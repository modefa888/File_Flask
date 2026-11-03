// ==================================================================
// ==UserScript==
// @name         可视化采集（点选任意网站数据）
// @namespace    file-flask.visual-scraper
// @version      1.7.1
// @description  点选列表项 → 点选字段 → 自动生成 CSS / XPath → 元素树查看 → 当页预览 → 跨页采集 → 导出 CSV / JSON。规则按站点自动保存，支持黑夜 / 白天主题。
// @author       File_Flask
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==
/* ------------------------------------------------------------------
   使用说明
   --------
   1. 右下角「采」按钮打开面板（标题栏可拖动，🌙/☀️ 切换黑白主题）；
   2. 点「① 选列表项」→ 在页面里点任意一条数据（整行 / 整张卡片）；
   3. 点「② 选字段」→ 逐个点要采集的内容，字段名 / 取值方式自动判断；
   4. 字段行 🔍 打开「元素树」：左边 DOM 树、右边 XPath / CSS / 属性，
      点「用」直接把字段设成取某个属性，或用某个 XPath / CSS 写回字段；
   5. 「提取本页」预览表格；「跨页」自动点下一页连续采集；
   6. 导出 CSV / JSON / 复制到剪贴板；规则按域名自动保存复用。
   快捷键：Esc 退出点选。
   ================================================================== */
