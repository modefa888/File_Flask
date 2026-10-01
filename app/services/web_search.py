"""联网搜索服务：默认使用 DuckDuckGo（无需 API Key）。

返回标准格式：
    [{"title": "...", "href": "https://...", "body": "..."}, ...]

若依赖未安装或网络不通，返回带 error 的单项列表，调用方应优雅降级。
"""
import textwrap

from ..log import get_logger

_log = get_logger()

try:
    from duckduckgo_search import DDGS
    _HAS_DDG = True
except Exception as e:  # noqa: BLE001
    _HAS_DDG = False
    _log.warning("未安装 duckduckgo-search，联网搜索不可用：%s", e)


def search_web(query: str, max_results: int = 5):
    """执行联网搜索，返回结果列表。"""
    q = str(query or "").strip()
    if not q:
        return []
    if not _HAS_DDG:
        return [{"error": "未安装 duckduckgo-search，无法联网搜索。请在 requirements.txt 中取消注释并安装。"}]
    try:
        max_results = max(1, min(int(max_results or 5), 10))
    except (TypeError, ValueError):
        max_results = 5
    try:
        with DDGS() as ddgs:
            results = ddgs.text(q, max_results=max_results)
            out = []
            for r in results:
                if not isinstance(r, dict):
                    continue
                title = str(r.get("title") or "").strip()
                href = str(r.get("href") or "").strip()
                body = str(r.get("body") or "").strip()
                if not (title or body or href):
                    continue
                out.append({"title": title, "href": href, "body": body})
            return out
    except Exception as e:  # noqa: BLE001
        _log.warning("联网搜索失败: %s", e)
        return [{"error": "联网搜索失败：%s" % e}]


def format_results(results: list, max_chars: int = 2000) -> str:
    """把搜索结果格式化成一段文本，供注入 LLM 上下文。"""
    if not results:
        return "（未找到相关网络结果）"
    lines = []
    for i, r in enumerate(results[:8], 1):
        if r.get("error"):
            lines.append("[搜索异常] %s" % r["error"])
            continue
        title = r.get("title") or ""
        href = r.get("href") or ""
        body = r.get("body") or ""
        snippet = textwrap.shorten(body, width=240, placeholder="…") if body else ""
        lines.append("[%d] %s\n    链接：%s\n    摘要：%s" % (i, title, href, snippet))
    text = "\n\n".join(lines)
    if max_chars and len(text) > max_chars:
        text = text[:max_chars] + "\n…（搜索结果已截断）"
    return text
