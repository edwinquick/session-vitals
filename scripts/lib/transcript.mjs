// Parse a Claude Code transcript (JSONL) into a flat, normalized event list.
// Only the main conversation chain is kept; subagent sidechains are dropped.
// Format observed against Claude Code 2.1.x transcripts; everything here is
// defensive because the format is not a published contract.
import fs from 'node:fs';

const KEEP = ['"type":"user"', '"type":"assistant"', '"compact_boundary"', '"isApiErrorMessage":true'];

export function parseTranscript(path) {
  const raw = fs.readFileSync(path, 'utf8');
  return parseTranscriptText(raw);
}

export function parseTranscriptText(raw) {
  const events = [];
  const seenRequests = new Set();
  for (const line of raw.split('\n')) {
    if (!line || !KEEP.some((k) => line.includes(k))) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const m = o.compactMetadata || {};
      events.push({ kind: 'compact', ts, trigger: m.trigger || 'unknown', preTokens: m.preTokens ?? null, postTokens: m.postTokens ?? null });
      continue;
    }
    if (o.isApiErrorMessage) { events.push({ kind: 'api_error', ts }); continue; }

    const msg = o.message;
    if (!msg) continue;

    if (o.type === 'user') {
      if (o.isCompactSummary) { events.push({ kind: 'compact_summary', ts }); continue; }
      const content = msg.content;
      if (typeof content === 'string') {
        if (isRealPrompt(content, o)) events.push({ kind: 'prompt', ts, text: content });
        continue;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            events.push({ kind: 'tool_result', ts, id: b.tool_use_id, isError: b.is_error === true || b.is_error === 'True' });
          } else if (b.type === 'text' && isRealPrompt(b.text, o)) {
            events.push({ kind: 'prompt', ts, text: b.text });
          }
        }
      }
      continue;
    }

    if (o.type === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b.type === 'tool_use') events.push({ kind: 'tool_use', ts, id: b.id, name: b.name, input: b.input || {} });
        else if (b.type === 'text') events.push({ kind: 'assistant_text', ts, len: (b.text || '').length });
      }
      // One API message can span several rows with the same requestId; count usage once.
      const reqKey = o.requestId || o.uuid;
      if (msg.usage && !seenRequests.has(reqKey)) {
        seenRequests.add(reqKey);
        const ctx = contextTokensFromUsage(msg.usage);
        if (ctx > 0) events.push({ kind: 'usage', ts, contextTokens: ctx, outputTokens: outputTokensFromUsage(msg.usage) });
      }
    }
  }
  return events;
}

function isRealPrompt(text, row) {
  if (!text || row.isMeta) return false;
  const t = text.trimStart();
  // Slash-command records, local shell caveats, and system-injected reminders are not the human speaking.
  if (t.startsWith('<')) return false;
  if (t.startsWith('This session is being continued from a previous conversation')) return false;
  return true;
}

function contextTokensFromUsage(u) {
  const pick = (x) => (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0);
  let best = pick(u);
  if (Array.isArray(u.iterations)) for (const it of u.iterations) best = Math.max(best, pick(it));
  return best;
}
function outputTokensFromUsage(u) {
  let n = u.output_tokens || 0;
  if (Array.isArray(u.iterations)) for (const it of u.iterations) n = Math.max(n, it.output_tokens || 0);
  return n;
}
