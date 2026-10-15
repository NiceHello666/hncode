// The mailbox: one inbox file per member, addressed by name.
//
//   ~/.hncode/teams/<team>/inboxes/<name>.json   ->  TeammateMessage[]
//
// WHY A FILE PER RECIPIENT
// ------------------------
// A single shared log would need every reader to track its own watermark, and a member that
// restarts would re-read everything it had already seen. Per-recipient files make "what is
// waiting for me" a plain read, and marking read is a write to your own file only — no member
// contends with another over the same one.
//
// WRITES ARE ATOMIC
// -----------------
// Write to a temp file, then rename. `rename` is atomic on every platform we run on, so a
// reader either sees the whole previous inbox or the whole new one — never a half-written JSON
// that parses as nothing and silently drops the mail. This also covers the cross-process case
// (two hncode sessions in the same team), where an in-process mutex would not.
import fs from 'node:fs';
import path from 'node:path';
import { inboxDir, inboxPath } from './store.js';

/**
 * A message as it sits in an inbox.
 *
 * `read` lives on the message rather than in a separate watermark file: it travels with the
 * message when the inbox is rewritten, and a member reading its own inbox is the only writer.
 */
export const MAX_INBOX = 500;

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* the tmp is worthless now */ }
    throw e;
  }
}

/** Every message in a member's inbox, oldest first. Never throws. */
export function readMailbox(teamName, agentName) {
  try {
    const parsed = JSON.parse(fs.readFileSync(inboxPath(teamName, agentName), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Only what the recipient has not seen. */
export function readUnread(teamName, agentName) {
  return readMailbox(teamName, agentName).filter((m) => !m.read);
}

/**
 * Deliver a message.
 *
 * The sender's name and colour are stamped here rather than passed by the call site, so every
 * message carries them whether it came from the lead, a teammate, or a future caller.
 */
export function writeToMailbox(teamName, recipientName, { from, text, summary, color }) {
  const file = inboxPath(teamName, recipientName);
  const box = readMailbox(teamName, recipientName);
  const msg = {
    from: String(from || 'unknown'),
    text: String(text == null ? '' : text),
    timestamp: new Date().toISOString(),
    read: false,
  };
  if (summary) msg.summary = String(summary);
  if (color) msg.color = String(color);
  box.push(msg);
  // Bounded: an inbox nobody drains must not grow without limit and turn every read into a
  // parse of the whole session's chatter.
  const kept = box.length > MAX_INBOX ? box.slice(box.length - MAX_INBOX) : box;
  writeAtomic(file, JSON.stringify(kept, null, 2));
  return msg;
}

/**
 * Mark the given messages read. Returns how many changed.
 *
 * `ids` are timestamps, not array positions: the box is re-read here, and a message
 * delivered in between would shift every later index — marking by position would then
 * silence the wrong message, or one that was never delivered at all.
 *
 * When called with no `ids` every message is marked, which is what a caller that
 * genuinely drained the whole box wants. A caller that PROCESSED a specific batch must
 * pass it: blanket-marking re-reads the box and marks whatever arrived since the
 * batch was taken, and those messages are then never delivered.
 */
export function markAllRead(teamName, agentName, ids = null) {
  const box = readMailbox(teamName, agentName);
  const want = Array.isArray(ids) ? new Set(ids.map((m) => (m && m.timestamp) || m)) : null;
  let n = 0;
  for (const m of box) {
    if (m.read) continue;
    if (want && !want.has(m.timestamp)) continue;
    m.read = true;
    n++;
  }
  if (n) writeAtomic(inboxPath(teamName, agentName), JSON.stringify(box, null, 2));
  return n;
}

/** Empty a member's inbox. Used when a teammate is removed from the team. */
export function clearMailbox(teamName, agentName) {
  try { fs.unlinkSync(inboxPath(teamName, agentName)); return true; } catch { return false; }
}

/**
 * Render unread mail the way a member should see it: as an addressable block, not as prose.
 *
 * The `from` line matters — a teammate's next action is often "reply to whoever asked", and a
 * block of text with no name attached leaves it guessing.
 */
export function formatInbox(messages) {
  if (!messages.length) return '';
  const out = [];
  for (const m of messages) {
    out.push(`[message from ${m.from}]`);
    if (m.summary) out.push(`(${m.summary})`);
    out.push(m.text);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** Every inbox file for a team, so the rota can be cleaned with the team. */
export function listInboxes(teamName) {
  try {
    return fs.readdirSync(inboxDir(teamName)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}
