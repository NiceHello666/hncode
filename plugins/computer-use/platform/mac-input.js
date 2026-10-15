// macOS input: mouse and keyboard through the Accessibility API and osascript.
//
// WHY osascript RATHER THAN A NATIVE API
// --------------------------------------
// The Accessibility API needs a C bridging layer to call from Node without a native module. Apple
// ships osascript, which reaches the same APIs, and System Events exposes mouse and keystroke
// commands. The cost is a process spawn per action (~50-150ms), which is acceptable for actions a
// person would take by hand and unacceptable for anything high-frequency — so nothing here loops.
//
// cliclick is used when present: it is a tiny, well-known utility that speaks to the same APIs
// without the osascript overhead, and it can click at absolute coordinates, which System Events
// cannot do directly.
import { run, have, unsupported, intArg as toInt } from './util.js';

const isMac = process.platform === 'darwin';

/** Whether the optional `cliclick` helper is installed. */
async function hasCliclick() {
  return isMac && (await have('cliclick'));
}

/**
 * Move the pointer.
 *
 * System Events has no absolute move, so cliclick is used when available and the movement is
 * otherwise skipped with an explanation — a click still lands correctly, because osascript's
 * "click at" moves first.
 */
export async function moveTo(x, y) {
  if (!isMac) return unsupported('mouse control on macOS only');
  const px = toInt(x, 0);
  const py = toInt(y, 0);
  if (await hasCliclick()) {
    await run('cliclick', [`m:${px},${py}`], { timeoutMs: 15000 });
    return { x: px, y: py };
  }
  return unsupported('moving the pointer on macOS needs cliclick (install: brew install cliclick). '
    + 'A click still works: use MouseClick, which moves and clicks in one osascript call.');
}

export async function cursorPos() {
  if (!isMac) return unsupported('mouse control on macOS only');
  if (await hasCliclick()) {
    const out = await run('cliclick', ['p'], { timeoutMs: 15000 });
    const m = /(-?\d+),(-?\d+)/.exec(out);
    if (m) return { x: +m[1], y: +m[2] };
  }
  return unsupported('reading the cursor position on macOS needs cliclick (install: brew install cliclick)');
}

/** Click at a point. Moves first, then clicks, in one call. */
export async function clickAt(x, y, { button = 'left', clicks = 1 } = {}) {
  if (!isMac) return unsupported('mouse control on macOS only');
  const px = toInt(x, 0);
  const py = toInt(y, 0);
  const n = toInt(clicks, 1, 1, 3);
  if (await hasCliclick()) {
    const btn = button === 'right' ? 'rc' : button === 'middle' ? 'mc' : 'c';
    for (let i = 0; i < n; i++) await run('cliclick', [`${btn}:${px},${py}`], { timeoutMs: 15000 });
    return { x: px, y: py, button, clicks: n };
  }
  // System Events can click at a position, and it honours the button through the modifiers only —
  // so a right-click is reported as unsupported rather than silently delivered as a left one.
  if (button !== 'left' || n > 1) {
    return unsupported(`a ${button} click (or a multi-click) on macOS needs cliclick `
      + '(install: brew install cliclick)');
  }
  await run('osascript', ['-e', `tell application "System Events" to click at {${px}, ${py}}`], { timeoutMs: 20000 });
  return { x: px, y: py, button, clicks: n };
}

export async function clickHere(opts = {}) {
  const pos = await cursorPos();
  if (pos && pos.error) return pos;
  if (pos && pos.unsupported) return pos;
  return clickAt(pos.x, pos.y, opts);
}

export async function drag(fromX, fromY, toX, toY, { button = 'left', durationMs = 300 } = {}) {
  if (!isMac) return unsupported('mouse control on macOS only');
  if (!(await hasCliclick())) return unsupported('dragging on macOS needs cliclick (install: brew install cliclick)');
  const b = button === 'right' ? 'rd' : 'dd';
  const u = button === 'right' ? 'ru' : 'du';
  await run('cliclick', [`m:${toInt(fromX, 0)},${toInt(fromY, 0)}`], { timeoutMs: 15000 });
  await run('cliclick', [`${b}:${toInt(fromX, 0)},${toInt(fromY, 0)}`], { timeoutMs: 15000 });
  const steps = Math.max(2, Math.min(30, Math.round(toInt(durationMs, 300, 0, 5000) / 30)));
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fromX + ((toX - fromX) * i) / steps);
    const y = Math.round(fromY + ((toY - fromY) * i) / steps);
    await run('cliclick', [`m:${x},${y}`], { timeoutMs: 15000 });
  }
  await run('cliclick', [`${u}:${toInt(toX, 0)},${toInt(toY, 0)}`], { timeoutMs: 15000 });
  return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, button };
}

