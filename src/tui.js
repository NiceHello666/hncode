// hncode TUI — raw-TTY renderer (no blessed).
//
// Why raw TTY instead of blessed: blessed cannot render to a non-TTY stream on
// Windows and mis-parses escape sequences here (arrows leak as `[A`, widgets fill
// with `undefined`, Windows Terminal ignores blessed's cursor-shape control).
// That is what produced the garbled screen you saw. kimi-code-cli itself renders
// with raw escape sequences + precise cursor placement, so this module does the
// same using the project's own escape primitives (colors.js / term.js). This
// gives byte-exact control over the block cursor (DECSCUSR), the caret position
// inside the input line, and full-screen redraws on every change/resize.
//
// The renderer is split into a PURE `composeFrame(state, cols, rows)` (returns
// the ANSI bytes — no TTY side effects, fully unit-testable) and `startTUI`
// (the raw-mode loop + key parser + agent wiring).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import {
  C, blockCursor, showCursor, hideCursor, alternateScreen, clearScreen, clearAndSetBg, setTheme, THEME_NAMES, lerpColor,
} from './colors.js';
import { copyText, readText, warmClipboard, readClipboardContentAsync } from './clipboard.js';
import { visualWidth, estimateTokens, estimateMessagesTokens, expandTabs } from './term.js';
import { Agent, SYSTEM_PROMPT } from './agent.js';
import { LLM } from './llm.js';
import * as sess from './session.js';
import { resolveProvider, resolveModelArg, addProvider, removeProvider, addModel, fetchModels, fetchCatalog, modelKey, modelLabel, effortOptions, effortWire, rememberModel, hncodeConfigFile, resolveConfig, setConfigString } from './config.js';
import { pluginCommands } from './plugin.js';

const ESC = '\x1b';
const VERSION = '0.1.0';

// ---- Slash command registry ----
// Mirrors kimi-code-cli's BUILTIN_SLASH_COMMANDS (registry.ts): name, aliases,
// description, and an argument hint. Commands are sorted by priority so the
// most useful appear first in the `/` menu.
export const COMMANDS = [
  { name: 'yolo', aliases: ['yes'], desc: 'Ask When Needed mode: anything inside the workspace (edits, writes, commands) runs automatically; paths outside it, destructive commands, questions and plans still ask.', priority: 101 },
  { name: 'permission', desc: 'Select permission mode', priority: 100 },
  { name: 'settings', aliases: ['config'], desc: 'Open settings (model / permission / statusline)', priority: 100 },
  { name: 'plan', desc: 'Toggle plan mode', priority: 100, argumentHint: '[on|off|clear]' },
  { name: 'focus', desc: 'Toggle Focus mode (minimal tools first, full tools after)', priority: 98, argumentHint: '[on|off]' },
  { name: 'auto', desc: 'Never Ask mode: never interrupts you; everything runs and is decided automatically.', priority: 99 },
  { name: 'ask', aliases: ['manual'], desc: 'Always Ask mode: read-only runs automatically; every other action asks first.', priority: 99 },
  { name: 'model', desc: 'Switch LLM model', priority: 100 },
  { name: 'effort', aliases: ['thinking'], desc: 'Switch thinking effort', priority: 95, argumentHint: '[off|on|high|medium|low]' },
  { name: 'provider', aliases: ['providers'], desc: 'Manage AI providers (add / delete)', priority: 95 },
  { name: 'help', aliases: ['h', '?'], desc: 'Show available commands and shortcuts', priority: 80 },
  { name: 'new', aliases: ['clear'], desc: 'Start a fresh session in the current workspace', priority: 80 },
  { name: 'sessions', aliases: ['resume'], desc: 'Browse and resume sessions', priority: 80 },
  { name: 'tasks', aliases: ['task'], desc: 'Browse background tasks', priority: 80 },
  { name: 'compact', desc: 'Compact the conversation context (AI summary + keep last 20%)', priority: 80, argumentHint: '[ratio]' },
  { name: 'goal', aliases: ['objective'], desc: 'Start or manage an autonomous goal', priority: 80, argumentHint: '[status|pause|resume|cancel] | <objective>' },
  { name: 'init', desc: 'Analyze the codebase and generate AGENTS.md', priority: 70 },
  { name: 'fork', desc: 'Fork the current session into a copy without switching to it', priority: 80 },
  { name: 'undo', desc: 'Withdraw the last prompt from the transcript', priority: 80, argumentHint: '[count]' },
  { name: 'title', aliases: ['rename'], desc: 'Set or show session title (also sets window title)', priority: 60, argumentHint: '<title>' },
  { name: 'status', desc: 'Show current session and runtime status', priority: 60 },
  { name: 'usage', desc: 'Show session tokens + context window', priority: 60 },
  { name: 'mcp', desc: 'Show MCP server status', priority: 60 },
  { name: 'mcp-config', desc: 'Configure MCP servers (list / add / remove)', priority: 60 },
  { name: 'statusline', desc: 'Configure which items appear in the status line', priority: 60 },
  
  { name: 'export-md', aliases: ['export'], desc: 'Export current session as a Markdown file', priority: 40, argumentHint: '[output-path]' },
  { name: 'import-session', aliases: ['import'], desc: 'Attach a Markdown file to the prompt so the AI reads it without a tool call', priority: 40, argumentHint: '<file.md>' },
  { name: 'copy', desc: 'Copy the last assistant message to the clipboard', priority: 40 },
  { name: 'set-system-prompt', aliases: ['system-prompt'], desc: 'Edit and save the system prompt (persisted to config.toml)', priority: 60 },
  { name: 'calm-mode', desc: 'Terse replies: stop the model narrating what it will do and why unless asked', priority: 60, argumentHint: '[on|off]' },
  { name: 'add-dir', desc: 'Add or list an additional workspace directory', priority: 60, argumentHint: '[list] | <path>' },
  { name: 'move', desc: 'Move current session to another directory (must exist)', priority: 60, argumentHint: '<path>' },
  { name: 'reload', desc: 'Reload config.toml settings', priority: 60 },
  { name: 'plugins', desc: 'List loaded plugins and their status', priority: 60 },
  { name: 'logout', aliases: ['disconnect'], desc: 'Log out of a configured provider', priority: 40 },
  { name: 'feedback', aliases: ['bug'], desc: 'Send feedback to the maintainers', priority: 60 },
  { name: 'version', desc: 'Show version information', priority: 20 },
  { name: 'exit', aliases: ['quit', 'q'], desc: 'Exit the application', priority: 20 },
].sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name));

// Plugin commands are merged into the built-in list at runtime. Plugins are
// loaded before the TUI starts, so this reflects any registered commands.
function allCommands() {
  return [...COMMANDS, ...pluginCommands.map((c) => ({
    name: c.name, description: c.description, aliases: c.aliases,
    argumentHint: c.argumentHint, priority: c.priority || 50,
    _plugin: true, run: c.run,
  }))].sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.name.localeCompare(b.name));
}

// Resolve a typed name (or alias) to a registry entry.
export function findCommand(name) {
  const n = String(name || '').replace(/^\//, '');
  return COMMANDS.find((c) => c.name === n || (c.aliases || []).includes(n))
    || pluginCommands.find((c) => c.name === n || (c.aliases || []).includes(n));
}

// Check if a command name refers to a plugin command.
export function isPluginCommand(name) {
  const n = String(name || '').replace(/^\//, '');
  return !!pluginCommands.find((c) => c.name === n || (c.aliases || []).includes(n));
}

// Appended to the system prompt while CALM MODE is on (/calm-mode). The point is
// to suppress the model's running commentary — the "I'll now look at X because Y"
// narration — without suppressing the answer or the tool calls themselves.
export const CALM_MODE_INSTRUCTION =
  'CALM MODE is ON. Do not narrate.\n'
  + '- Skip announcing what you are about to do, why you are doing it, or what you\n'
  + '  have just finished. No preamble, no play-by-play, no restating the request.\n'
  + '- Just do the work and report the OUTCOME, briefly. Keep tool calls as normal.\n'
  + '- Explain reasoning only if the user explicitly asks for it, or if a genuine\n'
  + '  blocker/decision needs their input.';

export const TIPS = [
  'Press Esc to interrupt the current turn at any time',
  '/init generates an AGENTS.md from your codebase for smarter agent context',
  'Use /mcp to manage MCP servers for additional tool integration',
  'The context line shows real-time token usage — watch it grow as the agent works',
  '/goal starts an autonomous objective — hncode will work until done or blocked',
  'Paste multiline content — hncode collapses it into a [paste #N +L lines] token',
  '/usage shows detailed token, steps, and context statistics for the session',
  'Ctrl+C aborts the current turn and returns you to the prompt',
  'The spinner on the left cycles through status messages while the agent works',
  '/model opens a picker — Tab switches between providers and models',
  '/provider lets you add, remove, or switch AI providers',
  'Tool calls show their arguments streaming live — no need to wait for completion',
  '/think lets you add reasoning/thinking instructions inline',
  'The todo list updates live as the agent makes progress on tasks',
  '/focus mode gives the agent Read, Write, Edit, and Bash in your workspace',
  'System messages appear in green — they are instructions, not conversation',
  'Queued messages wait for the current turn to finish',
  '/steer injects a message directly into the running turn',
  'Ctrl+R reloads the current session from disk',
  '/help shows available commands at any time',
  '/undo rolls the transcript back to before your last prompt',
  '/fork copies the current session so you can explore a branch without losing the original',
  '/sessions lists every saved conversation in this workspace',
  '/title sets a human-readable name for the current session',
  '/compact [ratio] AI-summarizes older history and keeps the most recent 20%',
  '/tasks lists background Bash jobs started with run_in_background',
  '/status prints the current model, provider, endpoint, and session id',
  '/statusline toggles which items appear in the bottom status bar',
  '/add-dir grants the agent access to another directory for this session',
  '/reload re-reads config.toml without restarting hncode',
  '/plugins lists the plugins loaded from ~/.hncode/plugins',
  '/logout clears the stored API key for a provider',
  '/version prints the hncode version string',
  '/feedback writes a bug report to ~/.hncode/feedback for the maintainers',
  '/copy puts the last assistant message on your system clipboard',
  '/export-md writes the whole session to a Markdown file on disk',
  '/import-session attaches a Markdown file to the next prompt without a Read call',
  '/new starts a fresh conversation in the current workspace',
  '/goal pause temporarily stops an autonomous objective',
  '/goal resume continues a paused autonomous objective',
  '/plan on turns every tool read-only so you can sketch without side effects',
  '/focus on gives the agent only Read, Write, Edit, and Bash',
  '/permission opens the picker for Always Ask / Ask When Needed / Never Ask',
  '/settings opens the combined settings menu',
  '/yolo auto-approves anything inside the workspace — risky paths still ask',
  '/auto never interrupts you; everything runs and is decided automatically',
  'Shift+Arrow selects text in the composer; Backspace or Delete removes it',
  'Ctrl+J inserts a newline without sending the message',
  'Ctrl+T expands or collapses the todo panel',
  'Ctrl+O expands or collapses tool output and thinking blocks',
  'Ctrl+B moves a long-running foreground Bash command to the background',
  'Ctrl+Shift+V pastes the clipboard as a bracketed paste',
  'Ctrl+Shift+C copies the mouse selection, or the last answer',
  'Cmd/Ctrl+L clears the visible screen but keeps the session state',
  '↑ in an empty composer recalls the newest queued message for editing',
  '↑/↓ in an empty composer walks through your input history',
  'PgUp / PgDn scroll the transcript without touching the composer',
  'Mouse-wheel scrolling over the composer moves the transcript, not the caret',
  'Drag the scrollbar thumb on the right edge to jump through the transcript',
  'Double-click a transcript row to select the whole line for copying',
  'Right-click a transcript row to open the copy / paste context menu',
  'Esc closes any open picker, form, panel, or command menu',
  'Esc during a running turn aborts the in-flight model request',
  'Ctrl+C once asks for confirmation; Ctrl+C twice exits hncode',
  'Ctrl+C with a dialog open closes the dialog instead of the app',
  'The `/` menu filters as you type — keep typing to narrow the list',
  'Enter on a `/` menu item runs the highlighted command',
  'Tab on a `/` menu item completes the command name into the composer',
  'The context gauge turns red as you approach the model context limit',
  'Auto-compaction triggers at 85% of the model context and keeps the last 20%',
  '/compact with no argument keeps the newest 20% and summarizes the rest',
  '/compact 0.3 keeps the newest 70% and summarizes the older 30%',
  'Tool results longer than the visible window collapse — Ctrl+O expands them',
  'A red bullet next to a tool call means the command exited non-zero',
  'A green bullet next to a tool call means it finished successfully',
  'The `[turn took …]` line at the end of a turn shows the wall-clock duration',
  '/provider add walks you through picking a known provider from models.dev',
  '/model shows categories per provider — Tab cycles between them',
  'Typing `/` at any time opens the command palette above the composer'
];

// Layout constants (kimi-code-cli style: no top chrome; the chat fills to the
// top, and the bottom stack is: input box (bottom) / menu / status line /
// context line — the context line is the very last row of the screen).
const CTX_H = 1;                 // context line (screen bottom row)
const STATUS_H = 1;              // status line (above context)
const INPUT_BASE_H = 3;          // input box: top border + input line + bottom border
const MAX_MENU = 6;              // menu rows shown (matches the ~6 you see)
const MAX_PICKER = 12;            // max picker list rows shown at once
const TIP_INTERVAL = 15000;
// Braille spinner frames for the "Working" indicator (orange).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Rotating status messages for the "Working..." line — all mean "the agent is
// thinking / working", but vary the wording so it doesn't look stuck.
const WORKING_MESSAGES = [
  'Thinking...', 'Working...', 'Crunching...', 'Processing...', 'Analyzing...', 'Pondering...', 'Mulling...', 'Considering...', 'Reasoning...', 'Deliberating...',
  'Reflecting...', 'Ruminating...', 'Planning...', 'Mapping...', 'Sketching...', 'Outlining...', 'Structuring...', 'Organizing...', 'Sorting...', 'Ordering...',
  'Prioritizing...', 'Focusing...', 'Concentrating...', 'Diving...', 'Digging...', 'Delving...', 'Probing...', 'Examining...', 'Inspecting...', 'Studying...',
  'Reviewing...', 'Checking...', 'Verifying...', 'Validating...', 'Confirming...', 'Building...', 'Assembling...', 'Constructing...', 'Composing...', 'Crafting...',
  'Creating...', 'Shaping...', 'Forming...', 'Forging...', 'Welding...', 'Stitching...', 'Weaving...', 'Knitting...', 'Threading...', 'Patching...',
  'Fixing...', 'Repairing...', 'Rebuilding...', 'Reworking...', 'Refactoring...', 'Restructuring...', 'Solving...', 'Untangling...', 'Unraveling...', 'Detangling...',
  'Deciphering...', 'Decoding...', 'Cracking...', 'Piecing...', 'Fitting...', 'Hunting...', 'Chasing...', 'Tracking...', 'Tracing...', 'Sniffing...',
  'Writing...', 'Drafting...', 'Editing...', 'Revising...', 'Rewriting...', 'Proofreading...', 'Polishing...', 'Refining...', 'Honing...', 'Tuning...',
  'Sharpening...', 'Tightening...', 'Trimming...', 'Pruning...', 'Cutting...', 'Merging...', 'Splicing...', 'Searching...', 'Scanning...', 'Sifting...',
  'Filtering...', 'Collecting...', 'Gathering...', 'Compiling...', 'Indexing...', 'Fetching...', 'Retrieving...', 'Loading...', 'Unpacking...', 'Computing...',
  'Calculating...', 'Measuring...', 'Estimating...', 'Calibrating...', 'Aligning...', 'Balancing...', 'Optimizing...', 'Streamlining...', 'Smoothing...', 'Cleaning...',
  'Sweeping...', 'Tidying...', 'Clearing...', 'Expanding...', 'Growing...', 'Blooming...', 'Walking...', 'Strolling...', 'Marching...', 'Hiking...',
  'Trekking...', 'Journeying...', 'Sailing...', 'Cruising...', 'Gliding...', 'Flying...', 'Soaring...', 'Floating...', 'Drifting...', 'Wandering...',
  'Exploring...', 'Roaming...', 'Venturing...', 'Discovering...', 'Uncovering...', 'Unveiling...', 'Revealing...', 'Exposing...', 'Spinning...', 'Whirling...',
  'Twirling...', 'Rotating...', 'Swirling...', 'Churning...', 'Turning...', 'Rolling...', 'Rocking...', 'Swaying...', 'Flowing...', 'Streaming...',
  'Cascading...', 'Rippling...', 'Bubbling...', 'Sparkling...', 'Cooking...', 'Simmering...', 'Boiling...', 'Stewing...', 'Roasting...', 'Baking...',
  'Grilling...', 'Frying...', 'Whisking...', 'Beating...', 'Stirring...', 'Mixing...', 'Blending...', 'Kneading...', 'Proofing...', 'Rising...',
  'Fermenting...', 'Brewing...', 'Steeping...', 'Infusing...', 'Seasoning...', 'Garnishing...', 'Plating...', 'Serving...', 'Tasting...', 'Adjusting...',
  'Perfecting...', 'Glazing...', 'Painting...', 'Drawing...', 'Designing...', 'Orchestrating...', 'Conducting...', 'Dancing...', 'Jigging...', 'Jiving...',
  'Boogying...', 'Shimmying...', 'Grooving...', 'Bouncing...', 'Hopping...', 'Skipping...', 'Nurturing...', 'Tending...', 'Gardening...', 'Planting...',
  'Seeding...', 'Sprouting...', 'Rooting...', 'Branching...', 'Watering...', 'Flourishing...', 'Thriving...', 'Sneaking...', 'Tiptoeing...', 'Creeping...',
  'Charging...', 'Gunning...', 'Ramping...', 'Revving...', 'Warming...', 'Powering...', 'Igniting...', 'Kindling...', 'Sparking...', 'Blazing...',
  'Burning...', 'Glowing...', 'Illuminating...', 'Enlightening...', 'Brightening...', 'Dawning...', 'Breaking...', 'Leaping...', 'Jumping...', 'Bounding...',
  'Springing...', 'Launching...', 'Propelling...', 'Accelerating...', 'Waiting...', 'Holding...', 'Steadying...', 'Progressing...', 'Advancing...', 'Continuing...',
  'Persisting...', 'Persevering...', 'Standing...', 'Readying...', 'Preparing...', 'Sussing...', 'Sleuthing...', 'Orienting...', 'Locating...', 'Targeting...',
  'Acquiring...', 'Syncing...', 'Harmonizing...', 'Lining...', 'Wrapping...', 'Finalizing...', 'Landing...', 'Nailing...', 'Sealing...', 'Rethinking...',
  'Reassessing...', 'Revisiting...', 'Retracing...', 'Replaying...', 'Rehearsing...', 'Simulating...', 'Modeling...', 'Prototyping...', 'Testing...', 'Iterating...',
  'Rendering...', 'Repainting...', 'Compositing...', 'Wiring...', 'Linking...', 'Bundling...', 'Packing...', 'Shipping...', 'Deploying...', 'Juggling...',
  'Weighing...', 'Distilling...', 'Extracting...', 'Parsing...', 'Formatting...', 'Normalizing...', 'Sanitizing...', 'Locking...', 'Securing...', 'Guarding...',
  'Watching...', 'Monitoring...', 'Surveying...', 'Scouting...', 'Reconnoitering...', 'Concocting...', 'Devising...', 'Inventing...', 'Imagining...', 'Envisioning...',
  'Visualizing...', 'Picturing...', 'Dreaming...', 'Wondering...', 'Marveling...', 'Admiring...', 'Appreciating...', 'Enjoying...', 'Savoring...', 'Relishing...',
  'Loving...', 'Cherishing...', 'Treasure-hunting...', 'Questing...', 'Seeking...', 'Striving...', 'Endeavoring...', 'Attempting...', 'Trying...', 'Experimenting...',
  'Innovating...', 'Pioneering...', 'Trailblazing...', 'Pathfinding...', 'Navigating...', 'Steering...', 'Guiding...', 'Directing...', 'Captaining...', 'Piloting...',
  'Commanding...', 'Leading...', 'Spearheading...', 'Championing...', 'Absorbing...', 'Accenting...', 'Acclaiming...', 'Accommodating...', 'Accounting...', 'Accrediting...',
  'Accumulating...', 'Achieving...', 'Acknowledging...', 'Activating...', 'Adapting...', 'Adding...', 'Addressing...', 'Adhering...', 'Administering...', 'Adopting...',
  'Adorning...', 'Advising...', 'Affirming...', 'Aggregating...', 'Agreing...', 'Aiming...', 'Airbrushing...', 'Alerting...', 'Allocating...', 'Allowing...',
  'Altering...', 'Amalgamating...', 'Amending...', 'Amplifying...', 'Amusing...', 'Anchoring...', 'Animating...', 'Annexing...', 'Announcing...', 'Answering...',
  'Anticipating...', 'Appealing...', 'Appending...', 'Applying...', 'Appointing...', 'Appraising...', 'Approaching...', 'Approving...', 'Archiving...', 'Arguing...',
  'Arming...', 'Arranging...', 'Arraying...', 'Arresting...', 'Arriving...', 'Articulating...', 'Ascending...', 'Asserting...', 'Assessing...', 'Assigning...',
  'Assimilating...', 'Assisting...', 'Assuring...', 'Astonishing...', 'Attaching...', 'Attacking...', 'Attaining...', 'Attending...', 'Attesting...', 'Attracting...',
  'Auditing...', 'Augmenting...', 'Authenticating...', 'Authoring...', 'Authorizing...', 'Automating...', 'Averting...', 'Awakening...', 'Awarding...', 'Babbling...',
  'Backing...', 'Backtracking...', 'Badging...', 'Baging...', 'Baiting...', 'Ballooning...', 'Banding...', 'Banking...', 'Bartering...', 'Basing...',
  'Batching...', 'Bearing...', 'Bedazzling...', 'Befriending...', 'Begining...', 'Beholding...', 'Believing...', 'Belonging...', 'Bending...', 'Benefiting...',
  'Beseeching...', 'Bestowing...', 'Beting...', 'Biding...', 'Billowing...', 'Binding...', 'Blasting...', 'Bleaching...', 'Bleeding...', 'Bleeping...',
  'Blessing...', 'Blinking...', 'Blistering...', 'Blocking...', 'Bloting...', 'Blowing...', 'Bluring...', 'Boarding...', 'Boasting...', 'Bobing...',
  'Bolstering...', 'Bombarding...', 'Bonding...', 'Booming...', 'Boosting...', 'Bootstraping...', 'Bordering...', 'Borrowing...', 'Botching...', 'Bottling...',
  'Bowing...', 'Bowling...', 'Boxing...', 'Bracing...', 'Brainstorming...', 'Braising...', 'Branding...', 'Braving...', 'Breaching...', 'Breathing...',
  'Breezing...', 'Bricking...', 'Bridging...', 'Briefing...', 'Bringing...', 'Bristling...', 'Broadening...', 'Brokering...', 'Bronzing...', 'Brooding...',
  'Browsing...', 'Brushing...', 'Buckling...', 'Budgeting...', 'Buffering...', 'Buffing...', 'Bulking...', 'Bulletproofing...', 'Bumping...', 'Bunching...',
  'Buoying...', 'Bursting...', 'Burying...', 'Busting...', 'Buttering...', 'Buzzing...', 'Caching...', 'Cadencing...', 'Cajoling...', 'Caking...',
  'Calling...', 'Calming...', 'Camping...', 'Canceling...', 'Canoodling...', 'Canvasing...', 'Capitalizing...', 'Captioning...', 'Capturing...', 'Carbonizing...',
  'Caring...', 'Carving...', 'Cashing...', 'Casting...', 'Cataloging...', 'Catapulting...', 'Catching...', 'Categorizing...', 'Catering...', 'Cautioning...',
  'Ceasing...', 'Celebrating...', 'Cementing...', 'Censoring...', 'Centralizing...', 'Certifying...', 'Chaining...', 'Chairing...', 'Chalking...', 'Challenging...',
  'Channeling...', 'Chanting...', 'Charting...', 'Chating...', 'Cheering...', 'Chewing...', 'Chilling...', 'Chiming...', 'Chiping...', 'Chirping...',
  'Chiseling...', 'Choosing...', 'Choping...', 'Choreographing...', 'Chronicling...', 'Chuging...', 'Ciphering...', 'Circling...', 'Circulating...', 'Citing...',
  'Civilizing...', 'Clamping...', 'Clanging...', 'Claping...', 'Clarifying...', 'Clashing...', 'Classifying...', 'Clawing...', 'Cleansing...', 'Cleaving...',
  'Climbing...', 'Clinching...', 'Cliping...', 'Cloaking...', 'Clocking...', 'Cloning...', 'Closing...', 'Clouding...', 'Clustering...', 'Clutching...',
  'Coaching...', 'Coalescing...', 'Coating...', 'Coaxing...', 'Cocooning...', 'Codifying...', 'Coercing...', 'Coexisting...', 'Cogitating...', 'Cohering...',
  'Coiling...', 'Coinciding...', 'Collaborating...', 'Collapsing...', 'Collating...', 'Colliding...', 'Colonizing...', 'Coloring...', 'Combing...', 'Combining...',
  'Comforting...', 'Commemorating...', 'Commencing...', 'Commenting...', 'Commissioning...', 'Commiting...', 'Communing...', 'Communicating...', 'Commuting...', 'Compacting...',
  'Comparing...', 'Compassing...', 'Compeling...', 'Compensating...', 'Competing...', 'Complementing...', 'Completing...', 'Complicating...', 'Complimenting...', 'Comprehending...',
  'Compressing...', 'Comprising...', 'Compromising...', 'Concealing...', 'Conceding...', 'Conceiving...', 'Conceptualizing...', 'Concerning...', 'Concluding...', 'Concuring...',
  'Condensing...', 'Conditioning...', 'Condoning...', 'Confering...', 'Confessing...', 'Configuring...', 'Confining...', 'Confiscating...', 'Conflating...', 'Confronting...',
  'Confusing...', 'Congealing...', 'Congratulating...', 'Conjuring...', 'Connecting...', 'Conquering...', 'Consecrating...', 'Consenting...', 'Conserving...', 'Consigning...',
  'Consisting...', 'Consoling...', 'Consolidating...', 'Conspiring...', 'Constituting...', 'Constraining...', 'Consulting...', 'Consuming...', 'Contacting...', 'Containing...',
  'Contemplating...', 'Contending...', 'Contenting...', 'Contesting...', 'Contracting...', 'Contrasting...', 'Contributing...', 'Contriving...', 'Controling...', 'Convening...',
  'Converging...', 'Conversing...', 'Converting...', 'Conveying...', 'Convincing...', 'Convoying...', 'Cooling...', 'Cooperating...', 'Coordinating...', 'Copying...',
  'Coring...', 'Corking...', 'Correlating...', 'Corresponding...', 'Corroborating...', 'Corraling...', 'Correcting...', 'Corrugating...', 'Cosseting...', 'Counseling...',
  'Counting...', 'Coupling...', 'Coursing...', 'Covering...', 'Coveting...', 'Cradling...', 'Cranking...', 'Crashing...', 'Crawling...', 'Creasing...',
  'Crediting...', 'Cresting...', 'Critiquing...', 'Crocheting...', 'Crooning...', 'Crossing...', 'Crowding...', 'Crowning...', 'Crumbing...', 'Crusading...',
  'Crystallizing...', 'Cubing...', 'Cuddling...', 'Culling...', 'Cultivating...', 'Curbing...', 'Curating...', 'Curling...', 'Currying...', 'Cushioning...',
  'Customizing...', 'Cuting...', 'Cycling...', 'Dabbling...', 'Daming...', 'Dampening...', 'Daring...', 'Darting...', 'Dashing...', 'Dating...',
  'Dawdling...', 'Dazzling...', 'Deactivating...', 'Debuging...', 'Debuting...', 'Decanting...', 'Decelerating...', 'Decentralizing...', 'Decking...', 'Declaring...',
  'Declining...', 'Decomposing...', 'Decorating...', 'Decoupling...', 'Decreasing...', 'Dedicating...', 'Deducing...', 'Deepening...', 'Defeating...', 'Defending...',
  'Defering...', 'Defining...', 'Deflecting...', 'Deforming...', 'Defragmenting...', 'Defusing...', 'Degreasing...', 'Dehydrating...', 'Delegating...', 'Deleting...',
  'Delivering...', 'Demanding...', 'Demarcating...', 'Demisting...', 'Demystifying...', 'Denoting...', 'Denouncing...', 'Densifying...', 'Departing...', 'Depending...',
  'Depositing...', 'Depressurizing...', 'Deputing...', 'Deriving...', 'Descending...', 'Describing...', 'Deserting...', 'Desiring...', 'Despatching...', 'Detecting...',
  'Detering...', 'Detoxing...', 'Devaluing...', 'Developing...', 'Deviating...', 'Devoting...', 'Diping...', 'Disabling...', 'Disarming...', 'Disassembling...',
  'Disbursing...', 'Discarding...', 'Discerning...', 'Discharging...', 'Disciplining...', 'Disclosing...', 'Disconnecting...', 'Discontinuing...', 'Discounting...', 'Discoursing...',
  'Discrediting...', 'Discriminating...', 'Discussing...', 'Disembarking...', 'Disentangling...', 'Disguising...', 'Disinfecting...', 'Disliking...', 'Dismantling...', 'Dismissing...',
  'Dispatching...', 'Dispeling...', 'Dispensing...', 'Dispersing...', 'Displaying...', 'Disposing...', 'Disproving...', 'Dissecting...', 'Disseminating...', 'Dissipating...',
  'Dissolving...', 'Distinguishing...', 'Distracting...', 'Distributing...', 'Disturbing...', 'Diverting...', 'Divining...', 'Dividing...', 'Divulging...', 'Docking...',
  'Documenting...', 'Dodging...', 'Domesticating...', 'Dominating...', 'Donating...', 'Doodling...', 'Dosing...', 'Doting...', 'Doubling...', 'Doubting...',
  'Downgrading...', 'Downloading...', 'Draging...', 'Draining...',
];

// ---- ANSI helpers ----
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[0-9;?]* [a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}
function visualCol(s) { return visualWidth(stripAnsi(String(s))); }
function col(text, c) { return c + String(text) + C.reset; }

function fitAnsi(s, w) {
  const str = String(s);
  const v = visualCol(str);
  if (v < w) return str + ' '.repeat(w - v);
  if (v === w) return str;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i))
        || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(str.slice(i))
        || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    if (n + cw > w) break;
    n += cw;
    out += ch;
    i += cp > 0xffff ? 2 : 1;
  }
  if (n < w) out += ' '.repeat(w - n);
  return out;
}

function wrapWords(str, width) {
  width = Math.max(1, width | 0);
  const out = [];
  let line = '';
  // Expand tabs first: visualCol counts '\t' as 0 columns but the terminal
  // advances to the next tab stop, which made the row wider than computed and
  // wrapped it onto the following line.
  const words = expandTabs(str).split(' ');
  for (let w of words) {
    // A word longer than the line must be hard-split. This MUST measure visual
    // columns (not string length): CJK characters occupy two cells, so slicing
    // by `.length` would emit lines twice as wide as the box and the terminal
    // would wrap them onto the next row, corrupting the layout.
    if (visualCol(w) > width) {
      if (line) { out.push(line); line = ''; }
      let chunk = '';
      let cw = 0;
      for (const ch of w) {
        const chw = visualCol(ch);
        if (cw + chw > width) { out.push(chunk); chunk = ''; cw = 0; }
        chunk += ch; cw += chw;
      }
      if (chunk) line = chunk;
      continue;
    }
    const cand = line ? line + ' ' + w : w;
    if (visualCol(cand) <= width) line = cand;
    else { if (line) out.push(line); line = w; }
  }
  if (line) out.push(line);
  else if (out.length === 0) out.push('');
  return out;
}

