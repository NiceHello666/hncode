// Tests for the cell layer the picker is composited through.
//
// Why this is its own module with its own tests: the picker used to be painted by
// assigning a finished ANSI string over a whole frame row, which is a REPLACEMENT,
// not an overlay — every column the card occupied was erased, so the transcript beside
// it disappeared. The fix was to adopt OpenTUI's model, where a dialog is its own
// cell buffer drawn onto the scene with `drawFrameBuffer` and `blendCells` keeps the
// destination under a blank overlay cell.
//
// Testing principle: these are pure string→cells→string transforms, so they are driven
// directly. The rules that matter are the ones that are invisible when broken — a
// dropped escape changes a colour, a lost cell shifts a row sideways.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cell, BLANK, parseCells, renderCells, blendCell, drawFrameBuffer } from '../src/cell-buffer.js';
import { visualWidth } from '../src/term.js';

const ESC = String.fromCharCode(27);
const plain = (s) => String(s).replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');

// ---------------------------------------------------------------------------
// Parsing and rendering
// ---------------------------------------------------------------------------

test('parseCells splits into one cell per column and renderCells round-trips', () => {
  assert.deepEqual(parseCells('abc').map((c) => c.ch), ['a', 'b', 'c']);
  assert.equal(plain(renderCells(parseCells('hello'))), 'hello');
  assert.equal(plain(renderCells(parseCells(`${ESC}[38;5;74mhi${ESC}[0m`))), 'hi');
});

test('renderCells is idempotent: re-rendering does not grow the escape codes', () => {
  // This is the property that keeps the render path cheap AND correct. Without a reset
  // between style runs, every parse → render round-trip appended another copy of each
  // code, so a row that had been dimmed and composited a few times carried a "style"
  // of hundreds of repeated escapes — invisible in a stripped-text check, and a real
  // cost on every frame.
  const once = renderCells(parseCells(`${ESC}[38;5;74mhi${ESC}[0mthere`));
  const twice = renderCells(parseCells(once));
  assert.equal(twice, once, 'a second round-trip is a no-op');
  assert.equal(renderCells(parseCells(renderCells(parseCells(once)))), once);
  // And a run's style is bounded, not cumulative.
  const styles = parseCells(once).map((c) => c.style);
  for (const s of styles) assert.ok(s.length < 40, `style grew unbounded: ${JSON.stringify(s)}`);
});

test('a style change is recorded on the cell that carries it, and the next one', () => {
  const cells = parseCells(`${ESC}[31ma${ESC}[32mb`);
  assert.equal(cells[0].style, `${ESC}[31m`);
  assert.equal(cells[1].style, `${ESC}[31m${ESC}[32m`, 'the second cell inherits the first');
  assert.equal(plain(renderCells(cells)), 'ab', 'and rendering keeps both colours in order');
});

test('a reset ends the style instead of being carried into the next cell', () => {
  // If `\x1b[0m` were kept in the accumulated style, every cell after the first reset
  // would re-emit it — harmless visually but it grows the string without bound.
  const cells = parseCells(`${ESC}[31ma${ESC}[0mb`);
  assert.equal(cells[1].style, '', 'the style is cleared at the reset');
});

test('a wide glyph is ONE cell plus its continuation, so it never gets split', () => {
  // OpenTUI guards its blend with `encodedCharWidth(destCell.char) == 1` for exactly
  // this reason: splitting a double-width character produces two broken halves.
  //
  // `parseCells` is indexed by DISPLAY COLUMN, not by character: `中文` is two
  // characters but FOUR columns, so it becomes four cells — the glyph, its
  // continuation, the glyph, its continuation. The character itself is still never
  // divided; what changed is that the array index now means the same thing it means
  // on screen. Indexing by character left the layer shorter than the columns it had
  // to cover, and the transcript showed through the dialog wherever it was not.
  const cells = parseCells('中文');
  assert.equal(cells.length, 4, 'one cell per column, not per character');
  assert.equal(cells[0].ch, '中');
  assert.equal(cells[2].ch, '文');
  assert.ok(cells[1].cont && cells[3].cont, 'each wide glyph owns a continuation cell');
  // The round trip is what actually reaches the terminal: the continuation emits
  // nothing, so the glyph is written once and the terminal supplies its second column.
  assert.equal(plain(renderCells(cells)), '中文');
});

