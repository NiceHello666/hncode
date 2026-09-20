// hncode entry: CLI arg parsing, subcommands, headless -p mode, and TUI dispatch.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveConfig, effectiveSnapshot, saveConfig, resolveModelArg, readPersonalPrompt } from './config.js';
import * as sess from './session.js';
import { Agent, SYSTEM_PROMPT } from './agent.js';
import { llmTools } from './tools/index.js';
import { setToolsList } from './llm.js';
import { localVersion } from './version.js';
import { EXIT, FORMATS, isValidFormat, buildResult, exitCodeFor, resultLine, createRunTracker, trackEvent, finalReply } from './ci.js';

// The version shown by `hncode -V` and the help banner. Read from package.json
// (via version.js) so it can never drift from the published version again.
export const VERSION = localVersion();

const HELP = `hncode ${VERSION} — a Kimi Code-style coding agent.

Usage: hncode [options] [command]

Cyan-blue TUI for long agent sessions. OpenAI + Anthropic streaming,
MCP-style toolbelt (Edit, Read, Write, Bash, Glob, Grep, TodoList, ...).

Options:
  -V, --version                 output the version number
  -S, --session [id]            Resume a session (with id) or pick interactively.
  -c, --continue                Continue the previous session for this directory.
  -y, --yolo                    Routine edits/commands run; risky actions still ask.
  --auto                        Never ask; everything runs automatically.
  -m, --model <model>           Model alias to use for this invocation.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the reply.
  --output-format <format>      Prompt mode output: text (default), json, or stream-json.
                                json prints one result object; stream-json streams events then a result.
                                Exit code reflects the outcome: 0 ok, 1 failure, 2 config, 3 no answer, 4 interrupted.
  --control                     Expose a local control socket (prompt/status/interrupt) while the TUI runs.
  --control <path>              Same, at an explicit socket path.
  --plan                        Start in plan mode (research only, no writes).
  --add-dir <dir>               Add an additional workspace directory. Repeatable.
  -h, --help                    Show help.

Commands:
  session list                  List sessions, most recent first.
  provider list                 Show configured providers.
  doctor config [path]          Validate a config.toml (default: merged config).
  init                          Create ~/.hncode/config.toml with defaults.
  export [id]                   Export a session to ~/.hncode/export/<id>.json.
  control status                Ask a running session (started with --control) for its status.
  control prompt <text>         Queue a prompt on a running session.
  control interrupt             Interrupt the running turn.
  hooks list                    Show configured shell hooks.
  skills list                   List installed skills.
  mcp list                      Show configured MCP servers.
`;

function printHelp() { process.stdout.write(HELP); }

// ---- minimal argv parsing ----
export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else { key = a.slice(2); val = null; }
      if (key === 'resume') key = 'session'; // `--resume <id>` is an alias for `--session <id>`
      if (['session', 'control'].includes(key) && val === null) { const nx = argv[i + 1]; out[key] = nx !== undefined && !nx.startsWith('-') ? (i++, nx) : true; }
else if (key === 'model' || key === 'prompt' || key === 'output-format' || key === 'add-dir') {
        if (val === null) {
          const nx = argv[i + 1];
          // Only consume the next token if it is a real value, not another flag
          // or the end of argv. Previously `--model -y` and a trailing `--model`
          // swallowed or mangled the value, breaking the real flag.
          val = (nx !== undefined && !nx.startsWith('-')) ? argv[++i] : undefined;
        }
out[key] = (key === 'add-dir' && val !== undefined)
        ? (out[key] || []).concat([val])
        : val;
      } else if (val !== null) { out[key] = val === 'true' ? true : val === 'false' ? false : val; }
      else out[key] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      const short = { V: 'version', S: 'session', c: 'continue', y: 'yolo', auto: 'auto', m: 'model', p: 'prompt', h: 'help' };
if (key === 'S' || key === 'm' || key === 'p') {
        const nx = argv[i + 1];
        // Take the next token as the value only if it exists and is not another
        // flag. Previously `-S -y` swallowed `-y` as the session id and a bare
        // trailing `-m` became undefined; both silently broke the real flag.
        const hasVal = nx !== undefined && !nx.startsWith('-');
        if (hasVal) { out[short[key]] = argv[i + 1]; i++; }
        else if (key === 'S') { out.session = true; }  // "-S" with no id => pick interactively
        // '-m' / '-p' with no usable value: leave unset (same as a missing arg).
      } else out[short[key]] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

