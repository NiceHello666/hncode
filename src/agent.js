// The agent loop: sends the message history to the LLM, consumes the normalized
// event stream, executes any tool calls, appends results, and repeats until the
// model answers without tool calls (or a step/interrupt condition is hit).

import { LLM, setToolsList } from './llm.js';
import { tools, getTool, llmTools } from './tools/index.js';
import { DELEGATION_TOOLS } from './subagent-types.js';
import { estimateMessagesTokens, estimateRequestOverhead, estimateTokens } from './term.js';
import { runHooks } from './plugin.js';
import { loadHooks, runShellHooks } from './hooks.js';
import {
  shapeToolResult, trimToolResults, DEFAULT_TRIM_THRESHOLD, DEFAULT_TRIM_KEEP_RATIO,
} from './tool-result.js';
// ---- compaction text (kimi's shapes) ----------------------------------------
// These mirror kimi-code's contextMemory/compactionHandoff.ts so a compacted
// history reads the same way there.

// Wraps harness-generated text so it reads as a system note rather than something
// the user actually typed.
function wrapSystemReminder(content) {
  return `<system-reminder>\n${String(content).trim()}\n</system-reminder>`;
}

const COMPACTION_SUMMARY_PREFIX = [
  'The conversation so far has been compacted to free up context. What follows is your own working summary of this task — use it to continue your train of thought rather than starting over.',
  'Treat it as notes, not proof: where it says a step was done, tests passed, or a fix worked, verify that yourself before relying on it.',
  'User messages earlier in this context are preserved verbatim from the compacted conversation. The summary records which earlier requests were already addressed.',
].join(' ');

// The instruction given to the model that WRITES the summary. Adapted from
// kimi-code's fullCompaction/compaction-instruction.md: it is a handoff for the
// model that resumes, not a recap for a human. The language rule matters — without
// it a Chinese conversation produced an English summary and the resumed context
// lost the vocabulary the task was being discussed in.
const COMPACTION_INSTRUCTION = [
  'You are about to run out of context. Create a handoff summary for the model that will resume this task after the earlier conversation is cleared.',
  '',
  'This message is a direct task, not part of the above conversation.',
  '',
  'Write it in the same language the conversation has been using — do not switch to English just because these instructions are in English.',
  '',
  'Make the summary self-sufficient: the next turn will see only the preserved messages and this summary. In your own words, preserve what is genuinely needed to continue:',
  '',
  '- What the latest request actually asks for, and any ambiguity you have already resolved. If the latest request is large (a big paste or file) and may be truncated in the kept messages, preserve the actual ask.',
  '- The instructions and constraints currently in force (user preferences, project rules, environment limits), with settled decisions kept separate from open questions, so neither is reopened nor mistaken for decided.',
  '- What has actually been done, at high fidelity: exact commands run, exact file paths touched, and their results — the concrete values, key lines and error text — not just the commands. Keep only the final working version of any code; drop intermediate attempts and already-resolved errors.',
  '- What you still do not know: files referenced but not read, APIs assumed but unseen, questions the user has not answered. Name these gaps so the next turn checks them instead of assuming.',
  '- The forward plan: the exact next step, the sequence to finish, decisions already made for those steps, foreseeable obstacles and how you mean to handle them.',
  '',
  'Be honest about uncertainty. If an earlier step claimed something was done but was never verified, say so plainly and treat it as unverified rather than fact.',
  '',
  'Be concise and proportional: a long multi-step task warrants detail, a nearly finished exchange needs only a sentence or two.',
  '',
  'Respond with text only. Do not call any tools.',
].join('\n');

// Trailing note: the model should RESUME, not answer the summary.
const COMPACTION_CONTINUATION_TEXT = 'Context compaction is complete — continue the work that was in progress when it began.';

