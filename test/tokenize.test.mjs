// Tests for the raw-byte key/mouse tokenizer.
//
// Why this file exists: tokenize() is the most frequently changed and least
// directly observable part of the TUI — its bugs surface as "Ctrl+E does nothing"
// or "the arrow keys leak as [A". Several of those shipped. Every test here
// corresponds to a bug that was actually introduced, so a regression is caught
// rather than rediscovered by hand.
//
// Testing principle: the input is a byte stream, so the useful equivalence classes
// are the ENCODINGS a terminal may use for one logical key, plus the split-across-
// chunks case (a sequence arriving in pieces) and the incomplete case (waiting for
// more bytes — must stay in `rest`, never be consumed).

import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, csiName, ctrlLetter } from '../src/tui.js';

const ESC = String.fromCharCode(27);
const ctrl = (ch) => String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64); // 'E' -> 0x05

/** Token list reduced to comparable strings, and the unconsumed rest. */
function tok(input) {
  const { tokens, rest } = tokenize(input);
  return {
    keys: tokens.map((t) => (t.paste !== undefined ? `paste:${t.paste}` : (t.key || `ch:${t.ch}`))),
    rest,
  };
}

test('plain printable characters become ch tokens', () => {
  assert.deepEqual(tok('abc').keys, ['ch:a', 'ch:b', 'ch:c']);
});

test('legacy Ctrl+letter bytes map to c-<letter>', () => {
  // The general rule added after Ctrl+E (0x05) was found dead on legacy terminals.
  // Boundary: 0x01 (A) and 0x1A (Z) are the ends of the range.
  assert.deepEqual(tok(ctrl('A')).keys, ['c-a']);
  assert.deepEqual(tok(ctrl('E')).keys, ['c-e']);
  assert.deepEqual(tok(ctrl('V')).keys, ['c-v']);
  assert.deepEqual(tok(ctrl('Z')).keys, ['c-z']);
});

test('backspace is not misread as Ctrl+H', () => {
  // 0x08 is BOTH the Backspace byte and the Ctrl+H code. Backspace must win.
  assert.deepEqual(tok(String.fromCharCode(8)).keys, ['backspace']);
  assert.deepEqual(tok(String.fromCharCode(0x7f)).keys, ['backspace']);
});

test('tab and newline keep their own tokens despite being in the Ctrl range', () => {
  assert.deepEqual(tok('\t').keys, ['tab']);
  assert.deepEqual(tok('\n').keys, ['newline']);
});

test('CSI arrow keys parse, with and without a leading parameter', () => {
  assert.deepEqual(tok(`${ESC}[A`).keys, ['up']);
  assert.deepEqual(tok(`${ESC}[B`).keys, ['down']);
  assert.deepEqual(tok(`${ESC}[C`).keys, ['right']);
  assert.deepEqual(tok(`${ESC}[D`).keys, ['left']);
});

test('modified CSI arrows parse (the `;` parameter used to abort the sequence)', () => {
  // Regression: the parameter scan only accepted DIGITS, so it stopped at the ':'
  // in `1;5A`, `fin` became ';', the guard rejected it, and Ctrl+Up was DROPPED
  // entirely — the `;`-parameter code below was unreachable.
  assert.deepEqual(tok(`${ESC}[1;2A`).keys, ['shift-up']);
  assert.deepEqual(tok(`${ESC}[1;5A`).keys, ['c-up']);
  assert.deepEqual(tok(`${ESC}[1;5B`).keys, ['c-down']);
  assert.deepEqual(tok(`${ESC}[1;5C`).keys, ['c-right']);
  assert.deepEqual(tok(`${ESC}[1;5D`).keys, ['c-left']);
});

test('CSI-u (kitty protocol) modifiers parse', () => {
  assert.deepEqual(tok(`${ESC}[118;5u`).keys, ['c-v']);
  assert.deepEqual(tok(`${ESC}[118;6u`).keys, ['c-s-v']);
});

test('bracketed paste yields the pasted text as one token', () => {
  assert.deepEqual(tok(`${ESC}[200~hello world${ESC}[201~`).keys, ['paste:hello world']);
});

