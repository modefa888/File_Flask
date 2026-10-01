"""联网搜索服务：默认走 Bing 网页搜索（HTML 解析，无需 API Key），
DuckDuckGo（duckduckgo_search 库）作为兜底。

之所以自己解析 Bing：
    duckduckgo_search 8.x 在该环境里只用 bing 后端，且其底层 primp（Rust）客户端
    会因 TLS 曲线协商失败报 `peer misbehaved: SelectedUnofferedKxGroup`，导致一直返回 None。
    标准库 urllib 的 TLS 栈可以正常访问 Bing，因此这里直接抓取 Bing 结果页。

返回标准格式：
    [{"title": "...", "href": "https://...", "body": "..."}, ...]

若全部搜索源都失败，返回带 error 的单项列表，调用方应优雅降级。
"""
import base64
import html as _html
import re
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings

from ...log import get_logger

_log = get_logger()

try:                                   # 新包名优先，旧包名兼容
    from ddgs import DDGS
    _HAS_DDG = True
except Exception:  # noqa: BLE001
    try:
        from duckduckgo_search import DDGS
        _HAS_DDG = True
    except Exception as e:  # noqa: BLE001
        _HAS_DDG = False
        _log.warning("未安装 duckduckgo-search/ddgs，DuckDuckGo 兜底不可用：%s", e)

_BING_URL = "https://www.bing.com/search"
_BING_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}


def _decode_bing_href(href):
    """Bing 部分结果会包一层 https://www.bing.com/ck/a?...&u=a1<base64url>，这里还原真实地址。"""
    if not href:
        return ""
    if "bing.com/ck/a" in href or "bing.com/aclick" in href:
        try:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            u = (qs.get("u") or [""])[0]
            if u.startswith("a1"):
                b = u[2:]
                b += "=" * (-len(b) % 4)
                return base64.urlsafe_b64decode(b).decode("utf-8", "replace") or href
        except Exception:  # noqa: BLE001
            pass
    return href


def _strip_tags(s):
    return _html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def _parse_bing(html_text, max_results):
    """从 Bing 结果页 HTML 里抽取 b_algo 结果块。"""
    out = []
    try:
        from lxml import html as LH
        doc = LH.fromstring(html_text)
        for li in doc.xpath('//li[contains(@class,"b_algo")]'):
            a = li.xpath('.//h2//a')
            if not a:
                continue
            title = a[0].text_content().strip()
            href = _decode_bing_href(a[0].get("href") or "")
            ps = li.xpath('.//div[contains(@class,"b_caption")]//p') or li.xpath('.//p')
            body = ps[0].text_content().strip() if ps else ""
            if title or body:
                out.append({"title": title, "href": href, "body": body})
            if len(out) >= max_results:
                break
        if out:
            return out
    except Exception as e:  # noqa: BLE001
        _log.debug("lxml 解析 Bing 失败，改用正则：%s", e)

    # 正则兜底（不依赖 lxml）
    for m in re.finditer(r'<li class="b_algo".*?(?=<li class="b_algo"|</ol>)', html_text, re.S):
        chunk = m.group(0)
        am = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', chunk, re.S)
        if not am:
            continue
        href = _decode_bing_href(_html.unescape(am.group(1)))
        title = _strip_tags(am.group(2))
        bm = re.search(r'<p[^>]*>(.*?)</p>', chunk, re.S)
        body = _strip_tags(bm.group(1)) if bm else ""
        if title or body:
            out.append({"title": title, "href": href, "body": body})
        if len(out) >= max_results:
            break
    return out


def _bing_search(query, max_results, timeout=15):
    """Bing 网页搜索（标准库实现，最多重试 3 次）。"""
    params = {
        "q": query,
        "count": str(max(10, min(max_results * 2, 30))),
        "setlang": "zh-CN",
        "FORM": "QBLH",
    }
    url = _BING_URL + "?" + urllib.parse.urlencode(params)
    last = "未知错误"
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers=_BING_HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            text = raw.decode("utf-8", "replace")
            out = _parse_bing(text, max_results)
            if out:
                return out
            last = "Bing 未返回可解析的结果"
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
            if e.code not in (429, 503):        # 非限流一般重试也无效，但仍试一次
                last += "（%s）" % (e.reason or "")
        except Exception as e:  # noqa: BLE001
            last = "%s: %s" % (type(e).__name__, e)
        if i < 2:
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(last)


def _ddg_search(query, max_results):
    """DuckDuckGo 兜底（部分环境可用）。"""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")            # 旧包会提示已改名，这里静默
        with DDGS(timeout=12) as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
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


def search_web(query: str, max_results: int = 5):
    """执行联网搜索，返回结果列表。"""
    q = str(query or "").strip()
    if not q:
        return []
    try:
        max_results = max(1, min(int(max_results or 5), 10))
    except (TypeError, ValueError):
        max_results = 5

    errors = []
    try:                                              # ① Bing 网页搜索（主要来源）
        out = _bing_search(q, max_results)
        if out:
            return out
        errors.append("Bing：未返回结果")
    except Exception as e:  # noqa: BLE001
        _log.warning("Bing 搜索失败：%s", e)
        errors.append("Bing：%s" % e)

    if _HAS_DDG:                                      # ② DuckDuckGo 兜底
        try:
            out = _ddg_search(q, max_results)
            if out:
                return out
            errors.append("DuckDuckGo：未返回结果")
        except Exception as e:  # noqa: BLE001
            _log.warning("DuckDuckGo 搜索失败：%s", e)
            errors.append("DuckDuckGo：%s" % e)

    detail = "；".join(errors) if errors else "无可用搜索源"
    return [{"error": "联网搜索失败（%s）" % detail}]


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
