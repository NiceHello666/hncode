// secret-guard — catch credentials before they leave the machine.
//
// WHY THIS EXISTS: the one class of mistake that cannot be undone by editing a file is
// a secret that was already WRITTEN down. Once an API key is in a tracked file it is in
// your history and, after a push, on GitHub — rotating the key is the only fix. The
// built-in tools cannot cover this: Grep finds an exact string you already suspect, and
// nothing in the loop looks at what a Write/Edit is ABOUT to store.
//
// Two independent guards, because they catch different moments:
//
//   1. ScanSecret (tool) — an on-demand audit of the whole workspace.
//      Use it before committing, or when you inherit a repo and want to know whether
//      it is already leaking something.
//
//   2. A Write/Edit hook — fires while the agent is working and REFUSES the write.
//      The cheapest secret to clean up is the one that was never written, and a
//      post-hoc scan has to remember to run at all. A `PreToolUse`-style check that
//      returns a block reason hands the model the problem immediately, so it can fix
//      the file instead of the user finding out at push time.
//
// Deliberately NOT a entropy-based "looks random" heuristic: those fire on minified
// JS, hashes, base64 fixtures and UUIDs, and a guard that cries wolf gets turned off.
// Every rule below matches a PREFIX a provider actually issues, so a hit is a hit.

import fs from 'node:fs';
import path from 'node:path';

// Each rule: a named pattern. `id` is what the user sees. Kept conservative on
// purpose — see the header for why entropy scoring is not used.
const RULES = [
  { id: 'AWS access key',     re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'AWS secret',         re: /\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})\b/gi },
  { id: 'GitHub token',       re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'GitHub fine-grained',re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // Anthropic BEFORE OpenAI: `sk-ant-…` also satisfies the broader `sk-…` pattern, and a
  // specific rule listed second reports the same value twice under two names.
  { id: 'Anthropic key',      re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // `(?!ant-)` keeps the OpenAI rule from re-matching an Anthropic key even if the
  // ordering above is ever changed.
  { id: 'OpenAI key',         re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'Slack token',        re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'Google API key',     re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'Stripe secret',      re: /\b[rs]k_live_[0-9a-zA-Z]{24,}\b/g },
  { id: 'Private key block',  re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { id: 'JWT',                re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'Generic assignment', re: /(?:api[_-]?key|apikey|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*["']([^"'\s]{12,})["']/gi },
];

// A file whose NAME says it is a sample is not a leak: `.env.example`, `config.sample`,

// A file whose NAME says it is a sample is not a leak: `.env.example`, `config.sample`,
// docs, and the test fixtures that deliberately contain fake keys. Flagging those trains
// people to ignore the guard.
const SKIP_FILE = /(^|[\\/])(\.env\.(example|sample|template|dist)|.*\.(example|sample|template|md|mdx|txt|rst))$/i;
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|dist|build|out|coverage|vendor|\.next|target|__pycache__|\.venv|venv)([\\/]|$)/i;

// A value that is obviously a placeholder is not a secret.
const PLACEHOLDER = /^(x+|y+|z+|0+|\*+|\.{3,}|<[^>]*>|\$\{[^}]*\}|your[_-]?.*|changeme|placeholder|redacted|example|test|dummy|fake|todo|null|undefined|none|abc123|foo|bar|baz)$/i;

function isPlaceholder(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (PLACEHOLDER.test(s)) return true;
  // A rule whose capture group is missing (a bare prefix match) has nothing to check.
  return false;
}

/**
 * Scan text for secret-shaped strings.
 * Returns [{ rule, line, match }] with the match REDACTED — reporting the secret back
 * in full would put it in the transcript and the session file, which is the same leak
 * the scan is meant to prevent.
 */
export function scanText(text, { maxHits = 50 } = {}) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000) continue;      // minified/bundled: not a hand-written secret
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const captured = m[1];
        if (captured !== undefined && isPlaceholder(captured)) continue;
        hits.push({ rule: rule.id, line: i + 1, match: redact(m[0]) });
        if (hits.length >= maxHits) return hits;
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++;   // zero-width safety
      }
    }
  }
  return hits;
}

// Show only enough to locate the value, never enough to use it.
export function redact(s) {
  const str = String(s);
  if (str.length <= 8) return str[0] + '***';
  return str.slice(0, 4) + '…' + str.slice(-2) + ` (${str.length} chars)`;
}

function walk(root, { maxFiles = 5000, maxBytes = 512 * 1024 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (SKIP_DIR.test(full)) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      if (SKIP_FILE.test(full)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size === 0 || st.size > maxBytes) continue;
      out.push(full);
    }
  }
  return out;
}

