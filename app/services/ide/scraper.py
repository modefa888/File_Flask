"""可视化数据采集（任意网站 → 结构化数据）。

流程
----
1. 抓取：服务端 GET 目标页面，把 HTML **清洗后**交给前端 iframe 预览。
   · 静态预览（默认）：去掉 <script>/<noscript>/<template> 与 on* 属性，图片走 /proxy 代理；
   · 交互预览（interactive）：保留并执行站点脚本，页面上所有资源地址改写成
     /api/scraper/mirror/<token>/<scheme>/<host>/<path>，由服务端代取（带 UA / Cookie /
     Referer），CSS/JS 里的 url()、@import、import 说明符一并改写，运行时由注入的
     代理脚本接管 fetch / XHR / 动态 src —— 浏览器全程不直连源站。
2. 点选：抓取规则（列表项选择器 + 字段选择器）完全由前端在预览页里点选生成，
   所以这里不需要任何「站点适配」代码。
3. 采集：按规则在服务端批量提取（文本 / 属性 / 内层 HTML），支持三种翻页方式：
   URL 模板（含 {page}）/ 下一页链接选择器 / 不翻页。
4. 导出：CSV（带 BOM，Excel 直接打开不乱码）/ JSON / XLSX。

约定
----
- 只做读操作，不改动任何本地文件；
- 只接受 http / https 网址；
- 单页 HTML 与单元格内容都有长度上限，避免异常站点把内存撑爆；
- 成功 {"ok": true, ...}，失败 {"error": "..."}（异常向上抛 ValueError / RuntimeError，
  由路由层统一转成响应）。
"""
import csv
import datetime
import io
import json
import os
import re
import threading
import time
import uuid
from urllib.parse import quote, unquote, urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

import requests
from bs4 import BeautifulSoup

from ...log import get_logger
from ..common.store_db import store_conn, store_tx

_log = get_logger()

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

MAX_HTML = 4 * 1024 * 1024      # 单页 HTML 上限（字节）
MAX_RENDER_HTML = 8 * 1024 * 1024   # 浏览器渲染后的 DOM 通常更大，单独放宽
MAX_ROWS = 5000                 # 一次采集最多保留多少行
MAX_PAGES = 30                  # 一次采集最多翻多少页
CELL_MAX = 4000                 # 单元格文本上限
_FIELD_TYPES = ("text", "html", "attr")


# ----------------------------------------------------------------- 抓取

def check_url(url):
    """补全协议 + 校验，只放行 http / https。"""
    u = (url or "").strip()
    if not u:
        raise ValueError("请填写网址")
    if not re.match(r"^[a-zA-Z][\w+.-]*://", u):
        u = "https://" + u.lstrip("/")
    p = urlparse(u)
    if p.scheme not in ("http", "https"):
        raise ValueError("只支持 http / https 网址")
    if not p.netloc:
        raise ValueError("网址格式不正确")
    return u


# ------------------------------------------------- 预览缓存（iframe 用的页面）
# 预览页由服务端出（/api/scraper/preview/<token>），不再用 iframe srcdoc：
#   · srcdoc 文档的地址是 about:srcdoc，拦不住站点脚本时控制台会一直刷
#     「Blocked script execution in about:srcdoc…」；
#   · 而且 srcdoc 里发的图片请求不带站点 Referer，图床一律 403。
_PREVIEW_TTL = 1800          # 预览页在内存里留 30 分钟
_PREVIEW_MAX = 12            # 最多同时留 12 个，够反复点选用了
_PREVIEWS = {}
_PREVIEW_LOCK = threading.Lock()

# 预览页的 CSP：禁脚本 / 禁嵌套框架，只放行样式、字体和图片（图片基本都走本地代理）
PREVIEW_CSP = ("default-src 'self'; script-src 'none'; object-src 'none'; "
               "frame-src 'none'; img-src 'self' data: blob: https:; "
               "style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:")


def cache_preview(html, url, session="", live=False, hdrs=None, insecure=False, token=""):
    """把清洗好的 HTML 存进内存，返回一个短 token 给前端当 iframe 地址。

    session：这份预览来自哪个渲染会话（浏览器渲染模式才有），
    「滚动加载更多」要靠它找回那个还开着的无头浏览器继续往下滚。
    hdrs / insecure：镜像代理重新抓资源时复用的请求头（UA、Cookie）与证书策略；
    镜像地址必须在生成 HTML 前就确定，所以允许外部传 token 进来。
    """
    token = (token or "").strip() or uuid.uuid4().hex
    now = time.time()
    with _PREVIEW_LOCK:
        for k, v in list(_PREVIEWS.items()):
            if now - v["ts"] > _PREVIEW_TTL:
                _PREVIEWS.pop(k, None)
        while len(_PREVIEWS) >= _PREVIEW_MAX:
            _PREVIEWS.pop(next(iter(_PREVIEWS)), None)
        _PREVIEWS[token] = {"html": html, "url": url, "ts": now,
                            "session": session or "", "live": bool(live),
                            "hdrs": dict(hdrs or {}), "insecure": bool(insecure)}
    return token


def get_preview(token):
    token = (token or "").strip()
    if not token:
        return None
    with _PREVIEW_LOCK:
        item = _PREVIEWS.get(token)
        if not item:
            return None
        if time.time() - item["ts"] > _PREVIEW_TTL:
            _PREVIEWS.pop(token, None)
            return None
        return {"html": item["html"], "url": item["url"],
                "session": item.get("session") or "", "live": bool(item.get("live")),
                "hdrs": dict(item.get("hdrs") or {}),
                "insecure": bool(item.get("insecure"))}


def _fmt_mb(n):
    try:
        n = float(n or 0)
    except Exception:
        n = 0.0
    if n < 1024 * 1024:
        return "%.0f KB" % (n / 1024) if n else "0 KB"
    if n < 1024 * 1024 * 1024:
        return "%.1f MB" % (n / 1048576.0)
    return "%.2f GB" % (n / 1073741824.0)


_CHROMIUM_KEYS = ("chrome", "chromium", "headless_shell", "playwright")


def _chromium_mem():
    """统计 Chromium（无头浏览器）子进程的内存占用。

    Flask 进程的 RSS 不包含 Playwright 起的浏览器子进程 —— 它们才是渲染模式下的
    内存大头（单个几百 MB 到 1GB+）。这里遍历 /proc 建进程树，找出本进程的所有
    后代里 cmdline 命中 chrome / chromium / headless_shell / playwright 的，
    累加各自的 VmRSS（crashpad 崩溃收集器除外，占用很小没有统计意义）。
    """
    me = os.getpid()
    kids = {}
    cmds = {}
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open("/proc/%s/stat" % pid, "rb") as f:
                    data = f.read().decode("utf-8", "ignore")
                # comm 字段可能含空格和括号，取最后一个 ")" 之后才是状态字段
                rest = data[data.rindex(")") + 2:].split()
                ppid = int(rest[1])
                with open("/proc/%s/cmdline" % pid, "rb") as f:
                    cmd = f.read().decode("utf-8", "ignore").replace("\x00", " ").lower()
                kids.setdefault(ppid, []).append(int(pid))
                cmds[int(pid)] = cmd
            except Exception:
                continue
    except Exception:
        return {"n": 0, "bytes": 0, "bytes_h": "0 KB"}
    total, n = 0, 0
    stack, seen = [me], {me}
    while stack:
        cur = stack.pop()
        for ch in kids.get(cur, []):
            if ch in seen:
                continue
            seen.add(ch)
            stack.append(ch)
            cmd = cmds.get(ch, "")
            if not any(k in cmd for k in _CHROMIUM_KEYS):
                continue
            if "crashpad" in cmd:
                continue
            try:
                with open("/proc/%d/status" % ch, "r") as f:
                    for line in f:
                        if line.startswith("VmRSS:"):
                            total += int(line.split()[1]) * 1024   # kB → B
                            n += 1
                            break
            except Exception:
                continue
    # 进程树外的 Playwright 内核：浏览器主进程退出后，它的子进程会被 init 收养
    # （或变成僵尸），上面那条「从本进程往下找」的路径就看不见了。界面上会显示
    # Chromium 0 个，但系统里其实还有残留进程，这里单独报出来。
    orphan = sum(1 for pid, cmd in cmds.items()
                 if pid not in seen and "ms-playwright" in cmd and "crashpad" not in cmd)
    return {"n": n, "bytes": total, "bytes_h": _fmt_mb(total), "orphans": orphan}


