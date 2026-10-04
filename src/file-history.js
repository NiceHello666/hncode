// File checkpoints for /undo.
//
// The old /undo only rewound the CONVERSATION: it truncated the transcript and
// said "Undid N prompts", while every Edit/Write the agent had made stayed on
// disk. That reads as a lie — the user believes the work was withdrawn and then
// finds their files still rewritten. This module makes the rewind real: the
// content a file had BEFORE the agent touched it is kept, and /undo puts it back
// (and deletes a file the agent created).
//
// The model follows Claude Code's fileHistory (src/utils/fileHistory.ts):
//   * a backup is taken per TURN, lazily, on the first change to a file within
//     that turn — so the recorded version is exactly the pre-turn state;
//   * one entry per user turn is recorded even when nothing changed, so the
//     index lines up with the user prompts /undo counts;
//   * backups are content copies under ~/.hncode/file-history/<sessionId>/, so a
//     rewind cannot fail on a file that has since been edited by hand (it just
//     overwrites it back).
//
// Only files the agent itself modified are ever touched. A file the user edited
// in their own editor during the turn is not in the index and is left alone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function homeDir() {
  return process.env.HNCODE_HOME || os.homedir();
}

export function historyDir(sessionId) {
  return path.join(homeDir(), '.hncode', 'file-history', String(sessionId || 'unscoped'));
}

function indexPath(sessionId) {
  return path.join(historyDir(sessionId), 'index.json');
}

// Read the index. A missing or corrupt file yields an empty one rather than a
// throw: checkpoints are a safety net, and losing them must not break /undo's
// conversation rewind.
function readIndex(sessionId) {
  try {
    const doc = JSON.parse(fs.readFileSync(indexPath(sessionId), 'utf8'));
    if (doc && Array.isArray(doc.turns)) {
      for (const t of doc.turns) if (!Array.isArray(t.files)) t.files = [];
      return doc;
    }
  } catch { /* first run, or the file was removed */ }
  return { turns: [] };
}

