// When the status bar's git diff is refreshed.
//
// WHY THIS FILE EXISTS
// --------------------
// The count used to update on a 15s timer that deliberately STOOD DOWN during a turn, plus once at
// turn end. The reasoning was sound as far as it went — mid-turn the agent is about to write more
// files, so a poll returns a value that is stale on arrival — but the consequence was that a long
// turn showed an unchanging `+0 -0` while dozens of files were edited, and the real figures appeared
// only after everything had finished.
//
// The missing distinction is between a POLL and a STEP BOUNDARY. At a step boundary the agent has
// stopped writing and is about to think, so the count is both current and worth looking at. That is
// where the refresh now happens, and it is the only mid-turn one.
//
// The properties below are about WHERE the call is made and whether it survives the guard, because
// the git numbers themselves would be correct either way — it is their freshness on screen that is
// under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('src/tui.js');
const src = fs.readFileSync(SRC, 'utf8');

/** The body of the `tool_result` branch of the agent-event handler. */
function toolResultHandler() {
  const start = src.indexOf("} else if (e.type === 'tool_result') {");
  assert.ok(start > 0, 'the tool_result handler is present');
  const end = src.indexOf("} else if (e.type === 'error')", start);
  assert.ok(end > start, 'the handler ends where the next branch begins');
  return src.slice(start, end);
}

test('a completed step refreshes the git info', () => {
  // The call is what makes the diff track the turn instead of waiting for it.
  assert.match(toolResultHandler(), /refreshGitInfo\(state, \{ force: true \}\)/,
    'the tool_result handler refreshes the git info');
});

test('the refresh is forced, so the mid-turn guard does not swallow it', () => {
  // Without `force` this call would be dropped by `if (!force && state.running) return` — the very
  // guard that exists to stop the timer, and which applies to every caller.
  assert.match(toolResultHandler(), /refreshGitInfo\(state, \{ force: true \}\)/,
    'the per-step call passes force: true');
});

test('it happens at the step boundary, alongside the transcript save', () => {
  // `persistTurnProgress` marks a completed step. Anchoring the refresh to the same place keeps the
  // two from drifting apart, and means the refresh cannot fire part-way through a tool.
  const body = toolResultHandler();
  assert.match(body, /persistTurnProgress\(messages\)/, 'the step boundary is marked');
  const saveAt = body.indexOf('persistTurnProgress(messages)');
  const refreshAt = body.indexOf('refreshGitInfo(state, { force: true })');
  assert.ok(refreshAt > saveAt, 'the refresh follows the step-boundary save');
});

test('an unforced refresh is still refused while a turn runs', () => {
  // The property the 15s timer depends on. Losing it would spawn git every 15s mid-turn for a value
  // the per-step refresh has already made current.
  assert.match(src, /if \(!force && state\.running\) return;/, 'the guard is intact');
});

test('the periodic timer still stands down during a turn', () => {
  // So the per-step refresh is the ONLY thing running git mid-turn; two sources would fight.
  const at = src.indexOf('const gitTimer = setInterval');
  assert.ok(at > 0, 'the timer is present');
  const body = src.slice(at, at + 400);
  assert.match(body, /if \(state\.running\) return;/, 'the timer skips a running turn');
});

test('nothing else was added to the mid-turn path', () => {
  // A refresh tied to the frame loop or a keystroke spawned git per keystroke once before; this
  // pins the number of forced call sites so a new one is a deliberate change rather than a drift.
  const forced = [...src.matchAll(/refreshGitInfo\(state, \{ force: true \}\)/g)].length;
  assert.equal(forced, 10, `expected 10 forced call sites, found ${forced}`);
});
