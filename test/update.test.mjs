// Auto-update: version comparison, and whether an install's outcome is actually knowable.
//
// WHY THESE ASSERTIONS
// --------------------
// `updateBackground` used to resolve `{ ok: true }` the instant `spawn` returned, with
// `stdio: 'ignore'`. So a detached npm that could not write the global prefix, or could not
// reach the registry, said so to nobody — and `/update` told the user the update was
// installing. Verified at the time by installing a package that does not exist: it still
// reported success.
//
// The tests below are about that: a comparison that must not silently answer "up to date",
// and an outcome that must travel somewhere readable.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  isNewer, updateStampFile, readUpdateStamp, clearUpdateStamp, localVersion,
} = await import('../src/update.js');

// ---------------------------------------------------------------------------
// version comparison
// ---------------------------------------------------------------------------

test('a leading v does not hide an update', () => {
  // `parseSemver` ran the regex against the raw string, so `v0.6.0` did not parse and
  // `isNewer` answered false — an update that would never be detected if a registry ever
  // echoed the tag with its `v`.
  assert.equal(isNewer('v0.6.0', '0.5.1'), true);
  assert.equal(isNewer('V0.6.0', '0.5.1'), true);
  assert.equal(isNewer(' 0.6.0 ', '0.5.1'), true);
  assert.equal(isNewer('0.6.0', '0.5.1'), true);
});

test('a numeric comparison, not a string one', () => {
  // String order puts '0.10.0' before '0.9.9', which would have made every 0.10+ release
  // invisible to anyone on 0.9.x.
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.9.9', '0.10.0'), false);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
});

test('a prerelease ranks below its own release', () => {
  // Dropping the suffix made `0.5.1-beta` and `0.5.1` identical, so the direction came out
  // of the fallthrough rather than out of the versions.
  assert.equal(isNewer('0.5.1', '0.5.1-beta'), true, 'the release is newer than its beta');
  assert.equal(isNewer('0.5.1-beta', '0.5.1'), false, 'the beta is not newer than the release');
  assert.equal(isNewer('0.5.1-beta', '0.5.1-beta'), false, 'identical');
  assert.equal(isNewer('0.6.0-beta.1', '0.5.1'), true, 'a newer version is still newer');
});

test('same version is never an update, either way round', () => {
  for (const v of ['0.5.1', 'v0.5.1', ' 0.5.1 ']) {
    assert.equal(isNewer(v, '0.5.1'), false, v);
    assert.equal(isNewer('0.5.1', v), false, v);
  }
});

test('an unreadable version is never an update', () => {
  // The registry being unreachable must not look like "up to date" AND must not look like an
  // update — it is a third state, and `checkAndUpdate` reports it as `none`.
  assert.equal(isNewer('', '0.5.1'), false);
  assert.equal(isNewer('nonsense', '0.5.1'), false);
  assert.equal(isNewer('0.5.1', ''), false);
  assert.equal(isNewer('0.5.1', 'nonsense'), false);
});

test('localVersion reads the real package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(localVersion(), pkg.version);
});

// ---------------------------------------------------------------------------
// install outcome
// ---------------------------------------------------------------------------

test('the stamp file lives under the config home', () => {
  // Not asserted against the real HOME: the point is that it follows HNCODE_HOME, so a test
  // (or a sandboxed install) can redirect it.
  const p = updateStampFile();
  assert.match(p, /update\.json$/);
  assert.ok(p.includes(process.env.HNCODE_HOME || path.join(os.homedir(), '.hncode')));
});

test('the stamp survives a round trip, and clears', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-upd-'));
  const prev = process.env.HNCODE_HOME;
  process.env.HNCODE_HOME = home;
  try {
    assert.equal(readUpdateStamp(), null, 'nothing recorded yet');

    fs.writeFileSync(updateStampFile(), JSON.stringify({ status: 'error', version: '0.6.0', error: 'EACCES' }));
    const s = readUpdateStamp();
    assert.equal(s.status, 'error');
    assert.equal(s.version, '0.6.0');
    assert.equal(s.error, 'EACCES');

    assert.equal(clearUpdateStamp(), true);
    assert.equal(readUpdateStamp(), null);
  } finally {
    if (prev === undefined) delete process.env.HNCODE_HOME;
    else process.env.HNCODE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt stamp reads as null rather than throwing', () => {
  // It is read during startup; a half-written file must not take the TUI down.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-upd-'));
  const prev = process.env.HNCODE_HOME;
  process.env.HNCODE_HOME = home;
  try {
    fs.writeFileSync(updateStampFile(), '{ not json');
    assert.equal(readUpdateStamp(), null);
    assert.equal(clearUpdateStamp(), true, 'and it can still be cleared');
  } finally {
    if (prev === undefined) delete process.env.HNCODE_HOME;
    else process.env.HNCODE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