const spec = {
  name: 'ScanSecret',
  description: `Audit files for leaked credentials (API keys, tokens, private keys).

Use it:
- before committing or pushing, especially on a repo you did not write;
- after pasting configuration, or when a model has just written config/env files;
- NOT as a replacement for a proper history scanner (gitleaks/trufflehog) — this reads the
  files as they are NOW and cannot see a secret that was deleted in an earlier commit.

Returns one line per hit: file, line number, rule, and the match REDACTED (only the first
few characters). A placeholder such as \`your_api_key_here\` is not reported.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to scan. Defaults to the workspace root.' },
      maxFiles: { type: 'number', description: 'Stop after this many files (default 5000).' },
    },
  },
  async execute(args, ctx) {
    const root = path.resolve(ctx.cwd || ctx.workspace || process.cwd(), String(args.path || '.'));
    let targets;
    let st;
    try { st = fs.statSync(root); } catch { return `Error: no such path: ${root}`; }
    if (st.isFile()) targets = SKIP_FILE.test(root) ? [] : [root];
    else targets = walk(root, { maxFiles: Number(args.maxFiles) > 0 ? Number(args.maxFiles) : 5000 });

    const findings = [];
    let scanned = 0;
    for (const f of targets) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      // A NUL byte in the first chunk means binary: skip without decoding the rest.
      if (text.indexOf('\u0000') >= 0) continue;
      scanned++;
      for (const h of scanText(text)) {
        findings.push({ file: path.relative(ctx.cwd || ctx.workspace || root, f) || f, ...h });
        if (findings.length >= 100) break;
      }
      if (findings.length >= 100) break;
    }

    if (!findings.length) return `No secrets found. Scanned ${scanned} file(s) under ${root}.`;
    const lines = findings.map((f) => `  ${f.file}:${f.line}  ${f.rule}  ${f.match}`);
    return `Found ${findings.length} possible secret(s) in ${scanned} file(s):\n${lines.join('\n')}\n\n`
      + 'Each value above is REDACTED. If a real credential is here, rotate it — removing the\n'
      + 'file is NOT enough once it has been committed or pushed. For history, use gitleaks.';
  },
};

// The write-guard. Only text-like extensions are inspected: scanning a PNG for
// "sk-" would both waste time and produce nonsense hits.
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|json5|ya?ml|toml|ini|env|cfg|conf|config|md|txt|sh|ps1|bat|py|rb|go|rs|java|kt|php|lua|sql|xml|properties|gradle)$/i;
const ENV_LIKE = /(^|[\\/])(\.env(\..*)?|[^\\/]*\.(env|pem|key|p12|pfx))$/i;

export function install(api) {
  api.registerTool(spec);

  // Block a Write/Edit that would introduce a secret. Hooks in this codebase receive
  // (toolName, args, ctx); throwing inside onToolExecute is what aborts the call, so the
  // message has to explain the fix rather than just refuse.
  api.registerHook('onToolExecute', (toolName, args) => {
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    const chunks = [];
    if (typeof args.content === 'string') chunks.push(args.content);          // Write
    if (typeof args.new_string === 'string') chunks.push(args.new_string);    // Edit
    if (typeof args.old_string === 'string') chunks.push(args.old_string);
    if (!chunks.length) return;
    const p = String(args.path || args.file_path || '');
    // A `.env.example` or a doc is SUPPOSED to show key shapes; only real targets block.
    if (SKIP_FILE.test(p) || /\.(example|sample|template)$/i.test(p)) return;

    const hits = scanText(chunks.join('\n'), { maxHits: 3 });
    if (!hits.length) return;
    // Match on the NAME as well: writing to a .env / .pem is the most likely way a real
    // secret lands on disk even when its shape is unusual.
    const named = ENV_LIKE.test(p) ? ' (this is a secret-bearing file name)' : '';
    const detail = hits.map((h) => `  - ${h.rule}: ${h.match}`).join('\n');
    throw new Error(
      `secret-guard blocked this ${toolName}${named} — it looks like it writes a credential:\n${detail}\n`
      + 'Move the value into an environment variable, or read it from a file that is git-ignored,\n'
      + 'and reference that instead. If it is a deliberate test fixture, put it in a file whose\n'
      + 'name ends in .example or .sample (those are exempt).',
    );
  });

  api.registerCommand({
    name: 'secret-scan',
    description: 'Scan the workspace for leaked credentials (alias for the ScanSecret tool)',
    argumentHint: '[path]',
    run: async (arg, ctx) => {
      const out = await spec.execute({ path: String(arg || '').trim() || '.' }, ctx.ctx || ctx);
      return out;
    },
  });
}

export default { name: 'secret-guard' };
