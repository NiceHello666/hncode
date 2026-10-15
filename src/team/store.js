// Where a team lives on disk.
//
//   ~/.hncode/teams/<team>/config.json         the roster (TeamFile)
//   ~/.hncode/teams/<team>/inboxes/<name>.json  one inbox per member
//   ~/.hncode/tasks/<team>/                     the shared task list
//
// WHY FILES RATHER THAN MEMORY
// ----------------------------
// Every member runs in the same process, so a Map would be simpler — and would be wrong. The
// roster has to survive the session that created it (a teammate outlives the turn that spawned
// it, and `--continue` must find the team again), and the mailbox is the ONE channel members
// share. Keeping both on disk means a member written to by another is never holding a stale
// copy, and a crashed session leaves something a person can read.
//
// The layout mirrors Claude Code's (`~/.claude/teams/...`), so the mental model transfers and a
// reader of either project recognises the other.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The per-user directory. Resolved per call so a test can redirect it after import. */
function homeDir() {
  return process.env.HNCODE_HOME || os.homedir();
}

export function teamsRoot() {
  return path.join(homeDir(), '.hncode', 'teams');
}

export function tasksRoot() {
  return path.join(homeDir(), '.hncode', 'tasks');
}

// A team name becomes a directory name, so it cannot be trusted as-is: `../` would escape the
// teams directory, and a name with a slash would place the files somewhere else entirely.
export function sanitizeName(name) {
  return String(name == null ? '' : name).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

export function teamDir(teamName) {
  return path.join(teamsRoot(), sanitizeName(teamName));
}

export function teamFilePath(teamName) {
  return path.join(teamDir(teamName), 'config.json');
}

export function inboxDir(teamName) {
  return path.join(teamDir(teamName), 'inboxes');
}

export function inboxPath(teamName, agentName) {
  return path.join(inboxDir(teamName), `${sanitizeName(agentName)}.json`);
}

export function teamTasksDir(teamName) {
  return path.join(tasksRoot(), sanitizeName(teamName));
}

/** Every team on disk, newest first. Never throws. */
export function listTeams() {
  let entries;
  try {
    entries = fs.readdirSync(teamsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(teamsRoot(), e.name, 'config.json');
    try {
      out.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { /* a half-written or removed team is skipped, not fatal */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** The roster, or null. Never throws. */
export function readTeamFile(teamName) {
  try {
    return JSON.parse(fs.readFileSync(teamFilePath(teamName), 'utf8'));
  } catch {
    return null;
  }
}

/** Write the roster, creating the directory. Throws only on a real IO failure. */
export function writeTeamFile(teamName, teamFile) {
  fs.mkdirSync(teamDir(teamName), { recursive: true });
  fs.writeFileSync(teamFilePath(teamName), JSON.stringify(teamFile, null, 2), 'utf8');
  return teamFile;
}

/**
 * Update one member, read-modify-write.
 *
 * Not a cached object: two members can be updated in the same tick (one goes idle while another
 * starts), and a write from a borrowed copy would lose whichever change came first.
 */
export function updateMember(teamName, memberName, patch) {
  const team = readTeamFile(teamName);
  if (!team) return false;
  const i = team.members.findIndex((m) => m.name === memberName);
  if (i < 0) return false;
  team.members[i] = { ...team.members[i], ...patch };
  writeTeamFile(teamName, team);
  return true;
}

/** Remove a member. Returns false when the team or the member is unknown. */
export function removeMember(teamName, memberName) {
  const team = readTeamFile(teamName);
  if (!team) return false;
  const before = team.members.length;
  team.members = team.members.filter((m) => m.name !== memberName);
  if (team.members.length === before) return false;
  writeTeamFile(teamName, team);
  return true;
}

/** Delete a team and its inboxes. The shared task list is left alone unless asked. */
export function deleteTeam(teamName, { tasks = true } = {}) {
  const remove = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } };
  const ok = remove(teamDir(teamName));
  if (tasks) remove(teamTasksDir(teamName));
  return ok;
}

/**
 * The id every teammate is addressed by: `<name>@<team>`.
 *
 * Deterministic on purpose — `team-lead@my-team` is derivable without asking, so a member that
 * only knows the team name can still address the lead, and a teammate spawned twice under the
 * same name does not accumulate two identities.
 */
export function formatAgentId(name, teamName) {
  return `${sanitizeName(name)}@${sanitizeName(teamName)}`;
}

/** The name half of an agent id, or the id itself when it has no team. */
export function agentNameOf(agentId) {
  const at = String(agentId || '').indexOf('@');
  return at < 0 ? String(agentId || '') : String(agentId).slice(0, at);
}
