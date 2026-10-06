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

/** The session directory. A store that cannot be listed is a store whose work is invisible.
 *
 *  Async because it profiles the largest session — see the memory breakdown below. */
async function checkSessions(files, sessionsDir, limit = 4) {
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
  // Sizes of every session, so the memory profile can pick the largest regardless of how
  // large it is. The `big` list below is filtered to the ones worth WARNING about; the
  // profiler wants the largest whatever its size, because "this session holds 0.66 MB of
  // tool arguments" is useful at 4 MB and not only at 500.
  const sizes = [];
  for (const f of names) {
    try { sizes.push({ f, size: fs.statSync(path.join(sessionsDir, f)).size }); } catch { /* raced away */ }
  }
  sizes.sort((a, b) => b.size - a.size);
  const big = sizes.filter((x) => x.size > 8 * 1024 * 1024);

  for (const b of big.slice(0, limit)) {
    const mb = (b.size / 1048576).toFixed(1);
    const sev = b.size > V8_LIMIT * 0.75 ? 'error' : 'warn';
    out.push(check('oversized session', sev, `${mb} MB  ${b.f}`,
      b.size > V8_LIMIT * 0.75
        ? 'Approaching the ~512 MB string limit, past which saving FAILS. Trim the reasoning transcript — see tools/repair-transcripts.mjs.'
        : 'Large; loading and saving this session will be slow.'));
  }

  // WHERE THE BYTES ARE in the biggest session, as opposed to how big the file is.
  //
  // A file size says nothing actionable: the same 2.5 MB can be a conversation or a
  // runaway transcript, and only one of those is worth fixing. The breakdown also explains
  // the file being LARGER than the content it holds — measured on a real session, the
  // serialised JSON was 2.29 MB while text + tool results + tool arguments summed to
  // 1.27 MB, so structure and escaping are as expensive as the text.
  //
  // Skipped below 1 MB: loading and measuring a session to learn it is small is itself
  // work, and the finding would be "nothing to see". Deliberately NOT gated on `big` —
  // that list only holds sessions big enough to warn about, and the breakdown is most
  // useful on an ordinary one: it is where "half your memory is tool arguments" shows up.
  if (sizes.length && sizes[0].size > 1024 * 1024) {
    const top = sizes[0];
    try {
      const { loadSession } = await import('./session.js');
      const { profileMemory, memoryHeadline } = await import('./memory-profile.js');
      const loaded = loadSession(top.f.replace(/\.json$/, ''));
      if (loaded) {
        const profile = profileMemory({ session: loaded });
        out.push(check('largest session memory', 'info',
          `${memoryHeadline(profile)}  (${top.f})`,
          'Text, tool results and tool ARGUMENTS are counted separately; run /memory-profile for the full breakdown.'));
      }
    } catch (e) {
      out.push(check('largest session memory', 'warn', `could not profile ${top.f}: ${e.message}`,
        'The file was readable by size but would not parse.'));
    }
  }

  // Leftover temp files from an interrupted save.

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

/**
 * Free space where the sessions live.
 *
 * A store that fills up is a store that loses work, and the failure is not obviously about
 * disk: the write fails, the turn is lost, and the error text says ENOENT or EACCES. The
 * session directory held 608 MB on this machine at one point, which is the shape that walks
 * a disk to full without anyone noticing.
 *
 * `statfs` is used where the platform has it (Node 18.15+). Where it does not, the check is
 * SKIPPED rather than guessed — a wrong number here is worse than no number.
 */
function checkDisk(dir) {
  if (typeof fs.statfsSync !== 'function') {
    return [check('disk space', 'info', 'not measurable on this Node/platform', '')];
  }
  try {
    const st = fs.statfsSync(dir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const totalBytes = Number(st.blocks) * Number(st.bsize);
    const freeGb = freeBytes / 1024 ** 3;
    const totalGb = totalBytes / 1024 ** 3;
    // Thresholds are deliberately far apart: below 1 GB is an error (a long session can
    // write hundreds of megabytes), below 5 GB is a warning.
    const sev = freeGb < 1 ? 'error' : freeGb < 5 ? 'warn' : 'ok';
    return [check('disk space', sev, `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(0)} GB`,
      sev === 'ok' ? ''
        : 'Saving a session writes the whole transcript, which has reached hundreds of MB. Free space, or point HNCODE_SESSIONS_DIR at another volume.')];
  } catch (e) {
    return [check('disk space', 'info', `could not measure: ${e.message}`, '')];
  }
}

/**
 * The workspace's git state.
 *
 * Two things here actually break work: a missing `user.name`/`user.email` makes every
 * commit fail, and an unfinished merge or rebase means the tree is not what the agent
 * thinks it is. Both are cheap to check and neither surfaced anywhere before.
 */
function checkGit(workspace, cp) {
  if (!workspace) return [];
  if (!cp) return [check('git', 'info', 'the git module is unavailable', '')];
  const run = (args) => {
    try {
      const r = cp.spawnSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: 5000, windowsHide: true });
      return r.status === 0 ? String(r.stdout || '').trim() : null;
    } catch { return null; }
  };
  // A workspace that is not a repo is normal, and says nothing about health.
  const top = run(['rev-parse', '--show-toplevel']);
  if (!top) return [check('git', 'info', 'not a git repository', '')];

  const out = [];
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  out.push(check('git', 'ok', `${branch || '(detached)'} in ${top}`));

  for (const key of ['user.name', 'user.email']) {
    if (!run(['config', '--get', key])) {
      out.push(check(`git ${key}`, 'warn', 'not set',
        `Every commit fails without it. Run: git config --global ${key} "…"`));
    }
  }
  // A half-finished operation changes what the agent is looking at.
  const gitDir = run(['rev-parse', '--git-dir']);
  if (gitDir) {
    const abs = path.isAbsolute(gitDir) ? gitDir : path.join(workspace, gitDir);
    for (const [file, what] of [['MERGE_HEAD', 'a merge'], ['REBASE_HEAD', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick']]) {
      if (fs.existsSync(path.join(abs, file))) {
        out.push(check('git in progress', 'warn', `${what} is unfinished`,
          'The working tree is mid-operation; resolve it before trusting a diff.'));
      }
    }
  }
  return out;
  return out;
}

/**
 * A LIVE end-to-end probe: can this configuration actually complete a turn?
 *
 * This is the check a static report cannot make. Everything above reads files; a key that
 * exists and an endpoint that parses still say nothing about whether a request SUCCEEDS, and
 * the failures that matter — a revoked key, a wrong base URL, a model the account cannot
 * reach, a provider that rejects `reasoning_effort` — are all invisible until a real request
 * is made.
 *
 * It costs one request and a handful of tokens, so it is OPT-IN (`/doctor --probe`) and never
 * part of a plain run. Modelled on jcode's provider-doctor, whose AUTH_CREDENTIAL_LOADED,
 * NON_STREAMING_CHAT_COMPLETION and STREAMING_CHAT_COMPLETION checks do the same thing.
 *
 * The steps are reported as they happen, so a failure names the step that broke rather than
 * only saying the whole thing did not work.
 */
async function probeProvider(cfg, input = {}) {
  const out = [];
  const send = input.probeRequest;      // injected by a test; see the note below
  if (!cfg.provider || !cfg.model) {
    return [check('probe', 'info', 'skipped: no provider/model configured', '')];
  }
  if (!cfg.endpoint) {
    return [check('probe', 'info', 'skipped: no endpoint', '')];
  }
  // A test supplies its own transport. Without one, the real LLM class is used — lazily, so
  // a plain /doctor never pays to import the provider stack.
  const doRequest = send || (async () => {
    const { LLM } = await import('./llm.js');
    const llm = new LLM(cfg);
    let text = '';
    let sawError = null;
    let usage = null;
    await llm.request(
      [{ role: 'user', content: 'Reply with the single word: ok' }],
      (e) => {
        if (e.type === 'data') text += e.text;
        else if (e.type === 'error') sawError = e.error;
        else if (e.type === 'usage') usage = e.usage;
      },
      // One turn, no tools, no streaming: the smallest request that proves the pipeline.
      { noTools: true, streaming: false },
    );
    return { text, error: sawError, usage };
  });

  const t0 = Date.now();
  let res;
  try {
    res = await doRequest();
  } catch (e) {
    return [check('probe', 'error', `request threw: ${(e && e.message) || e}`,
      'The configuration parses but a request does not complete. Check the key, the endpoint and the network.')];
  }
  const ms = Date.now() - t0;

  if (res && res.error) {
    return [check('probe', 'error', `provider error: ${String(res.error).slice(0, 160)}`,
      'The key may be revoked, the model unavailable, or the provider rejecting a field in the request.')];
  }
  const text = String((res && res.text) || '').trim();
  if (!text) {
    // A 200 with no text is the failure mode that looks like success: a reasoning model can
    // spend its whole budget on `reasoning_content` and return an empty `content`.
    return [check('probe', 'error', `empty reply in ${ms} ms`,
      'The request completed but returned no text. If this model always reasons, it may be spending the whole output budget on reasoning.')];
  }
  // `usage` comes off the RESULT, not out of the closure that built it — reading the local
  // inside `doRequest` from here was a ReferenceError on every successful probe.
  const usage = res && res.usage;
  out.push(check('probe', 'ok', `replied "${text.slice(0, 20)}" in ${ms} ms`,
    usage ? `provider reported ${JSON.stringify(usage)}` : ''));
  return out;
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
  // Named distinctly from the TERM check: both used to be called "TERM", so a report with a
  // small terminal showed the same name twice and read as a duplicated finding.
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
export async function runDoctor(input = {}) {
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
    ...(await checkSessions(files, sessionsDir)),
    ...checkErrorLog(files),
    ...checkMcp(input.mcpServers, input.mcpConnections),
    ...checkHooks(files, workspace),
    ...checkExtensions(files),
    ...checkDisk(sessionsDir),
    ...checkGit(workspace, input.childProcess),
...checkTerminal(env, input.dims),
  ];
  // The live probe is OPT-IN: it spends a request and a few tokens, so it must never run
  // as part of a plain /doctor.
  if (input.probe) results.push(...await probeProvider(cfg, input));
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
