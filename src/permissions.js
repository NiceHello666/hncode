// Permission rules — standing allow / ask / deny decisions, mirroring Claude Code's
// `permissions` block in settings.
//
// Why this exists: without it, "always allow npm test" has no home. The user answers
// the same approval prompt on every turn, or switches the whole session to Auto
// and loses the prompt for genuinely dangerous commands too. A rule set lets the
// routine work through while the rest keeps asking.
//
// Rule syntax (a subset of Claude Code's, chosen to stay readable):
//   Bash                 — every Bash call
//   Bash(npm run test)   — that exact command
//   Bash(npm run test *) — a command starting with `npm run test `
//   Bash(git push *)     — same idea, for a command with arguments
//   Read(./src/**)       — a tool whose `path` / `file_path` argument matches the glob
//   Write(./dist/**)     — same, for the path-taking tools
//   Edit                 — the tool, whatever its arguments
// An empty argument list means "any call of this tool".
//
// Precedence is deny > ask > allow, and it is checked before every other mode rule:
// a deny must not be reachable around by switching to YOLO, and an explicit ask must
// still prompt inside a mode that would otherwise auto-approve.

// Which argument names hold a path, per tool. Mirrors the tools' own schemas.
const PATH_ARGS = {
  Read: ['path', 'file_path'],
  Write: ['path', 'file_path'],
  Edit: ['path', 'file_path'],
  FileLines: ['path', 'file_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'pattern'],
};

// `Bash(npm run test)` / `Read(./src/**)` -> { tool, arg }
export function parseRule(rule) {
  const text = String(rule == null ? '' : rule).trim();
  if (!text) return null;
  const open = text.indexOf('(');
  if (open === -1) return { tool: text, arg: null };
  if (!text.endsWith(')')) return null;              // malformed: a `(` with no `)`
  const tool = text.slice(0, open).trim();
  if (!tool) return null;
  return { tool, arg: text.slice(open + 1, -1).trim() };
}

// Glob -> RegExp. Supports `**` (any depth), `*` (within a segment) and `?`.
// Deliberately small: enough for path and command-prefix matching, with no
// dependency and no surprise backtracking.
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

// Does `rule` (already parsed) match this call? `args` is the tool's argument object.
export function ruleMatches(parsed, toolName, args) {
  if (!parsed || parsed.tool !== toolName) return false;
  if (parsed.arg === null || parsed.arg === '') return true;   // bare tool name: any call

  const a = args || {};
  // Bash: the rule names a command. A trailing `*` means "starts with"; otherwise the
  // command must match exactly, so `Bash(rm -rf /)` cannot be widened by an argument.
  if (toolName === 'Bash') {
    const cmd = String(a.command || a.cmd || '').trim();
    if (parsed.arg.endsWith('*')) {
      const prefix = parsed.arg.slice(0, -1).trim();
      return cmd === prefix || cmd.startsWith(prefix + ' ');
    }
    return cmd === parsed.arg;
  }

  // Path-taking tools: match any of the tool's path-ish arguments against the glob,
  // so `Read(./src/**)` works whether the model sent `path` or `file_path`.
  const names = PATH_ARGS[toolName] || ['path', 'file_path', 'pattern'];
  for (const n of names) {
    const v = a[n];
    if (typeof v !== 'string' || !v) continue;
    // Accept both `./src/**` and `src/**` for the same intent.
    const norm = v.replace(/\\/g, '/').replace(/^\.\//, '');
    const pat = parsed.arg.replace(/\\/g, '/').replace(/^\.\//, '');
    if (globToRegExp(pat).test(norm) || globToRegExp(pat).test(v.replace(/\\/g, '/'))) return true;
  }
  return false;
}

// The decision for one call: 'deny' | 'ask' | 'allow' | null (no rule matched).
export function decideFromRules(rules, toolName, args) {
  const list = rules || {};
  const test = (key) => {
    const arr = Array.isArray(list[key]) ? list[key] : [];
    for (const raw of arr) {
      if (ruleMatches(parseRule(raw), toolName, args)) return true;
    }
    return false;
  };
  // deny wins outright; then an explicit ask; then allow.
  if (test('deny')) return 'deny';
  if (test('ask')) return 'ask';
  if (test('allow')) return 'allow';
  return null;
}

// Human-readable summary for /permissions, so a user can see what is in force.
export function describeRules(rules) {
  const list = rules || {};
  const lines = [];
  for (const key of ['allow', 'ask', 'deny']) {
    const arr = Array.isArray(list[key]) ? list[key] : [];
    lines.push(`${key} (${arr.length}):`);
    if (!arr.length) lines.push('  (none)');
    else for (const r of arr) lines.push('  ' + r);
  }
  return lines.join('\n');
}
