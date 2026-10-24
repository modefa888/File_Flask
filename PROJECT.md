# PROJECT.md — 项目结构与架构说明

> 本文档基于当前代码库（`app/__init__.py` 注册蓝图、`app/routes/`、`app/services/` 实际文件）梳理生成，用于快速了解工程结构、模块职责与关键数据流。当前实际注册 **23 个蓝图**（含 `ai`、`agent`、`chat_history`、`pip`），与 `README.md` 已同步。

---

## 1. 项目概览

- **名称**：File_Flask —— 基于 Flask 的 Web 文件管理器 + 在线 IDE
- **启动入口**：`run.py` → `app.create_app()`
- **技术栈**：Python 3 + Flask（≥2.0）+ Pillow（≥9.0）+ SQLite + ffmpeg（可选）
- **前端**：服务端渲染 + 内联 JS，模板位于 `app/templates/`，依赖走 `app/static/` 本地化 vendor
- **部署形态**：本地/内网 Web 服务，可用 PyInstaller 打包为独立可执行文件

### 运行方式

```bash
pip install -r requirements.txt
python run.py                    # 默认 http://localhost:5001，自动打开浏览器
python run.py --port 8000        # 指定端口
python run.py --no-browser       # 不自动打开浏览器
python run.py --debug            # 调试模式（代码热重载）
```

默认账号见 `app/config.py`。

---

## 2. 顶层目录

```
File_Flask/
├── run.py                # 启动入口（argparse、浏览器自动打开、Flask.run）
├── requirements.txt      # Flask>=2.0, Pillow>=9.0
├── FileManager.spec      # PyInstaller 打包配置
├── file_manager.py       # 旧版单文件实现（~365KB），保留作备份，已由 app/ 重构替代
├── README.md             # 面向用户的功能/使用说明
├── PROJECT.md            # 本文档：结构与架构
├── .trae/                # IDE 配置
├── .venv/                # 虚拟环境（已 gitignore）
├── build/  dist/         # PyInstaller 产物（已 gitignore）
├── data/                 # 运行时数据（缓存/索引/回收站/分享 token/AI 配置等，已 gitignore）
├── logs/                 # JSON 结构化日志，每日轮转保留 15 天（已 gitignore）
└── app/                  # 重构后的模块化应用
    ├── __init__.py       # 应用工厂 create_app()
    ├── config.py         # 集中配置（端口/账号/安全规则/缓存路径/ffmpeg…）
    ├── log.py            # JSON 日志 + 每日轮转
    ├── routes/           # 23 个蓝图（HTTP 层）
    ├── services/         # 11 个业务服务（无 HTTP 依赖）
    ├── templates/        # 5 个 Jinja 模板
    └── static/           # 前端资源 + vendor 本地化依赖
```

---

## 3. 应用启动流程（`app/__init__.py`）

`create_app()` 按顺序执行：

1. **构造 Flask 实例**：模板/静态目录从 `config` 取；写入 `SECRET_KEY / DEBUG / JSON_AS_ASCII / MAX_CONTENT_LENGTH=32MB`。
2. **`_register_blueprints(app)`**：一次性 `import` 并注册 23 个蓝图（顺序见下文第 4 节）。
3. **`_install_request_logging(app)`**：
   - `before_request` 记录 `g._start = monotonic()` 与 `method/path`。
   - `after_request` 输出 JSON 日志，字段包含 `method / path / status / latency_ms`。
4. **`_init_index_engine()`**：
   - `_init_index_db()` 建表。
   - `_load_index_meta()` 加载已有索引；若不存在则启动守护线程，延迟 2 秒后首次全量建索引。
   - `_schedule_index_scan(30)` 每 30 秒调度一次增量扫描。
   - 索引初始化异常仅 `warning`，**不阻断服务启动**。

`run.py` 中额外设置 `app.config["TEMPLATES_AUTO_RELOAD"] = True`，保证非 debug 模式下改模板即时生效；`threaded=True` 开启多线程并发。

---

## 4. 路由层：23 个蓝图

> 共 **23 个 Blueprint**（见 `app/__init__.py`）；与 `README.md` 已同步。

`app/routes/` 下每个模块暴露一个 `bp` 蓝图，均在 `create_app()` 中注册：

