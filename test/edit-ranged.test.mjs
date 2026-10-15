// A ranged edit: start_line/end_line TOGETHER WITH old_string/new_string.
//
// WHY THIS FILE EXISTS
// --------------------
// The two families used to be mutually exclusive — the combination was rejected outright. That
// left `replace_all` as the only way to change one of several identical snippets, which changes
// ALL of them. The case it cannot serve is ordinary: a `return 1;` inside three similar functions,
// where only the middle one should move.
//
// The range narrows WHERE to look; the snippet says WHAT to replace inside it. These tests pin the
// behaviour that makes that useful, and — more importantly — that the range really does confine
// the replacement, since a range that did not would be `replace_all` wearing a disguise.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-ranged-'));
const { spec } = await import('../src/tools/edit.js');

/** A file where the same snippet appears three times, one per function. */
function threeCopies() {
  const file = path.join(dir, `dup${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, [
    'function a() {',
    '  return 1;',
    '}',
    'function b() {',
    '  return 1;',
    '}',
    'function c() {',
    '  return 1;',
    '}',
    '',
  ].join('\n'), 'utf8');
  return file;
}

async function prepare(file) {
  const ctx = { workspace: dir, readPool: new Map() };
  await spec.execute({ path: file }, ctx);   // read-before-write
  return ctx;
}

const read = (f) => fs.readFileSync(f, 'utf8');

test('the two families may be combined', async () => {
  // The headline change: this used to be an error telling the caller to pick one.
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 4, end_line: 6, old_string: '  return 1;', new_string: '  return 2;' }, ctx,
  );
  assert.doesNotMatch(out, /do not mix/i, `the combination is accepted: ${out}`);
  assert.match(out, /replaced 1 occurrence/);
});

test('the range CONTAINS the replacement — copies outside it are untouched', async () => {
  // The whole point. `replace_all` would have changed all three.
  const file = threeCopies();
  const ctx = await prepare(file);
  await spec.execute(
    { path: file, start_line: 4, end_line: 6, old_string: '  return 1;', new_string: '  return 2;' }, ctx,
  );
  const lines = read(file).split('\n');
  assert.equal(lines[1], '  return 1;', 'the copy before the range is unchanged');
  assert.equal(lines[4], '  return 2;', 'the copy inside the range changed');
  assert.equal(lines[7], '  return 1;', 'the copy after the range is unchanged');
});

test('a snippet that is ambiguous file-wide becomes unambiguous inside a range', async () => {
  // Without the range this is the error that sent callers to `replace_all`.
  const file = threeCopies();
  const ctx = await prepare(file);

  const bare = await spec.execute({ path: file, old_string: 'return 1;', new_string: 'return 2;' }, ctx);
  assert.match(bare, /matched 3 occurrences/, 'ambiguous without a range');

  const ranged = await spec.execute(
    { path: file, start_line: 7, end_line: 9, old_string: 'return 1;', new_string: 'return 3;' }, ctx,
  );
  assert.match(ranged, /replaced 1 occurrence/, 'and settled with one');

  const lines = read(file).split('\n');
  assert.equal(lines[7], '  return 3;', 'the LAST copy changed, the one the range named');
  assert.equal(lines[1], '  return 1;');
  assert.equal(lines[4], '  return 1;');
});

test('two occurrences INSIDE one range are still reported as ambiguous', async () => {
  // The range narrows the search; it does not authorise guessing among what it finds.
  const file = path.join(dir, 'pair.js');
  fs.writeFileSync(file, 'x = 1;\nx = 1;\n', 'utf8');
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 1, end_line: 2, old_string: 'x = 1;', new_string: 'x = 2;' }, ctx,
  );
  assert.match(out, /matched 2 occurrences within lines 1-2/);
  assert.equal(read(file), 'x = 1;\nx = 1;\n', 'nothing was written');
});

test('a range that does not hold the snippet says where it IS', async () => {
  // Reporting a bare "not found" would send the caller hunting for a typo that is not there, when
  // the real problem is the range.
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 1, end_line: 3, old_string: 'function b()', new_string: 'function B()' }, ctx,
  );
  assert.match(out, /not found within lines 1-3/);
  assert.match(out, /elsewhere in the file, outside lines 1-3/, 'and it points at the real location');
});

test('a snippet that is nowhere at all gets the ordinary not-found message', async () => {
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 1, end_line: 3, old_string: 'nowhereAtAll()', new_string: 'x' }, ctx,
  );
  assert.match(out, /not found within lines 1-3/);
  assert.doesNotMatch(out, /elsewhere in the file/, 'no misleading hint when it is truly absent');
});

test('replace_all inside a range changes every copy in the range, and no others', async () => {
  const file = path.join(dir, 'rangeall.js');
  fs.writeFileSync(file, 'a = 1;\na = 1;\n\nb = 1;\n', 'utf8');
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 1, end_line: 2, old_string: 'a = 1;', new_string: 'a = 2;', replace_all: true }, ctx,
  );
  assert.match(out, /replaced 2 occurrence/);
  assert.equal(read(file), 'a = 2;\na = 2;\n\nb = 1;\n', 'line 4 was outside the range');
});

test('the range is validated before anything is matched', async () => {
  const file = threeCopies();
  const ctx = await prepare(file);
  for (const args of [
    { start_line: 0, end_line: 3 },          // not 1-based
    { start_line: 5, end_line: 2 },          // reversed
    { start_line: 1, end_line: 9999 },       // past the end
  ]) {
    const out = await spec.execute({ path: file, old_string: 'return 1;', new_string: 'x', ...args }, ctx);
    assert.match(out, /Error/, `refused ${JSON.stringify(args)}`);
    assert.equal(read(file), threeCopiesFile(), 'and wrote nothing');
  }
  function threeCopiesFile() {
    return 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\nfunction c() {\n  return 1;\n}\n';
  }
});

test('a range without new_string is still an error', async () => {
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute({ path: file, start_line: 1, end_line: 3, old_string: 'return 1;' }, ctx);
  assert.match(out, /needs new_string/);
});

test('a half-given range beside an old_string is IGNORED, not refused', async () => {
  // A caller naturally adds `start_line` from the schema's own wording ("1-based first line to
  // replace") expecting it to help. `old_string` already locates the edit, so the unpaired bound is
  // a hint that failed to pair — refusing rejected a request that was already complete.
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 4, old_string: 'return 1;', new_string: 'return 2;' }, ctx,
  );
  // 'return 1;' appears three times, so the REAL objection is ambiguity — not the stray bound.
  assert.doesNotMatch(out, /BOTH start_line and end_line/, 'the stray bound is not the problem');
  assert.match(out, /matched 3 occurrences/, 'the snippet is still judged on its own merits');
});

test('a half-given range beside a UNIQUE old_string simply works', async () => {
  const file = path.join(dir, `half${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, 'const a = 1;\nconst target = 2;\nconst c = 3;\n', 'utf8');
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, start_line: 2, old_string: 'const target = 2;', new_string: 'const target = 20;' }, ctx,
  );
  assert.match(out, /replaced 1 occurrence/, `edit applied: ${out}`);
  assert.match(read(file), /const target = 20;/, 'and the file changed');
});

