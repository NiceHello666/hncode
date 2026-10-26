// A teammate must not answer into the void.
//
// WHY THIS FILE EXISTS
// --------------------
// "The team lead still does not reply to me." Two separate faults, both silent:
//
//   1. The member's FIRST user turn was an EMPTY STRING. `firstPrompt` returns '' when there is no
//      task, no assignment, and no one to report to — and the last of those is the NORMAL case for a
//      team's first member, because `addMember` makes the first member the lead and "report to the
//      lead" then resolves to itself and is discarded. A model handed an empty user turn has nothing
//      to answer, so the round produced no reply at all.
//
//   2. A round that answered in TEXT instead of calling `SendMessage` sent nothing. The tool is how a
//      member is told to reply, but a model that answers conversationally — "I'm here, got it" —
//      produces the very words the user is waiting for and delivers them nowhere. From outside, that is
//      identical to being ignored.
//
// Both are covered here with an INJECTED agent, so no model is involved: `makeAgent` exists for exactly
// this, and a test that needed a real model could not run in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-reply-'));
process.env.HNCODE_HOME = HOME;

const team = await import('../src/team/team.js');
const mailbox = await import('../src/team/mailbox.js');
const panel = await import('../src/team-panel.js');
const { TEAM_LEAD_NAME } = await import('../src/team/constants.js');
const { runTeammate } = await import('../src/team/runner.js');
const { runAs } = await import('../src/team/context.js');

/** A team with one member, and one message waiting in its inbox. */
function freshTeam(name) {
  team.createTeam({ teamName: name, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(name, { name: 'w1', agentType: 'general' });
  mailbox.writeToMailbox(name, 'w1', { from: 'team-lead', text: 'are you there?' });
  return name;
}

/** Run ONE round with a fake agent, and report what it was asked plus what reached the lead. */
async function round(teamName, agentBody) {
  let asked = null;
  let first = true;
  const result = await runAs({ name: 'w1', teamName, agentType: 'general' }, () => runTeammate({
    teamName, memberName: 'w1',
    cfg: { model: 'm', provider: 'p', workspace: process.cwd(), cwd: process.cwd(), raw: { models: {}, providers: {} } },
    maxSteps: 2,
    // One round only: stop as soon as it comes back to waiting for mail.
    shouldStop: () => !first,
    makeAgent: (opts) => {
      asked = opts;
      first = false;
      return {
        messages: opts.messages,
        run: () => agentBody(opts),
      };
    },
  }));
  return { result, asked, inbox: mailbox.readMailbox(teamName, 'team-lead').map((m) => `${m.from}: ${m.text}`) };
}

// ---------------------------------------------------------------------------
// 1. the first prompt
// ---------------------------------------------------------------------------

test('the member is never handed an EMPTY first request', async () => {
  // The failure: `firstPrompt` returned '' and the agent got `{role:'user', content:''}`. Anything is
  // better than that — an empty turn is a question with no words in it.
  const T = freshTeam('empty-prompt');
  const { asked } = await round(T, () => {});
  const firstUser = asked.messages.find((m) => m.role === 'user');
  assert.ok(firstUser, 'the agent was given a user turn');
  assert.ok(String(firstUser.content || '').trim().length > 0,
    `the first request must say something (got ${JSON.stringify(firstUser.content)})`);
});

// ---------------------------------------------------------------------------
// 2. a text answer
// ---------------------------------------------------------------------------

test('a round that answers in text still reaches the lead', async () => {
  // The member never calls SendMessage — it just replies. Its words must still arrive.
  const T = freshTeam('text-reply');
  const { inbox } = await round(T, (opts) => {
    opts.messages.push({ role: 'assistant', content: 'Yes, I am here.' });
  });
  assert.deepEqual(inbox, ['w1: Yes, I am here.'],
    `the text answer reached the lead (inbox: ${JSON.stringify(inbox)})`);
});

test('a round that used SendMessage is not answered TWICE', async () => {
  // The fallback must not duplicate a reply the tool already delivered. The fake agent simulates the
  // tool by firing the event the runner watches for, then ALSO writing the mailbox as the tool would.
  const T = freshTeam('no-double');
  const { inbox } = await round(T, (opts) => {
    opts.onEvent({ type: 'tool_start', name: 'SendMessage', args: { to: 'team-lead', message: 'via the tool' } });
    mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: 'via the tool' });
    opts.messages.push({ role: 'assistant', content: 'via the tool' });
  });
  assert.equal(inbox.length, 1, `exactly one reply (inbox: ${JSON.stringify(inbox)})`);
  assert.match(inbox[0], /via the tool/);
});

