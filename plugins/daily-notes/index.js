// daily-notes plugin — write today's work summary to ~/notes/YYYY-MM-DD.md.
//
// hncode has /export-md (full session transcript) but nothing that captures a
// short, dated work-log of "what I did today". This fills that gap: it gathers
// the session's agenda/title, the todo list, and the day's git commits, hands a
// concise digest to the agent, and writes a Markdown note you can keep.
//
// Self-contained: Node builtins + public plugin API only; no ../src imports.
// LICENSE: MIT.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

function cwdOf(ctx) {
  return ctx.state?.cwd || ctx.state?.workspace || (ctx.cfg && ctx.cfg.workspace) || process.cwd();
}
function out(ctx) {
  if (typeof ctx?.app === 'function') return (m) => ctx.app(m);
  if (typeof ctx?.api?.notice === 'function') return (m) => ctx.api.notice(m, 'info');
  return () => {};
}
function err(ctx) {
  if (typeof ctx?.appErr === 'function') return (m) => ctx.appErr(m);
  if (typeof ctx?.app === 'function') return (m) => ctx.app(m);
  if (typeof ctx?.api?.notice === 'function') return (m) => ctx.api.notice(m, 'error');
  return () => {};
}

function todayCommits(cwd) {
  try {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const iso = since.toISOString().slice(0, 19).replace('T', ' ');
    const out = execSync(`git log --since="${iso}" --pretty=format:"- %s (%h)"`, { cwd, encoding: 'utf8' });
    return out.trim();
  } catch { return ''; }
}

export function install(api) {
  api.registerCommand({
    name: 'daily-notes',
    description: 'Write today\'s work summary (agenda, todos, git commits) to ~/notes/YYYY-MM-DD.md.',
    argumentHint: '[extra note]',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const cwd = cwdOf(ctx);
      const stamp = new Date().toISOString().slice(0, 10);
      const notesDir = path.join(os.homedir(), 'notes');
      const outPath = path.join(notesDir, `${stamp}.md`);

      const session = ctx.state?.session || ctx.session;
      const title = (session && (session.title || session.goal)) || ctx.state?.title || '(untitled session)';
      const todos = (ctx.state && Array.isArray(ctx.state.todos)) ? ctx.state.todos : [];
      const commits = todayCommits(cwd);
      const extra = String(arg || '').trim();

      const todoLines = todos.length
        ? todos.map((t) => `- [${t.status === 'done' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.title}`).join('\n')
        : '(no todos)';
      const commitLines = commits || '(no commits today)';

      const digest =
`# Work log — ${stamp}

## Focus
${title}

## Todos
${todoLines}

## Commits today
${commitLines}
${extra ? '\n## Notes\n' + extra : ''}`;

      if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
      api.writeFile(outPath, digest);
      say(`Daily note written to ${outPath}`);
      return;
    },
  });
}

export default { name: 'daily-notes', version: '1.0.0' };
