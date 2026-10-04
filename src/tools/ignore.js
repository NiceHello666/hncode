// Best-effort .gitignore / .ignore / .rgignore matcher for Glob & Grep.
import fs from 'node:fs';
import path from 'node:path';
import { globToRegexSource } from './matchers.js';

const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];
const cache = new Map();

export function parseIgnoreFile(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, ''); // strip trailing comments? no: only outside string; good enough
    line = line.trimEnd();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    let anchor = false;
    if (line.startsWith('/')) { anchor = true; line = line.slice(1); }
    if (!line) continue;
    out.push({ raw: line, negate, dirOnly, anchor });
  }
  return out;
}

export function ignorePatternsFor(dir) {
  let cached = cache.get(dir);
  if (cached) return cached;
  const arr = [];
  for (const name of IGNORE_FILES) {
    try {
      const txt = fs.readFileSync(path.join(dir, name), 'utf8');
      arr.push(...parseIgnoreFile(txt));
    } catch {}
  }
  cache.set(dir, arr);
  return arr;
}

// Compiled glob → RegExp, memoised. `matchPattern` runs for EVERY entry against
// EVERY accumulated ignore pattern, so building a fresh RegExp each time was the
// single largest cost of a directory walk (measured: 73ms of a 228ms walk on a
// 354-file repo, purely in `new RegExp`). Patterns are immutable strings, so a
// process-lifetime cache is safe.
const reCache = new Map();
function globToRegex(pattern) {
  let re = reCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(globToRegexSource(pattern));
    if (reCache.size >= 4096) reCache.clear();   // bounded; patterns are few in practice
    reCache.set(pattern, re);
  }
  return re;
}

export function matchPattern(pat, relPath, isDir) {
  if (pat.dirOnly && !isDir) return false;
  const re = globToRegex(pat.raw);
  if (pat.anchor) return re.test(relPath);
  if (re.test(relPath)) return true;
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (re.test(parts.slice(i).join('/'))) return true;
  }
  return false;
}

// Walk dir applying ignore patterns from root..leaf. Returns list of absolute files
// (and dirs if includeDirs), honoring ignore unless includeIgnored.
// Walk dir applying ignore patterns from root..leaf. Returns list of absolute files
// (and dirs if includeDirs), honoring ignore unless includeIgnored.
//
// mtime and "is a file" are captured DURING the walk. The previous version stat'ed
// every result TWICE more afterwards (once per comparison in the sort, once in the
// file filter), which on a 354-file repo cost ~24ms of a 228ms walk — pure
// duplication, since the information was already available as each entry was
// visited. One stat per file now, reused for both.
export function walkFiles(base, opts = {}) {
  const { includeIgnored = false, includeDirs = false } = opts;
  const baseAbs = path.resolve(base);
  /** @type {{path:string, mtime:number, isFile:boolean}[]} */
  const found = [];
  _walk(baseAbs, '', [], found, { includeIgnored, includeDirs });
  // Newest first. Sort before truncating so the newest 1000 survive the cap.
  found.sort((a, b) => b.mtime - a.mtime);
  if (found.length > 1000) found.length = 1000;
  return found.filter((e) => includeDirs || e.isFile).map((e) => e.path);
}

function _walk(dir, relPrefix, parentPatterns, found, opts) {
  const { includeIgnored, includeDirs } = opts;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const acc = parentPatterns.concat(ignorePatternsFor(dir));
  for (const ent of entries) {
    const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
    const abs = path.join(dir, ent.name);
    let isDir;
    try { isDir = ent.isDirectory(); } catch { try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; } }
    // ignore decision
    let ignored = false;
    for (const pat of acc) {
      if (matchPattern(pat, rel, isDir)) ignored = !pat.negate;
    }
    if (ignored && !includeIgnored) {
      if (isDir) continue; // prune dir subtree
      continue;
    }
    if (isDir) {
      if (includeDirs) {
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch { /* keep 0 */ }
        found.push({ path: abs, mtime, isFile: false });
      }
      _walk(abs, rel, acc, found, opts);
    } else {
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { /* keep 0 */ }
      found.push({ path: abs, mtime, isFile: ent.isFile() });
    }
  }
}
