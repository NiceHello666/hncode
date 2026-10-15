// SessionCore: the interface a front end needs to CONTINUE a session, not just read one.
//
// WHY
// ---
// A session used to be a pile of closure variables inside startTUI, so only the process that drew
// it could run it. The web UI had to proxy to a live terminal, and a session whose terminal had
// closed was readable but not resumable — which is the difference between a viewer and a client.
//
// The core is not a rewrite of runAgent (1020 lines woven through the paint path). It is the
// INTERFACE: submit, dispatch, interrupt, queue, plus the lifecycle around them. These assertions
// pin that interface, and they run with no terminal, which is the whole point.
import assert from 'node:assert/strict';
import test from 'node:test';

const { SessionCore } = await import('../src/session-core.js');
const { HEADLESS_VIEW } = await import('../src/session-view.js');

/** A core over a state object, with recording stubs for the host callbacks. */
function makeCore(over = {}) {
  const calls = { runAgent: [], dispatch: [], quit: 0 };
  const state = { chat: [], queued: [], running: false, ...(over.state || {}) };
  const core = new SessionCore({
    state,
    cfg: { model: 'm' },
    session: over.session || { id: 's1' },
    view: over.view || HEADLESS_VIEW,
  });
  core.bind({
    runAgent: async (text, opts, view) => { calls.runAgent.push({ text, opts, view }); return 'ran'; },
    dispatch: async (...args) => { calls.dispatch.push(args); return 'dispatched'; },
    quit: () => { calls.quit++; },
  });
  return { core, state, calls };
}

test('submit runs a turn, and hands the view through', () => {
  // The view must reach runAgent, or a headless run would try to paint through the TUI's painter
  // — which in the daemon is a function that does not exist.
  const { core, calls } = makeCore();
  return core.submit('hello').then((r) => {
    assert.equal(r, 'ran');
    assert.equal(calls.runAgent.length, 1);
    assert.equal(calls.runAgent[0].text, 'hello');
    assert.equal(calls.runAgent[0].view, HEADLESS_VIEW, 'the core passes ITS view, not a default');
  });
});

test('submit refuses an empty message rather than starting an empty turn', async () => {
  const { core, calls } = makeCore();
  await assert.rejects(() => core.submit('   '), /empty message/);
  await assert.rejects(() => core.submit(null), /empty message/);
  assert.equal(calls.runAgent.length, 0);
});

test('submit says so when the host never bound a runner', async () => {
  // A core built without `bind` is a programming error, and the message has to name it rather
  // than fail with "undefined is not a function" from three frames down.
  const core = new SessionCore({ state: { chat: [], queued: [] }, cfg: {}, session: {} });
  await assert.rejects(() => core.submit('x'), /no agent runner/);
});

test('dispatch accepts a bare name or a whole line', async () => {
  const { core, calls } = makeCore();
  await core.dispatch('model', 'gpt');
  await core.dispatch('/plan on');
  assert.equal(calls.dispatch.length, 2);
  assert.equal(calls.dispatch[0][0], 'model');
  assert.equal(calls.dispatch[0][1], 'gpt');
  assert.equal(calls.dispatch[1][0], '/plan', 'the slash survives — the dispatcher owns that');
  assert.equal(calls.dispatch[1][1], 'on');
});

test('dispatch passes the live state and config, not copies', async () => {
  // A command mutates `state` and `cfg` — `/mode`, `/model`, `/focus` all do. Copies would make
  // every command appear to work and take effect nowhere.
  const { core, state, calls } = makeCore();
  await core.dispatch('/focus', 'on');
  assert.equal(calls.dispatch[0][2], state);
  assert.equal(calls.dispatch[0][3], core.cfg);
});

test('a command that asks to quit does', async () => {
  const { core, state, calls } = makeCore();
  await core.dispatch('/exit');
  assert.equal(calls.quit, 0, 'not yet — the flag is what decides');

  state._quit = true;
  await core.dispatch('/exit');
  assert.equal(calls.quit, 1);
});

test('interrupt reaches the running agent, and refuses when there is none', async () => {
  const { core, state } = makeCore();
  await assert.rejects(() => core.interrupt(), /nothing is running/);

  let stopped = 0;
  state.agent = { interrupt: () => { stopped++; } };
  await core.interrupt();
  assert.equal(stopped, 1);
});

test('running reflects the state the turn loop writes', () => {
  const { core, state } = makeCore();
  assert.equal(core.running, false);
  state.running = true;
  assert.equal(core.running, true);
});

test('the queue reads as a copy, so a drain cannot shift it under a reader', () => {
  const { core, state } = makeCore({ state: { queued: ['a', 'b'] } });
  const q = core.queued;
  assert.deepEqual(q, ['a', 'b']);
  state.queued.shift();
  assert.deepEqual(q, ['a', 'b'], 'the snapshot did not change');
  assert.deepEqual(core.queued, ['b'], 'but the live queue did');
});

test('enqueue pushes and announces, clearQueue empties', () => {
  const pushed = [];
  const view = { ...HEADLESS_VIEW, pubStatusField: (f, v) => pushed.push([f, v]) };
  const { core, state } = makeCore({ view });

  assert.equal(core.enqueue('next'), true);
  assert.deepEqual(state.queued, ['next']);
  assert.deepEqual(pushed, [['queued', ['next']]], 'the browser is told immediately');

  assert.equal(core.enqueue('  '), false, 'blank is not queued');
  core.clearQueue();
  assert.deepEqual(state.queued, []);
  assert.deepEqual(pushed[1], ['queued', []]);
});

test('events reach every subscriber, and one bad subscriber is contained', () => {
  const { core } = makeCore();
  const seen = [];
  const off = core.onEvent((e) => seen.push(e));
  core.onEvent(() => { throw new Error('this listener is broken'); });

  assert.doesNotThrow(() => core.emit({ type: 'delta' }), 'a throwing listener must not break the turn');
  assert.deepEqual(seen, [{ type: 'delta' }]);

  off();
  core.emit({ type: 'after' });
  assert.equal(seen.length, 1, 'unsubscribing stops delivery');
});

test('the core holds the state object rather than copying it', () => {
  // The 74 references inside runAgent and every reader in composeFrame reach the SAME object.
  // Copying would leave the renderer looking at a stale transcript.
  const state = { chat: [{ role: 'user', text: 'x' }], queued: [] };
  const core = new SessionCore({ state, cfg: {}, session: {} });
  assert.equal(core.state, state);
  state.chat.push({ role: 'assistant', text: 'y' });
  assert.equal(core.state.chat.length, 2);
});
