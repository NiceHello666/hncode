import { makeState, composeFrame } from 'file:///D:/hncode/src/tui.js';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const cols = 58;
function mk(msgs, input = '') {
  const s = makeState({ cfg: { model: 'm', maxContextTokens: 100000 }, session: { workspace: 'D:/hncode' }, opts: {} });
  s.cwd = 'D:/hncode';
  for (const m of msgs) s.chat.push(m);
  s.input = input; s.caret = input.length;
  return s;
}
const rows = (s) => composeFrame(s, cols, 24).lines.map(strip);

const s = mk([{ role: 'assistant', text: 'AAA' }, { role: 'user', text: 'HELLO_THERE' }], 'draft');
const r = rows(s);

// Find composer top
const msgRow = r.find((l) => l.includes('HELLO_THERE'));
console.log('msgRow idx:', r.indexOf(msgRow), JSON.stringify(msgRow));

const compTop = r.find((l) => (/^ ╭─+╮$/.test(l.trim()) || /^╭─+╮$/.test(l.trim())) && r.indexOf(l) > r.indexOf(msgRow));
console.log('compTop:', JSON.stringify(compTop));
console.log('compTop idx:', r.indexOf(compTop));

// List all rows with their indices
r.forEach((l, i) => {
  if (l.includes('╭')) console.log(i, 'box top', JSON.stringify(l.trimEnd()));
});
