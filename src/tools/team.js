// The tools a model uses to work with a team.
//
//   TeamCreate    start a team (the caller becomes its lead)
//   TeamDelete    dissolve it
//   SendMessage   talk to a member, or to everyone
//   TaskCreate    put work on the shared list
//   TaskUpdate    change a task's state, and claim or release it
//   TaskList      read the list
//
// Each one is a THIN wrapper: the rules live in team.js / tasks.js / mailbox.js, so a command,
// a tool and a test all take the same path. A tool that reimplemented "can I claim this" would
// be a second place for that rule to be wrong.
import { createTeam, disbandTeam, addMember, removeTeammate, formatRoster, findMember, leadOf } from '../team/team.js';
import { readTeamFile, formatAgentId } from '../team/store.js';
import { writeToMailbox, readMailbox, formatInbox } from '../team/mailbox.js';
import { createTask, updateTask, readTasks, claimTask, releaseTask, formatTasks, TASK_STATES } from '../team/tasks.js';
import { currentAgent } from '../team/context.js';
import { leadTeam as sharedLeadTeam, setLeadTeam, clearLeadTeam as sharedClearLeadTeam } from '../session-core.js';
import { TEAM_LEAD_NAME, BROADCAST } from '../team/constants.js';

// The lead's team lives in session-core.js, because the `/team` command needs it too and a
// second copy would let the keyboard and the model disagree about which team is active.

/** The team the lead is on, or null. Read by the roster view and by the team command. */
export function leadTeam() { return sharedLeadTeam(); }

/** Forget the lead's team. Called when it is dissolved. */
export function clearLeadTeam() { return sharedClearLeadTeam(); }

/**
 * Who is calling, and which team they are on.
 *
 * A teammate's team comes from its AsyncLocalStorage identity; the lead passes the team name
 * explicitly because it has no identity of its own — `currentAgent()` is undefined for the
 * person at the keyboard.
 */
function caller(args) {
  const me = currentAgent();
  if (me) return { name: me.name, teamName: me.teamName, isTeammate: true };
  return { name: TEAM_LEAD_NAME, teamName: args.team_name || sharedLeadTeam(), isTeammate: false };
}

function requireTeam(teamName) {
  if (!teamName) return 'Error: no team. Pass `team_name`, or create one with TeamCreate.';
  const team = readTeamFile(teamName);
  if (!team) return `Error: no team "${teamName}". Use TeamCreate first.`;
  return null;
}

// ---------------------------------------------------------------------------
// TeamCreate
// ---------------------------------------------------------------------------

export const TeamCreateSpec = {
  name: 'TeamCreate',
  get description() {
    return [
      'Create a team and become its lead.',
      '',
      'A team is a named roster of agents that can message each other and share one task list.',
      'Use it when the work divides into parts that need to talk — an agent that only needs to',
      'report back does not need a team; the Agent tool is cheaper.',
      '',
      'After creating one, add members with TeamCreate\'s `members` list, then put work on the',
      'shared list with TaskCreate.',
    ].join('\n');
  },
  parameters: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'A short name for the team, e.g. "auth-refactor".' },
      description: { type: 'string', description: 'What the team is for. Shown to every member.' },
      members: {
        type: 'array',
        description: 'Members to start with. Each gets its own agent, running in the background.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short name, used to address this member.' },
            agent_type: { type: 'string', description: 'Its role, e.g. "coder", "tester".' },
            prompt: { type: 'string', description: 'What it should start doing. Omit to have it ask.' },
            model: { type: 'string', description: 'Optional model override.' },
          },
          required: ['name'],
        },
      },
    },
    required: ['team_name'],
  },
  async execute(args, ctx) {
    const me = caller(args);
    if (me.isTeammate) {
      return { error: 'Error: a teammate cannot create a team. Only the session\'s own agent can.' };
    }
    const r = createTeam({
      teamName: args.team_name,
      description: args.description,
      leadSessionId: (ctx && ctx.session && ctx.session.id) || '',
      cwd: (ctx && ctx.cwd) || process.cwd(),
    });
    if (!r.ok) return { error: `Error: ${r.error}` };
    // Remember it, so every later tool call from the lead knows where it belongs.
    setLeadTeam(r.team.name);

    const added = [];
    const refused = [];
    for (const m of (Array.isArray(args.members) ? args.members : [])) {
      const a = addMember(args.team_name, {
        name: m.name,
        agentType: m.agent_type || 'general',
        model: m.model || '',
        prompt: m.prompt || '',
        cwd: (ctx && ctx.cwd) || process.cwd(),
      });
      if (a.ok) added.push({ ...a.member, prompt: m.prompt || '' });
      else refused.push(`${m.name}: ${a.error}`);
    }

    // Spawning is the caller's job: this module has no business starting agents, and the TUI
    // owns the event loop they need. It hands back what to spawn.
    if (ctx && typeof ctx.spawnTeammates === 'function' && added.length) {
      try { await ctx.spawnTeammates(args.team_name, added); } catch { /* reported below */ }
    }

    const lines = [
      `Team "${r.team.name}" created. You are "${TEAM_LEAD_NAME}".`,
      r.team.description ? `Purpose: ${r.team.description}` : '',
      '',
      formatRoster(readTeamFile(r.team.name)),
    ].filter(Boolean);
    if (refused.length) lines.push('', 'Not added:', ...refused.map((x) => `  ${x}`));
    if (added.length && !(ctx && ctx.spawnTeammates)) {
      lines.push('', 'Note: these members are on the roster but no agent is running for them yet.');
    }
    return { content: lines.join('\n') };
  },
};