| # | 模块 | 蓝图名 | 主要职责 |
|---|------|--------|---------|
| 1 | `auth.py` | `auth` | 登录/登出/会话校验 |
| 2 | `pages.py` | `pages` | 页面路由：`/` `/m` `/desktop` `/ide` |
| 3 | `browser.py` | `browser` | 文件列表 / 预览 / 缩略图 / 流媒体 / 下载 / 收藏 |
| 4 | `zip.py` | `zip` | 压缩包：浏览、预览包内文件、解压、创建、嵌套 zip |
| 5 | `delete.py` | `delete` | 删除 / 回收站 / 撤销 / 删除历史 |
| 6 | `archive_history.py` | `archive_history` | 压缩历史列表 |
| 7 | `fileops.py` | `fileops` | 新建 / 重命名 / 移动 / 复制等 |
| 8 | `index.py` | `index` | 持久化索引的文件名搜索 |
| 9 | `progress_stream.py` | `progress_stream` | 通用 SSE 进度推送 |
| 10 | `grep.py` | `grep` | 正则内容搜索 |
| 11 | `git.py` | `git` | status / diff / log / stage / commit / push / pull / remote / init / .gitignore |
| 12 | `run.py` | `run` | 在线 IDE 的 F5 运行、日志流、超时后转后台；后台任务面板（`/api/run/tasks` 带 CPU/内存/端口，端口可点击新标签打开；操作按钮为彩色图标，另有「查看详细信息」悬浮卡片） |
| 13 | `port.py` | `port` | 端口占用查询 / 杀进程 |
| 14 | `term.py` | `term` | 服务器终端命令执行（含安全拦截与二次确认） |
| 15 | `env.py` | `env` | 运行环境探测 / 一键安装到 `~/.local` |
| 16 | `shares.py` | `shares` | `/share/<token>` 分享链接 |
| 17 | `ide/ai.py` | `ai` | AI 助手：多接口（OpenAI 兼容）配置、流式对话、按 git 改动生成提交信息 |
| 18 | `ide/agent.py` | `agent` | AI 智能体：模型自动读/写文件、搜索、执行命令，多轮直到任务完成 |
| 19 | `ide/chat_history.py` | `chat_history` | AI 对话历史持久化：会话/消息的增删查改（SQLite） |
| 20 | `ide/pip.py` | `pip` | IDE 内的 Python 包管理：安装 / 卸载 / 查询 |
| 21 | `ide/proc.py` | `proc` | 进程资源管理器：系统 CPU/内存/磁盘/网络占用、进程列表、结束进程、AI 资源诊断（`POST /api/proc/diagnose`） |
| 22 | `ide/cron.py` | `cron` | 定时任务（参考青龙面板）：cron 计划任务的增删改查、启停、立即运行、停止、执行记录与日志 |
| 23 | `ide/termai.py` | `termai` | 终端 AI 助手：自然语言 → 命令建议（含风险说明）、执行后流式解读输出 |
| 24 | `adm/update.py` | `update` | 在线更新：后台管理 SPA 模块（`/admin#update`），GitHub 检查更新、拉取代码、装依赖、重启；另支持初始化 Git 仓库、上传 ZIP 包覆盖更新、备份记录列表与一键回滚 |
| 25 | `ide/sshfile.py` | `sshfile` | SSH 远程文件管理（paramiko SFTP）：`/api/ssh/fs/*` 列目录 / 读写 / 建删改 / 上传 / 下载 / 缩略图；SFTP 客户端按连接缓存（15 分钟 TTL），复用 sshconn 的连接存储与凭据解密 |

### 4.1 AI 助手（`ide/ai.py`）

- 兼容所有 OpenAI 格式的服务（OpenAI / DeepSeek / Kimi / Qwen / SenseNova / Ollama / vLLM …）。
- 端点：
  - `GET/POST /api/ai/config` —— 读取/保存 `{providers, active, sys}`；key 只存服务端，GET 脱敏返回。
  - `POST /api/ai/chat` —— SSE 流式对话，`content` 支持字符串或 OpenAI 图片数组。
  - `POST /api/ai/commit-message` —— 依据仓库改动生成提交信息。
- 配置持久化在 `data/storage/.file_manager_ai.json`。
- 限制：图片 data URL 单张 9MB、单次最多 8 张图片部件；连接超时 15s、读取超时 300s。

### 4.2 AI 智能体（`ide/agent.py`）

