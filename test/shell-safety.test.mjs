// Tests for the shell command classifier.
//
// Why this file exists: `isDestructiveCommand` is the only thing that still asks
// before a command runs in YOLO mode, and `isReadOnlyCommand` is what lets a
// command run WITHOUT asking in Ask mode. Both used to be one regex over the whole
// command string, and it was wrong in both directions at once — it prompted for
// `npm run format` and `2>/dev/null`, and waved through `dd of=/dev/sda`,
// `crontab -r` and `docker system prune -af`.
//
// Testing principle: the useful cases are the ENCODINGS of one act. The same
// `rm -rf` reaches the shell as `sudo rm -rf`, `sh -c "rm -rf"`, `timeout 5 rm
// -rf`, `find -exec rm`, `xargs rm`, and inside a `&&` chain. Every one of them
// must be caught, because a rule that only knows the bare spelling is a rule a
// model can step around by accident. Conversely the near-misses — the WORD
// `format` in an argument, the redirect to `/dev/null`, a `--dry-run` — must NOT
// be caught, because each false positive is a prompt the user has already said
// yes to.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDestructiveCommand, isReadOnlyCommand, splitSegments, tokenizeWords,
} from '../src/shell-safety.js';

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

test('splitSegments splits on unquoted control operators only', () => {
  assert.deepEqual(splitSegments('a && b').segments, ['a ', ' b']);
  assert.deepEqual(splitSegments('a || b').segments, ['a ', ' b']);
  assert.deepEqual(splitSegments('a ; b').segments, ['a ', ' b']);
  assert.deepEqual(splitSegments('a | b').segments, ['a ', ' b']);
  // A pipe inside quotes is DATA, not an operator — the old metacharacter test
  // rejected the whole command, which is why a quoted pattern never auto-ran.
  const q = splitSegments('grep "a|b" src/');
  assert.deepEqual(q.segments, ['grep "a|b" src/']);
  assert.equal(q.metacharacters.size, 0);
});

test('splitSegments records redirects without leaving them in the segment', () => {
  const r = splitSegments('echo hi > /tmp/out');
  assert.deepEqual(r.redirects, ['/tmp/out']);
  // `>` is still a metacharacter, which is what refuses the read-only fast path.
  assert.ok(r.metacharacters.has('>'));
});

test('tokenizeWords keeps a quoted run together and drops the quotes', () => {
  assert.deepEqual(tokenizeWords('git commit -m "two words"'), ['git', 'commit', '-m', 'two words']);
  assert.deepEqual(tokenizeWords("a 'b c' d"), ['a', 'b c', 'd']);
  assert.deepEqual(tokenizeWords('  spaced   out  '), ['spaced', 'out']);
  assert.deepEqual(tokenizeWords(''), []);
});

// ---------------------------------------------------------------------------
// Destructive: the same act, in every spelling
// ---------------------------------------------------------------------------

test('a recursive or forced delete is caught in every wrapper', () => {
  // The baseline and each way of hiding it.
  for (const cmd of [
    'rm -rf /build',
    'sudo rm -rf /build',
    'doas rm -rf /build',
    'env rm -rf /build',
    'sudo -u root rm -rf /build',
    'command rm -rf /build',
    'nohup rm -rf /tmp/x',
    'timeout 5 rm -rf /build',
    'nice -n 10 rm -rf /build',
    'time rm -rf /build',
    'FOO=bar rm -rf /build',
    'sh -c "rm -rf /build"',
    'bash -c "rm -rf ~"',
    'dash -c "rm -rf /"',
    'sh -c "sudo rm -rf /build"',
    'cmd /c "rm -rf /build"',
    'echo hi && rm -rf /build',
    'echo hi; rm -rf /build',
    'true || rm -rf /build',
    'find . -exec rm -rf {} +',
    'find . -delete',
    'xargs rm -rf',
  ]) {
    assert.equal(isDestructiveCommand(cmd), true, `must be destructive: ${cmd}`);
  }
});

test('rm flags: -r and -f each count, and long forms too', () => {
  assert.equal(isDestructiveCommand('rm -r dir'), true);
  assert.equal(isDestructiveCommand('rm -f file'), true);
  assert.equal(isDestructiveCommand('rm -fr dir'), true);
  assert.equal(isDestructiveCommand('rm --recursive dir'), true);
  assert.equal(isDestructiveCommand('rm --force file'), true);
  // A flag-looking path is not a flag.
  assert.equal(isDestructiveCommand('rm -- --weird-name'), false);
  // No flags at all: an ordinary single-file delete, which the workspace check
  // still has to approve.
  assert.equal(isDestructiveCommand('rm build/out.js'), false);
});

