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
    const timer = setTimeout(() => { resolve(null); }, timeoutMs);
    helperQueue.push((out) => { clearTimeout(timer); resolve(out); });
    try { helper.stdin.write(script + `\n'${SENT}'\n`); }
    catch { clearTimeout(timer); resolve(null); }
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

// Read clipboard as image (base64 PNG). Returns null if clipboard has no image.
export function readImage() {
  if (!win()) return null;
  try {
    // PowerShell: Get-Clipboard -Image, save to temp file, read as base64
    const b64 = cp.execSync(
      'powershell -NoProfile -Command "$img = Get-Clipboard -Image; if ($null -ne $img) { $path = [System.IO.Path]::GetTempFileName() + \'.png\'; $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = [System.IO.File]::ReadAllBytes($path); Remove-Item $path; Write-Host ([Convert]::ToBase64String($bytes)) }"',
      { encoding: 'ascii', windowsHide: true, timeout: 8000 },
    );
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    if (s.length > 0) return s;
    return null;
  } catch { return null; }
}
