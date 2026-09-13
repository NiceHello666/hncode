// Read tool — mirrors the hncode Read tool schema & behavior.

import fs from 'node:fs';
import { resolvePath, isProbablyTextFile } from './utils.js';

// Normalize newlines so a text file's hash is stable regardless of CRLF/LF.
export function normalizeText(s) {
  return String(s).split(/\r\n|\r|\n/).join('\n');
}
// FNV-1a-ish 32-bit hash of a string (cheap, deterministic).
export function hashStr(s) {
  const str = normalizeText(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}
// Hash the exact <start..end> 1-based line slice of `lines`.
function hashLines(lines, start, end) {
  const slice = (lines.slice(start - 1, end) || []).join('\n');
  return hashStr(slice);
}

export const spec = {
  name: 'Read',
  description: 'Read a text file. Returns the whole file by default; use line_offset / n_lines for a range.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the text file.' },
      line_offset: {
        type: 'integer',
        description: '1-based start line. Negative counts from the end (e.g. -100 = last 100 lines).',
        default: 1,
      },
      n_lines: { type: 'integer', minimum: 1, description: 'Lines to read (default: the rest of the file).' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    let buf;
    try { buf = fs.readFileSync(p); } catch (e) { return `Error reading ${args.path}: ${e.message}`; }
    if (!isProbablyTextFile(buf)) {
      return `Cannot read: ${args.path} appears to be a binary file (use a tool suited for binary).`;
    }
    let st;
    try { st = fs.statSync(p); } catch { st = null; }
    // NO truncation: the caller asked for the file, so the whole file is returned
    // (line ranges still work via line_offset / n_lines). The old 1000-line and
    // 128 KB caps silently cut the content, which also corrupted the
    // staleness hashes recorded below because they were computed from the
    // TRUNCATED text rather than the file on disk.
    const text = buf.toString('utf8');
    const lines = normalizeText(text).split('\n');
    const total = lines.length;
    // Default: every line. An explicit n_lines still narrows the window.
    const nLines = args.n_lines ? args.n_lines : total;
    let start = args.line_offset !== undefined ? args.line_offset : 1;
    if (start < 0) start = Math.max(1, total + 1 + start);
    start = Math.max(1, Math.min(start, total));
    const end = Math.min(start + nLines - 1, total);
    let out = '';
    out += `${args.path} (lines ${start}-${end} of ${total})\n`;
    for (let i = start; i <= end; i++) out += `${i}\t${lines[i - 1]}\n`;
    // No trailing "truncated" banner: without an explicit n_lines every line is
    // returned, so the only way to stop early is a deliberate range request — the
    // header already states which lines those were.

    // --- Record a hash fingerprint so a later Edit can verify the AI is
    // editing against the same content it read (snippet-staleness guard). ---
    // Store the FULL file's normalized content hash plus this call's line
    // range + region hash. Edit compares old_string's location against these.
    if (ctx) {
      const pool = (ctx.readPool = ctx.readPool || new Map());
      let entry = pool.get(p);
      if (!entry) {
        entry = {
          mtimeMs: st ? st.mtimeMs : 0,
          size: st ? st.size : 0,
          fileHash: hashStr(text),
          lines: total,            // current total line count at read time
          regions: [],             // {start, end, hash} of each read slice
        };
        pool.set(p, entry);
      }
      entry.mtimeMs = st ? st.mtimeMs : entry.mtimeMs;
      entry.size = st ? st.size : entry.size;
      entry.fileHash = hashStr(text);
      entry.lines = total;
      // Record this call's exact region (only the lines actually returned).
      entry.regions.push({ start, end, hash: hashLines(lines, start, end) });
    }
    return out;
  },
};
