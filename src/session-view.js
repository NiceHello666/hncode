// The seam between a session and the thing displaying it.
//
// WHY THIS EXISTS
// ---------------
// `runAgent` is 1020 lines and mixes three concerns: assembling the request, driving the agent
// loop, and PAINTING. The painting is what tied a session to the TUI — a session could only run
// in the process that drew it, so the web UI had to proxy to a live terminal and a session whose
// terminal had closed could never be continued.
//
// The audit that motivated this file counted the damage: of 1020 lines, only 127 places touch the
// TUI at all, and just 27 of those are rendering calls and 5 are modals. Everything else is
// session state the session would carry anyway. So the seam is real and small enough to cut.
//
// WHY A PARAMETER RATHER THAN A GLOBAL
// ------------------------------------
// The TUI passes its own painters; a headless run passes no-ops. A module-level "current view"
// would make two sessions in one process share whatever was set last — the same failure the
// teammate identity had, and the reason that one uses AsyncLocalStorage.
//
// Every method is optional at the call site via `view?.x?.()`. A view that only wants rows should
// not have to implement file dialogs, and a headless run must not have to stub twenty methods to
// run one turn.

/** A view that draws nothing. Used by headless runs and by tests. */
export const HEADLESS_VIEW = {
  note: () => {},
  err: () => {},
  render: () => {},
  renderSoon: () => {},
  // The transcript. A headless run still APPENDS to it: the chat log is what gets persisted
  // and what the web UI streams, so dropping this would lose the turn rather than merely not
  // drawing it.
  addChat: () => {},
  sync: () => {},
  pushRow: () => {},
  patchRow: () => {},
  syncChat: () => {},
  pubStatusField: () => {},
  edit: async () => null,
  pick: async () => null,
  form: async () => null,
};

/**
 * Wrap a real TUI's painters into the shape `runAgent` expects.
 *
 * `deps` is what `startTUI` already owns: the hub, the frame painter, the chat log. Passing them
 * in rather than importing them keeps this module free of the 17k-line file it would otherwise
 * have to import — and makes the seam testable without a terminal.
 */
export function tuiView(deps) {
  const {
    // `hub` is NOT destructured: it is assigned long after this runs, so reading it here
    // would freeze the null that exists now and every web push would silently no-op. Read it
    // through `deps.hub` at the call site. The rest are plain functions that never change.
    renderFrame, renderSoon, addChat, notice, syncWeb,
    openEditor, openPicker, openForm, stdout,
  } = deps;

  return {
    // A line the USER should read. In the TUI these are the transient notices; a teammate's
    // failure that is only logged is a failure nobody sees.
    note: (text, kind = 'info') => { try { notice(text, kind); } catch { /* the UI itself */ } },

    // The same notice at ERROR level. Separate method because the TUI's `appErr(m)` is
    // `notice(m, 'error')` — the level is not in the call, so a plain rename to `note` would
    // quietly downgrade every failure to an ordinary message.
    err: (text) => { try { notice(text, 'error'); } catch { /* the UI itself */ } },

    // Repaint now, and soon. Two names because the call sites differ in intent: one has just
    // changed what should be on screen, the other is mid-stream and wants to coalesce.
    render: () => { try { renderFrame(); } catch { /* a paint failure must not kill a turn */ } },
    renderSoon: () => { try { (renderSoon || renderFrame)(); } catch { /* as above */ } },

    // Append to the transcript. This is DATA, not drawing: the chat log is what `--continue`
    // saves and what the web UI streams, so it has to work with no terminal at all.
    addChat: (msg) => { try { addChat(msg); } catch { /* as above */ } },

    // A row that is updated in place rather than appended — a running tool call, a compaction
    // block. Optional: a view without the notion of "the same row" simply ignores it.
    pushRow: (row) => { try { deps.hub && deps.hub.pushRow(row); } catch { /* best effort */ } },
    patchRow: (id, patch) => { try { deps.hub && deps.hub.patchRow(id, patch); } catch { /* best effort */ } },

    // The transcript, mirrored for a watching browser. Best effort by design — the web UI
    // lagging is not a reason to fail a turn.
    syncChat: (chat) => { try { deps.hub && deps.hub.syncChat(chat); } catch { /* best effort */ } },
    sync: () => { try { syncWeb && syncWeb(); } catch { /* best effort */ } },
    pubStatusField: (field, value) => {
      try { deps.hub && deps.hub.pubStatusField(field, value); } catch { /* best effort */ }
    },

    // The two things a headless run genuinely cannot do. Returning null rather than throwing
    // lets the caller fall back to a textual answer, which is what the web UI wants anyway.
    edit: (spec) => { openEditor && openEditor(spec); return null; },
    pick: (spec) => { openPicker && openPicker(spec); return null; },
    form: (spec) => { openForm && openForm(spec); return null; },

    // Terminal geometry, for the parts of a transcript that wrap. A headless run has no width to
    // wrap to, so it reports a conventional one rather than failing.
    dims: () => {
      try {
        const [cols, rows] = stdout.getWindowSize();
        return { cols: cols || 80, rows: rows || 24 };
      } catch { return { cols: 80, rows: 24 }; }
    },

    /** True when this view can show a modal. Callers that need one must check. */
    interactive: true,
  };
}
