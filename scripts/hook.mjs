#!/usr/bin/env node
// Single hook entry point. Reads the hook payload on stdin and dispatches on
// hook_event_name. Never throws to the caller: a broken measurement must not
// break the session it is measuring.
import fs from 'node:fs';
import { parseTranscript } from './lib/transcript.mjs';
import { computeVitals, extractConstraintCandidates } from './lib/vitals.mjs';
import { scoreVitals, formatOneLine } from './lib/rubric.mjs';
import { loadState, saveState, newState, loadConfig } from './lib/state.mjs';

const REPORT_EVERY = Number(process.env.SESSION_VITALS_REPORT_EVERY || 5);
const MAX_AUTO_PINS = 12;

main().catch((err) => { process.stderr.write(`session-vitals: ${err.message}\n`); process.exit(0); });

async function main() {
  const input = JSON.parse(await readStdin());
  if (input.agent_id) return; // subagents have their own fresh windows; not measured
  const event = input.hook_event_name;
  const config = loadConfig();

  // /clear starts a new session id, so a fresh state file follows it naturally.
  const state = loadState(input.session_id) || newState(input);
  state.transcriptPath = input.transcript_path || state.transcriptPath;
  state.cwd = input.cwd || state.cwd;
  if (input.model) { state.model = input.model; state.contextWindow = Math.max(state.contextWindow || 0, newState(input).contextWindow); }

  switch (event) {
    case 'SessionStart': return onSessionStart(input, state);
    case 'UserPromptSubmit': return onUserPrompt(input, state, config);
    case 'PreCompact': return onPreCompact(input, state);
    case 'Stop': return onStop(input, state, config);
    default: saveState(state);
  }
}

function onSessionStart(input, state) {
  if (input.startup_reason === 'compact') {
    state.compactionsSeen = (state.compactionsSeen || 0) + 1;
    if (state.probe) state.probe.stale = true;
    saveState(state);
    // Constraint pinning: re-inject verbatim after every compaction. This is
    // the one mitigation shown to bring post-compaction violations back to
    // zero (Governance Decay, arXiv 2606.22528). Plain stdout is added as
    // context on SessionStart.
    const lines = [];
    lines.push('[session-vitals] The conversation was just compacted. Compaction is lossy for constraints stated in user turns, so the following are re-injected verbatim.');
    if (state.pins.length) {
      lines.push('Pinned constraints still in force:');
      for (const p of state.pins) lines.push(`- ${p.text}`);
    } else {
      lines.push('No constraints were pinned in this session. If the user stated standing rules earlier, restate them to the user now and pin them with the /vitals skill.');
    }
    if (state.baseline?.task) lines.push(`Original task, as first stated by the user: ${trunc(state.baseline.task, 600)}`);
    lines.push('Run /vitals to verify task retention before continuing.');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }
  if (input.startup_reason === 'resume' && state.probe) state.probe.stale = true;
  saveState(state);
}

function onUserPrompt(input, state, config) {
  const text = String(input.user_prompt || input.prompt || '');
  // Task notifications from background agents, slash-command records and
  // system reminders arrive through this hook too. They are not the human
  // speaking: they must not become the baseline, pins, or a counted prompt.
  if (!text.trim() || text.trimStart().startsWith('<')) { saveState(state); return; }
  const isSlash = text.trimStart().startsWith('/');
  state.promptCount = (state.promptCount || 0) + 1;
  if (!state.baseline && !isSlash) {
    state.baseline = { task: text.slice(0, 4000), ts: new Date().toISOString() };
  }
  // Auto-capture constraint-shaped statements from the human. Marked as
  // source=auto so the skill can show them and the user can prune them.
  if (!isSlash) {
    for (const c of extractConstraintCandidates(text)) {
      if (state.pins.some((p) => p.text === c)) continue;
      state.pins.push({ text: c, source: 'auto', ts: new Date().toISOString() });
    }
  }
  const manual = state.pins.filter((p) => p.source !== 'auto');
  const auto = state.pins.filter((p) => p.source === 'auto').slice(-MAX_AUTO_PINS);
  state.pins = [...manual, ...auto];

  const measured = measure(state, config);
  let out = null;
  if (measured) {
    const { result, vitals } = measured;
    const prev = state.lastReport;
    const worsened = prev && TIER_RANK[result.tier] > TIER_RANK[prev.tier];
    const crossedDegraded = TIER_RANK[result.tier] >= 2 && (!prev || TIER_RANK[prev.tier] < 2);
    // Routine readouts only when there is something to say, and never the
    // same tier and action twice inside one cadence window.
    const due = state.promptCount % REPORT_EVERY === 0 && result.tier !== 'healthy'
      && !(prev && prev.tier === result.tier && prev.action === result.recommendation.action && state.promptCount - (prev.promptCount || 0) < REPORT_EVERY);
    if (due || worsened || crossedDegraded) {
      const line = formatOneLine(result, vitals);
      out = {
        systemMessage: line,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[session-vitals] ${line} ${result.recommendation.why}${result.recommendation.action === 'continue' ? '' : ' Finish the user\'s current request first, then pass this suggestion on in one sentence.'}`,
        },
      };
      state.lastReport = { tier: result.tier, score: result.score, action: result.recommendation.action, promptIndex: vitals.prompts, promptCount: state.promptCount, ts: new Date().toISOString() };
    }
  }
  saveState(state);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

function onPreCompact(input, state) {
  state.lastPreCompact = { trigger: input.compact_reason || input.trigger || 'unknown', ts: new Date().toISOString() };
  saveState(state);
}

function onStop(input, state, config) {
  const measured = measure(state, config);
  if (!measured) return;
  const { result, vitals } = measured;
  const prev = state.lastReport;
  const worsened = prev && TIER_RANK[result.tier] > TIER_RANK[prev.tier];
  const firstDegraded = !prev && TIER_RANK[result.tier] >= 2;
  if (worsened || firstDegraded) {
    state.lastReport = { tier: result.tier, score: result.score, action: result.recommendation.action, promptIndex: vitals.prompts, promptCount: state.promptCount, ts: new Date().toISOString() };
    saveState(state);
    // Stop: user-facing warning only. No additionalContext, so the model is
    // not nudged into another turn by its own monitor.
    process.stdout.write(JSON.stringify({ systemMessage: formatOneLine(result, vitals) }) + '\n');
    return;
  }
  saveState(state);
}

function measure(state, config) {
  if (!state.transcriptPath || !fs.existsSync(state.transcriptPath)) return null;
  const events = parseTranscript(state.transcriptPath);
  const vitals = computeVitals(events, { ...config, contextWindow: state.contextWindow });
  const probe = state.probe && !state.probe.stale && vitals.prompts - state.probe.promptIndex <= 10 ? state.probe : null;
  const result = scoreVitals(vitals, probe);
  return { result, vitals };
}

const TIER_RANK = { healthy: 0, watch: 1, degraded: 2, critical: 3 };

function trunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data || '{}'));
    // Unref'd so a finished hook exits at once instead of waiting out the guard.
    setTimeout(() => resolve(data || '{}'), 3000).unref();
  });
}
