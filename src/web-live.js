// Waking a saved session so the daemon can run it with no terminal anywhere.
//
// This is what replaces the blanket 409 the daemon used to answer every action with: a saved
// session was readable and nothing else, which makes the web UI a viewer rather than a client.
//
// WHAT IT NEEDS AND WHERE IT COMES FROM
// -------------------------------------
// A live session is `state` + `cfg` + `session` plus two objects that already exist:
//
//   SessionHost  the stream buffer, the transcript recorder, the message shape
//   SessionCore  submit / dispatch / interrupt / queue
//
// The daemon can build all four itself. What it CANNOT build is `runAgent` — the 1024-line turn
// loop, which still lives inside the TUI's closure and reaches for `state.scroll`, `beginTurn`
// and the git badge. That one function is injected by the TUI module, which is why the daemon
// asks for it rather than importing it at the top.
import * as sess from './session.js';
import { resolveConfig } from './config.js';
import { SessionHost } from './session-host.js';
import { SessionCore } from './session-core.js';
import { HEADLESS_VIEW } from './session-view.js';

const IDLE_MS = 30 * 60 * 1000;

/** Live sessions by id, so a second request does not build a second agent over one conversation. */
const live = new Map();

const fresh = (e) => !!e && (Date.now() - e.at) < IDLE_MS;

/** Forget sessions nobody has touched. Returns how many were dropped. */
export function sweepIdle(now = Date.now()) {
  let n = 0;
  for (const [id, e] of live) if (now - e.at > IDLE_MS) { live.delete(id); n++; }
  return n;
}

export function liveEntry(id) {
  const e = live.get(String(id));
  return fresh(e) ? e : null;
}

export function liveSessionIds() {
  return [...live].filter(([, e]) => fresh(e)).map(([id]) => id);
}

/** Drop a session from memory. Its transcript stays on disk. */
export function sleepSession(id) {
  return live.delete(String(id));
}

/**
 * The turn loop, supplied by whoever built this module's caller.
 *
 * The daemon cannot import `tui.js` for it without loading the entire renderer, and more to the
 * point the loop is not READY to move: it is 1024 lines woven through the paint path. Injecting
 * it keeps the seam honest — when it does move, only this assignment changes.
 */
let runnerFactory = null;

/** Register the source of turn loops. Called once by the TUI module on import. */
export function setRunnerFactory(fn) {
  runnerFactory = typeof fn === 'function' ? fn : null;
}

/**
 * Wake `id`, or hand back the entry already holding it.
 *
 * Never throws: every failure here is something a browser should be told, not a crashed daemon.
 */
export function wakeSession(id, { onEvent, workspace } = {}) {
  const key = String(id || '');
  if (!key) return { ok: false, error: 'no session id' };

  const existing = liveEntry(key);
  if (existing) { existing.at = Date.now(); return { ok: true, entry: existing, reused: true }; }

  let session;
  try { session = sess.loadSession(key); } catch (e) {
    return { ok: false, error: `could not read session ${key}: ${(e && e.message) || e}` };
  }
  if (!session) return { ok: false, error: `no session ${key}` };

  // The session's OWN workspace: a conversation about one project must not start reading another.
  const cwd = workspace || session.workspace || process.cwd();

  let cfg;
  try { cfg = resolveConfig({ workspace: cwd }); } catch (e) {
    return { ok: false, error: `could not resolve config: ${(e && e.message) || e}` };
  }
  // The session records which model it was talking to. A config change since then must not
  // silently move an old conversation onto a different one.
  if (session.model) cfg.model = session.model;

  const state = makeHeadlessState(cfg, session, cwd);
  const view = headlessViewFor(session, state);
  const host = new SessionHost({ state, cfg, session, view });
  const core = new SessionCore({ state, cfg, session, view, host });

  const entry = {
    id: key, session, cfg, state, host, core, view, at: Date.now(),
    listeners: new Set(),
    // The runner is attached below; a first action waits on this so it cannot race the wiring.
    ready: null,
  };

  core.onEvent((e) => {
    entry.at = Date.now();
    for (const fn of entry.listeners) { try { fn(e); } catch { /* one bad socket */ } }
    if (onEvent) { try { onEvent(e); } catch { /* as above */ } }
  });

  entry.ready = attach(entry);

  live.set(key, entry);
  return { ok: true, entry };
}