test('disk and system level commands are destructive', () => {
  for (const cmd of [
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'dd if=x of=/dev/nvme0n1',
    'mkfs.ext4 /dev/sdb',
    'mkfs /dev/sdb',
    'shutdown /s',
    'reboot',
    'halt',
    'poweroff',
    'diskpart',
    'wipefs -a /dev/sdb',
    'shred -u secret.key',
    'fdisk /dev/sdb',
    'truncate -s 0 src/index.js',
    'truncate --size 0 log.txt',
    'crontab -r',
    'taskkill /f /im node.exe',
    'vssadmin delete shadows /all',
    'reg delete HKLM\\Software\\Foo /f',
    'sc delete MyService',
    'docker system prune -af',
    'echo x > /dev/sda',
    ':(){ :|:& };:',
    'chmod -R 000 /',
    'chown -R nobody /',
    'format D:',
  ]) {
    assert.equal(isDestructiveCommand(cmd), true, `must be destructive: ${cmd}`);
  }
});

test('a delete hidden inside an interpreter still counts', () => {
  assert.equal(isDestructiveCommand('python -c "import shutil; shutil.rmtree(\'x\')"'), true);
  assert.equal(isDestructiveCommand('node -e "require(\'fs\').rmSync(\'x\', {recursive:true})"'), true);
  assert.equal(isDestructiveCommand('python -c "print(1)"'), false);
});

test('git: the writing verbs are destructive, and a dry run never is', () => {
  assert.equal(isDestructiveCommand('git push'), true);
  assert.equal(isDestructiveCommand('git push origin main'), true);
  assert.equal(isDestructiveCommand('git reset --hard HEAD~3'), true);
  assert.equal(isDestructiveCommand('git clean -fdx'), true);
  assert.equal(isDestructiveCommand('git branch -D feature'), true);
  // The false positives that made YOLO unusable for routine git work.
  assert.equal(isDestructiveCommand('git push --dry-run'), false);
  assert.equal(isDestructiveCommand('git clean -n'), false);
  assert.equal(isDestructiveCommand('git status'), false);
  assert.equal(isDestructiveCommand('git log --oneline -5'), false);
});

// ---------------------------------------------------------------------------
// Destructive: the near-misses that must stay quiet
// ---------------------------------------------------------------------------

test('the WORD format is not the format command', () => {
  // The old regex had `\bformat\b`, so every one of these prompted in YOLO mode.
  for (const cmd of [
    'npm run format',
    'npx prettier --write .',
    'gofmt -w .',
    'cargo fmt',
    'grep -rn format src/',
    'rg "format" src/',
    'dotnet format',
    'python -m black src/',
    'echo "use the format command"',
  ]) {
    assert.equal(isDestructiveCommand(cmd), false, `must NOT be destructive: ${cmd}`);
  }
  // But the real thing still is.
  assert.equal(isDestructiveCommand('format D:'), true);
});

test('redirecting to /dev/null is not a device wipe', () => {
  // The old regex was `>\s*/dev/`, which matched the commonest redirect there is.
  assert.equal(isDestructiveCommand('npm test 2>/dev/null'), false);
  assert.equal(isDestructiveCommand('ls -la > /dev/null'), false);
  assert.equal(isDestructiveCommand('node build.js > /dev/null'), false);
  assert.equal(isDestructiveCommand('cat f > /dev/stderr'), false);
  // A block device still is.
  assert.equal(isDestructiveCommand('dd if=/dev/zero of=/dev/sda'), true);
  assert.equal(isDestructiveCommand('echo x > /dev/sda'), true);
});

