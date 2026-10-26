// Structured messages between team members, and the permission round-trip they carry.
//
// WHY THIS FILE EXISTS
// --------------------
// A team's traffic is not all prose. A task assignment names a task ID, a shutdown request carries a
// correlation ID the reply must echo, and a permission request has to BLOCK the sender until a matching
// answer arrives. None of that fits in free text, so every consumer was reduced to matching substrings —
// "does this look like a shutdown?" — which works until someone writes the word in a sentence.
//
// The permission chain is the one with teeth. Before it existed a teammate had two options: be allowed to
// touch anything, or be unable to ask. Nothing carried "may I run this?" to the person who could answer.
//
// Shapes follow Claude Code's `src/utils/teammateMailbox.ts` field for field. `request_id` correlation is
// what lets a member have several calls in flight without one answer authorising another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-proto-'));
process.env.HNCODE_HOME = HOME;

const proto = await import('../src/team/protocol.js');
const perm = await import('../src/team/permission.js');
const team = await import('../src/team/team.js');
const mailbox = await import('../src/team/mailbox.js');
const panel = await import('../src/team-panel.js');

// ---------------------------------------------------------------------------
// the wire format
// ---------------------------------------------------------------------------

test('plain chat is not protocol traffic', () => {
  // The mailbox is shared, so a message that merely LOOKS like JSON, or that mentions a protocol word,
  // must stay chat. Reclassifying it would swallow what a member was trying to say.
  assert.equal(proto.parseProtocol('hello, how are you?'), null);
  assert.equal(proto.parseProtocol('{"a":1}'), null, 'JSON with no known type is chat');
  assert.equal(proto.parseProtocol('{oops'), null, 'broken JSON is chat');
  assert.equal(proto.parseProtocol(''), null);
  assert.equal(proto.parseProtocol('[shutdown requested by leader]'), null,
    'a sentence containing the word is still a sentence');
});

test('each message type survives a round trip', () => {
  const cases = [
    ['task_assignment', proto.taskAssignment({ taskId: '3', subject: 'fix', description: 'd', assignedBy: 'lead' })],
    ['shutdown_request', proto.shutdownRequest({ requestId: 's1', from: 'lead', reason: 'done' })],
    ['shutdown_approved', proto.shutdownApproved({ requestId: 's1', from: 'w1' })],
    ['shutdown_rejected', proto.shutdownRejected({ requestId: 's1', from: 'w1', reason: 'mid-task' })],
    ['permission_request', proto.permissionRequest({ requestId: 'p1', agentId: 'w1', toolName: 'Bash', toolUseId: 't1', description: 'x', input: {} })],
    ['permission_response', proto.permissionResponse({ requestId: 'p1', approved: true })],
    ['plan_approval_request', proto.planApprovalRequest({ requestId: 'q1', from: 'w1', plan: 'do it' })],
    ['plan_approval_response', proto.planApprovalResponse({ requestId: 'q1', approved: false })],
    ['mode_set_request', proto.modeSetRequest({ mode: 'yolo', from: 'lead' })],
  ];
  for (const [type, msg] of cases) {
    const back = proto.parseProtocol(JSON.stringify(msg));
    assert.ok(back, `${type} parses`);
    assert.equal(back.type, type, `${type} keeps its type`);
  }
});

test('a refusal carries a REASON, not just a boolean', () => {
  // The member shows it to the model, so the next attempt can differ. `approved: false` alone leaves it
  // guessing what was wrong.
  const deny = proto.permissionResponse({ requestId: 'p1', approved: false, error: 'not that file' });
  assert.equal(deny.subtype, 'error');
  assert.equal(deny.error, 'not that file');
});

// ---------------------------------------------------------------------------
// the permission round trip
// ---------------------------------------------------------------------------

const T = 'proto';
team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
team.addMember(T, { name: 'w1', agentType: 'general' });

/** Answer whatever the lead's box is holding, asynchronously. */
async function answerAs(approved, error) {
  await new Promise((r) => setTimeout(r, 120));
  const req = mailbox.readMailbox(T, 'team-lead').map((m) => perm.asPermissionRequest(m.text)).filter(Boolean).pop();
  assert.ok(req, 'the lead received a request');
  perm.answerPermission({ teamName: T, memberName: 'w1', requestId: req.requestId, approved, error });
  return req;
}

test('an approved request unblocks the member', async () => {
  const pending = perm.requestPermission({
    teamName: T, memberName: 'w1', leadName: 'team-lead',
    toolName: 'Bash', toolUseId: 'tu1', description: 'run the suite', input: { command: 'npm test' },
    timeoutMs: 5000,
  });
  const req = await answerAs(true);
  assert.equal(req.toolName, 'Bash', 'the lead sees which tool');
  assert.equal(req.description, 'run the suite', 'and what it would do');
  assert.equal((await pending).approved, true);
});

