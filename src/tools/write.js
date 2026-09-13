// Write tool — mirrors the hncode Write tool schema & behavior.

import fs from 'node:fs';
import { resolvePath, ensureDir, truncateBuf } from './utils.js';

export const spec = {
  name: 'Write',
  description: 'Create or overwrite a file (prefer Edit for existing files). mode: overwrite (default) | append.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file.' },
      content: { type: 'string', description: 'Content to write.' },
      mode: { type: 'string', enum: ['overwrite', 'append'], default: 'overwrite', description: 'Overwrite or append.' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    try {
      ensureDir(p);
      const flag = args.mode === 'append' ? 'a' : 'w';
      fs.writeFileSync(p, args.content, { flag });
    } catch (e) { return `Error writing ${args.path}: ${e.message}`; }
    const size = fs.statSync(p).size;
    return `File written: ${args.path} (${size} bytes)`;
  },
};
