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
//   - services      (named values other plugins can `inject`)
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
//
// SERVICES, DEPENDENCIES AND TEARDOWN
// -----------------------------------
// A plugin may export four more things:
//   provides   names of the services its install() registers with api.provide()
//   inject     names of the services it needs; its install() runs only after they
//              are all provided, so a plugin never has to guess the load order.
//              A plugin whose dependencies cannot be satisfied is SKIPPED with a
//              notice rather than started half-wired.
//   dispose    dispose(api); called by unloadPlugins() BEFORE the registered
//              things are undone, so it can flush a file or stop a timer.
//   reload     hot reload: loadPlugins(dir, { fresh: true }) re-imports each file
//              with a cache-busting query and calls dispose + the collected
//              unregister functions of the previous load, so an edited plugin
//              takes effect without restarting hncode. (Exception: a `patch` on a
//              module that is ALREADY loaded this session still needs a restart —
//              the load hook only sees modules imported after it runs.)
//
//   export const provides = ['signature-db'];
//   export const inject = ['signature-db'];
//   export default { name: 'x', version: '1.0.0', install, dispose };

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { addSkillFromText, listSkills, deleteSkill } from './skills.js';
import { addPatch, listPatchTargets, clearPatches, LEGACY_SEAMS, installPatchLoader } from './patch.js';
// THEME_NAMES only. colors.js has no imports of its own, so this cannot create a cycle —
// which matters because this module is loaded very early, by bootstrap.
import { THEME_NAMES } from './colors.js';

// ---------------------------------------------------------------------------
// Internal registries — these are the "live" state that plugins mutate.
// ---------------------------------------------------------------------------

const registeredTools = [];
const registeredCommands = [];
const registeredHooks = {};
const registeredConfig = {};
const loadedPlugins = [];
const registeredKeybinds = [];
const registeredWidgets = [];
const registeredPatches = {};      // { seam: [fn] }  mixin-style patches keyed by seam name

// ---------------------------------------------------------------------------
// Services — the composition seam between plugins.
//
// `api.provide(name, value)` publishes a value under a name and `api.inject` /
// `api.get(name)` reads it, so plugin B can build on plugin A without importing
// its file (which would break the moment A is edited or reloaded). This is what
// makes `inject` load ordering meaningful: the names are the graph's edges.
// ---------------------------------------------------------------------------
const services = new Map();

// ---------------------------------------------------------------------------
// Per-plugin bookkeeping — one unit per plugin whose install() ran, in load order.
//
// Every register* call funnels its unregister function into the CURRENT unit, so
// a plugin author gets teardown for free instead of collecting disposers by hand
// and getting it wrong. unloadPlugins() then walks the units backwards.
// ---------------------------------------------------------------------------
const pluginUnits = [];
let currentUnit = null;            // the unit whose install() is running, if any
// Bumped per fresh (cache-busted) import; see loadPlugins' `opts.fresh`.
let loadSeq = 0;
/** Record a disposer against the plugin currently installing. Returns it unchanged,
 *  so a register* method can both track and return the unregister function. */
function track(dispose) {
  if (currentUnit && typeof dispose === 'function') currentUnit.disposers.push(dispose);
  return dispose;
}

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
 *
 * It is CALLABLE as well as carrying methods — `api.log('x')` and `api.log.warn('x')`
 * both work, exactly like `console`. The alternative, exposing the four methods as
 * `api.log` / `api.info` / `api.warn` / `api.error`, was what the type definitions had
 * claimed and the host never provided: `api.info(...)` was `undefined`, so a plugin
 * following the docs crashed on its first log line. One object with both shapes is the
 * one that cannot contradict itself.
 */
function makeLogger(sink) {
  const fn = (...a) => sink.log(...a);
  fn.log = (...a) => sink.log(...a);
  fn.info = (...a) => sink.info(...a);
  fn.warn = (...a) => sink.warn(...a);
  fn.error = (...a) => sink.error(...a);
  return fn;
}

