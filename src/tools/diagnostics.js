// LSP tool — real compiler diagnostics and symbol lookup, from the project's own language
// server.
//
// WHY THIS IS WORTH A TOOL
// -----------------------
// Every other check hncode can make about an edit is textual: does the string match, does
// the file parse as JSON, does grep find the symbol elsewhere. None of them can say "this
// does not compile", which is the one thing a developer most wants to know after an edit.
// A language server can, and it is already installed on many machines.
//
// DIAGNOSTICS ARE PUSHED, NOT PULLED
// ----------------------------------
// LSP has no "give me the problems in this file" request. A server sends
// `publishDiagnostics` when it has computed them, which for a cold server is after it has
// indexed the project — seconds, not milliseconds. So `diagnostics` waits for that
// notification, and reports whether it ARRIVED. An empty list from a settled server means
// the file is clean; an empty list from a timeout means "not known yet", and the two must
// not be reported the same way, or the tool becomes a source of false confidence.
//
// NO SERVER IS NOT A FAILURE
// --------------------------
// Most machines have no server for most languages. The tool says which one it wanted and
// what to install, and the turn carries on — a missing language server must never fail an
// edit.

import fs from 'node:fs';
import path from 'node:path';
import {
  findServer, availableServers, startClient, openDocument, waitForDiagnostics,
  formatDiagnostic, languageFor, fileUri,
} from '../lsp.js';
import { resolvePath } from './utils.js';

// One client per (server, root), reused across calls in a turn. Starting rust-analyzer is
// seconds of indexing; doing it per call would make the tool useless.
const clients = new Map();
const clientKey = (serverId, root) => `${serverId}\u0000${root}`;

async function clientFor(server, root) {
  const key = clientKey(server.id, root);
  const existing = clients.get(key);
  if (existing && !existing.dead()) return existing;
  if (existing) clients.delete(key);
  const started = await startClient(server, root, {});
  if (!started.ok) return { error: started.error };
  clients.set(key, started.client);
  return started.client;
}

/** Stop every running server. Called on exit so no orphan process is left behind. */
export async function stopLspClients() {
  const all = [...clients.values()];
  clients.clear();
  for (const c of all) { try { await c.stop(); } catch { /* going away anyway */ } }
}

/** For tests and for the TUI: which servers are live right now. */
export function liveLspClients() {
  return [...clients.entries()].map(([k, c]) => ({ key: k, serverId: c.serverId, root: c.root }));
}

export const spec = {
  name: 'Diagnostics',
  description: `Ask the project's language server for the REAL compiler errors in a file — the answer a build would give, without running one.

Use it after a change that could break the build (a rename, a signature change, a new import), instead of guessing from reading the code. The file is opened in the server, so results include errors the server only knows about AFTER indexing, which can take a moment on a cold project.

Supported when the matching server is installed: rust-analyzer (.rs), typescript-language-server (.ts/.js), pyright-langserver (.py), gopls (.go), clangd (.c/.cpp). If none is installed the tool says which one it wanted.

The result distinguishes "no problems" from "the server did not answer in time" — never treat the second as clean.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to check.' },
      wait_seconds: { type: 'integer', minimum: 1, maximum: 120, description: 'How long to wait for the server to report. Default 20. A cold project needs longer.' },
    },
    required: ['path'],
  },

  async execute(args, ctx) {
    if (typeof args.path !== 'string' || !args.path.trim()) return 'Error: `path` is required.';
    let abs;
    try { abs = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    if (!fs.existsSync(abs)) return `Error: ${args.path} does not exist.`;

    const server = findServer(abs);
    if (!server) {
      const installed = availableServers();
      const ext = path.extname(abs) || '(no extension)';
      return `No language server for ${ext}. `
        + (installed.length
          ? `Installed here: ${installed.map((s) => `${s.id} (${s.command})`).join(', ')}.`
          : 'None of rust-analyzer, typescript-language-server, pyright-langserver, gopls or clangd is installed.')
        + ' Install one to get diagnostics; nothing else is affected.';
    }

    const root = ctx.workspace || ctx.cwd || process.cwd();
    const client = await clientFor(server, root);
    if (client.error) return `Error: could not start ${server.command}: ${client.error}`;

    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (e) { return `Error reading ${args.path}: ${e.message}`; }

    // Clear the previous answer for THIS file first, so a fresh didOpen result cannot be
    // confused with a stale one from the same server. The URI comes from `fileUri`, the
    // same function `openDocument` uses — building it by hand here drifted on Windows,
    // where a backslash path and a `file://` URI are not interchangeable.
    const uri = fileUri(abs);
    for (let i = client.notifications.length - 1; i >= 0; i--) {
      const n = client.notifications[i];
      if (n.method === 'textDocument/publishDiagnostics' && n.params && n.params.uri === uri) {
        client.notifications.splice(i, 1);
      }
    }
    openDocument(client, abs, text, languageFor(abs));

    const waitMs = Math.min(120, Math.max(1, Number(args.wait_seconds) || 20)) * 1000;
    const { diagnostics, settled } = await waitForDiagnostics(client, abs, waitMs);

    if (!settled) {
      return `The ${server.id} server did not report on ${args.path} within ${waitMs / 1000}s.`
        + `\nThis is NOT a clean result — it means the answer is unknown. A large project can take`
        + `\nlonger to index the first time; retry with a larger wait_seconds.`
        + (client.stderrTail() ? `\n\nServer output:\n${client.stderrTail().slice(-600)}` : '');
    }

    if (!diagnostics.length) return `${args.path}: no problems reported by ${server.id}.`;

    // Worst first: an error is what blocks a build, ahead of a warning or a hint.
    const order = { error: 0, warning: 1, information: 2, hint: 3 };
    const sorted = diagnostics.slice().sort((a, b) => {
      const sa = order[(['', 'error', 'warning', 'information', 'hint'][a.severity || 1])] ?? 9;
      const sb = order[(['', 'error', 'warning', 'information', 'hint'][b.severity || 1])] ?? 9;
      if (sa !== sb) return sa - sb;
      const la = a.range && a.range.start ? a.range.start.line : 0;
      const lb = b.range && b.range.start ? b.range.start.line : 0;
      return la - lb;
    });
    for (const d of sorted) {
      d._file = abs;
      // A diagnostic can point at ANOTHER file; report that file rather than this one, or
      // an error about a type defined elsewhere reads as if it were in the file asked about.
      if (d.relatedInformation) {
        for (const ri of d.relatedInformation) {
          if (ri.location && ri.location.uri) d._file = abs;
        }
      }
    }

    const counts = { error: 0, warning: 0, other: 0 };
    for (const d of sorted) {
      const name = ['', 'error', 'warning', 'information', 'hint'][d.severity || 1] || 'info';
      if (name === 'error') counts.error += 1;
      else if (name === 'warning') counts.warning += 1;
      else counts.other += 1;
    }
    const summary = [
      counts.error ? `${counts.error} error(s)` : '',
      counts.warning ? `${counts.warning} warning(s)` : '',
      counts.other ? `${counts.other} more` : '',
    ].filter(Boolean).join(', ');

    const shown = sorted.slice(0, 50);
    const header = `${args.path}: ${summary} — from ${server.id}`;
    const body = shown.map((d) => formatDiagnostic(d, root)).join('\n');
    const more = sorted.length > shown.length
      ? `\n… and ${sorted.length - shown.length} more`
      : '';
    return `${header}\n\n${body}${more}`;
  },
};

/** Exported for tests. */
export { fileUri };
