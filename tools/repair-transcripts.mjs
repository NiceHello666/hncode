// One-time repair for session files written by the pre-fix `recordTranscriptRow`.
//
// The bug: on every streamed chunk the recorder did `stored += liveText`, and `liveText`
// was the WHOLE reasoning chain so far. The stored value is therefore a "prefix tower":
//
//     S = C[:L1] + C[:L2] + ... + C[:Ln],      L1 < L2 < ... < Ln = |C|
//
// where C is the real reasoning and the LAST block is C itself. One session reached
// 533 MB this way — past the point where `JSON.stringify` throws, so it could no longer
// be saved at all.
//
// The tower is invertible. At a block boundary `o` the next block begins with the same
// characters as the block after it, so `o` is the centre of a square:
//
//     S[o : o + L] == S[o + L : o + 2L]        with L = the next block's length
//
// A walk that repeatedly takes the smallest such L that is longer than the block it just
// read lands exactly on the boundaries and stops at the final block, which no later one
// follows. What remains is C.
//
// A result is used only when it REBUILDS S byte for byte, and a boundary that admits a
// second length within a small window of the first is treated as ambiguous and skipped.
// Nothing here guesses, and anything not understood is left exactly as it was.
//
// Usage:
//   node tools/repair-transcripts.mjs                    # report only, writes nothing
//   node tools/repair-transcripts.mjs --apply            # rewrite, keeping a .bak
//   node tools/repair-transcripts.mjs --apply --id <id>  # one session

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionsDir, loadSession, saveSession } from '../src/session.js';

// How far past the first valid length to keep looking for a second one. Two candidate
// lengths for the same boundary would mean two different recovered chains, so a close
// second hit is what makes an entry ambiguous. Bounding the probe keeps the walk linear:
// searching the whole remaining text for every boundary is O(n^2), which cannot finish
// on a file this size.
const AMBIGUITY_WINDOW = 64;

// THE GUARD THAT SEPARATES THE BUG FROM MERE REPETITION.
//
// A tower is not proof of the amplifier. Any PERIODIC text is also a tower — every prefix
// of it is a prefix of its tail — so the walk tiles it, the rebuild succeeds, and a naive
// recovery hands back one period as "the reasoning", deleting the rest of a real answer
// from a model that repeated itself. That is not hypothetical: a stuck model emits long
// repeated runs, and measurement shows repetition alone reaches a 216x factor, past any
// amplification floor that would still catch the bug. So the factor cannot be the signal.
//
// The SHAPE of the growth can. The bug appends the running total once per streamed chunk,
// and chunks are irregular, so successive block lengths differ by a stream of SMALL,
// VARYING increments — 14 to 35 distinct step sizes in the entries measured. Periodic text
// steps by exactly one period every time, giving 1 or 2 distinct values however long it
// gets. Requiring both a real growth rate and several distinct steps accepts every genuine
// entry (the smallest worthwhile one had 4) and rejects every repetitive one.
const MIN_FACTOR = 8;          // below this the entry is too small to matter anyway
const MIN_DISTINCT_STEPS = 3;  // a periodic run has 1-2, the amplifier has many

/** The smallest L > `min` (and <= `maxL`) with S[o:o+L] == S[o+L:o+2L], or -1. */
function firstSquare(S, o, min, maxL) {
  const first = S.charCodeAt(o);
  const limit = Math.min(S.length - o, maxL >= 0 ? maxL : S.length);
  for (let L = min + 1; 2 * L <= limit; L++) {
    if (S.charCodeAt(o + L) !== first) continue;
    let ok = true;
    for (let k = 1; k < L; k++) {
      if (S.charCodeAt(o + k) !== S.charCodeAt(o + L + k)) { ok = false; break; }
    }
    if (ok) return L;
  }
  return -1;
}

/**
 * The real reasoning behind a stored blob, or null when the blob is not a clean tower
 * (too short, ambiguous, a periodic run, or failing to rebuild).
 *
 * @returns {{chain: string, blocks: number}|null}
 */
