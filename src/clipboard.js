// Clipboard access, fast enough for a keypress.
//
// Spawning a fresh PowerShell costs ~1.5-3s on Windows (cold start), which made
// Ctrl+Shift+C and every paste feel broken. So:
//   copy  -> clip.exe with UTF-16LE input (~100ms, no PowerShell at all).
//   read  -> ONE long-lived PowerShell child, pre-warmed at TUI start; a command
//            on an already-running shell costs ~100-230ms instead of seconds.
//            If the helper is unusable, fall back to a one-shot PowerShell.
// Non-Windows paths (pbcopy/pbpaste/xclip) are cheap enough to run per call.

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENT = '@@HNCODE_CLIP@@';
let helper = null;      // long-lived PowerShell child
let helperBuf = '';     // stdout accumulated since the last sentinel
let helperQueue = [];   // pending read() resolvers
let helperBusy = false; // one command in flight at a time

function win() { return process.platform === 'win32'; }

// ---------------------------------------------------------------- copy
export function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  if (win()) {
    // clip.exe takes UTF-16LE. (`cmd /c echo "…" | clip` mangled quotes, '%'
    // and newlines; plain UTF-8 input turned non-ASCII into mojibake.)
    cp.execSync('clip', { input: Buffer.from(s, 'utf16le'), windowsHide: true, timeout: 5000 });
    return true;
  }
  const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
  cp.execSync(cmd, { input: Buffer.from(s, 'utf8'), timeout: 5000 });
  return true;
}

// ------------------------------------------------------- PowerShell helper
export function warmClipboard() {
  if (!win() || helper) return;
  try {
    helper = cp.spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    helper.stdout.on('data', (d) => {
      helperBuf += d.toString('binary');
      let i;
      while ((i = helperBuf.indexOf(SENT)) >= 0) {
        const chunk = helperBuf.slice(0, i);
        helperBuf = helperBuf.slice(i + SENT.length);
        const w = helperQueue.shift();
        helperBusy = false;
        if (w) w(chunk);
      }
    });
    helper.on('exit', () => { helper = null; helperBusy = false; });
    helper.on('error', () => { helper = null; helperBusy = false; });
    helper.stdin.write('$ProgressPreference = "SilentlyContinue"\n');
  } catch { helper = null; }
}

function helperRun(script, timeoutMs) {
  warmClipboard();
  if (!helper) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { helperBusy = false; resolve(null); }, timeoutMs);
    helperQueue.push((out) => { clearTimeout(timer); resolve(out); });
    try { helper.stdin.write(script + `\n'${SENT}'\n`); }
    catch { clearTimeout(timer); helperBusy = false; resolve(null); }
  });
}

// ---------------------------------------------------------------- read
// Base64 both ways: decoding PowerShell's stdout as UTF-8 garbled non-ASCII
// text (its pipe encoding follows the console code page), so instead of reading
// text we read base64 ASCII and decode it ourselves.
function readOnce() {
  if (win()) {
    const b64 = cp.execSync(
      'powershell -NoProfile -Command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw) + \'\'))"',
      { encoding: 'ascii', windowsHide: true, timeout: 8000 },
    );
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s, 'base64').toString('utf8');
  }
  const cmd = process.platform === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o';
  return cp.execSync(cmd, { encoding: 'utf8', timeout: 5000 });
}

// Async read: uses the warm helper when available. Returns { text, via } so the
// caller can tell the user which path answered.
export async function readText(timeoutMs = 3000) {
  if (win() && helper && !helperBusy) {
    helperBusy = true;
    const out = await helperRun('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw) + ""))', timeoutMs);
    if (out != null) {
      const b64 = out.replace(/\r/g, '').split('\n').filter((l) => l.trim()).pop() || '';
      try { return { text: Buffer.from(b64.trim(), 'base64').toString('utf8'), via: 'helper' }; } catch {}
    }
    helperBusy = false;
  }
  try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
}

