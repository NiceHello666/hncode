// Edit tool — mirrors the hncode Edit tool schema & behavior.
// Snippet-based exact replacement (old_string -> new_string), NOT a whole-file rewrite,
// so edits stay token-cheap (unlike kimi-code-cli's whole-file Edit).

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, ensureDir, checkpointBeforeWrite } from './utils.js';
import { hashStr, normalizeText } from './read.js';

// Typographic quotes -> straight quotes. A model almost always emits ASCII
// quotes, but docs/blog/markdown often use curly ones; without this the edit
// fails with "old_string not found" even though the text is visibly there.
// Mirrors Claude Code's normalizeQuotes.
const CURLY = [
  ['\u2018', "'"], ['\u2019', "'"],   // ‘ ’
  ['\u201c', '"'], ['\u201d', '"'],   // “ ”
];
export function normalizeQuotes(s) {
  let out = String(s);
  for (const [from, to] of CURLY) out = out.split(from).join(to);
  return out;
}

// Re-exported from read.js so the staleness guard has ONE definition of the
// region hash. Previously read.js and edit.js each had their own copy; any
// drift between them would silently disable staleness detection.
import { hashRegion as hashLines } from './read.js';

export const spec = {
  name: 'Edit',
  description: 'Edit a file. THE TWO MODES ARE MUTUALLY EXCLUSIVE — NEVER combine them:\n  - LINE-RANGE mode: path + start_line + end_line + new_string. Replaces lines [start_line, end_line] with new_string. PRESERVE the exact indentation (spaces/tabs) of the lines you are replacing — copy it straight from the Read output, after its line-number prefix. PREFERRED — use it whenever you have Read the file and know the line numbers.\n  - EXACT-SUBSTRING mode: path + old_string + new_string. Replaces text exactly matching old_string. Use ONLY when the exact text is known and a line range is not convenient.\nDo NOT pass start_line/end_line together with old_string/new_string in one call, and do NOT pass any of these four keys when you are not using that mode. Omitting new_string is an error, not an empty replacement (in line-range mode pass new_string; in substring mode pass old_string + new_string).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace, including whitespace and newlines. Omit when using start_line/end_line.' },
      new_string: { type: 'string', description: 'Replacement text. In SUBSTRING mode it replaces old_string. In LINE-RANGE mode it replaces lines [start_line, end_line]. In line-range mode PRESERVE the exact leading whitespace (indentation) from Read output; copy it exactly as it appears after the line-number prefix.' },
      replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string.' },
      start_line: { type: 'integer', minimum: 1, description: 'PREFERRED MODE. 1-based first line to replace (requires end_line and new_string). Use this line-range mode first.' },
      end_line: { type: 'integer', minimum: 1, description: 'PREFERRED MODE. 1-based last line to replace (inclusive; requires start_line).' },
    },
    // Either line-range mode (start_line+end_line+new_string) OR exact-substring
    // mode (old_string+new_string).
    // Line-range is the preferred route.
    anyOf: [
      { required: ['path', 'start_line', 'end_line', 'new_string'] },
      { required: ['path', 'old_string', 'new_string'] },
    ],
  },
  async execute(args, ctx) {
    // Validate BEFORE resolving the path. `resolvePath(undefined)` resolves to the
    // workspace root rather than failing, so a truncated tool call (agent.js falls
    // back to `{ raw, _rawLen }` when the streamed JSON will not parse) could
    // target a DIRECTORY and produce a confusing EISDIR/ENOENT instead of "retry
    // the call".
    if (typeof args.path !== 'string' || !args.path.trim()) {
      const truncated = args && args.raw
        ? ` The arguments did not parse as JSON${args._rawLen ? ` (${args._rawLen} characters received)` : ''} — the call was most likely truncated. Retry, and keep \`old_string\` / \`new_string\` small (edit in several passes rather than one large replacement).`
        : '';
      return `Error: \`path\` is required and must be a non-empty string.${truncated}`;
    }
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    // A Jupyter notebook is JSON, not text: a snippet edit corrupts it. Point the
    // model at the notebook-aware path instead (mirrors Claude Code errorCode 5).
    if (String(p).toLowerCase().endsWith('.ipynb')) {
      return `Error: ${args.path} is a Jupyter notebook. Its .ipynb is JSON — edit the cells through a notebook-aware tool (or edit the JSON carefully), not a plain text Edit.`;
    }
    let content;
    try {
      content = fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return `Error reading ${args.path}: file does not exist.${similarFileHint(p)}`;
      }
      return `Error reading ${args.path}: ${e.message}`;
    }
    const { start_line, end_line } = args;
    // The two modes are MUTUALLY EXCLUSIVE: sending line-range AND substring
    // parameters together is ambiguous — reject it rather than guessing which
    // one the caller meant. Only one family may be present in `args`.
    const hasRangeKeys = args.start_line != null || args.end_line != null;
    const hasSubKeys = args.old_string != null;
    if (hasRangeKeys && hasSubKeys) {
      return `Error: do not mix line-range mode and substring mode. Use EITHER (start_line/end_line/new_string) OR (old_string/new_string), never both.`;
    }

    // ---- LINE-RANGE mode ---------------------------------------------------
    // `start_line`..`end_line` replace the lines at those 1-based positions,
    // with NO old_string involved at all. This is the path for "change line 12"
    // where spelling out the exact current text is awkward. It is fully
    // self-contained: validate -> check the Read cache -> splice -> write ->
    // refresh the cache -> return.
    // ONE bound without the other is its own mistake and an easy one to make: the
    // call then falls past this block and reports a missing old_string, which
    // sends the model looking in the wrong place.
    if ((start_line != null) !== (end_line != null)) {
      return 'Error: line-range mode needs BOTH start_line and end_line.';
    }
    if (start_line != null && end_line != null) {
      // Accept both spellings so old new_content callers keep working.
      const new_string = args.new_string != null ? args.new_string : args.new_content;
      // new_string is required — a missing one would put the literal string
      // "undefined" in the file.
      if (new_string == null) return `Error: new_string is required for line-range mode (pass an empty string to delete the lines).`;
      if (typeof new_string !== 'string') {
        return `Error: new_string must be a string (got ${new_string === null ? 'null' : typeof new_string}).`;
      }
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

      const inserted = normalizeText(new_string).split('\n');
      // The lines being REPLACED, captured before the splice. The TUI renders an
      // Edit's diff from the tool ARGUMENTS, and line-range mode has no
      // `old_string` to diff against — so without reporting them here the edit
      // drew NO diff at all (no +/- rows, no +N/-N counts). Reporting them lets
      // the caller diff the replaced region -> `new_string`.
      const replacedText = lines.slice(start - 1, end).join('\n');
      const out = [...lines.slice(0, start - 1), ...inserted, ...lines.slice(end)];
      const normUpdated = out.join('\n');
      const updated = eol === '\r\n' ? normUpdated.split('\n').join('\r\n') : normUpdated;
      // Checkpoint the pre-edit content so /undo can put it back (file-history.js).
      checkpointBeforeWrite(p, ctx);
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
      if (ctx) ctx.lastEditDiff = { old: replacedText, new: normalizeText(new_string), startLine: start };
      return `Edited ${args.path}: replaced lines ${start}-${end} (${removed} line${removed === 1 ? '' : 's'}) with ${inserted.length} line${inserted.length === 1 ? '' : 's'}.`;
    }


    // ---- SUBSTRING mode (old_string -> new_string) --------------------------
    let { old_string, new_string, replace_all = false } = args;
    // Reaching here means neither mode was usable: line-range needs
    // start_line+end_line (handled above) and substring needs old_string. When
    // BOTH are absent, say so — "old_string must not be empty" sends the model
    // hunting for a stray empty string it never sent.
    if (old_string == null && new_string == null) {
      return 'Error: no edit mode given. Pass EITHER (start_line, end_line, new_string) OR (old_string, new_string).';
    }
    if (old_string === '' || old_string == null) return `Error: old_string must not be empty.`;
    if (new_string == null) return `Error: new_string is required for substring mode.`;

    // --- Newline normalization (Windows CRLF) ---
    // The Read tool normalizes \r\n -> \n, so an agent builds old_string/new_string
    // with LF. But the file on disk may be CRLF, making a raw LF match fail. We
    // normalize the FILE content to LF for matching, then restore the file's own
    // line ending style when writing back, so we never corrupt or mix endings.
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normContent = content.split(/\r\n|\r|\n/).join('\n');
    const normOld = normalizeText(old_string);
    const normNew = normalizeText(new_string);

    let matchOld = normOld;    // the string that will actually be matched/replaced
    let matchNew = normNew;
    let count = normContent.split(matchOld).length - 1;
    if (count === 0) {
      // Quote-normalized retry: the file may use curly quotes while the model sent
      // straight ones. Match on the normalized forms, then replace the ACTUAL
      // substring found in the file so typography is preserved.
      // Quote-normalized retry: the file may use curly quotes while the model sent
      // straight ones. Match on the normalized forms, then replace the ACTUAL
      // substring found in the file so typography is preserved. normalizeQuotes is
      // 1 char -> 1 char, so indices line up between the two strings.
      const normFileQ = normalizeQuotes(normContent);
      if (normFileQ !== normContent) {
        const normOldQ = normalizeQuotes(normOld);
        const idx = normFileQ.indexOf(normOldQ);
        if (idx >= 0) {
          matchOld = normContent.slice(idx, idx + normOldQ.length);
          matchNew = normNew;   // keep the model's new_string as written
          count = normContent.split(matchOld).length - 1;
        }
      }
    }
    if (count === 0) {
      const near = nearestLineHint(normContent, normOld);
      return `Error: old_string not found in ${args.path}.${near}`;
    }
    if (count > 1 && !replace_all) {
      return `Error: old_string matched ${count} occurrences in ${args.path}. Use replace_all=true or make old_string unique.`;
    }

    // --- Staleness guard: the AI must edit against content it actually Read.
    // We stored per-region + whole-file hashes in ctx.readPool when Read ran.
    // If the file changed on disk since (external edit, stream, Ctrl-C side
    // effect), reject so a snippet edit cannot silently corrupt the file. ---
    const stale = checkStale(p, normContent, matchOld, ctx);
    if (stale) return stale;

    const normUpdated = replace_all
      ? normContent.replaceAll(matchOld, matchNew)
      : normContent.replace(matchOld, matchNew);
    const updated = eol === '\r\n' ? normUpdated.split('\n').join('\r\n') : normUpdated;
    // Checkpoint the pre-edit content so /undo can put it back (file-history.js).
    checkpointBeforeWrite(p, ctx);
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
        const anchor = String(matchNew).split('\n')[0];
        let at = newLines.indexOf(anchor);
        if (at < 0) at = newLines.indexOf(String(matchOld).split('\n')[0]);
        if (at >= 0) {
          const newSpan = String(matchNew).split('\n').length;
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

// Suggest a near-miss filename when a path does not exist: same directory, an
// exact case-insensitive match, same stem with a different extension, or a
// prefix match. Saves the model a round-trip of guessing (Claude Code's
// "Did you mean X?").
function similarFileHint(missingPath) {
  const dir = path.dirname(missingPath);
  const base = path.basename(missingPath);
  const stem = base.replace(/\.[^.]*$/, '').toLowerCase();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return ''; }
  const lower = base.toLowerCase();
  // Levenshtein distance, capped — enough to catch a typo (confg -> config).
  const lev = (a, b) => {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 3;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  };
  let cand = entries.find((e) => e.toLowerCase() === lower);
  if (!cand) {
    let best = null, bestD = 3;
    for (const e of entries) {
      const d = lev(stem, e.replace(/\.[^.]*$/, '').toLowerCase());
      if (d < bestD) { bestD = d; best = e; }
    }
    cand = best;
  }
  if (cand && cand !== base) return ` Did you mean "${path.join(dir, cand)}"?`;
  return '';
}

