// Session teleport — carry a conversation to another machine or another checkout.
//
// Why not just copy the session file: a session's JSON contains absolute paths (the
// workspace, every file the tools touched) and the tool arguments that name them. A
// file teleported verbatim to a different checkout resumes with a workspace that
// does not exist and a transcript full of paths that resolve to nothing. So a
// teleport is a TRANSFORM, not a copy:
//
//   * paths under the old workspace are rewritten to the new one;
//   * the workspace itself is recorded, so the receiving side can check it exists;
//   * everything machine-specific that would be WRONG on the other machine is
//     dropped rather than carried (see `stripVolatile`).
//
// The container is plain JSON with a small header, so a teleport can be inspected,
// edited by hand, or piped through `ssh`. Compression is deliberately not used: a
// session is text, base64 would make it unreadable, and the transport (scp, ssh,
// git) can compress better than we can.

/** The header written into every teleport file, so a stale format is detectable. */
export const TELEPORT_FORMAT = 'hncode-teleport';
export const TELEPORT_VERSION = 1;

/**
 * Fields that describe THIS machine's runtime rather than the conversation. Carried
 * verbatim they would be wrong on the other side in a way that looks like data
 * corruption, so they are dropped: a running tool's live output refers to a process
 * that no longer exists, and the token/cost totals belong to the machine that spent
 * them.
 */
const VOLATILE_KEYS = [
  'tasks',              // background jobs: the processes are gone
  'usage',              // token totals spent on the exporting machine
  'sessionApprovals',   // grants the user made here must not transfer silently
  '_tokTimes',
  '_metrics',
];

/** Drop the machine-specific fields, returning a copy. */
export function stripVolatile(session) {
  const out = { ...(session || {}) };
  for (const k of VOLATILE_KEYS) delete out[k];
  // A live or pending tool row belongs to a turn that is not running here.
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const c = { ...m };
      delete c.pending;
      delete c.liveOutput;
      return c;
    });
  }
  return out;
}

