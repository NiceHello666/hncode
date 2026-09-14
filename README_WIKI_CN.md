# hncode Wiki

[English](https://github.com/NiceHello666/hncode/blob/main/README_WIKI.md) | 简体中文 | [返回 README](https://github.com/NiceHello666/hncode/blob/main/README_CN.md)

hncode 的完整文档 —— 一个运行在终端用户界面（TUI）里的 AI 编程助手。

---

## 目录

1. [hncode 是什么](#1-hncode-是什么)
2. [环境要求](#2-环境要求)
3. [安装](#3-安装)
4. [首次运行](#4-首次运行)
5. [配置](#5-配置)
   - [5.1 基础：全部在 TUI 里配置](#51-基础全部在-tui-里配置)
   - [5.2 进阶：手写 config.toml](#52-进阶手写-configtoml)
   - [5.3 环境变量](#53-环境变量)
6. [命令行接口](#6-命令行接口)
7. [斜杠命令](#7-斜杠命令)
8. [快捷键](#8-快捷键)
9. [工具集](#9-工具集)
10. [权限模式](#10-权限模式)
11. [上下文管理与自动压缩](#11-上下文管理与自动压缩)
12. [会话](#12-会话)
13. [插件系统](#13-插件系统)
14. [开发者指南](#14-开发者指南)
15. [故障排查](#15-故障排查)
16. [许可证](#16-许可证)

---

## 1. hncode 是什么

hncode 是一个住在终端里的编程助手。你描述一个任务，它就会读写文件、执行 shell 命令、搜索代码库、抓取网页，并一直工作到任务完成 —— 具体行为取决于你选择的权限模式。

它灵感源自 [Kimi Code](https://github.com/MoonshotAI/kimi-code)，思路类似：使用原始终端（而非 `blessed`）渲染的青色蓝调 TUI、由模型驱动的工具调用循环，以及来自 OpenAI 兼容端点或 Anthropic 的流式响应。

主要特点：

- **是 TUI，不是 CLI**：这是一个交互式全屏界面。同时也提供非交互的 `-p` 提示模式，方便脚本调用。
- **双协议**：OpenAI 兼容（`/chat/completions`）和 Anthropic（`/messages`）。
- **零运行时依赖**：纯 Node.js，无原生模块，无第三方包。
- **不绑定模型**：任何遵循 OpenAI 或 Anthropic 线格式的服务都能用。

---

## 2. 环境要求

- **Node.js ≥ 20**
- 一个终端。Windows 上推荐 **Windows Terminal**。
- 至少一个服务商的 API Key（OpenAI 兼容或 Anthropic）。

> **Windows 提示**：最好安装 [Git for Windows](https://gitforwindows.org/)，以便需要 POSIX shell 的工具能找到 `bash`。

---

## 3. 安装

### 全局安装（推荐）

```bash
npm install -g @hncode/hncode
hncode
```

### 免安装运行

```bash
npx @hncode/hncode
```

### 安装钩子

包声明了两个 npm 生命周期脚本：

| 脚本 | 文件 | 作用 |
|------|------|------|
| `preinstall` | `bin/preinstall.js` | 检查 Node ≥ 20，打印平台，若已全局安装则给出提示。 |
| `install` | `bin/install.js` | 创建 `~/.hncode/`（含 `config.toml`、`sessions/`、`plugins/`），写入初始配置，然后提示如何在 Windows / macOS / Linux 上刷新 shell 的 `PATH`。 |

两个脚本都不会执行你的代码、也不会联网，只会在本地创建目录和一个默认配置文件。

### 从源码安装

```bash
git clone https://github.com/NiceHello666/hncode.git
cd hncode
npm link          # 全局暴露 `hncode` 命令
```

---

## 4. 首次运行

1. 启动 `hncode`。首次运行时安装脚本已创建 `~/.hncode/config.toml`。
2. **在 TUI 里**添加服务商：运行 `/provider`，挑选已知服务商（或添加自定义服务商），粘贴你的 API Key。模型会自动登记。（如果你已设置 `HNCODE_API_KEY`，此步可跳过。）
3. 输入任务，按 **Enter**。

详见[配置](#5-配置)。

界面分为：

- **对话区**（顶部）：你的消息、模型的回答，以及每次工具调用及其结果。
- **待办面板**：当助手在跟踪任务时出现。
- **输入框**（底部）：你打字的地方。
- **状态行**：模型、权限模式、思考强度、工作目录。
- **上下文行**（最底）：实时的 token 用量 / 上下文窗口。

---

## 5. 配置

hncode **只**读取 `~/.hncode/config.toml`（以及 `HNCODE_*` 环境变量），不会读取其他产品的配置。

**通常你不需要手写这个文件。** 服务商和模型都可以在 TUI 里配置，hncode 会替你写入 `config.toml`。直接编辑 TOML 属于*进阶*用法 —— 适合脚本化部署、特殊端点，或向导没暴露的设置。

### 5.1 基础：全部在 TUI 里配置

在 hncode 打开时运行这些斜杠命令：

| 命令 | 作用 |
|------|------|
| `/provider` | 管理服务商 —— **添加**、**编辑**或**删除**。 |
| `/model` | 选择模型，或在已添加的模型之间切换。 |
| `/effort [off\|on\|high\|medium\|low]` | 设置当前模型的思考强度。 |

**添加服务商**（`/provider` → Add）：

- 从 [models.dev](https://models.dev) 目录挑选**已知服务商** —— base URL 会自动预填，或
- 添加**自定义服务商** —— 你自己提供名称、base URL、API Key 和协议（`OpenAI` 或 `Anthropic`）。

保存后，hncode 会调用该服务商的 `/models` 端点并**自动登记所有模型**，同时记录各自的上下文窗口和思考能力。你事先不需要知道这些。

**编辑服务商**（`/provider` → 在某个服务商上按 Enter）可以修改它的名称、base URL、API Key 和协议类型。

所有改动都会立即持久化到 `~/.hncode/config.toml`，重启后依然有效。

### 5.2 进阶：手写 `config.toml`

`~/.hncode/config.toml` 包含三部分：顶层默认值、`[providers.*]` 和 `[models.*]`。

最小示例：

```toml
default_model = "gpt-4o-mini"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "sk-..."

[models.gpt-4o-mini]
provider = "openai"
model = "gpt-4o-mini"
```

**服务商** —— `[providers.<name>]`：

| 键 | 含义 |
|----|------|
| `base_url` | Base URL。hncode 会追加 `/chat/completions`（OpenAI）或 `/messages`（Anthropic）。 |
| `api_key` | 该服务商的密钥。 |
| `protocol` | `openai`（默认）或 `anthropic`。 |

**模型** —— `[models.<alias>]`：

| 键 | 含义 |
|----|------|
| `provider` | 该模型所属的服务商。 |
| `model` | 发送给 API 的字面模型 id。 |
| `display_name` | 界面上显示的友好名称。 |
| `context_length` | 上下文窗口（token），用于驱动上下文计量。 |
| `max_tokens` | 最大输出 token。 |
| `efforts` | 可选思考强度数组，例如 `["low","medium","high"]`。 |
| `reasoning` | `true`/`false`，模型是否能思考。 |
| `always_thinking` | 为 `true` 时思考无法关闭。 |

改完文件后运行 `/reload` 即可生效，无需重启。

### 5.3 环境变量

下面的每一项都会**覆盖** `config.toml` 里的同名设置 —— 适合 CI，或避免把密钥写进文件：

| 变量 | 含义 |
|------|------|
| `HNCODE_API_KEY` | API 密钥。 |
| `HNCODE_PROVIDER` | 要使用的服务商名。 |
| `HNCODE_MODEL` | 要使用的模型别名。 |
| `HNCODE_BASE_URL` | 覆盖 base URL。 |
| `HNCODE_PROTOCOL` | `openai` 或 `anthropic`。 |
| `HNCODE_MAX_CONTEXT` | 覆盖上下文窗口大小（token）。 |
| `HNCODE_MAX_OUTPUT` | 覆盖单次请求最大输出 token。 |
| `HNCODE_REASONING` | `1`/`true` 标记模型具备推理能力。 |
| `HNCODE_SYSTEM_PROMPT` | 覆盖系统提示词。 |
| `HNCODE_CALM_MODE` | `1`/`true` 开启简洁模式。 |
| `HNCODE_ALLOW_EXTERNAL` | `1` 允许工具访问工作区之外的路径。 |
| `HNCODE_CONFIG` | 备用配置文件路径（供 `doctor config` 使用）。 |
| `HNCODE_SESSIONS_DIR` | 会话保存目录。 |
| `HNCODE_PLUGINS` | 插件目录。 |

---

## 6. 命令行接口

```
hncode [options] [command]
```

### 选项

| 选项 | 说明 |
|------|------|
| `-V, --version` | 打印版本号。 |
| `-S, --session [id]` | 恢复会话（可带 id，或交互选择）。 |
| `-c, --continue` | 继续**当前目录**最近的会话。 |
| `-y, --yolo` | Ask When Needed：工作区内的编辑/命令自动执行；工作区外路径与破坏性命令仍会询问。 |
| `--auto` | Never Ask：全部自动执行。 |
| `-m, --model <model>` | 本次调用使用的模型别名。 |
| `-p, --prompt <prompt>` | 非交互式运行一次提示并打印回复。 |
| `--output-format <format>` | 提示模式输出：`text`（默认）或 `stream-json`。 |
| `--plan` | 以 plan 模式启动（只研究，不写入）。 |
| `--add-dir <dir>` | 额外的工作区目录，可重复。 |
| `-h, --help` | 显示帮助。 |

### 子命令

| 命令 | 说明 |
|------|------|
| `session list` | 列出会话（最新在前）。 |
| `provider list` | 显示已配置的服务商及其模型数量。 |
| `doctor config [path]` | 校验 `config.toml`。 |
| `init` | 创建带默认值的 `~/.hncode/config.toml`。 |
| `export [id]` | 导出会话到 `~/.hncode/export/<id>.json`。 |

### 无头模式

```bash
hncode -p "解释一下 src/agent.js 做什么"
hncode -p "列出 TODO" --output-format stream-json
```

`stream-json` 模式下，每个事件打印为一行 JSON 对象，方便管道传给其他工具。

---

## 7. 斜杠命令

在输入框中输入 `/` 打开命令菜单；**Tab** 补全，**Enter** 运行。

### 会话与工作区

| 命令 | 别名 | 说明 |
|------|------|------|
| `/new` | `/clear` | 在当前工作区新建会话（并清空待办面板）。 |
| `/sessions` | `/resume` | 浏览并恢复**当前目录**的历史会话。 |
| `/fork` | — | 把当前会话复制成新会话（不切换过去）。 |
| `/title <title>` | `/rename` | 设置（或显示）会话标题；同时设置终端窗口标题。 |
| `/move <path>` | — | 把当前会话迁移到另一个已存在的目录。 |
| `/add-dir [list] \| <path>` | — | 添加或列出额外的工作区目录。 |
| `/undo [count]` | — | 从对话中撤回最近若干条提示。 |
| `/init` | — | 分析代码库并生成 `AGENTS.md`。 |
| `/export-md [path]` | `/export` | 把当前会话导出为 Markdown 文件。 |
| `/import-session <file.md>` | `/import` | 把 Markdown 文件附加到提示中，让模型无需工具调用即可读取。 |

### 模型与服务商

| 命令 | 别名 | 说明 |
|------|------|------|
| `/model <name>` | — | 切换模型。单独 `/model` 打开选择器。 |
| `/provider` | `/providers` | 添加 / 编辑 / 删除服务商。 |
| `/effort [off\|on\|high\|medium\|low]` | `/thinking` | 切换思考强度。 |
| `/logout` | `/disconnect` | 登出已配置的服务商。 |
| `/reload` | — | 重新加载 `config.toml`。 |

### 行为

| 命令 | 别名 | 说明 |
|------|------|------|
| `/ask` | `/manual` | Always Ask 模式。 |
| `/yolo` | `/yes` | Ask When Needed 模式。 |
| `/auto` | — | Never Ask 模式。 |
| `/plan [on\|off\|clear]` | — | Plan 模式：只研究，不写入。 |
| `/focus [on\|off]` | — | Focus 模式：以最小工具子集起步。 |
| `/calm-mode [on\|off]` | — | 简洁回复；模型不再叙述过程。 |
| `/set-system-prompt` | `/system-prompt` | 编辑并保存系统提示词（持久化到 `config.toml`）。 |
| `/goal [status\|pause\|resume\|cancel] \| <objective>` | `/objective` | 启动或管理自主目标。 |

### 上下文与诊断

| 命令 | 说明 |
|------|------|
| `/compact [ratio]` | 压缩对话：AI 摘要较早部分，保留最近 20%（给参数则保留 `1-ratio`）。 |
| `/usage` | 显示会话 token 与上下文窗口。 |
| `/status` | 显示会话与运行时状态。 |
| `/tasks` | 浏览后台任务。 |
| `/mcp` | 显示 MCP 服务状态。 |
| `/mcp-config` | 配置 MCP 服务（列出 / 添加 / 移除）。 |
| `/plugins` | 列出已加载插件及其命令。 |
| `/statusline` | 配置状态行显示哪些项目。 |
| `/settings` | 打开设置菜单（模型 / 权限 / 状态行）。 |
| `/copy` | 复制最后一条助手消息到剪贴板。 |
| `/help` | 显示所有命令与快捷键。 |
| `/version` | 显示版本信息。 |
| `/exit` | `/quit`、`/q` —— 退出。 |

未知的 `/命令` 会报错，**不会**发送给模型。

---

## 8. 快捷键

| 按键 | 作用 |
|------|------|
| `Enter` | 发送消息。 |
| `Ctrl-J` | 在输入框中插入换行。 |
| `Ctrl-Shift-C` | 复制当前鼠标选中内容（无选中则复制最后一条回答）。 |
| `Ctrl-Shift-V` | 粘贴剪贴板。多行粘贴会折叠成 `[paste #N +L lines]` 标记。 |
| `↑` / `↓` | 输入框为空时：调出历史输入。否则：滚动对话。 |
| `/` | 打开命令菜单；`Tab` 循环选择。 |
| `@` | 文件/文件夹补全；`Tab` 补全。 |
| `Esc` | 取消菜单/对话框，或打断当前回合。 |
| `Ctrl-E` | 用编辑器打开 `config.toml`。 |
| `Ctrl-B` | 把正在运行的 Bash 命令移到后台。 |
| `Ctrl-S` | 把排队输入直接注入正在运行的回合。 |
| `↑`（排队时） | 取回最后一条排队消息以便编辑。 |
| `Ctrl-O` | 展开/折叠工具输出与思考内容。 |
| `Ctrl-T` | 展开/折叠待办面板。 |
| `Ctrl-C` 两次 | 退出 hncode。 |

### 粘贴

- **文本**：原样插入（多行会折叠成标记）。
- **文件**：插入其绝对路径，模型可据此 `Read`。
- **图片**（如截图）：保存为临时 `.png`，插入其**路径**。
- 剪贴板通过**预热**的后台 PowerShell 读取，所以重复粘贴约为 10ms，而不是数秒。

### 鼠标

- 拖拽选择对话文本；右键弹出复制/粘贴菜单。
- 拖拽待办面板顶部横线可调整大小。
- 在对话区或 `/` 菜单上滚轮滚动。

---

## 9. 工具集

模型可以调用以下内置工具。每个返回一个字符串；失败会以**红色**显示，并把该工具的状态圆点变红。

| 工具 | 用途 |
|------|------|
| `Read` | 读取文本文件（默认全文；可用 `line_offset` / `n_lines` 指定范围）。 |
| `Write` | 写入文件（新建或覆盖）。 |
| `Edit` | 用 `new_string` 替换精确匹配的 `old_string`（除非 `replace_all`，否则必须唯一）。 |
| `Bash` | 执行 shell 命令；支持后台任务。 |
| `Glob` | 按模式查找文件。 |
| `Grep` | 按正则搜索文件内容。 |
| `TodoList` | 维护待办面板中的任务列表。 |
| `TaskList` / `TaskOutput` / `TaskStop` / `TaskWait` | 管理后台任务。 |
| `FetchURL` | 抓取 URL 并返回文本。 |
| `WebSearch` | 网络搜索。 |
| `ReadMediaFile` | 读取图片/媒体文件。 |
| `FileLines` | 统计（或查看）文件行数。 |

### Edit 的安全模型

`Edit` 不会盲改：

- 必须先 `Read` 文件再 `Edit`，且被编辑区域必须在你实际读过的快照内。否则报：`Edit rejected: you have not read the lines you are editing…`。
- 若文件在你读取后发生了变化：`Edit rejected: <path> changed since it was Read…`。重新 `Read` 再编辑。

这些保护用于避免覆盖并发修改。

### 失败如何展示

- **Bash**：非 0 退出码会把圆点变红，命令自身输出说明原因。内部的 `[exit code: N]` 行不会显示给你。
- **Edit / Write**：正文被 diff 取代，因此失败时会在工具调用下方显示一行红色原因。
- **Read / Grep / Glob 等**：完整结果照常显示，失败时为红色。

---

## 10. 权限模式

| 模式 | 命令 | 行为 |
|------|------|------|
| **Always Ask** | `/ask` | 只读工具自动执行；其他操作一律先询问。 |
| **Ask When Needed** | `/yolo` | 工作区内的编辑/命令自动执行。工作区外路径、破坏性命令、提问与计划仍会询问。 |
| **Never Ask** | `/auto` | 不打断你；一切自动决定并执行。 |

模式显示在状态行，并且**持久化在会话中**，恢复会话时一并恢复。命令行标志（`--auto`、`-y`）会在本次调用中覆盖它。

Plan 模式（`/plan`）把工具限制为只读。Focus 模式（`/focus`）以最小工具子集起步。

---

## 11. 上下文管理与自动压缩

每次请求都会携带此前的对话。当估算大小达到模型上下文窗口的 **85%** 时，hncode 会**自动压缩**：

1. 保留最近的 **20%** 消息。
2. 请模型**摘要**较早部分（目标、决策、涉及的文件、当前状态）。
3. 摘要作为一条系统消息插入，从而保留对话脉络。

也可以手动压缩：

```
/compact          # 保留最近 20%，AI 摘要其余部分
/compact 0.3      # 丢弃最旧的 30%，保留 70%
```

token 估算采用与 Kimi Code 相同的启发式：`ceil(ASCII 字符数 / 4) + 非 ASCII 字符数`。屏幕底部的实时计量每步刷新。

---

## 12. 会话

一个会话记录 `id`、`title`、`workspace`、`model`、`messages`、`rounds`、`steps` 以及运行时模式标志。

- 保存在 `~/.hncode/sessions/<id>.json`。
- `/sessions` 只列出**当前目录**的会话。
- `hncode --continue` 恢复**当前目录**最近的会话。
- `/move <path>` 把会话迁移到另一个目录。
- `/new` 新建会话（并清空待办面板）。
- 模式标志（权限 / plan / focus / effort）随会话持久化。

---

## 13. 插件系统

插件是从 `~/.hncode/plugins/`（或 `HNCODE_PLUGINS`）加载的纯 ESM 模块。

### 一个插件

```javascript
// ~/.hncode/plugins/my-plugin.mjs
export function install(api) {
  // 1. 注册模型可调用的工具。
  api.registerTool({
    name: 'MyTool',
    description: '做一件事。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(args, ctx) {
      return `got: ${args.text}`;
    },
  });

  // 2. 注册斜杠命令。
  api.registerCommand({
    name: 'mycmd',
    description: '运行我的命令。',
    argumentHint: '[text]',
    run: (arg, ctx) => { /* ... */ },
  });

  // 3. 注册生命周期钩子。
  api.registerHook('onTurnEnd', (turnInfo) => { /* ... */ });
}

export default { name: 'my-plugin', version: '1.0.0' };
```

### API 一览

| 方法 | 用途 |
|------|------|
| `api.registerTool(spec)` | 添加工具。返回反注册函数。 |
| `api.registerCommand(cmd)` | 添加 `/命令`。返回反注册函数。 |
| `api.registerHook(name, fn)` | 添加生命周期钩子。返回反注册函数。 |
| `api.registerConfig(defaults)` | 合并默认配置值。 |
| `api.ctx` | 运行时 agent 上下文（钩子期间可用）。 |
| `api.tools` / `api.commands` / `api.hooks` / `api.config` / `api.plugins` | 内省。 |

支持的钩子名：`onTurnStart`、`onTurnEnd`、`onBeforeRequest`、`onAfterRequest`、`onToolExecute`、`onToolResult`、`onNewMessage`。

用 `/plugins` 查看已加载内容。

---

## 14. 开发者指南

### 项目结构

```
bin/            命令行入口（hncode、.cmd、.ps1）+ 安装钩子
src/
  index.js      argv 解析、子命令、无头模式、TUI 分发
  tui.js        原始 TTY 渲染器、按键处理、斜杠命令
  agent.js      工具循环（请求 → 工具调用 → 重复）
  llm.js        OpenAI + Anthropic 客户端（流式与非流式）
  config.js     config.toml 解析、服务商、模型、思考强度
  session.js    会话存储
  plugin.js     插件宿主与注册表
  tools/        每个工具一个文件
  colors.js     ANSI 颜色辅助
  term.js       token 估算、宽度计算、换行
```

### agent 循环

`src/agent.js` 的执行流程：构建请求 → 流式接收回复 → 若模型发出工具调用则执行并追加结果 → 重复，直到模型给出不含工具调用的最终回答、用户打断，或步数预算（如有）耗尽。若模型在任务中途停下，完成度守卫会提醒它继续（最多 `MAX_NUDGES` 次）。

### 添加工具

1. 新建 `src/tools/mytool.js`，导出 `spec`，包含 `name`、`description`、`parameters`（JSON schema）和 `async execute(args, ctx)`。
2. 在 `src/tools/index.js` 中注册。

### token 估算

`src/term.js` 中的 `estimateTokens(text)`：ASCII 约 4 字符/token，非 ASCII 约 1 字符/token。

### 检查

项目未接入测试运行器；保持 `node --check <file>` 通过，并手动验证改动。

---

## 15. 故障排查

| 现象 | 可能原因 / 处理 |
|------|----------------|
| `hncode: interactive mode requires a TTY` | 你在管道中运行。非交互请用 `hncode -p \"…\"`。 |
| `no api_key configured` | 设置 `HNCODE_API_KEY`，或配置服务商（`/provider`）。运行 `hncode doctor config`。 |
| Windows 上界面乱码 | 使用 **Windows Terminal**；老式 `cmd.exe` 控制台渲染很差。 |
| 粘贴很慢 | 首次粘贴后应约为 10ms（剪贴板助手已预热）。首次极慢是 PowerShell 冷启动所致。 |
| `Edit rejected: you have not read the lines…` | 先 `Read` 文件（相关行），再 `Edit`。 |
| 上下文计量接近 100% | 运行 `/compact`，或等 85% 时自动压缩触发。 |

---

## 16. 许可证

[GNU General Public License v3.0](https://github.com/NiceHello666/hncode/blob/main/LICENSE)。

1. ✅ 可自由使用、修改和分享。
2. ✅ 必须保留原作者署名（NiceHello666）并链接回本仓库。
3. ❌ 不得用于商业目的。

---

[返回 README](https://github.com/NiceHello666/hncode/blob/main/README_CN.md) · [English Wiki](https://github.com/NiceHello666/hncode/blob/main/README_WIKI.md)
