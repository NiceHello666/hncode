// Tool-result size control.
//
// Two separate problems, both of which used to be silent:
//
//   1. A SINGLE huge result. Per-tool caps exist (`MAX_OUTPUT_BYTES` in
//      tools/utils.js) but `Read` deliberately has none, and nothing bounded the
//      AGGREGATE of a step's results — a turn with four Reads could add half a
//      megabyte to a history that is then resent on every later request. Real
//      sessions in ~/.hncode/sessions reached 5 MB this way.
//   2. OLD results that no longer matter. A file read forty turns ago is dead
//      weight, but the whole history is resent every request, so it is paid for
//      again and again until something compacts.
//
// The cap is applied where the result is BUILT (see `shapeToolResult`), and the
// overflow is kept, not lost: it goes to a file under the session's own
// directory and the model gets a bounded preview plus the path, so it can Read
// the rest if it turns out to need it. This mirrors Claude Code's
// `<persisted-output>` handling (src/utils/toolResultStorage.ts).
//
// The ages pass (stale-pass) is the cheap half of compaction: it clears the
// BODY of old tool results while leaving the message — and therefore the
// assistant/tool pairing and the exact prefix length — untouched, so it does not
// disturb the message list shape the provider has already cached. Claude Code
// does the same thing in microCompact.ts ("[Old tool result content cleared]").

import fs from 'node:fs';
import path from 'node:path';

// Bytes of a single tool result that are kept inline. Above this the overflow is
// written to disk. 50 KB is Claude Code's DEFAULT_MAX_RESULT_SIZE_CHARS and is
// comfortably more than a whole source file's worth of lines.
export const MAX_RESULT_BYTES = 50 * 1024;

// Bytes of a spilled result that stay in the transcript as a preview.
export const PREVIEW_BYTES = 2 * 1024;

// Trigger ratio: trim once the request reaches this fraction of the model window.
// 50% by default (`trim_threshold` / HNCODE_TRIM_THRESHOLD). Well below the
// compaction trigger on purpose — this is the cheap pass that keeps the history
// from ever getting near compaction in the first place.
export const DEFAULT_TRIM_THRESHOLD = 0.5;

// Fraction of the tool-result TEXT that survives a trim. 30% by default
// (`trim_keep_ratio` / HNCODE_TRIM_KEEP_RATIO), i.e. the rest is elided. Measured
// against the tool-result text only, not the whole request, so a trim never eats
// the conversation itself.
export const DEFAULT_TRIM_KEEP_RATIO = 0.3;

// A tool result shorter than this is never worth eliding: the marker plus the
// pointer would cost more than the text it replaces.
export const MIN_TRIM_BYTES = 512;

export const CLEARED_MARKER = '[Old tool result content cleared]';
export const PERSISTED_TAG = 'persisted-output';

// Directory for spilled results, beside the session file so it is cleaned up
// with the session rather than accumulating in a temp dir.
export function spillDir(sessionId) {
  const root = process.env.HNCODE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.hncode');
  return path.join(root, 'tool-results', String(sessionId || 'unscoped'));
}

