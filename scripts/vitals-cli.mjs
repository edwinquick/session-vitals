#!/usr/bin/env node
// CLI used by the /vitals skill and by humans.
//   vitals-cli report [--transcript <path>] [--json]
//   vitals-cli probe                 print the retention probe questions
//   vitals-cli probe --answers <file> score answers against baseline, store result
//   vitals-cli pin "<constraint>"    pin a constraint for re-injection after compaction
//   vitals-cli pins                  list pins
//   vitals-cli unpin <index>         remove a pin (1-based, from `pins`)
//   vitals-cli baseline "<task>"     override the baseline task statement
// Every command takes --session <id>. Inside Claude Code the session id comes
// from CLAUDE_CODE_SESSION_ID, so the flag is only needed from a terminal.
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscript } from './lib/transcript.mjs';
import { computeVitals } from './lib/vitals.mjs';
import { scoreVitals, formatReport } from './lib/rubric.mjs';
import { resolveSession, saveState, loadConfig, detectContextWindow, adoptObservedWindow } from './lib/state.mjs';

// Options that take a value are pulled out first, so `pin "x" --session id`
// pins "x" and not the flag.
const VALUE_FLAGS = new Set(['--session', '--transcript', '--answers']);
const raw = process.argv.slice(2);
const opts = {};
const args = [];
for (let i = 0; i < raw.length; i++) {
  if (VALUE_FLAGS.has(raw[i])) opts[raw[i]] = raw[++i];
  else args.push(raw[i]);
}
const cmd = args[0] || 'report';
const flag = (name) => opts[name];
const has = (name) => args.includes(name);

