// User keybindings.
//
// WHY THESE ASSERTIONS
// --------------------
// A keybinding feature fails in one of two quiet ways, and both are worse than not having
// it: a binding that SILENTLY DOES NOTHING (the spelling differs from the tokenizer's
// vocabulary, so the key never matches) and a binding that SWALLOWS EVERY KEY (a malformed
// file the loader treats as "no bindings", or a chain that never terminates). Every case
// below is one of those two.
//
// `normalizeKey` is the whole surface where the first can happen, so it is tested against
// the spellings a person actually writes — `ctrl+o` as much as `c-o` — rather than only
// the internal form.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  keybindingsFile, normalizeKey, loadKeybindings, resolveKey,
  readOrEmpty, writeKeybindings, describeKeybindings,
} = await import('../src/keybindings.js');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-keys-'));
const cleanup = (h) => { try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* temp */ } };
const withHome = (doc) => {
  const home = tmpHome();
  if (doc !== undefined) fs.writeFileSync(keybindingsFile(home), typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf8');
  return home;
};

// ---------------------------------------------------------------------------
// normalisation: the spellings people write
// ---------------------------------------------------------------------------

test('the usual key spellings normalise to this TUI’s tokens', () => {
  const cases = [
    ['ctrl+o', 'c-o'], ['C-O', 'c-o'], ['ctrl-o', 'c-o'], ['^o', '^o'],
    ['control+o', 'c-o'], ['Ctrl+T', 'c-t'], ['c-t', 'c-t'],
    ['return', 'enter'], ['Return', 'enter'], ['enter', 'enter'],
    ['esc', 'escape'], ['Escape', 'escape'], ['escape', 'escape'],
    ['tab', 'tab'], ['shift+tab', 'shift-tab'],
    ['up', 'up'], ['ctrl+up', 'c-up'], ['pageup', 'pgup'],
    ['f1', 'f1'], ['space', ' '],
  ];
  for (const [input, want] of cases) {
    assert.equal(normalizeKey(input), want, `${JSON.stringify(input)} -> ${JSON.stringify(want)}`);
  }
});

test('an unsupported modifier falls back to the base key instead of a dead token', () => {
  // `cmd` does not exist on Windows and nothing emits a `cmd-*` token, so binding one must
  // not produce a key that can never arrive.
  assert.equal(normalizeKey('cmd+x'), 'x');
  assert.equal(normalizeKey('alt+x'), 'x');
  assert.equal(normalizeKey('super+x'), 'x');
});

test('an empty or nonsense spec normalises to nothing, never to a real key', () => {
  assert.equal(normalizeKey(''), '');
  assert.equal(normalizeKey(null), '');
  assert.equal(normalizeKey(undefined), '');
  assert.equal(normalizeKey('ctrl+'), '');
});

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

test('a missing file is normal, not an error', () => {
  const home = tmpHome();
  try {
    const r = loadKeybindings(home);
    assert.equal(r.errors.length, 0, 'no complaints about a file that was never written');
    assert.equal(r.bindings.size, 0);
  } finally { cleanup(home); }
});

test('a malformed file is reported ONCE and yields no bindings', () => {
  // The dangerous version of this: parse failure silently treated as "{}" is fine, but
  // reporting it every keypress is not, so the loader returns the errors to the caller and
  // the CALLER decides. What must not happen is throwing — that would kill the keypress.
  const home = withHome('{ not json');
  try {
    const r = loadKeybindings(home);
    assert.equal(r.bindings.size, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /not valid JSON/);
  } finally { cleanup(home); }
});

test('a JSON array or scalar is rejected rather than iterated', () => {
  const home = withHome('[1,2,3]');
  try {
    const r = loadKeybindings(home);
    assert.equal(r.bindings.size, 0);
    assert.equal(r.errors.length, 1);
  } finally { cleanup(home); }
});

test('both a flat map and a { bindings: … } wrapper are accepted', () => {
  const flat = withHome({ 'ctrl+o': 'enter' });
  const wrapped = withHome({ bindings: { 'ctrl+o': 'enter' } });
  try {
    assert.equal(loadKeybindings(flat).bindings.get('c-o').key, 'enter');
    assert.equal(loadKeybindings(wrapped).bindings.get('c-o').key, 'enter');
  } finally { cleanup(flat); cleanup(wrapped); }
});

test('a command target is recognised, and only when it looks like one', () => {
  const home = withHome({
    'ctrl+e': '/theme',
    'ctrl+r': '  /status  ',
    'ctrl+b': 'enter',
    'ctrl+t': { command: '/cost' },
    'ctrl+p': { key: 'c-o' },
  });
  try {
    const { bindings, errors } = loadKeybindings(home);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join('; ')}`);
    assert.deepEqual(bindings.get('c-e'), { command: '/theme' });
    assert.deepEqual(bindings.get('c-r'), { command: '/status' }, 'whitespace around a command is tolerated');
    assert.deepEqual(bindings.get('c-b'), { key: 'enter' });
    assert.deepEqual(bindings.get('c-t'), { command: '/cost' });
    assert.deepEqual(bindings.get('c-p'), { key: 'c-o' });
  } finally { cleanup(home); }
});

test('a bad entry is skipped with a message, and the good entries still load', () => {
  // One typo must not take the whole file with it.
  const home = withHome({
    'ctrl+e': '/theme',
    'ctrl+q': 42,
    'ctrl+w': 'ctrl+w',
  });
  try {
    const { bindings, errors } = loadKeybindings(home);
    assert.equal(bindings.size, 1, 'the valid binding survives');
    assert.ok(bindings.has('c-e'));
    assert.equal(errors.length, 2, 'both bad entries are reported');
  } finally { cleanup(home); }
});

// ---------------------------------------------------------------------------
// resolution: the two failure modes
// ---------------------------------------------------------------------------

test('an unbound key passes through untouched', () => {
  const m = new Map([['c-e', { command: '/theme' }]]);
  assert.deepEqual(resolveKey('c-o', m), { key: 'c-o', command: null });
  assert.deepEqual(resolveKey('enter', m), { key: 'enter', command: null });
});

test('a key alias is followed to its target', () => {
  const m = new Map([['c-j', { key: 'enter' }]]);
  assert.deepEqual(resolveKey('c-j', m), { key: 'enter', command: null });
});

test('an alias chain is followed, and a cycle terminates', () => {
  // A cycle is a config the user can easily write by accident; it must not hang the event
  // loop, because that is a frozen UI with no error.
  const chain = new Map([['c-a', { key: 'c-b' }], ['c-b', { key: 'c-c' }], ['c-c', { key: 'enter' }]]);
  assert.deepEqual(resolveKey('c-a', chain), { key: 'enter', command: null });

  const cycle = new Map([['c-a', { key: 'c-b' }], ['c-b', { key: 'c-a' }]]);
  const r = resolveKey('c-a', cycle);
  assert.ok(['c-a', 'c-b'].includes(r.key), 'the walk stopped somewhere valid instead of looping');
  assert.equal(r.command, null);
});

test('a command binding replaces the key entirely', () => {
  // Running the command AND dispatching the original key would fire two unrelated actions
  // from one press.
  const m = new Map([['c-e', { command: '/theme' }]]);
  assert.deepEqual(resolveKey('c-e', m), { key: 'c-e', command: '/theme' });
});

test('two command bindings in a chain do not both run', () => {
  const m = new Map([['c-a', { command: '/theme' }], ['c-b', { command: '/cost' }]]);
  const r = resolveKey('c-a', m);
  assert.equal(r.command, '/theme', 'exactly one command is returned');
});

test('a missing or malformed bindings map degrades to pass-through', () => {
  // `resolveKey` is on the keypress path: it must not be able to throw.
  for (const bad of [null, undefined, {}, [], 'nope', 42]) {
    assert.deepEqual(resolveKey('enter', bad), { key: 'enter', command: null });
  }
  assert.deepEqual(resolveKey(null, new Map()), { key: '', command: null });
});

// ---------------------------------------------------------------------------
// writing and describing
// ---------------------------------------------------------------------------

test('writeKeybindings creates the directory and round-trips', () => {
  const home = tmpHome();
  try {
    // The file lives one level down in a home that does not exist yet.
    const file = writeKeybindings(home, { 'c-e': '/theme' });
    assert.ok(fs.existsSync(file), 'the file was created');
    const back = loadKeybindings(home);
    assert.equal(back.errors.length, 0);
    assert.deepEqual(back.bindings.get('c-e'), { command: '/theme' });
  } finally { cleanup(home); }
});

test('readOrEmpty returns an empty doc for a missing or broken file', () => {
  const home = tmpHome();
  try {
    assert.deepEqual(readOrEmpty(home).doc, {}, 'missing file');
    fs.writeFileSync(keybindingsFile(home), '{oops', 'utf8');
    assert.deepEqual(readOrEmpty(home).doc, {}, 'broken file does not throw');
  } finally { cleanup(home); }
});

test('the listing names the file, sorts the bindings, and shows the problems', () => {
  const home = withHome({ 'ctrl+o': 'enter', 'ctrl+e': '/theme', 'ctrl+z': 1 });
  try {
    const lines = describeKeybindings(loadKeybindings(home)).join('\n');
    assert.ok(lines.includes(keybindingsFile(home)), 'the file path is shown');
    assert.ok(lines.includes('c-e'), 'a binding is listed');
    assert.ok(lines.includes('/theme'), 'its command target is shown');
    assert.ok(lines.indexOf('c-e') < lines.indexOf('c-o'), 'sorted by source key');
    assert.ok(lines.includes('Problems:'), 'the bad entry is reported');
  } finally { cleanup(home); }
});

test('an empty listing explains how to add one', () => {
  const home = tmpHome();
  try {
    const lines = describeKeybindings(loadKeybindings(home)).join('\n');
    assert.ok(lines.includes('No keybindings set'), 'the empty state is explicit');
    assert.ok(lines.includes('/keybindings add'), 'and names the command that fixes it');
  } finally { cleanup(home); }
});

test('the file path follows HNCODE_HOME when it is set', () => {
  const prev = process.env.HNCODE_HOME;
  process.env.HNCODE_HOME = path.join(os.tmpdir(), 'hncode-home-probe');
  try {
    assert.equal(keybindingsFile(), path.join(process.env.HNCODE_HOME, 'keybindings.json'));
  } finally {
    if (prev === undefined) delete process.env.HNCODE_HOME; else process.env.HNCODE_HOME = prev;
  }
});
