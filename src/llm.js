// Dual-protocol (OpenAI + Anthropic) chat client with streaming + non-streaming.
// Normalizes both providers into a common event stream consumed by the agent:
//   {type:'data', text}            assistant text delta
//   {type:'tool_start', id, name}  a tool call began
//   {type:'tool_args', id, chunk}  partial JSON argument chunk
//   {type:'tool_end', id}          tool call arguments complete
//   {type:'end'}                   assistant turn finished
//   {type:'error', error}          fatal error

import { llmTools } from './tools/index.js';
import { effortWire } from './config.js';
import { applyPromptCache } from './cache.js';

export function openAiToolDefs(tools) {
  // Guard: a caller that passes null/undefined (e.g. setToolsList(null)) used to
  // throw on `.map`, failing the whole request. An empty tool list is valid.
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function anthropicToolDefs(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
// ---------------------------------------------------------------------------
// Multimodal content
//
// A tool may return `{ media: [...] }` instead of a string — ReadMediaFile does,
// so a screenshot reaches the model as an IMAGE rather than as a description of
// one. The entries are normalized here, once, into the shapes each protocol
// wants; everything upstream (agent, tools) stays protocol-agnostic.
//
//   { type: 'image', mimeType: 'image/png', data: '<base64>' }
//   { type: 'text',  text: '...' }
//
// `data` is base64 WITHOUT the `data:` prefix; the prefix is added per protocol.

function isMediaContent(c) {
  return !!c && typeof c === 'object' && Array.isArray(c.media);
}

function mediaText(c) {
  return String(c.text == null ? '' : c.text);
}

/** OpenAI: content parts, `image_url` carries the data URL. */
function toOpenAiContent(c) {
  const parts = [];
  const text = mediaText(c);
  if (text) parts.push({ type: 'text', text });
  for (const m of c.media) {
    if (m && m.type === 'image' && m.data) {
      parts.push({ type: 'image_url', image_url: { url: `data:${m.mimeType || 'image/png'};base64,${m.data}` } });
    }
  }
  // A media block with no image and no text would serialise as an empty array,
  // which some providers reject. Fall back to a plain string.
  if (!parts.length) return text || '';
  return parts;
}

/** Anthropic: content blocks, `image` carries source bytes. */
function toAnthropicContent(c) {
  const blocks = [];
  const text = mediaText(c);
  if (text) blocks.push({ type: 'text', text });
  for (const m of c.media) {
    if (m && m.type === 'image' && m.data) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: m.mimeType || 'image/png', data: m.data } });
    }
  }
  if (!blocks.length) return text || '';
  return blocks;
}

// Internal canonical messages -> OpenAI request shape.
export function toOpenAi(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content });
    else if (m.role === 'user') {
      out.push({ role: 'user', content: isMediaContent(m.content) ? toOpenAiContent(m.content) : m.content });
    } else if (m.role === 'assistant') {
      const hasText = typeof m.content === 'string' && m.content.trim();
      const hasCalls = Array.isArray(m.toolCalls) && m.toolCalls.length;
      if (!hasText && !hasCalls) continue; // 上游不允许空 assistant，直接丢弃
      const msg = { role: 'assistant', content: m.content || null };
      if (hasCalls) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: isMediaContent(m.content) ? toOpenAiContent(m.content) : m.content,
      });
    }
  }
  return out;
}

// Internal canonical messages -> Anthropic request shape. Returns {system, messages}.
export function toAnthropic(messages) {
  const sys = [];
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') { sys.push(m.content); continue; }
    if (m.role === 'user') {
      const c = isMediaContent(m.content) ? toAnthropicContent(m.content) : [{ type: 'text', text: m.content }];
      out.push({ role: 'user', content: c });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: isMediaContent(m.content) ? toAnthropicContent(m.content) : m.content,
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of (m.toolCalls || [])) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content: blocks });
    }
  }
return { system: sys.join('\n\n').trim(), messages: out };
}

