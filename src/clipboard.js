// Clipboard access, fast enough for a keypress.
//
// Spawning a fresh PowerShell costs ~1.5-3s on Windows (cold start), which made
// Ctrl+Shift+C and every paste feel broken. So:
//   copy  -> clip.exe with UTF-16LE input (~100ms, no PowerShell at all).
//   read  -> ONE long-lived PowerShell child, pre-warmed at TUI start; a command
//            on an already-running shell costs ~100-230ms instead of seconds.
//            If the helper is unusable, fall back to a one-shot PowerShell.
// Non-Windows paths (pbcopy/pbpaste/xclip) are cheap enough to run per call.
//
// THREE THINGS MADE THE FIRST PASTE FAIL, all measured on the shipping code:
//   * The helper was "ready" the instant `spawn` returned, but the shell needs
//     ~2-3s before it can answer anything. A read in that window was sent to a
//     shell that had not started reading stdin yet, so it burned `helperRun`'s
//     full 3s deadline and then fell through to the cold one-shot.
//   * Worse, the warm sequence's sentinel was written WITHOUT a queued resolver
//     ("so it drains from the buffer"). When a read pushed its resolver before
//     that sentinel came back, the SENTINEL consumed the read's slot and resolved
//     it with its own empty output — so the paste reported "Clipboard empty or
//     unavailable" while the real answer (with the actual clipboard content) was
//     dropped on the floor. Reproduced deliberately: the read got "", and the
//     payload arrived afterwards with nobody left to receive it.
//   * The fallback ran `powershell` (5.1) with an 8s timeout. Loading
//     WinForms + Drawing there measured 3.8s idle and 11.5s on a busy machine —
//     past the timeout, so `execSync` threw and the paste reported "unavailable"
//     for a clipboard that was fine. `pwsh` does the same work in 1.9s.
// The warm-up also used to spawn a THROWAWAY shell (`pwsh -Command exit`) through
// `execSync` to decide which exe to use, blocking the TUI's startup path for ~1.9s
// before its first paint. The exe is discovered from the spawn's own `error` event
// now, so nothing blocks.

import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENT = '@@HNCODE_CLIP@@';
let helper = null;      // long-lived PowerShell child
let helperBuf = '';     // stdout accumulated since the last sentinel
let helperQueue = [];   // pending read() resolvers, ONE per sentinel written
let helperBusy = false; // one command in flight at a time
let helperReady = false; // the warm sequence has answered: the shell can take commands

/** How long a read will wait for the helper to finish warming. It is already coming
 *  up, and waiting for a ~10ms answer beats the multi-second cold fallback. */
const HELPER_READY_MS = 6000;

/** Deadline for ONE command on a warm shell. Only reached when the shell has already
 *  answered, so it is a hang detector, not a warm-up budget. */
const HELPER_CMD_MS = 3000;

/** Deadline for the cold one-shot fallback. Raised from 8s: loading WinForms and
 *  Drawing in powershell 5.1 measured 11.5s under load, and the old timeout turned
 *  that into a spurious "clipboard unavailable". This is the last resort, so it is
 *  allowed to be slow — failing here helps nobody. */
const ONESHOT_MS = 20000;

function win() { return process.platform === 'win32'; }

// ---------------------------------------------------------------- copy
export function copyText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  if (win()) {
    // clip.exe takes UTF-16LE. (`cmd /c echo "…" | clip` mangled quotes, '%'
    // and newlines; plain UTF-8 input turned non-ASCII into mojibake.) Prefix the
    // UTF-16 byte order mark (FF FE) so clip.exe is never left to guess the endian
    // or treat input as ANSI — without it, non-ASCII on some Windows versions /
    // code pages came out mojibake.
    cp.execSync('clip', { input: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]), windowsHide: true, timeout: 5000 });
    return true;
  }
  const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
  cp.execSync(cmd, { input: Buffer.from(s, 'utf8'), timeout: 5000 });
  return true;
}

// Which PowerShell the helper runs. `pwsh` (7) starts far faster than the built-in
// `powershell` (5.1) — measured 1.9s vs 11.5s for the same image probe — and the image
// path needs the WinForms/Drawing assemblies. This is only the PREFERRED name: it is
// resolved from the spawn's own `error` event (see startHelper), so discovering that a
// box has no pwsh costs nothing instead of blocking the TUI's startup path with a
// throwaway shell.
let _psExe = 'pwsh';

