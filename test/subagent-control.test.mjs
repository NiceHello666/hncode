// Controlling running subagents: list, message, interrupt, close.
//
// WHY THESE ASSERTIONS
// --------------------
// The registry's whole value is that its contents ARE the set of agents that can still be
// acted on. If a settled run lingers, the list lies and a "close" appears to fail; if a
// live run is missing, there is no way to reach it at all. So the tests are about the
// LIFECYCLE — register, act, end — and about addressing an agent by whichever id the
// caller happens to hold, since a caller with an agent id and a caller with a task id both
// reasonably expect to reach the same run.
//
// The handles are stubs here on purpose: what matters is that the control path calls
// exactly one method with exactly the given text, not how a real Agent implements `steer`.
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  registerRun, endRun, listRuns, findRun, sendToRun, interruptRun,
  interruptAll, closeRun, describeRuns,
} = await import('../src/subagent-control.js');

/** A handle that records what was done to it. */
function fakeAgent(over = {}) {
  const calls = [];
  const handle = {
    agentId: over.agentId || 'agent-x',
    taskId: over.taskId || '',
    type: over.type || 'coder',
    description: over.description || 'do a thing',
    steer: (text) => { calls.push({ m: 'steer', text }); if (over.steerThrows) throw new Error('steer failed'); },
    interrupt: () => { calls.push({ m: 'interrupt' }); if (over.interruptThrows) throw new Error('interrupt failed'); },
  };
  return { handle, calls };
}

// Every test ends its own runs, so the registry is empty at the start of each.
test.beforeEach(() => { for (const r of listRuns()) endRun(r.runId); });

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test('the registry holds exactly the runs that are live', () => {
  const a = fakeAgent({ agentId: 'agent-a' });
  const b = fakeAgent({ agentId: 'agent-b' });
  const ida = registerRun(a.handle);
  const idb = registerRun(b.handle);
  assert.equal(listRuns().length, 2, 'both are listed');
  endRun(ida);
  assert.equal(listRuns().length, 1, 'the ended one is gone');
  assert.equal(findRun(ida), null, 'and unreachable');
  assert.ok(findRun(idb), 'the other is untouched');
});

test('run ids are unique even within one millisecond', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const { handle } = fakeAgent();
    ids.add(registerRun(handle));
  }
  assert.equal(ids.size, 200, 'no id was reused');
  for (const r of listRuns()) endRun(r.runId);
});

test('an unknown reference resolves to nothing rather than throwing', () => {
  assert.equal(findRun('nope'), null);
  assert.equal(findRun(''), null);
  assert.equal(findRun(null), null);
  assert.equal(findRun(undefined), null);
});

// ---------------------------------------------------------------------------
// addressing: whichever id the caller holds
// ---------------------------------------------------------------------------

test('a run is reachable by run id, agent id, or task id', () => {
  const { handle } = fakeAgent({ agentId: 'agent-7', taskId: 'task-9' });
  const runId = registerRun(handle);
  assert.equal(findRun(runId).runId, runId, 'by run id');
  assert.equal(findRun('agent-7').runId, runId, 'by agent id');
  assert.equal(findRun('task-9').runId, runId, 'by task id');
});

test('the agent id wins over a task id that collides with another run’s agent id', () => {
  // Contrived but the resolution order has to be defined: an exact run id first, then the
  // scan. This pins the order so a future change cannot silently swap it.
  const a = fakeAgent({ agentId: 'shared', taskId: '' });
  const ida = registerRun(a.handle);
  const b = fakeAgent({ agentId: 'other', taskId: 'shared' });
  const idb = registerRun(b.handle);
  assert.equal(findRun('shared').runId, ida, 'the agent-id match comes first');
  assert.equal(findRun(idb).runId, idb, 'but an exact run id still wins');
});

// ---------------------------------------------------------------------------
// the three operations
// ---------------------------------------------------------------------------

