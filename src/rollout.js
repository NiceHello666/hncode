// Session replay (/replay) — play a recorded conversation back, one step at a time.
//
// Why this exists: a session file records WHAT happened but not how long it took or
// in what ORDER relative to the tools, and reading the raw JSON to understand a run
// is unpleasant. More importantly, when something went wrong two hours ago, the
// question is "what did the model see when it made that bad call" — and the answer is
// the transcript AS IT STOOD at that step, which is not the same as the final
// transcript.
//
// So the replay is a step index over the session's messages, with the state at each
// step reconstructable. It is deliberately read-only: nothing here writes a file or
// resumes execution. A replay that could act would be a footgun.
//
// Steps are the unit the user cares about — a user message, an assistant reply, a
// tool call, a tool result — not raw JSON entries, because one assistant message can
// carry several tool calls and the interesting question is "which tool ran, in what
// order".

/** The kinds of step a replay can stop on, in the order they can occur. */
export const STEP_KINDS = ['user', 'assistant', 'thinking', 'tool', 'system'];

/**
 * Turn a session's messages into replay steps.
 *
 * Returns an array of
 * `{ index, kind, role, label, text, toolName, args, at }`. `at` is only present
 * when the recording kept a timestamp, which older sessions do not.
 */
export function buildSteps(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const steps = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');
    const at = m.at || m.timestamp || null;
    if (role === 'assistant') {
      // Split one assistant message into its reasoning, its prose, and each tool
      // call: the tool calls are the steps a debugging reader wants on their own.
      const thinking = typeof m.reasoning === 'string' ? m.reasoning : '';
      if (thinking.trim()) {
        steps.push({ kind: 'thinking', role, label: 'thinking', text: thinking, at });
      }
      const text = typeof m.content === 'string' ? m.content : '';
      if (text.trim()) {
        steps.push({ kind: 'assistant', role, label: 'reply', text, at });
      }
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      for (const c of calls) {
        const name = (c && (c.name || (c.function && c.function.name))) || 'tool';
        steps.push({
          kind: 'tool', role, label: name, toolName: name,
          text: '', args: c && (c.args || c.arguments || (c.function && c.function.arguments)) || null,
          at,
        });
      }
      if (!thinking.trim() && !text.trim() && !calls.length) {
        steps.push({ kind: 'assistant', role, label: 'reply', text: '', at });
      }
      continue;
    }
    if (role === 'tool') {
      const name = m.toolName || m.name || 'tool';
      steps.push({ kind: 'tool', role, label: `${name} result`, toolName: name, text: typeof m.content === 'string' ? m.content : '', at });
      continue;
    }
    if (role === 'user' || role === 'system') {
      steps.push({ kind: role, role, label: role === 'user' ? 'prompt' : 'system', text: typeof m.content === 'string' ? m.content : '', at });
      continue;
    }
    // Anything else (a plugin-injected role, a future one) is shown as itself rather
    // than dropped: a replay that silently omits steps is worse than an ugly label.
    steps.push({ kind: 'other', role, label: role || 'entry', text: typeof m.content === 'string' ? m.content : '', at });
  }
  return steps.map((s, i) => ({ ...s, index: i }));
}

/**
 * The state at step `i`: which prompt is being answered and what has been seen.
 *
 * This is the "as it stood" view — the whole reason to replay rather than scroll.
 */
export function stateAtStep(steps, i) {
  const list = Array.isArray(steps) ? steps : [];
  const at = Math.max(0, Math.min(list.length - 1, i | 0));
  let lastPrompt = '';
  let tools = 0;
  for (let n = 0; n <= at; n++) {
    const s = list[n];
    if (!s) continue;
    if (s.kind === 'user') lastPrompt = s.text;
    if (s.kind === 'tool') tools++;
  }
  return {
    index: at,
    lastPrompt,
    tools,
    // The turn number the step belongs to, counting prompts: 1-based for display.
    turn: list.slice(0, at + 1).filter((s) => s && s.kind === 'user').length || 1,
  };
}

/** A one-line summary per step, for the scrubber list. */
export function stepLine(step, width = 72) {
  if (!step) return '';
  const t = String(step.text || '').replace(/\s+/g, ' ').trim();
  const arg = step.args == null ? ''
    : (typeof step.args === 'string' ? step.args : JSON.stringify(step.args)).replace(/\s+/g, ' ');
  const body = t || arg;
  const cut = body.length > width ? body.slice(0, width - 1) + '…' : body;
  return cut;
}

/**
 * The frame for one step: a header plus the step's body, wrapped.
 *
 * Wrapping is done here rather than by the caller so a replay view and a test agree
 * on the exact rows.
 */
export function renderStep(steps, i, opts = {}) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return ['(this session has no steps to replay)'];
  const at = Math.max(0, Math.min(list.length - 1, i | 0));
  const s = list[at];
  const st = stateAtStep(list, at);
  const width = Math.max(20, opts.width || 76);
  const out = [];
  out.push(`step ${at + 1}/${list.length}  turn ${st.turn}  ${s.kind}${s.toolName ? ' ' + s.toolName : ''}`);
  if (st.lastPrompt) out.push(`  answering: ${st.lastPrompt.split('\n')[0].slice(0, width - 12)}`);
  if (s.at) out.push(`  at: ${s.at}`);
  out.push('');
  const body = [String(s.text || ''), s.args == null ? '' : (typeof s.args === 'string' ? s.args : JSON.stringify(s.args, null, 2))]
    .filter((x) => x && String(x).trim()).join('\n');
  const rows = body ? String(body).split('\n') : ['(no content)'];
  for (const r of rows) {
    if (r.length <= width) { out.push(r); continue; }
    for (let k = 0; k < r.length; k += width) out.push(r.slice(k, k + width));
  }
  return out;
}

/** Totals for the header: how many steps of each kind, and how many tools ran. */
export function replaySummary(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const counts = {};
  for (const s of list) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const calls = list.filter((s) => s.kind === 'tool' && s.role === 'assistant').length;
  const results = list.filter((s) => s.kind === 'tool' && s.role === 'tool').length;
  return { total: list.length, counts, calls, results };
}

export default { buildSteps, stateAtStep, stepLine, renderStep, replaySummary, STEP_KINDS };
