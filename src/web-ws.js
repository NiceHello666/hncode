// Zero-dependency WebSocket server for the local web UI.
//
// The project ships with NO runtime dependencies (see package.json), so a
// WebSocket upgrade cannot use the `ws` package. RFC 6455 is implemented here by
// hand: the SHA-1 handshake uses node:crypto, and the data framing (text frames,
// ~7-byte masks, 16/64-bit lengths) is a small loop.
//
// This is deliberately the smallest subset the web UI needs: a server that
// accepts one text-message stream per connection, echoes nothing, and lets the
// caller push string messages. No ping/pong, no fragmentation (the browser never
// fragments), no binary. Compression is NOT negotiated, so the browser sends
// plain frames — enough for our JSON events.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const KEEPALIVE_MS = 25000;

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// Hard cap on a single frame's payload. A malicious/formed peer can declare a
// 64-bit length; allocating that much would throw RangeError and crash the
// process, and buffering a slow trickle of an oversized frame would OOM.
const MAX_FRAME = 64 * 1024 * 1024;

/** A single accepted, open WebSocket connection. */
export class WsConn {
  constructor(socket, onClose) {
    this.socket = socket;
    this._done = onClose;   // internal close sink, fired once when the socket dies
    this.open = true;
    // The caller registers a message handler.
    this.onMessage = null;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._close());
    socket.on('error', () => this._close());
    // Server->client keepalive: idle proxies (EasyTier, the daemon, nginx)
    // drop a silent WebSocket, the front-end reconnects and re-reads the whole
    // snapshot (page appears to reload itself). A repeated ping keeps the path
    // alive; the timer dies with the socket in _close().
    this._ka = setInterval(function () { try { this.ping(); } catch { /* closing */ } }.bind(this), KEEPALIVE_MS);
    if (this._ka.unref) this._ka.unref();
  }

  _buffer = Buffer.alloc(0);

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    // Guard against a peer trickling an oversized frame: the incomplete-frame
    // path would otherwise keep appending to the buffer without bound.
    if (this._buffer.length > MAX_FRAME) { try { this._close(); } catch {} return; }
    // Try to parse as many complete frames as the buffer holds.
    for (;;) {
      const parsed = this._parseFrame(this._buffer);
      if (!parsed) return;
      const { consumed, data } = parsed;
      this._buffer = this._buffer.subarray(consumed);
      if (parsed.fatal) { try { this._close(); } catch {} return; }
      if (this.onMessage) {
        try { this.onMessage(data); } catch { /* a handler must not kill the conn */ }
      }
    }
  }

  /** Parse one WS frame from the front of `buf`. Returns null when the frame is
      incomplete; otherwise `{ consumed, data }` with `data` the UTF-8 string. */
  _parseFrame(buf) {
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      const hi = buf.readUInt32BE(off);
      const lo = buf.readUInt32BE(off + 4);
      len = hi * 4294967296 + lo;
      off += 8;
    }
    if (len > MAX_FRAME) return { consumed: 1, data: '', fatal: true };
    // Only masked text frames from a browser; ignore anything else gracefully.
    if (!masked) {
      // Not masked is a protocol error. A browser always masks, so this means
      // the stream is corrupted — flag it fatal and let _onData drop the
      // connection instead of guessing a frame length (which could swallow
      // following frames) or spinning forever (consumed:0 froze the server).
      return { consumed: 1, data: '', fatal: true };
    }
    const maskLen = 4;
    if (buf.length < off + maskLen) return null;
    const mask = buf.subarray(off, off + maskLen);
    off += maskLen;
    if (buf.length < off + len) return null;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
    // opcode 0x9 = ping, 0xA = pong, 0x8 = close. We answer pings; skip the rest.
    if (!fin) return { consumed: off + len, data: '' };   // no fragmentation support
    let text = '';
    if (opcode === 0x1) {           // text frame
      text = payload.toString('utf8');
    } else if (opcode === 0x9) {    // ping -> pong
      this._writeFrame(0xA, payload);
    } else if (opcode === 0x8) {    // close -> close back
      this._writeFrame(0x8, Buffer.alloc(0));
      this._close();
    }
    return { consumed: off + len, data: text };
  }

  /** Send a text message as an unmasked frame, per RFC 6455 (server->client
      frames are never masked). */
  send(text) {
    if (!this.open) return;
    this._writeFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  /** Send a ping control frame (opcode 0x9). The peer answers with a pong,
      keeping the socket and any proxy between us and the browser alive. */
  ping() {
    if (!this.open) return;
    this._writeFrame(0x9, Buffer.alloc(0));
  }

  _writeFrame(opcode, payload) {
    const len = payload.length;
    const header = [0x80 | opcode];
    if (len <= 125) {
      header.push(len);
    } else if (len <= 0xffff) {
      // RFC 6455: opcode+mask bit, then 126, then a 16-bit big-endian length.
      header.push(126);
      const b = Buffer.alloc(2);
      b.writeUInt16BE(len, 0);
      header.push(b[0], b[1]);
    } else {
      // 127, then a 64-bit big-endian length.
      header.push(127);
      const b = Buffer.alloc(8);
      b.writeUInt32BE(Math.floor(len / 4294967296), 0);
      b.writeUInt32BE(len >>> 0, 4);
      header.push(...b);
    }
    const buf = Buffer.concat([Buffer.from(header), payload]);
    try { this.socket.write(buf); } catch { /* closing */ }
  }

  close() {
    if (!this.open) return;
    try { this._writeFrame(0x8, Buffer.alloc(0)); } catch { /* closing */ }
    this._close();
  }

  _close() {
    if (this._ka) { clearInterval(this._ka); this._ka = null; }
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch { /* already gone */ }
    if (this._done) { try { this._done(); } catch { /* best-effort */ } }
  }
}

/**
 * Attach a WebSocket upgrade handler to an http.Server.
 *
 *   onConnection(conn) — called once a connection is accepted and open. `conn` is
 *     a WsConn with `.send(text)` and `.close()`; set `conn.onMessage` to receive
 *     client frames.
 *   onUpgrade(req) — optional; return a string to reject (sent as the HTTP status
 *     for the upgrade), or null to accept.
 */
export function attachWebSocket(server, opts = {}) {
  const { path = '/api/ws', onConnection, onUpgrade } = opts;
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    const p = url.split('?')[0];
    if (p !== path) { socket.destroy(); return; }
    if (onUpgrade) {
      const reject = onUpgrade(req);
      if (reject) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' + reject,
        );
        socket.destroy();
        return;
      }
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto
      .createHash('sha1')
      .update(key + WS_MAGIC)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    try {
      const conn = new WsConn(socket, () => {
        // The caller decides what to do when a connection drops.
        if (opts.onClose) opts.onClose(conn);
      });
      if (onConnection) onConnection(conn);
    } catch (e) {
      // A connection that fails to construct must not kill the process; log it.
      try { fs.appendFileSync(path.join(os.tmpdir(), 'hncode-web-ws.log'), '[ws] onConnection threw: ' + (e && e.message) + '\n'); } catch { /* best-effort */ }
    }
  });
}

/**
 * Convenience: is the incoming `req` a WebSocket upgrade for our path? Lets an
 * http server's normal request handler skip it (the upgrade event is handled
 * separately, so this is informational).
 */
export function isUpgradeRequest(req) {
  const up = String(req.headers.upgrade || '').toLowerCase();
  return up === 'websocket';
}