- 端点：
  - `POST /api/ai/agent` `{repo, messages, perm, provider_id?, model?}` —— 启动**后台运行**，立即返回 `{run_id}`。
  - `GET /api/ai/agent/stream?run_id=&offset=` —— 连接该运行的 SSE：先回放已产生的事件，再实时续传（新任务用）。
  - `GET /api/ai/agent/events?run_id=&offset=` —— 按 offset 取事件（JSON，含 `next`/`done`），**刷新续接用轮询**（比长挂 SSE 稳）。
  - `GET /api/ai/agent/status?run_id=` —— 查询该运行是否还在。
  - `GET /api/ai/agent/for-session?sid=` —— 按会话 id 找最近一场运行（本地 run_id 丢失时兜底）。
  - `POST /api/ai/agent/stop` `{run_id}` —— 停止后台运行。
  - `POST /api/ai/agent/approve` `{run_id, call_id, allow, always}` —— 批准/拒绝待确认调用。
- **后台运行 / 断线续传**（`services/ide/agentrun.py`）：执行放在后台线程，事件缓冲在内存；
  页面刷新 / 断线不会中断任务，前端刷新后按 `run_id` 重连（`offset=0` 从头回放）即可看到实时进度。
  缓冲默认保留 6 小时 / 最多 50 场；`POST /api/ai/agent/stop` 会同时拒绝该运行挂起的确认，让阻塞中的调用立刻退出。
  普通对话（`POST /api/ai/chat`）传 `bg=1` 时同样走该后台通道（插件入口 `/api/ai/plugin` 保持直连流式）。
- **回复兜底落库**（`agentrun.save_reply()`）：运行结束时服务端会把这一轮回复（正文 / 步骤 /
  文件变更 / 任务清单）直接写进会话历史，`mid` 固定为 `"m"+run_id`（前端用同一个 mid 保存 → 覆盖更新，不会重复）。
  因此即使前端没能重连、或用户直接关掉页面，下一次打开会话也能看到结果。
  前端若丢失了 `run_id`，可用 `GET /api/ai/agent/for-session?sid=` 按会话 id 找回运行。
- **中断来源必须区分**：前端用 `AI._userStop`（只有点「停止」/切换/新建会话才置位）与
  `pagehide/beforeunload` 区分「用户主动停止」和「刷新/关闭页面」。刷新导致的事件流中断
  **不能**写成「已停止/出错了」的回复，也**不能**清掉 `pendingTurn` 续连标记 —— 否则刷新后就再也接不上。
  只有任务真正结束（正常收尾 / 用户停止 / 明确报错）才清标记。等待确认（`ask`）时刷新，
  重连回放会重建确认卡片，服务端挂起状态仍在 `_PENDING`，点允许/拒绝照常生效（超时 600s）。
- 内置工具：`list_dir / read_file / write_file / edit_file / search_files / run_command`，
  以及可开关的 `web_search / generate_image / code_intel / delegate_task / todo_write`。
- 任务清单：`todo_write` 工具让模型把多步任务拆成待办清单（`pending / in_progress / completed`），
  每次调用 SSE 推送 `{"type":"todos","todos":[...]}`；前端把清单渲染成「悬浮固定在消息区底部」的
  可折叠面板（`#aiTodoFloat`，绝对定位在 `#aiMsgs` 外层容器上，不随消息滚动，并自动给消息区补底部留白），
  不再内嵌在消息里。清单随回复存入会话历史（`meta.todos`），刷新/切换会话后取最后一份回放。
  运行中「进行中」的项转圈；会话停止 / 完成 / 异常结束后自动切到「已暂停」（换成暂停图标、停止转圈、
  状态行琥珀色），点「停止」按钮即时暂停。可在 设置 → 对话 → 任务清单 关闭。
  兜底：多步任务若模型迟迟不建清单，主循环会在最近的工具结果末尾注入一次「系统提醒」（每 3 轮最多一次），
  促使它调用 `todo_write`，避免小模型漏建导致面板不显示。
- 权限三档（与前端一致）：
  - `readonly` —— 只读；写入与执行一律拒绝。
  - `workspace` —— 读任意；写只能落在项目根内；执行命令逐条确认。
  - `full` —— 读写任意；执行命令不再确认（危险命令仍被 `services/safety.py` 拦截）。
- 关键防护：`_MAX_ROUNDS=12` 防死循环；单个工具结果回填模型上限 20000 字符；`read_file` 返回 4 万字符；搜索最多扫 4000 文件、返回 60 命中；命令 `timeout` 1–300s，超时 `SIGTERM → SIGKILL` 杀进程组。

### 4.3 AI 对话历史（`ide/chat_history.py` + `services/ide/chatdb.py`）

- 端点：`/api/ai/chat/*`（列表、详情、新增、删除等，按 `user_id` 隔离）。
- 存储：`data/.file_manager_ai_chat.db`（SQLite，`conversations` + `messages` 双表）。
- 消息中的图片以 `dataURL` 形式完整保存（`images` 字段为 JSON 数组），保证多端回放一致。

