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
//
// PERFORMANCE (this is the hottest function in the whole TUI — a profile of a
// 500-message transcript streaming markdown put ~48% of samples in this plus
// clusterWidth/clusterGlyphWidth/isWideByDefault):
//   * a printable-ASCII fast path returns the length immediately. Agent output
//     is overwhelmingly ASCII, and measuring it cost ~30 range comparisons per
//     character for nothing. 1MB of ASCII went from 219ms to ~0.
//   * everything else is memoised (see WIDTH_CACHE_MAX). Rows are re-measured
//     every frame while a reply streams, and the same substrings come back
//     again and again.
export function visualWidth(s) {
  if (!s) return 0;
  const str = typeof s === 'string' ? s : String(s);
  // Fast path: printable ASCII measures exactly its length.
  if (isPrintableAscii(str)) return str.length;
  const hit = widthCache.get(str);
  if (hit !== undefined) return hit;
  const w = clusterWidth(str);
  if (widthCache.size >= WIDTH_CACHE_MAX) {
    // Cheap eviction: drop the oldest insertion (Map preserves order).
    const oldest = widthCache.keys().next().value;
    if (oldest !== undefined) widthCache.delete(oldest);
  }
  widthCache.set(str, w);
  return w;
}

// All code units printable ASCII? `\t`/newline/escape all fail, which is what we
// want: those have their own width rules (tab = 4, ESC starts an ANSI sequence).
function isPrintableAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

const WIDTH_CACHE_MAX = 4096;
const widthCache = new Map();


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

// ---------------------------------------------------------------------------
// East Asian AMBIGUOUS width
// ---------------------------------------------------------------------------
// Unicode gives every character an East Asian Width class. `A` (Ambiguous) means
// ONE column on a Western terminal and TWO on a CJK one — the terminal decides, the
// character does not say. hncode's chrome leans on these heavily, which is why they
// had to be handled rather than avoided:
//
//   box rules   ─ │ ╭ ╮ ╰ ╯ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼
//   separators  ·  …  —  –
//   markers     ↑ ↓ ← → ❯ ● ○ ✓ ✗
//   math        ± × ÷ ≠ ≤ ≥ ∞
//
// Measuring them as 1 column on a CJK terminal made every row containing one N columns
// short, so the row's right edge landed N columns past the panel it belonged to —
// "the text pushes the wall right". The panel's own background could not hide it
// either: the overflow is REAL cells on screen, not a measurement disagreement inside
// one row.
//
// Default: follow the LOCALE. A CJK locale is the standard reason a terminal treats
// EAW=A as wide, and it is the only signal available before anything is drawn — the
// code page does not say (a UTF-8 Windows console still renders them wide), and no
// terminal query reports it.
let ambiguousWide = null;   // lazily resolved so a test can set the env first

