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

// The two PowerShell families, by the name they are invoked as.
export const SHELL_CANDIDATES = ['pwsh', 'powershell'];

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
 * Find a usable PowerShell: pwsh first, then the built-in powershell.
 * Returns { path, name, edition } or null when neither exists.
 *
 * `edition` drives syntax guidance — see the header. It is inferred from the NAME
 * rather than by running the binary (a spawn per probe is not worth it, and
 * PowerShell 6, also named `pwsh`, is EOL and not a realistic target, so `pwsh`
 * safely implies 7+).
 */
export function detectShell() {
  for (const name of SHELL_CANDIDATES) {
    const path = whichSync(name);
    if (path) {
      return { path, name, edition: name === 'pwsh' ? 'core' : 'desktop' };
    }
  }
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
 * Throws a message naming the fix when no PowerShell is installed, instead of
 * letting the caller hit a bare ENOENT.
 */
export function shellSpawnArgs(command) {
  const shell = getShell();
  if (!shell) {
    throw new Error(
      'No PowerShell found on PATH (tried pwsh, powershell). '
      + 'Install PowerShell 7+ or add it to PATH, then retry.',
    );
  }
  return { bin: shell.path, args: ['-NoProfile', '-NonInteractive', '-Command', command], shell };
}
