// Tests for the scrollbar geometry and the command registry.
//
// Both are pure and easy to get subtly wrong in a way that only shows up visually:
// an off-by-one in the thumb leaves the last row unreachable, and a command-table
// mistake makes a shortcut silently dead. So the tests assert the INVARIANTS a
// caller depends on (thumb stays inside the track, the ends land exactly) rather
// than one hard-coded row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scrollbarGeometry, scrollbarGlyph, composeFrame, makeState } from '../src/tui.js';
import { parseCells } from '../src/cell-buffer.js';
import { C, TRUECOLOR } from '../src/colors.js';

// ---------------------------------------------------------------------------
// scrollbarGeometry
// ---------------------------------------------------------------------------

test('the thumb never leaves the track', () => {
  // The whole point of the geometry: any scroll position maps to a thumb that is
  // inside [0, bodyH). An overhang would draw past the last row.
  for (const total of [1, 5, 10, 100, 1000]) {
    for (const bodyH of [1, 10, 20]) {
      for (const scroll of [0, 1, 50, 999, 100000]) {
        const g = scrollbarGeometry({ total, bodyH, scroll });
        assert.ok(g.thumbStart >= 0, `thumbStart >= 0 (${total}/${bodyH}/${scroll})`);
        assert.ok(g.thumbLen >= 1, `thumbLen >= 1 (${total}/${bodyH}/${scroll})`);
        assert.ok(g.thumbStart + g.thumbLen <= bodyH,
          `thumb must fit: ${g.thumbStart}+${g.thumbLen} <= ${bodyH} (${total}/${bodyH}/${scroll})`);
      }
    }
  }
});

test('the thumb is at the bottom when pinned there and at the top when scrolled fully', () => {
  const bodyH = 10;
  const bottom = scrollbarGeometry({ total: 100, bodyH, scroll: 0 });
  assert.equal(bottom.thumbStart + bottom.thumbLen, bodyH, 'pinned-to-tail thumb must touch the last row');
  const top = scrollbarGeometry({ total: 100, bodyH, scroll: 90 });   // maxScroll
  assert.equal(top.thumbStart, 0, 'fully scrolled thumb must touch the first row');
});

test('content that fits fills the whole track', () => {
  // Nothing to scroll: the thumb IS the track, so the bar reads as "all visible".
  const g = scrollbarGeometry({ total: 5, bodyH: 10, scroll: 0 });
  assert.equal(g.thumbStart, 0);
  assert.equal(g.thumbLen, 10);
  assert.equal(g.maxScroll, 0);
});

test('the virtual grid is exactly twice the row count (half-row resolution)', () => {
  // The 2x grid is what lets the thumb land on a half-row; if the ratio drifts the
  // glyph rule stops matching the geometry.
  for (const bodyH of [1, 7, 20]) {
    const g = scrollbarGeometry({ total: 500, bodyH, scroll: 0 });
    assert.equal(g.virtualTrack, bodyH * 2);
    assert.ok(g.virtualThumbSize >= 1);
    assert.ok(g.virtualThumbStart + g.virtualThumbSize <= g.virtualTrack);
  }
});

test('scroll is clamped, not trusted', () => {
  // A caller passing a stale or wild offset must not produce a negative or
  // out-of-range thumb. `scroll` counts rows UP from the tail, so a negative value
  // clamps to 0, which is the BOTTOM (thumbLast), not the top.
  const bodyH = 10;
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: -50 }).thumbStart, bodyH - 1);
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: 0 }).thumbStart, bodyH - 1);
  // A wild positive value clamps to maxScroll, the fully-scrolled (top) position.
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: 1e9 }).thumbStart, 0);
  assert.equal(scrollbarGeometry({ total: 100, bodyH, scroll: NaN }).maxScroll, 90);
});

// ---------------------------------------------------------------------------
// scrollbarGlyph
// ---------------------------------------------------------------------------

test('glyph coverage: full cell is a block, half cell is a half block, none is blank', () => {
  assert.equal(scrollbarGlyph(null, 0), ' ');
  // The track row of a 1-row thumb at the bottom is blank; the thumb row is full.
  const g = scrollbarGeometry({ total: 100, bodyH: 10, scroll: 0 });
  assert.equal(scrollbarGlyph(g, 0), ' ');
  assert.equal(scrollbarGlyph(g, 9), '█');
  // A thumb one virtual unit wide (half a cell) draws a half block, which is what
  // makes a short scrollbar able to sit between rows.
  const half = scrollbarGeometry({ total: 1000, bodyH: 20, scroll: 500 });
  const col = Array.from({ length: 20 }, (_, i) => scrollbarGlyph(half, i)).join('');
  assert.ok(col.includes('▄') || col.includes('▀'), 'a half-row thumb must use a half block');
});