/** EAW=A ranges (Unicode 15), ascending — `inRanges` binary-searches this. */
const AMBIGUOUS = [
  [0x00A1, 0x00A1], [0x00A4, 0x00A4], [0x00A7, 0x00A8], [0x00AA, 0x00AA],
  [0x00AD, 0x00AE], [0x00B0, 0x00B4], [0x00B6, 0x00BA], [0x00BC, 0x00BF],
  [0x00C6, 0x00C6], [0x00D0, 0x00D0], [0x00D7, 0x00D8], [0x00DE, 0x00E1],
  [0x00E6, 0x00E6], [0x00E8, 0x00EA], [0x00EC, 0x00ED], [0x00F0, 0x00F0],
  [0x00F2, 0x00F3], [0x00F7, 0x00FA], [0x00FC, 0x00FC], [0x00FE, 0x00FE],
  [0x0101, 0x0101], [0x0111, 0x0111], [0x0113, 0x0113], [0x011B, 0x011B],
  [0x0126, 0x0127], [0x012B, 0x012B], [0x0131, 0x0133], [0x0138, 0x0138],
  [0x013F, 0x0142], [0x0144, 0x0144], [0x0148, 0x014B], [0x014D, 0x014D],
  [0x0152, 0x0153], [0x0166, 0x0167], [0x016B, 0x016B], [0x01CE, 0x01CE],
  [0x01D0, 0x01D0], [0x01D2, 0x01D2], [0x01D4, 0x01D4], [0x01D6, 0x01D6],
  [0x01D8, 0x01D8], [0x01DA, 0x01DA], [0x01DC, 0x01DC], [0x0251, 0x0251],
  [0x0261, 0x0261], [0x02C4, 0x02C4], [0x02C7, 0x02C7], [0x02C9, 0x02CB],
  [0x02CD, 0x02CD], [0x02D0, 0x02D0], [0x02D8, 0x02DB], [0x02DD, 0x02DD],
  [0x02DF, 0x02DF], [0x0300, 0x036F], [0x0391, 0x03A1], [0x03A3, 0x03A9],
  [0x03B1, 0x03C1], [0x03C3, 0x03C9], [0x0401, 0x0401], [0x0410, 0x044F],
  [0x0451, 0x0451], [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019],
  [0x201C, 0x201D], [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030],
  [0x2032, 0x2033], [0x2035, 0x2035], [0x203B, 0x203B], [0x203E, 0x203E],
  [0x2074, 0x2074], [0x207F, 0x207F], [0x2081, 0x2084], [0x20AC, 0x20AC],
  [0x2103, 0x2103], [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113],
  [0x2116, 0x2116], [0x2121, 0x2122], [0x2126, 0x2126], [0x212B, 0x212B],
  [0x2153, 0x2154], [0x215B, 0x215E], [0x2160, 0x216B], [0x2170, 0x2179],
  [0x2189, 0x2189], [0x2190, 0x2199], [0x21B8, 0x21B9], [0x21D2, 0x21D2],
  [0x21D4, 0x21D4], [0x21E7, 0x21E7], [0x2200, 0x2200], [0x2202, 0x2203],
  [0x2207, 0x2208], [0x220B, 0x220B], [0x220F, 0x220F], [0x2211, 0x2211],
  [0x2215, 0x2215], [0x221A, 0x221A], [0x221D, 0x2220], [0x2223, 0x2223],
  [0x2225, 0x2225], [0x2227, 0x222C], [0x222E, 0x222E], [0x2234, 0x2237],
  [0x223C, 0x223D], [0x2248, 0x2248], [0x224C, 0x224C], [0x2252, 0x2252],
  [0x2260, 0x2261], [0x2264, 0x2267], [0x226A, 0x226B], [0x226E, 0x226F],
  [0x2282, 0x2283], [0x2286, 0x2287], [0x2295, 0x2295], [0x2299, 0x2299],
  [0x22A5, 0x22A5], [0x22BF, 0x22BF], [0x2312, 0x2312], [0x2460, 0x24E9],
  [0x24EB, 0x254B], [0x2550, 0x2573], [0x2580, 0x258F], [0x2592, 0x2595],
  [0x25A0, 0x25A1], [0x25A3, 0x25A9], [0x25B2, 0x25B3], [0x25B6, 0x25B7],
  [0x25BC, 0x25BD], [0x25C0, 0x25C1], [0x25C6, 0x25C8], [0x25CB, 0x25CB],
  [0x25CE, 0x25D1], [0x25E2, 0x25E5], [0x25EF, 0x25EF], [0x2605, 0x2606],
  [0x2609, 0x2609], [0x260E, 0x260F], [0x261C, 0x261C], [0x261E, 0x261E],
  [0x2640, 0x2640], [0x2642, 0x2642], [0x2660, 0x2661], [0x2663, 0x2665],
  [0x2667, 0x266A], [0x266C, 0x266D], [0x266F, 0x266F], [0x269E, 0x269F],
  [0x26C6, 0x26CD], [0x26CF, 0x26D3], [0x26D5, 0x26E1], [0x26E3, 0x26E3],
  [0x26E8, 0x26E9], [0x26EB, 0x26F1], [0x26F4, 0x26F4], [0x26F6, 0x26F9],
  [0x26FB, 0x26FC], [0x26FE, 0x26FF], [0x273D, 0x273D], [0x2761, 0x2761],
  [0x2776, 0x277F], [0x2B56, 0x2B59], [0x3248, 0x324F], [0xE000, 0xF8FF],
  [0xFE00, 0xFE0F], [0xFFFD, 0xFFFD], [0x1F100, 0x1F10A],
  [0x1F110, 0x1F12D], [0x1F130, 0x1F169], [0x1F170, 0x1F19A],
];

/**
 * Should EAW=Ambiguous characters measure 2 columns?
 *
 * Resolved once, from (in order):
 *   1. `HNCODE_AMBIGUOUS_WIDTH` — an explicit override, for a terminal whose setting
 *      does not match its locale;
 *   2. the locale — `zh`/`ja`/`ko` mean a CJK terminal, which is the standard reason a
 *      terminal renders these wide.
 */