### 4.4 定时任务（`ide/cron.py` + `services/ide/cron*.py`）

- 端点：`/api/cron/tasks`（列表，带下次运行时间与运行中状态）、`/api/cron/save`（新建/更新）、
  `/api/cron/delete`、`/api/cron/toggle`（启停）、`/api/cron/run`（立即运行）、`/api/cron/stop`、
  `/api/cron/runs`（执行记录）、`/api/cron/log`（日志增量）、`/api/cron/clear-runs`、`/api/cron/validate`、
  `/api/cron/suggest`（按文件推断命令/名称/工作目录，供「从文件新建」预填）。
- 入口：活动栏「定时任务」图标；文件树右键「添加定时任务…」会按文件类型（复用 `run._RUNNERS` /
  `_project_runtime`，例如 .py 自动用项目 `.venv/bin/python`）预填命令与工作目录后弹出新建悬浮框；
  任务名称默认取当前项目文件夹名（`ROOT` 目录名）。
- 存储：`store.db` 的 `cron_tasks` + `cron_runs` 两张表（`services/ide/crondb.py`）。
- 表达式：标准 5 段式（分 时 日 月 周），支持 `*`、区间、列表、步长与 `@daily` 等宏；
  日 / 周同时限定时按标准 cron 取「或」（`services/ide/cronutil.py`）。
- 调度执行：`services/ide/cronsvc.py` 起一个守护线程，每 5s 扫一次，命中且该分钟未触发过就执行；
  同一任务不并发；执行前统一走 `safety.check_command` 拦截危险命令；
  日志落盘 `data/cron_logs/<task_id>/<run_id>.log`，前端按 offset 轮询增量读取；
  每个任务保留最近 50 条记录，超出的连同日志一起清理；支持超时自动终止与手动停止。
- 前端：活动栏「定时任务」图标 + 侧栏面板（`js/36_定时任务…js`、`css/36_定时任务.css`），
  含任务卡片（启停开关 / 立即运行 / 执行记录 / 编辑 / 删除）、浮层任务编辑器（含 cron 预设与实时校验）、
  执行记录 + 日志查看浮层。
- 编辑区大页：侧栏「打开管理面板」→ 以标签页形式打开完整管理视图（虚拟路径 `\u0000cron`，可与会话一起恢复），
  含统计概览（总数/已启用/运行中/成功/失败）、搜索 + 状态筛选、批量启用/停用/运行/删除、
  任务表格（名称/计划+下次运行/状态/命令/上次运行/操作）、右侧详情（任务信息 + 执行记录 + 实时日志）。

### 4.5 pip 包管理（`ide/pip.py`）

- 供 IDE 侧边栏调用，支持安装 / 卸载 / 查询 Python 包，可指定虚拟环境。

### 4.6 终端 AI 助手（`ide/termai.py`）

- 交互参考腾讯云 OrcaTerm 的 AI Agent：终端里直接说人话（「查看当前ip」）→ 出「意图 + 风险等级 +
  推荐命令 + 说明」卡片 → 点执行 → 输出流式解读。
- 端点：
  - `GET /api/term/ai/status` —— 是否可用（未配置接口 / 已在「设置 → 系统 AI」停用）。
  - `POST /api/term/ai/plan` `{input, cwd, history?}` —— 非流式，返回
    `{intent, risk(low|medium|high), reason, command, explain, alternatives, blocked, need_confirm, note}`。
  - `POST /api/term/ai/analyze` `{question, command, stdout, stderr, exit_code, cwd, context?}` ——
    SSE 流式解读（`data: {"delta"}` … `data: [DONE]`）。
  - `POST /api/term/ai/session` `{transcript, host?, env?, question?}` —— 整场会话复盘（SSE）。
    AI 浮层的「分析本次会话」把 SSH 终端 xterm 缓冲区（scrollback + 当前屏）里的全部命令与
    系统回显一次性上传；服务端先压缩（保留所有命令行、报错 / 警告行、开头与结尾，中间标注
    `…（省略 N 行）…`，预算 18000 字符）再交给模型，输出「会话概览 / 执行的命令 / 发现的问题 /
    风险提示 / 建议下一步」。前端回读见 `38_…js` 的 `sshTranscript()`。
  - `GET /api/term/ai/history?host=&limit=` / `POST /api/term/ai/history` /
    `DELETE /api/term/ai/history?id=|?host=|?all=1` —— 历史记录的查 / 存 / 删。
