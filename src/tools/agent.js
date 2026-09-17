// Agent tool — launch a subagent to handle a task, mirroring kimi-code's Agent.
//
// A subagent is a full Agent instance (same toolbelt, same protocol) with its OWN
// message list. The point is context isolation: the parent gets a conclusion back
// instead of a pile of file dumps.
//
// Supports, like kimi:
//   prompt / description        the task
//   subagent_type               profile name (we keep a small catalog)
//   resume                      continue an earlier subagent by agent id
//   run_in_background           start a background task and return its id
//   fork                        start from a snapshot of THIS conversation
//   model                       run on another configured model
//
// The result is returned as a plain string. A subagent's output is only visible
// to the CALLER, never rendered to the user directly — the parent is expected to
// summarise it.

import { createTask, appendTaskOutput, settleTask } from '../agent-task.js';
import { SUBAGENT_TYPES, DEFAULT_SUBAGENT_TYPE, availableTypes, toolsForSubagent } from '../subagent-types.js';

// Live subagent registry, keyed by agent id. A resumed agent keeps its own
// message list here, which is what makes `resume` work.
const subagents = new Map();
let agentSeq = 0;


export function newAgentId() {
  agentSeq = (agentSeq + 1) % 1e6;
  return `agent-${Date.now().toString(36)}${String(agentSeq).padStart(3, '0')}`;
}

export function getSubagent(id) {
  return subagents.get(id) || null;
}

export function listSubagents() {
  return [...subagents.values()];
}

// Build the system prompt for a subagent: its profile prompt plus the shared
// rules, so a subagent behaves like the main agent within its remit.
function systemPromptFor(type, cfg, systemPrompt) {
  const profile = SUBAGENT_TYPES[type] || SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  const base = (cfg.systemPrompt && String(cfg.systemPrompt).trim()) || systemPrompt;
  return `${profile.prompt}\n\n${base}`;
}

// Run a subagent to completion. `history` seeds its messages (fork). Returns
// { text, usage } or { error }.
// `onProgress(text)` receives the subagent's live output (its reasoning and answer
// stream, and each tool it runs) so the TUI can show it under the `Using Agent`
// row the way Bash's output is shown. `agentId` labels the lines when several
// subagents run at once (AgentSwarm), so the reader can tell them apart.
async function runSubagent({ cfg, type, prompt, history, signal, onEvent, onProgress, agentId }) {
  const { Agent, SYSTEM_PROMPT } = await import('../agent.js');
  const subCfg = {
    ...cfg,
    systemPrompt: systemPromptFor(type, cfg, SYSTEM_PROMPT),
    // The profile narrows the toolbelt (explore / plan / researcher are read-only)
    // and the delegation tools are removed unconditionally — a subagent must not
    // start another agent. `noDelegation` is the hard backstop in agent.js for the
    // case where the model emits a call for a tool it no longer has.
    toolFilter: toolsForSubagent(type, cfg.toolFilter),
    noDelegation: true,
  };
  // fork: the snapshot comes first, then the new instruction.
  const messages = Array.isArray(history) && history.length
    ? [...history, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  let text = '';
  const agent = new Agent({
    cfg: subCfg,
    messages,
    onEvent: (e) => {
      if (e.type === 'data') text += e.text;
      // Mirror what the subagent is actually doing into the parent's transcript:
      // its reasoning and answer stream as `data`/`think`, and every tool it runs
      // arrives as tool_start/tool_result. Without this the `Using Agent …` row sat
      // silent for the whole run — the subagent looked hung.
      if (onProgress) {
        const tag = agentId ? `[${agentId}] ` : '';
        if (e.type === 'data' || e.type === 'think') {
          if (e.text) onProgress(tag + e.text);
        } else if (e.type === 'tool_start') {
          onProgress(`\n${tag}\u25b8 ${e.name}\n`);
        } else if (e.type === 'tool_result') {
          const body = String(e.content == null ? '' : e.content);
          const first = body.split('\n').slice(0, 3).join('\n');
          onProgress(`${tag}${first}${body.split('\n').length > 3 ? '\n\u2026' : ''}\n`);
        } else if (e.type === 'error') {
          onProgress(`\n${tag}[error] ${(e.error && e.error.message) || String(e.error)}\n`);
        }
      }
      if (onEvent) onEvent(e);
    },
    // A subagent never prompts: it inherits the parent's permission mode by
    // running under the same ctx (kimi does the same — approvals belong to the
    // parent turn, not the child).
    onApproval: async () => true,
  });
  if (signal) {
    if (signal.aborted) throw new Error('Interrupted by user');
    signal.addEventListener('abort', () => agent.interrupt(), { once: true });
  }
  await agent.run();
  // The parent must receive ONLY what the subagent concluded — never its tool
  // chatter, and never its reasoning. Two things could leak in:
  //   * the aggregate `data` stream, which also contains intermediate narration;
  //   * an inline `<think>…</think>` block, when a model puts reasoning in the
  //     content stream instead of the separate reasoning channel.
  // So: take the LAST assistant message (the handoff), and strip any think block
  // from it. Fall back to the filtered stream text when there is no message.
  const stripThink = (s) => String(s).replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  const lastAssistant = [...agent.messages].reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && stripThink(m.content));
  const result = (lastAssistant && stripThink(lastAssistant.content)) || stripThink(text) || '(no output)';
  return { text: result, messages: agent.messages };
}

