// What a teammate is TOLD about itself and its team.
//
// WHY THIS FILE EXISTS
// --------------------
// Three faults in the same place, all of which showed up as "the team doesn't work".
//
//   1. THE LEAD WAS TOLD TO ASK ITSELF FOR WORK. The first message ended with
//      `ask the lead for work: SendMessage with to="team-lead"` — sent to the lead itself, whose
//      roster name is its own. It complied, got no assignment, and stayed idle. The user saw a
//      lead that never replies.
//
//   2. THE ROSTER WAS PASTED INTO THE CONVERSATION. It cost tokens every round, went stale when a
//      member joined or left, and — worst — the lead read its own name in that list and concluded
//      it was not the lead, then reported the contradiction back to the user.
//
//   3. A MEMBER WAS TOLD "You are X, a teammate on the team Y" as a fact, with the member list
//      under it. Identity and the roster are configuration, not something that was SAID, so they
//      belong in the system prompt, which is rebuilt each request.
//
//   4. THE USER'S OWN MESSAGE GOT NO ANSWER. The rules covered finishing, being blocked and
//      asking for work — none of which is "the person said hello to you". A teammate that answered
//      only under those conditions treated a direct message as nothing to reply to, so a lead
//      that was perfectly alive looked dead. Answering `team-lead` is now stated as its own case.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-teamprompt-'));
process.env.HNCODE_HOME = home;
process.env.USERPROFILE = home;
process.env.HOME = home;

const { firstPrompt, teammateSystemPrompt, reportsTo } = await import('../src/team/runner.js');

/** The shape the user runs: one agent that IS the lead, plus a member. */
const team = {
  name: 'hnteam',
  leadName: 'hnt',
  members: [
    { name: 'hnt', role: 'lead', agentType: 'general' },
    { name: '2', role: 'member', agentType: 'general' },
  ],
};
const lead = team.members[0];
const member = team.members[1];

// ---------------------------------------------------------------------------
// who reports to whom
// ---------------------------------------------------------------------------

test('the lead has nobody above it; everyone else reports to the lead', () => {
  assert.equal(reportsTo(team, lead), '', 'a lead reports to nobody');
  assert.equal(reportsTo(team, member), 'hnt', 'a member reports to the lead by NAME');
});

test('a lone member is not told to report to itself', () => {
  const alone = { name: 'solo', leadName: 'solo', members: [{ name: 'solo', role: 'lead' }] };
  assert.equal(reportsTo(alone, alone.members[0]), '');
});

// ---------------------------------------------------------------------------
// the first message
// ---------------------------------------------------------------------------

test('the lead is NEVER told to ask for work', () => {
  // The fault that produced a silent lead. Asking is only for someone who has a lead to ask.
  const msg = firstPrompt({ team, member: lead, task: null, taskList: '', assignment: '' });
  assert.equal(msg, '', `a lead with no task has nothing to ask for, got: ${JSON.stringify(msg)}`);
  assert.doesNotMatch(msg, /ask/i);
});

test('a member with no task IS told to ask, by name, as its first action', () => {
  const msg = firstPrompt({ team, member, task: null, taskList: '', assignment: '' });
  assert.match(msg, /FIRST action/, 'it is an instruction, not a description');
  assert.match(msg, /SendMessage with to="hnt"/, 'and it names the tool and the recipient');
});

test('a member with an assignment is not told to ask for one', () => {
  const msg = firstPrompt({ team, member, task: null, taskList: '', assignment: 'review src/team' });
  assert.match(msg, /Your assignment: review src\/team/);
  assert.doesNotMatch(msg, /FIRST action/, 'it already has work');
});

test('a claimed task is stated as the task', () => {
  const msg = firstPrompt({ team, member, task: { id: 't1', subject: 'audit the parser' }, taskList: '', assignment: '' });
  assert.match(msg, /Your task \(t1\): audit the parser/);
  assert.doesNotMatch(msg, /FIRST action/);
});

// ---------------------------------------------------------------------------
// the roster is NOT in the conversation
// ---------------------------------------------------------------------------

test('neither the first message nor the system prompt repeats "You are X, a teammate on Y"', () => {
  // The exact sentence that was pasted before: a FACT about the setup, stated as conversation.
  for (const who of [lead, member]) {
    const first = firstPrompt({ team, member: who, task: null, taskList: '', assignment: '' });
    assert.doesNotMatch(first, /a teammate on the team/, `first message for ${who.name}`);
    assert.doesNotMatch(first, /Your team:/, 'and no pasted roster in the conversation');
  }
});

