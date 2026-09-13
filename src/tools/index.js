// Toolbelt registry. Each entry exposes the JSON schema (matching hncode's tools)
// plus an async execute(args, ctx) returning a result string.

import * as readMod from './read.js';
import * as writeMod from './write.js';
import * as editMod from './edit.js';
import * as globMod from './glob.js';
import * as grepMod from './grep.js';
import * as bashMod from './bash.js';
import * as todoMod from './todo.js';
import * as fetchUrlMod from './fetch-url.js';
import * as webSearchMod from './web-search.js';
import * as readMediaFileMod from './read-media-file.js';
import * as fileLinesMod from './file-lines.js';
import { TaskListSpec, TaskOutputSpec, TaskStopSpec, TaskWaitSpec } from './tasks.js';
import { pluginTools } from '../plugin.js';

// Built-in tools.
const builtinTools = [
  readMod.spec,
  writeMod.spec,
  editMod.spec,
  globMod.spec,
  grepMod.spec,
  bashMod.spec,
  todoMod.spec,
  fetchUrlMod.spec,
  webSearchMod.spec,
  readMediaFileMod.spec,
  fileLinesMod.spec,
  TaskListSpec,
  TaskOutputSpec,
  TaskStopSpec,
  TaskWaitSpec,
];

// Combined list: built-ins + plugin-registered tools. Plugin tools appear after
// built-ins so their names are visible, but built-in names take precedence in
// the byName lookup (first one wins).
export function combinedTools() {
  return [...builtinTools, ...pluginTools];
}

export const tools = builtinTools;
export { builtinTools };

const byName = new Map(builtinTools.map((t) => [t.name, t]));
export function getTool(name) { return byName.get(name); }
export function toolNames() { return combinedTools().map((t) => t.name); }

// Schemas for sending to an LLM (OpenAI `tools` array).
export function llmTools() {
  return combinedTools().map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
