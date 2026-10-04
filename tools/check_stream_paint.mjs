// Drives the REAL TUI headlessly and checks that a streamed reply reaches the screen
// WHOLE.   node tools/check_stream_paint.mjs
//
// WHY THIS EXISTS
// ---------------
// Streamed text does not go straight to the transcript: it goes through the paced
// StreamBuffer (src/stream-buffer.js), which decouples ARRIVAL from REVEAL. That layer
// has its own unit tests, and they all passed while the TUI was losing characters —
// because the loss was in the WIRING, not in the buffer:
//
//   streamBuf.pushText(e.text);   // the return value is the text due RIGHT NOW
//
// `pushText` / `pushReasoning` do not only enqueue: they hand back the characters the
// pacing controller says are due at this instant, and those characters are already off
// the buffer's queue when they come back. A caller that ignores the return value drops
// them for good. Measured on a one-chunk reply: the first 32 characters of the answer
// never appeared, which also swallowed the leading prose and the `<|plan|>` tag of a
// Plan-mode reply — so Plan mode saw no plan at all.
//
// A source-level assertion ("does the handler apply the returned ops?") would pin the
// SHAPE of the fix without pinning the behaviour, so this harness runs the real thing:
// a fake TTY, a fake provider that streams one coalesced burst, and the painted screen
// read back through a small terminal model. It is the only check that fails on the old
// wiring.
//
// Deliberately dependency-free and self-contained: no network, no real TTY, a temp
// HNCODE_HOME and workspace, and it removes both when it is done.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `process.stdout.write` is repurposed to capture the TUI's output, so the report below
// has to go through the ORIGINAL write.
const out = process.stdout.write.bind(process.stdout);
const say = (s) => out(s + '\n');

const COLS = 100;
const ROWS = 30;
const ESC = '\x1b';

/** A terminal faithful enough to read the painted screen back: cursor addressing, line
 *  clear, screen clear, CR/LF, and the frame's own box drawing. */
class Screen {
  constructor() {
    this.cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ' '));
    this.r = 0;
    this.c = 0;
  }

  write(s) {
    let i = 0;
    while (i < s.length) {
      if (s[i] === ESC) {
        let m = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(s.slice(i));
        if (m) {
          const p = m[1];
          const f = m[2];
          if (f === 'H' || f === 'f') {
            const a = p.split(';');
            this.r = Math.max(0, Math.min(ROWS - 1, Number(a[0] || 1) - 1));
            this.c = Math.max(0, Math.min(COLS - 1, Number(a[1] || 1) - 1));
          } else if (f === 'K') {
            for (let c = (p === '' || Number(p) === 0 ? this.c : 0); c < COLS; c++) this.cells[this.r][c] = ' ';
          } else if (f === 'J' && Number(p) === 2) {
            for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) this.cells[r][c] = ' ';
          }
          i += m[0].length;
          continue;
        }
        m = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
        if (m) { i += m[0].length; continue; }
        i += 1;
        continue;
      }
      if (s[i] === '\n') { this.r = Math.min(ROWS - 1, this.r + 1); this.c = 0; i++; continue; }
      if (s[i] === '\r') { this.c = 0; i++; continue; }
      const cp = s.codePointAt(i);
      if (this.c < COLS) this.cells[this.r][this.c] = String.fromCodePoint(cp);
      this.c = Math.min(COLS - 1, this.c + 1);
      i += cp > 0xffff ? 2 : 1;
    }
  }

  /** The painted screen as text. Box-drawing glyphs are replaced so a row can be
   *  matched with plain ASCII, which is all the assertions below need. */
  text() {
    return this.cells
      .map((row) => row.join('').replace(/[^\x20-\x7e]/g, '.').replace(/\s+$/, ''))
      .join('\n');
  }
}

const PROSE = 'I read the config and it is straightforward.';
const PLAN_BODY = '## Step one\n- `src/a.js`: change the thing.\n'
  + '## Step two\n- `src/b.js`: change the other thing.\n'
  + '## Verify\n- run the tests.';
const REPLY = `${PROSE}\n\n<|plan|>\n${PLAN_BODY}\n</|plan|>`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-check-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-check-ws-'));
fs.mkdirSync(path.join(home, '.hncode'), { recursive: true });
fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), '');
process.env.HNCODE_HOME = home;
process.env.HNCODE_NO_MOUSE_HOVER = '1';
process.env.HNCODE_NO_KITTY_KEYS = '1';

