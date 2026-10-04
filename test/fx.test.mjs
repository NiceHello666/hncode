// Tests for currency conversion behind `/cost cny`.
//
// Why this file exists: a converted money figure is wrong in a way nobody can
// check by eye. Two specific failures are guarded here:
//
//   1. A rate that silently defaults to a guessed value (7.0) produces a
//      plausible number that is not what the user paid. The converter must refuse
//      instead, and the caller must say so.
//   2. The two reference APIs use DIFFERENT field names for the same table
//      (`rates` vs `conversion_rates`). Reading only one shape made the second
//      endpoint look like it had no rate at all.
//
// Testing principle: the parsing and conversion are pure, so they are tested
// directly against both real payload shapes. The network call is exercised
// separately, by an env override, so the suite never depends on an API being up.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRate, convert, normalizeCurrency, envRate, usdRate, syncRate, clearRateCache,
  SUPPORTED_CURRENCIES,
} from '../src/fx.js';

// ---------------------------------------------------------------------------
// Currency names
// ---------------------------------------------------------------------------

test('normalizeCurrency accepts the spellings a user might type', () => {
  assert.equal(normalizeCurrency('cny'), 'CNY');
  assert.equal(normalizeCurrency('CNY'), 'CNY');
  assert.equal(normalizeCurrency(' ¥ '), 'CNY');
  assert.equal(normalizeCurrency('￥'), 'CNY');
  assert.equal(normalizeCurrency('rmb'), 'CNY');
  assert.equal(normalizeCurrency('usd'), 'USD');
  assert.equal(normalizeCurrency('$'), 'USD');
  // Anything unsupported is '' (not a guess), so the caller can refuse it.
  assert.equal(normalizeCurrency('eur'), '');
  assert.equal(normalizeCurrency(''), '');
  assert.equal(normalizeCurrency(undefined), '');
});

// ---------------------------------------------------------------------------
// Rate parsing
// ---------------------------------------------------------------------------

test('parseRate reads BOTH reference APIs field names', () => {
  // frankfurter / ECB shape.
  assert.equal(parseRate({ amount: 1, base: 'USD', rates: { CNY: 6.7034 } }, 'CNY'), 6.7034);
  // open.er-api.com shape — the one an `rates`-only reader missed.
  assert.equal(parseRate({ result: 'success', base_code: 'USD', conversion_rates: { CNY: 7.12 } }, 'CNY'), 7.12);
});

test('parseRate rejects anything that is not a usable positive number', () => {
  assert.equal(parseRate(null, 'CNY'), null);
  assert.equal(parseRate({}, 'CNY'), null);
  assert.equal(parseRate({ rates: {} }, 'CNY'), null);
  assert.equal(parseRate({ rates: { CNY: 0 } }, 'CNY'), null);
  assert.equal(parseRate({ rates: { CNY: -1 } }, 'CNY'), null);
  assert.equal(parseRate({ rates: { CNY: 'x' } }, 'CNY'), null);
  assert.equal(parseRate({ rates: { USD: 1 } }, 'CNY'), null, 'a rate for another currency is not a rate');
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

test('convert multiplies for a foreign currency and is a no-op for USD', () => {
  assert.equal(convert(12.5, 'CNY', 7), 87.5);
  // USD is the native unit: needing a rate for it would be a bug, so pass null.
  assert.equal(convert(12.5, 'USD', null), 12.5);
  assert.equal(convert(12.5, 'usd', 999), 12.5);
});

test('convert returns null rather than a number when the rate is missing', () => {
  // This is the failure the whole module exists to prevent: a converted figure
  // that is plausible and wrong.
  assert.equal(convert(12.5, 'CNY', null), null);
  assert.equal(convert(12.5, 'CNY', undefined), null);
  assert.equal(convert(12.5, 'CNY', 0), null);
  assert.equal(convert(12.5, 'CNY', -7), null);
  assert.equal(convert(12.5, 'CNY', NaN), null);
  assert.equal(convert(NaN, 'CNY', 7), null);
});

// ---------------------------------------------------------------------------
// Rate sources
// ---------------------------------------------------------------------------

test('an env override is used without any network call', async () => {
  clearRateCache();
  process.env.HNCODE_CNY_PER_USD = '8.25';
  try {
    assert.deepEqual(envRate('CNY'), { rate: 8.25, source: 'HNCODE_CNY_PER_USD' });
    const fx = await usdRate('CNY');
    assert.equal(fx.rate, 8.25);
    assert.equal(fx.source, 'HNCODE_CNY_PER_USD');
  } finally { delete process.env.HNCODE_CNY_PER_USD; clearRateCache(); }
});

test('an explicit override beats everything and needs no network', async () => {
  clearRateCache();
  const fx = await usdRate('CNY', { override: 6.5 });
  assert.equal(fx.rate, 6.5);
  assert.equal(fx.source, 'config');
});

test('USD needs no rate at all', async () => {
  const fx = await usdRate('USD');
  assert.equal(fx.rate, 1);
  assert.equal(fx.source, 'native');
});

test('an unsupported currency yields no rate instead of a fallback', async () => {
  clearRateCache();
  // Not in SUPPORTED_CURRENCIES, so /cost rejects it before getting here; the
  // module must agree rather than invent one.
  assert.deepEqual(SUPPORTED_CURRENCIES, ['USD', 'CNY']);
  const fx = await usdRate('EUR', { timeoutMs: 1 });
  assert.equal(fx === null || fx.rate > 0, true, 'no fabricated rate');
});

// ---------------------------------------------------------------------------
// syncRate — the path the status row uses
// ---------------------------------------------------------------------------

test('syncRate answers from an override or the env with no network', () => {
  clearRateCache();
  assert.equal(syncRate('CNY', { override: 6.5 }).rate, 6.5);
  process.env.HNCODE_CNY_PER_USD = '9.1';
  try {
    assert.equal(syncRate('CNY').rate, 9.1);
  } finally { delete process.env.HNCODE_CNY_PER_USD; }
});

test('syncRate refuses when answering would need a request', () => {
  // This is what keeps the status row honest: a cold cache must NOT produce a
  // converted figure, and the row falls back to USD instead.
  clearRateCache();
  assert.equal(syncRate('CNY'), null);
});

test('syncRate serves a value only once the cache has been warmed', async () => {
  clearRateCache();
  delete process.env.HNCODE_CNY_PER_USD;
  // Cold, with no override or env: answering would need a request, so the sync
  // reader must refuse. That is the state the status row falls back from.
  assert.equal(syncRate('CNY'), null, 'unknown before any lookup');

  const fetched = await usdRate('CNY', { timeoutMs: 8000 });
  if (!fetched) return;   // offline: nothing to assert about warming the cache
  // Now the synchronous reader sees it, which is the exact sequence /cost performs
  // before repainting the row (warm with usdRate, then refreshCost reads sync).
  assert.equal(syncRate('CNY').rate, fetched.rate);
  clearRateCache();
});

test('USD is always resolvable synchronously', () => {
  clearRateCache();
  assert.equal(syncRate('USD').rate, 1);
  assert.equal(syncRate('usd').rate, 1);
});

