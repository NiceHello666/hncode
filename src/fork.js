/**
 * A message that belongs to ONE conversation.
 *
 * `/fork` used `messages.slice()`, which copies the array but not the messages in it, so
 * the fork and its parent shared every message object. Nothing went wrong until the
 * fork edited one — then the parent changed too, in a session the user had already
 * walked away from. A shallow copy of the message is the minimum; the nested fields are
 * copied as well because a turn writes into them (`toolCalls`, a growing `content`
 * string on a streamed assistant message, the `allLines` of a plugin log).
 *
 * The underscore-prefixed bookkeeping fields are NOT copied: they describe the parent’s
 * render state, and carrying them over would make the fork display rows the new
 * conversation has not produced.
 */
export function cloneMessageForFork(m) {
  if (!m || typeof m !== 'object') return m;
  const copy = {};
  for (const k of Object.keys(m)) {
    // Render bookkeeping: the fork has its own screen and its own scroll.
    if (k === '_conv' || k === '_mdCache' || k === '_wrapped' || k === '_prevWrap') continue;
    const v = m[k];
    if (Array.isArray(v)) copy[k] = v.map((e) => (e && typeof e === 'object' ? { ...e } : e));
    else if (v && typeof v === 'object') copy[k] = { ...v };
    else copy[k] = v;
  }
  return copy;
}
// The command that uses it: `/fork`. Kept beside the clone so the two cannot drift.
//
export function forkOf(session, newId, now = Date.now()) {
  const forked = {
    ...session,
    id: newId(),
    title: `${session.title || 'untitled'} (fork)`,
    createdAt: now,
    updatedAt: now,
    messages: (session.messages || []).map(cloneMessageForFork),
    forkedFrom: session.forkedFrom || session.id || null,
  };
  // The turn counters belong to the conversation, not to the copy.
  delete forked.rounds;
  delete forked.steps;
  return forked;
}
