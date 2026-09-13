// FetchURL tool — fetch a web page's main text content (Node built-in fetch, no deps).

import os from 'node:os';

const MAX_BYTES = 200 * 1024; // generous cap for large pages

// Strip HTML tags and collapse whitespace into readable plain text.
export function htmlToText(html) {
  let s = String(html || '');
  // Drop script/style contents entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // Replace block-level tags with newlines so paragraphs survive.
  s = s.replace(/<(br|p|div|li|h[1-6]|tr|section|article|blockquote)[^>]*>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|ul|ol)>/gi, '\n');
  // Decode a few common entities to ASCII.
  s = s.replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–');
  // Remove any remaining tags and collapse whitespace.
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return s;
}

// Reject non-http(s) URLs. No SSRF guard: hncode is a local tool the user
// controls, the model may legitimately fetch a localhost service or intranet
// page, and Bash can already run anything. Only enforce http/https.
function rejectUrl(raw) {
  if (!raw || typeof raw !== 'string') return 'Error: url must be a non-empty string.';
  let u;
  try { u = new URL(raw.trim()); } catch { return `Error: invalid URL: ${raw}`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `Error: only http/https URLs are supported (got ${u.protocol}//).`;
  }
  return null; // ok
}

export const spec = {
  name: 'FetchURL',
  description: 'Fetch a URL and return its text (main page text, or the full body; a leading note says which). Any http/https URL, including localhost.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch.' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    const rejected = rejectUrl(args.url);
    if (rejected) return rejected;
    const signal = (ctx && ctx.signal) || undefined;
    try {
      const res = await fetch(args.url.trim(), { signal, redirect: 'follow' });
      if (!res.ok) {
        return `Error: ${res.status} ${res.statusText} from ${args.url}`;
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      let isTruncated = false;
      let body;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        while (got < MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (got >= MAX_BYTES) { isTruncated = true; break; }
        }
        if (isTruncated) { try { await reader.cancel(); } catch {} }
        body = Buffer.concat(chunks);
      } else {
        body = Buffer.from(await res.arrayBuffer());
      }

      let text;
      if (isHtml) {
        text = htmlToText(body.toString('utf8'));
      } else if (contentType.includes('json')) {
        text = 'The returned content is the full response body, returned verbatim:\n\n' + body.toString('utf8');
      } else if (contentType.includes('text/')) {
        text = body.toString('utf8');
      } else {
        const type = contentType.split(';')[0] || 'unknown';
        return `The response is binary (content-type: ${type}); no text content to return.`;
      }
      if (!text || !text.trim()) text = 'The response body is empty.';
      let out = isHtml
        ? 'The returned content is the main text extracted from the page.\n\n'
        : 'The returned content is the full response body, returned verbatim.\n\n';
      out += text;
      if (isTruncated) out += `\n\n[... truncated; page larger than ${Math.round(MAX_BYTES / 1024)} KB]`;
      return out;
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'interrupted' : (e.message || String(e));
      return `Error fetching ${args.url}: ${msg}`;
    }
  },
};