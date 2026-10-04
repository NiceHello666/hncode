// Which shell commands are read-only, and which are destructive enough to always
// ask about. Both answers are load-bearing:
//
//   * `isReadOnlyCommand` lets a harmless command (`git status`) run without a
//     prompt in Ask mode — a wrong "yes" runs something the user never approved.
//   * `isDestructiveCommand` is what still asks in YOLO mode — a wrong "no" runs
//     `dd of=/dev/sda` silently.
//
// Both used to be a single regex tested against the WHOLE command string, which
// failed in both directions at once:
//
//   `\bformat\b` matched the WORD, so `npm run format`, `grep -rn format src/`
//   and `dotnet format` all looked destructive — and in YOLO mode those prompt.
//   `>\s*/dev/` matched `/dev/null`, the most common redirect in the language.
//   `\bgit\s+push\b` matched `git push --dry-run`, and `\bgit\s+clean\b` matched
//   `git clean -n`.
//
//   Meanwhile `dd of=/dev/sda`, `find -delete`, `truncate -s 0`, `chmod -R 000 /`,
//   `crontab -r`, `docker system prune -af`, `reg delete` and `taskkill /f` were
//   not in the regex at all, so YOLO ran them without a word.
//
// So this module does what kimi's bash parser does, minus the parser: it SPLITS
// the command into the segments a shell would execute, TOKENIZES each one, peels
// off the wrappers that hide the real program (`sudo`, `env`, `timeout`,
// `sh -c "…"`), and only then asks what the real program is. A rule about `format`
// can therefore mean the COMMAND `format`, not the word appearing in an argument.
//
// It is deliberately not a full shell parser. It knows the constructs that hide a
// destructive command, and errs toward "destructive" (ask) when it cannot tell.
// See test/shell-safety.test.mjs for the behaviours that must hold.

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/**
 * Split a command on the control operators a shell would act on, respecting
 * quotes. Only UNQUOTED operators split: in `grep "a|b" src/` the pipe is data,
 * and treating it as a pipe is what made the old metacharacter test reject a
 * read-only command.
 *
 * Returns { segments, metacharacters, redirects }:
 *   segments       — one entry per command the shell would run
 *   metacharacters — unquoted operator characters seen (for the read-only test)
 *   redirects      — unquoted redirect targets, e.g. ['/dev/null']
 */
export function splitSegments(cmd) {
  const s = String(cmd == null ? '' : cmd);
  const segments = [];
  const metacharacters = new Set();
  const redirects = [];
  let current = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { current += s.slice(i, i + 2); i += 2; continue; }
    if (c === "'" || c === '"') {
      // Consume the whole quoted run verbatim. A quote can also OPEN inside a word
      // (`--msg="a b"`); appending keeps the word together for tokenizeWords.
      const quote = c;
      let j = i + 1;
      current += c;
      while (j < s.length) {
        if (quote === '"' && s[j] === '\\' && j + 1 < s.length) { current += s.slice(j, j + 2); j += 2; continue; }
        current += s[j];
        if (s[j] === quote) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>') {
      metacharacters.add(two[0]);
      if (two === '>>') redirects.push(readRedirect(s, i + 2));
      else { segments.push(current); current = ''; }
      i += 2;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      // All four end a segment. `&` backgrounds it, which still runs it.
      metacharacters.add(c === '\n' ? ';' : c);
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (c === '>') {
      metacharacters.add('>');
      redirects.push(readRedirect(s, i + 1));
      i += 1;
      continue;
    }
    if (c === '<' || c === '`') { metacharacters.add(c); i += 1; continue; }
    if (c === '$') {
      // `$(…)` / `${…}` can run a command or expand a path. Record the substitution
      // so the read-only test rejects the command, but keep the text for tokenizing.
      if (s[i + 1] === '(') metacharacters.add('$');
      current += c; i += 1; continue;
    }
    if (c === '(' || c === ')') { metacharacters.add(c); current += c; i += 1; continue; }
    current += c;
    i += 1;
  }
  segments.push(current);
  return { segments, metacharacters, redirects };
}

// The token after a redirect operator; may be absent (`cmd >`).
function readRedirect(s, from) {
  let i = from;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let out = '';
  while (i < s.length && !/[\s|;&<>]/.test(s[i])) { out += s[i]; i++; }
  return out.replace(/^['"]+|['"]+$/g, '');
}

/**
 * Split one segment into words, dropping the quotes and keeping a word together
 * across quoted whitespace (`--msg="a b"` is ONE word).
 */
export function tokenizeWords(segment) {
  const s = String(segment == null ? '' : segment).trim();
  const words = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (has) { words.push(cur); cur = ''; has = false; } i++; continue; }
    has = true;
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < s.length) {
        if (quote === '"' && s[j] === '\\' && j + 1 < s.length) { cur += s[j + 1]; j += 2; continue; }
        if (s[j] === quote) break;
        cur += s[j]; j++;
      }
      i = j + 1;
      continue;
    }
    cur += c;
    i++;
  }
  if (has) words.push(cur);
  return words;
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

