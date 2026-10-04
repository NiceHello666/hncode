// Tests for provider-reported token accounting and the cost it implies.
//
// Why this file exists: `/usage` used to divide the transcript's JSON length by
// 3.5 and present the result as the session's token count, and there was no cost
// readout at all. The numbers now come from the provider, which means three things
// have to hold and none of them is visible when it breaks:
//
//   1. each protocol's own spelling parses into ONE normalised shape,
//   2. a field the provider did not send stays absent rather than becoming zero,
//   3. the cost math charges cache reads at the cache price, not twice.
//
// Testing principle: the inputs here are real response frames, copied from the
// three wire formats. A hand-written object literal would test the normaliser
// against itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeNonStreaming } from '../src/llm.js';
import { addUsage } from '../src/agent.js';
import { costFromCatalog, modelCost, usageCost } from '../src/config.js';

/** Run one protocol's payload through the non-streaming consumer. */
function usageOf(protocol, json) {
  const events = [];
  consumeNonStreaming(protocol, json, (e) => events.push(e));
  const u = events.filter((e) => e.type === 'usage');
  assert.equal(u.length, 1, `${protocol}: exactly one usage event`);
  return u[0].usage;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('OpenAI chat/completions usage parses, including the cached and reasoning parts', () => {
  const u = usageOf('openai', {
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 1024 },
      completion_tokens_details: { reasoning_tokens: 128 },
    },
  });
  assert.deepEqual(u, { input: 1200, output: 300, cached: 1024, reasoning: 128 });
});

test('Anthropic usage parses input, output and BOTH cache directions', () => {
  // Anthropic bills a cache WRITE more than plain input, so dropping it (as an
  // input-only reader would) understates the cost.
  const u = usageOf('anthropic', {
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 40, output_tokens: 12,
      cache_read_input_tokens: 900, cache_creation_input_tokens: 100,
    },
  });
  assert.deepEqual(u, { input: 40, output: 12, cached: 900, cacheWrite: 100 });
});

test('Responses usage parses its input/output token names', () => {
  const u = usageOf('responses', {
    output: [], status: 'completed',
    usage: { input_tokens: 800, output_tokens: 90, input_tokens_details: { cached_tokens: 700 } },
  });
  assert.deepEqual(u, { input: 800, output: 90, cached: 700, reasoning: undefined });
});

test('a response with NO usage emits no usage event', () => {
  // `undefined` and zero are different facts; the readout must be able to tell
  // "this endpoint does not report" from "this request used nothing".
  for (const p of ['openai', 'anthropic', 'responses']) {
    const events = [];
    consumeNonStreaming(p, p === 'openai'
      ? { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }
      : p === 'anthropic' ? { content: [{ type: 'text', text: 'x' }] } : { output: [], status: 'completed' },
      (e) => events.push(e));
    assert.equal(events.filter((e) => e.type === 'usage').length, 0, `${p} must not invent usage`);
  }
});

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

test('addUsage sums the fields it is given and leaves the rest alone', () => {
  // Anthropic reports input on one event and output on another; the second event
  // must not zero the first event's input.
  let total = {};
  total = addUsage(total, { input: 100, cached: 80 });
  total = addUsage(total, { output: 20 });
  assert.equal(total.input, 100);
  assert.equal(total.cached, 80);
  assert.equal(total.output, 20);
});

test('addUsage counts REQUESTS, not usage events', () => {
  // The completion side arrives once per request in all three protocols, so it is
  // what the counter keys on — counting events would report an Anthropic request
  // as two.
  let total = {};
  total = addUsage(total, { input: 100 });               // Anthropic's message_start
  assert.equal(total.calls, undefined, 'an input-only report is not a completed request');
  total = addUsage(total, { output: 20 });               // Anthropic's message_delta
  assert.equal(total.calls, 1);
  total = addUsage(total, { input: 5, output: 2 });      // OpenAI's single frame
  assert.equal(total.calls, 2);
});

test('addUsage never overwrites a known total with an unreported one', () => {
  const a = addUsage({ input: 10, output: 5 }, { input: 1 });
  assert.equal(a.input, 11);
  assert.equal(a.output, 5, 'a missing field must not be treated as zero');
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test('costFromCatalog reads the catalog names and ignores the extras', () => {
  // models.dev also publishes `tiers` and a `reasoning` price; neither is used
  // here (the tier is a different rate for a longer context, which we do not
  // model), and their presence must not break the parse.
  const c = costFromCatalog({ input: 2.5, output: 15, reasoning: 15, cache_read: 0.25, tiers: [{ input: 5 }] });
  assert.deepEqual(c, { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: undefined });
  assert.equal(costFromCatalog({}), undefined, 'a model with no prices has no cost object');
  assert.equal(costFromCatalog(undefined), undefined);
});

test('modelCost reads the stored flat keys, and null when the model is unpriced', () => {
  const cfg = { model: 'p/m', raw: { models: { 'p/m': { cost_input: 2.5, cost_output: 15, cost_cache_read: 0.25 } } } };
  assert.deepEqual(modelCost(cfg), { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: undefined });
  assert.equal(modelCost({ model: 'p/unknown', raw: { models: {} } }), null);
});

test('usageCost charges cache reads at the cache price, not twice', () => {
  const cost = { input: 2.5, output: 15, cacheRead: 0.25 };
  // 1M input of which 0.5M was a cache read, plus 1M output.
  //   0.5M fresh  x $2.50 = 1.25
  //   0.5M cached x $0.25 = 0.125
  //   1M output   x $15   = 15
  const usd = usageCost({ input: 1_000_000, output: 1_000_000, cached: 500_000 }, cost);
  assert.ok(Math.abs(usd - 16.375) < 1e-9, `expected 16.375, got ${usd}`);
  // Without cache pricing, the reads fall back to the plain input rate rather than
  // being dropped (which would understate the bill).
  const noCache = usageCost({ input: 1_000_000, output: 0, cached: 500_000 }, { input: 2 });
  assert.ok(Math.abs(noCache - 2) < 1e-9, `expected 2, got ${noCache}`);
});

test('usageCost returns null, not zero, when there is no pricing', () => {
  // A made-up $0.00 reads as "this was free". The readout distinguishes them.
  assert.equal(usageCost({ input: 100, output: 10 }, null), null);
  assert.equal(usageCost(null, { input: 1 }), null);
  assert.equal(usageCost({ input: 100, output: 10 }, {}), 0, 'an empty price set is a real zero, not unknown');
});
