// Plugin system for hncode.
//
// Plugins are plain ESM modules loaded from a configurable directory (default
// ~/.hncode/plugins/*). Each plugin exports an `install(api)` function that
// receives a frozen API surface and can register:
//
//   - tools         (agent tools, same shape as built-in specs)
//   - commands      (slash-commands in the TUI)
//   - hooks         (lifecycle events: onTurnStart, onTurnEnd, onBeforeTool, etc.)
//   - config        (default config values that merge into resolveConfig)
//
// Example plugin:
//   import { Tool } from 'hncode';
//   export function install(api) {
//     api.registerTool({
//       name: 'Echo',
//       description: 'Echo back the given text',
//       parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
//       async execute(args) { return args.text; }
//     });
//     api.registerCommand({ name: 'echo', run: (arg, ctx) => console.log(arg) });
//   }
//   export default { name: 'echo-plugin' };

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// Default plugin directory.
const PLUGIN_DIR = path.join(os.homedir(), '.hncode', 'plugins');

// ---------------------------------------------------------------------------
// Internal registries — these are the "live" state that plugins mutate.
// ---------------------------------------------------------------------------

const registeredTools = [];
const registeredCommands = [];
const registeredHooks = {};
const registeredConfig = {};
const loadedPlugins = [];

// ---------------------------------------------------------------------------
// Plugin notices — what loaded, what failed, and anything a plugin reports.
//
// A plugin author's instinct is console.log/error, and that used to be the only channel.
// The TUI owns the screen, so those messages went to a terminal the user cannot see while
// the app runs: a plugin that failed to load simply did not appear, with no explanation
// anywhere. Collecting every message and letting the TUI render it puts both the success
// and the failure where the user is already looking.
// ---------------------------------------------------------------------------
const pendingNotices = [];

/** Record one notice. `level` is 'info' | 'warn' | 'error'. */
function notice(level, text) {
  pendingNotices.push({ level, text: String(text == null ? '' : text) });
}

/** Take and clear the pending notices — the TUI drains this after loading. */
export function takePluginNotices() {
  const out = pendingNotices.slice();
  pendingNotices.length = 0;
  return out;
}

function fmtArgs(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

/**
 * A console-like object handed to `install(api)` as `api.log`, so a plugin can report
 * without knowing anything about the UI. Everything reaches the chat AND mirrors to the
 * terminal, so a plugin author watching stderr still sees it.
 */
export const pluginLogger = {
  log: (...a) => { notice('info', fmtArgs(a)); console.log('[hncode-plugin]', ...a); },
  info: (...a) => { notice('info', fmtArgs(a)); console.log('[hncode-plugin]', ...a); },
  warn: (...a) => { notice('warn', fmtArgs(a)); console.warn('[hncode-plugin]', ...a); },
  error: (...a) => { notice('error', fmtArgs(a)); console.error('[hncode-plugin]', ...a); },
};

const API = {
  // Register a new tool (same shape as built-in tool specs).
  // Returns an unregister function.
  registerTool(spec) {
    if (!spec || typeof spec !== 'object' || !spec.name) {
      throw new Error('registerTool: spec must have a `name`');
    }
    if (registeredTools.some((t) => t.name === spec.name)) {
      throw new Error(`registerTool: tool "${spec.name}" is already registered`);
    }
    registeredTools.push(spec);
    return () => {
      const i = registeredTools.findIndex((t) => t.name === spec.name);
      if (i >= 0) registeredTools.splice(i, 1);
    };
  },

  // Register a slash-command.
  //   { name: 'echo', description: '...', argumentHint: '[text]', run: (arg, ctx) => {} }
  // `run` receives the command argument string and a context object.
  registerCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || !cmd.name) {
      throw new Error('registerCommand: cmd must have a `name`');
    }
    if (registeredCommands.some((c) => c.name === cmd.name)) {
      throw new Error(`registerCommand: command "/${cmd.name}" is already registered`);
    }
    registeredCommands.push(cmd);
    return () => {
      const i = registeredCommands.findIndex((c) => c.name === cmd.name);
      if (i >= 0) registeredCommands.splice(i, 1);
    };
  },

  // Register a lifecycle hook. Supported hook names:
  //   onTurnStart, onTurnEnd, onBeforeRequest, onAfterRequest,
  //   onToolExecute, onToolResult, onNewMessage
  registerHook(name, fn) {
    if (!name || typeof fn !== 'function') {
      throw new Error('registerHook: name and fn are required');
    }
    (registeredHooks[name] = registeredHooks[name] || []).push(fn);
    return () => {
      const arr = registeredHooks[name];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    };
  },

  // Merge default config values. These are applied in resolveConfig after
  // all built-in defaults and before user config overrides.
  registerConfig(defaults) {
    Object.assign(registeredConfig, defaults || {});
  },

  // Runtime helpers.
  get ctx() { return _ctx; },

  // Introspection.
  get tools() { return [...registeredTools]; },
  get commands() { return [...registeredCommands]; },
  get hooks() { return { ...registeredHooks }; },
  get config() { return { ...registeredConfig }; },
  get plugins() { return [...loadedPlugins]; },

  // Reporting. `api.log.info('…')` reaches the CHAT, which is the only channel a user
  // can actually see while the TUI owns the screen; it also mirrors to the terminal for
  // a developer watching it. See pluginLogger.
  log: pluginLogger,
};

