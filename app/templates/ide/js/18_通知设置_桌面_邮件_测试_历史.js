  /* ================================================================
     通知设置（设置 → 通知）
     - 浏览器通知（Web Notification API，服务器本机系统通知兜底）+ SMTP 邮件
     - 保存/加载/测试三条通道/清空历史/最近通知记录
     - 触发时机：AI 对话 done、智能体 done（后端已完成触发）
     ================================================================ */
  const NOTIFY_DEFAULTS = {
    enabled: false,
    scope: "both",
    channels: { desktop: true, smtp: false },
    template: { chat: "AI 助手 · 回复完成", agent: "AI 智能体 · 任务完成" },
    template_body: "任务已完成：{query}",
    summary_max_chars: 120,
    query_max_chars: 60,
    desktop: { sound: true, sound_name: "", timeout_ms: 5000, app_name: "File_Flask" },
    smtp: { host: "", port: 465, security: "ssl", username: "", password: "", from_addr: "", to: "", subject_prefix: "[File_Flask] ", test_recipient: "" },
  };

  /* 通知分区 HTML：由设置页 buildSettingsContent() 调用。
     结构（markup）与逻辑统一放在本文件，避免通知模块代码散落在设置页 JS 里。 */
  function notifyBuildSectionHTML() {
    return '<div class="set-sec" id="sec-notify" data-kw="通知 notify email 邮件 浏览器 桌面 toast 提示">' +
      '<h2><i class="bi bi-bell"></i> 通知</h2>' +
      '<div class="set-desc" data-kw="通知 notify 邮件 smtp 浏览器">AI 消息完成后向"启动服务的本人"推送。<b>浏览器通知</b>通过浏览器通知 API 推送到当前浏览器（需授权），服务器本机系统通知作为兜底；<b>邮件</b>通过 SMTP 发送。默认关闭。</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-power"></i> 总开关</div>' +
        '<div class="notify-row inline set-row" data-kw="启用通知 enabled">' +
          '<div class="notify-label-wrap"><div class="notify-label">启用通知</div><div class="notify-desc">关闭后所有通道均不触发。</div></div>' +
          '<label class="set-switch"><input type="checkbox" id="notifyEnabled"><span></span></label>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-broadcast"></i> 通知通道</div>' +
        '<div class="notify-grid-2">' +
          '<div class="notify-channel-card set-row" data-kw="浏览器 browser desktop 本地">' +
            '<div class="notify-icon"><i class="bi bi-bell"></i></div>' +
            '<div class="notify-channel-info"><div class="notify-label">浏览器通知</div><div class="notify-desc">通过浏览器通知 API 推送到当前浏览器（需授权通知权限）。</div></div>' +
            '<label class="set-switch"><input type="checkbox" id="notifyDesktop"><span></span></label>' +
          '</div>' +
          '<div class="notify-channel-card email set-row" data-kw="邮件 smtp email">' +
            '<div class="notify-icon"><i class="bi bi-envelope"></i></div>' +
            '<div class="notify-channel-info"><div class="notify-label">邮件通知（SMTP）</div><div class="notify-desc">QQ / 163 / Gmail / Outlook 等 SMTP 发送。</div></div>' +
            '<label class="set-switch"><input type="checkbox" id="notifyEmail"><span></span></label>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card notifyDesktopOpts">' +
        '<div class="notify-card-title"><i class="bi bi-bell"></i> 浏览器通知选项</div>' +
        '<div class="notify-row stack set-row" data-kw="应用名 app name">' +
          '<div class="notify-label-wrap"><div class="notify-label">应用名</div><div class="notify-desc">系统通知中心显示的来源名称（服务器本机系统通知兜底时使用）。</div></div>' +
          '<input class="notify-input" id="notifyAppName" placeholder="文件管理器">' +
        '</div>' +
        '<div class="notify-row inline set-row" data-kw="提示音 sound 响铃">' +
          '<div class="notify-label-wrap"><div class="notify-label">提示音</div><div class="notify-desc">浏览器通知是否响铃（最终以浏览器/系统设置为准）。</div></div>' +
          '<label class="set-switch"><input type="checkbox" id="notifyDesktopSound"><span></span></label>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card notifyEmailOpts">' +
        '<div class="notify-card-title"><i class="bi bi-envelope-gear"></i> SMTP 设置</div>' +
        '<div class="notify-row stack set-row" data-kw="收件人 to">' +
          '<div class="notify-label-wrap"><div class="notify-label">收件人地址</div><div class="notify-desc">接收通知的邮箱，多个用英文逗号分隔。</div></div>' +
          '<input class="notify-input" id="notifyTo" placeholder="me@example.com">' +
        '</div>' +
        '<div class="notify-grid-2">' +
          '<div class="notify-row stack set-row" data-kw="smtp 服务器 host">' +
            '<div class="notify-label-wrap"><div class="notify-label">SMTP 服务器</div><div class="notify-desc">如 smtp.qq.com</div></div>' +
            '<input class="notify-input" id="notifySmtpHost" placeholder="smtp.qq.com">' +
          '</div>' +
          '<div class="notify-row stack set-row" data-kw="端口 port">' +
            '<div class="notify-label-wrap"><div class="notify-label">端口</div><div class="notify-desc">465 或 587</div></div>' +
            '<input class="notify-input" id="notifySmtpPort" type="number" min="1" max="65535" placeholder="465">' +
          '</div>' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="加密 security">' +
          '<div class="notify-label-wrap"><div class="notify-label">加密方式</div><div class="notify-desc">SSL (TLS) / STARTTLS / 无</div></div>' +
          '<select class="notify-select" id="notifyEncryption">' +
            '<option value="ssl">SSL (TLS)</option><option value="starttls">STARTTLS</option><option value="none">无</option>' +
          '</select>' +
        '</div>' +
        '<div class="notify-grid-2">' +
          '<div class="notify-row stack set-row" data-kw="发件人账号 username">' +
            '<div class="notify-label-wrap"><div class="notify-label">发件人账号</div><div class="notify-desc">你的邮箱地址</div></div>' +
            '<input class="notify-input" id="notifyUser" placeholder="me@example.com">' +
          '</div>' +
          '<div class="notify-row stack set-row" data-kw="授权码 密码 password">' +
            '<div class="notify-label-wrap"><div class="notify-label">授权码 / 密码</div><div class="notify-desc">邮件服务商授权码，保存后仅显示 ****</div></div>' +
            '<form class="notify-pwd-form" autocomplete="off" onsubmit="return false">' +
            '<input class="notify-input" id="notifyPassword" type="password" placeholder="授权码" autocomplete="off">' +
          '</form>' +
          '</div>' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="显示名 from name">' +
          '<div class="notify-label-wrap"><div class="notify-label">发件人显示名</div><div class="notify-desc">收件箱里显示的名字（可选）</div></div>' +
          '<input class="notify-input" id="notifyFromName" placeholder="文件管理器">' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-pencil-square"></i> 通知模板</div>' +
        '<div class="notify-row stack set-row" data-kw="标题模板 title">' +
          '<div class="notify-label-wrap"><div class="notify-label">标题模板</div><div class="notify-desc">变量：<code>{{task}}</code> <code>{{query}}</code> <code>{{answer_len}}</code> <code>{{file_count}}</code></div></div>' +
          '<input class="notify-input" id="notifyTitle" placeholder="AI 任务已完成">' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="正文模板 body">' +
          '<div class="notify-label-wrap"><div class="notify-label">正文模板</div><div class="notify-desc">同上；正文长度会自动截断。</div></div>' +
          '<input class="notify-input" id="notifyBody" placeholder="任务 {{task}} 已完成">' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-gear-wide-connected"></i> 操作</div>' +
        '<div class="notify-desc" style="margin:0 0 12px;">保存后立即生效；测试会按所选通道发一条真实通知。</div>' +
        '<div class="notify-actions" data-kw="测试 保存 test save">' +
          '<button class="notify-btn" id="notifyTestLocal"><i class="bi bi-bell"></i> 测试浏览器</button>' +
          '<button class="notify-btn" id="notifyTestEmail"><i class="bi bi-envelope"></i> 测试邮件</button>' +
          '<button class="notify-btn" id="notifyTestAll"><i class="bi bi-broadcast"></i> 全部通道</button>' +
          '<button class="notify-btn primary" id="notifySave"><i class="bi bi-save"></i> 保存</button>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title" style="justify-content:space-between;">' +
          '<span><i class="bi bi-clock-history"></i> 最近通知记录</span>' +
          '<button class="notify-btn" id="notifyClearHistory"><i class="bi bi-trash"></i> 清空</button>' +
        '</div>' +
        '<div class="notify-desc" style="margin:0 0 10px;">最多保留 30 条。</div>' +
        '<div id="notifyHistory" class="notify-history">加载中…</div>' +
      '</div>' +
    '</div>';
  }

  // toast 定义在 00_preamble.js 的 IIFE 闭包里，本文件必须在 16_自定义悬停提示 之前加载
  // （ide.html 的 include 顺序）才能拿到它；这里兜底，避免被排到闭包外时整段逻辑抛错。
  const notifyToast = (typeof toast === "function")
    ? toast
    : (msg, type) => console.warn("[notify]" + (type ? " [" + type + "]" : ""), msg);

  // 缓存当前配置
  let _notifyCache = null;

  /* ---------- 浏览器通知（Web Notification API） ----------
     后端 desktop 通道在服务器本机发系统通知；这里轮询 /api/ai/notify，
     把 desktop 通道的通知镜像到当前浏览器（需用户授权通知权限）。 */
  const NOTIFY_POLL_MS = 15000;
  const NOTIFY_CURSOR_KEY = "notify.lastCursor";
  let _notifyLastCursor = (() => {
    try {
      const raw = localStorage.getItem(NOTIFY_CURSOR_KEY);
      return raw === null ? -1 : (parseInt(raw, 10) || 0);   // -1 = 尚未初始化（首次不弹历史通知）
    } catch (_) { return -1; }
  })();

  function notifyBrowserGranted() {
    return ("Notification" in window) && Notification.permission === "granted";
  }

  // 首次开启「浏览器通知」或点测试时，向浏览器申请通知权限
  function notifyRequestBrowserPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (_) {}
    }
  }

  function notifyShowBrowser(rec) {
    if (!rec) return;
    const ch = rec.channels || {};
    const dk = ch.desktop;                       // 只镜像 desktop（浏览器）通道
    const ok = typeof dk === "boolean" ? dk : !!(dk && dk.ok);
    if (!ok) return;
    // 浏览器通知仅在安全上下文（https / localhost）可用；
    // http 内网访问时退化为页内 toast 提示。
    if (!notifyBrowserGranted()) {
      const t = rec.title || "File_Flask";
      const b = (rec.body || "").split("\n")[0];
      notifyToast("🔔 " + t + (b ? "：" + b : ""), "ok");
      return;
    }
    try {
      const soundOn = !document.getElementById("notifyDesktopSound") ||
                      document.getElementById("notifyDesktopSound").checked;
      const n = new Notification(rec.title || "File_Flask", {
        body: rec.body || "",
        silent: !soundOn,
        tag: "file-flask-notify-" + (rec.ts || ""),
      });
      n.onclick = () => { try { window.focus(); n.close(); } catch (_) {} };
    } catch (_) {}
  }

  function notifyStartPolling() {
    if (window.__notifyPolling) return;
    window.__notifyPolling = true;
    setInterval(async () => {
      try {
        const r = await fetch("/api/ai/notify?cursor=" + Math.max(_notifyLastCursor, 0));
        if (!r.ok) return;
        const d = await r.json();
        if (!d || !d.has_new) return;
        if (_notifyLastCursor < 0) {
          // 首次运行：只记录游标，不把历史通知弹出来
          _notifyLastCursor = d.cursor || 0;
        } else if (rec_isNewer(d)) {
          notifyShowBrowser(d.latest);
          _notifyLastCursor = d.cursor || _notifyLastCursor;
        }
        try { localStorage.setItem(NOTIFY_CURSOR_KEY, String(_notifyLastCursor)); } catch (_) {}
      } catch (_) {}
    }, NOTIFY_POLL_MS);
  }

  function rec_isNewer(d) {
    return d && d.latest && (d.cursor || 0) > Math.max(_notifyLastCursor, 0);
  }

  async function notifyLoad() {
    try {
      const r = await fetch("/api/ai/notify");
      const d = await r.json();
      if (d && d.cfg) {
        _notifyCache = d.cfg;
        notifyFill(d.cfg);
        notifyRenderHistory(d.recent || []);
      }
    } catch (e) {
      console.error("[notify] load failed:", e);
    }
  }

  function notifyFill(cfg) {
    const q = id => document.getElementById(id);
    const ch = cfg.channels || {};
    const dk = cfg.desktop || {};
    const sk = cfg.smtp || {};
    const tp = cfg.template || {};
    // 兼容"channels.desktop 是 bool"
    const desktopOn = typeof ch.desktop === "object" ? !!ch.desktop.enabled : !!ch.desktop;
    const smtpOn = typeof ch.smtp === "object" ? !!ch.smtp.enabled : !!ch.smtp;

    if (q("notifyEnabled"))        q("notifyEnabled").checked = !!cfg.enabled;
    if (q("notifyDesktop"))        q("notifyDesktop").checked = desktopOn;
    if (q("notifyAppName"))        q("notifyAppName").value = dk.app_name || "File_Flask";
    if (q("notifyDesktopSound"))   q("notifyDesktopSound").checked = dk.sound !== false;

    if (q("notifyEmail"))          q("notifyEmail").checked = smtpOn;
    if (q("notifyTo"))             q("notifyTo").value = sk.to || "";
    if (q("notifySmtpHost"))       q("notifySmtpHost").value = sk.host || "";
    if (q("notifySmtpPort"))       q("notifySmtpPort").value = sk.port || 465;
    if (q("notifyEncryption"))     q("notifyEncryption").value = sk.security || "ssl";
    if (q("notifyUser"))           q("notifyUser").value = sk.username || "";
    if (q("notifyPassword")) {
      q("notifyPassword").value = "";
      q("notifyPassword").placeholder = sk.password_set ? "已保存（留空保持不变）" : "授权码";
    }
    if (q("notifyFromName"))       q("notifyFromName").value = sk.from_name || sk.from_addr || "";
    if (q("notifyTitle"))          q("notifyTitle").value = tp.chat || NOTIFY_DEFAULTS.template.chat;
    if (q("notifyBody"))           q("notifyBody").value = cfg.template_body || NOTIFY_DEFAULTS.template_body;

    notifyToggleOptVisibility();
  }

  function notifyToggleOptVisibility() {
    const desktopOn = document.getElementById("notifyDesktop")?.checked;
    document.querySelectorAll(".notifyDesktopOpts").forEach(el => el.style.display = desktopOn ? "" : "none");
    const emailOn = document.getElementById("notifyEmail")?.checked;
    document.querySelectorAll(".notifyEmailOpts").forEach(el => el.style.display = emailOn ? "" : "none");
  }

  function notifyReadForm() {
    const q = id => document.getElementById(id)?.value ?? "";
    const c = id => document.getElementById(id)?.checked ?? false;
    return {
      enabled: c("notifyEnabled"),
      scope: "both",
      channels: { desktop: c("notifyDesktop"), smtp: c("notifyEmail") },
      desktop: {
        app_name: q("notifyAppName").trim() || "File_Flask",
        sound: c("notifyDesktopSound"),
      },
      smtp: {
        to: q("notifyTo").trim(),
        host: q("notifySmtpHost").trim(),
        port: parseInt(q("notifySmtpPort"), 10) || 465,
        security: q("notifyEncryption"),
        username: q("notifyUser").trim(),
        password: q("notifyPassword").trim(),  // 空字符串表示"保持不变"
        from_addr: q("notifyFromName").trim(),  // 后端字段 from_addr
        from_name: q("notifyFromName").trim(),  // 兼容字段
      },
      template: {
        chat: q("notifyTitle").trim() || NOTIFY_DEFAULTS.template.chat,
      },
      template_body: q("notifyBody").trim() || NOTIFY_DEFAULTS.template_body,
    };
  }

  async function notifySave() {
    const body = notifyReadForm();
    try {
      const r = await fetch("/api/ai/notify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      _notifyCache = d.cfg;
      notifyToast("通知设置已保存", "ok");
      // 密码框回到默认 placeholder
      const pwd = document.getElementById("notifyPassword");
      if (pwd) { pwd.value = ""; pwd.placeholder = "授权码"; }
    } catch (e) {
      notifyToast("保存失败：" + e.message, "err");
    }
  }

  const _notifyTestBtnId = { desktop: "notifyTestLocal", email: "notifyTestEmail", all: "notifyTestAll" };

  async function notifyTest(channel, btn) {
    // 事件是委托在 document 上的，e.target 可能是按钮里的图标，
    // 且 event.currentTarget 是 document（不是按钮），所以这里显式按 id 取按钮。
    btn = btn || document.getElementById(_notifyTestBtnId[channel] || "");
    if (btn) { btn.disabled = true; btn.dataset._old = btn.innerHTML; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 发送中…'; }
    // 测试浏览器通道时顺带申请通知权限（首次使用）
    if (channel === "desktop" || channel === "all") notifyRequestBrowserPermission();
    try {
      // 先保存（如果用户改了配置就直接把当前表单保存）
      try { await notifySave(); } catch (_) {}
      const r = await fetch("/api/ai/notify/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const d = await r.json();
      if (d.ok) {
        const chName = { desktop: "浏览器", email: "邮件", all: "全部通道" }[channel] || channel;
        notifyToast(`测试通知已发送（${chName}）`, "ok");
      } else {
        const parts = [];
        if (d.results) for (const [k, v] of Object.entries(d.results)) {
          parts.push(`${k}: ${v.ok ? "✅" : "❌"} ${(v.detail || v.error || "").slice(0, 200)}`);
        }
        notifyToast("测试失败：" + (parts.join(" | ") || d.error || "未知错误"), "err");
      }
      // 刷新历史
      await notifyLoad();
    } catch (e) {
      notifyToast("测试请求失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._old || '<i class="bi bi-broadcast"></i> 测试'; }
    }
  }

  async function notifyClearHistory() {
    if (!confirm("清空全部通知记录？")) return;
    try {
      const r = await fetch("/api/ai/notify/history", { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      notifyToast("已清空 " + (d.cleared || 0) + " 条记录", "ok");
      await notifyLoad();
    } catch (e) {
      notifyToast("清空失败：" + e.message, "err");
    }
  }

  function notifyRenderHistory(records) {
    const box = document.getElementById("notifyHistory");
    if (!box) return;
    if (!records || !records.length) {
      box.innerHTML = '<div class="notify-history-empty"><i class="bi bi-inbox"></i>暂无通知记录<div>AI 对话或智能体任务完成后会自动出现在这里。</div></div>';
      return;
    }
    const icon = { ai: "💬", chat: "💬", agent: "🤖", test: "🧪" };
    const chClass = ok => ok ? "ok" : "fail";
    const chIcon = ok => ok ? "bi-check-circle" : "bi-x-circle";
    const chs = r => {
      const names = Object.keys(r.channels || {});
      if (!names.length) return '<span class="notify-hch">—</span>';
      return names.map(n => {
        const c = r.channels[n] || {};
        const ok = typeof c === "boolean" ? c : c.ok;
        return `<span class="notify-hch ${chClass(ok)}"><i class="bi ${chIcon(ok)}"></i> ${n}</span>`;
      }).join("");
    };
    const ts = t => {
      if (!t) return "—";
      const d = new Date(t * 1000);
      const pad = n => String(n).padStart(2, "0");
      return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    box.innerHTML = records.map(r => {
      const title = (r.title || "").replace(/</g, "&lt;");
      const body = (r.body || "").replace(/</g, "&lt;").replace(/\s+/g, " ").slice(0, 120);
      const task = (r.task || r.kind || "unknown").replace(/</g, "&lt;");
      return `<div class="notify-hitem">` +
        `<div class="notify-hicon">${icon[r.kind] || "📢"}</div>` +
        `<div class="notify-hbody">` +
          `<div class="notify-htitle"><span>${title}</span><span class="notify-hmeta">[${task}] · ${ts(r.ts || 0)}</span></div>` +
          `<div class="notify-hchannels">${chs(r)}</div>` +
          (body ? `<div class="notify-hbodytext">${body}</div>` : "") +
        `</div>` +
      `</div>`;
    }).join("");
  }

  function notifyMountSettings() {
    // 全局事件只绑定一次；数据每次都刷新
    if (!window.__notifyMounted) {
      window.__notifyMounted = true;

      document.addEventListener("input", e => {
        const t = e.target;
        if (!t || !t.id || !t.id.startsWith("notify")) return;
        notifyToggleOptVisibility();
      }, true);
      document.addEventListener("change", e => {
        const t = e.target;
        if (!t || !t.id || !t.id.startsWith("notify")) return;
        notifyToggleOptVisibility();
        // 开启「浏览器通知」时，向浏览器申请通知权限
        if (t.id === "notifyDesktop" && t.checked) notifyRequestBrowserPermission();
      }, true);

      document.addEventListener("click", e => {
        // 按钮内含 <i> 图标，e.target 可能是图标而不是按钮，统一向上找最近的 button
        const btn = e.target && e.target.closest ? e.target.closest("button") : null;
        const id = btn ? btn.id : (e.target ? e.target.id : "");
        if (id === "notifySave") notifySave();
        else if (id === "notifyTestLocal") notifyTest("desktop", btn);
        else if (id === "notifyTestEmail") notifyTest("email", btn);
        else if (id === "notifyTestAll") notifyTest("all", btn);
        else if (id === "notifyClearHistory") notifyClearHistory();
      });

      // 进入通知分区时刷新
      document.addEventListener("click", e => {
        const nav = e.target.closest && e.target.closest(".set-navitem");
        if (nav && nav.dataset.sec === "sec-notify") {
          setTimeout(() => notifyLoad(), 100);
        }
      });

      // 启动浏览器通知轮询（镜像 desktop 通道到当前浏览器）
      notifyStartPolling();
    }
    // 每次进入设置页都刷新一次数据（表单可能被清空）
    setTimeout(() => {
      if (document.getElementById("notifyHistory")) notifyLoad();
    }, 100);
  }
