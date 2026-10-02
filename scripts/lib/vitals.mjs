// The informant layer: metrics derived from the transcript alone, so the
// model being measured cannot bias them (the clinical analogue is the AD8
// informant questionnaire, versus the patient's own MMSE answers).
import crypto from 'node:crypto';

export const DEFAULTS = {
  contextWindow: 200_000,
  recentToolWindow: 30,
  recentPromptWindow: 6,
  thrashRefillFraction: 0.5,
  thrashWithinPrompts: 10,
  recentCompactionPrompts: 40,
};

// Two shapes of correction, calibrated against real transcripts:
//   1. an opener, after optional filler ("ok", "wait", "hmm", "actually", "hold on")
//   2. a phrase anywhere in the prompt that only appears when the user is
//      pushing back on something the model got wrong or forgot
const FILLER = "(?:(?:ok(?:ay)?|hmm+|wait|actually|hold on|so|well|also|please)[,.!\\s]+)*";
const CORRECTION_OPENER_RE = new RegExp('^' + FILLER + "(no\\b|nope\\b|not that\\b|wrong\\b|that'?s (not|wrong|still)|that is not\\b|i (meant|said|asked|told you)\\b|you (already|just|didn'?t|did not|ignored|missed|skipped|forgot)\\b|again\\b|stop\\b|undo\\b|revert\\b|why did you\\b|as i said\\b|i already\\b|we already\\b|still (broken|wrong|not|failing)\\b|didn'?t (i|we) (just|already)\\b|don'?t (do|go|use|run|change|touch)\\b)", 'i');
const CORRECTION_ANYWHERE_RE = /(your context is stale|you(?:'re| are) (?:confused|mistaken|wrong)|that'?s (?:still )?not what i|as i (?:said|asked|told you)|i (?:already )?told you|we already (?:did|filed|fixed|decided|discussed|covered|have|removed|closed|merged|added|changed)\b|this session (?:already|was)|(?:doesn'?t|does not|didn'?t|isn'?t|is not) (?:work|match|exist|apply)|still (?:broken|failing|wrong|doesn'?t|isn'?t)|(?:we'?re|i'?m) still (?:working|here|on it|going))/i;
// "7am not 10am": a very short prompt whose whole content is X not Y.
const CORRECTION_SHORT_NOT_RE = /^.{1,20}\bnot\b.{1,20}$/i;
// Openers that look like "no" but are not corrections.
const NOT_A_CORRECTION_RE = /^(?:no (?:worries|problem|rush|stress|need|hurry)|nope,? (?:all good|that'?s fine))/i;
// A constraint is a short imperative addressed to the agent. Sentences that
// merely contain "only" or "without", or that carry markdown, code, or
// closing tags, are report prose and not rules.
const CONSTRAINT_RE = /^(never|always|do not|don'?t|must|no matter what|under no circumstances|please (?:never|always|do not|don'?t))\b|(?:^|\b(?:you|please|and|but|also)\s+)(?:must not|must never|should never|never|do not|don'?t) (?:ever )?[a-z]/i;
const NOT_A_CONSTRAINT_RE = /[`*<>{}|]|^\s*[-#\d.)]|\bI (?:did|applied|found|checked|ran)\b|\bwas\b|\bwere\b|\bis\b .*\bonly\b/i;
const PROGRESS_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Writes that are not to the project: discarded output and scratch space.
const NOT_A_PROJECT_FILE_RE = /^(?:\/dev\/|\$null$|nul$|&|\$\{?(?:env:)?(?:TEMP|TMP|TMPDIR)\b)|(?:^|[\\/])(?:tmp|temp|scratchpad)[\\/]|^\/tmp\b/i;

// A target must look like a file with an extension. That drops Makefile and
// friends, and also every jq timestamp, version number and code fragment that
// a `>` comparison would otherwise turn into an "edited file".
const FILE_SHAPE_RE = /^[\w.~/\\:@$+-]+\.[A-Za-z0-9]{1,10}$/;

// Files a shell command writes, when it does so in one of the common shapes:
// `sed -i`, `>`/`>>` redirection (which covers `cat > f <<EOF`), `tee`,
// PowerShell's Set-Content/Add-Content/Out-File, and scripts that open a file
// for writing. Conservative on purpose: a missed edit costs less than a
// `grep foo > /tmp/x` counted as one.
export function shellEditTargets(command) {
  const targets = new Set();
  // Script bodies (python/node heredocs or -c/-e strings) carry the writes.
  const q = String.raw`\\?(['"\x60])`;
  for (const m of command.matchAll(new RegExp(String.raw`\bopen\(\s*[rf]?${q}([^'"\x60\n\\]+)\\?\1\s*,\s*\\?(['"])[wax]\+?b?\\?\3`, 'g'))) targets.add(m[2]);
  for (const m of command.matchAll(new RegExp(String.raw`\bPath\(\s*[rf]?${q}([^'"\x60\n\\]+)\\?\1\s*\)\.write_(?:text|bytes)\(`, 'g'))) targets.add(m[2]);
  for (const m of command.matchAll(new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|writeFile)\(\s*${q}([^'"\x60\n\\]+)\\?\1`, 'g'))) targets.add(m[2]);
  // Shell syntax only outside heredoc bodies and quoted strings, so a `>` in
  // generated HTML, a jq filter or a node arrow function is not a redirection.
  const shell = maskQuoted(command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<$2$3'));
  for (const m of shell.matchAll(/(?:^|\s)>>?\s*([^\s;&|<>()]+)/g)) targets.add(m[1]);
  for (const m of shell.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|<>()]+)/g)) targets.add(m[1]);
  for (const m of shell.matchAll(/\b(?:Set-Content|Add-Content|Out-File)\b[^|;\n]*?(?:-(?:Path|FilePath|LiteralPath)\s+|\s)([^\s|;-][^\s|;]*)/gi)) targets.add(m[1]);
  // sed: only with an in-place flag; the files are the trailing arguments.
  for (const m of shell.matchAll(/\bsed\s+([^|;&\n]*)/g)) {
    const words = m[1].trim().split(/\s+/);
    if (!words.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) continue;
    for (let i = words.length - 1; i > 0 && FILE_SHAPE_RE.test(words[i]); i--) targets.add(words[i]);
  }
  // `S=<scratchpad>; cat > "$S/pr.md"` is a scratch write, so expand variables
  // the same command assigns before deciding what is project and what is not.
  const vars = new Map();
  for (const m of command.matchAll(/(?:^|[\s;&(])\$?(\w+)\s?=\s?(['"]?)([^\s'";&|]+)\2/g)) vars.set(m[1].toLowerCase(), m[3]);
  const expand = (f) => f.replace(/^\$\{?(?:env:)?(\w+)\}?/, (m, v) => vars.get(v.toLowerCase()) ?? m);
  return [...targets].filter((f) => FILE_SHAPE_RE.test(f) && !NOT_A_PROJECT_FILE_RE.test(expand(f)));
}

// Replace each quoted string with "" unless its content is itself a plain
// file path (`> "docs/a.md"`, `sed -i '...' "src/x.ts"`), which is kept bare.
// A small scanner rather than a regex, because agent commands nest quotes,
// escape them, and run scripts across many lines inside them.
function maskQuoted(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { out += s.slice(i, i + 2); i++; continue; }
    if (c !== "'" && c !== '"') { out += c; continue; }
    let body = '';
    let j = i + 1;
    for (; j < s.length && s[j] !== c; j++) {
      if (c === '"' && s[j] === '\\' && '"\\$`'.includes(s[j + 1])) j++;
      body += s[j];
    }
    out += FILE_SHAPE_RE.test(body) ? body : '""';
    i = j;
  }
  return out;
}

export function isCorrection(text) {
  const t = text.trim();
  if (!t || t.startsWith('[')) return false; // "[Request interrupted by user]" and similar markers
  if (NOT_A_CORRECTION_RE.test(t)) return false;
  if (CORRECTION_OPENER_RE.test(t)) return true;
  if (CORRECTION_ANYWHERE_RE.test(t)) return true;
  if (!t.includes('\n') && !/\?\s*$/.test(t) && CORRECTION_SHORT_NOT_RE.test(t)) return true;
  return false;
}

// Short imperative lines that read like standing constraints. These are the
// statements that decay hardest under compaction when left as plain user
// turns (Governance Decay, arXiv 2606.22528), so they are candidates to pin.
export function extractConstraintCandidates(text) {
  const out = [];
  for (const rawLine of text.split(/\n|(?<=[.!])\s+/)) {
    const line = rawLine.trim();
    if (line.length < 12 || line.length > 160) continue;
    if (!CONSTRAINT_RE.test(line)) continue;
    if (/\?$/.test(line)) continue;
    if (NOT_A_CONSTRAINT_RE.test(line)) continue;
    out.push(line);
  }
  return out;
}

export function computeVitals(events, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const prompts = [];
  const toolUses = [];
  const resultsById = new Map();
  const compactions = [];
  const usages = [];
  let apiErrors = 0;
  let firstTs = null, lastTs = null;

  let seq = 0;
  for (const e of events) {
    seq++;
    if (e.ts) { firstTs ??= e.ts; lastTs = e.ts; }
    switch (e.kind) {
      case 'prompt': prompts.push({ ts: e.ts, text: e.text, toolIndex: toolUses.length, correction: isCorrection(e.text) }); break;
      case 'tool_use': toolUses.push({ ...e, promptIndex: prompts.length, hash: hashInput(e.name, e.input) }); break;
      case 'tool_result': resultsById.set(e.id, e.isError); break;
      case 'compact': compactions.push({ ...e, seq, promptIndex: prompts.length }); break;
      case 'usage': usages.push({ ...e, seq, promptIndex: prompts.length }); break;
      case 'api_error': apiErrors++; break;
    }
  }
  for (const t of toolUses) t.isError = resultsById.get(t.id) === true;

  const contextTokens = usages.length ? usages[usages.length - 1].contextTokens : 0;
  const peakContextTokens = usages.reduce((m, u) => Math.max(m, u.contextTokens), 0);
  // The hook payload does not always carry a model id. If the session has
  // already held more than the assumed window, it must be a 1M-window model.
  if (peakContextTokens > o.contextWindow) o.contextWindow = 1_000_000;
  const contextPct = o.contextWindow ? contextTokens / o.contextWindow : 0;

  const recentTools = toolUses.slice(-o.recentToolWindow);
  const errRate = (arr) => (arr.length ? arr.filter((t) => t.isError).length / arr.length : 0);
  const recentErrorRate = errRate(recentTools);
  const overallErrorRate = errRate(toolUses);

  // Identical consecutive calls: same tool, same input. Retrying the same
  // failing command is the canonical loop signature.
  const retryRuns = countRetryRuns(recentTools);
  const retryRunsAll = countRetryRuns(toolUses);

  // Files read three or more times inside the recent window.
  const readCounts = new Map();
  for (const t of recentTools.slice(-40)) {
    if (READ_TOOLS.has(t.name) && t.input && t.input.file_path) readCounts.set(t.input.file_path, (readCounts.get(t.input.file_path) || 0) + 1);
  }
  const rereadFiles = [...readCounts.entries()].filter(([, n]) => n >= 3).map(([f, n]) => ({ file: f, count: n }));

  const recentPrompts = prompts.slice(-o.recentPromptWindow);
  const recentCorrections = recentPrompts.filter((p) => p.correction).length;
  const totalCorrections = prompts.filter((p) => p.correction).length;

  let lastProgressPromptIndex = -1;
  let everProgressed = false;
  const editedFiles = new Set();
  for (const t of toolUses) {
    const command = SHELL_TOOLS.has(t.name) && typeof t.input.command === 'string' ? t.input.command : null;
    const isCommit = command !== null && /\bgit\s+commit\b/.test(command);
    const shellTargets = command !== null ? shellEditTargets(command) : [];
    if (PROGRESS_TOOLS.has(t.name) || isCommit || shellTargets.length) {
      everProgressed = true;
      lastProgressPromptIndex = t.promptIndex;
      if (t.input.file_path) editedFiles.add(t.input.file_path);
      for (const f of shellTargets) editedFiles.add(f);
    }
  }
  const shellCalls = toolUses.filter((t) => SHELL_TOOLS.has(t.name)).length;
  const promptsSinceProgress = everProgressed ? prompts.length - lastProgressPromptIndex : null;

  // Thrashing: the context refilled past a fraction of the window within a
  // few prompts after a compaction. The pattern of work has to change; more
  // compaction will not help.
  // Ordered by event sequence, not prompt index: an auto-compaction lands
  // mid-turn, and the usage rows from earlier in that same turn sit at peak
  // fill. Counting them as "after" would flag every compaction as thrashing.
  // fastRefill is the leading indicator: the window came back to half full
  // within a few prompts of the last compaction. thrashing is the confirmed
  // pattern: two compactions within a few prompts of each other.
  let fastRefill = false;
  let thrashing = false;
  const lastCompaction = compactions[compactions.length - 1];
  if (lastCompaction) {
    const after = usages.filter((u) => u.seq > lastCompaction.seq && u.promptIndex - lastCompaction.promptIndex <= o.thrashWithinPrompts);
    const peakAfter = after.reduce((m, u) => Math.max(m, u.contextTokens), 0);
    fastRefill = peakAfter >= o.thrashRefillFraction * o.contextWindow;
  }
  for (let i = 1; i < compactions.length; i++) {
    if (compactions[i].promptIndex - compactions[i - 1].promptIndex <= o.thrashWithinPrompts && prompts.length - compactions[i].promptIndex <= o.recentCompactionPrompts) thrashing = true;
  }
  // Compactions are scored by recency. Six compactions across a week-long
  // session is a heavy session, not a declining one; three in the last forty
  // prompts is.
  const recentCompactions = compactions.filter((c) => prompts.length - c.promptIndex <= o.recentCompactionPrompts).length;

  return {
    contextWindow: o.contextWindow,
    contextTokens, contextPct, peakContextTokens,
    prompts: prompts.length,
    toolCalls: toolUses.length,
    recentToolCalls: recentTools.length,
    recentErrorRate, overallErrorRate,
    retryRuns, retryRunsAll,
    rereadFiles,
    recentCorrections, totalCorrections,
    correctionPromptTexts: recentPrompts.filter((p) => p.correction).map((p) => p.text.slice(0, 120)),
    promptsSinceProgress, everProgressed,
    editedFiles: [...editedFiles],
    shellCalls,
    compactions: compactions.map((c) => ({ trigger: c.trigger, preTokens: c.preTokens, postTokens: c.postTokens, promptIndex: c.promptIndex })),
    recentCompactions,
    promptsSinceCompaction: lastCompaction ? prompts.length - lastCompaction.promptIndex : null,
    thrashing,
    fastRefill,
    apiErrors,
    firstPrompt: prompts[0] ? prompts[0].text : null,
    // The latest prompt that states work rather than pushing back or nodding
    // along ("ok", "next"), used to name the current step in suggested commands.
    lastRequest: [...prompts].reverse().find((p) => !p.correction && !p.text.trimStart().startsWith('/') && p.text.trim().length >= 20)?.text ?? null,
    elapsedMinutes: firstTs && lastTs ? Math.round((lastTs - firstTs) / 60000) : null,
  };
}

function countRetryRuns(tools) {
  let runs = 0;
  for (let i = 1; i < tools.length; i++) {
    if (tools[i].hash === tools[i - 1].hash && (i === 1 || tools[i - 1].hash !== tools[i - 2].hash)) runs++;
  }
  return runs;
}

function hashInput(name, input) {
  return crypto.createHash('sha1').update(name + ' ' + stableStringify(input)).digest('hex').slice(0, 16);
}
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
