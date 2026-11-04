"""无头浏览器渲染（懒加载 / 无限滚动支持）。

为什么需要
----------
预览默认把 <script> 全部剥掉（安全 + 快），而「懒加载 / 滚动到底加载更多」本来就是
站点脚本干的事 —— 没有脚本，滚到底当然不会多出内容。这里用 Playwright 起一个无头
Chromium 把页面真正跑起来，滚动若干屏后把渲染完的 DOM 交给 scraper 的清洗 / 点选流程。

线程模型
--------
Playwright 的同步 API 对象只能在「创建它的线程」里使用，而 Flask 每个请求都在不同
线程，所以每个会话自带一个 worker 线程：外部只通过 call() 把函数排队投递进去执行。

资源
----
每个会话 = 一个 Chromium（约 100~200MB）。默认最多同时留 2 个，空闲 2 分钟自动关闭；
超出上限时先关最久没用的那个。playwright 没装时直接抛错，由路由层转成可读提示。
"""
import queue
import threading
import time
import uuid
from concurrent.futures import Future

from ...log import get_logger

_log = get_logger()

MAX_SESSIONS = 2
IDLE_TIMEOUT = 120          # 会话空闲多久自动关闭（秒）。Chromium 是内存大户，不能挂太久
STALE_TIMEOUT = 360         # 一次性 / 构造失败会话的兜底清理时长（秒），比正常渲染耗时宽裕
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_sessions = {}
_lock = threading.Lock()
# 所有还活着的会话，包括 render_once 的一次性会话和「构造到一半失败」的会话。
# 这些都不在 _sessions 里，过去一旦没人拿到对象引用，close() 就永远不会被调用：
# worker 线程卡在 _q.get()，Playwright driver 和 Chromium 进程一直留着。
_ALL = set()
_ALL_LOCK = threading.Lock()


def available():
    """playwright 是否可用（没装就给前端一个友好提示，而不是整页 500）。"""
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except Exception:
        return False


def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        raise RuntimeError(
            "服务端未安装 playwright，无法执行 JS 渲染。安装方法："
            "pip install playwright 然后执行 playwright install chromium")


