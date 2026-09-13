// Add orange color to nudge messages
const fs = require('fs');
let s = fs.readFileSync('src/tui.js', 'utf8');
const oldStr = "        if (e.type === 'nudge') {\n          // The model stopped without an answer; the agent told it to continue.\n          addChat({ role: 'system', text: `Turn ended without an answer (${e.reason}); asked the model to continue (${e.attempt}/${e.max}).` });\n          return;\n        }";
const newStr = "        if (e.type === 'nudge') {\n          // The model stopped without an answer; the agent told it to continue.\n          // Render in orange so it stands out from regular system messages.\n          const msg = `Turn ended without an answer (${e.reason}); asked the model to continue (${e.attempt}/${e.max}).`;\n          addChat({ role: 'system', text: C.yellow + msg + C.reset });\n          return;\n        }";
const n = s.split(oldStr).length - 1;
if (n !== 1) throw new Error('expected 1 match, found ' + n);
s = s.replace(oldStr, newStr);
fs.writeFileSync('src/tui.js', s, 'utf8');
console.log('ok: nudge orange');
