import fs from 'node:fs';
const p = 'D:/hncode/src/tui.js';
let s = fs.readFileSync(p, 'utf8');
const from = 'if (cur === \'yolo\' && isInsideWorkspace(toolName, args)) return true;';
const to = 'if (cur === \'yolo\' && isInsideWorkspace(state, toolName, args)) return true;';
if (!s.includes(from)) { console.error('anchor missing'); process.exit(1); }
s = s.replace(from, to);
fs.writeFileSync(p, s, 'utf8');
const back = fs.readFileSync(p, 'utf8');
console.log('fixed:', back.includes("isInsideWorkspace(state, toolName, args)"));