test('a round with nothing to say sends nothing', async () => {
  // No assistant text and no tool call: an empty message would be noise, not a reply.
  const T = freshTeam('silent');
  const { inbox } = await round(T, () => {});
  assert.deepEqual(inbox, [], 'nothing invented');
});

// ---------------------------------------------------------------------------
// 3. a round that throws
// ---------------------------------------------------------------------------

test('a failed round reports WHY instead of going quiet', async () => {
  // The model call fails for every reason the network and the provider can produce. Without a report the
  // error left `runTeammate` entirely and the member simply looked unresponsive.
  const T = freshTeam('failed-round');
  const { inbox } = await round(T, () => { throw new Error('no model configured'); });
  assert.equal(inbox.length, 1, 'the lead was told');
  assert.match(inbox[0], /w1:/);
  assert.match(inbox[0], /no model configured/, `the reason is in the message (${inbox[0]})`);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 4. what the LEAD is shown
// ---------------------------------------------------------------------------

test('two replies from the same member are told apart', async () => {
  // The defect this fixes, as reported: two answers arrived in one `<team-inbox>` block as
  // "1: …" and "1: …" — the sender name repeated with nothing between them, so they read as broken
  // numbering rather than as two messages.
  const T = 'two-replies';
  team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
  mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: 'first answer' });
  mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: 'second answer' });

  const shown = team.formatLeadInbox(T, { mark: false });
  assert.equal(shown.split('--- from w1 ---').length - 1, 2, `two delimited blocks (${shown})`);
  assert.match(shown, /first answer/);
  assert.match(shown, /second answer/);
  // A blank line between them, so one block's tail cannot be mistaken for the next one's head.
  assert.match(shown, /first answer\n\n--- from w1 ---/, 'separated by a blank line');
});

test('the lead is told to answer EACH message, not the batch', () => {
  // With one message the old wording was fine; with several it read as a single reply to a single
  // thing, which is how a member's second answer went unanswered.
  const T = 'each';
  team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
  mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: 'hi' });
  assert.match(team.formatLeadInbox(T, { mark: false }), /Answer each with the SendMessage tool/);
});

// ---------------------------------------------------------------------------
// 5. the messages are VISIBLE — in the PANEL
// ---------------------------------------------------------------------------

test('the panel shows both directions of a conversation', () => {
  // THE DEFECT: `memberTraffic` read only the MEMBER's inbox, which holds what was sent TO it and
  // nothing it ever SAID — an agent's words live in the recipient's box. So the panel echoed the user's
  // own messages back at them and never showed a single reply, and a team that was working looked
  // silent.
  const T = 'both-ways';
  team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T, { name: 'w1', agentType: 'general' });
  mailbox.writeToMailbox(T, 'w1', { from: TEAM_LEAD_NAME, text: 'please review the code' });
  mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: 'on it' });

  const traffic = panel.memberTraffic(T, 'w1', 10);
  const said = traffic.map((m) => `${m.from}: ${m.text}`);
  assert.ok(said.includes('team-lead: please review the code'), `what was sent to it (${said})`);
  assert.ok(said.includes('w1: on it'), `and what IT said (${said})`);
});