class RenderSession:
    """一个常驻无头浏览器的渲染会话；所有 Playwright 操作都在自己的 worker 线程里跑。"""

    def __init__(self, url, headers=None, insecure=False, timeout=30, low_mem=False):
        _require_playwright()
        self.token = uuid.uuid4().hex
        self.url = url
        self.page_url = url
        self.html = ""
        self.low_mem = bool(low_mem)
        self.last_used = time.time()
        self._q = queue.Queue()
        self._closed = False
        self._pw = None
        self._browser = None
        self._ctx = None
        self._page = None
        self._thread = threading.Thread(target=self._loop, daemon=True, name="scr-render")
        with _ALL_LOCK:
            _ALL.add(self)
        _ensure_reaper()
        self._thread.start()
        try:
            # 首屏：打开页面并等一小会儿，让首屏接口 / 懒加载图起来
            self.html = self.call(lambda: self._open(url, headers or {}, insecure, timeout),
                                  timeout=max(60, int(timeout) + 40))
            self.page_url = self.call(lambda: self._page.url, timeout=30) or url
        except BaseException:
            # 首屏超时 / 打开失败：对象还没返回给调用方，外面没人会调 close()；
            # 不清理就会永久留下一个 worker 线程和一整套 Chromium 进程。
            self.close()
            raise

    # ---------------------------------------------------------- 线程内执行
    def _loop(self):
        try:
            self._loop_inner()
        finally:
            with _ALL_LOCK:
                _ALL.discard(self)

    def _loop_inner(self):
        from playwright.sync_api import sync_playwright
        try:
            self._pw = sync_playwright().start()
        except BaseException as e:      # 浏览器没装好等
            _log.warning("启动 playwright 失败: %s", e)
            self._pw = None
            # 让所有排队中的调用立刻失败，而不是一直挂着
            while True:
                item = self._q.get()
                if item is None:
                    break
                _fn, fut = item
                if not fut.done():
                    fut.set_exception(RuntimeError("启动无头浏览器失败：%s" % e))
            return
        while True:
            item = self._q.get()
            if item is None:
                break
            fn, fut = item
            if fut.done():
                continue
            try:
                fut.set_result(fn())
            except BaseException as e:      # noqa: BLE001  线程里不能漏异常出去
                try:
                    fut.set_exception(e)
                except Exception:
                    pass
        for closable in (self._ctx, self._browser):
            try:
                if closable:
                    closable.close()
            except Exception:
                pass
        try:
            if self._pw:
                self._pw.stop()
        except Exception:
            pass

    def call(self, fn, timeout=120):
        if self._closed:
            raise RuntimeError("渲染会话已关闭")
        fut = Future()
        self._q.put((fn, fut))
        self.last_used = time.time()
        return fut.result(timeout=timeout)

    # ---------------------------------------------------------- 具体动作
    def _open(self, url, headers, insecure, timeout):
        args = ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled",
                # 内存控制：视频 / 重型站点单个页面就能吃 1GB+，这里压一压
                "--disable-gpu",                # 无头用不上 GPU，省掉 GPU 进程内存
                "--mute-audio",                 # 静音，媒体解码照常但省一部分
                "--renderer-process-limit=1"]   # 渲染进程合并，减少进程数开销
        if self.low_mem:
            # 低内存模式（迷你版）：再瘦一圈，代价是页面更慢 / 极端重型的页面可能崩
            args += [
                "--blink-settings=imagesEnabled=false",   # 干脆不加载图片（配合「不代理图片资源」）
                "--process-per-site",                     # 同站点复用渲染进程
                "--disable-features=site-per-process,BackForwardCache,Translate,MediaRouter",
                "--js-flags=--max-old-space-size=192",    # 限制单个渲染进程的 V8 堆（MB）
                "--disable-background-networking",
                "--disk-cache-size=1",
            ]
        self._browser = self._pw.chromium.launch(headless=True, args=args)
        self._ctx = self._browser.new_context(
            user_agent=headers.get("User-Agent") or UA,
            viewport=({"width": 1024, "height": 768} if self.low_mem
                      else {"width": 1440, "height": 960}),
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            ignore_https_errors=bool(insecure),
            extra_http_headers={k: v for k, v in headers.items() if k.lower() != "user-agent"},
        )
        # 无头浏览器的指纹太明显（navigator.webdriver=true / 缺 chrome 对象），
        # 不少站点会因此直接甩验证码页；这里做最小化的常规伪装。
        try:
            self._ctx.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
                "Object.defineProperty(navigator,'languages',{get:()=>['zh-CN','zh']});"
                "window.chrome = window.chrome || { runtime: {} };"
            )
        except Exception:
            pass
        self._page = self._ctx.new_page()
        try:
            self._page.goto(url, wait_until="domcontentloaded",
                            timeout=max(10000, int(timeout) * 1000))
        except Exception as e:
            raise RuntimeError("打开页面失败：%s" % e)
        self._page.wait_for_timeout(1500)      # 首屏数据 / 图片
        return self._page.content()

    def _scroll(self, times, delay, settle):
        """往下滚：最多滚 times 次，页面高度不再增长（到底了）就提前停。"""
        page = self._page
        limit = max(1, min(20, int(times or 1)))
        loops = 0
        last_h = -1
        while loops < limit:
            try:
                h = page.evaluate("""() => Math.max(
                    (document.scrollingElement || {}).scrollHeight || 0,
                    document.body ? document.body.scrollHeight : 0)""")
            except Exception:
                h = 0
            try:
                page.evaluate("""() => {
                    const el = document.scrollingElement || document.body;
                    const h = Math.max(el.scrollHeight, document.body ? document.body.scrollHeight : 0);
                    window.scrollTo(0, h);
                    // 有些站点只监听 wheel / scroll 事件，补一次确保触发加载
                    window.dispatchEvent(new Event('scroll'));
                }""")
            except Exception:
                pass
            loops += 1
            page.wait_for_timeout(int(max(0.2, min(5.0, float(delay or 1.2))) * 1000))
            try:
                h2 = page.evaluate("""() => Math.max(
                    (document.scrollingElement || {}).scrollHeight || 0,
                    document.body ? document.body.scrollHeight : 0)""")
            except Exception:
                h2 = h
            # 滚了至少两次且高度没变 → 已经到底，再滚也是白等
            if loops >= 2 and h2 <= last_h:
                break
            last_h = h2
        page.wait_for_timeout(int(max(0, settle) * 1000))
        try:
            y = page.evaluate("window.scrollY || 0")
        except Exception:
            y = 0
        return page.content(), y

    def scroll(self, times=3, delay=1.2, settle=0.8):
        return self.call(lambda: self._scroll(times, delay, settle), timeout=180)

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._q.put(None)
        except Exception:
            pass
        # 只往队列投毒不等待：worker 若正卡在 Playwright 调用里，浏览器还要过很久
        # 才关，这段时间它既不在 _sessions 里，也不会被「一键释放」看到。这里等一小
        # 会儿，正常情况下足够让 _ctx / _browser / driver 全部退出。
        t = self._thread
        if t is not None and t.is_alive() and t is not threading.current_thread():
            try:
                t.join(timeout=3)
            except Exception:
                pass


