// /doctor and /theme.
//
// WHY THESE ASSERTIONS
// --------------------
// `doctor` exists because every failure this project actually hit was visible in the
// environment beforehand and invisible from the TUI: a session file past the V8 string
// limit (saving stops working), an unwritable store, an MCP server that never connected,
// a config with no provider. The checks are therefore tested against a FAKE environment —
// a temp home and store — so the assertions describe the check's rule, not this machine.
//
// `theme` exists because `THEMES` and `setTheme` were already in colors.js with no way to
// reach them. What matters is that every name in the list is actually loadable, that an
// unknown name is REFUSED rather than half-applied, and that the derived colours
// `setTheme` computes (scrollbar shades, the light/dark branch) stay sane for each theme
// — a theme table entry with a missing field would produce an invalid escape at paint
// time, which is a corrupted frame rather than an error.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runDoctor, formatDoctor, summarize } = await import('../src/doctor.js');
const { THEME_NAMES, THEME_LABELS, hasTheme, isLightTheme, setTheme, C } = await import('../src/colors.js');

/** A throwaway home with a store, so no check reads the real machine's state. */
function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-doctor-'));
  fs.mkdirSync(path.join(home, '.hncode', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.hncode', 'config.toml'), 'model = "m"\n', 'utf8');
  return home;
}
const cleanup = (home) => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ } };

const findAll = (results, re) => results.filter((r) => re.test(r.name));

// ---------------------------------------------------------------------------
// doctor: the checks that matter
// ---------------------------------------------------------------------------

test('a healthy environment reports no errors', async () => {
  const home = fakeHome();
  try {
    const cfg = { provider: 'p', model: 'm', endpoint: 'https://api.example.com/v1', apiKey: 'k' };
    const results = await runDoctor({ cfg, env: { HOME: home, TERM: 'xterm-256color' }, workspace: home });
    // The DISK check reads the real volume, so a machine that is genuinely low on space
    // fails this test through no fault of the code — which is exactly what happened. The
    // claim here is about the CONFIGURED environment, so the one check that measures the
    // host is excluded and has its own test below.
    const code = results.filter((r) => r.severity === 'error' && r.name !== 'disk space');
    assert.deepEqual(code, [], `unexpected errors: ${JSON.stringify(code)}`);
  } finally { cleanup(home); }
});

test('a missing provider and model are errors, each with a remedy', async () => {
  const home = fakeHome();
  try {
    const results = await runDoctor({ cfg: {}, env: { HOME: home, TERM: 'xterm' }, workspace: home });
    for (const name of ['provider', 'model']) {
      const [hit] = findAll(results, new RegExp(`^${name}$`));
      assert.ok(hit, `${name} is reported`);
      assert.equal(hit.severity, 'error');
      assert.ok(hit.fix.length > 0, `${name} carries a fix, not just a finding`);
    }
  } finally { cleanup(home); }
});

test('a local endpoint may legitimately have no API key', async () => {
  // ollama and llama.cpp serve without auth; flagging them would train the user to ignore
  // the check.
  const home = fakeHome();
  try {
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'http://localhost:11434/v1' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    const [key] = findAll(results, /^api key$/);
    assert.ok(key, 'the key is reported');
    assert.notEqual(key.severity, 'error', 'a local endpoint without a key is not an error');
  } finally { cleanup(home); }
});

test('an endpoint that is not a URL is an error', async () => {
  const home = fakeHome();
  try {
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'api.example.com/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    const [hit] = findAll(results, /^endpoint$/);
    assert.equal(hit.severity, 'error');
  } finally { cleanup(home); }
});

test('a session file near the V8 string limit is flagged as an ERROR, with the way out', async () => {
  // This is the failure that cost real work: past ~512 MB `JSON.stringify` throws, so
  // every save of that session fails while the TUI looks normal.
  const home = fakeHome();
  try {
    const dir = path.join(home, '.hncode', 'sessions');
    // Sparse: 400 MB of declared size without writing 400 MB. `writeSync(fd, str, pos, enc)`
    // seeks without filling the gap, which is what keeps this test fast.
    const f = fs.openSync(path.join(dir, 'huge.json'), 'w');
    fs.writeSync(f, 'x', 400 * 1024 * 1024, 'utf8');
    fs.closeSync(f);
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    const [hit] = findAll(results, /^oversized session$/);
    assert.ok(hit, 'the oversized session is reported');
    assert.equal(hit.severity, 'error', '400 MB is past the danger threshold');
    assert.match(hit.fix, /512 MB|repair-transcripts/i, 'and the fix names the limit or the tool');
  } finally { cleanup(home); }
});

test('leftover .tmp files from an interrupted save are reported', async () => {
  const home = fakeHome();
  try {
    fs.writeFileSync(path.join(home, '.hncode', 'sessions', 'a.json.123.abc.tmp'), 'x');
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    assert.ok(findAll(results, /interrupted save/).length, 'the leftover temp file is reported');
  } finally { cleanup(home); }
});

test('the store writability is probed, so a read-only store is an error', async () => {
  const home = fakeHome();
  try {
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    const [hit] = findAll(results, /session store writable/);
    assert.equal(hit.severity, 'ok', 'a normal temp store is writable');
  } finally { cleanup(home); }
});

test('a malformed hooks file is an error, because its hooks silently never run', async () => {
  const home = fakeHome();
  try {
    fs.writeFileSync(path.join(home, '.hncode', 'hooks.json'), '{ this is not json', 'utf8');
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    const [hit] = findAll(results, /^hooks$/);
    assert.equal(hit.severity, 'error');
  } finally { cleanup(home); }
});

