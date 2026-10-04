// What a session file must NOT do to itself.
//
// Three failures were found by inspecting real session files, and all three let a
// conversation be "saved" while making it unrecoverable:
//
//   1. `recordTranscriptRow` APPENDED the live reasoning block on every streamed chunk
//      instead of assigning it, and the block already held the whole chain — so the
//      stored text grew as O(n^2/chunk). A 5000-character chain arriving five characters
//      at a time became 2.5 MB. One file on the developer's machine reached 533 MB, and
//      JSON.stringify throws past ~512 MB, so every save in that session failed.
//
//   2. `serializableSession` wrote `transcript` BEFORE `messages`, and the metadata head
//      reader gives up after 4 MB without ever reaching the `"messages"` key. A session
//      whose transcript passed 4 MB therefore returned no metadata at all, and a null
//      entry is SKIPPED by the listing — three intact conversations were invisible to
//      /sessions, /all-sessions, the web rail and `--continue`.
//
//   3. Nothing recovered a file that already had the old layout, which is what those
//      three were.
//
// Each test drives the REAL write or read path. A save/load round trip alone cannot see
// failure 1 — whatever was stored does round-trip, only its size is wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTranscriptRow } from '../src/tui.js';

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-sesssize-'));
// `session.js` resolves its store through this variable at call time, so the tests never
// touch the real ~/.hncode/sessions (which is where the damaged originals live).
process.env.HNCODE_SESSIONS_DIR = store;

const {
  saveSession, loadSession, listSessions, latestSession, readSessionMeta,
  lastSaveFailure, clearSaveFailure,
} = await import('../src/session.js');
const { recoverReasoning } = await import('../tools/repair-transcripts.mjs');

const BASE = {
  workspace: '/w', model: 'p/m', createdAt: 1,
  messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
};

// ---------------------------------------------------------------------------
// 1. the reasoning row is stored once, not once per chunk
// ---------------------------------------------------------------------------

test('a reasoning block that streams in chunks is stored at its real size', () => {
  // The shape `appendThinking` produces: ONE live block, mutated in place, handed to
  // recordTranscriptRow again on every delta.
  const list = [];
  const live = { role: 'thinking', text: '', pending: true };
  for (let i = 0; i < 400; i++) {
    live.text += 'abcde';                     // a 5-character delta
    appendTranscriptRow(list, 2, { role: 'thinking', text: live.text }, true);
  }
  assert.equal(list.length, 1, 'one block was extended, not 400 rows appended');
  assert.equal(list[0].row.text, live.text, 'the stored text is exactly the chain');
  // The old code produced 400*401/2*5 = 401000 characters here, 200x the truth.
  assert.equal(list[0].row.text.length, 2000);
});

test('a streamed chain does not balloon the file it is saved into', () => {
  const list = [];
  const live = { role: 'thinking', text: '', pending: true };
  for (let i = 0; i < 2000; i++) {
    live.text += 'x'.repeat(50);             // 100k characters of reasoning
    appendTranscriptRow(list, 2, { role: 'thinking', text: live.text }, true);
  }
  const session = { ...BASE, id: 'size-1', transcript: list };
  saveSession(session);
  const size = fs.statSync(path.join(store, 'size-1.json')).size;
  // Stored once, the session is ~100 KB. Appended, it would have been ~100 MB.
  assert.ok(size < 500 * 1024, `the file stayed small (${size} bytes)`);
  assert.equal(loadSession('size-1').transcript[0].row.text.length, 100000);
});

test('a settled block is not extended by the next one', () => {
  // The extend rule is deliberately narrow: a finished block must not swallow the next
  // one, or a session would keep a single ever-growing reasoning row.
  const list = [];
  appendTranscriptRow(list, 2, { role: 'thinking', text: 'first' }, false);
  appendTranscriptRow(list, 2, { role: 'thinking', text: 'second' }, false);
  assert.deepEqual(list.map((e) => e.row.text), ['first', 'second']);
});

