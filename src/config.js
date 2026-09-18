// hncode configuration — fully independent of kimi-code-cli.
// Loads ONLY ~/.hncode/config.toml (plus HNCODE_* env overrides). It does NOT
// read ~/.kimi-code/config.toml; hncode and kimi-code are separate products.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parse } from './toml.js';
import { pluginConfigDefaults } from './plugin.js';

const home = os.homedir();

export const DEFAULTS = {
  model: '',
  provider: '',
  baseUrl: '',
  apiKey: '',
  protocol: 'openai',
  // Fallback context window when neither config nor /v1/models provides one.
  maxContextTokens: 512000,
  maxOutputTokens: 4096,
  reasoning: false,
  workspace: process.cwd(),
  allowExternal: false,
};

// Provider/model catalog upstream — the same source kimi-code uses. Fetched by
// `/provider` → Add so the user can pick a known provider (with its base_url)
// or type a custom one. Shape: { [providerId]: { id, name, api, doc, env,
// models: { [modelId]: { id, name, limit: { context, output }, reasoning, … } } } }.
export const MODELS_DEV_URL = 'https://models.dev/api.json';
let catalogCache = null;
let catalogInFlight = null;
const CATALOG_TTL_MS = 10 * 60 * 1000;
let catalogFetchedAt = 0;

// Fetch (and memoize) the models.dev catalog. Returns null on failure.
export async function fetchCatalog() {
  const now = Date.now();
  if (catalogCache && now - catalogFetchedAt < CATALOG_TTL_MS) return catalogCache;
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(MODELS_DEV_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = await res.json();
      if (json && typeof json === 'object') {
        catalogCache = json;
        catalogFetchedAt = Date.now();
        return json;
      }
      return null;
    } catch { return null; }
    finally { catalogInFlight = null; }
  })();
  return catalogInFlight;
}

export function hncodeConfigFile() {
  return process.env.HNCODE_CONFIG || path.join(home, '.hncode', 'config.toml');
}

// ---- personal preferences (/personal) ----
// Free-form markdown the user wants applied on EVERY turn ("reply in Chinese",
// "I use pnpm", "never add a trailing newline", …). Two scopes are merged, the
// project one LAST so it can refine the global one:
//   * global  — ~/.hncode/PERSONAL.md      (every workspace)
//   * project — <workspace>/.hncode/PERSONAL.md  (this workspace only)
// Both are OPTIONAL; a missing/empty file injects nothing. The files are read
// fresh on each turn, so an edit through /personal takes effect immediately.
export function personalPromptFile(scope, workspace) {
  if (scope === 'global') return path.join(home, '.hncode', 'PERSONAL.md');
  return path.join(workspace || process.cwd(), '.hncode', 'PERSONAL.md');
}

// Header placed before the injected preferences, so the model knows where the
// text came from and how much authority it has.
export const PERSONAL_PROMPT_HEADER =
  'USER PERSONAL PREFERENCES (persistent notes from the user; follow them unless\n'
  + 'the current request says otherwise):';

// Raw file content for one scope (no header) — used by /personal's editor.
export function readPersonalPromptRaw(scope, workspace) {
  try { return fs.readFileSync(personalPromptFile(scope, workspace), 'utf8'); } catch { return ''; }
}

// Save one scope. Empty text REMOVES the file (so nothing is injected).
export function writePersonalPrompt(scope, workspace, text) {
  const file = personalPromptFile(scope, workspace);
  const value = String(text == null ? '' : text);
  if (!value.trim()) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.replace(/\s+$/, '') + '\n', 'utf8');
  return file;
}

export function readPersonalPrompt(workspace) {
  const parts = [];
  for (const scope of ['global', 'project']) {
    try {
      const t = fs.readFileSync(personalPromptFile(scope, workspace), 'utf8').trim();
      if (t) parts.push(t);
    } catch { /* no file for this scope: nothing to inject */ }
  }
  if (!parts.length) return '';
  return PERSONAL_PROMPT_HEADER + '\n' + parts.join('\n\n');
}

