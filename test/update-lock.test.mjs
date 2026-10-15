// The install lock: the same update must never run twice.
//
// WHY
// ---
// Three things can start an install — the startup check, the 30-minute interval and
// `/update` — and the in-process guard spans only the VERSION QUERY, because
// `checkAndUpdate` returns as soon as npm is spawned. `/update` did not consult that guard at
// all, and a second hncode session shares nothing with the first except the filesystem.
// `npm install -g` does not lock the global prefix, so two racing installs write into the
// same tree.
//
// The lock is created with `O_EXCL`, which is atomic across PROCESSES. An `existsSync` check
// followed by a write is not: two sessions can both pass the check before either writes, and
// these tests exist to keep that distinction from being lost.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const {
  claimInstallLock, releaseInstallLock, installLockHolder, updateLockFile,
} = await import('../src/update.js');

/** Run `fn` with HNCODE_HOME pointed at a throwaway directory. */
function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-lock-'));
  const prev = process.env.HNCODE_HOME;
  process.env.HNCODE_HOME = home;
  try { return fn(home); } finally {
    if (prev === undefined) delete process.env.HNCODE_HOME;
    else process.env.HNCODE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('the first claimant wins and the second is refused', () => {
  withTempHome(() => {
    const a = claimInstallLock('0.6.0');
    assert.equal(a.ok, true, 'the first claim must succeed');

    const b = claimInstallLock('0.6.0');
    assert.equal(b.ok, false, 'the second must be refused');
    assert.ok(b.heldBy, 'and must name the holder so the caller can say who is installing');
    assert.equal(b.heldBy.pid, process.pid);
    assert.equal(b.heldBy.version, '0.6.0');
  });
});

test('releasing lets the next claim through', () => {
  withTempHome(() => {
    assert.equal(claimInstallLock('0.6.0').ok, true);
    assert.equal(releaseInstallLock(), true);
    assert.equal(installLockHolder(), null);
    assert.equal(claimInstallLock('0.6.0').ok, true);
  });
});

test('a stale lock is broken rather than blocking updates forever', () => {
  // A crashed process must not disable updates permanently — that is a worse failure than
  // the rare double install the lock exists to prevent.
  withTempHome((home) => {
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(home, 'update.lock'), JSON.stringify({ pid: 999999, version: '0.5.0', at: staleAt }));
    assert.equal(claimInstallLock('0.6.0').ok, true, 'a 20-minute-old lock (threshold 15) is abandoned');
  });
});

test('an unreadable lock is treated as stale, not as a permanent block', () => {
  withTempHome((home) => {
    fs.writeFileSync(path.join(home, 'update.lock'), '{ not json');
    assert.equal(claimInstallLock('0.6.0').ok, true);
  });
});

test('a FRESH lock is respected', () => {
  // The other half of the staleness rule: a lock that is genuinely held must not be broken,
  // or the guard does nothing when it matters.
  withTempHome((home) => {
    fs.writeFileSync(path.join(home, 'update.lock'), JSON.stringify({ pid: 1, version: '0.6.0', at: new Date().toISOString() }));
    assert.equal(claimInstallLock('0.6.0').ok, false);
  });
});

test('the lock is under the config home, so a sandbox can redirect it', () => {
  withTempHome(() => {
    assert.match(updateLockFile(), /update\.lock$/);
    assert.ok(updateLockFile().startsWith(process.env.HNCODE_HOME));
  });
});

test('O_EXCL is atomic: processes that collide produce exactly one winner', async () => {
  // The whole point. An `existsSync` + `writeFileSync` lets SEVERAL processes win, which is what
  // makes this worth running in separate processes rather than in-process.
  //
  // The rendezvous is a WALL-CLOCK instant, and that is the fragile part: on a loaded machine
  // (a full `node --test` run) eight cold Node starts spread out enough that the last worker
  // arrives after the winner has already exited. It then finds no lock and wins too — correctly,
  // since the lock is free — and the test reported "3 claimed the lock" for a lock that never
  // misbehaved. So each worker now reports WHEN it claimed, and the assertion is applied to the
  // workers that really arrived together. The count of winners is exactly one among those; a late
  // worker is not evidence of anything.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-race-'));
  const updUrl = new URL('../src/update.js', import.meta.url).href;
  const worker = path.join(home, 'worker.mjs');
  fs.writeFileSync(worker, [
    `process.env.HNCODE_HOME = ${JSON.stringify(home)};`,
    `const upd = await import(${JSON.stringify(updUrl)});`,
    // Every worker waits for the same wall-clock instant, so the ones that get there in time
    // collide on the create.
    'const at = Number(process.argv[2]);',
    'const wait = at - Date.now();',
    'if (wait > 0) await new Promise((r) => setTimeout(r, wait));',
    'const claim = upd.claimInstallLock("0.6.0");',
    // `late` is how far past the rendezvous this worker actually got, in ms. Measured BEFORE the
    // claim so it describes when the process was ready, not how long the claim took.
    'process.stdout.write(JSON.stringify({ ok: claim.ok, late: Date.now() - at }));',
  ].join('\n'));

  const N = 8;
  const at = Date.now() + 700;
  const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, String(at)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  })));

  fs.rmSync(home, { recursive: true, force: true });

  const bad = results.filter((r) => r === '');
  assert.equal(bad.length, 0, `a worker produced no output: ${JSON.stringify(results)}`);

  const claims = results.map((r) => JSON.parse(r));
  // Everyone who was ready within a short window of the rendezvous. The window is generous
  // because a loaded machine is exactly the case this must survive.
  const WINDOW_MS = 250;
  const together = claims.filter((c) => c.late <= WINDOW_MS);
  assert.ok(together.length >= 2,
    `the race needs at least two workers arriving together; got ${together.length} of ${N}`);

  const winners = together.filter((c) => c.ok).length;
  assert.equal(winners, 1,
    `${together.length} processes raced within ${WINDOW_MS}ms and ${winners} claimed the lock`);

  // And whoever won must have won by creating the file, so nobody lost to a stale lock.
  const late = claims.filter((c) => c.late > WINDOW_MS);
  if (late.length) {
    assert.equal(late.filter((c) => c.ok).length, 0,
      'a worker that arrived late still won, which means the lock was not held when it checked');
  }
});