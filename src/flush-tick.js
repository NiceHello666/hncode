// Monotonic terminal-flush counter.
//
// WHY THIS EXISTS
// ---------------
// "I changed the state" and "the terminal has that change" are different facts, and
// this TUI has code that conflates them.
//
// State changes reach the screen through `renderSoon()`, which only SCHEDULES a paint
// (`setImmediate`). Several places then read the screen's geometry back as if the paint
// had already happened: the mouse handlers map a click's row to a transcript line
// through `state._bodyScreenTop`, the transcript renderer anchors the scroll position to
// `state._anchorPin`, and a resize defers its repair to the next frame. Every one of
// those is computed by `composeFrame` — the same call the pending paint will make, with
// the same state, so the values agree. The fragile part is not the arithmetic, it is the
// ORDERING: any of them can run in the window between the state change and the paint,
// and if the paint is then superseded (a resize, a re-entrant render) the value that was
// acted upon belongs to a frame that never reached the terminal.
//
// A counter makes "a frame has been written" observable, which is what lets a caller
// wait for it instead of assuming it. Deliberately a plain module-level integer with no
// allocation and no subscriber list: it is read a handful of times per frame, not
// subscribed to.

let flushTick = 0;

/**
 * Record one completed terminal frame write. Called from the single place every screen
 * change passes through, so "the tick advanced" means bytes left this process.
 *
 * Advanced even when a frame produced NO output (`diffFrame` returned an empty string
 * when nothing changed): a frame that was correctly painted by writing nothing is just
 * as painted, and gating on the tick would then wait for a change that will never come.
 */
export function noteTerminalFlush() {
  flushTick++;
  return flushTick;
}

/** The current tick. Monotonic for the life of the process; never resets. */
export function getTerminalFlushTick() {
  return flushTick;
}

/**
 * True once a frame has been written SINCE the given tick was taken.
 *
 * The usage that matters is "I am about to change state that is only observable after a
 * paint; if a paint already happened since I looked, the value I would read is current,
 * and if not, it is stale." Callers capture `getTerminalFlushTick()` when they widen a
 * value (open a panel, start a drag) and use this to decide whether to re-read it.
 *
 * @param {number} since a tick from `getTerminalFlushTick`.
 */
export function frameWrittenSince(since) {
  return flushTick !== since;
}