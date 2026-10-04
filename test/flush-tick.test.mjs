// "Painted" must be an observable fact, not an assumption.
//
// WHY THIS EXISTS
// ---------------
// `renderSoon()` only SCHEDULES a paint. Several places then read geometry that
// `composeFrame` produced — `_bodyScreenTop` for mouse→transcript mapping, the hitbox
// list for what a click hit, `_anchorPin` for the scroll anchor — as if the paint had
// already happened. It usually has been, and the values agree because the pending paint
// renders the same state again. The fragile part is ORDERING: a resize or a re-entrant
// render can make that pending paint a different frame, and the value acted upon then
// belongs to a frame that never reaches the screen.
//
// `src/flush-tick.js` is the counter that makes "bytes left this process" observable.
// This file covers the counter's contract; `flush-tick-wiring.test.mjs` covers that the
// TUI actually maintains and consumes it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getTerminalFlushTick, noteTerminalFlush, frameWrittenSince } from '../src/flush-tick.js';

test('the tick is monotonic and starts where the process is', () => {
  const a = getTerminalFlushTick();
  noteTerminalFlush();
  const b = getTerminalFlushTick();
  noteTerminalFlush();
  const c = getTerminalFlushTick();
  assert.ok(b > a, 'a flush must advance the tick');
  assert.ok(c > b);
  assert.equal(c - b, 1, 'exactly one flush is exactly one step');
});

test('the tick never wraps or resets', () => {
  // The comparison is `!==`, not `>`, so a wrap would be invisible — but a wrap would
  // also make `frameWrittenSince` wrong for any caller holding an old value, which is
  // the whole point of a monotonic counter.
  const first = getTerminalFlushTick();
  for (let i = 0; i < 100; i++) noteTerminalFlush();
  assert.equal(getTerminalFlushTick(), first + 100);
});

test('"written since" is false until a flush actually happens', () => {
  const taken = getTerminalFlushTick();
  assert.equal(frameWrittenSince(taken), false, 'nothing has been written yet');
  noteTerminalFlush();
  assert.equal(frameWrittenSince(taken), true);
});

test('a stale capture keeps reporting true, however many flushes follow', () => {
  // The usage is "I widened this at tick N; has a frame landed since?" — an old capture
  // must not flip back to false, or the caller would keep waiting for a frame that has
  // long since arrived.
  const taken = getTerminalFlushTick();
  noteTerminalFlush();
  for (let i = 0; i < 5; i++) noteTerminalFlush();
  assert.equal(frameWrittenSince(taken), true);
});

test('a fresh capture is false again', () => {
  // Taking the tick again names the frame just written, so nothing has been written
  // since THAT one. This is what makes the pattern usable in a loop.
  noteTerminalFlush();
  const taken = getTerminalFlushTick();
  assert.equal(frameWrittenSince(taken), false);
  noteTerminalFlush();
  assert.equal(frameWrittenSince(taken), true);
  assert.equal(frameWrittenSince(getTerminalFlushTick()), false, 'and false once more after');
});

test('the counter is shared, not per-caller', () => {
  // Two importers must see the same number, or "a frame was written" would mean
  // different things in different places.
  const before = getTerminalFlushTick();
  noteTerminalFlush();
  assert.equal(getTerminalFlushTick(), before + 1);
});