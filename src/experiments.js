// Feature flags for work that is not finished enough to be on for everyone.
//
// Why this exists instead of "just leave it off in the code": an unfinished feature
// needs to be EXERCISED, by the person building it and by anyone willing to help,
// against real sessions. Commenting it out means it is only ever tested on the
// branch where it was written. A named flag also makes the risk legible — `/experiments`
// lists what is on, and `hncode.experiments` records it, so a bug report can say
// which combination produced it.
//
// Scope rules:
//   * OFF unless turned on. A flag whose default is "on" is not an experiment, it
//     is a release.
//   * A flag that no code reads is a bug, not a no-op: `pruneUnknown()` exists so
//     the list cannot silently rot, and the test asserts every declared flag is
//     referenced somewhere in src/.
//   * Turning a flag off must leave no residue. `applyExperiments()` is therefore
//     called on every reload and is idempotent.

/**
 * The registry. Each entry is a flag with a one-line reason it exists — a flag with
 * no explanation is indistinguishable from a mistake, and this list is what
 * `/experiments` shows.
 */
export const EXPERIMENTS = {
  'parallel-tools': {
    default: false,
    desc: 'Run independent tool calls from one model turn concurrently',
    since: '0.5.0',
  },
  'prompt-cache-hints': {
    default: false,
    desc: 'Send cache_control breakpoints on long stable prefixes (Anthropic)',
    since: '0.5.0',
  },
  'shell-parser-strict': {
    default: false,
    desc: 'Refuse to run a shell command the classifier cannot fully parse',
    since: '0.5.0',
  },
};

/** Is `name` a declared flag? */
export function isExperiment(name) {
  return Object.prototype.hasOwnProperty.call(EXPERIMENTS, String(name == null ? '' : name).trim());
}

/**
 * The flag state from config plus the environment.
 *
 * `HNCODE_EXPERIMENTS=a,b` enables without touching config.toml — the escape hatch a
 * test or a one-off run needs. Config wins when both are present, because config is
 * the thing the user edited deliberately.
 */
export function experimentState(cfg, env = process.env) {
  const out = {};
  for (const [name, spec] of Object.entries(EXPERIMENTS)) out[name] = !!spec.default;
  const fromEnv = String(env.HNCODE_EXPERIMENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of fromEnv) if (isExperiment(name)) out[name] = true;
  const raw = (cfg && ((cfg.raw && cfg.raw.experiments) ?? cfg.experiments)) || {};
  if (raw && typeof raw === 'object') {
    for (const [name, v] of Object.entries(raw)) {
      if (isExperiment(name)) out[name] = v === true || v === 'true' || v === 'on';
    }
  }
  return out;
}

/** Just the enabled names, sorted — what a panel or a log line shows. */
export function enabledExperiments(cfg, env) {
  const st = experimentState(cfg, env);
  return Object.keys(st).filter((k) => st[k]).sort();
}

/**
 * Merge new flag values into a config's raw table, returning the table to persist.
 *
 * Written as a pure function of (current, changes) so the caller does not have to
 * know how the config is shaped, and so the "turn one off" direction is testable:
 * an explicit `false` is KEPT (it records a deliberate choice), while an unknown
 * name is dropped rather than written into the file.
 */
export function mergeExperiments(current, changes) {
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  for (const [name, v] of Object.entries(changes || {})) {
    if (!isExperiment(name)) continue;
    if (v === undefined) delete out[name];
    else out[name] = v === true || v === 'true' || v === 'on';
  }
  return out;
}

/**
 * Drop names that are no longer flags, so a config does not accumulate entries for
 * features that were removed or renamed. Returns { kept, dropped }.
 */
export function pruneUnknown(current) {
  const kept = {};
  const dropped = [];
  for (const [name, v] of Object.entries(current && typeof current === 'object' ? current : {})) {
    if (isExperiment(name)) kept[name] = v;
    else dropped.push(name);
  }
  return { kept, dropped };
}

/** Panel lines for `/experiments`. */
export function describeExperiments(state) {
  const rows = [];
  for (const [name, spec] of Object.entries(EXPERIMENTS)) {
    rows.push({
      name,
      on: !!(state && state[name]),
      desc: spec.desc,
      since: spec.since,
      defaultOn: !!spec.default,
    });
  }
  return rows;
}

export default { EXPERIMENTS, experimentState, enabledExperiments, mergeExperiments, pruneUnknown, describeExperiments, isExperiment };
