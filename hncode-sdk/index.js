// @hncode/hncode-sdk — runtime helpers and types for hncode plugins.
//
// WHY THIS IS A SEPARATE, DEPENDENCY-FREE PACKAGE
// ----------------------------------------------
// A plugin runs INSIDE the hncode process: the host injects the `api` object into
// `install(api)`. So a plugin never needs to import hncode itself, and hncode is
// not (and must not become) a dependency of this package — that would pull the
// whole CLI, its entry point and its install scripts into every plugin.
//
// What a plugin DOES need at author time is the shape of `api` (for completion and
// type-checking) and, for `api.patch`, the list of symbols it may target. Both live
// here: `index.d.ts` describes the API, `targets.*` lists the patchable symbols.
//
// This file is the RUNTIME half. It exports small, dependency-free constants and
// helpers that a plugin can `import` for real (not just for types).

/**
 * Lifecycle hooks accepted by `api.registerHook(name, fn)`.
 * Kept in sync with the names the host actually FIRES — see src/plugin.js's
 * registerHook and the runHooks() call sites in src/tui.js.
 */
export const HOOK_NAMES = [
  'onStartup',
  'onShutdown',
  'onTurnStart',
  'onTurnEnd',
  'onBeforeRequest',
  'onAfterRequest',
  'onToolExecute',
  'onToolResult',
  'onNewMessage',
  'onSessionSave',
];

/**
 * The legacy abstract "seams" accepted by `api.patch(seam, fn)` with the old
 * chain signature `(ctx, next)`. Everything else passed to `api.patch` is a
 * symbol target like "llm.js#LLM.requestText".
 */
export const LEGACY_SEAMS = [
  'systemPrompt',
  'llmRequest',
  'llmHeaders',
  'llmBody',
  'llmResponse',
  'toolDispatch',
  'toolResult',
  'beforeRender',
  'afterRender',
];

/** Notice/severity kinds accepted by `api.notice(text, kind)`. */
export const NOTICE_KINDS = ['info', 'warn', 'error'];

/** Config scopes accepted by hncode's personal-preference / memory files. */
export const SCOPES = ['global', 'project'];

/**
 * Wrap a plugin object with light validation. Purely a convenience: it returns
 * its argument unchanged (so `export default definePlugin({...})` type-checks and
 * runs the same), but it throws early on the mistakes hncode would otherwise
 * reject at load time anyway — a missing name/version, or an install that is not
 * a function. Failing here gives a clearer message and a stack that points at the
 * plugin file rather than at hncode's loader.
 *
 * @template {import('./index.d.ts').HncodePlugin} T
 * @param {T} plugin
 * @returns {T}
 */
export function definePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error('definePlugin: expected an object');
  }
  if (!plugin.name || typeof plugin.name !== 'string') {
    throw new Error('definePlugin: `name` is required');
  }
  if (!plugin.version || typeof plugin.version !== 'string') {
    throw new Error('definePlugin: `version` is required (semver, e.g. "1.0.0")');
  }
  if (typeof plugin.install !== 'function') {
    throw new Error('definePlugin: `install(api)` must be a function');
  }
  return plugin;
}

/**
 * Split a patch target into its parts, so a plugin can build targets from values
 * instead of string concatenation. Returns null when the target is not a symbol
 * target (e.g. a legacy seam).
 *
 *   parsePatchTarget('llm.js#LLM.requestText')
 *     -> { file: 'llm.js', base: 'LLM', method: 'requestText', id: 'llm.js#LLM.requestText' }
 *   parsePatchTarget('git.js#commit')
 *     -> { file: 'git.js', base: 'commit', method: null,  id: 'git.js#commit' }
 *
 * @param {string} target
 * @returns {{ file: string, base: string, method: string | null, id: string } | null}
 */
export function parsePatchTarget(target) {
  const m = /^([^#]+)#([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?$/.exec(String(target || '').trim());
  if (!m) return null;
  return { file: m[1], base: m[2], method: m[3] || null, id: `${m[1]}#${m[2]}${m[3] ? '.' + m[3] : ''}` };
}

/** The nine legacy seams as a Set, for membership tests in a plugin. */
export const LEGACY_SEAM_SET = new Set(LEGACY_SEAMS);

/** The hook names as a Set. */
export const HOOK_NAME_SET = new Set(HOOK_NAMES);
