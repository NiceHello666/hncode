// Git workflow helpers — structured access to the operations a coding agent
// performs constantly, so the model (and the /git, /commit, /branch commands)
// do not have to hand-write shell pipelines for them.
//
// Everything here shells out to the user's own `git`. Nothing is reimplemented:
// the point is a typed, testable wrapper that reports clean errors and never
// runs a destructive command implicitly. `isRepo()` gates every other call so a
// non-repo directory yields a clear message instead of a raw git error.
//
// Destructive operations (reset --hard, checkout --, branch -D) are NOT exposed
// here. The agent can still run them through Bash if the user asks; a helper
// module should not make them easy to reach by accident.

import cp from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Force UTF-8 for git's OWN output regardless of the console codepage, and stop
// it octal-escaping non-ASCII filenames. Without these, on a Windows console
// using a non-UTF-8 codepage (GBK/CP936, etc.) git prints paths and messages in
// that codepage and Node's utf8 decode mangles them — and even in UTF-8 locales
// `git status` quotes any non-ASCII path as `"\350\257\264\346\230\216.md"`,
// which the model then cannot match to a real file.
//   i18n.logOutputEncoding=utf-8 : commit messages on stdout
//   core.quotepath=false         : raw (unquoted) non-ASCII paths
//   i18n.commitEncoding=utf-8    : how we write messages back
// Passed with -c so nothing is written to the user's git config.
const GIT_ENV = [
  '-c', 'core.quotepath=false',
  '-c', 'i18n.logOutputEncoding=utf-8',
  '-c', 'i18n.commitEncoding=utf-8',
];

// Run git with args in `cwd`. Returns { ok, stdout, stderr, code, error }.
// Never throws: a missing git binary or a non-repo is data, not an exception.
export function runGit(args, cwd, opts = {}) {
  const timeout = opts.timeoutMs || 30_000;
  try {
    const r = cp.spawnSync('git', [...GIT_ENV, ...args], {
      cwd: cwd || process.cwd(),
      // Decode git's bytes as UTF-8 explicitly. `encoding: 'utf8'` is what we
      // want, but the environment is also pinned below so a console codepage
      // cannot override the byte stream before it reaches us.
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
    });
    if (r.error) return { ok: false, stdout: '', stderr: '', code: null, error: r.error.message };
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', code: r.status, error: null };
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', code: null, error: e.message };
  }
}

export function isRepo(cwd) {
  const r = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

// "{branch}" or a detached-HEAD short sha. Empty when not a repo.
export function currentBranch(cwd) {
  const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!r.ok) return '';
  const b = r.stdout.trim();
  if (b && b !== 'HEAD') return b;
  // Detached: report the short sha so the status line is still meaningful.
  const s = runGit(['rev-parse', '--short', 'HEAD'], cwd);
  return s.ok ? `(detached ${s.stdout.trim()})` : '';
}

