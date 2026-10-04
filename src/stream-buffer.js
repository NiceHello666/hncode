// Semantic stream buffer — paces the reveal of streaming text so every provider
// looks the same.
//
// WHY THIS EXISTS
// ---------------
// Providers feed text deltas with wildly different cadences. OpenAI emits many tiny
// token-level deltas (a few characters every ~10-15ms), which already looks smooth.
// Anthropic coalesces its `content_block_delta` events into larger chunks that arrive
// in bursts with gaps (say 40 characters every ~100ms). Revealing each burst the
// instant it arrives makes the UI stair-step: a clump of text pops in, nothing for
// several frames, then another clump. The same interface therefore looks smooth on one
// provider and choppy on another, for no reason the user can see.
//
// To make every provider look the same, this buffer decouples ARRIVAL from REVEAL.
// Incoming content accumulates in an ordered backlog and a time-paced proportional
// controller drips it out: the rate rises with the backlog so a fast model is never
// left behind, yet a lone burst is spread over several frames instead of dumped in one.
//
// This is a port of jcode's `crates/jcode-tui-core/src/stream_buffer.rs`, kept to the
// same constants and the same shape so the two behave identically. Zero dependencies,
// like the rest of hncode.
//
// THE BACKLOG IS SEGMENT-AWARE
// ----------------------------
// Reasoning text and answer text are queued as ordered segments of ONE stream, plus
// zero-width "close reasoning region" markers. Both kinds therefore share the same
// smoothing controller and reveal strictly in arrival order. Pacing only the answer
// text would let reasoning pop in provider-sized clumps, and the ordering flushes
// needed to fix that would defeat the answer pacing too.

/** Steady-state reveal rate (chars/sec) with an empty backlog. This sets the floor
 *  cadence and how the trailing characters of a burst drain out. */
export const BASE_REVEAL_CPS = 180;

/** Additional reveal rate per buffered character. The controller speeds up as the
 *  backlog grows so a fast model is tracked with bounded latency: at a steady incoming
 *  rate `R`, the backlog settles near `(R - BASE_REVEAL_CPS) / REVEAL_BACKLOG_GAIN`. */
export const REVEAL_BACKLOG_GAIN = 3;

/** Hard ceiling for paced output, in characters per second. The proportional
 *  controller above may ask to catch up much faster when a provider delivers a whole
 *  response in one burst. Without a ceiling, a 3k-character backlog at a 50ms redraw
 *  cadence reveals more than 500 characters in one frame, which is several terminal
 *  rows appearing at once. Capping by ELAPSED TIME rather than by a fixed
 *  chars-per-frame value keeps a 16ms and a 50ms redraw loop at the same visual rate,
 *  while still draining a large burst in a few seconds. */
export const MAX_REVEAL_CPS = 960;

/** Maximum elapsed time credited to a single reveal step. Without this, a long idle
 *  gap before the next burst would bank a huge budget and dump the whole burst at
 *  once, reintroducing the choppiness this exists to remove. */
export const MAX_REVEAL_STEP_MS = 50;

/** Kinds of streamed content moving through the buffer. */
export const StreamKind = { Text: 'text', Reasoning: 'reasoning' };

/** Revealed operations, in arrival order. Callers apply these to the UI: `text`
 *  appends answer text, `reasoning` appends reasoning text, and `closeReasoning` ends
 *  the live reasoning region — exactly after the final buffered reasoning character it
 *  followed. */
export const StreamOp = {
  Text: 'text',
  Reasoning: 'reasoning',
  CloseReasoning: 'closeReasoning',
};

/** Maximum jitter-recorder events retained per series (arrivals / reveals). */
const JITTER_EVENT_CAP = 4096;

/**
 * Take at most `n` CODE POINTS off the front of `s`.
 *
 * The budget is counted in code points, not UTF-16 units: a surrogate pair is one
 * character to the model and one column-pair on screen, so counting units would drain
 * emoji at half rate and could split a pair mid-character.
 */
function takeCodePoints(s, n) {
  if (n <= 0) return ['', s];
  let count = 0;
  let i = 0;
  while (i < s.length && count < n) {
    const cp = s.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    count++;
  }
  return [s.slice(0, i), s.slice(i)];
}

function countCodePoints(s) {
  let n = 0;
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    n++;
  }
  return n;
}

/**
 * Records arrival (provider burst) and reveal (paced UI) events so choppiness can be
 * quantified: a smooth reveal stream has low variance in characters-per-time
 * regardless of how bursty the arrivals were. This is what lets the smoothing be
 * verified with a number instead of by eye.
 */
