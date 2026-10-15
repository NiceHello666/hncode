// The pieces a running session needs that are not the display.
//
// WHY A HOST RATHER THAN A BIGGER CORE
// ------------------------------------
// After the display calls were routed through the view, an audit of runAgent's 1024 lines found 25
// remaining TUI dependencies across 14 names. Only FOUR of those genuinely need a foreground
// process (`state.scroll`, `dropScrollPin`, `beginTurn`, `refreshGitInfo`) — and three of the four
// are harmless no-ops headless. The other seven names are session machinery that happened to be
// written inside startTUI's closure:
//
//   flushStream            drains the stream buffer
//   recordTranscriptRow    appends to the persisted display history
//   normalizeMsg           its shape is what every renderer and the web UI read
//   generateTitle          names the session
//   stopTask               stops a background job
//   runShellCommand        the `!cmd` path
//
// Those belong to a session, not to a terminal. The host is where they live so both a TUI and a
// daemon can have them.
import {
  StreamBuffer, StreamOp,
} from './stream-buffer.js';

/**
 * The parts of a session that outlive any one turn.
 *
 * `view` decides where anything the user should see goes; everything else here is state the
 * session carries. Constructed by the TUI with its own painters, and by the daemon with
 * HEADLESS_VIEW.
 */
export class SessionHost {
  constructor({ state, cfg, session, view, onEvent } = {}) {
    this.state = state;
    this.cfg = cfg;
    this.session = session;
    this.view = view;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};

    // One buffer for the whole session rather than one per turn: the pacing it does is about the
    // pipe, not about the turn, and a fresh buffer per turn would drop whatever the previous one
    // had not yet released.
    this.streamBuf = new StreamBuffer();
    this._recorder = null;

