// Synchronise src/i18n.js into the browser bundle.
//
// The strings live in ONE module (src/i18n.js) because the server returns some of
// them (error text, the login page) and the browser renders the rest. Duplicating
// the table by hand is how the two end up disagreeing — a Chinese terminal and an
// English page for the same session. This script rewrites web-public/i18n.js from
// the module, so there is exactly one source.
//
// Run: node tools/sync-i18n.mjs [--check]
//   --check  exits non-zero when the generated file is out of date (for CI).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES, LANGUAGES, DEFAULT_LANG } from '../src/i18n.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src', 'web-public', 'i18n.js');

const body = [
  // No header comment: this file is a build artefact served verbatim to the
  // browser, so anything written here is visible in devtools. The generator's
  // identity is recorded in this script and in the README, not in the payload.
  'export const LANGUAGES = ' + JSON.stringify(LANGUAGES, null, 2) + ';',
  '',
  'export const DEFAULT_LANG = ' + JSON.stringify(DEFAULT_LANG) + ';',
  '',
  'export const MESSAGES = ' + JSON.stringify(MESSAGES, null, 2) + ';',
  '',
  'export function t(lang, key, vars) {',
  '  const entry = MESSAGES[key];',
  '  if (!entry) return key;',
  '  let s = entry[lang] || entry[DEFAULT_LANG] || entry.en || key;',
  '  if (vars) {',
  "    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));",
  '  }',
  '  return s;',
  '}',
  '',
  'export function catalog(lang) {',
  '  const out = {};',
  '  for (const key of Object.keys(MESSAGES)) out[key] = t(lang, key);',
  '  return out;',
  '}',
  '',
].join('\n');

const check = process.argv.includes('--check');
let current = '';
try { current = fs.readFileSync(OUT, 'utf8'); } catch { /* not generated yet */ }

if (current === body) {
  console.log('web-public/i18n.js is up to date.');
  process.exit(0);
}
if (check) {
  console.error('web-public/i18n.js is OUT OF DATE — run: node tools/sync-i18n.mjs');
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body, 'utf8');
console.log('wrote ' + path.relative(process.cwd(), OUT) + ' (' + Object.keys(MESSAGES).length + ' messages)');