def mem_stats():
    """数据采集模块的实时内存占用：进程 RSS + 各缓存块明细（给前端仪表用）。

    RSS 是「整个 Flask 进程」的常驻内存，除下面几块缓存外，还有 BeautifulSoup
    解析大页面的临时对象、每个请求线程独立的 glibc malloc arena、线程栈等。
    进程一多，arena 释放后也不一定还给内核，所以 RSS 往往远大于缓存明细之和、
    且只涨不跌；用 other / threads 显式列出，免得看起来像内存凭空消失。
    """
    rss = 0
    threads = 0
    try:
        with open("/proc/self/status", "r") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1]) * 1024   # kB → B
                elif line.startswith("Threads:"):
                    threads = int(line.split()[1])
    except Exception:
        try:
            import resource
            rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024
        except Exception:
            rss = 0
    anon = 0
    try:
        with open("/proc/self/smaps_rollup", "r") as f:
            for line in f:
                if line.startswith("Anonymous:"):
                    anon = int(line.split()[1]) * 1024   # kB → B
                    break
    except Exception:
        pass
    with _IMG_LOCK:
        img_n, img_b = len(_IMG_CACHE), int(_IMG_SIZE)
    with _MIRROR_LOCK:
        mir_n, mir_b = len(_MIRROR_CACHE), int(_MIRROR_SIZE)
    with _PREVIEW_LOCK:
        prev_n = len(_PREVIEWS)
        # 别用 str(html)：那等于每 5 秒把所有预览页整份复制一遍，自己制造内存峰值
        prev_b = sum(len(v.get("html") or "") for v in _PREVIEWS.values())
    sess_n = 0
    try:
        from . import render as render_mod
        sess_n = len(getattr(render_mod, "_sessions", None) or {})
    except Exception:
        pass
    chrom = _chromium_mem()
    other = max(0, rss - img_b - mir_b - prev_b - chrom["bytes"])
    return {
        "rss": rss,
        "rss_h": _fmt_mb(rss),
        "threads": threads,
        "anon": anon,
        "anon_h": _fmt_mb(anon),
        "other": other,
        "other_h": _fmt_mb(other),
        "img": {"n": img_n, "bytes": img_b, "bytes_h": _fmt_mb(img_b)},
        "mirror": {"n": mir_n, "bytes": mir_b, "bytes_h": _fmt_mb(mir_b)},
        "previews": {"n": prev_n, "bytes": prev_b, "bytes_h": _fmt_mb(prev_b)},
        "render_sessions": sess_n,
        "chromium": chrom,
    }


def mem_clear():
    """一键释放：清空图片 / 镜像 / 预览缓存，关掉所有渲染会话（当前预览会失效）。

    注意：预览 HTML 一并清掉，前端需要重新「抓取页面」才能继续点选。
    """
    global _IMG_SIZE, _MIRROR_SIZE
    with _IMG_LOCK:
        _IMG_CACHE.clear()
        _IMG_SIZE = 0
    with _MIRROR_LOCK:
        _MIRROR_CACHE.clear()
        _MIRROR_SIZE = 0
    with _PREVIEW_LOCK:
        _PREVIEWS.clear()
    closed = 0
    try:
        from . import render as render_mod
        with render_mod._lock:
            for t in list(render_mod._sessions.keys()):
                sess = render_mod._sessions.pop(t, None)
                if sess is not None:
                    try:
                        sess.close()
                        closed += 1
                    except Exception:
                        pass
    except Exception:
        pass
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    # gc.collect() 只把对象还给 Python 的内存池，RSS 仍被 glibc arena 占着
    _trim_heap()
    out = mem_stats()
    out["closed_sessions"] = closed
    out["ok"] = True
    return out


def scroll_preview(token, times=3, delay=1.2, asset_prefix=""):
    """在渲染会话里继续往下滚 N 屏（触发懒加载 / 无限滚动），返回新的预览地址。"""
    item = get_preview(token)
    if not item:
        raise RuntimeError("预览已过期，请重新抓取页面")
    session_token = item.get("session") or ""
    if not session_token:
        raise RuntimeError("当前页面是静态抓取，滚不会加载新内容；请在「高级」里勾选「浏览器渲染」后重新抓取")
    from . import render as render_mod
    sess = render_mod.get_session(session_token)
    if not sess:
        raise RuntimeError("渲染会话已过期（空闲超过 2 分钟），请重新抓取页面")
    html, scroll_y = sess.scroll(times=times, delay=delay)
    # 交互预览（含「渲染 + 交互」同时开启）滚动后重建 DOM 时也要保留脚本并继续走镜像，
    # 否则滚一次就退化成静态预览，轮播 / 点击特效全没了
    live = bool(item.get("live"))
    mirror_base = mirror_base_of(asset_prefix, token) if live else ""
    cleaned = clean_html(html, sess.page_url, asset_prefix,
                         keep_scripts=live, mirror_base=mirror_base)
    new_token = cache_preview(cleaned, sess.page_url, session_token, live=live,
                              hdrs=item.get("hdrs"), insecure=item.get("insecure"))
    return {
        "preview": (live_preview_url(mirror_base, sess.page_url) if live and mirror_base
                    else "/api/scraper/preview/" + new_token),
        "scroll_y": scroll_y,
        "bytes": len(html.encode("utf-8", "ignore")),
        "times": int(times),
    }


# ------------------------------------------------- 出站 HTTP（有界并发 + 连接池）
# 交互预览里站点所有资源都走 /mirror 代取，一个门户首页能打出上百个并发请求。
# 原来每个 Werkzeug 请求线程各自 requests.get()：并发无上限、TCP 不复用，更要命的是
# glibc 会给每个线程单独分一个 malloc arena（几十 MB），线程退出也不还给内核，
# 于是 RSS 越用越大。这里把「发请求 / 读响应 / 解析大文本」收敛到固定数量的 worker：
#   · arena 数量被 worker 数封顶；
#   · 每个 worker 一个 Session，连接 keep-alive 复用，CLOSE-WAIT 不再堆积；
#   · 流式分块读，超过上限立刻断连，不再把超大响应整块读进内存；
#   · 读完立刻 close()，连接归还连接池。
_HTTP_WORKERS = 16                 # 懒加载一类密集小请求，太少会成为瓶颈、把请求都堆在队列
_HTTP_CHUNK = 64 * 1024
_HTTP_QUEUE_MAX = 32                 # 同时「在执行 + 排队」的上限：满了就立刻失败，不堆请求线程
_HTTP_RESULT_TIMEOUT = 35            # 单个请求最多等这么久（含队列），到时直接 502
_HTTP_READ_BUDGET = 30               # 流式读取的绝对时长上限，防长连接 / 慢流占死 worker
_HTTP_LOCAL = threading.local()
_HTTP_EXEC = None
_HTTP_EXEC_LOCK = threading.Lock()
_HTTP_QUEUE = threading.BoundedSemaphore(_HTTP_QUEUE_MAX)


def _http_session():
    """每个池线程一个 Session：连接池天然线程封闭，不用加锁也不会串 Cookie。"""
    s = getattr(_HTTP_LOCAL, "session", None)
    if s is None:
        from requests.adapters import HTTPAdapter
        s = requests.Session()
        adapter = HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
        _HTTP_LOCAL.session = s
    return s


def _http_exec():
    global _HTTP_EXEC
    with _HTTP_EXEC_LOCK:
        if _HTTP_EXEC is None:
            _HTTP_EXEC = ThreadPoolExecutor(max_workers=_HTTP_WORKERS,
                                            thread_name_prefix="scr-http")
    _ensure_heap_trimmer()
    return _HTTP_EXEC


def _http_read(url, headers, timeout, insecure=False, max_bytes=16 * 1024 * 1024,
               method="GET", body=None):
    """池线程里执行：流式限量读取，返回「已读完且已归还连接」的 Response。

    timeout 只管「两次收包之间的间隔」，源站持续吐数据（SSE / 慢流）时不会触发，
    所以再叠一层绝对时长预算：读超过预算就断连，免得一个长连接把 worker 占死，
    后面成片的懒加载请求全卡在队列里。
    """
    r = _http_session().request(method, url, headers=headers, data=body,
                                timeout=timeout, verify=not insecure,
                                allow_redirects=True, stream=True)
    try:
        chunks, size, deadline = [], 0, time.time() + _HTTP_READ_BUDGET
        for chunk in r.iter_content(_HTTP_CHUNK):
            if not chunk:
                continue
            size += len(chunk)
            if size > max_bytes:
                lim = ("%.1f MB" % (max_bytes / 1048576.0) if max_bytes >= 1048576
                       else "%.0f KB" % (max_bytes / 1024.0))
                raise RuntimeError("资源过大（超过 %s）" % lim)
            chunks.append(chunk)
            if time.time() > deadline:
                raise RuntimeError("资源读取超时（超过 %.0f 秒）" % _HTTP_READ_BUDGET)
        # 内容已经在手：后面 r.content / r.text / r.apparent_encoding 只读这段缓存
        r._content = b"".join(chunks)
        r._content_consumed = True
        return r
    finally:
        r.close()


