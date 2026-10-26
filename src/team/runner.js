// Running one teammate.
//
// A teammate's life is a loop, not a single call: it is given a job, works, reports, and then
// WAITS for more mail instead of ending. That is what makes it a team rather than a batch — the
// lead can send a correction after seeing the first result, and the teammate is still there to
// receive it.
//
//   claim/be given a task  ->  run the agent  ->  report to the lead  ->  wait  ->  (repeat)
//
// WHY IT ENDS AT ALL
// ------------------
// Three ways out, and each has to exist: the lead sends a shutdown, the idle timeout expires
// with nobody asking anything, or the run is interrupted. Without the timeout a forgotten
// teammate would hold its slot forever, and a single-threaded event loop full of never-ending
// agents cannot be reasoned about.
import { Agent } from '../agent.js';
import { readUnread, writeToMailbox, markAllRead, formatInbox } from './mailbox.js';
import { readTeamFile, updateMember } from './store.js';
import { leadOf } from './team.js';
import { claimTask, updateTask, readTasks, unclaimedTasks } from './tasks.js';
import { currentAgent } from './context.js';
import { TEAM_LEAD_NAME, TEAMMATE_MAX_STEPS, TEAMMATE_IDLE_TIMEOUT_MS } from './constants.js';

/**
 * Who this member reports to, or '' when it IS the one in charge.
 *
 * The lead is the first member added and carries `role: 'lead'`. `team.leadName` records the same
 * name, so when the two agree AND they are the member being asked about, this member is the lead —
 * and a lead has nobody above it to ask for work.
 */
export function reportsTo(team, member) {
  const self = member && member.name;
  const byRole = (team.members || []).find((m) => m.role === 'lead');
  const leadName = (byRole && byRole.name) || team.leadName || '';
  if (!leadName || leadName === self) return '';
  return leadName;
}

/**
 * Build what a teammate sees on its first turn.
 *
 * The ROSTER is deliberately NOT here. It used to be pasted in as a list, which looked convenient
 * and was wrong three ways:
 *
 *   * it cost tokens on every round, since this message is part of the transcript;
 *   * it went STALE — a member that joined or left afterwards changed the roster, while the copy in
 *     the conversation kept describing the old one;
 *   * it leaked into the model's reasoning about itself. A lead read its own name in that list and
 *     concluded it should ask "the lead" for work, i.e. ask itself, then reported the contradiction
 *     back to the user.
 *
 * The current roster is injected by `TEAMMATE_ADDENDUM`'s caller (see `teammateSystemPrompt`),
 * which recomputes it each round from the file.
 */
export function firstPrompt({ team, member, task, taskList, assignment }) {
  const parts = [];
  const leadName = reportsTo(team, member);
  if (task) {
    parts.push(`Your task (${task.id}): ${task.subject}`);
    if (task.description) parts.push(task.description);
  } else if (assignment) {
    // The prompt the member was spawned with IS its assignment. Without this the teammate opened
    // by asking the lead what to do — a round spent answering a question the spawner already knew.
    parts.push(`Your assignment: ${assignment}`);
  } else if (leadName) {
    // An instruction, not a statement of fact. The old wording ("You have no task yet. Ask the
    // lead what to work on.") read as a description of the situation, while the system prompt says
    // to message the lead when FINISHING or BLOCKED — neither of which is true yet. A model
    // following that rule stayed silent, so the lead received nothing and the team looked dead.
    parts.push(`You have no task yet. Your FIRST action is to send ${leadName} a short message`);
    parts.push(`asking for work: SendMessage with to="${leadName}". Do that before anything else.`);
  }
  if (taskList && taskList.length) {
    parts.push('');
    parts.push('The full task list (do not start anything already owned):');
    parts.push(taskList);
  }
  return parts.join('\n').trim();
}