// Extract a (possibly still-streaming) JSON string value by key from a partial
// JSON document. Used to show a Write's `content` as it arrives; returns '' when
// the value hasn't started or is incomplete enough that decoding fails.
export function extractJsonString(json, key) {
  if (!json) return '';
  const idx = json.indexOf(`"${key}"`);
  if (idx < 0) return '';
  const colon = json.indexOf(':', idx + key.length + 2);
  if (colon < 0) return '';
  let i = colon + 1;
  while (i < json.length && /\s/.test(json[i])) i++;
  if (json[i] !== '"') return '';
  i++;
  let out = '';
  while (i < json.length) {
    const ch = json[i];
    if (ch === '\\') {
      const nxt = json[i + 1];
      if (nxt === undefined) break;
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
      if (nxt === 'u') {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16) || 0);
        i += 6; continue;
      }
      out += map[nxt] !== undefined ? map[nxt] : nxt;
      i += 2; continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out;
}

// Minimal line diff for the Edit tool: a compact LCS-based diff rendered as
//   - removed line
//   + added line
//   (unchanged context lines are omitted)
export function lineDiff(oldStr, newStr, startLine = 1) {
  const a = String(oldStr == null ? '' : oldStr).replace(/\r\n/g, '\n').split('\n');
  const b = String(newStr == null ? '' : newStr).replace(/\r\n/g, '\n').split('\n');
  // LCS table (inputs are edit snippets, so sizes stay small).
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  // Line numbers as they appear in the real file (startLine = first old line).
  let oldNo = startLine, newNo = startLine;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i], no: oldNo }); i++; j++; oldNo++; newNo++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i], no: oldNo }); i++; oldNo++; }
    else { out.push({ type: 'add', text: b[j], no: newNo }); j++; newNo++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i], no: oldNo }); i++; oldNo++; }
  while (j < m) { out.push({ type: 'add', text: b[j], no: newNo }); j++; newNo++; }
  return out;
}

// Word-wrap a string that may contain ANSI colour codes, measuring VISIBLE
// width only. Escape sequences are carried over to the line they belong to.
function wrapAnsiWords(str, width) {
  width = Math.max(1, width | 0);
  const tokens = String(str).split(/(\s+)/); // keep whitespace as tokens
  const out = [];
  let line = '';
  let lineW = 0;
  const push = () => { if (line !== '') out.push(line); line = ''; lineW = 0; };
  for (const tok of tokens) {
    if (tok === '') continue;
    const tw = visualCol(tok);
    if (/^\s+$/.test(tok)) {
      if (lineW > 0) { line += tok; lineW += tw; }
      continue;
    }
    if (lineW > 0 && lineW + tw > width) push();
    if (tw > width && visualCol(tok) > width) {
      // Hard-split an over-long token by visible columns.
      let chunk = '';
      let cw = 0;
      for (const ch of tok) {
        const chw = visualCol(ch);
        if (cw + chw > width) { out.push(chunk); chunk = ''; cw = 0; }
        chunk += ch; cw += chw;
      }
      if (chunk) { line = chunk; lineW = cw; }
      continue;
    }
    line += tok;
    lineW += tw;
  }
  if (line !== '') out.push(line);
  if (out.length === 0) out.push('');
  return out;
}

// Word-aware wrap that also returns each row's starting offset in the source
// string, so the caret can be mapped to a (row, col) inside the composer.
function wrapWithOffsets(text, width) {
  const out = [];
  const n = text.length;
  if (n === 0) return [{ text: '', start: 0 }];
  let i = 0;
  while (i < n) {
    let w = 0;
    let j = i;
    let lastSpace = -1;
    while (j < n) {
      const ch = text[j];
      const cw = visualWidth(ch);
      if (w + cw > width) break;
      if (ch === ' ') lastSpace = j;
      w += cw;
      j++;
    }
    if (j === i) j = i + 1; // always make progress (wide char > width)
    if (j < n && lastSpace > i) {
      out.push({ text: text.slice(i, lastSpace), start: i });
      i = lastSpace + 1;
    } else {
      out.push({ text: text.slice(i, j), start: i });
      i = j;
    }
  }
  return out;
}

// The composer is ONLY for messages to the model. Dialogs (pickers, forms) do
// not use it — they render their own inputs (search box, form fields).
// The prompt glyph matches the transcript's user marker (`❯`) so the composer
// reads as "the same kind of thing" as a sent user message.
export function composerInput(state) {
  return { text: state.input || '', caret: state.caret || 0, prefix: '❯ ' };
}

// Marker text for a collapsed multi-line paste, e.g. `[paste #1 +12 lines]`.
// Only multi-line pastes collapse; a single-line paste is inserted verbatim.
export function pasteMarker(id, lineCount) {
  return lineCount > 1 ? `[paste #${id} +${lineCount} lines]` : `[paste #${id} ${lineCount} lines]`;
}
// Matches a collapsed-paste marker anywhere in a string.
const PASTE_MARKER_RE = /\[paste #(\d+) \+\d+ lines\]/g;

// Expand every `[paste #N +L lines]` marker in `text` back to its real content.
export function expandPastes(text, pastes) {
  if (!pastes || !text || !text.includes('[paste #')) return text;
  return text.replace(PASTE_MARKER_RE, (whole, id) => {
    const entry = pastes.get(Number(id));
    return entry ? entry.text : whole;
  });
}

// Wrap each `[paste #N +L lines]` marker in the composer row with a selection
// background so it renders as one block chip (foreground preserved). Returns
// the row with ANSI inserted; non-marker text is left untouched.
export function highlightPasteMarkers(row) {
  const s = String(row);
  if (!s.includes('[paste #')) return s;
  return s.replace(/\[paste #\d+ \+\d+ lines\]/g, (m) => C.selBg + m + C.reset);
}

// Apply selection background to the text portion of a composer row.
// `text` is the visible text on this row (after the prefix), `textStart`
// is the character offset of `text[0]` in the full input string, and
// `[selAnchor, selHead]` is the selection range in the full input.
export function highlightSelection(text, textStart, selAnchor, selHead) {
  if (!text) return text;
  const a = Math.min(selAnchor, selHead);
  const h = Math.max(selAnchor, selHead);
  let out = '';
  let inSel = false;
  for (let i = 0; i < text.length; i++) {
    const globalIdx = textStart + i;
    const want = globalIdx >= a && globalIdx < h;
    if (want && !inSel) { out += C.selBg; inSel = true; }
    else if (!want && inSel) { out += C.reset; inSel = false; }
    out += text[i];
  }
  if (inSel) out += C.reset;
  return out;
}

// The composer treats a collapsed-paste marker as ONE atomic unit: moving the
// caret across it jumps over the whole `[paste #N +L lines]`, and deleting it
// removes the entire marker. `dir` = -1 (look left of the caret) or +1 (right).
export function adjacentPasteMarker(text, caret, dir) {
  const s = String(text || '');
  const c = Math.max(0, Math.min(s.length, caret));
  if (dir < 0) {
    const m = /\[paste #(\d+) \+\d+ lines\]$/.exec(s.slice(0, c));
    if (m) return { start: c - m[0].length, end: c, id: Number(m[1]) };
  } else {
    const m = /^\[paste #(\d+) \+\d+ lines\]/.exec(s.slice(c));
    if (m) return { start: c, end: c + m[0].length, id: Number(m[1]) };
  }
  return null;
}

// Apply the hover highlight to the visible columns [col0, col1) of an ANSI row.
// The highlight is an explicit bright style (C.hover), and it is RE-APPLIED
// after every escape sequence inside the span: a row is built from several
// col(...) chunks, each of which ends in RESET, and those resets used to cancel
// a bare BOLD a few characters into the row — so only the first chunk of a row
// ever appeared to light up. When the span ends, the row's own style is put
// back by replaying the SGR codes seen so far.
export function tintRange(row, col0, col1) {
  const s = String(row);
  if (col1 <= col0) return s;
  const hover = C.hover;
  let out = '';
  let cur = ''; // the row's own SGR state so far (replayed after the span)
  let col = 0;
  let i = 0;
  let tinting = false;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i))
        || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
      if (m) {
        const seq = m[0];
        if (seq.endsWith('m')) { // SGR: track what the row has set for itself
          const p = seq.slice(2, -1);
          if (p === '' || p.split(';').includes('0')) cur = '';
          else cur += seq;
        }
        out += seq;
        if (tinting) out += hover; // the row's own codes must not cancel us
        i += seq.length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    const want = col >= col0 && col < col1;
    if (want && !tinting) { out += hover; tinting = true; }
    else if (!want && tinting) { out += C.reset + cur; tinting = false; }
    out += ch;
    col += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  if (tinting) out += C.reset + cur;
  return out;
}

// Wrap the single visible cell at column `col` in reverse video: our own block
// caret. The row is already padded to the full width, so a caret past the last
// character inverts a padding space (kimi-code renders its caret the same way).
// A wide (2-column) glyph is inverted as a whole so the block keeps its size.
export function caretBlock(row, col) {
  const s = String(row);
  if (col < 0) return s;
  let out = '';
  let shown = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i))
        || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    if (col >= shown && col < shown + cw) {
      // Invert exactly one cell; ESC[7m .. ESC[27m leaves the row's colours alone.
      out += '\x1b[7m' + ch + '\x1b[27m';
    } else {
      out += ch;
    }
    shown += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return out;
}

// Lay the composer out as display rows. The first row carries the prompt
// prefix; wrapped continuation rows are indented to match. Explicit newlines
// start a fresh row. Returns the rows plus the caret's (row, col) within them
// (col already includes the leading border column).
function composerLayout(state, insideW) {
  const { text: rawText, caret: rawCaret, prefix } = composerInput(state);
  const text = rawText;
  const caret = Math.max(0, Math.min(text.length, rawCaret));
  const cont = ' '.repeat(visualCol(prefix));
  const rows = [];
  // Per display row: the text offsets it covers plus the visual width of its
  // prefix, so a mouse click can be mapped back to a text index (click-to-caret).
  const meta = [];
  let caretRow = 0;
  let caretCol = 1 + visualCol(prefix);
  let base = 0;
  const paras = text.split('\n');
  for (let pi = 0; pi < paras.length; pi++) {
    const p = paras[pi];
    const pre = pi === 0 ? prefix : cont;
    const bodyW = Math.max(1, insideW - visualCol(pre));
    const segs = wrapWithOffsets(p, bodyW);
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      const rowPre = si === 0 ? pre : cont;
      rows.push(rowPre + seg.text);
      meta.push({ start: base + seg.start, end: base + seg.start + seg.text.length, preWidth: visualCol(rowPre) });
      const absStart = base + seg.start;
      const absEnd = absStart + seg.text.length;
      if (caret >= absStart && caret <= absEnd) {
        caretRow = rows.length - 1;
        caretCol = 1 + visualCol(rowPre) + visualCol(seg.text.slice(0, caret - absStart));
      }
    }
    base += p.length + 1; // + the '\n' we split on
  }
  if (rows.length === 0) { rows.push(prefix); meta.push({ start: 0, end: 0, preWidth: visualCol(prefix) }); }
  return { rows, meta, caretRow, caretCol };
}

// Map a click inside the composer content (colInside = 0-based column within the
// text area, after the left border) on display row `rowIdx` back to a text index.
export function composerTextIndexAt(layout, rowIdx, colInside) {
  const m = layout.meta[rowIdx];
  if (!m) return 0;
  const colInSeg = colInside - m.preWidth; // columns into the segment text
  if (colInSeg <= 0) return m.start;
  // Walk the row's text to find the character whose cumulative width passes colInSeg.
  const rowText = layout.rows[rowIdx].slice(m.preWidth);
  let w = 0;
  let idx = 0;
  for (const ch of rowText) {
    const cw = visualWidth(ch);
    if (w + cw > colInSeg) break;
    w += cw;
    idx += ch.length;
  }
  return Math.min(m.end, m.start + idx);
}

// A Bash result is a FAILURE when the command exited non-zero or the spawn
// itself errored. Detected from the tool-result text (the only place the code
// survives for the UI, since the exit-code line is hidden from display).
// Failure prefixes that the built-in tools actually return (verified against
// src/tools/*.js). Any result starting with one of these is a FAILED call:
//   "Error: old_string not found in …"      (Edit)
//   "Error reading/writing <path>: …"       (Read/Write/Edit)
//   "Cannot read: <path> appears to be …"   (Read)
//   "Edit rejected: …"                      (Edit staleness / read guards)
//   "Command cannot be empty."              (Bash)
// resolvePath throws are surfaced verbatim as `e.message`, e.g.
//   "Path outside workspace: …" / "ENOENT: no such file or directory …".
const FAIL_PREFIX = /^(Error\b|\[error:|Cannot read:|Edit rejected:|Command cannot be empty\b|Path outside workspace\b|ENOENT\b|EACCES\b|EPERM\b|EISDIR\b|ENOTDIR\b)/i;

export function isFailureResult(text, toolName) {
  const s = String(text == null ? '' : text);
  const trimmed = s.trim();
  if (FAIL_PREFIX.test(trimmed)) return true;
  // A non-zero Bash exit code marks the call as failed (red status bullet). The
  // `[exit code: N]` LINE itself is never shown to the user — it is bookkeeping
  // for the model only (see messageLines).
  const m = /\[exit code:\s*([^\]]+)\]/.exec(s);
  if (!m) return false;
  const v = m[1].trim();
  return v !== '0';
}

// Extract the human-readable failure reason from a tool result, or '' when the
// result should not render an extra "why it failed" line. The reason is shown
// in red under the tool call for non-Bash tools (Edit / Read / Write / …); Bash
// failures are already obvious from the command's own output, so they return ''.
export function failureReason(text, toolName) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash') return '';
  const s = String(text == null ? '' : text);
  const trimmed = s.trim();
  if (!FAIL_PREFIX.test(trimmed)) return '';
  // Collapse to a single line and drop the `[error: …]` wrapper.
  let line = trimmed.split('\n')[0].trim();
  line = line.replace(/^\[error:\s*/i, '').replace(/\]$/, '').trim();
  return line;
}

function msgColorFor(role, text) {
  if (role === 'system' && typeof text === 'string' && text.startsWith('[turn took')) return C.gray;
  if (role === 'system') return C.teal;
  if (role === 'user') return C.cyan;
  if (role === 'warn') return C.orange;    // unfinished-turn warning
  if (role === 'queued') return C.gray;    // pending, not yet sent
  if (role === 'steer') return C.yellow;   // injected into the running turn
  if (role === 'tool') return C.blue;
  if (role === 'tool_result') return C.gray;
  // Default foreground color based on theme
  return C.fg;
}

// ---- tool call display: "Using Name (keyArg)" / "Used Name (keyArg) ----
// Mirrors kimi-code's extractKeyArgument: pick the one argument that best
// identifies the call, so a tool line reads `Using Read (src/tui.js)`.
const KEY_ARG = {
  Bash: ['command'],
  Read: ['path', 'file_path'],
  Write: ['path', 'file_path'],
  Edit: ['path', 'file_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  FileLines: ['path', 'file_path'],
  FetchURL: ['url'],
  WebSearch: ['query'],
  Agent: ['description', 'prompt'],
  TaskOutput: ['task_id'],
  TaskStop: ['task_id'],
};
const MAX_ARG = 60;
function keyArgument(name, args, workspace) {
  if (!args || typeof args !== 'object') return '';
  const keys = KEY_ARG[name] || Object.keys(args);
  for (const k of keys) {
    const v = args[k];
    if (typeof v !== 'string' || !v.length) continue;
    let text = v.split('\n')[0];
    // Make absolute paths under the workspace relative (shorter + familiar).
    if ((k === 'path' || k === 'file_path') && path.isAbsolute(text) && workspace) {
      const rel = path.relative(workspace, text);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) text = rel;
    }
    if (text.length > MAX_ARG) {
      text = (k === 'path' || k === 'file_path')
        ? '…' + text.slice(text.length - (MAX_ARG - 1))
        : text.slice(0, MAX_ARG - 1) + '…';
    }
    // Display paths with forward slashes (consistent across platforms).
    if (k === 'path' || k === 'file_path') text = text.replace(/\\/g, '/');
    return text;
  }
  return '';
}
// "● Using Read (src/tui.js)" while running, "● Used Read (src/tui.js)" when done.
// The verb is plain (white) / green once finished; the tool NAME is always the
// theme (cyan) colour; the key argument is dim/gray.
export function formatToolLine(msg, workspace) {
  const name = msg.toolName || '';
  const arg = keyArgument(name, msg.toolArgs, workspace);
  const verb = msg.pending ? 'Using' : 'Used';
  // Show streamed size for Write tool
  let sizeStr = '';
  if (name === 'Write' && typeof msg.streamContent === 'string' && msg.streamContent.length) {
    const bytes = Buffer.byteLength(msg.streamContent, 'utf8');
    sizeStr = bytes >= 1048576 ? ` ${(bytes / 1048576).toFixed(1)}MB`
      : bytes >= 1024 ? ` ${(bytes / 1024).toFixed(1)}KB`
      : ` ${bytes}B`;
  }
  // Show +xx -xx diff counts for Edit tool when done
  let diffStr = '';
  if (name === 'Edit' && !msg.pending && msg.diff && msg.diff.length) {
    const adds = msg.diff.filter((d) => d.type === 'add').length;
    const deletes = msg.diff.filter((d) => d.type === 'del').length;
    if (adds || deletes) {
      diffStr = ' ' + (adds ? col(`+${adds}`, C.green) : '') + ' ' + (deletes ? col(`-${deletes}`, C.red) : '');
    }
  }
  // The `●` bullet carries the state (orange while running, green when done),
  // so the verb itself stays plain white and the tool name keeps the theme
  // colour.
  const argText = arg ? ' ' + col(`(${arg})`, C.gray) : '';
  return col(verb, C.white) + ' ' + col(name, C.cyan) + argText + col(sizeStr, C.gray) + diffStr;
}

// ---- live TODO panel (kimi-code's todo-panel) ----
// Renders above the input box: a rule, a "Todo" heading, up to 5 rows, and a
// "+N more · ctrl+t to expand" hint. Ctrl+T expands the full list.
const TODO_MAX_VISIBLE = 5;
export function selectVisibleTodos(todos) {
  if (todos.length <= TODO_MAX_VISIBLE) return { rows: todos, hidden: 0, counts: {} };
  const inProgress = [], pending = [], done = [];
  todos.forEach((t, i) => {
    if (t.status === 'in_progress') inProgress.push(i);
    else if (t.status === 'pending') pending.push(i);
    else done.push(i);
  });
  const picked = new Set(inProgress.slice(0, TODO_MAX_VISIBLE));
  if (picked.size < TODO_MAX_VISIBLE) {
    const doneC = [...done].reverse();
    const pendC = pending;
    const remaining = TODO_MAX_VISIBLE - picked.size;
    let doneCount, pendCount;
    if (!doneC.length) { doneCount = 0; pendCount = Math.min(remaining, pendC.length); }
    else if (!pendC.length) { pendCount = 0; doneCount = Math.min(remaining, doneC.length); }
    else {
      doneCount = 1;
      pendCount = Math.min(remaining - 1, pendC.length);
      if (pendCount < remaining - 1) doneCount = Math.min(doneC.length, remaining - pendCount);
    }
    for (let i = 0; i < doneCount; i++) picked.add(doneC[i]);
    for (let i = 0; i < pendCount; i++) picked.add(pendC[i]);
  }
  const idx = [...picked].sort((a, b) => a - b);
  const counts = { done: 0, in_progress: 0, pending: 0 };
  todos.forEach((t, i) => { if (!picked.has(i)) counts[t.status] = (counts[t.status] || 0) + 1; });
  return { rows: idx.map((i) => todos[i]), hidden: todos.length - idx.length, counts };
}

function todoRow(todo, w) {
  const mark = todo.status === 'in_progress' ? col('●', C.cyan + C.bold)
    : todo.status === 'done' ? col('✓', C.green)
    : col('○', C.gray);
  const title = todo.status === 'in_progress' ? col(todo.title, C.white + C.bold)
    : todo.status === 'done' ? col(todo.title, C.gray)
    : col(todo.title, C.white);
  return '  ' + mark + ' ' + fitAnsi(title, Math.max(1, w - 4));
}

// `hoverTop` / `dragTop` drive the top rule's hover and press colours: that rule
// is a drag handle for resizing the panel.
function renderTodoPanel(state, w, hoverTop, dragTop) {
  const todos = state.todos || [];
  if (!todos.length) return [];
  const out = [];
  const ruleColor = dragTop ? C.scrollThumbActive : (hoverTop ? C.hover : C.border);
  out.push(col('─'.repeat(w), ruleColor));
  out.push(col('  Todo', C.cyan + C.bold));
  const want = todoRowCount(state);
  // Keep the automatic pick ORDER (so the in-progress item keeps its priority) and
  // top it up from the remaining items until `want` rows are shown.
  const ordered = [];
  const seen = new Set();
  for (const t of selectVisibleTodos(todos).rows) { ordered.push(t); seen.add(t); }
  for (const t of todos) {
    if (ordered.length >= want) break;
    if (!seen.has(t)) { ordered.push(t); seen.add(t); }
  }
  const rows = ordered.slice(0, want);
  for (const t of rows) out.push(todoRow(t, w));
  const hidden = todos.length - rows.length;
  if (hidden > 0) {
    const counts = { done: 0, in_progress: 0, pending: 0 };
    for (const t of todos) if (!rows.includes(t)) counts[t.status] = (counts[t.status] || 0) + 1;
    const dist = [['done', 'done'], ['in_progress', 'in progress'], ['pending', 'pending']]
      .filter(([k]) => counts[k] > 0).map(([k, label]) => `${counts[k]} ${label}`).join(', ');
    out.push(col(`  … +${hidden} more${dist ? ` (${dist})` : ''} · drag the top rule to resize`, C.gray));
  }
  return out;
}

// --- queue pane (kimi-code's QueuePane) -------------------------------------
// One rule line, one line per queued message, one dim hint line. Queued input is
// held while the agent is streaming and is injected by Ctrl-S (or by the agent
// itself at the next tool boundary).
function renderQueuePanel(state, w) {
  const queued = state.queued || [];
  if (!queued.length) return [];
  const out = [col('─'.repeat(w), C.border)];
  for (const text of queued) {
    // Collapse to a single line, like kimi's queue pane does.
    const single = String(text).replace(/\s+/g, ' ').trim();
    out.push(col('  ', C.cyan) + col('❯ ', C.cyan) + col(fitAnsi(single, Math.max(1, w - 6)), C.white));
  }
  const hint = state.running ? '↑ to edit · ctrl-s to steer immediately' : '↑ to edit · will send now';
  out.push(col('  ' + hint, C.gray));
  return out;
}

// Height (in rows) the queue pane will occupy, for layout math.
function queuePanelHeight(state) {
  const n = (state.queued || []).length;
  return n ? n + 2 : 0; // rule + items + hint
}

// How many todo ROWS the panel shows.
//   * `state.todoRows` (set by dragging the top rule) wins when present;
//   * otherwise the automatic heuristic (selectVisibleTodos) decides.
// Always clamped to [1, todos.length]: at least ONE row, never more than exist.
export function todoRowCount(state) {
  const todos = state.todos || [];
  if (!todos.length) return 0;
  const manual = state.todoRows;
  let rows;
  if (typeof manual === 'number' && Number.isFinite(manual)) {
    rows = Math.round(manual);
  } else {
    rows = state.todosExpanded ? todos.length : selectVisibleTodos(todos).rows.length;
  }
  return Math.max(1, Math.min(todos.length, rows));
}

// Height (in rows) the todo panel will occupy, for layout math.
export function todoPanelHeight(state) {
  const todos = state.todos || [];
  if (!todos.length) return 0;
  const rows = todoRowCount(state);
  const extra = todos.length > rows ? 1 : 0; // the "… +N more" hint
  return 2 + rows + extra; // rule + heading + rows (+ hint)
}

// Render one chat message into display lines.
// Returns { lines: [{text, ind, color}] } (ind = indent string for continuation).
function messageLines(msg, width, workspace, expanded) {
  // Tool calls render as a single "● Using/Used Name (arg)" line (kimi style).
  // The body already carries its own ANSI colours, so mark it pre-colored.
  if (msg.role === 'tool') {
    const body = formatToolLine(msg, workspace);
    // Red bullet for a failed call (a Bash non-zero exit / [error: …]).
    const failed = msg.failed === true || (msg.role === 'tool' && msg.failed === true);
    const pre = col('● ', msg.pending ? C.orange : (failed ? C.red : C.green));
    const bodyW = Math.max(1, width - visualCol('● '));
    const wrapped = wrapAnsiWords(body, bodyW);
    const out = wrapped.map((t, i) => ({
      text: t,
      ind: i === 0 ? pre : '  ',
      raw: true,   // text already contains ANSI; do not wrap in another colour
    }));
    const name = msg.toolName || '';
    const indent = '  ';
    const avail = Math.max(1, width - visualCol(indent));

    // Live output of a RUNNING command (Bash): rendered under the "Using …"
    // row exactly like the finished "Used …" output, just not done yet. Only
    // the tail is shown (capped) so a chatty command cannot flood the frame.
    if (msg.pending && typeof msg.liveOutput === 'string' && msg.liveOutput.length) {
      const bodyW = Math.max(1, width - visualCol('  '));
      const rawLines = msg.liveOutput.replace(/\r\n/g, '\n').split('\n');
      const MAX_RUN_LINES = expanded ? Infinity : 8;
      const shown = rawLines.slice(-MAX_RUN_LINES); // running: show the newest output
      if (rawLines.length > MAX_RUN_LINES) {
        out.push({ text: col(`… ${rawLines.length - MAX_RUN_LINES} earlier line(s)`, C.gray), ind: indent, raw: true });
      }
      for (const ln of shown) {
        for (const t of (ln === '' ? [''] : wrapWords(ln, bodyW))) {
          out.push({ text: col(t, C.gray), ind: indent, raw: true });
        }
      }
    }

    // Write: stream the file content while the model is still emitting it.
    if (name === 'Write' && typeof msg.streamContent === 'string' && msg.streamContent.length) {
      const lines = msg.streamContent.replace(/\r\n/g, '\n').split('\n');
      const MAX = 20;
      const wNum = String(lines.length).length;
      lines.slice(0, MAX).forEach((ln, i) => {
        out.push({ text: col(`${String(i + 1).padStart(wNum)} ${ln}`, C.gray), ind: indent, raw: true });
      });
      if (lines.length > MAX) out.push({ text: col(`… ${lines.length - MAX} more lines`, C.gray), ind: indent, raw: true });
    }

    // Edit: show the diff once the tool has finished, as
    //   <line-no> - old text
    //   <line-no> + new text
    if (name === 'Edit' && !msg.pending && msg.diff && msg.diff.length) {
      const MAX = 40;
      const changed = msg.diff.filter((d) => d.type !== 'ctx');
      const width = Math.max(1, ...changed.map((d) => String(d.no || 0).length));
      for (const d of changed.slice(0, MAX)) {
        const no = String(d.no || 0).padStart(width);
        const mark = d.type === 'add' ? '+' : '-';
        const color = d.type === 'add' ? C.green : C.red;
        out.push({ text: col(`${no} ${mark} ${d.text}`, color), ind: indent, raw: true });
      }
      if (changed.length > MAX) out.push({ text: col(`… ${changed.length - MAX} more changed lines`, C.gray), ind: indent, raw: true });
      if (changed.length === 0) out.push({ text: col('(no changes)', C.gray), ind: indent, raw: true });
    }
    return out;
  }
  // Tool output: a single "↳ " marker on the first line, then the output
  // indented by 2 columns. Long output is capped (kimi caps result previews
  // too) so one command cannot flood the whole transcript.
  if (msg.role === 'tool_result') {
    // The marker sits in the SAME COLUMN as the tool bullet `●` (rendered as
    // '● ', i.e. columns 0-1), so `↳ ` starts at column 0 and the output text
    // is indented to the tool text column. ONE `↳` per result, however many
    // lines it has.
    const pre = '↳ ';
    const cont = '  ';
    const bodyW = Math.max(1, width - visualCol(cont));
    const rawLines = String(msg.text || '').replace(/\r\n/g, '\n').split('\n');
    // Trim blank lines at BOTH ends: commands typically emit a trailing
    // newline, and some tools emit a leading one. A stray blank line would
    // render as a lone "↳ " with no content.
    while (rawLines.length && rawLines[0].trim() === '') rawLines.shift();
    while (rawLines.length && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
    const MAX_RESULT_LINES = expanded ? Infinity : 12;
    // The exit-code line is bookkeeping for the AGENT (it stays in the tool
    // result the model receives) and is NEVER shown to the user — success or
    // failure. A failure is already legible from the RED result text below.
    // `[error: …]` is kept: it carries the message, not just a code.
    const visible = rawLines.filter((ln) => !/^\[exit code:/.test(ln.trim()));
    const failed = msg.failed === true;
    const shown = visible.slice(0, MAX_RESULT_LINES);
    const out = [];
    shown.forEach((ln, idx) => {
      const isErr = /^\[error:/.test(ln.trim());
      // A failed run is red throughout so it cannot be skimmed past.
      const color = isErr ? C.red : (failed ? C.red : C.gray);
      const wrapped = ln === '' ? [''] : wrapWords(ln, bodyW);
      wrapped.forEach((t, i) => {
        out.push({ text: t, ind: idx === 0 && i === 0 ? pre : cont, color });
      });
    });
    if (visible.length > MAX_RESULT_LINES) {
      out.push({ text: `… ${visible.length - MAX_RESULT_LINES} more lines`, ind: cont, color: failed ? C.red : C.gray });
    }
    // Nothing to show (empty output) -> render no row at all rather than a
    // dangling "↳ ".
    return out;
  }

  // Reasoning ("thinking") block, matching kimi-code's ThinkingComponent:
  //   live      -> "<spinner> thinking…" then the LAST 2 content lines, indented
  //   finalized -> "● " marker on the first line, up to 2 preview lines, then a
  //                "… (N more lines)" hint
  // All of it is dim text.
  if (msg.role === 'thinking') {
    const INDENT = '  ';
    const bodyW = Math.max(1, width - visualCol(INDENT));
    const contentLines = [];
    for (const ln of String(msg.text || '').replace(/\r\n/g, '\n').split('\n')) {
      if (ln === '') { contentLines.push(''); continue; }
      for (const w of wrapWords(ln, bodyW)) contentLines.push(w);
    }
    const PREVIEW = expanded ? Infinity : 2;
    const out = [];
    if (msg.pending) {
      const spin = SPINNER[(msg.spin || 0) % SPINNER.length];
      out.push({ text: spin + ' thinking…', ind: '', color: C.gray });
      const vis = contentLines.length > PREVIEW ? contentLines.slice(-PREVIEW) : contentLines;
      for (const l of vis) out.push({ text: l, ind: INDENT, color: C.gray });
    } else {
      const shown = contentLines.slice(0, PREVIEW);
      shown.forEach((l, i) => out.push({ text: l, ind: i === 0 ? '● ' : INDENT, color: C.gray }));
      if (contentLines.length > PREVIEW) {
        out.push({ text: `… (${contentLines.length - PREVIEW} more lines, ctrl+o to expand)`, ind: INDENT, color: C.gray });
      }
      if (shown.length === 0) out.push({ text: '', ind: '● ', color: C.gray });
    }
    return out;
  }

  let icon = '';
  switch (msg.role) {
    case 'system': icon = ''; break;
    case 'user': icon = '❯'; break;
    case 'warn': icon = '⚑'; break;   // ⚑ unfinished-turn warning
    // `queued` keeps the SAME marker as a user message: it is a user message, just
    // not sent yet. Its pending state is shown by the colour (gray) and the queue
    // pane below, not by a different glyph.
    case 'queued': icon = '❯'; break;
    case 'steer': icon = '❯'; break;
    case 'aborted': icon = ''; break;
    default: icon = '';
  }
  const prefix = icon ? icon + ' ' : ''; // Restore original: no extra blank column
  const preW = visualCol(prefix);
  const contPad = ' '.repeat(preW);
  const bodyW = Math.max(1, width - preW);
  const fg = msgColorFor(msg.role, msg.text);
  // The marker keeps the theme colour (cyan) while a USER message renders its
  // text in white — the whole line used to inherit the role colour, so user
  // text came out cyan too. `indColor` colours the marker only.
  const indColor = msg.role === 'user' ? C.cyan : fg;
  const bodyFg = msg.role === 'user' ? C.white : fg;
  const codeFg = C.cyan;
  const lines = [];
  // Only assistant/thinking output benefits from Markdown; user/system/tool
  // stay plain so their text is never mangled. Assistant text should be WHITE by default.
  const useMd = msg.role === 'assistant';
  if (useMd) {
    const mdRows = renderMdText(String(msg.text || ''), bodyW, fg, codeFg);
    mdRows.forEach((ml, i) => {
      lines.push({ text: ml, ind: i === 0 ? prefix : contPad, raw: true });
    });
  } else {
    let code = false;
    for (const raw of expandTabs(String(msg.text || '')).split('\n')) {
      if (raw.trimStart().startsWith('```')) { code = !code; continue; }
      if (code) lines.push({ text: raw.slice(0, bodyW), ind: contPad, color: codeFg });
      else {
        for (const ln of wrapWords(raw, bodyW)) {
          // The marker is emitted only for the message's FIRST row. Using a
          // per-source-line index repeated `❯` on every line of a multi-line
          // message.
          const firstRow = lines.length === 0;
          lines.push({ text: ln, ind: firstRow ? prefix : contPad, color: bodyFg, indColor: firstRow ? indColor : undefined });
        }
      }
    }
  }
  if (lines.length === 0) lines.push({ text: '', ind: prefix, color: fg });
  return lines;
}

// Block-level Markdown renderer. Produces pre-styled rows (each carries its own
// ANSI). Supports: headings, thematic breaks, blockquotes, unordered/ordered and
// task lists, indented/nested lists, tables, fenced code blocks (with the
// language captured so a future highlighter can use it), paragraphs, and inline
// styles (bold/italic/strike/code/links/autolinks).
function renderMdText(text, width, fg, codeFg) {
  const src = String(text).replace(/\r\n/g, '\n');
  const para = src.split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}.*\|/.test(l) || /^\s*\|[-: ]+\|/.test(l);
  const splitCells = (l) => {
    const s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map((c) => c.trim());
  };

  while (i < para.length) {
    let line = para[i];
    const t = line.replace(/\s+$/, '');
    // Fenced code block. Rendered with a rule ABOVE (labelled with the language)
    // and a matching full-width rule BELOW, so the block is visibly delimited.
    const fm = /^\s*(```+|~~~+)\s*(\S*)/.exec(t);
    if (fm) {
      const lang = fm[2] || '';
      i++;
      const buf = [];
      while (i < para.length && !/^\s*(```+|~~~+)/.test(para[i])) { buf.push(para[i]); i++; }
      i++; // closing fence
      const rule = (s) => col(s, C.gray);
      // Opening rule: `─ <lang> ` then `─` padding out to the FULL width.
      // (The old version subtracted 4 and was 2 columns short of the panel.)
      if (lang) {
        const head = `\u2500 ${lang} `;
        out.push(rule(head + '─'.repeat(Math.max(1, width - visualCol(head)))));
      } else {
        out.push(rule('─'.repeat(Math.max(1, width))));
      }
      // Fenced code block CONTENT is plain body text — render it in the
      // default terminal colour (white), not the theme's cyan. The cyan is
      // reserved for UI chrome and the language label; a large code block in
      // cyan reads as "everything is the theme colour" (matches the "assistant
      // text should be white" requirement).
      for (const cl of buf) out.push(col(cl.slice(0, width), C.white));
      // Closing rule, matching the opening one.
      out.push(rule('─'.repeat(Math.max(1, width))));
      continue;
    }
    // Table: a header line followed by a separator line
    if (t.includes('|') && i + 1 < para.length && isTableSep(para[i + 1])) {
      const header = splitCells(t);
      const sep = splitCells(para[i + 1]);
      const body = [];
      i += 2;
      while (i < para.length && para[i].trim().includes('|') && !isTableSep(para[i])) { body.push(splitCells(para[i])); i++; }
      renderTable(out, header, body, sep.length, width, fg);
      continue;
    }
    // Fall through to single-line renderer
    const rows = markdownLineToRows(t, width, fg, codeFg, false);
    out.push(...rows);
    i++;
  }
  return out;
}

