// Jupyter notebook (.ipynb) support: read and edit CELLS rather than the JSON.
//
// WHY THIS EXISTS
// ---------------
// `tools/edit.js` REFUSED to touch a .ipynb, and the refusal was right: a notebook is JSON,
// and a snippet replacement inside it either corrupts the structure or lands in the middle
// of a base64 image. But refusing is only half an answer — it left the model with no way to
// change a notebook at all, so it would either give up or reach for Bash and do it by hand.
//
// What it needs instead is a view of the notebook as cells, and edits expressed against
// those cells. That is what this module provides:
//
//   listCells      -> the cells, with their index, type and a preview
//   readCell       -> one cell's source, in full
//   replaceSource  -> replace one cell's source
//   insertCell     -> add a cell before/after an index
//   deleteCell     -> remove one cell
//
// THE ONE INVARIANT THAT MATTERS
// ------------------------------
// Everything OUTSIDE `cells[i].source` is preserved byte-for-byte in intent: cell ids,
// metadata, outputs, execution_count, nbformat, the top-level metadata. A notebook carries
// state that is not the code — outputs a user may want to keep, a kernel's metadata, cell
// ids that Jupyter's collaboration features key on — and a tool that rebuilt the document
// from the parsed object would silently drop the fields it did not know about.
//
// So the JSON is PARSED to find what to change, the change is applied to the parsed value,
// and the parsed value is serialised back. Every field survives because every field is
// carried by the same object; `JSON.stringify` is given the ORIGINAL indentation so the
// file's diff stays about the edit rather than about reformatting.
//
// A MALFORMED NOTEBOOK IS NOT REPAIRED
// ------------------------------------
// If the file does not parse, or has no `cells` array, every function here refuses and says
// why. Guessing at a broken notebook's structure is how a tool turns "I could not help" into
// "I destroyed your work".

import fs from 'node:fs';

/** Notebook formats this understands. A newer nbformat is accepted: the `cells` shape has
 *  been stable across 4.x, and refusing a 4.6 file because we know 4.5 would be silly. */
const MIN_NBFORMAT = 4;

/**
 * Parse a notebook.
 *
 * @returns {{ok: true, doc: object, indent: string} | {ok: false, error: string}}
 */
export function parseNotebook(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { return { ok: false, error: `not valid JSON: ${e.message}` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'the top level is not an object' };
  }
  if (!Array.isArray(doc.cells)) {
    return { ok: false, error: 'there is no `cells` array (is this really a notebook?)' };
  }
  const nbf = Number(doc.nbformat);
  if (Number.isFinite(nbf) && nbf < MIN_NBFORMAT) {
    return { ok: false, error: `nbformat ${nbf} is older than ${MIN_NBFORMAT}, whose cell shape this understands` };
  }
  // Detect the indentation so a re-serialised file does not reformat the whole document.
  // Jupyter writes one space, but a hand-edited or tool-generated file may differ.
  const m = /^([ \t]+)"/m.exec(text);
  return { ok: true, doc, indent: m ? m[1] : ' ' };
}

/** Read and parse a file. */
export function loadNotebook(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, error: `could not read ${file}: ${e.message}` }; }
  const parsed = parseNotebook(text);
  if (!parsed.ok) return { ok: false, error: `${file}: ${parsed.error}` };
  return { ...parsed, text };
}

/**
 * The source of a cell as one string.
 *
 * Jupyter stores `source` as an ARRAY of lines (each keeping its own newline) in nbformat 4,
 * and as a plain string in some hand-written files. Both spellings appear in the wild, and a
 * caller that only handled the array read `undefined` from the string form.
 */
export function cellSource(cell) {
  if (!cell) return '';
  const s = cell.source;
  if (Array.isArray(s)) return s.join('');
  if (typeof s === 'string') return s;
  return '';
}

/** Split a source string into the array form Jupyter writes, keeping the newlines. */
export function toSourceLines(text) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  // `split` with a capture keeps the separators, so `"a\nb\n"` -> `["a\n", "b\n"]`.
  const parts = s.split(/(?<=\n)/);
  return parts.filter((p) => p !== '');
}

/** One-line preview of a cell, for `listCells`. */
function preview(text, max = 60) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '\u2026';
}

/**
 * List the cells.
 *
 * @returns {Array<{index:number, id:string, type:string, lines:number, source:string,
 *   preview:string, outputs:number, executionCount:number|null}>}
 *   `index` is 0-based and is what every other function here takes.
 */
