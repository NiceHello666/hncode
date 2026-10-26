// Esc must end the WAIT for a tool, not merely ask it to stop.
//
// WHY THIS FILE EXISTS
// --------------------
// Two separate faults, reported together.
//
// 1. Esc was bound ONLY inside overlays (picker/form/approval/plan review). During ordinary tool
//    execution it reached nothing: only Ctrl+C interrupted, and Ctrl+C also arms the exit prompt — so the
//    key a person presses when a command is taking too long was the one that could quit the app.
//
// 2. Even after that was fixed, a PLUGIN tool still ignored Esc. `ctx.signal` is handed to every tool but
//    nothing enforces that a tool listens; built-ins do (Bash kills its process tree), a plugin is free
//    not to. The caller's `await` then waited for it anyway, so the row said "Using …" until the plugin
//    happened to finish.
//
// The second fault cannot be fixed by asking plugins to behave, so the wait is RACED against the signal.
// The plugin keeps running — that is stated plainly in the source — but the turn is no longer held by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const tuiSrc = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
const agentSrc = fs.readFileSync(path.resolve('src/agent.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. the key reaches interrupt
// ---------------------------------------------------------------------------

test('Esc interrupts a running turn', () => {
  const at = tuiSrc.indexOf("t.key === 'escape' && state.running");
  assert.ok(at > 0, 'Esc is bound to the running state');
  const block = tuiSrc.slice(at, tuiSrc.indexOf('\n    }', at));
  assert.match(block, /state\.agent\.interrupt\(\)/, 'and it interrupts the turn');
});

test('Esc never arms the exit prompt', () => {
  // A key meaning "stop this command" must not also be able to quit the app — that is exactly what made
  // Ctrl+C a poor substitute.
  const at = tuiSrc.indexOf("t.key === 'escape' && state.running");
  const block = tuiSrc.slice(at, tuiSrc.indexOf('\n    }', at));
  assert.doesNotMatch(block, /confirmExit/);
});

test('an open overlay keeps Esc for itself', () => {
  // Closing a dialog is a different job from stopping a command, and the dialog owns the keyboard while
  // it is up.
  const at = tuiSrc.indexOf("t.key === 'escape' && state.running");
  const block = tuiSrc.slice(at, tuiSrc.indexOf('\n    }', at));
  for (const overlay of ['state.picker', 'state.form', 'state.panel', 'state.editor', 'state.question']) {
    assert.ok(block.includes(overlay), `the exclusion list covers ${overlay}`);
  }
});

// ---------------------------------------------------------------------------
// 2. the wait ends even when the tool ignores the signal
// ---------------------------------------------------------------------------

/** The real raceWithAbort, lifted out of agent.js so its behaviour can be driven. */
function loadRaceWithAbort() {
  const at = agentSrc.indexOf('function raceWithAbort');
  assert.ok(at > 0, 'raceWithAbort is defined');
  const end = agentSrc.indexOf('\n}', at) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(`${agentSrc.slice(at, end)}\nreturn raceWithAbort;`)();
}

test('aborting ends the wait at once, whatever the tool is doing', async () => {
  const race = loadRaceWithAbort();
  const ctrl = new AbortController();
  let toolStillRunning = true;
  const slowTool = new Promise((resolve) => {
    setTimeout(() => { toolStillRunning = false; resolve('finished'); }, 5000);
  });

  const started = Date.now();
  const raced = race(slowTool, ctrl.signal);
  setTimeout(() => ctrl.abort(), 20);

  await assert.rejects(raced, /aborted/);
  const took = Date.now() - started;
  assert.ok(took < 1000, `it returned in ${took}ms, not after the tool's 5s`);
  assert.equal(toolStillRunning, true, 'the tool itself kept running — that is the documented limit');
});

test('a tool that finishes first is unaffected', async () => {
  const race = loadRaceWithAbort();
  const ctrl = new AbortController();
  assert.equal(await race(Promise.resolve('value'), ctrl.signal), 'value');
});

test('a tool that rejects still rejects with its own error', async () => {
  // Racing must not swallow the real failure and report "aborted" instead.
  const race = loadRaceWithAbort();
  const ctrl = new AbortController();
  await assert.rejects(race(Promise.reject(new Error('disk full')), ctrl.signal), /disk full/);
});

test('an already-aborted signal refuses without waiting', async () => {
  const race = loadRaceWithAbort();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(race(new Promise(() => {}), ctrl.signal), /aborted/);
});

test('a tool resolving after the abort does not become an unhandled rejection', async () => {
  // The abandoned promise is left to settle detached. If nothing catches it, Node reports an unhandled
  // rejection — which this application turns into process.exit(1).
  const race = loadRaceWithAbort();
  const ctrl = new AbortController();
  let rejected = false;
  const late = new Promise((_, rej) => setTimeout(() => { rejected = true; rej(new Error('late')); }, 60));

  const raced = race(late, ctrl.signal);
  ctrl.abort();
  await assert.rejects(raced, /aborted/);
  // Give the abandoned promise time to reject; nothing should surface.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(rejected, true, 'the tool did reject late');
});

test('the tool call is actually wired through the race', () => {
  // The helper is useless if `tool.execute` is still awaited directly.
  assert.match(agentSrc, /await raceWithAbort\(tool\.execute\(_args, this\.ctx\), this\.toolAbort\.signal\)/,
    'the execution goes through the race');
});
