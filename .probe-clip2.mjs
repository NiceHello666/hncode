// Probe: can clip.exe be used for a FAST copy (win32)? It is ~70ms vs ~2.9s for
// spawning powershell. clip.exe expects UTF-16LE for non-ASCII text.
import cp from 'node:child_process';
const sh = (cmd, opts) => cp.execSync(cmd, { windowsHide: true, timeout: 8000, ...opts });
const READ = 'powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"';
const orig = (() => { try { return sh(READ, { encoding: 'utf8' }); } catch { return ''; } })();

const text = 'line1\nline2 "quoted" 100% & $x 中文 ✅';
let a = Date.now();
sh('clip', { input: Buffer.from(text, 'utf16le') });
console.log('clip.exe utf16le write', Date.now() - a + 'ms');
console.log('read back:', JSON.stringify(sh(READ, { encoding: 'utf8' })));
console.log('match:', sh(READ, { encoding: 'utf8' }) === text);

try { sh('clip', { input: Buffer.from(orig, 'utf16le') }); console.log('restored clipboard'); } catch {}
