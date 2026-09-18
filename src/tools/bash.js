// Bash tool — mirrors the kimi-code Bash tool schema & behavior.
// Runs commands via PowerShell (pwsh). Supports
// timeout/cwd/run_in_background/disable_timeout. Background tasks are tracked so
// TaskList/TaskOutput can inspect them.

import fs from 'node:fs';
import cp from 'node:child_process';
import { resolvePath, truncateBuf } from './utils.js';
import { createTask, appendTaskOutput, settleTask } from '../agent-task.js';

// kimi-code's timeout policy (agent-core-v2/agent/tools/os/bash/bash.ts).
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 5 * 60;
export const DEFAULT_BACKGROUND_TIMEOUT_S = 10 * 60;
export const MAX_BACKGROUND_TIMEOUT_S = 24 * 60 * 60;



// ---- output sanitizing -------------------------------------------------------
// Captured output can contain terminal control sequences (colours, cursor
// moves, `\r` spinners, bells, …). hncode's renderer passes result strings to
// the terminal verbatim, so a surviving escape fights the differential
// renderer ("text bleeding onto the next row"). It also inflates the token
// count of what we send back to the model. Strip everything a terminal would
// interpret as a command, keeping only `\n` and `\t`.
const OSC_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_RE = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
const ESC_SINGLE_RE = /\u001B(?:[ -/][0-~]|[0-~])/g;
const C0_RE = /[\u0000-\u0008\u000B-\u001F]/g;

export function sanitizeShellOutput(text) {
  const s = String(text ?? '');
  if (!s) return s;
  return s
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_SINGLE_RE, '')
    .replace(C0_RE, '');
}

// PowerShell emits UTF-8 by default, so decode output as UTF-8.
function decodeBuffer(buf) {
  if (buf.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
  }
}
function decodeChunks(chunks) {
  return decodeBuffer(Buffer.concat(chunks));
}