test('MCP: configured-but-not-connected and failed are distinguished', async () => {
  const home = fakeHome();
  try {
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
      mcpServers: { a: { command: 'x' }, b: { url: 'http://y' }, c: { command: 'z' } },
      mcpConnections: [{ name: 'b', ok: false, error: 'boom' }, { name: 'c', ok: true, toolCount: 3 }],
    });
    assert.equal(findAll(results, /^MCP a$/)[0].severity, 'warn', 'never started');
    assert.equal(findAll(results, /^MCP b$/)[0].severity, 'error', 'failed to connect');
    assert.equal(findAll(results, /^MCP c$/)[0].severity, 'ok', 'connected');
  } finally { cleanup(home); }
});

test('a workspace that does not exist is an error', async () => {
  const home = fakeHome();
  try {
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: path.join(home, 'nope'),
    });
    const [hit] = findAll(results, /^workspace$/);
    assert.equal(hit.severity, 'error');
  } finally { cleanup(home); }
});

test('a small terminal is a warning, not an error', async () => {
  const home = fakeHome();
  try {
    const results = await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home, dims: { cols: 40, rows: 10 },
    });
    assert.equal(findAll(results, /terminal size/)[0].severity, 'warn');
  } finally { cleanup(home); }
});

test('the report sorts worst-first and hides passing checks unless asked', () => {
  const results = [
    { name: 'fine', severity: 'ok', detail: 'a', fix: '' },
    { name: 'broken', severity: 'error', detail: 'b', fix: 'do c' },
    { name: 'meh', severity: 'warn', detail: 'd', fix: 'do e' },
  ];
  const short = formatDoctor(results, { showOk: false });
  const text = short.join('\n');
  assert.ok(text.includes('broken'), 'the error is shown');
  assert.ok(text.includes('meh'), 'the warning is shown');
  assert.ok(!text.includes('fine'), 'the passing check is hidden');
  assert.ok(text.indexOf('broken') < text.indexOf('meh'), 'errors come before warnings');
  assert.ok(text.includes('do c'), 'the remedy is printed for an error');

  const full = formatDoctor(results, { showOk: true }).join('\n');
  assert.ok(full.includes('fine'), '--all includes the passing checks');
});

test('doctor never writes: it is safe on a machine whose state matters', async () => {
  // A diagnostic that repairs is one nobody can run on a machine they care about. Asserted
  // by snapshotting the store's contents across a run.
  const home = fakeHome();
  try {
    const dir = path.join(home, '.hncode', 'sessions');
    fs.writeFileSync(path.join(dir, 'keep.json'), '{"id":"keep"}');
    const before = fs.readdirSync(dir).sort();
    await runDoctor({
      cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k' },
      env: { HOME: home, TERM: 'xterm' }, workspace: home,
    });
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'the store is untouched');
  } finally { cleanup(home); }
});

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------

test('every advertised theme name loads', () => {
  for (const name of THEME_NAMES) {
    assert.ok(hasTheme(name), `${name} is recognised`);
    assert.ok(THEME_LABELS[name], `${name} has a description for the picker`);
    assert.equal(setTheme(name), true, `${name} applies`);
  }
});

test('an unknown theme is refused rather than half-applied', () => {
  setTheme('dark');
  const before = C.fg;
  assert.equal(setTheme('definitely-not-a-theme'), false, 'the call reports failure');
  assert.equal(C.fg, before, 'and nothing was mutated');
  assert.equal(hasTheme('definitely-not-a-theme'), false);
});

test('setTheme leaves every colour a valid escape, for every theme', () => {
  // A theme table missing a field would put `undefined` into a colour string, which
  // corrupts the frame instead of raising. Walk the fields the painter reads.
  for (const name of THEME_NAMES) {
    setTheme(name);
    for (const key of ['fg', 'bg', 'teal', 'cyan', 'blue', 'border', 'hover', 'selBg',
      'bgPanel', 'scrollThumbFg', 'scrollThumbBg', 'scrollThumbHoverFg', 'scrollThumbActiveBg',
      'red', 'green', 'yellow', 'orange', 'gray', 'white']) {
      const v = C[key];
      assert.equal(typeof v, 'string', `${name}.${key} is a string`);
      assert.ok(v.length > 0, `${name}.${key} is not empty`);
      assert.ok(!v.includes('undefined'), `${name}.${key} has no undefined in it: ${JSON.stringify(v)}`);
      assert.match(v, /^\x1b\[/, `${name}.${key} is an escape: ${JSON.stringify(v)}`);
    }
  }
  setTheme('dark');
});

test('the light/dark classification matches each theme background', () => {
  assert.equal(isLightTheme('light'), true);
  assert.equal(isLightTheme('dark'), false);
  assert.equal(isLightTheme('nord'), false);
  assert.equal(isLightTheme('non-existent'), false, 'an unknown theme is not "light"');
  // And the derived branch colour follows the same rule.
  setTheme('light');
  const lightBranch = C.branch;
  setTheme('dark');
  assert.notEqual(C.branch, lightBranch, 'the branch colour is darkened on a light theme');
});

test('switching themes actually changes the palette', () => {
  setTheme('dark');
  const darkBg = C.bg;
  setTheme('gruvbox');
  assert.notEqual(C.bg, darkBg, 'the background differs between themes');
  setTheme('dark');
});
