// Edit tool — mirrors the hncode Edit tool schema & behavior.
// Snippet-based exact replacement (old_string -> new_string), NOT a whole-file rewrite,
// so edits stay token-cheap (unlike kimi-code-cli's whole-file Edit).

import fs from 'node:fs';
import { resolvePath, ensureDir } from './utils.js';
import { hashStr, normalizeText } from './read.js';

// Hash the <start..end> 1-based line slice of an already-normalized line array.
function hashLines(lines, start, end) {
  return hashStr((lines.slice(start - 1, end) || []).join('\n'));
}

export const spec = {
  name: 'Edit',
  description: 'Replace an exact substring (old_string) with new_string. Fails if old_string is missing or ambiguous (unless replace_all).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace, including whitespace and newlines. Omit when using start_line/end_line.' },
      new_string: { type: 'string', description: 'Replacement text for old_string.' },
      replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string.' },
      start_line: { type: 'integer', minimum: 1, description: '1-based first line to replace (requires end_line and new_content).' },
      end_line: { type: 'integer', minimum: 1, description: '1-based last line to replace (inclusive; requires start_line).' },
      new_content: { type: 'string', description: 'Replacement text for the line range [start_line, end_line]. Requires start_line and end_line.' },
    },
    // Either exact-substring mode (old_string+new_string) OR line-range mode.
    anyOf: [
      { required: ['path', 'old_string', 'new_string'] },
      { required: ['path', 'start_line', 'end_line', 'new_content'] },
    ],
  },
  async execute(args, ctx) {
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch (e) { return `Error reading ${args.path}: ${e.message}`; }
    const { start_line, end_line, new_content } = args;

    // ---- LINE-RANGE mode ---------------------------------------------------
    // `start_line`..`end_line` replace the lines at those 1-based positions,
    // with NO old_string involved at all. This is the path for "change line 12"
    // where spelling out the exact current text is awkward. It is fully
    // self-contained: validate -> check the Read cache -> splice -> write ->
    // refresh the cache -> return.
    if (start_line != null && end_line != null) {
      const start = Number(start_line) | 0, end = Number(end_line) | 0;
      if (start < 1 || end < start) {
        return `Error: invalid line range ${start_line}-${end_line} (expected 1-based, start <= end).`;
      }
      const eol = content.includes('\r\n') ? '\r\n' : '\n';
      const lines = content.split(/\r\n|\r|\n/);
      if (end > lines.length) {
        return `Error: end_line ${end_line} exceeds file length (${lines.length} lines).`;
      }
      // STALENESS: the range must sit inside a region this turn actually Read and
      // that still matches. Same guarantee as the substring path, checked here
      // directly (no old_string to search for).
      const stale = checkStaleRange(p, lines, start, end, ctx);
      if (stale) return stale;

      const inserted = normalizeText(new_content).split('\n');
      // The lines being REPLACED, captured before the splice. The TUI renders an
      // Edit's diff from the tool ARGUMENTS, and line-range mode has no
      // `old_string` to diff against — so without reporting them here the edit
      // drew NO diff at all (no +/- rows, no +N/-N counts). Reporting them lets
      // the caller diff `old_content` -> `new_content`.
      const replacedText = lines.slice(start - 1, end).join('\n');
      const out = [...lines.slice(0, start - 1), ...inserted, ...lines.slice(end)];
      const normUpdated = out.join('\n');
      const updated = eol === '\r\n' ? normUpdated.split('\n').join('\r\n') : normUpdated;
      try {
        ensureDir(p);
        fs.writeFileSync(p, updated, 'utf8');
      } catch (e) { return `Error writing ${args.path}: ${e.message}`; }
      refreshReadPool(p, normUpdated, { start, end: start + inserted.length - 1 }, ctx);
      const removed = end - start + 1;
      // Publish the diff for the UI. The Edit line is drawn from these, so a
      // line-range edit shows the same +/- rows and +N/-N counts as a substring
      // edit instead of nothing. `ctx.lastEditDiff` is consumed (and cleared) by
      // the agent loop right after this tool returns.
      if (ctx) ctx.lastEditDiff = { old: replacedText, new: normalizeText(new_content), startLine: start };
      return `Edited ${args.path}: replaced lines ${start}-${end} (${removed} line${removed === 1 ? '' : 's'}) with ${inserted.length} line${inserted.length === 1 ? '' : 's'}.`;
    }


    // ---- SUBSTRING mode (old_string -> new_string) --------------------------
    let { old_string, new_string, replace_all = false } = args;
    if (old_string === '' || old_string == null) return `Error: old_string must not be empty.`;

    // --- Newline normalization (Windows CRLF) ---
    // The Read tool normalizes \r\n -> \n, so an agent builds old_string/new_string
    // with LF. But the file on disk may be CRLF, making a raw LF match fail. We
    // normalize the FILE content to LF for matching, then restore the file's own
    // line ending style when writing back, so we never corrupt or mix endings.
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normContent = content.split(/\r\n|\r|\n/).join('\n');
    const normOld = normalizeText(old_string);
    const normNew = normalizeText(new_string);

    const count = normContent.split(normOld).length - 1;
    if (count === 0) return `Error: old_string not found in ${args.path}.`;
    if (count > 1 && !replace_all) {
      return `Error: old_string matched ${count} occurrences in ${args.path}. Use replace_all=true or make old_string unique.`;
    }

    // --- Staleness guard: the AI must edit against content it actually Read.
    // We stored per-region + whole-file hashes in ctx.readPool when Read ran.
    // If the file changed on disk since (external edit, stream, Ctrl-C side
    // effect), reject so a snippet edit cannot silently corrupt the file. ---
    const stale = checkStale(p, normContent, normOld, ctx);
    if (stale) return stale;

    const normUpdated = replace_all
      ? normContent.replaceAll(normOld, normNew)
      : normContent.replace(normOld, normNew);
    const updated = eol === '\r\n' ? normUpdated.split('\n').join('\r\n') : normUpdated;
    try {
      ensureDir(p);
      fs.writeFileSync(p, updated, 'utf8');
    } catch (e) { return `Error writing ${args.path}: ${e.message}`; }
    // Silently re-arm the Read snapshot for the edited region so the AI can keep
    // editing on top of its own change WITHOUT another Read: we recompute the
    // affected line range + hash from the NEW content and refresh the pool. We
    // also drop any previously-recorded region whose content no longer matches
    // (those are genuinely stale now). Nothing here is told to the model.
    if (ctx && ctx.readPool) {
      const entry = ctx.readPool.get(p);
      if (entry) {
        const newLines = normUpdated.split('\n');
        entry.fileHash = hashStr(normUpdated);
        entry.lines = newLines.length;
        // Locate the edit site in the NEW content: the first line of the new
        // text if present, else fall back to the old target's location.
        const anchor = String(normNew).split('\n')[0];
        let at = newLines.indexOf(anchor);
        if (at < 0) at = newLines.indexOf(String(normOld).split('\n')[0]);
        if (at >= 0) {
          const newSpan = String(normNew).split('\n').length;
          const start = at + 1;
          const end = Math.min(newLines.length, at + Math.max(1, newSpan));
          // Re-hash every surviving old region against the new content, and add
          // the freshly-edited span. Regions that no longer match are dropped.
          const kept = entry.regions.filter((r) => hashLines(newLines, r.start, r.end) === r.hash);
          kept.push({ start, end, hash: hashLines(newLines, start, end) });
          entry.regions = kept;
        } else {
          // Could not locate the site: drop stale regions so nothing false stays.
          entry.regions = entry.regions.filter((r) => hashLines(newLines, r.start, r.end) === r.hash);
        }
        try { const st = fs.statSync(p); entry.size = st.size; entry.mtimeMs = st.mtimeMs; } catch {}
      }
    }
    const occurrences = replace_all ? count : 1;
    // Publish the diff for the UI (same contract as the line-range path above).
    if (ctx) {
      const startLine = (() => {
        const at = normContent.split('\n').indexOf(String(normOld).split('\n')[0]);
        return at >= 0 ? at + 1 : 1;
      })();
      ctx.lastEditDiff = { old: normalizeText(old_string), new: normalizeText(new_string), startLine };
    }
    return `Edited ${args.path}: replaced ${occurrences} occurrence(s).`;
  },
};

