# hncode — AI Coding Agent CLI

> **This is a product of my Vibe Coding session. It may not be perfect, but if you have any suggestions, feel free to open an issue.**

A cyan-blue TUI coding agent inspired by [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code), with OpenAI + Anthropic support, MCP-style toolbelt, and intelligent context management.

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

### Tab Completion

- Type `/` → command menu
- Type `@` → file/folder completion
- Use Tab to navigate, Enter to select

### Auto Compaction

- Triggers automatically when context usage reaches 85%
- AI summarizes dropped messages instead of simply deleting them
- Keeps the most recent 20% of conversation to maintain context coherence

---

## 🔧 Plugin System

### Creating Plugins

Create `.js` or `.mjs` files in `~/.hncode/plugins/`:

```javascript
// my-plugin.mjs
export function install(api) {
  // Register new tool
  api.registerTool({
    name: 'MyTool',
    description: '...',
    parameters: { /* schema */ },
    async execute(args, ctx) { return result; }
  });
  
  // Register command
  api.registerCommand({
    name: 'mycmd',
    description: '...',
    run: (arg, ctx) => { /* ... */ }
  });
  
  // Register hook
  api.registerHook('onTurnEnd', (turnInfo) => { /* ... */ });
}

export default { name: 'my-plugin', version: '1.0.0' };
```

### View Loaded Plugins

```bash
hncode /plugins
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

## 🎨 Themes

Supported themes: `auto`, `dark`, `light`, or custom RGB colors.

Set via config:
```toml
theme = "dark"
```

Or use `/theme <name>` in TUI.

---

## 🤝 Contributing

This project was created through Vibe Coding. While it may not be perfect, I welcome your feedback!

**Feel free to:**
- Submit issues for bugs or suggestions
- Fork and create pull requests
- Share your experience using hncode

---

## 🙏 Acknowledgments

hncode draws inspiration from several excellent projects:

- **[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)** - The original cyan-blue TUI coding agent that inspired this project's design and approach
- **[Claude Code](https://github.com/anthropics/claude-code)** - The conversation flow and tool interaction patterns

Special thanks to the communities behind these projects for pushing the boundaries of AI-assisted coding.

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

**In short:**
1. ✅ You can freely use, modify, and share this code
2. ✅ Must retain author attribution (NiceHello666) and link back to this repository
3. ❌ Cannot be used for commercial purposes (e.g., selling, as part of paid products)

---

**NPM Package**: [@hncode/hncode](https://www.npmjs.com/package/@hncode/hncode)  
**GitHub**: [NiceHello666/hncode](https://github.com/NiceHello666/hncode)  
**Chinese Version**: [README_CN.md](./README_CN.md)