test('a refusal reaches the member WITH its reason', async () => {
  const pending = perm.requestPermission({
    teamName: T, memberName: 'w1', leadName: 'team-lead',
    toolName: 'Write', toolUseId: 'tu2', description: 'overwrite config', input: {},
    timeoutMs: 5000,
  });
  await answerAs(false, 'not that file');
  const res = await pending;
  assert.equal(res.approved, false);
  assert.equal(res.error, 'not that file');
});

test('the response is CONSUMED, so the next request is not auto-approved', async () => {
  // The defect this guards: a response left in the box answers every later request too — authorising a
  // call the person never saw.
  const first = perm.requestPermission({
    teamName: T, memberName: 'w1', leadName: 'team-lead',
    toolName: 'Bash', toolUseId: 'tu3', description: 'first', input: {}, timeoutMs: 5000,
  });
  await answerAs(true);
  await first;

  const left = mailbox.readMailbox(T, 'w1').filter((m) => {
    const p = proto.parseProtocol(m.text);
    return p && p.type === 'permission_response';
  });
  assert.deepEqual(left, [], 'nothing is left in the box');
});

test('a timeout says NOBODY ANSWERED, not "denied"', async () => {
  // The model must be able to tell "the person said no" from "nobody was there" — they call for different
  // next steps.
  const res = await perm.requestPermission({
    teamName: T, memberName: 'w1', leadName: 'team-lead',
    toolName: 'Bash', toolUseId: 'tu4', description: 'x', input: {},
    timeoutMs: 250,
  });
  assert.equal(res.approved, false);
  assert.match(res.error, /no answer from team-lead/);
});

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

test('a pending permission owns the keyboard', () => {
  // Otherwise `y` while composing sends the letter instead of approving, and the member keeps blocking.
  const p = panel.makeTeamPanel(T);
  p.pendingPermission = { requestId: 'r1', agentId: 'w1', toolName: 'Bash', description: 'x', input: {} };

  assert.deepEqual(panel.handleTeamPanelKey(p, { ch: 'y' }), { handled: true, action: 'permission', approved: true });
  assert.deepEqual(panel.handleTeamPanelKey(p, { ch: 'n' }), { handled: true, action: 'permission', approved: false });
  assert.deepEqual(panel.handleTeamPanelKey(p, { key: 'escape' }), { handled: true, action: 'permission', approved: false });
  // An unrelated key is swallowed rather than moving the selection out from under the decision.
  assert.deepEqual(panel.handleTeamPanelKey(p, { ch: 'j' }), { handled: true });
});

test('without a pending request the keys work normally', () => {
  const p = panel.makeTeamPanel(T);
  assert.equal(panel.handleTeamPanelKey(p, { ch: 'j' }).handled, false, 'not swallowed');
});

// ---------------------------------------------------------------------------
// the roster preview
// ---------------------------------------------------------------------------

test('three lines of a member\'s own work show under its name', () => {
  // Without it the roster claims `working` with no evidence: a member running a long test and one that
  // hung look identical. Claude Code draws the same three lines (`getMessagePreview`).
  const p = panel.makeTeamPanel(T);
  for (const e of [
    { kind: 'text', name: 'w1', text: 'Let me read the manifest' },
    { kind: 'tool', name: 'w1', tool: 'Read' },
    { kind: 'tool_result', name: 'w1', tool: 'Read', detail: 'package.json (40 lines)' },
    { kind: 'tool', name: 'w1', tool: 'Bash' },
    { kind: 'tool_result', name: 'w1', tool: 'Bash', detail: 'npm test — all passed' },
  ]) panel.noteActivity(p, e);

  const lines = panel.previewLines(p, 'w1', 3, 70);
  assert.equal(lines.length, 3, 'three lines');
  assert.match(lines[2], /npm test/, 'the NEWEST is last, in reading order');
  assert.match(lines[1], /package\.json/, 'and the one before it');
});

test('a tool preview prefers a result over the bare tool name', () => {
  // `Bash` says nothing; `npm test` says what the member is doing.
  const p = panel.makeTeamPanel(T);
  panel.noteActivity(p, { kind: 'tool', name: 'w1', tool: 'Bash' });
  panel.noteActivity(p, { kind: 'tool_result', name: 'w1', tool: 'Bash', detail: 'npm test' });
  const lines = panel.previewLines(p, 'w1', 3, 70);
  assert.match(lines.join(' '), /npm test/);
  assert.doesNotMatch(lines.join(' '), /^Bash$/);
});

// ---------------------------------------------------------------------------
// auto-exit
// ---------------------------------------------------------------------------

