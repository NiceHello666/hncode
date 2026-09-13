import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = (m) => process.stderr.write(m + '\n');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur2-'));
fs.writeFileSync(path.join(tmpDir, 'config.toml'), 'model = "A/m"\n\n[providers.A]\nbase_url = "https://a.test/v1"\napi_key = "k"\n\n[models."A/m"]\nprovider = "A"\nmodel = "m"\n', 'utf8');
process.env.HNCODE_CONFIG = path.join(tmpDir, 'config.toml');
process.env.HNCODE_SESSIONS_DIR = path.join(tmpDir, 'sessions');
const captured = [];
class FakeOut extends EventEmitter { constructor() { super(); this.isTTY = true; this.columns = 90; this.rows = 26; } write(s) { captured.push(String(s)); return true; } getWindowSize() { return [90, 26]; } getColorDepth() { return 24; } }
class FakeIn extends EventEmitter { constructor() { super(); this.isTTY = true; this.isRaw = false; } setRawMode(v) { this.isRaw = v; return this; } resume() { return this; } pause() { return this; } setEncoding() { return this; } feed(s) { this.emit('data', s); } }
const fakeIn = new FakeIn();
process.stdout.write = (s) => { captured.push(String(s)); return true; };
process.stdout.getWindowSize = () => [90, 26];
process.stdout.isTTY = true; process.stdin.isTTY = true;
process.stdin.setRawMode = (v) => { fakeIn.isRaw = v; return fakeIn; };
process.stdin.resume = () => fakeIn; process.stdin.pause = () => fakeIn;
process.stdin.setEncoding = () => fakeIn; process.stdin.on = (...a) => fakeIn.on(...a);
process.stdin.removeListener = (...a) => fakeIn.removeListener(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { startTUI } = await import('./src/tui.js');
const { resolveConfig } = await import('./src/config.js');
const cfg = resolveConfig();
startTUI({ cfg: { ...cfg }, session: { id: 'c', workspace: 'D:\\hncode', title: '', messages: [] }, auto: true }).catch((e) => out('ERR ' + e.message));
await sleep(250);
captured.length = 0;
fakeIn.feed('/settings'); await sleep(20); fakeIn.feed('\r'); await sleep(350);
const all = captured.join('');
out('caret sequences: ' + (all.match(/\x1b\[7m/g) || []).length);
let cur = null;
for (const p of all.split(/(\x1b\[\d+;\d+H)/)) {
  const m = /^\x1b\[(\d+);\d+H$/.exec(p);
  if (m) { cur = Number(m[1]); continue; }
  if (/\x1b\[7m/.test(p)) out('  caret on screen row ' + cur + ': ' + JSON.stringify(p.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(0, 54)));
}
process.exit(0);
