/** The name every team's leader is known by. Not a member name a user can pick. */
export const TEAM_LEAD_NAME = 'team-lead';

/** Broadcast address in SendMessage: everyone on the team except the sender. */
export const BROADCAST = '*';

/** How many teammates one team may hold. A team that grows past this cannot be reasoned about. */
export const MAX_TEAMMATES = 8;

/** How many tool steps a teammate may take in one run before it is stopped. */
export const TEAMMATE_MAX_STEPS = 40;

/**
 * How long a teammate waits for a message before ending its run.
 *
 * 0 = indefinitely, which is the default: the lead is a person typing, and a member that
 * quits after a quiet spell cannot be given work later. A caller that genuinely wants a
 * bounded run passes a positive value (`spawnTeammate({ idleTimeoutMs: 60_000 })`).
 */
export const TEAMMATE_IDLE_TIMEOUT_MS = 0;
