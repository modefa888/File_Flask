"""内容搜索（在文件中搜索 / grep），供在线 IDE 的搜索面板使用。

GET /api/grep?root=<目录>&keyword=<关键字>&case=1&word=1&regex=1&skip=a,b
    &max_files=200&max_matches=2000&per_file=40&timeout=12

返回按文件分组的匹配行，供前端渲染成 VS Code 风格的搜索结果列表。
"""
import os
import re
import time

from flask import Blueprint, request, jsonify

from ..config import _TEXT_EXTS
from ..log import get_logger


_log = get_logger()
bp = Blueprint("grep", __name__)

# config._TEXT_EXTS 之外、常见但未收录的文本扩展名
_EXTRA_TEXT_EXTS = {
    "vue", "svelte", "astro", "jsx", "tsx", "mjs", "cjs", "jsonc", "json5",
    "kt", "kts", "gradle", "swift", "dart", "scala", "clj", "ex", "exs",
    "pl", "pm", "r", "jl", "m", "mm", "proto", "graphql", "gql", "tf", "hcl",
    "asm", "s", "cmake", "dockerfile", "makefile", "gitignore", "editorconfig",
    "properties", "diff", "patch", "srt", "ass", "vtt", "tsv", "lock", "env",
}
_TEXT_EXTS_ALL = set(_TEXT_EXTS) | _EXTRA_TEXT_EXTS

_MAX_FILE_BYTES = 2 * 1024 * 1024      # 单文件超过 2MB 跳过（压缩包/大日志等）
_MAX_LINE_LEN = 420                    # 返回的单行文本上限，超长行以匹配位置为中心截断
_SNIFF_BYTES = 4096                    # 二进制探测字节数


def _truthy(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _maybe_text(filename: str) -> bool:
    """按扩展名粗判是否为可搜索的文本文件。"""
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if ext:
        return ext in _TEXT_EXTS_ALL
    # 无扩展名（如 README / Makefile）：交由调用方按体积与二进制探测决定
    return True


def _u16_len(s: str) -> int:
    """返回字符串的 UTF-16 码元长度。

    Python 按码点计数，而 JS/CodeMirror 按 UTF-16 码元计数：emoji 等增补平面字符
    在 JS 中占 2 位。列号必须统一成 UTF-16 码元，否则含 emoji 的行高亮会偏移。
    """
    return len(s.encode("utf-16-le")) // 2


def _collect_matches(text: str, pat, per_file: int):
    """逐行匹配，返回 (matches, total, more)。

    matches: 最多返回 per_file 条（带行号与上下文），供前端渲染；
    total:   该文件实际命中的总数（用于结果摘要）；
    more:    是否还有未返回的匹配。
    """
    matches = []
    total = 0
    for lineno, line in enumerate(text.splitlines()):
        for m in pat.finditer(line):
            if m.end() == m.start():
                continue                      # 跳过空匹配（如正则 a*）
            total += 1
            if len(matches) >= per_file:
                continue
            start_ch, end_ch = m.start(), m.end()
            snippet, offset = line, 0
            if len(line) > _MAX_LINE_LEN:
                cut = max(0, start_ch - _MAX_LINE_LEN // 3)
                snippet = line[cut:cut + _MAX_LINE_LEN]
                offset = cut
            # 全部列号/长度按 UTF-16 码元输出，与 JS / CodeMirror 的索引口径一致
            matches.append({
                "line": lineno + 1,
                # col 始终是「原始行内」的绝对列号：编辑器跳转必须用它
                "col": _u16_len(line[:start_ch]),
                "len": _u16_len(line[start_ch:end_ch]),
                # text 为展示片段（超长行会截断），trim 是片段首字符在原始行中的偏移
                "text": snippet,
                "trim": _u16_len(line[:offset]),
                "trimmed": bool(offset) or (offset + len(snippet) < len(line)),
            })
    return matches, total, total > len(matches)


def _iter_candidate_files(root, skip_l):
    """遍历 root，产出候选文件路径（跳过隐藏目录、依赖目录、超限文件）。"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if skip_l:
            dirnames[:] = [d for d in dirnames if d.lower() not in skip_l]
        for fn in filenames:
            if fn.startswith(".") and fn not in (".gitignore", ".env", ".editorconfig"):
                continue
            if not _maybe_text(fn):
                continue
            fp = os.path.join(dirpath, fn)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            if not os.path.isfile(fp) or st.st_size > _MAX_FILE_BYTES:
                continue
            yield fp


@bp.route("/api/grep")
def api_grep():
    """在文件中搜索内容，返回按文件分组的结果。"""
    root = request.args.get("root", "").strip()
    keyword = request.args.get("keyword", "")
    case_sensitive = _truthy(request.args.get("case", ""))
    whole_word = _truthy(request.args.get("word", ""))
    use_regex = _truthy(request.args.get("regex", ""))
    skip_dirs = [s.strip() for s in request.args.get("skip", "").split(",") if s.strip()]
    skip_l = {s.lower() for s in skip_dirs}
    _log.info("GET /api/grep root=%s keyword_len=%d", root, len(keyword))

    if not keyword:
        return jsonify({"error": "搜索关键字不能为空"}), 400

    try:
        max_files = max(1, min(1000, int(request.args.get("max_files", 200))))
        max_matches = max(1, min(20000, int(request.args.get("max_matches", 2000))))
        per_file = max(1, min(500, int(request.args.get("per_file", 40))))
        budget = max(1.0, min(60.0, float(request.args.get("timeout", 12))))
    except (TypeError, ValueError):
        max_files, max_matches, per_file, budget = 200, 2000, 40, 12.0

    if not root:
        root = "/"
    root = os.path.abspath(os.path.normpath(root))
    if not os.path.isdir(root):
        return jsonify({"error": f"搜索根目录不存在: {root}"}), 400

    # 统一编译成正则：普通关键字转义后即字面量匹配（可选全字边界）
    if use_regex:
        try:
            pat = re.compile(keyword, 0 if case_sensitive else re.IGNORECASE)
        except re.error as e:
            return jsonify({"error": f"正则表达式无效：{e}"}), 400
    else:
        body = re.escape(keyword)
        if whole_word:
            body = r"\b" + body + r"\b"
        pat = re.compile(body, 0 if case_sensitive else re.IGNORECASE)

    t0 = time.monotonic()
    files_out = []
    total_matches = 0
    truncated = False

    for fp in _iter_candidate_files(root, skip_l):
        if time.monotonic() - t0 > budget or len(files_out) >= max_files or total_matches >= max_matches:
            truncated = True
            break
        try:
            with open(fp, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        if b"\x00" in raw[:_SNIFF_BYTES]:
            continue                              # 二进制文件（如无扩展名的可执行文件）
        text = raw.decode("utf-8", "replace")
        matches, total, more = _collect_matches(text, pat, per_file)
        if not matches:
            continue
        total_matches += total
        files_out.append({
            "path": fp.replace("\\", "/"),
            "rel": os.path.relpath(fp, root).replace("\\", "/"),
            "count": len(matches),          # 返回的匹配条数
            "total": total,                 # 该文件实际命中总数
            "more": more,
            "matches": matches,
        })

    return jsonify({
        "done": True,
        "root": root,
        "file_count": len(files_out),
        "match_count": total_matches,
        "truncated": truncated or total_matches >= max_matches,
        "duration": round(time.monotonic() - t0, 2),
        "files": files_out,
    })
