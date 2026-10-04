// A minimal retained-mode cell layer, modelled on OpenTUI's OptimizedBuffer.
//
// WHY THIS EXISTS
// ---------------
// The picker used to be painted as a finished ANSI STRING assigned over a whole
// frame row (`lines[row] = boxRow`). That is not an overlay, it is a replacement:
// every column the card's padding happened to occupy was erased, so the transcript
// beside the card disappeared — a row of `11111111111111` rendered as
// `        |111111|`.
//
// OpenTUI gets this right because it never builds strings. It keeps a 2-D buffer of
// cells, paints the dialog into its OWN buffer, and composites that buffer onto the
// scene with `drawFrameBuffer`. The rule that makes it work is in `blendCells`:
//
//     const preserveChar = (charIsDefaultSpace and destNotZero and
//                           destNotDefaultSpace and destWidthIsOne);
//     const finalChar = if (preserveChar) destCell.char else overlayCell.char;
//
// An overlay cell that is a BLANK SPACE does not overwrite what is underneath — it
// keeps the destination's character. That single rule is the difference between a
// floating window and a full-screen takeover.
//
// hncode still renders its body as ANSI strings (rewriting all of it would be a much
// larger change), so this module does one job: turn a row of that text into cells,
// composite an overlay row onto it cell-by-cell using OpenTUI's rule, and turn the
// result back into an ANSI string. Zero dependencies, like the rest of hncode.

import { charWidth } from './term.js';

// A cell in a layer. `blank` marks a cell the overlay does not paint — the equivalent
// of OpenTUI's DEFAULT_SPACE_CHAR combined with a transparent alpha. Those cells
// defer to whatever is underneath instead of erasing it.
export function cell(ch, style, blank = false) {
  return { ch, style: style || '', blank };
}

const RESET = '\x1b[0m';

/**
 * The cell that follows a double-width glyph, occupying its second column.
 *
 * A terminal does not advance one column per CHARACTER, it advances one column per
 * DISPLAY CELL. `你好` is two characters but eight columns; `😀` is one character and
 * two columns. A layer indexed by character therefore drifts out of step with the
 * screen as soon as it contains anything wide, and every glyph after it lands one
 * or more columns to the left of where the terminal will actually draw it — which is
 * how backdrop text ended up showing through the middle of an opaque dialog.
 *
 * The continuation cell holds an empty `ch`, so rendering emits the wide glyph once
 * and the terminal supplies the second column itself. This is the same accounting
 * OpenTUI does with `encodedCharWidth`.
 */
const WIDE_CONT = { ch: '', style: '', blank: false, cont: true };

/** A cell that defers to the layer below it. */
export const BLANK = cell(' ', '', true);

/**
 * Split an ANSI string into cells, ONE PER DISPLAY COLUMN.
 *
 * A wide (CJK) glyph is ONE cell followed by a continuation cell spanning its second
 * column, so `cells.length` always equals `visualWidth(str)` and index N is always
 * screen column N. Indexing by code point instead — which this used to do — silently
 * desynchronised the layer from the screen for any row containing wide text: the
 * layer came out shorter than the columns it had to cover, so the tail of the row was
 * never overwritten and the transcript underneath showed through the dialog.
 *
 * Zero-width characters (combining marks, joiners) occupy no column and are dropped.
 */
export function parseCells(s) {
  const str = String(s == null ? '' : s);
  const cells = [];
  let style = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i))
        || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(str.slice(i));
      if (m) {
        // A reset ends the current style rather than becoming part of the next one. Both
        // spellings matter: `renderCells` emits `\x1b[0m`, but a row that came from
        // elsewhere — a shell escape, a plugin, a hand-built string — can carry the bare
        // `\x1b[m`, and treating that as an ordinary attribute left the old style attached
        // to the next cell. The stale `48;…` then survived every later edit and the row
        // never quite matched itself.
        if (m[0] === '\x1b[0m' || m[0] === '\x1b[m') style = '';
        else style += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const step = cp > 0xffff ? 2 : 1;
    const cw = charWidth(ch);
    if (cw === 0) { i += step; continue; }        // combining mark: no column of its own
    cells.push(cell(ch, style));
    if (cw === 2) cells.push({ ...WIDE_CONT, style });  // its second column
    i += step;
  }
  return cells;
}

/**
 * Render cells back to an ANSI string.
 *
 * A RESET is emitted before each new style run, so the output is IDEMPOTENT: parsing
 * it again reproduces exactly the styles it came from. Without the reset the codes
 * accumulate — a row that was dimmed, re-parsed and re-rendered grew a fresh `\x1b[2m`
 * on every pass, and after a few frames a cell's "style" was hundreds of repeated
 * escape codes. That is invisible in a stripped-text check and eventually slows the
 * whole render path down.
 */
export function renderCells(cells) {
  let out = '';
  let cur = null;
  for (const c of cells) {
    // A wide glyph's continuation cell carries no character of its own: the glyph
    // before it already occupies both columns on screen, so emitting anything here
    // would shift the rest of the row one column to the right.
    if (c.cont) continue;
    if (c.style !== cur) {
      // Close the previous run before opening the next, so neither leaks into the other.
      out += c.style === '' ? RESET : RESET + c.style;
      cur = c.style;
    }
    out += c.ch;
  }
  return out;
}

/**
 * OpenTUI's `blendCells`, reduced to the one rule that matters here.
 *
 * An overlay cell that is BLANK keeps the destination's character — and, since the
 * destination has already been dimmed by the time the layer goes on top, that
 * character arrives dimmed. Everything else in the overlay is opaque and wins.
 */
export function blendCell(overlay, dest) {
  if (!overlay.blank) return overlay;
  // A continuation cell belongs to the wide glyph in the cell before it. If the
  // overlay put a wide glyph here, that glyph owns both columns, so the
  // destination's second half must not survive independently of the first.
  if (overlay.cont) return overlay;
  if (dest && dest.ch && dest.ch !== ' ' && !dest.cont) return dest;
  return overlay;
}

/**
 * Composite an overlay row onto a base row at column `destX`, cell by cell, using
 * `blendCell`. This is `drawFrameBuffer` for a single row.
 *
 * `overlay` is a cell array (build one with `parseCells` and mark the cells that must
 * stay transparent with `BLANK`), or a plain string for the common case of an opaque
 * overlay. The base row is a string and is never mutated — each call parses its own
 * copy, so compositing several rows cannot make one bleed into the next.
 */
export function drawFrameBuffer(baseRow, overlay, destX) {
  const base = parseCells(baseRow);
  const layer = typeof overlay === 'string' ? parseCells(overlay) : overlay;
  for (let i = 0; i < layer.length; i++) {
    const at = destX + i;
    if (at < 0) continue;
    if (at >= base.length) {
      // Past the end of the base row: pad so the overlay still lands.
      while (base.length < at) base.push(BLANK);
      base.push(blendCell(layer[i], null));
      continue;
    }
    base[at] = blendCell(layer[i], base[at]);
  }
  return renderCells(base);
}