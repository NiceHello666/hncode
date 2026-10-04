// An empty reasoning block: not displayed, but its STATE is kept.
//
// Why this matters: a thinking block is finalised when a tool call starts, and the
// next `think` event opens a NEW block. That new block can be empty — the model
// emitted a think event with no text, or the protocol sent a delta frame with none.
// Two things must both hold:
//
//   * the empty block draws NOTHING (a bare `●` reads as a rendering bug);
//   * the block stays in `state.chat`, so a later `think` event APPENDS to it and its
//     content appears in full.
//
// The second is the one a naive "delete empty blocks" fix would break, so it is
// asserted directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFrame, makeState, makeThinkingLineForTest } from '../src/tui.js';

const cfg = () => ({ model: 'p/m', raw: { providers: {}, models: { 'p/m': {} } }, maxContextTokens: 100000 });
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const at = (n) => new Date(2026, 0, 1, 0, 0, n);

test('an empty reasoning block renders no rows', () => {
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  const msg = { role: 'thinking', text: '', pending: false };
  assert.deepEqual(makeThinkingLineForTest(state, msg), [], 'nothing drawn');
});

test('a whitespace-only reasoning block renders no rows either', () => {
  // A model that emits only newlines produced a `●` row with nothing after it.
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  for (const text of ['\n', '   ', '\n\n\n', ' \n ']) {
    assert.deepEqual(makeThinkingLineForTest(state, { role: 'thinking', text, pending: false }), [],
      `text ${JSON.stringify(text)}`);
  }
});

test('a PENDING empty block draws nothing, not a lone spinner', () => {
  // The live form has a "thinking…" label, so an empty pending block still produced a
  // visible row. It should not: there is no thought to show yet.
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  assert.deepEqual(makeThinkingLineForTest(state, { role: 'thinking', text: '', pending: true }), []);
});

test('a block with content renders exactly as before', () => {
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  const rows = makeThinkingLineForTest(state, { role: 'thinking', text: 'a real thought', pending: false });
  assert.ok(rows.length >= 1);
  assert.match(plain(rows[0].text), /a real thought/);
  assert.match(rows[0].ind, /●/, 'the marker is on the first line');
});

test('the empty block STAYS in the transcript, so later text can land in it', () => {
  // The state-preservation contract. Dropping the message would mean the next `think`
  // opens a second block and the transcript gains a spurious empty entry — and the
  // row cache keys on the message, so removing one mid-stream would invalidate the
  // layout of everything after it.
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  state.chat = [
    { role: 'user', text: 'hi' },
    { role: 'thinking', text: '', pending: true },
  ];
  const before = state.chat.length;
  composeFrame(state, 60, 20);
  assert.equal(state.chat.length, before, 'the render pass did not remove the block');
  assert.equal(state.chat[1].role, 'thinking');

  // Now it receives text, as the next `think` event would give it.
  state.chat[1].text = 'now there is something to say';
  const frame = composeFrame(state, 60, 20);
  const shown = frame.lines.map(plain).join('\n');
  assert.match(shown, /now there is something to say/, 'the block appears once it has content');
});

test('an empty block takes no rows in the frame', () => {
  // Its `msgLen` must be 0 so the scroll maths does not reserve space for a row that
  // is never drawn — otherwise the viewport drifts by one row per empty block.
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  state.tip = '';
  state.chat = [{ role: 'user', text: 'hi' }];
  const withNone = composeFrame(state, 60, 24).lines.map(plain).join('\n');
  state.chat.push({ role: 'thinking', text: '', pending: false });
  const withEmpty = composeFrame(state, 60, 24).lines.map(plain).join('\n');
  assert.equal(withEmpty, withNone, 'an empty block changes nothing on screen');
});

test('a tool boundary leaves an empty block invisible without losing it', () => {
  // The sequence the user described: think, call a tool (which finalises the block),
  // then think again with nothing to say. The second block must not be drawn, and it
  // must still be the block a THIRD think event appends to.
  const state = makeState({ cfg: cfg(), session: { messages: [] }, opts: {} });
  state.tip = '';
  state.chat = [
    { role: 'user', text: 'do it' },
    { role: 'thinking', text: 'first I should look', pending: false },   // finalised by the tool
    { role: 'tool', toolName: 'Read', text: 'file contents', pending: false },
    { role: 'thinking', text: '', pending: true },                       // the empty one
  ];
  const frame = composeFrame(state, 64, 24);
  const shown = frame.lines.map(plain).join('\n');
  assert.match(shown, /first I should look/, 'the earlier reasoning is still shown');
  assert.ok(!/●\s*$/m.test(shown), 'no bare marker row');
  // It is still the last message, which is what `appendThinking` appends to.
  assert.equal(state.chat.at(-1).role, 'thinking');
  assert.equal(state.chat.at(-1).pending, true);
});
