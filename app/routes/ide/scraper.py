"""可视化数据采集接口（编辑器区域「数据采集」标签页）。

端点一览
--------
POST /api/scraper/fetch       抓取一个页面（返回清洗后的预览地址，供 iframe 预览 / 点选）
GET  /api/scraper/preview/<t> 下发预览页（静态模式禁脚本 CSP；交互模式不设 CSP）
GET  /api/scraper/mirror/<t>/<scheme>/<host>/<path>
                              站点资源镜像（HTML / CSS / JS / 图片 / 接口统一代取并改写地址），
                              交互预览靠它把 JS 真正执行起来，浏览器不直连源站
GET  /api/scraper/proxy       图片 / 字体代理（带站点 Referer，绕开图床防盗链；静态模式用）
POST /api/scraper/scroll      渲染模式下继续往下滚 N 屏（触发懒加载 / 无限滚动）
POST /api/scraper/extract     按选择器从指定页面提取一次（服务端校验用）
POST /api/scraper/count       统计选择器在页面上匹配到多少个元素
POST /api/scraper/run         批量采集（支持 URL 模板 / 下一页链接 / 不翻页）
POST /api/scraper/export      导出结果：csv / json / xlsx（直接下发文件）
GET  /api/scraper/tasks       采集方案列表
POST /api/scraper/tasks       新建或更新采集方案
POST /api/scraper/tasks/delete 删除采集方案

约定：成功 {"ok": true, ...}，失败 {"error": "..."} + 4xx/5xx。
"""
from flask import Blueprint, Response, jsonify, request, session

from ...log import get_logger
from ...services.ide import scraper as sc

bp = Blueprint("scraper", __name__)
_log = get_logger()


def _body():
    return request.get_json(silent=True) or {}


def _headers_of(data):
    """前端传来的请求头：支持 {headers:{...}} 或 {ua, cookie} 两种写法。"""
    hdrs = {}
    raw = data.get("headers")
    if isinstance(raw, dict):
        for k, v in raw.items():
            k = str(k or "").strip()
            if k and v not in (None, ""):
                hdrs[k] = str(v)
    ua = (data.get("ua") or "").strip()
    if ua:
        hdrs["User-Agent"] = ua
    cookie = (data.get("cookie") or "").strip()
    if cookie:
        hdrs["Cookie"] = cookie
    return hdrs


def _fail(msg, code=400):
    return jsonify({"error": str(msg)}), code


@bp.route("/api/scraper/fetch", methods=["POST"])
def api_scraper_fetch():
    """抓取单个页面：返回清洗后的 HTML + 标题 + 最终地址。"""
    data = _body()
    try:
        page = sc.fetch_page(
            data.get("url", ""),
            headers=_headers_of(data),
            timeout=data.get("timeout") or 25,
            insecure=bool(data.get("insecure")),
            keep_html=False,          # 预览页走 /preview，不把上百 KB 的 HTML 塞进 JSON
            # 预览页里有 <base href="原站点">，代理地址必须写成本服务的绝对地址，
            # 否则相对路径会被解析到原站点上（https://原站/api/scraper/proxy… → 404）
            asset_prefix=request.host_url.rstrip("/"),
            render=bool(data.get("render")),
            scroll_times=int(data.get("scroll_times") or 0),
            # 交互预览：保留站点脚本（轮播 / 点击 / 滚动加载），靠 iframe sandbox 隔离
            interactive=bool(data.get("live") or data.get("interactive")),
        )
    except ValueError as e:
        return _fail(e, 400)
    except RuntimeError as e:
        return _fail(e, 502)
    except Exception as e:
        _log.exception("抓取页面失败")
        return _fail("抓取失败：%s" % e, 500)
    return jsonify({"ok": True, **page})


@bp.route("/api/scraper/preview/<token>")
def api_scraper_preview(token):
    """下发清洗好的预览页：CSP 禁脚本，地址是真实 HTTP 文档（不再是 about:srcdoc）。"""
    item = sc.get_preview(token)
    if not item:
        return _fail("预览已过期，请重新抓取页面", 404)
    resp = Response(item["html"], mimetype="text/html")
    # 交互预览要放行站点脚本，不能再套 script-src 'none'（隔离由 iframe sandbox 负责）
    if not item.get("live"):
        resp.headers["Content-Security-Policy"] = sc.PREVIEW_CSP
    # 沙箱不透明源的脚本拿原页面地址拼请求可能落回预览路由，补上 CORS 免得被拦
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin") or "*"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/api/scraper/scroll", methods=["POST"])
def api_scraper_scroll():
    """渲染模式下继续往下滚：拿同一个无头浏览器再滚几屏，回传新的预览地址。"""
    data = _body()
    token = data.get("token") or data.get("preview") or ""
    try:
        times = max(1, min(20, int(data.get("times") or 3)))
    except Exception:
        times = 3
    try:
        delay = max(0.2, min(5.0, float(data.get("delay") or 1.2)))
    except Exception:
        delay = 1.2
    try:
        res = sc.scroll_preview(token, times=times, delay=delay,
                                asset_prefix=request.host_url.rstrip("/"))
    except RuntimeError as e:
        return _fail(e, 409)
    except Exception as e:
        _log.exception("滚动加载失败")
        return _fail("滚动加载失败：%s" % e, 500)
    return jsonify({"ok": True, **res})


