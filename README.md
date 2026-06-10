# AI小力

AI小力是一个常驻桌面的 AI 任务助手。它不是只弹一下提醒的工具，而是把“刚刚做了什么、现在该做什么、接下来安排什么”持续沉淀成任务上下文，再交给通用 LLM 做复盘和总结。

你可以像跟助理说话一样输入一句自然语言：刚刚半小时做了什么、未来一小时要做什么、几点提醒什么。AI小力会自动拆成历史动作、单点提醒和时间块，让一天的工作从零散念头变成可执行、可复盘的安排。

macOS 版本额外支持“刚刚发生了啥”的本机语音转写，适合会议、沟通、临时复盘后快速沉淀。

> English summary: AI Xiaoli is an Electron-based desktop AI task assistant. It combines an animated desktop mascot, reminders, natural-language planning, time blocks, snooze tracking, macOS local speech transcription, activity logs, and OpenAI-compatible LLM reviews.

## 功能特性

- 常驻桌面的小力形象，支持静态呼吸、提醒动画、聆听动画和对话气泡。
- 直接安排：用一句话自动创建历史动作、未来单点提醒和未来时间块，不再手动拆任务。
- 自定义提醒：单点提醒只负责某个时间点；时间块负责一段工作区间，结构更接近日程规划。
- 拖延任务二次提醒：“10 分钟后”会更新原提醒，并记录为复盘上下文，不制造重复任务。
- 时间块进度状态：任务进行中时，小力会从黑白状态按进度由下到上恢复原本色彩。
- macOS 菜单栏当前任务：时间块进行中时，顶部状态栏会显示“小力｜当前任务”，不用打开窗口也能知道自己正在推进什么。
- 更轻量的提醒气泡：提醒内容出现在小力头部左上角，点击气泡即可关闭，减少按钮占位。
- “刚刚发生了啥”：macOS 版支持主动录音、本机语音转写、草稿确认和 LLM HTML 复盘。
- AI 总结：可按今天、昨天、七天、自选时间段生成复盘，并支持自定义 Markdown 模板。
- 活动日志：可选记录前台 App 活动、提醒触发、稍后提醒和桌宠交互，用于复盘。
- 软件更新提醒：自动检查 GitHub Release，新版本出现时提示用户，由用户决定查看说明、下载新版或忽略该版本。
- 桌面体验优化：透明点击区域会尽量贴合小力本体，支持桌面拖拽、悬浮按钮、鼠标拖动缩放、开机启动、暂停提醒和显示/隐藏。

## 产品截图

以下截图由当前产品界面直接渲染生成，使用演示数据，不包含真实个人提醒或复盘内容。

### 桌宠提醒

小力常驻桌面，在提醒触发时播放动效并显示对话气泡；点击气泡即可收起，也可以选择“10 分钟后”把原提醒顺延。

![AI小力桌宠提醒](docs/images/desktop-reminder.png)

### 提醒管理

提醒面板采用接近 macOS 提醒事项的结构，支持今天、计划中、停用筛选、单点提醒、时间块规划、直接安排和拖延记录查看。

![AI小力提醒管理](docs/images/reminders-panel.png)

### AI 复盘与通用 LLM API

AI 总结支持今天、昨天、七天和自选时间段；通用 LLM API 使用 OpenAI-compatible Chat Completions 协议。直接安排、智能复盘和“刚刚发生了啥”都复用同一套通用 LLM 配置。

![AI小力智能复盘](docs/images/ai-review.png)

## 平台支持

| 功能 | macOS | Windows |
| --- | --- | --- |
| 桌宠提醒与动画 | 支持 | 支持 |
| 自定义提醒与稍后提醒 | 支持 | 支持 |
| 直接安排：自然语言生成历史动作、提醒和时间块 | 支持，需要 LLM | 支持，需要 LLM |
| 通用 LLM API 复盘 | 支持 | 支持 |
| 活动日志与历史复盘 | 支持 | 支持 |
| 新版本提醒与一键下载 | 支持 | 支持 |
| 菜单栏显示当前任务 | 支持 | 暂不支持 |
| “刚刚发生了啥”本机语音转写 | 支持，基于 macOS Speech | 暂不支持 |
| 本仓库打包脚本 | macOS | 暂不公开 Windows 打包链路 |

## 通用 LLM API

AI小力使用 OpenAI-compatible Chat Completions 协议调用模型：

```http
POST {Base URL}{Chat Path}
Authorization: Bearer <API Key>
Content-Type: application/json
```

请求体格式：

```json
{
  "model": "your-model-name",
  "messages": [],
  "temperature": 0.2
}
```

设置页保留这些配置项：

- Base URL，例如 `https://api.openai.com`
- Chat Path，默认 `/v1/chat/completions`
- Model，例如 `gpt-4o-mini`、`deepseek-chat`、`qwen-plus`
- API Key

常见可用服务包括 OpenAI、DeepSeek、Qwen/通义千问兼容接口、Kimi/Moonshot 兼容接口、SiliconFlow、OpenRouter、OneAPI/New API、Ollama 的 OpenAI-compatible `/v1` 接口等。

暂不直接支持原生非兼容协议，例如 Anthropic 原生 Messages API、Gemini 原生 REST API。此类服务需要通过 OpenAI-compatible 网关使用，或等待后续版本适配。

## 安装使用

### 从 Release 下载

- macOS Apple Silicon：下载 `AI-Xiaoli-macOS-arm64.zip`。
- Windows：下载 `AI-Xiaoli-Windows-x64.zip`。

macOS 当前未做 Apple notarization。如果系统提示无法打开，可在“系统设置 > 隐私与安全性”里允许打开，或自行签名/公证后再分发。

Windows 版本包含桌宠提醒、直接安排、时间块和通用 LLM 复盘；“刚刚发生了啥”的本机语音转写目前只在 macOS 版本提供。

## 本地开发

当前开源源码以 macOS 技术路径为主。Windows 安装包会在 Release 中提供，但 Windows 打包链路暂不在本仓库公开。

```bash
npm install
npm run dev
```

打包 macOS：

```bash
npm run package:mac
```

## 数据位置

运行时数据写入用户目录，不写入安装目录。

macOS：

- `~/Library/Application Support/AI小力/settings.json`
- `~/Library/Application Support/AI小力/reminders.json`
- `~/Library/Application Support/AI小力/activity.jsonl`
- `~/Library/Application Support/AI小力/summary-history.json`
- `~/Library/Application Support/AI小力/just-now-history.json`

新版会从旧的 `~/Library/Application Support/AI小力桌宠/` 自动迁移提醒和设置文件。

## 隐私说明

- 第一版不读取微信、邮件或其他 App 的通知内容。
- macOS 版“刚刚发生了啥”只在用户主动点击录制时开启麦克风。
- macOS 语音转写走系统 Speech 能力；转写后才把确认文本交给用户配置的 LLM。
- API Key 保存在本机 Electron userData 中，macOS 可用时使用 `safeStorage` 加密。

## License

MIT