export const pluginLogger = makeLogger({
  log: (...a) => { notice('info', fmtArgs(a)); console.log('[hncode-plugin]', ...a); },
  info: (...a) => { notice('info', fmtArgs(a)); console.log('[hncode-plugin]', ...a); },
  warn: (...a) => { notice('warn', fmtArgs(a)); console.warn('[hncode-plugin]', ...a); },
  error: (...a) => { notice('error', fmtArgs(a)); console.error('[hncode-plugin]', ...a); },
});

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
    return track(() => {
      const i = registeredTools.findIndex((t) => t.name === spec.name);
      if (i >= 0) registeredTools.splice(i, 1);
    });
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
    return track(() => {
      const i = registeredCommands.findIndex((c) => c.name === cmd.name);
      if (i >= 0) registeredCommands.splice(i, 1);
    });
  },

  // Register a lifecycle hook. Supported hook names:
  //   onStartup, onShutdown, onTurnStart, onTurnEnd,
  //   onBeforeRequest, onAfterRequest,
  //   onToolExecute, onToolResult, onNewMessage, onSessionSave
  // An unknown name is accepted (a plugin may use its own event, and hncode never
  // fires it) — see HOOK_NAMES in the SDK for the set the host actually emits.
  registerHook(name, fn) {
    if (!name || typeof fn !== 'function') {
      throw new Error('registerHook: name and fn are required');
    }
    (registeredHooks[name] = registeredHooks[name] || []).push(fn);
    return track(() => {
      const arr = registeredHooks[name];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    });
  },

  // Merge default config values. These are applied in resolveConfig after
  // all built-in defaults and before user config overrides. Returns an unregister
  // function that drops the keys this call added — the values live in a shared
  // object, so unloading has to remove them by key.
  registerConfig(defaults) {
    const keys = Object.keys(defaults || {});
    Object.assign(registeredConfig, defaults || {});
    if (currentUnit) currentUnit.configKeys.push(...keys);
    return track(() => { for (const k of keys) delete registeredConfig[k]; });
  },

  // Runtime helpers.
  get ctx() { return _ctx; },

  // ----- Services -----
  // Publish a value other plugins can `inject` / `get`. Declare the same names in
  // the module's `provides` export: the loader reads that (not this call) to work
  // out the load order, because ordering must be known BEFORE any install runs.
  // A duplicate name is an error rather than a silent overwrite — two plugins
  // fighting over one name is the failure a dependency system exists to prevent.
  provide(name, value) {
    const key = String(name == null ? '' : name).trim();
    if (!key) throw new Error('provide: a service name is required');
    const existing = pluginUnits.find((u) => u.services.has(key));
    if (services.has(key)) {
      throw new Error(`provide: service "${key}" is already provided${existing ? ` by ${existing.name}` : ''}`);
    }
    const unit = currentUnit;
    services.set(key, value);
    if (unit) unit.services.add(key);
    return track(() => {
      // Only drop the entry if it is still the value THIS plugin published: an
      // unregister called by hand after a reload must not delete the new load's.
      if (services.get(key) === value) services.delete(key);
      if (unit) unit.services.delete(key);
    });
  },

  /** A provided service, or undefined. */
  get(name) { return services.get(String(name == null ? '' : name).trim()); },
  /** Whether a service is available right now. */
  has(name) { return services.has(String(name == null ? '' : name).trim()); },
  /** Like get(), but throws when the service is missing — use it in install() when
   *  the plugin cannot work at all without it. */
  require(name) {
    const key = String(name == null ? '' : name).trim();
    if (!services.has(key)) throw new Error(`require: service "${key}" is not available`);
    return services.get(key);
  },
  /** Names of every currently-provided service. */
  get serviceNames() { return [...services.keys()]; },

  // ----- Teardown -----
  /** Register a cleanup function, run by unloadPlugins() before the registrations
   *  are undone. For resources the register* calls do not know about: timers,
   *  child processes, watchers, files. Returns an unregister function. */
  onDispose(fn) {
    if (typeof fn !== 'function') throw new Error('onDispose: a function is required');
    const unit = currentUnit;
    const wrapper = () => {
      if (unit) { const i = unit.disposers.indexOf(wrapper); if (i >= 0) unit.disposers.splice(i, 1); }
      return fn();
    };
    return track(wrapper);
  },


  // Runtime helpers.
  get ctx() { return _ctx; },

  // Register a skill from an in-memory SKILL.md string. Lets a plugin ship a skill
  // as code instead of asking the user to /import-skill a file. `content` is the
  // skill body; pass `name` to fix the skill name (else it is read from the
  // front-matter `name` field). Returns { ok, name, path, replaced } or { ok:false, error }.
  // The skill lands in the same skills directory /import-skill uses, so it shows up
  // immediately under /skills and can be activated with /skill:<name>.
  addSkill(content, name) {
    return addSkillFromText(content, name);
  },

  // ----- Runtime control -----
  sendPrompt(text, opts) { return _host.sendPrompt ? _host.sendPrompt(text, opts || {}) : null; },
  addMessage(role, text) { return _host.addChat ? _host.addChat(role, text) : null; },
  getMessages() { return _host.getMessages ? _host.getMessages() : []; },
  clearSession() { if (_host.clearSession) _host.clearSession(); },
  saveSession(s) { if (_host.saveSession) _host.saveSession(s); },
  quit() { if (_host.quit) _host.quit(); },

  // ----- UI -----
  notice(text, kind) { if (_host.notice) _host.notice(text, kind); },
  openPanel(content) { if (_host.openPanel) _host.openPanel(content); },
  openEditor(opts) { if (_host.openEditor) _host.openEditor(opts); },
  openPicker(opts) { if (_host.openPicker) _host.openPicker(opts); },
  openForm(opts) { if (_host.openForm) _host.openForm(opts); },
  openTasksPanel() { if (_host.openTasksPanel) _host.openTasksPanel(); },
  openRegistryBrowser(kind) { if (_host.openRegistryBrowser) _host.openRegistryBrowser(kind); },

  // The /files browser, driven from a plugin. `filter` narrows the tree the same way
  // `/files <filter>` does. Returns whether the browser actually opened, so a plugin can
  // tell a headless host (or an empty workspace) from a real success — a plugin that opens
  // a panel and then waits for the user is broken if nothing appeared.
  openFileTree(filter) { return _host.openFileTree ? !!_host.openFileTree(filter) : false; },
  /** Close the file-tree browser if it is open. */
  closeFileTree() { if (_host.closeFileTree) _host.closeFileTree(); },

  // ----- Theme -----
  /** Every theme name this build knows. */
  get themeNames() { return THEME_NAMES.slice(); },
  /** The theme in force, or the default when none was set. */
  getTheme() { return _host.getTheme ? _host.getTheme() : null; },
  /**
   * Switch the colour theme. Returns false for an unknown name or a host that cannot
   * repaint — the check is here rather than in the host so a plugin gets a straight answer
   * instead of a screen that half-changed.
   */
  setTheme(name) {
    const n = String(name == null ? '' : name).trim();
    if (!THEME_NAMES.includes(n)) return false;
    return _host.setTheme ? !!_host.setTheme(n) : false;
  },

  // ----- Subagents -----
  /**
   * The subagents running RIGHT NOW. A finished agent is not listed — it is no longer
   * controllable, and its result is already in the conversation.
   */
  subagents() { return _host.subagents ? _host.subagents() : []; },
  /** Send a message to a running subagent (by agent id, run id or task id). */
  messageSubagent(ref, text) {
    return _host.messageSubagent ? _host.messageSubagent(ref, text) : { ok: false, message: 'not supported by this host' };
  },
  /** Stop one running subagent, or every one when `ref` is omitted. */
  interruptSubagent(ref) {
    return _host.interruptSubagent ? _host.interruptSubagent(ref) : { ok: false, message: 'not supported by this host' };
  },
  /** Interrupt a subagent AND drop it from the running list at once. */
  closeSubagent(ref) {
    return _host.closeSubagent ? _host.closeSubagent(ref) : { ok: false, message: 'not supported by this host' };
  },

  // ----- Keybinds -----
  /**
   * Whether a shortcut is already claimed — by a built-in, by another plugin, or by the
   * user's own keybindings file. `registerKeybind` silently overwrites, so a plugin that
   * wants to be polite checks first.
   */
  isKeyBound(key) { return _host.isKeyBound ? !!_host.isKeyBound(key) : false; },
  /** Every currently-claimed shortcut token. */
  get boundKeys() { return _host.boundKeys ? _host.boundKeys() : []; },

  // ----- Config (runtime read/write) -----
  getConfig(key) { return _host.getConfig ? _host.getConfig(key) : undefined; },
  setConfig(key, val) { if (_host.setConfig) _host.setConfig(key, val); },
  // Persist a config value to disk so it survives restarts. The host does the
  // actual TOML write (plugins must not import ../src). Returns true on success.
  persistConfig(key, val) {
    if (_host.persistConfig) return _host.persistConfig(key, val);
    if (_host.setConfig) { _host.setConfig(key, val); return true; } // best-effort in-memory only
    return false;
  },

  // ----- Filesystem helpers (encoding-aware, error-tolerant) -----
  readFile(file, enc) { try { return fs.readFileSync(file, enc || 'utf8'); } catch { return null; } },
  writeFile(file, data, enc) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, enc || 'utf8'); return true; } catch { return false; } },
  readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback !== undefined ? fallback : null; } },
  writeJSON(file, obj) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); return true; } catch { return false; } },

  // ----- Skills -----
  get skills() { try { return listSkills(); } catch { return []; } },
  removeSkill(name) { return deleteSkill(name); },

  // ----- Keybinds & widgets -----
  registerKeybind(key, fn) {
    // Claim a global shortcut. The key uses the TUI's internal token format:
    // 'c-k' for Ctrl+K, 'c-s-c' for Ctrl+Shift+C, or a plain name like 'f9'.
    // Returns an unregister function.
    if (!key || typeof fn !== 'function') throw new Error('registerKeybind: key and fn are required');
    registeredKeybinds.push({ key: String(key).toLowerCase(), fn });
    return track(() => { const i = registeredKeybinds.findIndex((k) => k.key === String(key).toLowerCase() && k.fn === fn); if (i >= 0) registeredKeybinds.splice(i, 1); });
  },
  registerTuiWidget(fn) {
    if (typeof fn !== 'function') throw new Error('registerTuiWidget: fn is required');
    registeredWidgets.push(fn);
    return track(() => { const i = registeredWidgets.indexOf(fn); if (i >= 0) registeredWidgets.splice(i, 1); });
  },

  // ----- Patching (behaviour injection into hncode's own code) -----
  // Two target kinds, one method:
  //
  //   1. A SYMBOL target — "file.js#name" or "file.js#Class.method". This wraps
  //      the named export/class method in hncode's src/. Works for ANY symbol;
  //      the wrapper is installed by rewriting that module's source at load time
  //      (see patch.js). The handler is { before?, after?, around? }.
  //
  //   2. A legacy SEAM — one of the nine abstract seams ('systemPrompt',
  //      'llmRequest', …). The handler is the old chain function (ctx, next).
  //      Kept so plugins written against the original API keep working.
  //
  // Returns an unregister function.
  patch(target, handler) {
    if (!target) throw new Error('patch: target is required');
    if (LEGACY_SEAMS.has(String(target))) {
      if (typeof handler !== 'function') throw new Error(`patch: seam "${target}" needs a chain function (ctx, next)`);
      if (!registeredPatches[target]) registeredPatches[target] = [];
      registeredPatches[target].push(handler);
      return track(() => { const arr = registeredPatches[target]; if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); if (!arr.length) delete registeredPatches[target]; } });
    }
    // Symbol target: { before, after, around }
    return track(addPatch(String(target), handler));
  },
  get patchSeams() { return [...Object.keys(registeredPatches), ...listPatchTargets()]; },

  log: pluginLogger,

  // ----- Introspection -----
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

