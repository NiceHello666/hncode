// CI / scripting integration — turning a headless run into something a pipeline
// can act on.
//
// `hncode -p "…"` already prints the reply. What a CI job additionally needs is:
//   * a machine-readable final result (did it succeed? what changed?),
//   * an exit code that reflects the OUTCOME, not just "the process started",
//   * a stable JSON envelope it can parse without scraping prose.
//
// The formats (chosen to match what CI systems and Claude-Code-style tools
// already understand):
//   text        — the assistant's reply, as before (default)
//   json        — ONE object at the end: { ok, reply, toolCalls, files, error }
//   stream-json — one JSON event per line as the run progresses (existing), now
//                 terminated by a final `result` event so a reader can stop.
//
// Exit codes (see EXIT):
//   0  the run completed and produced an answer
//   1  generic failure (LLM error, bad config)
//   2  configuration problem (no API key)
//   3  the model stopped without an answer / reported a blocker
//   4  interrupted
//
// Nothing here writes to stdout directly except through the helpers, so the
// caller stays in control of framing.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXIT = {
  OK: 0,
  FAILURE: 1,
  CONFIG: 2,
  NO_ANSWER: 3,
  INTERRUPTED: 4,
};

export const FORMATS = ['text', 'json', 'stream-json'];

export function isValidFormat(f) {
  return f == null || FORMATS.includes(f);
}

// Build the structured result for a finished run.
//   ok        — completed with a usable answer
//   reply     — the assistant's final text
//   toolCalls — names of tools invoked, in order
//   files     — files the run wrote/edited (from tool ARGS, best-effort)
//   error     — a fatal error message, when the run failed outright
//   stopped   — the turn was interrupted
export function buildResult({ reply, toolCalls, files, error, stopped, durationMs, model, sessionId }) {
  const hasReply = typeof reply === 'string' && reply.trim().length > 0;
  const ok = !error && !stopped && hasReply;
  const result = {
    ok,
    reply: reply || '',
    toolCalls: toolCalls || [],
    files: files || [],
    durationMs: durationMs || 0,
    model: model || '',
    sessionId: sessionId || '',
  };
  if (error) result.error = String(error);
  if (stopped) result.stopped = true;
  return result;
}

// Map a result to a process exit code.
export function exitCodeFor(result, hadConfigError) {
  if (hadConfigError) return EXIT.CONFIG;
  if (!result) return EXIT.FAILURE;
  if (result.stopped) return EXIT.INTERRUPTED;
  if (result.error) return EXIT.FAILURE;
  if (!result.ok) return EXIT.NO_ANSWER;
  return EXIT.OK;
}

// The JSON envelope printed at the end in `json` mode. Single line so a shell
// can capture it with `tail -1` or `jq`.
export function resultLine(result) {
  return JSON.stringify({ type: 'result', ...result });
}

// Collect tool activity from an agent event stream. `onEvent` is called per
// event; this returns the mutable accumulators the caller reads at the end.
export function createRunTracker() {
  return { toolCalls: [], files: [], errors: [], text: '' };
}

// Files a tool call will write, taken from its arguments. Only the mutating
// tools are considered: a Read of a file is not "changed by this run".
const WRITE_TOOLS = new Set(['Write', 'Edit']);

export function trackEvent(tracker, e) {
  if (!tracker || !e) return tracker;
  if (e.type === 'data' && e.text) tracker.text += e.text;
  if (e.type === 'tool_use' && e.name) {
    tracker.toolCalls.push(e.name);
    if (WRITE_TOOLS.has(e.name) && e.args && typeof e.args.path === 'string') {
      if (!tracker.files.includes(e.args.path)) tracker.files.push(e.args.path);
    }
  }
  if (e.type === 'error') tracker.errors.push((e.error && e.error.message) || String(e.error));
  return tracker;
}

// The final assistant text for the run. Prefers the LAST assistant message that
// has text (the handoff), falling back to the streamed aggregate. Mirrors the
// rule subagents use, so both report the same thing.
export function finalReply(messages, streamedText) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return String(streamedText || '').trim();
}

