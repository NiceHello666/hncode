// Tests for the motion/edge additions: reduced motion, the shared sweep band, and
// their wiring into state and config.
//
// Why these are tested separately: each is a visual change that no existing
// transcript test catches — a reduced-motion mode that still rotates, or a sweep that
// slams to full on its leading edge, would look wrong in a way `node --check` and the
// layout tests cannot see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { reducedMotionOn, spinnerFrame, sweepSettle, bandCharsFor, framesPerChar, SWEEP_TICKS, formatToolLine } from '../src/tui.js';
import { resolveConfig } from '../src/config.js';

const stateFor = (overrides) => ({
  spin: 0,
  cfg: { reducedMotion: false, shimmerEdge: 'cosine' },
  ...overrides,
});

// ---------------------------------------------------------------------------
// reduced motion
// ---------------------------------------------------------------------------

test('reduced motion is OFF by default', () => {
  assert.equal(reducedMotionOn(stateFor()), false);
  assert.equal(reducedMotionOn(stateFor({ cfg: { reducedMotion: false } })), false);
});

test('reduced motion reads from state, then config, then the environment', () => {
  // State wins (it is what /reduced-motion writes).
  assert.equal(reducedMotionOn(stateFor({ reducedMotion: true, cfg: { reducedMotion: false } })), true);
  assert.equal(reducedMotionOn(stateFor({ reducedMotion: false, cfg: { reducedMotion: true } })), false);
  // Config is next.
  assert.equal(reducedMotionOn(stateFor({ cfg: { reducedMotion: true } })), true);
  // And HNCODE_REDUCED_MOTION, the same convention config uses.
  const prev = process.env.HNCODE_REDUCED_MOTION;
  try {
    process.env.HNCODE_REDUCED_MOTION = '1';
    assert.equal(reducedMotionOn(stateFor()), true);
    process.env.HNCODE_REDUCED_MOTION = 'off';
    assert.equal(reducedMotionOn(stateFor()), false);
  } finally {
    if (prev === undefined) delete process.env.HNCODE_REDUCED_MOTION;
    else process.env.HNCODE_REDUCED_MOTION = prev;
  }
});

test('a reduced-motion spinner is a constant dot, never a rotating braille glyph', () => {
  const st = stateFor({ cfg: { reducedMotion: true } });
  const glyphs = new Set();
  for (let tick = 0; tick < 40; tick++) {
    glyphs.add(spinnerFrame({ ...st, spin: tick }).glyph);
  }
  // Over a full cycle, exactly ONE glyph — the dot. The rotating braille would cycle
  // through ten.
  assert.deepEqual([...glyphs], ['●']);
});

test('the dot breathes: it is dim for roughly half the cycle and lit for the other', () => {
  const st = stateFor({ cfg: { reducedMotion: true } });
  // The cycle is 2000ms and the tick is 80ms, so 25 ticks per HALF (lit then dim).
  // Tick 30 is firmly in the dim half — far enough from either boundary that the
  // test is not fragile against minor timing changes.
  assert.equal(spinnerFrame({ ...st, spin: 0 }).dim, false);
  assert.equal(spinnerFrame({ ...st, spin: 30 }).dim, true, 'second half of the cycle is dim');
// 50 ticks = two full cycles, so the phase repeats.
  assert.equal(spinnerFrame({ ...st, spin: 50 }).dim, false);
});
test('a normal spinner rotates through the braille frames and is never dim', () => {
  const st = stateFor();
  const glyphs = [];
  for (let tick = 0; tick < 10; tick++) glyphs.push(spinnerFrame({ ...st, spin: tick }).glyph);
  assert.equal(new Set(glyphs).size, 10, 'ten distinct frames');
  assert.ok(glyphs.every((g, i) => spinnerFrame({ ...st, spin: i }).dim === false));
});

// ---------------------------------------------------------------------------
// the sweep band
// ---------------------------------------------------------------------------

test('a settle sweep keeps a character lit AFTER the band passes it', () => {
  // The property that separates a settle from a pulse, and the bug that produced two
  // broken animations: a pulse dims a character again once the band leaves it, so a
  // "fill in" animation ends with nothing filled in.
  const half = 0.33;
  assert.equal(sweepSettle(0, half, 'cosine'), 1, 'exactly at the settle point');
  assert.equal(sweepSettle(0.2, half, 'cosine'), 1, 'behind the head: stays lit');
  assert.equal(sweepSettle(5, half, 'cosine'), 1, 'far behind: still lit');
  // Ahead of the band nothing has happened yet.
  assert.equal(sweepSettle(-half, half, 'cosine'), 0, 'exactly at the far edge');
  assert.equal(sweepSettle(-0.5, half, 'cosine'), 0, 'not reached yet');
  // Inside the band it ramps, and the ramp is monotonic.
  const ramp = [-0.3, -0.2, -0.1].map((d) => sweepSettle(d, half, 'cosine'));
  assert.ok(ramp[0] < ramp[1] && ramp[1] < ramp[2], `ramp must rise: ${ramp}`);
  assert.ok(ramp.every((v) => v > 0 && v < 1), `inside the band only: ${ramp}`);
});