/** The system prompt a teammate runs under: the normal one, plus how a teammate behaves. */
export const TEAMMATE_ADDENDUM = `
# You are a teammate

You are one member of a team. Someone directs the work — the LEAD, an agent whose name is on your
roster — and you report to it. If YOU are the lead, nobody directs you: the person using hncode
does, and you direct the others. The other members are your peers. You are addressed by name, and
you address others by name.

## Talking to the team

Use SendMessage: \`to\` a name sends to that member; \`to\` "*" reaches everyone else and should be
rare, because a broadcast interrupts each of them.

WHO YOU ANSWER is set by who wrote to you, not by a fixed name:
  - a message from the person using hncode carries the name \`team-lead\`. **Answer it with
    \`SendMessage\` to \`team-lead\`.** They are outside the roster, so they are the one recipient
    that is never "another member". This is the reply people wait for, and a person who gets no
    answer concludes the whole team is broken
  - a message from a member is answered to that member
  - a message from the lead is answered to the lead

Answer anything sent to you. A greeting, a question, a correction — each is a message somebody is
waiting on, and none of them is covered by "only report when you finish". Being silent about a
direct message is the one failure that reads as a dead teammate.

Report to the lead when:
  - you START, with no task yet — ask what to work on. Say so ONCE and then wait; the lead
    cannot answer a question you never sent, and silence looks exactly like being broken
  - you FINISH a piece of work — what you did, and where the result is
  - you are BLOCKED — what stopped you and what you need. That is more useful than a partial
    result with no explanation
  - something needs a decision you should not make alone

Otherwise, report ONCE and then stop talking. A message that only says "still working" costs a
turn and tells it nothing — work, then report. Do not narrate your progress.

## Doing the work

TeamTaskList shows the shared work and TeamTaskUpdate claims it. Claim before you start, so two
members do not take the same task, and mark it done with a short result — that is what the lead
reads to see the team moving.

If you are given a task, do it. If you cannot, say so plainly.`;

/**
 * The system prompt for one member: the shared addendum, plus WHO it is and WHO is on the team.
 *
 * Identity and the roster belong HERE rather than in the first user message, and the difference is
 * not cosmetic:
 *
 *   * a system prompt is rebuilt for every request, so it is always the CURRENT roster — a member
 *     that joined or left cannot leave a stale list behind in the transcript;
 *   * the conversation stays a record of the WORK. A pasted roster there is re-sent every round
 *     and reads as something that was said, so the model reasons about it as content rather than
 *     as configuration;
 *   * being told its own role here is what stops a LEAD reading the roster and concluding it
 *     should ask "the lead" — itself — for work, then reporting the contradiction to the user.
 *
 * `reportsTo` returning '' is what makes a lead a lead: it has nobody above it, so it is never
 * told to ask for an assignment, and is told instead that assigning work is its own job.
 */
export function teammateSystemPrompt(team, member) {
  const peers = (team.members || []).filter((m) => m && m.name && m.name !== member.name);
  const leadName = reportsTo(team, member);
  const lines = [TEAMMATE_ADDENDUM, ''];
  lines.push('# You, right now');
  lines.push('');
  if (leadName) {
    lines.push(`You are "${member.name}". ${leadName} is the lead — it decides what the team works on,`);
    lines.push('and it is who you report to.');
  } else {
    lines.push(`You are "${member.name}", and you ARE the lead of this team. You decide what the team`);
    lines.push('works on. Nobody assigns you work: take the user\'s instruction, break it into tasks,');
    lines.push('and hand those to the other members. Do not ask anyone for an assignment.');
  }
  if (peers.length) {
    lines.push('');
    lines.push('On the team with you:');
    for (const m of peers) {
      lines.push(`  ${m.name}${m.role === 'lead' ? ' (lead)' : ''}${m.agentType ? ` — ${m.agentType}` : ''}`);
    }
  } else {
    lines.push('');
    lines.push('You are currently the only member of this team.');
  }
  return lines.join('\n');
}

