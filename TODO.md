# hncode TODO

## Fixed

- [x] **Fix `args is not defined` in `/compact` command** — `src/tui.js:2508`
  The `compact` case referenced an undefined variable `args`. Removed the
  redundant `const raw = args.trim();` line; the function's existing
  `const raw = (arg || '').trim();` (line ~2142) is used instead.

- [x] **Fix `/model` picker overflow above screen** — `src/tui.js:~1617-1620`
  The picker's `overhead` calculation did not account for footer rows (the
  "Thinking" options in the `/model` picker). Now includes `footerRows`
  (0 or 2) in the overhead. Also added `MAX_PICKER = 12` constant to cap
  visible items.

- [x] **Add `MAX_PICKER = 12` constant** — `src/tui.js:111`
  Caps the number of visible picker items at 12, similar to `MAX_MENU = 6`.

- [x] **Reduce right-side width by 1 for queue panel and user message boxes**
  - Queue panel text width: `w - 4` → `w - 6` (`src/tui.js:711`)
  - User/queued message box width: `boxW = innerW` → `boxW = innerW - 2`
    (`src/tui.js:1213`)

- [x] **Fix steer format: render as `steer` role (no box)** — `src/tui.js:3774`
  Steered messages were added as `user` role (with a box). Changed to
  `addChat({ role: 'steer', text })`. The `steer` role has no box, is
  yellow, and shows the `❯` marker.

- [x] **Rename `/cool-mode` to `/calm-mode`** — `src/tui.js, src/config.js`
  - Command: `cool-mode` → `calm-mode`
  - Config key: `cool_mode` → `calm_mode`
  - Config property: `coolMode` → `calmMode`
  - Env var: `HNCODE_COOL_MODE` → `HNCODE_CALM_MODE`
  - Constant: `COOL_MODE_INSTRUCTION` → `CALM_MODE_INSTRUCTION`
  - Backward compat: legacy `cool_mode` key still read in config.js

- [x] **Fix `setConfigString is not defined` error** — `src/tui.js:27`
  `setConfigString` was used but never imported from `./config.js`.
  Added to the import statement.

- [x] **Fix editor ESC/arrow keys when running** — `src/tui.js:~3957`
  When the editor (from `/set-system-prompt`) is open and a turn is running,
  ESC interrupted the agent instead of closing the editor. Fixed by adding
  `state.editor` to the `overlayOpen` check.

- [x] **Fix scroll jumping to session beginning** — `src/tui.js:~4772`
  `anchorScroll()` used `state._anchorRows || 0` as the previous row count,
  which caused a massive scroll jump on the first call after scrolling up.
  Changed to only adjust scroll when `_anchorRows` is previously set.

- [x] **Add category tabs to `/model` picker** — `src/tui.js`
  - Added `pickerCategory` and `pickerCategories` state fields
  - `pickerFiltered()` now filters by active category
  - Category tabs rendered above the item list ("All" + provider names)
  - Tab key cycles through categories
  - `/model` picker items now have a `category` field (the provider name)
  - Hint updated to mention Tab for category switching

- [x] **Composer text selection via mouse drag** — `src/tui.js`
  - Added `composerSel` state for selection range
  - Mousedown on composer rows stores position for drag selection
  - Mousemove extends the selection (highlighted in yellow)
  - Mouseup clears the mousedown state
  - Context menu includes "Copy" for composer selection
  - Ctrl+Shift+C copies composer selection (before falling back to last answer)
  - All key handlers (typing, arrows, backspace, etc.) clear the selection
  - Added `highlightSelection()` helper function

- [x] **Fix `/provider` Enter to edit, remove Ctrl+E** — `src/tui.js`
  - Enter on a regular provider now opens the edit form (was: selects provider)
  - Ctrl+E handler removed from the generic key handler
  - Hint updated: "Enter edit" instead of "Enter select · Ctrl+E edit"
