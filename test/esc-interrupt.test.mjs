// Esc during a turn must interrupt it.
//
// WHY THIS FILE EXISTS
// --------------------
// The help text has always said so — `Press Esc to interrupt the current turn`, and a shortcut list
// reading `Esc … interrupt the turn` — but only Ctrl+C was wired to `agent.interrupt()`. Pressing Esc
// while a tool ran did nothing at all, which is precisely when it is wanted: a Bash command taking
// longer than expected, a screen walk over a large tree.
//
// The chain has four links and only the first was missing:
//   Esc -> agent.interrupt() -> toolAbort.abort() -> the tool's abort listener -> kill the child
//
// So these tests cover the whole chain, not just the key binding — a key bound to a method that
// aborts a signal no tool listens to would look correct and stop nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const { Agent } = await import('../src/agent.js');

/** An agent instance with only what `interrupt()` touches. */
function bareAgent() {
  const a = Object.create(Agent.prototype);
  a.stopRequested = false;
  a.toolAbort = new AbortController();
  a.steerQueue = [];
  a.llm = null;
  a._summaryLlm = null;
  return a;
}

test('interrupt() aborts the tool signal', () => {
  const a = bareAgent();
  assert.equal(a.toolAbort.signal.aborted, false, 'not aborted to begin with');
  a.interrupt();
  assert.equal(a.toolAbort.signal.aborted, true, 'and aborted after');
  assert.equal(a.stopRequested, true, 'the loop is told to stop too');
});

test('interrupt() survives a missing llm', () => {
  // It is called from a key handler, where a throw would take down the TUI. An agent built before
  // its first request has no `llm` yet.
  const a = bareAgent();
  a.llm = null;
  assert.doesNotThrow(() => a.interrupt());
});

test('the Bash tool stops its child when that signal fires', async () => {
  // The link that makes Esc useful rather than merely wired: a long command must die.
  const { spec } = await import('../src/tools/bash.js');
  const ctrl = new AbortController();
  const ctx = { workspace: process.cwd(), signal: ctrl.signal, onOutput: () => {}, _foreground: null };

  const started = Date.now();
  // The command is 120 seconds and the abort fires at 500ms. The gap is the point: "the call
  // returned" can then only mean the child was killed, because waiting it out is impossible inside
  // any sane test timeout. An earlier version used 15 seconds with a 10-second bound, which failed
  // under a loaded `node --test` run — reporting machine load as a defect.
  const running = spec.execute({ command: 'node -e "setTimeout(()=>{},120000)"', timeout: 300 }, ctx);
  setTimeout(() => ctrl.abort(), 500);
  const out = String(await running);
  const elapsed = Date.now() - started;

  assert.match(out, /Interrupted by user/, `the tool reports the interrupt: ${out.slice(0, 120)}`);
  // Generous on purpose: the claim is "killed rather than awaited", and 90s is far below the 120s
  // the command would have taken while being far above any scheduling delay.
  assert.ok(elapsed < 90000, `killed rather than awaited (${elapsed}ms of 120000ms)`);
});

test('an already-aborted signal is refused without spawning', async () => {
  const { spec } = await import('../src/tools/bash.js');
  const ctrl = new AbortController();
  ctrl.abort();
  const ctx = { workspace: process.cwd(), signal: ctrl.signal, onOutput: () => {}, _foreground: null };
  const out = String(await spec.execute({ command: 'echo should-not-run' }, ctx));
  assert.match(out, /Interrupted by user/);
});

test('the Esc key reaches interrupt while a turn runs', () => {
  // The link that WAS missing. Asserted at the source because the handler lives inside startTUI's
  // closure and cannot be called directly; the property is that a running turn plus Esc calls
  // interrupt.
  const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
  const at = src.indexOf("t.key === 'escape' && state.running");
  assert.ok(at > 0, 'Esc is bound to the running state');
  const block = src.slice(at, src.indexOf('\n    }', at));
  assert.match(block, /state\.agent\.interrupt\(\)/, 'and it interrupts the turn');
  // It must NOT arm the exit prompt: a key meaning "stop this" must not also be able to quit.
  assert.doesNotMatch(block, /confirmExit/, 'Esc never arms the exit prompt');
  // And it must exclude open overlays, so Esc keeps its other job of closing one.
  for (const overlay of ['state.picker', 'state.form', 'state.panel', 'state.editor', 'state.question']) {
    assert.ok(block.includes(overlay), `Esc-leaves-the-overlay-alone check covers ${overlay}`);
  }
});
