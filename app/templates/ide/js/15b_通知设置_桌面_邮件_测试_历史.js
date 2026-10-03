  /* ================================================================
     通知设置（设置 → 通知）
     - 桌面通知（本机可见）+ SMTP 邮件
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

  // 缓存当前配置
  let _notifyCache = null;

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
      toast("通知设置已保存", "ok");
      // 密码框回到默认 placeholder
      const pwd = document.getElementById("notifyPassword");
      if (pwd) { pwd.value = ""; pwd.placeholder = "授权码"; }
    } catch (e) {
      toast("保存失败：" + e.message, "err");
    }
  }

  async function notifyTest(channel) {
    const btn = event && event.currentTarget;
    if (btn) { btn.disabled = true; btn.dataset._old = btn.textContent; btn.textContent = "发送中…"; }
    try {
      // 先保存（如果用户改了配置就直接把当前表单保存）
      try { await notifySave(); } catch (_) {}
      const r = await fetch("/api/ai/notify/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const d = await r.json();
      if (d.ok) {
        toast(`测试通知已发送（${channel}）`, "ok");
      } else {
        const parts = [];
        if (d.results) for (const [k, v] of Object.entries(d.results)) {
          parts.push(`${k}: ${v.ok ? "✅" : "❌"} ${(v.detail || v.error || "").slice(0, 200)}`);
        }
        toast("测试失败：" + (parts.join(" | ") || d.error || "未知错误"), "err");
      }
      // 刷新历史
      await notifyLoad();
    } catch (e) {
      toast("测试请求失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset._old || "测试"; }
    }
  }

  async function notifyClearHistory() {
    if (!confirm("清空全部通知记录？")) return;
    try {
      const r = await fetch("/api/ai/notify/history", { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      toast("已清空 " + (d.cleared || 0) + " 条记录", "ok");
      await notifyLoad();
    } catch (e) {
      toast("清空失败：" + e.message, "err");
    }
  }

  function notifyRenderHistory(records) {
    const box = document.getElementById("notifyHistory");
    if (!box) return;
    if (!records || !records.length) {
      box.innerHTML = '<div style="opacity:.5;text-align:center;padding:8px;">暂无通知记录。AI 对话或智能体任务完成后会自动出现在这里。</div>';
      return;
    }
    const icon = { ai: "💬", chat: "💬", agent: "🤖", test: "🧪" };
    // channels 可能是 {"desktop": {"ok": true, ...}} 或 {"desktop": true, ...}
    const chs = r => {
      const names = Object.keys(r.channels || {});
      const parts = names.map(n => {
        const c = r.channels[n] || {};
        if (typeof c === "boolean") return `${n} ${c ? "✅" : "❌"}`;
        const ok = c.ok;
        return `${n}${ok ? "✅" : "❌"}`;
      });
      return parts.join(" · ") || "—";
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
      return `<div style="border-bottom:1px dashed rgba(0,0,0,.08);padding:4px 0;">` +
        `<span style="opacity:.6;">${ts(r.ts || 0)}</span> ` +
        `<span style="margin:0 4px;">${icon[r.kind] || "📢"}</span> ` +
        `<b>${title}</b> <span style="opacity:.5;">[${task}]</span>` +
        `<div style="opacity:.75;">${chs(r)}</div>` +
        (body ? `<div style="opacity:.6;font-size:11px;">${body}</div>` : "") +
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
      }, true);

      document.addEventListener("click", e => {
        const t = e.target;
        if (t.id === "notifySave") notifySave();
        else if (t.id === "notifyTestLocal") notifyTest("desktop");
        else if (t.id === "notifyTestEmail") notifyTest("email");
        else if (t.id === "notifyTestAll") notifyTest("all");
        else if (t.id === "notifyClearHistory") notifyClearHistory();
      });

      // 进入通知分区时刷新
      document.addEventListener("click", e => {
        const nav = e.target.closest && e.target.closest(".set-navitem");
        if (nav && nav.dataset.sec === "sec-notify") {
          setTimeout(() => notifyLoad(), 100);
        }
      });
    }
    // 每次进入设置页都刷新一次数据（表单可能被清空）
    setTimeout(() => {
      if (document.getElementById("notifyHistory")) notifyLoad();
    }, 100);
  }
