// Fix: left/right arrow should move by visual columns, not character indices
// This handles emoji and other wide characters correctly
const fs = require('fs');
let s = fs.readFileSync('src/tui.js', 'utf8');

const oldLeftRight = "    if (t.key === 'left' || t.key === 'right') {\n      const dir = t.key === 'left' ? -1 : 1;\n      const mk = adjacentPasteMarker(state.input, state.caret || 0, dir);\n      if (mk) {\n        state.caret = dir < 0 ? mk.start : mk.end;\n      } else if (dir < 0) {\n        state.caret = Math.max(0, (state.caret || 0) - 1);\n      } else {\n        state.caret = Math.min(state.input.length, (state.caret || 0) + 1);\n      }\n      renderFrame(); return;\n    }";

const newLeftRight = "    if (t.key === 'left' || t.key === 'right') {\n      const dir = t.key === 'left' ? -1 : 1;\n      const mk = adjacentPasteMarker(state.input, state.caret || 0, dir);\n      if (mk) {\n        state.caret = dir < 0 ? mk.start : mk.end;\n      } else {\n        // Move by visual column, handling emoji/wide chars correctly\n        const input = state.input || '';\n        let pos = state.caret || 0;\n        while (pos >= 0 && pos <= input.length) {\n          const targetPos = dir < 0 ? pos - 1 : pos + 1;\n          if (targetPos < 0 || targetPos > input.length) break;\n          const ch = input.slice(targetPos - Math.sign(dir), targetPos);\n          if (visualWidth(ch) === 1) { pos = targetPos; break; }\n          // Wide char: skip the whole glyph\n          if (dir < 0 && targetPos > 0) pos = targetPos - 1;\n          else if (dir > 0 && targetPos < input.length) pos = targetPos + 1;\n          else break;\n        }\n        state.caret = Math.max(0, Math.min(input.length, pos));\n      }\n      renderFrame(); return;\n    }";

const n = s.split(oldLeftRight).length - 1;
if (n !== 1) throw new Error('expected 1 match for left/right handler, found ' + n);
s = s.replace(oldLeftRight, newLeftRight);
fs.writeFileSync('src/tui.js', s, 'utf8');
console.log('ok: left/right now handles emoji width correctly');