test('a different anchor starts a new row rather than extending', () => {
  const list = [];
  appendTranscriptRow(list, 2, { role: 'thinking', text: 'before the question' }, true);
  appendTranscriptRow(list, 4, { role: 'thinking', text: 'after it' }, true);
  assert.equal(list.length, 2);
  assert.equal(list[0].row.text, 'before the question');
});

test('non-reasoning rows are appended, never merged', () => {
  const list = [];
  appendTranscriptRow(list, 2, { role: 'system', text: '[turn took 1s]' }, false);
  appendTranscriptRow(list, 2, { role: 'system', text: '[turn took 2s]' }, false);
  assert.deepEqual(list.map((e) => e.row.text), ['[turn took 1s]', '[turn took 2s]']);
});

// ---------------------------------------------------------------------------
// 2. the key order that keeps the head reader away from the transcript
// ---------------------------------------------------------------------------

test('transcript is written AFTER messages, so the head reader never crosses it', () => {
  const session = {
    ...BASE, id: 'order-1',
    transcript: [{ anchor: 0, ts: 1, row: { role: 'thinking', text: 'x'.repeat(8 * 1024 * 1024) } }],
  };
  saveSession(session);
  const text = fs.readFileSync(path.join(store, 'order-1.json'), 'utf8');
  const atMessages = text.indexOf('"messages"');
  const atTranscript = text.indexOf('"transcript"');
  assert.ok(atMessages > 0 && atTranscript > 0, 'both keys are present');
  assert.ok(atMessages < atTranscript,
    `messages (${atMessages}) must come before transcript (${atTranscript})`);
  // And that is what keeps it listable: the 8 MB transcript is never reached.
  assert.ok(atMessages < 4 * 1024 * 1024, 'the messages key sits inside the head budget');
});

test('a session with a multi-megabyte transcript is still listed', () => {
  const session = {
    ...BASE, id: 'order-2', title: 'a long conversation',
    transcript: [{ anchor: 0, ts: 1, row: { role: 'thinking', text: 'y'.repeat(6 * 1024 * 1024) } }],
  };
  saveSession(session);
  const ids = listSessions().map((s) => s.id);
  assert.ok(ids.includes('order-2'), 'the session appears in the list');
  const meta = readSessionMeta(path.join(store, 'order-2.json'));
  assert.equal(meta.title, 'a long conversation');
  assert.equal(meta.workspace, '/w');
});

// ---------------------------------------------------------------------------
// 3. files the OLD writer left behind are readable again
// ---------------------------------------------------------------------------

/** A file in the pre-fix layout: `transcript` ahead of `messages`, and big enough that
 *  the metadata head scan hits its cap before it ever sees `"messages"`. */
function writeLegacyFile(id, transcriptBytes) {
  const doc = {
    id, title: 'written by the old code', workspace: '/w', model: 'p/m',
    createdAt: 1, updatedAt: 2, rounds: 7, steps: 9,
    todos: [{ title: 'a todo', status: 'pending' }],
    transcript: [{ anchor: 0, ts: 1, row: { role: 'thinking', text: 'z'.repeat(transcriptBytes) } }],
    messages: BASE.messages,
  };
  fs.writeFileSync(path.join(store, `${id}.json`), JSON.stringify(doc), 'utf8');
  return path.join(store, `${id}.json`);
}

test('a legacy file with an oversized transcript is listed, not hidden', () => {
  // This is the exact shape of the three real sessions that went missing: intact, and
  // unreachable because the head scan gave up before the `"messages"` key.
  writeLegacyFile('legacy-big', 5 * 1024 * 1024);
  const ids = listSessions().map((s) => s.id);
  assert.ok(ids.includes('legacy-big'), 'the legacy session is listed again');

  const meta = readSessionMeta(path.join(store, 'legacy-big.json'));
  assert.equal(meta.id, 'legacy-big');
  assert.equal(meta.title, 'written by the old code');
  assert.equal(meta.workspace, '/w');
  assert.equal(meta.updatedAt, 2, 'the timestamp is read, so the list sorts it correctly');
  assert.equal(meta.rounds, 7);
});

