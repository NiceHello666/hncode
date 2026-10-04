// Side conversations (/btw) and recaps.
//
// A side conversation is a FORK of the main thread: it carries the SAME conversation
// history, so a question like "what does this error mean" has the context to be
// answered rather than bounced back as "which file?". What it must not do is affect
// the main thread — the main agent keeps running, and nothing said in the side thread
// is written back to the session or to disk.
//
// That is how the two references do it, and the split is deliberate:
//   * kimi's `startBtw` calls `agentLifecycle.fork(main)`, and `fork` copies the
//     whole message list into the child agent; its system reminder tells the side
//     model to "prefer answering from what you already know from the conversation".
//   * codex forks the thread with `ephemeral = true`, and its snapshot comment says
//     it outright: "The forked history remains available to the model through core
//     state, but side conversations should visually start at the side boundary."
//
// So history is a FEATURE of the side thread, not baggage. What the user sees is a
// clean question and answer; what the model has is the full context. Those two are
// separable, and this module keeps them separate:
//
//   forkMessages(session)   -> the history handed to the side model
//   thread.transcript()     -> only what happened since the fork, for the panel
//
// Tools are cut to the read-only three (Read / Grep / Glob): a side question may
// inspect a file to answer, and must not edit one. The model still sees the other
// tool DEFINITIONS in the request — that is what keeps the prompt cache shared with
// the main thread — so a call to anything else is refused rather than hidden. See
// SIDE_TOOL_REFUSAL: kimi does exactly this, and for the same reason.
//
// A RECAP is the opposite kind of read: it is a summary OF the main conversation, so
// it takes a digest rather than the history. The two live together because they share
// the "read-only, secondary model, must not disturb the session" shape.

/** The only tools a side question may actually use. */
export const SIDE_RO_TOOLS = ['Read', 'Grep', 'Glob', 'FileLines'];



/**
 * The system prompt for a side thread: the session's prompt plus the side-thread
 * framing.
 *
 * The framing has to do three jobs, and each line below exists because dropping it
 * causes a specific failure:
 *   * say it is a side channel, so the model does not treat the user's question as a
 *     new task and start a multi-step effort;
 *   * say the main agent is still RUNNING, so it does not say "let me stop what I was
 *     doing" or otherwise narrate an interruption that did not happen;
 *   * say which tools actually work, so the model does not waste a step on one that is
 *     absent from the request.
 */
export function sideSystemPrompt(basePrompt, opts = {}) {
  const tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : SIDE_RO_TOOLS;
  const lines = [String(basePrompt || '')];
  lines.push(
    '',
    '## This is a side question',
    'The user asked you something off to the side of the main conversation. Answer it',
    'directly and briefly.',
    '',
    'You are a separate, lightweight instance. You have the conversation so far, so',
    'answer from what you already know; the main agent continues independently, so do',
    'not refer to being interrupted or to pausing anything.',
    '',
    `Only these tools work here: ${tools.join(', ')}. Use them when the answer depends`,
    'on the current contents of a file. Do not attempt to edit, write or run anything —',
    'those tools are not available in a side question.',
    '',
    'Your reply is shown to the user but is NOT added to their conversation, so do not',
    'assume the main model will ever see it. If the answer calls for a code change, say',
    'what should be done and let the user decide to bring it up in the main thread.',
  );
  return lines.join('\n');
}

/** The refusal a side thread gets for a tool outside its set (kimi's wording, ours). */
export const SIDE_TOOL_REFUSAL =
  'Only reading tools are available in a side question (Read, Grep, Glob, FileLines). '
  + 'Ask in the main thread if this needs to change something.';

/**
 * The history a side thread forks from a session.
 *
 * A COPY, and only the roles a model can be given: `system` is rebuilt by the caller
 * from the current prompt, and a `tool` row without its matching call would be an
 * orphan the protocol rejects. Tool CALLS are kept — dropping them would break the
 * pairing with their results and lose the record of what was already done, which is
 * exactly the context a side question needs.
 */
export function forkMessages(session, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 0;   // 0 = no limit
  const list = Array.isArray(session && session.messages) ? session.messages : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') continue;
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    if (!text.trim() && !calls.length) continue;
    out.push({ ...m });
  }
  // `limit` keeps the most RECENT entries when set: a very long session does not need
  // its opening messages to answer a question about the work in progress.
  return limit > 0 && out.length > limit ? out.slice(-limit) : out;
}