/**
 * Wait for mail.
 *
 * Polls the inbox rather than blocking on a watch: the delivery is a file rename from another
 * async context in this same process, and `fs.watch` on Windows reports a rename as two events
 * (the tmp appearing and the target changing) which would need de-duplicating anyway. A poll is
 * both simpler and more portable.
 *
 * `timeoutMs` of 0 (or less) means WAIT INDEFINITELY, and that is now the default for a
 * teammate: a member that gives up after two quiet minutes cannot be given work later, which
 * is the opposite of what a team is for. The lead is a person typing, and the gap between "you
 * are hired" and "here is the job" is not a failure. `shouldStop` is still honoured on every
 * poll, so a disband or an interrupt ends the wait promptly.
 *
 * Returns the unread messages, or null when the caller must stop.
 */
export async function waitForMail(teamName, agentName, { timeoutMs = 0, pollMs = 250, shouldStop } = {}) {
  const forever = !(timeoutMs > 0);
  const deadline = forever ? Infinity : Date.now() + timeoutMs;
  // Back off while the box stays empty: 250ms -> 2s. Every poll is a readFileSync
  // plus a JSON.parse of the whole inbox, so an idle eight-member team burned
  // 32 sync file reads a second, forever. Delivery is still prompt — a message
  // lands at most one backoff step (~2s) late, which is imperceptible for a
  // person typing the next instruction.
  let wait = pollMs;
  for (;;) {
    if (shouldStop && shouldStop()) return null;
    const unread = readUnread(teamName, agentName);
    if (unread.length) return unread;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 2000);
  }
}

/**
 * Run one teammate to completion.
 *
 * `deps` carries what the runner cannot import: the built agent config, the tool set, and the
 * callbacks that reach the TUI. Passing them in keeps this module free of the 17k-line TUI it
 * would otherwise have to import, and makes the loop testable with a stub agent.
 */