export function recoverReasoning(S) {
  if (typeof S !== 'string' || S.length < 16) return null;
  const lengths = [];
  let o = 0;
  let prev = 0;
  for (;;) {
    const L = firstSquare(S, o, prev);
    if (L < 0) break;
    // A second valid length within the window means this boundary has two readings.
    // The probe is bounded for the same reason the search is: an unbounded rescan here
    // is O(n^2) across the ~6000 boundaries of a large entry and never finishes.
    const alt = firstSquare(S, o, L, L + AMBIGUITY_WINDOW);
    if (alt > 0) return null;
    lengths.push(L);
    o += L;
    prev = L;
  }
  const chainLen = S.length - o;
  const maxBlock = lengths.length ? lengths[lengths.length - 1] : 0;
  if (!lengths.length || chainLen <= maxBlock) return null;
  // Two guards, both needed. The factor rules out the many small towers that are not worth
  // rewriting; the DISTINCT STEPS rule out periodic text, which reaches a high factor too
  // but steps by one constant amount. See MIN_FACTOR / MIN_DISTINCT_STEPS.
  if (S.length < chainLen * MIN_FACTOR) return null;
  const steps = new Set();
  for (let i = 1; i < lengths.length; i++) steps.add(lengths[i] - lengths[i - 1]);
  if (steps.size < MIN_DISTINCT_STEPS) return null;
  // Every block must be a prefix of the chain, and the blocks must tile S exactly.
  let off = 0;
  for (const L of [...lengths, chainLen]) {
    if (L > chainLen) return null;
    for (let k = 0; k < L; k++) {
      if (S.charCodeAt(off + k) !== S.charCodeAt(o + k)) return null;
    }
    off += L;
  }
  if (off !== S.length) return null;
  return { chain: S.slice(o), blocks: lengths.length };
}

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const idAt = argv.indexOf('--id');
  const wantId = idAt >= 0 ? argv[idAt + 1] : null;

  const dir = sessionsDir();
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !wantId || f === `${wantId}.json`);

  console.log(`${apply ? 'REPAIRING' : 'SCANNING'} ${files.length} file(s) in ${dir}\n`);

  const rows = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const id = f.replace(/\.json$/, '');
    const sizeBefore = fs.statSync(full).size;
    let session;
    try { session = loadSession(id); } catch { continue; }
    if (!session || !Array.isArray(session.transcript)) continue;

    let before = 0;
    let after = 0;
    let reduced = 0;
    let refused = 0;
    const found = [];
    for (const entry of session.transcript) {
      const row = entry && entry.row;
      if (!row || row.role !== 'thinking' || typeof row.text !== 'string') continue;
      before += row.text.length;
      const out = recoverReasoning(row.text);
      if (!out || out.chain.length >= row.text.length) {
        if (!out) refused += 1;
        after += row.text.length;
        continue;
      }
      found.push([row, out.chain]);
      reduced += 1;
      after += out.chain.length;
    }
    if (!before || after >= before) continue;
    rows.push({ id, full, session, found, sizeBefore, before, after, reduced, refused });
  }

  rows.sort((a, b) => b.before - a.before);
  for (const r of rows) {
    console.log(`${r.id}`);
    console.log(`   reasoning ${(r.before / 1048576).toFixed(1)} MB -> ${(r.after / 1048576).toFixed(2)} MB` +
      `   (${r.reduced} entries, ${r.refused} left as-is)`);
  }

  if (!rows.length) {
    console.log('nothing to repair');
    return;
  }

  if (!apply) {
    console.log('\nreport only — nothing was written. Re-run with --apply to rewrite.');
    return;
  }

  console.log('');
  for (const r of rows) {
    for (const [row, chain] of r.found) row.text = chain;
    fs.copyFileSync(r.full, `${r.full}.bak`);
    saveSession(r.session);
    // `saveSession` resolves its own path from the session id; report the file it wrote.
    const written = path.join(dir, `${r.session.id}.json`);
    console.log(`${r.id}: ${(r.sizeBefore / 1048576).toFixed(1)} MB -> ${(fs.statSync(written).size / 1048576).toFixed(2)} MB` +
      `   backup: ${r.id}.json.bak`);
  }
  console.log('\ndone. Delete the .bak files once the sessions open correctly.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