def _http_submit(fn, *args, **kwargs):
    """提交到池；超出并发上限立刻失败，绝不长时间阻塞请求线程。

    懒加载一滚动就打出成片请求：若让它们在队列里阻塞 90 秒，Werkzeug 会为每个
    请求各开一个线程，线程反复建销又让 glibc 的 malloc arena 只增不减 —— 表现就是
    「页面卡住 + 内存一直涨」。所以这里不排队、不阻塞：能力之外直接 503。
    """
    if not _HTTP_QUEUE.acquire(blocking=False):
        raise RuntimeError("资源代取繁忙（并发过多），请稍后重试")
    try:
        fut = _http_exec().submit(fn, *args, **kwargs)
    except BaseException:
        _HTTP_QUEUE.release()
        raise
    fut.add_done_callback(lambda _f: _HTTP_QUEUE.release())
    try:
        return fut.result(timeout=_HTTP_RESULT_TIMEOUT)
    except FuturesTimeout:
        raise RuntimeError("资源代取超时，请稍后重试")


# ------------------------------------------------- 堆内存归还
# Python 把对象 free 掉之后，glibc 的 malloc arena 仍占着 RSS。定期 trim 一次把
# 空闲页还给内核；「释放内存」按钮也会立即触发同一个动作。
_TRIM_INTERVAL = 300
_trim_lock = threading.Lock()
_trim_started = False


def _trim_heap():
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def _ensure_heap_trimmer():
    global _trim_started
    with _trim_lock:
        if _trim_started:
            return
        _trim_started = True

    def _run():
        while True:
            time.sleep(_TRIM_INTERVAL)
            _trim_heap()

    threading.Thread(target=_run, daemon=True, name="scr-heap-trim").start()


# ------------------------------------------------- 资源代理（图片 / 字体）
_IMG_TTL = 3600
_IMG_ITEM_MAX = 12 * 1024 * 1024      # 单个资源上限
_IMG_TOTAL_MAX = 32 * 1024 * 1024     # 内存缓存总量上限（内存优化：64MB → 32MB）
_IMG_CACHE = {}
_IMG_SIZE = 0
_IMG_LOCK = threading.Lock()


def proxy_src(url, page_url, prefix=""):
    """把页面里的图片地址换成同源代理地址，代理请求会带上站点的 Referer。

    prefix 是本服务的源（http://host:port）。**必须给**：预览页里有 <base href="原站点">，
    相对地址会被解析到原站去（变成 https://原站/api/scraper/proxy…，必然 404）。
    """
    raw = str(url or "").strip()
    if not raw or raw.startswith(("data:", "blob:", "#")):
        return raw
    abs_url = _abs_url(raw, page_url)
    if not abs_url.lower().startswith(("http://", "https://")):
        return raw
    path = "/api/scraper/proxy?u=%s&ref=%s" % (
        quote(abs_url, safe=""), quote(page_url or "", safe=""))
    return (prefix.rstrip("/") + path) if prefix else path


def fetch_media(url, ref=""):
    """抓一个图片 / 字体：带上页面 Referer，绕过图床的防盗链；结果做内存缓存。"""
    target = check_url(url)
    key = (target, ref or "")
    now = time.time()
    with _IMG_LOCK:
        hit = _IMG_CACHE.get(key)
        if hit and now - hit["ts"] < _IMG_TTL:
            return hit["type"], hit["data"]
        if hit:
            _IMG_CACHE.pop(key, None)
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    }
    if ref:
        headers["Referer"] = ref
    try:
        # 走池：连接复用 + 流式限量读取，超大资源在读的过程中就断掉
        r = _http_submit(_http_read, target, headers, 15, False, _IMG_ITEM_MAX)
    except requests.exceptions.RequestException as e:
        raise RuntimeError("资源请求失败：%s" % e)
    if r.status_code >= 400:
        raise RuntimeError("资源返回 HTTP %d" % r.status_code)
    ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    ok_type = (ctype.startswith("image/") or ctype.startswith("font/")
               or ctype in ("application/font-woff", "application/font-woff2",
                            "application/vnd.ms-fontobject", "application/octet-stream"))
    if not ok_type:
        raise RuntimeError("不是图片 / 字体资源：%s" % (ctype or "unknown"))
    data = r.content or b""
    if len(data) > _IMG_ITEM_MAX:
        raise RuntimeError("资源过大（%.1f MB）" % (len(data) / 1048576.0))
    global _IMG_SIZE
    with _IMG_LOCK:
        old = _IMG_CACHE.pop(key, None)
        if old:
            _IMG_SIZE -= len(old["data"])
        _IMG_CACHE[key] = {"type": ctype, "data": data, "ts": now}
        _IMG_SIZE += len(data)
        # 过期条目平时只在「再次访问同一资源」时才被清掉，没人再访问的就一直占着内存；
        # 每次插入顺带扫一遍，把过期的一并释放（总量上限兜底之外再加一层保险）
        for k in [k for k, v in _IMG_CACHE.items()
                  if k != key and now - v["ts"] > _IMG_TTL]:
            v = _IMG_CACHE.pop(k, None)
            if v:
                _IMG_SIZE -= len(v["data"])
        while _IMG_SIZE > _IMG_TOTAL_MAX and len(_IMG_CACHE) > 1:
            k, v = next(iter(_IMG_CACHE.items()))
            if k == key:
                break
            _IMG_CACHE.pop(k, None)
            _IMG_SIZE -= len(v["data"])
    return ctype, data


_STYLE_URL_RE = re.compile(r"url\(\s*(['\"]?)([^)'\"]+)\1\s*\)", re.I)


def _rewrite_style_urls(style, base_url, prefix=""):
    def rep(m):
        u = m.group(2).strip()
        if not u or u.startswith(("data:", "blob:", "#")):
            return m.group(0)
        return "url(%s)" % proxy_src(u, base_url, prefix)
    return _STYLE_URL_RE.sub(rep, style)


_LAZY_ATTRS = ("data-src", "data-original", "data-lazy-src", "data-actualsrc",
               "data-echo", "data-url")


def _rewrite_media(soup, base_url, prefix=""):
    """图片全部走本地代理；懒加载图直接补成真地址（脚本被去掉后它们永远不会自己加载）。"""
    for el in soup.find_all(["img", "source", "video", "audio"]):
        lazy = ""
        for attr in _LAZY_ATTRS:
            v = str(el.get(attr) or "").strip()
            if v and not v.startswith("data:"):
                lazy = v
                break
        src = str(el.get("src") or "").strip()
        placeholder = (not src) or src.startswith("data:") or ("blank" in src.lower()) or ("placeholder" in src.lower())
        if lazy and placeholder:
            try:
                el["src"] = proxy_src(lazy, base_url, prefix)
            except Exception:
                pass
        elif src and not src.startswith("data:"):
            try:
                el["src"] = proxy_src(src, base_url, prefix)
            except Exception:
                pass
        if el.get("poster"):
            try:
                el["poster"] = proxy_src(el.get("poster"), base_url, prefix)
            except Exception:
                pass
        srcset = el.get("srcset")
        if srcset:
            parts = []
            for cand in str(srcset).split(","):
                seg = cand.strip()
                if not seg:
                    continue
                bits = seg.split()
                try:
                    bits[0] = proxy_src(bits[0], base_url, prefix)
                except Exception:
                    pass
                parts.append(" ".join(bits))
            el["srcset"] = ", ".join(parts)
        for attr in _LAZY_ATTRS + ("loading",):
            if el.has_attr(attr):
                del el.attrs[attr]

    # 内联 style 里的 background-image:url(...)
    for el in soup.find_all(style=True):
        style = str(el.get("style") or "")
        if "url(" in style.lower():
            try:
                el["style"] = _rewrite_style_urls(style, base_url, prefix)
            except Exception:
                pass


# ------------------------------------------- 站点镜像（JS / CSS / 图片全走代理）
# 交互预览要让站点脚本真的跑起来，但不能让浏览器直连源站：
#   · 内网 / 墙外站点的资源浏览器根本请求不到；
#   · 直连要带 Cookie / Referer 才能拿到数据，浏览器跨域又会被 CORS 拦。
# 所以把页面里所有资源地址改写成 /api/scraper/mirror/<token>/<scheme>/<host>/<path>，
# 由服务端带请求头代取；路径结构保持不变，模块里的相对 import（./chunk.js）自然能命中。
def mirror_base_of(asset_prefix, token):
    if not asset_prefix or not token:
        return ""
    return asset_prefix.rstrip("/") + "/api/scraper/mirror/" + token + "/"


