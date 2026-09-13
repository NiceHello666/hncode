// TaskList / TaskOutput / TaskStop — manage background Bash tasks spawned with
// run_in_background.

import cp from 'node:child_process';

export const TaskListSpec = {
  name: 'TaskList',
  description: 'List background tasks (from Bash run_in_background). Reports id, status, description.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const tasks = Object.values(ctx.tasks || {}).sort((a, b) => b.start - a.start);
    if (tasks.length === 0) return 'No background tasks.';
    return tasks.map((t) => `#${t.id} [${t.status}] pid=${t.pid} ${t.description || t.command}`).join('\n');
  },
};

export const TaskOutputSpec = {
  name: 'TaskOutput',
  description: 'Get the output of a background task (Bash run_in_background) by task_id. head_limit caps the lines returned.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task id returned when the task was started.' },
      head_limit: { type: 'integer', minimum: 0, description: 'Max output lines returned.' },
    },
    required: ['task_id'],
  },
  async execute(args, ctx) {
    const t = (ctx.tasks || {})[args.task_id];
    if (!t) return `No such task: ${args.task_id}`;
    const lines = t.output ? t.output.split('\n').filter((l) => l.length > 0) : [];
    const capped = args.head_limit ? lines.slice(0, args.head_limit) : lines;
    const tail = lines.length > (capped.length);
    let out = `#${t.id} [${t.status}] (pid ${t.pid})\n${capped.join('\n')}`;
    if (tail) out += `\n... [${lines.length - capped.length} more lines; use head_limit]`;
    return out;
  },
};

export const TaskStopSpec = {
  name: 'TaskStop',
  description: 'Stop a running background task (Bash run_in_background) by task_id. Use only when the task must be cancelled.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Background task id to stop.' },
      reason: { type: 'string', description: 'Short reason recorded on stop.' },
    },
    required: ['task_id'],
  },
  async execute(args, ctx) {
    const t = (ctx.tasks || {})[args.task_id];
    if (!t) return `No such task: ${args.task_id}`;
    if (t.status !== 'running') return `Task ${t.id} is not running (status: ${t.status}).`;
    const reason = args.reason || 'Stopped by TaskStop';
    try {
      if (process.platform === 'win32' && t.pid) {
        try { cp.spawnSync('taskkill', ['/pid', String(t.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
      } else if (t.pid) {
        try { process.kill(t.pid, 'SIGTERM'); } catch {}
      }
    } catch (e) {
      return `Failed to stop ${t.id}: ${e.message}`;
    }
    t.status = 'stopped';
    t.stopReason = reason;
    t.end = Date.now();
    return `Stopped task ${t.id}. reason: ${reason}`;
  },
};

// WaitFor — block until a background task finishes (or the timeout elapses).
// Mirrors kimi-code's task-wait: a timeout is not an error; the result lists
// the tasks still running so the caller can wait again.
export const TaskWaitSpec = {
  name: 'TaskWait',
  description: 'Wait for background tasks (Bash run_in_background) to finish, timeout in seconds (1-600). With task_id, waits for that task; without it, returns when any running task finishes. A timeout is not an error; still-running tasks are listed, so you may call it again.',
  parameters: {
    type: 'object',
    properties: {
      timeout: { type: 'integer', minimum: 1, maximum: 600, description: 'Max seconds to wait (1-600).' },
      task_id: { type: 'string', description: 'Task id to wait for; omit to wait for any running task.' },
    },
    required: ['timeout'],
  },
  async execute(args, ctx) {
    const tasks = ctx.tasks || {};
    const target = args.task_id ? tasks[args.task_id] : null;
    if (args.task_id && !target) return `No such task: ${args.task_id}`;
    const secs = Math.max(1, Math.min(600, Number(args.timeout) || 1));
    const deadline = Date.now() + secs * 1000;
    const signal = ctx && ctx.signal;

    const isDone = (t) => t && t.status !== 'running';
    const anyRunning = () => Object.values(tasks).some((t) => t.status === 'running');

    // Nothing to wait for at call time.
    if (args.task_id) {
      if (isDone(target)) return `Task ${target.id} already ${target.status}${target.code !== undefined ? ` (exit ${target.code})` : ''}.`;
    } else if (!anyRunning()) {
      return 'No background tasks are running.';
    }

    await new Promise((resolve) => {
      const tick = setInterval(() => {
        const done = args.task_id ? isDone(target) : !anyRunning();
        if (done || Date.now() >= deadline || (signal && signal.aborted)) {
          clearInterval(tick);
          resolve();
        }
      }, 100);
    });

    if (signal && signal.aborted) return 'Interrupted by user';
    const still = Object.values(tasks).filter((t) => t.status === 'running');
    if (args.task_id) {
      if (isDone(target)) {
        return `Task ${target.id} finished: ${target.status}${target.code !== undefined ? ` (exit ${target.code})` : ''}${target.stopReason ? ` — ${target.stopReason}` : ''}.`;
      }
      return `Task ${target.id} still running after ${secs}s.`;
    }
    if (!still.length) return 'All background tasks have finished.';
    const list = still.map((t) => `#${t.id} ${t.description || t.command}`).join('; ');
    return `Timeout after ${secs}s; still running: ${list}`;
  },
};
