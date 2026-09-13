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

function globToRegex(pattern) {
  return new RegExp(globToRegexSource(pattern));
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
export function walkFiles(base, opts = {}) {
  const results = [];
  const { includeIgnored = false, includeDirs = false } = opts;
  const baseAbs = path.resolve(base);
  _walk(baseAbs, '', [], results, { includeIgnored, includeDirs });
  // sort by mtime desc for a "most recent first" feel
  results.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return b < a ? 1 : -1; }
  });
  if (results.length > 1000) results.length = 1000;
  try { if (!includeDirs) return results.filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }); } catch { return results; }
  return results;
}

function _walk(dir, relPrefix, parentPatterns, results, opts) {
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
      if (includeDirs) results.push(abs);
      _walk(abs, rel, acc, results, opts);
    } else {
      results.push(abs);
    }
  }
}
