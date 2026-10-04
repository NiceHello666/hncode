// Memory tool — the agent records a durable note for FUTURE sessions.
//
// Distinct from /personal: that file is the USER's standing preferences and the
// agent must never write it. This tool writes MEMORY.md, which is the agent's own
// scratchpad, injected into the system prompt on later turns (see config.js's
// readMemory). The point is to stop rediscovering the same facts every session —
// build quirks, a command that works here, a decision the user already made.

import { appendMemory, readMemoryRaw, memoryFile } from '../config.js';

export const spec = {
  name: 'Memory',
  description: `Save a durable note for FUTURE sessions, or list what is already saved.

Use it when you learn something that will still be true next week and that you would
otherwise have to rediscover: a build/test command that works in this repo, a layout
quirk, a convention the user asked for, a decision they already made, a gotcha that
cost you a debugging cycle.

Do NOT use it for:
- things already in AGENTS.md or the code (read them instead — they are the source);
- facts about the CURRENT task or its progress (use TodoList; this file outlives the task);
- anything the user asked you to keep quiet, secrets, tokens, or credentials;
- one-off details you will never need again.

Write ONE short note per call, in the user's own language. Prefer several small notes
over one long entry: a note that is wrong or stale later can be edited out of a file
you can read back.

Scope:
- project (default) — stored in this workspace, follows the repository;
- global — stored in your home directory, applies to every workspace.`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list'],
        description: 'add a note, or list what is stored. Defaults to add.',
      },
      note: {
        type: 'string',
        description: 'The note to save (one or two sentences). Required when action is add.',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'Which memory to write to. Defaults to project.',
      },
    },
    required: [],
  },
  async execute(args, ctx) {
    // A malformed argument must not throw: an uncaught error here aborts the turn.
    const action = String(args.action || 'add').toLowerCase();
    const scope = String(args.scope || 'project').toLowerCase() === 'global' ? 'global' : 'project';
    const workspace = (ctx && (ctx.workspace || ctx.cwd)) || process.cwd();

    if (action === 'list') {
      const project = readMemoryRaw('project', workspace).trim();
      const global = readMemoryRaw('global', workspace).trim();
      const out = [];
      out.push(`project (${memoryFile('project', workspace)}):`);
      out.push(project || '  (empty)');
      out.push('');
      out.push(`global (${memoryFile('global', workspace)}):`);
      out.push(global || '  (empty)');
      return out.join('\n');
    }

    if (action !== 'add') {
      return `Error: unknown action ${JSON.stringify(action)}; use "add" or "list".`;
    }
    const note = String(args.note == null ? '' : args.note).trim();
    if (!note) return 'Error: `note` is required when action is "add".';
    // Guard against the file quietly becoming a transcript. The tool is for durable
    // facts, and a pasted log is neither durable nor a fact.
    if (note.length > 600) {
      return `Error: the note is ${note.length} characters; keep it under 600 (save a summary, not a dump).`;
    }
    try {
      const file = appendMemory(scope, workspace, note);
      return `Saved to ${scope} memory (${file}).`;
    } catch (e) {
      return `Error writing memory: ${e.message}`;
    }
  },
};
