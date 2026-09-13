# hncode - AI Coding Agent Configuration

## Overview
hncode is a kimi-code-cli-style CLI coding agent with cyan-blue TUI, OpenAI + Anthropic streaming support, and MCP-style toolbelt.

## Key Features
- **Terminal UI**: Raw-TTY renderer with block cursor, differential painting
- **Streaming**: Full support for OpenAI and Anthropic protocols with real-time token display
- **MCP Tools**: Edit, Read, Write, Bash, Glob, Grep, TodoList, and more
- **Modes**: Ask When Needed (yolo), Never Ask (auto), Always Ask
- **Thinking Support**: Reasoning blocks with `` tags
- **Plan/Focus Modes**: Independent planning and focused execution modes

## File Reading Best Practices

### Use Bash for Large Files to Save Tokens
When reading large files, prefer using `Bash` commands over the `Read` tool:

```javascript
// ❌ Bad - consumes many tokens for large files
Read { path: "large-file.js" }

// ✅ Good - use bash head/tail/wc for size control
Bash { command: "head -100 /path/to/file" }
Bash { command: "wc -l /path/to/file" }
Bash { command: "cat /path/to/file | head -n 50" }
```

### When to Use Each Method

**Use Bash when:**
- File is larger than ~100 lines
- You only need a portion of the file
- You want to check file size first
- You're doing initial exploration

**Use Read when:**
- File is small (< 50 lines)
- You need the complete file content
- The file has been confirmed as necessary

### Example Workflow

```javascript
// Step 1: Check file size
const size = await Bash({ command: "wc -l src/large-module.js" });

// Step 2: Read in chunks if needed
if (size.includes("1000")) {
  const firstPart = await Bash({ command: "head -100 src/large-module.js" });
  const lastPart = await Bash({ command: "tail -50 src/large-module.js" });
  // Process parts separately
} else {
  // File is small enough to read completely
  const content = await Read({ path: "src/large-module.js" });
}
```

## MCP Tool Usage Patterns

### Read Tool Success Pattern
```javascript
{
  "name": "Read",
  "args": {
    "path": "relative/path/to/file.js"
  }
}

// Display format
● Used Read (src/config.js)
↳ File read successfully: 1033 bytes
```

### Bash Tool Success Pattern
```javascript
{
  "name": "Bash",
  "args": {
    "command": "head -20 src/main.js"
  }
}

// Display format
● Used Bash (head -20 src/main.js)
↳ [output appears below]
```

## Toolbelt (13 tools)

| Tool | Purpose |
|------|---------|
| `Read` | Read a text file (line ranges; records a hash for Edit staleness checks) |
| `Write` | Create/overwrite a file |
| `Edit` | Exact snippet replacement (CRLF-safe; rejects if file changed since Read) |
| `Glob` | Find files by glob pattern |
| `Grep` | Search file contents (regex) |
| `Bash` | Run a shell command (bash preferred; `run_in_background` for detached tasks) |
| `TodoList` | Manage the task list shown above the composer |
| `FetchURL` | Fetch a web page's main text (any http/https URL, incl. localhost) |
| `WebSearch` | Search the web (Bing HTML backend, no API key) |
| `TaskList` | List background tasks |
| `TaskOutput` | Read a background task's output |
| `TaskStop` | Kill a background task |
| `TaskWait` | Block until a background task finishes (timeout is not an error) |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Send the message |
| Ctrl-J / Shift-Enter | Insert a newline in the composer |
| ↑ / ↓ | Input history (empty composer) · scroll the chat |
| PgUp / PgDn | Scroll the transcript |
| / | Open the command menu; Tab completes |
| Esc | Close the menu/dialog · interrupt a running turn |
| **Ctrl-B** | Move a running foreground Bash command to the background (detach) |
| Ctrl-O | Expand/collapse tool output and thinking blocks |
| Ctrl-T | Expand/collapse the todo panel |
| Ctrl-C | Interrupt a running turn; when idle, press twice to exit |
| Ctrl-D | Exit when the composer is empty |

