// Session store. Sessions persist under ~/.hncode/sessions/<id>.json.
// A session records: id, title, cwd (workspace), model, createdAt, updatedAt,
// and the message list (canonical, same shape the agent loop uses).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DEFAULT_DIR = () => path.join(os.homedir(), '.hncode', 'sessions');
function dir(custom) { return custom || process.env.HNCODE_SESSIONS_DIR || DEFAULT_DIR(); }

export function newId() {
  // compact, mostly-sorted id (like a timestamp+rand ULID-ish)
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function sessionFile(id, storeDir) {
  return path.join(dir(storeDir), `${id}.json`);
}

export function saveSession(session, storeDir) {
  session.updatedAt = Date.now();
  fs.mkdirSync(dir(storeDir), { recursive: true });
  const tmp = sessionFile(session.id, storeDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, sessionFile(session.id, storeDir));
  return session;
}

export function loadSession(id, storeDir) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id, storeDir), 'utf8')); }
  catch { return null; }
}

// Most recent session for a workspace, or globally.
// `opts.skipEmpty` ignores sessions with no messages: hncode creates an empty
// session shell on every launch, so without this `--continue` would "resume"
// a brand-new empty session instead of the user's last real conversation.
export function latestSession(cwd, storeDir, opts = {}) {
  const d = dir(storeDir);
  let files;
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { return null; }
  let best = null;
  let bestEmpty = null;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      if (cwd !== undefined && s.workspace !== path.resolve(cwd)) continue;
      if (!best || s.updatedAt > best.updatedAt) best = s;
      const hasMsgs = Array.isArray(s.messages) && s.messages.length > 0;
      if (hasMsgs && (!bestEmpty || s.updatedAt > bestEmpty.updatedAt)) bestEmpty = s;
    } catch {}
  }
  if (opts.skipEmpty) return bestEmpty || best;
  return best;
}

export function listSessions(storeDir) {
  const d = dir(storeDir);
  let files;
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch {}
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export function deleteSession(id, storeDir) {
  try { fs.unlinkSync(sessionFile(id, storeDir)); return true; } catch { return false; }
}