function authHeaders(cfg) {
  const h = { 'content-type': 'application/json' };
  if (cfg.apiKey) {
    if (cfg.protocol === 'anthropic') {
      h['x-api-key'] = cfg.apiKey;
      h['anthropic-version'] = '2023-06-01';
    } else {
      h['authorization'] = `Bearer ${cfg.apiKey}`;
    }
  }
  return h;
}

function buildBody(cfg, messages, streaming = true, opts = {}) {
  const common = { stream: streaming, max_tokens: cfg.maxOutputTokens };
  if (cfg.temperature != null) common.temperature = cfg.temperature;
  // Thinking / reasoning. The wire form depends on the protocol and the chosen
  // effort (see config.effortWire): OpenAI-compatible sends `reasoning_effort`,
  // Anthropic sends a `thinking` budget. Models that think by default need no
  // flag, so nothing is sent when the effort is off/unset.
  //
  // `noReasoning` opts a request OUT of it. Internal one-shot requests that cap
  // their output (the session title, the compaction summary) must not ask for
  // thinking: a reasoning model spends the whole small budget on
  // `reasoning_content`, returns `finish_reason: "length"` with empty `content`,
  // and the request comes back as a failure that never even shows an error.
  const wire = opts.noReasoning ? {} : (effortWire(cfg, cfg.effort) || {});
  // Internal requests that have no use for tools must not carry the ~25 KB tool
  // block: it is pure input cost on top of a request that only wants one line.
  const defs = Object.prototype.hasOwnProperty.call(opts, 'tools') ? openAiToolDefs(opts.tools) : openAiToolDefs(llmToolsList);
  if (cfg.protocol === 'anthropic') {
    const { system, messages: am } = toAnthropic(messages);
    const body = {
      model: cfg.innerModel, system, messages: am,
      tools: opts.noTools ? undefined : anthropicToolDefs(opts.tools || llmToolsList),
      ...common, ...wire,
    };
    if (!body.tools || !body.tools.length) delete body.tools;
    // Prompt caching: mark the stable prefix (tools + system + conversation head)
    // so the provider bills it as a cache READ instead of fresh input. The key is
    // the SESSION id, so it stays identical across turns and never thrashes.
    return JSON.stringify(applyPromptCache('anthropic', body, {
      enabled: cfg.promptCache !== false,
      sessionKey: cfg.sessionId,
    }));
  }
  const body = {
    model: cfg.innerModel, messages: toOpenAi(messages),
    ...common, ...wire,
  };
  if (!opts.noTools) body.tools = defs;
  return JSON.stringify(applyPromptCache('openai', body, {
    enabled: cfg.promptCache !== false,
    sessionKey: cfg.sessionId,
  }));
}

// tool list used for defs (injected via setTools)
let llmToolsList = [];
// Only ever store an array: `null`/undefined here would make every later request
// throw when the defs are built.
export function setToolsList(list) { llmToolsList = Array.isArray(list) ? list : []; }

