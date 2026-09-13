// Grep tool — mirrors the hncode Grep tool schema & behavior.
// Primary path uses ripgrep (`rg`) for full fidelity; falls back to a pure-JS
// walker when rg is unavailable or multiline searching is requested.

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { normalizeInput, isProbablyTextFile, truncateBuf } from './utils.js';
import { walkFiles } from './ignore.js';
import { matchGlob } from './matchers.js';

export const spec = {
  name: 'Grep',
  description: 'Search file contents by regex. output_mode: content (default) | files_with_matches | count_matches. Honors ignore files unless include_ignored.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression to search for.' },
      path: { type: 'string', description: 'Directory or file to search (default: cwd).', default: '.' },
      glob: { type: 'string', description: 'Glob filter for which files are searched (e.g. *.ts).' },
      type: { type: 'string', description: 'File-type filter (ripgrep -t, e.g. ts, py, go).' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count_matches'], default: 'content', description: 'Matching lines, matching files, or per-file counts.' },
      '-i': { type: 'boolean', default: false, description: 'Case-insensitive search.' },
      '-n': { type: 'boolean', default: false, description: 'Prefix each match with its 1-based line number.' },
      '-A': { type: 'integer', minimum: 0, description: 'Lines of context after each match.' },
      '-B': { type: 'integer', minimum: 0, description: 'Lines of context before each match.' },
      '-C': { type: 'integer', minimum: 0, description: 'Lines of context around each match (alias for -A/-B).' },
      head_limit: { type: 'integer', minimum: 0, description: 'Limit output to the first N matches/lines.' },
      offset: { type: 'integer', minimum: 0, description: 'Leading matches/lines to skip.' },
      multiline: { type: 'boolean', default: false, description: 'Match across newlines.' },
      include_ignored: { type: 'boolean', default: false, description: 'Search ignored files too.' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const p = normalizeInput(args.path || '.');
    const base = path.resolve(ctx.cwd || ctx.workspace, p);
    if (!fs.existsSync(base)) return `Error: path does not exist: ${args.path}`;
    if (!args.multiline && hasRg()) return grepRg(args, base, ctx);
    return grepJs(args, base, ctx);
  },
};

function hasRg() {
  try { cp.spawnSync('rg', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function buildRgArgs(args, base) {
  const a = ['--no-heading', '--line-number', '--no-config', '-e', args.pattern];
  if (args['-i']) a.push('-i');
  const before = args['-B'] || (args['-C'] || 0);
  const after = args['-A'] || (args['-C'] || 0);
  if (before) a.push('-B', String(before));
  if (after) a.push('-A', String(after));
  if (args.glob) a.push('-g', args.glob);
  if (args.type) a.push('-t', args.type);
  if (args.output_mode === 'files_with_matches') a.push('-l');
  else if (args.output_mode === 'count_matches') a.push('-c');
  if (args.include_ignored) a.push('--no-ignore');
  a.push('--', base);
  return a;
}

function grepRg(args, base, ctx) {
  let out;
  try {
    const r = cp.spawnSync('rg', buildRgArgs(args, base), {
      cwd: ctx.cwd || ctx.workspace,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    out = r.stdout || '';
    if (r.status > 1 && r.stderr) return `rg error: ${r.stderr.trim()}`;
  } catch (e) {
    return `rg unavailable: ${e.message}; falling back`;
  }
  return paginate(out, args);
}

function grepJs(args, base, ctx) {
  const flags = 'g' + (args['-i'] ? 'i' : '') + (args.multiline ? 's' : '');
  const re = new RegExp(args.pattern, flags);
  const files = walkFiles(base, { includeIgnored: !!args.include_ignored, includeDirs: false });
  const filtered = files.filter((abs) => {
    if (args.glob) {
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (!matchGlob(args.glob, rel) && !matchGlob(args.glob, path.basename(abs))) return false;
    }
    if (args.type) {
      const ext = path.extname(abs).toLowerCase().slice(1);
      if (ext !== args.type) return false;
    }
    return true;
  });

  const out = [];
  for (const abs of filtered) {
    let txt;
    try {
      const buf = fs.readFileSync(abs);
      if (!isProbablyTextFile(buf)) continue;
      txt = truncateBuf(buf);
    } catch { continue; }
    const mode = args.output_mode;

    if (args.multiline) {
      const ms = Array.from(txt.matchAll(re));
      if (ms.length === 0) continue;
      if (mode === 'files_with_matches') { out.push(abs); continue; }
      if (mode === 'count_matches') { out.push(`${abs}:${ms.length}`); continue; }
      const lines = txt.split('\n');
      for (const mm of ms) {
        const lineNo = txt.slice(0, mm.index).split('\n').length; // 1-based
        emitContext(out, abs, lineNo - 1, lines, args);
      }
    } else {
      const lines = txt.split('\n');
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          count++;
          if (mode === 'files_with_matches') { out.push(abs); break; }
          if (mode === 'count_matches') continue;
          emitContext(out, abs, i, lines, args);
        }
      }
      if (count > 0 && mode === 'count_matches') out.push(`${abs}:${count}`);
    }
  }
  return paginate(out.join('\n'), args);
}

function emitContext(out, file, idx, lines, a) {
  const before = a['-C'] || a['-B'] || 0;
  const after = a['-C'] || a['-A'] || 0;
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length - 1, idx + after);
  for (let k = start; k <= end; k++) {
    if (k === idx) out.push(`${file}:${k + 1}:${lines[k]}`);
    else out.push(`${file}-${k + 1}-${lines[k]}`);
  }
}

function paginate(raw, args) {
  if (raw === '' || raw === undefined || raw === null) return 'No matches found.';
  let lines = raw.split('\n').filter((l) => l.length > 0);
  if (args.offset) lines = lines.slice(args.offset);
  if (args.head_limit) lines = lines.slice(0, args.head_limit);
  if (lines.length === 0) return 'No matches found.';
  return lines.join('\n');
}
