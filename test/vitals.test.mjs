import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptText } from '../scripts/lib/transcript.mjs';
import { computeVitals, isCorrection, extractConstraintCandidates } from '../scripts/lib/vitals.mjs';
import { scoreVitals, formatOneLine, formatReport } from '../scripts/lib/rubric.mjs';
import { healthySession, degradedSession, thrashingSession, TranscriptBuilder } from './fixtures/make-transcript.mjs';

const run = (b) => { const v = computeVitals(parseTranscriptText(b.text()), { contextWindow: 200_000 }); return { v, r: scoreVitals(v) }; };

test('parser: keeps main-chain prompts, tools, usage, compactions; drops meta and sidechains', () => {
  const b = new TranscriptBuilder();
  b.prompt('do the thing').meta('<system-reminder>ignore</system-reminder>').prompt('<local-command-caveat>x</local-command-caveat>');
  b.tool('Read', { file_path: '/a' }).tool('Read', { file_path: '/b' }, { sidechain: true }).compact('manual');
  const ev = parseTranscriptText(b.text());
  assert.equal(ev.filter((e) => e.kind === 'prompt').length, 1);
  assert.equal(ev.filter((e) => e.kind === 'tool_use').length, 1);
  assert.equal(ev.filter((e) => e.kind === 'compact').length, 1);
  assert.equal(ev.filter((e) => e.kind === 'compact_summary').length, 1);
  const usage = ev.filter((e) => e.kind === 'usage');
  assert.ok(usage.length >= 1);
  assert.ok(usage[0].contextTokens > 10_000, 'context tokens come from iterations when top-level usage is zero');
});

test('healthy session scores healthy and recommends continue', () => {
  const { v, r } = run(healthySession());
  assert.equal(r.tier, 'healthy');
  assert.equal(r.recommendation.action, 'continue');
  assert.equal(v.recentCorrections, 0);
  assert.equal(v.editedFiles.length, 2);
  assert.equal(v.promptsSinceProgress, 0);
});

test('degraded session: rereads, retry loop, errors, corrections are all detected', () => {
  const { v, r } = run(degradedSession());
  assert.equal(v.rereadFiles.length, 1);
  assert.ok(v.retryRuns >= 2, `retry runs ${v.retryRuns}`);
  assert.equal(v.recentCorrections, 2);
  assert.ok(v.recentErrorRate > 0.25);
  assert.ok(v.contextPct > 0.75);
  assert.ok(['degraded', 'critical'].includes(r.tier), r.tier);
  // Memory signals (corrections at 2, retries at 2) mean compaction would not help.
  assert.notEqual(r.recommendation.action, 'compact');
  assert.ok(['handoff', 'abandon'].includes(r.recommendation.action), r.recommendation.action);
});

test('thrashing after repeated compaction is critical and recommends handoff, not abandon', () => {
  const { v, r } = run(thrashingSession());
  assert.equal(v.compactions.length, 2);
  assert.equal(v.thrashing, true);
  assert.equal(r.tier, 'critical');
  assert.equal(r.recommendation.action, 'handoff');
  assert.match(r.recommendation.why, /subagents/);
});

test('a single auto-compaction at peak fill is not thrashing, and old compactions age out', () => {
  const b = new TranscriptBuilder();
  b.prompt('Long task.');
  // The turn that triggers auto-compaction sits at peak fill; those usage rows precede the boundary.
  b.setContext(190_000).tool('Read', { file_path: '/tmp/proj/a.ts' }).compact('auto', 20_000);
  for (let i = 0; i < 45; i++) { b.prompt(`step ${i}`); b.tool('Edit', { file_path: '/tmp/proj/a.ts', old_string: String(i), new_string: 'x' }, { grow: 500 }).assistantText('ok', 200); }
  const { v, r } = run(b);
  assert.equal(v.compactions.length, 1);
  assert.equal(v.thrashing, false);
  assert.equal(v.fastRefill, false);
  assert.equal(v.recentCompactions, 0);
  assert.ok(!r.signals.some((s) => s.key === 'compaction'));
});

