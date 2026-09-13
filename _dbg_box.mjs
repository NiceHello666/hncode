import { makeState, composeFrame } from 'file:///D:/hncode/src/tui.js';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const s = makeState({ cfg: { model: 'm', maxContextTokens: 100000 }, session: { workspace: 'D:/hncode' }, opts: {} });
s.cwd = 'D:/hncode';
s.chat.push({ role: 'user', text: 'first line\nsecond line\nthird line' });
const rows = composeFrame(s, 60, 20).lines.map(strip).filter((l) => l.trim());
rows.forEach((r, i) => {
  const t = r.trim();
  console.log(i, 'top=', /^╭─+╮$/.test(t), 'bot=', /^╰─+╯$/.test(t), JSON.stringify(t.slice(0, 24)));
});
