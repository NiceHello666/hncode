// Session hub — the single source of truth shared by the TUI and the web UI.
//
// WHY THIS EXISTS: the TUI is the original owner of the transcript, the agent
// events and the input. The web UI must see exactly what the TUI sees AND be able
// to drive the same session (send prompts, run slash commands, interrupt, answer
// approvals). Without one shared object the two would drift: a web-sent prompt
// would never appear in the terminal, and a TUI-sent one would never reach the
// browser.
//
// Shape: the hub keeps the durable view (transcript rows, status, tasks, todos)
// and an append-only event log. Both front-ends are SUBSCRIBERS:
//   * `emit(event)` — anything happening in the session. Broadcast to every
//     subscriber; the hub also folds it into its own view so a late subscriber
//     (a browser opened mid-turn) can render the whole state on connect.
//   * `pushRow(row)` — a transcript row was appended by the TUI. Goes out as a
//     `row` event AND into the durable view.
// Actions (the user's intent) travel the OTHER way through injected handlers, so
// the web never touches the agent directly — it calls the same functions the
// keyboard does. That is what keeps behaviour identical in both front-ends.

// How many transcript rows / events to keep for a reconnecting client. The
// transcript is bounded because a long session with big tool results would
// otherwise grow without limit in a process that may run for days; the browser
// gets the tail and can scroll back no further than that on a fresh connect.
//
// NOTE: this is a MEMORY bound for a long-running process, not a rendering one.
// The browser is sent everything up to here and the windowed list (vlist.js)
// keeps only the visible slice in the DOM, so the two limits are independent.
const MAX_ROWS = 4000;
const MAX_EVENTS = 2000;
const SNAPSHOT_ROWS = 0;   // 0 = no cap; see snapshot()

/**
 * Status fields that animate the Working row and change on EVERY frame a turn is
 * running. They must not count as a "status change" — otherwise a long turn
 * broadcasts the whole status (and the browser rebuilds every card pane) once per
 * frame. The pulse is drawn client-side; these ride along when a real change
 * broadcasts.
 */
const ANIMATION_FIELDS = new Set(['spin', 'workMsg', 'pulseStart']);
// Which fields of a transcript row the browser actually renders. The fingerprint
// covers exactly these, so streaming text (a growing `text`) invalidates it while
// an unrelated mutation does not. Keeping the list here — rather than hashing the
// whole object — also keeps a large tool result from being stringified on every
// frame.
const ROW_FIELDS = [
  'role', 'text', 'toolName', 'pending', 'failed',
  'streamContent', 'liveOutput', 'phase', 'tokensBefore', 'tokensAfter',
  'instruction', 'card',
];

function rowFingerprint(msg) {
  let s = '';
  for (const f of ROW_FIELDS) {
    const v = msg[f];
    if (v === undefined || v === null) { s += '|'; continue; }
    if (typeof v === 'string') s += v.length + ':' + (v.length <= 64 ? v : '');
    else if (typeof v === 'object') s += v === msg.card ? 'card:' + String(v.headline || '') : 'obj';
    else s += String(v);
    s += '|';
  }
  // Tool arguments drive the one-line summary, so a change there must be seen.
  s += msg.toolArgs ? Object.keys(msg.toolArgs).join(',') + ':' + String(msg.toolArgs.command || msg.toolArgs.path || msg.toolArgs.pattern || '').length : '';
  // The diff drives an expanded row's body.
  s += '/' + (Array.isArray(msg.diff) ? msg.diff.length : 0);
  return s;
}

