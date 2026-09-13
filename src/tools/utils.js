// Shared helpers for the hncode toolbelt.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const MAX_OUTPUT_BYTES = 128 * 1024; // cap tool results to avoid token blowup

export function truncateBuf(buf) {
  if (Buffer.isBuffer(buf)) {
    if (buf.length <= MAX_OUTPUT_BYTES) return buf.toString('utf8');
    return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + `\n...[truncated ${buf.length - MAX_OUTPUT_BYTES} bytes]`;
  }
  const s = String(buf);
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_OUTPUT_BYTES) + `\n...[truncated ${s.length - MAX_OUTPUT_BYTES} chars]`;
}

// Expand ~ and map Git-Bash /c/x -> C:\x style paths, then resolve against cwd.
export function normalizeInput(p) {
  let s = String(p);
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return path.join(`${m[1].toUpperCase()}:\\`, ...m[2].split('/'));
  return s;
}

export function resolvePath(input, ctx) {
  const raw = normalizeInput(input);
  let p = path.resolve(ctx.cwd || ctx.workspace, raw);
  try { p = fs.realpathSync(p); } catch {} // resolve symlinks if present
  const ws = path.resolve(ctx.cwd || ctx.workspace);
  if (!ctx.allowExternal) {
    let rel = path.relative(ws, p);
    if (rel === '') return p;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path outside workspace: ${input}. Run hncode from that directory or set HNCODE_ALLOW_EXTERNAL=1.`);
    }
  }
  return p;
}

export function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Read a file fully, returning its string. Throws if not a file.
export function readFileBytes(p) {
  const st = fs.statSync(p);
  if (!st.isFile() && !st.isFIFO()) throw new Error(`Not a file: ${p}`);
  return fs.readFileSync(p);
}

// Visible width ignoring ANSI escapes (approx).
export function visibleWidth(s) {
  return (s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

export function isProbablyTextFile(buf) {
  // Treat as text if mostly printable ASCII/UTF-8 and few NULs.
  if (buf.length === 0) return true;
  let nulls = 0;
  for (let i = 0; i < Math.min(buf.length, 8192); i++) if (buf[i] === 0) nulls++;
  if (nulls > 0) return false;
  let bad = 0;
  for (let i = 0; i < Math.min(buf.length, 8192); i++) {
    const b = buf[i];
    if (b < 9 || (b > 13 && b < 32) || b > 254) bad++;
  }
  return bad / Math.min(buf.length, 8192) < 0.10;
}
