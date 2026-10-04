// Tests for the semantic stream buffer.
//
// The contract that matters is NOT "it eventually shows all the text" — that is easy
// and a naive implementation passes it. It is:
//
//   1. no character is lost or duplicated, whatever the burst pattern;
//   2. arrival ORDER is preserved across kinds (reasoning before the answer it
//      preceded, region boundaries exactly where they were queued);
//   3. the reveal is SMOOTHER than the arrivals that fed it — that is the whole point,
//      and it is the only claim a user can actually see;
//   4. a burst cannot be dumped in one frame, and an idle gap cannot bank a budget;
//   5. `flush()` empties everything, because a turn that ends must not leave text
//      trickling out behind it.
//
// A deterministic clock is injected throughout: real timers would make the smoothing
// assertions flaky, and the pacing IS the feature.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamBuffer, StreamOp,
  BASE_REVEAL_CPS, MAX_REVEAL_CPS, MAX_REVEAL_STEP_MS,
} from '../src/stream-buffer.js';

// A clock the test advances by hand.
function makeClock() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
  };
}

/** Concatenate the text of every op, ignoring markers. */
const textOf = (ops) => ops.filter((o) => o.text).map((o) => o.text).join('');

test('a single burst is never revealed in one step', () => {
  // The headline behaviour. A provider that hands over 400 characters at once must not
  // put 400 characters on screen in one frame.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  const first = b.pushText('x'.repeat(400));
  assert.ok(first.length <= 1, `a fresh burst revealed ${first.length} chunks at once`);
  assert.ok(textOf(first).length < 400, 'the whole burst was revealed immediately');
  // Nothing arrives for a while: the backlog must drain on its own, without a push.
  let seen = textOf(first).length;
  for (let i = 0; i < 40; i++) {
    clock.advance(16);
    seen += textOf(b.flushSmoothFrame()).length;
  }
  assert.ok(seen > textOf(first).length, 'the backlog did not drain without new arrivals');
});

test('no character is lost or duplicated, across a bursty feed', () => {
  // Arrival is bursty (Anthropic-shaped): clumps with gaps. Every character must still
  // reach the UI exactly once, in order.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  const chunks = ['Hello', ', wor', 'ld. ', 'This is ', 'a bursty ', 'feed with ', 'gaps.'];
  let revealed = '';
  for (const c of chunks) {
    revealed += textOf(b.pushText(c));
    clock.advance(100);            // a gap between clumps
    revealed += textOf(b.flushSmoothFrame());
  }
  revealed += textOf(b.flush());
  assert.equal(revealed, chunks.join(''), 'the revealed text must equal the fed text exactly');
  assert.ok(b.isEmpty, 'flush must empty the buffer');
});

test('reasoning and answer text keep their arrival order', () => {
  // Both kinds share one queue, so a reasoning block cannot overtake the answer text
  // that came after it — and the region boundary lands exactly where it was queued.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  const ops = [];
  ops.push(...b.pushReasoning('thinking hard'));
  ops.push(...b.pushCloseReasoning());
  ops.push(...b.pushText('the answer'));
  clock.advance(1000);
  ops.push(...b.flush());

  const kinds = ops.map((o) => o.op);
  const firstText = kinds.indexOf(StreamOp.Text);
  const closeIdx = kinds.indexOf(StreamOp.CloseReasoning);
  assert.ok(closeIdx >= 0, 'the close marker was dropped');
  assert.ok(firstText > closeIdx,
    `answer text revealed before the reasoning region closed: ${JSON.stringify(kinds)}`);
  // Every reasoning op precedes every text op.
  const lastReasoning = kinds.lastIndexOf(StreamOp.Reasoning);
  assert.ok(lastReasoning < firstText, 'reasoning text leaked past the answer text');
});