def live_preview_url(mirror_base, page_url):
    """交互预览的 iframe 地址：不用 /api/scraper/preview/<token>，而是镜像路径里
    页面同目录下的一个魔法文件名。

    为什么：不透明源里 location.origin 是 "null"，但 location.href 仍是真实地址；
    站点脚本大量使用 new URL(x, location.href)、location.href.split() 之类按文档
    地址推导接口路径的写法 —— 文档地址落在镜像里页面的同目录下，这些推导才能得到
    能被镜像代理接住的地址，而不是打到预览路由 / 站点根上的 404。
    """
    if not mirror_base:
        return ""
    u = mirror_url(page_url, page_url, mirror_base)
    u = u.split("#")[0].split("?")[0]
    return u.rstrip("/") + "/__scr_preview__.html"


def mirror_url(url, page_url, mirror_base):
    """把站点资源地址换成镜像地址；data: / # / javascript: 这类原样返回。"""
    raw = str(url or "").strip()
    if not mirror_base or not raw:
        return raw
    if raw.startswith(("data:", "blob:", "#", "javascript:", "mailto:", "tel:", "about:")):
        return raw
    if raw.startswith(mirror_base):
        return raw
    absu = _abs_url(raw, page_url)
    low = absu.lower()
    if not low.startswith(("http://", "https://")):
        return raw
    p = urlparse(absu)
    if not p.netloc:
        return raw
    out = mirror_base + p.scheme + "/" + p.netloc + (p.path or "/")
    if p.query:
        out += "?" + p.query
    if p.fragment:
        out += "#" + p.fragment
    return out


def mirror_target(rest, query=""):
    """还原镜像路径 → 真实地址：https/v.qq.com/a.js → https://v.qq.com/a.js"""
    rest = (rest or "").lstrip("/")
    scheme, _, remainder = rest.partition("/")
    scheme = scheme.lower()
    if scheme not in ("http", "https") or not remainder:
        raise ValueError("镜像地址不合法")
    target = scheme + "://" + remainder
    if query:
        target += "?" + query
    return target


# 需要改写地址的属性：按标签区分，避免误伤 value / content 之类的普通属性
_MIRROR_ATTRS = {
    "a": ("href",), "area": ("href",), "link": ("href",), "script": ("src",),
    "img": ("src",), "source": ("src",), "video": ("src", "poster"),
    "audio": ("src",), "track": ("src",), "iframe": ("src",), "frame": ("src",),
    "embed": ("src",), "object": ("data",), "form": ("action",), "input": ("src",),
    "use": ("href", "xlink:href"), "image": ("href", "xlink:href"),
    "blockquote": ("cite",), "q": ("cite",), "body": ("background",),
    "table": ("background",), "td": ("background",), "th": ("background",),
}


def _rewrite_srcset(value, base_url, mirror_base):
    parts = []
    for cand in str(value or "").split(","):
        seg = cand.strip()
        if not seg:
            continue
        bits = seg.split()
        bits[0] = mirror_url(bits[0], base_url, mirror_base)
        parts.append(" ".join(bits))
    return ", ".join(parts)


def _rewrite_all_links(soup, base_url, mirror_base, no_img=False):
    """交互预览：页面上所有资源 / 跳转地址都改走镜像。no_img=True 时图片类标签跳过（直连原站）。"""
    for tag, attrs in _MIRROR_ATTRS.items():
        if no_img and tag in ("img", "source", "video", "audio"):
            continue
        for el in soup.find_all(tag):
            for attr in attrs:
                v = el.get(attr)
                if v:
                    try:
                        el[attr] = mirror_url(v, base_url, mirror_base)
                    except Exception:
                        pass
            if el.has_attr("srcset"):
                try:
                    el["srcset"] = _rewrite_srcset(el.get("srcset"), base_url, mirror_base)
                except Exception:
                    pass
            if el.has_attr("imagesrcset"):
                try:
                    el["imagesrcset"] = _rewrite_srcset(el.get("imagesrcset"), base_url, mirror_base)
                except Exception:
                    pass
            # 地址被改写后原文件的 SRI 摘要必然对不上，浏览器会直接拒绝执行
            if el.has_attr("integrity"):
                del el.attrs["integrity"]

    for el in soup.find_all(style=True):
        style = str(el.get("style") or "")
        if "url(" in style.lower():
            try:
                el["style"] = _rewrite_css_text(style, base_url, mirror_base)
            except Exception:
                pass
    for st in soup.find_all("style"):
        try:
            if st.string:
                st.string.replace_with(_rewrite_css_text(str(st.string), base_url, mirror_base))
        except Exception:
            pass
    # preload / modulepreload 只是首屏加速提示：地址改成镜像后浏览器缓存键对不上，
    # 控制台会一直刷「preloaded but not used within a few seconds」。直接去掉，
    # 真正用到时 import / stylesheet 照样会去拉，镜像那边还有内存缓存。
    for link in soup.find_all("link"):
        rel = " ".join(link.get("rel") or []).lower()
        if "preload" in rel or "prefetch" in rel:
            link.decompose()

    # importmap 里也是地址，不改写模块名就解析不到
    for sc in soup.find_all("script", attrs={"type": "importmap"}):
        try:
            txt = sc.string or ""
            txt = re.sub(r"""(["'])((?:https?:)?/[^"']+)\1""",
                         lambda m: m.group(1) + mirror_url(m.group(2), base_url, mirror_base) + m.group(1),
                         txt)
            sc.string = txt
        except Exception:
            pass


_CSS_URL_RE2 = re.compile(r"""url\(\s*(['"]?)([^)'"]+)\1\s*\)""", re.I)
_CSS_IMPORT_RE = re.compile(r"""@import\s+(['"])([^'"]+)\1""", re.I)


def _rewrite_css_text(text, base_url, mirror_base):
    """CSS 里的 url() / @import 也要走镜像，否则背景图、字体、分包样式全 404。"""
    if not mirror_base or not text:
        return text

    def rep_url(m):
        u = (m.group(2) or "").strip()
        if not u or u.startswith(("data:", "blob:", "#")):
            return m.group(0)
        return 'url("%s")' % mirror_url(u, base_url, mirror_base)

    def rep_imp(m):
        u = (m.group(2) or "").strip()
        if not u or u.startswith(("data:", "blob:")):
            return m.group(0)
        return '@import "%s"' % mirror_url(u, base_url, mirror_base)

    out = _CSS_URL_RE2.sub(rep_url, text)
    return _CSS_IMPORT_RE.sub(rep_imp, out)


_JS_FROM_RE = re.compile(r"""(\bfrom\s*)(['"])([^'"\n]+)\2""")
_JS_IMPORT_RE = re.compile(r"""(\bimport\s*\(\s*)(['"])([^'"\n]+)\2""")
_JS_SIDE_RE = re.compile(r"""(\bimport\s+)(['"])([^'"\n]+)\2""")
_JS_MAP_RE = re.compile(r"""^[ \t]*//[#@]\s*sourceMappingURL=.*$""", re.M)


def _rewrite_js_text(text, base_url, mirror_base):
    """ESM 里的 import / export ... from 改成镜像地址（相对路径本来就能命中，这里只补绝对地址）。"""
    if not mirror_base or not text:
        return text

    def fix(spec):
        s = (spec or "").strip()
        if not s.startswith(("/", "//", "http://", "https://")):
            return spec          # 相对 / 裸模块名：交给浏览器按当前路径解析
        return mirror_url(s, base_url, mirror_base)

    def mk(prefix_group=1):
        def rep(m):
            return m.group(prefix_group) + m.group(2) + fix(m.group(3)) + m.group(2)
        return rep

    out = _JS_FROM_RE.sub(mk(), text)
    out = _JS_IMPORT_RE.sub(mk(), out)
    out = _JS_SIDE_RE.sub(mk(), out)
    # sourceMappingURL 指向的是原站路径，留着只会在控制台多一条 404
    return _JS_MAP_RE.sub("", out)


_AGENT_CACHE = {"text": "", "ts": 0.0}


def agent_js():
    """读取注入到预览页里的代理脚本（内联下发：sandbox 不透明源拿不到 Cookie，
    走 /static 会被登录校验拦掉，内联最稳）。"""
    now = time.time()
    if _AGENT_CACHE["text"] and now - _AGENT_CACHE["ts"] < 5:
        return _AGENT_CACHE["text"]
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), "static", "js", "scraper-agent.js")
    try:
        with io.open(path, "r", encoding="utf-8") as fh:
            _AGENT_CACHE["text"] = fh.read()
    except Exception as e:
        _log.warning("读取代理脚本失败: %s", e)
        _AGENT_CACHE["text"] = ""
    _AGENT_CACHE["ts"] = now
    return _AGENT_CACHE["text"]


