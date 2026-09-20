// MCP client — connect to Model Context Protocol servers and expose their tools.
//
// The Model Context Protocol is an open JSON-RPC 2.0 standard. A server speaks it
// over stdio (a child process) or HTTP. This module implements the CLIENT side so
// an hncode session can use tools from servers the user configures.
//
// Config (`~/.hncode/mcp.json`, or a per-project `<workspace>/.hncode/mcp.json`):
//
//   {
//     "mcpServers": {
//       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
//       "remote":     { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
//     }
//   }
//
// Lifecycle, per the spec:
//   1. start the transport
//   2. `initialize`                 (protocolVersion + clientInfo) -> capabilities
//   3. `notifications/initialized`
//   4. `tools/list`                 -> tool definitions
//   5. `tools/call`                 -> per invocation
//
// Discovered tools are registered through plugin.registerTool() so they reach the
// model with no changes to the toolbelt, the agent loop, or the LLM adapters.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

// The protocol revision this client speaks. Servers negotiate down if needed.
export const PROTOCOL_VERSION = '2024-11-05';
export const CLIENT_INFO = { name: 'hncode', version: '0.3.1' };

// How long a server gets to complete the initialize + tools/list handshake. This
// runs BEFORE the TUI opens, so it is deliberately short: a wedged server should
// cost a few seconds, not the 30s a tool call is allowed.
export const CONNECT_TIMEOUT_MS = 8_000;

// Live connections made at startup, shared by every consumer of the MCP client
// (the CLI startup and the TUI's /mcp). Kept in this module rather than passed
// around so the status view can always see the real state.
let liveConnections = [];
export function setLiveConnections(conns) { liveConnections = conns || []; }
export function getLiveConnections() { return liveConnections; }

export function globalMcpFile() {
  return process.env.HNCODE_MCP_FILE || path.join(os.homedir(), '.hncode', 'mcp.json');
}
export function projectMcpFile(workspace) {
  return path.join(workspace || process.cwd(), '.hncode', 'mcp.json');
}

// Merge global + project server definitions (project wins on a name clash).
// Returns { servers: {name: def}, errors: [string] }. Never throws.
export function loadMcpConfig(workspace) {
  const out = { servers: {}, errors: [] };
  const files = workspace ? [globalMcpFile(), projectMcpFile(workspace)] : [globalMcpFile()];
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(f);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    let doc;
    try { doc = JSON.parse(text); } catch (e) { out.errors.push(`${abs}: invalid JSON (${e.message})`); continue; }
    const servers = (doc && doc.mcpServers) || {};
    for (const [name, def] of Object.entries(servers)) {
      if (!def || typeof def !== 'object') { out.errors.push(`${abs}: server "${name}" must be an object`); continue; }
      if (!def.command && !def.url) { out.errors.push(`${abs}: server "${name}" needs "command" or "url"`); continue; }
      out.servers[name] = { ...def, _source: abs };
    }
  }
  return out;
}

// ---- JSON-RPC framing -------------------------------------------------------

// A stdio connection: newline-delimited JSON-RPC over the child's stdin/stdout.
// MCP's stdio transport is line-delimited (NOT Content-Length framed — that is
// the LSP convention, and mixing them up is the usual way this breaks).
export function createStdioTransport(command, args, opts = {}) {
  const child = cp.spawn(command, args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env || {}) },
    cwd: opts.cwd || process.cwd(),
    windowsHide: true,
    // npm-installed shims are `.cmd` on Windows and need a shell to run.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  });
  const state = {
    child,
    buffer: '',
    nextId: 1,
    pending: new Map(),   // id -> { resolve, reject, timer }
    closed: false,
    stderr: '',
    handlers: [],
  };
  child.stdout.on('data', (d) => {
    state.buffer += d.toString('utf8');
    let i;
    while ((i = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, i).trim();
      state.buffer = state.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // ignore non-JSON noise
      handleMessage(state, msg);
    }
  });
  child.stderr.on('data', (d) => { state.stderr = (state.stderr + d.toString('utf8')).slice(-4000); });
  child.on('error', (e) => failAll(state, `server process error: ${e.message}`));
  child.on('close', (code) => { state.closed = true; failAll(state, `server exited (code ${code})`); });
  return state;
}

