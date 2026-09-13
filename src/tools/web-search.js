// WebSearch tool — search the web via Bing's HTML endpoint (no API key needed).

import { htmlToText } from './fetch-url.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&middot;/gi, '·')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// Parse Bing's HTML into { title, url, snippet } results.
export function parseBingResults(html, limit = 8) {
  const out = [];
  const blocks = String(html).match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  for (const block of blocks) {
    const href = (block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/) || [])[1];
    if (!href) continue;
    const titleHtml = (block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    const title = decodeEntities(titleHtml.replace(/<[^>]+>/g, '')).trim();
    // Snippet lives in <p> or a caption div; fall back to stripped block text.
    let snippet = (block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1]
      || (block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) || [])[1]
      || '';
    snippet = decodeEntities(snippet.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!snippet) snippet = htmlToText(block).replace(/\s+/g, ' ').slice(0, 240);
    out.push({ title: title || href, url: href, snippet });
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
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) return 'Error: query must not be empty.';
    const signal = (ctx && ctx.signal) || undefined;
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=en';
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal,
      });
      if (!res.ok) return `Error: search failed (${res.status} ${res.statusText}).`;
      const html = await res.text();
      const results = parseBingResults(html, 8);
      if (!results.length) return `No search results found for: ${query}`;
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'interrupted' : (e.message || String(e));
      return `Error searching "${query}": ${msg}`;
    }
  },
};