export async function scroll({ dx = 0, dy = 0 } = {}) {
  if (!isMac) return unsupported('mouse control on macOS only');
  if (!(await hasCliclick())) return unsupported('scrolling on macOS needs cliclick (install: brew install cliclick)');
  const up = toInt(dy, 0, -100, 100);
  const right = toInt(dx, 0, -100, 100);
  const args = [];
  for (let i = 0; i < Math.abs(up); i++) args.push(up > 0 ? 'wu:1' : 'wd:1');
  for (let i = 0; i < Math.abs(right); i++) args.push(right > 0 ? 'ws:1' : 'wq:1');
  if (args.length) await run('cliclick', args, { timeoutMs: 30000 });
  return { dx: right, dy: up };
}

/** Type text. System Events `keystroke` handles Unicode, so this needs no helper. */
export async function typeText(text) {
  if (!isMac) return unsupported('keyboard control on macOS only');
  const s = String(text == null ? '' : text);
  if (!s) return { typed: 0 };
  // One osascript per chunk: a very long argument can exceed the command-line limit, and a single
  // keystroke of a long string is delivered as one event that some applications drop.
  const CHUNK = 200;
  for (let i = 0; i < s.length; i += CHUNK) {
    const part = s.slice(i, i + CHUNK);
    const literal = part.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await run('osascript', ['-e', `tell application "System Events" to keystroke "${literal}"`], { timeoutMs: 60000 });
  }
  return { typed: s.length };
}

/** The AppleScript modifier names for a chord. */
const MAC_MODS = {
  cmd: 'command down', command: 'command down', meta: 'command down',
  ctrl: 'control down', control: 'control down',
  alt: 'option down', option: 'option down', opt: 'option down',
  shift: 'shift down',
};

/** Press a key or chord, e.g. `cmd+s`, `ctrl+alt+delete`, `return`. */
export async function keyPress(combo) {
  if (!isMac) return unsupported('keyboard control on macOS only');
  const parts = String(combo || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no key given');
  const mods = [];
  let key = null;
  for (const p of parts) {
    const m = MAC_MODS[p.toLowerCase()];
    if (m) { mods.push(m); continue; }
    key = p;
  }
  if (!key) throw new Error(`no key in "${combo}" — give a key such as "s" or "return", plus modifiers`);
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  // A single character goes through keystroke; a named key needs key code.
  const NAMED = {
    return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
    left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
    f11: 103, f12: 111,
  };
  const lower = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED, lower)) {
    await run('osascript', ['-e', `tell application "System Events" to key code ${NAMED[lower]}${using}`], { timeoutMs: 20000 });
  } else if (key.length === 1) {
    const literal = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await run('osascript', ['-e', `tell application "System Events" to keystroke "${literal}"${using}`], { timeoutMs: 20000 });
  } else {
    throw new Error(`unknown key: "${key}"`);
  }
  return { keys: parts };
}

// ---------------------------------------------------------------------------
// process and pixel operations
// ---------------------------------------------------------------------------

/**
 * Group windows by process, with the main window identified.
 *
 * A stub here: the grouping needs a window-to-process map, and the platform window enumeration
 * this backend uses does not carry a pid. Saying so is better than returning an empty list, which
 * would read as "no applications are running" — a different and untrue statement.
 */
export async function listApps() {
  return unsupported('grouping windows by application is not implemented on macOS yet; use ListWindows instead');
}

/** Start a program. */
export async function launchApp() {
  return unsupported('launching applications on macOS is not implemented yet — use the shell (open -a / pkill)');
}

/** End a process. */
export async function terminateProcess() {
  return unsupported('ending a process on macOS is not implemented yet — use the shell instead');
}

/** The colour at a point. */
export async function readPixel() {
  return unsupported('reading a pixel on macOS is not implemented yet; use Screenshot with a small region');
}
