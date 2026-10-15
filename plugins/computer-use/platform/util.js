// Shared helpers for the computer-use backends.
//
// WHY A BACKEND PER PLATFORM
// --------------------------
// There is no portable way to take a screenshot, read a window's control tree, or move the
// mouse. Each OS has its own mechanism, and they differ in kind rather than in spelling:
//
//   Windows  PowerShell + .NET: System.Drawing for pixels, UI Automation for the control tree,
//            SendInput (user32.dll) for input.
//   macOS    screencapture(1) for pixels, the Accessibility API (AXUIElement) for the tree,
//            osascript/keystroke for input.
//   Linux    grim (Wayland) or import (X11) for pixels, AT-SPI for the tree, xdotool or ydotool
//            for input.
//
// So each backend exposes the SAME small surface and the tools never learn about platforms. A
// capability a platform cannot provide returns { unsupported: 'reason' } rather than throwing
// or, worse, returning an empty result that reads like "there is nothing there".
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Run a program and resolve with its stdout. Rejects with the stderr attached. */
export function run(cmd, args, { timeoutMs = 30000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // The message matters more than the code: "pwsh not found" and "the script threw" need
        // different fixes, and a bare ENOENT tells the reader neither.
        const detail = String(stderr || '').trim() || err.message;
        reject(new Error(`${cmd}: ${detail}`));
        return;
      }
      resolve(String(stdout));
    });
    if (input != null) child.stdin.end(input);
  });
}

/** True when a program is on PATH. */
export async function have(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await run(probe, [cmd], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** A per-process scratch directory for captures. */
export function shotDir() {
  const dir = path.join(os.tmpdir(), 'hncode-computer-use');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let shotSeq = 0;

/** A fresh path for a capture, never reusing a name within the process. */
export function shotPath(tag = 'shot') {
  shotSeq += 1;
  return path.join(shotDir(), `${tag}-${Date.now()}-${shotSeq}.png`);
}

/**
 * The answer for a capability this platform does not have.
 *
 * A distinct shape from an error: the request was understood, the platform simply cannot do it.
 * The tools turn this into a sentence naming the missing mechanism, because "unsupported" alone
 * leaves the model retrying.
 */
export function unsupported(reason) {
  return { unsupported: reason };
}

/** True when a backend result is an unsupported-capability marker. */
export function isUnsupported(r) {
  return !!(r && typeof r === 'object' && typeof r.unsupported === 'string');
}

/** Clamp an integer argument, with a default. */
export function intArg(v, dflt, min = -Infinity, max = Infinity) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** A file's size in bytes, or 0. */
export function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Read a PNG's pixel dimensions from its IHDR chunk.
 *
 * Parsed rather than asked of an image library: the plugin has no dependencies, and the IHDR is
 * fixed-layout at a fixed offset, so this is both exact and instant. A capture whose size is
 * unknown is not useful to report — the model needs to know whether it got the whole screen.
 */
export function pngSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    // 8-byte signature, 4-byte length, "IHDR", then width and height as big-endian uint32.
    if (head.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------
//
// Cross-platform, so it lives here rather than in a per-platform backend: every platform has a
// program that does the job, and the differences are one command name each.

/**
 * Put text on the clipboard.
 *
 * WINDOWS USES `Set-Clipboard`, NOT `clip.exe`. `clip.exe` takes UTF-16 and needs a byte order mark
 * to be read correctly — without it non-ASCII arrives as mojibake — but the mark then becomes part of
 * the clipboard text, so every paste begins with a zero-width character. `Set-Clipboard` receives a
 * .NET string and has neither problem. Measured over six samples it was better on all of them,
 * including leaving line endings alone where `clip.exe` turned `\n` into `\r\n`.
 *
 * The text travels as base64 so nothing in it can terminate the PowerShell script or be re-parsed:
 * a quoted literal would need every quote doubled, and a newline or a backtick in the text would
 * otherwise change what the script means.
 */
export async function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return { ok: false, error: 'nothing to copy' };
  try {
    if (process.platform === 'win32') {
      const b64 = Buffer.from(s, 'utf16le').toString('base64');
      const script = 'Add-Type -AssemblyName System.Windows.Forms; '
        + '[System.Windows.Forms.Clipboard]::SetText('
        + `[System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${b64}')))`;
      const exe = (await have('pwsh')) ? 'pwsh' : 'powershell';
      await run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15000 });
      return { ok: true, length: s.length };
    }
    const cmd = process.platform === 'darwin' ? 'pbcopy'
      : (await have('xclip')) ? 'xclip' : (await have('wl-copy')) ? 'wl-copy' : null;
    if (!cmd) return unsupported('copying on Linux needs xclip (X11) or wl-copy (Wayland)');
    const args = cmd === 'xclip' ? ['-selection', 'clipboard'] : [];
    await run(cmd, args, { timeoutMs: 10000, input: s });
    return { ok: true, length: s.length };
  } catch (e) {
    return { error: `could not copy: ${(e && e.message) || String(e)}` };
  }
}

/**
 * Read the clipboard as text.
 *
 * A DISTINCT PLACEHOLDER rather than an empty string when clipboard reading is unavailable: an empty
 * result would read as "the clipboard is empty", which is a different and possibly false statement.
 */
export async function readClipboard() {
  try {
    if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; '
        + '[System.Windows.Forms.Clipboard]::GetText()';
      const exe = (await have('pwsh')) ? 'pwsh' : 'powershell';
      const out = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15000 });
      // PowerShell appends a newline to the output; that is the writer's, not the clipboard's.
      return { ok: true, text: out.replace(/\r?\n$/, '') };
    }
    const cmd = process.platform === 'darwin' ? 'pbpaste'
      : (await have('xclip')) ? 'xclip' : (await have('wl-paste')) ? 'wl-paste' : null;
    if (!cmd) return unsupported('reading the clipboard on Linux needs xclip (X11) or wl-paste (Wayland)');
    const args = cmd === 'xclip' ? ['-selection', 'clipboard', '-o'] : [];
    const out = await run(cmd, args, { timeoutMs: 10000 });
    return { ok: true, text: out };
  } catch (e) {
    return { error: `could not read the clipboard: ${(e && e.message) || String(e)}` };
  }
}
