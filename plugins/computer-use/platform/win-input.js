// Windows input: mouse and keyboard through user32.
//
// WHY SetCursorPos / mouse_event / keybd_event, AND NOT SendInput
// --------------------------------------------------------------
// This was written with SendInput, on the reasoning that it is the modern call and that moving the
// pointer plus pressing a button in one INPUT array is more faithful. It did not work AT ALL: every
// action returned success and nothing moved, because the INPUT struct is a C UNION modelled with
// [StructLayout(LayoutKind.Explicit)] and [FieldOffset], where mi and ki occupy the SAME
// bytes. Written sequentially they occupy different bytes, the struct is the wrong size, and
// SendInput rejects the call — returning 0, which nothing checked.
//
// The older calls are simple enough to be hard to get wrong, and each is one syscall with no
// marshalled structure to mislay:
//
//   SetCursorPos(x, y)                  move the pointer, in screen pixels
//   mouse_event(flags, 0, 0, data, 0)   press, release, wheel
//   keybd_event(vk, scan, flags, 0)     press and release a key
//
// MapVirtualKey(vk, 0) supplies the scan code for each key. Some applications — games, and
// anything reading hardware input — distinguish keys by scan code and ignore a virtual key on its
// own.
import { run, have, unsupported, intArg as toInt } from './util.js';

const isWin = process.platform === 'win32';

// The mouse_event flag bits.
const MOUSEEVENTF = {
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
};
// keybd_event's second flag: the key coming back up.
const KEYEVENTF_KEYUP = 0x0002;
// A wheel notch, in the units mouse_event expects.
const WHEEL_DELTA = 120;

const PRELUDE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CuInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static void MovePointer(int x, int y) { SetCursorPos(x, y); }

  public static void Button(uint down, uint up, int count) {
    for (int i = 0; i < count; i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(30);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
      if (i + 1 < count) System.Threading.Thread.Sleep(30);
    }
  }

  public static void Wheel(uint flag, int notches) {
    // One call per notch: a single call carrying a large delta is clipped by some applications.
    int dir = notches < 0 ? -1 : 1;
    for (int i = 0; i < Math.Abs(notches); i++) {
      mouse_event(flag, 0, 0, (uint)(dir * 120), UIntPtr.Zero);
      System.Threading.Thread.Sleep(12);
    }
  }

  public static void KeyDown(byte vk) {
    byte scan = (byte)MapVirtualKey(vk, 0);
    keybd_event(vk, scan, 0, UIntPtr.Zero);
  }

  public static void KeyUp(byte vk) {
    byte scan = (byte)MapVirtualKey(vk, 0);
    keybd_event(vk, scan, 2, UIntPtr.Zero);
  }

  // One UTF-16 code unit as a Unicode key event.
  //
  // keybd_event's scan parameter is a single BYTE, so it can carry only a code unit up to 0xFF —
  // useless for CJK, which starts at 0x4E00. The character therefore goes through SendInput, whose
  // KEYBDINPUT.wScan is a ushort and holds any BMP code unit. This is the one place SendInput is
  // genuinely needed; the union trap that made the mouse calls no-ops does not apply when only the
  // keyboard arm of the union is used.
  public static void UnicodeUnit(ushort unit) {
    INPUT[] a = new INPUT[2];
    a[0].type = 1; a[0].ki.wVk = 0; a[0].ki.wScan = unit; a[0].ki.dwFlags = 0x0004;
    a[1].type = 1; a[1].ki.wVk = 0; a[1].ki.wScan = unit; a[1].ki.dwFlags = 0x0004 | 0x0002;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }

  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);

  // A UNION: the keyboard and mouse arms begin at the SAME byte. Declared sequentially they occupy
  // different bytes, the struct is the wrong size, and SendInput rejects every call — which is how
  // the mouse actions came to report success while doing nothing.
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;
    [FieldOffset(8)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }

  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
}
"@

# Bring a window to the front and keep it there.
#
# Windows has a FOREGROUND LOCK: a process that does not own the current foreground window is
# refused permission to change it, and SetForegroundWindow simply returns false. The way through is
# to attach this thread's input queue to the foreground window's thread, which lends it that
# thread's standing, then detach. Retried, because the foreground can change under us.
function BringToFront([IntPtr]$h) {
  for ($i = 0; $i -lt 5; $i++) {
    if ([CuInput]::IsForeground($h)) { return $true }
    $fg = [CuInput]::GetForegroundWindow()
    $fgPid = 0
    [CuInput]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
    $cur = [CuInput]::GetCurrentThreadId()
    [CuInput]::AttachThreadInput($cur, $fgPid, $true) | Out-Null
    try {
      [CuInput]::BringWindowToTop($h) | Out-Null
      [CuInput]::SetForegroundWindow($h) | Out-Null
      [CuInput]::SetActiveWindow($h) | Out-Null
    } finally {
      [CuInput]::AttachThreadInput($cur, $fgPid, $false) | Out-Null
    }
    Start-Sleep -Milliseconds 60
    if ([CuInput]::IsForeground($h)) { return $true }
  }
  return [CuInput]::IsForeground($h)
}

