// NotebookEdit — read and edit a Jupyter notebook by CELL.
//
// WHY A TOOL AND NOT A BRANCH IN `Edit`
// ------------------------------------
// `Edit`'s contract is "replace this text with that text", and a notebook has no text to
// match: the source lives inside a JSON array, so a `old_string` would match in one place in
// the .ipynb and mean something different in the cell. Expressing the operation as CELL
// indices removes the ambiguity entirely — there is nothing to match, so nothing to match
// wrongly.
//
// `tools/edit.js` still refuses a .ipynb, and now says to use THIS instead. That refusal is
// the safety property: a notebook can only be changed through an operation that knows its
// structure, so the corruption the refusal prevented remains impossible.
//
// Everything outside the edited `source` is preserved: outputs, metadata, cell ids, the
// top-level metadata. See src/notebook.js for why that is an invariant rather than a nicety.

import {
  loadNotebook, listCells, describeCells, replaceSource, insertCell,
  deleteCell, checkIndex, cellSource, saveNotebook,
} from '../notebook.js';
import { resolvePath } from './utils.js';
import { checkpointBeforeWrite } from './utils.js';

export const spec = {
  name: 'NotebookEdit',
  description: `Read and change a Jupyter notebook (.ipynb) by CELL. Plain Edit refuses .ipynb because a notebook is JSON — use this instead.

Actions:
- \`list\`: every cell with its index, type, line count and a one-line preview. Do this FIRST unless you already know the indices.
- \`read\`: one cell's source in full.
- \`replace\`: replace one cell's source. Everything else about the cell (its outputs, metadata, id) is preserved.
- \`insert\`: add a cell BEFORE an index; use index = cell count to append.
- \`delete\`: remove one cell.

Indices are 0-based and refer to the list \`list\` prints. Recent output is kept when a cell's source is replaced, exactly as Jupyter does when you edit without re-running.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .ipynb file.' },
      action: { type: 'string', enum: ['list', 'read', 'replace', 'insert', 'delete'], description: 'What to do.' },
      index: { type: 'integer', description: '0-based cell index. Required for read/replace/insert/delete. For insert, the new cell goes BEFORE this index (cell count to append).' },
      source: { type: 'string', description: 'The cell source. Required for replace and insert.' },
      cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Type for an inserted cell; defaults to code.' },
    },
    required: ['path', 'action'],
  },

  async execute(args, ctx) {
    if (typeof args.path !== 'string' || !args.path.trim()) return 'Error: `path` is required.';
    const action = String(args.action || '').toLowerCase();
    if (!['list', 'read', 'replace', 'insert', 'delete'].includes(action)) {
      return `Error: \`action\` must be one of list, read, replace, insert, delete (got ${JSON.stringify(args.action)}).`;
    }
    let abs;
    try { abs = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    if (!String(abs).toLowerCase().endsWith('.ipynb')) {
      return `Error: ${args.path} is not a .ipynb file. Use Edit for ordinary text files.`;
    }
    const loaded = loadNotebook(abs);
    if (!loaded.ok) return `Error: ${loaded.error}`;

    if (action === 'list') {
      return describeCells(loaded.doc, args.path).join('\n');
    }

    const idx = checkIndex(loaded.doc, args.index);
    if (!idx.ok) return `Error: ${idx.error}`;

    if (action === 'read') {
      const cell = loaded.doc.cells[args.index];
      const type = cell.cell_type || 'unknown';
      const src = cellSource(cell);
      return `cell ${args.index} (${type}, ${src ? src.split('\n').length : 0} line(s)):\n\n${src}`;
    }

    if (action === 'replace') {
      if (typeof args.source !== 'string') return 'Error: `source` is required for replace.';
      const before = cellSource(loaded.doc.cells[args.index]);
      const r = replaceSource(loaded.doc, args.index, args.source);
      if (!r.ok) return `Error: ${r.error}`;
      // A checkpoint BEFORE the write, like Edit does, so /checkpoints and /undo can put
      // the previous cell content back.
      try { checkpointBeforeWrite(abs, ctx); } catch { /* best effort */ }
      const saved = saveNotebook(abs, loaded.doc, loaded.indent);
      if (!saved.ok) return `Error: saving ${args.path}: ${saved.error}`;
      const beforeLines = before ? before.split('\n').length : 0;
      const afterLines = args.source ? args.source.split('\n').length : 0;
      return `Replaced the source of ${args.path} cell ${args.index} (${beforeLines} -> ${afterLines} line(s)). The cell's outputs and metadata are unchanged.`;
    }

    if (action === 'insert') {
      if (typeof args.source !== 'string') return 'Error: `source` is required for insert.';
      const r = insertCell(loaded.doc, args.index, args.source, args.cell_type);
      if (!r.ok) return `Error: ${r.error}`;
      try { checkpointBeforeWrite(abs, ctx); } catch { /* best effort */ }
      const saved = saveNotebook(abs, loaded.doc, loaded.indent);
      if (!saved.ok) return `Error: saving ${args.path}: ${saved.error}`;
      return `Inserted a ${r.cell.cell_type} cell at index ${args.index} in ${args.path}. The notebook now has ${loaded.doc.cells.length} cell(s).`;
    }

    // delete
    const r = deleteCell(loaded.doc, args.index);
    if (!r.ok) return `Error: ${r.error}`;
    try { checkpointBeforeWrite(abs, ctx); } catch { /* best effort */ }
    const saved = saveNotebook(abs, loaded.doc, loaded.indent);
    if (!saved.ok) return `Error: saving ${args.path}: ${saved.error}`;
    return `Deleted cell ${args.index} from ${args.path}. The notebook now has ${loaded.doc.cells.length} cell(s).`;
  },
};

/** Exported for tests: the cell list without touching the filesystem. */
export { listCells };
