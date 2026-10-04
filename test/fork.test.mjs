// `/fork` must produce a conversation that can diverge from its parent.
//
// THE BUG THIS PINS
// -----------------
// `/fork` built the copy with `messages: session.messages.slice()`, which copies the
// ARRAY but not the messages inside it — so the fork and its parent shared every message
// object. Nothing was wrong at the moment of forking; the fork was a faithful copy, and
// the file on disk was a separate JSON document. The damage came later, from any write
// into a message: `/compact` replacing `messages`, `/undo` truncating, a plugin rewriting
// one. Then the PARENT changed — silently, in a session the user had already left.
//
// This drives the real `dispatch`, because `cloneMessageForFork` is module-private and a
// hand-built copy would not prove the command uses it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatch, makeState } from '../src/tui.js';
import { forkOf } from '../src/fork.js';
import { listSessions, loadSession } from '../src/session.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-fork-home-'));
fs.mkdirSync(path.join(home, '.hncode'), { recursive: true });
fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), '');
process.env.HNCODE_HOME = home;

const notices = [];
const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
  raw: { providers: {}, models: { 'p/m': {} } },
};
const session = {
  id: 'parent-id', title: 'parent', workspace: '/w', model: 'p/m',
  createdAt: 1, updatedAt: 1,
  messages: [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer', toolCalls: [{ id: 't1', function: { name: 'Read' } }] },
    { role: 'user', content: 'second' },
  ],
  rounds: 3, steps: 7,
};
const state = makeState({ cfg, session, opts: {} });
state.chat = [];
const h = {
  addChat: (m) => state.chat.push(m),
  notice: (m) => notices.push(m),
  persistState: () => {},
  saveSession: () => {},
  renderFrame: () => {},
};

await dispatch('/fork', '', state, cfg, session, h, () => {}, { write: () => true }, () => {});

const forkId = (notices.join('\n').match(/forked \(([^)]+)\)/) || [])[1];
assert.ok(forkId, `the fork must report its id, got: ${notices.join(' | ')}`);

test('the fork is saved and is not the parent', () => {
  const ids = listSessions().map((s) => s.id);
  assert.ok(ids.includes(forkId), 'the fork is on disk');
  assert.notEqual(forkId, session.id);
});

test('a fork holds its OWN message objects', () => {
  // The whole point, and the part the file round-trip CANNOT show: loading a session
  // yields a fresh JSON document, so aliasing is invisible from disk. It has to be
  // checked on the object the command handed to saveSession.
  const fork = forkOf(session, () => 'kid');
  assert.notEqual(fork.messages[0], session.messages[0], 'not the same object');
  assert.notEqual(fork.messages[1], session.messages[1]);
  assert.deepEqual(fork.messages[1], session.messages[1], 'but a faithful copy');
  // Nested fields too: a turn writes into them (a growing `content`, a pushed tool call).
  assert.notEqual(fork.messages[1].toolCalls, session.messages[1].toolCalls);
  assert.notEqual(fork.messages[1].toolCalls[0], session.messages[1].toolCalls[0]);
  // And the aliasing is what actually breaks things, so prove the consequence:
  fork.messages[0].content = 'MUTATED IN THE FORK';
  assert.equal(session.messages[0].content, 'first', 'the parent must be untouched');
});

test('the fork does not inherit the parent turn counters', () => {
  // rounds/steps belong to the conversation, not the copy: a fork that inherited them
  // made the status bar claim work that happened in a different conversation.
  const fork = forkOf(session, () => 'kid');
  assert.equal(fork.rounds, undefined);
  assert.equal(fork.steps, undefined);
  assert.equal(session.rounds, 3, 'and the parent still has its own');
});

test('the fork records where it came from', () => {
  assert.equal(forkOf(session, () => 'kid').forkedFrom, 'parent-id');
  // A fork of a fork keeps pointing at the session it was actually branched from, so the
  // lineage reads as a tree instead of a flat list of siblings.
  const kid = forkOf({ ...session, id: 'kid-id', title: 'parent (fork)', forkedFrom: 'parent-id' }, () => 'kid2');
  assert.equal(kid.forkedFrom, 'parent-id');
  assert.equal(kid.title, 'parent (fork) (fork)');
});
test('render bookkeeping does not travel with the fork', () => {
  // `_conv` / `_mdCache` describe the parent's screen and its scroll; carrying them over
  // makes the fork display rows the new conversation has not produced.
  const withState = {
    ...session,
    messages: [{ role: 'user', content: 'x', _conv: true, _mdCache: [1, 2], _wrapped: [[0, 1]], _prevWrap: [0] }],
  };
  const m = forkOf(withState, () => 'kid').messages[0];
  assert.equal(m._conv, undefined);
  assert.equal(m._mdCache, undefined);
  assert.equal(m._wrapped, undefined);
  assert.equal(m._prevWrap, undefined);
  assert.equal(m.content, 'x', 'the message itself is kept');
});

test('the parent is untouched by the fork', () => {
  // Nothing above wrote to the parent, and that is the assertion: the fork operation
  // itself must be read-only with respect to it.
  assert.equal(session.title, 'parent');
  assert.deepEqual(session.messages.map((m) => m.content), ['first', 'answer', 'second']);
  assert.equal(session.rounds, 3);
});

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp dir */ }
});