// The TUI/host injects its capabilities here so the API above can forward to them.
let _host = {};
export function setPluginHost(host) { _host = host || {}; }

// ---------------------------------------------------------------------------
// Plugin loading
// ---------------------------------------------------------------------------

/** Read a list-valued metadata field as a clean array of non-empty strings. */
function nameList(value) {
  const arr = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  return arr.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
}

// Order candidates so every plugin's `inject` names are provided before it runs.
// This is the dependency graph the plugin system previously did not have: the
// order was the directory listing, so a plugin that extended another plugin's
// tool only worked if its name happened to sort later.
//
// Returns { ordered, skipped }, where a skipped entry is { candidate, reason }:
// 'missing' when nobody provides a name the plugin injected, and 'cycle' for the
// leftovers of the topological sort.
function orderByInject(candidates) {
  const providerOf = new Map();
  for (const c of candidates) for (const s of c.provides) providerOf.set(s, c);

  // Iteratively drop whatever can never be satisfied: a name nobody provides, or a
  // name provided by a plugin that has already been dropped. Repeat so a chain of
  // dependents falls with its dependency instead of being reported as a cycle.
  const skipped = [];
  const live = new Set(candidates);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of candidates) {
      if (!live.has(c)) continue;
      const bad = c.inject.find((s) => !providerOf.has(s) || !live.has(providerOf.get(s)));
      if (bad) {
        live.delete(c);
        const by = providerOf.get(bad);
        skipped.push({
          candidate: c,
          reason: 'missing',
          detail: by
            ? `"${bad}" was provided by ${by.name}, which did not start`
            : `nothing provides "${bad}" — declare it in the other plugin's \`provides\` export`,
        });
        changed = true;
      }
    }
  }

  // Kahn's algorithm over the survivors. Ties keep the discovery order, so the
  // result is deterministic instead of depending on Map iteration luck.
  const ordered = [];
  const done = new Set();
  const pending = candidates.filter((c) => live.has(c));
  while (pending.length) {
    const i = pending.findIndex((c) => c.inject.every((s) => done.has(s)));
    if (i < 0) {
      // Nothing is ready and the queue is not empty: the rest is a cycle.
      for (const c of pending) skipped.push({ candidate: c, reason: 'cycle', detail: c.inject.join(', ') });
      break;
    }
    const [c] = pending.splice(i, 1);
    for (const s of c.provides) done.add(s);
    ordered.push(c);
  }
  return { ordered, skipped };
}