class JitterRecorder {
  constructor() {
    this.arrivals = [];
    this.reveals = [];
  }

  recordArrival(kind, chars, at) { this._record(this.arrivals, kind, chars, at); }
  recordReveal(kind, chars, at) { this._record(this.reveals, kind, chars, at); }

  _record(series, kind, chars, at) {
    if (chars === 0) return;
    if (series.length >= JITTER_EVENT_CAP) series.shift();
    series.push({ at, chars, kind });
  }

  /** Characters-per-second samples across a series, plus their spread. */
  static seriesStats(series) {
    if (series.length < 2) return { samples: 0, mean: 0, stdev: 0 };
    const rates = [];
    for (let i = 1; i < series.length; i++) {
      const dt = (series[i].at - series[i - 1].at) / 1000;
      // A zero-length gap would divide by zero; sub-millisecond gaps are noise.
      if (dt > 0) rates.push(series[i].chars / dt);
    }
    if (!rates.length) return { samples: 0, mean: 0, stdev: 0 };
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
    return { samples: rates.length, mean, stdev: Math.sqrt(variance) };
  }

  profile() {
    const arrivals = JitterRecorder.seriesStats(this.arrivals);
    const reveals = JitterRecorder.seriesStats(this.reveals);
    return {
      arrivals,
      reveals,
      // The headline number: how much steadier the reveal is than the arrivals that
      // fed it. 1 means "no smoothing", >1 means the UI is smoother than the wire.
      smoothing: arrivals.stdev > 0 ? arrivals.stdev / Math.max(1e-9, reveals.stdev) : 0,
    };
  }
}