// Render a Markdown table as aligned columns. Header bolded, rows readable.
function renderTable(out, header, body, colCount, width, fg) {
  const cols = Math.max(header.length, colCount, ...body.map((r) => r.length));
  const B = C.border;
  const val = (r, c) => (r && r[c] !== undefined ? String(r[c]) : '');
  // Per-column natural width (visual columns), reserving 2 padding each side.
  const natural = Array.from({ length: cols }, (_, c) => {
    let m = 0;
    const consider = (v) => { m = Math.max(m, visualCol(v)); };
    consider(val(header, c));
    for (const r of body) consider(val(r, c));
    return m;
  });
  // Cap total table width to the available width (minus borders).
  const availInner = Math.max(cols, width - (cols + 1));
  const totalNatural = natural.reduce((a, b) => a + 2 + b, 0);
  let widths;
  if (totalNatural <= availInner) {
    widths = natural;
  } else {
    // Scale down proportionally, but never below 1.
    const over = totalNatural - availInner;
    const surplus = natural.reduce((a, b) => a + (b > 1 ? b - 1 : 0), 0) + cols * 1;
    widths = natural.map((n) => {
      const shrink = over > 0 ? Math.min(n - 1, Math.round((n - 1) * (over / Math.max(1, surplus)))) : 0;
      return Math.max(1, n - shrink);
    });
  }
  // Render one row; bold for the header.
  const oneRow = (cells, bold, onlyCells) => {
    const parts = [];
    for (let c = 0; c < cols; c++) {
      const v = val(cells, c);
      const cell = ' ' + v + ' '.repeat(Math.max(0, widths[c] - visualCol(v))) + ' ';
      parts.push(bold ? col(cell, C.white + C.bold) : col(cell, C.gray));
    }
    out.push(col('│', B) + parts.join(col('│', B)) + col('│', B));
  };
  out.push(col('╭' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '╮', B));
  oneRow(header, true);
  out.push(col('├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤', B));
  for (const r of body) oneRow(r, false);
  out.push(col('╰' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '╯', B));
}
function markdownLineToRows(line, width, fg, codeFg, isContinuation) {
  const out = [];
  const t = line.replace(/\s+$/, '');

  // Headings: `# 标题`
  let m = /^(\s*)(#{1,6})\s+(.*)$/.exec(t);
  if (m && !isContinuation) {
    const hashCount = m[2].length;
    // h1 is bold white, h2 is plain white, h3+ is gray. Only h1 carries BOLD.
    const size = hashCount === 1 ? C.white + C.bold : hashCount === 2 ? C.white : C.gray;
    for (const w of wrapWords(m[3], width)) {
      out.push(col(w, size));
    }
    return out;
  }
  // Thematic break
  if (/^\s*(-{3,}|\*{3,}|_{3,})$/.test(t)) {
    out.push(col('─'.repeat(Math.min(width, Math.max(8, width))), C.gray));
    return out;
  }
  // Blockquote
  if (/^\s*>\s?/.test(t)) {
    const content = t.replace(/^\s*>\s?/, '');
    for (const w of wrapWords(content, Math.max(1, width - 2))) {
      out.push(col('▍' + w, C.gray));
    }
    return out;
  }
  // Unordered/ordered list — bold the bullet, keep content plain. Also handles
  // task checkboxes `- [ ] xxx` / `- [x] xxx`.
  {
    const task = /^(\s*)([-*+]\s+)?\[( |x|X)\]\s+(.*)$/.exec(t);
    if (task && !isContinuation) {
      const checked = task[3] !== ' ';
      const box = checked ? col('✓', C.green) : col('○', C.gray);
      const content = col(' ' + inlineMarkdown(task[4], codeFg, fg), fg);
      for (const w of wrapWords(task[4], Math.max(1, width - 4))) {
        out.push(col('  ', C.gray) + box + (w === task[4] ? content : col(' ' + w, fg)));
      }
      return out;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(t);
    if (li && !isContinuation) {
      const isOrdered = /^\d/.test(li[2]);
      const bullet = isOrdered ? col(li[2], C.cyan) : col('•', C.cyan);
      const pad = isOrdered ? ' '.repeat(visualCol(li[2])) + ' ' : '  ';
      let first = true;
      for (const w of wrapWords(inlineMarkdown(li[3], codeFg, fg), Math.max(1, width - 2))) {
        out.push((first ? col('', C.gray) + bullet + ' ' : col(pad, C.gray)) + col(w, fg));
        first = false;
      }
      return out;
    }
  }
  // Inline styles: **bold**, *italic*, `code`, [text](url)
  if (/[*`\[]/.test(t)) {
    for (const w of wrapWords(t, width)) out.push(col(inlineMarkdown(w, codeFg, fg), fg));
    return out;
  }
  // Plain - apply default foreground color
  for (const w of wrapWords(t, width)) out.push(col(w, fg));
  return out;
}

// Apply inline markdown to a single line: `code`, **bold**, *italic*, ~~strike~~,
// [text](url). Order matters so inner tokens are handled safely.
// `base` is the surrounding foreground colour; every inline style re-asserts it
// after its own reset, otherwise the bare `\e[0m` would cancel the base colour
// for the REST of the line (plain text after a **bold** run used to lose its
// colour and fall back to the terminal default).
function inlineMarkdown(s, codeFg, base) {
  const fb = base || '';
  let r = s;
  // Inline code first so it is not mangled by * [] ~.
  r = r.replace(/`([^`]+)`/g, (_, c) => col(c, codeFg) + fb);
  // Bold
  r = r.replace(/\*\*([^*]+)\*\*/g, (_, c) => C.bold + c + C.reset + fb);
  // Strikethrough
  r = r.replace(/~~([^~]+)~~/g, (_, c) => '\x1b[9m' + c + '\x1b[29m');
  // Italic
  r = r.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, (_, pre, c) => pre + '\x1b[3m' + c + '\x1b[23m');
  // Links: [text](url) -> text (cyan); autolink bare http(s) urls
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt) => col(txt, C.cyan) + fb);
  r = r.replace(/(^|\s)(https?:\/\/[^\s]+)/g, (_, pre, url) => pre + col(url, C.cyan));
  return r;
}

// Flatten chat buffer into visible colored lines.
// Render the chat to display lines. Each message caches its rendered rows keyed
// by (text, width, expanded) so streaming — which only changes the LAST message
// — does not re-wrap the entire transcript on every frame. Same idea as kimi's
// per-component render cache; it is what lets high-throughput models stream
// without the UI burning CPU re-rendering old messages.
// ---- Codewhale-style rendering ----
// Each transcript line is a Line: { spans: [ {content, color}, ... ] }.
// Selection is applied to the SPANS INSIDE each line; the number of lines
// never changes. This keeps scrollbar `total` and the mouse lineIdx mapping
// stable (the previous one-span-per-line splice model renumbered lines and
// desynchronised both).

function span(text, color) { return { content: text, color: '' + (color || '') }; }

// Merge the selection background into a span's colour string. Codewhale uses
// Ratatui's `Style::patch` which COMPOSES background + existing foreground
// rather than replacing the foreground. We prepend the selection background
// and preserve whatever foreground the span already carries.
function selStyled(color) { return C.selBg + (color || ''); }

// Apply a selection range to one line's spans (Codewhale apply_selection_to_line).
// Returns a NEW array of spans; the caller replaces the line's spans. `col_start`
// and `col_end` are in visual columns; `usize::MAX` = Infinity for the tail.


// Convert a single messageLines row into a Line ({spans:[...]}).
function rowToLine(r) {
  const ind = r.ind || '';
  const body = r.text || '';
  // If raw, text already has ANSI codes; otherwise apply color.
  // `indColor` colours only the indent/marker, so a user row can show a cyan
  // `❯` with white message text.
  if (r.raw) return ind + body;
  if (r.indColor && ind) {
    const tail = r.color ? (r.color + body + C.reset) : body;
    return r.indColor + ind + C.reset + tail;
  }
  const text = ind + body;
  if (r.color) return r.color + text + C.reset;
  return text;
}

// Pull the string values that are ALREADY complete out of a partially streamed
// JSON argument blob, so a tool row can render its key argument while the model
// is still emitting it. Only complete `"key":"value"` pairs are returned.
function extractPartialArgs(raw, prev) {
  const out = { ...(prev || {}) };
  const s = String(raw || '');
  const re = /"([A-Za-z_][\w-]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const val = m[2]
      .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    out[key] = val;
  }
  return out;
}

function renderChatLines(state, w) {
  const out = [];
  const expanded = !!state.expanded;
  // One blank column on the left of the whole transcript, so the markers (❯, ●,
  // ↳) do not sit flush against the screen edge.
  const PAD = ' ';
  const padW = visualCol(PAD);
  const innerW = Math.max(1, w - padW);
  for (const msg of state.chat) {
    // A `user` / `queued` message is drawn inside a COMPOSER-STYLE BOX: rounded
    // corners with `─`, and a `│` down each side — so a sent prompt looks exactly
    // like the input box it was typed into.
    // `steer` gets NO box: it is injected into the turn already in progress, so a
    // box would falsely suggest a separate turn had started.
    const bordered = msg.role === 'user' || msg.role === 'queued';
    // The box spans one column less than the full inner width, so the right edge
    // has a 1-column margin (matching the left margin from `PAD`).
    const boxW = innerW - 2;                   // total box width, including both │
    const boxInner = Math.max(1, boxW - 2);    // span the two │s occupy
    // One column of padding inside each wall, mirroring the composer box.
    const boxPad = Math.min(1, Math.max(0, boxInner - 1));
    const boxText = Math.max(1, boxInner - boxPad * 2);
    const topRule = PAD + col('╭' + '─'.repeat(boxInner) + '╮', C.border);
    const botRule = PAD + col('╰' + '─'.repeat(boxInner) + '╯', C.border);
    // A box always needs its TOP border — including when the message is the first
    // row of the transcript. (The earlier `out.length > 0` guard came from the
    // rule-only version, where a leading divider looked wrong; a box without a
    // top is simply broken.) For adjacent bordered messages the previous box's
    // bottom already serves as this one's top, so skip the duplicate.
    if (bordered && out[out.length - 1] !== topRule) out.push(topRule);
    // The cache key MUST include everything messageLines() reads. toolArgs was
    // missing, so a tool row rendered at `tool_start` (args still {}) kept its
    // stale "Using Bash" line even after `tool_use` delivered the command —
    // the row only appeared once some OTHER keyed field changed. liveOutput is
    // keyed because it grows while a command runs; `failed` flips the bullet
    // and the result colour red once the tool reports a non-zero exit.
    // The row WIDTH is keyed (not `w`) because the rows are laid out to it:
    // `boxText` for a bordered message (inside the box padding), `innerW` otherwise.
    const rowW = bordered ? boxText : innerW;
    const key = `${rowW}\u0000${expanded ? 1 : 0}\u0000${msg.pending ? 1 : 0}\u0000${msg.text || ''}\u0000${msg.streamContent || ''}`
      + `\u0000${msg.liveOutput ? msg.liveOutput.length : 0}\u0000${msg.failed ? 1 : 0}\u0000${JSON.stringify(msg.toolArgs || null)}`;
    let cached = msg._cache;
    if (!cached || cached.key !== key) {
      const rows = messageLines(msg, rowW, state.cwd, expanded);
      cached = { key, rows: rows.map(rowToLine) };
      msg._cache = cached;
    }
    // The margin is added here (outside the cache) so it is not baked into the
    // cached rows. A bordered message also gets its side walls, laid out to the
    // box's inner width so it lines up with the composer exactly.
    if (bordered) {
      const pad = ' '.repeat(boxPad);
      for (const r of cached.rows) {
        out.push(PAD + col('│', C.border) + pad + fitAnsi(r, boxText) + pad + col('│', C.border));
      }
    } else {
      for (const r of cached.rows) out.push(PAD + r);
    }
    if (bordered && out[out.length - 1] !== botRule) out.push(botRule);
  }
  return out;
}

// Serialise a Line (array of spans) to an ANSI string.
function lineToString(line) {
  let s = '';
  for (const sp of line.spans) {
    // Emit the span's colour prefix, then the content, then RESET so a
    // selection background (which carries no fg) cannot bleed into the next
    // span. Omitting the reset made a single-span line's selection highlight
    // run all the way to the right edge.
    s += sp.color + sp.content + C.reset;
  }
  return s;
}

function modeLabel(mode) {
  if (mode === 'auto') return 'Never Ask';
  if (mode === 'yolo') return 'Ask When Needed';
  return 'Ask';
}
function trimDecimal(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Token counts use 1024-based units: context sizes are powers of two, so
// 262144 reads as "256k", not "262.1k". k values at or above 100 are rounded
// to whole numbers ("977k").
function fmtTokens(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1024 * 1024 * 1024) return trimDecimal(n / (1024 * 1024 * 1024)) + 'G';
  if (n >= 1024 * 1024) return trimDecimal(n / (1024 * 1024)) + 'M';
  if (n >= 1024) {
    const k = n / 1024;
    return (k >= 100 ? Math.round(k) : trimDecimal(k)) + 'k';
  }
  return String(n);
}

// Usage as a whole-number percentage of `max`, ceiled so any non-zero usage
// shows at least 1%, clamped to [0, 100]. A non-positive or non-finite `max`
// reports 0.
function usagePercent(used, max) {
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((used / max) * 100)));
}

// Human-readable elapsed duration, omitting zero leading units:
// 1year 1mon 1day 1hour 1min 1s / 2years 2mons 2days 2hours 2mins 2s
function fmtDuration(ms) {
  ms = Math.max(0, Math.floor(ms));
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / 60000) % 60;
  const hour = Math.floor(ms / 3600000) % 24;
  const day = Math.floor(ms / 86400000) % 30;
  const mon = Math.floor(ms / 2592000000) % 12;
  const year = Math.floor(ms / 31536000000);
  const parts = [];
  if (year) parts.push(year + 'year' + (year > 1 ? 's' : ''));
  if (mon) parts.push(mon + 'mon' + (mon > 1 ? 's' : '') + ' ');
  if (day) parts.push(day + 'day' + (day > 1 ? 's' : '') + ' ');
  if (hour) parts.push(hour + 'hour' + (hour > 1 ? 's' : '') + ' ');
  if (min) parts.push(min + 'min' + (min > 1 ? 's' : '') + ' ');
  // Seconds are always shown (at least "0s").
  parts.push(sec + 's');
  return parts.join('');
}

// Left/right justify: left text, then padding, then right text flush to `w`.
// ANSI codes are ignored for width so colored segments still align exactly.
// When both don't fit, the LEFT is preserved and the RIGHT (tip) is truncated.
function justify(left, right, w) {
  const lw = visualCol(left);
  const rw = visualCol(right);
  if (left && right) {
    if (lw + rw + 1 <= w) return left + ' '.repeat(w - lw - rw) + right;
    const room = w - lw - 1;
    if (room > 0) return left + ' ' + fitAnsi(right, room);
    return fitAnsi(left, w);
  }
  if (!left) return ' '.repeat(Math.max(0, w - rw)) + right;
  if (!right) return left + ' '.repeat(Math.max(0, w - lw));
  return fitAnsi(left, w);
}

// Height of the composer box (top border + content rows + bottom border).
export function composerHeight(state, cols) {
  const insideW = Math.max(0, (cols | 0) - 2);
  return composerLayout(state, insideW - 3).rows.length + 2;
}

// ---- scrollbar (Codewhale's TranscriptScrollbar) ---------------------------
// Geometry for a vertical scrollbar over the transcript body. `scroll` is the
// number of lines scrolled UP from the bottom (0 = pinned to newest). Returns
// the thumb's row range within the body (0-based) so the painter and the mouse
// hit-test share one source of truth.
export function scrollbarGeometry({ total, bodyH, scroll }) {
  const maxScroll = Math.max(0, total - bodyH);
  const pos = Math.min(maxScroll, Math.max(0, scroll || 0));
  // Thumb length proportional to the visible fraction, at least 1 row.
  const thumb = Math.max(1, Math.round(bodyH * (bodyH / Math.max(1, total))));
  // 0 = bottom (pinned), maxScroll = top. Row 0 is the TOP of the body.
  const fromTop = maxScroll === 0 ? 0 : (maxScroll - pos) / maxScroll;
  const maxThumbStart = Math.max(0, bodyH - thumb);
  const thumbStart = Math.round(fromTop * maxThumbStart);
  return { thumbStart, thumbLen: thumb, bodyH, total, maxScroll };
}

// Paint the scrollbar glyph into the LAST column of a body row. The row already
// has exactly `w` visible columns; we replace the final one with the gutter.

// ---- mouse text selection (Codewhale-style: modify object properties, not strings) ---
// Apply selection background by modifying the color property of line objects,
// not by adding ANSI codes to strings. This preserves existing ANSI structure.
function applySelectionToRow(lines, idx, sel, w) {
  if (idx < 0) return lines;
  const a = sel.anchor, h = sel.head;
  if (!a || !h) return lines;
  const start = (h.row < a.row || (h.row === a.row && h.col < a.col)) ? h : a;
  const end = start === a ? h : a;
  if (idx < start.row || idx > end.row) return lines;
  
  let c0, c1;
  if (start.row === end.row) { 
    c0 = start.col; 
    c1 = end.col; 
  }
  else if (idx === start.row) { 
    c0 = start.col; 
    c1 = Infinity; 
  }
  else if (idx === end.row) { 
    c0 = 0; 
    c1 = end.col; 
  }
  else { 
    c0 = 0; 
    c1 = Infinity; 
  }
  
  // Apply selection background to each line object in the array
  for (const lineObj of lines) {
    // Calculate visual column position for this line object
    let col = 0;
    const text = lineObj.text || '';
    
    // Check if this line object overlaps with selection
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const cw = visualWidth(ch);
      
      if (col >= c0 && col < c1) {
        // Apply selection background by setting color property
        // If already has color, merge with selection bg
        if (lineObj.color) {
          // Merge colors: keep original foreground, add selection background
          lineObj.color = C.selBg + lineObj.color;
        } else {
          lineObj.color = C.selBg;
        }
      }
      
      col += cw;
      i += cp > 0xffff ? 2 : 1;
      
      if (col >= w) break;
    }
  }
  
  return lines;
}

// Wrap the visible columns [c0, c1) of an ANSI string in the selection
// background, preserving the existing foreground colours inside the range.
// NOTE: pass (end.col + 1) as c1 — the end column is the cell under the pointer
// and is part of the selection.
function highlightAnsiRange(row, c0, c1, w) {
  const s = String(row);
  let out = '';
  let col = 0;
  let i = 0;
  let inSel = false;

  while (i < s.length) {
    if (s[i] === '\x1b') {
      // Emit the escape, then RE-ASSERT the selection background if we are
      // inside the range. The row embeds its own resets (a markdown bold or
      // inline-code span ends in ESC[0m), and a bare ESC[0m cancels the
      // background too — so without re-asserting, everything after the first
      // coloured run inside the selection lost its highlight.
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(s.slice(i)) || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        if (inSel) out += C.selBg;
        i += m[0].length;
        continue;
      }
    }

    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    const want = col >= c0 && col < c1;

    if (want && !inSel) {
      out += C.selBg;
      inSel = true;
    } else if (!want && inSel) {
      out += C.reset;
      inSel = false;
    }

    out += ch;
    col += cw;
    i += cp > 0xffff ? 2 : 1;

    if (col >= w) break;
  }

  if (inSel) out += C.reset;

  return out;
}