export function headSha(cwd, short = true) {
  const r = runGit(short ? ['rev-parse', '--short', 'HEAD'] : ['rev-parse', 'HEAD'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

// Parsed `git status --porcelain=v1`. Each entry:
//   { x, y, path, origPath }  — x = index status, y = worktree status
// `??` is untracked, `!!` is ignored (not reported by default here).
export function status(cwd) {
  const r = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  if (!r.ok) return { ok: false, error: r.error || r.stderr.trim() || 'git status failed', entries: [] };
  const parts = r.stdout.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const x = e[0], y = e[1];
    const p = e.slice(3);
    // A rename/copy is followed by the ORIGINAL path in the next NUL field.
    if (x === 'R' || x === 'C') {
      const orig = parts[++i] || '';
      entries.push({ x, y, path: p, origPath: orig });
    } else {
      entries.push({ x, y, path: p });
    }
  }
  return { ok: true, entries, error: null };
}

// A compact human summary: "M file.js", "?? new.txt", …
export function statusLines(cwd) {
  const s = status(cwd);
  if (!s.ok) return [`git status failed: ${s.error}`];
  if (!s.entries.length) return ['Working tree clean.'];
  return s.entries.map((e) => `${(e.x + e.y).trim() || '??'} ${e.path}${e.origPath ? ` (from ${e.origPath})` : ''}`);
}

// Stage paths (default: everything, `git add -A`). Returns { ok, error }.
export function stage(paths, cwd) {
  // `-A` is a FLAG, not a pathspec: it must not follow `--`. With explicit
  // paths, `--` separates them from a path that looks like a flag.
  const real = (paths && paths.length) ? ['add', '--', ...paths] : ['add', '-A'];
  const r = runGit(real, cwd);
  return { ok: r.ok, error: r.ok ? null : (r.stderr.trim() || r.error || 'git add failed') };
}

export function unstage(paths, cwd) {
  const real = (paths && paths.length) ? ['reset', 'HEAD', '--', ...paths] : ['reset', 'HEAD'];
  const r = runGit(real, cwd);
  return { ok: r.ok, error: r.ok ? null : (r.stderr.trim() || r.error || 'git reset failed') };
}

// Files changed in the index (staged), for a commit preview.
export function stagedFiles(cwd) {
  const r = runGit(['diff', '--cached', '--name-only'], cwd);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

// Is the index empty (nothing staged)?
export function hasStagedChanges(cwd) {
  const r = runGit(['diff', '--cached', '--quiet'], cwd);
  // exit 1 means there ARE differences.
  return r.code === 1;
}

// Commit the staged index. `message` may be multi-line; it is passed with -m
// repeated so newlines survive every platform's arg handling.
export function commit(message, cwd, opts = {}) {
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return { ok: false, error: 'commit message must not be empty' };
  const args = ['commit'];
  if (opts.amend) args.push('--amend');
  if (opts.noVerify) args.push('--no-verify');
  for (const line of msg.split('\n')) args.push('-m', line);
  const r = runGit(args, cwd, { timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, error: r.stderr.trim() || r.error || 'git commit failed', stdout: r.stdout };
  const sha = headSha(cwd);
  return { ok: true, sha, stdout: r.stdout.trim() };
}

export function listBranches(cwd) {
  const r = runGit(['branch', '--format=%(refname:short)'], cwd);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

// Create and switch to a branch. `from` optionally bases it on another ref.
export function createBranch(name, cwd, from) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'branch name must not be empty' };
  const args = ['switch', '-c', n];
  if (from) args.push(from);
  let r = runGit(args, cwd);
  // Older git (< 2.23) has no `switch`.
  if (!r.ok && /switch/.test(r.stderr) && /unknown|not a git command/i.test(r.stderr)) {
    r = runGit(from ? ['checkout', '-b', n, from] : ['checkout', '-b', n], cwd);
  }
  return { ok: r.ok, error: r.ok ? null : (r.stderr.trim() || r.error || 'git switch failed') };
}

export function switchBranch(name, cwd) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'branch name must not be empty' };
  let r = runGit(['switch', n], cwd);
  if (!r.ok && /unknown|not a git command/i.test(r.stderr)) r = runGit(['checkout', n], cwd);
  return { ok: r.ok, error: r.ok ? null : (r.stderr.trim() || r.error || 'git switch failed') };
}

export function remoteUrl(cwd) {
  const r = runGit(['remote', 'get-url', 'origin'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

// Parse a git remote URL into { host, owner, repo }. Handles https and ssh
// (scp-like) forms. Returns null when it does not look like one.
export function parseRemote(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  let m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (m) {
    const parts = m[2].split('/').filter(Boolean);
    if (parts.length >= 2) return { host: m[1], owner: parts[0], repo: parts[parts.length - 1] };
  }
  m = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(s);
  if (m) {
    const parts = m[2].split('/').filter(Boolean);
    if (parts.length >= 2) return { host: m[1], owner: parts[0], repo: parts[parts.length - 1] };
  }
  return null;
}

// A "create a PR" URL for the current branch, or '' when the remote is unknown.
// This does NOT open a browser or call an API: it hands the user a link, which
// is the portable behaviour across hosts (GitHub/GitLab/Bitbucket all accept a
// compare URL for the common hosts; unknown hosts get the repo page).
export function prUrl(cwd, base = 'main') {
  const info = parseRemote(remoteUrl(cwd));
  if (!info) return '';
  const branch = currentBranch(cwd);
  if (!branch || branch.startsWith('(')) return '';
  const { host, owner, repo } = info;
  if (host.includes('github.com')) {
    return `https://${host}/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
  }
  if (host.includes('gitlab')) {
    return `https://${host}/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`;
  }
  if (host.includes('bitbucket')) {
    return `https://${host}/${owner}/${repo}/pull-requests/new?source=${encodeURIComponent(branch)}`;
  }
  return `https://${host}/${owner}/${repo}`;
}

// --- worktree support (parallel sessions that cannot collide) ----------------

export function listWorktrees(cwd) {
  const r = runGit(['worktree', 'list', '--porcelain'], cwd);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) out.push(cur); cur = { path: line.slice(9).trim() }; }
    else if (!cur) continue;
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line === 'bare') cur.bare = true;
    else if (line === 'detached') cur.detached = true;
  }
  if (cur) out.push(cur);
  return out;
}

