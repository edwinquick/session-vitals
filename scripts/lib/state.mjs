// Per-session state that lives outside the context window: baseline task,
// pinned constraints, the last probe result, the last report.
//
// Hooks run with CLAUDE_PLUGIN_DATA set and write there. The CLI, launched
// from the model's own shell, does not get that variable, so lookups search
// every plausible root and a loaded state remembers the file it came from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATH_KEY = Symbol.for('session-vitals.path');

export function candidateRoots() {
  const roots = [];
  if (process.env.SESSION_VITALS_HOME) roots.push(process.env.SESSION_VITALS_HOME);
  if (process.env.CLAUDE_PLUGIN_DATA) roots.push(process.env.CLAUDE_PLUGIN_DATA);
  roots.push(path.join(os.homedir(), '.claude', 'session-vitals'));
  const pluginData = path.join(os.homedir(), '.claude', 'plugins', 'data');
  try {
    for (const d of fs.readdirSync(pluginData)) if (d.startsWith('session-vitals')) roots.push(path.join(pluginData, d));
  } catch { /* no plugin data dir */ }
  return [...new Set(roots)];
}

// Where new state is written: the first candidate root.
export function stateRoot() {
  const dir = path.join(candidateRoots()[0], 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(sessionId) { return path.join(stateRoot(), sessionId + '.json'); }

export function loadState(sessionId) {
  for (const root of candidateRoots()) {
    const p = path.join(root, 'sessions', sessionId + '.json');
    const s = readJson(p);
    if (s) return withPath(s, p);
  }
  return null;
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const p = state[PATH_KEY] || statePath(state.sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(p + '.tmp', p);
  return withPath(state, p);
}

export function newState(input) {
  return {
    sessionId: input.session_id,
    transcriptPath: input.transcript_path || null,
    cwd: input.cwd || null,
    model: input.model || null,
    contextWindow: detectContextWindow(input.model, input.cwd),
    startedAt: new Date().toISOString(),
    baseline: null,
    pins: [],
    compactionsSeen: 0,
    lastReport: null,
    probe: null,
    promptCount: 0,
  };
}

// Neither the hook payload nor the transcript carries the "[1m]" suffix the
// user configured, so also look at the settings files that could have set it.
// computeVitals has a further fallback: a session that has held more than
// 200k tokens is on a 1M window whatever the id says.
export function detectContextWindow(model, cwd) {
  if (process.env.SESSION_VITALS_CONTEXT_WINDOW) return Number(process.env.SESSION_VITALS_CONTEXT_WINDOW);
  if (model && /\[1m\]|-1m\b|1m$/i.test(model)) return 1_000_000;
  const candidates = [
    cwd && path.join(cwd, '.claude', 'settings.local.json'),
    cwd && path.join(cwd, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    const s = readJson(p);
    if (s && typeof s.model === 'string' && /\[1m\]/i.test(s.model)) return 1_000_000;
  }
  if (process.env.ANTHROPIC_MODEL && /\[1m\]/i.test(process.env.ANTHROPIC_MODEL)) return 1_000_000;
  return 200_000;
}

// Newest state file whose cwd matches, across every root, for the CLI when
// the skill runs without a session id in hand.
export function findStateForCwd(cwd) {
  let best = null;
  for (const root of candidateRoots()) {
    const dir = path.join(root, 'sessions');
    let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      const s = readJson(p);
      if (!s) continue;
      if (cwd && s.cwd !== cwd) continue;
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { m, s: withPath(s, p) };
    }
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
  for (const root of candidateRoots()) {
    const c = readJson(path.join(root, 'config.json'));
    if (c) return c;
  }
  return {};
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function withPath(state, p) {
  Object.defineProperty(state, PATH_KEY, { value: p, enumerable: false, configurable: true });
  return state;
}
