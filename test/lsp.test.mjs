// LSP client: framing, discovery, and the client/server handshake over a real pipe.
//
// WHY THESE ASSERTIONS
// --------------------
// The framing is the part that goes wrong in a way nothing else catches. A `Content-Length`
// that counted CHARACTERS instead of BYTES does not fail loudly: the server reads a short
// body, the next frame starts mid-JSON, and every subsequent request hangs. That failure
// appears minutes later as a frozen tool, nowhere near the cause. So the framing is tested
// directly, including a multibyte body and arbitrary chunk boundaries.
//
// The handshake is tested against a REAL child process speaking the protocol, not a mock:
// the whole point of this module is that it talks to something outside the process, and a
// mock would only prove the mock and the client agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  encodeMessage, createDecoder, findServer, availableServers, commandExists,
  startClient, openDocument, waitForDiagnostics, formatDiagnostic,
  fileUri, uriToPath, languageFor, SERVERS,
} = await import('../src/lsp.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-lsp-'));

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

test('a frame declares its body length in BYTES, not characters', () => {
  // The multibyte case is the one that breaks a character count.
  for (const body of ['plain', '你好世界', 'emoji 🌍 here', '']) {
    const enc = encodeMessage({ jsonrpc: '2.0', id: 1, params: { s: body } });
    const header = enc.slice(0, enc.indexOf('\r\n\r\n')).toString('ascii');
    const declared = Number(/Content-Length:\s*(\d+)/.exec(header)[1]);
    const actual = enc.length - (enc.indexOf('\r\n\r\n') + 4);
    assert.equal(declared, actual, `declared ${declared} vs actual ${actual} for ${JSON.stringify(body)}`);
    assert.equal(declared, Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, params: { s: body } }), 'utf8'));
  }
});

test('a frame round-trips through the decoder', () => {
  const msg = { jsonrpc: '2.0', id: 7, result: { ok: true, text: '你好' } };
  const out = createDecoder().push(encodeMessage(msg));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], msg);
});

test('a frame split across arbitrary chunks still decodes exactly once', () => {
  const msg = { jsonrpc: '2.0', id: 2, method: 'm', params: { s: 'x'.repeat(50) } };
  const enc = encodeMessage(msg);
  // Every split point, so no off-by-one in the header parse can hide.
  for (let cut = 1; cut < enc.length; cut++) {
    const d = createDecoder();
    const first = d.push(enc.slice(0, cut));
    const second = d.push(enc.slice(cut));
    const all = [...first, ...second];
    assert.equal(all.length, 1, `split at ${cut} produced ${all.length} messages`);
    assert.deepEqual(all[0], msg);
  }
});

test('several frames in one chunk all decode', () => {
  const d = createDecoder();
  const buf = Buffer.concat([encodeMessage({ id: 1, result: 1 }), encodeMessage({ id: 2, result: 2 }), encodeMessage({ id: 3, result: 3 })]);
  const out = d.push(buf);
  assert.deepEqual(out.map((m) => m.id), [1, 2, 3]);
  assert.equal(d.pending, 0, 'nothing is left buffered');
});

test('a partial frame is held, not dropped', () => {
  const enc = encodeMessage({ id: 9, result: 'hello' });
  const d = createDecoder();
  assert.deepEqual(d.push(enc.slice(0, enc.length - 3)), [], 'no message yet');
  assert.ok(d.pending > 0, 'the partial frame is still buffered');
  const out = d.push(enc.slice(enc.length - 3));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 9);
});

test('a body longer than one chunk is assembled from both', () => {
  // The realistic case: a large publishDiagnostics arriving across several reads.
  const big = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///x', diagnostics: Array.from({ length: 300 }, (_, i) => ({ message: `problem ${i}`, severity: 1 })) } };
  const enc = encodeMessage(big);
  const d = createDecoder();
  let out = [];
  for (let i = 0; i < enc.length; i += 97) out = out.concat(d.push(enc.slice(i, i + 97)));
  assert.equal(out.length, 1);
  assert.equal(out[0].params.diagnostics.length, 300);
});