// ---- AGENTS.md --------------------------------------------------------------
// Project instruction files, mirroring codex's AGENTS.md spec
// (codex-rs/core/gpt_5_2_prompt.md, "AGENTS.md spec"):
//   * a file's scope is the whole directory tree rooted where it sits;
//   * for every file you touch you must obey the AGENTS.md whose scope covers it;
//   * more-deeply-nested files take precedence on conflict;
//   * direct system/user instructions outrank all of them.
// Files are therefore collected from the workspace root DOWN to the working
// directory and injected outermost-first, so the deepest one is read last and
// naturally wins — the same precedence, without a merge step.
//
// This closes a real gap: /init WRITES an AGENTS.md and the prompt advertises it
// as "smarter agent context", but nothing ever read it back.
const AGENTS_MAX_BYTES = 32 * 1024;
const AGENTS_FILENAMES = ['AGENTS.md', 'agents.md', 'AGENTS.override.md'];

export const AGENTS_PROMPT_HEADER =
  'PROJECT INSTRUCTIONS (AGENTS.md). The scope of each file is the directory it sits in,\n'
  + 'so a deeper file is more specific and takes precedence over a shallower one. They apply\n'
  + 'to every file you touch under that directory. The current request and the user\'s direct\n'
  + 'instructions still outrank anything here.'

// Every applicable AGENTS.md, outermost first. `dir` keeps the scope visible.
export function agentsFilesFor(cwd, workspaceRoot) {
  const start = path.resolve(cwd || process.cwd());
  const root = path.resolve(workspaceRoot || start);
  const dirs = [];
  let dir = start;
  for (;;) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    // Stop at the filesystem root, or once we have walked past the workspace.
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  dirs.reverse();                     // outermost first
  const found = [];
  for (const d of dirs) {
    for (const name of AGENTS_FILENAMES) {
      const p = path.join(d, name);
      try {
        if (!fs.statSync(p).isFile()) continue;
        found.push({ path: p, dir: d });
        break;                        // one instruction file per directory
      } catch { /* not present here */ }
    }
  }
  return found;
}

// The block injected into the system prompt, or '' when the project has none.
export function readAgentsMd(cwd, workspaceRoot) {
  const files = agentsFilesFor(cwd, workspaceRoot);
  if (!files.length) return '';
  const parts = [];
  for (const f of files) {
    try {
      let text = fs.readFileSync(f.path, 'utf8').trim();
      if (!text) continue;
      if (Buffer.byteLength(text, 'utf8') > AGENTS_MAX_BYTES) {
        text = Buffer.from(text, 'utf8').subarray(0, AGENTS_MAX_BYTES).toString('utf8') + '\n[truncated]';
      }
      parts.push(`--- ${f.path} ---\n${text}`);
    } catch { /* unreadable: skip rather than fail the turn */ }
  }
  if (!parts.length) return '';
  return AGENTS_PROMPT_HEADER + '\n\n' + parts.join('\n\n');
}

function loadBaseToml() {
  // Only hncode's own config file participates.
  const f = hncodeConfigFile();
  let base = {};
  try {
    if (fs.statSync(f).isFile()) base = parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`hncode: failed to parse ${f}: ${e.message}`);
  }
  return base;
}