function killTree(child) {
  try {
    const exit = child.exitCode !== null || child.signalCode !== null;
    if (exit || child.killed) return;
    if (process.platform === 'win32') {
      try { cp.spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
}

export const spec = {
  name: 'Bash',
  description: 'Run a shell command via pwsh. Returns combined stdout+stderr. timeout default 60s (max 300s); run_in_background detaches and returns a task id.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.' },
      description: { type: 'string', description: 'Short description (shown in task lists; required for background tasks).' },
      timeout: { type: 'integer', minimum: 1, description: 'Seconds before the command is killed. Foreground default 60s/max 300s; background default 600s/max 86400s.' },
      cwd: { type: 'string', description: 'Working directory (default: workspace/project root).' },
      run_in_background: { type: 'boolean', default: false, description: 'Run detached and return a task id instead of waiting.' },
      disable_timeout: { type: 'boolean', default: false, description: 'Disable the timeout (background only).' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    if (!args.command || !String(args.command).length) return 'Command cannot be empty.';
    const cwdRaw = args.cwd || ctx.workspace;
    let cwd;
    try { cwd = resolvePath(cwdRaw, ctx); } catch (e) { return e.message; }
    if (!fs.existsSync(cwd)) return `Error: cwd does not exist: ${cwdRaw}`;

    if (args.run_in_background) return spawnBackground(args, cwd, ctx);

    const bg = false;
    const cap = bg ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
    const def = bg ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
    const timeoutMs = args.disable_timeout ? undefined : Math.min(args.timeout ?? def, cap) * 1000;
    const command = args.command;
    // stdin is 'ignore' (NUL / /dev/null): leaving it as an open pipe made any
    // command that reads stdin (`cat`, `npm init`, …) block until the timeout.
    const child = cp.spawn('pwsh', ['-Command', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let settled = false;
    // Live stream sink: hand decoded output to the agent (ctx.onOutput) so the UI
    // can show a running command's output in real time, exactly like the
    // finished "Used Bash" row does. Foreground runs only — a background task's
    // output is read through TaskOutput.
    //
    // Decoding is STREAMING (a multi-byte char can be split across chunks) and
    // sanitizing runs over the whole accumulated text, then only the NEW tail is
    // emitted: stripping per-chunk would cut an escape sequence in half and leak
    // the remainder into the display.
    const sink = typeof ctx.onOutput === 'function' ? ctx.onOutput : null;
    const liveDecoder = sink ? new TextDecoder('utf-8') : null;
    let liveAcc = '';
    let liveSent = 0;
    const push = (d) => {
      chunks.push(d);
      if (!sink || settled) return;
      try {
        liveAcc += liveDecoder.decode(d, { stream: true });
        const clean = sanitizeShellOutput(liveAcc);
        if (clean.length > liveSent) {
          const delta = clean.slice(liveSent);
          liveSent = clean.length;
          sink(delta);
        }
      } catch {}
    };
    if (child.stdout) child.stdout.on('data', push);
    if (child.stderr) child.stderr.on('data', push);

    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { killTree(child); }, timeoutMs);

    // Esc / Ctrl-C in the TUI aborts the turn: kill the running command too,
    // otherwise a long command keeps running after the user interrupted.
    const signal = ctx.signal;
    const onAbort = () => { killTree(child); };
    if (signal) {
      if (signal.aborted) return 'Interrupted by user';
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    return new Promise((resolve) => {
      // Expose a detach hook so the TUI's ctrl+b can move a long-running
      // foreground command into the background WITHOUT killing it: the child
      // keeps running, gets registered as a task, and this promise resolves
      // immediately with a "moved to background" note so the agent continues.
      if (ctx) {
        ctx._foreground = {
          command: args.command,
          description: args.description || args.command,
          child, chunks,
          detach: () => {
            if (settled) return null;
            settled = true;
            cleanup();
            // Stop treating this as foreground: drop the abort listener so an
            // Esc after detaching does not kill the now-background task.
            if (signal) signal.removeEventListener('abort', onAbort);
            const id = registerBackgroundTask(args, child, ctx, chunks);
            resolve(`Moved to background as task #${id}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${id}"}.`);
            return id;
          },
        };
      }
      child.on('close', (code) => {
        cleanup();
        if (ctx) ctx._foreground = null;
        if (settled) return;
        settled = true;
        if (signal && signal.aborted) { resolve('Interrupted by user'); return; }
        let out = truncateBuf(sanitizeShellOutput(decodeChunks(chunks)));
        out += `\n[exit code: ${code === null ? 'killed' : code}]`;
        resolve(out);
      });
      child.on('error', (e) => {
        cleanup();
        if (ctx) ctx._foreground = null;
        if (settled) return;
        settled = true;
        resolve(truncateBuf(sanitizeShellOutput(decodeChunks(chunks))) + `\n[error: ${e.message}]`);
      });
    });
  },
};

// Register an already-spawned child (foreground -> background detach) as a task.
// Reuses the same task shape and lazy output decoding as spawnBackground. The
// foreground path's existing stdout/stderr listeners keep writing into the SAME
// `existingChunks` array the task reads, so we must NOT add new listeners here
// (doing so doubled every line of output).
function registerBackgroundTask(args, child, ctx, existingChunks) {
  const task = createTask(ctx, 'process', {
    description: args.description || args.command,
    command: args.command,
    pid: child.pid,
    detached: true,
    _chunks: existingChunks || [],
  });
  defineOutput(task);
  child.on('close', (code) => {
    // A task already settled (TaskStop -> 'killed') keeps its status; the
    // process's non-zero kill exit must not relabel a deliberate stop.
    if (task.status === 'running') {
      settleTask(task, code === 0 ? 'completed' : 'failed', { exitCode: code });
    } else {
      task.exitCode = code;
    }
  });
  return task.taskId;
}

function spawnBackground(args, cwd, ctx) {
  const command = args.command;
  // Detached + piped stdio is not a real detach: when the parent exits, the
  // pipes close and the child gets SIGPIPE. Redirect stdout/stderr to the
  // task's output file instead, so the process survives and TaskOutput can
  // still read it. (In the TUI the parent rarely exits, but headless -p mode
  // does, and a background job should outlive the prompt.)
  const child = cp.spawn('pwsh', ['-Command', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const task = createTask(ctx, 'process', {
    description: args.description || args.command,
    command: args.command,
    pid: child.pid,
    detached: true,
  });
  defineOutput(task);
  const push = (d) => appendTaskOutput(task, d);
  if (child.stdout) child.stdout.on('data', push);
  if (child.stderr) child.stderr.on('data', push);
  child.on('close', (code) => {
    if (task.status === 'running') {
      settleTask(task, code === 0 ? 'completed' : 'failed', { exitCode: code });
    } else {
      task.exitCode = code;
    }
  });
  // Background timeout: default 600s, capped at 86400s; `disable_timeout` removes
  // it. The timer is unref'd so it never keeps the process alive on its own.
  if (!args.disable_timeout) {
    const bgTimeoutMs = Math.min(args.timeout ?? DEFAULT_BACKGROUND_TIMEOUT_S, MAX_BACKGROUND_TIMEOUT_S) * 1000;
    const t = setTimeout(() => {
      killTree(child);
      settleTask(task, 'timed_out', { stopReason: 'timed out' });
    }, bgTimeoutMs);
    if (t.unref) t.unref();
  }
  child.unref();
  return `Background task ${task.taskId} started (pid ${child.pid}): ${args.description || args.command}
Inspect with TaskList (running tasks) and TaskOutput {task_id: "${task.taskId}"} (output).`;
}

// Lazy output: the accumulated bytes are decoded only when actually read, so a
// chatty background task costs nothing until queried.
function defineOutput(task) {
  Object.defineProperty(task, 'output', {
    enumerable: true,
    get() { return sanitizeShellOutput(decodeChunks(this._chunks)); },
  });
}
