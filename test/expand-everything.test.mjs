// Ctrl+O must reveal EVERY collapsed body in the transcript.
//
// WHY THIS FILE EXISTS
// --------------------
// Every collapsible block in `messageLines` keeps a preview and a "… ctrl+o to expand" hint — except one
// did not honour the key at all. The Write block hard-coded `MAX = 20` and never read `expanded`, so a
// 500-line file could only ever show its first twenty lines: the summary said "… 480 more lines" and
// there was no key that would reveal them. The hint pointed at a gesture that did nothing for that block.
//
// The test is written as a TABLE over block kinds and asserts one property — expanded renders strictly
// more rows than collapsed — because that is the property that was missing. A per-block test written only
// for the blocks that already worked would have passed while Write stayed broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderChatLines } from '../src/tui.js';

const W = 60;
// 300 lines: large enough to hit ANY numeric ceiling a block still carries. At 80 lines a 100- or
// 200-line cap would never be reached, and a mutation restoring one would pass unnoticed.
const BODY = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');

/** Rows a single message occupies, folded or expanded. */
const rows = (msg, expanded) => renderChatLines({
  chat: [msg], cwd: 'D:/x', cfg: { shimmerEdge: 'cosine' },
  _forceFullRender: true, expanded, spin: 0,
}, W).length;

// ---------------------------------------------------------------------------
// every block
// ---------------------------------------------------------------------------

test('expanding reveals more of every collapsible body', () => {
  const cases = [
    ['Write file content', {
      role: 'tool', toolName: 'Write', toolArgs: { file_path: 'a.js' },
      streamContent: BODY, _streamLineCount: 300,
    }],
    ['a tool result', { role: 'tool_result', toolName: 'Bash', text: BODY }],
    ['reasoning', { role: 'thinking', text: BODY, pending: false }],
    // A background task card is its own role (`bg_task`); a `tool` row without it is a different,
    // non-collapsible shape and would make this case assert nothing.
    ['a background task card', {
      role: 'bg_task',
      card: { phase: 'completed', headline: 'background task finished' },
      text: BODY,
    }],
  ];
  for (const [label, msg] of cases) {
    const folded = rows(msg, false);
    const open = rows(msg, true);
    assert.ok(open > folded,
      `${label}: expanded must show MORE than collapsed (folded ${folded}, expanded ${open})`);
    // AND it must be the WHOLE body, not merely more of it. `open > folded` alone passes at a 200-line
    // ceiling on a 300-line body, which is exactly the kind of silent cap this file exists to catch.
    assert.ok(open >= BODY.split('\n').length,
      `${label}: expanded shows the whole body (${open} rows for ${BODY.split('\n').length} lines)`);
  }
});

test('a Write preview is a preview, not the whole file', () => {
  // The folded side has to actually fold: a ten-row cap on five rows of content would pass the test
  // above while showing everything by default.
  const msg = {
    role: 'tool', toolName: 'Write', toolArgs: { file_path: 'a.js' },
    streamContent: BODY, _streamLineCount: 300,
  };
  assert.ok(rows(msg, false) < 40, 'collapsed shows a small preview');
  assert.ok(rows(msg, true) > 290, 'expanded shows essentially the whole file');
});

test('an expanded block says nothing about pressing Ctrl+O', () => {
  // The hint is only meaningful while collapsed. Leaving it up tells the user to press a key that
  // changes nothing — which is how the Write block's silent cap stayed invisible.
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const render = (msg, expanded) => renderChatLines({
    chat: [msg], cwd: 'D:/x', cfg: { shimmerEdge: 'cosine' },
    _forceFullRender: true, expanded, spin: 0,
  }, W).map(strip).join('\n');

  const write = {
    role: 'tool', toolName: 'Write', toolArgs: { file_path: 'a.js' },
    streamContent: BODY, _streamLineCount: 300,
  };
  assert.match(render(write, false), /ctrl\+o to expand/, 'folded, the hint is there');
  assert.doesNotMatch(render(write, true), /more lines/, 'expanded, nothing is left to expand');

  const result = { role: 'tool_result', toolName: 'Bash', text: BODY };
  assert.match(render(result, false), /ctrl\+o to expand/);
  assert.doesNotMatch(render(result, true), /more lines/);
});

test('no block keeps a fixed ceiling once expanded', () => {
  // A body long enough to hit any numeric cap a block might still carry. `expanded ? 200 : 6` was the
  // shape of one such ceiling: the block grew but stopped, and the hint told the user to press Ctrl+O.
  const long = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
  const msg = { role: 'tool_result', toolName: 'Bash', text: long };
  assert.ok(rows(msg, true) > 290, 'an expanded result is not silently truncated');
});
