// Output styles, loaded from FILES — the way Claude Code's `.claude/output-styles/`
// works (a file's NAME is the style, its BODY is the instructions).
//
// Why files rather than another picker entry: an output style is a paragraph of
// prompting that a user iterates on. Editing a TOML string inside config.toml for
// that is unpleasant, and it makes the style unreviewable in a diff. A directory of
// Markdown files means the style is editable with $EDITOR, diffable, and shareable
// by copying one file.
//
// File format (all parts optional except the body):
//
//     ---
//     name: Terse reviewer
//     description: Reviews code, states findings, no praise
//     ---
//     You answer only in short declarative sentences. Never open with praise…
//
// A file with no frontmatter is valid: the name then comes from the filename
// (`terse-reviewer.md` -> `Terse Reviewer`), which is what makes ad-hoc styles
// cheap to add.
//
// The style is INJECTED as a system-ish reminder on each request rather than baked
// into the system prompt, so switching styles does not invalidate the prompt cache
// and reverting is a matter of clearing a flag.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where styles are read from, most specific first.
 *
 * `home` is the `.hncode` DIRECTORY, matching how config.js resolves every other
 * per-user path (`path.join(homeDir(), '.hncode', …)`). Deriving it independently
 * here — `process.env.HNCODE_HOME || ~/.hncode` — got it wrong under HNCODE_HOME,
 * which points at the PARENT of `.hncode`: styles then lived in
 * `<HNCODE_HOME>/output-styles` while the rest of the app looked in
 * `<HNCODE_HOME>/.hncode/…`, so a user with HNCODE_HOME set could never see a style.
 * The caller passes `config.hncodeDir()`, so both agree by construction.
 */
export function styleDirs(cwd, home) {
  const base = home || defaultHncodeDir();
  const dirs = [path.join(base, 'output-styles')];
  // Project-level styles override the personal ones of the same name, so a repo can
  // pin its own style for everyone working in it.
  if (cwd) dirs.push(path.join(cwd, '.hncode', 'output-styles'));
  return dirs;
}

// The per-user .hncode directory, resolved exactly as config.js does it:
//   path.join(HNCODE_HOME || os.homedir(), '.hncode')
// HNCODE_HOME stands in for the HOME directory — it is how a test or a user keeping
// config on another drive relocates the whole thing — so `.hncode` is appended to
// it. Appending it to a value that ALREADY contained `.hncode` put the styles one
// directory too deep and made them invisible.
function defaultHncodeDir() {
  return path.join(process.env.HNCODE_HOME || os.homedir(), '.hncode');
}

/** `terse-reviewer` -> `Terse Reviewer`. The fallback name when a file has none. */
export function nameFromFile(file) {
  const base = path.basename(String(file || ''), '.md');
  return base.split(/[-_]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Split a style file into { meta, body }.
 *
 * Only a leading `---` fence is treated as frontmatter — the same rule as Jekyll's,
 * chosen because a style BODY will often contain `---` (a horizontal rule in
 * Markdown), and treating a later one as a fence would swallow the instructions.
 */
export function parseStyle(raw, file = '') {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const meta = {};
  let body = text;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    // Find the CLOSING fence; everything between is metadata.
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        // Strip one layer of quotes if present; a description with a colon is
        // otherwise fine because only the FIRST colon separates the key.
        meta[m[1].toLowerCase()] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      }
      body = lines.slice(end + 1).join('\n');
    }
  }
  const name = meta.name || nameFromFile(file);
  return { name, description: meta.description || '', body: body.trim(), meta };
}

/** Every style readable right now, sorted by name. Missing directories are not an error. */
export function listStyles(cwd, home) {
  const found = new Map();   // name (lowercased) -> style
  for (const dir of styleDirs(cwd, home)) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries.sort()) {
      if (!f.endsWith('.md')) continue;
      let raw = '';
      try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const style = parseStyle(raw, f);
      if (!style.body) continue;                 // a style with no body does nothing
      // The LATER directory wins (project over personal): this loop runs home first.
      found.set(style.name.toLowerCase(), { ...style, file: path.join(dir, f), dir });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One style by name (case-insensitive), or null. */
export function findStyle(name, cwd, home) {
  // A trailing `.md` is dropped, since `ls` shows the extension and typing it is the
  // obvious thing to do after looking at the directory.
  const want = String(name == null ? '' : name).trim().toLowerCase().replace(/\.md$/, '');
  if (!want) return null;
  const all = listStyles(cwd, home);
  // Every spelling a user might type, most exact first:
  //   1. the display name (`Terse Reviewer`)
  //   2. the FILE name without .md (`terse-reviewer`) — this is what `ls` shows and
  //      what a user types after seeing the directory, and without it the lookup
  //      failed for the very style they just created.
  //   3. a prefix of either, so `/output-style terse` is enough to disambiguate.
  const fileOf = (s) => String(s.file || '').replace(/^.*[\\/]/, '').replace(/\.md$/, '').toLowerCase();
  return all.find((s) => s.name.toLowerCase() === want)
    || all.find((s) => fileOf(s) === want)
    || all.find((s) => s.name.toLowerCase().startsWith(want))
    || all.find((s) => fileOf(s).startsWith(want))
    || null;
}

/**
 * The reminder text that carries a style into a request.
 *
 * Deliberately wrapped in the same `<system-reminder>` envelope the harness uses
 * elsewhere, and placed so the model reads it as an instruction about FORM rather
 * than as content to answer. It says the style overrides earlier formatting
 * requests, because a system prompt already contains output rules and the later
 * instruction is the one a model follows.
 */
export function styleReminder(style) {
  if (!style || !style.body) return '';
  return [
    '<system-reminder>',
    `The user has selected the "${style.name}" output style. It governs the FORM of`,
    'your replies and takes precedence over any earlier formatting instruction.',
    '',
    style.body,
    '</system-reminder>',
  ].join('\n');
}

/** Create a starter file so /output-style new gives the user something to edit. */
export function writeStyleTemplate(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(name || 'my-style').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-style';
  const file = path.join(dir, `${slug}.md`);
  if (fs.existsSync(file)) return { file, created: false };
  const body = [
    '---',
    `name: ${nameFromFile(file)}`,
    'description: what this style is for',
    '---',
    '',
    'Write your style instructions here. They describe the FORM of every reply:',
    'length, tone, structure, what to leave out. They are added to each request as',
    'a system reminder, so they take precedence over the default formatting rules.',
    '',
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, created: true };
}

export default { styleDirs, listStyles, findStyle, parseStyle, styleReminder, nameFromFile, writeStyleTemplate };
