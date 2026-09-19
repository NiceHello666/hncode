// The agent loop: sends the message history to the LLM, consumes the normalized
// event stream, executes any tool calls, appends results, and repeats until the
// model answers without tool calls (or a step/interrupt condition is hit).

import { LLM, setToolsList } from './llm.js';
import { tools, getTool, llmTools } from './tools/index.js';
import { DELEGATION_TOOLS } from './subagent-types.js';
import { estimateMessagesTokens } from './term.js';
import { runHooks } from './plugin.js';
import { loadHooks, runShellHooks } from './hooks.js';

// A short, stable key for the prompt cache, derived from the conversation's
// first user message. Stability is the whole point: the same conversation must
// produce the same key on every turn, so a cheap deterministic hash beats a
// random id. (Different conversations may collide — that is harmless, it only
// means the provider's routing key is shared.)
function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36) + '-' + str.length.toString(36);
}

// ---- completion guard --------------------------------------------------------
// A turn is only complete when the model ends it with an actual answer. Models
// do stop mid-task: the stream ends right after a reasoning block, or with an
// empty assistant message, and the caller would report "done" for unfinished
// work. When that happens we tell the model what it did and give it more steps.
// Bounded, so a model that insists on stopping cannot loop forever.
export const MAX_NUDGES = 5;

export function nudgeMessage(why) {
  return `[hncode] Your turn ended without a final answer: ${why}. `
    + 'This usually means the task is not finished. If the work IS complete, reply with a short '
    + 'summary of what changed and how you verified it. Otherwise keep going with the tools right '
    + 'now — do not stop silently.';
}

// Final instruction appended to the system prompt (see SYSTEM_PROMPT).
// (The wording lives in SYSTEM_PROMPT itself, under "Finishing a turn".)

export const SYSTEM_PROMPT = `You are hncode, a coding agent in the user's terminal on ${process.platform}.
You work inside a workspace directory using the tools provided.

Tools:
- Read a file before editing it; never guess contents or edit code you haven't read.
- Prefer Edit over Write for existing files.
- If a tool fails, read the error and fix your approach. After 2 failed attempts on the same goal, stop and report the blocker.
- Independent tool calls may run in parallel; never parallelize dependent ones.

Reasoning:
- Put ALL of your internal reasoning inside <think>...</think> tags, and always emit BOTH the opening
  and the closing tag. Do not omit the tags, do not abbreviate them, and do not leave the block unclosed.
- Everything outside <think>...</think> is what the user reads: keep it to the answer itself — what you
  did and what you found. Never repeat or summarise your reasoning there.
- Keep the tags exactly as written: <think> and </think>. Do not emit any other variant.
Acting:
- Unless the user is explicitly asking for a plan, asking a question about the code, or brainstorming,
  assume they want the work DONE. Say less and do more: implement the change rather than describing it.
- Carry the task through implementation and verification in this turn. Do not stop at analysis, at a
  partial fix, or at a list of things you would do next.
- New project, no prior context: be ambitious, use your judgement on structure.
  Existing codebase: be surgical. Touch only what the task needs — no renames, no reorganising,
  no drive-by fixes.
- Read the neighbours before you write: match the naming, error handling and comment density you see.
- Do not re-read a file after editing it, and do not re-run a search you already have results for.
  A successful edit tool call already proves it worked.

Scope:
- Do only what was asked. Do not refactor or "improve" unrelated code.
- Do not fix unrelated bugs or broken tests — mention them instead; they are not yours to change.
- If the request is ambiguous, ask one short clarifying question.
- State any assumption you make.
- Might be a dirty git worktree. Never revert changes you did not make. Never run a destructive command
  (git reset --hard, git checkout --) unless the user asked for it. If you notice an unexpected change
  you did not make, stop and ask.

Verifying:
- Run the narrowest check that exercises your change first, then widen.
- In auto/yolo mode, run tests and lint yourself without asking.
- In ask mode, do not burn the user's time on slow test suites mid-task: say what you would run and
  let them confirm.
- Do not add tests to a codebase that has none. Do not add a formatter that the project did not configure.
- If you could not verify something, say so plainly. Do not imply a test passed when you did not run it.

Finishing:
- Never stop silently after a tool call; end every turn with a written answer in the user's language.
- Report briefly: what changed, and how you verified it. If something failed, say what you tried and what you need.
- Never claim success without evidence. Cite file:line for referenced code.
- Be concise. No filler, no restating the request or explaining tool output that already spoke for itself.
- If context is running low, call /compact to shrink history.
`;