### Background tasks
- Start one with `Bash { run_in_background: true, description: "..." }`; it returns a `task_…` id.
- The status line shows `bg N→M` (running→finished) when any task exists; toggle via `/statusline` → "background tasks".
- **Ctrl-B** detaches a *foreground* command that is still running (kimi-code parity): the child keeps running, becomes a task, and the agent's turn continues immediately.
- Inspect with `/tasks` or the TaskList / TaskOutput / TaskWait tools.

## Code Architecture

### Core Files
- `src/tui.js`: Terminal UI rendering (Codewhale-style span-based selection)
- `src/colors.js`: ANSI color primitives and cursor control
- `src/term.js`: Terminal utilities (visual width, tab expansion)
- `src/agent.js`: Agent orchestration and tool calling
- `src/config.js`: Configuration management
- `src/session.js`: Session persistence

### Edit Tool — CRLF Handling (Windows-correct)
The Read tool normalizes `\r\n` → `\n`, so an agent builds `old_string`/`new_string` with LF even when the file on disk is CRLF. The Edit tool must therefore:
1. **Match on LF-normalized content**: read the file, split on `/\r\n|\r|\n/` and rejoin with `\n`, and normalize the caller's `old_string` the same way. (A raw LF `old_string` against a CRLF file otherwise reports "not found".)
2. **Restore the file's own line-endings on write**: detect `eol = content.includes('\r\n') ? '\r\n' : '\n'`, apply the replacement to the LF-normalized text, then rejoin with the original `eol` — never produce mixed line endings.
- `old_string` may not be empty; ambiguous matches (>1, no `replace_all`) are rejected; `replace_all` uses `replaceAll`.
- Snippet-based exact replacement (not whole-file rewrite) so edits stay token-cheap.

### Rendering Pipeline
1. **Span-based rendering** (Codewhale style):
   - Each transcript line is a `Line`: `{ spans: [{ content, color }, ...] }`
   - `messageLines()` emits per-row strings (possibly ANSI-styled)
   - `rowToLine()` parses each row via `ansiToSpans()` into structured `{content, color}` spans so selection column math is exact (never counts ANSI bytes as visible chars)
   - Selection is applied INSIDE each line's spans; the number of lines NEVER changes

2. **Key Functions**:
   - `renderChatLines()`: Returns `Line[]` with caching (keyed by text/width/expanded)
   - `applySelectionToLines(lines, sel)`: Codewhale `apply_selection` — for each line between start.row and end.row, computes (colStart, colEnd) and calls `applySelectionToLine`
   - `applySelectionToLine(line, colStart, colEnd)`: Codewhale `apply_selection_to_line` — walks spans tracking `currentCol`; fully-outside spans kept, fully-inside spans get `C.selBg` PREPENDED to their existing color (like Ratatui `.patch()` which composes bg + fg), partial spans split by codepoint into before/selected/after
   - `lineToString(line)`: Serialises spans back to an ANSI string for the frame. **Each span must end with `C.reset`** (`s += sp.color + sp.content + C.reset`) — otherwise a selection background (which carries no fg) bleeds into the following spans, making a single-span line's selection run all the way to the right edge instead of stopping at the dragged column.
   - `composeFrame()`: Assembles complete frame; applies selection BEFORE computing total/scroll so line count is stable
   - `diffFrame()`: Differential painting for efficient updates

3. **Critical invariants**:
   - Selection must NEVER splice/replace whole lines — only each line's internal `spans` array. The previous one-span-per-line model used `splice` which renumbered lines and desynchronised the scrollbar `total` and mouse `lineIdx` mapping.
   - **Cache pollution**: `renderChatLines()` returns cached `Line` objects (shared with `msg._cache`). `composeFrame` must CLONE each line's spans BEFORE `applySelectionToLines` (`.map(ln => ({spans: ln.spans.map(sp => ({content, color}))}))`), otherwise selection backgrounds permanently stick to cached rows and old highlights accumulate across frames.
   - A new selection replaces the old one: `mousedown` always creates a fresh `{anchor, head}` object, discarding the previous selection.

