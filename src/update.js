// Auto-update support for hncode.
//
// hncode is installed as a global npm package (@hncode/hncode). This module
// checks npm for a newer version and, when one exists, installs it in the
// background without ever blocking the TUI. The running process is unaffected —
// the new files land on disk and take effect on next launch, which is the
// "seamless / no-sense" behaviour we want.
//
// Everything here is fire-and-forget: check() and update() return Promises that
// resolve to a status string, never throw to the caller. The TUI calls them from
// timers / startup without awaiting.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localVersion } from './version.js';

const PKG_NAME = '@hncode/hncode';
// Spawn npm portably. On Windows npm is a `.cmd` shim, and Node refuses to spawn
// a `.cmd` directly (EINVAL) — it must go through a shell. Using
// `cmd.exe /c npm ...` keeps that behaviour while avoiding `shell: true`, which
// Node warns about (with a shell, args are concatenated rather than escaped).
function spawnNpm(args, opts) {
  if (process.platform === 'win32') return spawn('cmd.exe', ['/c', 'npm', ...args], opts);
  return spawn('npm', args, opts);
}
// How often the auto-check runs once we are past the startup check.
export const AUTO_UPDATE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export { localVersion };

// Latest version published to npm, or '' if the registry is unreachable /
// not installed / not a package.
//
// ASYNC on purpose: `execSync` blocks the whole event loop, so a cold `npm view`
// (measured at ~15s on a slow registry, vs ~2s warm) froze the TUI — no key
// handling, no repaint — for the entire duration. `spawn` runs the same command
// off the main thread, and the timeout kills it rather than waiting it out.
export function remoteVersion(timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnNpm(['view', PKG_NAME, 'version', '--silent'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(''); }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish(''));
    child.on('close', () => finish((out || '').trim()));
  });
}

