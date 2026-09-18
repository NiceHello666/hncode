// AgentSwarm tool — launch many subagents from ONE prompt template, mirroring
// kimi-code's AgentSwarm.
//
//   prompt_template: 'Review {{item}} for regressions.'
//   items: ['src/a.ts', 'src/b.ts']        -> two subagents
//
// Enforced rules (same as kimi):
//   * at least 2 items unless resume_agent_ids is given
//   * whenever items are present, prompt_template is required and must contain
//     the {{item}} placeholder
//   * the filled-in prompts must be distinct
//   * at most 128 items
//   * swarm runs are queued, so a large swarm does not spawn 128 processes at once

import { spec as agentSpec } from './agent.js';
import { SUBAGENT_TYPES, DEFAULT_SUBAGENT_TYPE } from '../subagent-types.js';
import { createTask, appendTaskOutput, settleTask } from '../agent-task.js';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;
// How many subagents run at once. kimi queues launches automatically; we use a
// small fixed window so a 128-item swarm cannot stampede the machine.
const SWARM_CONCURRENCY = 4;

// Validate and expand the swarm request. Returns { prompts } or { error }.
export function planSwarm(args) {
  const items = Array.isArray(args.items) ? args.items.map((s) => String(s).trim()).filter(Boolean) : [];
  const template = args.prompt_template == null ? '' : String(args.prompt_template);
  // `typeof [] === 'object'`, so an array was previously accepted and turned
  // into [['0', ...], ['1', ...]] — the swarm then tried to resume agents
  // named "0"/"1". Require a plain object.
  const resumeMap = (args.resume_agent_ids
    && typeof args.resume_agent_ids === 'object'
    && !Array.isArray(args.resume_agent_ids))
    ? Object.entries(args.resume_agent_ids).map(([id, p]) => [String(id).trim(), String(p).trim()])
    : [];

  if (items.length === 0 && resumeMap.length === 0) {
    return { error: 'Error: provide at least 2 items, or a resume_agent_ids map.' };
  }
  if (items.length === 1 && resumeMap.length === 0) {
    return { error: 'Error: at least 2 items are required (a single task should use the Agent tool instead).' };
  }
  if (items.length > MAX_AGENT_SWARM_SUBAGENTS) {
    return { error: `Error: at most ${MAX_AGENT_SWARM_SUBAGENTS} subagents per swarm (got ${items.length}).` };
  }
  if (items.length > 0 && !template.trim()) {
    return { error: 'Error: `prompt_template` is required whenever `items` are present.' };
  }
  if (items.length > 0 && !template.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    return { error: `Error: \`prompt_template\` must contain the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.` };
  }
  const prompts = items.map((it) => template.split(PROMPT_TEMPLATE_PLACEHOLDER).join(it));
  const uniq = new Set(prompts);
  if (uniq.size !== prompts.length) {
    return { error: 'Error: two items expand to the same prompt — make each item distinct.' };
  }
  return { prompts, resumeMap };
}

