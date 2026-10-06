// Commands must run through dispatch(), not just their helpers.
//
// WHY THIS EXISTS
// ----------------
// `/doctor` shipped broken: it threw `dims is not defined` for every user who ran it. The
// cause was a SCOPE mistake — the `case 'doctor':` body sits in the module-level
// `dispatch()` function, but it referenced `dims()`, which is a closure inside
// `startTUI`. Neither `dispatch` nor `doctor.js` was at fault; the command worked in every
// unit test and failed the moment a real user pressed the key.
//
// So the tests below go through `dispatch()` with the same argument shape the TUI passes.
// That is the only layer where a scope error is observable — a helper-level test cannot
// see it, because the helper is not what the switch calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-dispatch-'));
process.env.HNCODE_SESSIONS_DIR = store;

const { dispatch } = await import('../src/tui.js');

/** Everything dispatch() needs, in the shape startTUI supplies. */
function harness() {
  const panels = [];
  const notices = [];
  const chats = [];
  const errors = [];
  return {
    panels, notices, chats, errors,
    h: {
      addChat: (role, text) => chats.push({ role, text }),
      openPicker: () => {}, openForm: () => {}, openEditor: () => {},
      notice: (text, kind) => notices.push({ text, kind }),
      sendPrompt: () => {}, quit: () => {}, saveSession: () => {},
      openPanel: (title, lines) => panels.push({ title, lines }),
    },
    // A TTY-shaped stdout, so a command that asks for the window size gets real numbers
    // rather than the fallback — which is exactly what the /doctor crash was about.
    stdout: { getWindowSize: () => [120, 40], write: () => true, isTTY: true, columns: 120, rows: 40 },
    state: {
      input: '', caret: 0, chat: [], tasks: {}, todos: [],
      workspace: store, cwd: store, mode: 'ask', plan: false, focus: false,
      session: { id: 'probe', messages: [], transcript: [] },
    },
    cfg: {
      provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k',
      workspace: store, raw: { providers: {}, models: {} },
    },
    session: { id: 'probe', messages: [], transcript: [] },
  };
}

/** Run a command and report any error the same way the user would see one. */
async function run(cmd) {
  const t = harness();
  const seen = [];
  const realErr = console.error;
  console.error = (...a) => seen.push(a.map(String).join(' '));
  let thrown = null;
  try {
    await dispatch('/' + cmd, '', t.state, t.cfg, t.session, t.h, async () => {}, t.stdout);
    await new Promise((r) => setTimeout(r, 300));   // the doctor path settles in a promise
  } catch (e) {
    thrown = e;
  } finally {
    console.error = realErr;
  }
  // A ReferenceError caught by a .catch() in the command still has to be visible here:
  // "the panel did not open" is the symptom a user reports.
  const logged = seen.find((m) => /is not defined|ReferenceError/.test(m));
  return { thrown, logged, panels: t.panels, notices: t.notices };
}

// ---------------------------------------------------------------------------
// the bug
// ---------------------------------------------------------------------------

test('/doctor runs without a scope error and opens its panel', async () => {
  const r = await run('doctor');
  assert.equal(r.thrown, null, `threw: ${r.thrown && r.thrown.message}`);
  assert.equal(r.logged, undefined, `a scope error reached the user: ${r.logged}`);
  assert.ok(r.panels.length, 'the doctor panel opened');
  assert.match(r.panels[0].title, /doctor/i);
});

test('/doctor uses the terminal size it is given', async () => {
  // The regression behind the crash: the size has to come from the stdout dispatch is
  // handed, so a narrow terminal is still reported as narrow.
  const t = harness();
  t.stdout = { getWindowSize: () => [50, 10], write: () => true, isTTY: true, columns: 50, rows: 10 };
  await dispatch('/doctor', '--all', t.state, t.cfg, t.session, t.h, async () => {}, t.stdout);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(t.panels.length, 'the panel opened with a narrow terminal too');
  const text = t.panels[0].lines.join('\n');
  assert.match(text, /50x10/, `the narrow size was reported: ${text.slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// memory-profile, same layer
// ---------------------------------------------------------------------------

test('/memory-profile opens a panel with the memory breakdown', async () => {
  const r = await run('memory-profile');
  assert.equal(r.thrown, null, `threw: ${r.thrown && r.thrown.message}`);
  assert.ok(r.panels.length, 'the panel opened');
  const text = r.panels[0].lines.join('\n');
  assert.match(text, /Memory profile/);
  assert.match(text, /tool arguments/, 'and names the category that turned out to matter most');
});

test('/memprof is an alias, so both spellings work', async () => {
  const r = await run('memprof');
  assert.equal(r.thrown, null);
  assert.ok(r.panels.length, 'the alias opened the same panel');
});

// ---------------------------------------------------------------------------
// what a scope mistake looks like from here
// ---------------------------------------------------------------------------

test('a command referencing an out-of-scope name is caught by this harness', async () => {
  // The control: prove the harness WOULD have caught the original bug. It is a source check
  // rather than a fabricated broken command, because injecting one would mean editing
  // dispatch() to fail on purpose.
  const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
  const dispatchStart = src.indexOf('export async function dispatch(');
  assert.ok(dispatchStart > 0, 'dispatch is a module-level function');
  // Every identifier `case 'doctor'` references must be a dispatch parameter, a local,
  // or a module import — never a name declared inside startTUI.
const caseStart = src.indexOf("case 'doctor': {", dispatchStart);
  const caseEnd = src.indexOf("case 'memory-profile':", caseStart);
  // Strip comments before looking for a CALL: the block's own comment explains this very
  // bug and NAMES dims(), so a naive test matches its own explanation and fails forever.
  const body = src.slice(caseStart, caseEnd)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // The specific regression, stated as an assertion.
  assert.ok(!/\bdims\s*\(/.test(body),
    "the doctor case must not call startTUI's dims() closure; it is not in scope there");
  // And the parameter it uses instead.
assert.match(body, /stdout\.getWindowSize\(\)/, 'the size comes from the stdout parameter');
});


test.after(() => {
  try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* temp */ }
  delete process.env.HNCODE_SESSIONS_DIR;
});
