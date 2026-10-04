// Symbol-level patching — let a plugin wrap ANY exported function or class method
// in hncode's own source, without editing that source.
//
// WHY THIS EXISTS
// --------------
// The original `api.patch(seam, fn)` only exposed nine hand-picked "seams"
// (systemPrompt, llmRequest, …). Everything else — Agent.send, LLM.chat, any of
// the ~340 exported functions — was unreachable from a plugin. This module makes
// every symbol patchable by rewriting the target module's SOURCE at load time.
//
// HOW IT WORKS (and why it is safe)
// ---------------------------------
// ESM exports are read-only bindings, so a plugin cannot monkey-patch them at
// runtime (verified: `Cannot assign to read only property`). But a module CAN
// reassign its OWN bindings, and Node's `module.registerHooks({ load })` lets us
// rewrite a module's source as it is loaded. So for each requested target we:
//
//   1. leave the original declaration untouched (no body parsing at all), and
//   2. append a small footer that reassigns the symbol through our wrapper:
//        foo = __hncodePatch("file.js#foo", foo);
//        Klass.prototype.m = __hncodePatch("file.js#Klass.m", Klass.prototype.m);
//
// For an `export const` target we also rewrite that one declaration line
// (`const` → `let`) so it can be reassigned — still a single-line change, still
// no function-body analysis. This was chosen over an AST rewriter (acorn) to keep
// hncode's zero-runtime-dependency promise; it relies only on the fact that the
// target's declaration line is well-formed, which holds for every export in src/.
//
// ORDERING (important)
// --------------------
// The load hook only sees modules that are imported AFTER it is registered;
// already-cached modules are left alone (verified). hncode's entry therefore
// registers this loader and loads plugins BEFORE importing the business modules
// (see src/bootstrap.js). A module that has already been imported cannot be
// patched — patching it is reported as a skipped target, not a silent no-op.

import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

// Registry: { "file.js#symbol": [handler, …] }. The loader reads it per module.
const registry = new Map();

// The nine legacy abstract seams, kept so `api.patch('systemPrompt', fn)` from an
// existing plugin keeps working. These are handled by plugin.js's chain runner,
// NOT by this module; listed here so api.patch can tell the two target kinds apart.
export const LEGACY_SEAMS = new Set([
  'systemPrompt', 'llmRequest', 'llmHeaders', 'llmBody', 'llmResponse',
  'toolDispatch', 'toolResult', 'beforeRender', 'afterRender',
]);

let loaderInstalled = false;
let loaderActive = false;
const patchedFiles = new Set();

