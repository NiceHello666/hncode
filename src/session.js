// Session store. Sessions persist under ~/.hncode/sessions/<id>.json.
// A session records: id, title, cwd (workspace), model, createdAt, updatedAt,
// and the message list (canonical, same shape the agent loop uses).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DEFAULT_DIR = () => path.join(os.homedir(), '.hncode', 'sessions');
function dir(custom) { return custom || process.env.HNCODE_SESSIONS_DIR || DEFAULT_DIR(); }

// ---- metadata cache --------------------------------------------------------
// Enumerating sessions (listSessions / latestSession / --continue) re-read every
// session file to grab its id/title/workspace/timestamps. With hundreds of
// sessions that is hundreds of open+read+parse per call. Since session files are
// only ever written through THIS module (saveSession/deleteSession), we cache the
// parsed metadata per directory and invalidate the affected entries on write. A
// caller that knows the dir changed externally (another hncode instance) can call
// invalidateSessionCache(). The cache never stores message content — only the
// cheap metadata head.
const _metaCache = new Map(); // key: storeDir (string) -> Map<fullPath, {meta, hasMessages}>
function cacheFor(storeDir, create = true) {
  const d = dir(storeDir);
  let c = _metaCache.get(d);
  if (!c && create) { c = new Map(); _metaCache.set(d, c); }
  return c;
}
export function invalidateSessionCache(storeDir) {
  _metaCache.delete(dir(storeDir));
}
// Public types do not change; this is used by the TUI/headless before a re-list
// if external state is suspected. Our own save/delete already invalidate.

// FIX: single place for the error log so save/load failures are never silent.
function errorLogFile() {
  return path.join(os.homedir(), '.hncode', 'session-errors.log');
}
function logSessionError(op, detail) {
  try {
    fs.mkdirSync(path.dirname(errorLogFile()), { recursive: true });
    fs.appendFileSync(
      errorLogFile(),
      `[${new Date().toISOString()}] ${op}: ${detail}\n`,
      'utf8',
    );
  } catch { /* logging must never throw */ }
}

