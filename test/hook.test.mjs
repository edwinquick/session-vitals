import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { degradedSession, healthySession } from './fixtures/make-transcript.mjs';

const HOOK = path.resolve('scripts/hook.mjs');
const CLI = path.resolve('scripts/vitals-cli.mjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-vitals-'));
  const env = { ...process.env, SESSION_VITALS_HOME: dir, SESSION_VITALS_REPORT_EVERY: '3' };
  return { dir, env };
}
function hook(env, payload) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function cli(env, args, cwd) {
  return spawnSync('node', [CLI, ...args], { env: { ...env, CLAUDE_PROJECT_DIR: cwd }, encoding: 'utf8' });
}

test('hooks: session start, prompts, report cadence, pins survive compaction', () => {
  const { dir, env } = sandbox();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, degradedSession().text());
  const base = { session_id: 'abc', transcript_path: transcript, cwd: '/tmp/proj', model: 'claude-fable-5-1[1m]' };

  assert.equal(hook(env, { ...base, hook_event_name: 'SessionStart', startup_reason: 'startup' }), '');
  const state1 = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'abc.json'), 'utf8'));
  assert.equal(state1.contextWindow, 1_000_000);

  // First prompt: baseline captured, constraint auto-pinned. The transcript is
  // already degraded, so crossing into that tier reports at once regardless of cadence.
  let out = hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'Fix the flaky auth test. Do not touch the database schema.' });
  let json = JSON.parse(out);
  assert.match(json.systemMessage, /^Session vitals: (degraded|critical)\. .*Suggest: hand off to a fresh session\./);
  assert.match(json.hookSpecificOutput.additionalContext, /^\[session-vitals\] Session vitals: .*Finish the user's current request first/);
  let state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'abc.json'), 'utf8'));
  assert.equal(state.baseline.task, 'Fix the flaky auth test. Do not touch the database schema.');
  assert.deepEqual(state.pins.map((p) => p.text), ['Do not touch the database schema.']);

  // Prompts 2 and 3: same tier and action, inside the cadence window, so silence
  // even though 3 is a multiple of the cadence. The same warning is not repeated.
  out = hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'keep going' });
  assert.equal(out, '');
  out = hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'and then?' });
  assert.equal(out, '');
  // Prompt 6: a full cadence window has passed since the last readout, so it repeats.
  for (const p of ['ok', 'next']) assert.equal(hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: p }), '');
  out = hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'status?' });
  json = JSON.parse(out);
  assert.match(json.systemMessage, /Session vitals:/);

  // Manual pin through the CLI, then compaction re-injects both pins verbatim.
  const pin = cli(env, ['pin', 'Never push to main'], '/tmp/proj');
  assert.equal(pin.status, 0, pin.stderr);
  hook(env, { ...base, hook_event_name: 'PreCompact', compact_reason: 'auto' });
  const reinject = hook(env, { ...base, hook_event_name: 'SessionStart', startup_reason: 'compact' });
  assert.match(reinject, /re-injected verbatim/);
  assert.match(reinject, /- Do not touch the database schema\./);
  assert.match(reinject, /- Never push to main/);
  assert.match(reinject, /Original task/);

  // Report via CLI finds the state by cwd.
  const rep = cli(env, ['report'], '/tmp/proj');
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /SESSION VITALS/);
  assert.match(rep.stdout, /Pinned constraints \(2\)/);
});

test('probe: good answers pass, bad answers register mismatches and change the tier', () => {
  const { dir, env } = sandbox();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, healthySession().text());
  const base = { session_id: 'p1', transcript_path: transcript, cwd: '/tmp/proj2' };
  hook(env, { ...base, hook_event_name: 'SessionStart', startup_reason: 'startup' });
  hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'Add a retry to the upload client. Never change the public API.' });
  cli(env, ['pin', 'Never change the public API'], '/tmp/proj2');

  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ task: 'Add retry logic to the upload client without changing its public API', constraints: ['public API must not change'], files: ['src/upload.ts', 'src/upload.test.ts'], lastCorrection: null, nextStep: 'run tests' }));
  let r = cli(env, ['probe', '--answers', good], '/tmp/proj2');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROBE RESULT: 0 mismatch/);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ task: 'Refactor the billing dashboard styles', constraints: [], files: [], lastCorrection: null, nextStep: 'unsure' }));
  r = cli(env, ['probe', '--answers', bad], '/tmp/proj2');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROBE RESULT: 3 mismatch/);
  const rep = cli(env, ['report'], '/tmp/proj2');
  assert.match(rep.stdout, /^SESSION VITALS: critical → start over from git and the issue/);
  assert.match(rep.stdout, /The retention probe missed 3 items/);
});

