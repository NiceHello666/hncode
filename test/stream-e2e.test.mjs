// The streamed reply must reach the SCREEN whole.
//
// `src/stream-buffer.js` has thorough unit tests and every one of them passed while the
// TUI was dropping the head of every streamed delta: the buffer was right, the wiring
// was not. `pushText` / `pushReasoning` return the characters the pacing controller says
// are due at that instant and take them off the queue as they hand them over, so a caller
// that ignores the return value loses them — measurably the first 32 characters of a
// coalesced reply, prose and `<|plan|>` tag included, which left Plan mode with no plan.
//
// Only a run of the real TUI can catch that, so the check lives in
// tools/check_stream_paint.mjs (fake TTY, fake provider, painted screen read back) and is
// driven from here. It is run as a CHILD PROCESS on purpose: it takes over process.stdout
// / process.stdin / fetch and starts the TUI's timers, none of which belong in the test
// runner's own process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CHECK = path.join(import.meta.dirname, '..', 'tools', 'check_stream_paint.mjs');

test('a coalesced streamed reply is painted whole, plan block included', () => {
  const run = spawnSync(process.execPath, [CHECK], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0,
    'streamed text was lost between the buffer and the transcript:\n'
    + `${run.stdout || ''}${run.stderr || ''}`);
  assert.match(run.stdout, /all checks passed/);
});
