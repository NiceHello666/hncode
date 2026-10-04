// LSP client: real diagnostics and symbol lookup from a language server.
//
// WHY THIS IS NOT AN MCP SERVER
// ----------------------------
// `src/mcp.js` already speaks JSON-RPC, and the temptation is to reuse it. But MCP frames
// messages as NEWLINE-DELIMITED JSON while LSP frames them with a `Content-Length` header —
// mcp.js says so itself ("MCP's stdio transport is line-delimited (NOT Content-Length
// framed — that is the LSP convention, and mixing them up is the usual way this breaks)").
// Sharing the transport would mean one of the two protocols being wrong. So the framing is
// implemented here, and only the framing: everything above it is plain JSON-RPC.
//
// WHAT IT IS FOR
// --------------
// A model editing code benefits from the same thing a human does: being told that the line
// it just wrote does not compile. This gives the agent that, without a build step and
// without guessing — the compiler's own answer, over the protocol its own tooling speaks.
//
// NO SERVER IS NOT AN ERROR
// -------------------------
// Most machines have no language server installed. That is the normal case, not a broken
// one: `findServer` returns null, callers report "no server for this file", and everything
// else in hncode works exactly as before. A missing server must never make a turn fail.

import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** A server definition: how to start it and which files it handles. */
export const SERVERS = [
  {
    id: 'rust-analyzer',
    command: 'rust-analyzer',
    extensions: ['.rs'],
    // rust-analyzer only speaks stdio when told to; it otherwise looks for a socket.
    args: [],
  },
  {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  {
    id: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
  },
  {
    id: 'gopls',
    command: 'gopls',
    extensions: ['.go'],
  },
  {
    id: 'clangd',
    command: 'clangd',
    extensions: ['.c', '.h', '.cc', '.cpp', '.hpp', '.cxx'],
  },
];

/** Is `command` runnable? Checked without spawning, so a probe costs nothing. */
export function commandExists(command) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        const p = path.join(d, command + ext);
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * The server that handles a file, or null.
 *
 * @param {string} file
 * @returns {{id:string, command:string, args:string[], bin:string}|null}
 */
export function findServer(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (!ext) return null;
  for (const s of SERVERS) {
    if (!s.extensions.includes(ext)) continue;
    const bin = commandExists(s.command);
    if (bin) return { ...s, bin };
  }
  return null;
}

/** Every server that is actually installed here, for /doctor and the tool's error text. */
export function availableServers() {
  return SERVERS.map((s) => ({ id: s.id, command: s.command, bin: commandExists(s.command) }))
    .filter((s) => s.bin)
    .map((s) => ({ id: s.id, command: s.command, bin: s.bin }));
}

// ---- framing ---------------------------------------------------------------

/**
 * Encode one JSON-RPC message with an LSP `Content-Length` header.
 *
 * The length is BYTES, not characters. A message containing a non-ASCII identifier —
 * a Rust symbol with a Greek letter, a comment in Chinese — would be cut short by a
 * character count, and the server would then desynchronise on the next frame, which shows
 * up as every subsequent request hanging.
 */
export function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  const len = Buffer.byteLength(json, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${len}\r\n\r\n`, 'ascii'),
    Buffer.from(json, 'utf8'),
  ]);
}

/**
 * A streaming decoder for `Content-Length` frames.
 *
 * Chunk boundaries are arbitrary, so a frame can arrive split or several at once. State is
 * kept between calls; `push` returns whatever complete messages are available NOW.
 */
export function createDecoder() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      for (;;) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) break;
        const header = buf.slice(0, sep).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          // An unparseable header means the stream is lost: drop what we have rather than
          // spinning on it forever.
          buf = buf.slice(sep + 4);
          continue;
        }
        const len = Number(m[1]);
        const start = sep + 4;
        if (buf.length < start + len) break;      // the rest has not arrived yet
        const body = buf.slice(start, start + len).toString('utf8');
        // Advance past the EXACT byte length, which is why the header was byte-counted.
        buf = buf.slice(start + len);
        try { out.push(JSON.parse(body)); } catch { /* a malformed frame is skipped */ }
      }
      return out;
    },
    /** Bytes held back waiting for the rest of a frame. */
    get pending() { return buf.length; },
  };
}

// ---- the client ------------------------------------------------------------

/** How long to wait for a server to answer before giving up. A language server that has
 *  not indexed a project will not answer at all, and a hung request is worse than an
 *  honest "no answer". */
const DEFAULT_TIMEOUT_MS = 20_000;
/** How long to let the server finish its handshake and initial analysis. */
const INIT_TIMEOUT_MS = 30_000;

/**
 * Start a server and complete the LSP handshake.
 *
 * @returns {Promise<{ok:true, client:object} | {ok:false, error:string}>}
 */
export async function startClient(server, root, opts = {}) {
  const log = opts.log || (() => {});
  let child;
  try {
    child = cp.spawn(server.bin, server.args || [], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A shell is NOT used: the argv is already resolved, and a shell would let a path
      // with a space in it split into two arguments.
      shell: false,
    });
  } catch (e) {
    return { ok: false, error: `could not start ${server.command}: ${e.message}` };
  }

  const decoder = createDecoder();
  const pending = new Map();
  let nextId = 1;
  let dead = null;
  let stderrTail = '';
  const notifications = [];

  child.stdout.on('data', (chunk) => {
    for (const msg of decoder.push(chunk)) {
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const waiter = pending.get(msg.id);
        if (waiter) { pending.delete(msg.id); waiter(msg); }
      } else if (msg.method) {
        // Server-initiated notifications and requests (publishDiagnostics, and the
        // registerCapability requests a server sends during init). Requests are answered
        // with a null result so the server does not block waiting on us.
        notifications.push(msg);
        if (msg.id != null) {
          try { child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: msg.id, result: null })); }
          catch { /* the pipe is already gone */ }
        }
      }
    }
  });
  child.stderr.on('data', (d) => {
    // Keep only the tail: rust-analyzer is chatty and the useful error is the last line.
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  const onExit = (code, signal) => {
    dead = `the language server exited (${signal || code})${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-1)[0]}` : ''}`;
    for (const [, waiter] of pending) waiter({ error: { message: dead } });
    pending.clear();
  };
  child.on('exit', onExit);
  child.on('error', (e) => { dead = `the language server failed: ${e.message}`; });

  function send(msg) {
    if (dead) return Promise.reject(new Error(dead));
    try { child.stdin.write(encodeMessage(msg)); }
    catch (e) { return Promise.reject(e); }
    return null;
  }

  function request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (dead) return Promise.reject(new Error(dead));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
      try { child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params })); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }

  function notify(method, params) {
    try { child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params })); }
    catch { /* a dead pipe: the exit handler has already recorded why */ }
  }

  const rootUri = pathToFileURL(path.resolve(root)).href;
  const capabilities = {
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: true },
      publishDiagnostics: { relatedInformation: true },
      hover: { contentFormat: ['plaintext', 'markdown'] },
      definition: { linkSupport: false },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    },
    workspace: { workspaceFolders: true, configuration: true },
  };

  try {
    await request('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: path.resolve(root),
      workspaceFolders: [{ uri: rootUri, name: path.basename(path.resolve(root)) }],
      capabilities,
      initializationOptions: opts.initializationOptions || {},
    }, INIT_TIMEOUT_MS);
  } catch (e) {
    try { child.kill(); } catch { /* already gone */ }
    return { ok: false, error: `initialize failed: ${e.message}` };
  }
  notify('initialized', {});

  return {
    ok: true,
    client: {
      root,
      serverId: server.id,
      request,
      notify,
      notifications,
      stderrTail: () => stderrTail,
      dead: () => dead,
      async stop() {
        try { await request('shutdown', null, 3000); } catch { /* shutting down anyway */ }
        notify('exit', null);
        setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 250);
      },
      _child: child,
      _raw: { log },
    },
  };
}