/**
 * Undo everything the currently loaded plugins registered, in reverse load order.
 *
 * Every register* call funnels its unregister function into the plugin's unit, so
 * this normally has nothing to guess. Each plugin's own `dispose(api)` runs FIRST
 * (while its registrations still exist, which is what lets it flush state through
 * them), then the collected unregister functions, then the registries are cleared
 * as a safety net — a plugin that threw mid-install leaves partial registrations
 * that no disposer covers.
 * Returns { unloaded, failed } for the caller to report: `unloaded` are the plugin
 * names that were torn down, `failed` the teardown errors.
 */
export async function unloadPlugins() {
  const failed = [];
  const unloaded = [];
  // Reverse order: a plugin built on another is torn down first, so its teardown
  // cannot see a dependency that has already collapsed.
  for (const unit of pluginUnits.slice().reverse()) {
    unloaded.push(unit.name);
    if (typeof unit.disposeFn === 'function') {
      try { await unit.disposeFn(API); }
      catch (e) { failed.push(`${unit.name}: dispose() failed: ${String((e && e.message) || e)}`); }
    }
    // `.slice().reverse()`: a disposer removes itself from the list, and mutating
    // the array being walked would skip the next entry.
    for (const d of unit.disposers.slice().reverse()) {
      try { await d(); }
      catch (e) { failed.push(`${unit.name}: a registered teardown failed: ${String((e && e.message) || e)}`); }
    }
    for (const k of unit.configKeys) delete registeredConfig[k];
    for (const s of unit.services) services.delete(s);
  }
  pluginUnits.length = 0;

  // The safety net. Plugins registered these through the units above, so this is
  // normally already empty; it exists for a plugin whose install() threw after
  // registering something, which no disposer knows about. It also clears
  // keybinds/widgets, which a reload used to leave behind forever.
  registeredTools.length = 0;
  registeredCommands.length = 0;
  for (const k of Object.keys(registeredHooks)) delete registeredHooks[k];
  for (const k of Object.keys(registeredConfig)) delete registeredConfig[k];
  for (const k in registeredPatches) delete registeredPatches[k];
  registeredKeybinds.length = 0;
  registeredWidgets.length = 0;
  clearPatches();
  loadedPlugins.length = 0;

  return { unloaded, failed };
}

