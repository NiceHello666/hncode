// TUI side of the global web UI.
//
// The user's model is: "/web" opens ONE web UI for this machine. If a daemon is
// already running, this session simply registers with it and does NOT start a
// second server — the existing one already holds the fixed port and token, and a
// second one could not bind that port anyway.
//
// So the flow is: probe -> (spawn if absent) -> register -> heartbeat. The
// session's own per-session server (web.js) still exists, because that is where
// the transcript and the actions live; the daemon only routes to it.

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.js';
import { HEARTBEAT_MS, defaultDaemonPipe } from './web-daemon.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Send one line-JSON request over the daemon pipe. Never throws. */
export function daemonCall(req, opts = {}) {
  const pipePath = opts.pipePath || defaultDaemonPipe();
  const timeoutMs = opts.timeoutMs || 2000;
  return new Promise((resolve) => {
    let done = false, sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (sock) sock.destroy(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    try { sock = net.connect(pipePath); }
    catch (e) { finish({ ok: false, error: e.message }); return; }
    let buf = '';
    sock.on('connect', () => {
      try { sock.write(JSON.stringify(req) + '\n'); }
      catch (e) { finish({ ok: false, error: e.message }); }
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let parsed = null;
      try { parsed = JSON.parse(buf.slice(0, i)); } catch { /* malformed */ }
      finish(parsed || { ok: false, error: 'bad reply' });
    });
    sock.on('error', (e) => finish({ ok: false, error: e.message }));
  });
}

/** Is a daemon already listening on the pipe? */
export async function daemonAlive(opts = {}) {
  const r = await daemonCall({ op: 'ping' }, opts);
  return r && r.ok === true;
}

/**
 * The daemon's own address, as it reports it. Use this instead of assuming the
 * configured port: when the config says `web_port = 0` the OS picks one, and a
 * guessed URL would point nowhere.
 */
export async function daemonInfo(opts = {}) {
  const r = await daemonCall({ op: 'ping' }, opts);
  if (!r || !r.ok) return null;
  const host = r.host || '127.0.0.1';
  return { host, port: r.port, sessions: r.sessions, url: `http://${host}:${r.port}/` };
}

/**
 * Ask the daemon to shut down and release its port.
 *
 * Needed because the daemon is started DETACHED on purpose — `child.kill()` from
 * the spawning process does not reach it once that process has moved on (which is
 * what left orphaned daemons behind in testing). This is the supported way to
 * stop one from outside.
 */
export async function stopDaemon(opts = {}) {
  const r = await daemonCall({ op: 'shutdown' }, opts);
  return !!(r && r.ok);
}

/**
 * Start the daemon as a DETACHED process.
 *
 * Detached and `unref`ed on purpose: the daemon must outlive the terminal that
 * happened to start it. Its own idle rule (exit once the last session
 * deregisters) is what stops it from lingering forever.
 *
 * Returns once it answers on the pipe, or throws with what went wrong — a silent
 * failure here would leave /web reporting success with nothing serving it.
 */
export async function spawnDaemon(opts = {}) {
  const cfg = resolveConfig();
  const pipePath = opts.pipePath || defaultDaemonPipe();
  // An explicit host (from `/web <ip>`) wins over the config value, so the same
  // command that asks for a network-reachable session server also binds the
  // daemon to the network. Without this the daemon kept 127.0.0.1 and the
  // browser's connection to the listed URL died with "no data sent".
  const daemonHost = opts.host || cfg.webHost || '127.0.0.1';
  const logFile = path.join(os.homedir(), '.hncode', 'web-daemon.log');
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch { /* exists */ }
  let out = 'ignore';
  try { out = fs.openSync(logFile, 'a'); } catch { out = 'ignore'; }

  const entry = path.join(HERE, 'web-daemon-cli.js');
  if (!fs.existsSync(entry)) throw new Error(`daemon entry not found: ${entry}`);

  const child = cp.spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: {
      ...process.env,
      HNCODE_WEB_PIPE: pipePath,
      HNCODE_WEB_HOST: daemonHost,
      HNCODE_WEB_PORT: String(cfg.webPort == null ? 8765 : cfg.webPort),
    },
  });
  child.unref();

  // Wait for it to answer. A bind failure (port taken by something else) shows up
  // here as a timeout, which is the honest report: the daemon is not serving.
  const deadline = Date.now() + (opts.waitMs || 8000);
  let lastErr = 'did not start';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    const ping = await daemonCall({ op: 'ping' }, { pipePath, timeoutMs: 800 });
    if (ping && ping.ok) return { spawned: true, child, pipePath, logFile };
    if (ping && ping.error && ping.error !== 'timeout') lastErr = ping.error;
  }
  throw new Error(`web daemon did not start (${lastErr}); see ${logFile}`);
}

/**
 * Attach this session to the global daemon.
 *
 * @param {object} info  { id, port, token, title, workspace }
 *   `port`/`token` describe THIS session's own web.js server, which the daemon
 *   proxies to. Without them the daemon can only serve the session read-only.
 * @returns {Promise<{ ok, spawned, reused, pipePath, heartbeat }>}
 */
export async function attachToDaemon(info, opts = {}) {
  const pipePath = opts.pipePath || defaultDaemonPipe();
  let spawned = false;

  if (!(await daemonAlive({ pipePath }))) {
    await spawnDaemon({ pipePath, waitMs: opts.waitMs, host: info.host });
    spawned = true;
  }

  const reg = await daemonCall({
    op: 'register',
    id: info.id,
    port: info.port,
    token: info.token,
    title: info.title || '',
    workspace: info.workspace || '',
    pid: process.pid,
  }, { pipePath, timeoutMs: 4000 });

  if (!reg || !reg.ok) {
    throw new Error(`could not register with the web daemon: ${(reg && reg.error) || 'no reply'}`);
  }

  // Heartbeat so a killed process is not shown as live forever. `unref` keeps the
  // timer from holding the event loop open on its own.
  const hb = setInterval(() => {
    daemonCall({ op: 'touch', id: info.id }, { pipePath, timeoutMs: 1500 }).catch(() => {});
  }, Math.max(5000, HEARTBEAT_MS));
  if (hb.unref) hb.unref();

  const detach = () => {
    clearInterval(hb);
    daemonCall({ op: 'unregister', id: info.id }, { pipePath, timeoutMs: 1500 }).catch(() => {});
  };

  // Ask the daemon where it actually is, rather than trusting the configured
  // port: `web_port = 0` means the OS chose one.
  const addr = await daemonInfo({ pipePath, timeoutMs: 2000 });
  const host = (addr && addr.host) || '127.0.0.1';
  const port = (addr && addr.port) != null ? addr.port : null;
  const url = port == null ? null : `http://${host}:${port}/s/${encodeURIComponent(info.id)}/`;

  return {
    ok: true,
    spawned,
    reused: !spawned,
    pipePath,
    host,
    port,
    // The per-SESSION URL the user should open. The daemon's root lists every
    // session, so both are reported and the TUI can print whichever it wants.
    url,
    rootUrl: port == null ? null : `http://${host}:${port}/`,
    heartbeat: hb,
    detach,
  };
}