@bp.route("/api/scraper/proxy")
def api_scraper_proxy():
    """图片 / 字体代理：带上原页面 Referer，图床就不会因为防盗链返回 403。"""
    u = (request.args.get("u") or "").strip()
    ref = (request.args.get("ref") or "").strip()
    if not u:
        return _fail("缺少资源地址", 400)
    try:
        ctype, data = sc.fetch_media(u, ref)
    except ValueError as e:
        return _fail(e, 400)
    except RuntimeError as e:
        return _fail(e, 502)
    except Exception as e:
        _log.warning("资源代理失败 %s: %s", u[:120], e)
        return _fail("资源加载失败：%s" % e, 502)
    resp = Response(data, mimetype=ctype)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "script-src 'none'; object-src 'none'"
    return resp


@bp.route("/api/scraper/mirror/<token>/<path:rest>",
          methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
def api_scraper_mirror(token, rest):
    """站点资源镜像：HTML / CSS / JS / 图片 / 接口 全部由服务端代取。

    交互预览的 iframe 是不透明源（sandbox 不带 allow-same-origin），浏览器既没有
    登录 Cookie，直连源站也会被 CORS 拦。这里以 token（随机、30 分钟过期）作为凭证，
    服务端带上抓取时用的 UA / Cookie / Referer 去取，并把内容里的地址继续改写成镜像地址。
    """
    origin = request.headers.get("Origin") or ""
    cors = {
        "Access-Control-Allow-Origin": origin or "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") or "*",
        "Access-Control-Expose-Headers": "*",
        "Vary": "Origin",
    }

    def _json(msg, code):
        resp = jsonify({"error": str(msg)})
        resp.status_code = code
        resp.headers.update(cors)
        return resp

    if request.method == "OPTIONS":
        resp = Response("", status=204)
        resp.headers.update(cors)
        return resp

    item = sc.get_preview(token)
    if not item:
        return _json("预览已过期，请重新抓取页面", 404)

    # 交互预览的文档本体：镜像路径里的魔法文件名（__scr_preview__.html）不代取，
    # 直接下发缓存的预览 HTML —— 这样文档地址落在镜像目录结构里，
    # 站点脚本按 location.href 推导的相对地址才能被镜像接住
    last_seg = rest.replace("\\", "/").split("?")[0].split("/")[-1]
    if last_seg.startswith("__scr_preview__"):
        resp = Response(item["html"], mimetype="text/html")
        resp.headers.update(cors)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    try:
        target = sc.mirror_target(rest, request.query_string.decode("utf-8", "ignore"))
    except ValueError as e:
        return _json(e, 400)

    asset_prefix = request.host_url.rstrip("/")
    mirror_base = sc.mirror_base_of(asset_prefix, token)
    hdrs = dict(item.get("hdrs") or {})
    # 浏览器这次请求里对站点有意义、但抓页面时没有的头（接口提交最常用）
    for k in ("Content-Type", "X-Requested-With", "Authorization", "X-CSRF-Token"):
        v = request.headers.get(k)
        if v and not any(x.lower() == k.lower() for x in hdrs):
            hdrs[k] = v

    body = None if request.method in ("GET", "HEAD") else request.get_data()
    try:
        res = sc.fetch_mirror(
            target, item.get("url") or "", hdrs=hdrs,
            insecure=bool(item.get("insecure")), token=token,
            mirror_base=mirror_base, asset_prefix=asset_prefix,
            accept=request.headers.get("Accept") or "",
            method=request.method, body=body)
    except ValueError as e:
        return _json(e, 400)
    except RuntimeError as e:
        return _json(e, 502)
    except Exception as e:
        _log.warning("镜像失败 %s: %s", target[:120], e)
        return _json("资源加载失败：%s" % e, 502)

    if res.get("redirect"):
        resp = Response("", status=302)
        # 站点重定向（常见：跳到 https / 加尾斜杠）：让浏览器跟到新的镜像地址，
        # 这样里面的相对 import 才能按正确目录解析
        resp.headers["Location"] = sc.mirror_url(res["redirect"], item.get("url") or "", mirror_base)
        resp.headers.update(cors)
        return resp

    resp = Response(res.get("data") or b"", status=res.get("status") or 200)
    resp.headers["Content-Type"] = res.get("ctype") or "application/octet-stream"
    resp.headers.update(cors)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "private, max-age=120"
    return resp