test('everyday commands are not destructive', () => {
  for (const cmd of [
    'npm test', 'npm run build', 'npm install', 'npx tsc --noEmit',
    'git commit -m "fix"', 'git add -A', 'git diff', 'git stash',
    'ls -la', 'cat package.json', 'rg TODO src/', 'node --version',
    'docker build -t x .', 'docker ps', 'make test', 'cargo test',
    'mv a.txt b.txt', 'mkdir -p src/new', 'sed -i s/a/b/ f.txt',
  ]) {
    assert.equal(isDestructiveCommand(cmd), false, `must NOT be destructive: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

test('a query command is read-only, a mutating one is not', () => {
  for (const cmd of ['ls -la', 'cat README.md', 'rg TODO src/', 'git status', 'git log', 'git diff HEAD~1', 'pwd', 'wc -l f.ts', 'jq . x.json']) {
    assert.equal(isReadOnlyCommand(cmd), true, `must be read-only: ${cmd}`);
  }
  for (const cmd of ['rm -rf dist', 'mv a b', 'npm install', 'git commit -m x', 'git push', 'node -e "1"', 'python -c "1"', 'sed -i s/a/b/ f', 'mkdir x']) {
    assert.equal(isReadOnlyCommand(cmd), false, `must NOT be read-only: ${cmd}`);
  }
});

test('chaining, piping, substitution or redirection refuses the read-only path', () => {
  // Every one of these could hide a write behind a harmless first word.
  for (const cmd of [
    'ls && rm -rf dist',
    'ls; rm -rf dist',
    'ls | xargs rm',
    'cat $(rm -rf x)',
    'echo hi > out.txt',
    'ls `pwd`',
    'ls & rm -rf x',
  ]) {
    assert.equal(isReadOnlyCommand(cmd), false, `must NOT be read-only: ${cmd}`);
  }
});

test('a quoted pipe or redirect is data, so the command stays read-only', () => {
  // The old metacharacter scan rejected these, so they always prompted.
  assert.equal(isReadOnlyCommand('grep "a|b" src/'), true);
  assert.equal(isReadOnlyCommand('rg "x > y" src/'), true);
});

test('git is read-only only for its reading verbs, and only without a writing flag', () => {
  for (const cmd of ['git status', 'git log --oneline', 'git diff', 'git show HEAD', 'git rev-parse HEAD', 'git ls-files']) {
    assert.equal(isReadOnlyCommand(cmd), true, `must be read-only: ${cmd}`);
  }
  // `branch`/`tag`/`remote`/`config` read by default but write with a flag, so the
  // flag has to refuse them.
  assert.equal(isReadOnlyCommand('git branch'), true);
  assert.equal(isReadOnlyCommand('git branch -D feature'), false);
  assert.equal(isReadOnlyCommand('git branch -d feature'), false);
  assert.equal(isReadOnlyCommand('git tag'), true);
  assert.equal(isReadOnlyCommand('git remote -v'), true);
  assert.equal(isReadOnlyCommand('git remote add origin url'), false);
  assert.equal(isReadOnlyCommand('git remote add origin url'), false);
  assert.equal(isReadOnlyCommand('git config user.email'), true);
  assert.equal(isReadOnlyCommand('git config --global user.email x'), false);
});

test('find is read-only only without an exec or delete', () => {
  assert.equal(isReadOnlyCommand('find . -name "*.ts"'), true);
  assert.equal(isReadOnlyCommand('find . -delete'), false);
  assert.equal(isReadOnlyCommand('find . -exec rm {} +'), false);
});

test('a wrapper is peeled before the read-only verdict, so it cannot hide a program', () => {
  // `env ls` and `timeout 5 ls` are still reads, and the peel sees through them.
  assert.equal(isReadOnlyCommand('env ls'), true);
  assert.equal(isReadOnlyCommand('timeout 5 ls'), true);
  assert.equal(isReadOnlyCommand('nice -n 10 ls'), true);
  // Privilege escalation is never read-only, however harmless the program looks:
  // `sudo cat f` and `sudo cat /etc/shadow` are indistinguishable here.
  assert.equal(isReadOnlyCommand('sudo ls'), false);
  assert.equal(isReadOnlyCommand('doas ls'), false);
  assert.equal(isReadOnlyCommand('sudo -u root cat f'), false);
  // A wrapper around a delete is still a delete.
  assert.equal(isReadOnlyCommand('env rm -rf x'), false);
  assert.equal(isReadOnlyCommand('rm -rf x'), false);
  // A bare `sh -c "…"` cannot be proven read-only.
  assert.equal(isReadOnlyCommand('sh -c "ls"'), false);
});

test('isDestructiveCommand errs toward asking when a nested command is too deep to judge', () => {
  // Four levels of `sh -c` nesting is the limit; beyond it the answer must be
  // "ask", not "safe".
  const deep = 'sh -c "sh -c \\"sh -c \\\\\\"sh -c \\\\\\\\\\\\\\"rm -rf /\\\\\\\\\\\\\\"\\\\\\"\\""';
  assert.equal(isDestructiveCommand(deep), true);
});
