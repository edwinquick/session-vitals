// Per-session state that lives outside the context window: baseline task,
// pinned constraints, the last probe result, the last report. Stored under
// the plugin data dir when Claude Code provides one, else ~/.claude/session-vitals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stateRoot() {
  const base = process.env.SESSION_VITALS_HOME || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'session-vitals');
  const dir = path.join(base, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(sessionId) { return path.join(stateRoot(), sessionId + '.json'); }

export function loadState(sessionId) {
  try { return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8')); } catch { return null; }
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const p = statePath(state.sessionId);
  fs.writeFileSync(p + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(p + '.tmp', p);
  return state;
}

export function newState(input) {
  return {
    sessionId: input.session_id,
    transcriptPath: input.transcript_path || null,
    cwd: input.cwd || null,
    model: input.model || null,
    contextWindow: detectContextWindow(input.model),
    startedAt: new Date().toISOString(),
    baseline: null,
    pins: [],
    compactionsSeen: 0,
    lastReport: null,
    probe: null,
    promptCount: 0,
  };
}

export function detectContextWindow(model) {
  if (process.env.SESSION_VITALS_CONTEXT_WINDOW) return Number(process.env.SESSION_VITALS_CONTEXT_WINDOW);
  if (model && /\[1m\]|-1m\b|1m$/i.test(model)) return 1_000_000;
  return 200_000;
}

// Newest state file whose cwd matches, for the CLI when the skill runs
// without a session id in hand.
export function findStateForCwd(cwd) {
  const dir = stateRoot();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  let best = null;
  for (const f of files) {
    const p = path.join(dir, f);
    let s; try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (cwd && s.cwd !== cwd) continue;
    const m = fs.statSync(p).mtimeMs;
    if (!best || m > best.m) best = { m, s };
  }
  return best ? best.s : null;
}

// Fallback when no hook has run: the newest transcript for this cwd.
export function guessTranscriptForCwd(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    const m = fs.statSync(p).mtimeMs;
    if (!best || m > best.m) best = { m, p };
  }
  return best ? best.p : null;
}

export function loadConfig() {
  const base = process.env.SESSION_VITALS_HOME || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'session-vitals');
  try { return JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8')); } catch { return {}; }
}
