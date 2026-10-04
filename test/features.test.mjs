// Tests for the three self-contained additions: output styles, feature flags and
// session approvals, plus the rule self-test.
//
// Why these are tested apart from the TUI: each is a small decision procedure with
// a failure mode that is SILENT in the running app. A style whose body fails to
// parse simply stops applying; an experiment nobody reads is a no-op that looks
// enabled; an approval key that is too broad turns "approve npm test" into
// "approve every npm command". None of those raise an error anywhere.
//
// Testing principle: parse/decide functions are pure, so they are driven directly
// with real file contents (written to a temp dir) rather than with stubs — the file
// reading IS the feature for styles.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseStyle, nameFromFile, listStyles, findStyle, styleReminder, writeStyleTemplate, styleDirs,
} from '../src/output-styles.js';
import {
  EXPERIMENTS, experimentState, enabledExperiments, mergeExperiments, pruneUnknown, describeExperiments, isExperiment,
} from '../src/experiments.js';
import {
  approvalKey, isApprovedForSession, rememberApproval, forgetApproval, describeSessionApprovals,
} from '../src/session-approvals.js';
import { parseRuleLine, selfTestRules, exampleArgs, decideFromRules } from '../src/permissions.js';

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-feat-'));
  fs.mkdirSync(path.join(dir, '.hncode'), { recursive: true });
  return dir;
}
function writeStyle(dir, file, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body, 'utf8');
}

// ---------------------------------------------------------------------------
// Output styles
// ---------------------------------------------------------------------------

test('a style file name becomes its name when there is no frontmatter', () => {
  assert.equal(nameFromFile('terse-reviewer.md'), 'Terse Reviewer');
  assert.equal(nameFromFile('/a/b/short.md'), 'Short');
  const s = parseStyle('Be brief.\n', 'terse-reviewer.md');
  assert.equal(s.name, 'Terse Reviewer');
  assert.equal(s.body, 'Be brief.');
});

test('frontmatter supplies name and description, and the body keeps its own ---', () => {
  // A `---` INSIDE the body is a Markdown rule, not a fence: reading the second one
  // as a closing fence would swallow the instructions below it.
  const raw = [
    '---',
    'name: Terse',
    'description: no praise',
    '---',
    'Be brief.',
    '',
    '---',
    '',
    'Still my instructions.',
  ].join('\n');
  const s = parseStyle(raw, 'x.md');
  assert.equal(s.name, 'Terse');
  assert.equal(s.description, 'no praise');
  assert.match(s.body, /Be brief\./);
  assert.match(s.body, /Still my instructions\./);
});

test('a quoted metadata value keeps its colon', () => {
  const s = parseStyle('---\ndescription: "tone: flat"\n---\nBody', 'x.md');
  assert.equal(s.description, 'tone: flat');
});

test('listing reads the directory, skips bodyless files, and project overrides personal', () => {
  const home = tmpHome();
  const styles = path.join(home, '.hncode', 'output-styles');
  const project = path.join(home, 'repo', '.hncode', 'output-styles');
  writeStyle(styles, 'a.md', 'body A');
  writeStyle(styles, 'empty.md', '---\nname: Empty\n---\n');
  writeStyle(project, 'a.md', 'body A project');

  const all = listStyles(path.join(home, 'repo'), path.join(home, '.hncode'));
  const a = all.find((s) => s.name.toLowerCase() === 'a');
  assert.ok(a, 'the style is listed');
  assert.equal(a.body, 'body A project', 'the project copy wins');
  assert.ok(!all.some((s) => /empty/i.test(s.name)), 'a style with no body is not selectable');
});

test('finding a style is case-insensitive and accepts a prefix', () => {
  const home = tmpHome();
  writeStyle(path.join(home, '.hncode', 'output-styles'), 'terse-reviewer.md', 'be brief');
  const cwd = path.join(home, 'w');
  assert.ok(findStyle('terse-reviewer', cwd, path.join(home, '.hncode')));
  assert.ok(findStyle('TERSE-REVIEWER', cwd, path.join(home, '.hncode')));
  assert.ok(findStyle('terse', cwd, path.join(home, '.hncode')), 'a prefix matches');
  assert.equal(findStyle('nothing-here', cwd, path.join(home, '.hncode')), null);
});