### Composer input & paste
- **Shift+Enter** inserts a newline. Terminals do not report Shift+Enter distinctly by default, so hncode enables the **Kitty keyboard protocol** (`ESC[>1u` on start, `ESC[<u` on exit) and parses `ESC[ cp ; mod u` (CSI-u). codepoint 13/10 + shift → `newline`; ctrl+letter is mapped back to the `c-x` tokens. Terminals without support ignore the sequence (classic input still works).
- **Esc clears the whole composer** (all text + the paste registry), not just a slash command.
- **Multi-line paste collapses** to a `[paste #N +L lines]` marker; the real text is stored in `state.pastes` (a Map) and expanded on submit by `expandPastes`. A single-line paste is inserted verbatim. The marker renders with a block background (`highlightPasteMarkers` → `C.selBg`) so it reads as one chip.
- **The marker is an ATOMIC unit**: `adjacentPasteMarker(text, caret, dir)` finds a marker immediately left (−1) or right (+1) of the caret; ←/→ jump over the whole marker, and Backspace/Delete remove the entire marker (also dropping its stored paste). A caret in the MIDDLE of a marker still moves char-by-char.
- **Composer text is WHITE** (`C.white`); only the box border stays theme-cyan. Rendered as `col('│', C.cyan) + C.white + fitAnsi(row, insideW) + C.reset + col('│', C.cyan)` so the border colour and the text colour are independent.
- **Queue / steer**: while the agent is running, Enter QUEUES the message (transcript role `queued`, icon ⏳, gray). At each tool boundary the queue is drained into the running turn via `agent.steer()` and those rows flip to role `steer` (icon ↪, yellow). Anything left when the turn ends runs as a fresh turn.

### Global hover
- Every clickable region gets a hover tint: `state.hoverHit` (set in the `mousehover` handler via `hitAt`) is passed to `tintRange(row, col0, col1)` in composeFrame, which inserts BOLD (`ESC[1m`/`ESC[22m`) over just that column range — brightening the EXISTING colour a touch rather than changing it. Only re-renders when the hovered region actually changes.
- The scrollbar keeps its separate 3-state hover/press tint (see below); all other regions are click + hover only.

### Cursor positioning (never let it drift)
`diffFrame` must ALWAYS emit the cursor position (`CUP` = `ESC[row;colH`) on every paint, not only when it changed. Repainting content moves the terminal cursor to the end of the last written row; skipping the CUP left the caret stuck at the bottom-right. Only the cursor **shape** sequence (`ESC[2 q` / show / hide) stays conditional — that is what flickers. The composer caret row is bottom-anchored: `caretScreenRow = h - bottomChrome - 2 - (composer.rows.length - 1 - composer.caretRow)`, so it is independent of how many transcript rows were drawn above.

### Global mouse click support
`composeFrame` is pure, so it emits a **hitbox registry** (`frame.hitboxes`) alongside the lines; the mouse handler consumes it.
- Each surface calls `addHit(row, col0, col1, {kind, ...})` while pushing rows; rows are recorded in pre-clamp `lines` coordinates, then shifted to final screen rows (`+ topPad - topTrim`) and filtered to `[0, h)` before returning.
- `paintNow` stores `state._hitboxes` and `state._composerMeta` from each frame; `hitAt(t)` scans topmost-first for the region under a click.
- `dispatchHit(hb)` actions by `kind`:
  - `menuItem` → run the `/command` (mirrors Enter on the menu)
  - `composerRow` → `composerTextIndexAt(layout, rowIdx, colInContent)` maps the click column back to a text index, sets `state.caret` (click-to-caret)
  - `pickerItem` → select + activate the item (same done/picker-identity guard as Enter; recomputes `footerFor`)
  - `pickerFooterOpt` → set the footer value (e.g. thinking effort)
  - `formField` → focus that field
  - `formType` → focus the Type row + set the option
