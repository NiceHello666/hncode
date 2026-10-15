// Linux input: xdotool on X11, ydotool on Wayland.
//
// WHY BOTH, AND WHY WAYLAND CANNOT USE xdotool
// --------------------------------------------
// xdotool drives the X server directly, which a Wayland session does not expose to clients: the
// compositor owns the input path and forbids one client synthesising events into another's window.
// So on Wayland xdotool does not "work less well" — it cannot work at all, and ydotool is the route
// (it goes through the kernel's uinput device, which needs its daemon and usually root).
//
// A missing tool is reported with the install command, because "input is unavailable" leaves the
// reader with nothing to do.
import { run, have, unsupported, intArg as toInt } from './util.js';

const isLinux = process.platform === 'linux';

/** How this session is drawn. */
function sessionType() {
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return 'none';
}

/** The tool this session can use for input, and why not when there is none. */
async function pick() {
  if (sessionType() === 'wayland') {
    if (await have('ydotool')) return { kind: 'ydotool', cmd: 'ydotool' };
    return {
      error: 'this is a Wayland session, where xdotool cannot inject input at all. Mouse and '
        + 'keyboard control needs ydotool, which requires its daemon (ydotoold) and usually root '
        + '(install: ydotool, then systemctl enable --now ydotool)',
    };
  }
  if (await have('xdotool')) return { kind: 'xdotool', cmd: 'xdotool' };
  return {
    error: 'mouse and keyboard control on X11 needs xdotool (install: xdotool). '
      + 'Alternative: dotool, which is a drop-in for the common cases',
  };
}

/** Run an xdotool subcommand, or explain that this session has no input tool. */
async function input(argv, { timeoutMs = 20000 } = {}) {
  const p = await pick();
  if (p.error) return p;
  if (p.kind === 'xdotool') {
    await run('xdotool', argv, { timeoutMs });
    return { ok: true };
  }
  // ydotool takes a different command language: ydotool mousemove --absolute x y, ydotool click,
  // ydotool type, ydotool key. Translating the small set the tools use keeps the callers free
  // of the difference.
  const translated = translateToYdotool(argv);
  if (translated.error) return translated;
  await run('ydotool', translated.argv, { timeoutMs });
  return { ok: true };
}

/** Map an xdotool argument vector onto ydotool's. */
export function translateToYdotool(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'mousemove') {
    // xdotool: mousemove <x> <y>
    return { argv: ['mousemove', '--absolute', rest[0], rest[1]] };
  }
  if (sub === 'click') {
    // xdotool: click [1|2|3]
    const btn = rest[0] || '1';
    return { argv: ['click', btn === '2' ? '0x40' : btn === '3' ? '0x41' : '0xC0'] };
  }
  if (sub === 'mousedown' || sub === 'mouseup') {
    const btn = rest[0] || '1';
    const code = btn === '2' ? '0x40' : btn === '3' ? '0x41' : '0xC0';
    return { argv: [sub === 'mousedown' ? 'click' : 'click', `0x${(sub === 'mousedown' ? 0x40 : 0x80) | (parseInt(code, 16) >> 6 & 1)}`] };
  }
  if (sub === 'type' || sub === 'key') return { argv };
  if (sub === 'getmouselocation') {
    return { argv: ['mousemove', '--absolute', '0', '0'] }; // ydotool has no query; handled by caller
  }
  if (sub === 'getdisplaygeometry') return { argv: ['/dev/null'] };
  return { error: `ydotool cannot do "${sub}"` };
}

export async function moveTo(x, y) {
  if (!isLinux) return unsupported('mouse control on Linux only');
  const r = await input(['mousemove', String(toInt(x, 0)), String(toInt(y, 0))]);
  if (r.error) return unsupported(r.error);
  return { x: toInt(x, 0), y: toInt(y, 0) };
}

export async function cursorPos() {
  if (!isLinux) return unsupported('mouse control on Linux only');
  if (sessionType() === 'wayland') {
    return unsupported('reading the cursor position on Wayland is not possible from a client; '
      + 'the compositor does not expose it. Track the position from the calls you make instead');
  }
  if (!(await have('xdotool'))) return unsupported('reading the cursor position needs xdotool (install: xdotool)');
  const out = await run('xdotool', ['getmouselocation'], { timeoutMs: 10000 });
  const mx = /x:(-?\d+)/.exec(out);
  const my = /y:(-?\d+)/.exec(out);
  if (!mx || !my) return { error: `could not parse the cursor position: ${out.trim().slice(0, 120)}` };
  return { x: +mx[1], y: +my[1] };
}

