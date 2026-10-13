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


def _sort_value(v):
    """归一化排序值，保证不同类型可比较：数字 < 字符串 < 空值。"""
    if isinstance(v, bool):
        return (0, float(v), "")
    if isinstance(v, (int, float)):
        return (0, float(v), "")
    if v is None or v == "":
        return (2, 0.0, "")
    return (1, 0.0, str(v).lower())


def _field_of(row, field):
    if isinstance(row, dict):
        return row.get(field)
    return getattr(row, field, None)


def apply_sort(rows, request, keymap=None):
    """按 ?sort=<字段>&order=asc|desc 排序；未传 sort 时原样返回。

    - keymap：可选的「前端列名 → 行字段」映射（通常直接传字段名即可）；
    - 空值（None / 空串）始终排在最后，不受升序 / 降序影响。
    """
    field = (request.args.get("sort") or "").strip()
    if not field:
        return list(rows)
    if keymap:
        field = keymap.get(field, field)
    rev = (request.args.get("order") or "asc").strip().lower() == "desc"

    present, empty = [], []
    for r in rows:
        (empty if _sort_value(_field_of(r, field))[0] == 2 else present).append(r)
    present.sort(key=lambda r: _sort_value(_field_of(r, field)), reverse=rev)
    return present + empty


def paginate(rows, request, search=True, sort=True, sort_key=None):
    """对 rows（list[dict]）做关键字过滤 + 排序 + 分页，返回 (page_items, total)。"""
    rows = list(rows)
    q = (request.args.get("q") or "").strip().lower()
    if search and q:
        rows = [r for r in rows if _match(r, q)]
    if sort:
        rows = apply_sort(rows, request, sort_key)
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