/** Names of the services plugins have provided. */
export function listPluginServices() { return [...services.keys()]; }

// Discover and load all plugins from the plugin directory.
// Each plugin is a .js/.mjs file that exports either:
//   - `install(api)` (named export)
//   - or a default export with an `install` method
//
// `opts.fresh` re-imports each file with a cache-busting query so an EDITED plugin
// takes effect without restarting the process — the ESM cache would otherwise hand
// back the module instance loaded last time. Used by the reload path only.
export async function loadPlugins(dir, opts = {}) {
  const pluginDir = dir || PLUGIN_DIR;
  if (!fs.existsSync(pluginDir)) return [];

  // Node decides a .js file's module type from the NEAREST package.json, searching
  // upward well past the plugin directory. An installed plugin has no package.json
  // of its own, and whatever the search finds higher up cannot be touched, so the
  // loader parses each plugin as CommonJS first, detects module syntax, re-parses it
  // as ESM, and prints MODULE_TYPELESS_PACKAGE_JSON — once per plugin, on every
  // launch, over the screen the TUI has not taken over yet. Plugins are ESM by
  // definition (see the header), so state the type once at the plugin root and the
  // loader stops guessing. An existing package.json is left alone: it may be the
  // author's own, with fields we do not know about.
  const pkgFile = path.join(pluginDir, 'package.json');
  try {
    if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, '{ "type": "module" }\n');
  } catch { /* read-only plugin dir: the warning is noise, not a failure */ }

  // Notices belong to THIS run; a second load must not replay the first run's. The
  // wipe comes BEFORE the unload so a failing teardown is reported in this run.
  pendingNotices.length = 0;

  // Tear the previous load down properly instead of just resetting the registries:
  // that is what lets a plugin release a timer or a child process, and what makes
  // `loadPlugins` safe to call on a live process (the reload path).
  const { failed } = await unloadPlugins();
  for (const f of failed) notice('warn', f);

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

  // Phase 1: import every file and read its metadata. Imports come first because the
  // dependency order is declared in that metadata — the graph cannot be built before
  // the modules are read.
  const candidates = [];
  for (const { id: f, full } of files) {
    try {
      // A query string is a DIFFERENT module instance to Node, which is exactly what
      // a hot reload wants. Only on a fresh load: the startup path keeps the plain
      // URL so nothing else can see two instances of a plugin.
      const url = pathToFileURL(full).href + (opts.fresh ? `?v=${++loadSeq}` : '');
      const mod = await import(url);
      // `install(api)` may be the named export or live on the default export.
      let installFn;
      if (mod && typeof mod.install === 'function') installFn = mod.install;
      else if (mod && mod.default && typeof mod.default.install === 'function') installFn = mod.default.install;

if (typeof installFn !== 'function') {
        // Report it to the chat: a file that is present but registers nothing is
        // the most confusing failure of all — the user sees the file on disk and nothing
        // in the UI, with no hint that the export is missing. `notice` feeds the AI
        // output area; no console line, so it does not leak onto the terminal.
        notice('error', `${f}: no install(api) function found — skipped`);
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
      const name = defMeta.name || defMeta.meta?.name || namedMeta.name || namedMeta.meta?.name || fallback;
      // A plugin MUST declare a version (semver, e.g. "1.0.0"). Omitting it is a
      // hard load failure, not a silent default — an unversioned plugin cannot be
      // told apart from a stale one, and remote update checks depend on it.
      const version = defMeta.version || defMeta.meta?.version || namedMeta.version || namedMeta.meta?.version;
      if (!version || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version.trim())) {
        notice('error', `${f}: missing or invalid \`version\` (need semver like "1.0.0") — skipped. Add \`export default { name: '${name}', version: '1.0.0' }\`.`);
        continue;
      }
      // dispose() may be a named export or on the default export, like install.
      const disposeFn = typeof mod.dispose === 'function' ? mod.dispose
        : (def && typeof def.dispose === 'function' ? def.dispose : null);
      // provides/inject may be named exports, on `meta`, or on the default export.
      const provides = nameList(mod.provides || defMeta.provides || namedMeta.provides || defMeta.meta?.provides);
      const inject = nameList(mod.inject || defMeta.inject || namedMeta.inject || defMeta.meta?.inject);
      candidates.push({ id: f, name, version: version.trim(), installFn, disposeFn, provides, inject });
    } catch (e) {
      // Report it BOTH ways. stderr is the developer's channel (a plugin author running
      // The TUI owns the screen, so a load failure must reach the AI output area. `notice`
      // feeds the chat; no console line, so it does not leak onto the terminal.
      const msg = String((e && e.message) || e);
      notice('error', `${f} failed to load: ${msg}`);
    }
  }

  // Phase 2: order by `inject`, and report whatever cannot start.
  const { ordered, skipped } = orderByInject(candidates);
  for (const { candidate, reason, detail } of skipped) {
    notice('error', reason === 'cycle'
      ? `${candidate.id}: circular \`inject\` dependency (${detail}) — skipped`
      : `${candidate.id}: missing dependency — ${detail}; skipped`);
  }

  // Phase 3: install, dependencies first.
  for (const c of ordered) {
    const unit = {
      id: c.id, name: c.name, version: c.version,
      provides: c.provides, inject: c.inject,
      disposeFn: c.disposeFn,
      disposers: [], configKeys: [], services: new Set(),
    };
    // Set BEFORE install so every register* call inside it is attributed to this
    // plugin, and cleared in `finally` so a throw cannot leave the next plugin's
    // registrations recorded against this one.
    currentUnit = unit;
    try {
      // AWAITED: an async install that registers after an await would otherwise race
      // the next plugin's install, which would break the ordering this function
      // exists to provide — and its registrations would land after the load ended.
      await c.installFn(API);
      pluginUnits.push(unit);
      // install(api) FIRST, then record it. Pushing before the call reported a plugin as
      // loaded even when its install() threw — /plugins would list it under Loaded while
      // none of its tools existed.
      loadedPlugins.push({ id: c.id, name: c.name, version: c.version });
      // The notice goes to the AI output area; no console line, so it does not leak
      // onto the terminal (the TUI owns the screen at this point).
      notice('info', `loaded ${c.name}${c.version && c.version !== '0.0.0' ? ' v' + c.version : ''}`);
    } catch (e) {
      // Undo whatever this plugin managed to register BEFORE it threw, so a broken
      // plugin cannot leave half its tools behind.
      for (const d of unit.disposers.slice().reverse()) { try { await d(); } catch { /* already failing */ } }
      for (const k of unit.configKeys) delete registeredConfig[k];
      for (const s of unit.services) services.delete(s);
      const msg = String((e && e.message) || e);
      notice('error', `${c.id} failed to install: ${msg}`);
    } finally {
      currentUnit = null;
    }
  }

  // A patch registered on a module that is ALREADY loaded cannot take effect: the
  // load hook only rewrites modules imported after it runs. On a fresh reload that
  // is the normal case for src/*, so say so instead of letting the plugin look like
  // it silently did nothing.
  if (opts.fresh && listPatchTargets().length) {
    notice('warn', `${listPatchTargets().length} patch target(s) active — a patch on a module already loaded this session needs a restart`);
  }

  return [...loadedPlugins];
}

