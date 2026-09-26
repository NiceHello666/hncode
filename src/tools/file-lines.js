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
    // See read.js: a missing path reaches resolvePath(undefined), which resolves to
    // the workspace root rather than failing.
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return 'Error: `path` is required and must be a non-empty string.';
    }
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }

    if (!fs.existsSync(p)) return `Error: file not found: ${args.path}`;

    const stat = fs.statSync(p);
    if (!stat.isFile()) return `Error: not a file: ${args.path}`;

    // Count LINES only — never the content. Read the file in bounded chunks and
    // count newlines, so a huge file is not pulled wholesale into memory just to
    // answer "how many lines". Any of \r\n, \r, or \n counts as one line break,
    // matching the newline forms Read normalizes.
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch { return `Error: cannot open ${args.path}`; }
    const CHUNK = 256 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let lineBreaks = 0;                // count of \r\n, \r, or \n sequences
    let prevCR = false;
    let lastWasBreak = false;          // whether the last byte seen was a line break
    let read = 0;
    try {
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CHUNK, read);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) {
          const b = buf[i];
          if (b === 0x0a) {           // \n
            if (!prevCR) lineBreaks++;
            prevCR = false;
            lastWasBreak = true;
          } else if (b === 0x0d) {    // \r
            lineBreaks++;
            prevCR = true;
            lastWasBreak = true;
          } else {
            prevCR = false;
            lastWasBreak = false;
          }
        }
        if (n < CHUNK) break;
        read += n;
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    // "a\nb\nc" is 3 lines; "a\nb\nc\n" is also 3 (the trailing \n terminates
    // the last line, it does not open a new one). So drop the final break.
    const lines = 1 + lineBreaks - (lastWasBreak ? 1 : 0);
    return `Lines: ${Math.max(1, lines)}`;
  },
};
