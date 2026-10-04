// Currency conversion for the cost readout, so /cost can report in CNY as well
// as USD. Prices from models.dev are USD per 1M tokens; a Chinese user wants to
// see what that came to in ￥, and doing that by hand every time is the reason
// nobody looks at the number.
//
// Three ways to get the rate, in order:
//   1. an explicit override — `cny_per_usd` in config.toml, or HNCODE_CNY_PER_USD
//      in the environment. Checked first and used with NO network call, so a
//      machine without internet still reports a correct ￥ figure.
//   2. a live fetch from a keyless reference-rate API, memoized for HOURS: the
//      rate moves a fraction of a percent a day, and this only feeds a readout.
//   3. nothing. The caller then says the rate is unavailable rather than
//      converting with a guessed 7.0, which would be wrong in a way the user
//      cannot see.
//
// Endpoints are tried in order because neither is guaranteed: frankfurter
// republishes ECB reference rates (stable, but ECB-only currencies), and
// open.er-api.com covers more currencies without a key.

const TTL_MS = 6 * 60 * 60 * 1000;

// currency -> { rate, source, at }. A plain Map, so a test can inspect or clear it.
const cache = new Map();

/** Currencies /cost accepts. USD is the native one (models.dev prices in it). */
export const SUPPORTED_CURRENCIES = ['USD', 'CNY'];

/** `'cny'`/`'￥'` -> `'CNY'`; returns '' when unrecognised. */
export function normalizeCurrency(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase();
  if (!s) return '';
  if (s === '¥' || s === '￥' || s === 'RMB' || s === 'YUAN') return 'CNY';
  if (s === '$' || s === 'USD' || s === 'US$') return 'USD';
  return SUPPORTED_CURRENCIES.includes(s) ? s : '';
}

/**
 * Pull the USD->`currency` rate out of either API's response shape:
 *   frankfurter      { amount: 1, base: 'USD', rates: { CNY: 6.70 } }
 *   open-er-api      { result: 'success', base_code: 'USD', conversion_rates: { CNY: 7.12 } }
 * Returns a positive number, or null when the payload has no usable rate.
 */
export function parseRate(json, currency = 'CNY') {
  if (!json || typeof json !== 'object') return null;
  const key = normalizeCurrency(currency) || 'CNY';
  const table = json.rates || json.conversion_rates;
  if (!table || typeof table !== 'object') return null;
  const raw = table[key];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** USD -> `currency` at `rate`. Null when either input is unusable. */
export function convert(usd, currency, rate) {
  const amount = Number(usd);
  if (!Number.isFinite(amount)) return null;
  const cur = normalizeCurrency(currency) || 'USD';
  if (cur === 'USD') return amount;               // no rate needed
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return null;
  return amount * r;
}

/** The `<CUR>_PER_USD` env override, or null. Both the short and prefixed names. */
export function envRate(currency) {
  const cur = normalizeCurrency(currency);
  if (!cur || cur === 'USD') return null;
  for (const key of [`HNCODE_${cur}_PER_USD`, `HNCODE_${cur}_RATE`]) {
    const n = Number(process.env[key]);
    if (Number.isFinite(n) && n > 0) return { rate: n, source: key };
  }
  return null;
}

const ENDPOINTS = [
  { source: 'frankfurter (ECB)', url: (cur) => `https://api.frankfurter.app/latest?from=USD&to=${cur}` },
  { source: 'open.er-api.com', url: () => 'https://open.er-api.com/v6/latest/USD' },
];

/**
 * USD -> `currency` rate.
 *
 * `opts.override` is a user-set rate (config.toml); it wins over the network.
 * `opts.timeoutMs` bounds each request. Returns
 * `{ rate, source, at }`, or null when nothing could supply one.
 */
export async function usdRate(currency, opts = {}) {
  const cur = normalizeCurrency(currency);
  if (!cur || cur === 'USD') return { rate: 1, source: 'native', at: Date.now() };

  const override = Number(opts.override);
  if (Number.isFinite(override) && override > 0) return { rate: override, source: 'config', at: Date.now() };
  const fromEnv = envRate(cur);
  if (fromEnv) return { ...fromEnv, at: Date.now() };

  const hit = cache.get(cur);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  for (const ep of ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000);
      let json;
      try {
        const res = await fetch(ep.url(cur), { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) continue;
        json = await res.json();
      } finally {
        clearTimeout(timer);
      }
      const rate = parseRate(json, cur);
      if (rate) {
        const entry = { rate, source: ep.source, at: Date.now() };
        cache.set(cur, entry);
        return entry;
      }
    } catch { /* offline or blocked: try the next endpoint */ }
  }
  return null;
}

/**
 * The rate WITHOUT touching the network: an explicit override, the environment,
 * or a still-fresh memoized value. Returns null when the answer would require a
 * request.
 *
 * This exists because the status row is drawn from a SYNCHRONOUS render function,
 * which cannot await a fetch. The rate therefore has to be warmed ahead of time
 * (see the TUI's startup and /cost) and read here; a missing rate means the row
 * falls back to USD rather than blocking or showing a converted guess.
 */
export function syncRate(currency, opts = {}) {
  const cur = normalizeCurrency(currency);
  if (!cur) return null;
  if (cur === 'USD') return { rate: 1, source: 'native', at: Date.now() };
  const override = Number(opts.override);
  if (Number.isFinite(override) && override > 0) return { rate: override, source: 'config', at: Date.now() };
  const fromEnv = envRate(cur);
  if (fromEnv) return { ...fromEnv, at: Date.now() };
  const hit = cache.get(cur);
  return (hit && Date.now() - hit.at < TTL_MS) ? hit : null;
}


/** Drop the memoized rates (tests, and a manual refresh). */
export function clearRateCache() { cache.clear(); }

export default { usdRate, syncRate, convert, parseRate, normalizeCurrency, envRate, clearRateCache, SUPPORTED_CURRENCIES };
