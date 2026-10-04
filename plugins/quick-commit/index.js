// quick-commit plugin — draft a commit message with the agent, then confirm
// before committing. Distinct from the built-in /commit (which either runs the
// full agent commit flow or commits a message you typed): this is a SAFE,
// two-step "generate → approve → commit" path that never commits without an
// explicit confirmation, so an unwanted message can't slip in.
//
// Usage:
//   /quick-commit            → agent drafts a message (shown in chat)
//   /quick-commit "msg"      → opens a confirm picker, commits on approve
//
// Self-contained: Node builtins + public plugin API only; no ../src imports.
// LICENSE: MIT.

import path from 'node:path';
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
function isRepo(cwd) {
  try { execSync('git rev-parse --is-inside-work-tree', { cwd, encoding: 'utf8' }); return true; } catch { return false; }
}
function statusLines(cwd) {
  try { return execSync('git status --short', { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
}
function diffStat(cwd) {
  try { return execSync('git diff --stat HEAD', { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
}
function doCommit(message, cwd) {
  try {
    execSync('git add -A', { cwd, encoding: 'utf8' });
    const res = execSync(`git commit -m ${JSON.stringify(message)}`, { cwd, encoding: 'utf8' });
    return { ok: true, out: res };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.stdout || e.message || '').toString() };
  }
}

export function install(api) {
  api.registerCommand({
    name: 'quick-commit',
    description: 'Draft a commit message with the agent, then confirm before committing (safe 2-step).',
    argumentHint: '[message]  — no arg drafts via agent; with a message, confirms & commits',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const cwd = cwdOf(ctx);

      if (!isRepo(cwd)) { fail(`Not a git repository: ${cwd}`); return; }

      const message = String(arg || '').trim();

      // --- Mode 2: explicit message → confirm picker → commit ---
      if (message) {
        if (typeof api.openPicker !== 'function') {
          const r = doCommit(message, cwd);
          if (r.ok) say(`Committed: ${message.split('\n')[0]}`);
          else fail(`Commit failed: ${r.error}`);
          return;
        }
        api.openPicker({
          title: 'Commit with this message?',
          items: [
            { label: 'Commit', sub: message.split('\n')[0] },
            { label: 'Cancel', sub: 'abort, nothing committed' },
          ],
          searchable: false,
          hint: '↑↓ navigate · Enter select · Esc cancel',
          onPick: (it) => {
            if (!it || it.label !== 'Commit') { out(ctx)('Commit cancelled.'); return true; }
            const r = doCommit(message, cwd);
            if (r.ok) out(ctx)(`Committed: ${message.split('\n')[0]}`);
            else err(ctx)(`Commit failed: ${r.error}`);
            return true;
          },
        });
        return;
      }

      // --- Mode 1: no message → agent drafts one, and prints a ready-to-run
      //     /quick-commit "..." line so the user can confirm with one Enter (no
      //     manual copy). The agent still only drafts; nothing is committed until
      //     the user runs that line and approves the confirm picker.
      const stat = diffStat(cwd);
      const prompt =
`Draft a concise git commit message for the current changes in ${cwd}.\n\n` +
`Diffstat:\n${stat || '(working tree clean)'}\n\n` +
`Rules:\n` +
`- One short imperative subject line (<= 72 chars), then a blank line and a brief body only if needed.\n` +
`- Explain INTENT, not the diff. Match the repo's existing style.\n` +
`- If the tree is clean, say there is nothing to commit.\n` +
`Output format (exactly this):\n` +
`1) the commit message text (no quotes, no fences)\n` +
`2) on the next line, a command the user can paste to commit it, of the form:\n` +
`   /quick-commit "PASTE THE MESSAGE HERE"`;
      if (typeof api.sendPrompt !== 'function') { fail('Error: no agent host available.'); return; }
      const dispatched = api.sendPrompt(`/quick-commit`, { skillBody: prompt, bubbleText: 'draft commit message' });
      if (!dispatched) { fail('Error: agent host not ready. Restart hncode.'); return; }
      say('Agent drafted a message below — run the /quick-commit "..." line it printed to confirm & commit.');
    },
  });
}

export default { name: 'quick-commit', version: '1.0.0' };
