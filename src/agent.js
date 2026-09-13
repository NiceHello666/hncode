// The agent loop: sends the message history to the LLM, consumes the normalized
// event stream, executes any tool calls, appends results, and repeats until the
// model answers without tool calls (or a step/interrupt condition is hit).

import { LLM, setToolsList } from './llm.js';
import { tools, getTool, llmTools } from './tools/index.js';
import { estimateMessagesTokens } from './term.js';

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

export const SYSTEM_PROMPT = `You are hncode, a coding agent running. You must monitor your context usage. When you detect that you're approaching the context limit (see your last messages about token counts), you should proactively call /compact to reduce the conversation history. in the user's terminal on ${process.platform}.
You operate inside a workspace directory. You can inspect files, edit code, run commands, and track tasks using the tools available.

Tools:
- Prefer Edit over Write for existing files.
- Read before you edit; never guess file contents. Never propose changes to code you haven't read.
- If a tool fails, diagnose why before switching tactics. Read the error; don't guess.
  After 2 failed attempts on the same goal, STOP and report the blocker.
- Independent tool calls can run in parallel, but never parallelize calls with dependencies.

Scope:
- Do what was asked. Do not refactor, rename, or "improve" unrelated code.
- If the request is ambiguous, ask one short clarifying question before acting.
- If you make an assumption, state it explicitly.

Finishing:
- Never stop silently after a tool call.
- End every turn with a short report in the user's language:
  Done: what changed (files / commands / result), and how you verified it.
  Not done: what failed, what you tried, and what you need from the user.
- Never claim success without evidence. Cite file_path:line_number for any code you
  reference. If you didn't run a command or read back the file, you don't know it worked.
- Be brief. No filler, no restating the request.
- After tools succeed, don't re-explain what the tool did. Report only the outcome.

Finishing a turn:
- End every turn with a written answer. Never stop right after a tool call, and never
  stop with reasoning only: either keep calling tools until the task is done, or write
  the summary. A turn that ends without an answer is flagged back to you with a reminder.
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
    const filtered = Array.isArray(cfg.toolFilter) && cfg.toolFilter.length
      ? tools.filter((t) => cfg.toolFilter.includes(t.name))
      : tools;
    setToolsList(filtered);
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
    this.llm = new LLM(cfg);
    this.stopRequested = false;
    this.onApproval = onApproval; // async (toolName, args) => boolean
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
    let text = '';
    let toolCalls = [];
    let emittedEnd = false;
    // Reasoning text seen in the current step. A turn that ends with reasoning
    // but no answer is a truncated turn (see the completion guard below).
    let thought = '';
    let nudges = 0;
    // True when the most recent iteration still had tool calls pending; used to
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

      await this.llm.request(this.messages, handle);

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
        this.messages.push({
          role: 'assistant',
          content: hasText ? text : null,
          toolCalls: hasCalls ? toolCalls : undefined,
        });
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
          if (this.onToolStart) this.onToolStart(tc.name, tc.args);
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          try {
            result = await tool.execute(tc.args, this.ctx);
          } catch (err) {
            result = `Error running ${tc.name}: ${err.message}`;
            allOk = false;
          }
          this.ctx.lastResult = result;
          // Surface the live TODO list so the TUI can render its panel.
          if (tc.name === 'TodoList') {
            this.onEvent({ type: 'todos', todos: this.ctx.todoState || [] });
          }
        }
        this.messages.push({ role: 'tool', toolCallId: tc.id, content: result });
        this.onEvent({ type: 'tool_result', id: tc.id, name: tc.name, content: result });
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
  }
}