// Parse a semver-ish `x.y.z` into comparable numbers, or null when it is not one.
//
// The leading `v` is stripped because npm accepts `v1.2.3` as a version and some mirrors
// echo it back; without this the string failed to parse and every update was invisible.
// The prerelease suffix is KEPT as a flag rather than discarded: `1.2.3-beta` has to rank
// BELOW `1.2.3`, and dropping the suffix made the two identical.
function parseSemver(v) {
  const raw = String(v == null ? '' : v).trim();
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

// True when `remote` is strictly newer than `local`.
export function isNewer(remote, local) {
  const r = parseSemver(remote), l = parseSemver(local);
  if (!r || !l) return false;
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  if (r.patch !== l.patch) return r.patch > l.patch;
  // Same release. A plain version outranks its own prerelease, so 1.2.3 is newer than
  // 1.2.3-beta — but 1.2.3-beta is NOT newer than 1.2.3, which is what dropping the
  // suffix got wrong.
  if (r.pre === l.pre) return false;
  if (!l.pre) return false;   // local is the release, remote is a prerelease of it
  if (!r.pre) return true;    // remote is the release, local is the prerelease
  return r.pre > l.pre;       // both prereleases: lexical order is semver's rule here
}


// ---- install lock ------------------------------------------------------------
//
// Created with O_EXCL, which is atomic across processes: whoever wins the create owns the
// install, and everyone else reads the owner and stands down. A plain `existsSync` check
// followed by a write is a race — two sessions can pass the check before either writes.
export function updateLockFile() {
  const dir = process.env.HNCODE_HOME || path.join(os.homedir(), '.hncode');
  return path.join(dir, 'update.lock');
}

// Older than this and the lock is treated as abandoned. An install that outlives it is
// still running, but a lock that can never expire would disable updates for good — which is
// the worse failure, so the age wins.
const LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * Try to claim the install lock.
 *
 * Returns `{ ok: true }` when this process now owns it, or `{ ok: false, heldBy }` with the
 * owner record (pid, version, when) so the caller can say who is installing instead of
 * silently doing nothing. Never throws.
 */
export function claimInstallLock(version = '') {
  const file = updateLockFile();
  const payload = JSON.stringify({ pid: process.pid, version, at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch { /* the open below reports the real problem */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' is O_CREAT|O_EXCL|O_WRONLY: it fails when the file exists, atomically.
      fs.writeFileSync(file, payload, { flag: 'wx' });
      return { ok: true };
    } catch (e) {
      if (e && e.code !== 'EEXIST') return { ok: false, heldBy: null };
      // Someone holds it. Only break it if it is old enough to be abandoned.
      let owner = null;
      let age = 0;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        age = Date.now() - new Date(owner.at || 0).getTime();
      } catch {
        // Unreadable: treat it as stale rather than as a permanent block.
        age = LOCK_STALE_MS + 1;
      }
      if (age < LOCK_STALE_MS) return { ok: false, heldBy: owner };
      try { fs.unlinkSync(file); } catch { return { ok: false, heldBy: owner }; }
      // Loop once more: the next create either wins or reports the new owner.
    }
  }
  return { ok: false, heldBy: null };
}

/** Release the install lock. Never throws. */
export function releaseInstallLock() {
  try { fs.unlinkSync(updateLockFile()); return true; } catch { return false; }
}

/** Who holds the lock right now, or null. Never throws. */
export function installLockHolder() {
  try { return JSON.parse(fs.readFileSync(updateLockFile(), 'utf8')); } catch { return null; }
}

// ---- recording what a background install did ---------------------------------
//
// An install cannot change the RUNNING process, so the only moment the user can learn
// about it is the next launch. That makes a file the natural channel: the detached npm
// writes its outcome here, and the next `startTUI` reads it.
export function updateStampFile() {
  const dir = process.env.HNCODE_HOME || path.join(os.homedir(), '.hncode');
  return path.join(dir, 'update.json');
}

/** The last install's outcome, or null. Never throws. */
export function readUpdateStamp() {
  try { return JSON.parse(fs.readFileSync(updateStampFile(), 'utf8')); } catch { return null; }
}

// npm's own stderr from the background install, beside the stamp. A FILE because
// the install outlives this process: a pipe belonged to hncode, and quitting
// mid-install closed it under npm — the install died on EPIPE partway through.
function updateLogFile() {
  const dir = process.env.HNCODE_HOME || path.join(os.homedir(), '.hncode');
  return path.join(dir, 'update-log.txt');
}

/** Last `n` bytes of a file, or ''. Never throws. */
function tailOfFile(p, n = 4000) {
  try {
    const st = fs.statSync(p);
    const fh = fs.openSync(p, 'r');
    try {
      const start = Math.max(0, st.size - n);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fh, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fh); }
  } catch { return ''; }
}

/** Forget it, once it has been reported. Never throws. */
export function clearUpdateStamp() {
  try { fs.unlinkSync(updateStampFile()); return true; } catch { return false; }
}

function writeUpdateStamp(obj) {
  try {
    fs.mkdirSync(path.dirname(updateStampFile()), { recursive: true });
    fs.writeFileSync(updateStampFile(), JSON.stringify({ at: new Date().toISOString(), ...obj }));
  } catch { /* the install is what matters; a lost note must not mask it */ }
}