/**
 * Content equality for status fields. Scalars by value; arrays element-wise with a
 * one-level object compare (the shape of a todo / task / file entry); other
 * objects field-wise with a JSON fallback for anything nested deeper — exactly the
 * shapes webStatus builds (`options` carries arrays of objects, `pending` carries
 * option lists).
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
      continue;
    }
    return false;
  }
  return true;
}
// The subset of a TUI message the browser needs. Built explicitly rather than
// spreading, so TUI-only bookkeeping (render caches, the arg-stream parser state,
// the hub id itself) never travels over the wire.
function snapshotRow(msg) {
  const out = { role: msg.role || 'system', text: msg.text == null ? '' : String(msg.text) };
  for (const k of ['toolName', 'pending', 'failed', 'streamContent', 'liveOutput',
    'phase', 'tokensBefore', 'tokensAfter', 'instruction']) {
    if (msg[k] !== undefined) out[k] = msg[k];
  }
  // The two fields that can be unbounded. `text` is a finished tool result and
  // `liveOutput` is a running command's stream; both are capped BEFORE the wire,
  // because this snapshot travels as one SSE frame and the browser copies it into
  // a fresh row object on every patch. 128 KiB matches the tool-result cap
  // (`MAX_OUTPUT_BYTES`), so the browser sees the same content the terminal kept.
  out.text = capText(out.text, MAX_ROW_TEXT_CHARS);
  if (typeof out.liveOutput === 'string') {
    out.liveOutput = capText(out.liveOutput, MAX_ROW_TEXT_CHARS);
  }
  // A tool's one-line summary needs its identifying argument, not the whole
  // payload — a Write's `content` can be megabytes.
  if (msg.toolArgs && typeof msg.toolArgs === 'object') {
    const a = {};
    for (const k of ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'description', 'task_id']) {
      if (typeof msg.toolArgs[k] === 'string') a[k] = String(msg.toolArgs[k]).slice(0, 400);
    }
    if (Object.keys(a).length) out.toolArgs = a;
  }
  if (Array.isArray(msg.diff)) out.diff = msg.diff.slice(0, 400);
  if (msg.card && typeof msg.card === 'object') {
    out.card = { phase: msg.card.phase, headline: msg.card.headline, detail: msg.card.detail };
  }
  return out;
}

/** Per-row character budget for the two fields that can grow without bound. */
const MAX_ROW_TEXT_CHARS = 128 * 1024;

/** Keep the TAIL of an over-long field — the part both front-ends show — and mark
    what was dropped, so a truncated row is not mistaken for a short one. */
function capText(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return `...[${str.length - max} chars truncated]\n` + str.slice(str.length - max);
}



export class SessionHub {
  constructor() {
    this.rows = [];            // durable transcript: { id, role, text, ... }
    this.events = [];          // ring of recent events, replayed on connect
    this.subscribers = new Set();
    this.seq = 0;
    this.rowSeq = 0;
    // hub row id -> last fingerprint, for syncChat's incremental diff.
    this._rowFp = new Map();
    // hub row id -> the row object in `this.rows`. syncChat runs on every paint
    // frame, and looking a row up with Array.find() inside the per-message loop
    // made it O(n^2): every token of a long reply walked the whole transcript. The
    // index turns that lookup into a Map hit.
    this._rowById = new Map();
    // Filled in by the TUI once it owns these. A web action that has no handler
    // reports a clear error instead of silently doing nothing.
    this.actions = {
      submit: null,        // async (text) => void          — same path as typing
      dispatch: null,      // async (cmd, arg) => void      — slash commands
      interrupt: null,     // async () => void
      approve: null,       // async (id, ok) => void        — answer an approval
      answerQuestion: null,// async (id, answers) => void   — AskUserQuestion
      stopTask: null,      // async (taskId) => void
      setMode: null,       // async (mode) => void
      status: null,        // () => object
      shell: null,         // async (cmd) => void           — `!` passthrough
      steer: null,         // async (text) => void          — inject into the running turn
      editQueued: null,    // async (text) => {text}        — recall a queued msg for editing
      dropQueued: null,    // async (text) => void          — remove a queued message
    };
  }