// Clip to a TOKEN budget, counting non-ASCII as one token per character (the same
// Clip to a TOKEN budget, counting non-ASCII as one token per character (the same
// rule estimateTokens uses). Slicing by characters is wrong for CJK text: 4000
// Chinese characters are ~4000 tokens, not ~1000.
function clipToTokens(text, maxTokens) {
  if (maxTokens <= 0) return '';
  const s = String(text ?? '');
  let ascii = 0, nonAscii = 0, end = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) <= 127) ascii++; else nonAscii++;
    if (Math.ceil(ascii / 4) + nonAscii > maxTokens) break;
    end += ch.length;
  }
  return end >= s.length ? s : s.slice(0, end) + '\n…[clipped]';
}

// May the history be split between `index` and `index + 1`? Mirrors kimi's
// canSplitAfter — a split is illegal when it would orphan a tool exchange:
//   * the message before the cut is a user message (would start the kept part
//     mid-turn), or
//   * it is an assistant message that still has tool calls, or
//   * the message after the cut is a tool result, or
//   * the prefix ends inside an open tool exchange (more results to come).
function canSplitAfter(messages, index) {
  if (index < 0 || index >= messages.length) return false;
  const m = messages[index];
  if (!m) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return false;
  const next = messages[index + 1];
  if (next && next.role === 'tool') return false;
  return !prefixEndsWithOpenToolExchange(messages, index);
}

// True when the prefix [0..index] ends with an assistant that issued MORE tool
// calls than have results so far — cutting there would leave a call unanswered.
function prefixEndsWithOpenToolExchange(messages, index) {
  if (!messages[index] || messages[index].role !== 'tool') return false;
  let results = 0;
  for (let i = index; i >= 0; i--) {
    const m = messages[i];
    if (!m) return false;
    if (m.role === 'tool') { results++; continue; }
    return m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > results;
  }
  return false;
}


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
  return h.toString(36) + '-' + str.length.toString(36);
}

// Render what an Edit actually changed, for the MODEL's tool result.
//
// The UI has always received the edit through `editDiff` (see the tool_result
// event), but the message pushed into `this.messages` carried only the one-line
// receipt ("Edited a.js: replaced 1 occurrence(s)."). The model was therefore
// asked to verify its own edit from a sentence that describes nothing: it could
// not see WHAT changed, so a wrong-but-successful edit looked identical to a
// correct one. The diff is appended here — after the receipt — so the model
// reads what it did.
//
// The format is the usual unified one (`- old`, `+ new`) with the line number
// from the file, and it is deliberately indented two spaces: a tool result is
// rendered as plain text, and the indent keeps the +/- marks from reading as
// part of the JSON envelope some providers wrap tool output in.
export function formatEditDiffForModel(diff, maxLines = 400) {
  if (!diff || typeof diff.old !== 'string' || typeof diff.new !== 'string') return '';
  const split = (s) => String(s).replace(/\r\n/g, '\n').split('\n');
  const oldLines = split(diff.old);
  const newLines = split(diff.new);
  const startLine = Number(diff.startLine) > 0 ? Number(diff.startLine) : 1;
  const out = [];
  out.push('');
  out.push('--- diff ---');
  let n = startLine;
  for (const l of oldLines) out.push('  ' + String(n++).padStart(4) + ' - ' + l);
  n = startLine;
  for (const l of newLines) out.push('  ' + String(n++).padStart(4) + ' + ' + l);
  // A whole-file edit (a Write-sized `new`) must not be echoed back in full.
  if (out.length > maxLines + 3) {
    const hidden = out.length - (maxLines + 3);
    out.length = maxLines + 3;
    out.push('  … ' + hidden + ' more diff line(s) omitted');
  }
  return out.join('\n');
}

// Final instruction appended to the system prompt (see SYSTEM_PROMPT).
// (The wording lives in SYSTEM_PROMPT itself, under "Finishing a turn".)


// Tools whose execution cannot affect what any OTHER tool call in the same step
// observes, and cannot be affected by one. Two read-only tools therefore have no
// reason to run one after the other, and the agent runs a consecutive run of them
// in parallel (see the tool loop in run()). Anything that writes, spawns, shells
// out or mutates the working tree is excluded — that rules out `Git` (it can
// stage/commit/switch), `ReadMediaFile` (read-only, but it decodes megabytes of
// media and is never the bottleneck) and every delegation tool. Claude Code
// expresses the same idea as `isConcurrencySafe()` on each tool; this is the flat
// version of it, matching hncode's tool registry.
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'FileLines', 'FetchURL', 'WebSearch',
  'TaskList', 'TaskOutput',
]);

