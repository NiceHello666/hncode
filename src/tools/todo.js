// TodoList tool — mirrors the hncode TodoList tool schema & behavior.
// Replaces the agent's todo list with the full list provided.

export const spec = {
  name: 'TodoList',
  description: 'Track multi-step work. Pass the COMPLETE list; it replaces the current one. Items: title + status (pending | in_progress | done).',
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
    ctx.todoState = args.todos.map((t) => ({ title: String(t.title), status: t.status || 'pending' }));
    return render(ctx.todoState);
  },
};

export function render(list) {
  return 'Todo list:\n' + (list || []).map((t) => `- [${t.status}] ${t.title}`).join('\n');
}
