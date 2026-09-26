

import { t, catalog, LANGUAGES, DEFAULT_LANG } from './i18n.js';

let LANG = DEFAULT_LANG;
try {
  const saved = localStorage.getItem('hncode.lang');
  if (saved && LANGUAGES.some((l) => l.id === saved)) LANG = saved;
} catch {}
let T = catalog(LANG);
const tr = (key, vars) => {
  let s = T[key] || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
};

function applyStatic() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = tr(el.getAttribute('data-i18n'));
  }
}

// Language switcher in the header, mirroring the app's buildLangSwitch: one
// button per installed language; clicks update the module LANG, the localStorage
// preference (shared with the app so a choice here carries over) and re-render
// the static strings.
function buildLangSwitch() {
  const box = document.getElementById('lang-switch');
  if (!box) return;
  box.replaceChildren();
  box.title = tr('nav.language');
  for (const l of LANGUAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.label;
    b.className = l.id === LANG ? 'is-on' : '';
    b.addEventListener('click', () => {
      if (l.id === LANG) return;
      LANG = l.id;
      T = catalog(LANG);
      try { localStorage.setItem('hncode.lang', LANG); } catch {}
      buildLangSwitch();
      applyStatic();
    });
    box.appendChild(b);
  }
}

const groupsEl = document.getElementById('groups');
const errEl = document.getElementById('err');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleString();
  const min = Math.floor(diff / 60000);
  if (min < 1) return tr('home.justNow');
  if (min < 60) return tr('home.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return tr('home.hoursAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return tr('home.daysAgo', { n: day });
  return new Date(ms).toLocaleDateString();
}

function sessionRow(s, live) {
  const a = el('a', 'row');
  a.href = `/s/${encodeURIComponent(s.id)}/`;

  const titleCell = el('div');
  titleCell.appendChild(el('span', 'row-title', s.title || tr('home.untitled')));
  titleCell.appendChild(el('span', 'row-id', s.id));
  titleCell.appendChild(el('span', 'tag ' + (live ? 'tag-live' : 'tag-ro'),
    live ? tr('home.live') : tr('home.readonly')));
  a.appendChild(titleCell);

  a.appendChild(el('div', 'row-when', relTime(s.at || s.updatedAt)));
  a.appendChild(el('div', 'row-rounds', s.rounds ? String(s.rounds) : ''));
  return a;
}

function render(live, saved) {
  groupsEl.textContent = '';
  const liveIds = new Set(live.map((s) => s.id));

  const byWs = new Map();
  const push = (ws, item) => {
    const key = ws || tr('home.noWorkspace');
    if (!byWs.has(key)) byWs.set(key, []);
    byWs.get(key).push(item);
  };
  for (const s of live) push(s.workspace, { s, live: true });
  for (const s of saved) {
    if (liveIds.has(s.id)) continue;
    push(s.workspace, { s, live: false });
  }

  if (!byWs.size) {
    groupsEl.appendChild(el('p', 'empty', tr('home.empty')));
    return;
  }

  const entries = [...byWs.entries()].map(([ws, items]) => ({
    ws,
    items,
    anyLive: items.some((i) => i.live),
    newest: Math.max(0, ...items.map((i) => i.s.at || i.s.updatedAt || 0)),
  }));
  entries.sort((a, b) => (b.anyLive - a.anyLive) || (b.newest - a.newest));

  for (const g of entries) {
    const sec = el('section', 'group');
    const head = el('div', 'group-head');
    head.appendChild(el('span', 'ws', g.ws));
    head.appendChild(el('span', 'count', tr('home.sessionCount', { n: g.items.length })));
    sec.appendChild(head);
    const rows = el('div', 'rows');
    for (const it of g.items) rows.appendChild(sessionRow(it.s, it.live));
    sec.appendChild(rows);
    groupsEl.appendChild(sec);
  }
}

let timer = null;

async function load() {
  try {
    const res = await fetch('api/sessions');
    if (res.status === 401) { location.replace('/login'); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    errEl.hidden = true;
    render(data.live || [], data.saved || []);
  } catch (e) {
    errEl.textContent = tr('home.loadFailed') + e.message;
    errEl.hidden = false;
  }
}

document.getElementById('refresh').addEventListener('click', () => { void load(); });

document.getElementById('logout').addEventListener('click', () => {
  document.cookie = 'hncode_web=; Max-Age=0; Path=/';
  location.replace('/login');
});

  buildLangSwitch();
  applyStatic();
void load();

timer = setInterval(() => { void load(); }, 5000);
window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); });