/**
 * Build the state a headless session runs on.
 *
 * Deliberately NOT `makeState` from tui.js: that seeds twenty fields the renderer needs (panel
 * sizes, drag flags, hover state, the composer) and none of which a headless run reads. The
 * fields below are the ones a turn actually touches.
 */
function makeHeadlessState(cfg, session, cwd) {
  const effort = session.effort || cfg.effort || (cfg.reasoning ? 'on' : 'off');
  return {
    cfg,
    session,
    workspace: cwd,
    cwd,
    provider: cfg.provider || '',
    model: cfg.model || '',
    modelLabel: cfg.model || '',
    mode: session.mode || 'ask',
    reasoning: effort !== 'off',
    effort,
    chat: [],
    queued: [],
    running: false,
    rounds: session.rounds || 0,
    steps: session.steps || 0,
    _stepsBase: 0,
    _turnSteps: 0,
    turnStart: 0,
    lastTurnMs: session.lastTurnMs || 0,
    titleAttempts: 0,
    todos: Array.isArray(session.todos) ? session.todos : [],
    tasks: {},
    ctxTokens: 0,
    ctxPercent: 0,
    ctxMax: cfg.maxContextTokens || 512000,
    tokenHistory: Array.isArray(session.tokenHistory) ? session.tokenHistory : [],
    saveHistory: session.saveHistory !== false,
    saveThinking: session.saveThinking !== false,
    // Read by the turn loop. A session driven from a browser is never the foreground process, so
    // these stay at their resting values and nothing scrolls to follow them.
    scroll: 0,
    agent: null,
    _quit: false,
  };
}

/**
 * The display for a headless run: nothing is drawn, and the transcript is what gets synced.
 *
 * `syncChat` is the one method that must do real work — it is how the browser sees the turn — and
 * everything else is the no-op it looks like.
 */
function headlessViewFor(session, state) {
  return {
    ...HEADLESS_VIEW,
    syncChat: (chat) => { if (Array.isArray(chat)) session.messages = chat.slice(); },
    // The turn loop reads the window size when it wraps prose. A browser has no terminal, and
    // reporting zero would divide by it.
    dims: () => ({ cols: 100, rows: 30 }),
  };
}

/** Ask the injected factory for the turn loop and bind it to the entry. */
async function attach(entry) {
  if (!runnerFactory) {
    return { ok: false, error: 'no headless runner is registered in this process' };
  }
  try {
    const bound = await runnerFactory(entry);
    entry.core.bind(bound);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Run an action against a session, waking it first.
 *
 * The action names and argument shapes are the same ones a live session's `/api/action` accepts,
 * so the browser needs no special case — the only difference is that the first call pays for a
 * resume.
 */
export async function actionOn(id, name, args = [], opts = {}) {
  const woken = wakeSession(id, opts);
  if (!woken.ok) return { ok: false, error: woken.error, status: 404 };
  const { entry } = woken;

  const ready = await entry.ready;
  if (!ready || ready.ok === false) {
    return { ok: false, error: (ready && ready.error) || 'the session runner is unavailable', status: 500 };
  }

  try {
    if (name === 'submit') await entry.core.submit(args[0]);
    else if (name === 'dispatch') await entry.core.dispatch(args[0], args[1]);
    else if (name === 'interrupt') await entry.core.interrupt();
    // `setMode` lives on the CORE, not on the entry: the entry is a registry row holding
    // `core`/`host`/`view`, and calling it on the row itself threw a TypeError that the
    // catch below reported as a 409 — so the mode silently refused to change.
    else if (name === 'setMode') await entry.core.setMode(args[0]);
    else return { ok: false, error: `action "${name}" is not available for a resumed session`, status: 400 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), status: 409 };
  }

  // The transcript changed, so the copy on disk is stale by definition.
  try { sess.saveSession(entry.session); } catch { /* reported on the next read */ }
  return { ok: true, result: undefined };
}

/**
 * The live session's status, in the shape `savedSessionState` uses.
 *
 * `readOnly: false` is what tells the UI its actions will be accepted — the single flag that
 * separates a session a browser can drive from one it can only read.
 */
export function liveSessionState(id) {
  const e = liveEntry(id);
  if (!e) return null;
  const st = e.state;
  return {
    readOnly: false,
    status: {
      running: !!st.running,
      model: e.cfg.model || '',
      mode: st.mode || 'ask',
      rounds: st.rounds || 0,
      steps: st.steps || 0,
      queued: [...(st.queued || [])],
    },
  };
}