// Unified clipboard read: returns text to insert into the composer, handling
// three clipboard shapes:
//   1. copied FILES          -> absolute path(s)
//   2. plain TEXT            -> the text itself
//   3. an IMAGE (screenshot) -> saved to a temp .png, returns its path
//
// SPEED: a cold PowerShell costs ~2.9s on Windows (measured), while a command on
// the already-warm, long-lived helper (see warmClipboard) costs ~10ms. The TUI
// pre-warms the helper at start, so we run this probe on THAT shell. Only if the
// helper is unavailable do we fall back to a one-shot PowerShell.
//
// The probe prints a tagged result that can be parsed cheaply:
//   F::<path>   a copied file path (one line per file)
//   T::<base64> base64-encoded clipboard text
//   I::<path>   a clipboard image saved to a temp png
//   (empty)     nothing usable on the clipboard
//
// NOTE: no `-join` here. A backtick-n inside the JS string produced a broken
// PowerShell expression (silently returned nothing), which made FILE pastes fall
// back to the slow cold spawn. Emitting one F:: line per file is simpler and
// also supports multi-file copies.
const CLIP_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$f=Get-Clipboard -Format FileDropList",
  "if($f -and $f.Count -gt 0){$f|ForEach-Object{'F::'+$_.FullName};return}",
  "$t=Get-Clipboard -Raw",
  "if($t){'T::'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t));return}",
  "$i=Get-Clipboard -Image",
  "if($null -ne $i){$p=Join-Path $env:TEMP ('hncode-paste-'+[guid]::NewGuid().ToString('N')+'.png');$i.Save($p,[System.Drawing.Imaging.ImageFormat]::Png);'I::'+$p}",
].join('; ');

// Parse the probe output into { text, via }. Handles one-or-more F:: lines.
function parseClipResult(out) {
  const lines = String(out == null ? '' : out).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const fileLines = lines.filter((l) => l.startsWith('F::'));
  if (fileLines.length) return { text: fileLines.map((l) => l.slice(3).trim()).join('\n'), via: 'files' };
  const imgLine = lines.find((l) => l.startsWith('I::'));
  if (imgLine) return { text: imgLine.slice(3).trim(), via: 'image' };
  const txtLine = lines.find((l) => l.startsWith('T::'));
  if (txtLine) {
    try { return { text: Buffer.from(txtLine.slice(3).trim(), 'base64').toString('utf8'), via: 'text' }; }
    catch { return null; }
  }
  return null;
}

// Run the probe on the warm helper (fast path). Resolves null if it is not ready.
async function readViaHelper() {
  warmClipboard();
  if (!helper) return null;
  // Wait briefly for any in-flight command (e.g. a concurrent readText) to drain,
  // so we still hit the warm shell instead of falling back to a cold spawn.
  for (let i = 0; i < 20 && helperBusy; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (helperBusy) return null;
  helperBusy = true;
  const out = await helperRun(CLIP_PROBE, 3000);
  return out == null ? null : parseClipResult(out);
}

export function readClipboardContent() {
  if (!win()) {
    try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
  }
  // Synchronous API is required by the caller, so use a one-shot PowerShell here
  // and let the async path (readClipboardContentAsync) use the warm helper.
  const scriptFile = clipScriptPath();
  if (!scriptFile) return { text: '', via: 'none' };
  try {
    const out = cp.execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    return parseClipResult(out) || { text: '', via: 'none' };
  } catch { return { text: '', via: 'none' }; }
}

// Async version that prefers the warm helper (~10ms) over a cold spawn (~2.9s).
export async function readClipboardContentAsync() {
  if (!win()) {
    try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
  }
  const viaHelper = await readViaHelper();
  if (viaHelper) return viaHelper;
  return readClipboardContent();
}

// The PowerShell logic for the one-shot fallback lives in a temp .ps1 file:
// passing a multi-line script via -Command "..." mangles its own quotes on
// Windows, so we write the script once and re-use it by path.
let _clipScript = null;
function clipScriptPath() {
  if (_clipScript) return _clipScript;
  const p = path.join(os.tmpdir(), 'hncode-clipread.ps1');
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$files = Get-Clipboard -Format FileDropList',
    'if ($files -and $files.Count -gt 0) { $files | ForEach-Object { "F::" + $_.FullName }; exit }',
    '$txt = Get-Clipboard -Raw',
    'if ($txt) { "T::" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($txt)); exit }',
    '$img = Get-Clipboard -Image',
    'if ($null -ne $img) {',
    '  $path = Join-Path $env:TEMP ("hncode-paste-" + [guid]::NewGuid().ToString("N") + ".png")',
    '  $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '  "I::" + $path',
    '}',
    '',
  ].join('\n');
  try { fs.writeFileSync(p, script, 'utf8'); } catch { return null; }
  _clipScript = p;
  return p;
}
