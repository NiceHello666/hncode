// Prompt caching — explicit cache breakpoints for long, stable prefixes.
//
// Why this is worth doing: an agent resends the whole conversation every turn,
// and the prefix (system prompt + tool definitions + early messages) is
// byte-identical across turns. Providers that support prompt caching bill those
// tokens at a fraction of the input price and skip the prefill compute. Without
// explicit breakpoints only the providers that cache automatically benefit.
//
// Protocol differences:
//   * anthropic — explicit: mark up to N breakpoints with
//     `cache_control: { type: "ephemeral" }`. Anthropic caches everything UP TO
//     and INCLUDING a marked block, so the LAST breakpoint should sit at the end
//     of the stable prefix. The minimum cacheable prefix is model-dependent
//     (~1024 tokens); marking a shorter prefix is a no-op, not an error.
//   * openai — automatic for prompts over ~1024 tokens on supporting models. A
//     stable `prompt_cache_key` improves routing; keys must not vary per request.
//   * everything else — no-op. Unknown providers are left untouched: sending an
//     unsupported `cache_control` field can 400 some gateways.
//
// The cache is only useful when the prefix is STABLE, so the helpers here take
// care to mark the same positions every turn for the same conversation.

import { estimateTokens } from './term.js';

// Anthropic allows at most 4 cache breakpoints per request.
export const MAX_BREAKPOINTS = 4;
// Below this, a breakpoint is pointless: most providers will not cache a prefix
// this short, and the marker is wasted budget.
export const MIN_CACHEABLE_TOKENS = 1024;

export function supportsCaching(protocol) {
  return protocol === 'anthropic' || protocol === 'openai' || protocol === 'responses';
}

// Index (into `messages`) of the last message that belongs to the STABLE prefix.
// The prefix is only cacheable while it cannot change between turns. The system
// prompt and tool list are fixed for a session; the conversation then grows by
// APPENDING. So the prefix is "everything except the recent tail", and the tail
// must be excluded because it is what changes next turn.
//
// We keep the last `keepTail` messages out of the cached region: a tool result
// appended this turn is not part of the stable prefix next turn until it is
// itself superseded. Returns -1 when there is nothing worth marking.
export function stablePrefixEnd(messages, keepTail = 2) {
  const n = Array.isArray(messages) ? messages.length : 0;
  if (n === 0) return -1;
  // Never mark the very last message: it is the newest content and is the most
  // likely to be replaced/regenerated.
  const end = Math.min(n - 1, n - 1 - Math.max(1, keepTail));
  return end >= 0 ? end : -1;
}

// Attach Anthropic `cache_control` breakpoints to a request body IN PLACE-safe
// Total character length of the prefix's content. `.length` is O(1) per string,
// so this is O(#messages) — versus the full-string join plus the per-character
// token walk the decision below used to make on EVERY request (and on every
// retry attempt): ~1 MB of building and ~1M loop iterations on a 200k-token
// history.
function prefixContentLength(messages, end) {
  let n = 0;
  for (let i = 0; i <= end; i++) {
    const c = messages[i] && messages[i].content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) {
      for (const b of c) if (b && typeof b.text === 'string') n += b.text.length;
    }
  }
  return n;
}

// Memo of the last decision, keyed by `end:totalLength`. Tool-result trimming
// rewrites content in place, which changes the length and so invalidates it.
let _prefixDecision = { key: '', cacheable: false };

