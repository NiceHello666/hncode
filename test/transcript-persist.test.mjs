// The display-only transcript must survive a resume.
//
// WHAT WAS LOST
// -------------
// `session.messages` holds what the MODEL is sent, so anything that exists only on screen
// has no home there — a notice, a warning, a compaction result, a plan card, a
// background-task card, a reasoning block. `reconstructChat` rebuilds the transcript from
// `convRowFor`, which handles three roles, so every other one vanished on resume: the
// `[turn took 3.2s]` receipts, the "Stopped:" warnings, the compaction summary, the plan you
// approved, the background tasks, and the reasoning itself.
//
// They are recorded in `session.transcript` instead, anchored to the message count they
// followed, and `reconstructChat` interleaves them. Nothing sends that array to a provider.
//
// `rich` is deliberately absent: those rows are command OUTPUT (/diff, /log, /cost), and
// replaying them shows a snapshot of a moment that has passed. `bash` and `tool_result` are
// absent too — `session.shellHistory` already covers them, and recording twice would double
// every `!cmd`.
//
// This drives the real `reconstructChat`, and the persistence half through a real session
// file, because the failure mode is a field silently missing at the seam between them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconstructChat } from '../src/tui.js';
import { saveSession, loadSession } from '../src/session.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-transcript-'));
fs.mkdirSync(path.join(home, '.hncode'), { recursive: true });
fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), '');
process.env.HNCODE_HOME = home;

/** A session carrying a conversation plus display rows anchored between the messages. */
function sessionWith(rows) {
  return {
    id: 'tr-1',
    workspace: '/w',
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ],
    transcript: rows,
  };
}

const textOf = (rows) => rows.map((r) => String(r.text == null ? '' : r.text));

// ---------------------------------------------------------------------------
// The resume side: rows come back, in the slot they were recorded in
// ---------------------------------------------------------------------------

test('a notice recorded after the second answer comes back after it', () => {
  // `anchor` is the number of real messages that preceded the row, so anchor 2 means
  // "after the first exchange, before the second question" — the slot it was shown in.
  const chat = reconstructChat(sessionWith([
    { anchor: 2, ts: 1, row: { role: 'system', text: '[turn took 3.2s]' } },
  ]));
  const texts = textOf(chat);
  const at = texts.indexOf('[turn took 3.2s]');
  assert.ok(at >= 0, 'the notice is back');
  assert.equal(texts[at - 1], 'first answer', 'in the slot it was recorded at');
  assert.equal(texts[at + 1], 'second question', 'and the conversation continues after it');
});

test('rows recorded at the same anchor keep their recorded order', () => {
  const chat = reconstructChat(sessionWith([
    { anchor: 2, ts: 1, row: { role: 'system', text: 'first notice' } },
    { anchor: 2, ts: 2, row: { role: 'warn', text: 'second notice' } },
  ]));
  const texts = textOf(chat);
  assert.deepEqual(texts.slice(2, 4), ['first notice', 'second notice']);
});

test('rows anchored past the last message land at the tail', () => {
  // anchor === messages.length is what "at the very tail" means: the row followed every
  // conversation message. An anchor BEYOND that is what a row recorded before a message
  // was later removed looks like, and it must land in the same place rather than vanish.
  const chat = reconstructChat(sessionWith([
    { anchor: 4, ts: 1, row: { role: 'system', text: 'after everything' } },
  ]));
  const texts = textOf(chat);
  assert.equal(texts[texts.length - 1], 'after everything');
  // They must not disturb the conversation itself.
  assert.ok(texts.includes('first question'));
  assert.ok(texts.includes('second answer'));
});

test('a resumed reasoning block is settled, not left spinning', () => {
  // `pending` is live state. A block that was open when the session was saved must not
  // resume as a spinner that never stops.
  const chat = reconstructChat(sessionWith([
    { anchor: 2, ts: 1, row: { role: 'thinking', text: 'weighing the options', pending: true } },
  ]));
  const t = chat.find((r) => r.role === 'thinking');
  assert.ok(t, 'the reasoning came back');
  assert.equal(t.text, 'weighing the options');
  assert.equal(t.pending, false, 'and it is settled');
});

test('a session with no transcript resumes exactly as before', () => {
  // The common case must be untouched: a file written before this feature has no
  // `transcript` key at all.
  const chat = reconstructChat(sessionWith(undefined));
  assert.deepEqual(chat.map((r) => r.role), ['user', 'assistant', 'user', 'assistant']);
});