test('the reminder says the style overrides earlier formatting rules', () => {
  const text = styleReminder({ name: 'Terse', body: 'Be brief.' });
  // The precedence claim is the load-bearing part: a system prompt already carries
  // formatting rules, and this has to be read as the later instruction.
  assert.match(text, /takes precedence/);
  assert.match(text, /Be brief\./);
  assert.match(text, /^<system-reminder>/);
  assert.match(text, /<\/system-reminder>$/);
  assert.equal(styleReminder({ name: 'x', body: '' }), '', 'an empty body injects nothing');
});

test('the template is created once and is a valid, selectable style', () => {
  const home = tmpHome();
  const dir = styleDirs(path.join(home, 'w'), path.join(home, '.hncode'))[0];
  const first = writeStyleTemplate(dir, 'My Style');
  assert.equal(first.created, true);
  const second = writeStyleTemplate(dir, 'My Style');
  assert.equal(second.created, false, 'an existing file is never overwritten');
  const s = parseStyle(fs.readFileSync(first.file, 'utf8'), path.basename(first.file));
  assert.ok(s.body.length > 0, 'the template has a body, so it is immediately usable');
  assert.equal(s.name, 'My Style');
});

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

test('every flag is OFF by default unless it says otherwise', () => {
  const st = experimentState({});
  for (const [name, spec] of Object.entries(EXPERIMENTS)) {
    assert.equal(st[name], !!spec.default, `${name} default`);
  }
});

test('the environment enables a flag and config overrides it', () => {
  const name = Object.keys(EXPERIMENTS)[0];
  const fromEnv = experimentState({}, { HNCODE_EXPERIMENTS: name });
  assert.equal(fromEnv[name], true);
  // Config wins: it is the thing the user edited deliberately.
  const fromCfg = experimentState({ raw: { experiments: { [name]: false } } }, { HNCODE_EXPERIMENTS: name });
  assert.equal(fromCfg[name], false);
});

test('an unknown name in the env is ignored, not invented', () => {
  const st = experimentState({}, { HNCODE_EXPERIMENTS: 'no-such-flag' });
  assert.equal(st['no-such-flag'], undefined);
  assert.equal(isExperiment('no-such-flag'), false);
});

test('merging keeps an explicit false and drops unknown names', () => {
  const name = Object.keys(EXPERIMENTS)[0];
  const merged = mergeExperiments({}, { [name]: false, bogus: true });
  assert.deepEqual(merged, { [name]: false });
  // Turning it off must be REMEMBERED, or the default would come back.
  assert.equal(experimentState({ raw: { experiments: merged } })[name], false);
});

test('pruning reports the names it drops, so a stale config is visible', () => {
  const name = Object.keys(EXPERIMENTS)[0];
  const { kept, dropped } = pruneUnknown({ [name]: true, removed_flag: true });
  assert.deepEqual(Object.keys(kept), [name]);
  assert.deepEqual(dropped, ['removed_flag']);
});

test('every declared flag is referenced somewhere in src/', () => {
  // A flag no code reads is a bug that looks like a feature: /experiments lists it,
  // turning it on does nothing, and the user has no way to tell. This assertion is
  // what keeps the registry honest.
  const root = path.join(import.meta.dirname, '..', 'src');
  const files = [];
  for (const d of ['', 'tools']) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (f.endsWith('.js')) files.push(path.join(root, d, f));
    }
  }
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const unreferenced = Object.keys(EXPERIMENTS).filter((n) => !text.includes(n));
  assert.deepEqual(unreferenced, [], 'a flag no code reads is not an experiment');
});

test('describeExperiments reports state, not just the registry', () => {
  const name = Object.keys(EXPERIMENTS)[0];
  const rows = describeExperiments({ [name]: true });
  const row = rows.find((r) => r.name === name);
  assert.equal(row.on, true);
  assert.ok(row.desc.length > 0, 'every flag explains itself');
});

// ---------------------------------------------------------------------------
// Session approvals
// ---------------------------------------------------------------------------