// Programs whose only job is to launch another program. `sudo rm -rf /` and
// `rm -rf /` are the same act, so the wrapper has to come off before the real
// command is judged. The old whole-string regex caught `sudo rm` by accident,
// but could not catch `sh -c "rm -rf /"` at all.
const LAUNCH_WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'builtin', 'nice',
  'ionice', 'setsid', 'stdbuf', 'time', 'timeout', 'chrt', 'taskset', 'unbuffer',
]);

// The subset of wrappers that ESCALATE privileges. They are still peeled for the
// destructive verdict (`sudo rm -rf` is a delete), but they can never count as
// read-only: `sudo cat f` and `sudo cat /etc/shadow` look identical from here.
const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas', 'runas', 'su']);

// Options of a wrapper that TAKE A VALUE, so the value is not mistaken for the
// program being launched.
const WRAPPER_VALUE_OPTIONS = new Set([
  // sudo / doas
  '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
  '-T', '--command-timeout', '-U', '--other-user', '-r', '--role', '-t', '--type',
  // env
  '--unset', '--chdir', '--split-string', '-S',
  // nice / timeout / taskset / ionice / chrt / stdbuf
  '-n', '--adjustment', '-k', '--kill-after', '-s', '--signal', '-p', '--pid',
  '-c', '--cpu-list', '--class', '--classdata', '--io-class', '-o', '--output',
  '--priority', '--scheduling-policy',
]);

// Shells. `sh -c "…"` hands the rest of the line to a NEW shell, so its argument
// is a nested program that needs the same analysis.
const NESTED_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell']);
// The flags that make a shell's next word a command string.
const SHELL_COMMAND_FLAGS = new Set(['-c', '-command', '/c', '-cmd']);

