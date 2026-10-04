// User keybindings — remap a key to another key, or to a slash command.
//
// WHY AN ALIAS TABLE AND NOT A PLUGIN-STYLE HANDLER LIST
// -----------------------------------------------------
// The TUI dispatches keys in one large switch whose cases are also the ONLY place the
// key's meaning is defined. Rewriting that switch into a registry would be a much larger
// change than the feature is worth, and it would put a layer between every keystroke and
// the handler — on the one path where latency is visible.
//
// So a binding is an ALIAS: it names a target the switcher already understands.
//
//   key       -> the key to send instead      ("ctrl-j" = "enter")
//   command   -> the slash command to run     ("ctrl-e" = "/theme")
//
// One key, one target, applied before dispatch. That covers what people actually rebind
// for — a key their terminal eats, a chord they prefer, a command they run constantly —
// with no change to the dispatch path and no way for a binding to leave the UI in a
// state the switcher does not know how to handle. A key with no binding passes through
// untouched, which is what keeps the default experience identical.
//
// WHY THE FILE IS THE SOURCE OF TRUTH
// -----------------------------------
// Bindings live in ~/.hncode/keybindings.json, read per keypress rather than cached: it is
// a small file, the read costs microseconds, and it means an edit takes effect immediately
// instead of after a restart. A malformed file is reported ONCE and then ignored — a typo
// must not silently swallow every key the user presses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where user bindings live. `HNCODE_HOME` moves it, like the rest of the config. */
export function keybindingsFile(home) {
  const base = home || process.env.HNCODE_HOME || path.join(os.homedir(), '.hncode');
  return path.join(base, 'keybindings.json');
}

// Names people will reasonably write, mapped to the tokens the tokenizer emits. Without
// this, `ctrl+o` (how every other tool spells it) would not match `c-o`, and the binding
// would silently do nothing — the worst outcome for a config feature.
const KEY_ALIASES = {
  return: 'enter', cr: 'enter',
  esc: 'escape',
  del: 'delete',
  pageup: 'pgup', pagedown: 'pgdn',
  space: ' ',
};

// Modifier names, recognised on their own so they can be joined with a base key.
const MODIFIERS = {
  ctrl: 'c', control: 'c', ctl: 'c',
  shift: 's',
  alt: 'm', meta: 'm', option: 'm', opt: 'm', cmd: 'm', command: 'm', super: 'm', win: 'm',
};

/**
 * Normalise a key spelling to this TUI's token vocabulary.
 * `ctrl+o` -> `c-o`, `Return` -> `enter`, `C-T` -> `c-t`.
 *
 * A spec that names only modifiers, or ends on the separator (`ctrl+`), is malformed and
 * returns '' — the caller treats that as an error. Returning a made-up token instead would
 * create a binding the tokenizer can never emit, which is a key that silently does nothing.
 */
export function normalizeKey(spec) {
  const s = String(spec == null ? '' : spec).trim().toLowerCase();
  if (!s) return '';
  // A leading/trailing `+`, or a trailing `-`, means a half-written chord. `ctrl+` would
  // otherwise split into one part and be returned verbatim as the literal string "ctrl+".
  if (/[+\s]$/.test(s) && !/^-+$/.test(s)) return '';
  if (/^[+\s]/.test(s)) return '';
  // `ctrl-o` is the other common spelling of a chord: split it on `-` when the first
  // segment is a modifier name, so it is not returned whole as an unknown key.
  let parts = s.split(/[+\s]+/).filter(Boolean);
  if (parts.length === 1 && parts[0].includes('-')) {
    const seg = parts[0].split('-').filter(Boolean);
    if (seg.length > 1 && seg.slice(0, -1).every((p) => MODIFIERS[p])) parts = seg;
  }
  if (!parts.length) return '';
  if (parts.length === 1) {
    // A bare modifier name is not a key: nothing emits `ctrl` on its own.
    if (MODIFIERS[parts[0]]) return '';
    return KEY_ALIASES[parts[0]] || parts[0];
  }
  const mods = [];
  let base = '';
  for (const p of parts) {
    const m = MODIFIERS[p];
    if (m) { if (!mods.includes(m)) mods.push(m); continue; }
    // A second non-modifier means the spec is not a chord at all (`ctrl+a+b`); the last one
    // wins, matching how the single-part path treats an unknown name.
    base = KEY_ALIASES[p] || p;
  }
  if (!base) return '';                 // `ctrl+shift` names no key
  if (!mods.length) return base;
  // Ctrl is emitted as `c-<letter>`; a modified non-letter (ctrl+up) is `c-up`; and a
  // shift-modified control is the `c-s-<x>` form the CSI-u path produces.
  if (mods.length === 1 && mods[0] === 'c') return `c-${base}`;
  // Shift alone is emitted as `shift-<base>` for the named keys the tokenizer handles
  // specially (shift-tab, shift-up, shift-home, …).
  if (mods.length === 1 && mods[0] === 's') return `shift-${base}`;
  if (mods.includes('c') && mods.includes('s')) return `c-s-${base}`;
  // Any other combination resolves to the base key rather than to a token nothing emits,
  // so `alt+x` still does something sensible instead of becoming a dead key.
  return base;
}

