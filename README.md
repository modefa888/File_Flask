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
├── run.py                  # 启动入口
├── file_manager.py         # 旧版单文件实现（已由 app/ 包重构替代，保留备份）
├── FileManager.spec        # PyInstaller 打包配置
├── requirements.txt
├── app/                    # 重构后的模块化应用
│   ├── __init__.py         # 应用工厂 create_app()：装配蓝图、请求日志、索引初始化
│   ├── config.py           # 集中配置：端口/认证/执行权限/安全规则/缓存路径/ffmpeg
│   ├── log.py              # JSON 日志 + 每日轮转
│   ├── routes/             # 16 个蓝图
│   │   ├── auth.py         # 登录认证
│   │   ├── pages.py        # 页面路由（/ /m /desktop /ide）
│   │   ├── browser.py      # 文件列表/预览/缩略图/流媒体/下载/收藏
│   │   ├── zip.py          # 压缩包（浏览/解压/创建/嵌套）
│   │   ├── delete.py       # 删除/回收站/撤销/历史
│   │   ├── fileops.py      # 文件操作
│   │   ├── index.py        # 索引搜索
│   │   ├── grep.py         # 内容搜索
│   │   ├── git.py          # Git 集成
│   │   ├── run.py          # 运行代码（F5）+ 日志流
│   │   ├── term.py         # 终端执行
│   │   ├── env.py          # 运行环境检测/安装
│   │   ├── port.py         # 端口管理
│   │   ├── shares.py       # 分享链接
│   │   ├── archive_history.py  # 压缩历史
│   │   └── progress_stream.py  # SSE 进度推送
│   ├── services/           # 业务服务
│   │   ├── filecore.py     # 文件核心逻辑
│   │   ├── thumbnail.py    # ffmpeg 缩略图（信号量限 3 并发）
│   │   ├── indexer.py / db.py  # 持久化索引 + SQLite
│   │   ├── trash.py        # 回收站
│   │   ├── safety.py       # 命令安全校验
│   │   ├── envprobe.py / envinstall.py  # 环境探测/安装
│   │   └── portinfo.py     # 端口信息
│   ├── templates/          # index / mobile / ide / login / markdown_view
│   └── static/             # 前端资源（含 vendor 本地化依赖）
├── data/                   # 运行时数据（已 gitignore）：缓存/索引/回收站/删除历史/收藏
└── logs/                   # JSON 日志（每日轮转）
```

## 技术要点

- **应用工厂 + 蓝图**：`create_app()` 统一装配 16 个蓝图，请求中间件记录每个 HTTP 请求的 JSON 日志（状态码、耗时）
- **threaded=True**：Flask 开发服务器多线程处理并发请求
- **三级缓存**：缩略图走 磁盘缓存 → 内存 LRU → 浏览器 HTTP 缓存；目录大小/列表缓存持久化在 `data/`
- **索引后台调度**：启动时加载索引元信息，每 30s 调度一次增量扫描，首次启动 2s 后自动全量建索引
- **安全设计**：
  - 系统关键目录（/etc /usr /boot 等）删除/改权限直接拦截
  - 危险命令正则拦截（关机、格式化、fork 炸弹、提权等）+ 高风险操作二次确认
  - 请求体上限 32MB；登录认证
- **打包**：PyInstaller 冻结运行时数据写到可执行文件旁的 `data/`、`logs/`，避免写入临时目录丢失

## 注意事项

- 服务默认监听 `0.0.0.0:5001`，**仅建议在本机 / 内网受信任环境使用**；若暴露公网，请修改 `app/config.py` 中的账号密码并设置 `ENABLE_EXEC = False` 关闭命令执行能力
- 视频缩略图依赖**系统完整版 ffmpeg**（IDE 自带的精简 ffmpeg 缺图片编码器会生成失败）
- `.gitignore` 已排除 `data/`、`logs/`、`build/`、`dist/`、`.venv/`
