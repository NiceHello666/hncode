// Revert the queued-message auto-steer: a message typed while the agent runs must
// WAIT and become its own turn (the drain after agent.run()), not be folded into
// the running turn.
//
// My earlier attempt reworded the comment but left `state.agent.steer(text)` in
// place, so queued messages were still absorbed by the current turn. Ctrl-S stays
// the explicit "inject into the running turn now" shortcut.
import fs from 'node:fs';

const file = 'D:/hncode/src/tui.js';
let src = fs.readFileSync(file, 'utf8');

const from = '    if (state.running && state.agent) {\n'
  + '      state.queued.push(text);\n';
const at = src.indexOf(from);
if (at < 0) { console.error('ABORT: running branch not found'); process.exit(1); }
// find the end of this block (the next "\n    }\n" after it)
const end = src.indexOf('\n    }\n', at);
if (end < 0) { console.error('ABORT: block end not found'); process.exit(1); }
const before = src.slice(at, end + 6);

const after = '    if (state.running && state.agent) {\n'
  + '      state.queued.push(text);\n'
  + '      // QUEUED, not steered: the message waits and becomes its own turn once\n'
  + '      // this one finishes (the drain after agent.run()). It must NOT be handed\n'
  + '      // to the running turn — Ctrl-S is the explicit "inject it now" shortcut.\n'
  + '      renderFrame();\n'
  + '      return;\n'
  + '    }\n';

if (!/state\.agent\.steer\(text\)/.test(before)) {
  console.error('ABORT: no steer call inside the running branch; nothing to change');
  process.exit(1);
}
src = src.slice(0, at) + after + src.slice(end + 6);
fs.writeFileSync(file, src, 'utf8');

const back = fs.readFileSync(file, 'utf8');
console.log('removed auto-steer:', !/state\.agent\.steer\(text\);/.test(back));
console.log('still drains after run:', back.includes('becomes its own turn'));
console.log('Ctrl-S unaffected:', back.includes('state.agent.steer(text)') === false ? '(no bare steer left)' : '(check steerAll)');