  // ---- broadcasting ----------------------------------------------------------

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Broadcast one event. Subscriber failures must never break the session. */
  emit(event) {
    const e = { ...event, seq: ++this.seq, at: Date.now() };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const fn of this.subscribers) {
      try { fn(e); } catch { /* one bad client must not kill the others */ }
    }
    return e;
  }

  /**
   * Append a transcript row. `row` is the TUI's own message object (role/text/
   * toolName/toolArgs/pending/failed/diff/…), so the two front-ends render the
   * SAME data rather than two parallel models.
   */
  pushRow(row) {
    const r = { ...row, id: row.id != null ? row.id : ++this.rowSeq };
    if (row.id == null) r.id = this.rowSeq;
    this.rows.push(r);
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
    this.emit({ type: 'row', row: r });
    return r;
  }

  /** Mutate an existing row in place (streaming text, a tool finishing, …). */
  patchRow(id, patch) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, patch);
    this.emit({ type: 'row_patch', id, patch });
    return r;
  }

  /**
   * Sync the hub's view of the transcript against the TUI's own `state.chat`.
   *
   * This is the bridge between the two front-ends, and it exists so the TUI does
   * NOT have to announce every change. `state.chat` is mutated from half a dozen
   * places (addChat plus direct pushes for streamed prose, tool rows, thinking
   * blocks, the plan bubble, aborts) and one of them is a streaming hot path where
   * an extra call per token would be felt. Instead the caller runs this once per
   * paint: rows are matched by IDENTITY, so a pushed row is picked up on the next
   * frame, and a mutated row is diffed by a cheap field fingerprint.
   *
   * Returns nothing; failures here must never affect rendering.
   */
  syncChat(chat) {
    const list = Array.isArray(chat) ? chat : [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const msg = list[i];
      if (!msg || typeof msg !== 'object') continue;
      // Bind the TUI's message object to a stable hub row id the first time we see
      // it. A WeakMap would be cleaner but the TUI copies rows (spread) in a few
      // paths, so the id lives on the message itself.
      let id = msg._hubId;
      if (id == null) {
        id = ++this.rowSeq;
        Object.defineProperty(msg, '_hubId', { value: id, enumerable: false, configurable: true, writable: true });
      }
      seen.add(id);
      const fp = rowFingerprint(msg);
      const known = this._rowFp.get(id);
      if (known === undefined) {
        const row = { ...snapshotRow(msg), id };
        this.rows.push(row);
        this._rowById.set(id, row);
        this.emit({ type: 'row', row });
} else if (known !== fp) {
        const target = this._rowById.get(id);
        // The WHOLE row's renderable fields, not a text delta.
        //
        // A delta looked like an easy win — a streamed reply grows one token at a
        // time, so shipping only the appended slice is O(n) instead of O(n^2) over a
        // message. But it puts the sender and the receiver into a shared state
        // machine: the receiver must hold exactly the text the sender assumed, and
        // any divergence (a dropped frame, a reconnect mid-stream, an out-of-order
        // batch) silently TRUNCATES the message instead of visibly failing. That is
        // exactly what happened: replies rendered at a fraction of their real length
        // in the browser while the terminal showed them whole.
        //
        // The full patch costs bandwidth, and this is a LOOPBACK server: the cost
        // that matters is the browser's re-render, and `text` is assigned to one
        // text node either way. Correctness over a micro-optimisation.
        const patch = snapshotRow(msg);
        if (target) Object.assign(target, patch);
        this.emit({ type: 'row_patch', id, patch });
      }
    }
    // The TUI rebuilds `state.chat` wholesale on /compact and on session resume.
    // Anything it no longer holds is gone from the hub too, or the browser would
    // keep showing rows the terminal has already dropped.
    //
    // The COUNT is compared first: it is almost always equal, so the common frame
    // never walks the list. The previous version built two filtered copies of
    // `rows` on every frame whether anything had been dropped or not.
    if (this.rows.length !== seen.size) {
      const kept = this.rows.filter((r) => seen.has(r.id));
      if (kept.length !== this.rows.length) {
        this.rows = kept;
        this._rowById = new Map(kept.map((r) => [r.id, r]));
        this.emit({ type: 'rows_reset', rows: this.rows });
      }
    }
    if (this.rows.length > MAX_ROWS) {
      const dropped = this.rows.splice(0, this.rows.length - MAX_ROWS);
      for (const r of dropped) {
        this._rowById.delete(r.id);
        this._rowFp.delete(r.id);
      }
    }
  }


