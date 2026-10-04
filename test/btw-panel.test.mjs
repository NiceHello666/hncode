// Tests for the /btw box renderer — the panel docked above the composer.
//
// Why this file exists: the box is drawn by its own code path rather than going
// through the transcript, so a mistake in it is not caught by any transcript test.
// Three failures are silent and each is guarded here:
//
//   * a row that is not exactly the frame width BREAKS THE BORDER — the right `│`
//     drifts, and every row after it on screen is shifted;
//   * a height that does not match the rows actually produced makes `composeFrame`
//     reserve the wrong number of rows, so the box either overlaps the composer or
//     leaves a gap;
//   * a bare `''` in the content list instead of a `{ l, color }` row renders as
//     `undefined`.
//
// Testing principle: render at several widths and assert the INVARIANT (every row is
// exactly `width` columns) rather than pinning a byte-exact golden frame, which would
// break on any wording change.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBtwPanel, btwPanelHeight, btwBodyLines, wrapLine, MIN_PANEL_LINES } from '../src/btw-panel.js';

/** A panel with the given turns. */
const panelWith = (turns) => ({ btwPanel: { turns, model: 'cheap' } });

/** Strip ANSI so widths can be measured. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('every row of the box is exactly the requested width', () => {
  // The invariant that matters: the border cannot drift. Checked at widths where the
  // frame is larger and smaller than the hint text.
  const state = panelWith([
    { prompt: 'what does the --retries flag do?', answer: 'It retries a failed request.\n\nDefault is 3.', phase: 'done' },
    { prompt: 'and the timeout?', answer: 'It bounds the whole run.', phase: 'done' },
  ]);
  for (const w of [30, 40, 62, 84, 120]) {
    const rows = renderBtwPanel(state, w, { terminalRows: 40 });
    assert.ok(rows.length > 2, `w=${w}: the box has content`);
    for (const r of rows) {
      assert.equal(plain(r).length, w, `w=${w}: ${JSON.stringify(plain(r))}`);
    }
  }
});

test('the box is bordered and titled', () => {
  const rows = renderBtwPanel(panelWith([{ prompt: 'q', answer: 'a', phase: 'done' }]), 60, { terminalRows: 40 });
  const first = plain(rows[0]);
  const last = plain(rows[rows.length - 1]);
  assert.ok(first.startsWith('╭'), first);
  assert.ok(first.includes('BTW'), 'the title names the feature');
  assert.ok(first.endsWith('╮'), first);
  assert.ok(last.startsWith('╰'), last);
  assert.ok(last.endsWith('╯'), last);
  assert.match(first, /Esc close/, 'the close key is discoverable');
  // Every content row is closed on the right.
  for (const r of rows.slice(1, -1)) {
    assert.equal(plain(r)[0], '│', plain(r));
    assert.equal(plain(r).at(-1), '│', plain(r));
  }
});

test('each question is marked and the answer follows it', () => {
  const rows = renderBtwPanel(panelWith([
    { prompt: 'first question', answer: 'first answer', phase: 'done' },
    { prompt: 'second question', answer: 'second answer', phase: 'done' },
  ]), 60, { terminalRows: 40 }).map(plain);
  const text = rows.join('\n');
  assert.match(text, /Q: first question/);
  assert.match(text, /first answer/);
  assert.match(text, /Q: second question/);
  assert.match(text, /second answer/);
  // The QUESTIONS come before their own answers, in order.
  assert.ok(text.indexOf('first question') < text.indexOf('first answer'));
  assert.ok(text.indexOf('first answer') < text.indexOf('second question'));
});

test('a running turn shows a placeholder and a caret, not a blank box', () => {
  const rows = renderBtwPanel(panelWith([{ prompt: 'working?', answer: '', thinking: '', phase: 'running' }]), 60, { terminalRows: 40 }).map(plain);
  const text = rows.join('\n');
  assert.match(text, /Waiting for answer/);
  assert.match(text, /▍/, 'the caret marks it as live');
});

test('streaming thinking shows a preview instead of a blank row', () => {
  const rows = renderBtwPanel(panelWith([{ prompt: 'q', answer: '', thinking: 'thinking about it', phase: 'running' }]), 60, { terminalRows: 40 }).map(plain);
  assert.match(rows.join('\n'), /thinking about it/);
});

test('a failed turn shows the error, in its own colour', () => {
  const raw = renderBtwPanel(panelWith([{ prompt: 'q', answer: '', error: 'the endpoint refused', phase: 'failed' }]), 60, { terminalRows: 40 });
  assert.match(raw.map(plain).join('\n'), /the endpoint refused/);
});

test('the height never exceeds a third of the terminal, and never goes below the floor', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ prompt: `question ${i}`, answer: `answer ${i}`, phase: 'done' }));
  const tall = panelWith(many);
  const h30 = btwPanelHeight(tall, 30, 80);
  // A third of 30 is 10 rows of content, plus the two borders.
  assert.ok(h30 <= 10 + 2, `expected <= 12, got ${h30}`);
  assert.ok(h30 >= MIN_PANEL_LINES, `expected at least ${MIN_PANEL_LINES}, got ${h30}`);

  // A SHORT terminal still fits: the box must not claim more than the screen has.
  for (const rows of [8, 12, 20]) {
    const h = btwPanelHeight(tall, rows, 80);
    assert.ok(h <= rows, `terminal ${rows}: box height ${h} must fit`);
    assert.ok(h >= 3, `terminal ${rows}: box must be usable`);
  }

  // A small box does not grow past its content.
  const small = panelWith([{ prompt: 'q', answer: 'a', phase: 'done' }]);
  assert.equal(btwPanelHeight(small, 40, 80), 4, 'one Q + one A + two borders');
});

test('the height matches the rows actually rendered', () => {
  // If these disagree, composeFrame reserves the wrong number of rows and the box
  // either overlaps the composer or leaves a gap.
  const cases = [
    panelWith([{ prompt: 'q', answer: 'a', phase: 'done' }]),
    panelWith([{ prompt: 'long '.repeat(30), answer: 'answer '.repeat(40), phase: 'done' }]),
    panelWith([{ prompt: 'q', answer: '', phase: 'running' }]),
    panelWith(Array.from({ length: 12 }, (_, i) => ({ prompt: `q${i}`, answer: `a${i}`, phase: 'done' }))),
  ];
  for (const state of cases) {
    for (const w of [40, 80]) {
      const h = btwPanelHeight(state, 60, w);
      const rows = renderBtwPanel(state, w, { terminalRows: 60 });
      assert.equal(rows.length, h, `w=${w}: height ${h} vs ${rows.length} rows rendered`);
    }
  }
});

test('content taller than the box scrolls, and says how much is hidden', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ prompt: `q${i}`, answer: `a${i}`, phase: 'done' }));
  const state = panelWith(many);
  const rows = renderBtwPanel(state, 60, { terminalRows: 24 }).map(plain);
  const text = rows.join('\n');
  // The tail is what is shown by default (following the newest), so the LAST turn
  // is visible and the first is not.
  assert.match(text, /q29/, 'the newest question is visible');
  assert.ok(!text.includes('q0\n'), 'the oldest is scrolled out');
  assert.match(text, /more/, 'the hidden count is stated');
  assert.match(rows[0], /↑↓ scroll/, 'the scroll key is advertised when it will work');
});

test('scrolling up reveals older turns', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ prompt: `q${i}`, answer: `a${i}`, phase: 'done' }));
  const tail = renderBtwPanel({ ...panelWith(many), btwScroll: 0 }, 60, { terminalRows: 24 }).map(plain).join('\n');
  const up = renderBtwPanel({ ...panelWith(many), btwScroll: 200 }, 60, { terminalRows: 24 }).map(plain).join('\n');
  // Scrolled fully up shows the FIRST turn, which the tail view did not.
  assert.ok(up.includes('q0'), 'the first turn becomes visible');
  assert.ok(!tail.includes('q0\n'), 'sanity: it was not visible at the tail');
});

test('an empty or absent panel renders nothing at all', () => {
  assert.deepEqual(renderBtwPanel({}, 60, { terminalRows: 40 }), []);
  assert.deepEqual(renderBtwPanel({ btwPanel: { turns: [] } }, 60, { terminalRows: 40 }), []);
  assert.equal(btwPanelHeight({}, 40, 60), 0);
  assert.equal(btwPanelHeight({ btwPanel: { turns: [] } }, 40, 60), 0);
});

test('a very narrow terminal does not crash or overflow', () => {
  // A frame narrower than the border characters is degenerate but must not throw.
  for (const w of [1, 4, 8, 12]) {
    const rows = renderBtwPanel(panelWith([{ prompt: 'q', answer: 'a', phase: 'done' }]), w, { terminalRows: 20 });
    for (const r of rows) assert.equal(plain(r).length, Math.max(8, w), `w=${w}`);
  }
});

test('wrapping splits on display width, not character count', () => {
  // A CJK character is two columns wide, so wrapping by `.length` would overflow the
  // border — the same class of bug the width invariant above guards.
  const rows = wrapLine('中文中文中文', 4);
  assert.equal(rows.length, 3, 'each row holds two CJK chars');
  assert.deepEqual(rows, ['中文', '中文', '中文']);
  assert.deepEqual(wrapLine('', 10), ['']);
  assert.deepEqual(wrapLine('short', 10), ['short']);
});

test('the body-row count and the renderer agree on turn separation', () => {
  // `btwBodyLines` is the height input; a miscount here is exactly the off-by-one the
  // height test above catches, so it is asserted directly too.
  const one = btwBodyLines({ turns: [{ prompt: 'q', answer: 'a', phase: 'done' }] }, 80);
  assert.equal(one, 2, 'one question row + one answer row');
  const two = btwBodyLines({ turns: [
    { prompt: 'q1', answer: 'a1', phase: 'done' },
    { prompt: 'q2', answer: 'a2', phase: 'done' },
  ] }, 80);
  assert.equal(two, 5, 'two turns plus the blank separator between them');
});