test('fast refill after one compaction is degraded/handoff, not critical', () => {
  const b = new TranscriptBuilder();
  b.prompt('Big task.').setContext(190_000).assistantText().compact('auto', 20_000);
  b.prompt('continue');
  for (let i = 0; i < 4; i++) b.tool('Read', { file_path: `/tmp/proj/big${i}.ts` }, { grow: 25_000 });
  b.assistantText();
  const { v, r } = run(b);
  assert.equal(v.fastRefill, true);
  assert.equal(v.thrashing, false);
  assert.equal(r.tier, 'degraded');
  assert.equal(r.recommendation.action, 'handoff');
  assert.match(r.recommendation.why, /subagents/);
});

test('abandon requires a memory signal: three corrections in six prompts', () => {
  const b = healthySession();
  for (const t of ['No, that is the wrong file.', 'You already changed that, undo it.', 'Again: only the upload client.']) { b.prompt(t); b.assistantText(); }
  const { v, r } = run(b);
  assert.equal(v.recentCorrections, 3);
  assert.equal(r.tier, 'critical');
  assert.equal(r.recommendation.action, 'abandon');
});

test('heavy context with no memory signals recommends compact', () => {
  const b = healthySession();
  b.prompt('Now look at the rest of the module.');
  for (let i = 0; i < 12; i++) b.tool('Read', { file_path: `/tmp/proj/src/m${i}.ts` }, { grow: 9000 });
  b.setContext(170_000).assistantText();
  const { r } = run(b);
  assert.equal(r.tier, 'degraded');
  assert.equal(r.recommendation.action, 'compact');
});

test('probe mismatches escalate the recommendation', () => {
  const { v } = run(healthySession());
  const r0 = scoreVitals(v, null);
  assert.equal(r0.tier, 'healthy');
  // One mismatch alone must not make a healthy session degraded: a task
  // paraphrase scored low once and produced four false handoff warnings.
  const r1 = scoreVitals(v, { mismatches: 1, stale: false });
  assert.equal(r1.tier, 'healthy');
  const r2 = scoreVitals(v, { mismatches: 2, stale: false });
  assert.equal(r2.tier, 'degraded');
  assert.equal(r2.recommendation.action, 'handoff');
  const r3 = scoreVitals(v, { mismatches: 3, stale: false });
  assert.equal(r3.tier, 'critical');
  assert.equal(r3.recommendation.action, 'abandon');
  const stale = scoreVitals(v, { mismatches: 3, stale: true });
  assert.equal(stale.tier, 'healthy');
});

