// Move approval panel before composer
const fs = require('fs');
let s = fs.readFileSync('src/tui.js', 'utf8');

// Find the approval panel block and its surrounding context
const approvalBlock = "// Approval pending overlay - use same width as composer\n  // Placed above the composer box\n  if (state.approvalPending && !dialog) {\n    const ap = state.approvalPending;\n    const promptW = insideW;\n    const verb = col('Approve', C.white + C.bold);\n    const cmd = col(ap.toolName + '?', C.cyan + C.bold);\n    const prompt = verb + ' ' + cmd;\n    const hint = col('Enter to approve | Esc to reject', C.gray);\n    lines.push(col('╭' + '─'.repeat(promptW) + '╮', C.border));\n    lines.push(col('│ ' + fitAnsi(prompt, promptW - 2) + ' │', C.border));\n    if (ap.desc) {\n      const descLine = ap.desc.length > promptW - 6 ? ap.desc.slice(0, promptW - 9) + '...' : ap.desc;\n      lines.push(col('│  ' + col(descLine, C.gray) + ' │', C.border));\n    }\n    lines.push(col('│ ' + fitAnsi(hint, promptW - 2) + ' │', C.border));\n    lines.push(col('╰' + '─'.repeat(promptW) + '╯', C.border));\n  }";

// Remove the approval block from its current position
s = s.replace('\n    ' + approvalBlock, '');

// Find composer start and insert approval block before it
const composerStart = "let composerFirstRow = -1;\n  if (!dialog) {\n    composerFirstRow = lines.length + 1;\n    lines.push(col('╭' + '─'.repeat(insideW) + '╮', C.border));";

const newComposerStart = `  // Approval pending overlay - same width as composer, placed above it
  if (state.approvalPending && !dialog) {
    const ap = state.approvalPending;
    const promptW = insideW;
    const verb = col('Approve', C.white + C.bold);
    const cmd = col(ap.toolName + '?', C.cyan + C.bold);
    const prompt = verb + ' ' + cmd;
    const hint = col('Enter to approve | Esc to reject', C.gray);
    lines.push(col('╭' + '─'.repeat(promptW) + '╮', C.border));
    lines.push(col('│ ' + fitAnsi(prompt, promptW - 2) + ' │', C.border));
    if (ap.desc) {
      const descLine = ap.desc.length > promptW - 6 ? ap.desc.slice(0, promptW - 9) + '...' : ap.desc;
      lines.push(col('│  ' + col(descLine, C.gray) + ' │', C.border));
    }
    lines.push(col('│ ' + fitAnsi(hint, promptW - 2) + ' │', C.border));
    lines.push(col('╰' + '─'.repeat(promptW) + '╯', C.border));
  }
  
  let composerFirstRow = -1;
  if (!dialog) {
    composerFirstRow = lines.length + 1;
    lines.push(col('╭' + '─'.repeat(insideW) + '╮', C.border));`;

s = s.replace(composerStart, newComposerStart);

fs.writeFileSync('src/tui.js', s, 'utf8');
console.log('✅ Moved approval panel before composer');