// AskUserQuestion tool — ask the user 1-4 structured multiple-choice questions
// mid-turn and block until they answer. Mirrors kimi-code's AskUserQuestion:
// the same input shape, the same duplicate validation, and the same result
// JSON, so a model trained on either behaves the same.
//
// The TUI supplies the actual UI through `ctx.askQuestion` (a function injected
// by the Agent). When it is absent — headless `-p` mode, a plugin harness, or a
// client that cannot prompt — the tool FAILS with a message telling the model to
// ask in plain text instead of silently returning an empty answer, which would
// look like "the user declined".

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// The user always gets an escape hatch for free input, so the model must not
// waste one of its 2-4 option slots on an "Other" of its own.
export const OTHER_LABEL = 'Other';

// A SECOND free-text row, shown once after the LAST question: not an answer to
// anything, just somewhere to add context that no option covered. Reported as
// `additional` on the result (NOT `note`, which already means "dismissed").
export const SUPPLEMENT_LABEL = 'Add a note';

const UNIQUENESS_HINT =
  'Question texts must be unique across questions, and option labels must be unique within each question.';

// Validate the two uniqueness rules kimi enforces. Returns an error string, or
// null when the input is acceptable. Checks run BEFORE any UI is shown so a
// malformed call never interrupts the user.
export function questionUniquenessError(questions) {
  const texts = new Set();
  for (const q of questions) {
    if (texts.has(q.question)) {
      return `Invalid questions: duplicate question text ${JSON.stringify(q.question)}. ${UNIQUENESS_HINT} Rephrase the duplicates and call the tool again.`;
    }
    texts.add(q.question);
    const labels = new Set();
    for (const o of q.options) {
      if (labels.has(o.label)) {
        return `Invalid questions: duplicate option label ${JSON.stringify(o.label)} in question ${JSON.stringify(q.question)}. ${UNIQUENESS_HINT} Rephrase the duplicates and call the tool again.`;
      }
      labels.add(o.label);
    }
  }
  return null;
}

const DESCRIPTION = `Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

When NOT to use:
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome

Overusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.

Usage notes:
- Users always have an "Other" option for custom input — don't create one yourself
- Use multi_select to allow multiple answers to be selected for a question
- Keep option labels concise (1-5 words), use descriptions for trade-offs and details
- Each question should have 2-4 meaningful, distinct options
- Question texts must be unique across the call, and option labels must be unique within each question
- You can ask 1-4 questions at a time; group related questions to minimize interruptions
- If you recommend a specific option, list it first and append "(Recommended)" to its label
- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked "Other"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question
- The user may also leave a free-form \`additional\` note covering the whole request; the field appears only when they wrote one. Treat it as extra context, not as the answer to a specific question`;

export const spec = {
  name: 'AskUserQuestion',
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: 'The questions to ask the user (1-4 questions).',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: "A specific, actionable question. End with '?'.",
            },
            header: {
              type: 'string',
              description: "Short category tag (max 12 chars, e.g. 'Auth', 'Style').",
            },
            options: {
              type: 'array',
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              description:
                "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically.",
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: "Concise display text (1-5 words). If recommended, append '(Recommended)'.",
                  },
                  description: {
                    type: 'string',
                    description: 'Brief explanation of trade-offs or implications.',
                  },
                },
                required: ['label'],
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user can select multiple options.',
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },

  async execute(args, ctx) {
    // AUTO ("Never Ask") forbids asking by definition — the whole point of the
    // mode is that the agent decides for itself. Checked FIRST so the model gets
    // a clear instruction back instead of a dialog the user never wanted. The
    // wording mirrors kimi-code's `auto-mode-ask-user-question-deny` policy; the
    // `Error:` prefix is ours — it is what marks the call as failed to the TUI, so
    // the status bullet turns RED instead of staying green on a refusal.
    if (ctx && ctx.permissionMode === 'auto') {
      return 'Error: AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.';
    }

    const raw = (args && args.questions) || [];
    if (!Array.isArray(raw) || raw.length === 0) {
      return 'Error: `questions` must be a non-empty array (1-4 questions).';
    }
    if (raw.length > MAX_QUESTIONS) {
      return `Error: at most ${MAX_QUESTIONS} questions per call (got ${raw.length}). Group related questions to minimize interruptions.`;
    }

    // Normalize + validate BEFORE showing any UI: a malformed call must not
    // interrupt the user, it must come straight back to the model.
    const questions = [];
    for (const q of raw) {
      const text = String((q && q.question) || '').trim();
      if (!text) return 'Error: every question needs a non-empty `question` string.';
      const opts = Array.isArray(q && q.options) ? q.options : [];
      if (opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) {
        return `Error: question ${JSON.stringify(text)} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (got ${opts.length}).`;
      }
      const options = [];
      for (const o of opts) {
        const label = String((o && o.label) || '').trim();
        if (!label) return `Error: every option in ${JSON.stringify(text)} needs a non-empty \`label\`.`;
        options.push({ label, description: String((o && o.description) || '') });
      }
      questions.push({
        question: text,
        header: String((q && q.header) || '').trim().slice(0, 12),
        options,
        multiSelect: !!(q && q.multi_select),
      });
    }

    const dup = questionUniquenessError(questions);
    if (dup) return dup;

    // No interactive client: say so explicitly. Returning `{answers:{}}` would be
    // read as "the user refused to answer", which is a different signal.
    if (typeof ctx.askQuestion !== 'function') {
      return 'The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.';
    }

    let result;
    try {
      result = await ctx.askQuestion(questions, ctx);
    } catch (err) {
      // An aborted turn (Esc / Ctrl-C) is not a dismissal — let the agent see the
      // interruption instead of a fabricated empty answer.
      if (ctx.signal && ctx.signal.aborted) throw err;
      return `Error: could not ask the user: ${(err && err.message) || String(err)}`;
    }

    // Dismissed (Esc) or nothing answered: kimi's exact semantics — an empty
    // answers object plus a note telling the model NOT to treat it as consent.
    // A dismissal also drops any note the user had started typing.
    const answers = (result && typeof result === 'object' && result.answers) || null;
    const additional = (result && typeof result === 'object' && result.additional) || '';
    if (!answers || Object.keys(answers).length === 0) {
      return JSON.stringify({
        answers: {},
        note: 'User dismissed the question without answering.',
      });
    }
    // `additional` is OPTIONAL: omit the key entirely when the user left the
    // supplement blank, so the model does not see a meaningless empty field.
    const out = { answers };
    if (additional) out.additional = additional;
    return JSON.stringify(out);
  },
};
