// workspace-utils plugin — three small, genuinely-missing utilities for hncode.
//
// What hncode already has (so we do NOT overlap):
//   - TodoList TOOL (the agent maintains a todo list) but NO command to export it.
//   - /diff, /git etc. but no "explain this file and save the note".
//   - no dependency-health scan at all.
//
// IMPORTANT (feedback channel): the TUI discards a plugin command's return
// value. Real feedback must go through ctx.app / ctx.appErr (the same channels
// the built-in commands use) — so every command prints its result via ctx.app.
//
// This plugin uses only the public plugin API (api.writeFile, api.sendPrompt)
// and the command context (ctx.state.todos, ctx.state.cwd, ctx.app). It imports
// NOTHING from ../src/*, so it works when installed to ~/.hncode/plugins.
// LICENSE: MIT.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cwdOf(ctx) {
  return ctx.state?.cwd || ctx.state?.workspace || (ctx.cfg && ctx.cfg.workspace) || process.cwd();
}

// Print a result line. The TUI passes the command a context with `app` /
// `appErr`, which are the SAME transient banner (state.notice, ~4s, NOT written
// into the chat history) that built-in commands like /model use. We use that and
// nothing else, so results never bloat the conversation context. Falls back to
// the plugin API notice only in a headless host; never addChat (that would add a
// permanent system message and waste context).
function out(ctx) {
  if (typeof ctx?.app === 'function') return (m) => ctx.app(m);
  if (typeof ctx?.api?.notice === 'function') return (m) => ctx.api.notice(m, 'info');
  return () => {};
}
function err(ctx) {
  if (typeof ctx?.appErr === 'function') return (m) => ctx.appErr(m);
  if (typeof ctx?.app === 'function') return (m) => ctx.app(m);
  if (typeof ctx?.api?.notice === 'function') return (m) => ctx.api.notice(m, 'error');
  return () => {};
}

