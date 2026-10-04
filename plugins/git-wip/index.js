// git-wip plugin — save and restore named WIP snapshots. The built-in /stash only
// does generic list/push/pop. This adds LABELED, timestamped WIP saves and a
// one-command restore by label, so "save my half-done work as 'feature-x' and
// come back to it later" is a single command instead of juggling stash indices.
//
// Mechanism: each WIP is a real git stash with a message containing a label tag
// (wip:<label>@<timestamp>). /git-wip list shows them with their labels; /git-wip
// restore <label> pops the most recent matching stash.
//
// Self-contained: Node builtins + public plugin API only; no ../src imports.
// LICENSE: MIT.

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
function run(cmd, cwd) {
  try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8' }) }; }
  catch (e) { return { ok: false, error: (e.stderr || e.stdout || e.message || '').toString() }; }
}
function listWips(cwd) {
  const r = run('git stash list', cwd);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^([^:]+):\s*On\s+\S+:\s*(.+)$/);
    return { ref: m ? m[1] : line.split(':')[0], msg: m ? m[2] : line };
  }).filter((e) => /wip:/.test(e.msg));
}
function restoreByLabel(cwd, label) {
  const matches = listWips(cwd).filter((e) => e.msg.includes(`wip:${label}`));
  if (!matches.length) return { ok: false, error: `No WIP named "${label}".` };
  // pop the most recent (first) matching stash
  const ref = matches[0].ref;
  const r = run(`git stash pop ${ref}`, cwd);
  if (!r.ok) return { ok: false, error: r.error + '\n(Resolve conflicts, then /git-wip restore ' + label + ' again or git stash pop manually.)' };
  return { ok: true, out: r.out };
}

export function install(api) {
  api.registerCommand({
    name: 'git-wip',
    description: 'Save/restore named WIP snapshots. /git-wip save <label> | restore <label> | list',
    argumentHint: 'save <label> | restore <label> | list',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const cwd = cwdOf(ctx);
      if (!isRepo(cwd)) { fail(`Not a git repository: ${cwd}`); return; }

      const parts = String(arg || '').trim().split(/\s+/);
      const sub = (parts[0] || 'list').toLowerCase();

      if (sub === 'list') {
        const wips = listWips(cwd);
        if (!wips.length) { say('No named WIP snapshots.'); return; }
        const lines = wips.map((e) => {
          const m = e.msg.match(/wip:(.+?)@(.+)$/);
          return `  ${m ? m[1] : e.msg}  (${m ? m[2] : e.ref})`;
        });
        say(`WIP snapshots:\n${lines.join('\n')}`);
        return;
      }

      if (sub === 'save') {
        const rest = parts.slice(1);
        const includeUntracked = rest[0] === '--all';
        const label = (includeUntracked ? rest.slice(1) : rest).join(' ') || 'wip';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const msg = `wip:${label}@${ts}`;
        // Do NOT `git add -A` first: that would sweep unrelated untracked files into
        // the stash. `git stash push` captures tracked modifications by default; pass
        // --include-untracked only when the user opts in with --all.
        const flag = includeUntracked ? '-u' : '';
        const r = run(`git stash push ${flag} -m ${JSON.stringify(msg)}`, cwd);
        if (!r.ok) { fail(`WIP save failed: ${r.error}`); return; }
        // Show what got stashed so the user can verify the snapshot's scope.
        const show = run(`git stash show -u --stat ${JSON.stringify('stash@{0}')}`, cwd);
        const detail = show.ok && show.out.trim() ? `\n${show.out.trim()}` : '';
        say(`Saved WIP "${label}" (${ts}).${detail}`);
        return;
      }

      if (sub === 'restore') {
        const label = parts.slice(1).join(' ');
        if (!label) { fail('Usage: /git-wip restore <label>'); return; }
        const r = restoreByLabel(cwd, label);
        if (!r.ok) { fail(`Restore failed: ${r.error}`); return; }
        say(`Restored WIP "${label}".`);
        return;
      }

      fail('Usage: /git-wip save <label> | restore <label> | list');
    },
  });
}

export default { name: 'git-wip', version: '1.0.0' };
