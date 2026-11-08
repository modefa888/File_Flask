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
})();
