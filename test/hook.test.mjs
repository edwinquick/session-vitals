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
  assert.match(json.systemMessage, /Session vitals: (DEGRADED|CRITICAL)/);
  assert.match(json.hookSpecificOutput.additionalContext, /Recommended action/);
  let state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'abc.json'), 'utf8'));
  assert.equal(state.baseline.task, 'Fix the flaky auth test. Do not touch the database schema.');
  assert.deepEqual(state.pins.map((p) => p.text), ['Do not touch the database schema.']);

  // Second prompt: same tier, not due (cadence 3), so silence.
  out = hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'keep going' });
  assert.equal(out, '');
  // Third prompt: routine readout is due.
  out = hook(env, { ...base, hook_event_name: 'UserPromptSubmit', user_prompt: 'and then?' });
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
  assert.match(rep.stdout, /tier=critical/);
  assert.match(rep.stdout, /action=abandon/);
});

test('hook never fails the session on garbage input', () => {
  const { env } = sandbox();
  const r = spawnSync('node', [HOOK], { input: 'not json', env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /session-vitals/);
});