// A target is "file.js#symbol" (a plain export) or "file.js#Class.method".
const TARGET_RE = /^([^#]+)#([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?$/;

/** Normalise a user-supplied target into { file, base, method|null } or null. */
export function parseTarget(target) {
  const m = TARGET_RE.exec(String(target || '').trim());
  if (!m) return null;
  return { file: m[1], base: m[2], method: m[3] || null, id: `${m[1]}#${m[2]}${m[3] ? '.' + m[3] : ''}` };
}

/** Register one handler for a symbol target. Returns an unregister function. */
export function addPatch(target, handler) {
  const info = parseTarget(target);
  if (!info) throw new Error(`patch: bad target "${target}" (want "file.js#symbol" or "file.js#Class.method")`);
  if (!handler || typeof handler !== 'object') throw new Error('patch: handler must be an object like { before, after, around }');
  if (!info.method && patchedFiles.has(info.file) && !registry.get(info.id)) {
    // Allow it anyway; the loader may not have run yet for this file.
  }
  const list = registry.get(info.id) || [];
  list.push(handler);
  registry.set(info.id, list);
  return () => {
    const arr = registry.get(info.id);
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) registry.delete(info.id);
  };
}

/** All registered target ids (for /plugins-style introspection). */
export function listPatchTargets() { return [...registry.keys()]; }

/** Remove every handler (used by _resetPlugins and tests). */
export function clearPatches() { registry.clear(); }

// ---------------------------------------------------------------------------
// The runtime wrapper applied in the module footer.
// ---------------------------------------------------------------------------

/**
 * Wrap `fn` so every handler registered for `id` runs around it.
 * - before(...args): if it returns an array, that replaces the argument list.
 * - after(result, args): if it returns non-undefined, that replaces the result.
 * - around(original, args, thisArg): full control; its return value is the result.
 * Handler `this` is the call's `this` (so a class method can read its instance).
 */
export function applyPatches(id, fn) {
  const handlers = registry.get(id);
  if (!handlers || !handlers.length) return fn;

  function wrapped(...args) {
    let finalArgs = args;
    for (const h of handlers) {
      if (typeof h.before === 'function') {
        const r = h.before.apply(this, finalArgs);
        if (Array.isArray(r)) finalArgs = r;
      }
    }

    // `around` takes over the call entirely; otherwise call the original.
    const aroundHandler = handlers.filter((h) => typeof h.around === 'function').pop();
    const aroundFn = aroundHandler && aroundHandler.around;
    const invoke = () => (aroundFn ? aroundFn.call(this, fn, finalArgs, this) : fn.apply(this, finalArgs));

    const finish = (result) => {
      let out = result;
      for (const h of handlers) {
        if (typeof h.after === 'function') {
          const r = h.after.call(this, out, finalArgs);
          if (r !== undefined) out = r;
        }
      }
      return out;
    };

    const r = invoke();
    // Preserve asyncness: only then-ables get the after-chain deferred.
    if (r && typeof r.then === 'function') return r.then(finish);
    return finish(r);
  }
  return wrapped;
}

// Expose to rewritten modules (they run in their own scope and cannot import us
// without a cycle). One global, set once.
function installGlobal() {
  if (!globalThis.__hncodePatch) {
    globalThis.__hncodePatch = (id, fn) => applyPatches(id, fn);
  }
}

// ---------------------------------------------------------------------------
// The load hook: rewrite a module's source to append the patch footers.
// ---------------------------------------------------------------------------

/** Build the footer source for the targets whose file matches `base`. */
function footerFor(base, ids) {
  const lines = ['', '/* hncode:patch-footer (auto-generated) */', ';(() => {', '  const P = globalThis.__hncodePatch;', '  if (!P) return;'];
  for (const id of ids) {
    const info = parseTarget(id);
    if (!info) continue;
    const ref = info.method ? `${info.base}.prototype.${info.method}` : info.base;
    lines.push(`  try { ${ref} = P(${JSON.stringify(id)}, ${ref}); } catch (e) { console.error('[hncode-patch] ${id}:', e.message); }`);
  }
  lines.push('})();', '');
  return lines.join('\n');
}

/**
 * In `src`, make target `file#symbol` reassignable:
 *  - `export const NAME = …` → `export let NAME = …`   (only for a plain target)
 * The declaration line is matched literally; function bodies are never touched.
 */
function makeReassignable(src, info) {
  if (info.method) return src; // class methods are patched via the prototype
  const re = new RegExp(`^(\\s*)export const (${info.base})\\b`, 'm');
  return src.replace(re, '$1export let $2');
}

/** Rewrite one module's source, or return it unchanged when it has no targets. */
export function rewriteSource(filename, src) {
  const base = filename.split(/[\\/]/).pop();
  const ids = [...registry.keys()].filter((id) => parseTarget(id)?.file === base);
  if (!ids.length) return null;

  let out = src;
  for (const id of ids) {
    const info = parseTarget(id);
    // A plain target declares a top-level function/const; make it mutable if const.
    out = makeReassignable(out, info);
  }
  return out + footerFor(base, ids);
}

/**
 * Register the Node load hook. Idempotent and NON-FATAL: if the runtime has no
 * `module.registerHooks` (added in Node 22.15; hncode still declares engines
 * >=20) or registration throws, symbol patching is simply disabled. It must
 * never throw — a throw here would propagate through bootstrap and stop hncode
 * from starting at all, which is far worse than a missing optional feature.
 * Returns true when the loader is active.
 */
export function installPatchLoader() {
  installGlobal();
  if (loaderInstalled) return loaderActive;
  loaderInstalled = true;

  if (typeof module.registerHooks !== 'function') {
    // Older Node: patching is unavailable. Everything else keeps working.
    console.error('[hncode-patch] module.registerHooks is unavailable on this Node — symbol patching disabled.');
    return (loaderActive = false);
  }

  let srcDir;
  try { srcDir = path.dirname(fileURLToPath(import.meta.url)); } catch { return (loaderActive = false); }

  try {
    module.registerHooks({
      load(url, context, nextLoad) {
        const r = nextLoad(url, context);
        // Only hncode's own src/*.js files, and only when something targets them.
        if (!url.startsWith('file:') || !url.includes('/src/') || typeof r.source === 'undefined') return r;
        let file;
        try { file = fileURLToPath(url); } catch { return r; }
        if (path.dirname(file) !== srcDir) return r;
        try {
          const s = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
          const rewritten = rewriteSource(file, s);
          if (rewritten == null) return r;
          patchedFiles.add(path.basename(file));
          return { ...r, source: rewritten, format: r.format || 'module' };
        } catch (e) {
          // A rewrite failure must not break the module load — return it as-is
          // and report, rather than taking hncode down.
          console.error(`[hncode-patch] failed to rewrite ${url}:`, e && e.message);
          return r;
        }
      },
    });
    loaderActive = true;
  } catch (e) {
    console.error('[hncode-patch] could not install the load hook — symbol patching disabled:', e && e.message);
    loaderActive = false;
  }
  return loaderActive;
}

/** Whether the load hook is actually active (installed AND usable). index.js uses
 *  this to decide whether plugins still need loading — if patching is disabled,
 *  bootstrap already loaded them, so it must NOT be treated as "installed". */
export function isLoaderInstalled() { return loaderActive; }