export class Agent {
  constructor({ cfg, messages, onEvent, maxSteps = 0, onToolStart, canInterrupt = () => false, onApproval }) {
    this.cfg = cfg;
    this.messages = messages;
    this.onEvent = onEvent;
    this.maxSteps = maxSteps;
    this.onToolStart = onToolStart; // (name, args) => void (for headless/TTY overlays)
    // Ensure the LLM client knows the bare tool specs (the client wraps them per-protocol).
    // A toolFilter (array of tool names) limits which tools are exposed — used
    // by Plan mode (read-only subset) and Focus mode (minimal subset first).
    // `cfg.noDelegation` marks this as a SUBAGENT: delegation tools are removed
    // even if the filter would have allowed them. The catalog already excludes
    // them from every profile; this is the hard backstop that also covers the
    // `null` (= everything) case, so a subagent can never spawn another agent.
    const filtered = (Array.isArray(cfg.toolFilter) && cfg.toolFilter.length
      ? tools.filter((t) => cfg.toolFilter.includes(t.name))
      : tools
    ).filter((t) => !(cfg.noDelegation && DELEGATION_TOOLS.includes(t.name)));
    setToolsList(filtered);
    // A block for the direct-call path too: the model can still emit a tool call
    // for a tool that is not exposed, so refuse it here rather than at execution.
    this.noDelegation = !!cfg.noDelegation;
    // AbortSignal handed to every tool so a long-running one (Bash) is killed
    // when the user presses Esc / Ctrl-C — otherwise the command keeps running
    // after the turn was interrupted.
    this.toolAbort = new AbortController();
    this.ctx = { ...cfg, tasks: {}, todoState: Array.isArray(cfg.todoState) ? cfg.todoState.slice() : [], allowExternal: !!cfg.allowExternal, signal: this.toolAbort.signal };
    // Live output stream for a RUNNING tool (Bash): the tool calls this with raw
    // chunks and the agent tags them with the id of the tool call in flight, so
    // the TUI can append them to the matching "Using …" row while it runs.
    this._currentToolId = null;
    this.ctx.onOutput = (chunk) => {
      if (chunk && this._currentToolId) this.onEvent({ type: 'tool_output', id: this._currentToolId, chunk });
    };
    // `fork` (the Agent tool) snapshots THIS conversation into the subagent. The
    // tool reads `ctx._parentMessages`, which nothing ever set — so `fork: true`
    // was accepted and then seeded the subagent with an empty history. Hand the
    // tool a live getter over this agent's own messages instead of a copy, so the
    // snapshot is taken at spawn time and reflects everything up to that point.
    this.ctx._parentMessages = this.messages;
    // Prompt-cache key: identify the SESSION, not the request, so the cached
    // prefix is reused across turns instead of thrashing. The caller may pass one
    // (the TUI knows the session id); otherwise derive a stable value from the
    // first user message so repeated runs of the same conversation still share a
    // prefix. A subagent inherits the parent's key (same conversation family).
    if (cfg.sessionId == null) {
      const firstUser = (Array.isArray(messages) ? messages : []).find((m) => m.role === 'user' && typeof m.content === 'string');
      cfg = { ...cfg, sessionId: firstUser ? hashKey(firstUser.content) : 'default' };
      this.cfg = cfg;
    }
    this.llm = new LLM(cfg);
    this.stopRequested = false;
    this.onApproval = onApproval; // async (toolName, args) => boolean
    // Shell hooks (Claude Code-style): user-configured commands run at lifecycle
    // events. ALWAYS stored as a `{ hooks: {Event: [...]} }` config, which is the
    // shape runShellHooks() reads. A caller may inject one (tests / the TUI,
    // which reloads per turn); otherwise it is read from disk for this workspace.
    this.hookConfig = cfg.hookConfig
      ? (cfg.hookConfig.hooks ? cfg.hookConfig : { hooks: cfg.hookConfig })
      : { hooks: loadHooks(cfg.workspace).hooks };
    // The turn's user prompt, for the UserPromptSubmit hook. Set by run().
    this._turnPrompt = '';
    // Messages the user types while the agent is streaming. They are injected
    // as user messages right AFTER the current round of tool calls, so the
    // model sees "tool callback / user steer" together on the next request —
    // exactly like kimi-code's steer (no separate turn feel).
    this.steerQueue = [];
  }

