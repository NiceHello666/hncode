// Fix: Remove nudge from user view + smarter guard for tool execution
const fs = require('fs');
let agent = fs.readFileSync('src/agent.js', 'utf8');
let tui = fs.readFileSync('src/tui.js', 'utf8');

// ---- 1. Don't show nudge message to user (remove the chat entry) ----
// The nudge is internal only - we just continue the loop without adding it to chat
const oldNudgeEvent = "        if (why && nudges < MAX_NUDGES) {\n          nudges++;\n          this.onEvent({ type: 'nudge', reason: why, attempt: nudges, max: MAX_NUDGES });\n          // Merge into the previous user turn when there is one: two consecutive\n          // user messages are rejected by providers that require role alternation.\n          const last = this.messages[this.messages.length - 1];\n          const body = nudgeMessage(why);\n          if (last && last.role === 'user' && typeof last.content === 'string') last.content += '\\n\\n' + body;\n          else this.messages.push({ role: 'user', content: body });\n          continue;\n        }";

const newNudgeEvent = "        if (why && nudges < MAX_NUDGES) {\n          nudges++;\n          // Don't add nudge to chat - it's an internal signal to continue the turn\n          const last = this.messages[this.messages.length - 1];\n          const body = nudgeMessage(why);\n          if (last && last.role === 'user' && typeof last.content === 'string') last.content += '\\n\\n' + body;\n          else this.messages.push({ role: 'user', content: body });\n          continue;\n        }";

const n1 = agent.split(oldNudgeEvent).length - 1;
if (n1 !== 1) throw new Error('expected 1 match for nudge event, found ' + n1);
agent = agent.replace(oldNudgeEvent, newNudgeEvent);

// ---- 2. Smart guard: don't interrupt if tools are still running ----
// Check if any tool call has pending=true or if we're in a tool execution phase
const oldGuardCheck = "// ---- completion guard: never report \"done\" on an unfinished turn ----\n      // A turn is only complete when it ends with an actual answer text. Models\n      // may stop after reasoning only, or with an empty message, OR after tool calls\n      // without summarizing results. In those cases we inject a nudge and let the\n      // model try again. This guard applies ALWAYS, regardless of whether tool calls exist.";

const newGuardCheck = "// ---- completion guard: never report \"done\" on an unfinished turn ----\n      // A turn is only complete when it ends with an actual answer text. Models\n      // may stop after reasoning only, or with an empty message, OR after tool calls\n      // without summarizing results. In those cases we inject a nudge and let the\n      // model try again. But DON'T interrupt if tools are still executing (pending=true).\n      const hasPendingTools = (m) => Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.pending === true);\n      const anyToolRunning = [...state.chat].reverse().find((m) => m.role === 'assistant' && hasPendingTools(m));\n      if (anyToolRunning) {\n        // Tools are still executing - don't interrupt, let them finish first\n        break;\n      }";

const n2 = agent.split(oldGuardCheck).length - 1;
if (n2 !== 1) throw new Error('expected 1 match for guard check, found ' + n2);
agent = agent.replace(oldGuardCheck, newGuardCheck);

// ---- 3. Remove nudge display from TUI (no more orange message) ----
const oldNudgeDisplay = "        if (e.type === 'nudge') {\n          // The model stopped without an answer; the agent told it to continue.\n          // Render in orange so it stands out from regular system messages.\n          const msg = `Turn ended without an answer (${e.reason}); asked the model to continue (${e.attempt}/${e.max}).`;\n          addChat({ role: 'system', text: C.yellow + msg + C.reset });\n          return;\n        }";

const newNudgeDisplay = "        if (e.type === 'nudge') {\n          // Internal signal only - no UI update needed. The agent will continue automatically.\n          return;\n        }";

const n3 = tui.split(oldNudgeDisplay).length - 1;
if (n3 !== 1) throw new Error('expected 1 match for nudge display, found ' + n3);
tui = tui.replace(oldNudgeDisplay, newNudgeDisplay);

fs.writeFileSync('src/agent.js', agent, 'utf8');
fs.writeFileSync('src/tui.js', tui, 'utf8');

console.log('ok: nudge removed from user view');
console.log('ok: smart guard added (won\'t interrupt running tools)');
