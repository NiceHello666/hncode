// Cyan-blue visual theme for hncode. Adapts to the terminal's color depth:
// uses true-color when available, 256/16-color fallbacks otherwise.

function colorDepth() {
  try { return process.stdout.getColorDepth?.() || 0; } catch { return 0; }
}
const DEPTH = colorDepth();
export const TRUECOLOR = DEPTH >= 24 || process.env.COLORTERM === 'truecolor' || /^xterm.*-256color$|.*-truecolor$/.test(process.env.TERM || '');

function rgb(r, g, b) { return TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${ansi256(r, g, b)}m`; }
function brgb(r, g, b) { return TRUECOLOR ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${ansi256(r, g, b)}m`; }

// Quantize a truecolor triple to the nearest 256-color xterm index.
function ansi256(r, g, b) {
  const ri = Math.round(r / 51), gi = Math.round(g / 51), bi = Math.round(b / 51);
  if (ri === gi && gi === bi) {
    if (ri === 0) return 16;
    if (ri === 255 / 51) return 232 + ri;
    return 232 + ri; // grayscale ramp
  }
  return 16 + 36 * ri + 6 * gi + bi;
}

// Brand: cyan-blue (青蓝色).
export const TEAL = rgb(0, 184, 219);     // 青蓝
export const CYAN = rgb(0, 215, 255);
export const BLUE = rgb(66, 135, 245);
export const FG = TEAL;                   // primary fg
export const BG = rgb(0, 18, 26);
export const BORDER = rgb(70, 130, 180);

// Named accent colours per theme. `auto` keeps the brand cyan-blue and lets the
// terminal's own palette show through for everything else; `dark`/`light` pick
// accent triples that stay readable on that background.
const THEMES = {
  auto: { teal: [0, 184, 219], cyan: [0, 215, 255], blue: [66, 135, 245], border: [70, 130, 180], hover: [190, 245, 255] },
  dark: { teal: [0, 200, 230], cyan: [90, 225, 255], blue: [90, 150, 255], border: [80, 140, 190], hover: [190, 245, 255] },
  light: { teal: [0, 120, 160], cyan: [0, 140, 200], blue: [40, 90, 200], border: [120, 160, 200], hover: [0, 80, 110] },
};
export const THEME_NAMES = Object.keys(THEMES);

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  muted: '\x1b[90m',
  teal: TEAL,
  cyan: CYAN,
  blue: BLUE,
  fg: FG,
  bg: BG,
  bgTeal: brgb(0, 184, 219),
  bgDim: brgb(12, 24, 30),
  bgPanel: TRUECOLOR ? '\x1b[48;5;236m' : '\x1b[48;5;236m',
  border: BORDER,
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  magenta: '\x1b[95m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  orange: TRUECOLOR ? rgb(255, 140, 0) : '\x1b[38;5;208m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  // Selection highlight (mouse text selection) and the scrollbar gutter.
  // Selection uses a dark teal background so white text stays readable.
  selBg: TRUECOLOR ? brgb(0, 70, 84) : '\x1b[48;5;23m', // Original dark cyan background
  scrollTrack: '\x1b[90m',          // dim gutter
  scrollThumb: TRUECOLOR ? rgb(0, 184, 219) : '\x1b[38;5;37m', // brand cyan-blue
  // Scrollbar interaction states. hover: a touch whiter/brighter than the brand
  // colour; active (pressed/dragging): a touch darker. Idle returns to
  // scrollThumb (the brand colour) — the caller swaps back automatically.
  scrollThumbHover: TRUECOLOR ? rgb(120, 226, 245) : '\x1b[38;5;123m',
  scrollThumbActive: TRUECOLOR ? rgb(0, 140, 168) : '\x1b[38;5;31m',
  // Hover highlight for clickable rows (menu items, picker options, form
  // fields, composer rows). An explicit bright foreground + BOLD rather than a
  // bare BOLD: BOLD only brightens the 16-colour palette (it does nothing to a
  // true-color row), which is why hover used to be invisible on most rows.
  // tintRange() re-applies this so the row's own SGR codes cannot cancel it.
  hover: '\x1b[1m' + rgb(190, 245, 255),
};

export function style(text, ...codes) {
  return codes.join('') + text + '\x1b[0m';
}

// Linearly interpolate between two RGB triples and return an ANSI colour string.
// Used for the pulsing Working indicator (orange pulses to a brighter/darker
// shade over a 2s cycle).
export function lerpColor(r1, g1, b1, r2, g2, b2, t) {
  const ti = Math.max(0, Math.min(1, t));
  const r = Math.round(r1 + (r2 - r1) * ti);
  const g = Math.round(g1 + (g2 - g1) * ti);
  const b = Math.round(b1 + (b2 - b1) * ti);
  return rgb(r, g, b);
}

// Apply a named theme IN PLACE. `C` is a module-level object and ESM imports are
// live bindings, so mutating its properties here changes the colours everywhere
// without re-importing. Returns true when the name was recognised.
export function setTheme(name) {
  const t = THEMES[name];
  if (!t) return false;
  C.teal = rgb(...t.teal);
  C.fg = C.teal;
  C.cyan = rgb(...t.cyan);
  C.blue = rgb(...t.blue);
  C.border = rgb(...t.border);
  C.bgTeal = brgb(...t.teal);
  // Hover stays visible on this theme's background (bright on dark, dark on light).
  C.hover = '\x1b[1m' + rgb(...(t.hover || [190, 245, 255]));
  return true;
}

export function clearScreen() {
  return '\x1b[3J\x1b[H\x1b[2J';
}
export function eraseLine() {
  return '\x1b[2K';
}
export function eraseScreen() {
  return '\x1b[2J';
}
export function moveTo(r, c) {
  return `\x1b[${r + 1};${c + 1}H`;
}
export function cursorUp(n) { return `\x1b[${n}A`; }
export function cursorDown(n) { return `\x1b[${n}B`; }
export function cursorLeft(n) { return `\x1b[${n}D`; }
export function cursorForward(n) { return `\x1b[${n}C`; }
export function hideCursor() { return '\x1b[?25l'; }
export function showCursor() { return '\x1b[?25h'; }
// Cursor shape: terminals accept DECSCUSR — 2 = block, 4 = underline, 6 = bar(I-beam);
// 1/3/5 = blinking variants. Force a solid block cursor so positioning is always exact
// and unaffected by I-beam alignment.
export function blockCursor() { return '\x1b[2 q'; }
export function underlineCursor() { return '\x1b[4 q'; }
export function barCursor() { return '\x1b[6 q'; }
export function alternateScreen(on) { return on ? '\x1b[?1049h' : '\x1b[?1049l'; }
export function setScrollRegion(top, bottom) {
  if (process.platform === 'win32') return ''; // win TTY scroll regions are unreliable
  return `\x1b[${top + 1};${bottom + 1}r`;
}
export function resetScrollRegion() {
  return '\x1b[r';
}
export function setBracketed(on) {
  return `\x1b[?2004h${on ? '' : ''}`; // placeholder; real impl toggles bracketed paste
}