# ------------------------------------------------------- 镜像资源抓取 + 缓存
_MIRROR_TTL = 900
_MIRROR_ITEM_MAX = 24 * 1024 * 1024
_MIRROR_TOTAL_MAX = 64 * 1024 * 1024    # 内存优化：128MB → 64MB，命中不足时重新代取即可
_MIRROR_CACHE = {}
_MIRROR_SIZE = 0
_MIRROR_LOCK = threading.Lock()

_TEXT_TYPES = ("text/html", "application/xhtml+xml", "text/css",
               "text/javascript", "application/javascript", "application/x-javascript",
               "application/ecmascript", "module", "image/svg+xml",
               "application/json", "text/plain")


def _decode_body(resp):
    enc = (resp.encoding or "").lower()
    ctype = (resp.headers.get("Content-Type") or "").lower()
    if not enc or enc in ("iso-8859-1", "latin-1", "ascii"):
        enc = ""
    if not enc:
        m = re.search(r"charset=([\w-]+)", ctype)
        if m:
            enc = m.group(1).lower()
    if not enc or enc in ("iso-8859-1", "latin-1", "ascii"):
        try:
            enc = resp.apparent_encoding or "utf-8"
        except Exception:
            enc = "utf-8"
    try:
        return resp.content.decode(enc, "ignore")
    except Exception:
        return resp.content.decode("utf-8", "ignore")


def fetch_mirror(target, page_url, hdrs=None, insecure=False, token="",
                 mirror_base="", asset_prefix="", accept="", method="GET", body=None):
    """代取一个站点资源并改写其中的地址，返回 {status, ctype, data} 或 {redirect}。

    网络请求和 HTML / JS 改写都丢进固定大小的线程池（见「出站 HTTP」）：请求线程
    只查缓存、写缓存，不再各自解析几 MB 的 DOM，避免并发一高就新开一堆 malloc arena。
    """
    target = check_url(target)
    method = (method or "GET").upper()
    key = (token, target, accept, method, len(body or b""))
    now = time.time()
    with _MIRROR_LOCK:
        hit = _MIRROR_CACHE.get(key) if method in ("GET", "HEAD") else None
        if hit and now - hit["ts"] < _MIRROR_TTL:
            return {"status": hit["status"], "ctype": hit["ctype"], "data": hit["data"]}
        if hit:
            _MIRROR_CACHE.pop(key, None)

    res = _http_submit(_mirror_job, target, page_url, hdrs, insecure, mirror_base,
                       asset_prefix, accept, method, body)
    if res.get("redirect"):
        return res
    global _MIRROR_SIZE
    data = res.get("data") or b""
    with _MIRROR_LOCK:
        old = _MIRROR_CACHE.pop(key, None)
        if old:
            _MIRROR_SIZE -= len(old["data"])
        _MIRROR_CACHE[key] = {"status": res["status"], "ctype": res["ctype"],
                              "data": data, "ts": now}
        _MIRROR_SIZE += len(data)
        # key 带预览 token，重新抓一次页面旧 token 的条目就再也命中不了；
        # 光靠总量上限兜底会让它们一直占着内存，插入时顺手清掉过期的
        for k in [k for k, v in _MIRROR_CACHE.items()
                  if k != key and now - v["ts"] > _MIRROR_TTL]:
            v = _MIRROR_CACHE.pop(k, None)
            if v:
                _MIRROR_SIZE -= len(v["data"])
        while _MIRROR_SIZE > _MIRROR_TOTAL_MAX and len(_MIRROR_CACHE) > 1:
            k, v = next(iter(_MIRROR_CACHE.items()))
            if k == key:
                break
            _MIRROR_CACHE.pop(k, None)
            _MIRROR_SIZE -= len(v["data"])
    return res


def _mirror_job(target, page_url, hdrs, insecure, mirror_base, asset_prefix,
                accept, method, body):
    """池线程里执行：发请求 → 解码 → 改写地址。大对象只在这几个线程里分配/释放。"""
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": accept or "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if page_url:
        headers["Referer"] = page_url
    for k, v in (hdrs or {}).items():
        k = str(k or "").strip()
        if not k or v in (None, ""):
            continue
        # 这几个头由 requests 自己算 / 必须由代理改写，照搬会导致内容长度、压缩、
        # 跨域来源对不上（Referer 用原页面，Origin 由站点自己带）
        if k.lower() in ("host", "content-length", "accept-encoding", "connection",
                         "referer", "origin", "cookie2", "accept"):
            continue
        headers[k] = str(v)

    try:
        r = _http_read(target, headers, timeout=20, insecure=insecure,
                       max_bytes=_MIRROR_ITEM_MAX, method=method, body=body)
    except requests.exceptions.RequestException as e:
        raise RuntimeError("资源请求失败：%s" % e)
    if r.history and r.url and r.url != target:
        return {"redirect": r.url}

    status = r.status_code
    ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    raw = r.content or b""
    if len(raw) > _MIRROR_ITEM_MAX:
        raise RuntimeError("资源过大（%.1f MB）" % (len(raw) / 1048576.0))

    data = raw
    if ctype in _TEXT_TYPES:
        text = _decode_body(r)
        if ctype in ("text/html", "application/xhtml+xml"):
            text = clean_html(text, r.url, asset_prefix=asset_prefix,
                              keep_scripts=True, mirror_base=mirror_base)
            ctype = "text/html"
        elif ctype == "text/css":
            text = _rewrite_css_text(text, r.url, mirror_base)
        elif "javascript" in ctype or ctype == "module":
            text = _rewrite_js_text(text, r.url, mirror_base)
        data = text.encode("utf-8", "ignore")
        ctype = ctype + "; charset=utf-8"
    return {"status": status, "ctype": ctype, "data": data}


def _promote_lazy(soup, base_url):
    """不代理图片模式：只把懒加载的真实地址补成绝对地址（浏览器直连源站），src 保持原样。"""
    for el in soup.find_all(["img", "source", "video", "audio"]):
        for attr in _LAZY_ATTRS:
            v = str(el.get(attr) or "").strip()
            if v and not v.startswith("data:"):
                if not str(el.get("src") or "").strip():
                    try:
                        el["src"] = _abs_url(v, base_url)
                    except Exception:
                        pass
                break
        for attr in _LAZY_ATTRS:
            if el.has_attr(attr):
                del el.attrs[attr]