test('an approval key is the program plus its subcommand, not the whole line', () => {
  assert.equal(approvalKey('Bash', { command: 'npm test --watch' }), 'Bash:npm test');
  assert.equal(approvalKey('Bash', { command: 'npm test src/a.ts' }), 'Bash:npm test');
  assert.equal(approvalKey('Bash', { command: 'npm run test' }), 'Bash:npm run');
  // A leading assignment is not the program.
  assert.equal(approvalKey('Bash', { command: 'FOO=1 npm test x' }), 'Bash:npm test');
  // A non-Bash tool is keyed by the tool alone: the per-call path guard still runs.
  assert.equal(approvalKey('Write', { path: 'a.txt' }), 'Write');
  assert.equal(approvalKey('Read', { file_path: 'b.ts' }), 'Read');
});

test('an approval covers the same program with different arguments only', () => {
  const list = rememberApproval([], 'Bash', { command: 'npm test --watch' });
  assert.equal(isApprovedForSession(list, 'Bash', { command: 'npm test --coverage' }), true);
  assert.equal(isApprovedForSession(list, 'Bash', { command: 'npm publish' }), false);
  assert.equal(isApprovedForSession(list, 'Write', { path: 'x' }), false);
});

test('a destructive command is never covered by an approval', () => {
  // The one place this module refuses to be literal: Ctrl+A on `rm -rf build`
  // must not pre-approve the next `rm -rf /`.
  const list = rememberApproval([], 'Bash', { command: 'rm -rf build' });
  assert.equal(isApprovedForSession(list, 'Bash', { command: 'rm -rf build' }, true), false);
});

test('remembering is idempotent and forgetting removes one key', () => {
  let list = rememberApproval([], 'Bash', { command: 'npm test' });
  list = rememberApproval(list, 'Bash', { command: 'npm test' });
  assert.deepEqual(list, ['Bash:npm test']);
  assert.deepEqual(forgetApproval(list, 'Bash:npm test'), []);
});

test('the panel text says the grants are session-scoped', () => {
  assert.match(describeSessionApprovals([]), /session/i);
  const text = describeSessionApprovals(['Bash:npm test']);
  assert.match(text, /Bash:npm test/);
  assert.match(text, /session ends/i, 'the lifetime must be stated, not implied');
});

// ---------------------------------------------------------------------------
// Rule self-test
// ---------------------------------------------------------------------------

test('a rule line carries its own match / not_match examples', () => {
  const p = parseRuleLine('Bash(npm run test *)   # match: npm run test foo | not_match: npm run tests');
  assert.equal(p.rule, 'Bash(npm run test *)');
  assert.deepEqual(p.match, ['npm run test foo']);
  assert.deepEqual(p.not_match, ['npm run tests']);
  // A hyphen and the plural marker are both accepted, since this is a TOML comment.
  assert.deepEqual(parseRuleLine('x  # not-match: a').not_match, ['a']);
  assert.deepEqual(parseRuleLine('x').match, [], 'a rule without examples is still a rule');
});

test('the self-test catches a rule that does not do what it claims', () => {
  // `Bash(git push *)` matching a bare `git push` is the exact trap: the trailing
  // `*` form allows prefix-only, so the not_match example fails. This is the bug the
  // feature exists to surface.
  const r = selfTestRules({
    allow: [
      'Bash(git push *)   # not_match: git push',
      'Bash(npm test *)    # match: npm test a | not_match: npm testx',
    ],
  });
  assert.equal(r.checks.length, 3);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].kind, 'not_match');
});

test('a rule with no examples produces no checks, so an old config is not flagged', () => {
  const r = selfTestRules({ allow: ['Bash(npm test)', 'Read(./src/**)'] });
  assert.deepEqual(r.checks, []);
  assert.deepEqual(r.failed, []);
});

test('an example is turned into the argument the tool would receive', () => {
  assert.deepEqual(exampleArgs('Bash', 'npm test'), { command: 'npm test' });
  // A path tool matches on any of its path-ish arguments, so all are supplied.
  const a = exampleArgs('Read', './src/a.ts');
  assert.equal(a.path, './src/a.ts');
  assert.equal(a.file_path, './src/a.ts');
});

test('the self-test agrees with the real decision path', () => {
  // The examples must be checked with the SAME matcher the approval flow uses;
  // a second implementation would let a rule pass the test and fail in practice.
  const rules = { allow: ['Bash(npm test)   # match: npm test'] };
  assert.equal(selfTestRules(rules).failed.length, 0);
  assert.equal(decideFromRules(rules, 'Bash', { command: 'npm test' }), 'allow');
});