- **本模块只建议 / 解读、不执行命令**：执行仍走 `/api/term/exec`，因此拦截与二次确认只有一条路径，
  `check_command` 的结论（blocked / confirm）会提前并入返回体，卡片上直接显示「已拦截 / 需确认」。
- 模型必须输出 JSON；解析失败时退化为「只给说明、不给命令」（能从代码围栏里捞出命令才用），
  避免脏文本变成可执行命令。
- 使用「设置 → 系统 AI」中名为 `term` 的模块（可单独停用 / 单独指定模型），调用次数计入 AI 统计。
- 页面响应统一加 `Cache-Control: no-store`（`app/__init__.py::_after_request`），模板 / 内联脚本改动普通刷新即可生效；
  SSH 终端标签不参与通用会话恢复，「终端连接」侧栏也不再在刷新后自动展开；从往返缓存恢复时会清掉悬浮框与已断开的 SSH 终端。
  侧栏连接项的「播放 / 停止」按钮由 `tab.sshSid` + `SESS[sid].alive` 决定，只在该项被打开时常显
  （其余编辑 / 复制 / 删除仍悬停才出现）；建立会话后必须再渲染一次侧栏，否则按钮会停在「播放」。
  SSH 自己按 `localStorage["ide.session.sshTabs"]` 恢复成「未连接」的占位标签（不自动建连），
  恢复后若编辑区没有任何激活标签就自动激活第一个 —— 否则 `.cm-host` 一直是 `display:none`，
  表现为「标签栏在、下面一片空白」。
- 图标：面板与 SSH 入口的图标全部用内联 SVG（`taiIco` / `TAI_SVG`），不依赖 bootstrap-icons 字体，
  避免字体未加载 / 版本较旧 / 被缓存时显示成方框；「清空历史」用项目自带的贴按钮悬浮确认框 `uiConfirmPop`。
- 历史记录：落 `store.db` 的 `term_ai_history` 表（`ts / host / question / command / risk / ok / exit_code`），
  每次执行结束（成功或失败）由前端 `POST` 一条；表内最多保留 2000 条，界面按时间倒序显示最近 50 条。
  浮层右上角时钟图标展开列表：点条目把需求回填到输入框、「填入」把命令打到终端输入行（不执行）、
  可单条删除或一键清空。`host` 为空串表示本机内置终端，远程终端存 `user@host`。
- 前端：`js/44_终端AI助手…js` + `css/42_终端AI助手.css`。两处终端都接入了：
  - 底部内置终端：输入框左侧「AI」开关开启后所有输入交给 AI（命令前加 `!` 可强制直接执行），
    关闭时按「首个词是否为中文 / 是否以 `?` 开头」自动识别；
  - SSH 远程终端（`js/38_…js`）：右上角「AI」按钮打开**可拖动的浮动面板**；`Ctrl+Shift+I` 开关面板，
    按住标题栏拖动、双击标题栏回到右下角默认位置（位置记在 localStorage `ide.ai.popPos`）。
    Shell 模式下直接输入中文回车，会先用 `Ctrl+U` 撤掉远端那一行再打开面板并带上这句话
    （判定偏保守，避开 REPL / 密码提示）。
    命令经 `/api/ssh/input` 发到远端，按「1.8s 无新输出」判定结束并回读输出做解读。
  - 一键分析本次会话：SSH 的 AI 浮层左下「分析本次会话」按钮 —— 从 xterm 缓冲区取整场
    会话（命令 + 回显），POST 到 `/api/term/ai/session` 流式输出复盘卡片（复用
    `taiAnalyzeCard`，只换端点 / 标题）。输入框里已写的问题会作为「用户关注点」一并带上；
    生成期间按钮置灰，停止 / 结束自动恢复。
    登录后服务器自动喷的欢迎信息（MOTD / 系统信息 / 可升级包 / Last login）不计入分析：
    `markSessionBody()` 在 MOTD 结束（提示符出现或停顿 5 秒）时用 `term.registerMarker(0)`
    锚住提示符行，`sshTranscript()` 从 `bodyMark.line` 开始回读；marker 随 buffer 滚动
    自动前移，被 scrollback 挤出（`isDisposed`）说明欢迎信息早已滚掉，直接从 0 读。

---

## 5. 服务层：`app/services/`

