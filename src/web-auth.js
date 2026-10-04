// Authentication for the local web UI.
//
// THREAT MODEL, stated plainly because it decides every choice here: the server
// binds to a local address by default and serves one user's coding session — the
// transcript, the file contents it read, and the ability to RUN COMMANDS as that
// user. So the bar is not "keep out a determined attacker"; it is:
//   * a page the user visits in another tab must not be able to talk to it
//     (same-origin rules do not apply to `fetch` from a random site without CORS,
//     but a form POST or a `<img>`/websocket still reaches it),
//   * another user on the same machine must not read the transcript,
//   * a leaked URL pasted into a chat must not be enough on its own.
//
// What that buys:
//   * a 256-bit TOKEN, generated per process, required on every request;
//   * constant-time comparison, so a token cannot be guessed byte by byte;
//   * a same-origin check on state-changing requests (Origin/Referer must match
//     the bound host), which is the standard defence against a cross-site POST;
//   * HttpOnly + SameSite=Strict session cookie after a one-time token exchange,
//     so the token does not have to sit in the page's JS or in a URL.
//
// What it deliberately does NOT do: TLS (the transport is loopback), user
// accounts, or rate limiting beyond a small login delay. Binding to a non-loopback
// address is allowed (/web 0.0.0.0) but is opt-in and warned about, because then
// the token is the ONLY thing between the network and a shell.

import crypto from 'node:crypto';

// 32 bytes of entropy, base64url. Long enough that guessing is hopeless, short
// enough to paste from a terminal.
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Constant-time string compare. `crypto.timingSafeEqual` throws on a length
 * mismatch, which would itself leak the length — so both sides are hashed first,
 * making every comparison the same length.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Loopback check — decides whether binding needs a warning. */
export function isLoopback(addr) {
  const a = String(addr || '').trim().toLowerCase();
  if (a === 'localhost' || a === '::1' || a === '[::1]') return true;
  if (/^127(\.\d{1,3}){3}$/.test(a)) return true;
  return false;
}

/**
 * Is this request allowed to CHANGE something? A browser sends `Origin` on every
 * state-changing cross-origin request (and on same-origin POSTs too), so a
 * mismatch means the request came from a page we do not control. Requests with no
 * Origin at all are allowed only when they carry the bearer token — that is a
 * script (curl), not a browser being abused by another site.
 */
export function sameOriginOk(req, expectedHosts) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return null;                 // caller decides (token-only scripts)
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return expectedHosts.includes(host);
}

/** Parse `Cookie: a=1; b=2`. Returns {} for anything malformed. */
export function parseCookies(header) {
  const out = {};
  const s = String(header || '');
  if (!s) return out;
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The request's credential, from either place:
 *   * `Authorization: Bearer <token>` — scripts, curl, the CLI;
 *   * the `hncode_web` cookie        — the browser, set by POST /api/login.
 */
export function requestSecret(req, cookieName = 'hncode_web') {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const cookies = parseCookies(req.headers.cookie);
  return cookies[cookieName] || '';
}

export function isAuthed(req, token, cookieName) {
  return safeEqual(requestSecret(req, cookieName), token);
}