export function detectAmbiguousWide(env = process.env) {
  const raw = env.HNCODE_AMBIGUOUS_WIDTH;
  if (raw !== undefined && raw !== '') return /^(1|true|yes|on)$/i.test(raw);
  let loc = '';
  try { loc = (Intl.DateTimeFormat().resolvedOptions().locale) || ''; } catch { /* no Intl */ }
  const tag = loc || env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /^(zh|ja|ko)\b/i.test(tag) || /^(zh|ja|ko)[-_]/i.test(tag);
}

export function isAmbiguousWide() {
  if (ambiguousWide === null) ambiguousWide = detectAmbiguousWide();
  return ambiguousWide;
}

/**
 * Turn the ambiguous-as-wide rule on or off. Clears the width cache, which is keyed by
 * string alone and would otherwise hand back widths measured under the other rule.
 */
export function setAmbiguousWide(on) {
  const next = !!on;
  if (next === ambiguousWide) return;
  ambiguousWide = next;
  widthCache.clear();
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
  // FAST PATH: plain printable ASCII is exactly one cell wide. Without this each
  // ASCII character paid for isZeroWidth + isWideByDefault (≈30 range tests) + a
  // binary search, which is most of what made width measurement the hottest
  // function in the TUI.
  if (c >= 0x20 && c <= 0x7e) return 1;
  if (isZeroWidth(c)) return 0;
  if (isWideByDefault(c)) return 2;
  if (inRanges(c, WIDE)) return 2;
  return 1;
}

// Shared native segmenter. `Intl.Segmenter` implements the full Unicode
// grapheme-break algorithm in native code, so it is both more correct than the
// hand-rolled scanner it replaces (ZWJ families, flags, combining marks) and
// much cheaper — that scanner allocated a `{text, next}` object per character,
// which showed up as GC pressure in profiles.
const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

// Width of a whole string measured by GRAPHEME CLUSTER: a ZWJ sequence or a
// flag counts 2 columns total, not the sum of its codepoints (which used to
// make 👨‍👩‍👧 measure 8 columns and break every row it appeared on).
export function clusterWidth(s) {
  const str = String(s || '');
  if (!str) return 0;
  let w = 0;
  if (graphemeSegmenter) {
    // NOTE: an "ASCII runs are free" split was tried here and made things WORSE
    // (a 500KB markdown string went 97ms -> 544ms): slicing the string into a
    // run per CJK character costs far more than handing the whole thing to the
    // native segmenter. The real win is the printable-ASCII fast path in
    // visualWidth() plus the memo cache, not micro-splitting here.
    for (const { segment } of graphemeSegmenter.segment(str)) w += clusterGlyphWidth(segment);
    return w;
  }
  // Fallback for a runtime without Intl.Segmenter: per code point.
  for (const ch of str) w += clusterGlyphWidth(ch);
  return w;
}
// Width of one grapheme cluster. Allocation-free on the common path: a

// Width of one grapheme cluster. Allocation-free on the common path: a
// single-code-point cluster (every ASCII character, most CJK) returns
// charWidth directly instead of first building an array of code points.
function clusterGlyphWidth(cluster) {
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  if (cluster.length <= (first > 0xFFFF ? 2 : 1)) return charWidth(cluster);

  const cps = [];
  for (let i = 0; i < cluster.length;) {
    const cp = cluster.codePointAt(i);
    cps.push(cp);
    i += cp > 0xFFFF ? 2 : 1;
  }
  // ZWJ sequence / flag pair / VS16-presented symbol => 2 columns.
  if (cps.includes(0x200D)) return 2;
  if (cps.some(isRegional)) return 2;
  if (cps.includes(0xFE0F)) return 2;          // explicit emoji presentation
  let width = charWidth(String.fromCodePoint(cps[0]));
  for (let k = 1; k < cps.length; k++) width += charWidth(String.fromCodePoint(cps[k]));
  return width;
}

