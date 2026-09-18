// Correctness: the metadata reader must return the SAME values as a full parse,
// for every shape a real session file can take.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionMeta, listSessions, latestSession, loadSession, saveSession } from "./src/session.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hn-meta-"));
const write = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); return p; };
const full = (file) => { const o = JSON.parse(fs.readFileSync(file, "utf8")); delete o.messages; return o; };

const cases = {
  "normal.json": { id: "normal", title: "A session", workspace: "C:\\w", createdAt: 1, updatedAt: 2, messages: [{ role: "user", content: "hi" }] },
  "empty-msgs.json": { id: "empty-msgs", title: "Empty", workspace: "C:\\w", createdAt: 1, updatedAt: 3, messages: [] },
  "no-msgs-key.json": { id: "no-msgs-key", title: "Shell", workspace: "C:\\w", createdAt: 1, updatedAt: 4 },
  "after-msgs.json": { id: "after-msgs", messages: [{ role: "user", content: "x" }], title: "Late title", workspace: "C:\\w", updatedAt: 5 },
  "unicode.json": { id: "unicode", title: "中文会话 — ok", workspace: "C:\\w", createdAt: 1, updatedAt: 6, messages: [{ role: "user", content: "你好" }] },
  "big.json": { id: "big", title: "Big", workspace: "C:\\w", createdAt: 1, updatedAt: 7, messages: Array.from({ length: 4000 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: "x".repeat(500) })) },
};

let bad = 0;
for (const [name, obj] of Object.entries(cases)) {
  const file = write(name, obj);
  const got = readSessionMeta(file);
  const want = full(file);
  // Compare every metadata field the callers use.
  const keys = new Set([...Object.keys(want), ...Object.keys(got || {})]);
  const diffs = [];
  for (const k of keys) {
    if (k === "messages") continue;
    if (JSON.stringify(want[k]) !== JSON.stringify(got && got[k])) diffs.push(k + ": got " + JSON.stringify(got && got[k]) + " want " + JSON.stringify(want[k]));
  }
  const ok = diffs.length === 0 && got !== null;
  if (!ok) bad++;
  console.log((ok ? "ok   " : "BAD  ") + name.padEnd(18) + " size=" + String(fs.statSync(file).size).padStart(8) + "  " + (ok ? "metadata matches a full parse" : diffs.join("; ")));
}

// A corrupt file must not throw, and must not be listed.
const corrupt = path.join(dir, "corrupt.json");
fs.writeFileSync(corrupt, "{ this is not json");
console.log((readSessionMeta(corrupt) === null ? "ok   " : "BAD  ") + "corrupt file -> null (no throw)");
if (readSessionMeta(corrupt) !== null) bad++;

// listSessions must return every valid session, newest first, with no messages.
const list = listSessions(dir);
const ids = list.map((s) => s.id).filter(Boolean);
console.log("");
console.log("listSessions -> " + list.length + " entries: " + ids.join(", "));
console.log("  sorted newest first    : " + (list.every((s, i) => i === 0 || (list[i - 1].updatedAt || 0) >= (s.updatedAt || 0))));
console.log("  no messages leaked     : " + list.every((s) => s.messages === undefined));
console.log("  corrupt file excluded  : " + !ids.includes("corrupt"));
if (!list.every((s) => s.messages === undefined) || ids.includes("corrupt")) bad++;

// latestSession must still return a FULL session (messages included) for resume.
const latest = latestSession("C:\\w", dir, { skipEmpty: true });
console.log("");
console.log("latestSession (skipEmpty) -> " + (latest && latest.id));
console.log("  is a full session      : " + !!(latest && Array.isArray(latest.messages)));
console.log("  skipped the empty ones : " + (latest && latest.id !== "empty-msgs" && latest.id !== "no-msgs-key"));
if (!latest || !Array.isArray(latest.messages)) bad++;
if (latest.id === "empty-msgs") bad++;

fs.rmSync(dir, { recursive: true, force: true });
console.log("");
console.log(bad ? bad + " wrong" : "metadata reader matches a full parse on every shape");