function basename(word) {
  return String(word || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/**
 * Peel launch wrappers off `words`, returning the real program and its arguments.
 * `nested` is a command STRING a wrapper introduced (`sh -c "…"`), which the
 * caller analyzes as a fresh program. `cmd` is '' when the whole segment was a
 * wrapper with nothing to launch.
 */
function unwrap(words) {
  let i = 0;
  // Bounded, so a crafted chain cannot spin this loop.
  for (let guard = 0; guard < 32 && i < words.length; guard++) {
    // `FOO=bar cmd` — a variable assignment prefix, per POSIX.
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (i >= words.length) break;
    const cmd = basename(words[i]);
    const rest = words.slice(i + 1);

    if (CMD_SHELLS.has(cmd)) {
      // `cmd /c …` — the argument after the flag is the command string.
      const flagIdx = rest.findIndex((w) => SHELL_COMMAND_FLAGS.has(w.toLowerCase()));
      if (flagIdx >= 0) return { cmd: '', args: [], nested: rest.slice(flagIdx + 1).join(' ') };
      return { cmd, args: rest, nested: null };
    }
    if (NESTED_SHELLS.has(cmd)) {
      const flagIdx = rest.findIndex((w) => SHELL_COMMAND_FLAGS.has(w.toLowerCase()));
      // `sh -c "rm -rf /"` -> the string is the program.
      if (flagIdx >= 0) return { cmd: '', args: [], nested: rest.slice(flagIdx + 1).join(' ') };
      // `bash script.sh` runs that file; the command is the shell itself.
      return { cmd, args: rest, nested: null };
    }
    if (LAUNCH_WRAPPERS.has(cmd)) {
      let j = i + 1;
      while (j < words.length && words[j].startsWith('-')) {
        const key = words[j].split('=')[0];
        const inlineValue = words[j].includes('=');
        j += (!inlineValue && WRAPPER_VALUE_OPTIONS.has(key)) ? 2 : 1;
      }
      // `timeout 5 rm -rf /` — the duration is a positional operand of the wrapper.
      while (j < words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[j])) j++;
      if (j >= words.length) break;
      i = j;
      continue;
    }
    return { cmd, args: rest, nested: null };
  }
  return { cmd: '', args: [], nested: null };
}

// ---------------------------------------------------------------------------
// Destructive shapes
// ---------------------------------------------------------------------------

// Shells that take a command string with /c rather than -c.
const CMD_SHELLS = new Set(['cmd']);

// A program that is destructive whatever it is pointed at. `mkfs.ext4` and the
// Windows `format` are matched by stem below.
const ALWAYS_DESTRUCTIVE = new Set([
  'shutdown', 'reboot', 'halt', 'poweroff', 'diskpart', 'bcdedit',
  'wipefs', 'shred', 'fdisk', 'cfdisk', 'sgdisk', 'mkswap',
  'restart-computer', 'stop-computer',
]);

// Interpreters that run their argument as code. `python -c "shutil.rmtree(…)"`
// is a delete no command-name rule can see, so it is judged by the text.
const CODE_INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'nodejs', 'perl', 'ruby', 'php', 'lua']);
const CODE_DESTRUCTIVE_RE = /\b(rmtree|unlink|rmdir|remove_tree|shutil\.rm|fs\.rm|rmSync|unlinkSync|rmdirSync|rmRemove|FileUtils\.rm|system\s*\(\s*['"]rm)|subprocess\.(run|call|Popen)[^;]{0,40}\brm\b/i;

// Patterns judged against the WHOLE command text, because no single program owns
// them: a redirect into a block device, a recursive chmod to no permissions, a
// fork bomb. Kept narrow on purpose — broad patterns here are what produced the
// false positives described at the top of this file.
const TEXT_DESTRUCTIVE_RE = [
  /:\(\)\s*\{[^}]*\};\s*:/,                                  // fork bomb
  />\s*\/dev\/(sd|nvme|disk|hd|vd|fd|mmcblk)/,                // redirect to a block device
  /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|disk|hd|vd|mmcblk)/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\b(bcdedit|vssadmin)\b[^|;&]*\b(delete|revert)\b/,
  /(^|[|;&]\s*)chmod\b[^|;&]*-[rR][^|;&]*\b0{3,4}\b/,
  /(^|[|;&]\s*)chown\b[^|;&]*-[rR]\s+\S+\s+\/(\s|$)/,
];

// `rm -rf`, `rm -r -f`, `rm --recursive`: recursion deletes a tree in one go, and
// `-f` stops asking about each file. Either flag alone is enough to be worth a
// prompt — this keeps the guarantee the old regex had (it matched `-r` and `-f`
// alike, since `\w*[rf]` allowed an empty `\w*`) while dropping its habit of
// matching those letters anywhere in the line.
function rmIsDestructive(args) {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (!a.startsWith('-') || a === '-') continue;       // a path, not a flag
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (a === '--recursive') recursive = true;
      if (a === '--force') force = true;
      continue;
    }
    const letters = a.slice(1);                          // combined shorts: -rf
    if (/[rR]/.test(letters)) recursive = true;
    if (/f/.test(letters)) force = true;
  }
  return recursive || force;
}
/** `mkfs`, `mkfs.ext4`, `mkfs.xfs` — the whole family. */
function isMkfs(cmd) { return cmd === 'mkfs' || cmd.startsWith('mkfs.'); }