// Estimate the LLM token count of a plain string, matching kimi-code's
// algorithm in `llm-adapter/contract/tokens.ts`:
//   tokens = ceil(ASCII chars / 4) + non-ASCII chars
// ASCII characters average ~4 per token; CJK and other non-ASCII are ~1 token
// each. This is far more accurate than a uniform chars/4 ratio.
// Token estimate. The character walk is O(len), and the context gauge re-prices
// whole message bodies (a Read result can be hundreds of KB) every turn.
//
// A value cache only helps COMPLETED messages: they are immutable, so the same
// string is measured again and again. It actively HURTS streaming text, where the
// string grows every frame — every call is a miss, so the cache pays hashing and an
// insert each time and (once full) an O(n) eviction sweep, measuring 1ms/call vs
// ~0.001ms for a plain walk (30k growing-text calls: 31s cached vs 30ms uncached).
//
// So the cache is limited to SHORT strings: completed metadata and role names hit
// it, while a long or growing body is just walked directly. At most 4 KB was chosen
// because a token estimate is only ever re-asked for values that are cheap to hold
// and genuinely stable; anything larger is better re-walked than hashed + stored.
const tokCache = new Map();
const TOK_CACHE_MAX = 20000;
const TOK_CACHE_MAX_LEN = 4096;   // only memoise strings this short

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (s.length <= TOK_CACHE_MAX_LEN) {
    const hit = tokCache.get(s);
    if (hit !== undefined) return hit;
    let ascii = 0, nonAscii = 0;
    for (const ch of s) {
      if (ch.codePointAt(0) <= 127) ascii++;
      else nonAscii++;
    }
    const out = Math.ceil(ascii / 4) + nonAscii;
    if (tokCache.size >= TOK_CACHE_MAX) {
      // Drop the oldest half in one go: cheaper than one-at-a-time and keeps the
      // recently measured entries that a per-entry eviction would churn.
      let i = 0;
      for (const k of tokCache.keys()) { tokCache.delete(k); if (++i >= TOK_CACHE_MAX / 2) break; }
    }
    tokCache.set(s, out);
    return out;
  }
  // Long body: walk it. No memoise, no map churn.
  let ascii = 0, nonAscii = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) <= 127) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

// Estimate tokens for the MESSAGES only. The system prompt and tool definitions are
// NOT included: `messages` usually already starts with the system prompt (the TUI
// builds `[{ role: 'system', content: sysText }, ...]`), so adding `cfg.systemPrompt`
// on top counted it twice — and the value in `cfg` is the RAW prompt, not the
// assembled `sysText` (calm/plan/swarm/AGENTS.md appended), so it was also the wrong
// number. Callers that want the whole request add it themselves via
// estimateRequestOverhead().
export function estimateMessagesTokens(messages, cfg) {
  let total = 0;
  for (const m of messages || []) total += estimateMessageTokens(m, cfg);
  return total;
}

/**
 * Tokens for ONE message. Split out so callers that walk the history (e.g.
 * planCompaction) can price each message ONCE instead of re-summing the whole
 * array per message — that was O(n²) over the transcript.
 */
export function estimateMessageTokens(m, cfg) {
  if (!m) return 0;
  let total = estimateTokens(m.role || '');
  const c = m.content;
  total += typeof c === 'string' ? estimateTokens(c) : estimateTokens(JSON.stringify(c || ''));
  if (m.toolCalls) for (const tc of m.toolCalls) {
    total += estimateTokens(tc.name || '') + estimateTokens(JSON.stringify(tc.args || ''));
  }
  return total;
}

// ---- per-message token memo -----------------------------------------------
//
// Message objects -> { sig, tok }. WeakMap, so a message dropped from the history
// takes its estimate with it: no unbounded growth, and no manual eviction policy.
const msgTokMemo = new WeakMap();
//
// `estimateMessageTokens` above re-measures an immutable message every time it is
// asked, and the askers are frequent: the context gauge runs at every step, and
// compaction walks the whole history to find its cut point. A Read result can be
// hundreds of KB, so re-walking one costs milliseconds (measured: a 300 KB body is
// ~5.3 ms to price). Completed messages never change, so their estimate never has
// to be recomputed.
//
// The memo is a WeakMap keyed on the MESSAGE OBJECT, which gives two properties for
// free: it cannot leak (a dropped message takes its entry with it) and it cannot
// collide (two equal messages are still two objects).
//
// Correctness — the one place a stored message changes underneath us —
// --------------------------------------------------------------------
// `trimToolResults` rewrites `m.content` IN PLACE, replacing a large body with a
// short pointer. A memo that trusted object identity alone would keep serving the
// pre-trim count, and the gauge would claim the context was still full right after
// the very operation meant to shrink it — the trim would appear to do nothing and
// the next request would compact again for no reason.
//
// So every entry stores a cheap SIGNATURE of the content alongside the number, and
// a mismatch recomputes. `.length` on a string is O(1), which is what makes this
// affordable: streaming text (which grows every frame) misses on the signature and
// is re-walked, exactly as `estimateTokens`' own short-string cache already
// established. Content that is neither a string nor an array gets a weaker
// signature and is simply re-measured each time rather than risk a stale answer.
function msgSignature(m) {
  const c = m.content;
  let s;
  if (typeof c === 'string') s = 's' + c.length;
  else if (c == null) s = 'n';
  else if (Array.isArray(c)) s = 'a' + c.length;
  else s = '';                       // unknown shape: never trust a memo
  if (m.toolCalls) s += 't' + m.toolCalls.length;
  return s;
}

