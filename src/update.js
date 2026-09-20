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

// Parse a semver-ish "x.y.z" (ignore prerelease tags) into comparable numbers.
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// True when `remote` is strictly newer than `local`.
export function isNewer(remote, local) {
  const r = parseSemver(remote), l = parseSemver(local);
  if (!r || !l) return false;
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  return r.patch > l.patch;
}

// Spin up the actual install in the BACKGROUND. Detached + unref'd so it keeps
// running after this process exits; stdout/err are swallowed (seamless).
// Returns: { ok: true } or { ok: false, error }.
export function updateBackground() {
  return new Promise((resolve) => {
    try {
      // `npm install -g` needs to run detached; no need to wait here.
      const child = spawnNpm(['install', '-g', `${PKG_NAME}@latest`], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      // We consider it "started" — the actual completion is unknown and that is
      // fine; the next process will be the new version.
      resolve({ ok: true });
    } catch (e) {
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

// Full auto-check: read remote, if newer start a background update.
// Returns a status object. The TUI's auto-check IGNORES it (fully silent); the
// /update command reports it.
export async function checkAndUpdate() {
  const local = localVersion();
  if (!local) return { status: 'none', message: "can't read local version" };
  const remote = await remoteVersion();
  if (!remote) return { status: 'none', message: 'npm registry unreachable' };

  if (isNewer(remote, local)) {
    const r = await updateBackground();
    return {
      status: r.ok ? 'updated' : 'error',
      message: r.ok
        ? `New version ${remote} — installing in background (restart to use it)`
        : `Update failed: ${r.error}`,
      current: local,
      latest: remote,
    };
  }
  return { status: 'uptodate', message: `hncode is up to date (${local})`, current: local, latest: remote };
}