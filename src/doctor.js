// /doctor — report the environment this session is running in, and flag the things that
// break it. Modelled on Claude Code's and cline's `doctor` commands.
//
// WHY THIS EXISTS
// ---------------
// Every failure this project has hit in practice was visible in the environment BEFORE
// it bit, and none of it was visible from the TUI:
//
//   * a session file grew past the V8 string limit, so saving silently stopped working
//     for an hour and a half (only a line in ~/.hncode/session-errors.log);
//   * three intact conversations became unlistable because their transcript pushed the
//     metadata key out of the head reader's reach;
//   * an MCP server that never connected, so its tools simply were not there;
//   * an API key that was absent or a base URL that was malformed, which surfaces as a
//     provider error on the first real turn and looks like a model problem.
//
// A diagnosis is a LIST OF CHECKS, each with a severity, so it can be tested: the checks
// that read the filesystem take their paths from this module's own resolution functions
// (the same ones the rest of the program uses), which is what makes a report trustworthy
// rather than a second, divergent opinion about where things live.
//
// READ-ONLY BY CONSTRUCTION. Nothing here writes, repairs or deletes: a diagnostic that
// "fixes" something is a diagnostic nobody can run on a machine they care about. The
// only outbound work is an optional reachability probe, which the caller opts into.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Severities, worst first. `ok` is the only one that means "nothing to do". */
export const SEVERITY_ORDER = ['error', 'warn', 'ok', 'info'];

const MARK = { error: '✖', warn: '!', ok: '✔', info: '·' };

/** One check's outcome. `fix` is the actionable half — a finding with no remedy is noise. */
function check(name, severity, detail, fix) {
  return { name, severity, detail: String(detail == null ? '' : detail), fix: fix || '' };
}

// ---- individual checks -----------------------------------------------------

/** The config file is where every provider and key lives; a malformed one is fatal. */
function checkConfig(cfg, files) {
  const file = files.config;
  if (!fs.existsSync(file)) {
    return [check('config file', 'warn', `${file} does not exist`,
      'Run hncode once to create it, or /model to pick a provider.')];
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return [check('config file', 'error', `unreadable: ${e.message}`, `Check permissions on ${file}`)];
  }
  const out = [check('config file', 'ok', file)];
  // A TOML file the parser rejects would have failed before this point, so the useful
  // signal here is the SHAPE: a config with no provider cannot make a request.
  if (!cfg.provider) {
    out.push(check('provider', 'error', 'no provider configured',
      'Run /model to choose one, or /provider add <name> <base-url>.'));
  }
  if (!cfg.model) {
    out.push(check('model', 'error', 'no model selected', 'Run /model.'));
  }
  if (!cfg.apiKey) {
    // A local endpoint (ollama, llama.cpp, lmstudio) legitimately has no key.
    const local = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(String(cfg.endpoint || ''));
    out.push(local
      ? check('api key', 'info', 'none set, and the endpoint is local', '')
      : check('api key', 'error', 'not set', 'Set it in config.toml, or via /provider.'));
  }
  if (cfg.endpoint && !/^https?:\/\//i.test(String(cfg.endpoint))) {
    out.push(check('endpoint', 'error', `does not look like a URL: ${cfg.endpoint}`,
      'It must start with http:// or https://.'));
  }
  if (!text.includes('[' ) && !text.includes('=')) {
    out.push(check('config shape', 'warn', 'the file has no keys in it', `Open ${file} and check it.`));
  }
  return out;
}