def clean_html(raw, base_url, asset_prefix="", keep_scripts=False, mirror_base="", no_img=False):
    """清洗预览用 HTML。

    keep_scripts=False（默认）：去脚本 / 去事件属性 / 图片改走代理，安全但站点特效不跑；
    keep_scripts=True（交互预览）：保留站点脚本（轮播 / 点击 / 滚动加载才能工作），
    并且把页面上所有资源地址改写成 mirror_base 开头的镜像地址 —— 脚本、样式、图片、
    接口全部由服务端代取，浏览器不直连源站；再由 iframe 的 sandbox 负责隔离。
    no_img=True：图片资源不做代理改写，src 保持原站地址（预览更快，防盗链站可能裂图）。
    """
    soup = BeautifulSoup(raw or "", "html.parser")
    # CSP / refresh 两种模式都要去掉：前者会挡掉我们的注入脚本与高亮样式，后者会把 iframe 跳走
    for meta in soup.find_all("meta"):
        equiv = str(meta.get("http-equiv") or "").strip().lower()
        if equiv in ("content-security-policy", "refresh", "x-frame-options"):
            meta.decompose()

    if keep_scripts and mirror_base:
        # 交互预览：脚本照跑，但地址全部改走镜像（相对地址靠 <base> 指向镜像根）
        try:
            _rewrite_all_links(soup, base_url, mirror_base, no_img=no_img)
        except Exception as e:
            _log.warning("预览资源镜像改写失败: %s", e)
    elif not keep_scripts:
        for tag in soup(["script", "noscript", "template", "object", "embed", "iframe", "frame"]):
            tag.decompose()
        # <link rel="modulepreload"> / <link rel="preload" as="script"> 虽然不带 <script> 标签，
        # 浏览器照样会去下载站点 JS（再被 CSP 拦成一条红色报错）。这里一并清掉。
        for link in soup.find_all("link"):
            rel = " ".join(link.get("rel") or []).lower()
            as_ = str(link.get("as") or "").strip().lower()
            drop = ("modulepreload" in rel or "prefetch" in rel or "preconnect" in rel
                    or "dns-prefetch" in rel or "manifest" in rel
                    or ("preload" in rel and as_ in ("script", "fetch", "worker",
                                                     "sharedworker", "serviceworker",
                                                     "image", "video", "audio")))
            if drop:
                link.decompose()
        for el in soup.find_all(True):
            for name in list(el.attrs):
                low = str(name).lower()
                if low.startswith("on") or low in ("srcdoc", "formaction"):
                    del el.attrs[name]
        try:
            if no_img:
                _promote_lazy(soup, base_url)   # 只补懒加载真地址，不做代理改写
            else:
                _rewrite_media(soup, base_url, asset_prefix)
        except Exception as e:
            _log.warning("预览资源改写失败: %s", e)

    # <base>：让预览里的相对路径（图片 / 样式）按原站点解析
    head = soup.head
    if head is None:
        head = soup.new_tag("head")
        if soup.html is not None:
            soup.html.insert(0, head)
        elif soup.body is not None:
            soup.body.insert_before(head)
        else:
            soup.insert(0, head)
    # <base>：镜像模式下指向镜像里的页面地址，这样脚本里的相对地址也自动落到代理上
    base_href = base_url
    if keep_scripts and mirror_base:
        base_href = mirror_url(base_url, base_url, mirror_base)
    try:
        head.insert(0, soup.new_tag("base", href=base_href))
    except Exception:
        pass
    # 交互预览：先告诉代理脚本镜像前缀 / 站点源，再内联注入（内联是为了躲开登录校验，
    # sandbox 不透明源的请求不带 Cookie，去 /static 拿会被 401 拦掉）
    if keep_scripts:
        try:
            cfg = soup.new_tag("script")
            cfg.string = ("window.__SCR_NO_IMG__=%s;window.__SCR_MIRROR__=%s;window.__SCR_SITE__=%s;window.__SCR_PAGE__=%s;"
                          % (json.dumps(bool(no_img and keep_scripts)),
                             json.dumps(mirror_base or ""), json.dumps(_origin_of(base_url)),
                             json.dumps(base_url)))
            head.insert(0, cfg)
        except Exception:
            pass
        js = agent_js()
        if js:
            try:
                tag = soup.new_tag("script")
                tag.string = js
                head.insert(0, tag)
            except Exception:
                pass
    return str(soup)


def _origin_of(url):
    try:
        p = urlparse(url or "")
        if p.scheme and p.netloc:
            return "%s://%s" % (p.scheme, p.netloc)
    except Exception:
        pass
    return ""


def _title_of(soup):
    try:
        t = soup.title
        return (t.get_text(" ", strip=True) if t else "")[:300]
    except Exception:
        return ""


_BLOCK_WORDS = ("验证码", "安全验证", "人机验证", "滑动验证", "访问过于频繁",
                "just a moment", "attention required", "access denied", "captcha")


def blocked_reason(text):
    """识别「人机验证 / 拒绝访问」这类反爬拦截页，返回标题方便提示用户。"""
    try:
        title = _title_of(BeautifulSoup(text or "", "html.parser"))
    except Exception:
        return ""
    low = title.lower()
    for w in _BLOCK_WORDS:
        if w in low:
            return title
    return ""


def fetch_page(url, headers=None, timeout=25, insecure=False, keep_html=True,
               asset_prefix="", render=False, scroll_times=0, interactive=False,
               no_img=False, low_mem=False):
    """请求一个页面，返回 {url, status, title, preview, bytes, cost_ms, rendered[, html]}。

    render=True 时改用无头浏览器执行站点脚本（懒加载 / 无限滚动只有这样才能出来），
    scroll_times：打开后先自动往下滚几屏再取 DOM。此时 preview 会绑定渲染会话，
    前端可以继续「滚动加载更多」。
    """
    target = check_url(url)
    hdrs = {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    for k, v in (headers or {}).items():
        k = str(k or "").strip()
        if k and v not in (None, ""):
            hdrs[k] = str(v)
    timeout = max(3, min(60, int(timeout or 25)))
    t0 = time.time()
    session_token = ""
    final_url = target
    status = 200
    text = ""

    if render:
        from . import render as render_mod
        sess = render_mod.open_session(target, headers=hdrs, insecure=insecure, timeout=timeout,
                                       low_mem=low_mem)
        session_token = sess.token
        final_url = sess.page_url or target
        text = sess.html or ""
        if scroll_times:
            text, _y = sess.scroll(times=scroll_times)
        stop = blocked_reason(text)
        if stop:
            raise RuntimeError(
                "站点返回了人机验证页（%s）。这种情况换 IP 或在该站登录一次，把 Cookie 填到「高级」里再抓。"
                % stop)
    else:
        try:
            r = requests.get(target, headers=hdrs, timeout=timeout,
                             verify=not insecure, allow_redirects=True)
        except requests.exceptions.SSLError as e:
            raise RuntimeError("HTTPS 证书校验失败（%s）；可在「高级」里勾选忽略证书错误" % e)
        except requests.exceptions.Timeout:
            raise RuntimeError("请求超时（%d 秒）" % timeout)
        except requests.exceptions.RequestException as e:
            raise RuntimeError("请求失败：%s" % e)

        ctype = (r.headers.get("Content-Type") or "").lower()
        if "charset" not in ctype:
            try:
                r.encoding = r.apparent_encoding or r.encoding or "utf-8"
            except Exception:
                pass
        else:
            # 不少站点把 charset 写成 iso-8859-1（实则 UTF-8 / GBK），按实际内容纠正，避免中文乱码
            declared = (r.encoding or "").lower()
            if declared in ("iso-8859-1", "latin-1", "ascii"):
                try:
                    if r.apparent_encoding:
                        r.encoding = r.apparent_encoding
                except Exception:
                    pass
        text = r.text or ""
        final_url = r.url
        status = r.status_code
        if r.status_code >= 400:
            raise RuntimeError("目标站点返回 HTTP %d" % r.status_code)
        if "json" in ctype and "<" not in text[:200]:
            raise RuntimeError("该地址返回的是 JSON 接口而不是网页，暂不支持直接预览")

    limit = MAX_RENDER_HTML if render else MAX_HTML
    if len(text.encode("utf-8", "ignore")) > limit:
        text = text.encode("utf-8", "ignore")[:limit].decode("utf-8", "ignore")

    soup = BeautifulSoup(text, "html.parser")
    title = _title_of(soup)
    live = bool(interactive)
    # 镜像地址里要带 token，所以先定 token 再清洗 HTML
    token = uuid.uuid4().hex
    mirror_base = mirror_base_of(asset_prefix, token) if live else ""
    html = clean_html(text, final_url, asset_prefix, keep_scripts=live, mirror_base=mirror_base,
                      no_img=no_img)
    cache_preview(html, final_url, session_token, live=live, hdrs=hdrs,
                  insecure=insecure, token=token)
    out = {
        "url": final_url,
        "status": status,
        "title": title,
        "preview": (live_preview_url(mirror_base, final_url)
                    if live and mirror_base
                    else "/api/scraper/preview/" + token),
        "mirror": mirror_base,
        "bytes": len(text.encode("utf-8", "ignore")),
        "cost_ms": int((time.time() - t0) * 1000),
        "rendered": bool(render),
        "interactive": live,
    }
    if keep_html:
        out["html"] = html
    return out


# ----------------------------------------------------------------- 提取

def _clip(text):
    s = str(text if text is not None else "")
    s = re.sub(r"[ \t\u00a0]+", " ", s)
    s = re.sub(r"\s*\n\s*", "\n", s).strip()
    return s[:CELL_MAX]


def _abs_url(value, base):
    v = str(value or "").strip()
    if not v:
        return ""
    low = v.lower()
    if low.startswith(("javascript:", "data:", "mailto:", "tel:", "#")):
        return v
    try:
        return urljoin(base or "", v)
    except Exception:
        return v


def normalize_fields(fields):
    """字段配置归一化：名字 / 选择器 / 取值类型 / 属性名 / 是否多值。"""
    out = []
    for i, f in enumerate(fields or []):
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or "").strip() or ("字段%d" % (i + 1))
        ftype = str(f.get("type") or "text").strip().lower()
        if ftype not in _FIELD_TYPES:
            ftype = "text"
        out.append({
            "name": name,
            "selector": str(f.get("selector") or "").strip(),
            "type": ftype,
            "attr": str(f.get("attr") or "").strip() or ("href" if ftype == "attr" else ""),
            "multi": bool(f.get("multi")),
            "absolute": f.get("absolute", True) is not False,
            "replaces": [
                {"find": str(r.get("find") or ""), "to": str(r.get("to") or ""), "regex": bool(r.get("regex"))}
                for r in (f.get("replaces") or []) if isinstance(r, dict)
            ],
            "prefix": str(f.get("prefix") or ""),
            "suffix": str(f.get("suffix") or ""),
        })
    return out


