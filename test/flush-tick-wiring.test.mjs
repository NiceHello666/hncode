// The TUI must MAINTAIN the flush tick and CONSUME it where geometry is read.
//
// `flush-tick.test.mjs` covers the counter itself. This covers the two things that make
// it useful: that every paint advances it (so "a frame was written" is true), and that
// the mouse path settles a pending paint before mapping the pointer (so the geometry it
// acts on is the frame the user is looking at).
//
// `startTUI` builds its handlers inside a closure, so the wiring is asserted at the
// source level — the same technique stream-wiring.test.mjs uses.
//
// tui.js is CRLF, so nothing below may anchor on a literal newline: function bodies are
// cut out by brace matching instead, and every assertion is an index comparison inside
// the extracted body. That keeps a failure reporting its own message rather than
// dumping 800KB of source.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TUI = path.join(import.meta.dirname, '..', 'src', 'tui.js');
const src = fs.readFileSync(TUI, 'utf8');

/**
 * The source of `function <signature> (...) { ... }`, brace-matched. The signature is
 * matched literally, so it has to be written exactly as it appears in the source.
 *
 * @param {string} signature e.g. `paintNow()` or `scrollFromThumb(rowF)`.
 * @param {number} [depth] nesting level of the closing brace, counted from the
 *   function's own opening brace. 0 is the function itself, 1 a nested block.
 */
function body(signature, depth = 0) {
  const start = src.indexOf(`function ${signature}`);
  assert.ok(start >= 0, `${signature} was not found`);
  const open = src.indexOf('{', start);
  assert.ok(open > 0, `${signature} has no body`);
  let level = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') level++;
    else if (src[i] === '}') {
      level--;
      if (level === 0 || level === depth) return src.slice(open + 1, i);
    }
  }
  throw new Error(`${signature} is unbalanced`);
}

/** Assert that `later` appears in `code` after `earlier`. */
function ordered(code, earlier, later, what) {
  const a = code.indexOf(earlier);
  const b = code.indexOf(later);
  assert.ok(a >= 0, `${what}: ${JSON.stringify(earlier)} was not found`);
  assert.ok(b >= 0, `${what}: ${JSON.stringify(later)} was not found`);
  assert.ok(a < b, `${what}: ${JSON.stringify(later)} must come after ${JSON.stringify(earlier)}`);
}

test('every paint advances the tick, and records it as the last frame', () => {
  // paintNow is the ONLY place a frame reaches the terminal, so this is the only place
  // the counter may move. Both halves matter: `noteTerminalFlush()` makes "written"
  // observable, and the `_frameTickAt` capture is what lets a caller ask whether the
  // frame it was looking at has since been superseded.
  const paint = body('paintNow()');
  assert.ok(paint.includes('noteTerminalFlush()'),
    'paintNow must advance the flush tick — it is the only path to the terminal');
  assert.ok(paint.includes('state._frameTickAt = getTerminalFlushTick()'),
    'paintNow must record which frame is now the last one written');
});

test('the tick is captured AFTER the write, not before', () => {
  // Capturing first would name the PREVIOUS frame, so a caller would read
  // `frameWrittenSince` as true for a frame that is still only pending.
  ordered(body('paintNow()'), 'stdout.write(out)', 'state._frameTickAt = getTerminalFlushTick()',
    'the flush tick must be captured after the write, or it names an unpainted frame');
});

test('the mouse path settles a pending frame before reading pointer geometry', () => {
  // `hitAt` reads the hitbox list and `mouseToCell` reads `_bodyScreenTop`; both are
  // produced by composeFrame. A click can land in the window between a state change and
  // its `renderSoon()`, and the frame that paint produces can be superseded — so acting
  // on the geometry without settling it can act on a row the user never sees.
  const handle = body('handleMouse(t)');
  assert.ok(handle.includes('flushFrame()'), 'handleMouse must settle a pending frame');
  ordered(handle, 'flushFrame()', 'hitAt(t)', 'the hitbox lookup must follow the settle');
  ordered(handle, 'flushFrame()', 'mouseToCell(t)', 'the row mapping must follow the settle');
});

test('flushFrame only paints when something is actually pending', () => {
  // Unconditionally repainting on every mouse event would turn a hover into a frame, and
  // the point of `renderSoon` is that a burst coalesces into one paint.
  const flush = body('flushFrame()').trim();
  assert.equal(flush, 'if (paintScheduled) paintNow();',
    'flushFrame must be a no-op when no paint is pending');
});

test('a hitbox dispatched directly is still settled first', () => {
  // `dispatchHit` is reached from the mouse path today, but a hitbox carries a ROW
  // RANGE — geometry that means nothing before the frame that produced it is on screen.
  // Asserted here so a future direct call site cannot skip the contract.
  const dispatch = body('dispatchHit(hb)');
  assert.ok(dispatch.includes('flushFrame()'),
    'dispatchHit must settle a pending frame before acting on a hitbox row');
  ordered(dispatch, 'flushFrame()', 'switch (hb.kind)', 'the settle must precede the dispatch');
});

test('the scrollbar drag reads geometry, changes it, then paints', () => {
  // `state._sb` is the scrollbar rectangle of the frame on screen. It is only correct
  // because the mouse path settles the pending paint first, so the read has to come
  // before the change and the repaint after it — otherwise the next drag move works
  // from a frame that was never shown.
  const drag = body('scrollFromThumb(rowF)');
  ordered(drag, 'const sb = state._sb', 'state.scroll =', 'the geometry must be read before it is changed');
  ordered(drag, 'state.scroll =', 'renderFrame()', 'the frame this change produces must be painted');
  assert.equal((drag.match(/renderFrame\(\)/g) || []).length, 1,
    'exactly one paint: a second was a duplicate that painted the same frame twice');
});