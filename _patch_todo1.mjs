// Make the todo panel's TOP BORDER draggable, so the panel height can be resized
// by hand, with hover/press feedback like the scrollbar.
//
// Clamp: minimum = the heading + ONE todo row; maximum = the heading + ALL todos.
// The manual height is stored on the session (state.todoRows) and takes precedence
// over the auto-shrink heuristic in selectVisibleTodos.
import fs from 'node:fs';

const file = 'D:/hncode/src/tui.js';
let src = fs.readFileSync(file, 'utf8');
const ok = [];
const sub = (label, from, to) => {
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error('ABORT ' + label + ': ' + n); process.exit(1); }
  src = src.replace(from, to); ok.push(label);
};

// ---- 1. clamp + height helpers ------------------------------------------------
sub('todo clamps',
  'function todoPanelHeight(state) {',
  '// How many todo ROWS the panel should show.\n'
  + '//   * `state.todoRows` (set by dragging the top border) wins when present;\n'
  + '//   * otherwise the automatic "up to TODO_MAX_VISIBLE, prioritising in-progress"\n'
  + '//     heuristic decides (selectVisibleTodos).\n'
  + '// Always clamped to [1, todos.length]: at least one row, never more than exist.\n'
  + 'export function todoRowCount(state) {\n'
  + '  const todos = state.todos || [];\n'
  + '  if (!todos.length) return 0;\n'
  + '  const manual = state.todoRows;\n'
  + '  let rows;\n'
  + '  if (typeof manual === \'number\' && Number.isFinite(manual)) {\n'
  + '    rows = Math.round(manual);\n'
  + '  } else {\n'
  + '    const sel = selectVisibleTodos(todos);\n'
  + '    rows = state.todosExpanded\n'
  + '      ? todos.length\n'
  + '      : sel.rows.length;\n'
  + '  }\n'
  + '  return Math.max(1, Math.min(todos.length, rows));\n'
  + '}\n\n'
  + '// The panel's total height: heading + rows (+1 for the overflow hint when the\n'
  + '// list does not fit).\n'
  + 'export function todoPanelHeight(state) {');

sub('height uses row count',
  '  const todos = state.todos || [];\n'
  + '  if (!todos.length) return 0;\n'
  + '  const sel = selectVisibleTodos(todos);\n'
  + '  const rows = state.todosExpanded\n'
  + '    ? todos.length + (todos.length > TODO_MAX_VISIBLE ? 1 : 0)\n'
  + '    : sel.rows.length + (sel.hidden > 0 ? 1 : 0);\n'
  + '  return 2 + rows; // rule + heading + rows',
  '  const todos = state.todos || [];\n'
  + '  if (!todos.length) return 0;\n'
  + '  const rows = todoRowCount(state);\n'
  + '  const extra = todos.length > rows ? 1 : 0;   // the "… +N more" hint\n'
  + '  return 2 + rows + extra; // rule + heading + rows (+ hint)');

// ---- 2. render the requested number of rows, and mark the border --------------
sub('render uses row count',
  'function renderTodoPanel(state, w) {\n'
  + '  const todos = state.todos || [];\n'
  + '  if (!todos.length) return [];\n'
  + '  const out = [];\n'
  + "  out.push(col('─'.repeat(w), C.border));\n"
  + "  out.push(col('  Todo', C.cyan + C.bold));\n"
  + '  if (state.todosExpanded) {\n'
  + '    for (const t of todos) out.push(todoRow(t, w));\n'
  + '    if (todos.length > TODO_MAX_VISIBLE) out.push(col(`  all ${todos.length} items · ctrl+t to collapse`, C.gray));\n'
  + '  } else {\n'
  + '    const { rows, hidden, counts } = selectVisibleTodos(todos);\n'
  + '    for (const t of rows) out.push(todoRow(t, w));\n'
  + '    if (hidden > 0) {\n'
  + "      const dist = [['done', 'done'], ['in_progress', 'in progress'], ['pending', 'pending']]\n"
  + '        .filter(([k]) => counts[k] > 0).map(([k, label]) => `${counts[k]} ${label}`).join(\', \');\n'
  + '      out.push(col(`  … +${hidden} more${dist ? ` (${dist})` : \'\'} · ctrl+t to expand`, C.gray));\n'
  + '    }\n'
  + '  }\n'
  + '  return out;\n'
  + '}',

  'function renderTodoPanel(state, w, hoverTop, dragTop) {\n'
  + '  const todos = state.todos || [];\n'
  + '  if (!todos.length) return [];\n'
  + '  const out = [];\n'
  + '  // The top rule doubles as a DRAG HANDLE. Hover/press swap its colour so the\n'
  + '  // affordance is discoverable (same 3-state idea as the scrollbar thumb).\n'
  + "  const ruleColor = dragTop ? C.cyan : (hoverTop ? C.hover : C.border);\n"
  + "  out.push(col('─'.repeat(w), ruleColor));\n"
  + "  out.push(col('  Todo', C.cyan + C.bold));\n"
  + '  const want = todoRowCount(state);\n'
  + '  if (state.todosExpanded) {\n'
  + '    for (const t of todos) out.push(todoRow(t, w));\n'
  + '    if (todos.length > TODO_MAX_VISIBLE) out.push(col(`  all ${todos.length} items · ctrl+t to collapse`, C.gray));\n'
  + '  } else {\n'
  + '    // Show exactly `want` rows, preserving the automatic pick ORDER so the\n'
  + '    // in-progress item keeps its priority; any extras follow it.\n'
  + '    const picked = selectVisibleTodos(todos).rows;\n'
  + '    const ordered = [];\n'
  + '    const seen = new Set();\n'
  + '    for (const t of picked) { ordered.push(t); seen.add(t); }\n'
  + '    for (const t of todos) { if (ordered.length >= want) break; if (!seen.has(t)) { ordered.push(t); seen.add(t); } }\n'
  + '    const rows = ordered.slice(0, want);\n'
  + '    for (const t of rows) out.push(todoRow(t, w));\n'
  + '    const hidden = todos.length - rows.length;\n'
  + '    if (hidden > 0) {\n'
  + '      const counts = { done: 0, in_progress: 0, pending: 0 };\n'
  + '      for (const t of todos) if (!rows.includes(t)) counts[t.status] = (counts[t.status] || 0) + 1;\n'
  + "      const dist = [['done', 'done'], ['in_progress', 'in progress'], ['pending', 'pending']]\n"
  + '        .filter(([k]) => counts[k] > 0).map(([k, label]) => `${counts[k]} ${label}`).join(\', \');\n'
  + '      out.push(col(`  … +${hidden} more${dist ? ` (${dist})` : \'\'} · ctrl+t to expand, drag the top rule to resize`, C.gray));\n'
  + '    }\n'
  + '  }\n'
  + '  return out;\n'
  + '}');

fs.writeFileSync(file, src, 'utf8');
console.log('applied: ' + ok.join(' | '));