# ---------------------------------------------------------------- 会话管理
def _sweep():
    now = time.time()
    dead = []
    with _lock:
        for token, sess in list(_sessions.items()):
            if now - sess.last_used > IDLE_TIMEOUT:
                _sessions.pop(token, None)
                dead.append(sess)
    # 兜底：一次性会话（render_once）和构造失败没人接手的会话都不在 _sessions 里，
    # 只扫 _sessions 会漏掉它们，Playwright driver / Chromium 就一直挂着。
    with _ALL_LOCK:
        stale = [s for s in _ALL
                 if not s._closed and now - s.last_used > STALE_TIMEOUT]
    for sess in dead + stale:
        try:
            sess.close()
        except Exception:
            pass


# 后台定时清理：之前 _sweep 只在「下次再抓取」时才跑，用户用完放着的话，
# 空闲的 Chromium（单个几百 MB 到 1GB+）会一直挂着不关 —— 这就是内存占用
# 居高不下的主因。起一个守护线程定期扫，到点就关。
_reaper_lock = threading.Lock()
_reaper_started = False


def _ensure_reaper():
    global _reaper_started
    with _reaper_lock:
        if _reaper_started:
            return
        _reaper_started = True

    def _run():
        while True:
            time.sleep(30)
            try:
                _sweep()
            except Exception:
                pass

    threading.Thread(target=_run, daemon=True, name="scr-render-reaper").start()


def open_session(url, headers=None, insecure=False, timeout=30, low_mem=False):
    """打开一个渲染会话（同一时间最多 MAX_SESSIONS 个）。"""
    _ensure_reaper()
    _sweep()
    with _lock:
        while len(_sessions) >= MAX_SESSIONS:
            oldest = min(_sessions.values(), key=lambda s: s.last_used)
            _sessions.pop(oldest.token, None)
            try:
                oldest.close()
            except Exception:
                pass
            break
    sess = RenderSession(url, headers=headers, insecure=insecure, timeout=timeout,
                         low_mem=low_mem)
    with _lock:
        _sessions[sess.token] = sess
    return sess


def get_session(token):
    token = (token or "").strip()
    if not token:
        return None
    with _lock:
        sess = _sessions.get(token)
    if not sess:
        return None
    if time.time() - sess.last_used > IDLE_TIMEOUT:
        with _lock:
            _sessions.pop(token, None)
        try:
            sess.close()
        except Exception:
            pass
        return None
    return sess


def render_once(url, headers=None, insecure=False, timeout=30, scroll_times=0, delay=1.2,
                low_mem=False):
    """一次性渲染：打开 → 滚 N 屏 → 取 HTML → 关会话。采集时按页调用。"""
    sess = None
    try:
        sess = RenderSession(url, headers=headers, insecure=insecure, timeout=timeout,
                             low_mem=low_mem)
        html = sess.html
        if scroll_times:
            html, _y = sess.scroll(times=scroll_times, delay=delay)
        return html, sess.page_url
    finally:
        if sess:
            try:
                sess.close()
            except Exception:
                pass
