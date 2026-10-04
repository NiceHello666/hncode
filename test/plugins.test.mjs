// Tests for plugin composition: `inject` load order, services, teardown and reload.
//
// Why this file exists: the loader used to run plugins in directory order, kept no
// record of what each one registered, and had no way to take a plugin back out. All
// three failures are silent — a dependent plugin starts before its dependency and
// simply does not work, and a reloaded plugin leaves its previous registrations
// behind. Neither shows up as an error anywhere, so they are tested here.
//
// Testing principle: each plugin is a real file on disk loaded through the real
// loader. A stubbed loader would not exercise import ordering, the metadata exports
// or the ESM cache — which is where the reload bug lives.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPlugins, unloadPlugins, listPluginServices, takePluginNotices,
  pluginTools, pluginCommands, pluginKeybinds, pluginConfigDefaults, pluginLoaded,
  API, _resetPlugins,
} from '../src/plugin.js';

let seq = 0;
/** A fresh, empty plugin directory. */
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hncode-p-${process.pid}-${++seq}-`));
  return dir;
}

/** Write a plugin file. `body` is the module source, minus the metadata exports. */
function writePlugin(dir, file, body) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  return full;
}

/** Metadata + an install that records the order it ran in. */
function marker(name, extra = '') {
  return `export default { name: ${JSON.stringify(name)}, version: '1.0.0' };\n${extra}`;
}

const errors = (notes) => notes.filter((n) => n.level === 'error').map((n) => n.text);

test('inject orders a dependent plugin AFTER the one providing its service', async () => {
  // The whole point: `aaa-dependent` sorts FIRST alphabetically and still must run
  // after `zzz-provider`, because it injects the service the latter provides.
  const dir = tmpDir();
  writePlugin(dir, 'aaa-dependent/index.js', marker('dependent', `
export const inject = ['db'];
export function install(api) {
  if (!api.has('db')) throw new Error('db was not ready');
  api.provide('consumer', { rows: api.require('db').rows });
  api.registerCommand({ name: 'consume', run: () => 'ok' });
}
`));
  writePlugin(dir, 'zzz-provider/index.js', marker('provider', `
export const provides = ['db'];
export function install(api) {
  api.provide('db', { rows: 3 });
}
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded.map((p) => p.name), ['provider', 'dependent']);
  assert.deepEqual(errors(takePluginNotices()), []);
  assert.deepEqual(listPluginServices().sort(), ['consumer', 'db']);
  assert.ok(pluginCommands.some((c) => c.name === 'consume'), 'the dependent plugin registered its command');
});

test('a plugin whose dependency nobody provides is skipped, not started half-wired', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'needy/index.js', marker('needy', `
export const inject = ['nope'];
export function install(api) {
  api.registerTool({ name: 'Never', description: 'x', execute: () => 'y' });
}
`));
  writePlugin(dir, 'fine/index.js', marker('fine', `
export function install(api) { api.registerTool({ name: 'Fine', description: 'x', execute: () => 'y' }); }
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded.map((p) => p.name), ['fine'], 'only the satisfiable plugin loads');
  assert.ok(!pluginTools.some((t) => t.name === 'Never'), 'the skipped plugin registered nothing');
  assert.ok(pluginTools.some((t) => t.name === 'Fine'), 'the other plugin still loaded');
  const msgs = errors(takePluginNotices());
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /needy\/index\.js: missing dependency/);
  assert.match(msgs[0], /nothing provides "nope"/);
});

test('a chain of dependents falls with its missing root, reported as missing not as a cycle', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'c/index.js', marker('c', `
export const inject = ['b'];
export function install(api) { api.provide('c', 1); }
`));
  writePlugin(dir, 'b/index.js', marker('b', `
export const provides = ['b'];
export const inject = ['a'];
export function install(api) { api.provide('b', 1); }
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded, []);
  const msgs = errors(takePluginNotices());
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => /missing dependency/.test(m)), 'a dependent of a dropped plugin is missing, not circular');
});

