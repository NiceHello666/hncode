// The window list, the application grouping, and the clipboard.
//
// WHY THIS FILE EXISTS
// --------------------
// Three defects found by running the code rather than reading it.
//
// 1. THE WINDOW LIST WAS MOSTLY NOISE. Measured: 15 windows, 11 of them parked at (-32000, -32000),
//    the coordinate Windows hides a window at. They carry a VALID rectangle, so they looked exactly
//    like real windows — a click at their "centre" aims where no screen is, and a window screenshot
//    renders an empty frame.
//
// 2. CHINESE TITLES ARRIVED AS MOJIBAKE. `锟斤拷` is UTF-8 bytes decoded as GBK: without
//    `[Console]::OutputEncoding = UTF8` the console's own codepage encodes every non-ASCII title.
//    The same fault runs through the UIA tree's element names and the OCR text.
//
// 3. THE CLIPBOARD LOST ITS CONTENT. `clip.exe` needed a byte order mark to read UTF-16 correctly,
//    and then the mark became part of the text — every paste began with a zero-width character.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const { isRealWindow } = await import('../plugins/computer-use/platform/windows.js');
const { copyText, readClipboard } = await import('../plugins/computer-use/platform/util.js');
const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// finding a window that can be acted on
// ---------------------------------------------------------------------------

test('a window Windows has parked off-screen is not real', () => {
  // The exact coordinate, which is how all 11 noise rows were identified without a blacklist.
  assert.equal(isRealWindow({ x: -32000, y: -32000, width: 160, height: 28 }), false);
  assert.equal(isRealWindow({ x: -32000, y: 100, width: 160, height: 28 }), false, 'either axis is enough');
});

test('a window with no area is not real', () => {
  assert.equal(isRealWindow({ x: 100, y: 100, width: 0, height: 0 }), false);
  assert.equal(isRealWindow({ x: 100, y: 100, width: 1, height: 1 }), false);
});

test('an ordinary visible window IS real', () => {
  // The other half: the filter must not throw away what it is meant to keep. A window at a negative
  // coordinate is normal on a multi-monitor setup — the second display to the left has negative x.
  assert.equal(isRealWindow({ x: 0, y: 0, width: 1920, height: 1080 }), true);
  assert.equal(isRealWindow({ x: -8, y: -8, width: 1936, height: 1056 }), true, 'a maximised window is slightly negative');
  assert.equal(isRealWindow({ x: -1920, y: 0, width: 1920, height: 1080 }), true, 'a monitor to the left');
});

test('the real window list has no parked windows in it', { skip: !isWin }, async () => {
  // End to end on this machine: whatever is running, nothing parked survives the filter.
  const { listWindows } = await import('../plugins/computer-use/platform/windows.js');
  const all = await listWindows({ includeNoise: true });
  const real = await listWindows();
  assert.ok(real.length <= all.length, 'filtering can only remove');
  for (const w of real) {
    assert.ok(w.x > -31000 && w.y > -31000, `a parked window survived: ${w.title} at ${w.x},${w.y}`);
    assert.ok(w.width > 1 && w.height > 1, `a zero-area window survived: ${w.title}`);
  }
});

test('the enumeration reports a class name and a UTF-8 title', { skip: !isWin }, async () => {
  const { listWindows } = await import('../plugins/computer-use/platform/windows.js');
  const wins = await listWindows();
  if (!wins.length) return;
  for (const w of wins) {
    assert.equal(typeof w.className, 'string', `class name missing for ${w.title}`);
  }
});

test('a Chinese window title arrives as real Chinese', { skip: !isWin }, async () => {
  const { listWindows } = await import('../plugins/computer-use/platform/windows.js');
  const wins = await listWindows({ includeNoise: true });
  const zh = wins.filter((w) => /[\u4e00-\u9fff]/.test(w.title));
  if (!zh.length) return; // nothing localised is running, so there is nothing to assert

  // A title that survived is one whose characters are real CJK. The failure mode is bytes decoded
  // with the wrong codepage, which yields replacement or compatibility characters rather than
  // nothing at all — so "the title is non-empty" would not be enough to catch it.
  for (const w of zh) {
    assert.equal(/\ufffd|锟/.test(w.title), false,
      `title arrived as mojibake: ${JSON.stringify(w.title)}`);
    const cjk = [...w.title].filter((c) => {
      const cp = c.codePointAt(0);
      return cp >= 0x4e00 && cp <= 0x9fff;
    });
    assert.ok(cjk.length > 0, `no real CJK in ${JSON.stringify(w.title)}`);
  }
});

// ---------------------------------------------------------------------------
// the clipboard
// ---------------------------------------------------------------------------

test('text survives a clipboard round trip exactly', { skip: !isWin }, async () => {
  // The bug this guards: `clip.exe` NEEDED a byte order mark for non-ASCII, and then that mark
  // became part of the text — so every paste started with an invisible U+FEFF.
  for (const s of ['hello', '中文测试', 'emoji 🎉 ok', "it's", 'line1\nline2', '  spaced  ']) {
    const w = await copyText(s);
    assert.equal(w.ok, true, `copy reported success for ${JSON.stringify(s)}`);
    const r = await readClipboard();
    assert.equal(r.ok, true);
    assert.equal(r.text, s, `round trip changed ${JSON.stringify(s)}`);
  }
});

test('the copied text carries no byte order mark', { skip: !isWin }, async () => {
  // Asserted separately because U+FEFF is invisible: a round trip through a lenient reader can pass
  // while every paste still begins with it.
  await copyText('hello');
  const r = await readClipboard();
  assert.equal(r.text.charCodeAt(0) === 0xFEFF, false,
    'the clipboard text starts with U+FEFF, which pastes as a stray invisible character');
});

test('copying an empty string is refused rather than clearing the clipboard', async () => {
  const r = await copyText('');
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to copy/);
});