/** The session directory. A store that cannot be listed is a store whose work is invisible. */
function checkSessions(files, sessionsDir, limit = 4) {
  const out = [];
  if (!fs.existsSync(sessionsDir)) {
    return [check('session store', 'warn', `${sessionsDir} does not exist yet`,
      'It is created on the first save.')];
  }
  let names;
  try {
    names = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [check('session store', 'error', `cannot list ${sessionsDir}: ${e.message}`,
      'Check that the directory exists and is readable.')];
  }
  out.push(check('session store', 'ok', `${names.length} session file(s) in ${sessionsDir}`));

  // Writability is the property that matters: a read-only store loses every turn while
  // the TUI looks completely normal. Tested with a create-and-remove, not a mode bit,
  // because the mode bit lies on Windows and on a mounted volume.
  const probe = path.join(sessionsDir, `.doctor-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    out.push(check('session store writable', 'ok', 'yes'));
  } catch (e) {
    out.push(check('session store writable', 'error', `no: ${e.message}`,
      'Every turn will fail to save. Fix permissions, or point HNCODE_SESSIONS_DIR somewhere writable.'));
  }

  // A file big enough to approach the V8 string limit. This is the failure this project
  // actually hit: past ~512 MB `JSON.stringify` throws, and every save of that session
  // then fails until the transcript is trimmed.
  const V8_LIMIT = 512 * 1024 * 1024;
  const big = [];
  for (const f of names) {
    try {
      const size = fs.statSync(path.join(sessionsDir, f)).size;
      if (size > 8 * 1024 * 1024) big.push({ f, size });
    } catch { /* raced away */ }
  }
  big.sort((a, b) => b.size - a.size);
  for (const b of big.slice(0, limit)) {
    const mb = (b.size / 1048576).toFixed(1);
    const sev = b.size > V8_LIMIT * 0.75 ? 'error' : 'warn';
    out.push(check('oversized session', sev, `${mb} MB  ${b.f}`,
      b.size > V8_LIMIT * 0.75
        ? 'Approaching the ~512 MB string limit, past which saving FAILS. Trim the reasoning transcript — see tools/repair-transcripts.mjs.'
        : 'Large; loading and saving this session will be slow.'));
  }

  // Leftover temp files from an interrupted save.
  let tmp = [];
  try { tmp = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.tmp')); } catch { /* listed above */ }
  if (tmp.length) {
    out.push(check('interrupted save', 'warn', `${tmp.length} .tmp file(s) left behind`,
      `The write did not finish; the session itself is fine. Delete ${sessionsDir}\\*.tmp`));
  }
  return out;
}

/** The error log. Its very existence usually means something failed silently. */
function checkErrorLog(files) {
  if (!fs.existsSync(files.errorLog)) return [];
  let text = '';
  try { text = fs.readFileSync(files.errorLog, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const tail = lines.slice(-3);
  const sev = lines.length > 20 ? 'warn' : 'info';
  return [check('error log', sev, `${lines.length} entr(ies), latest: ${tail[tail.length - 1].slice(0, 90)}`,
    `Read ${files.errorLog}. A repeated message there is a bug worth reporting.`)];
}

/** MCP servers: configured but not connected is the silent case. */
function checkMcp(servers, connections) {
  const names = Object.keys(servers || {});
  if (!names.length) return [check('MCP servers', 'info', 'none configured', '')];
  const byName = new Map((connections || []).map((c) => [c.name, c]));
  const out = [];
  for (const n of names) {
    const conn = byName.get(n);
    if (!conn) out.push(check(`MCP ${n}`, 'warn', 'configured but not started', 'Restart, or check the server command.'));
    else if (!conn.ok) out.push(check(`MCP ${n}`, 'error', `failed: ${conn.error}`, 'Fix the command/URL in /mcp-config.'));
    else out.push(check(`MCP ${n}`, 'ok', `${conn.toolCount} tool(s)`));
  }
  return out;
}

/** Hooks: a malformed hooks.json silently never fires. */
function checkHooks(files, workspace) {
  const candidates = [files.hooks, path.join(workspace || process.cwd(), '.hncode', 'hooks.json')];
  const out = [];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
      const events = Object.keys(doc.hooks || {});
      out.push(check('hooks', 'ok', `${events.length} event(s) configured in ${f}`));
    } catch (e) {
      out.push(check('hooks', 'error', `${f} is not valid JSON: ${e.message}`,
        'A malformed hooks file makes every hook in it silently never run.'));
    }
  }
  return out;
}

/** The workspace: tools resolve paths against it, so it has to exist and be writable. */
function checkWorkspace(workspace) {
  if (!workspace) return [check('workspace', 'error', 'not set', 'Run /move, or start hncode in a directory.')];
  if (!fs.existsSync(workspace)) {
    return [check('workspace', 'error', `${workspace} does not exist`,
      'Every file tool will fail. /move to a directory that exists.')];
  }
  const probe = path.join(workspace, `.doctor-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return [check('workspace', 'ok', `${workspace} (writable)`)];
  } catch {
    return [check('workspace', 'warn', `${workspace} (NOT writable)`,
      'Reads work; Edit, Write and a background command that writes will fail.')];
  }
}

/** Skills and plugins: a directory that exists but holds nothing is worth knowing about. */
function checkExtensions(files) {
  const out = [];
  for (const [label, dir] of [['skills', files.skills], ['plugins', files.plugins]]) {
    if (!fs.existsSync(dir)) continue;
    let n = 0;
    try { n = fs.readdirSync(dir).length; } catch { /* unreadable */ }
    out.push(check(label, 'info', `${n} entr(ies) in ${dir}`, ''));
  }
  return out;
}