// --- remote control ----------------------------------------------------------
// A running hncode TUI can expose a small control surface (a unix socket /
// named pipe) so another process can queue a prompt or query status. This is
// what "remote control" means here: not a network server by default, a local
// endpoint the user opts into.
//
// The protocol is newline-delimited JSON, one request per line, one response
// per line:  {"op":"prompt","text":"…"}  ->  {"ok":true}
//            {"op":"status"}             ->  {"ok":true,"busy":false,"session":"…"}

export function defaultControlPath() {
  if (process.env.HNCODE_CONTROL_SOCKET) return process.env.HNCODE_CONTROL_SOCKET;
  if (process.platform === 'win32') {
    // Windows has no unix sockets at a filesystem path: Node exposes named pipes
    // under \\.\pipe\. Using a normal temp path there fails with EACCES, which is
    // exactly what happened before this branch existed.
    return `\\\\.\\pipe\\hncode-control-${process.pid}`;
  }
  return path.join(os.homedir(), '.hncode', 'control.sock');
}

// Start a control server. `handlers` is { prompt(text), status(), interrupt() }.
// Returns { server, path, close() }. A stale socket file is replaced; a live one
// makes the call fail so two TUIs cannot fight over it.
export function startControlServer(handlers, opts = {}) {
  const sockPath = opts.path || defaultControlPath();
  const isPipe = process.platform === 'win32' && sockPath.startsWith('\\\\');
  if (!isPipe) {
    try { fs.mkdirSync(path.dirname(sockPath), { recursive: true }); } catch { /* exists */ }
    // Remove a stale socket (a crash leaves one behind). Windows named pipes
    // disappear with the process and cannot be stat()ed, hence the guard above.
    try {
      const st = fs.statSync(sockPath);
      if (st.isSocket() || st.isFIFO()) fs.unlinkSync(sockPath);
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
        handleControlLine(line, handlers).then((res) => {
          try { conn.write(JSON.stringify(res) + '\n'); } catch { /* peer gone */ }
        });
      }
    });
    conn.on('error', () => { /* client hung up */ });
  });

  return new Promise((resolve) => {
    server.on('error', (e) => resolve({ server: null, path: sockPath, error: e.message, close() {} }));
    server.listen(sockPath, () => {
      resolve({
        server,
        path: sockPath,
        error: null,
        close() {
          try { server.close(); } catch { /* already closed */ }
          if (!isPipe) { try { fs.unlinkSync(sockPath); } catch { /* already gone */ } }
        },
      });
    });
  });
}

async function handleControlLine(line, handlers) {
  let req;
  try { req = JSON.parse(line); } catch { return { ok: false, error: 'invalid JSON' }; }
  try {
    if (req.op === 'status') return { ok: true, ...(await handlers.status()) };
    if (req.op === 'prompt') {
      if (typeof req.text !== 'string' || !req.text.trim()) return { ok: false, error: 'text required' };
      await handlers.prompt(req.text);
      return { ok: true };
    }
    if (req.op === 'interrupt') {
      await handlers.interrupt();
      return { ok: true };
    }
    return { ok: false, error: `unknown op: ${req.op}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Client side: send one request to a running control server. Returns the parsed
// response or { ok:false, error }. Never throws.
export async function sendControl(req, opts = {}) {
  const sockPath = opts.path || defaultControlPath();
  const timeoutMs = opts.timeoutMs || 10_000;
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch { /* already gone */ }
      resolve(r);
    };
    try { sock = net.connect(sockPath); }
    catch (e) { resolve({ ok: false, error: e.message }); return; }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    sock.on('connect', () => {
      try { sock.write(JSON.stringify(req) + '\n'); }
      catch (e) { clearTimeout(timer); finish({ ok: false, error: e.message }); }
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(timer);
        try { finish(JSON.parse(buf.slice(0, i))); } catch { finish({ ok: false, error: 'bad response' }); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  });
}
