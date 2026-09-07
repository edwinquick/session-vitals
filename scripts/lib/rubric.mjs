// The rubric: severity per signal, a tier, and a single recommended action.
// Four actions only. The decision table is documented in docs/rubric.md and
// this file must stay in step with it.
//   continue  keep working
//   compact   /compact with a focus instruction, pins re-injected afterwards
//   handoff   write a handoff doc from this session, start a fresh one
//   abandon   start fresh from durable artifacts only (diff, commits, issue),
//             because a summary written by a confused session is itself suspect

export const ACTIONS = ['continue', 'compact', 'handoff', 'abandon'];
export const TIERS = ['healthy', 'watch', 'degraded', 'critical'];

export function scoreVitals(v, probe = null) {
  const signals = [];
  const add = (key, severity, detail) => { if (severity > 0) signals.push({ key, severity, detail }); };

  const pct = v.contextPct;
  add('context', pct > 0.9 ? 3 : pct > 0.75 ? 2 : pct > 0.55 ? 1 : 0, `context ${Math.round(pct * 100)}% of ${fmtK(v.contextWindow)} (${fmtK(v.contextTokens)})`);

  const n = v.compactions.length;
  const rc = v.recentCompactions ?? n;
  let compSev = rc >= 3 ? 3 : rc === 2 ? 2 : rc === 1 ? 1 : 0;
  if (n >= 3) compSev = Math.max(compSev, 1);
  if (v.fastRefill || v.thrashing) compSev = Math.min(3, compSev + 1);
  const compNote = v.thrashing ? ', two within a few prompts of each other (thrashing)' : v.fastRefill ? ', refilled to half the window within a few prompts' : '';
  add('compaction', compSev, `${rc} compaction${rc === 1 ? '' : 's'} in the last 40 prompts (${n} total)${compNote}`);

  const r = v.recentErrorRate;
  let errSev = r > 0.6 ? 3 : r > 0.4 ? 2 : r > 0.25 ? 1 : 0;
  if (v.recentToolCalls >= 10 && r - v.overallErrorRate > 0.2) errSev = Math.min(3, errSev + 1);
  if (v.recentToolCalls < 5) errSev = 0;
  add('tool_errors', errSev, `${Math.round(r * 100)}% of last ${v.recentToolCalls} tool calls failed (session ${Math.round(v.overallErrorRate * 100)}%)`);

  add('retry_loops', v.retryRuns >= 3 ? 3 : v.retryRuns === 2 ? 2 : v.retryRuns === 1 ? 1 : 0, `${v.retryRuns} identical-retry run${v.retryRuns === 1 ? '' : 's'} in recent tool calls`);

  const rr = v.rereadFiles.length;
  add('rereads', rr >= 3 ? 2 : rr >= 1 ? 1 : 0, rr ? `re-read 3+ times: ${v.rereadFiles.map((f) => shortPath(f.file)).join(', ')}` : '');

  const c = v.recentCorrections;
  add('corrections', c >= 3 ? 3 : c === 2 ? 2 : c === 1 ? 1 : 0, `${c} correction${c === 1 ? '' : 's'} from the user in the last 6 prompts (${v.totalCorrections} total)`);

  if (v.everProgressed && v.promptsSinceProgress !== null) {
    add('stalled', v.promptsSinceProgress >= 12 ? 2 : v.promptsSinceProgress >= 6 ? 1 : 0, `${v.promptsSinceProgress} prompts since the last edit or commit`);
  }

  add('api_errors', v.apiErrors >= 2 ? 1 : 0, `${v.apiErrors} API errors`);

  if (probe && probe.mismatches !== undefined && probe.stale !== true) {
    add('probe', probe.mismatches >= 2 ? 3 : probe.mismatches === 1 ? 2 : 0, `task-retention probe: ${probe.mismatches} mismatch${probe.mismatches === 1 ? '' : 'es'}${probe.summary ? ' (' + probe.summary + ')' : ''}`);
  }

  const sum = signals.reduce((s, x) => s + x.severity, 0);
  const max = signals.reduce((m, x) => Math.max(m, x.severity), 0);
  const sev = (k) => signals.find((s) => s.key === k)?.severity || 0;
  const hardCritical = sev('corrections') === 3 || sev('retry_loops') === 3 || sev('probe') === 3 || v.thrashing;

  let tier;
  if (hardCritical || sum >= 9) tier = 'critical';
  else if (max >= 2 || sum >= 5) tier = 'degraded';
  else if (sum >= 2) tier = 'watch';
  else tier = 'healthy';

  return { tier, score: sum, signals, recommendation: recommend(tier, sev, v) };
}

