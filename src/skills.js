// Skills — user-supplied reusable prompt packages.
//
// A skill is a Markdown file under ~/.hncode/skills/<name>.md. Its body is
// text that gets injected into the conversation when the user activates it, so
// a skill is essentially a saved prompt fragment ("review this PR for security
// issues", "write tests in this project's style", …).
//
// Two ways a skill comes into being:
//   * /import-skill <file.md>  — copies (or overwrites) an external .md into the
//     skills directory. A duplicate name is REPLACED, not rejected.
//   * hand-authoring a file in the skills directory.
//
// Activation is /skill:<name>. The file body is what gets sent; an optional YAML
// front-matter block (--- … ---) is stripped from the body and only used for the
// display name / description, so a skill file can stay self-describing without
// leaking its metadata into the prompt.
//
// Everything here is filesystem-only and side-effect free apart from the
// explicit import/write helpers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_PREFIX = 'skill:';

// The skills directory. Kept next to the other hncode state (~/.hncode/…), and
// overridable through the environment for tests.
export function skillsDir() {
  return process.env.HNCODE_SKILLS_DIR || path.join(os.homedir(), '.hncode', 'skills');
}

// A skill name is the file's basename without extension. Normalise what the
// user typed ("Skill:Review", "/skill:review", "review.md") to a bare name.
export function normalizeSkillName(name) {
  let n = String(name == null ? '' : name).trim();
  n = n.replace(/^\/+/, '');                  // leading slash
  if (n.toLowerCase().startsWith(SKILL_PREFIX)) n = n.slice(SKILL_PREFIX.length);
  n = n.replace(/\.md$/i, '');                // trailing .md
  return n.trim();
}

// Parse an optional leading `---\n…\n---` front-matter block. Returns the body
// with the block removed, plus whatever fields were found. Tolerates a missing
// or malformed block (then body === text and meta is empty).
export function parseFrontMatter(text) {
  const src = String(text == null ? '' : text);
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let v = kv[2];
    // Strip a single layer of matching quotes.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

// All skills, sorted by name. Each entry: { name, description, path, size }.
// Unreadable files are skipped rather than failing the whole listing.
export function listSkills() {
  const dir = skillsDir();
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const name = f.replace(/\.md$/i, '');
    let description = '';
    try {
      const { meta } = parseFrontMatter(fs.readFileSync(full, 'utf8'));
      description = meta.description || meta.title || '';
    } catch { /* unreadable: keep it listed with no description */ }
    out.push({ name, description, path: full, size: st.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Read a skill's body (front-matter stripped). Returns null when not found.
export function readSkill(name) {
  const n = normalizeSkillName(name);
  if (!n) return null;
  const full = path.join(skillsDir(), `${n}.md`);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return null; }
  const { meta, body } = parseFrontMatter(text);
  return { name: n, description: meta.description || meta.title || '', body: body.trim(), path: full };
}

// Import (copy or overwrite) an external Markdown file as a skill.
// `name` overrides the derived name when given. Returns
// { ok: true, name, path, replaced } or { ok: false, error }.
export function importSkill(file, name) {
  const srcPath = path.resolve(String(file == null ? '' : file));
  let text;
  try {
    const st = fs.statSync(srcPath);
    if (!st.isFile()) return { ok: false, error: `Not a file: ${srcPath}` };
    text = fs.readFileSync(srcPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot read ${srcPath}: ${e.message}` };
  }
  // Name precedence: explicit argument, else front-matter `name`, else filename.
  const { meta } = parseFrontMatter(text);
  const derived = name || meta.name || path.basename(srcPath).replace(/\.md$/i, '');
  const skillName = normalizeSkillName(derived);
  if (!skillName) return { ok: false, error: 'Could not derive a skill name (pass one explicitly).' };
  if (/[\\/]/.test(skillName)) return { ok: false, error: `Invalid skill name: ${skillName}` };

  const dir = skillsDir();
  const dest = path.join(dir, `${skillName}.md`);
  const replaced = fs.existsSync(dest);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, text, 'utf8');
  } catch (e) {
    return { ok: false, error: `Cannot write ${dest}: ${e.message}` };
  }
  return { ok: true, name: skillName, path: dest, replaced };
}

export function deleteSkill(name) {
  const n = normalizeSkillName(name);
  if (!n) return false;
  try { fs.unlinkSync(path.join(skillsDir(), `${n}.md`)); return true; } catch { return false; }
}

// Completion candidates for the composer: names prefixed with the marker the
// user must type, so accepting a candidate yields `/skill:<name>`.
export function skillCompletions(prefix = '') {
  const p = normalizeSkillName(prefix).toLowerCase();
  return listSkills()
    .filter((s) => !p || s.name.toLowerCase().startsWith(p))
    .map((s) => ({ name: s.name, description: s.description, insert: SKILL_PREFIX + s.name }));
}

// Build the text a skill contributes to the conversation. A short header keeps
// the model from treating the body as the user's own words.
export function skillPrompt(skill) {
  if (!skill || !skill.body) return '';
  return `[skill: ${skill.name}]\n\n${skill.body}`;
}