// Git tool — structured access to the operations a coding agent performs
// constantly, so it does not have to hand-write shell pipelines for status,
// staging, committing, branching and worktrees.
//
// Destructive operations are deliberately NOT exposed (no reset --hard, no
// checkout --, no branch -D): a mistake through this tool would be unrecoverable.
// The agent can still run those through Bash when the user explicitly asks.

import * as git from '../git.js';

const ACTIONS = ['status', 'diff', 'stage', 'unstage', 'commit', 'log', 'branch', 'switch', 'worktree'];

export const spec = {
  name: 'Git',
  description: `Run a git operation and return its result. Actions:
- status: branch, staged/unstaged/untracked files.
- diff: show changes. \`staged: true\` shows the index; \`path\` limits to one file.
- stage: add files to the index (omit \`paths\` to stage everything).
- unstage: remove files from the index.
- commit: commit the staged index with \`message\` (multi-line allowed). Stages everything first if nothing is staged.
- log: recent commits (use \`count\`, default 10).
- branch: list branches, or create one with \`create: "<name>"\`.
- switch: check out an existing branch named \`branch\`.
- worktree: list worktrees, or add/remove one for parallel work.

Use this instead of writing \`git\` shell pipelines. Destructive resets are not exposed; run those with Bash only if the user asked for it.`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'Which git operation to run.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'File paths (stage/unstage/diff).' },
      message: { type: 'string', description: 'Commit message (commit). May be multi-line.' },
      branch: { type: 'string', description: 'Branch name (switch/branch/worktree).' },
      create: { type: 'string', description: 'Create a branch with this name (branch action).' },
      from: { type: 'string', description: 'Base ref for a new branch (branch action).' },
      staged: { type: 'boolean', default: false, description: 'Show the staged diff (diff action).' },
      count: { type: 'integer', minimum: 1, description: 'Number of commits to show (log action; default 10).' },
      dir: { type: 'string', description: 'Worktree directory (worktree action).' },
      remove: { type: 'boolean', default: false, description: 'Remove the worktree instead of adding it (worktree action).' },
      force: { type: 'boolean', default: false, description: 'Force worktree removal (worktree action).' },
    },
    required: ['action'],
  },

  async execute(args, ctx) {
    const cwd = (ctx && (ctx.cwd || ctx.workspace)) || process.cwd();
    const action = String(args.action || '').trim();
    if (!ACTIONS.includes(action)) return `Error: unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`;
    if (!git.isRepo(cwd)) return `Error: not a git repository: ${cwd}`;

    switch (action) {
      case 'status': {
        const branch = git.currentBranch(cwd);
        const s = git.status(cwd);
        if (!s.ok) return `Error: ${s.error}`;
        const lines = [`branch: ${branch}`, `head: ${git.headSha(cwd)}`, ''];
        if (!s.entries.length) lines.push('Working tree clean.');
        else {
          lines.push(`Changes (${s.entries.length}):`);
          for (const e of s.entries) {
            const code = (e.x + e.y).trim() || '?';
            lines.push(`  [${code}] ${e.path}${e.origPath ? ` (from ${e.origPath})` : ''}`);
          }
        }
        return lines.join('\n');
      }

      case 'diff': {
        const a = ['diff'];
        if (args.staged) a.push('--cached');
        a.push('--stat');
        // paths after --
        const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];
        const statR = git.runGit(a.concat(paths.length ? ['--', ...paths] : []), cwd);
        if (!statR.ok) return `Error: ${statR.stderr.trim() || statR.error}`;
        if (!statR.stdout.trim()) return args.staged ? 'No staged changes.' : 'No changes.';
        // Also include the full diff, bounded so a huge change cannot flood context.
        const full = git.runGit(['diff'].concat(args.staged ? ['--cached'] : []).concat(paths.length ? ['--', ...paths] : []), cwd);
        const MAX = 60 * 1024;
        let body = full.stdout || '';
        let note = '';
        if (body.length > MAX) { body = body.slice(0, MAX); note = `\n... [diff truncated at ${MAX} chars]`; }
        return `${statR.stdout.trim()}\n\n${body}${note}`;
      }

      case 'stage': {
        const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];
        const r = git.stage(paths, cwd);
        if (!r.ok) return `Error: ${r.error}`;
        const staged = git.stagedFiles(cwd);
        return `Staged ${paths.length || 'all'} path(s). Index now holds ${staged.length} file(s):\n${staged.join('\n')}`;
      }

      case 'unstage': {
        const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];
        const r = git.unstage(paths, cwd);
        return r.ok ? `Unstaged ${paths.length || 'all'} path(s).` : `Error: ${r.error}`;
      }

      case 'commit': {
        const message = String(args.message || '').trim();
        if (!message) return 'Error: `message` is required for a commit.';
        // Stage everything when the index is empty — "commit my changes" is the
        // common request and an empty-index commit is almost never intended.
        let autoStaged = false;
        if (!git.hasStagedChanges(cwd)) {
          const st = git.stage([], cwd);
          if (!st.ok) return `Error staging: ${st.error}`;
          autoStaged = true;
        }
        const r = git.commit(message, cwd);
        if (!r.ok) return `Error: ${r.error}`;
        return `${autoStaged ? 'Staged all changes.\n' : ''}Committed ${r.sha}.\n${r.stdout}`;
      }

      case 'log': {
        const n = Math.max(1, Math.min(200, Number(args.count) || 10));
        const r = git.runGit(['log', `-${n}`, '--pretty=format:%h %ad %s', '--date=short'], cwd);
        return r.ok ? (r.stdout.trim() || 'No commits yet.') : `Error: ${r.stderr.trim() || r.error}`;
      }

      case 'branch': {
        if (args.create) {
          const r = git.createBranch(args.create, cwd, args.from);
          return r.ok ? `Created and switched to branch ${args.create}.` : `Error: ${r.error}`;
        }
        const cur = git.currentBranch(cwd);
        const list = git.listBranches(cwd);
        return `Branches (current: ${cur}):\n` + list.map((b) => `  ${b === cur ? '* ' : '  '}${b}`).join('\n');
      }

      case 'switch': {
        const r = git.switchBranch(args.branch, cwd);
        return r.ok ? `Switched to ${args.branch}.` : `Error: ${r.error}`;
      }

      case 'worktree': {
        if (!args.dir) {
          const list = git.listWorktrees(cwd);
          return `Worktrees (${list.length}):\n` + list.map((w) => `  ${w.path} ${w.branch ? '[' + w.branch + ']' : ''}`).join('\n');
        }
        if (args.remove) {
          const r = git.removeWorktree(args.dir, cwd, { force: !!args.force });
          return r.ok ? `Removed worktree ${args.dir}.` : `Error: ${r.error}`;
        }
        const r = git.addWorktree(args.dir, args.branch, cwd);
        if (!r.ok) return `Error: ${r.error}`;
        return r.reused ? `Worktree already present: ${r.path}` : `Worktree created at ${r.path}${r.branch ? ` on ${r.branch}` : ''}.`;
      }

      default:
        return `Error: unhandled action "${action}".`;
    }
  },
};