/** Normalise a path to forward slashes with no trailing separator, for comparison. */
function norm(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Rewrite the paths under `from` to `to`, anywhere in the session.
 *
 * A STRUCTURAL walk over the parsed object, not a text replace over the serialized
 * JSON. The text approach looked simpler but could never work on Windows: JSON
 * escapes a backslash as `\\`, so the string `D:\old\proj` appears in the file as
 * `D:\\old\\proj` and searching for the raw path finds nothing. Escaping the search
 * term to match produced a second class of misses (a path that legitimately contains
 * a backslash next to text that is not part of it).
 *
 * Walking every string compares the path in its NORMALISED form (forward slashes, no
 * trailing separator), so `D:\old\proj`, `D:/old/proj` and a trailing-slash variant
 * all match, and the REPLACEMENT is written back in the separator style the original
 * string used — a Windows session keeps backslashes, a POSIX one keeps slashes.
 */
export function rewriteWorkspace(session, from, to) {
  const oldPath = norm(from);
  const newPath = norm(to);
  if (!oldPath || !newPath || oldPath === newPath) return session;
  const walk = (value) => {
    if (typeof value === 'string') return replaceInString(value, oldPath, newPath);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(session);
}

/**
 * Replace `oldPath` inside one string, preserving the separator style.
 *
 * The match is done on a normalised COPY of the string with index mapping, so the
 * replacement lands in the right place while the surrounding text is untouched. A
 * simple `split/join` on the normalised form would rewrite every backslash in the
 * string, including ones that are not path separators.
 */
function replaceInString(text, oldPath, newPath) {
  const normText = norm(text);
  // The whole-string case is by far the most common (a path ARGUMENT). The tail may
  // carry a trailing separator the normalisation removed, which is dropped with it:
  // `D:\old\proj\` becomes the new path, not the new path plus a stray slash.
  if (normText === oldPath) return toStyle(newPath);
  return replaceByIndex(text, oldPath, newPath);
}

// Replace every path-shaped occurrence, matching on the normalised form and writing
// the replacement at the ORIGINAL indices. norm() rewrites separators one character
// for one, so the indices line up exactly and the surrounding text is never touched.
//
// The replacement extends past the matched prefix to the END OF THE PATH TOKEN, and
// the tail is re-emitted with POSIX separators. Without that, moving a Windows
// checkout to Linux produced `read /home/me/proj\src\a.js` — the prefix rewritten and
// the rest still using backslashes, which resolves on neither system.
function replaceByIndex(text, oldPath, newPath) {
  const normText = norm(text);
  let at = normText.indexOf(oldPath);
  if (at < 0) return text;
  const styled = toStyle(newPath);
  let out = '';
  let cursor = 0;
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1];
    const end = at + oldPath.length;
    const after = end >= text.length ? '' : text[end];
    // Only a path-SHAPED hit counts, so a coincidental substring inside a word is
    // left alone. `okAfter` has to accept a separator too: the match may stop at the
    // workspace root while the string continues into a file (`…/proj/src/a.js`).
    const okBefore = at === 0 || /[\\/\s"'(=,:;]/.test(before);
    const okAfter = end >= text.length || /[\\/\s"'),:;]/.test(after);
    if (okBefore && okAfter) {
      // Consume the rest of the path token so its separators can be normalised too.
      let stop = end;
      const sep = /[\\/]/;
      if (end < text.length && sep.test(text[end])) {
        while (stop < text.length && !/[\s"'),:;]/.test(text[stop])) stop++;
      }
      out += text.slice(cursor, at) + styled + toStyle(text.slice(end, stop));
      cursor = stop;
      at = normText.indexOf(oldPath, stop);
      continue;
    }
    at = normText.indexOf(oldPath, at + 1);
  }
  return out + text.slice(cursor);
}

/**
 * Write `p` with POSIX separators.
 *
 * Always forward slashes, whatever the input string used: the target workspace is
 * what decides the style, and the target is recorded POSIX-normalised (see pack). A
 * Windows SOURCE path that lands on a Linux checkout must come out as `/home/x/proj`,
 * not `\home\x\proj`, or the receiving side resolves nothing.
 */
function toStyle(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Build the teleport container for a session.
 *
 * `opts.from` / `opts.to` rewrite the workspace; `to` is also recorded as the
 * workspace the receiving side should have.
 */
export function packSession(session, opts = {}) {
  const from = opts.from || session.workspace || '';
  const to = opts.to || from;
  const body = rewriteWorkspace(stripVolatile(session), from, to);
  return {
    format: TELEPORT_FORMAT,
    version: TELEPORT_VERSION,
    exportedAt: new Date().toISOString(),
    // The workspace the session EXPECTS. The importing side checks this and reports
    // a mismatch rather than silently resuming somewhere else.
    workspace: norm(to),
    // Recorded so the importer can show what happened, and a human reviewing the
    // file can see it moved.
    from: norm(from),
    title: body.title || '',
    rounds: body.rounds || 0,
    session: { ...body, workspace: norm(to) },
  };
}

/** Serialize a teleport for writing. */
export function serializeTeleport(pack) {
  return JSON.stringify(pack, null, 2) + '\n';
}

/**
 * Parse and validate a teleport. Throws with a specific reason, because the common
 * failure is pasting the wrong file and "invalid JSON" alone does not say that.
 */
export function parseTeleport(text) {
  let pack;
  try { pack = JSON.parse(String(text || '')); }
  catch (e) { throw new Error(`not valid JSON: ${e.message}`); }
  if (!pack || typeof pack !== 'object') throw new Error('empty teleport');
  if (pack.format !== TELEPORT_FORMAT) {
    throw new Error(`not an hncode teleport (format is ${JSON.stringify(pack.format)})`);
  }
  if (!(pack.version <= TELEPORT_VERSION)) {
    throw new Error(`teleport version ${pack.version} is newer than this build (${TELEPORT_VERSION})`);
  }
  if (!pack.session || typeof pack.session !== 'object') throw new Error('teleport has no session');
  return pack;
}

/**
 * Prepare an imported teleport for this machine.
 *
 * Returns `{ session, warnings }`. Warnings rather than errors: a renamed checkout is
 * a common, recoverable situation, and refusing to import would strand the
 * conversation. The caller decides whether to continue.
 */
export function unpackInto(pack, opts = {}) {
  const warnings = [];
  const here = norm(opts.workspace || pack.workspace || '');
  const there = norm(pack.workspace || '');
  if (there && here && there !== here) {
    warnings.push(`the session was recorded in ${there}, but this workspace is ${here} — paths have been rewritten`);
  }
  let session = pack.session;
  // Re-point at THIS workspace when it differs, so the transcript's paths resolve.
  session = rewriteWorkspace(session, there, here);
  // A fresh id unless the caller wants the original: importing twice under one id
  // would make the two copies overwrite each other on save.
  session = { ...session, workspace: here, importedAt: new Date().toISOString() };
  if (opts.newId && typeof opts.newId === 'function') session.id = opts.newId();
  return { session, warnings };
}

/** `hncode-teleport-<id>-<stamp>.json`, a name that sorts by time and names the origin. */
export function teleportFileName(session, at = new Date()) {
  const id = String((session && session.id) || 'session').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `hncode-teleport-${id}-${stamp}.json`;
}

/** A human summary for the confirmation message. */
export function describeTeleport(pack) {
  const msgs = Array.isArray(pack.session && pack.session.messages) ? pack.session.messages.length : 0;
  return [
    `title      ${pack.title || '(untitled)'}`,
    `from       ${pack.from || '(unknown)'}`,
    `workspace  ${pack.workspace || '(unknown)'}`,
    `exported   ${pack.exportedAt || '(unknown)'}`,
    `messages   ${msgs}`,
    `rounds     ${pack.rounds || 0}`,
  ].join('\n');
}

export default {
  packSession, serializeTeleport, parseTeleport, unpackInto,
  rewriteWorkspace, stripVolatile, teleportFileName, describeTeleport,
  TELEPORT_FORMAT, TELEPORT_VERSION,
};
