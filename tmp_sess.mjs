// Session listing cost. `listSessions` JSON.parses EVERY file in full — including
// the whole message history — just to render a picker title and date.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sess from "./src/session.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hn-sess-"));
// Synthesize a realistic history: 40 sessions, some with long transcripts.
const msg = (i) => ({ role: i % 3 === 0 ? "user" : "assistant", content: "x".repeat(4000) });
let total = 0;
for (let i = 0; i < 40; i++) {
  const messages = Array.from({ length: 50 + i * 20 }, (_, k) => msg(k));
  const s = {
    id: "sess" + i, title: "session " + i, workspace: process.cwd(),
    createdAt: Date.now() - i * 86400000, updatedAt: Date.now() - i * 3600000,
    messages,
  };
  const j = JSON.stringify(s, null, 2);
  total += Buffer.byteLength(j);
  fs.writeFileSync(path.join(dir, "sess" + i + ".json"), j);
}
console.log("40 sessions, " + (total / 1048576).toFixed(1) + " MB on disk total");
console.log("");

const t = (label, fn, iters = 3) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  console.log("  " + label.padEnd(40) + ms.toFixed(1).padStart(8) + " ms" + (ms > 100 ? "   <-- FREEZE" : ms > 16 ? "   <-- hitch" : ""));
  return ms;
};

t("listSessions (the /sessions picker)", () => sess.listSessions(dir), 2);
t("latestSession (--continue)", () => sess.latestSession(process.cwd(), dir, { skipEmpty: true }), 2);
t("loadSession (one file, the resume path)", () => sess.loadSession("sess0", dir), 5);

fs.rmSync(dir, { recursive: true, force: true });
