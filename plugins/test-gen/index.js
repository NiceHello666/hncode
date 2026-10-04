// test-gen plugin — generate a unit-test scaffold for a source file. hncode can
// answer "write tests for this" in chat, but it leaves no file and guesses the
// framework. This command produces a sibling test file (<name>.test.<ext> or
// __tests__/<name>.test.<ext>) using the repo's own test setup, so the result is
// runnable immediately. The agent reads the target and writes the test file.
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

// Decide the test file path + which framework the repo uses, by sniffing manifests.
function plan(cwd, target) {
  const abs = path.resolve(cwd, target);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);

  // framework detection
  let framework = 'generic';
  try {
    const p = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const all = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
    if (all.vitest) framework = 'vitest';
    else if (all.jest) framework = 'jest';
    else if (all.mocha) framework = 'mocha';
    else if (all['@playwright/test']) framework = 'playwright';
  } catch { /* no package.json */ }

  // placement: __tests__/ next to the file, or sibling .test.EXT
  const useDir = fs.existsSync(path.join(dir, '__tests__'));
  const testPath = useDir
    ? path.join(dir, '__tests__', `${stem}.test${ext}`)
    : path.join(dir, `${stem}.test${ext}`);
  return { abs, testPath, framework, ext: ext || '.js' };
}

export function install(api) {
  api.registerCommand({
    name: 'test-gen',
    description: 'Generate a unit-test scaffold (<name>.test.<ext>) for a source file, using the repo\'s test framework.',
    argumentHint: '<file>',
    run: async (arg, ctx) => {
      const say = out(ctx);
      const fail = err(ctx);
      const target = String(arg || '').trim();
      if (!target) { fail('Error: a source file path is required.'); return; }

      const cwd = cwdOf(ctx);
      const abs = path.resolve(cwd, target);
      if (!fs.existsSync(abs)) { fail(`Error: no such file: ${abs}`); return; }

      const { testPath, framework } = plan(cwd, target);

      const prompt =
`Write a unit-test scaffold for the source file at ${abs}, as the test framework ${framework}, and save it to ${testPath} as Markdown code (i.e. write the file ${testPath} with the test source).\n\n` +
`Requirements:\n` +
`- Import the public functions/exports from the source file and test the main behaviors.\n` +
`- Cover the happy path plus at least one edge/error case.\n` +
`- Use the conventions of ${framework} (e.g. describe/it for jest/vitest, test() for mocha).\n` +
`- Keep it runnable: do not reference private internals that are not exported.\n` +
`Be accurate about the module's actual API — read the source first. Do not invent exports.`;

      if (typeof api.sendPrompt !== 'function') { fail('Error: no agent host available.'); return; }
      const dispatched = api.sendPrompt(`/test-gen`, { skillBody: prompt, bubbleText: `generate tests for ${target}` });
      if (!dispatched) { fail('Error: agent host not ready. Restart hncode.'); return; }
      say(`Generating ${framework} tests → ${testPath}`);
    },
  });
}

export default { name: 'test-gen', version: '1.0.0' };
