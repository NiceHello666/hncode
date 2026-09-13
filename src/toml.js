// Minimal but correct TOML parser (subset sufficient for hncode + ~/.kimi-code/config.toml).
// Supports: comments, basic & literal strings (incl. multiline), arrays (incl. multiline
// and trailing commas), inline tables, dotted keys, tables [a.b."c"], booleans, ints,
// floats, and dates (returned as strings). Arrays of tables [[...]] are NOT supported.

const T = (s) => new _T(s);

class _T {
  constructor(s) { this.s = s; this.pos = 0; this.n = s.length; }
  peek() { return this.pos < this.n ? this.s[this.pos] : ''; }
  cur()  { return this.pos < this.n ? this.s[this.pos] : ''; }
  next() { return this.pos < this.n ? this.s[this.pos++] : ''; }
  eof()  { return this.pos >= this.n; }
  copyUntil(re) {
    let out = '';
    while (!this.eof() && !re.test(this.cur())) out += this.next();
    return out;
  }
}

function isWhitespace(c) { return c === ' ' || c === '\t'; }
function isBareKey(c) { return /[A-Za-z0-9_-]/.test(c); }

export function parse(toml) {
  if (toml.length === 0) return {};
  const t = T(toml);
  const root = {};
  let current = root;
  while (!t.eof()) {
    skipTrivia(t);
    if (t.eof()) break;
    if (t.peek() === '[') {
      // table header (or array-of-tables [[...]] which we reject)
      t.next(); // consume '['
      if (t.peek() === '[') {
        t.next();
        throw new Error('TOML: arrays of tables ([[...]]) are not supported');
      }
      const keys = parseKeyPath(t);
      expect(t, ']');
      t.next();
      current = ensureTable(root, keys);
      requireLineEnd(t);
    } else {
      // key = value
      const keys = parseKeyPath(t);
      skipTrivia(t);
      expect(t, '=');
      t.next();
      skipTrivia(t);
      const value = parseValue(t);
      assign(current, keys, value);
      requireLineEnd(t);
    }
  }
  return root;
}

function skipTrivia(t) {
  while (!t.eof()) {
    const c = t.cur();
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { t.next(); continue; }
    if (c === '#') {
      // comment until end of line
      while (!t.eof() && t.cur() !== '\n' && t.cur() !== '\r') t.next();
      continue;
    }
    break;
  }
}

function parseKeyPath(t) {
  const parts = [];
  do {
    skipTrivia(t);
    parts.push(parseKeyPart(t));
    skipTrivia(t);
    if (t.cur() === '.') { t.next(); continue; }
    break;
  } while (!t.eof());
  if (parts.length === 0) throw new Error('TOML: expected key');
  return parts;
}

function parseKeyPart(t) {
  const c = t.cur();
  if (c === '"') return parseBasicString(t, true);
  if (c === "'") return parseLiteralString(t, true);
  // bare key
  let out = '';
  while (!t.eof() && isBareKey(t.cur())) out += t.next();
  if (!out) throw new Error(`TOML: invalid key char ${JSON.stringify(t.cur())}`);
  return out;
}

function parseValue(t) {
  skipTrivia(t);
  const c = t.cur();
  if (c === '"') return parseBasicString(t, false);
  if (c === "'") return parseLiteralString(t, false);
  if (c === '[') return parseArray(t);
  if (c === '{') return parseInlineTable(t);
  // scalar until delimiter
  let raw = '';
  while (!t.eof()) {
    const cc = t.cur();
    if (cc === '\n' || cc === '\r' || cc === ',' || cc === '}' || cc === ']' || cc === '#') break;
    if (isWhitespace(cc)) break;
    raw += t.next();
  }
  return parseScalar(raw);
}

function parseScalar(raw) {
  if (raw === '') throw new Error('TOML: empty value');
  const l = raw.toLowerCase();
  if (l === 'true') return true;
  if (l === 'false') return false;
  // int
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  // float (incl. exponents)
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(raw) && !/^0[0-9]/.test(raw.replace(/^[+-]/,''))) {
    const num = Number(raw);
    if (!Number.isNaN(num)) return num;
  }
  // date/time (keep as string)
  if (/^\d{4}-\d{2}-\d{2}([Tt]|\s)\d{2}:\d{2}:\d{2}/.test(raw) || /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw;
  }
  return raw; // bare word fallback as string
}

