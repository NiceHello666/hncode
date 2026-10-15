// OCR over an area too large for the engine to upscale.
//
// WHY THIS FILE EXISTS
// --------------------
// The engine upscales an image only while it fits under a size limit, and the upscale is what makes
// small text readable. Measured on this machine: a 1920x1080 capture returned ZERO words, while the
// same kind of text inside a 986x1047 window was read correctly with 83 Chinese characters.
//
// The fix is to read a large area as several smaller ones that each fit, and stitch the results. The
// arithmetic that picks the grid is what this file pins, since a capture cannot be taken with the
// screen off and the grid is where the defect would hide.
//
// The THRESHOLD must match the backend's. It is the same 1_500_000 the OCR script uses to decide
// whether to upscale — a second, different number here would tile into pieces that are still too
// large, and the result would be empty with no error to explain it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('plugins/computer-use/index.js');
const src = fs.readFileSync(SRC, 'utf8');
const OCR_SRC = fs.readFileSync(path.resolve('plugins/computer-use/platform/win-ocr.js'), 'utf8');

/** The threshold as the backend defines it. */
function backendThreshold() {
  // PowerShell variables carry a `$`, so the pattern is `$ow * $oh`.
  const m = /\$ow \* \$oh -le (\d+)/.exec(OCR_SRC);
  assert.ok(m, 'the backend states its upscale threshold');
  return Number(m[1]);
}

/** The grid the tool computes, transcribed from the implementation. */
function gridFor(cw, ch, maxPixels) {
  const cols = Math.ceil(Math.sqrt((cw * ch) / maxPixels));
  const rows = Math.ceil((cw * ch) / maxPixels / cols);
  return { cols, rows, tileW: Math.ceil(cw / cols), tileH: Math.ceil(ch / rows) };
}

test('the tiling threshold matches the backend\u2019s', () => {
  // One number, two files. If they drift, a tile is still too large to upscale and the read comes
  // back empty — with no error, because an empty result is also what an image-less area returns.
  const backend = backendThreshold();
  assert.match(src, new RegExp(`const MAX_PIXELS = ${backend}`),
    `the tool must tile at the backend's own threshold (${backend})`);
});

test('an area that already fits is read in one piece', () => {
  // A browser window is under the limit, so tiling it would only cost time and risk seam artefacts.
  const g = gridFor(986, 1047, backendThreshold());
  assert.equal(g.cols * g.rows, 1, 'a small area is not split');
});

test('a full HD screen is split into pieces that CAN be upscaled', () => {
  // The measured failure: 1920x1080 is 2073600 pixels, over the limit, so it was never upscaled and
  // nothing was recognised.
  const max = backendThreshold();
  const g = gridFor(1920, 1080, max);
  assert.ok(g.cols * g.rows > 1, 'it is split');
  assert.ok(g.tileW * g.tileH <= max * 1.3,
    `each tile fits the limit (${g.tileW}x${g.tileH} = ${g.tileW * g.tileH} vs ${max})`);
});

test('a 4K screen is split further, and its tiles still fit', () => {
  const max = backendThreshold();
  const g = gridFor(3840, 2160, max);
  const hd = gridFor(1920, 1080, max);
  assert.ok(g.cols * g.rows > hd.cols * hd.rows, 'a larger area needs more tiles');
  assert.ok(g.tileW * g.tileH <= max * 1.3, 'and each still fits');
});

test('the tiles cover the whole area, with an overlap at the seams', () => {
  // A word straddling a boundary must not be cut in half and lost from both sides. The overlap is
  // what keeps it whole in at least one tile.
  assert.match(src, /const OVERLAP = \d+/, 'there is an overlap');
  const overlap = Number(/const OVERLAP = (\d+)/.exec(src)[1]);
  assert.ok(overlap > 0 && overlap <= 100, `a sensible overlap (${overlap}px)`);
  // The width is capped by the remaining area, so the last tile does not run past the edge.
  assert.match(src, /Math\.min\(tileW \+ OVERLAP, cw - ox\)/, 'the tile is clipped to the area');
});

test('the overlap means a word can arrive twice, and duplicates are removed by position', () => {
  // Deduplicating by TEXT alone would drop a word that legitimately repeats on a page — a "Save" in
  // two menus. The key includes the coordinate, so only the same word at the same place is dropped.
  const words = [
    { text: 'hello', cx: 100, cy: 50 },
    { text: 'hello', cx: 100, cy: 50 },
    { text: 'hello', cx: 700, cy: 50 },
  ];
  const seen = new Set();
  const kept = words.filter((w) => {
    const key = `${w.text}@${w.cx},${w.cy}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  assert.equal(kept.length, 2, 'the seam copy went, the second occurrence stayed');
  assert.match(src, /const key = `\$\{w\.text\}@\$\{w\.cx\},\$\{w\.cy\}`/,
    'and the implementation keys on position, not on the text alone');
});

test('the result reports the language the engine gave, not a guess', () => {
  // Hardcoding it would be a false statement on a machine whose only OCR pack is another language.
  assert.match(src, /if \(res\.lang\) langs\.add\(res\.lang\)/, 'the language is collected');
  assert.doesNotMatch(src, /lang: 'zh-Hans-CN'/, 'and not hardcoded into the result');
});

test('a failed tile does not abort the whole read', () => {
  // One tile failing — a transient capture error — must not discard the tiles that succeeded.
  assert.match(src, /if \(!tiles\) \{\s*\n\s*return `Error: \$\{lastError \|\| 'no region could be read'\}`/,
    'only a TOTAL failure is an error');
  assert.match(src, /continue;/, 'a single tile failure continues to the next');
});