test('a message reaches the run through steer, exactly once', () => {
  const a = fakeAgent({ agentId: 'agent-a' });
  registerRun(a.handle);
  const r = sendToRun('agent-a', 'skip the tests');
  assert.equal(r.ok, true);
  assert.deepEqual(a.calls, [{ m: 'steer', text: 'skip the tests' }], 'steer was called with the text');
  assert.match(r.message, /skip the tests/, 'the report quotes what was sent');
});

test('an empty message is refused without touching the run', () => {
  const a = fakeAgent();
  registerRun(a.handle);
  assert.equal(sendToRun('agent-x', '   ').ok, false);
  assert.equal(sendToRun('agent-x', '').ok, false);
  assert.equal(a.calls.length, 0, 'steer was never called');
});

test('messaging an unknown or finished run reports rather than throwing', () => {
  assert.equal(sendToRun('ghost', 'hello').ok, false);
  const a = fakeAgent({ agentId: 'gone' });
  const id = registerRun(a.handle);
  endRun(id);
  const r = sendToRun('gone', 'hello');
  assert.equal(r.ok, false);
  assert.match(r.message, /No running subagent/);
});

test('a steer that throws is reported, not propagated', () => {
  // The control path runs from a tool call or a keypress; a throw here would abort the
  // caller for a reason that belongs to the subagent.
  const a = fakeAgent({ agentId: 'grumpy', steerThrows: true });
  registerRun(a.handle);
  const r = sendToRun('grumpy', 'hello');
  assert.equal(r.ok, false);
  assert.match(r.message, /steer failed/);
});

test('interrupt reaches one run and leaves the others alone', () => {
  const a = fakeAgent({ agentId: 'agent-a' });
  const b = fakeAgent({ agentId: 'agent-b' });
  registerRun(a.handle);
  registerRun(b.handle);
  const r = interruptRun('agent-a');
  assert.equal(r.ok, true);
  assert.deepEqual(a.calls, [{ m: 'interrupt' }]);
  assert.equal(b.calls.length, 0, 'the other run was not touched');
});

test('interruptAll stops every live run', () => {
  const handles = ['a', 'b', 'c'].map((n) => {
    const f = fakeAgent({ agentId: `agent-${n}` });
    registerRun(f.handle);
    return f;
  });
  const r = interruptAll();
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  for (const h of handles) assert.deepEqual(h.calls, [{ m: 'interrupt' }]);
});

test('interruptAll on nothing reports that, rather than claiming success', () => {
  const r = interruptAll();
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
});

test('close interrupts AND removes the run at once', () => {
  // The reason close exists: an interrupted run is removed when its await unwinds, so a
  // listing straight afterwards would still show it and the interrupt would look ignored.
  const a = fakeAgent({ agentId: 'agent-a' });
  const id = registerRun(a.handle);
  const r = closeRun('agent-a');
  assert.equal(r.ok, true);
  assert.deepEqual(a.calls, [{ m: 'interrupt' }], 'the run was stopped');
  assert.equal(listRuns().length, 0, 'and removed immediately');
  assert.equal(findRun(id), null, 'so it cannot be listed or addressed');
  assert.match(r.message, /resume/, 'the report says the conversation survives');
});

test('closing an unknown run reports rather than throwing', () => {
  const r = closeRun('ghost');
  assert.equal(r.ok, false);
  assert.match(r.message, /No running subagent/);
});

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

test('the listing reports each run with its id, type and age', () => {
  const a = fakeAgent({ agentId: 'agent-a', type: 'explore', description: 'survey the repo' });
  registerRun(a.handle);
  const text = describeRuns().join('\n');
  assert.match(text, /Running subagents \(1\)/);
  assert.match(text, /explore/);
  assert.match(text, /agent-a/);
  assert.match(text, /survey the repo/);
});

test('the listing shows the last message sent to a run', () => {
  const a = fakeAgent({ agentId: 'agent-a' });
  registerRun(a.handle);
  sendToRun('agent-a', 'focus on the parser');
  const text = describeRuns().join('\n');
  assert.match(text, /last message: focus on the parser/);
});

test('an empty listing says so explicitly', () => {
  assert.deepEqual(describeRuns(), ['No subagent is running.']);
});
