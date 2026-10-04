// patch-example — a worked example of api.patch, the symbol-level patching API.
//
// Enable it with `/plugins install patch-example` (or copy this folder into
// ~/.hncode/plugins), then RESTART hncode — patches are installed at load time.
// Run `/patch` to see the targets this plugin registered actually listed.
//
// api.patch(target, handler) wraps a symbol in hncode's own src/ without editing
// it. The target is "file.js#name" (a top-level export) or "file.js#Class.method".
// handler may supply any of before/after/around — see plugins/README.md.
//
// Below are three small, SAFE, observable patches (each just logs; none change
// behaviour), chosen so the example cannot surprise anyone:
//   * a top-level function   — git.js#isRepo
//   * a class method         — llm.js#LLM.requestText
//   * an argument rewrite    — Glob-style: not shown, because `before` returning
//                              an array REPLACES the args (documented in README).
//
// NOTE: patching a hot path in production would be a real behaviour change. This
// plugin is intentionally inert (it logs to a ring buffer you can inspect) so it
// is safe to load. Set HNCODE_PATCH_EXAMPLE_VERBOSE=1 to also print to stderr.

const log = [];
globalThis.__patchExampleLog = log;

function record(what) {
  const line = `${new Date().toISOString()} ${what}`;
  log.push(line);
  if (log.length > 200) log.shift();
  if (process.env.HNCODE_PATCH_EXAMPLE_VERBOSE === '1') console.error('[patch-example]', line);
}

export function install(api) {
  // 1) Wrap a top-level export. `after` runs once the original returns.
  api.patch('git.js#isRepo', {
    after: (result, args) => { record(`isRepo(${JSON.stringify(args)}) -> ${result}`); return result; },
  });

  // 2) Wrap a class method. `this` inside the handler is the instance.
  api.patch('llm.js#LLM.requestText', {
    before: () => { record('LLM.requestText called'); },
  });

  // 3) A slash-command to dump the log, so the example is self-contained.
  api.registerCommand({
    name: 'patch-example-log',
    description: 'Show the log written by the patch-example plugin (demonstrates api.patch).',
    argumentHint: '[clear]',
    run: async (arg, ctx) => {
      const say = (m) => (typeof ctx?.app === 'function' ? ctx.app(m) : api.notice(m, 'info'));
      if (String(arg || '').trim() === 'clear') { log.length = 0; say('patch-example log cleared.'); return; }
      if (!log.length) { say('patch-example log is empty — use the tools, then re-run this.'); return; }
      say(`patch-example log (${log.length} entries):\n` + log.slice(-20).join('\n'));
    },
  });
}

export default { name: 'patch-example', version: '1.0.0' };