test('an unparseable header is skipped rather than looping forever', () => {
  const d = createDecoder();
  // A garbage line, then a valid frame: the good one must still come through.
  const junk = Buffer.from('NOT A HEADER\r\n\r\n', 'ascii');
  const out = d.push(Buffer.concat([junk, encodeMessage({ id: 5, result: 'ok' })]));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 5);
});

test('a malformed JSON body is skipped, not thrown', () => {
  const bad = Buffer.from('Content-Length: 5\r\n\r\n{oops', 'utf8');
  const d = createDecoder();
  const out = d.push(Buffer.concat([bad, encodeMessage({ id: 6, result: 'ok' })]));
  assert.equal(out.length, 1, 'the good frame survived');
  assert.equal(out[0].id, 6);
});

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

test('server discovery maps extensions to a server', () => {
  // Asserted through the table, so the mapping is pinned even on a machine with nothing
  // installed (which is the common case).
  const byExt = {};
  for (const s of SERVERS) for (const e of s.extensions) byExt[e] = s.id;
  assert.equal(byExt['.rs'], 'rust-analyzer');
  assert.equal(byExt['.ts'], 'typescript');
  assert.equal(byExt['.py'], 'pyright');
  assert.equal(byExt['.go'], 'gopls');
  assert.equal(byExt['.cpp'], 'clangd');
});

test('findServer returns null for a file no server claims', () => {
  assert.equal(findServer('notes.txt'), null);
  assert.equal(findServer('archive.zip'), null);
  assert.equal(findServer('noextension'), null);
  assert.equal(findServer(''), null);
});

test('findServer returns null when the server is simply not installed', () => {
  // This is the NORMAL case and must not be an error: a missing server cannot break a turn.
  const found = findServer('x.py');
  if (commandExists('pyright-langserver')) {
    assert.ok(found, 'pyright is installed, so it is found');
  } else {
    assert.equal(found, null, 'not installed, so nothing is claimed');
  }
});

test('availableServers lists only what can actually run', () => {
  for (const s of availableServers()) {
    assert.ok(commandExists(s.command), `${s.command} should be runnable`);
  }
});

test('the language id is right for each extension a server handles', () => {
  assert.equal(languageFor('a.rs'), 'rust');
  assert.equal(languageFor('a.ts'), 'typescript');
  assert.equal(languageFor('a.tsx'), 'typescriptreact');
  assert.equal(languageFor('a.jsx'), 'javascriptreact');
  assert.equal(languageFor('a.py'), 'python');
  assert.equal(languageFor('a.cpp'), 'cpp');
  assert.equal(languageFor('a.unknown'), 'plaintext');
});

// ---------------------------------------------------------------------------
// URIs
// ---------------------------------------------------------------------------

test('a path converts to a file URI and back', () => {
  const p = path.join(tmp, 'src', 'main.rs');
  const uri = fileUri(p);
  assert.match(uri, /^file:\/\//, 'scheme is present');
  assert.ok(uri.startsWith('file:///'), 'an absolute path has three slashes');
  // The round trip is what matters: the client opens with one and matches notifications on
  // the other, so a mismatch would mean diagnostics that never arrive.
  assert.equal(path.resolve(uriToPath(uri)), path.resolve(p));
});

test('a URI with spaces or unicode survives the round trip', () => {
  const p = path.join(tmp, 'a dir', 'ünïcode.rs');
  assert.equal(path.resolve(uriToPath(fileUri(p))), path.resolve(p));
});

// ---------------------------------------------------------------------------
// the handshake, against a real subprocess
// ---------------------------------------------------------------------------

/** Write a stub LSP server: answers initialize, pushes one diagnostic on didOpen. */
function writeStub(name, diagMessage = 'cannot find value `x`') {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, `
let buf = Buffer.alloc(0);
const send = (o) => {
  const j = JSON.stringify(o);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(j, 'utf8') + '\\r\\n\\r\\n' + j);
};
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep < 0) break;
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, sep).toString('ascii'));
    if (!m) { buf = buf.slice(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) break;
    const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString('utf8'));
    buf = buf.slice(sep + 4 + len);
    if (msg.method === 'initialize') send({ id: msg.id, result: { capabilities: {} } });
    else if (msg.method === 'shutdown') send({ id: msg.id, result: null });
    else if (msg.method === 'exit') process.exit(0);
    else if (msg.method === 'textDocument/didOpen') {
      setTimeout(() => send({ method: 'textDocument/publishDiagnostics', params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } },
          severity: 1, message: ${JSON.stringify(diagMessage)}, source: 'stub' }],
      } }), 40);
    }
  }
});
`, 'utf8');
  return p;
}

