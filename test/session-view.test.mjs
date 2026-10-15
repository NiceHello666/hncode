// The view seam: what runAgent is allowed to assume about its display.
//
// WHY
// ---
// runAgent is 1020 lines and used to reach for `state`, `renderFrame()` and `addChat()` directly —
// which is what tied a session to the process that drew it, and why a session whose terminal had
// closed could never be continued from the web UI.
//
// The audit that justified the extraction: of those 1020 lines, 45 display calls and 6 pushes to
// the web hub were the entire contact surface. Everything else is session state the session
// carries anyway. These assertions pin the contract that replaced it, so a later change cannot
// quietly reintroduce a direct `renderFrame()` and re-break the headless case.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const { HEADLESS_VIEW, tuiView } = await import('../src/session-view.js');

const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
const lines = src.split(/\r?\n/);

// runAgent's body, located by its declaration rather than by a line number that drifts.
// The body is everything until the next top-level function, found by scanning — a hardcoded
// end marker is a line number in disguise, and this file has already outlived several.
// The body moved to module level as `runTurn`; runAgent is a forwarder now.
const start = lines.findIndex((l) => l.startsWith('async function runTurn('));
assert.ok(start > 0, 'runAgent was located');
let end = start + 1;
while (end < lines.length && !/^(async )?function \w+|^\/\/ ---- TUI entry point/.test(lines[end])) end++;
assert.ok(end > start, 'the end of runAgent was located');
const body = lines.slice(start, end).join('\n');

test('runAgent draws only through the view', () => {
  // Comments name the old functions on purpose (they explain what each block does), so the
  // assertion is about CODE.
  const code = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const leaks = [
    [/(?<![\w.])renderFrame\(\)/, 'renderFrame'],
    [/(?<![\w.])renderSoon\(\)/, 'renderSoon'],
    [/(?<![\w.])addChat\(/, 'addChat'],
    [/(?<![\w.])appErr\(/, 'appErr'],
    [/(?<![\w.])app\(/, 'app'],
  ];
  for (const [re, name] of leaks) {
    assert.doesNotMatch(code, re, `${name} must go through the view`);
  }
});

test('a headless view can answer every method runAgent calls', () => {
  // The contract is only real if a no-op implementation satisfies it. A method the TUI has and
  // the headless one lacks would be a TypeError in the daemon, at the first turn.
  const called = new Set();
  for (const m of body.matchAll(/(?<![\w.$])(?:viewCur|v)\.([a-zA-Z]\w*)\(/g)) called.add(m[1]);
  assert.ok(called.size >= 4, `expected several view calls, found ${[...called].join(', ')}`);

  for (const m of called) {
    assert.equal(typeof HEADLESS_VIEW[m], 'function', `HEADLESS_VIEW.${m} is missing`);
  }
});

test('every view method the adapter exposes is callable without a terminal', () => {
  // `tuiView` binds a real TUI. The methods it hands back must not throw when the thing they wrap
  // is absent — a headless run has no `openPicker`, and a push to a hub that never started must
  // be a no-op rather than an exception.
  const v = tuiView({});
  for (const name of Object.keys(HEADLESS_VIEW)) {
    assert.equal(typeof v[name], 'function', `tuiView does not provide ${name}`);
    assert.doesNotThrow(() => {
      const r = v[name]();
      // The dialog methods return a promise or null; neither is awaited here on purpose.
      void r;
    }, `tuiView().${name} threw with no dependencies`);
  }
});

test('a note and an error are distinguishable', () => {
  // `appErr` in the TUI is `notice(m, 'error')`. Folding it into `note` would have shown every
  // failure — a denied tool, a teammate that never started — as an ordinary message.
  const seen = [];
  const v = tuiView({ notice: (text, kind) => seen.push([text, kind]) });
  v.note('something happened');
  v.err('something broke');
  assert.deepEqual(seen, [
    ['something happened', 'info'],
    ['something broke', 'error'],
  ]);
});

test('the hub is read late, not captured', () => {
  // `startWeb` assigns `hub` long after the adapter is built. A captured copy would be the null
  // that existed at construction, so every push would silently no-op — the web UI would look
  // connected and never update.
  let hub = null;
  const v = tuiView({ get hub() { return hub; } });
  assert.doesNotThrow(() => v.pubStatusField('queued', []), 'a null hub is a no-op, not a throw');

  const pushed = [];
  hub = { pubStatusField: (f, val) => pushed.push([f, val]) };
  v.pubStatusField('queued', ['a']);
  assert.deepEqual(pushed, [['queued', ['a']]], 'and the live hub receives it once assigned');
});
