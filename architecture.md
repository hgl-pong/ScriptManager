---
id: scriptmanager-architecture
type: architecture-design
status: draft
title: 'ScriptManager 架构：本地服务 + 浏览器界面'
parent: scriptmanager-goal
---

# 架构

一个本地进程扮演服务端，浏览器扮演界面；没有原生 UI 代码，也没有远程服务。

## 拓扑

`ScriptManager.bat` → 隐藏窗口起 `node server/app.js`；或直接运行单文件 `ScriptManager.exe`（Node SEA，
内置服务端与前端资源，首次启动解压 `web/dist` 到 `%TEMP%\ScriptManager-web\<build-id>`）。两者共用
`server/start.js` → 只监听 `127.0.0.1`（8765 起，被占则顺延）→ 生成一枚启动 token → 用带 token 的 URL
打开 Edge `--app` 窗口（找不到浏览器则退化为默认浏览器）→ React 前端每 200ms 轮询 `/api/output`
取增量输出行；AI 回复另走 `/api/ai/stream`，按字符游标轮询。

服务端静态托管 `web/dist`；开发时 Vite（5173）把 `/api` 代理到同一服务。

## 边界

| 单元 | 拥有 | 不碰 |
| --- | --- | --- |
| `server/app.js` | 开发入口：定位仓库根目录 | 启动细节 |
| `server/start.js` | 选端口、生成 token、装配、开窗口、首次运行写入默认扫描根 | 路由与业务逻辑 |
| `server/sea-main.js` | exe 入口：数据目录选择、内嵌前端解压、日志重定向 | HTTP 路由 |
| `scripts/build-exe.mjs` | 前端构建、esbuild bundle、SEA blob、postject 注入 | 运行时行为 |
| `server/server.js` | HTTP 契约、token 校验、静态托管、当前运行的持有者 | 拼命令行、读写库文件 |
| `server/library.js` | 扫描、类型判定、视图合并与排序 | HTTP、文件写入 |
| `server/store.js` | `config.json` / `library.json` / `run-history.json` / `ai-history.json` 读写（按文件串行化 + 唯一临时文件 + rename 原子写） | 脚本怎么跑 |
| `server/runner.js` | 子进程、行解码、退出码与耗时、停止、终端启动 | 持久化运行记录 |
| `server/ai/protocols.js` | 三种协议的请求构造、SSE 事件解析、`/models` 端点与鉴权（纯函数） | 网络、持久化 |
| `server/ai/prompts.js` | 五种用途的提示词与脚本围栏清理 | HTTP、文件 |
| `server/ai/job.js` | API 请求生命周期：fetch、SSE 累积、字符游标、停止、超时（兼容保留） | 配置与提示词内容 |
| `server/ai/local.js` | 本地 Claude Code 子进程：参数拼装、stdin 提示词、stdout 流、停止、超时 | HTTP、配置结构 |
| `server/ai/secret.js` | API Key 的 DPAPI 加解密与内存缓存（兼容保留） | 配置结构 |
| `server/encoding.js` | 脚本编码识别（BOM / UTF-8 / GBK）与按源编码写回 | HTTP、AI 提示词 |
| `server/paths.js` | 路径键（小写）这一条约定 | 其它 |
| `shared/rows.js` | 过滤、标签集合、最近运行格式化 | node 与 DOM API |
| `web/` | 全部界面状态与呈现 | 业务规则的第二次实现 |

`shared/` 的存在是为了让「界面过滤」与「接口排序」用同一份代码：浏览器从服务端拿全量行，本地过滤，不重复请求。

## 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探测 |
| GET | `/api/state` | 扫描根目录、标签集合、脚本行、最近运行记录、正在运行的 runId（首次扫描有缓存，`?rescan=1` 强制重扫） |
| POST | `/api/scan` · `/api/roots` | 重扫；保存扫描根目录后重扫 |
| GET | `/api/browse?path=` | 目录选择器：空路径返回盘符，否则返回子目录（已跳过规则过滤） |
| POST | `/api/meta` | 写别名与标签，返回新的 state |
| POST | `/api/run` | 启动脚本，返回 `runId`；有运行在跑时返回 409 |
| GET | `/api/output?runId=&after=` | 返回 `{lines, cursor, state, exitCode, durationMs}` 增量 |
| POST | `/api/stop` | 结束进程树 |
| POST | `/api/terminal` | 在真实控制台窗口里跑（不写运行记录） |
| POST | `/api/open` · `/api/reveal` | 默认程序打开、资源管理器定位 |
| GET | `/api/ai/state` | 本地 Agent 配置、API 配置列表（兼容）、上次目录/解释器、协议清单、正在运行的 `job` |
| POST | `/api/ai/local` | 保存本地 Code Agent 配置（命令、模型、推理强度、工作目录、额外参数、超时） |
| POST | `/api/ai/local/test` | 用极短提示词跑一次本地 Agent，返回文本或错误 |
| GET | `/api/ai/history` | 最近 30 次 AI 请求记录（时间、类型、脚本、提示词、结果、状态） |
| POST | `/api/ai/history/clear` | 清空 AI 请求记录 |
| POST | `/api/ai/profiles` | 保存全部 AI 配置与当前生效项；新明文 Key 才重新加密，不传则保留原值；拒绝未知协议 |
| POST | `/api/ai/test` | 用一条极短请求测连通，返回模型回话或原始错误 |
| POST | `/api/ai/models` | 按 profile 的协议/Base URL/Key 请求 `/models`，返回模型列表或可读错误（失败仍可手动输入） |
| POST | `/api/ai/ask` | `{kind, prompt?, path?, type?, previous?}` → `{jobId}`；本地 Agent 启用时走本地 job，否则走 API profile；同步预留单 job 槽位 |
| GET | `/api/ai/stream?jobId=&after=` | `{text, cursor, state, error}`，按字符游标取增量 |
| POST | `/api/ai/stop` | 中断当前 AI 请求 |
| POST | `/api/ai/save` | 写生成脚本（自动补扩展名、同名先问覆盖、编号备份、目录自动加入扫描根）、重扫并返回 state 与 `backupPath` |
| POST | `/api/ai/apply` | 按源编码备份后回写选中脚本，返回改动行数与 `backupPath` |