| 模块 | 职责 |
|------|------|
| `filecore.py` | 文件核心逻辑（列表、预览、大小、路径处理等） |
| `thumbnail.py` | 基于系统 ffmpeg 的视频缩略图；信号量限 3 并发；磁盘缓存 + 内存 LRU |
| `indexer.py` | 持久化索引的增量扫描、调度器、文件名搜索 |
| `db.py` | SQLite 连接与建表（`data/.file_manager_index.db`） |
| `trash.py` | 回收站（删除入站 / 恢复 / 清空 / 历史） |
| `safety.py` | 命令安全校验：`check_command()` 返回 `blocked / confirm / ok` |
| `envprobe.py` | 探测系统 Python / Node 等运行时 |
| `envinstall.py` | 白名单式一键安装运行时到 `~/.local`，无需管理员 |
| `portinfo.py` | 端口占用查询 |
| `services/ide/procinfo.py` | 进程资源管理器采集：后台采样线程（2 秒）出快照，系统/分组占用、进程列表、按 pid 结束进程 |
| `services/ide/procdiag.py` | AI 资源诊断专用逻辑：采集诊断快照、筛可安全结束的候选进程、组织提问、清洗模型结论（服务端是唯一真源） |
| `services/ide/chatdb.py` | AI 对话历史 SQLite 存储层（`conversations` + `messages` 双表，按 `user_id` 隔离） |
| `services/ide/agentrun.py` | AI 后台运行管理：把 Agent / 对话执行从 HTTP 请求解耦，事件入内存缓冲，支持刷新后按 run_id 重连（回放 + 实时续传） |
| `services/ide/agent/` | Agent 智能体的工具实现与权限门控 |
| `services/adm/updater.py` | 在线更新：GitHub 检查（API / git 双通道）、fetch + 合并、更新前代码备份、依赖安装、四种重启方式；含 Git 仓库初始化与 ZIP 包覆盖更新 |
| `services/ide/cronutil.py` | cron 表达式解析 / 匹配 / 推算下次运行时间 |
| `services/ide/crondb.py` | 定时任务与执行历史的 SQLite 存储层 |
| `services/ide/cronsvc.py` | 定时任务调度线程 + 执行器（日志落盘 / 超时 / 停止 / 清理） |
| `archive_history.py` | 压缩历史持久化 |

---

## 6. 模板与前端

`app/templates/`：

- `index/index.html` —— 桌面端主界面入口，只做 include 拼接；正文在 `index/partials/body.html`，
  逻辑与样式按模块拆在 `index/js/*.js`、`index/css/*.css`（文件浏览、预览、上传、AI 助手等）
  - `index/js/52_拖拽上传.js` + `index/css/13_拖拽上传.css`：把本地**文件或文件夹**拖进文件列表
    （`.file-table`）→ 只加入「上传列表」对话框（文件名 / 大小 / 上传状态 / 操作，可逐个移除、
    可再点「上传文件 / 上传文件夹」追加），点 **开始上传** 才真正写入。拖拽提示遮罩全程
    `pointer-events:none`，否则卡片压住鼠标会反复 dragenter/dragleave 导致提示框抖动。
    文件夹用 `webkitGetAsEntry` 递归展开（`readEntries` 必须循环读到空，否则大文件夹漏文件），
    按原目录结构上传；成功后用 `localAddItem` 本地插入顶层条目（不整目录重载）。
    **断点续传（分片上传）**：每个文件按 4MB 切片，上传前先查 `/api/files/upload_status`
    拿到「已接收分片」，只传缺失分片，最后 `/api/files/upload_merge` 合并；中途失败 / 刷新页面后
    重新「开始上传」都从断点继续，已传分片不重传。分片按 `(相对路径|大小|修改时间)` 的 sha1
    落到 `.upload_tmp/<hash>/<index>`，临时目录 3 天后由 `/api/files/upload_chunk` 偶发清理，
    合并成功后立即删除。并发 3 文件、每片失败重试 3 次；单文件 >25MB 标红跳过，同名文件自动 `-1/-2`。
    IDE 的普通上传仍走老的 `POST /api/files/upload`（一次性，不带分片）。
    上传前先 `POST /api/files/upload_check` 做同名检测，命中则在对话框内弹出「文件冲突确认」
    （列出 本地大小 → 线上大小），选「覆盖」则 merge 带 `overwrite=1` 直接覆盖，选「跳过」则
    这些文件标灰跳过、其余照常传。对话框顶部还有一条统计信息：空闲显示 上传大小 / 共耗时 /
    平均上传速度 / 成功数，上传中显示 总进度 / 正在上传(x/y) / 实时速度 / 已用时 / 预计剩余
    （上传期间由 400ms 定时器刷新，不依赖分片回调）。统计在添加文件 / 重开对话框时保留，
    只有「开始上传」和「清空列表」才重置。
    每次 merge 的结果（文件名 / 大小 / 目标目录 / 耗时 / 状态 / 上传者）写入 store.db 的
    `upload_history` 表（最近 3000 条），文件管理顶栏「上传记录」按钮打开右侧抽屉查看
    （`53_上传记录面板.js` + `14_上传记录面板.css`，支持拖动左边缘调宽、双击复位、搜索、
    状态筛选、分页、自定义二次确认框清空）；点记录行会让左侧文件管理跳到文件所在目录并高亮，
    抽屉保持打开，跳转后确认文件已不在原位置则该行标为「已删除」（回写 `upload_history.missing`，
    接口 `POST /api/files/upload_records/missing`），文件又出现时自动取消标记；分片中断等
    走不到 merge 的失败由前端 `POST /api/files/upload_record_fail` 补记。
  - 删除（文件 / 文件夹）：右键菜单「删除」「删除文件夹」都走后台任务
    `POST /api/delete/start`（`22_删除.js` + `08_后台任务系统…js`），弹窗显示进度条 +
    已删文件数 + 当前文件 + 字节数，删除任务额外显示「实时删除进度表」（最近搬进回收站的
    条目，最新在上，`15_删除进度表.css`）；目录删除在文件数 ≤20000 时逐文件 move 以便上报
    进度，更大目录整体 rename 秒移。`delete.py` 的进度快照带 `recent` 字段，SSE
    `/api/progress/stream` 与 `/api/delete/progress` 同步返回。