def _apply_rules(v, field):
    """字段取值规则：字符串替换（普通 / 正则）→ 前后缀拼接（值非空才拼）。"""
    s = str(v if v is not None else "")
    for r in field.get("replaces") or []:
        find = str(r.get("find") or "")
        if not find:
            continue
        try:
            if r.get("regex"):
                s = re.compile(find).sub(str(r.get("to") or ""), s)
            else:
                s = s.replace(find, str(r.get("to") or ""))
        except Exception:
            pass
    pre = str(field.get("prefix") or "")
    suf = str(field.get("suffix") or "")
    if s and (pre or suf):
        s = pre + s + suf
    return s


def _select_nodes(root, selector):
    sel = str(selector or "").strip()
    if not sel or sel == ".":
        return []
    if sel.startswith(">"):
        sel = sel[1:].strip()
    try:
        return root.select(sel)
    except Exception:
        return []


# ------------------------------------------------------- XPath（高级选择器）
def is_xpath(sel):
    """以 / 或 (// 开头就当 XPath，其余按 CSS 选择器处理。"""
    s = str(sel or "").strip()
    return s.startswith(("/", ".//", "(//", "(.//"))


def _xpath_expr(sel):
    # `//div/a` 在片段里等价于 `.//div/a`；显式补上 `.` 让浏览器 / lxml 语义一致
    s = str(sel or "").strip()
    return "." + s if s.startswith("//") else s


def _lxml_frag(root):
    from lxml import html as lxml_html
    return lxml_html.fromstring(str(root))


def _select_by_xpath(html, sel):
    """用 XPath 在整页里选「列表项」，转成 bs4 元素后交给字段提取。"""
    from lxml import html as lxml_html
    try:
        tree = lxml_html.fromstring(html or "")
    except Exception as e:
        raise ValueError("页面解析失败：%s" % e)
    try:
        nodes = tree.xpath(_xpath_expr(sel))
    except Exception as e:
        raise ValueError("XPath 不合法：%s" % e)
    out = []
    for n in nodes:
        if isinstance(n, str) or not hasattr(n, "tag"):
            continue
        try:
            out.append(BeautifulSoup(lxml_html.tostring(n, encoding="unicode"), "html.parser"))
        except Exception:
            continue
    return out


def _xpath_value(node, field, base_url):
    if node is None:
        return ""
    # `//a/@href`、`//span/text()` 这类直接出字符串 / 数字的写法
    if isinstance(node, (str, int, float, bool)):
        return _clip(node)
    t = field["type"]
    try:
        if t == "attr":
            v = node.get(field["attr"] or "href") or ""
            if field.get("absolute", True) and field["attr"] in ("href", "src"):
                v = _abs_url(v, base_url)
            return _clip(v)
        if t == "html":
            from lxml import html as lxml_html
            inner = (node.text or "") + "".join(
                lxml_html.tostring(c, encoding="unicode") for c in node)
            return _clip(inner)
        return _clip(" ".join((node.text_content() or "").split()))
    except Exception:
        return ""


def _cell_xpath(root, field, base_url):
    try:
        frag = _lxml_frag(root)
        nodes = frag.xpath(_xpath_expr(field["selector"]))
    except Exception:
        return ""
    if nodes is None:
        return ""
    if not isinstance(nodes, list):
        nodes = [nodes]
    if field["multi"]:
        vals = [_unproxy(_xpath_value(n, field, base_url)) for n in nodes]
        return _clip(_apply_rules(" | ".join([v for v in vals if v]), field))
    for n in nodes:
        v = _unproxy(_xpath_value(n, field, base_url))
        if v:
            return _clip(_apply_rules(v, field))
    return ""


# 同时兼容三种写法：相对代理地址、带本站源（http://host:port/api/...）的绝对地址、
# 以及 bs4 序列化后 `&` 被转义成 `&amp;` 的情况
_PROXY_URL_RE = re.compile(
    r"(?:https?://[^/\"'\s]+)?/api/scraper/proxy\?u=([^&\"'\s]+)"
    r"(?:(?:&amp;|&)ref=[^\"'&\s]*)?")

# 交互预览里的镜像地址：/api/scraper/mirror/<token>/<scheme>/<host><path>
_MIRROR_URL_RE = re.compile(
    r"(?:https?://[^/\"'\s]+)?/api/scraper/mirror/[0-9a-zA-Z]+/"
    r"(https?)/([^/\"'?\s]+)([^\"'\s]*)")


def _unproxy(value):
    """预览时图片被改写成了本地代理 / 镜像地址；采集结果里要还原成原始地址再导出。"""
    s = str(value if value is not None else "")
    if "/api/scraper/proxy?" in s:
        s = _PROXY_URL_RE.sub(lambda m: unquote(m.group(1)), s)
    if "/api/scraper/mirror/" in s:
        s = _MIRROR_URL_RE.sub(
            lambda m: "%s://%s%s" % (m.group(1), m.group(2), m.group(3) or ""), s)
    return s


def _cell(root, field, base_url):
    """从一个「列表项」里取一个字段的值（CSS 或 XPath 都支持）。"""
    sel = field["selector"]
    if is_xpath(sel):
        return _cell_xpath(root, field, base_url)
    nodes = [root] if (not sel or sel == ".") else _select_nodes(root, sel)
    if not nodes:
        return ""
    if field["multi"]:
        vals = [_unproxy(_value(n, field, base_url)) for n in nodes]
        return _clip(_apply_rules(" | ".join([v for v in vals if v]), field))
    return _clip(_apply_rules(_unproxy(_value(nodes[0], field, base_url)), field))


def _value(el, field, base_url):
    t = field["type"]
    try:
        if t == "html":
            return _clip(el.decode_contents())
        if t == "attr":
            v = el.get(field["attr"] or "href")
            if isinstance(v, (list, tuple)):
                v = " ".join([str(x) for x in v])
            v = str(v or "").strip()
            if field.get("absolute", True) and field["attr"] in ("href", "src"):
                v = _abs_url(v, base_url)
            return _clip(v)
        return _clip(el.get_text(" ", strip=True))
    except Exception:
        return ""


def extract_rows(html, item_selector, fields, base_url="", limit=0):
    """按规则从一页 HTML 里提取数据行。"""
    fields = normalize_fields(fields)
    if not fields:
        raise ValueError("请先添加至少一个字段")
    soup = BeautifulSoup(html or "", "html.parser")
    sel = str(item_selector or "").strip()
    if sel:
        if is_xpath(sel):
            roots = _select_by_xpath(html, sel)
        else:
            try:
                roots = soup.select(sel)
            except Exception as e:
                raise ValueError("列表项选择器不合法：%s" % e)
    else:
        roots = [soup]
    rows = []
    for root in roots:
        row = {}
        for f in fields:
            row[f["name"]] = _cell(root, f, base_url)
        rows.append(row)
        if limit and len(rows) >= int(limit):
            break
    return rows


def count_matches(html, item_selector):
    """预览时用：这个选择器在页面里能匹配到多少个元素（CSS / XPath 都行）。"""
    sel = str(item_selector or "").strip()
    if not sel:
        return 0
    if is_xpath(sel):
        try:
            from lxml import html as lxml_html
            return len(lxml_html.fromstring(html or "").xpath(_xpath_expr(sel)))
        except Exception:
            return 0
    try:
        return len(BeautifulSoup(html or "", "html.parser").select(sel))
    except Exception:
        return 0


_NEXT_WORDS = ("下一页", "下页", "后一页", "next", "›", "»", ">")


def find_next_url(html, next_selector, base_url):
    """从当前页找「下一页」的绝对地址；找不到返回空串。"""
    sel = str(next_selector or "").strip()
    if is_xpath(sel):
        try:
            from lxml import html as lxml_html
            nodes = lxml_html.fromstring(html or "").xpath(_xpath_expr(sel))
        except Exception:
            nodes = []
        for n in nodes:
            if isinstance(n, str):
                href = n
            else:
                href = n.get("href") if getattr(n, "tag", "") == "a" else ""
                if not href:
                    try:
                        hs = n.xpath(".//a/@href")
                        href = hs[0] if hs else ""
                    except Exception:
                        href = ""
            href = str(href or "").strip()
            if href and not href.lower().startswith(("javascript:", "#")):
                return _abs_url(href, base_url)
        return ""
    soup = BeautifulSoup(html or "", "html.parser")
    el = None
    if sel:
        try:
            el = soup.select_one(sel)
        except Exception:
            el = None
    else:
        el = soup.select_one('a[rel="next"]')
        if el is None:
            for a in soup.find_all("a"):
                txt = a.get_text(" ", strip=True).lower()
                if txt and any(w in txt for w in _NEXT_WORDS) and a.get("href"):
                    el = a
                    break
    if el is None:
        return ""
    if el.name != "a":
        inner = el.find("a")
        if inner is not None:
            el = inner
    href = el.get("href") if el is not None else ""
    href = str(href or "").strip()
    if not href or href.lower().startswith(("javascript:", "#")):
        return ""
    return _abs_url(href, base_url)