    // Where revealed text goes. Three callbacks rather than an event, because this is not a
    // notification — it is the append itself, and a host that only announced the text would
    // lose every character the buffer released.
    this.appenders = {
      assistant: () => {},
      reasoning: () => {},
      settleReasoning: () => {},
    };
  }

  /**
   * Where `recordTranscriptRow` writes.
   *
   * Injected rather than imported: the recorder lives in session.js and reaches the disk, and a
   * test (or a daemon with no store) must be able to run a session without one.
   */
  setRecorder(fn) {
    this._recorder = typeof fn === 'function' ? fn : null;
    return this;
  }

  /** Drain whatever the stream buffer is holding. Idempotent. */
  flushStream() {
    const ops = this.streamBuf.flush();
    return this.applyStreamOps(ops);
  }

  /**
   * Apply the ops the buffer hands back.
   *
   * The push methods RETURN the characters due right now and have already dequeued them, so
   * dropping the return value loses that text permanently — this is the one rule the whole
   * streaming path depends on, and it is why every push goes through here.
   */
  applyStreamOps(ops) {
    if (!ops || !ops.length) return false;
    const a = this.appenders;
    for (const o of ops) {
      // Text and reasoning go to DIFFERENT appenders — that is what keeps a reasoning block
      // from overtaking the answer that followed it, and what closes the block at exactly the
      // point the provider closed it.
      if (o.op === StreamOp.Text) a.assistant(o.text);
      else if (o.op === StreamOp.Reasoning) a.reasoning(o.text);
      else if (o.op === StreamOp.CloseReasoning) a.settleReasoning();
    }
    return true;
  }

  /**
   * Append a row to the persisted DISPLAY history.
   *
   * Separate from the chat log: `session.messages` is what gets sent to the model, while this is
   * what the user saw — notices, warnings, plan cards, reasoning. `/save-history off` drops it,
   * and a session without a recorder simply does not keep it.
   */
  recordTranscriptRow(msg) {
    if (!this.session) return;
    if (this.state.saveHistory === false) return;
    if (!this._recorder) return;
    try { this._recorder(this.session, msg, this.state); } catch { /* history is not worth a turn */ }
  }

  /**
   * The canonical shape of a message.
   *
   * Every renderer reads rows shaped like this, and the web UI mirrors the same shape — so it is
   * normalised once, here, rather than at each reader.
   *
   * `failed` is deliberately preserved: a failed tool result must render red, and dropping it made
   * every failure look like ordinary output.
   */
  normalizeMsg(m) {
    const msg = { ...(m || {}) };
    if (msg.text == null && msg.content != null) msg.text = String(msg.content);
    if (msg.content == null && msg.text != null) msg.content = msg.text;
    if (msg.role === 'tool' && msg.failed === undefined && typeof msg.text === 'string') {
      msg.failed = /^Error\b|^Cannot read\b|^Edit rejected/.test(msg.text);
    }
    return msg;
  }

  /**
   * Close the pending reasoning row.
   *
   * A reasoning block stays `pending` while it streams and is what the renderer draws a live
   * cursor on. Nothing in a headless run draws it, but the flag is what the transcript records
   * — a block left pending would be read back as still running on the next resume.
   */
  settleThinking() {
    const t = [...(this.state.chat || [])].reverse().find((m) => m.role === 'thinking' && m.pending);
    if (t) t.pending = false;
  }

  /**
   * Add `n` to the turn's output-token estimate.
   *
   * Called for EVERY stream the model produces — answer, reasoning, tool arguments — because
   * the turn is billed for all three. The provider's exact figure replaces the estimate when the
   * `usage` event lands, so this only has to be roughly right while it is on screen.
   *
   * `n` may be FRACTIONAL. Streaming callers pass `estimateTokensFloat` so that a chunk smaller
   * than four characters contributes its real share instead of a whole rounded token — see that
   * function for why summing rounded chunks inflated the figure by a third. Only the DISPLAYED
   * total is rounded.
   */
  countOutputTokens(n) {
    const add = Number(n) || 0;
    if (add <= 0) return;
    const st = this.state;
    st.turnOutputEstimate = (st.turnOutputEstimate || 0) + add;
    // SETTLED + ESTIMATE, not the estimate alone: a turn makes one request per step, and
    // `usage` closes each one. Showing only the live estimate made the counter restart from
    // zero at the start of every step.
    st.turnOutputTokens = Math.round((st.turnOutputSettled || 0) + st.turnOutputEstimate);
  }

  /** Whether tools may touch paths outside the workspace. Read live off config. */
  externalAllowed() {
    return !!(this.cfg && this.cfg.allowExternal);
  }

  /**
   * Write the session's live switches back to the record.
   *
   * Mode, plan, focus and swarm are all things a command flips mid-session and all of which a
   * resume has to bring back. Saved here rather than at turn end so `/mode yolo` followed by a
   * crash does not come back as `ask`.
   */
  persistState() {
    const s = this.session;
    if (!s) return;
    const st = this.state;
    s.mode = st.mode;
    s.plan = !!st.plan;
    s.planPath = st.planPath || null;
    s.focus = !!st.focus;
    s.swarm = !!st.swarm;
    s.todos = st.todos || [];
    return s;
  }

  /**
   * Name the session from its first exchange.
   *
   * Returns the title, or '' when there is nothing to name it with. A failure returns '' rather
   * than throwing: an unnamed session is a cosmetic loss, and the caller has a turn in flight.
   */
  async generateTitle(userText, { makeTitle } = {}) {
    if (!this.session) return '';
    if (this.session.title) return this.session.title;
    if (typeof makeTitle !== 'function') return '';
    const asked = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!asked) return '';
    try {
      const title = await makeTitle(asked, this.cfg);
      if (title && !this.session.title) {
        this.session.title = String(title).slice(0, 80);
        this.view.syncChat && this.view.syncChat(this.state.chat || []);
      }
      return this.session.title || '';
    } catch {
      // The caller counts attempts; a throw here would end a turn over a label.
      return '';
    }
  }
}

/** The op kinds the buffer emits, re-exported so a consumer does not import two modules. */
export const HOST_STREAM_OPS = StreamOp;
