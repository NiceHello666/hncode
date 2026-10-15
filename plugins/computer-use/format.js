// The result formatting shared by every computer-use tool.
//
// WHY THIS IS SEPARATE FROM THE TOOLS
// -----------------------------------
// Three shapes reach a tool's caller and each needs a different sentence:
//
//   a normal result      describe what happened, with the numbers that matter
//   an { error }         something went wrong that a retry might fix
//   an { unsupported }   the platform cannot do this at all, and the reason names the fix
//
// The third is the one worth centralising. A model that reads "unsupported" with no mechanism
// named will try the same call again; one that reads "install xdotool" has something to do, or a
// reason to pick a different approach. Every tool therefore routes its result through here.
import { isUnsupported } from './platform/util.js';

/** Turn a backend result into the text a tool returns. */
export function present(result, describe) {
  if (result == null) return 'Error: the operation returned nothing.';
  if (isUnsupported(result)) {
    return `Not available on this machine: ${result.unsupported}`;
  }
  if (result.error) {
    return `Error: ${result.error}`;
  }
  if (typeof describe === 'function') return describe(result);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * A screenshot as the tool result.
 *
 * The path and the pixel size travel together, because the caller needs both: the size to reason
 * about coordinates, and the path to attach the image. Reporting only the path leaves the model
 * guessing at the coordinate space, and a coordinate guessed from the wrong space clicks the wrong
 * place — the most common way a computer-use agent misbehaves.
 */
export function presentShot(shot, label) {
  if (isUnsupported(shot)) return `Not available on this machine: ${shot.unsupported}`;
  if (shot.error) return `Error: ${shot.error}`;
  const size = shot.width && shot.height ? `${shot.width}x${shot.height}` : 'unknown size';
  return `${label}: ${shot.path}\n${size} pixels, ${Math.round((shot.bytes || 0) / 1024)} KB`;
}

/**
 * The control tree as text, one element per line.
 *
 * A tabular line rather than JSON: a tree of a few hundred nodes as JSON costs several times the
 * tokens for the same information, and the fields are fixed. The index leads each line because it
 * is what every element-addressed tool takes as its argument.
 */
export function presentTree(tree, { hwnd, limit = 400 } = {}) {
  if (isUnsupported(tree)) return `Not available on this machine: ${tree.unsupported}`;
  if (tree.error) return `Error: ${tree.error}`;
  if (Array.isArray(tree)) return tree.map((t) => t.error || t.unsupported || '?').join('\n');
  const els = tree.elements || [];
  if (!els.length) {
    return `No elements found${hwnd ? ` in window ${hwnd}` : ''}. The window may be empty, `
      + 'minimised, or drawn without accessibility support (a game, or a custom-rendered pane). '
      + 'Use Screenshot to see what is there.';
  }
  const shown = els.slice(0, limit);
  const lines = shown.map((e) => {
    const box = e.width && e.height ? ` @${e.x},${e.y} ${e.width}x${e.height}` : ' (off screen)';
    const id = e.automationId ? ` #${e.automationId}` : '';
    const off = e.enabled === false ? ' [disabled]' : '';
    // The CONTENT, when a control has one and its name does not already say it. A window with no
    // real controls — a game, a canvas, a chat pane drawn by hand — puts its readable text here and
    // nowhere else, so leaving it out made such a window look empty.
    const body = (e.text || e.value || '');
    const shownBody = body && body !== e.name
      ? ` = "${body.length > 120 ? body.slice(0, 120) + '…' : body}"`
      : '';
    return `[${e.index}] ${e.controlType} "${e.name}"${id}${box}${off}${shownBody}`;
  });
  const more = els.length > shown.length
    ? `\n... ${els.length - shown.length} more (raise maxNodes, or narrow with controlTypes)`
    : '';
  const trunc = tree.truncated ? '\n(the walk hit maxNodes — this is a partial tree)' : '';
  return `${els.length} element(s)${hwnd ? ` in window ${hwnd}` : ''}:\n${lines.join('\n')}${more}${trunc}`;
}

/** A search result as text. */

export function presentMatches(res, what) {
  if (isUnsupported(res)) return `Not available on this machine: ${res.unsupported}`;
  if (res.error) return `Error: ${res.error}`;
  if (Array.isArray(res)) return res.map((t) => t.error || t.unsupported || '?').join('\n');
  const m = res.matches || [];
  if (!m.length) {
    return `No element matched ${what}. Use GetUITree to see what the window actually contains — `
      + 'the name may differ in case or wording, or the control may have no accessible name.';
  }
  const lines = m.map((e) => {
    const box = e.width && e.height ? ` @${e.x},${e.y} ${e.width}x${e.height}` : '';
    return `[${e.index}] ${e.controlType} "${e.name}"${e.automationId ? ` #${e.automationId}` : ''}${box}`;
  });
  const more = res.total > m.length ? `\n... ${res.total - m.length} more matched` : '';
  return `${res.total} match(es) for ${what}:\n${lines.join('\n')}${more}`;
}
