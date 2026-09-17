// TaskOutputViewer - full-screen scrollable output for ONE background task,
// mirroring kimi-code's TaskOutputViewer.
//
// Keys: Up/Down or j/k line, PgUp/PgDn or Ctrl+U/D page, g/G top/bottom,
//       Q/Esc close. The view follows the tail while the user is parked at the
//       bottom; scrolling up keeps the position so history is readable.
import { C } from './colors.js';
import { visualWidth } from './term.js';
import { STATUS_LABEL } from './agent-task.js';
import { statusColorToken } from './tasks-browser.js';

const ELLIPSIS = '\u2026';
const ESC = '\x1b';
// visWidth() counts ANSI bytes, so strip escapes before measuring: every
// string here carries colour codes and would otherwise measure far too wide.
function visWidth(s) { return visualWidth(String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')); }

function truncateToWidth(s, width) {
  const str = String(s);
  let out = '';
  let n = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visWidth(ch);
    if (n + cw > width - 1) {
      // Pad after the ellipsis so the row is EXACTLY `width` columns: a short
      // row breaks the frame's right border alignment.
      const used = n + 1;
      return out + ELLIPSIS + ' '.repeat(Math.max(0, width - used));
    }
    n += cw;
    out += ch;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

function padToWidth(s, width) {
  const w = visWidth(s);
  if (w === width) return s;
  if (w > width) return truncateToWidth(s, width);
  return s + ' '.repeat(width - w);
}

function fitExactly(line, width) {
  let s = String(line);
  if (visWidth(s) > width) s = truncateToWidth(s, width);
  return padToWidth(s, width) + C.reset;
}

export function makeViewerState(task) {
  return { task, scrollTop: 0, follow: true };
}

function lines(state) {
  const out = String((state.task && state.task.output) || '');
  if (!out.length) return ['[no output captured]'];
  return out.replace(/\r\n/g, '\n').split('\n');
}

function viewRows(rows) { return Math.max(1, rows - 4); }

function maxScroll(state, rows) {
  return Math.max(0, lines(state).length - viewRows(rows));
}

export function handleViewerKey(state, t, rows) {
  const ch = t.ch;
  const max = maxScroll(state, rows);
  const page = Math.max(1, viewRows(rows) - 1);
  if (t.key === 'escape' || ch === 'q' || ch === 'Q') return 'close';
  if (t.key === 'up' || ch === 'k') { state.scrollTop = Math.max(0, state.scrollTop - 1); state.follow = false; return 'scroll'; }
  if (t.key === 'down' || ch === 'j') {
    state.scrollTop = Math.min(max, state.scrollTop + 1);
    state.follow = state.scrollTop >= max;
    return 'scroll';
  }
  if (t.key === 'pageup' || ch === ' ') { state.scrollTop = Math.max(0, state.scrollTop - page); state.follow = false; return 'scroll'; }
  if (t.key === 'pagedown') { state.scrollTop = Math.min(max, state.scrollTop + page); state.follow = state.scrollTop >= max; return 'scroll'; }
  if (t.key === 'home' || ch === 'g') { state.scrollTop = 0; state.follow = false; return 'scroll'; }
  if (t.key === 'end' || ch === 'G') { state.scrollTop = max; state.follow = true; return 'scroll'; }
  return null;
}

export function renderTaskOutputViewer(state, cols, rows) {
  const task = state.task;
  // Follow the tail when parked at the bottom (like less +F).
  const max = maxScroll(state, rows);
  if (state.follow) state.scrollTop = max;
  state.scrollTop = Math.max(0, Math.min(max, state.scrollTop));

  // header
  const segs = [C.cyan + C.bold + ' Task output ' + C.reset, C.white + C.bold + (task ? task.taskId : '(none)') + C.reset];
  if (task) {
    segs.push(statusColorToken(task.status) + (STATUS_LABEL[task.status] || task.status) + C.reset);
    if (task.exitCode != null) segs.push(C.gray + 'exit ' + task.exitCode + C.reset);
    if (task.description) segs.push(C.gray + task.description + C.reset);
  }
  const header = fitExactly(segs.join('  '), cols);

  // body
  const bodyH = rows - 2;
  const all = lines(state);
  const vr = viewRows(rows);
  const innerW = Math.max(1, cols - 4);
  const bodyLines = [C.border + '\u250c' + '\u2500'.repeat(Math.max(0, cols - 2)) + '\u2510' + C.reset];
  for (let i = 0; i < vr; i++) {
    const raw = all[state.scrollTop + i] ?? '';
    bodyLines.push(C.border + '\u2502 ' + C.reset + fitExactly(C.white + raw + C.reset, innerW) + C.border + ' \u2502' + C.reset);
  }
  bodyLines.push(C.border + '\u2514' + '\u2500'.repeat(Math.max(0, cols - 2)) + '\u2518' + C.reset);

  // footer with position + keys
  const key = (s) => C.cyan + C.bold + s + C.reset;
  const dim = (s) => C.gray + s + C.reset;
  const total = all.length;
  const maxs = Math.max(0, total - vr);
  const percent = maxs === 0 ? 100 : Math.round((state.scrollTop / maxs) * 100);
  const from = state.scrollTop + 1;
  const to = Math.min(total, state.scrollTop + vr);
  const pos = C.gray + ' ' + from + '-' + to + ' / ' + total + ' (' + percent + '%) ' + C.reset;
  const keys = ' ' + key('\u2191\u2193') + ' ' + dim('line') + '  ' + key('PgUp/PgDn') + ' ' + dim('page') + '  '
    + key('g/G') + ' ' + dim('top/bot') + '  ' + key('Q/Esc') + ' ' + dim('close');
  const lw = visWidth(keys);
  const rw = visWidth(pos);
  const footer = lw + 2 + rw <= cols ? keys + ' '.repeat(cols - lw - rw) + pos : fitExactly(keys, cols);

  return [header, ...bodyLines, footer];
}
