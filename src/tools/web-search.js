// WebSearch tool — search the web through puri.li's JSON API.
//
// WHY NOT A SCRAPED SEARCH PAGE
// -----------------------------
// This used to fetch Bing's HTML and parse `<li class="b_algo">` blocks. That worked until it
// silently stopped: the request still returned 200 with the query echoed in `<title>`, but the
// page contained no results — the two or three `b_algo` blocks it did have were
// `translate.google.cn` and similar chrome, unrelated to the query. Measured over five identical
// requests for one query: five different first results (Yandex, GitHub, 知乎, PixelOS, Nature),
// none of them related. Adding a market parameter, warming up cookies, and sending a full set of
// browser headers all changed nothing.
//
// The failure mode is what made this urgent. A scraper that returns junk does not look broken to
// the model — the results arrive in the normal shape, so they get used and cited. A JSON API that
// answers with `results: []` can at least be reported honestly.

const ENDPOINT = 'https://puri.li/api/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * The API's payload, as a list of results.
 *
 * Tolerant on purpose: this is a third-party service with no published schema, so a missing or
 * renamed field must degrade to "fewer results" rather than throw. `description` is the snippet;
 * an entry without a URL is dropped, because a result the model cannot open is not usable.
 */
export function parseSearchResults(json, limit = 8) {
  const list = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    out.push({
      title: String(r.title || r.url).trim(),
      url: r.url,
      snippet: String(r.description || r.snippet || '').replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export const spec = {
  name: 'WebSearch',
  description: 'Search the web. Results are title/URL/snippet; snippets are summaries, so fetch a promising URL with FetchURL. Cite sources.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      page: { type: 'integer', description: 'Page number, 1-based. Defaults to 1.' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) return 'Error: query must not be empty.';
    const page = Math.max(1, Math.trunc(Number(args.page)) || 1);
    const signal = (ctx && ctx.signal) || undefined;
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&page=${page}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal,
      });
      if (!res.ok) return `Error: search failed (${res.status} ${res.statusText}).`;
      // The endpoint answers with JSON. If it ever does not, say so rather than parsing a page.
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { return `Error: search returned a non-JSON response (${text.length} bytes) for "${query}".`; }

      const results = parseSearchResults(json, 8);
      if (!results.length) {
        // A genuine empty result set, NOT an error. The old scraper could not tell the two apart,
        // which is why a broken page looked like a successful search with odd results.
        return page > 1
          ? `No search results found for: ${query} (page ${page}).`
          : `No search results found for: ${query}`;
      }
      const more = json && json.hasNext ? `\n\nMore results available: call WebSearch again with page=${page + 1}.` : '';
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n') + more;
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'interrupted' : (e.message || String(e));
      return `Error searching "${query}": ${msg}`;
    }
  },
};
