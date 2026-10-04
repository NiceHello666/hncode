// The segmented context bar: allocation, exact width, and the readout's fallback.
//
// WHY THESE ASSERTIONS
// --------------------
// Two things about this bar are easy to get subtly wrong and impossible to eyeball:
//
//   1. The columns must sum to EXACTLY `width`. Rounding each share independently lands
//      one or two columns off, which shows up as a bar that does not reach the right edge
//      — or that wraps onto the next row and corrupts the layout below it.
//   2. The readout is drawn INSIDE the free segment, so its width comes out of the same
//      budget as the fills. When the two disagreed on the threshold, the bar came up a
//      column short at every width.
//
// The strip function below drops every CSI sequence, so a bar's VISIBLE length is what
// gets measured — the same thing the terminal lays out.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBarColumns, renderContextBar, formatReadout, compactTokens, segmentCaption, SEGMENTS,
} from '../src/context-bar.js';
import { contextSegments } from '../src/tui.js';
/** Visible columns: drop every CSI sequence. */

/** Visible columns: drop every CSI sequence. */
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The bar STRING. `renderContextBar` returns `{ text, hits }`; most of these assertions are
 *  about the drawing, so the unwrapping is kept here rather than repeated at each call. */
const barOf = (r) => r.text;

/** A mid-sized breakdown, reused where the exact numbers do not matter. */
const MIXED = { system: 1200, prompt: 3100, assistant: 4400, thinking: 1200, tools: 1800 };

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

test('the columns sum to exactly the width', () => {
  const cases = [
    [1200, 3100, 4400, 1200, 1800, 88300],
    [50000, 30000, 15000, 4000, 1000, 0],
    [1, 1, 1, 1, 1, 5],
    [100, 0, 0, 200, 0, 99700],
    [7, 0, 0, 0, 0, 93],
  ];
  for (const vals of cases) {
    for (const width of [20, 40, 60, 80, 120]) {
      const cols = allocateBarColumns(vals, width);
      assert.equal(cols.reduce((a, b) => a + b, 0), width,
        `${JSON.stringify(vals)} at width ${width} -> ${JSON.stringify(cols)}`);
    }
  }
});

test('a segment too small to round keeps its column', () => {
  // The reason for the minimum-1 pass: thinking at 0.2% rounds to zero columns and
  // disappears, which is exactly the fact someone reads the bar to find out.
  const cols = allocateBarColumns([100, 0, 0, 200, 0, 99700], 80);
  assert.ok(cols[0] >= 1, 'the 100-token system segment is visible');
  assert.ok(cols[3] >= 1, 'and so is the 200-token thinking segment');
  assert.equal(cols[1], 0, 'a genuinely zero segment takes nothing');
});

test('a full window leaves nothing for the free segment', () => {
  const cols = allocateBarColumns([50000, 30000, 15000, 4000, 1000, 0], 80);
  assert.equal(cols[5], 0);
  assert.equal(cols.reduce((a, b) => a + b, 0), 80);
});