/** Drop any memoised estimate for a message whose content was rewritten in place. */
export function forgetMessageTokens(m) {
  if (m && typeof m === 'object') msgTokMemo.delete(m);
}

/**
 * `estimateMessageTokens`, memoised per message object.
 *
 * Safe to call on STREAMING messages too: the signature check misses on every
 * frame, so a growing body is simply re-measured and never served stale.
 */
export function messageTokens(m, cfg) {
  if (!m || typeof m !== 'object') return estimateMessageTokens(m, cfg);
  const sig = msgSignature(m);
  if (sig !== '') {
    const hit = msgTokMemo.get(m);
    if (hit !== undefined && hit.sig === sig) return hit.tok;
  }
  const tok = estimateMessageTokens(m, cfg);
  if (sig !== '') msgTokMemo.set(m, { sig, tok });
  return tok;
}

/**
 * A rolling total over a message list that grows by appending.
 *
 * This is the idea borrowed from jcode's `ActiveCharEstimate`
 * (`crates/jcode-base/src/compaction.rs`): keep a running count of the messages
 * already priced, so the common append-only case never rescans history. jcode also
 * notes why the cached value and its staleness flag are bundled into one type
 * rather than two independent fields — a path that updated one without the other
 * silently corrupted token accounting. Here the two are a single number,
 * `_counted`: it is meaningless on its own and is only ever read together with the
 * length it was computed against.
 *
 * `sync()` is O(new messages) when the list was only appended to, and O(n) after a
 * compaction (which REPLACES the array, so the old count describes messages that no
 * longer exist). Correctness does not depend on detecting appends perfectly: the
 * boundary identities are spot-checked and any doubt falls back to a full recount,
 * which is still cheap because the per-message memo makes each step a WeakMap hit.
 */
export class TokenLedger {
  constructor() {
    this.tokens = 0;
    this._counted = 0;
    this._first = null;
    this._last = null;
  }

  /** Total tokens for `messages`, reusing the previous count where it is still valid. */
  sync(messages, cfg) {
    const msgs = Array.isArray(messages) ? messages : [];
    const n = msgs.length;
    const canExtend = this._counted > 0 && this._counted <= n
      && this._first === msgs[0]
      && this._last === msgs[this._counted - 1];
    if (canExtend) {
      for (let i = this._counted; i < n; i++) this.tokens += messageTokens(msgs[i], cfg);
    } else {
      // Full recount. Still O(n) WEAK-MAP LOOKUPS rather than O(n) string walks,
      // which is the difference between milliseconds and microseconds.
      let total = 0;
      for (let i = 0; i < n; i++) total += messageTokens(msgs[i], cfg);
      this.tokens = total;
    }
    this._counted = n;
    this._first = n ? msgs[0] : null;
    this._last = n ? msgs[n - 1] : null;
    return this.tokens;
  }

  /** Forget everything — call after an in-place edit of an already-counted message. */
  reset() {
    this.tokens = 0;
    this._counted = 0;
    this._first = null;
    this._last = null;
  }
}

// The overhead a request carries BEYOND its messages: the system prompt plus the
// tool definitions. Passed the assembled system text so the number matches what is
// actually sent.
export function estimateRequestOverhead(systemText, cfg) {
  let total = estimateTokens(systemText || '');
  const n = (cfg && Array.isArray(cfg.toolFilter)) ? cfg.toolFilter.length : 0;
  if (n) total += n * 8;   // rough per-tool-definition overhead
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
    // Per CHARACTER, `charWidth` is the right measure and is far cheaper than
    // clusterWidth here: the loop already iterates code points (so a surrogate
    // pair arrives as a single `ch`), and clusterWidth would spin up the
    // segmenter for every single character.
    col += charWidth(ch);
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
