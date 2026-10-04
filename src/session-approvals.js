// Session approval memory — "always allow this, for now".
//
// The permission RULES in config.toml are the durable answer ("allow npm test
// forever"). This module is the transient one: the user is mid-task, a prompt
// appears for something they already decided about five minutes ago, and they want
// it gone without editing a file. kimi has exactly this as one of its permission
// policies (`session-approval-history`), evaluated AFTER the configured rules so a
// rule always wins.
//
// Scope rules, all of which exist to keep the memory from being a surprise:
//   * The entry lives on the SESSION object, not on config — it dies with the
//     session. A persisted grant would silently apply to next week's work.
//   * It is keyed by the SHAPE of the call, not the call: for a command, the
//     PROGRAM plus its first argument (`npm test`), so `npm test --watch` is
//     covered but `npm publish` is not.
//   * It never covers a destructive command, whatever the user approved. Ctrl+A on
//     `rm -rf /build` must not pre-approve the next `rm -rf /`. This is the one
//     place the module refuses to be literal about what was approved.
//   * It cannot override a `deny` rule: the rule check runs first (see the caller).

/**
 * The key an approval is remembered under.
 *
 * For a shell command: the program and its first non-flag argument. That is the
 * narrowest unit that is still useful — `npm test` covers `npm test --watch` and
 * `npm test src/a.test.ts`, while `npm run` stays separate from `npm test`.
 *
 * For anything else: the tool name alone. A file tool's approval is about the TOOL
 * (the path guard still applies per call), and keying by path would produce a new
 * entry per file with no benefit.
 */
export function approvalKey(toolName, args) {
  const tool = String(toolName || '');
  if (tool !== 'Bash') return tool;
  const cmd = String((args && (args.command || args.cmd)) || '').trim();
  if (!cmd) return tool;
  const words = cmd.split(/\s+/).filter(Boolean);
  // Skip a leading assignment (`FOO=1 npm test`) — it is not the program.
  const prog = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) || '';
  if (!prog) return tool;
  const sub = words.slice(words.indexOf(prog) + 1).find((w) => !w.startsWith('-')) || '';
  return sub ? `${tool}:${prog} ${sub}` : `${tool}:${prog}`;
}

/** A label for the transcript, e.g. `Bash: npm test` or `Write`. */
export function sessionApprovalLabel(toolName, args) {
  return approvalKey(toolName, args);
}

/**
 * Was this call approved for the session? `destructive` is the caller's verdict on
 * the command; a true value always returns false, so the memory cannot pre-approve
 * something that was judged too dangerous to run unattended.
 */
export function isApprovedForSession(list, toolName, args, destructive = false) {
  if (destructive) return false;
  const key = approvalKey(toolName, args);
  if (!key) return false;
  return Array.isArray(list) && list.includes(key);
}

/** Add a key to the list (returning a new array; no duplicates). */
export function rememberApproval(list, toolName, args) {
  const key = approvalKey(toolName, args);
  const cur = Array.isArray(list) ? list : [];
  if (!key || cur.includes(key)) return cur.slice();
  return [...cur, key];
}

/** Drop one key. */
export function forgetApproval(list, key) {
  return (Array.isArray(list) ? list : []).filter((k) => k !== key);
}

/** Panel lines for /permissions, so the grants are visible and revocable. */
export function describeSessionApprovals(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return 'No session approvals. Ctrl+A on a prompt remembers one.';
  return ['Approved for this session (cleared when the session ends):']
    .concat(arr.map((k) => '  ' + k)).join('\n');
}

export default {
  approvalKey, sessionApprovalLabel, isApprovedForSession,
  rememberApproval, forgetApproval, describeSessionApprovals,
};
