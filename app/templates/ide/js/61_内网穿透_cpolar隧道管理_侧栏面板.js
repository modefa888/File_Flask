/* 内网穿透（cpolar）侧栏面板：安装检测 / authtoken 配置 / 隧道创建 · 停止 · 公网地址列表。
 * 隧道启停走 cpolar 本地 9200 REST API（ngrok 1.x 风格），后端 /api/tunnel/* 做代理。
 * 须在 16_（关闭大 IIFE）之前加载，复用闭包内的 $ / esc / toast。 */
if (typeof panels !== "undefined") panels.tunnel = "tunnelPanel";
if (typeof titles !== "undefined") titles.tunnel = "内网穿透";

(function () {
  let poll = null;
  let authOpen = false;        // authtoken 配置区是否展开（面板重绘时保持）
  let svcBusy = null;          // 正在执行的 systemd 动作（start / stop / restart）
  let statusHtml = "", listHtml = "";   // 上次渲染的 HTML：内容没变就不重建 DOM，避免轮询抖动

  function api(path, opts) {
    return fetch(path, Object.assign({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }, opts || {})).then(r => r.json().catch(() => ({ error: "响应解析失败" })));
  }
  function post(path, body) {
    return api(path, { method: "POST", body: JSON.stringify(body || {}) });
  }

  /* ---------------- 状态卡 ---------------- */
  function pill(good, text, title) {
    return '<span class="tnl-pill ' + (good ? "ok" : "bad") + '"' +
      (title ? ' title="' + esc(title) + '"' : "") +
      '><i></i><em>' + esc(text) + '</em></span>';
  }
  function icon(name, spin) {
    return '<i class="bi bi-' + name + (spin ? " tnl-spin" : "") + '"></i>';
  }

  function renderStatus(st) {
    const box = $("tnlStatus");
    if (!box) return;
    if (!st) {
      const err = '<div class="tnl-empty">' + icon("exclamation-triangle") + '状态获取失败</div>';
      if (statusHtml !== err) { statusHtml = err; box.innerHTML = err; }
      return;
    }
    const active = st.service === "active";
    const ver = String(st.version || "").trim().split(" ").pop();
    const rows = [];

    rows.push('<div class="tnl-st-row"><span class="tnl-st-label">安装</span>' +
      pill(st.installed, st.installed ? ("已安装" + (ver ? " · v" + ver : "")) : "未安装") +
      '</div>');

    // 服务行：右侧「启动 / 停止」按钮直接控制 systemd 服务
    let svcBtn = "";
    if (st.installed) {
      const isThis = svcBusy === (active ? "stop" : "start");
      svcBtn = '<button class="tnl-act ' + (active ? "stop" : "start") + '" data-tnl="svc-' +
        (active ? "stop" : "start") + '"' + (svcBusy ? " disabled" : "") + '>' +
        icon(isThis ? "arrow-repeat" : (active ? "stop-fill" : "play-fill"), isThis) +
        (isThis ? "处理中" : (active ? "停止" : "启动")) + '</button>';
    }
    rows.push('<div class="tnl-st-row"><span class="tnl-st-label">服务</span>' +
      pill(active, active ? "运行中" : (st.service || "未知")) + svcBtn + '</div>');

    if (!st.installed) {
      rows.push('<div class="tnl-st-extra">' +
        '<div class="tnl-cmd"><code>' + esc(st.install_cmd || "") + '</code>' +
        '<button class="tnl-mini" data-tnl="copy-install" title="复制安装命令">' + icon("clipboard") + '</button></div>' +
        '<button class="g-btn block outline" data-tnl="install">' + icon("download") + ' 尝试一键安装（需 sudo 免密）</button>' +
        '</div>');
    } else if (!active) {
      rows.push('<div class="tnl-st-extra tnl-fallback">启动按钮无权限？' +
        '<button class="tnl-mini" data-tnl="copy-svc" title="复制 sudo systemctl start cpolar">' +
        icon("clipboard") + ' 备用命令</button></div>');
    }

    rows.push('<div class="tnl-st-row"><span class="tnl-st-label">Web API</span>' +
      pill(st.api_ok, st.api_ok ? "9200 已就绪" : "9200 未就绪") + '</div>');
    rows.push('<div class="tnl-st-row"><span class="tnl-st-label">authtoken</span>' +
      pill(st.authtoken_set,
        st.authtoken_set ? ("已配置 " + (st.authtoken_mask || "")) : "未配置",
        st.authtoken_config ? ("配置来自 " + st.authtoken_config) : "未找到 cpolar 配置文件") +
      '<button class="tnl-act" data-tnl="auth-toggle" title="配置 authtoken">' +
      (authOpen ? "收起" : "配置") + '</button></div>');

    const html = '<div class="tnl-st-head">' + icon("activity") +
      '<span>服务状态</span><span class="tnl-st-sub">cpolar</span></div>' +
      '<div class="tnl-st-body">' + rows.join("") + '</div>';
    if (html !== statusHtml) { statusHtml = html; box.innerHTML = html; }
    const sec = $("tnlAuthSec");
    if (sec) sec.hidden = !authOpen;
  }

  /* ---------------- 隧道列表 ---------------- */
  function renderList(res) {
    const box = $("tnlList");
    if (!box) return;
    const cnt = $("tnlCount");
    const n = (res && res.tunnels) ? res.tunnels.length : 0;
    const cntText = n ? "(" + n + ")" : "";
    // 活动栏图标右上角同步显示在线隧道数量；服务停止时自动隐藏
    const badge = $("actTunnelBadge");
    if (badge) {
      if (badge.textContent !== String(n)) badge.textContent = String(n);
      const show = n ? "" : "none";
      if (badge.style.display !== show) badge.style.display = show;
    }
    let html;
    if (res && res.blocked) {
      const starting = res.reason === "starting";
      html = '<div class="tnl-empty tnl-need-start">' +
        icon(starting ? "hourglass-split" : "power") +
        '<span>' + (starting ? "服务正在启动" : "请启动服务") + '</span>' +
        '<small>' + (starting
          ? "cpolar 已运行，但 9200 Web API 尚未就绪，稍后会自动刷新"
          : "cpolar 服务未运行，启动后才会显示在线隧道") + '</small>' +
        (starting ? "" :
          '<button class="g-btn block outline tnl-start-here" data-tnl="svc-start">' +
          icon("play-fill") + ' 启动服务</button>') +
        '</div>';
    } else if (!res || !res.ok) {
      html = '<div class="tnl-empty">' + icon("exclamation-triangle") +
        '<span>' + esc((res && res.error) || "列表获取失败") + '</span></div>';
    } else if (!res.tunnels.length) {
      html = '<div class="tnl-empty">' + icon("hdd-network") +
        '<span>暂无隧道</span><small>点顶部「新建隧道」添加，或在 cpolar Web 面板里创建</small></div>';
    } else {
      html = res.tunnels.map(function (t) {
        const st = String(t.status || "").trim();
        const stText = (st === "enable" || st === "active" || st === "online") ? "已启用" : (st || "已启用");
        const addr = String(t.addr || "-");
        const addrText = addr.indexOf("://") >= 0 ? addr : ":" + addr;
        return '<div class="tnl-item" data-name="' + esc(t.name) + '">' +
          '<div class="tnl-item-top"><i class="bi bi-globe2"></i>' +
            '<span class="tnl-nm">' + esc(t.name) + '</span>' +
            '<span class="tnl-tag ' + esc(t.proto) + '">' + esc(t.proto || "—") + '</span>' +
            (res.source === "webui" ? "" :
              '<button class="tnl-mini danger" data-tnl="stop" title="移除隧道"><i class="bi bi-stop-fill"></i></button>') +
            '</div>' +
          '<div class="tnl-item-meta">本地 ' + esc(addrText) + ' · ' + esc(stText) + '</div>' +
          (t.public_url
            ? '<div class="tnl-url-row"><div class="tnl-url" data-tnl="copy-url" title="点击复制公网地址">' + esc(t.public_url) + '</div>' +
              '<button class="tnl-url-open" data-tnl="open-url" title="在编辑区网页面板打开"><i class="bi bi-window-stack"></i></button></div>'
            : '<div class="tnl-hint">' +
              (res.source === "config" ? "公网地址请在 cpolar Web 面板查看" : "公网地址生成中…") + '</div>') +
          '</div>';
      }).join("");
      if (res.source === "config" && !webUiToken()) {
        html += '<div class="tnl-hint">仅显示配置隧道。要同步在线实例（含公网地址），' +
          '请在「内网穿透」面板右上角点「浏览器打开」并登录一次 cpolar Web UI。</div>';
      }
    }
    if (html !== listHtml) {
      const top = box.scrollTop;          // 重绘后恢复列表自己的滚动位置
      listHtml = html;
      box.innerHTML = html;
      box.scrollTop = top;
    }
    if (cnt && cnt.textContent !== cntText) cnt.textContent = cntText;
  }

  /* ---------------- 编辑区网页面板 ----------------
     用虚拟路径标签（与设置页 / 数据采集工作台同构），把 cpolar Web UI 或任意网址
     内嵌进右侧编辑区；会话恢复由 00_preamble.js 调 window.openTunnelWebPanel 重开。 */
  const TNL_WEB_PATH = "\u0000tunnel:web";

  function tnlDefaultUrl() {
    // 与 IDE 页面保持同一 hostname：登录态 cookie 不区分端口，但区分域名
    return "http://" + (location.hostname || "127.0.0.1") + ":9200/";
  }
  function tnlNormalizeUrl(u) {
    let s = String(u || "").trim();
    if (!s) return tnlDefaultUrl();
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    return s;
  }
  function tnlSetWebUrl(tab, url, fresh) {
    const u = tnlNormalizeUrl(url);
    tab.tnlWebUrl = u;
    const inp = tab.host.querySelector(".tnl-web-addr");
    if (inp) inp.value = u;
    const fr = tab.host.querySelector(".tnl-web-frame");
    if (fr) fr.src = u + (fresh ? (u.indexOf("?") >= 0 ? "&" : "?") + "_r=" + Date.now() : "");
    const st = tab.host.querySelector(".tnl-web-state");
    if (st) { try { st.textContent = new URL(u).host; } catch (_) { st.textContent = "内网穿透"; } }
    if (typeof sessionSaveTabs === "function") sessionSaveTabs();
  }
  function tnlBindWebPanel(host, tab) {
    host.addEventListener("click", function (e) {
      const b = e.target.closest("[data-web]");
      if (!b) return;
      const act = b.dataset.web;
      if (act === "go") tnlSetWebUrl(tab, host.querySelector(".tnl-web-addr").value);
      else if (act === "reload") tnlSetWebUrl(tab, tab.tnlWebUrl || tnlDefaultUrl(), true);
      else if (act === "external") window.open(tab.tnlWebUrl || tnlDefaultUrl(), "_blank", "noopener");
    });
    const inp = host.querySelector(".tnl-web-addr");
    if (inp) inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); tnlSetWebUrl(tab, inp.value); }
    });
  }

  function openWebPanelNow(url) {
    let tab = findTab(TNL_WEB_PATH);
    const created = !tab;
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host tnl-web-host";
      host.innerHTML =
        '<div class="tnl-web">' +
          '<div class="tnl-web-bar">' +
            '<i class="bi bi-globe2 tnl-web-ico"></i>' +
            '<input class="tnl-web-addr" type="text" spellcheck="false" placeholder="输入网址后回车">' +
            '<button class="tnl-web-btn" data-web="go" title="打开输入的网址"><i class="bi bi-arrow-return-left"></i></button>' +
            '<button class="tnl-web-btn" data-web="reload" title="刷新页面"><i class="bi bi-arrow-clockwise"></i></button>' +
            '<button class="tnl-web-btn" data-web="external" title="在浏览器新标签打开"><i class="bi bi-box-arrow-up-right"></i></button>' +
          '</div>' +
          '<div class="tnl-web-body">' +
            '<iframe class="tnl-web-frame" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>' +
          '</div>' +
          '<div class="tnl-web-foot"><span><i class="bi bi-info-circle"></i> 网页在编辑区内嵌显示；若页面空白（站点拒绝嵌套 / 混合内容），请点右上角在浏览器打开</span>' +
          '<span class="tnl-web-state">cpolar Web UI</span></div>' +
        '</div>';
      tab = {
        path: TNL_WEB_PATH, name: "内网穿透", displayPath: "内网穿透 / 网页面板",
        host: host, cm: null, original: "", dirty: false, big: false,
        group: curGroup, isTunnelWeb: true,
        iconHtml: '<i class="bi bi-globe2" style="color:#4daafc"></i>'
      };
      tabs.push(tab);
      renderTabsAll();
      tnlBindWebPanel(host, tab);
    }
    activate(tab);
    // 保存过账号密码时：先自动登录写入共享 cookie，再加载 / 刷新 iframe，
    // Web UI 会直接以登录态打开，无需跨源操作它的表单。
    ensureWebUiLogin().then(function (ok) {
      if (created || ok || url) tnlSetWebUrl(tab, url || tab.tnlWebUrl || tnlDefaultUrl());
      load();
    });
    return tab;
  }
  /* 打开网页面板前先查一次服务状态：没启动 / 9200 未就绪时只提示，不建标签页。
     silent 供会话恢复使用，刷新页面时不弹提示。 */
  function openTunnelWebPanel(url, silent) {
    return api("/api/tunnel/status").then(function (st) {
      renderStatus(st);
      const down = !st || st.service !== "active";
      const pending = !down && !st.api_ok;
      if (down || pending) {
        if (!silent) toast(down
          ? "请先启动 cpolar 服务，再打开网页面板"
          : "cpolar 服务正在启动（9200 未就绪），请稍后再打开网页面板", "warn");
        return null;
      }
      return openWebPanelNow(url);
    }).catch(function () {
      if (!silent) toast("无法获取 cpolar 服务状态，请稍后重试", "err");
      return null;
    });
  }
  window.openTunnelWebPanel = openTunnelWebPanel;

  /* ---------------- cpolar Web UI 实时数据（可选增强） ----------------
     Web 面板的 /api/v1/tunnels 需要登录 token；用户在网页面板登录后，9200 的
     cookie 会随 credentials:"include" 带上（该服务允许 CORS）。拿不到就安静
     回退到后端从 cpolar.yml 读出的隧道定义，不会让列表变空。 */
  function webUiArray(d) {
    if (!d) return null;
    if (Array.isArray(d)) return d;
    const keys = ["tunnels", "list", "data", "rows", "items", "result"];
    for (let i = 0; i < keys.length; i++) {
      const v = d[keys[i]];
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") { const inner = webUiArray(v); if (inner) return inner; }
    }
    return null;
  }
  function webUiTunnel(t) {
    if (!t || typeof t !== "object") return null;
    const name = String(t.name || t.tunnelName || t.tunnel_name || t.title || "").trim();
    if (!name) return null;
    return {
      name: name,
      proto: String(t.proto || "http").toLowerCase(),
      addr: String(t.addr || t.local_addr || t.port || ""),
      public_url: String(t.public_url || t.url || ""),
      status: String(t.status || t.state || "active"),
    };
  }
  /* Web UI 的在线列表页把 data.items[].publish_tunnels[] 展开成一行行实例
     （一条 http 隧道会同时有 http / https 两个实例），这里做同样的展开。 */
  function webUiInstances(d) {
    const arr = webUiArray(d);
    if (!arr) return null;
    const out = [];
    arr.forEach(function (it) {
      const pub = (it && Array.isArray(it.publish_tunnels)) ? it.publish_tunnels : null;
      if (pub) pub.forEach(function (p) { if (p && typeof p === "object") out.push(p); });
      else if (it && typeof it === "object") out.push(it);
    });
    return out;
  }
  /* cpolar Web UI 用 js-cookie 把登录 token 存在 vue_admin_template_token；
     cookie 不区分端口，所以 IDE 页面（5001）也能读到 9200 写下的这个 cookie。 */
  function webUiToken() {
    const jar = (document.cookie || "").split(";");
    for (let i = 0; i < jar.length; i++) {
      const s = jar[i].trim();
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      if (s.slice(0, eq).toLowerCase() === "vue_admin_template_token") {
        const v = s.slice(eq + 1);
        try { return decodeURIComponent(v); } catch (_) { return v; }
      }
    }
    return "";
  }
  let webProbeAt = 0;
  function fetchWebUiTunnels() {
    const token = webUiToken();
    const now = Date.now();
    if (!token && now - webProbeAt < 15000) return Promise.resolve(null);  // 未登录时别反复产生 401
    webProbeAt = now;
    const h = (!location.hostname || location.hostname === "localhost")
      ? "127.0.0.1" : location.hostname;
    const opts = { credentials: "include" };
    if (token) opts.headers = { Authorization: "Bearer " + token };
    const req = fetch("http://" + h + ":9200/api/v1/tunnels", opts)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        const arr = webUiInstances(d);
        return arr ? arr.map(webUiTunnel).filter(Boolean) : null;
      })
      .catch(function () { return null; });
    // 9200 卡住时最多等 2s（小于 3s 轮询间隔），否则每轮都会被下一次 load 抢占
    return Promise.race([
      req,
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 2000); })
    ]);
  }

  /* ---------------- Web UI 自动登录（账号密码加密保存在服务端） ---------------- */
  function writeWebUiToken(token) {
    // cookie 不区分端口：写在本机 host 上，9200 的 Web UI 加载时会读到并判定为已登录
    document.cookie = "vue_admin_template_token=" + encodeURIComponent(token) +
      "; path=/; SameSite=Lax";
  }
  function ensureWebUiLogin() {
    // 账号密码只存在于服务端密文里；浏览器拿到的只有一次性登录 token
    return post("/api/tunnel/webui/login", {})
      .then(function (r) {
        if (r.error || !r.token) return false;
        writeWebUiToken(r.token);
        return true;
      })
      .catch(function () { return false; });
  }
  /* 旧版把明文存在 localStorage：一次性迁移到服务端加密存储后删除，避免明文残留 */
  function migrateLegacyCred() {
    let raw = "";
    try { raw = localStorage.getItem("ide.tunnel.webui.cred") || ""; }
    catch (_) { return Promise.resolve(); }
    if (!raw) return Promise.resolve();
    let p = Promise.resolve();
    try {
      const c = JSON.parse(raw);
      if (c && c.email && c.password) {
        p = api("/api/tunnel/webui/cred", {
          method: "POST", body: JSON.stringify({ email: c.email, password: c.password })
        }).catch(function () { return null; });
      }
    } catch (_) {}
    return p.then(function () {
      try { localStorage.removeItem("ide.tunnel.webui.cred"); } catch (_) {}
    });
  }
  function updateCredState() {
    return api("/api/tunnel/webui/cred").then(function (r) {
      const s = $("tnlCredState");
      if (s) {
        s.textContent = r.saved ? "已保存" : "未配置";
        s.classList.toggle("empty", !r.saved);
      }
      const e = $("tnlCredEmail"), p = $("tnlCredPwd");
      if (e && !e.value) e.value = r.email || "";
      if (p) p.placeholder = r.saved ? "已加密保存，重新输入可修改" : "登录密码";
    });
  }

  let loadSeq = 0;
  function load() {
    const seq = ++loadSeq;
    const blocked = function (reason) {
      renderList({ ok: true, tunnels: [], blocked: true, reason: reason });
    };
    api("/api/tunnel/status").then(function (st) {
      if (seq !== loadSeq) return;
      renderStatus(st);
      // 服务没跑 / 9200 还没就绪：列表区只给提示，不再拉隧道数据
      const svcDown = !st || st.service !== "active";
      const apiDown = !svcDown && !st.api_ok;
      if (svcDown || apiDown) { blocked(svcDown ? "stopped" : "starting"); return; }
      // 两个数据源都到齐后只做一次决策、只渲染一次：避免「先 2 条后 4 条」的高度跳动
      Promise.all([api("/api/tunnel/list"), fetchWebUiTunnels()]).then(function (arr) {
        if (seq !== loadSeq) return;
        const res = arr[0], web = arr[1];
        const base = (res && res.tunnels) ? res.tunnels.length : 0;
        if (web && web.length >= base) {
          // API 返回顺序可能抖动，排序后再生成 HTML，保证内容签名稳定
          web.sort(function (a, b) {
            return (a.name + "|" + a.proto + "|" + a.public_url).localeCompare(
              b.name + "|" + b.proto + "|" + b.public_url);
          });
          renderList({ ok: true, tunnels: web, source: "webui" });
        } else renderList(res);
      });
    }, function () {
      if (seq !== loadSeq) return;
      renderStatus(null);
      blocked("stopped");
    });
  }

  /* ---------------- 操作 ---------------- */
  function copyText(text, tip) {
    const done = () => toast(tip || "已复制", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (_) { toast("复制失败", "err"); }
    ta.remove();
  }

  function startTunnel() {
    const name = ($("tnlName").value || "").trim();
    const proto = $("tnlProto").value;
    const addr = ($("tnlAddr").value || "").trim();
    if (!name) return toast("请填写隧道名称", "warn");
    if (!addr) return toast("请填写本地端口", "warn");
    post("/api/tunnel/start", { name: name, proto: proto, addr: addr }).then(function (r) {
      if (r.error) return toast(r.error, "err");
      toast(r.hint || ("隧道 " + name + " 已创建"), "ok");
      load();
      setTimeout(load, 1500);   // cpolar 写入 / 启动是异步的，补刷一次保证列表跟上
    });
  }

  function saveAuthToken() {
    const tok = ($("tnlAuthToken").value || "").trim();
    if (!tok) return toast("请填写 authtoken", "warn");
    post("/api/tunnel/authtoken", { token: tok }).then(function (r) {
      if (r.error) return toast(r.error, "err");
      toast(r.hint || ("authtoken 已配置" + (r.config ? "（" + r.config + "）" : "")), "ok");
      $("tnlAuthToken").value = "";
      load();
    });
  }

  function stopTunnel(name) {
    post("/api/tunnel/stop", { name: name }).then(function (r) {
      if (r.error) return toast(r.error, "err");
      toast(r.hint || ("隧道 " + name + " 已移除"), "ok");
      load();
    });
  }

  /* 控制 cpolar 的 systemd 服务：安装成功后不必再去终端敲命令 */
  function serviceAction(action, btn) {
    if (svcBusy) return;
    svcBusy = action;
    if (btn) btn.disabled = true;
    post("/api/tunnel/service", { action: action }).then(function (r) {
      svcBusy = null;
      if (!r.ok) {
        toast(r.hint || r.error || "操作失败", "err");
      } else {
        toast(action === "stop" ? "cpolar 服务已停止" :
          (action === "restart" ? "cpolar 服务已重启" : "cpolar 服务已启动，等待 9200 就绪"), "ok");
      }
      load();
      setTimeout(load, 1600);   // systemctl 是异步的，稍后再刷一次确认 9200 已就绪
    });
  }

  function tryInstall() {
    toast("正在执行安装脚本，最长等 5 分钟…", "info");
    post("/api/tunnel/install", {}).then(function (r) {
      if (r.ok && r.installed) { toast("cpolar 安装成功", "ok"); load(); return; }
      toast((r.hint || "安装失败，请在终端手动执行") , "err");
      load();
    });
  }

  /* ---------------- 面板可见性 / 轮询 ---------------- */
  function panelVisible() {
    const p = document.getElementById("tunnelPanel");
    return !!(p && p.classList.contains("active"));
  }
  function pollStart() {
    if (poll) return;
    poll = setInterval(function () {
      if (document.hidden || !panelVisible()) return;
      load();
    }, 3000);
  }

  /* ---------------- 初始化 ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    const panel = document.getElementById("tunnelPanel");
    if (!panel) return;

    $("tnlRefresh") && ($("tnlRefresh").onclick = load);
    $("tnlListRefresh") && ($("tnlListRefresh").onclick = load);
    $("tnlStart") && ($("tnlStart").onclick = startTunnel);
    $("tnlAuthSave") && ($("tnlAuthSave").onclick = saveAuthToken);
    $("tnlAuthToggle") && ($("tnlAuthToggle").onclick = function () {
      authOpen = false; const sec = $("tnlAuthSec"); if (sec) sec.hidden = true;
      const t = panel.querySelector('[data-tnl="auth-toggle"]'); if (t) t.textContent = "配置";
    });
    $("tnlNew") && ($("tnlNew").onclick = function () {
      const sec = $("tnlFormSec");
      if (!sec) return;
      sec.hidden = !sec.hidden;                    // 点击顶部按钮展开 / 收起新建隧道模块
      this.classList.toggle("on", !sec.hidden);
      if (!sec.hidden) {
        const f = $("tnlName");
        if (f) { f.focus(); f.scrollIntoView({ block: "nearest" }); }
      }
    });
    $("tnlWeb") && ($("tnlWeb").onclick = function () {
      openTunnelWebPanel();          // 在右侧编辑区打开网页面板，而不是弹浏览器新窗口
    });
    $("tnlCredToggle") && ($("tnlCredToggle").onclick = function () {
      const f = $("tnlCredForm");
      if (!f) return;
      f.hidden = !f.hidden;
      this.textContent = f.hidden ? "设置" : "收起";
      if (!f.hidden) { const e = $("tnlCredEmail"); if (e) e.focus(); }
    });
    $("tnlCredSave") && ($("tnlCredSave").onclick = function () {
      const email = ($("tnlCredEmail").value || "").trim();
      const pwd = $("tnlCredPwd").value || "";
      if (!email || !pwd) return toast("请填写 cpolar 邮箱账号和密码", "warn");
      api("/api/tunnel/webui/cred", {
        method: "POST", body: JSON.stringify({ email: email, password: pwd })
      }).then(function (r) {
        if (r.error) return toast(r.error, "err");
        if ($("tnlCredPwd")) $("tnlCredPwd").value = "";
        updateCredState();
        ensureWebUiLogin().then(function (ok) {
          toast(ok ? "凭据已加密保存，网页面板将自动登录" : "凭据已加密保存，但登录失败，请检查账号密码",
            ok ? "ok" : "err");
          load();
        });
      });
    });
    $("tnlCredClear") && ($("tnlCredClear").onclick = function () {
      api("/api/tunnel/webui/cred", { method: "DELETE" }).then(function (r) {
        if (r.error) return toast(r.error, "err");
        document.cookie = "vue_admin_template_token=; path=/; Max-Age=0; SameSite=Lax";
        if ($("tnlCredEmail")) $("tnlCredEmail").value = "";
        if ($("tnlCredPwd")) $("tnlCredPwd").value = "";
        updateCredState();
        toast("已清除加密保存的账号密码", "ok");
        load();
      });
    });
    const credReady = migrateLegacyCred().then(updateCredState);

    // 状态卡 / 隧道列表里的事件（复制命令、复制公网地址、停止、配置 authtoken…）
    panel.addEventListener("click", function (e) {
      const b = e.target.closest("[data-tnl]");
      if (!b) return;
      const act = b.dataset.tnl;
      if (act === "copy-install") return copyText("curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh | sudo bash", "安装命令已复制，请到服务器终端执行");
      if (act === "copy-svc") return copyText("sudo systemctl start cpolar", "启动命令已复制，请到服务器终端执行");
      if (act === "install") return tryInstall();
      if (act === "svc-start") return serviceAction("start", b);
      if (act === "svc-stop") return serviceAction("stop", b);
      if (act === "auth-toggle") {
        authOpen = !authOpen;
        const sec = $("tnlAuthSec"); if (sec) sec.hidden = !authOpen;
        b.textContent = authOpen ? "收起" : "配置";
        if (authOpen) { const i = $("tnlAuthToken"); if (i) i.focus(); }
        return;
      }
      if (act === "stop") return stopTunnel(b.closest(".tnl-item").dataset.name);
      if (act === "copy-url") {
        copyText(b.textContent.trim(), "公网地址已复制");
      }
      if (act === "open-url") {
        const row = b.closest(".tnl-url-row");
        const u = row ? row.querySelector(".tnl-url") : null;
        return openTunnelWebPanel(u ? u.textContent.trim() : "");
      }
    });

    const act = document.getElementById("actTunnel");
    if (act) act.addEventListener("click", function () { setTimeout(load, 0); });

    // 页面刷新后也恢复一次登录态，左侧在线实例列表才能继续同步
    credReady.then(ensureWebUiLogin).then(load);
    load();
    pollStart();
  });

  /* ---------------- 服务启动 → 一键创建隧道 ----------------
     输出面板出现 "Running on http://127.0.0.1:5000" 之类的服务日志时，
     底部工具条显示「一键创建隧道」；点击自动建 cpolar 隧道并回显公网连接。 */
  const SVC_RUN_RE = /(running on|listening on|listening|serving|serve_forever|local:|started server|启动服务|端口)/i;
  const SVC_URL_RE = /https?:\/\/[^/\s:'"]+:(\d{2,5})/i;
  const SVC_WORD_RE = /(?:port|端口|on)[^\d]{0,20}(\d{2,5})/i;
  const svcTunnel = { port: 0, busy: false, checking: 0, verified: 0 };
  const SVC_SAVE_KEY = "ide.tunnel.onekey";

  function svcDetectPort(text) {
    const t = String(text || "");
    if (!t || !SVC_RUN_RE.test(t)) return 0;
    const m = t.match(SVC_URL_RE) || t.match(SVC_WORD_RE);
    if (!m) return 0;
    const p = parseInt(m[1], 10);
    return (p > 0 && p <= 65535) ? p : 0;
  }

  function svcBtn() {
    let b = $("bpTunnelBtn");
    if (b) return b;
    const tabs = document.querySelector(".bp-tabs");
    if (!tabs) return null;
    b = document.createElement("button");
    b.id = "bpTunnelBtn";
    b.className = "bp-btn";
    b.style.display = "none";
    const clear = $("bpClear");
    tabs.insertBefore(b, clear ? clear.nextSibling : null);
    b.onclick = svcCreate;
    return b;
  }

  /* 已建隧道的连接按端口记在本地，刷新后不必再创建一次 */
  function svcSaved(port) {
    try {
      const m = JSON.parse(localStorage.getItem(SVC_SAVE_KEY) || "{}");
      const v = m && m[String(port)];
      return (v && v.url) ? v : null;
    } catch (_) { return null; }
  }
  function svcSave(port, url) {
    try {
      const m = JSON.parse(localStorage.getItem(SVC_SAVE_KEY) || "{}");
      m[String(port)] = { url: url, at: Date.now() };
      localStorage.setItem(SVC_SAVE_KEY, JSON.stringify(m));
    } catch (_) { /* 忽略 */ }
  }

  /* 侧栏已经渲染出来的公网地址是最可靠的数据源（cpolar Web UI 在线实例） */
  function svcDomUrl(name, port) {
    const items = document.querySelectorAll("#tnlList .tnl-item");
    for (let i = 0; i < items.length; i++) {
      const nm = String(items[i].dataset.name || "");
      const meta = items[i].querySelector(".tnl-item-meta");
      if (nm !== name && !(port && meta && meta.textContent.indexOf(":" + port) >= 0)) continue;
      const u = items[i].querySelector(".tnl-url");
      if (u && u.textContent.trim()) return u.textContent.trim();
    }
    return "";
  }

  /* 直接读 9200 在线实例，绕过 fetchWebUiTunnels 的 15s 节流 */
  function svcWebList() {
    const token = webUiToken();
    const h = (!location.hostname || location.hostname === "localhost") ? "127.0.0.1" : location.hostname;
    const opts = { credentials: "include" };
    if (token) opts.headers = { Authorization: "Bearer " + token };
    return fetch("http://" + h + ":9200/api/v1/tunnels", opts)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        const arr = webUiInstances(d);
        return arr ? arr.map(webUiTunnel).filter(Boolean) : [];
      })
      .catch(function () { return []; });
  }

  /* 按端口找已有隧道的公网地址：侧栏 DOM → 9200 在线实例 → 后端隧道列表 */
  async function svcLookup(port) {
    const name = "ide_" + port;
    let url = svcDomUrl(name, port);
    if (url) return url;
    const match = function (t) {
      return t && t.public_url && (String(t.name) === name ||
        String(t.addr) === String(port) || String(t.addr).indexOf(":" + port) >= 0 ||
        String(t.addr).indexOf(String(port)) >= 0);
    };
    try {
      const web = await svcWebList();
      const hit = web.filter(match)[0];
      if (hit) return hit.public_url;
    } catch (_) { /* 忽略 */ }
    try {
      const ls = await api("/api/tunnel/list");
      const t = ((ls && ls.tunnels) || []).filter(match)[0];
      if (t) return t.public_url;
    } catch (_) { /* 忽略 */ }
    return "";
  }

  function svcOffer(port) {
    const b = svcBtn();
    if (!b) return;
    b.style.display = "";
    b.title = "为本地 :" + port + " 一键创建 cpolar 公网隧道";
    b.innerHTML = '<i class="bi bi-cloud-arrow-up"></i> 一键创建隧道 :' + port;
    b.onclick = svcCreate;
  }

  async function svcShow(port) {
    if (!port) return;
    const b = svcBtn();
    if (!b) return;
    svcTunnel.port = port;
    b.style.display = "";
    b.disabled = false;
    const saved = svcSaved(port);
    if (saved && saved.url) {                   // 刷新后直接回显连接，不再提示重新创建
      svcResult(port, saved.url, true);
      if (svcTunnel.verified !== port) {
        svcTunnel.verified = port;
        svcLookup(port).then(function (u) {
          if (u && u !== saved.url) { svcSave(port, u); svcResult(port, u, true); }
          else if (!u) svcOffer(port);         // 隧道已被删除 → 恢复创建按钮
        });
      }
      return;
    }
    if (svcTunnel.checking === port) return;    // 同一端口不重复查
    svcTunnel.checking = port;
    const url = await svcLookup(port);
    svcTunnel.checking = 0;
    if (svcTunnel.port !== port) return;
    if (url) { svcSave(port, url); svcResult(port, url, true); }
    else svcOffer(port);
  }

  function svcHide() {
    const b = $("bpTunnelBtn");
    if (b) b.style.display = "none";
    svcTunnel.port = 0;
  }

  function svcWatch() {
    const body = $("opBody");
    if (!body || !window.MutationObserver) return;
    new MutationObserver(function (list) {
      if (!body.childElementCount) { svcHide(); return; }
      list.forEach(function (rec) {
        Array.prototype.forEach.call(rec.addedNodes || [], function (n) {
          if (n.nodeType !== 1) return;
          const p = svcDetectPort(n.textContent || "");
          if (p) svcShow(p);
        });
      });
    }).observe(body, { childList: true });
  }

  async function svcCreate() {
    if (svcTunnel.busy) return;
    const b = svcBtn();
    let port = svcTunnel.port;
    try {                                     // 后端 /proc 检测到的真实监听端口更准
      const r = await fetch("/api/run/tasks").then(function (x) { return x.json(); });
      const cand = (r.tasks || []).filter(function (x) {
        return x && x.running && (x.ports || []).length;
      });
      const t = cand.filter(function (x) {
        return x.ports.indexOf(Number(svcTunnel.port)) >= 0;
      })[0] || cand[0];
      if (t && t.ports && t.ports[0]) port = t.ports[0];
    } catch (_) { /* 拿不到就用日志里识别的端口 */ }
    if (!port) { toast("未识别到服务端口，请先在输出里确认监听地址", "warn"); return; }
    svcTunnel.busy = true;
    if (b) {
      b.disabled = true;
      /* 纯 CSS 圆环 spinner：中心对称，旋转不会像字体图标那样抖动 */
      if (!document.getElementById("svcSpinStyle")) {
        const st = document.createElement("style");
        st.id = "svcSpinStyle";
        st.textContent =
          '#bpTunnelBtn .svc-spin{display:inline-block;width:11px;height:11px;box-sizing:border-box;' +
          'border:2px solid currentColor;border-right-color:transparent;border-radius:50%;' +
          'vertical-align:-1px;margin-right:4px;animation:svcSpin .7s linear infinite}' +
          '@keyframes svcSpin{to{transform:rotate(360deg)}}';
        document.head.appendChild(st);
      }
      b.innerHTML = '<span class="svc-spin"></span> 正在创建隧道…';
    }
    const step = function (txt) {
      if (b) b.innerHTML = '<span class="svc-spin"></span> ' + esc(txt);
    };
    const limit = function (p, ms, label) {
      return Promise.race([
        p,
        new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error(label + "超时（" + Math.round(ms / 1000) + "s）"));
          }, ms);
        }),
      ]);
    };
    try {
      step("检查 cpolar 状态…");
      let st = await limit(api("/api/tunnel/status"), 8000, "检查 cpolar 状态");
      if (!st.installed) {
        toast("cpolar 未安装，正在尝试一键安装…", "warn");
        step("正在安装 cpolar…");
        const ins = await limit(post("/api/tunnel/install", {}), 25000, "安装 cpolar");
        if (!ins.ok && !ins.installed) throw new Error(ins.hint || "安装失败，请在服务器终端安装 cpolar");
        st = await limit(api("/api/tunnel/status"), 8000, "检查 cpolar 状态");
      }
      if (st.service !== "active") {
        step("正在启动 cpolar 服务…");
        const sv = await limit(post("/api/tunnel/service", { action: "start" }), 20000, "启动 cpolar 服务");
        if (!sv.ok) throw new Error(sv.hint || sv.error || "cpolar 服务启动失败");
        st = sv.status || await limit(api("/api/tunnel/status"), 8000, "检查 cpolar 状态");
      }
      for (let i = 0; i < 8 && st && !st.api_ok; i++) {
        step("等待 9200 就绪…");
        await new Promise(function (r) { setTimeout(r, 700); });
        st = await limit(api("/api/tunnel/status"), 8000, "检查 cpolar 状态");
      }
      const name = "ide_" + port;
      step("正在创建隧道…");
      const cr = await limit(post("/api/tunnel/start", { name: name, proto: "http", addr: String(port) }),
        10000, "创建隧道");
      if (cr.error && !/已存在/.test(cr.error)) throw new Error(cr.error);
      step("正在获取公网连接…");
      await limit(ensureWebUiLogin().catch(function () { return false; }), 8000, "登录 Web 面板");
      let url = "";
      for (let i = 0; i < 6 && !url; i++) {
        url = await limit(svcLookup(port), 6000, "读取在线隧道");
        if (!url) await new Promise(function (r) { setTimeout(r, 1200); });
      }
      if (url) svcSave(port, url);
      svcResult(port, url, false);
      load();
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      toast("创建隧道失败：" + msg, "err");
      if (b) { b.innerHTML = '<i class="bi bi-cloud-arrow-up"></i> 重试创建隧道 :' + port; b.onclick = svcCreate; }
    } finally {
      svcTunnel.busy = false;
      if (b) b.disabled = false;
    }
  }

  function svcResult(port, url, quiet) {
    const b = svcBtn();
    const host = location.hostname || "127.0.0.1";
    const webui = "http://" + host + ":9200/";
    if (b) {
      b.style.display = "";
      b.innerHTML = '<i class="bi bi-link-45deg"></i> ' + (url ? "公网连接（点复制）" : "查看 Web 面板");
      b.title = url ? (url + "（点击复制）") : ("公网地址请在 cpolar Web 面板查看：" + webui);
      b.onclick = function () {
        if (url) copyText(url, "公网连接已复制：" + url);
        else window.open(webui, "_blank", "noopener");
      };
    }
    const body = $("opBody");
    if (body) {
      let span = body.querySelector("[data-svc-url]");   // 同一行复用，避免刷新/更新时重复追加
      if (!span) {
        span = document.createElement("span");
        span.setAttribute("data-svc-url", "1");
        span.className = "op-ok op-result";
        body.appendChild(span);
      }
      span.innerHTML = url
        ? '✔ 隧道已就绪（本地 :' + esc(String(port)) + '）→ 公网连接：<a class="op-link" href="' +
          esc(url) + '" target="_blank" rel="noopener">' + esc(url) +
          '</a> <button class="bp-btn" style="padding:0 4px" data-svc-copy="1">复制</button>'
        : '✔ 隧道已创建（本地 :' + esc(String(port)) + '），公网地址请在 <a class="op-link" href="' +
          esc(webui) + '" target="_blank" rel="noopener">cpolar Web 面板</a> 查看';
      const cp = span.querySelector("[data-svc-copy]");
      if (cp) cp.onclick = function () { copyText(url, "公网连接已复制：" + url); };
      body.scrollTop = body.scrollHeight;
    }
    if (!quiet) {
      if (url) toast("公网连接：" + url, "ok");
      else toast("隧道已创建，公网地址请在 cpolar Web 面板查看", "warn");
    }
  }

  svcWatch();
})();
