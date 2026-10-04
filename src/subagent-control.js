// Live control of running subagents: message one, interrupt one, close one.
//
// WHY A REGISTRY AND NOT A MAP ON THE AGENT
// ----------------------------------------
// `tools/agent.js` already keeps `subagents` (agent id -> { id, type, messages }) so a
// `resume` can find the conversation. That map is the WRONG thing to control from: it
// holds the RECORD of an agent, which outlives the run, while "interrupt" and "send a
// message" need the in-flight one. A finished agent has no live handle and must not be
// shown as controllable.
//
// So this module holds a SECOND map, of runs only: id -> { steer, interrupt, taskId,
// startedAt, type, description, status }. `tools/agent.js` registers a run when it starts
// and clears it when the run settles, which makes the registry's contents EXACTLY the set
// of agents that can still be acted on. Nothing here guesses that from timestamps.
//
// The handles are the real Agent methods (`steer`, `interrupt`), so a message sent here
// takes the same path as one the user steers into the main turn, and an interrupt stops
// the subagent the same way Esc stops the parent — there is no second implementation to
// drift out of step.

/** runId -> live handle. Only RUNNING agents are ever in here. */
const runs = new Map();

let seq = 0;
function nextId() {
  seq = (seq + 1) % 1e6;
  return `run-${Date.now().toString(36)}${String(seq).padStart(3, '0')}`;
}

/**
 * Register a running subagent.
 *
 * @param {object} handle
 * @param {string} handle.agentId     the agent id from tools/agent.js (what `resume` uses)
 * @param {string} [handle.taskId]    the background task id, when the run was detached
 * @param {string} handle.type        subagent type
 * @param {string} [handle.description]
 * @param {(text:string)=>void} handle.steer      inject a message into the running run
 * @param {()=>void} handle.interrupt             stop the run
 * @returns {string} the run id, for the control tools to name it
 */
export function registerRun(handle) {
  const runId = nextId();
  runs.set(runId, {
    runId,
    agentId: String(handle.agentId || ''),
    taskId: handle.taskId ? String(handle.taskId) : '',
    type: String(handle.type || ''),
    description: String(handle.description || ''),
    startedAt: Date.now(),
    steer: handle.steer,
    interrupt: handle.interrupt,
    messages: [],
    status: 'running',
  });
  return runId;
}

/** Drop a run. Called when it settles, so the registry only ever holds live work. */
export function endRun(runId) {
  const r = runs.get(runId);
  if (r) r.status = 'done';
  runs.delete(runId);
}

export function listRuns() {
  return [...runs.values()];
}

/** Find a run by EITHER its run id or the agent id it belongs to — a caller usually has
 *  one or the other and should not have to know which kind it holds. */
export function findRun(ref) {
  const key = String(ref == null ? '' : ref).trim();
  if (!key) return null;
  if (runs.has(key)) return runs.get(key);
  for (const r of runs.values()) {
    if (r.agentId === key || r.taskId === key) return r;
  }
  return null;
}

/**
 * Send a message into a running subagent.
 *
 * `steer` rather than a new turn: the message is injected once the subagent's in-flight
 * tool calls finish, which is the only safe point to change its instructions. A new
 * request while tools are running would either queue behind them anyway or fork the
 * conversation, and the second is not what "say something to this agent" means.
 *
 * @returns {{ok: boolean, message: string}}
 */
export function sendToRun(ref, text) {
  const run = findRun(ref);
  if (!run) return { ok: false, message: `No running subagent matches "${ref}". Use AgentMessage with no id, or TaskList, to see what is running.` };
  const body = String(text == null ? '' : text).trim();
  if (!body) return { ok: false, message: 'The message is empty.' };
  try {
    run.steer(body);
    run.messages.push({ at: Date.now(), text: body });
    return { ok: true, message: `Sent to ${run.agentId} (${run.type}): ${body}` };
  } catch (e) {
    return { ok: false, message: `Could not reach ${run.agentId}: ${e.message}` };
  }
}

/** Stop a running subagent. Returns the agent id, so the caller can report it. */
export function interruptRun(ref) {
  const run = findRun(ref);
  if (!run) return { ok: false, message: `No running subagent matches "${ref}".` };
  try {
    run.interrupt();
    return { ok: true, message: `Interrupted ${run.agentId} (${run.type}).`, agentId: run.agentId, runId: run.runId };
  } catch (e) {
    return { ok: false, message: `Could not interrupt ${run.agentId}: ${e.message}` };
  }
}

/** Stop every running subagent. The escape hatch when several were fanned out. */
export function interruptAll() {
  const all = listRuns();
  const ids = [];
  for (const r of all) {
    try { r.interrupt(); ids.push(r.agentId); } catch { /* an already-dead run */ }
  }
  return { ok: ids.length > 0, count: ids.length, agents: ids };
}

/**
 * Close a run: interrupt it AND forget it, so it stops appearing in listings.
 *
 * Distinct from interrupt on purpose. An interrupted run is removed when its `await`
 * unwinds, which is asynchronous — so a user who interrupts and immediately lists would
 * still see it, and would reasonably conclude the interrupt did nothing. `close` removes
 * it at once. The record of the conversation stays in `tools/agent.js`, so `resume` still
 * works; only the live handle goes.
 */
export function closeRun(ref) {
  const run = findRun(ref);
  if (!run) return { ok: false, message: `No running subagent matches "${ref}".` };
  try { run.interrupt(); } catch { /* already stopping */ }
  endRun(run.runId);
  return { ok: true, message: `Closed ${run.agentId} (${run.type}). Its conversation stays available to \`resume\`.`, agentId: run.agentId };
}

/** Lines for a control tool / panel: one row per running subagent. */
export function describeRuns() {
  const all = listRuns();
  if (!all.length) return ['No subagent is running.'];
  const out = [`Running subagents (${all.length})`, ''];
  for (const r of all) {
    const secs = Math.round((Date.now() - r.startedAt) / 1000);
    out.push(`  ${r.runId}  ${r.type.padEnd(10)} ${secs}s  ${r.agentId}`);
    if (r.description) out.push(`      ${r.description}`);
    if (r.messages.length) {
      const last = r.messages[r.messages.length - 1];
      out.push(`      last message: ${String(last.text).slice(0, 80)}`);
    }
  }
  return out;
}