export async function runTeammate({
  teamName,
  memberName,
  cfg,
  makeState,
  toolNote = () => {},
  shouldStop = () => false,
  // 0 = wait forever. See `waitForMail`: a member that quits after a quiet spell cannot be
  // given work later, and the lead is a person typing rather than a service on a deadline.
  idleTimeoutMs = 0,
  makeAgent,
  onStart,
  onFinish,
  // Live output from this member's turn: `{ kind, text }` / `{ kind: 'tool', name, detail }`.
  //
  // Without it a teammate was a black box — the roster said idle→working→idle and nothing about what
  // it did in between. A person watching a team needs to see the work, not only its conclusion: a
  // member that spends forty seconds running tests looks identical to one that hung.
  onStream = () => {},
  // Ask the person before a tool runs, via the lead's mailbox.
  // `async (toolName, args) => boolean | { approved, error }`.
  //
  // An injected hook rather than a hard-wired call: `runTeammate` is exercised in tests with a fake agent
  // and no team, and a permission round-trip there would block for the full timeout on every tool.
  askPermission,
}) {
  const identity = currentAgent();
  if (!identity || identity.name !== memberName) {
    return { ok: false, error: `runTeammate must be called inside runAs() for "${memberName}"` };
  }

  const team = readTeamFile(teamName);
  if (!team) return { ok: false, error: `no team "${teamName}"` };
  const member = team.members.find((m) => m.name === memberName);
  if (!member) return { ok: false, error: `"${memberName}" is not on team "${teamName}"` };

  // A task may have been assigned before the teammate started, or be waiting to be claimed.
  let task = null;
  if (member.taskId) {
    task = readTasks(teamName).find((t) => t.id === member.taskId) || null;
  }
  if (!task) {
    const free = unclaimedTasks(teamName);
    if (free.length) {
      const claimed = claimTask(teamName, free[0].id, memberName);
      if (claimed.ok) task = claimed.task;
    }
  }

  const taskList = readTasks(teamName);
  // The system entry goes FIRST and the task text after it. The Agent has no `systemPrompt`
  // option — the prompt is an ordinary system message the caller supplies, which is how the
  // TUI builds one per turn.
  //
  // THE FIRST PROMPT MUST NOT BE EMPTY. An empty user turn gives the model nothing to answer, so the
  // round produces no reply and the member looks dead. That happened whenever `firstPrompt` had nothing
  // to say — no task, no assignment, and no lead to report to — which is the NORMAL start for the first
  // member of a team, because `addMember` makes the first member the lead and "report to the lead" then
  // resolves to itself and returns ''.
  const opening = firstPrompt({
    team,
    member,
    task,
    taskList: taskList.length ? taskList.map((t) => `${t.id} ${t.status} ${t.subject}`).join('\n') : '',
    assignment: member.prompt || '',
  }) || 'You are on the team and have no task yet. Read the messages in your next input, answer the lead, and use SendMessage to reply.';
  const messages = [
    { role: 'system', content: teammateSystemPrompt(team, member) },
    { role: 'user', content: opening },
  ];

  onStart && onStart({ member, task });

  const result = { ok: true, reports: [], task: task && task.id };
  let idle = false;

  for (;;) {
    if (shouldStop()) break;

    updateMember(teamName, memberName, { isActive: true, phase: 'thinking' });

    // Run the agent for this round. `messages` is the running transcript OF THIS TEAMMATE,
    // so it remembers what it already did across the rounds of one assignment.
    // One round of the teammate's work. `makeAgent` is injectable so the loop can be tested
    // without a model; production passes nothing and gets a real Agent.
    const build = makeAgent || ((opts) => new Agent(opts));
    // Whether THIS round invoked SendMessage. Reset per round because the fallback below only applies
    // to a round that stayed silent — a member that answered with the tool has already been delivered.
    let sentThisRound = false;
    const agent = build({
      cfg,
      messages,
      maxSteps: TEAMMATE_MAX_STEPS,
      // ASK THE PERSON, THROUGH THE LEAD, BEFORE ANY TOOL RUNS.
      //
      // A teammate can write files and run commands, and until this existed it had exactly two options:
      // do anything, or be unable to ask. This forwards the question to the lead's mailbox and BLOCKS
      // here until the answer comes back — the runner is synchronous per round, so a refusal has to
      // arrive as a value, not as a later event.
      //
      // `askPermission` is undefined for a team whose lead has no panel; the call then resolves to a
      // refusal with a reason, which the model can act on.
      onApproval: askPermission,
      onEvent: (e) => {
        if (e.type === 'tool_start' && /^SendMessage$/.test(String(e.name || ''))) sentThisRound = true;
        if (e.type === 'tool_start') toolNote(memberName, e.name, e.args);
        // The one moment a member is unambiguously working, as opposed to blocked on the
        // model — which is what most of a round is.
        updateMember(teamName, memberName, { isActive: true, phase: 'working' });

        // LIVE OUTPUT — as TRANSCRIPT ENTRIES, not status blips.
        //
        // Claude Code renders a teammate by feeding `viewedAgentTask.messages` to the SAME <Messages>
        // component the main transcript uses (REPL.tsx: `displayedMessages = viewedAgentTask.messages`),
        // so its answer, its tool calls and their results read as one conversation. Relaying bare
        // strings meant the panel had nothing to show but a single activity line — which is exactly the
        // complaint: "I switch to a member and see no messages, though it is working."
        try {
          if (e.type === 'data' && e.text) {
            onStream({ kind: 'text', name: memberName, text: String(e.text) });
          } else if (e.type === 'think' && e.text) {
            onStream({ kind: 'think', name: memberName, text: String(e.text) });
          } else if (e.type === 'tool_start') {
            onStream({ kind: 'tool', name: memberName, tool: String(e.name || ''), id: e.id || '' });
          } else if (e.type === 'tool_result') {
            // The WHOLE result. The panel wraps and clips at render time, where the available height is
            // known; trimming to the first line here threw away the body a reader came for.
            onStream({
              kind: 'tool_result',
              name: memberName,
              tool: String(e.name || ''),
              id: e.id || '',
              detail: String(e.content || ''),
              editDiff: e.editDiff || null,
            });
          }
        } catch { /* a display hook must never fail a member's turn */ }
      },
    });
    // A ROUND THAT THROWS MUST BE REPORTED, not swallowed.
    //
    // `agent.run()` reaches the model, so it fails for every reason the network and the provider can
    // produce: no model configured, a bad key, a 429, a dropped connection. Without this the error left
    // `runTeammate` entirely — no reply, no log the user could see, and the member simply looked
    // unresponsive. That is indistinguishable from "the team is ignoring me", which is exactly how it was
    // reported.
    //
    // The message goes to the lead's inbox, which reaches the TUI through the same onLeadMail path as an
    // ordinary reply, so a failure is visible where a reply would have been.
    try {
      await agent.run();
    } catch (e) {
      const why = (e && e.message) || String(e);
      writeToMailbox(teamName, TEAM_LEAD_NAME, {
        from: memberName,
        text: `I could not complete this round: ${why}`,
        summary: 'round failed',
        color: member.color,
      });
      result.failed = (result.failed || 0) + 1;
      result.lastError = why;
      updateMember(teamName, memberName, { isActive: false, phase: 'idle' });
      onFinish && onFinish({ member, task });
      result.ok = false;
      // Back to waiting rather than exiting: a transient failure (a rate limit) must not end the member.
      // `waitForMail` below decides whether it stops, on the same terms as a successful round.
      const mail = await waitForMail(teamName, memberName, { timeoutMs: idleTimeoutMs, shouldStop });
      if (!mail) { idle = true; break; }
      continue;
    }

    // The Agent kept the SAME array and appended to it, so the transcript already carries
    // this round. Nothing to copy — `messages` IS `agent.messages`.
    // A round that answered in TEXT instead of calling SendMessage must still reach the lead.
    //
    // The tool is how a member is TOLD to reply, and most rounds use it. A model that answers
    // conversationally instead — "I'm here, got your message" — produces the same words and sends them
    // nowhere, so the person who asked gets silence while the member considers itself done. From outside
    // that is indistinguishable from being ignored, which is how it was reported.
    //
    // The guard: only when `SendMessage` did NOT run this round. `sentThisRound` is set by the agent's
    // tool events, so a round that replied properly is not answered twice.
    if (!sentThisRound) {
      const text = lastAssistantText(agent);
      if (text) {
        writeToMailbox(teamName, TEAM_LEAD_NAME, {
          from: memberName,
          text,
          summary: 'reply',
          color: member.color,
        });
      }
    }

    // A tool named SendMessage already delivered its message (see the tool's own handler), so
    // here we only report completion to the lead if the agent did not.
    if (task) {
      const t = readTasks(teamName).find((x) => x.id === task.id);
      if (t && t.status === 'in_progress') {
        updateTask(teamName, task.id, {
          status: 'completed',
          result: lastAssistantText(agent) || '',
        });
        // The team's OWN lead: a member reports to whoever leads it, which is not
        // necessarily the default name.
        writeToMailbox(teamName, leadOf(teamName), {
          from: memberName,
          text: `Done with ${task.id}: ${task.subject}\n\n${lastAssistantText(agent) || '(no summary)'}`,
          summary: `done ${task.id}`,
          color: member.color,
        });
      }
    }

    updateMember(teamName, memberName, { isActive: false, phase: 'idle' });
    onFinish && onFinish({ member, task });

    const mail = await waitForMail(teamName, memberName, { timeoutMs: idleTimeoutMs, shouldStop });
    if (!mail) { idle = true; break; }

    // Only the batch that was just read is marked. Marking the whole box would also
    // mark anything delivered since `waitForMail` returned, and that message would
    // then never be seen — it is unread, so it is not in `mail`, and it is now read,
    // so the next `readUnread` skips it.
    markAllRead(teamName, memberName, mail);

    // A shutdown or a team-ending notice stops the loop before the agent sees it as a request.
    const stop = mail.find((m) => /\[(shutdown|team ending)\]/i.test(m.text));
    if (stop) { result.stoppedBy = stop.from; break; }

    messages.push({ role: 'user', content: formatInbox(mail) });
    result.reports.push(...mail.map((m) => ({ from: m.from, summary: m.summary })));
  }

  updateMember(teamName, memberName, { isActive: false });
  return { ...result, idle };
}

/** The teammate's last assistant turn, as plain text. */
function lastAssistantText(agent) {
  const msgs = agent.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '');
    if (text.trim()) return text.trim();
  }
  return '';
}
