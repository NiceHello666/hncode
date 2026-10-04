// Shell discovery for the Bash tool.
//
// The tool used to hardcode `spawn('pwsh', …)`, which relies on `pwsh` being on
// PATH. On a Windows box with only the built-in Windows PowerShell that name does
// not resolve at all, so the spawn failed with ENOENT and the whole tool was dead —
// no fallback, and nothing in the message said why. It only ever worked where the
// user had installed PowerShell 7 and added it to PATH by hand.
//
// Mirrors Claude Code's findPowerShell (src/utils/shell/powershellDetection.ts):
// prefer pwsh (Core 7+), fall back to powershell (Desktop 5.1), and cache the
// answer — the probe shells out, so it must not run per command.
//
// The EDITION matters beyond picking a binary: 7+ supports the pipeline chain
// operators (`&&`, `||`) and 5.1 does not, so the prompt's syntax guidance depends
// on which one was found.

import cp from 'node:child_process';
import fs from 'node:fs';

// The two PowerShell families, by the name they are invoked as.
export const SHELL_CANDIDATES = ['pwsh', 'powershell'];

// Last-resort Windows fallback. A Windows box always has cmd.exe (%COMSPEC%),
// so when neither PowerShell exists the Bash tool must still run SOMETHING
// rather than failing outright. `cmd` is not a PowerShell, so the syntax
// guidance and the spawn args differ (see cmdSpawnArgs).
export function findCmdExe() {
  const fromEnv = process.env.COMSPEC || process.env.ComSpec;
  if (fromEnv) {
    try { if (fs.existsSync(fromEnv)) return fromEnv; } catch { /* fall through to the PATH probe */ }
  }
  if (process.platform === 'win32') {
    return whichSync('cmd') || whichSync('cmd.exe') || 'cmd.exe';
  }
  return null;
}

/**
 * Resolve an executable name through PATH without spawning it.
 *
 * `where` on Windows / `which` on POSIX are the platform's own resolvers, so the
 * answer matches what a shell would do. Returns the first absolute path or null.
 */
function whichSync(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = cp.execFileSync(probe, [name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    });
    // `where` can print several matches; take the first non-empty line.
    const first = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Find a usable shell: pwsh, then the built-in powershell, then (on Windows)
 * cmd.exe as a last resort. Returns { path, name, edition } or null.
 *
 * `edition` drives syntax guidance — see the header. It is inferred from the NAME
 * rather than by running the binary (a spawn per probe is not worth it, and
 * PowerShell 6, also named `pwsh`, is EOL and not a realistic target, so `pwsh`
 * safely implies 7+). `edition: 'cmd'` means neither PowerShell exists and the
 * Bash tool is running through cmd.exe: it still works, but the command syntax is
 * cmd's, not PowerShell's.
 */
export function detectShell() {
  for (const name of SHELL_CANDIDATES) {
    const path = whichSync(name);
    if (path) {
      return { path, name, edition: name === 'pwsh' ? 'core' : 'desktop' };
    }
  }
  // No PowerShell at all: on Windows, guarantee cmd.exe so the tool is not dead.
  const cmd = findCmdExe();
  if (cmd) return { path: cmd, name: 'cmd', edition: 'cmd' };
  return null;
}

let cached;          // undefined = not probed yet; null = probed, none found
let cachedEnvKey;    // re-probe if PATH changes (a /env PATH=… must take effect)

/**
 * Cached detectShell(). The probe spawns a process, so it runs once per PATH.
 * Re-probing when PATH changes means an in-session PATH fix (`/env PATH=…`, which
 * is exactly what a user with a stripped PATH would do) can rescue the tool.
 */
export function getShell() {
  const key = String(process.env.PATH || '');
  if (cached === undefined || cachedEnvKey !== key) {
    cached = detectShell();
    cachedEnvKey = key;
  }
  return cached;
}

/** Test seam: forget the cached probe. */
export function resetShellCache() {
  cached = undefined;
  cachedEnvKey = undefined;
}

/**
 * The command + args to run `command` through the detected shell.
 *
 * `-NoProfile` and `-NonInteractive` are not cosmetic: a user profile can print a
 * banner into stdout (polluting the captured result) and can take seconds to load
 * on every single tool call, and `-NonInteractive` stops a command that prompts
 * from hanging the tool forever with no way to answer.
 *
 * When neither PowerShell exists, `edition === 'cmd'` selects cmd.exe args instead
 * (see detectShell). Throws a message naming the fix only when no shell at all
 * was found, instead of letting the caller hit a bare ENOENT.
 */
export function shellSpawnArgs(command) {
  const shell = getShell();
  if (!shell) {
    throw new Error(
      'No shell found (tried pwsh, powershell, and cmd.exe). '
      + 'Install PowerShell 7+ or add it to PATH, then retry.',
    );
  }
  if (shell.edition === 'cmd') {
    // cmd.exe: `/d` skips AutoRun commands, `/s` makes `/c` quoting behave
    // predictably. The command is passed as ONE argv element, so Node does the
    // quoting and we do not wrap it ourselves.
    return { bin: shell.path, args: ['/d', '/s', '/c', command], shell };
  }
  return { bin: shell.path, args: ['-NoProfile', '-NonInteractive', '-Command', command], shell };
}