test('task notifications and slash commands are not prompts: no baseline, no pins, no count', () => {
  const { dir, env } = sandbox();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, healthySession().text());
  const base = { session_id: 'tn1', transcript_path: transcript, cwd: '/tmp/proj5' };
  hook(env, { ...base, hook_event_name: 'SessionStart', startup_reason: 'startup' });
  hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: '/session-vitals:vitals' });
  hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: '<task-notification>\n<summary>Agent finished</summary>\n<result>**Findings.** Never assert the output. Do not touch the schema.</result>\n</task-notification>' });
  let state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'tn1.json'), 'utf8'));
  assert.equal(state.baseline, null);
  assert.deepEqual(state.pins, []);
  assert.equal(state.promptCount, 1, 'the slash command counts as a prompt, the notification does not');
  hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'scan the repo for slop code and tell me what you find?' });
  state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'tn1.json'), 'utf8'));
  assert.equal(state.baseline.task, 'scan the repo for slop code and tell me what you find?');
});

test('probe: a detailed paraphrase of a short request passes task recall', () => {
  const { dir, env } = sandbox();
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, healthySession().text());
  const base = { session_id: 'pp1', transcript_path: transcript, cwd: '/tmp/proj6' };
  hook(env, { ...base, hook_event_name: 'SessionStart', startup_reason: 'startup' });
  hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'scan the repo for slop code and tell me what you find?' });
  const a = path.join(dir, 'a.json');
  fs.writeFileSync(a, JSON.stringify({ task: 'Read-only audit of the moto-platform repo for slop code across Edge Functions, mobile, web and shared, delivered as a ranked findings list with severities.', constraints: [], files: ['src/upload.ts', 'src/upload.test.ts'], lastCorrection: null, nextStep: 'report' }));
  const r = cli(env, ['probe', '--answers', a], '/tmp/proj6');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROBE RESULT: 0 mismatch/);
});

test('CLI finds state written under CLAUDE_PLUGIN_DATA even without that variable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-vitals-'));
  const pluginData = path.join(dir, 'plugin-data');
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, healthySession().text());
  const hookEnv = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, HOME: dir };
  delete hookEnv.SESSION_VITALS_HOME;
  const base = { session_id: 'pd1', transcript_path: transcript, cwd: '/tmp/proj3' };
  hook(hookEnv, { ...base, hook_event_name: 'SessionStart', startup_reason: 'startup' });
  hook(hookEnv, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'Add a retry to the upload client.' });
  assert.ok(fs.existsSync(path.join(pluginData, 'sessions', 'pd1.json')));

  // The CLI shell has neither variable. It must still find the state through ~/.claude/plugins/data/session-vitals*.
  fs.mkdirSync(path.join(dir, '.claude', 'plugins', 'data'), { recursive: true });
  fs.renameSync(pluginData, path.join(dir, '.claude', 'plugins', 'data', 'session-vitals-inline'));
  const cliEnv = { ...process.env, HOME: dir };
  delete cliEnv.SESSION_VITALS_HOME; delete cliEnv.CLAUDE_PLUGIN_DATA;
  const pin = cli(cliEnv, ['pin', 'Keep the public API stable'], '/tmp/proj3');
  assert.equal(pin.status, 0, pin.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'plugins', 'data', 'session-vitals-inline', 'sessions', 'pd1.json'), 'utf8'));
  assert.ok(state.pins.some((p) => p.text === 'Keep the public API stable'), 'pin written back to the file it was loaded from');
  assert.ok(!('__path' in state) && !Object.keys(state).some((k) => k.includes('path') && k !== 'transcriptPath'), 'no private path leaked into JSON');
});

test('1M window is detected from the settings file when the model id lacks the suffix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-vitals-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1[1m]' }));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, healthySession().text());
  const env = { ...process.env, HOME: dir, SESSION_VITALS_HOME: path.join(dir, 'sv') };
  delete env.SESSION_VITALS_CONTEXT_WINDOW;
  hook(env, { session_id: 'w1', transcript_path: transcript, cwd: '/tmp/proj4', model: 'claude-fable-5-1', hook_event_name: 'SessionStart', startup_reason: 'startup' });
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'sv', 'sessions', 'w1.json'), 'utf8'));
  assert.equal(state.contextWindow, 1_000_000);
});

test('hook never fails the session on garbage input', () => {
  const { env } = sandbox();
  const r = spawnSync('node', [HOOK], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /session-vitals/);
});
