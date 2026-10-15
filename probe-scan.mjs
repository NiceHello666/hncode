import fs from 'node:fs';
import path from 'node:path';
function walk(dir, out=[]) {
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk('src');
const probs = [];
const re = /import\s+(?:([^'"]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(src))) {
    const clause = (m[1]||'').trim();
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) { probs.push(`MISSING FILE: ${f} -> ${spec}`); continue; }
    if (clause) {
      const mm = clause.match(/\{([^}]*)\}/);
      if (mm) {
        const names = mm[1].split(',').map(s=>s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        const tsrc = fs.readFileSync(target,'utf8');
        for (const n of names) {
          const exps = new Set();
          for (const em of tsrc.matchAll(/export\s*\{([^}]*)\}/g)) {
            for (const part of em[1].split(',')) {
              const p = part.trim(); if (!p) continue;
              exps.add(p.split(/\s+as\s+/).pop().trim());
            }
          }
          for (const em of tsrc.matchAll(/export\s+(?:const|let|var|function|class|async function)\s+([A-Za-z0-9_$]+)/g)) exps.add(em[1]);
          let star = false;
          for (const em of tsrc.matchAll(/export\s+\*\s+from/g)) star = true;
          if (!exps.has(n) && !star) probs.push(`SUSPECT NAME: ${f} imports { ${n} } from ${spec} not found`);
          else if (!exps.has(n) && star) probs.push(`STAR: ${f} imports { ${n} } from ${spec} (target uses export *)`);
        }
      }
    }
  }
}
console.log(probs.join('\n') || 'NO STATIC PROBLEMS');
console.log('---total files', files.length);