## 不变量

- 只监听回环地址；`/api/*` 必须带 `x-sm-token`（启动 URL 的 `?t=` 转成请求头），否则 401。任何网页都能向 `127.0.0.1` 发请求，token 是唯一的门。
- 同一时刻只有一个运行。
- 运行记录由 `runner.onExit` 交给服务端写盘；`/api/state` 会 `await pendingSave`，所以界面一看到 `exited` 就一定能读到最后一次退出码与参数。
- 库的键是小写绝对路径；孤儿记录只隐藏不清洗，避免误改配置导致标签丢失。
- 子进程输出按系统 OEM 码页解码（本机 936 → `gbk`），`.py` 走 `-X utf8`；不按 UTF-8 硬解普通 `.bat`。
- `library.json` 与 `config.json` 分离：前者每次运行都写，后者是低频手改。
- API Key 以 `dpapi:` 前缀的密文存在 `config.json`；读取接口只给 `hasKey`。加密绑定当前 Windows 用户，配置不可跨机器复制。界面只显示本地 Agent，API profiles 保留用于兼容/测试。
- 本地 Agent 默认启用：`claude -p --output-format text --tools "" --permission-prompts none`，提示词走 stdin；`--model` 映射模型，`--effort` 映射 low/medium/high/xhigh/max，超时默认 300s。API 模式由保存 API profiles 关闭。
- AI 请求与脚本运行各有一条状态与停止按钮，互不阻塞；单 job 槽位在任何 `await` 之前同步预留，并发 ask 只有一个 200、其余 409，不会产生无法停止的孤儿请求。
- AI 请求有 5 分钟上限；`/api/ai/state` 暴露正在运行的 job，页面刷新后可重新挂接。
- 保存/回写使用编号备份（`.bak`、`.bak.1`…），`copyFile(..., COPYFILE_EXCL)` 保证不覆盖旧备份，并返回真实的 `backupPath`。
- 回写保持源文件编码（GBK / UTF-16LE）；新文件按解释器默认编码写入。
- 保存目录不在扫描根目录时自动追加，保存后列表立即可见。
- 每次运行结束写入 `run-history.json`（最多 100 条，含参数/退出码/耗时）；`/api/state` 返回最近记录，界面可填入参数或再次运行。
- 每次 AI 请求结束写入 `ai-history.json`（最多 30 条）；单条文本上限 50 KB，超长标记 `truncated` 且不允许载入回写。记录只用于展示，不作为下一次请求的上下文。
- 首次运行（没有 `config.json`）默认扫描应用目录下的 `scripts\`：exe 版即 `release\scripts\`，开发版即仓库 `scripts\`。已有配置不会被重写。
- 每条 AI 配置带可选的推理强度：本地 Agent 映射为 `--effort`；API 兼容路径仍分别发 `reasoning_effort` / `reasoning.effort` / Anthropic thinking 预算。
- 保存新脚本与回写已有脚本都先写 `.bak`；扩展名按解释器补齐，文件名不允许路径分隔符。
- 诊断（「为什么报错」）附带该脚本最近一次运行的退出码与内存中的输出尾部。

## 已知限制

- 停止走 `taskkill /T /F`：被强杀的脚本没有有意义的退出码，只保证状态变成 `exited`。
- 「在终端里运行」会开真窗口，没有自动化断言，只有手点验证。
- 页面刷新靠 `state.running` 重新挂上正在跑的任务；输出从服务端缓存的行头重新拉（最多近 6000 行）。
- 关闭浏览器窗口不会停掉后台服务，需要手动结束 `node.exe`。
- 前端构建产物 `web/dist` 不入库：新克隆或改过前端后要先 `npm run build`。
- GBK 回写是规范化重编码：少数重复映射字符的字节可能不同但文本不变；GBK 无法表示的字符会让回写返回 400，原文件保持不动（备份已先生成）。
- 无 BOM 的 UTF-16 不自动识别；外部进程占用 `config.json` 时，写入仍可能因 `EPERM` 失败。
- `response.failed` 的错误文本仍是原始 JSON；`maxTokens` 目前只对 Anthropic 生效。
- 单文件 exe 由 Node SEA 生成，未签名（SmartScreen 可能提示），体积约 86 MB；构建时才需要 Node 24 与 `postject`。
- 本地 Agent 需要目标机安装并登录 Claude Code CLI；`--tools ""` 禁用工具，因此 agent 不会读写文件，只返回文本。
- exe 首次启动把内嵌前端解压到 `%TEMP%`；配置/库/日志默认在 exe 同目录，目录只读时回退到 `%LOCALAPPDATA%\ScriptManager`，默认 `scripts\` 也随之落在回退目录。
