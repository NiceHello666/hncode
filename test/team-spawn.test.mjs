// The team's two show-stoppers, both of which made it look like the feature did not exist.
//
// WHY THIS FILE EXISTS
// --------------------
// "I made a team and it never answers me." Two independent defects produced exactly that, and
// neither was visible from the roster — the team looked created and the member looked idle.
//
//   1. `/team add NAME` called `addMember` itself and THEN called the spawner, which called
//      `addMember` a second time. For the team's FIRST member that name IS `leadName`, which
//      `addMember` refuses (`"…" is the lead of this team`). So the spawn returned `failed` and
//      the member stayed a roster row with `taskId: null` — no agent, nothing reading its inbox.
//
//   2. `SendMessage` (and the other nine team tools) return `{ content }`, while every other tool
//      returns a string. That object was pushed into the `tool` message verbatim, and the next
//      request was rejected with `missing type field in content item at index 0`. So the agent's
//      first message DID arrive and the conversation died one message later — a team that says
//      hello once and never speaks again.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-teamspawn-'));
process.env.HNCODE_HOME = home;
process.env.USERPROFILE = home;
process.env.HOME = home;

const team = await import('../src/team/team.js');
const spawn = await import('../src/team/spawn.js');
const store = await import('../src/team/store.js');
const mbox = await import('../src/team/mailbox.js');

// Every test here STARTS a real teammate, and a running teammate holds the event loop open — so
// the suite would report all-pass and then exit non-zero, which reads as failure. Stopping them
// is part of the test, not tidiness.
test.after(() => {
  for (const t of ['firstmember', 'secondmember', 'reuse', 'sendreaches']) {
    try { spawn.stopTeam(t); } catch { /* never started */ }
  }
});

/** The exact sequence `/team create` + `/team add` performs. */
function addViaCommand(teamName, memberName) {
  team.createTeam({ teamName, cwd: process.cwd() });
  const added = team.addMember(teamName, { name: memberName, cwd: process.cwd() });
  assert.ok(added.ok !== false, `addMember: ${JSON.stringify(added)}`);
  return spawn.spawnMany(teamName, [{ name: memberName, model: '', agentType: 'general' }], {
    cfg: { model: 'unused-in-this-test', workspace: process.cwd() },
    cwd: process.cwd(),
    tasks: {},
    onEvent: () => {},
  });
}

test('adding the FIRST member starts an agent instead of refusing it', () => {
  // The first member added becomes the lead, so it is exactly the name the second `addMember`
  // used to reject. This is the case every new team goes through.
  const res = addViaCommand('firstmember', 'NiceLeader');
  assert.deepEqual(res.failed, [], `spawn must not fail: ${JSON.stringify(res.failed)}`);
  assert.deepEqual(res.started.map((s) => s.name), ['NiceLeader']);

  // `taskId` is the proof an agent was attached. A row with `taskId: null` is a name on paper.
  const member = store.readTeamFile('firstmember').members.find((m) => m.name === 'NiceLeader');
  assert.ok(member.taskId, 'the roster records the task that ties the agent to the member');
  assert.equal(spawn.isRunning('firstmember', 'NiceLeader'), true, 'and the agent is running');
});

test('a later member starts the same way', () => {
  team.createTeam({ teamName: 'secondmember', cwd: process.cwd() });
  team.addMember('secondmember', { name: 'Lead', cwd: process.cwd() });
  const res = spawn.spawnMany('secondmember', [{ name: 'Helper', model: '', agentType: 'general' }], {
    cfg: { model: 'unused', workspace: process.cwd() }, cwd: process.cwd(), tasks: {}, onEvent: () => {},
  });
  assert.deepEqual(res.failed, [], 'a non-lead member spawns too');
  assert.ok(store.readTeamFile('secondmember').members.find((m) => m.name === 'Helper').taskId);
});

