// Who is running right now.
//
// A teammate runs in the SAME process as its lead, so "am I a teammate" cannot live on a module
// variable — every member would overwrite it and the last one to start would answer for all of
// them. `AsyncLocalStorage` gives each async execution chain its own view, which is the shape
// needed: a teammate's whole run happens inside one `runAs` call, so every function it reaches
// sees ITS identity while the lead's sees none.
//
// WHY NOT A STACK
// ---------------
// A stack would be popped by any interleaving, and teammate runs interleave freely — they await
// tool calls, network, timers. AsyncLocalStorage follows the async context rather than the call
// stack, so it survives those awaits.
import { AsyncLocalStorage } from 'node:async_hooks';
import { TEAM_LEAD_NAME } from './constants.js';

const storage = new AsyncLocalStorage();

/**
 * The identity of the member whose async context we are inside, or undefined for the lead.
 *
 * `undefined` IS the lead: the person at the keyboard is not a teammate. Code that needs "am I a
 * teammate" asks `currentAgent()`, rather than a separate flag that could disagree with this.
 */
export function currentAgent() {
  return storage.getStore() || undefined;
}

export function isTeammate() {
  return !!storage.getStore();
}

/** The calling member's name, or the lead's when there is none. */
export function currentAgentName() {
  const ctx = storage.getStore();
  return ctx ? ctx.name : TEAM_LEAD_NAME;
}

/** The team the calling member belongs to, or undefined for a lead with no team. */
export function currentTeamName() {
  const ctx = storage.getStore();
  return ctx ? ctx.teamName : undefined;
}

/**
 * Run `fn` as `identity`.
 *
 * Every await inside `fn` sees the same identity — that is the whole point, and why this must
 * WRAP the teammate's run rather than be set before it.
 */
export function runAs(identity, fn) {
  return storage.run(identity, fn);
}

/** Build the identity record for a member. */
export function makeIdentity({ name, teamName, color, agentType, model, taskId = null }) {
  return {
    name,
    teamName,
    color,
    agentType: agentType || 'general',
    model: model || '',
    // Set when this teammate was spawned to work on a specific task, so it can report back to
    // that task rather than to the team at large.
    taskId,
  };
}

// Distinct enough to tell apart in a log line.
export const MEMBER_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'orange'];

/**
 * A colour for a member: stable per name, avoiding what the team already uses.
 *
 * Stable because a colour that changed between messages would make the transcript unreadable —
 * the eye tracks a member BY its colour.
 */
export function pickColor(name, taken = []) {
  const used = new Set(taken);
  const n = MEMBER_COLORS.length;
  const start = [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % n;
  for (let i = 0; i < n; i++) {
    const c = MEMBER_COLORS[(start + i) % n];
    if (!used.has(c)) return c;
  }
  // Every colour taken: share one rather than returning undefined, which would leave the member
  // uncoloured and indistinguishable.
  return MEMBER_COLORS[start];
}