// Judge ONE already-unwrapped command. Returns a reason string, or null when the
// command is not destructive.
function judgeUnwrapped(cmd, args) {
  if (!cmd) return null;
  if (ALWAYS_DESTRUCTIVE.has(cmd)) return `${cmd} is a system-level destructive command`;
  if (isMkfs(cmd)) return 'mkfs formats a filesystem';
  if (cmd === 'format') return 'format is the Windows disk-format command';

  switch (cmd) {
    case 'rm': case 'rmdir':
      if (rmIsDestructive(args)) return 'a recursive or forced delete';
      break;
    case 'del': case 'erase':
      // A delete whatever its flags, which is what the old `\bdel\b` matched.
      // Narrowed to the command NAME, so a path containing "del" no longer trips it.
      return 'the Windows delete command';
    case 'remove-item': {
      const joined = args.join(' ').toLowerCase();
      if (/-recurse\b|\s-r\b/.test(joined)) return 'Remove-Item -Recurse';
      break;
    }
    case 'find': case 'fd': case 'gfind':
      if (args.includes('-delete')) return 'find -delete';
      for (const flag of ['-exec', '-execdir', '-ok', '-okdir']) {
        const i = args.indexOf(flag);
        if (i >= 0 && args[i + 1] && /^(rm|shred|del)$/i.test(basename(args[i + 1]))) return `find ${flag} rm`;
      }
      break;
    case 'xargs':
      if (args.some((a) => /^(rm|shred|del)$/i.test(basename(a)))) return 'xargs running a delete';
      break;
    case 'truncate': {
      const i = args.findIndex((a) => a === '-s' || a === '--size');
      if (i >= 0 && args[i + 1] === '0') return 'truncate to zero length';
      break;
    }
    case 'crontab':
      if (args.some((a) => a === '-r' || a === '--remove')) return 'crontab -r removes every scheduled job';
      break;
    case 'taskkill':
      if (args.some((a) => /^\/f$/i.test(a))) return 'taskkill /f';
      break;
    case 'reg': case 'reg.exe': {
      const sub = (args.find((a) => !a.startsWith('-') && !a.startsWith('/')) || '').toLowerCase();
      if (sub === 'delete') return 'reg delete';
      break;
    }
    case 'sc': case 'sc.exe': {
      const sub = (args.find((a) => !a.startsWith('-')) || '').toLowerCase();
      if (sub === 'delete') return 'sc delete';
      break;
    }
    case 'docker':
      if (args.includes('prune')) return 'docker prune';
      break;
    case 'git': {
      const sub = (args.find((a) => !a.startsWith('-')) || '').toLowerCase();
      // A dry run changes nothing, and flagging it is what made `git push
      // --dry-run` prompt in YOLO mode.
      if (args.some((a) => a === '-n' || a === '--dry-run')) break;
      if (sub === 'push') return 'git push';
      if (sub === 'reset' && args.includes('--hard')) return 'git reset --hard';
      if (sub === 'clean') return 'git clean removes untracked files';
      if (sub === 'branch' && args.includes('-D')) return 'git branch -D';
      break;
    }
    case 'npm': case 'yarn': case 'pnpm':
      if (args.includes('publish') && !args.includes('--dry-run')) return 'publishing a package';
      break;
    case 'sh': case 'bash': case 'dash': case 'zsh': case 'ksh': case 'ash':
    case 'pwsh': case 'powershell': case 'cmd':
      // Only reachable as `sh script.sh` (the `-c` form is unwrapped into a nested
      // command). Nothing to judge without reading the script.
      break;
  }

  if (CODE_INTERPRETERS.has(cmd)) {
    const code = args.filter((a) => !a.startsWith('-')).join(' ');
    if (CODE_DESTRUCTIVE_RE.test(code)) return `${cmd} running a delete`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_NESTED_DEPTH = 4;

/**
 * Is this command destructive enough that it must never auto-run? Reaching this
 * means the user is asked, even in YOLO mode.
 */
export function isDestructiveCommand(cmd, depth = 0) {
  const text = String(cmd == null ? '' : cmd);
  if (!text.trim()) return false;
  if (depth >= MAX_NESTED_DEPTH) return true;   // too deep to judge: ask
  for (const re of TEXT_DESTRUCTIVE_RE) if (re.test(text)) return true;
  const { segments } = splitSegments(text);
  for (const seg of segments) {
    const words = tokenizeWords(seg);
    if (!words.length) continue;
    const u = unwrap(words);
    if (judgeUnwrapped(u.cmd, u.args)) return true;
    // `sh -c "…"` / `cmd /c …`: the wrapper's own command string is a program.
    if (u.nested && isDestructiveCommand(u.nested, depth + 1)) return true;
  }
  return false;
}

// A read-only command's every segment is a known query/inspection tool. Anything
// that MUTATES is not on the list, and anything chained, redirected or substituted
// is rejected outright — a wrapper could hide a write.
const READ_ONLY_BINS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'echo', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq',
  'grep', 'rg', 'ag', 'find', 'fd', 'which', 'where', 'whoami', 'hostname',
  'date', 'env', 'printenv', 'stat', 'file', 'du', 'df', 'tree', 'type',
  'jq', 'tr', 'cut', 'diff', 'man', 'help', 'true', 'test',
  'git',   // further restricted to read-only verbs below
  // NOT here on purpose: node/python/npm/npx/make/docker/kubectl/gh — each can
  // execute arbitrary code or mutate state via a flag (`node -e`, `python -c`,
  // `npm install`), so allowing the bare binary would be a hole.
]);

