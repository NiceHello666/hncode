// The shared row cache must actually SAVE work in the real renderer.
//
//   node tools/check_row_cache.mjs
//
// `row-cache.test.mjs` proves the store is bounded and keyed correctly. It cannot prove
// the TUI USES it, and the failure mode for a cache is to be correct and unused — which
// looks exactly like success in a unit test. So this drives the real renderer over a
// transcript larger than the local-cache window and measures what actually happened.
//
// Run as a CHILD PROCESS: `renderChatLines` reads `process.env.HNCODE_HOME` for its
// config path, so it must not share a store with the test runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CHECK = path.join(import.meta.dirname, '..', 'tools', 'check_row_cache.mjs');

test('rendered rows survive the message objects being rebuilt', () => {
  const run = spawnSync(process.execPath, [CHECK], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0,
    `the shared row store is not doing its job:\n${run.stdout || ''}${run.stderr || ''}`);
  assert.match(run.stdout, /all checks passed/);
});