(function () {
  "use strict";
  if (window.__VISUAL_SCRAPER__) return;
  window.__VISUAL_SCRAPER__ = true;

  var MAX_PREVIEW_ROWS = 100;      // 面板里最多预览多少行（导出不受影响）
  var HOST = location.host || "localhost";
  var RULE_KEY = "vscr:rules:" + HOST;
  var THEME_KEY = "vscr:theme";
  var Z = 2147483600;

  var state = {
    open: false, mode: "",         // "" 浏览 | "item" 选列表项 | "field" 选字段 | "next" 选下一页
    itemSel: "", nextSel: "", fields: [], rows: [],
    rawRows: [],                   // 未清洗的原始提取行（rows 是清洗后的展示 / 导出行）
    clean: { replaces: [], merges: [], filters: [], filterAnd: true, dropEmpty: false },
    cleanOpen: false,
    crawl: null,                   // { rows, page, max, nextSel, timer }
    adjust: null,                  // { el, stack, sel, count } 列表项确认前的调整状态
    hl: null,
  };

  /* ---------------- 小工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(msg, ok) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:" + (Z + 2) +
      ";max-width:70vw;padding:8px 14px;border-radius:8px;font:12px/1.5 system-ui,sans-serif;" +
      "color:#fff;background:" + (ok === false ? "#c0392b" : ok === "warn" ? "#b7791f" : "#2563eb") +
      ";box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .2s";
    document.documentElement.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = "1"; });
    setTimeout(function () {
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 300);
    }, 2200);
  }
  function absUrl(v) {
    try { return new URL(v, location.href).href; } catch (e) { return v; }
  }

  /* ---------------- 主题 ---------------- */
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
    applyTheme();
  }
  function applyTheme() {
    var t = getTheme();
    document.querySelectorAll(".vscr-scope").forEach(function (el) { el.dataset.theme = t; });
    var b = $("vscrTheme");
    if (b) {
      b.textContent = t === "dark" ? "🌙" : "☀️";
      b.title = t === "dark" ? "切换到白天主题" : "切换到黑夜主题";
    }
  }

  /* ---------------- 选择器生成（与可视化采集同源算法） ---------------- */
  function clsOk(c) {
    // 前端框架的临时类尽量避开；自己注入的高亮类（vscr-*）绝不能进选择器
    return /^[A-Za-z_][\w-]*$/.test(c) && !/^vscr-/i.test(c) &&
      !/^(is-|has-|active|selected|current|open|show|hide|hover)/i.test(c);
  }
  function seg(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id && /^[A-Za-z][\w-]*$/.test(el.id) ? el.id : "";
    if (id) {
      try { if (document.querySelectorAll("#" + id).length === 1) return "#" + id; } catch (e) { }
    }
    var cls = Array.prototype.slice.call(el.classList || []).filter(clsOk).slice(0, 2);
    if (cls.length) {
      var sel = tag + "." + cls.join(".");
      var parent = el.parentElement;
      if (parent) {
        try { if (parent.querySelectorAll(sel).length === 1) return sel; } catch (e) { }
      }
    }
    var p = el.parentElement, idx = 1;
    if (p) {
      var sibs = Array.prototype.filter.call(p.children, function (x) { return x.tagName === el.tagName; });
      idx = Math.max(1, sibs.indexOf(el) + 1);
    }
    return tag + ":nth-of-type(" + idx + ")";
  }
  function absPath(el) {
    var parts = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 20) {
      var tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      parts.unshift(seg(cur));
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  function relSel(el, root) {
    if (!root) return absPath(el);
    var parts = [], cur = el, guard = 0;
    while (cur && cur !== root && cur.nodeType === 1 && guard++ < 12) {
      parts.unshift(seg(cur));
      cur = cur.parentElement;
    }
    if (cur !== root) return absPath(el);   // 不在列表项里 → 退回绝对路径
    return parts.length ? parts.join(" > ") : ".";
  }
  function xpathOf(el, root) {
    var segs = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && cur !== root && guard++ < 30) {
      var tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      var p = cur.parentElement, idx = 1;
      if (p) {
        var sibs = Array.prototype.filter.call(p.children, function (x) { return x.tagName === cur.tagName; });
        idx = Math.max(1, sibs.indexOf(cur) + 1);
      }
      segs.unshift(tag + "[" + idx + "]");
      cur = cur.parentElement;
    }
    if (root && cur === root) return segs.length ? ".//" + segs.join("/") : ".";
    return "//" + segs.join("/");
  }
  function itemSelOf(el) {
    var allowBare = ["li", "tr", "article", "dd", "dt", "figure", "section", "option"];
    var cur = el, fallback = "", guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 7) {
      var tag = cur.tagName.toLowerCase();
      if (tag === "body" || tag === "html") break;
      var cls = Array.prototype.slice.call(cur.classList || []).filter(clsOk).slice(0, 2);
      if (cls.length) {
        var cand = tag + "." + cls.join(".");
        var n = 0;
        try { n = document.querySelectorAll(cand).length; } catch (e) { }
        if (n >= 2) return cand;
        if (n === 1 && !fallback) fallback = cand;
      } else if (allowBare.indexOf(tag) >= 0) {
        var m = 0;
        try { m = document.querySelectorAll(tag).length; } catch (e) { }
        if (m >= 2) return tag;
      }
      cur = cur.parentElement;
    }
    return fallback || absPath(el);
  }

  /* ---------------- 选择器求值（CSS / XPath） ---------------- */
  function isXPath(sel) {
    var s = String(sel || "").trim();
    return s.indexOf("/") === 0 || s.indexOf(".//") === 0 ||
      s.indexOf("(//") === 0 || s.indexOf("(.//") === 0;
  }
  function evalXPath(expr, root) {
    var e = String(expr || "").trim();
    if (e.indexOf("//") === 0) e = "." + e;
    try {
      var r = document.evaluate(e, root || document, null, XPathResult.ANY_TYPE, null);
      if (r.resultType === XPathResult.STRING_TYPE) return r.stringValue;
      if (r.resultType === XPathResult.NUMBER_TYPE) return String(r.numberValue);
      if (r.resultType === XPathResult.BOOLEAN_TYPE) return String(r.booleanValue);
      var out = [], n;
      while ((n = r.iterateNext())) out.push(n);
      return out;
    } catch (err) { return null; }
  }
  function itemNodes(sel) {
    var s = String(sel || "").trim();
    if (!s) return [];
    if (isXPath(s)) {
      var res = evalXPath(s, document);
      var arr = Array.isArray(res) ? res : (res ? [res] : []);
      return arr.filter(function (n) { return n && n.nodeType === 1; });
    }
    try { return Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { return []; }
  }
  function itemRootOf(el, sel) {
    var s = String(sel || "").trim();
    if (!s) return null;
    if (isXPath(s)) {
      var res = evalXPath(s, document);
      var arr = Array.isArray(res) ? res : (res ? [res] : []);
      var best = null;
      arr.forEach(function (n) {
        if (!n || n.nodeType !== 1 || !n.contains(el)) return;
        if (!best || best.contains(n)) best = n;
      });
      return best;
    }
    try { return el.closest(s); } catch (e) { return null; }
  }

  /* ---------------- 提取 ---------------- */
  /* rawFromEl / localValue 产出「原始值」；fieldValue 套用字段取值规则
     （替换 / 前后缀拼接），所有出口统一走 fieldValue，预览和提取结果一致 */
  function rawFromEl(el, f) {
    if (!el) return "";
    if (f.type === "html") return (el.innerHTML || "").trim();
    if (f.type === "attr") {
      var v = el.getAttribute(f.attr || "href") || "";
      if (v && (f.attr === "href" || f.attr === "src")) v = absUrl(v);
      return v;
    }
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
  function fieldValue(v, f) {
    var s = (v == null ? "" : String(v));
    (f.rules || []).forEach(function (r) {
      if (r.type !== "replace" || !r.find) return;
      if (r.regex) { try { s = s.replace(new RegExp(r.find, "g"), r.to); } catch (e) { } }
      else s = s.split(r.find).join(r.to);
    });
    if (f.prefix) s = f.prefix + s;
    if (f.suffix) s = s + f.suffix;
    return s;
  }
  function valueFrom(el, f) { return fieldValue(rawFromEl(el, f), f); }
  function localValue(root, f) {
    var sel = String(f.selector || "").trim();
    if (isXPath(sel)) {
      var res = evalXPath(sel, root);
      if (typeof res === "string") return res;
      return rawFromEl(Array.isArray(res) ? res[0] : res, f);
    }
    var hit = null;
    if (!sel || sel === ".") hit = root;
    else {
      try { hit = root.querySelector(sel); } catch (e) { }
      // 文档级选择器（点选时选到了列表项外面）：整页兜底一次
      if (!hit && f.abs) { try { hit = document.querySelector(sel); } catch (e) { } }
    }
    return rawFromEl(hit, f);
  }
  function extractRows(limit) {
    var roots = itemNodes(state.itemSel).slice(0, limit || 5000);
    return roots.map(function (r) {
      var row = {};
      state.fields.forEach(function (f) {
        if (f.multi) {
          var vals = [];
          if (isXPath(f.selector)) {
            var res = evalXPath(f.selector, r);
            (Array.isArray(res) ? res : (res ? [res] : [])).forEach(function (n) {
              vals.push(typeof n === "string" ? n : valueFrom(n, f));
            });
          } else {
            var hits = [];
            try { hits = Array.prototype.slice.call(r.querySelectorAll(f.selector || "*")); } catch (e) { }
            hits.forEach(function (n) { vals.push(valueFrom(n, f)); });
          }
          row[f.name] = vals.filter(Boolean).join(" | ");
        } else {
          row[f.name] = fieldValue(localValue(r, f), f);
        }
      });
      return row;
    });
  }
  function guessList() {
    var groups = {}, all = document.querySelectorAll("body *");
    var limit = Math.min(all.length, 3000);
    for (var i = 0; i < limit; i++) {
      var el = all[i];
      var tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "br") continue;
      var cls = Array.prototype.slice.call(el.classList || []).filter(clsOk);
      var key = "";
      if (cls.length) key = tag + "." + cls[0];
      else if (["li", "tr", "article", "dd"].indexOf(tag) >= 0) key = tag;
      else continue;
      var g = groups[key] || (groups[key] = { key: key, n: 0, text: 0 });
      g.n++;
      g.text += (el.textContent || "").length;
    }
    var best = null;
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.n < 3) return;
      if (g.text / g.n < 8) return;                    // 基本没文字的多半是布局容器
      if (!best) { best = g; return; }
      if (g.n > best.n || (g.n === best.n && g.text / g.n > best.text / best.n)) best = g;
    });
    return best;
  }

  /* ---------------- 规则存取（按域名） ---------------- */
  function saveRule() {
    try {
      localStorage.setItem(RULE_KEY, JSON.stringify({
        itemSel: state.itemSel, nextSel: state.nextSel, fields: state.fields, clean: state.clean,
      }));
    } catch (e) { }
  }
  function loadRule() {
    try {
      var d = JSON.parse(localStorage.getItem(RULE_KEY) || "null");
      if (d && d.itemSel) {
        state.itemSel = d.itemSel || "";
        state.nextSel = d.nextSel || "";
        state.fields = Array.isArray(d.fields) ? d.fields : [];
        if (d.clean && typeof d.clean === "object") {
          state.clean = {
            replaces: Array.isArray(d.clean.replaces) ? d.clean.replaces : [],
            merges: Array.isArray(d.clean.merges) ? d.clean.merges : [],
            filters: Array.isArray(d.clean.filters) ? d.clean.filters : [],
            filterAnd: d.clean.filterAnd !== false,
            dropEmpty: !!d.clean.dropEmpty,
          };
        }
        return true;
      }
    } catch (e) { }
    return false;
  }

  /* ---------------- 点选（悬停高亮 + 点击取元素） ---------------- */
  var styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = VSCR_CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }
  function setHl(el) {
    if (state.hl === el) return;
    if (state.hl) { try { state.hl.classList.remove("vscr-hover"); } catch (e) { } }
    state.hl = el;
    if (el) { try { el.classList.add("vscr-hover"); } catch (e) { } }
  }
  function clearMatches() {
    try {
      document.querySelectorAll(".vscr-match").forEach(function (n) { n.classList.remove("vscr-match"); });
    } catch (e) { }
  }
  function isOurUi(el) {
    return !!(el.closest && (el.closest("#vscrPanel") || el.closest("#vscrFab") ||
      el.closest("#vscrModal") || el.closest("#vscrAdj") || el.closest("#vscrPop") ||
      el.closest("#vscrCode")));
  }
  /* 穿透浮层：站点常用跟随鼠标的提示层 / 透明遮罩盖在卡片上，
     直接点到的 target 是浮层（不在列表项里）→ 点选全落空。
   用 elementsFromPoint 把这个点上的元素从上到下全拿出来，
   取第一个真正在列表项里的那一层。 */
  function pickTarget(e) {
    var cands = [];
    try { cands = document.elementsFromPoint(e.clientX, e.clientY); } catch (err) { }
    if (!cands.length) cands = [e.target];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c || c.nodeType !== 1 || isOurUi(c)) continue;
      if (state.mode === "field" && state.itemSel) {
        if (itemRootOf(c, state.itemSel)) return c;
        continue;                          // 这层是浮层，往下找真正的卡片内容
      }
      return c;                            // item 模式 / 未设列表项：直接用最上层
    }
    return e.target;
  }
  function pickOnMove(e) {
    if (state.adjust) return;          // 调整中：高亮锁定在候选元素上，不跟随鼠标
    if (!state.mode) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || /^(HTML|BODY)$/.test(el.tagName) || isOurUi(el)) return;
    if (state.mode === "field" && state.itemSel) el = pickTarget(e) || el;
    setHl(el);
  }
  function pickOnClick(e) {
    var raw = e.target;
    // 自己面板 / 悬浮球 / 弹层 / 调整条上的点击先放行（必须在拦截之前，
    // 否则点选模式和调整状态激活时自己的按钮全会失效）
    if (raw && raw.closest && isOurUi(raw)) return;
    // 列表项调整中：拦下页面点击，防止误点链接跳走，等确认 / 取消
    if (state.adjust) { e.preventDefault(); e.stopPropagation(); return; }
    if (!state.mode) return;
    if (!raw || raw.nodeType !== 1 || /^(HTML|BODY)$/.test(raw.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      var el = (state.mode === "field" && state.itemSel) ? (pickTarget(e) || raw) : raw;
      // 先摘掉高亮类再取选择器 / 字段名，自己的临时类绝不进规则
      try { el.classList.remove("vscr-hover"); } catch (err) { }
      setHl(null);

      if (state.mode === "item") {
        // 不立即保存：先进入调整状态，可扩大 / 缩小，点「确认」才落定
        startAdjust(el);
        return;
      }
      if (state.mode === "next") {
        // 下一页按钮不在列表项里：用绝对路径选择器记下来
        state.nextSel = absPath(el);
        var ni = $("vscrNext");
        if (ni) ni.value = state.nextSel;
        saveRule();
        setMode("");
        toast("下一页按钮已设置：" + state.nextSel, true);
        return;
      }
      if (state.mode === "field") {
        if (!state.itemSel) { toast("先选列表项，再选字段", false); return; }
        var root = itemRootOf(el, state.itemSel);
        if (!root) { toast("这个元素不在列表项里：请点列表项内部的内容", false); return; }
        var css = relSel(el, root);
        var tag = el.tagName.toLowerCase();
        var name = (Array.prototype.slice.call(el.classList || []).filter(clsOk)[0] || "")
          .replace(/^(item|list|post|card)[-_]?/i, "") || (tag === "a" ? "链接" : tag === "img" ? "图片" : (/^h[1-6]$/.test(tag) ? "标题" : tag));
        var base = name, i = 2;
        while (state.fields.some(function (f) { return f.name === name; })) { name = base + i; i++; }
        var type = "text", attr = "";
        if (tag === "a" && el.getAttribute("href")) { type = "attr"; attr = "href"; }
        else if (tag === "img" && el.getAttribute("src")) { type = "attr"; attr = "src"; }
        state.fields.push({ name: name, selector: css, type: type, attr: attr, multi: false, abs: false });
        try { el.classList.add("vscr-picked"); } catch (err) { }
        renderPanel();
        saveRule();
        toast("已添加字段：" + css, true);
      }
    } catch (err) {
      toast("点选出错：" + (err && err.message || err), false);
    }
  }

  /* ---------------- 列表项调整（扩大 / 缩小 / 确认后才保存） ---------------- */
  function showAdj(b) {
    var bar = $("vscrAdj");
    if (!bar) return;
    bar.style.display = b ? "flex" : "none";
    if (b) applyTheme();
  }
  function startAdjust(el) {
    try { el.classList.remove("vscr-hover"); } catch (e) { }
    setHl(null);
    state.adjust = { el: el, stack: [], sel: "", count: 0 };
    // 注意：不动 state.mode —— 面板上「① 选列表项」保持高亮，
    // 调整期间页面点击由 pickOnClick 里的 state.adjust 分支拦下
    renderPanel();
    showAdj(true);
    updateAdjust();
  }
  function updateAdjust() {
    var a = state.adjust;
    if (!a) return;
    a.sel = itemSelOf(a.el);
    var nodes = itemNodes(a.sel);
    a.count = nodes.length;
    // 蓝框标出当前候选元素，虚线框标出该选择器命中的所有行
    clearMatches();
    try {
      document.querySelectorAll(".vscr-picked").forEach(function (n) { n.classList.remove("vscr-picked"); });
    } catch (e) { }
    setHl(a.el);
    try { nodes.slice(0, 200).forEach(function (n) { n.classList.add("vscr-match"); }); } catch (e) { }
    $("vscrAdjSel").textContent = a.sel;
    $("vscrAdjSel").title = a.sel;
    $("vscrAdjCount").textContent = "匹配 " + a.count + " 项";
    $("vscrAdjCount").style.color = a.count ? "var(--ok)" : "var(--bad)";
    $("vscrItem").value = a.sel;           // 输入框同步显示候选（未保存）
  }
  function adjExpand() {
    var a = state.adjust;
    if (!a) return;
    var p = a.el.parentElement;
    if (!p || /^(HTML|BODY)$/.test(p.tagName)) { toast("已经到最外层了", "warn"); return; }
    a.stack.push(a.el);
    a.el = p;
    updateAdjust();
  }
  function adjShrink() {
    var a = state.adjust;
    if (!a) return;
    if (!a.stack.length) { toast("已经是最开始选中的元素了", "warn"); return; }
    a.el = a.stack.pop();
    updateAdjust();
  }
  function adjConfirm() {
    var a = state.adjust;
    if (!a) return;
    if (!a.count) { toast("这个选择器匹配不到元素，先「扩大」或换一个", "warn"); return; }
    state.itemSel = a.sel;
    state.adjust = null;
    showAdj(false);
    clearMatches();
    setHl(null);
    syncItem();
    saveRule();
    toast("已确认列表项：" + state.itemSel, true);
    setMode("field");                      // 确认后自动进入选字段
  }
  function adjCancel() {
    state.adjust = null;
    showAdj(false);
    clearMatches();
    setHl(null);
    $("vscrItem").value = state.itemSel;   // 恢复成已保存的选择器
    renderPanel();
    setMode("item");
  }

  function setMode(m) {
    state.mode = m;
    document.body.classList.toggle("vscr-picking", !!m);
    setHl(null);
    // 浏览模式把页面上的选中状态全部藏起来（命中框 / 已选标记），保持页面干净；
    // 切回点选模式时 renderPanel 会自动把命中框画回来
    if (!m) {
      clearMatches();
      try {
        document.querySelectorAll(".vscr-picked").forEach(function (n) { n.classList.remove("vscr-picked"); });
      } catch (e) { }
    }
    renderPanel();
  }

  /* ---------------- 元素树查看器 ----------------
   左边拍平的 DOM 子树（相对列表项），右边 XPath / CSS / 属性列表。
   油猴脚本和页面同文档：悬停树节点直接高亮页面元素，比 iframe 版更直接。 */
  var viewer = { field: null, nodes: [], root: null, idx: -1 };

  function findFieldEl(f, items) {
    var s = String(f.selector || "").trim();
    if (!s) return null;
    if (isXPath(s)) {
      var res = evalXPath(s, document);
      var el = Array.isArray(res) ? res[0] : res;
      return (el && el.nodeType === 1) ? el : null;
    }
    var scopes = items && items.length ? items : [document];
    for (var i = 0; i < scopes.length; i++) {
      var hit = null;
      try { hit = scopes[i].querySelector(s); } catch (e) { }
      if (hit) return hit;
    }
    try { return document.querySelector(s); } catch (e) { return null; }
  }
  function nodeLabel(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = (typeof el.className === "string" ? el.className : "")
      .trim().split(/\s+/).filter(clsOk).slice(0, 2)
      .map(function (c) { return "." + c; }).join("");
    var tx = "";
    try { tx = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120); } catch (e) { }
    var full = tag + id + cls + (tx ? "  " + tx : "");
    return '<i title="' + esc(full) + '">' + esc(tag + id + cls) + "</i>" +
      (tx ? '<span title="' + esc(full) + '">' + esc(tx) + "</span>" : "");
  }
  function attrsOf(el) {
    var out = [];
    if (!el || !el.attributes) return out;
    for (var i = 0; i < el.attributes.length && out.length < 24; i++) {
      var a = el.attributes[i];
      if (!a || !a.name) continue;
      out.push({ name: a.name, value: String(a.value == null ? "" : a.value) });
    }
    out.sort(function (a, b) {
      var da = /^data-/.test(a.name) ? 0 : 1;
      var db = /^data-/.test(b.name) ? 0 : 1;
      if (da !== db) return da - db;
      return a.name < b.name ? -1 : 1;
    });
    return out;
  }
  function openTree(field) {
    var items = itemNodes(state.itemSel);
    var el = field ? findFieldEl(field, items) : (items[0] || null);
    var root = (el && (itemRootOf(el, state.itemSel) || el.parentElement)) || items[0] || document.body;
    viewer.field = field || null;
    viewer.root = root;
    viewer.sel = el;
    viewer.nodes = [];
    viewer.idx = -1;
    var rows = [];
    (function walk(node, depth) {
      if (!node || node.nodeType !== 1 || rows.length >= 600) return;
      var idx = viewer.nodes.length;
      viewer.nodes.push(node);
      rows.push({ i: idx, depth: depth });
      if (depth >= 8) return;
      for (var k = 0; k < node.children.length; k++) walk(node.children[k], depth + 1);
    })(root, 0);

    var modal = $("vscrModal");
    modal.style.display = "flex";
    applyTheme();
    $("vscrTreeRoot").textContent = "· 相对列表项 " + (state.itemSel || "(未设置)") +
      (field ? "（写回字段「" + field.name + "」）" : "（浏览模式，只读）");
    var writeRow = $("vscrWriteRow");
    if (writeRow) writeRow.style.display = field ? "" : "none";

    var tree = $("vscrTree");
    tree.innerHTML = rows.map(function (r) {
      var nd = viewer.nodes[r.i];
      var full = "";
      try { full = (nd.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300); } catch (e) { }
      return '<div class="vscr-tnode' + (nd === el ? " on" : "") + '" data-i="' + r.i + '"' +
        (full ? ' title="' + esc(full) + '"' : "") +
        ' style="padding-left:' + (8 + r.depth * 14) + 'px">' + nodeLabel(nd) + "</div>";
    }).join("") || '<div class="vscr-empty">没有可显示的节点</div>';

    if (el) selectNode(viewer.nodes.indexOf(el));
    else {
      $("vscrVXp").textContent = field ? (isXPath(field.selector) ? field.selector : "(未匹配到)") : "(未选择)";
      $("vscrVCss").textContent = field ? (!isXPath(field.selector) ? field.selector : "(未匹配到)") : "(未选择)";
      $("vscrVHtml").textContent = "";
      $("vscrVAttrs").innerHTML = '<div class="vscr-vsec">在左边点一个节点查看它的 XPath / CSS / 属性</div>';
    }
    var on = tree.querySelector(".vscr-tnode.on");
    if (on) { try { on.scrollIntoView({ block: "nearest" }); } catch (e) { } }
  }
  function selectNode(i) {
    var el = viewer.nodes[i];
    if (!el) return;
    viewer.idx = i;
    var tree = $("vscrTree");
    tree.querySelectorAll(".vscr-tnode").forEach(function (n) {
      n.classList.toggle("on", Number(n.dataset.i) === i);
    });
    var root = viewer.root;
    var xp = el === root ? "." : xpathOf(el, root);
    var css = el === root ? "." : relSel(el, root);
    $("vscrVXp").textContent = xp || "(空)";
    $("vscrVCss").textContent = css || "(空)";
    $("vscrVHtml").textContent = (el.outerHTML || "").slice(0, 4000);
    var attrs = attrsOf(el);
    $("vscrVAttrs").innerHTML = attrs.length
      ? '<div class="vscr-vsec">属性' + (viewer.field ? "（点「用」直接取这个值）" : "") + "</div>" +
        attrs.map(function (a) {
          var v = a.value.length > 60 ? a.value.slice(0, 60) + "…" : a.value;
          return '<div class="vscr-atr">' +
            '<code class="vscr-atr-n" title="' + esc(a.name) + '">' + esc(a.name) + "</code>" +
            '<code class="vscr-atr-v" title="' + esc(a.value) + '">' + esc(v) + "</code>" +
            (viewer.field ? '<button class="vscr-btn vscr-atr-use" data-attr="' + esc(a.name) + '">用</button>' : "") +
            "</div>";
        }).join("")
      : '<div class="vscr-vsec">这个节点没有属性</div>';
  }
  function closeTree() {
    $("vscrModal").style.display = "none";
    setHl(null);
    viewer.field = null;
    viewer.nodes = [];
  }
  function viewerApply(kind) {
    var f = viewer.field;
    if (!f) { toast("请从字段行的 🔍 打开元素树，才能写回字段", "warn"); return; }
    var el = viewer.nodes[viewer.idx];
    if (!el) { toast("先在左边树里选一个节点", "warn"); return; }
    var root = viewer.root;
    var val = kind === "xpath"
      ? (el === root ? "." : xpathOf(el, root))
      : (el === root ? "." : relSel(el, root));
    if (!val) { toast("没有可用的选择器", "warn"); return; }
    f.selector = val;
    saveRule();
    renderPanel();
    closeTree();
    toast("已写回字段「" + f.name + "」：" + val, true);
  }
  function viewerUseAttr(name) {
    var f = viewer.field;
    if (!f) { toast("请从字段行的 🔍 打开元素树，才能写回字段", "warn"); return; }
    var el = viewer.nodes[viewer.idx];
    if (!el) { toast("先在左边树里选一个节点", "warn"); return; }
    var root = viewer.root;
    f.type = "attr";
    f.attr = name;
    f.selector = el === root ? "." : relSel(el, root);
    if (!f.name || /^字段\d+$/.test(f.name)) f.name = name;
    saveRule();
    renderPanel();
    closeTree();
    toast("已设为取属性 " + name + "（" + f.selector + "）", true);
  }

  /* ---------------- UI ---------------- */
  var VSCR_CSS = [
    ".vscr-scope{--bg:#1e1e22;--panel:#26262c;--card:#2b2b31;--line:#3a3a42;--line2:#2f2f36;" +
      "--fg:#dcdcdf;--fg2:#c9c9cf;--dim:#8a8a92;--acc:#38bdf8;--acc2:#a78bfa;--ok:#6fcf8a;--bad:#e08a8a}",
    ".vscr-scope[data-theme='light']{--bg:#eef1f6;--panel:#ffffff;--card:#f3f5f8;--line:#dfe4ec;--line2:#e9edf3;" +
      "--fg:#1f2328;--fg2:#414750;--dim:#6b7280;--acc:#2f6feb;--acc2:#7c3aed;--ok:#1a7f37;--bad:#d1242f}",

    /* 主面板 */
    "#vscrPanel{position:fixed;right:18px;bottom:72px;z-index:" + Z + ";width:372px;" +
      "max-height:calc(100vh - 100px);display:none;flex-direction:column;" +
      "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:12px;overflow:hidden;" +
      "font:12.5px/1.55 system-ui,-apple-system,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.45)}",
    "#vscrHead{flex:none;display:flex;align-items:center;gap:6px;padding:9px 12px;background:var(--card);" +
      "cursor:move;user-select:none;border-bottom:1px solid var(--line)}",
    "#vscrHead .vscr-iconbtn{cursor:pointer;color:var(--dim);background:none;border:none;font-size:13px;padding:2px 5px;border-radius:5px}",
    "#vscrHead .vscr-iconbtn:hover{color:var(--fg);background:var(--bg)}",
    ".vscr-sec{flex:none;border-bottom:1px solid var(--line)}",
    ".vscr-bar{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px}",

    ".vscr-btn{height:26px;padding:0 10px;border-radius:6px;cursor:pointer;background:var(--card);color:var(--fg2);" +
      "border:1px solid var(--line);font:12px system-ui,sans-serif;white-space:nowrap}",
    ".vscr-btn:hover{color:var(--fg);border-color:var(--dim)}",
    ".vscr-btn.on{color:var(--acc);border-color:var(--acc);background:var(--bg)}",
    ".vscr-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}",
    ".vscr-btn.danger{color:var(--bad)}",
    ".vscr-btn:disabled{opacity:.5;cursor:not-allowed}",

    ".vscr-in{height:26px;padding:0 8px;background:var(--card);color:var(--fg);border:1px solid var(--line);" +
      "border-radius:6px;outline:none;font:11px system-ui,sans-serif}",
    ".vscr-in:focus{border-color:var(--acc)}",
    ".vscr-in.mono{font-family:Consolas,monospace;font-size:10.5px}",

    ".vscr-badge{font-size:11px;color:var(--dim)}",
    ".vscr-badge.ok{color:var(--ok)}",
    ".vscr-badge.bad{color:var(--bad)}",

    ".vscr-fld{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:6px 7px;margin-bottom:6px;overflow:hidden}",
    ".vscr-frow{display:flex;gap:4px;align-items:center;margin-bottom:4px;flex-wrap:wrap;row-gap:4px}",
    ".vscr-fld input,.vscr-fld select{height:22px;background:var(--bg);color:var(--fg);border:1px solid var(--line);" +
      "border-radius:4px;font:11px system-ui,sans-serif;padding:0 5px;outline:none}",
    ".vscr-fld input:focus,.vscr-fld select:focus{border-color:var(--acc)}",
    ".vscr-fld .vscr-mono{font-family:Consolas,monospace;font-size:10.5px}",
    ".vscr-x{cursor:pointer;color:var(--dim);border:none;background:none;font-size:12px;padding:2px 4px}",
    ".vscr-x:hover{color:var(--bad)}",

    ".vscr-tbl{border-collapse:collapse;font-size:11px;width:max-content;min-width:100%}",
    ".vscr-tbl th{position:sticky;top:0;background:var(--card);color:var(--fg2);font-weight:600;white-space:nowrap;z-index:1}",
    ".vscr-tbl th,.vscr-tbl td{border:1px solid var(--line2);padding:3px 7px;text-align:left;max-width:320px;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#vscrResult tbody tr:hover td{background:var(--bg)}",

    /* 元素树弹层 */
    "#vscrModal{position:fixed;inset:0;z-index:" + (Z + 1) + ";display:none;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45)}",
    ".vscr-box{width:min(920px,94vw);height:min(620px,84vh);display:flex;flex-direction:column;" +
      "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:10px;overflow:hidden;" +
      "font:12.5px/1.55 system-ui,-apple-system,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.45)}",
    ".vscr-mhead{flex:none;display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--card);" +
      "border-bottom:1px solid var(--line);font-weight:600;overflow:hidden}",
    ".vscr-msub{font-weight:400;font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;min-width:0;flex:1}",
    ".vscr-mmain{flex:1;min-height:0;display:flex;min-width:0}",
    "#vscrTree{flex:none;width:52%;min-width:0;overflow:auto;padding:6px 4px 10px;background:var(--bg);" +
      "border-right:1px solid var(--line);font-family:Consolas,monospace}",
    ".vscr-tnode{display:flex;align-items:baseline;gap:5px;min-height:22px;padding:3px 8px;border-radius:4px;" +
      "cursor:pointer;font-size:11px;color:var(--fg2);white-space:normal;word-break:break-all;line-height:1.45}",
    ".vscr-tnode:hover{background:rgba(56,189,248,.12);color:var(--fg)}",
    ".vscr-tnode.on{background:rgba(56,189,248,.22);color:var(--fg)}",
    ".vscr-tnode i{flex:none;font-style:normal;color:var(--acc);word-break:keep-all}",
    ".vscr-tnode span{min-width:0;color:var(--dim)}",
    ".vscr-mside{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;padding:10px 12px;overflow:auto}",
    ".vscr-vrow{display:flex;align-items:flex-start;gap:8px;font-size:11.5px;min-width:0}",
    ".vscr-vrow b{flex:none;width:42px;color:var(--dim);font-weight:600}",
    ".vscr-vrow code{flex:1;min-width:0;padding:4px 8px;border-radius:5px;background:var(--card);" +
      "border:1px solid var(--line);font-family:Consolas,monospace;font-size:11px;color:var(--fg2);" +
      "white-space:pre-wrap;word-break:break-all;max-height:64px;overflow:auto}",
    "#vscrVAttrs{display:flex;flex-direction:column;gap:4px;max-height:26vh;overflow:auto}",
    ".vscr-vsec{font-size:11px;color:var(--dim)}",
    ".vscr-atr{display:flex;align-items:center;gap:6px;font-size:11px}",
    ".vscr-atr code{font-family:Consolas,monospace}",
    ".vscr-atr-n{flex:none;width:120px;color:var(--acc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".vscr-atr-v{flex:1;min-width:0;color:var(--fg2);background:var(--card);border:1px solid var(--line);" +
      "border-radius:4px;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".vscr-atr-use{flex:none;height:20px;padding:0 8px;font-size:10.5px}",
    "#vscrVHtml{margin:0;flex:1;min-height:60px;max-height:26vh;overflow:auto;padding:8px 10px;border-radius:6px;" +
      "background:var(--card);border:1px solid var(--line);color:var(--fg2);" +
      "font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}",
    ".vscr-empty{padding:18px 12px;font-size:11.5px;color:var(--dim)}",

    /* 生成代码弹层 */
    "#vscrCode{position:fixed;inset:0;z-index:" + (Z + 2) + ";display:none;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45)}",
    "#vscrCodeOut{flex:1;min-height:0;overflow:auto;margin:0;padding:10px 12px;background:var(--bg);" +
      "color:var(--fg2);font-family:Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre;tab-size:2}",

    /* 数据详情悬浮框 */
    "#vscrView{position:fixed;inset:0;z-index:" + (Z + 2) + ";display:none;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45)}",
    ".vscr-fill{display:flex;align-items:center;gap:6px;font-size:11px}",
    ".vscr-fill .n{flex:none;width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}",
    ".vscr-fill .bar{flex:1;height:8px;background:var(--card);border-radius:4px;overflow:hidden}",
    ".vscr-fill .bar > i{display:block;height:100%;background:var(--acc)}",
    ".vscr-fill .p{flex:none;width:78px;text-align:right;color:var(--dim)}",

    /* 列表项调整条 */
    "#vscrAdj{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:" + (Z + 2) + ";" +
      "display:none;align-items:center;gap:6px;padding:8px 12px;background:var(--panel);color:var(--fg);" +
      "border:1px solid var(--acc);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);" +
      "font:12px system-ui,-apple-system,sans-serif;max-width:94vw}",
    "#vscrAdjSel{font-family:Consolas,monospace;font-size:11px;color:var(--acc2);" +
      "max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".vscr-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;" +
      "font-size:10.5px;color:var(--fg2);background:var(--bg);border:1px solid var(--acc)}",
    ".vscr-chip i{cursor:pointer;font-style:normal;opacity:.6;font-size:10px}",
    ".vscr-chip i:hover{opacity:1;color:var(--bad)}",

    /* 取值规则悬浮框 */
    "#vscrPop{position:fixed;z-index:" + (Z + 3) + ";width:300px;display:none;flex-direction:column;gap:6px;" +
      "background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:10px;" +
      "font:12px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.5)}",
    "#vscrPop .vscr-phead{display:flex;align-items:center;gap:6px;font-weight:600}",
    "#vscrPop .vscr-prev{display:flex;flex-direction:column;gap:3px;max-height:110px;overflow:auto;" +
      "background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;" +
      "font-family:Consolas,monospace;font-size:10.5px}",
    "#vscrPop .vscr-prev .r{display:flex;gap:6px;align-items:baseline}",
    "#vscrPop .vscr-prev .a{flex:1;min-width:0;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#vscrPop .vscr-prev .b{flex:1;min-width:0;color:var(--ok);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#vscrPop .vscr-prrow{display:flex;gap:4px;flex-wrap:wrap;align-items:center}",

    /* 页面点选状态（作用在站点元素上，不能用 var()——它们不在 .vscr-scope 里） */
    ".vscr-hover{outline:2px solid #38bdf8 !important;outline-offset:-2px;" +
      "background:rgba(56,189,248,.12) !important;}",
    ".vscr-picked{outline:2px dashed #f59e0b !important;outline-offset:-2px;}",
    ".vscr-match{outline:1px dashed rgba(56,189,248,.55) !important;outline-offset:-1px;}",
    "body.vscr-picking,body.vscr-picking *{cursor:crosshair !important;}",
  ].join("\n");

  function buildUi() {
    ensureStyle();

    var fab = document.createElement("div");
    fab.id = "vscrFab";
    fab.textContent = "采";
    fab.title = "可视化采集";
    fab.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:" + Z +
      ";width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed)" +
      ";color:#fff;font:600 17px/44px system-ui,sans-serif;text-align:center;cursor:pointer;" +
      "user-select:none;box-shadow:0 6px 20px rgba(37,99,235,.45)";
    document.documentElement.appendChild(fab);

    var panel = document.createElement("div");
    panel.id = "vscrPanel";
    panel.className = "vscr-scope";
    panel.dataset.theme = getTheme();
    panel.innerHTML =
      // 标题栏（可拖动 + 主题切换）
      '<div id="vscrHead">' +
        '<b style="font-size:13px">可视化采集</b>' +
        '<span class="vscr-badge">' + esc(HOST) + "</span>" +
        '<span style="margin-left:auto"></span>' +
        '<button class="vscr-iconbtn" id="vscrTheme" title="切换主题">🌙</button>' +
        '<button class="vscr-iconbtn" id="vscrMin" title="收起">—</button>' +
      "</div>" +
      // 模式工具条
      '<div class="vscr-sec vscr-bar">' +
        '<button class="vscr-btn" data-mode="item">① 选列表项</button>' +
        '<button class="vscr-btn" data-mode="field">② 选字段</button>' +
        '<button class="vscr-btn" data-mode="">浏览</button>' +
        '<button class="vscr-btn" id="vscrGuess">自动识别</button>' +
        '<button class="vscr-btn" id="vscrClear">清高亮</button>' +
        '<button class="vscr-btn" id="vscrTreeBtn" title="查看列表项内的 DOM 树，选节点拿 XPath / CSS / 属性">元素树</button>' +
        '<button class="vscr-btn" id="vscrCodeBtn" title="把当前采集规则一键生成可执行代码（Python / Node / 浏览器 JS）">生成代码</button>' +
      "</div>" +
      // 列表项
      '<div class="vscr-sec" style="padding:8px 10px">' +
        '<div style="display:flex;gap:6px;align-items:center">' +
          '<input id="vscrItem" class="vscr-in mono" spellcheck="false" style="flex:1;min-width:0" ' +
            'placeholder="列表项选择器（点选 / 手填，支持 XPath）">' +
          '<span id="vscrCount" class="vscr-badge"></span>' +
        "</div>" +
      "</div>" +
      // 字段列表
      '<div class="vscr-sec" style="display:flex;align-items:center;padding:7px 10px 0">' +
        '<b style="font-size:12px">字段</b><span id="vscrFCount" class="vscr-badge" style="margin-left:6px"></span>' +
        '<button class="vscr-btn" id="vscrAdd" style="margin-left:auto">+ 添加</button>' +
      "</div>" +
      '<div id="vscrFields" class="vscr-sec" style="max-height:200px;overflow:auto;padding:6px 10px"></div>' +
      // 跨页采集 + 提取
      '<div class="vscr-sec vscr-bar" style="align-items:center">' +
        '<button class="vscr-btn primary" id="vscrRun">提取本页</button>' +
        '<input id="vscrNext" class="vscr-in mono" spellcheck="false" style="flex:1;min-width:0" placeholder="下一页按钮选择器（点「选」或手填）">' +
        '<button class="vscr-btn" data-mode="next" title="进入点选状态，直接点页面上的「下一页」按钮自动生成选择器">选</button>' +
        '<input id="vscrMax" class="vscr-in" type="number" min="1" max="50" value="1" title="最多翻页数" style="width:46px">' +
        '<button class="vscr-btn" id="vscrCrawl">跨页</button>' +
        '<button class="vscr-btn danger" id="vscrStop" style="display:none">停止</button>' +
      "</div>" +
      // 分页采集实时状态（只在跨页运行时显示）
      '<div id="vscrCrawlStat" class="vscr-sec" style="display:none;padding:5px 10px;font-size:11px;color:var(--acc)"></div>' +
      // 清洗 / 筛选
      '<div class="vscr-sec" style="display:flex;align-items:center;padding:6px 10px">' +
        '<button class="vscr-btn" id="vscrCleanBtn">清洗 / 筛选</button>' +
        '<span id="vscrCleanBadge" class="vscr-badge" style="margin-left:6px"></span>' +
      "</div>" +
      '<div id="vscrClean" style="display:none;max-height:190px;overflow:auto;padding:6px 10px;border-bottom:1px solid var(--line)">' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:5px">' +
          '<select id="vscrFCol" class="vscr-in" style="flex:1;min-width:76px"></select>' +
          '<select id="vscrFOp" class="vscr-in">' +
            '<option value="contains">包含</option><option value="not_contains">不包含</option>' +
            '<option value="eq">等于</option><option value="ne">不等于</option>' +
            '<option value="regex">正则</option><option value="empty">为空</option>' +
            '<option value="not_empty">不为空</option>' +
          "</select>" +
          '<input id="vscrFVal" class="vscr-in" placeholder="关键字" style="flex:1;min-width:60px">' +
          '<button class="vscr-btn" id="vscrFAdd" title="添加一条筛选规则">+ 筛选</button>' +
        "</div>" +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:5px">' +
          '<button class="vscr-btn" id="vscrFAnd" title="所有规则都满足才保留">全部满足</button>' +
          '<button class="vscr-btn" id="vscrFOr" title="满足任意一条就保留">任意满足</button>' +
          '<button class="vscr-btn" id="vscrFDrop" title="任意一列是空的整行丢掉（广告卡 / 缺数据脏行）">丢弃空值行</button>' +
          '<button class="vscr-btn" id="vscrFClear" style="margin-left:auto">清除全部</button>' +
        "</div>" +
        '<div id="vscrFChips" style="display:flex;flex-wrap:wrap;gap:4px"></div>' +
        '<div class="vscr-badge" style="margin-top:4px">替换 / 拼接已移到每个字段的「规则」按钮里（带实时预览）</div>' +
      "</div>" +
      // 结果
      '<div id="vscrResult" style="flex:1;min-height:60px;overflow:auto"></div>' +
      // 导出条
      '<div class="vscr-sec vscr-bar" style="border-bottom:none;border-top:1px solid var(--line);align-items:center">' +
        '<span id="vscrStat" style="flex:1;font-size:11px;color:var(--dim)">还没提取数据</span>' +
        '<button class="vscr-btn" id="vscrViewBtn" title="查看采集数据的统计信息与数据操作">查看</button>' +
        '<button class="vscr-btn" id="vscrCopy">复制</button>' +
        '<button class="vscr-btn" id="vscrCsv">CSV</button>' +
        '<button class="vscr-btn" id="vscrJson">JSON</button>' +
      "</div>";
    document.documentElement.appendChild(panel);

    // 元素树弹层
    var modal = document.createElement("div");
    modal.id = "vscrModal";
    modal.className = "vscr-scope";
    modal.dataset.theme = getTheme();
    modal.innerHTML =
      '<div class="vscr-box">' +
        '<div class="vscr-mhead">元素树 <span class="vscr-msub" id="vscrTreeRoot"></span>' +
          '<button class="vscr-iconbtn" id="vscrTreeClose" title="关闭" style="margin-left:auto;cursor:pointer;' +
            'color:var(--dim);background:none;border:none;font-size:13px;padding:2px 5px">✕</button>' +
        "</div>" +
        '<div class="vscr-mmain">' +
          '<div id="vscrTree"></div>' +
          '<div class="vscr-mside">' +
            '<div class="vscr-vrow"><b>XPath</b><code id="vscrVXp">(未选择)</code></div>' +
            '<div class="vscr-vrow"><b>CSS</b><code id="vscrVCss">(未选择)</code></div>' +
            '<div id="vscrVAttrs"></div>' +
            '<div class="vscr-bar" id="vscrWriteRow" style="padding:0">' +
              '<button class="vscr-btn" data-use="xpath" title="把这条 XPath 写回该字段">用这个 XPath</button>' +
              '<button class="vscr-btn" data-use="css" title="把这条 CSS 写回该字段">用这个 CSS</button>' +
            "</div>" +
            '<div class="vscr-bar" style="padding:0">' +
              '<button class="vscr-btn" data-copy="xp">复制 XPath</button>' +
              '<button class="vscr-btn" data-copy="css">复制 CSS</button>' +
            "</div>" +
            '<div class="vscr-vsec">左边点节点即可切换目标；鼠标划过节点会在页面上高亮。' +
              "想要属性 / 文本节点，可以把 XPath 改成 <b>.//a/@href</b>、<b>.//span/text()</b>。</div>" +
            '<pre id="vscrVHtml"></pre>' +
          "</div>" +
        "</div>" +
      "</div>";
    document.documentElement.appendChild(modal);

    // 取值规则悬浮框（点字段行的「规则」按钮弹出）
    var pop = document.createElement("div");
    pop.id = "vscrPop";
    pop.className = "vscr-scope";
    pop.dataset.theme = getTheme();
    pop.innerHTML =
      '<div class="vscr-phead">取值规则 <span class="vscr-badge" id="vscrPopName"></span>' +
        '<button class="vscr-iconbtn" id="vscrPopClose" title="关闭" style="margin-left:auto;cursor:pointer;' +
          'color:var(--dim);background:none;border:none;font-size:13px;padding:2px 5px">✕</button>' +
      "</div>" +
      '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--fg2);cursor:pointer">' +
        '<input type="checkbox" id="vscrPopMulti" style="width:auto;height:auto;accent-color:var(--acc)">' +
        "多值（多个匹配用 | 拼接）</label>" +
      '<div class="vscr-prev" id="vscrPopPrev"></div>' +
      '<div class="vscr-prrow">' +
        '<span class="vscr-badge" style="flex:none">替换</span>' +
        '<input id="vscrPopFind" class="vscr-in" placeholder="查找" style="flex:1;min-width:56px">' +
        '<input id="vscrPopTo" class="vscr-in" placeholder="替换为" style="flex:1;min-width:56px">' +
        '<label style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dim);cursor:pointer">' +
          '<input type="checkbox" id="vscrPopRe" style="width:auto;height:auto;accent-color:var(--acc)">正则</label>' +
        '<button class="vscr-btn" id="vscrPopRAdd" title="把这条替换规则加到该字段">添加</button>' +
      "</div>" +
      '<div id="vscrPopChips" style="display:flex;flex-wrap:wrap;gap:4px"></div>' +
      '<div class="vscr-prrow">' +
        '<span class="vscr-badge" style="flex:none">拼接</span>' +
        '<input id="vscrPopPre" class="vscr-in" placeholder="前缀" style="flex:1;min-width:56px">' +
        '<input id="vscrPopSuf" class="vscr-in" placeholder="后缀" style="flex:1;min-width:56px">' +
      "</div>";
    document.documentElement.appendChild(pop);

    // 生成代码弹层
    var cmodal = document.createElement("div");
    cmodal.id = "vscrCode";
    cmodal.className = "vscr-scope";
    cmodal.dataset.theme = getTheme();
    cmodal.innerHTML =
      '<div class="vscr-box">' +
        '<div class="vscr-mhead">生成采集代码' +
          '<select id="vscrCodeLang" class="vscr-in" style="flex:none">' +
            '<option value="py_bs4">Python · requests + BeautifulSoup</option>' +
            '<option value="py_lxml">Python · requests + lxml（支持 XPath）</option>' +
            '<option value="node_cheerio">Node.js · axios + cheerio</option>' +
            '<option value="js_dom">浏览器 JS · fetch + DOMParser</option>' +
          "</select>" +
          '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dim);cursor:pointer">' +
            '<input type="checkbox" id="vscrCodeNext" style="width:auto;height:auto;accent-color:var(--acc)">按下一页翻页</label>' +
          '<button class="vscr-iconbtn" id="vscrCodeClose" title="关闭" style="margin-left:auto;cursor:pointer;' +
            'color:var(--dim);background:none;border:none;font-size:13px;padding:2px 5px">✕</button>' +
        "</div>" +
        '<pre id="vscrCodeOut"></pre>' +
        '<div class="vscr-sec vscr-bar" style="border-bottom:none;border-top:1px solid var(--line)">' +
          '<span class="vscr-badge" style="flex:1">代码里已包含你配置的取值规则（替换 / 前后缀 / 多值）</span>' +
          '<button class="vscr-btn" id="vscrCodeCopy">复制</button>' +
          '<button class="vscr-btn" id="vscrCodeDl">下载</button>' +
        "</div>" +
      "</div>";
    document.documentElement.appendChild(cmodal);

    // 列表项调整条（点选列表项后出现，确认才保存）
    var adj = document.createElement("div");
    adj.id = "vscrAdj";
    adj.className = "vscr-scope";
    adj.dataset.theme = getTheme();
    adj.innerHTML =
      '<span style="flex:none;font-weight:600">列表项调整</span>' +
      '<span id="vscrAdjSel" class="vscr-badge" title=""></span>' +
      '<span id="vscrAdjCount" class="vscr-badge" style="flex:none"></span>' +
      '<button class="vscr-btn" id="vscrAdjUp" title="选中元素的上一级（选择范围更大）">扩大 ⊃</button>' +
      '<button class="vscr-btn" id="vscrAdjDown" title="退回上一级（选择范围更小）">缩小 ⊂</button>' +
      '<button class="vscr-btn primary" id="vscrAdjOk" title="保存这个选择器">确认</button>' +
      '<button class="vscr-btn" id="vscrAdjNo" title="放弃本次选择">取消</button>';
    document.documentElement.appendChild(adj);

    // 数据详情弹层（查看 + 数据操作）
    var vmodal = document.createElement("div");
    vmodal.id = "vscrView";
    vmodal.className = "vscr-scope";
    vmodal.dataset.theme = getTheme();
    vmodal.innerHTML =
      '<div class="vscr-box" style="width:min(540px,92vw);height:min(560px,82vh)">' +
        '<div class="vscr-mhead">数据详情' +
          '<button class="vscr-iconbtn" id="vscrViewClose" title="关闭" style="margin-left:auto;cursor:pointer;' +
            'color:var(--dim);background:none;border:none;font-size:13px;padding:2px 5px">✕</button>' +
        "</div>" +
        '<div class="vscr-mside">' +
          '<div id="vscrViewStats" style="display:flex;flex-wrap:wrap;gap:6px"></div>' +
          '<div class="vscr-vsec">列填充情况（非空 / 总行数）——填充率低的列多半是懒加载没等到</div>' +
          '<div id="vscrViewCols" style="display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto"></div>' +
          '<div class="vscr-vsec">数据表格（全部 ' + '<span id="vscrViewRows">0</span> 行）</div>' +
          '<div id="vscrViewTable" style="max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:6px"></div>' +
          '<div class="vscr-vsec">数据操作</div>' +
          '<div class="vscr-bar" style="padding:0">' +
            '<button class="vscr-btn" id="vscrViewDedup" title="整行完全相同的只保留第一条">整行去重</button>' +
            '<button class="vscr-btn" id="vscrViewRev" title="行顺序倒过来">反转顺序</button>' +
            '<button class="vscr-btn" id="vscrViewRe" title="重新提取当前页数据（用于补漏）">重新提取</button>' +
            '<button class="vscr-btn danger" id="vscrViewClear" title="清空已采集的所有数据">清空数据</button>' +
          "</div>" +
        "</div>" +
      "</div>";
    document.documentElement.appendChild(vmodal);

    bindUi();
    applyTheme();
    syncItem();
  }

  function renderPanel() {
    document.querySelectorAll("#vscrPanel [data-mode]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.mode === state.mode);
    });
    var cnt = $("vscrCount");
    if (cnt) {
      var n = state.itemSel ? itemNodes(state.itemSel).length : 0;
      cnt.textContent = state.itemSel ? ("匹配 " + n + " 项") : "";
      cnt.className = "vscr-badge" + (state.itemSel ? (n ? " ok" : " bad") : "");
      // 把命中的行框出来（只框前 200 个）；只在点选列表项 / 字段时画，浏览 / 选下一页不画
      clearMatches();
      if (n && (state.mode === "item" || state.mode === "field")) {
        try {
          itemNodes(state.itemSel).slice(0, 200).forEach(function (x) { x.classList.add("vscr-match"); });
        } catch (e) { }
      }
    }
    var fc = $("vscrFCount");
    if (fc) fc.textContent = state.fields.length;

    var box = $("vscrFields");
    if (box) {
      if (!state.fields.length) {
        box.innerHTML = '<div class="vscr-badge" style="padding:4px 2px">还没有字段：切到「② 选字段」在页面上点要采集的内容。</div>';
      } else {
        box.innerHTML = state.fields.map(function (f, i) {
          var rn = (f.rules || []).length + (f.prefix ? 1 : 0) + (f.suffix ? 1 : 0);
          var rtxt = "规则" + (rn ? "(" + rn + ")" : "");
          return '<div class="vscr-fld" data-fi="' + i + '">' +
            '<div class="vscr-frow">' +
              '<input class="vscr-name" value="' + esc(f.name) + '" placeholder="字段名" style="flex:1;min-width:0">' +
              '<button class="vscr-btn" data-view="' + i + '" title="在元素树里查看该字段，可改用 XPath / CSS / 属性" style="padding:0 6px">🔍</button>' +
              '<select class="vscr-type">' +
                '<option value="text"' + (f.type === "text" ? " selected" : "") + ">文本</option>" +
                '<option value="html"' + (f.type === "html" ? " selected" : "") + ">HTML</option>" +
                '<option value="attr"' + (f.type === "attr" ? " selected" : "") + ">属性</option>" +
              "</select>" +
              (f.type === "attr"
                ? '<input class="vscr-attr" value="' + esc(f.attr || "href") + '" placeholder="href" style="width:58px">'
                : "") +
              '<button class="vscr-btn' + (rn ? " on" : "") + '" data-rules="' + i + '" ' +
                'title="取值规则：替换 / 前后缀拼接 / 多值，带实时预览" style="flex:none">' + rtxt + "</button>" +
              '<button class="vscr-x" data-del="' + i + '" title="删除">✕</button>' +
            "</div>" +
            '<input class="vscr-mono" style="width:100%" value="' + esc(f.selector) + '" placeholder="选择器（CSS / XPath）">' +
          "</div>";
        }).join("");
      }
    }
  }

  function syncItem() {
    var inp = $("vscrItem");
    if (inp) inp.value = state.itemSel;
    renderPanel();
  }

  function showTable(rows) {
    var box = $("vscrResult");
    state.rows = rows;
    var stat = $("vscrStat");
    if (!rows.length) {
      box.innerHTML = '<div class="vscr-empty" style="text-align:center">没提取到数据：检查列表项 / 字段选择器</div>';
      if (stat) stat.textContent = "0 行";
      return;
    }
    var cols = Object.keys(rows[0]);
    var head = "<tr><th>#</th>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
    var body = rows.slice(0, MAX_PREVIEW_ROWS).map(function (r, i) {
      return "<tr><td>" + (i + 1) + "</td>" + cols.map(function (c) {
        var v = r[c] == null ? "" : String(r[c]);
        return '<td title="' + esc(v) + '">' + esc(v) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    box.innerHTML = '<table class="vscr-tbl"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
    if (stat) {
      stat.textContent = rows.length + " 行 × " + cols.length + " 列" +
        (state.rawRows.length && state.rawRows.length !== rows.length
          ? ("（清洗 " + state.rawRows.length + " → " + rows.length + "）") : "") +
        (state.crawl ? ("（已采 " + state.crawl.page + " 页）") : "") +
        (rows.length > MAX_PREVIEW_ROWS ? ("（预览前 " + MAX_PREVIEW_ROWS + " 行）") : "");
    }
  }

  /* ---------------- 数据清洗（拼接 → 替换 → 筛选 → 丢弃空值行） ----------------
   rawRows 永远保存原始提取数据，清洗只影响展示 / 导出的 rows，
   所以随时「清除」就能回到全量；规则随采集规则一起按站点保存。 */
  function applyClean() {
    var c = state.clean;
    var rows = (state.rawRows || []).map(function (r) {
      var o = {}; for (var k in r) o[k] = r[k]; return o;
    });
    // ① 拼接：把两列拼成一个新列（空值自动跳过）
    c.merges.forEach(function (m) {
      if (!m.name) return;
      rows.forEach(function (r) {
        var parts = [r[m.a], r[m.b]].filter(function (v) {
          return v != null && String(v).trim() !== "";
        });
        r[m.name] = parts.join(m.sep || "-");
      });
    });
    // ② 替换：普通字符串全量替换；勾了正则按正则替换
    c.replaces.forEach(function (rp) {
      var find = String(rp.find || "");
      if (!find || !rp.col) return;
      var re = null;
      if (rp.regex) { try { re = new RegExp(find, "g"); } catch (e) { return; } }
      rows.forEach(function (r) {
        var v = r[rp.col];
        if (v == null) return;
        r[rp.col] = rp.regex ? String(v).replace(re, rp.to) : String(v).split(find).join(rp.to);
      });
    });
    // ③ 筛选：按字符串规则保留 / 丢弃行
    var cols = rows.length ? Object.keys(rows[0]) : [];
    rows = rows.filter(function (r) {
      var tests = c.filters.map(function (f) {
        var val = (f.col === "*" || !f.col)
          ? cols.map(function (x) { return String(r[x] == null ? "" : r[x]); }).join(" ")
          : String(r[f.col] == null ? "" : r[f.col]);
        var v = String(f.value == null ? "" : f.value);
        switch (f.op) {
          case "empty": return !val.trim();
          case "not_empty": return !!val.trim();
          case "eq": return val.trim() === v.trim();
          case "ne": return val.trim() !== v.trim();
          case "regex": try { return new RegExp(v).test(val); } catch (e) { return true; }
          case "not_contains": return v ? val.indexOf(v) < 0 : true;
          default: return v ? val.indexOf(v) >= 0 : true;
        }
      });
      var ok = tests.length ? (c.filterAnd ? tests.every(Boolean) : tests.some(Boolean)) : true;
      // 丢弃空值行：任意一列是空的整行丢掉（广告卡 / 缺数据这类脏行）
      if (ok && c.dropEmpty) {
        ok = cols.every(function (x) { return String(r[x] == null ? "" : r[x]).trim() !== ""; });
      }
      return ok;
    });
    state.rows = rows;
    refreshCleanCols();
    renderCleanChips();
    showTable(rows);
  }
  function cleanCols() {
    return (state.rawRows && state.rawRows.length) ? Object.keys(state.rawRows[0]) : [];
  }
  function refreshCleanCols() {
    var cols = cleanCols();
    var keep = {};
    var s = $("vscrFCol");
    if (s && s.value) keep.vscrFCol = s.value;
    var opts = function (withAny) {
      var h = withAny ? '<option value="*">任意列</option>' : "";
      return h + cols.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + "</option>"; }).join("");
    };
    var fc = $("vscrFCol");
    if (fc) { fc.innerHTML = opts(true); if (keep.vscrFCol) fc.value = keep.vscrFCol; }
    var badge = $("vscrCleanBadge");
    if (badge) {
      var n = state.clean.filters.length + state.clean.replaces.length + state.clean.merges.length +
        (state.clean.dropEmpty ? 1 : 0);
      badge.textContent = n ? (n + " 条规则") : "";
    }
  }
  function renderCleanChips() {
    var box = $("vscrFChips");
    if (!box) return;
    var c = state.clean, chips = [];
    c.filters.forEach(function (f, i) {
      var op = { contains: "包含", not_contains: "不包含", eq: "等于", ne: "不等于",
        regex: "正则", empty: "为空", not_empty: "不为空" }[f.op] || f.op;
      var col = f.col === "*" ? "任意列" : f.col;
      var val = (f.op === "empty" || f.op === "not_empty") ? "" : "「" + f.value + "」";
      chips.push('<span class="vscr-chip" data-ckind="filter" data-ci="' + i + '">' +
        esc(col) + " " + op + esc(val) + '<i data-ci="' + i + '">✕</i></span>');
    });
    c.replaces.forEach(function (rp, i) {
      chips.push('<span class="vscr-chip" data-ckind="replace">' + esc(rp.col) + ": " +
        esc(rp.find) + " → " + esc(rp.to) + (rp.regex ? " (正则)" : "") +
        '<i data-ri="' + i + '">✕</i></span>');
    });
    c.merges.forEach(function (m, i) {
      chips.push('<span class="vscr-chip" data-ckind="merge">' + esc(m.a) + "+" + esc(m.b) +
        " → " + esc(m.name) + '<i data-mi="' + i + '">✕</i></span>');
    });
    if (c.dropEmpty) chips.push('<span class="vscr-chip">丢弃空值行</span>');
    box.innerHTML = chips.join("");
  }

  /* ---------------- 生成采集代码 ---------------- */
  function pyStr(s) { return JSON.stringify(String(s == null ? "" : s)); }
  function codeFields() {
    return state.fields.filter(function (f) { return String(f.selector || "").trim(); }).map(function (f) {
      return {
        name: f.name, sel: String(f.selector).trim(), type: f.type || "text",
        attr: f.attr || "href", multi: !!f.multi, abs: !!f.abs,
        rules: (f.rules || []).filter(function (r) { return r.type === "replace" && r.find; })
          .map(function (r) { return { find: r.find, to: r.to || "", re: !!r.regex }; }),
        prefix: f.prefix || "", suffix: f.suffix || "",
      };
    });
  }
  function genCtx() {
    return {
      url: location.href.split("#")[0],
      itemSel: state.itemSel || "",
      fields: codeFields(),
      nextSel: state.nextSel || "",
      pages: Math.max(1, Math.min(50, Number($("vscrMax").value) || 1)),
    };
  }
  function pyFields(fs) {
    return "[\n" + fs.map(function (f) {
      var rep = "[" + f.rules.map(function (r) {
        return "(" + pyStr(r.find) + ", " + pyStr(r.to) + ", " + (r.re ? "True" : "False") + ")";
      }).join(", ") + "]";
      return "    {\"name\": " + pyStr(f.name) + ", \"sel\": " + pyStr(f.sel) +
        ", \"type\": " + pyStr(f.type) + ", \"attr\": " + pyStr(f.attr) +
        ", \"multi\": " + (f.multi ? "True" : "False") + ", \"abs\": " + (f.abs ? "True" : "False") +
        ", \"replace\": " + rep + ", \"prefix\": " + pyStr(f.prefix) + ", \"suffix\": " + pyStr(f.suffix) + "}";
    }).join(",\n") + "\n]";
  }
  function jsFields(fs) { return JSON.stringify(fs, null, 2); }

  function genPyBS4(c) {
    var L = [];
    L.push('# -*- coding: utf-8 -*-');
    L.push('"""由「可视化采集」生成 · 页面: ' + c.url + '"');
    L.push('用法: pip install requests beautifulsoup4 && python scrape.py"""');
    if (isXPath(c.itemSel)) L.push("# 注意: BeautifulSoup 不支持 XPath，建议改用 lxml 版本或把选择器换成 CSS");
    L.push("import csv, re, time");
    L.push("from urllib.parse import urljoin");
    L.push("import requests");
    L.push("from bs4 import BeautifulSoup");
    L.push("");
    L.push("URL = " + pyStr(c.url));
    L.push("ITEM_SEL = " + pyStr(c.itemSel) + "   # 列表项");
    L.push("NEXT_SEL = " + pyStr(c.nextSel) + "     # 下一页 <a> 链接（SPA 按钮翻页请改用 Playwright）");
    L.push("MAX_PAGES = " + c.pages);
    L.push("HEADERS = {\"User-Agent\": \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36\"}");
    L.push("FIELDS = " + pyFields(c.fields));
    L.push("");
    L.push("def field_value(item, soup, f):");
    L.push("    if f[\"sel\"] in (\"\", \".\"):");
    L.push("        nodes = [item]");
    L.push("    elif f[\"abs\"]:");
    L.push("        found = soup.select(f[\"sel\"])");
    L.push("        nodes = found if f[\"multi\"] else found[:1]");
    L.push("    elif f[\"multi\"]:");
    L.push("        nodes = item.select(f[\"sel\"])");
    L.push("    else:");
    L.push("        n = item.select_one(f[\"sel\"])");
    L.push("        nodes = [n] if n else []");
    L.push("    vals = []");
    L.push("    for n in nodes:");
    L.push("        if n is None:");
    L.push("            continue");
    L.push("        if f[\"type\"] == \"html\":");
    L.push("            v = n.decode_contents().strip()");
    L.push("        elif f[\"type\"] == \"attr\":");
    L.push("            v = n.get(f[\"attr\"] or \"href\") or \"\"");
    L.push("        else:");
    L.push("            v = \" \".join(n.get_text().split())");
    L.push("        vals.append(v)");
    L.push("    v = \" | \".join([x for x in vals if x]) if f[\"multi\"] else (vals[0] if vals else \"\")");
    L.push("    for find, to, is_re in f[\"replace\"]:");
    L.push("        v = re.sub(find, to, v) if is_re else v.replace(find, to)");
    L.push("    return f[\"prefix\"] + v + f[\"suffix\"]");
    L.push("");
    L.push("def extract(soup):");
    L.push("    return [{f[\"name\"]: field_value(item, soup, f) for f in FIELDS}");
    L.push("            for item in soup.select(ITEM_SEL)]");
    L.push("");
    L.push("def main():");
    L.push("    sess = requests.Session()");
    L.push("    sess.headers.update(HEADERS)");
    L.push("    url = URL");
    L.push("    all_rows = []");
    L.push("    for page in range(1, MAX_PAGES + 1):");
    L.push("        resp = sess.get(url, timeout=15)");
    L.push("        resp.raise_for_status()");
    L.push("        soup = BeautifulSoup(resp.text, \"html.parser\")");
    L.push("        rows = extract(soup)");
    L.push("        all_rows.extend(rows)");
    L.push("        print(\"第 %d 页：%d 行\" % (page, len(rows)))");
    L.push("        if page >= MAX_PAGES or not NEXT_SEL:");
    L.push("            break");
    L.push("        nxt = soup.select_one(NEXT_SEL)");
    L.push("        if not nxt or not nxt.get(\"href\"):");
    L.push("            print(\"找不到下一页链接，结束\")");
    L.push("            break");
    L.push("        url = urljoin(url, nxt.get(\"href\"))");
    L.push("        time.sleep(1)   # 礼貌间隔，按需调整");
    L.push("    with open(\"scrape.csv\", \"w\", newline=\"\", encoding=\"utf-8-sig\") as fh:");
    L.push("        w = csv.DictWriter(fh, fieldnames=list(all_rows[0].keys()) if all_rows else [])");
    L.push("        w.writeheader()");
    L.push("        w.writerows(all_rows)");
    L.push("    print(\"完成：%d 行 → scrape.csv\" % len(all_rows))");
    L.push("");
    L.push("if __name__ == \"__main__\":");
    L.push("    main()");
    return L.join("\n");
  }

  function genPyLxml(c) {
    var L = [];
    L.push('# -*- coding: utf-8 -*-');
    L.push('"""由「可视化采集」生成 · 页面: ' + c.url + '"');
    L.push('用法: pip install requests lxml cssselect && python scrape.py（CSS 与 XPath 选择器都支持）"""');
    L.push("import csv, re, time");
    L.push("from urllib.parse import urljoin");
    L.push("import requests");
    L.push("from lxml import html as LH");
    L.push("");
    L.push("URL = " + pyStr(c.url));
    L.push("ITEM_SEL = " + pyStr(c.itemSel));
    L.push("NEXT_SEL = " + pyStr(c.nextSel));
    L.push("MAX_PAGES = " + c.pages);
    L.push("HEADERS = {\"User-Agent\": \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36\"}");
    L.push("FIELDS = " + pyFields(c.fields));
    L.push("");
    L.push("def nodes_of(scope, sel):");
    L.push("    \"\"\"XPath / CSS 通吃：/ 开头走 XPath，其余走 cssselect\"\"\"");
    L.push("    if not sel:");
    L.push("        return []");
    L.push("    if sel.startswith(\"/\"):");
    L.push("        return scope.xpath(sel)");
    L.push("    return scope.cssselect(sel)");
    L.push("");
    L.push("def field_value(item, doc, f):");
    L.push("    sel = f[\"sel\"]");
    L.push("    if sel in (\"\", \".\"):");
    L.push("        nodes = [item]");
    L.push("    else:");
    L.push("        nodes = nodes_of(doc, sel) if f[\"abs\"] else nodes_of(item, sel)");
    L.push("        if not f[\"multi\"]:");
    L.push("            nodes = nodes[:1]");
    L.push("    vals = []");
    L.push("    for n in nodes:");
    L.push("        if f[\"type\"] == \"html\":");
    L.push("            v = LH.tostring(n, encoding=\"unicode\").strip()");
    L.push("        elif f[\"type\"] == \"attr\":");
    L.push("            v = n.get(f[\"attr\"] or \"href\") or \"\"");
    L.push("        else:");
    L.push("            v = \" \".join(n.text_content().split())");
    L.push("        vals.append(v)");
    L.push("    v = \" | \".join([x for x in vals if x]) if f[\"multi\"] else (vals[0] if vals else \"\")");
    L.push("    for find, to, is_re in f[\"replace\"]:");
    L.push("        v = re.sub(find, to, v) if is_re else v.replace(find, to)");
    L.push("    return f[\"prefix\"] + v + f[\"suffix\"]");
    L.push("");
    L.push("def main():");
    L.push("    sess = requests.Session()");
    L.push("    sess.headers.update(HEADERS)");
    L.push("    url = URL");
    L.push("    all_rows = []");
    L.push("    for page in range(1, MAX_PAGES + 1):");
    L.push("        resp = sess.get(url, timeout=15)");
    L.push("        resp.raise_for_status()");
    L.push("        doc = LH.fromstring(resp.text)");
    L.push("        items = nodes_of(doc, ITEM_SEL)");
    L.push("        for item in items:");
    L.push("            all_rows.append({f[\"name\"]: field_value(item, doc, f) for f in FIELDS})");
    L.push("        print(\"第 %d 页：%d 行\" % (page, len(items)))");
    L.push("        if page >= MAX_PAGES or not NEXT_SEL:");
    L.push("            break");
    L.push("        nxt = nodes_of(doc, NEXT_SEL)[:1]");
    L.push("        if not nxt or not nxt[0].get(\"href\"):");
    L.push("            print(\"找不到下一页链接，结束\")");
    L.push("            break");
    L.push("        url = urljoin(url, nxt[0].get(\"href\"))");
    L.push("        time.sleep(1)");
    L.push("    with open(\"scrape.csv\", \"w\", newline=\"\", encoding=\"utf-8-sig\") as fh:");
    L.push("        w = csv.DictWriter(fh, fieldnames=list(all_rows[0].keys()) if all_rows else [])");
    L.push("        w.writeheader()");
    L.push("        w.writerows(all_rows)");
    L.push("    print(\"完成：%d 行 → scrape.csv\" % len(all_rows))");
    L.push("");
    L.push("if __name__ == \"__main__\":");
    L.push("    main()");
    return L.join("\n");
  }

  function genNodeCheerio(c) {
    var L = [];
    L.push("// 由「可视化采集」生成 · 页面: " + c.url);
    L.push("// 用法: npm i axios cheerio && node scrape.js" +
      (c.fields.some(function (f) { return isXPath(f.sel); }) ? "（注意: cheerio 不支持 XPath，XPath 字段需改写为 CSS）" : ""));
    L.push("const axios = require(\"axios\");");
    L.push("const cheerio = require(\"cheerio\");");
    L.push("const fs = require(\"fs\");");
    L.push("");
    L.push("const URL = " + JSON.stringify(c.url) + ";");
    L.push("const ITEM_SEL = " + JSON.stringify(c.itemSel) + ";");
    L.push("const NEXT_SEL = " + JSON.stringify(c.nextSel) + ";");
    L.push("const MAX_PAGES = " + c.pages + ";");
    L.push("const UA = \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36\";");
    L.push("const FIELDS = " + jsFields(c.fields) + ";");
    L.push("");
    L.push("function fieldValue($, item, $root, f) {");
    L.push("  let nodes;");
    L.push("  if (f.sel === \"\" || f.sel === \".\") nodes = [item];");
    L.push("  else if (f.abs) nodes = $root(f.sel).toArray();");
    L.push("  else nodes = f.multi ? item.find(f.sel).toArray() : item.find(f.sel).first().toArray();");
    L.push("  const vals = nodes.map((n) => {");
    L.push("    const el = $(n);");
    L.push("    if (f.type === \"html\") return (el.html() || \"\").trim();");
    L.push("    if (f.type === \"attr\") return el.attr(f.attr || \"href\") || \"\";");
    L.push("    return el.text().replace(/\\s+/g, \" \").trim();");
    L.push("  });");
    L.push("  let v = f.multi ? vals.filter(Boolean).join(\" | \") : (vals[0] || \"\");");
    L.push("  for (const [find, to, isRe] of f.replace) {");
    L.push("    v = isRe ? v.replace(new RegExp(find, \"g\"), to) : v.split(find).join(to);");
    L.push("  }");
    L.push("  return f.prefix + v + f.suffix;");
    L.push("}");
    L.push("");
    L.push("(async () => {");
    L.push("  let url = URL;");
    L.push("  const rows = [];");
    L.push("  for (let page = 1; page <= MAX_PAGES; page++) {");
    L.push("    const resp = await axios.get(url, { headers: { \"User-Agent\": UA }, timeout: 15000 });");
    L.push("    const $ = cheerio.load(resp.data);");
    L.push("    const items = $(ITEM_SEL).toArray();");
    L.push("    for (const it of items) {");
    L.push("      const row = {};");
    L.push("      for (const f of FIELDS) row[f.name] = fieldValue($, $(it), $.root(), f);");
    L.push("      rows.push(row);");
    L.push("    }");
    L.push("    console.log(`第 ${page} 页：${items.length} 行`);");
    L.push("    if (page >= MAX_PAGES || !NEXT_SEL) break;");
    L.push("    const href = $(NEXT_SEL).first().attr(\"href\");");
    L.push("    if (!href) { console.log(\"找不到下一页链接，结束\"); break; }");
    L.push("    url = new URL(href, url).href;");
    L.push("    await new Promise((r) => setTimeout(r, 1000));");
    L.push("  }");
    L.push("  fs.writeFileSync(\"scrape.json\", JSON.stringify(rows, null, 2));");
    L.push("  console.log(`完成：${rows.length} 行 → scrape.json`);");
    L.push("})();");
    return L.join("\n");
  }

  function genJsDom(c) {
    var L = [];
    L.push("// 由「可视化采集」生成 · 页面: " + c.url);
    L.push("// 用法：在目标站点页面的控制台里运行（受同源策略限制，只能采同源页面）");
    L.push("(async () => {");
    L.push("  const URL = " + JSON.stringify(c.url) + ";");
    L.push("  const ITEM_SEL = " + JSON.stringify(c.itemSel) + ";");
    L.push("  const NEXT_SEL = " + JSON.stringify(c.nextSel) + ";");
    L.push("  const MAX_PAGES = " + c.pages + ";");
    L.push("  const FIELDS = " + jsFields(c.fields) + ";");
    L.push("");
    L.push("  const applyRules = (v, f) => {");
    L.push("    for (const [find, to, isRe] of f.replace) {");
    L.push("      v = isRe ? v.replace(new RegExp(find, \"g\"), to) : v.split(find).join(to);");
    L.push("    }");
    L.push("    return f.prefix + v + f.suffix;");
    L.push("  };");
    L.push("  const pick = (item, doc, f) => {");
    L.push("    let nodes;");
    L.push("    if (f.sel === \"\" || f.sel === \".\") nodes = [item];");
    L.push("    else if (f.abs) nodes = [...doc.querySelectorAll(f.sel)];");
    L.push("    else nodes = f.multi ? [...item.querySelectorAll(f.sel)] : [item.querySelector(f.sel)].filter(Boolean);");
    L.push("    const vals = nodes.map((n) =>");
    L.push("      f.type === \"html\" ? n.innerHTML.trim()");
    L.push("      : f.type === \"attr\" ? (n.getAttribute(f.attr || \"href\") || \"\")");
    L.push("      : n.textContent.replace(/\\s+/g, \" \").trim());");
    L.push("    return applyRules(f.multi ? vals.filter(Boolean).join(\" | \") : (vals[0] || \"\"), f);");
    L.push("  };");
    L.push("");
    L.push("  let url = URL;");
    L.push("  const rows = [];");
    L.push("  for (let page = 1; page <= MAX_PAGES; page++) {");
    L.push("    const html = await (await fetch(url)).text();");
    L.push("    const doc = new DOMParser().parseFromString(html, \"text/html\");");
    L.push("    doc.querySelectorAll(ITEM_SEL).forEach((it) => {");
    L.push("      const row = {};");
    L.push("      FIELDS.forEach((f) => row[f.name] = pick(it, doc, f));");
    L.push("      rows.push(row);");
    L.push("    });");
    L.push("    console.log(`第 ${page} 页：共 ${rows.length} 行`);");
    L.push("    if (page >= MAX_PAGES || !NEXT_SEL) break;");
    L.push("    const a = doc.querySelector(NEXT_SEL);");
    L.push("    if (!a || !a.getAttribute(\"href\")) break;");
    L.push("    url = new URL(a.getAttribute(\"href\"), url).href;");
    L.push("    await new Promise((r) => setTimeout(r, 1000));");
    L.push("  }");
    L.push("  console.table(rows.slice(0, 50));");
    L.push("  window.__SCRAPE_ROWS__ = rows;   // 结果挂在这里，也可直接 copy(rows)");
    L.push("  return rows;");
    L.push("})();");
    return L.join("\n");
  }

  function genCode() {
    var lang = $("vscrCodeLang").value;
    var c = genCtx();
    if (!c.itemSel) { return "// 先选好列表项，再生成代码"; }
    var out;
    if (lang === "py_lxml") out = genPyLxml(c);
    else if (lang === "node_cheerio") out = genNodeCheerio(c);
    else if (lang === "js_dom") out = genJsDom(c);
    else out = genPyBS4(c);
    return out;
  }
  function codeFileName() {
    var lang = $("vscrCodeLang").value;
    return (lang === "py_bs4" || lang === "py_lxml") ? "scrape.py" : "scrape.js";
  }

  /* ---------------- 数据详情（查看 + 操作） ---------------- */
  function renderView() {
    var rows = state.rows || [], raw = state.rawRows || [];
    var cols = rows.length ? Object.keys(rows[0]) : [];
    var nRules = state.clean.filters.length + state.clean.replaces.length +
      state.clean.merges.length + (state.clean.dropEmpty ? 1 : 0);
    var chip = function (t) { return '<span class="vscr-chip">' + t + "</span>"; };
    var stats = $("vscrViewStats");
    if (stats) {
      stats.innerHTML = chip("数据 " + rows.length + " 行") + chip(cols.length + " 列") +
        chip("原始 " + raw.length + " 行") + chip("已采 " + (state.lastPages || (raw.length ? 1 : 0)) + " 页") +
        (nRules ? chip("清洗 " + nRules + " 条规则") : "");
    }
    var colsBox = $("vscrViewCols");
    if (colsBox) {
      colsBox.innerHTML = cols.length ? cols.map(function (c) {
        var ne = 0;
        rows.forEach(function (r) { if (String(r[c] == null ? "" : r[c]).trim()) ne++; });
        var pct = rows.length ? Math.round(ne * 100 / rows.length) : 0;
        return '<div class="vscr-fill"><span class="n" title="' + esc(c) + '">' + esc(c) + "</span>" +
          '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
          '<span class="p">' + ne + "/" + rows.length + " · " + pct + "%</span></div>";
      }).join("") : '<div class="vscr-vsec">还没有数据：先「提取本页」或「跨页」</div>';
    }
    // 数据表格：完整展示所有行（单元格悬停看全文）
    var rowsN = $("vscrViewRows");
    if (rowsN) rowsN.textContent = rows.length;
    var tbl = $("vscrViewTable");
    if (tbl) {
      if (!rows.length) {
        tbl.innerHTML = '<div class="vscr-empty">还没有数据</div>';
      } else {
        var head = "<tr><th>#</th>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
        var body = rows.map(function (r, i) {
          return "<tr><td>" + (i + 1) + "</td>" + cols.map(function (c) {
            var v = String(r[c] == null ? "" : r[c]);
            return '<td title="' + esc(v) + '">' + esc(v) + "</td>";
          }).join("") + "</tr>";
        }).join("");
        tbl.innerHTML = '<table class="vscr-tbl"><thead>' + head + "</thead><tbody>" + body + "</tbody></table>";
      }
    }
  }
  function openView() {
    $("vscrView").style.display = "flex";
    applyTheme();
    renderView();
  }

  /* ---------------- 导出 ---------------- */
  function download(content, mime, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }
  function csvOf(rows) {
    if (!rows.length) return "";
    var cols = Object.keys(rows[0]);
    var q = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
    return "\ufeff" + cols.map(q).join(",") + "\n" +
      rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(","); }).join("\n");
  }
  function stamp() {
    var d = new Date();
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
  }

  /* ---------------- 自动化多页采集 ----------------
   原理：提取当前页 → 找到下一页按钮（手选 / 留空自动识别）→ 点它 →
   等新内容渲染 → 再提取 → 循环。自动去重（同一行不重复收）、
   连续 2 页没有新数据自动停、跨页按钮实时显示进度。 */
  function findNextAuto() {
    // 没手选下一页时，按常见模式自动找
    var sels = ["a[rel='next']", "a.next", ".next", "li.pagination-next > a",
      "button.next", ".pagination .next", ".page-next"];
    for (var i = 0; i < sels.length; i++) {
      try {
        var el = document.querySelector(sels[i]);
        if (el && el.offsetParent !== null) return el;
      } catch (e) { }
    }
    // 文本兜底：找可见的「下一页 / Next」按钮
    var cands = document.querySelectorAll("a, button");
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j];
      if (c.offsetParent === null) continue;
      if (/下一页|下一頁|next\s*»|»\s*next/i.test(c.textContent || "")) return c;
    }
    return null;
  }
  function rowKey(r) { return JSON.stringify(r); }
  /* 等页面图片加载完（懒加载站点直接提取会拿到空字段），最多等 timeout 毫秒 */
  function waitForImgs(timeout, cb) {
    var t0 = Date.now();
    var poll = function () {
      var bad = 0;
      try {
        if (document.images) {
          Array.prototype.forEach.call(document.images, function (im) {
            if (im.src && !im.complete) bad++;
          });
        }
      } catch (e) { }
      if (bad === 0 || Date.now() - t0 > timeout) { cb(); return; }
      setTimeout(poll, 300);
    };
    poll();
  }
  /* 检测「某列在别的行有值、这几行却是空」——多半是没等加载完就提取了 */
  function pageHasEmptyCells(rows) {
    var filled = {};
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) {
        if (String(r[k] == null ? "" : r[k]).trim()) filled[k] = 1;
      });
    });
    return rows.some(function (r) {
      return Object.keys(filled).some(function (k) {
        return !String(r[k] == null ? "" : r[k]).trim();
      });
    });
  }
  function crawlStat(text) {
    var el = $("vscrCrawlStat");
    if (el) { el.textContent = text; el.style.display = text ? "block" : "none"; }
  }
  function crawlStart() {
    if (state.crawl) return;
    var nextSel = ($("vscrNext").value || "").trim();
    var max = Math.max(1, Math.min(50, Number($("vscrMax").value) || 1));
    if (!state.itemSel) { toast("先选列表项", false); return; }
    if (!state.fields.length) { toast("先添加至少一个字段", false); return; }
    state.crawl = {
      rows: [], seen: {}, page: 0, max: max, nextSel: nextSel, idle: 0,
      // 等新内容的判据基线：列表项数量 / 页面高度 / 地址，任一变化即认为换页成功
      lastCount: itemNodes(state.itemSel).length,
      lastHeight: document.body.scrollHeight,
      lastUrl: location.href,
    };
    $("vscrStop").style.display = "";
    $("vscrRun").disabled = true;
    toast("开始自动多页采集（最多 " + max + " 页" +
      (nextSel ? "" : "，下一页按钮未设置：将自动识别") + "）", true);
    crawlStep();
  }
  function crawlStep() {
    var c = state.crawl;
    if (!c) return;
    c.page++;
    crawlStat("第 " + c.page + "/" + c.max + " 页 · 提取数据中…");
    var rows = extractRows(5000);
    // 先等图片加载完再定稿；发现「有列空着但别的行有值」就再补采一次填空
    crawlStat("第 " + c.page + "/" + c.max + " 页 · 等待图片与内容加载…");
    waitForImgs(4000, function () {
      if (!state.crawl) return;
      var finishExtract = function () {
        if (!state.crawl) return;
        // 自动去重：换页后内容没变化的行不重复收（也是「没有新数据」的判据）
        var fresh = 0;
        rows.forEach(function (r) {
          var k = rowKey(r);
          if (!c.seen[k]) { c.seen[k] = 1; c.rows.push(r); fresh++; }
        });
        state.rawRows = c.rows;
        applyClean();
        crawlStat("第 " + c.page + "/" + c.max + " 页 · 提取 " + rows.length + " 行（新 " +
          fresh + "）· 累计 " + c.rows.length + " 行");
        var crawlBtn = $("vscrCrawl");
        if (crawlBtn) crawlBtn.textContent = "跨页 " + c.page + "/" + c.max;
        // 连续 2 页没有新数据 → 内容到底了，自动结束
        if (fresh === 0) {
          c.idle++;
          if (c.idle >= 2) { toast("连续 2 页没有新数据，自动结束", "warn"); crawlStop(); return; }
        } else c.idle = 0;
        if (c.page >= c.max) { crawlStop(); return; }
        // 找下一页：手选的选择器优先，留空则自动识别
        var btn = null;
        if (c.nextSel) {
          if (isXPath(c.nextSel)) {
            var res = evalXPath(c.nextSel, document);
            btn = Array.isArray(res) ? res[0] : res;
          } else {
            try { btn = document.querySelector(c.nextSel); } catch (e) { }
          }
        } else btn = findNextAuto();
        if (!btn) {
          crawlStat("第 " + c.page + "/" + c.max + " 页 · 找不到下一页按钮，已结束");
          toast("找不到下一页按钮，采集结束", "warn");
          crawlStop();
          return;
        }
        // 阶段 ①：先滚到页面最底部，触发懒加载（给站点 0.8 秒反应）
        crawlStat("第 " + c.page + "/" + c.max + " 页 · 滚动到底触发懒加载…");
        try { window.scrollTo(0, document.body.scrollHeight); } catch (e) { }
        c.timer = setTimeout(function () { crawlClick(c, btn); }, 800);
      };
      if (pageHasEmptyCells(rows)) {
        crawlStat("第 " + c.page + "/" + c.max + " 页 · 检测到空字段，稍后补采一次…");
        c.timer = setTimeout(function () {
          if (!state.crawl) return;
          var rows2 = extractRows(5000);
          // 只补空格子，已有值不覆盖
          for (var i = 0; i < rows.length && i < rows2.length; i++) {
            Object.keys(rows[i]).forEach(function (k) {
              if (!String(rows[i][k] == null ? "" : rows[i][k]).trim() &&
                  String(rows2[i][k] == null ? "" : rows2[i][k]).trim()) rows[i][k] = rows2[i][k];
            });
          }
          finishExtract();
        }, 1200);
      } else finishExtract();
    });
  }
  function crawlClick(c, btn) {
    if (!state.crawl) return;
    // 阶段 ②：点击下一页（点击前记下判据基线，用于判断是否真的换了内容）
    crawlStat("第 " + c.page + "/" + c.max + " 页 · 点击下一页…");
    c.lastCount = itemNodes(state.itemSel).length;
    c.lastHeight = document.body.scrollHeight;
    c.lastUrl = location.href;
    try {
      btn.scrollIntoView({ block: "center" });
      btn.click();
    } catch (e) {
      toast("点下一页失败：" + e.message, false);
      crawlStop();
      return;
    }
    // 阶段 ③：轮询等新内容（每 0.3 秒查一次，最长 8 秒；列表项数量 /
    // 页面高度 / 地址任一变化即认为换页成功，提前进入下一轮提取）
    crawlStat("第 " + c.page + "/" + c.max + " 页 · 等待新内容加载…");
    var tries = 0;
    var wait = function () {
      if (!state.crawl) return;
      tries++;
      var changed = itemNodes(state.itemSel).length !== c.lastCount ||
        document.body.scrollHeight !== c.lastHeight ||
        location.href !== c.lastUrl;
      if (changed || tries > 26) {
        crawlStep();
      } else {
        c.timer = setTimeout(wait, 300);
      }
    };
    c.timer = setTimeout(wait, 400);
  }
  function crawlStop() {
    var c = state.crawl;
    if (c && c.timer) clearTimeout(c.timer);
    state.crawl = null;
    var stop = $("vscrStop");
    if (stop) stop.style.display = "none";
    var run = $("vscrRun");
    if (run) run.disabled = false;
    var crawlBtn = $("vscrCrawl");
    if (crawlBtn) crawlBtn.textContent = "跨页";
    if (c) {
      state.lastPages = c.page;
      crawlStat("采集结束 · 共 " + c.page + " 页 " + c.rows.length + " 行");
      toast("多页采集完成：共 " + c.page + " 页 " + (state.rows || []).length + " 行", true);
    }
  }

  /* ---------------- 取值规则悬浮框 ----------------
   点字段行的「规则」按钮弹出：替换规则（可叠多条）+ 前后缀拼接 + 多值，
   上面实时显示前 3 条数据的 原始值 → 处理结果。 */
  function openRulesPop(f, anchor) {
    if (!f) return;
    state.popField = f;
    $("vscrPopName").textContent = f.name || "";
    $("vscrPopMulti").checked = !!f.multi;
    $("vscrPopPre").value = f.prefix || "";
    $("vscrPopSuf").value = f.suffix || "";
    $("vscrPopFind").value = ""; $("vscrPopTo").value = ""; $("vscrPopRe").checked = false;
    var pop = $("vscrPop");
    pop.style.display = "flex";
    applyTheme();
    renderPopChips();
    renderPopPrev();
    // 定位：贴着按钮下方弹出，右侧不出屏、底部不够就往上
    var r = anchor.getBoundingClientRect();
    var top = r.bottom + 6, left = r.right - pop.offsetWidth;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 6);
    pop.style.top = Math.max(8, Math.min(top, window.innerHeight - pop.offsetHeight - 8)) + "px";
    pop.style.left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  }
  function renderPopChips() {
    var f = state.popField;
    var box = $("vscrPopChips");
    if (!f || !box) return;
    box.innerHTML = (f.rules || []).map(function (r, i) {
      return '<span class="vscr-chip">' + (r.regex ? "正则 " : "") + "「" + esc(r.find) + "」→「" +
        esc(r.to) + "」" + '<i data-pi="' + i + '" title="删除这条规则">✕</i></span>';
    }).join("");
  }
  function renderPopPrev() {
    var f = state.popField;
    var box = $("vscrPopPrev");
    if (!f || !box) return;
    var roots = itemNodes(state.itemSel).slice(0, 3);
    if (!roots.length) {
      box.innerHTML = '<div style="color:var(--dim)">先选列表项（或点「提取本页」），这里显示 原始值 → 处理结果 预览</div>';
      return;
    }
    box.innerHTML = roots.map(function (r0) {
      var raw = localValue(r0, f);
      var out = fieldValue(raw, f);
      return '<div class="r"><span class="a" title="' + esc(raw) + '">' + esc(raw || "(空)") + "</span>" +
        '<span style="color:var(--dim);flex:none">→</span>' +
        '<span class="b" title="' + esc(out) + '">' + esc(out || "(空)") + "</span></div>";
    }).join("");
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindUi() {
    var fab = $("vscrFab"), panel = $("vscrPanel");

    fab.addEventListener("click", function () {
      state.open = !state.open;
      panel.style.display = state.open ? "flex" : "none";
      if (state.open) renderPanel();
    });
    $("vscrMin").addEventListener("click", function () {
      state.open = false;
      panel.style.display = "none";
    });
    $("vscrTheme").addEventListener("click", function () {
      setTheme(getTheme() === "dark" ? "light" : "dark");
    });

    // 面板拖动（按住标题栏）
    (function () {
      var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      var head = $("vscrHead");
      head.addEventListener("mousedown", function (e) {
        if (e.target.closest("button")) return;   // 点按钮不进入拖动
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        var r = panel.getBoundingClientRect();
        ox = r.left; oy = r.top;
        e.preventDefault();
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        panel.style.left = (ox + e.clientX - sx) + "px";
        panel.style.top = (oy + e.clientY - sy) + "px";
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      });
      document.addEventListener("mouseup", function () { dragging = false; });
    })();

    // 模式按钮
    panel.querySelectorAll("[data-mode]").forEach(function (b) {
      b.addEventListener("click", function () { setMode(b.dataset.mode); });
    });
    $("vscrGuess").addEventListener("click", function () {
      var best = guessList();
      if (!best) { toast("没识别出明显的列表，直接点页面上的一条数据试试", "warn"); return; }
      state.itemSel = best.key;
      syncItem();
      saveRule();
      toast("识别到 " + best.n + " 条：" + best.key, true);
    });
    $("vscrClear").addEventListener("click", function () {
      clearMatches();
      setHl(null);
      document.querySelectorAll(".vscr-picked").forEach(function (n) { n.classList.remove("vscr-picked"); });
    });
    $("vscrTreeBtn").addEventListener("click", function () { openTree(null); });
    $("vscrCodeBtn").addEventListener("click", function () {
      var m = $("vscrCode");
      m.style.display = "flex";
      applyTheme();
      $("vscrCodeNext").checked = !!state.nextSel;
      $("vscrCodeOut").textContent = genCode();
    });
    $("vscrCodeLang").addEventListener("change", function () {
      $("vscrCodeOut").textContent = genCode();
    });
    $("vscrCodeNext").addEventListener("change", function () {
      $("vscrCodeOut").textContent = genCode();
    });
    $("vscrCodeClose").addEventListener("click", function () { $("vscrCode").style.display = "none"; });
    $("vscrCodeCopy").addEventListener("click", function () {
      navigator.clipboard.writeText($("vscrCodeOut").textContent).then(
        function () { toast("代码已复制到剪贴板", true); },
        function () { toast("复制失败：浏览器拒绝了剪贴板权限", false); });
    });
    $("vscrCodeDl").addEventListener("click", function () {
      download($("vscrCodeOut").textContent, "text/plain", codeFileName());
    });
    $("vscrCode").addEventListener("click", function (e) {
      if (e.target === this) this.style.display = "none";
    });

    // 列表项调整条
    $("vscrAdjUp").addEventListener("click", adjExpand);
    $("vscrAdjDown").addEventListener("click", adjShrink);
    $("vscrAdjOk").addEventListener("click", adjConfirm);
    $("vscrAdjNo").addEventListener("click", adjCancel);

    // 列表项输入
    $("vscrItem").addEventListener("input", function () {
      state.itemSel = this.value.trim();
      renderPanel();
      saveRule();
    });
    // 下一页按钮选择器（手填也记进规则）
    $("vscrNext").addEventListener("input", function () {
      state.nextSel = this.value.trim();
      saveRule();
    });

    // 字段列表（委托：输入 / 删除 / 查看元素）
    $("vscrFields").addEventListener("input", function (e) {
      var box = e.target.closest("[data-fi]");
      if (!box) return;
      var f = state.fields[Number(box.dataset.fi)];
      if (!f) return;
      if (e.target.classList.contains("vscr-name")) f.name = e.target.value;
      else if (e.target.classList.contains("vscr-type")) {
        f.type = e.target.value;
        if (f.type === "attr" && !f.attr) f.attr = "href";
        renderPanel();
      } else if (e.target.classList.contains("vscr-attr")) f.attr = e.target.value.trim();
      else if (e.target.classList.contains("vscr-multi")) f.multi = !!e.target.checked;
      else if (e.target.classList.contains("vscr-mono")) f.selector = e.target.value.trim();
      saveRule();
    });
    $("vscrFields").addEventListener("click", function (e) {
      var view = e.target.closest("[data-view]");
      if (view) { openTree(state.fields[Number(view.dataset.view)]); return; }
      var rbtn = e.target.closest("[data-rules]");
      if (rbtn) { openRulesPop(state.fields[Number(rbtn.dataset.rules)], rbtn); return; }
      var del = e.target.closest("[data-del]");
      if (!del) return;
      state.fields.splice(Number(del.dataset.del), 1);
      renderPanel();
      saveRule();
    });
    $("vscrAdd").addEventListener("click", function () {
      state.fields.push({ name: "字段" + (state.fields.length + 1), selector: "", type: "text", attr: "", multi: false, abs: false });
      renderPanel();
      saveRule();
    });

    // 提取 / 跨页
    $("vscrRun").addEventListener("click", function () {
      if (!state.itemSel) { toast("先选列表项", false); return; }
      if (!state.fields.length) { toast("先添加至少一个字段", false); return; }
      toast("提取中：等待图片加载…");
      waitForImgs(2500, function () {
        state.rawRows = extractRows(5000);
        state.lastPages = 1;
        applyClean();
        toast("提取完成：" + state.rows.length + " 行", true);
      });
    });
    $("vscrCrawl").addEventListener("click", crawlStart);
    $("vscrStop").addEventListener("click", crawlStop);

    // 清洗 / 筛选
    $("vscrCleanBtn").addEventListener("click", function () {
      state.cleanOpen = !state.cleanOpen;
      $("vscrClean").style.display = state.cleanOpen ? "block" : "none";
      this.classList.toggle("on", state.cleanOpen);
      if (state.cleanOpen) refreshCleanCols();
    });
    $("vscrFAdd").addEventListener("click", function () {
      var col = $("vscrFCol").value || "*", op = $("vscrFOp").value, val = ($("vscrFVal").value || "").trim();
      if (op !== "empty" && op !== "not_empty" && !val) { toast("先填关键字（选「为空 / 不为空」可留空）", "warn"); return; }
      state.clean.filters.push({ col: col, op: op, value: val });
      $("vscrFVal").value = "";
      saveRule();
      applyClean();
    });
    $("vscrFVal").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("vscrFAdd").click(); }
    });
    $("vscrFAnd").addEventListener("click", function () {
      state.clean.filterAnd = true;
      this.classList.add("on"); $("vscrFOr").classList.remove("on");
      saveRule(); applyClean();
    });
    $("vscrFOr").addEventListener("click", function () {
      state.clean.filterAnd = false;
      this.classList.add("on"); $("vscrFAnd").classList.remove("on");
      saveRule(); applyClean();
    });
    $("vscrFDrop").addEventListener("click", function () {
      state.clean.dropEmpty = !state.clean.dropEmpty;
      this.classList.toggle("on", state.clean.dropEmpty);
      saveRule(); applyClean();
    });
    $("vscrFClear").addEventListener("click", function () {
      state.clean.filters = []; state.clean.replaces = []; state.clean.merges = [];
      state.clean.dropEmpty = false;
      $("vscrFDrop").classList.remove("on");
      saveRule(); applyClean();
      toast("已清除全部清洗规则，回到全量数据", "warn");
    });
    $("vscrFChips").addEventListener("click", function (e) {
      var i = e.target.closest("i");
      if (!i) return;
      if (i.dataset.ci != null) state.clean.filters.splice(Number(i.dataset.ci), 1);
      else if (i.dataset.ri != null) state.clean.replaces.splice(Number(i.dataset.ri), 1);
      else if (i.dataset.mi != null) state.clean.merges.splice(Number(i.dataset.mi), 1);
      saveRule(); applyClean();
    });
    (function initCleanMode() {
      if (state.clean.filterAnd) $("vscrFAnd").classList.add("on");
      else $("vscrFOr").classList.add("on");
      $("vscrFDrop").classList.toggle("on", !!state.clean.dropEmpty);
    })();

    // 取值规则悬浮框
    $("vscrPopClose").addEventListener("click", function () { $("vscrPop").style.display = "none"; });
    $("vscrPopMulti").addEventListener("change", function () {
      var f = state.popField;
      if (!f) return;
      f.multi = !!this.checked;
      saveRule(); renderPanel(); renderPopPrev();
    });
    $("vscrPopPre").addEventListener("input", function () {
      var f = state.popField;
      if (!f) return;
      f.prefix = this.value;
      saveRule(); renderPopPrev(); renderPanel();
    });
    $("vscrPopSuf").addEventListener("input", function () {
      var f = state.popField;
      if (!f) return;
      f.suffix = this.value;
      saveRule(); renderPopPrev(); renderPanel();
    });
    $("vscrPopRAdd").addEventListener("click", function () {
      var f = state.popField;
      if (!f) return;
      var find = $("vscrPopFind").value;
      if (!find) { toast("先填要查找的内容", "warn"); return; }
      if (!f.rules) f.rules = [];
      f.rules.push({ type: "replace", find: find, to: $("vscrPopTo").value, regex: !!$("vscrPopRe").checked });
      $("vscrPopFind").value = ""; $("vscrPopTo").value = ""; $("vscrPopRe").checked = false;
      saveRule(); renderPopChips(); renderPopPrev(); renderPanel();
    });
    $("vscrPopFind").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("vscrPopRAdd").click(); }
    });
    $("vscrPopChips").addEventListener("click", function (e) {
      var i = e.target.closest("i");
      if (!i || i.dataset.pi == null) return;
      var f = state.popField;
      if (!f || !f.rules) return;
      f.rules.splice(Number(i.dataset.pi), 1);
      saveRule(); renderPopChips(); renderPopPrev(); renderPanel();
    });
    // 点悬浮框外面自动收起
    document.addEventListener("mousedown", function (e) {
      var pop = $("vscrPop");
      if (!pop || pop.style.display === "none") return;
      if (e.target.closest && (e.target.closest("#vscrPop") || e.target.closest("[data-rules]"))) return;
      pop.style.display = "none";
    });

    // 导出
    $("vscrViewBtn").addEventListener("click", openView);
    $("vscrViewClose").addEventListener("click", function () { $("vscrView").style.display = "none"; });
    $("vscrView").addEventListener("click", function (e) {
      if (e.target === this) this.style.display = "none";
    });
    $("vscrViewDedup").addEventListener("click", function () {
      var before = state.rawRows.length;
      var seen = {};
      state.rawRows = state.rawRows.filter(function (r) {
        var k = rowKey(r);
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
      applyClean();
      toast("已去重：移除 " + (before - state.rawRows.length) + " 行重复数据", true);
      renderView();
    });
    $("vscrViewRev").addEventListener("click", function () {
      state.rawRows.reverse();
      applyClean();
      renderView();
    });
    $("vscrViewRe").addEventListener("click", function () {
      $("vscrView").style.display = "none";
      $("vscrRun").click();
    });
    $("vscrViewClear").addEventListener("click", function () {
      state.rawRows = [];
      applyClean();
      state.lastPages = 0;
      toast("已清空全部采集数据", "warn");
      renderView();
    });
    $("vscrCsv").addEventListener("click", function () {
      if (!state.rows.length) { toast("还没有数据可导出", "warn"); return; }
      download(csvOf(state.rows), "text/csv", "scrape_" + stamp() + ".csv");
    });
    $("vscrJson").addEventListener("click", function () {
      if (!state.rows.length) { toast("还没有数据可导出", "warn"); return; }
      download(JSON.stringify(state.rows, null, 2), "application/json", "scrape_" + stamp() + ".json");
    });
    $("vscrCopy").addEventListener("click", function () {
      if (!state.rows.length) { toast("还没有数据可复制", "warn"); return; }
      var cols = Object.keys(state.rows[0]);
      var tsv = [cols.join("\t")].concat(state.rows.map(function (r) {
        return cols.map(function (c) { return String(r[c] == null ? "" : r[c]).replace(/\t|\n/g, " "); }).join("\t");
      })).join("\n");
      navigator.clipboard.writeText(tsv).then(
        function () { toast("已复制 " + state.rows.length + " 行（可直接粘贴进 Excel）", true); },
        function () { toast("复制失败：浏览器拒绝了剪贴板权限", false); });
    });

    // 元素树弹层（委托）
    var modal = $("vscrModal");
    modal.addEventListener("click", function (e) {
      var use = e.target.closest("[data-attr]");
      if (use) { viewerUseAttr(use.dataset.attr); return; }
      var apply = e.target.closest("[data-use]");
      if (apply) { viewerApply(apply.dataset.use); return; }
      var cp = e.target.closest("[data-copy]");
      if (cp) {
        var el = viewer.nodes[viewer.idx];
        var root = viewer.root;
        var v = "";
        if (el) {
          v = cp.dataset.copy === "xp"
            ? (el === root ? "." : xpathOf(el, root))
            : (el === root ? "." : relSel(el, root));
        }
        if (!v) { toast("先在左边树里选一个节点", "warn"); return; }
        navigator.clipboard.writeText(v).then(
          function () { toast("已复制", true); },
          function () { toast("复制失败", false); });
        return;
      }
      if (e.target === modal || e.target.closest("#vscrTreeClose")) closeTree();
    });
    var tree = $("vscrTree");
    tree.addEventListener("click", function (e) {
      var row = e.target.closest(".vscr-tnode");
      if (!row) return;
      setHl(null);
      selectNode(Number(row.dataset.i));
    });
    tree.addEventListener("mouseover", function (e) {
      var row = e.target.closest(".vscr-tnode");
      if (!row) return;
      setHl(viewer.nodes[Number(row.dataset.i)] || null);   // 页面上直接高亮
    });
    tree.addEventListener("mouseleave", function () { setHl(null); });

    // 点选引擎：挂在 window 捕获阶段 —— 事件传播的第一站，
    // 比站点注册在 document 上的捕获监听更早跑，防止被 stopImmediatePropagation 拦掉
    window.addEventListener("mouseover", pickOnMove, true);
    window.addEventListener("click", pickOnClick, true);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (state.adjust) { adjCancel(); return; }
        if ($("vscrPop").style.display !== "none") { $("vscrPop").style.display = "none"; return; }
        if ($("vscrCode").style.display !== "none") { $("vscrCode").style.display = "none"; return; }
        if ($("vscrModal").style.display !== "none") { closeTree(); return; }
        if (state.mode) { setMode(""); toast("已退出点选", "warn"); }
      }
    });

    // 上次的规则自动载入
    if (loadRule()) {
      syncItem();
      if (state.nextSel) $("vscrNext").value = state.nextSel;
      toast("已载入本站点上次的采集规则（" + state.fields.length + " 个字段）", true);
    }
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    if (!document.body) { setTimeout(start, 300); return; }
    buildUi();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
