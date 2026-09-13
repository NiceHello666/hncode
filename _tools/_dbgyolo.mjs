// Reproduce: after typing /yolo + Enter, does the composer still show "/yolo"?
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = (m) => process.stderr.write(m + '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-'));
fs.writeFileSync(path.join(tmpDir, 'config.toml'), 'model = "A/m"\n\n[providers.A]\nbase_url = "https://a.test/v1"\napi_key = "k"\n\n[models."A/m"]\nprovider = "A"\nmodel = "m"\n', 'utf8');
process.env.HNCODE_CONFIG = path.join(tmpDir, 'config.toml');
process.env.HNCODE_SESSIONS_DIR = path.join(tmpDir, 'sessions');

const captured = [];
class FakeOut extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.columns = 110; this.rows = 30; }
  write(s) { captured.push(String(s)); return true; }
  getWindowSize() { return [110, 30]; }
  getColorDepth() { return 24; }
}
class FakeIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.isRaw = false; }
  setRawMode(v) { this.isRaw = v; return this; }
  resume() { return this; } pause() { return this; } setEncoding() { return this; }
  feed(s) { this.emit('data', s); }
}
const fakeIn = new FakeIn();
process.stdout.write = (s) => { captured.push(String(s)); return true; };
process.stdout.getWindowSize = () => [110, 30];
process.stdout.isTTY = true; process.stdin.isTTY = true;
process.stdin.setRawMode = (v) => { fakeIn.isRaw = v; return fakeIn; };
process.stdin.resume = () => fakeIn; process.stdin.pause = () => fakeIn;
process.stdin.setEncoding = () => fakeIn; process.stdin.on = (...a) => fakeIn.on(...a);
process.stdin.removeListener = (...a) => fakeIn.removeListener(...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { makeScreen } = await import('./_screen.mjs');
const screen = makeScreen();
const frame = () => { screen.reset(); screen.feed(captured.join('')); return screen.text(); };
// the composer content row is the box row containing "❯"
const composerLine = () => (frame().split('\n').find((l) => /│ ❯/.test(l)) || '').trim();

const { startTUI } = await import('../src/tui.js');
const { resolveConfig } = await import('../src/config.js');
const cfg = resolveConfig();
startTUI({ cfg: { ...cfg }, session: { id: 'y', workspace: 'D:\\hncode', title: '', messages: [] }, auto: false })
  .catch((e) => out('startTUI: ' + e.message));
await sleep(200);

out('--- before: composer is empty ---');
out('  composer: ' + JSON.stringify(composerLine()));

out('--- type /yolo (no Enter yet) ---');
fakeIn.feed('/yolo'); await sleep(150);
out('  composer: ' + JSON.stringify(composerLine()));

out('--- press Enter ---');
fakeIn.feed('\r'); await sleep(300);
out('  composer: ' + JSON.stringify(composerLine()));
out('  mode notice shown: ' + /Ask When Needed/.test(frame()));

out('--- type /auto then Enter ---');
fakeIn.feed('/auto'); await sleep(120); fakeIn.feed('\r'); await sleep(300);
out('  composer: ' + JSON.stringify(composerLine()));

out('--- type /model then Esc (cancel a picker) ---');
fakeIn.feed('/model'); await sleep(120); fakeIn.feed('\r'); await sleep(250);
fakeIn.feed('\x1b'); await sleep(250);
out('  composer: ' + JSON.stringify(composerLine()));

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(0);
