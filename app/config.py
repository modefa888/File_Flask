"""集中式配置模块：路径、常量、Flask 应用配置。"""
import os
import shutil
import sys

# ===== 从 .env 加载环境变量（账号密码等系统参数集中存放于项目根 .env）=====
# load_dotenv() 无参会从 dotenv 包目录向上查找，找不到项目根，故显式指定路径。
try:
    from dotenv import load_dotenv
    _PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))
except Exception:
    # 未安装 python-dotenv 时退化为纯环境变量，不影响既有运行
    pass

def _env_str(name, default):
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v

def _env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

def _env_bool(name, default):
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1","true","yes","on","y")

# 是否以冻结的可执行文件运行（PyInstaller 打包后为 True）
_IS_FROZEN = bool(getattr(sys, "frozen", False))

# Flask 应用目录 / 静态 / 模板
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_FOLDER = os.path.join(BASE_DIR, "templates")
STATIC_FOLDER = os.path.join(BASE_DIR, "static")

# Flask 配置
SECRET_KEY = _env_str("SECRET_KEY", "change-me-in-production")
DEBUG = _env_bool("DEBUG", False)
HOST = _env_str("HOST", "0.0.0.0")
PORT = _env_int("PORT", 5001)

# 默认起始路径
_DEFAULT_START = os.path.sep if os.name != "nt" else os.environ.get("SystemDrive", "C:") + "\\"
DEFAULT_START_PATH = _env_str("DEFAULT_START_PATH", _DEFAULT_START)

# ===== 执行权限（IDE 的“运行”与“终端”会在服务器上执行命令）=====
# 仅在本机 / 内网受信任环境使用；若服务要暴露到公网，请改为 False 关闭执行能力。
ENABLE_EXEC = _env_bool("ENABLE_EXEC", True)
# 终端命令安全校验：True=拦截危险命令（可在此调整规则），False=不校验（有风险）
EXEC_ENFORCE_SAFETY = _env_bool("EXEC_ENFORCE_SAFETY", True)
# 「运行环境」面板的一键安装：True=允许通过内置白名单方案下载官方包安装到 ~/.local（无需管理员）
# 关闭后，面板仍会显示安装方案与系统包命令，但不会自动下载执行。
ENABLE_AUTO_INSTALL = _env_bool("ENABLE_AUTO_INSTALL", True)

# ===== 「运行当前文件」(F5) 的超时设置 =====
# 前台运行会实时推送日志。超过下面的秒数后按 RUN_TIMEOUT_ACTION 处理：
#   "background" —— 进程仍在运行（多为 Web 服务 / 常驻程序）时自动转为后台运行，
#                   不再计时，不会把刚启动好、能正常访问的服务杀掉（推荐，默认）；
#   "kill"       —— 直接终止整个进程组（适合避免写飞的脚本一直占着资源）。
# 想彻底不超时，直接用 Ctrl+F5「后台运行（服务模式）」。
RUN_TIMEOUT = _env_int("RUN_TIMEOUT", 30)            # 默认超时（秒）
RUN_TIMEOUT_MAX = _env_int("RUN_TIMEOUT_MAX", 300)       # 允许前端传入的最大超时（秒）
RUN_TIMEOUT_ACTION = _env_str("RUN_TIMEOUT_ACTION", "background")   # 超时后：background=转为后台继续跑 / kill=终止

# ===== Demo / 小游戏目录（与 data 平级，独立于默认浏览根）=====
DEMO_DIR = os.path.join(os.path.dirname(BASE_DIR), "demo")
if not os.path.isdir(DEMO_DIR):
    os.makedirs(DEMO_DIR, exist_ok=True)
# Demo 管理页元数据（名称/标签/图标/顺序/启用等，存于 data/ 下）
DEMO_MANIFEST = os.path.join(os.path.dirname(BASE_DIR), "data", "demo_games.json")
# 系统关键目录（删除/改权限时直接拦截）
_SYS_DIRS = r"(/etc|/usr|/boot|/bin|/sbin|/lib|/lib64|/var|/opt|/proc|/sys|/dev|/root|/srv|/System|/Volumes|/Applications)"

