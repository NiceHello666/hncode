// Tests for the symbol-patching engine.
//
// patch.js lets a plugin wrap any function or class method in hncode's own source
// by rewriting that module as it loads. Two things must hold:
//   * the RUNTIME contract — before/after/around compose in a well-defined order,
//     async results are awaited, and `this` is preserved for methods;
//   * the REWRITE contract — a patched module still runs, the original body is
//     untouched, and only targeted files are rewritten.
//
// The rewrite is deliberately source-level (a footer that reassigns the symbol)
// rather than an AST transform, so the tests assert on that shape: the declaration
// is left byte-identical and the footer does the work.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTarget, addPatch, applyPatches, clearPatches, listPatchTargets,
  rewriteSource, LEGACY_SEAMS,
} from '../src/patch.js';

// Always start from an empty registry so tests cannot leak into each other.
function isolate() { clearPatches(); }
test.afterEach(isolate);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

test('parseTarget accepts "file.js#symbol" and "file.js#Class.method"', () => {
  assert.deepEqual(parseTarget('git.js#commit'), { file: 'git.js', base: 'commit', method: null, id: 'git.js#commit' });
  assert.deepEqual(parseTarget('llm.js#LLM.requestText'), { file: 'llm.js', base: 'LLM', method: 'requestText', id: 'llm.js#LLM.requestText' });
  assert.deepEqual(parseTarget('a/b.js#f'), { file: 'a/b.js', base: 'f', method: null, id: 'a/b.js#f' });
});

