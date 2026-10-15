// The session, as a thing a non-TUI front end can own.
//
// WHY NOT MOVE THE FIELDS
// -----------------------
// `state` already IS the session state — `chat`, `queued`, `running`, `rounds`, `steps`, `todos`,
// `ctxTokens`, `workMsg`, `titleAttempts`. Moving them into a new object would mean rewriting the
// 74 references inside runAgent plus every reader in composeFrame and the panels, for no gain:
// the fields would live one property deeper and every line that touches them would change.
//
// So the core HOLDS the state rather than replacing it. A headless run creates its own state
// object and hands it to a core; the TUI hands over the one it already builds. Same code, one
// carrier, no churn.
//
// WHAT THE CORE ADDS
// ------------------
// Three things the state object cannot do for itself, and which a second front end needs:
//
//   * `submit(text)` — start a turn, from anywhere
//   * `dispatch(cmd, arg)` — run a slash command, from anywhere
//   * a lifecycle — `onEvent` out, `interrupt` in, without a terminal to route through
//
// Those are exactly the 207 lines of hub actions plus the 100 of submit, which is why they are
// what gets extracted rather than the 1020 of runAgent.
import { HEADLESS_VIEW } from './session-view.js';

// The team the LEAD is on.
//
// A lead has no async identity — only teammates do — so without this every tool and command it
// calls would have to be handed the team name, and the model does not know to pass it. One
// process, one lead, one team: createTeam refuses a second.
//
// This is the ONLY copy. tools/team.js reads through here rather than keeping its own, or a
// team created from the keyboard would be invisible to the model.
let leadTeamName = null;

/** The team the lead is leading, or null. */
export function leadTeam() {
  return leadTeamName;
}

/** Record it. Called when a team is created, from either the tool or the command. */
export function setLeadTeam(name) {
  leadTeamName = name || null;
  return leadTeamName;
}

/** Forget it. Called when the team is dissolved. */
export function clearLeadTeam() {
  leadTeamName = null;
}

export class SessionCore {
  /**
   * @param {object} deps
   * @param {object} deps.state   the live state object (the TUI's, or one built for a headless run)
   * @param {object} deps.cfg
   * @param {object} deps.session the persisted session record
   * @param {object} [deps.view]  display adapter; HEADLESS_VIEW when there is no terminal
   */
  constructor({ state, cfg, session, view = HEADLESS_VIEW, host = null }) {
    // The session machinery. Optional so a test can build a core without one, but a real
    // session passes it: it holds the ONE stream buffer and the transcript recorder.
    this.host = host;
    this.state = state;
    this.cfg = cfg;
    this.session = session;
    this.view = view;

    /** Host callbacks the core does not own: run a turn, run a command, stop. */
    this._runAgent = null;
    this._dispatch = null;
    this._quit = null;
    /**
     * The object `dispatch` destructures its UI callbacks from.
     *
     * NOT `this.view`: the view is the seam a SESSION sees (note/err/render/pick/form), while a
     * command is written against the host's own names — `notice`, `openPicker`, `openForm`,
     * `sendPrompt`, `saveSession`, `quit`. Passing the view left every panel-opening command
     * (`/help`, `/model`, `/exit`) throwing `openPicker is not a function`.
     */
    this._commandHost = null;
    /** Subscribers, for a front end that wants the turn's events as they happen. */
    this._listeners = new Set();
  }

  /**
   * Hand the core the functions only the embedding process can provide.
   *
   * `runAgent` stays where it is for now: it is 1020 lines woven through the TUI's paint path,
   * and moving it in one piece is the step that cannot be verified halfway. Wiring it here means
   * the core's interface is complete and a later step can move the implementation without any
   * caller changing.
   */
  bind({ runAgent, dispatch, quit, commandHost }) {
    if (runAgent) this._runAgent = runAgent;
    if (dispatch) this._dispatch = dispatch;
    if (quit) this._quit = quit;
    if (commandHost) this._commandHost = commandHost;
    return this;
  }

  /** Subscribe to turn events. Returns an unsubscribe. */
  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this._listeners) {
      try { fn(event); } catch { /* a listener must not break the turn */ }
    }
  }

  // ---- the actions a front end may take ------------------------------------

  /**
   * Start a turn with `text`.
   *
   * Rejects rather than returning an error code: the caller is an HTTP handler or a key press,
   * and both need a throw to answer with a status or a message. `hub.call` already converts that
   * shape, so the two agree.
   */
  async submit(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty message');
    if (!this._runAgent) throw new Error('this session has no agent runner');
    return this._runAgent(text, {}, this.view);
  }

  /** Run a slash command. `cmd` may be `/name args` or just `name`. */
  async dispatch(cmd, arg) {
    if (!this._dispatch) throw new Error('this session has no command dispatcher');
    const raw = String(cmd || '').trim();
    if (!raw) throw new Error('empty command');
    const sp = raw.indexOf(' ');
    const name = sp === -1 ? raw : raw.slice(0, sp);
    const rest = sp === -1 ? String(arg || '') : raw.slice(sp + 1).trim();
    const out = await this._dispatch(name, rest, this.state, this.cfg, this.session, this._commandHost);
    if (this.state._quit && this._quit) this._quit();
    return out;
  }

  /**
   * Stop the running turn.
   *
   * Throws when nothing is running rather than doing nothing: a front end that reports "stopped"
   * for a turn that had already finished is lying to the user about what happened.
   */
  async interrupt() {
    const agent = this.state.agent;
    if (!agent || typeof agent.interrupt !== 'function') throw new Error('nothing is running');
    agent.interrupt();
  }

  /** Whether a turn is in flight. */
  get running() {
    return !!this.state.running;
  }

  /**
   * The queued prompts, as a plain array.
   *
   * A copy: the queue is drained by the turn loop, and a front end iterating the live array would
   * see it shift under it.
   */
  get queued() {
    return [...(this.state.queued || [])];
  }

  /** Queue a prompt for after the current turn. */
  enqueue(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    (this.state.queued = this.state.queued || []).push(t);
    this.view.pubStatusField('queued', this.queued);
    return true;
  }

  /** Drop every queued prompt. */
  clearQueue() {
    this.state.queued = [];
    this.view.pubStatusField('queued', []);
  }

  /**
   * Change the permission mode.
   *
   * Validated here rather than by the caller: `ask` / `yolo` / `auto` is the whole set the rest
   * of the program understands, and a typo reaching `state.mode` would be read as a mode that
   * denies everything.
   */
  async setMode(mode) {
    const m = String(mode || '');
    if (!['ask', 'yolo', 'auto'].includes(m)) throw new Error(`unknown mode: ${m}`);
    this.state.mode = m;
    if (this.session) this.session.mode = m;
    return m;
  }

  /** The permission mode in force. */
  get mode() {
    return this.state.mode || 'ask';
  }
}