@bp.route("/api/scraper/extract", methods=["POST"])
def api_scraper_extract():
    """按规则提取一次（前端「预览」在本地也能做，这里用于跨页 / 校验）。"""
    data = _body()
    try:
        page = sc.fetch_page(
            data.get("url", ""),
            headers=_headers_of(data),
            timeout=data.get("timeout") or 25,
            insecure=bool(data.get("insecure")),
        )
        rows = sc.extract_rows(
            page["html"],
            data.get("item_selector", ""),
            data.get("fields") or [],
            page["url"],
            limit=int(data.get("limit") or 0),
        )
    except ValueError as e:
        return _fail(e, 400)
    except RuntimeError as e:
        return _fail(e, 502)
    except Exception as e:
        _log.exception("提取失败")
        return _fail("提取失败：%s" % e, 500)
    return jsonify({"ok": True, "rows": rows, "count": len(rows), "url": page["url"]})


@bp.route("/api/scraper/count", methods=["POST"])
def api_scraper_count():
    """统计列表项选择器能匹配多少元素（前端点完选择器即时反馈）。"""
    data = _body()
    try:
        page = sc.fetch_page(
            data.get("url", ""),
            headers=_headers_of(data),
            timeout=data.get("timeout") or 25,
            insecure=bool(data.get("insecure")),
        )
        n = sc.count_matches(page["html"], data.get("item_selector", ""))
    except Exception as e:
        return _fail(e, 502)
    return jsonify({"ok": True, "count": n})


@bp.route("/api/scraper/run", methods=["POST"])
def api_scraper_run():
    """批量采集（可能耗时：页数 × 延时），前端显示「采集中」。"""
    data = _body()
    try:
        res = sc.crawl(
            data.get("url", ""),
            data.get("fields") or [],
            item_selector=data.get("item_selector", ""),
            pages=data.get("pages") or 1,
            page_mode=data.get("page_mode") or "none",
            url_template=data.get("url_template", ""),
            next_selector=data.get("next_selector", ""),
            delay_ms=data.get("delay_ms") or 0,
            headers=_headers_of(data),
            timeout=data.get("timeout") or 25,
            insecure=bool(data.get("insecure")),
            limit_per_page=data.get("limit_per_page") or 0,
            dedupe=data.get("dedupe", True),
            render=bool(data.get("render")),
            scroll_times=int(data.get("scroll_times") or 0),
        )
    except ValueError as e:
        return _fail(e, 400)
    except RuntimeError as e:
        return _fail(e, 502)
    except Exception as e:
        _log.exception("批量采集失败")
        return _fail("采集失败：%s" % e, 500)

    # 顺手把这个方案落库（同一个 id 就更新），方便下次直接点开继续用
    try:
        sc.save_task(
            data.get("task_id") or "",
            (data.get("name") or "").strip() or ("采集 " + (data.get("url") or "")[:60]),
            data.get("url") or "",
            {
                "item_selector": data.get("item_selector", ""),
                "fields": data.get("fields") or [],
                "pages": data.get("pages") or 1,
                "page_mode": data.get("page_mode") or "none",
                "url_template": data.get("url_template", ""),
                "next_selector": data.get("next_selector", ""),
                "delay_ms": data.get("delay_ms") or 0,
                "insecure": bool(data.get("insecure")),
                "ua": (data.get("ua") or "").strip(),
                "cookie": (data.get("cookie") or "").strip(),
                "render": bool(data.get("render")),
                "scroll_times": int(data.get("scroll_times") or 0),
                "scroll_loops": int(data.get("scroll_loops") or 0),
            },
            rows=res.get("count") or 0,
        )
    except Exception:
        pass
    return jsonify(res)


@bp.route("/api/scraper/export", methods=["POST"])
def api_scraper_export():
    """导出采集结果：直接下发文件（csv / json / xlsx）。"""
    data = _body()
    try:
        content, mime, filename = sc.export_rows(
            data.get("rows") or [],
            data.get("columns") or [],
            data.get("format") or "csv",
        )
    except ValueError as e:
        return _fail(e, 400)
    except Exception as e:
        _log.exception("导出失败")
        return _fail("导出失败：%s" % e, 500)
    resp = Response(content, mimetype=mime)
    resp.headers["Content-Disposition"] = 'attachment; filename="%s"' % filename
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/api/scraper/tasks", methods=["GET"])
def api_scraper_tasks():
    return jsonify({"ok": True, "tasks": sc.list_tasks()})


@bp.route("/api/scraper/tasks", methods=["POST"])
def api_scraper_task_save():
    data = _body()
    try:
        task = sc.save_task(
            data.get("id") or "",
            data.get("name") or "",
            data.get("url") or "",
            data.get("cfg") or {},
            rows=data.get("rows") or 0,
        )
    except Exception as e:
        return _fail(e, 400)
    return jsonify({"ok": True, "task": task, "user": session.get("username") or ""})


@bp.route("/api/scraper/tasks/delete", methods=["POST"])
def api_scraper_task_delete():
    data = _body()
    ok = sc.delete_task(data.get("id") or "")
    return jsonify({"ok": bool(ok), "error": "" if ok else "删除失败"})