test('an EMPTY bracketed paste is a distinct, detectable token', () => {
  // This is the signal that the clipboard held an image the terminal could not
  // send as text; the paste path reads the clipboard on it.
  assert.deepEqual(tok(`${ESC}[200~${ESC}[201~`).keys, ['paste:']);
});

test('a complete paste followed by a keystroke keeps both, in order', () => {
  assert.deepEqual(tok(`${ESC}[200~ab${ESC}[201~x`).keys, ['paste:ab', 'ch:x']);
});

test('an INCOMPLETE sequence stays in rest and is never consumed', () => {
  // The parser must not swallow a prefix: the caller re-feeds the buffer when the
  // rest of the bytes arrive. Consuming here would lose the key.
  // NOTE: a bare ESC is NOT "incomplete" — it is the Escape key and is emitted as
  // such; only a partial CSI/paste/mouse sequence is held back.
  for (const partial of [`${ESC}[`, `${ESC}[1`, `${ESC}[200~hi`, `${ESC}[<0;1`]) {
    const r = tok(partial);
    assert.deepEqual(r.keys, [], `partial ${JSON.stringify(partial)} must produce no token`);
    assert.equal(r.rest, partial, `partial ${JSON.stringify(partial)} must be left in rest`);
  }
});

test('a bare ESC is the Escape key', () => {
  // Distinct from an incomplete sequence: there is nothing more coming, so it is a
  // complete key press and must be emitted immediately.
  const r = tok(ESC);
  assert.deepEqual(r.keys, ['escape']);
  assert.equal(r.rest, '');
});

test('a split sequence reassembles when the chunks arrive separately', () => {
  // What the caller actually does: feed chunk 1, keep `rest`, prepend it to chunk 2.
  const first = tokenize(`${ESC}[1;5`);
  assert.deepEqual(first.tokens, []);
  const second = tokenize(first.rest + 'A');
  assert.deepEqual(second.tokens.map((t) => t.key), ['c-up']);
});

test('SGR mouse: press, release, wheel, hover and drag are distinguished', () => {
  // cb bit layout: 0-1 button, 32 motion, 64 wheel.
  assert.deepEqual(tok(`${ESC}[<0;12;5M`).keys, ['mousedown']);
  assert.deepEqual(tok(`${ESC}[<0;12;5m`).keys, ['mouseup']);
  assert.deepEqual(tok(`${ESC}[<64;3;4M`).keys, ['wheelup']);
  assert.deepEqual(tok(`${ESC}[<65;3;4M`).keys, ['wheeldown']);
  assert.deepEqual(tok(`${ESC}[<35;7;8M`).keys, ['mousehover']);   // 32|3 = motion, no button
  assert.deepEqual(tok(`${ESC}[<32;7;8M`).keys, ['mousemove']);   // 32|0 = motion, button held
  assert.deepEqual(tok(`${ESC}[<2;1;1M`).keys, ['rightclick']);
});

test('mouse coordinates are carried through, 1-based', () => {
  const { tokens } = tokenize(`${ESC}[<0;42;17M`);
  assert.equal(tokens[0].col, 42);
  assert.equal(tokens[0].row, 17);
});

test('ctrlLetter lowercases a code point; csiName is total', () => {
  // ctrlLetter takes a CSI-u CODE POINT (the letter of `ESC[<cp>;<mod>u`), not a raw
  // Ctrl byte: 97='a', 65='A' -> 'a'. Anything that is not a letter/space is null.
  assert.equal(ctrlLetter(97), 'a');
  assert.equal(ctrlLetter(65), 'a');
  assert.equal(ctrlLetter(122), 'z');
  assert.equal(ctrlLetter(90), 'z');
  assert.equal(ctrlLetter(32), ' ');
  assert.equal(ctrlLetter(49), null);   // '1' is not a letter
  assert.equal(ctrlLetter(1), null);
  // csiName must ALWAYS name a key — an unknown final byte still yields a string,
  // so an unrecognised sequence consumes cleanly instead of stalling the loop.
  for (const fin of ['A', 'B', 'H', 'F', 'Z', '~']) {
    assert.equal(typeof csiName('1;5', fin), 'string');
  }
});