// ---------------------------------------------------------------------------
// TeamDelete
// ---------------------------------------------------------------------------

export const TeamDeleteSpec = {
  name: 'TeamDelete',
  description: 'Dissolve a team: tell its members, then remove the roster, the inboxes and the shared task list.',
  parameters: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'The team to dissolve. Defaults to the caller\'s own team.' },
      reason: { type: 'string', description: 'Sent to each member before the team goes.' },
    },
  },
  async execute(args) {
    const me = caller(args);
    const teamName = me.teamName || args.team_name;
    const err = requireTeam(teamName);
    if (err) return { error: err };
    const r = disbandTeam(teamName, { reason: args.reason || 'the lead ended the team' });
    if (!r.ok) return { error: `Error: ${r.error}` };
    if (sharedLeadTeam() === teamName) sharedClearLeadTeam();
    return { content: `Team "${teamName}" dissolved.${r.told ? ` ${r.told} member(s) were told.` : ''}` };
  },
};

// ---------------------------------------------------------------------------
// SendMessage
// ---------------------------------------------------------------------------

export const SendMessageSpec = {
  name: 'SendMessage',
  get description() {
    return [
      'Send a message to a teammate, or to everyone on the team.',
      '',
      '`to` is a member name, or "*" to reach every member except yourself.',
      '',
      'Messages are delivered to the recipient\'s inbox and read on its next step — so this is',
      'asynchronous: it does not wait for a reply. Say what you need and move on; the answer',
      'arrives as a message of its own.',
      '',
      'Use it to hand over work, report a result, or ask a question only that member can answer.',
      'Do not use it to narrate progress — a message that says nothing costs the recipient a turn.',
    ].join('\n');
  },
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'A member name, or "*" to message the whole team.' },
      message: { type: 'string', description: 'The text to send.' },
      summary: { type: 'string', description: 'Five to ten words for the recipient\'s list view.' },
    },
    required: ['to', 'message'],
  },
  async execute(args, ctx) {
    const me = caller(args);
    const teamName = me.teamName || args.team_name;
    const err = requireTeam(teamName);
    if (err) return { error: err };

    const team = readTeamFile(teamName);
    const text = String(args.message == null ? '' : args.message).trim();
    if (!text) return { error: 'Error: `message` is empty.' };

    const color = (findMember(teamName, me.name) || {}).color;

    if (args.to === BROADCAST) {
      // Everyone but the sender. The lead is included when a MEMBER broadcasts — "everyone else"
      // means the lead too, and leaving it out was why a member's broadcast reached no one.
      const others = team.members.filter((m) => m.name !== me.name);
      if (!others.length) return { error: 'Error: there is nobody else on the team to broadcast to.' };
      for (const m of others) {
        writeToMailbox(teamName, m.name, { from: me.name, text, summary: args.summary, color });
      }
      return { content: `Broadcast to ${others.length} member(s): ${others.map((m) => m.name).join(', ')}` };
    }

    // `team-lead` is the USER, and it is a real inbox — not a roster entry.
    //
    // The user is not a member: their session sits outside the roster, and it reads the boxes
    // named `leadOf(team)` AND `TEAM_LEAD_NAME` (see `readLeadInbox`). Their own sends carry the
    // `team-lead` alias, so a teammate answering one addresses `to: 'team-lead'`.
    //
    // Resolving that to `leadOf(team)` was wrong: for a team whose only agent IS the lead, the
    // alias resolved back to the sender, and `SendMessage` refused with "that is you" — so the
    // report it had just written was never delivered. Writing to the alias directly is what
    // reaches the person, and it is why the box exists.
    if (args.to === TEAM_LEAD_NAME) {
      writeToMailbox(teamName, TEAM_LEAD_NAME, { from: me.name, text, summary: args.summary, color });
      // Tell the running TUI at once, so the message appears in the user's transcript as it is sent
      // rather than waiting for their next turn.
      //
      // Without this the reply was only ever written to a file: `formatLeadInbox` runs at the START of
      // a turn, so a member's answer sat unread until the person happened to type something else. From
      // the user's side that is indistinguishable from the team being dead — they send an instruction,
      // nothing appears, and the answer is already on disk.
      //
      // The callback reaches here through `ctx`, which the Agent builds by spreading the teammate's
      // config, so the spawner only has to put it there.
      if (typeof ctx?.onLeadMail === 'function') {
        try { ctx.onLeadMail({ from: me.name, text, summary: args.summary, color }); } catch { /* never fail a send over a display hook */ }
      }
      return { content: 'Sent to the lead (the user).' };
    }

    const target = team.members.find((m) => m.name === args.to);
    if (!target) {
      // Naming the candidates turns a dead end into a fix.
      return { error: `Error: no member "${args.to}" on team "${teamName}". Members: ${team.members.map((m) => m.name).join(', ')}` };
    }
    if (target.name === me.name) return { error: 'Error: that is you. Pick another member, or "*".' };

    writeToMailbox(teamName, target.name, { from: me.name, text, summary: args.summary, color });
    return { content: `Sent to ${target.name}.` };
  },
};

