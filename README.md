# File_Flask — Web 文件管理器 & 在线 IDE

基于 Flask 的本地/内网文件管理可视化工具：浏览器中管理任意目录，集文件浏览、预览、压缩包、回收站、全文搜索、Git、在线 IDE、终端执行于一体，支持 PyInstaller 打包为独立可执行文件。

## 快速开始

```bash
pip install -r requirements.txt   # Flask>=2.0, Pillow>=9.0
python run.py                     # 默认 http://localhost:5001，自动打开浏览器
python run.py --port 8000         # 指定端口
python run.py --no-browser        # 不自动打开浏览器
python run.py --debug             # 调试模式（代码改动自动重载）
```

默认账号：`admin / admin123`（见 `app/config.py`）

## 功能总览

### 文件管理
- **多视图浏览**：图标 / 树 / 列表三种视图，可自由切换任意目录（含系统盘），路径自动记忆
- **预览**：文本（20MB 内可编辑）、图片、视频（分块流式播放）、音频、Markdown
- **视频缩略图**：系统 ffmpeg 抽帧生成封面，磁盘缓存（`data/.file_manager_thumbs/`）+ LRU 内存缓存，3 并发限制
- **收藏夹**：收藏目录并支持分组管理，最近文件夹快捷访问
- **文件操作**：新建 / 重命名 / 移动 / 复制等（`fileops`）
- **回收站**：删除进入回收站，支持撤销恢复、删除历史记录
- **分享链接**：生成 `/share/<token>` 下载链接

### 压缩包
- 浏览 zip 内容、在线预览包内文件、解压、创建压缩包
- 支持**嵌套 zip** 逐层浏览
- 创建 / 解压均为后台任务，带实时进度条；保留压缩历史

### 搜索与索引
- **持久化索引**：SQLite 索引（`data/.file_manager_index.db`），后台定时扫描增量更新，支持文件名搜索
- **grep 内容搜索**：按正则在指定目录内搜索文件内容

### 开发者功能
- **在线 IDE**（`/ide`）：CodeMirror 编辑器，多标签、语法高亮
- **运行代码**（F5）：实时推送运行日志（SSE 流），30s 超时后自动转后台运行（Web 服务不被误杀），可配置 kill
- **终端**：在服务器上执行命令，内置危险命令拦截与二次确认规则（见 `app/config.py` 的 `EXEC_BLOCK_PATTERNS` / `EXEC_CONFIRM_PATTERNS`）
- **Git 集成**：status / diff / log / stage / commit / push / pull / remote / init / .gitignore 管理
- **运行环境面板**：探测系统 Python / Node 等运行时，支持一键安装到 `~/.local`（白名单方案，无需管理员）
- **端口管理**：查看端口占用并杀进程

### 其他
- 移动端适配页面（`/m`）
- JSON 结构化日志，每日轮转保留 15 天（`logs/app.log`），每次 HTTP 请求/响应均记录
- PyInstaller 打包支持（`FileManager.spec`，产物在 `dist/`）

## 目录结构

```
File_Flask/
├── run.py                        # 启动入口（默认自动开浏览器）
├── file_manager.py               # 旧版单文件实现（已由 app/ 包重构替代，保留备份）
├── FileManager.spec              # PyInstaller 打包配置
├── requirements.txt
├── app/                          # 重构后的模块化应用
│   ├── __init__.py               # create_app()：注册 20 个蓝图、中间件、索引初始化
│   ├── config.py                 # 集中配置（端口 / 认证 / 执行权限 / 安全规则 / 缓存路径）
│   ├── log.py                    # JSON 请求日志 + 每日轮转
│   ├── routes/                   # 业务蓝图（20 个，按功能分 3 层）
│   │   ├── progress_stream.py    # SSE 进度推送（扁平，跨模块共用）
│   │   ├── common/               # 文件管理核心（9 个）
│   │   │   ├── pages.py           # 首页与模板装配
│   │   │   ├── auth.py            # 登录认证
│   │   │   ├── browser.py         # 目录浏览 / 上传 / 下载 / 预览
│   │   │   ├── zip.py             # 打包 / 解压（zip / tar）
│   │   │   ├── delete.py          # 回收站：删除 / 恢复 / 永久删除
│   │   │   ├── fileops.py         # 重命名 / 移动 / 复制
│   │   │   ├── index.py           # SQLite FTS5 全文索引 + 后台扫描
│   │   │   ├── shares.py          # 分享链接
│   │   │   └── archive_history.py # 操作 / 归档历史
│   │   └── ide/                  # IDE / 运行 / 集成（10 个）
│   │   │   │   ├── grep.py            # 代码 grep 搜索
│   │   │   │   ├── git.py             # Git 集成
│   │   │   │   ├── term.py            # 终端执行（WebSocket）
│   │   │   │   ├── run.py             # 运行代码（前台 / 后台 / SSE 日志）
│   │   │   │   ├── port.py            # 端口占用查询 & 释放
│   │   │   │   ├── ai.py              # AI 助手（流式 SSE）
│   │   │   │   ├── agent.py           # Agent 智能体（多步工具调用）
│   │   │   │   ├── chat_history.py    # AI 对话历史（SQLite）
│   │   │   │   ├── pip.py             # pip 包管理
│   │   │   │   └── env.py             # IDE 环境探测 / 安装
│   ├── services/                 # 无状态 / 持久化工具
│   │   ├── common/               # 文件管理底层
│   │   │   ├── safety.py          # 路径越权检查（防 ../ 逃逸）
│   │   │   ├── filecore.py        # 文件 / 目录操作底层
│   │   │   ├── indexer.py         # 全文索引构建与查询
│   │   │   ├── thumbnail.py       # ffmpeg 缩略图（信号量限 3 并发）
│   │   │   ├── trash.py           # 回收站机制
│   │   │   ├── undo.py            # 撤销操作
│   │   │   ├── archive_history.py # 归档历史
│   │   │   ├── notifications.py   # 通知中心
│   │   │   └── db.py              # SQLite 通用封装
│   │   └── ide/                  # IDE 底层
│   │   │   │   ├── portinfo.py        # 端口占用查询（ss / /proc 双源）
│   │   │   │   ├── chatdb.py          # AI 对话历史 SQLite 存储
│   │   │   │   ├── envprobe.py        # IDE 环境探测
│   │   │   │   ├── envinstall.py      # IDE 环境安装
│   │   │   │   ├── web_search.py      # 联网搜索
│   │   │   │   └── agent/             # Agent 工具集（fs / shell / editor / browser）
│   ├── templates/                # 两套模板：桌面 (index/) + 移动端 (mobile/)
│   │   ├── base.html
│   │   ├── index/                 # 桌面端模板（含 ide/ 子目录）
│   │   ├── mobile/                # 移动端模板
│   │   └── markdown_view.html     # Markdown 预览页
│   └── static/                   # 前端资源（含 vendor 本地化依赖）
├── data/                         # 运行时数据（已 gitignore）：缓存 / 索引 / 回收站 / 任务注册表
├── logs/                         # JSON 日志（每日轮转）
└── demo/                         # 演示素材
```