/**
   * Update non-transcript session state (context gauge, tasks, todos, model).
   *
   * Broadcasts ONLY when something actually changed. `setStatus` runs on EVERY TUI
   * frame (~12/s), and `webStatus` rebuilds every array and the nested
   * `options`/`pending` objects each time — so identical content always arrives
   * behind FRESH references. A reference compare (`next[k] !== prev[k]`) therefore
   * reported a change every frame, every frame was broadcast, and the browser
   * re-rendered its whole status DOM — the card panes included — 12 times a second
   * while nothing had changed. That idle churn is what showed up as a tab sitting
   * at 800+ MB with typing that stuttered even when the model was not streaming.
   *
   * ANIMATION FIELDS are excluded from the change test. `spin`, `workMsg` and
   * `pulseStart` drive the Working row's pulse and change on every frame while a
   * turn runs, but the ONLY thing that needs them is the pulse — which the browser
   * draws itself with requestAnimationFrame. Broadcasting on each of those changes
   * meant a long turn rebuilt the whole status DOM (and every card pane) once per
   * frame. They ride along in a broadcast a REAL change triggers, never by
   * themselves.
   *
   * Scalars compare by value; objects compare one level deep (arrays element-wise,
   * nested objects by field) with a JSON fallback for anything deeper — exactly
   * the shapes webStatus builds.
   */
  statusChanged(next) {
    const prev = this.status || {};
    for (const k of Object.keys(next)) {
      if (ANIMATION_FIELDS.has(k)) continue;
      if (!sameValue(next[k], prev[k])) return true;
    }
    // A field present before but dropped from next is also a change.
    for (const k of Object.keys(prev)) {
      if (ANIMATION_FIELDS.has(k)) continue;
      if (!(k in next)) return true;
    }
    return false;
  }

  setStatus(patch) {
    const next = { ...(this.status || {}), ...patch };
    if (!this.statusChanged(next)) return this.status;
    this.status = next;
    this.emit({ type: 'status', status: this.status });
    return this.status;
  }

  /**
   * Publish ONE status field as its own event, so a low-frequency change
   * (e.g. a queued message) reaches the browser immediately instead of riding
   * the next whole-status snapshot. Keeps the field in `this.status` too, so a
   * freshly-connected client still gets it via snapshot().
   */
  pubStatusField(field, value) {
    if (field == null) return this.status;
    const next = { ...(this.status || {}), [field]: value };
    if (!this.statusChanged(next)) return this.status;
    this.status = next;
    const e = { type: field, [field]: value };
    this.emit(e);
    return this.status;
  }

  /**
   * Everything a freshly connected client needs to render the current view.
   *
   * The whole transcript is sent by default. `limit` exists for callers that want
   * a bounded slice (it is a tail), but nothing forces a cap: the browser's
   * windowed list renders only the visible rows, so a long transcript costs one
   * payload rather than one DOM node per row. When a caller DOES cap it, `hidden`
   * reports how much was left out.
   */
  snapshot(limit) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SNAPSHOT_ROWS;
    const start = cap > 0 ? Math.max(0, this.rows.length - cap) : 0;
    return {
      rows: start > 0 ? this.rows.slice(start) : this.rows,
      hidden: start,
      totalRows: this.rows.length,
      status: this.status || {},
      events: this.events.slice(-200),
    };
  }

  // ---- actions (web -> session) ---------------------------------------------
  // Each returns { ok, error } so the HTTP layer can answer honestly instead of
  // pretending an action ran.

  async call(name, ...args) {
    const fn = this.actions[name];
    if (typeof fn !== 'function') {
      return { ok: false, error: `action "${name}" is not available in this session` };
    }
    try {
      // The handler's return value travels back to the caller. Most actions are
      // fire-and-forget (submit, interrupt) and return undefined, but the ones
      // that READ something — listProviders, getConfig — have nothing else to
      // report with, and dropping it made them look like they did nothing.
      const result = await fn(...args);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }
}