/**
 * One side thread: a fork of the main conversation.
 *
 * Two message lists, and the split is the whole design:
 *   `history`  — the main conversation, handed to the model as context
 *   `messages` — ONLY what was said in the side thread
 *
 * `payload()` sends history + messages, so the side model answers with full context.
 * `transcript()` returns ONLY `messages`, so the panel shows a clean question and
 * answer rather than the entire session again. That is codex's "history remains
 * available to the model, but side conversations visually start at the side boundary".
 */
export class SideThread {
  /**
   * @param {object} opts
   *   basePrompt  the system prompt the main session uses
   *   history     the messages forked from the session (see forkMessages)
   *   tools       the tool names that actually work here (defaults to the read-only set)
   *   model       label of the model the side answers run on (for display)
   */
  constructor(opts = {}) {
    this.basePrompt = String(opts.basePrompt || '');
    this.model = String(opts.model || '');
    this.tools = Array.isArray(opts.tools) && opts.tools.length ? [...opts.tools] : [...SIDE_RO_TOOLS];
    // A COPY, never the session's array: appending here must not reach the session.
    this.history = (Array.isArray(opts.history) ? opts.history : []).map((m) => ({ ...m }));
    this.messages = [];
    this.error = null;
  }

  /** How many entries were forked in — for the panel, so the context is visible. */
  get forked() {
    return this.history.length;
  }

  /** The request payload. Exposed so a test can assert exactly what would be sent. */
  payload(text) {
    return [
      { role: 'system', content: sideSystemPrompt(this.basePrompt, { tools: this.tools }) },
      ...this.history,
      ...this.messages,
      { role: 'user', content: String(text || '') },
    ];
  }

  /** Record an exchange. Kept separate from the request so a failed ask is not kept. */
  record(text, reply) {
    this.messages.push({ role: 'user', content: String(text || '') });
    this.messages.push({ role: 'assistant', content: String(reply == null ? '' : reply) });
  }

  /** How many exchanges have happened, for the header and the tests. */
  get turns() {
    return Math.floor(this.messages.length / 2);
  }

  /**
   * ONLY the side thread's own exchanges — not the forked history.
   *
   * The reason is the one codex states: the history is context for the MODEL, and
   * repeating it in the panel would bury the two lines the user actually asked for.
   */
  transcript() {
    const rows = [];
    for (const m of this.messages) {
      rows.push({ role: m.role === 'user' ? 'user' : 'assistant', text: m.content });
    }
    return rows;
  }
}

/** Is `name` a tool a side question may use? */
export function sideToolAllowed(name) {
  return SIDE_RO_TOOLS.includes(String(name || ''));
}

/**
 * The recap prompt. A recap answers "where was I", so the instruction pins the
 * three things that answer it and forbids the two that do not.
 *
 * Deliberately not a summary of the transcript: /compact already does that, and its
 * output REPLACES the history. This one is read by a human coming back to the
 * terminal and changes nothing.
 */
export const RECAP_PROMPT = `You are writing a short recap of a coding session the user is returning to.

State, in at most six short lines:
  1. What the user asked for (the goal, not the wording).
  2. What has been done so far, naming the files that changed.
  3. What is NOT done yet, or what is uncertain.

Rules: no greeting, no praise, no restating the rules you were given, no
speculation about what the user might want next. Plain sentences, no Markdown
headings. If the work is finished, say so in one line.`;

/**
 * Build the messages for a recap request.
 *
 * The RECAP gets the forked history as real messages rather than a digest: the model
 * is being asked what happened, and handing it the actual conversation beats handing
 * it a lossy summary of one. `limit` bounds it so a very long session stays cheap.
 */
export function recapMessages(history, opts = {}) {
  const list = Array.isArray(history) ? history : [];
  const limit = Number.isFinite(opts.limit) ? opts.limit : 0;
  const tail = limit > 0 && list.length > limit ? list.slice(-limit) : list;
  if (!tail.length) {
    return [
      { role: 'system', content: RECAP_PROMPT },
      { role: 'user', content: 'The conversation is empty. Say so in one line.' },
    ];
  }
  return [
    { role: 'system', content: RECAP_PROMPT },
    ...tail,
    // The instruction comes LAST, as the final user turn, so it is the most recent
    // thing the model reads — a recap is an instruction about the history above it.
    { role: 'user', content: 'Write the recap of the session above, per the rules.' },
  ];
}

/** Counts for a panel header: how much conversation is being summarised. */
export function digestStats(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const users = list.filter((m) => m && m.role === 'user').length;
  const assistants = list.filter((m) => m && m.role === 'assistant').length;
  return { users, assistants, total: list.length };
}

export default {
  sideSystemPrompt, SideThread, SIDE_RO_TOOLS, SIDE_TOOL_REFUSAL,
  forkMessages, sideToolAllowed, recapMessages, digestStats, RECAP_PROMPT,
};