// The agent context is injected lazily; plugins that need it read api.ctx

// The agent context is injected lazily; plugins that need it read api.ctx
// during their hook callbacks.
let _ctx = null;
export function setPluginContext(ctx) { _ctx = ctx; }

// ---------------------------------------------------------------------------
// Plugin loading
// ---------------------------------------------------------------------------

// Discover and load all plugins from the plugin directory.
// Each plugin is a .js/.mjs file that exports either:
//   - `install(api)` (named export)
//   - or a default export with an `install` method
export async function loadPlugins(dir) {
  const pluginDir = dir || PLUGIN_DIR;
  if (!fs.existsSync(pluginDir)) return [];

  // loadPlugins() may be called more than once (tests, hot reload). Reset the
  // registries first so a second load cannot throw "tool already registered"
  // and accumulate stale hooks/config over reloads.
  registeredTools.length = 0;
  registeredCommands.length = 0;
  for (const k of Object.keys(registeredHooks)) delete registeredHooks[k];
  for (const k of Object.keys(registeredConfig)) delete registeredConfig[k];
  loadedPlugins.length = 0;
  // Notices belong to THIS run too; a second load must not replay the first run's.
  pendingNotices.length = 0;

  // Two layouts, because both are in the wild and the install path only produces one:
  //   plugins/foo.js            — a single-file plugin
  //   plugins/foo/index.js      — a plugin directory (this is what /plugins install
  //                               writes, and what a plugin with helper files needs)
  // Only the flat form used to be scanned, so every plugin installed through the
  // manager was written to disk correctly and then silently never loaded.
  const files = [];
  for (const e of fs.readdirSync(pluginDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs'))) {
      files.push({ id: e.name, full: path.join(pluginDir, e.name) });
      continue;
    }
    if (!e.isDirectory()) continue;
    const dir = path.join(pluginDir, e.name);
    // A directory's entry point: index.js/.mjs, else the first .js/.mjs beside it (a
    // directory may legitimately be named differently from its file).
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const entry = ['index.js', 'index.mjs'].find((n) => entries.includes(n))
      || entries.filter((n) => n.endsWith('.js') || n.endsWith('.mjs')).sort()[0];
    if (!entry) continue;
    files.push({ id: `${e.name}/${entry}`, full: path.join(dir, entry) });
  }

  for (const { id: f, full } of files) {
    try {
      const mod = await import(pathToFileURL(full).href);
      // `install(api)` may be the named export or live on the default export.
      let installFn;
      if (mod && typeof mod.install === 'function') installFn = mod.install;
      else if (mod && mod.default && typeof mod.default.install === 'function') installFn = mod.default.install;

if (typeof installFn !== 'function') {
        // Report it to the chat as well: a file that is present but registers nothing is
        // the most confusing failure of all — the user sees the file on disk and nothing
        // in the UI, with no hint that the export is missing.
        notice('error', `${f}: no install(api) function found — skipped`);
        // eslint-disable-next-line no-console
        console.error(`[hncode-plugin] ${f}: no install(api) function found, skipped.`);
        continue;
      }

      // Metadata can arrive three ways, and all three are in the wild:
      //   export default { name: 'x', version: '1' }   (object)
      //   export default 'x'                            (plain string)
      //   export const meta = { name: 'x' }             (named export)
      // Only the default export used to be read, so a plugin using the named form
      // showed up as its FILENAME with version 0.0.0 in /plugins. Check them all.
      const def = (mod && mod.default) || {};
      const defMeta = typeof def === 'string' ? { name: def } : def;
      const namedMeta = (mod && mod.meta) || {};
      // Fall back to the DIRECTORY name for a directory plugin, so a plugin at
      // plugins/secret-guard/index.js with no metadata shows as `secret-guard`, not
      // `secret-guard/index.js`.
      const fallback = f.includes('/') ? f.split('/')[0] : f.replace(/\.m?js$/, '');
      const plugin = {
        id: f,
        name: defMeta.name || defMeta.meta?.name || namedMeta.name || namedMeta.meta?.name || fallback,
        version: defMeta.version || defMeta.meta?.version || namedMeta.version || namedMeta.meta?.version || '0.0.0',
      };
      // install(api) FIRST, then record it. Pushing before the call reported a plugin as
      // loaded even when its install() threw — /plugins would list it under Loaded while
      // none of its tools existed.
      installFn(API);
      loadedPlugins.push(plugin);
      // The notice goes to the chat; the console line stays for a developer watching a
      // terminal, matching the failure path below.
      notice('info', `loaded ${plugin.name}${plugin.version && plugin.version !== '0.0.0' ? ' v' + plugin.version : ''}`);
      // eslint-disable-next-line no-console
      console.log(`[hncode-plugin] loaded: ${plugin.name}`);
    } catch (e) {
      // Report it BOTH ways. stderr is the developer's channel (a plugin author running
      // hncode from a terminal), but the TUI owns the screen, so a user who installs a
      // plugin through /plugins never sees it — their plugin simply does not appear and
      // nothing says why. `notice` feeds the chat; the console line stays for a developer
      // watching a terminal.
      const msg = String((e && e.message) || e);
      notice('error', `${f} failed to load: ${msg}`);
      // eslint-disable-next-line no-console
      console.error(`[hncode-plugin] ${f}: ${msg}`);
    }
  }

  return [...loadedPlugins];
}

// ---------------------------------------------------------------------------
// Hook runner — called by the core from the TUI / agent loop.
// ---------------------------------------------------------------------------

export async function runHooks(name, ...args) {
  const arr = registeredHooks[name];
  if (!arr || !arr.length) return;
  for (const fn of arr) {
    try { await fn(...args); } catch (e) {
      // Hooks must never crash the agent.
      // eslint-disable-next-line no-console
      console.error(`[hncode-plugin] hook "${name}" error: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports for the core to consume
// ---------------------------------------------------------------------------

export { API, registeredTools as pluginTools, registeredCommands as pluginCommands };
// Plugin-provided config DEFAULTS. resolveConfig() must merge these BEFORE
// user config so a plugin can supply a value the user has not set. Previously
// registerConfig() stored into this object and nothing ever read it.
export { registeredConfig as pluginConfigDefaults };

// Reset state — useful for tests.
export function _resetPlugins() {
  registeredTools.length = 0;
  registeredCommands.length = 0;
  for (const k of Object.keys(registeredHooks)) delete registeredHooks[k];
  for (const k of Object.keys(registeredConfig)) delete registeredConfig[k];
  loadedPlugins.length = 0;
  pendingNotices.length = 0;
  _ctx = null;
}
