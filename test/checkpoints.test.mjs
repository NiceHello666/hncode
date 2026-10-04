// Per-file checkpoints and the surgical restore.
//
// WHY THESE ASSERTIONS
// --------------------
// A restore is a WRITE to a file the user cares about, driven by minutes-old state. The two
// ways it goes wrong are both destructive and both silent:
//
//   * restoring the WRONG version — the index records one entry per file per turn, and the
//     version to restore is the OLDEST one among the turns being rewound, not the newest;
//   * touching a file it should not — a file that did not exist at that checkpoint must be
//     deleted, and every other file must be left exactly as it is.
//
// So the tests drive a real temp directory through the real module, and assert on file
// CONTENT afterwards. `rewind` already had this shape; `listCheckpoints` /
// `restoreCheckpoint` are the per-file counterparts and are tested the same way.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home per test, so nothing here can see or touch the real ~/.hncode.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-cp-'));
process.env.HNCODE_HOME = HOME;

const {
  beginTurn, recordBeforeWrite, rewind, listCheckpoints, restoreCheckpoint,
  checkpointDelta, describeCheckpoints, turnCount,
} = await import('../src/file-history.js');

const work = () => {
  const parent = path.join(HOME, 'work');
  fs.mkdirSync(parent, { recursive: true });   // mkdtemp needs an existing parent
  return fs.mkdtempSync(path.join(parent, 'w-'));
};
let sid = 0;
const newSession = () => `sess-${++sid}`;

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8'); };

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

test('a checkpoint captures the content BEFORE the write', () => {
  const s = newSession();
  const dir = work();
  const file = path.join(dir, 'a.txt');
  write(file, 'v1');
  beginTurn(s);
  recordBeforeWrite(s, file);
  write(file, 'v2');                       // the agent's edit

  const cps = listCheckpoints(s, { path: file });
  assert.equal(cps.length, 1);
  assert.equal(cps[0].existed, true);
  assert.equal(read(cps[0].backup), 'v1', 'the backup holds the pre-turn content');
});

test('a file created by the agent records that it did NOT exist', () => {
  const s = newSession();
  const dir = work();
  const file = path.join(dir, 'new.txt');
  beginTurn(s);
  recordBeforeWrite(s, file);              // nothing there yet
  write(file, 'created by the agent');

  const cps = listCheckpoints(s, { path: file });
  assert.equal(cps.length, 1);
  assert.equal(cps[0].existed, false, 'so a restore knows to delete it');
  assert.equal(cps[0].backup, '', 'and there is nothing to copy back');
});

test('only the FIRST write to a file in a turn is recorded', () => {
  // The recorded version must be the pre-TURN state. Recording again on the second write
  // would capture the state after the first edit, i.e. a halfway point.
  const s = newSession();
  const dir = work();
  const file = path.join(dir, 'a.txt');
  write(file, 'v1');
  beginTurn(s);
  recordBeforeWrite(s, file);
  write(file, 'v2');
  recordBeforeWrite(s, file);
  write(file, 'v3');

  const cps = listCheckpoints(s, { path: file });
  assert.equal(cps.length, 1, 'one entry per file per turn');
  assert.equal(read(cps[0].backup), 'v1', 'the pre-turn version, not the halfway one');
});

test('a turn is recorded even when nothing changed, so the count lines up with /undo', () => {
  const s = newSession();
  beginTurn(s);
  beginTurn(s);
  beginTurn(s);
  assert.equal(turnCount(s), 3);
});

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

test('checkpoints are listed newest-turn first, with stable 1-based indices', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  write(a, 'a1'); write(b, 'b1');
  beginTurn(s);
  recordBeforeWrite(s, a);
  write(a, 'a2');
  beginTurn(s);
  recordBeforeWrite(s, b);
  write(b, 'b2');

  const all = listCheckpoints(s);
  assert.equal(all.length, 2);
  assert.equal(all[0].turn, 2, 'the newer turn comes first');
  assert.equal(all[0].path, b);
  assert.equal(all[1].turn, 1);
  assert.deepEqual(all.map((c) => c.index), [1, 2], 'indices are 1-based and ordered');
});

test('the list can be narrowed to one file', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  write(a, 'a1');
  beginTurn(s);
  recordBeforeWrite(s, a);
  beginTurn(s);
  write(b, 'b1');
  recordBeforeWrite(s, b);

  assert.equal(listCheckpoints(s).length, 2);
  assert.equal(listCheckpoints(s, { path: a }).length, 1);
  assert.equal(listCheckpoints(s, { path: b }).length, 1);
});

test('a session with no checkpoints lists nothing and says so', () => {
  const s = newSession();
  assert.deepEqual(listCheckpoints(s), []);
  const text = describeCheckpoints(s, '').join('\n');
  assert.match(text, /No checkpoints recorded/);
});

