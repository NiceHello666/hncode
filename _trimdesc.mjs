// Trim the tool descriptions: keep what changes the model's BEHAVIOUR (defaults,
// limits, mutual exclusions), drop the restating of the obvious.
import fs from 'node:fs';

const edits = [
  ['D:/hncode/src/tools/bash.js',
    "description: 'Run a shell command via PowerShell (pwsh). Returns combined stdout+stderr, truncated. timeout in seconds (default 60, max 300). run_in_background detaches and returns a task id (see TaskList/TaskOutput/TaskWait). disable_timeout removes the limit.',",
    "description: 'Run a shell command via pwsh. Returns combined stdout+stderr. timeout default 60s (max 300s); run_in_background detaches and returns a task id.',"],

  ['D:/hncode/src/tools/edit.js',
    "description: 'Replace an exact substring (old_string) with new_string in the given file. Rejected if old_string is absent, or matches more than once unless replace_all is true.',",
    "description: 'Replace an exact substring (old_string) with new_string. Fails if old_string is missing or ambiguous (unless replace_all).',"],

  ['D:/hncode/src/tools/fetch-url.js',
    // keep as-is if the pattern does not match exactly; handled below
    "description: 'Fetch a URL and return its text: either the main page text extracted, or the full body verbatim; a leading note says which. Any http/https URL, including localhost/intranet.',",
    "description: 'Fetch a URL and return its text (main page text, or the full body; a leading note says which). Any http/https URL, including localhost.',"],

  ['D:/hncode/src/tools/glob.js',
    "description: 'Find files matching a glob pattern. Honors .gitignore/.ignore/.rgignore unless include_ignored. Up to 100 matches, most recently modified first.',",
    "description: 'Find files by glob pattern. Honors ignore files unless include_ignored. Up to 100 matches, newest first.',"],

  ['D:/hncode/src/tools/grep.js',
    "description: 'Search file contents by regex. Honors .gitignore unless include_ignored. output_mode: content (default) | files_with_matches | count_matches. -i, -n, -A/-B/-C context, head_limit/offset paginate.',",
    "description: 'Search file contents by regex. output_mode: content (default) | files_with_matches | count_matches. Honors ignore files unless include_ignored.',"],

  ['D:/hncode/src/tools/tasks.js',
    "description: 'List background tasks (started via Bash with run_in_background=true). Reports id, status, and a short description for each.',",
    "description: 'List background tasks (from Bash run_in_background). Reports id, status, description.',"],

  ['D:/hncode/src/tools/todo.js',
    "description: 'Track progress on multi-step work. Pass the complete list; it replaces the current one. Each item: title + status (pending | in_progress | done).',",
    "description: 'Track multi-step work. Pass the COMPLETE list; it replaces the current one. Items: title + status (pending | in_progress | done).',"],

  ['D:/hncode/src/tools/web-search.js',
    "description: 'Search the web for up-to-date information. Each result has a title, URL and snippet. Snippets are summaries, not full pages: fetch a promising URL with FetchURL. Cite source URLs in your answer.',",
    "description: 'Search the web. Results are title/URL/snippet; snippets are summaries, so fetch a promising URL with FetchURL. Cite sources.',"],

  ['D:/hncode/src/tools/write.js',
    "description: 'Create a new file or overwrite an existing one (prefer Edit for existing files). mode: \"overwrite\" (default) or \"append\".',",
    "description: 'Create or overwrite a file (prefer Edit for existing files). mode: overwrite (default) | append.',"],

  ['D:/hncode/src/tools/file-lines.js',
    "description: 'Count the lines of a file. Returns only the line count — it does NOT return the file content; use Read for that.',",
    "description: 'Count a file\\'s lines. Does NOT return content; use Read for that.',"],

  ['D:/hncode/src/tools/read-media-file.js',
    "description: 'Read a media file (image/video/audio). For images returns base64 data; for other formats returns metadata.',",
    "description: 'Read a media file. Images return base64; other formats return metadata.',"],
];

for (const [file, from, to] of edits) {
  let src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) { console.log('SKIP (no match): ' + file); continue; }
  src = src.replace(from, to);
  fs.writeFileSync(file, src, 'utf8');
  console.log('ok: ' + file.split('/').pop());
}