// ---------------------------------------------------------------------------
// Hook runner — called by the core from the TUI / agent loop.
// ---------------------------------------------------------------------------


// Run all patches registered for `seam`. `ctx` is mutated by each patch; the final
// built-in behavior is `base`. Returns whatever the chain resolves to (a patch may
// short-circuit by returning without calling next).
export async function runPatch(seam, ctx, base) {
  const arr = registeredPatches[seam];
  if (!arr || !arr.length) return typeof base === 'function' ? await base(ctx) : base;
  let i = -1;
  async function next(c) {
    i++;
    if (i >= arr.length) return typeof base === 'function' ? await base(c) : base;
    return arr[i](c, next);
  }
  return next(ctx);
}

// Synchronous variant of runPatch for hot paths that cannot await (render loop,
// header/body construction before fetch). Same chain semantics; the last built-in
// behavior is `base`. Patches that register here must NOT be async or they will be
// skipped (a sync seam cannot await a Promise).
export function runPatchSync(seam, ctx, base) {
  const arr = registeredPatches[seam];
  if (!arr || !arr.length) return typeof base === 'function' ? base(ctx) : base;
  let i = -1;
  function next(c) {
    i++;
    if (i >= arr.length) return typeof base === 'function' ? base(c) : base;
    return arr[i](c, next);
  }
  return next(ctx);
}

