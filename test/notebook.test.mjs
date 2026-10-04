// Jupyter notebook (.ipynb) support.
//
// WHY THESE ASSERTIONS
// --------------------
// A notebook is not a text file: it carries state that the SOURCE does not represent —
// stored outputs, per-cell metadata and tags, cell ids that Jupyter's collaboration keys on,
// kernel metadata at the top level. The dangerous failure is not "the edit did not work", it
// is "the edit worked and silently dropped everything else", and that failure is invisible in
// a diff of the cell you meant to change.
//
// So most of what follows asserts on what must SURVIVE an edit. The round trips go through a
// real file on disk, because the serialisation step is where a field would be lost.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  parseNotebook, loadNotebook, cellSource, toSourceLines, listCells, describeCells,
  replaceSource, insertCell, deleteCell, checkIndex, serializeNotebook, saveNotebook, newCellId,
} = await import('../src/notebook.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-nb-'));

/** A realistic notebook: both source spellings, outputs, tags, ids, kernel metadata. */
function sample() {
  return {
    cells: [
      {
        cell_type: 'markdown', id: 'md-1', metadata: {},
        source: ['# Analysis\n', '\n', 'Some *notes*.\n'],
      },
      {
        cell_type: 'code', id: 'code-1', metadata: { tags: ['keep-me'], collapsed: false },
        execution_count: 7,
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hello\n'] },
          { output_type: 'execute_result', data: { 'text/plain': ['42'] }, metadata: {}, execution_count: 7 },
        ],
        // The STRING spelling, which some tools write. A reader that only handles the array
        // form returns '' here and silently edits nothing.
        source: 'x = 1\nprint(x)\n',
      },
      { cell_type: 'raw', id: 'raw-1', metadata: {}, source: ['raw text\n'] },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.0' },
      custom: { keep: true },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

const writeNb = (name, doc, indent = ' ') => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(doc, null, indent) + '\n', 'utf8');
  return p;
};

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

test('a well-formed notebook parses, and its indentation is detected', () => {
  const r = parseNotebook(JSON.stringify(sample(), null, ' '));
  assert.equal(r.ok, true);
  assert.equal(r.indent, ' ');
});

test('a tab-indented notebook keeps its tabs', () => {
  const r = parseNotebook(JSON.stringify(sample(), null, '\t'));
  assert.equal(r.ok, true);
  assert.equal(r.indent, '\t');
});

test('a malformed document is refused with a reason, never guessed at', () => {
  for (const [text, re] of [
    ['{ not json', /not valid JSON/],
    ['[1,2,3]', /not an object/],
    ['{"nbformat":4}', /cells/],
    ['"a string"', /not an object/],
  ]) {
    const r = parseNotebook(text);
    assert.equal(r.ok, false, `${text} should be refused`);
    assert.match(r.error, re);
  }
});