# 直接拒绝执行的命令（正则，忽略大小写；reason 会显示给用户）
EXEC_BLOCK_PATTERNS = [
    # —— 关机 / 重启 / 内核 / 系统状态 ——
    (r"\b(shutdown|reboot|halt|poweroff|kexec)\b", "禁止关机 / 重启服务器"),
    (r"\bsystemctl\s+(reboot|poweroff|halt|suspend|hibernate|hybrid-sleep|kexec|"
     r"default|rescue|emergency|isolate)\b", "禁止关机 / 重启 / 切换系统状态"),
    (r"\bsystemctl\s+\w+\s+(ctrl-alt-del|reboot|poweroff|halt|suspend|emergency|rescue)\.target\b",
     "禁止操作系统关键 systemd 目标"),
    (r"\binit\s+[0-9]\b|\btelinit\s+[0-9]\b", "禁止切换系统运行级别"),
    (r"\bsystemd-crash|>\s*/proc/sysrq-trigger", "禁止触发 SysRq / 触发内核崩溃"),
    (r">\s*/proc/|>\s*/sys/", "禁止直接写入内核参数"),
    (r"\bsysctl\s+(-w|--write|-)", "禁止修改内核参数"),
    (r"\b(insmod|rmmod|modprobe)\b", "禁止加载 / 卸载内核模块"),
    (r"\bswapoff\b|\bswapon\b", "禁止开关交换分区"),
    (r"\b(setenforce|semanage|setcap|capsh)\b", "禁止修改安全策略 / 进程能力"),
    (r"\b(bpftrace|perf\s+trace)\b", "禁止使用内核跟踪工具（影响系统）"),
    # —— 进程 ——
    (r"\bkill(all)?\b[^\n]*(\s-1\b|\s1\s*$)", "禁止杀死 init / 全部进程"),
    (r"\bkillall5\b|\bpkill\b[^\n]*\binit\b", "禁止杀死 init / 全部进程"),
    (r"\binit\s+[06]\b", "禁止切换系统运行级别"),
    # —— 磁盘 / 文件系统 ——
    (r"\bmkfs(\.\w+)?\b|\bmke2fs\b|\bfdisk\b|\bparted\b|\bsgdisk\b|\bgdisk\b", "禁止格式化 / 分区磁盘"),
    (r"\bdd\b[^\n]*\bof=/dev/|>\s*/dev/(sd|hd|nvme|vd|mmcblk|disk|loop)", "禁止直接写入块设备"),
    (r"\b(lvremove|vgremove|pvremove|blkdiscard|wipefs|mdadm\s+--stop|mdadm\s+--zero)\b",
     "禁止破坏逻辑卷 / 磁盘阵列 / 块设备签名"),
    (r"\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+"
     r"(/|/\*|~|~/|\$HOME)\s*$", "禁止递归强制删除根目录 / 家目录"),
    (r"\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+"
     r"(/|/\*|~|~/|\$HOME)\s*$", "禁止递归强制删除根目录 / 家目录"),
    (r"\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+" + _SYS_DIRS + r"(/\*?)?\s*$",
     "禁止删除系统关键目录"),
    (r"\brm\s+-rf?\s+--no-preserve-root", "禁止删除根目录"),
    (r"\bfind\s+/[^\s]*\s[^\n]*(-delete|-exec\s+rm)", "禁止用 find 批量删除文件"),
    (r"\bchmod\s+(-[a-zA-Z]+\s+)*777\s+/(\s|$)", "禁止把根目录权限改为 777"),
    (r"\bchmod\s+-R\s+[0-7]+\s+" + _SYS_DIRS, "禁止递归修改系统目录权限"),
    (r"\bchown\s+-R\b[^\n]*\s/(\s|$)", "禁止递归修改根目录属主"),
    (r"\bchattr\b", "禁止修改文件系统属性（chattr）"),
    (r"\b(debugfs|tune2fs|e2fsck\s+-y)\b", "禁止直接操作文件系统元数据"),
    # —— 提权 / 逃逸 ——
    (r"\b(sudo|su|doas|pkexec|nsenter|unshare)\b", "禁止提权 / 进入其它命名空间"),
    (r"\bdocker\s+(run|exec)\b[^\n]*--privileged", "禁止启动特权容器"),
    (r"\bmount\b[^\n]*\s/\s", "禁止挂载到根目录"),
    # —— 其它高危 ——
    (r":\s*\(\s*\)\s*\{.*\}\s*;\s*:", "禁止 fork 炸弹"),
    (r"\bhistory\s+-c\b", "禁止清空命令历史"),
]

