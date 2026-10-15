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