function handleMessage(state, msg) {
  if (msg.id != null && state.pending.has(msg.id)) {
    const p = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  // A server-initiated REQUEST (e.g. sampling). Answer politely so the server
  // does not hang; hncode does not implement sampling, so it is "not supported".
  if (msg.method && msg.id != null) {
    try {
      writeMessage(state, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
    } catch { /* transport closed */ }
    return;
  }
  for (const h of state.handlers) { try { h(msg); } catch { /* a notification handler must not throw */ } }
}

function failAll(state, reason) {
  for (const [, p] of state.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  state.pending.clear();
}

function writeMessage(state, msg) {
  if (state.closed || !state.child.stdin || state.child.stdin.destroyed) throw new Error('transport closed');
  state.child.stdin.write(JSON.stringify(msg) + '\n');
}

// Send a request and await its reply. `timeoutMs` guards a wedged server.
export function request(state, method, params, timeoutMs = 30_000) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    try { writeMessage(state, { jsonrpc: '2.0', id, method, params: params || {} }); }
    catch (e) { state.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

function notify(state, method, params) {
  try { writeMessage(state, { jsonrpc: '2.0', method, params: params || {} }); } catch { /* best-effort */ }
}

// ---- HTTP transport ---------------------------------------------------------

// Streamable-HTTP transport: one POST per JSON-RPC message. The server may reply
// with JSON or an SSE stream; both are parsed here.
export function createHttpTransport(url, headers) {
  return {
    kind: 'http',
    url,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(headers || {}) },
    sessionId: null,
    nextId: 1,
  };
}

export async function httpRequest(state, method, params, timeoutMs = 30_000) {
  const id = state.nextId++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(state.url, {
      method: 'POST',
      headers: state.sessionId ? { ...state.headers, 'mcp-session-id': state.sessionId } : state.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
      signal: ctrl.signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) state.sessionId = sid;
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      const msg = parseSseForId(await res.text(), id);
      if (!msg) throw new Error('no response message in SSE stream');
      if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
      return msg.result;
    }
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Pull the JSON-RPC reply for `id` out of an SSE body.
export function parseSseForId(body, id) {
  for (const line of String(body || '').split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const msg = JSON.parse(payload);
      if (msg && msg.id === id) return msg;
    } catch { /* not JSON: skip */ }
  }
  return null;
}

// ---- connection + tool discovery -------------------------------------------

// Connect to one server, handshake, and list its tools.
// Returns { ok, tools, error, serverInfo, transport, isHttp } — never throws.
export async function connectServer(name, def, opts = {}) {
  // CONNECT_TIMEOUT (not the 30s tool-call timeout): this runs during startup, so
  // a wedged server must not hold the session hostage. 8s is generous for a
  // handshake while keeping a dead server's cost to single-digit seconds.
  const timeoutMs = opts.timeoutMs || CONNECT_TIMEOUT_MS;
  let transport;
  const isHttp = !!def.url;
  try {
    transport = isHttp
      ? createHttpTransport(def.url, def.headers)
      : createStdioTransport(def.command, def.args, { env: def.env, cwd: def.cwd });
  } catch (e) {
    return { ok: false, tools: [], error: `could not start "${name}": ${e.message}` };
  }

  const send = (method, params) => (isHttp
    ? httpRequest(transport, method, params, timeoutMs)
    : request(transport, method, params, timeoutMs));

  try {
    const init = await send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO,
    });
    if (!isHttp) notify(transport, 'notifications/initialized', {});
    const list = await send('tools/list', {});
    const tools = Array.isArray(list && list.tools) ? list.tools : [];
    return { ok: true, tools, error: null, serverInfo: (init && init.serverInfo) || {}, transport, isHttp };
  } catch (e) {
    try { if (!isHttp) transport.child.kill(); } catch { /* already gone */ }
    return { ok: false, tools: [], error: `"${name}": ${e.message}` };
  }
}

// Call one tool on a connected server. Returns { ok, text, error, raw }.
export async function callTool(transport, isHttp, toolName, args, timeoutMs = 60_000) {
  try {
    const result = isHttp
      ? await httpRequest(transport, 'tools/call', { name: toolName, arguments: args || {} }, timeoutMs)
      : await request(transport, 'tools/call', { name: toolName, arguments: args || {} }, timeoutMs);
    return { ok: true, text: flattenContent(result), error: null, raw: result };
  } catch (e) {
    return { ok: false, text: '', error: e.message, raw: null };
  }
}

// MCP tool results carry a `content` array of typed blocks. Flatten to text for
// the model; non-text blocks are described rather than dropped silently.
export function flattenContent(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'resource' && b.resource) parts.push(`[resource ${b.resource.uri || ''}]`);
    else if (b.type === 'image') parts.push(`[image ${b.mimeType || ''}]`);
    else parts.push(`[${b.type || 'unknown'} block]`);
  }
  if (!parts.length && typeof result.text === 'string') parts.push(result.text);
  return parts.join('\n');
}

