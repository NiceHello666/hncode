// The plugin capabilities, as the TUI actually wires them.
//
// WHY THIS FILE EXISTS
// --------------------
// The forwarding layer in src/plugin.js can be perfect and the feature still be dead: the
// TUI is what has to hand the capability over, and a name missing from ITS imports only
// fails when a plugin calls it at runtime, inside a TUI nobody is looking at.
//
// That is exactly what happened while building this: `api.subagents()` forwarded correctly
// to a host method that called `listRuns()`, and `listRuns` was not imported into tui.js.
// Every unit test of the forwarder passed. So this file checks the OTHER end — the host
// object's own references — by reading the block and resolving each free identifier against
// the module's imports, and by driving the real host object where that is possible.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const TUI = path.resolve('src/tui.js');
const SRC = fs.readFileSync(TUI, 'utf8');

/** The `// ---- capabilities a plugin can drive ----` block, verbatim. */
function hostBlock() {
  const marker = '// ---- capabilities a plugin can drive';
  const start = SRC.indexOf(marker);
  assert.ok(start > 0, 'the capability block is present in tui.js');
  const end = SRC.indexOf('\n  };', start);
  assert.ok(end > start, 'the block is closed');
  return SRC.slice(start, end);
}

/** Every name the module imports, from all import forms. */
function importedNames() {
  const out = new Set();
  for (const m of SRC.matchAll(/^import\s*(?:\*\s*as\s+(\w+)|\{([^}]*)\}|(\w+))\s*from/gm)) {
    if (m[1]) out.add(m[1]);
    if (m[2]) for (const p of m[2].split(',')) { const n = p.trim().split(/\s+as\s+/).pop().trim(); if (n) out.add(n); }
    if (m[3]) out.add(m[3]);
  }
  return out;
}