// ---------------------------------------------------------------------------
// TaskCreate / TaskUpdate / TaskList
// ---------------------------------------------------------------------------

export const TeamTaskCreateSpec = {
  name: 'TeamTaskCreate',
  description: 'Add a task to the team\'s shared list. Every member sees the same list, so this is how work is divided.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'One line: what needs doing.' },
      description: { type: 'string', description: 'Detail a member needs to do it without asking.' },
      owner: { type: 'string', description: 'A member name to assign it to. Omit to leave it for whoever is free.' },
      blocked_by: {
        type: 'array',
        description: 'Task ids that must finish first, e.g. ["#1"].',
        items: { type: 'string' },
      },
    },
    required: ['subject'],
  },
  async execute(args, ctx) {
    const me = caller(args);
    const teamName = me.teamName || args.team_name;
    const err = requireTeam(teamName);
    if (err) return { error: err };

    if (args.owner) {
      const team = readTeamFile(teamName);
      // The LEAD is addressable by the alias the user's own messages carry, so an owner named
      // `team-lead` resolves to the agent that actually holds the role.
      const owner = args.owner === TEAM_LEAD_NAME ? leadOf(teamName) : args.owner;
      if (!team.members.some((m) => m.name === owner)) {
        return { error: `Error: no member "${args.owner}". Members: ${team.members.map((m) => m.name).join(', ')}` };
      }
    }
    const t = createTask(teamName, {
      subject: args.subject,
      description: args.description,
      owner: args.owner || null,
      blockedBy: args.blocked_by,
      createdBy: me.name,
    });
    if (args.owner) updateTask(teamName, t.id, { status: 'in_progress' });
    return { content: `Created ${t.id}: ${t.subject}${args.owner ? ` (assigned to ${args.owner})` : ''}` };
  },
};

