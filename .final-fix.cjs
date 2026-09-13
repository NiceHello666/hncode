// Simple fix: output content first, then cursor-position scrollbar
const fs = require('fs');
let s = fs.readFileSync('src/tui.js', 'utf8');

// Replace the entire scrollbar rendering section
const oldSection = "    for (let i = 0; i < bodyH; i++) {\n      const idx = start + i;\n      let row = '';\n      if (idx >= 0 && idx < total) {\n        row = lineToString(chat[idx]);\n      }\n      if (sb) {\n        const inThumb = i >= sb.thumbStart && i < sb.thumbStart + sb.thumbLen;\n        let thumbColor = C.scrollThumb;\n        if (state.sbDrag) thumbColor = C.scrollThumbActive;\n        else if (state.sbHover) thumbColor = C.scrollThumbHover;\n        const glyph = inThumb ? col('┃', thumbColor) : col('│', C.scrollTrack);\n        row = fitAnsi(row, w - 1) + glyph;\n      }\n      lines.push(row);\n    }";

const newSection = "    for (let i = 0; i < bodyH; i++) {\n      const idx = start + i;\n      let row = '';\n      if (idx >= 0 && idx < total) {\n        row = lineToString(chat[idx]);\n      }\n      \n      // Step 1: Output content line\n      lines.push(row);\n      \n      // Step 2: If scrollbar needed, append cursor-move + glyph\n      if (sb) {\n        const inThumb = i >= sb.thumbStart && i < sb.thumbStart + sb.thumbLen;\n        let thumbColor = C.scrollThumb;\n        if (state.sbDrag) thumbColor = C.scrollThumbActive;\n        else if (state.sbHover) thumbColor = C.scrollThumbHover;\n        const glyph = inThumb ? col('┃', thumbColor) : col('│', C.scrollTrack);\n        \n        // Move cursor to column w (right edge) on this row, then write glyph\n        // Format: ESC[<row>;<col>H where row/col are 1-indexed\n        const cursorMove = '\\x1b[' + (idx + 1) + ';' + w + 'H';\n        lines.push(cursorMove + glyph);\n      }\n    }";

const n = s.split(oldSection).length - 1;
if (n !== 1) throw new Error('expected 1 match, found ' + n);
s = s.replace(oldSection, newSection);

fs.writeFileSync('src/tui.js', s, 'utf8');
console.log('✅ Done! Scrollbar now uses separate cursor positioning.');
console.log('   Content is written first, then cursor moves to fixed position to write scrollbar.');
