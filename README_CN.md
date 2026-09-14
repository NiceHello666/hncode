# hncode — AI 编程助手 TUI

[English](https://github.com/NiceHello666/hncode/blob/main/README.md) | 简体中文 | [Wiki](https://github.com/NiceHello666/hncode/blob/main/README_WIKI_CN.md)

> **这是我 Vibe Coding 的产物，可能不是特别好，但是如果有什么建议的话也欢迎提 issue**

一个基于终端用户界面（TUI）的 AI 编程助手，灵感源自 [Kimi Code](https://github.com/MoonshotAI/kimi-code)。它提供青色蓝调 (Cyan-blue) 的 TUI 界面，支持 OpenAI 和 Anthropic 双协议，配备 MCP 风格的工具集和智能上下文管理。

---

## 🌟 核心特性

- **原生 TUI 渲染**: 使用原始终端序列渲染，完美兼容 Windows Terminal，解决 blessed 等库在 Windows 上的兼容性问题
- **双协议支持**: 同时支持 OpenAI-compatible API 和 Anthropic API
- **智能上下文管理**: 85% 使用率时自动压缩，AI 摘要保留历史对话
- **MCP 风格工具集**: Read, Write, Edit, Bash, Glob, Grep, TodoList, WebSearch, FetchURL 等
- **插件系统**: 可扩展的工具、命令和生命周期钩子
- **会话持久化**: 跨会话恢复对话
- **权限模式**: Ask, YOLO, Auto 三种工作流模式

---

## 🚀 安装

### 全局安装（推荐）

```bash
npm install -g @hncode/hncode
```

然后运行：
```bash
hncode
```

### 使用 npx（无需安装）

```bash
npx @hncode/hncode
```

---

## 📖 文档

本文件只是简要介绍。**完整文档**（所有命令、配置项、架构说明、插件与开发指南）请见 Wiki：

- **[Wiki（英文）](https://github.com/NiceHello666/hncode/blob/main/README_WIKI.md)**
- **[Wiki（简体中文）](https://github.com/NiceHello666/hncode/blob/main/README_WIKI_CN.md)**

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

- **[Kimi Code](https://github.com/MoonshotAI/kimi-code)** - 原始的青色蓝调终端界面 AI 编程助手，启发了本项目的设计和理念
- **[Claude Code](https://github.com/anthropics/claude-code)** - 对话流程和工具交互模式

特别感谢这些项目背后的社区，它们推动了 AI 辅助编程的边界。

---

## 📄 许可证

本项目的许可受 [GNU General Public License v3.0](https://github.com/NiceHello666/hncode/blob/main/LICENSE) 保护。

**简单来说:**
1. ✅ 你可以自由使用、修改和分享此代码
2. ✅ 必须保留原作者署名（NiceHello666）并链接回此仓库
3. ❌ 不得用于商业目的（例如出售、作为付费产品的一部分）

---

**NPM 包**: [@hncode/hncode](https://www.npmjs.com/package/@hncode/hncode)  
**GitHub**: [NiceHello666/hncode](https://github.com/NiceHello666/hncode)
