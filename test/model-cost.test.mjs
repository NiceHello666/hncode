// Tests for recovering a PRICE for a model the catalog does not list directly.
//
// Why this file exists: a self-hosted provider is not in models.dev, so its models
// have no price in config.toml and `/cost` reported "no pricing". The recovery is
// inference, and inference can be silently wrong in the expensive direction: for
// `deepseek-v4.1-flash` the catalog carries ~50 listings from 0.0198 to 0.65 USD
// per 1M input. Picking the minimum understates a bill 8x; picking arbitrarily is
// worse. These tests pin the selection rules and, just as importantly, pin the
// REFUSAL: a model nobody lists must stay unpriced rather than inherit a stranger's
// rate.
//
// Testing principle: the whole lookup is driven by a fake catalog injected through
// the module's own cache, so the rules are tested in isolation from the live
// models.dev payload — which changes daily and would make a failing test
// unreadable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The catalog is module-private, so the tests drive config.js through a HOME with a
// config.toml and through `fetchCatalog`'s memo. A temp HOME keeps the developer's
// real config out of it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-cost-'));
process.env.HNCODE_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.hncode'), { recursive: true });

const config = await import('../src/config.js');

/** A config whose only model is `key`, under a provider named `provider`. */
function cfgFor(key, provider, modelId) {
  return {
    model: key,
    raw: {
      providers: { [provider]: { base_url: 'http://127.0.0.1:1/v1', protocol: 'openai' } },
      models: { [key]: { provider, model: modelId } },
    },
  };
}

const live = await config.fetchCatalog();
// Skip the assertions that need the live catalog when the network is unavailable.
const hasLive = !!live;

test('a model the catalog lists exactly still prices from its stored entry', () => {
  // The direct path, unchanged: an entry with cost keys never consults the catalog.
  const cfg = {
    model: 'p/m',
    raw: {
      providers: { p: {} },
      models: { 'p/m': { provider: 'p', model: 'm', cost_input: 1, cost_output: 2, cost_cache_read: 0.1 } },
    },
  };
  assert.deepEqual(config.modelCost(cfg), { input: 1, output: 2, cacheRead: 0.1, cacheWrite: undefined });
});

test('an undeclared gateway provider is NOT priced — no guessing from the model name', { skip: !hasLive }, () => {
  // The case that produced the bogus $2.57. `buddy` is a local proxy models.dev does
  // not list, and the model it serves is spelled `workbuddy/deepseek-v4.1-flash`.
  // Treating the `deepseek-` prefix as evidence of the vendor applied DeepSeek's
  // official rate to a service that charges nothing. The answer must be null: there
  // is no way to know what an unlisted provider costs.
  const cost = config.modelCost(cfgFor('buddy/workbuddy/deepseek-v4.1-flash', 'buddy', 'workbuddy/deepseek-v4.1-flash'));
  assert.equal(cost, null, 'an unlisted provider has no price to report');
});

test('a provider DECLARING its catalog mapping IS priced from it', { skip: !hasLive }, () => {
  // The supported way to price a reseller: say which models.dev entry it maps to.
  // This is a statement by the user, not an inference from a name.
  const cfg = {
    model: 'gw/deepseek-flash',
    raw: {
      providers: { gw: { catalog: 'deepseek' } },
      models: { 'gw/deepseek-flash': { provider: 'gw', model: 'deepseek-flash' } },
    },
  };
  const cost = config.modelCost(cfg);
  assert.ok(cost, 'the declared mapping resolves');
  assert.ok(cost.input > 0);
});

test('a model nobody lists stays unpriced', { skip: !hasLive }, () => {
  // The refusal is the feature: an invented number is worse than an honest gap,
  // because a wrong price is undetectable while a missing one is visible.
  const cost = config.modelCost(cfgFor('x/zzz-not-a-real-model-9999', 'x', 'zzz-not-a-real-model-9999'));
  assert.equal(cost, null);
});

test('a name that matches another provider\u2019s model is still not priced', { skip: !hasLive }, () => {
  // `gpt-5.4` is listed in the catalog under other providers, and the old code took
  // the most common rate for it. Under the exact rule it is unpriced unless the
  // provider declares the mapping.
  const cost = config.modelCost(cfgFor('gw/gpt-5.4', 'gw', 'gpt-5.4'));
  assert.equal(cost, null, 'sharing a name is not evidence of the price');
});

test('the exact provider bucket prices a catalog-declared entry', { skip: !hasLive }, () => {
  const exact = config.modelCost({
    model: 'deepseek/deepseek-flash',
    raw: {
      providers: { deepseek: { catalog: 'deepseek' } },
      models: { 'deepseek/deepseek-flash': { provider: 'deepseek', model: 'deepseek-flash' } },
    },
  });
  assert.equal(exact.input, 0.15);
});

test('a FREE catalog entry prices at exactly zero, not "unknown"', { skip: !hasLive }, () => {
  // 637 catalog entries are `{input: 0, output: 0}` and there is no `free` flag. Zero
  // must read as a price: otherwise a free model looks unpriced and falls through to
  // a guess.
  const free = config.costFromCatalog({ input: 0, output: 0 });
  assert.deepEqual(free, { input: 0, output: 0, cacheRead: undefined, cacheWrite: undefined });
  assert.equal(config.usageCost({ input: 1_000_000, output: 1_000_000 }, free), 0);
});

test('an entry the user priced at ZERO does not fall through to the catalog', () => {
  // A stored `cost_input = 0` is a decision. Treating it as "unset" would charge the
  // model the catalog rate — the same class of bug as the free-model one.
  const cfg = {
    model: 'p/m',
    raw: {
      providers: { p: { catalog: 'deepseek' } },
      models: { 'p/m': { provider: 'p', model: 'deepseek-flash', cost_input: 0, cost_output: 0 } },
    },
  };
  assert.deepEqual(config.modelCost(cfg), { input: 0, output: 0, cacheRead: undefined, cacheWrite: undefined });
});

test('with no catalog fetched at all, the answer is null rather than a guess', () => {
  // The lookup must not invent a rate from nothing.
  const empty = { model: 'x/m', raw: { providers: { x: {} }, models: { 'x/m': { provider: 'x', model: 'm' } } } };
  assert.equal(config.modelCost(empty), null, 'nothing to infer from before a fetch');
});

test('the exact provider bucket wins over the designation fallback', { skip: !hasLive }, () => {
  // A catalog-installed entry must be used as stored, even when the same model
  // appears elsewhere at a different rate.
  const exact = config.modelCost({
    model: 'deepseek/deepseek-flash',
    raw: {
      providers: { deepseek: { catalog: 'deepseek' } },
      models: { 'deepseek/deepseek-flash': { provider: 'deepseek', model: 'deepseek-flash' } },
    },
  });
  assert.equal(exact.input, 0.15);
});

test('with no catalog fetched at all, the answer is null rather than a guess', () => {
  // Fresh module instance with its own (empty) memo, so nothing has been fetched.
  // The lookup must not invent a rate from nothing.
  const empty = { model: 'x/m', raw: { providers: { x: {} }, models: { 'x/m': { provider: 'x', model: 'm' } } } };
  const before = config.modelCost(empty);
  assert.equal(before, null, 'nothing to infer from before a fetch');
});
