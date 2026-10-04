// Correctness + performance harness for the context-token accounting.
//   node tools/bench_tokens.mjs
//
// The memo and the ledger both trade a re-measure for cached state, so what matters is
// not the speedup — it is that the number stays IDENTICAL to the uncached one,
// including after an in-place content rewrite (what tool-result trimming does).
import { estimateMessagesTokens, estimateMessageTokens, messageTokens, TokenLedger, forgetMessageTokens } from '../src/term.js';
import { applyTrim } from '../src/tool-result.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

// A transcript shaped like a real one: big Read results interleaved with short turns.
function makeHistory(n, bigEvery = 10) {
  const out = [{ role: 'system', content: 'you are a coding agent' }];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `question ${i} `.padEnd(120, 'q') });
    if (i % bigEvery === 0) out.push({ role: 'tool', toolCallId: `t${i}`, name: 'Read', content: 'x'.repeat(60_000) });
    out.push({ role: 'assistant', content: `answer ${i} `.padEnd(400, 'a'), toolCalls: [{ id: `c${i}`, name: 'Bash', args: { command: 'ls -la /tmp/' + i } }] });
  }
  return out;
}

console.log('\n== correctness: memo matches the uncached figure ==');
{
  const msgs = makeHistory(40);
  let all = true;
  for (const m of msgs) if (messageTokens(m, null) !== estimateMessageTokens(m, null)) all = false;
  ok('memo == estimate for every message', all);
  ok('repeat ask is stable', messageTokens(msgs[3], null) === messageTokens(msgs[3], null));
}

console.log('\n== correctness: ledger total == uncached total ==');
{
  const msgs = makeHistory(200);
  const truth = estimateMessagesTokens(msgs, null);
  const led = new TokenLedger();
  const first = led.sync(msgs, null);
  ok('first sync matches truth', first === truth, `(${first} vs ${truth})`);
  ok('second sync (cached) matches truth', led.sync(msgs, null) === truth);
}

console.log('\n== correctness: append-only growth stays exact ==');
{
  const msgs = makeHistory(20);
  const led = new TokenLedger();
  let okAll = true;
  for (let i = 0; i < msgs.length; i++) {
    msgs.length = i + 1;
    if (led.sync(msgs, null) !== estimateMessagesTokens(msgs, null)) okAll = false;
  }
  ok('incremental total matches at every prefix', okAll);
}

console.log('\n== correctness: in-place content rewrite is noticed ==');
{
  // The real hazard: trimToolResults mutates m.content without replacing the object. A
  // cache trusting identity alone would keep serving the old number, and the gauge
  // would claim the trim freed nothing.
  const msgs = makeHistory(6);
  const led = new TokenLedger();
  const before = led.sync(msgs, null);
  const victim = msgs.find((m) => m.role === 'tool');
  victim.content = '[Output elided to save context]';
  forgetMessageTokens(victim);
  led.reset();
  const after = led.sync(msgs, null);
  ok('total DROPS after in-place rewrite', after < before, `(${before} -> ${after})`);
  ok('after == uncached truth', after === estimateMessagesTokens(msgs, null));
}

console.log('\n== correctness: the signature alone catches an in-place rewrite ==');
{
  // Proves the memo is self-invalidating: even with NO explicit forgetMessageTokens and
  // NO ledger reset, a content change must not be served from cache.
  const msgs = makeHistory(6);
  const victim = msgs.find((m) => m.role === 'tool');
  const before = messageTokens(victim, null);
  victim.content = '[Output elided]';
  const after = messageTokens(victim, null);
  ok('memoised message re-measures after content change', after < before, `(${before} -> ${after})`);
  ok('and equals the uncached figure', after === estimateMessageTokens(victim, null));
}

console.log('\n== correctness: applyTrim (the real mutator) is reflected ==');
{
  const msgs = [
    { role: 'user', content: 'q' },
    { role: 'tool', toolCallId: 'a', name: 'Read', content: 'y'.repeat(80_000) },
    { role: 'tool', toolCallId: 'b', name: 'Read', content: 'z'.repeat(80_000) },
  ];
  const truthBefore = estimateMessagesTokens(msgs, null);
  const led = new TokenLedger();
  led.sync(msgs, null);
  applyTrim(msgs, { elide: [1, 2], keep: [], keepBytes: 0 }, 'bench-session');
  led.reset();
  const after = led.sync(msgs, null);
  ok('trimmed total shrank a lot', after < truthBefore / 10, `(${truthBefore} -> ${after})`);
  ok('trimmed total == uncached truth', after === estimateMessagesTokens(msgs, null));
}

