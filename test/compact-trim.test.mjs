// The compaction trim, driven through the real code path.
//
// WHY THIS FILE EXISTS
// --------------------
// `computeCompactSplit` and the trim below it had NO test at all — 856 green tests said
// nothing about them. Two defects lived in that gap: a `droppedCount` whose declaration was
// deleted while two references survived (a ReferenceError on every compaction, with no
// `onEvent` reaching the UI), and a `lead` prefix that duplicated the system prompt whenever
// the cut landed at 0.
//
// The prompt is the load-bearing part: `llm.js` concatenates every `system` message into the
// request, so a duplicated block doubles the instructions on every compacted request.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HNCODE_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-compact-test-'));

const { Agent } = await import('../src/agent.js');

// A fake agent that only answers the questions the trim asks. No network is reachable.
function fakeAgent(messages, usedTokens = 100000) {
  const a = Object.create(Agent.prototype);
  a.cfg = { compactKeepRatio: 0.2 };
  a.usedTokens = () => usedTokens;
  a.messages = messages;
  return a;
}

// The trim lives on the prototype as `applyCompactionSplit`, so these tests drive the REAL
// implementation. An earlier version of this file re-implemented the four lines instead and
// stayed green when the duplicate-system-prompt bug was reintroduced — the copy carried its
// own guard, which is exactly how a test of a restatement fails. Do not inline it again.
function applyTrim(agent, summary = 'SUMMARY') {
  const before = agent.messages.length;
  const split = agent.computeCompactSplit(100000);
  const { dropped } = agent.applyCompactionSplit(100000, summary);
  return { split, dropped, before, after: agent.messages.length };
}

test('the trim never cuts inside the leading system block', () => {
  const msgs = [
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];
  const a = fakeAgent(msgs);
  const { split } = applyTrim(a);
  // The cut drops [0..split-1]. Landing at 1 would take S1 and leave S2.
  assert.ok(split === 0 || split >= 2,
    `a cut at ${split} splits the 2-message system block`);
});

test('the system prompt survives the trim exactly once', () => {
  // The regression: at split 0, `keep` already contains the whole array, so prepending the
  // block sent the prompt twice. `llm.js` concatenates system messages, so it doubled in
  // every compacted request from then on.
  const a = fakeAgent([
    { role: 'system', content: 'SYS' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: 'a2' },
  ]);
  applyTrim(a);
  const systems = a.messages.filter((m) => m.role === 'system');
  assert.equal(systems.length, 1, `expected one system message, got ${systems.length}`);
  assert.equal(systems[0].content, 'SYS');
});

test('a multi-message system block is not duplicated either', () => {
  const a = fakeAgent([
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: 'a2' },
  ]);
  applyTrim(a);
  const contents = a.messages.filter((m) => m.role === 'system').map((m) => m.content);
  assert.deepEqual(contents, ['S1', 'S2'], 'each block message appears once, in order');
});

test('a cut that keeps everything does not duplicate the system prompt', () => {
  // The reachable duplication. `split` falls back to 0 when NO boundary is legal — an
  // assistant that issued a tool call with an unanswered result is the ordinary way that
  // happens. `keep` is then the whole array, so a `lead` prefix restates the block: the
  // request carries the system prompt twice, on every compacted turn from then on.
  const a = fakeAgent([
    { role: 'system', content: 'SYS' },
    { role: 'tool', content: 'r' },
  ]);
  const { split } = applyTrim(a);
  assert.equal(split, 0, 'this history has no legal cut, so split is 0');
  const systems = a.messages.filter((m) => m.role === 'system');
  assert.equal(systems.length, 1, `the prompt appears once, got ${systems.length}`);
  assert.equal(systems[0].content, 'SYS');
});

test('a cut that keeps everything still keeps every message', () => {
  // The other half of the same branch: dropping the `lead` prefix must not DROP the block.
  const a = fakeAgent([
    { role: 'system', content: 'SYS' },
    { role: 'tool', content: 'r' },
  ]);
  applyTrim(a);
  assert.equal(a.messages.filter((m) => m.role === 'tool').length, 1, 'the tool row survives');
});

test('the trim adds the summary and the continuation note, in that order', () => {
  const a = fakeAgent([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ]);
  applyTrim(a);
  const tail = a.messages.slice(-2);
  // Both are harness text wrapped as a system reminder, and both are USER messages — a
  // `system` summary was skipped by the TUI's rebuild and filtered by the session save, which
  // is what made the old shape pure data loss.
  assert.deepEqual(tail.map((m) => m.role), ['user', 'user']);
  assert.match(tail[0].content, /^<system-reminder>[\s\S]*SUMMARY[\s\S]*<\/system-reminder>$/,
    'the summary is wrapped');
  assert.match(tail[1].content, /continue the work that was in progress/i,
    'the continuation note comes LAST, so the model resumes rather than answering the summary');
});

test('the trimmed history is shorter than what it replaced', () => {
  // The history has to be WEIGHTY for the split to land far enough in to drop anything: the
  // walk accumulates a budget (`used * keepRatio`) and stops at the first legal cut past it,
  // so a transcript of tiny uniform messages keeps almost everything. Real compaction fires
  // on a big history, which is what this reproduces.
  const msgs = [{ role: 'system', content: 'SYS' }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: 'x'.repeat(8000) });
    msgs.push({ role: 'assistant', content: 'y'.repeat(8000) });
  }
  msgs.push({ role: 'user', content: 'last' });
  msgs.push({ role: 'assistant', content: 'done' });
  const before = msgs.length;
  const a = fakeAgent(msgs);
  const { split } = applyTrim(a);
  assert.ok(split > 0, 'a heavy history produces a real cut');
  assert.ok(a.messages.length < before, `trimmed ${before} -> ${a.messages.length}`);
});

test('the compacted event payload uses a value the trim actually returns', () => {
  // The ReferenceError regression: `droppedCount` was referenced by the `compacted` event and
  // the PostCompact hook payload after its declaration was deleted. That is a class of error
  // `node --check` cannot see — the file parses and throws only at runtime, on a path no test
  // reached. Asserting the identifier is BOUND catches it without a live LLM.
  const src = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
  const at = src.indexOf("type: 'compacted'");
  assert.ok(at > 0, 'the compacted event exists');
  const around = src.slice(at, at + 400);
  assert.match(around, /dropped: droppedCount/, 'the payload names the dropped count');
  // It must come from the trim's return value, which is the binding that has to exist.
  assert.match(src, /const \{ split, dropped: droppedCount \} = this\.applyCompactionSplit/,
    'and it is destructured from applyCompactionSplit');
});
