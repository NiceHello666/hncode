import { createRequire } from 'node:module';
const require = createRequire('file:///D:/hncode/');
const wcwidth = require('wcwidth');
import { makeState, composeFrame } from 'file:///D:/hncode/src/tui.js';
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const realW = (s) => { let w = 0; for (const ch of strip(s)) { const v = wcwidth(ch); w += (v === undefined ? 1 : v); } return w; };
const s = makeState({ cfg: { model: 'm', maxContextTokens: 100000 }, session: { workspace: 'D:/hncode' }, opts: {} });
s.cwd = 'D:/hncode';
s.chat.push({ role: 'assistant', text: 'AAA' });
s.chat.push({ role: 'user', text: 'HELLO_THERE' });
s.input = 'draft'; s.caret = 5;
const r = composeFrame(s, 58, 24).lines.map(strip);
const msgTop = r.find((l) => /^╭─+╮$/.test(l.trim()) || /^ ╭─+╮$/.test(l.trim()));
const compTop = r.find((l) => (l.includes('HELLO_THERE') ? false : false) || (l.trim() && /^╭─+╮$/.test(l.trim()) || /^ ╭─+╮$/.test(l.trim())));
// Just dump all rows for inspection
r.forEach((l, i) => {
  if (l.trim()) {
    const isTop = /^╭─+╮$/.test(l.trim()) || /^ ╭─+╮$/.test(l.trim());
    console.log(`row ${i}: width=${realW(l)} "${l.trimEnd().slice(0, 40)}" ${isTop ? '[TOP]' : ''}`);
  }
});