test('cosine and linear differ only in the shape of the ramp', () => {
  const half = 0.33;
  const mid = -half / 2;
  const c = sweepSettle(mid, half, 'cosine');
  const l = sweepSettle(mid, half, 'linear');
  // Linear is exactly halfway at the midpoint; cosine is not (that is the point of it).
  assert.ok(Math.abs(l - 0.5) < 1e-9, `linear midpoint should be 0.5, got ${l}`);
  assert.notEqual(c, l, 'the two edges must differ');
  // Both agree on the two ends.
  for (const edge of ['cosine', 'linear']) {
    assert.equal(sweepSettle(0, half, edge), 1, `${edge} settles`);
    assert.equal(sweepSettle(-half, half, edge), 0, `${edge} starts at 0`);
  }
});

test('the transition is smooth: no step larger than a third of the range', () => {
  // "The transition is not natural" was the complaint, and part of the cause was
  // FRAMES PER CHARACTER. This checks the SHAPE has no jump, which a coarse
  // approximation of the ramp would produce.
  const half = 0.5;
  let prev = 0;
  let maxStep = 0;
  for (let i = 1; i <= 40; i++) {
    const d = -half + (2 * half) * (i / 40);
    const v = sweepSettle(d, half, 'cosine');
    maxStep = Math.max(maxStep, v - prev);
    prev = v;
  }
  assert.ok(maxStep < 0.34, `a cosine ramp over 40 samples must step smoothly, got ${maxStep}`);
});

test('framesPerChar grows with the half-sweep and is bounded by it', () => {
  // The measure that decides whether a sweep reads as a fade. It approaches ticks/2
  // as the band grows, so the tick count alone caps the smoothness — which is why the
  // parameter has to be checked rather than eyeballed.
  assert.ok(framesPerChar(10) >= 3, `a 10-char row must get 3+ frames, got ${framesPerChar(10).toFixed(2)}`);
  // The OLD 6-tick setting gave 2.0 frames — a snap, and the reason the animation
  // looked wrong. The new setting must be strictly smoother.
  assert.ok(framesPerChar(10, 6) <= 2.1, `the old 6-tick setting was a snap, got ${framesPerChar(10, 6).toFixed(2)}`);
  assert.ok(framesPerChar(10) > framesPerChar(10, 6), 'the new setting must be smoother than the old');
  assert.ok(framesPerChar(10, 20) > framesPerChar(10, 10), 'more ticks is smoother');
  assert.ok(framesPerChar(10, 1000) <= 500, 'bounded by ticks/2');
  // Every realistic row length clears the 2-frame floor.
  for (const n of [4, 7, 10, 16, 30]) {
    assert.ok(framesPerChar(n) >= 2, `n=${n} got ${framesPerChar(n).toFixed(2)}`);
  }
});

test('the band is proportional to the row, so smoothness is uniform', () => {
  // The point of scaling the band is that frames-per-character is the SAME for every
  // row length. A fixed cap on the band (as an earlier version had) made long rows
  // snap while short ones were smooth.
  assert.ok(bandCharsFor(4) >= 2, 'a short row still gets a usable band');
  assert.equal(bandCharsFor(10), 5);
  assert.equal(bandCharsFor(200), 100, 'the band follows the row, it is not capped');
  const fps = [7, 10, 16, 30, 60].map((n) => framesPerChar(n));
  const spread = Math.max(...fps) - Math.min(...fps);
  assert.ok(spread < 0.5, `every row length should be equally smooth, spread was ${spread.toFixed(2)}`);
});

test('a zero or near-zero half-width does not divide by zero or NaN', () => {
  // The clamp inside sweepSettle keeps `half` above 1e-6, so division is safe even
  // when a caller passes 0. NaN here would propagate into a colour escape.
  for (const v of [
    sweepSettle(0, 0, 'cosine'),
    sweepSettle(0.0001, 0.0001, 'linear'),
    sweepSettle(0.0001, 0.0001, 'cosine'),
    sweepSettle(-0.0001, 0.0001, 'linear'),
  ]) {
    assert.equal(Number.isFinite(v), true, `expected a finite number, got ${v}`);
  }
});

// ---------------------------------------------------------------------------
// config wiring

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pending tool rows (regression)
// ---------------------------------------------------------------------------

