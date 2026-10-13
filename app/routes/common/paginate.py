"""后台表格通用的「关键字搜索 + 分页」辅助。

多数后台列表接口返回全部记录；用本模块在接口层统一做：
  1. 关键字搜索：不区分大小写，在所有基础类型字段（str/int/float/bool）上做子串匹配；
  2. 分页：按 page / page_size 切片。

用法：
    from ...common.paginate import paginate
    page_items, total = paginate(all_rows, request)
    return jsonify({"items": page_items, "total": total, ...})
"""


def _match(row, q):
    for v in row.values():
        if isinstance(v, (str, int, float, bool)):
            if q in str(v).lower():
                return True
    return False


def paginate(rows, request, search=True):
    """对 rows（list[dict]）做关键字过滤 + 分页，返回 (page_items, total)。"""
    rows = list(rows)
    q = (request.args.get("q") or "").strip().lower()
    if search and q:
        rows = [r for r in rows if _match(r, q)]
    total = len(rows)
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        size = max(1, min(500, int(request.args.get("page_size", 10))))
    except (TypeError, ValueError):
        size = 10
    start = (page - 1) * size
    return rows[start:start + size], total


def paginate_opt(rows, request):
    """仅当请求显式携带 page 参数时才分页；否则返回全量 (rows, None)。

    供「IDE 主界面与后台管理共用」的接口使用：
      · IDE 端不传 page → 拿到全量列表（保持原有返回结构，行为不变）；
      · 后台表格始终传 page → 拿到 {分页切片, total}。
    """
    if request.args.get("page"):
        return paginate(rows, request)
    return list(rows), None