/** One-shot PowerShell, preferring the exe the helper resolved. Returns stdout, or
 *  null when neither exe could answer. A machine without `pwsh` has to be able to
 *  fall back WITHOUT the startup-time probe that used to decide this. */
function runPowershell(args, opts) {
  const tried = [];
  for (const exe of [_psExe, 'powershell']) {
    if (tried.includes(exe)) continue;
    tried.push(exe);
    try { return cp.execSync(`${exe} ${args}`, opts); } catch { /* try the next exe */ }
  }
  return null;
}

// ------------------------------------------------------- PowerShell helper
export function warmClipboard() {
  if (!win() || helper) return;
  startHelper(_psExe);
}

/** Spawn the long-lived shell. `exe` is tried first; if that exe does not exist,
 *  the spawn reports ENOENT on its `error` event and this retries with 5.1. */
function startHelper(exe) {
  try {
    helper = cp.spawn(exe, ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { helper = null; return; }
  helperReady = false;
  helper.on('error', () => {
    const missing = helper;
    dropHelper();
    // `pwsh` absent (or unusable): fall back to the built-in shell once.
    if (exe !== 'powershell' && missing) { _psExe = 'powershell'; warmClipboard(); }
  });
  helper.on('exit', () => dropHelper());
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
  helper.stdin.write('$ProgressPreference = "SilentlyContinue"\n');
  // Pre-load the image assemblies ONCE, at warm time. Loading them lazily inside
  // the probe cost ~3.6s on 5.1 — longer than the probe timeout — so the FIRST
  // image paste always failed. Doing it up front moves that cost off the paste
  // path entirely (the shell is warmed at TUI start, not on a keypress).
  //
  // This sentinel is QUEUED like every other command answer, and that is the whole
  // point: written without a resolver it used to be claimed by whatever read pushed
  // its resolver first, which handed that read THIS empty output and dropped the
  // read's own answer — the first paste after startup reported "Clipboard empty or
  // unavailable" for a clipboard that had content. The queued resolver here is what
  // marks the shell as ready, so one sentinel still has exactly one owner.
  helperQueue.push(() => { helperReady = true; });
  helper.stdin.write("try { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing } catch {}\n'" + SENT + "'\n");
}

/** Tear down the helper and release every waiter. A read must never be left hanging on
 *  a shell that has died — it has a cold fallback to get to. */
function dropHelper() {
  helper = null;
  helperBusy = false;
  helperReady = false;
  helperBuf = '';
  const waiting = helperQueue;
  helperQueue = [];
  for (const w of waiting) w(null);
}

/** Resolve once the shell can take commands, or false when it never got there. */
async function waitHelperReady(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (helperReady) return true;
    if (!helper) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return helperReady;
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
    const b64 = runPowershell(
      '-NoProfile -Command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw) + \'\'))"',
      { encoding: 'ascii', windowsHide: true, timeout: ONESHOT_MS },
    );
    if (b64 == null) throw new Error('no powershell');
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(s, 'base64').toString('utf8');
  }
  const cmd = process.platform === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o';
  return cp.execSync(cmd, { encoding: 'utf8', timeout: 5000 });
}

// Async read: uses the warm helper when available. Returns { text, via } so the
// caller can tell the user which path answered.
export async function readText(timeoutMs = HELPER_CMD_MS) {
  if (win()) {
    warmClipboard();
    // Same readiness gate as the probe: a read sent to a shell that has not finished
    // warming is answered by nothing, and the cold path is the expensive one.
    if (helper && await waitHelperReady(HELPER_READY_MS)) {
      helperBusy = true;
      const out = await helperRun('[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw) + ""))', timeoutMs);
      if (out != null) {
        const b64 = out.replace(/\r/g, '').split('\n').filter((l) => l.trim()).pop() || '';
        try { return { text: Buffer.from(b64.trim(), 'base64').toString('utf8'), via: 'helper' }; } catch {}
      }
      helperBusy = false;
    }
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
//
// The image branch uses the .NET WinForms clipboard, NOT `Get-Clipboard -Image`:
// that parameter only exists on some builds (and is absent even from the pwsh 7
// in use here), so it silently failed everywhere and image paste never worked.
// `[Windows.Forms.Clipboard]::GetImage()` exists on Windows PowerShell 5.1 AND
// pwsh 7 — verified on 5.1 — so it is the portable way to read a copied image.
const CLIP_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$f=Get-Clipboard -Format FileDropList",
  "if($f -and $f.Count -gt 0){$f|ForEach-Object{'F::'+$_.FullName};return}",
  "$t=Get-Clipboard -Raw",
  "if($t){'T::'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t));return}",
  // The assemblies are loaded once by warmClipboard(); no Add-Type here, so the
  // probe stays fast even the first time an image is on the clipboard.
  "$i=[System.Windows.Forms.Clipboard]::GetImage()",
  "if($null -ne $i){$p=Join-Path $env:TEMP ('hncode-paste-'+[guid]::NewGuid().ToString('N')+'.png');$i.Save($p,[System.Drawing.Imaging.ImageFormat]::Png);'I::'+$p}",
].join('; ');

// Parse the probe output into { text, via }. Handles one-or-more F:: lines.
function parseClipResult(out) {
  const lines = String(out == null ? '' : out).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const fileLines = lines.filter((l) => l.startsWith('F::'));
  if (fileLines.length) return { text: fileLines.map((l) => l.slice(3).trim()).join('\n'), via: 'files' };
  const imgLine = lines.find((l) => l.startsWith('I::'));
  if (imgLine) { const p = imgLine.slice(3).trim(); trackPastedImage(p); return { text: p, via: 'image' }; }
  const txtLine = lines.find((l) => l.startsWith('T::'));
  if (txtLine) {
    try { return { text: Buffer.from(txtLine.slice(3).trim(), 'base64').toString('utf8'), via: 'text' }; }
    catch { return null; }
  }
  return null;
}

// ---- pasted-image lifecycle ------------------------------------------------
// A pasted image is written to a temp .png (the model needs a PATH to hand to
// ReadMediaFile), so something has to remove it again or the temp dir fills up
// one screenshot at a time. Every path the probe reports is remembered here and
// the TUI deletes the whole set on exit — see cleanupPastedImages().
const pastedImages = new Set();

function trackPastedImage(p) {
  if (p) pastedImages.add(p);
}

/**
 * Delete every image this process wrote to a temp file. Safe to call from a
 * `process.on('exit')` handler: it is fully synchronous and swallows errors (a
 * locked file must not turn a clean exit into a failed one).
 * Returns the number of files removed.
 */
export function cleanupPastedImages() {
  let removed = 0;
  for (const p of pastedImages) {
    try { fs.rmSync(p, { force: true }); removed++; } catch { /* locked/missing: ignore */ }
  }
  pastedImages.clear();
  return removed;
}

/** How many pasted images are still on disk (diagnostics/tests). */
export function pastedImageCount() { return pastedImages.size; }

// Run the probe on the warm helper (fast path). Resolves null if it is not ready.
async function readViaHelper() {
  warmClipboard();
  if (!helper) return null;
  // Wait for the shell to finish warming FIRST. The warm sequence is already in
  // flight, so this waits for something that is going to happen anyway; sending the
  // probe early meant it was answered by nobody, which cost the full command
  // deadline and then fell through to the cold one-shot — several seconds for a
  // clipboard the helper could have read in ~10ms.
  if (!helperReady && !await waitHelperReady(HELPER_READY_MS)) return null;
  // Then wait briefly for any in-flight command (e.g. a concurrent readText) to
  // drain, so we still hit the warm shell instead of falling back to a cold spawn.
  for (let i = 0; i < 20 && helperBusy; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (helperBusy || !helper) return null;
  helperBusy = true;
  const out = await helperRun(CLIP_PROBE, HELPER_CMD_MS);
  return out == null ? null : parseClipResult(out);
}

export function readClipboardContent() {
  if (!win()) {
    try { return { text: readOnce(), via: 'oneshot' }; } catch { return { text: '', via: 'none' }; }
  }
  // Synchronous API is required by the caller, so use a one-shot PowerShell here
  // and let the async path (readClipboardContentAsync) use the warm helper. The exe
  // is the one the helper resolved — `powershell` 5.1 measured 11.5s on the same
  // probe that `pwsh` did in 1.9s, and the old 8s deadline turned that into a
  // spurious "clipboard unavailable".
  const scriptFile = clipScriptPath();
  if (!scriptFile) return { text: '', via: 'none' };
  const out = runPowershell(
    `-NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
    { encoding: 'utf8', windowsHide: true, timeout: ONESHOT_MS },
  );
  if (out == null) return { text: '', via: 'none' };
  return parseClipResult(out) || { text: '', via: 'none' };
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
    // .NET clipboard, not `Get-Clipboard -Image` (see the CLIP_PROBE note).
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
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
