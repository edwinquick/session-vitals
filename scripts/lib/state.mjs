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

// Neither the hook payload nor the transcript reliably carries the "[1m]"
// suffix, so also look at the settings files that could have set it, and at
// model ids this machine has already seen hold more than 200k tokens. Below
// 200k a 1M session looks exactly like a full 200k one, so without that memory
// the first readings of every such session would be measured against 200k.
// computeVitals has a further fallback for the session that first crosses it.
export function detectContextWindow(model, cwd) {
  if (process.env.SESSION_VITALS_CONTEXT_WINDOW) return Number(process.env.SESSION_VITALS_CONTEXT_WINDOW);
  if (model && /\[1m\]|-1m\b|1m$/i.test(model)) return 1_000_000;
  const learned = model && learnedWindows()[modelKey(model)];
  if (learned) return learned;
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

// Raise the session's window to what the transcript proved (computeVitals
// upgrades it once more than 200k tokens were held) and remember the model id,
// so the hook, the CLI and later sessions on the same id all agree. Returns
// true when the state changed and should be saved.
export function adoptObservedWindow(state, vitals) {
  if (process.env.SESSION_VITALS_CONTEXT_WINDOW) return false;
  if (!(vitals.contextWindow > (state.contextWindow || 0))) return false;
  state.contextWindow = vitals.contextWindow;
  if (state.model) rememberWindow(state.model, vitals.contextWindow);
  return true;
}

function modelKey(model) { return String(model).toLowerCase().replace(/\[1m\]$/, ''); }

function learnedWindows() {
  const out = {};
  for (const root of candidateRoots().reverse()) {
    const w = readJson(path.join(root, 'windows.json'));
    if (w) for (const [k, v] of Object.entries(w)) if (Number(v?.window) > 0) out[k] = Number(v.window);
  }
  return out;
}

function rememberWindow(model, window) {
  const p = path.join(candidateRoots()[0], 'windows.json');
  const w = readJson(p) || {};
  const key = modelKey(model);
  if (w[key]?.window >= window) return;
  w[key] = { window, seenAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', JSON.stringify(w, null, 2));
    fs.renameSync(p + '.tmp', p);
  } catch { /* best effort: the session state still carries the window */ }
}

// Sessions whose files changed within this window count as live. Without a
// session id, more than one live session in a directory is ambiguous.
const LIVE_MS = 2 * 60 * 60 * 1000;

// Which session the CLI is acting for. By id whenever one is known: the
// shell Claude Code gives the model carries CLAUDE_CODE_SESSION_ID, so the
// skill always has it. Picking the newest file instead let a second session
// in the same directory take over the probe, the report and the pins (#8).
// Without an id (a human at a terminal), the newest session is used only when
// it is the sole live one; otherwise this refuses and lists the candidates.
// Returns { state, transcript, sessionId, error }.
export function resolveSession({ sessionId, cwd, transcript } = {}) {
  sessionId = sessionId || process.env.CLAUDE_CODE_SESSION_ID || null;
  if (sessionId) {
    if (!/^[\w-]+$/.test(sessionId)) return { error: `not a session id: ${sessionId}` };
    const state = loadState(sessionId);
    const t = transcript || state?.transcriptPath || transcriptForSession(sessionId, cwd);
    return { state, transcript: t, sessionId };
  }
  const candidates = statesForCwd(cwd);
  if (!candidates.length) return { state: null, transcript: transcript || guessTranscriptForCwd(cwd), sessionId: null };
  const live = candidates.filter((c) => Date.now() - c.m < LIVE_MS);
  if (live.length > 1) {
    const list = live.map((c) => `  ${c.s.sessionId}  last active ${new Date(c.m).toISOString()}  ${(c.s.baseline?.task || '').slice(0, 60)}`).join('\n');
    return { error: `${live.length} sessions are active in ${cwd}; pass --session <id> to choose one:\n${list}` };
  }
  const state = candidates[0].s;
  return { state, transcript: transcript || state.transcriptPath, sessionId: state.sessionId, byRecency: true };
}

// State files for this cwd across every root, newest first.
function statesForCwd(cwd) {
  const want = cwd && sameDir(cwd);
  const out = [];
  for (const root of candidateRoots()) {
    const dir = path.join(root, 'sessions');
    let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      const s = readJson(p);
      if (!s || (want && !want(s.cwd))) continue;
      out.push({ m: fs.statSync(p).mtimeMs, s: withPath(s, p) });
    }
  }
  return out.sort((a, b) => b.m - a.m);
}

// Hook payloads and shells disagree on drive-letter case on Windows.
function sameDir(a) {
  const norm = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const na = norm(a);
  return (b) => !!b && norm(b) === na;
}

function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function transcriptForSession(sessionId, cwd) {
  if (!cwd) return null;
  const p = path.join(projectDir(cwd), sessionId + '.jsonl');
  return fs.existsSync(p) ? p : null;
}

// Fallback when no hook has run and no session id is known: the newest
// transcript for this cwd.
export function guessTranscriptForCwd(cwd) {
  const dir = projectDir(cwd);
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
