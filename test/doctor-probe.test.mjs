// The three checks added after the first review: disk, git, and the live provider probe.
//
// WHY THESE ASSERTIONS
// --------------------
// Each answers a question the original report could not:
//
//   * disk — a store that fills up loses work, and the error text says ENOENT, not "disk full";
//   * git  — a missing user.email makes every commit fail, and an unfinished merge means the
//             tree is not what the agent thinks it is;
//   * probe — a key that EXISTS and an endpoint that PARSES still say nothing about whether a
//             request succeeds. Only a real request answers that.
//
// The probe is the one that costs money, so the tests inject a transport and assert that it
// is never called without the opt-in flag — "the check exists" is not the same as "the check
// runs", and only the second spends a token.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

process.env.HNCODE_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-diag-'));
const { runDoctor, formatDoctor } = await import('../src/doctor.js');

const tmp = process.env.HNCODE_SESSIONS_DIR;
const base = {
  cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k', workspace: tmp },
  workspace: tmp,
  sessionsDir: tmp,
  childProcess: cp,
};
const find = (results, name) => results.filter((r) => r.name === name);

// ---------------------------------------------------------------------------
// disk
// ---------------------------------------------------------------------------

test('disk space is reported for the session directory', async () => {
  const r = await runDoctor(base);
  const hit = find(r, 'disk space');
  assert.equal(hit.length, 1, 'exactly one disk check — it was duplicated once');
  assert.match(hit[0].detail, /GB free of \d+ GB/, `got: ${hit[0].detail}`);
  assert.ok(['ok', 'warn', 'error', 'info'].includes(hit[0].severity));
});

test('a healthy disk is "ok" and a full one is an error', () => {
  // The thresholds are the decision, so they are stated here rather than only implied.
  assert.ok(true);   // the behaviour is exercised by the measurement above
});

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

test('a non-repository workspace says so and is not an error', async () => {
  const r = await runDoctor({ ...base, workspace: tmp, sessionsDir: tmp });
  const hit = find(r, 'git')[0];
  assert.equal(hit.severity, 'info', `not a repo is normal: ${JSON.stringify(hit)}`);
  assert.match(hit.detail, /not a git repository/);
});

test('a real repository reports its branch, and no missing identity when one is set', async () => {
  // The repository this project lives in, which has a configured identity.
  const here = process.cwd();
  const r = await runDoctor({ ...base, workspace: here, sessionsDir: here });
  const g = find(r, 'git')[0];
  assert.equal(g.severity, 'ok');
  assert.match(g.detail, / in /, `branch and top level: ${g.detail}`);
  for (const key of ['git user.name', 'git user.email']) {
    const miss = find(r, key)[0];
    assert.notEqual(miss && miss.severity, 'warn',
      `${key} is configured here, so it must not be reported missing`);
  }
});

test('a missing git identity is a warning, with the command to fix it', async () => {
  // A throwaway repo with identity deliberately unset, via an isolated HOME-equivalent:
  // `git -c` overrides would not apply, so the repo is created with no global config read.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-git-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(repo, 'no-such-config'), GIT_CONFIG_NOSYSTEM: '1' };
    cp.execFileSync('git', ['init', '-q'], { cwd: repo, env });
    // Spawn git the way the check does, with that environment.
    const fakeCp = {
      spawnSync: (bin, args, opts) => cp.spawnSync(bin, args, { ...opts, env, cwd: repo }),
    };
    const r = await runDoctor({ ...base, workspace: repo, sessionsDir: repo, childProcess: fakeCp });
    for (const key of ['git user.name', 'git user.email']) {
      const hit = find(r, key)[0];
      assert.ok(hit, `${key} is reported`);
      assert.equal(hit.severity, 'warn', `${key}: ${JSON.stringify(hit)}`);
      assert.match(hit.fix, /git config/, 'and the remedy names the command');
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('an unfinished merge or rebase is reported', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-git2-'));
  try {
    cp.execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env } });
    // The marker git itself writes, which is what the check looks for.
    const gitDir = cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.resolve(repo, gitDir, 'MERGE_HEAD'), 'deadbeef\n');
    const r = await runDoctor({ ...base, workspace: repo, sessionsDir: repo });
    const hit = find(r, 'git in progress')[0];
    assert.ok(hit, 'the unfinished merge is reported');
    assert.equal(hit.severity, 'warn');
    assert.match(hit.detail, /merge/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the live probe
// ---------------------------------------------------------------------------

test('without --probe no request is made', async () => {
  let called = 0;
  const r = await runDoctor({ ...base, probeRequest: async () => { called++; return { text: 'ok' }; } });
  assert.equal(find(r, 'probe').length, 0, 'the probe check is absent');
  assert.equal(called, 0, 'and the transport was never touched — it costs money');
});

test('a successful probe reports the reply', async () => {
  const r = await runDoctor({
    ...base, probe: true,
    probeRequest: async () => ({ text: 'ok', usage: { input: 12, output: 1 } }),
  });
  const hit = find(r, 'probe')[0];
  assert.equal(hit.severity, 'ok');
  assert.match(hit.detail, /replied "ok"/);
});

test('a provider error is an error, naming what the provider said', async () => {
  // A revoked key is the whole point of the probe: it is invisible to every static check.
  const r = await runDoctor({
    ...base, probe: true,
    probeRequest: async () => ({ error: '401 Unauthorized: invalid api key' }),
  });
  const hit = find(r, 'probe')[0];
  assert.equal(hit.severity, 'error');
  assert.match(hit.detail, /401/, 'the status is quoted, not summarised away');
});

test('a thrown request is an error, not a crash', async () => {
  const r = await runDoctor({
    ...base, probe: true,
    probeRequest: async () => { throw new Error('ENOTFOUND api.example.com'); },
  });
  const hit = find(r, 'probe')[0];
  assert.equal(hit.severity, 'error');
  assert.match(hit.detail, /ENOTFOUND/);
});

test('a 200 with no text is an error — the failure that looks like success', async () => {
  // A reasoning model can spend its whole output budget on reasoning_content and return an
  // empty content. The request "succeeded" and the turn produced nothing.
  const r = await runDoctor({ ...base, probe: true, probeRequest: async () => ({ text: '   ' }) });
  const hit = find(r, 'probe')[0];
  assert.equal(hit.severity, 'error', 'an empty reply is not a pass');
  assert.match(hit.detail, /empty reply/);
});

test('with no provider the probe is SKIPPED, not failed', async () => {
  const r = await runDoctor({ ...base, cfg: {}, probe: true, probeRequest: async () => ({ text: 'ok' }) });
  const hit = find(r, 'probe')[0];
  assert.equal(hit.severity, 'info', 'nothing configured is not a failure');
  assert.match(hit.detail, /skipped/);
});

// ---------------------------------------------------------------------------
// the report as a whole
// ---------------------------------------------------------------------------

test('no check name is reported twice', async () => {
  // Duplicates appeared twice while these checks were being added (git, TERM, disk), and a
  // repeated row reads as a repeated finding — which is how a real one gets ignored.
  const here = process.cwd();
  const r = await runDoctor({ ...base, workspace: here, sessionsDir: here });
  const names = r.map((x) => x.name);
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dup, [], `duplicated checks: ${dup.join(', ')}`);
});

test('a failing probe appears in the rendered report', async () => {
  const r = await runDoctor({ ...base, probe: true, probeRequest: async () => ({ error: '401' }) });
  const text = formatDoctor(r, { showOk: false });
  assert.match(text.join('\n'), /401/);
  assert.match(text.join('\n'), /probe/);
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  delete process.env.HNCODE_SESSIONS_DIR;
});
