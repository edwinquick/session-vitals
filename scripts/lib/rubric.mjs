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
  // detail: a full sentence for the report. short: a few words for the one-liner.
  const add = (key, severity, detail, short) => { if (severity > 0) signals.push({ key, severity, detail, short: short || detail }); };
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  const pct = v.contextPct;
  const pctStr = `${Math.round(pct * 100)}%`;
  add('context', pct > 0.9 ? 3 : pct > 0.75 ? 2 : pct > 0.55 ? 1 : 0, `Context is ${pctStr} full (${fmtK(v.contextTokens)} of ${fmtK(v.contextWindow)})`, `context ${pctStr} full`);

  const n = v.compactions.length;
  const rc = v.recentCompactions ?? n;
  let compSev = rc >= 3 ? 3 : rc === 2 ? 2 : rc === 1 ? 1 : 0;
  if (n >= 3) compSev = Math.max(compSev, 1);
  if (v.fastRefill || v.thrashing) compSev = Math.min(3, compSev + 1);
  const compNote = v.thrashing ? ', two of them back to back' : v.fastRefill ? ', and the window refilled to half within a few prompts' : '';
  add('compaction', compSev, `${plural(rc, 'compaction')} in the last 40 prompts${n > rc ? ` (${n} in total)` : ''}${compNote}`, v.thrashing ? 'compaction thrashing' : v.fastRefill ? 'refilling fast after compaction' : plural(rc, 'recent compaction'));

  const r = v.recentErrorRate;
  let errSev = r > 0.6 ? 3 : r > 0.4 ? 2 : r > 0.25 ? 1 : 0;
  if (v.recentToolCalls >= 10 && r - v.overallErrorRate > 0.2) errSev = Math.min(3, errSev + 1);
  if (v.recentToolCalls < 5) errSev = 0;
  const rising = v.recentToolCalls >= 10 && r - v.overallErrorRate > 0.2;
  add('tool_errors', errSev, `${Math.round(r * 100)}% of the last ${v.recentToolCalls} tool calls failed${rising ? `, up from ${Math.round(v.overallErrorRate * 100)}% over the session` : ''}`, `${Math.round(r * 100)}% tool errors${rising ? ' and rising' : ''}`);

  add('retry_loops', v.retryRuns >= 3 ? 3 : v.retryRuns === 2 ? 2 : v.retryRuns === 1 ? 1 : 0, `${plural(v.retryRuns, 'identical retry loop')} in recent tool calls`, plural(v.retryRuns, 'retry loop'));

  const rr = v.rereadFiles.length;
  const rrList = v.rereadFiles.slice(0, 2).map((f) => `${shortPath(f.file)} read ${f.count} times`).join(', ') + (rr > 2 ? `, and ${rr - 2} more` : '');
  add('rereads', rr >= 3 ? 2 : rr >= 1 ? 1 : 0, rr ? `${rrList} recently` : '', plural(rr, 'file re-read'));

  const c = v.recentCorrections;
  add('corrections', c >= 3 ? 3 : c === 2 ? 2 : c === 1 ? 1 : 0, `You corrected it ${c === 1 ? 'once' : c + ' times'} in the last 6 prompts${v.totalCorrections > c ? ` (${v.totalCorrections} in total)` : ''}`, `${plural(c, 'correction')} in 6 prompts`);

  if (v.everProgressed && v.promptsSinceProgress !== null) {
    add('stalled', v.promptsSinceProgress >= 12 ? 2 : v.promptsSinceProgress >= 6 ? 1 : 0, `${v.promptsSinceProgress} prompts since the last edit or commit`, 'no edits lately');
  }

  add('api_errors', v.apiErrors >= 2 ? 1 : 0, `${plural(v.apiErrors, 'API error')} this session`, plural(v.apiErrors, 'API error'));

  if (probe && probe.mismatches !== undefined && probe.stale !== true) {
    add('probe', probe.mismatches >= 3 ? 3 : probe.mismatches === 2 ? 2 : probe.mismatches === 1 ? 1 : 0, `The retention probe missed ${plural(probe.mismatches, 'item')}${probe.summary ? ': ' + probe.summary : ''}`, `probe missed ${probe.mismatches}`);
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

export const ACTION_LABEL = {
  continue: 'carry on',
  compact: 'compact with a focus instruction',
  handoff: 'hand off to a fresh session',
  abandon: 'start over from git and the issue',
};

const DOTS = { 1: '●○○', 2: '●●○', 3: '●●●' };

function sorted(signals) { return signals.slice().sort((a, b) => b.severity - a.severity); }

// The warning line shown to the user by the hooks. One sentence of evidence,
// one of advice.
export function formatOneLine(result, v) {
  const top = sorted(result.signals).slice(0, 3).map((s) => s.short).join(' · ');
  const evidence = top ? `${top[0].toUpperCase()}${top.slice(1)}.` : `Context ${Math.round(v.contextPct * 100)}% full, nothing else showing.`;
  return `Session vitals: ${result.tier}. ${evidence} Suggest: ${ACTION_LABEL[result.recommendation.action]}. /vitals for details.`;
}

export function formatReport(result, v, state = {}) {
  const lines = [];
  const action = result.recommendation.action;
  lines.push(`SESSION VITALS: ${result.tier} → ${ACTION_LABEL[action]}`);
  lines.push('');
  if (result.signals.length) {
    lines.push("What's showing");
    for (const s of sorted(result.signals)) lines.push(`  ${DOTS[s.severity]}  ${s.detail}`);
  } else {
    lines.push(`Nothing showing. Context ${Math.round(v.contextPct * 100)}% full (${fmtK(v.contextTokens)} of ${fmtK(v.contextWindow)}).`);
  }
  if (action !== 'continue' || result.tier !== 'healthy') {
    lines.push('');
    lines.push(`Why ${ACTION_LABEL[action].split(' ')[0] === 'carry' ? 'carry on' : ACTION_LABEL[action].replace(/ (with|to|from).*$/, '')}`);
    lines.push(`  ${result.recommendation.why}`);
    if (result.recommendation.how) lines.push(`  Next: ${result.recommendation.how}`);
  }
  if (state.pins?.length) {
    lines.push('');
    lines.push(`Pinned constraints (${state.pins.length})`);
    for (const p of state.pins) lines.push(`  • ${p.text}`);
  }
  if (state.probe && !state.probe.stale) {
    lines.push('');
    lines.push(`Last retention probe: ${state.probe.mismatches === 0 ? 'all consistent' : plural2(state.probe.mismatches, 'item') + ' missed'}, at prompt ${state.probe.promptIndex}`);
  }
  lines.push('');
  const files = v.editedFiles.length;
  lines.push(`Session: ${v.prompts} prompts · ${v.toolCalls} tool calls · ${v.elapsedMinutes ?? '?'} min · ${plural2(v.compactions.length, 'compaction')} · ${files ? plural2(files, 'file') + ' edited' : 'nothing edited yet'}`);
  return lines.join('\n');
}

function plural2(n, one, many = one + 's') { return `${n} ${n === 1 ? one : many}`; }

function fmtK(n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
function shortPath(p) { const parts = String(p).split('/'); return parts.slice(-2).join('/'); }