test('a surrogate pair survives the round trip as one cell', () => {
  // `😀` is ONE character spanning TWO columns, so it is one glyph cell plus one
  // continuation — and it must not be torn into two lone surrogates on the way.
  const cells = parseCells('😀x');
  assert.equal(cells.length, 3);
  assert.equal(cells[0].ch, '\u{1F600}');
  assert.ok(cells[1].cont, 'the emoji occupies a second column');
  assert.equal(cells[2].ch, 'x');
  assert.equal(plain(renderCells(cells)), '😀x');
});

test('a row with wide text yields exactly as many cells as columns', () => {
  // The invariant the compositor depends on: cell index === screen column. Without
  // it a layer cannot be trusted to cover the columns it was asked to cover.
  for (const s of ['ascii only', '你好世界', 'ab你好', '😀x', 'mixed 中文 and ascii']) {
    assert.equal(parseCells(s).length, visualWidth(s), `column count for ${JSON.stringify(s)}`);
  }
});

// ---------------------------------------------------------------------------
// blendCell — OpenTUI's rule
// ---------------------------------------------------------------------------

test('an opaque overlay cell wins over whatever is underneath', () => {
  const merged = blendCell(cell('X'), cell('a'));
  assert.equal(merged.ch, 'X');
});

test('a BLANK overlay cell keeps the destination character', () => {
  // The whole point of the overlay. `1111111111111` under a blank card cell must stay
  // `1111111111111` — this is the rule that turns a replacement into a layer.
  const merged = blendCell(BLANK, cell('7'));
  assert.equal(merged.ch, '7');
});

test('a blank overlay cell over a blank destination stays blank', () => {
  // Nothing to preserve, so the overlay's own blank wins rather than inventing a char.
  assert.equal(blendCell(BLANK, cell(' ')).ch, ' ');
  assert.equal(blendCell(BLANK, null).ch, ' ');
});

test('a preserved cell keeps the destination style, so its colour survives', () => {
  const dest = cell('7', `${ESC}[38;5;74m`);
  const merged = blendCell(BLANK, dest);
  assert.equal(merged.ch, '7');
  assert.equal(merged.style, `${ESC}[38;5;74m`);
});

// ---------------------------------------------------------------------------
// drawFrameBuffer — the composite
// ---------------------------------------------------------------------------

test('an overlay replaces only its own span and leaves both flanks intact', () => {
  // The overlay is exactly as wide as it is — it does not pad itself out to the base.
  // Both flanks must survive verbatim: this is the assertion that a whole-row
  // replacement would fail, which is the bug the layer model exists to fix.
  // 12-char base, 2-cell overlay at column 3 → 3 kept, 2 drawn, 7 kept.
  assert.equal(plain(drawFrameBuffer('AAAAAAAAAAAA', 'XX', 3)), 'AAAXXAAAAAAA');
  assert.equal(plain(drawFrameBuffer('AAAAAAAAAAAA', 'XX', 0)), 'XXAAAAAAAAAA');
  assert.equal(plain(drawFrameBuffer('AAAAAAAAAAAA', 'XX', 10)), 'AAAAAAAAAAXX');
});

test('overlay cells past the end of the base row still land', () => {
  // The card is often wider than a short row; dropping it would silently shrink it.
  assert.equal(plain(drawFrameBuffer('ab', 'XXXX', 1)), 'aXXXX');
});

test('a short overlay leaves the rest of the base row alone', () => {
  // The overlay is only as wide as the card; the rest of the row is not its business.
  assert.equal(plain(drawFrameBuffer('AAAAAAAA', 'BB', 2)), 'AABBAAAA');
});

test('blanks in the overlay show the base through, opaque cells do not', () => {
  // The exact shape of a card row: opaque walls, a transparent inner padding column.
  // destX=1, so base column 0 is outside the card and keeps its own '7'; the BLANK at
  // overlay index 1 sits over base column 2 and lets that '7' through; `t` and `i` are
  // opaque and win; the closing wall is opaque too.
  const overlay = [cell('│'), BLANK, cell('t'), cell('i'), cell('│')];
  const out = drawFrameBuffer('77777777', overlay, 1);
  assert.equal(plain(out), '7│7ti│77', 'the blank column shows the 7 underneath');
});

test('a base row is never mutated between composites', () => {
  // The picker composites several rows through this; sharing one array between them
  // would make row 2's card bleed into row 1's.
  const base = 'AAAAAAAA';
  drawFrameBuffer(base, 'XXXX', 0);
  assert.equal(base, 'AAAAAAAA');
});
