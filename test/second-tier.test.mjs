// Tests for the second-tier additions: side threads, cron schedules, teleport and
// step replay.
//
// Why each is tested apart from the TUI: every one of them has a failure mode that is
// quiet in the running app.
//
//   * A side thread that leaks into session.messages costs money on every later turn
//     and silently changes the model's context — nothing visibly goes wrong.
//   * A cron parser that accepts a malformed expression produces a schedule that
//     never fires, or worse, fires far more often than asked.
//   * A teleport that does not rewrite paths looks fine until the file it names
//     cannot be opened on the other machine.
//   * A replay that reports the FINAL transcript for every step answers the wrong
//     question — "what did it see at step 3" — with no sign that it did.
//
// Testing principle: the parsers and transforms are pure, so they are driven with
// real inputs (including real Windows paths) rather than with mocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { forkMessages, SideThread, sideSystemPrompt, recapMessages, digestStats, SIDE_RO_TOOLS, sideToolAllowed } from '../src/side-thread.js';
import {
  parseCron, describeCron, validateEntry, listSchedules, dueWithHistory,
  readHistory, writeHistory, minuteKeyOf,
} from '../src/schedule.js';
import {
  packSession, serializeTeleport, parseTeleport, unpackInto, rewriteWorkspace,
  stripVolatile, teleportFileName, describeTeleport,
} from '../src/teleport.js';
import { buildSteps, stateAtStep, renderStep, replaySummary } from '../src/rollout.js';

// ---------------------------------------------------------------------------
// Side threads
// ---------------------------------------------------------------------------

test('the fork is a COPY of the conversation, with only model-usable roles', () => {
  const session = {
    messages: [
      { role: 'system', content: 'the system prompt' },
      { role: 'user', content: 'add a command' },
      { role: 'assistant', content: 'added it', toolCalls: [{ name: 'Edit', args: { path: 'a' } }] },
      { role: 'tool', toolName: 'Edit', content: 'ok' },
      { role: 'notice', content: 'a UI-only row' },
      { role: 'assistant', content: '   ' },
    ],
  };
  const forked = forkMessages(session);
  // The system prompt is dropped (the caller rebuilds it) and a UI-only role cannot be
  // sent to a model, but everything a model can read comes across — INCLUDING the tool
  // call, whose pairing with its result is what makes the history valid.
  assert.deepEqual(forked.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.ok(Array.isArray(forked[1].toolCalls), 'the tool call survives');
});

test('the fork is a COPY, so the side thread cannot write back into the session', () => {
  const session = { messages: [{ role: 'user', content: 'original' }] };
  const forked = forkMessages(session);
  forked[0].content = 'MUTATED';
  forked.push({ role: 'user', content: 'extra' });
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'original');
});