test('pure line-range mode still replaces whole lines', async () => {
  // The ranged mode must not have swallowed the older one.
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute({ path: file, start_line: 2, end_line: 2, new_string: '  return 42;' }, ctx);
  assert.match(out, /replaced lines 2-2/);
  assert.equal(read(file).split('\n')[1], '  return 42;');
});

test('pure substring mode still works across the whole file', async () => {
  const file = threeCopies();
  const ctx = await prepare(file);
  const out = await spec.execute(
    { path: file, old_string: '  return 1;', new_string: '  return 2;', replace_all: true }, ctx,
  );
  assert.match(out, /replaced 3 occurrence/);
  assert.equal((read(file).match(/return 2;/g) || []).length, 3, 'all three changed');
});

test('a ranged edit reports a diff with context, like any other', async () => {
  const file = threeCopies();
  const ctx = await prepare(file);
  await spec.execute(
    { path: file, start_line: 4, end_line: 6, old_string: '  return 1;', new_string: '  return 2;' }, ctx,
  );
  const diff = ctx.lastEditDiff;
  assert.ok(diff, 'the edit published a diff for the UI');
  assert.equal(diff.old, '  return 1;', 'the snippet that was replaced');
  assert.equal(diff.new, '  return 2;', 'and what it became');
});