export const TeamTaskUpdateSpec = {
  name: 'TeamTaskUpdate',
  get description() {
    return [
      'Change a task: claim it, release it, or set its state.',
      '',
      `status is one of: ${TASK_STATES.join(', ')}.`,
      '',
      'Claiming checks the task is not taken and not blocked, and says which when it refuses —',
      'so a refusal tells you what to do next rather than just failing.',
    ].join('\n');
  },
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The id, e.g. "#3".' },
      status: { type: 'string', enum: TASK_STATES, description: 'The new state.' },
      claim: { type: 'boolean', description: 'Take ownership. Refused if someone else has it, or it is blocked.' },
      release: { type: 'boolean', description: 'Give it back, so another member can take it.' },
      owner: { type: 'string', description: 'Assign it to a member by name.' },
      result: { type: 'string', description: 'What came of it. Worth setting when completing.' },
    },
    required: ['task_id'],
  },
  async execute(args, ctx) {
    const me = caller(args);
    const teamName = me.teamName || args.team_name;
    const err = requireTeam(teamName);
    if (err) return { error: err };
    const id = String(args.task_id);

    if (args.claim) {
      const r = claimTask(teamName, id, me.name);
      if (!r.ok) return { error: `Error: cannot claim ${id} — ${r.reason}.` };
      return { content: `Claimed ${id}: ${r.task.subject}` };
    }
    if (args.release) {
      const r = releaseTask(teamName, id, me.name);
      if (!r.ok) return { error: `Error: ${r.reason}.` };
      return { content: `Released ${id}.` };
    }

    const patch = {};
    if (args.status) patch.status = args.status;
    if (args.owner) patch.owner = args.owner;
    if (args.result !== undefined) patch.result = String(args.result);
    if (!Object.keys(patch).length) return { error: 'Error: nothing to change. Pass status, claim, release, owner or result.' };

    // Completing without saying who did it leaves the list unable to answer "who finished this".
    if (patch.status === 'completed' && !patch.result && !me.isTeammate) {
      patch.result = '';
    }
    const t = updateTask(teamName, id, patch);
    if (!t) return { error: `Error: no task ${id} on team "${teamName}".` };
    return { content: `Updated ${id}: ${t.status}${t.owner ? ` @${t.owner}` : ''} — ${t.subject}` };
  },
};

export const TeamTaskListSpec = {
  name: 'TeamTaskList',
  description: 'Read the team\'s shared task list: what is unclaimed, what is in flight, what is blocked.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Only tasks owned by this member.' },
      status: { type: 'string', enum: TASK_STATES, description: 'Only tasks in this state.' },
    },
  },
  async execute(args) {
    const me = caller(args);
    const teamName = me.teamName || args.team_name;
    const err = requireTeam(teamName);
    if (err) return { error: err };
    let list = readTasks(teamName);
    if (args.owner) list = list.filter((t) => t.owner === args.owner);
    if (args.status) list = list.filter((t) => t.status === args.status);
    return { content: formatTasks(list) };
  },
};

// ---------------------------------------------------------------------------
// ListTeammates — so a member can find out who exists without being told
// ---------------------------------------------------------------------------

export const ListTeammatesSpec = {
  name: 'ListTeammates',
  description: 'The team roster: who is on it, what they are doing, and how much unread mail each has.',
  parameters: { type: 'object', properties: {} },
  async execute(args) {
    const me = caller(args);
    const teamName = me.teamName || args.team_name;
    const err = requireTeam(teamName);
    if (err) return { error: err };
    return { content: formatRoster(readTeamFile(teamName)) };
  },
};

/** Every team tool, for the catalog. */
export const TEAM_TOOL_SPECS = [
  TeamCreateSpec,
  TeamDeleteSpec,
  SendMessageSpec,
  TeamTaskCreateSpec,
  TeamTaskUpdateSpec,
  TeamTaskListSpec,
  ListTeammatesSpec,
];
