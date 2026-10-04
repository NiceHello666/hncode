// A picker's hint must advertise every key the picker actually handles, and stay
// short enough that the width clip cannot hide one.
//
// Why this is tested: the /provider picker grew an `onCtrlR` handler (re-fetch the
// provider's models) and an `onDelete` handler, but neither appeared in its hint
// line, so both features were invisible — a listener with no advertised shortcut is
// the same as no feature. The hint row is also CLIPPED (not wrapped) at the terminal
// width, so a hint that runs too long drops its tail off the right edge; the test
// pins the length so the keys stay visible at the narrowest width the UI targets.
//
// Testing principle: the assertion is derived from the source rather than hardcoded,
// so a future picker that adds a handler without updating its hint fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeState, composeFrame } from '../src/tui.js';
import { visualWidth } from '../src/term.js';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const visualLen = (s) => visualWidth(String(s == null ? '' : s));
const TUI = path.join(import.meta.dirname, '..', 'src', 'tui.js');
const src = fs.readFileSync(TUI, 'utf8');

/** Every openPicker({...}) body, with the handlers it defines and the hint it sets. */
function pickers() {
  const lines = src.split('\n');
  const out = [];
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (start < 0 && /openPicker\(\{/.test(l)) { start = i; depth = 0; }
    if (start < 0) continue;
    const stripped = l.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    for (const ch of stripped) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth <= 0 && i > start) {
      const body = lines.slice(start, i + 1).join('\n');
      const hint = (/hint:\s*'([^']*)'/.exec(body) || [])[1];
      const defines = (k) => new RegExp('\\n\\s*' + k + ':').test('\n' + body);
      out.push({
        line: start + 1,
        hint,
        handlers: {
          onCtrlR: defines('onCtrlR') ? 'Ctrl+R' : null,
          onCtrlE: defines('onCtrlE') ? 'Ctrl+E' : null,
          onDelete: defines('onDelete') ? 'Del' : null,
        },
      });
      start = -1;
    }
  }
  return out;
}

test('every picker handler is named in its hint', () => {
  const offenders = [];
  for (const p of pickers()) {
    const keys = Object.values(p.handlers).filter(Boolean);
    if (!keys.length) continue;
    const hint = p.hint || '';
    for (const k of keys) if (!hint.includes(k)) offenders.push(`tui.js:${p.line} defines ${k} but the hint omits it`);
  }
  assert.deepEqual(offenders, []);
});

test('the hint fits the narrowest terminal it is designed for', () => {
  // The hint row is clipped (not wrapped) at the terminal width, so it must fit the
  // narrowest terminal the UI targets. That is 60 columns — the frame's own floor is
  // 20 (tui.js `Math.max(20, cols)`), but that is a crash guard, not a usable layout,
  // and no real terminal is narrower than 60. The guessable keys (arrows, Esc,
  // "type to search") are what gets dropped first if a hint runs long.
  const MIN_TARGET_COLS = 60;
  for (const p of pickers()) {
    const keys = Object.values(p.handlers).filter(Boolean);
    if (!keys.length) continue;
    const hint = p.hint || '';
    assert.ok(visualLen(hint) <= MIN_TARGET_COLS,
      `tui.js:${p.line}: hint is ${visualLen(hint)} cols, past ${MIN_TARGET_COLS}: ${JSON.stringify(hint)}`);
    for (const k of keys) assert.ok(hint.includes(k), `tui.js:${p.line}: ${k} missing from hint`);
  }
});

test('the /provider hint advertises Ctrl+R and Del', () => {
  const p = pickers().find((x) => x.handlers.onCtrlR);
  assert.ok(p, 'the provider picker still defines onCtrlR');
  assert.match(p.hint, /Ctrl\+R/);
  assert.match(p.hint, /\bDel\b/);
});

test('rendering the provider hint at the target widths keeps both keys visible', () => {
  const p = pickers().find((x) => x.handlers.onCtrlR);
  const cfg = {
    model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
    maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
    raw: { providers: { alpha: { base_url: 'http://1/v1' } }, models: {} },
  };
  // 60 is the narrowest width the UI is designed for; below that the whole dialog
  // layout, not just this row, stops working.
  for (const cols of [60, 80, 100, 120]) {
    const st = makeState({ cfg, session: { messages: [] }, opts: {} });
    st.tip = '';
    st.chat = [{ role: 'user', text: 'hi' }];
    st.picker = { title: 'Select a provider', items: [{ label: 'alpha', sub: 'x' }], sel: 0, hint: p.hint, searchable: true };
    const row = (composeFrame(st, cols, 20).lines.map(plain).find((l) => /·/.test(l) && /Ctrl/.test(l)) || '');
    assert.match(row, /Ctrl\+R/, `${cols} cols lost Ctrl+R: ${JSON.stringify(row.trim())}`);
    assert.match(row, /Del/, `${cols} cols lost Del: ${JSON.stringify(row.trim())}`);
  }
});
