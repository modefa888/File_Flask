# PROJECT.md — 项目结构与架构说明

> 本文档基于当前代码库（`app/__init__.py` 注册蓝图、`app/routes/`、`app/services/` 实际文件）梳理生成，用于快速了解工程结构、模块职责与关键数据流。当前实际注册 **20 个蓝图**（含 `ai`、`agent`、`chat_history`、`pip`），与 `README.md` 已同步。

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
    ├── routes/           # 20 个蓝图（HTTP 层）
    ├── services/         # 11 个业务服务（无 HTTP 依赖）
    ├── templates/        # 5 个 Jinja 模板
    └── static/           # 前端资源 + vendor 本地化依赖
```

---

## 3. 应用启动流程（`app/__init__.py`）

`create_app()` 按顺序执行：

1. **构造 Flask 实例**：模板/静态目录从 `config` 取；写入 `SECRET_KEY / DEBUG / JSON_AS_ASCII / MAX_CONTENT_LENGTH=32MB`。
2. **`_register_blueprints(app)`**：一次性 `import` 并注册 20 个蓝图（顺序见下文第 4 节）。
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

## 4. 路由层：20 个蓝图

> 共 **20 个 Blueprint**（见 `app/__init__.py`）；与 `README.md` 已同步。

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
| 12 | `run.py` | `run` | 在线 IDE 的 F5 运行、日志流、超时后转后台 |
| 13 | `port.py` | `port` | 端口占用查询 / 杀进程 |
| 14 | `term.py` | `term` | 服务器终端命令执行（含安全拦截与二次确认） |
| 15 | `env.py` | `env` | 运行环境探测 / 一键安装到 `~/.local` |
| 16 | `shares.py` | `shares` | `/share/<token>` 分享链接 |
| 17 | `ide/ai.py` | `ai` | AI 助手：多接口（OpenAI 兼容）配置、流式对话、按 git 改动生成提交信息 |
| 18 | `ide/agent.py` | `agent` | AI 智能体：模型自动读/写文件、搜索、执行命令，多轮直到任务完成 |
| 19 | `ide/chat_history.py` | `chat_history` | AI 对话历史持久化：会话/消息的增删查改（SQLite） |
| 20 | `ide/pip.py` | `pip` | IDE 内的 Python 包管理：安装 / 卸载 / 查询 |
| 21 | `ide/proc.py` | `proc` | 进程资源管理器：系统 CPU/内存/磁盘/网络占用、进程列表、结束进程、AI 资源诊断（`POST /api/proc/diagnose`） |

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
  - `POST /api/ai/agent` `{repo, messages, perm, provider_id?, model?}` —— SSE 流式。
  - `POST /api/ai/agent/approve` `{run_id, call_id, allow, always}` —— 批准/拒绝待确认调用。
- 内置工具：`list_dir / read_file / write_file / edit_file / search_files / run_command`，
  以及可开关的 `web_search / generate_image / code_intel / delegate_task / todo_write`。
- 任务清单：`todo_write` 工具让模型把多步任务拆成待办清单（`pending / in_progress / completed`），
  每次调用 SSE 推送 `{"type":"todos","todos":[...]}`，前端在消息下方渲染可折叠的「任务列表」进度面板；
  清单随回复存入会话历史（`meta.todos`），刷新后仍可回放。可在 设置 → 对话 → 任务清单 关闭。
- 权限三档（与前端一致）：
  - `readonly` —— 只读；写入与执行一律拒绝。
  - `workspace` —— 读任意；写只能落在项目根内；执行命令逐条确认。
  - `full` —— 读写任意；执行命令不再确认（危险命令仍被 `services/safety.py` 拦截）。
- 关键防护：`_MAX_ROUNDS=12` 防死循环；单个工具结果回填模型上限 20000 字符；`read_file` 返回 4 万字符；搜索最多扫 4000 文件、返回 60 命中；命令 `timeout` 1–300s，超时 `SIGTERM → SIGKILL` 杀进程组。

### 4.3 AI 对话历史（`ide/chat_history.py` + `services/ide/chatdb.py`）

- 端点：`/api/ai/chat/*`（列表、详情、新增、删除等，按 `user_id` 隔离）。
- 存储：`data/.file_manager_ai_chat.db`（SQLite，`conversations` + `messages` 双表）。
- 消息中的图片以 `dataURL` 形式完整保存（`images` 字段为 JSON 数组），保证多端回放一致。

### 4.4 pip 包管理（`ide/pip.py`）

- 供 IDE 侧边栏调用，支持安装 / 卸载 / 查询 Python 包，可指定虚拟环境。

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
| `services/ide/agent/` | Agent 智能体的工具实现与权限门控 |
| `archive_history.py` | 压缩历史持久化 |

---

## 6. 模板与前端

`app/templates/`：

- `index.html`（≈411KB）—— 桌面端主界面：文件浏览、预览、IDE、Git、AI 助手、Agent 等所有功能前端
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
最多 12 轮，最后推送 {"type":"done"}
```

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
| 打包脚本 | `FileManager.spec` |
| 启动参数 | `run.py` 的 `argparse` |
