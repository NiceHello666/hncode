// The settings schema: one declaration per setting, projected onto every surface.
//
// WHY THESE ASSERTIONS
// --------------------
// The schema is now the single source for four things that used to be written out
// separately — the UI rows, the accepted keys, the defaults, and the validation — and the
// failure mode of a "single source" is that it silently covers LESS than the old
// per-command handling did. So the tests are about coverage and reconciliation, not about
// any one row:
//
//   * every key the code reads must be declared, or it becomes unreachable from /settings;
//   * every default must be a STRING, because that is what config.toml holds and what the
//     setter writes — a boolean default made every toggle render "off" regardless;
//   * `coerceSetting` must be the only place a value is interpreted, so a target cannot
//     accept `yes` while another rejects it;
//   * the tabs must partition the rows, and no tab may render empty.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const {
  SETTINGS_SCHEMA, SETTING_BY_KEY, SETTINGS_TABS,
  settingsForTab, populatedTabs, settableKeys, coerceSetting,
  effectiveValue, isSet, displayValue, changedSettings,
} = await import('../src/settings-schema.js');

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

test('every config key the code reads is declared in the schema', () => {
  // The gap this catches: a key the code honours but the schema does not know about can
  // never be set from /settings or /set, and reads as "that setting does not exist".
  const src = ['src/tui.js', 'src/config.js'];
  const found = new Set();
  for (const f of src) {
    const text = fs.readFileSync(path.resolve(f), 'utf8');
    for (const m of text.matchAll(/\bcfg\.raw\.([a-z][a-z0-9_]*)(?![\w(])/g)) found.add(m[1]);
    for (const m of text.matchAll(/root\.([a-z][a-z0-9_]*)(?![\w(])/g)) found.add(m[1]);
  }
  // Keys that are NOT settings, with the reason each is excluded — an exclusion without a
  // reason is how a real setting ends up unreachable.
  const notSettings = new Set([
    'models', 'providers',   // data tables, not scalar settings
    'permissions', 'schedule', // structured maps served by their own commands
    'workspace',             // session state, owned by /move
    'api_key', 'web_token',  // CREDENTIALS — they must never land on a settings screen
    'children',              // a file-tree node property, not config at all
    'cool_mode',             // legacy alias read for backwards compatibility
    'focus_texture',         // declared and deliberately without a row
  ]);
  const missing = [...found].filter((k) => !SETTING_BY_KEY.has(k) && !notSettings.has(k)).sort();
  assert.deepEqual(missing, [],
    `read by the code but absent from the schema: ${missing.join(', ')}`);
});

test('no key is declared twice', () => {
  const seen = new Map();
  for (const d of SETTINGS_SCHEMA) seen.set(d.key, (seen.get(d.key) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(dup, [], `declared twice: ${dup.join(', ')}`);
});

test('settableKeys lists exactly the schema', () => {
  assert.equal(settableKeys().length, SETTINGS_SCHEMA.length);
  assert.ok(settableKeys().every((k) => SETTING_BY_KEY.has(k)));
});

// ---------------------------------------------------------------------------
// defaults must be strings
// ---------------------------------------------------------------------------

test('every default is a string, matching what config.toml stores', () => {
  // A JS boolean here made `displayValue` compare `true === 'true'` and fail, so EVERY
  // toggle rendered as "off" whatever its default was.
  for (const d of SETTINGS_SCHEMA) {
    assert.equal(typeof d.default, 'string', `${d.key} default is ${typeof d.default}`);
  }
});

test('a bool default reads as on or off, never as a raw value', () => {
  for (const d of SETTINGS_SCHEMA.filter((x) => x.kind === 'bool')) {
    assert.ok(['true', 'false'].includes(d.default), `${d.key} default ${JSON.stringify(d.default)}`);
    const shown = displayValue({ raw: {} }, d.key);
    assert.ok(['on', 'off'].includes(shown), `${d.key} shows ${JSON.stringify(shown)}`);
  }
});

test('an int default is a whole number inside its own bounds', () => {
  for (const d of SETTINGS_SCHEMA.filter((x) => x.kind === 'int')) {
    const n = Number(d.default);
    assert.ok(Number.isInteger(n), `${d.key} default ${JSON.stringify(d.default)}`);
    if (d.min != null) assert.ok(n >= d.min, `${d.key} default below min`);
    if (d.max != null) assert.ok(n <= d.max, `${d.key} default above max`);
  }
});

test('an enum default is one of its own values', () => {
  for (const d of SETTINGS_SCHEMA.filter((x) => x.kind === 'enum')) {
    assert.ok(d.values.includes(d.default), `${d.key} default ${d.default} not in ${d.values.join('/')}`);
  }
});

test('the theme default names a theme the program ships', async () => {
  const { THEME_NAMES } = await import('../src/colors.js');
  const d = SETTING_BY_KEY.get('theme');
  assert.ok(THEME_NAMES.includes(d.default), `theme default ${d.default} is not a shipped theme`);
  for (const v of d.values) assert.ok(THEME_NAMES.includes(v), `${v} is not a shipped theme`);
});

// ---------------------------------------------------------------------------
// coercion — the single validation point
// ---------------------------------------------------------------------------

test('a bool accepts the spellings people write and nothing else', () => {
  for (const yes of ['1', 'true', 'on', 'yes', 'YES', 'True']) {
    assert.deepEqual(coerceSetting('auto_trim', yes), { ok: true, value: 'true' }, yes);
  }
  for (const no of ['0', 'false', 'off', 'no', '']) {
    assert.deepEqual(coerceSetting('auto_trim', no), { ok: true, value: 'false' }, no);
  }
  const bad = coerceSetting('auto_trim', 'maybe');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /on\/off/);
});

test('an int takes a number, a percent sign, and refuses the rest', () => {
  assert.deepEqual(coerceSetting('compact_threshold', '85'), { ok: true, value: '85' });
  assert.deepEqual(coerceSetting('compact_threshold', '85%'), { ok: true, value: '85' }, 'the sign is natural here');
  assert.deepEqual(coerceSetting('compact_threshold', ' 42 '), { ok: true, value: '42' });
  for (const bad of ['abc', '8.5', '']) {
    assert.equal(coerceSetting('compact_threshold', bad).ok, false, JSON.stringify(bad));
  }
});

test('an int is held inside the bounds the schema declares', () => {
  const d = SETTING_BY_KEY.get('compact_threshold');
  assert.equal(coerceSetting('compact_threshold', String(d.min - 1)).ok, false, 'below the minimum');
  assert.equal(coerceSetting('compact_threshold', String(d.max + 1)).ok, false, 'above the maximum');
  assert.equal(coerceSetting('compact_threshold', String(d.min)).ok, true, 'the minimum itself is allowed');
  assert.equal(coerceSetting('compact_threshold', String(d.max)).ok, true, 'and so is the maximum');
});

test('an enum accepts a case-insensitive hit and refuses a near miss', () => {
  assert.deepEqual(coerceSetting('theme', 'nord'), { ok: true, value: 'nord' });
  assert.deepEqual(coerceSetting('theme', 'NORD'), { ok: true, value: 'nord' }, 'case is not a distinction worth having');
  const bad = coerceSetting('theme', 'nordic');
  assert.equal(bad.ok, false, 'a near miss must be refused, not coerced');
  assert.match(bad.error, /one of/);
});

test('a string takes anything, including empty — which means unset', () => {
  assert.deepEqual(coerceSetting('system_prompt', 'be terse'), { ok: true, value: 'be terse' });
  assert.deepEqual(coerceSetting('system_prompt', ''), { ok: true, value: '' });
  // A multi-line prompt must survive intact, newlines and all.
  const multi = 'line one\nline two\n\nline four';
  assert.deepEqual(coerceSetting('system_prompt', multi), { ok: true, value: multi });
});

test('an unknown key is refused by name', () => {
  const r = coerceSetting('not_a_setting', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown setting/);
});

// ---------------------------------------------------------------------------
// effective value, and what counts as changed
// ---------------------------------------------------------------------------

test('an unset value falls back to the schema default', () => {
  for (const d of SETTINGS_SCHEMA) {
    assert.equal(effectiveValue({ raw: {} }, d.key), d.default, d.key);
    assert.equal(isSet({ raw: {} }, d.key), false, `${d.key} is not set`);
  }
});

test('a set value wins over the default, and is marked as set', () => {
  const cfg = { raw: { theme: 'gruvbox', auto_trim: 'false' } };
  assert.equal(effectiveValue(cfg, 'theme'), 'gruvbox');
  assert.equal(isSet(cfg, 'theme'), true);
  assert.equal(displayValue(cfg, 'theme'), 'gruvbox');
  assert.equal(displayValue(cfg, 'auto_trim'), 'off');
});

test('an empty string means unset, so a cleared prompt reverts', () => {
  const cfg = { raw: { system_prompt: '' } };
  assert.equal(isSet(cfg, 'system_prompt'), false, 'empty is not a value');
  assert.equal(effectiveValue(cfg, 'system_prompt'), SETTING_BY_KEY.get('system_prompt').default);
});

test('changedSettings names only what differs, string-compared', () => {
  // A value written back equal to its default is NOT a change, and saying otherwise makes
  // the list useless as a "what have I customised" view.
  const cfg = { raw: { theme: 'gruvbox', auto_trim: 'true', calm_mode: 'false' } };
  const changed = changedSettings(cfg).map((d) => d.key);
  assert.ok(changed.includes('theme'), 'a real change is listed');
  assert.ok(!changed.includes('auto_trim'), 'set to its default is not a change');
  assert.ok(!changed.includes('calm_mode'), 'nor is setting the default explicitly');
});

test('a long text value is shortened for the row, and says so', () => {
  const long = 'x'.repeat(200);
  const shown = displayValue({ raw: { system_prompt: long } }, 'system_prompt');
  assert.ok(shown.length <= 41, `row value is bounded: ${shown.length}`);
  assert.match(shown, /…/, 'and marked as truncated');
  // A multi-line value shows its first line, not a newline that would break the row.
  const multi = displayValue({ raw: { system_prompt: 'first line\nsecond' } }, 'system_prompt');
  assert.ok(!multi.includes('\n'), 'no newline leaks into a one-line row');
});

test('an unset string reads as (unset) rather than an empty gap', () => {
  assert.equal(displayValue({ raw: {} }, 'provider'), '(unset)');
  assert.equal(displayValue({ raw: { provider: 'openai' } }, 'provider'), 'openai');
});

// ---------------------------------------------------------------------------
// the tabs
// ---------------------------------------------------------------------------

test('every rowed setting belongs to a declared tab', () => {
  const ids = new Set(SETTINGS_TABS.map((t) => t.id));
  for (const d of SETTINGS_SCHEMA) {
    if (!d.ui) continue;                     // hidden by design
    assert.ok(ids.has(d.ui.tab), `${d.key} is on unknown tab ${d.ui.tab}`);
  }
});

test('no declared tab renders empty', () => {
  // An empty tab is a dead end in the rail: the user opens it and sees nothing.
  for (const t of populatedTabs()) {
    assert.ok(settingsForTab(t.id).length > 0, `tab ${t.id} has no rows`);
  }
  assert.equal(populatedTabs().length, SETTINGS_TABS.length, 'every declared tab is populated');
});

test('every rowed setting carries a label and a hint', () => {
  for (const d of SETTINGS_SCHEMA) {
    if (!d.ui) continue;
    assert.ok(d.ui.label && d.ui.label.length, `${d.key} has no label`);
    assert.ok(d.ui.hint && d.ui.hint.length, `${d.key} has no hint`);
    assert.ok(d.ui.group && d.ui.group.length, `${d.key} has no group`);
  }
});

test('hidden settings are still settable, which is the point of hiding them', () => {
  const hidden = SETTINGS_SCHEMA.filter((d) => !d.ui);
  for (const d of hidden) {
    assert.ok(settableKeys().includes(d.key), `${d.key} is hidden AND unreachable`);
    assert.equal(coerceSetting(d.key, d.default).ok, true, `${d.key} cannot be set to its own default`);
  }
});

test('the prompt tab exists and holds the prompt knobs', () => {
  // The tab this feature was asked for; a schema without it would be a settings screen
  // that cannot edit the prompt at all.
  const keys = settingsForTab('prompt').map((d) => d.key);
  for (const k of ['system_prompt', 'append_system_prompt', 'plan_instructions']) {
    assert.ok(keys.includes(k), `prompt tab has no ${k}`);
  }
});