test('an nbformat older than 4 is refused rather than misread', () => {
  const r = parseNotebook(JSON.stringify({ nbformat: 3, cells: [] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /nbformat 3/);
});

test('a newer 4.x minor version is accepted', () => {
  // The cell shape has been stable across 4.x; refusing 4.6 because we know 4.5 would be
  // refusing a file we can plainly read.
  const r = parseNotebook(JSON.stringify({ nbformat: 4, nbformat_minor: 9, cells: [] }));
  assert.equal(r.ok, true);
});

test('a missing file reports rather than throwing', () => {
  const r = loadNotebook(path.join(tmp, 'nope.ipynb'));
  assert.equal(r.ok, false);
  assert.match(r.error, /could not read/);
});

// ---------------------------------------------------------------------------
// both source spellings
// ---------------------------------------------------------------------------

test('both the array and the string source forms read as one string', () => {
  assert.equal(cellSource({ source: ['a\n', 'b\n'] }), 'a\nb\n');
  assert.equal(cellSource({ source: 'a\nb\n' }), 'a\nb\n');
  assert.equal(cellSource({}), '');
  assert.equal(cellSource(null), '');
});

test('a source string round-trips to the array form with its newlines intact', () => {
  assert.deepEqual(toSourceLines('a\nb\n'), ['a\n', 'b\n']);
  assert.deepEqual(toSourceLines('a\nb'), ['a\n', 'b']);
  assert.deepEqual(toSourceLines(''), []);
  assert.deepEqual(toSourceLines(null), []);
  // The property that matters: joining back gives exactly what went in.
  for (const s of ['', 'x', 'x\n', 'a\nb\nc', 'a\n\n\nb\n', '\n\n']) {
    assert.equal(toSourceLines(s).join(''), s, `round trip for ${JSON.stringify(s)}`);
  }
});

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

test('the cell list reports index, type, size and a preview', () => {
  const cells = listCells(sample());
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map((c) => c.type), ['markdown', 'code', 'raw']);
  assert.deepEqual(cells.map((c) => c.index), [0, 1, 2]);
  assert.equal(cells[1].lines, 3, 'the string-form source is counted too');
  assert.equal(cells[1].executionCount, 7);
  assert.equal(cells[1].outputs, 2);
  assert.match(cells[0].preview, /Analysis/);
});

test('a preview is one line and bounded', () => {
  const cells = listCells({ cells: [{ cell_type: 'code', source: ['a\n'.repeat(500)] }] });
  assert.ok(cells[0].preview.length <= 60);
  assert.ok(!cells[0].preview.includes('\n'));
});

test('the rendered list names every cell and its output count', () => {
  const text = describeCells(sample(), 'x.ipynb').join('\n');
  assert.match(text, /x\.ipynb — 3 cell\(s\)/);
  assert.match(text, /markdown/);
  assert.match(text, /output\(s\)/);
});

test('an empty notebook lists nothing but says so', () => {
  assert.match(describeCells({ cells: [] }, 'e.ipynb').join('\n'), /no cells/);
});

// ---------------------------------------------------------------------------
// the invariant: everything else survives
// ---------------------------------------------------------------------------

test('replacing a cell source preserves outputs, metadata, ids and the document', () => {
  const doc = sample();
  const keep = JSON.stringify({ metadata: doc.metadata, minor: doc.nbformat_minor });
  const before = JSON.stringify({ outputs: doc.cells[1].outputs, meta: doc.cells[1].metadata, id: doc.cells[1].id });

  const r = replaceSource(doc, 1, 'x = 2\nprint(x)\n');
  assert.equal(r.ok, true);

  assert.equal(JSON.stringify({ outputs: doc.cells[1].outputs, meta: doc.cells[1].metadata, id: doc.cells[1].id }), before,
    'the cell keeps its outputs, its tags and its id');
  assert.equal(JSON.stringify({ metadata: doc.metadata, minor: doc.nbformat_minor }), keep,
    'the top-level metadata and format version are untouched');
  assert.equal(cellSource(doc.cells[1]), 'x = 2\nprint(x)\n', 'and the source is what changed');
});

test('the invariant holds through a real file round trip', () => {
  // The serialisation step is where a field would actually be lost, so this goes to disk.
  const doc = sample();
  const p = writeNb('roundtrip.ipynb', doc);
  const loaded = loadNotebook(p);
  assert.equal(loaded.ok, true);
  const r = replaceSource(loaded.doc, 1, 'y = 3\n');
  assert.equal(r.ok, true);
  assert.equal(saveNotebook(p, loaded.doc, loaded.indent).ok, true);

  const back = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(back.metadata, sample().metadata, 'kernel metadata survives');
  assert.deepEqual(back.cells[1].outputs, sample().cells[1].outputs, 'outputs survive');
  assert.deepEqual(back.cells[1].metadata, sample().cells[1].metadata, 'tags survive');
  assert.equal(back.cells[1].id, 'code-1', 'the cell id survives');
  assert.equal(back.cells[1].execution_count, 7, 'the execution count survives');
  assert.equal(back.cells[0].source.join(''), sample().cells[0].source.join(''), 'other cells are untouched');
});

test('the file keeps its own indentation and a trailing newline', () => {
  const p = writeNb('tabs.ipynb', sample(), '\t');
  const loaded = loadNotebook(p);
  replaceSource(loaded.doc, 0, '# changed\n');
  saveNotebook(p, loaded.doc, loaded.indent);
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /\n\t"cells"/, 'tabs are preserved');
  assert.ok(text.endsWith('\n'), 'and the file still ends with a newline');
});

