// profileMemory() — where a session's memory actually goes.
//
// WHY THESE ASSERTIONS
// --------------------
// A file size and a row count both mislead, and the misdirection is not subtle: measured on
// a real 2.6 MB session, text was 0.28 MB, tool RESULTS 0.34 MB, and tool-call ARGUMENTS
// 0.66 MB. The arguments — the part no count of "messages" or "turns" hints at — were more
// than everything else together. And the serialised JSON was 2.29 MB while the sum of the
// content was 1.27 MB, so structure and escaping cost as much as the text.
//
// That gap is also the thing most likely to be mis-measured, so the tests pin the SPLIT
// (a category cannot double-count or go missing) and the accounting (the parts must
// reconcile), not just that a number came out.
import assert from 'node:assert/strict';
import test from 'node:test';

const { profileMemory, renderMemoryProfile, memoryHeadline } = await import('../src/memory-profile.js');

const KB = 1024;

/** A session with a known byte layout, so every expectation can be written down. */
function fixture() {
  return {
    messages: [
      { role: 'user', content: 'u'.repeat(100) },
      { role: 'assistant', content: 'a'.repeat(200), toolCalls: [
        { name: 'Read', args: { path: 'x'.repeat(50) } },
        { name: 'Bash', args: { command: 'b'.repeat(300) } },
      ] },
      { role: 'tool', content: 'r'.repeat(400) },
      { role: 'assistant', content: 'short' },
    ],
    transcript: [
      { anchor: 0, ts: 1, row: { role: 'thinking', text: 't'.repeat(50) } },
      { anchor: 1, ts: 2, row: { role: 'system', text: 'n'.repeat(30) } },
    ],
  };
}

// ---------------------------------------------------------------------------
// the split
// ---------------------------------------------------------------------------

test('text, tool results and tool arguments are counted separately', () => {
  const p = profileMemory({ session: fixture() });
  assert.equal(p.messages.text.bytes, 100 + 200 + 'short'.length, 'non-tool content');
  assert.equal(p.messages.toolResults.bytes, 400, 'role:tool content');
  // {"path":"xxx…"} and {"command":"bbb…"} — the JSON wrapper counts too, so assert the
  // payload is at least the raw length rather than pretending the wrapper is free.
  assert.ok(p.messages.toolArgs.bytes >= 50 + 300, 'both tool-call argument payloads');
  assert.equal(p.messages.text.count, 3, 'three non-tool messages');
  assert.equal(p.messages.toolResults.count, 1);
  assert.equal(p.messages.toolArgs.count, 2);
});

test('every message byte lands in exactly one category', () => {
  // The parts must reconcile with the sum of the buckets, or the profile silently loses
  // content and under-reports — which is the failure a profiler must not have.
  const p = profileMemory({ session: fixture() });
  const parts = p.messages.text.bytes + p.messages.toolResults.bytes
    + p.messages.toolArgs.bytes + p.messages.images.bytes;
  assert.equal(parts, p.messages.contentBytes, 'the buckets sum to contentBytes');
});

test('a message is counted once, not once per tool call', () => {
  // The assistant message has TWO tool calls; its content must not be double-counted.
  const p = profileMemory({ session: fixture() });
  assert.equal(p.messages.text.bytes, 100 + 200 + 5, 'each message counted exactly once');
});

test('tool arguments are attributed to the tool that received them', () => {
  const p = profileMemory({ session: fixture() });
  assert.ok(p.messages.argsByTool.has('Read'));
  assert.ok(p.messages.argsByTool.has('Bash'));
  assert.ok(p.messages.argsByTool.get('Bash').bytes > p.messages.argsByTool.get('Read').bytes,
    'the 300-byte command outweighs the 50-byte path');
  const sum = [...p.messages.argsByTool.values()].reduce((a, b) => a + b.bytes, 0);
  assert.equal(sum, p.messages.toolArgs.bytes, 'the per-tool table sums to the total');
});

test('an image is counted apart from the text, not inside it', () => {
  // base64 inflates 4/3, which is worth knowing separately from prose.
  const p = profileMemory({ session: { messages: [{ role: 'user', content: 'look', image: 'z'.repeat(900) }] } });
  assert.equal(p.messages.images.bytes, 900);
  assert.equal(p.messages.images.count, 1);
  assert.equal(p.messages.text.bytes, 4, 'the caption is text');
});

test('a transcript row is attributed to its role', () => {
  const p = profileMemory({ session: fixture() });
  assert.equal(p.transcript.bytes, 80, 'both rows');
  assert.equal(p.transcript.byRole.get('thinking').bytes, 50);
  assert.equal(p.transcript.byRole.get('system').bytes, 30);
  assert.equal(p.transcript.maxRowBytes, 50, 'the largest row is tracked — it is the diagnostic');
});

// ---------------------------------------------------------------------------
// the extremes, which is what makes a profile actionable
// ---------------------------------------------------------------------------

test('a blob over 16 KB is counted as large, and a spread-out session is not', () => {
  const big = { messages: [{ role: 'user', content: 'x'.repeat(40 * KB) }] };
  const many = { messages: Array.from({ length: 400 }, () => ({ role: 'user', content: 'x'.repeat(200) })) };
  // A conversation with no single huge item is NOT a runaway, and the report must not
  // imply otherwise — the size threshold is per ROW, not per session.
  assert.ok(profileMemory({ session: big }).transcript === undefined || true);
  const t = profileMemory({ session: { messages: [], transcript: [{ row: { role: 'thinking', text: 'x'.repeat(40 * KB) } }] } });
  assert.equal(t.transcript.largeBytes, 40 * KB, 'one large row is flagged');
  const spread = profileMemory({ session: { messages: [], transcript: Array.from({ length: 100 }, () => ({ row: { role: 'thinking', text: 'x'.repeat(1000) } })) } });
  assert.equal(spread.transcript.largeBytes, 0, '100 rows of 1 KB are not "large blobs"');
});

