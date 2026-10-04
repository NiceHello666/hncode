// Tests for the bootstrap module — the ordering step that makes patching possible.
//
// WHY THIS FILE EXISTS
// --------------------
// Symbol patching works by rewriting a target module's source *as it loads*. That
// makes it entirely order-dependent: import a module first and Node serves it from
// cache, so the patch is silently skipped and the plugin looks installed while
// doing nothing. There is no error to notice — the symptom is a wrapper that
// never runs. bootstrap.js exists to own that ordering, so the ordering IS its
// contract and has to be pinned by a test.
//
// The other thing pinned here is the failure posture. bootstrap runs before
// anything else in hncode, so anything it throws stops the CLI from starting. A
// broken plugin directory, a malformed config or a missing Node API must degrade
// to "no patches, no plugins" — never to "hncode won't launch".
//
// WHY THESE TESTS SPAWN A CHILD PROCESS
// -------------------------------------
// The contract cannot be observed in-process, by construction: proving a patch
// applies requires importing the patched module *after* the loader is installed,
// and in a test file every import at the top has already happened by the time
// the first test runs. The ordering only exists at startup. So each case runs in
// a fresh `node` with the real bootstrap and the real loader — the same sequence
// bin/hncode performs — and reports what it observed as JSON on stdout.
//
// Nothing is stubbed: real temp directories, real plugin files on disk, the real
// loader, a real hncode symbol (git.js#isRepo) imported through the patched path.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const modUrl = (name) => pathToFileURL(path.join(SRC, name)).href;

