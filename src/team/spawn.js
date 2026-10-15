// Spawning a teammate and registering it as a background task.
//
// This is the equivalent of Claude Code's `spawnInProcessTeammate`: it creates the identity,
// registers a task so the roster and `TaskList` can see it, and starts the run — without
// awaiting it, because a teammate that blocks its lead's turn is not a teammate.
//
// THE TASK IS THE HANDLE
// ----------------------
// The registry is how everything else reaches a running teammate: `TaskList` lists them,
// `TaskOutput` reads what they have said, `TaskStop` aborts one. Reusing it rather than adding a
// parallel registry means a teammate shows up wherever background work already does.
import { createTask, settleTask, appendTaskOutput } from '../agent-task.js';
import { runAs, makeIdentity } from './context.js';
import { runTeammate } from './runner.js';
import { addMember, setMemberActive } from './team.js';
import { updateMember } from './store.js';
import { readTeamFile } from './store.js';
import { TEAMMATE_MAX_STEPS } from './constants.js';

/** Live teammates, by agent id. The abort handle and the running promise. */
const running = new Map();

/** Every teammate currently running. */
export function liveTeammates() {
  return [...running.values()].map((r) => ({ name: r.name, teamName: r.teamName, taskId: r.taskId }));
}

/** Is a teammate with this name already running on this team? */
export function isRunning(teamName, name) {
  return [...running.values()].some((r) => r.teamName === teamName && r.name === name);
}

/**
 * Spawn one teammate.
 *
 * Returns as soon as it is RUNNING — the promise it hands back resolves when the teammate
 * finishes, and the caller is expected to not await it. Everything that needs to observe progress
 * goes through the task registry.
 */
export function spawnTeammate({
  teamName,
  name,
  prompt = '',
  agentType = 'general',
  model = '',
  cfg,
  toolNote,
  // 0 = the member waits for work indefinitely; see `waitForMail`. The old default made a
  // teammate quit after two quiet minutes, so a later instruction had nobody to reach.
  idleTimeoutMs = 0,
  maxSteps = TEAMMATE_MAX_STEPS,
  cwd,
  onEvent,
  tasks,
}) {
  const team = readTeamFile(teamName);
  if (!team) return { ok: false, error: `no team "${teamName}"` };
  if (isRunning(teamName, name)) return { ok: false, error: `"${name}" is already running` };

  // Join the roster ONLY if this name is not on it yet.
  //
  // `/team add` calls `addMember` itself and THEN calls this spawner, so an unconditional second
  // `addMember` here ran for a name the roster already held — and for the team's FIRST member
  // that name IS `leadName`, which `addMember` refuses (`"…" is the lead of this team`). So the
  // spawn failed and the member stayed a roster row with `taskId: null`: no agent, nothing that
  // reads its inbox, and no reply to anything sent to it. That is the bug behind "I made a team
  // and it never answers".
  //
  // A name that is already there is REUSED rather than re-added. `addMember` is still the way in
  // for a caller that has not joined the member yet (the model's TeamCreate tool spawns names
  // that are already on the roster too, and a direct API use may not be).
  const existing = team.members.find((m) => m.name === name);
  let member;
  if (existing) {
    member = existing;
  } else {
    const added = addMember(teamName, { name, agentType, model, prompt, cwd });
    if (!added.ok) return { ok: false, error: added.error };
    member = added.member;
  }

  // Registered like any other background task, so `TaskList` finds it.
  // Registered in the CALLER's registry, not a fresh object: a task nothing can see is a
  // task that never appears in TaskList. `{ tasks: {} }` was that mistake.
  const registry = tasks || {};
  const task = createTask({ tasks: registry }, 'teammate', {
    description: `${name}: ${String(prompt || 'waiting for work').slice(0, 60)}`,
    teamName,
    memberName: name,
    agentId: member.agentId,
  });

  // The member must point at its task, because `runTeammate` looks the task up BY that id.
  // Leaving it unset sent the teammate to the unclaimed pool — empty on a fresh team — and it
  // opened by asking the lead for work.
  updateMember(teamName, name, { taskId: task.taskId });
  const identity = makeIdentity({
    name,
    teamName,
    color: member.color,
    agentType,
    model,
  });

  const abort = { aborted: false, listeners: [] };
  const controller = {
    abort() { abort.aborted = true; for (const l of abort.listeners) { try { l(); } catch { /* best effort */ } } },
    get signal() { return abort; },
  };

  appendTaskOutput(task, `[${name}] started on team "${teamName}"\n`);
  onEvent && onEvent({ type: 'start', name, teamName, taskId: task.taskId, color: member.color });

  // The run, wrapped in its own async identity. NOT awaited: the lead continues its turn while
  // the teammate works, and the result arrives as a message.
  // What this teammate runs ON. The per-member choice wins, then the subagent model, then the
  // session's — the same order the chooser describes, so the row the user picked is the model
  // that answers. `cfg.model` is what `new Agent` reads; putting the name only on the identity
  // made the chooser cosmetic.
  const runCfg = {
    ...cfg,
    model: member.model || cfg.subagentModel || cfg.model,
  };
  let ok = false;
  const promise = runAs(identity, async () => {
    try {
      const result = await runTeammate({
        teamName,
        memberName: name,
        cfg: runCfg,
        maxSteps,
        idleTimeoutMs,
        toolNote: (who, toolName, args) => {
          appendTaskOutput(task, `[${who}] ${toolName}\n`);
          toolNote && toolNote(who, toolName, args);
          onEvent && onEvent({ type: 'tool', name: who, tool: toolName });
        },
        shouldStop: () => abort.aborted,
        onStart: () => onEvent && onEvent({ type: 'working', name }),
        onFinish: () => onEvent && onEvent({ type: 'idle', name }),
      });
      ok = true;
      appendTaskOutput(task, `[${name}] finished${result.idle ? ' (idle timeout)' : ''}\n`);
      onEvent && onEvent({ type: 'finish', name, result });
      return result;
    } catch (e) {
      const message = (e && e.message) || String(e);
      appendTaskOutput(task, `[${name}] failed: ${message}\n`);
      onEvent && onEvent({ type: 'error', name, error: message });
      return { ok: false, error: message };
    } finally {
      // Settled with the OUTCOME. `settleTask` only touches a task that is still
      // running, so a stop that already claimed it keeps its own status — but a
      // teammate that threw was settled as 'completed', which put a green check on
      // the panel next to a failure log line.
      settleTask(task, ok ? 'completed' : 'failed');
      running.delete(member.agentId);
      setMemberActive(teamName, name, false);

      // The member STAYS on the roster, and its inbox stays on disk.
      //
      // This used to call `removeTeammate`, on the reasoning that a finished teammate's name
      // would make a later SendMessage look deliverable. That got it backwards: the name IS
      // deliverable, because the member is idle and waiting — `runTeammate` ends its loop only
      // when the team is stopping it. Removing it instead destroyed the roster entry AND the
      // inbox (`removeTeammate` clears the mailbox), so an agent that had reported in and was
      // waiting for an assignment disappeared along with anything it had said. That is why a
      // team of four came back as one lead with no members and no mail.
      //
      // A member is taken off the roster by an explicit act: `TeamDelete`, `disbandTeam`, or
      // the user's `/team remove`.
    }
  });

  running.set(member.agentId, {
    name,
    teamName,
    taskId: task.taskId,
    controller,
    teamName,
    taskId: task.taskId,
    controller,
    promise,
    color: member.color,
  });

  return { ok: true, member, taskId: task.taskId, promise, controller };
}

