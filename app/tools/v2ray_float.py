#!/usr/bin/env python3
"""V2Ray 桌面悬浮流量胶囊（系统级 tkinter 小窗）。

由 Flask 的 /api/v2ray/float/start 启动，通过本机 HTTP 接口读取状态 / 执行操作。
样式对齐浏览器版：浅色圆角卡片 + 紧凑布局 + 蓝色高亮，窗口用 XShape 裁成圆角。
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import math
import re
import tkinter as tk
import tkinter.font as tkfont
import urllib.request

CARD = "#ffffff"
BORDER = "#d8dee4"
DIVIDER = "#eaeef2"
TXT = "#1f2328"
SUB = "#6e7781"
MUTED = "#8c959f"
BLUE = "#0969da"
BLUE_BG = "#e8f1fb"
BLUE_BD = "#b6d4ea"
GREEN = "#1a7f37"
RED = "#cf222e"
HOVER = "#f6f8fa"

# tkinter 在多数 Linux 字体里显示不了国旗 / emoji，会变成方块，先过滤掉
_EMOJI_RE = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")

W_PILL = 300
H_PILL = 60
W_OPEN = 320
H_OPEN = 430
RADIUS = 14

MODE_NAMES = {"global": "全局", "rule": "绕过大陆", "direct": "直连"}
MODE_FULL = {"global": "全局代理", "rule": "绕过大陆", "direct": "全局直连"}

# 竖三色 / 横三色国旗（常见国家；系统没有国旗图片，直接在 Canvas 上画）
_FLAG_V = {
    "IT": ("#009246", "#ffffff", "#ce2b37"),
    "FR": ("#0055a4", "#ffffff", "#ef4135"),
    "IE": ("#169b62", "#ffffff", "#ff883e"),
    "BE": ("#000000", "#fdda24", "#ef3340"),
    "RO": ("#002b7f", "#fcd116", "#ce1126"),
    "NG": ("#008751", "#ffffff", "#008751"),
    "PE": ("#d91023", "#ffffff", "#d91023"),
    "MX": ("#006847", "#ffffff", "#ce1126"),
}
_FLAG_H = {
    "DE": ("#000000", "#dd0000", "#ffce00"),
    "NL": ("#ae1c28", "#ffffff", "#21468b"),
    "RU": ("#ffffff", "#0039a6", "#d52b1e"),
    "AT": ("#ed2939", "#ffffff", "#ed2939"),
    "HU": ("#ce2939", "#ffffff", "#477050"),
    "BG": ("#ffffff", "#00966e", "#d62612"),
    "LT": ("#fdb913", "#006a44", "#c1272d"),
    "ES": ("#aa151b", "#f1bf00", "#aa151b"),
    "TH": ("#a51931", "#f4f5f8", "#2d2a4a"),
    "ID": ("#ce1126", "#ffffff", "#ffffff"),
    "PL": ("#ffffff", "#dc143c", "#dc143c"),
}

# 节点前的国家/地区代码徽章（没有对应国旗数据时用彩色小标签代替）
_BADGE_COLORS = ("#0969da", "#1a7f37", "#8250df", "#bf3989",
                 "#bc4c00", "#0a3069", "#116329", "#6e7781")
_CC_RE = re.compile(r"(?:^|[_\-\s])([A-Za-z]{2})(?=[_\-\s]|[\u4e00-\u9fff]|$)")


def country_code(name: str) -> str:
    """从节点名里取国家代码，例如「IT_意大利」「🇮🇹_US_美国」→ IT / US。"""
    m = _CC_RE.search(_EMOJI_RE.sub("", str(name or "")))
    return m.group(1).upper() if m else ""


class XRect(ctypes.Structure):
    _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short),
                ("width", ctypes.c_ushort), ("height", ctypes.c_ushort)]


def human(n) -> str:
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        n = 0.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024.0
    return "%.1f GB" % n


def fit(text, n: int) -> str:
    s = _EMOJI_RE.sub("", str(text or "")).strip()
    s = s.lstrip("_-|· ")          # 国旗被过滤后常留下前导下划线
    return s if len(s) <= n else s[:n - 1] + "…"


class Float:
    def __init__(self, api: str, token: str):
        self.api = api.rstrip("/")
        self.token = token
        # 本机回环请求不能走系统代理（否则会被自身 / 其他代理绕一圈）
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.info = {}
        self.opened = False
        self.busy = ""
        self.err = ""
        self.scroll = 0
        self.hits = []
        self.hover = None
        self.drag = None
        self.moved = False
        self._x11 = None
        self._xext = None
        self._dpy = None

        self.root = tk.Tk()
        self.root.title("V2Ray 流量")
        self.root.overrideredirect(True)
        try:
            self.root.attributes("-topmost", True)
            self.root.attributes("-alpha", 0.99)
        except tk.TclError:
            pass
        self.family = self._pick_family()
        self._f9b = tkfont.Font(family=self.family, size=9, weight="bold")
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.pill_x = max(0, sw - W_PILL - 28)
        self.pill_y = max(0, sh - H_PILL - 96)
        self.root.geometry("%dx%d+%d+%d" % (W_PILL, H_PILL, self.pill_x, self.pill_y))
        self.cv = tk.Canvas(self.root, width=W_PILL, height=H_PILL, bg=CARD,
                            highlightthickness=0, bd=0)
        self.cv.pack(fill="both", expand=True)
        self.cv.bind("<ButtonPress-1>", self._press)
        self.cv.bind("<B1-Motion>", self._motion)
        self.cv.bind("<ButtonRelease-1>", self._release)
        self.cv.bind("<Motion>", self._motion_hover)
        self.cv.bind("<MouseWheel>", self._wheel)
        self.cv.bind("<Button-4>", lambda e: self._scroll(-1))
        self.cv.bind("<Button-5>", lambda e: self._scroll(1))
        self.root.bind("<Escape>", lambda e: self._set_open(False))
        self.root.bind("<Button-3>", lambda e: self.root.destroy())
        self.paint()
        self._shape_log("win %s frame %s" % (hex(self.root.winfo_id()), self.root.wm_frame()))
        self.root.after(250, lambda: self._apply_shape(W_PILL, H_PILL))
        self.root.after(150, self.tick)

    def _pick_family(self) -> str:
        import tkinter.font as tkfont
        try:
            fams = set(tkfont.families(self.root))
        except tk.TclError:
            return "Sans"
        for name in ("Noto Sans CJK SC", "WenQuanYi Micro Hei", "Source Han Sans CN",
                     "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Sans"):
            if name in fams:
                return name
        return "Sans"

    # ---------- 圆角窗口（XShape） ----------
    def _apply_shape(self, w: int, h: int, retry: int = 0):
        try:
            # 窗口还没真正映射时设置形状会被丢掉，等它可见后再设
            if not self.root.winfo_viewable():
                if retry < 20:
                    self.root.after(60, lambda: self._apply_shape(w, h, retry + 1))
                return
            self.root.update_idletasks()
            if self._x11 is None:
                self._x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
                self._xext = ctypes.CDLL(ctypes.util.find_library("Xext"))
                self._x11.XOpenDisplay.restype = ctypes.c_void_p
                self._x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
                self._dpy = self._x11.XOpenDisplay(None)
                self._xext.XShapeCombineRectangles.argtypes = [
                    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                    ctypes.POINTER(XRect), ctypes.c_int, ctypes.c_int, ctypes.c_int]
                self._x11.XFlush.argtypes = [ctypes.c_void_p]
            if not self._dpy:
                return
            r = RADIUS
            rects = [(r, 0, w - 2 * r, h), (0, r, w, h - 2 * r)]
            for i in range(r):
                # 第 i 行圆角的水平内收量：i=0 时 dx=r（整行缩进），越往下越小
                dx = int(round(r - math.sqrt(max(0.0, r * r - (r - i) ** 2))))
                rects.append((dx, i, max(1, w - 2 * dx), 1))
                rects.append((dx, h - 1 - i, max(1, w - 2 * dx), 1))
            arr = (XRect * len(rects))(*[XRect(int(x), int(y), int(ww), int(hh))
                                         for x, y, ww, hh in rects])
            # Tk 的 winfo_id() 是内容子窗口，真正显示的是外层包装窗口；
            # 圆角必须裁在外层；两层都裁一遍，避免任何一层露出白色直角。
            targets = [self.root.winfo_id()]
            try:
                rret = ctypes.c_ulong()
                pret = ctypes.c_ulong()
                children = ctypes.POINTER(ctypes.c_ulong)()
                n = ctypes.c_uint()
                self._x11.XQueryTree(self._dpy, ctypes.c_ulong(targets[0]),
                                     ctypes.byref(rret), ctypes.byref(pret),
                                     ctypes.byref(children), ctypes.byref(n))
                if pret.value and pret.value != rret.value:
                    targets.insert(0, pret.value)
            except Exception:                      # noqa: BLE001
                pass
            for target in targets:
                self._xext.XShapeCombineRectangles(
                    self._dpy, ctypes.c_ulong(target), 0, 0, 0,
                    arr, len(rects), 0, 0)
            self._x11.XFlush(self._dpy)
            self._shape_log("ok %dx%d retry=%d" % (w, h, retry))
        except Exception as e:                     # noqa: BLE001
            self._shape_log("err: %r" % (e,))      # 没有 Xext 时退回方角，不影响功能

    @staticmethod
    def _shape_log(msg: str):
        try:
            with open("/tmp/vf_shape.log", "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except OSError:
            pass

    # ---------- 与 Flask 通信 ----------
    def call(self, path: str, body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.api + path, data=data,
            headers={"X-Float-Token": self.token, "Content-Type": "application/json"},
            method="POST" if body is not None else "GET")
        with self.opener.open(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    def tick(self):
        try:
            self.info = self.call("/api/v2ray/float/info") or {}
            self.err = ""
        except Exception as e:                     # noqa: BLE001
            self.err = str(e)
        self.paint()
        self.root.after(1500, self.tick)

    # ---------- 绘制 ----------
    def _rr(self, x1, y1, x2, y2, r, fill, outline="", width=1):
        """精确圆角矩形：四角用 pieslice 圆弧，直边用矩形补齐（比 smooth 多边形更圆）。"""
        r = max(0.0, min(r, (x2 - x1) / 2, (y2 - y1) / 2))
        if r <= 0.5:
            self.cv.create_rectangle(x1, y1, x2, y2, fill=fill, outline=outline, width=width)
            return
        cv = self.cv
        kw = {"fill": fill, "outline": outline, "width": width, "style": tk.PIESLICE}
        cv.create_arc(x1, y1, x1 + 2 * r, y1 + 2 * r, start=90, extent=90, **kw)
        cv.create_arc(x2 - 2 * r, y1, x2, y1 + 2 * r, start=0, extent=90, **kw)
        cv.create_arc(x1, y2 - 2 * r, x1 + 2 * r, y2, start=180, extent=90, **kw)
        cv.create_arc(x2 - 2 * r, y2 - 2 * r, x2, y2, start=270, extent=90, **kw)
        cv.create_rectangle(x1 + r, y1, x2 - r, y2, fill=fill, outline="")
        cv.create_rectangle(x1, y1 + r, x2, y2 - r, fill=fill, outline="")
        if outline and width:
            cv.create_line(x1 + r, y1, x2 - r, y1, fill=outline, width=width)
            cv.create_line(x1 + r, y2, x2 - r, y2, fill=outline, width=width)
            cv.create_line(x1, y1 + r, x1, y2 - r, fill=outline, width=width)
            cv.create_line(x2, y1 + r, x2, y2 - r, fill=outline, width=width)

    def _badge(self, x, y, code):
        """节点前的国家代码徽章（没有国旗数据时的兜底）。"""
        bw, bh = 20, 13
        color = _BADGE_COLORS[sum(ord(c) for c in code) % len(_BADGE_COLORS)]
        self._rr(x, y, x + bw, y + bh, 4, color)
        self._tx(x + bw / 2, y + bh / 2, code, "#ffffff", 7, True, "center")

    def _flag(self, x, y, code) -> bool:
        """在 Canvas 上画一面小国旗；没有对应数据返回 False。"""
        w, h = 20, 13
        code = (code or "").upper()
        known = (code in _FLAG_V or code in _FLAG_H or
                 code in ("JP", "US", "GB", "CH", "CN", "HK", "KR",
                          "TW", "CA", "BR", "TR", "SG"))
        if not known:
            return False
        cv = self.cv

        def rect(x1, y1, x2, y2, color):
            cv.create_rectangle(x + x1, y + y1, x + x2, y + y2, fill=color, outline="")

        cv.create_rectangle(x, y, x + w, y + h, fill="#ffffff", outline="")
        if code in _FLAG_V:
            a, b, c = _FLAG_V[code]
            rect(0, 0, w / 3, h, a)
            rect(w / 3, 0, 2 * w / 3, h, b)
            rect(2 * w / 3, 0, w, h, c)
        elif code in _FLAG_H:
            a, b, c = _FLAG_H[code]
            rect(0, 0, w, h / 3, a)
            rect(0, h / 3, w, 2 * h / 3, b)
            rect(0, 2 * h / 3, w, h, c)
        elif code == "JP":
            cv.create_oval(x + w / 2 - 3.4, y + h / 2 - 3.4, x + w / 2 + 3.4,
                           y + h / 2 + 3.4, fill="#bc002d", outline="")
        elif code == "US":
            for i in range(7):
                rect(0, (2 * i) * h / 13, w, (2 * i + 1) * h / 13, "#b22234")
            rect(0, 0, w * 0.45, h * 7 / 13, "#3c3b6e")
        elif code == "GB":
            rect(0, 0, w, h, "#012169")
            rect(0, h / 2 - 1.6, w, h / 2 + 1.6, "#ffffff")
            rect(w / 2 - 1.6, 0, w / 2 + 1.6, h, "#ffffff")
            rect(0, h / 2 - 1, w, h / 2 + 1, "#c8102e")
            rect(w / 2 - 1, 0, w / 2 + 1, h, "#c8102e")
        elif code == "CH":
            rect(0, 0, w, h, "#d52b1e")
            rect(w / 2 - 1.4, h * 0.2, w / 2 + 1.4, h * 0.8, "#ffffff")
            rect(w * 0.28, h / 2 - 1.4, w * 0.72, h / 2 + 1.4, "#ffffff")
        elif code == "CN":
            rect(0, 0, w, h, "#de2910")
            cv.create_oval(x + 2.5, y + 2, x + 6.5, y + 6, fill="#ffde00", outline="")
        elif code == "HK":
            rect(0, 0, w, h, "#de2910")
            cv.create_oval(x + w / 2 - 3, y + h / 2 - 3, x + w / 2 + 3,
                           y + h / 2 + 3, fill="#ffffff", outline="")
        elif code == "KR":
            rect(0, 0, w, h, "#ffffff")
            cv.create_oval(x + w / 2 - 3.2, y + h / 2 - 3.2, x + w / 2 + 3.2,
                           y + h / 2 + 3.2, fill="#cd2e3a", outline="")
        elif code == "TW":
            rect(0, 0, w, h, "#fe0000")
            rect(0, 0, w * 0.5, h * 0.5, "#000095")
        elif code == "CA":
            rect(0, 0, w / 4, h, "#d80621")
            rect(3 * w / 4, 0, w, h, "#d80621")
            rect(w / 4, 0, 3 * w / 4, h, "#ffffff")
        elif code == "BR":
            rect(0, 0, w, h, "#009c3b")
            cv.create_polygon(x + w / 2, y + 1.5, x + w - 1.5, y + h / 2,
                              x + w / 2, y + h - 1.5, x + 1.5, y + h / 2,
                              fill="#ffdf00", outline="")
        elif code == "TR":
            rect(0, 0, w, h, "#e30a17")
            cv.create_oval(x + w / 2 - 3, y + h / 2 - 3, x + w / 2 + 3,
                           y + h / 2 + 3, fill="#ffffff", outline="")
            cv.create_oval(x + w / 2 - 2, y + h / 2 - 2, x + w / 2 + 2,
                           y + h / 2 + 2, fill="#e30a17", outline="")
        elif code == "SG":
            rect(0, 0, w, h / 2, "#ed2939")
            rect(0, h / 2, w, h, "#ffffff")
            cv.create_oval(x + 3, y + 1.5, x + 8, y + 6.5, fill="#ffffff", outline="")
        else:
            return False
        cv.create_rectangle(x, y, x + w, y + h, fill="", outline="#d0d7de")
        return True

    def _tx(self, x, y, text, fill=TXT, size=9, bold=False, anchor="nw"):
        return self.cv.create_text(x, y, text=text, fill=fill, anchor=anchor,
                                   font=(self.family, size, "bold" if bold else "normal"))

    def paint(self):
        cv = self.cv
        cv.delete("all")
        self.hits = []
        w0 = W_OPEN if self.opened else W_PILL
        h0 = H_OPEN if self.opened else H_PILL
        # 卡片本体：1px 浅灰描边，和浏览器版的边框一致
        self._rr(1, 1, w0 - 1, h0 - 1, RADIUS, CARD, BORDER)
        info = self.info or {}
        running = bool(info.get("running"))
        mode = info.get("mode") or "rule"
        node = info.get("node") or {}
        sp = info.get("speed") or {}
        up = sp.get("up") or 0
        down = sp.get("down") or 0

        # 胶囊区（白色卡片由窗口本身承担，这里只画内容）
        cv.create_oval(14, 26, 22, 34, fill=GREEN if running else MUTED, outline="")
        self._tx(30, 12, "↑ " + human(up) + "/s", TXT, 10, True)
        self._tx(30, 32, "↓ " + human(down) + "/s", SUB, 9)
        name = fit(node.get("name") or "未连接", 10)
        code = country_code(node.get("name"))
        if code:
            # 国旗放在节点名左侧（按文本实际宽度定位，不会撞在一起）
            ix = W_PILL - 14 - self._f9b.measure(name) - 24
            if ix > 128:
                self._flag(ix, 10, code)
        self._tx(W_PILL - 14, 11, name, TXT, 9, True, "ne")
        self._tx(W_PILL - 14, 30, "切换中…" if self.busy else MODE_FULL.get(mode, "绕过大陆"),
                 SUB, 8, False, "ne")
        self._tx(W_PILL - 14, 44, "连接失败" if self.err else
                 ("点击收起 ▴" if self.opened else "点击展开 ▾"),
                 RED if self.err else MUTED, 8, False, "ne")

        if not self.opened:
            return
        w = W_OPEN
        cv.create_line(0, H_PILL, w, H_PILL, fill=DIVIDER)
        self._tx(16, 72, "路由模式", SUB, 8)
        y = 88
        gap = 4
        bw = (w - 32 - gap * 2) / 3
        for i, m in enumerate(("global", "rule", "direct")):
            x1 = 16 + i * (bw + gap)
            self._btn(x1, y, x1 + bw, y + 28, MODE_NAMES[m], m, m == mode)

        cv.create_line(0, 128, w, 128, fill=DIVIDER)
        nodes = info.get("nodes") or []
        self._tx(16, 138, "切换节点", SUB, 8)
        self._tx(w - 16, 138, "%d 个" % len(nodes), MUTED, 8, False, "ne")
        ly = 154
        rows, rowh = 9, 24
        shown = nodes[self.scroll:self.scroll + rows]
        if not shown:
            self._tx(w / 2, ly + 30, "还没有节点", MUTED, 9, False, "center")
        for i, n in enumerate(shown):
            ry = ly + i * rowh
            key = ("node", n.get("id"))
            on = bool(node.get("id") and n.get("id") == node.get("id"))
            hover = (self.hover == key)
            self._rr(16, ry, w - 16, ry + rowh - 2, 8,
                     BLUE_BG if on else (HOVER if hover else CARD),
                     BLUE_BD if on else "")
            code = country_code(n.get("name"))
            if code:
                fy = ry + (rowh - 2 - 13) / 2
                if not self._flag(24, fy, code):     # 有国旗数据就画国旗，否则用代码徽章
                    self._badge(24, fy, code)
                tx = 50
            else:
                tx = 26
            self._tx(tx, ry + (rowh - 2) / 2,
                     fit(n.get("name") or n.get("id") or "", 19),
                     BLUE if on else TXT, 9, on, "w")
            self.hits.append((16, ry, w - 16, ry + rowh - 2, key))
        stage = rows * rowh
        if len(nodes) > rows:
            cv.create_rectangle(w - 10, ly, w - 7, ly + stage, fill="#f0f3f6", outline="")
            hh = max(26, stage * rows / max(1, len(nodes)))
            yy = ly + (stage - hh) * (self.scroll / max(1, len(nodes) - rows))
            cv.create_rectangle(w - 10, yy, w - 7, yy + hh, fill="#d0d7de", outline="")

        cv.create_line(0, H_OPEN - 50, w, H_OPEN - 50, fill=DIVIDER)
        ay = H_OPEN - 40
        acts = (("断开" if running else "连接", "toggle", False),
                ("主界面", "open", False), ("关闭胶囊", "close", True))
        for i, (label, act, danger) in enumerate(acts):
            x1 = 16 + i * (bw + gap)
            self._btn(x1, ay, x1 + bw, ay + 28, label, act, False, danger=danger)

    def _btn(self, x1, y1, x2, y2, label, key, on, left=False, danger=False, plain=False):
        hover = (self.hover == key)
        fill = BLUE_BG if on else (HOVER if hover else CARD)
        outline = "" if plain and not on else (BLUE_BD if on else BORDER)
        self._rr(x1, y1, x2, y2, 8, fill, outline)
        color = BLUE if on else (RED if danger else TXT)
        if left:
            self._tx(x1 + 8, (y1 + y2) / 2, label, color, 9, on, "w")
        else:
            self._tx((x1 + x2) / 2, (y1 + y2) / 2, label, color, 9, on, "center")
        self.hits.append((x1, y1, x2, y2, key))

    # ---------- 交互 ----------
    def _press(self, e):
        self.drag = (e.x_root, e.y_root, self.root.winfo_x(), self.root.winfo_y())
        self.moved = False

    def _motion(self, e):
        if not self.drag:
            return
        dx = e.x_root - self.drag[0]
        dy = e.y_root - self.drag[1]
        if abs(dx) > 3 or abs(dy) > 3:
            self.moved = True
        if self.moved:
            self.root.geometry("+%d+%d" % (self.drag[2] + dx, self.drag[3] + dy))

    def _motion_hover(self, e):
        key = None
        for x1, y1, x2, y2, k in self.hits:
            if x1 <= e.x <= x2 and y1 <= e.y <= y2:
                key = k
                break
        if key != self.hover:
            self.hover = key
            self.paint()

    def _release(self, e):
        moved, self.moved = self.moved, False
        self.drag = None
        if moved:
            return
        if e.y < H_PILL - 2:
            self._set_open(not self.opened)
            return
        for x1, y1, x2, y2, key in self.hits:
            if x1 <= e.x <= x2 and y1 <= e.y <= y2:
                self._on_hit(key)
                return

    def _set_open(self, opened: bool):
        self.opened = opened
        w, h = (W_OPEN, H_OPEN) if opened else (W_PILL, H_PILL)
        if opened:
            y = min(self.pill_y, max(0, self.root.winfo_screenheight() - H_OPEN - 8))
        else:
            y = self.pill_y
        self.root.geometry("%dx%d+%d+%d" % (w, h, self.root.winfo_x(), y))
        self.cv.config(width=w, height=h)
        self.paint()
        self.root.after(150, lambda: self._apply_shape(w, h))

    def _scroll(self, delta):
        nodes = (self.info or {}).get("nodes") or []
        max_off = max(0, len(nodes) - 9)
        self.scroll = max(0, min(max_off, self.scroll + delta))
        self.paint()

    def _wheel(self, e):
        self._scroll(-1 if e.delta > 0 else 1)

    def _on_hit(self, key):
        if self.busy:
            return
        if key == "close":
            self.root.destroy()
            return
        if key == "open":
            import webbrowser
            webbrowser.open(self.api + "/ide")
            return
        if key == "toggle":
            self._act("toggle", {})
        elif isinstance(key, tuple) and key[0] == "node":
            self._act("node", {"id": key[1]})
        elif key in MODE_NAMES:
            self._act("mode", {"mode": key})

    def _act(self, action: str, extra: dict):
        self.busy = action
        self.paint()
        body = {"action": action}
        body.update(extra)
        try:
            self.info = self.call("/api/v2ray/float/action", body) or self.info
            self.err = ""
        except Exception as e:                     # noqa: BLE001
            self.err = str(e)
        self.busy = ""
        self.paint()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5001)
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    app = Float("http://127.0.0.1:%d" % args.port, args.token)
    app.root.mainloop()


if __name__ == "__main__":
    main()