export async function clickAt(x, y, { button = 'left', clicks = 1 } = {}) {
  if (!isLinux) return unsupported('mouse control on Linux only');
  const n = toInt(clicks, 1, 1, 3);
  const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  const moved = await input(['mousemove', String(toInt(x, 0)), String(toInt(y, 0))]);
  if (moved.error) return unsupported(moved.error);
  const r = await input(['click', '--repeat', String(n), btn]);
  if (r.error) return unsupported(r.error);
  return { x: toInt(x, 0), y: toInt(y, 0), button, clicks: n };
}

export async function clickHere(opts = {}) {
  const pos = await cursorPos();
  if (pos && (pos.error || pos.unsupported)) return pos;
  const btn = opts.button === 'right' ? '3' : opts.button === 'middle' ? '2' : '1';
  const r = await input(['click', '--repeat', String(toInt(opts.clicks, 1, 1, 3)), btn]);
  if (r.error) return unsupported(r.error);
  return { button: opts.button || 'left', clicks: toInt(opts.clicks, 1, 1, 3) };
}

export async function drag(fromX, fromY, toX, toY, { button = 'left', durationMs = 300 } = {}) {
  if (!isLinux) return unsupported('mouse control on Linux only');
  const p = await pick();
  if (p.error) return unsupported(p.error);
  const btn = button === 'right' ? '3' : 'middle' ? '2' : '1';
  const btn2 = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
  void btn;
  const steps = Math.max(2, Math.min(30, Math.round(toInt(durationMs, 300, 0, 5000) / 30)));
  const down = await input(['mousedown', btn2]);
  if (down.error) return unsupported(down.error);
  try {
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(fromX + ((toX - fromX) * i) / steps);
      const y = Math.round(fromY + ((toY - fromY) * i) / steps);
      await input(['mousemove', String(x), String(y)]);
    }
  } finally {
    await input(['mouseup', btn2]);
  }
  return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, button };
}

export async function scroll({ dx = 0, dy = 0, x = null, y = null } = {}) {
  if (!isLinux) return unsupported('mouse control on Linux only');
  if (x != null && y != null) await input(['mousemove', String(toInt(x, 0)), String(toInt(y, 0))]);
  const up = toInt(dy, 0, -100, 100);
  const right = toInt(dx, 0, -100, 100);
  const p = await pick();
  if (p.error) return unsupported(p.error);
  // Button 4 is wheel-up, 5 wheel-down, 6 wheel-left, 7 wheel-right — the X11 convention.
  for (let i = 0; i < Math.abs(up); i++) await input(['click', up > 0 ? '4' : '5']);
  for (let i = 0; i < Math.abs(right); i++) await input(['click', right > 0 ? '7' : '6']);
  return { dx: right, dy: up };
}

export async function typeText(text) {
  if (!isLinux) return unsupported('keyboard control on Linux only');
  const s = String(text == null ? '' : text);
  if (!s) return { typed: 0 };
  const r = await input(['type', '--delay', '12', '--', s], { timeoutMs: 120000 });
  if (r.error) return unsupported(r.error);
  return { typed: s.length };
}

/** Translate a chord such as `ctrl+s` into xdotool's key syntax. */
export function chordToXdotool(combo) {
  const parts = String(combo || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => {
    const k = p.toLowerCase();
    if (k === 'cmd' || k === 'command' || k === 'meta' || k === 'win') return 'super';
    if (k === 'option' || k === 'opt') return 'alt';
    if (k === 'esc') return 'Escape';
    if (k === 'return') return 'Return';
    if (k === 'enter') return 'Return';
    if (k === 'del') return 'Delete';
    if (k === 'ctrl') return 'ctrl';
    return p;
  }).join('+');
}

export async function keyPress(combo) {
  if (!isLinux) return unsupported('keyboard control on Linux only');
  const keys = chordToXdotool(combo);
  if (!keys) throw new Error('no key given');
  const r = await input(['key', '--clearmodifiers', keys]);
  if (r.error) return unsupported(r.error);
  return { keys: String(combo).split('+').map((s) => s.trim()) };
}

export { sessionType };

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
  return unsupported('grouping windows by application is not implemented on Linux yet; use ListWindows instead');
}

/** Start a program. */
export async function launchApp() {
  return unsupported('launching applications on Linux is not implemented yet — use the shell (xdg-open / kill)');
}

/** End a process. */
export async function terminateProcess() {
  return unsupported('ending a process on Linux is not implemented yet — use the shell instead');
}

/** The colour at a point. */
export async function readPixel() {
  return unsupported('reading a pixel on Linux is not implemented yet; use Screenshot with a small region');
}
