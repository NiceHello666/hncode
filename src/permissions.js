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

/** Strip a trailing `# …` comment. ` #` (whitespace before the hash) is the
 *  delimiter, so a `#` inside an argument — `Bash(echo a#b)` — is left alone. */
export function stripRuleComment(text) {
  const m = /(^|\s)#/.exec(String(text == null ? '' : text));
  return m ? String(text).slice(0, m.index + m[1].length).trim() : String(text == null ? '' : text).trim();
}

// `Bash(npm run test)` / `Read(./src/**)` -> { tool, arg }
export function parseRule(rule) {
  // The comment is stripped FIRST. Without this a rule carrying `# match: …`
  // examples parsed as null (the text no longer ends with `)`) and the rule
  // silently stopped matching anything — so annotating a rule broke it.
  const text = stripRuleComment(rule);
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

// ---------------------------------------------------------------------------
// Rule self-tests
// ---------------------------------------------------------------------------
// A rule that silently matches NOTHING is worse than no rule at all: the user
// believes `npm test` is allowed, the prompt appears anyway, and nothing says why.
// A typo in a glob (`./src/*` vs `./src/**`) is invisible until the prompt shows up
// at the wrong moment.
//
// So a rule may carry its own examples, checked when the rules are read:
//
//   Bash(npm run test *)   # match: npm run test foo   | not_match: npm run tests
//
// This mirrors codex's `prefix_rule(match=[...], not_match=[...])`, which validates
// its examples at load time. The examples live on the SAME line as the rule, as a
// trailing comment, so a rule and its test cannot drift into two places and the
// line-based config format does not have to change.
//
// Several examples are separated by `|`. An example is the ARGUMENT the rule
// describes — the command for Bash, the path for a file tool — so no quoting is
// needed for the common case.

/** Split one rule line into `{ rule, match, not_match }`. */
export function parseRuleLine(line) {
  const text = String(line == null ? '' : line);
  // A ` #` delimiter, so a `#` inside an argument stays part of the rule.
  const delim = /(^|\s)#/.exec(text);
  const ruleText = delim ? text.slice(0, delim.index + delim[1].length).trim() : text.trim();
  const comment = delim ? text.slice(delim.index + delim[0].length).trim() : '';
  const out = { rule: ruleText, match: [], not_match: [] };
  if (!comment) return out;
  // Scan for the markers rather than splitting on them: `split` with a LOOKAHEAD
  // of `\bnot[_-]?match` splits `not-match` into `not-` and `match:` (the boundary
  // before `match` matched first), which produced two unusable halves. An explicit
  // scan takes the longest marker at each position and cannot do that.
  const marker = /(not[_-]?match|match)\s*:/gi;
  const found = [];
  let m;
  while ((m = marker.exec(comment)) !== null) {
    found.push({ key: /^not/i.test(m[1]) ? 'not_match' : 'match', from: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < found.length; i++) {
    const end = i + 1 < found.length ? found[i + 1].from : comment.length;
    const body = comment.slice(found[i].bodyStart, end);
    for (const ex of body.split('|')) {
      const t = ex.trim();
      if (t) out[found[i].key].push(t);
    }
  }
  return out;
}

/** An example string -> the argument object `ruleMatches` expects. */
export function exampleArgs(toolName, example) {
  const ex = String(example == null ? '' : example).trim();
  if (toolName === 'Bash') return { command: ex };
  return { path: ex, file_path: ex, pattern: ex };
}

/**
 * Check every rule's examples. Returns `{ checks, failed }`; a failed check is
 * `{ rule, kind: 'match'|'not_match', example, list }`.
 *
 * A rule with NO examples yields no checks: the test is opt-in, so adding this to an
 * existing config cannot start reporting errors for rules nobody annotated.
 */
export function selfTestRules(rules) {
  const list = rules || {};
  const checks = [];
  const failed = [];
  // `deny` is included on purpose: an over-broad deny is the MOST damaging typo of
  // the three, because it can lock the agent out of the work it was asked to do.
  for (const key of ['allow', 'ask', 'deny']) {
    const arr = Array.isArray(list[key]) ? list[key] : [];
    for (const raw of arr) {
      const { rule, match, not_match } = parseRuleLine(raw);
      if (!rule) continue;
      const parsed = parseRule(rule);
      if (!parsed) {
        failed.push({ rule, kind: 'parse', example: '', list: key });
        continue;
      }
      for (const ex of match) {
        const pass = ruleMatches(parsed, parsed.tool, exampleArgs(parsed.tool, ex));
        checks.push({ rule, kind: 'match', example: ex, pass, list: key });
        if (!pass) failed.push({ rule, kind: 'match', example: ex, list: key });
      }
      for (const ex of not_match) {
        const pass = !ruleMatches(parsed, parsed.tool, exampleArgs(parsed.tool, ex));
        checks.push({ rule, kind: 'not_match', example: ex, pass, list: key });
        if (!pass) failed.push({ rule, kind: 'not_match', example: ex, list: key });
      }
    }
  }
  return { checks, failed };
}

/** The self-test block for the /permissions panel. */
export function describeSelfTest(result) {
  if (!result || !result.checks.length) {
    return result && result.failed.length
      ? `${result.failed.length} rule(s) could not be parsed:\n`
        + result.failed.map((f) => `  FAIL ${f.list}: ${f.rule}`).join('\n')
      : 'No rule has examples yet. Add them on the rule line:\n'
        + '  Bash(git push *)   # match: git push | not_match: git pull';
  }
  const out = [`${result.checks.length} example(s) checked, ${result.failed.length} failed:`];
  for (const c of result.checks) {
    const want = c.kind === 'match' ? 'should match    ' : 'should NOT match';
    out.push(`  ${c.pass ? 'ok  ' : 'FAIL'} ${want} ${c.list}: ${c.rule}  <- ${c.example}`);
  }
  return out.join('\n');
}

export default {
  parseRule, ruleMatches, decideFromRules, describeRules,
  parseRuleLine, selfTestRules, describeSelfTest, exampleArgs,
};

