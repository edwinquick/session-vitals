// Synthetic transcript builder mirroring the Claude Code 2.1.x JSONL shape.
let n = 0;
const id = () => 'u' + (++n).toString(36).padStart(6, '0');

export class TranscriptBuilder {
  constructor({ sessionId = 'sess-test', startMs = Date.parse('2026-09-01T10:00:00Z') } = {}) {
    this.rows = [];
    this.sessionId = sessionId;
    this.t = startMs;
    this.ctx = 12_000;
  }
  tick(ms = 20_000) { this.t += ms; return new Date(this.t).toISOString(); }
  base(extra = {}) {
    return { uuid: id(), parentUuid: null, isSidechain: false, sessionId: this.sessionId, timestamp: this.tick(), cwd: '/tmp/proj', version: '2.1.252', ...extra };
  }
  prompt(text, extra = {}) {
    this.rows.push(this.base({ type: 'user', message: { role: 'user', content: text }, ...extra }));
    return this;
  }
  meta(text) { return this.prompt(text, { isMeta: true }); }
  assistantText(text = 'Working on it.', grow = 1500) {
    this.ctx += grow;
    this.rows.push(this.base({ type: 'assistant', requestId: id(), message: { role: 'assistant', content: [{ type: 'text', text }], usage: this.usage() } }));
    return this;
  }
  tool(name, input, { error = false, grow = 2500, sidechain = false } = {}) {
    const tid = 'toolu_' + id();
    this.ctx += grow;
    this.rows.push(this.base({ type: 'assistant', isSidechain: sidechain, requestId: id(), message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input }], usage: this.usage() } }));
    this.rows.push(this.base({ type: 'user', isSidechain: sidechain, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: error ? 'Exit code 1' : 'ok', is_error: error }] } }));
    return this;
  }
  compact(trigger = 'auto', postTokens = 20_000) {
    const pre = this.ctx;
    this.ctx = postTokens;
    this.rows.push(this.base({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger, preTokens: pre, postTokens } }));
    this.rows.push(this.base({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }));
    return this;
  }
  setContext(tokens) { this.ctx = tokens; return this; }
  usage() {
    return { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 40, cache_read_input_tokens: this.ctx - 200, cache_creation_input_tokens: 160, output_tokens: 90 }] };
  }
  text() { return this.rows.map((r) => JSON.stringify(r)).join('\n') + '\n'; }
}

export function healthySession() {
  const b = new TranscriptBuilder();
  b.prompt('Add a retry to the upload client. Never change the public API.');
  b.assistantText().tool('Read', { file_path: '/tmp/proj/src/upload.ts' }).tool('Edit', { file_path: '/tmp/proj/src/upload.ts', old_string: 'a', new_string: 'b' });
  b.tool('Bash', { command: 'npm test' }).assistantText('Done, tests pass.');
  b.prompt('Great, now add a test for the timeout path.');
  b.tool('Write', { file_path: '/tmp/proj/src/upload.test.ts', content: 'x' }).tool('Bash', { command: 'npm test' }).assistantText('Added.');
  return b;
}

export function degradedSession() {
  const b = new TranscriptBuilder();
  b.prompt('Fix the flaky auth test. Do not touch the database schema.');
  for (let i = 0; i < 6; i++) b.tool('Read', { file_path: '/tmp/proj/src/auth.test.ts' }, { grow: 6000 });
  b.tool('Edit', { file_path: '/tmp/proj/src/auth.test.ts', old_string: 'a', new_string: 'b' });
  for (let i = 0; i < 4; i++) b.tool('Bash', { command: 'npm test -- auth' }, { error: true });
  b.assistantText('Still failing.');
  b.prompt('No, I said do not touch the schema. Revert that.');
  b.tool('Bash', { command: 'git checkout -- db/schema.sql' });
  b.prompt("That's not what I asked. Again: fix the test only.");
  b.setContext(165_000).assistantText('Understood.');
  return b;
}

export function thrashingSession() {
  const b = new TranscriptBuilder();
  b.prompt('Migrate the logger to structured output.');
  b.setContext(180_000).assistantText();
  b.compact('auto', 25_000);
  b.prompt('continue');
  for (let i = 0; i < 5; i++) b.tool('Read', { file_path: `/tmp/proj/src/f${i}.ts` }, { grow: 25_000 });
  b.assistantText();
  b.compact('auto', 25_000);
  b.prompt('continue');
  for (let i = 0; i < 5; i++) b.tool('Read', { file_path: `/tmp/proj/src/g${i}.ts` }, { grow: 25_000 });
  b.assistantText();
  return b;
}