test('the half block follows where the coverage starts inside the cell', () => {
  // Rule (from scrollbarGlyph): coverage that begins at the cell's first virtual
  // unit is the TOP half -> `▀`; coverage that begins at the second unit is the
  // BOTTOM half -> `▄`. Getting these swapped makes the thumb look like it jumps.
  const base = { virtualTrack: 20, bodyH: 10, total: 100, maxScroll: 90 };
  // Starts at virtual 0 of row 0 -> upper half.
  assert.equal(scrollbarGlyph({ ...base, virtualThumbStart: 0, virtualThumbSize: 1 }, 0), '▀');
  // Starts at virtual 1 of row 0 (the cell's second unit) -> lower half.
  assert.equal(scrollbarGlyph({ ...base, virtualThumbStart: 1, virtualThumbSize: 1 }, 0), '▄');
  // A two-unit coverage is a full block regardless of where it starts.
  assert.equal(scrollbarGlyph({ ...base, virtualThumbStart: 0, virtualThumbSize: 2 }, 0), '█');
  assert.equal(scrollbarGlyph({ ...base, virtualThumbStart: 4, virtualThumbSize: 2 }, 2), '█');
});

test('a full-cell thumb yields no half blocks anywhere', () => {
  const g = scrollbarGeometry({ total: 100, bodyH: 10, scroll: 0 });
  const col = Array.from({ length: 10 }, (_, i) => scrollbarGlyph(g, i)).join('');
  assert.ok(!col.includes('▀') && !col.includes('▄'), 'a whole-row thumb must use only full/blank cells');
});

// ---------------------------------------------------------------------------
// how the scrollbar CELL is painted
// ---------------------------------------------------------------------------
// The glyph geometry above is only half the picture: a `▀`/`▄` exposes one half of its
// cell to the BACKGROUND, so the colours decide whether a half-covered row reads as a
// half block or as a second full square. Two regressions are pinned here, both of which
// only show up on a real terminal:
//
//   * foreground AND background were both set to the thumb colour, so the exposed half
//     kept the thumb colour and the row looked like two squares instead of one and a
//     half;
//   * `dimRange` implements the modal backdrop by adding faint (`ESC[2m`), which fades
//     the FOREGROUND only — so with the thumb colour in the background, opening a picker
//     left the thumb's background half at full brightness while the whole screen receded.

test('a half-covered thumb row exposes the TRACK, not more thumb', () => {
  // A `▀`/`▄` fills only HALF its cell: the other half shows the cell's BACKGROUND. So
  // the background must be the track colour, or the exposed half keeps the thumb colour
  // and the row reads as two squares instead of one and a half. The assertion is on the
  // RENDERED cell rather than on the palette, because the bug was in how the cell was
  // painted — the palette always had both colours.
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
    maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
    raw: { providers: {}, models: { 'p/m': {} } },
  };
  const thumbBgs = [C.scrollThumbBg, C.scrollThumbHoverBg, C.scrollThumbActiveBg];
  const halves = [];
  for (const total of [60, 120, 300, 900]) {
    const st = makeState({ cfg, session: { messages: [] }, opts: {} });
    st.tip = '';
    st.chat = Array.from({ length: total }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `line ${i}` }));
    const frame = composeFrame(st, 80, 24);
    frame.lines.forEach((line, r) => {
      const last = parseCells(line)[79];
      // The scrollbar is the LAST column of every body row, and its glyph is one of the
      // three block forms. Identify the half rows by glyph, not by their colours — the
      // colours are exactly what is under test.
      if (last && (last.ch === '▀' || last.ch === '▄')) halves.push({ total, r, ch: last.ch, style: last.style });
    });
  }
  assert.ok(halves.length > 0, 'the sweep drew at least one half-covered thumb row');
  for (const h of halves) {
    for (const bg of thumbBgs) {
      assert.ok(!h.style.includes(bg),
        `total=${h.total} row ${h.r}: a ${JSON.stringify(h.ch)} row paints the thumb as its BACKGROUND, ` +
        'so the exposed half is thumb-coloured and the row looks like two squares');
    }
  }
});