// Run the install DETACHED and record how it went. Returns as soon as npm is started —
// `{ ok: true, pending: true }` — because waiting here would stall the caller for the length
// of an install. The outcome travels through the stamp file instead.
//
// stderr is CAPTURED rather than ignored. `stdio: 'ignore'` is what made every failure
// silent: an npm that could not write the global prefix said so to nobody.
export function updateBackground(version = '') {
  return new Promise((resolve) => {
    // ONE install at a time, across processes. The lock is the only thing that stops the
    // startup check, the interval and /update from each spawning their own npm — the
    // in-process guard spans only the version query, and another session shares nothing
    // but this file.
    const lock = claimInstallLock(version);
    if (!lock.ok) {
      const who = lock.heldBy;
      const msg = who && who.pid
        ? `an update to ${who.version || 'a newer version'} is already installing (pid ${who.pid})`
        : 'an update is already installing';
      // Not an error: the other install will finish and write the stamp. Saying so lets
      // /update answer honestly instead of reporting a failure the user cannot act on.
      resolve({ ok: false, busy: true, error: msg });
      return;
    }

    // stderr lands in a file (survives this process); when the file cannot be
    // opened, fall back to a pipe and the in-memory capture below.
    const logFile = updateLogFile();
    let logFd = null;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      logFd = fs.openSync(logFile, 'w');
    } catch { logFd = null; }

    let child;
    try {
      child = spawnNpm(['install', '-g', `${PKG_NAME}@latest`], {
        detached: true,
        stdio: ['ignore', 'ignore', logFd == null ? 'pipe' : logFd],
      });
    } catch (e) {
      if (logFd != null) { try { fs.closeSync(logFd); } catch { /* already gone */ } }
      releaseInstallLock();
      const error = (e && e.message) || String(e);
      writeUpdateStamp({ status: 'error', version, error });
      resolve({ ok: false, error });
      return;
    }

    let stderr = '';
    if (logFd == null && child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
    }

    // The lock is released on BOTH paths below. Leaving it behind on a failure would
    // block every later update until it aged out, which is worse than the double install
    // it prevents.
    child.on('error', (e) => {
      releaseInstallLock();
      if (logFd != null) { try { fs.closeSync(logFd); } catch { /* already gone */ } }
      writeUpdateStamp({ status: 'error', version, error: (e && e.message) || String(e) });
    });
    child.on('close', (code) => {
      releaseInstallLock();
      if (logFd != null) { try { fs.closeSync(logFd); } catch { /* already gone */ } }
      // Exit code 0 is the only thing that means the files were replaced. Anything else —
      // no permission, an unreachable registry, a killed process — is recorded with npm's
      // own last words, which is what makes the next launch's message actionable.
      if (code === 0) {
        writeUpdateStamp({ status: 'installed', version });
      } else {
        const raw = logFd != null ? tailOfFile(logFile) : stderr;
        const tail = raw.trim().split(/\r?\n/).slice(-6).join('\n');
        writeUpdateStamp({ status: 'error', version, code, error: tail || `npm exited ${code}` });
      }
    });

    // Detached so the install outlives this process; the stamp file is how its result
    // travels back. `unref` is what lets hncode exit while npm is still running.
    child.unref();
    resolve({ ok: true, pending: true });
  });
}

// Full auto-check: read remote, if newer start a background update.
// Returns a status object. The TUI's auto-check IGNORES it (fully silent); the
// /update command reports it.
// Full auto-check: read the remote version and, when it is newer, START a background
// install. Returns a status object.
//
// The status says `installing`, not `updated`: this returns as soon as npm is spawned, and
// whether the files were actually replaced is only knowable from the stamp file afterwards.
// The old `updated` claimed a result nothing here could observe, which is how a failed
// install was reported to the user as a success.
export async function checkAndUpdate() {
  const local = localVersion();
  if (!local) return { status: 'none', message: "can't read local version" };
  const remote = await remoteVersion();
  if (!remote) return { status: 'none', message: 'npm registry unreachable' };

  if (isNewer(remote, local)) {
    const r = await updateBackground(remote);
    return {
      // `busy` is not `error`: another install is already running and will write the
      // stamp itself. Reporting a failure would send the user looking for a problem
      // that does not exist.
      status: r.ok ? 'installing' : (r.busy ? 'busy' : 'error'),
      message: r.ok
        ? `New version ${remote} — installing in background; restart when it finishes`
        : (r.busy ? `Already updating: ${r.error}` : `Update failed: ${r.error}`),
      current: local,
      latest: remote,
    };
  }
  return { status: 'uptodate', message: `hncode is up to date (${local})`, current: local, latest: remote };
}