test('the panel groups rows by turn and shows the index', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  write(a, 'a1');
  beginTurn(s);
  recordBeforeWrite(s, a);
  const text = describeCheckpoints(s, dir).join('\n');
  assert.match(text, /turn 1/);
  assert.match(text, /a\.txt/, 'the path is shown relative to the workspace');
  assert.match(text, /1\s/, 'the index is printed');
});

// ---------------------------------------------------------------------------
// the surgical restore
// ---------------------------------------------------------------------------

test('restoring one file brings back its content and leaves the others alone', () => {
  // The point of the feature: /undo would have rolled BOTH files back.
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  write(a, 'a1'); write(b, 'b1');
  beginTurn(s);
  recordBeforeWrite(s, a); recordBeforeWrite(s, b);
  write(a, 'a2'); write(b, 'b2');

  const target = listCheckpoints(s, { path: a })[0];
  const r = restoreCheckpoint(s, target);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'restored');
  assert.equal(read(a), 'a1', 'a was rolled back');
  assert.equal(read(b), 'b2', 'b was NOT touched');
});

test('restoring a file the agent CREATED deletes it', () => {
  const s = newSession();
  const dir = work();
  const file = path.join(dir, 'brand-new.txt');
  beginTurn(s);
  recordBeforeWrite(s, file);
  write(file, 'the agent made this');
  assert.ok(fs.existsSync(file));

  const r = restoreCheckpoint(s, listCheckpoints(s, { path: file })[0]);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'deleted');
  assert.ok(!fs.existsSync(file), 'the file is gone, as it was before the turn');
});

test('a restore does NOT truncate the index, so other checkpoints stay valid', () => {
  // Distinct from /undo, which consumes the turns it rewinds. A surgical restore must be
  // repeatable, and must not silently invalidate the list the user is reading.
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  write(a, 'a1');
  beginTurn(s);
  recordBeforeWrite(s, a);
  write(a, 'a2');

  const before = listCheckpoints(s);
  restoreCheckpoint(s, before[0]);
  assert.equal(listCheckpoints(s).length, before.length, 'the index is unchanged');
  // And restoring again is still possible.
  assert.equal(restoreCheckpoint(s, before[0]).ok, true);
});

test('restoring a checkpoint with a missing backup fails cleanly instead of blanking the file', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  write(a, 'precious');
  beginTurn(s);
  recordBeforeWrite(s, a);
  write(a, 'edited');
  // Simulate the backup being cleaned up or lost.
  const entry = listCheckpoints(s, { path: a })[0];
  fs.rmSync(entry.backup, { force: true });

  const r = restoreCheckpoint(s, entry);
  assert.equal(r.ok, false, 'the failure is reported');
  assert.equal(read(a), 'edited', 'and the current file was NOT overwritten with nothing');
});

test('restoring a checkpoint with no path reports rather than throwing', () => {
  assert.equal(restoreCheckpoint('s', null).ok, false);
  assert.equal(restoreCheckpoint('s', {}).ok, false);
});

test('a restore recreates a directory that has since been removed', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'sub', 'deep', 'a.txt');
  write(a, 'v1');
  beginTurn(s);
  recordBeforeWrite(s, a);
  write(a, 'v2');
  fs.rmSync(path.join(dir, 'sub'), { recursive: true, force: true });

  const r = restoreCheckpoint(s, listCheckpoints(s, { path: a })[0]);
  assert.equal(r.ok, true);
  assert.equal(read(a), 'v1', 'the path was rebuilt');
});

// ---------------------------------------------------------------------------
// the comparison helper
// ---------------------------------------------------------------------------

test('the delta reports the line change between the checkpoint and now', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  write(a, 'one\ntwo\n');
  beginTurn(s);
  recordBeforeWrite(s, a);
  write(a, 'one\ntwo\nthree\nfour\n');

  const d = checkpointDelta(listCheckpoints(s, { path: a })[0]);
  assert.deepEqual(d, { before: 3, after: 5, lines: 2 });
});

test('the delta is null when there is nothing to compare', () => {
  assert.equal(checkpointDelta(null), null);
  assert.equal(checkpointDelta({}), null);
  assert.equal(checkpointDelta({ existed: false }), null);
});

// ---------------------------------------------------------------------------
// the existing turn rewind still works
// ---------------------------------------------------------------------------

test('rewind restores every file the rewound turns touched', () => {
  const s = newSession();
  const dir = work();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  write(a, 'a1'); write(b, 'b1');
  beginTurn(s);
  recordBeforeWrite(s, a); recordBeforeWrite(s, b);
  write(a, 'a2'); write(b, 'b2');

  const res = rewind(s, 1);
  assert.equal(res.turns, 1);
  assert.equal(read(a), 'a1');
  assert.equal(read(b), 'b1');
  assert.equal(turnCount(s), 0, 'the turn was consumed');
});

test.after(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  delete process.env.HNCODE_HOME;
});