console.log('\n== correctness: array replacement (compaction) resets cleanly ==');
{
  const msgs = makeHistory(30);
  const led = new TokenLedger();
  led.sync(msgs, null);
  const trimmed = msgs.slice(5);
  const truth = estimateMessagesTokens(trimmed, null);
  ok('after replace, sync matches', led.sync(trimmed, null) === truth, `(${led.sync(trimmed, null)} vs ${truth})`);
}

console.log('\n== correctness: streaming message is never served stale ==');
{
  const m = { role: 'assistant', content: '' };
  const seen = [];
  for (let i = 0; i < 5; i++) { m.content += 'chunk'; seen.push(messageTokens(m, null)); }
  const rising = seen.every((v, i) => i === 0 || v > seen[i - 1]);
  ok('growing message re-measures every time', rising, JSON.stringify(seen));
  ok('final equals uncached', seen[seen.length - 1] === estimateMessageTokens(m, null));
}

console.log('\n== performance ==');
function bench(label, fn, iters) {
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / iters / 1e6;
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(3)} ms/op`);
  return ms;
}
for (const n of [500, 2000, 5000]) {
  const msgs = makeHistory(n);
  const a = bench(`n=${n}  uncached estimateMessagesTokens`, () => estimateMessagesTokens(msgs, null), 5);
  const led = new TokenLedger();
  const b = bench(`n=${n}  ledger cold sync`, () => { led.reset(); led.sync(msgs, null); }, 5);
  const c = bench(`n=${n}  ledger warm sync (append 1)`, () => { msgs.push({ role: 'user', content: 'x' }); led.sync(msgs, null); msgs.pop(); }, 20);
  console.log(`      -> cold ${(a / b).toFixed(1)}x, append ${(a / c).toFixed(0)}x`);
}

console.log(fails === 0 ? '\nALL CORRECTNESS CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);

// ---------------------------------------------------------------------------
// The Agent integration. `usedTokens()` now reads a rolling ledger, so the thing
// that could break is the AGENT's own reset discipline: a compaction replaces the
// array, and a trim rewrites content in place. Both must move the number.
// ---------------------------------------------------------------------------
console.log('\n== Agent.usedTokens: ledger stays exact across a real turn shape ==');
try {
  const { Agent } = await import('../src/agent.js');
  const cfg = { model: 'm', provider: 'p', innerModel: 'm', baseUrl: 'x', protocol: 'openai', maxContextTokens: 200000, workspace: process.cwd() };
  const agent = new Agent({ cfg, messages: [{ role: 'system', content: 'sys' }], onEvent: () => {} });
  agent.messages = makeHistory(30);
  const truth = estimateMessagesTokens(agent.messages, null);
  const got = agent.usedTokens();
  ok('agent total == uncached truth', got === truth, `(${got} vs ${truth})`);
  ok('agent total is stable across repeat calls', agent.usedTokens() === truth);

  // Append one message, the way the loop does every step.
  agent.messages.push({ role: 'assistant', content: 'a fresh reply' });
  const truth2 = estimateMessagesTokens(agent.messages, null);
  ok('after append, agent total == truth', agent.usedTokens() === truth2, `(${agent.usedTokens()} vs ${truth2})`);

  // Compact: the array is REPLACED, and the agent resets the ledger at that point.
  // The tail must still contain a tool result for the trim case below, so keep one.
  const lastTool = agent.messages.map((m) => m.role).lastIndexOf('tool');
  agent.messages = agent.messages.slice(Math.max(0, lastTool - 4));
  agent._ledger.reset();
  const truth3 = estimateMessagesTokens(agent.messages, null);
  ok('after compaction replace, agent total == truth', agent.usedTokens() === truth3, `(${agent.usedTokens()} vs ${truth3})`);

  // Trim: content rewritten IN PLACE, and the agent resets the ledger at that point.
  const beforeTrim = agent.usedTokens();
  const ti = agent.messages.findIndex((m) => m.role === 'tool');
  if (ti >= 0) {
    agent.messages[ti].content = '[Output elided to save context]';
    forgetMessageTokens(agent.messages[ti]);
    agent._ledger.reset();
    ok('after in-place trim, agent total DROPS', agent.usedTokens() < beforeTrim,
      `(${beforeTrim} -> ${agent.usedTokens()})`);
    ok('and equals truth', agent.usedTokens() === estimateMessagesTokens(agent.messages, null));
  } else {
    ok('trim case exercised', false, '(no tool message in the kept tail)');
  }
} catch (e) {
  ok('Agent integration runs', false, e.message);
}

console.log(fails === 0 ? '\nEVERYTHING PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);