export class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.controller = null;
    // Inline-reasoning state carried ACROSS requests. Our system prompt tells the
    // model to put all its reasoning inside one <think> span, and tool calls happen
    // inside that span — so the span outlives a single request. Reset when the turn
    // ends (see resetThink).
    this._inThink = false;
    this._tagPending = '';
  }

  // Called by the agent at the end of a turn: the next turn starts a fresh
  // reasoning block, even if the previous one never saw its closing tag.
  resetThink() {
    this._inThink = false;
    this._tagPending = '';
  }

  // Abort an in-flight request (Esc / Ctrl-C while the agent is running).
  abort() {
    if (this.controller) { try { this.controller.abort(); } catch {} }
  }

  // Simple non-streaming text request — used for internal tasks (e.g. context
  // summarization during compaction) that should not surface a tool plan to the
  // user. Returns the assistant's text content or null on failure.
  //
  // `opts.noReasoning` / `opts.noTools` exist for the small one-shot requests:
  // a capped budget plus a reasoning model is what silently produced an empty
  // title (see buildBody), and an internal request has no tools to call.
  async requestText(messages, opts = {}) {
    const cfg = this.cfg;
    this.controller = new AbortController();
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: authHeaders(cfg),
        body: buildBody(cfg, messages, false, opts),
        signal: this.controller.signal,
      });
      if (!res || !res.ok) {
        let t = '';
        try { if (res) t = await res.text(); } catch {}
        const status = res ? res.status : 'network';
        return null;
      }
      const json = await res.json();
      let text = '';
      if (cfg.protocol === 'anthropic') {
        for (const cb of (json.content || [])) {
          if (cb.type === 'text' && cb.text) text += cb.text;
        }
      } else {
        const msg = json.choices && json.choices[0] && json.choices[0].message;
        if (msg && msg.content) text = msg.content;
      }
      // An EMPTY reply that hit the output cap is a failure, not an answer. The
      // title request used to receive `content: ""` + `finish_reason: "length"`
      // and treat it as "the model had nothing to say", which is why the title
      // was silently never generated (and never retried). Returning it marked
      // lets the caller decide — the title path retries with a bigger budget.
      if (!text) {
        const truncated = cfg.protocol === 'anthropic'
          ? (json.stop_reason === 'max_tokens')
          : !!(json.choices && json.choices[0] && json.choices[0].finish_reason === 'length');
        return truncated ? '' : null;
      }
      return text;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      return null;
    }
  }

  async request(messages, onEvent) {
    const cfg = this.cfg;
    let res = null;
    let lastError = null;
    let lastStatus = 0;
    let attempts = 0;

    // Retry the HTTP round-trip up to 3 times. Any non-200 response is treated
    // as a problem and retried (5xx, 429, and unexpected 4xx alike), as is a
    // network/connection error. The only exceptions are aborts (Esc/Ctrl-C) —
    // those end the turn — and a response that is not ok on the final attempt.
    const RETRIES = 3;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      attempts = attempt;
      // Fresh controller per attempt so an abort aborts this specific request
      // and the retry loop stops.
      this.controller = new AbortController();
      const signal = this.controller.signal;
      try {
        res = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: authHeaders(cfg),
          body: buildBody(cfg, messages),
          signal,
        });
      } catch (e) {
        // An abort is a normal way to end a turn, not an error to report.
        if (e && e.name === 'AbortError') { onEvent({ type: 'aborted' }); return; }
        lastError = e;
        lastStatus = 0; // network error
      }
      if (res && res.ok) break;
      if (res) lastStatus = res.status;
      if (attempt < RETRIES) {
        // Small exponential backoff (200ms, 400ms). If the user hit Esc during
        // the wait, stop retrying.
        const tryingSignal = this.controller.signal;
        await new Promise((r) => {
          const timer = setTimeout(r, 200 * attempt);
          tryingSignal.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true });
        });
        if (tryingSignal.aborted) { onEvent({ type: 'aborted' }); return; }
      }
    }

    if (lastError && !res) {
      onEvent({ type: 'error', error: lastError });
      return;
    }
    if (!res || !res.ok) {
      let t = '';
      try { if (res) t = await res.text(); } catch {}
      const tries = lastStatus ? `${res.status}` : 'network';
      onEvent({ type: 'error', error: new Error(`LLM request failed after ${attempts} attempt(s) (${tries}): ${truncate(t)}`) });
      return;
    }
    if (cfg.stream === false) {
      const json = await res.json();
      return consumeNonStreaming(cfg.protocol, json, onEvent);
    }
    if (!res.body) { onEvent({ type: 'end' }); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // The inline-reasoning state (`inThink` / `tagPending`) is carried on the LLM
    // instance, NOT recreated per request. A model that opens <think>, runs a tool,
    // and only writes </think> in the NEXT step would otherwise have everything
    // after the tool call reclassified as the ANSWER — the reasoning text and the
    // literal `</think>` tag both showed up in the transcript.
    const state = {
      tools: new Map(), indexToId: {}, doneEmitted: false,
      inThink: !!this._inThink, tagPending: this._tagPending || '',
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(':')) continue;
          const s = line.startsWith('data: ') ? line.slice(6) : (line.startsWith('data:') ? line.slice(5) : line);
          if (s === '[DONE]') { finish(state, onEvent); return; }
          if (processEvent(cfg.protocol, s, onEvent, state) === 'end') { finish(state, onEvent); return; }
        }
      }
    } catch (e) {
      // Aborting mid-stream (Esc) also lands here.
      if (e && e.name === 'AbortError') { onEvent({ type: 'aborted' }); return; }
      onEvent({ type: 'error', error: e });
      return;
    } finally {
      reader.releaseLock?.();
      // Carry the inline-reasoning state forward on EVERY exit path — a normal end,
      // [DONE], an abort and an error all pass through here. The model may resume an
      // open <think> span after a tool call in the next step, so this belongs to the
      // turn, not to one request.
      this._inThink = !!state.inThink;
      this._tagPending = state.tagPending || '';
    }
    finish(state, onEvent);
  }
}

