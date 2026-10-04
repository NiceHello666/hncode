


const MAX_ITEMS = 50;

export class Completer {

  constructor(input, box, opts) {
    this.input = input;
    this.box = box;
    this.getCommands = opts.getCommands || (() => []);
    this.getFiles = opts.getFiles || (() => []);
    this.onAccept = opts.onAccept || (() => {});
    this.onSubmit = opts.onSubmit || (() => {});
    this.items = [];
    this.sel = 0;
    this.mode = null;
    this.query = '';
    this.range = { start: 0, end: 0 };
  }

  get open() { return this.mode !== null; }

  refresh() {
    const value = this.input.value;
    const caret = this.input.selectionStart == null ? value.length : this.input.selectionStart;
    const hit = detect(value, caret);

    if (!hit) { this.close(); return; }
    this.mode = hit.mode;
    this.query = hit.query;
    this.range = { start: hit.start, end: caret };

    const all = hit.mode === 'command' ? this.getCommands() : this.getFiles();
    this.items = filterItems(all, hit, MAX_ITEMS);
    if (!this.items.length) { this.close(); return; }

    this.sel = Math.min(this.sel, this.items.length - 1);
    this.render();
  }

  close() {
    this.mode = null;
    this.items = [];
    this.sel = 0;
    this.box.hidden = true;
    this.box.textContent = '';
  }

  move(delta) {
    if (!this.open || !this.items.length) return false;
    this.sel = (this.sel + delta + this.items.length) % this.items.length;
    this.render();
    return true;
  }

  accept() {
    if (!this.open || !this.items.length) return false;
    const it = this.items[this.sel];
    const insert = this.mode === 'command' ? '/' + it.name : '@' + it.rel;

    const suffix = this.mode === 'command' ? ' ' : '';
    const value = this.input.value;
    const next = value.slice(0, this.range.start) + insert + suffix + value.slice(this.range.end);
    const caret = this.range.start + insert.length + suffix.length;
    this.close();
    this.onAccept(next, caret);
    return true;
  }

  run() {
    if (!this.open || !this.items.length) return false;
    const it = this.items[this.sel];
    if (this.mode === 'command') {
      this.close();
      this.onSubmit('/' + it.name);
      return true;
    }
    return this.accept();
  }

  render() {
    const box = this.box;
    box.textContent = '';
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const row = document.createElement('div');
      row.className = 'comp-item' + (i === this.sel ? ' is-sel' : '');
      const name = document.createElement('span');
      name.className = 'comp-name';
      name.textContent = this.mode === 'command' ? '/' + it.name : it.rel;
      row.appendChild(name);
      const meta = this.mode === 'command'
        ? [it.argumentHint, it.desc].filter(Boolean).join('  ')
        : (it.isDir ? 'directory' : '');
      if (meta) {
        const sub = document.createElement('span');
        sub.className = 'comp-sub';
        sub.textContent = meta;
        row.appendChild(sub);
      }
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        this.sel = i;
        this.run();
      });
      box.appendChild(row);
    }
    box.hidden = false;
    const sel = box.children[this.sel];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
}

export function detect(value, caret) {
  const v = String(value == null ? '' : value);
  const c = Math.max(0, Math.min(v.length, caret == null ? v.length : caret));
  let start = c;
  while (start > 0 && !/\s/.test(v[start - 1])) start--;
  const token = v.slice(start, c);
  if (!token) return null;
  if (token[0] === '/') return { mode: 'command', query: token.slice(1), start, token };
  if (token[0] === '@') return { mode: 'file', query: token.slice(1), start, token };
  return null;
}

export function filterItems(all, hit, limit = MAX_ITEMS) {
  const q = String(hit.query || '').toLowerCase();
  const out = [];
  if (hit.mode === 'command') {
    for (const it of all || []) {
      if (!it || !it.name) continue;
      const name = String(it.name).toLowerCase();

      const aliasHit = (it.aliases || []).some((a) => String(a).toLowerCase().startsWith(q));
      if (q && !name.startsWith(q) && !aliasHit) continue;

      out.push({ rank: q && name.startsWith(q) ? 0 : 1, it });
    }
  } else {
    for (const it of all || []) {
      if (!it || !it.rel) continue;
      const rel = String(it.rel).toLowerCase();
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (q && !rel.includes(q)) continue;

      const rank = (q && base.startsWith(q) ? 0 : 1) + (it.isDir ? 0 : 0.5);
      out.push({ rank, it });
    }
  }
  out.sort((a, b) => a.rank - b.rank
    || String(a.it.name || a.it.rel).length - String(b.it.name || b.it.rel).length);
  return out.slice(0, limit).map((x) => x.it);
}