test('the recovered session is still fully loadable', () => {
  // The recovery must be a fixed VIEW of the file, not a shortcut that loses the
  // conversation: loading it in full is what resuming does.
  const full = loadSession('legacy-big');
  assert.ok(full, 'the file loads');
  assert.equal(full.messages.length, 2);
  assert.equal(full.transcript[0].row.text.length, 5 * 1024 * 1024);
});

test('a session with real messages is not treated as empty by --continue', () => {
  // `hasMessages` is what `--continue --skipEmpty` filters on. A recovered entry has to
  // report the truth, or resuming would step over a session full of work.
  //
  // No cwd is passed on purpose: a real file records a RESOLVED workspace, and the filter
  // compares resolved paths, so `/w` would look like a different directory.
  const picked = latestSession(undefined, undefined, { skipEmpty: true });
  assert.ok(picked, 'a session was picked');
  assert.ok((picked.messages || []).length > 0, 'the picked session has messages');
});

test('metadata is never taken from a nested key', () => {
  // A `"title"` inside a todo or a transcript row must not be mistaken for the session's
  // own. Only depth-1 keys are read, and the nested ones are skipped by value.
  const id = 'legacy-nested';
  const doc = {
    id, title: 'the real title', workspace: '/w', model: 'p/m', createdAt: 1, updatedAt: 2,
    todos: [{ title: 'a nested title', detail: { title: 'deeper still' } }],
    transcript: [{ anchor: 0, ts: 1, row: { role: 'thinking', text: 'q'.repeat(5 * 1024 * 1024) } }],
    messages: BASE.messages,
  };
  fs.writeFileSync(path.join(store, `${id}.json`), JSON.stringify(doc), 'utf8');
  const meta = readSessionMeta(path.join(store, `${id}.json`));
  assert.equal(meta.title, 'the real title', 'the nested titles were ignored');
});

test('a corrupt file is still not a session', () => {
  // The recovery must not turn rubbish into a listing entry: a file with no readable
  // root metadata at all still returns null, which the listing skips.
  fs.writeFileSync(path.join(store, 'garbage.json'), 'not json at all', 'utf8');
  assert.equal(readSessionMeta(path.join(store, 'garbage.json')), null);
  assert.ok(!listSessions().map((s) => s.id).includes('garbage'));
});

test('an ordinary small session is unaffected', () => {
  // The common case must read exactly as it did: no `transcript`, small file.
  const session = { ...BASE, id: 'plain-1', title: 'ordinary' };
  saveSession(session);
  const meta = readSessionMeta(path.join(store, 'plain-1.json'));
  assert.equal(meta.title, 'ordinary');
  assert.equal(meta.messages, undefined, 'the reader never carries messages');
});

// ---------------------------------------------------------------------------
// 4. a failed save is reported, not just logged
// ---------------------------------------------------------------------------

test('a save that cannot complete is recorded so the UI can say so', () => {
  // The whole reason the 533 MB session went unnoticed: a failed save only reached a
  // log file. The flag is what makes the TUI able to warn that the turn is on screen
  // but not on disk.
  clearSaveFailure();
  assert.equal(lastSaveFailure(), null, 'clean to start with');
  // A session with no id is refused silently by design; force a real failure instead
  // with a store path that cannot be created (a file where a directory must be).
  const blocked = path.join(store, 'not-a-dir');
  fs.writeFileSync(blocked, 'x', 'utf8');
  saveSession({ ...BASE, id: 'wont-save' }, path.join(blocked, 'sessions'));
  const f = lastSaveFailure();
  assert.ok(f, 'the failure was recorded');
  assert.equal(f.id, 'wont-save');
  assert.match(f.detail, /\S/, 'and it carries a reason');
});

test('a later successful save clears the recorded failure', () => {
  // Otherwise the warning would stay on screen for a problem the user already fixed.
  saveSession({ ...BASE, id: 'now-fine' });
  assert.equal(lastSaveFailure(), null);
});

// ---------------------------------------------------------------------------
// 5. recovering a file the old writer already amplified
// ---------------------------------------------------------------------------