// ---- inline reasoning tags -------------------------------------------------
// Some OpenAI-compatible servers do not send a separate `reasoning_content`
// field: they put the chain of thought INLINE in `content`, wrapped in a tag.
// Three spellings have to be supported, because they come from three places:
//   ` thinking…`                 — the DeepSeek-R1 token markers, as emitted by
//                               vLLM / llama.cpp builds of that model
//   `<thinking>…</thinking>`    — what several OpenAI-compatible servers wrap it in
//   `<think>…</think>`          — what OUR OWN system prompt asks for (agent.js
//                               and prompt-presets.js both instruct this)
// The last one was missing, so a model that followed our prompt had its whole
// reasoning trace rendered as the ANSWER, raw tags and all.
//
// The three are mutually distinguishable, which is what makes supporting all of
// them safe: `</think>` does not occur inside `</thinking>`, `<think>` does not
// occur inside `<thinking>`, and `' thinking'` does not occur inside `<think>`.
// So an early match can never be caused by the longer tag.
//
// Without splitting these out, the raw tags and the whole reasoning trace are
// rendered as the assistant's answer (and counted as output tokens). This is a
// streaming state machine: a tag can be split across chunks, so a trailing partial
// tag is held back until the next chunk decides what it is.
const THINK_OPEN_TAGS = [' thinking', '<thinking>', '<think>'];
// Closing tags. If none of these appear, the block stays in think mode to EOI.
const THINK_CLOSE_TAGS = ['<｜end▁of▁thinking｜>', '</thinking>', '</think>'];

// Longest suffix of `buf` that is a proper prefix of one of `tags`.
// A single trailing space is deliberately NOT a candidate: `' '` is a prefix of
// `' thinking'`, but holding it back would stall every sentence-ending space
// (and its neighbour letter could be anything). Only hold at least 2 chars,
// which makes the tag unambiguous even split across chunks.
function partialTagSuffixLen(buf, tags) {
  let best = 0;
  for (const tag of tags) {
    const max = Math.min(tag.length - 1, buf.length);
    for (let len = Math.max(2, 1); len <= max; len++) { // len>=2 only
      if (buf.endsWith(tag.slice(0, len))) { if (len > best) best = len; break; }
    }
  }
  return best;
}

function feedContent(text, onEvent, state) {
  let buf = (state.tagPending || '') + String(text || '');
  state.tagPending = '';
  let inThink = !!state.inThink;
  while (buf.length > 0) {
    const tags = inThink ? THINK_CLOSE_TAGS : THINK_OPEN_TAGS;
    let best = -1, bestTag = null;
    for (const tag of tags) {
      const i = buf.indexOf(tag);
      if (i >= 0 && (best === -1 || i < best)) { best = i; bestTag = tag; }
    }
    if (best === -1) {
      const keep = partialTagSuffixLen(buf, tags);
      const emit = buf.slice(0, buf.length - keep);
      if (emit) onEvent({ type: inThink ? 'think' : 'data', text: emit });
      state.tagPending = keep ? buf.slice(buf.length - keep) : '';
      state.inThink = inThink;
      return;
    }
    const before = buf.slice(0, best);
    if (before) onEvent({ type: inThink ? 'think' : 'data', text: before });
    inThink = !inThink;
    buf = buf.slice(best + bestTag.length);
  }
  state.inThink = inThink;
}

