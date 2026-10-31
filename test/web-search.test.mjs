// WebSearch reads a JSON API, and reports a genuine empty result as empty.
//
// WHY THIS FILE EXISTS
// --------------------
// This tool used to scrape Bing's HTML for `<li class="b_algo">` blocks. It did not fail loudly
// when that stopped working — the request still returned 200 and the page still echoed the query
// in its `<title>`, so the parser happily returned the two or three unrelated entries it found
// (`translate.google.cn`, `baike.baidu.com`). Five identical requests for one query produced five
// different first results, none of them related to the query, and the model used them as facts.
//
// A scraper that goes wrong returns PLAUSIBLE JUNK. A JSON API that has nothing can say so. That
// difference is the whole point of the switch, and these tests hold both halves of it: the shape
// is read correctly, and "no results" is never dressed up as a successful search.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const { parseSearchResults, spec } = await import('../src/tools/web-search.js');

/**
 * Run `fn` with `fetch` replaced by `stub`, and restore it afterwards.
 *
 * Restoring in a `finally` matters: a stub left in place would make every later test in the file
 * "succeed" against the wrong reply.
 */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** A fetch stub that answers with `body` and status 200. */
function stub(body) {
  return async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => body });
}

// ---------------------------------------------------------------------------
// reading the payload
// ---------------------------------------------------------------------------

test('results are read from the API payload', () => {
  const json = {
    results: [
      { title: 'First', url: 'https://a.example/', description: 'one' },
      { title: 'Second', url: 'https://b.example/', description: 'two' },
    ],
  };
  const out = parseSearchResults(json);
  assert.deepEqual(out, [
    { title: 'First', url: 'https://a.example/', snippet: 'one' },
    { title: 'Second', url: 'https://b.example/', snippet: 'two' },
  ]);
});

test('a result the model cannot open is dropped', () => {
  // A result with no URL is not usable — it cannot be fetched or cited — so it must not be shown.
  const out = parseSearchResults({
    results: [
      { title: 'no url', description: 'x' },
      { title: 'empty url', url: '', description: 'x' },
      { title: 'fine', url: 'https://ok.example/', description: 'x' },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://ok.example/');
});

test('a missing snippet becomes an empty string, not "undefined"', () => {
  const out = parseSearchResults({ results: [{ title: 't', url: 'https://e.example/' }] });
  assert.equal(out[0].snippet, '');
  assert.doesNotMatch(JSON.stringify(out), /undefined/);
});

test('a title falls back to the URL rather than showing nothing', () => {
  const out = parseSearchResults({ results: [{ url: 'https://bare.example/' }] });
  assert.equal(out[0].title, 'https://bare.example/');
});

test('a payload of the wrong shape yields no results instead of throwing', () => {
  // The service publishes no schema, so a rename or an error body must degrade, not crash a turn.
  for (const bad of [null, {}, { results: null }, { results: 'nope' }, { error: 'rate limited' }]) {
    assert.deepEqual(parseSearchResults(bad), [], `for ${JSON.stringify(bad)}`);
  }
});

test('the result count is capped', () => {
  const many = { results: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, url: `https://e${i}.example/` })) };
  assert.equal(parseSearchResults(many, 8).length, 8);
  assert.equal(parseSearchResults(many, 3).length, 3);
});

// ---------------------------------------------------------------------------
// what the tool tells the model
// ---------------------------------------------------------------------------

test('an empty result set is reported as such', async () => {
  // Never presented as a successful search. The old scraper could not tell "no results" from
  // "the page changed", which is how unrelated content ended up looking like an answer.
  const body = JSON.stringify({ results: [], total: 0, hasNext: false, page: 1 });
  const out = await withFetch(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    () => spec.execute({ query: 'nothing here' }, {}));
  assert.match(out, /No search results found/);
  assert.doesNotMatch(out, /^\d+\./, 'and it does not invent numbered results');
});

test('a non-JSON response is named as such rather than parsed', async () => {
  // If the endpoint ever answers with a page or a proxy error, say so. Parsing it as results is
  // exactly the mistake that made the scraper look healthy while returning junk.
  const out = await withFetch(async () => new Response('<html>blocked</html>', { status: 200 }),
    () => spec.execute({ query: 'x' }, {}));
  assert.match(out, /non-JSON/);
});

test('an HTTP error is reported with its status', async () => {
  const out = await withFetch(async () => new Response('', { status: 503, statusText: 'Service Unavailable' }),
    () => spec.execute({ query: 'x' }, {}));
  assert.match(out, /503/);
});

test('a network failure is reported, not thrown', async () => {
  const out = await withFetch(async () => { throw new Error('ECONNREFUSED'); },
    () => spec.execute({ query: 'x' }, {}));
  assert.match(out, /ECONNREFUSED/);
});

test('a successful search numbers its results with title, url and snippet', async () => {
  const body = JSON.stringify({
    results: [{ title: 'Hit', url: 'https://hit.example/', description: 'a summary' }],
    hasNext: false,
  });
  const out = await withFetch(async () => new Response(body, { status: 200 }),
    () => spec.execute({ query: 'anything' }, {}));
  assert.match(out, /^1\. Hit$/m);
  assert.match(out, /https:\/\/hit\.example\//);
  assert.match(out, /a summary/);
});

test('a successful search numbers its results', async () => {
  const body = JSON.stringify({
    results: [{ title: 'a', url: 'https://a.example/', content: 'snip' }],
  });
  const out = await withFetch(stub(body), () => spec.execute({ query: 'q' }, {}));
  assert.match(out, /^1\. a/);
  assert.match(out, /https:\/\/a\.example\//);
  assert.match(out, /snip/);
});

test('the request is a POST with the keyless header', async () => {
  let seen = null;
  const body = JSON.stringify({ results: [{ title: 'a', url: 'https://a.example/' }] });
  const stubFn = async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, statusText: 'OK', text: async () => body };
  };
  await withFetch(stubFn, () => spec.execute({ query: 'a b&c=d' }, {}));
  assert.match(seen.url, /tavily\.com\/search/, 'the Tavily endpoint is what it calls');
  assert.equal(seen.init.method, 'POST', 'a POST, because keyless mode is not offered on a GET');
  assert.equal(seen.init.headers['X-Tavily-Access-Mode'], 'keyless', 'the header that selects it');
  assert.equal(JSON.parse(seen.init.body).query, 'a b&c=d', 'the query travels in the body, unencoded');
});

test("the API's own answer is labelled as a summary, not a source", async () => {
  const body = JSON.stringify({
    answer: 'Doutula is a Chinese meme site.',
    results: [{ title: 'a', url: 'https://a.example/', content: 'snip' }],
  });
  const out = await withFetch(stub(body), () => spec.execute({ query: 'q' }, {}));
  assert.match(out, /Summary \(from the search API, not a source\)/);
  assert.ok(out.indexOf('Summary') < out.indexOf('1. a'), 'the summary comes before the sources');
});
