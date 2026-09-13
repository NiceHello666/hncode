// Diagnose the queue_ctx failure: instrument the real timing of request #1.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const out = (m) => process.stderr.write(m + '\n');

const requests = [];
let releaseFirst;
const gate = new Promise((r) => { releaseFirst = r; });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    const n = requests.length;
    requests.push(JSON.parse(body || '{}'));
    out(`  [stub] request #${n} received at t+${Date.now() - T0}ms`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (n === 0) {
      await gate;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo hi"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: 'OK turn ' + n } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const T0 = Date.now();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgq-'));
fs.writeFileSync(path.join(tmpDir, 'config.toml'), `model = "A/m"\n\n[providers.A]\nbase_url = "http://127.0.0.1:${port}"\napi_key = "k"\nprotocol = "openai"\n\n[models."A/m"]\nprovider = "A"\nmodel = "m"\ncontext_length = 1000000\n`, 'utf8');
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
const { startTUI } = await import('../src/tui.js');
const { resolveConfig } = await import('../src/config.js');
const cfg = resolveConfig();
startTUI({ cfg: { ...cfg }, session: { id: 'q', workspace: 'D:\\hncode', title: '', messages: [] }, auto: true })
  .catch((e) => out('startTUI: ' + e.message));
await sleep(150);

out(`submitting the first prompt at t+${Date.now() - T0}ms`);
fakeIn.feed('do the thing'); await sleep(10); fakeIn.feed('\r');
for (const wait of [50, 120, 200, 400]) {
  await sleep(wait === 50 ? 50 : 70);
  out(`  t+${Date.now() - T0}ms: requests=${requests.length}`);
}
out(`\nWas request #1 issued within 120ms? ${requests.length >= 1 ? 'YES' : 'NO'}`);
out('requests so far: ' + requests.length);
releaseFirst();
await sleep(1200);
out('after release: ' + requests.length);
process.exit(0);
