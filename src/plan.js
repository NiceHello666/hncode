// Plan review helpers — turning a model's <plan> block into something the user
// can actually review before any file is touched.
//
// Plan mode already asks the model for a <plan>…</plan> block and prompts to
// approve it. What this module adds is the review material and the persistence:
//
//   * filesReferenced(plan)  — which paths the plan says it will touch, so the
//                              user sees the blast radius instead of prose.
//   * planStats(plan)        — step/line counts for a compact summary line.
//   * savePlan()             — write the approved plan to
//                              <workspace>/.hncode/plans/<timestamp>.md so it
//                              survives the session and can be handed to a
//                              subagent or pasted into an issue.
//
// Everything here is pure except savePlan(). The parsing is deliberately
// tolerant: a plan is free-form Markdown, so a missed file reference degrades to
// "fewer files listed", never to an error.

import fs from 'node:fs';
import path from 'node:path';

// Paths that appear in a plan: backticked spans, and bare tokens that look like
// a path (contains a slash and a file-ish extension, or a well-known filename).
// Ordered by first appearance, de-duplicated, and filtered to plausible files.
const PATH_EXT = /\.(?:[a-z0-9]{1,8})$/i;
const KNOWN_FILES = /^(?:AGENTS\.md|README(?:\.[a-z]+)?|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile|Dockerfile|\.gitignore|tsconfig\.json)$/i;

export function filesReferenced(plan) {
  const text = String(plan || '');
  const found = [];
  const seen = new Set();
  const push = (raw) => {
    let p = String(raw || '').trim();
    // Strip trailing punctuation the prose adds around a path.
    p = p.replace(/^[`'"(\[]+/, '').replace(/[`'")\],.;:]+$/, '');
    if (!p || p.length > 200) return;
    if (/\s/.test(p)) return;
    if (p.includes('://')) return;                 // a URL, not a path
    if (/^[-*#>]/.test(p)) return;
    // A token is a plausible path when it has a separator, a file-ish extension,
    // or is a well-known project filename. This keeps a bare word like "config"
    // from being reported as a file.
    const looksPath = p.includes('/') || p.includes('\\') || PATH_EXT.test(p) || KNOWN_FILES.test(p);
    if (!looksPath) return;
    const key = p.replace(/\\/g, '/');
    if (seen.has(key)) return;
    seen.add(key);
    found.push(p);
  };

  // 1. backticked spans (the prompt asks for files in backticks)
  for (const m of text.matchAll(/`([^`\n]+)`/g)) push(m[1]);
  // 2. bare tokens that look like paths (covers un-backticked mentions)
  for (const m of text.matchAll(/(?:^|[\s(])((?:[\w.@-]+\/)+[\w.@-]+|\b[\w.-]+\.[a-z0-9]{1,8}\b)/gi)) push(m[1]);
  return found;
}

// Compact summary for the review box: how many steps and how many lines.
export function planStats(plan) {
  const text = String(plan || '');
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  // A "step" is a heading (## / ###) or a top-level numbered item.
  const steps = lines.filter((l) => /^\s*(?:#{1,6}\s+\S|\d+[.)]\s+\S)/.test(l)).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return { lines: nonEmpty, steps, words, files: filesReferenced(text).length };
}

// Where a saved plan goes: <workspace>/.hncode/plans/<id>.md. Kept inside the
// project (not ~/.hncode) so it can be committed or reviewed with the change.
export function plansDir(workspace) {
  return path.join(workspace || process.cwd(), '.hncode', 'plans');
}

// Persist a plan. `id` defaults to a timestamp slug. Returns
// { ok, path, error }. Never throws.
export function savePlan(plan, workspace, id) {
  const text = String(plan || '').trim();
  if (!text) return { ok: false, path: '', error: 'empty plan' };
  const dir = plansDir(workspace);
  const slug = id || new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const file = path.join(dir, `${slug}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `# Plan (${new Date().toISOString()})\n\n${text}\n`, 'utf8');
  } catch (e) {
    return { ok: false, path: file, error: e.message };
  }
  return { ok: true, path: file, error: null };
}

export function listPlans(workspace) {
  const dir = plansDir(workspace);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const full = path.join(dir, n);
    try { const st = fs.statSync(full); if (st.isFile()) out.push({ name: n, path: full, mtimeMs: st.mtimeMs }); }
    catch { /* unreadable: skip */ }
  }
  // Newest first. Tie-break by name DESCENDING so that two plans written in the
  // same millisecond still come back in a deterministic (and, for the
  // timestamp-slug naming, newest-looking) order.
  out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

// The review panel's lines. Kept here (not the TUI) so it can be unit-tested.
export function reviewLines(plan, workspace) {
  const stats = planStats(plan);
  const files = filesReferenced(plan);
  const lines = [];
  lines.push(`Steps: ${stats.steps}   Lines: ${stats.lines}   Files mentioned: ${files.length}`);
  lines.push('');
  if (files.length) {
    lines.push('Files this plan will touch:');
    for (const f of files.slice(0, 40)) lines.push(`  ${f}`);
    if (files.length > 40) lines.push(`  … and ${files.length - 40} more`);
  } else {
    lines.push('No specific files named in the plan.');
  }
  lines.push('');
  lines.push('Enter = approve & execute   e = edit the plan   Esc = keep planning');
  return lines;
}