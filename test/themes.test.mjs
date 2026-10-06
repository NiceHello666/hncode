// Every theme is complete, distinct, labelled, and reachable from /settings.
//
// WHY A TEST FOR PALETTES
// -----------------------
// A theme that omits a field does not fail — `setTheme` guards each assignment, so the
// missing colour silently stays whatever the PREVIOUSLY applied theme put there. That makes
// a half-specified theme look correct until you happen to switch away from one specific
// theme, which is the worst way for it to fail. These assertions are about coverage and
// reachability, not about whether the colours are pretty.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as colors from '../src/colors.js';
import { SETTING_BY_KEY, coerceSetting } from '../src/settings-schema.js';

// `surface` has no `C` counterpart of its own: `setTheme` turns it into `bgPanel`.
const TABLE_FIELDS = [
  'fg', 'bg', 'teal', 'cyan', 'blue', 'border',
  'hover', 'selBg', 'red', 'green', 'yellow', 'orange',
  'white', 'gray', 'surface',
];

// The themes that paint on a light background. `auto` picks between them from the probe.
const LIGHT = new Set(['light', 'solar']);

test('every theme applies and leaves the palette fully set', () => {
  for (const name of colors.THEME_NAMES) {
    assert.equal(colors.setTheme(name), true, `${name}: setTheme refused it`);
    const missing = ['white', 'gray', 'red', 'green', 'yellow', 'orange', 'bgPanel', 'fg', 'selBg']
      .filter((k) => typeof colors.C[k] !== 'string' || !colors.C[k]);
    assert.deepEqual(missing, [], `${name}: C.${missing.join(', C.')} still unset after apply`);
  }
});

test('every theme defines every field', () => {
  // Read the TABLE, not `C`: `C` is the applied palette, so a field that was never set
  // reads as whatever the previously applied theme left there — the very bug this catches.
  // `THEMES` is not exported, so the source is parsed; the assertion is about the text.
  const src = readFileSync(new URL('../src/colors.js', import.meta.url), 'utf8');
  const body = /^const THEMES = \{([\s\S]*?)\n\};/m.exec(src);
  assert.ok(body, 'THEMES not found in colors.js');

  for (const name of colors.THEME_NAMES) {
    if (name === 'auto') continue;                 // a choice, not a table
    const block = new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`).exec(body[1]);
    assert.ok(block, `${name} has no entry in THEMES`);
    for (const field of TABLE_FIELDS) {
      assert.match(block[1], new RegExp(`(^|[\\s{,])${field}:`), `${name}.${field} is not defined`);
    }
  }
});

test('no two palettes are the same', () => {
  // A duplicate is a theme the user can pick and see no change. `auto` is excluded because
  // it RESOLVES to light or dark — on a dark terminal it IS dark, by design.
  const seen = new Map();
  for (const name of colors.THEME_NAMES) {
    if (name === 'auto') continue;
    colors.setTheme(name);
    const sig = [colors.C.fg, colors.C.teal, colors.C.bg, colors.C.border].join('|');
    assert.equal(seen.has(sig), false, `${name} renders exactly like ${seen.get(sig)}`);
    seen.set(sig, name);
  }
  assert.equal(seen.size, colors.THEME_NAMES.length - 1);
});

test('every theme has a label, and every label names a theme', () => {
  for (const n of colors.THEME_NAMES) {
    assert.ok(colors.THEME_LABELS[n], `${n} has no label`);
  }
  for (const n of Object.keys(colors.THEME_LABELS)) {
    assert.ok(colors.THEME_NAMES.includes(n), `${n} has a label but no palette`);
  }
});

test('the light/dark classification is right, since auto depends on it', () => {
  for (const n of colors.THEME_NAMES) {
    if (n === 'auto') continue;
    assert.equal(colors.isLightTheme(n), LIGHT.has(n), `${n} is classified wrong`);
  }
});

test('auto resolves to a real palette and follows the terminal', () => {
  colors.setLightBackground(false);
  colors.setTheme('auto');
  const onDark = [colors.C.fg, colors.C.bg].join('|');
  assert.equal(colors.isLightTheme('auto'), false);

  colors.setLightBackground(true);
  colors.setTheme('auto');
  const onLight = [colors.C.fg, colors.C.bg].join('|');
  assert.equal(colors.isLightTheme('auto'), true);

  assert.notEqual(onDark, onLight, 'auto must not be one fixed palette');

  colors.setTheme('dark');
  assert.equal([colors.C.fg, colors.C.bg].join('|'), onDark, 'auto on a dark terminal IS dark');
  colors.setLightBackground(false);
});

test('/settings offers exactly the themes that exist', () => {
  const values = SETTING_BY_KEY.get('theme').values;
  for (const n of colors.THEME_NAMES) {
    assert.ok(values.includes(n), `/settings omits ${n}`);
    assert.equal(coerceSetting('theme', n).ok, true, `/settings would reject ${n}`);
  }
  for (const v of values) {
    assert.ok(colors.hasTheme(v), `/settings offers unknown theme ${v}`);
  }
});

test('currentTheme reports the CONCRETE theme auto resolved to', () => {
  // The render cache keys on this, so `auto` has to report the palette actually in force —
  // reporting `auto` would make a light/dark switch look like no change at all.
  colors.setLightBackground(false);
  colors.setTheme('auto');
  assert.equal(colors.currentTheme(), 'dark');
  colors.setLightBackground(true);
  colors.setTheme('auto');
  assert.equal(colors.currentTheme(), 'light');
  colors.setLightBackground(false);
});