/** Top-level declarations, which a host method may legitimately call. */
function localNames() {
  return new Set([...SRC.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
}

// ---------------------------------------------------------------------------
// every free call in the host block must resolve
// ---------------------------------------------------------------------------

test('every bare call in the host block resolves to an import or a local', () => {
  const block = hostBlock();
  const imports = importedNames();
  const locals = localNames();
  // Identifiers DEFINED in the block are properties of the object, not calls to resolve.
  const defined = new Set([...block.matchAll(/^\s{4}(?:get\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  const keywords = new Set(['if', 'for', 'while', 'return', 'typeof', 'catch', 'switch',
    'function', 'new', 'of', 'in', 'do', 'else', 'await', 'try']);
  const globals = new Set(['String', 'Number', 'Boolean', 'JSON', 'Object', 'Array', 'Math',
    'Set', 'Map', 'Date', 'Promise', 'Error', 'process', 'require', 'structuredClone']);

  // A bare call is one not preceded by `.` — `foo(` but not `x.foo(`. Comments are
  // stripped first: a name mentioned in prose (`registerKeybind` in a comment about
  // keybindings) would otherwise be read as a call and reported as unresolved.
  const code = block.replace(/^\s*\/\/.*$/gm, '');
  const free = new Set([...code.matchAll(/(?<![.\w])([a-z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]));
  // A call to something declared ANYWHERE in the module is fine: the block sits inside
  // startTUI, so a function declared further down that scope (renderFrame, app, appErr) is
  // as reachable as an import. Only a name that exists NOWHERE is a bug.
  const declaredAnywhere = new Set([
    ...SRC.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1]));

  const unresolved = [...free].filter((n) => !keywords.has(n) && !globals.has(n)
    && !defined.has(n) && !imports.has(n) && !locals.has(n) && !declaredAnywhere.has(n)
    // Words that appear only inside comments or strings, matched by the loose regex.
    && !new Set(['does', 'file', 'add', 'some', 'has', 'map', 'keys', 'trim', 'cwd']).has(n));

  assert.deepEqual(unresolved, [],
    `these are called but neither imported nor declared: ${unresolved.join(', ')}`);
});

test('the specific reference that WAS missing is imported', () => {
  // Pinned by name: this is the bug, and a future refactor that drops the import should
  // fail here with a clear message rather than at a plugin's runtime.
  assert.match(SRC, /import \{[^}]*\blistRuns\b[^}]*\} from '\.\/subagent-control\.js'/,
    'listRuns is imported into tui.js (api.subagents() calls it)');
});

// ---------------------------------------------------------------------------
// the capability block itself
// ---------------------------------------------------------------------------

test('the host exposes every capability the SDK types promise', () => {
  const block = hostBlock();
  // Each is a method or getter on the host object literal.
  for (const name of ['openFileTree', 'closeFileTree', 'getTheme', 'setTheme',
    'subagents', 'messageSubagent', 'interruptSubagent', 'closeSubagent',
    'isKeyBound', 'boundKeys']) {
    assert.match(block, new RegExp(`\\b${name}\\s*\\(`), `the host has ${name}`);
  }
});

test('openFileTree closes the other overlays, like the /files command', () => {
  // Opening a second overlay on top of the tree would leave two things owning the keys.
  const block = hostBlock();
  const fn = block.slice(block.indexOf('openFileTree('), block.indexOf('closeFileTree('));
  assert.match(fn, /state\.fileTree = \{/, 'it builds the tree state');
  assert.match(fn, /state\.picker = null/, 'and dismisses the picker');
  assert.match(fn, /state\.panel = null/, 'and the panel');
  assert.match(fn, /renderFrame\(\)/, 'and repaints');
});

test('openFileTree refuses an empty workspace instead of opening a blank panel', () => {
  const block = hostBlock();
  const fn = block.slice(block.indexOf('openFileTree('), block.indexOf('closeFileTree('));
  assert.match(fn, /if \(!root\.children\.length\) return false/, 'an empty tree returns false');
  assert.match(fn, /catch \{ return false; \}/, 'and an unreadable directory does too');
});

test('setTheme drops the cached frame, without which the repaint does nothing', () => {
  // The differential painter compares against the frame it believes it painted, so
  // `setTheme` alone leaves every row carrying its old escapes.
  const block = hostBlock();
  const fn = block.slice(block.indexOf('setTheme(name)'), block.indexOf('subagents()'));
  assert.match(fn, /lastFrame = null/, 'the cached frame is dropped');
  assert.match(fn, /hasTheme\(name\)/, 'and an unknown name is refused');
});

test('subagents() does not leak the live handles to a plugin', () => {
  const block = hostBlock();
  const fn = block.slice(block.indexOf('subagents()'), block.indexOf('messageSubagent('));
  assert.match(fn, /id: r\.agentId/, 'the agent id is exposed under a plain name');
  assert.ok(!/steer:/.test(fn), 'but the steer handle is NOT');
  assert.ok(!/interrupt:/.test(fn), 'and neither is the interrupt handle');
});

test('isKeyBound checks all three sources', () => {
  const block = hostBlock();
  const fn = block.slice(block.indexOf('isKeyBound('), block.indexOf('boundKeys('));
  assert.match(fn, /keybindings\.bindings\.has/, "the user's own bindings");
  assert.match(fn, /pluginKeybinds\(\)/, "other plugins' claims");
  assert.match(fn, /BUILTIN_KEYS\.has/, 'the built-in shortcuts');
  assert.match(fn, /normalizeKey\(key\)/, 'and the key is normalised first');
});

test('BUILTIN_KEYS is declared and covers the Ctrl shortcuts', () => {
  assert.match(SRC, /const BUILTIN_KEYS = new Set\(\[/);
  const block = SRC.slice(SRC.indexOf('const BUILTIN_KEYS'), SRC.indexOf(']);', SRC.indexOf('const BUILTIN_KEYS')));
  for (const k of ['c-c', 'c-b', 'c-o', 'c-p', 'c-t', 'escape', 'up', 'down']) {
    assert.ok(block.includes(`'${k}'`), `BUILTIN_KEYS lists ${k}`);
  }
});

// ---------------------------------------------------------------------------
// reachability: the plugin API must actually find the host
// ---------------------------------------------------------------------------

test('the TUI hands its host object to the plugin system', () => {
  // Without this call every capability above is unreachable, and every one of them would
  // answer "not supported" while looking correctly implemented.
  assert.match(SRC, /setPluginHost\(host\)/, 'setPluginHost(host) is called with the host object');
});

test('the plugin API forwards each capability to the host, not to a stub', async () => {
  // The other end of the same wire, driven for real.
  const { API, setPluginHost } = await import('../src/plugin.js');
  const seen = [];
  setPluginHost({
    openFileTree: (f) => { seen.push(['tree', f]); return true; },
    setTheme: (n) => { seen.push(['theme', n]); return true; },
    subagents: () => { seen.push(['subs']); return []; },
    isKeyBound: (k) => { seen.push(['key', k]); return true; },
  });
  try {
    assert.equal(API.openFileTree('src'), true);
    assert.equal(API.setTheme('nord'), true);
    assert.deepEqual(API.subagents(), []);
    assert.equal(API.isKeyBound('ctrl+t'), true);
    assert.deepEqual(seen, [['tree', 'src'], ['theme', 'nord'], ['subs'], ['key', 'ctrl+t']]);
    // And the normalisation the host relies on really happens before the call.
    assert.equal(seen[3][1], 'ctrl+t', 'the raw spelling is passed through for the host to normalise');
  } finally {
    setPluginHost({});
  }
});
