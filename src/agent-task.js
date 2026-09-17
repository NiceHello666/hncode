// Background task registry — the single place tasks are created, listed, stopped
// and read. Mirrors kimi-code's task model:
//
//   TaskInfo = base fields + a `kind`-discriminated payload
//     kind 'process'  -> { command, pid, exitCode }        (Bash run_in_background)
//     kind 'agent'    -> { agentId, subagentType, model, thinkingEffort }  (Agent)
//     kind 'question' -> { questionCount, toolCallId }     (AskUserQuestion bg)
//
// Statuses match kimi exactly so the UI can share one vocabulary:
//   running | completed | failed | timed_out | killed | lost
//
// Bash used to keep its own ad-hoc objects ('done'/'failed', `id`, `start`), which
// is why the task panel could not show the same fields as kimi's. Everything now
// goes through `createTask`, so a task always has the same shape no matter which
// tool spawned it.

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out', 'killed', 'lost']);

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

// `{prefix}-{8 chars}` like kimi's VALID_TASK_ID. Unique even for two tasks
// created in the same millisecond (a bare Date.now() collided).
let seq = 0;
export function newTaskId(prefix = 'task') {
  seq = (seq + 1) % 1e9;
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const s = String(seq).padStart(4, '0');
  return `${prefix}-${(Date.now().toString(36) + s).slice(-8)}-${rand}`;
}

// Decode a task's buffered chunks for display. Buffer chunks (Bash) are UTF-8;
// string chunks (Agent/AgentSwarm) are already text.
function decodeTaskOutput(chunks) {
  const list = chunks || [];
  if (!list.length) return '';
  const allStrings = list.every((c) => typeof c === 'string');
  if (allStrings) return list.join('');
  try { return Buffer.concat(list.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8'); }
  catch { return list.map((c) => String(c)).join(''); }
}

// The task store lives on the agent ctx (`ctx.tasks`), so every tool and the TUI
// see the same map.
function store(ctx) {
  if (!ctx) return {};
  if (!ctx.tasks) ctx.tasks = {};
  return ctx.tasks;
}

/**
 * Register a task. `kind` selects the payload group; the returned object is the
 * live record (mutate `status`/`endedAt`/`stopReason` as it runs).
 *
 * options:
 *   description  short human label
 *   detached     true when it runs in the background (Ctrl+B or run_in_background)
 *   timeoutMs    optional cap
 *   command/pid/exitCode            (kind 'process')
 *   agentId/subagentType/model/thinkingEffort  (kind 'agent')
 *   questionCount/toolCallId        (kind 'question')
 *   output       initial output text
 */
export function createTask(ctx, kind, options = {}) {
  const tasks = store(ctx);
  const prefix = kind === 'process' ? 'bash' : kind === 'agent' ? 'agent' : 'question';
  const task = {
    taskId: newTaskId(prefix),
    kind,
    description: String(options.description || ''),
    status: 'running',
    detached: options.detached !== false,
    startedAt: Date.now(),
    endedAt: null,
    stopReason: undefined,
    timeoutMs: options.timeoutMs,
    // Output is buffered here and exposed through `output` below. Kept as chunks
    // so the decoder can run lazily (a chatty task costs nothing until read).
    _chunks: options._chunks || [],
    _bytes: 0,
  };
  if (kind === 'process') {
    task.command = String(options.command || '');
    task.pid = options.pid || 0;
    task.exitCode = null;
  } else if (kind === 'agent') {
    task.agentId = options.agentId;
    task.subagentType = options.subagentType;
    task.model = options.model;
    task.thinkingEffort = options.thinkingEffort;
  } else if (kind === 'question') {
    task.questionCount = options.questionCount || 0;
    task.toolCallId = options.toolCallId;
  }
  // Every task exposes its buffered output through `output`. The chunks are
  // stored raw and decoded lazily:
  //   * a process appends Buffer chunks -> decode as UTF-8
  //   * an agent/swarm appends strings  -> join
  // Callers may override this getter when they need a different decoding.
  Object.defineProperty(task, 'output', {
    enumerable: true,
    configurable: true,
    get() { return decodeTaskOutput(this._chunks); },
  });
  tasks[task.taskId] = task;
  return task;
}

// Cap retained output per task; a runaway command must not exhaust memory.
export const MAX_TASK_OUTPUT_BYTES = 2 * 1024 * 1024;

// Append raw bytes/chunks to a task, trimming the oldest past the cap.
export function appendTaskOutput(task, chunk) {
  if (!task || chunk == null) return;
  task._chunks.push(chunk);
  task._bytes = (task._bytes || 0) + (chunk.length || 0);
  while (task._bytes > MAX_TASK_OUTPUT_BYTES && task._chunks.length > 1) {
    task._bytes -= task._chunks[0].length || 0;
    task._chunks.shift();
  }
}

// Settle a task. `status` is one of the kimi statuses; a task that was already
// stopped keeps 'killed' (mirrors kimi: a deliberate stop must not be relabelled
// as a failure by the process's non-zero exit).
export function settleTask(task, status, extra = {}) {
  if (!task) return;
  // A task that already reached a TERMINAL state must not be relabelled: a
  // deliberate stop ('killed') must not turn into 'failed' when the killed
  // process reports a non-zero exit, and a 'completed' task must not be
  // downgraded by a late error. Only a still-running task settles.
  if (isTerminal(task.status)) {
    if (extra.exitCode !== undefined && task.kind === 'process') task.exitCode = extra.exitCode;
    return;
  }
  task.status = status;
  task.endedAt = Date.now();
  if (extra.stopReason !== undefined) task.stopReason = extra.stopReason;
  if (extra.exitCode !== undefined && task.kind === 'process') task.exitCode = extra.exitCode;
}

export function listTasks(ctx) {
  return Object.values(store(ctx));
}

export function getTask(ctx, id) {
  return store(ctx)[id] || null;
}

// Newest-first for display (mirrors kimi's compareTasks: running first, then by
// most recent activity).
export function sortedTasks(ctx) {
  const tasks = listTasks(ctx);
  return tasks.slice().sort((a, b) => {
    const at = isTerminal(a.status), bt = isTerminal(b.status);
    if (at !== bt) return at ? 1 : -1;
    if (!at) return a.startedAt - b.startedAt;
    return (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt);
  });
}

// Human label for a status, matching kimi's STATUS_LABEL.
export const STATUS_LABEL = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  killed: 'killed',
  lost: 'lost',
};

// Colour token for a status (the TUI maps it to a theme colour).
export function statusColor(status) {
  if (status === 'running') return 'green';
  if (status === 'completed') return 'gray';
  return 'red';
}