export class StreamBuffer {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] Injectable clock in ms. Tests pin it to make the
   *   pacing deterministic; production leaves it as `Date.now`.
   */
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.baseCps = opts.baseCps != null ? opts.baseCps : BASE_REVEAL_CPS;
    this.backlogGain = opts.backlogGain != null ? opts.backlogGain : REVEAL_BACKLOG_GAIN;
    this.maxCps = opts.maxCps != null ? opts.maxCps : MAX_REVEAL_CPS;
    this.maxStepMs = opts.maxStepMs != null ? opts.maxStepMs : MAX_REVEAL_STEP_MS;
    this.queue = [];
    this.backlogChars = 0;
    this.lastReveal = this.now();
    // Fractional reveal budget carried between steps so slow rates still make progress
    // instead of rounding down to zero forever.
    this.carry = 0;
    // Independent hard-ceiling budget. Kept separate from `carry` so a large
    // proportional-controller backlog cannot bypass the wall-clock cap when many
    // provider deltas arrive between redraw ticks.
    this.ceilingCarry = 0;
    // Whether reasoning pushed through this buffer is still "open" (no close marker
    // queued since the last reasoning chunk).
    this.reasoningOpen = false;
    this.jitter = new JitterRecorder();
  }

  /** Push answer text, returning the paced ops ready to apply now. If a reasoning
   *  region is open in the backlog and this text contains non-whitespace, a
   *  `closeReasoning` marker is queued first so the region closes (in order) before
   *  the answer text reveals. */
  pushText(text) {
    const s = String(text == null ? '' : text);
    if (!s) return this._revealNow();
    if (this.reasoningOpen && s.trim() !== '') {
      this.queue.push({ marker: true });
      this.reasoningOpen = false;
    }
    this._pushChunk(StreamKind.Text, s);
    return this._revealNow();
  }

  /** Push reasoning text, returning the paced ops ready to apply now. Marks the
   *  reasoning region open until a close marker is queued. */
  pushReasoning(text) {
    const s = String(text == null ? '' : text);
    if (!s) return this._revealNow();
    this.reasoningOpen = true;
    this._pushChunk(StreamKind.Reasoning, s);
    return this._revealNow();
  }

  /** Queue a reasoning-region close marker (a no-op when no reasoning is open in the
   *  backlog), returning the paced ops ready to apply now. The marker reveals exactly
   *  after the final buffered reasoning character. */
  pushCloseReasoning() {
    if (this.reasoningOpen) {
      this.queue.push({ marker: true });
      this.reasoningOpen = false;
    }
    return this._revealNow();
  }

  /** Force flush the entire backlog. Call this on message end, commit, or interrupt —
   *  anything that ends the turn must not leave text trickling out afterwards. */
  flush() {
    this.carry = 0;
    this.ceilingCarry = 0;
    this.lastReveal = this.now();
    const ops = this._drainOps(this.backlogChars, true);
    this.backlogChars = 0;
    this.reasoningOpen = false;
    return ops;
  }

  /** Reveal one paced frame worth of buffered content. Called from the periodic redraw
   *  tick so the backlog drains smoothly even when no new delta arrived this frame.
   *  Finalization paths should still call `flush()`. */
  flushSmoothFrame() {
    return this._revealNow();
  }

  /** True when nothing is buffered — no chunks and no markers. A caller driving a
   *  fast tick can stop the tick on this. */
  get isEmpty() {
    return this.queue.length === 0;
  }

  /** Characters still waiting to be revealed. */
  get backlog() {
    return this.backlogChars;
  }

  /** Drop the backlog without returning content. */
  clear() {
    this.queue.length = 0;
    this.backlogChars = 0;
    this.carry = 0;
    this.ceilingCarry = 0;
    this.reasoningOpen = false;
    this.lastReveal = this.now();
  }

  /** Arrival-vs-reveal smoothness statistics. */
  jitterProfile() {
    return this.jitter.profile();
  }

  resetJitter() {
    this.jitter = new JitterRecorder();
  }

  /** Append a chunk, coalescing with the previous queue entry of the same kind so the
   *  queue stays short under token-level feeds. */
  _pushChunk(kind, text) {
    const n = countCodePoints(text);
    this.backlogChars += n;
    this.jitter.recordArrival(kind, n, this.now());
    const back = this.queue[this.queue.length - 1];
    if (back && !back.marker && back.kind === kind) {
      back.text += text;
      return;
    }
    this.queue.push({ kind, text });
  }

  /** Proportional, time-paced reveal: advance the budget by the (clamped) elapsed time
   *  times a backlog-scaled rate, then drain that many characters plus any zero-cost
   *  markers reached along the way. */
  _revealNow() {
    const now = this.now();
    if (this.backlogChars === 0) {
      // No chunk backlog: reset so an idle gap cannot bank reveal budget. Any queued
      // entries are markers only, and they emit immediately.
      this.carry = 0;
      this.ceilingCarry = 0;
      this.lastReveal = now;
      return this._drainOps(0, true);
    }

    const dt = Math.min(Math.max(0, now - this.lastReveal), this.maxStepMs) / 1000;
    this.lastReveal = now;

    const cps = this.baseCps + this.backlogChars * this.backlogGain;
    this.carry += dt * cps;
    this.ceilingCarry += dt * this.maxCps;

    let reveal = Math.min(Math.floor(this.carry), Math.floor(this.ceilingCarry));
    if (reveal === 0) {
      // The budget has not reached a whole character yet; keep accumulating. Leading
      // markers still emit so region boundaries are not delayed.
      return this._drainOps(0, false);
    }

    // The backlog-scaled controller is intentionally aggressive about catching up, but
    // it must never turn one provider burst into a visible wall of text. Bounding each
    // step by the same wall-clock rate keeps 16ms and 50ms redraw loops visually
    // identical, and the independent token bucket means repeated pushes with near-zero
    // elapsed time cannot mint one free character each.
    reveal = Math.min(reveal, this.backlogChars);
    this.carry -= reveal;
    this.ceilingCarry -= reveal;
    return this._drainOps(reveal, false);
  }

/** Drain up to `charCount` characters from the front of the queue, on code-point
   *  boundaries, emitting markers whenever they reach the front. A marker costs no
   *  budget, so a queued region boundary is never delayed behind text. */
  _drainOps(charCount) {
    const ops = [];
    let budget = charCount;
    const at = this.now();
    for (;;) {
      const front = this.queue[0];
      if (!front) break;
      if (front.marker) {
        this.queue.shift();
        ops.push({ op: StreamOp.CloseReasoning });
        continue;
      }
      if (budget === 0) break;
      // Read the kind BEFORE any shift: the pop below clears the reference.
      const kind = front.kind;
      const available = countCodePoints(front.text);
      const take = Math.min(budget, available);
      let chunk;
      if (take === available) {
        this.queue.shift();
        chunk = front.text;
      } else {
        const [head, rest] = takeCodePoints(front.text, take);
        front.text = rest;
        chunk = head;
      }
      budget -= take;
      this.backlogChars = Math.max(0, this.backlogChars - take);
      this.jitter.recordReveal(kind, take, at);
      ops.push({ op: kind === StreamKind.Text ? StreamOp.Text : StreamOp.Reasoning, text: chunk });
    }
    return ops;
  }
}