  // Queue a steering message typed while streaming. It takes effect once the
  // in-flight tool calls finish and the loop asks the model again.
  steer(text) {
    if (text && text.trim()) this.steerQueue.push(String(text).trim());
  }
  // True when a steer is pending injection.
  get hasSteer() { return this.steerQueue.length > 0; }

  interrupt() {
    this.stopRequested = true;
    try { this.toolAbort.abort(); } catch {}
    if (this.llm) this.llm.abort();
  }

  async run() {
    // Plugin lifecycle: `onTurnStart` fires here and `onTurnEnd` in the finally
    // block at the end of this method. Both are awaited and both swallow plugin
    // errors (see runHooks), so a broken plugin cannot abort a turn.
    await runHooks('onTurnStart', { messages: this.messages });
    // SHELL HOOK: SessionStart fires once per agent run (the first turn of a
    // session). A hook failure never blocks — it is a convenience signal.
    await runShellHooks(this.hookConfig, 'SessionStart', { messages: this.messages }, this.cfg.workspace);
    // SHELL HOOK: UserPromptSubmit fires with the latest user message. It cannot
    // block (Claude Code's can add context; blocking the user's own prompt is a
    // worse failure than a missing hook), so the result is only logged.
    {
      const lastUser = [...this.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
      if (lastUser) {
        this._turnPrompt = lastUser.content;
        await runShellHooks(this.hookConfig, 'UserPromptSubmit', { prompt: lastUser.content }, this.cfg.workspace);
      }
    }
    let text = '';
    let toolCalls = [];
    let emittedEnd = false;
    let thought = '';
    let nudges = 0;
    // decide whether running out of steps actually left the turn unfinished.
    let hadToolCallsOnFinalStep = false;

    const handle = async (e) => {
      switch (e.type) {
        case 'data':
          text += e.text;
          this.onEvent({ type: 'data', text: e.text });
          break;
        case 'think':
          // Reasoning tokens: forward verbatim so the TUI can render a live
          // "thinking…" block. They are NOT part of the assistant message.
          thought += e.text;
          this.onEvent({ type: 'think', text: e.text });
          break;
        case 'tool_start':
          toolCalls.push({ id: e.id, name: e.name, args: {}, argsJson: '' });
          this.onEvent({ type: 'tool_start', id: e.id, name: e.name });
          break;
        case 'tool_args': {
          const tc = toolCalls.find((t) => t.id === e.id);
          if (tc) { tc.argsJson += e.chunk; }
          // Forward the raw argument chunk so the TUI can stream a Write's
          // content (or an Edit's old/new text) while the model is emitting it.
          this.onEvent({ type: 'tool_args', id: e.id, chunk: e.chunk });
          break;
        }
        case 'tool_end': {
          const tc = toolCalls.find((t) => t.id === e.id);
          if (tc) {
            try { tc.args = tc.argsJson ? JSON.parse(tc.argsJson) : {}; }
            catch { tc.args = { raw: tc.argsJson }; }
          }
          break;
        }
        case 'end':
          emittedEnd = true;
          break;
        case 'aborted':
          // The request was aborted (Esc / Ctrl-C): surface it and stop the loop.
          this.stopRequested = true;
          this.onEvent({ type: 'aborted' });
          break;
        case 'error':
          this.onEvent({ type: 'error', error: e.error });
          break;
      }
    };

    // No step cap: the loop runs until the model produces a final answer, the
    // user interrupts (Esc / Ctrl-C), or an error ends the turn. maxSteps is
    // kept only for callers that explicitly request a bound (0/undefined = none).
    // Runaway safety comes from the completion guard (MAX_NUDGES) and the user's
    // ability to interrupt, not from a fixed tool-round budget.
    const stepLimit = (this.maxSteps > 0) ? this.maxSteps : Infinity;
    for (let step = 0; step < stepLimit; step++) {
      // Process any steer messages collected during the previous step
      if (this.steerQueue.length > 0) {
        const steers = this.steerQueue.splice(0);
        for (const text of steers) {
          this.messages.push({ role: 'user', content: text });
          this.onEvent({ type: 'steer', text });
        }
      }
      if (this.stopRequested) { this.onEvent({ type: 'stopped' }); break; }
      text = ''; toolCalls = []; emittedEnd = false; thought = '';
      // Report the start of each model round so the TUI can count steps/rounds.
      this.onEvent({ type: 'step_start', step, round: step + 1 });
      // ---- auto-compaction (kimi's runtime strategy) ----
      // Before each model call, if the estimated context usage is at or above
      // 85% of the model's max context, summarize the older portion of the
      // conversation and keep only the most recent 20% of messages (plus the
      // summary). This mirrors kimi's triggerRatio=0.85 & maxRecentSizeRatio=0.2
      // policy, using the same ASCII/4 + non-ASCII token estimator. The dropped
      // messages are replaced by a single AI-generated summary so context is
      // preserved rather than simply discarded.
      const maxCtx = this.cfg.maxContextTokens || 512000;
      let usedNow = estimateMessagesTokens(this.messages, this.cfg);
      if (maxCtx > 0 && usedNow >= maxCtx * 0.85) {
        const before = usedNow;
        // SHELL HOOK: PreCompact — a chance to back up the transcript before the
        // older half is summarized away. Never blocks (the trim must go ahead).
        await runShellHooks(this.hookConfig, 'PreCompact',
          { tokens: usedNow, messages: this.messages }, this.cfg.workspace);
        const keepN = Math.max(1, Math.ceil(this.messages.length * 0.2));
        const keep = this.messages.slice(-keepN);
        const dropped = this.messages.slice(0, this.messages.length - keepN);
        this.messages = keep;
        // Ask the model to summarize what was trimmed so far, then prepend it
        // as a system message so the model retains the conversation arc.
        let summary = '';
        if (dropped.length > 0) {
          const summaryPrompt = [
            { role: 'system', content: 'Summarize the conversation history that follows. Capture the user\'s goals, the key decisions made, files created/modified, and the current state of any ongoing work. Be concise but thorough.' },
            ...dropped,
          ];
          const cfgCopy = { ...this.cfg, maxOutputTokens: Math.min(this.cfg.maxOutputTokens || 4096, 2048) };
          const llm = new LLM(cfgCopy);
          try { summary = await llm.requestText(summaryPrompt); } catch { summary = ''; }
          if (summary) {
            this.messages = [{
              role: 'system',
              content: `[hncode] Earlier conversation context was auto-compacted to stay within the context window. Summary of what was trimmed:\n\n${summary}`,
            }, ...this.messages];
          }
        }
        usedNow = estimateMessagesTokens(this.messages, this.cfg);
        this.onEvent({ type: 'compacted', before, after: usedNow, kept: keepN });
      }
      // Live context gauge: report the estimated size of the request about to be
      // sent, so the TUI's context readout is refreshed at every step rather than
      // only once the whole turn ends.
      this.onEvent({ type: 'context', tokens: usedNow, max: maxCtx });

      // Inject any user steering messages typed during the previous step.
      // They are appended right after the last assistant/tool round so the
      // model sees "tool callback / user steer" on this next request.
      if (this.steerQueue.length > 0) {
        for (const steerText of this.steerQueue.splice(0)) {
          this.messages.push({ role: 'user', content: steerText });
          this.onEvent({ type: 'steer', text: steerText });
        }
      }

      // Plugin hooks around the model round-trip. `onBeforeRequest` sees the exact
      // message array being sent (and may mutate it); `onAfterRequest` fires once
      // the stream has been consumed.
      await runHooks('onBeforeRequest', this.messages, this.cfg);
      await this.llm.request(this.messages, handle);
      await runHooks('onAfterRequest', this.messages, this.cfg);

      // An abort ends the turn: keep whatever text arrived, then stop.
      if (this.stopRequested) {
        if (text) this.messages.push({ role: 'assistant', content: text });
        break;
      }

      // append assistant message —— 绝不 push 既无文本、又无 tool_calls 的空消息，
      // 否则上游报 "content or tool_calls must be set"。
      const hasText = !!(text && text.trim());
      const hasCalls = toolCalls.length > 0;
      if (hasText || hasCalls) {
        const assistantMsg = {
          role: 'assistant',
          content: hasText ? text : null,
          toolCalls: hasCalls ? toolCalls : undefined,
        };
        this.messages.push(assistantMsg);
        // Plugin hook: one per assistant message committed to the history. Fired
        // here (the single point where the model's reply lands) rather than at each
        // of the eleven `messages.push` sites, so a plugin sees a coherent message
        // instead of the intermediate bookkeeping pushes.
        await runHooks('onNewMessage', assistantMsg, this.messages);
      }

      // ---- if tool calls exist, execute them ----
      if (toolCalls.length > 0) {
        // Execute tools below
      } else if (this.steerQueue.length > 0) {
        const steers = this.steerQueue.splice(0);
        for (const msg of steers) this.messages.push({ role: 'user', content: msg });
        continue;
      } else if (!hasText) {
        if (nudges < MAX_NUDGES) {
          nudges++;
          const why = thought.trim()
            ? 'your last output was reasoning/thinking only, with no answer text'
            : 'your final message was empty';
          this.onEvent({ type: 'nudge', reason: why, attempt: nudges, max: MAX_NUDGES });
          const last = this.messages[this.messages.length - 1];
          const body = nudgeMessage(why);
          if (last && last.role === 'user' && typeof last.content === 'string') last.content += '\n\n' + body;
          else this.messages.push({ role: 'user', content: body });
          continue;
        }
        break;
      } else {
        // The model produced its answer. A steer typed WHILE that answer was
        // streaming still has to be delivered: drain it and take another step.
        // (Checking only at tool boundaries dropped it, because a final answer
        // has no tool boundary.)
        if (this.steerQueue.length > 0) {
          const steers = this.steerQueue.splice(0);
          for (const msg of steers) this.messages.push({ role: 'user', content: msg });
          continue;
        }
        break;
      }

      // execute tools
      let allOk = true;
      // Tool-subset enforcement: in Plan/Focus mode the model may still emit a
      // tool that is not exposed. Block it with a fixed message so the model
      // learns it must stick to the allowed subset.
      const modeName = Array.isArray(this.cfg.toolFilter)
        ? (this.cfg.toolFilter.includes('Bash') ? 'Focus' : 'Plan')
        : undefined;
      for (const tc of toolCalls) {
        if (this.stopRequested) break;
        // Tag output produced by THIS tool call so onOutput can route it to the
        // right "Using …" row (a turn can run several tools in sequence).
        this._currentToolId = tc.id;
        
        // Permission check before executing each tool
        let result;
        if (this.onApproval) {
          const ok = await this.onApproval(tc.name, tc.args);
          if (!ok) {
            result = `Blocked by user: tool "${tc.name}" was rejected.`;
            this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
            this.messages.push({ role: 'tool', toolCallId: tc.id, content: result });
            this.onEvent({ type: 'tool_result', id: tc.id, name: tc.name, content: result });
            allOk = false;
            continue;
          }
        }
        
        const tool = getTool(tc.name);
        // A subagent may not delegate. The tool is not exposed to it, but the model
        // can still emit a call for a tool it was told about earlier, so refuse it
        // here with an actionable message instead of running a nested agent.
        if (this.noDelegation && DELEGATION_TOOLS.includes(tc.name)) {
          result = `You CAN'T use ${tc.name}: subagents cannot delegate. Do the work yourself and report the result to the agent that started you.`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          this.messages.push({ role: 'tool', toolCallId: tc.id, content: result });
          this.onEvent({ type: 'tool_result', id: tc.id, name: tc.name, content: result });
          allOk = false;
          continue;
        }
        if (modeName && !this.cfg.toolFilter.includes(tc.name)) {
          result = `You CAN'T use this tool on ${modeName} Mode. Allowed: ${this.cfg.toolFilter.join(', ')}.`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          this.messages.push({ role: 'tool', toolCallId: tc.id, content: result });
          this.onEvent({ type: 'tool_result', id: tc.id, name: tc.name, content: result });
          allOk = false;
          continue;
        }
        if (!tool) {
          result = `Error: unknown tool "${tc.name}".`;
          allOk = false;
        } else {
          // SHELL HOOK: PreToolUse. A non-zero exit blocks the tool, and its
          // message goes back to the model in place of the tool result — that is
          // the whole point of a pre-hook (e.g. refuse a write that fails a lint
          // gate). Checked BEFORE approving/executing so a blocked call never
          // touches the filesystem.
          const pre = await runShellHooks(this.hookConfig, 'PreToolUse',
            { toolName: tc.name, toolArgs: tc.args }, this.ctx.cwd || this.cfg.workspace);
          if (pre.blocked) {
            result = `Blocked by a PreToolUse hook: ${pre.reason}`;
            this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
            this.messages.push({ role: 'tool', toolCallId: tc.id, content: result });
            this.onEvent({ type: 'tool_result', id: tc.id, name: tc.name, content: result });
            allOk = false;
            continue;
          }
          if (this.onToolStart) this.onToolStart(tc.name, tc.args);
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          // Plugin hook: onToolExecute fires BEFORE the tool runs and receives the
          // mutable args object, so a plugin can inspect or adjust a call. Errors
          // are swallowed by runHooks — a broken plugin must not break a turn.
          await runHooks('onToolExecute', tc.name, tc.args, this.ctx);
          try {
            result = await tool.execute(tc.args, this.ctx);
          } catch (err) {
            result = `Error running ${tc.name}: ${err.message}`;
            allOk = false;
          }
          this.ctx.lastResult = result;
          // Plugin hook: onToolResult fires with the tool's output.
          await runHooks('onToolResult', tc.name, result, this.ctx);
          // SHELL HOOK: PostToolUse. Never blocks (the tool already ran); a
          // failure is logged. This is where "format after every edit" lives.
          await runShellHooks(this.hookConfig, 'PostToolUse',
            { toolName: tc.name, toolArgs: tc.args, toolResult: result }, this.ctx.cwd || this.cfg.workspace);
          // Surface the live TODO list so the TUI can render its panel.
          if (tc.name === 'TodoList') {
            this.onEvent({ type: 'todos', todos: this.ctx.todoState || [] });
          }
        }
        this.messages.push({ role: 'tool', toolCallId: tc.id, content: result });
        // An Edit reports the text it replaced on ctx (both the substring and the
        // line-range path do). Forward it so the TUI can draw the +/- diff: the
        // line-range mode has no `old_string` in its args, so without this the
        // edit rendered with no diff at all. Cleared every time so a later tool
        // cannot inherit a stale diff.
        this.onEvent({
          type: 'tool_result', id: tc.id, name: tc.name, content: result,
          editDiff: this.ctx.lastEditDiff || null,
        });
        this.ctx.lastEditDiff = null;
      }


      // Did THIS iteration still have tool calls? If the loop runs out of budget
      // right after running them, the turn really is unfinished.
      hadToolCallsOnFinalStep = toolCalls.length > 0;

      // Report the context after this step's tool results were appended: that is
      // exactly what the next request will carry, so the gauge grows with history.
      this.onEvent({ type: 'context', tokens: estimateMessagesTokens(this.messages, this.cfg), max: maxCtx });

    }

    // With the cap removed this can only trigger for a caller that set an
    // explicit finite maxSteps: the final iteration still produced tool calls,
    // so the turn genuinely ran out of rounds. Checking the step index alone (as
    // this used to) reported "budget exhausted" for turns that had finished.
    if (Number.isFinite(stepLimit) && !this.stopRequested && hadToolCallsOnFinalStep) {
      this.onEvent({
        type: 'incomplete',
        reason: 'the step budget was exhausted while tools were still being called',
        usedNudges: nudges,
      });
    }
    if (!emittedEnd && this.onEvent) this.onEvent({ type: 'done' });
    // The turn is over, so the inline-reasoning block it may have left open is
    // abandoned: the NEXT user turn starts a fresh one. Without this, a model that
    // never wrote its closing tag would leave the following turn's answer classified
    // as reasoning.
    if (typeof this.llm.resetThink === 'function') this.llm.resetThink();
    // Plugin lifecycle: the turn is over (normally, interrupted, or out of steps).
    // In a finally-equivalent position — every exit path above reaches here.
    await runHooks('onTurnEnd', { messages: this.messages, stopped: this.stopRequested });
    // SHELL HOOK: Stop fires when the turn ends, whether it finished or was
    // interrupted. Never blocks.
    await runShellHooks(this.hookConfig, 'Stop',
      { messages: this.messages, stopped: this.stopRequested, prompt: this._turnPrompt }, this.cfg.workspace);
  }
}