test('correction and constraint detectors', () => {
  assert.ok(isCorrection("No, I meant the other file"));
  assert.ok(isCorrection("That's not what I asked"));
  assert.ok(isCorrection("you already did that"));
  assert.ok(!isCorrection('Nice, now add tests'));
  assert.ok(!isCorrection('Notice the pattern here'));
  // Shapes taken from real transcripts.
  assert.ok(isCorrection('ok your context is stale, we added a site delete page a few days ago.'));
  assert.ok(isCorrection('We already did a cleanup and had a new launch plan that this session was coordinating with'));
  assert.ok(isCorrection('7am not 10am'));
  assert.ok(isCorrection("that url doesn't work, it errors"));
  assert.ok(isCorrection("don't go to local yet, we haven't used cloud resources at all"));
  assert.ok(isCorrection("we're still working, it's not tomorrow yet. break it down"));
  assert.ok(!isCorrection('[Request interrupted by user]'));
  assert.ok(!isCorrection("just confirming that the triage skills don't allow for any input to alter prompts?"));
  assert.ok(!isCorrection("I don't think I have the key we set in supabase. I can't find it so we may need to recreate it"));
  assert.ok(!isCorrection('what is the ADMIN_REGION_DISCOVERY_SECRET supposed to be again?'));
  assert.ok(!isCorrection('ok lets take a deeper dive at all of the issues in GH especially older ones that may not be triaged'));
  assert.ok(!isCorrection("no worries, we'll test it again now that we know it works."));
  assert.ok(!isCorrection('good morning. We have a lot of stuff partially done and CI jobs failed'));
  assert.ok(!isCorrection("lets fix and close 1500 now so we're not confused next week."));
  assert.ok(!isCorrection('does 1417 matter, we have the same docker setup here on this machine correct?'));
  const c = extractConstraintCandidates('Fix the parser. Never edit generated files. Do you want tests?\nAlways run lint before committing.');
  assert.deepEqual(c, ['Never edit generated files.', 'Always run lint before committing.']);
  assert.deepEqual(extractConstraintCandidates('Fix the flaky auth test. Do not touch the database schema.'), ['Do not touch the database schema.']);
  assert.deepEqual(extractConstraintCandidates("Please don't push to main, and you must not touch the schema."), ["Please don't push to main, and you must not touch the schema."]);
  // Report prose from a subagent that leaked in through a task notification. None of it is a rule.
  for (const junk of [
    '**Labeling.** I applied `bug` only.',
    'The audit was read-only throughout, and the working tree is untouched.</result>',
    'Exports 2 of the 4 contracts; `riderRideInPublish` and `curatedDestinationsPublish` are reachable only by deep path.',
    'They never assert the parsed output, so the default is untested.',
    'Has no card on the dashboard index; reachable only by deep link from a claim detail page.',
    'PostgrestError objects survive, Errors do not, so the logs are silently lossy for the hardest bugs.',
  ]) assert.deepEqual(extractConstraintCandidates(junk), [], junk);
});

test('formatters produce a one-liner and a report', () => {
  const { v, r } = run(degradedSession());
  const line = formatOneLine(r, v);
  assert.match(line, /^Session vitals: (degraded|critical)\. /);
  assert.match(line, /Suggest: hand off to a fresh session\. \/vitals for details\.$/);
  assert.ok(!/[a-z_]+:\d/.test(line), 'no key:severity tokens in the user-facing line');
  const rep = formatReport(r, v, { pins: [{ text: 'Do not touch the schema', source: 'manual' }] });
  assert.match(rep, /^SESSION VITALS: (degraded|critical) → hand off to a fresh session/);
  assert.match(rep, /What's showing\n  ●●○  /);
  assert.match(rep, /You corrected it 2 times in the last 6 prompts/);
  assert.match(rep, /Why hand off\n/);
  assert.match(rep, /Pinned constraints \(1\)\n  • Do not touch the schema/);
  assert.match(rep, /Session: 3 prompts · 12 tool calls/);
  const { v: hv, r: hr } = run(healthySession());
  const healthy = formatReport(hr, hv, {});
  assert.match(healthy, /^SESSION VITALS: healthy → carry on\n\nNothing showing\./);
});

test('window is inferred as 1M when the session has already exceeded 200k', () => {
  const b = new TranscriptBuilder();
  b.prompt('Long session.').setContext(450_000).assistantText();
  const v = computeVitals(parseTranscriptText(b.text()), { contextWindow: 200_000 });
  assert.equal(v.contextWindow, 1_000_000);
  assert.ok(v.contextPct < 0.5);
});

test('research session with no edits is not penalized for stalling', () => {
  const b = new TranscriptBuilder();
  b.prompt('Explain how the auth flow works.');
  for (let i = 0; i < 8; i++) { b.tool('Read', { file_path: `/tmp/proj/src/x${i}.ts` }).assistantText(); b.prompt('and then?'); }
  const { r } = run(b);
  assert.ok(!r.signals.some((s) => s.key === 'stalled'));
  assert.equal(r.tier, 'healthy');
});