function recommend(tier, sev, v) {
  if (tier === 'healthy') return { action: 'continue', why: 'No decline signals above baseline.' };
  if (tier === 'watch') {
    return { action: 'continue', why: 'Mild signals. Pin your standing constraints now so they survive the next compaction.', how: 'vitals pin "<constraint>"' };
  }
  if (tier === 'degraded') {
    const memoryProblem = sev('corrections') >= 2 || sev('probe') >= 2 || sev('retry_loops') >= 2;
    if (!memoryProblem && !v.fastRefill && (sev('context') >= 2 || sev('compaction') >= 1 || sev('rereads') >= 1)) {
      return { action: 'compact', why: 'The context is heavy with exploration but the task is still held. A focused compaction keeps the useful part.', how: '/compact focus on <the task>, keep: <pinned constraints>' };
    }
    if (!memoryProblem && v.fastRefill) {
      return { action: 'handoff', why: 'The window refilled to half within a few prompts of the last compaction, so another compaction buys very little. Hand off and delegate bulk reads to subagents in the fresh session.', how: 'Write a handoff doc, then /clear and paste it; use subagents for exploration' };
    }
    return { action: 'handoff', why: 'Signals point at lost understanding rather than a full window. A fresh session with a handoff doc is cheaper than re-correcting this one.', how: 'Write a handoff doc, then /clear and paste it' };
  }
  // critical
  if (sev('corrections') === 3 || sev('probe') === 3) {
    return { action: 'abandon', why: 'The session has lost the thread badly enough that its own summary cannot be trusted. Restart from durable artifacts: git diff, commits, the issue or plan.', how: 'Note the diff and open issue, /clear, restate the task yourself' };
  }
  if (v.thrashing) {
    return { action: 'handoff', why: 'The context refills within a few prompts of every compaction. More compaction will not help; the working pattern has to change. Hand off to a fresh session and delegate bulk reads to subagents there.', how: 'Write a handoff doc, then /clear and paste it; use subagents for exploration' };
  }
  return { action: 'handoff', why: 'Multiple strong signals. Hand off before the next compaction erases what is still correct.', how: 'Write a handoff doc, then /clear and paste it' };
}

export function formatOneLine(result, v) {
  const top = result.signals.slice().sort((a, b) => b.severity - a.severity).slice(0, 3).map((s) => `${s.key}:${s.severity}`).join(' ');
  return `Session vitals: ${result.tier.toUpperCase()} (score ${result.score}) · context ${Math.round(v.contextPct * 100)}% · ${top || 'no signals'} → ${result.recommendation.action}. /vitals for the full readout.`;
}

export function formatReport(result, v, state = {}) {
  const lines = [];
  lines.push(`SESSION VITALS  tier=${result.tier}  score=${result.score}  action=${result.recommendation.action}`);
  lines.push('');
  lines.push(`Context     ${fmtK(v.contextTokens)} / ${fmtK(v.contextWindow)} (${Math.round(v.contextPct * 100)}%), peak ${fmtK(v.peakContextTokens)}`);
  lines.push(`Session     ${v.prompts} prompts, ${v.toolCalls} tool calls, ${v.elapsedMinutes ?? '?'} min, ${v.compactions.length} compaction(s)${v.thrashing ? ' THRASHING' : ''}`);
  lines.push(`Errors      recent ${Math.round(v.recentErrorRate * 100)}% vs session ${Math.round(v.overallErrorRate * 100)}%, ${v.retryRuns} retry run(s), ${v.apiErrors} API error(s)`);
  lines.push(`Corrections ${v.recentCorrections} in last 6 prompts, ${v.totalCorrections} total`);
  lines.push(`Progress    ${v.everProgressed ? v.promptsSinceProgress + ' prompt(s) since last edit/commit, ' + v.editedFiles.length + ' file(s) edited' : 'no edits or commits yet'}`);
  if (v.rereadFiles.length) lines.push(`Re-reads    ${v.rereadFiles.map((f) => `${shortPath(f.file)}×${f.count}`).join(', ')}`);
  lines.push('');
  lines.push('Signals');
  if (!result.signals.length) lines.push('  none');
  for (const s of result.signals.sort((a, b) => b.severity - a.severity)) lines.push(`  [${s.severity}] ${s.key}: ${s.detail}`);
  lines.push('');
  lines.push(`Recommendation: ${result.recommendation.action.toUpperCase()}`);
  lines.push(`  ${result.recommendation.why}`);
  if (result.recommendation.how) lines.push(`  How: ${result.recommendation.how}`);
  if (state.pins?.length) { lines.push(''); lines.push(`Pinned constraints (${state.pins.length})`); for (const p of state.pins) lines.push(`  - ${p.text}`); }
  if (state.probe && !state.probe.stale) { lines.push(''); lines.push(`Last probe: ${state.probe.mismatches} mismatch(es) at prompt ${state.probe.promptIndex}${state.probe.summary ? ' (' + state.probe.summary + ')' : ''}`); }
  return lines.join('\n');
}

function fmtK(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
function shortPath(p) { const parts = String(p).split('/'); return parts.slice(-2).join('/'); }
