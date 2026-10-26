// Permission requests, routed from a member to the person through the team mailbox.
//
// WHY THIS FILE EXISTS
// --------------------
// A teammate runs tools that can write files and execute commands. Until now it had exactly two options:
// be allowed to do anything, or be unable to ask. There was no middle — nothing carried "may I run this?"
// from the member to the person who could answer, and nothing carried the answer back.
//
// The protocol is the mailbox, because it is the only channel that already reaches both ends:
//
//   1. the member blocks on a tool it may not run and writes a `permission_request` to the lead's box
//   2. the TUI shows it (the lead's inbox is already drained every turn)
//   3. the person approves or refuses; a `permission_response` goes to the member's box
//   4. the member's runner polls for the response, matches it by `request_id`, and continues
//
// `request_id` is what makes this correct rather than a race: a member may have several calls in flight,
// and a response that arrived for an earlier one must not authorise a later one.
import { writeToMailbox, readMailbox, removeMail } from './mailbox.js';
import { newRequestId, parseProtocol } from './protocol.js';

/** How long a member waits for an answer before giving up. Long: a person may be away. */
export const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

/** How often the member looks for its answer. */
const POLL_MS = 250;

/**
 * A member asks for permission and BLOCKS until the lead answers.
 *
 * Resolves to `{ approved: false, error }` on refusal and on timeout — never throws, because the caller is
 * mid-turn and an exception here would end a member that merely needed a decision. A timeout is reported
 * as a refusal WITH ITS REASON, so the model is told the difference between "no" and "nobody answered".
 */
export async function requestPermission({
  teamName,
  memberName,
  leadName,
  toolName,
  toolUseId,
  description,
  input,
  timeoutMs = PERMISSION_TIMEOUT_MS,
  shouldStop = () => false,
}) {
  const requestId = newRequestId('perm');
  writeToMailbox(teamName, leadName, {
    from: memberName,
    text: JSON.stringify({
      type: 'permission_request',
      request_id: requestId,
      agent_id: memberName,
      tool_name: toolName,
      tool_use_id: toolUseId || '',
      description: description || '',
      input: input && typeof input === 'object' ? input : {},
      permission_suggestions: [],
    }),
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) return { approved: false, error: 'cancelled' };
    const answer = findResponse(teamName, memberName, requestId);
    if (answer) return answer;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return {
    approved: false,
    error: `no answer from ${leadName} within ${Math.round(timeoutMs / 1000)}s`,
  };
}

/**
 * Look for the answer to one request, consuming it.
/**
 * Look for the answer to one request, and CONSUME it.
 *
 * Deleted rather than flagged read: the member polls in a loop, so a response left in the box would
 * authorise its NEXT request too — a decision the person never made.
 */
function findResponse(teamName, memberName, requestId) {
  const box = readMailbox(teamName, memberName);
  for (const m of box) {
    const msg = parseProtocol(m.text);
    if (!msg || msg.type !== 'permission_response') continue;
    if (String(msg.request_id) !== String(requestId)) continue;
    removeMail(teamName, memberName, [m.seq]);
    if (msg.subtype === 'success') {
      return { approved: true, updatedInput: msg.response && msg.response.updated_input };
    }
    return { approved: false, error: String(msg.error || 'Permission denied') };
  }
  return null;
}

/**
 * The lead's side: does this inbox message ask for permission?
 *
 * Returns the request when it does, so the caller can put it in front of the person. A message that is
 * not a permission request returns null and is handled as ordinary chat by the listener.
 */
export function asPermissionRequest(text) {
  const msg = parseProtocol(text);
  if (!msg || msg.type !== 'permission_request') return null;
  return {
    requestId: String(msg.request_id || ''),
    agentId: String(msg.agent_id || ''),
    toolName: String(msg.tool_name || ''),
    toolUseId: String(msg.tool_use_id || ''),
    description: String(msg.description || ''),
    input: msg.input && typeof msg.input === 'object' ? msg.input : {},
  };
}

/** The lead answers a request. */
export function answerPermission({ teamName, memberName, requestId, approved, error, updatedInput }) {
  const msg = approved
    ? { type: 'permission_response', request_id: requestId, subtype: 'success', response: updatedInput ? { updated_input: updatedInput } : {} }
    : { type: 'permission_response', request_id: requestId, subtype: 'error', error: String(error || 'Permission denied') };
  writeToMailbox(teamName, memberName, { from: 'team-lead', text: JSON.stringify(msg) });
}