// Normalize a path for comparison. Two problems make a raw string compare fail:
//   * git reports worktree paths with FORWARD slashes even on Windows, while
//     path.resolve() yields backslashes;
//   * on Windows a path can be spelled with an 8.3 short name (`ADMINI~1`) or
//     the long name (`Administrator`) — they are the same directory.
// realpathSync resolves both; it also lower-cases via lowercasing after resolve.
function samePath(a, b) {
  const norm = (p) => {
    let r;
    const abs = path.resolve(String(p || ''));
    try { r = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs); }
    catch { r = abs; }                       // may not exist yet: fall back
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

// Create (or reuse) a worktree for `branch` at `dir`.
export function addWorktree(dir, branch, cwd, opts = {}) {
  const target = path.resolve(dir);
  if (fs.existsSync(target)) {
    const existing = listWorktrees(cwd).find((w) => samePath(w.path, target));
    if (existing) return { ok: true, path: target, reused: true, branch: existing.branch };
    return { ok: false, error: `path already exists and is not a worktree: ${target}` };
  }
  const branches = listBranches(cwd);
  const args = ['worktree', 'add'];
  if (opts.detach) args.push('--detach');
  args.push(target);
  if (branch) args.push(branches.includes(branch) ? branch : '-b', ...(branches.includes(branch) ? [] : [branch]));
  const r = runGit(args, cwd);
  return r.ok ? { ok: true, path: target, reused: false, branch } : { ok: false, error: r.stderr.trim() || r.error };
}

export function removeWorktree(dir, cwd, opts = {}) {
  const args = ['worktree', 'remove', path.resolve(dir)];
  if (opts.force) args.push('--force');
  const r = runGit(args, cwd);
  return { ok: r.ok, error: r.ok ? null : (r.stderr.trim() || r.error) };
}

// A short context block for the system prompt / status line: branch, dirty
// count, and the remote. Empty when not a repo.
export function summary(cwd) {
  if (!isRepo(cwd)) return '';
  const branch = currentBranch(cwd);
  const s = status(cwd);
  const dirty = s.ok ? s.entries.length : 0;
  const info = parseRemote(remoteUrl(cwd));
  const remote = info ? `${info.owner}/${info.repo}` : '';
  return [
    `branch: ${branch || '(unknown)'}`,
    `changes: ${dirty} file(s)${dirty ? ' — uncommitted' : ' — clean'}`,
    remote ? `remote: ${remote}` : '',
  ].filter(Boolean).join('\n');
}

// Compact statusline info: the branch plus the working-tree diff totals.
// Returns null when not a repo (the caller then renders nothing).
//
// The counts come from `git diff --shortstat` run twice (unstaged + staged) so
// the numbers describe the UNCOMMITTED work — which is what a "+12 -3" badge on
// the status line is for.
export function statuslineInfo(cwd) {
  if (!isRepo(cwd)) return null;
  const branch = currentBranch(cwd);
  const stat = (args) => {
    const r = runGit(['diff', ...args, '--shortstat'], cwd);
    if (!r.ok) return { files: 0, insertions: 0, deletions: 0 };
    // e.g. " 3 files changed, 12 insertions(+), 4 deletions(-)"
    const s = r.stdout.trim();
    const files = /(\d+) files? changed/.exec(s);
    const ins = /(\d+) insertions?\(\+\)/.exec(s);
    const del = /(\d+) deletions?\(-\)/.exec(s);
    return {
      files: files ? Number(files[1]) : 0,
      insertions: ins ? Number(ins[1]) : 0,
      deletions: del ? Number(del[1]) : 0,
    };
  };
  const unstaged = stat([]);
  const staged = stat(['--cached']);
  return {
    branch: branch || '',
    insertions: unstaged.insertions + staged.insertions,
    deletions: unstaged.deletions + staged.deletions,
    changed: unstaged.files + staged.files,
  };
}