// `/new` reuses the session OBJECT instead of allocating a fresh one, so every field it
// forgets to clear is carried into the new conversation — and persisted, because
// saveSession writes the whole object. `shellHistory` was one of those: the `!command`
// rows of the PREVIOUS session reappeared in a session the user had just started, and
// again after the next `--continue`.
//
// The first test pins WHY it is visible at all (a message-less session still renders an
// inherited shell entry); the second pins the fix. `case 'new'` builds its handlers
// inside a closure, so the field reset is asserted at the source level — the same
// technique `picker-hints.test.mjs` and `stream-wiring.test.mjs` use.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reconstructChat } from '../src/tui.js';

const TUI = path.join(import.meta.dirname, '..', 'src', 'tui.js');
const src = fs.readFileSync(TUI, 'utf8');

test('a message-less session still renders an inherited shell entry', () => {
  // This is what made the leak visible. `shellHistory` lives outside `messages`, and an
  // entry anchored at 0 — a `!command` run before the first message — is emitted even
  // when the session has said nothing, because the tail emit is `emitShells(0)`.
  const leaked = {
    messages: [],
    shellHistory: [{ cmd: 'git status', ts: 1000, ok: true, doneAt: 2000, anchor: 0 }],
  };
  const rows = reconstructChat(leaked);
  assert.ok(rows.some((r) => r.role === 'bash' && r.text === 'git status'),
    'a blank session must not be able to render a shell command it never ran');
});

test('a session with no shell history renders no shell rows', () => {
  // The state a new session must be in. Guards against the fix being "hide the rows"
  // rather than "clear the history".
  const clean = { messages: [], shellHistory: [] };
  assert.deepEqual(reconstructChat(clean), []);
  assert.deepEqual(reconstructChat({ messages: [] }), []);
});

test('the /new handler clears shellHistory', () => {
  // Scope the assertion to the `case 'new':` block, so a clear added somewhere else
  // (a start-up path, say) cannot satisfy it.
  const start = src.indexOf("case 'new':");
  assert.ok(start > 0, "the 'new' case was not found");
  const next = src.indexOf("\n    case '", start + 1);
  const block = src.slice(start, next > 0 ? next : start + 4000);
  assert.ok(/session\.shellHistory = \[\];/.test(block),
    "case 'new' must reset session.shellHistory, or the previous session's !commands leak into the new one");
});

test('every per-conversation CONTENT field the /new handler owns is reset', () => {
  // The general rule the bug violated. Mode toggles (plan/focus/swarm/effort/mode) are
  // the user's SETTINGS and deliberately survive `/new`; anything holding content that
  // belongs to one conversation must not.
  const start = src.indexOf("case 'new':");
  const next = src.indexOf("\n    case '", start + 1);
  const block = src.slice(start, next > 0 ? next : start + 4000);
  const contentFields = [
    ['messages', /messages: \[\]/],
    ['todos', /session\.todos = \[\]/],
    ['shellHistory', /session\.shellHistory = \[\]/],
    ['usage', /delete session\.usage/],
  ];
  for (const [field, re] of contentFields) {
    assert.ok(re.test(block), `case 'new' must reset ${field}`);
  }
});