test('a pending tool row animates and stops once the tool finishes', () => {
  const msg = { role: 'tool', toolName: 'Bash', toolArgs: { command: 'ls' }, pending: true };
  const line = formatToolLine(msg, 'D:/x', 3, 0);
  assert.equal(typeof line, 'string');
  assert.ok(line.includes('Using'), 'the pending row renders');
  assert.ok(/\x1b\[/.test(line), 'the pending name carries colour escapes (it is animating)');
  // `spin` is monotonic, so different ticks must give different colouring — otherwise
  // the row is static and the "animation" is a no-op.
  const later = formatToolLine(msg, 'D:/x', 5, 0);
  assert.notEqual(line, later, 'the sweep advances with the tick');
  // A FINISHED tool shows a flat colour: no sweep, nothing to animate.
  const done = formatToolLine({ ...msg, pending: false }, 'D:/x', 3, 0);
  const doneLater = formatToolLine({ ...msg, pending: false }, 'D:/x', 9, 0);
  assert.equal(done, doneLater, 'a finished row does not animate');
});

test('formatToolLine survives with no state in scope (regression)', () => {
  // formatToolLine used to read `state.shimmerEdge` directly, but it is a
  // module-level function — `state` only exists inside startTUI's closure. The
  // ReferenceError fired the moment an agent tool call painted its first "Using …"
  // row, surfaced as an unhandledRejection, and the process handler exited the whole
  // TUI with no visible error. The edge is a parameter now, like spin/pulseStart.
  const msg = { role: 'tool', toolName: 'Bash', toolArgs: { command: 'ls' }, pending: true };
  assert.doesNotThrow(() => formatToolLine(msg, 'D:/x', 3, 0));
  assert.doesNotThrow(() => formatToolLine(msg, 'D:/x', 3, 0, 'linear'));
});

test('the edge option changes the rendered sweep', () => {
  // Verified by rendering, not by comparing the formulas: the two edges differ by only
  // ~0.10 of the intensity range, and an early version of this test measured exactly
  // that and concluded the option was below the colour quantisation. It was — because
  // the animation was DEAD at the time (`pulseStart || spin` collapsed the cycle; see
  // the regression test above). With the sweep running, the difference lands on
  // different colour codes and the option is visible, so the test asserts THAT.
  const msg = { role: 'tool', toolName: 'ReadMediaFile', toolArgs: { path: 'a.png' }, pending: true };
  let differed = 0;
  for (let spin = 0; spin < 60; spin++) {
    if (formatToolLine(msg, 'D:/x', spin, 0, 'cosine') !== formatToolLine(msg, 'D:/x', spin, 0, 'linear')) differed++;
  }
  assert.ok(differed > 0, 'the edge option must affect the rendered output');
  // ...and it is a small difference, not a different picture: the option shapes the
  // ramp, it does not change the colours.
  assert.ok(differed < 40, `the option should not change most frames, differed on ${differed}/60`);
  // The underlying values differ by a fraction of the range, which is why the effect is
  // subtle rather than dramatic.
  const n = 13;
  const BAND = bandCharsFor(n) / n;
  let maxGap = 0;
  for (let i = 0; i < n; i++) {
    const d = -BAND / 2 - i / n;
    maxGap = Math.max(maxGap, Math.abs(sweepSettle(d, BAND, 'cosine') - sweepSettle(d, BAND, 'linear')));
  }
  assert.ok(maxGap > 0.05 && maxGap < 0.5, `the edges should differ modestly, got ${maxGap}`);
});

// config wiring
// ---------------------------------------------------------------------------

test('config exposes reducedMotion and shimmerEdge with sensible defaults', () => {
  const prev = process.env.HNCODE_REDUCED_MOTION;
  const prevEdge = process.env.HNCODE_SHIMMER_EDGE;
  try {
    delete process.env.HNCODE_REDUCED_MOTION;
    delete process.env.HNCODE_SHIMMER_EDGE;
    const cfg = resolveConfig();
    assert.equal(cfg.reducedMotion, false, 'motion is the default; reduced is opt-out');
    assert.equal(cfg.shimmerEdge, 'cosine', 'the soft edge is the default');
  } finally {
    if (prev === undefined) delete process.env.HNCODE_REDUCED_MOTION; else process.env.HNCODE_REDUCED_MOTION = prev;
    if (prevEdge === undefined) delete process.env.HNCODE_SHIMMER_EDGE; else process.env.HNCODE_SHIMMER_EDGE = prevEdge;
  }
});

test('the environment can force both options', () => {
  const prev = process.env.HNCODE_REDUCED_MOTION;
  const prevEdge = process.env.HNCODE_SHIMMER_EDGE;
  try {
    process.env.HNCODE_REDUCED_MOTION = '1';
    process.env.HNCODE_SHIMMER_EDGE = 'linear';
    const cfg = resolveConfig();
    assert.equal(cfg.reducedMotion, true);
    assert.equal(cfg.shimmerEdge, 'linear');
    // And an unknown edge falls back to cosine rather than a crash.
    process.env.HNCODE_SHIMMER_EDGE = 'wiggly';
    assert.equal(resolveConfig().shimmerEdge, 'cosine');
  } finally {
    if (prev === undefined) delete process.env.HNCODE_REDUCED_MOTION; else process.env.HNCODE_REDUCED_MOTION = prev;
    if (prevEdge === undefined) delete process.env.HNCODE_SHIMMER_EDGE; else process.env.HNCODE_SHIMMER_EDGE = prevEdge;
  }
});
