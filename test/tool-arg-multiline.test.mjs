// A multi-line tool argument is shown as its first line PLUS a marker for the rest.
//
// WHY THIS FILE EXISTS
// --------------------
// `keyArgument` did `v.split('\n')[0]` — it took the first line of the argument and dropped
// everything after it with no indication. A three-command script therefore displayed exactly like a
// one-command script, and the reader had no way to tell the head of a long command from a short one.
//
// The marker has to be RIGHT in both directions: present when lines were dropped, and ABSENT when
// they were not. A command ending in a newline — how a heredoc is written — split into a trailing
// empty element, and counting it claimed `(+1 line)` for a command with no second line at all. That
// is the same defect as the silent drop, pointing the other way.
import assert from 'node:assert/strict';
import test from 'node:test';

const { formatToolLine } = await import('../src/tui.js');

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
/** The rendered row for a Bash call with the given arguments. */
const row = (toolArgs) => strip(formatToolLine({ toolName: 'Bash', toolArgs, pending: false }, process.cwd(), 0, 0, 0));
/** The same row with Ctrl+O's expanded state, which lifts the one-line cut. */
const expandedRow = (toolArgs) => strip(formatToolLine(
  { toolName: 'Bash', toolArgs, pending: false }, process.cwd(), 0, 0, undefined, true));

test('the first line of a multi-line command is shown', () => {
  const out = row({ command: 'cd /d D:\\repo\nnpm test\nnpm run build' });
  assert.match(out, /cd \/d D:\\repo/, 'the first line is what a one-line row can carry');
});

test('the dropped lines are declared, with a count', () => {
  // The count is what makes the row honest: "…" alone still leaves the reader guessing how much
  // is missing.
  assert.match(row({ command: 'a\nb' }), /\(\+1 line\)/, 'one line left out');
  assert.match(row({ command: 'a\nb\nc' }), /\(\+2 lines\)/, 'two lines left out, plural');
});

test('a single-line command carries NO marker', () => {
  // The other half. A marker on a complete command is a false alarm, and it is what makes a reader
  // stop trusting the marker at all.
  const out = row({ command: 'npm test' });
  assert.doesNotMatch(out, /\(\+\d/, `no count for one line: ${out}`);
  assert.doesNotMatch(out, /…/, `no ellipsis for one line: ${out}`);
});

test('a trailing newline is not an extra line', () => {
  // `"npm test\n"` is ONE command. It split into ['npm test', ''] and the empty tail was counted.
  assert.doesNotMatch(row({ command: 'npm test\n' }), /\(\+/, 'no count for a trailing newline');
  assert.doesNotMatch(row({ command: 'npm test\n\n\n' }), /\(\+/, 'nor for several blank tails');
});

test('CRLF line endings are counted once, not twice', () => {
  // A `\r\n` split on `\n` leaves a trailing `\r` on each line; if that were treated as content the
  // count would be wrong, and a two-line command would claim three lines.
  const out = row({ command: 'a\r\nb\r\nc' });
  assert.match(out, /\(\+2 lines\)/, `two lines after the first: ${out}`);
});

test('a first line that is itself cut is still marked', () => {
  // When the first line alone exceeds the row, the argument is truncated and the trailing marker
  // stands for both the cut text and the lines below it. The row wraps the argument in parens, so
  // the marker sits just inside the closing one.
  const out = row({ command: 'x'.repeat(300) + '\nsecond\nthird' });
  assert.match(out, /…\)$/, `a truncated first line is marked: ${JSON.stringify(out.slice(-8))}`);
  assert.ok(out.length < 200, 'and the row stayed bounded');
});

test('a path argument is unaffected by the line logic', () => {
  // The same function serves every tool; the multi-line rule must not disturb a plain path.
  const out = row({ path: '/tmp/a.txt' });
  assert.doesNotMatch(out, /\(\+\d/, `no count for a path: ${out}`);
});

// ---------------------------------------------------------------------------
// Ctrl+O: the whole command
// ---------------------------------------------------------------------------

test('expanding shows a long single-line command in full', () => {
  // The collapsed row cuts at MAX_ARG so a `node -e "…"` one-liner does not wrap across the screen.
  // Ctrl+O is the escape hatch: whoever expands tool output to read it wants the command they are
  // reading the output OF, and the command is what they asked for in the first place.
  const cmd = "cd a && ls -la | grep foo | awk '{print $2}' && echo done && npm run build 2>&1 | tail -50 && git status --short";
  const collapsed = row({ command: cmd });
  const shown = expandedRow({ command: cmd });
  assert.ok(collapsed.length < cmd.length, 'the collapsed row is cut');
  assert.ok(shown.includes(cmd), 'the expanded row carries the whole command');
  assert.doesNotMatch(shown, /\+\d+ lines?/, 'and no count of what is missing');
});

test('expanding keeps a multi-line command on its own lines', () => {
  // Newlines are honoured rather than flattened. `wrapAnsiWords` alone turns them into spaces, so the
  // script would come back as one reflowed line — and the reason to expand is to read the script.
  const out = expandedRow({ command: 'set -e\nnpm ci\nnpm test' });
  assert.ok(out.includes('set -e\nnpm ci\nnpm test'), 'the line breaks survive');
  assert.doesNotMatch(out, /\(\+\d+ lines?\)/, 'and nothing is elided');
});

test('collapsing is unchanged, so the default row is still one line', () => {
  // The expand path must not alter what a user sees without pressing anything.
  const out = row({ command: 'set -e\nnpm ci\nnpm test' });
  assert.doesNotMatch(out, /\n/, 'the collapsed row is a single line');
  assert.match(out, /\+\d+ lines?/, 'and it still says how much is hidden');
});

// ---------------------------------------------------------------------------
// the RENDERED rows
// ---------------------------------------------------------------------------

test('an expanded multi-line command renders as separate rows', async () => {
  // The test above checks the STRING `formatToolLine` returns, which already carries newlines. What
  // turns that string into rows is `messageLines`, and it is not exported — so the newline handling
  // can only be checked by composing a frame and counting. That is also the honest check: the rows are
  // what the user sees.
  const { composeFrame } = await import('../src/tui.js');
  const rowsFor = (expanded) => {
    const state = {
      expanded, running: false, spin: 0, cwd: process.cwd(),
      cfg: { shimmerEdge: 'cosine' }, todos: [], queued: [],
      chat: [{ role: 'tool', toolName: 'Bash', toolArgs: { command: 'set -e\nnpm ci\nnpm test' }, pending: false }],
    };
    const frame = composeFrame(state, 100, 30);
    const lines = (Array.isArray(frame) ? frame : frame.lines || []).map(strip);
    return lines.filter((l) => /npm|set -e/.test(l));
  };

  const collapsed = rowsFor(false);
  assert.equal(collapsed.length, 1, `one row when collapsed: ${JSON.stringify(collapsed)}`);

  const shown = rowsFor(true);
  assert.equal(shown.length, 3, `one row per line of the script: ${JSON.stringify(shown)}`);
  assert.match(shown[0], /set -e/, 'the first row carries the first line');
  assert.match(shown[1], /npm ci/, 'the second row the second line');
  assert.match(shown[2], /npm test\)/, 'and the last row closes the paren');
});
