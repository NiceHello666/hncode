// A command that does not exist is sent to the model as text.
//
// WHY THIS FILE EXISTS
// --------------------
// An unrecognised `/name` used to be REFUSED with "Unknown command" and dropped. The composer strips the
// slash on the command path, so the user's text never reached the model: typing `/why is this slow`
// produced an error instead of an answer. A leading slash is also how a slash-heavy message happens to
// start — a path, a sed script, a regex — so a message that merely LOOKED like a command was the most
// likely casualty, and it was lost silently from the conversation.
//
// The tests go through `dispatch()`, because that is the only layer where the routing is observable: a
// helper test cannot see which branch the switch took.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-unknown-cmd-'));
process.env.HNCODE_SESSIONS_DIR = store;

const { dispatch } = await import('../src/tui.js');

/** dispatch()'s dependencies, capturing what is SENT and what is NOTICED. */
function harness() {
  const notices = [];
  const sent = [];
  return {
    notices, sent,
    h: {
      addChat: () => {}, openPicker: () => {}, openForm: () => {}, openEditor: () => {},
      notice: (text, kind) => notices.push({ text, kind }),
      sendPrompt: (text) => { sent.push(text); },
      quit: () => {}, saveSession: () => {},
      // `/help` and friends open a panel. Without it the command THREW, which the test then read as
      // "not a known command" — the harness was missing a dependency, not the router a branch.
      openPanel: () => {},
    },
    stdout: { getWindowSize: () => [120, 40], write: () => true, isTTY: true, columns: 120, rows: 40 },
    state: { input: '', caret: 0, chat: [], tasks: {}, todos: [], workspace: store, cwd: store, mode: 'ask' },
    cfg: { provider: 'p', model: 'm', workspace: store, raw: { providers: {}, models: {} } },
    session: { id: 'probe', messages: [], transcript: [] },
  };
}

/** Run a line through dispatch the way the composer does. */
async function run(line, arg = '') {
  const t = harness();
  await dispatch(line, arg, t.state, t.cfg, t.session, t.h, async () => {}, t.stdout);
  return t;
}

test('an unknown command is sent to the model', () => {
  // The defect: this text used to be dropped on the floor.
  return run('/why-is-this-slow please explain', 'please explain').then((t) => {
    assert.equal(t.sent.length, 1, `exactly one message was sent: ${JSON.stringify(t.sent)}`);
    assert.match(t.sent[0], /why-is-this-slow/);
  });
});

test('the message is sent WHOLE, arguments included', () => {
  // `arg` is the trailing text and `cmdRaw` already carries it; sending `arg` alone would lose the
  // command word, and sending `cmdRaw` alone would lose nothing. Both must end up in the message.
  return run('/explain this regex \\d+', 'this regex \\d+').then((t) => {
    const msg = t.sent[0] || '';
    assert.match(msg, /explain/, 'the name is kept');
    assert.match(msg, /\\d\+/, 'and so is the argument');
  });
});

test('the leading slash is preserved exactly once', () => {
  // Callers pass `cmdRaw` both with and without the slash, so it has to be normalised rather than
  // assumed: `//foo` would be a different message than the user typed.
  return Promise.all([
    run('/nope', ''),
    run('nope', ''),
  ]).then(([withSlash, without]) => {
    assert.equal(withSlash.sent[0], '/nope');
    assert.equal(without.sent[0], '/nope', 'a missing slash is added, not doubled');
    assert.doesNotMatch(without.sent[0], /^\/\//, 'and never doubled');
  });
});

test('the user is told the command was not recognised', () => {
  // Silent forwarding would be worse than the error was: a typo like `/hlep` would look like it ran.
  return run('/hlep', '').then((t) => {
    const said = t.notices.map((n) => n.text).join(' ');
    assert.match(said, /No such command/, `the notice names the problem: ${said}`);
    assert.match(said, /hlep/, 'and names what was not found');
    assert.equal(t.notices[0].kind, 'info', 'as information, not an error — it still went through');
  });
});

test('a real command is NOT forwarded', () => {
  // The guard on the other side: the new path must not swallow ordinary commands.
  return run('/help', '').then((t) => {
    assert.equal(t.sent.length, 0, `a known command sends nothing as text: ${JSON.stringify(t.sent)}`);
  });
});
