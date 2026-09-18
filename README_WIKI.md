# hncode Wiki

English | [简体中文](https://github.com/NiceHello666/hncode/blob/main/README_WIKI_CN.md) | [Back to README](https://github.com/NiceHello666/hncode/blob/main/README.md)

Complete documentation for hncode — an AI coding agent that runs as a terminal user interface (TUI).

---

## Table of Contents

1. [What hncode is](#1-what-hncode-is)
2. [Requirements](#2-requirements)
3. [Installation](#3-installation)
4. [First run](#4-first-run)
5. [Configuration](#5-configuration)
   - [5.1 Basic: configure everything from the TUI](#51-basic-configure-everything-from-the-tui)
   - [5.2 Advanced: edit `config.toml` by hand](#52-advanced-edit-configtoml-by-hand)
   - [5.3 Environment variables](#53-environment-variables)
6. [Command-line interface](#6-command-line-interface)
7. [Slash commands](#7-slash-commands)
8. [Keyboard shortcuts](#8-keyboard-shortcuts)
9. [Tools](#9-tools)
10. [Permission modes](#10-permission-modes)
11. [Context management & auto-compaction](#11-context-management--auto-compaction)
12. [Sessions](#12-sessions)
13. [Plugin system](#13-plugin-system)
   - [The smallest useful plugin](#the-smallest-useful-plugin)
   - [Verify it loaded](#verify-it-loaded)
   - [Registering a slash command](#registering-a-slash-command)
   - [Registering a hook](#registering-a-hook)
   - [The full API surface](#the-full-api-surface)
   - [Things that trip people up](#things-that-trip-people-up)
14. [For developers](#14-for-developers)
15. [Troubleshooting](#15-troubleshooting)
16. [Acknowledgments](#16-acknowledgments)
17. [License](#17-license)

---

## 1. What hncode is

hncode is a coding agent that lives in your terminal. You describe a task; it reads and edits files, runs shell commands, searches the codebase, fetches web pages, and keeps working until the task is done — subject to the permission mode you choose.

It is inspired by [Kimi Code](https://github.com/MoonshotAI/kimi-code) and takes a similar approach: a raw-terminal (not `blessed`) cyan-blue TUI, a tool loop driven by a model that may emit tool calls, and streaming responses from either an OpenAI-compatible endpoint or Anthropic.

Key traits:

- **TUI, not CLI**: it is an interactive full-screen interface. It also has a non-interactive `-p` prompt mode for scripting.
- **Dual protocol**: OpenAI-compatible (`/chat/completions`) and Anthropic (`/messages`).
- **Zero runtime dependencies**: pure Node.js, no native modules, no third-party packages.
- **Model-agnostic**: anything that speaks the OpenAI or Anthropic wire format works.

---

## 2. Requirements

- **Node.js ≥ 20**
- A terminal. On Windows, **Windows Terminal** is recommended.
- An API key for at least one provider (OpenAI-compatible or Anthropic).

> **Windows note**: ideally also have [Git for Windows](https://gitforwindows.org/) installed so tools that expect a POSIX shell can find `bash`.

---

## 3. Installation

### Global install (recommended)

```bash
npm install -g @hncode/hncode
hncode
```

### Run without installing

```bash
npx @hncode/hncode
```

### The install hooks

The package declares two npm lifecycle scripts:

| Script | File | What it does |
|--------|------|--------------|
| `preinstall` | `bin/preinstall.js` | Checks Node ≥ 20, prints the platform, warns if already installed globally. |
| `install` | `bin/install.js` | Creates `~/.hncode/` with `config.toml`, `sessions/`, and `plugins/`, writes a starter config, then prints how to refresh your shell `PATH` on Windows / macOS / Linux. |

Neither script executes your code or phones home; they only create local directories and a default config file.

### Manual install from source

```bash
git clone https://github.com/NiceHello666/hncode.git
cd hncode
npm link          # exposes the `hncode` command globally
```

---

## 4. First run

1. Launch `hncode`. On first run the install script has created `~/.hncode/config.toml`.
2. Add a provider **from inside the TUI**: run `/provider`, pick a known provider (or add a custom one), and paste your API key. Models are registered automatically. (If you already set `HNCODE_API_KEY`, this is unnecessary.)
3. Type your task and press **Enter**.

See [Configuration](#5-configuration) for the details.

The TUI is split into:

- **Transcript** (top): your messages, the model's answers, and each tool call with its result.
- **Todo panel**: appears when the agent is tracking tasks.
- **Composer** (bottom): where you type.
- **Status line**: model, permission mode, thinking effort, working directory.
- **Context line** (very bottom): live token usage / context window.

---

## 5. Configuration

hncode reads **only** `~/.hncode/config.toml` (plus `HNCODE_*` environment variables). It does not read any other product's config.

**You usually don't need to edit this file by hand.** Providers and models can be configured entirely from inside the TUI, and the resulting `config.toml` is written for you. Editing the TOML directly is an *advanced* option — useful for scripted setups, unusual endpoints, or settings the wizard does not expose.

### 5.1 Basic: configure everything from the TUI

Run these slash commands while hncode is open:

| Command | What it does |
|---------|--------------|
| `/provider` | Manage providers — **add**, **edit**, or **delete**. |
| `/model` | Pick a model, or switch between models you already added. |
| `/effort [off\|on\|high\|medium\|low]` | Set the thinking effort for the current model. |

**Adding a provider** (`/provider` → Add):

- pick a **known provider** from the [models.dev](https://models.dev) catalog — the base URL is pre-filled, or
- add a **custom provider** — you supply the name, base URL, API key, and protocol (`OpenAI` or `Anthropic`).

After you save it, hncode calls that provider's `/models` endpoint and **registers every model automatically**, recording each one's context window and thinking capability. You do not need to know any of that up front.

**Editing a provider** (`/provider` → Enter on a provider) lets you change its name, base URL, API key, and protocol type.

Everything is persisted to `~/.hncode/config.toml` immediately, so it survives a restart.

### 5.2 Advanced: edit `config.toml` by hand

`.hncode/config.toml` holds three things: top-level defaults, `[providers.*]`, and `[models.*]`.

A minimal file:

```toml
default_model = "gpt-4o-mini"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "sk-..."

[models.gpt-4o-mini]
provider = "openai"
model = "gpt-4o-mini"
```

**Providers** — `[providers.<name>]`:

| Key | Meaning |
|-----|---------|
| `base_url` | Base URL. hncode appends `/chat/completions` (OpenAI) or `/messages` (Anthropic). |
| `api_key` | API key for this provider. |
| `protocol` | `openai` (default) or `anthropic`. |

**Models** — `[models.<alias>]`:

| Key | Meaning |
|-----|---------|
| `provider` | Which provider this model belongs to. |
| `model` | The literal model id sent to the API. |
| `display_name` | Friendly name shown in the UI. |
| `context_length` | Context window in tokens (drives the context gauge). |
| `max_tokens` | Max output tokens. |
| `efforts` | Array of selectable thinking efforts, e.g. `["low","medium","high"]`. |
| `reasoning` | `true`/`false` — whether the model can think. |
| `always_thinking` | `true` if thinking cannot be turned off. |

After editing the file, run `/reload` to apply it without restarting.

### 5.3 Environment variables
Every value below **overrides** its `config.toml` counterpart — handy for CI or for keeping a key out of the file:

| Variable | Meaning |
|----------|---------|
| `HNCODE_API_KEY` | API key. |
| `HNCODE_PROVIDER` | Provider name to use. |
| `HNCODE_MODEL` | Model alias to use. |
| `HNCODE_BASE_URL` | Override the base URL. |
| `HNCODE_PROTOCOL` | `openai` or `anthropic`. |
| `HNCODE_MAX_CONTEXT` | Override the context window size (tokens). |
| `HNCODE_MAX_OUTPUT` | Override the max output tokens per request. |
| `HNCODE_REASONING` | `1`/`true` to mark the model as reasoning-capable. |
| `HNCODE_SYSTEM_PROMPT` | Override the system prompt. |
| `HNCODE_CALM_MODE` | `1`/`true` to enable calm mode. |
| `HNCODE_ALLOW_EXTERNAL` | `1` to allow tool access to paths outside the workspace. |
| `HNCODE_CONFIG` | Path to an alternate config file (used by `doctor config`). |
| `HNCODE_SESSIONS_DIR` | Alternate directory for saved sessions. |
| `HNCODE_PLUGINS` | Alternate plugin directory. |

---

## 6. Command-line interface

```
hncode [options] [command]
```

### Options

| Option | Description |
|--------|-------------|
| `-V, --version` | Print the version number. |
| `-S, --session [id]` | Resume a session (with an id, or pick interactively). |
| `-c, --continue` | Continue the most recent session **for the current directory**. |
| `-y, --yolo` | Ask-when-needed: workspace edits/commands run automatically; outside-workspace paths and destructive commands still ask. |
| `--auto` | Never ask: everything runs automatically. |
| `-m, --model <model>` | Model alias for this invocation. |
| `-p, --prompt <prompt>` | Run one prompt non-interactively and print the reply. |
| `--output-format <format>` | For prompt mode: `text` (default) or `stream-json`. |
| `--plan` | Start in plan mode (research only, no writes). |
| `--add-dir <dir>` | Add an extra workspace directory. Repeatable. |
| `-h, --help` | Show help. |

### Subcommands

| Command | Description |
|---------|-------------|
| `session list` | List sessions, most recent first. |
| `provider list` | Show configured providers and their model counts. |
| `doctor config [path]` | Validate a `config.toml`. |
| `init` | Create `~/.hncode/config.toml` with defaults. |
| `export [id]` | Export a session to `~/.hncode/export/<id>.json`. |

### Headless mode

```bash
hncode -p "explain what src/agent.js does"
hncode -p "list the TODOs" --output-format stream-json
```

In `stream-json` mode each event is printed as one JSON object per line, which is convenient for piping into other tools.

---

## 7. Slash commands

Type `/` in the composer to open the command menu; **Tab** completes, **Enter** runs.

### Session & workspace

| Command | Aliases | Description |
|---------|---------|-------------|
| `/new` | `/clear` | Start a fresh session in the current workspace (clears the todo panel). |
| `/sessions` | `/resume` | Browse and resume past conversations **in this directory**. |
| `/fork` | — | Copy the current session into a new one without switching to it. |
| `/title <title>` | `/rename` | Set (or show) the session title; also sets the terminal window title. |
| `/move <path>` | — | Move the current session to another existing directory. |
| `/add-dir [list] \| <path>` | — | Add or list an extra workspace directory. |
| `/undo [count]` | — | Withdraw the last prompt(s) from the transcript. |
| `/init` | — | Analyze the codebase and generate `AGENTS.md`. |
| `/export-md [path]` | `/export` | Export the current session as a Markdown file. |
| `/import-session <file.md>` | `/import` | Attach a Markdown file to the prompt so the model reads it without a tool call. |

### Model & providers

| Command | Aliases | Description |
|---------|---------|-------------|
| `/model <name>` | — | Switch model. `/model` alone opens a picker. |
| `/provider` | `/providers` | Add / edit / delete providers. |
| `/effort [off\|on\|high\|medium\|low]` | `/thinking` | Switch thinking effort. |
| `/logout` | `/disconnect` | Log out of a configured provider. |
| `/reload` | — | Reload `config.toml`. |

### Behaviour

| Command | Aliases | Description |
|---------|---------|-------------|
| `/ask` | `/manual` | Always-ask mode. |
| `/yolo` | `/yes` | Ask-when-needed mode. |
| `/auto` | — | Never-ask mode. |
| `/plan [on\|off\|clear]` | — | Plan mode: research only, no writes. |
| `/focus [on\|off]` | — | Focus mode: start with a minimal tool subset. |
| `/calm-mode [on\|off]` | — | Terse replies; the model stops narrating. |
| `/set-system-prompt` | `/system-prompt` | Edit and save the system prompt (persisted to `config.toml`). |
| `/personal [global\|project]` | `/preferences` | Edit personal preferences injected into every prompt. `project` → `<workspace>/.hncode/PERSONAL.md` (this workspace), `global` → `~/.hncode/PERSONAL.md` (all workspaces). Bare `/personal` picks the scope. |
| `/goal [status\|pause\|resume\|cancel] \| <objective>` | `/objective` | Start or manage an autonomous goal. |

### Context & diagnostics

| Command | Description |
|---------|-------------|
| `/compact [ratio]` | Compact the conversation: AI-summarize the older part, keep the most recent 20% (or `1-ratio` if a ratio is given). |
| `/usage` | Show session tokens and the context window. |
| `/status` | Show session and runtime status. |
| `/tasks` | Browse background tasks. |
| `/mcp` | Show MCP server status. |
| `/mcp-config` | Configure MCP servers (list / add / remove). |
| `/plugins` | List loaded plugins and their commands. |
| `/statusline` | Configure which items appear in the status line. |
| `/settings` | Open the settings menu (model / permission / statusline). |
| `/copy` | Copy the last assistant message to the clipboard. |
| `/help` | Show all commands and shortcuts. |
| `/version` | Show version information. |
| `/exit` | `/quit`, `/q` — exit. |

Unknown `/commands` are reported as errors and are **not** sent to the model.

---

## 8. Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send the message. |
| `Ctrl-J` | Insert a newline in the composer. |
| `Ctrl-Shift-C` | Copy the current mouse selection (or the last answer if none). |
| `Ctrl-Shift-V` | Paste the clipboard. Multi-line pastes collapse into a `[paste #N +L lines]` marker. |
| `↑` / `↓` | With an empty composer: recall input history. Otherwise: scroll the chat. |
| `/` | Open the command menu; `Tab` cycles entries. |
| `@` | File/folder completion; `Tab` completes. |
| `Esc` | Cancel the menu/dialog, or interrupt the running turn. |
| `Ctrl-E` | Open `config.toml` in your editor. |
| `Ctrl-B` | Move the running Bash command to the background. |
| `Ctrl-S` | Steer queued input into the running turn. |
| `↑` (while queued) | Recall the last queued message for editing. |
| `Ctrl-O` | Expand/collapse tool output and thinking. |
| `Ctrl-T` | Expand/collapse the todo panel. |
| `Ctrl-C` twice | Exit hncode. |

### Pasting

- **Text** is inserted literally (multi-line collapses to a marker).
- **Files** are inserted as their absolute path(s), so the model can `Read` them.
- **Images** (e.g. a screenshot) are saved to a temp `.png` and the **path** is inserted.
- The clipboard is read on a **pre-warmed** background PowerShell, so repeats are ~10 ms instead of seconds.

### Mouse

- Drag to select transcript text; right-click for a Copy/Paste context menu.
- Drag the todo panel's top rule to resize it.
- Scroll with the wheel over the transcript or the `/` menu.

---

## 9. Tools

The model can call these built-in tools. Each returns a string; failures are shown in **red** and turn the tool's status bullet red.

| Tool | Purpose |
|------|---------|
| `Read` | Read a text file (whole file by default; `line_offset` / `n_lines` for a range). |
| `Write` | Write a file (create or overwrite). |
| `Edit` | Replace an exact `old_string` with `new_string` (must be unique unless `replace_all`). |
| `Bash` | Run a shell command; supports background jobs. |
| `Glob` | Find files by pattern. |
| `Grep` | Search file contents by regex. |
| `TodoList` | Maintain the task list shown in the todo panel. |
| `TaskList` / `TaskOutput` / `TaskStop` / `TaskWait` | Manage background tasks. |
| `FetchURL` | Fetch a URL and return its text. |
| `WebSearch` | Search the web. |
| `ReadMediaFile` | Read an image/media file. |
| `FileLines` | Count (or inspect) the lines of a file. |
| `AskUserQuestion` | Ask the user 1-4 structured multiple-choice questions mid-turn and wait for the answer. An "Other" free-text option is always added per question, plus an "Add a note" row after the last one for a free-form supplement. The result is JSON: `{"answers":{"<question>":"<label>"},"additional":"<note>"}` — `additional` appears only when a note was written — or `{"answers":{},"note":"User dismissed…"}` when they press Esc. |

### The Edit safety model

`Edit` refuses to run blindly:

- You must `Read` a file before `Edit`ing it, and the edited region must be inside a snapshot you actually read. Otherwise: `Edit rejected: you have not read the lines you are editing…`.
- If the file changed since you read it: `Edit rejected: <path> changed since it was Read…`. Re-read, then edit.

These guards prevent clobbering concurrent changes.

### How failures are shown

- **Bash**: a non-zero exit code turns the bullet red; the command's own output explains why. The internal `[exit code: N]` line is never shown to you.
- **Edit / Write**: the body is replaced by the diff, so on failure a red reason line appears beneath the tool call.
- **Read / Grep / Glob / …**: the full result is shown, in red when it failed.

---

## 10. Permission modes

| Mode | Command | Behaviour |
|------|---------|-----------|
| **Always Ask** | `/ask` | Read-only tools run automatically; everything else asks first. |
| **Ask When Needed** | `/yolo` | Workspace edits/commands run automatically. Paths outside the workspace, destructive commands, questions, and plans still ask. |
| **Never Ask** | `/auto` | Nothing interrupts you; everything is decided automatically. The workspace path guard is lifted too, so the agent may read and write anywhere — this is the equivalent of `HNCODE_ALLOW_EXTERNAL=1` for the session. |

The mode is shown in the status line and is **persisted in the session**, so resuming restores it. CLI flags (`--auto`, `-y`) override it for that invocation.

Plan mode (`/plan`) restricts tools to read-only. Focus mode (`/focus`) starts with a minimal tool subset.

---

## 11. Context management & auto-compaction

Every request carries the conversation so far. When the estimated size reaches **85%** of the model's context window, hncode **auto-compacts**:

1. It keeps the most recent **20%** of messages.
2. It asks the model to **summarize** the older part (goals, decisions, files touched, current state).
3. The summary is inserted as a system message, so the conversation arc survives.

You can also compact manually:

```
/compact          # keep the last 20%, AI-summarize the rest
/compact 0.3      # drop the oldest 30%, keep 70%
```

Token usage is estimated with the same heuristic Kimi Code uses: `ceil(ASCII chars / 4) + non-ASCII chars`. The live gauge at the bottom of the screen is refreshed every step.

---

## 12. Sessions

A session records `id`, `title`, `workspace`, `model`, `messages`, `rounds`, `steps`, and the runtime mode flags.

- Stored under `~/.hncode/sessions/<id>.json`.
- `/sessions` lists only sessions **from the current directory**.
- `hncode --continue` resumes the most recent session **for the current directory**.
- `/move <path>` relocates a session to another directory.
- `/new` starts a fresh one (and clears the todo panel).
- Mode flags (permission / plan / focus / effort) are persisted with the session.

---

## 13. Plugin system

A plugin is a single `.js`/`.mjs` file you drop into `~/.hncode/plugins/` (or the
directory named by `HNCODE_PLUGINS`). It is a normal ES module — no build step, no
manifest, no dependencies required. The file name is the plugin id.

### The smallest useful plugin

Save this as `~/.hncode/plugins/echo.mjs`, restart hncode, and the model gains a new
tool it can call:

```javascript
export function install(api) {
  api.registerTool({
    name: 'Echo',
    description: 'Echo the given text back. Use when the user asks to echo.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
    async execute(args, ctx) {
      return args.text;
    },
  });
}

export default { name: 'echo', version: '1.0.0' };
```

Two things make it work:

- **`install(api)` is the entry point.** Export it by name, or as `default.install`.
  A file without it is skipped, with a message on stderr.
- **`export default` is metadata only** — `{ name, version }`, used by `/plugins`.
  Omit it and the plugin still works; it just shows up under its file name.

### Verify it loaded

`/plugins` lists everything that loaded, its version, and any commands it added:

```
Loaded plugins:
  • echo v1.0.0 (echo.mjs)
```

If your plugin is missing, the reason went to **stderr** — the TUI owns the screen,
so a load failure prints to the terminal rather than into the chat. A duplicate tool
or command name throws there too.

### Registering a slash command

```javascript
api.registerCommand({
  name: 'greet',              // becomes /greet
  aliases: ['hi'],
  description: 'Say hello.',
  argumentHint: '[name]',
  run: async (arg, ctx) => {
    // `arg` is everything typed after the command name.
    // Return a string to display it; return nothing for a no-op.
    return `Hello, ${arg || 'world'}!`;
  },
});
```

### Registering a hook

Hooks are how a plugin reacts to the agent loop. Every hook is optional, and each
receives plain data — a plugin never has to reach into internals.

| Hook | When it fires | Arguments |
|------|---------------|-----------|
| `onTurnStart` | A turn begins | `({ messages })` |
| `onBeforeRequest` | Just before the model call | `(messages, cfg)` |
| `onAfterRequest` | Just after the stream is consumed | `(messages, cfg)` |
| `onNewMessage` | An assistant message is committed to history | `(message, allMessages)` |
| `onToolExecute` | Before a tool runs | `(toolName, args, ctx)` |
| `onToolResult` | After a tool returns | `(toolName, result, ctx)` |
| `onTurnEnd` | The turn is over (also on interrupt) | `({ messages, stopped })` |

A practical example — audit every shell command the agent runs:

```javascript
export function install(api) {
  api.registerHook('onToolExecute', (name, args) => {
    if (name === 'Bash') console.error('[audit] bash:', args.command);
  });
}
```

Two guarantees worth relying on:

- **A throwing hook cannot break a turn.** Each hook runs inside a `try/catch`, the
  error is reported to stderr, and the agent continues.
- **Hooks run in registration order**, and may be async.

### Registering config defaults

`api.registerConfig({ ... })` merges values used by `resolveConfig`. They are applied
after the built-in defaults and **before** the user's `config.toml`, so the user
always wins.

### The full API surface

| Member | Type | Purpose |
|--------|------|---------|
| `api.registerTool(spec)` | fn | Add a tool. Returns an unregister function. |
| `api.registerCommand(cmd)` | fn | Add a `/command`. Returns an unregister function. |
| `api.registerHook(name, fn)` | fn | Add a lifecycle hook. Returns an unregister function. |
| `api.registerConfig(defaults)` | fn | Merge default config values. |
| `api.ctx` | getter | The live agent context. Only meaningful inside a hook. |
| `api.tools` / `api.commands` / `api.hooks` / `api.config` / `api.plugins` | getter | Copies, for introspection. |

All three `register*` functions return a function that undoes the registration, so a
plugin can unload itself:

```javascript
const off = api.registerTool({ /* … */ });
// later:
off();
```

### Things that trip people up

- **Names must be unique across all plugins.** Registering `Echo` twice throws; two
  plugins cannot both claim the same tool or command name.
- **Plugins load once, at startup.** Editing a plugin file needs a restart.
  `/reload` reloads `config.toml`, not plugin code.
- **`api.ctx` is null outside a hook.** It is injected when the agent runs, so read it
  inside a hook callback rather than at install time.
- **A tool's `execute` must return a string.** That string is what the model sees.
  Throw instead, and the transcript shows `Error running <tool>: …`.

---

## 14. For developers

### Project layout

```
bin/            CLI entry points (hncode, .cmd, .ps1) + install hooks
src/
  index.js      argv parsing, subcommands, headless mode, TUI dispatch
  tui.js        the raw-TTY renderer, key handling, slash commands
  agent.js      the tool loop (request → tool calls → repeat)
  llm.js        OpenAI + Anthropic client (streaming & non-streaming)
  config.js     config.toml resolution, providers, models, thinking effort
  session.js    session store
  plugin.js     plugin host + registry
  tools/        one file per tool
  colors.js     ANSI colour helpers
  term.js       token estimation, width math, wrapping
```

### The agent loop

`src/agent.js` runs: build the request → stream the reply → if the model emitted tool calls, execute them and append the results → repeat, until the model answers without tool calls, the user interrupts, or the step budget (if any) runs out. A completion guard nudges the model if it stops mid-task (up to `MAX_NUDGES` times).

### Adding a tool

1. Create `src/tools/mytool.js` exporting a `spec` with `name`, `description`, `parameters` (JSON schema), and `async execute(args, ctx)`.
2. Register it in `src/tools/index.js`.

### Token estimation

`estimateTokens(text)` in `src/term.js`: ASCII counts ~4 chars/token, non-ASCII ~1 char/token.

### Running the test suite / checks

There is no test runner wired up; keep `node --check <file>` clean and exercise changes manually.

---

## 15. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `hncode: interactive mode requires a TTY` | You are piping output. Use `hncode -p \"…\"` for non-interactive use. |
| `no api_key configured` | Set `HNCODE_API_KEY`, or configure a provider (`/provider`). Run `hncode doctor config`. |
| Commands look garbled on Windows | Use **[Windows Terminal](https://github.com/microsoft/terminal)**; legacy `cmd.exe` consoles render poorly. It is free on the Microsoft Store, and hncode's renderer is built for it. |
| Paste feels slow | It should be ~10 ms after the first paste (the clipboard helper is pre-warmed). A very slow first paste is the PowerShell cold start. |
| `Edit rejected: you have not read the lines…` | `Read` the file (the relevant lines) first, then `Edit`. |
| Context gauge near 100% | Run `/compact`, or let auto-compaction trigger at 85%. |
| Context gauge near 100% | Run `/compact`, or let auto-compaction trigger at 85%. |
| A plugin I wrote does not load | The reason is on **stderr**, not in the chat — the TUI owns the screen. Run hncode, quit, and read the terminal output. One file per plugin, and the name must be unique. |

---

## 16. Acknowledgments

hncode is built on the ideas of several open-source projects:

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** — the cyan-blue raw-terminal TUI and the overall agent shape that this project follows.
- **[Claude Code](https://github.com/anthropics/claude-code)** — conversation flow and tool-interaction patterns.
- **[Codex](https://github.com/openai/codex)** — reading its open-source implementation shaped several behaviours here: the `AGENTS.md` loading spec (scope, precedence, injection), the rule against spawning subagents without explicit permission, the plan-tool state machine, the code-review finding filter, and parts of the system prompt.

---

## 17. License

[GNU General Public License v3.0](https://github.com/NiceHello666/hncode/blob/main/LICENSE).

1. ✅ Free to use, modify, and share.
2. ✅ Must retain author attribution (NiceHello666) and link back to the repository.
3. ❌ May not be used for commercial purposes.

---

[Back to README](https://github.com/NiceHello666/hncode/blob/main/README.md) · [简体中文 Wiki](https://github.com/NiceHello666/hncode/blob/main/README_WIKI_CN.md)