/**
 * Spawn several, tolerating individual failures.
 *
 * One bad name must not stop the rest: a lead that asked for four members and got one is worse
 * off than one that got three and was told which failed.
 */
export function spawnMany(teamName, members, opts) {
  const started = [];
  const failed = [];
  for (const m of members) {
    const r = spawnTeammate({ teamName, cwd: opts.cwd, cfg: opts.cfg, toolNote: opts.toolNote, onEvent: opts.onEvent, ...m });
    if (r.ok) started.push({ name: m.name, taskId: r.taskId });
    else failed.push({ name: m.name, error: r.error });
  }
  return { started, failed };
}

/** Stop a teammate by name. Returns false when nothing was running under it. */
export function stopTeammate(teamName, name) {
  for (const [id, r] of running) {
    if (r.teamName === teamName && r.name === name) {
      r.controller.abort();
      running.delete(id);
      return true;
    }
  }
  return false;
}

/** Stop every teammate on a team. Used when the team is dissolved. */
export function stopTeam(teamName) {
  let n = 0;
  for (const [id, r] of running) {
    if (r.teamName !== teamName) continue;
    r.controller.abort();
    running.delete(id);
    n++;
  }
  return n;
}

/**
 * Wait for every teammate on a team to finish.
 *
 * Bounded, because a teammate that is idle-waiting will not finish on its own — the lead asking
 * "are they done" must get an answer even if the answer is "no".
 */
export async function waitForTeam(teamName, timeoutMs = 60_000) {
  const mine = [...running.values()].filter((r) => r.teamName === teamName);
  if (!mine.length) return { done: 0, pending: 0 };
  const all = Promise.allSettled(mine.map((r) => r.promise));
  const raced = await Promise.race([
    all.then(() => true),
    new Promise((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
  const pending = [...running.values()].filter((r) => r.teamName === teamName).length;
  return { done: raced ? mine.length : mine.length - pending, pending, timedOut: !raced };
}
