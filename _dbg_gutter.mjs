import { makeState, composeFrame } from 'file:///D:/hncode/src/tui.js';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const s = makeState({ cfg: { model: 'm', maxContextTokens: 100000 }, session: { workspace: 'D:/hncode' }, opts: {} });
s.cwd = 'D:/hncode';
for (let i = 0; i < 40; i++) s.chat.push({ role: 'assistant', text: 'answer ' + i });
const raw = composeFrame(s, 60, 22).lines;
for (let i = 15; i < 22; i++) {
  console.log('row', String(i).padStart(2), 'len', strip(raw[i]).length, JSON.stringify(strip(raw[i]).slice(0, 58)));
}