const screen = new Screen();
process.stdout.write = (s) => { screen.write(String(s)); return true; };
process.stdout.getWindowSize = () => [COLS, ROWS];
process.stdout.columns = COLS;
process.stdout.rows = ROWS;
// The composer/keys only work on a TTY; the READABLE side is a real pipe here, which is
// enough — keys are pushed into it below.
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

// ---- the provider ---------------------------------------------------------------
// One coalesced burst, the shape Anthropic-style providers deliver: the whole reply in a
// single delta. That is what makes the buffer hold text at the moment the UI reads the
// transcript, and it is where the head of the reply used to disappear.
const handler = async (url, init) => {
  if (!String(url).includes('127.0.0.1:9')) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (!init || !init.body) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const body = JSON.parse(init.body);
  if (!body.stream) {
    // The one-shot session-title request.
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Read the config' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY } }] })}\n\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const realFetch = globalThis.fetch;
globalThis.fetch = handler;

const cfg = {
  model: 'p/m', innerModel: 'm', provider: 'p', providerName: 'p',
  baseUrl: 'http://127.0.0.1:9', endpoint: 'http://127.0.0.1:9/v1/chat/completions',
  protocol: 'openai', apiKey: 'k', stream: true,
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false,
  workspace, autoUpdate: false, raw: { providers: {}, models: { 'p/m': {} } },
};
const session = {
  id: 'check', title: 'check', workspace, model: 'p/m', createdAt: Date.now(),
  messages: [], plan: true, mode: 'ask', shellHistory: [], todos: [],
};

// ---- drive it --------------------------------------------------------------------
let failures = 0;
const ok = (name, cond, extra = '') => {
  say(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startTUI } = await import('../src/tui.js');
startTUI({ cfg, session, opts: {} }).catch(() => { /* the harness reports on the screen */ });

// Wait for the first paint before typing: the key handlers live inside startTUI, and a
// keystroke that arrives before them is simply lost. The status bar is the signal — with
// plan mode on it reads "Ask Plan", and it carries no box-drawing glyphs.
const readyBy = Date.now() + 10000;
while (Date.now() < readyBy) {
  if (screen.text().includes('Ask Plan')) break;
  await sleep(50);
}
process.stdin.emit('data', 'make a plan\r');

// Wait for Plan mode's review prompt: it is only drawn once the reply is over AND the
// plan has been read out of the transcript. When no plan was recognised the turn just
// ends, so a settled `[turn took …]` row means there is nothing left to wait for.
let shown = '';
let settled = false;
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  await sleep(50);
  shown = screen.text();
  if (shown.includes('Review this plan')) break;
  if (shown.includes('[turn took')) {
    if (settled) break;
    settled = true;
  }
}

say(process.env.HNCODE_CHECK_DUMP ? shown : '');
ok('the plan review prompt appears', shown.includes('Review this plan'),
  shown.includes('Review this plan') ? '' : '(the plan was never read — set HNCODE_CHECK_DUMP=1 for the screen)');
// The head of the reply: it is the first thing a dropped push return value takes out,
// and losing it takes the `<|plan|>` tag with it (so the whole plan splits into prose).
ok('the prose before the plan block is on screen', shown.includes(PROSE));
for (const line of PLAN_BODY.split('\n')) {
  if (!line.trim()) continue;
  // Markdown markers do not survive rendering: the heading marks, the backticks around
  // a path and the bullet glyph are all gone by the time the row is painted.
  const wanted = line.replace(/^#+\s*/, '').replace(/^-\s*/, '').replace(/`/g, '');
  ok(`plan line painted whole: ${wanted}`, shown.includes(wanted));
}
// The tags are delimiters, not content: they must never be rendered.
ok('the plan tags are not painted', !shown.includes('<|plan|>') && !shown.includes('</|plan|>'));
// The review summary is computed from the plan text, so it only names the files when the
// finalize read a COMPLETE plan.
ok('the review summary saw the whole plan', shown.includes('Files mentioned: 2') && shown.includes('src/a.js'));

globalThis.fetch = realFetch;
// Best-effort: Windows can still be holding a handle on the workspace (a git spawn from
// the badge refresh), and a cleanup failure must not turn a passing check into a crash.
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp dir */ }
try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* temp dir */ }
say(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