function parseBasicString(t, isKey) {
  t.next(); // opening "
  if (t.peek() === '"' && t.next() === '"' && t.next() === '"') {
    // multiline basic """
    // line-ending-trim: skip a newline immediately following the opening """
    if (t.cur() === '\n') t.next();
    else if (t.cur() === '\r') { t.next(); if (t.cur() === '\n') t.next(); }
    let out = '';
    while (!t.eof()) {
      const c = t.next();
      if (c === '\\') {
        const e = t.next();
        out += unescapeBasic(e, t);
        continue;
      }
      if (c === '"' && t.peek() === '"' && t.next() === '"' && t.next() === '"') break;
      if (c === '\r' && t.cur() === '\n') { t.next(); out += '\n'; continue; }
      out += c;
    }
    return out;
  }
  // single-line basic
  let out = '';
  while (!t.eof()) {
    const c = t.next();
    if (c === '"') { if (isKey) { break; } else { return out; } }
    if (c === '\\') { const e = t.next(); out += unescapeBasic(e, t); continue; }
    if (c === '\n' || c === '\r') throw new Error('TOML: unterminated basic string');
    out += c;
  }
  return out;
}

function unescapeBasic(e, t) {
  const m = {
    b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\',
    ' ' : ' ', '\t': '\t', '/': '/',
  };
  if (e in m) return m[e];
  if (e === 'u') return readHex(t, 4);
  if (e === 'U') return readHex(t, 8);
  throw new Error(`TOML: invalid escape \\${e}`);
}

function readHex(t, count) {
  let hex = '';
  for (let i = 0; i < count; i++) hex += t.next();
  return String.fromCodePoint(parseInt(hex, 16));
}

function parseLiteralString(t, isKey) {
  t.next(); // opening '
  if (t.peek() === "'" && t.next() === "'" && t.next() === "'") {
    // multiline literal '''
    if (t.cur() === '\n') t.next();
    else if (t.cur() === '\r') { t.next(); if (t.cur() === '\n') t.next(); }
    let out = '';
    while (!t.eof()) {
      const c = t.next();
      if (c === "'" && t.peek() === "'" && t.next() === "'" && t.next() === "'") break;
      out += c;
    }
    return out;
  }
  let out = '';
  while (!t.eof()) {
    const c = t.next();
    if (c === "'") break;
    if (c === '\n' || c === '\r') throw new Error('TOML: unterminated literal string');
    out += c;
  }
  return out;
}

function parseArray(t) {
  t.next(); // [
  const arr = [];
  while (true) {
    skipTrivia(t);
    if (t.cur() === ']') { t.next(); break; }
    if (t.eof()) throw new Error('TOML: unterminated array');
    arr.push(parseValue(t));
    skipTrivia(t);
    if (t.cur() === ',') { t.next(); continue; }
    if (t.cur() === ']') { t.next(); break; }
    if (t.eof()) throw new Error('TOML: unterminated array');
    throw new Error(`TOML: expected ',' or ']' in array, got ${JSON.stringify(t.cur())}`);
  }
  return arr;
}

function parseInlineTable(t) {
  t.next(); // {
  const obj = {};
  while (true) {
    skipTrivia(t);
    if (t.cur() === '}') { t.next(); break; }
    if (t.eof()) throw new Error('TOML: unterminated inline table');
    const keys = parseKeyPath(t);
    skipTrivia(t);
    expect(t, '=');
    t.next();
    const value = parseValue(t);
    assign(obj, keys, value);
    skipTrivia(t);
    if (t.cur() === ',') { t.next(); continue; }
    if (t.cur() === '}') { t.next(); break; }
  }
  return obj;
}

function expect(t, ch) {
  if (t.cur() !== ch) throw new Error(`TOML: expected '${ch}' got ${JSON.stringify(t.cur())} at ${t.pos}`);
}

function requireLineEnd(t) {
  // After a key=value or table header: only skip trailing spaces/tabs on this
  // line (and an optional trailing comment), then require a line boundary.
  // We do NOT consume the newline here; the main loop's skipTrivia() will.
  while (!t.eof() && (t.cur() === ' ' || t.cur() === '\t')) t.next();
  if (t.cur() === '#') {
    while (!t.eof() && t.cur() !== '\n' && t.cur() !== '\r') t.next();
  }
  if (!t.eof() && t.cur() !== '\n' && t.cur() !== '\r') {
    throw new Error(`TOML: expected end of line at ${t.pos}, got ${JSON.stringify(t.cur())}`);
  }
}

function ensureTable(root, keys) {
  let o = root;
  for (const k of keys) {
    if (!(k in o) || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  return o;
}

function assign(table, keys, value) {
  let o = table;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!(k in o) || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  const last = keys[keys.length - 1];
  o[last] = value;
}

export default { parse };
