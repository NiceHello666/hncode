// Shared glob matching used by Glob, Grep and the .gitignore matcher.
// Semantics: `*` matches within a path segment; `**` (optionally followed by `/`)
// matches across segments; `?` matches one non-separator char; `[class]` char
// classes; `{a,b}` brace expansion. `/` is the path separator used for matching.

export function expandBraces(str) {
  const i = str.indexOf('{');
  if (i === -1) return [str];
  let depth = 1, j = i + 1, parts = [], part = '', ok = false;
  while (j < str.length && depth > 0) {
    const c = str[j];
    if (c === '{') { depth++; part += c; }
    else if (c === '}') { depth--; if (depth === 0) { parts.push(part); ok = true; break; } else part += c; }
    else if (c === ',' && depth === 1) { parts.push(part); part = ''; }
    else part += c;
    j++;
  }
  if (!ok) return [str];
  const out = [];
  const before = str.slice(0, i), after = str.slice(j + 1);
  for (const p of parts) {
    for (const b of expandBraces(before)) for (const pp of expandBraces(p)) for (const a of expandBraces(after)) out.push(b + pp + a);
  }
  return out;
}

function escapeRegex(c) {
  return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c;
}

export function globToRegexSource(pattern) {
  let src = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      src += '[\\s\\S]*'; i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') {
      src += '[^/]*';
    } else if (c === '?') {
      src += '[^/]';
    } else if (c === '[') {
      let j = i + 1, negated = false;
      if (pattern[j] === '!' || pattern[j] === '^') { negated = true; j++; }
      let body = '';
      while (j < pattern.length && pattern[j] !== ']') body += pattern[j++];
      if (pattern[j] === ']') {
        if (negated) body = '/' + body;
        src += negated ? '[^' + body + ']' : '[' + body + ']';
        i = j;
      } else {
        src += escapeRegex(c);
      }
    } else {
      src += escapeRegex(c);
    }
  }
  return src + '$';
}

// Match the whole string against a single pattern (anchored, like globToRegex).
export function globRegex(pattern) {
  const alts = expandBraces(pattern);
  if (alts.length === 1) return new RegExp('^' + globToRegexSource(alts[0]));
  return new RegExp('^(?:' + alts.map(globToRegexSource).join('|') + ')');
}

// True if `s` matches `pattern` (full match on `s`).
export function matchGlob(pattern, s) {
  return globRegex(pattern).test(s);
}
