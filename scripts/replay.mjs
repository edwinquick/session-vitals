#!/usr/bin/env node
// Replay a finished transcript through the hooks, prompt by prompt, and print
// every warning the user would have seen. For evaluating format and
// thresholds against a real session without re-running it.
//   node scripts/replay.mjs <transcript.jsonl> [--window 1000000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const transcript = args.find((a) => !a.startsWith('--'));
if (!transcript) { console.error('usage: replay.mjs <transcript.jsonl> [--window N]'); process.exit(1); }
const wi = args.indexOf('--window');
const window = wi >= 0 ? args[wi + 1] : undefined;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-replay-'));
const env = { ...process.env, SESSION_VITALS_HOME: home };
if (window) env.SESSION_VITALS_CONTEXT_WINDOW = window;
const prefix = path.join(home, 'prefix.jsonl');
const lines = fs.readFileSync(transcript, 'utf8').split('\n');
const sessionId = 'replay';

function hook(payload) {
  const r = spawnSync('node', [path.join(here, 'hook.mjs')], { input: JSON.stringify({ session_id: sessionId, transcript_path: prefix, cwd: '/replay', ...payload }), env, encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stderr);
  return r.stdout.trim();
}

fs.writeFileSync(prefix, '');
hook({ hook_event_name: 'SessionStart', startup_reason: 'startup' });

let promptNo = 0, shown = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes('"type":"user"')) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary) continue;
  const c = o.message?.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  if (!text) continue;
  // The transcript up to, but not including, this prompt is what the hook sees.
  fs.writeFileSync(prefix, lines.slice(0, i).join('\n') + '\n');
  promptNo++;
  const label = text.trimStart().startsWith('<') ? `(${text.trim().match(/^<([a-z-]+)/)?.[1] || 'system'})` : JSON.stringify(text.slice(0, 70).replace(/\n/g, ' '));
  const out = hook({ hook_event_name: 'UserPromptSubmit', user_prompt: text });
  let msg = null;
  if (out) { try { msg = JSON.parse(out).systemMessage; } catch { msg = out; } }
  console.log(`#${promptNo} ${label}`);
  if (msg) { shown++; console.log(`     ⚠ ${msg}`); }
  // Stop fires at the end of the turn; approximate with the transcript up to the next prompt.
  let j = i + 1;
  while (j < lines.length && !(lines[j].includes('"type":"user"') && !lines[j].includes('tool_result') && !lines[j].includes('"isMeta":true'))) j++;
  fs.writeFileSync(prefix, lines.slice(0, j).join('\n') + '\n');
  const stop = hook({ hook_event_name: 'Stop' });
  if (stop) { try { const m = JSON.parse(stop).systemMessage; if (m) { shown++; console.log(`     ⚠ (turn end) ${m}`); } } catch { /* ignore */ } }
}
fs.writeFileSync(prefix, lines.join('\n'));
console.log(`\n${promptNo} prompts replayed, ${shown} warning${shown === 1 ? '' : 's'} shown.`);
console.log(`\nFinal /vitals report:\n`);
const rep = spawnSync('node', [path.join(here, 'vitals-cli.mjs'), 'report', '--transcript', prefix], { env: { ...env, CLAUDE_PROJECT_DIR: '/replay' }, encoding: 'utf8' });
process.stdout.write(rep.stdout.replace(/\nTranscript: .*\n?$/, '\n'));
const state = JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessionId + '.json'), 'utf8'));
console.log(`\nState after replay: baseline=${state.baseline ? JSON.stringify(state.baseline.task.slice(0, 60)) : 'none'}, pins=${state.pins.length}, promptCount=${state.promptCount}`);
fs.rmSync(home, { recursive: true, force: true });