test('parseTarget rejects malformed targets', () => {
  // A target with no "#" or a junk identifier must fail, so addPatch reports it
  // rather than registering something that can never match.
  for (const bad of ['nonsense', 'file.js', '#foo', 'file.js#', 'file.js#1abc', '', null, undefined]) {
    assert.equal(parseTarget(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('addPatch rejects a bad target or handler', () => {
  assert.throws(() => addPatch('nonsense', {}), /bad target/);
  assert.throws(() => addPatch('a.js#b', null), /handler must be/);
  assert.throws(() => addPatch('a.js#b', 'nope'), /handler must be/);
});

test('legacy seam names are recognised (they are NOT symbol targets)', () => {
  // The nine abstract seams keep working with the old chain signature; they must be
  // distinguishable so api.patch can route them to the chain runner.
  assert.ok(LEGACY_SEAMS.has('systemPrompt'));
  assert.ok(LEGACY_SEAMS.has('toolResult'));
  assert.equal(LEGACY_SEAMS.size, 9);
  assert.equal(parseTarget('systemPrompt'), null, 'a seam is not a file#symbol target');
});

// ---------------------------------------------------------------------------
// Runtime wrapping
// ---------------------------------------------------------------------------

test('before and after run around the original, in that order', () => {
  const order = [];
  addPatch('demo.js#f', {
    before: () => { order.push('before'); },
    after: (r) => { order.push('after'); return r * 10; },
  });
  const wrapped = applyPatches('demo.js#f', (x) => { order.push('orig'); return x + 1; });
  assert.equal(wrapped(1), 20, 'after may replace the result');
  assert.deepEqual(order, ['before', 'orig', 'after']);
});

test('before returning an array replaces the arguments', () => {
  addPatch('demo.js#g', { before: (a, b) => [b, a] });
  const wrapped = applyPatches('demo.js#g', (a, b) => [a, b]);
  assert.deepEqual(wrapped(1, 2), [2, 1]);
});

test('before returning nothing leaves the arguments alone', () => {
  let seen = null;
  addPatch('demo.js#g', { before: () => { return undefined; } });
  const wrapped = applyPatches('demo.js#g', (a, b) => { seen = [a, b]; return 0; });
  wrapped(1, 2);
  assert.deepEqual(seen, [1, 2]);
});

test('after returning undefined leaves the result alone', () => {
  addPatch('demo.js#h', { after: () => {} });
  const wrapped = applyPatches('demo.js#h', () => 'kept');
  assert.equal(wrapped(), 'kept');
});

test('around takes over the call and may call the original', () => {
  addPatch('demo.js#k', { around: (orig, args) => orig(...args) + 100 });
  const wrapped = applyPatches('demo.js#k', (x) => x);
  assert.equal(wrapped(5), 105);
});

test('around can suppress the original entirely', () => {
  let called = false;
  addPatch('demo.js#k', { around: () => 'short-circuit' });
  const wrapped = applyPatches('demo.js#k', () => { called = true; return 'orig'; });
  assert.equal(wrapped(), 'short-circuit');
  assert.equal(called, false);
});

test('`this` is preserved for a class method wrapper', () => {
  // A method wrapper that lost `this` would break every instance call.
  const obj = {
    n: 7,
    m(x) { return this.n + x; },
  };
  addPatch('demo.js#K.m', { after: (r) => r * 2 });
  obj.m = applyPatches('demo.js#K.m', obj.m);
  assert.equal(obj.m(1), 16, '(7 + 1) * 2, which requires `this` inside the original');
});

test('the wrapper is transparent for an async function', async () => {
  // `after` must see the RESOLVED value, not the Promise.
  let seen = null;
  addPatch('demo.js#as', { after: async (r) => { seen = r; return r + 1; } });
  const wrapped = applyPatches('demo.js#as', async (x) => x * 2);
  const out = await wrapped(21);
  assert.equal(seen, 42, 'after must receive the awaited value');
  assert.equal(out, 43);
});

test('an unpatched symbol is returned as the SAME function (no wrapper allocated)', () => {
  // A needless wrapper would break identity checks and cost a call per invocation.
  const fn = (x) => x * 2;
  assert.equal(applyPatches('demo.js#nope', fn), fn);
});

test('multiple handlers for one target compose in registration order', () => {
  const order = [];
  const off1 = addPatch('demo.js#m', { before: () => { order.push('h1'); } });
  addPatch('demo.js#m', { before: () => { order.push('h2'); } });
  const wrapped = applyPatches('demo.js#m', () => { order.push('orig'); return 0; });
  wrapped();
  assert.deepEqual(order, ['h1', 'h2', 'orig']);
  off1();
  assert.deepEqual(listPatchTargets(), ['demo.js#m'], 'unregistering one handler keeps the target');
});

test('unregistering the last handler removes the target', () => {
  const off = addPatch('demo.js#only', { before: () => {} });
  off();
  assert.deepEqual(listPatchTargets(), []);
});

// ---------------------------------------------------------------------------
// Source rewriting
// ---------------------------------------------------------------------------

test('rewriteSource appends a footer and leaves the declaration untouched', () => {
  addPatch('demo.js#foo', { before: () => {} });
  const src = 'export function foo(a) {\n  return a;\n}\n';
  const out = rewriteSource('demo.js', src);
  assert.ok(out.startsWith(src), 'the original source must be a prefix, byte for byte');
  assert.ok(out.includes('hncode:patch-footer'), 'a footer must be appended');
  assert.ok(out.includes('foo = P("demo.js#foo", foo)'), 'the footer must reassign the symbol');
});

test('only files with a registered target are rewritten', () => {
  addPatch('other.js#x', { before: () => {} });
  // No target names demo.js, so it must be reported as "no rewrite" (null), which
  // the loader treats as "return the module unchanged".
  assert.equal(rewriteSource('demo.js', 'export function foo() {}\n'), null);
  assert.notEqual(rewriteSource('other.js', 'export function x() {}\n'), null);
});

test('a target on a file whose source has no such symbol still yields a footer', () => {
  // The footer's try/catch means a missing symbol is a load-time warning, not a
  // crash — the plugin loaded, its target just did not exist.
  addPatch('demo.js#missing', { before: () => {} });
  const out = rewriteSource('demo.js', 'export function present() {}\n');
  assert.ok(out.includes('hncode:patch-footer'));
  assert.ok(out.includes('try {'), 'the reassignment must be guarded');
});

test('a class method target patches via the prototype', () => {
  addPatch('demo.js#K.m', { after: (r) => r });
  const out = rewriteSource('demo.js', 'export class K { m() { return 1; } }\n');
  assert.ok(out.includes('K.prototype.m = P("demo.js#K.m", K.prototype.m)'),
    'a method target must reassign on the prototype, not the class');
});

test('the footer guards on the global, so a plain import cannot throw', () => {
  // patch.js sets globalThis.__hncodePatch once; a module loaded without it (a test
  // importing the file directly) must still run, not crash on an undefined call.
  addPatch('demo.js#foo', { before: () => {} });
  const out = rewriteSource('demo.js', 'export function foo() {}\n');
  assert.ok(out.includes('if (!P) return;'), 'the footer must no-op when the global is absent');
});