export function newId() {
  // compact, mostly-sorted id (like a timestamp+rand ULID-ish)
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function sessionFile(id, storeDir) {
  return path.join(dir(storeDir), `${id}.json`);
}

// FIX: build the serialized object with a FIXED key order so `updatedAt`
// always lands BEFORE `messages`. readSessionMeta() stops scanning at the
// `"messages"` key, so a session whose updatedAt sits after the transcript
// would report updatedAt = 0 and the session list / --continue would sort
// wrongly (or pick the wrong session). Key order here is authoritative.
function serializableSession(session) {
  const out = {};
  out.id = session.id;
  out.title = session.title || '';
  out.workspace = session.workspace || '';
  out.model = session.model || '';
  out.createdAt = session.createdAt || Date.now();
  out.updatedAt = Date.now();
  // Everything else (messages, rounds, steps, plan, focus, swarm, effort, …)
  // is copied AFTER updatedAt. `messages` in particular must come after the
  // metadata block.
  for (const k of Object.keys(session)) {
    if (k in out) continue;
    if (k === 'messages') continue;   // handled below, last
    out[k] = session[k];
  }
  out.messages = Array.isArray(session.messages) ? session.messages : [];
  return out;
}

export function saveSession(session, storeDir) {
  if (!session || !session.id) return session;
  // Keep the live object's updatedAt in sync for callers that read it back.
  session.updatedAt = Date.now();
  try {
    fs.mkdirSync(dir(storeDir), { recursive: true });
    const target = sessionFile(session.id, storeDir);
    // FIX: unique temp name so two concurrent saves of the same session cannot
    // clobber each other's temp file mid-write.
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    const json = JSON.stringify(serializableSession(session), null, 2);
    fs.writeFileSync(tmp, json, 'utf8');
    // Atomic replace. If this throws (EXDEV etc.) the temp is cleaned up below.
    fs.renameSync(tmp, target);
    // The saved transcript changed, so its cached metadata head is stale. Drop
    // just this entry; the next scan re-reads the file (cheap, one file).
    cacheFor(storeDir, false)?.delete(sessionFile(session.id, storeDir));
  } catch (e) {
    // FIX: never fail silently. Previously an empty catch {} in the TUI meant a
    // serialization error (circular ref, disk full, permissions) lost the turn
    // with no signal at all.
    logSessionError('save', `${session.id}: ${e && e.message ? e.message : String(e)}`);
    return session;
  }
  return session;
}

export function loadSession(id, storeDir) {
  const file = sessionFile(id, storeDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // ENOENT is "no such session" (normal). Anything else is a real read error.
    if (e && e.code !== 'ENOENT') logSessionError('load', `${id}: ${e.message}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // FIX: a corrupt file is NOT the same as a missing session. Log it so the
    // user can find the damaged file instead of silently "losing" the session.
    logSessionError('parse', `${id}: ${e.message} (file: ${file})`);
    return null;
  }
}

// Most recent session for a workspace, or globally.
// `opts.skipEmpty` ignores sessions with no messages: hncode creates an empty
// session shell on every launch, so without this `--continue` would "resume"
// a brand-new empty session instead of the user's last real conversation.
//
// Only metadata is read (see readSessionMeta): the full parse was 370 ms on 40
// realistic sessions, pure waste since the caller needs a title and a timestamp.
export function latestSession(cwd, storeDir, opts = {}) {
  const entries = scanCached(storeDir);
  const wantWs = cwd !== undefined ? path.resolve(cwd) : null;
  let best = null;          // { meta, file }
  let bestEmpty = null;
  const stamp = (m) => (m && (m.updatedAt || m.createdAt)) || 0;
  for (const { meta, hasMessages, file } of entries) {
    if (wantWs !== null && meta.workspace !== wantWs) continue;
    const up = stamp(meta);
    if (!best || up > stamp(best.meta)) best = { meta, file };
    // hasMessages comes from the same cache entry (single head-read per file),
    // so we do not reopen anything to test emptiness.
    if (hasMessages && (!bestEmpty || up > stamp(bestEmpty.meta))) bestEmpty = { meta, file };
  }
  const pick = opts.skipEmpty ? (bestEmpty || best) : best;
  if (!pick) return null;
  // The caller wants a usable session, so load the chosen one in full — one file,
  // not forty.
  const loaded = loadSession(pick.meta.id || path.basename(pick.file, '.json'), storeDir);
  if (loaded) return loaded;
  // If the full load failed (corrupt), fall back to the metadata we already have
  // so the caller still gets an id/title/workspace instead of null.
  return pick.meta;
}

// Enumerate the session directory, reading each file's metadata head ONCE per
// file per process (cached). Repeated calls — listSessions then latestSession,
// or the /sessions picker — reuse the parsed metadata instead of re-opening
// every file. Entries are deleted from the cache when saveSession/deleteSession
// touches that file, and stale paths are pruned here when the directory shrinks.
// Returns [{ file, meta, hasMessages }].
function scanCached(storeDir) {
  const d = dir(storeDir);
  const map = cacheFor(storeDir);
  let names;
  try { names = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { map.clear(); return []; }
  // Prune cached paths that no longer exist on disk.
  const live = new Set(names);
  for (const p of map.keys()) if (!live.has(path.basename(p))) map.delete(p);
  // Read only the files we have not cached yet.
  const out = [];
  for (const f of names) {
    const full = path.join(d, f);
    let got = map.get(full);
    if (!got) {
      got = _readMetaOnce(full);
      if (got) map.set(full, got);
    }
    if (got) out.push({ file: full, meta: got.meta, hasMessages: got.hasMessages });
  }
  return out;
}

// Read ONLY a session's metadata (id/title/workspace/timestamps), never its
// messages — and never the whole FILE. Two costs had to go:
//   * `JSON.parse` of the entire session: listing 40 realistic sessions measured
//     528 ms, `--continue` 370 ms, to read a title and a date;
//   * even `readFileSync` of the whole file: a session with a long transcript is
//     megabytes, and pulling it into a string is itself the stall.
//
// FIX: the previous version scanned for the bare `"messages"` key and stopped,
// which is wrong in two ways:
//   1. it assumes no metadata follows messages, but saveSession USED TO append
//      `updatedAt` after `messages` (object key insertion order), so updatedAt
//      was never seen and every session sorted as 0;
//   2. it cut the head mid-key, so the JSON.parse fixup was fragile.
// Now we stop at `"messages": [` (the array VALUE), not the key, so any key
// between the metadata block and the messages array is still included.
//
// Returns null when the file is not a readable session.
const META_HEAD_BYTES = 64 * 1024;
const META_MAX_BYTES = 4 * 1024 * 1024;   // give up rather than scan a giant file

export function readSessionMeta(file) {
  const res = _readMetaOnce(file);
  return res ? res.meta : null;
}

// Metadata for `file`, plus whether it holds any message. Reads the file head
// ONE time: latestSession needs both the timestamp (to sort) and the
// non-empty rule (for --continue's skipEmpty). Doing them in two passes —
// readSessionMeta then hasMessages — opened every candidate file twice.
// Returns { meta, hasMessages } or null.
function _readMetaOnce(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(META_HEAD_BYTES);
    let text = '';
    let read = 0;
    let cut = -1;
    // Grow in chunks until the `"messages"` VALUE starts, or the cap is hit.
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, read);
      if (n <= 0) break;
      text += buf.toString('utf8', 0, n);
      read += n;
      cut = findMessagesValueStart(text);
      if (cut >= 0 || read >= META_MAX_BYTES) break;
    }
    // Non-empty check from the SAME buffered head: true when a real "role" line
    // follows the messages-array opening. Mirrors hasMessages().
    const nonEmpty = !!(cut >= 0 && /"role"/.test(text.slice(cut)));
    // Take everything BEFORE the messages array (which is the metadata block),
    // then close the truncated JSON object.
    const head = cut > 0 ? text.slice(0, cut) : text;
    try {
      // `head` ends right after `"messages":` (no value), so append `[]}` to
      // close it cleanly. Also handle the case where the array value already
      // started but the head stops elsewhere.
      const json = head.replace(/,\s*$/, '').replace(/"messages"\s*:\s*$/, '"messages": []')
        + (head.trimEnd().endsWith('{') || head.trimEnd().endsWith(',') ? '}' : '}');
      const parsed = JSON.parse(json);
      delete parsed.messages;
      return { meta: parsed, hasMessages: nonEmpty };
    } catch {
      // Fallback: parse as much of the file as we have, drop messages.
      try {
        const m = JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
        delete m.messages;
        return { meta: m, hasMessages: nonEmpty };
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Locate the index of the character right after `"messages"` (whitespace and
// the `:` included) so the metadata head can be closed with `"messages": []}`.
// Returns -1 when the key is not present in `text`.
function findMessagesValueStart(text) {
  const key = text.indexOf('"messages"');
  if (key < 0) return -1;
  let i = key + '"messages"'.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === ':') i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;   // may point at `[` (or be end-of-text; caller handles both)
}

// Non-empty detection now lives in _readMetaOnce (it reads the file head once
// for both the metadata and the emptiness rule), so the old separate
// hasMessages() scan is gone — latestSession no longer reopens each candidate.

// The session list for the /sessions picker. Metadata only — see readSessionMeta
// for why. Entries carry no `messages`, which every caller already treats as
// "not loaded yet".
export function listSessions(storeDir) {
  const out = [];
  for (const { meta } of scanCached(storeDir)) {
    // FIX: fall back to createdAt so a legacy session written with a
    // post-messages updatedAt still sorts reasonably instead of as 0.
    if (!meta.updatedAt && meta.createdAt) meta.updatedAt = meta.createdAt;
    out.push(meta);
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export function deleteSession(id, storeDir) {
  // Drop the cached entry if present (before unlink, so the path is known).
  try { cacheFor(storeDir, false)?.delete(sessionFile(id, storeDir)); } catch {}
  try { fs.unlinkSync(sessionFile(id, storeDir)); return true; } catch { return false; }
}