test('the conversation does not carry the member list', () => {
  // The roster is configuration: it must not be something the model reads as content, because it
  // goes stale and it made the lead mis-read its own role.
  const withTasks = firstPrompt({
    team, member, task: null, taskList: 't1 open do a thing', assignment: '',
  });
  assert.match(withTasks, /The full task list/, 'the TASK list is still conversation content');
  assert.doesNotMatch(withTasks, /^Your team:/m, 'the MEMBER list is not');
});

// ---------------------------------------------------------------------------
// the system prompt carries identity
// ---------------------------------------------------------------------------

test('the lead is told it IS the lead, and not to ask for an assignment', () => {
  const sys = teammateSystemPrompt(team, lead);
  assert.match(sys, /you ARE the lead/, 'its role is stated plainly');
  assert.match(sys, /Do not ask anyone for an assignment/, 'and asking is forbidden');
  assert.match(sys, /2 — general/, 'with the other members listed');
});

test('a member is told who its lead is, by name', () => {
  const sys = teammateSystemPrompt(team, member);
  assert.match(sys, /"2".*hnt is the lead/s, 'it knows who it reports to');
  assert.match(sys, /hnt \(lead\)/, 'and the roster marks which one is the lead');
  assert.doesNotMatch(sys, /you ARE the lead/);
});

test('the roster in the system prompt is recomputed, not frozen', () => {
  // A member that leaves must disappear from the next request. The system prompt is built per
  // call, so this holds by construction — asserted so a future cache cannot break it silently.
  const before = teammateSystemPrompt(team, lead);
  assert.match(before, /2 — general/);

  const after = teammateSystemPrompt({ ...team, members: [lead] }, lead);
  assert.doesNotMatch(after, /2 — general/, 'the departed member is gone');
  assert.match(after, /the only member of this team/, 'and the lead is told it is alone now');
});

test('the lead keeps the shared team instructions', () => {
  // Being in charge does not mean dropping the addendum: how to talk to the team, how not to
  // narrate progress, and that the task list is how work is claimed all still apply.
  const sys = teammateSystemPrompt(team, lead);
  assert.match(sys, /# You are a teammate/, 'the shared addendum is still first');
  assert.match(sys, /TeamTaskList shows the shared work/, 'including how work is claimed');
});

// ---------------------------------------------------------------------------
// the wiring
// ---------------------------------------------------------------------------

test('the runner builds the system prompt from the live roster', () => {
  const src = fs.readFileSync(path.resolve('src/team/runner.js'), 'utf8');
  assert.match(src, /role: 'system', content: teammateSystemPrompt\(team, member\)/,
    'the system entry is built per call from `team`, which was just read from disk');
  // A frozen copy would defeat the point: `TEAMMATE_ADDENDUM` alone has no names in it.
  assert.ok(!/role: 'system', content: TEAMMATE_ADDENDUM/.test(src),
    'the raw addendum is no longer used directly, or the roster would never reach the model');
});

// ---------------------------------------------------------------------------
// the user's own message gets an answer
// ---------------------------------------------------------------------------

test('a teammate is told to answer the person, by the name their messages carry', () => {
  // The report was "the lead never replies". The lead WAS alive and DID read the message — its
  // rules covered finishing, being blocked and asking for work, none of which is "the user said
  // hello". So it treated a direct message as nothing to answer.
  const sys = teammateSystemPrompt(team, lead);
  assert.match(sys, /WHO YOU ANSWER/, 'the routing is stated explicitly');
  assert.match(sys, /a message from the person using hncode carries the name `team-lead`/,
    'the user is identified by the name their sends actually carry');
  assert.match(sys, /SendMessage` to `team-lead`/, 'and the reply address is spelled out');
  assert.match(sys, /Answer anything sent to you/,
    'greetings and questions count, not only finished work');
});

test('the prompt cannot be read as "only report when you finish"', () => {
  // The exact mis-reading that produced the silence: the old text listed only finish / blocked /
  // decide, so anything else fell outside the list and got no reply.
  const sys = teammateSystemPrompt(team, member);
  const talking = sys.slice(sys.indexOf('## Talking to the team'), sys.indexOf('## Doing the work'));
  assert.match(talking, /Being silent about a\s+direct message is the one failure/,
    'silence on a direct message is called out as a failure');
});

test('a LEAD also answers the person — being in charge does not exempt it', () => {
  // The lead has no agent above it, so the ONLY thing that ever writes to it is the user. If the
  // answering rule were scoped to "members", the one agent the user talks to would stay silent.
  const sys = teammateSystemPrompt(team, lead);
  assert.match(sys, /Answer anything sent to you/);
  assert.match(sys, /team-lead/);
});