export const spec = {
  name: 'Agent',
  description: `Launch a subagent to handle a task. The subagent runs with its own context, so delegating keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt.
- Investigations (figure out X, find why Y): give the question, not prescribed steps.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance.
- A subagent's result is only visible to you, not to the user. Summarize the relevant parts yourself in your own reply.

When NOT to use Agent:
- Skip delegation for trivial work you can already do directly — reading a file whose path you know, or any task that takes a step or two.
- Do NOT spawn a subagent unless the user, or the applicable AGENTS.md / project instructions, explicitly asks for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do NOT count as permission to spawn. Doing the work yourself is the default.
- Do not delegate the step you are about to be blocked on: if your very next action depends on the result, do it yourself and keep the critical path moving.
- Do not delegate work you are already doing — redelegating an unresumed task duplicates effort instead of saving context.

Available agent types:
${availableTypes()}`,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full task prompt for the subagent.' },
      description: { type: 'string', description: 'Short task description (3-5 words) for UI display.' },
      subagent_type: { type: 'string', description: `One of the available agent types. Defaults to "${DEFAULT_SUBAGENT_TYPE}" when omitted.` },
      resume: { type: 'string', description: 'Optional agent id to resume instead of creating a new instance. Do not also pass subagent_type.' },
      run_in_background: { type: 'boolean', default: false, description: 'If true, return immediately with a task id instead of waiting. The result arrives in the conversation later.' },
      fork: { type: 'boolean', default: false, description: "Start the subagent from a snapshot of this agent's completed conversation history instead of zero context." },
      model: { type: 'string', description: 'A configured model key to run the subagent on, or "primary" for the current model. Ignored when resuming.' },
    },
    required: ['prompt', 'description'],
  },

  async execute(args, ctx) {
    const prompt = String(args.prompt || '').trim();
    const description = String(args.description || '').trim();
    if (!prompt) return 'Error: `prompt` is required.';
    if (!description) return 'Error: `description` is required (short label for the task list).';

    const resumeId = args.resume ? String(args.resume).trim() : '';
    const wantFork = args.fork === true;
    if (resumeId && args.subagent_type) {
      return 'Error: cannot set subagent_type when resuming an existing agent. Resume by agent id only.';
    }
    if (resumeId && wantFork) {
      return 'Error: `fork` cannot be combined with `resume`.';
    }

    // ---- resume an existing subagent -------------------------------------
    let existing = null;
    if (resumeId) {
      existing = subagents.get(resumeId);
      if (!existing) return `Error: no such subagent: ${resumeId}`;
    }

    const type = existing
      ? existing.type
      : (SUBAGENT_TYPES[args.subagent_type] ? args.subagent_type : DEFAULT_SUBAGENT_TYPE);

    // ---- model override ---------------------------------------------------
    // Precedence: the call's own `model` > the user's configured subagent model
    // (/swarm-sub-agent) > the session's model. 'primary' always means "this
    // session's model", so an explicit primary beats a configured default.
    let subCfg = ctx;
    const wantPrimary = args.model === 'primary';
    const explicit = args.model && !wantPrimary && ctx.raw && ctx.raw.models && ctx.raw.models[args.model]
      ? args.model : '';
    const configured = ctx.subagentModel && ctx.raw && ctx.raw.models && ctx.raw.models[ctx.subagentModel]
      ? ctx.subagentModel : '';
    const chosen = wantPrimary ? '' : (explicit || configured);
    if (chosen) {
      const { resolveModelArg } = await import('../config.js');
      subCfg = resolveModelArg(ctx, chosen);
    }

    // ---- fork: snapshot this conversation --------------------------------
    let history = null;
    if (wantFork) {
      history = (ctx._parentMessages || []).filter(
        (m) => m.role !== 'system' && m.role !== 'tool' && typeof m.content === 'string' && m.content.trim(),
      );
    }

    // ---- background -------------------------------------------------------
    if (args.run_in_background === true) {
      const controller = new AbortController();
      const task = createTask(ctx, 'agent', {
        description,
        agentId: null,
        subagentType: type,
        model: args.model || '',
        detached: true,
      });
      task._abort = () => controller.abort();
      const agentId = existing ? existing.id : newAgentId();
      task.agentId = agentId;

      // Fire and forget: the task record carries the result when it lands.
      void (async () => {
        try {
          const run = await runSubagent({
            cfg: subCfg, type, prompt, history,
            signal: controller.signal,
            // No live streaming into the task output: that should read as the
            // subagent's CONCLUSION. `run.text` below is the cleaned final message.
          });
          const entry = existing || { id: agentId, type, messages: [] };
          entry.messages = run.messages;
          entry.type = type;
          subagents.set(agentId, entry);
          appendTaskOutput(task, `\n\n${run.text}`);
          settleTask(task, 'completed');
          if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
        } catch (e) {
          const stopped = controller.signal.aborted;
          settleTask(task, stopped ? 'killed' : 'failed', { stopReason: stopped ? 'Stopped by user' : e.message });
          appendTaskOutput(task, `\n[error: ${e.message}]`);
          if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
        }
      })();

      return `agent_id: ${agentId}\ntask_id: ${task.taskId}\nstatus: running\nnext_step: Continue your work; the result arrives in a later message. Use TaskOutput {task_id: "${task.taskId}"} for a non-blocking check or TaskStop to cancel.`;
    }

    // ---- foreground (the default; Ctrl+B detaches it) ---------------------
    // Registered like Bash's foreground hook so the TUI's ctrl+b can move a long
    // subagent into the background WITHOUT losing its work: the run keeps going,
    // the task record gets the result when it lands, and this call resolves at
    // once with the task id so the parent turn can continue.
    const bgController = new AbortController();
    const onParentAbort = () => bgController.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) return 'Error: the turn was interrupted before the subagent started.';
      ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const agentId = existing ? existing.id : newAgentId();
    const entry = existing || { id: agentId, type, messages: [] };
    subagents.set(agentId, entry);

    let detachedId = null;
    const resetForeground = () => { if (ctx && ctx._foreground && ctx._foreground.detach) ctx._foreground = null; };
    // Start the run BEFORE the detach hook is installed, so the hook's closure can
    // reference the in-flight promise (it waits on it to record the result).
    // `onProgress` feeds the parent's live-output sink (ctx.onOutput), which the
    // agent tags with THIS tool call's id — the same path Bash uses, so the TUI
    // renders the subagent's stream under the `Using Agent` row and Ctrl+O folds it.
    const runPromise = runSubagent({
      cfg: subCfg, type, prompt, history, signal: bgController.signal,
      // `_progressTag` is set by AgentSwarm to the item index, so a swarm's
      // concurrently-running subagents are distinguishable in the live stream.
      // A plain Agent call has no tag and prints its stream unlabelled.
      onProgress: (text) => {
        if (typeof ctx.onOutput !== 'function') return;
        const tag = ctx._progressTag ? `[${ctx._progressTag}] ` : '';
        ctx.onOutput(tag ? text.split('\n').map((l) => (l ? tag + l : l)).join('\n') : text);
      },
    });
    if (ctx) {
      ctx._foreground = {
        kind: 'Agent',
        description,
        detach: () => {
          if (detachedId) return detachedId;
          // Hand the in-flight work to a background task. The controller is NOT
          // aborted, so the subagent keeps running.
          const task = createTask(ctx, 'agent', {
            description, agentId, subagentType: type, model: args.model || '', detached: true,
          });
          task._abort = () => bgController.abort();
          detachedId = task.taskId;
          resetForeground();
          void (async () => {
            try {
              const r = await runPromise;
              entry.messages = r.messages; entry.type = type;
              subagents.set(agentId, entry);
              appendTaskOutput(task, r.text);
              settleTask(task, 'completed');
              if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
            } catch (e) {
              const stopped = bgController.signal.aborted;
              settleTask(task, stopped ? 'killed' : 'failed', { stopReason: stopped ? 'Stopped by user' : e.message });
              appendTaskOutput(task, `\n[error: ${e.message}]`);
              if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
            }
          })();
          return task.taskId;
        },
      };
    }
    let run;
    try {
      run = await runPromise;
    } catch (e) {
      resetForeground();
      // Detached: the background task owns the error now, not this call.
      if (detachedId) return `Moved to background as task #${detachedId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${detachedId}"}.`;
      return `Error: subagent failed: ${e.message}`;
    }
    if (ctx.signal) ctx.signal.removeEventListener('abort', onParentAbort);
    resetForeground();
    if (detachedId) {
      return `Moved to background as task #${detachedId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${detachedId}"}.`;
    }
    entry.messages = run.messages;
    entry.type = type;
    subagents.set(agentId, entry);

    return `agent_id: ${agentId}\n\n${run.text}`;
  },
};