// `git` verbs that do not write. Anything else is refused.
const GIT_READ_SUBCMDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'describe', 'blame',
  'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'shortlog', 'tag', 'config',
  'reflog', 'whatchanged', 'name-rev', 'grep', 'count-objects', 'symbolic-ref',
  'show-ref', 'for-each-ref', 'worktree',
]);
// Flags that turn a nominally read-only verb into a write (`git branch -D`,
// `git tag -d`, `git remote add`, `git config --set`).
const GIT_WRITE_FLAGS = new Set([
  '-d', '-D', '-m', '-M', '--set', '--unset', '--add', '--edit', '--delete',
  '--amend', '--force', '-f', '--global', '--local', '--system', 'add', 'remove',
]);

/** Is this command read-only, i.e. safe to run without a prompt in Ask mode? */
export function isReadOnlyCommand(cmd) {
  const text = String(cmd == null ? '' : cmd).trim();
  if (!text) return false;
  const { segments, metacharacters, redirects } = splitSegments(text);
  // Any unquoted operator, substitution or redirect means the effect is not
  // confined to what the first word suggests.
  if (metacharacters.size) return false;
  if (redirects.length) return false;
  const words = [];
  for (const seg of segments) words.push(...tokenizeWords(seg));
  if (!words.length) return false;
  // Privilege escalation is never "read-only": `sudo cat` reads one file and can
  // also read every file, so it asks. Checked on the RAW first word, because
  // peeling the wrapper would turn `sudo ls` into a plain `ls`.
  if (PRIVILEGE_WRAPPERS.has(basename(words[0]))) return false;
  const u = unwrap(words);
  if (!u.cmd) return false;                   // a bare `sh -c "…"` is not provable
  if (!READ_ONLY_BINS.has(u.cmd)) return false;
  if (u.cmd === 'git') {
    const sub = (u.args.find((a) => !a.startsWith('-')) || '').toLowerCase();
    if (!sub || !GIT_READ_SUBCMDS.has(sub)) return false;
    // `tag`/`branch`/`remote`/`config`/`worktree` are read-only only WITHOUT a
    // writing flag, so any of those flags refuses the whole command.
    if (u.args.some((a) => GIT_WRITE_FLAGS.has(a))) return false;
  }
  if (u.cmd === 'find' || u.cmd === 'fd') {
    for (const f of ['-delete', '-exec', '-execdir', '-ok', '-okdir']) {
      if (u.args.includes(f)) return false;
    }
  }
  // A bare `env`/`printenv` prints the environment, but `env rm -rf /` launches a
  // program — the wrapper peel above turns that into `rm`, which is not in the list.
  return true;
}

export default { isDestructiveCommand, isReadOnlyCommand, splitSegments, tokenizeWords };