// Returns an error message when the edit is stale, else null (safe to edit).

// Returns an error message when the edit is stale, else null (safe to edit).
function checkStale(p, normContent, normOld, ctx) {
  if (!ctx || !ctx.readPool) return null; // no Read happened; nothing to verify
  const entry = ctx.readPool.get(p);
  if (!entry) return null; // this file was never Read this turn; allow

  const curLines = normContent.split('\n');
  const curFileHash = hashStr(normContent);

  // Locate the edit target's first line in the CURRENT file (1-based).
  const firstLine = String(normOld).split('\n')[0];
  const idx = curLines.indexOf(firstLine);
  const editLine = idx >= 0 ? idx + 1 : -1;

  // (1) The edit target must sit inside a region the AI actually Read, and that
  //     region's content must still match what was Read. Reading the WHOLE file
  //     records a region covering every line, so this also covers "read full,
  //     edit a part". This is what rejects "read lines 1-3, edit line 7".
  if (editLine > 0) {
    const coveredByIntactRegion = entry.regions.some(
      (r) => editLine >= r.start && editLine <= r.end && hashLines(curLines, r.start, r.end) === r.hash,
    );
    if (coveredByIntactRegion) return null;
  }

  // (2) Whole file unchanged since Read, but the edit target was never Read
  //     (no region covers it). Tell the AI to read the target lines first.
  if (curFileHash === entry.fileHash) {
    const ranges = entry.regions.map((r) => `${r.start}-${r.end}`).join(', ') || 'none';
    return `Edit rejected: you have not read the lines you are editing in ${p}. Read the target lines first (Read with line_offset / n_lines), then Edit.`;
  }

  // (3) The file changed on disk since it was Read and the edit target is not in
  //     an intact Read region. Reject so a stale snippet cannot corrupt the file.
  return `Edit rejected: ${p} changed since it was Read (the edited region is not in an intact Read snapshot). Re-run Read to get the current content, then Edit.`;
}
// ---- helpers for the line-range path ---------------------------------------

