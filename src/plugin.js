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
};

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

  const files = fs.readdirSync(pluginDir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .sort();

  for (const f of files) {
    const full = path.join(pluginDir, f);
    try {
      const mod = await import(pathToFileURL(full).href);
      let installFn;
      if (mod && typeof mod.install === 'function') installFn = mod.install;
      else if (mod && mod.default && typeof mod.default.install === 'function') installFn = mod.default.install;

      if (typeof installFn !== 'function') {
        // eslint-disable-next-line no-console
        console.error(`[hncode-plugin] ${f}: no install(api) function found, skipped.`);
        continue;
      }

      // Metadata comes from the default export. `name` there is a plain STRING
      // (`export default { name: 'recorder' }`), so reading `meta.name` off it
      // returned undefined and the plugin showed up as its FILENAME with version
      // 0.0.0 — /plugins listed every plugin under the wrong name. Accept both
      // shapes: a string name, or an object carrying { name, version }.
      const def = (mod && mod.default) || {};
      const meta = typeof def === 'string' ? { name: def } : def;
      const plugin = {
        id: f,
        name: meta.name || meta.meta?.name || f,
        version: meta.version || meta.meta?.version || '0.0.0',
      };
      loadedPlugins.push(plugin);
      installFn(API);
      // eslint-disable-next-line no-console
      console.log(`[hncode-plugin] loaded: ${plugin.name}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[hncode-plugin] ${f}: ${e.message}`);
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

// Reset state — useful for tests.
export function _resetPlugins() {
  registeredTools.length = 0;
  registeredCommands.length = 0;
  for (const k of Object.keys(registeredHooks)) delete registeredHooks[k];
  for (const k of Object.keys(registeredConfig)) delete registeredConfig[k];
  loadedPlugins.length = 0;
  _ctx = null;
}
