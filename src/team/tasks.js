// The shared task list. One file per team, read and written by every member.
//
//   ~/.hncode/tasks/<team>/tasks.json   ->  Task[]
//
// WHY A SINGLE FILE RATHER THAN ONE PER TASK
// ------------------------------------------
// The list is what members read to decide what to do next: "is anything unclaimed", "am I
// blocking someone". That question spans the whole list, so keeping it in one file makes the
// common read a single parse instead of a directory walk with a parse per entry. A team's list
// is small (tens of entries); it is not a work queue with thousands of items.
//
// CLAIMING IS A COMPARE-AND-SWAP
// ------------------------------
// Two members polling at the same moment must not both take the same task. The claim re-reads
// the file, checks the owner is still unset, and only then writes — and because the write is a
// temp-file rename (see mailbox.js), the loser's write is the one that sees the winner's.
import fs from 'node:fs';
import path from 'node:path';
import { teamTasksDir } from './store.js';

export const TASK_STATES = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'];

function tasksFile(teamName) {
  return path.join(teamTasksDir(teamName), 'tasks.json');
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to salvage */ }
    throw e;
  }
}

/** Every task, oldest first. Never throws. */
// Cached by (mtimeMs, size) — the team panel reads the task list every frame,
// and a stat per read replaces the full readFileSync + JSON.parse. writeTasks
// goes through writeAtomic (rename), which always changes the mtime.
let _tasksCache = { key: '', tasks: null };
export function readTasks(teamName) {
  const file = tasksFile(teamName);
  let st = null;
  try { st = fs.statSync(file); } catch { /* absent */ }
  if (!st) return [];
  const key = `${st.mtimeMs}:${st.size}`;
  if (_tasksCache.key === key) return _tasksCache.tasks.slice();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tasks = Array.isArray(parsed) ? parsed : [];
    _tasksCache = { key, tasks };
    return tasks.slice();
  } catch {
    _tasksCache = { key: '', tasks: null };
    return [];
  }
}

function writeTasks(teamName, tasks) {
  writeAtomic(tasksFile(teamName), JSON.stringify(tasks, null, 2));
  return tasks;
}

/** The next id, derived from what is already there so a restart cannot reuse one. */
function nextId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const n = Number(String(t.id || '').replace(/^#/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `#${max + 1}`;
}

/**
 * Add a task and return it.
 *
 * `blockedBy` names other task ids. Kept as plain ids rather than resolved objects so a task can
 * reference one that is not created yet — which is how a plan is written down in order.
 */
export function createTask(teamName, { subject, description = '', owner = null, blockedBy = [], createdBy = '' }) {
  const tasks = readTasks(teamName);
  const task = {
    id: nextId(tasks),
    subject: String(subject || '').trim() || '(untitled)',
    description: String(description || ''),
    status: 'pending',
    owner: owner || null,
    blockedBy: Array.isArray(blockedBy) ? blockedBy.map(String) : [],
    createdBy: String(createdBy || ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.push(task);
  writeTasks(teamName, tasks);
  return task;
}

/** Update fields on a task. Returns the updated task, or null when the id is unknown. */
export function updateTask(teamName, id, patch) {
  const tasks = readTasks(teamName);
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const next = { ...tasks[i], ...patch, updatedAt: Date.now() };
  if (patch.status && !TASK_STATES.includes(patch.status)) return null;
  tasks[i] = next;
  writeTasks(teamName, tasks);
  return next;
}

/**
 * Take a task, but only if nobody else has.
 *
 * Returns `{ ok: true, task }` on success, or `{ ok: false, reason }` naming what stopped it —
 * a caller that cannot say WHY a claim failed leaves the model guessing between "someone beat
 * me to it" and "that task does not exist", and the two need different next actions.
 */
export function claimTask(teamName, id, agentName) {
  const tasks = readTasks(teamName);
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return { ok: false, reason: `no task ${id}` };

  const t = tasks[i];
  if (t.status === 'completed') return { ok: false, reason: `${id} is already completed` };
  if (t.status === 'cancelled') return { ok: false, reason: `${id} was cancelled` };
  if (t.owner && t.owner !== agentName) return { ok: false, reason: `${id} is already owned by ${t.owner}` };

  // Blocked by another task that is not done. The dependency is the point of writing it down.
  const blocking = (t.blockedBy || []).filter((dep) => {
    const d = tasks.find((x) => x.id === dep);
    return d && d.status !== 'completed' && d.status !== 'cancelled';
  });
  if (blocking.length) return { ok: false, reason: `${id} is blocked by ${blocking.join(', ')}` };

  tasks[i] = { ...t, owner: agentName, status: 'in_progress', updatedAt: Date.now() };
  writeTasks(teamName, tasks);
  return { ok: true, task: tasks[i] };
}

/** Release a task back to the pool, keeping its history. */
export function releaseTask(teamName, id, agentName) {
  const t = readTasks(teamName).find((x) => x.id === id);
  if (!t) return { ok: false, reason: `no task ${id}` };
  if (t.owner && t.owner !== agentName) return { ok: false, reason: `${id} is owned by ${t.owner}, not ${agentName}` };
  return { ok: true, task: updateTask(teamName, id, { owner: null, status: 'pending' }) };
}

/** The tasks nobody has taken, in order. */
export function unclaimedTasks(teamName) {
  return readTasks(teamName).filter((t) => !t.owner && t.status === 'pending');
}

/**
 * The list as a model should read it.
 *
 * Compact and aligned rather than JSON: this goes into a prompt on every step, and the model
 * needs the id, the state and the subject — not the timestamps or the creator.
 */
export function formatTasks(tasks) {
  if (!tasks.length) return 'No tasks.';
  const w = Math.max(...tasks.map((t) => t.id.length));
  return tasks.map((t) => {
    const owner = t.owner ? ` @${t.owner}` : '';
    const blocked = (t.blockedBy || []).length ? ` (blocked by ${t.blockedBy.join(', ')})` : '';
    return `${t.id.padEnd(w)}  ${t.status.padEnd(11)} ${t.subject}${owner}${blocked}`;
  }).join('\n');
}

/** Counts per state, for a one-line summary. */
export function taskSummary(tasks) {
  const out = {};
  for (const s of TASK_STATES) out[s] = 0;
  for (const t of tasks) if (t.status in out) out[t.status]++;
  return out;
}
