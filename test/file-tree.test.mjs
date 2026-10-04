// The /files tree browser.
//
// WHY THESE ASSERTIONS
// --------------------
// A tree view fails in ways a flat list cannot, and all of them look fine in a screenshot:
//
//   * the gutter (`│  ` vs `   `) is what tells the eye WHICH parent a row belongs to, and
//     getting it wrong reparents rows visually — a file appears to be inside the directory
//     above it;
//   * "directories first" is what makes the structure readable at all; a mixed sort buries
//     them and the tree reads as a flat list with indentation;
//   * the selected index and the scroll offset have to survive a re-render, or opening a
//     directory jumps the selection somewhere else.
//
// The tree is built from a LIST, so these tests never touch the filesystem: the module's
// job is to arrange paths, and tools/ignore.js is what finds them.
import assert from 'node:assert/strict';
import test from 'node:test';

const { buildTree, visibleRows, allDirs, countFiles, renderTree, moveSel } = await import('../src/file-tree.js');

const W = (lines) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

/** A small tree with a nested directory and siblings on both sides. */
const ROOT = '/w';
const FILES = [
  '/w/README.md',
  '/w/src/a.js',
  '/w/src/b.js',
  '/w/src/deep/c.js',
  '/w/test/x.test.js',
  '/w/zzz.txt',
];

const tree = () => buildTree(FILES, ROOT);
const ALL = () => new Set(['src', 'src/deep', 'test']);

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

test('directories are derived from the paths, and counted', () => {
  const root = tree();
  const names = root.children.map((c) => c.name);
  assert.deepEqual(names, ['src', 'test', 'README.md', 'zzz.txt'],
    'the two directories come first, then the loose files');
  assert.equal(countFiles(root), 6, 'every file is counted');
  assert.equal(countFiles(root.children[0]), 3, 'src holds a.js, b.js and deep/c.js');
});

test('directories sort before files, and each group sorts by name', () => {
  for (const node of [tree(), ...tree().children.filter((c) => c.dir)]) {
    const dirs = node.children.filter((c) => c.dir).map((c) => c.name);
    const files = node.children.filter((c) => !c.dir).map((c) => c.name);
    assert.deepEqual(dirs, dirs.slice().sort(), `directories are ordered in ${node.name}`);
    assert.deepEqual(files, files.slice().sort(), `files are ordered in ${node.name}`);
    if (dirs.length && files.length) {
      assert.ok(node.children.findIndex((c) => c.dir) < node.children.findIndex((c) => !c.dir),
        'no directory follows a file');
    }
  }
});

test('a path outside the root is dropped rather than escaping the tree', () => {
  const root = buildTree(['/w/a.js', '/elsewhere/b.js', '/w/c.js'], '/w');
  const names = root.children.map((c) => c.name);
  assert.deepEqual(names, ['a.js', 'c.js'], 'the outside file is not shown');
});

test('a path equal to the root is not a child of itself', () => {
  const root = buildTree(['/w'], '/w');
  assert.deepEqual(root.children, []);
});

test('allDirs finds every directory, at every depth', () => {
  assert.deepEqual(allDirs(tree()).sort(), ['src', 'src/deep', 'test']);
});

test('an empty list yields an empty tree', () => {
  const root = buildTree([], '/w');
  assert.deepEqual(root.children, []);
  assert.equal(countFiles(root), 0);
});

// ---------------------------------------------------------------------------
// visibility and the gutter
// ---------------------------------------------------------------------------

test('a collapsed directory hides its children', () => {
  const root = tree();
  const rows = visibleRows(root, new Set());
  assert.deepEqual(rows.map((r) => r.node.name), ['src', 'test', 'README.md', 'zzz.txt'],
    'nothing under a closed directory is listed');
});

test('an open directory shows its children, and only those', () => {
  const root = tree();
  const rows = visibleRows(root, new Set(['src']));
  assert.deepEqual(rows.map((r) => r.node.name),
    ['src', 'deep', 'a.js', 'b.js', 'test', 'README.md', 'zzz.txt'],
    'src is open, deep is not, so deep/c.js stays hidden');
});