test('the reveal is smoother than the arrivals that fed it', () => {
  // The measurable claim. The wire pattern here is the one that actually looks bad: a
  // big clump arriving after a pause, i.e. bursts of very different sizes. The reveal is
  // sampled at the REDRAW cadence, so it must come out far steadier than the wire.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  let revealed = 0;
  // Sizes deliberately uneven: 5, 60, 5, 60, ... — the stair-step a coalescing provider
  // produces when a small delta follows a big one.
  for (let i = 0; i < 24; i++) {
    const n = i % 2 === 0 ? 5 : 60;
    revealed += textOf(b.pushText('y'.repeat(n))).length;
    clock.advance(100);
    revealed += textOf(b.flushSmoothFrame()).length;
  }
  revealed += textOf(b.flush()).length;
  assert.equal(revealed, 12 * 5 + 12 * 60, 'every character must arrive');
  const p = b.jitterProfile();
  assert.ok(p.arrivals.stdev > 0, 'the arrival pattern must register as choppy');
  assert.ok(p.smoothing > 1,
    `the reveal should be steadier than the wire (smoothing=${p.smoothing.toFixed(2)})`);
});

test('an idle gap does not bank reveal budget', () => {
  // MAX_REVEAL_STEP_MS caps the elapsed time credited to one step. Without it, a pause
  // before the next burst would dump that whole burst at once.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  clock.advance(60_000);                     // a minute of silence
  const ops = b.pushText('z'.repeat(2000));
  const cap = Math.ceil(MAX_REVEAL_STEP_MS / 1000 * MAX_REVEAL_CPS);
  assert.ok(textOf(ops).length <= cap,
    `a minute-long gap revealed ${textOf(ops).length} chars at once (cap ${cap})`);
});

test('the reveal rate rises with the backlog but stays under the ceiling', () => {
  // The controller is proportional: a bigger backlog drains faster, so a fast model is
  // not left behind. The ceiling keeps a huge backlog from becoming a wall of text.
  const clock = makeClock();
  const small = new StreamBuffer({ now: clock.now });
  small.pushText('a'.repeat(10));
  clock.advance(16);
  const smallReveal = textOf(small.flushSmoothFrame()).length;

  const clock2 = makeClock();
  const big = new StreamBuffer({ now: clock2.now });
  big.pushText('a'.repeat(5000));
  clock2.advance(16);
  const bigReveal = textOf(big.flushSmoothFrame()).length;

  assert.ok(bigReveal > smallReveal, 'a larger backlog must drain faster');
  const ceiling = Math.ceil(16 / 1000 * MAX_REVEAL_CPS);
  assert.ok(bigReveal <= ceiling, `revealed ${bigReveal} chars in 16ms (ceiling ${ceiling})`);
});

test('the reveal rate is independent of the tick length', () => {
  // Capping by ELAPSED TIME rather than by a fixed chars-per-frame value is what keeps a
  // 16ms and a 50ms redraw loop at the same visual rate.
  const run = (tick) => {
    const clock = makeClock();
    const b = new StreamBuffer({ now: clock.now });
    b.pushText('m'.repeat(20_000));
    let revealed = 0;
    for (let i = 0; i < Math.floor(1000 / tick); i++) {
      clock.advance(tick);
      revealed += textOf(b.flushSmoothFrame()).length;
    }
    return revealed;
  };
  const fast = run(16);
  const slow = run(50);
  // Both drain the same wall-clock second; the ceiling makes them near-equal.
  assert.ok(Math.abs(fast - slow) <= 0.2 * Math.max(fast, slow),
    `16ms revealed ${fast}, 50ms revealed ${slow} — the rates diverged`);
});

test('push calls with near-zero elapsed time cannot mint free characters', () => {
  // The independent ceiling bucket. Without it, repeated pushes in the same millisecond
  // would each get a whole character from the proportional controller.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  let revealed = 0;
  for (let i = 0; i < 500; i++) revealed += textOf(b.pushText('q')).length;
  assert.equal(revealed, 0, 'no characters may be revealed without elapsed time');
});

