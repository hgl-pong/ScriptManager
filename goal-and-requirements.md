---
id: scriptmanager-goal
type: goal-and-requirements
status: active
title: ScriptManager 目标与需求
tags: [windows, powershell, ai, tooling]
---

# ScriptManager

Windows 上的本地脚本库 + AI 生成助手：双击一个 `.bat` 打开，脚本扫得到、跑得动、AI 改得了。

## Overview

ScriptManager 是我自己在一台 Windows 机器上用的本地小工具。双击 `ScriptManager.bat` 会在一个独立的浏览器应用窗口里打开界面：
看到脚本库列表，能带参数运行、实时看输出和退出码；需要新脚本时用一句话让 AI 写出来，预览后存进库里直接跑；
已有脚本报错时选中它问 AI 解释、修复或加日志。

它替代的是「散在磁盘各处的脚本 + 记事本 + 每次重查语法」这件事。它不是 IDE（不写编辑器）、
不是调度器（不定时跑）、不管理版本历史（可交给 git）。

## Problem

我的脚本散在 `E:\Tools`、桌面和各项目目录里。要跑其中一个，得先回想它在哪，再开一个 cmd 敲路径，
忘了参数还要翻文件头注释；想改的时候打开记事本，改完不知道原来长什么样，也没有任何运行记录。
最费时间的其实是**写新脚本**：一个临时念头（批量重命名、清理某目录下超过 30 天的日志、给一批图片改尺寸）
要花十几分钟查语法、试错、再调试；写完以后它和别的脚本一样散掉，下次还是找不到。

净效果是：用得越多，越找不到；越找不到，越倾向于每次重新写一遍。

## Capabilities

### 脚本库

- 扫描指定根目录里的 `.bat` / `.cmd` / `.ps1` / `.py`，登记为条目：显示名、路径、类型、标签、最近运行时间与结果
- 列表按名称和标签搜索，最近使用过的排在前面
- 选中即可运行：遇到需要参数的脚本先弹一个参数输入框，运行中把 stdout/stderr 实时贴到输出区，结束后显示退出码与耗时
- 选中项可以「用默认编辑器打开」和「在资源管理器里定位」

### AI 生成脚本

- 一句话描述需求 → 用当前选中的 AI 配置生成脚本 → 预览 → 确认后保存进库（可填标签、选目标目录）→ 可直接运行
- 固定上下文包含「Windows + 目标解释器（cmd / PowerShell / Python）」约束，并要求只输出脚本、中文注释
- 生成结果不满意可以追问重生成，不必重新描述需求

### AI 解释 / 修复 / 优化

- 对选中的脚本发起：解释它做了什么 / 为什么报错（自动附带最近一次运行的输出和退出码）/ 加日志与错误处理 / 改写得更安全
- 结果显示在窗口里，可只读查看；也可一键回写文件，覆盖前先把原文件备份为 `.bak`
- 回写后提示「差异摘要」（改了几行、新增了什么），不假装是完整 diff 工具

### AI 接入配置

- 三种协议各一套适配，互不共用请求代码：
  - **OpenAI Chat Completions**（`/v1/chat/completions`）—— 同时覆盖 DeepSeek、通义、Kimi、本地 vLLM 等兼容端点，靠自定义 Base URL 指向
  - **OpenAI Responses**（`/v1/responses`）
  - **Anthropic Messages**（`/v1/messages`）
- 一条 AI 配置包含：显示名、协议类型、Base URL、模型名、API Key、可选额外请求头
- 界面里可以增删改多条配置，并「测试连接」：发一句极短请求，显示模型回话，或原样显示 HTTP 状态码与错误消息
- 有一条配置处于「当前生效」状态，生成与解释请求都走它；回复按流式逐字显示，可用「停止」中断

## Tech Notes

| Aspect | Choice | Rationale |
| --- | --- | --- |
| 入口 | `ScriptManager.bat` | 双击即用；只做隐藏窗口启动 `node server\app.js` 并退出，逻辑为零 |
| 服务端 | Node.js + 内置 `node:http` 自写路由，零生产依赖 | 本机已有 Node 24；扫描、进程、JSON 都在同一门语言里，测试用 `node:test` 直接打 HTTP 接口 |
| 界面 | React + TypeScript + Vite，构建产物由服务端静态托管；启动后用 Edge `--app` 开独立窗口（无地址栏） | 浏览器能做的事远多于 WinForms 自绘控件；`--app` 保留「一个窗口」的体验 |
| 网络 | 只监听 `127.0.0.1`，启动生成一枚 token，请求带 `x-sm-token` | 本机端口对任何网页可见，不带 token 的跨站请求一律拒 |
| 输出流 | 浏览器每 200ms 轮询增量行（`after` 游标） | 本地延迟无感；比 SSE 少一层连接、重连与代理缓冲的坑 |
| 脚本执行 | `cmd /c` / `powershell -File` / `python -X utf8` 子进程，按行读 stdout/stderr，按 OEM 码页解码 | 与终端里手动跑等价，参数与退出码原样透传 |
| 配置 | 工具目录下 `config.json`（扫描根目录、窗口尺寸）+ `library.json`（别名/标签/上次运行），`.gitignore` 排除 | 便携、跟着工具目录走；API Key（下一片）也在本地文件、不入 git |

## Alternatives Considered

同类工具已经不少，但它们都只做「库 + 运行」，没有「让 AI 把需求写进库」。这个组合是继续自己做的理由，不是功能清单。

| 项目 | 差在哪 | 链接 |
| --- | --- | --- |
| BatWallet | 最接近的定位：.cmd/.ps1 收藏后双击即跑，MIT、.NET 8 双皮肤。但它只是启动器——无 AI、无标签搜索、不留输出与退出码 | <https://github.com/SecretChilliZ/BatWallet> |
| Conscripts | BAT/PS1 集中启动，C#/WinUI3 且有 Store 包。要 .NET 构建链，不是「一个 bat 拷贝即用」；同样无 AI | <https://github.com/sh0ckj0ckey/Conscripts> |
| ScriptDeck | 扫目录里带 README 的 .bat 项目，浏览器界面检索并启动。要 Python + 浏览器常驻，无流式输出与退出码 | <https://github.com/huanyu-a/ScriptDeck_Script_Manager> |
| PsLauncher | 托盘常驻 + 多标签终端，ANSI 彩色输出、强制结束子进程——运行体验最强。但无 AI，重心是并行守护多个长跑脚本 | <https://github.com/NGC13009/PsLauncher> |
| cc-yh | 参考价值在于它同样把 **OpenAI Chat / OpenAI Responses / Anthropic** 三种接口做成一套可切换配置，证明这个三协议抽象可行。但它是通用 agent 工作台，不管理我的脚本库，生成结果也不会落成库里的条目 | <https://github.com/ApolloYH/cc-yh> |

只想要「收集 + 运行」的话，BatWallet 已经够用；本项目的差异只有一条：**在同一个窗口里，用一句话把新脚本生成进库，并让 AI 修已有脚本**。代价是要有 Node（本机已装 24）。
