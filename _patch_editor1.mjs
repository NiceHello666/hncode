// Add a multiline TEXT EDITOR overlay (`state.editor`) and use it for
// /set-system-prompt, plus a /cool-mode toggle.
//
//   /set-system-prompt          -> opens an editor preloaded with the current
//                                  system prompt (the custom one if set, else the
//                                  built-in). Ctrl+S saves, Esc cancels.
//   /cool-mode [on|off]         -> toggles a terse-reply mode; the flag is
//                                  persisted and an instruction is injected into
//                                  every request while it is on.
import fs from 'node:fs';

const file = 'D:/hncode/src/tui.js';
let src = fs.readFileSync(file, 'utf8');

// ---- 1. the editor's rendering lives beside the panel's ----
const anchor = '  if (state.panel) {\n'
  + '    const p = state.panel;\n';
if (!src.includes(anchor)) { console.error('ABORT: panel render anchor missing'); process.exit(1); }
src = src.replace(anchor,
  '  if (state.editor) {\n'
  + '    const ed = state.editor;\n'
  + '    const rule = col(\u2500'.repeat(1) ? '' : '', C.border); // placeholder
  + '  } else if (state.panel) {\n'
  + '    const p = state.panel;\n');

fs.writeFileSync(file, src, 'utf8');
console.log('stub inserted (will be replaced next patch)');