export async function runHooks(name, ...args) {
  const arr = registeredHooks[name];
  if (!arr || !arr.length) return;
  // Return the last truthy value a hook produced, so an `onToolResult` hook can
  // hand back a (redacted) replacement for the tool's output. Hooks that return
  // nothing leave `ret` undefined; existing hook types ignore the return anyway.
  let ret;
  for (const fn of arr) {
    try {
      const r = await fn(...args);
      if (r !== undefined) ret = r;
    } catch (e) {
      // Hooks must never crash the agent.
      // eslint-disable-next-line no-console
      console.error(`[hncode-plugin] hook "${name}" error: ${e.message}`);
    }
  }
  return ret;
}

// ---------------------------------------------------------------------------
// Exports for the core to consume
// ---------------------------------------------------------------------------

export { API, registeredTools as pluginTools, registeredCommands as pluginCommands };
export const pluginPatches = registeredPatches;
// The plugins that loaded THIS run, as { id, name, version }. Exported for the
// registry browser's "Loaded" tab; it previously read `API.plugins`, which never
// existed, so opening /plugins threw "Cannot read properties of undefined" and
// killed the process.
export const pluginLoaded = loadedPlugins;
// Plugin-claimed global keybinds / status widgets. The TUI consumes these directly.
export const pluginKeybinds = registeredKeybinds;
export const pluginWidgets = registeredWidgets;
// Run every matching keybind for a pressed key; returns true if any matched.
export async function runKeybinds(key) {
  const k = String(key || '').toLowerCase();
  let hit = false;
  for (const { key: kk, fn } of registeredKeybinds) {
    if (kk === k) { try { await fn(); hit = true; } catch (e) { console.error(`[hncode-plugin] keybind ${kk} error: ${e.message}`); } }
  }
  return hit;
}
// Synchronous keybind dispatch for the TUI's sync input handler. Handlers that
// return a Promise are still reported as handled but run in the background.
export function runKeybindsSync(key) {
  const k = String(key || '').toLowerCase();
  let hit = false;
  for (const { key: kk, fn } of registeredKeybinds) {
    if (kk === k) {
      try { fn(); hit = true; } catch (e) { console.error(`[hncode-plugin] keybind ${kk} error: ${e.message}`); }
    }
  }
  return hit;
}

// Render all plugin widgets into a single status-bar fragment.
export function renderWidgets() {
  const parts = [];
  for (const fn of registeredWidgets) {
    try { const s = fn(); if (s) parts.push(String(s)); } catch (e) { /* a bad widget must not break the bar */ }
  }
  return parts.join('   ');
}
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
  registeredKeybinds.length = 0;
  registeredWidgets.length = 0;
  for (const k in registeredPatches) delete registeredPatches[k];
  clearPatches();
  pendingNotices.length = 0;
  pluginUnits.length = 0;
  services.clear();
  currentUnit = null;
  _ctx = null;
}
