/* ==================================================================
   数据采集 · 预览页代理脚本（注入到 iframe 里）
   ------------------------------------------------------------------
   交互预览模式下，站点脚本要正常跑（轮播图、点击切换、滚动加载…），
   所以不能再剥 <script>；为了安全，iframe 用 sandbox="allow-scripts"
   （不带 allow-same-origin）→ 文档变成不透明源，站点脚本访问不到父页面，
   父页面也拿不到 contentDocument。两边只通过 postMessage 通信。

   本脚本负责：
     · 点选：hover 高亮 + 点击生成 CSS / XPath（相对列表项），回传父页面；
     · 清浮层：自动 / 手动隐藏广告、登录弹窗；
     · 元素树：把当前列表项的子树拍平回传（父页面渲染）；
     · 匹配数统计。
   静态模式下本脚本不会被注入。
   ================================================================== */
(function () {
  if (window.__scrAgent) return;
  window.__scrAgent = true;

  var MODE = "";
  var HIDE = [];
  var NODES = [];
  var TREE_ROOT = null;
  var PICK_EL = null;      // 列表项调整中：当前候选元素
  var ADJ_STACK = [];      // 扩大 / 缩小的历史栈（缩小 = 退回上一层）

  /* ==================================================================
     镜像代理：页面里所有对站点的请求都改走 /api/scraper/mirror/<token>/
     ------------------------------------------------------------------
     HTML / CSS 里的地址由服务端改写好了，但 JS 运行时拼出来的地址
     （fetch('/api/list')、xhr.open('GET', url)、img.src = '/a.png'…）
     浏览器会按当前源的根路径解析，直接打到我们服务上必然 404。
     这里在站点脚本执行前把这些入口全部劫持一遍。
     ================================================================== */
  var MIRROR = window.__SCR_MIRROR__ || "";
  var SITE = window.__SCR_SITE__ || "";

  function mm(u) {
    try {
      if (!u) return u;
      MIRROR = MIRROR || window.__SCR_MIRROR__ || "";
      SITE = SITE || window.__SCR_SITE__ || "";
      if (!MIRROR) return u;
      var s = String(u);
      if (s.indexOf(MIRROR) === 0) return s;
      if (/^(data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(s)) return s;
      // 不透明源里 location.origin === "null"，站点脚本用 location.origin + "/x"
      // 拼出来的地址是 "null/x…" —— 还原成站点根路径再走镜像
      if (/^null(:\/\/|\/)/i.test(s)) s = SITE + s.slice(4);
      var abs = "";
      if (/^https?:\/\//i.test(s)) abs = s;
      else if (s.slice(0, 2) === "//") abs = "https:" + s;
      else if (s.charAt(0) === "/") abs = (SITE || location.origin) + s;
      else return u;                  // 相对地址：<base> 已指向镜像，浏览器自己就找对了
      // 镜像路径形如 /api/scraper/mirror/<token>/<scheme>/<host>/<path>，
      // 协议段不能丢，否则后端还原不出真实地址
      var m = abs.match(/^(https?):\/\/(.+)$/i);
      if (!m) return u;
      return MIRROR + m[1].toLowerCase() + "/" + m[2];
    } catch (e) { return u; }
  }
  window.__scrMirror = mm;

  try {
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") input = mm(input);
          else if (window.URL && input instanceof URL) input = mm(input.href);
          else if (input && input.url) {
            var nu = mm(input.url);
            if (nu !== input.url) input = new Request(nu, input);
          }
        } catch (e) { }
        return _fetch.call(this, input, init);
      };
    }
  } catch (e) { }

  try {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 1) args[1] = mm(u);
      return _open.apply(this, args);
    };
  } catch (e) { }

  try {
    var _beacon = navigator.sendBeacon;
    if (_beacon) {
      navigator.sendBeacon = function (u, d) { return _beacon.call(navigator, mm(u), d); };
    }
  } catch (e) { }

  try {
    var _ES = window.EventSource;
    if (_ES) {
      var ES2 = function (u, o) { return new _ES(mm(u), o); };
      ES2.prototype = _ES.prototype;
      window.EventSource = ES2;
    }
  } catch (e) { }

  // 属性赋值（框架最常用的写法）与 setAttribute 两条路都要管
  function patchProp(ctor, prop) {
    try {
      if (!ctor || !ctor.prototype) return;
      var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
      if (!d || !d.set) return;
      Object.defineProperty(ctor.prototype, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) { d.set.call(this, mm(v)); }
      });
    } catch (e) { }
  }
  patchProp(window.HTMLImageElement, "src");
  patchProp(window.HTMLImageElement, "srcset");
  patchProp(window.HTMLScriptElement, "src");
  patchProp(window.HTMLLinkElement, "href");
  patchProp(window.HTMLSourceElement, "src");
  patchProp(window.HTMLMediaElement, "src");
  patchProp(window.HTMLVideoElement, "poster");
  patchProp(window.HTMLIFrameElement, "src");

  try {
    var _setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      var low = String(n || "").toLowerCase();
      if (low === "src" || low === "href" || low === "poster" || low === "data") v = mm(v);
      return _setAttr.call(this, n, v);
    };
  } catch (e) { }

  // sandbox 不带 allow-same-origin → 文档是不透明源，localStorage 一访问就抛
  // SecurityError，很多 SPA 会直接白屏。这里换成内存实现，脚本照跑。
  try {
    window.localStorage.getItem("__scr_probe__");
  } catch (e0) {
    var mkStore = function () {
      var data = {};
      var api = {
        getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
        setItem: function (k, v) { data[String(k)] = String(v); },
        removeItem: function (k) { delete data[String(k)]; },
        clear: function () { data = {}; },
        key: function (i) { return Object.keys(data)[i] || null; }
      };
      Object.defineProperty(api, "length", { get: function () { return Object.keys(data).length; } });
      return api;
    };
    ["localStorage", "sessionStorage"].forEach(function (name) {
      try { Object.defineProperty(window, name, { value: mkStore(), configurable: true }); } catch (e) { }
    });
  }

  // 同理：不透明源下 document.cookie 读取直接抛 SecurityError，很多站点脚本
  // （登录态判断、埋点、A/B 分流）没写 try/catch，一抛整页就停在那。
  // 换成内存 cookie，站点逻辑照常跑，只是读不到真实 Cookie。
  try {
    void document.cookie;
  } catch (e0) {
    var jar = [];
    try {
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: function () { return jar.join("; "); },
        set: function (v) {
          var s = String(v == null ? "" : v);
          var k = s.split("=")[0].replace(/^\s+|\s+$/g, "");
          jar = jar.filter(function (x) { return x.split("=")[0].replace(/^\s+|\s+$/g, "") !== k; });
          jar.push(s);
        }
      });
    } catch (e1) { }
  }

  // document.referrer 是我们工作台的地址（父页面 URL），站点统计脚本拿它拼请求
  // 必然打到我们服务上被 CORS 拦掉（控制台里的 /ide?rid=… XHR 报错就是这么来的）。
  // 改成原站点页面地址，站点脚本看起来就像正常打开了这个页面。
  try {
    Object.defineProperty(document, "referrer", {
      configurable: true,
      get: function () { return window.__SCR_PAGE__ || ""; }
    });
  } catch (e) { }

  // SPA 基本都会调 history.pushState：不透明源下会被拒绝并抛异常，包一层别让它冒出去
  try {
    ["pushState", "replaceState"].forEach(function (name) {
      var orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function () {
        try { return orig.apply(history, arguments); } catch (e) { }
      };
    });
  } catch (e) { }

  // http（非 localhost）不是安全上下文，crypto.randomUUID 不存在，
  // 站点用它生成 id 时会直接抛错，补一个等价实现
  try {
    if (window.crypto && !window.crypto.randomUUID) {
      window.crypto.randomUUID = function () {
        var b = new Uint8Array(16);
        try { window.crypto.getRandomValues(b); } catch (e) {
          for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
        }
        b[6] = (b[6] & 15) | 64;
        b[8] = (b[8] & 63) | 128;
        var h = Array.prototype.map.call(b, function (x) {
          return ("0" + x.toString(16)).slice(-2);
        }).join("");
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" +
          h.slice(16, 20) + "-" + h.slice(20);
      };
    }
  } catch (e) { }

  function post(type, data) {
    try {
      var msg = { __scr: 1, type: type };
      if (data) for (var k in data) msg[k] = data[k];
      parent.postMessage(msg, "*");
    } catch (e) { }
  }

  /* ---------------- 选择器算法（与父页面保持一致） ---------------- */
  function clsOk(c) {
    return /^[A-Za-z_][\w-]*$/.test(c) && !/^scr-/.test(c);
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
    var p = el.parentElement;
    var idx = 1;
    if (p) {
      var sibs = Array.prototype.filter.call(p.children, function (x) { return x.tagName === el.tagName; });
      idx = Math.max(1, sibs.indexOf(el) + 1);
    }
    return tag + ":nth-of-type(" + idx + ")";
  }

  function absPath(el) {
    var parts = [];
    var cur = el;
    var guard = 0;
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
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur !== root && cur.nodeType === 1 && guard++ < 12) {
      parts.unshift(seg(cur));
      cur = cur.parentElement;
    }
    if (cur !== root) return absPath(el);
    return parts.length ? parts.join(" > ") : ".";
  }

  function xpathOf(el, root) {
    var segs = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && cur !== root && guard++ < 30) {
      var tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      var p = cur.parentElement;
      var idx = 1;
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

  function isXPath(sel) {
    var s = String(sel || "").trim();
    return s.indexOf("/") === 0 || s.indexOf(".//") === 0 ||
      s.indexOf("(//") === 0 || s.indexOf("(.//") === 0;
  }

  /* ---------------- 提取支持 ---------------- */
  /* 镜像地址还原成原站点地址（预览 DOM 里的 src / href 已被服务端改写成镜像地址，
     提取出来的数据必须是原图地址，不能把镜像地址当数据） */
  function unmm(u) {
    try {
      var s = String(u == null ? "" : u);
      if (!MIRROR || s.indexOf(MIRROR) < 0) return s;
      var rest = s.slice(s.indexOf(MIRROR) + MIRROR.length);
      var m = rest.match(/^(https?)\/(?!\/)(.+)$/i);   // https/v.qq.com/x → https://v.qq.com/x
      return m ? m[1] + "://" + m[2] : s;
    } catch (e) { return String(u == null ? "" : u); }
  }

  function valueFrom(el, f) {
    if (!el) return "";
    if (f.type === "html") return unmm(el.innerHTML || "");
    if (f.type === "attr") {
      var v = el.getAttribute(f.attr || "href") || "";
      if (v && (f.attr === "href" || f.attr === "src")) {
        try { v = new URL(v, window.__SCR_PAGE__ || document.baseURI).href; } catch (e) { }
      }
      return unmm(v);
    }
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function localValue(root, f) {
    var sel = String(f.selector || "").trim();
    if (isXPath(sel)) {
      var res = evalXPath(sel, root);
      if (typeof res === "string") return res;
      var el = Array.isArray(res) ? res[0] : res;
      return valueFrom(el, f);
    }
    var hit = null;
    if (!sel || sel === ".") hit = root;
    else {
      try { hit = root.querySelector(sel); } catch (e) { hit = null; }
      // 文档级选择器（点选时选到了列表项外面）：整页兜底找一次
      if (!hit && f.abs) { try { hit = document.querySelector(sel); } catch (e) { } }
    }
    return valueFrom(hit, f);
  }

  /* 取值规则：字符串替换（普通 / 正则）→ 前后缀拼接（值非空才拼） */
  function applyRules(v, f) {
    var s = v == null ? "" : String(v);
    (f.replaces || []).forEach(function (r) {
      var find = String(r.find || "");
      if (!find) return;
      if (r.regex) { try { s = s.replace(new RegExp(find, "g"), r.to || ""); } catch (e) { } }
      else s = s.split(find).join(r.to || "");
    });
    var pre = f.prefix || "", suf = f.suffix || "";
    if (s && (pre || suf)) s = pre + s + suf;
    return s;
  }

  function extractRows(itemSel, fields) {
    var roots = itemNodes(itemSel).slice(0, 2000);   // 全量提取（分页展示），导出不受影响
    return roots.map(function (r) {
      var row = {};
      (fields || []).forEach(function (f) {
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
          row[f.name] = applyRules(vals.filter(Boolean).join(" | "), f);
        } else {
          row[f.name] = applyRules(localValue(r, f), f);
        }
      });
      return row;
    });
  }

  /* 自动识别列表：与父页面同一套启发式（会重复出现的类名 / 标签 + 文本量） */
  function guessList() {
    var groups = {};
    var all = document.querySelectorAll("body *");
    var limit = Math.min(all.length, 2500);
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
      if (g.text / g.n < 8) return;                     // 基本没文字的多半是布局容器
      if (!best) { best = g; return; }
      if (g.n > best.n || (g.n === best.n && g.text / g.n > best.text / best.n)) best = g;
    });
    return best;
  }

  function evalXPath(sel, root) {
    var expr = String(sel || "").trim();
    if (expr.indexOf("//") === 0) expr = "." + expr;
    try {
      var r = document.evaluate(expr, root || document, null, XPathResult.ANY_TYPE, null);
      if (r.resultType === XPathResult.STRING_TYPE) return r.stringValue;
      if (r.resultType === XPathResult.NUMBER_TYPE) return String(r.numberValue);
      if (r.resultType === XPathResult.BOOLEAN_TYPE) return String(r.booleanValue);
      var out = [];
      var n = null;
      while ((n = r.iterateNext())) out.push(n);
      return out;
    } catch (e) { return null; }
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

  function itemSelOf(el) {
    var allowBare = ["li", "tr", "article", "dd", "dt", "figure", "section", "option"];
    var cur = el;
    var fallback = "";
    var guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 7) {
      var tag = cur.tagName.toLowerCase();
      if (tag === "body" || tag === "html") break;
      var cls = Array.prototype.slice.call(cur.classList || []).filter(clsOk).slice(0, 2);
      if (cls.length) {
        var cand = tag + "." + cls.join(".");
        var n = 0;
        try { n = document.querySelectorAll(cand).length; } catch (e) { n = 0; }
        if (n >= 2) return cand;
        if (n === 1 && !fallback) fallback = cand;
      } else if (allowBare.indexOf(tag) >= 0) {
        var m = 0;
        try { m = document.querySelectorAll(tag).length; } catch (e) { m = 0; }
        if (m >= 2) return tag;
      }
      cur = cur.parentElement;
    }
    return fallback || absPath(el);
  }

  function itemRootOf(el, itemSel) {
    var sel = String(itemSel || "").trim();
    if (!sel) return null;
    if (isXPath(sel)) {
      var res = evalXPath(sel, document);
      var arr = Array.isArray(res) ? res : (res ? [res] : []);
      var best = null;
      arr.forEach(function (n) {
        if (!n || n.nodeType !== 1 || !n.contains(el)) return;
        if (!best || best.contains(n)) best = n;
      });
      return best;
    }
    try { return el.closest(sel); } catch (e) { return null; }
  }

  /* ---------------- 高亮样式 ---------------- */
  function ensureStyle() {
    if (document.getElementById("scrAgentStyle")) return;
    var st = document.createElement("style");
    st.id = "scrAgentStyle";
    st.textContent =
      ".scr-hover{outline:2px solid #38bdf8 !important;outline-offset:-2px;" +
      "background:rgba(56,189,248,.12) !important;}" +
      ".scr-match{outline:2px dashed rgba(56,189,248,.9) !important;outline-offset:-2px;}" +
      "body.scr-picking,body.scr-picking *{cursor:crosshair !important;}";
    (document.head || document.documentElement).appendChild(st);
  }

  var hovered = null;
  function setHover(el) {
    if (hovered === el) return;
    if (hovered) { try { hovered.classList.remove("scr-hover"); } catch (e) { } }
    hovered = el;
    if (el && el.nodeType === 1) { try { el.classList.add("scr-hover"); } catch (e) { } }
  }

  /* 把选择器命中的行框出来（只框前 200 个），返回命中数 */
  function markMatches(sel) {
    var olds = document.querySelectorAll(".scr-match");
    for (var i = 0; i < olds.length; i++) { try { olds[i].classList.remove("scr-match"); } catch (e) { } }
    var list = itemNodes(sel);
    list.slice(0, 200).forEach(function (x) { try { x.classList.add("scr-match"); } catch (e) { } });
    return list.length;
  }

  /* ---------------- 清浮层 ---------------- */
  var OVERLAY_RE = /(^|[\s_-])(ad|ads|adv|advert|advertisement|promo|popup|modal|dialog|layer|mask|overlay|login|float|floating|banner|toast|guide|qrcode|suspend|recommend|notice|tips?)([\s_-]|$)/i;

  function hideBySel(sel) {
    try {
      document.querySelectorAll(sel).forEach(function (el) {
        el.style.setProperty("display", "none", "important");
      });
    } catch (e) { }
  }

  function applyHide() {
    HIDE.forEach(hideBySel);
  }

  function hideEl(el) {
    if (!el || el === document.body || el === document.documentElement) return;
    var sel = absPath(el);
    try { el.style.setProperty("display", "none", "important"); } catch (e) { return; }
    if (sel && HIDE.indexOf(sel) < 0) HIDE.push(sel);
    post("hiddenOne", { selector: sel, total: HIDE.length });
  }

  function autoClean() {
    var vp = Math.max(1, (window.innerWidth || 1280) * (window.innerHeight || 900));
    var skip = /^(SCRIPT|STYLE|LINK|META|IMG|A|SPAN|P|LI|TD|TR|BR|VIDEO|CANVAS|SVG|PATH)$/;
    var nodes = document.body ? document.body.querySelectorAll("*") : [];
    var n = 0;
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var el = nodes[i];
      if (!el.tagName || skip.test(el.tagName)) continue;
      if (el.closest("header,nav,footer")) continue;
      var cs = null;
      try { cs = window.getComputedStyle(el); } catch (e) { continue; }
      if (!cs || (cs.position !== "fixed" && cs.position !== "sticky")) continue;
      var r = el.getBoundingClientRect();
      if (r.width * r.height < vp * 0.04) continue;
      var z = parseInt(cs.zIndex, 10) || 0;
      var cls = typeof el.className === "string" ? el.className : "";
      var sig = ((el.id || "") + " " + cls).toLowerCase();
      if (/header|navbar|topbar|toolbar|footer|search/.test(sig)) continue;
      var named = OVERLAY_RE.test(sig);
      if (cs.position === "sticky" && !named) continue;
      if (!named && z < 100) continue;
      var sel = absPath(el);
      try { el.style.setProperty("display", "none", "important"); } catch (e) { continue; }
      if (sel && HIDE.indexOf(sel) < 0) HIDE.push(sel);
      n++;
    }
    return n;
  }

  /* ---------------- 元素树 ---------------- */
  function label(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = (typeof el.className === "string" ? el.className : "")
      .trim().split(/\s+/).filter(clsOk).slice(0, 2)
      .map(function (c) { return "." + c; }).join("");
    var tx = "";
    try { tx = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28); } catch (e) { }
    return { tag: tag + id + cls, text: tx };
  }

  function attrsOf(el) {
    var out = [];
    if (!el || !el.attributes) return out;
    for (var i = 0; i < el.attributes.length && out.length < 24; i++) {
      var a = el.attributes[i];
      if (!a || !a.name) continue;
      out.push({ name: a.name, value: String(a.value == null ? "" : a.value).slice(0, 300) });
    }
    out.sort(function (a, b) {
      var da = /^data-/.test(a.name) ? 0 : 1;
      var db = /^data-/.test(b.name) ? 0 : 1;
      return da - db;
    });
    return out;
  }

  function findFieldEl(sel, items) {
    var s = String(sel || "").trim();
    if (!s) return null;
    if (isXPath(s)) {
      var res = evalXPath(s, document);
      var el = Array.isArray(res) ? res[0] : res;
      return (el && el.nodeType === 1) ? el : null;
    }
    var scopes = items.length ? items : [document];
    for (var i = 0; i < scopes.length; i++) {
      var hit = null;
      try { hit = scopes[i].querySelector(s); } catch (e) { hit = null; }
      if (hit) return hit;
    }
    try { return document.querySelector(s); } catch (e) { return null; }
  }

  function buildTree(d) {
    var items = itemNodes(d.itemSel);
    var el = findFieldEl(d.selector, items);
    TREE_ROOT = (el && itemRootOf(el, d.itemSel)) || items[0] || document.body;
    NODES = [];
    var rows = [];
    (function walk(node, depth) {
      if (!node || node.nodeType !== 1 || rows.length >= 600) return;
      var idx = NODES.length;
      NODES.push(node);
      rows.push({ i: idx, depth: depth, label: label(node) });
      if (depth >= 8) return;
      for (var i = 0; i < node.children.length; i++) walk(node.children[i], depth + 1);
    })(TREE_ROOT, 0);
    post("tree", {
      id: d.id,
      nodes: rows,
      rootLabel: items.length ? "相对列表项 " + (d.itemSel || "") : "整页（列表项未匹配）",
      found: !!el,
      selIndex: el ? NODES.indexOf(el) : -1,
    });
  }

  function nodeInfo(index) {
    var el = NODES[index];
    if (!el) return null;
    var root = TREE_ROOT;
    return {
      i: index,
      xpath: el === root ? "." : xpathOf(el, root),
      css: el === root ? "." : relSel(el, root),
      html: (el.outerHTML || "").slice(0, 4000),
      attrs: attrsOf(el),
    };
  }

  /* ---------------- 事件 ---------------- */
  function onMove(e) {
    if (!MODE) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || /^(HTML|BODY)$/.test(el.tagName)) return;
    setHover(el);
  }

  function onClick(e) {
    if (!MODE) return;
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (a) e.preventDefault();
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (MODE === "clean") { hideEl(el); return; }
    if (MODE === "item") {
      // 不直接定稿：进入调整状态，父页面的调整条上可扩大 / 缩小，确认才保存
      PICK_EL = el;
      ADJ_STACK = [el];
      var sel = itemSelOf(el);
      var n = markMatches(sel);
      post("picked", { mode: "item", pending: 1, selector: sel, count: n });
      return;
    }
    if (MODE === "field") {
      var root = itemRootOf(el, (window.__scrItemSel || ""));
      if (!root) { post("picked", { mode: "field", error: "not-in-item" }); return; }
      try { el.classList.remove("scr-hover"); } catch (e) { }   // 别把高亮类带进 HTML 快照
      post("picked", {
        mode: "field",
        css: relSel(el, root),
        xpath: xpathOf(el, root),
        html: (el.outerHTML || "").slice(0, 6000),
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)
      });
    }
  }

  function handle(d) {
    if (d.cmd === "mode") {
      MODE = d.mode || "";
      if (d.itemSel != null) window.__scrItemSel = d.itemSel;
      // 离开「点选列表项」模式时，未确认的调整作废
      if (MODE !== "item" && PICK_EL) { PICK_EL = null; ADJ_STACK = []; markMatches(""); }
      if (document.body) document.body.classList.toggle("scr-picking", !!MODE);
      setHover(null);
      return;
    }
    if (d.cmd === "adjItem") {
      if (!PICK_EL) return;
      if (d.dir === "up") {
        var p = PICK_EL.parentElement;
        if (!p || /^(HTML|BODY)$/.test(p.tagName)) return;
        ADJ_STACK.push(p); PICK_EL = p;
      } else {
        if (ADJ_STACK.length <= 1) return;
        ADJ_STACK.pop(); PICK_EL = ADJ_STACK[ADJ_STACK.length - 1];
      }
      var s = itemSelOf(PICK_EL);
      var n = markMatches(s);
      post("picked", { mode: "item", pending: 1, selector: s, count: n });
      return;
    }
    if (d.cmd === "adjConfirm") { PICK_EL = null; ADJ_STACK = []; return; }   // 保留命中高亮
    if (d.cmd === "adjClear") { PICK_EL = null; ADJ_STACK = []; markMatches(""); return; }
    if (d.cmd === "hide") { HIDE = d.selectors || []; applyHide(); post("hidden", { id: d.id }); return; }
    if (d.cmd === "count") {
      var c = markMatches(d.itemSel);
      post("count", { id: d.id, count: c });
      return;
    }
    if (d.cmd === "extract") {
      try {
        var total = itemNodes(d.itemSel).length;
        post("extracted", { id: d.id, rows: extractRows(d.itemSel, d.fields), total: total });
      } catch (err) {
        post("extracted", { id: d.id, error: String(err && err.message || err) });
      }
      return;
    }
    if (d.cmd === "guess") {
      var bg = null;
      try { bg = guessList(); } catch (err2) { }
      post("guessed", { id: d.id, selector: bg ? bg.key : "", count: bg ? bg.n : 0 });
      return;
    }
    if (d.cmd === "tree") { buildTree(d); return; }
    if (d.cmd === "hoverIndex") { setHover(NODES[d.index] || null); return; }
    if (d.cmd === "selectIndex") {
      post("node", Object.assign({ id: d.id }, nodeInfo(d.index) || { error: "no-node" }));
      return;
    }
    if (d.cmd === "clean") {
      var n = autoClean();
      post("cleaned", { id: d.id, count: n, selectors: HIDE.slice() });
      return;
    }
    if (d.cmd === "ping") { post("pong", { id: d.id }); return; }
  }

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (!d.__scr || !d.cmd) return;
    try { handle(d); } catch (err) { post("error", { id: d.id, error: String(err && err.message || err) }); }
  });

  document.addEventListener("mouseover", onMove, true);
  document.addEventListener("mouseleave", function () { setHover(null); }, true);
  document.addEventListener("click", onClick, true);

  function boot() {
    ensureStyle();
    applyHide();
    post("ready", { url: location.href });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