test('a bounded fork keeps the most recent entries', () => {
  const session = { messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` })) };
  const forked = forkMessages(session, { limit: 5 });
  assert.equal(forked.length, 5);
  assert.equal(forked[0].content, 'm35');
  assert.equal(forked[4].content, 'm39');
});

test('a side thread sends the forked history, which is the point of the feature', () => {
  const history = [{ role: 'user', content: 'the earlier request' }, { role: 'assistant', content: 'answered' }];
  const st = new SideThread({ basePrompt: 'BASE', history, model: 'cheap' });
  const p = st.payload('what is the flag?');
  assert.equal(p[0].role, 'system');
  assert.match(p[0].content, /BASE/);
  // The history IS the context: without it the model cannot answer "what does THIS
  // error mean" and has to ask which file.
  assert.deepEqual(p.slice(1, 3).map((m) => m.content), ['the earlier request', 'answered']);
  assert.equal(p[p.length - 1].content, 'what is the flag?');
  assert.equal(st.forked, 2);
});

test('the panel transcript shows ONLY the side exchanges, not the fork', () => {
  // codex states the reason: the forked history is context for the MODEL, and
  // repeating it in the panel buries the two lines the user asked for.
  const st = new SideThread({ basePrompt: 'B', history: [{ role: 'user', content: 'OLD MESSAGE' }] });
  st.record('q1', 'a1');
  assert.equal(st.transcript().length, 2);
  assert.ok(!st.transcript().some((r) => r.text.includes('OLD MESSAGE')));
  // The model still gets it.
  assert.ok(st.payload('q2').some((m) => m.content === 'OLD MESSAGE'));
});

test('the side thread keeps its own exchanges as further context', () => {
  const st = new SideThread({ basePrompt: 'B', history: [{ role: 'user', content: 'h' }] });
  st.record('q1', 'a1');
  st.record('q2', 'a2');
  assert.equal(st.turns, 2);
  const p = st.payload('q3');
  // 1 system + 1 forked + 4 side messages + the new question.
  assert.equal(p.length, 7);
  assert.deepEqual(p.slice(2, 4).map((m) => m.content), ['q1', 'a1']);
});

test('the system prompt says the main agent keeps running and which tools work', () => {
  // Collapse the line wrapping: the prompt is written as wrapped prose lines, and a
  // regex over the raw text would fail on a phrase that happens to straddle a break.
  const text = sideSystemPrompt('BASE').replace(/\s+/g, ' ');
  assert.match(text, /side question/i);
  // The base prompt says "carry the task through"; a side channel must not.
  assert.match(text, /main agent continues independently/);
  assert.match(text, /do not refer to being interrupted/);
  assert.match(text, /NOT added to their conversation/);
  // The tool list is stated so the model does not waste a step on an absent tool.
  for (const t of SIDE_RO_TOOLS) assert.ok(text.includes(t), `${t} is named`);
  assert.ok(sideSystemPrompt('BASE').startsWith('BASE'), 'the base prompt is still there');
});

test('only the reading tools are allowed in a side thread', () => {
  for (const t of SIDE_RO_TOOLS) assert.equal(sideToolAllowed(t), true, t);
  for (const t of ['Write', 'Edit', 'Bash', 'Agent', 'Memory', 'FetchURL']) {
    assert.equal(sideToolAllowed(t), false, `${t} must be refused`);
  }
});

test('a recap sends the REAL history, bounded, with the instruction last', () => {
  const long = Array.from({ length: 500 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const msgs = recapMessages(long, { limit: 20 });
  // system + 20 history entries + the closing instruction.
  assert.equal(msgs.length, 22);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /what has been done/i);
  assert.match(msgs[0].content, /no greeting/i);
  // The most recent entries, not the oldest.
  assert.equal(msgs[1].content, 'm480');
  // The instruction is the LAST user turn, so it is the most recent thing read.
  assert.match(msgs[msgs.length - 1].content, /Write the recap/i);
});

test('recap of an empty session says so instead of asking about nothing', () => {
  const msgs = recapMessages([]);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].content, /empty/i);
  assert.deepEqual(digestStats([]), { users: 0, assistants: 0, total: 0 });
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

test('the five fields are matched in the standard order', () => {
  const c = parseCron('30 14 15 6 *');
  assert.equal(c.matches(new Date(2026, 5, 15, 14, 30)), true);
  assert.equal(c.matches(new Date(2026, 5, 15, 14, 31)), false, 'minute must match');
  assert.equal(c.matches(new Date(2026, 5, 15, 15, 30)), false, 'hour must match');
  assert.equal(c.matches(new Date(2026, 5, 16, 14, 30)), false, 'day must match');
  assert.equal(c.matches(new Date(2026, 6, 15, 14, 30)), false, 'month must match');
});

test('ranges, lists and steps work', () => {
  const steps = parseCron('*/15 * * * *');
  assert.deepEqual([0, 15, 30, 45].map((m) => steps.matches(new Date(2026, 0, 1, 0, m))), [true, true, true, true]);
  assert.equal(steps.matches(new Date(2026, 0, 1, 0, 7)), false);
  const list = parseCron('0 9,18 * * *');
  assert.equal(list.matches(new Date(2026, 0, 1, 9, 0)), true);
  assert.equal(list.matches(new Date(2026, 0, 1, 18, 0)), true);
  assert.equal(list.matches(new Date(2026, 0, 1, 12, 0)), false);
  const range = parseCron('0 9-11 * * *');
  assert.equal(range.matches(new Date(2026, 0, 1, 10, 0)), true);
  assert.equal(range.matches(new Date(2026, 0, 1, 12, 0)), false);
  // A step over a range, not over the whole field.
  assert.equal(parseCron('0 9 1-30/10 * *').fields.dom.has(21), true);
  assert.equal(parseCron('0 9 1-30/10 * *').fields.dom.has(31), false);
});

test('an invalid expression is REJECTED rather than silently never firing', () => {
  // The whole reason the parser throws: a schedule that never fires looks identical
  // to one that is simply not due yet.
  for (const bad of ['', '0 9 * *', '0 9 * * * *', '60 0 * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', 'a b c d e', '5-1 * * * *', '*/0 * * * *']) {
    assert.throws(() => parseCron(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});

test('day-of-week accepts 7 as Sunday without breaking 0-7 ranges', () => {
  // Two bugs in one line of logic: an early fold made `7` look like a backwards
  // range, and folding BOTH ends made `0-7` cover only Sunday.
  assert.equal(parseCron('0 0 * * 7').matches(new Date(2026, 8, 27, 0, 0)), true, '7 is Sunday');
  assert.equal(parseCron('0 0 * * 0').matches(new Date(2026, 8, 27, 0, 0)), true, '0 is Sunday');
  const week = parseCron('0 0 * * 0-7');
  assert.equal(week.fields.dow.size, 7, '0-7 covers every day');
  assert.throws(() => parseCron('0 0 * * 8'));
});

test('when both day fields are set, cron fires on EITHER', () => {
  // The standard rule, and the one that surprises people. It is implemented AND
  // stated in the help text, so a reader is not left to discover it.
  const c = parseCron('0 9 1 * 1');
  assert.equal(c.matches(new Date(2026, 8, 1, 9, 0)), true, 'the 1st');
  assert.equal(c.matches(new Date(2026, 8, 28, 9, 0)), true, 'a Monday');
  assert.equal(c.matches(new Date(2026, 8, 8, 9, 0)), false, 'neither');
  // With only ONE restricted, the other cannot force a match.
  const domOnly = parseCron('0 9 15 * *');
  assert.equal(domOnly.matches(new Date(2026, 8, 16, 9, 0)), false);
});

test('an entry needs a prompt and a valid cron', () => {
  assert.equal(validateEntry({ cron: '0 9 * * *', prompt: 'x' }).ok, true);
  assert.match(validateEntry({ cron: '0 9 * * *' }).error, /prompt/);
  assert.match(validateEntry({ prompt: 'x' }).error, /5 fields/);
  assert.equal(validateEntry(null).ok, false);
});

test('a schedule fires once per due minute, and survives a restart', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-sch-'));
  const configFile = path.join(home, '.hncode', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const sch = { morning: { cron: '0 9 * * 1-5', prompt: 'summarise the PRs' } };
  const at = new Date(2026, 8, 28, 9, 0, 20);   // a Monday, 09:00

  let history = readHistory(configFile);
  assert.deepEqual(history, {}, 'a missing history file reads as empty');
  assert.deepEqual(dueWithHistory(sch, history, at).map((d) => d.id), ['morning']);

  // Record the run, as the TUI does, then check the SAME minute again.
  history[ 'morning' ] = minuteKeyOf(at);
  assert.equal(writeHistory(configFile, history), true);
  const reread = readHistory(configFile);
  assert.deepEqual(dueWithHistory(sch, reread, at), [], 'not twice in one minute');

  // The history is what makes it survive a restart in the same minute.
  const afterRestart = readHistory(configFile);
  assert.deepEqual(dueWithHistory(sch, afterRestart, at), [], 'still not twice after a reload');

  // A later day is due again.
  assert.deepEqual(dueWithHistory(sch, reread, new Date(2026, 8, 29, 9, 0)).map((d) => d.id), ['morning']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a disabled or invalid schedule never becomes due', () => {
  const at = new Date(2026, 8, 28, 9, 0);
  assert.deepEqual(dueWithHistory({ a: { cron: '0 9 * * *', prompt: 'x', enabled: false } }, {}, at), []);
  assert.deepEqual(dueWithHistory({ a: { cron: 'broken', prompt: 'x' } }, {}, at), []);
  assert.deepEqual(dueWithHistory({ a: { cron: '0 9 * * *' } }, {}, at), []);
});

test('the panel names the cron shape in words when it is a known one', () => {
  assert.equal(describeCron('0 9 * * 1-5'), 'weekdays at 09:00');
  assert.equal(describeCron('*/30 * * * *'), 'every 30 minutes');
  // An unknown expression is shown as-is rather than guessed at.
  assert.equal(describeCron('7 3 2 4 6'), '7 3 2 4 6');
});

test('listing normalises the config table and reports validity', () => {
  const rows = listSchedules({
    ok: { cron: '0 9 * * *', prompt: 'go' },
    off: { cron: '0 9 * * *', prompt: 'go', enabled: false },
    bad: { cron: 'nope', prompt: 'go' },
  });
  assert.deepEqual(rows.map((r) => r.id), ['ok', 'off', 'bad']);
  assert.equal(rows[0].valid, true);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[2].valid, false);
});

// ---------------------------------------------------------------------------
// Teleport
// ---------------------------------------------------------------------------

test('packing drops what describes the exporting machine', () => {
  const packed = packSession({
    id: 'a', workspace: 'D:\\w',
    messages: [{ role: 'assistant', content: 'x', pending: true, liveOutput: 'running' }],
    tasks: { t: {} }, usage: { calls: 3 }, sessionApprovals: ['Bash:npm test'],
  }, { from: 'D:\\w', to: 'D:\\w' });
  assert.equal('tasks' in packed.session, false);
  assert.equal('usage' in packed.session, false);
  assert.equal('sessionApprovals' in packed.session, false, 'a grant must not travel');
  assert.equal(packed.session.messages[0].pending, undefined);
  assert.equal(packed.session.messages[0].liveOutput, undefined);
});

test('a Windows workspace path is rewritten even though JSON escapes it', () => {
  // The bug this guards: a text search over the serialized JSON cannot find
  // `D:\old\proj`, because the file holds `D:\\old\\proj`. A structural walk does not
  // care how the serializer escapes anything.
  const s = { workspace: 'D:\\old\\proj', messages: [{ role: 'user', content: 'read D:\\old\\proj\\src\\a.js now' }] };
  const out = rewriteWorkspace(s, 'D:\\old\\proj', '/home/me/proj');
  assert.equal(out.messages[0].content, 'read /home/me/proj/src/a.js now');
});

test('the whole path token is normalised, not just the matched prefix', () => {
  // Rewriting the prefix alone produced `read /new\src\a.js` — a path that resolves
  // on neither system.
  const s = { messages: [{ role: 'user', content: 'cat D:\\old\\p\\deep\\f.ts' }] };
  const out = rewriteWorkspace(s, 'D:\\old\\p', '/srv/p');
  assert.equal(out.messages[0].content, 'cat /srv/p/deep/f.ts');
});

test('a coincidental substring inside a word is left alone', () => {
  const s = { messages: [{ role: 'user', content: 'the path is notD:\\old\\p really' }] };
  const out = rewriteWorkspace(s, 'D:\\old\\p', '/x');
  assert.equal(out.messages[0].content, 'the path is notD:\\old\\p really');
});

test('a posix to posix move rewrites and leaves the rest of the text intact', () => {
  const s = { messages: [{ role: 'user', content: 'ls /a/b/src && echo done' }] };
  const out = rewriteWorkspace(s, '/a/b', '/c/d');
  assert.equal(out.messages[0].content, 'ls /c/d/src && echo done');
});

test('a teleport round-trips, and importing into another checkout re-points it', () => {
  const session = {
    id: 'orig', title: 'fix bug', workspace: 'D:\\old\\proj',
    messages: [{ role: 'user', content: 'read D:\\old\\proj\\src\\a.js' }], rounds: 3,
  };
  const pack = packSession(session, { from: 'D:\\old\\proj', to: '/home/me/proj' });
  assert.equal(pack.format, 'hncode-teleport');
  assert.equal(pack.workspace, '/home/me/proj');
  assert.match(pack.session.messages[0].content, /\/home\/me\/proj\/src\/a\.js/);

  const text = serializeTeleport(pack);
  const back = parseTeleport(text);
  assert.equal(back.title, 'fix bug');

  const { session: imported, warnings } = unpackInto(back, { workspace: '/srv/checkout', newId: () => 'fresh' });
  assert.equal(imported.id, 'fresh', 'a new id, so two copies do not overwrite each other');
  assert.equal(imported.workspace, '/srv/checkout');
  assert.match(imported.messages[0].content, /\/srv\/checkout\/src\/a\.js/);
  assert.equal(warnings.length, 1, 'moving checkouts is reported, not silent');
  assert.match(warnings[0], /rewritten/);
});

test('importing into the SAME workspace warns about nothing', () => {
  const pack = packSession({ workspace: '/x', messages: [] }, { from: '/x', to: '/x' });
  const { warnings } = unpackInto(pack, { workspace: '/x' });
  assert.deepEqual(warnings, []);
});

test('a file that is not a teleport is rejected with a reason', () => {
  // "invalid JSON" alone does not tell a user they pasted the wrong file.
  assert.throws(() => parseTeleport('nope'), /not valid JSON/);
  assert.throws(() => parseTeleport('{}'), /not an hncode teleport/);
  assert.throws(() => parseTeleport('{"format":"claude"}'), /not an hncode teleport/);
  assert.throws(() => parseTeleport('{"format":"hncode-teleport","version":99,"session":{}}'), /newer than this build/);
});

test('the exported file name sorts by time and names the origin', () => {
  const n = teleportFileName({ id: 'abc-123' }, new Date('2026-09-30T12:34:56Z'));
  assert.match(n, /^hncode-teleport-abc-123-2026-09-30T12-34-56\.json$/);
  // A path-hostile id cannot escape the directory.
  assert.ok(!teleportFileName({ id: '../../etc/passwd' }).includes('/'));
});

test('the summary reports what was carried', () => {
  const pack = packSession({ title: 't', workspace: '/w', messages: [{ role: 'user', content: 'x' }], rounds: 2 }, { from: '/w', to: '/w' });
  const text = describeTeleport(pack);
  assert.match(text, /title\s+t/);
  assert.match(text, /messages\s+1/);
  assert.match(text, /rounds\s+2/);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('one assistant message becomes separate thinking, reply and tool steps', () => {
  const steps = buildSteps([{
    role: 'assistant', content: 'Found it.', reasoning: 'Searching…',
    toolCalls: [{ name: 'Grep', args: { pattern: 'x' } }, { name: 'Read', args: { path: 'a' } }],
  }]);
  assert.deepEqual(steps.map((s) => s.kind), ['thinking', 'assistant', 'tool', 'tool']);
  assert.deepEqual(steps.map((s) => s.label), ['thinking', 'reply', 'Grep', 'Read']);
});

test('a tool RESULT is its own step, so call and result are distinguishable', () => {
  const steps = buildSteps([
    { role: 'assistant', content: '', toolCalls: [{ name: 'Bash', args: { command: 'ls' } }] },
    { role: 'tool', toolName: 'Bash', content: 'a.js' },
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, 'tool');
  assert.equal(steps[0].role, 'assistant', 'a call');
  assert.equal(steps[1].role, 'tool', 'a result');
  const s = replaySummary(steps);
  assert.equal(s.calls, 1);
  assert.equal(s.results, 1);
});

test('the state at a step reports what was being answered THEN, not at the end', () => {
  // The point of a replay: step 1 must not know about the prompt that came later.
  const steps = buildSteps([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(stateAtStep(steps, 1).lastPrompt, 'first');
  assert.equal(stateAtStep(steps, 1).turn, 1);
  assert.equal(stateAtStep(steps, 2).lastPrompt, 'second');
  assert.equal(stateAtStep(steps, 2).turn, 2);
});

test('an out-of-range step index is clamped rather than throwing', () => {
  const steps = buildSteps([{ role: 'user', content: 'x' }]);
  assert.equal(stateAtStep(steps, -5).index, 0);
  assert.equal(stateAtStep(steps, 999).index, 0);
  assert.doesNotThrow(() => renderStep(steps, 999));
  assert.match(renderStep([], 0)[0], /no steps/);
});

test('a step frame wraps long lines and shows the tool arguments', () => {
  const steps = buildSteps([{ role: 'assistant', content: '', toolCalls: [{ name: 'Bash', args: { command: 'x'.repeat(200) } }] }]);
  const rows = renderStep(steps, 0, { width: 40 });
  assert.ok(rows[0].includes('Bash'), 'the header names the tool');
  assert.ok(rows.every((r) => r.length <= 40 + 20), 'nothing is wildly over the width');
  assert.ok(rows.some((r) => r.includes('command')), 'the arguments are shown');
});

test('an unknown role is shown rather than dropped', () => {
  // A replay that silently omits steps is worse than one with an ugly label.
  const steps = buildSteps([{ role: 'plugin-note', content: 'hello' }]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'other');
});