export const spec = {
  name: 'AgentSwarm',
  description: `Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`${PROMPT_TEMPLATE_PLACEHOLDER}\`. For example, with \`prompt_template\` set to \`Review ${PROMPT_TEMPLATE_PLACEHOLDER} for likely regressions.\` and \`items\` set to \`["src/a.ts", "src/b.ts"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.

Use \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call. Do not duplicate resumed work in \`items\`.

Each of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`${PROMPT_TEMPLATE_PLACEHOLDER}\`; and the filled-in prompts must be distinct.

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to ${MAX_AGENT_SWARM_SUBAGENTS} subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

When NOT to use AgentSwarm:
- Never call this on your own initiative. It requires the same explicit permission as \`Agent\`: the user, or the applicable AGENTS.md / project instructions, must have asked for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do NOT count as permission.
- Do not use it for two or three differently-shaped tasks: use separate \`Agent\` calls instead, which can run in parallel in one message.
- Do not use it to fan out work you could finish yourself in a few steps.

If \`AgentSwarm\` is called, that call must be the only tool call in the response.`,
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description for the whole swarm.' },
      subagent_type: { type: 'string', description: `Subagent type used for every new subagent spawned from items; defaults to ${DEFAULT_SUBAGENT_TYPE}.` },
      prompt_template: { type: 'string', description: `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.` },
      items: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_AGENT_SWARM_SUBAGENTS,
        description: `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      },
      fork: { type: 'boolean', default: false, description: "Fork the current context for every item-spawned subagent: each starts with a snapshot of this agent's completed conversation history." },
      resume_agent_ids: { type: 'object', description: 'Map of existing subagent agent_id to the prompt used to resume that subagent. Resumed subagents are launched before new item-based subagents.' },
      model: { type: 'string', description: 'Which model to run the item-spawned subagents on, or "primary" for the current model.' },
    },
    required: ['description'],
  },

  async execute(args, ctx) {
    const description = String(args.description || '').trim();
    if (!description) return 'Error: `description` is required.';

    const plan = planSwarm(args);
    if (plan.error) return plan.error;

    const type = SUBAGENT_TYPES[args.subagent_type] ? args.subagent_type : DEFAULT_SUBAGENT_TYPE;

    // Build the work list: resumes first (kimi launches them before new items).
    const jobs = [
      ...plan.resumeMap.map(([agentId, prompt]) => ({ kind: 'resume', agentId, prompt })),
      ...plan.prompts.map((prompt) => ({ kind: 'new', prompt })),
    ];

    // The swarm runs in the FOREGROUND by default, like Bash and Agent: this call
    // does not return until every subagent has finished, so the turn waits for the
    // result. The task record exists from the start so Ctrl+B can hand the run to
    // the background mid-flight (the TUI's ctrl+b calls `ctx._foreground.detach`).
    const task = createTask(ctx, 'agent', {
      description: `${description} (${jobs.length} subagents)`,
      subagentType: type,
      model: args.model || '',
      detached: false,
    });

    // Run with a bounded window. Each job appends its verdict to the task output
    // as it finishes, so TaskOutput shows partial progress.
    const results = new Array(jobs.length).fill(null);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const job = jobs[i];
        try {
          const subArgs = {
            prompt: job.prompt,
            description: `${description} #${i + 1}`,
            ...(job.kind === 'resume' ? { resume: job.agentId } : { subagent_type: type }),
            ...(args.model ? { model: args.model } : {}),
            ...(args.fork === true && job.kind === 'new' ? { fork: true } : {}),
          };
          const out = await agentSpec.execute(subArgs, { ...ctx, _progressTag: `#${i + 1}` });
          // `agentSpec.execute` returns `agent_id: <id>\n\n<handoff>`. The swarm's
          // caller wants the handoff, and the id is only useful for a later
          // `resume`; keep it on one labelled line rather than letting it lead the
          // block, so the reported text is what each subagent actually produced.
          const raw = String(out);
          const m = /^agent_id:\s*(\S+)\s*\n+([\s\S]*)$/.exec(raw);
          const body = (m ? m[2] : raw).trim();
          const head = `--- #${i + 1}${job.kind === 'resume' ? ` (resumed ${job.agentId})` : ''}${m ? ` [${m[1]}]` : ''} ---`;
          results[i] = `${head}\n${body}`;
        } catch (e) {
          results[i] = `--- #${i + 1} ---\n[error: ${e.message}]`;
        }
        // Stream progress into the task output so a long swarm is inspectable.
        const done = results.filter((r) => r !== null).length;
        appendTaskOutput(task, `[${done}/${jobs.length}] finished\n`);
      }
    };
    const runAll = Promise.all(Array.from({ length: Math.min(SWARM_CONCURRENCY, jobs.length) }, worker));

    // Ctrl+B hands the still-running swarm to the background. The task already
    // exists, so detaching only flips who waits on `runAll`: the turn stops
    // blocking and keeps the normal progress lines flowing into the task output.
    let detached = false;
    if (ctx) {
      ctx._foreground = {
        kind: 'AgentSwarm',
        description: `${description} (${jobs.length} subagents)`,
        detach: () => {
          if (detached) return task.taskId;
          detached = true;
          task.detached = true;
          if (ctx._foreground && ctx._foreground.detach) ctx._foreground = null;
          void (async () => {
            try {
              await runAll;
              settleTask(task, 'completed');
              appendTaskOutput(task, results.join('\n\n'));
            } catch (e) {
              settleTask(task, 'failed', { stopReason: e.message });
            }
            if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);
          })();
          return task.taskId;
        },
      };
    }

    try {
      await runAll;
    } catch (e) {
      if (ctx && ctx._foreground && ctx._foreground.detach) ctx._foreground = null;
      // Detached: the background continuation owns the outcome now.
      if (detached) return `Moved to background as task #${task.taskId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${task.taskId}"}.`;
      settleTask(task, 'failed', { stopReason: e.message });
      return `Error: swarm failed: ${e.message}`;
    }
    if (ctx && ctx._foreground && ctx._foreground.detach) ctx._foreground = null;
    if (detached) {
      return `Moved to background as task #${task.taskId}. It keeps running; inspect with TaskList / TaskOutput {task_id: "${task.taskId}"}.`;
    }
    settleTask(task, 'completed');
    appendTaskOutput(task, results.join('\n\n'));
    if (typeof ctx._onBackgroundTaskDone === 'function') ctx._onBackgroundTaskDone(task);

    return `Swarm finished: ${jobs.length} subagent(s).\n\n${results.join('\n\n')}`;
  },
};