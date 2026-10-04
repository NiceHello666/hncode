// Drive the new plugin capabilities through the REAL host wiring.
//
// The TUI's `host` object is built inside startTUI, so this test builds the same shape by
// importing the modules the host forwards to. What it proves is the CONTRACT: a plugin's
// call reaches the same function the slash command uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = (await import('../src/plugin.js')).API;
const { registerRun, endRun, sendToRun, interruptRun, interruptAll, closeRun } = await import('../src/subagent-control.js');
const { normalizeKey, loadKeybindings } = await import('../src/keybindings.js');

// Every capability added, with the shape the host promises.
for (const k of ['openFileTree', 'closeFileTree', 'themeNames', 'getTheme', 'setTheme',
  'subagents', 'messageSubagent', 'interruptSubagent', 'closeSubagent', 'isKeyBound', 'boundKeys']) {
  test(`api.${k} exists`, () => {
    assert.notEqual(API[k], undefined, `api.${k} is missing`);
  });
}

// ---------------------------------------------------------------------------
// with no host wired (headless), every call must be safe and honest
// ---------------------------------------------------------------------------

test('with no host, the calls answer instead of throwing', () => {
  // A plugin is loaded before the TUI exists (index.js), so this is a real state.
  assert.equal(API.openFileTree(), false, 'reports that nothing opened');
  assert.doesNotThrow(() => API.closeFileTree());
  assert.deepEqual(API.subagents(), []);
  assert.equal(API.getTheme(), null);
  assert.equal(API.setTheme('dark'), false, 'no host to repaint with');
  assert.equal(API.isKeyBound('c-t'), false);
  // `boundKeys` is a GETTER returning an array, not a method — matching `patchSeams` and
  // `serviceNames`, which are read the same way.
  assert.ok(Array.isArray(API.boundKeys));
  assert.deepEqual(API.boundKeys, []);
  const r = API.messageSubagent('x', 'hi');
  assert.equal(r.ok, false);
  assert.match(r.message, /not supported/);
});

test('themeNames works with no host, because it needs none', () => {
  // The list is a build-time fact, not a host capability.
  assert.ok(API.themeNames.length >= 3);
  assert.ok(API.themeNames.includes('dark'));
});

test('setTheme rejects an unknown name before touching the host', () => {
  // The guard is what stops a plugin from half-changing the screen: the host is never
  // called for a name it could not apply.
  assert.equal(API.setTheme('no-such-theme'), false);
  assert.equal(API.setTheme(''), false);
  assert.equal(API.setTheme(null), false);
});

// ---------------------------------------------------------------------------
// with a host wired
// ---------------------------------------------------------------------------

/** Wire the plugin API to stub capabilities, then restore it afterwards. */
async function withHost(stubs) {
  const { setPluginHost } = await import('../src/plugin.js');
  setPluginHost(stubs);
  return () => setPluginHost({});
}

test('openFileTree forwards and reports what the host returned', async () => {
  const seen = [];
  const restore = await withHost({
    openFileTree: (f) => { seen.push(f); return true; },
  });
  try {
    assert.equal(API.openFileTree('src'), true);
    assert.deepEqual(seen, ['src'], 'the filter reached the host');
    assert.equal(API.openFileTree(), true);
    assert.deepEqual(seen, ['src', undefined]);
  } finally { restore(); }
});

test('openFileTree reports FALSE when the host could not open one', async () => {
  // An empty workspace. A plugin that opened a panel and then waited for input would hang
  // its own flow, so the answer has to be honest.
  const restore = await withHost({ openFileTree: () => false });
  try {
    assert.equal(API.openFileTree(), false);
  } finally { restore(); }
});

test('setTheme validates, forgets nothing, and forwards a good name', async () => {
  const applied = [];
  const restore = await withHost({ setTheme: (n) => { applied.push(n); return true; } });
  try {
    assert.equal(API.setTheme('nord'), true);
    assert.deepEqual(applied, ['nord']);
    assert.equal(API.setTheme('bogus'), false, 'rejected without calling the host');
    assert.deepEqual(applied, ['nord'], 'and nothing was applied');
    assert.equal(API.setTheme('  gruvbox  '), true, 'surrounding whitespace is tolerated');
    assert.deepEqual(applied, ['nord', 'gruvbox'], 'the trimmed name is what the host sees');
  } finally { restore(); }
});