export function resolveConfig() {
  const root = loadBaseToml() || {};
  // Merge plugin-provided defaults UNDER the user's config: an explicitly set
  // user value always wins.
  for (const [k, v] of Object.entries(pluginConfigDefaults || {})) {
    if (!(k in root)) root[k] = v;
  }

  const providers = root.providers || {};
  const models = root.models || {};
  let model = process.env.HNCODE_MODEL || root.model || root.default_model || DEFAULTS.model;
  // No hard-coded provider: fall back to the first one the user configured.
  let providerName = process.env.HNCODE_PROVIDER || root.provider || Object.keys(providers)[0] || DEFAULTS.provider;
  // If no model was named but models exist, adopt the first one under the
  // active provider (so the status line always has a model to show).
  if (!model) {
    const first = Object.keys(models).find((k) => (models[k].provider || '') === providerName)
      || Object.keys(models)[0];
    if (first) model = first;
  }

  let baseUrl = process.env.HNCODE_BASE_URL || root.base_url || root.baseUrl || '';
  let apiKey = process.env.HNCODE_API_KEY || root.api_key || root.apiKey || '';
  let protocol = process.env.HNCODE_PROTOCOL || root.protocol || '';
  // The model actually sent to the API: the [models.*] entry's `model` field
  // when the key names a pool entry, otherwise the literal name.
  const modelEntry = models[model] || {};
  let innerModel = bareModelId(modelEntry.provider || providerName, model, modelEntry);
  
  // A [models.*] entry names its own provider; honour it.
  if (modelEntry.provider) providerName = modelEntry.provider;

  // Optional provider sub-tables: [providers.NAME] base_url / api_key / protocol.
  const prov = providers[providerName];
  if (prov) {
    // Provider sub-table supplements env/root; an explicit HNCODE_* env var
    // always wins, otherwise the provider table fills in the gaps it declares.
    baseUrl = process.env.HNCODE_BASE_URL || (prov.base_url || prov.baseUrl) || baseUrl;
    apiKey = process.env.HNCODE_API_KEY || (prov.api_key || prov.apiKey) || apiKey;
    protocol = process.env.HNCODE_PROTOCOL || (prov.protocol) || protocol;
    innerModel = prov.model || innerModel;
  }
  protocol = protocol || DEFAULTS.protocol;

  // The base URL is used EXACTLY as configured — we only append the API path.
  // (No `/v1` is injected: if the user's base ends in /v1, the result is
  // `<base>/chat/completions`; if it doesn't, it's `<base>/chat/completions` too.)
const b = baseUrl.replace(/\/+$/, '');
  // An empty base URL produces a relative endpoint like "/chat/completions",
  // which fetch() rejects with a URL-scheme error the model can't decode. Leave
  // the endpoint empty instead so the caller can show "not set".
  const endpoint = !b ? '' : (protocol === 'anthropic' ? `${b}/messages` : `${b}/chat/completions`);

  // Context window: an explicit env/root override wins, then the model's own
  // `contextLength` (discovered from the provider's /v1/models), then the
  // default. This is what stops every model from being pinned to 128k.
  const overrideContext = process.env.HNCODE_MAX_CONTEXT || root.max_context_size || root.max_context_tokens;
  const modelContext = Number(modelEntry.contextLength || modelEntry.context_length || modelEntry.max_context_size || 0);
  const maxContext = Number(overrideContext || modelContext || DEFAULTS.maxContextTokens);
  const maxOutput = Number(process.env.HNCODE_MAX_OUTPUT || root.max_output_size || DEFAULTS.maxOutputTokens);
  const reasoning = process.env.HNCODE_REASONING ? /^(1|true|yes)$/i.test(process.env.HNCODE_REASONING) : !!root.reasoning;
  const allowExternal = process.env.HNCODE_ALLOW_EXTERNAL === '1' || !!root.tool_allow_external_paths;

  return {
    model, provider: providerName, innerModel,
    baseUrl: b, endpoint, apiKey, protocol,
    maxContextTokens: maxContext, maxOutputTokens: maxOutput, reasoning,
    workspace: process.env.HNCODE_WORKSPACE || root.workspace || DEFAULTS.workspace,
    allowExternal,
    // A user-supplied system prompt (set via /set-system-prompt). Empty means
    // "use the built-in SYSTEM_PROMPT". Read from config.toml so it persists
    // across restarts.
    systemPrompt: process.env.HNCODE_SYSTEM_PROMPT || root.system_prompt || '',
    // CALM MODE (/calm-mode): persisted boolean. When true an instruction is
    // appended to the system prompt to suppress narration.
    calmMode: process.env.HNCODE_CALM_MODE
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_CALM_MODE)
      // Backwards-compat: read legacy cool_mode key if calm_mode is not set.
      : (root.calm_mode === true || root.calm_mode === 'true'
         || root.cool_mode === true || root.cool_mode === 'true'),
    // SUBAGENT MODEL (/swarm-sub-agent): the model each subagent runs on. Empty
    // (the default) means "follow this session's model", which is what the Agent
    // and AgentSwarm tools fall back to. Set from config.toml so it persists.
    subagentModel: process.env.HNCODE_SUBAGENT_MODEL || root.subagent_model || '',
    // Plugin directory (default: ~/.hncode/plugins). Set to "" or "false" to
    // disable plugin loading entirely.
    pluginDir: process.env.HNCODE_PLUGINS || root.plugins_dir || '',
    // AUTO-UPDATE (/auto-update): when true, hncode checks npm for a newer
    // version at startup and then every 30 minutes, installing in the background
    // without interrupting the session.
    autoUpdate: process.env.HNCODE_AUTO_UPDATE
      ? /^(1|true|yes|on)$/i.test(process.env.HNCODE_AUTO_UPDATE)
      : (root.auto_update === true || root.auto_update === 'true'),
    raw: root,
  };
}

