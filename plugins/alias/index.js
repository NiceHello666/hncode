// alias plugin — user-defined command aliases for hncode.
//
// Adds two commands that feed the engine's alias table (resolved in dispatch()
// before any built-in/plugin command):
//   /alias <short> <expansion>        project-scoped (only this workspace)
//   /global-alias <short> <expansion> global (every workspace)
//   /alias (no args)                  list current aliases
//   /alias <short>                    remove that alias
//
// The expansion is any command text, e.g. "/explain" or "/deps --quick". When
// you later type "/<short> args", dispatch rewrites it to "<expansion> args".
//
// This plugin only writes cfg.command_aliases via api.persistConfig (host does
// the TOML write); it imports nothing from ../src.  LICENSE: MIT.

const ALIAS_KEY = 'command_aliases';

function readAliases(api) {
  const v = api.getConfig(ALIAS_KEY);
  return (v && typeof v === 'object') ? v : {};
}
function writeAliases(api, map) {
  api.persistConfig(ALIAS_KEY, map);
}

function registerAliasCommand(api, { name, scope, description }) {
  api.registerCommand({
    name,
    description,
    argumentHint: scope === 'global'
      ? '<short> <expansion>  |  <short> (remove)  |  (list)'
      : '<short> <expansion>  |  <short> (remove)  |  (list)',
    run: async (arg, ctx) => {
      const say = (m) => (typeof ctx?.app === 'function' ? ctx.app(m) : api.notice(m, 'info'));
      const fail = (m) => (typeof ctx?.appErr === 'function' ? ctx.appErr(m) : api.notice(m, 'error'));
      const parts = String(arg || '').trim().split(/\s+/);
      const map = readAliases(api);

      // No args → list
      if (!parts[0]) {
        const entries = Object.entries(map).filter(([, v]) => v.scope === scope);
        if (!entries.length) { say(`No ${scope} aliases.`); return; }
        const ws = (ctx.state && (ctx.state.cwd || ctx.state.workspace)) || '';
        const lines = entries.map(([k, v]) => `  ${k} → ${v.to}${v.scope === 'project' ? `  (workspace ${v.workspace === ws ? 'this' : v.workspace})` : ''}`);
        say(`${scope} aliases:\n${lines.join('\n')}`);
        return;
      }

      const short = parts[0].replace(/^\/+/, '').toLowerCase();
      const expansion = parts.slice(1).join(' ').trim();

      // Remove mode: "/alias foo" with no expansion
      if (!expansion) {
        if (map[short] && map[short].scope === scope) {
          delete map[short];
          writeAliases(api, map);
          say(`Removed ${scope} alias: /${short}`);
        } else {
          fail(`No ${scope} alias /${short} to remove.`);
        }
        return;
      }

      const target = expansion.replace(/^\/+/, '');
      if (!target) { fail('Error: expansion cannot be empty.'); return; }
      map[short] = {
        to: target,
        scope,
        workspace: scope === 'project' ? ((ctx.state && (ctx.state.cwd || ctx.state.workspace)) || process.cwd()) : undefined,
      };
      writeAliases(api, map);
      say(`Set ${scope} alias /${short} → /${target}`);
    },
  });
}

export function install(api) {
  registerAliasCommand(api, {
    name: 'alias',
    scope: 'project',
    description: 'Project command alias: /alias <short> <expansion> | /alias <short> (remove) | /alias (list).',
  });
  registerAliasCommand(api, {
    name: 'global-alias',
    scope: 'global',
    description: 'Global command alias (every workspace): /global-alias <short> <expansion> | <short> (remove) | (list).',
  });
}

export default { name: 'alias', version: '1.0.0' };