// ---------------------------------------------------------------------------
// /todo-export — write the current session's todo list to a Markdown checklist.
// hncode shows todos on screen but you cannot save them; this persists them so
// you can hand the list to a teammate or pick it up later.
// ---------------------------------------------------------------------------
function registerTodoExport(api) {
  api.registerCommand({
    name: 'todo-export',
    description: 'Export the current session todo list to a Markdown checklist file.',
    argumentHint: '[path]  (default: <cwd>/TODO.md)',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const todos = (ctx.state && Array.isArray(ctx.state.todos)) ? ctx.state.todos : [];
      if (!todos.length) { fail('No todos in this session. Use the TodoList tool first.'); return; }

      const cwd = cwdOf(ctx);
      const outPath = path.resolve(cwd, String(arg || '').trim() || 'TODO.md');
      const stamp = new Date().toISOString().slice(0, 10);
      const counts = todos.reduce((a, t) => { a[t.status] = (a[t.status] || 0) + 1; return a; }, {});

      const lines = [];
      lines.push(`# Todo list — ${stamp}`);
      lines.push('');
      lines.push(`_${counts.done || 0} done, ${counts.in_progress || 0} in progress, ${(counts.pending || 0) + (counts.planned || 0)} pending._`);
      lines.push('');
      const mark = { done: '[x]', in_progress: '[~]', pending: '[ ]', planned: '[ ]' };
      for (const t of todos) {
        const m = mark[t.status] || '[ ]';
        lines.push(`${m} ${t.title}`);
      }
      lines.push('');

      if (api.writeFile(outPath, lines.join('\n'))) {
        say(`Exported ${todos.length} todo(s) to ${outPath}`);
      } else {
        fail(`Error: could not write ${outPath}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// /explain — have the agent explain a file (or path) in plain language and save
// the explanation next to it as <name>.explained.md. hncode can answer "what
// does this do?" in chat, but it leaves no durable, re-readable note. This
// captures the explanation as a file you can revisit or commit.
// ---------------------------------------------------------------------------
function registerExplain(api) {
  api.registerCommand({
    name: 'explain',
    description: 'EXPLAIN a file: the agent writes a plain-language walkthrough and saves it as <name>.explained.md.',
    argumentHint: '<file|dir>',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const target = String(arg || '').trim();
      if (!target) { fail('Error: a file or directory path is required.'); return; }

      const cwd = cwdOf(ctx);
      const abs = path.resolve(cwd, target);
      let exists = false;
      try { exists = fs.existsSync(abs); } catch { /* ignore */ }
      if (!exists) { fail(`Error: no such file or directory: ${abs}`); return; }

      const isDir = fs.statSync(abs).isDirectory();
      const base = path.basename(abs);
      const outName = `${base}.explained.md`;
      const outPath = path.join(path.dirname(abs), outName);

      const prompt =
        `Explain the following ${isDir ? 'directory' : 'file'} in plain, practical language for a developer who has not seen it before.\n` +
        `Target: ${abs}\n\n` +
        `Write the explanation to the file ${outPath} as Markdown. Include:\n` +
        `- What the ${isDir ? 'directory' : 'file'} is for and its role in the project\n` +
        `- Key entry points / exported functions or modules\n` +
        `- Important control flow or data flow\n` +
        `- Any non-obvious gotchas, dependencies, or conventions\n` +
        `Keep it accurate and cite file:line where useful. Do not invent behaviour.`;

      if (typeof api.sendPrompt === 'function') {
        const dispatched = api.sendPrompt(`/explain ${target}`, { skillBody: prompt, bubbleText: `explain ${target}` });
        if (dispatched) {
          say(`Explaining ${target} — note → ${outPath}`);
        } else {
          fail('Error: the agent host is not ready. Restart hncode and try again.');
        }
      } else {
        fail('Error: no agent host available to run the explanation.');
      }
    },
  });
}

// ---------------------------------------------------------------------------
// /deps — scan declared dependencies and have the agent assess health: outdated
// majors, known-risk patterns, and obvious gaps. hncode has no dependency tool
// at all. We read package.json / requirements.txt / go.mod ourselves (cheap,
// no network) and let the agent use its tools for the deeper analysis.
// ---------------------------------------------------------------------------
function readManifest(cwd) {
  const candidates = [
    { file: 'package.json', kind: 'npm', read: () => {
      const j = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      return { dependencies: j.dependencies || {}, devDependencies: j.devDependencies || {} };
    } },
    { file: 'requirements.txt', kind: 'pip', read: () => {
      const txt = fs.readFileSync(path.join(cwd, 'requirements.txt'), 'utf8');
      const deps = {};
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9_.\-]+)/);
        if (m && !line.trim().startsWith('#')) deps[m[1]] = '';
      }
      return { dependencies: deps, devDependencies: {} };
    } },
    { file: 'go.mod', kind: 'go', read: () => {
      const txt = fs.readFileSync(path.join(cwd, 'go.mod'), 'utf8');
      const deps = {};
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(require\s+)?([A-Za-z0-9_./\-]+)\s+v[\d]/);
        if (m) deps[m[2].replace(/^require\s+/, '')] = '';
      }
      return { dependencies: deps, devDependencies: {} };
    } },
  ];
  for (const c of candidates) {
    const p = path.join(cwd, c.file);
    if (fs.existsSync(p)) {
      try { return { ok: true, kind: c.kind, file: c.file, data: c.read() }; }
      catch (e) { return { ok: false, file: c.file, note: e.message }; }
    }
  }
  return { ok: false, note: 'no package.json / requirements.txt / go.mod found in the workspace' };
}

function registerDeps(api) {
  api.registerCommand({
    name: 'deps',
    description: 'Scan declared dependencies and have the agent assess health (outdated majors, risk patterns, gaps).',
    argumentHint: '[path]  (default: workspace root)',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const cwd = path.resolve(cwdOf(ctx), String(arg || '').trim() || '.');
      const m = readManifest(cwd);
      if (!m.ok) { fail(`Error: ${m.note || 'could not read manifest'}.`); return; }

      const all = { ...m.data.dependencies, ...m.data.devDependencies };
      const names = Object.keys(all);
      if (!names.length) {
        fail(`No dependencies declared in ${m.file} (at ${cwd}). Run /deps <path-to-a-project-with-a-manifest> to scan another directory.`);
        return;
      }

      const section = (title, obj) => {
        const keys = Object.keys(obj);
        if (!keys.length) return '';
        return `${title} (${keys.length}):\n` + keys.map((k) => `  - ${k}@${obj[k] || '(unpinned)'}`).join('\n') + '\n';
      };
      const manifestText =
        `Dependency manifest: ${m.file} (${m.kind})\n` +
        section('dependencies', m.data.dependencies) +
        section('devDependencies', m.data.devDependencies);

      const prompt =
        `Assess the dependency health of this project based on its manifest below.\n\n` +
        '```\n' + manifestText + '```\n\n' +
        `Workspace: ${cwd}\n\n` +
        `Use your tools (for example check the lockfile, run the project's package manager, ` +
        `or read the relevant source) to give a practical review:\n` +
        `- Outdated dependencies, especially those behind a MAJOR version\n` +
        `- Packages with known risk patterns (native builds, large attack surface, unmaintained)\n` +
        `- Missing or unpinned versions that hurt reproducibility\n` +
        `- Obvious gaps (a test framework missing, a linter missing)\n` +
        `Be concrete: name packages and the specific concern. Do not invent version numbers ` +
        `you have not verified. If the manifest looks fine, say so.`;

      if (typeof api.sendPrompt === 'function') {
        const dispatched = api.sendPrompt(`/deps ${cwd}`, { skillBody: prompt, bubbleText: `deps ${cwd}` });
        if (dispatched) {
          say(`Scanning ${names.length} dependenc(ies) via ${m.file}`);
        } else {
          fail('Error: the agent host is not ready. Restart hncode and try again.');
        }
      } else {
        fail('Error: no agent host available to run the scan.');
      }
    },
  });
}

export function install(api) {
  registerTodoExport(api);
  registerExplain(api);
  registerDeps(api);
}

export default { name: 'workspace-utils', version: '1.0.0' };