export function listCells(doc) {
  return (doc.cells || []).map((c, i) => {
    const src = cellSource(c);
    return {
      index: i,
      id: c.id == null ? '' : String(c.id),
      type: String(c.cell_type || 'unknown'),
      lines: src ? src.split('\n').length : 0,
      source: src,
      preview: preview(src),
      outputs: Array.isArray(c.outputs) ? c.outputs.length : 0,
      executionCount: c.execution_count == null ? null : c.execution_count,
    };
  });
}

/** Render the cell list for a tool result or a panel. */
export function describeCells(doc, file) {
  const cells = listCells(doc);
  const header = file ? `${file} — ${cells.length} cell(s)` : `${cells.length} cell(s)`;
  if (!cells.length) return [header, '', 'The notebook has no cells.'];
  const lines = [header, ''];
  for (const c of cells) {
    const meta = [];
    if (c.type === 'code' && c.executionCount != null) meta.push(`[${c.executionCount}]`);
    if (c.outputs) meta.push(`${c.outputs} output(s)`);
    lines.push(`  ${String(c.index).padStart(3)}  ${c.type.padEnd(8)} ${c.lines} line(s) ${meta.join(' ')}`);
    if (c.preview) lines.push(`       ${c.preview}`);
  }
  return lines;
}

/** Serialise a document back, preserving the file's own indentation. */
export function serializeNotebook(doc, indent = ' ') {
  // A notebook written by Jupyter ends with a newline; matching that keeps the file's last
  // line unchanged, so a diff does not show a spurious "\ No newline at end of file".
  return JSON.stringify(doc, null, indent) + '\n';
}

/** Save a document, atomically, so a crash cannot leave a half-written notebook. */
export function saveNotebook(file, doc, indent = ' ') {
  const text = serializeNotebook(doc, indent);
  const tmp = `${file}.${process.pid}.nb.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, error: e.message };
  }
}

/** True when an index addresses a real cell. Reported by name so the message is actionable. */
export function checkIndex(doc, index) {
  const n = (doc.cells || []).length;
  if (!Number.isInteger(index)) return { ok: false, error: `cell index must be an integer (got ${JSON.stringify(index)})` };
  if (index < 0 || index >= n) return { ok: false, error: `cell index ${index} is out of range (the notebook has ${n} cell(s): 0-${n - 1})` };
  return { ok: true };
}

/**
 * Replace one cell's source, leaving everything else about it — outputs, metadata, id —
 * exactly as it was.
 *
 * Clearing `outputs` would be the tempting "correct" thing, since the old output no longer
 * matches the new code. It is the wrong default: the agent is editing SOURCE, and a user who
 * asked for one line to change does not expect their stored outputs to be dropped. The
 * unchanged-output state is what Jupyter itself shows when you edit a cell without running
 * it, so it is also the least surprising.
 *
 * @returns {{ok: true, cell: object} | {ok: false, error: string}}
 */
export function replaceSource(doc, index, source) {
  const idx = checkIndex(doc, index);
  if (!idx.ok) return idx;
  const cell = doc.cells[index];
  cell.source = toSourceLines(source);
  return { ok: true, cell };
}

/**
 * Insert a cell.
 *
 * @param {number} index insert BEFORE this index; `doc.cells.length` appends.
 */
export function insertCell(doc, index, source, type = 'code') {
  const n = (doc.cells || []).length;
  if (!Number.isInteger(index) || index < 0 || index > n) {
    return { ok: false, error: `insert index must be 0-${n} (got ${JSON.stringify(index)})` };
  }
  const kind = type === 'markdown' || type === 'raw' ? type : 'code';
  const cell = { cell_type: kind, metadata: {}, source: toSourceLines(source) };
  if (kind === 'code') { cell.outputs = []; cell.execution_count = null; }
  // nbformat 4.5+ requires every cell to carry an id. Adding one keeps a notebook that had
  // ids from becoming invalid; a notebook that predates them is left alone.
  const anyId = (doc.cells || []).some((c) => c && c.id);
  if (anyId || Number(doc.nbformat_minor) >= 5) cell.id = newCellId();
  doc.cells.splice(index, 0, cell);
  return { ok: true, cell, index };
}

/** Remove one cell. */
export function deleteCell(doc, index) {
  const idx = checkIndex(doc, index);
  if (!idx.ok) return idx;
  const [removed] = doc.cells.splice(index, 1);
  return { ok: true, removed };
}

/** A short random id in the shape Jupyter uses (8 lowercase hex/alnum characters). */
export function newCellId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