test('spawning a name already on the roster reuses the entry rather than failing', () => {
  // The spawner is reachable from more than one caller, and a caller that has already joined the
  // member must not be the reason it never starts. `/team add` is exactly that caller: it calls
  // `addMember`, then spawns. The spawner must therefore tolerate a name that is already there —
  // which for the FIRST member it always is, and that name is also the one `addMember` refuses.
  team.createTeam({ teamName: 'reuse', cwd: process.cwd() });
  const joined = team.addMember('reuse', { name: 'Worker', cwd: process.cwd() });
  assert.ok(joined.ok !== false, 'the member joins first, as /team add does');

  const res = spawn.spawnMany('reuse', [{ name: 'Worker', model: '' }], {
    cfg: { model: 'unused', workspace: process.cwd() }, cwd: process.cwd(), tasks: {}, onEvent: () => {},
  });
  assert.deepEqual(res.failed, [], `spawning a joined member must not fail: ${JSON.stringify(res.failed)}`);
  assert.deepEqual(res.started.map((s) => s.name), ['Worker']);
  assert.equal(store.readTeamFile('reuse').members.filter((m) => m.name === 'Worker').length, 1,
    'and there is still exactly one member of that name');
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the tool result must be TEXT
// ---------------------------------------------------------------------------

test('a tool result object becomes the string the model can be sent', () => {
  // The shape the team tools actually return. `{ content }` and `{ error }` are the two forms;
  // anything else structured is stringified rather than dropped.
  const src = fs.readFileSync(path.resolve('src/agent.js'), 'utf8');
  const at = src.indexOf('function toolResultText(');
  assert.ok(at > 0, 'the normaliser exists');
  const body = src.slice(at, src.indexOf('\n}', at));

  // The rules, asserted from the source so a rewrite cannot silently lose them.
  assert.match(body, /typeof value === 'string'/, 'a string passes through');
  assert.match(body, /value\.content/, 'a `{ content }` result uses its content');
  assert.match(body, /value\.error/, 'a `{ error }` result uses its error');
  assert.match(body, /Array\.isArray\(value\.media\)/, 'and a media result is preserved, not flattened');
});

test('the teammate tool table returns the objects that normaliser exists for', () => {
  // The regression's premise: if these tools ever start returning plain strings the normaliser
  // becomes dead code, and if a NEW tool returns an object the normaliser is what saves it.
  const teamTools = fs.readFileSync(path.resolve('src/tools/team.js'), 'utf8');
  assert.ok(/return \{ content:/.test(teamTools),
    'the team tools still return `{ content }` — the shape that reached the model verbatim');
});

test('an agent that calls SendMessage reaches the lead', async () => {
  // End to end through the tool, inside a teammate's async identity, which is how the identity
  // the tool reads is established.
  const { SendMessageSpec } = await import('../src/tools/team.js');
  const { runAs, makeIdentity } = await import('../src/team/context.js');

  const teamName = 'sendreaches';
  team.createTeam({ teamName, cwd: process.cwd() });
  team.addMember(teamName, { name: 'Lead', cwd: process.cwd() });
  team.addMember(teamName, { name: 'Helper', cwd: process.cwd() });

  const identity = makeIdentity({ name: 'Helper', teamName, color: 'x', agentType: 'general', model: '' });
  const out = await runAs(identity, () => SendMessageSpec.execute(
    { to: 'Lead', message: 'no task yet, what should I work on?' }, {},
  ));

  // The object the agent must not hand to the provider unchanged.
  assert.equal(typeof out, 'object');
  assert.equal(typeof out.content, 'string', 'the tool reports success as text');

  const box = mbox.readMailbox(teamName, 'Lead');
  assert.equal(box.length, 1, 'and the message is in the lead\'s inbox');
  assert.equal(box[0].from, 'Helper');
  assert.match(box[0].text, /what should I work on/);
});
test('an agent replying to the `team-lead` alias reaches the USER', () => {
  // The reply that never arrived. The user's own messages are stamped `from: team-lead`, so a
  // teammate answering one addresses `to: 'team-lead'` — and the user's session is not a roster
  // member, it reads the box NAMED `team-lead` (plus the roster lead's).
  //
  // Two ways this broke: the alias was refused as `no member "team-lead"`, and then, once it was
  // mapped to `leadOf(team)`, it resolved back to the SENDING agent for a team whose only agent
  // is the lead — `Error: that is you`, so the report the agent had just written was dropped.
  return import('../src/tools/team.js').then(async ({ SendMessageSpec }) => {
    const { runAs, makeIdentity } = await import('../src/team/context.js');

    const teamName = 'leadalias';
    team.createTeam({ teamName, cwd: process.cwd() });
    // The shape the user actually runs: ONE agent, which is the team's lead.
    team.addMember(teamName, { name: 'Nice', cwd: process.cwd() });

    const identity = makeIdentity({ name: 'Nice', teamName, color: 'red', agentType: 'general', model: '' });
    const out = await runAs(identity, () => SendMessageSpec.execute(
      { to: 'team-lead', message: '项目审查完成' }, {},
    ));

    assert.equal(out.error, undefined, `must not refuse: ${JSON.stringify(out)}`);
    assert.match(out.content, /lead/i);

    // It lands in the alias box, and NOT in the agent's own.
    assert.equal(mbox.readMailbox(teamName, 'team-lead').length, 1, 'the user\'s box has it');
    assert.match(mbox.readMailbox(teamName, 'team-lead')[0].text, /项目审查完成/);
    assert.equal(mbox.readMailbox(teamName, 'Nice').filter((m) => m.from === 'Nice').length, 0,
      'and the agent did not send it to itself');

    // The user's session reads that box, so this is the assertion that matters.
    const seen = team.readLeadInbox(teamName);
    assert.equal(seen.length, 1, 'the user\'s session sees exactly one message');
    assert.equal(seen[0].from, 'Nice');
    assert.match(seen[0].text, /项目审查完成/);
  });
});