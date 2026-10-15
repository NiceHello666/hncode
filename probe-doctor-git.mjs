// Minimal reproduction of the two defects found in src/doctor.js checkGit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

process.env.HNCODE_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-diag-'));
const { runDoctor } = await import('./src/doctor.js');

const tmp = process.env.HNCODE_SESSIONS_DIR;
const here = process.cwd();

// --- Defect B: a `git -C <path>` style workspace (cwd unavailable) -----------
// checkGit spawns git WITHOUT `-C workspace` when `workspace` is falsy, so it
// silently inspects the process cwd instead of the workspace it was asked about.
const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-other-'));
cp.execFileSync('git', ['init', '-q'], { cwd: otherRepo });
fs.writeFileSync(path.join(otherRepo, 'MERGE_HEAD.probe'), '');

const noWorkspace = await runDoctor({
  cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k', workspace: tmp },
  workspace: null,          // <- no workspace passed
  sessionsDir: tmp,
  childProcess: cp,
});
console.log('A) workspace=null -> git rows:',
  JSON.stringify(noWorkspace.filter((r) => r.name.startsWith('git')), null, 2));
console.log('   cwd is', here, '-> it reported THAT repo, not "unknown"');

// --- Defect A: identity check ------------------------------------------------
const rows = await runDoctor({
  cfg: { provider: 'p', model: 'm', endpoint: 'https://x/v1', apiKey: 'k', workspace: here },
  workspace: here,
  sessionsDir: here,
  childProcess: cp,
});
console.log('B) identity rows in real repo:',
  JSON.stringify(rows.filter((r) => r.name.startsWith('git user')), null, 2));
console.log('   (empty = "not set" row omitted entirely, which assert.notEqual(undefined,"warn") accepts)');

fs.rmSync(otherRepo, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
