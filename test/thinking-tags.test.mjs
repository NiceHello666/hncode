// Which inline reasoning-tag spellings the parser accepts — and, just as importantly,
// which PROSE it does not mistake for one.
//
// WHY THIS EXISTS
// ---------------
// Most OpenAI-compatible servers send the chain of thought in a separate
// `reasoning_content` field, but some put it INLINE in `content` wrapped in a tag.
// `feedContent` (src/llm.js) finds such a tag with `indexOf` over the whole buffer and
// then TOGGLES: everything before the tag is emitted one way, everything after the other.
// So a tag that also occurs in ordinary writing does not merely fail to match — it
// reclassifies the rest of the reply.
//
// That is what `' thinking'` did. It matches "I am thinking about this", and because a
// reply containing that phrase never reaches a closing tag, the remainder was emitted as
// REASONING and the user's answer disappeared into the thinking block. The bare forms are
// gone for that reason; this file pins their absence, because they are the kind of thing
// a well-meaning compatibility patch would add back.
//
// The tags come in pairs by convention — `<|thinking|>`/`<|/thinking|>` is what our own
// prompt asks for — but the parser is a single flag, so any opening tag closes on any
// closing one. Mixing is asserted here rather than left implicit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeNonStreaming } from '../src/llm.js';

/**
 * Feed one reply through the real non-streaming path and collect the events.
 * `consumeNonStreaming` is the exported entry point that uses the same `feedContent` the
 * streaming path does, so this exercises the real parser rather than a copy of it.
 */
function classify(content) {
  const events = [];
  consumeNonStreaming('openai', { choices: [{ message: { content } }] }, (e) => events.push(e));
  return {
    answer: events.filter((e) => e.type === 'data').map((e) => e.text).join(''),
    reasoning: events.filter((e) => e.type === 'think').map((e) => e.text).join(''),
  };
}

// ---- the accepted spellings ------------------------------------------------------

test('the canonical pair: <|thinking|> … <|/thinking|>', () => {
  const r = classify('<|thinking|>weighing the options<|/thinking|>the answer is B');
  assert.equal(r.reasoning, 'weighing the options');
  assert.equal(r.answer, 'the answer is B');
});

test('the short pair: <|think|> … <|/think|>', () => {
  const r = classify('<|think|>weighing the options<|/think|>the answer is B');
  assert.equal(r.reasoning, 'weighing the options');
  assert.equal(r.answer, 'the answer is B');
});

test('the slash-first spelling of both pairs', () => {
  // The delimiter ORDER differs between conventions, and a model that writes
  // `</|thinking|>` must not have its reasoning leak into the answer over punctuation.
  for (const [open, close] of [['<|thinking|>', '</|thinking|>'], ['<|think|>', '</|think|>']]) {
    const r = classify(`${open}weighing the options${close}the answer is B`);
    assert.equal(r.reasoning, 'weighing the options', `${open} … ${close}`);
    assert.equal(r.answer, 'the answer is B', `${open} … ${close}`);
  }
});

test('DeepSeek-R1’s own markers, which are not ours to change', () => {
  // U+FF5C bars and U+2581 separators: no prose can be mistaken for these. The OPENING
  // marker used to be missing while the closing one was present, which left the format
  // inside-out — the begin marker was emitted as the ANSWER and the end marker then
  // flipped everything after it into reasoning.
  const BEGIN = '<\uFF5Cbegin\u2581of\u2581thinking\uFF5C>';
  const END = '<\uFF5Cend\u2581of\u2581thinking\uFF5C>';
  const r = classify(`${BEGIN}weighing the options${END}the answer is B`);
  assert.equal(r.reasoning, 'weighing the options');
  assert.equal(r.answer, 'the answer is B');
});

test('mixing the spellings closes correctly', () => {
  // The parser is one flag, so the opening and closing spellings need not match. Asserted
  // because a future "pair them up" refactor would break exactly this.
  const mixes = [
    ['<|thinking|>', '<|/think|>'],
    ['<|think|>', '<|/thinking|>'],
    ['<|thinking|>', '</|think|>'],
    ['<|think|>', '</|thinking|>'],
  ];
  for (const [open, close] of mixes) {
    const r = classify(`${open}weighing the options${close}the answer is B`);
    assert.equal(r.reasoning, 'weighing the options', `${open} … ${close}`);
    assert.equal(r.answer, 'the answer is B', `${open} … ${close}`);
  }
});

// ---- the prose that must stay prose ----------------------------------------------

test('a sentence containing “thinking” is not a reasoning block', () => {
  // The regression. Each of these matched `' thinking'`, and the reply then had no closing
  // tag — so the rest of it was emitted as reasoning and the answer vanished.
  const sentences = [
    'I am thinking about this: the answer is B',
    'Stop thinking and answer: it is B',
    'After thinking it over, I chose B',
    'Thanks for thinking of me — the answer is B',
    'without thinking twice, the answer is B',
  ];
  for (const s of sentences) {
    const r = classify(s);
    assert.equal(r.reasoning, '', `must not be reasoning: ${JSON.stringify(s)}`);
    assert.equal(r.answer, s, `must be the whole answer: ${JSON.stringify(s)}`);
  }
});

test('literal angle-bracket forms in prose are not reasoning blocks either', () => {
  // HTML, a tutorial, or this very file quoted back. agent.js warns about exactly this:
  // "a plain <think> is ordinary text that may appear in code or prose".
  const prose = [
    'Use <think> in your template to render the block',
    'The wrapper is <thinking> and it takes no attributes',
    'Write </think> to close it',
  ];
  for (const s of prose) {
    const r = classify(s);
    assert.equal(r.reasoning, '', `must not be reasoning: ${JSON.stringify(s)}`);
    assert.equal(r.answer, s, `must be the whole answer: ${JSON.stringify(s)}`);
  }
});

// ---- the streaming state machine's edges -----------------------------------------
// ---- the state machine's edges ---------------------------------------------------

test('an unterminated block stays reasoning to the end', () => {
  // The model opened a block and never closed it. Everything after the opening tag is
  // reasoning, and the empty answer is the honest result — the alternative is showing the
  // chain of thought as the answer.
  const r = classify('<|thinking|>never closed');
  assert.equal(r.reasoning, 'never closed');
  assert.equal(r.answer, '');
});

test('text before and after a block is split in the right order', () => {
  const r = classify('before<|thinking|>middle<|/thinking|>after');
  assert.equal(r.answer, 'beforeafter');
  assert.equal(r.reasoning, 'middle');
});
