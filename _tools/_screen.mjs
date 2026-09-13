// Test helper: reconstruct the visible screen from a raw captured ANSI stream.
// Needed because the interactive renderer is differential — it emits only the
// rows that changed, positioned with `ESC[{row};1H`, rather than whole frames.
export function makeScreen() {
  let rows = 40, cols = 200;
  const grid = [];
  let r = 0, c = 0;
  const ensure = (row) => { while (grid.length <= row) grid.push([]); };
  const put = (ch) => {
    ensure(r);
    const line = grid[r];
    while (line.length < c) line.push(' ');
    line[c] = ch;
    c++;
  };
  const clearRow = (row) => { grid[row] = []; };

  function feed(str) {
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch === '\x1b') {
        // Cursor-shape (DECSCUSR) and other space-terminated sequences: ignore.
        const sc = /^\x1b\[[0-9;?]* q/.exec(str.slice(i));
        if (sc) { i += sc[0].length; continue; }
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(str.slice(i));
        if (!m) { i++; continue; }
        const params = m[1], fin = m[2];
        i += m[0].length;
        if (fin === 'H' || fin === 'f') {
          const parts = params.split(';').map((x) => parseInt(x, 10));
          r = Math.max(0, (parts[0] || 1) - 1);
          c = Math.max(0, (parts[1] || 1) - 1);
        } else if (fin === 'A') { r = Math.max(0, r - (parseInt(params, 10) || 1)); }
        else if (fin === 'B') { r += (parseInt(params, 10) || 1); }
        else if (fin === 'C') { c += (parseInt(params, 10) || 1); }
        else if (fin === 'D') { c = Math.max(0, c - (parseInt(params, 10) || 1)); }
        else if (fin === 'J') {
          const n = parseInt(params, 10) || 0;
          if (n === 2) { for (let k = 0; k < grid.length; k++) clearRow(k); }
          else { clearRow(r); c = 0; for (let k = r + 1; k < grid.length; k++) clearRow(k); }
        } else if (fin === 'K') { clearRow(r); c = 0; }
        continue;
      }
      if (ch === '\n') { r++; c = 0; i++; continue; }
      if (ch === '\r') { c = 0; i++; continue; }
      put(ch);
      i++;
    }
  }
  function text() {
    const out = [];
    for (let k = 0; k < rows; k++) {
      const line = (grid[k] || []).join('').replace(/\s+$/, '');
      out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }
  return { feed, text, setRows: (n) => { rows = n; }, reset: () => { for (let k = 0; k < grid.length; k++) clearRow(k); r = 0; c = 0; } };
}
