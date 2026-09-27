"""集中式配置模块：路径、常量、Flask 应用配置。"""
import os
import shutil
import sys

# 是否以冻结的可执行文件运行（PyInstaller 打包后为 True）
_IS_FROZEN = bool(getattr(sys, "frozen", False))

# Flask 应用目录 / 静态 / 模板
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_FOLDER = os.path.join(BASE_DIR, "templates")
STATIC_FOLDER = os.path.join(BASE_DIR, "static")

# Flask 配置
SECRET_KEY = "change-me-in-production"
DEBUG = False
HOST = "0.0.0.0"
PORT = 5001

# 默认起始路径
DEFAULT_START_PATH = os.path.sep if os.name != "nt" else os.environ.get("SystemDrive", "C:") + "\\"

# ===== 登录认证 =====
AUTH_USERNAME = "admin"
AUTH_PASSWORD = "admin123"

# ===== 运行时数据（保存在应用目录下）=====
# 源码运行时放到项目根目录的 data/；打包为可执行文件后放到可执行文件旁的 data/，
# 避免写入解压用的临时目录（_MEIPASS）导致数据随进程退出而丢失。
if _IS_FROZEN:
    _DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "data")
else:
    _DATA_ROOT = os.path.join(os.path.dirname(BASE_DIR), "data")
os.makedirs(_DATA_ROOT, exist_ok=True)

_CACHE_DIR = _DATA_ROOT

# 目录大小缓存
_DIR_SIZE_CACHE_FILE = os.path.join(_CACHE_DIR, ".file_manager_cache.json")
# 目录列表缓存
_LIST_CACHE_FILE = os.path.join(_CACHE_DIR, ".file_manager_list_cache.json")
# 回收站目录
_TRASH_DIR = os.path.join(_DATA_ROOT, ".file_manager_trash")
os.makedirs(_TRASH_DIR, exist_ok=True)
# 删除历史
_DELETE_HISTORY_FILE = os.path.join(_DATA_ROOT, ".file_manager_delete_history.json")

# 持久化索引数据库
_INDEX_DB_FILE = os.path.join(_CACHE_DIR, ".file_manager_index.db")
_INDEX_DB_NEW = _INDEX_DB_FILE + ".new"

# 缩略图磁盘缓存目录（视频封面等，源文件未修改时直接复用，避免重复 ffmpeg 抽帧）
_THUMB_CACHE_DIR = os.path.join(_DATA_ROOT, ".file_manager_thumbs")
os.makedirs(_THUMB_CACHE_DIR, exist_ok=True)
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
    "lrc",
}
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"}
_VIDEO_EXTS = {"mp4", "webm", "mkv", "avi", "mov", "m4v", "ogg", "flv"}
_AUDIO_EXTS = {"mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "wma", "mp2", "mid", "midi"}
_PREVIEW_EXTS = _TEXT_EXTS | _IMAGE_EXTS | _VIDEO_EXTS
_PREVIEW_MAX_BYTES = 5 * 1024 * 1024          # 图片等预览上限 5MB
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