/** Turn a file path into the `file://` URI LSP expects. */
export function fileUri(file) {
  return pathToFileURL(path.resolve(file)).href;
}

/** And back, for the locations a server reports. */
export function uriToPath(uri) {
  try { return fileURLToPath(uri); } catch { return String(uri); }
}

/**
 * Open a document. LSP has no "read this file" request — a server only knows about
 * documents the client has TOLD it about, so `didOpen` is mandatory before any query
 * about a file will answer.
 */
export function openDocument(client, file, text, languageId) {
  client.notify('textDocument/didOpen', {
    textDocument: {
      uri: fileUri(file),
      languageId: languageId || languageFor(file),
      version: 1,
      text,
    },
  });
}

/** Re-send a document's content after it changed on disk. */
export function changeDocument(client, file, text, version) {
  client.notify('textDocument/didChange', {
    textDocument: { uri: fileUri(file), version: version || 2 },
    contentChanges: [{ text }],
  });
}

/** The LSP `languageId` for a file, which servers key their behaviour on. */
export function languageFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return {
    '.rs': 'rust',
    '.ts': 'typescript', '.tsx': 'typescriptreact',
    '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.pyi': 'python',
    '.go': 'go',
    '.c': 'c', '.h': 'c',
    '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  }[ext] || 'plaintext';
}

/**
 * Diagnostics for one file, from the notifications the server has sent.
 *
 * LSP has no "give me diagnostics" request: the server PUSHES them as `publishDiagnostics`
 * when it has computed them, which for a cold server is after it has indexed the project.
 * So this waits for the notification for this file, up to `waitMs`. Returning `[]` on a
 * timeout would claim the file is clean when the truth is "not known yet", so the caller
 * gets `settled` and can say which it was.
 *
 * @returns {Promise<{diagnostics: Array, settled: boolean}>}
 */
export async function waitForDiagnostics(client, file, waitMs = 15_000) {
  const want = fileUri(file);
  const latest = () => {
    for (let i = client.notifications.length - 1; i >= 0; i--) {
      const n = client.notifications[i];
      if (n.method === 'textDocument/publishDiagnostics' && n.params && n.params.uri === want) {
        return n.params.diagnostics || [];
      }
    }
    return null;
  };
  const now = latest();
  if (now) return { diagnostics: now, settled: true };

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (client.dead()) return { diagnostics: [], settled: false };
    await new Promise((r) => setTimeout(r, 100));
    const got = latest();
    if (got) return { diagnostics: got, settled: true };
  }
  // An empty list IS a valid answer (a clean file), so the caller must be able to tell
  // "no problems" from "no answer", which is what `settled` is for.
  return { diagnostics: [], settled: false };
}

/** Severity numbers LSP uses, in words. */
export const SEVERITY_NAMES = ['', 'error', 'warning', 'information', 'hint'];

/** One diagnostic as a readable line: `error 12:5  cannot find value \`x\``. */
export function formatDiagnostic(d, root) {
  const sev = SEVERITY_NAMES[d.severity || 1] || 'info';
  const line = (d.range && d.range.start ? d.range.start.line : 0) + 1;
  const col = (d.range && d.range.start ? d.range.start.character : 0) + 1;
  const where = root ? path.relative(root, d._file || '').split(path.sep).join('/') : (d._file || '');
  const src = d.source ? ` [${d.source}]` : '';
  const msg = String(d.message || '').replace(/\s+/g, ' ').trim();
  return `${sev.padEnd(7)} ${where}${where ? ':' : ''}${line}:${col}${src}  ${msg}`;
}
