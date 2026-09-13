// Empirically find (layoutW, textW, trailSpaces) that gives: rows exactly 60 wide,
// right wall at col 59, and NO character truncation at any input length.
import { makeState, composeFrame } from 'file:///D:/hncode/src/tui.js';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// We can't easily parameterize the internals from outside, so instead we measure
// the CURRENT behaviour precisely to see what's wrong.
const cols = 60;
const s = makeState({cfg:{model:'m',maxContextTokens:100000},session:{workspace:'D:/hncode'},opts:{}});
s.cwd = 'D:/hncode';

console.log('--- current behaviour ---');
for (const n of [50, 52, 53, 54, 55, 56]) {
  s.input = 'A'.repeat(n);
  s.caret = n;
  const f = composeFrame(s, cols, 24);
  const rows = f.lines.map(strip).filter((l) => /^ │/.test(l));
  const counts = rows.map(r => [...r].filter(c => c === 'A').length);
  const total = counts.reduce((a,b)=>a+b,0);
  const wall0 = rows[0] ? rows[0].trimEnd().lastIndexOf('│') : -1;
  const lens = rows.map(r=>r.length);
  console.log(n, '-> rows', rows.length, 'A', total, counts.join(','), '| lens', lens.join(','), '| wall', wall0, total===n?'OK':'TRUNCATED');
}
