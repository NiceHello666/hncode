// Clipboard probe on win32: timing + correctness of each access path.
import cp from 'node:child_process';

const sh = (cmd, opts) => cp.execSync(cmd, { windowsHide: true, timeout: 8000, ...opts });
const READ = 'powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"';
const WRITE_PS = 'powershell -NoProfile -Command "Set-Clipboard -Value ([Console]::In.ReadToEnd())"';

const orig = (() => { try { return sh(READ, { encoding: 'utf8' }); } catch { return ''; } })();
const t = (label, fn) => {
  const a = Date.now();
  let r = '';
  try { r = fn(); } catch (e) { r = 'ERR ' + String(e.message).slice(0, 70); }
  console.log(label.padEnd(26), String(Date.now() - a).padStart(5) + 'ms', '=>', JSON.stringify(String(r).trim()).slice(0, 50));
  return r;
};

t('read (cold pwsh, = startup)', () => sh(READ, { encoding: 'utf8' }));

const text = 'line1\nline2 "quoted" 100% & $x 中文';
t('write Set-Clipboard stdin', () => sh(WRITE_PS, { input: Buffer.from(text, 'utf8') }));
t('read back (Set-Clipboard)', () => sh(READ, { encoding: 'utf8' }));

t('write clip.exe (ascii)', () => sh('clip', { input: Buffer.from('ascii only', 'utf8') }));
t('read back (clip ascii)', () => sh(READ, { encoding: 'utf8' }));

t('write clip.exe (cjk)', () => sh('clip', { input: Buffer.from('中文测试', 'utf8') }));
t('read back (clip cjk)', () => sh(READ, { encoding: 'utf8' }));

// A long-lived helper: how fast is a command on an already-running pwsh?
const child = cp.spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true });
let buf = '';
const waiters = [];
child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const w = waiters.shift(); if (w) w(l); } });
const run = (line) => new Promise((res) => { waiters.push(res); child.stdin.write(line + '\n'); });
t('persistent pwsh #1', () => { run('(Get-Clipboard -Raw).Length'); return 'queued'; });
await new Promise((r) => setTimeout(r, 1200));
const a = Date.now();
const one = await run('Set-Clipboard -Value ([Console]::In.ReadToEnd())');
console.log('persistent write took', Date.now() - a + 'ms', JSON.stringify(one));
child.kill();
try { sh(WRITE_PS, { input: Buffer.from(orig, 'utf8') }); console.log('restored original clipboard'); } catch {}