- Hit-testing runs BEFORE the overlay guard, so picker/form clicks work; only the **scrollbar** has hover/press states, everything else is click-only.
- `composerLayout` now also returns `meta: [{start, end, preWidth}]` (per display row) for the caret mapping; `composerTextIndexAt` is exported for tests.

### Scrollbar Implementation (Codewhale Style)
- Scrollbar glyphs (`│` track, `┃` thumb) occupy the FINAL column as their own gutter
- Text is padded first: `row = fitAnsi(row, w - 1) + glyph` — `fitAnsi` pads/truncates to exactly w-1 columns so the glyph always sits at column w-1 (0-based), never glued to the text
- Geometry computed once per frame (`scrollbarGeometry`) and stored in `state._sb` for mouse hit-testing
- `showBar = total > bodyH && w > 4`
- **Thumb interaction states** (three colours, idle auto-restores to the brand colour):
  - idle → `C.scrollThumb` (brand cyan-blue)
  - hover (`state.sbHover`, pointer over the gutter) → `C.scrollThumbHover` (a touch whiter/brighter)
  - active (`state.sbDrag`, pressed/dragging) → `C.scrollThumbActive` (a touch darker)
  - Hover requires `?1003h` (bare pointer motion) + a `mousehover` SGR branch (btn bit 32 set, low 2 bits = 3). Only re-render when `sbHover` actually flips; `mouseup` re-evaluates `sbHover` so the tint clears when the pointer leaves.

### Context window & provider deletion
- **Per-model context**: `resolveConfig` sizes `maxContextTokens` from the model's own `context_length` (discovered from the provider's `/v1/models` and persisted by `addModel`). Precedence: env/root override → model `context_length`/`context_length` → **default 512000**. (Previously everything was pinned to a hard-coded 128k.)
- `fetchAndRegisterModels` stores `contextLength`/`maxTokens` per model and passes them to `addModel`, which writes `context_length = N` / `max_tokens = N` into the `[models."p/m"]` block.
- **Deleting a provider removes its models too**: `removeProvider(name)` strips `[providers.name]` AND every `[models."name/..."]` entry, and the `/provider` delete handler also purges `cfg.raw.models` for that provider — otherwise `/model` kept listing the deleted provider's models.

### Edit staleness — must Read the edited lines
`checkStale` (src/tools/edit.js) enforces that the AI edits content it actually Read:
1. Locate the edit target's first line in the current file. If it falls inside a Read region whose hash still matches → allow.
2. Whole file unchanged but the target was never Read (no region covers it) → **reject**: "you have not read the lines you are editing … Read the target lines first". This is what stops "read lines 1-3, edit line 7".
3. File changed on disk and the target is not in an intact Read region → reject (stale snapshot).
- Reading the WHOLE file records a region covering every line, so "read full, edit a part" still passes.
- After a successful Edit the pool is **silently re-armed for the edited region** (nothing is told to the model): `fileHash`/`lines`/stat are refreshed, the edit site is located in the NEW content, its line span + hash are added to `regions`, and any old region whose content no longer matches is dropped. This lets the AI keep editing on top of its own change without another Read, while external changes and never-read regions are still rejected.

### Text Color Defaults
- Assistant output: WHITE (not cyan) — plain paragraphs render with no colour code (terminal default)
- **Fenced code block CONTENT: WHITE** — rendered with `C.white`, not `codeFg`. The cyan is reserved for UI chrome + language label; a large code block in cyan reads as "everything is the theme colour". (Inline `` `code` `` keeps cyan via `codeFg` for visual distinction.)
- Bold/headings: BOLD via `\x1b[1m`
- User/System: Cyan/Green
- Tool calls: White/Green
- Selection background: `C.selBg` (dark teal `\x1b[48;5;23m`) PREPENDED to existing fg, preserving original foreground colour (Codewhale `Style::patch` behaviour)

