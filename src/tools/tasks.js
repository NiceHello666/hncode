// TaskList / TaskOutput / TaskStop / TaskWait — manage background tasks spawned
// by Bash (run_in_background) and Agent (run_in_background). The task records
// live in the shared registry (src/agent-task.js), so the CLI tools and the
// /tasks panel read exactly the same data.

import cp from 'node:child_process';
import { isTerminal, settleTask, STATUS_LABEL } from '../agent-task.js';

function taskLine(t) {
  const extra = t.stopReason ? ` (${t.stopReason})` : '';
  const label = STATUS_LABEL[t.status] || t.status;
  const what = t.kind === 'process' ? (t.description || t.command) : t.description;
  return `#${t.taskId} [${label}${extra}] pid=${t.pid || '-'} ${what}`;
}

export const TaskListSpec = {
  name: 'TaskList',
  description: 'List background tasks (from Bash or Agent run_in_background). Reports task id, status, description.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args, ctx) {
    const tasks = Object.values(ctx.tasks || {}).sort((a, b) => b.startedAt - a.startedAt);
    if (tasks.length === 0) return 'No background tasks.';
    return tasks.map(taskLine).join('\n');
  },
};

export const TaskOutputSpec = {
  name: 'TaskOutput',
  description: 'Get the output of a background task by task_id. head_limit caps the lines returned.',
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
    const text = t.output || '';
    const lines = text ? text.split('\n').filter((l) => l.length > 0) : [];
    const capped = args.head_limit ? lines.slice(0, args.head_limit) : lines;
    const tail = lines.length > capped.length;
    const label = STATUS_LABEL[t.status] || t.status;
    let out = `#${t.taskId} [${label}] (pid ${t.pid || '-'})\n${capped.join('\n')}`;
    if (tail) out += `\n... [${lines.length - capped.length} more lines; use head_limit]`;
    return out;
  },
};

export const TaskStopSpec = {
  name: 'TaskStop',
  description: 'Stop a running background task by task_id. Use only when the task must be cancelled.',
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
    if (isTerminal(t.status)) return `Task ${t.taskId} already ${STATUS_LABEL[t.status] || t.status}.`;
    const reason = args.reason || 'Stopped by TaskStop';
    try {
      // An agent task aborts through its controller; a process is killed.
      if (t.kind === 'agent' && typeof t._abort === 'function') {
        t._abort();
      } else if (t.pid) {
        if (process.platform === 'win32') {
          try { cp.spawnSync('taskkill', ['/pid', String(t.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
        } else {
          try { process.kill(t.pid, 'SIGTERM'); } catch {}
        }
      }
    } catch (e) {
      return `Failed to stop ${t.taskId}: ${e.message}`;
    }
    // 'killed' — a deliberate stop, distinct from a failure (kimi's vocabulary).
    settleTask(t, 'killed', { stopReason: reason });
    return `Stopped task ${t.taskId}. reason: ${reason}`;
  },
};

// Wait for background tasks to finish. A timeout is not an error; the result
// lists the tasks still running so the caller can wait again.
export const TaskWaitSpec = {
  name: 'TaskWait',
  description: 'Wait for background tasks to finish, timeout in seconds (1-600). With task_id, waits for that task; without it, returns when any running task finishes. A timeout is not an error; still-running tasks are listed, so you may call it again.',
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

    const isDone = (t) => t && isTerminal(t.status);
    const anyRunning = () => Object.values(tasks).some((t) => t.status === 'running');

    if (args.task_id) {
      if (isDone(target)) return `Task ${target.taskId} already ${STATUS_LABEL[target.status] || target.status}${target.exitCode != null ? ` (exit ${target.exitCode})` : ''}.`;
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
        return `Task ${target.taskId} finished: ${STATUS_LABEL[target.status] || target.status}${target.exitCode != null ? ` (exit ${target.exitCode})` : ''}${target.stopReason ? ` — ${target.stopReason}` : ''}.`;
      }
      return `Task ${target.taskId} still running after ${secs}s.`;
    }
    if (!still.length) return 'All background tasks have finished.';
    const list = still.map((t) => `#${t.taskId} ${t.description || t.command || ''}`).join('; ');
    return `Timeout after ${secs}s; still running: ${list}`;
  },
};