test('the panel orders the two sides by time', () => {
  // Merged and sorted, so the exchange reads in the order it happened rather than as two appended lists.
  const T = 'ordered';
  team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T, { name: 'w1', agentType: 'general' });
  mailbox.writeToMailbox(T, 'w1', { from: TEAM_LEAD_NAME, text: 'first' });
  mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: 'second' });
  mailbox.writeToMailbox(T, 'w1', { from: TEAM_LEAD_NAME, text: 'third' });

  const texts = panel.memberTraffic(T, 'w1', 10).map((m) => m.text);
  assert.deepEqual(texts, ['first', 'second', 'third'], `time order (${texts})`);
});

test('team traffic does NOT go into the main transcript', () => {
  // It belongs in the panel. Interleaving another conversation into the one the user is having with the
  // lead makes the transcript unreadable, and the panel is what the panel is for.
  const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  const at = src.indexOf('const teamName = leadTeam();');
  assert.ok(at > 0, 'the inbox injection is present');
  const block = src.slice(at, at + 900);
  assert.doesNotMatch(block, /addChat\(\{ role: 'team'/, 'no transcript row is added');
  assert.match(block, /messages\.push\(\{ role: 'user', content: `<team-inbox>/, 'it goes to the model');
});

// ---------------------------------------------------------------------------
// 6. the panel shows the WHOLE message
// ---------------------------------------------------------------------------

test('a multi-line reply is kept whole, not cut to its first line', () => {
  // The defect: `split('\n')[0].slice(0, 100)` kept the first line and a hundred characters, then the
  // layout drew one row per message. A member answering with a bulleted list — a capability summary, a
  // plan, a stack trace — appeared to say one short sentence.
  //
  // BOTH BOXES are checked. The truncation sat in two separate `map` callbacks, one per mailbox, so a
  // test that only covered the member's side passed while the user's own long messages were still cut.
  const T = 'multiline';
  team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T, { name: 'w1', agentType: 'general' });
  const reply = 'first line\n- a bullet\n- another bullet\n\nlast paragraph';
  const question = 'please look at:\n- one thing\n- another thing';
  mailbox.writeToMailbox(T, 'w1', { from: TEAM_LEAD_NAME, text: question });
  mailbox.writeToMailbox(T, 'team-lead', { from: 'w1', text: reply });

  const traffic = panel.memberTraffic(T, 'w1', 10);
  const byText = new Map(traffic.map((m) => [m.text, m.from]));
  assert.equal(byText.get(reply), 'w1', `the member's multi-line message is stored in full (${[...byText.keys()]})`);
  assert.equal(byText.get(question), TEAM_LEAD_NAME, `and so is the user's (${[...byText.keys()]})`);
});

test('the panel WRAPS it, so every line reaches the screen', () => {
  // Storing it whole is not enough — the row layout has to draw more than one row for one message.
  const T = 'wrapped';
  team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T, { name: 'w1', agentType: 'general' });
  mailbox.writeToMailbox(T, 'w1', { from: TEAM_LEAD_NAME, text: 'what can you do?' });
  mailbox.writeToMailbox(T, 'team-lead', {
    from: 'w1',
    text: 'Here is the list:\n- reading and editing code\n- running commands\n\nand a closing note',
  });

  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const p = panel.makeTeamPanel(T);
  // The member's answer now arrives as a LIVE `text` entry (its own stream), and the mailbox copy is
  // deliberately not drawn — the same words twice is worse than once. So the test feeds the entry the
  // relay would.
  panel.noteActivity(p, {
    kind: 'text',
    name: 'w1',
    text: 'Here is the list:\n- reading and editing code\n- running commands\n\nand a closing note',
  });
  const rendered = panel.renderTeamPanel(p, 70, 24).map(strip).join('\n');
  assert.match(rendered, /what can you do\?/, 'the question');
  assert.match(rendered, /Here is the list:/, 'the answer’s first line');
  assert.match(rendered, /reading and editing code/, 'a bullet from the middle');
  assert.match(rendered, /a closing note/, 'and the last line');
});
