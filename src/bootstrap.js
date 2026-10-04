// Bootstrap: install the patch loader and load plugins BEFORE the rest of
// hncode's modules are imported.
//
// WHY A SEPARATE MODULE
// ---------------------
// Symbol-level patching (patch.js) rewrites a target module's source as it is
// loaded, so the loader MUST be installed and the plugins MUST have registered
// their targets before those modules are imported. If any patched module is
// imported first, it is served from cache and the patch is silently skipped.
//
// hncode's real work lives in modules (agent.js, llm.js, tools/*) that index.js
// imports at the top, so index.js cannot load plugins itself — by the time it ran
// loadPlugins(), those modules would already be cached. This module runs first
// (see bin/hncode) and does the ordering that makes patching possible.
//
// It is deliberately tiny and dependency-light: it only needs config (for the
// plugin directory) plus plugin.js / patch.js. Everything else stays lazy.
//
// FAILURE POSTURE: bootstrap must NEVER stop hncode from starting. A missing
// Node API, a malformed config, or a broken plugin directory degrades to "no
// patches / no plugins", never to "hncode won't launch".

// Set once plugins have been loaded (by bootstrap or by index.js), so index.js
// does not load them a second time and trip "tool already registered".
let pluginsLoaded = false;
export function pluginsAlreadyLoaded() { return pluginsLoaded; }
export function markPluginsLoaded() { pluginsLoaded = true; }

export async function bootstrap({ loadPlugins = true } = {}) {
  // Patch loader first, but never let it break startup: installPatchLoader is
  // already non-throwing, and we belt-and-brace with try/catch here.
  try {
    const { installPatchLoader } = await import('./patch.js');
    installPatchLoader();
  } catch (e) {
    console.error('[hncode] patch loader unavailable, continuing without it:', e && e.message);
  }

  if (!loadPlugins) return { pluginDir: null, loaded: [] };

  try {
    const { resolveConfig } = await import('./config.js');
    const cfg = resolveConfig();
    if (!cfg.pluginDir) return { pluginDir: null, loaded: [] };

    const { loadPlugins: load } = await import('./plugin.js');
    const loaded = await load(cfg.pluginDir);
    markPluginsLoaded();
    return { pluginDir: cfg.pluginDir, loaded };
  } catch (e) {
    // A broken plugin dir/config must not stop hncode. Report and carry on.
    console.error('[hncode] plugin bootstrap failed, continuing without plugins:', e && e.message);
    markPluginsLoaded();
    return { pluginDir: null, loaded: [], error: e };
  }
}
