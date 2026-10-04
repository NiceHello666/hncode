// The /btw box — a bordered panel docked ABOVE the composer, the way kimi's
// BtwPanelComponent is (see its `mount`, which adds the panel to
// `btwPanelContainer` and sets `editor.connectedAbove = true`).
//
// Why a docked box rather than a full-screen panel: the side conversation is
// something you have WHILE working, and the composer stays the place you type. In
// kimi the composer input IS the way to ask a follow-up — `sendUserInput` feeds the
// same panel — so the box sits directly above it and the editor is where you keep
// typing. A full-screen takeover hides the conversation being asked about, which is
// precisely the context a side question is about.
//
// Shape, matching kimi's renderer:
//
//   ╭ BTW ─ Esc close ─────────────────────────────╮
//   │ Q: what does the --retries flag do?          │
//   │ The `--retries` flag controls how many…      │
//   │                                              │
//   │ Q: and the timeout flag?                     │
//   │ It sets how long a run may take…             │
//   ╰──────────────────────────────────────────────╯
//
// Differences from kimi, all deliberate:
//   * turns are held in the SESSION side thread, not here, so /btw clear and the
//     accumulated view have one source of truth;
//   * the height cap is a fraction of the terminal (kimi: a third) but the panel
//     GROWS to the largest size it has needed, so it does not jitter on every token.

import { visualWidth } from './term.js';
import { C } from './colors.js';

/** Rows kimi reserves as the floor for the box, so it is never a one-line sliver. */
export const MIN_PANEL_LINES = 3;

/**
 * The box's height in rows, given the terminal height.
 *
 * Mirrors kimi's `collapsedBodyLimit`: at most a THIRD of the terminal, at least
 * MIN_PANEL_LINES. Returns the TOTAL rows the box occupies (borders included), and
 * 0 when there is nothing to show so the caller can skip it entirely.
 */
export function btwPanelHeight(state, terminalRows, width) {
  const panel = state && state.btwPanel;
  if (!panel || !panel.turns || !panel.turns.length) return 0;
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 24;
  // At most a THIRD of the terminal (kimi's rule), floor of MIN_PANEL_LINES, and the
  // rest of the screen keeps the transcript visible.
  const maxBody = Math.max(MIN_PANEL_LINES, Math.floor(rows / 3)) - 1;
  const inner = Math.max(1, (width | 0) - 4);
  const needed = btwBodyLines(panel, inner);
  // `_btwMinBody` grows monotonically, like kimi's `minBodyLines`: a box that shrank
  // as a streamed answer reflowed would make the screen jump on most tokens.
  const mark = Math.max(Number(panel._btwMinBody) || 0, needed);
  if (panel && typeof panel === 'object') panel._btwMinBody = mark;
  const want = Math.max(1, Math.min(maxBody, mark));
  return want + 2;   // the two border rows
}

/**
 * How many content rows the box has ever needed.
 *
 * kimi keeps `minBodyLines` and grows it monotonically for the same reason: a box
 * that resized on every streamed token would make the whole screen jump. Seeding it
 * from this means the height only ever changes when the CONTENT needs more room.
 */
export function btwBodyLines(panel, width) {
  if (!panel || !panel.turns || !panel.turns.length) return 0;
  let n = 0;
  for (const t of panel.turns) {
    if (n > 0) n += 1;                       // the blank line between turns
    n += wrapCount(`Q: ${t.prompt}`, width);
    const answer = String(t.answer || '');
    if (answer.trim()) {
      for (const line of answer.split('\n')) n += Math.max(1, wrapCount(line, width));
    } else if (t.thinking && t.thinking.trim()) {
      n += 1;                                 // the thinking preview
    } else if (!t.error) {
      n += 1;                                 // "Waiting for answer…"
    }
    if (t.error) n += wrapCount(t.error, width);
    // The blinking caret row. It MUST be counted here or the box is one row short and
    // the last content line is clipped off.
    if (t.phase === 'running') n += 1;
  }
  return n;
}

/** How many display rows a string needs at `width`. Never returns 0. */
function wrapCount(text, width) {
  const w = Math.max(1, width);
  const s = String(text == null ? '' : text);
  if (!s.length) return 1;
  let rows = 0;
  for (const line of s.split('\n')) {
    const vis = visualWidth(line);
    rows += Math.max(1, Math.ceil(vis / w));
  }
  return rows;
}