// ---------------------------------------------------------------------------
// insert / delete
// ---------------------------------------------------------------------------

test('inserting puts the cell at the index given, before what was there', () => {
  const doc = sample();
  const r = insertCell(doc, 1, 'new = True\n', 'code');
  assert.equal(r.ok, true);
  assert.equal(doc.cells.length, 4);
  assert.equal(cellSource(doc.cells[1]), 'new = True\n');
  assert.equal(cellSource(doc.cells[2]), 'x = 1\nprint(x)\n', 'the old cell moved down');
});

test('appending uses the cell count as the index', () => {
  const doc = sample();
  const r = insertCell(doc, doc.cells.length, 'last\n', 'markdown');
  assert.equal(r.ok, true);
  assert.equal(doc.cells.length, 4);
  assert.equal(cellSource(doc.cells[3]), 'last\n');
});

test('an inserted code cell gets the fields a code cell needs', () => {
  const doc = sample();
  insertCell(doc, 0, 'a = 1\n', 'code');
  assert.deepEqual(doc.cells[0].outputs, [], 'outputs start empty');
  assert.equal(doc.cells[0].execution_count, null, 'and it has not been run');
});

test('an inserted markdown or raw cell carries no code-only fields', () => {
  const doc = sample();
  insertCell(doc, 0, '# hi\n', 'markdown');
  assert.equal(doc.cells[0].outputs, undefined, 'markdown has no outputs');
  assert.equal(doc.cells[0].execution_count, undefined);
});

test('an inserted cell gets an id when the notebook uses ids', () => {
  // nbformat 4.5+ requires every cell to have one; a notebook that had ids would become
  // invalid if a new cell lacked one.
  const doc = sample();
  const r = insertCell(doc, 0, 'z\n', 'code');
  assert.equal(typeof doc.cells[0].id, 'string');
  assert.ok(doc.cells[0].id.length > 0);
  assert.notEqual(doc.cells[0].id, doc.cells[1].id, 'the id is unique among the cells');
  assert.equal(r.ok, true);
});

test('an out-of-range insert index is refused with the range in the message', () => {
  const doc = sample();
  for (const i of [-1, 4, 99, 1.5, null]) {
    const r = insertCell(doc, i, 'x\n');
    assert.equal(r.ok, false, `index ${i} should be refused`);
    assert.match(r.error, /0-3/, 'the message states the valid range');
  }
  assert.equal(doc.cells.length, 3, 'and nothing was inserted');
});

test('deleting removes exactly one cell and reports it', () => {
  const doc = sample();
  const r = deleteCell(doc, 1);
  assert.equal(r.ok, true);
  assert.equal(doc.cells.length, 2);
  assert.deepEqual(doc.cells.map((c) => c.id), ['md-1', 'raw-1']);
  assert.equal(cellSource(r.removed), 'x = 1\nprint(x)\n', 'the removed cell is returned');
});

test('a bad index is refused by read, replace and delete alike', () => {
  const doc = sample();
  for (const i of [-1, 3, 100, 'x', null, 0.5]) {
    assert.equal(checkIndex(doc, i).ok, false, `index ${i}`);
    assert.equal(replaceSource(doc, i, 'x').ok, false);
    assert.equal(deleteCell(doc, i).ok, false);
  }
  assert.match(checkIndex(doc, 9).error, /0-2/, 'the error states the valid range');
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

test('the serialised form matches the shape Jupyter writes', () => {
  const text = serializeNotebook(sample(), ' ');
  assert.ok(text.endsWith('\n'), 'ends with a newline');
  assert.match(text, /\n "cells": \[/, 'is indented');
  // And it re-parses to the same document.
  assert.deepEqual(JSON.parse(text), sample());
});

test('saving is atomic: no temp file is left behind', () => {
  const p = writeNb('atomic.ipynb', sample());
  saveNotebook(p, sample(), ' ');
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.nb.tmp'));
  assert.deepEqual(leftovers, [], 'no partial write is left in the directory');
});

test('a new cell id looks like the ones Jupyter writes', () => {
  const id = newCellId();
  assert.match(id, /^[a-z0-9]{8}$/);
  const many = new Set(Array.from({ length: 500 }, () => newCellId()));
  assert.equal(many.size, 500, 'ids do not collide in practice');
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
});
