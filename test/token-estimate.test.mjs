// The token estimate must be close enough to plan with.
//
// WHY THIS FILE EXISTS
// --------------------
// The estimator was `ascii / 4 + nonAscii`, the "four characters per token" folklore. That holds for
// English prose and for nothing else this application sends. Measured against BPE rates for its own
// content it was off by up to 35% in the direction that matters — an UNDERCOUNT, so the context gauge
// read low and compaction fired late:
//
//   English prose    1.05x   (the rule was calibrated for exactly this case)
//   TypeScript code  0.80x
//   JSON payload     0.82x
//   tool schema      0.75x
//   paths and flags  0.73x
//   minified JSON    0.65x
//
// On a 300k context, 0.65x is a ~100k error — the size of the gap being reported.
//
// The cause is that BPE merges COMMON BYTE PAIRS. Prose repeats whole words, so four characters per
// token holds; JSON and code are punctuation-dense, merge almost nothing, and a token covers ~2.6
// characters. The fix prices five character classes separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateTokensFloat } from '../src/term.js';

/**
 * The reference: what a BPE vocabulary actually charges, per character class.
 *
 * Published averages for cl100k/o200k-style vocabularies. Computing the baseline this way — rather than
 * guessing a chars-per-token figure per sample — is what makes the test meaningful: an earlier audit
 * judged a mixed CJK+code sample against 1.5 chars/token, reported 0.66x, and was wrong about the
 * BASELINE rather than about the estimator.
 */
function reference(s) {
  let wide = 0; let letters = 0; let digits = 0; let space = 0; let punct = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 127) wide++;
    else if (cp === 32 || cp === 9) space++;
    else if (cp >= 48 && cp <= 57) digits++;
    else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) letters++;
    else punct++;
  }
  return letters / 4.2 + digits / 3.0 + punct / 2.6 + space / 3.0 + wide;
}

const SAMPLES = {
  'English prose': 'The quick brown fox jumps over the lazy dog. '.repeat(20),
  'TypeScript code': 'function renderTeamPanel(panel, cols, rows) {\n  const out = [];\n  return out.slice(0, rows);\n}\n'.repeat(5),
  'JSON payload': JSON.stringify({ type: 'permission_request', request_id: 'perm-abc123', tool_name: 'Bash', input: { command: 'npm test' } }).repeat(5),
  'Chinese prose': '这是一段中文说明，用来测试估算器对中日韩文字的处理是否正确。'.repeat(10),
  'Mixed CJK+code': '读取 src/tui.js 并检查 renderFrame 函数。'.repeat(15),
  'minified JSON': '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8}'.repeat(10),
  'paths and flags': 'D:\\hncode\\src\\team-panel.js --include=*.ts --exclude-dir=node_modules '.repeat(10),
  'tool schema': JSON.stringify({ type: 'object', properties: { path: { type: 'string', description: 'file to read' } }, required: ['path'] }).repeat(6),
};

test('every content type this app sends is within 10% of the reference', () => {
  // 10% is the bar worth defending: at 1M context that is 100k of error on a full window, which is the
  // scale the old formula was wrong by on a THIRD of a window.
  for (const [name, text] of Object.entries(SAMPLES)) {
    const est = estimateTokensFloat(text);
    const ref = reference(text);
    const ratio = est / ref;
    assert.ok(Math.abs(ratio - 1) <= 0.1,
      `${name}: estimate ${est.toFixed(0)} vs reference ${ref.toFixed(0)} (${ratio.toFixed(2)}x)`);
  }
});

test('the old formula would FAIL that bar — the test has teeth', () => {
  // The control. If someone reverts to `ascii/4 + nonAscii`, this reproduces it and shows the same test
  // would fail, so the assertion above is not vacuous.
  const oldFormula = (s) => {
    let ascii = 0; let nonAscii = 0;
    for (const ch of s) { if (ch.codePointAt(0) <= 127) ascii++; else nonAscii++; }
    return ascii / 4 + nonAscii;
  };
  const worst = Object.entries(SAMPLES)
    .map(([name, text]) => ({ name, ratio: oldFormula(text) / reference(text) }))
    .sort((a, b) => a.ratio - b.ratio)[0];
  assert.ok(worst.ratio < 0.8,
    `the old formula is off by ${((1 - worst.ratio) * 100).toFixed(0)}% on ${worst.name}`);
});

test('an empty string is zero, not NaN', () => {
  // This runs on every streamed chunk, and an empty one arrives whenever a step ends.
  assert.equal(estimateTokensFloat(''), 0);
  assert.equal(estimateTokens(''), 0);
});

test('the two entry points use the SAME formula', () => {
  // `estimateTokens` round-trips through a cache and has an uncached path for long bodies; the streaming
  // counter does not. They used to disagree, which is how a session reports two numbers for one request.
  const short = 'const x = { a: 1 };';
  const long = '{"k":"v"},'.repeat(2000);
  for (const s of [short, long]) {
    assert.equal(estimateTokens(s), Math.ceil(estimateTokensFloat(s)),
      `both paths agree on a ${s.length}-character input`);
  }
});

test('CJK costs about one token per character', () => {
  // The one place the old formula was right, and it must stay right: it is the largest per-character rate.
  const zh = '你好世界';
  assert.ok(Math.abs(estimateTokensFloat(zh) - 4) < 0.5);
});