// When old_string is not found, look for the closest line in the file and name
// it, so the model can see what the text actually is instead of guessing.
function nearestLineHint(content, oldStr) {
  const want = String(oldStr).split('\n')[0].trim();
  if (!want || want.length < 3) return '';
  const lines = String(content).split('\n');
  // Character bigrams: robust to small differences and cheap on long lines.
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const wantGrams = grams(want);
  if (!wantGrams.size) return '';
  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const g = grams(lines[i].trim());
    if (!g.size) continue;
    let hit = 0;
    for (const t of wantGrams) if (g.has(t)) hit++;
    const score = hit / wantGrams.size;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best >= 0 && bestScore >= 0.5) {
    return ` The closest line is line ${best + 1}: ${JSON.stringify(lines[best].trim().slice(0, 120))}`;
  }
  return '';
}

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
  //     (no region covers it). Name the exact lines so the model reads the right
  //     window instead of guessing.
  if (curFileHash === entry.fileHash) {
    const span = String(normOld).split('\n').length;
    const at = editLine > 0 ? editLine : 1;
    return `Edit rejected: you have not read the lines you are editing in ${p}. The target is around line ${at} (${span} line${span === 1 ? '' : 's'}). Read it first — ${args_readHint(p, at, span)} — then Edit.`;
  }

  // (3) The file changed on disk since it was Read and the edit target is not in
  //     an intact Read region. Reject so a stale snippet cannot corrupt the file.
  const at3 = editLine > 0 ? ` (target line ${editLine})` : '';
  return `Edit rejected: ${p} changed since it was Read${at3}, and the edited region is not in an intact Read snapshot. Re-run ${args_readHint(p, editLine > 0 ? editLine : 1, String(normOld).split('\n').length)} to get the current content, then Edit.`;
}

// A ready-to-use Read call for the hint. Keeps the model from guessing line ranges.
function args_readHint(p, at, span) {
  const from = Math.max(1, at - 3);
  const n = Math.max(span + 6, 10);
  return `Read { path: ${JSON.stringify(p)}, line_offset: ${from}, n_lines: ${n} }`;
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
    return `Edit rejected: lines ${start}-${end} were not read in ${p}. Read them first — ${args_readHint(p, start, end - start + 1)} — then Edit.`;
  }
  return `Edit rejected: ${p} changed since it was Read (lines ${start}-${end} are not in an intact Read snapshot). Re-run ${args_readHint(p, start, end - start + 1)} to get the current content, then Edit.`;
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