// Write `text` to disk and return the preview + path, or null when the write
// fails (a read-only disk must not fail the tool call).
export function spillResult(sessionId, toolCallId, text) {
  try {
    const dir = spillDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    // The tool-call id is already a unique, filesystem-safe token from the
    // provider, so it needs no sanitizing beyond dropping path separators.
    const safe = String(toolCallId || 'result').replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(dir, `${safe}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return { file, preview: previewOf(text, PREVIEW_BYTES), originalBytes: Buffer.byteLength(text, 'utf8') };
  } catch {
    return null;
  }
}

// A preview cut on a line boundary when one is close enough, so the model does
// not receive half a line of code as its last visible detail.
export function previewOf(text, maxBytes) {
  const s = String(text == null ? '' : text);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let cut = Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  const nl = cut.lastIndexOf('\n');
  if (nl > maxBytes * 0.5) cut = cut.slice(0, nl);
  return cut;
}

// The message the model sees in place of an oversized result. It says what
// happened, how big it was, where the rest is, and how to get it — an agent that
// cannot tell why its output is missing retries the same call forever.
export function spillNotice(spilled) {
  return [
    `Output too large (${fmtBytes(spilled.originalBytes)}). Full output saved to: ${spilled.file}`,
    '',
    `Preview (first ${fmtBytes(PREVIEW_BYTES)}):`,
    spilled.preview,
    '',
    `Read the file above to see the rest — use line_offset / n_lines to page through it.`,
  ].join('\n');
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Shape ONE tool result for the model: pass small results through, spill big
// ones. Returns { content, spilled } where `content` is what goes into the
// message. `sessionId`/`toolCallId` identify the spill file.
export function shapeToolResult(content, { sessionId, toolCallId, maxBytes = MAX_RESULT_BYTES } = {}) {
  if (typeof content !== 'string') return { content, spilled: false };
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { content, spilled: false };
  const spilled = spillResult(sessionId, toolCallId, content);
  // The write failed: a normal-sized preview is still better than megabytes, and
  // the notice must not claim a path that does not exist.
  if (!spilled) {
    return {
      content: `${previewOf(content, PREVIEW_BYTES)}\n\n[Output truncated: ${fmtBytes(Buffer.byteLength(content, 'utf8'))} total; the full output could not be saved.]`,
      spilled: false,
    };
  }
  return { content: spillNotice(spilled), spilled: true };
}

// Which tool results to elide, and by how much.
//
// RULE (the user's): keep a FRACTION of the tool-result text, the newest part.
// Walk the results from newest to oldest accumulating their size; once the total
// kept exceeds `keepRatio` of ALL tool-result text, everything older is elided.
//
// Walking newest-first is what makes this behave the way a person expects: the
// results you were just working from are the ones that survive, and the material
// from twenty turns ago goes first.
//
// Returns { keep: [indices], elide: [indices], totalBytes, keepBytes, elideBytes }.
// `mustKeep` (an index) is never elided — the tool result belonging to the step
// currently in flight, if the caller knows it.
export function planTrim(messages, keepRatio, mustKeep) {
  const empty = { keep: [], elide: [], totalBytes: 0, keepBytes: 0, elideBytes: 0 };
  if (!Array.isArray(messages)) return empty;
  const ratio = Number.isFinite(keepRatio) ? Math.min(Math.max(keepRatio, 0), 1) : DEFAULT_TRIM_KEEP_RATIO;

  // Only string-bodied results can be elided; a media result carries content
  // blocks and clearing it would delete the image itself.
  const candidates = [];
  let totalBytes = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'tool') continue;
    if (typeof m.content !== 'string') continue;
    totalBytes += m.content.length;
    if (m.content === CLEARED_MARKER) continue;
    if (m.content.length < MIN_TRIM_BYTES) continue;
    candidates.push(i);
  }
  if (!candidates.length) return { ...empty, totalBytes };

  // A budget of 0 means "elide everything eligible"; a budget of 1 means "keep it
  // all", in which case we still elide the already-marked ones so a repeated call
  // is a no-op rather than a growing patch.
  const budget = totalBytes * ratio;
  const keep = new Set();
  let keepBytes = 0;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const i = candidates[k];
    if (i === mustKeep) { keep.add(i); keepBytes += messages[i].content.length; continue; }
    const size = messages[i].content.length;
    // Keep this chunk if we are still under budget, but ALWAYS keep the single
    // newest result: a trim that elides the output the model is currently reading
    // is how a working turn turns into a confused one.
    if (keepBytes + size <= budget || keep.size === 0) {
      keep.add(i);
      keepBytes += size;
    }
  }

  const elide = [];
  let elideBytes = 0;
  for (const i of candidates) {
    if (keep.has(i)) continue;
    elide.push(i);
    elideBytes += messages[i].content.length;
  }
  return { keep: [...keep].sort((a, b) => a - b), elide, totalBytes, keepBytes, elideBytes };
}

// Apply a trim to `messages` IN PLACE, replacing each elided result with a short
// pointer to the text on disk.
//
// Two properties matter here and both are deliberate:
//
//   * The message COUNT and every message's role stay identical. The provider's
//     prompt cache is keyed on the prefix, and a message list that changes SHAPE
//     invalidates it — replacing bodies keeps the shape.
//
//   * The full text is written to disk first (spillDir), so an elided result is
//     RECOVERABLE: the model reads the pointer and pages through the file. That is
//     what makes "elided" different from "deleted" — the point the user raised
//     about trimming eating their work.
//
// `sessionId`/`messages` identify where the copies go. Returns
// { elided, elidedBytes, kept, keptBytes }.
export function applyTrim(messages, plan, sessionId) {
  const out = { elided: 0, elidedBytes: 0, kept: plan.keep.length, keptBytes: plan.keepBytes };
  if (!Array.isArray(messages) || !plan.elide.length) return out;
  for (const i of plan.elide) {
    const m = messages[i];
    const original = m.content;
    // Copy it out BEFORE overwriting: this is the whole difference between a trim
    // and a loss. If the write fails we still elide, but the pointer says so.
    const spilled = spillResult(sessionId, `trim-${m.toolCallId || i}`, original);
    const tool = m.name || 'tool';
    m.content = spilled
      ? `[Output elided to save context — ${fmtBytes(original.length)} from ${tool}.\n`
        + `Full text saved to: ${spilled.file}\n`
        + `Read that file (with line_offset/n_lines) if you need this output again.]`
      : `[Output elided to save context — ${fmtBytes(original.length)} from ${tool}; the full text could not be saved.]`;
    out.elided++;
    out.elidedBytes += original.length;
  }
  return out;
}

// Convenience: plan + apply in one go. Returns null when nothing needed trimming,
// so a caller can skip its UI event entirely.
export function trimToolResults(messages, opts = {}) {
  const plan = planTrim(messages, opts.keepRatio, opts.mustKeep);
  if (!plan.elide.length) return null;
  return { ...applyTrim(messages, plan, opts.sessionId), plan };
}