// ---- subcommands ----
function cmdSessionList(args) {
  const items = sess.listSessions();
  if (items.length === 0) { console.log('No sessions yet.'); return 0; }
  for (const s of items.slice(0, 30)) {
    const when = new Date(s.updatedAt || 0).toISOString().slice(0, 19).replace('T', ' ');
    const title = (s.title || '(untitled)').replace(/\n/g, ' ');
    console.log(`${s.id.padEnd(20)} ${when}  ${title}`);
  }
  return 0;
}
function cmdProviderList() {
  const cfg = resolveConfig();
  const provs = (cfg.raw.providers) || {};
  const models = (cfg.raw.models) || {};
  const counts = {};
  for (const m of Object.values(models)) if (m.provider) counts[m.provider] = (counts[m.provider] || 0) + 1;
  const names = Object.keys(provs).length ? Object.keys(provs) : [cfg.provider];
  for (const name of names) {
    const p = provs[name];
    const url = p ? (p.base_url || p.baseUrl || '') : cfg.baseUrl;
    console.log(`${name}  (${counts[name] || 0} models)  ${url}`);
  }
  console.log(`active: ${cfg.provider} / ${cfg.model}`);
  return 0;
}
async function cmdDoctorConfig(p) {
  let file = p;
  if (!file) {
    const home = os.homedir();
    for (const f of [process.env.HNCODE_CONFIG, path.join(home, '.hncode', 'config.toml')]) {
      if (f && fs.existsSync(f)) { file = f; break; }
    }
    file = file || path.join(home, '.hncode', 'config.toml');
    console.log(`No path given; validated: ${file}`);
  }
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const { parse } = await import('./toml.js');
    parse(txt);
    console.log(`OK: ${file} is valid TOML.`);
    return 0;
  } catch (e) {
    console.error(`INVALID: ${file}: ${e.message}`);
    return 1;
  }
}

function cmdInit() {
  const cfg = resolveConfig();
  const target = path.join(os.homedir(), '.hncode', 'config.toml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines = [
    `# hncode configuration`,
    `default_model = "${cfg.raw.default_model || 'gpt-4o-mini'}"`,
    ``,
    `# Or set these directly:`,
    `# base_url = "${cfg.baseUrl}"`,
    `# protocol = "openai"   # or "anthropic"`,
    `# max_context_size = 128000`,
    `# max_output_size = 4096`,
  ];
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
    console.log(`Created ${target}`);
  } else {
    console.log(`Already exists: ${target}`);
  }
  return 0;
}

function cmdExport(id) {
  const s = id ? sess.loadSession(id) : sess.latestSession(process.cwd());
  if (!s) { console.error('No session found.'); return 1; }
  const exportDir = path.join(os.homedir(), '.hncode', 'export');
  fs.mkdirSync(exportDir, { recursive: true });
  const out = path.join(exportDir, `${s.id}.json`);
  fs.writeFileSync(out, JSON.stringify(s, null, 2), 'utf8');
  console.log(`Exported ${s.id} -> ${out}`);
  return 0;
}

const SUBCOMMANDS = {
  'session': { 'list': cmdSessionList },
  'provider': { 'list': cmdProviderList },
  'doctor': { 'config': cmdDoctorConfig },
  'init': cmdInit,
  'export': cmdExport,
  'control': {
    // Subcommands pass only positional[2] to their handler, so bind the op.
    'status': (rest) => cmdControl('status', rest),
    'prompt': (rest) => cmdControl('prompt', rest),
    'interrupt': (rest) => cmdControl('interrupt', rest),
  },
};

// ---- control (talk to a running --control session) --------------------------
// `hncode control status|prompt|interrupt` — the client half of the control
// socket the TUI opens with --control. Prints the JSON reply so a script can
// parse it; exits non-zero when the running session could not be reached.
async function cmdControl(sub, arg) {
  const { sendControl } = await import('./ci.js');
  const op = sub || 'status';
  if (!['status', 'prompt', 'interrupt'].includes(op)) {
    console.error(`unknown control op: ${op}. Use status | prompt <text> | interrupt.`);
    return 1;
  }
  const req = { op };
  if (op === 'prompt') {
    const text = String(arg || '').trim();
    if (!text) { console.error('control prompt requires text.'); return 1; }
    req.text = text;
  }
  const res = await sendControl(req, { path: process.env.HNCODE_CONTROL_SOCKET || undefined });
  console.log(JSON.stringify(res));
  return res && res.ok ? 0 : 1;
}