test('a view closes for a dead member but STAYS for a finished one', () => {
  // Exiting on completion would slam the transcript shut at the moment it became worth reading — that is
  // exactly when a person wants to see what the member did.
  assert.equal(panel.shouldAutoExit('killed'), true);
  assert.equal(panel.shouldAutoExit('failed'), true);
  assert.equal(panel.shouldAutoExit('stopped'), true);
  assert.equal(panel.shouldAutoExit('completed'), false);
  assert.equal(panel.shouldAutoExit('idle'), false);
  assert.equal(panel.shouldAutoExit('working'), false);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// roster actions
// ---------------------------------------------------------------------------

test('k / s / p / m are bound, and each carries what the caller needs', () => {
  // Claude Code's TeamsDialog exposes eight roster actions; these are the four that stop or redirect a
  // member. Without them the only way to deal with a runaway teammate was to close the panel, which
  // left it working.
  const T2 = 'roster';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'a', agentType: 'general' });
  team.addMember(T2, { name: 'b', agentType: 'general' });
  const p = panel.makeTeamPanel(T2);

  assert.deepEqual(panel.handleTeamPanelKey(p, { ch: 'k' }), { handled: true, action: 'kill', name: 'a' },
    'k kills the selected member');
  assert.deepEqual(panel.handleTeamPanelKey(p, { ch: 's' }), { handled: true, action: 'shutdown', name: 'a' },
    's asks it to stop gracefully');
  assert.deepEqual(panel.handleTeamPanelKey(p, { ch: 'm' }), { handled: true, action: 'cycleMode', name: 'a' },
    'm cycles its permission mode');
});

test('p names every IDLE member and skips the lead', () => {
  // Pruning is the five-idle-teammates case: killing them one at a time is five round trips. The lead
  // is never included — it is the roster entry that represents the person running the team.
  const T2 = 'prune';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'idle1', agentType: 'general' });
  team.addMember(T2, { name: 'idle2', agentType: 'general' });
  const p = panel.makeTeamPanel(T2);
  const res = panel.handleTeamPanelKey(p, { ch: 'p' });
  assert.equal(res.action, 'prune');
  assert.ok(Array.isArray(res.names), 'it hands back the names');
  assert.ok(!res.names.some((n) => /lead/i.test(n)), 'never the lead');
});

test("a member's permission mode is stored on the roster", () => {
  // Stored rather than messaged: the mode is a property that has to survive a restart, and a respawn
  // reads it from here.
  const T2 = 'modes';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'w', agentType: 'general' });
  assert.equal(team.setMemberMode(T2, 'w', 'yolo'), true);
  assert.equal(team.findMember(T2, 'w').permissionMode, 'yolo');
  assert.equal(team.setMemberMode(T2, 'nobody', 'ask'), false, 'unknown member is refused');
});

// ---------------------------------------------------------------------------
// two levels
// ---------------------------------------------------------------------------

test('Enter drills into a member, left goes back', () => {
  // Claude Code's TeamsDialog is two levels (`teammateList` → `teammateDetail`): the roster is for
  // scanning many members, the detail is for one. A single flat screen cannot do both — the roster
  // wants its rows, the detail wants the space.
  const T2 = 'levels';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'w1', agentType: 'general' });
  const p = panel.makeTeamPanel(T2);

  assert.equal(p.level, 'list', 'starts on the roster');
  panel.handleTeamPanelKey(p, { key: 'enter' });
  assert.equal(p.level, 'detail', 'Enter drills in');
  panel.handleTeamPanelKey(p, { key: 'left' });
  assert.equal(p.level, 'list', 'left goes back');
});

test('left at the top level closes the panel', () => {
  // "Back" from the first screen means leaving it; there is nothing above the roster.
  const T2 = 'topback';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'w1', agentType: 'general' });
  const p = panel.makeTeamPanel(T2);
  assert.deepEqual(panel.handleTeamPanelKey(p, { key: 'left' }), { handled: true, action: 'close' });
});

test('Enter in the detail view starts a message instead of drilling again', () => {
  // Drilling twice would have no third level; the useful action there is writing to the member you are
  // looking at.
  const T2 = 'deep';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'w1', agentType: 'general' });
  const p = panel.makeTeamPanel(T2);
  p.level = 'detail';
  panel.handleTeamPanelKey(p, { key: 'enter' });
  assert.equal(p.mode, 'compose', 'it composes');
  assert.equal(p.level, 'detail', 'and stays on the detail level');
});

test('the detail view names the member, its mode and what it is doing', () => {
  // What matters when looking at ONE member is what it runs as and what it has been saying — not the
  // roster row it came from.
  const T2 = 'detailview';
  team.createTeam({ teamName: T2, leadSessionId: 's1', cwd: process.cwd() });
  team.addMember(T2, { name: 'w1', agentType: 'general' });
  team.setMemberMode(T2, 'w1', 'yolo');
  const p = panel.makeTeamPanel(T2);
  panel.noteActivity(p, { kind: 'tool_result', name: 'w1', tool: 'Read', detail: 'package.json' });
  p.level = 'detail';

  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const shown = panel.renderTeamPanel(p, 72, 22).map(strip).join('\n');
  assert.match(shown, /@w1/, 'the name');
  assert.match(shown, /yolo/, 'its permission mode');
  assert.match(shown, /package\.json/, 'what it is doing');
  assert.match(shown, /back/, 'and how to leave');
});
