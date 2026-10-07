/* API 调试（仿 Postman）：HTTP 请求客户端。入口：左侧活动栏「API 调试」图标（#actApi）。 */
(function () {
  "use strict";
  const API_VIEW_PREFIX = "\u0000http:";
  const API_STORE_KEY = "ide.http.reqs";
  const API_GROUP_KEY = "ide.http.groups";     // 分组单独存一个键：旧数据没有 gid 字段，天然落在「未分组」，无需迁移
  const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  const API_METHOD_CLS = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "delete", HEAD: "head", OPTIONS: "options" };

  let API_REQS = null;
  let API_GROUPS = null;

  function apiAttr(s) { return escAttr ? escAttr(s) : esc(String(s == null ? "" : s)); }

  function apiLoad() {
    if (API_REQS) return API_REQS;
    try { API_REQS = JSON.parse(localStorage.getItem(API_STORE_KEY) || "[]"); } catch (_) { API_REQS = []; }
    if (!Array.isArray(API_REQS)) API_REQS = [];
    return API_REQS;
  }
  function apiPersist() { try { localStorage.setItem(API_STORE_KEY, JSON.stringify(API_REQS || [])); } catch (_) {} }
  function apiList() { return apiLoad(); }
  function apiFind(id) { return apiLoad().filter(function (r) { return r.id === id; })[0] || null; }
  function apiNewId() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function apiAdd(req) { apiLoad(); API_REQS.push(req); apiPersist(); }
  function apiBlank(name, gid) {
    return { id: apiNewId(), name: name || "新建请求", method: "GET", url: "", params: [], headers: [],
      body: { mode: "none", raw: "", form: [] }, auth: { type: "none", token: "", username: "", password: "" },
      gid: gid || "" };
  }

  /* ---------------- 分组 ----------------
     请求上只记 gid，分组本身（名称 / 折叠状态）存在 API_GROUP_KEY 里 */
  function apiLoadGroups() {
    if (API_GROUPS) return API_GROUPS;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(API_GROUP_KEY) || "[]"); } catch (_) { raw = null; }
    if (!Array.isArray(raw)) raw = [];
    // 清洗脏数据：没有 id 的丢掉、缺字段的补默认值，避免渲染出 undefined
    API_GROUPS = raw.filter(function (g) { return g && typeof g.id === "string" && g.id; }).map(function (g) {
      return { id: g.id, name: String(g.name || "新建分组"), collapsed: !!g.collapsed };
    });
    return API_GROUPS;
  }
  function apiPersistGroups() { try { localStorage.setItem(API_GROUP_KEY, JSON.stringify(API_GROUPS || [])); } catch (_) {} }
  function apiGroupFind(gid) { return apiLoadGroups().filter(function (g) { return g.id === gid; })[0] || null; }
  function apiNewGroupId() { return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function apiGroupAdd(name) {
    const g = { id: apiNewGroupId(), name: String(name == null ? "" : name).trim() || "新建分组", collapsed: false };
    apiLoadGroups().push(g); apiPersistGroups(); return g;
  }
  function apiGroupRemove(gid) {
    API_GROUPS = apiLoadGroups().filter(function (g) { return g.id !== gid; });
    apiPersistGroups();
    // 组内请求回到「未分组」：否则会留下指向已删分组的孤儿 gid，列表里就再也看不到它们
    API_REQS = apiList().map(function (r) { if (r.gid === gid) r.gid = ""; return r; });
    apiPersist();
  }
  /* 请求实际所属的分组：分组已被删掉时残留的 gid 一律当「未分组」处理 */
  function apiReqGid(r) { return (r && r.gid && apiGroupFind(r.gid)) ? r.gid : ""; }
  function apiMoveReq(id, gid) {
    const r = apiFind(id); if (!r) return "";
    r.gid = (gid && apiGroupFind(gid)) ? gid : "";
    apiPersist();
    return r.gid;
  }
  function apiRow(k, v) { return { on: true, k: k || "", v: v || "" }; }
  /* 复制文本：优先异步剪贴板，失败再回退 execCommand（http / webview / 无剪贴板权限都能兜住） */
  function apiCopy(text) {
    const t = String(text == null ? "" : text);
    function execCopy() {
      return new Promise(function (res, rej) {
        const ta = document.createElement("textarea");
        ta.value = t; ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand("copy") ? res() : rej(new Error("copy failed")); }
        catch (e) { rej(e); } finally { ta.remove(); }
      });
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).catch(execCopy);
    return execCopy();
  }
  /* 复制失败时的兜底：弹出文本框并自动全选，让用户手动 Ctrl+C，避免「点了没反应」 */
  function apiCopyFallback(title, text) {
    uiModal({ title: title, hideCancel: true, okText: "关闭",
      html: '<textarea id="apiCopyOut" class="api-curl-in scroll-thin" spellcheck="false">' + esc(String(text == null ? "" : text)) + '</textarea>' });
    const ta = $("apiCopyOut");
    if (ta) { ta.focus(); ta.select(); ta.addEventListener("keydown", function (e) { e.stopPropagation(); }); }
  }