export function saveConfig(overlay) {
  const dir = hncodeConfigFile();
  const entries = Object.entries(overlay || {});
  if (entries.length === 0) return dir;
  // Render the overlay to TOML lines, preserving key order.
  let out = '';
  for (const [k, v] of entries) out += toTomlLine(k, v) + '\n';
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // Check if file exists and has content
  try {
    if (fs.statSync(dir).isFile()) {
      const existing = fs.readFileSync(dir, 'utf8');
      if (existing.trim().length > 0) {
        // Append to existing config instead of overwriting — but only for keys
        // that are NOT already present as top-level lines, so two saveConfig
        // calls for the same key never produce duplicate keys. Reuse the same
        // "top-level before any [table] header" rule as setConfigString.
        const keys = new Set(entries.map(([k]) => k));
        const lines = existing.split(/\r?\n/);
        const seen = new Set();       // top-level keys already in the file
        let inTable = false;
        for (const ln of lines) {
          if (/^\s*\[/.test(ln)) inTable = true;
          if (!inTable) {
            const km = /^\s*([A-Za-z0-9_]+)\s*=\s*/.exec(ln);
            if (km) seen.add(km[1]);
          }
        }
        // Nothing to add: every overlay key is already present top-level.
        let add = '';
        for (const [k, v] of entries) {
          if (!seen.has(k)) add += toTomlLine(k, v) + '\n';
        }
        if (add) {
          const sep = existing.endsWith('\n') ? '' : '\n';
          fs.writeFileSync(dir, existing + sep + '\n' + add.trimEnd() + '\n', 'utf8');
        }
        return dir;
      }
    }
  } catch {}

  // New file or empty file
  fs.writeFileSync(dir, out, 'utf8');
  return dir;
}

// Persist a top-level string key in config.toml, replacing any previous value.
// Used by /set-system-prompt. Multi-line values are written as a TOML MULTI-LINE
// BASIC STRING ("""…"""), which keeps newlines readable and means the editor can
// round-trip a prompt that contains them. An empty value REMOVES the key, so the
// built-in prompt takes over again.
export function setConfigString(key, value) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;          // inside a multi-line value we are dropping
  let replaced = false;
  const keyRe = new RegExp('^\\s*' + escapeRe(key) + '\\s*=');
  // Track the index of the first table header — new root-level keys must be
  // inserted BEFORE any [table] section, or TOML assigns them to the last table.
  let firstTableIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (skipping) {
      // A multi-line basic string ends at an unescaped """.
      if (/"""\s*$/.test(ln) || /'''\s*$/.test(ln)) skipping = false;
      continue;
    }
    // Detect a TOML table header line like [foo] or [foo.bar] at column 0.
    if (/^\[/.test(ln) && firstTableIdx < 0) firstTableIdx = out.length;
    if (keyRe.test(ln)) {
      // Drop this key's line, and its body if it opens a multi-line string.
      const rest = ln.slice(ln.indexOf('=') + 1).trim();
      const opensMultiline = /^"""|^'''/.test(rest) && !/^"""[\s\S]*"""\s*$/.test(rest);
      if (opensMultiline) skipping = true;
      if (!replaced && value !== '' && value != null) {
        out.push(...renderTomlString(key, String(value)));
        replaced = true;
      }
      continue;
    }
    out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (!replaced && value !== '' && value != null) {
    // Insert new root-level keys BEFORE the first [table] section so they
    // are parsed as root keys, not assigned to a table.
    const rendered = renderTomlString(key, String(value));
    if (firstTableIdx >= 0) {
      out.splice(firstTableIdx, 0, '', ...rendered);
    } else {
      out.push('');
      out.push(...rendered);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  return file;
}

// Render `key = <value>` as TOML. Uses a multi-line basic string when the value
// contains newlines (readable, and TOML-valid), a plain one otherwise.
function renderTomlString(key, value) {
  if (value.includes('\n')) {
    // Inside """…""" a backslash must be escaped; quotes are fine unless tripled.
    const body = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    return [`${key} = """`, ...body.split('\n'), '"""'];
  }
  return [`${key} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`];
}

// Append (or replace) a [providers.<name>] table in config.toml without
// clobbering unrelated content. Used by /provider's "Add provider…" flow.
export function addProvider(name, { base_url, api_key, protocol } = {}) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const lines = text.split(/\r?\n/);
  // drop any existing [providers.<name>] block (and its key lines) so we replace it
  const out = [];
  let skipping = false;
  for (const ln of lines) {
    const m = /^\s*\[providers\.([^\]]+)\]\s*$/.exec(ln);
    if (m) { skipping = m[1] === name; if (skipping) continue; }
    else if (/^\s*\[/.test(ln)) skipping = false;
    if (!skipping) out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  out.push('');
  out.push(`[providers.${name}]`);
  if (base_url) out.push(`base_url = "${String(base_url).replace(/"/g, '\\"')}"`);
  if (api_key) out.push(`api_key = "${String(api_key).replace(/"/g, '\\"')}"`);
  if (protocol) out.push(`protocol = "${String(protocol).replace(/"/g, '\\"')}"`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  return file;
}

// Remove a [providers.<name>] table (and its key lines) from config.toml, plus
// every [models."<name>/..."] entry that belongs to it — otherwise /model keeps
// listing the deleted provider's models.
export function removeProvider(name) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return file; }
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  // A models key is `[models."provider/modelId"]`; match the provider prefix.
  const modelRe = /^\s*\[models\."([^"]+)"\]\s*$/;
  for (const ln of lines) {
    const pm = /^\s*\[providers\.([^\]]+)\]\s*$/.exec(ln);
    if (pm) { skipping = pm[1] === name; if (skipping) continue; }
    const mm = modelRe.exec(ln);
    if (mm) {
      // The model key starts with `<provider>/`; skip it if it is this provider's.
      const keyProvider = mm[1].split('/')[0];
      skipping = keyProvider === name;
      if (skipping) continue;
    } else if (/^\s*\[/.test(ln)) {
      skipping = false;
    }
    if (!skipping) out.push(ln);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  return file;
}

// ---- models: fetch + per-provider pools ----
// Models are stored per provider as `[models."provider/model"]`, and also
// mirrored into the provider's own pool at `[providers.NAME].models`. The
// display name defaults to the model id (edit config.toml to override).
export function modelKey(provider, modelId) { return `${provider}/${modelId}`; }

// Append a model under a provider (used by the "add model" flow and by the
// auto-fetch after adding a provider). Idempotent per key.
export function addModel(provider, modelId, opts = {}) {
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const key = modelKey(provider, modelId);
  if (new RegExp(`^\\s*\\[models\\."${escapeRe(key)}"\\]`, 'm').test(text)) return file; // already there
  const lines = [`[models."${key}"]`, `provider = "${provider}"`, `model = "${modelId}"`];
  if (opts.display_name) lines.push(`display_name = "${String(opts.display_name).replace(/"/g, '\\"')}"`);
  // Persist the context window discovered from /v1/models so resolveConfig can
  // size the context bar per model (not a global 128k).
  if (opts.contextLength) lines.push(`context_length = ${Number(opts.contextLength)}`);
  if (opts.maxTokens) lines.push(`max_tokens = ${Number(opts.maxTokens)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, '\n' + lines.join('\n') + '\n', 'utf8');
  return file;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Fetch the model list from a provider's API. The base URL is used as given and
// we append only `/models` (so `https://host/v1` → `https://host/v1/models`).
// Anthropic sends x-api-key + anthropic-version. Returns [{id, display}] or [].
export async function fetchModels({ baseUrl, apiKey, protocol }) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) return [];
  const url = `${b}/models`;
  const headers = { 'content-type': 'application/json' };
  if (protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return [];
    const json = await res.json();
    // OpenAI: { data: [{ id }] }  |  Anthropic: { data: [{ id, display_name }] }
    const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
    return arr.map((m) => ({
      id: String(m.id || m.name || ''),
      display: m.display_name || m.displayName || '',
      // Capability hints (servers vary in what they expose).
      contextLength: m.context_length || m.contextLength || undefined,
      maxTokens: m.max_tokens || undefined,          // NEW: per-model token limit from /v1/models
      maxOutputTokens: m.max_output_tokens || m.maxOutputTokens || undefined,
      ownedBy: m.owned_by || undefined,
      // Reasoning support flags, when the server declares them.
      reasoning: m.reasoning === true || m.supports_reasoning === true
        || Array.isArray(m.reasoning_efforts) || Array.isArray(m.supported_efforts)
        || undefined,
      efforts: m.reasoning_efforts || m.supported_efforts || undefined,
    })).filter((m) => m.id);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

// ---- thinking effort capability ----
// The set of selectable efforts for a model. Honours, in order:
//   1. an explicit `efforts` / `reasoning_efforts` list on the model entry
//   2. an explicit `reasoning = false` (model cannot think)
//   3. a name heuristic for models known to expose graded effort
// Returns [] when the model has no thinking control (then /model shows no
// effort row and /effort reports it is unsupported).
// Selectable thinking efforts for a model, mirroring kimi's `segmentsFor`:
//   * a model that declares `efforts` uses exactly those (plus a leading 'off'
//     unless it is `always_thinking`, which cannot be turned off)
//   * `reasoning = false` / `thinking = false` -> no control at all
//   * otherwise fall back to id heuristics: graded OpenAI models get
//     off/low/medium/high, Anthropic and everything else get off/on.
export function effortOptions(cfg, modelKeyName) {
  const models = (cfg.raw && cfg.raw.models) || {};
  const entry = models[modelKeyName || cfg.model] || {};
  const declared = Array.isArray(entry.efforts) ? entry.efforts.filter(Boolean).slice() : [];
  const alwaysOn = entry.always_thinking === true || entry.alwaysThinking === true;
  if (declared.length) return alwaysOn ? declared : (declared[0] === 'off' ? declared : ['off', ...declared]);
  if (alwaysOn) return ['on'];
  if (entry.reasoning === false || entry.thinking === false) return [];
  const id = String(entry.model || modelKeyName || cfg.innerModel || '').toLowerCase();
  // OpenAI-style graded efforts.
  if (/(^|\/)(gpt-5|o1|o3|o4)/.test(id) || /gpt-5|o1-|o3-|o4-/.test(id)) {
    return ['off', 'low', 'medium', 'high'];
  }
  // Anthropic extended thinking is a budget, not a grade — expose on/off only.
  if (cfg.protocol === 'anthropic') return ['off', 'on'];
  // Default: thinking is on/off.
  return ['off', 'on'];
}

// Map a chosen effort to the wire value for the active protocol.
export function effortWire(cfg, effort) {
  if (!effort || effort === 'off') return null;
  if (cfg.protocol === 'anthropic') {
    const budget = { on: 8000, low: 2000, medium: 8000, high: 16000, max: 32000 }[effort] || 8000;
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  // OpenAI-compatible: `reasoning_effort`. "on" is not a valid grade, so map it
  // to "medium"; concrete grades pass through.
  const grade = effort === 'on' ? 'medium' : effort;
  return { reasoning_effort: grade };
}

function toTomlLine(k, v) {
  if (typeof v === 'string') return `${k} = "${v.replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return `${k} = ${v}`;
  if (typeof v === 'number') return `${k} = ${v}`;
  if (Array.isArray(v)) return `${k} = [ ${v.map((x) => `"${x}"`).join(', ')} ]`;
  return `${k} = "${v}"`;
}

// The bare model id sent to the API. The config KEY is authoritative: it is
// always "<provider>/<model-id>", so the id is the key minus the provider
// prefix. The entry's `model` field is only consulted when the key has no
// provider prefix — older hncode versions wrote corrupt values there (e.g. a
// different model's id), so it must not override a well-formed key.
export function bareModelId(provider, key, entry) {
  const e = entry || {};
  const providerName = e.provider || provider || '';
  const k = String(key || '');
  // API 只需要 model id 本身（可能带子前缀，如 qoder/deepseek-flash），
  // 不要 hncode 的 provider 前缀（traebuddy/）。所以剥掉 "<provider>/"。
  if (providerName && k.startsWith(providerName + '/')) return k.slice(providerName.length + 1);
  // key 没有 provider 前缀时，显式 model 字段优先；否则用 key 本身。
  const fromField = typeof e.model === 'string' ? e.model : '';
  return fromField || k;
}

// Human-friendly model label for the status line.
//   1. an explicit `display_name` on the [models.*] entry wins (user's choice)
//   2. otherwise the bare model id, exactly as configured
export function modelLabel(cfg) {
  const models = (cfg.raw && cfg.raw.models) || {};
  const entry = models[cfg.model] || {};
  if (entry.display_name) return entry.display_name;
  return bareModelId(cfg.provider, cfg.model, entry) || cfg.innerModel || cfg.model || '';
}

// Remember the model the user last switched to, so a new hncode session starts
// on it. Stored as a top-level `model = "..."` in config.toml.
export function rememberModel(model) {
  if (!model) return;
  const file = hncodeConfigFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = text.split(/\r?\n/);
  const out = [];
  let replaced = false;
  let seenTableHeader = false;
  for (const ln of lines) {
    const isModelLine = /^\s*model\s*=/.test(ln);
    // A top-level `model = "..."` line lives before any `[table]` header.
    // Once a table header appears, subsequent `model =` lines are table keys,
    // not the active model.
    if (isModelLine && !seenTableHeader && !replaced) {
      out.push(`model = "${String(model).replace(/"/g, '\\"')}"`);
      replaced = true;
      continue;
    }
    out.push(ln);
    if (/^\s*\[/.test(ln)) seenTableHeader = true;
  }
  if (!replaced) {
    // No top-level model line: insert it before the first table header.
    let at = out.findIndex((l) => /^\s*\[/.test(l));
    if (at < 0) at = out.length;
    out.splice(at, 0, `model = "${String(model).replace(/"/g, '\\"')}"`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const joined = out.join('\n').replace(/^\n+/, '');
  fs.writeFileSync(file, joined + (joined.endsWith('\n') ? '' : '\n'), 'utf8');
  return file;
}

// Non-secret snapshot for /settings display.
export function effectiveSnapshot(cfg) {
  return {
    model: cfg.model,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    protocol: cfg.protocol,
    endpoint: cfg.endpoint,
    apiKeySet: !!cfg.apiKey,
    reasoning: cfg.reasoning,
    maxContextTokens: cfg.maxContextTokens,
    maxOutputTokens: cfg.maxOutputTokens,
    workspace: cfg.workspace,
    allowExternal: cfg.allowExternal,
  };
}

// Re-resolve a provider's base URL / protocol / API key when the user switches
// providers at runtime (/provider, /model). The chosen provider's [providers.NAME]
// sub-table takes precedence (it's the point of switching); env vars set at boot
// are already baked into `cfg` and only remain in effect when the provider table
// does not override a given field.
// Recompute the context window for a given model key. `resolveConfig` picks the
// window from the model's [models.*] entry (context_length), an env/root
// override, or the default. resolveProvider / resolveModelArg must reuse the
// SAME rule when the user switches provider/model mid-session, otherwise the
// status-bar context gauge (state.ctxMax) keeps the stale previous model's value.
function contextForModel(cfg, modelName) {
  const root = (cfg && cfg.raw) || {};
  const models = (root.models) || {};
  const overrideContext = process.env.HNCODE_MAX_CONTEXT || root.max_context_size || root.max_context_tokens;
  const entry = models[modelName] || {};
  const modelContext = Number(entry.contextLength || entry.context_length || entry.max_context_size || 0);
  return Number(overrideContext || modelContext || DEFAULTS.maxContextTokens);
}

export function resolveProvider(cfg, providerName, innerModel) {
  const pr = (cfg.raw && cfg.raw.providers) || {};
  const prov = pr[providerName] || {};
  const baseUrl = (prov.base_url || prov.baseUrl || '') || cfg.baseUrl;
  const apiKey = (prov.api_key || prov.apiKey || '') || cfg.apiKey;
  const protocol = (prov.protocol) || cfg.protocol;
  const inner = prov.model || (innerModel != null ? innerModel : cfg.innerModel);
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const endpoint = !b ? '' : (protocol === 'anthropic' ? `${b}/messages` : `${b}/chat/completions`);
  // Provider switch may move the active model too; refresh the context window
  // so the gauge reflects the newly active model, not the old one.
  const maxContextTokens = contextForModel(cfg, cfg.model);
  return { ...cfg, provider: providerName, innerModel: inner, baseUrl: b, endpoint, apiKey, protocol, maxContextTokens };
}

// Switch model, optionally moving to a provider declared via [models.NAME].
// The returned cfg carries BOTH: `model` is the pool key (what the status line
// and rememberModel use) and `innerModel` is the bare id sent to the API.
export function resolveModelArg(cfg, modelName) {
  if (!modelName) return cfg;
  const models = (cfg.raw && cfg.raw.models) || {};
  const entry = models[modelName] || {};
  const provider = entry.provider || cfg.provider;
  const inner = bareModelId(provider, modelName, entry);
  // Refresh the context window for the newly selected model.
  const maxContextTokens = contextForModel(cfg, modelName);
  return { ...resolveProvider(cfg, provider, inner), model: modelName, maxContextTokens };
}

export default { resolveConfig, saveConfig, effectiveSnapshot, resolveProvider, resolveModelArg, addProvider, removeProvider, addModel, fetchModels, fetchCatalog, modelKey, modelLabel, bareModelId, rememberModel, hncodeConfigFile };