

const $ = (id) => document.getElementById(id);

export class SettingsPanel {

  constructor(opts) {
    this.act = opts.act;
    this.getStatus = opts.getStatus;
    this.tr = opts.tr;
    this.toast = opts.toast || (() => {});
    this.providers = [];
    this.known = [];
    this.loaded = false;
  }

  get open() { return !$('settings').hidden; }

  show() {
    $('settings').hidden = false;
    const st = this.getStatus() || {};
    $('set-title').value = st.title || '';
    $('set-session-id').textContent = st.session || '';

    void this.refreshProviders();
    void this.refreshConfig();
    this.renderPrefs();
  }

  hide() { $('settings').hidden = true; }

  async refreshProviders() {
    const r = await this.act('listProviders', []);
    this.providers = (r && r.result) || [];
    this.renderProviders();
  }

  renderProviders() {
    const box = $('provider-list');
    box.textContent = '';
    if (!this.providers.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = this.tr('settings.noProviders');
      box.appendChild(p);
      return;
  }
    for (const p of this.providers) {
      const row = document.createElement('div');
      row.className = 'set-item';

      const name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = p.name;
      row.appendChild(name);

      const tag = document.createElement('span');
      tag.className = 'set-tag' + (p.keySet ? '' : ' off');
      tag.textContent = p.keySet ? this.tr('settings.tagKey') : this.tr('settings.tagNoKey');
      row.appendChild(tag);

      const sub = document.createElement('span');
      sub.className = 'set-sub';
      sub.textContent = `${p.protocol} · ${p.baseUrl || this.tr('settings.noUrl')} · ${this.tr('settings.modelCount', { n: p.models.length })}`;
      sub.title = p.baseUrl || '';
      row.appendChild(sub);

      const disc = document.createElement('button');
      disc.className = 'set-act';
      disc.type = 'button';
      disc.textContent = this.tr('settings.discover');
      disc.addEventListener('click', async () => {
        disc.disabled = true;
        try {
          const r = await this.act('discoverModels', [p.name]);
          const n = (r && r.result && r.result.found) || 0;
          this.toast(this.tr('settings.foundModels', { n }), 'info');
          await this.refreshProviders();
        } catch (e) {
          this.toast(this.tr('settings.failed') + e.message, 'error');
        } finally {
          disc.disabled = false;
        }
      });
      row.appendChild(disc);

      const del = document.createElement('button');
      del.className = 'set-act danger';
      del.type = 'button';
      del.textContent = this.tr('settings.remove');
      del.addEventListener('click', async () => {
        if (!confirm(this.tr('settings.confirmRemove', { name: p.name }))) return;
        try {
          await this.act('removeProvider', [p.name]);
          this.toast(this.tr('settings.removed', { name: p.name }), 'info');
          await this.refreshProviders();
        } catch (e) {
          this.toast(this.tr('settings.failed') + e.message, 'error');
        }
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  async addProvider() {
    const name = $('np-name').value.trim();
    const url = $('np-url').value.trim();
    const key = $('np-key').value;
    const proto = $('np-proto').value;
    if (!name) { this.toast(this.tr('settings.nameRequired'), 'error'); return; }
    try {
      await this.act('addProvider', [name, url, key, proto]);
      $('np-name').value = '';
      $('np-url').value = '';
      $('np-key').value = '';
      this.toast(this.tr('settings.added', { name }), 'info');
      await this.refreshProviders();
      await this.refreshConfig();
    } catch (e) {
      this.toast(this.tr('settings.failed') + e.message, 'error');
    }
  }

  async toggleKnown() {
    const box = $('known-list');
    if (!box.hidden) { box.hidden = true; return; }
    if (!this.known.length) {
      try {
        this.known = (await this.act('listKnownProviders', [])).result || [];
      } catch (e) {
        this.toast(this.tr('settings.failed') + e.message, 'error');
        return;
      }
    }
    box.hidden = false;
    this.renderKnown('');
  }

  renderKnown(filter) {
    const box = $('known-list');
    box.textContent = '';
    const q = String(filter || '').toLowerCase();
    const hits = this.known.filter((p) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (!hits.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = this.tr('settings.noMatch');
      box.appendChild(p);
      return;
    }
    for (const p of hits.slice(0, 60)) {
      const row = document.createElement('div');
      row.className = 'set-item';
      const name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = p.name;
      row.appendChild(name);
      const sub = document.createElement('span');
      sub.className = 'set-sub';
      sub.textContent = p.api;
      sub.title = p.api;
      row.appendChild(sub);
      const add = document.createElement('button');
      add.className = 'set-act';
      add.type = 'button';
      add.textContent = this.tr('settings.import');
      add.addEventListener('click', async () => {
        const key = prompt(this.tr('settings.keyPrompt', { name: p.name }), '');
        if (key === null) return;
        add.disabled = true;
        try {
          const r = await this.act('importKnownProvider', [p.id, p.id, key]);
          const n = (r && r.result && r.result.added) || 0;
          this.toast(this.tr('settings.imported', { name: p.name, n }), 'info');
          await this.refreshProviders();
          await this.refreshConfig();
        } catch (e) {
          this.toast(this.tr('settings.failed') + e.message, 'error');
        } finally {
          add.disabled = false;
        }
      });
      row.appendChild(add);
      box.appendChild(row);
    }
  }

  renderPrefs() {
    const box = $('pref-list');

    if (!this.cfgKeys) this.cfgKeys = [];
    box.textContent = '';
    const PREFS = [
      ['calm_mode', 'pref.calm'],
      ['auto_compact', 'pref.autoCompact'],
      ['auto_update', 'pref.autoUpdate'],
      ['prompt_cache', 'pref.promptCache'],
      ['tool_allow_external_paths', 'pref.external'],
    ];
    for (const [key, label] of PREFS) {
      const row = document.createElement('div');
      row.className = 'set-item';
      const name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = this.tr(label);
      row.appendChild(name);
      const sel = document.createElement('select');
      sel.className = 'set-select';
      for (const v of ['on', 'off']) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      }
      const cur = String(this.cfgKeys[key] ? 'on' : 'off');
      sel.value = cur;
      sel.addEventListener('change', async () => {
        try {
          await this.act('setConfig', [key, sel.value === 'on' ? 'true' : 'false']);
          this.toast(`${this.tr(label)} → ${sel.value}`, 'info');
          await this.refreshConfig();
        } catch (e) {
          this.toast(this.tr('settings.failed') + e.message, 'error');
          sel.value = cur;
        }
      });
      row.appendChild(sel);
      box.appendChild(row);
    }
  }

  async refreshConfig() {
    try {
      const r = await this.act('getConfig', []);
      const c = (r && r.result) || {};
      this.cfgKeys = c;
      const dl = $('cfg-view');
      dl.textContent = '';
      const rows = [
        ['settings.model', c.model],
        ['settings.provider', c.provider],
        ['settings.protocol', c.protocol],
        ['settings.endpoint', c.endpoint],
        ['settings.key', c.apiKeySet ? this.tr('settings.valSet') : this.tr('settings.valNotSet')],
        ['settings.workspace', c.workspace],
        ['settings.ctx', String(c.maxContextTokens || '')],
      ];
      for (const [k, v] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = this.tr(k);
        const dd = document.createElement('dd');
        dd.className = 'mono ellip';
        dd.textContent = v == null || v === '' ? '—' : String(v);
        dd.title = dd.textContent;
        dl.append(dt, dd);
      }
      this.renderPrefs();
    } catch (e) {
      this.toast(this.tr('settings.failed') + e.message, 'error');
    }
  }

  async saveTitle() {
    const t = $('set-title').value.trim();
    if (!t) { this.toast(this.tr('settings.nameRequired'), 'error'); return; }
    try {
      await this.act('setTitle', [t]);
      this.toast(this.tr('settings.titleSaved'), 'info');
    } catch (e) {
      this.toast(this.tr('settings.failed') + e.message, 'error');
    }
  }
}

export function attachSettings(panel) {
  $('btn-settings').addEventListener('click', () => panel.show());
  $('settings-close').addEventListener('click', () => panel.hide());

  $('settings').addEventListener('mousedown', (ev) => {
    if (ev.target === $('settings')) panel.hide();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && panel.open) panel.hide();
  });
  $('set-title-save').addEventListener('click', () => { void panel.saveTitle(); });
  $('np-add').addEventListener('click', () => { void panel.addProvider(); });
  $('imp-known').addEventListener('click', () => { void panel.toggleKnown(); });
  $('imp-filter').addEventListener('input', () => panel.renderKnown($('imp-filter').value));
}
