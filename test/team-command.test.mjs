// `/team` — the team features a user drives from the keyboard.
//
// WHY THESE ASSERTIONS
// --------------------
// Creating a team is a decision about how work will be done, and it belongs to the user. The model
// has the same operations as tools; this command is what keeps the choice from having to go through
// a model turn — which would mean the model picking its own teammates' models.
//
// Two things are worth pinning, and both have silent failure modes:
//
//   * the lead's team must be ONE value. tools/team.js and the command both need it; two copies
//     would let `/team create` succeed while `SendMessage` reported no team.
//   * adding a member without naming a model must ASK. A silent default would give every member
//     the same model, which is the one outcome the per-member choice exists to avoid.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Run `fn` with HNCODE_HOME pointed at a throwaway directory. */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-teamcmd-'));
  const prev = process.env.HNCODE_HOME;
  process.env.HNCODE_HOME = home;
  // The lead's team is module-level by design, so it outlives a test. Clearing it here is what
  // keeps "nothing was created yet" true for the next one.
  coreMod.clearLeadTeam();
  try { return await fn(); } finally {
    coreMod.clearLeadTeam();
    if (prev === undefined) delete process.env.HNCODE_HOME;
    else process.env.HNCODE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const { dispatch, makeState } = await import('../src/tui.js');
const teamMod = await import('../src/team/team.js');
const store = await import('../src/team/store.js');
const coreMod = await import('../src/session-core.js');

/** A host that records what the command said, plus a dispatcher bound to it. */
function harness() {
  const said = [];
  const host = {
    // addChat takes a message OBJECT — that is how the TUI calls it, and a (role, text) signature
    // records nothing usable.
    addChat: (msg) => said.push(String((msg && (msg.text != null ? msg.text : msg.content)) || '')),
    notice: (t) => said.push(String(t)),
    openPicker: (p) => { host._picker = p; },
    openForm: () => {}, openEditor: () => {},
    sendPrompt: () => {}, quit: () => {}, saveSession: () => {},
    openTasksPanel: () => {}, openRegistryBrowser: () => {}, openPanel: () => {},
  };

  const cfg = {
    provider: 'p', model: 'session-model', endpoint: 'x', apiKey: 'k',
    workspace: process.cwd(), subagentModel: 'sub-model',
    raw: {
      providers: { provA: {} },
      models: { 'model-a': { provider: 'provA' }, 'model-b': { provider: 'provA' } },
    },
  };
  const session = { id: 'p', messages: [], transcript: [] };
  const state = makeState({ cfg, session, opts: {} });
  state.cfg = cfg;
  state.chat = [];
  const stdout = { getWindowSize: () => [100, 30], write: () => true, isTTY: true, columns: 100, rows: 30 };

  return {
    host, cfg, session, state, said,
    run: (arg) => dispatch('team', arg, state, cfg, session, host, async () => {}, stdout),
    reset: () => { said.length = 0; host._picker = null; },
  };
}

test('create makes a team and records it as the lead\'s', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');

    assert.match(h.said.join(' '), /Team "demo" created/);
    assert.equal(coreMod.leadTeam(), 'demo', 'the lead knows which team it is on');

    // The first member added becomes the lead, which is when the roster first has one.
    await h.run('add alice model-a');
    assert.match(teamMod.readRoster('demo'), /alice/);
    assert.equal(teamMod.leadOf('demo'), 'alice');
  });
});

test('a team name is required, and the refusal says how', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create');
    assert.match(h.said.join(' '), /Usage: \/team create/);
    assert.equal(coreMod.leadTeam(), null, 'nothing was created');
  });
});

test('adding a member without a model ASKS which one', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');
    h.reset();

    await h.run('add alice');
    assert.ok(h.host._picker, 'a picker opened');
    assert.equal(h.host._picker.title, 'Model for alice');

    const labels = h.host._picker.items.map((i) => i.label);
    assert.ok(labels.includes('default'), 'offers to follow the session');
    assert.ok(labels.includes('model-a') && labels.includes('model-b'), 'and lists the configured models');

    const dflt = h.host._picker.items[0];
    assert.match(dflt.sub, /sub-model/, 'and says which model "default" means');

    h.host._picker.onPick(h.host._picker.items.find((i) => i.label === 'model-a'));
    const m = store.readTeamFile('demo').members.find((x) => x.name === 'alice');
    assert.equal(m.model, 'model-a', 'the member got the chosen model');
  });
});

test('a model on the command line skips the picker', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');
    h.reset();

    await h.run('add bob model-b');
    assert.ok(!h.host._picker, 'no picker');
    assert.equal(store.readTeamFile('demo').members.find((x) => x.name === 'bob').model, 'model-b');
    assert.match(h.said.join(' '), /model-b/, 'and the confirmation names it');
  });
});

test('the default row leaves the member on the session\'s model', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');
    h.reset();
    await h.run('add carol');
    h.host._picker.onPick(h.host._picker.items[0]);   // "default"

    const m = store.readTeamFile('demo').members.find((x) => x.name === 'carol');
    assert.equal(m.model, '', 'no override stored');
    assert.match(h.said.join(' '), /sub-model|session/, 'and the confirmation explains what it follows');
  });
});

test('list prints the roster', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');
    await h.run('add alice model-a');
    h.reset();

    await h.run('list');
    const text = h.said.join('\n');
    assert.match(text, /alice/, 'the member who joined first');
    assert.match(text, /lead/, 'is shown as the lead');
  });
});

test('the bare command opens a menu over the four actions', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');
    h.reset();

    await h.run('');
    assert.ok(h.host._picker, 'a menu opened');
    const acts = h.host._picker.items.map((i) => i.action);
    for (const a of ['create', 'add', 'list', 'delete']) {
      assert.ok(acts.includes(a), `the menu offers ${a}`);
    }
  });
});

test('delete dissolves the team and clears the lead', async () => {
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');
    await h.run('add alice model-a');
    h.reset();

    await h.run('delete');
    assert.equal(store.readTeamFile('demo'), null, 'the roster is gone');
    assert.equal(coreMod.leadTeam(), null, 'and the lead forgot it');
    assert.match(h.said.join(' '), /dissolved/);
  });
});

test('the lead\'s team is ONE value, shared with the tools', async () => {
  // Two copies is the failure this guards: `/team create` would set the command's and
  // `SendMessage` would read the tool's, telling the model there is no team.
  await withHome(async () => {
    const h = harness();
    await h.run('create demo');

    const tools = await import('../src/tools/team.js');
    assert.equal(coreMod.leadTeam(), 'demo');
    assert.equal(tools.leadTeam(), 'demo', 'the tool namespace reads the same value');

    await h.run('delete');
    assert.equal(tools.leadTeam(), null, 'and clearing it clears both');
  });
});

test('the source has no second copy of the lead\'s team', () => {
  // A `let leadTeamName` in tools/team.js would shadow the shared one the moment the two drift.
  const tools = fs.readFileSync(new URL('../src/tools/team.js', import.meta.url), 'utf8');
  assert.doesNotMatch(tools, /^let leadTeamName\b/m, 'tools/team.js must not keep its own');
  assert.match(tools, /sharedLeadTeam/, 'it reads the shared one');
});