/** Build the exact blob the pre-fix recorder produced: per chunk, the whole chain so
 *  far was appended again, so the value is C[:L1]+C[:L2]+...+C[:Ln] ending in C.
 *
 *  The chunks are IRREGULAR on purpose. Real streaming deltas vary in size, and that is
 *  what distinguishes the bug's tower from a merely periodic string — the recovery uses
 *  the number of distinct growth steps as its signal, so a test built from equal chunks
 *  would not model the input it has to accept. `sizes` is a repeating pattern of chunk
 *  lengths, mirroring how a provider streams a few characters at a time. */
function amplified(chain, sizes = [5, 3, 11, 7, 2, 13, 4, 9]) {
  let stored = '';
  let live = '';
  let i = 0;
  let k = 0;
  while (i < chain.length) {
    const n = sizes[k % sizes.length];
    k++;
    live += chain.slice(i, i + n);
    stored += live;
    i += n;
  }
  return stored;
}

/** A non-repeating chain of the given length — real prose never repeats exactly, and the
 *  periodic case is covered separately below. */
function textOf(len) {
  const words = ['read', 'the', 'file', 'and', 'check', 'the', 'rendering', 'path', 'then',
    'verify', 'the', 'context', 'bar', 'geometry', 'against', 'the', 'picker', 'overlay'];
  let out = '';
  let i = 0;
  while (out.length < len) { out += words[i % words.length] + ' '; i++; }
  return out.slice(0, len);
}

test('the amplified reasoning in an old file is recovered exactly', () => {
  // 4000 real characters streamed a few at a time: the stored blob is the sum of the
  // running prefixes, so a few kB of reasoning becomes well over a megabyte.
  const chain = textOf(4000);
  const stored = amplified(chain);
  assert.ok(stored.length > 2e5, `the old write path built a running-prefix tower (${stored.length})`);
  assert.ok(stored.endsWith(chain), 'the chain is the tail of the blob');

  const out = recoverReasoning(stored);
  assert.ok(out, 'the blob was recognised as amplified');
  assert.equal(out.chain, chain, 'and the recovered text is the chain that was streamed');
  assert.ok(out.chain.length < stored.length / 50, 'a large reduction');
});

test('a handful of separate chains in one file are each recovered', () => {
  // The real 533 MB session held 58 of these, each from its own turn.
  const chains = [textOf(3000), textOf(2500), textOf(4000)];
  const stored = chains.map((c) => amplified(c));
  for (let i = 0; i < chains.length; i++) {
    const out = recoverReasoning(stored[i]);
    assert.ok(out, `entry ${i} recovered`);
    assert.equal(out.chain, chains[i]);
  }
});

test('reasoning that was never amplified is left alone', () => {
  // Ordinary prose is not a tower at all: its consecutive blocks do not grow into each
  // other, so the walk stops immediately.
  const plain = 'The user asked about the context bar, so I read context-bar.js and tui.js. '.repeat(20);
  assert.equal(recoverReasoning(plain), null);
});

test('genuinely repetitive reasoning is not trimmed away', () => {
  // The dangerous case. A PERIODIC text is also a tower — every prefix of it is a prefix of
  // its tail — so the walk tiles it and the rebuild succeeds. Without the amplification
  // floor the recovery would hand back one period and delete the rest of a real answer from
  // a model that repeated itself.
  const period = 'the same sentence, over and over. ';
  for (const reps of [20, 50, 100, 400]) {
    const text = period.repeat(reps);
    assert.equal(recoverReasoning(text), null, `${reps} repeats must be left whole`);
  }
  // And a doubled block of prose, the most natural accidental repeat.
  const half = period.repeat(50);
  assert.equal(recoverReasoning(half + half), null);
});

test('too-short reasoning is never touched', () => {
  assert.equal(recoverReasoning('short'), null);
  assert.equal(recoverReasoning(''), null);
  assert.equal(recoverReasoning(null), null);
  assert.equal(recoverReasoning(undefined), null);
});



test.after(() => {
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* temp dir */ }
  delete process.env.HNCODE_SESSIONS_DIR;
});
