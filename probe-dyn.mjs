import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
function walk(dir, out=[]) {
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk('src');
const re = /import\s+(?:([^'"]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
const checks = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(src))) {
    const clause = (m[1]||'').trim();
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) continue;
    const mm = clause.match(/\{([^}]*)\}/);
    if (mm) {
      const names = mm[1].split(',').map(s=>s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      checks.push({f, target, names});
    }
  }
}
let bad = 0;
for (const c of checks) {
  try {
    const ns = await import(pathToFileURL(c.target).href);
    for (const n of c.names) {
      if (!(n in ns)) { console.log(`MISSING EXPORT: ${c.f} imports { ${n} } from ${path.relative('.',c.target)}`); bad++; }
    }
  } catch (e) {
    console.log(`IMPORT FAIL: ${path.relative('.',c.target)} imported by ${c.f}: ${e.message.split('\n')[0]}`);
    bad++;
  }
}
console.log(bad ? `${bad} problems` : 'ALL DYNAMIC CHECKS PASSED');
