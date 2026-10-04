// The painted screen must equal the frame, on terminals that do NOT cancel the
// pending-wrap flag on a cursor move.
//
// WHY THIS IS TESTED AGAINST A TERMINAL MODEL
// -------------------------------------------
// `diffFrame` is a DIFFERENTIAL painter: it writes only the rows that changed and
// assumes nothing else has touched the screen. The frame it compares against is the one
// it BELIEVES it painted, never the real one — so any disagreement between that belief
// and the terminal is permanent, and shows up as stray characters until something forces
// a full repaint (re-entering the session, a resize).
//
// The trigger is a terminal that keeps the "pending wrap" flag when a printed character
// fills the last column. Every row composeFrame produces is EXACTLY `cols` columns wide
// (the frame is padded), so writing one fills that column EVERY time, and the next row's
// first character then wraps to the line below. The frame after that is shifted by a row,
// and this painter never notices. The reported symptom was a few characters of the last
// reply stranded on screen — sometimes a lone wide glyph, sometimes a stray `a` or `7` —
// gone after re-entering the session.
//
// So the contract is not "the output string looks right" but "a terminal, played
// faithfully, shows exactly what the frame says". The model below deliberately implements
// the WORST behaviour (no cursor sequence clears the flag) so the guarantee does not
// depend on the emulator being well-behaved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFrame, diffFrame, makeState } from '../src/tui.js';
import { visualWidth } from '../src/term.js';

const ESC = '\x1b';
const stripAll = (s) => String(s)
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

/**
 * A terminal with autowrap, a bottom margin that SCROLLS, and — the point of this test —
 * a pending-wrap flag that NOTHING clears except a carriage return, a line feed, or a
 * printed character consuming it. That is stricter than any real emulator, which is what
 * makes it a useful adversary.
 */
class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
    this.r = 0;
    this.c = 0;
    this.pendingWrap = false;
    this.scrolls = 0;
  }

  put(ch, w) {
    if (this.pendingWrap) {
      this.c = 0;
      this.r += 1;
      this.pendingWrap = false;
      this.scroll();
    }
    if (w === 2) {
      this.cells[this.r][this.c] = ch;
      if (this.c + 1 < this.cols) this.cells[this.r][this.c + 1] = '';
      this.c += 2;
    } else {
      this.cells[this.r][this.c] = ch;
      this.c += 1;
    }
    if (this.c >= this.cols) { this.c = this.cols - 1; this.pendingWrap = true; }
  }

  scroll() {
    if (this.r < this.rows) return;
    this.cells.shift();
    this.cells.push(Array.from({ length: this.cols }, () => ' '));
    this.r = this.rows - 1;
    this.scrolls++;
  }

  write(s) {
    let i = 0;
    while (i < s.length) {
      if (s[i] === ESC) {
        let m = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(s.slice(i));
        if (m) {
          const params = m[1];
          const final = m[2];
          if (final === 'H' || final === 'f') {
            const p = params.split(';');
            this.r = Math.max(0, Math.min(this.rows - 1, Number(p[0] || 1) - 1));
            this.c = Math.max(0, Math.min(this.cols - 1, Number(p[1] || 1) - 1));
            // NOTE: pending wrap is deliberately NOT cleared here.
          } else if (final === 'K') {
            const mode = params === '' ? 0 : Number(params);
            const from = mode === 0 ? this.c : 0;
            for (let c = from; c < this.cols; c++) this.cells[this.r][c] = ' ';
            // NOTE: nor here.
          }
          i += m[0].length;
          continue;
        }
        m = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
        if (m) { i += m[0].length; continue; }
        i += 1;
        continue;
      }
      if (s[i] === '\n') { this.r += 1; this.c = 0; this.pendingWrap = false; this.scroll(); i++; continue; }
      if (s[i] === '\r') { this.c = 0; this.pendingWrap = false; i++; continue; }
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const w = visualWidth(ch);
      if (w > 0) this.put(ch, w);
      i += cp > 0xffff ? 2 : 1;
    }
  }

  rowText(r) {
    let out = '';
    for (let c = 0; c < this.cols; c++) {
      const cell = this.cells[r][c];
      if (cell === '') continue;
      out += cell;
    }
    return out;
  }
}

const cfg = {
  model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: '/w',
  raw: { providers: {}, models: { 'p/m': {} } },
};

const COLS = 80;
const ROWS = 24;

/** Drive `steps` frames through the painter into a Screen, comparing after each. */
function replay(setup, steps) {
  const st = makeState({ cfg, session: { messages: [] }, opts: {} });
  st.tip = '';
  setup(st);
  const screen = new Screen(COLS, ROWS);
  let prev = null;
  const problems = [];
  steps.forEach((mutate, idx) => {
    mutate(st);
    const frame = composeFrame(st, COLS, ROWS);
    const out = diffFrame(prev, frame);
    prev = frame;
    if (out) screen.write(out);
    for (let r = 0; r < ROWS; r++) {
      const want = stripAll(frame.lines[r]);
      const got = screen.rowText(r);
      if (want !== got && problems.length < 5) {
        problems.push(`step ${idx} row ${r}\n      frame : ${JSON.stringify(want)}\n      screen: ${JSON.stringify(got)}`);
      }
    }
  });
  return { problems, screen };
}