### Glyph Widths (charWidth special-cases) — CRITICAL for alignment
- **`❯` (0x276F) is ONE column.** Counting it as 2 made `fitAnsi` under-pad every user line by one column, so the scrollbar glyph landed one cell LEFT of the right edge (misaligned scrollbar on user messages). This was the root cause of "the `|` isn't aligned on user lines".
- `◆` (0x25C6) = 2, `●` (0x25CF) = 1, `↳` (0x21B7) = 1, `▸ □` (0x25B8/0x25A1) = 1, `⚑ ⚒` (0x2691/0x2692) = 2.

## Commands Reference

### Mode Commands
- `/yolo` - Ask When Needed mode
- `/auto` - Never Ask mode  
- `/permission` - Select permission mode

### Planning & Focus
- `/plan [on|off|clear]` - Toggle plan mode (read-only planning)
- `/focus [on|off]` - Toggle focus mode (minimal tools first)

### Model Management
- `/model [name]` - Switch LLM model
- `/effort [off|on|high|medium|low]` - Set thinking effort level
- `/provider` - Manage AI providers

### Session Management
- `/new` - Start fresh session
- `/sessions` - Browse and resume sessions
- `/compact [instruction]` - Compact conversation context
- `/export-md [path]` - Export session as Markdown

### Workspace
- `/add-dir [list | <path>]` - Add additional workspace directory
- `/init` - Generate AGENTS.md for current project

### System
- `/settings` - Open settings menu
- `/theme [auto|dark|light|<name>]` - Set terminal theme
- `/statusline` - Configure status line items
- `/help` - Show commands and shortcuts

## Environment Setup

### Requirements
- Node.js >= 20
- Windows Terminal or compatible terminal emulator
- Git Bash (for cross-platform compatibility)

### Configuration
Located at `~/.hncode/config.toml`:
```toml
[models]
# Model definitions
[yolo]
workspace = "."
maxContextTokens = 128000
```

### PowerShell Integration
For environment variable reloading:
```powershell
reloadenv  # Reloads PATH and HNCODE-related variables from registry
```

## Testing & Verification

### Read Tool Test
To verify Read tool works:
1. Create test file: `New-Item -Path test-file.txt`
2. Run hncode and request: `Read test-file.txt`
3. Verify output shows: `● Used Read (test-file.txt)`

### Selection Test
1. Type some text in assistant response
2. Left-click and drag to select
3. Verify background highlight appears correctly
4. Press Ctrl+C to copy (without auto-copy)

### Streaming Test
1. Send a prompt that generates long output
2. Verify tok/s counter updates in real-time
3. Check context line shows: `rounds X | steps Y | Z tok/s | context: P%`

## Known Issues & Solutions

### Scrollbar Corruption
- **Issue**: `│` appearing at end of every line
- **Solution**: Replace last column instead of appending (Codewhale style)

### Text Color
- **Issue**: Assistant text appearing cyan instead of white
- **Solution**: Default assistant color is now WHITE

### Token Usage
- **Issue**: Large files consuming too many tokens
- **Solution**: Use Bash commands with `head`/`tail`/`wc` for controlled reads

## Development Notes

### Span-Based Rendering Benefits
- Precise selection highlighting without ANSI string manipulation
- Efficient cache invalidation (only affected spans re-render)
- Preserves existing formatting while adding selection overlay

### Codewhale Inspiration
- Line structure: `Line { spans: [Span, ...] }`
- Selection splits spans rather than modifying strings
- Incremental rendering for high-throughput models

### Performance Optimizations
- Message caching by `(text, width, expanded)` key
- Span splitting only when selection overlaps
- Differential paint skips unchanged rows

## Credits
Inspired by kimi-code-cli and Codewhale TUI architecture.