// ---- headless prompt mode ----
async function runPrompt({ cfg, prompt, format, session, modelArg }) {
  cfg = resolveModelArg(cfg, modelArg);
  if (!cfg.apiKey) {
    console.error('hncode: no api_key configured. Set HNCODE_API_KEY or configure a provider first. Run `hncode doctor config` to check.');
    return EXIT.CONFIG;
  }
  const messages = [];
  if (session && session.messages) for (const m of session.messages.slice(-30)) messages.push(m);
  // Same layering as the TUI: built-in prompt first, then the user's own
  // system_prompt override if any, then the /personal notes, then calm mode.
  let sysText = (cfg.systemPrompt && String(cfg.systemPrompt).trim()) || SYSTEM_PROMPT;
  const personal = readPersonalPrompt(cfg.workspace);
  if (personal) sysText += '\n\n' + personal;
  messages.push({ role: 'system', content: sysText });
  const saved = session || { id: sess.newId(), title: prompt.slice(0, 60), workspace: path.resolve(process.cwd()), model: cfg.model, createdAt: Date.now(), messages: [] };
  const tracker = createRunTracker();
  const startedAt = Date.now();
  let fatal = null;
  const agent = new Agent({
    cfg,
    messages,
    // Uncapped: run until the model finishes (see agent.js).
    onEvent: (e) => {
      trackEvent(tracker, e);
      if (e.type === 'error') fatal = (e.error && e.error.message) || String(e.error);
      if (format === 'stream-json' || format === 'json') {
        // `json` mode keeps stdout clean for the final envelope, so events go to
        // stderr there. `stream-json` is the streaming contract: one event/line.
        if (format === 'stream-json') {
          if (e.type === 'context') return; // TUI-only gauge; not part of the stream
          const line = { type: e.type };
          if (e.text) line.text = e.text;
          if (e.name) line.name = e.name;
          if (e.id) line.id = e.id;
          if (e.content != null) line.content = e.content;
          process.stdout.write(JSON.stringify(line) + '\n');
        }
      } else if (e.type === 'data') {
        process.stdout.write(e.text);
      }
    },
  });
  saved.messages = messages;
  await agent.run();
  sess.saveSession(saved);

  const reply = finalReply(messages, tracker.text);
  const result = buildResult({
    reply,
    toolCalls: tracker.toolCalls,
    files: tracker.files,
    error: fatal || (tracker.errors.length ? tracker.errors[tracker.errors.length - 1] : null),
    stopped: !!agent.stopRequested,
    durationMs: Date.now() - startedAt,
    model: cfg.model,
    sessionId: saved.id,
  });

  if (format === 'json') {
    // Exactly one JSON object on stdout, so `| jq` / `tail -1` works.
    process.stdout.write(resultLine(result) + '\n');
  } else if (format === 'stream-json') {
    // A terminating event tells a streaming reader the run is over and carries
    // the same envelope, so both formats end with a `result` record.
    process.stdout.write(resultLine(result) + '\n');
  } else {
    process.stdout.write('\n');
  }
  return exitCodeFor(result, false);
}

// ---- TUI dispatch ----
async function startTui(opts) {
  const { startTUI } = await import('./tui.js');
  await startTUI(opts);
}