test('a circular inject is reported as a cycle and neither plugin starts', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'p/index.js', marker('p', `
export const provides = ['p']; export const inject = ['q'];
export function install(api) { api.provide('p', 1); }
`));
  writePlugin(dir, 'q/index.js', marker('q', `
export const provides = ['q']; export const inject = ['p'];
export function install(api) { api.provide('q', 1); }
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded, []);
  const msgs = errors(takePluginNotices());
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => /circular/.test(m)));
  assert.deepEqual(listPluginServices(), [], 'a plugin in a cycle provides nothing');
});

test('providing a name twice is an error rather than a silent overwrite', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'a/index.js', marker('a', `
export const provides = ['shared'];
export function install(api) { api.provide('shared', 1); }
`));
  writePlugin(dir, 'b/index.js', marker('b', `
export const provides = ['shared'];
export function install(api) { api.provide('shared', 2); }
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded.map((p) => p.name), ['a'], 'the second provider failed to install');
  const msgs = errors(takePluginNotices());
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /b\/index\.js failed to install/);
  assert.match(msgs[0], /already provided by a/);
  assert.equal(API.get('shared'), 1, 'the first provider keeps the name');
});

test('an install that throws leaves none of its registrations behind', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'half/index.js', marker('half', `
export function install(api) {
  api.registerTool({ name: 'HalfTool', description: 'x', execute: () => 'y' });
  api.registerConfig({ half_key: 1 });
  api.provide('half', {});
  api.registerKeybind('c-q', () => {});
  throw new Error('boom');
}
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded, []);
  assert.ok(!pluginTools.some((t) => t.name === 'HalfTool'), 'the tool was rolled back');
  assert.equal(pluginConfigDefaults.half_key, undefined, 'the config default was rolled back');
  assert.deepEqual(listPluginServices(), [], 'the service was rolled back');
  assert.equal(pluginKeybinds.length, 0, 'the keybind was rolled back');
  assert.match(errors(takePluginNotices())[0], /failed to install: boom/);
});

test('unloadPlugins undoes registrations, config, services and keybinds in one call', async () => {
  const dir = tmpDir();
  const log = [];
  // The disposer writes into a file the test can read, because the module instance
  // that holds the array is discarded by the next load.
  const logFile = path.join(dir, 'log.txt');
  writePlugin(dir, 'thing/index.js', marker('thing', `
import fs from 'node:fs';
export const provides = ['thing'];
const record = (s) => fs.appendFileSync(${JSON.stringify(logFile)}, s + '\\n');
export function install(api) {
  api.provide('thing', { v: 1 });
  api.registerTool({ name: 'Thing', description: 'x', execute: () => 'y' });
  api.registerCommand({ name: 'thing', run: () => 'y' });
  api.registerConfig({ thing_key: 'set' });
  api.registerKeybind('c-j', () => {});
  api.onDispose(() => record('onDispose'));
}
export function dispose() { record('dispose'); }
`));

  await loadPlugins(dir);
  assert.equal(pluginTools.length, 1);
  assert.equal(pluginConfigDefaults.thing_key, 'set');
  assert.equal(pluginKeybinds.length, 1);
  assert.equal(pluginConfigDefaults.thing_key, 'set');

  const { unloaded, failed } = await unloadPlugins();
  assert.deepEqual(unloaded, ['thing']);
  assert.deepEqual(failed, []);
  assert.deepEqual(pluginTools, []);
  assert.deepEqual(pluginCommands, []);
  assert.deepEqual(pluginLoaded, []);
  assert.equal(pluginConfigDefaults.thing_key, undefined);
  assert.equal(pluginKeybinds.length, 0);
  assert.deepEqual(listPluginServices(), []);

  // Order matters: dispose() runs while the registrations still exist, and the
  // onDispose callback after it — both are how a plugin flushes state out.
  assert.deepEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n'), ['dispose', 'onDispose']);
});

test('reloading picks up an EDIT to a plugin file (the ESM cache is bypassed)', async () => {
  const dir = tmpDir();
  const file = writePlugin(dir, 'edit-me/index.js', marker('edit-me', `
export function install(api) { api.registerCommand({ name: 'version1', run: () => 1 }); }
`));

  await loadPlugins(dir);
  assert.ok(pluginCommands.some((c) => c.name === 'version1'));

  fs.writeFileSync(file, marker('edit-me', `
export function install(api) { api.registerCommand({ name: 'version2', run: () => 2 }); }
`), 'utf8');

  // Without `fresh`, Node hands back the cached module and nothing changes — the
  // reason the reload path passes the flag.
  await loadPlugins(dir);
  assert.ok(pluginCommands.some((c) => c.name === 'version1'), 'a plain reload reuses the cached module');

  await loadPlugins(dir, { fresh: true });
  assert.ok(!pluginCommands.some((c) => c.name === 'version1'), 'the old command is gone');
  assert.ok(pluginCommands.some((c) => c.name === 'version2'), 'the edited command is live');
});

test('a plugin removed from disk is unloaded by the next load', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'gone/index.js', marker('gone', `
export function install(api) { api.registerCommand({ name: 'gone', run: () => 1 }); }
`));
  writePlugin(dir, 'stays/index.js', marker('stays', `
export function install(api) { api.registerCommand({ name: 'stays', run: () => 1 }); }
`));

  await loadPlugins(dir);
  assert.equal(pluginCommands.length, 2);

  fs.rmSync(path.join(dir, 'gone'), { recursive: true, force: true });
  const loaded = await loadPlugins(dir, { fresh: true });
  assert.deepEqual(loaded.map((p) => p.name), ['stays']);
  assert.deepEqual(pluginCommands.map((c) => c.name), ['stays'], 'the removed plugin took its registrations with it');
});

test('a version-less plugin is still refused, and now also without an install', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'no-version/index.js', 'export function install() {}\n');
  writePlugin(dir, 'no-install/index.js', marker('no-install'));
  writePlugin(dir, 'ok/index.js', marker('ok', `
export function install(api) { api.registerCommand({ name: 'ok', run: () => 1 }); }
`));

  const loaded = await loadPlugins(dir);
  assert.deepEqual(loaded.map((p) => p.name), ['ok']);
  const msgs = errors(takePluginNotices());
  assert.equal(msgs.length, 2);
  assert.ok(msgs.some((m) => /missing or invalid `version`/.test(m)));
  assert.ok(msgs.some((m) => /no install\(api\) function/.test(m)));
});

test('an async install is awaited, so its registrations land before the load returns', async () => {
  // Not awaited, an install that registers after an await would race the next
  // plugin's install and its tool would appear only once it happened to resume.
  const dir = tmpDir();
  writePlugin(dir, 'slow/index.js', marker('slow', `
export async function install(api) {
  await new Promise((r) => setTimeout(r, 5));
  api.registerTool({ name: 'Slow', description: 'x', execute: () => 'y' });
}
`));

  await loadPlugins(dir);
  assert.ok(pluginTools.some((t) => t.name === 'Slow'), 'the awaited registration is present');
});

test('_resetPlugins clears the units and services too, not just the registries', async () => {
  const dir = tmpDir();
  writePlugin(dir, 'x/index.js', marker('x', `
export const provides = ['x'];
export function install(api) {
  api.provide('x', 1);
  api.registerTool({ name: 'X', description: 'd', execute: () => 'y' });
}
`));
  await loadPlugins(dir);
  assert.deepEqual(listPluginServices(), ['x']);

  _resetPlugins();
  assert.deepEqual(listPluginServices(), []);
  assert.deepEqual(pluginTools, []);
  assert.deepEqual(takePluginNotices(), []);
});