const isCommand = (s) => typeof s === 'string' && s.trim().startsWith('/');

/**
 * Read and validate the bindings file.

/**
 * Read and validate the bindings file.
 *
 * @returns {{bindings: Map<string, {key?:string, command?:string}>, errors: string[], file: string}}
 *   `bindings` maps a NORMALISED source key to exactly one target.
 */
export function loadKeybindings(home) {
  const file = keybindingsFile(home);
  const out = { bindings: new Map(), errors: [], file };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // Absent is the normal case and deserves no complaint. Anything else is worth saying.
    if (e && e.code !== 'ENOENT') out.errors.push(`could not read ${file}: ${e.message}`);
    return out;
  }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { out.errors.push(`${file} is not valid JSON: ${e.message}`); return out; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    out.errors.push(`${file} must contain a JSON object of "key": "target" pairs`);
    return out;
  }
  // Accept both a flat map and a `{ bindings: { … } }` wrapper, because both spellings are
  // natural and refusing one would be a pointless papercut.
  const table = (doc.bindings && typeof doc.bindings === 'object' && !Array.isArray(doc.bindings))
    ? doc.bindings : doc;
  for (const [from, to] of Object.entries(table)) {
    if (from === 'bindings') continue;
    const src = normalizeKey(from);
    if (!src) { out.errors.push(`"${from}": not a usable key name`); continue; }
    let target;
    if (typeof to === 'string' && isCommand(to)) {
      target = { command: to.trim() };
    } else if (typeof to === 'string') {
      const dst = normalizeKey(to);
      if (!dst) { out.errors.push(`"${from}": "${to}" is not a usable key name or a /command`); continue; }
      if (dst === src) { out.errors.push(`"${from}": a key cannot be bound to itself`); continue; }
      target = { key: dst };
    } else if (to && typeof to === 'object' && typeof to.command === 'string' && isCommand(to.command)) {
      target = { command: to.command.trim() };
    } else if (to && typeof to === 'object' && typeof to.key === 'string') {
      const dst = normalizeKey(to.key);
      if (!dst || dst === src) { out.errors.push(`"${from}": bad target key`); continue; }
      target = { key: dst };
    } else {
      out.errors.push(`"${from}": the target must be a key name (e.g. "enter") or a command (e.g. "/theme")`);
      continue;
    }
    out.bindings.set(src, target);
  }
  return out;
}

/**
 * Resolve one incoming key through the bindings.
 *
 * A command binding is CAPPED: resolving a command binding that points at another command
 * binding, or a chain of key aliases, must not loop. One hop for a command, and a bounded
 * walk for keys, is enough to be useful and impossible to hang on.
 *
 * @returns {{key: string, command: string|null}} the key to dispatch, plus a command to run.
 */
export function resolveKey(key, bindings, maxHops = 8) {
  const k = String(key == null ? '' : key);
  if (!bindings || typeof bindings.get !== 'function') return { key: k, command: null };
  let cur = k;
  let command = null;
  for (let hop = 0; hop < maxHops; hop++) {
    const hit = bindings.get(cur);
    if (!hit) break;
    if (hit.command) {
      // The command replaces the key entirely: running it and ALSO dispatching the
      // original key would fire two unrelated actions from one press.
      if (command) break;      // already found one; do not chain commands
      command = hit.command;
      break;
    }
    if (!hit.key || hit.key === cur) break;
    cur = hit.key;
  }
  return { key: cur, command };
}

/** A JSON body for the bindings file, used by `/keybindings add` on first write. */
export function readOrEmpty(home) {
  const file = keybindingsFile(home);
  try { return { file, doc: JSON.parse(fs.readFileSync(file, 'utf8')) || {} }; }
  catch { return { file, doc: {} }; }
}

/** Write the bindings file, creating the directory if needed. */
export function writeKeybindings(home, doc) {
  const file = keybindingsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * A human-readable table of the settings, for `/keybindings`.
 * Sorted so the output is stable across runs.
 */
export function describeKeybindings(loaded) {
  const out = [];
  if (!loaded.bindings.size) {
    out.push('No keybindings set.', '', `File: ${loaded.file}`, 'Add one with /keybindings add <key> <key|/command>');
  } else {
    out.push(`Keybindings (${loaded.bindings.size}) — ${loaded.file}`, '');
    for (const [from, to] of [...loaded.bindings.entries()].sort()) {
      out.push(`  ${from.padEnd(12)} -> ${to.command ? to.command : to.key}`);
    }
  }
  if (loaded.errors.length) {
    out.push('', 'Problems:', ...loaded.errors.map((e) => `  ! ${e}`));
  }
  return out;
}
