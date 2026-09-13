// Probe: a persistent PowerShell helper for clipboard IO. Spawning powershell
// costs ~2.9s on this machine, which is why copy/paste felt broken — a warm
// child should be ~10ms. Base64 both ways to dodge pipe encoding issues.
import cp from 'node:child_process';

const t = (label, a) => console.log(label.padEnd(30), String(a).padStart(5) + 'ms');

const child = cp.spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', '-'], { windowsHide: true });
let buf = '';
const waiters = [];
const SENT = '@@HN@@';
child.stdout.on('data', (d) => {
  buf += d.toString('binary');
  let i;
  while ((i = buf.indexOf(SENT)) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + SENT.length);
    const w = waiters.shift();
    if (w) w(line);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()));

const run = (script) => new Promise((res) => {
  waiters.push(res);
  child.stdin.write(script + `; '${SENT}'\n`);
});

const warm = Date.now();
await run('$null = 1');
t('persistent pwsh warm-up', Date.now() - warm);

const text = 'line1\nline2 "quoted" 100% & $x 中文 ✅';
const b64 = Buffer.from(text, 'utf8').toString('base64');
let a = Date.now();
await run(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`);
t('write via persistent pwsh', Date.now() - a);

a = Date.now();
const out = await run(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw) + ''))`);
t('read via persistent pwsh', Date.now() - a);

const line = out.replace(/\r/g, '').trim().split('\n').filter((l) => l.trim()).pop();
const back = Buffer.from(line.trim(), 'base64').toString('utf8');
console.log('round-trip match:', back === text, JSON.stringify(back.slice(0, 60)));

a = Date.now();
const out2 = await run(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw) + ''))`);
t('read again (steady state)', Date.now() - a);

child.kill();
