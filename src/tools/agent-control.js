// Tools for controlling a RUNNING subagent: list, message, interrupt, close.
//
// WHY THESE ARE SEPARATE FROM TaskList / TaskStop
// ----------------------------------------------
// `TaskStop` cancels a background task by task_id, and for an agent that means aborting
// its controller — the whole run dies. There was no way to do the thing a person actually
// asks for while watching a subagent work: tell it something, and let it continue. And
// there was no way to stop ONE subagent of a swarm without stopping the turn that started
// them, because `TaskStop` needs a task id that only the background path creates.
//
// These tools address agents by AGENT id (or run id, or task id — whichever the caller
// has), which is the identifier `Agent` prints and `AgentSwarm` reports, so the model can
// act on what it just started without a lookup table.
//
// `AgentMessage` uses the same `steer` path as the TUI's Ctrl+S: the message lands when
// the subagent's in-flight tool calls finish. That is the only safe moment to change a
// run's instructions, and it is what makes "keep going, but also do X" meaningful.

import { listRuns, sendToRun, interruptRun, interruptAll, closeRun, describeRuns } from '../subagent-control.js';

export const AgentListSpec = {
  name: 'AgentList',
  description: `List the subagents that are running RIGHT NOW, with the id to address each one.

Use this before AgentMessage / AgentInterrupt / AgentClose when you do not already hold the id. A subagent that has finished is not listed — it is no longer controllable, and its result is already in this conversation (or in TaskOutput for a background run).`,
  parameters: { type: 'object', properties: {} },
  async execute() {
    const runs = listRuns();
    if (!runs.length) return 'No subagent is running.';
    return describeRuns().join('\n');
  },
};

export const AgentMessageSpec = {
  name: 'AgentMessage',
  description: `Send a message to a RUNNING subagent without stopping it.

The text is injected when the subagent's in-flight tool calls finish — the same point the user's own steering messages land — so it changes the run's instructions rather than interrupting them. Use it to redirect work ("skip the tests for now"), to add a constraint, or to correct a wrong assumption you can see in its stream.

Identify the subagent by its agent_id (what \`Agent\` returned, or what AgentSwarm reported), its run id, or its task id. Use AgentList if you have none of them.`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'The subagent to message: agent_id, run id, or task_id.' },
      message: { type: 'string', description: 'What to tell it. Delivered as a steering message.' },
    },
    required: ['agent_id', 'message'],
  },
  async execute(args) {
    const r = sendToRun(args.agent_id, args.message);
    return r.ok ? r.message : `Error: ${r.message}`;
  },
};

export const AgentInterruptSpec = {
  name: 'AgentInterrupt',
  description: `Stop ONE running subagent, leaving everything else alone.

Prefer this over TaskStop for a subagent: TaskStop works on a background task id and cancels the whole run, while this reaches the subagent directly and needs only the agent id. Omit \`agent_id\` to stop EVERY running subagent, which is the way out when a swarm has gone wrong.

Brief the model on what the agent had established before stopping it: a subagent's partial work is not written anywhere you can read afterwards.`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'The subagent to stop. Omit to stop all of them.' },
      reason: { type: 'string', description: 'Short reason, for the transcript.' },
    },
  },
  async execute(args) {
    const ref = args && args.agent_id ? String(args.agent_id).trim() : '';
    if (!ref) {
      const all = interruptAll();
      return all.ok
        ? `Interrupted ${all.count} subagent(s): ${all.agents.join(', ')}`
        : 'No subagent is running.';
    }
    const r = interruptRun(ref);
    return r.ok ? r.message : `Error: ${r.message}`;
  },
};

export const AgentCloseSpec = {
  name: 'AgentClose',
  description: `Interrupt a subagent AND remove it from the running list immediately.

Use this when you stopped a subagent and no longer want it in AgentList. An interrupted run is removed when its await unwinds, which is asynchronous, so a listing right afterwards can still show it; close removes it at once. The subagent's CONVERSATION is kept, so a later \`Agent\` call can still \`resume\` it.`,
  parameters: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'The subagent to close.' },
    },
    required: ['agent_id'],
  },
  async execute(args) {
    const r = closeRun(args.agent_id);
    return r.ok ? r.message : `Error: ${r.message}`;
  },
};