- `mobile.html`（≈306KB）—— 移动端 `/m`
- `ide.html`（≈517KB）—— 独立在线 IDE `/ide`
- `login.html` —— 登录页
- `markdown_view.html` —— Markdown 渲染页面

前端资源、CodeMirror、图标库等放在 `app/static/`，依赖已本地化到 `static/vendor/`，运行时无需外网。

---

## 7. 关键数据流

### 7.1 请求 → 响应（含日志）

```
Client ─HTTP─▶ Flask.before_request (记录 start)
            ─▶ Blueprint 路由 → service 层
            ─▶ Flask.after_request (写 JSON 日志：method/path/status/latency_ms)
Client ◀─响应─
```

### 7.2 文件搜索（双通道）

- **文件名搜索**：`routes/index.py` → `services/indexer.py` → SQLite（后台每 30s 增量扫描）。
- **内容搜索**：`routes/grep.py` → 正则遍历目录 → 直接返回命中行。
- AI Agent 的 `search_files` 工具走独立实现，跳过 `.git / node_modules / __pycache__ / .venv / dist / build / logs` 等目录，单文件 >2MB 跳过。

### 7.3 缩略图三级缓存

浏览器 HTTP 缓存 → 内存 LRU → 磁盘 `data/.file_manager_thumbs/`；ffmpeg 信号量并发 ≤ 3。

### 7.4 运行代码（IDE 的 F5）

`routes/run.py` 起子进程 → SSE 推送 stdout/stderr → 30s 超时自动转后台；可配置 kill。Web 服务本身不会被误杀。

### 7.5 AI Agent 循环

```
用户消息 → 模型（SSE 流）→ 若返回 tool_call：
    _gate() 权限/安全校验
        ├─ blocked → 直接返回拒绝
        ├─ need_ask → 挂起 Event，推送 SSE {"type":"ask"}，等待 /approve
        └─ allowed → 执行工具 → 结果回填 → 回到模型
无工具调用即结束，最后推送 {"type":"done"}
```

**后台运行**：`POST /api/ai/agent` 只启动后台线程并返回 `{run_id}`；线程把每步事件写入
`agentrun` 的内存缓冲。前端连 `GET /api/ai/agent/stream` 消费；刷新 / 断线后按同一
`run_id` 重连即先回放缓冲、再实时续传 —— 因此「刷新页面任务仍在后台跑，刷新后能看到实时进度」。
浏览器不会因为刷新而终止后台任务；只有点「停止」（`/api/ai/agent/stop`）才会取消。

---

## 8. 配置与安全

`app/config.py` 集中管理：

- **服务**：`HOST / PORT / DEBUG / SECRET_KEY`
- **凭据加密盐**：`SECRET_SALT`（Git Token / AI API Key / SMTP 授权码 / Telegram Bot Token
  落库前用它派生加密密钥；留空则回退到 `data/.file_manager_secret_key` 本地随机密钥。
  换盐会导致已存凭据无法解密，需在界面上重新填写）