function writeIndex(sessionId, doc) {
  const file = indexPath(sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Same atomic-replace shape as session.js: a crash mid-write must not leave a
    // half-written index that a later read would have to guess at.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Start a new turn: append an (initially empty) entry and return its id. The id
// is just the turn's position, which is what /undo counts in.
export function beginTurn(sessionId) {
  const doc = readIndex(sessionId);
  doc.turns.push({ at: Date.now(), files: [] });
  if (doc.turns.length > 200) doc.turns.splice(0, doc.turns.length - 200);
  writeIndex(sessionId, doc);
  return sessionId == null ? null : doc.turns.length - 1;
}

// Record `filePath`'s CURRENT content as the version to restore, ONCE per turn —
// called immediately before the agent writes, so what is captured is the state
// before any of this turn's changes.
//
// Returns true when a backup was taken (or already existed for this turn).
export function recordBeforeWrite(sessionId, filePath) {
  const abs = path.resolve(filePath);
  const doc = readIndex(sessionId);
  const turn = doc.turns[doc.turns.length - 1];
  // No turn open (the caller forgot beginTurn): open one so the backup still has a
  // home, rather than dropping it and silently losing the ability to rewind.
  if (!turn) { beginTurn(sessionId); return recordBeforeWrite(sessionId, filePath); }
  if (turn.files.some((f) => f.path === abs)) return true;

  let existed = true;
  let content = null;
  try {
    content = fs.readFileSync(abs);
  } catch (e) {
    if (e && e.code === 'ENOENT') existed = false;
    else return false;      // unreadable: do not claim a checkpoint we cannot honour
  }

  let backup = '';
  if (existed) {
    const dir = historyDir(sessionId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16)
        + '-' + crypto.randomBytes(3).toString('hex') + '.bak';
      backup = path.join(dir, name);
      fs.writeFileSync(backup, content);
    } catch {
      return false;
    }
  }
  turn.files.push({ path: abs, existed, backup });
  return writeIndex(sessionId, doc);
}

// How many turns are on record.
export function turnCount(sessionId) {
  return readIndex(sessionId).turns.length;
}

/**
 * Rewind `count` turns: put every file the agent changed back to how it was
 * before those turns, and delete any file the agent created in them.
 *
 * Walks the turns from newest to oldest and, for each file, keeps the version
 * recorded EARLIEST among the rewound turns — that is the pre-turn state. Returns
 * { restored: [path], deleted: [path], turns: n, failed: [{path, error}] }.
 */
export function rewind(sessionId, count = 1) {
  const doc = readIndex(sessionId);
  const n = Math.max(0, Math.min(Number(count) || 0, doc.turns.length));
  const out = { restored: [], deleted: [], turns: 0, failed: [] };
  if (!n) return out;

  const rewound = doc.turns.slice(doc.turns.length - n);
  // For each file, keep the FIRST record seen walking oldest -> newest: that is
  // the content it had before the first of the rewound turns touched it. Taking
  // the newest instead would restore a halfway state (the version left by the
  // previous rewound turn). A file CREATED in the oldest rewound turn records
  // `existed: false`, which correctly wins over the copies taken in later turns.
  const chosen = new Map();
  for (const turn of rewound) {
    for (const f of turn.files) if (!chosen.has(f.path)) chosen.set(f.path, f);
  }
  const ordered = [...chosen.entries()];

  for (const [file, rec] of ordered) {
    try {
      if (rec.existed === false) {
        // The agent created it in one of these turns: it did not exist before.
        fs.rmSync(file, { force: true });
        out.deleted.push(file);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(rec.backup, file);
        out.restored.push(file);
      }
    } catch (e) {
      out.failed.push({ path: file, error: e && e.message ? e.message : String(e) });
    }
  }
  doc.turns.splice(doc.turns.length - n, n);
  writeIndex(sessionId, doc);
  out.turns = n;
  return out;
}

// Human-readable summary for the /undo notice.
export function describeRewind(res) {
  const parts = [];
  if (res.restored.length) parts.push(`${res.restored.length} file(s) restored`);
  if (res.deleted.length) parts.push(`${res.deleted.length} created file(s) removed`);
  if (res.failed.length) parts.push(`${res.failed.length} could not be restored`);
  return parts.join(', ');
}

/**
 * Every checkpoint on record, newest turn first, as one flat list.
 *
 * WHY THIS EXISTS BESIDE `rewind`
 * -------------------------------
 * `rewind(n)` is all-or-nothing across whole turns: to get one file back you must also roll
 * back every other file those turns touched. That is the right default (a turn is a unit of
 * intent) and the wrong tool for "I want the version of THIS file from before that one
 * edit". The index already records exactly that — one entry per file per turn, with the
 * content it had — so the list is a rearrangement of existing data, not new bookkeeping.
 *
 * @returns {Array<{turn:number, at:number, path:string, existed:boolean, backup:string,
 *   size:number|null, ageMs:number}>} turn is 1-based, counting from the oldest.
 */
export function listCheckpoints(sessionId, opts = {}) {
  const doc = readIndex(sessionId);
  const only = opts.path ? path.resolve(opts.path) : null;
  const out = [];
  const now = Date.now();
  for (let i = doc.turns.length - 1; i >= 0; i--) {
    const turn = doc.turns[i];
    for (const f of turn.files) {
      if (only && f.path !== only) continue;
      let size = null;
      if (f.existed && f.backup) {
        try { size = fs.statSync(f.backup).size; } catch { size = null; }
      }
      out.push({
        // `index` is 1-based over the whole list, newest first — the number the panel
        // prints and `restore <n>` accepts. Assigned here rather than derived from `turn`
        // so a row keeps its identity even after another turn is recorded.
        index: 0,
        turn: i + 1,
        at: turn.at,
        path: f.path,
        existed: f.existed !== false,
        backup: f.backup || '',
        size,
        ageMs: Math.max(0, now - (turn.at || now)),
      });
    }
  }
  out.forEach((c, i) => { c.index = i + 1; });
  return out;
}

/**
 * Restore ONE file from one checkpoint, leaving every other file and the turn index alone.
 *
 * The index is deliberately NOT truncated: this is a surgical restore, not a rewind, so the
 * remaining checkpoints stay valid. A file that did not exist at that checkpoint is deleted,
 * which is what "restore" means for a file the agent created.
 *
 * @returns {{ok: boolean, action?: 'restored'|'deleted', error?: string}}
 */
export function restoreCheckpoint(sessionId, entry) {
  const target = entry && entry.path;
  if (!target) return { ok: false, error: 'no path on that checkpoint' };
  try {
    if (entry.existed === false) {
      fs.rmSync(target, { force: true });
      return { ok: true, action: 'deleted' };
    }
    if (!entry.backup) return { ok: false, error: 'that checkpoint has no content copy' };
    // Read BEFORE creating the directory: a missing backup must not leave an empty
    // directory behind where there was none.
    const content = fs.readFileSync(entry.backup);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return { ok: true, action: 'restored' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** A `+N -M` size delta for a checkpoint against the current file, or null when either side
 *  is unavailable. Cheap: it reads only the backup (the current file is stat'ed). */
export function checkpointDelta(entry) {
  if (!entry || !entry.existed || !entry.backup) return null;
  try {
    const before = fs.readFileSync(entry.backup, 'utf8').split(/\r?\n/).length;
    const after = fs.readFileSync(entry.path, 'utf8').split(/\r?\n/).length;
    return { before, after, lines: after - before };
  } catch { return null; }
}

/** Lines for the /checkpoints panel: one row per checkpoint, grouped visually by turn. */
export function describeCheckpoints(sessionId, workspace) {
  const all = listCheckpoints(sessionId);
  if (!all.length) {
    return ['No checkpoints recorded for this session yet.', '',
      'A checkpoint is taken the first time the agent changes a file in a turn,',
      'so this fills in as you work.'];
  }
  const lines = [`Checkpoints (${all.length}) across ${new Set(all.map((c) => c.turn)).size} turn(s)`, ''];
  let lastTurn = null;
  for (const c of all) {
    if (c.turn !== lastTurn) {
      lastTurn = c.turn;
      const when = c.at ? new Date(c.at).toISOString().slice(0, 16).replace('T', ' ') : '?';
      lines.push(`turn ${c.turn}  ${when}`);
    }
    const rel = workspace && String(c.path).startsWith(workspace)
      ? path.relative(workspace, c.path).split(path.sep).join('/')
      : c.path;
    const what = c.existed ? `${c.size == null ? '?' : c.size} B` : 'created here';
    lines.push(`  ${String(c.index).padStart(3)}  ${what.padEnd(12)} ${rel}`);
  }
  lines.push('', 'Restore one with /checkpoints restore <n>');
  return lines;
}