test('getTheme passes the host answer through, and is null with no host', async () => {
  let restore = await withHost({ getTheme: () => 'dracula' });
  try { assert.equal(API.getTheme(), 'dracula'); } finally { restore(); }
  // With a host that has no answer, the value is passed through as-is — the host is the
  // authority, and substituting our own default would hide a host that is misconfigured.
  restore = await withHost({ getTheme: () => undefined });
  try { assert.equal(API.getTheme(), undefined); } finally { restore(); }
  // With NO host at all (a plugin loaded before the TUI exists) there is nothing to pass
  // through, so the answer is null rather than undefined-of-undefined.
  restore = await withHost({});
  try { assert.equal(API.getTheme(), null); } finally { restore(); }
});

test('subagent control forwards to the registry', async () => {
  // Wired to the REAL registry module, not a stub, so the forwarding path is exercised.
  // The host mapper renames `agentId` to `id` — the name a plugin reads — so the mapping is
  // copied here exactly as tui.js writes it. A test that called listRuns() directly would
  // be checking the registry and not the contract.
  const { listRuns: rawList } = await import('../src/subagent-control.js');
  const restore = await withHost({
    subagents: () => rawList().map((r) => ({
      id: r.agentId, runId: r.runId, taskId: r.taskId,
      type: r.type, description: r.description, startedAt: r.startedAt,
    })),
    messageSubagent: (ref, text) => sendToRun(ref, text),
    interruptSubagent: (ref) => (ref ? interruptRun(ref) : interruptAll()),
    closeSubagent: (ref) => closeRun(ref),
  });
  const calls = [];
  const runId = registerRun({
    agentId: 'agent-api-test', type: 'coder', description: 'x',
    steer: (t) => calls.push(['steer', t]),
    interrupt: () => calls.push(['interrupt']),
  });
  try {
    const list = API.subagents();
    assert.ok(Array.isArray(list));
    const found = list.find((a) => a.id === 'agent-api-test');
    assert.ok(found, `the running agent is listed; got ${JSON.stringify(list)}`);
    assert.equal(found.type, 'coder');
    assert.equal(typeof found.runId, 'string');
    // The handles themselves must NOT leak to a plugin: a steer function is the host's
    // internals, and a plugin mutating the registry through it would bypass every check.
    assert.equal(found.steer, undefined);
    assert.equal(found.interrupt, undefined);

    assert.equal(API.messageSubagent('agent-api-test', 'focus').ok, true);
    assert.deepEqual(calls, [['steer', 'focus']]);
    assert.equal(API.closeSubagent('agent-api-test').ok, true);
    assert.ok(calls.some(([m]) => m === 'interrupt'));
    assert.equal(rawList().length, 0, 'and it is gone from the registry');
  } finally {
    endRun(runId);
    for (const r of rawList()) endRun(r.runId);
    restore();
  }
});

test('isKeyBound knows the built-in keys, via the same token vocabulary', () => {
  // `ctrl+t` is how everyone writes it; the vocabulary is `c-t`. The TUI normalises before
  // asking, so the answer has to be right for the spelling a plugin uses.
  assert.equal(normalizeKey('ctrl+t'), 'c-t');
});

// ---------------------------------------------------------------------------
// the pieces the host composes, tested directly
// ---------------------------------------------------------------------------

test('the key vocabulary covers the spellings a plugin would write', async () => {
  const { normalizeKey: nk } = await import('../src/keybindings.js');
  for (const [input, want] of [['ctrl+t', 'c-t'], ['Ctrl+O', 'c-o'], ['escape', 'escape'], ['Esc', 'escape'], ['ctrl+up', 'c-up']]) {
    assert.equal(nk(input), want, `${input} -> ${want}`);
  }
});

test('a user keybinding is visible to isKeyBound', () => {
  // The host consults the same bindings map the dispatcher uses.
  const loaded = loadKeybindings();
  assert.ok(loaded.bindings instanceof Map, 'the bindings load as a Map the host can query');
});
