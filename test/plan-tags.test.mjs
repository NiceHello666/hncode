// Tests for the plan block's delimiters.
//
// The delimiters were changed from `<plan>` to `<|plan|>`. That is not cosmetic: a bare
// `<plan>` is a plausible thing for prose, HTML, or a code fence to contain, so the
// extraction could latch onto text the model never meant as a plan block. The pipes
// make an accidental match effectively impossible, and these tests pin both halves —
// the new tag is found, and the old one is NOT.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlan, PLAN_OPEN_TAG, PLAN_CLOSE_TAG, PLAN_MODE_INSTRUCTION } from '../src/tui.js';

test('a pipe-delimited plan block is extracted', () => {
  const text = `Here is what I found.\n\n<|plan|>\n## Step one\n- src/a.js: do the thing.\n</|plan|>`;
  assert.equal(extractPlan(text), '## Step one\n- src/a.js: do the thing.');
});

test('the LAST block wins when the reply has more than one', () => {
  // The prompt tells the model only the last block is used, so extraction must match —
  // a model that revises mid-reply must not have its first attempt approved.
  const text = `<|plan|>old attempt</|plan|>\nsome prose\n<|plan|>new attempt</|plan|>`;
  assert.equal(extractPlan(text), 'new attempt');
});

test('unclosed blocks run to the end of the reply', () => {
  // A reply still streaming has no closing tag yet; the plan is what has arrived.
  assert.equal(extractPlan('<|plan|>## A\n- b'), '## A\n- b');
});

test('no block at all yields null, not an empty string', () => {
  // Callers distinguish "no plan offered" from "empty plan", so null is load-bearing.
  assert.equal(extractPlan('just prose'), null);
  assert.equal(extractPlan(''), null);
  assert.equal(extractPlan(null), null);
  assert.equal(extractPlan(undefined), null);
});

test('an empty block yields null, so it cannot be approved', () => {
  assert.equal(extractPlan('<|plan|></|plan|>'), null);
  assert.equal(extractPlan('<|plan|>   \n  </|plan|>'), null);
});

test('the old bare <plan> tag is NOT a delimiters any more', () => {
  // The regression this whole change is about. A reply that merely mentions the word
  // "plan" in prose — or shows HTML, or quotes a tag inside a code fence — must not be
  // read as offering a plan to approve, because approving it would turn prose into an
  // instruction.
  assert.equal(extractPlan('We should <plan> this carefully.'), null);
  assert.equal(extractPlan('<div class="plan">layout</div>'), null);
  assert.equal(extractPlan('Use a <plan> tag in your HTML.'), null);
  assert.equal(extractPlan('<plan>\n## a plan\n</plan>'), null);
});

test('prose that merely says "plan" in markdown is not a block', () => {
  assert.equal(extractPlan('I have a plan: fix it.'), null);
  assert.equal(extractPlan('## Plan\n- step one'), null);
});

test('the delimiters are pipe-delimited and the close is the open, mirrored', () => {
  assert.equal(PLAN_OPEN_TAG, '<|plan|>');
  assert.equal(PLAN_CLOSE_TAG, '</|plan|>');
  assert.ok(PLAN_CLOSE_TAG === `</${PLAN_OPEN_TAG.slice(1)}`,
    'the close tag must mirror the open one, or extraction can only match one of them');
});

test('the prompt the model is given names the new tags and not the old', () => {
  // The instruction is what the model actually sees; if it still said `<plan>` the model
  // would emit a block the extractor can no longer find, and Plan mode would silently
  // stop working.
  assert.ok(PLAN_MODE_INSTRUCTION.includes(PLAN_OPEN_TAG), 'the prompt must name the open tag');
  assert.ok(PLAN_MODE_INSTRUCTION.includes(PLAN_CLOSE_TAG), 'the prompt must name the close tag');
  assert.ok(!PLAN_MODE_INSTRUCTION.includes('<plan'),
    'the prompt must not still mention the old bare tag');
});

test('extraction is case-insensitive but the pipes are mandatory on the OPEN tag', () => {
  // The old regex was case-insensitive; keep that, since a model may capitalise. The
  // CLOSE has to be case-insensitive too, or a capitalised pair runs past its own
  // closing tag and swallows the rest of the reply.
  assert.equal(extractPlan('<|PLAN|>body</|plan|>'), 'body');
  assert.equal(extractPlan('<|plan|>body</|PLAN|>'), 'body');
  // A bare `<plan>` cannot open a block: that is the whole point of the pipes.
  assert.equal(extractPlan('<plan>body</|plan|>'), null);
  assert.equal(extractPlan('<plan>body</plan>'), null);
  // A pipe-delimited OPEN with a bare close is an UNCLOSED block, and an unclosed block
  // runs to the end of the reply (see the streaming test above) — the bare close is just
  // text inside it. This is deliberate: while a reply streams, the closing tag has not
  // arrived yet, so an unterminated block must still be readable.
  assert.equal(extractPlan('<|plan|>body</plan>'), 'body</plan>');
});