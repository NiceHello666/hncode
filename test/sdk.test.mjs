// The plugin SDK against the live host.
//
// WHY THESE ASSERTIONS
// --------------------
// The SDK is a promise about the host, and it is a promise nothing was checking. Three
// separate drifts were found by hand while writing this file:
//
//   * `api.log` / `info` / `warn` / `error` were declared as four members, while the host
//     exposes ONE callable object — so `api.info(...)` was `undefined` and a plugin
//     following the docs crashed on its first log line;
//   * six introspection getters (`tools`, `commands`, `hooks`, `config`, `plugins`) were
//     on the host and absent from the types, so `api.tools` did not complete;
//   * the host fires ten lifecycle hooks while `HOOK_NAMES` listed seven.
//
// A type file cannot be tested by reading it, so the key check here LOADS A REAL PLUGIN
// through the real loader and probes every key the types declare. That is the only way
// the promise and the delivery get compared.
//
// `targets.js` is checked the other way: the generator must produce targets that the
// patch loader can actually address, which means one file level under src/ and nothing
// nested (see the loader in src/patch.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SDK = await import('../hncode-sdk/index.js');
const { PATCH_TARGETS, PATCH_TARGET_SET, isPatchTarget, GENERATED_FROM } = await import('../hncode-sdk/targets.js');
const { loadPlugins } = await import('../src/plugin.js');

// Every key `HncodePluginApi` declares. Hand-listed rather than parsed: a regex cannot see
// `readJSON<T>(...)`, and a parser that silently skips a line would hide exactly the drift
// this file exists to catch.
const DECLARED_API_KEYS = [
  'registerTool', 'registerCommand', 'registerHook', 'registerConfig',
  'ctx', 'provide', 'get', 'has', 'require', 'serviceNames', 'onDispose',
  'addSkill', 'skills', 'removeSkill',
  'sendPrompt', 'addMessage', 'getMessages', 'clearSession', 'saveSession', 'quit',
  'notice', 'openPanel', 'openEditor', 'openPicker', 'openForm',
  'openTasksPanel', 'openRegistryBrowser',
  'getConfig', 'setConfig', 'persistConfig',
  'readFile', 'writeFile', 'readJSON', 'writeJSON',
  'registerKeybind', 'registerTuiWidget', 'isKeyBound', 'boundKeys',
  'openFileTree', 'closeFileTree',
  'themeNames', 'getTheme', 'setTheme',
  'subagents', 'messageSubagent', 'interruptSubagent', 'closeSubagent',
  'patch', 'patchSeams',
  'tools', 'commands', 'hooks', 'config', 'plugins',
  'log',
];

// ---------------------------------------------------------------------------
// the API surface
// ---------------------------------------------------------------------------

/** Load a plugin that records what it saw, and return that record. */
async function probeHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-sdk-test-'));
  // A UNIQUE global name per probe: the module cache is shared across tests in a file, so a
  // fixed name would let an earlier probe's record be read by a later test.
  const g = `__probe_${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(path.join(dir, 'probe.js'), `