test('an open overlay dims a filled row, not just its glyphs', () => {
  // `ESC[2m` — what a modal backdrop's "faint" is — affects the FOREGROUND only. A cell
  // painted with a BACKGROUND therefore used to stay at full brightness while every character
  // around it receded. The context bar is the clearest case: it is read as a row of colour
  // with almost no text, so it was the one part of the screen that ignored the dim
  // completely.
  //
  // The bar's own fills are used as the probe rather than a scrollbar: the picker is painted
  // AFTER the scrollbar and its gutter covers that column outright, so the frame cannot
  // currently answer "is the scrollbar dimmed under a picker" at all, and a test asking it
  // finds no bar and reports what looks like a dimming failure.
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
    maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
    raw: { providers: {}, models: { 'p/m': {} } },
  };
  const session = {
    id: 's', workspace: '/w', model: 'p/m',
    messages: [
      { role: 'user', content: 'a question with a few words in it' },
      { role: 'assistant', content: 'an answer long enough to occupy part of the window' },
    ],
  };
  const build = (picker) => {
    const st = makeState({ cfg, session, opts: {} });
    st.chat = session.messages.map((m) => ({ ...m, text: m.content }));
    st.rounds = 3; st.steps = 5; st.tokRate = 20;
    st.ctxTokens = 4500; st.ctxMax = 100000; st.ctxPercent = 5;
    st._gitInfo = null; st._costText = '$0.10'; st.tip = 'a tip';
    if (picker) st.picker = { title: 'Actions', items: [{ label: 'Copy' }], sel: 0, searchable: false };
    return composeFrame(st, 100, 30);
  };
  const barFills = [C.ctxSystem, C.ctxPrompt, C.ctxAssistant, C.ctxThinking, C.ctxTools, C.ctxFree];
  // The bar is the second-to-last row of the frame, always — it sits below the composer.
  // Located that way rather than by "the first row containing a bar fill": several other rows
  // carry backgrounds of their own (the composer's box, a panel's surface), so a content
  // search lands on one of those and then asserts about a row that was never the bar.
  const barRowOf = (frame) => frame.lines.length - 2;
  const plain = build(false);
  const plainAt = barRowOf(plain);
  assert.ok(plainAt > 0, 'the frame draws a context bar');
  const plainBar = String(plain.lines[plainAt]);
  // Only the fills this particular transcript actually uses: a segment with nothing in it
  // takes no columns, so requiring every colour would be requiring a picture that is not
  // there. The FREE segment is the one guaranteed to be present in a nearly-empty window.
  const present = barFills.filter((f) => plainBar.includes(f));
  assert.ok(present.length > 0, `the bar carries at least one fill: ${JSON.stringify(plainBar.slice(0, 80))}`);

  // With an overlay open, the bar must be FAINT — every cell carrying the faint — and it
  // must still be a BAR: the fills that separate one segment from the next have to survive.
  //
  // Whether the fill ITSELF is darkened depends on the colour depth, and that is deliberate.
  // At 256 colours the segment blues live in the 6x6x6 cube's lowest two steps, and scaling
  // them toward the page quantises distinct segments onto the same index — measured, five of
  // six fills stay distinct at 0.85x and four at 0.72x. A dimmed bar that has lost two of its
  // five segments is worse than one whose fills are unchanged and whose glyphs are faint, so
  // below truecolor the fill is left alone and only `ESC[2m` is applied.
  const open = build(true);
  const openAt = barRowOf(open);
  assert.ok(openAt > 0, 'the frame still draws a context bar under an overlay');
  const openBar = String(open.lines[openAt]);
  assert.ok(openBar.includes(C.dim), 'the bar is faint');
  for (const f of present) {
    assert.ok(openBar.includes(f),
      `the bar LOST ${JSON.stringify(f)} under an overlay — the segments must stay distinct`);
  }
  if (TRUECOLOR) {
    // With an exact triple available the fill is genuinely pulled toward the page, which is
    // what makes a backdrop recede on a terminal that can express it.
    for (const f of present) {
      assert.ok(!openBar.includes(f),
        `truecolor: the bar still carries ${JSON.stringify(f)} undimmed`);
    }
  }
  // And the bar's own width survives: dimming must not have eaten the readout.
  const plainText = plainBar.replace(/\x1b\[[0-9;]*m/g, '');
  const openText = openBar.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(openText.length, plainText.length, 'the row is still exactly as wide');
  assert.ok(openText.trim(), 'and still shows something');
});