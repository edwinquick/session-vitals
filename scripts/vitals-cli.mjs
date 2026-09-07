#!/usr/bin/env node
// CLI used by the /vitals skill and by humans.
//   vitals-cli report [--transcript <path>] [--json]
//   vitals-cli probe                 print the retention probe questions
//   vitals-cli probe --answers <file> score answers against baseline, store result
//   vitals-cli pin "<constraint>"    pin a constraint for re-injection after compaction
//   vitals-cli pins                  list pins
//   vitals-cli unpin <index>         remove a pin (1-based, from `pins`)
//   vitals-cli baseline "<task>"     override the baseline task statement
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscript } from './lib/transcript.mjs';
import { computeVitals } from './lib/vitals.mjs';
import { scoreVitals, formatReport } from './lib/rubric.mjs';
import { findStateForCwd, guessTranscriptForCwd, saveState, loadConfig, detectContextWindow } from './lib/state.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'report';
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);

function run() {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let state = findStateForCwd(cwd) || findStateForCwd(null);
  const transcript = flag('--transcript') || state?.transcriptPath || guessTranscriptForCwd(cwd);

  switch (cmd) {
    case 'report': {
      if (!transcript || !fs.existsSync(transcript)) throw new Error('no transcript found; pass --transcript <path>');
      const config = loadConfig();
      const events = parseTranscript(transcript);
      const vitals = computeVitals(events, { ...config, contextWindow: state?.contextWindow || detectContextWindow(process.env.SESSION_VITALS_MODEL) });
      const probe = state?.probe && !state.probe.stale && vitals.prompts - state.probe.promptIndex <= 10 ? state.probe : null;
      const result = scoreVitals(vitals, probe);
      if (has('--json')) process.stdout.write(JSON.stringify({ transcript, vitals, result, pins: state?.pins || [], probe: state?.probe || null }, null, 2) + '\n');
      else process.stdout.write(formatReport(result, vitals, state || {}) + `\n\nTranscript: ${transcript}\n`);
      return;
    }
    case 'probe': {
      if (!state) throw new Error('no session state; the hooks have not run for this project yet');
      const answersPath = flag('--answers');
      if (!answersPath) { process.stdout.write(probeQuestions()); return; }
      const answers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
      const events = transcript && fs.existsSync(transcript) ? parseTranscript(transcript) : [];
      const vitals = computeVitals(events, { contextWindow: state.contextWindow });
      const scored = scoreProbe(answers, state, vitals);
      state.probe = { ...scored, promptIndex: vitals.prompts, ts: new Date().toISOString(), stale: false, answers };
      saveState(state);
      process.stdout.write(formatProbe(scored, state, vitals) + '\n');
      return;
    }
    case 'pin': {
      if (!state) throw new Error('no session state; the hooks have not run for this project yet');
      const text = args.slice(1).join(' ').trim();
      if (!text) throw new Error('usage: pin "<constraint>"');
      const existing = state.pins.find((p) => p.text === text);
      if (existing) existing.source = 'manual'; else state.pins.push({ text, source: 'manual', ts: new Date().toISOString() });
      saveState(state);
      process.stdout.write(`pinned (${state.pins.length} total)\n`);
      return;
    }
    case 'pins': {
      if (!state) throw new Error('no session state');
      if (!state.pins.length) { process.stdout.write('no pins\n'); return; }
      state.pins.forEach((p, i) => process.stdout.write(`${i + 1}. [${p.source}] ${p.text}\n`));
      return;
    }
    case 'unpin': {
      if (!state) throw new Error('no session state');
      const i = Number(args[1]) - 1;
      if (!(i >= 0 && i < state.pins.length)) throw new Error('unpin <index from pins>');
      const [removed] = state.pins.splice(i, 1);
      saveState(state);
      process.stdout.write(`removed: ${removed.text}\n`);
      return;
    }
    case 'baseline': {
      if (!state) throw new Error('no session state');
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
  const overlap = jaccard(contentWords(baseline), contentWords(answers.task || ''));
  if (!baseline) details.push('no baseline task on record yet (the first non-slash prompt becomes it), so task recall was not scored');
  else if (overlap < 0.12) { mismatches++; details.push(`task statement barely overlaps the original request (overlap ${overlap.toFixed(2)})`); }

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

try { run(); } catch (err) { process.stderr.write(`vitals: ${err.message}\n`); process.exit(1); }
