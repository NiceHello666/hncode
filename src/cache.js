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
  return protocol === 'anthropic' || protocol === 'openai';
}

// Index (into `messages`) of the last message that belongs to the STABLE prefix.
//
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
// fashion (returns a new body). Breakpoints are placed:
//   1. on the LAST tool definition (caches the whole tool block),
//   2. on the system prompt (caches tools + system together),
//   3. on the last message of the stable prefix (caches the conversation head).
// Marking the tail first and working backwards keeps the total <= MAX_BREAKPOINTS.
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
    const end = stablePrefixEnd(out.messages, opts.keepTail);
    if (end >= 0 && end < out.messages.length) {
      // Only worth a breakpoint once the prefix is long enough to cache.
      const prefixText = out.messages.slice(0, end + 1)
        .map((m) => (typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ? m.content.map((b) => b.text || '').join('') : ''))
        .join('\n');
      if (estimateTokens(prefixText) >= minTokens) {
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
  if (protocol === 'openai') return withOpenAiCache(body, opts);
  return body;
}