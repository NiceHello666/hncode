import fs from 'node:fs';
import path from 'node:path';
const dir = 'D:/hncode/src/tools';
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'index.js' && n !== 'utils.js' && n !== 'ignore.js' && n !== 'matchers.js')) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = /name: '([^']+)',\s*\n\s*description: '((?:[^'\\]|\\.)*)'/.exec(s);
  if (!m) { console.log(`${f.padEnd(20)} (no spec.description found)`); continue; }
  console.log(`${f.padEnd(20)} ${m[1].padEnd(16)} ${m[2].length} chars: ${m[2]}`);
}