export default {
  name: 'probe', version: '1.0.0',
  install(api) {
    const seen = {};
    for (const k of ${JSON.stringify(DECLARED_API_KEYS)}) seen[k] = typeof api[k];
    seen['log as a function'] = typeof api.log;
    seen['log.log'] = api.log ? typeof api.log.log : 'undefined';
    seen['log.info'] = api.log ? typeof api.log.info : 'undefined';
    seen['log.warn'] = api.log ? typeof api.log.warn : 'undefined';
    seen['log.error'] = api.log ? typeof api.log.error : 'undefined';
    globalThis.${g} = { seen, api };
  },
};
`, 'utf8');
  await loadPlugins(dir, { fresh: true });
  const out = globalThis[g];
  delete globalThis[g];
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('every key the SDK declares exists on the host', async () => {
  const { seen } = await probeHost();
  const missing = Object.entries(seen).filter(([, t]) => t === 'undefined').map(([k]) => k);
  assert.deepEqual(missing, [],
    `the types promise these and the host does not provide them: ${missing.join(', ')}`);
});

test('the logger is BOTH callable and carrying methods', async () => {
  // This is the shape that was wrong: four separate members were declared, so a plugin
  // written against the docs called `api.info(...)` and hit `undefined`.
  const { seen, api } = await probeHost();
  assert.equal(seen['log as a function'], 'function', 'api.log(...) works');
  assert.equal(seen['log.log'], 'function');
  assert.equal(seen['log.info'], 'function');
  assert.equal(seen['log.warn'], 'function');
  assert.equal(seen['log.error'], 'function');
  // And no separate members are claimed any more.
  assert.equal(api.info, undefined, 'api.info is NOT a member — the types must not say it is');
  assert.equal(api.warn, undefined);
  assert.equal(api.error, undefined);
});

test('the introspection getters return the shapes the types describe', async () => {
  const { api } = await probeHost();
  assert.ok(Array.isArray(api.tools), 'tools is an array');
  assert.ok(Array.isArray(api.commands), 'commands is an array');
  assert.ok(Array.isArray(api.plugins), 'plugins is an array');
  assert.ok(Array.isArray(api.patchSeams), 'patchSeams is an array');
  assert.equal(typeof api.hooks, 'object');
  assert.equal(typeof api.config, 'object');
});

test('the introspection getters are live views, not stale copies', async () => {
  // A plugin uses `api.tools` to avoid a name collision; a snapshot taken at install time
  // would be exactly wrong for that.
  const { api } = await probeHost();
  const before = api.commands.length;
  api.registerCommand({ name: 'probe-live-view', description: 'x', run: () => 'ok' });
  assert.equal(api.commands.length, before + 1, 'the new command shows up immediately');
  assert.ok(api.commands.some((c) => c.name === 'probe-live-view'));
});

test('the declared hook list matches the hooks the host fires', async () => {
  // The host fires ten; HOOK_NAMES listed seven. A plugin registering `onShutdown` got no
  // completion and no membership test, even though the host calls it.
  const fired = new Set();
  const srcDir = path.resolve('src');
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of text.matchAll(/runHooks\(\s*'([A-Za-z]+)'/g)) fired.add(m[1]);
  }
  // onSessionSave is dispatched through a dynamically-imported runHooks in tui.js.
  for (const m of fs.readFileSync(path.join(srcDir, 'tui.js'), 'utf8').matchAll(/runHooks\(\s*'([A-Za-z]+)'/g)) {
    fired.add(m[1]);
  }
  const missing = [...fired].filter((h) => !SDK.HOOK_NAMES.includes(h));
  assert.deepEqual(missing, [], `the host fires these and HOOK_NAMES omits them: ${missing.join(', ')}`);
});

test('HOOK_NAMES is a Set-able list with no duplicates', () => {
  assert.equal(SDK.HOOK_NAME_SET.size, SDK.HOOK_NAMES.length, 'no duplicate hook names');
  for (const h of SDK.HOOK_NAMES) assert.ok(SDK.HOOK_NAME_SET.has(h));
});

// ---------------------------------------------------------------------------
// the patch target list
// ---------------------------------------------------------------------------

test('the generated target list is non-empty and names real files', () => {
  assert.ok(PATCH_TARGETS.length > 100, `expected a substantial list, got ${PATCH_TARGETS.length}`);
  const srcDir = path.resolve('src');
  const files = new Set(fs.readdirSync(srcDir));
  for (const t of PATCH_TARGETS.slice(0, 200)) {
    const file = t.split('#')[0];
    assert.ok(files.has(file), `${t} names a file that does not exist in src/`);
  }
});

test('every target is one the patch loader can address', () => {
  // The loader rewrites src/<file>.js only, so a target naming a nested path
  // (src/tools/x.js) or a bad shape could never be applied — it would be advertised and
  // then silently skipped.
  assert.ok(isPatchTarget(PATCH_TARGETS[0]), 'membership works for a real target');
  assert.equal(isPatchTarget('nope.js#nope'), false);
  for (const t of PATCH_TARGETS) {
    assert.match(t, /^[\w.-]+\.js#[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/,
      `${t} is not "file.js#symbol" or "file.js#Class.method"`);
    assert.ok(!t.includes('/'), `${t} is nested; the loader only reaches src/*.js`);
  }
});

test('a target the generator emits is one the loader parses', async () => {
  const { parseTarget } = await import('../src/patch.js');
  for (const t of PATCH_TARGETS.slice(0, 300)) {
    assert.ok(parseTarget(t), `the loader cannot parse the generated target ${t}`);
  }
});

test('PATCH_TARGET_SET agrees with PATCH_TARGETS', () => {
  assert.equal(PATCH_TARGET_SET.size, PATCH_TARGETS.length, 'the Set holds exactly the list');
  for (const t of PATCH_TARGETS) assert.ok(PATCH_TARGET_SET.has(t));
});

test('the generated files record what they were generated from', () => {
  assert.match(GENERATED_FROM, /src\//, 'the footer names the source directory');
  assert.match(GENERATED_FROM, /\d+ files/);
  assert.match(GENERATED_FROM, /\d+ symbols/);
});

test('the generated targets include the new modules', () => {
  // The point of re-running `npm run gen`: modules added since the last generation have to
  // appear, or a plugin cannot patch them.
  for (const file of ['doctor.js', 'keybindings.js', 'lsp.js', 'notebook.js', 'file-tree.js', 'subagent-control.js']) {
    assert.ok(PATCH_TARGETS.some((t) => t.startsWith(`${file}#`)),
      `${file} has no patchable target — re-run npm run gen`);
  }
});

// ---------------------------------------------------------------------------
// the runtime helpers
// ---------------------------------------------------------------------------

test('definePlugin validates the fields the loader requires', () => {
  const good = { name: 'x', version: '1.0.0', install() {} };
  assert.equal(SDK.definePlugin(good), good, 'a valid plugin passes through unchanged');
  assert.throws(() => SDK.definePlugin(null), /expected an object/);
  assert.throws(() => SDK.definePlugin({ version: '1', install() {} }), /`name` is required/);
  assert.throws(() => SDK.definePlugin({ name: 'x', install() {} }), /`version` is required/);
  assert.throws(() => SDK.definePlugin({ name: 'x', version: '1' }), /must be a function/);
});

test('parsePatchTarget splits both target shapes and rejects the rest', () => {
  assert.deepEqual(SDK.parsePatchTarget('llm.js#LLM.requestText'),
    { file: 'llm.js', base: 'LLM', method: 'requestText', id: 'llm.js#LLM.requestText' });
  assert.deepEqual(SDK.parsePatchTarget('git.js#commit'),
    { file: 'git.js', base: 'commit', method: null, id: 'git.js#commit' });
  // The parser is PERMISSIVE about the file part — it is the LOADER that only reaches
  // src/*.js (see src/patch.js). Asserting a rejection here would be asserting something
  // the function never did; the nesting rule is checked above, on the generated list.
  assert.deepEqual(SDK.parsePatchTarget('a/b.js#x'),
    { file: 'a/b.js', base: 'x', method: null, id: 'a/b.js#x' });
  for (const bad of ['', 'nope', '#x', 'a.js#', null]) {
    assert.equal(SDK.parsePatchTarget(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('the legacy seam list matches the loader’s', async () => {
  // The SDK's list is what a plugin author reads; the loader's is what works. Two lists
  // that drift means a documented seam that does nothing.
  const { LEGACY_SEAMS: loaderSeams } = await import('../src/patch.js');
  assert.deepEqual([...SDK.LEGACY_SEAMS].sort(), [...loaderSeams].sort());
  assert.equal(SDK.LEGACY_SEAM_SET.size, SDK.LEGACY_SEAMS.length);
});

test('the notice kinds match what the host accepts', () => {
  assert.deepEqual(SDK.NOTICE_KINDS, ['info', 'warn', 'error']);
});