test('a full-width row followed by another row does not spill onto the next line', () => {
  // The minimal case: two frames, the first of which fills the last column. Without the
  // carriage return the second row's first character wraps and the row lands one line
  // too low — the seed of every larger desync.
  const { problems } = replay(
    (st) => { st.chat = [{ role: 'assistant', text: 'first' }]; st.running = false; },
    [
      null,
      (st) => { st.chat = [{ role: 'assistant', text: 'second' }]; },
      (st) => { st.chat = [{ role: 'assistant', text: 'third' }]; },
    ].filter(Boolean),
  );
  assert.deepEqual(problems, [], 'rows spilled to the wrong line');
});

test('a streaming CJK reply paints exactly what the frame says', () => {
  // Wide glyphs, markdown headings and a growing row count — the shape a real reply has,
  // and the one the stray characters were reported on.
  const reply = '我来看看这个配置。\n\n## 检查\n- `src/config.js` 里的 provider 列表\n\n'
    + '然后修改它，这是一段比较长的中文说明文字，让行宽接近终端宽度。';
  const { problems } = replay(
    (st) => { st.chat = [{ role: 'user', text: '帮我看看配置' }, { role: 'assistant', text: '' }]; st.running = true; },
    Array.from({ length: reply.length }, (_, i) => (st) => {
      st.chat[st.chat.length - 1].text = reply.slice(0, i + 1);
      st.chat[st.chat.length - 1]._cache = null;
      st.spin = i;
    }),
  );
  assert.deepEqual(problems, [], 'the painted screen diverged from the frame');
});

test('a picker composited over the transcript paints exactly what the frame says', () => {
  // Exercises the cell-layer composite and the gutter blanking, both of which rewrite
  // rows the painter had already compared, plus the backdrop dimming on every row.
  const { problems } = replay(
    (st) => {
      st.chat = [{ role: 'user', text: '选择' }, { role: 'assistant', text: '' }];
      st.running = true;
      st.picker = {
        title: '选择模型 pick', sel: 0, searchable: true,
        items: [{ label: '模型甲 model-alpha' }, { label: '模型乙 model-beta' }],
      };
    },
    Array.from({ length: 40 }, (_, i) => (st) => {
      st.chat[st.chat.length - 1].text += '内容';
      st.chat[st.chat.length - 1]._cache = null;
      st.spin = i;
    }),
  );
  assert.deepEqual(problems, [], 'the painted screen diverged from the frame');
});

test('a growing reasoning block paints exactly what the frame says', () => {
  // The path the stray characters were actually reported on. A pending `thinking` block
  // carries a live spinner: the row is CACHED with a zero-width placeholder and the real
  // glyph is substituted in afterwards (`SPIN_PLACEHOLDER`, one column wide once
  // substituted), so the row's own content shifts by a column as the tick advances while
  // its text is still growing. Combined with the pending-wrap flag that is a lot of
  // moving parts, so it gets its own replay.
  const thinking = "Anthropic's input_json_delta is the official event name for partial "
    + 'tool input; the reply text below it keeps growing while the spinner ticks.';
  const { problems } = replay(
    (st) => {
      st.chat = [{ role: 'user', text: '问题' }, { role: 'thinking', text: '', pending: true, spin: 0 }];
      st.running = true;
    },
    Array.from({ length: thinking.length }, (_, i) => (st) => {
      st.chat[1].text = thinking.slice(0, i + 1);
      st.chat[1]._cache = null;
      st.chat[1].spin = i;
      st.spin = i;
    }),
  );
  assert.deepEqual(problems, [], 'the painted screen diverged from the frame');
});

test('scrolling and resizing repaint every row that changed', () => {
  const { problems } = replay(
    (st) => {
      st.chat = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第 ${i} 行中文，用来把正文撑满。` }));
      st.running = true;
    },
    Array.from({ length: 40 }, (_, i) => (st) => {
      st.spin = i;
      st.scroll = i < 15 ? 0 : (i < 30 ? 5 : 0);
    }),
  );
  assert.deepEqual(problems, [], 'the painted screen diverged from the frame');
});

test('every written row ends with a carriage return', () => {
  // The mechanism, pinned directly so a refactor of the loops cannot silently drop it.
  // Both the full-repaint path and the changed-span path must emit it.
  const prev = null;
  const st = makeState({ cfg, session: { messages: [] }, opts: {} });
  st.tip = '';
  st.chat = [];
  const frame = composeFrame(st, COLS, ROWS);
  const full = diffFrame(prev, frame);
  const rows = (full.match(/\x1b\[\d+;1H\x1b\[2K/g) || []).length;
  const crs = (full.match(/\r/g) || []).length;
  assert.ok(rows > 0, 'the full repaint wrote rows');
  assert.equal(crs, rows, `every written row must end with a CR (${rows} rows, ${crs} CRs)`);

  // The incremental path: change one row and check its write carries the CR.
  const next = composeFrame(Object.assign(st, { chat: [{ role: 'assistant', text: 'x' }] }), COLS, ROWS);
  const inc = diffFrame(frame, next);
  const incRows = (inc.match(/\x1b\[\d+;1H\x1b\[2K/g) || []).length;
  const incCrs = (inc.match(/\r/g) || []).length;
  assert.ok(incRows > 0, 'the incremental repaint wrote rows');
  assert.equal(incCrs, incRows, `every written row must end with a CR (${incRows} rows, ${incCrs} CRs)`);
});