// A tool name safe for every provider's function-name rules and for matching
// back to its server + original name. Providers want [A-Za-z0-9_-], so
// "server.tool" becomes "mcp__server__tool".
export function mcpToolName(server, tool) {
  const clean = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`;
}

// Convert an MCP tool definition into an hncode tool spec whose execute() calls
// back into the server.
export function toHncodeSpec(server, tool, transport, isHttp) {
  return {
    name: mcpToolName(server, tool.name),
    description: (tool.description || `MCP tool ${tool.name} from ${server}.`).slice(0, 4000),
    parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
    _mcp: { server, tool: tool.name },
    async execute(args) {
      const r = await callTool(transport, isHttp, tool.name, args);
      if (!r.ok) return `Error calling ${server}/${tool.name}: ${r.error}`;
      // MCP signals tool-level failure with isError, not a JSON-RPC error.
      if (r.raw && r.raw.isError) return `Error from ${server}/${tool.name}: ${r.text}`;
      return r.text || '(no output)';
    },
  };
}

// Connect every configured server and register its tools through the plugin API.
// Returns { servers: [...], toolCount }.
export async function connectAll(config, registerTool, opts = {}) {
  const only = opts.only;
  const entries = Object.entries((config && config.servers) || {}).filter(([name]) => !only || only.includes(name));
  // Connect in PARALLEL. This runs on the startup path, before the TUI opens, so
  // a serial loop meant one slow/wedged server delayed every later one — N dead
  // servers cost N × timeout before the user saw anything. Runs concurrently, the
  // whole set costs the SLOWEST single server instead of their sum.
  const results = await Promise.all(entries.map(async ([name, def]) => {
    const conn = await connectServer(name, def, opts);
    if (!conn.ok) return { name, ok: false, toolCount: 0, error: conn.error, serverInfo: {} };
    let registered = 0;
    let err = null;
    for (const tool of conn.tools) {
      if (!tool || !tool.name) continue;
      try {
        registerTool(toHncodeSpec(name, tool, conn.transport, conn.isHttp));
        registered++;
      } catch (e) {
        // A name clash with a built-in is reported, not fatal: keep the rest.
        err = err || `tool "${tool.name}": ${e.message}`;
      }
    }
    return { name, ok: true, toolCount: registered, error: err, serverInfo: conn.serverInfo, transport: conn.transport, isHttp: conn.isHttp };
  }));
  const toolCount = results.reduce((n, r) => n + (r.toolCount || 0), 0);
  return { servers: results, toolCount };
}
// Disconnect every connected server (kills stdio children). HTTP needs nothing.

// Disconnect every connected server (kills stdio children). HTTP needs nothing.
export function disconnectAll(connections) {
  for (const c of connections || []) {
    if (c && c.transport && c.transport.child) {
      try { c.transport.child.kill(); } catch { /* already gone */ }
    }
  }
}

// Human-readable status for /mcp.
export function describeServers(config, connections) {
  const names = Object.keys((config && config.servers) || {});
  if (!names.length) {
    return ['No MCP servers configured.', '', `Config file: ${globalMcpFile()}`,
      'Add one with /mcp-config add <name> <command|url> [args...]'];
  }
  const byName = new Map((connections || []).map((c) => [c.name, c]));
  const lines = [`MCP servers (${names.length}) — config: ${globalMcpFile()}`, ''];
  for (const n of names) {
    const def = config.servers[n];
    const conn = byName.get(n);
    const target = def.url ? def.url : `${def.command || ''} ${(def.args || []).join(' ')}`.trim();
    let status;
    if (!conn) status = 'not connected';
    else if (!conn.ok) status = `FAILED: ${conn.error}`;
    else status = `connected — ${conn.toolCount} tool(s)${conn.serverInfo && conn.serverInfo.name ? ` (${conn.serverInfo.name})` : ''}`;
    lines.push(`  ${n}: ${status}`);
    lines.push(`      ${target}`);
    if (conn && conn.error) lines.push(`      ! ${conn.error}`);
  }
  return lines;
}