// Same guarantee as checkStale, but for an explicit [start, end] line range:
// every line in the range must sit inside a region that was Read this turn and
// whose content still matches. Returns an error string, or null when safe.
function checkStaleRange(p, curLines, start, end, ctx) {
  if (!ctx || !ctx.readPool) return null; // no Read happened; nothing to verify
  const entry = ctx.readPool.get(p);
  if (!entry) return null;                // never Read this turn; allow

  const normContent = curLines.join('\n');
  const curFileHash = hashStr(normContent);

  // A region covers the range when it fully contains it AND still hashes the
  // same as when it was Read.
  const covered = entry.regions.some(
    (r) => start >= r.start && end <= r.end && hashLines(curLines, r.start, r.end) === r.hash,
  );
  if (covered) return null;

  if (curFileHash === entry.fileHash) {
    // No "(read so far: …)" listing: the range is what the model must act on, and
    // echoing the regions it HAS read only invited it to reason about them instead
    // of re-reading the target lines.
    return `Edit rejected: lines ${start}-${end} were not read in ${p}. Read the target lines first (Read with line_offset / n_lines), then Edit.`;
  }
  return `Edit rejected: ${p} changed since it was Read (lines ${start}-${end} are not in an intact Read snapshot). Re-run Read to get the current content, then Edit.`;
}

// Refresh the region cache after a successful edit: drop regions that no longer
// match the NEW content, and record the freshly-written span. Mirrors the
// re-arm block used by the substring path.
function refreshReadPool(p, normUpdated, written, ctx) {
  if (!ctx || !ctx.readPool) return;
  const entry = ctx.readPool.get(p);
  if (!entry) return;
  const newLines = normUpdated.split('\n');
  entry.fileHash = hashStr(normUpdated);
  entry.lines = newLines.length;
  const kept = entry.regions.filter((r) => hashLines(newLines, r.start, r.end) === r.hash);
  kept.push({ start: written.start, end: Math.min(newLines.length, Math.max(written.start, written.end)), hash: hashLines(newLines, written.start, Math.min(newLines.length, Math.max(written.start, written.end))) });
  entry.regions = kept;
  try { const st = fs.statSync(p); entry.size = st.size; entry.mtimeMs = st.mtimeMs; } catch {}
}