function run() {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const resolved = resolveSession({ sessionId: flag('--session'), cwd, transcript: flag('--transcript') });
  if (resolved.error) throw new Error(resolved.error);
  let state = resolved.state;
  const transcript = resolved.transcript;
  // State may only ever belong to the session being measured. A state file
  // for another session must not lend its pins, probe or baseline.
  if (state && resolved.sessionId && state.sessionId !== resolved.sessionId) state = null;
  if (resolved.byRecency) process.stderr.write(`vitals: no session id given; using ${state.sessionId}, the only active session here
`);

  switch (cmd) {
    case 'report': {
      if (!transcript || !fs.existsSync(transcript)) throw new Error('no transcript found; pass --transcript <path>');
      const config = loadConfig();
      const events = parseTranscript(transcript);
      const vitals = computeVitals(events, { ...config, contextWindow: state?.contextWindow || detectContextWindow(process.env.SESSION_VITALS_MODEL, cwd) });
      if (state && adoptObservedWindow(state, vitals)) state = saveState(state);
      const probe = state?.probe && !state.probe.stale && vitals.prompts - state.probe.promptIndex <= 10 ? state.probe : null;
      const result = scoreVitals(vitals, probe);
      if (has('--json')) process.stdout.write(JSON.stringify({ transcript, vitals, result, pins: state?.pins || [], probe: state?.probe || null }, null, 2) + '\n');
      else process.stdout.write(formatReport(result, vitals, state || {}) + `\n\nTranscript: ${transcript}\n`);
      return;
    }
    case 'probe': {
      if (!state) throw new Error(noState(resolved));
      const answersPath = flag('--answers');
      if (!answersPath) { process.stdout.write(probeQuestions()); return; }
      const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
      const events = transcript && fs.existsSync(transcript) ? parseTranscript(transcript) : [];
      const vitals = computeVitals(events, { contextWindow: state.contextWindow });
      adoptObservedWindow(state, vitals);
      const scored = scoreProbe(answers, state, vitals);
      state.probe = { ...scored, promptIndex: vitals.prompts, ts: new Date().toISOString(), stale: false, answers };
      saveState(state);
      process.stdout.write(formatProbe(scored, state, vitals) + '\n');
      return;
    }
    case 'pin': {
      if (!state) throw new Error(noState(resolved));
      const text = args.slice(1).join(' ').trim();
      if (!text) throw new Error('usage: pin "<constraint>"');
      const existing = state.pins.find((p) => p.text === text);
      if (existing) existing.source = 'manual'; else state.pins.push({ text, source: 'manual', ts: new Date().toISOString() });
      saveState(state);
      process.stdout.write(`pinned (${state.pins.length} total)\n`);
      return;
    }
    case 'pins': {
      if (!state) throw new Error(noState(resolved));
      if (!state.pins.length) { process.stdout.write('no pins\n'); return; }
      state.pins.forEach((p, i) => process.stdout.write(`${i + 1}. [${p.source}] ${p.text}\n`));
      return;
    }
    case 'unpin': {
      if (!state) throw new Error(noState(resolved));
      const i = Number(args[1]) - 1;
      if (!(i >= 0 && i < state.pins.length)) throw new Error('unpin <index from pins>');
      const [removed] = state.pins.splice(i, 1);
      saveState(state);
      process.stdout.write(`removed: ${removed.text}\n`);
      return;
    }
    case 'baseline': {
      if (!state) throw new Error(noState(resolved));
      const text = args.slice(1).join(' ').trim();
      if (!text) { process.stdout.write((state.baseline?.task || '(none)') + '\n'); return; }
      state.baseline = { task: text, ts: new Date().toISOString(), source: 'manual' };
      saveState(state);
      process.stdout.write('baseline set\n');
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

function noState(resolved) {
  return resolved.sessionId
    ? `no session state for ${resolved.sessionId}; the hooks have not run for this session yet`
    : 'no session state; the hooks have not run for this project yet';
}

function probeQuestions() {
  return [
    'RETENTION PROBE. Answer from memory, in your own words, before running anything else.',
    'Do not scroll back through the conversation to look these up; the point is to measure what you are holding, not what you can find.',
    'Write the answers as JSON to a scratch file with these keys, then run: vitals-cli probe --answers <file>',
    '',
    '  task          one sentence: what is this session for?',
    '  constraints   array of strings: every standing rule the user or CLAUDE.md has put in force for this work',
    '  files         array of paths you have edited or created in this session',
    '  lastCorrection the most recent thing the user corrected you on, or null',
    '  nextStep      one sentence: what you would do next',
    '',
  ].join('\n');
}

// Score the patient's answers against the informant's records. Low
// overlap on the task, missing pins, and missed edited files all count.
function scoreProbe(answers, state, vitals) {
  const details = [];
  let mismatches = 0;

  const baseline = state.baseline?.task || vitals.firstPrompt || '';
  // Overlap coefficient, not Jaccard: a long, detailed paraphrase of a short
  // request must pass as long as it carries the request's key words.
  const overlap = overlapCoefficient(contentWords(baseline), contentWords(answers.task || ''));
  if (!baseline) details.push('no baseline task on record yet (the first non-slash prompt becomes it), so task recall was not scored');
  else if (overlap < 0.25) { mismatches++; details.push(`task statement barely overlaps the original request (overlap ${overlap.toFixed(2)})`); }

  const pins = state.pins.filter((p) => p.source === 'manual').map((p) => p.text);
  const said = (answers.constraints || []).map((s) => contentWords(String(s)));
  const missingPins = pins.filter((pin) => !said.some((w) => jaccard(contentWords(pin), w) >= 0.3));
  if (pins.length && missingPins.length) { mismatches++; details.push(`${missingPins.length} of ${pins.length} pinned constraints not recalled`); }

  const claimed = new Set((answers.files || []).map((f) => path.basename(String(f))));
  const actual = vitals.editedFiles.map((f) => path.basename(f));
  const missedFiles = actual.filter((f) => !claimed.has(f));
  if (actual.length && missedFiles.length / actual.length > 0.5) { mismatches++; details.push(`recalled ${actual.length - missedFiles.length} of ${actual.length} edited files`); }

  if (vitals.recentCorrections > 0 && !answers.lastCorrection) { mismatches++; details.push('user corrected recently but no correction recalled'); }

  return { mismatches, summary: details.join('; '), details, missingPins, missedFiles, taskOverlap: overlap };
}

function formatProbe(s, state, vitals) {
  const out = [`PROBE RESULT: ${s.mismatches} mismatch(es)`];
  for (const d of s.details) out.push(`  - ${d}`);
  if (!s.mismatches) out.push('  task, constraints, files and corrections all consistent with the record');
  if (s.missingPins.length) { out.push('  Pins not recalled (now re-shown):'); for (const p of s.missingPins) out.push(`    - ${p}`); }
  if (s.missedFiles.length) out.push(`  Edited files not recalled: ${s.missedFiles.join(', ')}`);
  out.push(`  Original request (first ${Math.min(300, (state.baseline?.task || '').length)} chars): ${(state.baseline?.task || vitals.firstPrompt || '').slice(0, 300)}`);
  out.push('Run `vitals-cli report` to see how this changes the recommendation.');
  return out.join('\n');
}

const STOP = new Set('a an the and or but of to in on for with at by from as is are was were be been this that these those it its into over under about we you i me my our your they them their do does did done can could should would will just also not no yes so if then than when where which who what how why all any some more most very really please let lets make sure want need like get got'.split(' '));
function contentWords(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

try { run(); } catch (err) { process.stderr.write(`vitals: ${err.message}\n`); process.exit(1); }