test('opening a nested directory reveals only its own children', () => {
  const root = tree();
  const rows = visibleRows(root, new Set(['src', 'src/deep']));
  assert.ok(rows.some((r) => r.node.name === 'c.js'), 'the nested file appears');
  assert.equal(rows.filter((r) => r.node.name === 'c.js').length, 1, 'exactly once');
});

test('depth increases with nesting', () => {
  const root = tree();
  const rows = visibleRows(root, new Set(['src', 'src/deep']));
  const depthOf = (n) => rows.find((r) => r.node.name === n).depth;
  assert.equal(depthOf('src'), 0);
  assert.equal(depthOf('a.js'), 1);
  assert.equal(depthOf('deep'), 1);
  assert.equal(depthOf('c.js'), 2);
});

test('the gutter keeps a row attached to its own parent', () => {
  // The failure this pins: `src` is followed by `test`, so every row under `src` must be
  // prefixed with a vertical bar — that is what the eye follows back up. A row under the
  // LAST root entry gets spaces instead, because there is nothing below it to connect to.
  const root = tree();
  const rows = visibleRows(root, new Set(['src']));
  const g = (n) => rows.find((r) => r.node.name === n).prefix;
  // `src` is the first of four root children → its children carry the bar.
  assert.equal(g('a.js'), '\u2502  ');
  // `test` is the second of four → so is its child.
  assert.equal(g('deep'), '\u2502  ');
  // `README.md` is the third, `zzz.txt` the fourth: the last root entry's own children
  // would get spaces, but neither of these has children.
  assert.equal(g('README.md'), '');
  assert.equal(g('zzz.txt'), '');
});

test('the gutters of the LAST root directory are spaces', () => {
  // Directories sort first, so a directory is the final root entry only when EVERY root
  // child is a directory. Then nothing follows it, and a row under it gets spaces rather
  // than a bar — there is no sibling below to connect to.
  const root = buildTree(['/w/alpha/a.js', '/w/test/x.js'], '/w');
  const rows = visibleRows(root, new Set(['test']));
  const x = rows.find((r) => r.node.name === 'x.js');
  assert.equal(x.prefix, '   ', 'no bar under the final root entry');
});

test('a directory that is NOT last keeps the bar under it', () => {
  // The complement, and the case the eye relies on: bars run down to the sibling that
  // closes the group, which is what shows where a directory ends. A loose file at the
  // root sorts AFTER every directory, so it is what makes the directory non-final.
  const root = buildTree(['/w/test/x.js', '/w/README.md'], '/w');
  const rows = visibleRows(root, new Set(['test']));
  assert.equal(rows.find((r) => r.node.name === 'x.js').prefix, '\u2502  ');
});