test('whitespace-only answer text does not close an open reasoning region', () => {
  // A newline arriving between reasoning and the answer is not the answer starting; the
  // region must stay open until real content shows up.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  b.pushReasoning('thinking');
  const ops = b.pushText('\n\n');
  assert.ok(!ops.some((o) => o.op === StreamOp.CloseReasoning),
    'a whitespace-only delta closed the reasoning region');
  clock.advance(100);
  const after = b.pushText('real answer');
  const kinds = [...ops, ...after, ...b.flush()].map((o) => o.op);
  assert.ok(kinds.includes(StreamOp.CloseReasoning), 'real answer text must close the region');
});

test('a reasoning region with no answer text still closes on request', () => {
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  b.pushReasoning('just thinking');
  const ops = [...b.pushCloseReasoning(), ...b.flush()];
  assert.ok(ops.some((o) => o.op === StreamOp.CloseReasoning), 'the explicit close was dropped');
});

test('emoji and CJK are counted and drained by code point, never split', () => {
  // The budget is counted in code points, not UTF-16 units: splitting a surrogate pair
  // would put a lone half-surrogate on screen, and counting units would drain an emoji
  // at half rate.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  const text = '😀中🎉文'.repeat(10);
  let revealed = '';
  b.pushText(text);
  for (let i = 0; i < 400; i++) {
    clock.advance(16);
    revealed += textOf(b.flushSmoothFrame());
  }
  revealed += textOf(b.flush());
  assert.equal(revealed, text, 'the multi-byte text must round-trip exactly');
  // A chunk must never end on a lone high surrogate: that is the visible symptom of
  // draining by UTF-16 unit instead of code point.
  for (let i = 0; i + 1 < revealed.length; i++) {
    const code = revealed.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = revealed.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff,
        `lone high surrogate at index ${i} in the revealed text`);
      i++;
    }
  }
});

test('chunks of the same kind coalesce so the queue stays short', () => {
  // A token-level feed (OpenAI) must not grow the queue once per token: each entry is a
  // string concatenation, and a long answer would otherwise carry thousands of them.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  for (let i = 0; i < 2000; i++) {
    b.pushText('t');
    clock.advance(1);
    b.flushSmoothFrame();
  }
  // Whatever is left must be a single coalesced entry, not 2000.
  assert.ok(b.queue.length <= 2, `the queue grew to ${b.queue.length} entries`);
});

test('flush returns everything and leaves the buffer empty', () => {
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  b.pushText('one');
  b.pushReasoning('two');
  const all = textOf(b.flush());
  assert.equal(all, 'onetwo');
  assert.ok(b.isEmpty, 'the buffer must be empty after flush');
  assert.equal(b.backlog, 0, 'the backlog counter must reset');
  assert.deepEqual(b.flush(), [], 'a second flush has nothing to return');
});

test('clear drops the backlog without revealing it', () => {
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  b.pushText('discard me');
  b.clear();
  assert.ok(b.isEmpty, 'clear must empty the queue');
  assert.equal(b.backlog, 0);
  assert.deepEqual(b.flush(), [], 'nothing may survive a clear');
});

test('markers are emitted even when no character budget is available', () => {
  // A region boundary must not be stuck behind a text budget that has not accrued yet.
  const clock = makeClock();
  const b = new StreamBuffer({ now: clock.now });
  b.pushReasoning('r');
  b.pushCloseReasoning();
  const ops = b.pushCloseReasoning();          // no elapsed time, no budget
  assert.ok(Array.isArray(ops), 'push must always return an op list');
  const all = [...ops, ...b.flush()];
  assert.ok(all.some((o) => o.op === StreamOp.CloseReasoning), 'the marker was swallowed');
});

test('the base rate is the floor and the ceiling is above it', () => {
  // Guards against a config mistake that would invert the controller.
  assert.ok(BASE_REVEAL_CPS > 0);
  assert.ok(MAX_REVEAL_CPS > BASE_REVEAL_CPS,
    'the ceiling must be above the base rate, or the controller can never catch up');
});