// Attach Anthropic `cache_control` breakpoints to a request body IN PLACE-safe
// fashion (returns a new body). Breakpoints are placed:
//   1. on the LAST tool definition (caches the whole tool block),
//   2. on the system prompt (caches tools + system together),
//   3. on the last message of the stable prefix (caches the conversation head).
// Marking the tail first and working backwards keeps the total <= MAX_BREAKPOINTS.
//
// `cacheEnd` is the index of the last message that belongs to the stable prefix,
// counted by the CALLER. The agent loop knows it exactly — everything before that
// index was already sent in an earlier request of this turn — so passing it beats
// any guess made from the message count here.
export function withAnthropicCache(body, opts = {}) {
  if (!body || typeof body !== 'object') return body;
  const minTokens = opts.minTokens || MIN_CACHEABLE_TOKENS;
  const out = { ...body };
  const marker = { type: 'ephemeral' };

  // Tools: marking the last one caches the entire tools array.
  if (Array.isArray(out.tools) && out.tools.length) {
    const tools = out.tools.slice();
    tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: marker };
    out.tools = tools;
  }

  // System: a plain string must become a text block to carry cache_control.
  if (typeof out.system === 'string' && out.system.trim()) {
    out.system = [{ type: 'text', text: out.system, cache_control: marker }];
  } else if (Array.isArray(out.system) && out.system.length) {
    const sys = out.system.slice();
    const last = sys.length - 1;
    sys[last] = { ...(typeof sys[last] === 'string' ? { type: 'text', text: sys[last] } : sys[last]), cache_control: marker };
    out.system = sys;
  }

  // Conversation head: mark the stable prefix's last message.
  if (Array.isArray(out.messages) && out.messages.length) {
    // The caller's boundary when it has one; otherwise fall back to counting off
    // the tail. A caller's value ABOVE the last index means the array grew after it
    // was taken, so it is clamped to the end rather than rejected — the prefix it
    // describes is still the stable one, it just no longer reaches the tail.
    const n = out.messages.length;
    const end = Number.isInteger(opts.cacheEnd)
      ? Math.min(n - 1, opts.cacheEnd)
      : stablePrefixEnd(out.messages, opts.keepTail);
    // An EMPTY prefix is not worth marking. With `cacheEnd === -1` the caller is
    // saying "nothing has been sent yet", so every message in this request is new.
    if (end >= 0 && end < n) {
      // Only worth a breakpoint once the prefix is long enough to cache. Memoized
      // on the length fingerprint; a cold decision uses ~4 chars/token — exact for
      // ASCII code and prose, conservative for CJK (whose real token count is
      // HIGHER than chars/4, so a marked prefix is always truly cacheable). Being
      // wrong on the other side is a harmless no-op: the provider ignores a
      // breakpoint on a sub-minimum prefix.
      const plen = prefixContentLength(out.messages, end);
      const key = `${end}:${plen}`;
      let cacheable;
      if (_prefixDecision.key === key) cacheable = _prefixDecision.cacheable;
      else {
        cacheable = plen / 4 >= minTokens;
        _prefixDecision.key = key;
        _prefixDecision.cacheable = cacheable;
      }
      if (cacheable) {
        const msgs = out.messages.slice();
        const msg = { ...msgs[end] };
        if (typeof msg.content === 'string') {
          msg.content = [{ type: 'text', text: msg.content }];
        }
        if (Array.isArray(msg.content) && msg.content.length) {
          const c = msg.content.slice();
          const li = c.length - 1;
          c[li] = { ...c[li], cache_control: marker };
          msg.content = c;
        }
        msgs[end] = msg;
        out.messages = msgs;
      }
    }
  }
  return out;
}

// OpenAI-compatible: most providers cache automatically. A STABLE
// `prompt_cache_key` helps routing on the providers that accept it, and must not
// change between turns of the same conversation or the cache thrashes.
// `seed` should therefore identify the SESSION, not the request.
export function withOpenAiCache(body, opts = {}) {
  if (!body || typeof body !== 'object') return body;
  const key = opts.sessionKey;
  if (!key) return body;
  return { ...body, prompt_cache_key: String(key) };
}

// Apply the right caching strategy for `protocol`. Returns the body unchanged
// for protocols with no explicit support.
export function applyPromptCache(protocol, body, opts = {}) {
  if (!opts.enabled) return body;
  if (protocol === 'anthropic') return withAnthropicCache(body, opts);
  // Responses API accepts the same stable `prompt_cache_key` as chat/completions.
  if (protocol === 'openai' || protocol === 'responses') return withOpenAiCache(body, opts);
  return body;
}