test('the { last } flag is set on the final child of each level', () => {
  const root = tree();
  const rows = visibleRows(root, new Set(['src']));
  const byName = (n) => rows.find((r) => r.node.name === n);
  assert.equal(byName('zzz.txt').last, true, 'the last root child');
  assert.equal(byName('src').last, false);
  assert.equal(byName('b.js').last, true, 'the last child of src');
  assert.equal(byName('deep').last, false);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('the header names the file count and the keys', () => {
  const root = tree();
  const expanded = ALL();
  const v = renderTree({ root, rows: visibleRows(root, expanded), sel: 0, scroll: 0, width: 70, height: 20, expandedSet: expanded });
  const text = W(v.lines).join('\n');
  assert.match(text, /Files — 6 file\(s\)/);
  assert.match(text, /Enter insert/);
  assert.match(text, /Esc close/);
});

test('the body fits the height it is given, header and footer included', () => {
  const root = tree();
  const expanded = ALL();
  for (const height of [8, 12, 20, 40]) {
    const v = renderTree({ root, rows: visibleRows(root, expanded), sel: 0, scroll: 0, width: 70, height, expandedSet: expanded });
    assert.ok(v.lines.length <= height, `height ${height}: got ${v.lines.length} lines`);
  }
});

test('directories carry a marker and their count', () => {
  const root = tree();
  const expanded = new Set();      // everything closed: markers show as closed
  const v = renderTree({ root, rows: visibleRows(root, expanded), sel: 0, scroll: 0, width: 70, height: 20, expandedSet: expanded });
  const text = W(v.lines).join('\n');
  assert.match(text, /\u25b8 src\//, 'a closed directory has the closed marker and a trailing slash');
  assert.match(text, /\(3\)/, 'and its file count');
});

test('an open directory shows the open marker', () => {
  const root = tree();
  const expanded = new Set(['src']);
  const v = renderTree({ root, rows: visibleRows(root, expanded), sel: 0, scroll: 0, width: 70, height: 20, expandedSet: expanded });
  assert.match(W(v.lines).join('\n'), /\u25be src\//);
});

test('the selection is kept in view by adjusting the scroll, not the index', () => {
  const root = tree();
  const expanded = ALL();
  const rows = visibleRows(root, expanded);
  // Ask for the last row with a short window: the scroll must follow.
  const v = renderTree({ root, rows, sel: rows.length - 1, scroll: 0, width: 70, height: 10, expandedSet: expanded });
  assert.equal(v.sel, rows.length - 1, 'the index is what the caller asked for');
  assert.ok(v.scroll > 0, 'the window moved instead');
  assert.ok(v.scroll <= v.sel, 'and the selection is inside it');
});

test('scrolling up past the top clamps rather than going negative', () => {
  const root = tree();
  const expanded = ALL();
  const v = renderTree({ root, rows: visibleRows(root, expanded), sel: 3, scroll: 99, width: 70, height: 10, expandedSet: expanded });
  assert.ok(v.scroll <= v.sel, 'the scroll was pulled back to the selection');
  assert.ok(v.scroll >= 0);
});

test('an out-of-range selection is clamped to the list', () => {
  const root = tree();
  const expanded = ALL();
  const rows = visibleRows(root, expanded);
  const v = renderTree({ root, rows, sel: 9999, scroll: 0, width: 70, height: 10, expandedSet: expanded });
  assert.ok(v.sel < rows.length, 'clamped into range');
  assert.ok(v.sel >= 0);
});

test('every rendered row is no wider than the panel', () => {
  // A row wider than the frame wraps and corrupts every row below it.
  const root = tree();
  const expanded = ALL();
  const rows = visibleRows(root, expanded);
  for (const width of [24, 30, 40, 80]) {
    const v = renderTree({ root, rows, sel: 0, scroll: 0, width, height: 20, expandedSet: expanded });
    for (const line of W(v.lines)) {
      assert.ok(line.length <= width, `width ${width}: ${JSON.stringify(line.slice(0, 60))} is ${line.length} wide`);
    }
  }
});

test('a very long name is truncated with an ellipsis, not wrapped', () => {
  const long = 'x'.repeat(200) + '.js';
  const root = buildTree([`/w/${long}`], '/w');
  const rows = visibleRows(root, new Set());
  const v = renderTree({ root, rows, sel: 0, scroll: 0, width: 40, height: 10, expandedSet: new Set() });
  const body = W(v.lines).find((l) => l.includes('x'));
  assert.ok(body.length <= 40, 'the row stays inside the panel');
  assert.match(body, /\u2026/, 'and is marked as truncated');
});

test('the footer carries the position and the selected path', () => {
  const root = tree();
  const expanded = ALL();
  const rows = visibleRows(root, expanded);
  const v = renderTree({ root, rows, sel: 1, scroll: 0, width: 70, height: 20, expandedSet: expanded });
  const footer = W(v.lines)[v.lines.length - 1];
  assert.match(footer, /2\//, 'the 1-based position is shown');
  assert.match(footer, new RegExp(rows[1].node.rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---------------------------------------------------------------------------
// movement
// ---------------------------------------------------------------------------

test('movement wraps at both ends', () => {
  // A browser that dead-ends makes the arrow keys feel broken on a short list.
  assert.equal(moveSel(0, -1, 5), 4, 'up from the top wraps to the bottom');
  assert.equal(moveSel(4, 1, 5), 0, 'down from the bottom wraps to the top');
  assert.equal(moveSel(2, 1, 5), 3);
  assert.equal(moveSel(2, -1, 5), 1);
});

test('movement with no rows stays at zero rather than going NaN', () => {
  assert.equal(moveSel(0, 1, 0), 0);
  assert.equal(moveSel(5, -1, 0), 0);
});

test('a big jump wraps rather than landing out of range', () => {
  assert.equal(moveSel(0, 12, 5), 2);
  assert.equal(moveSel(0, -12, 5), 3);
});
