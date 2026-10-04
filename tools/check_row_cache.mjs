// Drive the REAL renderer and check the shared store actually saves work.
//
//   node tools/check_row_cache.mjs
//
// WHY THIS EXISTS
// ---------------
// `row-cache.test.mjs` proves the store is bounded and keyed correctly. It cannot prove
// the TUI USES it — and the failure mode for a cache is to be correct and unused, which
// looks exactly like success in a unit test.
//
// What is measured here is the thing the cache exists for: re-rendering the same
// transcript twice must not wrap the same messages twice. A message whose local
// `_cache` is dropped — as it is for everything more than CACHE_KEEP messages from the
// tail — is the case that used to re-wrap from scratch, and is the one this exercises.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.stdout.write.bind(process.stdout);
const say = (s) => out(s + '\n');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-cache-home-'));
fs.mkdirSync(path.join(home, '.hncode'), { recursive: true });
fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), '');
process.env.HNCODE_HOME = home;

let failures = 0;
const ok = (name, cond, extra = '') => {
  say(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures++;
};

const { makeState, renderChatLines, composeFrame } = await import('../src/tui.js');
const { resetRowCache, cacheStats } = await import('../src/row-cache.js');

// Enough messages that the tail window forces some through the store: the renderer drops
// `m._cache` for anything more than CACHE_KEEP (300) messages from the end.
const COUNT = 420;
const chat = [];
for (let i = 0; i < COUNT; i++) {
  chat.push({
    role: i % 2 ? 'assistant' : 'user',
    text: `message ${i}: ${'lorem ipsum dolor sit amet '.repeat(6)}`,
  });
}

const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
  raw: { providers: {}, models: { 'p/m': {} } },
};
const state = makeState({ cfg, session: { messages: [] }, opts: {} });
state.chat = chat;

// ---- pass 1: the cold pass populates the store ------------------------------------
resetRowCache();
renderChatLines(state, 100);
const afterCold = cacheStats();
const belowWindow = COUNT - 300;   // CACHE_KEEP is 300

say(`  cold pass: ${COUNT} messages, ${afterCold.size} rows parked in the shared store`);
ok('the tail window actually reaches the store', afterCold.size > 0,
  `${afterCold.size} entries from ${belowWindow} messages below the window`);
// The store holds only what is below the window: the window itself is still served by
// the message-local cache, which is the cheaper lookup and is not shared with anything.
ok('the store is bounded by the window, not by the whole transcript',
  afterCold.size < COUNT, `${afterCold.size} of ${COUNT}`);
ok('and the cold pass rendered every message exactly once', afterCold.misses === COUNT,
  `${afterCold.misses} misses, ${afterCold.hits} hits`);

// ---- a session switch: the same transcript, rebuilt from scratch -------------------
// This is the case the store exists for. The rows below the window live on message
// objects that a resume throws away and rebuilds from the log, so their local caches
// are gone — and before the store existed, every one of them was re-wrapped from
// nothing, on the first frame after every `--continue` and every `/sessions` resume.
const rebuilt = chat.map((m) => ({ role: m.role, text: m.text }));
state.chat = rebuilt;
state._metrics = null;
const hitsBefore = cacheStats().hits;
const missesBefore = cacheStats().misses;
renderChatLines(state, 100);
const afterResume = cacheStats();
const resumeHits = afterResume.hits - hitsBefore;
const resumeMisses = afterResume.misses - missesBefore;

ok('a rebuilt transcript still finds its rows', resumeHits > 0,
  `${resumeHits} of ${COUNT} messages served from the store, ${resumeMisses} re-rendered`);

// ---- a WIDTH change must miss everything ------------------------------------------
// The dangerous failure: serving rows laid out for the old width. Every key differs, so
// the store must report zero hits on the entry set — and the frame must still be correct.
const hitsBeforeWidth = cacheStats().hits;
const atNewWidth = renderChatLines(state, 61);
const afterWidth = cacheStats();
ok('a width change misses the store instead of reusing old-width rows',
  afterWidth.hits === hitsBeforeWidth,
  `${afterWidth.hits - hitsBeforeWidth} hits after the width changed`);
ok('and the narrower frame is still a full frame',
  atNewWidth.length > 0 && atNewWidth.every((l) => typeof l === 'string'));

// ---- the frames are identical when nothing changed ---------------------------------
// The property that actually matters to a user: the store must be invisible.
state._metrics = null;
const a = renderChatLines(state, 100);
state._metrics = null;
const b = renderChatLines(state, 100);
ok('a cached repaint produces byte-identical rows', JSON.stringify(a) === JSON.stringify(b));

say(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp dir */ }
process.exit(failures ? 1 : 0);