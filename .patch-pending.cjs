// Fix pending state for tool calls
const fs = require('fs');
let tui = fs.readFileSync('src/tui.js', 'utf8');
let agent = fs.readFileSync('src/agent.js', 'utf8');

// ---- 1. In TUI: set pending=true when tool_use event arrives ----
const oldToolUse = "          const entry = [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.id === e.id)\n            || [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.toolName === e.name);\n          if (entry) {\n            entry.toolArgs = e.args || {};";
const newToolUse = "          const entry = [...state.chat].reverse().find((m) => m.role === 'tool' && m.id === e.id)\n            || [...state.chat].reverse().find((m) => m.role === 'tool' && m.toolName === e.name);\n          if (entry) {\n            entry.pending = true; // mark as running so \"Using\" shows\n            entry.toolArgs = e.args || {};";
const n1 = tui.split(oldToolUse).length - 1;
if (n1 !== 1) throw new Error('expected 1 match for tool_use handler, found ' + n1);
tui = tui.replace(oldToolUse, newToolUse);

// ---- 2. In Agent: create tool messages with pending=true initially ----
const oldToolCreate = "        chat.push({ role: 'tool', toolName: tc.name, toolArgs: tc.args || {}, pending: false });";
const newToolCreate = "        chat.push({ role: 'tool', toolName: tc.name, toolArgs: tc.args || {}, pending: true });";
const n2 = agent.split(oldToolCreate).length - 1;
if (n2 !== 1) throw new Error('expected 1 match for tool message creation, found ' + n2);
agent = agent.replace(oldToolCreate, newToolCreate);

fs.writeFileSync('src/tui.js', tui, 'utf8');
fs.writeFileSync('src/agent.js', agent, 'utf8');

console.log('ok: tool_use now sets pending=true');
console.log('ok: tool messages created with pending=true');