# 需要用户二次确认才执行的命令（reason 会显示给用户）
EXEC_CONFIRM_PATTERNS = [
    # —— 文件删除 / 覆盖 ——
    (r"\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*", "递归 / 强制删除文件"),
    (r"\bmv\b[^\n]*\s/(\s|$)", "移动文件到根目录"),
    (r"\btruncate\b|\bshred\b", "截断 / 粉碎文件内容"),
    (r">\s*" + _SYS_DIRS, "写入系统目录"),
    (r"\b(cp|rsync|install)\b[^\n]*\s" + _SYS_DIRS, "写入系统目录"),
    # —— 服务 / 进程管理 ——
    (r"\bsystemctl\s+(start|stop|restart|reload|try-restart|enable|disable|mask|unmask|"
     r"daemon-reload|daemon-reexec)\b", "启停 / 修改系统服务"),
    (r"\bservice\s+\S+\s+(start|stop|restart|reload)\b", "启停系统服务"),
    # 锚定到命令开头，避免把 `cat /etc/passwd`、`grep "kill"` 这类误判为危险操作
    (r"^\s*(sudo\s+)?(kill|pkill|killall)\b", "终止进程"),
    (r"^\s*(systemd-run|at|batch|nice|renice)\b", "以后台 / 计划方式或改优先级运行"),
    # —— 系统配置 ——
    (r"\b(iptables|ip6tables|nft|ufw|firewall-cmd)\b", "修改防火墙规则"),
    (r"^\s*(sudo\s+)?(mount|umount)\b", "挂载 / 卸载文件系统"),
    (r"^\s*(sudo\s+)?crontab\b", "修改定时任务"),
    (r"^\s*(sudo\s+)?(useradd|userdel|groupadd|groupdel|passwd|chpasswd|usermod|chsh)\b", "修改系统用户"),
    (r"\b(hostnamectl|timedatectl|localectl)\b", "修改系统主机 / 时间 / 区域设置"),
    # —— 开发类操作 ——
    (r"\bgit\s+reset\s+--hard\b", "丢弃所有未提交改动"),
    (r"\bgit\s+clean\s+-[a-zA-Z]*f", "删除未跟踪文件"),
    (r"\bgit\s+push\s+.*--force\b|\bgit\s+push\s+-f\b", "强制推送（可能覆盖远端历史）"),
    (r"\b(npm|yarn|pnpm)\s+(publish|install|i|add|remove|uninstall)\b|\bpip3?\s+(install|uninstall)\b",
     "安装 / 卸载 / 发布依赖包"),
    (r"\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b", "从网络下载脚本并直接执行"),
    (r"\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|network\s+rm)\b|\bkubectl\s+delete\b",
     "删除容器 / 镜像 / 集群资源"),
    (r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\.\.", "删除上级目录内容"),
]

# ===== 登录认证（账号密码从 .env 读取，避免明文散落在源码）=====
AUTH_USERNAME = _env_str("AUTH_USERNAME", "admin")
AUTH_PASSWORD = _env_str("AUTH_PASSWORD", "admin123")

# ===== 运行时数据（保存在应用目录下）=====
# 源码运行时放到项目根目录的 data/；打包为可执行文件后放到可执行文件旁的 data/，
# 避免写入解压用的临时目录（_MEIPASS）导致数据随进程退出而丢失。
if _IS_FROZEN:
    _DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "data")
else:
    _DATA_ROOT = os.path.join(os.path.dirname(BASE_DIR), "data")
os.makedirs(_DATA_ROOT, exist_ok=True)

# 运行时数据根目录（公开常量，供各服务模块引用）
DATA_ROOT = _DATA_ROOT

_CACHE_DIR = _DATA_ROOT

# 持久化 JSON 存储统一目录（收藏夹 / 配置 / 历史 / 缓存等），
# 与临时目录、压缩包备份、数据库文件分开，便于管理与备份
_STORAGE_DIR = os.path.join(_DATA_ROOT, "storage")
os.makedirs(_STORAGE_DIR, exist_ok=True)
# 运行时数据：JSON 存储目录（公开常量，供各服务模块引用）
STORAGE_DIR = _STORAGE_DIR

# 目录大小缓存
_DIR_SIZE_CACHE_FILE = os.path.join(_STORAGE_DIR, ".file_manager_cache.json")
# 目录列表缓存
_LIST_CACHE_FILE = os.path.join(_STORAGE_DIR, ".file_manager_list_cache.json")
# 回收站目录
_TRASH_DIR = os.path.join(_DATA_ROOT, ".file_manager_trash")
os.makedirs(_TRASH_DIR, exist_ok=True)
# 删除历史
_DELETE_HISTORY_FILE = os.path.join(_STORAGE_DIR, ".file_manager_delete_history.json")
# 分享记录数据库（SQLite）
_SHARE_DB_FILE = os.path.join(_STORAGE_DIR, "shares.db")

# AI 助手配置（OpenAI 兼容接口：base_url / api_key / model）
AI_CONFIG_FILE = os.path.join(_STORAGE_DIR, ".file_manager_ai.json")

# Git 远程仓库认证信息（Token / SSH 等），仅保存在服务端
GIT_CREDENTIALS_FILE = os.path.join(_STORAGE_DIR, ".file_manager_git_credentials.json")

# 持久化索引数据库
_INDEX_DB_FILE = os.path.join(_CACHE_DIR, ".file_manager_index.db")
_INDEX_DB_NEW = _INDEX_DB_FILE + ".new"

