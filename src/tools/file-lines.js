// FileLines tool — reports how many lines a file has. Line count ONLY: it never
// returns file content (use Read for that). This lets an agent size a file
// cheaply before deciding whether/where to Read it.

import fs from 'node:fs';
import { resolvePath } from './utils.js';

export const spec = {
  name: 'FileLines',
  description: 'Count the lines of a file. Does NOT return content; use Read for that.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file.' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }

    if (!fs.existsSync(p)) return `Error: file not found: ${args.path}`;

    const stat = fs.statSync(p);
    if (!stat.isFile()) return `Error: not a file: ${args.path}`;

    // Count LINES only — never the content. Splitting on the same newline forms
    // Read normalizes keeps the count consistent with Read's own total.
    const lines = fs.readFileSync(p, 'utf8').split(/\r\n|\r|\n/);
    // A file ending in a newline splits with a trailing '' element; that is the
    // terminator of the previous line, not a line of its own.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    return `Lines: ${lines.length}`;
  },
};
