# hncode — AI 编程助手命令行工具

> **这是我 Vibe Coding 的产物，可能不是特别好，但是如果有什么建议的话也欢迎提 issue**

一个基于命令行终端的 AI 编程助手，灵感源自 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)。它提供青色蓝调 (Cyan-blue) 的 TUI 界面，支持 OpenAI 和 Anthropic 双协议，配备 MCP 风格的工具集和智能上下文管理。

## 🌟 核心特性

- **原生 TUI 渲染**: 使用原始终端序列号渲染，完美兼容 Windows Terminal，解决 blessed 等库在 Windows 上的兼容性问题
- **双协议支持**: 同时支持 OpenAI-compatible API 和 Anthropic API
- **智能上下文管理**: 
  - 85% 使用率时自动触发压缩
  - AI 摘要保留的历史对话，而非简单丢弃
  - 手动 `/compact` 命令支持自定义压缩比例
- **MCP 风格工具集**: Read, Write, Edit, Bash, Glob, Grep, TodoList, WebSearch, FetchURL 等
- **插件系统**: 可扩展的工具、命令和生命周期钩子
- **会话持久化**: 跨会话恢复对话
- **权限模式**: Ask, YOLO, Auto 三种工作流模式

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

这将下载并运行最新版本，而无需全局安装。

### 本地开发安装

```bash
npm install @hncode/hncode
```

## ⚙️ 配置

创建 `~/.hncode/config.toml`:

```toml
default_model = "gpt-4o-mini"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "your-api-key-here"

[models.gpt-4o-mini]
provider = "openai"
model = "gpt-4o-mini"
```

或使用环境变量:
```bash
export HNCODE_API_KEY="your-key"
export HNCODE_PROVIDER="openai"
export HNCODE_MODEL="gpt-4o-mini"
```

## 📖 使用

### 基本命令

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

### Tab 补全

- 输入 `/` → 命令菜单
- 输入 `@` → 文件/文件夹补全
- 使用 Tab 导航，Enter 选择

### 自动压缩

- 当上下文使用率达到 85% 时自动触发
- AI 会摘要被丢弃的消息，而不是简单删除
- 保留最近的 20% 对话以保持上下文连贯性

## 🔧 插件系统

### 创建插件

在 `~/.hncode/plugins/` 目录下创建 `.js` 或 `.mjs` 文件：

```javascript
// my-plugin.mjs
export function install(api) {
  // 注册新工具
  api.registerTool({
    name: 'MyTool',
    description: '...',
    parameters: { /* schema */ },
    async execute(args, ctx) { return result; }
  });
  
  // 注册命令
  api.registerCommand({
    name: 'mycmd',
    description: '...',
    run: (arg, ctx) => { /* ... */ }
  });
  
  // 注册钩子
  api.registerHook('onTurnEnd', (turnInfo) => { /* ... */ });
}

export default { name: 'my-plugin', version: '1.0.0' };
```

### 查看已加载插件

```bash
hncode /plugins
```

## 🛠 工具集

内置工具包括：
- `Read`, `Write`, `Edit` - 文件操作
- `Bash` - 执行 Shell 命令
- `Glob`, `Grep` - 搜索文件
- `TodoList`, `TaskOutput` - 任务管理
- `FetchURL`, `WebSearch` - 网络访问
- `ReadMediaFile`, `FileLines` - 媒体处理

## 🎨 主题

支持的 theme: `auto`, `dark`, `light`, 或自定义 RGB 颜色。

通过配置设置:
```toml
theme = "dark"
```

或在 TUI 中使用 `/theme <name>`。

## 🤝 贡献

这个项目是通过 Vibe Coding 创建的。虽然它可能不够完美，但我欢迎您的反馈！

**欢迎：**
- 提交问题报告 bug 或提出建议
- Fork 并创建拉取请求
- 分享您使用 hncode 的体验

## 🙏 致谢

hncode 从以下几个优秀项目中汲取了灵感：

- **[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)** - 原始的青色蓝调终端界面 AI 编程助手，启发了本项目的设计和理念
- **[Claude Code](https://github.com/anthropics/claude-code)** - 对话流程和工具交互模式

特别感谢这些项目背后的社区，它们推动了 AI 辅助编程的边界。

## 📄 许可证

本项目的许可受 [GNU General Public License v3.0](LICENSE) 保护。

**简单来说:**
1. ✅ 你可以自由使用、修改和分享此代码
2. ✅ 必须保留原作者署名（NiceHello666）并链接回此仓库
3. ❌ 不得用于商业目的（例如出售、作为付费产品的一部分）

---

**NPM 包**: [@hncode/hncode](https://www.npmjs.com/package/@hncode/hncode)  
**GitHub**: [NiceHello666/hncode](https://github.com/NiceHello666/hncode)  
**English Version**: [README.md](./README.md)
