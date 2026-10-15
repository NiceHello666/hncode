// Steps must report the images its steps captured.
//
// WHY THIS FILE EXISTS
// --------------------
// The point of running several steps in one call is to keep the intermediate states out of the
// conversation. A screenshot step therefore returned its PNG path INSIDE the summary text, where it
// read as one more line of output — the model had to notice it and work out that it was a picture
// worth attaching. Extracting the path and listing the images separately is what makes them usable.
//
// The extraction is the part that can be wrong in a way nobody notices: a path containing a space is
// common on Windows (`C:\Users\John Smith\...`), and a whitespace split truncates it to its last
// word — yielding a path that looks plausible and does not exist. A test that only used paths
// without spaces would pass while every real capture failed to attach.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('plugins/computer-use/index.js');
const src = fs.readFileSync(SRC, 'utf8');

/** The path-extraction block, taken from the source so the test cannot drift from it. */
function extractor() {
  const a = src.indexOf('const shot = (() => {');
  assert.ok(a > 0, 'the extraction is present');
  const b = src.indexOf('})();', a) + 5;
  return new Function('out', `${src.slice(a, b)}\nreturn shot;`);
}

const extract = extractor();

test('a captured PNG path is found in a step result', () => {
  const out = { text: 'Screenshot of 60x40 at (0,0): C:\\Temp\\region-1.png\n60x40 pixels, 3 KB' };
  assert.equal(extract(out), 'C:\\Temp\\region-1.png');
});

test('a path WITH A SPACE is not truncated', () => {
  // The defect this guards. A whitespace split returns "shot.png" or "Smith\\shot.png" — plausible
  // enough that a reader would not question it, and no such file exists.
  assert.equal(extract({ text: 'C:\\Users\\John Smith\\AppData\\temp\\shot.png' }),
    'C:\\Users\\John Smith\\AppData\\temp\\shot.png');
  assert.equal(extract({ text: 'Screenshot: C:\\a b\\shot.png (60x40)' }), 'C:\\a b\\shot.png');
});

test('a POSIX path works too', () => {
  assert.equal(extract({ text: 'Screenshot:\n/tmp/hncode/region-3.png\n100x50 pixels' }),
    '/tmp/hncode/region-3.png');
});

test('the label before the path is not swallowed', () => {
  // `Screenshot of 60x40 at (0,0): ` ends with a colon, and so does `C:`. Walking back must stop at
  // the label's colon — the one followed by a space — and not at the drive letter's.
  assert.equal(extract({ text: 'Screenshot of 60x40 at (0,0): C:\\Temp\\r.png\n60x40' }),
    'C:\\Temp\\r.png');
});

test('a result with no image yields nothing', () => {
  // The other direction: a step that merely mentions the word must not produce a bogus image.
  for (const text of [
    'Desktop: 1920x1080, origin at 0,0',
    '5 element(s) in window 123:\n[0] Button "Save"',
    'Interrupted by user.',
    '',
  ]) {
    assert.equal(extract({ text }), null, `no path in ${JSON.stringify(text)}`);
  }
});

test('the images are listed at the END, not buried in the summary', () => {
  // A path in the middle of a sequence reads as ordinary output. The final section is what makes it
  // unmistakable, and it names the tool that produced it.
  assert.match(src, /image\(s\) captured\. Attach each with ReadMediaFile/,
    'the result frames the images explicitly');
  assert.match(src, /images\.map\(\(im\) => `  step \$\{im\.step\} \(\$\{im\.tool\}\): \$\{im\.path\}`\)/,
    'each image is listed with its step and tool');
  // And the section comes after the step lines, not before them.
  const headAt = src.indexOf('const head = failed');
  const shotsAt = src.indexOf('const shots = images.length');
  assert.ok(shotsAt > headAt, 'the images come after the step summary');
});

test('the collection does not lose an image when several steps capture', () => {
  // `push` into an array, not an overwrite — two Screenshot steps must yield two entries.
  assert.match(src, /images\.push\(\{ step: i \+ 1, tool: name, path: shot \}\)/, 'it appends');
  assert.doesNotMatch(src, /images = \{/, 'and does not assign a single object');
});