// Truncate an ANSI string to exactly `width` visible columns (no padding).
function sliceAnsi(s, width) {
  const str = String(s);
  if (width <= 0) return '';
  let out = '';
  let col = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(str.slice(i)) || /^\x1b\[[0-9;?]* [a-zA-Z]/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = visualWidth(ch);
    if (col + cw > width) break;
    out += ch;
    col += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return out + (out.includes('\x1b') ? C.reset : '');
}

// ---- pure frame composer (no TTY side effects) ----
// kimi-code-cli layout: NO top chrome. Top-to-bottom it is:
//   chat (fills the top) / composer box / [command menu] / status line /
//   [Ctrl-C confirm] / context line (very last screen row).
// Returns { ansi, cursor: {row, col} } with 0-based coords.
export function composeFrame(state, cols, rows) {
  const w = Math.max(20, cols | 0);
  const h = Math.max(12, rows | 0);
  const insideW = Math.max(0, w - 2);

  const dialog = state.picker || state.form || state.panel || null;

  // ---- geometry ----
  const composer = composerLayout(state, insideW - 3); // bodyW = (insideW-3)-2 = 53, matches fitAnsi(textW-2) = cInner-4 = 53
  const composerBoxH = dialog ? 0 : composer.rows.length + 2;
  const menuItems = (state.menuOpen && state.menuList.length && !dialog)
    ? Math.min(state.menuList.length, MAX_MENU) + 1
    : 0;
  const noticeH = state.notice ? 1 : 0;
  const confirmH = state.confirmExit ? 1 : 0;
  const workingH = (!dialog && state.running) ? 1 : 0;
  const todoH = dialog ? 0 : todoPanelHeight(state);
  const queueH = dialog ? 0 : queuePanelHeight(state);
  const bottomH = todoH + queueH + workingH + composerBoxH + menuItems + STATUS_H + noticeH + confirmH + CTX_H;
  const bodyH = Math.max(1, h - bottomH);

  const lines = [];
  let dialogCaret = null;
  const hits = [];
  const addHit = (row, col0, col1, hit) => hits.push({ row, col0, col1, ...hit });

  if (state.editor) {
    // A simple modal multiline editor: the text, a caret we draw ourselves, and a
    // key hint. Ctrl+S saves, Esc cancels. The view follows the caret.
    const ed = state.editor;
    const rule = col('─'.repeat(w), C.border);
    const textLines = ed.text.split('\n');
    lines.push(col(ed.title || 'Edit', C.cyan + C.bold));
    lines.push(rule);
    const hint = ed.hint || 'Ctrl+S save · Esc cancel · Enter newline';
    lines.push(col(hint, C.gray));
    lines.push('');
    // Viewport height for the editor body
    const viewH = Math.max(1, bodyH - (ed.notice ? 6 : 5));
    // Keep the caret row in view.
    let top = Math.max(0, ed.top || 0);
    if (ed.caretRow < top) top = ed.caretRow;
    if (ed.caretRow >= top + viewH) top = ed.caretRow - viewH + 1;
    ed.top = top;
    for (let i = 0; i < viewH; i++) {
      const idx = top + i;
      const txt = idx < textLines.length ? expandTabs(textLines[idx]) : '';
      lines.push(col(fitAnsi(txt, w), C.white));
      // Mouse click on this body row moves the caret to that line.
      addHit(lines.length - 1, 0, w - 1, { kind: 'editor', row: idx });
    }
    lines.push(col(fitAnsi(`  line ${ed.caretRow + 1}/${textLines.length} · ${textLines.length} lines`, w), C.gray));
    if (ed.notice) lines.push(col(fitAnsi('  ' + ed.notice, w), ed.noticeKind === 'error' ? C.red : C.green));
    lines.push(rule);
    // Caret position = caret column within the visible window.
    dialogCaret = {
      row: 3 + Math.max(0, Math.min(viewH - 1, ed.caretRow - top)),
      col: Math.min(w - 1, visualCol(expandTabs(textLines[ed.caretRow] || '').slice(0, ed.caretCol))),
    };
    while (lines.length < bodyH) lines.push(' '.repeat(w));
  } else if (state.panel) {
    const p = state.panel;
    const rule = col('─'.repeat(w), C.border);
    const bodyLines = p.lines || [];
    const viewH = Math.max(1, bodyH - 5);
    const maxTop = Math.max(0, bodyLines.length - viewH);
    const top = Math.min(maxTop, Math.max(0, p.top || 0));
    lines.push(col(p.title || '', C.cyan + C.bold));
    lines.push(rule);
    for (let i = 0; i < viewH; i++) {
      const idx = top + i;
      lines.push(col(fitAnsi(idx < bodyLines.length ? bodyLines[idx] : '', w), C.white));
    }
    const up = top > 0 ? '▲' : ' ';
    const down = top + viewH < bodyLines.length ? `▼ ${bodyLines.length - top - viewH} more` : '';
    lines.push(col(fitAnsi(`  ${up} ${down}`, w), C.gray));
    lines.push(col('Esc close · ↑/↓ scroll', C.gray));
    lines.push(rule);
    while (lines.length < bodyH) lines.push(' '.repeat(w));
  } else if (state.form) {
    const f = state.form;
    const rule = col('─'.repeat(w), C.border);
    const fields = f.fields || [];
    const body = [col(f.title || '', C.cyan + C.bold), rule, ''];
    const fieldBodyRows = [];
    fields.forEach((field, i) => {
      const active = i === f.fieldIdx;
      const label = col((field.label + ':').padEnd(f.labelW + 1), active ? C.cyan : C.gray);
      const shown = active ? renderFieldValue(field, true) : renderFieldValue(field, false);
      fieldBodyRows.push(body.length);
      body.push(label + shown);
      if (i === f.fieldIdx) dialogCaret = { row: body.length - 1, col: visualCol(label) + fieldCaretCol(field, active) };
    });
    let typeBodyRow = -1;
    let typeOpts = [];
    if (!f.hideType) {
      body.push('');
      const types = ['OpenAI', 'Anthropic'];
      const typeActive = f.fieldIdx === fields.length;
      const labelW = visualCol('Type:'.padEnd(f.labelW + 1));
      let colCursor = labelW;
      typeOpts = types.map((t) => {
        const brick = (typeActive ? '❯ ' : '  ') + t;
        const cw = visualCol(brick);
        const rec = { opt: t, colStart: colCursor, colEnd: colCursor + cw };
        colCursor += cw + 2;
        return rec;
      });
      const typeStr = types.map((t) => t === f.type
        ? col((typeActive ? '❯ ' : '  ') + t, typeActive ? (C.cyan + C.bold) : C.cyan)
        : col('  ' + t, C.gray)).join('  ');
      const typeLabel = col('Type:'.padEnd(f.labelW + 1), typeActive ? C.cyan : C.gray);
      const typeHint = f.type ? '' : col('  ← choose', C.yellow);
      body.push(typeLabel + typeStr + typeHint);
      typeBodyRow = body.length - 1;
    }
    body.push('');
    body.push(col(f.hint || 'Tab next field · Enter submit · Esc cancel', C.gray));
    body.push(rule);
    const padTop = Math.max(0, Math.floor((bodyH - body.length) / 2));
    fieldBodyRows.forEach((bi, i) => addHit(padTop + bi, 0, w - 1, { kind: 'formField', index: i }));
    if (typeBodyRow >= 0) {
      typeOpts.forEach((rec) => addHit(padTop + typeBodyRow, rec.colStart, rec.colEnd, { kind: 'formType', option: rec.opt }));
    }
    for (let i = 0; i < padTop; i++) lines.push(' '.repeat(w));
    for (const b of body) lines.push(b);
    while (lines.length < bodyH) lines.push(' '.repeat(w));
    if (dialogCaret) dialogCaret.row += padTop;
  } else if (state.picker) {
    const pick = state.picker;
    const query = state.pickerQuery || '';
    const list = pickerFiltered(state);
    const selIdx = Math.max(0, Math.min(list.length - 1, pick.sel || 0));
    const rule = col('─'.repeat(w), C.border);
    const titleSuffix = pick.searchable === false ? '' : ' (type to search)';
    const hintText = pick.hint || '↑↓ navigate · Enter select · Esc cancel';
    const body = [
      col(pick.title || '', C.cyan + C.bold) + col(titleSuffix, C.gray),
      rule,
      col(hintText, C.gray),
      '',
    ];
    if (pick.searchable !== false) {
      body.push(col('Search: ', C.gray) + col(query, C.white));
      if (query) {
        dialogCaret = { row: body.length - 1, col: visualCol('Search: ') + visualCol(query) };
      }
    }
    // Category tabs (if the picker defines them): "All" + provider categories.
    if (pick.categories && pick.categories.length > 1) {
      const cats = pick.categories;
      const active = state.pickerCategory || cats[0];
      const allItems = state.picker.items || [];
      let catLine = col('Categories: ', C.gray);
      for (let ci = 0; ci < cats.length; ci++) {
        const label = cats[ci];
        const active_ = label === active;
        // Count items in this category (for the tab label).
        let cnt;
        if (label === cats[0]) {
          cnt = allItems.filter((it) => !it.action).length; // "All" = all non-action items
        } else {
          cnt = allItems.filter((it) => it.category === label).length;
        }
        const seg = active_
          ? col(`[${label} (${cnt})]`, C.cyan + C.bold)
          : col(` ${label} (${cnt}) `, C.gray);
        catLine += seg;
      }
      body.push(catLine);
    }
    // Overhead: header rows (body.length) + trailing empty + rule + optional "more" line + optional footer (empty + footer row).
    const footerRows = pick.footer ? 2 : 0;
    const overhead = body.length + footerRows + 2; // +2 for trailing empty line and rule
    const maxItems = Math.max(1, Math.min(MAX_PICKER, bodyH - overhead - 1)); // -1 reserved for potential "more" line
    let first = Math.max(0, selIdx - Math.floor((maxItems - 1) / 2));
    if (first + maxItems > list.length) first = Math.max(0, list.length - maxItems);
    const shown = list.slice(first, first + maxItems);
    const itemBodyRows = [];
    shown.forEach((item, j) => {
      const idx = first + j;
      const isSel = idx === selIdx;
      const ptr = isSel ? col('❯ ', C.cyan) : '  ';
      const label = col(String(item.label), isSel ? (C.cyan + C.bold) : C.white);
      const sub = item.sub != null && item.sub !== '' ? col('  ' + String(item.sub), C.gray) : '';
      const cur = item.current ? col('  ← current', C.green) : '';
      itemBodyRows.push(body.length);
      body.push(col(fitAnsi(ptr + label + sub, w - visualCol(cur)), C.white) + cur);
    });
    if (list.length > maxItems) body.push(col(`▼ ${list.length - (first + shown.length)} more`, C.gray));
    let footerBodyRow = -1;
    let footerOpts = [];
    if (pick.footer) {
      const f = pick.footer;
      body.push('');
      const label = col(`${f.label || 'Thinking'}:  `, C.gray);
      const labelW = visualCol(`${f.label || 'Thinking'}:  `);
      let colCursor = labelW;
      const bricks = (f.options || []).map((o) => {
        const brick = f.focused
          ? (o === f.value ? `[ ${o} ]` : ` ${o} `)
          : ` ${o} `;
        const cw = visualCol(brick);
        footerOpts.push({ opt: o, colStart: colCursor, colEnd: colCursor + cw });
        colCursor += cw + 1;
        return o === f.value ? col(brick, C.cyan + C.bold) : col(brick, C.gray);
      }).join(' ');
      const row = label + bricks + (f.focused && !f.value ? col('  ← choose', C.yellow) : '');
      body.push(row);
      footerBodyRow = body.length - 1;
      if (f.focused) {
        dialogCaret = { row: body.length - 1, col: visualCol(label) + 1 };
      }
    }
    body.push('');
    body.push(rule);
    const padTop = Math.max(0, Math.floor((bodyH - body.length) / 2));
    itemBodyRows.forEach((bi, j) => {
      addHit(padTop + bi, 0, w - 1, { kind: 'pickerItem', index: first + j });
    });
    if (footerBodyRow >= 0) {
      footerOpts.forEach((rec) => {
        addHit(padTop + footerBodyRow, rec.colStart, rec.colEnd, { kind: 'pickerFooterOpt', option: rec.opt });
      });
    }
    for (let i = 0; i < padTop; i++) lines.push(' '.repeat(w));
    for (const b of body) lines.push(b);
    while (lines.length < bodyH) lines.push(' '.repeat(w));
    if (dialogCaret) dialogCaret.row += padTop;
  } else {
    const chat = renderChatLines(state, w);
    if (state.selection && state.selection.anchor && state.selection.head) {
      // Apply selection highlight directly on ANSI strings
      for (let i = 0; i < chat.length; i++) {
        const a = state.selection.anchor, h = state.selection.head;
        if (!Number.isFinite(a.row) || !Number.isFinite(h.row)) { /* no range */ }
        else {
        const startIdx = (h.row < a.row || (h.row === a.row && h.col < a.col)) ? h : a;
        const endIdx = startIdx === a ? h : a;
        if (i < startIdx.row || i > endIdx.row) continue;
        let c0, c1;
        // +1: the end column is the cell under the pointer and is selected too.
        if (startIdx.row === endIdx.row) { c0 = startIdx.col; c1 = endIdx.col + 1; }
        else if (i === startIdx.row) { c0 = startIdx.col; c1 = Infinity; }
        else if (i === endIdx.row) { c0 = 0; c1 = endIdx.col + 1; }
        else { c0 = 0; c1 = Infinity; }
        chat[i] = highlightAnsiRange(chat[i], c0, c1, cols);
        }
      }
    }
    if (process.env.HNCODE_DEBUG && state.selection) {
      const _a = state.selection.anchor, _h = state.selection.head;
      const _s = (_h.row < _a.row || (_h.row === _a.row && _h.col < _a.col)) ? _h : _a;
      const _e = _s === _a ? _h : _a;
    }
    const total = chat.length;
    const maxScroll = Math.max(0, total - bodyH);
    const scroll = Math.min(maxScroll, Math.max(0, state.scroll || 0));
    const start = total <= bodyH ? -(bodyH - total) : total - bodyH - scroll;
    const showBar = total > bodyH && w > 4;
    const sb = showBar ? scrollbarGeometry({ total, bodyH, scroll }) : null;

    for (let i = 0; i < bodyH; i++) {
      const idx = start + i;
      let row = '';
      if (idx >= 0 && idx < total) {
        row = chat[idx] || '';
      }
      if (sb) {
        const inThumb = i >= sb.thumbStart && i < sb.thumbStart + sb.thumbLen;
        let thumbColor = C.scrollThumb;
        if (state.sbDrag) thumbColor = C.scrollThumbActive;
        else if (state.sbHover) thumbColor = C.scrollThumbHover;
        const glyph = inThumb ? col('┃', thumbColor) : col('│', C.scrollTrack);
        row = fitAnsi(row, w - 1) + glyph;
      }
      lines.push(row);
    }
    state._sb = sb;
    state._bodyTop = start;
    state._bodyH = bodyH;
    // How many blank padding rows precede the first body row on screen. When
    // the transcript is shorter than the body, `start` is negative and those
    // rows are padding; a click there must NOT map to a transcript line.
    state._bodyPadTop = Math.max(0, -start);
  }

  if (workingH) {
    const frame = SPINNER[(state.spin || 0) % SPINNER.length];
    const elapsed = state.turnStart ? ` ${col('[' + fmtDuration(Date.now() - state.turnStart) + ']', C.gray)}` : '';
    // The wording was chosen once at turn start; the gradient below loops
    // independently, so the phrase stays put while the colours sweep.
    const workMsg = state.workMsg || WORKING_MESSAGES[0];
    const spin = state.spin || 0;

    // ---- turn-finish animation ----
    // 0.5s morph: `[turn took 1s]` grows in from the LEFT, covering the working
    // phrase one character at a time; once the phrase is fully covered, the
    // rest of the final text is simply appended. The whole row fades to grey.
    if (state.finishAnim) {
      const DUR = 500;
      const t = Math.min(1, (Date.now() - state.finishAnim.start) / DUR);
      const wordFrom = state.finishAnim.wordFrom || '';
      const wordTo = state.finishAnim.wordTo || 'turn took';
      const tail = state.finishAnim.tail || '';   // ` <duration>]`, never changes
      // SWEEP: start from the LIVE word (`Working...`), pad it on the right to
      // the wider of the two words, then overwrite it left → right, one
      // character per step. Characters the sweep has not reached keep their OLD
      // value, so each `.` disappears on its own turn:
      //   [Working... 59s] → [turn to... 59s] → [turn too.. 59s] → [turn took 59s]
      // Width = the LONGER word, otherwise a longer old word gets truncated and
      // its trailing dots vanish at once.
      const width = Math.max(wordFrom.length, wordTo.length);
      const from = wordFrom.padEnd(width, '.');
      const toPadded = wordTo.padEnd(width, '');
      const done = t >= 1 ? width : Math.floor(t * width);   // chars overwritten so far
      let word = '';
      for (let i = 0; i < width; i++) {
        word += (i < done) ? (toPadded[i] || '') : from[i];
      }
      // Colour: orange → grey over the animation.
      const ORANGE = [255, 140, 0];
      const GREY   = [150, 150, 150];
      const r = Math.round(ORANGE[0] + (GREY[0] - ORANGE[0]) * t);
      const g = Math.round(ORANGE[1] + (GREY[1] - ORANGE[1]) * t);
      const b = Math.round(ORANGE[2] + (GREY[2] - ORANGE[2]) * t);
      const animColor = lerpColor(r, g, b, r, g, b, 0);
      lines.push(col(frame, animColor) + ' ' + col(`[${word}${tail}`, animColor));
    } else {

      // Timing (spinner ticks every 80ms, so 0.5s ≈ 6 ticks):
    //   0.5s yellow sweep (each char fades orange → yellow, left to right)
    //   0.5s fade back   (each char fades yellow → orange, left to right)
    //   0.5s red sweep   (each char fades orange → red, left to right)
    //   0.5s fade back   (each char fades red → orange, left to right)
    // → loops straight back to the yellow sweep. ~2s per full cycle.
    const SWEEP = 6;                 // 0.5s
    const HALF  = SWEEP + SWEEP;     // 12 ticks per colour (sweep + sweep back)
    const CYCLE = HALF * 2;          // 24 ticks for the full loop (~2s)
    const inCycle = spin % CYCLE;
    const inHalf  = inCycle % HALF;       // 0..23 within this colour's half
    const phase   = inCycle < HALF ? 0 : 1; // 0 = yellow, 1 = red

    // Colours as plain RGB triples (never ANSI strings).
    const ORANGE = [255, 140, 0];
    const YELLOW = [255, 240, 120];
    const RED    = [255, 0, 0];    // pure red
    const target = phase === 0 ? YELLOW : RED;

    const chars = workMsg;
    const n = chars.length;

    // A character fades over a band this many characters wide. BAND = 1/n made
    // the band exactly one char, so at this sweep speed (n/6 chars per tick) a
    // char crossed it inside a single frame — i.e. it snapped instead of fading.
    // A 3-char band gives each char ~3 frames of visible gradient.
    const BAND_CHARS = Math.max(2, Math.min(4, n / 3));
    const BAND = BAND_CHARS / n;

    // Interpolate orange ↔ target by `t` (0 = orange, 1 = target).
    const mix = (t) => {
      const k = Math.max(0, Math.min(1, t));
      return lerpColor(
          ORANGE[0] + (target[0] - ORANGE[0]) * k,
          ORANGE[1] + (target[1] - ORANGE[1]) * k,
          ORANGE[2] + (target[2] - ORANGE[2]) * k,
          ORANGE[0] + (target[0] - ORANGE[0]) * k,
          ORANGE[1] + (target[1] - ORANGE[1]) * k,
          ORANGE[2] + (target[2] - ORANGE[2]) * k,
          0,
      );
    };

    const out = [];
    for (let i = 0; i < n; i++) {
      const charAt = n > 0 ? i / n : 0;
      let t; // 0 = orange, 1 = target colour
      if (inHalf < SWEEP) {
        // Sweep in: orange → target colour, left to right.
        // `head` must reach 1 (not (SWEEP-1)/SWEEP) or the last char,
        // at (n-1)/n, is never swept.
        const head = (inHalf + 1) / SWEEP;   // 1/SWEEP … 1
        t = (head - charAt) / BAND;
      } else {
        // Sweep back: target colour → orange, left to right.
        const head = (inHalf - SWEEP + 1) / SWEEP;  // 1/SWEEP … 1
        t = 1 - (head - charAt) / BAND;
      }
      out.push(col(chars[i], mix(t)));
    }
      lines.push(col(frame, C.orange) + ' ' + out.join('') + elapsed);
    }
  }

  if (state.todos && state.todos.length) {
    // The panel's top rule is a DRAG HANDLE. Record its screen row as a hitbox so
    // the mouse handler can hover/press it; the row offset is corrected to final
    // screen coordinates by composeFrame's hitbox pass (like every other hit).
    const todoTopRow = lines.length;
    addHit(todoTopRow, 0, w - 1, { kind: 'todoResize' });
    for (const l of renderTodoPanel(state, w, state.todoResizeHover, state.todoResizeDrag)) lines.push(l);
  }

  // Queued (not yet sent) messages, directly above the composer: these are what
  // Ctrl-S steers into the running turn. See renderQueuePanel.
  for (const l of renderQueuePanel(state, w)) lines.push(l);

    // Approval pending overlay - same width as the composer, placed above it.
  // The border characters are coloured INDIVIDUALLY and each content row is
  // padded to an exact inner width: colouring the whole row (as this used to)
  // also wrapped the padding in the border colour and left the right `│`
  // white and drifting inside the box next to the text.
  if (state.approvalPending && !dialog) {
    const ap = state.approvalPending;
    const promptW = insideW;
    // Content span: promptW - 2 leaves one padding space on each side, so the
    // row is exactly 1 + 1 + (promptW - 2) + 1 + 1 = promptW + 2 wide — the same
    // as the composer. Using promptW - 4 made the box 2 columns too narrow and
    // fitAnsi pushed the right border inward.
    const innerW = Math.max(1, promptW - 2);
    const bar = (ch) => col(ch, C.border);
    const boxRow = (content) => bar('│') + ' ' + fitAnsi(content, innerW) + ' ' + bar('│');
    const verb = col('Approve', C.white + C.bold);
    const cmd = col(ap.toolName + '?', C.cyan + C.bold);
    lines.push(bar('╭' + '─'.repeat(promptW) + '╮'));
    lines.push(boxRow(verb + ' ' + cmd));
    if (Array.isArray(ap.detail) && ap.detail.length) {
      for (const ln of ap.detail) {
        // Wrap by DISPLAY width so a wide/CJK glyph cannot push the border out.
        for (const seg of wrapWords(ln === '' ? ' ' : ln, innerW)) {
          lines.push(boxRow(col(seg, C.gray)));
        }
      }
    } else if (ap.desc) {
      for (const seg of wrapWords(ap.desc, innerW)) lines.push(boxRow(col(seg, C.gray)));
    }
    lines.push(boxRow(col('Enter to approve | Esc to reject', C.gray)));
    lines.push(bar('╰' + '─'.repeat(promptW) + '╯'));
  }
  
  let composerFirstRow = -1;
  if (!dialog) {
    composerFirstRow = lines.length + 1;
    // The composer carries the same 1-column left margin as the transcript, so its
    // walls line up exactly with a sent user/queue message's box.
    //   frame width = 1 (margin) + 1 (│) + cInner + 1 (│)  =>  cInner = w - 3
    // `insideW` (w-2) is the space BETWEEN the walls, so the margin is taken OUT of
    // it rather than added on top — otherwise the box came out 2 columns short.
    const CPAD = ' ';
    const cInner = Math.max(1, insideW - 1);
    lines.push(CPAD + col('╭' + '─'.repeat(cInner) + '╮', C.border));
    for (let ri = 0; ri < composer.rows.length; ri++) {
      addHit(lines.length, 2, cInner, { kind: 'composerRow', rowIdx: ri });
      // Colour the prompt glyph like the transcript's user marker (cyan) and keep
      // the typed TEXT white. The prefix is the first `❯ ` of the row (the
      // continuation rows are padded with spaces instead).
      const rawRow = composer.rows[ri];
      const styledRow = highlightPasteMarkers(rawRow);
      // One space of padding after the left wall (and before the right wall), the
      // same as the transcript's user/queue boxes, so the geometry is identical.
      const pre = composerInput(state).prefix;
      const textW = Math.max(1, cInner - 2); // Original value: 1+1+textW+1+1 = 60 with pre=2, fitWidth=55
      // Apply composer text selection highlight if a selection is active.
      const sel = state.composerSel;
      const rowMeta = composer.meta[ri] || {};
      let rowAnsi;
      if (rawRow.startsWith(pre)) {
        const textPart = styledRow.slice(pre.length);
        const textStart = rowMeta.start != null ? rowMeta.start : 0;
        const highlighted = (sel && sel.anchor !== sel.head)
          ? highlightSelection(textPart, textStart, sel.anchor, sel.head)
          : textPart;
        rowAnsi = ' ' + col(pre, C.cyan) + C.white +
          fitAnsi(highlighted, Math.max(1, textW - visualCol(pre))) + ' ';
      } else {
        const textStart = rowMeta.start != null ? rowMeta.start : 0;
        const highlighted = (sel && sel.anchor !== sel.head)
          ? highlightSelection(styledRow, textStart, sel.anchor, sel.head)
          : styledRow;
        rowAnsi = ' ' + C.white + fitAnsi(highlighted, textW) + ' ';
      }
      lines.push(
        CPAD + col('│', C.cyan) + rowAnsi + C.reset + col('│', C.cyan)
      );
    }
    lines.push(CPAD + col('╰' + '─'.repeat(cInner) + '╯', C.border));
  }

  
  if (state.menuOpen && state.menuList.length && !dialog) {
    const totalMatches = state.menuList.length;
    const sel = state.menuSel + 1;
    const off = state.menuOffset || 0;
    const shown = state.menuList.slice(off, off + MAX_MENU);
    shown.forEach((cmd, j) => {
      const selected = off + j === state.menuSel;
      const mark = selected ? col('❯ ', C.cyan) : '  ';
      const nameField = col(cmd.name, selected ? (C.cyan + C.bold) : C.gray);
      const hint = cmd.argumentHint ? col(' ' + cmd.argumentHint, C.gray) : '';
      const pad = Math.max(2, 18 - visualCol(cmd.name) - visualCol(hint));
      const desc = col(cmd.desc, C.gray);
      addHit(lines.length, 1, insideW, { kind: 'menuItem', index: off + j });
      lines.push(col('│' + fitAnsi(mark + nameField + hint + ' '.repeat(pad) + desc, insideW) + '│', C.border));
    });
    lines.push(col('│' + fitAnsi(col(`(${sel}/${totalMatches})`, C.gray), insideW) + '│', C.border));
  }

  const cwd = state.cwd || '';
  const thinking = state.reasoning
    ? (state.effort && state.effort !== 'on' ? ` thinking: ${state.effort}` : ' thinking')
    : state.seenThinking ? ' thinking' : '';
  const label = state.modelLabel || state.model || '';
  const modeBadge = state.plan ? col('Plan', C.cyan + C.bold)
    : state.focus ? col('Focus', C.magenta + C.bold)
    : '';
  const parts = [];
  if (state.slMode !== false) parts.push(col(modeLabel(state.mode), C.yellow));
  if (modeBadge) parts.push(modeBadge);
  if (state.slModel !== false && label) {
    const think = state.slEffort !== false ? thinking : '';
    parts.push(col(`${label}${think}`, C.white));
  }
  if (state.slTasks !== false) {
    const ts = Object.values(state.tasks || {});
    const running = ts.filter((t) => t.status === 'running').length;
    const done = ts.length - running;
    if (ts.length) {
      parts.push(col(running ? `bg ${running}→${done}` : `bg ${done}`, running ? C.cyan : C.gray));
    }
  }
  if (state.slCwd !== false && cwd) parts.push(col(cwd, C.gray));
  const statusLeft = parts.join('  ');
  const statusRight = (state.slTips !== false && state.tip) ? col(state.tip, C.gray) : '';
  lines.push(justify(statusLeft, statusRight, w));

  if (noticeH) {
    const nc = state.noticeKind === 'error' ? C.red : C.gray;
    lines.push(col(fitAnsi('  ' + state.notice, w), nc));
  }

  if (confirmH) lines.push(col(fitAnsi('Press Ctrl+C again to exit the hncode', w), C.yellow));

  const ctxRight = `${state.rounds} turn${state.rounds === 1 ? '' : 's'} | ${state.steps} step${state.steps === 1 ? '' : 's'} | ${Math.round(state.tokRate)} tok/s | context: ${state.ctxPercent}% (${fmtTokens(state.ctxTokens || 0)}/${fmtTokens(state.ctxMax || 1)})`;
  const ctxW = visualCol(ctxRight);
  const ctxPad = Math.max(0, w - ctxW);
  lines.push(' '.repeat(ctxPad) + col(fitAnsi(ctxRight, Math.min(ctxW, w)), C.white));

  let topPad = 0;
  if (lines.length < h) { topPad = h - lines.length; }
  while (lines.length < h) lines.unshift(' '.repeat(w));
  let topTrim = 0;
  if (lines.length > h) { topTrim = lines.length - h; lines.splice(0, topTrim); }
  const hitboxes = hits
    .map((hb) => ({ ...hb, row: hb.row + topPad - topTrim }))
    .filter((hb) => hb.row >= 0 && hb.row < h);

  if (state.hoverHit) {
    const hv = state.hoverHit;
    if (hv.row >= 0 && hv.row < lines.length) {
      lines[hv.row] = tintRange(lines[hv.row], hv.col0, hv.col1);
    }
  }

  let cursor;
  let cursorVisible;
  if (dialogCaret) {
    cursor = { row: Math.min(dialogCaret.row, h - 1), col: Math.min(dialogCaret.col, w - 1) };
    cursorVisible = true;
  } else if (dialog) {
    cursor = { row: 0, col: 0 };
    cursorVisible = false;
  } else {
    const menuH = (state.menuOpen && state.menuList.length && !dialog)
      ? Math.min(state.menuList.length, MAX_MENU) + 1 : 0;
    const bottomChrome = STATUS_H + (state.notice ? 1 : 0) + (state.confirmExit ? 1 : 0) + CTX_H + menuH;
    const caretScreenRow = h - bottomChrome - 2 - (composer.rows.length - 1 - composer.caretRow);
    cursor = {
      row: Math.max(0, Math.min(caretScreenRow, h - 1)),
      col: Math.min(composer.caretCol + 2, w - 1),
    };
    cursorVisible = true;
  }

  const padded = lines.map((l) => fitAnsi(l, w));
  // Draw the block caret ourselves (composer OR dialog field / search box) and
  // keep the hardware cursor hidden for the whole session: the differential
  // painter writes full-width rows while scrolling, and the terminal parks its
  // own cursor at the end of the screen for a frame — which read as the caret
  // flickering between the input box and the bottom row.
  if (cursorVisible && cursor.row >= 0 && cursor.row < padded.length) {
    padded[cursor.row] = caretBlock(padded[cursor.row], cursor.col);
  }
  const cursorShape = hideCursor();

  const ansi = `\x1b[H` + padded.join('\n')
    + `\x1b[${cursor.row + 1};${cursor.col + 1}H` + cursorShape;
  return { ansi, lines: padded, cursor, cursorVisible, width: w, height: h,
           cursorRow: cursor.row, cursorCol: cursor.col, cursorShape, hitboxes, composerMeta: composer.meta };
}

// Differential paint: emit cursor-positioning + content for ONLY the rows whose
// content changed since `prev`. This is what keeps redraws flicker-free and
// cheap (kimi-code's pi-tui does the same). A full repaint happens on first
// paint and whenever the terminal size changes.
export function diffFrame(prev, next) {
  let shape = '';
  if (!prev || prev.cursorShape !== next.cursorShape) shape = next.cursorShape;
  const pos = `\x1b[${next.cursorRow + 1};${next.cursorCol + 1}H`;

  const sizeChanged = !prev || prev.width !== next.width || prev.height !== next.height;
  if (sizeChanged) {
    let out = '\x1b[?2026h';
    for (let i = 0; i < next.lines.length; i++) out += `\x1b[${i + 1};1H\x1b[2K` + next.lines[i];
    out += '\x1b[?2026l' + pos + shape;
    return out;
  }

  const maxLines = Math.max(prev.lines.length, next.lines.length);
  let first = -1, last = -1;
  for (let i = 0; i < maxLines; i++) {
    const a = i < prev.lines.length ? prev.lines[i] : '';
    const b = i < next.lines.length ? next.lines[i] : '';
    if (a !== b) { if (first === -1) first = i; last = i; }
  }
  if (first === -1) {
    return pos + shape;
  }

  let out = '\x1b[?2026h';
  // Only [first, last] changed; rewriting to the bottom of the screen made a
  // single appended line repaint the whole viewport every frame.
  const reach = Math.min(next.lines.length, last + 1);
  let pos2 = first;
  for (let i = first; i < reach; i++) {
    if (i === first) out += `\x1b[${first + 1};1H`;
    else out += '\r\n';
    out += '\x1b[2K' + next.lines[i];
    pos2 = i;
  }
  if (next.lines.length < prev.lines.length) {
    const extraStart = next.lines.length;
    const extraEnd = Math.max(extraStart, prev.lines.length);
    if (pos2 < extraStart - 1) out += '\r\n'.repeat(extraStart - 1 - pos2);
    else if (pos2 > extraStart - 1) out += `\x1b[${pos2 - (extraStart - 1)}A`;
    out += '\r\n';
    for (let i = extraStart; i < extraEnd; i++) {
      out += '\x1b[2K';
      if (i < extraEnd - 1) out += '\r\n';
    }
    out += `\x1b[${extraEnd - extraStart}A`;
  }
  out += '\x1b[?2026l';
  out += pos + shape;
  return out;
}

function renderFieldValue(field, active) {
  const val = field.value || '';
  if (field.kind === 'mask') {
    const masked = '•'.repeat(val.length);
    return active ? col(masked || ' ', C.white) : col(masked, C.white);
  }
  return active ? col(val || ' ', C.white) : col(val, C.white);
}
function fieldCaretCol(field, active) {
  const val = field.value || '';
  const shown = field.kind === 'mask' ? '•'.repeat(val.length) : val;
  const c = Math.max(0, Math.min(shown.length, field.caret || 0));
  return visualCol(shown.slice(0, c));
}

// ---- state factory ----
export function makeState({ cfg, session, opts }) {
  const cwd = session.workspace || cfg.workspace || process.cwd();
  return {
    workspace: cwd,
    provider: cfg.provider || '',
    model: cfg.model || '',
    modelLabel: modelLabel(cfg) || cfg.model || '',
    // CLI flags win; otherwise resume whatever the session was left in.
    mode: opts.auto ? 'auto' : opts.yolo ? 'yolo' : ((session && session.mode) || 'ask'),
    reasoning: !!cfg.reasoning,
    seenThinking: false,
    expanded: false,
    todos: (session && Array.isArray(session.todos)) ? session.todos : [],
    todosExpanded: false,
    cwd,
    cwdOverride: null,
    tip: '',
    ctxPercent: 0,
    ctxTokens: 0,
    ctxMax: cfg.maxContextTokens || 512000,
    rounds: (session && session.rounds) || 0,
    turnStart: 0,
    steps: (session && session.steps) || 0,
    lastTurnMs: (session && session.lastTurnMs) || 0,
    _stepsBase: 0,
    _turnSteps: 0,
    tokRate: 0,
    _tokTimes: [],
    chat: [],
    scroll: 0,
    selection: null,
    sbDrag: false,
    sbDragOffset: 0,
    sbHover: false,
    // Todo panel resize: the top rule is a drag handle. `todoRows` is the
    // manual row count (undefined = automatic), and the two flags drive its
    // hover/press styling.
    todoRows: undefined,
    todoResizeHover: false,
    todoResizeDrag: false,
    todoResizeStart: null,
    hoverHit: null,
    input: '',
    caret: 0,
    composerSel: null,
    pastes: new Map(),
    pasteCounter: 0,
    queued: [],
    running: false,
    spin: 0,
    workMsg: WORKING_MESSAGES[0],   // chosen once per turn
    // Turn-finish animation: while non-null, the Working row renders the morph
    // from `from` to `to` (see composeFrame). Cleared ~0.5s after turn end.
    finishAnim: null,   // { start, from, to }
    mouse: true,
    menuOpen: false,
    menuList: [],
    menuSel: 0,
    menuOffset: 0,
    objective: '',
    goalPaused: false,
    plan: !!(session && session.plan),
    planPath: (session && session.planPath) || null,
    focus: !!(session && session.focus),
    effort: (session && session.effort) || cfg.effort || (cfg.reasoning ? 'on' : 'off'),
    // Theme removed - forced dark only
    addDirs: [],
    tasks: {},
    slMode: true, slModel: true, slEffort: true, slCwd: true, slTasks: true, slTips: true,
    picker: null,
    pickerQuery: '',
    pickerCategory: null,  // active filter category (null = "All")
    pickerCategories: null,
    form: null,
    panel: null,
    notice: '',
    noticeKind: 'info',
    confirmExit: false,
    history: [],
    historyIdx: -1,
    _tipIndex: 0,
  };
}

// Pick a RANDOM tip, never the same one twice in a row. Any legacy "Tip #N:"
// prefix is stripped so the status line never shows a number.
export function setTip(state) {
  if (TIPS.length === 0) return;
  if (TIPS.length === 1) { state.tip = stripTipPrefix(TIPS[0]); return; }
  let i;
  do { i = Math.floor(Math.random() * TIPS.length); }
  while (i === state._tipIndex);
  state._tipIndex = i;
  state.tip = stripTipPrefix(TIPS[i]);
}

function stripTipPrefix(s) {
  return String(s).replace(/^Tip #\d+:\s*/i, '');
}

export function reconstructChat(s) {
  const chat = [];
  for (const m of (s && s.messages) || []) {
    const role = m.role;
    const text = typeof m.content === 'string' ? m.content : '';
    if (role === 'user') chat.push({ role: 'user', text });
    else if (role === 'assistant') {
      chat.push({ role: 'assistant', text });
      for (const tc of (m.toolCalls || [])) {
        chat.push({ role: 'tool', toolName: tc.name, toolArgs: tc.args || {}, pending: false });
      }
    } else if (role === 'tool') {
      chat.push({ role: 'tool_result', text });
    }
  }
  return chat;
}

export function pickerFiltered(state) {
  if (!state.picker) return [];
  const items = state.picker.items || [];
  const q = (state.pickerQuery || '').trim().toLowerCase();
  let filtered = items;
  if (q) {
    const hit = items.filter((it) => String(it.label).toLowerCase().includes(q));
    filtered = hit.length ? hit : items;
  }
  // Category filter: when "All" is active (cat is null or "All"), show everything.
  // For a specific provider category, only show items whose category matches.
  const cat = state.pickerCategory;
  if (cat && cat !== 'All') {
    const catFiltered = filtered.filter((it) => it.category === cat);
    filtered = catFiltered.length ? catFiltered : filtered;
  }
  return filtered;
}

export function refreshMenu(state) {
  const val = state.input || '';
  if (val === '' || !val.startsWith('/') || val.includes(' ')) {
    state.menuOpen = false;
    state.menuList = [];
    state.menuSel = 0;
    state.menuOffset = 0;
    return;
  }
  const prefix = val.slice(1).toLowerCase();
  state.menuList = allCommands().filter((c) => c.name.startsWith(prefix));
  state.menuSel = Math.min(state.menuSel, Math.max(0, state.menuList.length - 1));
  state.menuOpen = state.menuList.length > 0;
  ensureMenuVisible(state);
}

function ensureMenuVisible(state) {
  if (!state.menuList.length) return;
  const off = state.menuOffset || 0;
  const last = off + MAX_MENU - 1;
  if (state.menuSel < off) state.menuOffset = state.menuSel;
  else if (state.menuSel > last) state.menuOffset = Math.max(0, state.menuSel - MAX_MENU + 1);
}

// ---- command dispatch ----
async function dispatch(cmdRaw, arg, state, cfg, session, h, submit, stdout, renderFrame) {
  const { addChat, openPicker, openForm, notice, sendPrompt, quit, saveSession, openEditor } = h;
  const entry = findCommand(cmdRaw);
  const cmd = entry ? entry.name : String(cmdRaw || '').replace(/^\//, '');
  const app = (m) => notice(m, 'info');
  // Settings changed through a command must be written to the session at once.
  const persist = () => { try { h.persistState && h.persistState(); } catch {} };
  const appErr = (m) => notice(m, 'error');
  const say = (m) => addChat({ role: 'system', text: m });
  const raw = (arg || '').trim();

  switch (cmd) {
    case 'permission': {
      const named = { ask: 'ask', manual: 'ask', yolo: 'yolo', auto: 'auto' }[raw.toLowerCase()];
      if (named) { setPermission(state, named); persist(); app(`Permission mode: ${PERMISSION_LABEL[named]}`); return; }
      openPicker({
        title: 'Select permission mode',
        items: [
          { label: 'Always Ask', sub: 'read-only runs automatically; other actions ask', current: state.mode === 'ask', value: 'ask' },
          { label: 'Ask When Needed', sub: 'workspace-internal edits and commands run automatically; outside the workspace or destructive commands ask', current: state.mode === 'yolo', value: 'yolo' },
          { label: 'Never Ask', sub: 'never interrupts; dangerous commands are still guarded', current: state.mode === 'auto', value: 'auto' },
        ],
        sel: ['ask', 'yolo', 'auto'].indexOf(state.mode),
        searchable: false,
        hint: '↑↓ navigate · Enter select · Esc cancel',
        onPick: (it) => { setPermission(state, it.value); persist(); app(`Permission mode: ${PERMISSION_LABEL[it.value]}`); return true; },
      });
      return;
    }
    case 'yolo': setPermission(state, 'yolo'); persist(); app(`Permission mode: ${PERMISSION_LABEL.yolo}`); return;
    case 'auto': setPermission(state, 'auto'); persist(); app(`Permission mode: ${PERMISSION_LABEL.auto}`); return;
    case 'ask': setPermission(state, 'ask'); persist(); app(`Permission mode: ${PERMISSION_LABEL.ask}`); return;

    case 'plan': {
      const a = raw.toLowerCase();
      if (a === 'clear') { state.plan = false; state.planPath = null; persist(); app('Plan cleared.'); return; }
      if (a === 'on') state.plan = true;
      else if (a === 'off') state.plan = false;
      else state.plan = !state.plan;
      if (state.plan) state.focus = false;
      persist();
      app(`Plan mode: ${state.plan ? 'ON (read-only planning)' : 'OFF'}`);
      return;
    }
    case 'focus': {
      const a = raw.toLowerCase();
      let want = !state.focus;
      if (a === 'on') want = true;
      else if (a === 'off') want = false;
      state.focus = want;
      if (state.focus) state.plan = false;
      persist();
      app(`Focus mode: ${state.focus ? 'ON (Read/Write/Edit/Bash only)' : 'OFF (all tools)'}`);
      return;
    }

    case 'settings':
      openPicker({
        title: 'Settings',
        items: [
          { label: 'model', sub: 'switch LLM model' },
          { label: 'effort', sub: 'switch thinking effort' },
          { label: 'permission', sub: 'select permission mode' },
          { label: 'provider', sub: 'manage AI providers' },
          { label: 'statusline', sub: 'configure status line items' },
          { label: 'add-dir', sub: 'add an additional workspace directory' },
        ],
        onPick: (it) => { dispatch(it.label, '', state, cfg, session, h, submit, stdout); return true; },
      });
      return;

    case 'model': {
      const models = (cfg.raw && cfg.raw.models) || {};
      let names = Object.keys(models);
      if (!names.length) {
        const pr = (cfg.raw && cfg.raw.providers) || {};
        names = Object.keys(pr);
        if (!names.length) { appErr('No providers configured. Add one first: /provider'); return; }
        if (raw) {
          if (!pr[raw]) { appErr(`Unknown provider: ${raw}`); return; }
          applyModel(state, cfg, resolveProvider(cfg, raw));
          app(`Model → ${cfg.model || '(unset)'} via ${raw}`);
          return;
        }
        openPicker({
          title: 'Select a provider',
          items: names.map((n) => ({ label: n, sub: ((pr[n] || {}).base_url || '').replace(/^https?:\/\//, ''), current: n === cfg.provider })),
          sel: Math.max(0, names.indexOf(cfg.provider)),
          onPick: (it) => { applyModel(state, cfg, resolveProvider(cfg, it.label)); app(`Provider → ${cfg.provider}`); return true; },
        });
        return;
      }
      if (raw) {
        if (!models[raw]) { appErr(`Unknown model alias: ${raw}`); return; }
        applyModel(state, cfg, resolveModelArg(cfg, raw));
        app(`Model → ${cfg.model}`);
        return;
      }
      {
        // Build categories: "All" + one per configured provider.
        const _providers = Object.keys(cfg.raw.providers || {});
        const _catLabels = ['All', ..._providers];
        openPicker({
          title: 'Select a model',
          items: [
            ...names.map((n) => ({ label: n, sub: models[n].provider || cfg.provider || '', current: n === cfg.model, category: models[n].provider || '' })),
            { label: '＋ Add model…', sub: 'register a model under a provider', action: 'add-model' },
          ],
          categories: _catLabels,
          category: null,  // start on "All"
          hint: '↑↓ navigate · Tab switch category · Enter select · Esc cancel',
          sel: Math.max(0, names.indexOf(cfg.model)),
          footerFor: (item) => {
            if (!item || item.action === 'add-model') return { label: 'Thinking', options: ['off', 'on'], value: state.effort || 'off', focused: false };
            const itemOpts = effortOptions(cfg, item.label);
            if (!itemOpts.length) return null;
            const cur = item.label === cfg.model ? (state.effort && itemOpts.includes(state.effort) ? state.effort : 'off') : (itemOpts.includes(state.effort) ? state.effort : itemOpts.includes('off') ? 'off' : itemOpts[0]);
            return { label: 'Thinking', options: itemOpts, value: cur, focused: false };
          },
          onPick: (it) => {
            if (it.action === 'add-model') {
            const pr = (cfg.raw && cfg.raw.providers) || {};
            const providers = Object.keys(pr);
            if (!providers.length) { appErr('No providers configured. Add one first: /provider'); return true; }
            openPicker({
              title: 'Add model — choose a provider',
              items: providers.map((n) => ({ label: n, sub: ((pr[n] || {}).base_url || '').replace(/^https?:\/\//, ''), provider: n })),
              searchable: true,
              onPick: (pit) => {
                openForm({
                  title: `Add A Model To ${pit.label}`,
                  fields: [
                    { key: 'model', label: 'Model ID' },
                    { key: 'display_name', label: 'Display Name' },
                  ],
                  type: null,
                  hideType: true,
                  hint: 'Tab next field · Enter save · Esc cancel (display name defaults to the id)',
                  onSubmit: (values) => {
                    if (!values.model) { appErr('Cancelled: model id is required.'); return; }
                    const disp = values.display_name || values.model;
                    addModel(pit.provider, values.model, { display_name: values.display_name });
                    cfg.raw.models = cfg.raw.models || {};
                    cfg.raw.models[modelKey(pit.provider, values.model)] = { provider: pit.provider, model: values.model, display_name: values.display_name || undefined };
                    app(`Model added: ${pit.provider}/${values.model} (${disp})`);
                  },
                });
                return true;
              },
            });
            return true;
          }
          applyModel(state, cfg, resolveModelArg(cfg, it.label));
          const fo = state.picker && state.picker.footer;
          if (fo && fo.value) setEffort(state, cfg, fo.value);
          app(`Model → ${cfg.model}${state.effort && state.effort !== 'off' ? ` (thinking ${state.effort})` : ''}`);
          return true;
        },
        });
      }
      return;
    }
    case 'effort': {
      const opts = effortOptions(cfg);
      if (!opts.length) { appErr('The current model has no thinking control.'); return; }
      if (raw) {
        const v = raw.toLowerCase();
        if (!opts.includes(v)) { appErr(`Unknown effort: ${raw} (expected ${opts.join(' / ')})`); return; }
        setEffort(state, cfg, v);
        persist();
        app(`Thinking effort → ${v}`);
        return;
      }
      openPicker({
        title: 'Select thinking effort',
        items: opts.map((o) => ({ label: o, sub: o === 'off' ? 'no reasoning tokens' : `${o} reasoning budget`, current: (state.effort || 'off') === o })),
        sel: Math.max(0, opts.indexOf(state.effort || 'off')),
        searchable: false,
        onPick: (it) => { setEffort(state, cfg, it.label); persist(); app(`Thinking effort → ${it.label}`); return true; },
      });
      return;
    }
    case 'provider': {
      const pr = (cfg.raw && cfg.raw.providers) || {};
      const names = Object.keys(pr);
      const items = names.map((name) => {
        const p = pr[name] || {};
        return { label: name, sub: (p.base_url || p.baseUrl || '').replace(/^https?:\/\//, '') || '(no base_url)', current: name === cfg.provider };
      });
      items.push({ label: '＋ Add provider…', sub: 'create a new [providers.*] entry', action: 'add' });
      openPicker({
        title: names.length ? 'Select a provider' : 'No providers yet',
        items,
        sel: Math.max(0, names.indexOf(cfg.provider)),
        hint: names.length ? '↑↓ navigate · Enter edit · Delete remove · Esc cancel' : 'Enter to add your first provider · Esc cancel',
        onDelete: (it) => {
          if (!it || it.action === 'add') return false;
          removeProvider(it.label);
          delete (cfg.raw.providers || {})[it.label];
          for (const key of Object.keys(cfg.raw.models || {})) {
            if (key.split('/')[0] === it.label) delete cfg.raw.models[key];
          }
          const left = Object.keys(cfg.raw.providers || {});
          state.picker.items = left.map((name) => ({
            label: name,
            sub: ((cfg.raw.providers[name] || {}).base_url || '').replace(/^https?:\/\//, '') || '(no base_url)',
            current: name === cfg.provider,
          }));
          state.picker.items.push({ label: '＋ Add provider…', sub: 'create a new [providers.*] entry', action: 'add' });
          state.picker.sel = Math.max(0, Math.min(state.picker.sel, state.picker.items.length - 1));
          if (cfg.provider === it.label) { cfg.provider = ''; state.provider = ''; }
          app(`Provider removed: ${it.label}`);
          return true;
        },
        onPick: (it) => {
          if (it.action === 'add') {
            app('Loading provider list…');
            fetchCatalog().then((catalog) => {
              const entries = catalog
                ? Object.values(catalog)
                    .filter((p) => p && p.id && p.api)
                    .map((p) => ({ id: p.id, name: p.name || p.id, api: p.api, doc: p.doc || '' }))
                    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
                : [];
              const items = entries.map((p) => ({
                label: p.name,
                sub: p.api.replace(/^https?:\/\//, ''),
                providerId: p.id,
                base_url: p.api,
                action: 'pickKnown',
              }));
              items.push({ label: '＋ Custom provider…', sub: 'enter base URL, key and protocol yourself', action: 'custom' });
              openPicker({
                title: 'Add a provider',
                items,
                searchable: true,
                hint: '↑↓ navigate · type to search · Enter select · Esc cancel',
                onPick: (pit) => {
                  if (pit.action === 'custom') {
                    openForm({
                      title: 'Add A Custom Provider',
                      fields: [
                        { key: 'name', label: 'Provider Name' },
                        { key: 'base_url', label: 'Base URL' },
                        { key: 'api_key', label: 'API Key', kind: 'mask' },
                      ],
                      type: null,
                      hint: 'Tab next field · ↑/↓ field · ←/→ type · Enter save · Esc cancel',
                      onSubmit: (values, type) => {
                        if (!values.name) { appErr('Cancelled: provider name is required.'); return; }
                        if (!type) { appErr('Cancelled: choose a Type (OpenAI / Anthropic).'); return; }
                        const protocol = type === 'Anthropic' ? 'anthropic' : 'openai';
                        registerProvider(state, cfg, h, values.name, values.base_url, values.api_key, protocol, type);
                      },
                    });
                    return true;
                  }
                  openForm({
                    title: `Edit ${pit.label}`,
                    fields: [
                      { key: 'name', label: 'Provider Name', value: pit.name },
                      { key: 'base_url', label: 'Base URL', value: pit.base_url },
                      { key: 'api_key', label: 'API Key', kind: 'mask', value: pit.api_key || '' },
                      { key: 'type', label: 'Type', options: ['OpenAI', 'Anthropic'], value: pit.type || (pit.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI') },
                    ],
                    type: null,
                    hint: 'Tab next field · Enter save · Esc cancel',
                    onSubmit: async (values) => {
                      if (!values.name) { appErr('Cancelled: provider name is required.'); return; }
                      const protocol = values.type === 'Anthropic' ? 'anthropic' : 'openai';
                      registerProvider(state, cfg, h, values.name, values.base_url, values.api_key, protocol, values.type);
                      
                      // Auto-fetch models and configure context/thinking settings
                      try {
                        const models = await fetchModels({ 
                          baseUrl: values.base_url, 
                          apiKey: values.api_key, 
                          protocol 
                        });
                        
                        if (models.length > 0) {
                          // Add each model with its configuration
                          for (const m of models) {
                            const key = modelKey(values.name, m.id);
                            if (!cfg.raw.models[key]) {
                              addModel(values.name, m.id, {
                                display_name: m.display,
                                contextLength: m.contextLength,
                                maxTokens: m.maxTokens,
                              });
                              
                              // Configure model entry in raw config
                              if (!cfg.raw.models) cfg.raw.models = {};
                              cfg.raw.models[key] = {
                                provider: values.name,
                                model: m.id,
                                display_name: m.display,
                                context_length: m.contextLength,
                                max_tokens: m.maxTokens,
                                reasoning: m.reasoning,
                                efforts: m.efforts,
                              };
                            }
                          }
                          
                          app(`Added ${models.length} model(s) with auto-configured context windows and thinking capabilities.`);
                        } else {
                          app(`Provider added. No models found at this endpoint.`);
                        }
                      } catch (error) {
                        app(`Provider added. Failed to fetch models: ${error.message}`);
                      }
                    },
                  });
                  return true;
                },
              });
            });
            return true;
          }
          // Enter on a regular provider opens the edit form (Ctrl+E removed).
          const p = cfg.raw.providers && cfg.raw.providers[it.label] || {};
          openForm({
            title: `Edit Provider: ${it.label}`,
            fields: [
              { key: 'name', label: 'Provider Name', value: it.label },
              { key: 'base_url', label: 'Base URL', value: p.base_url || p.baseUrl || '' },
              { key: 'api_key', label: 'API Key', kind: 'mask', value: p.api_key || p.apiKey || '' },
            ],
            type: p.protocol || 'openai',
            hideType: true,
            hint: 'Tab next field · ←/→ type · Enter save · Esc cancel',
            onSubmit: (values, type) => {
              if (!values.name) { appErr('Cancelled: provider name is required.'); return; }
              const protocol = values.type === 'Anthropic' ? 'anthropic' : 'openai';
              addProvider(values.name, { base_url: values.base_url, api_key: values.api_key, protocol });
              delete (cfg.raw.providers || {})[it.label];
              for (const key of Object.keys(cfg.raw.models || {})) {
                if (key.split('/')[0] === it.label) delete cfg.raw.models[key];
              }
              state.picker.items = Object.keys(cfg.raw.providers || {}).map((name) => ({
                label: name,
                sub: ((cfg.raw.providers[name] || {}).base_url || '').replace(/^https?:\/\//, '') || '(no base_url)',
                current: name === cfg.provider,
              }));
              state.picker.items.push({ label: '＋ Add provider…', sub: 'create a new [providers.*] entry', action: 'add' });
              state.picker.sel = Math.max(0, Math.min(state.picker.sel, state.picker.items.length - 1));
              if (values.name === cfg.provider) { applyModel(state, cfg, resolveProvider(cfg, values.name)); }
              app(`Provider updated: ${values.name}`);
              return true;
            },
          });
          return true;
        },
      });
      return;
    }

    case 'new':
      // Save current session's todos before switching
      if (session && Array.isArray(state.todos)) {
        session.todos = state.todos.slice();
        saveSession(session);
      }
      
      state.chat = [];
      Object.assign(session, { id: sess.newId(), title: '', messages: [], createdAt: Date.now(), rounds: 0, steps: 0, lastTurnMs: 0 });
      state.objective = '';
      state.rounds = 0; state.steps = 0; state.lastTurnMs = 0;
      // New session starts with empty TODO list
      state.todos = [];
      session.todos = [];
      // Set terminal window title to default (Untitled)
      stdout.write('\x1b]0;Untitled\x07');
      // A fresh session has no history, so the context gauge must go back to 0
      // (otherwise it kept showing the PREVIOUS session's usage until the next
      // turn reported a new estimate). The window size is a property of the
      // current model, so it is re-resolved from cfg rather than kept stale.
      state.ctxTokens = 0;
      state.ctxPercent = 0;
      state.ctxMax = cfg.maxContextTokens || state.ctxMax;
      state.tokRate = 0;
      state._tokTimes = [];
      saveSession(session);
      app(`Started a new session (${session.id}).`);
      return;
    case 'sessions': {
      const all = sess.listSessions();
      const cwd = path.resolve(state.cwd || state.workspace || process.cwd());
      // Filter to only show sessions from the current workspace.
      const list = all.filter((s) => {
        if (!Array.isArray(s.messages) || s.messages.length === 0) return false;
        const sessionCwd = s.workspace ? path.resolve(s.workspace) : null;
        return sessionCwd === cwd;
      });
      if (!list.length) { app(all.length ? `No sessions in this directory (${cwd}).` : 'No saved sessions.'); return; }
      openPicker({
        title: 'Resume a session',
        items: list.slice(0, 50).map((s) => ({
          label: (s.title || 'untitled').slice(0, 30),
          sub: `${new Date(s.updatedAt || s.createdAt || 0).toLocaleString().slice(0, 19)} · ${(s.messages || []).length} msgs · ${s.workspace || ''}${s.lastTurnMs ? ` · last turn ${fmtDuration(s.lastTurnMs)}` : ''}`,
          id: s.id,
        })),
        onPick: (it) => {
          const hit = list.find((s) => s.id === it.id);
          if (hit) {
            const keepModel = cfg.model;
            const keepInner = cfg.innerModel;
            const keepProvider = cfg.provider;
            Object.assign(session, hit);
            cfg.model = keepModel;
            cfg.innerModel = keepInner;
            cfg.provider = keepProvider;
            state.chat = reconstructChat(session);
            state.scroll = 0;
            state.rounds = session.rounds || 0;
            state.steps = session.steps || 0;
            state.lastTurnMs = session.lastTurnMs || 0;
            
            // Update context gauge based on restored session messages.
            const approx = estimateMessagesTokens(session.messages, cfg);
            state.ctxTokens = approx;
            state.ctxMax = cfg.maxContextTokens || state.ctxMax;
            state.ctxPercent = usagePercent(approx, state.ctxMax);
            
            const dur = session.lastTurnMs ? ` · last turn ${fmtDuration(session.lastTurnMs)}` : '';
            app(`Resumed ${hit.id} (${hit.title || 'untitled'}) · ${(session.messages || []).length} messages.${dur}`);
          }
          return true;
        },
      });
      return;
    }
    case 'tasks': {
      const tasks = Object.values(state.tasks || {});
      if (!tasks.length) { app('No background tasks.'); return; }
      const rows = tasks
        .sort((a, b) => (b.start || 0) - (a.start || 0))
        .map((t) => {
          const secs = t.end ? Math.round((t.end - (t.start || t.end)) / 1000) : Math.round((Date.now() - (t.start || Date.now())) / 1000);
          const extra = t.stopReason ? ` (${t.stopReason})` : '';
          return `  #${t.id} [${t.status}${extra}] pid=${t.pid} ${secs}s ${t.description || t.command || ''}`;
        });
      say('Background tasks:\n' + rows.join('\n'));
      return;
    }
    case 'fork': {
      const forked = { ...session, id: sess.newId(), title: `${session.title || 'untitled'} (fork)`, createdAt: Date.now(), messages: (session.messages || []).slice() };
      sess.saveSession(forked);
      app(`Session forked (${forked.id}). Still in the original; switch via /sessions.`);
      return;
    }
    case 'undo': {
      const count = Math.max(1, parseInt(raw || '1', 10) || 1);
      const msgs = session.messages || [];
      let idx = msgs.length;
      for (let i = 0; i < count; i++) {
        let j = idx - 1;
        while (j >= 0 && msgs[j].role !== 'user') j--;
        if (j < 0) break;
        idx = j;
      }
      if (idx >= msgs.length) { app('Nothing to undo.'); return; }
      const removed = msgs.slice(idx);
      session.messages = msgs.slice(0, idx);
      state.chat = state.chat.slice(0, Math.max(0, state.chat.length - removed.length));
      saveSession(session);
      app(`Undid ${count} prompt${count > 1 ? 's' : ''}.`);
      return;
    }
    case 'title': {
      if (raw) {
        session.title = raw.slice(0, 200);
        saveSession(session);
        // Set terminal window title - use OSC sequence
        // Only show "Untitled" prefix if user hasn't set a custom title
        const displayTitle = session.title || 'Untitled';
        stdout.write(`\x1b]0;${displayTitle}\x07`);
        app(`Session title set to: "${displayTitle}"`);
      } else {
        app(`Session title: ${session.title || 'not set'}`);
      }
      return;
    }
    case 'compact': {
      const msgs = session.messages || [];
      if (msgs.length <= 2) { app('Nothing to compact yet.'); return; }
      const ratio = raw ? parseFloat(raw) : null; // optional slice ratio (0-1)

      // AI-powered compaction: summarize the dropped portion of the conversation
      // via the model, so context is preserved rather than simply truncated.
      let keepCount, dropped;
      if (ratio !== null) {
        // Slice mode: user-specified ratio to drop (0-1). E.g. 0.2 drops the
        // oldest 20% and keeps the most recent 80%.
        if (!isNaN(ratio) && ratio > 0 && ratio < 1) {
          keepCount = Math.ceil(msgs.length * (1 - ratio));
          dropped = msgs.length - keepCount;
        } else {
          app('Invalid ratio; use 0-1 (e.g., 0.2 to drop 20%% of oldest messages)');
          return;
        }
      } else {
        // Default mode: keep the most recent 20% of messages, summarize the rest.
        keepCount = Math.max(1, Math.ceil(msgs.length * 0.2));
        dropped = msgs.length - keepCount;
      }

      const droppedMsgs = msgs.slice(0, dropped);
      const kept = msgs.slice(keepCount);

      // Ask the model to summarize the trimmed messages.
      let summary = '';
      if (droppedMsgs.length > 0) {
        const llm = new LLM(cfg);
        app(`Summarizing ${dropped} messages for compaction…`);
        try {
          summary = await llm.requestText([
            { role: 'system', content: 'You are an expert at summarizing coding-agent conversations. Summarize the conversation history below. Capture: the user\'s original request, key decisions made, files created or modified, errors encountered and how they were resolved, and the current state of any ongoing work or remaining tasks. Be concise but thorough — aim for 3-5 short paragraphs that let the model continue the task with full context. Do NOT include meta-commentary, only the facts.' },
            ...droppedMsgs,
          ]);
        } catch (e) {
          summary = '';
        }
      }

      const compactedSummary = summary
        ? `Context compacted: dropped ${dropped} older messages, replaced with AI summary.\n\nSummary:\n${summary}`
        : `Context compacted (dropped ${dropped} older messages).`;

      // Update the session messages: keep the recent ones + summary.
      session.messages = [...kept, { role: 'system', content: compactedSummary }];
      // Mirror the change in the live chat view.
      state.chat = [...state.chat.slice(0, state.chat.length - msgs.length), ...kept, { role: 'system', content: compactedSummary }];

      saveSession(session);
      state.tokens = estimateMessagesTokens(session.messages);
      app('OK');
      return;
    }
    case 'set-system-prompt': {
      // Show the prompt currently in effect: the custom one if set, else the
      // built-in. Saving writes it to config.toml; an EMPTY value clears the
      // override and restores the built-in.
      const builtin = SYSTEM_PROMPT;
      const custom = cfg.raw && cfg.raw.system_prompt ? String(cfg.raw.system_prompt) : '';
      const current = custom || builtin;
      openEditor({
        title: custom
          ? 'System prompt (custom — saving replaces it; clear it to restore the built-in)'
          : 'System prompt (built-in — saving overrides it)',
        text: current,
        caretRow: 0,
        caretCol: 0,
        onSave: (text) => {
          const value = String(text).trim();
          try {
            setConfigString('system_prompt', value);
          } catch (e) { appErr('Could not write config.toml: ' + e.message); return; }
          cfg.systemPrompt = value;
          cfg.raw.system_prompt = value;
          if (value) app(`System prompt saved (${value.length} chars) → ${hncodeConfigFile()}`);
          else app('System prompt override cleared; the built-in prompt is in use again.');
        },
      });
      return;
    }

    case 'calm-mode': {
      // Terse-output mode: while ON, an instruction is injected with each request
      // telling the model not to narrate what it is about to do or why, unless
      // asked. Persisted so it survives a restart.
      const a = raw.toLowerCase();
      let want;
      if (a === 'on') want = true;
      else if (a === 'off') want = false;
      else if (a === '') want = !cfg.calmMode;
      else { appErr('Usage: /calm-mode [on|off]'); return; }
      try { setConfigString('calm_mode', want ? 'true' : 'false'); }
      catch (e) { appErr('Could not write config.toml: ' + e.message); return; }
      cfg.calmMode = want;
      cfg.raw.calm_mode = want;
      app(`Calm mode: ${want ? 'ON — the model will keep explanations to a minimum' : 'OFF'}`);
      return;
    }

    case 'init': {
      if (!cfg.model) { appErr('LLM not set. Configure a provider with /provider first.'); return; }
      say('/init — analyzing the workspace to generate AGENTS.md…');
      sendPrompt('Analyze this codebase and write an AGENTS.md file at the workspace root with concise instructions for future agents: project layout, build/test commands, and conventions.');
      return;
    }

    case 'goal': {
      const a = raw.toLowerCase();
      if (!raw || a === 'status') {
        say(state.objective ? `Goal: ${state.objective}\nStatus: ${state.goalPaused ? 'paused' : 'active'}` : 'No goal set. Start one with /goal <objective>.');
        return;
      }
      if (a === 'pause') { state.goalPaused = true; app('Goal paused. Use /goal resume to continue.'); return; }
      if (a === 'resume') {
        if (!state.objective) { app('No goal to resume.'); return; }
        state.goalPaused = false; app('Goal resumed.');
        sendPrompt('Resume the active goal.');
        return;
      }
      if (a === 'cancel') { state.objective = ''; state.goalPaused = false; app('Goal cancelled.'); return; }
      if (a.startsWith('replace ')) { state.objective = raw.slice(8).trim(); app('Goal replaced.'); return; }
      state.objective = raw; state.goalPaused = false;
      app(`Goal set: ${raw}`);
      sendPrompt(raw);
      return;
    }

    case 'help':
      h.openPanel('hncode — commands', [
        ...allCommands().map((c) => `  /${c.name.padEnd(14)} ${(c.argumentHint || '').padEnd(26)} ${c.desc}`),
        '',
        'Shortcuts',
        '  Enter          send the message',
        '  Ctrl-J         insert a newline',
        '  Ctrl+Shift+C   copy the selection (or the last answer)',
        '  Ctrl+Shift+V   paste the clipboard (multi-line pastes collapse)',
        '  ↑ / ↓          input history (empty composer) · scroll the chat',
        '  /              open the command menu · Tab completes',
        '  Esc            cancel the menu / dialog · interrupt the turn',
        '  Ctrl+E         open config.toml in editor',
        '  Ctrl-B         move a running Bash command to the background',
        '  Ctrl-S         steer queued input into the running turn',
        '  ↑ (queued)     recall the last queued message for editing',
        '  Ctrl-O         expand/collapse tool output and thinking',
        '  Ctrl-T         expand/collapse the todo panel',
        '  Ctrl-C twice   exit hncode',
      ]);
      return;
    case 'status': {
      const lines = [
        `hncode v${VERSION}`,
        `Model:       ${cfg.model || 'not set'}${state.effort && state.effort !== 'off' ? ` (thinking ${state.effort})` : ''}`,
        `Provider:    ${cfg.provider || 'not set'}${cfg.protocol ? ` (${cfg.protocol})` : ''}`,
        `Endpoint:    ${cfg.endpoint || 'not set'}`,
        `API key:     ${cfg.apiKey ? 'set' : 'NOT SET'}`,
        `Directory:   ${state.cwd}`,
        `Permissions: ${PERMISSION_LABEL[state.mode]}`,
        `Plan mode:   ${state.plan ? 'on' : 'off'}`,
        `Session:     ${session.id}`,
      ];
      if (session.title) lines.push(`Title:       ${session.title}`);
      if (state.objective) lines.push(`Goal:        ${state.objective}${state.goalPaused ? ' (paused)' : ''}`);
      lines.push(`Context:     ${state.ctxPercent}% (${fmtTokens(state.ctxTokens)}/${fmtTokens(state.ctxMax)})`);
      say(lines.join('\n'));
      return;
    }
    case 'usage': {
      const msgs = session.messages || [];
      const approx = Math.round(JSON.stringify(msgs).length / 3.5);
      say([
        'Session usage',
        `  messages: ${msgs.length}`,
        `  approx tokens: ${approx}`,
        '',
        'Context window',
        `  ${state.ctxPercent}% used (${fmtTokens(state.ctxTokens)} / ${fmtTokens(state.ctxMax)})`,
      ].join('\n'));
      return;
    }
    case 'version': app(`hncode v${VERSION}`); return;

    case 'mcp': {
      const mcpFile = path.join(os.homedir(), '.hncode', 'mcp.json');
      let doc = { mcpServers: {} };
      try { doc = JSON.parse(fs.readFileSync(mcpFile, 'utf8')); } catch {}
      const names = Object.keys(doc.mcpServers || {});
      say(names.length
        ? `MCP servers (${names.length}):\n` + names.map((n) => {
            const e = doc.mcpServers[n];
            return `  ${n}  ${e.url ? e.url : `${e.command || ''} ${(e.args || []).join(' ')}`.trim()}`;
          }).join('\n')
        : 'No MCP servers configured. Run /mcp-config to add one.');
      return;
    }
    case 'mcp-config': {
      const mcpFile = path.join(os.homedir(), '.hncode', 'mcp.json');
      let doc = { mcpServers: {} };
      try { doc = JSON.parse(fs.readFileSync(mcpFile, 'utf8')); } catch {}
      doc.mcpServers = doc.mcpServers || {};
      const [action, name, ...rest] = raw.split(/\s+/).filter(Boolean);
      if (!action || action === 'list') {
        const names = Object.keys(doc.mcpServers);
        say(names.length ? `MCP servers (${mcpFile}):\n` + names.map((n) => `  ${n}`).join('\n') : `No MCP servers configured. File: ${mcpFile}`);
        return;
      }
      if (['remove', 'rm', 'delete'].includes(action)) {
        if (!name || !doc.mcpServers[name]) { appErr(`No such MCP server: ${name || '(none)'}`); return; }
        delete doc.mcpServers[name];
        fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
        fs.writeFileSync(mcpFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        app(`MCP server removed: ${name}. Start a new session to apply.`);
        return;
      }
      if (action === 'add') {
        const target = rest[0] || '';
        if (!name || !target) { appErr('Usage: /mcp-config add <name> <command|url> [args...]'); return; }
        doc.mcpServers[name] = /^https?:\/\//.test(target) ? { url: target } : { command: target, args: rest.slice(1) };
        fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
        fs.writeFileSync(mcpFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        app(`MCP server added: ${name} → ${mcpFile}. Start a new session to apply.`);
        return;
      }
      appErr('Usage: /mcp-config [list] | add <name> <command|url> [args...] | remove <name>');
      return;
    }

case 'statusline':
      openPicker({
        title: 'Status line items',
        items: [
          { label: 'permission mode', kind: 'toggle', isOn: state.slMode !== false },
          { label: 'model name', kind: 'toggle', isOn: state.slModel !== false },
          { label: 'thinking effort', kind: 'toggle', isOn: state.slEffort !== false },
          { label: 'current directory', kind: 'toggle', isOn: state.slCwd !== false },
          { label: 'background tasks', kind: 'toggle', isOn: state.slTasks !== false },
          { label: 'rotating tips', kind: 'toggle', isOn: state.slTips !== false },
        ],
        hint: '↑↓ navigate · Enter toggle · Esc close',
        onPick: (it) => {
          it.isOn = !it.isOn;
          it.sub = it.isOn ? 'on' : 'off';
          const key = { 'permission mode': 'slMode', 'model name': 'slModel', 'thinking effort': 'slEffort', 'current directory': 'slCwd', 'background tasks': 'slTasks', 'rotating tips': 'slTips' }[it.label];
          state[key] = it.isOn;
          app(`Status line: ${it.label} → ${it.isOn ? 'shown' : 'hidden'}`);
          return false;
        },
      });
      return;

    case 'export-md': {
      const msgs = session.messages || [];
      if (!msgs.length) { appErr('Nothing to export (empty session).'); return; }
      const out = raw || path.join(state.cwd, `hncode-export-${session.id}.md`);
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buildMarkdown(session), 'utf8');
        say(`Exported ${msgs.length} messages → ${out}`);
      } catch (e) { appErr(`Export failed: ${e.message}`); }
      return;
    }
    case 'import-session': {
      // Force a Markdown file: the content is injected into the prompt, so a
      // binary/arbitrary file would waste tokens or corrupt the request.
      const pickMd = (list) => list.filter((f) => /\.(md|markdown)$/i.test(f));
      const doImport = (target) => {
        if (!target) return;
        let abs;
        try { abs = path.resolve(state.cwd, target); } catch { abs = target; }
        if (!/\.(md|markdown)$/i.test(abs)) { appErr('Only Markdown files are supported (.md / .markdown).'); return; }
        let text;
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) { appErr('Not a file: ' + target); return; }
          text = fs.readFileSync(abs, 'utf8');
        } catch (e) { appErr('Could not read ' + target + ': ' + e.message); return; }
        if (!text.trim()) { appErr('That Markdown file is empty: ' + target); return; }
        const rel = path.relative(state.cwd, abs).replace(/\\/g, '/') || target;
        say(`/import-session — attaching ${rel} (${text.length} chars) to the prompt…`);
        // The file content travels WITH the message, so the model does not need
        // a Read call to see it.
        sendPrompt(
          'The following is the contents of ' + rel + ', provided inline so you do not need to read it with a tool.\n\n'
          + '<file path="' + rel + '">\n' + text + '\n</file>\n\n'
          + 'Use it as context for whatever I ask next.',
        );
      };
      if (raw) { doImport(raw); return; }
      // No argument: offer the Markdown files in the workspace.
      let entries = [];
      try {
        entries = pickMd(fs.readdirSync(state.cwd)).sort();
      } catch { entries = []; }
      // Also look one level down — exports often land in a subdirectory.
      const found = [];
      for (const name of entries) found.push(name);
      try {
        for (const d of fs.readdirSync(state.cwd, { withFileTypes: true })) {
          if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
          let inner = [];
          try { inner = pickMd(fs.readdirSync(path.join(state.cwd, d.name))); } catch { continue; }
          for (const name of inner.slice(0, 20)) found.push(d.name + '/' + name);
        }
      } catch { /* ignore */ }
      if (!found.length) {
        appErr('No Markdown files found in ' + state.cwd + '. Pass a path: /import-session <file.md>');
        return;
      }
      openPicker({
        title: 'Import a Markdown file into the prompt',
        items: found.slice(0, 60).map((p) => ({
          label: p,
          sub: (() => { try { return Math.max(1, Math.round(fs.statSync(path.join(state.cwd, p)).size / 1024)) + ' KB'; } catch { return ''; } })(),
          id: p,
        })),
        searchable: true,
        hint: '↑↓ choose · Enter attach · Esc cancel — or /import-session <path>',
        onPick: (it) => { doImport(it.id); return true; },
      });
      return;
    }
    case 'copy': {
      const last = [...state.chat].reverse().find((m) => m.role === 'assistant' && (m.text || '').trim());
      if (!last) { appErr('No assistant message to copy.'); return; }
      try {
        if (process.platform === 'win32') cp.execSync('clip', { input: last.text });
        else cp.execSync('pbcopy', { input: last.text });
        app(`Copied to clipboard (${last.text.length} characters).`);
      } catch { appErr('Clipboard unavailable.'); }
      return;
    }
    case 'add-dir': {
      state.addDirs = state.addDirs || [];
      if (!raw || raw === 'list') {
        say(state.addDirs.length ? 'Additional directories:\n' + state.addDirs.map((d) => `  ${d}`).join('\n') : 'No additional directories.');
        return;
      }
      const dir = path.resolve(state.cwd, raw.replace(/^~/, os.homedir()));
      if (!fs.existsSync(dir)) { appErr(`Directory does not exist: ${dir}`); return; }
      openPicker({
        title: `Add directory to workspace: ${dir}`,
        items: [
          { label: 'Yes, for this session', value: 'session' },
          { label: 'Yes, and remember this directory', value: 'persist' },
          { label: 'No', value: 'no' },
        ],
        searchable: false,
        onPick: (it) => {
          if (it.value === 'no') { app(`Did not add ${dir} as a working directory.`); return true; }
          if (!state.addDirs.includes(dir)) state.addDirs.push(dir);
          if (it.value === 'persist') {
            const f = hncodeConfigFile();
            try { fs.appendFileSync(f, `\n[workspace]\nadditional_dirs = ["${dir.replace(/"/g, '\\"')}"]\n`, 'utf8'); } catch {}
            app(`Added workspace directory:\n  ${dir}\n  Saved to:\n  ${f}`);
          } else app(`Added workspace directory:\n  ${dir}\n  For this session only`);
          return true;
        },
      });
      return;
    }

    case 'move': {
      if (!raw) { appErr('Usage: /move <target-directory>'); return; }
      const target = path.resolve(state.cwd, raw.replace(/^~/, os.homedir()));
      if (!fs.existsSync(target)) { appErr(`Directory does not exist: ${target}`); return; }
      // Create a new session in the target directory with the same messages.
      const newSession = {
        id: sess.newId(),
        title: session.title || '(moved)',
        workspace: target,
        model: session.model,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: (session.messages || []).slice(),
        rounds: session.rounds,
        steps: session.steps,
        mode: session.mode,
        plan: session.plan,
        planPath: session.planPath,
        focus: session.focus,
        effort: session.effort,
        theme: session.theme,
        todos: (session.todos || []).slice(),
        lastTurnMs: session.lastTurnMs,
      };
      sess.saveSession(newSession);
      // Update state to use the new session.
      session = newSession;
      state.chat = reconstructChat(session);
      state.scroll = 0;
      state.rounds = session.rounds || 0;
      state.steps = session.steps || 0;
      saveSession(session);
      app(`Session moved to: ${target} (${newSession.id})`);
      return;
    }

    case 'reload': {
      try {
        const fresh = h.reloadConfig ? h.reloadConfig() : null;
        if (fresh) {
          Object.assign(cfg, fresh);
          state.model = cfg.model;
          state.provider = cfg.provider;
          state.modelLabel = modelLabel(cfg) || cfg.model || '';
          state.reasoning = !!cfg.reasoning;
          cfg.effort = state.reasoning ? state.effort : '';
          if (cfg.raw && cfg.raw.theme) { state.theme = cfg.raw.theme; setTheme(state.theme); }
        }
        app('Config reloaded.');
      } catch (e) { appErr(`Reload failed: ${e.message}`); }
      return;
    }
    case 'plugins': {
      const { pluginCommands, loadedPlugins } = await import('../plugin.js');
      if (!loadedPlugins.length) { app('No plugins loaded. Check ~/.hncode/plugins/'); return; }
      const lines = ['Loaded plugins:', ...loadedPlugins.map((p) => `  • ${p.name} v${p.version} (${p.id})`)];
      if (pluginCommands.length) {
        lines.push('', 'Plugin commands:', ...pluginCommands.map((c) => `  /${c.name.padEnd(14)} ${c.description || ''}`));
      }
      h.openPanel('hncode — plugins', lines);
      return;
    }
    case 'logout': {
      const pr = (cfg.raw && cfg.raw.providers) || {};
      const names = Object.keys(pr);
      if (!names.length) { app('Nothing to logout.'); return; }
      const doLogout = (name) => {
        const p = pr[name] || {};
        delete p.api_key;
        delete p.apiKey;
        addProvider(name, { base_url: p.base_url, api_key: '', protocol: p.protocol });
        if (cfg.provider === name) cfg.apiKey = '';
        app(`Logged out from ${name}.`);
      };
      if (raw && pr[raw]) { doLogout(raw); return; }
      openPicker({
        title: 'Select a provider to log out',
        items: names.map((n) => ({ label: n, sub: (pr[n].base_url || '').replace(/^https?:\/\//, '') })),
        searchable: false,
        onPick: (it) => { doLogout(it.label); return true; },
      });
      return;
    }
    case 'feedback': {
      const text = raw;
      if (!text) { appErr('Usage: /feedback <message>'); return; }
      const dir = path.join(os.homedir(), '.hncode', 'feedback');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `${Date.now()}.txt`);
        fs.writeFileSync(f, `${text}\n\nsession=${session.id}\nversion=${VERSION}\nos=${process.platform}\nmodel=${cfg.model}\n`, 'utf8');
        app(`Feedback saved: ${f}`);
      } catch (e) { appErr(`Feedback failed: ${e.message}`); }
      return;
    }
    case 'exit': quit(); return;

    default:
      // Check if this is a plugin-registered command.
      if (isPluginCommand(cmd)) {
        const pc = findCommand(cmd);
        if (pc && pc._plugin && typeof pc.run === 'function') {
          try { pc.run(raw, { state, cfg, session, h, app, appErr }); }
          catch (e) { appErr(`Plugin command "/${cmd}" failed: ${e.message}`); }
          return;
        }
      }
      // Unknown command: show error message
      appErr(`Unknown command: /${cmdRaw.replace(/^\//, '')}`);
      return;
  }
}

const PERMISSION_LABEL = { ask: 'Always Ask', yolo: 'Ask When Needed', auto: 'Never Ask' };
function setPermission(state, mode) { state.mode = mode; }

// Is `p` inside the workspace (or one of the extra directories added via
// /add-dir)? Used by YOLO mode: work inside the workspace is auto-approved, work
// outside it asks.
export function isInWorkspace(state, p) {
  if (!p) return false;
  let abs;
  try { abs = path.resolve(state.cwd || state.workspace || process.cwd(), p); } catch { return false; }
  try { abs = fs.realpathSync(abs); } catch { /* may not exist yet (a new file) */ }
  const roots = [state.cwd || state.workspace, ...(state.addDirs || [])].filter(Boolean);
  for (const root of roots) {
    let r;
    try { r = fs.realpathSync(root); } catch { r = path.resolve(root); }
    const rel = path.relative(r, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

// Decide whether a tool call stays inside the workspace. Anything we cannot PROVE
// is inside asks the user — that is the safe default for YOLO.
function isInsideWorkspace(state, toolName, args) {
  if (!args || typeof args !== 'object') return false;
  switch (toolName) {
    // Path-taking tools: check the path argument.
    case 'Read': case 'Write': case 'Edit': case 'FileLines': case 'Glob': case 'Grep':
      return isInWorkspace(state, args.path || args.file_path || args.dir || state.cwd);
    case 'Bash': {
      // A shell command can touch anything, so it is only auto-approved when every
      // path-like token it mentions resolves inside the workspace AND it contains
      // no blatantly destructive form. Anything ambiguous asks.
      const cmd = String(args.command || '');
      const cwd = args.cwd || state.cwd;
      if (args.cwd && !isInWorkspace(state, args.cwd)) return false;
      if (isDestructiveCommand(cmd)) return false;
      return commandPathsAreInside(state, cmd, cwd);
    }
    default:
      // Unknown tool: ask (never widen the auto-approve surface by accident).
      return false;
  }
}

// Obvious "this is not a routine workspace edit" patterns.
const DESTRUCTIVE_RE = /(\brm\b[^|]*\s-\w*[rf]|\bdel\b|Remove-Item[^|]*-Recurse|\bformat\b|\bmkfs\b|\bshutdown\b|\breboot\b|\bgit\s+push\b|\bgit\s+reset\b[^|]*--hard|\bgit\s+clean\b|>\s*\/dev\/|:\(\)\s*\{|~\/(\.ssh|\.aws|\.config)|\$HOME\/\.(ssh|aws))/i;
function isDestructiveCommand(cmd) {
  return DESTRUCTIVE_RE.test(String(cmd || ''));
}

// True when every absolute / parent-relative path mentioned in the command lies
// inside the workspace. Relative paths are resolved against the command's cwd.
function commandPathsAreInside(state, cmd, cwd) {
  const s = String(cmd || '');
  // Absolute (Windows drive or POSIX) and explicit parent-relative paths.
  const tokens = s.match(/(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\s"'|;&<>)]*/g) || [];
  for (const tok of tokens) {
    // Skip URL-ish and flag-ish tokens.
    if (/^(https?:)?\/\//.test(tok)) continue;
    const cleaned = tok.replace(/[\\/]+$/, '');
    if (!cleaned) continue;
    if (!isInWorkspace(state, path.resolve(cwd || state.cwd, cleaned))) return false;
  }
  // A `cd` that leaves the workspace is not routine either.
  const cds = s.match(/\bcd\s+([^\s;&|]+)/gi) || [];
  for (const c of cds) {
    const target = c.replace(/^\s*cd\s+/i, '').trim();
    if (target && !isInWorkspace(state, path.resolve(cwd || state.cwd, target))) return false;
  }
  return true;
}
function applyModel(state, cfg, next) {
  cfg.model = next.model; cfg.innerModel = next.innerModel; cfg.provider = next.provider;
  cfg.baseUrl = next.baseUrl; cfg.endpoint = next.endpoint; cfg.apiKey = next.apiKey; cfg.protocol = next.protocol;
  state.model = cfg.model; state.provider = cfg.provider;
  state.modelLabel = modelLabel(cfg) || cfg.model || '';
  state.seenThinking = false;
  // Update context window when switching models.
  state.ctxMax = cfg.maxContextTokens || state.ctxMax;
  try { if (cfg.model) rememberModel(cfg.model); } catch {}
}

function setEffort(state, cfg, value) {
  state.effort = value;
  state.reasoning = !!value && value !== 'off';
  cfg.effort = state.reasoning ? value : '';
}

function registerProvider(state, cfg, h, name, baseUrl, apiKey, protocol, typeLabel) {
  addProvider(name, { base_url: baseUrl, api_key: apiKey, protocol });
  cfg.raw.providers = cfg.raw.providers || {};
  cfg.raw.providers[name] = { base_url: baseUrl || undefined, api_key: apiKey || undefined, protocol };
  applyModel(state, cfg, resolveProvider(cfg, name));
  h.notice(`Provider added: ${name} (${typeLabel}) → ${hncodeConfigFile()}`, 'info');
  fetchAndRegisterModels(state, cfg, name, h);
}

async function fetchAndRegisterModels(state, cfg, providerName, h) {
  const p = (cfg.raw.providers || {})[providerName] || {};
  const baseUrl = p.base_url || p.baseUrl || '';
  if (!baseUrl) return;
  h.notice(`Discovering models for ${providerName}…`, 'info');
  const models = await fetchModels({ baseUrl, apiKey: p.api_key || p.apiKey || '', protocol: p.protocol || 'openai' });
  if (!models.length) { h.notice(`No models discovered for ${providerName} (endpoint unreachable or empty).`, 'error'); return; }
  cfg.raw.models = cfg.raw.models || {};
  for (const m of models) {
    addModel(providerName, m.id, { display_name: m.display, contextLength: m.contextLength, maxTokens: m.maxTokens });
    cfg.raw.models[modelKey(providerName, m.id)] = {
      provider: providerName,
      model: m.id,
      display_name: m.display || undefined,
      maxTokens: m.maxTokens || undefined,
      contextLength: m.contextLength || undefined,
      ownedBy: m.ownedBy || undefined,
      reasoning: m.reasoning || undefined,
      efforts: m.efforts || undefined,
    };
  }
  h.notice(`Discovered ${models.length} models for ${providerName}. Use /model to pick one.`, 'info');
}

function buildMarkdown(session) {
  const parts = [`# ${session.title || session.id || 'hncode session'}`, ''];
  for (const m of (session.messages || [])) {
    const who = m.role === 'user' ? '**User**' : m.role === 'assistant' ? '**Assistant**' : `**${m.role}**`;
    parts.push(`${who}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '', null, 2)}`);
    if (m.toolCalls && m.toolCalls.length) {
      for (const tc of m.toolCalls) parts.push(`- tool: ${tc.name}(${JSON.stringify(tc.args || {})})`);
    }
  }
  return parts.join('\n');
}

// ---- key tokenizer (raw bytes -> tokens) ----
function tokenize(str) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === ESC && str.startsWith('\x1b[200~', i)) {
      const end = str.indexOf('\x1b[201~', i + 6);
      if (end === -1) break;
      out.push({ paste: str.slice(i + 6, end) });
      i = end + 6;
      continue;
    }
    if (c === ESC) {
      const ku = /^\x1b\[(\d+)(?:;(\d+))?(?::\d+)?u/.exec(str.slice(i));
      if (ku) {
        const cp = parseInt(ku[1], 10);
        const mod = ku[2] ? parseInt(ku[2], 10) - 1 : 0;
        const shift = (mod & 1) !== 0, alt = (mod & 2) !== 0, ctrl = (mod & 4) !== 0;
        if ((cp === 13 || cp === 10) && shift) { out.push({ key: 'newline' }); i += ku[0].length; continue; }
        if (cp === 13 || cp === 10) { out.push({ key: 'enter' }); i += ku[0].length; continue; }
        if (cp === 9) { out.push({ key: shift ? 'shift-tab' : 'tab' }); i += ku[0].length; continue; }
        if (cp === 27) { out.push({ key: 'escape' }); i += ku[0].length; continue; }
        if (!ctrl && !alt && cp >= 32) {
          out.push({ ch: String.fromCodePoint(cp) });
          i += ku[0].length; continue;
        }
        if (ctrl && shift && !alt) {
          // Ctrl+Shift+<letter> needs its own token. Collapsing it into 'c-<x>'
          // made Ctrl+Shift+C indistinguishable from Ctrl+C, so "copy" ran the
          // interrupt / exit-confirmation path instead.
          const ch = ctrlLetter(cp);
          if (ch) { out.push({ key: 'c-s-' + ch }); i += ku[0].length; continue; }
        }
        if (ctrl && !alt) {
          const ch = ctrlLetter(cp);
          if (ch) { out.push({ key: 'c-' + ch }); i += ku[0].length; continue; }
        }
        i += ku[0].length; continue;
      }
      if (str[i + 1] === '[') {
        if (str[i + 2] === '<') {
          const mm = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(str.slice(i));
          if (!mm) break;
          const btn = parseInt(mm[1], 10);
          const mcol = parseInt(mm[2], 10);
          const mrow = parseInt(mm[3], 10);
          const press = mm[4] === 'M';
          if ((btn & 64) === 64) {
            out.push({ key: (btn & 1) ? 'wheeldown' : 'wheelup', col: mcol, row: mrow });
          } else if (press && (btn & 3) === 0 && (btn & 32) === 0) {
            out.push({ key: 'mousedown', button: 'left', col: mcol, row: mrow });
          } else if (press && (btn & 32) === 32 && (btn & 3) === 3) {
            out.push({ key: 'mousehover', col: mcol, row: mrow });
          } else if (press && (btn & 32) === 32) {
            out.push({ key: 'mousemove', button: 'left', col: mcol, row: mrow });
          } else if (!press && (btn & 3) === 0) {
            out.push({ key: 'mouseup', button: 'left', col: mcol, row: mrow });
          } else if (press && (btn & 3) === 2) {
            out.push({ key: 'rightclick', col: mcol, row: mrow });
          }
          i += mm[0].length;
          continue;
        }
        let j = i + 2;
        while (j < str.length && str[j] >= '0' && str[j] <= '9') j++;
        if (str[j] === '?') { j++; while (j < str.length && str[j] >= '0' && str[j] <= '9') j++; }
        const fin = str[j];
        if (fin === undefined || !/[A-Za-z~]/.test(fin)) break;
        const params = (str.slice(i + 2, j).match(/^\d+/) || [''])[0];
        out.push({ key: csiName(params, fin) });
        i = j + 1;
      } else if (str[i + 1] === 'O') {
        const f = str[i + 2];
        if (f === undefined) break;
        out.push({ key: f === 'P' ? 'f1' : 'escape' });
        i += 3;
      } else {
        out.push({ key: 'escape' });
        i++;
      }
    } else if (c === '\r') {
      out.push({ key: 'enter' });
      i++;
      if (str[i] === '\n') i++;
    }
    else if (c === '\n') { out.push({ key: 'newline' }); i++; }
    else if (c === '\t') { out.push({ key: 'tab' }); i++; }
    else if (c === '\x03') { out.push({ key: 'c-c' }); i++; }
    else if (c === '\x02') { out.push({ key: 'c-b' }); i++; }
    else if (c === '\x04') { out.push({ key: 'c-d' }); i++; }
    else if (c === '\x0f') { out.push({ key: 'c-o' }); i++; }
    else if (c === '\x14') { out.push({ key: 'c-t' }); i++; }
    else if (c === '\x13') { out.push({ key: 'c-s' }); i++; }
    // Ctrl+V arrives as the raw control byte 0x16 (terminals do not wrap it in a
    // CSI-u sequence unless the Kitty protocol maps it), so it needs an explicit
    // entry here — otherwise it fell through to { ch: '\x16' } and was dropped.
    else if (c === '\x16') { out.push({ key: 'c-v' }); i++; }
    else if (c === '\x7f' || c === '\x08') { out.push({ key: 'backspace' }); i++; }
    else { out.push({ ch: c }); i++; }
  }
  return { tokens: out, rest: str.slice(i) };
}
// Lower-case letter (or space) a control-key code point stands for, else null.
function ctrlLetter(cp) {
  if (cp >= 97 && cp <= 122) return String.fromCharCode(cp);
  if (cp >= 65 && cp <= 90) return String.fromCharCode(cp + 32);
  if (cp === 32) return ' ';
  return null;
}
function csiName(params, fin) {
  if (fin === 'A') return 'up';
  if (fin === 'B') return 'down';
  if (fin === 'C') return 'right';
  if (fin === 'D') return 'left';
  if (fin === 'F') return 'end';
  if (fin === 'H') return 'home';
  if (fin === 'Z') return 'shift-tab';
  if (fin === '~') {
    const n = parseInt(params || '0', 10);
    if (n === 1 || n === 7) return 'home';
    if (n === 3) return 'delete';
    if (n === 4 || n === 8) return 'end';
    if (n === 5) return 'pageup';
    if (n === 6) return 'pagedown';
    return 'escape';
  }
  return 'escape';
}

// ---- TUI entry point ----
export async function startTUI(opts) {
  const { cfg, session } = opts;
  
  // FIRST: Ensure model is initialized before restoring session
  if (!cfg.model || !cfg.innerModel) {
    // Model not set yet - use default or prompt user
    if (!cfg.model) {
      console.log('No model configured. Please run /model to select one.');
      return 1;
    }
  }
  
  const state = makeState({ cfg, session, opts });
  cfg.effort = state.reasoning ? state.effort : '';
  // Force dark theme (theme removed from state)
  setTheme('dark');
  
  // Calculate initial context usage from loaded session
  if (session && session.messages && session.messages.length) {
    const approx = estimateMessagesTokens(session.messages, cfg);
    state.ctxTokens = approx;
    state.ctxPercent = usagePercent(approx, state.ctxMax);
  }
  
  // NOW: Restore session with the correct model context
  if (session && session.messages && session.messages.length) {
    state.chat = reconstructChat(session);
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const addChat = (msg) => {
    state.chat.push(normalizeMsg(msg));
    // Only auto-follow when the view is ALREADY pinned to the bottom. Forcing
    // scroll = 0 unconditionally yanked the user back down whenever new output
    // arrived — so reading history mid-turn was impossible.
    if ((state.scroll || 0) === 0) state.scroll = 0;
    renderFrame();
  };
  let noticeTimer = null;
  function notice(text, kind = 'info') {
    state.notice = text;
    state.noticeKind = kind;
    renderFrame();
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { state.notice = ''; renderFrame(); }, 4000);
  }

  function dims() {
    try {
      const [cols, rows] = stdout.getWindowSize();
      return { cols: cols || 80, rows: rows || 24 };
    } catch { return { cols: 80, rows: 24 }; }
  }
  let lastFrame = null;
  let paintScheduled = false;
  function paintNow() {
    paintScheduled = false;
    const { cols, rows } = dims();
    const frame = composeFrame(state, cols, rows);
    const out = diffFrame(lastFrame, frame);
    lastFrame = frame;
    state._hitboxes = frame.hitboxes || [];
    state._composerMeta = frame.composerMeta || [];
    if (out) stdout.write(out);
  }
  function renderFrame() { paintNow(); }
  // No frame-rate cap: paint on the next event-loop turn. Calls made within the
  // same tick still coalesce (paintScheduled), so a burst of stream deltas
  // produces one frame per tick at full speed instead of being throttled to
  // ~60fps and having intermediate frames dropped.
  function renderSoon() {
    if (paintScheduled) return;
    paintScheduled = true;
    setImmediate(paintNow);
  }
  function openPicker(p) {
    let footer = p.footer ? { focused: false, ...p.footer } : null;
    if (p.footerFor) {
      const item = (p.items || [])[Math.max(0, Math.min((p.items || []).length - 1, p.sel || 0))];
      footer = p.footerFor(item, footer) || footer;
    }
    state.picker = {
      title: p.title || '',
      items: p.items || [],
      sel: Math.max(0, Math.min((p.items || []).length - 1, p.sel || 0)),
      searchable: p.searchable !== false,
      hint: p.hint || null,
      keepInput: !!p.keepInput,
      onPick: p.onPick || (() => true),
      onDelete: p.onDelete || null,
      onCancel: p.onCancel || null,
      footerFor: p.footerFor || null,
      footer,
      categories: p.categories || null,   // list of category labels (first is "All")
      category: p.category || null,        // active category (null = "All")
    };
    state.pickerQuery = '';
    state.pickerCategory = (state.picker.categories && state.picker.categories.length)
      ? (p.category || state.picker.categories[0]) : null;
    state.form = null;
    state.menuOpen = false; state.menuList = []; state.menuSel = 0;
    // A dialog usually replaces the composer, so the half-typed prompt is
    // cleared — but the right-click context menu is an overlay ON TOP of the
    // composer and must leave it (text + caret) untouched, otherwise opening it
    // silently destroyed the prompt.
    if (!p.keepInput) { state.input = ''; state.caret = 0; }
    renderFrame();
  }

  function openForm(spec) {
    const fields = (spec.fields || []).map((f) => ({
      key: f.key, label: f.label || f.key || '', value: f.value || '',
      kind: f.kind || 'text', caret: (f.value || '').length,
    }));
    const labelW = spec.labelW || Math.max(0, ...fields.map((f) => f.label.length + 1));
    state.form = {
      title: spec.title || '',
      fields,
      fieldIdx: 0,
      type: spec.type !== undefined ? spec.type : 'OpenAI',
      hideType: !!spec.hideType,
      labelW,
      hint: spec.hint || 'Tab next field · ←/→ type · Enter submit · Esc cancel',
      onSubmit: spec.onSubmit || (() => {}),
      onCancel: spec.onCancel || null,
    };
    state.picker = null;
    state.pickerQuery = '';
    state.menuOpen = false; state.menuList = []; state.menuSel = 0;
    renderFrame();
  }

  // Open the modal multiline editor (see the `state.editor` branch in
  // composeFrame for the rendering and in handleKey for the editing keys).
  function openEditor(spec) {
    const text = String(spec.text || '');
    const ls = text.split('\n');
    const row = Math.max(0, Math.min(ls.length - 1, spec.caretRow || 0));
    state.editor = {
      title: spec.title || 'Edit',
      hint: spec.hint || 'Ctrl+S save · Esc cancel · Enter newline · arrows move',
      text,
      caretRow: row,
      caretCol: Math.max(0, Math.min((ls[row] || '').length, spec.caretCol || 0)),
      top: 0,
      notice: '',
      noticeKind: 'info',
      onSave: spec.onSave || null,
    };
    state.panel = null; state.picker = null; state.pickerQuery = ''; state.pickerCategory = null; state.form = null;
    state.menuOpen = false; state.menuList = []; state.menuSel = 0;
    renderFrame();
  }

  function openPanel(title, lines) {
    state.panel = { title: title || '', lines: lines || [], top: 0 };
    state.picker = null; state.pickerQuery = ''; state.pickerCategory = null; state.form = null;
    state.menuOpen = false; state.menuList = []; state.menuSel = 0;
    renderFrame();
  }

  if (!stdin.isTTY) {
    return 1;
  }
  let wasRaw = false;
  try { stdin.setRawMode(true); wasRaw = true; } catch { wasRaw = false; }
  stdin.resume();
  stdin.setEncoding('utf8');

  stdout.write(alternateScreen(true));
  stdout.write(clearScreen());
  stdout.write('\x1b[>1u');
  stdout.write('\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
  // Start the PowerShell clipboard helper now: its cold start is seconds long,
  // and doing it lazily on the first Ctrl+Shift+V made the shortcut look dead.
  warmClipboard();
  setTip(state);
  renderFrame();

  const tipTimer = setInterval(() => { setTip(state); renderFrame(); }, TIP_INTERVAL);
  const spinTimer = setInterval(() => {
    if (!state.running) return;
    // Monotonic tick counter — do NOT wrap it at SPINNER.length, or the
    // Working-colour cycle (which counts up to ~48 ticks) can never reach its
    // red phase. The SPINNER frame is derived with `% SPINNER.length` at the
    // call site instead.
    state.spin = (state.spin || 0) + 1;
    renderFrame();
  }, 80);

  const TOK_WINDOW_MS = 1000;
  const tokTimer = setInterval(() => {
    const times = state._tokTimes;
    if (!times || !times.length) {
      if (state.tokRate !== 0) { state.tokRate = 0; renderFrame(); }
      return;
    }
    const cutoff = Date.now() - TOK_WINDOW_MS;
    let drop = 0;
    while (drop < times.length && times[drop] < cutoff) drop++;
    if (drop) times.splice(0, drop);
    const rate = times.length;
    if (rate !== state.tokRate) { state.tokRate = rate; renderFrame(); }
  }, 50);

  let keyBuf = '';
  let escTimer = null;
  let escRetries = 0;
  let confirmTimer = null;
  const flushEsc = () => {
    escTimer = null;
    escRetries++;
    const { tokens, rest } = tokenize(keyBuf);
    keyBuf = rest;
    for (const t of tokens) handleKey(t);
    if (keyBuf) {
      if (escRetries > 4) {
        handleKey({ key: 'escape' });
        keyBuf = '';
        escRetries = 0;
      } else {
        escTimer = setTimeout(flushEsc, 40);
      }
    } else {
      escRetries = 0;
    }
  };

  stdin.on('data', (chunk) => {
    keyBuf += chunk;
    escRetries = 0;
    if (escTimer) clearTimeout(escTimer);
    const { tokens, rest } = tokenize(keyBuf);
    keyBuf = rest;
    for (const t of tokens) handleKey(t);
    if (keyBuf) {
      escTimer = setTimeout(flushEsc, 40);
    }
  });

  function mouseToCell(t) {
    const { cols } = dims();
    const col = Math.max(0, Math.min(cols - 1, (t.col || 1) - 1));
    const screenRow = (t.row || 1) - 1;
    // Body row 0 is drawn directly under the transcript padding (see
    // composeFrame), so a screen row must be shifted by that padding before
    // it is turned into a line index. Without this, clicking the blank area
    // above a short transcript yielded a negative index that was clamped to 0
    // ("start of session") and the drag selected everything from the top.
    // Body row i is drawn at screen row i (0-based) and shows transcript line
    // `_bodyTop + i`. When the transcript is shorter than the body, _bodyTop is
    // NEGATIVE — those leading rows are the blank padding, so the padding is
    // already accounted for here and must NOT be subtracted again.
    const rowInBody = screenRow;
    const lineIdx = (state._bodyTop != null ? state._bodyTop : 0) + rowInBody;
    // A negative index means no transcript line sits under the pointer; report
    // -1 so callers can ignore it (never clamp it to 0 — that is line 0, the
    // start of the session, which made a drag select from the very top).
    const idx = lineIdx < 0 ? -1 : lineIdx;
    // `row` is the canonical field the selection model uses (the same name the
    // head carries). Without it `anchor.row` was undefined and the paint loop
    // highlighted the whole transcript (see the selection range test).
    return { col, screenRow, rowInBody, lineIdx: idx, row: idx };
  }
  function isOnScrollbar(t) {
    if (!state._sb) return false;
    const { cols } = dims();
    return (t.col || 1) === cols;
  }
  function scrollFromThumb(rowInBody) {
    const sb = state._sb;
    if (!sb) return;
    const maxThumbStart = Math.max(1, sb.bodyH - sb.thumbLen);
    const frac = Math.max(0, Math.min(1, (rowInBody - (state.sbDragOffset || 0)) / maxThumbStart));
    state.scroll = Math.round((1 - frac) * sb.maxScroll);
    renderFrame();
  }
  function hitAt(t) {
    const hbs = state._hitboxes || [];
    const row = (t.row || 1) - 1;
    const col = (t.col || 1) - 1;
    for (let i = hbs.length - 1; i >= 0; i--) {
      const hb = hbs[i];
      if (hb.row === row && col >= hb.col0 && col <= hb.col1) return hb;
    }
    return null;
  }
  function dispatchHit(hb) {
    if (!hb) return false;
    switch (hb.kind) {
      case 'menuItem': {
        state.menuSel = hb.index;
        const cmd = state.menuList[hb.index];
        if (cmd) {
          state.menuOpen = false; state.menuList = []; state.menuSel = 0; state.menuOffset = 0;
          state.input = ''; state.caret = 0;
          dispatch(cmd.name, '', state, cfg, session, host, submit, stdout);
          if (state._quit) { quit(); return true; }
          renderFrame();
        }
        return true;
      }
      case 'composerRow': {
        const { cols } = dims();
        const insideW = Math.max(0, cols - 2);
        const layout = composerLayout(state, insideW - 3);
        const t = state._lastMouse;
        const clickCol = t ? (t.col || 1) - 1 : 1;
        const colInContent = Math.max(0, clickCol - 1);
        const idx = composerTextIndexAt(layout, hb.rowIdx, colInContent);
        state.caret = idx;
        // Store mousedown position for potential drag selection in the composer.
        state._composerMouseDown = { row: hb.rowIdx, col: idx, caret: idx };
        state.composerSel = null;
        renderFrame();
        return true;
      }
      case 'editor': {
        if (!state.editor) return false;
        const ed = state.editor;
        const ls = ed.text.split('\n');
        // Set caret to clicked position
        ed.caretRow = hb.row;
        ed.caretCol = Math.min((ls[ed.caretRow] || '').length, 1000); // Cap at reasonable length
        renderFrame();
        return true;
      }
      case 'pickerItem': {
        if (!state.picker) return false;
        state.picker.sel = hb.index;
        if (state.picker.footerFor) {
          const it2 = pickerFiltered(state)[hb.index];
          state.picker.footer = state.picker.footerFor(it2, state.picker.footer);
        }
        const it = pickerFiltered(state)[hb.index];
        if (it) {
          const before = state.picker;
          const done = state.picker.onPick ? state.picker.onPick(it) : true;
          if (done && state.picker === before) { state.picker = null; state.pickerQuery = ''; state.pickerCategory = null; }
          renderFrame();
        }
        return true;
      }
      case 'pickerFooterOpt': {
        if (!state.picker || !state.picker.footer) return false;
        state.picker.footer.focused = true;
        state.picker.footer.value = hb.option;
        renderFrame();
        return true;
      }
      case 'formField': {
        if (!state.form) return false;
        state.form.fieldIdx = hb.index;
        renderFrame();
        return true;
      }
      case 'formType': {
        if (!state.form) return false;
        state.form.fieldIdx = (state.form.fields || []).length;
        state.form.type = hb.option;
        renderFrame();
        return true;
      }
      default:
        return false;
    }
  }
  function handleMouse(t) {
    state._lastMouse = t;
    if (t.key === 'mousedown') {
      const hb = hitAt(t);
      if (hb && dispatchHit(hb)) return;
    }
    if (state.picker || state.form || state.panel || state.editor) {
      if (t.key === 'wheelup' || t.key === 'wheeldown') handleKey(t);
      return;
    }
    if (t.key === 'mousedown') {
      if (isOnScrollbar(t)) {
        const sb = state._sb;
        const { rowInBody } = mouseToCell(t);
        state.sbDrag = true;
        state.sbDragOffset = (rowInBody >= sb.thumbStart && rowInBody < sb.thumbStart + sb.thumbLen)
          ? rowInBody - sb.thumbStart : Math.floor(sb.thumbLen / 2);
        scrollFromThumb(rowInBody);
        return;
      }
      // The todo panel's top rule is a resize handle: pressing it starts a drag,
      // and the panel height follows the pointer (clamped to 1..all todos). This
      // must come before the transcript-selection arming below, otherwise the
      // press would start a text selection instead.
      const hitTodo = hitAt(t);
      if (hitTodo && hitTodo.kind === 'todoResize') {
        state.todoResizeDrag = true;
        state.todoResizeStart = { row: t.row, rows: todoRowCount(state) };
        renderFrame();
        return;
      }
      // Don't start selection on single click, wait for drag.
      const cell = mouseToCell(t);
      // Pressing the padding above the transcript must NOT arm a selection:
      // clamping the index to 0 (as this used to) made the anchor "line 0",
      // so a later drag highlighted from the start of the session.
      state._mouseDownPos = (cell.lineIdx < 0) ? null : { row: cell.lineIdx, col: cell.col };
      // A new press always starts a NEW selection: keeping the previous
      // anchor made the next drag highlight everything from the FIRST press
      // to the new pointer position. Cleared to null here and replaced on the
      // first mousemove of this press, so a plain click selects nothing.
      state.selection = null;
      renderFrame();
      return;
    }
    if (t.key === 'mousehover') {
      const onBar = state._sb ? isOnScrollbar(t) : false;
      if (onBar !== state.sbHover) { state.sbHover = onBar; renderFrame(); }
      const hb = hitAt(t);
      // The todo resize handle gets its own hover flag so its rule lights up.
      const onTodoRule = !!(hb && hb.kind === 'todoResize');
      if (onTodoRule !== state.todoResizeHover) { state.todoResizeHover = onTodoRule; renderFrame(); }
      // The composer rows stay click targets (mousedown places the caret), but
      // they are NOT highlighted on hover — tinting the prompt you are typing
      // is noise, not feedback.
      const next = (hb && hb.kind !== 'composerRow') ? { row: hb.row, col0: hb.col0, col1: hb.col1 } : null;
      const prev = state.hoverHit;
      const changed = (!!next !== !!prev)
        || (next && prev && (next.row !== prev.row || next.col0 !== prev.col0 || next.col1 !== prev.col1));
      if (changed) { state.hoverHit = next; renderFrame(); }
      return;
    }
    if (t.key === 'mousemove') {
      if (state.sbDrag) { scrollFromThumb(mouseToCell(t).rowInBody); return; }
      // Dragging the todo rule resizes the panel: moving UP shows more rows.
      if (state.todoResizeDrag) {
        const start = state.todoResizeStart || { row: t.row, rows: todoRowCount(state) };
        const delta = start.row - (t.row || 1);          // up = positive = more rows
        const want = start.rows + delta;
        const total = (state.todos || []).length;
        const clamped = Math.max(1, Math.min(total || 1, want));
        if (clamped !== state.todoRows) { state.todoRows = clamped; renderFrame(); }
        return;
      }
      // Composer text selection: drag from a composer mousedown.
      if (state._composerMouseDown) {
        const hb = hitAt(t);
        if (hb && hb.kind === 'composerRow') {
          const { cols } = dims();
          const insideW = Math.max(0, cols - 2);
          const layout = composerLayout(state, insideW - 3);
          const clickCol = (t.col || 1) - 1;
          const colInContent = Math.max(0, clickCol - 1);
          const idx = composerTextIndexAt(layout, hb.rowIdx, colInContent);
          state.caret = idx;
          state.composerSel = { anchor: state._composerMouseDown.caret, head: idx };
          renderFrame();
        }
        return;
      }
      // Start selection on drag from mousedown position
      if (state._mouseDownPos) {
        const { col, lineIdx } = mouseToCell(t);
        if (lineIdx < 0) return;   // above the first line: nothing to anchor to
        if (!state.selection) {
          state.selection = { anchor: state._mouseDownPos, head: { row: lineIdx, col } };
          renderFrame();
        } else {
          state.selection.head = { row: lineIdx, col };
          renderFrame();
        }
        return;
      }
      return;
    }
    if (t.key === 'mouseup') {
      state._mouseDownPos = null;
      state._composerMouseDown = null;
      if (state.todoResizeDrag) {
        // Finish the resize. Keep the hover flag in sync with where the pointer is.
        state.todoResizeDrag = false;
        state.todoResizeStart = null;
        state.todoResizeHover = !!(hitAt(t) && hitAt(t).kind === 'todoResize');
        renderFrame();
        return;
      }
      if (state.sbDrag) {
        state.sbDrag = false;
        state.sbHover = isOnScrollbar(t);
        renderFrame();
        return;
      }
      // Click on empty area: clear selection
      if (state.selection) {
        const a = state.selection.anchor;
        const h = state.selection.head;
        if (a.row === h.row && a.col === h.col) {
          state.selection = null;
        }
      }
      renderFrame();
      return;
    }
    if (t.key === 'rightclick') {
      openContextMenu(t);
      return;
    }
  }
  function selectionText() {
    const sel = state.selection;
    if (!sel || !sel.anchor || !sel.head) return '';
    const { cols } = dims();
    const rawChat = renderChatLines(state, cols);
    const a = sel.anchor, h = sel.head;
    const start = (h.row < a.row || (h.row === a.row && h.col < a.col)) ? h : a;
    const end = start === a ? h : a;

    const out = [];
    for (let r = Math.max(0, start.row); r <= Math.min(rawChat.length - 1, end.row); r++) {
      // renderChatLines() returns ANSI STRINGS (rowToLine), not {spans}
      // objects — reading .spans here threw "Cannot read properties of
      // undefined (reading 'map')" on every copy. Strip the escapes instead.
      const plain = stripAnsi(String(rawChat[r] || ''));
      let c0, c1;

      // +1: the end column is the cell UNDER the pointer, so it is included.
      if (start.row === end.row) { c0 = start.col; c1 = end.col + 1; }
      else if (r === start.row) { c0 = start.col; c1 = Infinity; }
      else if (r === end.row) { c0 = 0; c1 = end.col + 1; }
      else { c0 = 0; c1 = Infinity; }

      const sliced = slicePlainByCol(plain, c0, c1);
      const clean = sliced
        .replace(/<\/?thinking\b[^>]*>/gi, '')
        .replace(/<\/?think\b[^>]*>/gi, '');
      out.push(clean.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }
  function slicePlainByCol(text, c0, c1) {
    if (c0 === 0 && c1 === Infinity) return text;
    let out = '';
    let col = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; /* manual */) {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const cw = visualWidth(ch);
      if (col >= c0 && (c1 === Infinity || col < c1)) out += ch;
      col += cw;
      i += cp > 0xffff ? 2 : 1;
      if (c1 !== Infinity && col >= c1) break;
    }
    return out;
  }
  function copyToClipboard(text) {
    if (!text) return;
    try {
      copyText(text); // src/clipboard.js: clip.exe on Windows (~100ms, UTF-16LE)
      const n = text.split('\n').length;
      notice(`Copied ${text.length} chars (${n} line${n === 1 ? '' : 's'})`, 'info');
    } catch { notice('Clipboard unavailable', 'error'); }
  }
  // Insert pasted text into the composer, collapsing a multi-line paste into a
  // single [paste #N +L lines] marker. Shared by a bracketed paste (what
  // Ctrl+Shift+V sends in most terminals), the Ctrl+Shift+V shortcut and the
  // right-click menu's Paste, so all three behave identically.
  function insertComposerPaste(raw) {
    const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    if (!text) return false;
    const lineCount = text.split('\n').length;
    let insert = text;
    if (lineCount > 1) {
      const id = ++state.pasteCounter;
      state.pastes.set(id, { text, lines: lineCount });
      insert = pasteMarker(id, lineCount);
    }
    state.input = (state.input || '').slice(0, state.caret) + insert + (state.input || '').slice(state.caret);
    state.caret += insert.length;
    refreshMenu(state);
    return true;
  }
  // Async so the notice can be painted BEFORE the clipboard read: a cold
  // PowerShell took ~3s, which read as "the shortcut does nothing".
  async function pasteFromClipboard(fastPathOnly = false) {
    notice('Pasting…', 'info');
    // One probe handles every clipboard shape: copied FILES (→ paths), plain
    // TEXT (→ text), or an IMAGE (→ a temp .png path). The async version runs it
    // on the PRE-WARMED helper (~10ms) instead of a cold spawn (~2.9s).
    const { text, via } = await readClipboardContentAsync();
    if (text) {
      insertComposerPaste(text);
      notice(via === 'text' ? 'Pasted' : `Pasted ${via} as path`, 'info');
      renderFrame();
      return;
    }
    // Fast path failed — only fall back to the slow warm-helper reader when this
    // is a full paste (Ctrl+Shift+V), not a right-click quick paste.
    if (fastPathOnly) {
      notice('Clipboard empty or unavailable', 'error');
      renderFrame();
      return;
    }
    const result = await readText();
    if (!result.text) { notice('Clipboard empty or unavailable', 'error'); renderFrame(); return; }
    insertComposerPaste(result.text);
    notice(`Pasted via ${result.via}`, 'info');
    renderFrame();
  }
  // Ctrl-S: inject the queued messages (plus the current draft) into the RUNNING
  // turn instead of waiting for it to finish. Mirrors kimi-code's onCtrlS: only
  // meaningful while streaming, and the injected text shows up in the transcript
  // at the point it was steered. Agent.steer() buffers it for the next model
  // call, since nothing can be injected into a request already in flight.
  function steerAll() {
    if (!state.running || !state.agent) {
      notice('Nothing to steer into (the agent is idle)', 'error');
      renderFrame();
      return;
    }
    const items = (state.queued || []).slice();
    const draft = String(state.input || '').trim();
    if (draft) items.push(draft);
    if (!items.length) {
      notice('Nothing queued to steer', 'error');
      renderFrame();
      return;
    }
    for (const text of items) {
      state.agent.steer(text);
      // Show steered messages as `steer` role (no box, yellow) in the output area.
      addChat({ role: 'steer', text });
    }
    // The queue is consumed. The draft was steered too, so clear it (kimi clears
    // the editor for a steered draft).
    if (draft) { state.input = ''; state.caret = 0; state.pastes.clear(); state.pasteCounter = 0; }
    state.queued = [];
    renderFrame();
  }

  // ↑ with an empty composer recalls the LAST queued message for editing instead
  // of walking the history (kimi's "↑ to edit" in the queue pane).
  function recallQueued() {
    if (!state.queued || !state.queued.length) return false;
    const text = state.queued[state.queued.length - 1];
    state.queued = state.queued.slice(0, -1);
    state.input = text;
    state.caret = text.length;
    // Drop the matching transcript entry: the item is back in the composer.
    for (let i = state.chat.length - 1; i >= 0; i--) {
      if (state.chat[i].role === 'queued' && state.chat[i].text === text) { state.chat.splice(i, 1); break; }
    }
    refreshMenu(state);
    renderFrame();
    return true;
  }

  function openContextMenu(t) {
    const hasSel = !!(state.selection && state.selection.anchor && state.selection.head);
    const hasComposerSel = !!(state.composerSel && state.composerSel.anchor !== state.composerSel.head);
    const items = [];
    if (hasSel) items.push({ label: 'Copy', sub: 'copy the selected text', action: 'copy', primary: true });
    if (hasComposerSel) items.push({ label: 'Copy', sub: 'copy the selected composer text', action: 'copy-composer', primary: true });
    items.push({ label: 'Copy last answer', sub: 'copy the last assistant message', action: 'copy-last' });
    items.push({ label: 'Clear selection', sub: 'drop the current selection', action: 'clear' });
    if (hasComposerSel) items.push({ label: 'Clear composer selection', sub: 'drop the composer selection', action: 'clear-composer' });
    items.push({ label: 'Paste', sub: 'paste the clipboard into the composer', action: 'paste' });
    openPicker({
      title: 'Actions',
      items,
      searchable: false,
      keepInput: true, // the composer's text and caret must survive this menu
      hint: '↑↓ navigate · Enter run · Esc cancel',
      onPick: (it) => {
        if (it.action === 'copy') copyToClipboard(selectionText());
        else if (it.action === 'copy-composer') {
          const sel = state.composerSel;
          const a = Math.min(sel.anchor, sel.head);
          const h = Math.max(sel.anchor, sel.head);
          copyToClipboard((state.input || '').slice(a, h));
        }
        else if (it.action === 'copy-last') {
          const last = [...state.chat].reverse().find((m) => m.role === 'assistant' && (m.text || '').trim());
          if (last) copyToClipboard(last.text); else notice('No assistant message to copy', 'error');
        } else if (it.action === 'clear') { state.selection = null; }
        else if (it.action === 'clear-composer') { state.composerSel = null; }
        else if (it.action === 'paste') {
          // Same path as a bracketed paste / Ctrl+Shift+V: multi-line content
          // collapses into a [paste #N +L lines] marker instead of dumping the
          // raw text (the old code also stripped a real trailing newline).
          void pasteFromClipboard();
        }
        renderFrame();
        return true;
      },
    });
    renderFrame();
  }

  function handleKey(t) {
    if (t.key === 'mousedown' || t.key === 'mousemove' || t.key === 'mouseup' || t.key === 'rightclick' || t.key === 'mousehover') {
      handleMouse(t);
      return;
    }
    // Handle approval prompt - must be before all other input
    if (state.approvalPending) {
      if (t.key === 'enter' || t.key === ' ') {
        const resolve = state.approvalPending.resolve;
        state.approvalPending = null;
        resolve(true);
        renderFrame();
        return;
      }
      if (t.key === 'escape') {
        const resolve = state.approvalPending.resolve;
        state.approvalPending = null;
        resolve(false);
        renderFrame();
        return;
      }
      // Everything else (typing, arrows, paste, backspace) belongs to the
      // composer: only Enter/Esc are reserved for the prompt, so the user can
      // keep drafting while deciding.
      if (t.key === 'c-c') return;
    }
    if (t.key === 'c-c') {
      // An open overlay consumes Ctrl+C: close it instead of interrupting the
      // turn that is still running behind it.
      if (state.menuOpen || state.picker || state.form || state.panel) {
        if (state.picker) { const cb = state.picker.onCancel; state.picker = null; if (cb) cb(); }
        if (state.form) { const cb = state.form.onCancel; state.form = null; if (cb) cb(); }
        state.panel = null;
        state.menuOpen = false; state.menuList = []; state.menuSel = 0; state.menuOffset = 0;
        renderFrame();
        return;
      }
      if (state.running) {
        if (state.agent) state.agent.interrupt();
      }
      if (state.confirmExit) { quit(); return; }
      state.confirmExit = true;
      renderFrame();
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { state.confirmExit = false; renderFrame(); }, 3000);
      return;
    }
    if (state.confirmExit) { state.confirmExit = false; if (confirmTimer) clearTimeout(confirmTimer); }

    if (t.key === 'c-s-c') {
      // Ctrl+Shift+C: copy the mouse selection, else the last answer — the same
      // two actions as the right-click menu's Copy / Copy last answer. Works
      // while the agent is streaming too. (Only terminals that can report
      // modified keys — the kitty keyboard protocol hncode already enables —
      // can tell Ctrl+Shift+C from Ctrl+C; a terminal that sends ^C for both
      // cannot.)
      const sel = (state.selection && state.selection.anchor) ? selectionText() : '';
      if (sel) copyToClipboard(sel);
      else {
        const composerSel = state.composerSel;
        if (composerSel && composerSel.anchor !== composerSel.head) {
          const a = Math.min(composerSel.anchor, composerSel.head);
          const h = Math.max(composerSel.anchor, composerSel.head);
          copyToClipboard((state.input || '').slice(a, h));
        } else {
          const last = [...state.chat].reverse().find((m) => m.role === 'assistant' && (m.text || '').trim());
          if (last) copyToClipboard(last.text); else notice('Nothing to copy', 'error');
        }
      }
      renderFrame();
      return;
    }

    if (t.key === 'c-s-v') {
      // Ctrl+Shift+V: paste the clipboard like a bracketed paste. A terminal
      // that handles Ctrl+Shift+V itself sends the 200~/201~ sequence, which the
      // tokenizer turns into a {paste} token and which reads the same as this
      // shortcut from the user's point of view.
      void pasteFromClipboard();
      return;
    }

    if (t.key === 'c-b') {
      const fg = state.agent && state.agent.ctx && state.agent.ctx._foreground;
      if (fg && typeof fg.detach === 'function') {
        const id = fg.detach();
        if (id) {
          notice(`Moved to background: ${id}`, 'info');
          renderFrame();
          return;
        }
      }
    }

    if (t.key === 'c-s' && !state.editor) {
      steerAll();
      return;
    }

    if (t.key === 'c-t' && !state.editor) {
      state.todosExpanded = !state.todosExpanded;
      renderFrame();
      return;
    }

    if (t.key === 'c-o' && !state.editor) {
      state.expanded = !state.expanded;
      notice(state.expanded ? 'Expanded tool output' : 'Collapsed tool output', 'info');
      renderFrame();
      return;
    }

    // ↑ with an empty composer recalls the newest QUEUED message for editing
    // (the queue pane advertises this as "↑ to edit"). This MUST be handled
    // before the running/idle split below: queued messages only exist while the
    // agent is running, so the idle-only branch that used to hold this was
    // unreachable dead code and ↑ scrolled the chat instead.
    {
      const overlay = state.picker || state.form || state.panel || state.menuOpen || state.editor;
      const cur = state.input || '';
      if (!overlay && cur === '' && t.key === 'up' && (state.queued || []).length) {
        recallQueued();
        return;
      }
    }

    // A dialog (/settings, /model, /provider, /sessions, an approval panel, …)
    // owns the keyboard while it is open: Esc closes IT rather than aborting the
    // running turn, and the arrows move its selection instead of scrolling the
    // transcript. Without this guard the running block below stole those keys.
    // The modal editor (e.g. from /set-system-prompt) is included so that Esc and
    // arrow keys are handled by it, not by the running-turn interrupt/scroll logic.
    const overlayOpen = !!(state.picker || state.form || state.panel || state.menuOpen || state.editor);
    if (state.running && !overlayOpen) {
      if (t.key === 'escape') {
        if (state.agent) state.agent.interrupt();
        return;
      }
      if (t.key === 'pageup' || t.key === 'pagedown') {
        scrollChat(state, t.key === 'pageup' ? 10 : -10);
        renderFrame(); return;
      }
      if (t.key === 'wheelup' || t.key === 'wheeldown') {
        scrollChat(state, t.key === 'wheelup' ? 3 : -3);
        renderFrame(); return;
      }
      if (t.key === 'up' || t.key === 'down') {
        scrollChat(state, t.key === 'up' ? 3 : -3);
        renderFrame(); return;
      }
    }
    else {
      if (t.key === 'up' || t.key === 'down') {
        const overlay = state.picker || state.form || state.panel || state.menuOpen || state.editor;
        const cur = state.input || '';
        if (!overlay && cur === '' && state.history.length) {
          if (state.historyIdx === -1) state.historyIdx = state.history.length;
          state.historyIdx = t.key === 'up' ? Math.max(0, state.historyIdx - 1) : Math.min(state.history.length, state.historyIdx + 1);
          state.input = state.historyIdx >= state.history.length ? '' : (state.history[state.historyIdx] || '');
          state.caret = state.input.length;
          refreshMenu(state); renderFrame(); return;
        }
      }
    }

    if (state.editor) {
      // Modal multiline editor. Ctrl+S saves, Esc cancels, Enter inserts a
      // newline; the arrows/Home/End move the caret and the view follows it.
      const ed = state.editor;
      const setText = (text, row, col) => {
        ed.text = text;
        const ls = text.split('\n');
        ed.caretRow = Math.max(0, Math.min(ls.length - 1, row));
        ed.caretCol = Math.max(0, Math.min((ls[ed.caretRow] || '').length, col));
        renderFrame();
      };
      const curLines = () => ed.text.split('\n');
      if (t.key === 'escape') { state.editor = null; renderFrame(); return; }
      // Ctrl+S: save.
      if (t.key === 'c-s') {
        const cb = ed.onSave;
        state.editor = null;
        try { if (cb) cb(ed.text); } catch (e) { notice('Save failed: ' + e.message, 'error'); }
        renderFrame();
        return;
      }
      if (t.key === 'up' || t.key === 'down') {
        const ls = curLines();
        const r = Math.max(0, Math.min(ls.length - 1, ed.caretRow + (t.key === 'up' ? -1 : 1)));
        setText(ed.text, r, ed.caretCol);
        return;
      }
      if (t.key === 'left') { setText(ed.text, ed.caretRow, ed.caretCol - 1); return; }
      if (t.key === 'right') { setText(ed.text, ed.caretRow, ed.caretCol + 1); return; }
      if (t.key === 'home') { setText(ed.text, ed.caretRow, 0); return; }
      if (t.key === 'end') { setText(ed.text, ed.caretRow, (curLines()[ed.caretRow] || '').length); return; }
      if (t.key === 'pageup') { setText(ed.text, ed.caretRow - 10, ed.caretCol); return; }
      if (t.key === 'pagedown') { setText(ed.text, ed.caretRow + 10, ed.caretCol); return; }
      if (t.key === 'enter' || t.key === 'newline') {
        const ls = curLines();
        const line = ls[ed.caretRow] || '';
        ls[ed.caretRow] = line.slice(0, ed.caretCol);
        ls.splice(ed.caretRow + 1, 0, line.slice(ed.caretCol));
        setText(ls.join('\n'), ed.caretRow + 1, 0);
        return;
      }
      if (t.key === 'backspace') {
        const ls = curLines();
        const line = ls[ed.caretRow] || '';
        if (ed.caretCol > 0) {
          ls[ed.caretRow] = line.slice(0, ed.caretCol - 1) + line.slice(ed.caretCol);
          setText(ls.join('\n'), ed.caretRow, ed.caretCol - 1);
        } else if (ed.caretRow > 0) {
          const prev = ls[ed.caretRow - 1] || '';
          ls.splice(ed.caretRow, 1);
          ls[ed.caretRow - 1] = prev + line;
          setText(ls.join('\n'), ed.caretRow - 1, prev.length);
        }
        return;
      }
      if (t.key === 'delete') {
        const ls = curLines();
        const line = ls[ed.caretRow] || '';
        if (ed.caretCol < line.length) {
          ls[ed.caretRow] = line.slice(0, ed.caretCol) + line.slice(ed.caretCol + 1);
          setText(ls.join('\n'), ed.caretRow, ed.caretCol);
        } else if (ed.caretRow < ls.length - 1) {
          ls[ed.caretRow] = line + (ls[ed.caretRow + 1] || '');
          ls.splice(ed.caretRow + 1, 1);
          setText(ls.join('\n'), ed.caretRow, ed.caretCol);
        }
        return;
      }
      if (t.ch) {
        const ls = curLines();
        const line = ls[ed.caretRow] || '';
        ls[ed.caretRow] = line.slice(0, ed.caretCol) + t.ch + line.slice(ed.caretCol);
        setText(ls.join('\n'), ed.caretRow, ed.caretCol + t.ch.length);
        return;
      }
      if (t.paste !== undefined) {
        const ls = curLines();
        const line = ls[ed.caretRow] || '';
        const ins = String(t.paste).replace(/\r\n/g, '\n');
        const parts = (line.slice(0, ed.caretCol) + ins + line.slice(ed.caretCol)).split('\n');
        ls.splice(ed.caretRow, 1, ...parts);
        setText(ls.join('\n'), ed.caretRow + parts.length - 1, parts[parts.length - 1].length);
        return;
      }
      return;
    }

    if (state.panel) {
      const p = state.panel;
      if (t.key === 'escape') { state.panel = null; renderFrame(); return; }
      if (t.key === 'up') { p.top = Math.max(0, (p.top || 0) - 1); renderFrame(); return; }
      if (t.key === 'down') { p.top = (p.top || 0) + 1; renderFrame(); return; }
      if (t.key === 'pageup') { p.top = Math.max(0, (p.top || 0) - 10); renderFrame(); return; }
      if (t.key === 'pagedown') { p.top = (p.top || 0) + 10; renderFrame(); return; }
      if (t.key === 'home') { p.top = 0; renderFrame(); return; }
      return;
    }

    if (state.form) {
      const f = state.form;
      const nRows = f.fields.length + (f.hideType ? 0 : 1);
      const onType = !f.hideType && f.fieldIdx >= f.fields.length;
      const field = f.fields[f.fieldIdx];
      if (t.key === 'escape') { const cb = f.onCancel; state.form = null; if (cb) cb(); renderFrame(); return; }
      if (t.key === 'up') { f.fieldIdx = (f.fieldIdx - 1 + nRows) % nRows; renderFrame(); return; }
      if (t.key === 'down') { f.fieldIdx = (f.fieldIdx + 1) % nRows; renderFrame(); return; }
      if (t.key === 'tab') { f.fieldIdx = (f.fieldIdx + 1) % nRows; renderFrame(); return; }
      if (onType) {
        if (t.key === 'left' || t.key === 'right' || t.ch === ' ') {
          f.type = f.type === 'OpenAI' ? 'Anthropic' : 'OpenAI';
          renderFrame(); return;
        }
        if (t.key === 'enter') {
          const values = {};
          for (const fl of f.fields) values[fl.key] = fl.value.trim();
          const submit = f.onSubmit; state.form = null; submit(values, f.type); renderFrame(); return;
        }
        return;
      }
      if (t.key === 'left') { field.caret = Math.max(0, field.caret - 1); renderFrame(); return; }
      if (t.key === 'right') { field.caret = Math.min(field.value.length, field.caret + 1); renderFrame(); return; }
      if (t.key === 'home') { field.caret = 0; renderFrame(); return; }
      if (t.key === 'end') { field.caret = field.value.length; renderFrame(); return; }
      if (t.key === 'backspace') {
        if (field.caret > 0) { field.value = field.value.slice(0, field.caret - 1) + field.value.slice(field.caret); field.caret--; }
        renderFrame(); return;
      }
      if (t.key === 'delete') {
        if (field.caret < field.value.length) { field.value = field.value.slice(0, field.caret) + field.value.slice(field.caret + 1); }
        renderFrame(); return;
      }
      if (t.paste !== undefined) {
        const text = String(t.paste).replace(/[\r\n]+/g, '');
        field.value = field.value.slice(0, field.caret) + text + field.value.slice(field.caret);
        field.caret += text.length;
        renderFrame(); return;
      }
      if (t.key === 'enter') {
        const values = {};
        for (const fl of f.fields) values[fl.key] = fl.value.trim();
        const submit = f.onSubmit; state.form = null; submit(values, f.type); renderFrame(); return;
      }
      if (t.ch) { field.value = field.value.slice(0, field.caret) + t.ch + field.value.slice(field.caret); field.caret++; renderFrame(); return; }
      return;
    }

    if (state.picker) {
      const list = pickerFiltered(state);
      const foot = state.picker.footer;
      if (foot) {
        if (t.key === 'left' || t.key === 'right') {
          const i = Math.max(0, foot.options.indexOf(foot.value));
          const d = (t.key === 'right') ? 1 : -1;
          foot.value = foot.options[(i + d + foot.options.length) % foot.options.length];
          renderFrame(); return;
        }
        if (t.key === 'tab') { 
          // If there are multiple categories, Tab cycles them first
          if (state.picker.categories && state.picker.categories.length > 1) {
            const cats = state.picker.categories;
            const active = state.pickerCategory || cats[0];
            const idx = Math.max(0, cats.indexOf(active));
            const next = (idx + 1) % cats.length;
            state.pickerCategory = cats[next];
            state.picker.sel = 0;
            state.pickerQuery = '';
            renderFrame(); return;
          }
          // Otherwise toggle footer focus
          foot.focused = !foot.focused; 
          renderFrame(); 
          return; 
        }
        if (foot.focused) {
          if (t.key === 'enter') { foot.focused = false; renderFrame(); return; }
          if (t.key === 'escape') { foot.focused = false; renderFrame(); return; }
          return;
        }
      }
      if (t.key === 'wheelup' || t.key === 'wheeldown') {
        const n = list.length;
        if (!n) return;
        const cur = Math.min(state.picker.sel, n - 1);
        state.picker.sel = (cur + (t.key === 'wheeldown' ? 1 : n - 1)) % n;
        if (state.picker.footerFor) {
          const item = list[state.picker.sel];
          state.picker.footer = state.picker.footerFor(item, state.picker.footer);
        }
        renderFrame();
        return;
      }
      if (t.key === 'up' || t.key === 'down') {
        const n = list.length;
        if (!n) return;
        const cur = Math.min(state.picker.sel, n - 1);
        state.picker.sel = (cur + (t.key === 'down' ? 1 : n - 1)) % n;
        if (state.picker.footerFor) {
          const item = list[state.picker.sel];
          state.picker.footer = state.picker.footerFor(item, state.picker.footer);
        }
        renderFrame();
        return;
      }
      if (t.key === 'enter') {
        const item = list[state.picker.sel];
        if (!item) return;
        const before = state.picker;
        const done = state.picker.onPick(item);
        if (done && state.picker === before) { state.picker = null; state.pickerQuery = ''; state.pickerCategory = null; }
        renderFrame();
        return;
      }
      if (t.key === 'delete') {
        const item = list[state.picker.sel];
        if (state.picker.onDelete && item) {
          state.picker.onDelete(item);
          renderFrame();
        }
        return;
      }
      // Tab cycles categories (if the picker has them); resets selection & search.
      if (t.key === 'tab' && state.picker.categories && state.picker.categories.length > 1) {
        const cats = state.picker.categories;
        const active = state.pickerCategory || cats[0];
        const idx = Math.max(0, cats.indexOf(active));
        const next = (idx + 1) % cats.length;
        state.pickerCategory = cats[next];
        state.picker.sel = 0;
        state.pickerQuery = '';
        renderFrame(); return;
      }
      // (Ctrl+E provider edit removed: Enter now opens the edit form in /provider's onPick.)
      if (t.key === 'escape') {
        const cb = state.picker.onCancel;
        state.picker = null;
        state.pickerQuery = '';
        state.pickerCategory = null;
        if (cb) cb();
        renderFrame();
        return;
      }
      if (state.picker.searchable !== false) {
        if (t.key === 'backspace') {
          state.pickerQuery = (state.pickerQuery || '').slice(0, -1);
          state.picker.sel = 0;
          renderFrame(); return;
        }
        if (t.ch) {
          state.pickerQuery = (state.pickerQuery || '') + t.ch;
          state.picker.sel = 0;
          renderFrame(); return;
        }
      }
      return;
    }

    if (t.key === 'escape') {
      state.menuOpen = false; state.menuList = []; state.menuSel = 0;
      state.menuOffset = 0;
      state.input = ''; state.caret = 0;
      state.pastes.clear(); state.pasteCounter = 0;
      state.composerSel = null;
      refreshMenu(state);
      renderFrame();
      return;
    }
    if (state.menuOpen) {
      if (t.key === 'up') { state.menuSel = (state.menuSel - 1 + state.menuList.length) % state.menuList.length; ensureMenuVisible(state); renderFrame(); return; }
      if (t.key === 'down') { state.menuSel = (state.menuSel + 1) % state.menuList.length; ensureMenuVisible(state); renderFrame(); return; }
      if (t.key === 'tab') {
        const sel = state.menuList[state.menuSel];
        if (sel) { state.input = '/' + sel.name; state.caret = state.input.length; refreshMenu(state); renderFrame(); }
        return;
      }
    }
    
    // @ tab-completion for files/folders
    if (t.key === 'tab' && !state.menuOpen) {
      const input = state.input || '';
      const atIdx = input.lastIndexOf('@');
      if (atIdx >= 0) {
        const prefix = input.slice(0, atIdx + 1); // include @
        const suffix = input.slice(atIdx + 1);   // text after @
        
        // Collect files and folders from current workspace
        const cwd = state.cwd || state.workspace || process.cwd();
        let items = [];
        try {
          const entries = fs.readdirSync(cwd, { withFileTypes: true });
          for (const entry of entries) {
            const name = entry.name;
            // Skip hidden files by default
            if (name.startsWith('.')) continue;
            
            const fullPath = path.join(cwd, name);
            if (entry.isDirectory()) {
              items.push({ label: name + '/', type: 'dir', path: fullPath });
            } else {
              items.push({ label: name, type: 'file', path: fullPath });
            }
          }
        } catch (e) {
          // If we can't read the directory, just ignore
        }
        
        // Filter by suffix
        if (suffix) {
          const lowerSuffix = suffix.toLowerCase();
          items = items.filter((it) => it.label.toLowerCase().startsWith(lowerSuffix));
        }
        
        if (items.length > 0) {
          // Auto-complete to first match
          const match = items[0];
          state.input = prefix + match.label;
          state.caret = state.input.length;
          renderFrame();
          return;
        }
      }
    }
    if (t.key === 'up' || t.key === 'down') {
      const cur = state.input || '';
      if (cur === '' && state.history.length) {
        if (state.historyIdx === -1) state.historyIdx = state.history.length;
        state.historyIdx = t.key === 'up'
          ? Math.max(0, state.historyIdx - 1)
          : Math.min(state.history.length, state.historyIdx + 1);
        state.input = state.historyIdx >= state.history.length ? '' : (state.history[state.historyIdx] || '');
        state.caret = state.input.length;
        state.composerSel = null;
        refreshMenu(state); renderFrame(); return;
      }
      const insideW = Math.max(0, dims().cols - 2);
      const layout = composerLayout(state, insideW - 3);
      const dir = t.key === 'down' ? 1 : -1;
      const targetRow = layout.caretRow + dir;
      if (targetRow >= 0 && targetRow < layout.rows.length) {
        const starts = rowStartOffsets(state.input || '', layout.rows.length, insideW);
        const colInRow = Math.max(0, layout.caretCol - 1);
        const targetStart = starts[targetRow] != null ? starts[targetRow] : 0;
        state.caret = Math.min((state.input || '').length, targetStart + colInRow);
        state.composerSel = null;
        renderFrame(); return;
      }
      scrollChat(state, t.key === 'up' ? 3 : -3);
      renderFrame(); return;
    }
    if (t.key === 'wheelup' || t.key === 'wheeldown') {
      const d = t.key === 'wheelup' ? 3 : -3;
      if (state.panel) {
        const p = state.panel;
        p.top = Math.max(0, (p.top || 0) + (t.key === 'wheelup' ? -3 : 3));
        renderFrame(); return;
      }
      if (state.picker) {
        const n = pickerFiltered(state).length;
        if (n) {
          const cur = Math.min(state.picker.sel, n - 1);
          state.picker.sel = (cur + (t.key === 'wheeldown' ? 1 : n - 1)) % n;
          renderFrame();
        }
        return;
      }
      if (state.menuOpen && state.menuList.length) {
        const n = state.menuList.length;
        const cur = Math.min(state.menuSel, n - 1);
        state.menuSel = (cur + (t.key === 'wheeldown' ? 1 : n - 1)) % n;
        ensureMenuVisible(state);
        renderFrame();
        return;
      }
      scrollChat(state, d);
      renderFrame(); return;
    }
    if (t.key === 'pageup' || t.key === 'pagedown') {
      if (state.panel) {
        const p = state.panel;
        p.top = Math.max(0, (p.top || 0) + (t.key === 'pageup' ? -10 : 10));
        renderFrame(); return;
      }
      if (state.picker) {
        const n = pickerFiltered(state).length;
        if (n) {
          const cur = Math.min(state.picker.sel, n - 1);
          state.picker.sel = (cur + (t.key === 'pagedown' ? 1 : n - 1)) % n;
          renderFrame();
        }
        return;
      }
      scrollChat(state, t.key === 'pageup' ? 10 : -10);
      renderFrame(); return;
    }
    if (t.key === 'left' || t.key === 'right') {
      const dir = t.key === 'left' ? -1 : 1;
      const mk = adjacentPasteMarker(state.input, state.caret || 0, dir);
      if (mk) {
        state.caret = dir < 0 ? mk.start : mk.end;
      } else if (dir < 0) {
        state.caret = Math.max(0, (state.caret || 0) - 1);
      } else {
        state.caret = Math.min(state.input.length, (state.caret || 0) + 1);
      }
      state.composerSel = null;
      renderFrame(); return;
    }
    if (t.key === 'home') {
      const insideW = Math.max(0, dims().cols - 2);
      const layout = composerLayout(state, insideW);
      const starts = rowStartOffsets(state.input || '', layout.rows.length, insideW);
      state.caret = starts[layout.caretRow] != null ? starts[layout.caretRow] : 0;
      state.composerSel = null;
      renderFrame(); return;
    }
    if (t.key === 'end') {
      const insideW = Math.max(0, dims().cols - 2);
      const layout = composerLayout(state, insideW);
      const starts = rowStartOffsets(state.input || '', layout.rows.length, insideW);
      const next = starts[layout.caretRow + 1];
      state.caret = (next != null ? next - 1 : (state.input || '').length);
      state.caret = Math.max(0, Math.min((state.input || '').length, state.caret));
      state.composerSel = null;
      renderFrame(); return;
    }
    if (t.key === 'enter') {
      // Enter commits whatever is in the composer. When the `/` MENU is open it
      // selects a command, but the composer's own text is still what was typed —
      // it must be consumed either way, or the typed "/yolo" stayed on screen
      // after the command ran (forced submission skips the composer reset).
      const fromMenu = state.menuOpen && state.menuList.length;
      if (fromMenu) {
        submit('/' + state.menuList[state.menuSel].name);
        state.input = ''; state.caret = 0;
        state.pastes.clear(); state.pasteCounter = 0;
        state.composerSel = null;
        renderFrame();
      } else {
        submit();
        state.composerSel = null;
      }
      return;
    }
    if (t.key === 'newline') {
      state.input = (state.input || '').slice(0, state.caret) + '\n' + (state.input || '').slice(state.caret);
      state.caret++;
      state.composerSel = null;
      refreshMenu(state); renderFrame(); return;
    }
    if (t.key === 'c-d') {
      if ((state.input || '') === '') { quit(); return; }
      return;
    }
    if (t.key === 'backspace') {
      const sel = state.composerSel;
      if (sel && sel.anchor !== sel.head) {
        const a = Math.min(sel.anchor, sel.head);
        const h = Math.max(sel.anchor, sel.head);
        state.input = state.input.slice(0, a) + state.input.slice(h);
        state.caret = a;
      } else if (state.caret > 0) {
        const mk = adjacentPasteMarker(state.input, state.caret, -1);
        if (mk) {
          state.input = state.input.slice(0, mk.start) + state.input.slice(mk.end);
          state.caret = mk.start;
          state.pastes.delete(mk.id);
        } else {
          state.input = state.input.slice(0, state.caret - 1) + state.input.slice(state.caret);
          state.caret--;
        }
      }
      refreshMenu(state); renderFrame(); state.composerSel = null; return;
    }
    if (t.key === 'delete') {
      const sel = state.composerSel;
      if (sel && sel.anchor !== sel.head) {
        const a = Math.min(sel.anchor, sel.head);
        const h = Math.max(sel.anchor, sel.head);
        state.input = state.input.slice(0, a) + state.input.slice(h);
        state.caret = a;
      } else {
        const mk = adjacentPasteMarker(state.input, state.caret, 1);
        if (mk) {
          state.input = state.input.slice(0, mk.start) + state.input.slice(mk.end);
          state.pastes.delete(mk.id);
        } else if (state.caret < state.input.length) {
          state.input = state.input.slice(0, state.caret) + state.input.slice(state.caret + 1);
        }
      }
      refreshMenu(state); renderFrame(); state.composerSel = null; return;
    }
    if (t.paste !== undefined) {
      // A bracketed paste (Ctrl+Shift+V in most terminals): shared with the
      // Ctrl+Shift+V shortcut and the right-click menu's Paste.
      insertComposerPaste(t.paste);
      renderFrame(); return;
    }
    if (t.ch) {
      state.input = state.input.slice(0, state.caret) + t.ch + state.input.slice(state.caret);
      state.caret++;
      state.composerSel = null;
      refreshMenu(state); renderFrame();
    }
  }

  function rowStartOffsets(text, rowCount, insideW) {
    const starts = [];
    const prefix = ' > ';
    const cont = '   ';
    let base = 0;
    const paras = String(text).split('\n');
    for (let pi = 0; pi < paras.length; pi++) {
      const p = paras[pi];
      const pre = pi === 0 ? prefix : cont;
      const bodyW = Math.max(1, insideW - visualCol(pre));
      const segs = wrapWithOffsets(p, bodyW);
      for (let si = 0; si < segs.length; si++) starts.push(base + segs[si].start);
      base += p.length + 1;
    }
    return starts;
  }

  function statusExtra(state) {
    return (state.confirmExit ? 1 : 0)
      + (state.notice ? 1 : 0)
      + (state.running ? 1 : 0)
      + ((state.menuOpen && state.menuList.length) ? Math.min(state.menuList.length, MAX_MENU) + 1 : 0);
  }

  function scrollChat(state, delta) {
    const cols = dims().cols, rows = dims().rows;
    const chat = renderChatLines(state, cols);
    const ch = Math.max(1, rows - (composerHeight(state, cols) + statusExtra(state) + STATUS_H + CTX_H));
    const maxScroll = Math.max(0, chat.length - ch);
    state.scroll = Math.min(maxScroll, Math.max(0, (state.scroll || 0) + delta));
  }

  async function submit(forceText) {
    // `forceText` means the text came from somewhere other than the composer
    // (the queue drain). Clearing the composer in that case would throw away
    // whatever the user has typed SINCE queueing — so only reset it when we are
    // actually submitting the composer's own content. The composer/menu state
    // is always reset, since the prompt is being consumed either way.
    const fromComposer = forceText === undefined;
    const raw = fromComposer ? state.input : forceText;
    let text = expandPastes(raw, state.pastes).trim();
    if (fromComposer) {
      state.input = ''; state.caret = 0;
      state.pastes.clear(); state.pasteCounter = 0;
    }
    state.menuOpen = false; state.menuList = []; state.menuSel = 0;
    state.historyIdx = -1;
    if (!text) { renderFrame(); return; }
    if (!state.running) state.turnStart = Date.now();
    
    if (state.history[state.history.length - 1] !== text) state.history.push(text);
    // Commands are handled immediately, never queued: queuing them delayed a
    // /plan or /model until the running turn finished, which is not what
    // typing a command means.
    if (text.startsWith('/')) {
      const sp = text.indexOf(' ');
      const c = sp === -1 ? text : text.slice(0, sp);
      const arg = sp === -1 ? '' : text.slice(sp + 1).trim();
      dispatch(c, arg, state, cfg, session, host, submit, stdout);
      if (state._quit) { quit(); return; }
      renderFrame();
      return;
    }
    if (state.running && state.agent) {
      state.queued.push(text);
      // QUEUED, not steered: the message waits and becomes its own turn once
      // this one finishes (the drain after agent.run()). It must NOT be handed
      // to the running turn — Ctrl-S is the explicit "inject it now" shortcut.
      renderFrame();
      return;
    }

    await runAgent(text);
  }

  async function runAgent(text) {
    addChat({ role: 'user', text });
    state.running = true;
    // Pick the Working… wording ONCE for this turn, so it does not change while
    // the gradient loops. The next turn picks a new one.
    state.workMsg = WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)];
    state.rounds = (state.rounds || 0) + 1;
    state._stepsBase = state.steps || 0;
    state._turnSteps = 0;
    if (session) session.rounds = state.rounds;
    // system 固定在开头，且不持久化到 session（否则每轮都会堆一条）。
    // 历史里的旧 system 一律跳过，统一使用当前 system prompt：
    //   * a custom prompt from /set-system-prompt (config.toml `system_prompt`),
    //     falling back to the built-in SYSTEM_PROMPT;
    //   * plus the COOL-MODE instruction appended when that mode is ON, so the
    //     model stops narrating what it is about to do and why.
    const basePrompt = (cfg.systemPrompt && String(cfg.systemPrompt).trim()) || SYSTEM_PROMPT;
    let sysText = basePrompt;
    
    // Auto-generate title on first turn (if not already set)
    if (!session.title && session.messages && session.messages.length === 0) {
      sysText += '\n\n[IMPORTANT: Please generate a concise, descriptive title for this conversation based on the user\'s request. Return ONLY the title text, nothing else. Example: Fix color rendering issue or Implement plugin system]';
    }
    
    if (cfg.calmMode) {
      sysText += '\n\n' + CALM_MODE_INSTRUCTION;
    }
    let messages = [{ role: 'system', content: sysText }];
    if (session.messages && session.messages.length) {
      for (const m of session.messages) {
        if (m.role === 'system') continue;
        // 丢掉既无 content、又无 toolCalls 的空 assistant 消息（旧 bug 的残留）。
        if (m.role === 'assistant'
            && !(typeof m.content === 'string' && m.content.trim())
            && !(Array.isArray(m.toolCalls) && m.toolCalls.length)) {
          continue;
        }
        messages.push(m);
      }
    }
    messages.push({ role: 'user', content: text });
    // 只持久化对话本身，system 不进 session。
    Object.assign(session, { model: cfg.model, messages: messages.filter((m) => m.role !== 'system') });
    sess.saveSession(session);

    if (state.plan) {
      cfg.toolFilter = ['Read', 'Grep', 'Glob'];
    } else if (state.focus) {
      cfg.toolFilter = ['Read', 'Write', 'Edit', 'Bash'];
    } else {
      cfg.toolFilter = undefined;
    }

        const mode = state.mode || 'ask';
    
    // Approval callback: called before every tool execution
    const onApproval = async (toolName, args) => {
      // Read the mode LIVE: /permission, /yolo and /auto can change while the
      // turn runs, and the decision must follow the CURRENT setting.
      const cur = state.mode || 'ask';
      if (cur === 'auto') return true;

      // Read-only tools never need permission in any mode.
      const safeTools = ['Read', 'Grep', 'Glob', 'FetchURL', 'WebSearch', 'TaskOutput', 'TaskList', 'TaskStop', 'TaskWait', 'TodoList', 'FileLines'];
      if (safeTools.includes(toolName)) return true;

      // YOLO ("Ask When Needed"): anything that stays INSIDE the workspace runs
      // without asking — edits, writes and commands alike. Only work that touches
      // a path OUTSIDE the workspace (or a command whose target we cannot prove is
      // inside) needs the user.
      if (cur === 'yolo' && isInsideWorkspace(state, toolName, args)) return true;

      return new Promise((resolve) => {
        let desc = '';
        if (args && typeof args === 'object') {
          const keyArgs = args.path || args.file_path || args.pattern || args.command || args.url || args.query || '';
          desc = String(keyArgs).split('\n')[0].slice(0, 120);
        }
        
        // Lines to display. A Bash command (or any long argument) is shown in
        // FULL — collapsing it hid exactly what the user must review.
        const detail = [];
        const rawArg = (args && typeof args === 'object')
          ? (args.command || args.cmd || args.pattern || args.path || args.file_path || args.url || args.query || null)
          : null;
        if (typeof rawArg === 'string' && rawArg.length) {
          for (const ln of rawArg.replace(/\r\n/g, '\n').split('\n')) detail.push(ln);
        }
        // The prompt must NOT touch the composer: the user may already be typing,
        // and only Enter/Esc belong to the prompt.
        state.approvalPending = { toolName, args, desc, resolve, detail };
        renderFrame();
      });
    };
    
    // Seed the agent with the persisted list: Agent() otherwise starts from an
    // empty todoState, which wiped the panel on every new turn.
    cfg.todoState = state.todos || [];
    const agent = new Agent({
      // maxSteps omitted: the agent loop is uncapped (see agent.js).
      cfg, messages, onApproval,
      onEvent: (e) => {
        // Everything the MODEL streams counts toward the tok/s meter: reasoning
        // chunks carry `text` just like answer chunks do.
        if (e.text) {
          const now = Date.now();
          for (let k = 0, t = estimateTokens(e.text); k < t; k++) state._tokTimes.push(now);
        }
        // Tool-call ARGUMENTS are model output too (a Write's content, a long
        // Bash command) and used to show 0 tok/s while they streamed. Only the
        // argument stream counts: `tool_output` is the tool RUNNING, and a
        // tool_result is a later turn's input, not tokens the model produced.
        if (e.type === 'tool_args' && e.chunk) {
          const now = Date.now();
          for (let k = 0, t = estimateTokens(e.chunk); k < t; k++) state._tokTimes.push(now);
        }
        if (e.type === 'step_start') {
          state._turnSteps = (state._turnSteps || 0) + 1;
          state.steps = (state._stepsBase || 0) + state._turnSteps;
          if (session) session.steps = state.steps;
          renderSoon();
          return;
        }
        if (e.type === 'compacted') {
          state.ctxTokens = e.after || state.ctxTokens;
          state.ctxPercent = usagePercent(state.ctxTokens, state.ctxMax || 1);
          addChat({ role: 'system', text: `Context auto-compacted (${fmtTokens(e.before || 0)} → ${fmtTokens(e.after || 0)} tokens).` });
          return;
        }
        if (e.type === 'nudge') {
          // Silent internal signal - don't show to user
          return;
        }
        if (e.type === 'incomplete') {
          // Orange: this is a warning, not ordinary system output.
          addChat({ role: 'warn', text: `Stopped: ${e.reason}. The task may be unfinished — send another message to continue.` });
          return;
        }
        if (e.type === 'data') {
          const t = [...state.chat].reverse().find((m) => m.role === 'thinking' && m.pending);
          if (t) t.pending = false;
          appendAssistant(e.text);
          renderSoon(); return;
        }
        if (e.type === 'context') {
          // Live context gauge: the agent reports the estimated request size once
          // per step, so the header and /usage track the growing history.
          state.ctxTokens = e.tokens || 0;
          state.ctxMax = e.max || state.ctxMax;
          state.ctxPercent = usagePercent(state.ctxTokens, state.ctxMax || 1);
          renderSoon(); return;
        }
        if (e.type === 'think') { state.seenThinking = true; appendThinking(e.text); renderSoon(); return; }
        if (e.type === 'aborted') {
          const t = [...state.chat].reverse().find((m) => m.role === 'thinking' && m.pending);
          if (t) t.pending = false;
          // Use a special role that won't show the ✓ icon
          state.chat.push({ role: 'aborted', text: C.red + 'interrupted' + C.reset });
          return;
        }
        if (e.type === 'steer') {
          // The agent injected a steered message into the running turn.
          const qm = [...state.chat].reverse().find((m) => m.role === 'queued' && m.text === e.text)
            || [...state.chat].reverse().find((m) => m.role === 'queued');
          if (qm) qm.role = 'steer';
          const qi = state.queued.indexOf(e.text);
          if (qi >= 0) state.queued.splice(qi, 1);
          renderSoon();
          return;
        }
        if (e.type === 'tool_start') {
          const dup = state.chat.some((m) => m.role === 'tool' && m.pending && m.id === e.id);
          if (!dup) {
            state.chat.push({ role: 'tool', toolName: e.name, toolArgs: {}, pending: true, id: e.id, streamContent: '' });
          }
        } else if (e.type === 'tool_args') {
          const entry = [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.id === e.id);
          if (entry) {
            entry._argsRaw = (entry._argsRaw || '') + e.chunk;
            // Track the key argument as it streams so "Using Bash (cmd)" shows
            // the command DURING the run rather than only once it has finished.
            entry.toolArgs = extractPartialArgs(entry._argsRaw, entry.toolArgs || {});
            if (entry.toolName === 'Write') entry.streamContent = extractJsonString(entry._argsRaw, 'content');
          }
          renderSoon(); return;
        } else if (e.type === 'tool_output') {
          // Live output from a running tool (Bash): append it to the matching
          // "Using …" row so the command's output is visible before it finishes.
          const entry = [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.id === e.id)
            || [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending);
          if (entry) {
            entry.liveOutput = (entry.liveOutput || '') + e.chunk;
            renderSoon();
          }
          return;
        } else if (e.type === 'tool_use') {
          const entry = [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.id === e.id)
            || [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.toolName === e.name);
          if (entry) {
            entry.toolArgs = { ...(entry.toolArgs || {}), ...(e.args || {}) };
            if (e.name === 'Edit' && e.args && typeof e.args.old_string === 'string') {
              let startLine = 1;
              try {
                const file = path.isAbsolute(e.args.path || '') ? e.args.path : path.resolve(state.cwd, e.args.path || '');
                const before = fs.readFileSync(file, 'utf8').split(/\r?\n/);
                const at = before.indexOf(String(e.args.old_string).split(/\r?\n/)[0]);
                if (at >= 0) startLine = at + 1;
              } catch { }
              entry.diff = lineDiff(e.args.old_string, e.args.new_string, startLine);
            }
          }
          // The args just changed: repaint so "Using <Tool> (<arg>)" appears
          // as soon as they arrive instead of waiting for the next event.
          renderSoon();
        } else if (e.type === 'tool_result') {
          const entry = [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.id === e.id)
            || [...state.chat].reverse().find((m) => m.role === 'tool' && m.pending && m.toolName === e.name);
          // A failed run must be visible on the TOOL line too: the status bullet
          // turns red (see messageLines).
          const failedRun = isFailureResult(e.content, e.name);
          if (entry) { entry.pending = false; entry.id = undefined; entry.failed = failedRun; }
          const reason = failureReason(e.content, e.name);
          const isEditLike = e.name === 'Edit' || e.name === 'Write';
          if (!isEditLike) {
            // Non-Edit tools show their raw result underneath.
            addChat({ role: 'tool_result', text: e.content, failed: failedRun });
          } else if (reason) {
            // Edit/Write hide their body (the diff already shows the change), so
            // surface a failure reason as its own red line under the tool call.
            addChat({ role: 'tool_result', text: reason, failed: true });
          }
          // NOTE: queued input is deliberately NOT drained into the running turn
          // here. A message typed while the agent works is a NEW turn, so it waits
          // for this turn to finish (see the drain after `agent.run()`). Ctrl-S
          // remains the explicit "steer it into the running turn now" escape hatch.
        } else if (e.type === 'error') addChat({ role: 'tool_result', text: (e.error && e.error.message) || String(e.error) });
        else if (e.type === 'todos') { state.todos = e.todos || []; if (session) session.todos = state.todos; }
        renderFrame();
      },
    });
    state.agent = agent;
    if (agent.ctx && agent.ctx.tasks) state.tasks = agent.ctx.tasks;
    await agent.run();
    messages = agent.messages;
    if (agent.ctx && agent.ctx.tasks) state.tasks = agent.ctx.tasks;
    state.agent = null;
    const liveThink = [...state.chat].reverse().find((m) => m.role === 'thinking' && m.pending);
    if (liveThink) liveThink.pending = false;
    const approx = estimateMessagesTokens(messages, cfg);
    state.ctxTokens = approx;
    state.ctxMax = cfg.maxContextTokens || state.ctxMax;
    state.ctxPercent = usagePercent(approx, state.ctxMax);
    session.messages = messages;
    session.rounds = state.rounds;
    session.steps = state.steps;
    // The todo list is part of the session's visible state: persist it here
    // too, so resuming (or `hncode -c`) brings the panel back.
    session.todos = state.todos || [];
    // Also save runtime mode/flags so they persist across restarts.
    session.mode = state.mode || 'ask';
    session.plan = !!state.plan;
    session.planPath = state.planPath || null;
    session.focus = !!state.focus;
    sess.saveSession(session);
    const turnMs = state.turnStart ? Date.now() - state.turnStart : 0;
    const dur = fmtDuration(turnMs);
    // The live row is `<phrase> <gray>[<dur>]`. At the end we keep the same row
    // shape — `[<word> <dur>]` — and only rewrite the word, so the brackets and
    // the duration stay put and the time is never repeated. `…` is part of the
    // phrase and is preserved.
    const wordFrom = String(state.workMsg || WORKING_MESSAGES[0]);
    state.finishAnim = {
      start: Date.now(),
      wordFrom,
      wordTo: 'turn took',
      tail: ` ${dur}]`,   // fixed right-hand side, e.g. " 59s]"
    };
    const animStart = Date.now();
    while (Date.now() - animStart < 520) {
      renderFrame();
      await new Promise((r) => setTimeout(r, 20));
    }
    state.finishAnim = null;
    state.running = false;

    if (turnMs > 0) {
      state.lastTurnMs = turnMs;
      session.lastTurnMs = turnMs;
      sess.saveSession(session);
      // Same shape the sweep animated into: `[turn took <dur>]`.
      addChat({ role: 'system', text: `[turn took ${dur}]` });
    }
    renderFrame();
    if (state.queued.length) {
      // Anything still queued was never injected (the turn ended first), so it
      // becomes its own turn. Texts the agent DID consume were removed from
      // state.queued by the `steer` handler above.
      const next = state.queued.shift();
      if (next) { void submit(next); }
    }
  }

  // Remember the session's working mode (permission / plan / focus / effort)
  // so resuming it comes back the way the user left it. Written immediately:
  // these are settings, not conversation, and must survive an abrupt exit.
  function persistState() {
    if (!session) return;
    session.mode = state.mode;
    session.plan = !!state.plan;
    session.planPath = state.planPath || null;
    session.focus = !!state.focus;
    session.effort = state.effort || '';
    // Theme removed - forced dark only
    session.steps = state.steps || 0;
    session.rounds = state.rounds || 0;
    if (state.lastTurnMs) session.lastTurnMs = state.lastTurnMs;
    try { sess.saveSession(session); } catch {}
  }

  const host = {
    addChat, openPicker, openForm, notice, openPanel, openEditor,
    sendPrompt: (text) => { void runAgent(text); },
    quit: () => { state._quit = true; },
    saveSession: (s) => sess.saveSession(s),
    reloadConfig: () => resolveConfig(),
    persistState,
  };

  // Appending streamed text can also add rows (the message wraps as it grows).
  // While the user is scrolled up, compensate so their view does not shift — the
  // same anchoring rule addChat applies for a whole new message.
  function anchorScroll() {
    if ((state.scroll || 0) === 0) return;      // pinned to the bottom: follow
    const rows = renderChatLines(state, dims().cols).length;
    const prev = state._anchorRows;
    // On the first call after the user scrolled up, _anchorRows is unset — just
    // record the current row count without adjusting scroll. Otherwise a large
    // gap (prev=0 vs. rows=N) would jump the view to the top of the session.
    if (prev != null) {
      if (rows > prev) state.scroll = (state.scroll || 0) + (rows - prev);
    }
    state._anchorRows = rows;
  }

  function appendAssistant(text) {
    const last = state.chat[state.chat.length - 1];
    if (last && last.role === 'assistant') {
      last.text += text;
    } else {
      state.chat.push({ role: 'assistant', text: text || '' });
    }
    
    // Check if this is the first assistant response and we need to parse title
    if (!state.running && !session.title && state.chat.some(m => m.role === 'assistant')) {
      // Look for title in the assistant's response
      const assistantMsg = state.chat.find(m => m.role === 'assistant');
      if (assistantMsg && assistantMsg.text) {
        const text = assistantMsg.text.trim();
        // More lenient heuristic: short text (< 80 chars), no newlines, optional ending punctuation
        const cleanText = text.replace(/[.!?]$/, '').trim();
        if (cleanText.length < 80 && !text.includes('\n') && cleanText.length > 2) {
          session.title = cleanText;
          saveSession(session);
          stdout.write(`\x1b]0;${cleanText}\x07`);
          app(`Auto-generated title: "${cleanText}"`);
        }
      }
    }
    
    anchorScroll();
  }

  function appendThinking(text) {
    const last = state.chat[state.chat.length - 1];
    if (last && last.role === 'thinking' && last.pending) {
      last.text += text;
      last.spin = state.spin || 0;
    } else {
      state.chat.push({ role: 'thinking', text: text || '', pending: true, spin: state.spin || 0 });
    }
    anchorScroll();
  }

  function normalizeMsg(m) {
    // Keep `failed`: a failed tool result must render in RED. Dropping it here
    // made every failure look like ordinary gray output.
    return {
      role: m && m.role ? m.role : 'system',
      text: m && m.text != null ? String(m.text) : '',
      failed: !!(m && m.failed),
    };
  }

  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    try { if (wasRaw) stdin.setRawMode(false); } catch {}
    try { stdin.pause(); } catch {}
    if (tipTimer) clearInterval(tipTimer);
    if (spinTimer) clearInterval(spinTimer);
    if (tokTimer) clearInterval(tokTimer);
    if (confirmTimer) clearTimeout(confirmTimer);
    try { sess.saveSession(session); } catch {}
    stdout.write('\x1b[<u\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
    stdout.write(alternateScreen(false));
    stdout.write(showCursor());
    const id = session && session.id;
    const work = session && session.workspace;
    if (id) {
      let hint = '';
      hint += `\r\n  Session saved as ${id}\r\n`;
      hint += `  Continue here:  hncode --continue\r\n`;
      if (work) hint += `  Or resume the exact session:  hncode --resume ${id}\r\n`;
      hint += '\r\n';
      stdout.write(hint);
    }
  }
  function quit() { stop(); process.exit(0); }
  process.on('SIGWINCH', () => renderFrame());
  process.on('SIGINT', () => quit());
  process.on('exit', () => {
    if (stopped) return;
    try { stdout.write('\x1b[<u\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l' + alternateScreen(false) + showCursor()); } catch {}
  });

  // Keep the process alive for the whole session. startTUI is async and returns
  // as soon as the TUI is wired up; without a pending promise, main()'s await
  // resolves immediately and Node exits (the "flash of UI then quit" bug).
  return new Promise(() => {});
}