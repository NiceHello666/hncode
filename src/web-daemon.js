// The global hncode web UI.
//
// WHY A DAEMON: the per-session server in web.js can only ever serve the one TUI
// process that started it — its state lives in that process's closures. The user
// wants ONE address that lists every workspace and every session on the machine,
// with a fixed port and a fixed token, so a bookmark and a saved login keep
// working. That requires something that outlives an individual session.
//
// WHAT IT DOES
//   1. Owns the fixed port + token from config.toml.
//   2. Accepts registrations from running TUI sessions over a named pipe. Each
//      registration names the loopback port that session's own web.js listens on.
//   3. Proxies /s/<id>/* to that session's port (live, two-way, SSE included).
//   4. Serves a session whose TUI has EXITED straight from its file in
//      ~/.hncode/sessions (read-only), so nothing is lost when a terminal closes.
//   5. Exits when the last TUI session deregisters.
//
// The daemon deliberately does NOT re-implement SessionHub. A live session's
// transcript, actions and SSE stream stay in web.js, where they already work;
// this process only routes to them. A second copy of the incremental row state
// would be two sources of truth, which is exactly the class of bug this project
// keeps having to fix.

import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as sess from './session.js';
import { ensureWebToken } from './config.js';
import {
  safeEqual, isLoopback, sameOriginOk, requestSecret, isAuthed,
} from './web-auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'web-public');
const COOKIE = 'hncode_web';
const LOGIN_DELAY_MS = 400;

/** How long a session may go without a heartbeat before it is presumed dead. */
const STALE_MS = 45_000;

/** Heartbeat cadence the client is told to use (it may send more often). */
export const HEARTBEAT_MS = 15_000;
/**
 * How often the registry checks whether a session's process is still there.
 *
 * Short, because the check is `process.kill(pid, 0)` — a syscall, not I/O — and
 * it is what makes quitting hncode clear the daemon promptly. Waiting for the
 * heartbeat instead means up to STALE_MS of a stale entry, which is what left a
 * daemon running after the last TUI had gone.
 */
const SWEEP_MS = 5_000;

/** The pipe the sessions register on. */
export function defaultDaemonPipe() {
  if (process.env.HNCODE_WEB_PIPE) return process.env.HNCODE_WEB_PIPE;
  if (process.platform === 'win32') return '\\\\.\\pipe\\hncode-web-daemon';
  return path.join(os.homedir(), '.hncode', 'web-daemon.sock');
}

// ---------------------------------------------------------------------------
// Registry

export class Registry {
  constructor() {
    /** sessionId -> { id, port, token, title, workspace, pid, at } */
    this.live = new Map();
  }

  /** Add or refresh a session. Returns the stored record. */
  register(info) {
    const id = String((info && info.id) || '').trim();
    if (!id) throw new Error('id is required');
    const port = Number(info.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid port');
    const rec = {
      id,
      port,
      // The session's OWN access token. The daemon presents it upstream so
      // web.js's checks pass without the browser logging in twice.
      token: String(info.token || ''),
      title: String(info.title || ''),
      workspace: String(info.workspace || ''),
      pid: Number(info.pid) || 0,
      at: Date.now(),
    };
    this.live.set(id, rec);
    return rec;
  }

  touch(id) {
    const rec = this.live.get(String(id || ''));
    if (rec) { rec.at = Date.now(); return true; }
    return false;
  }

  unregister(id) {
    return this.live.delete(String(id || ''));
  }

  get(id) {
    const rec = this.live.get(String(id || ''));
    if (!rec) return null;
    // Same liveness rules as sweep, so a browser refresh reflects a session that
    // has exited instead of waiting for the next sweep tick.
    if (this.isProcessAlive(rec.pid) === false || Date.now() - rec.at > STALE_MS) {
      this.live.delete(rec.id);
      return null;
    }
    return rec;
  }

  /**
   * Is the process that registered this session still alive?
   *
   * `process.kill(pid, 0)` sends no signal; it only asks the OS whether the pid
   * exists, and it answers IMMEDIATELY. That matters because the alternative —
   * waiting for the heartbeat to go stale — takes up to STALE_MS, and a TUI that
   * exits through its own quit path cannot deregister reliably: `detach()` sends
   * an async pipe request and `process.exit()` follows in the same tick, so the
   * request is usually never written. The pid check turns "left a daemon running
   * for a minute after I quit" into "gone on the next sweep".
   *
   * EPERM means the pid exists but belongs to another user — still alive. Only
   * ESRCH means genuinely gone. An unknown pid (0) falls back to the heartbeat.
   */
  isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if (e && e.code === 'ESRCH') return false;
      return true;   // EPERM and anything else: assume alive
    }
  }

  /**
   * Drop sessions whose process is gone, or whose heartbeat stopped (the latter
   * covers a same-machine pid we cannot see, and a session that lost its event
   * loop while the pid stayed alive).
   */
  sweep(now = Date.now()) {
    const gone = [];
    for (const [id, rec] of this.live) {
      const dead = this.isProcessAlive(rec.pid) === false;
      const stale = now - rec.at > STALE_MS;
      if (dead || stale) { this.live.delete(id); gone.push(id); }
    }
    return gone;
  }

  list() {
    this.sweep();
    // The token is stripped from anything sent to the browser.
    return [...this.live.values()]
      .sort((a, b) => b.at - a.at)
      .map((r) => ({
        id: r.id, title: r.title, workspace: r.workspace,
        pid: r.pid, at: r.at, live: true,
      }));
  }

  get size() { return this.live.size; }
}