function loadOrCreateSession(opts, cfg) {
  let session = null;
  // NOTE: these keys must match what parseArgs actually produces — `--continue`
  // yields `args.continue` (not `args.cont`), and `--resume <id>` is normalised
  // to `args.session`. Reading the wrong key silently fell through to "create a
  // new session", which is why --continue looked like it started a fresh one.
  const sessionArg = opts.session;
  const wantsSession = typeof sessionArg === 'string' || sessionArg === true || !!opts.sessionId;
  const wantsContinue = !!(opts.continue || opts.cont);
  if (wantsSession) {
    const id = typeof sessionArg === 'string' ? sessionArg : opts.sessionId;
    if (id) session = sess.loadSession(id) || null;
  } else if (wantsContinue) {
    // --continue: get the most recent session for THIS directory that has messages.
    // Empty shells are created on every launch, so we skip them to find real conversations.
    session = sess.latestSession(process.cwd(), undefined, { skipEmpty: true });
  }
  if (!session) {
    session = { id: sess.newId(), title: '', workspace: path.resolve(process.cwd()), model: cfg.model, createdAt: Date.now(), messages: [] };
  } else {
    // CRITICAL: Update session model to match current config!
    // This prevents using stale model ID from old sessions.
    session.model = cfg.model;
  }
  return session;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }
  if (args.version) { console.log(VERSION); return 0; }

  // subcommands
  const [cmd, sub] = args.positional;
  if (cmd) {
    if (cmd === 'doctor' && !sub) { printHelp(); return 0; }
    const handler = SUBCOMMANDS[cmd];
    if (handler) {
      if (sub !== undefined) {
        const h2 = handler[sub];
        if (h2) return await h2(args.positional[2]);
        printHelp(); return 1;
      }
      if (typeof handler === 'function') return await handler(args.positional[1]);
      printHelp(); return 0;
    }
    console.error(`unknown command: ${cmd}`);
    return 1;
  }

  const baseCfg = resolveConfig();
  const cfg = resolveModelArg(baseCfg, args.model);

  // Load plugins (if enabled) before anything else so their tools and commands
  // are available in both headless and TUI modes.
  if (cfg.pluginDir) {
    const { loadPlugins } = await import('./plugin.js');
    await loadPlugins(cfg.pluginDir);
  }

  // Connect configured MCP servers and register their tools.
  //
  // This is a FUNCTION rather than an inline block because the two modes want
  // different timing:
  //   * headless (`-p`) MUST wait — the prompt runs immediately and its model
  //     request has to see the MCP tools in the tool list.
  //   * the TUI must NOT wait — connecting can take seconds (8s per wedged
  //     server), and blocking the first paint for that is unacceptable. The TUI
  //     starts this in the background and reports the result as a notice.
  // Failures are reported but never fatal: an unreachable server must not stop
  // the session from starting.
  const connectMcp = async () => {
    if (cfg.mcp === false) return { servers: [], toolCount: 0 };
    try {
      const mcp = await import('./mcp.js');
      const { API } = await import('./plugin.js');
      const mcpCfg = mcp.loadMcpConfig(cfg.workspace);
      if (!Object.keys(mcpCfg.servers).length) return { servers: [], toolCount: 0 };
      const res = await mcp.connectAll(mcpCfg, (spec) => API.registerTool(spec));
      mcp.setLiveConnections(res.servers);
      if (process.env.HNCODE_MCP_VERBOSE === '1') {
        for (const s of res.servers) {
          console.error(s.ok ? `[hncode-mcp] ${s.name}: ${s.toolCount} tool(s)` : `[hncode-mcp] ${s.name}: ${s.error}`);
        }
      }
      return res;
    } catch (e) {
      console.error(`hncode: MCP setup failed: ${e.message}`);
      return { servers: [], toolCount: 0 };
    }
  };

  // headless prompt: MCP must be live BEFORE the request goes out.
  if (args.prompt) {
    const format = args['output-format'];
    if (!isValidFormat(format)) {
      console.error(`hncode: unknown --output-format "${format}". Use one of: ${FORMATS.join(', ')}.`);
      return EXIT.CONFIG;
    }
    await connectMcp();
    let session = null;
    if (args.session) session = typeof args.session === 'string' ? sess.loadSession(args.session) : sess.latestSession(undefined, undefined, { skipEmpty: true });
    else if (args.continue) session = sess.latestSession(undefined, undefined, { skipEmpty: true });
    return runPrompt({ cfg, prompt: args.prompt, format, session, modelArg: args.model });
  }

  if (!process.stdout.isTTY) {
    console.error('hncode: interactive mode requires a TTY. Use `hncode -p "prompt"` for non-interactive use.');
    return EXIT.FAILURE;
  }

  const opts = {
    cfg,
    sessionFlag: args.session,
    sessionId: typeof args.session === 'string' ? args.session : null,
    cont: !!args.continue,
    yolo: !!args.yolo,
    auto: !!args.auto,
    plan: !!args.plan,
    addDirs: args['add-dir'] || [],
    // Remote control: expose a local socket so a script can queue a prompt or
    // query status on the running session (see ci.js).
    control: args.control === true ? '' : (typeof args.control === 'string' ? args.control : null),
    // MCP runs in the BACKGROUND once the TUI is up (see startTUI): connecting
    // can take seconds and must not delay the first paint.
    mcpConnect: connectMcp,
    session: loadOrCreateSession(args, cfg),
  };
  await startTui(opts);
  return EXIT.OK;
}

// main() is invoked by bin/hncode (the CLI entry point), which imports this module
// and calls main(process.argv.slice(2)) explicitly.