test('more used segments than columns degrades instead of overflowing', () => {
  // Five segments plus a free segment cannot each get a column on a 3-column bar.
  const cols = allocateBarColumns([1000, 1000, 1000, 1000, 1000, 1], 3);
  assert.equal(cols.reduce((a, b) => a + b, 0), 3, 'still exactly the width');
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('the bar occupies exactly the width asked for, at every width', () => {
  for (const w of [6, 12, 20, 30, 40, 60, 80, 100, 120, 200]) {
    const bar = barOf(renderContextBar(MIXED, 11700, 100000, w));
    assert.equal(visible(bar).length, w, `width ${w} -> ${JSON.stringify(visible(bar))}`);
  }
});

test('the bar carries all five segment fills plus the free one', () => {
  const bar = barOf(renderContextBar(MIXED, 11700, 100000, 80));
  assert.equal(SEGMENTS.length, 5, 'five content segments');
  for (const seg of SEGMENTS) {
    assert.ok(bar.includes(seg.fill), `${seg.key} is drawn`);
  }
});

test('a FULL window still shows the readout, because the bar gives up its columns', () => {
  // This is the case that motivated the layout: the readout used to be painted INSIDE the
  // free segment, so a full window — no free segment at all — silently lost the one number
  // that mattered most. Now the readout's columns are reserved first and the bar is fitted
  // into what is left, so the figure is there at 100% and the bar is merely narrower.
  const full = { system: 50000, prompt: 30000, assistant: 15000, thinking: 4000, tools: 1000 };
  const readout = 'context: 100% (100.0k/100.0k)';
  const r = renderContextBar(full, 100000, 100000, 100, readout);
  assert.equal(visible(r.text).length, 100, 'still exactly the width');
  assert.ok(visible(r.text).includes(readout), 'the readout survives a full window');
  assert.equal(r.hits.length, SEGMENTS.length, 'and every segment is still hoverable');
});

test('the bar never reaches the readout, at any fill level', () => {
  // The invariant behind the layout: the two share the row, so they must not overlap. A
  // hit that ran under the figures would name a segment the pointer is not on.
  const segs = { system: 12000, prompt: 31000, assistant: 44000, thinking: 12000, tools: 18000 };
  const readout = 'context: 50% (200.0k/391.4k)';
  for (const pct of [0, 29, 50, 95, 100]) {
    const used = Math.round(400000 * pct / 100);
    const scaled = Object.fromEntries(Object.entries(segs).map(([k, v]) => [k, Math.round(v * used / 117000)]));
    const r = renderContextBar(scaled, used, 400000, 100, readout);
    const last = r.hits.reduce((m, h) => Math.max(m, h.col1), -1);
    assert.ok(last < 100 - readout.length,
      `at ${pct}% the last segment ends at ${last}, clear of the readout`);
  }
});

test('no window, or no width, means no bar', () => {
  // Both come back as an EMPTY RESULT, not a bare string: a caller that forgot to unwrap
  // would get `{ hits: undefined }` and draw nothing at all.
  assert.equal(renderContextBar({ system: 100 }, 100, 0, 80).text, '', 'unknown window');
  assert.equal(renderContextBar({ system: 100 }, 100, 1000, 0).text, '', 'no columns');
  assert.deepEqual(renderContextBar({ system: 100 }, 100, 0, 80).hits, [], 'and no hits either');
});

test('the bar ends with a reset so the fill does not bleed past its row', () => {
  const bar = barOf(renderContextBar({ system: 1000 }, 1000, 100000, 80));
  assert.ok(bar.endsWith('\x1b[0m'), 'the last thing it emits is a reset');
});

// ---------------------------------------------------------------------------
// The readout
// ---------------------------------------------------------------------------

test('the readout steps down as its segment narrows, and never half-prints', () => {
  const wide = formatReadout(11700, 100000, 40);
  assert.match(wide, /^11\.7k\/100\.0k [\d.]+%$/, 'the full form when there is room');

  const narrow = formatReadout(11700, 100000, 12);
  assert.match(narrow, /^[\d.]+%$/, 'the percentage alone when there is not');
  assert.ok(!narrow.includes('/'), 'and no truncated fraction');

  assert.equal(formatReadout(11700, 100000, 4), '', 'nothing when even that will not fit');
});

test('the readout and the renderer agree on the room a form needs', () => {
  // They used to disagree by one column: the readout was accepted here and then not
  // written there, so every bar came up a column short.
  assert.ok(formatReadout(11700, 100000, 40).length <= 40, 'the full form fits a 40-column slot');
  assert.ok(formatReadout(11700, 100000, 12).length <= 12, 'the short form fits a 12-column slot');
  for (const w of [12, 20, 40, 60, 80]) {
    const bar = barOf(renderContextBar(MIXED, 11700, 100000, w));
    assert.equal(visible(bar).length, w, `width ${w}`);
  }
});

test('token counts compact the way the old readout did', () => {
  assert.equal(compactTokens(999), '999');
  assert.equal(compactTokens(1200), '1.2k');
  assert.equal(compactTokens(97000), '97.0k');
  assert.equal(compactTokens(3400000), '3.4M');
});

// ---------------------------------------------------------------------------
// The per-segment label, and the hover that stands in for it
// ---------------------------------------------------------------------------

test('a wide segment carries its name AND its value', () => {
  // Step 1 of the three: enough room, say everything. The names are FULL — there is no
  // abbreviation to fall back on, so a segment that cannot hold `assistant 4.4k` in full
  // drops the value, then the name, rather than shortening either.
  const wide = { system: 40000, prompt: 30000, assistant: 20000, thinking: 0, tools: 0 };
  const r = renderContextBar(wide, 90000, 100000, 120);
  const bar = visible(r.text);
  assert.match(bar, /system prompt 40\.0k/, 'the name and the count are both on the segment');
  assert.match(bar, /user messages 30\.0k/);
  assert.match(bar, /assistant 20\.0k/);
});

test('a narrow segment drops the value and keeps the name', () => {
  // Step 2: the value will not fit in the space, but the name alone will. Dropping the whole
  // label is what made the bar unreadable before — the name is the part that cannot be
  // inferred from the colour.
  // The name here is the FULL `thinking` (8 characters), so the segment needs 9 columns to
  // hold it plus the separator. The row is wide enough for that AND for a readout beside the
  // bar, because the two now share the row: the readout claims its columns first and the
  // bar is fitted into the remainder.
  const segs = { system: 0, prompt: 0, assistant: 0, thinking: 6000, tools: 0 };
  const r = renderContextBar(segs, 6000, 100000, 200, 'context: 6% (6.0k/97.7k)');
  const bar = visible(r.text);
  const th = r.hits.find((h) => h.data === 'thinking');
  const inSegment = bar.slice(th.col0, th.col1 + 1);
  assert.match(inSegment, /thinking/, 'the name survives');
  assert.ok(!/\d/.test(inSegment.replace('thinking', '')),
    `and the value is gone: ${JSON.stringify(inSegment)}`);
});

test('a segment too narrow for even the name still gets a hover target', () => {
  // Step 3 is only acceptable because of this: the label is gone, but the columns are still
  // Step 3 is only acceptable because of this: the label is gone, but the columns are still
  // registered, so pointing at the sliver of colour names it.
  const segs = { system: 0, prompt: 3000, assistant: 3000, thinking: 0, tools: 0 };
  const r = renderContextBar(segs, 6000, 100000, 40);
  assert.equal(r.hits.length, 2, 'both segments are hoverable');
  for (const hit of r.hits) {
    assert.ok(hit.col1 >= hit.col0, 'and each has a real span');
    assert.ok(hit.data, 'naming which segment it is');
  }
});

test('the hits tile the bar left to right with no gaps or overlaps', () => {
  // A gap would be a column the pointer is over and nothing answers for; an overlap would
  // make two segments claim the same column and the caption would flicker between them.
  const r = renderContextBar(MIXED, 11700, 100000, 100);
  const hits = r.hits.slice().sort((a, b) => a.col0 - b.col0);
  for (let i = 1; i < hits.length; i++) {
    assert.equal(hits[i].col0, hits[i - 1].col1 + 1,
      `${hits[i - 1].data} ends at ${hits[i - 1].col1}, ${hits[i].data} starts at ${hits[i].col0}`);
  }
  assert.equal(hits[0].col0, 0, 'the first segment starts at the left edge');
});

test('two adjacent labels never run together', () => {
  // Without the one blank column left at each segment\'s right edge, two short labels read
  // as one word (`asttl`) and the boundary between them becomes invisible.
  const segs = { system: 0, prompt: 200, assistant: 400, thinking: 200, tools: 0 };
  const bar = visible(barOf(renderContextBar(segs, 800, 100000, 40)));
  assert.ok(!/ast\s*tl|th\s*tl|pr\s*ast/.test(bar.replace(/\s{2,}/g, '  ')),
    `labels are separated: ${JSON.stringify(bar)}`);
});

test('a hovered segment names itself in full', () => {
  // The caption is the only place the full name appears; on the bar it is the abbreviation.
  assert.equal(segmentCaption('assistant', 4400), 'assistant 4.4k');
  assert.equal(segmentCaption('system', 1200), 'system prompt 1.2k');
  assert.equal(segmentCaption('tools', 1800), 'tool results 1.8k');
  assert.equal(segmentCaption('nope', 100), '', 'an unknown key says nothing rather than throwing');
});

// ---------------------------------------------------------------------------
// The system segment's values, mid-turn
// ---------------------------------------------------------------------------
//
// `session.messages` holds what the MODEL is sent minus the system prompt: the request is
// assembled as `[system, ...conversation]` and the array written back to the session is
// filtered to non-system roles, at turn start AND at every step boundary. Only at turn end
// is the complete request assigned back. The bar prices `session.messages`, so mid-turn the
// system segment had no message to count, was allocated no columns, and the `system prompt`
// band DISAPPEARED from the bar — then came back the moment the turn ended. The gap also
// silently inflated the assistant segment, which absorbed the share the scaling gave it.
//
// `turnSystemPrompt` carries the assembled text for the length of the turn.

const SYS = 'x'.repeat(3769);        // the real prompt is ~3.8k characters
const CONV = [
  { role: 'user', content: 'look at the context bar' },
  { role: 'assistant', content: 'reading the files now. '.repeat(40) },
];
const MID = { ctxMax: 100000, ctxTokens: 12000, rounds: 2, cfg: {}, session: { messages: CONV } };
const WINDOW = 100;
const READOUT = 'context: 12.0% (12.0k/97.7k)';

const segOf = (state, key) => contextSegments(state, state.cfg)[key];
const colsOf = (state, key) => {
  const segs = contextSegments(state, state.cfg);
  const hit = renderContextBar(segs, state.ctxTokens, state.ctxMax, WINDOW, READOUT)
    .hits.find((h) => h.data === key);
  return hit ? hit.col1 - hit.col0 + 1 : 0;
};

test('the system segment is priced during a turn, not only after it', () => {
  const mid = { ...MID, turnSystemPrompt: SYS };
  const end = { ...MID, session: { messages: [{ role: 'system', content: SYS }, ...CONV] } };
  assert.ok(segOf(mid, 'system') > 0, 'the prompt is counted while the turn runs');
  assert.equal(segOf(mid, 'system'), segOf(end, 'system'),
    'mid-turn and turn-end agree on what the system prompt costs');
  assert.equal(segOf(mid, 'assistant'), segOf(end, 'assistant'),
    'and the assistant segment is not inflated to absorb the difference');
});

test('without the turn-scoped prompt the segment is genuinely absent', () => {
  // The old behaviour, kept as the documented failure: this is what the bar did every turn.
  assert.equal(segOf(MID, 'system'), 0);
  assert.equal(colsOf(MID, 'system'), 0, 'so it got no columns and vanished from the bar');
});

test('the system segment gets real columns on the rendered bar during a turn', () => {
  const mid = { ...MID, turnSystemPrompt: SYS };
  assert.ok(colsOf(mid, 'system') > 0, 'the band is drawn mid-turn');
  assert.equal(colsOf(mid, 'system'), colsOf({ ...MID, session: { messages: [{ role: 'system', content: SYS }, ...CONV] } }, 'system'),
    'the same width it has at turn end');
});

test('a session that already carries the system message is not double-counted', () => {
  // Turn end assigns the full request back, so `turnSystemPrompt` is cleared. If a stale
  // copy survived, the prompt would be priced twice and the bar would overstate the window.
  const end = { ctxMax: 100000, ctxTokens: 12000, rounds: 2, cfg: {}, session: { messages: [{ role: 'system', content: SYS }, ...CONV] } };
  const clean = segOf(end, 'system');
  const withStale = segOf({ ...end, turnSystemPrompt: SYS }, 'system');
  assert.equal(withStale, clean, 'the session message wins and the stale copy is ignored');
});

test('a model that never thinks reports no phantom system segment', () => {
  // The guard is on the TEXT being present, not on a turn being open: an empty or absent
  // prompt must still yield a zero segment rather than an invented one.
  assert.equal(segOf({ ...MID, turnSystemPrompt: '' }, 'system'), 0);
  assert.equal(segOf({ ...MID, turnSystemPrompt: null }, 'system'), 0);
});