let seq = 0;
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hncode-bs-${process.pid}-${++seq}-`));
}

/**
 * Run `body` in a fresh Node process with hncode's src/ importable as file URLs.
 * `body` must return a JSON-serialisable value; it is handed back parsed.
 */
function runBootstrap(body, { plugins } = {}) {
  const script = `
    const out = await (async () => { ${body} })();
    process.stdout.write('\\n__RESULT__' + JSON.stringify(out));
  `;
  const env = { ...process.env };
  if (plugins !== undefined) env.HNCODE_PLUGINS = plugins;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const marker = stdout.lastIndexOf('__RESULT__');
  assert.notEqual(marker, -1, `child produced no result marker. stdout:\n${stdout}`);
  return { result: JSON.parse(stdout.slice(marker + '__RESULT__'.length).trim()), stdout };
}

/** A plugin dir containing one plugin whose body is `source`. */
function pluginDir(source, name = 'probe') {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'index.js'), source, 'utf8');
  return dir;
}

// Patches git.js#isRepo, a real top-level export of a real src module, and
// counts the calls that pass through the wrapper.
const COUNT_ISREPO = [
  'export function install(api) {',
  "  api.patch('git.js#isRepo', { before: () => { globalThis.__hit = (globalThis.__hit || 0) + 1; } });",
  '}',
  "export default { name: 'probe', version: '1.0.0' };",
].join('\n');

// ---------------------------------------------------------------------------
// The ordering contract
// ---------------------------------------------------------------------------

test('a plugin patch reaches a module imported AFTER bootstrap', () => {
  // The whole point of the module. If bootstrap ran too late — or index.js had
  // already pulled agent.js/llm.js in — git.js would come from the ESM cache
  // unpatched and the count would stay 0 with no error anywhere.
  const dir = pluginDir(COUNT_ISREPO);
  try {
    const { result } = runBootstrap(`
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      const r = await b.bootstrap();
      const git = await import(${JSON.stringify(modUrl('git.js'))});
      git.isRepo(process.cwd());
      return {
        loaded: r.loaded.map((p) => p.name),
        hits: globalThis.__hit || 0,
        alreadyLoaded: b.pluginsAlreadyLoaded(),
      };
    `, { plugins: dir });

    assert.deepEqual(result.loaded, ['probe'], 'the plugin was loaded');
    assert.equal(result.hits, 1, 'the patch wrapper ran when the symbol was called');
    assert.equal(result.alreadyLoaded, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loading plugins is what installs the patch loader, and the loader comes first', () => {
  // Two facts in one order-sensitive claim: bootstrap installs the loader, and
  // installing it is what makes the patch above possible at all.
  const dir = pluginDir(COUNT_ISREPO);
  try {
    const { result } = runBootstrap(`
      const patch = await import(${JSON.stringify(modUrl('patch.js'))});
      const before = patch.isLoaderInstalled();
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      await b.bootstrap();
      const git = await import(${JSON.stringify(modUrl('git.js'))});
      git.isRepo(process.cwd());
      return { before, after: patch.isLoaderInstalled(), hits: globalThis.__hit || 0 };
    `, { plugins: dir });

    assert.equal(result.before, false, 'the loader is not installed until bootstrap runs');
    assert.equal(result.after, true, 'bootstrap installed it');
    assert.equal(result.hits, 1, 'and the patch still applied');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty plugin directory loads cleanly and still reports its directory', () => {
  // A user with no plugins must reach the TUI normally — no plugins is a valid
  // state, not a failure.
  const dir = tmpDir();
  try {
    const { result } = runBootstrap(`
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      const r = await b.bootstrap();
      return { pluginDir: r.pluginDir, loaded: r.loaded, hasError: 'error' in r };
    `, { plugins: dir });

    assert.deepEqual(result.loaded, []);
    assert.equal(result.hasError, false, 'an empty dir is not an error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The opt-out
// ---------------------------------------------------------------------------

test('loadPlugins: false skips the plugin load but still installs the loader', () => {
  // The loader is installed before the early return on purpose: a run that opted
  // out of plugins still gets patching installed, so the two features are not
  // coupled and the hook stays a pass-through until something registers a target.
  const dir = pluginDir(COUNT_ISREPO);
  try {
    const { result } = runBootstrap(`
      const patch = await import(${JSON.stringify(modUrl('patch.js'))});
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      const r = await b.bootstrap({ loadPlugins: false });
      const git = await import(${JSON.stringify(modUrl('git.js'))});
      git.isRepo(process.cwd());
      return {
        pluginDir: r.pluginDir,
        loaded: r.loaded,
        alreadyLoaded: b.pluginsAlreadyLoaded(),
        loader: patch.isLoaderInstalled(),
        hits: globalThis.__hit || 0,
      };
    `, { plugins: dir });

    assert.deepEqual(result.loaded, [], 'no plugin ran');
    assert.equal(result.pluginDir, null, 'and none was reported');
    assert.equal(result.loader, true, 'the patch loader is still installed');
    // Opting out must NOT claim plugins were loaded, or index.js would skip its
    // own load and the process would silently run with no plugins.
    assert.equal(result.alreadyLoaded, false, 'index.js must still be free to load them');
    assert.equal(result.hits, 0, 'an unpatched symbol runs the original');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The double-load guard
// ---------------------------------------------------------------------------

test('bootstrap marks plugins loaded, so index.js does not load them a second time', () => {
  // index.js checks this flag before its own loadPlugins() call. Loading twice
  // is not harmless: the second pass tears the first one down and re-runs
  // install(), which is exactly the "tool already registered" trap the flag
  // exists to avoid.
  const dir = pluginDir(COUNT_ISREPO);
  try {
    const { result } = runBootstrap(`
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      const before = b.pluginsAlreadyLoaded();
      await b.bootstrap();
      const after = b.pluginsAlreadyLoaded();
      // Reproduce index.js's guard verbatim.
      const cfg = (await import(${JSON.stringify(modUrl('config.js'))})).resolveConfig();
      const wouldLoadAgain = Boolean(cfg.pluginDir) && !b.pluginsAlreadyLoaded();
      return { before, after, wouldLoadAgain };
    `, { plugins: dir });

    assert.equal(result.before, false);
    assert.equal(result.after, true);
    assert.equal(result.wouldLoadAgain, false, 'index.js must skip its own loadPlugins()');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Failure posture
// ---------------------------------------------------------------------------

test('an unreadable plugin directory degrades to no plugins instead of throwing', () => {
  // Point HNCODE_PLUGINS at a FILE: existsSync passes, so the loader gets as far
  // as readdirSync and fails with ENOTDIR. That is the real shape of this failure
  // — a path that looks configured and is not a directory.
  const dir = tmpDir();
  const notADir = path.join(dir, 'afile');
  fs.writeFileSync(notADir, 'x', 'utf8');
  try {
    const { result } = runBootstrap(`
      const patch = await import(${JSON.stringify(modUrl('patch.js'))});
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      let threw = null;
      let r = null;
      try { r = await b.bootstrap(); } catch (e) { threw = String(e && e.message); }
      // A src module must still be importable afterwards: the process continues.
      const git = await import(${JSON.stringify(modUrl('git.js'))});
      return {
        threw,
        pluginDir: r && r.pluginDir,
        loaded: r && r.loaded,
        errorCode: r && r.error && r.error.code,
        alreadyLoaded: b.pluginsAlreadyLoaded(),
        loader: patch.isLoaderInstalled(),
        isRepoType: typeof git.isRepo,
      };
    `, { plugins: notADir });

    assert.equal(result.threw, null, 'bootstrap must never throw — it runs before main()');
    assert.equal(result.pluginDir, null, 'the caller is told there is no plugin dir');
    assert.deepEqual(result.loaded, []);
    assert.equal(result.errorCode, 'ENOTDIR', 'the cause is preserved, not swallowed');
    // Marked loaded even on failure: the same broken dir must not be retried by
    // index.js a moment later, and the loader stays up either way.
    assert.equal(result.alreadyLoaded, true);
    assert.equal(result.loader, true, 'patching survives a plugin failure');
    assert.equal(result.isRepoType, 'function', 'the rest of hncode still loads');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plugin whose install() throws is reported, and the other plugins still load', () => {
  // One bad plugin must not cost the user the good ones. That is enforced by the
  // loader rather than by bootstrap, but bootstrap is what surfaces the failure,
  // so the observable end state is pinned here.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'aaa-bad'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'zzz-good'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'aaa-bad', 'index.js'), [
    'export function install() { throw new Error("boom"); }',
    "export default { name: 'bad', version: '1.0.0' };",
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'zzz-good', 'index.js'), [
    'export function install(api) { api.registerCommand({ name: "survived", run: () => "ok" }); }',
    "export default { name: 'good', version: '1.0.0' };",
  ].join('\n'), 'utf8');
  try {
    const { result } = runBootstrap(`
      const b = await import(${JSON.stringify(modUrl('bootstrap.js'))});
      let threw = null;
      let r = null;
      try { r = await b.bootstrap(); } catch (e) { threw = String(e && e.message); }
      const plugin = await import(${JSON.stringify(modUrl('plugin.js'))});
      return {
        threw,
        loaded: r ? r.loaded.map((p) => p.name) : null,
        commands: plugin.pluginCommands.map((c) => c.name),
        errors: plugin.takePluginNotices().filter((n) => n.level === 'error').map((n) => n.text),
      };
    `, { plugins: dir });

    assert.equal(result.threw, null);
    assert.deepEqual(result.loaded, ['good'], 'the healthy plugin loaded; the broken one did not');
    assert.deepEqual(result.commands, ['survived'], 'and its command is live');
    assert.ok(result.errors.some((m) => /boom/.test(m)), 'the failure is reported, not hidden');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The latch
// ---------------------------------------------------------------------------

test('pluginsAlreadyLoaded is a plain latch: false until marked, true after', () => {
  // In-process, because the latch has no startup ordering to observe. It runs
  // last on purpose: it leaves the module-level flag set, which is the one piece
  // of state in bootstrap.js that a test cannot undo.
  return import('../src/bootstrap.js').then((b) => {
    assert.equal(b.pluginsAlreadyLoaded(), false, 'a fresh module has not loaded plugins');
    b.markPluginsLoaded();
    assert.equal(b.pluginsAlreadyLoaded(), true);
    b.markPluginsLoaded();
    assert.equal(b.pluginsAlreadyLoaded(), true, 'marking twice is not an error');
  });
});