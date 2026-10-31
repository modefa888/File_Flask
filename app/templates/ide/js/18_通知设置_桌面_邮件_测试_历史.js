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
    // 插到哪个分区的输入框，就刷新哪个分区的预览
    if (_notifyLastField === "dlNotifyTitle" || _notifyLastField === "dlNotifyBody") dlNotifyPreviewRefresh();
    else notifyPreviewRefresh();
  }

  /* 通知分区 HTML：由设置页 buildSettingsContent() 调用。
     结构（markup）与逻辑统一放在本文件，避免通知模块代码散落在设置页 JS 里。 */
  /* ---------- 独立分区：定时任务通知（设置页左侧导航单独一项） ----------
     配置与「定时任务管理 → 设置」弹窗共用同一份（store.db 的 cron_cfg.notify），
     桌面 / 邮件 / Telegram 复用「通知」分区的全局通道配置，这里只做开关与事件选择。 */
  /* ================================================================
     通知渠道（设置 → 通知渠道）
     一个渠道可以配置多个账号：邮件多个收件账号、Telegram 多个群、
     钉钉多个机器人……「通知」与「定时任务通知」只勾选账号，不再各自填参数。
     配置存服务端（/api/notify/channels），密钥字段脱敏返回。
     ================================================================ */
  const NOTIFY_CH_DEFS = {
    desktop: {
      name: "浏览器 / 桌面通知", icon: "bi-bell", desc: "服务器本机弹系统通知，网页端同时镜像到浏览器",
      fields: [
        { k: "app_name", label: "应用名", ph: "File_Flask" },
        { k: "sound", label: "播放提示音", type: "bool" },
      ],
    },
    email: {
      name: "邮件（SMTP）", icon: "bi-envelope", desc: "QQ / 163 / Gmail / Outlook 等 SMTP 发信",
      // 必填字段：没填完就不能再加下一个账号（避免一堆半成品账号）
      required: ["to", "host", "username", "password"],
      fields: [
        { k: "to", label: "收件人", ph: "me@example.com", full: true, hint: "多个用英文逗号分隔" },
        { k: "host", label: "SMTP 服务器", ph: "smtp.qq.com" },
        { k: "port", label: "端口", type: "number", ph: "465" },
        { k: "security", label: "加密方式", type: "select", options: [["ssl", "SSL（465）"], ["tls", "STARTTLS（587）"], ["none", "不加密"]] },
        { k: "username", label: "发件人账号", ph: "me@example.com" },
        { k: "password", label: "授权码 / 密码", type: "password", ph: "授权码" },
        { k: "from_addr", label: "发件人地址", ph: "留空 = 用账号" },
        { k: "from_name", label: "发件人显示名", ph: "File_Flask" },
      ],
    },
    telegram: {
      name: "Telegram", icon: "bi-telegram", desc: "Bot 推送到私聊 / 群组 / 话题",
      required: ["bot_token", "chat_id"],
      fields: [
        { k: "bot_token", label: "Bot Token", type: "password", ph: "123456:ABC-DEF…", full: true },
        { k: "chat_id", label: "Chat ID", ph: "-1001234567890" },
        { k: "message_thread_id", label: "话题 ID", ph: "留空不指定" },
        { k: "api_base", label: "API 地址", ph: "https://api.telegram.org" },
        { k: "proxy", label: "代理", ph: "留空 = 直连" },
        { k: "disable_notification", label: "静音发送", type: "bool" },
      ],
    },
    dingtalk: {
      name: "钉钉机器人", icon: "bi-chat-dots", desc: "群机器人 Webhook，支持加签",
      required: ["webhook"],
      fields: [
        { k: "webhook", label: "Webhook 地址", ph: "https://oapi.dingtalk.com/robot/send?access_token=…", full: true },
        { k: "secret", label: "加签密钥", ph: "SEC…（留空不加签）" },
      ],
    },
    pushplus: {
      name: "PushPlus", icon: "bi-wechat", desc: "推送到微信（www.pushplus.plus）",
      required: ["token"],
      fields: [
        { k: "token", label: "Token", ph: "推送 token" },
        { k: "topic", label: "群组编码", ph: "留空 = 发给自己" },
      ],
    },
    web: {
      name: "网页版", icon: "bi-globe2", desc: "生成 Markdown 渲染页，地址按任务唯一",
      fields: [
        { k: "base_url", label: "站点地址", ph: "留空自动推断" },
        { k: "retention_days", label: "保留天数", type: "number", ph: "7" },
        { k: "link_enabled", label: "在其它渠道附加网页入口", type: "bool" },
        { k: "link_text", label: "入口文字", ph: "网页通知" },
        { k: "link_url", label: "固定跳转地址", ph: "留空 = 各任务自己的 /n/…" },
      ],
    },
  };
  const NOTIFY_CH_ORDER = ["desktop", "email", "telegram", "dingtalk", "pushplus", "web"];

  let _nacc = null;                 // {channel: [ {id,name,cfg} ]}
  let _naccTimer = null;
  let _naccSaving = false;
  // 本地改动序号：每次增删改 +1。保存请求返回时若序号已变（期间又改过），
  // 就不用服务端的旧快照覆盖内存，避免「刚删的账号又冒回来」。
  let _naccVer = 0;
  // 上次真正落库的内容（JSON）。内容没变就不发请求，
  // 所以「点开一个空账号 / 什么都没填」不会写库、也不会显示「已自动保存」。
  let _naccSavedJson = "";

  function notifyChannelsBuildSectionHTML() {
    return '<div class="set-sec" id="sec-channels" data-kw="通知渠道 账号 邮箱 smtp telegram 钉钉 pushplus 网页版 桌面">' +
      '<h2 data-kw="通知渠道 账号 邮箱 smtp telegram 钉钉 pushplus 网页版 桌面"><i class="bi bi-hdd-network"></i> 通知渠道</h2>' +
      '<div class="set-desc" data-kw="通知渠道 账号 邮箱 smtp telegram 钉钉 pushplus 网页版 桌面">' +
        '统一维护「发到哪里」：同一个渠道可以添加多个账号（多个邮箱、多个 Telegram 群、多个钉钉机器人）。' +
        '「AI 通知」与「定时任务通知」只负责勾选账号。密钥只保存在服务器本地。</div>' +
      // 不再需要「保存」按钮：改动自动落库；这行状态跟着滚动吸顶，滚到哪都能看到存没存
      '<div class="nacc-status"><span class="nacc-tip" id="notifyChannelsTip">改动会自动保存</span></div>' +
      '<div id="notifyChannelsBox" class="nacc-list"><div class="notify-history-empty">加载中…</div></div>' +
    '</div>';
  }

  function naccEsc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function naccBlank(channel) {
    const out = {};
    (NOTIFY_CH_DEFS[channel] || { fields: [] }).fields.forEach(f => {
      out[f.k] = f.type === "bool" ? (f.k === "link_enabled" || f.k === "sound") : "";
    });
    return out;
  }

  /* 提交给服务端的结构：只保留 id / name / cfg，
     并且**丢掉用户还没动过的草稿账号**（新加但一个字没填的空账号不落库） */
  function naccPayload() {
    const out = {};
    NOTIFY_CH_ORDER.forEach(ch => {
      out[ch] = (_nacc && _nacc[ch] || [])
        .filter(a => !a._draft || a._touched)
        .map(a => ({ id: a.id, name: a.name || "", cfg: a.cfg || {} }));
    });
    return out;
  }

  /* ---------- 完成度：必填字段都填了才算「已配置」 ---------- */
  function naccFieldDef(channel, k) {
    return ((NOTIFY_CH_DEFS[channel] || {}).fields || []).find(f => f.k === k) || null;
  }

  function naccFieldFilled(channel, acc, k) {
    const cfg = (acc && acc.cfg) || {};
    const f = naccFieldDef(channel, k);
    // 服务端对密钥类字段（邮箱授权码、TG Token、钉钉 Webhook…）会回传掩码 + *_set 标志，
    // 有标志就说明早就存过了，算已填
    if (cfg[k + "_set"]) return true;
    if (!f) return !!String(cfg[k] == null ? "" : cfg[k]).trim();
    if (f.type === "bool") return true;                       // 勾选项永远算已填
    return !!String(cfg[k] == null ? "" : cfg[k]).trim();
  }

  function naccMissing(channel, acc) {
    return (((NOTIFY_CH_DEFS[channel] || {}).required) || [])
      .filter(k => !naccFieldFilled(channel, acc, k));
  }

  function naccComplete(channel, acc) {
    return naccMissing(channel, acc).length === 0;
  }

  function naccMissingLabels(channel, acc) {
    return naccMissing(channel, acc)
      .map(k => (naccFieldDef(channel, k) || {}).label || k).join("、");
  }

  /* 折叠状态：按 渠道:id 记住用户的选择；没记录过的账号「配置完整就默认收起」，
     没填完的默认展开，省得一进页面就是一屏表单。 */
  const _naccCollapsed = {};
  function naccCollapsedOf(channel, acc) {
    if (!naccComplete(channel, acc)) return false;   // 没填完的一律展开，别把必填项藏起来
    const key = channel + ":" + acc.id;
    if (Object.prototype.hasOwnProperty.call(_naccCollapsed, key)) return !!_naccCollapsed[key];
    return false;                       // 没记录过的账号默认展开
  }

  /* 载入时给「已配置完成」的账号设默认收起（之后跟随用户的手动展开 / 收起） */
  function naccSeedCollapsed() {
    NOTIFY_CH_ORDER.forEach(ch => {
      (_nacc[ch] || []).forEach(a => {
        const key = ch + ":" + a.id;
        if (!Object.prototype.hasOwnProperty.call(_naccCollapsed, key)) {
          _naccCollapsed[key] = naccComplete(ch, a);
        }
      });
    });
  }

  /* 是否正在编辑渠道账号的某个字段：是则先不重绘，免得输入法组词被打断 */
  function naccIsEditing() {
    const el = document.activeElement;
    return !!(el && el.dataset && (el.dataset.f || el.dataset.nchName) &&
              el.closest && el.closest("#notifyChannelsBox"));
  }

  /* 重绘会重建输入框：把焦点和光标位置还回去，避免「填完一格就被踢出输入」 */
  function naccFocusSig(el) {
    if (!el || !el.dataset || !(el.dataset.f || el.dataset.nchName)) return null;
    return { nch: el.dataset.nch, id: el.dataset.id,
             f: el.dataset.f || "", name: el.dataset.nchName || "" };
  }
  function naccRestoreFocus(sig) {
    if (!sig) return;
    let sel;
    try {
      sel = sig.name
        ? '.nacc-name[data-id="' + sig.id + '"]'
        : 'input[data-nch="' + sig.nch + '"][data-id="' + sig.id + '"][data-f="' + sig.f + '"]';
      const el = document.querySelector("#notifyChannelsBox " + sel);
      if (!el || el.offsetParent === null) return;     // 卡片收起时跳过
      el.focus();
      if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
    } catch (_) { /* 忽略：焦点恢复失败不影响保存 */ }
  }

  function naccToggleCard(channel, id, btn) {
    const key = channel + ":" + id;
    const acc = naccFind(channel, id);
    const cur = btn && btn.dataset ? btn.dataset.collapsed === "1" : naccCollapsedOf(channel, acc || { id: id });
    _naccCollapsed[key] = !cur;
    notifyChannelsRender();
  }

  /* 输入时就地刷新这一张卡的状态（徽标 / 还缺什么 / 必填高亮），
     不用整块重绘，既能即时反馈也不打断输入 */
  function naccRefreshCardStatus(channel, id) {
    const acc = naccFind(channel, id);
    const card = document.querySelector('#notifyChannelsBox .nacc-card[data-ch="' + channel +
      '"][data-id="' + id + '"]');
    if (!acc || !card) return;
    const done = naccComplete(channel, acc);
    card.classList.toggle("done", done);
    card.classList.toggle("todo", !done);

    const badge = card.querySelector(".nacc-badge");
    if (badge) {
      badge.classList.toggle("ok", done);
      badge.classList.toggle("warn", !done);
      badge.textContent = done ? "已配置" : "待完善";
      if (done) badge.removeAttribute("title");
      else badge.title = "还缺：" + naccMissingLabels(channel, acc);
    }
    const need = card.querySelector(".nacc-need");
    if (need) {
      if (done) need.remove();
      else need.innerHTML = '<i class="bi bi-info-circle"></i> 还缺：' + naccEsc(naccMissingLabels(channel, acc));
    }
    // 必填项漏填高亮
    card.querySelectorAll("[data-f]").forEach(el => {
      const k = el.dataset.f;
      const isReq = (((NOTIFY_CH_DEFS[channel] || {}).required) || []).indexOf(k) >= 0;
      const miss = isReq && !naccFieldFilled(channel, acc, k);
      const lab = el.closest(".nacc-f");
      if (lab) lab.classList.toggle("nacc-miss", miss);
    });
    // 这一张卡填完了，它下面的「填完才能继续添加」提示也该收起来
    if (done) {
      const nxt = card.nextElementSibling;
      if (nxt && nxt.classList && nxt.classList.contains("nacc-block-hint")) nxt.remove();
    }
  }

  function naccFieldHtml(channel, acc, f) {
    const cfg = acc.cfg || {};
    const raw = cfg[f.k];
    const idAttr = ' data-nch="' + channel + '" data-id="' + naccEsc(acc.id) + '" data-f="' + f.k + '"';
    const isReq = (((NOTIFY_CH_DEFS[channel] || {}).required) || []).indexOf(f.k) >= 0;
    const miss = isReq && !naccFieldFilled(channel, acc, f.k);
    const cls = "nacc-f" + (f.full ? " full" : "") + (miss ? " nacc-miss" : "");
    const star = isReq ? '<i class="nacc-req" title="必填">*</i>' : "";
    if (f.type === "bool") {
      // 与其他字段同样的「标签 + 控件」两行结构，勾选框才能和左边的输入框水平对齐
      return '<div class="nacc-f"><span>' + naccEsc(f.label) + star + '</span>' +
        '<label class="nacc-check"><input type="checkbox"' + idAttr +
          (raw === false ? "" : " checked") + '>' +
          '<span class="nacc-check-t"><span class="on">已开启</span><span class="off">已关闭</span></span>' +
        '</label></div>';
    }
    if (f.type === "select") {
      const opts = (f.options || []).map(o =>
        '<option value="' + naccEsc(o[0]) + '"' + (String(raw || o[0]) === o[0] ? " selected" : "") + '>' +
        naccEsc(o[1]) + '</option>').join("");
      return '<label class="' + cls + '"><span>' + naccEsc(f.label) + star + '</span>' +
        '<select' + idAttr + '>' + opts + '</select></label>';
    }
    if (f.type === "password") {
      const saved = !!cfg[f.k + "_set"];
      const val = saved ? "" : naccEsc(raw || "");
      const ph = saved ? "已保存（留空保持不变）" : (f.ph || "");
      return '<label class="' + cls + '"><span>' + naccEsc(f.label) + star + '</span>' +
        '<input type="password"' + idAttr + ' value="' + val + '" placeholder="' + naccEsc(ph) +
        '" autocomplete="new-password" data-lpignore="true" data-1p-ignore spellcheck="false"></label>';
    }
    // 密钥类字段（如钉钉 Webhook）服务端只回传掩码：这里留空 + 提示已保存，
    // 用户不填就保持原值（与密码框一致）
    const savedSec = !!cfg[f.k + "_set"];
    const tv = savedSec ? "" : naccEsc(raw == null ? "" : raw);
    const tph = savedSec ? "已保存（留空保持不变）" : (f.ph || "");
    return '<label class="' + cls + '"><span>' + naccEsc(f.label) + star + '</span>' +
      '<input type="' + (f.type === "number" ? "number" : "text") + '"' + idAttr +
      ' value="' + tv + '" placeholder="' + naccEsc(tph) +
      '" autocomplete="off" spellcheck="false"></label>';
  }

  /* 折叠时显示的一行摘要，方便一眼看出这个账号发到哪 */
  function naccSummary(channel, acc) {
    const c = (acc && acc.cfg) || {};
    let s = "";
    if (channel === "desktop") s = c.app_name || "";
    else if (channel === "email") s = c.to || "";
    else if (channel === "telegram") s = c.chat_id ? "Chat ID " + c.chat_id : "";
    else if (channel === "dingtalk") {
      const m = String(c.webhook || "").match(/^https?:\/\/([^/]+)/);
      s = m ? m[1] : (c.webhook_set ? "已配置 Webhook" : "");
    } else if (channel === "pushplus") s = c.topic || "";
    else if (channel === "web") s = c.base_url || "";
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > 42 ? s.slice(0, 42) + "…" : s;
  }

  function notifyChannelsRender() {
    const box = document.getElementById("notifyChannelsBox");
    if (!box) return;
    if (!_nacc) { box.innerHTML = '<div class="notify-history-empty">读取失败</div>'; return; }
    const focusSig = naccFocusSig(document.activeElement);
    box.innerHTML = NOTIFY_CH_ORDER.map(ch => {
      const def = NOTIFY_CH_DEFS[ch] || { name: ch, icon: "bi-bell", desc: "", fields: [] };
      const items = _nacc[ch] || [];
      // 第一个没填完的账号：提示直接贴在它下面，避免跑到组头让人误以为是别的问题
      const firstBad = items.findIndex(a => !naccComplete(ch, a));
      const cards = items.map((acc, idx) => {
        const fields = def.fields.map(f => naccFieldHtml(ch, acc, f)).join("");
        const done = naccComplete(ch, acc);
        const collapsed = naccCollapsedOf(ch, acc);
        const sum = collapsed ? naccSummary(ch, acc) : "";
        return '<div class="nacc-card' + (collapsed ? " collapsed" : "") + (done ? " done" : " todo") +
            '" data-ch="' + ch + '" data-id="' + naccEsc(acc.id) + '">' +
          '<div class="nacc-hd">' +
            // 只有「配置完整」的账号才有折叠按钮；没填完的保持展开，避免把必填项藏起来
            (done
              ? '<button class="nacc-toggle" data-nacc-act="toggle" data-ch="' + ch + '" data-id="' + naccEsc(acc.id) + '"' +
                ' data-collapsed="' + (collapsed ? "1" : "0") + '" title="' + (collapsed ? "展开配置" : "收起配置") + '">' +
                '<i class="bi ' + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + '"></i></button>'
              : '<span class="nacc-toggle-sp"></span>') +
            '<i class="bi ' + def.icon + ' nacc-ico-ch"></i>' +
            '<input class="nacc-name" data-nch-name="' + ch + '" data-id="' + naccEsc(acc.id) + '"' +
              ' value="' + naccEsc(acc.name || "") + '" placeholder="账号名称，如 运维群" autocomplete="off" spellcheck="false">' +
            (collapsed && sum ? '<span class="nacc-sum">' + naccEsc(sum) + '</span>' : '') +
            '<span class="nacc-badge ' + (done ? "ok" : "warn") + '"' +
              (done ? '' : ' title="还缺：' + naccEsc(naccMissingLabels(ch, acc)) + '"') + '>' +
              (done ? '已配置' : '待完善') + '</span>' +
            '<div class="nacc-ops">' +
              '<button class="nacc-ico" data-nacc-act="test" data-ch="' + ch + '" data-id="' + naccEsc(acc.id) + '"' +
                ' title="给这个账号发一条测试通知"><i class="bi bi-send"></i></button>' +
              '<button class="nacc-ico danger" data-nacc-act="del" data-ch="' + ch + '" data-id="' + naccEsc(acc.id) + '"' +
                ' title="删除该账号"><i class="bi bi-trash3"></i></button>' +
            '</div>' +
          '</div>' +
          (done ? '' : '<div class="nacc-need"><i class="bi bi-info-circle"></i> 还缺：' +
            naccEsc(naccMissingLabels(ch, acc)) + '</div>') +
          '<div class="nacc-grid">' + fields + '</div>' +
        '</div>' +
        (idx === firstBad
          ? '<div class="nacc-block-hint"><i class="bi bi-info-circle"></i> 填完这个账号的必填项，才能继续添加下一个</div>'
          : '');
      }).join("");
      // 有没填完的账号时，禁止继续添加，避免一个渠道里全是半成品
      const blocker = items.find(a => !naccComplete(ch, a));
      const addBtn = '<button class="notify-btn nacc-add" data-nacc-act="add" data-ch="' + ch + '"' +
        (blocker ? ' disabled title="请先填完「' + naccEsc(blocker.name || blocker.id) + '」的必填项（' +
                   naccEsc(naccMissingLabels(ch, blocker)) + '）再添加"' : '') + '>' +
        '<i class="bi bi-plus-lg"></i> 添加账号</button>';
      return '<div class="nacc-group" data-ch="' + ch + '">' +
        '<div class="nacc-group-hd">' +
          '<div class="nacc-group-tt"><i class="bi ' + def.icon + '"></i>' +
            '<span class="nacc-group-name">' + naccEsc(def.name) + '</span>' +
            '<span class="nacc-group-desc">' + naccEsc(def.desc || "") + '</span>' +
          '</div>' +
          '<div class="nacc-group-act">' +
            '<span class="nacc-group-n">' + items.length + ' 个账号</span>' +
            addBtn +
          '</div>' +
        '</div>' +
        (cards || '<div class="nacc-empty">该渠道还没有账号，点「添加账号」新建一个。</div>') +
      '</div>';
    }).join("");
    naccRestoreFocus(focusSig);
    notifyTargetsRefreshAll();     // 账号变了，两个分区的勾选列表同步刷新
  }

  async function notifyChannelsLoad(force) {
    // 设置页没打开、也没有别的地方要渲染账号（如下载中心的「通知」分区）时就不拉
    if (!document.getElementById("notifyChannelsBox") &&
        !document.getElementById("notifyTargets") &&
        !document.getElementById("cronNotifyTargets") &&
        !document.getElementById("dlNotifyTargets")) return;
    // 先把还在防抖队列里的改动落库，否则下面拉回来的服务端快照会把它覆盖掉
    // （表现就是「刚填的内容切个分区就没了」）
    await notifyChannelsFlush();
    if (_nacc && !force) { notifyChannelsRender(); return; }
    try {
      const r = await fetch("/api/notify/channels");
      const d = await r.json();
      if (d && d.channels) {
        _nacc = {};
        NOTIFY_CH_ORDER.forEach(ch => { _nacc[ch] = (d.channels[ch] || []).slice(); });
        _naccSavedJson = JSON.stringify({ channels: naccPayload() });   // 记住已落库的基线
        naccSeedCollapsed();          // 配置完整的账号默认收起
        notifyChannelsRender();
      }
    } catch (e) {
      const box = document.getElementById("notifyChannelsBox");
      if (box) box.innerHTML = '<div class="notify-history-empty">读取失败：' + naccEsc(e.message) + '</div>';
    }
  }

  function naccFind(channel, id) {
    return (_nacc && _nacc[channel] || []).find(a => a.id === id) || null;
  }

  function notifyChannelsAdd(channel) {
    if (!_nacc) return;
    // 前置校验：该渠道里还有没填完的账号时，不允许继续添加
    const blocker = (_nacc[channel] || []).find(a => !naccComplete(channel, a));
    if (blocker) {
      notifyToast("请先填完「" + (blocker.name || blocker.id) + "」的必填项（" +
        naccMissingLabels(channel, blocker) + "）再添加账号", "warn");
      return;
    }
    const id = channel + "-" + Math.random().toString(16).slice(2, 10);
    _nacc[channel] = _nacc[channel] || [];
    const def = NOTIFY_CH_DEFS[channel] || { name: channel };
    // _draft：还没填任何内容的草稿，只在界面上占个位，不落库
    _nacc[channel].push({ id: id, channel: channel, _draft: true,
      name: def.name + " " + (_nacc[channel].length + 1), cfg: naccBlank(channel) });
    _naccVer++;
    notifyChannelsRender();
    // 空账号不保存：等用户真的填了内容，输入事件触发的自动保存才会把它写进去
    const tip = document.getElementById("notifyChannelsTip");
    if (tip) tip.textContent = "新账号填入内容后才会保存";
  }

  /* 删除前的二次确认：优先用全局的「贴着按钮弹出」悬浮框（02_查找替换 里导出），
     拿不到时退回居中弹窗；都没有才直接放行，避免功能卡死。 */
  function naccConfirmDelete(anchor, acc) {
    const title = "删除通知账号";
    const msg = "确定删除「" + (acc.name || acc.id) + "」吗？" +
      "删除后「AI 通知」与「定时任务通知」里对该账号的勾选会一并失效。";
    if (anchor && typeof window.uiConfirmPop === "function") {
      return window.uiConfirmPop(anchor, { title: title, msg: msg, okText: "删除", danger: true });
    }
    if (typeof uiConfirm === "function") {
      return uiConfirm(title, msg, "删除", true);
    }
    return Promise.resolve(true);
  }

  async function notifyChannelsDel(channel, id, btn) {
    const acc = naccFind(channel, id);
    if (!acc) return;
    const ok = await naccConfirmDelete(btn || null, acc);
    if (!ok) return;

    _nacc[channel] = (_nacc[channel] || []).filter(a => a.id !== id);
    _naccVer++;
    notifyChannelsRender();
    clearTimeout(_naccTimer);              // 取消防抖，改成「立即保存」再刷新
    _naccTimer = null;
    const saved = await notifyChannelsSave(true);
    if (!saved) notifyToast("删除失败，已按服务端配置恢复", "err");
    else notifyToast("已删除账号：" + (acc.name || acc.id), "ok");
    await notifyChannelsLoad(true);        // 以服务端为准，同步两个通知分区的勾选
  }

  function notifyChannelsAutoSave() {
    clearTimeout(_naccTimer);
    const tip = document.getElementById("notifyChannelsTip");
    if (tip) tip.textContent = "有改动，正在保存…";
    _naccTimer = setTimeout(() => {
      _naccTimer = null;
      notifyChannelsSave(true);
    }, 800);
  }

  /* 立刻把防抖队列里的改动存掉（切分区 / 关页面前调用） */
  async function notifyChannelsFlush() {
    if (!_naccTimer) return;
    clearTimeout(_naccTimer);
    _naccTimer = null;
    await notifyChannelsSave(true);
  }

  async function notifyChannelsSave(silent) {
    if (!_nacc) return false;
    // 同一时间只跑一个保存：后来的调用排队等前一个结束。
    // 否则「删除后马上刷新」这类操作会被在途的旧快照覆盖，表现为删不掉。
    for (let i = 0; _naccSaving && i < 100; i++) {
      await new Promise(r => setTimeout(r, 40));
    }
    // 提交内容没变就直接跳过：空草稿、只是点开卡片、重复触发都不写库
    const bodyStr = JSON.stringify({ channels: naccPayload() });
    const tip = document.getElementById("notifyChannelsTip");
    if (bodyStr === _naccSavedJson) {
      if (tip) tip.textContent = "改动会自动保存";
      return true;
    }
    _naccSaving = true;
    // 发送时快照：请求往返期间用户可能继续输入 / 删除，不能拿旧对象当请求体，
    // 也不能用服务端返回的旧快照覆盖内存里的新改动。
    const ver = _naccVer;
    if (tip) tip.textContent = "保存中…";
    try {
      const r = await fetch("/api/notify/channels", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ("HTTP " + r.status));
      if (ver === _naccVer) {                 // 期间没有新改动才回填
        // 服务端只返回已落库的账号；界面上还没填内容的草稿要保留住，不能凭空消失
        const drafts = {};
        NOTIFY_CH_ORDER.forEach(ch => {
          drafts[ch] = (_nacc[ch] || []).filter(a => a._draft && !a._touched);
        });
        _nacc = {};
        NOTIFY_CH_ORDER.forEach(ch => {
          _nacc[ch] = ((d.channels || {})[ch] || []).slice().concat(drafts[ch] || []);
        });
        _naccSavedJson = JSON.stringify({ channels: naccPayload() });
        // 正在输入时不重绘（避免输入法组词被打断），离开输入框后自然会再存一次并刷新状态
        if (!naccIsEditing()) notifyChannelsRender();
      }
      if (tip) {
        const t = new Date();
        const hh = String(t.getHours()).padStart(2, "0");
        const mm = String(t.getMinutes()).padStart(2, "0");
        const ss = String(t.getSeconds()).padStart(2, "0");
        tip.textContent = "已自动保存 " + hh + ":" + mm + ":" + ss;
      }
      if (!silent) notifyToast("通知渠道已保存", "ok");
      return true;
    } catch (e) {
      // 没有保存按钮了，失败必须明确提示，否则用户以为已经存上了
      if (tip) tip.textContent = "保存失败：" + e.message;
      notifyToast("通知渠道保存失败：" + e.message, "err");
      return false;
    } finally {
      _naccSaving = false;
    }
  }

  async function notifyChannelTest(channel, id, btn) {
    if (btn) { btn.disabled = true; btn.dataset._old = btn.innerHTML; btn.innerHTML = '<i class="bi bi-hourglass-split"></i>'; }
    try {
      await notifyChannelsSave(true);          // 先落盘，测试用的才是最新配置
      const r = await fetch("/api/notify/channels/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: channel, id: id }),
      });
      const d = await r.json();
      const acc = naccFind(channel, id);
      const name = (acc && acc.name) || channel;
      if (d.ok) notifyToast("测试通知已发送（" + name + "）", "ok");
      else notifyToast("测试失败（" + name + "）：" + (d.detail || d.error || "未知错误"), "err");
    } catch (e) {
      notifyToast("测试请求失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._old || "测试"; }
    }
  }

  /* ---------- 账号勾选（「通知」/「定时任务通知」共用） ----------
     整行都可点击：账号做成一枚「可勾选的胶囊」，鼠标落在行内任意位置都能切换，
     不用去瞄那个 15px 的小方框。 */
  function notifyTargetsRender(boxId, targets, attrName) {
    const box = document.getElementById(boxId);
    if (!box) return;
    if (!_nacc) { box.innerHTML = '<div class="notify-history-empty">账号加载中…</div>'; return; }
    // 默认用 data-nch-target（AI 通知 / 定时任务通知 共用）；
    // 其它模块（如下载中心）传自己的属性名，避免和这两个分区的委托事件串台
    const attr = attrName || "data-nch-target";
    const t = targets || {};
    const groups = NOTIFY_CH_ORDER.map(ch => {
      const all = _nacc[ch] || [];
      // 只列出「已落库且必填项填完」的账号：空账号 / 没填完的不能勾选
      const items = all.filter(a => !a._draft && naccComplete(ch, a));
      const pending = all.length - items.length;
      const def = NOTIFY_CH_DEFS[ch] || { name: ch, icon: "bi-bell" };
      const picked = Array.isArray(t[ch]) ? t[ch].map(String) : [];
      let opts = "";
      if (items.length) {
        opts = items.map(a => {
          const on = picked.indexOf(a.id) >= 0;
          return '<label class="nt-opt' + (on ? " on" : "") + '" title="点击勾选 / 取消">' +
            '<input type="checkbox" ' + attr + '="' + ch + '" value="' + naccEsc(a.id) + '"' +
            (on ? " checked" : "") + '>' +
            '<span class="nt-name">' + naccEsc(a.name || a.id) + '</span></label>';
        }).join("");
        if (pending > 0) {
          opts += '<span class="nt-pending"><i class="bi bi-exclamation-circle"></i>' +
            pending + ' 个账号没配置完 <a href="javascript:void(0)" class="nt-go" data-go="' + ch + '">去完善</a></span>';
        }
      } else if (pending > 0) {
        opts = '<span class="nt-none">' + pending + ' 个账号未配置完成 <a href="javascript:void(0)" class="nt-go" data-go="' +
          ch + '">去完善</a></span>';
      } else {
        opts = '<span class="nt-none">未配置账号 <a href="javascript:void(0)" class="nt-go" data-go="' + ch + '">去配置</a></span>';
      }
      return '<div class="nt-group' + (items.length === 1 ? " nt-single" : "") + '" data-nt-group="' + ch + '"' +
        (items.length === 1 ? ' title="点击整行即可勾选 / 取消"' : '') + '>' +
        '<div class="nt-ch"><i class="bi ' + def.icon + '"></i>' + naccEsc(def.name) + '</div>' +
        '<div class="nt-opts">' + opts + '</div>' +
      '</div>';
    }).join("");
    box.innerHTML = groups ||
      '<div class="notify-history-empty">还没有配置任何渠道账号，请先到「通知渠道」添加。</div>';
    notifyTestButtonsRefresh();      // 没勾账号的渠道，对应的「测试」按钮置灰
  }

  /* 勾选状态变化后同步胶囊的高亮（不整体重绘，避免打断点击） */
  function notifyTargetsSyncChip(cb) {
    if (!cb) return;
    const chip = cb.closest ? cb.closest(".nt-opt") : null;
    if (chip) chip.classList.toggle("on", !!cb.checked);
  }

  function notifyTargetsCollect(boxId, attrName) {
    const box = document.getElementById(boxId);
    const out = {};
    if (!box) return out;
    const attr = attrName || "data-nch-target";
    box.querySelectorAll("input[" + attr + "]").forEach(el => {
      const ch = el.getAttribute(attr);
      out[ch] = out[ch] || [];
      if (el.checked) out[ch].push(el.value);
    });
    return out;
  }

  /* ---------- 测试按钮：只有「上面勾选了该渠道的账号」才能点 ---------- */
  const NOTIFY_TEST_BTN_CH = {
    notifyTestLocal: "desktop", notifyTestEmail: "email",
    notifyTestTelegram: "telegram", notifyTestAll: "all",
    notifyCronTestDesktop: "desktop", notifyCronTestEmail: "email",
    notifyCronTestTelegram: "telegram", notifyCronTestDingtalk: "dingtalk",
    notifyCronTestPushplus: "pushplus", notifyCronTestWeb: "web",
    dlNotifyTestDesktop: "desktop", dlNotifyTestEmail: "email",
    dlNotifyTestTelegram: "telegram", dlNotifyTestDingtalk: "dingtalk",
    dlNotifyTestPushplus: "pushplus", dlNotifyTestWeb: "web",
  };
  const NOTIFY_TEST_BTN_TIP = "先在「推送账号」里勾选该渠道的账号，才能发送测试";

  function notifyTestButtonsRefresh() {
    const aiTg = notifyTargetsCollect("notifyTargets");
    const cronTg = notifyTargetsCollect("cronNotifyTargets");
    const dlTg = notifyTargetsCollect("dlNotifyTargets", "data-dln-target");
    const hasAny = tg => NOTIFY_CH_ORDER.some(ch => (tg[ch] || []).length > 0);
    Object.keys(NOTIFY_TEST_BTN_CH).forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const ch = NOTIFY_TEST_BTN_CH[id];
      const tg = id.indexOf("notifyCron") === 0 ? cronTg
               : id.indexOf("dlNotify") === 0 ? dlTg : aiTg;
      const on = ch === "all" ? hasAny(tg) : (tg[ch] || []).length > 0;
      btn.disabled = !on;
      if (on) btn.removeAttribute("title");
      else btn.title = NOTIFY_TEST_BTN_TIP;
    });
  }

  function notifyTargetsRefreshAll() {
    if (_notifyCache) notifyTargetsRender("notifyTargets", _notifyCache.targets);
    if (_cronNotifyCache) notifyTargetsRender("cronNotifyTargets", _cronNotifyCache.targets);
  }

  /* ---------- 分区 HTML ---------- */
  function notifyBuildSectionHTML() {
    return '<div class="set-sec" id="sec-notify" data-kw="AI 通知 ai notify 通知 email 邮件 浏览器 桌面 账号">' +
      '<h2><i class="bi bi-bell"></i> AI 通知</h2>' +
      '<div class="set-desc" data-kw="AI 通知 ai notify 通知 邮件 smtp telegram 浏览器 账号">' +
        'AI 助手 / 智能体回复完成后向「启动服务的本人」推送。推送账号统一在「<b>通知渠道</b>」里配置，' +
        '这里只勾选要发到哪些账号（同一渠道可多选）。默认关闭。</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-power"></i> 总开关</div>' +
        '<div class="notify-row inline set-row" data-kw="启用通知 enabled">' +
          '<div class="notify-label-wrap"><div class="notify-label">启用通知</div>' +
          '<div class="notify-desc">关闭后所有账号均不触发。</div></div>' +
          '<label class="set-switch"><input type="checkbox" id="notifyEnabled"><span></span></label>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-broadcast"></i> 推送账号</div>' +
        '<div class="notify-desc" style="margin:0 0 10px;">勾选发到哪些账号；没配置过就先去「通知渠道」添加。</div>' +
        '<div id="notifyTargets" class="notify-targets">加载中…</div>' +
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
        '<div class="notify-desc" style="margin:0 0 12px;">保存后立即生效；测试会按该渠道已勾选的账号各发一条真实通知。</div>' +
        '<div class="notify-actions" data-kw="测试 保存 test save">' +
          '<button class="notify-btn" id="notifyTestLocal"><i class="bi bi-bell"></i> 测试桌面</button>' +
          '<button class="notify-btn" id="notifyTestEmail"><i class="bi bi-envelope"></i> 测试邮件</button>' +
          '<button class="notify-btn" id="notifyTestTelegram"><i class="bi bi-telegram"></i> 测试 Telegram</button>' +
          '<button class="notify-btn" id="notifyTestAll"><i class="bi bi-broadcast"></i> 全部选中</button>' +
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

  function cronNotifyBuildSectionHTML() {
    return '<div class="set-sec" id="sec-cron-notify" data-kw="定时任务 通知 cron 钉钉 pushplus telegram 邮件 桌面 账号">' +
      '<h2 data-kw="定时任务 通知 cron 钉钉 pushplus telegram 邮件 桌面 账号"><i class="bi bi-alarm"></i> 定时任务通知</h2>' +
      '<div class="set-desc" data-kw="定时任务 通知 cron 钉钉 pushplus telegram 邮件 桌面 账号">' +
        '定时任务<b>失败 / 超时 / 安排重试</b>时推送。推送账号统一在「<b>通知渠道</b>」里配置，这里只勾选要发到哪些账号；' +
        '与 AI 通知互不影响。</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-power"></i> 总开关与触发事件</div>' +
        '<div class="notify-row inline set-row" data-kw="启用定时任务通知 enabled 开关 启用">' +
          '<div class="notify-label-wrap"><div class="notify-label">启用定时任务通知</div>' +
          '<div class="notify-desc">总开关；关闭后所有账号均不推送。</div></div>' +
          '<label class="set-switch"><input type="checkbox" id="notifyCronEnabled"><span></span></label>' +
        '</div>' +
        '<div class="notify-row inline set-row" data-kw="触发事件 失败 超时 重试 成功 fail timeout retry success">' +
          '<div class="notify-label-wrap"><div class="notify-label">触发事件</div>' +
          '<div class="notify-desc">勾选哪些事件时推送（任务里关掉「发送通知」的不推送，两者取交集）；' +
            '「执行成功」默认关闭，开启后每次执行成功也会推送并留记录。</div></div>' +
          '<div class="notify-cron-evs">' +
            '<label class="notify-check"><input type="checkbox" id="notifyCronEvFail"> 执行失败</label>' +
            '<label class="notify-check"><input type="checkbox" id="notifyCronEvTimeout"> 执行超时</label>' +
            '<label class="notify-check"><input type="checkbox" id="notifyCronEvRetry"> 安排重试</label>' +
            '<label class="notify-check"><input type="checkbox" id="notifyCronEvSuccess"> 执行成功</label>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-broadcast"></i> 推送账号</div>' +
        '<div class="notify-desc" style="margin:0 0 10px;">勾选发到哪些账号；没配置过就先去「通知渠道」添加。' +
          '任务里还能再按渠道筛选（任务 → 通知渠道）。</div>' +
        '<div id="cronNotifyTargets" class="notify-targets">加载中…</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-pencil-square"></i> 通知模板</div>' +
        '<div class="notify-row stack set-row" data-kw="定时任务 快速模板 预设 preset 模板 template">' +
          '<div class="notify-label-wrap"><div class="notify-label">快速模板</div>' +
          '<div class="notify-desc">点一下同时套用标题 + 正文，下面的预览即时生效；套用后仍可自由修改。清空两个字段则使用系统默认文案。</div></div>' +
          '<div class="notify-presets">' +
            Object.keys(CRON_TPL_PRESETS).map(id => {
              const p = CRON_TPL_PRESETS[id];
              return '<button type="button" class="notify-preset-cron" data-cpreset="' + id + '" title="' + p.desc + '">' +
                '<i class="bi ' + p.icon + '"></i> ' + p.name + '</button>';
            }).join("") +
          '</div>' +
        '</div>' +
        '<div class="notify-preview set-row" data-kw="定时任务 效果预览 预览 preview">' +
          '<div class="notify-preview-head"><span><i class="bi bi-eye"></i> 效果预览</span>' +
          '<span class="notify-preview-tag">示例数据</span></div>' +
          '<div class="notify-preview-card">' +
            '<div class="notify-preview-app"><i class="bi bi-alarm-fill"></i> File_Flask<span>刚刚</span></div>' +
            '<div class="notify-preview-title" id="notifyCronPreviewTitle">—</div>' +
            '<div class="notify-preview-body" id="notifyCronPreviewBody">—</div>' +
          '</div>' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="定时任务 标题模板 title">' +
          '<div class="notify-label-wrap"><div class="notify-label">标题模板</div>' +
          '<div class="notify-desc">留空 = 使用系统默认文案。</div></div>' +
          '<input class="notify-input" id="notifyCronTitle" placeholder="定时任务{event} · {task}">' +
        '</div>' +
        '<div class="notify-vars set-row" data-kw="定时任务 变量 variable 可用变量">' +
          '<span class="notify-vars-tip">可用变量（点击插入）</span>' +
          CRON_NOTIFY_VARS.map(x =>
            '<button type="button" class="notify-var" data-var="{' + x.key + '}" title="' + x.desc + '">{' + x.key + '}</button>').join("") +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="定时任务 正文模板 body">' +
          '<div class="notify-label-wrap"><div class="notify-label">正文模板</div>' +
          '<div class="notify-desc">支持换行；钉钉 / PushPlus 等渠道按纯文本发送。</div></div>' +
          '<textarea class="notify-input notify-textarea" id="notifyCronBody" rows="4" placeholder="任务「{task}」{event}。&#10;退出码：{exit}"></textarea>' +
        '</div>' +
      '</div>' +

      // 操作在前、记录在后：测试 / 保存是高频操作，别让它沉到最底下
      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-gear-wide-connected"></i> 操作</div>' +
        '<div class="notify-desc" style="margin:0 0 12px;">保存后立即生效；测试会按该渠道已勾选的账号各发一条真实通知。</div>' +
        '<div class="notify-actions" data-kw="测试 保存 test save 钉钉 pushplus 邮件 桌面 telegram">' +
          '<button class="notify-btn" id="notifyCronTestDesktop"><i class="bi bi-bell"></i> 测试桌面</button>' +
          '<button class="notify-btn" id="notifyCronTestEmail"><i class="bi bi-envelope"></i> 测试邮件</button>' +
          '<button class="notify-btn" id="notifyCronTestTelegram"><i class="bi bi-telegram"></i> 测试 Telegram</button>' +
          '<button class="notify-btn" id="notifyCronTestDingtalk"><i class="bi bi-chat-dots"></i> 测试钉钉</button>' +
          '<button class="notify-btn" id="notifyCronTestPushplus"><i class="bi bi-wechat"></i> 测试 PushPlus</button>' +
          '<button class="notify-btn" id="notifyCronTestWeb"><i class="bi bi-globe2"></i> 测试网页</button>' +
          '<button class="notify-btn primary" id="notifyCronSaveBtn" style="margin-left:auto;"><i class="bi bi-save"></i> 保存</button>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title" style="justify-content:space-between;">' +
          '<span><i class="bi bi-clock-history"></i> 通知记录</span>' +
          '<button class="notify-btn" id="notifyCronHistoryRefresh"><i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '</div>' +
        '<div class="notify-desc" style="margin:0 0 10px;">定时任务触发的推送记录（最新 50 条；全部记录见「AI 通知」分区）。</div>' +
        '<div id="notifyCronHistory" class="notify-history">加载中…</div>' +
      '</div>' +
    '</div>';
  }

  /* ---------- 下载通知：模板变量 / 预设 / 预览 ----------
     变量与后端 download_notify._vars_of() 保持一致；未知变量后端会原样输出。 */
  const DL_NOTIFY_VARS = [
    { key: "name",   desc: "文件 / 文件夹名" },
    { key: "event",  desc: "结果：完成 / 失败" },
    { key: "status", desc: "原始状态：done / failed" },
    { key: "size",   desc: "大小（自动 B / KB / MB / GB）" },
    { key: "error",  desc: "失败原因（完成时为空）" },
    { key: "date",   desc: "触发日期 YYYY-MM-DD" },
    { key: "time",   desc: "触发时间 HH:MM" },
  ];
  const DL_TPL_PRESETS = {
    std: {
      name: "标准", icon: "bi-check2-circle", desc: "标题带结果 + 文件名，正文分行列详情，各渠道都合适",
      title: "下载{event} · {name}",
      body: "任务「{name}」{event}。\n大小：{size}\n时间：{date} {time}",
    },
    mini: {
      name: "极简", icon: "bi-circle", desc: "一行摘要，适合桌面 / Telegram 一扫而过的场景",
      title: "⬇️ {name} {event}",
      body: "{name} {event}（{size}）· {date} {time}",
    },
    fail: {
      name: "失败告警", icon: "bi-exclamation-triangle", desc: "带 ⚠️ 前缀并突出失败原因，适合钉钉群 / 告警群醒目提醒",
      title: "⚠️ 下载{event}：{name}",
      body: "文件：{name}\n结果：{event}\n大小：{size}\n原因：{error}\n时间：{date} {time}",
    },
    plain: {
      name: "纯文本", icon: "bi-fonts", desc: "无表情符号，兼容老系统通知中心 / 老邮箱",
      title: "[下载] {name} {event}",
      body: "{name} 于 {date} {time} {event}，大小 {size}。",
    },
    detail: {
      name: "详细报告", icon: "bi-clipboard-data", desc: "带状态码与全部字段，适合邮件归档",
      title: "📥 {name} · {date}",
      body: "🕒 时间：{date} {time}\n📦 文件：{name}\n📏 大小：{size}\n🚦 结果：{event}（{status}）\n❗ 错误：{error}",
    },
  };
  // 标题留空 = 后端回退用 {name}；正文留空 = 后端回退「任务「xx」完成。」，预览按这份回退渲染
  const DL_TPL_DEFAULTS = { title: "{name}", body: "任务「{name}」{event}。" };

  function dlNotifySubVars(tpl, vars) {
    return String(tpl == null ? "" : tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m);
  }

  function dlNotifyPreviewVars() {
    const d = new Date(), p2 = n => String(n).padStart(2, "0");
    return {
      name: "ubuntu-24.04-desktop-amd64.iso",
      event: "完成",
      status: "done",
      size: "4.2 GB",
      error: "",
      date: d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()),
      time: p2(d.getHours()) + ":" + p2(d.getMinutes()),
    };
  }

  function dlNotifyPreviewRefresh() {
    const tOut = document.getElementById("dlNotifyPreviewTitle");
    const bOut = document.getElementById("dlNotifyPreviewBody");
    if (!tOut || !bOut) return;
    const vars = dlNotifyPreviewVars();
    const tEl = document.getElementById("dlNotifyTitle");
    const bEl = document.getElementById("dlNotifyBody");
    const title = (tEl && tEl.value.trim()) ? tEl.value : DL_TPL_DEFAULTS.title;
    const body = (bEl && bEl.value.trim()) ? bEl.value : DL_TPL_DEFAULTS.body;
    tOut.textContent = dlNotifySubVars(title, vars);
    bOut.textContent = dlNotifySubVars(body, vars);
    // 当前标题 + 正文与哪个快速模板一致，就高亮哪个（与其它通知分区的预设交互一致）
    document.querySelectorAll(".notify-preset-dl").forEach(el => {
      const p = DL_TPL_PRESETS[el.dataset.dlpreset];
      el.classList.toggle("active", !!p && p.title === title.trim() && p.body === body.trim());
    });
    // 未知变量提示：写了后端不认识的变量，会原样显示
    const used = (title + "\n" + body).match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || [];
    const unknown = Array.from(new Set(used.map(x => x.slice(1, -1))))
      .filter(k => !Object.prototype.hasOwnProperty.call(vars, k));
    const note = document.getElementById("dlNotifyPreviewNote");
    if (note) {
      note.style.display = unknown.length ? "" : "none";
      note.innerHTML = unknown.length
        ? '<i class="bi bi-exclamation-triangle"></i> 未知变量 ' +
          unknown.map(k => "<code>{" + k + "}</code>").join(" ") + " 会原样显示"
        : "";
    }
  }

  function dlApplyPreset(id) {
    const p = DL_TPL_PRESETS[id];
    if (!p) return;
    const tEl = document.getElementById("dlNotifyTitle");
    const bEl = document.getElementById("dlNotifyBody");
    if (tEl) tEl.value = p.title;
    if (bEl) bEl.value = p.body;
    dlNotifyPreviewRefresh();
    dlNotifyAutoSave();
  }

  /* ---------- 独立分区：下载通知（设置 → 下载通知） ----------
     配置存 store.db 的 dl_cfg（key='dl_notify'），由下载中心「完成 / 失败」事件触发；
     与「AI 通知」「定时任务通知」共用同一套渠道账号，这里只做开关 / 事件 / 勾选 / 文案。 */
  function dlNotifyBuildSectionHTML() {
    return '<div class="set-sec" id="sec-dl-notify" data-kw="下载通知 dl download 下载 完成 失败 账号">' +
      '<h2 data-kw="下载通知 dl download 下载 完成 失败 账号"><i class="bi bi-cloud-arrow-down"></i> 下载通知</h2>' +
      '<div class="set-desc" data-kw="下载通知 dl download 下载 完成 失败 账号">' +
        '下载任务<b>完成 / 失败</b>时推送。推送账号统一在「<b>通知渠道</b>」里配置，这里只勾选要发到哪些账号；' +
        '与 AI 通知、定时任务通知互不影响。</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-power"></i> 总开关与触发事件</div>' +
        '<div class="notify-row inline set-row" data-kw="启用下载通知 enabled 开关">' +
          '<div class="notify-label-wrap"><div class="notify-label">启用下载通知</div>' +
          '<div class="notify-desc">总开关；关闭后所有账号均不推送。</div></div>' +
          '<label class="set-switch"><input type="checkbox" id="dlNotifyEnabled"><span></span></label>' +
        '</div>' +
        '<div class="notify-row inline set-row" data-kw="触发事件 完成 失败 done failed">' +
          '<div class="notify-label-wrap"><div class="notify-label">触发事件</div>' +
          '<div class="notify-desc">勾选哪些结果需要推送；手动取消的任务不推送。</div></div>' +
          '<div class="notify-cron-evs">' +
            '<label class="notify-check"><input type="checkbox" id="dlNotifyEvDone"> 下载完成</label>' +
            '<label class="notify-check"><input type="checkbox" id="dlNotifyEvFail"> 下载失败</label>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-broadcast"></i> 推送账号</div>' +
        '<div class="notify-desc" style="margin:0 0 10px;">勾选发到哪些账号；没配置过就先去「通知渠道」添加。</div>' +
        '<div id="dlNotifyTargets" class="notify-targets">加载中…</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-pencil-square"></i> 通知文案</div>' +
        '<div class="notify-row stack set-row" data-kw="下载通知 快速模板 预设 preset 模板 template">' +
          '<div class="notify-label-wrap"><div class="notify-label">快速模板</div>' +
          '<div class="notify-desc">点一下同时套用标题 + 正文，下面的预览即时生效；套用后仍可自由修改。</div></div>' +
          '<div class="notify-presets">' +
            Object.keys(DL_TPL_PRESETS).map(id => {
              const p = DL_TPL_PRESETS[id];
              return '<button type="button" class="notify-preset-dl" data-dlpreset="' + id + '" title="' + p.desc + '">' +
                '<i class="bi ' + p.icon + '"></i> ' + p.name + '</button>';
            }).join("") +
          '</div>' +
        '</div>' +
        '<div class="notify-preview set-row" data-kw="下载通知 效果预览 预览 preview 通知示例">' +
          '<div class="notify-preview-head"><span><i class="bi bi-eye"></i> 效果预览</span>' +
          '<span class="notify-preview-tag">示例数据</span></div>' +
          '<div class="notify-preview-card">' +
            '<div class="notify-preview-app"><i class="bi bi-cloud-arrow-down-fill"></i> File_Flask<span>刚刚</span></div>' +
            '<div class="notify-preview-title" id="dlNotifyPreviewTitle">—</div>' +
            '<div class="notify-preview-body" id="dlNotifyPreviewBody">—</div>' +
          '</div>' +
          '<div class="notify-preview-note" id="dlNotifyPreviewNote" style="display:none;"></div>' +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="下载通知 标题模板 title">' +
          '<div class="notify-label-wrap"><div class="notify-label">标题模板</div>' +
          '<div class="notify-desc">留空 = 使用系统默认文案（文件名）。</div></div>' +
          '<input class="notify-input" id="dlNotifyTitle" placeholder="下载{event} · {name}">' +
        '</div>' +
        '<div class="notify-vars set-row" data-kw="下载通知 变量 variable 可用变量">' +
          '<span class="notify-vars-tip">可用变量（点击插入）</span>' +
          DL_NOTIFY_VARS.map(x =>
            '<button type="button" class="notify-var" data-var="{' + x.key + '}" title="' + x.desc + '">{' + x.key + '}</button>').join("") +
        '</div>' +
        '<div class="notify-row stack set-row" data-kw="下载通知 正文模板 body">' +
          '<div class="notify-label-wrap"><div class="notify-label">正文模板</div>' +
          '<div class="notify-desc">支持换行；钉钉 / PushPlus 等渠道按纯文本发送。</div></div>' +
          '<textarea class="notify-input notify-textarea" id="dlNotifyBody" rows="4" ' +
            'placeholder="任务「{name}」{event}。&#10;大小：{size}"></textarea>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title"><i class="bi bi-gear-wide-connected"></i> 操作</div>' +
        '<div class="notify-desc" style="margin:0 0 12px;">保存后立即生效；测试会按该渠道已勾选的账号各发一条真实通知。</div>' +
        '<div class="notify-actions" data-kw="下载通知 测试 保存 test save 桌面 邮件 telegram 钉钉 pushplus 网页">' +
          '<button class="notify-btn" id="dlNotifyTestDesktop"><i class="bi bi-bell"></i> 测试桌面</button>' +
          '<button class="notify-btn" id="dlNotifyTestEmail"><i class="bi bi-envelope"></i> 测试邮件</button>' +
          '<button class="notify-btn" id="dlNotifyTestTelegram"><i class="bi bi-telegram"></i> 测试 Telegram</button>' +
          '<button class="notify-btn" id="dlNotifyTestDingtalk"><i class="bi bi-chat-dots"></i> 测试钉钉</button>' +
          '<button class="notify-btn" id="dlNotifyTestPushplus"><i class="bi bi-wechat"></i> 测试 PushPlus</button>' +
          '<button class="notify-btn" id="dlNotifyTestWeb"><i class="bi bi-globe2"></i> 测试网页</button>' +
          '<button class="notify-btn primary" id="dlNotifySaveBtn" style="margin-left:auto;"><i class="bi bi-save"></i> 保存</button>' +
        '</div>' +
      '</div>' +

      '<div class="notify-card">' +
        '<div class="notify-card-title" style="justify-content:space-between;">' +
          '<span><i class="bi bi-clock-history"></i> 通知记录</span>' +
          '<button class="notify-btn" id="dlNotifyHistoryRefresh"><i class="bi bi-arrow-clockwise"></i> 刷新</button>' +
        '</div>' +
        '<div class="notify-desc" style="margin:0 0 10px;">下载任务触发的推送记录（最新 30 条）。</div>' +
        '<div id="dlNotifyHistory" class="notify-history">加载中…</div>' +
      '</div>' +
    '</div>';
  }

  /* ---------- 下载通知：读写 / 测试 / 记录 ---------- */
  let _dlNotifyCache = null;

  async function dlNotifyLoad() {
    if (!document.getElementById("dlNotifyEnabled")) return;
    try {
      const r = await fetch("/api/dl/notify");
      const d = await r.json();
      if (d && d.cfg) dlNotifyFill(d.cfg);
    } catch (_) { /* 后端未重启时静默 */ }
    dlNotifyLoadHistory();
  }

  function dlNotifyFill(n) {
    const q = id => document.getElementById(id);
    if (!q("dlNotifyEnabled")) return;
    _dlNotifyCache = n;
    q("dlNotifyEnabled").checked = !!n.enabled;
    const ev = n.events || {};
    if (q("dlNotifyEvDone")) q("dlNotifyEvDone").checked = ev.done !== false;
    if (q("dlNotifyEvFail")) q("dlNotifyEvFail").checked = ev.failed !== false;
    const tpl = n.template || {};
    if (q("dlNotifyTitle")) q("dlNotifyTitle").value = tpl.title || "";
    if (q("dlNotifyBody"))  q("dlNotifyBody").value = tpl.body || "";
    dlNotifyPreviewRefresh();
    notifyChannelsLoad().then(() => notifyTargetsRender("dlNotifyTargets", n.targets, "data-dln-target"));
  }

  function dlNotifyReadForm() {
    const q = id => document.getElementById(id);
    const c = id => { const el = q(id); return el ? el.checked : false; };
    const v = id => { const el = q(id); return el ? el.value : ""; };
    return {
      enabled: c("dlNotifyEnabled"),
      events: { done: c("dlNotifyEvDone"), failed: c("dlNotifyEvFail") },
      targets: notifyTargetsCollect("dlNotifyTargets", "data-dln-target"),
      template: { title: v("dlNotifyTitle").trim(), body: v("dlNotifyBody") },
    };
  }

  async function dlNotifySave(silent, skipFill) {
    try {
      const r = await fetch("/api/dl/notify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dlNotifyReadForm()),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ("HTTP " + r.status));
      if (d.cfg && !skipFill) dlNotifyFill(d.cfg);
      if (!silent) notifyToast("下载通知设置已保存", "ok");
      return true;
    } catch (e) {
      notifyToast("下载通知保存失败：" + e.message, "err");
      return false;
    }
  }

  let _dlNotifyTimer = null;
  function dlNotifyAutoSave() {
    clearTimeout(_dlNotifyTimer);
    _dlNotifyTimer = setTimeout(() => dlNotifySave(true, true), 600);
  }

  async function dlNotifyTest(channel, btn) {
    if (btn) { btn.disabled = true; btn.dataset._old = btn.innerHTML; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 发送中…'; }
    try {
      const saved = await dlNotifySave(true, true);      // 先落库，测试用的才是刚勾的账号
      if (!saved) return;
      const r = await fetch("/api/dl/notify/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: channel || "all" }),
      });
      const d = await r.json();
      const res = (d && d.results) || {};
      const keys = Object.keys(res);
      if (!keys.length) {
        notifyToast("还没有勾选任何通知账号", "warn");
        return;
      }
      const okCh = keys.filter(k => res[k] && res[k].ok);
      const badCh = keys.filter(k => !(res[k] && res[k].ok));
      if (okCh.length) {
        notifyToast("测试通知已发送（" + okCh.join(" / ") + "）", "ok");
      } else {
        const detail = keys.map(k => k + "：" + ((res[k] && res[k].detail) || "失败")).join("；");
        notifyToast("测试失败：" + detail, "err");
      }
      if (badCh.length && okCh.length) {
        notifyToast("部分渠道失败：" + badCh.join(" / "), "warn");
      }
      dlNotifyLoadHistory();
    } catch (e) {
      notifyToast("测试请求失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._old || ""; }
      notifyTestButtonsRefresh();   // 恢复按最新勾选的可点状态
    }
  }

  async function dlNotifyLoadHistory() {
    const box = document.getElementById("dlNotifyHistory");
    if (!box) return;
    try {
      const r = await fetch("/api/dl/notify/history?limit=30");
      const d = await r.json();
      const list = (d && d.items) || [];
      if (!list.length) {
        box.innerHTML = '<div class="notify-history-empty"><i class="bi bi-inbox"></i>暂无通知记录' +
          '<div>下载完成 / 失败触发推送（或点「发送测试」）后会出现在这里。</div></div>';
        return;
      }
      box.innerHTML = list.map(r2 => {
        const chats = notifyChannelsOf(r2);
        const chips = chats.length
          ? chats.map(c => '<span class="notify-hch ' + (c.ok ? "ok" : "fail") + '"' +
              (c.detail ? ' title="' + notifyEsc(c.detail) + '"' : "") + '>' +
              '<i class="bi ' + (c.ok ? "bi-check-circle" : "bi-x-circle") + '"></i>' +
              notifyEsc(NOTIFY_CH_NAME[c.key] || c.key) + '</span>').join("")
          : '<span class="notify-hch skip"><i class="bi bi-slash-circle"></i>未发送</span>';
        const title = notifyEsc(String(r2.title || "下载通知").slice(0, 120));
        const body = notifyEsc(String(r2.body || "").slice(0, 400));
        const abs = notifyAbsTime(r2.ts);
        const rel = notifyRelTime(r2.ts);
        return '<div class="notify-hitem">' +
          '<div class="notify-hicon" title="下载通知"><i class="bi bi-cloud-arrow-down"></i></div>' +
          '<div class="notify-hbody">' +
            '<div class="notify-htitle"><span>' + title + '</span>' +
              '<span class="notify-hmeta" title="' + abs + '">' + (rel || abs) + '</span></div>' +
            '<div class="notify-hchannels">' + chips + '</div>' +
            (body ? '<div class="notify-hbodytext">' + body + '</div>' : "") +
          '</div>' +
        '</div>';
      }).join("");
    } catch (_) {
      box.innerHTML = '<div class="notify-history-empty">记录加载失败</div>';
    }
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

  /* 页内通知卡片：浏览器通知不可用（http 内网 / 未授权）时镜像桌面通知。
     与 toast 的区别：保留正文换行（多行可读）、停留更久、可点掉。 */
  let _notifyCardTimer = null;
  /* 已转义文本里的链接自动渲染：<a href>（HTML / Telegram parse_mode 写法）、
     Markdown [文字](url)、裸 URL 统一转成可点链接（新标签打开）。 */
  function notifyLinkify(escaped) {
    const stash = [];
    const keep = h => { stash.push(h); return "\u0001" + (stash.length - 1) + "\u0001"; };
    let s = escaped;
    s = s.replace(/&lt;a\s+[^&]*?href=(?:"|')?(https?:\/\/[^"'\s&]+)(?:"|')?[^&]*?&gt;([\s\S]*?)&lt;\/a&gt;/gi,
      (m, url, txt) => keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        (String(txt).trim() || url) + '</a>'));
    s = s.replace(/\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)/g,
      (m, txt, url) => keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' +
        (txt || url) + '</a>'));
    s = s.replace(/(^|[^A-Za-z0-9"'=\/&])(https?:\/\/[^\s<"']+)/g, (m, pre, url) => {
      // 去掉被连带吞进来的转义实体尾巴，避免把 &amp; 后的字面量当成 URL
      const clean = url.replace(/&(?:amp|lt|gt|quot)?;?$/, "");
      return pre + keep('<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' +
        clean + '</a>') + url.slice(clean.length);
    });
    return s.replace(/\u0001(\d+)\u0001/g, (m, i) => stash[+i] || "");
  }

  /* 通知正文 → HTML：末尾的「前往网页版通知」段落换成可点按钮（新标签打开），
     其余内容按纯文本显示（保留换行），其中的链接自动变成可点链接。 */
  function notifyBodyHtml(body) {
    const esc = s => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const text = String(body || "").trim();
    if (!text) return "（无正文）";
    // 后端追加的格式：空行 + 分隔线 + 标题行 + 裸地址
    const m = text.match(/\n*━{3,}[^\n]*\n[^\n]*前往网页版通知[^\n]*\n(https?:\/\/[^\s]+)\s*$/);
    if (!m) return notifyLinkify(esc(text));
    const url = m[1];
    const head = text.slice(0, m.index).replace(/\s*$/, "");
    return (head ? notifyLinkify(esc(head)) + "\n" : "") +
      '<a class="nc-web-go" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" ' +
      'title="在新标签页打开网页版通知">' +
      '<i class="bi bi-globe2"></i> 前往网页版通知</a>';
  }

  function notifyCard(title, body) {
    let box = document.getElementById("notifyCard");
    if (!box) {
      box = document.createElement("div");
      box.id = "notifyCard";
      box.className = "ide-notify-card";   // 不能叫 notify-card：设置页的卡片占用了这个类名
      box.innerHTML = '<div class="nc-head"><i class="bi bi-bell-fill"></i>' +
        '<span class="nc-title"></span><button class="nc-x" title="关闭">×</button></div>' +
        '<pre class="nc-body"></pre>';
      document.body.appendChild(box);
      box.querySelector(".nc-x").onclick = (e) => {
        e.stopPropagation();
        box.classList.remove("show");
      };
      box.onclick = () => box.classList.remove("show");
    }
    box.querySelector(".nc-title").textContent = title || "File_Flask";
    const bodyEl = box.querySelector(".nc-body");
    bodyEl.innerHTML = notifyBodyHtml(body);
    // 点正文里的「前往网页版通知」：新标签打开，别顺手把卡片关掉
    bodyEl.querySelectorAll("a").forEach(a => { a.onclick = (e) => e.stopPropagation(); });
    box.classList.add("show");
    clearTimeout(_notifyCardTimer);
    _notifyCardTimer = setTimeout(() => box.classList.remove("show"), 12000);
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
      // http 内网 / 未授权时走页内卡片：保留正文换行，别像 toast 那样只剩第一行
      notifyCard(rec.title || "File_Flask", rec.body || "");
      return;
    }
    try {
      const soundOn = !document.getElementById("notifyDesktopSound") ||
                      document.getElementById("notifyDesktopSound").checked;
      // 系统通知栏最多显示 3~4 行：先按行截断，避免被系统从中间粗暴截掉。
      // 末尾的「前往网页版通知」压成一行，且点通知时直接新标签打开该地址。
      const raw = String(rec.body || "");
      const m = raw.match(/\n*━{3,}[^\n]*\n[^\n]*前往网页版通知[^\n]*\n(https?:\/\/[^\s]+)\s*$/);
      let bodyText, webUrl = "";
      if (m) {
        webUrl = m[1];
        const head = raw.slice(0, m.index).trim().split("\n").slice(0, 4).join("\n");
        bodyText = (head ? head + "\n" : "") + "🔗 网页版：\n" + webUrl;
      } else {
        bodyText = raw.split("\n").slice(0, 6).join("\n");
      }
      const n = new Notification(rec.title || "File_Flask", {
        body: bodyText,
        silent: !soundOn,
        tag: "file-flask-notify-" + (rec.ts || ""),
      });
      n.onclick = () => {
        try {
          window.focus(); n.close();
          if (webUrl) window.open(webUrl, "_blank", "noopener");   // 点通知 → 新标签打开网页版
        } catch (_) {}
      };
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
        await notifyChannelsLoad();          // 先拿到渠道账号，账号勾选才有得渲染
        notifyFill(d.cfg);
        notifyRenderHistory(d.recent || []);
      }
    } catch (e) {
      console.error("[notify] load failed:", e);
    }
    cronNotifyLoad();                       // 定时任务通知（配置存在 cron_cfg，独立接口）
  }

  /* ---------- 定时任务通知（cron_cfg.notify，与「定时任务 → 设置」共用同一份配置） ---------- */
  async function cronNotifyLoad() {
    if (!document.getElementById("notifyCronEnabled")) return;   // 设置面板没打开就不用管
    try {
      const r = await fetch("/api/cron/settings");
      const d = await r.json();
      if (d && d.notify) cronNotifyFill(d.notify);
    } catch (_) {}
    cronNotifyLoadHistory();
  }

  let _cronNotifyCache = null;

  function cronNotifyFill(n) {
    const q = id => document.getElementById(id);
    if (!q("notifyCronEnabled")) return;
    const ev = n.events || {};
    _cronNotifyCache = n;
    q("notifyCronEnabled").checked = !!n.enabled;
    if (q("notifyCronEvFail"))    q("notifyCronEvFail").checked = ev.fail !== false;
    if (q("notifyCronEvTimeout")) q("notifyCronEvTimeout").checked = ev.timeout !== false;
    if (q("notifyCronEvRetry"))   q("notifyCronEvRetry").checked = !!ev.retry;
    if (q("notifyCronEvSuccess")) q("notifyCronEvSuccess").checked = !!ev.success;
    // 推送账号：渠道参数已统一到「通知渠道」分区，这里只渲染可勾选的账号
    notifyChannelsLoad().then(() => notifyTargetsRender("cronNotifyTargets", n.targets));
    // 通知模板（清空 = 用系统默认文案）
    const tpl = n.template || {};
    if (q("notifyCronTitle")) q("notifyCronTitle").value = tpl.title || "";
    if (q("notifyCronBody"))  q("notifyCronBody").value = tpl.body || "";
    cronNotifyPreviewRefresh();
  }

  function cronNotifyReadForm() {
    const q = id => document.getElementById(id);
    const c = id => { const el = q(id); return el ? el.checked : false; };
    const v = id => { const el = q(id); return el ? el.value.trim() : ""; };
    return {
      notify: {
        enabled: c("notifyCronEnabled"),
        events: { fail: c("notifyCronEvFail"), timeout: c("notifyCronEvTimeout"),
                  retry: c("notifyCronEvRetry"), success: c("notifyCronEvSuccess") },
        // 只提交勾选的账号；渠道参数在「通知渠道」里维护
        targets: notifyTargetsCollect("cronNotifyTargets"),
        template: { title: v("notifyCronTitle"), body: v("notifyCronBody") },
      },
    };
  }

  async function cronNotifySave(silent, skipFill) {
    try {
      const r = await fetch("/api/cron/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cronNotifyReadForm()),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ("HTTP " + r.status));
      if (d.notify && !skipFill) cronNotifyFill(d.notify);   // 掩码回填，明示哪些已保存
      if (!silent) notifyToast("定时任务通知设置已保存", "ok");
      return true;
    } catch (e) {
      notifyToast("定时任务通知保存失败：" + e.message, "err");
      return false;
    }
  }

  // 改动即自动保存（防抖）：开关 / 勾选 / 输入后稍等片刻就落库，刷新不丢；
  // skipFill 回填，避免打断正在进行的输入
  let _cronAutoSaveTimer = null;
  // 是否存在「已启用」的定时任务：没有的话，这块设置基本没人用，
  // 自动保存弹提示只会成为噪音（尤其开局误触发 focusout 时）。
  // 侧栏没加载过任务列表时补一次 /api/cron/tasks，并缓存 60 秒，避免每次保存都多一个请求。
  let _cronEnabledProbe = { at: 0, has: false };
  async function cronNotifyHasEnabledTask() {
    try {
      const cached = (typeof CRON !== "undefined" && CRON && Array.isArray(CRON.tasks)) ? CRON.tasks : null;
      if (cached && cached.length) return cached.some(t => t && t.enabled);
      const now = Date.now();
      if (now - _cronEnabledProbe.at < 60000) return _cronEnabledProbe.has;
      let has = false;
      const r = await fetch("/api/cron/tasks");
      const d = await r.json();
      const list = (d && d.tasks) || [];
      if (typeof CRON !== "undefined" && CRON) CRON.tasks = list;   // 顺带补上侧栏缓存
      has = list.some(t => t && t.enabled);
      _cronEnabledProbe = { at: now, has: has };
      return has;
    } catch (e) {
      return false;
    }
  }
  function cronNotifyAutoSave() {
    clearTimeout(_cronAutoSaveTimer);
    _cronAutoSaveTimer = setTimeout(async () => {
      if (await cronNotifySave(true, true)) {
        // 静默保存照样生效，只是没在用定时任务时不打扰用户
        if (await cronNotifyHasEnabledTask()) notifyToast("定时任务通知：设置已自动保存", "ok");
      }
    }, 600);
  }

  async function cronNotifyTest(channel, btn) {
    if (btn) { btn.disabled = true; btn.dataset._old = btn.innerHTML; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> 发送中…'; }
    try {
      await cronNotifySave(true);                   // 先保存，测试用的才是刚填的配置
      const r = await fetch("/api/cron/notify-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const d = await r.json();
      const res = d && d.results && d.results[channel];
      const name = { desktop: "桌面", email: "邮件", dingtalk: "钉钉",
                     telegram: "Telegram", pushplus: "PushPlus", web: "网页版" }[channel] || channel;
      if (res && res.ok) notifyToast(`测试通知已发送（${name}）`, "ok");
      else notifyToast(`测试失败（${name}）：${(res && res.detail) || d.error || "未知错误"}`, "err");
      // 只刷新记录，不重绘整块表单，避免刚勾的账号被服务端快照覆盖
      cronNotifyLoadHistory();
    } catch (e) {
      notifyToast("测试请求失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._old || "测试"; }
      notifyTestButtonsRefresh();     // 发送期间若改了勾选，按最新勾选恢复可点状态
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
    const tp = cfg.template || {};
    if (q("notifyEnabled")) q("notifyEnabled").checked = !!cfg.enabled;
    if (q("notifyTitle"))   q("notifyTitle").value = tp.chat || NOTIFY_DEFAULTS.template.chat;
    if (q("notifyBody"))    q("notifyBody").value = cfg.template_body || NOTIFY_DEFAULTS.template_body;
    // 推送账号：渠道参数已统一到「通知渠道」分区，这里只渲染可勾选的账号
    notifyChannelsLoad().then(() => notifyTargetsRender("notifyTargets", cfg.targets));
    notifyPreviewRefresh();
  }

  function notifyToggleOptVisibility() {
    // 各渠道的参数表单已挪到「通知渠道」分区，这里只保留模板预览的刷新
    notifyPreviewRefresh();
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
      // 只提交勾选的账号；SMTP / Telegram 等参数在「通知渠道」里维护
      targets: notifyTargetsCollect("notifyTargets"),
      template: Object.assign(
        { chat: titleTpl },
        // 标题里带 {task} / {title} / {channel} 变量时，AI 助手与智能体共用同一模板（变量会自动区分）；
        // 否则保留磁盘上的 agent 标题，避免把「AI 助手」的标题套到智能体的通知上。
        /\{(?:task|title|channel)\}/.test(titleTpl) ? { agent: titleTpl } : {}
      ),
      template_body: bodyTpl,
    };
  }

  async function notifySave(silent) {
    // 渠道参数（SMTP / Telegram / 桌面）已挪到「通知渠道」分区，这里只保存开关、账号勾选与模板
    const body = notifyReadForm();
    try {
      const r = await fetch("/api/ai/notify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
      _notifyCache = d.cfg;
      cronNotifySave(true);                 // 定时任务通知的配置一并保存
      if (silent) return d;                 // 自动保存：不打扰，也不清空正在编辑的框
      notifyToast("通知设置已保存", "ok");
    } catch (e) {
      notifyToast("保存失败：" + e.message, "err");
    }
  }

  // 「通知」分区（AI 全局设置）：离开字段 / 切换开关后自动保存（防抖）
  let _notifyAutoSaveTimer = null;
  function notifyAutoSave() {
    clearTimeout(_notifyAutoSaveTimer);
    _notifyAutoSaveTimer = setTimeout(async () => {
      const d = await notifySave(true);
      if (d) notifyToast("通知：设置已自动保存", "ok");
    }, 500);
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
      // 先保存当前表单（含刚勾的账号）；保存失败就别测了，否则测的是旧配置
      const saved = await notifySave(true);
      if (!saved) {
        notifyToast("测试已取消：通知设置没能保存", "err");
        return;
      }
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
      // 只刷新历史列表；不要整块重绘表单，
      // 否则服务端快照会把界面上刚勾的账号覆盖掉（表现为「测试完勾选就没了」）
      notifyRefreshHistoryOnly();
    } catch (e) {
      notifyToast("测试请求失败：" + e.message, "err");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._old || '<i class="bi bi-broadcast"></i> 测试'; }
      notifyTestButtonsRefresh();     // 发送期间若改了勾选，按最新勾选恢复可点状态
    }
  }

  /* ---------- 定时任务通知：模板变量 / 预设 / 预览 / 记录 ---------- */
  const CRON_NOTIFY_VARS = [
    { key: "task", desc: "任务名称" },
    { key: "event", desc: "事件：执行失败 / 执行超时 / 安排重试" },
    { key: "exit", desc: "退出码" },
    { key: "duration", desc: "耗时（如 3.2s）" },
    { key: "attempt", desc: "重试进度（如 第 1/3 次；非重试为空）" },
    { key: "status", desc: "状态：成功 / 失败 / 超时" },
    { key: "run", desc: "执行记录 ID" },
    { key: "date", desc: "触发日期 YYYY-MM-DD" },
    { key: "time", desc: "触发时间 HH:MM" },
    { key: "output", desc: "脚本输出（任务里选「带脚本输出 / 自定义模板」时才有内容）" },
  ];
  const CRON_TPL_PRESETS = {
    std: {
      name: "标准", icon: "bi-check2-circle", desc: "标题带事件 + 任务名，正文分行列详情，各渠道都合适",
      title: "定时任务{event} · {task}",
      body: "任务「{task}」{event}。\n退出码：{exit}\n耗时：{duration}\n时间：{date} {time}\n执行记录：{run}",
    },
    simple: {
      name: "极简", icon: "bi-circle", desc: "一行摘要，适合 Telegram / 桌面通知这种一扫而过的场景",
      title: "⏰ {task} {event}",
      body: "{task} {event}（退出码 {exit}，耗时 {duration}）· {date} {time}",
    },
    alert: {
      name: "运维告警", icon: "bi-exclamation-triangle", desc: "带 🚨 前缀与结构化字段，适合钉钉群 / 告警群醒目提醒",
      title: "🚨 定时任务{event}：{task}",
      body: "任务：{task}\n事件：{event}\n退出码：{exit}\n耗时：{duration}\n重试：{attempt}\n时间：{date} {time}\n执行记录：{run}",
    },
    plain: {
      name: "纯文本", icon: "bi-fonts", desc: "无表情符号，兼容老系统通知中心 / 老邮箱",
      title: "[定时任务] {task} {event}",
      body: "{task} 于 {date} {time} {event}，退出码 {exit}，耗时 {duration}。执行记录 {run}。",
    },
    output: {
      name: "带脚本输出", icon: "bi-terminal", desc: "正文附上脚本输出；需在任务的「通知内容」里选「带脚本输出」或「自定义模板」",
      title: "定时任务{event} · {task}",
      body: "任务「{task}」{event}。\n退出码：{exit}　耗时：{duration}\n时间：{date} {time}\n执行记录：{run}\n\n▶ 脚本输出：\n{output}",
    },
  };
  // 标题 / 正文都清空时，后端会用调用方默认文案；预览也按这份默认来
  const CRON_TPL_DEFAULTS = CRON_TPL_PRESETS.std;

  function cronNotifySubVars(tpl, vars) {
    return String(tpl == null ? "" : tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m);
  }

  function cronNotifyPreviewVars() {
    const d = new Date(), p2 = n => String(n).padStart(2, "0");
    return {
      task: "每日备份",
      event: "执行失败",
      status: "失败",
      exit: "1",
      duration: "3.2s",
      attempt: "",
      run: "ab12cd34ef",
      date: d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()),
      time: p2(d.getHours()) + ":" + p2(d.getMinutes()),
      output: "Backup done: 128 files\nWarning: skipped ./cache (permission denied)",
    };
  }

  function cronNotifyPreviewRefresh() {
    const tOut = document.getElementById("notifyCronPreviewTitle");
    const bOut = document.getElementById("notifyCronPreviewBody");
    if (!tOut || !bOut) return;
    const vars = cronNotifyPreviewVars();
    const tEl = document.getElementById("notifyCronTitle");
    const bEl = document.getElementById("notifyCronBody");
    const title = (tEl && tEl.value.trim()) ? tEl.value : CRON_TPL_DEFAULTS.title;
    const body = (bEl && bEl.value.trim()) ? bEl.value : CRON_TPL_DEFAULTS.body;
    tOut.textContent = cronNotifySubVars(title, vars);
    bOut.textContent = cronNotifySubVars(body, vars);
    // 当前标题 + 正文与哪个快速模板一致，就高亮哪个（与「通知」分区的预设交互一致）
    document.querySelectorAll(".notify-preset-cron").forEach(el => {
      const p = CRON_TPL_PRESETS[el.dataset.cpreset];
      el.classList.toggle("active", !!p && p.title === title.trim() && p.body === body.trim());
    });
  }

  function cronApplyPreset(id) {
    const p = CRON_TPL_PRESETS[id];
    if (!p) return;
    const tEl = document.getElementById("notifyCronTitle");
    const bEl = document.getElementById("notifyCronBody");
    if (tEl) tEl.value = p.title;
    if (bEl) bEl.value = p.body;
    cronNotifyPreviewRefresh();
  }

  async function cronNotifyLoadHistory() {
    const box = document.getElementById("notifyCronHistory");
    if (!box) return;
    try {
      const r = await fetch("/api/cron/notify-history");
      const d = await r.json();
      cronNotifyRenderHistory((d && d.records) || []);
    } catch (_) {
      box.innerHTML = '<div class="notify-history-empty">记录加载失败</div>';
    }
  }

  function cronNotifyRenderHistory(records) {
    const box = document.getElementById("notifyCronHistory");
    if (!box) return;
    if (!records || !records.length) {
      box.innerHTML = '<div class="notify-history-empty"><i class="bi bi-inbox"></i>暂无通知记录' +
        '<div>任务失败 / 超时触发推送（或点下方「测试」按钮）后会出现在这里；' +
        '开启「执行成功」事件后，每次执行成功也会留记录。</div></div>';
      return;
    }
    box.innerHTML = records.map(r => {
      const chats = notifyChannelsOf(r);
      const chips = chats.length
        ? chats.map(c => {
            // 网页版：点 chip 直接新标签打开通知页（地址藏在 detail 里）
            const webUrl = c.key === "web"
              ? ((String(c.detail || "").match(/https?:\/\/[^\s"'<>]+/) || [""])[0])
              : "";
            const tip = c.detail ? ` title="${notifyEsc(c.detail)}"` : "";
            const attrs = webUrl
              ? ` data-web-url="${notifyEsc(webUrl)}" title="点击在新标签页打开网页版通知：${notifyEsc(webUrl)}"`
              : tip;
            return `<span class="notify-hch ${c.ok ? "ok" : "fail"}${webUrl ? " linkable" : ""}"${attrs}>` +
                   `<i class="bi ${c.ok ? "bi-check-circle" : "bi-x-circle"}"></i>` +
                   `${NOTIFY_CH_NAME[c.key] || c.key}` +
                   (webUrl ? ` <i class="bi bi-box-arrow-up-right"></i>` : "") + `</span>`;
          }).join("")
        : `<span class="notify-hch skip"><i class="bi bi-slash-circle"></i>未发送</span>`;
      const rawTitle = String(r.title || "").trim();
      const rawBody = String(r.body || "").trim();
      const title = notifyEsc(rawTitle.length > 120 ? rawTitle.slice(0, 120) + "…" : rawTitle) || "（无标题）";
      const body = notifyEsc(rawBody.length > 400 ? rawBody.slice(0, 400) + "…" : rawBody);
      const abs = notifyAbsTime(r.ts);
      const rel = notifyRelTime(r.ts);
      return `<div class="notify-hitem">` +
        `<div class="notify-hicon" title="定时任务">⏰</div>` +
        `<div class="notify-hbody">` +
          `<div class="notify-htitle"><span>${title}</span>` +
          `<span class="notify-hmeta" title="${abs}">${rel || abs}</span></div>` +
          `<div class="notify-hchannels">${chips}</div>` +
          (body ? `<div class="notify-hbodytext">${body}</div>` : "") +
        `</div>` +
      `</div>`;
    }).join("");
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
  const NOTIFY_CH_NAME = { desktop: "桌面", smtp: "邮件", telegram: "Telegram",
                          email: "邮件", dingtalk: "钉钉", pushplus: "PushPlus",
                          web: "网页版" };

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
    for (const key of ["desktop", "smtp", "email", "telegram", "dingtalk", "pushplus", "web"]) {
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
            // 网页版：点 chip 直接新标签打开通知页（地址藏在 detail 里）
            const webUrl = c.key === "web"
              ? ((String(c.detail || "").match(/https?:\/\/[^\s"'<>]+/) || [""])[0])
              : "";
            const tip = c.detail ? ` title="${notifyEsc(c.detail)}"` : "";
            const attrs = webUrl
              ? ` data-web-url="${notifyEsc(webUrl)}" title="点击在新标签页打开网页版通知：${notifyEsc(webUrl)}"`
              : tip;
            return `<span class="notify-hch ${c.ok ? "ok" : "fail"}${webUrl ? " linkable" : ""}"${attrs}>` +
                   `<i class="bi ${c.ok ? "bi-check-circle" : "bi-x-circle"}"></i>` +
                   `${NOTIFY_CH_NAME[c.key] || c.key}` +
                   (webUrl ? ` <i class="bi bi-box-arrow-up-right"></i>` : "") + `</span>`;
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
    // 刚建好 HTML：账号还没勾选，先把「测试」按钮置灰，等数据回来再按勾选放开
    notifyTestButtonsRefresh();
    // 全局事件只绑定一次；数据每次都刷新
    if (!window.__notifyMounted) {
      window.__notifyMounted = true;

      document.addEventListener("input", e => {
        const t = e.target;
        if (!t) return;
        // 「通知渠道」账号字段：只改内存，防抖保存；不重建 DOM，避免打断输入
        if (t.dataset && (t.dataset.f || t.dataset.nchName)) {
          const acc = naccFind(t.dataset.nch, t.dataset.id);
          if (acc) {
            if (t.dataset.nchName) acc.name = t.value;
            else acc.cfg[t.dataset.f] = (t.type === "checkbox") ? t.checked : t.value;
            acc._touched = true;              // 用户动过：草稿转正，可以落库了
            _naccVer++;
            naccRefreshCardStatus(t.dataset.nch, t.dataset.id);
          }
          notifyChannelsAutoSave();
          return;
        }
        if (t.id === "dlNotifyTitle" || t.id === "dlNotifyBody") dlNotifyPreviewRefresh();
        if (!t.id || !t.id.startsWith("notify")) return;
        notifyToggleOptVisibility();
        if (t.id === "notifyTitle" || t.id === "notifyBody") notifyPreviewRefresh();
        if (t.id === "notifyCronTitle" || t.id === "notifyCronBody") cronNotifyPreviewRefresh();
        // 文本输入不逐键保存：等离开输入框（focusout）或切换开关（change）时再自动保存，
        // 避免把打到一半的内容存进去
      }, true);
      document.addEventListener("change", e => {
        const t = e.target;
        if (!t) return;
        // 下载通知的账号勾选（用独立属性，避免和下面两个分区串台）
        if (t.dataset && t.dataset.dlnTarget) {
          notifyTargetsSyncChip(t);
          notifyTestButtonsRefresh();   // 测试按钮的可点状态跟着勾选实时变
          dlNotifyAutoSave();
          return;
        }
        // 下载通知：开关 / 事件
        if (t.id && t.id.indexOf("dlNotify") === 0) { dlNotifyAutoSave(); return; }
        // 账号勾选（「通知」/「定时任务通知」两个分区）
        if (t.dataset && t.dataset.nchTarget) {
          notifyTargetsSyncChip(t);          // 胶囊高亮跟着勾选状态走
          notifyTestButtonsRefresh();        // 「测试」按钮的可点状态跟着勾选变
          if (t.closest && t.closest("#cronNotifyTargets")) {
            if (_cronNotifyCache) _cronNotifyCache.targets = notifyTargetsCollect("cronNotifyTargets");
            cronNotifyAutoSave();
          } else {
            if (_notifyCache) _notifyCache.targets = notifyTargetsCollect("notifyTargets");
            notifyAutoSave();
          }
          return;
        }
        if (t.dataset && (t.dataset.f || t.dataset.nchName)) {
          const acc = naccFind(t.dataset.nch, t.dataset.id);
          if (acc) {
            if (t.dataset.nchName) acc.name = t.value;
            else acc.cfg[t.dataset.f] = (t.type === "checkbox") ? t.checked : t.value;
            acc._touched = true;              // 用户动过：草稿转正，可以落库了
            _naccVer++;
            naccRefreshCardStatus(t.dataset.nch, t.dataset.id);
          }
          notifyChannelsAutoSave();
          return;
        }
        if (!t.id || !t.id.startsWith("notify")) return;
        notifyToggleOptVisibility();
        // 开关 / 勾选 / 下拉：切换即自动保存（两个分区都适用）
        if (t.id.startsWith("notifyCron")) cronNotifyAutoSave();
        else notifyAutoSave();
      }, true);
      // 离开输入框（失焦）即自动保存：通知与定时任务通知两个分区都适用
      document.addEventListener("focusout", e => {
        const t = e.target;
        if (!t) return;
        if (t.dataset && (t.dataset.f || t.dataset.nchName)) {
          const acc = naccFind(t.dataset.nch, t.dataset.id);
          if (acc) {
            if (t.dataset.nchName) acc.name = t.value;
            else acc.cfg[t.dataset.f] = (t.type === "checkbox") ? t.checked : t.value;
            acc._touched = true;              // 用户动过：草稿转正，可以落库了
            _naccVer++;
            naccRefreshCardStatus(t.dataset.nch, t.dataset.id);
          }
          notifyChannelsAutoSave();
          return;
        }
        if (t.id && t.id.indexOf("dlNotify") === 0) { dlNotifyAutoSave(); return; }
        if (!t.id || !t.id.startsWith("notify") || !t.isConnected) return;
        if (t.id.startsWith("notifyCron")) cronNotifyAutoSave();
        else notifyAutoSave();
      }, true);
      // 记住最后编辑的模板字段，点变量胶囊时插入到那里
      document.addEventListener("focusin", e => {
        const t = e.target;
        if (t && (t.id === "notifyTitle" || t.id === "notifyBody" ||
                  t.id === "notifyCronTitle" || t.id === "notifyCronBody" ||
                  t.id === "dlNotifyTitle" || t.id === "dlNotifyBody")) _notifyLastField = t.id;
      }, true);

      document.addEventListener("click", e => {
        // 快速模板 / 变量胶囊（也是 button，需要先于下面的按钮分派处理）
        const presetBtn = e.target && e.target.closest ? e.target.closest(".notify-preset") : null;
        if (presetBtn) { notifyApplyPreset(presetBtn.dataset.preset); return; }
        const cronPresetBtn = e.target && e.target.closest ? e.target.closest(".notify-preset-cron") : null;
        if (cronPresetBtn) { cronApplyPreset(cronPresetBtn.dataset.cpreset); return; }
        const dlPresetBtn = e.target && e.target.closest ? e.target.closest(".notify-preset-dl") : null;
        if (dlPresetBtn) { dlApplyPreset(dlPresetBtn.dataset.dlpreset); return; }
        const varBtn = e.target && e.target.closest ? e.target.closest(".notify-var") : null;
        if (varBtn) { notifyInsertVar(varBtn.dataset.var); return; }
        // 历史记录里的「网页版」渠道：点一下新标签打开通知页
        const webChip = e.target && e.target.closest ? e.target.closest(".notify-hch[data-web-url]") : null;
        if (webChip) {
          window.open(webChip.dataset.webUrl, "_blank", "noopener");
          return;
        }
        // 只有一个账号的渠道：点这一行的任意空白处也能勾选 / 取消
        const ntRow = e.target && e.target.closest ? e.target.closest(".nt-group.nt-single") : null;
        if (ntRow && !(e.target.closest(".nt-opt") || e.target.tagName === "INPUT" ||
                       (e.target.closest && e.target.closest(".nt-go")))) {
          const cb = ntRow.querySelector('input[data-nch-target]');
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return;
        }
        // 通知渠道账号：添加 / 删除 / 测试
        const naccBtn = e.target && e.target.closest ? e.target.closest("[data-nacc-act]") : null;
        if (naccBtn) {
          const act = naccBtn.dataset.naccAct;
          const ch = naccBtn.dataset.ch;
          const aid = naccBtn.dataset.id;
          if (act === "add") notifyChannelsAdd(ch);
          else if (act === "del") notifyChannelsDel(ch, aid, naccBtn);
          else if (act === "test") notifyChannelTest(ch, aid, naccBtn);
          else if (act === "toggle") naccToggleCard(ch, aid, naccBtn);
          return;
        }
        // 账号选择里的「去配置」→ 跳到通知渠道分区
        const goBtn = e.target && e.target.closest ? e.target.closest(".nt-go") : null;
        if (goBtn) {
          const nav = document.querySelector('.set-navitem[data-sec="sec-channels"]');
          if (nav) nav.click();
          return;
        }
        // 按钮内含 <i> 图标，e.target 可能是图标而不是按钮，统一向上找最近的 button
        const btn = e.target && e.target.closest ? e.target.closest("button") : null;
        const id = btn ? btn.id : (e.target ? e.target.id : "");
        if (id === "notifySave") notifySave();
        else if (id === "notifyTestLocal") notifyTest("desktop", btn);
        else if (id === "notifyTestEmail") notifyTest("email", btn);
        else if (id === "notifyTestTelegram") notifyTest("telegram", btn);
        else if (id === "notifyTestAll") notifyTest("all", btn);
        else if (id === "notifyCronTestDesktop") cronNotifyTest("desktop", btn);
        else if (id === "notifyCronTestEmail") cronNotifyTest("email", btn);
        else if (id === "notifyCronTestTelegram") cronNotifyTest("telegram", btn);
        else if (id === "notifyCronTestDingtalk") cronNotifyTest("dingtalk", btn);
        else if (id === "notifyCronTestPushplus") cronNotifyTest("pushplus", btn);
        else if (id === "notifyCronTestWeb") cronNotifyTest("web", btn);
        else if (id === "notifyCronSaveBtn") cronNotifySave();
        else if (id === "notifyCronHistoryRefresh") cronNotifyLoadHistory();
        else if (id === "dlNotifyTestDesktop") dlNotifyTest("desktop", btn);
        else if (id === "dlNotifyTestEmail") dlNotifyTest("email", btn);
        else if (id === "dlNotifyTestTelegram") dlNotifyTest("telegram", btn);
        else if (id === "dlNotifyTestDingtalk") dlNotifyTest("dingtalk", btn);
        else if (id === "dlNotifyTestPushplus") dlNotifyTest("pushplus", btn);
        else if (id === "dlNotifyTestWeb") dlNotifyTest("web", btn);
        else if (id === "dlNotifySaveBtn") dlNotifySave();
        else if (id === "dlNotifyHistoryRefresh") dlNotifyLoadHistory();
        else if (id === "notifyClearHistory") notifyClearHistory();
      });

      // 进入通知 / 定时任务通知 / 通知渠道分区时刷新
      document.addEventListener("click", e => {
        const nav = e.target.closest && e.target.closest(".set-navitem");
        if (!nav) return;
        if (nav.dataset.sec === "sec-notify") {
          setTimeout(() => notifyLoad(), 100);
        } else if (nav.dataset.sec === "sec-cron-notify") {
          setTimeout(() => cronNotifyLoad(), 100);
        } else if (nav.dataset.sec === "sec-dl-notify") {
          setTimeout(() => dlNotifyLoad(), 100);
        } else if (nav.dataset.sec === "sec-channels") {
          setTimeout(() => notifyChannelsLoad(true), 100);
        }
      });

      // 关页面 / 切走时，把还在防抖队列里的渠道改动一起提交（keepalive 保证请求发得出去）
      window.addEventListener("pagehide", () => {
        if (!_naccTimer || !_nacc) return;
        clearTimeout(_naccTimer);
        _naccTimer = null;
        try {
          const body = JSON.stringify({ channels: naccPayload() });
          if (body === _naccSavedJson) return;          // 没有实际改动：不发请求
          fetch("/api/notify/channels", {
            method: "POST", keepalive: true,
            headers: { "Content-Type": "application/json" },
            body: body,
          });
        } catch (_) { /* 忽略：页面已经在卸载 */ }
      });

      // 启动浏览器通知轮询（镜像 desktop 通道到当前浏览器）
      notifyStartPolling();
    }
    // 每次进入设置页都刷新一次数据（表单可能被清空）
    setTimeout(() => {
      notifyPreviewRefresh();
      if (document.getElementById("notifyHistory")) notifyLoad();
      if (document.getElementById("notifyChannelsBox")) notifyChannelsLoad(true);
      if (document.getElementById("dlNotifyEnabled")) dlNotifyLoad();
    }, 100);
  }
