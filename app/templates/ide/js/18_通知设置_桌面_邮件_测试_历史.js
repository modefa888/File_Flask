  /* ================================================================
     通知设置（设置 → 通知）
     - 浏览器通知（Web Notification API，服务器本机系统通知兜底）+ SMTP 邮件
     - 保存/加载/测试三条通道/清空历史/最近通知记录
     - 触发时机：AI 对话 done、智能体 done（后端已完成触发）
     ================================================================ */
  const NOTIFY_DEFAULTS = {
    enabled: false,
    scope: "both",
    channels: { desktop: true, smtp: false, telegram: false },
    template: { chat: "{task} · 回复完成", agent: "{task} · 回复完成" },
    template_body: "任务已完成：{summary}",
    summary_max_chars: 120,
    query_max_chars: 60,
    desktop: { sound: true, sound_name: "", timeout_ms: 5000, app_name: "File_Flask" },
    smtp: { host: "", port: 465, security: "ssl", username: "", password: "", from_addr: "", to: "", subject_prefix: "[File_Flask] ", test_recipient: "" },
    telegram: { bot_token: "", chat_id: "", message_thread_id: "", disable_notification: false, api_base: "https://api.telegram.org", proxy: "" },
  };

  /* ---------- 快速模板预设（标题 + 正文成对） ----------
     渲染规则必须与后端 notifications.render() 一致，见下面的 notifySubVars()。
     注意：这里的 {xxx} 是单花括号，Jinja 不会处理（写成双花括号会被 Jinja 吃掉）。 */
  const NOTIFY_PRESETS = [
    {
      id: "standard", name: "标准", icon: "bi-check2-circle",
      desc: "标题带任务名 + 一行摘要，三个通道都合适",
      title: "{task} · 回复完成",
      body: "任务已完成：{summary}",
    },
    {
      id: "minimal", name: "极简", icon: "bi-dash-circle",
      desc: "只有任务名和摘要，最不打扰",
      title: "{task} · 完成",
      body: "{summary}",
    },
    {
      id: "qa", name: "问答对照", icon: "bi-chat-left-quote",
      desc: "保留提问 + 回复，回头翻记录最快",
      title: "{task} · 回复完成",
      body: "问：{query}\n答：{summary}",
    },
    {
      id: "report", name: "结构化报告", icon: "bi-clipboard-data",
      desc: "带时间与字数，适合邮件 / Telegram 归档",
      title: "📬 {task} · {time}",
      body: "🕒 {date} {time}\n❓ 任务：{query}\n💬 回复：{summary}\n📏 字数：{answer_len}",
    },
    {
      id: "plain", name: "纯文本", icon: "bi-fonts",
      desc: "无表情符号，兼容老系统通知中心 / 老邮箱",
      title: "{task} 任务完成",
      body: "{query}\n\n{summary}",
    },
  ];

  /* 模板可用变量（与后端 render() 保持一致；未列出的变量会原样输出） */
  const NOTIFY_VARS = [
    { key: "task",       desc: "任务名：AI 助手 / AI 智能体" },
    { key: "query",      desc: "提问 / 任务描述（过长自动截断）" },
    { key: "summary",    desc: "回复摘要（过长自动截断，默认 120 字）" },
    { key: "answer_len", desc: "回复字数（不计空白）" },
    { key: "time",       desc: "触发时间，如 14:32" },
    { key: "date",       desc: "触发日期，如 2026-10-04" },
    { key: "answer",     desc: "回复全文（不截断，邮件里想看完整内容时用）" },
    { key: "title",      desc: "通道默认标题" },
    { key: "channel",    desc: "chat / agent" },
  ];

  /* 效果预览用的示例数据（模拟一次 AI 对话完成） */
  const NOTIFY_PREVIEW_SAMPLE = {
    title: "AI 助手 · 回复完成",
    task: "AI 助手",
    channel: "chat",
    query: "把 app.js 里的 fetch 请求都改成 axios，并补上错误处理",
    answer: "已替换 app.js 中 3 处 fetch 调用为 axios，并统一了 try/catch 与失败提示，另外抽了一个 request() 封装方便后续复用。",
    time: "14:32",
    date: "2026-10-04",
  };

  /* 预览变量上限：与后端默认值（query_max_chars / summary_max_chars）一致 */
  const NOTIFY_PREVIEW_MAX = { query: 60, summary: 120 };

  // 后端是"每个模板字符串都用同一集合替换一次"，这里保持一致：未知变量原样保留。
  function notifySubVars(tpl, vars) {
    return String(tpl == null ? "" : tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m);
  }

  // 与后端 _truncate() 一致：压缩空白 → 超长截断 + 省略号
  function notifyClip(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    if (n && s.length > n) return s.slice(0, n).replace(/\s+$/, "") + "…";
    return s;
  }

  // 用示例数据算出一份"渲染变量表"
  function notifyPreviewVars() {
    const s = NOTIFY_PREVIEW_SAMPLE;
    return {
      title: s.title,
      task: s.task,
      channel: s.channel,
      query: notifyClip(s.query, NOTIFY_PREVIEW_MAX.query),
      summary: notifyClip(s.answer, NOTIFY_PREVIEW_MAX.summary),
      answer: s.answer,
      answer_len: String(s.answer.replace(/\s+/g, "").length),
      time: s.time,
      date: s.date,
    };
  }

  // 刷新"效果预览"与变量高亮
  function notifyPreviewRefresh() {
    const tOut = document.getElementById("notifyPreviewTitle");
    const bOut = document.getElementById("notifyPreviewBody");
    if (!tOut || !bOut) return;
    const tEl = document.getElementById("notifyTitle");
    const bEl = document.getElementById("notifyBody");
    const rawTitle = tEl ? tEl.value : "";
    const rawBody = bEl ? bEl.value : "";
    const vars = notifyPreviewVars();

    tOut.textContent = notifySubVars(rawTitle, vars).trim() || "（标题为空）";
    bOut.textContent = notifySubVars(rawBody, vars).trim() || "（正文为空）";

    // 高亮"当前正好等于某个预设"的按钮
    document.querySelectorAll(".notify-preset").forEach(el => {
      const p = NOTIFY_PRESETS.find(x => x.id === el.dataset.preset);
      el.classList.toggle("active", !!p && p.title === rawTitle.trim() && p.body === rawBody.trim());
    });

    // 未知变量提示：写了后端不认识的变量，会原样发给用户
    const used = (rawTitle + "\n" + rawBody).match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || [];
    const unknown = Array.from(new Set(used.map(x => x.slice(1, -1))))
      .filter(k => !Object.prototype.hasOwnProperty.call(vars, k));
    const note = document.getElementById("notifyPreviewNote");
    if (note) {
      note.style.display = unknown.length ? "" : "none";
      note.innerHTML = unknown.length
        ? '<i class="bi bi-exclamation-triangle"></i> 未知变量 ' +
          unknown.map(k => "<code>{" + k + "}</code>").join(" ") + " 会原样显示"
        : "";
    }
  }

  function notifyApplyPreset(id) {
    const p = NOTIFY_PRESETS.find(x => x.id === id);
    if (!p) return;
    const tEl = document.getElementById("notifyTitle");
    const bEl = document.getElementById("notifyBody");
    if (tEl) tEl.value = p.title;
    if (bEl) bEl.value = p.body;
    notifyPreviewRefresh();
    notifyToast("已套用模板：" + p.name, "ok");
  }

  // 点变量胶囊 → 插入到最后聚焦的那个输入框
  let _notifyLastField = "notifyBody";
  function notifyInsertVar(v) {
    const el = document.getElementById(_notifyLastField) || document.getElementById("notifyBody");
    if (!el) return;
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + v + el.value.slice(end);
    try { el.focus(); el.setSelectionRange(start + v.length, start + v.length); } catch (_) {}
    notifyPreviewRefresh();
  }

  /* 通知分区 HTML：由设置页 buildSettingsContent() 调用。
     结构（markup）与逻辑统一放在本文件，避免通知模块代码散落在设置页 JS 里。 */
  function notifyBuildSectionHTML() {
    return '<div class="set-sec" id="sec-notify" data-kw="通知 notify email 邮件 浏览器 桌面 toast 提示">' +
      '<h2><i class="bi bi-bell"></i> 通知</h2>' +
      '<div class="set-desc" data-kw="通知 notify 邮件 smtp telegram tg 机器人 浏览器">AI 消息完成后向"启动服务的本人"推送。<b>浏览器通知</b>通过浏览器通知 API 推送到当前浏览器（需授权），服务器本机系统通知作为兜底；<b>邮件</b>通过 SMTP 发送；<b>Telegram</b> 通过自建 Bot 推送。默认关闭。</div>' +

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
          '<div class="notify-channel-card tg set-row" data-kw="telegram tg bot 机器人 电报">' +
            '<div class="notify-icon"><i class="bi bi-telegram"></i></div>' +
            '<div class="notify-channel-info"><div class="notify-label">Telegram（Bot）</div><div class="notify-desc">自建 Bot 推送到指定私聊 / 群组 / 话题。</div></div>' +
            '<label class="set-switch"><input type="checkbox" id="notifyTelegram"><span></span></label>' +
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
        '<div class="notify-card-title"><i class="bi bi-envelope-at"></i> SMTP 设置</div>' +
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

      '<div class="notify-card notifyTelegramOpts">' +
        '<div class="notify-card-title"><i class="bi bi-telegram"></i> Telegram Bot 设置</div>' +
        '<div class="notify-row stack set-row" data-kw="bot token 令牌 token">' +
          '<div class="notify-label-wrap"><div class="notify-label">Bot Token</div><div class="notify-desc">在 @BotFather 创建 Bot 后获得，形如 <code>123456:ABC-DEF…</code>；保存后仅显示 ****。</div></div>' +
          '<form class="notify-pwd-form" autocomplete="off" onsubmit="return false">' +
            '<input class="notify-input" id="notifyTgToken" type="password" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" autocomplete="off">' +
          '</form>' +
        '</div>' +
        '<div class="notify-grid-2">' +
          '<div class="notify-row stack set-row" data-kw="chat id 会话 群组">' +
            '<div class="notify-label-wrap"><div class="notify-label">Chat ID</div><div class="notify-desc">私聊 / 群组的会话 ID，可向 <code>@userinfobot</code> 获取。</div></div>' +
            '<input class="notify-input" id="notifyTgChat" placeholder="-1001234567890">' +
          '</div>' +
          '<div class="notify-row stack set-row" data-kw="话题 thread topic">' +
            '<div class="notify-label-wrap"><div class="notify-label">话题 ID（可选）</div><div class="notify-desc">群组开启「话题 / Topics」时，发送到指定话题。</div></div>' +
            '<input class="notify-input" id="notifyTgThread" placeholder="留空则不指定">' +
          '</div>' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="api base 反代 地址">' +
          '<div class="notify-label-wrap"><div class="notify-label">API 地址（可选）</div><div class="notify-desc">默认 <code>https://api.telegram.org</code>；无法直连时可填自建 / 反代地址。</div></div>' +
          '<input class="notify-input" id="notifyTgApiBase" placeholder="https://api.telegram.org">' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="代理 proxy socks5 加速 直连">' +
          '<div class="notify-label-wrap"><div class="notify-label">代理（只给这个 Bot 用）</div>' +
          '<div class="notify-desc"><b>只有 Telegram 通道走这个代理</b>，邮件 / 浏览器通知照常直连，互不影响。' +
          '支持 <code>http://127.0.0.1:7890</code>、<code>socks5://127.0.0.1:1080</code>；留空 = 直连。</div></div>' +
          '<input class="notify-input" id="notifyTgProxy" placeholder="留空 = 直连（不走代理）" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="notify-row inline set-row" data-kw="静音 silent 免打扰">' +
          '<div class="notify-label-wrap"><div class="notify-label">静音发送</div><div class="notify-desc">发送时客户端不响铃 / 不震动。</div></div>' +
          '<label class="set-switch"><input type="checkbox" id="notifyTgSilent"><span></span></label>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-pencil-square"></i> 通知模板</div>' +
        '<div class="notify-row stack set-row" data-kw="快速模板 预设 preset 模板 template">' +
          '<div class="notify-label-wrap"><div class="notify-label">快速模板</div>' +
          '<div class="notify-desc">点一下同时套用标题 + 正文，下面的预览即时生效；套用后仍可自由修改。</div></div>' +
          '<div class="notify-presets">' +
            NOTIFY_PRESETS.map(p =>
              '<button type="button" class="notify-preset" data-preset="' + p.id + '" data-kw="' + p.name + '" title="' + p.desc + '">' +
                '<i class="bi ' + p.icon + '"></i> ' + p.name +
              '</button>').join("") +
          '</div>' +
        '</div>' +
        '<div class="notify-preview set-row" data-kw="效果预览 预览 preview 通知示例">' +
          '<div class="notify-preview-head"><span><i class="bi bi-eye"></i> 效果预览</span>' +
          '<span class="notify-preview-tag">示例数据</span></div>' +
          '<div class="notify-preview-card">' +
            '<div class="notify-preview-app"><i class="bi bi-bell-fill"></i> File_Flask<span>刚刚</span></div>' +
            '<div class="notify-preview-title" id="notifyPreviewTitle">—</div>' +
            '<div class="notify-preview-body" id="notifyPreviewBody">—</div>' +
          '</div>' +
          '<div class="notify-preview-note" id="notifyPreviewNote" style="display:none;"></div>' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="标题模板 title">' +
          '<div class="notify-label-wrap"><div class="notify-label">标题模板</div>' +
          '<div class="notify-desc">AI 助手与智能体共用；用 <code>{task}</code> 可自动区分两者。</div></div>' +
          '<input class="notify-input" id="notifyTitle" placeholder="{task} · 回复完成">' +
        '</div>' +
        '<div class="notify-vars set-row" data-kw="变量 variable 可用变量">' +
          '<span class="notify-vars-tip">可用变量（点击插入）</span>' +
          NOTIFY_VARS.map(v =>
            '<button type="button" class="notify-var" data-var="{' + v.key + '}" title="' + v.desc + '">{' + v.key + '}</button>').join("") +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="正文模板 body">' +
          '<div class="notify-label-wrap"><div class="notify-label">正文模板</div>' +
          '<div class="notify-desc">支持换行；过长内容按「回复摘要长度」自动截断。</div></div>' +
          '<textarea class="notify-input notify-textarea" id="notifyBody" rows="3" placeholder="任务已完成：{summary}"></textarea>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-gear-wide-connected"></i> 操作</div>' +
        '<div class="notify-desc" style="margin:0 0 12px;">保存后立即生效；测试会按所选通道发一条真实通知。</div>' +
        '<div class="notify-actions" data-kw="测试 保存 test save">' +
          '<button class="notify-btn" id="notifyTestLocal"><i class="bi bi-bell"></i> 测试浏览器</button>' +
          '<button class="notify-btn" id="notifyTestEmail"><i class="bi bi-envelope"></i> 测试邮件</button>' +
          '<button class="notify-btn" id="notifyTestTelegram"><i class="bi bi-telegram"></i> 测试 Telegram</button>' +
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
    // 兼容旧记录：早期版本把通道平铺在顶层（rec.desktop），没有 channels 汇总
    const dk = (rec.channels && rec.channels.desktop !== undefined)
      ? rec.channels.desktop
      : rec.desktop;                             // 只镜像 desktop（浏览器）通道
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
          notifyRefreshHistoryOnly();     // 设置面板开着的话，列表同步更新
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

  // 只刷新历史列表（新通知到达时调用）。
  // 这里刻意不走 notifyLoad()：那个会用服务端配置回填整张表单，
  // 会把用户正在编辑、还没保存的模板冲掉。
  async function notifyRefreshHistoryOnly() {
    if (!document.getElementById("notifyHistory")) return;   // 设置面板没打开就不用管
    try {
      const r = await fetch("/api/ai/notify");
      const d = await r.json();
      if (d && d.recent) notifyRenderHistory(d.recent);
    } catch (_) {}
  }

  function notifyFill(cfg) {
    const q = id => document.getElementById(id);
    const ch = cfg.channels || {};
    const dk = cfg.desktop || {};
    const sk = cfg.smtp || {};
    const tg = cfg.telegram || {};
    const tp = cfg.template || {};
    // 兼容"channels.desktop 是 bool"
    const desktopOn = typeof ch.desktop === "object" ? !!ch.desktop.enabled : !!ch.desktop;
    const smtpOn = typeof ch.smtp === "object" ? !!ch.smtp.enabled : !!ch.smtp;
    const tgOn = typeof ch.telegram === "object" ? !!ch.telegram.enabled : !!ch.telegram;

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

    if (q("notifyTelegram"))       q("notifyTelegram").checked = tgOn;
    if (q("notifyTgChat"))         q("notifyTgChat").value = tg.chat_id || "";
    if (q("notifyTgThread"))       q("notifyTgThread").value = tg.message_thread_id || "";
    if (q("notifyTgApiBase"))      q("notifyTgApiBase").value = tg.api_base || "https://api.telegram.org";
    if (q("notifyTgProxy"))        q("notifyTgProxy").value = tg.proxy || "";
    if (q("notifyTgSilent"))       q("notifyTgSilent").checked = !!tg.disable_notification;
    if (q("notifyTgToken")) {
      q("notifyTgToken").value = "";
      q("notifyTgToken").placeholder = tg.token_set ? "已保存（留空保持不变）" : "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
    }

    if (q("notifyTitle"))          q("notifyTitle").value = tp.chat || NOTIFY_DEFAULTS.template.chat;
    if (q("notifyBody"))           q("notifyBody").value = cfg.template_body || NOTIFY_DEFAULTS.template_body;

    notifyToggleOptVisibility();
    notifyPreviewRefresh();
  }

  function notifyToggleOptVisibility() {
    const desktopOn = document.getElementById("notifyDesktop")?.checked;
    document.querySelectorAll(".notifyDesktopOpts").forEach(el => el.style.display = desktopOn ? "" : "none");
    const emailOn = document.getElementById("notifyEmail")?.checked;
    document.querySelectorAll(".notifyEmailOpts").forEach(el => el.style.display = emailOn ? "" : "none");
    const tgOn = document.getElementById("notifyTelegram")?.checked;
    document.querySelectorAll(".notifyTelegramOpts").forEach(el => el.style.display = tgOn ? "" : "none");
  }

  function notifyReadForm() {
    const q = id => document.getElementById(id)?.value ?? "";
    const c = id => document.getElementById(id)?.checked ?? false;
    // 标题模板 AI 助手 / 智能体共用一份，用 {task} 变量自动区分两者
    const titleTpl = q("notifyTitle").trim() || NOTIFY_DEFAULTS.template.chat;
    const bodyTpl = q("notifyBody").replace(/[ \t]+$/gm, "").trim() || NOTIFY_DEFAULTS.template_body;
    return {
      enabled: c("notifyEnabled"),
      scope: "both",
      channels: { desktop: c("notifyDesktop"), smtp: c("notifyEmail"), telegram: c("notifyTelegram") },
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
      telegram: {
        bot_token: q("notifyTgToken").trim(),   // 空字符串表示"保持不变"
        chat_id: q("notifyTgChat").trim(),
        message_thread_id: q("notifyTgThread").trim(),
        api_base: q("notifyTgApiBase").trim() || "https://api.telegram.org",
        proxy: q("notifyTgProxy").trim(),   // 仅 Telegram 使用；空 = 直连
        disable_notification: c("notifyTgSilent"),
      },
      template: Object.assign(
        { chat: titleTpl },
        // 标题里带 {task} / {title} / {channel} 变量时，AI 助手与智能体共用同一模板（变量会自动区分）；
        // 否则保留磁盘上的 agent 标题，避免把「AI 助手」的标题套到智能体的通知上。
        /\{(?:task|title|channel)\}/.test(titleTpl) ? { agent: titleTpl } : {}
      ),
      template_body: bodyTpl,
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
      // Telegram Token 同理：清空输入框，按是否已保存切换 placeholder
      const tk = document.getElementById("notifyTgToken");
      if (tk) {
        tk.value = "";
        tk.placeholder = (d.cfg && d.cfg.telegram && d.cfg.telegram.token_set)
          ? "已保存（留空保持不变）"
          : "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
      }
    } catch (e) {
      notifyToast("保存失败：" + e.message, "err");
    }
  }

  const _notifyTestBtnId = { desktop: "notifyTestLocal", email: "notifyTestEmail", telegram: "notifyTestTelegram", all: "notifyTestAll" };

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
        const chName = { desktop: "浏览器", email: "邮件", telegram: "Telegram", all: "全部通道" }[channel] || channel;
        notifyToast(`测试通知已发送（${chName}）`, "ok");
      } else {
        const parts = [];
        const chLabel = { desktop: "桌面", smtp: "邮件", telegram: "Telegram" };
        if (d.results) for (const [k, v] of Object.entries(d.results)) {
          if (!v) continue;   // 未参与本次测试的通道后端返回 null，跳过
          parts.push(`${chLabel[k] || k}: ${v.ok ? "✅" : "❌"} ${(v.detail || v.error || "").slice(0, 200)}`);
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
    if (!(await uiConfirm("清空通知记录", "确定清空全部通知记录？此操作不可恢复。", "清空", true))) return;
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

  /* ---------- 历史记录字段归一化 ----------
     后端记录格式：{ id, kind: chat|agent|test, title, body, ts,
                     channels: { desktop: {ok, detail}, ... } }
     旧记录没有 kind、也没有 channels 汇总（只有平铺的 desktop/smtp/telegram），
     这里统一兼容，避免列表里出现 "[unknown]"、"—" 这类无意义占位。 */
  const NOTIFY_KIND_META = {
    chat:  { icon: "💬", name: "AI 助手" },
    agent: { icon: "🤖", name: "AI 智能体" },
    test:  { icon: "🧪", name: "测试通知" },
  };
  const NOTIFY_CH_NAME = { desktop: "桌面", smtp: "邮件", telegram: "Telegram" };

  function notifyEsc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 来源场景：新记录读 kind，旧记录退回 channel
  function notifyKindMeta(r) {
    const k = String((r && r.kind) || (r && r.channel) || "").toLowerCase();
    return NOTIFY_KIND_META[k] || { icon: "📢", name: "通知" };
  }

  // 本次真正走到的通道（未启用的通道后端存 null，直接跳过）
  function notifyChannelsOf(r) {
    const src = (r && r.channels && typeof r.channels === "object" && !Array.isArray(r.channels))
      ? r.channels
      : { desktop: r && r.desktop, smtp: r && r.smtp, telegram: r && r.telegram };
    const out = [];
    for (const key of ["desktop", "smtp", "telegram"]) {
      const v = src[key];
      if (v === null || v === undefined) continue;
      if (typeof v === "boolean") { out.push({ key, ok: v, detail: "" }); continue; }
      if (typeof v !== "object") continue;
      out.push({ key, ok: !!v.ok, detail: v.detail ? String(v.detail) : "" });
    }
    return out;
  }

  function notifyAbsTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return "—";
    const d = new Date(t * 1000);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function notifyRelTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return "";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - t);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 604800) return Math.floor(diff / 86400) + " 天前";
    return "";
  }

  function notifyRenderHistory(records) {
    const box = document.getElementById("notifyHistory");
    if (!box) return;
    if (!records || !records.length) {
      box.innerHTML = '<div class="notify-history-empty"><i class="bi bi-inbox"></i>暂无通知记录<div>AI 对话或智能体任务完成后会自动出现在这里。</div></div>';
      return;
    }
    box.innerHTML = records.map(r => {
      const meta = notifyKindMeta(r);
      const chats = notifyChannelsOf(r);
      const chips = chats.length
        ? chats.map(c => {
            const tip = c.detail ? ` title="${notifyEsc(c.detail)}"` : "";
            return `<span class="notify-hch ${c.ok ? "ok" : "fail"}"${tip}>` +
                   `<i class="bi ${c.ok ? "bi-check-circle" : "bi-x-circle"}"></i>` +
                   `${NOTIFY_CH_NAME[c.key] || c.key}</span>`;
          }).join("")
        : `<span class="notify-hch skip"><i class="bi bi-slash-circle"></i>未发送</span>`;
      const rawTitle = String(r.title || "").trim();
      const rawBody = String(r.body || "").trim();
      const title = notifyEsc(rawTitle.length > 120 ? rawTitle.slice(0, 120) + "…" : rawTitle) || "（无标题）";
      const body = notifyEsc(rawBody.length > 400 ? rawBody.slice(0, 400) + "…" : rawBody);
      const abs = notifyAbsTime(r.ts);
      const rel = notifyRelTime(r.ts);
      // 标题模板里常已含来源名（如 "📬 AI 助手 · 14:33"），此时 meta 只显示时间，避免重复
      const namePrefix = (meta.name && !rawTitle.includes(meta.name)) ? meta.name + " · " : "";
      return `<div class="notify-hitem">` +
        `<div class="notify-hicon" title="${meta.name}">${meta.icon}</div>` +
        `<div class="notify-hbody">` +
          `<div class="notify-htitle"><span>${title}</span>` +
          `<span class="notify-hmeta" title="${abs}">${namePrefix}${rel || abs}</span></div>` +
          `<div class="notify-hchannels">${chips}</div>` +
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
        if (t.id === "notifyTitle" || t.id === "notifyBody") notifyPreviewRefresh();
      }, true);
      document.addEventListener("change", e => {
        const t = e.target;
        if (!t || !t.id || !t.id.startsWith("notify")) return;
        notifyToggleOptVisibility();
        // 开启「浏览器通知」时，向浏览器申请通知权限
        if (t.id === "notifyDesktop" && t.checked) notifyRequestBrowserPermission();
      }, true);
      // 记住最后编辑的模板字段，点变量胶囊时插入到那里
      document.addEventListener("focusin", e => {
        const t = e.target;
        if (t && (t.id === "notifyTitle" || t.id === "notifyBody")) _notifyLastField = t.id;
      }, true);

      document.addEventListener("click", e => {
        // 快速模板 / 变量胶囊（也是 button，需要先于下面的按钮分派处理）
        const presetBtn = e.target && e.target.closest ? e.target.closest(".notify-preset") : null;
        if (presetBtn) { notifyApplyPreset(presetBtn.dataset.preset); return; }
        const varBtn = e.target && e.target.closest ? e.target.closest(".notify-var") : null;
        if (varBtn) { notifyInsertVar(varBtn.dataset.var); return; }
        // 按钮内含 <i> 图标，e.target 可能是图标而不是按钮，统一向上找最近的 button
        const btn = e.target && e.target.closest ? e.target.closest("button") : null;
        const id = btn ? btn.id : (e.target ? e.target.id : "");
        if (id === "notifySave") notifySave();
        else if (id === "notifyTestLocal") notifyTest("desktop", btn);
        else if (id === "notifyTestEmail") notifyTest("email", btn);
        else if (id === "notifyTestTelegram") notifyTest("telegram", btn);
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
      notifyPreviewRefresh();
      if (document.getElementById("notifyHistory")) notifyLoad();
    }, 100);
  }
