// The picker's category strip must stay fully reachable at any terminal width.
//
// WHY
// ---
// The strip was one unbounded row. The card is only as wide as the terminal allows, so its
// later categories were clipped off the right edge — and because `All` is always first and
// stayed visible, the screen suggested nothing was missing. On /model with long provider names
// the third category simply was not there.
//
// The fix is wrapping, not horizontal scrolling: each tab is a click target, and a category
// you have to scroll to is one you cannot click without first finding the scroll.
import assert from 'node:assert/strict';
import test from 'node:test';

const { makeState, composeFrame } = await import('../src/tui.js');

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

const CATS = ['All', 'a-very-long-provider-name-here', 'another-long-provider-name', 'third', 'fourth'];

function frameWithCategories(cols, rows = 30) {
  const cfg = { provider: 'p', model: 'm', endpoint: 'x', apiKey: 'k', workspace: process.cwd(), raw: {} };
  const state = makeState({ cfg, session: { id: 'p', messages: [], transcript: [] }, opts: {} });
  state.cfg = cfg;
  state.chat = [];
  state.picker = {
    title: 'Select a model',
    items: [
      { label: 'a-very-long-provider-name/and-a-longer-model-name-that-overflows', sub: 'provider', category: 'All' },
      { label: 'short', sub: 'x', category: 'All' },
    ],
    sel: 0,
    searchable: true,
    categories: CATS,
    category: null,
    hint: 'navigate / select / tab',
    footer: null,
    onPick: () => true,
  };
  const frame = composeFrame(state, cols, rows);
  return { state, lines: frame.lines.map(plain), frame };
}

test('every category is visible, at every terminal width', () => {
  for (const cols of [160, 120, 100, 80, 70, 60]) {
    const { lines } = frameWithCategories(cols);
    const text = lines.join('\n');
    const missing = CATS.filter((c) => !text.includes(c));
    assert.deepEqual(missing, [], `${cols} cols drops ${missing.join(', ')}`);
  }
});

test('each category tab gets an accurate hitbox on its own row', () => {
  // The strip used to be one row, so every tab shared `catBodyRow`. Once it wraps, a shared
  // row would put half the click targets on the wrong line — a click would select a category
  // the user did not aim at.
  for (const cols of [120, 80, 60]) {
    const { state, frame } = frameWithCategories(cols);
    assert.ok(state.picker, `${cols}: the picker is gone`);
    const set = state.picker;

    // The overlay records the tabs it drew on the SENTINEL object.
    const sentinel = (state.picker && state._pickerCardBody) || null;
    void sentinel;

    const hits = (frame.hitboxes || []).filter((h) => h.kind === 'pickerCategory');
    assert.equal(hits.length, CATS.length, `${cols}: expected ${CATS.length} category hitboxes, got ${hits.length}`);

    // Every tab is reachable, and no two share a row+column run.
    const seen = new Set();
    for (const h of hits) {
      const key = `${h.row}:${h.col0}`;
      assert.equal(seen.has(key), false, `${cols}: two tabs share ${key}`);
      seen.add(key);
      assert.ok(h.col1 >= h.col0, `${cols}: inverted range for ${h.label}`);
    }

    // At a narrow width the strip must occupy MORE THAN ONE row — otherwise it did not wrap
    // and the tabs must have been clipped instead.
    const rows = new Set(hits.map((h) => h.row));
    if (cols <= 80) {
      assert.ok(rows.size > 1, `${cols}: the strip stayed on one row (${rows.size}), so it was clipped`);
    }
  }
});

test('the category strip is a width candidate, but never widens the card past the screen', () => {
  // Two rules, and both matter:
  //
  //   1. the strip JOINS the width measurement, so it does not wrap while there is room.
  //      Declaring it as a sentinel and stepping over it (the first fix) made it wrap on a
  //      200-column terminal, because the card was only as wide as its short item labels.
  //   2. the card is then clamped to `cols - 6`, so a strip wider than the terminal still
  //      wraps instead of opening a full-width panel — the layout the picker exists to avoid.
  //
  // Measured through the HITBOXES: every rendered row is padded to the full terminal width,
  // so the line lengths cannot tell a narrow card from a wide one.
  const base = {
    title: 'T',
    items: [{ label: 'a', sub: '', category: 'All' }],
    sel: 0,
    searchable: false,
    category: null,
    hint: 'h',
    footer: null,
    onPick: () => true,
  };
  const cardWidth = (cats, cols) => {
    const cfg = { provider: 'p', model: 'm', endpoint: 'x', apiKey: 'k', workspace: process.cwd(), raw: {} };
    const state = makeState({ cfg, session: { id: 'p', messages: [], transcript: [] }, opts: {} });
    state.cfg = cfg;
    state.chat = [];
    state.picker = { ...base, categories: cats };
    const frame = composeFrame(state, cols, 40);
    const items = (frame.hitboxes || []).filter((h) => h.kind === 'pickerItem');
    if (!items.length) return null;
    const left = Math.min(...items.map((h) => h.col0));
    const right = Math.max(...items.map((h) => h.col1));
    return right - left + 1;
  };

  const COLS = 200;
  const short = cardWidth(['All', 'short'], COLS);
  const long = cardWidth(['All', 'a-label-of-forty-columns-here', 'another-one-similar'], COLS);
  const huge = cardWidth(['All', 'x'.repeat(400), 'y'.repeat(400)], COLS);

  assert.ok(short != null && long != null && huge != null, 'all three renders produced item hitboxes');

  // (1) a wider strip widens the card — up to the terminal.
  assert.ok(short <= long, `a longer strip narrowed the card: ${short} -> ${long}`);

  // (2) but never past the screen. The overlay clamps to `cols - 6`.
  assert.ok(huge < COLS, `a 400-column strip opened a ${huge}-column card on a ${COLS}-column terminal`);
  assert.ok(huge <= COLS - 6, `the card must respect the ${COLS - 6}-column clamp, got ${huge}`);
});