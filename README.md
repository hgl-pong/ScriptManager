# ScriptManager

Windows 上的本地脚本库 + AI 生成助手。双击 `ScriptManager.bat` 打开一个独立窗口（Edge `--app`），
左边是扫描出的脚本，右上跑脚本看输出，右下让 AI 生成新脚本、解释或修复选中的脚本。

## 快速开始

```bash
npm install
npm run build      # 生成 web/dist，只需在首次或改动前端后执行
```

然后双击 `ScriptManager.bat`：它在后台起一个只监听 `127.0.0.1` 的 Node 服务（默认端口 8765，被占则往后找），
带一枚随机 token 打开 Edge 应用窗口。关掉窗口服务仍在后台，需要停止时在任务管理器结束 `node.exe`。

第一次打开点顶栏 `目录…` 选一个扫描目录，列表就会填满。

## AI 使用（本地 Claude Code）

前置：目标机安装并登录 Claude Code CLI，`claude` 在 PATH 中。

1. 右下 AI 面板点「设置…」：命令默认 `claude`，可按需填模型、推理强度（low/medium/high/xhigh/max）、
   工作目录、额外参数和超时；保存后启用本地 Code Agent。
2. 点「连接测试」会跑一句极短请求，确认 CLI 已登录且可用。
3. 输入一句话点「生成」；结果流式显示且可手改，点「保存为脚本…」选目录/文件名/解释器，保存后自动重扫入库。
   若保存目录还不在扫描根目录里，会自动加入，保证保存的脚本立刻出现在列表中。
   不满意可以补一句再点「重生成」，会带上上一版结果。
4. 选中一个脚本后可用「解释」「为什么报错」「加日志」「改写更安全」。诊断会自动带上最近一次运行的退出码与输出；
   加日志和安全改写的结果可「回写文件」，覆盖前先备份为 `.bak`（已存在则 `.bak.1`、`.bak.2`…，不覆盖旧备份），
   回写保持原文件编码（GBK / UTF-16LE 不会被静默转成 UTF-8）。

### AI 聊天记录

AI 面板有「当前结果 / 聊天记录」两个页签。聊天记录保留最近 30 次请求（生成 / 解释 / 诊断 / 加日志 / 改写），
显示时间、脚本、提示词和结果；状态为完成的记录可「载入结果」回到当前结果区，再保存或回写。
记录在 `ai-history.json`，可在页签里清空。它是展示记录，不会作为下一次请求的上下文。

### 运行记录

底部「运行记录…」列出最近 100 次运行（脚本、参数、退出码、耗时）。可以「填入参数」或「再次运行」；
选中脚本时，参数输入框也会用下拉提示该脚本最近的参数。记录在 `run-history.json`。

## 单文件 exe

已经生成 `release\ScriptManager.exe`（约 86 MB，内置 Node 运行时与前端资源，目标机不需要安装 Node）。
重新打包：

```bash
npm install
npm run build:exe
```

