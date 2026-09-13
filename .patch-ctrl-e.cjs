// Add Ctrl+E to open config.toml for editing
const fs = require('fs');
let s = fs.readFileSync('src/tui.js', 'utf8');

// Find a good place to add the handler - after other c-* handlers
const oldHandler = "    if (t.key === 'c-b') {\n      const fg = state.agent && state.agent.ctx && state.agent.ctx._foreground;\n      if (fg && typeof fg.detach === 'function') {\n        const id = fg.detach();\n        if (id) {\n          notice(`Moved to background: ${id}`, 'info');\n          renderFrame();\n          return;\n        }\n      }\n    }";

const newHandler = "    if (t.key === 'c-e') {\n      // Open config.toml in default editor\n      const home = process.env.USERPROFILE || process.env.HOME;\n      const configFile = path.join(home, '.hncode', 'config.toml');\n      try {\n        cp.exec(`start \"\" \"${configFile}\"`);\n        notice(`Opened ${configFile} in editor`, 'info');\n        renderFrame();\n        return;\n      } catch (e) {\n        notice(`Failed to open config: ${e.message}`, 'error');\n        renderFrame();\n        return;\n      }\n    }\n\n    if (t.key === 'c-b') {\n      const fg = state.agent && state.agent.ctx && state.agent.ctx._foreground;\n      if (fg && typeof fg.detach === 'function') {\n        const id = fg.detach();\n        if (id) {\n          notice(`Moved to background: ${id}`, 'info');\n          renderFrame();\n          return;\n        }\n      }\n    }";

const n = s.split(oldHandler).length - 1;
if (n !== 1) throw new Error('expected 1 match for c-b handler, found ' + n);
s = s.replace(oldHandler, newHandler);
fs.writeFileSync('src/tui.js', s, 'utf8');
console.log('ok: added Ctrl+E to open config.toml');
