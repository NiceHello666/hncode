

import { t, catalog, LANGUAGES, DEFAULT_LANG } from './i18n.js';

let LANG = DEFAULT_LANG;
try {
  const saved = localStorage.getItem('hncode.lang');
  if (saved && LANGUAGES.some((l) => l.id === saved)) LANG = saved;
} catch {}
const T = catalog(LANG);
const tr = (key) => T[key] || key;

document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = tr(el.getAttribute('data-i18n'));
}

const form = document.getElementById('f');
const input = document.getElementById('t');
const err = document.getElementById('err');

function fail(msg) {
  err.textContent = msg;
  err.hidden = false;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  err.hidden = true;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: input.value.trim() }),
    });
    if (res.ok) { location.replace('/'); return; }
    const body = await res.json().catch(() => ({}));
    fail(body.error === 'invalid token' ? tr('login.badToken') : (body.error || tr('login.failed')));
  } catch (e) {
    fail(tr('login.unreachable') + e.message);
  } finally {
    btn.disabled = false;
  }
});
