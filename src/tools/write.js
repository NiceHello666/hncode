// Write tool — mirrors the hncode Write tool schema & behavior.

import fs from 'node:fs';
import { resolvePath, ensureDir, truncateBuf, checkpointBeforeWrite } from './utils.js';

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
    // Validate BEFORE touching the filesystem. A truncated or malformed tool call
    // arrives as `{ raw, _rawLen }` (agent.js falls back to that shape when the
    // streamed JSON will not parse) or with `content` simply missing — and
    // `fs.writeFileSync(p, undefined)` then threw Node's own
    // `The "data" argument must be of type string…`, which told the model nothing
    // about what to do or why. An unvalidated path is worse: `resolvePath(undefined)`
    // resolves to the workspace root, so a truncated call could target the wrong
    // file while the model believed it was writing a new one.
    const truncated = args && args.raw
      ? ` The arguments did not parse as JSON${args._rawLen ? ` (${args._rawLen} characters received)` : ''} — the call was most likely truncated. Retry, and split a large file across several Write calls (first part with mode "overwrite", the rest appended with mode "append").`
      : '';
    const path_ = args && args.path;
    if (typeof path_ !== 'string' || !path_.trim()) {
      return `Error: \`path\` is required and must be a non-empty string.${truncated}`;
    }
    if (typeof args.content !== 'string') {
      const got = args.content === null ? 'null' : typeof args.content;
      return `Error: \`content\` is required and must be a string (got ${got}).${truncated}`;
    }
    let p;
    try { p = resolvePath(path_, ctx); } catch (e) { return e.message; }
    // `mode` is an enum in the schema, but the schema is not enforced locally: an
    // unexpected value silently meant "overwrite" before. Say so instead.
    const mode = args.mode == null ? 'overwrite' : args.mode;
    if (mode !== 'overwrite' && mode !== 'append') {
      return `Error: invalid mode ${JSON.stringify(mode)}; use "overwrite" or "append".`;
    }
    // Checkpoint the pre-write content so /undo can put it back (file-history.js).
    // Taken BEFORE the write, once per turn, so the recorded version is the state
    // before any of this turn's changes.
    checkpointBeforeWrite(p, ctx);
    try {
      ensureDir(p);
      const flag = mode === 'append' ? 'a' : 'w';
      fs.writeFileSync(p, args.content, { flag });
    } catch (e) { return `Error writing ${path_}: ${e.message}`; }
    const size = fs.statSync(p).size;
    const verb = mode === 'append' ? 'appended to' : 'written';
    return `File ${verb}: ${path_} (${size} bytes)`;
  },
};