// ---------------------------------------------------------------------------
// Reading finished sessions off disk

/**
 * Every saved session, newest first.
 *
 * `readSessionMeta` stops scanning at `"messages"`, so this is cheap even with
 * hundreds of long transcripts. Sessions with no messages are skipped: an empty
 * session is one the user never really started, and listing it is just noise
 * beside the real ones.
 */
export function listSavedSessions(storeDir) {
  const dir = storeDir || sess.sessionsDir();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    let meta = null;
    try { meta = sess.readSessionMeta(full); } catch { continue; }
    if (!meta || !meta.id) continue;
    out.push({
      id: String(meta.id),
      title: String(meta.title || ''),
      workspace: String(meta.workspace || ''),
      updatedAt: Number(meta.updatedAt || meta.createdAt || 0),
      rounds: Number(meta.rounds || 0),
      steps: Number(meta.steps || 0),
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * A saved session rendered in the SAME payload shape web.js serves for a live
 * one — `{ rows, status, events }` — so the browser needs no second renderer.
 *
 * Read-only by construction: no process is running, so there is nothing that
 * could action a request. `status.readOnly` is what the UI keys its banner off,
 * and it is also what makes the actions refuse rather than silently do nothing.
 */
export function savedSessionState(sessionId, storeDir, opts = {}) {
  const s = sess.loadSession(String(sessionId), storeDir);
  if (!s) return null;
  const msgs = s.messages || [];
  // The WHOLE transcript by default. Serving only a tail made the page start
  // mid-conversation and put a "load older" button in front of the user's own
  // history — the wrong shape, and unnecessary now that the browser keeps only
  // the visible rows mounted (web-public/vlist.js). `limit` is still honoured for
  // callers that explicitly want a bounded tail.
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 0;
  const start = limit > 0 ? Math.max(0, msgs.length - limit) : 0;
  const slice = start > 0 ? msgs.slice(start) : msgs;
  const rows = [];
  let seq = 0;
  for (const m of slice) {
    // convRowFor returns an ARRAY (an assistant turn expands into its own row
    // plus one row per tool call) — flatten, never spread into an object.
    for (const r of sess.convRowFor(m)) rows.push({ ...r, id: ++seq });
  }
  return {
    rows,
    // How much was left out, so the page can say so instead of silently looking
    // like it starts mid-conversation.
    hidden: start,
    totalMessages: msgs.length,
    status: {
      session: s.id,
      title: s.title || '',
      model: s.model || '',
      provider: '',
      mode: s.mode || 'ask',
      cwd: s.workspace || '',
      plan: !!s.plan,
      busy: false,
      readOnly: true,
      updatedAt: s.updatedAt || s.createdAt || 0,
      rounds: s.rounds || 0,
      steps: s.steps || 0,
      ctxTokens: 0,
      ctxMax: 0,
      ctxPercent: 0,
    },
    events: [],
    readOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Static assets

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // The self-hosted faces under web-public/fonts. Without these the browser gets
  // `application/octet-stream` and refuses to apply the font.
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export function readAsset(urlPath) {
  const rel = String(urlPath || '/').split('?')[0];
  // NOTE: '/' is NOT mapped to index.html here. The daemon serves TWO shells —
  // the directory at '/', a session page under '/s/<id>/' — and picking one for
  // the caller is what silently made the root serve the single-session UI. Every
  // caller names the file it wants.
  if (rel === '/' || rel === '') return null;
  const safeRel = path.normalize(rel).replace(/^([/\\])+/, '');
  const target = path.join(PUBLIC_DIR, safeRel);
  // Containment check on the RESOLVED path: `..%2f..%2fetc/passwd` and friends
  // must not escape the asset directory.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    if (!fs.statSync(target).isFile()) return null;
    return {
      body: fs.readFileSync(target),
      type: MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Proxying one request to a session's own server

/**
 * Forward `req` to `http://<host>:<port><targetPath>` and pipe the reply back.
 *
 * SSE needs no special handling beyond NOT buffering: `pipe` forwards each chunk
 * as it arrives, which is exactly what an event stream needs. The session's own
 * server does its own token check, so the daemon presents that token upstream —
 * the browser authenticated once, against the daemon.
 */
export function proxyRequest(req, res, targetPath, port, opts = {}) {
  const upstreamHost = opts.host || '127.0.0.1';
  const token = String(opts.token || '');
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    delete headers.host;
    // The body length the browser declared is for the body we are about to pipe
    // through unchanged, so it stays valid — but Node rejects a mismatched one,
    // and the daemon reads some bodies itself. Let the pipe length be recomputed.
    delete headers['content-length'];
    if (token) headers.authorization = `Bearer ${token}`;
    // Drop the browser's Origin/Referer. The session's own server runs the same
    // CSRF check the daemon just ran, but it compares against ITS host and port —
    // which the browser never used, because it talked to the daemon. Forwarding
    // the header therefore made every state-changing request come back 403.
    // Removing it leaves the upstream with no Origin, which web-auth treats as a
    // token-bearing script (already authenticated here) and allows.
    delete headers.origin;
    delete headers.referer;

    const proxied = http.request({
      host: upstreamHost,
      port,
      method: req.method,
      path: targetPath,
      headers,
    }, (upstream) => {
      try { res.writeHead(upstream.statusCode || 502, upstream.headers); }
      catch { resolve(false); return; }
      upstream.pipe(res);
      upstream.on('end', () => resolve(true));
      upstream.on('error', () => { try { res.end(); } catch { /* gone */ } resolve(false); });
    });
    proxied.on('error', (e) => {
      if (!res.headersSent) {
        try {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'session unreachable: ' + e.message }));
        } catch { /* gone */ }
      }
      resolve(false);
    });
    req.pipe(proxied);
  });
}

/**
 * Forward a WebSocket upgrade to an upstream session server and bridge the two
 * raw sockets. The upstream answers its own 101 handshake; when it does, we pipe
 * the client's socket to the upstream's upgraded socket (and the `head` bytes
 * that arrived with the upgrade request).
 */
export function proxyUpgrade(req, socket, head, targetPath, port, opts = {}) {
  const upstreamHost = opts.host || '127.0.0.1';
  const token = String(opts.token || '');
  const headers = { ...req.headers };
  delete headers.host;
  if (token) headers.authorization = `Bearer ${token}`;
  const proxied = http.request({
    host: upstreamHost,
    port,
    method: 'GET',
    path: targetPath,
    headers,
  });
  proxied.on('upgrade', (upstreamRes, upstreamSocket, head2) => {
    // Whatever the upstream decided (101 or a rejection) is replayed to the
    // client, then the sockets are bridged so frames flow both ways.
    const statusLine = 'HTTP/1.1 ' + (upstreamRes.statusCode || 502) + ' ' + (upstreamRes.statusMessage || '') + '\r\n';
    const headerBlock = Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.write(statusLine + headerBlock + '\r\n');
    if (head2 && head2.length) socket.write(head2);
    if (head && head.length) upstreamSocket.write(head);

    // A bridged socket must NEVER surface an unhandled 'error' — a client that
    // closes mid-stream makes the upstream write fail with ECONNABORTED, and an
    // uncaught error kills the whole daemon (which is what the log showed). Both
    // directions are made safe, and one side closing shuts the other.
    const shut = () => { try { upstreamSocket.destroy(); } catch { /* gone */ } try { socket.destroy(); } catch { /* gone */ } };
    socket.on('error', shut);
    upstreamSocket.on('error', shut);
    socket.on('close', shut);
    upstreamSocket.on('close', shut);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxied.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });
  proxied.end();
}

// ---------------------------------------------------------------------------
// The registration pipe
//
// One line of JSON per request, one line of JSON per reply — the same shape
// ci.js uses for its control socket, so there is one protocol idiom in the
// project rather than two.

export function attachRegistryPipe(registry, opts = {}) {
  const pipePath = opts.path || defaultDaemonPipe();
  const onEmpty = typeof opts.onEmpty === 'function' ? opts.onEmpty : () => {};
  const address = typeof opts.address === 'function' ? opts.address : null;
  const onShutdown = typeof opts.onShutdown === 'function' ? opts.onShutdown : null;
  const isPipe = process.platform === 'win32' && pipePath.startsWith('\\\\');
  if (!isPipe) {
    try { fs.mkdirSync(path.dirname(pipePath), { recursive: true }); } catch { /* exists */ }
    try {
      const st = fs.statSync(pipePath);
      if (st.isSocket() || st.isFIFO()) fs.unlinkSync(pipePath);
    } catch { /* nothing to clean */ }
  }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        handleLine(registry, line, address).then((res) => {
          try { conn.write(JSON.stringify(res) + '\n'); } catch { /* peer gone */ }
          // The last session leaving means nothing is left to serve. Reported
          // AFTER the reply is written so the client is not left hanging.
          if (res.ok && res.op === 'unregister' && registry.size === 0) onEmpty();
          // Same ordering for shutdown: answer first, then go.
          if (res.ok && res.op === 'shutdown' && onShutdown) onShutdown();
        });
      }
    });
    conn.on('error', () => { /* client hung up */ });
  });

  return new Promise((resolve) => {
    server.on('error', (e) => resolve({ server: null, path: pipePath, error: e.message, close() {} }));
    server.listen(pipePath, () => {
      resolve({
        server,
        path: pipePath,
        error: null,
        close() {
          try { server.close(); } catch { /* already closed */ }
          if (!isPipe) { try { fs.unlinkSync(pipePath); } catch { /* already gone */ } }
        },
      });
    });
  });
}