const stubServer = (stubPath) => ({ id: 'stub', command: 'node', bin: process.execPath, args: [stubPath], extensions: ['.rs'] });

test('a client completes the handshake with a real server process', async () => {
  const stub = writeStub('ok.mjs');
  const started = await startClient(stubServer(stub), tmp, {});
  assert.equal(started.ok, true, started.ok ? '' : started.error);
  const client = started.client;
  assert.equal(client.serverId, 'stub');
  assert.equal(client.dead(), null, 'the process is alive');
  await client.stop();
});

test('diagnostics arrive for an opened file, and are reported as settled', async () => {
  const stub = writeStub('diag.mjs', 'something is wrong');
  const started = await startClient(stubServer(stub), tmp, {});
  assert.equal(started.ok, true);
  const client = started.client;
  const file = path.join(tmp, 'a.rs');
  fs.writeFileSync(file, 'fn main() {}\n', 'utf8');

  openDocument(client, file, 'fn main() {}\n');
  const { diagnostics, settled } = await waitForDiagnostics(client, file, 5000);
  assert.equal(settled, true, 'the server answered');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, 'something is wrong');
  await client.stop();
});

test('a file the server says nothing about times out as UNSETTLED, not as clean', async () => {
  // The distinction the whole tool depends on: an empty list from a timeout must never be
  // reported as "no problems", or the tool manufactures false confidence.
  const stub = writeStub('quiet.mjs');
  const started = await startClient(stubServer(stub), tmp, {});
  assert.equal(started.ok, true);
  const client = started.client;
  const file = path.join(tmp, 'never-opened.rs');
  const { diagnostics, settled } = await waitForDiagnostics(client, file, 700);
  assert.equal(settled, false);
  assert.deepEqual(diagnostics, []);
  await client.stop();
});

test('a diagnostic is formatted with its severity, position and source', () => {
  const d = {
    range: { start: { line: 11, character: 4 }, end: { line: 11, character: 9 } },
    severity: 1, source: 'rustc', message: 'cannot find value `x`\n  in this scope',
  };
  d._file = path.join(tmp, 'src', 'main.rs');
  const line = formatDiagnostic(d, tmp);
  assert.match(line, /^error/);
  assert.match(line, /src\/main\.rs:12:5/, '1-based line and column');
  assert.match(line, /\[rustc\]/);
  assert.ok(!line.includes('\n'), 'the message is flattened onto one line');
});

test('severities are named, not left as numbers', () => {
  const base = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm' };
  const names = [1, 2, 3, 4].map((severity) => formatDiagnostic({ ...base, severity }, '').trim().split(/\s+/)[0]);
  assert.deepEqual(names, ['error', 'warning', 'information', 'hint']);
});

test('a server that cannot start reports WHY, using its own stderr', async () => {
  // The realistic failure: a shim that exists but refuses to run (a rustup proxy with no
  // toolchain installed does exactly this). The message must carry the server's reason.
  const broken = path.join(tmp, 'broken.mjs');
  fs.writeFileSync(broken, 'process.stderr.write("no toolchain installed\\n"); process.exit(3);\n', 'utf8');
  const started = await startClient(stubServer(broken), tmp, {});
  assert.equal(started.ok, false);
  assert.match(started.error, /exited/);
  assert.match(started.error, /no toolchain installed/, 'the server stderr is surfaced');
});

test('a server binary that does not exist fails cleanly rather than throwing', async () => {
  const started = await startClient({ id: 'ghost', command: 'definitely-not-a-real-binary-xyz', bin: path.join(tmp, 'nope.exe'), args: [] }, tmp, {});
  assert.equal(started.ok, false);
  assert.ok(typeof started.error === 'string' && started.error.length, 'an error is reported');
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
});
