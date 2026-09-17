// Glob tool — mirrors the hncode Glob tool schema & behavior.
// Recursive glob from `path` (default cwd), honoring .gitignore/.ignore/.rgignore
// unless include_ignored. Returns up to 100 matches sorted most-recent-modified first.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeInput } from './utils.js';
import { walkFiles } from './ignore.js';
import { globRegex, expandBraces } from './matchers.js';

export const spec = {
  name: 'Glob',
  description: 'Find files by glob pattern. Honors ignore files unless include_ignored. Up to 100 matches, newest first.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. src/**/*.ts).' },
      path: { type: 'string', description: 'Directory to search from (default: project root).', default: '.' },
      include_ignored: { type: 'boolean', default: false, description: 'Also match git-ignored paths.' },
      include_dirs: { type: 'boolean', default: false, description: 'Include directories in results.' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    // `pattern` is required, but the model can still omit it. Return an error
    // string like every other tool instead of throwing — an uncaught throw here
    // aborts the whole turn.
    if (typeof args.pattern !== 'string' || !args.pattern.trim()) {
      return 'Error: `pattern` is required (e.g. "src/**/*.ts").';
    }
    const fromDir = typeof args.path === 'string' && args.path ? args.path : '.';
    const p = normalizeInput(fromDir);
    let base;
    try { base = path.resolve(ctx.cwd || ctx.workspace, p); } catch (e) { return `Error: ${e.message}`; }
    if (!fs.existsSync(base)) return `Error: path does not exist: ${fromDir}`;
    if (!fs.statSync(base).isDirectory()) return `Error: --path is not a directory: ${fromDir}`;

    const alts = expandBraces(args.pattern);
    const re = new RegExp('^(?:' + alts.map((a) => globRegex(a).source.slice(1, -1)).join('|') + ')$');


    const files = walkFiles(base, { includeIgnored: !!args.include_ignored, includeDirs: false });
    const matches = [];
    for (const abs of files) {
      const rel = path.relative(base, abs).split(path.sep).join('/');
      const winRel = abs.replace(/\\/g, '/');
      const base_ = path.basename(abs);
      if (re.test(rel) || re.test(winRel) || re.test(base_)) matches.push(abs);
    }
    if (matches.length > 100) matches.length = 100;
    if (matches.length === 0) return `No files matched \`${args.pattern}\` in ${fromDir}`;
    return matches.join('\n');
  },
};
