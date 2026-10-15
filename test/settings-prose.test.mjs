// Prose settings in /settings: how they READ, and where Enter takes you.
//
// WHY
// ---
// A prompt is a paragraph. It was shown as the paragraph truncated to forty characters — which
// told the user nothing except that it did not fit, and pushed the label out of line with every
// other row — and Enter opened a ONE-LINE form, so editing it meant driving a text box the size
// of a single row with no way to reach the line below.
//
// These assertions go through `dispatch('/settings')` rather than rebuilding the picker's items.
// A hand-built item list is what let a `def is not defined` slip through: the real row builder
// never ran.
import assert from 'node:assert/strict';
import test from 'node:test';

const { dispatch, makeState } = await import('../src/tui.js');
const { settingsForTab, effectiveValue } = await import('../src/settings-schema.js');

const LONG_PROMPT = [
  'You are terse. Answer in one sentence unless asked for detail.',
  '',
  'Never narrate what you are about to do. Just do it.',
  'When you are unsure, read the code instead of guessing.',
].join('\n');

/** Open /settings on a tab, through the real command, and hand back the picker. */
async function openSettings(tab, raw = {}) {
  const cfg = {
    provider: 'p', model: 'm', endpoint: 'x', apiKey: 'k',
    workspace: process.cwd(), raw,
  };
  const host = {
    addChat: () => {},
    openPicker: (p) => { host._picker = p; },
    openForm: () => { host._form = true; },
    openEditor: (spec) => { host._editor = spec; },
    notice: () => {}, sendPrompt: () => {}, quit: () => {}, saveSession: () => {},
    openTasksPanel: () => {}, openRegistryBrowser: () => {}, openPanel: () => {},
  };
  const stdout = { getWindowSize: () => [100, 30], write: () => true, isTTY: true, columns: 100, rows: 30 };
  const session = { id: 'p', messages: [], transcript: [] };
  const state = makeState({ cfg, session, opts: {} });
  state.cfg = cfg;
  await dispatch('/settings', tab, state, cfg, session, host, async () => {}, stdout);
  return { picker: host._picker, host, cfg };
}

test('a paragraph reads as its size, not as a truncated copy', async () => {
  const { picker } = await openSettings('prompt', { system_prompt: LONG_PROMPT });
  const item = picker.items.find((i) => i.label === 'System prompt');
  assert.ok(item, 'the row exists');
  assert.match(item.valueTag, /^4 lines, \d+ chars$/, `got ${JSON.stringify(item.valueTag)}`);
  assert.ok(item.valueTag.length <= 34, 'and it fits the row');
});

test('a single short line is shown as-is', async () => {
  // The abbreviation would be worse than the value here: "1 line, 27 chars" hides something the
  // row has room for.
  const { picker } = await openSettings('prompt', { append_system_prompt: 'Reply in Chinese.' });
  const item = picker.items.find((i) => i.label === 'Append to system prompt');
  assert.equal(item.valueTag, 'Reply in Chinese.');
});

test('an unset paragraph says so', async () => {
  const { picker } = await openSettings('prompt', {});
  const item = picker.items.find((i) => i.label === 'Plan mode instructions');
  assert.equal(item.valueTag, '(unset)');
});

test('Enter on a paragraph opens the multi-line editor with the whole value', async () => {
  const { picker, host } = await openSettings('prompt', { system_prompt: LONG_PROMPT });
  const item = picker.items.find((i) => i.label === 'System prompt');
  picker.onPick(item);

  assert.ok(host._editor, 'the editor opened');
  assert.equal(host._form, undefined, 'and NOT the one-line form');
  assert.equal(host._editor.text, LONG_PROMPT, 'the full text is handed over, newlines and all');
  assert.equal(host._editor.title, 'System prompt');
});

test('Enter on a short setting still uses the one-line form', async () => {
  const { picker, host } = await openSettings('model', {});
  const item = picker.items.find((i) => i.setKey === 'effort');
  assert.ok(item, 'the effort row exists');
  picker.onPick(item);
  assert.ok(host._form, 'the form opened');
  assert.equal(host._editor, undefined, 'and the editor did not');
});

test('every prose setting in the schema takes the editor path', async () => {
  // Guards the set rather than one example: a new paragraph setting that forgot to be `text`
  // would fall back to the one-line form and be just as unusable.
  const prose = settingsForTab('prompt').filter((d) => d.kind === 'text');
  assert.ok(prose.length >= 3, `expected several prose settings, found ${prose.length}`);

  const { picker, host } = await openSettings('prompt', { system_prompt: LONG_PROMPT });
  for (const d of prose) {
    host._editor = undefined;
    host._form = undefined;
    const item = picker.items.find((i) => i.setKey === d.key);
    assert.ok(item, `${d.key} has a row`);
    picker.onPick(item);
    assert.ok(host._editor, `${d.key} opens the editor`);
    assert.equal(host._form, undefined, `${d.key} does not open the form`);
  }
});

test('the value shown matches what is in force', async () => {
  const { picker, cfg } = await openSettings('prompt', { system_prompt: LONG_PROMPT });
  const item = picker.items.find((i) => i.label === 'System prompt');
  const real = effectiveValue(cfg, 'system_prompt');
  assert.equal(real, LONG_PROMPT, 'the config carries the text');
  assert.match(item.valueTag, new RegExp(`^${LONG_PROMPT.split('\n').length} lines`));
});
