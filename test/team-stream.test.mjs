// A member's live work must reach the person watching.
//
// WHY THIS FILE EXISTS
// --------------------
// "I also can't see what the member or the lead calls." The roster said `working` and nothing else, so
// a member running tests for forty seconds looked exactly like one that had hung — and a member that
// had actually hung looked no different from one that was fine. The agent already emitted every event
// describing its work; `runTeammate` dropped them all on the floor.
//
// The chain is agent -> `onStream` -> spawn `onEvent({type:'stream'})` -> TUI `noteActivity` ->
// `panel.activity` -> a rendered row. Every link is a silent no-op if broken, which is why this file
// drives the whole thing with a fake agent rather than asserting on one function.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-stream-'));
process.env.HNCODE_HOME = HOME;

const team = await import('../src/team/team.js');
const mailbox = await import('../src/team/mailbox.js');
const { runTeammate } = await import('../src/team/runner.js');
const { runAs } = await import('../src/team/context.js');
const panel = await import('../src/team-panel.js');

const T = 'streamtest';
team.createTeam({ teamName: T, leadSessionId: 's1', cwd: process.cwd() });
team.addMember(T, { name: 'w1', agentType: 'general' });
mailbox.writeToMailbox(T, 'w1', { from: 'team-lead', text: 'go' });

/** One round with a fake agent that emits the events a real agent emits. */
async function round(script) {
  const seen = [];
  let stop = false;
  await runAs({ name: 'w1', teamName: T, agentType: 'general' }, () => runTeammate({
    teamName: T, memberName: 'w1',
    cfg: { model: 'm', provider: 'p', workspace: process.cwd(), cwd: process.cwd(), raw: { models: {}, providers: {} } },
    maxSteps: 2,
    shouldStop: () => stop,
    onStream: (s) => seen.push(s),
    makeAgent: (opts) => ({
      messages: opts.messages,
      async run() { script(opts); stop = true; },
    }),
  }));
  return seen;
}

const plainScript = (opts) => {
  opts.onEvent({ type: 'think', text: 'planning' });
  opts.onEvent({ type: 'data', text: 'working on it' });
  opts.onEvent({ type: 'tool_start', name: 'Read', args: {} });
  opts.onEvent({ type: 'tool_result', name: 'Read', text: 'package.json (40 lines)' });
  opts.onEvent({ type: 'tool_start', name: 'Bash', args: {} });
  opts.messages.push({ role: 'assistant', content: 'done' });
};

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

test('a member\'s tool calls and text reach the UI', async () => {
  const seen = await round(plainScript);
  const kinds = seen.map((s) => s.kind);
  assert.ok(kinds.includes('tool'), `the tool calls are relayed (${kinds})`);
  assert.ok(kinds.includes('tool_result'), `and so are their results (${kinds})`);
  assert.ok(kinds.includes('text'), `and the streamed text (${kinds})`);
  assert.ok(kinds.includes('think'), `and the reasoning (${kinds})`);
});

test('a tool result arrives WHOLE, not trimmed to its first line', () => {
  // Trimming belongs in the ROW LAYOUT, where the available height is known. Cutting here threw away
  // the body a reader opened the pane for; the panel draws the first line itself when space is short.
  return round((opts) => {
    opts.onEvent({ type: 'tool_start', name: 'Read', args: {} });
    opts.onEvent({ type: 'tool_result', name: 'Read', content: 'package.json (40 lines)\n{"name":"hncode"}' });
  }).then((seen) => {
    const r = seen.find((s) => s.kind === 'tool_result');
    assert.match(r.detail, /package\.json \(40 lines\)/, 'the summary is there');
    assert.match(r.detail, /"name":"hncode"/, 'and so is the body');
  });
});

test('a display hook cannot fail a member\'s turn', async () => {
  // The relay is wrapped: throwing here must not kill the member.
  const seen = await round((opts) => {
    opts.onEvent({ type: 'tool_start', name: 'Read', args: {} });
    opts.messages.push({ role: 'assistant', content: 'still finished' });
  });
  assert.ok(seen.length > 0);
  // The turn completed — the throw would have propagated otherwise.
  const mail = mailbox.readMailbox(T, 'team-lead');
  assert.ok(mail.length > 0, 'the member answered despite the hook');
});

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

