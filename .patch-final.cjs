// Fix interrupt display and compact command + context size
const fs = require('fs');
let tui = fs.readFileSync('src/tui.js', 'utf8');
let agent = fs.readFileSync('src/agent.js', 'utf8');

// ---- 1. Remove "Interrupting..." notice, only show "interrupted" in red in AI output area ----
tui = tui.replace("notice('Interrupting…', 'info');\n        return;", "");
tui = tui.replace("notice('Interrupting…', 'info');\n        if (state.agent) state.agent.interrupt();", 
                  "if (state.agent) state.agent.interrupt();");

// Make "interrupted" RED instead of default gray
const oldInterruptMsg = "addChat({ role: 'system', text: 'Interrupted.' });";
const newInterruptMsg = "addChat({ role: 'system', text: C.red + 'interrupted' + C.reset });";
const n = tui.split(oldInterruptMsg).length - 1;
if (n !== 1) throw new Error('expected 1 match for Interrupted msg, found ' + n);
tui = tui.replace(oldInterruptMsg, newInterruptMsg);

// ---- 2. Set correct context size (4096 tokens max) ----
const ctxMatch = tui.match(/state\.ctxMax\s*=\s*\d+/);
if (ctxMatch) {
  const oldCtx = ctxMatch[0];
  tui = tui.replace(oldCtx, 'state.ctxMax = 4096; // max tokens for this session');
}

// ---- 3. Compact by AI output - add instruction to SYSTEM_PROMPT ----
const oldSystemPrompt = agent.match(/export const SYSTEM_PROMPT = `[\s\S]*?`;/);
if (!oldSystemPrompt) throw new Error('SYSTEM_PROMPT not found');
const newSystemPrompt = oldSystemPrompt[0].replace(
  /You are hncode, a coding agent running/,
  `You are hncode, a coding agent running. You must monitor your context usage. When you detect that you're approaching the context limit (see your last messages about token counts), you should proactively call /compact to reduce the conversation history.`
);
agent = agent.replace(oldSystemPrompt[0], newSystemPrompt);

// ---- 4. Add slice-compact command (manual compact of last 20%) ----
const oldCompactCase = "case 'compact': {\n      const msgs = session.messages || [];\n      if (msgs.length <= 2) { app('Nothing to compact yet.'); return; }\n      const keep = msgs.slice(-8);\n      const dropped = msgs.length - keep.length;\n      session.messages = keep;\n      state.chat = state.chat.slice(-8);\n      saveSession(session);\n      app(`Context compacted (dropped ${dropped} older messages${raw ? `; instruction: ${raw}` : ''}).`);\n      return;\n    }";
    
const newCompactCase = "case 'compact': {\n      const msgs = session.messages || [];\n      if (msgs.length <= 2) { app('Nothing to compact yet.'); return; }\n      const raw = args.trim();\n      const ratio = raw ? parseFloat(raw) : null; // optional slice ratio (0-1)\n      \n      if (ratio !== null) {\n        // Slice mode: drop last ratio portion\n        if (isNaN(ratio) || ratio <= 0 || ratio >= 1) { app('Invalid ratio; use 0-1 (e.g., 0.2 for 20%%)').return; }\n        const keepCount = Math.ceil(msgs.length * (1 - ratio));\n        const dropped = msgs.length - keepCount;\n        const kept = msgs.slice(0, keepCount);\n        const droppedText = kept.slice(-Math.max(1, Math.floor(dropped / 2))).map(m => m.content || m.text || '').join('\\n\\n');\n        const summary = `Context compacted: dropped last ${dropped} messages (${ratio*100}%). Previous context:\\n${droppedText}`;\n        msgs.splice(keepCount, dropped);\n        msgs.push({ role: 'system', content: summary });\n        state.chat = state.chat.slice(0, keepCount);\n        state.chat.push({ role: 'system', content: summary });\n      } else {\n        // Default mode: keep last 8 messages\n        const keep = msgs.slice(-8);\n        const dropped = msgs.length - keep.length;\n        session.messages = keep;\n        state.chat = state.chat.slice(-8);\n        const summary = `Context compacted (dropped ${dropped} older messages${raw ? '; custom' : ''}).`;\n        state.chat.push({ role: 'system', content: summary });\n      }\n      \n      saveSession(session);\n      state.tokens = estimateMessagesTokens(msgs);\n      app('OK');\n      return;\n    }";

const n2 = tui.split(oldCompactCase).length - 1;
if (n2 !== 1) throw new Error('expected 1 match for compact case, found ' + n2);
tui = tui.replace(oldCompactCase, newCompactCase);

fs.writeFileSync('src/tui.js', tui, 'utf8');
fs.writeFileSync('src/agent.js', agent, 'utf8');

console.log('ok: interrupt display fixed (red "interrupted" in chat)');
console.log('ok: context size set to 4096');
console.log('ok: compact supports /compact [ratio] for slice mode');
console.log('ok: AI instructed to compact proactively');
