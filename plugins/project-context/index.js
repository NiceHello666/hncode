// project-context plugin — generate a PROJECT.md onboarding document for the
// current workspace. hncode's /explain covers a single file; this covers the WHOLE
// project: what it is, how to run it, key directories, and conventions — the thing
// you'd hand a new teammate on day one. The agent reads the repo and writes the doc.
//
// Self-contained: Node builtins + public plugin API only; no ../src imports.
// LICENSE: MIT.

import fs from 'node:fs';
import path from 'node:path';

function cwdOf(ctx) {
  return ctx.state?.cwd || ctx.state?.workspace || (ctx.cfg && ctx.cfg.workspace) || process.cwd();
}
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

// Lightweight repo scan to give the agent a head start (avoids wasting tokens on
// huge directory walks the agent would have to do itself).
function scanRepo(cwd) {
  const top = [];
  try {
    for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      top.push(e.isDirectory() ? `dir  ${e.name}/` : `file ${e.name}`);
    }
  } catch { /* ignore */ }
  const manifests = ['package.json', 'README.md', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'Makefile', 'Dockerfile', '.gitignore']
    .filter((f) => fs.existsSync(path.join(cwd, f)));
  let pkg = '';
  try {
    const p = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    pkg = `name=${p.name || '?'} scripts=${Object.keys(p.scripts || {}).join(',')} deps=${Object.keys(p.dependencies || {}).length}`;
  } catch { /* no package.json or unreadable */ }
  return { top: top.join('\n'), manifests: manifests.join(', '), pkg };
}

export function install(api) {
  api.registerCommand({
    name: 'project-context',
    description: 'Generate a PROJECT.md onboarding document (what it is, how to run, key dirs) for the workspace.',
    argumentHint: '[output file]  (default: <cwd>/PROJECT.md)',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const cwd = cwdOf(ctx);
      const outPath = path.resolve(cwd, String(arg || '').trim() || 'PROJECT.md');

      const scan = scanRepo(cwd);

      const prompt =
`Write a concise PROJECT.md onboarding document for this repository as Markdown, written to ${outPath}.\n\n` +
`Workspace: ${cwd}\n` +
`Top-level entries:\n${scan.top || '(empty)'}\n` +
`Recognized manifests: ${scan.manifests || '(none)'}\n` +
`package.json summary: ${scan.pkg || '(n/a)'}\n\n` +
`Include:\n` +
`- What the project is for (1-2 sentences)\n` +
`- How to install, build, run, and test (read the relevant manifest/scripts)\n` +
`- Key directories and their roles\n` +
`- Any conventions, gotchas, or env requirements a newcomer needs\n` +
`Be accurate; cite file:line where useful. Do not invent scripts or commands you have not verified by reading the repo.`;

      if (typeof api.sendPrompt !== 'function') { fail('Error: no agent host available.'); return; }
      const dispatched = api.sendPrompt(`/project-context`, { skillBody: prompt, bubbleText: 'generate PROJECT.md' });
      if (!dispatched) { fail('Error: agent host not ready. Restart hncode.'); return; }
      say(`Generating PROJECT.md → ${outPath}`);
    },
  });
}

export default { name: 'project-context', version: '1.0.0' };
