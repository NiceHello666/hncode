// Scheduled prompts (/schedule) — a cron-like entry that queues a prompt on a
// running session. Mirrors cline's `schedule` command: a recurring prompt for work
// that happens on a clock rather than because the user asked.
//
// The cron parser is written here rather than pulled in as a dependency, because the
// whole point of the feature is one line of config and a timer — five fields of
// numbers and ranges do not justify a package. It supports exactly the cron subset
// that is useful for a coding session and REJECTS anything it does not understand
// instead of guessing: a schedule that silently never fires is worse than one that
// fails loudly at parse time.
//
// Supported syntax, per field:
//   *      any value
//   5       that value
//   1,3,5   a list
//   1-5     a range
//   */15    a step over the field's range
//   1-30/10 a step over a range
//
// Field order and ranges are the standard five-field form:
//   minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6 (0 = Sun)
//
// Day-of-month and day-of-week are combined with OR when BOTH are restricted, which
// is what cron does (and is the standard source of confusion — a `0 9 1 * 1` entry
// fires on the 1st OR on Mondays, not only on Mondays that are the 1st). That
// behaviour is implemented, and stated in the help text rather than left as folklore.

import fs from 'node:fs';
import path from 'node:path';

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
];

/** Compile one field into a Set of allowed numbers. Throws on anything invalid. */
function parseField(spec, field) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`empty ${field.name} entry`);
    // `base/step` — the base may be `*`, a single value or a range.
    const [base, stepRaw] = piece.split('/');
    let step = 1;
    if (stepRaw !== undefined) {
      step = Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "${stepRaw}" in ${field.name}`);
    }
    let lo;
    let hi;
    if (base === '*') { lo = field.min; hi = field.max; }
    else if (base.includes('-')) {
      const [a, b] = base.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad range "${base}" in ${field.name}`);
    } else {
      lo = Number(base);
      hi = lo;
      if (!Number.isInteger(lo)) throw new Error(`bad value "${base}" in ${field.name}`);
    }
    // A DOW of 7 means Sunday in several cron implementations. Folding it to 0 must
    // happen BEFORE the range tests: folding `hi` first made the single value `7`
    // satisfy `hi < lo` (0 < 7) and be rejected as a backwards range.
    const isDow = field.name === 'dow';
    const foldDow = (v) => (isDow && v === 7 ? 0 : v);
    if (isDow) {
      // Validate against the ALLOWED range (0-7) before folding, so `8` is still
      // rejected while `7` is accepted.
      if (lo < field.min || lo > field.max + 1 || hi > field.max + 1) {
        throw new Error(`${field.name} "${piece}" is out of range ${field.min}-${field.max}`);
      }
    } else if (lo < field.min || hi > field.max) {
      throw new Error(`${field.name} "${piece}" is out of range ${field.min}-${field.max}`);
    }
    if (hi < lo) throw new Error(`${field.name} range "${base}" runs backwards`);
    // A range ENDING at 7 covers Sunday, so the fold cannot just remap both ends to
    // 0 — `0-7` would become `0-0` and lose six days. Iterate the original range and
    // fold each VALUE instead.
    for (let v = lo; v <= hi; v += step) out.add(foldDow(v));
  }
  return out;
}

/**
 * Compile a cron expression. Returns a matcher with
 * `{ fields, matches(date), describe(), restricted }`, or throws with a message
 * naming the field that is wrong.
 */
export function parseCron(expr) {
  const parts = String(expr == null ? '' : expr).trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const fields = {};
  for (let i = 0; i < FIELDS.length; i++) {
    fields[FIELDS[i].name] = parseField(parts[i], FIELDS[i]);
  }
  // Which fields were written as `*`: the OR rule for dom/dow only applies when BOTH
  // are restricted, so the distinction has to survive parsing.
  const restricted = {
    dom: parts[2].trim() !== '*',
    dow: parts[4].trim() !== '*',
  };
  return {
    fields,
    restricted,
    expr: parts.join(' '),
    matches(date) {
      const d = date || new Date();
      if (!fields.minute.has(d.getMinutes())) return false;
      if (!fields.hour.has(d.getHours())) return false;
      if (!fields.month.has(d.getMonth() + 1)) return false;
      const domHit = fields.dom.has(d.getDate());
      const dowHit = fields.dow.has(d.getDay());
      // Standard cron: when both day fields are restricted, either may match.
      if (restricted.dom && restricted.dow) return domHit || dowHit;
      if (restricted.dom) return domHit;
      if (restricted.dow) return dowHit;
      return true;
    },
  };
}

/** `0 9 * * 1-5` -> `weekdays at 09:00`. A readable gloss when the shape is known. */
export function describeCron(expr) {
  const text = String(expr || '').trim();
  const named = {
    '0 9 * * 1-5': 'weekdays at 09:00',
    '0 18 * * 1-5': 'weekdays at 18:00',
    '*/30 * * * *': 'every 30 minutes',
    '0 * * * *': 'every hour, on the hour',
    '0 0 * * *': 'daily at midnight',
  };
  return named[text] || text;
}

/** Validate a schedule entry's fields. Returns { ok, error }. */
export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'not a table' };
  if (!String(entry.prompt || '').trim()) return { ok: false, error: 'prompt is required' };
  try {
    parseCron(entry.cron || entry.at);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, error: '' };
}