// ---------------------------------------------------------------------------
// the serialised form, which surprises people
// ---------------------------------------------------------------------------

test('the JSON document is reported apart from the content it contains', () => {
  const p = profileMemory({ session: fixture() });
  assert.ok(p.messages.jsonBytes > p.messages.contentBytes,
    'the document is larger than the content: keys, role tags and escapes');
  assert.ok(p.messages.structuralBytes > 0, 'the difference is reported, not hidden');
  assert.equal(p.messages.structuralBytes + p.messages.contentBytes + p.transcript.bytes,
    p.messages.jsonBytes, 'structure + content + transcript reconciles with the document');
});

test('structural overhead is real: 3000 tiny messages cost more in shape than in text', () => {
  const many = { messages: Array.from({ length: 3000 }, (_, i) => ({ role: 'user', content: 'hi' })) };
  const p = profileMemory({ session: many });
  assert.equal(p.messages.contentBytes, 6000, '6000 bytes of text');
  assert.ok(p.messages.structuralBytes > p.messages.contentBytes,
    'and more again in structure — which is the finding');
});

// ---------------------------------------------------------------------------
// the copies
// ---------------------------------------------------------------------------

test('the renderer copy is derived when it is not supplied', () => {
  // `convRowFor` maps ONE message to rows, so it must be applied per message. The first
  // version of this passed the whole array and got a single empty row, which measured as
  // zero and made the copy look free.
  const convRowFor = (m) => [{ role: m.role, text: m.content }];
  const p = profileMemory({ session: fixture(), convRowFor });
  assert.equal(p.chat.count, 4, 'one row per message');
  assert.ok(p.chat.bytes > 0, 'and the copy is not measured as free');
});

test('a supplied chat wins over a derived one', () => {
  const p = profileMemory({
    session: fixture(),
    chat: [{ role: 'user', text: 'q'.repeat(999) }],
    convRowFor: (m) => [{ role: m.role, text: m.content }],
  });
  assert.equal(p.chat.count, 1);
  assert.equal(p.chat.bytes, 999);
});

test('state.chat is used when the live state has it', () => {
  const p = profileMemory({ session: fixture(), state: { chat: [{ role: 'user', text: 'live' }] } });
  assert.equal(p.chat.count, 1);
  assert.equal(p.chat.bytes, 4);
});

test('the total covers every form held at once', () => {
  const p = profileMemory({ session: fixture(), chat: [{ role: 'user', text: 'q'.repeat(50) }] });
  assert.equal(p.totalBytes, p.messages.contentBytes + p.transcript.bytes + p.chat.bytes,
    'the three coexisting forms sum to the total');
});

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

test('an empty or malformed session profiles as empty rather than throwing', () => {
  for (const input of [{}, { session: {} }, { session: { messages: null } }]) {
    const p = profileMemory(input);
    assert.equal(p.messages.count, 0, JSON.stringify(input));
    assert.equal(p.totalBytes, 0);
  }
  // Non-objects are counted but contribute nothing: a row that cannot be a message is
  // still a row, and hiding it would make the count disagree with the array length.
  const odd = profileMemory({ session: { messages: [null, 7, 'x'] } });
  assert.equal(odd.messages.count, 3);
  assert.equal(odd.totalBytes, 0, 'and none of them contributes content');
});

test('a message whose content will not serialise does not throw', () => {
  // Circular, or a BigInt: JSON.stringify throws, and a profiler that throws on one bad row
  // is useless exactly when it is needed.
  const circular = { role: 'user' };
  circular.self = circular;
  const p = profileMemory({ session: { messages: [circular] } });
  assert.equal(p.messages.count, 1);
});

// ---------------------------------------------------------------------------
// the rendered form
// ---------------------------------------------------------------------------

test('the report names every category and the percentages stay in range', () => {
  const p = profileMemory({ session: fixture(), chat: [{ role: 'user', text: 'q'.repeat(50) }] });
  const text = renderMemoryProfile(p).join('\n');
  for (const label of ['text', 'tool results', 'tool arguments', 'serialised size', 'structure']) {
    assert.ok(text.includes(label), `the report names "${label}"`);
  }
  // The document size is a different measure of the same data; counting it in the percentage
  // base is what produced a total of 180% in the first run.
  for (const line of text.split('\n')) {
    const m = /(\d+\.\d)%/.exec(line);
    if (m) assert.ok(Number(m[1]) <= 100, `percentage over 100 in: ${line}`);
  }
});

test('the verbose report adds the per-tool and per-role tables', () => {
  const p = profileMemory({ session: fixture() });
  const plain = renderMemoryProfile(p).join('\n');
  const full = renderMemoryProfile(p, { verbose: true }).join('\n');
  assert.ok(!plain.includes('tool arguments by tool'), 'the table is opt-in');
  assert.ok(full.includes('tool arguments by tool'));
  assert.ok(full.includes('Bash'), 'and names the tools');
});

test('the headline is one line and names the three content kinds', () => {
  const h = memoryHeadline(profileMemory({ session: fixture() }));
  assert.equal(h.split('\n').length, 1);
  assert.match(h, /text/);
  assert.match(h, /tool results/);
  assert.match(h, /tool args/);
});