## 运行模块 & 端口管理

按文件扩展名调用本机解释器运行代码，实时看输出。日志与任务注册表都持久化到磁盘，**关掉浏览器、甚至重启本服务，后台程序都照常在跑**。

| 能力 | 说明 |
|---|---|
| 🧰 支持的运行时 | `py` / `js` / `mjs` / `cjs` / `sh` / `bash` / `rb` / `php` / `pl` / `lua` / `r`（找不到解释器时给出可读错误） |
| ⏱ 前台 / 后台 | 前台默认 30s 超时（`RUN_TIMEOUT` 可调，上限 `RUN_TIMEOUT_MAX`）；超时后按 `RUN_TIMEOUT_ACTION` 自动转后台（推荐，Web 服务 / 常驻程序不会被打断）或直接 kill |
| 📡 实时日志 | SSE 长连接（`/api/run/stream`）首选，`/api/run/log` 轮询兜底；日志同时写入 `data/run_logs/<task-id>.log` |
| 💾 跨重启存活 | 任务注册表在 `data/storage/.file_runner_tasks.json`；服务重启后自动「重新接管」仍存活的进程，继续跟踪日志与结束事件 |
| 🛟 EADDRINUSE 提示 | 日志里检测到 "address already in use" 时自动补一条操作指引，避免「明明上次启动成功，这次却莫名其妙秒退」的困惑 |
| 🔌 端口占用面板 | `GET /api/port/list` 列出本机监听端口 + 占用进程（pid / 进程名 / 启动命令 / 工作目录）；`POST /api/port/kill` 强制释放。信息源 `ss` 优先、`/proc/net/tcp*` 回退，兼容精简系统 |

相关端点：`/api/run/runtimes`、`POST /api/run`（前台/后台）、`/api/run/stream`、`/api/run/log`、`/api/run/tasks`、`POST /api/run/stop`、`POST /api/run/remove`、`POST /api/run/prune`。

底层实现：`app/routes/ide/run.py`、`app/routes/ide/port.py`、`app/services/ide/portinfo.py`。

> ⚠️ 该接口会在服务器所在机器上执行代码，仅应在受信任的本地 / 内网环境中使用。

## 技术要点

- **应用工厂 + 蓝图**：`create_app()` 统一装配 20 个蓝图，请求中间件记录每个 HTTP 请求的 JSON 日志（状态码、耗时）
- **threaded=True**：Flask 开发服务器多线程处理并发请求
- **三级缓存**：缩略图走 磁盘缓存 → 内存 LRU → 浏览器 HTTP 缓存；目录大小/列表缓存持久化在 `data/`
- **索引后台调度**：启动时加载索引元信息，每 30s 调度一次增量扫描，首次启动 2s 后自动全量建索引
- **安全设计**：
  - 系统关键目录（/etc /usr /boot 等）删除/改权限直接拦截
  - 路径越权拦截（`services/common/safety.py`：防 `../` 逃逸）
  - 危险命令正则拦截（关机、格式化、fork 炸弹、提权等）+ 高风险操作二次确认
  - 请求体上限 32MB；登录认证
- **打包**：PyInstaller 冻结运行时数据写到可执行文件旁的 `data/`、`logs/`，避免写入临时目录丢失

## 注意事项

- 服务默认监听 `0.0.0.0:5001`，**仅建议在本机 / 内网受信任环境使用**；若暴露公网，请修改 `app/config.py` 中的账号密码并设置 `ENABLE_EXEC = False` 关闭命令执行能力
- 视频缩略图依赖**系统完整版 ffmpeg**（IDE 自带的精简 ffmpeg 缺图片编码器会生成失败）
- `.gitignore` 已排除 `data/`、`logs/`、`build/`、`dist/`、`.venv/`
