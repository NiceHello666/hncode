// Small TTY / terminal utilities.
// Test file for Write size display - this comment should be long enough to measure

export function isTTY() {
  return !!process.stdout.isTTY;
}

export function size() {
  try {
    const [cols, rows] = process.stdout.getWindowSize();
    return { cols: cols || 80, rows: rows || 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

export function writeRaw(str) {
  if (!process.stdout.write(str)) return false;
  return true;
}

// Enable raw mode around a callback, restoring on exit/error.
export function withRawMode(cb) {
  const stream = process.stdin;
  if (!stream.isTTY) {
    throw new Error('hncode: interactive mode requires a TTY (stdin is not a terminal).');
  }
  const wasRaw = stream.isRaw;
  stream.setRawMode(true);
  stream.resume();
  stream.setEncoding('utf8');
  const cleanup = () => {
    try { stream.setRawMode(wasRaw || false); } catch {}
    stream.pause();
  };
  try {
    return cb(cleanup);
  } finally {
    cleanup();
  }
}

// Visible width ignoring ANSI escapes (approx; no CJK width handling).
// NOTE: kept for back-compat; prefer visualWidth() for display-accurate width.
export function strWidth(s) {
  return (s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

// True visual column-width of a plain string (no ANSI), assuming a terminal that
// renders East Asian / wide / some symbol glyphs as 2 columns. Must be used for any
// cursor positioning and line wrapping so an I-shaped (insert) caret lines up.
// Source of truth: Unicode wide ranges + a small set of CJK-fused symbol glyphs.
export function visualWidth(s) {
  if (!s) return 0;
  // Measured per GRAPHEME CLUSTER (see clusterWidth): summing charWidth per
  // codepoint made a ZWJ emoji sequence count 8 columns instead of 2.
  return clusterWidth(s);
}

// ---- East Asian Width tables (Unicode 15) --------------------------------
// Wide/Fullwidth ranges -> 2 columns. Everything else is 1 unless it is a
// zero-width character (see ZERO_WIDTH) or emoji presentation (see below).
const WIDE = [
  [0x1100, 0x115F], [0x231A, 0x231B], [0x2329, 0x232A], [0x23E9, 0x23EC],
  [0x23F0, 0x23F0], [0x23F3, 0x23F3], [0x25FD, 0x25FE], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267F, 0x267F], [0x2693, 0x2693], [0x26A1, 0x26A1],
  [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26CE, 0x26CE],
  [0x26D4, 0x26D4], [0x26EA, 0x26EA], [0x26F2, 0x26F3], [0x26F5, 0x26F5],
  [0x26FA, 0x26FA], [0x26FD, 0x26FD], [0x2705, 0x2705], [0x270A, 0x270B],
  [0x2728, 0x2728], [0x274C, 0x274C], [0x274E, 0x274E], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27B0, 0x27B0], [0x27BF, 0x27BF],
  [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55],
  [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
  [0xA000, 0xA4CF], [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF],
  [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
  [0x16FE0, 0x16FE4], [0x17000, 0x187F7], [0x18800, 0x18CD5],
  [0x1B000, 0x1B152], [0x1B164, 0x1B167], [0x1B170, 0x1B2FB],
  [0x1F004, 0x1F004], [0x1F0CF, 0x1F0CF], [0x1F18E, 0x1F18E],
  [0x1F191, 0x1F19A], [0x1F200, 0x1F320], [0x1F32D, 0x1F335],
  [0x1F337, 0x1F37C], [0x1F37E, 0x1F393], [0x1F3A0, 0x1F3CA],
  [0x1F3CF, 0x1F3D3], [0x1F3E0, 0x1F3F0], [0x1F3F4, 0x1F3F4],
  [0x1F3F8, 0x1F43E], [0x1F440, 0x1F440], [0x1F442, 0x1F4FC],
  [0x1F4FF, 0x1F53D], [0x1F54B, 0x1F54E], [0x1F550, 0x1F567],
  [0x1F57A, 0x1F57A], [0x1F595, 0x1F596], [0x1F5A4, 0x1F5A4],
  [0x1F5FB, 0x1F64F], [0x1F680, 0x1F6C5], [0x1F6CC, 0x1F6CC],
  [0x1F6D0, 0x1F6D2], [0x1F6D5, 0x1F6D7], [0x1F6DC, 0x1F6DF],
  [0x1F6EB, 0x1F6EC], [0x1F6F4, 0x1F6FC], [0x1F7E0, 0x1F7EB],
  [0x1F7F0, 0x1F7F0], [0x1F90C, 0x1F93A], [0x1F93C, 0x1F945],
  [0x1F947, 0x1F9FF], [0x1FA70, 0x1FAFF],
  [0x20000, 0x2FFFD], [0x30000, 0x3FFFD],
];

// Combining / formatting characters that occupy no cell.
function isZeroWidth(c) {
  return (c >= 0x200B && c <= 0x200F)          // ZWSP..RLM (incl. ZWJ U+200D)
    || (c >= 0x0300 && c <= 0x036F)
    || (c >= 0x0483 && c <= 0x0489)
    || (c >= 0x0591 && c <= 0x05BD) || c === 0x05BF || (c >= 0x05C1 && c <= 0x05C2)
    || (c >= 0x0610 && c <= 0x061A)
    || (c >= 0x064B && c <= 0x065F) || c === 0x0670
    || (c >= 0x06D6 && c <= 0x06DC)
    || (c >= 0x0E31 && c <= 0x0E3A) || (c >= 0x0E47 && c <= 0x0E4E)
    || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF)
    || (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE00 && c <= 0xFE0F)
    || (c >= 0xFE20 && c <= 0xFE2F) || (c >= 0xE0100 && c <= 0xE01EF)
    || (c >= 0x1160 && c <= 0x11FF);           // Hangul Jamo medial/final
}

// Regional Indicator (flags) — two of them form one glyph.
const isRegional = (c) => c >= 0x1F1E6 && c <= 0x1F1FF;

// Emoji that occupy TWO cells by default (Emoji_Presentation=Yes), even
// without U+FE0F. Text-default symbols (U+276F ❯, U+2603 ☃, U+00B7 ·, …) are
// NOT in here: they are 1 cell unless followed by U+FE0F.
function isWideByDefault(c) {
  return (c >= 0x1F300 && c <= 0x1F5FF)
    || (c >= 0x1F600 && c <= 0x1F64F)
    || (c >= 0x1F680 && c <= 0x1F6FF)
    || (c >= 0x1F900 && c <= 0x1F9FF)
    || (c >= 0x1FA70 && c <= 0x1FAFF)
    || (c >= 0x1F000 && c <= 0x1F0FF)
    || isRegional(c)
    || c === 0x231A || c === 0x231B || c === 0x23E9 || c === 0x23EC
    || c === 0x23F0 || c === 0x23F3 || c === 0x25FD || c === 0x25FE
    || c === 0x2614 || c === 0x2615 || (c >= 0x2648 && c <= 0x2653)
    || c === 0x267F || c === 0x2693 || c === 0x26A1 || (c >= 0x26AA && c <= 0x26AB)
    || (c >= 0x26BD && c <= 0x26BE) || (c >= 0x26C4 && c <= 0x26C5)
    || c === 0x26CE || c === 0x26D4 || c === 0x26EA
    || (c >= 0x26F2 && c <= 0x26F3) || c === 0x26F5 || c === 0x26FA || c === 0x26FD
    || c === 0x2705 || (c >= 0x270A && c <= 0x270B) || c === 0x2728
    || c === 0x274C || c === 0x274E || (c >= 0x2753 && c <= 0x2755) || c === 0x2757
    || (c >= 0x2795 && c <= 0x2797) || c === 0x27B0 || c === 0x27BF
    || (c >= 0x2B1B && c <= 0x2B1C) || c === 0x2B50 || c === 0x2B55;
}

const inRanges = (c, ranges) => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (c < s) hi = mid - 1;
    else if (c > e) lo = mid + 1;
    else return true;
  }
  return false;
};

export function charWidth(ch) {
  const c = String(ch).codePointAt(0);
  if (c === undefined) return 0;
  // Tab renders as 4 spaces in most terminals.
  if (c === 0x09) return 4;
  if (c < 0x20 || c === 0x7F) return 0;
  if (isZeroWidth(c)) return 0;
  if (isWideByDefault(c)) return 2;
  if (inRanges(c, WIDE)) return 2;
  return 1;
}

// Split a string into grapheme clusters that a terminal renders as ONE glyph.
// Minimal but covers what actually appears in agent output: ZWJ sequences
// (👨‍👩‍👧), variation selectors (❤️), and flag pairs (🇺🇸).
function nextCluster(s, i) {
  // NOTE: every offset here is a UTF-16 INDEX (what slice() consumes). Mixing
  // in codepoint offsets desynced the scan across surrogate pairs, so a ZWJ
  // family measured 5 columns instead of 2.
  const at = (idx) => s.codePointAt(idx);
  const len = (cp) => cp > 0xFFFF ? 2 : 1;

  const firstCp = at(i);
  let end = i + len(firstCp);
  const startedRegional = isRegional(firstCp);

  for (;;) {
    if (end >= s.length) break;
    const cp = at(end);
    if (cp === 0x200D) {                       // ZWJ: absorb the next base too
      end += 1;
      if (end >= s.length) break;
      end += len(at(end));
      continue;
    }
    if (isZeroWidth(cp) || cp === 0xFE0F) { end += len(cp); continue; }
    // A regional-indicator PAIR forms one flag glyph.
    if (startedRegional && isRegional(cp)) { end += len(cp); break; }
    break;
  }
  return { text: s.slice(i, end), next: end };
}

// Width of a whole string measured by GRAPHEME CLUSTER: a ZWJ sequence or a
// flag counts 2 columns total, not the sum of its codepoints (which used to
// make 👨‍👩‍👧 measure 8 columns and break every row it appeared on).
export function clusterWidth(s) {
  const str = String(s || '');
  let w = 0;
  for (let i = 0; i < str.length;) {
    const { text, next } = nextCluster(str, i);
    i = next;
    if (!text) { i++; continue; }
    w += clusterGlyphWidth(text);
  }
  return w;
}

function clusterGlyphWidth(cluster) {
  const cps = [...cluster].map((c) => c.codePointAt(0));
  // ZWJ sequence / flag pair / VS16-presented symbol => 2 columns.
  if (cps.includes(0x200D)) return 2;
  if (cps.filter(isRegional).length >= 1) return 2;
  const base = cps[0];
  if (cps.includes(0xFE0F)) return 2;          // explicit emoji presentation
  const baseW = charWidth(String.fromCodePoint(base));
  let extra = 0;
  for (let k = 1; k < cps.length; k++) extra += charWidth(String.fromCodePoint(cps[k]));
  return baseW + extra;
}

// Estimate the LLM token count of a plain string, matching kimi-code's
// algorithm in `llm-adapter/contract/tokens.ts`:
//   tokens = ceil(ASCII chars / 4) + non-ASCII chars
// ASCII characters average ~4 per token; CJK and other non-ASCII are ~1 token
// each. This is far more accurate than a uniform chars/4 ratio.
export function estimateTokens(text) {
  let ascii = 0, nonAscii = 0;
  for (const ch of String(text ?? '')) {
    if (ch.codePointAt(0) <= 127) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

// Estimate tokens for the whole request payload: system + tools + messages.
export function estimateMessagesTokens(messages, cfg) {
  let total = estimateTokens(cfg && cfg.systemPrompt);
  if (Array.isArray(cfg && cfg.toolFilter)) total += cfg.toolFilter.length * 8; // rough tool-def overhead
  for (const m of messages || []) {
    total += estimateTokens(m.role || '');
    const c = m.content;
    total += typeof c === 'string' ? estimateTokens(c) : estimateTokens(JSON.stringify(c || ''));
    if (m.toolCalls) for (const tc of m.toolCalls) {
      total += estimateTokens(tc.name || '') + estimateTokens(JSON.stringify(tc.args || ''));
    }
  }
  return total;
}

// Expand TAB characters to spaces at 8-column tab stops. A terminal advances a
// tab to the NEXT tab stop, but our width math (visualWidth) counts '\t' as 0,
// so a row containing a tab is padded short and the terminal wraps it onto the
// next line — the "text bleeding onto another row" corruption. Tool output
// (e.g. `dir`, `ls -l`, git) contains tabs, so expand before measuring.
export function expandTabs(s, tabSize = 8) {
  const str = String(s ?? '');
  if (str.indexOf('\t') === -1) return str;
  let out = '';
  let col = 0;
  for (const ch of str) {
    if (ch === '\n') { out += ch; col = 0; continue; }
    if (ch === '\t') {
      const next = tabSize - (col % tabSize);
      out += ' '.repeat(next);
      col += next;
      continue;
    }
    out += ch;
    col += clusterWidth(ch);
  }
  return out;
}

// Truncate a string to `width` visible columns, stripping escapes for measurement
// and padding if shorter. Used for status/header lines. Honors 2-col glyphs.
export function fit(s, width) {
  const plain = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const plainW = visualWidth(plain);
  if (plainW <= width) return s + ' '.repeat(width - plainW);
  let kept = '';
  let w = 0;
  for (const ch of s) {
    if (ch === '\x1b') { kept += ch; continue; }
    const cw = charWidth(ch);
    if (w + cw > width) break;
    w += cw;
    kept += ch;
  }
  return kept;
}

export function emit(str) {
  process.stdout.write(str);
}