// Debug switch for the size/age control in tool-result.js, mirroring Claude
// Code's env-gated knobs. Set HNCODE_TOOL_RESULT_LIMITS=off to send every tool
// result verbatim (useful when a spill is suspected of hiding something the
// model needed).
function toolResultLimitsEnabled() {
  return !/^(0|off|false|no)$/i.test(String(process.env.HNCODE_TOOL_RESULT_LIMITS || ''));
}


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

/** Plain text of a structured tool result, for the model and the transcript. */
function mediaResultText(r) {
  if (!r || typeof r !== 'object') return String(r == null ? '' : r);
  return String(r.text == null ? '' : r.text);
}

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
    // Reuse an incoming task store when the caller provides one. Background
    // tasks OUTLIVE the turn that started them (their process is detached), so a
    // fresh `{}` per Agent made them vanish from the UI on the next turn while
    // still running. The TUI passes its persistent `state.tasks` through cfg.
    this.ctx = { ...cfg, tasks: cfg.tasks || {}, todoState: Array.isArray(cfg.todoState) ? cfg.todoState.slice() : [], allowExternal: !!cfg.allowExternal, signal: this.toolAbort.signal };
    // Live output stream for a RUNNING tool (Bash): the tool calls this with raw
    // chunks and the agent tags them with the id of the tool call in flight, so
    // the TUI can append them to the matching "Using …" row while it runs.
    this._currentToolId = null;
    this.ctx.onOutput = (chunk) => {
      if (chunk && this._currentToolId) this.onEvent({ type: 'tool_output', id: this._currentToolId, chunk });
    };
    // The Read snapshot pool lives ON THE AGENT, not on a per-turn ctx. It records
    // what the model has read (and the hashes at that moment) so a later Edit can
    // refuse to act on a stale snippet. /undo rewinds files on disk, i.e. it makes
    // those hashes describe content that is no longer there — the TUI clears this
    // pool right after a rewind so the next Edit is not rejected as stale.
    this.readPool = new Map();
    this.ctx.readPool = this.readPool;
    // `fork` (the Agent tool) snapshots THIS conversation into the subagent. The
    // tool reads `ctx._parentMessages`. This must be a GETTER, not the array
    // itself: auto-compaction REPLACES `this.messages` with a trimmed history, so
    // a retained reference kept pointing at the pre-compaction array — a fork
    // after a compaction would hand the subagent exactly the oversized history
    // that was just cut, and could push it straight past its own window.
    Object.defineProperty(this.ctx, '_parentMessages', {
      get: () => this.messages,
      enumerable: true,
      configurable: true,
    });
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
    // Auto-compaction is allowed at most once per TURN (not per step). Reset here so
    // a caller that reuses one Agent across turns still gets a fresh allowance.
    this._compactedThisTurn = false;
    this.onApproval = onApproval; // async (toolName, args) => boolean
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
    // The compaction summarizer is a SEPARATE LLM instance; abort it too, or an
    // auto-compaction in flight cannot be interrupted (Esc did nothing until the
    // summary request finished on its own).
    if (this._summaryLlm) { try { this._summaryLlm.abort(); } catch {} }
  }

  // What the NEXT request will carry: the messages (which already begin with the
  // assembled system prompt — see the TUI's runAgent) plus the tool-definition
  // overhead. It must NOT add `cfg.systemPrompt` on top: that value is the RAW
  // config string, not the assembled prompt (calm/plan/swarm/AGENTS.md are appended
  // later), so counting it both double-counted the system text and measured the
  // wrong figure — while being the only input that decides whether to compact.
  usedTokens() {
    let total = 0;
    for (const m of this.messages || []) total += estimateMessagesTokens([m], null);
    if (Array.isArray(this.cfg.toolFilter)) total += this.cfg.toolFilter.length * 8;
    return total;
  }

  // Where to cut the history for compaction. Walks back from the end accumulating a
  // token budget, but only accepts indices the boundary rule allows (so the kept
  // slice can never begin on an orphan tool result). Returns how many messages to
  // DROP. Mirrors kimi's computeCompactCount + canSplitAfter.
  computeCompactSplit(maxCtx) {
    // Keep a fraction of the CURRENT usage, not of the whole window: a big window
    // (1M) should not force a huge tail to be kept when only a little was used.
    // Ratio is configurable (/auto-compact keep, config.toml compact_keep_ratio),
    // default 0.2.
    const keepRatio = (typeof this.cfg.compactKeepRatio === 'number'
      && this.cfg.compactKeepRatio > 0 && this.cfg.compactKeepRatio < 1)
      ? this.cfg.compactKeepRatio : 0.2;
    const used = this.usedTokens();
    const maxSize = Math.max(1, Math.floor((used || (maxCtx || 512000) * 0.85) * keepRatio));
    const msgs = this.messages || [];
    // Never cut inside the LEADING system block. `msgs[0]` is the assembled system
    // prompt, and canSplitAfter() would happily allow a split right after it — which
    // would drop the prompt itself and leave the request with no instructions.
    let floor = 0;
    while (floor < msgs.length && msgs[floor] && msgs[floor].role === 'system') floor++;
    let recent = 1;
    let size = 0;
    let bestSplit;
    for (; recent < msgs.length; recent++) {
      const split = msgs.length - recent;
      size += estimateMessagesTokens([msgs[split]], null);
      if (split > floor && canSplitAfter(msgs, split - 1)) bestSplit = split;
      if (size >= maxSize && bestSplit !== undefined) break;
    }
    return bestSplit ?? 0;
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
    // decide whether running out of steps actually left the turn unfinished.
    let hadToolCallsOnFinalStep = false;
    // How many times this turn has continued an answer the output cap cut in half.
    // Bounded so a model that cannot fit its answer in the budget cannot loop.
    let truncationRecoveries = 0;
    const MAX_TRUNCATION_RECOVERIES = 3;

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
        case 'truncated':
          // The reply hit max_tokens and was cut off mid-answer. Remember it: the
          // loop below continues the turn instead of ending it (see the `truncated`
          // branch), so a half-written answer is never presented as a finished one.
          this._truncated = true;
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
            catch {
              // The streamed arguments did not form complete JSON. The usual cause
              // is truncation (a huge `content`, a long command) or an interrupted
              // stream. The `raw` shape is kept so a tool can SEE that its
              // arguments failed to parse and say so, instead of reporting a
              // missing field; `_rawLen` lets that message state how big the
              // partial payload was, which is what tells the model to split it.
              tc.args = { raw: tc.argsJson, _rawLen: tc.argsJson ? tc.argsJson.length : 0 };
            }
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
      this._truncated = false;
      // Report the start of each model round so the TUI can count steps/rounds.
      this.onEvent({ type: 'step_start', step, round: step + 1 });
      // ---- auto-compaction (kimi's runtime strategy) ----
      // Before each model call, if the estimated context usage is at or above
      // 85% of the model's max context, summarize the older portion and keep a
      // small recent tail. Mirrors kimi's triggerRatio=0.85 /
      // maxRecentSizeRatio=0.2 policy, plus its `reservedContextSize` rule: a
      // request that leaves less than the reserved headroom is compacted even
      // below 85%, so the reply has room to be generated.
      const maxCtx = this.cfg.maxContextTokens || 512000;
      let usedNow = this.usedTokens();
      // `reservedContextSize` (kimi): a request leaving less than this much headroom
      // is compacted even below the trigger ratio, so the REPLY has room to be
      // generated. A request just under the trigger could otherwise still fail.
      const reserved = this.cfg.reservedContextTokens || 50_000;
      const needsRoom = reserved > 0 && reserved < maxCtx && usedNow + reserved >= maxCtx;
      // Trigger ratio is configurable (/auto-compact threshold, config.toml
      // compact_threshold); default 0.85.
      const trigger = (typeof this.cfg.compactThreshold === 'number' && this.cfg.compactThreshold > 0
        && this.cfg.compactThreshold < 1) ? this.cfg.compactThreshold : 0.85;
      // At most ONCE per turn. This used to run inside the step loop with no counter,
      // so a trim that failed to get under the threshold triggered again on the very
      // next step — paying for another summary round-trip each step while the history
      // kept shrinking.
      const shouldCompact = this.cfg.autoCompact !== false && maxCtx > 0
        && !this._compactedThisTurn
        && (usedNow >= maxCtx * trigger || needsRoom);
      if (shouldCompact) {
        const before = usedNow;
        this._compactedThisTurn = true;
        // SHELL HOOK: PreCompact — a chance to back up the transcript before the
        // older half is summarized away. Never blocks (the trim must go ahead).
        await runShellHooks(this.hookConfig, 'PreCompact',
          { tokens: usedNow, messages: this.messages }, this.cfg.workspace);
        // Tell the TUI the trim is under way. Summarizing is a full model
        // round-trip, so without this the UI sat silent for seconds mid-turn
        // with no sign anything was happening.
        this.onEvent({ type: 'compacting', before: usedNow, keep: 0, dropped: 0 });
        //
        // SUMMARIZE BEFORE TRIMMING. The summary is generated from the FULL history,
        // so the summarizing model can see what just happened — the most recent
        // exchange is what tells it what the session is doing now. Trimming first
        // summarized only the OLD part and lost what the summary needed most.
        //
        // The transcript fed to the summarizer is bounded by TOKENS, not characters.
        // A character cap is not a size cap: 120k Chinese characters is roughly 120k
        // tokens, which alone can exceed the window and make the call FAIL — after
        // which the history was discarded with no summary at all. That is the normal
        // case for a Chinese conversation, not an edge case.
        const summaryBudget = Math.max(1, Math.floor(maxCtx * 0.3));
        const perMsgTokens = 4_000;
        const summaryParts = [];
        let summaryTokens = 0;
        for (let i = this.messages.length - 1; i >= 0; i--) {
          const m = this.messages[i];
          let raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          if (estimateTokens(raw) > perMsgTokens) raw = clipToTokens(raw, perMsgTokens);
          const line = `${m.role}: ${raw}`;
          const t = estimateTokens(line);
          if (summaryTokens + t > summaryBudget) break;
          summaryTokens += t;
          summaryParts.unshift(line);
        }
        let summary = '';
        if (this.messages.length > 0) {
          const summaryPrompt = [
            { role: 'system', content: COMPACTION_INSTRUCTION },
            { role: 'user', content: summaryParts.join('\n\n') },
          ];
          const cfgCopy = { ...this.cfg, maxOutputTokens: Math.min(this.cfg.maxOutputTokens || 4096, 4096) };
          const llm = new LLM(cfgCopy);
          // Remember this throwaway summarizer so Esc / Ctrl-C can abort IT too.
          // It is NOT `this.llm`, so `interrupt()` could not reach it — a running
          // auto-compaction was uninterruptible, which felt like a hang.
          this._summaryLlm = llm;
          // Thinking OFF and no tools, matching Claude Code's summarizer
          // (`thinkingConfig: { type: 'disabled' }`). Summarizing is a straight
          // transcription task: reasoning tokens buy nothing here, and on a
          // reasoning model they can consume the whole output budget — which
          // returns an EMPTY summary, and an empty summary is what turns a
          // compaction into a silent loss of history.
          try { summary = await llm.requestText(summaryPrompt, { noReasoning: true, noTools: true }); } catch { summary = ''; }
          this._summaryLlm = null;
        }
        // Interrupted mid-summary: do NOT trim. Aborting yields an empty summary, and
        // proceeding would drop history with nothing to replace it — data loss. Mark
        // the compaction block cancelled and bail out of the turn.
        if (this.stopRequested) {
          this.onEvent({ type: 'compaction_cancelled' });
          this.onEvent({ type: 'stopped' });
          break;
        }
        // NOW trim, at a split point the boundary rule allows.
        const split = this.computeCompactSplit(maxCtx);
        const keep = this.messages.slice(split);
        const droppedCount = this.messages.length - keep.length;
        // Shape: [ ...kept, summary, continuation ].
        //
        // The summary is a USER message wrapped in a <system-reminder> (kimi's
        // shape), not a `system` message. Two reasons:
        //   * the TUI rebuilds the system prompt from scratch each turn and SKIPS
        //     every `system` entry in the stored history, so a system summary was
        //     dropped before the model ever saw it;
        //   * the turn-end save filters `system` out of the session, so it was not
        //     persisted either — history trimmed AND summary lost at both ends,
        //     which made "compaction" pure data loss.
        // The continuation note goes LAST so the model's next move is "keep going"
        // rather than "answer the summary".
        const summaryText = summary
          ? `${COMPACTION_SUMMARY_PREFIX}\n${summary}`
          : `${COMPACTION_SUMMARY_PREFIX}\n(no summary available)`;
        this.messages = [
          ...keep,
          { role: 'user', content: wrapSystemReminder(summaryText) },
          { role: 'user', content: wrapSystemReminder(COMPACTION_CONTINUATION_TEXT) },
        ];
        usedNow = this.usedTokens();
        this.onEvent({
          type: 'compacted', before, after: usedNow, kept: keep.length,
          dropped: droppedCount, summary,
        });
        // SHELL HOOK: PostCompact. Fires after the trim, so a hook can archive the
        // summary or record the shrink. Never blocks.
        await runShellHooks(this.hookConfig, 'PostCompact',
          { before, after: usedNow, kept: keep.length, dropped: droppedCount, summary }, this.cfg.workspace);
      }
      // ---- tool-result trimming ----
      // The cheap pass, and the one that actually runs in practice: a history is
      // usually LARGE because of old tool output nobody is reading, not because the
      // conversation is long. Bodies are replaced by a short pointer — the message
      // list keeps its exact length and roles, so the assistant/tool pairing and the
      // cached prefix shape are untouched — and the removed text is copied to disk
      // first, so it stays recoverable.
      //
      // Trigger: the request reached `trimThreshold` (50% by default) of the window.
      // Target: keep `trimKeepRatio` (30% by default) of the tool-result TEXT,
      // newest first. Skipped while a compaction just ran (that already shrank
      // things) and above the compaction trigger (compaction is the right tool by
      // then, and the two must not fight over the same history).
      const trimThreshold = Number.isFinite(this.cfg.trimThreshold) ? this.cfg.trimThreshold : DEFAULT_TRIM_THRESHOLD;
      if (this.cfg.autoTrim !== false && toolResultLimitsEnabled()
          && !this._compactedThisTurn && maxCtx > 0
          && usedNow >= maxCtx * trimThreshold && usedNow < maxCtx * (this.cfg.compactThreshold || 0.85)) {
        const res = trimToolResults(this.messages, {
          sessionId: this.cfg.sessionId,
          keepRatio: Number.isFinite(this.cfg.trimKeepRatio) ? this.cfg.trimKeepRatio : DEFAULT_TRIM_KEEP_RATIO,
          // The model may still be reading the result it was handed last step.
          mustKeep: this._lastToolResultIndex,
        });
        if (res && res.elided > 0) {
          const after = this.usedTokens();
          this.onEvent({
            type: 'results_trimmed', elided: res.elided, elidedBytes: res.elidedBytes,
            kept: res.kept, keptBytes: res.keptBytes, before: usedNow, after,
          });
          usedNow = after;
        }
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

      // Append the assistant message. NEVER push one that carries neither text
      // nor tool_calls: upstream rejects it with "content or tool_calls must be
      // set".
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
      } else if (this._truncated && truncationRecoveries < MAX_TRUNCATION_RECOVERIES) {
        if (!hasText) {
          // Truncated with NO text at all: every output token went into reasoning
          // (a reasoning model on a small budget). There is nothing to continue
          // from, and ending the turn here would look like the model simply had
          // nothing to say. Say what actually happened instead.
          this.onEvent({
            type: 'error',
            error: new Error(
              `The model reached its ${this.cfg.maxOutputTokens || 'configured'} output-token limit `
              + 'before producing any text — raise the output limit (HNCODE_MAX_OUTPUT) or lower the thinking effort.',
            ),
          });
          break;
        }
        // The answer was cut off by max_tokens: it is HALF an answer, and it is
        // already committed above with no tool calls. Ask the model to pick up
        // where it stopped instead of ending the turn — otherwise the user reads
        // a sentence that stops mid-word and assumes that was all of it.
        truncationRecoveries++;
        this.messages.push({
          role: 'user',
          content: 'Your previous message was cut off because it reached the output token limit. Continue from exactly where it stopped — do not repeat what you already wrote, and do not start over.',
        });
        this.onEvent({ type: 'truncation_recovery', attempt: truncationRecoveries });
        continue;
      } else if (!hasText) {
        // No tool calls and no answer text: the model stopped without saying
        // anything. End the turn.
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

      // Gate + execute + hooks for ONE call, with no message bookkeeping: the
      // caller posts the result separately, in call order. Splitting it this way
      // is what makes a parallel batch possible at all — concurrent calls finish
      // out of order, and tool results MUST be appended in the order the model
      // asked for them or the protocol pairing breaks.
      const prepareToolCall = async (tc) => {
        // Tag output produced by THIS tool call so onOutput can route it to the
        // right "Using …" row (a turn can run several tools in sequence).
        this._currentToolId = tc.id;

        // Permission check before executing each tool
        let result = null;
        let ok = true;
        if (this.onApproval) {
          const approved = await this.onApproval(tc.name, tc.args);
          if (!approved) {
            result = `Blocked by user: tool "${tc.name}" was rejected.`;
            this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
            return { ok: false, result, editDiff: null, media: false };
          }
        }

        const tool = getTool(tc.name);
        // A subagent may not delegate. The tool is not exposed to it, but the model
        // can still emit a call for a tool it was told about earlier, so refuse it
        // here with an actionable message instead of running a nested agent.
        if (this.noDelegation && DELEGATION_TOOLS.includes(tc.name)) {
          result = `You CAN'T use ${tc.name}: subagents cannot delegate. Do the work yourself and report the result to the agent that started you.`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }
        if (modeName && !this.cfg.toolFilter.includes(tc.name)) {
          result = `You CAN'T use this tool on ${modeName} Mode. Allowed: ${this.cfg.toolFilter.join(', ')}.`;
          this.onEvent({ type: 'tool_use', id: tc.id, name: tc.name, args: tc.args });
          return { ok: false, result, editDiff: null, media: false };
        }
        if (!tool) {
          result = `Error: unknown tool "${tc.name}".`;
          return { ok: false, result, editDiff: null, media: false };
        }
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
          return { ok: false, result, editDiff: null, media: false };
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
          ok = false;
        }
        this.ctx.lastResult = result;
        // Plugin hook: onToolResult fires with the tool's output.
        await runHooks('onToolResult', tc.name, result, this.ctx);
        // SHELL HOOK: PostToolUse. Never blocks (the tool already ran); a
        // failure is logged. This is where "format after every edit" lives.
        await runShellHooks(this.hookConfig, 'PostToolUse',
          { toolName: tc.name, toolArgs: tc.args, toolResult: result }, this.ctx.cwd || this.cfg.workspace);
        // SHELL HOOK: PostToolUseFailure. Fires only when the tool failed (an
        // `Error`/`[error:` result, or a thrown run), so a hook can alert or
        // retry without matching on every successful call.
        if (typeof result === 'string' && /^(Error\b|\[error:)/.test(result.trim())) {
          ok = false;
          await runShellHooks(this.hookConfig, 'PostToolUseFailure',
            { toolName: tc.name, toolArgs: tc.args, toolResult: result }, this.ctx.cwd || this.cfg.workspace);
        }
        // Surface the live TODO list so the TUI can render its panel.
        if (tc.name === 'TodoList') {
          this.onEvent({ type: 'todos', todos: this.ctx.todoState || [] });
        }
        // A tool may return a STRUCTURED result instead of a string: ReadMediaFile
        // returns `{ text, media }` so an image can travel as an image.
        const editDiff = this.ctx.lastEditDiff || null;
        const media = !!result && typeof result === 'object' && Array.isArray(result.media);
        this.ctx.lastEditDiff = null;
        return { ok, result, editDiff, media };
      };

      // Post one call's outcome: the model's `tool` message, then the TUI event.
      const postToolResult = (tc, out) => {
        if (!out.ok) allOk = false;
        if (out.media) {
          const forModel = out.editDiff
            ? { ...out.result, text: mediaResultText(out.result) + formatEditDiffForModel(out.editDiff) }
            : out.result;
          this.messages.push({ role: 'tool', toolCallId: tc.id, content: forModel });
          this.onEvent({
            type: 'tool_result', id: tc.id, name: tc.name,
            content: out.result._receipt || out.result.text || '[media]',
            editDiff: out.editDiff,
          });
          return;
        }
        // The transcript keeps the full text; the MODEL may get a bounded version
        // (a spill or a preview) so one huge read cannot inflate every subsequent
        // request. See tool-result.js.
        const rawForModel = out.editDiff ? out.result + formatEditDiffForModel(out.editDiff) : out.result;
        const shaped = toolResultLimitsEnabled()
          ? shapeToolResult(rawForModel, { sessionId: this.cfg.sessionId, toolCallId: tc.id })
          : { content: rawForModel, spilled: false };
        this.messages.push({ role: 'tool', toolCallId: tc.id, content: shaped.content });
        // Remember where the newest tool result landed: a trim must never elide the
        // output the model was handed in the step it is about to reason about.
        this._lastToolResultIndex = this.messages.length - 1;
        this.onEvent({
          type: 'tool_result', id: tc.id, name: tc.name, content: out.result,
          editDiff: out.editDiff, spilled: shaped.spilled,
        });
      };


      for (let i = 0; i < toolCalls.length; i++) {
        if (this.stopRequested) break;
        const tc = toolCalls[i];
        // A RUN of consecutive read-only calls goes out in parallel. Non-
        // destructive by construction (see READ_ONLY_TOOLS), so none of them can
        // observe another's effects. The system prompt has always promised this
        // ("Run independent tool calls in parallel; never parallelize dependent
        // ones") but the loop executed every call one at a time, so a model that
        // issued four Reads paid for four round-trips in sequence.
        if (!READ_ONLY_TOOLS.has(tc.name)) {
          postToolResult(tc, await prepareToolCall(tc));
          continue;
        }
        const batch = [tc];
        while (i + 1 < toolCalls.length && READ_ONLY_TOOLS.has(toolCalls[i + 1].name)) batch.push(toolCalls[++i]);
        if (batch.length === 1) {
          postToolResult(tc, await prepareToolCall(tc));
          continue;
        }
        // Results are posted in CALL order, never completion order.
        const outs = await Promise.all(batch.map((b) => prepareToolCall(b)));
        for (let k = 0; k < batch.length; k++) postToolResult(batch[k], outs[k]);
      }


      // Did THIS iteration still have tool calls? If the loop runs out of budget
      // right after running them, the turn really is unfinished.
      hadToolCallsOnFinalStep = toolCalls.length > 0;

      // Report the context after this step's tool results were appended: that is
      // exactly what the next request will carry, so the gauge grows with history.
      this.onEvent({ type: 'context', tokens: this.usedTokens(), max: maxCtx });

    }

    // With the cap removed this can only trigger for a caller that set an
    // explicit finite maxSteps: the final iteration still produced tool calls,
    // so the turn genuinely ran out of rounds. Checking the step index alone (as
    // this used to) reported "budget exhausted" for turns that had finished.
    if (Number.isFinite(stepLimit) && !this.stopRequested && hadToolCallsOnFinalStep) {
      this.onEvent({
        type: 'incomplete',
        reason: 'the step budget was exhausted while tools were still being called',
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