// Emit whatever is still held back (a dangling partial tag is plain text).
function flushContent(onEvent, state) {
  if (state.tagPending) {
    onEvent({ type: state.inThink ? 'think' : 'data', text: state.tagPending });
    state.tagPending = '';
  }
}

function finish(state, onEvent) {
  // close any tool calls that started but never got an explicit end
  if (state.doneEmitted) return;
  // A still-OPEN reasoning block is deliberately NOT flushed here. The model can
  // continue it after a tool call in the next step — our own system prompt tells it
  // to put ALL reasoning in one <think> span, and tool calls happen inside that
  // span. Flushing would dump the held-back partial tag and end the block early, so
  // the rest of the reasoning would be reclassified as the ANSWER. The caller keeps
  // `inThink`/`tagPending` on the LLM instance and the block resumes there.
  if (!state.inThink) flushContent(onEvent, state);
  for (const [, t] of state.tools) {
    if (!t.done) onEvent({ type: 'tool_end', id: t.id });
  }
  state.doneEmitted = true;
  onEvent({ type: 'end' });
}

function processEvent(protocol, raw, onEvent, state) {
  let d;
  try { d = JSON.parse(raw); } catch { return 'continue'; }
  if (protocol === 'anthropic') return processAnthropic(d, onEvent, state);
  return processOpenAI(d, onEvent, state);
}

function processOpenAI(d, onEvent, state) {
  const choice = d.choices && d.choices[0];
  const delta = choice && choice.delta;
  const finishReason = choice && choice.finish_reason;
  // Some servers put the final chunk's content AND its finish_reason in the SAME
  // frame, so the stop reason has to be handled AFTER the delta — checking it
  // only on a delta-less frame missed the truncation marker entirely (a stream
  // that reported `length` alongside the last token looked like a normal end).
  if (!delta) {
    if (finishReason) {
      if (finishReason === 'length') onEvent({ type: 'truncated' });
      onEvent({ type: 'end' });
      return 'end';
    }
    return 'continue';
  }
  // Reasoning tokens, matching kimi's `extractReasoning` / `extractReasoningDetails`.
  // Different servers name the field differently — `reasoning_content`
  // (vLLM/DeepSeek/hy3), `reasoning` (newer vLLM), or `reasoning_details`. The
  // first observed key is remembered so the output stays consistent.
  if (state.reasoningKey === undefined) {
    state.reasoningKey = ['reasoning_content', 'reasoning_details', 'reasoning']
      .find((k) => typeof delta[k] === 'string' || Array.isArray(delta[k]));
  }
  const key = state.reasoningKey;
  if (key === 'reasoning_details' && Array.isArray(delta.reasoning_details)) {
    // e.g. [{type:'summary'|'encrypted', summary?, encrypted?}]. Only the
    // plain-URL summary is meaningful to hncode — encrypted tokens are opaque.
    for (const el of delta.reasoning_details) {
      if (el && typeof el.summary === 'string') onEvent({ type: 'think', text: el.summary });
    }
  } else if (key && typeof delta[key] === 'string' && delta[key]) {
    onEvent({ type: 'think', text: delta[key] });
  }
  // Content may carry INLINE  thinking…<｜end▁of▁thinking｜> reasoning (hy3/DeepSeek
  // style); feedContent splits it out as think events. Otherwise it would be
  // rendered as part of the answer.
  if (delta.content) feedContent(delta.content, onEvent, state);
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      // First chunk of a tool call carries `id`; later chunks only repeat `index`.
      if (tc.id) state.indexToId[tc.index] = tc.id;
      const id = tc.id || state.indexToId[tc.index];
      if (!id) continue;
      if (!state.tools.has(id)) {
        state.tools.set(id, { id, name: tc.function && tc.function.name, argsJson: '', done: false });
        onEvent({ type: 'tool_start', id, name: tc.function && tc.function.name });
      }
      if (tc.function && tc.function.arguments) {
        const t = state.tools.get(id); t.argsJson += tc.function.arguments;
        onEvent({ type: 'tool_args', id, chunk: tc.function.arguments });
      }
    }
  }
  // A frame can carry BOTH the last delta and the stop reason (see above). Now
  // that the delta is consumed, report the cut and end the round — mirroring the
  // `message_stop` path for Anthropic.
  if (finishReason) {
    if (finishReason === 'length') onEvent({ type: 'truncated' });
    onEvent({ type: 'end' });
    return 'end';
  }
  return 'continue';
}

