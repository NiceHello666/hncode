// Keyboard input: every chord reaches the method, and every character the model can type works.
//
// WHY THIS FILE EXISTS
// --------------------
// Two defects, both found by running the thing rather than reading it.
//
// 1. `[CuInput]::KeyUp(13)` failed with "does not contain a method named 'KeyUp'" — while
//    `[CuInput].GetMethod('KeyUp')` returned `Void KeyUp(UInt16)`, and `[CuInput]::KeyDown(13)`, an
//    identical call on a same-signature method in the same class, worked. Measured in PowerShell 5.1
//    and 7, for every argument type including an explicit [uint16], and GetMember('KeyUp') reported
//    only the method — so no "shadowing constant" explanation holds. Reflection reaches it, which is
//    what the exported wrappers now use.
//
//    Every chord was broken, since a chord is a KeyDown followed by a KeyUp: Enter, Ctrl+C, Tab.
//
// 2. `typeText("emoji 🎉")` failed with `Cannot convert argument "ch", with value: "127881", for
//    "TypeChar" to type "System.UInt16"`. An astral-plane character does not fit a UTF-16 code unit,
//    and the loop walked the string by CODE UNIT, so the emoji arrived as two lone surrogates. The
//    old comment claimed emoji worked; nothing had ever tested it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('plugins/computer-use/platform/win-input.js');
const src = fs.readFileSync(SRC, 'utf8');
const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// the call form
// ---------------------------------------------------------------------------

test('the key helpers take a BYTE virtual key code', () => {
  // The signature is the property worth pinning. `keybd_event` takes a byte for the key and a byte for
  // the scan code, and a `ushort` parameter here produced "does not contain a method named KeyUp" at
  // every call — an error about overload resolution rather than about the key.
  assert.match(src, /public static void KeyDown\(byte vk\)/);
  assert.match(src, /public static void KeyUp\(byte vk\)/);
  // And the scan code is looked up rather than left zero: some applications distinguish keys by scan
  // code and ignore a virtual key on its own.
  assert.match(src, /MapVirtualKey\(vk, 0\)/, 'the scan code is resolved');
});

test('a chord presses AND releases every key', () => {
  // The bug this file was written for: `KeyUp` was unreachable, so a chord pressed a key and never
  // released it, leaving it stuck down for every action afterwards. The mechanism has changed since
  // (reflection on SendInput, now keybd_event), so the assertion is on the PROPERTY rather than on the
  // call form: the helper can do both, and a chord uses both.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
  assert.match(code, /KeyDown\(\$\{c\}\)/, 'a chord presses each key');
  assert.match(code, /KeyUp\(\$\{c\}\)/, 'and releases each key');
  // The release runs in reverse, which is how a real keyboard produces a chord: the modifiers come up
  // last, after the key they modified.
  assert.match(code, /codes\.slice\(\)\.reverse\(\)\.map\(\(c\) => `\[CuInput\]::KeyUp/,
    'and releases in reverse order');
});

// ---------------------------------------------------------------------------
// astral characters
// ---------------------------------------------------------------------------

test('text is split by CODE POINT, not by code unit', () => {
  // `for (const ch of s)` walks UTF-16 units, which splits an emoji into two lone surrogates. The
  // spread operator iterates code points, which is what the pairing below expects.
  assert.match(src, /const points = \[\.\.\.s\]/, 'the text is spread into code points');
  assert.doesNotMatch(src, /for \(const ch of s\.slice/, 'and not sliced as raw string units');
});

test('a character above the BMP is sent as a surrogate pair', () => {
  // The pairing happens on the JS side: SendInput wants one call per UTF-16 code unit, and the C#
  // helper takes a single `ushort`, so it cannot receive a code point above 0xFFFF at all. Splitting
  // in `typeText` is what makes an astral character work.
  assert.match(src, /cp > 0xFFFF/, 'it detects an astral code point');
  assert.match(src, /0xD800 \+ \(v >> 10\)/, 'and emits the high surrogate');
  assert.match(src, /0xDC00 \+ \(v & 0x3FF\)/, 'and the low one');
  assert.match(src, /UnicodeUnit\(\$\{0xD800/, 'each half goes to the C# helper separately');
});

test('the arithmetic for a surrogate pair is correct', () => {
  // The formulas, checked against a known character: U+1F389 (party popper) must become
  // D83C DF89. Getting the shifts or the offsets wrong produces a different character silently.
  const cp = 0x1F389;
  const v = cp - 0x10000;
  const high = 0xD800 + (v >> 10);
  const low = 0xDC00 + (v & 0x3FF);
  assert.equal(high, 0xD83C, 'high surrogate');
  assert.equal(low, 0xDF89, 'low surrogate');
  assert.equal(String.fromCharCode(high, low), '\u{1F389}', 'and they recombine to the character');
});

// ---------------------------------------------------------------------------
// against the real machine
// ---------------------------------------------------------------------------

test('every chord in common use succeeds', { skip: !isWin }, async () => {
  // The assertion is that the call REACHES the method — a resolution failure happens regardless of
  // where focus is, so no window is needed. Before the fix every one of these threw.
  const { keyPress } = await import('../plugins/computer-use/platform/win-input.js');
  const chords = ['enter', 'tab', 'escape', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'alt+tab',
    'shift+left', 'ctrl+shift+escape', 'f5', 'up', 'a'];
  for (const c of chords) {
    await assert.doesNotReject(() => keyPress(c), `keyPress(${JSON.stringify(c)}) must not throw`);
  }
});

test('typing text works for ASCII, CJK and an astral character', { skip: !isWin }, async () => {
  const { typeText } = await import('../plugins/computer-use/platform/win-input.js');
  for (const s of ['hello', '中文测试', 'emoji 🎉', 'a"b\'c']) {
    const r = await typeText(s);
    assert.equal(typeof r.typed, 'number', `typeText(${JSON.stringify(s)}) reported a count`);
  }
});