# ----------------------------------------------------------------- 批量采集

def crawl(url, fields, item_selector="", pages=1, page_mode="none", url_template="",
          next_selector="", delay_ms=300, headers=None, timeout=25, insecure=False,
          limit_per_page=0, dedupe=True, render=False, scroll_times=0, low_mem=False):
    """按配置翻页采集，返回 {ok, rows, columns, count, pages, logs}。"""
    fields = normalize_fields(fields)
    if not fields:
        raise ValueError("请先添加至少一个字段")
    columns = [f["name"] for f in fields]
    try:
        pages = max(1, min(MAX_PAGES, int(pages or 1)))
    except Exception:
        pages = 1
    try:
        delay = max(0, min(5000, int(delay_ms or 0))) / 1000.0
    except Exception:
        delay = 0.0
    try:
        limit_per_page = max(0, int(limit_per_page or 0))
    except Exception:
        limit_per_page = 0

    mode = (page_mode or "none").strip().lower()
    if mode not in ("url", "next", "none", "scroll"):
        mode = "none"

    if mode == "scroll":
        # 滚动加载（懒加载 / 无限滚动）：必须真跑 JS，边滚边把新内容加载出来再提取；
        # 滚动次数就是「最多滚几屏」，渲染那边滚到底会自动提前停。
        render = True
        try:
            scroll_times = max(1, min(20, int(scroll_times or 6)))
        except Exception:
            scroll_times = 6
        pages = 1

    # 明确的目标 URL 列表（next 模式边走边找，列表为 None）
    urls = None
    if mode == "url":
        tpl = (url_template or "").strip()
        if not tpl:
            raise ValueError("翻页方式选了「URL 模板」，但模板是空的")
        has_ph = ("{page}" in tpl) or ("{页码}" in tpl)
        if not has_ph:
            urls = [check_url(tpl)]
        else:
            urls = [check_url(tpl.replace("{page}", str(i)).replace("{页码}", str(i)))
                    for i in range(1, pages + 1)]
    elif mode in ("none", "scroll"):
        urls = [check_url(url)]

    rows, seen, logs = [], set(), []
    cur_url = check_url(url)
    visited = set()
    fetched = 0

    while True:
        if urls is not None:
            if fetched >= len(urls):
                break
            target = urls[fetched]
        else:
            if fetched >= pages:
                break
            if not cur_url or cur_url in visited:
                break
            target = cur_url
        visited.add(target)
        t0 = time.time()
        try:
            if render:
                # 渲染模式：这一页单独开一个浏览器，滚完就关，避免多页采集把浏览器堆爆
                from . import render as render_mod
                html_text, page_url = render_mod.render_once(
                    target, headers=headers or {}, insecure=insecure,
                    timeout=timeout, scroll_times=scroll_times, low_mem=low_mem)
                page = {"html": html_text, "url": page_url}
            else:
                page = fetch_page(target, headers=headers, timeout=timeout, insecure=insecure)
            got = extract_rows(page["html"], item_selector, fields, page["url"], limit_per_page)
        except Exception as e:
            logs.append({"page": fetched + 1, "url": target, "ok": False,
                         "error": str(e), "cost_ms": int((time.time() - t0) * 1000)})
            break
        added = 0
        for r in got:
            key = json.dumps(r, ensure_ascii=False, sort_keys=True)
            if dedupe and key in seen:
                continue
            seen.add(key)
            rows.append(r)
            added += 1
            if len(rows) >= MAX_ROWS:
                break
        logs.append({"page": fetched + 1, "url": page["url"], "ok": True,
                     "found": len(got), "added": added,
                     "cost_ms": int((time.time() - t0) * 1000)})
        fetched += 1
        if len(rows) >= MAX_ROWS:
            break
        if mode == "next":
            nxt = find_next_url(page["html"], next_selector, page["url"])
            if not nxt or nxt in visited:
                break
            cur_url = nxt
        if delay and fetched < (len(urls) if urls is not None else pages):
            time.sleep(delay)

    return {"ok": True, "rows": rows, "columns": columns, "count": len(rows),
            "pages": fetched, "logs": logs, "capped": len(rows) >= MAX_ROWS,
            "mode": mode, "scroll_times": int(scroll_times or 0)}


# ----------------------------------------------------------------- 导出

def _safe_cell(v):
    s = "" if v is None else str(v)
    # 以 = + - @ 开头的内容在 Excel 里会被当公式，加个前缀避免误执行
    if s[:1] in ("=", "+", "-", "@"):
        s = "'" + s
    return s


def export_csv(rows, columns):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(columns)
    for r in rows:
        w.writerow([_safe_cell(r.get(c)) for c in columns])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def export_json(rows, columns):
    data = [{c: (r.get(c) if r.get(c) is not None else "") for c in columns} for r in rows]
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def export_xlsx(rows, columns):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "采集结果"
    ws.append(list(columns))
    for c in ws[1]:
        c.font = Font(bold=True)
    for r in rows:
        ws.append([str(r.get(c) if r.get(c) is not None else "")[:30000] for c in columns])
    for i, name in enumerate(columns, start=1):
        width = min(50, max(10, len(str(name)) * 2 + 4))
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = width
    ws.freeze_panes = "A2"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def export_rows(rows, columns, fmt="csv"):
    """导出结果，返回 (bytes, mimetype, filename)。"""
    columns = [str(c) for c in (columns or [])]
    if not columns:
        raise ValueError("没有可导出的列")
    if not rows:
        raise ValueError("没有可导出的数据")
    fmt = (fmt or "csv").strip().lower()
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    if fmt == "json":
        return export_json(rows, columns), "application/json; charset=utf-8", "scrape_%s.json" % stamp
    if fmt in ("xlsx", "excel"):
        return (export_xlsx(rows, columns),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "scrape_%s.xlsx" % stamp)
    return export_csv(rows, columns), "text/csv; charset=utf-8", "scrape_%s.csv" % stamp


# ----------------------------------------------------------------- 采集方案

def _now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def list_tasks():
    try:
        conn = store_conn()
        try:
            rows = conn.execute(
                "SELECT id, name, url, cfg, rows, ts, updated FROM scraper_tasks "
                "ORDER BY updated DESC").fetchall()
        finally:
            conn.close()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["cfg"] = json.loads(d.get("cfg") or "{}")
            except Exception:
                d["cfg"] = {}
            out.append(d)
        return out
    except Exception as e:
        _log.warning("读取采集方案失败: %s", e)
        return []


def get_task(task_id):
    for t in list_tasks():
        if t.get("id") == task_id:
            return t
    return None


def save_task(task_id, name, url, cfg, rows=0):
    """新建或更新一个采集方案，返回方案 dict。"""
    name = (name or "").strip() or "未命名采集"
    url = (url or "").strip()
    payload = json.dumps(cfg or {}, ensure_ascii=False)
    ts = _now()
    try:
        rows = max(0, int(rows or 0))
    except Exception:
        rows = 0
    task_id = (task_id or "").strip()
    try:
        with store_tx() as conn:
            if task_id:
                cur = conn.execute(
                    "UPDATE scraper_tasks SET name=?, url=?, cfg=?, rows=?, updated=? WHERE id=?",
                    (name, url, payload, rows, time.time(), task_id))
                if not cur.rowcount:
                    task_id = ""
            if not task_id:
                task_id = uuid.uuid4().hex[:16]
                conn.execute(
                    "INSERT INTO scraper_tasks (id, name, url, cfg, rows, ts, updated) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (task_id, name, url, payload, rows, ts, time.time()))
    except Exception as e:
        _log.warning("保存采集方案失败: %s", e)
        raise RuntimeError("保存失败：%s" % e)
    return {"id": task_id, "name": name, "url": url, "cfg": cfg or {},
            "rows": rows, "ts": ts}


def delete_task(task_id):
    task_id = (task_id or "").strip()
    if not task_id:
        return False
    try:
        with store_tx() as conn:
            conn.execute("DELETE FROM scraper_tasks WHERE id=?", (task_id,))
        return True
    except Exception as e:
        _log.warning("删除采集方案失败: %s", e)
        return False