# 缩略图磁盘缓存目录（视频封面等，源文件未修改时直接复用，避免重复 ffmpeg 抽帧）
_THUMB_CACHE_DIR = os.path.join(_DATA_ROOT, ".file_manager_thumbs")
os.makedirs(_THUMB_CACHE_DIR, exist_ok=True)
_COVER_DIR = os.path.join(_DATA_ROOT, ".file_manager_covers")
os.makedirs(_COVER_DIR, exist_ok=True)
# 视频封面持久化缓存：以「视频名 + 大小」的 hash 为键（不依赖 mtime，跨重启稳定复用），
# 封面图按 hash 存进 _COVER_DIR 子文件夹，索引写进该目录的 index.json，下次请求直接读本地。
_COVER_DIR = os.path.join(_DATA_ROOT, ".file_manager_covers")
os.makedirs(_COVER_DIR, exist_ok=True)
# 缩略图缓存上限（条目数），超出后按最久未使用清理
_THUMB_CACHE_MAX_ENTRIES = 2000
# 进程内内存缓存容量（LRU，单位：条）。这是唯一占用服务器内存的缓存层。
# 缩略图已持久化到磁盘（data/.file_manager_thumbs/）且浏览器也有 HTTP 缓存，
# 故内存缓存只是“热点加速层”。设为 0 可完全关闭内存缓存（仅靠磁盘+HTTP），最省内存。
_THUMB_MEM_CACHE_MAX = 200

# ===== 预览 / 缩略图 / 流式限制 =====
_TEXT_EXTS = {
    "txt", "md", "py", "js", "ts", "jsx", "tsx", "html", "htm", "css", "scss", "less",
    "json", "xml", "yml", "yaml", "ini", "cfg", "conf", "env", "sh", "bat", "ps1", "rs",
    "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "sql", "log", "csv", "toml",
    "lrc", "spec", "lock", "properties", "srt", "vtt",
}
# 无扩展名但应按文本打开的文件名（小写）
_TEXT_FILENAMES = {
    ".gitignore", ".editorconfig", ".dockerignore",
    "makefile", "dockerfile", "dockerfile.dev", "dockerfile.prod",
    "readme", "license", "copying", "changelog", "changes",
}
# 点开头文件（.env / .env.example / .npmrc 等）：splitext 对它们取不到扩展名，
# 按首段名（去掉开头点后的第一段）匹配此集合即视为文本，可打开编辑
_DOTFILE_TEXT_STEMS = {
    "env", "npmrc", "nvmrc", "bashrc", "zshrc", "profile", "vimrc", "curlrc", "wgetrc",
    "gitignore", "gitattributes", "gitmodules", "gitconfig", "dockerignore", "editorconfig",
    "prettierrc", "eslintrc", "babelrc", "stylelintrc", "flake8", "pypirc", "htaccess", "python-version",
}
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic"}
_VIDEO_EXTS = {"mp4", "webm", "mkv", "avi", "mov", "m4v", "ogg", "flv"}
_AUDIO_EXTS = {"mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "wma", "mp2", "mid", "midi"}
_PREVIEW_EXTS = _TEXT_EXTS | _IMAGE_EXTS | _VIDEO_EXTS
_PREVIEW_MAX_BYTES = 50 * 1024 * 1024         # 图片等预览上限 50MB
_TEXT_PREVIEW_MAX_BYTES = 20 * 1024 * 1024    # 文本编辑预览上限 20MB（兼容 package-lock.json 等大文件）
_STREAM_CHUNK_SIZE = 1024 * 1024              # 视频流分块 1MB
_THUMBNAIL_MAX_BYTES = 500 * 1024             # 缩略图 500KB

# ===== 视频缩略图（ffmpeg）=====
# 某些环境下 PATH 中的 ffmpeg 是精简裁剪版（如 IDE 自带的静态包，缺少图片编码器，
# 无法输出 .jpg 帧）。优先使用系统完整版 ffmpeg，找不到时才回退到 PATH。
def _resolve_ffmpeg_bin():
    candidates = []
    if os.name != "nt":
        candidates = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
    path_bin = shutil.which("ffmpeg") or "ffmpeg"
    for c in candidates:
        if os.path.isfile(c):
            return c
    return path_bin


FFMPEG_BIN = _resolve_ffmpeg_bin()


def _resolve_ffprobe_bin():
    """与 ffmpeg 同目录优先取 ffprobe（读取视频时长等元数据）"""
    try:
        sibling = os.path.join(os.path.dirname(FFMPEG_BIN), "ffprobe")
        if os.path.isfile(sibling):
            return sibling
    except OSError:
        pass
    return shutil.which("ffprobe") or "ffprobe"


FFPROBE_BIN = _resolve_ffprobe_bin()