function processAnthropic(d, onEvent, state) {
  const t = d.type;
  if (t === 'message_start' || t === 'message_delta' || t === 'message_stop') {
    if (t === 'message_stop') { onEvent({ type: 'end' }); return 'end'; }
    // `message_delta` carries the stop reason; `max_tokens` there means the reply
    // was cut off, not finished (see processOpenAI for the OpenAI spelling).
    if (t === 'message_delta' && d.delta && d.delta.stop_reason === 'max_tokens') {
      onEvent({ type: 'truncated' });
    }
    return 'continue';
  }
  if (t === 'content_block_start') {
    const cb = d.content_block;
    if (cb && cb.type === 'tool_use') {
      const id = cb.id; const name = cb.name;
      state.tools.set(d.index, { id, name, argsJson: '', done: false });
      onEvent({ type: 'tool_start', id, name });
    }
    return 'continue';
  }
  if (t === 'content_block_delta') {
    const delta = d.delta || {};
    if (delta.type === 'text_delta') feedContent(delta.text || '', onEvent, state);
    else if (delta.type === 'thinking_delta') onEvent({ type: 'think', text: delta.thinking || '' });
    else if (delta.type === 'input_json') {
      const blk = state.tools.get(d.index);
      if (blk) { blk.argsJson += delta.partial_json || ''; onEvent({ type: 'tool_args', id: blk.id, chunk: delta.partial_json || '' }); }
    }
    return 'continue';
  }
  if (t === 'content_block_stop') {
    const blk = state.tools.get(d.index);
    if (blk && !blk.done) { blk.done = true; onEvent({ type: 'tool_end', id: blk.id }); }
    return 'continue';
  }
  return 'continue';
}

// --- Non-streaming path ---
export function consumeNonStreaming(protocol, json, onEvent) {
  const state = { tagPending: '', inThink: false };
  if (protocol === 'anthropic') {
    const content = json.content || [];
    if (json.stop_reason === 'max_tokens') onEvent({ type: 'truncated' });
    for (const cb of content) {
      if (cb.type === 'text' && cb.text) feedContent(cb.text, onEvent, state);
      else if (cb.type === 'tool_use') {
        onEvent({ type: 'tool_start', id: cb.id, name: cb.name });
        onEvent({ type: 'tool_args', id: cb.id, chunk: JSON.stringify(cb.input || {}) });
        onEvent({ type: 'tool_end', id: cb.id });
      }
    }
  } else {
    const choice = json.choices && json.choices[0];
    const msg = choice && choice.message;
    if (!msg) { onEvent({ type: 'error', error: new Error('empty LLM response') }); return; }
    // Non-streaming: the truncation marker comes on the same object as the message.
    if (choice.finish_reason === 'length') onEvent({ type: 'truncated' });
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) onEvent({ type: 'think', text: msg.reasoning_content });
    else if (typeof msg.reasoning === 'string' && msg.reasoning) onEvent({ type: 'think', text: msg.reasoning });
    else if (Array.isArray(msg.reasoning_details)) {
      for (const el of msg.reasoning_details) if (el && typeof el.summary === 'string') onEvent({ type: 'think', text: el.summary });
    }
    if (msg.content) feedContent(msg.content, onEvent, state);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const id = tc.id; const name = tc.function && tc.function.name; const args = tc.function && tc.function.arguments;
        onEvent({ type: 'tool_start', id, name });
        if (args) onEvent({ type: 'tool_args', id, chunk: args });
        onEvent({ type: 'tool_end', id });
      }
    }
  }
  flushContent(onEvent, state);
  onEvent({ type: 'end' });
}

function truncate(s, n = 300) { return s.length > n ? s.slice(0, n) + '...' : s; }