test('the panel keeps the tool AND the text, not one or the other', () => {
  const p = panel.makeTeamPanel(T);
  const events = [
    { kind: 'think', name: 'w1', text: 'planning' },
    { kind: 'text', name: 'w1', text: 'working on it' },
    { kind: 'tool', name: 'w1', tool: 'Bash' },
  ];
  for (const e of events) panel.noteActivity(p, e);

  // ONE CONVERSATION PER MEMBER, in order — the shape Claude Code uses
  // (`displayedMessages = viewedAgentTask.messages`), not a single "latest activity" object.
  const log = p.chat.w1;
  assert.deepEqual(log.map((e) => e.kind), ['think', 'text', 'tool'], 'every entry is kept, in order');
  assert.equal(log[2].tool, 'Bash', 'the tool is named');
  assert.ok(log[1].text.includes('working on it'), 'and the text is there');
});

test('a streaming answer grows ONE entry, not one per delta', () => {
  // A bubble per delta would put a new line on every few characters and make the pane unreadable —
  // the opposite of what a transcript is for.
  const p = panel.makeTeamPanel(T);
  for (const chunk of ['Hmm', ', let me', ' check', '.']) {
    panel.noteActivity(p, { kind: 'text', name: 'w1', text: chunk });
  }
  assert.equal(p.chat.w1.length, 1, 'one entry');
  assert.equal(p.chat.w1[0].text, 'Hmm, let me check.', 'holding the whole answer');
});

test('a result attaches to the call it finished', () => {
  const p = panel.makeTeamPanel(T);
  panel.noteActivity(p, { kind: 'tool', name: 'w1', tool: 'Read' });
  panel.noteActivity(p, { kind: 'tool_result', name: 'w1', tool: 'Read', detail: 'a.js' });
  assert.equal(p.chat.w1.length, 1, 'no separate result entry');
  assert.equal(p.chat.w1[0].detail, 'a.js', 'the call carries it');
});

test('a result for a DIFFERENT tool does not attach', () => {
  // A late result must not label the wrong call; it becomes its own entry instead.
  const p = panel.makeTeamPanel(T);
  panel.noteActivity(p, { kind: 'tool', name: 'w1', tool: 'Bash' });
  panel.noteActivity(p, { kind: 'tool_result', name: 'w1', tool: 'Read', detail: 'a.js' });
  assert.equal(p.chat.w1[0].detail, undefined, 'the Bash call keeps no detail');
  assert.equal(p.chat.w1[1].kind, 'tool_result', 'the orphan result stands alone');
});

test('the conversation is bounded', () => {
  // A member can produce megabytes, and the pane draws a screenful.
  const p = panel.makeTeamPanel(T);
  for (let i = 0; i < 600; i++) {
    panel.noteActivity(p, { kind: 'tool', name: 'w1', tool: 'Read' });
  }
  assert.ok(p.chat.w1.length <= 400, `bounded (${p.chat.w1.length})`);
});

test('the rendered panel shows both the tool and the text', () => {
  const p = panel.makeTeamPanel(T);
  panel.noteActivity(p, { kind: 'tool', name: 'w1', tool: 'Bash' });
  panel.noteActivity(p, { kind: 'tool_result', name: 'w1', tool: 'Bash', detail: 'npm test' });
  panel.noteActivity(p, { kind: 'text', name: 'w1', text: 'running the suite' });
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const shown = panel.renderTeamPanel(p, 70, 24).map(strip).join('\n');
  assert.match(shown, /Bash/, 'the tool is on screen');
  assert.match(shown, /npm test/, 'with its result');
  assert.match(shown, /running the suite/, 'and what it is saying');
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('spawn forwards the relay to onEvent as a stream event', () => {
  // The middle link. runner's `onStream` reaching the UI is not enough — spawnMany must turn it into
  // an `onEvent` the TUI can see. Testing only the ends left this hop unverified: a mutation that
  // stubbed `onStream: () => {}` inside spawn passed every other assertion in this file.
  const src = fs.readFileSync(new URL('../src/team/spawn.js', import.meta.url), 'utf8');
  assert.match(src, /onStream: \(s\) => onEvent && onEvent\(\{ type: 'stream', name, stream: s \}\)/,
    'spawn relays it to onEvent');
});
