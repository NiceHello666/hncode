// Tests for pointer behaviour around an open overlay (a picker / context menu).
//
// Why this file exists: the overlay is painted OVER the frame, but the hitboxes were
// registered while the transcript / composer / status line were drawn, so controls
// UNDER the card stayed live. Two symptoms, both invisible to a layout test:
//
//   * a pointer inside the card at a row that lines up with the composer or the status
//     line resolved to THAT control, so the hover tint was applied to text behind the
//     popup and showed through it (the popup is opaque, so this reads as a glitch);
//   * a CLICK there ran the control behind the card — clicking a menu row could place
//     the caret in the composer instead.
//
// Testing principle: assert on the HITBOX SET, since that is what both the click
// dispatch and the hover-tint resolver consult. A rendering test cannot see this: the
// card looks identical whether or not the controls below it are still live.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, composeFrame, resolveHoverHit } from '../src/tui.js';

const cfg = () => ({
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
  raw: { providers: {}, models: { 'p/m': {} } },
});

function frameWith(extra, cols = 80, rows = 24) {
  const st = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  st.tip = '';
  st.chat = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'there' }];
  Object.assign(st, extra);
  return { state: st, frame: composeFrame(st, cols, rows) };
}

const kindsOf = (frame) => (frame.hitboxes || []).map((h) => h.kind);

test('with NO overlay, the composer and status line are live', () => {
  // The baseline: these ARE targets when nothing covers them.
  const { frame } = frameWith({});
  const kinds = kindsOf(frame);
  assert.ok(kinds.includes('composerRow'), 'the composer is a click target');
  assert.ok(kinds.includes('statusMode'), 'the status segments are click targets');
});

test('an open picker leaves ONLY its own targets live', () => {
  const { frame } = frameWith({
    picker: { title: 'Pick', items: [{ label: 'a' }, { label: 'b' }], sel: 0, searchable: true },
  });
  const kinds = kindsOf(frame);
  assert.ok(kinds.includes('pickerBody'), 'the card itself is a target');
  assert.ok(kinds.includes('pickerItem'), 'the rows are targets');
  // The controls UNDER the card must be gone: this is the regression.
  assert.ok(!kinds.includes('composerRow'), 'the composer under the card is not a target');
  assert.ok(!kinds.includes('statusMode'), 'the status line under the card is not a target');
  assert.ok(!kinds.includes('statusModel'), 'nor the model segment');
});

test('an open context menu leaves only its own targets live', () => {
  // The context menu is a picker with an anchor, so it goes through the same path.
  const { frame } = frameWith({
    picker: {
      title: 'Actions',
      items: [{ label: 'Copy', action: 'copy' }, { label: 'Paste', action: 'paste' }],
      sel: 0, searchable: false, anchor: { row: 3, col: 5 },
    },
  });
  const kinds = kindsOf(frame);
  assert.ok(kinds.includes('pickerItem'));
  assert.ok(!kinds.includes('composerRow'));
  assert.ok(!kinds.includes('statusMode'));
});

test('a hover inside the card resolves to the card, never to the text underneath', () => {
  const { state, frame } = frameWith({
    picker: { title: 'Pick', items: [{ label: 'a' }, { label: 'b' }], sel: 0, searchable: true },
  });
  // Point at the row where the COMPOSER would be without an overlay. The picker card
  // is anchored in the middle, so pick a row the card covers and check the resolution
  // is a card control, not the composer.
  const card = (frame.hitboxes || []).find((h) => h.kind === 'pickerItem');
  assert.ok(card, 'the card has an item row');
  state._lastMouse = { row: card.row + 1, col: card.col0 + 1 };   // wire coords are 1-based
  const hv = resolveHoverHit(state, frame.hitboxes);
  assert.ok(hv, 'a card row resolves');
  const hit = (frame.hitboxes || []).find((h) => h.row === hv.row && h.col0 === hv.col0);
  assert.ok(hit && hit.kind.startsWith('picker'), `resolved to ${hit && hit.kind}, expected a picker control`);
});

test('a pointer OUTSIDE the card resolves to nothing, so no tint is applied', () => {
  // The overlay is modal: a hover that misses the card must not light up whatever is
  // behind it. With the earlier version the composer row was still a hitbox, so a
  // pointer just past the card edge tinted the prompt text.
  const { state, frame } = frameWith({
    picker: { title: 'Pick', items: [{ label: 'a' }, { label: 'b' }], sel: 0, searchable: true },
  });
  // Row 0 (the very top) is outside any card.
  state._lastMouse = { row: 1, col: 1 };
  assert.equal(resolveHoverHit(state, frame.hitboxes), null, 'nothing to hover outside the card');
});

test('the card still renders and keeps its own rows after the filter', () => {
  // The filter must not remove the card's rows: a regression here would make the menu
  // unclickable, which is worse than the bug being fixed.
  const { frame } = frameWith({
    picker: { title: 'Pick', items: [{ label: 'first' }, { label: 'second' }], sel: 0, searchable: true },
  });
  const items = (frame.hitboxes || []).filter((h) => h.kind === 'pickerItem');
  assert.equal(items.length, 2, 'both rows are targets');
  // Each item hit is inside its card row.
  const body = (frame.hitboxes || []).filter((h) => h.kind === 'pickerBody');
  for (const it of items) {
    assert.ok(body.some((b) => b.row === it.row), `item on row ${it.row} is inside the card`);
  }
  const text = frame.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(text, /first/);
  assert.match(text, /second/);
});
