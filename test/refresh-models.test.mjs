// Tests for the model-refresh merge (mergeRefreshedModelEntry).
//
// Ctrl+R in /provider REPLACES a provider's model entries wholesale, but the
// source (models.dev catalog or /v1/models) does not report every field for
// every model. These tests pin the rule that makes that safe:
//
//   what the source REPORTED    -> wins (that is what a refresh is for)
//   what it did NOT report      -> keeps the value the entry already had
//
// Without the second half a refresh overwrote user settings with nothing — most
// visibly `context_length`, which then resolved back to the default window.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeRefreshedModelEntry } from '../src/tui.js';
import { replaceProviderModels } from '../src/config.js';

// A fully-tuned entry, as the /model editor and earlier sessions leave it.
const userEntry = () => ({
  provider: 'prov',
  model: 'm',
  display_name: 'My Tuned Model',
  context_length: 200000,
  max_tokens: 32000,
  max_output_tokens: 64000,
  reasoning: true,
  efforts: ['off', 'low', 'high'],
  cost_input: 1,
  cost_output: 2,
  cost_cache_read: 0.5,
  cost_cache_write: 1.25,
  ownedBy: 'someone',
});

test('fields the source did not report keep the previous values (context_length survives)', () => {
  // The case the bug came from: the source lists the model but says nothing
  // about limits — the user's window must NOT be wiped to empty.
  const entry = mergeRefreshedModelEntry('prov', { id: 'm', display: 'Fresh' }, userEntry());
  assert.equal(entry.context_length, 200000, 'the user-set window must not be wiped');
  assert.equal(entry.max_tokens, 32000);
  assert.equal(entry.max_output_tokens, 64000);
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.efforts, ['off', 'low', 'high']);
  assert.equal(entry.cost_input, 1);
  assert.equal(entry.cost_cache_read, 0.5);
  assert.equal(entry.ownedBy, 'someone');
  assert.equal(entry.display_name, 'Fresh', 'a reported field still wins');
});

test('reported values win over the previous ones (a refresh still refreshes)', () => {
  const entry = mergeRefreshedModelEntry('prov', {
    id: 'm',
    display: 'Newer Name',
    limit: { context: 400000, output: 16000 },
    reasoning: false,
    cost: { input: 3, output: 4 },
  }, userEntry());
  assert.equal(entry.display_name, 'Newer Name');
  assert.equal(entry.context_length, 400000);
  assert.equal(entry.max_output_tokens, 16000);
  assert.equal(entry.reasoning, false, 'an explicit false must win over the old true');
  assert.equal(entry.cost_input, 3);
  assert.equal(entry.cost_output, 4);
  assert.equal(entry.cost_cache_read, 0.5, 'a partial cost report must not blank the rest');
});

test('legacy camelCase keys are folded into canonical ones and cannot shadow them', () => {
  // resolveConfig checks `contextLength` BEFORE `context_length`. A stale
  // camelCase copy left beside the fresh value would win and report the OLD
  // window, so the merge must emit exactly one spelling per field.
  const prev = {
    provider: 'prov', model: 'm',
    contextLength: 100000, maxTokens: 8000, displayName: 'Old',
  };
  const refreshed = mergeRefreshedModelEntry('prov', { id: 'm', limit: { context: 400000 } }, prev);
  assert.equal(refreshed.context_length, 400000, 'the fetched value wins');
  assert.ok(!('contextLength' in refreshed), 'the stale camelCase key must be gone');
  assert.equal(refreshed.max_tokens, 8000, 'unreported camelCase values fold into canonical keys');
  assert.ok(!('maxTokens' in refreshed));
  assert.equal(refreshed.display_name, 'Old');

  // And with nothing fetched, the camelCase value survives under the canonical key.
  const kept = mergeRefreshedModelEntry('prov', { id: 'm' }, prev);
  assert.equal(kept.context_length, 100000);
  assert.equal(kept.max_tokens, 8000);
  assert.equal(kept.display_name, 'Old');
});

test("the source's own thinking levels win; absent them the old list stays", () => {
  const withOpts = mergeRefreshedModelEntry('prov', {
    id: 'm',
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  }, userEntry());
  assert.deepEqual(withOpts.efforts, ['low', 'medium', 'high'], "the catalog's list replaces the old one");

  const withoutOpts = mergeRefreshedModelEntry('prov', { id: 'm' }, userEntry());
  assert.deepEqual(withoutOpts.efforts, ['off', 'low', 'high'], 'no source data must not drop the list');
});

test('with no previous entry the merge is simply the fetched data', () => {
  const entry = mergeRefreshedModelEntry('prov', { id: 'm', display: 'D', limit: { context: 128000 } }, undefined);
  assert.equal(entry.provider, 'prov');
  assert.equal(entry.model, 'm');
  assert.equal(entry.display_name, 'D');
  assert.equal(entry.context_length, 128000);
  assert.equal(entry.max_tokens, undefined);
  assert.equal(entry.reasoning, undefined);
});

test('the merged values are what reaches config.toml (not the raw fetch)', () => {
  // refreshProviderModels builds its `persisted` list from the merged entry and
  // hands it to replaceProviderModels. Persisting the raw fetch here would
  // re-wipe on disk what the merge just preserved in memory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-refresh-'));
  const file = path.join(dir, 'config.toml');
  const prevEnv = process.env.HNCODE_CONFIG;
  process.env.HNCODE_CONFIG = file;
  try {
    fs.writeFileSync(file, '', 'utf8');
    const entry = mergeRefreshedModelEntry('prov', { id: 'm' }, {
      provider: 'prov', model: 'm', display_name: 'Tuned',
      context_length: 200000, max_output_tokens: 64000,
    });
    replaceProviderModels('prov', [{
      id: entry.model,
      display_name: entry.display_name,
      contextLength: entry.context_length,
      maxTokens: entry.max_tokens,
      maxOutputTokens: entry.max_output_tokens,
      reasoning: entry.reasoning,
      efforts: entry.efforts,
      cost: {
        input: entry.cost_input,
        output: entry.cost_output,
        cacheRead: entry.cost_cache_read,
        cacheWrite: entry.cost_cache_write,
      },
    }]);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /context_length = 200000/, 'the context window must survive to disk');
    assert.match(text, /max_output_tokens = 64000/);
    assert.match(text, /display_name = "Tuned"/);
  } finally {
    if (prevEnv === undefined) delete process.env.HNCODE_CONFIG;
    else process.env.HNCODE_CONFIG = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
