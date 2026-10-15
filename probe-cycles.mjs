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
const re = /import\s+[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const adj = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const deps = new Set();
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1]||m[2]||m[3];
    if (!spec.startsWith('.')) continue;
    const t = path.resolve(path.dirname(f), spec);
    if (fs.existsSync(t)) deps.add(t);
  }
  adj.set(path.resolve(f), deps);
}
// find cycles via DFS
const cycles = [];
const stack = []; const inStack = new Set(); const done = new Set();
function dfs(node) {
  if (inStack.has(node)) {
    cycles.push(stack.slice(stack.indexOf(node)).concat(node));
    return;
  }
  if (done.has(node)) return;
  inStack.add(node); stack.push(node);
  for (const d of (adj.get(node)||[])) dfs(d);
  stack.pop(); inStack.delete(node); done.add(node);
}
for (const f of adj.keys()) dfs(f);
if (!cycles.length) console.log('NO CYCLES');
const seen = new Set();
for (const c of cycles) {
  const key = [...c].sort().join('|');
  if (seen.has(key)) continue; seen.add(key);
  console.log('CYCLE:', c.slice(0,-1).map(p=>path.relative('src',p)).join(' -> '), '-> back');
}