- **导出文件的默认口令**：`EXPORT_PASSWORD`（API 调试「导出请求」用口令加密关键字段；
  导出弹窗留空即用它加密、本机导入免输口令，手填口令的文件则必须用同一口令导入。
  留空回退 `SECRET_SALT`，两者都空时导出必须手填。默认口令的钥匙在本机 `.env` 里，
  防的是文件被转发出去，不是防本机）
- **传输加密**：IDE 页面渲染时注入 RSA 公钥（密钥对见 `data/.file_manager_transport_key.pem`），
  前端用纯 JS RSA-OAEP 加密后提交（`tp1:` 前缀），后端解密再按存储密钥加密落库；
  未安装 `cryptography` 时自动降级为明文传输，功能不受影响
- **默认路径**：`DEFAULT_START_PATH`（首次启动默认起始目录）
- **认证**：默认 `admin / admin123`
- **执行权限**：`ENABLE_EXEC`（关闭后 `term` 与 Agent 的 `run_command` 都禁用）
- **危险命令**：`EXEC_BLOCK_PATTERNS`（直接拦截，如关机、格式化、fork 炸弹、提权）
- **高风险命令**：`EXEC_CONFIRM_PATTERNS`（二次确认）
- **系统关键目录**：`/etc` `/usr` `/boot` 等，删除/改权限直接拒绝
- **请求体上限**：32MB（`MAX_CONTENT_LENGTH`）
- **缓存/索引/日志路径**：均指向 `data/`、`logs/`

`services/safety.py::check_command()` 是所有命令执行（终端、Agent、AI 相关）的统一入口。

---

## 9. 打包

- `FileManager.spec`：PyInstaller 配置，产物输出到 `dist/`。
- 冻结运行时，`data/`、`logs/` 写到**可执行文件同目录**，避免写入临时目录后丢失（缓存、索引、回收站等状态需要持久）。

---

## 10. 使用注意

1. 服务默认监听 `0.0.0.0`，**仅建议本机 / 内网受信任环境**使用；如暴露公网请：
   - 修改 `config.py` 中的账号密码；
   - 设置 `ENABLE_EXEC = False` 关闭命令执行；
   - 置于反向代理 + HTTPS 之后。
2. 视频缩略图依赖**系统完整版 ffmpeg**，IDE 自带的精简 ffmpeg 缺图片编码器会失败。
3. `.gitignore` 已排除 `data/ logs/ build/ dist/ .venv/ __pycache__/`，但请自行确认密钥、AI 配置（`data/storage/.file_manager_ai.json` 内含 API Key）不会被误提交。
4. 修改 `templates/*.html` 后无需重启：`TEMPLATES_AUTO_RELOAD=True` 已启用。
5. `file_manager.py` 是旧版单文件实现，**当前运行时不再使用**，仅为备份保留。

---

## 11. 常见维护入口速查

| 想改什么 | 去这里 |
|---------|--------|
| 端口 / 账号 / 危险命令规则 | `app/config.py` |
| 加一个 HTTP 端点 | `app/routes/xxx.py` 新建蓝图，并在 `app/__init__.py::_register_blueprints` 注册 |
| 加业务逻辑（不依赖 HTTP） | `app/services/xxx.py` |
| 加日志字段 | `app/log.py` + `app/__init__.py::_install_request_logging` |
| 前端界面 | `app/templates/index.html`（桌面）/ `mobile.html`（手机）/ `ide.html`（IDE） |
| AI 对话历史结构 | `app/services/ide/chatdb.py` + `app/routes/ide/chat_history.py` |
| pip 安装 / 环境探测 | `app/routes/ide/pip.py` + `services/ide/envprobe.py`、`envinstall.py` |
| 定时任务（cron） | `app/routes/ide/cron.py` + `services/ide/cronutil.py`、`crondb.py`、`cronsvc.py`；前端 `js/36_定时任务…js` + `css/36_定时任务.css` |
| 终端 AI 助手（自然语言转命令 / 输出解读） | `app/routes/ide/termai.py`；前端 `js/44_终端AI助手…js` + `css/42_终端AI助手.css`（浅色配色在 `css/29_浅色主题.css` 末尾） |
| 在线更新（检查 / 拉取 / 重启） | `app/routes/adm/update.py` + `services/adm/updater.py` + `templates/adm/js/17_在线更新.js`（配置存 store_meta 的 `update_cfg`） |
| 打包脚本 | `FileManager.spec` |
| 启动参数 | `run.py` 的 `argparse` |
