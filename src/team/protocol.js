// Structured messages between team members.
//
// WHY THIS FILE EXISTS
// --------------------
// Everything a team does between its members travels through the mailbox, and almost all of it needs to
// be more than prose: a task assignment names a task ID, a shutdown request carries a correlation ID the
// reply must echo, and a permission request has to BLOCK the sender until a matching response comes back.
// Free text cannot carry any of that, so every consumer was reduced to matching substrings — "does this
// message look like a shutdown?" — which works until someone writes the word in a sentence.
//
// The wire format is a JSON object in the message body, discriminated by `type`. A human sentence has no
// `type` field, so plain chat and protocol traffic share one mailbox without ambiguity: parsing either
// succeeds and says what it is, or the message is chat.
//
// SHAPES follow Claude Code's (`src/utils/teammateMailbox.ts`) field for field. That matters more than it
// looks: `request_id` correlation, `task_assignment{taskId, subject, description, assignedBy}` and the
// `permission_request{tool_name, tool_use_id, input}` triple are what let a leader's UI approve the exact
// call a worker is blocked on. Inventing our own names here would make every one of those unanswerable.

/** How a message body is recognised as protocol traffic rather than chat. */
export const PROTOCOL_TYPES = Object.freeze([
  'task_assignment',
  'shutdown_request',
  'shutdown_approved',
  'shutdown_rejected',
  'permission_request',
  'permission_response',
  'plan_approval_request',
  'plan_approval_response',
  'mode_set_request',
]);

/**
 * Parse a message body as a structured message.
 *
 * Returns `null` for plain chat — which is the common case, so this must be cheap and must never throw.
 * A body that happens to be JSON but carries no known `type` is also chat: the mailbox is shared, and a
 * member discussing a JSON payload should not have its words reclassified.
 */
export function parseProtocol(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || raw[0] !== '{') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!PROTOCOL_TYPES.includes(parsed.type)) return null;
  return parsed;
}

/** Is this body protocol traffic at all? */
export function isProtocol(text) {
  return parseProtocol(text) !== null;
}

/** A task was handed to a member. */
export function taskAssignment({ taskId, subject, description, assignedBy }) {
  return {
    type: 'task_assignment',
    taskId: String(taskId || ''),
    subject: String(subject || ''),
    description: String(description || ''),
    assignedBy: String(assignedBy || ''),
    timestamp: new Date().toISOString(),
  };
}

/** A leader asks a member to stop. The member answers with `shutdown_approved` or `_rejected`. */
export function shutdownRequest({ requestId, from, reason }) {
  return {
    type: 'shutdown_request',
    requestId: String(requestId || ''),
    from: String(from || ''),
    reason: reason ? String(reason) : undefined,
    timestamp: new Date().toISOString(),
  };
}

export function shutdownApproved({ requestId, from }) {
  return {
    type: 'shutdown_approved',
    requestId: String(requestId || ''),
    from: String(from || ''),
    timestamp: new Date().toISOString(),
  };
}

export function shutdownRejected({ requestId, from, reason }) {
  return {
    type: 'shutdown_rejected',
    requestId: String(requestId || ''),
    from: String(from || ''),
    reason: String(reason || ''),
    timestamp: new Date().toISOString(),
  };
}

/** A member wants permission for a tool call and cannot proceed without an answer. */
export function permissionRequest({ requestId, agentId, toolName, toolUseId, description, input }) {
  return {
    type: 'permission_request',
    request_id: String(requestId || ''),
    agent_id: String(agentId || ''),
    tool_name: String(toolName || ''),
    tool_use_id: String(toolUseId || ''),
    description: String(description || ''),
    input: input && typeof input === 'object' ? input : {},
    permission_suggestions: [],
  };
}

/**
 * The leader's answer.
 *
 * Two shapes, discriminated by `subtype` rather than a nullable `approved`: a refusal carries a REASON,
 * and the member shows it to the model so the next attempt can differ. A bare boolean loses that.
 */
export function permissionResponse({ requestId, approved, error, updatedInput }) {
  if (!approved) {
    return {
      type: 'permission_response',
      request_id: String(requestId || ''),
      subtype: 'error',
      error: String(error || 'Permission denied'),
    };
  }
  return {
    type: 'permission_response',
    request_id: String(requestId || ''),
    subtype: 'success',
    response: updatedInput ? { updated_input: updatedInput } : {},
  };
}

/** A member proposes a plan; the leader approves or refuses it. */
export function planApprovalRequest({ requestId, from, plan }) {
  return {
    type: 'plan_approval_request',
    requestId: String(requestId || ''),
    from: String(from || ''),
    plan: String(plan || ''),
    timestamp: new Date().toISOString(),
  };
}

export function planApprovalResponse({ requestId, approved, feedback }) {
  return {
    type: 'plan_approval_response',
    requestId: String(requestId || ''),
    approved: Boolean(approved),
    feedback: feedback ? String(feedback) : undefined,
    timestamp: new Date().toISOString(),
  };
}

/** Change a member's permission mode without restarting it. */
export function modeSetRequest({ mode, from }) {
  return { type: 'mode_set_request', mode: String(mode || ''), from: String(from || '') };
}

/** Correlation id for a request/response pair. */
export function newRequestId(prefix = 'r') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
