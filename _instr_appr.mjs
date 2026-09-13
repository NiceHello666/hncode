import fs from 'node:fs';
const p = 'D:/hncode/src/tui.js';
let s = fs.readFileSync(p, 'utf8');
const anchor = "      if (cur === 'yolo' && isInsideWorkspace(state, toolName, args)) return true;";
if (!s.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
s = s.replace(anchor, anchor + `
      if (process.env.HNCODE_DEBUG_APPROVAL) {
        process.stderr.write('[dbg approval] mode=' + cur + ' tool=' + toolName
          + ' cwd=' + JSON.stringify(state.cwd) + ' ws=' + JSON.stringify(state.workspace)
          + ' addDirs=' + JSON.stringify(state.addDirs)
          + ' args=' + JSON.stringify(args)
          + ' inside=' + isInsideWorkspace(state, toolName, args) + '\\n');
      }`);
fs.writeFileSync(p, s, 'utf8');
console.log('instrumented');