产物在 `release\` 目录。首次启动会把内嵌前端解压到 `%TEMP%\ScriptManager-web\<build-id>`，
自动创建 `release\scripts\` 并把它设为默认扫描目录；配置、脚本库和日志也写在该目录
（exe 目录不可写时回退到 `%LOCALAPPDATA%\ScriptManager`）。
exe 构建时会把 PE 子系统切到 Windows GUI（2），双击不会出现控制台黑框；运行日志在 `release\logs\server.log`。
exe 未签名，Windows SmartScreen 可能提示；支持与 bat 相同的 `--no-open`、`--no-token`、`--port=8765` 参数。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `ScriptManager.bat` | 开发入口（隐藏窗口启动 Node 服务） |
| `release/ScriptManager.exe` | 单文件可执行版（内置 Node + 前端资源；配置与日志也在该目录） |
| `server/app.js` | 开发入口：定位仓库根目录后交给 `start.js` |
| `server/start.js` | 选端口、生成 token、起服务、开浏览器窗口（bat 与 exe 共用） |
| `server/sea-main.js` | exe 入口：定位数据目录、解压内嵌前端、启动服务 |
| `server/server.js` | `node:http` 路由、token 校验、静态托管 |
| `server/library.js` | 扫描、类型判定、视图合并排序 |
| `server/store.js` | `config.json` / `library.json` 读写 |
| `server/runner.js` | 命令行拼装、子进程、增量输出、退出码、停止、终端 |
| `server/ai/local.js` | 本地 Claude Code 子进程：stdin 提示词、流式 stdout、停止、超时 |
| `server/ai/protocols.js` | OpenAI Chat / Responses / Anthropic 适配（API 兼容保留，界面不暴露） |
| `server/ai/prompts.js` | 生成 / 解释 / 诊断 / 加日志 / 安全改写的提示词 |
| `server/ai/job.js` | API 请求生命周期（SSE 累积、字符游标、停止） |
| `server/ai/secret.js` | API Key 的 DPAPI 加解密（API 兼容保留） |
| `server/encoding.js` | 脚本编码识别与保持：UTF-8 BOM / UTF-16LE/BE / GBK |
| `shared/rows.js` | 服务端与浏览器共用的过滤/标签/格式化逻辑 |
| `web/` | Vite + React + TypeScript 界面（`AiPane`、`LocalAgentDialog`、`SaveScriptDialog`） |
| `scripts/` | **默认扫描目录**（首次运行自动创建；把你的 .bat/.cmd/.ps1/.py 放这里） |
| `tools/build-exe.mjs` | SEA 打包脚本（vite build → esbuild bundle → blob → postject） |
| `tests/` | `node --test` 断言（库、存储、运行器、AI 协议/任务/接口、HTTP 接口） |

## 配置

- `config.json`：扫描根目录、窗口尺寸、本地 Code Agent 配置（命令、模型、推理强度、工作目录、额外参数、超时）。
- 旧版本的三种 API profiles 如仍存在会原样保留，但界面只显示本地 Agent；API Key 仍按 DPAPI 存储。
- `library.json`：按小写绝对路径记的别名、标签、上次运行（退出码、耗时、参数）。文件不存在的条目只是隐藏，不会被清洗。
- `run-history.json`：最近 100 次运行记录（脚本、参数、退出码、耗时），用于复用参数和再次运行。
- `ai-history.json`：最近 30 次 AI 请求记录；单条结果超过 50 KB 会截断且不可「载入结果」。
- 以上文件都在 `.gitignore` 里，不进版本库。

## 开发

```bash
npm run dev:server   # 无 token、不弹窗，监听 8765
npm run dev          # Vite 5173，/api 代理到 8765
npm test             # node --test
npx tsc --noEmit     # 类型检查
npm run build:exe    # 生成 release/ScriptManager.exe
```

## 说明

- 服务只监听回环地址，且 `/api/*` 需要启动 URL 里那枚 token，浏览器里的其它网页无法驱动它。
- 输出按 200ms 轮询增量取行；子进程输出按系统 OEM 码页（本机 936/GBK）解码，`.py` 走 `-X utf8`。
- 交互式脚本（会 `pause` 或读输入）用「在终端里运行」开真实控制台窗口。
- AI 回复同样走轮询（字符游标），可与脚本运行同时进行；同一时刻只接受一个 AI 请求，并发请求会得到 409。
  页面刷新后会重新挂接正在进行的 AI 请求；默认超时 5 分钟，也可以随时「停止」。
- 本地 Agent 以 Claude Code 非交互模式运行：`claude -p --output-format text --tools "" --permission-prompts none`，
  提示词走 stdin；模型映射 `--model`，推理强度映射 `--effort`（low/medium/high/xhigh/max），默认不指定。
- 本地 Agent 不使用本工具的 API Key/DPAPI 配置，直接使用 Claude Code CLI 自己的登录状态。
- 生成结果可先手改再保存；保存/回写会先备份为 `.bak`，已有备份时递增为 `.bak.1`、`.bak.2`…，不会覆盖旧备份。