async function handleLine(registry, line, address) {
  let req;
  try { req = JSON.parse(line); } catch { return { ok: false, error: 'invalid JSON' }; }
  try {
    switch (req.op) {
      case 'register': return { ok: true, op: 'register', session: registry.register(req) };
      case 'touch': return { ok: true, op: 'touch', found: registry.touch(req.id) };
      case 'unregister': registry.unregister(req.id); return { ok: true, op: 'unregister' };
      // The listen address travels with `ping` so a client never has to assume
      // it. With a fixed port that is a convenience; with port 0 it is the only
      // way to learn where the daemon actually landed.
      case 'ping': {
        const addr = address ? address() : {};
        return { ok: true, op: 'ping', sessions: registry.size, host: addr.host, port: addr.port };
      }
      // Ask the daemon to stand down. Used by tests and by an operator who wants
      // the port back; the same trust model as the rest of this pipe, which is a
      // loopback/named-pipe channel only this user can open.
      case 'shutdown': return { ok: true, op: 'shutdown' };
      default: return { ok: false, error: `unknown op: ${req.op}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// The daemon

/**
 * @param {object} opts
 *   port      fixed port (0 = OS-assigned, for tests)
 *   host      bind address (default 127.0.0.1)
 *   token     access token (default: the persisted one)
 *   storeDir  session store directory
 *   registry  injectable Registry (tests)
 *   idleExit  exit once the last session deregisters (default: true)
 *   onEmpty   called instead of exiting when idleExit is false
 */
export async function startWebDaemon(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port == null ? 0 : Number(opts.port);
  const token = opts.token || ensureWebToken();
  const storeDir = opts.storeDir || sess.sessionsDir();
  const registry = opts.registry || new Registry();
  const idleExit = opts.idleExit !== false;
  const loopback = isLoopback(host);
  const expectedHosts = [];
  // The bind address decides whether a token is required, matching the HTTP rule:
  // on loopback the daemon is reachable only from this machine (reading config.toml
  // grants the same access), but bound beyond loopback it is on the network and the
  // token is the only thing between it and a shell. The browser carries it as the
  // `hncode_web` cookie; a script passes it as a Bearer token.
  const wsAuthed = (req) => loopback || isAuthed(req, token, COOKIE);

  let pipe = null;
  let idleTimer = null;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
      } catch { /* headers already sent */ }
    });
});

  // Forward WebSocket upgrades for a live session's /api/ws to that session's own
  // server. Without this the daemon (which does auth + path routing) would drop
  // the WS handshake — a plain http server destroys any upgrade it has no
  // listener for. Route /s/<id>/api/ws like handle() does, then bridge the two
  // sockets.
  server.on('upgrade', (req, socket, head) => {
    try {
      // A WebSocket upgrade bypasses the normal request handler (that is what an
      // upgrade IS), so auth cannot ride on handle(). Mirror the HTTP rule here,
      // or a daemon bound beyond loopback would hand any session's full transcript
      // to anyone who can reach the port.
      if (!wsAuthed(req)) { socket.destroy(); return; }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const p = url.pathname;
      const m = /^\/s\/([^/]+)(\/.*)?$/.exec(p);
      if (!m || !m[2].startsWith('/api/ws')) { socket.destroy(); return; }
      const id = decodeURIComponent(m[1]);
      const live = registry.get(id);
      if (!live) { socket.destroy(); return; }
      proxyUpgrade(req, socket, head, m[2], live.port, { token: live.token });
    } catch { socket.destroy(); }
  });

  function send(res, code, body, headers = {}) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
  }
  function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  async function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // The Origin check accepts the host the browser actually used, plus localhost
  // on the same port (a user may reach the daemon either way).
  function noteHost(req) {
    const h = String(req.headers.host || '');
    if (h && !expectedHosts.includes(h)) expectedHosts.push(h);
    const bare = h.replace(/:\d+$/, '');
    for (const alt of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      if (!expectedHosts.includes(alt) && (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1')) {
        expectedHosts.push(alt);
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const method = (req.method || 'GET').toUpperCase();
    noteHost(req);

    // --- unauthenticated -----------------------------------------------------
    // Reveals only that a daemon exists and how many sessions it holds.
    if (p === '/healthz') {
      return json(res, 200, { ok: true, service: 'hncode-web-daemon', sessions: registry.size });
    }
    // The login page and its assets have to load before a token exists, and the
    // login script imports the message table. NONE carry session data.
    if (p === '/login' || p === '/login.html' || p === '/login.css'
        || p === '/login.js' || p === '/i18n.js'
        || p === '/fonts.css' || p.startsWith('/fonts/')) {
      const asset = readAsset(p === '/login' ? '/login.html' : p);
      if (!asset) return send(res, 404, 'not found');
      return send(res, 200, asset.body, { 'content-type': asset.type, 'cache-control': 'no-store' });
    }
    // POST /api/login { token } -> HttpOnly cookie. The token travels in the
    // BODY, never the query string, so it stays out of logs and history.
    if (p === '/api/login' && method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* handled below */ }
      if (!safeEqual(String(body.token || ''), token)) {
        await new Promise((r) => setTimeout(r, LOGIN_DELAY_MS));
        return json(res, 401, { ok: false, error: 'invalid token' });
      }
      const secure = !loopback && String(req.headers['x-forwarded-proto'] || '') === 'https';
      // A 30-day cookie: the point of a stable token is that the browser does not
      // ask again every day.
      const cookie = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        'HttpOnly', 'SameSite=Strict', 'Path=/',
        secure ? 'Secure' : '',
        `Max-Age=${60 * 60 * 24 * 30}`,
      ].filter(Boolean).join('; ');
      return send(res, 200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': cookie,
      });
    }

    // --- authentication ------------------------------------------------------
    //
    // A request from THIS machine, addressed to a loopback name, is let straight
    // in without a token. That is the common case — the user starts the UI and
    // opens it in their own browser — and asking for a token there protects
    // nothing: anything that can open this socket already runs as this user and
    // can read the token out of config.toml.
    //
    // Everything else still needs the token, which is the case that matters: a
    // daemon bound beyond loopback, reached from another machine on the network.
    //
    // The rule keys off the BIND ADDRESS, not the client's: bound to a loopback
    // address the daemon is reachable only from this machine, so a token would
    // gate nothing the user does not already have access to. Bound anywhere else
    // it is on the network, and the token is what stands between that network and
    // a shell.
    if (!loopback && !isAuthed(req, token, COOKIE)) {
      if (p.startsWith('/api/')) return json(res, 401, { ok: false, error: 'unauthorized' });
      if (method === 'GET') { res.writeHead(302, { location: '/login' }); return res.end(); }
      return send(res, 401, 'unauthorized');
    }

    // CSRF: a state-changing request must come from a page we served.
    if (method !== 'GET' && method !== 'HEAD') {
      const ok = sameOriginOk(req, expectedHosts);
      if (ok === false) return json(res, 403, { ok: false, error: 'cross-origin request refused' });
    }

    // --- directory -----------------------------------------------------------
    // One request gives the landing page everything: live sessions from the
    // registry and finished ones read off disk.
    if (p === '/api/sessions') {
      return json(res, 200, {
        ok: true,
        live: registry.list(),
        saved: listSavedSessions(storeDir),
      });
    }

    if (p === '/api/daemon') {
      // `actualPort`, not the requested `port`: when the caller asks for 0 the OS
      // picks one, and reporting 0 back would tell a client to connect nowhere.
      return json(res, 200, {
        ok: true,
        host,
        port: actualPort,
        token,
        heartbeatMs: HEARTBEAT_MS,
        pid: process.pid,
      });
    }

    // --- session-scoped ------------------------------------------------------
    // /s/<id>/... — proxied to the live session, or served read-only from disk.
    // The prefix is STRIPPED before forwarding, so the session's own server sees
    // exactly the paths it always has and needs no changes.
    const m = /^\/s\/([^/]+)(\/.*)?$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]);
      // `/s/<id>` must become `/s/<id>/` before anything is served. The session
      // page loads its assets and calls its API through RELATIVE paths (so that
      // the same files work both standalone and behind this prefix); without the
      // trailing slash the browser resolves `api/state` against `/s/` and every
      // request misses. Redirecting once is cheaper and more reliable than
      // rewriting every path in the HTML and JS.
      if (m[2] === undefined) {
        res.writeHead(302, { location: `/s/${encodeURIComponent(id)}/${url.search || ''}` });
        return res.end();
      }
      const rest = m[2] + (url.search || '');
      const live = registry.get(id);
      if (live) {
        // A plain GET of the session root is the page itself: mark it live so the
        // UI enables the composer.
        return proxyRequest(req, res, rest, live.port, { host: '127.0.0.1', token: live.token });
      }
      return serveSaved(res, id, rest, method, storeDir);
    }

    // --- the landing page ----------------------------------------------------
    // Serve the SPA shell for any other GET so the client-side router works on a
    // deep link (`/d/<ws>` etc.). Assets are matched by extension so a missing
    // file 404s instead of silently returning HTML.
    if (method === 'GET' || method === 'HEAD') {
      const asset = readAsset(p);
      if (asset) return send(res, 200, asset.body, { 'content-type': asset.type, 'cache-control': 'no-store' });
      if (p !== '/' && path.extname(p)) return send(res, 404, 'not found');
      // The directory page is the daemon's root. A session page is only ever
      // served under /s/<id>/ (see above), so this shell must NOT be index.html —
      // that is the single-session UI and it would call a relative `api/state`
      // against the daemon's root, which has no such endpoint.
      const shell = readAsset('/home.html');
      if (!shell) return send(res, 500, 'web assets missing');
      return send(res, 200, shell.body, { 'content-type': shell.type, 'cache-control': 'no-store' });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  }


  /**
   * Serve a session whose TUI has exited, from its file on disk.
   *
   * Only the paths a live session's own server answers are answered (`/api/state`,
   * `/api/events`, `/api/sessions` and the page + its assets); everything that
   * would CHANGE something is refused with a clear reason. A read-only viewer that
   * silently accepted a prompt would be worse than one that says it cannot.
   */
  function serveSaved(res, id, rest, method, storeDir2) {
    const clean = rest.split('?')[0];
    // `?limit=N` bounds how much of a long transcript is sent. It defaults to
    // savedSessionState's own default; a caller can ask for more, but not for
    // "everything" — the whole point is that the payload stays bounded.
    const qs = rest.includes('?') ? new URLSearchParams(rest.slice(rest.indexOf('?') + 1)) : null;
    const limitArg = qs && qs.get('limit');
    const limit = limitArg && /^\d+$/.test(limitArg) ? Number(limitArg) : undefined;
    if (clean === '/api/state') {
      const state = savedSessionState(id, storeDir2, { limit });
      if (!state) return json(res, 404, { ok: false, error: 'no such session' });
      return json(res, 200, { ok: true, ...state });
    }
    // The session page's left rail asks for the directory. A LIVE session answers
    // this from its own web.js; a finished one has no process to ask, so the
    // daemon answers here. Without it the rail came up empty on exactly the pages
    // that are served from disk — the header said "no other sessions" and the
    // list the user just clicked in was gone.
    if (clean === '/api/sessions') {
      const live = registry.list().map((s) => ({
        id: s.id, title: s.title, workspace: s.workspace, updatedAt: s.at,
      }));
      const liveIds = new Set(live.map((s) => s.id));
      const saved = listSavedSessions(storeDir2).filter((s) => !liveIds.has(s.id));
      return json(res, 200, { ok: true, current: id, sessions: [...live, ...saved] });
    }
    if (clean === '/api/events') {
      // A finished session has no events to stream. Answer with a well-formed
      // stream that immediately reports the (empty) snapshot and stays open, so
      // the client's EventSource does not spin on reconnects.
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const state = savedSessionState(id, storeDir2) || { rows: [], status: {}, events: [] };
      res.write(`data: ${JSON.stringify({ type: 'snapshot', ...state, readOnly: true })}\n\n`);
      return undefined;
    }
    if (clean === '/api/action') {
      return json(res, 409, {
        ok: false,
        error: 'this session has exited — its transcript is read-only',
      });
    }
    // Assets come from the same web-public directory as everything else.
    const asset = readAsset(clean === '/' ? '/index.html' : clean);
    if (asset) return send(res, 200, asset.body, { 'content-type': asset.type, 'cache-control': 'no-store' });
    if (method === 'GET' && !path.extname(clean)) {
      const shell = readAsset('/index.html');
      if (shell) return send(res, 200, shell.body, { 'content-type': shell.type });
    }
    return send(res, 404, 'not found');
  }

  // ---- bind ---------------------------------------------------------------
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  /**
   * Stand down once nothing is left to serve.
   *
   * Called from two places, and they are NOT the same event:
   *   * a session deregisters cleanly (its /web off, or the TUI exiting through
   *     its normal shutdown path);
   *   * the sweep drops a session that never deregistered because its process
   *     was killed outright — a closed terminal window, a crash, Task Manager.
   * The second case is why this cannot live only in the deregister handler: a
   * daemon started on this machine outlived the TUI that spawned it exactly
   * because nothing re-checked emptiness after a sweep.
   *
   * The short delay lets the triggering reply flush before the listener goes.
   */
  function goIdleIfEmpty() {
    if (registry.size > 0) return;
    if (!idleExit) {
      if (typeof opts.onEmpty === 'function') opts.onEmpty();
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (registry.size === 0) close();
    }, 1500);
    if (idleTimer.unref) idleTimer.unref();
  }

  // ---- registration pipe --------------------------------------------------
  pipe = await attachRegistryPipe(registry, {
    path: opts.pipePath,
    // The address is reported on `ping` so a client never has to guess it. When
    // the caller asked for port 0 the OS picked one, and a client that assumed
    // its configured port would connect to nothing.
    address: () => ({ host, port: actualPort }),
    onShutdown: () => {
      // Let the reply reach the caller before the listeners go away.
      setTimeout(() => close(), 60);
    },
    onEmpty: goIdleIfEmpty,
  });

  // A process killed outright never deregisters (no terminal to run the exit
  // handler), so the sweep is what notices it. Dropping the entry is not enough
  // on its own — the daemon also has to re-check whether anything is left.
  const sweepTimer = setInterval(() => {
    const gone = registry.sweep();
    if (!gone.length) return;
    if (typeof opts.onSweep === 'function') opts.onSweep(gone);
    goIdleIfEmpty();
  }, SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();


  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    clearTimeout(idleTimer);
    try { server.close(); } catch { /* already closed */ }
    if (pipe) pipe.close();
  }

  return {
    server,
    registry,
    port: actualPort,
    host,
    token,
    url: `http://${host}:${actualPort}/`,
    pipePath: pipe && pipe.path,
    pipeError: pipe && pipe.error,
    close,
  };
}
