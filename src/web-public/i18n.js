export const LANGUAGES = [
  {
    "id": "zh",
    "label": "中文"
  },
  {
    "id": "en",
    "label": "English"
  }
];

export const DEFAULT_LANG = "en";

export const MESSAGES = {
  "app.title": {
    "zh": "hncode",
    "en": "hncode"
  },
  "login.heading": {
    "zh": "hncode",
    "en": "hncode"
  },
  "login.lede": {
    "zh": "访问令牌保存在 config.toml 里，第一次运行时自动生成，之后一直不变。",
    "en": "The access token lives in config.toml. It is generated once and stays the same."
  },
  "login.tokenLabel": {
    "zh": "访问令牌",
    "en": "Access token"
  },
  "login.submit": {
    "zh": "进入",
    "en": "Sign in"
  },
  "login.badToken": {
    "zh": "令牌不对。",
    "en": "Invalid token."
  },
  "login.failed": {
    "zh": "登录失败。",
    "en": "Sign-in failed."
  },
  "login.unreachable": {
    "zh": "连不上服务：",
    "en": "Cannot reach the server: "
  },
  "login.foot": {
    "zh": "本地服务，只监听回环地址。在任意一个终端里运行 /web 都能看到这台机器上的所有会话。",
    "en": "Local service, loopback only. Run /web in any terminal to see every session on this machine."
  },
  "home.brandSuffix": {
    "zh": "会话",
    "en": "sessions"
  },
  "home.lede": {
    "zh": "这台机器上的所有会话。运行中的可以继续对话，已退出的只能查看。",
    "en": "Every session on this machine. Running ones accept input; exited ones are read-only."
  },
  "home.empty": {
    "zh": "还没有任何会话。在终端里运行 hncode 开始一个。",
    "en": "No sessions yet. Start one by running hncode in a terminal."
  },
  "home.live": {
    "zh": "运行中",
    "en": "Running"
  },
  "home.saved": {
    "zh": "已退出",
    "en": "Exited"
  },
  "home.readonly": {
    "zh": "只读",
    "en": "Read-only"
  },
  "home.untitled": {
    "zh": "未命名",
    "en": "Untitled"
  },
  "home.noWorkspace": {
    "zh": "未知目录",
    "en": "Unknown directory"
  },
  "home.refresh": {
    "zh": "刷新",
    "en": "Refresh"
  },
  "home.logout": {
    "zh": "退出登录",
    "en": "Sign out"
  },
  "home.colTitle": {
    "zh": "会话",
    "en": "Session"
  },
  "home.colUpdated": {
    "zh": "最后活动",
    "en": "Last active"
  },
  "home.colRounds": {
    "zh": "回合",
    "en": "Turns"
  },
  "home.sessionCount": {
    "zh": "{n} 个会话",
    "en": "{n} session(s)"
  },
  "home.loadFailed": {
    "zh": "读取会话列表失败：",
    "en": "Could not load sessions: "
  },
  "home.justNow": {
    "zh": "刚刚",
    "en": "just now"
  },
  "home.minutesAgo": {
    "zh": "{n} 分钟前",
    "en": "{n}m ago"
  },
  "home.hoursAgo": {
    "zh": "{n} 小时前",
    "en": "{n}h ago"
  },
  "home.daysAgo": {
    "zh": "{n} 天前",
    "en": "{n}d ago"
  },
  "nav.chat": {
    "zh": "对话",
    "en": "Chat"
  },
  "nav.readonly": {
    "zh": "只读",
    "en": "read-only"
  },
  "nav.ariaLabel": {
    "zh": "视图切换",
    "en": "views"
  },
  "rail.ariaLabel": {
    "zh": "会话列表",
    "en": "sessions"
  },
  "nav.tasks": {
    "zh": "任务",
    "en": "Tasks"
  },
  "nav.files": {
    "zh": "文件",
    "en": "Files"
  },
  "nav.logs": {
    "zh": "日志",
    "en": "Logs"
  },
  "nav.tools": {
    "zh": "工具",
    "en": "Tools"
  },
  "nav.commands": {
    "zh": "命令",
    "en": "Commands"
  },
  "nav.connecting": {
    "zh": "连接中",
    "en": "Connecting"
  },
  "nav.connected": {
    "zh": "已连接",
    "en": "Connected"
  },
  "nav.disconnected": {
    "zh": "断开，重连中",
    "en": "Disconnected, retrying"
  },
  "nav.language": {
    "zh": "语言",
    "en": "Language"
  },
  "rail.heading": {
    "zh": "会话",
    "en": "Sessions"
  },
  "rail.empty": {
    "zh": "还没有其它会话",
    "en": "No other sessions"
  },
  "rail.noMatch": {
    "zh": "没有匹配的会话",
    "en": "No session matches"
  },
  "rail.noWorkspace": {
    "zh": "未知目录",
    "en": "Unknown directory"
  },
  "rail.current": {
    "zh": "当前",
    "en": "Current"
  },
  "rail.search": {
    "zh": "搜索 id / 标题 / 目录",
    "en": "search id / title / workspace"
  },
  "rail.all": {
    "zh": "所有会话",
    "en": "All sessions"
  },
  "rail.open": {
    "zh": "会话列表",
    "en": "Sessions"
  },
  "chat.untitled": {
    "zh": "会话",
    "en": "Session"
  },
  "chat.interrupt": {
    "zh": "中断",
    "en": "Interrupt"
  },
  "chat.placeholder": {
    "zh": "输入消息，Enter 发送，Shift+Enter 换行",
    "en": "Message the agent. Enter sends, Shift+Enter adds a line"
  },
  "chat.send": {
    "zh": "发送",
    "en": "Send"
  },
  "chat.shellHint": {
    "zh": "行首加 ! 直接执行命令",
    "en": "A leading ! runs the line in the shell"
  },
  "chat.running": {
    "zh": "运行中",
    "en": "Running"
  },
  "chat.idle": {
    "zh": "空闲",
    "en": "Idle"
  },
  "chat.toggleHint": {
    "zh": "点击展开原文",
    "en": "Click to expand"
  },
  "role.user": {
    "zh": "你",
    "en": "You"
  },
  "role.assistant": {
    "zh": "AI",
    "en": "AI"
  },
  "role.tool": {
    "zh": "工具",
    "en": "Tool"
  },
  "role.toolResult": {
    "zh": "输出",
    "en": "Output"
  },
  "role.system": {
    "zh": "系统",
    "en": "System"
  },
  "role.warn": {
    "zh": "警告",
    "en": "Warn"
  },
  "role.thinking": {
    "zh": "思考",
    "en": "Thinking"
  },
  "role.shell": {
    "zh": "shell",
    "en": "shell"
  },
  "role.plan": {
    "zh": "计划",
    "en": "Plan"
  },
  "role.compaction": {
    "zh": "压缩",
    "en": "Compact"
  },
  "role.aborted": {
    "zh": "中止",
    "en": "Aborted"
  },
  "role.bgTask": {
    "zh": "任务",
    "en": "Task"
  },
  "role.error": {
    "zh": "错误",
    "en": "Error"
  },
  "role.queued": {
    "zh": "队列",
    "en": "Queued"
  },
  "role.steer": {
    "zh": "注入",
    "en": "Steer"
  },
  "tool.running": {
    "zh": "运行中",
    "en": "running"
  },
  "tool.done": {
    "zh": "完成",
    "en": "done"
  },
  "tool.failed": {
    "zh": "失败",
    "en": "failed"
  },
  "compact.running": {
    "zh": "正在压缩",
    "en": "Compacting"
  },
  "compact.done": {
    "zh": "压缩完成",
    "en": "Compaction complete"
  },
  "compact.cancelled": {
    "zh": "压缩取消",
    "en": "Compaction cancelled"
  },
  "compact.amount": {
    "zh": "{before} → {after} tokens",
    "en": "{before} → {after} tokens"
  },
  "tasks.heading": {
    "zh": "后台任务",
    "en": "Background tasks"
  },
  "tasks.refresh": {
    "zh": "刷新",
    "en": "Refresh"
  },
  "tasks.empty": {
    "zh": "没有后台任务。",
    "en": "No background tasks."
  },
  "tasks.colId": {
    "zh": "ID",
    "en": "ID"
  },
  "tasks.colKind": {
    "zh": "类型",
    "en": "Kind"
  },
  "tasks.colStatus": {
    "zh": "状态",
    "en": "Status"
  },
  "tasks.colSummary": {
    "zh": "摘要",
    "en": "Summary"
  },
  "tasks.stop": {
    "zh": "停止",
    "en": "Stop"
  },
  "files.heading": {
    "zh": "会话改动",
    "en": "Session changes"
  },
  "files.sub": {
    "zh": "本轮对话读写过的文件",
    "en": "Files this conversation read or wrote"
  },
  "files.empty": {
    "zh": "本会话还没有读写文件。",
    "en": "No files read or written yet."
  },
  "files.colPath": {
    "zh": "路径",
    "en": "Path"
  },
  "files.colOps": {
    "zh": "操作",
    "en": "Ops"
  },
  "files.colCount": {
    "zh": "次数",
    "en": "Count"
  },
  "logs.heading": {
    "zh": "事件日志",
    "en": "Event log"
  },
  "logs.clear": {
    "zh": "清空",
    "en": "Clear"
  },
  "logs.sub": {
    "zh": "最近的会话事件，最新的在最下面",
    "en": "Recent session events, newest last"
  },
  "tools.heading": {
    "zh": "可用工具",
    "en": "Tools available"
  },
  "tools.sub": {
    "zh": "由本会话的模型调用",
    "en": "Callable by the model in this session"
  },
  "commands.heading": {
    "zh": "斜杠命令",
    "en": "Slash commands"
  },
  "commands.sub": {
    "zh": "与终端完全一致",
    "en": "Identical to the terminal"
  },
  "side.runtime": {
    "zh": "运行",
    "en": "Runtime"
  },
  "settings.open": {
    "zh": "设置",
    "en": "Settings"
  },
  "settings.title": {
    "zh": "设置",
    "en": "Settings"
  },
  "settings.close": {
    "zh": "关闭",
    "en": "Close"
  },
  "settings.save": {
    "zh": "保存",
    "en": "Save"
  },
  "settings.session": {
    "zh": "会话",
    "en": "Session"
  },
  "settings.titleLabel": {
    "zh": "标题",
    "en": "Title"
  },
  "settings.titleSaved": {
    "zh": "标题已保存",
    "en": "Title saved"
  },
  "settings.providers": {
    "zh": "Provider",
    "en": "Providers"
  },
  "settings.noProviders": {
    "zh": "还没有配置 provider",
    "en": "No providers configured"
  },
  "settings.discover": {
    "zh": "拉取模型",
    "en": "discover"
  },
  "settings.foundModels": {
    "zh": "找到 {n} 个模型",
    "en": "Found {n} model(s)"
  },
  "settings.import": {
    "zh": "导入",
    "en": "import"
  },
  "settings.imported": {
    "zh": "已导入 {name}，新增 {n} 个模型",
    "en": "Imported {name}, {n} new model(s)"
  },
  "settings.importKnown": {
    "zh": "从 models.dev 导入",
    "en": "Import from models.dev"
  },
  "settings.keyPrompt": {
    "zh": "请输入 {name} 的 API key：",
    "en": "API key for {name}:"
  },
  "settings.addProvider": {
    "zh": "添加",
    "en": "Add"
  },
  "settings.added": {
    "zh": "已添加 {name}",
    "en": "Added {name}"
  },
  "settings.remove": {
    "zh": "删除",
    "en": "remove"
  },
  "settings.removed": {
    "zh": "已删除 {name}",
    "en": "Removed {name}"
  },
  "settings.confirmRemove": {
    "zh": "删除 provider {name}？它的模型也会一并移除。",
    "en": "Delete provider {name}? Its models go too."
  },
  "settings.noMatch": {
    "zh": "没有匹配项",
    "en": "No match"
  },
  "settings.nameRequired": {
    "zh": "名称不能为空",
    "en": "Name is required"
  },
  "settings.failed": {
    "zh": "操作失败：",
    "en": "Failed: "
  },
  "settings.prefs": {
    "zh": "偏好",
    "en": "Preferences"
  },
  "settings.info": {
    "zh": "当前生效",
    "en": "In force"
  },
  "settings.model": {
    "zh": "模型",
    "en": "Model"
  },
  "settings.provider": {
    "zh": "Provider",
    "en": "Provider"
  },
  "settings.protocol": {
    "zh": "协议",
    "en": "Protocol"
  },
  "settings.endpoint": {
    "zh": "端点",
    "en": "Endpoint"
  },
  "settings.key": {
    "zh": "密钥",
    "en": "API key"
  },
  "settings.workspace": {
    "zh": "目录",
    "en": "Workspace"
  },
  "settings.ctx": {
    "zh": "上下文窗口",
    "en": "Context window"
  },
  "settings.phName": {
    "zh": "名称",
    "en": "name"
  },
  "settings.phUrl": {
    "zh": "接口地址",
    "en": "base URL"
  },
  "settings.phKey": {
    "zh": "API key",
    "en": "API key"
  },
  "settings.phFilter": {
    "zh": "筛选",
    "en": "filter"
  },
  "settings.tagKey": {
    "zh": "已设密钥",
    "en": "key"
  },
  "settings.tagNoKey": {
    "zh": "无密钥",
    "en": "no key"
  },
  "settings.noUrl": {
    "zh": "未设置地址",
    "en": "(no url)"
  },
  "settings.modelCount": {
    "zh": "{n} 个模型",
    "en": "{n} model(s)"
  },
  "settings.valSet": {
    "zh": "已设置",
    "en": "set"
  },
  "settings.valNotSet": {
    "zh": "未设置",
    "en": "not set"
  },
  "pref.calm": {
    "zh": "简洁模式",
    "en": "Calm mode"
  },
  "pref.autoCompact": {
    "zh": "自动压缩",
    "en": "Auto compact"
  },
  "pref.autoUpdate": {
    "zh": "自动更新",
    "en": "Auto update"
  },
  "pref.promptCache": {
    "zh": "提示缓存",
    "en": "Prompt cache"
  },
  "pref.external": {
    "zh": "允许工作区外路径",
    "en": "Allow external paths"
  },
  "side.model": {
    "zh": "模型",
    "en": "Model"
  },
  "side.provider": {
    "zh": "Provider",
    "en": "Provider"
  },
  "side.mode": {
    "zh": "权限",
    "en": "Permission"
  },
  "side.cwd": {
    "zh": "目录",
    "en": "Directory"
  },
  "side.plan": {
    "zh": "计划模式",
    "en": "Plan mode"
  },
  "side.effort": {
    "zh": "思考",
    "en": "Thinking"
  },
  "side.focus": {
    "zh": "专注模式",
    "en": "Focus mode"
  },
  "side.busy": {
    "zh": "状态",
    "en": "State"
  },
  "side.context": {
    "zh": "上下文",
    "en": "Context"
  },
  "side.usage": {
    "zh": "用量",
    "en": "Usage"
  },
  "side.rounds": {
    "zh": "轮次",
    "en": "Rounds"
  },
  "side.steps": {
    "zh": "步骤",
    "en": "Steps"
  },
  "side.rate": {
    "zh": "速度",
    "en": "Rate"
  },
  "unit.rounds": {
    "zh": "{n}轮",
    "en": "{n} turns"
  },
  "unit.steps": {
    "zh": "{n}步",
    "en": "{n} steps"
  },
  "unit.rate": {
    "zh": "{n} tok/s",
    "en": "{n} tok/s"
  },
  "unit.none": {
    "zh": "—",
    "en": "—"
  },
  "side.todos": {
    "zh": "待办",
    "en": "Todos"
  },
  "side.queue": {
    "zh": "队列",
    "en": "Queue"
  },
  "side.quick": {
    "zh": "快捷",
    "en": "Quick"
  },
  "side.on": {
    "zh": "开",
    "en": "on"
  },
  "side.off": {
    "zh": "关",
    "en": "off"
  },
  "side.none": {
    "zh": "（无）",
    "en": "(none)"
  },
  "mark.user": {
    "zh": "❯",
    "en": "❯"
  },
  "mark.queued": {
    "zh": "❯",
    "en": "❯"
  },
  "mark.steer": {
    "zh": "❯",
    "en": "❯"
  },
  "mark.bash": {
    "zh": "!",
    "en": "!"
  },
  "mark.warn": {
    "zh": "⚑",
    "en": "⚑"
  },
  "mark.thinking": {
    "zh": "●",
    "en": "●"
  },
  "mark.tool": {
    "zh": "●",
    "en": "●"
  },
  "mark.toolFailed": {
    "zh": "✗",
    "en": "✗"
  },
  "mark.result": {
    "zh": "↳",
    "en": "↳"
  },
  "mark.bgTask": {
    "zh": "●",
    "en": "●"
  },
  "mark.bgTaskFailed": {
    "zh": "✗",
    "en": "✗"
  },
  "tool.verb": {
    "zh": "调用",
    "en": "Used"
  },
  "tool.using": {
    "zh": "调用",
    "en": "Using"
  },
  "tool.used": {
    "zh": "调用",
    "en": "Used"
  },
  "chat.thinking": {
    "zh": "思考…",
    "en": "thinking…"
  },
  "tool.compacting": {
    "zh": "正在压缩上下文…",
    "en": "Compacting context…"
  },
  "tool.compacted": {
    "zh": "压缩完成",
    "en": "Compaction complete"
  },
  "tool.compactCancelled": {
    "zh": "压缩取消",
    "en": "Compaction cancelled"
  },
  "tool.moreLines": {
    "zh": "还有 {n} 行，展开",
    "en": "{n} more lines, expand"
  },
  "tool.collapse": {
    "zh": "收起",
    "en": "collapse"
  },
  "tool.noChanges": {
    "zh": "没有改动",
    "en": "no changes"
  },
  "chat.shellMode": {
    "zh": "shell 模式，Enter 执行",
    "en": "shell mode, Enter runs it"
  },
  "status.usage": {
    "zh": "{turns} 轮 | {steps} 步 | {rate} tok/s",
    "en": "{turns} turns | {steps} steps | {rate} tok/s"
  },
  "status.context": {
    "zh": "上下文 {pct}% ({used}/{max})",
    "en": "context {pct}% ({used}/{max})"
  },
  "status.tasksBash": {
    "zh": "[{n} 个任务运行中]",
    "en": "[{n} task(s) running]"
  },
  "status.tasksAgent": {
    "zh": "[{n} 个 agent 运行中]",
    "en": "[{n} agent(s) running]"
  },
  "status.expandTodos": {
    "zh": "展开全部待办",
    "en": "Show every todo"
  },
  "copy.copy": {
    "zh": "复制",
    "en": "copy"
  },
  "copy.copyTitle": {
    "zh": "复制到剪贴板",
    "en": "Copy to clipboard"
  },
  "copy.done": {
    "zh": "已复制",
    "en": "copied"
  },
  "copy.failed": {
    "zh": "复制失败",
    "en": "failed"
  },
  "drawer.close": {
    "zh": "Esc 关闭",
    "en": "esc ✕"
  },
  "tool.args": {
    "zh": "参数",
    "en": "args"
  },
  "queue.steer": {
    "zh": "注入",
    "en": "Steer"
  },
  "queue.steering": {
    "zh": "注入中…",
    "en": "Steering…"
  },
  "queue.steerHint": {
    "zh": "立即注入到正在进行的回合",
    "en": "Inject this into the running turn now"
  },
  "queue.edit": {
    "zh": "编辑",
    "en": "Edit"
  },
  "queue.editHint": {
    "zh": "取回输入框修改，不再排队",
    "en": "Pull it back into the composer to change it"
  },
  "queue.drop": {
    "zh": "移除",
    "en": "Drop"
  },
  "queue.dropHint": {
    "zh": "从队列中删除这条消息",
    "en": "Remove this message from the queue"
  },
  "queue.moreHint": {
    "zh": "… 还有 {n} 条",
    "en": "… +{n} more"
  },
  "queue.hintRunning": {
    "zh": "等待本回合结束",
    "en": "Sent when this turn ends"
  },
  "queue.hintIdle": {
    "zh": "回合结束后依次发送",
    "en": "Sent in order once the turn ends"
  },
  "popover.click": {
    "zh": "点击切换",
    "en": "Click to change"
  },
  "popover.effortLabel": {
    "zh": "思考等级",
    "en": "Thinking Effort"
  },
  "popover.effort": {
    "zh": "思考 {v}",
    "en": "think {v}"
  },
  "popover.off": {
    "zh": "off",
    "en": "off"
  },
  "popover.unknown": {
    "zh": "—",
    "en": "—"
  },
  "modal.approve": {
    "zh": "批准",
    "en": "Approve"
  },
  "modal.reject": {
    "zh": "拒绝",
    "en": "Reject"
  },
  "modal.allow": {
    "zh": "允许",
    "en": "Allow"
  },
  "modal.deny": {
    "zh": "拒绝",
    "en": "Deny"
  },
  "modal.question": {
    "zh": "需要选择",
    "en": "Question"
  },
  "modal.submit": {
    "zh": "提交",
    "en": "Submit"
  },
  "modal.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "modal.other": {
    "zh": "Other",
    "en": "Other"
  },
  "modal.otherHint": {
    "zh": "自己输入答案",
    "en": "Type your own answer"
  },
  "modal.note": {
    "zh": "补充说明",
    "en": "Add a note"
  },
  "modal.noteHint": {
    "zh": "写给整轮问题的补充，可留空",
    "en": "Optional notes for the whole request"
  },
  "modal.next": {
    "zh": "下一题",
    "en": "Next"
  },
  "modal.progress": {
    "zh": "第 {n}/{total} 题",
    "en": "Question {n}/{total}"
  },
  "err.actionFailed": {
    "zh": "操作失败",
    "en": "Action failed"
  },
  "err.unreachable": {
    "zh": "连不上服务：",
    "en": "Cannot reach the server: "
  },
  "err.unauthorized": {
    "zh": "未授权",
    "en": "Unauthorized"
  },
  "http.notFound": {
    "zh": "找不到",
    "en": "not found"
  },
  "http.badMethod": {
    "zh": "不支持该请求方法",
    "en": "method not allowed"
  },
  "http.unauthorized": {
    "zh": "未授权",
    "en": "unauthorized"
  }
};

export function t(lang, key, vars) {
  const entry = MESSAGES[key];
  if (!entry) return key;
  let s = entry[lang] || entry[DEFAULT_LANG] || entry.en || key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

export function catalog(lang) {
  const out = {};
  for (const key of Object.keys(MESSAGES)) out[key] = t(lang, key);
  return out;
}