# Un-minimise, then make sure the window is actually ON SCREEN.
#
# A window can sit at a valid rectangle outside every monitor — a disconnected second display leaves
# it there — and every click computed from its rectangle then lands on nothing. The rectangle is
# pulled back inside the primary monitor's bounds when it has drifted out.
function EnsureOnScreen([IntPtr]$h) {
  [CuInput]::ShowWindow($h, 5) | Out-Null
  Start-Sleep -Milliseconds 120
  $r = New-Object CuInput+RECT
  if (-not [CuInput]::GetWindowRect($h, [ref]$r)) { return }
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  $sw = [CuInput]::GetSystemMetrics(0); $sh = [CuInput]::GetSystemMetrics(1)
  $nx = $r.L; $ny = $r.T
  if ($w -ge $sw -or $ht -ge $sh) {
    $nx = [Math]::Max(0, [int](($sw - $w) / 2)); $ny = [Math]::Max(0, [int](($sh - $ht) / 2))
  } else {
    if ($r.L -lt 0) { $nx = 0 } elseif ($r.L + $w -gt $sw) { $nx = $sw - $w }
    if ($r.T -lt 0) { $ny = 0 } elseif ($r.T + $ht -gt $sh) { $ny = $sh - $ht }
  }
  if ($nx -ne $r.L -or $ny -ne $r.T) {
    [CuInput]::MoveWindow($h, $nx, $ny, $w, $ht, $true) | Out-Null
    Start-Sleep -Milliseconds 150
  }
}
`;

async function ps(script, { timeoutMs = 30000 } = {}) {
  const exe = (await have('pwsh')) ? 'pwsh' : 'powershell';
  const wrapped = `$ErrorActionPreference = "Stop"\ntry {\n${PRELUDE}\n${script}\n} catch { Write-Output ("__CUERR__" + $_.Exception.Message) }`;
  const out = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', wrapped], { timeoutMs });
  const err = /__CUERR__(.*)/.exec(out);
  if (err) throw new Error(err[1].trim());
  return out;
}

/** Move the pointer to a virtual-desktop coordinate. */
export async function moveTo(x, y) {
  if (!isWin) return unsupported('mouse control on Windows only');
  const px = toInt(x, 0);
  const py = toInt(y, 0);
  await ps(`[CuInput]::MovePointer(${px}, ${py})\nWrite-Output 'ok'`);
  return { x: px, y: py };
}

/** The pointer's current position. */
export async function cursorPos() {
  if (!isWin) return unsupported('mouse control on Windows only');
  const out = await ps('$p = New-Object CuInput+POINT\n[CuInput]::GetCursorPos([ref]$p) | Out-Null\nWrite-Output ("{0},{1}" -f $p.X, $p.Y)');
  const m = /(-?\d+),(-?\d+)/.exec(out);
  if (!m) throw new Error(`could not read the cursor position: ${out.trim().slice(0, 200)}`);
  return { x: +m[1], y: +m[2] };
}

/**
 * Move, then click.
 *
 * The move is part of the click: an application that pairs a hover with a click — a menu, a tooltip,
 * a drag target — does nothing if the button arrives without the pointer, and the pause lets the
 * window process the move before the button. `Button` presses and releases with a gap for the same
 * reason: some applications ignore a press and release that arrive in the same millisecond.
 */
export async function clickAt(x, y, { button = 'left', clicks = 1 } = {}) {
  if (!isWin) return unsupported('mouse control on Windows only');
  const px = toInt(x, 0);
  const py = toInt(y, 0);
  const n = toInt(clicks, 1, 1, 3);
  const [down, up] = button === 'right'
    ? [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP]
    : button === 'middle'
      ? [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP]
      : [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP];
  await ps([
    `[CuInput]::MovePointer(${px}, ${py})`,
    'Start-Sleep -Milliseconds 40',
    `[CuInput]::Button(${down}, ${up}, ${n})`,
    "Write-Output 'ok'",
  ].join('\n'));
  return { x: px, y: py, button, clicks: n };
}

/** Press and release without moving — for use after an explicit MouseMove. */
export async function clickHere({ button = 'left', clicks = 1 } = {}) {
  if (!isWin) return unsupported('mouse control on Windows only');
  const n = toInt(clicks, 1, 1, 3);
  const [down, up] = button === 'right'
    ? [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP]
    : button === 'middle'
      ? [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP]
      : [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP];
  await ps(`[CuInput]::Button(${down}, ${up}, ${n})\nWrite-Output 'ok'`);
  return { button, clicks: n };
}

/**
 * Drag from one point to another.
 *
 * The path is interpolated rather than jumped: a single jump is a teleport, and a drop target that
 * tracks the pointer — a sortable list, a slider, a file manager — never sees it.
 */
export async function drag(fromX, fromY, toX, toY, { button = 'left', steps = 12, durationMs = 300 } = {}) {
  if (!isWin) return unsupported('mouse control on Windows only');
  const fx = toInt(fromX, 0), fy = toInt(fromY, 0);
  const tx = toInt(toX, 0), ty = toInt(toY, 0);
  const n = toInt(steps, 12, 2, 100);
  const hold = toInt(durationMs, 300, 0, 5000);
  const [down, up] = button === 'right'
    ? [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP]
    : button === 'middle'
      ? [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP]
      : [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP];
  const lines = [
    `[CuInput]::MovePointer(${fx}, ${fy})`,
    'Start-Sleep -Milliseconds 40',
    `[CuInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)`,
    'Start-Sleep -Milliseconds 60',
  ];
  for (let i = 1; i <= n; i++) {
    const x = Math.round(fx + ((tx - fx) * i) / n);
    const y = Math.round(fy + ((ty - fy) * i) / n);
    lines.push(`[CuInput]::MovePointer(${x}, ${y})`);
    if (hold) lines.push(`Start-Sleep -Milliseconds ${Math.max(1, Math.round(hold / n))}`);
  }
  lines.push(`[CuInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`);
  lines.push("Write-Output 'ok'");
  await ps(lines.join('\n'));
  return { from: { x: fx, y: fy }, to: { x: tx, y: ty }, button };
}

/** Scroll the wheel. Positive `dy` scrolls up; positive `dx` scrolls right. */
export async function scroll({ dx = 0, dy = 0, x = null, y = null } = {}) {
  if (!isWin) return unsupported('mouse control on Windows only');
  const notchesY = toInt(dy, 0, -100, 100);
  const notchesX = toInt(dx, 0, -100, 100);
  const lines = [];
  if (x != null && y != null) {
    lines.push(`[CuInput]::MovePointer(${toInt(x, 0)}, ${toInt(y, 0)})`);
    lines.push('Start-Sleep -Milliseconds 40');
  }
  if (notchesY) lines.push(`[CuInput]::Wheel(${MOUSEEVENTF.WHEEL}, ${notchesY})`);
  if (notchesX) lines.push(`[CuInput]::Wheel(${MOUSEEVENTF.HWHEEL}, ${notchesX})`);
  lines.push("Write-Output 'ok'");
  await ps(lines.join('\n'));
  return { dx: notchesX, dy: notchesY };
}

/**
 * The virtual key codes for the named keys.
 *
 * Values from the Win32 VK_ constants. The left/right variants are distinct codes rather than a
 * modifier plus a flag, which is why `ctrl+shift+escape` and `lctrl` both work.
 */
const VK = {
  enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B, space: 0x20,
  backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2C, pause: 0x13,
  win: 0x5B, lwin: 0x5B, rwin: 0x5C, apps: 0x5D, meta: 0x5B, super: 0x5B,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12, shift: 0x10,
  lctrl: 0xA2, rctrl: 0xA3, lalt: 0xA4, ralt: 0xA5, lshift: 0xA0, rshift: 0xA1,
  // Named punctuation, because "+" and "-" inside a chord like ctrl+"+" split badly on +.
  plus: 0xBB, minus: 0xBD, comma: 0xBC, period: 0xBE, slash: 0xBF, backslash: 0xDC,
  semicolon: 0xBA, quote: 0xDE, grave: 0xC0, lbracket: 0xDB, rbracket: 0xDD,
};

/** Turn one key name into a virtual key code. */
export function vkFor(name) {
  const k = String(name || '').trim().toLowerCase();
  if (!k) return null;
  if (Object.prototype.hasOwnProperty.call(VK, k)) return VK[k];
  if (k.length === 1) {
    const up = k.toUpperCase();
    // A..Z and 0..9 coincide with their ASCII codes as virtual keys.
    if ((up >= 'A' && up <= 'Z') || (up >= '0' && up <= '9')) return up.charCodeAt(0);
  }
  return null;
}

/**
 * Press a key or a chord, e.g. `"ctrl+s"`, `"alt+tab"`, `"enter"`.
 *
 * Modifiers are held for the whole chord and released in reverse — the order a real keyboard
 * produces them. Pressing ctrl, releasing it, then pressing s is three separate events and reaches
 * the application as `ctrl` followed by `s`, not as the chord.
 */
export async function keyPress(combo) {
  if (!isWin) return unsupported('keyboard control on Windows only');
  const parts = String(combo || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('no key given');
  const codes = [];
  for (const p of parts) {
    const vk = vkFor(p);
    if (vk == null) throw new Error(`unknown key: "${p}". Try a letter, a digit, or one of: ${Object.keys(VK).slice(0, 20).join(', ')}`);
    codes.push(vk);
  }
  const lines = [];
  for (const c of codes) lines.push(`[CuInput]::KeyDown(${c})`);
  lines.push('Start-Sleep -Milliseconds 20');
  for (const c of codes.slice().reverse()) lines.push(`[CuInput]::KeyUp(${c})`);
  lines.push("Write-Output 'ok'");
  await ps(lines.join('\n'));
  return { keys: parts };
}

/**
 * Type text as Unicode characters.
 *
 * Iterates CODE POINTS, not code units. `for (const ch of s)` walks UTF-16 units, so an emoji
 * arrives as two lone surrogates and each half is rejected — 0x1F389 does not fit one unit.
 * Spreading the string yields whole characters, and one above the BMP is split into its surrogate
 * pair here, which is the two events SendInput wants for it.
 *
 * Sent in chunks with a pause between: a long string posted as one burst arrives faster than some
 * applications poll, and they drop characters.
 */
export async function typeText(text) {
  if (!isWin) return unsupported('keyboard control on Windows only');
  const s = String(text == null ? '' : text);
  if (!s) return { typed: 0 };
  const CHUNK = 200;
  const lines = [];
  const points = [...s];
  for (let i = 0; i < points.length; i += CHUNK) {
    for (const ch of points.slice(i, i + CHUNK)) {
      // A newline is not a Unicode character event; it is VK_RETURN.
      if (ch === '\n') { lines.push('[CuInput]::KeyDown(0x0D)'); lines.push('[CuInput]::KeyUp(0x0D)'); continue; }
      if (ch === '\r') continue;
      const cp = ch.codePointAt(0);
      if (cp > 0xFFFF) {
        const v = cp - 0x10000;
        lines.push(`[CuInput]::UnicodeUnit(${0xD800 + (v >> 10)})`);
        lines.push(`[CuInput]::UnicodeUnit(${0xDC00 + (v & 0x3FF)})`);
      } else {
        lines.push(`[CuInput]::UnicodeUnit(${cp})`);
      }
    }
    lines.push('Start-Sleep -Milliseconds 10');
  }
  lines.push("Write-Output 'ok'");
  await ps(lines.join('\n'), { timeoutMs: 120000 });
  return { typed: points.length };
}
/** Hold a set of modifiers, run a callback, then release them — for a multi-step chord. */
export async function withModifiers(modifiers, fn) {
  const codes = (modifiers || []).map(vkFor).filter((c) => c != null);
  const down = codes.map((c) => `[CuInput]::KeyDown(${c})`).join('\n');
  const up = codes.slice().reverse().map((c) => `[CuInput]::KeyUp(${c})`).join('\n');
  if (codes.length) await ps(`${down}\nStart-Sleep -Milliseconds 30\nWrite-Output 'ok'`);
  try {
    return await fn();
  } finally {
    if (codes.length) await ps(`${up}\nWrite-Output 'ok'`).catch(() => {});
  }
}

/**
 * Bring a window to the front, and make sure it is on screen.
 *
 * `SetForegroundWindow` alone is not enough: Windows has a foreground lock that refuses the call
 * from a process that does not already own the foreground, and it fails by returning false rather
 * than by throwing. The prelude's `BringToFront` attaches to the foreground thread to get through
 * it, and `EnsureOnScreen` pulls the window back if its rectangle has drifted off every monitor —
 * a window there is visible to `GetWindowRect` and clickable by nobody.
 */
export async function focusWindow(hwnd) {
  if (!isWin) return unsupported('window focus on Windows only');
  const out = await ps([
    `$h = [IntPtr]${toInt(hwnd, 0)}`,
    // Un-minimise first: a minimised window cannot become foreground.
    'if ([CuInput]::IsIconic($h)) { [CuInput]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 200 }',
    'EnsureOnScreen $h',
    '$ok = BringToFront $h',
    'Write-Output ("front=" + $ok)',
  ].join('\n'));
  return { ok: /front=True/.test(out), onScreen: true };
}

export { isWin, MOUSEEVENTF, VK };
