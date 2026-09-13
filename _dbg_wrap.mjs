import { makeState, composeFrame } from 'file:///D:/hncode/src/tui.js';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

const cols = 60;
const s = makeState({cfg:{model:'m',maxContextTokens:100000},session:{workspace:'D:/hncode'},opts:{}});
s.cwd = 'D:/hncode';

for (const n of [53, 54, 55, 56, 57]) {
  s.input = 'A'.repeat(n);
  s.caret = n;
  const f = composeFrame(s, cols, 24);
  const rows = f.lines.map(strip).filter((l) => /^ │/.test(l));
  const counts = rows.map(r => [...r].filter(c => c === 'A').length);
  const totalA = counts.reduce((a,b) => a+b, 0);
  const wallPos = rows[0] ? rows[0].trimEnd().lastIndexOf('│') : -1;
  console.log(n, 'chars ->', rows.length, 'rows, A:', totalA, 'wall at:', wallPos);
}
