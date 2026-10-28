// The context gauge must count the TOOL DEFINITIONS.
//
// WHY THIS FILE EXISTS
// --------------------
// The provider reported 1,048,942 input tokens while the app's own gauge said 682k. The part that could
// be explained was the tools: `usedTokens()` charged `toolFilter.length * 8` and only when a filter was
// set, so an ordinary turn added NOTHING for the schemas it sent. Measured, the 68 registered tools
// come to about 15 900 tokens — the flat 8 was off by 29×.
//
// The rest of the gap was NOT explained, and the provider's own figure was tried and rejected: it
// disagreed with the app by hundreds of thousands for reasons nobody could identify, and a gauge that
// shows a number its author cannot account for is worse than one with a known error. So the gauge is
// our estimate, corrected where the error is understood.
//
// The tool definitions are the part worth pinning, because they are the largest single omission and
// they also decide when to compact: under-reporting the request means compaction fires too late.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureToolDefTokens, estimateRequestOverhead, estimateTokens } from '../src/term.js';

const tool = (name, description, parameters = { type: 'object', properties: {} }) => ({ name, description, parameters });

// ---------------------------------------------------------------------------

test('a tool definition costs what its schema costs', () => {
  // Not a flat number: a description is a paragraph, and a nested parameters object is most of the
  // payload. Two tools with different descriptions must price differently, or the measure is fake.
  const small = measureToolDefTokens([tool('A', 'short')]);
  const large = measureToolDefTokens([tool('A', 'a much longer description '.repeat(40))]);
  assert.ok(large > small * 5, `a long description costs more (${small} vs ${large})`);
});

test('a nested parameters object is counted', () => {
  const flat = measureToolDefTokens([tool('A', 'x')]);
  const nested = measureToolDefTokens([tool('A', 'x', {
    type: 'object',
    properties: { path: { type: 'string', description: 'file to read' }, limit: { type: 'number' } },
    required: ['path'],
  })]);
  assert.ok(nested > flat, `parameters add to the cost (${flat} vs ${nested})`);
});

test('the total is the SUM over tools, not an average', () => {
  const one = measureToolDefTokens([tool('A', 'x')]);
  const three = measureToolDefTokens([tool('A', 'x'), tool('B', 'x'), tool('C', 'x')]);
  assert.equal(three, one * 3);
  assert.equal(measureToolDefTokens([]), 0);
  assert.equal(measureToolDefTokens(null), 0);
});

test('a malformed entry is skipped rather than crashing the gauge', () => {
  // The tool list comes from plugins; one bad entry must not take down every usage reading.
  assert.doesNotThrow(() => measureToolDefTokens([null, {}, tool('A', 'x')]));
  assert.ok(measureToolDefTokens([null, {}, tool('A', 'x')]) > 0);
});

// ---------------------------------------------------------------------------
// using the measurement
// ---------------------------------------------------------------------------

test('the request overhead includes the measured tool cost', () => {
  const system = 'you are an agent';
  const cfg = { toolDefTokens: 15855, toolFilter: ['A', 'B', 'C'] };
  const withTools = estimateRequestOverhead(system, cfg);
  const withoutTools = estimateRequestOverhead(system, { toolFilter: ['A', 'B', 'C'] });

  // The MEASUREMENT REPLACES the flat charge. Comparing the two totals therefore shows the difference
  // between them — 15855 − 24 — and not 15855: with no measurement the fallback still charges 3 × 8.
  const flat = 3 * 8;
  assert.equal(withTools - withoutTools, 15855 - flat,
    'the measured figure replaces the flat one rather than adding to it');

  // And the measured figure is present exactly once: check the total against the system cost directly.
  assert.equal(withTools, estimateTokens(system) + 15855);
});

test('without a measurement, the old estimate is kept as a fallback', () => {
  // Better than nothing, and it is exactly the old behaviour — so a caller that has not measured its
  // tools does not silently start reporting ZERO overhead.
  const a = estimateRequestOverhead('x', { toolFilter: ['A', 'B'] });
  const b = estimateRequestOverhead('x', { toolFilter: [] });
  assert.equal(a - b, 16, 'two tools at the old flat 8');
});

test('a zero measurement is respected, not treated as missing', () => {
  // `0` is a legitimate measurement — a subagent with no tools — and must not fall through to the
  // flat estimate, which would invent an overhead for tools that were never sent.
  const zero = estimateRequestOverhead('x', { toolDefTokens: 0, toolFilter: ['A', 'B'] });
  const fallback = estimateRequestOverhead('x', { toolFilter: ['A', 'B'] });
  assert.equal(zero, fallback - 16, 'the zero measurement wins over the flat one');
});