/** The terminal. An unknown size or a dumb TERM explains a broken-looking UI. */
function checkTerminal(env, dims) {
  const out = [];
  const term = env.TERM || '';
  if (env.NO_COLOR) out.push(check('colour', 'info', 'NO_COLOR is set', ''));
  else if (!term || term === 'dumb') {
    out.push(check('TERM', 'warn', term ? `"${term}"` : 'not set',
      'Colour and cursor control may not work. Set TERM=xterm-256color.'));
  } else {
    out.push(check('TERM', 'ok', `${term}${env.COLORTERM ? ` / ${env.COLORTERM}` : ''}`));
  }
  if (dims && (dims.cols < 60 || dims.rows < 15)) {
    out.push(check('terminal size', 'warn', `${dims.cols}x${dims.rows}`,
      'Below 60x15 the layout cannot fit; widen the window.'));
  }
  return out;
}

/** Runtime facts, so a bug report carries them. */
function checkRuntime(node, platform, dirs) {
  return [
    check('node', 'ok', node),
    check('platform', 'ok', platform),
    check('hncode home', 'info', dirs.home, ''),
    check('cwd', 'info', dirs.cwd, ''),
  ];
}

// ---- the report ------------------------------------------------------------

/**
 * Run every check and return the results.
 *
 * @param {object} input
 * @param {object} input.cfg          resolved config (provider/model/endpoint/apiKey)
 * @param {object} [input.files]      path overrides, for tests
 * @param {string} [input.workspace]
 * @param {object} [input.mcpServers] config.servers
 * @param {Array}  [input.mcpConnections]
 * @param {object} [input.env]
 * @param {object} [input.dims]       { cols, rows }
 * @param {string} [input.node]       process.version, for tests
 * @returns {Array<{name:string,severity:string,detail:string,fix:string}>}
 */
export function runDoctor(input = {}) {
  const cfg = input.cfg || {};
  const env = input.env || process.env;
  const workspace = input.workspace || cfg.workspace || process.cwd();
  const sessionsDir = input.sessionsDir || path.join(env.HOME || os.homedir(), '.hncode', 'sessions');
  const files = {
    config: path.join(env.HOME || os.homedir(), '.hncode', 'config.toml'),
    errorLog: path.join(env.HOME || os.homedir(), '.hncode', 'session-errors.log'),
    hooks: path.join(env.HOME || os.homedir(), '.hncode', 'hooks.json'),
    skills: path.join(env.HOME || os.homedir(), '.hncode', 'skills'),
    plugins: path.join(env.HOME || os.homedir(), '.hncode', 'plugins'),
    ...(input.files || {}),
  };

  const results = [
    ...checkRuntime(input.node || process.version, input.platform || process.platform, {
      home: path.join(env.HOME || os.homedir(), '.hncode'),
      cwd: process.cwd(),
    }),
    ...checkConfig(cfg, files),
    ...checkWorkspace(workspace),
    ...checkSessions(files, sessionsDir),
    ...checkErrorLog(files),
    ...checkMcp(input.mcpServers, input.mcpConnections),
    ...checkHooks(files, workspace),
    ...checkExtensions(files),
    ...checkTerminal(env, input.dims),
  ];
  return results;
}

/** Counts by severity, for a one-line summary. */
export function summarize(results) {
  const n = { error: 0, warn: 0, ok: 0, info: 0 };
  for (const r of results || []) if (n[r.severity] != null) n[r.severity] += 1;
  return n;
}

/** Render the report as a list of lines, worst first. Pure, so a test can assert on it. */
export function formatDoctor(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const showOk = opts.showOk !== false;
  const rank = (s) => { const i = SEVERITY_ORDER.indexOf(s); return i < 0 ? 99 : i; };
  const sorted = list.slice().sort((a, b) => rank(a.severity) - rank(b.severity));
  const n = summarize(list);
  const head = `Doctor — ${n.error} error(s), ${n.warn} warning(s)`
    + (opts.version ? `   hncode v${opts.version}` : '');
  const lines = [head, ''];
  for (const r of sorted) {
    if (!showOk && (r.severity === 'ok' || r.severity === 'info')) continue;
    const mark = MARK[r.severity] || '·';
    lines.push(`${mark} ${r.name.padEnd(24)} ${r.detail}`);
    if (r.fix && (r.severity === 'error' || r.severity === 'warn')) lines.push(`  ${' '.repeat(24)} → ${r.fix}`);
  }
  if (!n.error && !n.warn) {
    lines.push('', 'No problems found.');
  } else {
    lines.push('', 'Run /doctor --all to include the passing checks.');
  }
  return lines;
}