/*__APPEND__*/
  /* ---------------- 左栏列表 ---------------- */
  /* 单个请求条目。draggable 用于「拖拽到分组归类」，data-api-id 是点击与拖拽共用的定位依据 */
  function apiItemHtml(r) {
    const m = (r.method || "GET").toUpperCase();
    // 「已打开」和「当前正在编辑」都以标签页的真实状态为准：
    // active 若用模块里缓存的 id（只有 apiOpen 会写），从标签栏切走、或切到别的文件时
    // 缓存值不会变，底色就一直停在错误的条目上。这里与数据库侧栏的判定方式保持一致。
    const tab = findTab(API_VIEW_PREFIX + r.id);
    const open = !!tab;
    const act = !!(tab && tab.host && tab.host.classList.contains("active"));
    return '<div class="api-item' + (open ? " open" : "") + (act ? " active" : "") + '" draggable="true" data-api-id="' + apiAttr(r.id) + '" title="' + apiAttr(r.url || "（未填写 URL）") + '">' +
      '<span class="api-m api-m-' + (API_METHOD_CLS[m] || "get") + '">' + esc(m) + '</span>' +
      '<span class="api-main"><span class="api-name">' + esc(r.name || "未命名") + '</span>' +
      '<span class="api-sub">' + esc(r.url || "（未填写 URL）") + '</span></span>' +
      '<button class="api-act api-ren" title="重命名"><i class="bi bi-pencil"></i></button>' +
      '<button class="api-act api-del" title="删除"><i class="bi bi-trash3"></i></button>' +
      '</div>';
  }
  /* 列表结构：未分组的请求排在最上，然后按创建顺序排列各分组（分组可折叠） */
  function apiRenderList() {
    const box = $("apiList"); if (!box) return;
    const list = apiList(), groups = apiLoadGroups();
    // 顺手清掉指向已删分组的孤儿 gid，否则这些请求在列表里会凭空消失
    const known = {};
    groups.forEach(function (g) { known[g.id] = true; });
    let fixed = false;
    list.forEach(function (r) { if (r.gid && !known[r.gid]) { r.gid = ""; fixed = true; } });
    if (fixed) apiPersist();
    if (!list.length && !groups.length) { box.innerHTML = '<div class="api-empty">还没有请求，点上方「新建请求」开始。</div>'; return; }
    let html = "";
    list.filter(function (r) { return !r.gid; }).forEach(function (r) { html += apiItemHtml(r); });
    groups.forEach(function (g) {
      const items = list.filter(function (r) { return r.gid === g.id; });
      html += '<div class="api-group' + (g.collapsed ? " collapsed" : "") + '" data-gid="' + apiAttr(g.id) + '">' +
        '<div class="api-ghead" data-gid="' + apiAttr(g.id) + '" title="点击折叠/展开；拖拽请求到这里移入分组">' +
          '<i class="bi ' + (g.collapsed ? "bi-chevron-right" : "bi-chevron-down") + ' api-gchev"></i>' +
          '<i class="bi bi-folder-fill api-gico"></i>' +
          '<span class="api-gname">' + esc(g.name) + '</span>' +
          '<span class="api-gcount">' + items.length + '</span>' +
          '<button class="api-act api-gadd" title="在此分组新建请求"><i class="bi bi-plus-lg"></i></button>' +
          '<button class="api-act api-gren" title="重命名分组"><i class="bi bi-pencil"></i></button>' +
          '<button class="api-act api-gdel" title="删除分组"><i class="bi bi-trash3"></i></button>' +
        '</div>' +
        '<div class="api-gbody">' +
          (items.length ? items.map(apiItemHtml).join("") : '<div class="api-gempty">空分组，把请求拖进来</div>') +
        '</div>' +
      '</div>';
    });
    box.innerHTML = html;
  }
  window.apiSyncOpenMarks = function () { apiRenderList(); };
  function loadApiReqs() { apiRenderList(); }

  /* ---------------- 请求构建 ---------------- */
  function apiBuildUrl(req) {
    let url = (req.url || "").trim();
    if (!url) return "";
    const qs = [];
    (req.params || []).forEach(function (p) { if (p.on && p.k.trim()) qs.push(encodeURIComponent(p.k.trim()) + "=" + encodeURIComponent(p.v)); });
    if (qs.length) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs.join("&");
    return url;
  }
  function apiB64(s) {
    const bytes = new TextEncoder().encode(s || "");
    let bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function apiHasHdr(headers, name) { return Object.keys(headers).some(function (k) { return k.toLowerCase() === name; }); }
  function apiBuildHeaders(req) {
    const h = {};
    (req.headers || []).forEach(function (r) { if (r.on && r.k.trim()) h[r.k.trim()] = r.v; });
    const b = req.body || {};
    if (b.mode === "json" && (b.raw || "").trim()) { if (!apiHasHdr(h, "content-type")) h["Content-Type"] = "application/json"; }
    else if (b.mode === "form" && (b.form || []).some(function (r) { return r.on && r.k.trim(); })) { if (!apiHasHdr(h, "content-type")) h["Content-Type"] = "application/x-www-form-urlencoded"; }
    else if (b.mode === "text" && (b.raw || "").trim()) { if (!apiHasHdr(h, "content-type")) h["Content-Type"] = "text/plain; charset=utf-8"; }
    const a = req.auth || {};
    if (a.type === "bearer" && a.token) h["Authorization"] = "Bearer " + a.token;
    else if (a.type === "basic" && (a.username || a.password)) h["Authorization"] = "Basic " + apiB64(a.username + ":" + a.password);
    return h;
  }
  function apiBuildBody(req) {
    const b = req.body || {};
    if (b.mode === "json" || b.mode === "text") return b.raw || "";
    if (b.mode === "form") {
      const parts = [];
      (b.form || []).forEach(function (p) { if (p.on && p.k.trim()) parts.push(encodeURIComponent(p.k.trim()) + "=" + encodeURIComponent(p.v)); });
      return parts.join("&");
    }
    return "";
  }
  function apiCurl(req) {
    const url = apiBuildUrl(req);
    const headers = apiBuildHeaders(req);
    const body = apiBuildBody(req);
    let s = "curl -X " + req.method + " '" + url + "'";
    Object.keys(headers).forEach(function (k) { s += " \\\n  -H '" + (k + ": " + headers[k]).replace(/'/g, "'\\''") + "'"; });
    if (body && req.method !== "GET" && req.method !== "HEAD") s += " \\\n  --data-raw '" + body.replace(/'/g, "'\\''") + "'";
    return s;
  }
  function apiParseCurl(text) {
    text = (text || "").trim();
    if (text.indexOf("curl") === 0) text = text.replace(/^curl\s+/, "");
    const toks = []; let i = 0, n = text.length, cur = "", q = "";
    while (i < n) {
      const c = text[i];
      if (c === "\\" && (text[i + 1] === "\n" || text[i + 1] === " " || text[i + 1] === "\t")) { i += 2; cur += " "; continue; }
      if (q) { if (c === q) { q = ""; } else { cur += c; } i++; continue; }
      if (c === '"' || c === "'") { q = c; i++; continue; }
      if (c === " " || c === "\t" || c === "\n") { if (cur) { toks.push(cur); cur = ""; } i++; continue; }
      cur += c; i++;
    }
    if (cur) toks.push(cur);
    const req = apiBlank();
    let method = null, url = "", data = null;
    for (let j = 0; j < toks.length; j++) {
      const t = toks[j];
      if (t === "-X" || t === "--request") method = (toks[++j] || "GET").toUpperCase();
      else if (t === "--url") url = toks[++j] || "";
      else if (t === "-H" || t === "--header") { const h = toks[++j] || ""; const idx = h.indexOf(":"); if (idx > 0) req.headers.push(apiRow(h.slice(0, idx).trim(), h.slice(idx + 1).trim())); }
      else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary" || t === "--data-urlencode") data = toks[++j] || "";
      else if (t === "-u" || t === "--user") { const u = toks[++j] || ""; const sp = u.indexOf(":"); req.auth.type = "basic"; req.auth.username = sp >= 0 ? u.slice(0, sp) : u; req.auth.password = sp >= 0 ? u.slice(sp + 1) : ""; }
      else if (t.indexOf("-") === 0) { /* 忽略其它开关 */ }
      else if (!url) url = t;
    }
    req.method = method || (data !== null ? "POST" : "GET");
    req.url = url;
    if (data !== null) { req.body.mode = "raw"; req.body.raw = data; }
    return req;
  }
/*__APPEND__*/
  /* ---------------- 编辑器标签 ---------------- */
  function apiOpen(id) {
    let req = apiFind(id);
    if (!req) return;
    const path = API_VIEW_PREFIX + req.id;
    let tab = findTab(path);
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host api-host";
      tab = { path: path, displayPath: req.name, name: req.name, host: host, cm: null, original: "",
        dirty: false, big: false, group: curGroup, isApi: true, reqId: req.id, iconHtml: '<i class="bi bi-send"></i>' };
      tabs.push(tab); renderTabsAll();
    }
    apiBuildView(tab, req);
    activate(tab);          // activate 会回调 apiSyncOpenMarks() → apiRenderList()，高亮自动跟随
    apiRenderList();
    return tab;
  }

  function apiBuildView(tab, req) {
    if (tab.api && tab.api.req) req = tab.api.req;
    else req = apiFind(req.id) || req;
    tab.api = { req: req, sending: false, err: "", res: null, el: null, curPane: "params", curRes: "body" };
    tab.name = req.name; if (tab.el) renderTab(tab);
    const h = tab.host;
    h.innerHTML =
      '<div class="api">' +
        '<div class="api-bar">' +
          '<select class="api-method" title="请求方法">' +
            API_METHODS.map(function (m) { return '<option' + (m === req.method ? " selected" : "") + '>' + m + '</option>'; }).join("") +
          '</select>' +
          '<input class="api-url" spellcheck="false" autocomplete="off" placeholder="请求 URL，例如 https://api.example.com/users" value="' + apiAttr(req.url) + '">' +
          '<button class="g-btn api-send" title="发送 (Ctrl+Enter)"><i class="bi bi-send-fill"></i> 发送</button>' +
          '<span class="api-bar-sp"></span>' +
          '<button class="api-mini" id="apiCurlBtn" title="复制为 cURL"><i class="bi bi-terminal"></i> cURL</button>' +
          '<button class="api-mini" id="apiDupBtn" title="另存为副本"><i class="bi bi-files"></i></button>' +
        '</div>' +
        '<div class="api-req">' +
          '<div class="api-tabs">' +
            '<button class="api-tab" data-t="params">参数 <span class="api-badge" data-b="params">0</span></button>' +
            '<button class="api-tab" data-t="headers">请求头 <span class="api-badge" data-b="headers">0</span></button>' +
            '<button class="api-tab" data-t="body">请求体</button>' +
            '<button class="api-tab" data-t="auth">认证</button>' +
          '</div>' +
          '<div class="api-panes">' +
            '<div class="api-pane" data-p="params"></div>' +
            '<div class="api-pane" data-p="headers"></div>' +
            '<div class="api-pane" data-p="body"></div>' +
            '<div class="api-pane" data-p="auth"></div>' +
          '</div>' +
        '</div>' +
        '<div class="api-res">' +
          '<div class="api-res-head">' +
            '<span class="api-res-meta">尚未发送</span>' +
            '<span class="api-bar-sp"></span>' +
            '<button class="api-mini" id="apiCopyRes" title="复制响应体" disabled><i class="bi bi-clipboard"></i></button>' +
          '</div>' +
          '<div class="api-res-tabs">' +
            '<button class="api-rtab active" data-rt="body">响应体</button>' +
            '<button class="api-rtab" data-rt="headers">响应头</button>' +
            '<button class="api-rtab" data-rt="raw">原始</button>' +
          '</div>' +
          '<div class="api-res-body scroll-thin"></div>' +
        '</div>' +
      '</div>';

    tab.api.el = {
      method: h.querySelector(".api-method"), url: h.querySelector(".api-url"),
      panes: { params: h.querySelector('[data-p="params"]'), headers: h.querySelector('[data-p="headers"]'),
        body: h.querySelector('[data-p="body"]'), auth: h.querySelector('[data-p="auth"]') },
      res: h.querySelector(".api-res-body"), meta: h.querySelector(".api-res-meta"),
      copy: h.querySelector("#apiCopyRes"),
    };
    tab.api.el.method.addEventListener("change", function () { req.method = tab.api.el.method.value; apiPersist(); apiRenderList(); });
    tab.api.el.url.addEventListener("input", function () { req.url = tab.api.el.url.value; apiPersist(); apiRenderList(); });
    tab.api.el.url.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apiSend(tab); } });
    h.querySelector(".api-send").addEventListener("click", function () { apiSend(tab); });
    h.querySelector("#apiCurlBtn").addEventListener("click", function () {
      const txt = apiCurl(req);
      apiCopy(txt).then(function () { toast("cURL 已复制到剪贴板", "ok"); })
        .catch(function () { apiCopyFallback("复制为 cURL", txt); });
    });
    h.querySelector("#apiDupBtn").addEventListener("click", function () { const c = JSON.parse(JSON.stringify(req)); c.id = apiNewId(); c.name = req.name + " 副本"; apiAdd(c); apiRenderList(); apiOpen(c.id); toast("已另存为副本", "ok"); });
    h.querySelector("#apiCopyRes").addEventListener("click", function () { apiCopyResponse(tab); });
    h.querySelectorAll(".api-tab").forEach(function (b) { b.addEventListener("click", function () { apiShowPane(tab, b.dataset.t); }); });
    h.querySelectorAll(".api-rtab").forEach(function (b) { b.addEventListener("click", function () { apiShowRes(tab, b.dataset.rt); }); });

    apiRenderPane(tab, "params"); apiRenderPane(tab, "headers"); apiRenderPane(tab, "body"); apiRenderPane(tab, "auth");
    apiShowPane(tab, "params"); apiPaintRes(tab);
  }
/*__APPEND__*/
  function apiShowPane(tab, t) {
    tab.api.curPane = t;
    tab.host.querySelectorAll(".api-tab").forEach(function (b) { b.classList.toggle("active", b.dataset.t === t); });
    tab.host.querySelectorAll(".api-pane").forEach(function (p) {
      const on = p.dataset.p === t;
      p.classList.toggle("active", on);      // 配合 CSS .api-pane.active{display:block}，否则内联置空会回落到 display:none
      p.style.display = on ? "" : "none";
    });
  }
  function apiShowRes(tab, t) {
    tab.api.curRes = t;
    tab.host.querySelectorAll(".api-rtab").forEach(function (b) { b.classList.toggle("active", b.dataset.rt === t); });
    apiPaintRes(tab);
  }
  function apiKvHtml(rows) {
    const body = (rows || []).map(function (r, i) {
      return '<tr data-i="' + i + '">' +
        '<td class="api-kv-c"><input type="checkbox" data-f="on"' + (r.on ? " checked" : "") + '></td>' +
        '<td><input class="api-kv-k" data-f="k" placeholder="名称" value="' + apiAttr(r.k) + '"></td>' +
        '<td><input class="api-kv-v" data-f="v" placeholder="值" value="' + apiAttr(r.v) + '"></td>' +
        '<td class="api-kv-x"><button class="api-kv-del" title="删除"><i class="bi bi-x-lg"></i></button></td>' +
        '</tr>';
    }).join("");
    // 表格外面套一层限高容器：最多显示 6 行，更多行用内部滚动条查看（见 CSS .api-kv-wrap）
    return '<div class="api-kv-wrap scroll-thin"><table class="api-kv"><tbody>' + (body || "") + '</tbody></table></div>' +
      '<button class="api-add"><i class="bi bi-plus-lg"></i> 添加一行</button>';
  }
  function apiWireKv(tab, list, rows, pane) {
    list.addEventListener("input", function (e) {
      const tr = e.target.closest("tr"); if (!tr) return;
      const i = +tr.dataset.i, f = e.target.dataset.f; if (rows[i] == null) return;
      if (f === "on") rows[i].on = e.target.checked; else rows[i][f] = e.target.value;
      apiPersist(); apiUpdateBadges(tab);
    });
    list.addEventListener("click", function (e) {
      // 重绘目标必须是「这张表所在的面板」：原先写死成 headers，导致在「参数」里增删行时
      // 重绘的是隐藏的 headers 面板，参数面板还留着已删除的旧行
      if (e.target.closest(".api-kv-del")) { const tr = e.target.closest("tr"); rows.splice(+tr.dataset.i, 1); apiRenderPane(tab, pane); apiPersist(); return; }
      if (e.target.closest(".api-add")) { rows.push(apiRow("", "")); apiRenderPane(tab, pane); apiPersist(); }
    });
  }
  function apiUpdateBadges(tab) {
    const req = tab.api.req;
    const set = function (k, v) { const b = tab.host.querySelector('.api-badge[data-b="' + k + '"]'); if (b) b.textContent = v; };
    set("params", (req.params || []).filter(function (r) { return r.on && r.k.trim(); }).length);
    set("headers", (req.headers || []).filter(function (r) { return r.on && r.k.trim(); }).length);
  }
  function apiRenderPane(tab, t) {
    const req = tab.api.req, box = tab.api.el.panes[t];
    if (t === "params") { box.innerHTML = apiKvHtml(req.params); apiWireKv(tab, box, req.params, "params"); }
    else if (t === "headers") { box.innerHTML = apiKvHtml(req.headers); apiWireKv(tab, box, req.headers, "headers"); }
    else if (t === "body") {
      const b = req.body;
      const modes = [["none", "无"], ["json", "JSON"], ["text", "文本"], ["form", "表单"]];
      box.innerHTML =
        '<div class="api-body-modes">' +
          modes.map(function (m) { return '<label class="api-radio"><input type="radio" name="apiBodyMode" value="' + m[0] + '"' + (b.mode === m[0] ? " checked" : "") + '> ' + m[1] + '</label>'; }).join("") +
          '<button class="api-mini api-fmt" title="格式化 JSON（缩进 2 空格）"><i class="bi bi-magic"></i> 格式化</button>' +
        '</div>' +
        (b.mode === "form" ? '<div class="api-form">' + apiKvHtml(b.form) + '</div>' :
          '<textarea class="api-raw" spellcheck="false" placeholder="' + (b.mode === "json" ? "{ }" : "请求体内容") + '"></textarea>');
      const ta = box.querySelector(".api-raw");
      if (ta) { ta.value = b.raw || ""; ta.addEventListener("input", function () { req.body.raw = ta.value; apiPersist(); }); }
      if (b.mode === "form") apiWireKv(tab, box.querySelector(".api-form"), b.form, "body");
      box.querySelectorAll('input[name="apiBodyMode"]').forEach(function (r) {
        r.addEventListener("change", function () { req.body.mode = r.value; if (r.value === "form" && !req.body.form.length) req.body.form.push(apiRow("", "")); apiPersist(); apiRenderPane(tab, "body"); });
      });
      const fmt = box.querySelector(".api-fmt");
      if (fmt) fmt.addEventListener("click", function () { apiFmtJson(tab); });
    }
    else if (t === "auth") {
      const a = req.auth;
      box.innerHTML =
        '<div class="api-auth-row"><label class="api-lb">类型</label><select class="api-auth-type">' +
          '<option value="none"' + (a.type === "none" ? " selected" : "") + '>无</option>' +
          '<option value="bearer"' + (a.type === "bearer" ? " selected" : "") + '>Bearer Token</option>' +
          '<option value="basic"' + (a.type === "basic" ? " selected" : "") + '>Basic Auth</option></select></div>' +
        (a.type === "bearer" ? '<div class="api-auth-row"><label class="api-lb">Token</label><input class="api-auth-token" placeholder="粘贴令牌" value="' + apiAttr(a.token) + '"></div>' : "") +
        (a.type === "basic" ?
          '<div class="api-auth-row"><label class="api-lb">用户名</label><input class="api-auth-u" placeholder="用户名" value="' + apiAttr(a.username) + '"></div>' +
          '<div class="api-auth-row"><label class="api-lb">密码</label><input class="api-auth-p" type="password" placeholder="密码" value="' + apiAttr(a.password) + '"></div>' : "");
      box.querySelector(".api-auth-type").addEventListener("change", function () { a.type = box.querySelector(".api-auth-type").value; apiPersist(); apiRenderPane(tab, "auth"); });
      const tk = box.querySelector(".api-auth-token"); if (tk) tk.addEventListener("input", function () { a.token = tk.value; apiPersist(); });
      const uu = box.querySelector(".api-auth-u"); if (uu) uu.addEventListener("input", function () { a.username = uu.value; apiPersist(); });
      const pp = box.querySelector(".api-auth-p"); if (pp) pp.addEventListener("input", function () { a.password = pp.value; apiPersist(); });
    }
    apiUpdateBadges(tab);
  }
/*__APPEND__*/
  /* ---------------- 发送与响应 ---------------- */
  function apiFmtJson(tab) {
    const b = tab.api.req.body;
    if (b.mode === "json") { try { b.raw = JSON.stringify(JSON.parse(b.raw || "null"), null, 2); } catch (_) { toast("不是合法 JSON，无法格式化", "warn"); return; } }
    const ta = tab.host.querySelector(".api-raw");
    if (ta) ta.value = b.raw;
    apiPersist();
  }
  function apiStatusCls(code) { return code >= 500 ? "err" : (code >= 400 ? "warn" : (code >= 200 && code < 300 ? "ok" : "info")); }
  function apiCopyResponse(tab) {
    const r = tab.api.res;
    if (!r) { toast("还没有响应", "warn"); return; }
    const txt = r.encoding === "base64" ? "[二进制响应，无法复制文本]" : (r.text || "");
    apiCopy(txt).then(function () { toast("响应体已复制", "ok"); })
      .catch(function () { apiCopyFallback("响应体", txt); });
  }
  async function apiSend(tab) {
    const req = tab.api.req;
    const url = apiBuildUrl(req);
    if (!url) { toast("请先填写请求 URL", "warn"); return; }
    const headers = apiBuildHeaders(req);
    const body = apiBuildBody(req);
    tab.api.sending = true; tab.api.err = ""; apiPaintRes(tab);
    const sendBtn = tab.host.querySelector(".api-send");
    if (sendBtn) { sendBtn.disabled = true; }
    try {
      const res = await fetch("/api/http/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: req.method, url: url, headers: headers,
          body: (req.method === "GET" || req.method === "HEAD") ? "" : body,
          timeout: 30, followRedirects: true, verifySsl: true }),
      });
      const d = await res.json();
      if (d && d.error) throw new Error(d.error);
      tab.api.res = d;
    } catch (e) {
      tab.api.res = null; tab.api.err = (e && e.message) || String(e);
    } finally {
      tab.api.sending = false;
      if (sendBtn) sendBtn.disabled = false;
      apiPaintRes(tab);
    }
  }
  function apiPaintRes(tab) {
    const el = tab.api.el; if (!el) return;
    const r = tab.api.res, err = tab.api.err, sending = tab.api.sending;
    if (el.copy) el.copy.disabled = !!sending || !r;   // 没有响应时「复制响应体」不可点
    if (sending) { el.meta.className = "api-res-meta info"; el.meta.textContent = "发送中…"; el.res.innerHTML = '<div class="api-res-hint"><i class="bi bi-arrow-repeat pa-spin"></i> 正在发送请求</div>'; return; }
    if (err) { el.meta.className = "api-res-meta err"; el.meta.textContent = "请求失败"; el.res.innerHTML = '<div class="api-res-err"><i class="bi bi-exclamation-triangle"></i> ' + esc(err) + '</div>'; return; }
    if (!r) { el.meta.className = "api-res-meta"; el.meta.textContent = "尚未发送"; el.res.innerHTML = '<div class="api-res-hint">填写请求后点「发送」查看响应。</div>'; return; }
    const sizeTxt = (r.size || 0) >= 1024 ? ((r.size / 1024).toFixed(1) + " KB") : (r.size + " B");
    el.meta.className = "api-res-meta " + apiStatusCls(r.status);
    el.meta.innerHTML = '<span class="api-st ' + apiStatusCls(r.status) + '">' + r.status + " " + esc(r.status_text || "") + "</span> · " +
      (r.elapsed_ms / 1000).toFixed(2) + " 秒 · " + sizeTxt +
      (r.redirected ? ' · <i class="bi bi-arrow-right"></i> 已重定向' : "") +
      (r.truncated ? ' · 截断(>5MB)' : "");
    const rt = tab.api.curRes;
    if (rt === "headers") {
      el.res.innerHTML = '<table class="api-hdrs">' + r.headers.map(function (p) {
        return "<tr><td class=\"api-hk\">" + esc(p[0]) + "</td><td class=\"api-hv\">" + esc(p[1]) + "</td></tr>";
      }).join("") + "</table>";
    } else if (rt === "raw") {
      el.res.innerHTML = '<pre class="api-pre">' + esc(JSON.stringify(r, null, 2)) + "</pre>";
    } else {
      if (r.encoding === "base64") {
        const ct = (r.content_type || "").split(";")[0].toLowerCase();
        if (ct.indexOf("image/") === 0) el.res.innerHTML = '<img class="api-img" src="data:' + r.content_type + ';base64,' + r.body_b64 + '">';
        else el.res.innerHTML = '<div class="api-res-hint">二进制响应（' + (r.content_type || "?") + '，' + sizeTxt + '）。<button class="api-mini" id="apiDl">下载</button></div>';
        const dl = el.res.querySelector("#apiDl"); if (dl) dl.addEventListener("click", function () { apiDownload(tab, ct); });
      } else {
        let out = r.text || "";
        try { if (/json/i.test(r.content_type || "")) out = JSON.stringify(JSON.parse(out), null, 2); } catch (_) {}
        el.res.innerHTML = '<pre class="api-pre">' + esc(out) + "</pre>";
      }
    }
  }
  function apiDownload(tab, ct) {
    const r = tab.api.res; if (!r || r.encoding !== "base64") return;
    const bin = atob(r.body_b64);
    const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: ct || "application/octet-stream" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "response." + (ct.split("/")[1] || "bin"); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
/*__APPEND__*/
  /* ---------------- 左栏交互 ---------------- */
  /* 拖拽落点解析：落在条目上 → 该条目所在分组；落在分组区域 → 该分组；其余（列表空白）→ 未分组 */
  function apiDropZone(node) {
    if (!node || !node.closest) return null;
    const item = node.closest(".api-item");
    if (item) {
      const r = apiFind(item.dataset.apiId);
      return { el: item, gid: r ? apiReqGid(r) : "" };
    }
    const grp = node.closest(".api-group");
    if (grp) {
      const head = grp.querySelector(".api-ghead");
      if (head) return { el: head, gid: grp.dataset.gid || "" };
    }
    return { el: $("apiList"), gid: "" };
  }
  /* 右键条目「移动到分组」：拖拽之外的兜底入口（不方便拖拽时用） */
  async function apiAskMove(id) {
    const r = apiFind(id); if (!r) return;
    const cur = apiReqGid(r);
    const opts = '<option value="">（未分组）</option>' + apiLoadGroups().map(function (g) {
      return '<option value="' + apiAttr(g.id) + '"' + (g.id === cur ? " selected" : "") + '>' + esc(g.name) + '</option>';
    }).join("");
    const p = uiModal({ title: "移动到分组 · " + (r.name || "未命名"), icon: "bi-folder-symlink", okText: "移动",
      html: '<div class="api-mv-row"><label class="api-lb">分组</label><select id="apiMvSel">' + opts + '</select></div>' });
    const sel = $("apiMvSel");     // uiModal 是同步注入 DOM 的，await 之前就能取到
    let pick = cur;
    // 注意：uiModal 关闭时会先清空 innerHTML 再 resolve，所以值必须在这里就记下来
    if (sel) sel.addEventListener("change", function () { pick = sel.value; });
    if (!(await p)) return;
    apiMoveReq(id, pick);
    apiRenderList();
    const g = apiGroupFind(pick);
    toast("已移动到「" + (g ? g.name : "未分组") + "」", "ok");
  }
  function apiSideWire() {
    const newBtn = $("apiNew"), impBtn = $("apiImport"), expBtn = $("apiExport"),
      grpBtn = $("apiGroupNew"), list = $("apiList");
    // 顶部「新建请求」建在未分组下；要在分组里新建，用分组头右侧的 +
    if (newBtn) newBtn.addEventListener("click", function () { const r = apiBlank(); apiAdd(r); apiRenderList(); apiOpen(r.id); });
    if (impBtn) impBtn.addEventListener("click", function () { apiImportCurl(); });
    if (expBtn) expBtn.addEventListener("click", function () { apiExportAll(); });
    if (grpBtn) grpBtn.addEventListener("click", async function () {
      const n = await uiPrompt("新建分组", "", "例如：用户中心");
      if (!n) return;
      apiGroupAdd(n); apiRenderList(); toast("已新建分组", "ok");
    });
    if (list) list.addEventListener("click", async function (e) {
      /* ---------- 分组头 ---------- */
      const head = e.target.closest(".api-ghead");
      if (head) {
        const gid = head.dataset.gid, g = apiGroupFind(gid);
        if (!g) return;
        if (e.target.closest(".api-gadd")) { const r = apiBlank("新建请求", gid); apiAdd(r); apiRenderList(); apiOpen(r.id); return; }
        if (e.target.closest(".api-gren")) {
          const n = await uiPrompt("重命名分组", g.name, "分组名称");
          if (n) { g.name = n; apiPersistGroups(); apiRenderList(); }
          return;
        }
        if (e.target.closest(".api-gdel")) {
          const cnt = apiList().filter(function (r) { return r.gid === gid; }).length;
          const msg = "确定删除分组「" + g.name + "」吗？" +
            (cnt ? "\n组内 " + cnt + " 个请求会移到「未分组」，请求本身不会删除。" : "\n该分组是空的。");
          if (!(await uiConfirm("删除分组", msg, "删除", true))) return;
          apiGroupRemove(gid); apiRenderList(); toast("已删除分组", "ok");
          return;
        }
        g.collapsed = !g.collapsed;        // 点标题空白处 = 折叠 / 展开
        apiPersistGroups(); apiRenderList();
        return;
      }
      /* ---------- 请求条目 ---------- */
      const item = e.target.closest(".api-item"); if (!item) return;
      const id = item.dataset.apiId;
      if (e.target.closest(".api-del")) {
        // 删除不可撤销，且会连带关掉已打开的请求标签，所以加二次确认
        // （与「数据库连接」删除用同一套 uiConfirm 弹窗，标题 + 危险色按钮）
        const cur = apiFind(id);
        const nm = cur ? (cur.name || "未命名") : "该请求";
        if (!(await uiConfirm("删除请求", "确定删除「" + nm + "」吗？\n（只删除本机保存的这条请求，不可撤销）", "删除", true))) return;
        const t = findTab(API_VIEW_PREFIX + id);
        if (t) closeTab(t);          // 标签还在的话一并关闭
        API_REQS = apiLoad().filter(function (r) { return r.id !== id; }); apiPersist(); apiRenderList();
        return;
      }
      if (e.target.closest(".api-ren")) { uiPrompt("重命名请求", apiFind(id) ? apiFind(id).name : "", "新建请求").then(function (n) { const r = apiFind(id); if (r && n) { r.name = n; apiPersist(); const t = findTab(API_VIEW_PREFIX + id); if (t) { t.name = n; if (t.el) renderTab(t); } apiRenderList(); } }); return; }
      apiOpen(id);
    });
    /* 右键条目：弹出「移动到分组」，不习惯拖拽时走这里 */
    if (list) list.addEventListener("contextmenu", function (e) {
      const item = e.target.closest(".api-item"); if (!item) return;
      e.preventDefault();
      apiAskMove(item.dataset.apiId);
    });
    /* ---------- 拖拽：把请求拖进分组，或从分组拖回未分组 ----------
       dragId 只在按下拖动期间有值，dragover 靠它判断要不要 preventDefault
       （不 preventDefault 就不会触发 drop） */
    let dragId = "", zone = null;
    function clearZone() { if (zone) { zone.classList.remove("drop-on"); zone = null; } }
    if (list) list.addEventListener("dragstart", function (e) {
      const item = e.target.closest(".api-item"); if (!item) return;
      dragId = item.dataset.apiId;
      item.classList.add("dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragId); } catch (_) {} }
    });
    if (list) list.addEventListener("dragend", function () {
      dragId = ""; clearZone();
      list.querySelectorAll(".api-item.dragging").forEach(function (n) { n.classList.remove("dragging"); });
    });
    if (list) list.addEventListener("dragover", function (e) {
      if (!dragId) return;
      const z = apiDropZone(e.target); if (!z || !z.el) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (z.el !== zone) { clearZone(); zone = z.el; zone.classList.add("drop-on"); }
    });
    if (list) list.addEventListener("drop", function (e) {
      if (!dragId) return;
      const z = apiDropZone(e.target), id = dragId;
      e.preventDefault();
      dragId = ""; clearZone();
      if (!z) return;
      const gid = apiMoveReq(id, z.gid);
      // 拖进折叠的分组要自动展开，否则看不到落进去的结果
      const g = gid ? apiGroupFind(gid) : null;
      if (g && g.collapsed) { g.collapsed = false; apiPersistGroups(); }
      apiRenderList();
    });
  }
  async function apiImportCurl() {
    const p = uiModal({ title: "从 cURL 命令导入", html: '<textarea id="apiCurlIn" class="api-curl-in scroll-thin" placeholder="粘贴 curl 命令…"></textarea>', okText: "导入" });
    const ta = $("apiCurlIn");
    let buf = "";
    if (ta) ta.addEventListener("input", function () { buf = ta.value; });
    const ok = await p;
    if (!ok) return;
    const req = apiParseCurl(buf);
    if (!req.url) { toast("未能从命令中解析出 URL", "warn"); return; }
    apiAdd(req); apiRenderList(); apiOpen(req.id); toast("已导入请求", "ok");
  }
  function apiExportAll() {
    const data = JSON.stringify(apiList(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "api-requests.json"; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  /* 导出给 00_preamble 的 sessionRestore 用：刷新后按虚拟路径 \u0000http:<请求 id> 还原已打开的请求标签。
     本模块是独立 IIFE，内部的 const / function 默认不对外可见（此前只导出了 apiSideWire/apiSyncOpenMarks，
     导致 sessionRestore 里 typeof API_VIEW_PREFIX === "string" 恒为 false，这段还原逻辑成了死代码，
     请求标签会掉进 openFile 分支去读不存在的路径）。 */
  window.API_VIEW_PREFIX = API_VIEW_PREFIX;
  window.apiFind = apiFind;
  window.apiOpen = apiOpen;
  window.apiSideWire = apiSideWire;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apiSideWire); else apiSideWire();
})();
