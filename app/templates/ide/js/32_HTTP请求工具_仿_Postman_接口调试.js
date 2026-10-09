/* API 调试（仿 Postman）：HTTP 请求客户端。入口：左侧活动栏「API 调试」图标（#actApi）。 */
(function () {
  "use strict";
  const API_VIEW_PREFIX = "\u0000http:";
  const API_STORE_KEY = "ide.http.reqs";
  const API_GROUP_KEY = "ide.http.groups";     // 分组单独存一个键：旧数据没有 gid 字段，天然落在「未分组」，无需迁移
  const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  const API_METHOD_CLS = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "delete", HEAD: "head", OPTIONS: "options" };
  const API_REQ_H_KEY = "ide.http.reqHeight";  // 拖过响应状态栏后的「请求区」高度（px）；没拖过就没有这个键
  const API_RES_VIEW_KEY = "ide.http.resView";  // 响应体视图偏好：美化/原始/预览/可视化 + 语言 + 是否自动换行
  const API_RES_VIEWS = ["pretty", "raw", "preview", "visualize"];
  const API_RES_LANGS = ["auto", "json", "xml", "html", "javascript", "text"];
  const API_REQ_MIN_H = 120;                   // 请求区最小高度：页签 + 至少一行内容
  const API_RES_MIN_H = 140;                   // 响应区最小高度：状态栏 + 页签 + 几行内容
  const API_PANE_KEY = "ide.http.pane";        // 请求区当前页签：参数 / 请求头 / 请求体 / 认证
  const API_RTAB_KEY = "ide.http.resTab";      // 响应区当前页签：响应体 / 响应头 / 原始数据
  const API_PANES = ["params", "headers", "body", "auth"];
  const API_RTABS = ["body", "headers", "raw"];

  let API_REQS = null;
  let API_GROUPS = null;
  let API_RES_VIEW = null;     // 响应体视图偏好（见 apiResView）

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
  /* 一行 key-value。desc 是「注释」列：纯备注，不参与 URL / 请求头 / 表单的构建 */
  function apiRow(k, v, d) { return { on: true, k: k || "", v: v || "", desc: d || "" }; }
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
  // activate / renderTabsAll 都会调它：此时标签已显示，顺手把「等显示再接上的请求区高度」落实（见 apiFlushReqH）
  window.apiSyncOpenMarks = function () { apiRenderList(); apiFlushReqH(); };
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
  /* ---------------- 生成代码（Postman 风格的多语言代码段） ----------------
     把当前请求翻译成各语言的等价调用。复用了请求构建那套 apiBuildUrl / apiBuildHeaders /
     apiBuildBody，所以生成的代码与「实际发出的请求」严格一致（含自动补的 Content-Type、Bearer/Basic 认证）。
     字符串一律走 JSON.stringify 或语言自带的「原始字符串」语法兜底，保证生成的代码片段本身是合法代码，
     不会被请求体里的引号 / 反斜杠带崩（也顺便避免 XSS：悬浮框里用 textContent 渲染，不碰 innerHTML）。 */
  const API_CODE_TARGETS = [
    { id: "cs_httpclient", label: "C# - HttpClient" },
    { id: "cs_restsharp", label: "C# - RestSharp" },
    { id: "curl", label: "cURL" },
    { id: "dart_dio", label: "Dart - dio" },
    { id: "dart_http", label: "Dart - http" },
    { id: "go", label: "Go - Native" },
    { id: "http", label: "HTTP" },
    { id: "java_okhttp", label: "Java - OkHttp" },
    { id: "java_unirest", label: "Java - Unirest" },
    { id: "js_fetch", label: "JavaScript - Fetch" },
    { id: "js_jquery", label: "JavaScript - jQuery" },
    { id: "js_xhr", label: "JavaScript - XHR" },
    { id: "kotlin_okhttp", label: "Kotlin - Okhttp" },
    { id: "c_libcurl", label: "C - libcurl" },
    { id: "node_axios", label: "NodeJs - Axios" },
    { id: "node_native", label: "NodeJs - Native" },
    { id: "node_request", label: "NodeJs - Request" },
    { id: "node_unirest", label: "NodeJs - Unirest" },
    { id: "objc_nsurlsession", label: "Objective-C - NSURLSession" },
    { id: "ocaml", label: "OCaml - Cohttp" },
    { id: "php_curl", label: "PHP - cURL" },
    { id: "php_guzzle", label: "PHP - Guzzle" },
    { id: "php_http_request2", label: "PHP - HTTP_Request2" },
    { id: "php_pecl_http", label: "PHP - pecl_http" },
    { id: "ps", label: "PowerShell - RestMethod" },
    { id: "py_http", label: "Python - http.client" },
    { id: "py_requests", label: "Python - Requests" },
    { id: "r_httr", label: "R - httr" },
    { id: "r_rcurl", label: "R - RCurl" },
    { id: "ruby", label: "Ruby - Net::HTTP" },
    { id: "rust_reqwest", label: "Rust - reqwest" },
    { id: "httpie", label: "Shell - Httpie" },
    { id: "wget", label: "Shell - wget" },
    { id: "swift_urlsession", label: "Swift - URLSession" },
  ];
  const API_CODE_LANG_KEY = "ide.http.codeLang";   // 记住上次选的语言（和 cURL 偏好一样，工具级）

  function apiUrlParts(url) {
    try { const u = new URL(url); return { host: u.host, path: (u.pathname || "/") + u.search, scheme: u.protocol.replace(":", "") }; }
    catch (_) { return { host: url, path: "/", scheme: "http" }; }
  }
  /* 各语言的字符串字面量写法。JSON.stringify 的输出是合法的 JS/Python/Go/Java/C#/R/ObjC(C99)/Ruby
     字符串常量，所以大多数语言直接复用它；只有插值/原始字符串语义特殊的语言单独兜底：
       - Dart / Kotlin：$ 是插值，需转义成 \$
       - Rust / Swift：不支持 \uXXXX，改用原始字符串 r#"..."# / #"..."#
       - Go / OCaml：用反引号 / {| |} 原始串，含定界符时回退
       - Ruby：双引号串 #{} 会插值，转义成 \#{
       - PowerShell：单引号 here-string + 转义 $ 和 "
       - Shell：单引号串按 '\'' 转义 */
  function pyDict(o) { const ks = Object.keys(o); if (!ks.length) return "{}"; return "{\n" + ks.map(function (k) { return "    " + JSON.stringify(k) + ": " + JSON.stringify(o[k]); }).join(",\n") + "\n}"; }
  function jsDict(o) { const ks = Object.keys(o); if (!ks.length) return "{}"; return "{\n  " + ks.map(function (k) { return JSON.stringify(k) + ": " + JSON.stringify(o[k]); }).join(",\n  ") + "\n}"; }
  function phpStr(s) { return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }
  function phpAssoc(o) { const ks = Object.keys(o); if (!ks.length) return "[]"; return "[\n" + ks.map(function (k) { return "    " + JSON.stringify(k) + " => " + phpStr(o[k]); }).join(",\n") + "\n  ]"; }
  function phpUrl(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
  function goStr(s) { return String(s).indexOf("`") >= 0 ? JSON.stringify(s) : "`" + s + "`"; }
  function csStr(s) { return JSON.stringify(s); }
  function javaStr(s) { return JSON.stringify(s); }
  function cStr(s) { return JSON.stringify(s); }
  function rStr(s) { return JSON.stringify(s); }
  function objcStr(s) { return "@" + JSON.stringify(s); }
  function rubyDq(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
  /* Ruby 双引号串里 #{} 会被当插值，请求体里若恰好有就转义掉（#\{ 在 Ruby 里是字面 #） */
  function rubyStr(s) { return JSON.stringify(s).replace(/#([{@$])/g, "#\\$1"); }
  function ocamlStr(s) { return String(s).indexOf("|}") >= 0 ? JSON.stringify(s) : "{|" + s + "|}"; }
  function psStr(s) { return '"' + String(s).replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '""') + '"'; }
  function dartStr(s) { return JSON.stringify(s).replace(/\$/g, function () { return "\\$"; }); }
  function kotlinStr(s) { return JSON.stringify(s).replace(/\$/g, function () { return "\\$"; }); }
  function rustStr(s) { const t = String(s); if (t.indexOf('"#') < 0) return 'r#"' + t + '"#'; if (t.indexOf('"##') < 0) return 'r##"' + t + '"##'; return 'r###"' + t + '"###'; }
  function swiftStr(s) { const t = String(s); if (t.indexOf('"#') < 0) return '#"' + t + '"#'; if (t.indexOf('"##') < 0) return '##"' + t + '"##'; return '###"' + t + '"###'; }
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  function apiGenCode(target, req) {
    if (target === "curl") return apiCurl(req);
    const url = apiBuildUrl(req);
    const headers = apiBuildHeaders(req);
    const body = apiBuildBody(req);
    const hasBody = !!(body && req.method !== "GET" && req.method !== "HEAD");
    const ct = headers["Content-Type"] || (hasBody ? "text/plain" : "");
    switch (target) {
      case "cs_httpclient": return apiCodeCs(url, headers, body, hasBody, req.method, ct);
      case "cs_restsharp": return apiCodeRestSharp(url, headers, body, hasBody, req.method);
      case "dart_dio": return apiCodeDartDio(url, headers, body, hasBody, req.method);
      case "dart_http": return apiCodeDartHttp(url, headers, body, hasBody, req.method);
      case "go": return apiCodeGo(url, headers, body, hasBody, req.method, ct);
      case "http": return apiCodeRawHttp(url, headers, body, hasBody, req.method);
      case "java_okhttp": return apiCodeJava(url, headers, body, hasBody, req.method, ct);
      case "java_unirest": return apiCodeUnirest(url, headers, body, hasBody, req.method);
      case "js_fetch": return apiCodeJs(url, headers, body, hasBody, req.method);
      case "js_jquery": return apiCodeJquery(url, headers, body, hasBody, req.method);
      case "js_xhr": return apiCodeXhr(url, headers, body, hasBody, req.method);
      case "kotlin_okhttp": return apiCodeKotlinOkhttp(url, headers, body, hasBody, req.method, ct);
      case "c_libcurl": return apiCodeLibcurl(url, headers, body, hasBody, req.method);
      case "node_axios": return apiCodeNodeAxios(url, headers, body, hasBody, req.method);
      case "node_native": return apiCodeNodeNative(url, headers, body, hasBody, req.method);
      case "node_request": return apiCodeNodeRequest(url, headers, body, hasBody, req.method);
      case "node_unirest": return apiCodeNodeUnirest(url, headers, body, hasBody, req.method);
      case "objc_nsurlsession": return apiCodeObjc(url, headers, body, hasBody, req.method);
      case "ocaml": return apiCodeOcaml(url, headers, body, hasBody, req.method);
      case "php_curl": return apiCodePhpCurl(url, headers, body, hasBody, req.method);
      case "php_guzzle": return apiCodePhpGuzzle(url, headers, body, hasBody, req.method);
      case "php_http_request2": return apiCodePhpRequest2(url, headers, body, hasBody, req.method);
      case "php_pecl_http": return apiCodePhpPecl(url, headers, body, hasBody, req.method);
      case "ps": return apiCodePs(url, headers, body, hasBody, req.method);
      case "py_http": return apiCodePyHttp(url, headers, body, hasBody, req.method);
      case "py_requests": return apiCodePyRequests(url, headers, body, hasBody, req.method);
      case "r_httr": return apiCodeRHttr(url, headers, body, hasBody, req.method);
      case "r_rcurl": return apiCodeRRcurl(url, headers, body, hasBody, req.method);
      case "ruby": return apiCodeRuby(url, headers, body, hasBody, req.method);
      case "rust_reqwest": return apiCodeRust(url, headers, body, hasBody, req.method);
      case "httpie": return apiCodeHttpie(url, headers, body, hasBody, req.method);
      case "wget": return apiCodeWget(url, headers, body, hasBody, req.method);
      case "swift_urlsession": return apiCodeSwift(url, headers, body, hasBody, req.method);
      default: return "// 未知语言";
    }
  }
  function apiCodePyHttp(url, headers, body, hasBody, method) {
    const u = apiUrlParts(url), path = u.path || "/";
    const conn = u.scheme === "https" ? "HTTPSConnection" : "HTTPConnection";
    let s = "import http.client\n";
    if (hasBody) s += "import json\n\n"; else s += "\n";
    s += "conn = http.client." + conn + '("' + u.host + '")\n';
    s += (hasBody ? "payload = " + JSON.stringify(body) + "\n\n" : "\npayload = None\n");
    s += "headers = " + pyDict(headers) + "\n\n";
    s += 'conn.request("' + method + '", "' + path + '", payload, headers)\n';
    s += "res = conn.getresponse()\n";
    s += 'data = res.read().decode("utf-8")\n';
    s += "print(data)\n";
    return s;
  }
  function apiCodePyRequests(url, headers, body, hasBody, method) {
    let s = "import requests\n\n";
    s += 'url = "' + url + '"\n';
    s += "headers = " + pyDict(headers) + "\n";
    if (hasBody) s += "payload = " + JSON.stringify(body) + "\n";
    s += "\nresponse = requests.request(\"" + method + "\", url" + (hasBody ? ", data=payload" : "") + ", headers=headers)\n";
    s += "print(response.text)\n";
    return s;
  }
  function apiCodeNode(url, headers, body, hasBody, method) {
    let s = "const url = " + JSON.stringify(url) + ";\n";
    s += "const options = {\n";
    s += '  method: "' + method + '",\n';
    s += "  headers: " + jsDict(headers) + "\n";
    if (hasBody) s += "  body: " + JSON.stringify(body) + "\n";
    s += "};\n\n";
    s += "fetch(url, options)\n";
    s += "  .then((res) => res.text())\n";
    s += "  .then((body) => console.log(body))\n";
    s += "  .catch((error) => console.error(error));\n";
    return s;
  }
  function apiCodeJs(url, headers, body, hasBody, method) {
    let s = "fetch(" + JSON.stringify(url) + ", {\n";
    s += '  method: "' + method + '",\n';
    s += "  headers: " + jsDict(headers) + (hasBody ? ",\n  body: " + JSON.stringify(body) + "\n" : "\n");
    s += "})\n";
    s += "  .then((r) => r.text())\n";
    s += "  .then((data) => console.log(data));\n";
    return s;
  }
  function apiCodePhpCurl(url, headers, body, hasBody, method) {
    let s = "<?php\n\n";
    s += "$curl = curl_init();\n\n";
    s += "curl_setopt_array($curl, [\n";
    s += '  CURLOPT_URL => ' + phpUrl(url) + ",\n";
    s += "  CURLOPT_RETURNTRANSFER => true,\n";
    s += '  CURLOPT_ENCODING => "",\n';
    s += "  CURLOPT_MAXREDIRS => 10,\n";
    s += "  CURLOPT_TIMEOUT => 30,\n";
    s += '  CURLOPT_FOLLOWLOCATION => true,\n';
    s += '  CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,\n';
    s += '  CURLOPT_CUSTOMREQUEST => "' + method + '",\n';
    if (hasBody) s += "  CURLOPT_POSTFIELDS => " + phpStr(body) + ",\n";
    s += "  CURLOPT_HTTPHEADER => [\n";
    s += Object.keys(headers).map(function (k) { return "    " + phpStr(k + ": " + headers[k]); }).join(",\n");
    s += "\n  ],\n]);\n\n";
    s += "$response = curl_exec($curl);\n";
    s += "$err = curl_error($curl);\n";
    s += "curl_close($curl);\n\n";
    s += "if ($err) {\n  echo \"cURL Error #:\" . $err;\n} else {\n  echo $response;\n}\n";
    return s;
  }
  function apiCodePhpGuzzle(url, headers, body, hasBody, method) {
    let s = "<?php\n\n";
    s += "use GuzzleHttp\\Client;\n\n";
    s += "$client = new Client();\n\n";
    s += "$response = $client->request(\n";
    s += '  "' + method + '",\n';
    s += "  " + phpUrl(url) + ",\n";
    s += "  [\n";
    s += '    "headers" => ' + phpAssoc(headers) + (hasBody ? ",\n    \"body\" => " + phpStr(body) + "\n" : "\n");
    s += "  ]\n);\n\n";
    s += "echo $response->getBody();\n";
    return s;
  }
  function apiCodeCs(url, headers, body, hasBody, method, ct) {
    const others = {};
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() !== "content-type") others[k] = headers[k]; });
    let s = "using System.Net.Http;\nusing System.Text;\nusing System.Threading.Tasks;\n\n";
    s += "public class Program\n{\n  public static async Task Main()\n  {\n";
    s += "    var client = new HttpClient();\n\n";
    s += '    var request = new HttpRequestMessage(new HttpMethod("' + method + '"), "' + csStr(url) + '");\n';
    if (hasBody) { s += "    var content = new StringContent(" + csStr(body) + ', null, "' + (ct || "text/plain") + '");\n    request.Content = content;\n'; }
    Object.keys(others).forEach(function (k) { s += '    request.Headers.TryAddWithoutValidation("' + csStr(k) + '", "' + csStr(others[k]) + '");\n'; });
    s += "\n    var response = await client.SendAsync(request);\n";
    s += "    response.EnsureSuccessStatusCode();\n";
    s += "    var body = await response.Content.ReadAsStringAsync();\n";
    s += '    System.Console.WriteLine(body);\n';
    s += "  }\n}\n";
    return s;
  }
  function apiCodeGo(url, headers, body, hasBody, method) {
    let s = "package main\n\nimport (\n\t\"fmt\"\n\t\"io\"\n\t\"net/http\"\n";
    if (hasBody) s += '\t"strings"\n';
    s += ")\n\nfunc main() {\n";
    s += "\turl := " + goStr(url) + "\n\tmethod := " + goStr(method) + "\n\n";
    if (hasBody) s += "\tpayload := strings.NewReader(" + goStr(body) + ")\n\n";
    s += "\tclient := &http.Client{}\n";
    s += "\treq, err := http.NewRequest(method, url, " + (hasBody ? "payload" : "nil") + ")\n";
    s += "\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n\n";
    Object.keys(headers).forEach(function (k) { s += "\treq.Header.Add(" + goStr(k) + ", " + goStr(headers[k]) + ")\n"; });
    s += "\n\tres, err := client.Do(req)\n\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n\tdefer res.Body.Close()\n\n";
    s += "\tbody, err := io.ReadAll(res.Body)\n\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n\tfmt.Println(string(body))\n}\n";
    return s;
  }
  function apiCodeRuby(url, headers, body, hasBody, method) {
    const K = { GET: "Get", POST: "Post", PUT: "Put", PATCH: "Patch", DELETE: "Delete", HEAD: "Head", OPTIONS: "Options" };
    let s = 'require "uri"\nrequire "net/http"\n\n';
    s += 'url = URI("' + rubyDq(url) + '")\n';
    s += "http = Net::HTTP.new(url.host, url.port)\n";
    s += 'http.use_ssl = (url.scheme == "https")\n\n';
    s += "request = Net::HTTP::" + (K[method] || "Post") + ".new(url)\n";
    Object.keys(headers).forEach(function (k) { s += "request[" + rubyDq(k) + "] = " + rubyDq(headers[k]) + "\n"; });
    if (hasBody) s += "request.body = " + rubyStr(body) + "\n";
    s += "\nresponse = http.request(request)\nputs response.read_body\n";
    return s;
  }
  function apiCodePs(url, headers, body, hasBody, method) {
    let s = '$method = "' + method + '"\n';
    s += "$uri = " + psStr(url) + "\n";
    s += "$headers = @{\n";
    Object.keys(headers).forEach(function (k) { s += "  " + psStr(k) + " = " + psStr(headers[k]) + "\n"; });
    s += "}\n";
    if (hasBody) s += "$body = " + "@'\n" + body + "\n'@\n";
    s += "$response = Invoke-RestMethod -Method $method -Uri $uri -Headers $headers" + (hasBody ? " -Body $body" : "") + "\n";
    s += "$response\n";
    return s;
  }
  function apiCodeOcaml(url, headers, body, hasBody, method) {
    let s = "open Cohttp_lwt_unix\nopen Cohttp\nopen Lwt\n\n";
    s += "let body =" + (hasBody ? " {|" + body + "|}" : ' ""') + "\n\n";
    s += "let () =\n  let uri = Uri.of_string " + ocamlStr(url) + " in\n  let headers =\n    Header.init ()";
    Object.keys(headers).forEach(function (k) { s += "\n      |> Header.add " + ocamlStr(k) + " " + ocamlStr(headers[k]); });
    s += "\n  in\n";
    if (hasBody) s += "  let%lwt resp = Client.post ~headers uri ~body:(Cohttp.Body.of_string body) in\n";
    else s += "  let%lwt resp = Client.get ~headers uri in\n";
    s += "  let%lwt body_str = Cohttp_lwt.Body.to_string resp.body in\n";
    s += "  Lwt_io.printl body_str\n";
    return s;
  }
  function apiCodeJava(url, headers, body, hasBody, method, ct) {
    const others = {};
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() !== "content-type") others[k] = headers[k]; });
    let s = "import okhttp3.*;\nimport java.io.IOException;\n\npublic class Main {\n  public static void main(String[] args) throws IOException {\n";
    s += "    OkHttpClient client = new OkHttpClient();\n\n";
    if (hasBody) { s += '    MediaType mediaType = MediaType.parse("' + ct + '");\n    RequestBody body = RequestBody.create(mediaType, ' + javaStr(body) + ");\n"; }
    s += "    Request request = new Request.Builder()\n      .url(" + javaStr(url) + ")\n      .method(" + method + ", " + (hasBody ? "body" : "null") + ")\n";
    Object.keys(others).forEach(function (k) { s += '      .addHeader("' + javaStr(k) + '", "' + javaStr(others[k]) + '")\n'; });
    s += "      .build();\n\n";
    s += "    Response response = client.newCall(request).execute();\n    System.out.println(response.body().string());\n  }\n}\n";
    return s;
  }
  function apiCodeHttpie(url, headers, body, hasBody, method) {
    let s = "http " + (method === "GET" ? "" : "--method " + method + " ") + url;
    Object.keys(headers).forEach(function (k) { s += " " + k + ":" + headers[k]; });
    if (hasBody) s += " body:=" + JSON.stringify(body);
    return s.trim() + "\n";
  }
  function apiCodeRestSharp(url, headers, body, hasBody, method) {
    const M = { GET: "Get", POST: "Post", PUT: "Put", DELETE: "Delete", PATCH: "Patch", HEAD: "Head", OPTIONS: "Options" };
    const others = {};
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() !== "content-type") others[k] = headers[k]; });
    let s = "using RestSharp;\n\n";
    s += "var client = new RestClient(" + csStr(url) + ");\n";
    s += 'var request = new RestRequest("", Method.' + (M[method] || "Post") + ");\n";
    Object.keys(others).forEach(function (k) { s += "request.AddHeader(" + csStr(k) + ", " + csStr(others[k]) + ");\n"; });
    if (hasBody) s += "request.AddStringBody(" + csStr(body) + ", " + csStr(headers["Content-Type"] || "text/plain") + ");\n";
    s += "\nvar response = await client.ExecuteAsync(request);\n";
    s += "Console.WriteLine(response.Content);\n";
    return s;
  }
  function apiCodeDartDio(url, headers, body, hasBody, method) {
    const ks = Object.keys(headers);
    let s = "import 'package:dio/dio.dart';\n\nvoid main() async {\n  final dio = Dio();\n\n";
    s += "  final response = await dio.request(\n    " + dartStr(url) + ",\n";
    s += "    options: Options(\n      method: '" + method + "',\n      headers: {\n";
    s += ks.map(function (k) { return "        " + dartStr(k) + ": " + dartStr(headers[k]); }).join(",\n");
    s += (ks.length ? "\n" : "") + "      },\n    ),\n";
    if (hasBody) s += "    data: " + dartStr(body) + ",\n";
    s += "  );\n\n  print(response.data);\n}\n";
    return s;
  }
  function apiCodeDartHttp(url, headers, body, hasBody, method) {
    const ks = Object.keys(headers);
    let s = "import 'package:http/http.dart' as http;\n\nvoid main() async {\n  var headers = {\n";
    s += ks.map(function (k) { return "    " + dartStr(k) + ": " + dartStr(headers[k]); }).join(",\n");
    s += (ks.length ? "\n" : "") + "  };\n";
    s += "  var request = http.Request('" + method + "', Uri.parse(" + dartStr(url) + "));\n";
    if (hasBody) s += "  request.body = " + dartStr(body) + ";\n";
    s += "  request.headers.addAll(headers);\n\n";
    s += "  http.StreamedResponse response = await request.send();\n\n";
    s += "  if (response.statusCode == 200) {\n    print(await response.stream.bytesToString());\n  } else {\n    print(response.reasonPhrase);\n  }\n}\n";
    return s;
  }
  function apiCodeRawHttp(url, headers, body, hasBody, method) {
    const u = apiUrlParts(url), path = u.path || "/";
    let s = method + " " + path + " HTTP/1.1\nHost: " + u.host + "\n";
    Object.keys(headers).forEach(function (k) { s += k + ": " + headers[k] + "\n"; });
    if (hasBody) s += "\n" + body + "\n";
    return s;
  }
  function apiCodeUnirest(url, headers, body, hasBody, method) {
    const others = {};
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() !== "content-type") others[k] = headers[k]; });
    let s = "import kong.unirest.HttpResponse;\nimport kong.unirest.Unirest;\n\n";
    s += "public class Main {\n  public static void main(String[] args) {\n";
    s += "    HttpResponse<String> response = Unirest." + method.toLowerCase() + "(" + javaStr(url) + ")\n";
    Object.keys(others).forEach(function (k) { s += "      .header(" + javaStr(k) + ", " + javaStr(others[k]) + ")\n"; });
    if (hasBody) s += "      .body(" + javaStr(body) + ")\n";
    s += "      .asString();\n\n    System.out.println(response.getBody());\n  }\n}\n";
    return s;
  }
  function apiCodeJquery(url, headers, body, hasBody, method) {
    let s = "const settings = {\n";
    s += '  "async": true,\n  "crossDomain": true,\n';
    s += '  "url": ' + JSON.stringify(url) + ",\n";
    s += '  "method": "' + method + '",\n';
    s += '  "headers": ' + jsDict(headers);
    if (hasBody) s += ',\n  "data": ' + JSON.stringify(body);
    s += "\n};\n\n$.ajax(settings).done(function (response) {\n  console.log(response);\n});\n";
    return s;
  }
  function apiCodeXhr(url, headers, body, hasBody, method) {
    let s = hasBody ? "const data = " + JSON.stringify(body) + ";\n\n" : "";
    s += "const xhr = new XMLHttpRequest();\nxhr.withCredentials = true;\n\n";
    s += 'xhr.addEventListener("readystatechange", function () {\n';
    s += "  if (this.readyState === this.DONE) {\n    console.log(this.responseText);\n  }\n});\n\n";
    s += 'xhr.open("' + method + '", ' + JSON.stringify(url) + ");\n";
    Object.keys(headers).forEach(function (k) { s += "xhr.setRequestHeader(" + JSON.stringify(k) + ", " + JSON.stringify(headers[k]) + ");\n"; });
    s += "\nxhr.send(" + (hasBody ? "data" : "") + ");\n";
    return s;
  }
  function apiCodeKotlinOkhttp(url, headers, body, hasBody, method, ct) {
    const others = {};
    Object.keys(headers).forEach(function (k) { if (k.toLowerCase() !== "content-type") others[k] = headers[k]; });
    let s = "import okhttp3.MediaType.Companion.toMediaType\nimport okhttp3.OkHttpClient\nimport okhttp3.Request\nimport okhttp3.RequestBody.Companion.toRequestBody\n\n";
    s += "fun main() {\n    val client = OkHttpClient()\n\n";
    if (hasBody) s += "    val mediaType = " + kotlinStr(ct || "text/plain") + ".toMediaType()\n    val body = " + kotlinStr(body) + ".toRequestBody(mediaType)\n";
    s += "    val request = Request.Builder()\n        .url(" + kotlinStr(url) + ")\n";
    s += "        .method(" + kotlinStr(method) + ", " + (hasBody ? "body" : "null") + ")\n";
    Object.keys(others).forEach(function (k) { s += "        .addHeader(" + kotlinStr(k) + ", " + kotlinStr(others[k]) + ")\n"; });
    s += "        .build()\n\n";
    s += "    client.newCall(request).execute().use { response ->\n        println(response.body!!.string())\n    }\n}\n";
    return s;
  }
  function apiCodeLibcurl(url, headers, body, hasBody, method) {
    let s = "#include <curl/curl.h>\n\nint main(void) {\n  CURL *curl;\n  CURLcode res;\n\n";
    s += "  curl_global_init(CURL_GLOBAL_DEFAULT);\n  curl = curl_easy_init();\n  if (curl) {\n";
    s += "    struct curl_slist *headers = NULL;\n";
    Object.keys(headers).forEach(function (k) { s += "    headers = curl_slist_append(headers, " + cStr(k + ": " + headers[k]) + ");\n"; });
    s += "\n    curl_easy_setopt(curl, CURLOPT_URL, " + cStr(url) + ");\n";
    s += "    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);\n";
    s += "    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, " + cStr(method) + ");\n";
    if (hasBody) s += "    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, " + cStr(body) + ");\n";
    s += "\n    res = curl_easy_perform(curl);\n    curl_slist_free_all(headers);\n    curl_easy_cleanup(curl);\n  }\n\n";
    s += "  curl_global_cleanup();\n  return 0;\n}\n";
    return s;
  }
  function apiCodeNodeAxios(url, headers, body, hasBody, method) {
    let s = "const axios = require('axios');\n\n";
    if (hasBody) s += "let data = " + JSON.stringify(body) + ";\n\n";
    s += "const config = {\n  method: '" + method.toLowerCase() + "',\n  maxBodyLength: Infinity,\n";
    s += "  url: " + JSON.stringify(url) + ",\n  headers: " + jsDict(headers) + (hasBody ? ",\n  data: data\n" : "\n");
    s += "};\n\naxios.request(config)\n  .then((response) => {\n    console.log(JSON.stringify(response.data));\n  })\n  .catch((error) => {\n    console.log(error);\n  });\n";
    return s;
  }
  function apiCodeNodeNative(url, headers, body, hasBody, method) {
    const mod = apiUrlParts(url).scheme === "https" ? "https" : "http";
    let s = "const " + mod + " = require('" + mod + "');\n\n";
    if (hasBody) s += "let data = " + JSON.stringify(body) + ";\n\n";
    s += "const options = {\n  method: '" + method + "',\n  headers: " + jsDict(headers) + "\n};\n\n";
    s += "const req = " + mod + ".request(" + JSON.stringify(url) + ", options, (res) => {\n  let chunks = '';\n\n";
    s += "  res.on('data', (chunk) => {\n    chunks += chunk;\n  });\n\n  res.on('end', () => {\n    console.log(chunks);\n  });\n});\n\n";
    s += "req.on('error', (error) => {\n  console.error(error);\n});\n\n";
    if (hasBody) s += "req.write(data);\n";
    s += "req.end();\n";
    return s;
  }
  function apiCodeNodeRequest(url, headers, body, hasBody, method) {
    let s = "const request = require('request');\n\nconst options = {\n  method: '" + method + "',\n";
    s += "  url: " + JSON.stringify(url) + ",\n  headers: " + jsDict(headers) + (hasBody ? ",\n  body: " + JSON.stringify(body) : "") + "\n};\n\n";
    s += "request(options, function (error, response, body) {\n  if (error) throw new Error(error);\n\n  console.log(body);\n});\n";
    return s;
  }
  function apiCodeNodeUnirest(url, headers, body, hasBody, method) {
    let s = "const unirest = require('unirest');\n\n";
    s += "const req = unirest('" + method + "', " + JSON.stringify(url) + ")\n  .headers(" + jsDict(headers) + ");\n\n";
    if (hasBody) s += "req.send(" + JSON.stringify(body) + ");\n\n";
    s += "req.end(function (res) {\n  if (res.error) throw new Error(res.error);\n\n  console.log(res.body);\n});\n";
    return s;
  }
  function apiCodeObjc(url, headers, body, hasBody, method) {
    const ks = Object.keys(headers);
    let s = "#import <Foundation/Foundation.h>\n\n";
    s += "NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:" + objcStr(url) + "]\n";
    s += "  cachePolicy:NSURLRequestUseProtocolCachePolicy\n  timeoutInterval:10.0];\n";
    s += "[request setHTTPMethod:" + objcStr(method) + "];\n";
    s += "[request setAllHTTPHeaderFields:@{\n";
    s += ks.map(function (k) { return "  " + objcStr(k) + ": " + objcStr(headers[k]); }).join(",\n");
    s += "\n}];\n";
    if (hasBody) s += "[request setHTTPBody:[" + objcStr(body) + " dataUsingEncoding:NSUTF8StringEncoding]];\n";
    s += "\nNSURLSession *session = [NSURLSession sharedSession];\n";
    s += "NSURLSessionDataTask *dataTask = [session dataTaskWithRequest:request\n";
    s += '  completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {\n    if (error) {\n      NSLog(@"%@", error);\n    } else {\n      NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;\n      NSLog(@"%@", httpResponse);\n    }\n  }];\n';
    s += "[dataTask resume];\n";
    return s;
  }
  function apiCodePhpRequest2(url, headers, body, hasBody, method) {
    const M = { GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH", HEAD: "HEAD", OPTIONS: "OPTIONS" };
    let s = "<?php\nrequire_once 'HTTP/Request2.php';\n\n";
    s += "$request = new HTTP_Request2();\n";
    s += "$request->setUrl(" + phpUrl(url) + ");\n";
    s += "$request->setMethod(HTTP_Request2::METHOD_" + (M[method] || "POST") + ");\n";
    s += "$request->setConfig(['follow_redirects' => true]);\n";
    s += "$request->setHeader([\n" + Object.keys(headers).map(function (k) { return "  " + JSON.stringify(k) + " => " + phpStr(headers[k]); }).join(",\n") + "\n]);\n";
    if (hasBody) s += "$request->setBody(" + phpStr(body) + ");\n";
    s += "\ntry {\n  $response = $request->send();\n  if ($response->getStatus() == 200) {\n    echo $response->getBody();\n  } else {\n";
    s += "    echo 'Unexpected HTTP status: ' . $response->getStatus() . ' ' . $response->getReasonPhrase();\n  }\n";
    s += "} catch (HTTP_Request2_Exception $e) {\n  echo 'Error: ' . $e->getMessage();\n}\n";
    return s;
  }
  function apiCodePhpPecl(url, headers, body, hasBody, method) {
    let s = "<?php\n\n$client = new http\\Client();\n";
    s += "$request = new http\\Client\\Request(" + phpUrl(method) + ", " + phpUrl(url) + ");\n\n";
    s += "$request->setHeaders([\n" + Object.keys(headers).map(function (k) { return "  " + JSON.stringify(k) + " => " + phpStr(headers[k]); }).join(",\n") + "\n]);\n";
    if (hasBody) s += "$request->appendBody(" + phpStr(body) + ");\n";
    s += "\n$client->enqueue($request)->send();\n$response = $client->getResponse();\n\necho $response->getBody();\n";
    return s;
  }
  function apiCodeRHttr(url, headers, body, hasBody, method) {
    let s = "library(httr)\n\nurl <- " + rStr(url) + "\n\nheaders <- c(\n";
    s += Object.keys(headers).map(function (k) { return "  " + rStr(k) + " = " + rStr(headers[k]); }).join(",\n");
    s += "\n)\n";
    if (hasBody) s += "\nbody <- " + rStr(body) + "\n";
    s += "\nresponse <- VERB(" + rStr(method) + ", url" + (hasBody ? ", body = body" : "") + ", add_headers(headers))\n\n";
    s += 'content(response, "text")\n';
    return s;
  }
  function apiCodeRRcurl(url, headers, body, hasBody, method) {
    let s = "library(RCurl)\n\nheaders <- c(\n";
    s += Object.keys(headers).map(function (k) { return "  " + rStr(k) + " = " + rStr(headers[k]); }).join(",\n");
    s += "\n)\n\n";
    s += "content <- getURL(" + rStr(url) + ", httpheader = headers, customrequest = " + rStr(method);
    if (hasBody) s += ", postfields = " + rStr(body);
    s += ")\n\ncat(content)\n";
    return s;
  }
  function apiCodeRust(url, headers, body, hasBody, method) {
    const M = { GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH", HEAD: "HEAD", OPTIONS: "OPTIONS" };
    let s = "use std::error::Error;\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn Error>> {\n";
    s += "    let client = reqwest::Client::new();\n\n    let res = client\n";
    s += "        .request(reqwest::Method::" + (M[method] || "POST") + ", " + rustStr(url) + ")\n";
    Object.keys(headers).forEach(function (k) { s += "        .header(" + rustStr(k) + ", " + rustStr(headers[k]) + ")\n"; });
    if (hasBody) s += "        .body(" + rustStr(body) + ")\n";
    s += "        .send()\n        .await?;\n\n";
    s += '    println!("{}", res.text().await?);\n    Ok(())\n}\n';
    return s;
  }
  function apiCodeWget(url, headers, body, hasBody, method) {
    let s = "wget";
    if (method !== "GET") s += " \\\n  --method " + shq(method);
    s += " \\\n  --no-check-certificate";
    s += " \\\n  --timeout=0";
    Object.keys(headers).forEach(function (k) { s += " \\\n  --header " + shq(k + ": " + headers[k]); });
    if (hasBody) s += " \\\n  --body-data " + shq(body);
    s += " \\\n  --output-document \\\n  - \\\n  " + shq(url) + "\n";
    return s;
  }
  function apiCodeSwift(url, headers, body, hasBody, method) {
    let s = "import Foundation\n\nlet headers = [\n";
    s += Object.keys(headers).map(function (k) { return "  " + swiftStr(k) + ": " + swiftStr(headers[k]); }).join(",\n");
    s += "\n]\n";
    if (hasBody) s += "\nlet parameters = " + swiftStr(body) + "\nlet postData = parameters.data(using: .utf8)\n";
    s += "\nvar request = URLRequest(url: URL(string: " + swiftStr(url) + ")!, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 10.0)\n";
    s += "request.httpMethod = " + swiftStr(method) + "\n";
    s += "request.allHTTPHeaderFields = headers\n";
    if (hasBody) s += "request.httpBody = postData\n";
    s += "\nlet session = URLSession.shared\n";
    s += "let dataTask = session.dataTask(with: request as URLRequest) { (data, response, error) in\n";
    s += "  if let error = error {\n    print(error)\n  } else {\n    let httpResponse = response as? HTTPURLResponse\n    print(httpResponse)\n  }\n}\n\n";
    s += "dataTask.resume()\n";
    return s;
  }
  function apiCodeLangGet() {
    let v = null; try { v = localStorage.getItem(API_CODE_LANG_KEY); } catch (_) {}
    return (v && API_CODE_TARGETS.some(function (t) { return t.id === v; })) ? v : "curl";
  }
  function apiCodeLangSet(v) { try { localStorage.setItem(API_CODE_LANG_KEY, v); } catch (_) {} }

  /* 悬浮框：点「代码」按钮弹出，固定定位在按钮下方（右对齐）。
     只渲染一个；用 textContent 写代码（不碰 innerHTML），天然防 XSS。点外部 / Esc 关闭。 */
  let apiCodePop = null;
  function apiCodeOnDoc(e) {
    if (!apiCodePop) return;
    const t = e.target, pop = apiCodePop.pop;
    const inList = !!(apiCodePop.list && apiCodePop.list.contains(t));   // 点候选项不能先收列表，否则点不中
    if (!pop.contains(t) && !inList && !t.closest("#apiCodeBtn")) { apiCloseCode(); return; }
    if (apiCodePop.closeList && !inList && t !== apiCodePop.input) apiCodePop.closeList();
  }
  function apiCodeOnKey(e) {
    if (e.key !== "Escape") return;
    if (apiCodePop && apiCodePop.closeList && apiCodePop.closeList()) return;  // 有下拉先只关下拉，再按一次才关整框
    apiCloseCode();
  }
  function apiCloseCode() {
    if (!apiCodePop) return;
    apiCodePop.pop.remove();
    document.removeEventListener("mousedown", apiCodeOnDoc, true);
    document.removeEventListener("keydown", apiCodeOnKey, true);
    apiCodePop = null;
  }
  function apiCodeLangLabel(id) {
    for (let i = 0; i < API_CODE_TARGETS.length; i++) if (API_CODE_TARGETS[i].id === id) return API_CODE_TARGETS[i].label;
    return API_CODE_TARGETS[0].label;
  }
  function apiPaintCode(pop, tab) {
    const code = apiGenCode(pop._lang || "curl", tab.api.req);
    pop.querySelector(".api-code-body").textContent = code;
  }
  /* 语言下拉：输入框既是「当前语言」显示位，也是搜索框 —— 输入关键字按 label/id 过滤。
     列表用 position:fixed 定位在输入框正下方（fixed 不会被悬浮框的 overflow:hidden 裁掉）。
     键盘：↑↓ 移动高亮、Enter 选中、Esc 只关下拉、Tab 收起。 */
  function apiCodeLangInit(pop, tab) {
    const input = pop.querySelector(".api-code-lang-input");
    const list = pop.querySelector(".api-code-lang-list");
    let items = [], active = 0, opened = false;

    function idxOf(id) { for (let i = 0; i < API_CODE_TARGETS.length; i++) if (API_CODE_TARGETS[i].id === id) return i; return 0; }
    function browsing() { const q = input.value.trim().toLowerCase(); return !!q && q !== apiCodeLangLabel(pop._lang).toLowerCase(); }
    function paint() {
      const q = browsing() ? input.value.trim().toLowerCase() : "";
      items = q ? API_CODE_TARGETS.filter(function (t) { return t.label.toLowerCase().indexOf(q) >= 0 || t.id.indexOf(q) >= 0; })
                : API_CODE_TARGETS.slice();
      if (!q) active = idxOf(pop._lang);
      if (active >= items.length) active = Math.max(0, items.length - 1);
      list.textContent = "";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "api-code-lang-empty"; empty.textContent = "未找到匹配语言";
        list.appendChild(empty); return;
      }
      items.forEach(function (t) {
        const row = document.createElement("div");
        row.className = "api-code-lang-item" + (t.id === pop._lang ? " is-cur" : "");
        row.title = t.label;
        if (q) {
          const k = t.label.toLowerCase().indexOf(q);
          if (k >= 0) {
            row.appendChild(document.createTextNode(t.label.slice(0, k)));
            const mk = document.createElement("mark"); mk.textContent = t.label.slice(k, k + q.length);
            row.appendChild(mk);
            row.appendChild(document.createTextNode(t.label.slice(k + q.length)));
          } else row.textContent = t.label;
        } else row.textContent = t.label;
        row.addEventListener("mousedown", function (e) { e.preventDefault(); });
        row.addEventListener("mouseenter", function () { active = items.indexOf(t); mark(); });
        row.addEventListener("click", function () { pick(t.id); });
        list.appendChild(row);
      });
      mark();
    }
    function mark() {
      for (let i = 0; i < list.children.length; i++) list.children[i].classList.toggle("is-active", i === active);
      const el = list.children[active]; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function place() {
      const r = input.getBoundingClientRect();
      list.style.left = Math.round(r.left) + "px";
      list.style.width = Math.round(r.width) + "px";
      const below = window.innerHeight - r.bottom - 10, above = r.top - 10;
      if (below < 140 && above > below) { list.style.top = "auto"; list.style.bottom = Math.round(window.innerHeight - r.top + 4) + "px"; }
      else { list.style.bottom = "auto"; list.style.top = Math.round(r.bottom + 4) + "px"; }
    }
    function open() { if (!opened) { opened = true; list.hidden = false; } paint(); place(); }
    function close() {
      if (!opened) return false;
      opened = false; list.hidden = true; input.value = apiCodeLangLabel(pop._lang);
      return true;
    }
    function pick(id) { pop._lang = id; apiCodeLangSet(id); input.value = apiCodeLangLabel(id); apiPaintCode(pop, tab); close(); }

    input.value = apiCodeLangLabel(pop._lang);
    input.addEventListener("mousedown", function (e) {
      if (document.activeElement !== input) { e.preventDefault(); input.focus(); input.select(); }
      else if (!opened) input.select();
      open();
    });
    input.addEventListener("input", function () { active = 0; open(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (!opened) open(); active = Math.min(active + 1, items.length - 1); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (!opened) open(); active = Math.max(active - 1, 0); mark(); }
      else if (e.key === "Enter") { if (opened && items[active]) { e.preventDefault(); pick(items[active].id); } }
      else if (e.key === "Tab") { close(); }
    });
    input.addEventListener("blur", function () { setTimeout(function () { close(); }, 120); });
    apiCodePop.input = input;
    apiCodePop.closeList = close;
  }
  function apiToggleCode(tab) {
    if (apiCodePop && apiCodePop.tab === tab) { apiCloseCode(); return; }
    apiCloseCode();
    const btn = tab.host.querySelector("#apiCodeBtn"); if (!btn) return;
    const pop = document.createElement("div");
    pop.className = "api-code-pop";
    pop._lang = apiCodeLangGet();
    pop.innerHTML =
      '<div class="api-code-head">' +
        '<span class="api-code-title"><i class="bi bi-code"></i> 生成代码</span>' +
        '<div class="api-code-langwrap">' +
          '<i class="bi bi-search api-code-lang-ico"></i>' +
          '<input class="api-code-lang-input" type="text" spellcheck="false" autocomplete="off" placeholder="搜索语言" title="输入关键字筛选语言">' +
        "</div>" +
        '<button class="api-mini api-code-copy" title="复制代码"><i class="bi bi-clipboard"></i></button>' +
        '<button class="api-mini api-code-x" title="关闭"><i class="bi bi-x-lg"></i></button>' +
      "</div>" +
      '<div class="api-code-lang-list" hidden></div>' +
      '<pre class="api-code-body scroll-thin"></pre>';
    document.body.appendChild(pop);
    apiCodePop = { tab: tab, pop: pop, list: pop.querySelector(".api-code-lang-list"), closeList: null };
    apiCodeLangInit(pop, tab);
    const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.max(8, r.right - pw), top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + "px"; pop.style.top = top + "px";
    apiPaintCode(pop, tab);
    pop.querySelector(".api-code-copy").addEventListener("click", function () {
      const code = pop.querySelector(".api-code-body").textContent;
      apiCopy(code).then(function () { toast("代码已复制", "ok"); }).catch(function () { apiCopyFallback("复制代码", code); });
    });
    pop.querySelector(".api-code-x").addEventListener("click", apiCloseCode);
    setTimeout(function () { document.addEventListener("mousedown", apiCodeOnDoc, true); document.addEventListener("keydown", apiCodeOnKey, true); }, 0);
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
    // bulk 记录各面板（params / headers / body）是否正处在「批量编辑」纯文本模式
    if (tab.api && tab.api.hObs) { tab.api.hObs.disconnect(); }   // 重建视图前先停掉上一轮的高度观察
    apiPendReqH.delete(tab);                                     // 旧视图的「待落高度」作废，避免落到新面板上
    tab.api = { req: req, sending: false, err: "", res: null, el: null, curPane: "params", curRes: "body", bulk: {}, hObs: null, hPend: 0 };
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
          '<button class="api-mini" id="apiCodeBtn" title="生成多语言代码"><i class="bi bi-code"></i> 代码</button>' +
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
          '<div class="api-panes scroll-thin">' +
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
            // 原来也叫「原始」，和响应体里的「原始」视图撞名，改成「原始数据」（整个响应对象）
            '<button class="api-rtab" data-rt="raw" title="整个响应对象：状态码 / 响应头 / 正文文本">原始数据</button>' +
          '</div>' +
          // 响应体视图工具条（美化 / 原始 / 预览 / 可视化 + 语言 + 换行）：常驻元素，只换 innerHTML
          '<div class="api-res-view"></div>' +
          '<div class="api-res-body scroll-thin"></div>' +
        '</div>' +
      '</div>';

    tab.api.el = {
      root: h.querySelector(".api"), req: h.querySelector(".api-req"),
      method: h.querySelector(".api-method"), url: h.querySelector(".api-url"),
      panes: { params: h.querySelector('[data-p="params"]'), headers: h.querySelector('[data-p="headers"]'),
        body: h.querySelector('[data-p="body"]'), auth: h.querySelector('[data-p="auth"]') },
      res: h.querySelector(".api-res-body"), meta: h.querySelector(".api-res-meta"),
      copy: h.querySelector("#apiCopyRes"), view: h.querySelector(".api-res-view"),
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
    h.querySelector("#apiCodeBtn").addEventListener("click", function (e) { e.stopPropagation(); apiToggleCode(tab); });
    h.querySelector("#apiDupBtn").addEventListener("click", function () { const c = JSON.parse(JSON.stringify(req)); c.id = apiNewId(); c.name = req.name + " 副本"; apiAdd(c); apiRenderList(); apiOpen(c.id); toast("已另存为副本", "ok"); });
    h.querySelector("#apiCopyRes").addEventListener("click", function () { apiCopyResponse(tab); });
    h.querySelectorAll(".api-tab").forEach(function (b) { b.addEventListener("click", function () { apiShowPane(tab, b.dataset.t); }); });
    h.querySelectorAll(".api-rtab").forEach(function (b) { b.addEventListener("click", function () { apiShowRes(tab, b.dataset.rt); }); });
    apiWireResView(tab);      // 响应体视图工具条：容器常驻，只绑一次（内容由 apiPaintRes 重绘）

    apiRenderPane(tab, "params"); apiRenderPane(tab, "headers"); apiRenderPane(tab, "body"); apiRenderPane(tab, "auth");
    // 刷新 / 重开标签后接上上次看的页签（请求区 + 响应区），和高度一样属于工具级偏好
    apiShowPane(tab, apiPrefGet(API_PANE_KEY, API_PANES, "params"));
    apiShowRes(tab, apiPrefGet(API_RTAB_KEY, API_RTABS, "body"));
    apiWireResize(tab);        // 响应状态栏可上下拖动：调整请求区 / 响应区的高度
  }

  /* ---------------- 请求区 / 响应区高度（拖动响应状态栏） ----------------
     默认两块都由内容撑开（请求头表格限 6 行高）；一旦拖动过，就给请求区锁定像素高度，
     响应区吃掉剩下的空间。高度存在 localStorage，换请求、重开标签页后都保持。 */
  function apiSavedReqH() {
    const v = parseInt(localStorage.getItem(API_REQ_H_KEY) || "0", 10);
    return (v > 0) ? v : 0;
  }
  /* 收敛并落到 DOM：上限 =「面板高 - 响应区最小高度」，所以永远挤不没响应区。
     面板还没排版时（标签未激活 / 隐藏中，clientHeight 为 0）直接放弃，绝不能拿 0 去收敛 ——
     那样会被压成最小高度，刷新后拖好的「位置」就丢了（见 apiRestoreReqH）。 */
  function apiApplyReqH(tab, h) {
    const el = tab.api && tab.api.el;
    if (!el || !el.req || !el.root || !el.req.isConnected) return 0;
    const avail = el.root.clientHeight || 0;
    if (avail <= 0) return 0;                            // 量不到尺寸：先不应用，等有高度再来
    const max = Math.max(API_REQ_MIN_H, avail - API_RES_MIN_H);
    const v = Math.max(API_REQ_MIN_H, Math.min(max, Math.round(h)));
    el.req.classList.add("fixed");
    el.req.style.height = v + "px";
    return v;
  }
  /* 复原上次拖出来的高度。视图是在 activate 之前构建的（那时 .cm-host 还是 display:none），
     当场量不到高度，所以先挂进「等待队列」，等标签被激活（apiSyncOpenMarks 会被调用）或
     ResizeObserver 发现它终于有尺寸时再落；落成功就出队。 */
  const apiPendReqH = new Set();
  function apiFlushReqH() {
    if (!apiPendReqH.size) return;
    apiPendReqH.forEach(function (tab) {
      const el = tab.api && tab.api.el;
      if (!el || !el.req) { apiPendReqH.delete(tab); return; }          // 视图已重建：旧状态作废
      const h = apiSavedReqH() || tab.api.hPend || 0;
      if (apiApplyReqH(tab, h)) apiPendReqH.delete(tab);
    });
  }
  function apiRestoreReqH(tab) {
    if (tab.api.hObs) { tab.api.hObs.disconnect(); tab.api.hObs = null; }
    const saved = apiSavedReqH();
    if (!saved) { apiPendReqH.delete(tab); return; }     // 从没拖过：保持内容撑开的默认布局
    if (apiApplyReqH(tab, saved)) { apiPendReqH.delete(tab); return; }
    tab.api.hPend = saved;                               // 记下待落的高度，等标签显示出来
    apiPendReqH.add(tab);
    if (typeof ResizeObserver !== "function") return;    // 没有 RO 就只靠 activate 时的 flush
    const ob = new ResizeObserver(function () {
      apiFlushReqH();
      if (!apiPendReqH.has(tab)) { ob.disconnect(); tab.api.hObs = null; }
    });
    tab.api.hObs = ob;
    ob.observe(tab.api.el.root);
  }
  function apiResetReqH(tab) {
    const el = tab.api && tab.api.el; if (!el || !el.req) return;
    if (tab.api.hObs) { tab.api.hObs.disconnect(); tab.api.hObs = null; }
    apiPendReqH.delete(tab); tab.api.hPend = 0;
    el.req.classList.remove("fixed");
    el.req.style.height = "";
    try { localStorage.removeItem(API_REQ_H_KEY); } catch (_) {}
  }
  function apiWireResize(tab) {
    const el = tab.api.el, head = tab.host.querySelector(".api-res-head");
    if (!head || !el.req) return;
    head.title = "按住上下拖动，调整请求区 / 响应区高度（双击恢复默认）";
    apiRestoreReqH(tab);                                // 重绘后接上上次拖出来的高度
    let dragging = false, startY = 0, startH = 0;
    const onMove = function (e) {
      if (!dragging) return;
      apiApplyReqH(tab, startH + (e.clientY - startY));   // 鼠标往哪移，这条分界线就跟到哪（跟手）
    };
    const onUp = function () {
      if (!dragging) return;
      dragging = false;
      head.classList.remove("dragging");
      document.body.classList.remove("resizing-v");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // 存收敛后的真实高度；下次应用时还会再收敛一次，窗口更小也不会越界
      try { localStorage.setItem(API_REQ_H_KEY, String(parseInt(el.req.style.height || "0", 10) || 0)); } catch (_) {}
    };
    head.addEventListener("mousedown", function (e) {
      if (e.target.closest("button")) return;             // 「复制响应体」按钮照常可点
      e.preventDefault();                                 // 免得拖动时把状态文字选蓝
      dragging = true;
      startY = e.clientY;
      startH = el.req.getBoundingClientRect().height || 0;
      head.classList.add("dragging");
      document.body.classList.add("resizing-v");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    head.addEventListener("dblclick", function (e) {
      if (!e.target.closest("button")) apiResetReqH(tab);  // 双击恢复默认高度
    });
  }
  /* 窗口变小：已锁定的请求区跟着收敛，否则会把响应区挤到看不见 */
  let apiRszRaf = 0;
  window.addEventListener("resize", function () {
    if (apiRszRaf) return;
    apiRszRaf = requestAnimationFrame(function () {
      apiRszRaf = 0;
      document.querySelectorAll(".api .api-req.fixed").forEach(function (reqEl) {
        const apiEl = reqEl.closest(".api"); if (!apiEl) return;
        const max = Math.max(API_REQ_MIN_H, apiEl.clientHeight - API_RES_MIN_H);
        const h = parseInt(reqEl.style.height || "0", 10) || API_REQ_MIN_H;
        reqEl.style.height = Math.max(API_REQ_MIN_H, Math.min(max, h)) + "px";
      });
    });
  });
/*__APPEND__*/
  /* 工具级「视图偏好」读写：值必须在白名单里才认，脏数据一律回默认值 */
  function apiPrefGet(key, allowed, dft) {
    let v = null; try { v = localStorage.getItem(key); } catch (_) {}
    return (v && allowed.indexOf(v) >= 0) ? v : dft;
  }
  function apiPrefSet(key, v) { try { localStorage.setItem(key, v); } catch (_) {} }

  function apiShowPane(tab, t) {
    tab.api.curPane = t;
    apiPrefSet(API_PANE_KEY, t);            // 记住看的是哪一页：刷新 / 重开请求后回到同一页
    tab.host.querySelectorAll(".api-tab").forEach(function (b) { b.classList.toggle("active", b.dataset.t === t); });
    tab.host.querySelectorAll(".api-pane").forEach(function (p) {
      const on = p.dataset.p === t;
      p.classList.toggle("active", on);      // 配合 CSS .api-pane.active{display:block}，否则内联置空会回落到 display:none
      p.style.display = on ? "" : "none";
    });
  }
  function apiShowRes(tab, t) {
    tab.api.curRes = t;
    apiPrefSet(API_RTAB_KEY, t);
    tab.host.querySelectorAll(".api-rtab").forEach(function (b) { b.classList.toggle("active", b.dataset.rt === t); });
    apiPaintRes(tab);
  }
  function apiKvHtml(rows) {
    const body = (rows || []).map(function (r, i) {
      return '<tr data-i="' + i + '">' +
        '<td class="api-kv-c"><input type="checkbox" data-f="on"' + (r.on ? " checked" : "") + '></td>' +
        '<td><input class="api-kv-k" data-f="k" placeholder="名称" value="' + apiAttr(r.k) + '"></td>' +
        '<td><input class="api-kv-v" data-f="v" placeholder="值" value="' + apiAttr(r.v) + '"></td>' +
        // 注释列：纯备注，data-f="desc" 让 apiWireKv 的通用 input 处理直接落到 row.desc
        '<td><input class="api-kv-d" data-f="desc" placeholder="说明（可选）" value="' + apiAttr(r.desc || "") + '"></td>' +
        '<td class="api-kv-x"><button class="api-kv-del" title="删除"><i class="bi bi-x-lg"></i></button></td>' +
        '</tr>';
    }).join("");
    // 表格外面套一层限高容器：最多显示 6 行数据（表头吸顶），更多行用内部滚动条查看（见 CSS .api-kv-wrap）
    return '<div class="api-kv-bar"><span class="api-kv-hint">勾选的行才会随请求发出</span>' +
        '<button class="api-mini api-bulk" title="把整张表当纯文本编辑：每行一条「名称: 值」">批量编辑</button></div>' +
      '<div class="api-kv-wrap scroll-thin"><table class="api-kv">' +
        '<thead><tr><th class="api-kv-c"></th><th class="api-kvh-k">名称</th><th class="api-kvh-v">值</th>' +
        '<th class="api-kvh-d">注释</th><th class="api-kv-x"></th></tr></thead>' +
        '<tbody>' + (body || "") + '</tbody></table></div>' +
      '<button class="api-add"><i class="bi bi-plus-lg"></i> 添加一行</button>';
  }
  /* ---------------- 批量编辑（对标 Postman 的 Bulk Edit） ----------------
     把整张表当纯文本改：每行一条「名称: 值」，也接受「名称=值」，空行忽略。
     每行只认第一个分隔符，所以值里带 : 或 = （URL、时间戳等）不会被切错。 */
  function apiKvToText(rows) {
    return (rows || []).filter(function (r) {
      return (r.k || "").trim() || (r.v || "").trim();      // 完全空白的行不写进去
    }).map(function (r) {
      return (r.k || "") + ": " + (r.v || "");
    }).join("\n");
  }
  function apiKvFromText(text) {
    const out = [];
    String(text == null ? "" : text).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      let at = -1;
      for (let i = 0; i < line.length; i++) { if (line[i] === ":" || line[i] === "=") { at = i; break; } }
      if (at < 0) out.push(apiRow(line.trim(), ""));
      else out.push(apiRow(line.slice(0, at).trim(), line.slice(at + 1).trim()));
    });
    return out;
  }
  /* 写回表格：原地替换数组内容（保持引用不变，面板与事件委托都拿着这个数组）。
     按名称从旧行继承「勾选状态」和「注释」—— 注释列没出现在纯文本里，
     不继承的话用户一批量编辑就会把注释全丢掉。 */
  function apiKvApplyText(rows, text) {
    const pool = (rows || []).slice();
    const next = apiKvFromText(text).map(function (p) {
      let hit = -1;
      for (let i = 0; i < pool.length; i++) { if (pool[i] && pool[i].k === p.k) { hit = i; break; } }
      const old = hit >= 0 ? pool.splice(hit, 1)[0] : null;
      return { on: old ? old.on : true, k: p.k, v: p.v, desc: old ? (old.desc || "") : "" };
    });
    rows.length = 0;
    next.forEach(function (r) { rows.push(r); });
  }
  function apiKvBulkHtml() {
    return '<div class="api-kv-bar"><span class="api-kv-hint">每行一条「名称: 值」（也支持 名称=值），空行忽略</span>' +
        '<button class="api-mini api-bulk" title="把文本写回表格（Esc 也可以）">完成</button></div>' +
      '<textarea class="api-kv-bulk scroll-thin" spellcheck="false" placeholder="Accept: application/json&#10;Content-Type: application/json"></textarea>';
  }
  /* 渲染一张 kv 表：正常模式 = 表格，批量编辑模式 = 纯文本。两种模式只换 innerHTML，委托照旧绑在 list 上 */
  function apiRenderKv(tab, list, rows, pane) {
    const bulk = !!(tab.api.bulk && tab.api.bulk[pane]);
    list.innerHTML = bulk ? apiKvBulkHtml() : apiKvHtml(rows);
    if (bulk) {
      const ta = list.querySelector(".api-kv-bulk");
      if (ta) {
        ta.value = apiKvToText(rows);
        ta.addEventListener("keydown", function (e) {
          e.stopPropagation();                                // 免得被全局快捷键接走
          if (e.key === "Escape") { e.preventDefault(); apiKvEndBulk(tab, rows, pane); }
        });
      }
    }
    apiWireKv(tab, list, rows, pane);
  }
  function apiKvBeginBulk(tab, pane) {
    tab.api.bulk = tab.api.bulk || {};
    tab.api.bulk[pane] = true;
    apiRenderPane(tab, pane);
    const ta = tab.api.el.panes[pane].querySelector(".api-kv-bulk");
    if (ta) { ta.focus(); const n = ta.value.length; try { ta.setSelectionRange(n, n); } catch (_) {} }
  }
  function apiKvEndBulk(tab, rows, pane) {
    const box = tab.api.el.panes[pane];
    const ta = box ? box.querySelector(".api-kv-bulk") : null;
    if (ta) apiKvApplyText(rows, ta.value);
    if (tab.api.bulk) tab.api.bulk[pane] = false;
    apiPersist();
    apiRenderPane(tab, pane);                               // 重绘回表格（里面会刷新徽标）
  }
  /* 「参数 / 请求头 / 表单」表格的事件委托。
     注意这些容器是「建一次、内容反复重绘」的常驻元素（.api-pane 本身不重建，只换 innerHTML），
     所以事件只能绑一次：若每次重绘都 addEventListener，点一次「添加一行」会同时触发 N 个
     处理函数（N = 之前重绘过几次），表现为一次加出好几行；「删除」更糟，一次会 splice 掉 N 行。
     数组本身每次重绘都可能换新引用，因此把它挂在容器上、在事件里现取，而不是闭包死。 */
  function apiWireKv(tab, list, rows, pane) {
    list._apiRows = rows;                       // 每次重绘刷新引用
    if (list._apiWired === pane) return;        // 同一容器同一面板只绑一次
    list._apiWired = pane;
    list.addEventListener("input", function (e) {
      const tr = e.target.closest("tr"); if (!tr) return;
      const arr = list._apiRows; if (!arr) return;
      const i = +tr.dataset.i, f = e.target.dataset.f; if (arr[i] == null) return;
      if (f === "on") arr[i].on = e.target.checked; else arr[i][f] = e.target.value;
      apiPersist(); apiUpdateBadges(tab);
    });
    list.addEventListener("click", function (e) {
      const arr = list._apiRows; if (!arr) return;
      // 「批量编辑」是来回切换：进表格前把文本写回数组，进文本前把数组序列化成文本
      if (e.target.closest(".api-bulk")) {
        if (tab.api.bulk && tab.api.bulk[pane]) apiKvEndBulk(tab, arr, pane);
        else apiKvBeginBulk(tab, pane);
        return;
      }
      const tr = e.target.closest("tr");
      // 重绘目标必须是「这张表所在的面板」：原先写死成 headers，导致在「参数」里增删行时
      // 重绘的是隐藏的 headers 面板，参数面板还留着已删除的旧行
      if (e.target.closest(".api-kv-del")) { if (tr) arr.splice(+tr.dataset.i, 1); apiRenderPane(tab, pane); apiPersist(); return; }
      if (e.target.closest(".api-add")) { arr.push(apiRow("", "")); apiRenderPane(tab, pane); apiPersist(); }
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
    if (t === "params") apiRenderKv(tab, box, req.params, "params");
    else if (t === "headers") apiRenderKv(tab, box, req.headers, "headers");
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
      // 表单面板也是同一张 kv 表（含「注释」列和「批量编辑」）；容器是每次新建的 .api-form
      if (b.mode === "form") apiRenderKv(tab, box.querySelector(".api-form"), b.form, "body");
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
      const payload = { method: req.method, url: url, headers: headers,
        body: (req.method === "GET" || req.method === "HEAD") ? "" : body,
        timeout: 30, followRedirects: true, verifySsl: true };
      // 设置 → 网络/代理 里勾了「「API 调试」也走此代理」→ 套用同一套代理与出站策略
      if (typeof IDE_SETTINGS !== "undefined" && typeof httpProxySettings === "function") {
        const cfg = httpProxySettings();
        // 网站过滤属于全局策略：不受「API 调试也走此代理」开关影响，始终生效
        payload.filterMode = cfg.filterMode; payload.filterList = cfg.filterList;
        // 代理与出站策略只在开关打开时套用
        if (IDE_SETTINGS.httpForApiDebug) {
          payload.mode = cfg.mode; payload.proxy = cfg.proxy; payload.noProxy = cfg.noProxy;
          payload.timeout = cfg.timeout; payload.verifySsl = !cfg.insecure;
        }
      }
      const res = await fetch("/api/http/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
  /* ---------------- 响应体视图（美化 / 原始 / 预览 / 可视化） ----------------
     这组偏好是整个「工具」级的，不跟着请求走：选了「原始」再切到别的接口也还是原始（与 Postman 一致），
     所以放模块变量 + localStorage，而不是塞进单个请求对象里。 */
  function apiResView() {
    if (API_RES_VIEW) return API_RES_VIEW;
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(API_RES_VIEW_KEY) || "null"); } catch (_) { raw = null; }
    if (!raw || typeof raw !== "object") raw = {};
    API_RES_VIEW = {
      view: API_RES_VIEWS.indexOf(raw.view) >= 0 ? raw.view : "pretty",
      lang: API_RES_LANGS.indexOf(raw.lang) >= 0 ? raw.lang : "auto",
      wrap: raw.wrap !== false,        // 默认打开自动换行：与改造前 .api-pre 的 pre-wrap 表现一致
    };
    return API_RES_VIEW;
  }
  function apiSaveResView() { try { localStorage.setItem(API_RES_VIEW_KEY, JSON.stringify(API_RES_VIEW || {})); } catch (_) {} }

  /* 响应文本：二进制（base64）没有文本可读，一律当空串 */
  function apiResText(r) { return (r && r.encoding !== "base64" && typeof r.text === "string") ? r.text : ""; }
  /* 解析成 JSON（null = 不是 JSON）。缓存挂在 WeakMap 上而不是响应对象上，
     否则「原始数据」视图 stringify 整个响应时会多出一个 __json 字段。 */
  const API_JSON_CACHE = new WeakMap();
  function apiResJson(r) {
    if (!r || r.encoding === "base64") return null;
    let hit = API_JSON_CACHE.get(r);
    if (hit === undefined) {
      hit = { v: null };
      try { hit.v = JSON.parse(r.text || ""); } catch (_) { hit.v = null; }
      API_JSON_CACHE.set(r, hit);
    }
    return hit.v;
  }
  /* 语言：先看 Content-Type，再嗅探正文开头 —— 很多接口不带 content-type，或者一律写成 text/plain */
  function apiResLang(r) {
    const ct = String((r && r.content_type) || "").toLowerCase();
    if (/json/.test(ct)) return "json";
    if (/html/.test(ct)) return "html";
    if (/xml|svg/.test(ct)) return "xml";
    if (/javascript|ecmascript/.test(ct)) return "javascript";
    // text/* 不在这里直接下结论：text/plain 里塞 JSON 的接口太多了，继续往下嗅探正文，
    // 什么都不像时最后自然会落到 "text"
    const s = apiResText(r).replace(/^\uFEFF/, "").trim();
    if (!s) return "text";
    if (/^<\?xml/i.test(s)) return "xml";
    if (/^(<!doctype\s+html|<html)/i.test(s)) return "html";
    if (/^[\[{]/.test(s)) { try { JSON.parse(s); return "json"; } catch (_) { return "text"; } }
    if (/^<[a-z!/?]/i.test(s)) return "xml";
    return "text";
  }
  function apiLangName(l) { return ({ json: "JSON", xml: "XML", html: "HTML", javascript: "JavaScript", text: "纯文本" })[l] || "纯文本"; }
  function apiResLangUsed(r) { const V = apiResView(); return V.lang === "auto" ? apiResLang(r) : V.lang; }

  /* 语法高亮：一律「在原串上切词、再逐段转义」。
     不能先 esc 再拿正则匹配字符串 —— 转义会把 " 变成 &quot;，字符串就再也匹配不上（表现为整片无颜色）。 */
  const API_HL_JSON = /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}\[\],:])/g;
  const API_HL_JS = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(-?\b\d+(?:\.\d+)?\b)|\b(var|let|const|function|return|if|else|for|while|new|class|this|typeof|try|catch|finally|throw|async|await|yield|null|undefined|true|false)\b/g;
  const API_HL_XML = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][\w:.-]*|<![A-Za-z][^>]*>|<\?)|([A-Za-z_:][\w:.-]*)(=)("(?:[^"]*)"|'(?:[^']*)')|(\/?>)/g;

  /* 逐段拼接：匹配之外的部分也要 esc，否则正文里的 < 会被浏览器当成标签 */
  function apiHlRun(src, re, pick) {
    let out = "", last = 0, m;
    re.lastIndex = 0;                                   // 正则带 g，是共享的，每次用前必须归零
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) out += esc(src.slice(last, m.index));
      out += pick(m);
      last = m.index + m[0].length;
      if (m[0] === "") re.lastIndex++;                  // 零宽匹配兜底，否则死循环
    }
    return out + esc(src.slice(last));
  }
  function apiHlJson(src) {
    return apiHlRun(src, API_HL_JSON, function (m) {
      if (m[1] != null) return '<span class="api-tk-k">' + esc(m[1]) + "</span>" + esc(m[2] || "");
      if (m[3] != null) return '<span class="api-tk-s">' + esc(m[3]) + "</span>";
      if (m[4] != null) return '<span class="api-tk-n">' + esc(m[4]) + "</span>";
      if (m[5] != null) return '<span class="api-tk-l">' + esc(m[5]) + "</span>";
      return '<span class="api-tk-p">' + esc(m[6] == null ? m[0] : m[6]) + "</span>";
    });
  }
  function apiHlJs(src) {
    return apiHlRun(src, API_HL_JS, function (m) {
      if (m[1] != null) return '<span class="api-tk-c">' + esc(m[1]) + "</span>";
      if (m[2] != null) return '<span class="api-tk-s">' + esc(m[2]) + "</span>";
      if (m[3] != null) return '<span class="api-tk-n">' + esc(m[3]) + "</span>";
      return '<span class="api-tk-l">' + esc(m[4] == null ? m[0] : m[4]) + "</span>";
    });
  }
  function apiHlXml(src) {
    return apiHlRun(src, API_HL_XML, function (m) {
      if (m[1] != null) return '<span class="api-tk-c">' + esc(m[1]) + "</span>";
      if (m[2] != null) return '<span class="api-tk-t">' + esc(m[2]) + "</span>";
      if (m[3] != null) return '<span class="api-tk-a">' + esc(m[3]) + "</span>" + esc(m[4] || "") +
        '<span class="api-tk-s">' + esc(m[5] || "") + "</span>";
      return '<span class="api-tk-p">' + esc(m[6] == null ? m[0] : m[6]) + "</span>";
    });
  }
  function apiHl(src, lang) {
    if (lang === "json") return apiHlJson(src);
    if (lang === "html" || lang === "xml") return apiHlXml(src);
    if (lang === "javascript") return apiHlJs(src);
    return esc(src);
  }
  /* JSON 可折叠树（美化视图专用）：对象/数组带 ▾/▸ 折叠按钮，数组/对象后面标项数。
     节点超过 8000 个时返回 null 退回静态高亮 —— 几万项全展开成 DOM 会把页面卡死 */
  function apiJsonTreeHtml(v) {
    var budget = { n: 0 };
    function prim(x) {
      if (x === null) return '<span class="api-tk-l">null</span>';
      var t = typeof x;
      if (t === "string") return '<span class="api-tk-s">' + esc(JSON.stringify(x)) + "</span>";
      if (t === "number") return '<span class="api-tk-n">' + esc(String(x)) + "</span>";
      return '<span class="api-tk-l">' + (x ? "true" : "false") + "</span>";
    }
    function node(x, key) {
      if (++budget.n > 8000) throw "too-big";
      var head = key === undefined ? "" :
        '<span class="api-tk-k">"' + esc(key) + '"</span><span class="api-tk-p">: </span>';
      if (x === null || typeof x !== "object")
        return '<div class="api-jline"><span class="api-jtog none"></span>' + head + prim(x) + "</div>";
      var isArr = Array.isArray(x), len = x.length || Object.keys(x).length;
      if (!len) return '<div class="api-jline"><span class="api-jtog none"></span>' + head +
        '<span class="api-tk-p">' + (isArr ? "[]" : "{}") + "</span></div>";
      var kids = "", k;
      if (isArr) for (var i = 0; i < len; i++) kids += node(x[i], undefined);
      else for (k in x) if (Object.prototype.hasOwnProperty.call(x, k)) kids += node(x[k], k);
      return '<div class="api-jnode"><div class="api-jline">' +
        '<span class="api-jtog" title="折叠 / 展开"></span>' + head +
        '<span class="api-tk-p">' + (isArr ? "[" : "{") + '</span><span class="api-jmeta">' +
        len + (isArr ? " 项" : " 键") + '</span><span class="api-jfold">… </span></div>' +
        '<div class="api-jkids">' + kids + "</div>" +
        '<div class="api-jline api-jend"><span class="api-tk-p">' + (isArr ? "]" : "}") + "</span></div></div>";
    }
    try { return node(v, undefined); } catch (_) { return null; }
  }
  /* 美化：JSON 重新缩进；其它语言只上色不重排 —— HTML/XML 自动缩进会把内联文本拆得面目全非，
     与其给一份看着像坏了的排版，不如老实按原文显示 */
  function apiResPrettyText(r, lang) {
    if (lang === "json") {
      const v = apiResJson(r);
      if (v !== null) { try { return JSON.stringify(v, null, 2); } catch (_) {} }
    }
    return apiResText(r);
  }

  /* 预览：图片直接 img，其余（HTML / XML / SVG）丢进沙箱 iframe。
     沙箱刻意不给 allow-scripts：响应内容是外部来的，而这个应用自带本地文件接口，
     让预览页能发请求等于开了个后门；纯静态页面（绝大多数预览场景）照常显示。 */
  function apiResPreviewOk(r) {
    if (!r) return false;
    const base = String(r.content_type || "").split(";")[0].trim().toLowerCase();
    if (r.encoding === "base64") return base.indexOf("image/") === 0;
    return /html|xml|svg/.test(base) && !/json/.test(base);
  }
  function apiResPreviewHtml(r) {
    const ct = String(r.content_type || "");
    if (r.encoding === "base64") return '<img class="api-img" src="data:' + apiAttr(ct) + ";base64," + apiAttr(r.body_b64 || "") + '">';
    return '<iframe class="api-prev" sandbox referrerpolicy="no-referrer" srcdoc="' + apiAttr(r.text || "") + '"></iframe>';
  }

  /* 可视化：把 JSON 自动摆成表格 —— 对象数组 → 多列，对象 → 名称/值，数组 → 一列 */
  const API_VZ_LIMIT = 500;      // 最多渲染 500 行：几万行全塞进 DOM 会直接把页面卡死
  function apiVzCell(x) {
    if (x === undefined) return "";
    if (x === null) return '<span class="api-tk-l">null</span>';
    if (typeof x === "object") return esc(JSON.stringify(x));
    return esc(String(x));
  }
  function apiVzTable(headHtml, rowsHtml, total) {
    const note = total > API_VZ_LIMIT
      ? '<div class="api-vz-note">只渲染前 ' + API_VZ_LIMIT + " 行，共 " + total + " 行</div>" : "";
    return '<table class="api-vz">' + headHtml + "<tbody>" + rowsHtml.join("") + "</tbody></table>" + note;
  }
  function apiResVisualHtml(r) {
    const v = apiResJson(r);
    if (v === null) return '<div class="api-res-hint">这个响应不是 JSON，没法做成表格。</div>';
    const head = function (cells) {
      return "<thead><tr>" + cells.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr></thead>";
    };
    const idx = '<span class="api-vz-i">#</span>';
    if (Array.isArray(v)) {
      const objs = v.length > 0 && v.every(function (x) { return x && typeof x === "object" && !Array.isArray(x); });
      if (objs) {
        const cols = [];
        v.forEach(function (o) { Object.keys(o).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
        return apiVzTable(head([idx].concat(cols.map(function (c) { return esc(c); }))),
          v.slice(0, API_VZ_LIMIT).map(function (o, i) {
            return '<tr><td class="api-vz-i">' + (i + 1) + "</td>" +
              cols.map(function (c) { return "<td>" + apiVzCell(o[c]) + "</td>"; }).join("") + "</tr>";
          }), v.length);
      }
      return apiVzTable(head([idx, "值"]),
        v.slice(0, API_VZ_LIMIT).map(function (x, i) {
          return '<tr><td class="api-vz-i">' + (i + 1) + "</td><td>" + apiVzCell(x) + "</td></tr>";
        }), v.length);
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      return apiVzTable(head(["名称", "值"]), keys.slice(0, API_VZ_LIMIT).map(function (k) {
        return '<tr><td class="api-vz-k">' + esc(k) + "</td><td>" + apiVzCell(v[k]) + "</td></tr>";
      }), keys.length);
    }
    return apiVzTable(head(["值"]), ["<tr><td>" + apiVzCell(v) + "</td></tr>"], 1);
  }

  /* 工具条：美化 / 原始 / 预览 / 可视化 + 语言下拉 + 自动换行。
     用不上的视图置灰（和 Postman 一样），并把原因挂在 title 上 —— 灰按钮本身不触发悬停，
     所以提示写在外层 span 上。 */
  function apiPaintResView(tab, r, eff) {
    const el = tab.api.el, V = apiResView();
    if (!el.view) return;      // 老 DOM（理论上不会有）时别把整个响应区带崩
    const LANGS = [["auto", "自动"], ["json", "JSON"], ["xml", "XML"], ["html", "HTML"], ["javascript", "JavaScript"], ["text", "纯文本"]];
    const btn = function (id, label, why) {
      const cls = "api-rview" + (eff === id ? " active" : "");
      if (!why) return '<button class="' + cls + '" data-v="' + id + '">' + label + "</button>";
      return '<span class="api-rview-off" title="' + apiAttr(why) + '">' +
        '<button class="' + cls + '" data-v="' + id + '" disabled>' + label + "</button></span>";
    };
    el.view.innerHTML =
      '<div class="api-rviews">' +
        btn("pretty", "美化") + btn("raw", "原始") +
        btn("preview", "预览", apiResPreviewOk(r) ? "" : "只能预览 HTML / XML / SVG 或图片响应") +
        btn("visualize", "可视化", apiResJson(r) !== null ? "" : "只能把 JSON 响应渲染成表格") +
      "</div>" +
      '<select class="api-res-lang" title="语法语言（自动 = 按 Content-Type 识别）">' +
        LANGS.map(function (p) {
          return '<option value="' + p[0] + '"' + (V.lang === p[0] ? " selected" : "") + ">" + p[1] +
            (p[0] === "auto" ? " · " + apiLangName(apiResLang(r)) : "") + "</option>";
        }).join("") +
      "</select>" +
      '<button class="api-mini api-wrapbtn' + (V.wrap ? " active" : "") + '" title="自动换行：' +
        (V.wrap ? "已开启（点击关闭）" : "已关闭（点击开启）") + '"><i class="bi bi-text-wrap"></i></button>';
    el.view.classList.add("on");
  }
  function apiHideResView(el) { if (el && el.view) { el.view.classList.remove("on"); el.view.innerHTML = ""; } }

  /* 响应体入口：四个视图走同一条路。
     eff = 本次真正生效的视图：偏好里的视图在当前响应上用不了（比如「预览」碰上 JSON）就退回美化，
     只影响这一次渲染，用户的选择本身不动 —— 换回能预览的响应还是预览。 */
  function apiPaintBody(tab, r, sizeTxt) {
    const el = tab.api.el, V = apiResView();
    const usable = function (v) { return v === "preview" ? apiResPreviewOk(r) : (v === "visualize" ? apiResJson(r) !== null : true); };
    const eff = usable(V.view) ? V.view : "pretty";
    apiPaintResView(tab, r, eff);
    if (eff === "preview") { el.res.innerHTML = apiResPreviewHtml(r); return; }
    if (eff === "visualize") { el.res.innerHTML = apiResVisualHtml(r); return; }
    if (r.encoding === "base64") {          // 二进制又没有可预览的形态：只能给下载
      const base = String(r.content_type || "").split(";")[0].trim().toLowerCase();
      el.res.innerHTML = '<div class="api-res-hint">二进制响应（' + esc(r.content_type || "?") + "，" + sizeTxt +
        '）。<button class="api-mini" id="apiDl">下载</button></div>';
      const dl = el.res.querySelector("#apiDl");
      if (dl) dl.addEventListener("click", function () { apiDownload(tab, base); });
      return;
    }
    const lang = apiResLangUsed(r);
    if (eff === "pretty" && lang === "json" && apiResJson(r) !== null) {
      const tree = apiJsonTreeHtml(apiResJson(r));
      if (tree) {
        if (!el.res._apiJWired) {       // 折叠按钮点击委托：容器常驻，只绑一次
          el.res._apiJWired = true;
          el.res.addEventListener("click", function (e) {
            const tg = e.target.closest(".api-jtog");
            if (!tg || tg.classList.contains("none")) return;
            const nd = tg.closest(".api-jnode");
            if (nd) nd.classList.toggle("api-jclosed");
          });
        }
        el.res.innerHTML = '<div class="api-json">' + tree + "</div>";
        return;
      }
    }
    const text = eff === "raw" ? apiResText(r) : apiResPrettyText(r, lang);
    el.res.innerHTML = '<pre class="api-pre' + (V.wrap ? "" : " api-pre-nowrap") + '">' +
      (eff === "raw" ? esc(text) : apiHl(text, lang)) + "</pre>";
  }
  /* 视图工具条事件：容器常驻、内容反复重绘，所以只绑一次 + 委托（同 apiWireKv 的道理） */
  function apiWireResView(tab) {
    const el = tab.api.el; if (!el || !el.view || el.view._apiWired) return;
    el.view._apiWired = true;
    el.view.addEventListener("click", function (e) {
      const V = apiResView();
      if (e.target.closest(".api-wrapbtn")) { V.wrap = !V.wrap; apiSaveResView(); apiPaintRes(tab); return; }
      const b = e.target.closest(".api-rview");
      if (!b || b.disabled || b.dataset.v === V.view) return;
      V.view = b.dataset.v; apiSaveResView(); apiPaintRes(tab);
    });
    el.view.addEventListener("change", function (e) {
      if (!e.target.classList.contains("api-res-lang")) return;
      const V = apiResView(); V.lang = e.target.value; apiSaveResView(); apiPaintRes(tab);
    });
  }

  function apiPaintRes(tab) {
    const el = tab.api.el; if (!el) return;
    const r = tab.api.res, err = tab.api.err, sending = tab.api.sending;
    if (el.copy) el.copy.disabled = !!sending || !r;   // 没有响应时「复制响应体」不可点
    if (sending) { el.meta.className = "api-res-meta info"; el.meta.textContent = "发送中…"; el.res.innerHTML = '<div class="api-res-hint"><i class="bi bi-arrow-repeat pa-spin"></i> 正在发送请求</div>'; apiHideResView(el); return; }
    if (err) { el.meta.className = "api-res-meta err"; el.meta.textContent = "请求失败"; el.res.innerHTML = '<div class="api-res-err"><i class="bi bi-exclamation-triangle"></i> ' + esc(err) + '</div>'; apiHideResView(el); return; }
    if (!r) { el.meta.className = "api-res-meta"; el.meta.textContent = "尚未发送"; el.res.innerHTML = '<div class="api-res-hint">填写请求后点「发送」查看响应。</div>'; apiHideResView(el); return; }
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
      apiHideResView(el);
    } else if (rt === "raw") {
      el.res.innerHTML = '<pre class="api-pre">' + esc(JSON.stringify(r, null, 2)) + "</pre>";
      apiHideResView(el);
    } else {
      apiPaintBody(tab, r, sizeTxt);
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
      grpBtn = $("apiGroupNew"), list = $("apiList"), impFileBtn = $("apiImportFile");
    // 顶部「新建请求」建在未分组下；要在分组里新建，用分组头右侧的 +
    if (newBtn) newBtn.addEventListener("click", function () { const r = apiBlank(); apiAdd(r); apiRenderList(); apiOpen(r.id); });
    if (impBtn) impBtn.addEventListener("click", function () { apiImportCurl(); });
    if (impFileBtn) impFileBtn.addEventListener("click", function () { apiPickImportFile(); });
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
  /* ---------------- 导出 / 导入（关键字段加密） ----------------
     加密为什么放服务端：IDE 常常是以 http://<局域网IP>:端口 打开的，属于非安全上下文，
     浏览器在这种页面下不提供 crypto.subtle（同 js/24 的说明），前端做不了正经加密。
     服务端 services/common/export_crypto.py 用「口令 + 随机盐」派生密钥，
     与落库凭据同一套流加密原语（SHA256-CTR + HMAC），不依赖第三方库。
     前端这里只负责收口令、下载文件、把解出来的请求并回本机列表 ——
     「哪些字段算关键字段」只由后端 services/ide/httpexport.py 一处决定，
     免得两边各写一套规则后慢慢跑偏。 */
  const API_PW_KEY = "ide.http.expPw";      // 口令只记在 sessionStorage：关掉标签页就没了
  const API_IMPORT_MAX = 4 * 1024 * 1024;   // 本机存储只有几 MB，导太大的文件写不进去，先拦下来

  function apiPwGet() { try { return sessionStorage.getItem(API_PW_KEY) || ""; } catch (_) { return ""; } }
  function apiPwPut(v) { try { if (v) sessionStorage.setItem(API_PW_KEY, v); } catch (_) {} }

  /* 口令输入弹窗。uiModal 自带那个 input 是明文框（放密码不合适），所以自己往 html 里
     塞一个 type=password 的输入框，并用 input 事件兜住值 —— 弹窗关闭时会清空 innerHTML，
     那时再想读就读不到了。返回 null 表示用户取消，返回空串表示「就是要留空」。 */
  async function apiAskPassword(title, msg, okText, value, hint, placeholder) {
    const p = uiModal({ title: title, icon: "bi-shield-lock", okText: okText,
      html: '<div class="m-msg">' + esc(msg) + '</div>' +
        '<div class="m-row"><label>密码</label>' +
        '<input id="apiPwIn" type="password" autocomplete="new-password" spellcheck="false" placeholder="' +
        String(placeholder || "密码").replace(/"/g, "") + '">' +
        '<div class="hint">' + esc(hint || "仅用于加解密这个文件，不会写入磁盘或日志；关掉标签页即失效。") + '</div></div>' });
    const inp = $("apiPwIn");
    let buf = String(value || "");
    if (inp) {
      inp.value = buf;
      inp.addEventListener("input", function () { buf = inp.value; });
      inp.focus(); inp.select();
    }
    const ok = await p;
    return ok ? String(buf || "") : null;
  }

  async function apiPostExport(list, pw) {
    try {
      const res = await fetch("/api/http/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: list, groups: apiLoadGroups(), password: pw }),
      });
      const d = await res.json();
      return (d && typeof d === "object") ? d : { error: "服务端返回异常" };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  }

  /* 导出全部请求。两次「确认」合并成一个弹窗：既要给出加密口令，也起到原来那个二次确认的
     作用（导出按钮紧挨着「导入」，误点代价不小）。
     口令留空 = 用服务端 .env 里配的默认口令（EXPORT_PASSWORD，没配就回退 SECRET_SALT）——
     日常备份不用记口令，本机导入时也免输；填了口令则只有该口令能解开。 */
  async function apiExportAll() {
    const list = apiList();
    if (!list.length) { toast("还没有请求可导出", "warn"); return; }
    let pw = apiPwGet();                 // 上次这个标签页里输过的口令，预填上省事
    let warn = "";
    for (;;) {
      const ans = await apiAskPassword("导出全部请求（关键字段加密）",
        (warn ? warn + "\n\n" : "") +
        "将把本机保存的 " + list.length + " 个请求导出为 JSON 文件「api-requests.json」。\n\n" +
        "会用口令加密的关键字段：\n" +
        "· 请求头 / 查询参数 / 表单 / JSON 请求体里名字含 token、secret、password、api-key、cookie 的字段\n" +
        "· Authorization 请求头，以及「认证」页签里的 token、用户名、密码\n\n" +
        "其余内容（请求名、URL、分组等）仍是明文。",
        "导出", pw,
        "留空 = 使用服务端 .env 里配置的默认口令，本机导入时免输密码；填写则导入必须输入同一密码。",
        "留空 = 用服务端默认口令");
      if (ans === null) return;                        // 取消 = 不导出
      pw = ans.trim();
      const out = await apiPostExport(list, pw);
      if (out.error) {
        // 服务端没配默认口令（.env 里 EXPORT_PASSWORD 与 SECRET_SALT 都是空的）→ 让用户补一个
        if (out.error_code === "no_default_password") {
          warn = "服务端没有配置默认口令（.env 的 EXPORT_PASSWORD / SECRET_SALT 都为空），请填写导出密码。";
          continue;
        }
        toast("导出失败：" + out.error, "err");
        return;
      }
      apiPwPut(pw);                                    // 只记非空口令；留空（走默认口令）不会覆盖已缓存的值
      const blob = new Blob([out.file], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "api-requests.json"; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      const n = (out.sensitive || []).length;
      toast("已导出 " + out.count + " 个请求" +
        (out.keySource === "default" ? "，已用服务端默认口令加密" : "，已用你设置的密码加密") +
        (n ? "（" + n + " 处关键字段）" : "（没有需要加密的关键字段）"), "ok");
      return;
    }
  }

  /* 导入：选文件 → （按需问口令）→ 后端解密并清洗 → 并回本机列表。
     默认口令加密的文件（keySource=default）先不问口令，本机多半能直接解开；
     解不开（换过 .env / 来自别的机器）再转成手输，最多手输 3 次，免得重新选文件。 */
  function apiPickImportFile() {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json"; inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (f) apiImportFile(f);
    });
    inp.click();
  }

  async function apiImportFile(file) {
    if (file.size > API_IMPORT_MAX) {
      toast("文件太大（超过 4 MB）：本机存储只有几 MB，装不下", "warn");
      return;
    }
    let text = "";
    try { text = await file.text(); } catch (e) { toast("读取文件失败", "err"); return; }
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) { toast("不是合法的 JSON 文件", "warn"); return; }
    const sealed = text.indexOf("encp:v1:") >= 0;      // 文件里有没有密文
    // 默认口令加密的文件：本机后端自己就能解开，先不问密码，省一步操作；
    // 解不开（改过 .env / 来自别的机器）时再转成手输口径。
    const isDefault = !!(payload && !Array.isArray(payload) && payload.keySource === "default");
    let pw = apiPwGet(), ask = sealed && !isDefault, tip = "", tries = 0;
    while (tries < 3) {                                // tries 只数手输次数，静默那次不算
      if (ask) {
        tries++;
        const ans = await apiAskPassword("导入加密文件",
          (tip ? tip + "\n\n" : "") + "「" + file.name + "」里的关键字段是加密的，请输入导出时用的密码。",
          "解密并导入", pw, "密码不会写入磁盘或日志；关掉标签页即失效。", "导出时设置的密码");
        if (ans === null) return;
        pw = ans.trim();
        if (!pw) { toast("请输入密码", "warn"); continue; }
      }
      const d = await apiPostImport(payload, pw);
      if (!d.error) { if (pw) apiPwPut(pw); apiMergeImported(d, file.name); return; }
      if (d.error_code !== "bad_password" || !sealed) { toast("导入失败：" + d.error, "err"); return; }
      if (!ask) {
        tip = "用服务端默认口令解不开这个文件（可能改过 .env，或文件来自别的机器），请手动输入导出时用的密码。";
        ask = true;
      } else {
        tip = "";
        toast("密码不正确，请重新输入", "warn");
      }
    }
  }

  async function apiPostImport(payload, pw) {
    try {
      const res = await fetch("/api/http/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: payload, password: pw }),
      });
      const d = await res.json();
      return (d && typeof d === "object") ? d : { error: "服务端返回异常" };
    } catch (e) { return { error: (e && e.message) || String(e) }; }
  }

  /* 并回本机列表：分组按「名字」复用（同一个文件重复导入不会攒出一堆同名分组），
     请求一律换新 id（避免与已有 id 撞车）。只追加、不覆盖 —— 导错了删掉重来即可，
     比「先清空再写入」安全得多。 */
  function apiMergeImported(d, fileName) {
    const groups = d.groups || [], reqs = d.requests || [];
    const gmap = {};
    groups.forEach(function (g) {
      const name = String(g.name || "").trim() || "导入分组";
      const local = apiLoadGroups().filter(function (x) { return x.name === name; })[0];
      gmap[g.id] = (local || apiGroupAdd(name)).id;
    });
    reqs.forEach(function (raw) {
      const q = Object.assign(apiBlank(), raw);      // 后端已按白名单清洗，缺的字段由默认值兜住
      q.id = apiNewId();
      q.gid = gmap[raw.gid] || "";                   // 认不出的分组 / 旧版格式：落到「未分组」
      apiAdd(q);
    });
    apiRenderList();
    toast("已从「" + fileName + "」导入 " + reqs.length + " 个请求" +
      (d.decrypted ? "，解密 " + d.decrypted + " 处关键字段" : "") +
      (groups.length ? "，分组 " + groups.length + " 个" : ""), "ok");
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