/** Normalise the config table into a list with stable ids. */
export function listSchedules(schedule) {
  const table = schedule && typeof schedule === 'object' ? schedule : {};
  return Object.entries(table).map(([id, e]) => ({
    id,
    cron: String((e && (e.cron || e.at)) || '').trim(),
    prompt: String((e && e.prompt) || ''),
    enabled: !(e && e.enabled === false),
    cwd: (e && e.cwd) || '',
    lastRun: (e && e.last_run) || null,
    valid: validateEntry(e).ok,
    error: validateEntry(e).error,
  }));
}

/**
 * Which entries are DUE now.
 *
 * The rule is "the schedule matches this minute and it has not already run in this
 * minute". Both halves matter: a timer that ticks twice within one minute (which
 * happens when the process was busy, or when the tick lands on a minute boundary)
 * must not fire the same entry twice, and a session that was closed over the due
 * minute must not fire a burst of catch-up prompts on the next launch — a schedule
 * is not a queue of missed work.
 */
export function dueSchedules(schedule, now) {
  const d = now || new Date();
  const minuteKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}T${d.getHours()}:${d.getMinutes()}`;
  const out = [];
  for (const e of listSchedules(schedule)) {
    if (!e.enabled || !e.valid) continue;
    let matcher;
    try { matcher = parseCron(e.cron); } catch { continue; }
    if (!matcher.matches(d)) continue;
    if (e.lastRun === minuteKey) continue;
    out.push({ ...e, minuteKey });
  }
  return out;
}

/**
 * The schedule table with the given entries marked as run in this minute.
 *
 * Kept for callers that keep their history IN the config (the panel shows it either
 * way); the TUI uses the side file (see writeHistory) because rewriting the user's
 * whole config.toml once a minute is not acceptable.
 */
export function markRun(schedule, ids, minuteKey) {
  const out = { ...(schedule && typeof schedule === 'object' ? schedule : {}) };
  for (const id of ids) {
    if (!out[id]) continue;
    out[id] = { ...out[id], last_run: minuteKey };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------
// `last_run` cannot live in config.toml: the schedules are HAND-WRITTEN tables, and
// rewriting that file on every fire is both risky (it holds the user's whole
// configuration) and wrong in kind (a run record is state, not configuration). So the
// history is a separate small JSON file beside the config, keyed by entry id.
//
// It is also what makes "once per due minute" survive a RESTART: without a record on
// disk, a session closed and reopened within the same minute would fire the entry a
// second time.

/** Where the run history lives — beside the config, so a test HOME gets its own. */
export function historyFile(configFile) {
  return path.join(path.dirname(String(configFile)), 'schedule-state.json');
}

/** Read the run history. A missing or corrupt file reads as empty; never throws. */
export function readHistory(configFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile(configFile), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** Write the run history. Best-effort: a failed write must not drop the work. */
export function writeHistory(configFile, history) {
  try {
    fs.mkdirSync(path.dirname(historyFile(configFile)), { recursive: true });
    fs.writeFileSync(historyFile(configFile), JSON.stringify(history, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** `2026-9-30T9:5` — LOCAL time, since a cron expression is local by definition. */
export function minuteKeyOf(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}T${d.getHours()}:${d.getMinutes()}`;
}

/**
 * Which entries are due, consulting BOTH the config and the persisted history.
 *
 * Kept beside `dueSchedules` rather than replacing it, so the pure matching rule stays
 * testable without a filesystem.
 */
export function dueWithHistory(schedule, history, now) {
  const d = now || new Date();
  const minuteKey = minuteKeyOf(d);
  const out = [];
  for (const e of listSchedules(schedule)) {
    if (!e.enabled || !e.valid) continue;
    let matcher;
    try { matcher = parseCron(e.cron); } catch { continue; }
    if (!matcher.matches(d)) continue;
    const last = (history && history[e.id]) || e.lastRun || '';
    if (last === minuteKey) continue;
    out.push({ ...e, minuteKey });
  }
  return out;
}

/** Panel lines for /schedule — history included when it is available. */
export function describeSchedules(schedule, history) {
  const rows = listSchedules(schedule);
  if (!rows.length) {
    return [
      'No schedules. Add one to config.toml:',
      '',
      '  [schedule.morning]',
      '  cron = "0 9 * * 1-5"           # weekdays at 09:00',
      '  prompt = "Check the open PRs and post a summary"',
      '  enabled = true                  # optional, default true',
    ].join('\n');
  }
  return rows.map((e) => {
    const state = !e.enabled ? 'off' : e.valid ? 'on ' : 'BAD';
    const when = e.valid ? describeCron(e.cron) : `INVALID: ${e.error}`;
    const last = (history && history[e.id]) || e.lastRun || '';
    return `${state} ${e.id.padEnd(16)} ${when.padEnd(26)} ${e.prompt.slice(0, 44)}${last ? `  last ${last}` : ''}`;
  }).join('\n');
}

export default {
  parseCron, describeCron, validateEntry, listSchedules, dueSchedules, markRun,
  describeSchedules, dueWithHistory, readHistory, writeHistory, historyFile, minuteKeyOf,
};
