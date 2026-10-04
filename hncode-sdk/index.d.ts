// Type definitions for hncode plugins.
//
// A plugin is an ESM module exported as `{ name, version, install }`. `install`
// receives the host `api` object — that object is what this file describes, so an
// editor can complete `api.` and type-check the handlers.
//
// Usage:
//   /** @type {import('@hncode/hncode-sdk').HncodePlugin} *​/
//   export default { name: 'x', version: '1.0.0', install(api) { ... } };
//
// or, in TypeScript:
//   import type { HncodePlugin } from '@hncode/hncode-sdk';
//   const plugin: HncodePlugin = { ... };

import type { PatchTarget } from './targets.js';

export type { PatchTarget };

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON-Schema-ish parameter description (OpenAI `function.parameters` shape). */
export interface ToolParameters {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** A tool the model can call. Same shape as hncode's built-in tool specs. */
export interface ToolSpec {
  /** Unique tool name; `registerTool` throws on a duplicate. */
  name: string;
  description?: string;
  parameters?: ToolParameters;
  /**
   * Run the tool. Return a string, or `{ text, media? }` for multimodal output.
   * Throwing is fine — the agent converts it into an error result for the model.
   */
  execute(args: Record<string, unknown>, ctx: AgentContext): unknown | Promise<unknown>;
  [key: string]: unknown;
}

/** The context handed to a tool's `execute`. */
export interface AgentContext {
  /** Working directory of the session. */
  cwd?: string;
  workspace?: string;
  /** Abort signal — long-running tools should honour it. */
  signal?: AbortSignal;
  /** Mutable map of background tasks (shared across a session). */
  tasks?: Record<string, unknown>;
  /** Live todo list (TodoList tool). */
  todoState?: Array<{ title: string; status?: string }>;
  /** Whether tools may touch paths outside the workspace. */
  allowExternal?: boolean;
  /** The most recent tool result (set by the agent after each call). */
  lastResult?: unknown;
  /** Call with a chunk to stream live output to the matching "Using …" row. */
  onOutput?: (chunk: string) => void;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Context passed to a command's `run`. */
export interface CommandContext {
  /** The live TUI state (prefer the documented fields; the rest is internal). */
  state: Record<string, any>;
  /** The host object. */
  h: Record<string, any>;
  /** Resolved config. */
  cfg: Record<string, any>;
  /** The current session. */
  session: Record<string, any>;
  /** Print an info line (transient banner). */
  app: (message: string) => void;
  /** Print an error line (transient banner). */
  appErr: (message: string) => void;
  [key: string]: unknown;
}

/** A slash command. */
export interface CommandSpec {
  /** Without the leading slash; `registerCommand` throws on a duplicate. */
  name: string;
  description?: string;
  /** Shown in completion, e.g. '[on|off]'. */
  argumentHint?: string;
  /** Sorting weight in the `/` menu (higher = earlier). */
  priority?: number;
  aliases?: string[];
  run: (arg: string, ctx: CommandContext) => unknown | Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

/** Handler for a symbol patch: any combination of before/after/around. */
export interface PatchHandler {
  /** Runs before the call. Return an array to REPLACE the argument list. */
  before?: (this: any, ...args: any[]) => any[] | void;
  /** Runs after the call. Return a non-undefined value to REPLACE the result. */
  after?: (this: any, result: any, args: any[]) => any;
  /** Full control: call `original`, return the result. */
  around?: (this: any, original: (...a: any[]) => any, args: any[], thisArg: any) => any;
}

/** The legacy chain signature used by the nine abstract seams. */
export type SeamHandler = (ctx: any, next: (ctx: any) => any) => any;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillResult {
  ok: boolean;
  name?: string;
  path?: string;
  replaced?: boolean;
  error?: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// UI option shapes
// ---------------------------------------------------------------------------

export interface PickerItem {
  label: string;
  sub?: string;
  /** Marks the currently-selected row with a "current" tag. */
  current?: boolean;
  [key: string]: unknown;
}

export interface PickerOptions {
  title?: string;
  items: PickerItem[];
  hint?: string;
  searchable?: boolean;
  /** Keep the composer text instead of clearing it when the picker opens. */
  keepInput?: boolean;
  onPick?: (item: PickerItem) => boolean | void;
  onCancel?: () => void;
  [key: string]: unknown;
}

export interface FormField {
  key: string;
  label: string;
  value?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface FormOptions {
  title?: string;
  fields: FormField[];
  hint?: string;
  onSubmit?: (values: Record<string, string>, type: string) => void;
  onCancel?: () => void;
  [key: string]: unknown;
}

/** A subagent that is running RIGHT NOW, as reported by `api.subagents()`. */
export interface RunningSubagent {
  /** The agent id — the handle `Agent` prints and `AgentSwarm` reports. */
  id: string;
  /** The run id, valid only while the run is live. */
  runId: string;
  /** The background task id, when the run was detached. */
  taskId: string;
  /** 'coder' | 'explore' | 'plan' | 'researcher'. */
  type: string;
  description: string;
  startedAt: number;
}

/** The answer every subagent-control call gives. */
export interface SubagentResult {
  ok: boolean;
  message: string;
}

export interface EditorOptions {
  title?: string;
  text?: string;
  caretRow?: number;
  caretCol?: number;
  hint?: string;
  onSave?: (value: string) => void;
  [key: string]: unknown;
}

/**
 * The logger handed to a plugin as `api.log`. Callable like `console.log`, and also
 * carrying `log` / `info` / `warn` / `error` — both shapes work.
 */
export interface PluginLogger {
  (...args: unknown[]): void;
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

/** Every method and property the host injects into `install(api)`. */
export interface HncodePluginApi {
  /** Register a tool. Throws on a duplicate name. Returns an unregister fn. */
  registerTool(spec: ToolSpec): () => void;
  /** Register a slash command. Throws on a duplicate name. Returns an unregister fn. */
  registerCommand(cmd: CommandSpec): () => void;
  /** Register a lifecycle hook. Returns an unregister fn. */
  registerHook(name: string, fn: (...args: any[]) => any): () => void;
  /** Merge default config values (applied before user overrides). Returns an
   *  unregister fn that drops the keys this call added. */
  registerConfig(defaults: Record<string, unknown>): () => void;

  /** The lazily-injected agent context, or undefined before the first turn. */
  readonly ctx: AgentContext | undefined;

  // ---- services ----
  /**
   * Publish a value other plugins can `inject` / `get`. Declare the same names in
   * the module's `provides` export — the loader reads that to work out the load
   * order, since ordering must be known before any install runs. Throws when the
   * name is already provided. Returns an unregister fn.
   */
  provide(name: string, value: unknown): () => void;
  /** A provided service, or undefined. */
  get(name: string): any;
  /** Whether a service is available right now. */
  has(name: string): boolean;
  /** Like get(), but throws when the service is missing. */
  require(name: string): any;
  /** Names of every currently-provided service. */
  readonly serviceNames: string[];

  // ---- teardown ----
  /**
   * Register a cleanup function, run by unloadPlugins() (and on reload) before the
   * registrations are undone. For resources the register* calls do not know about:
   * timers, child processes, watchers, files. Returns an unregister fn.
   */
  onDispose(fn: () => void | Promise<void>): () => void;

  /** Publish a skill from an in-memory SKILL.md string. */

  /** Publish a skill from an in-memory SKILL.md string. */
  addSkill(content: string, name?: string): SkillResult;
  /** Installed skills. */
  readonly skills: SkillInfo[];
  /** Delete an installed skill by name. */
  removeSkill(name: string): SkillResult;

  // ---- runtime control ----
  /** Queue a prompt as if the user typed it. `opts.skillBody` / `opts.bubbleText` supported. */
  sendPrompt(text: string, opts?: { skillBody?: string; bubbleText?: string }): unknown;
  /** Append a message to the transcript. Returns null in a headless host. */
  addMessage(role: string, text: string): unknown;
  /** The conversation messages. */
  getMessages(): unknown[];
  /** Start a fresh session. */
  clearSession(): void;
  /** Persist a session object. */
  saveSession(session: unknown): void;
  /** Quit the host. */
  quit(): void;

  // ---- UI ----
  /** Show a transient notice. */
  notice(text: string, kind?: 'info' | 'warn' | 'error'): void;
  /** Open the scrollable info panel. */
  openPanel(content: string | string[]): void;
  /** Open the modal text editor. */
  openEditor(opts: EditorOptions): void;
  /** Open a searchable picker. */
  openPicker(opts: PickerOptions): void;
  /** Open a form. */
  openForm(opts: FormOptions): void;
  /** Open the background-tasks panel. */
  openTasksPanel(): void;
  /** Open the plugin/skill registry browser: 'plugins' | 'skills'. */
  openRegistryBrowser(kind: 'plugins' | 'skills'): void;

  // ---- config ----
  getConfig(key: string): unknown;
  setConfig(key: string, val: unknown): void;
  /** Persist a config value to disk. Returns true on success. */
  persistConfig(key: string, val: unknown): boolean;

  // ---- filesystem (encoding-aware, error-tolerant) ----
  readFile(file: string, enc?: BufferEncoding): string | null;
  writeFile(file: string, data: string, enc?: BufferEncoding): boolean;
  readJSON<T = unknown>(file: string, fallback?: T): T | null;
  writeJSON(file: string, obj: unknown): boolean;

  // ---- keybinds & widgets ----
  /** Claim a global shortcut using the TUI's token format ('c-k', 'f9'). */
  registerKeybind(key: string, fn: () => void): () => void;
  /** Render extra status-bar text. */
  registerTuiWidget(fn: () => string): () => void;
  /**
   * Whether a shortcut is already claimed — by the user's keybindings file, by another
   * plugin, or by a built-in. `registerKeybind` overwrites silently, so check first if you
   * care. Accepts any spelling `normalizeKey` understands ('ctrl+t' as well as 'c-t').
   */
  isKeyBound(key: string): boolean;
  /** Every currently-claimed shortcut token. */
  readonly boundKeys: string[];

  // ---- UI: the file tree ----
  /**
   * Open the workspace file browser. `filter` narrows the tree the way `/files <filter>`
   * does. Returns whether it actually opened — false for an empty workspace or a headless
   * host, so a plugin can tell instead of waiting on a panel that never appeared.
   */
  openFileTree(filter?: string): boolean;
  /** Close the file-tree browser if it is open. */
  closeFileTree(): void;

  // ---- theme ----
  /** Every theme name this build knows. A build-time fact, no host needed. */
  readonly themeNames: string[];
  /** The theme in force, or null when no host has one. */
  getTheme(): string | null;
  /**
   * Switch the colour theme. Returns false for an unknown name — the check runs before the
   * host is called, so a bad name cannot half-change the screen.
   */
  setTheme(name: string): boolean;

  // ---- subagents ----
  /** The subagents running RIGHT NOW. A finished one is not listed. */
  subagents(): RunningSubagent[];
  /** Send a message to a running subagent, addressed by agent id, run id or task id. */
  messageSubagent(ref: string, text: string): SubagentResult;
  /** Stop one running subagent, or every one when `ref` is omitted. */
  interruptSubagent(ref?: string): SubagentResult;
  /** Interrupt a subagent AND drop it from the running list at once. */
  closeSubagent(ref: string): SubagentResult;

  // ---- patching ----
  /**
   * Wrap an exported function or class method in hncode's own src/, or register
   * a legacy seam. `target` is a `PatchTarget` ("file.js#symbol") or a seam name.
   * Returns an unregister fn.
   */
  patch(target: PatchTarget | string, handler: PatchHandler | SeamHandler): () => void;
  /** Every currently-registered patch target. */
  readonly patchSeams: string[];

  // ---- introspection ----
  // What THIS load has registered so far. Useful for a plugin that wants to avoid
  // colliding with a name, or that reports what it found. These were on the host all
  // along and missing from these types, so `api.tools` did not complete.
  /** Every registered tool spec, including other plugins'. */
  readonly tools: ToolSpec[];
  /** Every registered slash command. */
  readonly commands: CommandSpec[];
  /** Registered hooks, keyed by hook name. */
  readonly hooks: Record<string, Array<(...args: any[]) => any>>;
  /** Plugin-supplied config defaults (before user overrides). */
  readonly config: Record<string, unknown>;
  /** The plugins loaded this session, in install order. */
  readonly plugins: Array<{ name: string; version: string }>;

  /**
   * A console-like logger. Mirrors to the chat AND to the terminal.
   *
   * CALLABLE (`api.log('x')`) as well as carrying the four methods
   * (`api.log.warn('x')`), exactly like `console`. There are no separate `api.info`
   * / `api.warn` / `api.error` members.
   */
  log: PluginLogger;
}

/** The object a plugin module exports by default. */
export interface HncodePlugin {
  name: string;
  /** Semver, e.g. "1.0.0". Required. */
  version: string;
  install: (api: HncodePluginApi) => void | Promise<void>;
  /**
   * Names of the services install() registers with `api.provide()`. The loader
   * reads this to work out the load order, so a provided service has to be declared
   * here and not only at the provide() call site.
   */
  provides?: string[];
  /**
   * Names of the services this plugin needs. Its install() runs only after all of
   * them are provided; a plugin whose dependencies can never be satisfied is skipped
   * with an error notice instead of starting half-wired.
   */
  inject?: string[];
  /** Called by unloadPlugins() (and by a reload) before the registrations are undone. */
  dispose?: (api: HncodePluginApi) => void | Promise<void>;
}

// ---- runtime helpers (index.js) ----
/** The hooks the host actually fires. */
export declare const HOOK_NAMES: [
  'onStartup',
  'onShutdown',
  'onTurnStart',
  'onTurnEnd',
  'onBeforeRequest',
  'onAfterRequest',
  'onToolExecute',
  'onToolResult',
  'onNewMessage',
  'onSessionSave',
];
/** Union of the hook names above, for typing a handler map. */
export type HookName = typeof HOOK_NAMES[number];
export declare const LEGACY_SEAMS: string[];
export declare const NOTICE_KINDS: string[];
export declare const SCOPES: string[];
export declare const LEGACY_SEAM_SET: Set<string>;
export declare const HOOK_NAME_SET: Set<string>;
export declare function definePlugin<T extends HncodePlugin>(plugin: T): T;
export declare function parsePatchTarget(target: string): { file: string; base: string; method: string | null; id: string } | null;