test('a malformed transcript entry does not take the resume down', () => {
  // This array comes off disk. A null (older writer, hand edit, truncated write) must not
  // throw the way a null message used to.
  const chat = reconstructChat(sessionWith([
    null,
    { anchor: 2, ts: 1, row: null },
    { anchor: 2, ts: 2, row: { role: 'system', text: 'the good one' } },
  ]));
  assert.ok(textOf(chat).includes('the good one'));
  assert.ok(textOf(chat).includes('second answer'), 'and the conversation is intact');
});

// ---------------------------------------------------------------------------
// The persistence side: the fields a row needs must survive a round trip
// ---------------------------------------------------------------------------

test('a display row survives a save and load unchanged', () => {
  // The loss was never the write — `serializableSession` copies every key — it was that
  // nothing was ever put in the array. This pins the round trip that makes it real.
  const rows = [
    { anchor: 2, ts: 1, row: { role: 'system', text: '[turn took 3.2s]' } },
    { anchor: 2, ts: 2, row: { role: 'compaction', text: 'a summary', phase: 'done', tokensBefore: 9000, tokensAfter: 1200 } },
    { anchor: 3, ts: 3, row: { role: 'bg_task', text: '', card: { phase: 'completed', headline: 'agent finished' } } },
    { anchor: 3, ts: 4, row: { role: 'plan', text: '## the plan' } },
    { anchor: 3, ts: 5, row: { role: 'skill', text: 'code-review' } },
    { anchor: 4, ts: 6, row: { role: 'thinking', text: 'a chain of thought', pending: false } },
  ];
  const session = { id: 'tr-save', workspace: '/w', model: 'p/m', messages: sessionWith(undefined).messages, transcript: rows };
  saveSession(session);
  const back = loadSession('tr-save');
  assert.ok(back, 'the session loads back');
  assert.deepEqual(back.transcript, rows, 'every row and every field survived');
});

test('a background-task card keeps its card, not just its text', () => {
  // The `bg_task` renderer reads `msg.card`; the row's text is only the body. A card that
  // arrives as a bare string renders the placeholder instead of what happened.
  const session = {
    id: 'tr-card', workspace: '/w', model: 'p/m', messages: [],
    transcript: [{ anchor: 0, ts: 1, row: { role: 'bg_task', text: 'the output', card: { phase: 'failed', headline: 'agent crashed' } } }],
  };
  saveSession(session);
  const back = loadSession('tr-card');
  assert.deepEqual(back.transcript[0].row.card, { phase: 'failed', headline: 'agent crashed' });
});

test('the save switches round-trip, so /save-history survives a restart', () => {
  const session = { id: 'tr-flags', workspace: '/w', model: 'p/m', messages: [], saveHistory: false, saveThinking: false };
  saveSession(session);
  const back = loadSession('tr-flags');
  assert.equal(back.saveHistory, false);
  assert.equal(back.saveThinking, false);
});

test('the rebuilt transcript reproduces the display roles the rebuild used to drop', () => {
  // The whole point, stated as a set: every one of these was silently gone on resume.
  const chat = reconstructChat(sessionWith([
    { anchor: 0, ts: 1, row: { role: 'system', text: 'a system notice' } },
    { anchor: 2, ts: 2, row: { role: 'warn', text: 'a warning' } },
    { anchor: 2, ts: 3, row: { role: 'compaction', text: 'a compaction', phase: 'done' } },
    { anchor: 3, ts: 4, row: { role: 'bg_task', text: 'a task', card: { phase: 'completed' } } },
    { anchor: 3, ts: 5, row: { role: 'plan', text: 'a plan' } },
    { anchor: 3, ts: 6, row: { role: 'skill', text: 'a skill' } },
    { anchor: 3, ts: 7, row: { role: 'steer', text: 'a steer' } },
    { anchor: 4, ts: 8, row: { role: 'thinking', text: 'reasoning', pending: false } },
  ]));
  const roles = chat.map((r) => r.role);
  for (const role of ['system', 'warn', 'compaction', 'bg_task', 'plan', 'skill', 'steer', 'thinking']) {
    assert.ok(roles.includes(role), `${role} survived the resume`);
  }
  // And the conversation is still exactly where it was.
  assert.deepEqual(
    chat.filter((r) => r._conv).map((r) => r.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
});

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp dir */ }
});
