# hncode — AI Coding Agent TUI

English | [简体中文](https://github.com/NiceHello666/hncode/blob/main/README_CN.md) | [Wiki](https://github.com/NiceHello666/hncode/blob/main/README_WIKI.md)

> **This is a product of my Vibe Coding session. It may not be perfect, but if you have any suggestions, feel free to open an issue.**

A cyan-blue terminal user interface (TUI) coding agent inspired by [Kimi Code](https://github.com/MoonshotAI/kimi-code), with OpenAI + Anthropic support, an MCP-style toolbelt, and intelligent context management.

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

---

## 📖 Documentation

This file is a quick overview. For the **full documentation** — every command, config option, architecture notes, and the plugin/development guide — see the Wiki:

- **[Wiki (English)](https://github.com/NiceHello666/hncode/blob/main/README_WIKI.md)**
- **[Wiki (简体中文)](https://github.com/NiceHello666/hncode/blob/main/README_WIKI_CN.md)**

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

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** - The original cyan-blue TUI coding agent that inspired this project's design and approach
- **[Claude Code](https://github.com/anthropics/claude-code)** - The conversation flow and tool interaction patterns
- **[Codex](https://github.com/openai/codex)** - Several behaviours were shaped by reading its open-source implementation: the AGENTS.md loading spec, the rule against spawning subagents unprompted, the plan-tool state machine, the review rubric, and parts of the system prompt

Special thanks to the communities behind these projects for pushing the boundaries of AI-assisted coding.

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](https://github.com/NiceHello666/hncode/blob/main/LICENSE).

**In short:**
1. ✅ You can freely use, modify, and share this code
2. ✅ Must retain author attribution (NiceHello666) and link back to this repository
3. ❌ Cannot be used for commercial purposes (e.g., selling, as part of paid products)

---

**NPM Package**: [@hncode/hncode](https://www.npmjs.com/package/@hncode/hncode)  
**GitHub**: [NiceHello666/hncode](https://github.com/NiceHello666/hncode)
