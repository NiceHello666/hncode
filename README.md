# hncode — AI Coding Agent CLI

> **这是我 Vibe Coding 的产物，可能不是特别好，但是如果有什么建议的话也欢迎提 issue**

A cyan-blue TUI coding agent inspired by kimi-code-cli, with OpenAI + Anthropic support, MCP-style toolbelt, and intelligent context management.

---

## 🌟 Features

- **Cyan-blue TUI**: Raw terminal renderer for perfect Windows Terminal compatibility
- **Dual Protocol Support**: Works with both OpenAI-compatible APIs and Anthropic
- **Smart Context Management**: Auto-compaction at 85% usage, AI-summarized history retention
- **MCP-style Toolbelt**: Read, Write, Edit, Bash, Glob, Grep, TodoList, WebSearch, etc.
- **Plugin System**: Extend with custom tools, commands, and hooks
- **Session Persistence**: Resume conversations across sessions
- **Permission Modes**: Ask, YOLO, or Auto modes for different workflows

---

## 🚀 Installation

### Global Installation (Recommended)

```bash
npm install -g @hncode/hncode
```

Then run:
```bash
hncode
```

### Using npx (No installation required)

```bash
npx @hncode/hncode
```

This will download and run the latest version without installing it globally.

---

## ⚙️ Configuration

Create `~/.hncode/config.toml`:

```toml
default_model = "gpt-4o-mini"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "your-api-key-here"

[models.gpt-4o-mini]
provider = "openai"
model = "gpt-4o-mini"
```

Or set environment variables:
```bash
export HNCODE_API_KEY="your-key"
export HNCODE_PROVIDER="openai"
export HNCODE_MODEL="gpt-4o-mini"
```

---

## 📖 Usage

### Basic Commands

```bash
# Start interactive session
hncode

# Headless mode (one prompt)
hncode -p "Fix the bug in src/main.js"

# Continue previous session
hncode --continue

# Auto mode (no questions)
hncode --auto
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/compact [ratio]` | Compact conversation (AI summary + keep last 20%) |
| `/model <name>` | Switch LLM model |
| `/sessions` | Browse and resume past conversations |
| `/move <path>` | Move current session to another directory |
| `/auto` / `/ask` / `/yolo` | Toggle permission mode |
| `/plan` / `/focus` | Toggle research-only or full-edit mode |
| `/calm-mode` | Terse replies (skip narration) |
| `/help` | Show all commands |

### Advanced Features

**Tab Completion**: 
- Type `/` → command menu
- Type `@` → file/folder completion
- Use Tab to navigate and Enter to select

**Auto Compaction**: 
- Triggers at 85% context window
- AI summarizes dropped messages
- Keeps most recent 20% of conversation

**Plugin System**:
Place plugins in `~/.hncode/plugins/`:
```javascript
// my-plugin.mjs
export function install(api) {
  api.registerTool({ /* ... */ });
  api.registerCommand({ name: 'mycmd', run: () => {} });
}
export default { name: 'my-plugin', version: '1.0.0' };
```

---

## 🛠 Tools

Built-in tools include:
- `Read`, `Write`, `Edit` - File operations
- `Bash` - Execute shell commands
- `Glob`, `Grep` - Search files
- `TodoList`, `TaskOutput` - Task management
- `FetchURL`, `WebSearch` - Internet access
- `ReadMediaFile`, `FileLines` - Media handling

---

## 🎨 Theme

Supported themes: `auto`, `dark`, `light`, or custom RGB colors.

Set via config:
```toml
theme = "dark"
```

Or `/theme <name>` in TUI.

---

## 🤝 Contributing

This project was created through Vibe Coding. While it may not be perfect, I welcome your feedback!

**Please feel free to:**
- Submit issues for bugs or suggestions
- Fork and create pull requests
- Share your experience using hncode

---

## 🙏 Acknowledgments

hncode draws inspiration from several excellent projects:

- **[kimi-code-cli](https://github.com/mckaymatt/kimi-code-cli)** - The original cyan-blue TUI coding agent that inspired this project's design and approach
- **[claude-code](https://github.com/anthropics/claude-code)** - The conversation flow and tool interaction patterns

Special thanks to the communities behind these projects for pushing the boundaries of AI-assisted coding.

---

## 📄 License

MIT License - See LICENSE file for details.

---

# hncode — AI 编程助手命令行工具

> **这是我 Vibe Coding 的产物，可能不是特别好，但是如果有什么建议的话也欢迎提 issue**

一个青色蓝调终端界面的 AI 编程助手，灵感来自 kimi-code-cli，支持 OpenAI 和 Anthropic API，配备 MCP 风格的工具集和智能上下文管理。

---

## 🌟 功能特性

- **青色蓝调 TUI**: 原生终端渲染器，完美兼容 Windows Terminal
- **双协议支持**: 同时支持 OpenAI 兼容 API 和 Anthropic
- **智能上下文管理**: 85% 使用率时自动压缩，AI 摘要保留历史对话
- **MCP 风格工具集**: Read、Write、Edit、Bash、Glob、Grep、TodoList、WebSearch 等
- **插件系统**: 通过自定义工具、命令和钩子扩展功能
- **会话持久化**: 跨会话恢复对话
- **权限模式**: Ask、YOLO、Auto 三种工作流模式

---

## 🚀 安装

```bash
npm install -g hncode
```

或直接使用：
```bash
npx hncode
```

---

## ⚙️ 配置

创建 `~/.hncode/config.toml`：

```toml
default_model = "gpt-4o-mini"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "你的-api-key"

[models.gpt-4o-mini]
provider = "openai"
model = "gpt-4o-mini"
```

或使用环境变量：
```bash
export HNCODE_API_KEY="你的-key"
export HNCODE_PROVIDER="openai"
export HNCODE_MODEL="gpt-4o-mini"
```

---

## 📖 使用方法

### 基本命令

```bash
# 启动交互式会话
hncode

# 无头模式（单次提示）
hncode -p "修复 src/main.js 中的 bug"

# 继续之前的会话
hncode --continue

# 自动模式（不问问题）
hncode --auto
```

### 斜杠命令

| 命令 | 描述 |
|------|------|
| `/compact [ratio]` | 压缩对话（AI 摘要 + 保留最近 20%） |
| `/model <name>` | 切换 LLM 模型 |
| `/sessions` | 浏览和恢复过往对话 |
| `/move <path>` | 将当前会话迁移到另一个目录 |
| `/auto` / `/ask` / `/yolo` | 切换权限模式 |
| `/plan` / `/focus` | 切换仅研究或完整编辑模式 |
| `/calm-mode` | 简洁回复（跳过叙述） |
| `/help` | 显示所有命令 |

### 高级功能

**Tab 补全**: 
- 输入 `/` → 命令菜单
- 输入 `@` → 文件/文件夹补全
- 使用 Tab 导航，Enter 选择

**自动压缩**: 
- 在 85% 上下文窗口时触发
- AI 摘要被丢弃的消息
- 保留最近 20% 的对话

**插件系统**:
将插件放在 `~/.hncode/plugins/`：
```javascript
// my-plugin.mjs
export function install(api) {
  api.registerTool({ /* ... */ });
  api.registerCommand({ name: 'mycmd', run: () => {} });
}
export default { name: 'my-plugin', version: '1.0.0' };
```

---

## 🛠 内置工具

- `Read`, `Write`, `Edit` - 文件操作
- `Bash` - 执行 Shell 命令
- `Glob`, `Grep` - 搜索文件
- `TodoList`, `TaskOutput` - 任务管理
- `FetchURL`, `WebSearch` - 网络访问
- `ReadMediaFile`, `FileLines` - 媒体处理

---

## 🎨 主题

支持的 theme：`auto`、`dark`、`light` 或自定义 RGB 颜色。

通过配置设置：
```toml
theme = "dark"
```

或在 TUI 中使用 `/theme <name>`。

---

## 🤝 贡献

这个项目是通过 Vibe Coding 创建的。虽然它可能不够完美，但我欢迎您的反馈！

**欢迎：**
- 提交问题报告 bug 或提出建议
- Fork 并创建拉取请求
- 分享您使用 hncode 的体验

---

## 🙏 致谢

hncode 从以下几个优秀项目中汲取了灵感：

- **[kimi-code-cli](https://github.com/mckaymatt/kimi-code-cli)** - 原始的青色蓝调终端界面 AI 编程助手，启发了本项目的设计和理念
- **[claude-code](https://github.com/anthropics/claude-code)** - 对话流程和工具交互模式

特别感谢这些项目背后的社区，它们推动了 AI 辅助编程的边界。

---

## 📄 许可证

MIT License - 详见 LICENSE 文件。