/** Clip a string to `width` display columns, adding `…` when it was cut. */
function clip(text, width) {
  const s = String(text == null ? '' : text);
  if (visualWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = visualWidth(ch);
    if (w + cw > Math.max(0, width - 1)) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * Render the box: `{ lines }`, one entry per SCREEN row including the borders.
 *
 * `state.btwScroll` counts rows up from the bottom of the content, as an offset from
 * the tail — the same convention the transcript uses, so ↑/↓ can share the code.
 */
export function renderBtwPanel(state, width, opts = {}) {
  const panel = state && state.btwPanel;
  if (!panel || !panel.turns || !panel.turns.length) return [];
  const w = Math.max(8, width | 0);
  const inner = Math.max(1, w - 4);          // '│ ' + content + ' │'
  const terminalRows = opts.terminalRows;
  const height = btwPanelHeight(state, terminalRows, w);
  const bodyRows = Math.max(1, height - 2);

  // ---- the content rows, in order ----
  const content = [];
  for (let i = 0; i < panel.turns.length; i++) {
    const t = panel.turns[i];
    // Every entry is a `{ l, color }` ROW. The blank separator between turns must be
    // one too: a bare '' pushed in its place rendered as `undefined` because the
    // renderer reads `row.l`.
    if (i > 0) content.push({ l: '', color: C.white });
    for (const l of wrapLine(`Q: ${t.prompt}`, inner)) content.push({ l, color: C.cyan });
    const answer = String(t.answer || '');
    if (answer.trim()) {
      for (const raw of answer.split('\n')) {
        // A blank line inside an answer stays blank; otherwise each line is wrapped on
        // its own so a long paragraph does not reflow into the previous one.
        if (!raw.trim()) { content.push({ l: '', color: C.white }); continue; }
        for (const l of wrapLine(raw, inner)) content.push({ l, color: C.white });
      }
    } else if (t.thinking && t.thinking.trim()) {
      content.push({ l: clip(`  …${t.thinking.trim().split('\n').slice(-1)[0]}`, inner), color: C.gray });
    } else if (!t.error) {
      content.push({ l: 'Waiting for answer…', color: C.gray });
    }
    if (t.error) for (const l of wrapLine(t.error, inner)) content.push({ l, color: C.red });
    if (t.phase === 'running') content.push({ l: '▍', color: C.gray });
  }

  // ---- scroll: offset from the tail, like the transcript ----

  // ---- scroll: offset from the tail, like the transcript ----
  const maxTop = Math.max(0, content.length - bodyRows);
  const scroll = Math.max(0, Math.min(maxTop, Number(state.btwScroll) || 0));
  const start = Math.max(0, content.length - bodyRows - scroll);
  const shown = content.slice(start, start + bodyRows);
  while (shown.length < bodyRows) shown.push({ l: '', color: C.white });

  // ---- the frame ----
  const out = [];
  const hint = maxTop > 0 ? 'Esc close · ↑↓ scroll ' : 'Esc close ';
  const title = ' BTW ';
  const head = `${title}${'─'.repeat(Math.max(1, w - 2 - visualWidth(title) - visualWidth(hint) - 1))} ${hint}`;
  // Every border segment is painted on its own, so the interior can carry the text
  // colour while the frame keeps the border colour. Painting the whole line and
  // patch-substituting the corners (as an earlier version did) left the colour escape
  // codes embedded in the output.
  out.push(col('╭', C.border) + col(fitBorder(head, w - 2), C.border) + col('╮', C.border));
  for (const row of shown) {
    const padded = row.l + ' '.repeat(Math.max(0, inner - visualWidth(row.l)));
    out.push(col('│', C.border) + ' ' + col(padded, row.color) + ' ' + col('│', C.border));
  }
  const above = start > 0 ? `▲ ${start} more` : '';
  const below = scroll > 0 ? `▼ ${scroll} more` : '';
  const tailHint = [above, below].filter(Boolean).join('  ') || 'Esc close';
  // The bottom border reads `╰─ Esc close ─────…────╯`: the hint sits in the middle of
  // the rule. The two corners take a column each, so the MIDDLE segment must be exactly
  // `w - 2` wide — `─ ` + hint + ` ` + fill.
  const foot = clip(tailHint, Math.max(1, w - 6));
  const mid = `─ ${foot} `;
  const footFill = Math.max(0, w - 2 - visualWidth(mid));
  out.push(col('╰', C.border) + col(mid + '─'.repeat(footFill), C.border) + col('╯', C.border));
  return out;
}

/** Paint `s`, resetting after it so the next segment starts clean. */
function col(s, color) {
  return color ? color + s + C.reset : s;
}


/** Pad or clip a border segment to exactly `width` columns. */
function fitBorder(s, width) {
  const w = Math.max(0, width);
  if (visualWidth(s) === w) return s;
  if (visualWidth(s) > w) return clip(s, w);
  return s + '─'.repeat(w - visualWidth(s));
}

/** Wrap one logical line into display rows of at most `width` columns. */
export function wrapLine(text, width) {
  const w = Math.max(1, width);
  const s = String(text == null ? '' : text);
  if (!s.length) return [''];
  const out = [];
  let cur = '';
  let curW = 0;
  for (const ch of s) {
    const cw = visualWidth(ch);
    if (curW + cw > w) { out.push(cur); cur = ''; curW = 0; }
    cur += ch;
    curW += cw;
  }
  out.push(cur);
  return out;
}


