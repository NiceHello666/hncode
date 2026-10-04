// `/move` must leave the session stamped with the directory it moved TO.
//
// THE BUG THIS PINS
// -----------------
// `case 'move'` built a new session with `workspace: target`, then did:
//
//   session = newSession;      // a local reassignment of the PARAMETER
//
// `dispatch`'s `session` is a parameter, so that assignment died with the call. The caller
// keeps its own `session` binding — the one `startTUI` closes over — so every later
// `saveSession(session)` wrote the OLD object, still carrying the old workspace. The file
// for the new id was written once with the right directory; the live session the TUI kept
// saving was the one from before the move. That is the report: after /move, the session is
// still marked with the folder it left.
//
// The fix routes the replacement through the host (`h.replaceSession`), which rebinds the
// closure variable AND the mirror on `state`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatch, makeState } from '../src/tui.js';
import { loadSession, listSessions } from '../src/session.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-move-home-'));
const from = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-move-from-'));
const to = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-move-to-'));
fs.mkdirSync(path.join(home, '.hncode'), { recursive: true });
fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), '');
process.env.HNCODE_HOME = home;

const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: from,
  raw: { providers: {}, models: { 'p/m': {} } },
};
const session = {
  id: 'before-move', title: 'a conversation', workspace: from, model: 'p/m',
  createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'asked in the wrong place' }],
  mode: 'ask', todos: [],
};

const state = makeState({ cfg, session, opts: {} });
state.chat = [];
state.cwd = from;

// The host, wired the way `startTUI` wires it: `replaceSession` rebinds the closure variable
// that every later save reads. This is the seam the old code was missing.
let live = session;
const notices = [];
const h = {
  addChat: (m) => state.chat.push(m),
  notice: (m) => notices.push(m),
  renderFrame: () => {},
  persistState: () => {},
  saveSession: () => {},
  replaceSession: (s) => { if (s) live = s; },
};

await dispatch('/move', to, state, cfg, session, h, () => {}, { write: () => true }, () => {});

test('the command reports the move', () => {
  assert.match(notices.join('\n'), /moved to/i, notices.join(' | '));
});

test('the LIVE session is the new one', () => {
  // The whole bug: `live` is what `startTUI` closes over and what every later save writes.
  assert.notEqual(live.id, 'before-move', 'the live binding still points at the old session');
  assert.equal(live.workspace, to);
});

test('the live session, saved again, still carries the new directory', () => {
  // Simulate the next turn: the TUI saves the live session. Before the fix this wrote the
  // OLD object, so the file kept the old workspace.
  h.saveSession(live);
  const reloaded = loadSession(live.id);
  assert.ok(reloaded, 'the moved session is on disk');
  assert.equal(reloaded.workspace, to, 'and is stamped with the directory it moved to');
});

test('the transcript came along', () => {
  assert.deepEqual(live.messages.map((m) => m.content), ['asked in the wrong place']);
});

test('the state follows the move, so the tools resolve in the new directory', () => {
  assert.equal(state.cwd, to);
  assert.equal(state.workspace, to);
  assert.equal(cfg.workspace, to, 'the agent copies the workspace from cfg each turn');
  assert.equal(cfg.cwd, to);
});

test('a move to a directory that does not exist is refused, and nothing moves', () => {
  const beforeId = live.id;
  const missing = path.join(to, 'no-such-subdir');
  return dispatch('/move', missing, state, cfg, live, h, () => {}, { write: () => true }, () => {})
    .then(() => {
      assert.equal(live.id, beforeId, 'the live session is unchanged');
      assert.match(notices.join('\n'), /does not exist/i);
    });
});

test.after(() => {
  for (const d of [home, from, to]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
});