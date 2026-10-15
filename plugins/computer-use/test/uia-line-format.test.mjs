// The tree's line format is tab-separated, so no field may contain a tab or a newline.
//
// WHY THIS FILE EXISTS
// --------------------
// `Walk` builds one tab-separated line per element. `Name`, `AutomationId` and `ClassName` were
// scrubbed for tabs but NOT for CR or LF.
//
// A control's name genuinely can contain a newline — a multi-line tooltip or label — and that ended
// the line early. One element became two lines, everything after it shifted, and the resulting tree
// had a HOLE in its numbering: 200 elements parsed as 199 with index 126 missing, so resolving
// `[126]` found nothing. Measured on a live window at maxNodes 200, 400 and 1200; the fix also
// brought back 3 elements that had been silently lost.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('plugins/computer-use/platform/win-uia.js');
const src = fs.readFileSync(SRC, 'utf8');

/** The PowerShell walk template as it appears in the source. */
function walkTemplate() {
  const a = src.indexOf('const WALK = `');
  const b = src.indexOf('`;', a);
  assert.ok(a > 0 && b > a, 'the WALK template is present');
  return src.slice(a + 'const WALK = `'.length, b);
}
const walk = walkTemplate();

/** The line builder itself, from `$line = (` to the end of the assignment. */
function lineBuilder() {
  const a = walk.indexOf('$line = (');
  assert.ok(a > 0, 'the line builder is present');
  // The assignment ends at the line containing `$txt))`.
  const b = walk.indexOf('(Scrub $txt))', a);
  assert.ok(b > a, 'the builder ends where the last field is written');
  return walk.slice(a, b + '(Scrub $txt))'.length);
}

test('every text field is written through the scrub', () => {
  // The defect was an INCONSISTENCY: two fields were scrubbed for tabs, CR and LF, the others only
  // for tabs. So the property is not "a scrub exists" but "no field escapes it".
  const builder = lineBuilder();
  for (const field of ['$nm', '$aid', '$cls', '$val', '$txt']) {
    assert.ok(builder.includes(`(Scrub ${field})`), `${field} is scrubbed`);
  }
});

test('no text field is interpolated into the line raw', () => {
  // Stated as an absence, so a field added later is caught too: inside the builder, a text variable
  // that is NOT wrapped in Scrub() is the bug.
  const withoutScrubbed = lineBuilder().replace(/\(Scrub \$\w+\)/g, '');
  for (const bare of ['$nm', '$aid', '$cls', '$val', '$txt']) {
    assert.ok(!withoutScrubbed.includes(bare),
      `${bare} reaches the line without the scrub: ${JSON.stringify(withoutScrubbed.slice(0, 140))}`);
  }
});

test('the scrub removes the separator AND both line endings', () => {
  // Three characters, and missing any one has a different effect: a tab adds COLUMNS, a CR or LF
  // adds LINES. Scrubbing the tab alone is what shipped.
  const at = walk.indexOf('function Scrub(');
  assert.ok(at > 0, 'Scrub is defined inside the template');
  const body = walk.slice(at, walk.indexOf('\n}', at));
  for (const ch of ['t', 'r', 'n']) {
    assert.ok(body.includes(`\\${ch}`) || body.includes(`\\\\${ch}`),
      `the character class covers \\${ch}: ${JSON.stringify(body)}`);
  }
  assert.match(body, /-replace/, 'and it is a replace, not a strip');
});

test('the root line is scrubbed too', () => {
  // Emitted by the script `getTree` builds, NOT inside the WALK template, so it must be looked for
  // in the whole source. It carries a window title, which can contain a newline as easily as any
  // control name — a title with a line break would corrupt the very first line of output.
  assert.match(src, /\(Scrub \$rootEl\.Name\)/, 'the window title is scrubbed');
});

test('the parse drops a line whose field count is wrong rather than guessing', async () => {
  // The other half of the contract: when a field DOES contain a separator, the parse must reject the
  // malformed line instead of building an element from shifted columns.
  const { parseElements } = await import('../plugins/computer-use/platform/win-uia.js');
  const good = '0\t1\tButton\tok\t\taid\t0\t0\t10\t10\tTrue\t\t';
  const short = '0\t1\tButton\tok';
  const out = parseElements([good, short].join('\n'));
  assert.equal(out.length, 1, 'the short line was dropped');
  assert.equal(out[0].name, 'ok', 'and the good line parsed');
});
