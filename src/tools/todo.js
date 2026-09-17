// TodoList tool — mirrors the hncode TodoList tool schema & behavior.
// Replaces the agent's todo list with the full list provided.

export const spec = {
  name: 'TodoList',
  description: `Track multi-step work. Pass the COMPLETE list; it replaces the current one. Items: title + status (pending | in_progress | done).

When to use it:
- Non-trivial work with several ordered steps, or a request that asks for more than one thing.
- NOT for a straightforward task you can finish in a step or two, and never as a single-item list.

Maintaining the list:
- Keep exactly ONE item in_progress at a time until everything is done.
- Never move an item straight from pending to done: set it to in_progress first, so the list reflects
  what is actually happening. Do not tick off several items in one update after the fact.
- Step titles are short (5-7 words), one line each.
- Update the list as you go, before starting the next step, not in a batch at the end.
- If your understanding changes, replace the whole list with the corrected one and say why.
- Finish with every item done, or explicitly say which you abandoned and why. Do not leave the list stale.
- Do not repeat the list back to the user after updating it — the UI already shows it.`,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, actionable task title.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Current status.' },
          },
          required: ['title', 'status'],
        },
        description: 'The full todo list.',
      },
    },
    required: ['todos'],
  },
  async execute(args, ctx) {
    // `todos` is required, but a missing or mistyped value must not throw: an
    // uncaught error here aborts the whole turn. Return a message the model can
    // act on, like every other tool.
    if (!Array.isArray(args.todos)) {
      return 'Error: `todos` must be an array of { title, status }.';
    }
    const VALID = ['pending', 'in_progress', 'done'];
    const badStatus = args.todos.find((t) => t && t.status != null && !VALID.includes(t.status));
    if (badStatus) {
      return `Error: invalid status ${JSON.stringify(badStatus.status)}; use one of ${VALID.join(' | ')}.`;
    }
    const empty = args.todos.find((t) => !t || typeof t.title !== 'string' || !t.title.trim());
    if (empty) return 'Error: every todo needs a non-empty `title`.';
    ctx.todoState = args.todos.map((t) => ({ title: String(t.title).trim(), status: t.status || 'pending' }));
    return render(ctx.todoState);
  },
};

export function render(list) {
  return 'Todo list:\n' + (list || []).map((t) => `- [${t.status}] ${t.title}`).join('\n');
}
