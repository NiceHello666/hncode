import fs from 'node:fs';
const L = fs.readFileSync('src/tools/agent.js', 'utf8').split(/\r?\n/);

// Every return in the foreground path, and what a subagent failure produces.
const at = L.findIndex((l) => /const runPromise = runSubagent\(/.test(l));
console.log(`runSubagent at ${at + 1}\n`);

L.forEach((l, i) => {
  if (i < at - 20) return;
  if (/return |catch|\.ok|error/.test(l)) console.log(`  ${i + 1} ${l.trim().slice(0, 96)}`);
});
