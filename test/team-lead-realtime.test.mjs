// A teammate's message to the lead must reach the person using hncode.
//
// WHY THIS FILE EXISTS
// --------------------
// `/team msg <name> <text>` wrote the message and the team never appeared to answer. The reply WAS
// written — to `team-lead`'s inbox — but the only reader of that inbox was `formatLeadInbox`, called at
// the START of a turn. So the sequence was:
//
//   the person sends an instruction  -> the member is woken and replies -> the reply lands on disk
//   the person watches an empty screen, because nothing reads the file until they type again
//
// From the user's side that is indistinguishable from a dead team, and no amount of formatting or
// hiding makes it better: the conversation IS what they asked to see.
//
// The fix is a callback. `SendMessage` writes the mailbox as before — that file is still the source of
// truth, and still what `formatLeadInbox` delivers at the next turn — and ADDITIONALLY calls
// `ctx.onLeadMail`, which the TUI turns into a transcript row as it happens.
//
// What is pinned here is the WIRING, because every link of it fails silently: a missing callback
// simply means the message arrives a turn late, which looks like slowness rather than a bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TOOL = path.resolve('src/tools/team.js');
const toolSrc = fs.readFileSync(TOOL, 'utf8');
const spawnSrc = fs.readFileSync(path.resolve('src/team/spawn.js'), 'utf8');
const tuiSrc = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');

/** The `to === TEAM_LEAD_NAME` branch of SendMessage, where the callback must fire. */
function leadBranch() {
  const at = toolSrc.indexOf("if (args.to === TEAM_LEAD_NAME) {");
  assert.ok(at > 0, 'the team-lead branch is present');
  // Up to the next statement at the same depth.
  const end = toolSrc.indexOf("const target = team.members.find", at);
  assert.ok(end > at, 'the branch ends where the next lookup begins');
  return toolSrc.slice(at, end);
}

test('a message to the lead still goes into the mailbox', () => {
  // The file remains the source of truth: the next turn's `formatLeadInbox` reads it, and it is what a
  // resumed session sees. The callback is an addition, not a replacement.
  assert.match(leadBranch(), /writeToMailbox\(teamName, TEAM_LEAD_NAME/,
    'the mailbox write is kept');
});

test('and it notifies the running TUI in the same branch', () => {
  assert.match(leadBranch(), /ctx\?\.onLeadMail|ctx\.onLeadMail/,
    'the callback fires for a message to the lead');
});

test('a display hook cannot break the send', () => {
  // The mailbox write has already happened. A throwing listener must not turn a delivered message into
  // an error the member sees, because the message IS delivered.
  const branch = leadBranch();
  assert.match(branch, /try \{[^}]*onLeadMail[\s\S]*?\} catch/,
    'the callback is guarded');
});

test('the spawner puts the callback on the teammate config', () => {
  // `ctx` is built by spreading this config (see the Agent constructor), so this is the channel that
  // makes the callback visible to the teammate's own tools.
  //
  // The destructure and the assignment are matched separately, and the second one over a generous span:
  // the file is CRLF, and the comment explaining WHY the callback is carried makes a single anchored
  // pattern fail on a file that is correct.
  assert.match(spawnSrc, /\bonLeadMail,/, 'spawnTeammate accepts it');
  const runCfg = spawnSrc.slice(spawnSrc.indexOf('const runCfg = {'), spawnSrc.indexOf('const runCfg = {') + 500);
  assert.match(runCfg, /\bonLeadMail,/, 'and puts it on runCfg');
  // And the parameter reaches the runner's cfg, not just the object literal.
  assert.match(spawnSrc, /runTeammate\(\{[\s\S]*?cfg: runCfg/, 'the config is what the teammate runs on');
});

test('spawnMany forwards it to each member', () => {
  // The path `/team add` and the TeamCreate tool both take. Dropping it here would make a reply appear
  // immediately for one entry point and not the other.
  assert.match(spawnSrc, /spawnTeammate\(\{[^)]*onLeadMail: opts\.onLeadMail/s,
    'spawnMany passes it through');
});

test('the TUI turns it into a transcript row, in full', () => {
  const at = tuiSrc.indexOf('onLeadMail: (mail) =>');
  assert.ok(at > 0, 'spawnTeammates supplies the callback');
  const body = tuiSrc.slice(at, at + 3000);
  // The row is the point: a notice alone scrolls away and is truncated.
  assert.match(body, /addChat\(/, 'the message becomes a chat row');
  // AND IT MUST BE THE IN-SCOPE `addChat`, not `viewCur.addChat`. `viewCur` is a local of `runTurn`,
  // and `spawnTeammates` lives inside `startTUI` — reading it there threw
  // "viewCur is not defined" from inside the tool relay, which reached unhandledRejection and killed
  // the TUI mid-turn. `node --check` cannot see it: the reference is syntactically valid.
  assert.doesNotMatch(body, /viewCur\.addChat/, 'and the in-scope addChat, not runTurn\'s viewCur');
  assert.match(body, /renderSoon\(\)/, 'and paints with the in-scope renderSoon');
  // NOT truncated. An early draft cut the text at a fixed length "to avoid flooding the screen", which
  // removes the content the user asked to read.
  assert.doesNotMatch(body, /text: [`'"][^`'"]*\.slice\(/, 'the row is not truncated');
  assert.match(body, /mail\.text/, 'the full text is used');
});

test('the notice names the sender and stays short', () => {
  // The transcript may be scrolled away; the notice is the interruption. It is a POINTER, so a short
  // version is right here — unlike the transcript row, which is the message itself.
  const at = tuiSrc.indexOf('onLeadMail: (mail) =>');
  const body = tuiSrc.slice(at, at + 3000);
  assert.match(body, /notice\(`\$\{mail\.from\}/, 'the notice leads with the sender');
  assert.match(body, /slice\(0, 100\)/, 'and is bounded, because it is only a pointer');
});
