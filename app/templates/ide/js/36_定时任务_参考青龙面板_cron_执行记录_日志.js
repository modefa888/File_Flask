  /* ==================================================================
     定时任务（参考青龙面板）：
       · 侧栏列出所有任务，可启用 / 停用、立即运行、停止、编辑、删除；
       · 编辑器里校验 cron 表达式并实时显示「下次运行时间」；
       · 每次执行都留一条记录（状态 / 退出码 / 耗时），可回看完整日志。
     后端：/api/cron/*（services/ide/cronsvc.py 每 5s 扫描一次调度）。
     var 声明，避免 showPanel 提前调用时命中 TDZ。
     ================================================================== */
  var CRON = { timer: null, tasks: [], editing: null, runs: [], runTask: null, logRun: null, logOffset: 0, logTimer: null,
               chanCfg: null, editChRaw: "", tplTarget: null, tryFields: null,
               trySnap: null, notifyTpl: null, notifyRun: null };

  const CRON_PRESETS = [
    ["每分钟", "* * * * *"], ["每 5 分钟", "*/5 * * * *"], ["每 30 分钟", "*/30 * * * *"],
    ["每小时", "0 * * * *"], ["每天 0 点", "0 0 * * *"], ["每天 9 点", "0 9 * * *"],
    ["每周一 9 点", "0 9 * * 1"], ["每月 1 号", "0 0 1 * *"],
  ];
  const CRON_STATUS = {
    running: ["执行中", "run"], success: ["成功", "ok"], fail: ["失败", "bad"],
    killed: ["已停止", "bad"], timeout: ["超时", "warn"],
  };
  /* 任务级「通知内容」：值必须与后端 crondb.NOTIFY_MODES 一致 */
  const CRON_TASK_NOTIFY_MODES = [
    ["status", "仅执行结果"],
    ["output", "执行结果 + 脚本输出"],
    ["output_only", "仅脚本输出"],
    ["custom", "自定义模板"],
  ];
  /* 任务级自定义模板可用变量（与后端 cronsvc._notify_parts 的 vars_ 对应） */
  const CRON_TASK_NOTIFY_VARS = [
    ["task", "任务名称", "任务名称"],
    ["event", "事件：执行失败 / 执行超时 / 执行成功", "事件"],
    ["status", "状态：成功 / 失败 / 超时", "状态"],
    ["exit", "退出码", "退出码"],
    ["duration", "耗时（如 3.2s）", "耗时"],
    ["attempt", "重试进度（如 第 1/3 次）", "重试进度"],
    ["run", "执行记录 ID", "执行记录 ID"],
    ["date", "日期 YYYY-MM-DD", "日期"],
    ["time", "时间 HH:MM", "时间"],
    ["output", "脚本输出（末尾若干行，受「输出行数」限制）", "脚本输出"],
  ];
  /* 任务级「通知渠道」：值必须与后端 crondb.NOTIFY_CHANNELS 一致。
     任务里只列「设置 → 定时任务通知」已启用的渠道，可以只发其中几个；
     未指定（空）= 跟随通知设置里的全部已启用渠道。 */
  const CRON_TASK_NOTIFY_CHANNELS = [
    ["desktop", "桌面通知", "bi-bell"],
    ["email", "邮件", "bi-envelope"],
    ["dingtalk", "钉钉机器人", "bi-chat-dots"],
    ["telegram", "Telegram", "bi-telegram"],
    ["pushplus", "PushPlus", "bi-wechat"],
  ];
  function cronTaskChannelName(key) {
    const hit = CRON_TASK_NOTIFY_CHANNELS.find(c => c[0] === key);
    return hit ? hit[1] : key;
  }
  /* 渲染渠道 chips（CRON.chanCfg 来自 /api/cron/settings 的 notify.channels） */
  function cronTaskChannelsRender() {
    const box = $("cronNotifyChannels");
    if (!box) return;
    if (!CRON.chanCfg) {                            // 还没拿到 / 读取失败：保持原值不动
      box.dataset.ready = "0";
      box.innerHTML = '<span class="cd-ch-empty">渠道配置读取失败，' +
        '<a href="javascript:void(0)" id="cronNotifyChRetry">重试</a>（保存时会保持原设置）</span>';
      const rt = $("cronNotifyChRetry");
      if (rt) rt.onclick = () => { box.innerHTML = '<span class="cd-ch-empty">加载中…</span>'; cronTaskChannelsLoad(); };
      cronTaskChannelsSync();
      return;
    }
    const enabled = CRON.chanCfg;
    const avail = CRON_TASK_NOTIFY_CHANNELS.filter(c => enabled[c[0]]);
    box.dataset.ready = "1";
    if (!avail.length) {                            // 全局一个都没开：提示去设置里开
      box.innerHTML = '<span class="cd-ch-empty">「设置 → 定时任务通知」里还没有启用任何渠道，' +
        '<a href="javascript:void(0)" id="cronNotifyChGo">去开启</a></span>';
      const go = $("cronNotifyChGo");
      if (go) go.onclick = () => {
        cronCloseModal();
        if (typeof cronOpenSettings === "function") cronOpenSettings();
      };
      cronTaskChannelsSync();
      return;
    }
    const raw = String(CRON.editChRaw || "").split(",").filter(Boolean);
    // 任务没指定过 = 全选；指定过的只勾其中仍然启用的
    let picked = raw.length ? raw.filter(k => enabled[k]) : avail.map(c => c[0]);
    if (!picked.length) picked = avail.map(c => c[0]);
    box.innerHTML = avail.map(([key, name, icon]) =>
      '<button type="button" class="cd-chip' + (picked.indexOf(key) >= 0 ? " on" : "") + '" data-cch="' + key + '">' +
        '<i class="bi ' + icon + '"></i>' + esc(name) + '</button>').join("");
    box.querySelectorAll(".cd-chip").forEach(b => {
      b.onclick = () => { b.classList.toggle("on"); cronTaskChannelsSync(); };
    });
    cronTaskChannelsSync();
  }
  function cronTaskChannelsSync() {
    const box = $("cronNotifyChannels");
    const hint = $("cronNotifyChHint");
    if (!box || !hint) return;
    const chips = [...box.querySelectorAll(".cd-chip")];
    if (!chips.length) { hint.textContent = ""; return; }
    const on = chips.filter(c => c.classList.contains("on")).length;
    hint.textContent = on === chips.length
      ? "发送到全部已启用渠道（共 " + chips.length + " 个）。"
      : (on === 0
        ? "一个都没勾：仍按全部已启用渠道发送；要完全不发请关掉上面的「执行后发送通知」。"
        : "只发送到勾选的 " + on + " / " + chips.length + " 个渠道。");
  }
  function cronTaskChannelsLoad() {
    if (CRON.chanCfg) cronTaskChannelsRender();     // 先用上次拿到的渲染，避免闪烁
    // 每次都拉一遍：「设置 → 定时任务通知」里可能刚改过渠道 / 全局模板
    fetch("/api/cron/settings").then(r => r.json()).then(d => {
      const nf = (d && d.notify) || {};
      // 全局模板：任务模板留空时「通知预览」要用它（与真实发送的回退逻辑一致）
      if (nf.template && typeof nf.template === "object") CRON.notifyTpl = nf.template;
      const ch = nf.channels;
      if (ch && typeof ch === "object") {
        CRON.chanCfg = ch;
        cronTaskChannelsRender();
      }
    }).catch(() => { if (!CRON.chanCfg) cronTaskChannelsRender(); });
  }
  /* 收集当前勾选的渠道：null = 界面没就绪（保存时沿用原值），"" = 跟随通知设置 */
  function cronTaskChannelsValue() {
    const box = $("cronNotifyChannels");
    if (!box || box.dataset.ready !== "1") return null;
    const chips = [...box.querySelectorAll(".cd-chip")];
    if (!chips.length) return null;
    const on = chips.filter(c => c.classList.contains("on")).map(c => c.dataset.cch);
    return (on.length === 0 || on.length === chips.length) ? "" : on.join(",");
  }
  /* 切换「通知内容」时，按模式显示输出行数 / 自定义模板 */
  function cronTaskNotifySync() {
    const sel = $("cronNotifyContent");
    if (!sel) return;
    const chk = $("cronNotify");
    const on = chk ? chk.checked : true;
    const mode = sel.value;
    const linesEl = $("cronNotifyLines");
    const linesWrap = linesEl && linesEl.closest ? linesEl.closest(".cd-notify-lines") : null;
    const tplRow = $("cronNotifyTplRow");
    const hint = $("cronNotifyHint");
    const chEl = $("cronNotifyChannels");
    const chWrap = chEl && chEl.closest ? chEl.closest(".cd-ch") : null;   // 渠道多选块
    if (sel) sel.disabled = !on;                    // 关掉通知后内容选择也置灰，避免以为仍在生效
    if (linesWrap) linesWrap.style.display = (on && mode !== "status") ? "" : "none";
    if (tplRow) tplRow.style.display = (on && mode === "custom") ? "" : "none";
    if (chWrap) chWrap.style.display = on ? "" : "none";
    if (hint) {
      hint.textContent = !on
        ? "关闭后该任务不再发送任何执行通知（「设置 → 定时任务通知」里的开关仍会生效）。"
        : (mode === "status"
          ? "只发送任务名 + 成功 / 失败 + 退出码 + 耗时，不包含脚本输出。"
          : (mode === "custom"
            ? "用下面的模板决定通知内容，可用 {output} 引用脚本输出；留空则回退到全局模板。"
            : "会把命令最后几行输出一起发到通知渠道（桌面 / 邮件 / 钉钉 / Telegram / PushPlus）。"));
    }
    cronTryPreview();                                // 切到 / 离开自定义模板时同步预览显隐
  }

  function cronStatusInfo(s) { return CRON_STATUS[s] || [s || "-", ""]; }
  function cronFmtTime(ts) {
    if (!ts) return "-";
    const d = new Date(ts * 1000), p2 = n => String(n).padStart(2, "0");
    return (d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }
  function cronFmtDur(ms) {
    ms = Math.max(0, Math.round(ms || 0));
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    const m = Math.floor(ms / 60000);
    return m + "m" + Math.round((ms % 60000) / 1000) + "s";
  }
  function cronAct(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body || {}) })
      .then(r => r.json()).catch(() => ({ error: "请求失败" }));
  }

  /* ---------- 列表 ---------- */
  async function loadCron(opts) {
    try {
      const r = await fetch("/api/cron/tasks");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      CRON.tasks = d.tasks || [];
      cronSetBadge(CRON.tasks.length, d.running || 0);
      renderCronList();
      // 编辑区大页也开着时：只刷新统计与表格，保留详情里的日志与滚动位置
      if (typeof cronViewPaintHead === "function" && $("cvTbody")) {
        cronViewPaintHead(); cronViewPaintRows();
      }
    } catch (e) {
      const hint = $("cronHint");
      if (hint && !(opts && opts.silent)) hint.textContent = "读取定时任务失败：" + (e.message || e);
    }
  }
  /* ---------- 活动栏角标：定时任务数量 ----------
     只统计「已启用」的任务个数，停用的不计入；
     悬停提示再给出「启用 N 个 / 共 M 个 · K 个执行中」。 */
  function cronSetBadge(total, running) {
    const el = $("actCronBadge");
    if (!el) return;
    const list = CRON.tasks || [];
    const n = list.filter(x => x.enabled).length;
    const all = list.length;
    const run = (running == null) ? list.filter(x => x.running).length : running;
    if (n > 0) { el.textContent = n > 99 ? "99+" : n; el.style.display = ""; }
    else el.style.display = "none";
    const act = el.closest ? el.closest(".act") : null;
    if (act) {                                       // 悬停提示补上数量，原始标题只记一次
      if (!act.dataset.baseTitle) act.dataset.baseTitle = act.title || "";
      act.title = n
        ? act.dataset.baseTitle + "（启用 " + n + " 个 / 共 " + all + " 个" + (run > 0 ? " · " + run + " 个执行中" : "") + "）"
        : act.dataset.baseTitle;
    }
  }
  /* 编辑区「定时任务管理面板」刷新时同步角标。
     注：以前只有调用处没有这个定义，抛出的 ReferenceError 会被外层 catch 静默吞掉，
     表现为大页里增删任务后角标不更新。 */
  function cronUpdateBadge() { cronSetBadge(); }
  function renderCronList() {
    const box = $("cronList");
    if (!box) return;
    const list = CRON.tasks || [];
    if (!list.length) {
      box.innerHTML = '<div class="ph">还没有定时任务。<br>点上方「新建任务」，用 cron 表达式设定运行时间（如 <code>0 9 * * *</code> 表示每天 9 点）。</div>';
      return;
    }
    box.innerHTML = "";
    list.forEach(t => {
      const st = t.running ? "running" : (t.last_status || "");
      const [sText, sCls] = st ? cronStatusInfo(st) : ["未运行", ""];
      const item = document.createElement("div");
      item.className = "cron-item" + (t.enabled ? "" : " off") + (t.running ? " running" : "");
      item.setAttribute("data-tid", t.id);
      item.innerHTML =
        '<div class="ci-top">' +
          '<label class="ci-switch" title="' + (t.enabled ? "已启用，点击停用" : "已停用，点击启用") + '">' +
            '<input type="checkbox" data-act="toggle"' + (t.enabled ? " checked" : "") + '><span></span></label>' +
          '<span class="ci-name" title="' + escAttr(t.name) + '">' + esc(t.name) + '</span>' +
          (sText ? '<span class="ci-st ' + sCls + '">' + esc(sText) + '</span>' : "") +
        '</div>' +
        '<div class="ci-cron"><i class="bi bi-clock-history"></i><code>' + esc(t.cron) + '</code>' +
          (t.next && t.next.length ? '<span class="ci-next" title="接下来的运行时间">下次 ' + esc(t.next[0]) + '</span>' : "") +
        '</div>' +
        '<div class="ci-cmd" title="' + escAttr(t.command) + '">$ ' + esc(t.command) + '</div>' +
        '<div class="ci-meta">' +
          (t.last_at ? '上次 ' + cronFmtTime(t.last_at) + ' · ' + cronFmtDur(t.last_ms) +
            ' · 共 ' + (t.run_count || 0) + ' 次（成功 ' + (t.ok_count || 0) + '）' : '从未运行过') +
        '</div>' +
        '<div class="ci-acts">' +
          (t.running
            ? '<button data-act="stop" class="ci-btn v-stop" title="停止本次执行"><i class="bi bi-stop-fill"></i></button>'
            : '<button data-act="run" class="ci-btn v-run" title="立即运行一次"><i class="bi bi-play-fill"></i></button>') +
          '<button data-act="runs" class="ci-btn v-log" title="执行记录与日志"><i class="bi bi-list-ul"></i></button>' +
          '<button data-act="edit" class="ci-btn v-edit" title="编辑任务"><i class="bi bi-pencil-square"></i></button>' +
          '<button data-act="del" class="ci-btn v-del" title="删除任务"><i class="bi bi-trash"></i></button>' +
        '</div>';
      const bind = (act, fn) => { const b = item.querySelector('[data-act="' + act + '"]'); if (b) b.onclick = fn; };
      bind("toggle", () => cronToggle(t));
      bind("run", () => cronRun(t));
      bind("stop", () => cronStop(t));
      bind("runs", () => cronOpenRuns(t));
      bind("edit", () => cronOpenEditor(t));
      bind("del", () => cronDelete(t));
      box.appendChild(item);
    });
  }

  /* ---------- 操作 ---------- */
  async function cronToggle(t) {
    const d = await cronAct("/api/cron/toggle", { id: t.id, enabled: !t.enabled });
    if (d.error) { toast(d.error, "err"); loadCron({ silent: true }); return; }
    t.enabled = d.task.enabled; t.next = d.task.next;
    renderCronList();
    toast(t.enabled ? "已启用：" + t.name : "已停用：" + t.name, "ok");
  }
  async function cronRun(t) {
    const d = await cronAct("/api/cron/run", { id: t.id });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已开始执行：" + t.name, "ok");
    loadCron({ silent: true });
    // 执行记录浮层正开着这个任务：刷新到最新一次（刚启动的那条）并自动跟踪日志
    if (CRON.runTask && CRON.runTask.id === t.id) cronOpenRuns(t, false);
  }
  async function cronStop(t) {
    const d = await cronAct("/api/cron/stop", { id: t.id });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已停止：" + t.name, "warn");
    loadCron({ silent: true });
  }
  async function cronDelete(t) {
    const ok = await uiConfirm("删除定时任务",
      "确定删除「" + t.name + "」吗？它的执行记录与日志文件会一起清掉，此操作不可撤销。", "删除", true);
    if (!ok) return;
    const d = await cronAct("/api/cron/delete", { id: t.id });
    if (d.error) { toast(d.error, "err"); return; }
    if (CRON.runTask && CRON.runTask.id === t.id) cronCloseModal();
    CRON.tasks = CRON.tasks.filter(x => x.id !== t.id);
    renderCronList();
    cronSetBadge();                                  // 任务少了一个：角标重算
    if (!CRON.tasks.length) renderCronList();
    toast("已删除：" + t.name, "ok");
  }

  /* ---------- 编辑器（浮层表单） ---------- */
  function cronEnsureModal() {
    let ov = $("cronModal");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.className = "cron-modal-overlay";
    ov.id = "cronModal";
    ov.style.display = "none";
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) cronCloseModal(); });
    return ov;
  }
  function cronCloseModal() {
    const ov = $("cronModal");
    if (ov) { ov.style.display = "none"; ov.innerHTML = ""; }
    clearTimeout(CRON.logTimer);
    CRON.logTimer = null;
    CRON.runTask = null; CRON.logRun = null;
  }
  /* t：编辑已有任务；prefill：新建时的预填内容（如从文件右键「添加定时任务」带过来） */
  function cronOpenEditor(t, prefill) {
    const ov = cronEnsureModal();
    CRON.editing = t || null;
    const isNew = !t;
    const src = t || prefill || {};
    const val = (k, d) => {
      const v = src[k];
      return (v !== undefined && v !== null && v !== "") ? v : d;
    };
    // 通知内容：默认「仅执行结果」+ 开启通知（与后端默认一致）
    const nOn = src.notify !== false && src.notify !== 0;
    const nMode = CRON_TASK_NOTIFY_MODES.some(m => m[0] === src.notify_content) ? src.notify_content : "status";
    const nLines = (src.notify_lines === 0 || src.notify_lines) ? src.notify_lines : 20;
    const nTitle = src.notify_title || "";
    const nBody = src.notify_body || "";
    // 通知渠道：原值（逗号分隔，空 = 跟随通知设置里的全部已启用渠道）
    CRON.editChRaw = String(src.notify_channels || "");
    CRON.tryFields = null;                           // 本次试运行解析出的 JSON 字段
    CRON.trySnap = null;                             // 本次试运行的输出快照（通知预览用）
    ov.innerHTML =
      '<div class="cron-dialog">' +
        '<div class="cd-head"><i class="bi bi-alarm"></i><span>' + (isNew ? "新建定时任务" : "编辑定时任务") + '</span>' +
          '<button class="cd-x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
        '<div class="cd-body">' +
          '<div class="cd-row"><label>任务名称</label>' +
            '<input id="cronName" placeholder="例如：每日备份" value="' + escAttr(val("name", "")) + '"></div>' +
          '<div class="cd-row"><label>执行命令</label>' +
            '<textarea id="cronCmd" rows="3" spellcheck="false" placeholder="例如：python /path/to/job.py &gt;&gt; out.log 2&gt;&amp;1">' +
              esc(val("command", "")) + '</textarea></div>' +
          '<div class="cd-row"><label>cron 表达式 <span class="cd-lbl-tip">分 时 日 月 周</span></label>' +
            '<div class="cd-cron-row"><input id="cronExpr" placeholder="0 9 * * *" spellcheck="false" autocomplete="off" value="' +
              escAttr(val("cron", "")) + '"><span class="cd-cron-tip" id="cronExprTip"></span></div>' +
            '<div class="cd-presets">' + CRON_PRESETS.map(([n, e]) =>
              '<button type="button" data-expr="' + escAttr(e) + '">' + esc(n) + '</button>').join("") + '</div></div>' +
          '<div class="cd-row2">' +
            '<div class="cd-row"><label>工作目录（可选）</label>' +
              '<input id="cronCwd" placeholder="' + escAttr(typeof ROOT !== "undefined" ? ROOT : "") + '" value="' +
                escAttr(val("cwd", "")) + '"></div>' +
            '<div class="cd-row cd-row-sm"><label>超时（秒，0 不限）</label>' +
              '<input id="cronTimeout" type="number" min="0" step="1" value="' + escAttr(val("timeout", 0)) + '"></div>' +
          '</div>' +
          '<div class="cd-row"><label>备注（可选）</label>' +
            '<input id="cronRemark" placeholder="给自己看的说明" value="' + escAttr(val("remark", "")) + '"></div>' +
          '<div class="cd-row cd-notify">' +
            '<div class="cd-notify-head">' +
              '<label>通知内容</label>' +
              '<span class="cd-nh-right">' +
                '<button type="button" class="cd-try-btn" id="cronTryRun" title="用上面的命令试跑一次（不写执行记录、不发通知），先看看脚本输出什么">' +
                  '<i class="bi bi-play-circle"></i> 测试运行</button>' +
                '<label class="cd-check"><input type="checkbox" id="cronNotify"' + (nOn ? " checked" : "") +
                  '> 执行后发送通知</label>' +
              '</span>' +
            '</div>' +
            '<div class="cd-notify-row">' +
              '<select id="cronNotifyContent" class="cd-select">' +
                CRON_TASK_NOTIFY_MODES.map(m =>
                  '<option value="' + m[0] + '"' + (nMode === m[0] ? " selected" : "") + '>' + esc(m[1]) + '</option>'
                ).join("") +
              '</select>' +
              '<span class="cd-notify-lines"' + ((nOn && nMode !== "status") ? "" : ' style="display:none"') +
                '><label for="cronNotifyLines">末尾行数</label>' +
                '<input id="cronNotifyLines" type="number" min="0" max="200" step="1" value="' + escAttr(nLines) +
                  '" title="附带脚本输出时取日志末尾多少行（0 = 不限，仍受长度上限约束）"></span>' +
            '</div>' +
            '<div class="cd-ch">' +
              '<div class="cd-ch-head"><span>通知渠道</span>' +
                '<span class="cd-ch-tip">只列「设置 → 定时任务通知」里已启用的</span></div>' +
              '<div class="cd-chips" id="cronNotifyChannels"><span class="cd-ch-empty">加载中…</span></div>' +
              '<div class="cd-hint" id="cronNotifyChHint"></div>' +
            '</div>' +
            '<div class="cd-hint" id="cronNotifyHint">用「脚本输出」可把命令最后几行输出一起发到通知渠道（桌面 / 邮件 / 钉钉 / Telegram / PushPlus）。</div>' +
            '<div class="cd-try" id="cronTryBox" style="display:none">' +
              '<div class="cd-try-head">' +
                '<span class="cd-try-st" id="cronTryStatus"></span>' +
                '<span class="cd-spacer"></span>' +
                '<button type="button" class="cd-mini ai" id="cronTryAi" title="用 AI 根据这次输出生成一版好看的通知文案（保留 {task} 等变量）">' +
                  '<i class="bi bi-stars"></i> AI 生成文案</button>' +
                '<button type="button" class="cd-mini" id="cronTryToTpl" title="切到「自定义模板」并把 {output} 加进正文">写进通知正文</button>' +
                '<button type="button" class="cd-mini" id="cronTryCopy">复制输出</button>' +
                '<button type="button" class="cd-mini" id="cronTryClear">收起</button>' +
              '</div>' +
              '<pre class="cd-try-out scroll-thin" id="cronTryOut"></pre>' +
              '<div class="cd-hint" id="cronTryHint"></div>' +
            '</div>' +
          '</div>' +
          '<div class="cd-notify-tpl" id="cronNotifyTplRow"' +
            ((nOn && nMode === "custom") ? "" : ' style="display:none"') + '>' +
            '<div class="cd-row"><label>自定义标题（可选，留空 = 用「设置 → 定时任务通知」里的全局模板）</label>' +
              '<input id="cronNotifyTitle" placeholder="定时任务{event} · {task}" value="' + escAttr(nTitle) + '"></div>' +
            '<div class="cd-row"><label>自定义正文（可选，可用下方变量）</label>' +
              '<textarea id="cronNotifyBody" rows="3" spellcheck="false" placeholder="任务「{task}」{event}。&#10;{output}">' +
                esc(nBody) + '</textarea></div>' +
            '<div class="cd-nvars">' + CRON_TASK_NOTIFY_VARS.map(v =>
              '<button type="button" class="cd-nvar" data-var="{' + v[0] + '}" title="' + escAttr(v[2]) + '">{' +
                v[0] + '}</button>').join("") + '</div>' +
            '<div class="cd-nvars" id="cronJsonVars" style="display:none"></div>' +
            '<div class="cd-hint" id="cronJsonHint">脚本输出是 JSON 对象时，点上面的「测试运行」会把字段变成可点变量（如 {order_count}），发送通知时自动替换。</div>' +
            // 通知预览放在自定义标题 / 正文下面：改模板能立刻看到最终效果
            '<div class="cd-try-prev" id="cronTryPrev" style="display:none">' +
              '<div class="cd-try-prev-h"><i class="bi bi-send"></i> 通知预览' +
                '<span class="cd-hint" id="cronTryPrevTitle"></span></div>' +
              '<pre class="cd-try-out" id="cronTryPrevBody"></pre>' +
            '</div>' +
          '</div>' +
          '<label class="cd-check"><input type="checkbox" id="cronEnabled"' + (val("enabled", true) ? " checked" : "") +
            '> 创建后立即启用</label>' +
          '<div class="cd-err" id="cronFormErr"></div>' +
        '</div>' +
        '<div class="cd-foot">' +
          '<span class="cd-spacer"></span>' +
          '<button class="cd-btn" id="cronCancel">取消</button>' +
          '<button class="cd-btn primary" id="cronSave">保存</button>' +
        '</div>' +
      '</div>';
    ov.style.display = "flex";
    const exprEl = $("cronExpr");
    const validate = () => {
      const expr = exprEl.value.trim();
      const tip = $("cronExprTip");
      if (!expr) { tip.textContent = ""; tip.className = "cd-cron-tip"; return; }
      cronAct("/api/cron/validate", { cron: expr }).then(d => {
        if (d.ok) {
          tip.textContent = (d.next && d.next.length) ? "下次 " + d.next[0].slice(5) : "未来 5 年内不会触发";
          tip.className = "cd-cron-tip ok";
        } else {
          tip.textContent = d.tip || "表达式非法";
          tip.className = "cd-cron-tip bad";
        }
      });
    };
    exprEl.addEventListener("input", validate);
    if (exprEl.value.trim()) validate();
    ov.querySelectorAll(".cd-presets button").forEach(b => {
      b.onclick = () => { exprEl.value = b.dataset.expr; validate(); };
    });
    ov.querySelector(".cd-x").onclick = cronCloseModal;
    $("cronCancel").onclick = cronCloseModal;
    $("cronSave").onclick = cronSave;
    // 通知内容切换：按模式显示「输出行数」/「自定义模板」并同步提示文案
    const nSel = $("cronNotifyContent"), nChk = $("cronNotify");
    if (nSel) nSel.onchange = cronTaskNotifySync;
    if (nChk) nChk.onchange = cronTaskNotifySync;
    cronTaskNotifySync();
    cronTaskChannelsLoad();                          // 渠道 chips：异步拉全局已启用渠道后渲染
    // 试运行：跑一次脚本，输出直接显示在「通知内容」下方，便于据此写自定义模板
    const tryBtn = $("cronTryRun");
    if (tryBtn) tryBtn.onclick = cronTryRun;
    const tryCopy = $("cronTryCopy");
    if (tryCopy) tryCopy.onclick = cronTryCopy;
    const tryTpl = $("cronTryToTpl");
    if (tryTpl) tryTpl.onclick = cronTryToTpl;
    const tryAi = $("cronTryAi");
    if (tryAi) tryAi.onclick = cronTryAi;
    const tryClear = $("cronTryClear");
    if (tryClear) tryClear.onclick = () => { const b = $("cronTryBox"); if (b) b.style.display = "none"; };

    CRON.tplTarget = null;                           // 变量按钮插入到最后聚焦的输入框
    ["cronNotifyTitle", "cronNotifyBody"].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("focus", () => { CRON.tplTarget = el; });
      el.addEventListener("input", cronTryPreviewSoon);   // 改模板即时刷新「通知预览」
    });
    ov.querySelectorAll(".cd-nvar").forEach(b => { b.onclick = () => cronInsertVar(b.dataset.var); });
    setTimeout(() => { const n = $("cronName"); if (n) n.focus(); }, 30);
  }
  /* ---------- 试运行（只看输出，不写记录、不发通知） ---------- */
  /* 往自定义标题 / 正文的光标处插入一个模板变量 */
  function cronInsertVar(token) {
    const el = CRON.tplTarget || $("cronNotifyBody");
    if (!el) return;
    const s = el.selectionStart == null ? el.value.length : el.selectionStart;
    const e2 = el.selectionEnd == null ? s : el.selectionEnd;
    el.value = el.value.slice(0, s) + token + el.value.slice(e2);
    el.focus();
    el.selectionStart = el.selectionEnd = s + token.length;
  }
  /* 脚本输出是 JSON 对象时，把顶层字段做成可点变量（发送时后端同样会展开） */
  function cronTryRenderFields(fields) {
    const box = $("cronJsonVars");
    if (!box) return;
    const keys = Object.keys(fields || {});
    CRON.tryFields = fields || {};
    if (!keys.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    box.style.display = "";
    box.innerHTML = '<span class="cd-nvars-lbl">输出字段</span>' + keys.map(k =>
      '<button type="button" class="cd-nvar out" data-var="{' + escAttr(k) + '}" title="' +
        escAttr(String(fields[k]).slice(0, 200)) + '">{' + esc(k) + '}</button>').join("");
    box.querySelectorAll(".cd-nvar").forEach(b => { b.onclick = () => cronInsertVar(b.dataset.var); });
  }
  var cronPrevTimer = null;
  /* 记住这次试运行的结果，供「通知预览」在本地渲染 */
  function cronTrySnapshot(d) {
    CRON.trySnap = {
      ok: !!d.ok, exit: d.exit_code, dur: d.duration || 0,
      tail: d.tail || "", fields: d.fields || {},
    };
  }
  /* 按当前模板 + 最近一次试运行结果渲染通知预览：改标题/正文即时刷新，不用重跑脚本 */
  function cronTryPreview() {
    const box = $("cronTryPrev");
    if (!box) return;
    const sel = $("cronNotifyContent");
    if (sel && sel.value !== "custom") { box.style.display = "none"; return; }
    const snap = CRON.trySnap;
    if (!snap) { box.style.display = "none"; return; }
    // 还没拿到全局模板时用默认模板（与后端 DEFAULT_CFG 一致），保证预览不空着
    const gt = CRON.notifyTpl || {
      title: "定时任务{event} · {task}",
      body: "任务「{task}」{event}。\n退出码：{exit}\n耗时：{duration}\n时间：{date} {time}\n执行记录：{run}",
    };
    const tVal = (($("cronNotifyTitle") || {}).value || "").trim();
    const bVal = ($("cronNotifyBody") || {}).value || "";
    const tTpl = tVal || String(gt.title || "").trim();
    const bTpl = bVal.trim() || String(gt.body || "").trim();
    if (!tTpl && !bTpl) { box.style.display = "none"; return; }
    const name = (($("cronName") || {}).value || "").trim() || "（未命名任务）";
    const now = new Date(), p2 = n => String(n).padStart(2, "0");
    const vars = {
      task: name,
      event: snap.ok ? "执行成功" : "执行失败",
      status: snap.ok ? "成功" : "失败",
      exit: snap.exit == null ? "无" : String(snap.exit),
      duration: (Math.max(0, snap.dur || 0) / 1000).toFixed(1) + "s",
      run: "（试运行）", attempt: "",
      date: now.getFullYear() + "-" + p2(now.getMonth() + 1) + "-" + p2(now.getDate()),
      time: p2(now.getHours()) + ":" + p2(now.getMinutes()),
      output: snap.tail,
    };
    Object.keys(snap.fields).forEach(k => { if (!(k in vars)) vars[k] = snap.fields[k]; });
    const sub = s => String(s || "").replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (m, k) => (k in vars ? String(vars[k]) : m));
    box.style.display = "";
    const h = $("cronTryPrevTitle"), b = $("cronTryPrevBody");
    if (h) h.textContent = sub(tTpl) || "（无标题）";
    if (b) b.textContent = sub(bTpl) || "（正文为空）";
  }
  function cronTryPreviewSoon() {
    clearTimeout(cronPrevTimer);
    cronPrevTimer = setTimeout(cronTryPreview, 250);
  }
  async function cronTryRun() {
    const btn = $("cronTryRun"), box = $("cronTryBox"), out = $("cronTryOut");
    const st = $("cronTryStatus"), hint = $("cronTryHint");
    if (!btn || !box || !out) return;
    const cmd = $("cronCmd").value.trim();
    if (!cmd) { toast("请先填写执行命令", "warn"); $("cronCmd").focus(); return; }
    // 预览口径跟「末尾行数」一致（用 output / output_only / custom 时才有意义，status 也给个预览）
    let lines = 20;
    const ln = $("cronNotifyLines");
    if (ln && String(ln.value).trim() !== "") {
      const n = parseInt(ln.value, 10);
      lines = isNaN(n) ? 20 : Math.max(0, Math.min(n, 200));
    }
    box.style.display = "";
    out.textContent = "";
    if (hint) hint.textContent = "";
    st.className = "cd-try-st";
    st.textContent = "运行中…（最多等 120 秒）";
    btn.disabled = true;
    try {
      const d = await cronAct("/api/cron/dry-run", {
        command: cmd,
        cwd: $("cronCwd").value.trim(),
        timeout: parseInt($("cronTimeout").value, 10) || 0,
        lines: lines,
        name: $("cronName").value.trim(),
        // 「自定义模板」模式下后端会顺手渲染一条通知预览（不发送）
        notify_content: $("cronNotifyContent") ? $("cronNotifyContent").value : "status",
        notify_title: $("cronNotifyTitle") ? $("cronNotifyTitle").value.trim() : "",
        notify_body: $("cronNotifyBody") ? $("cronNotifyBody").value.trim() : "",
      });
      if (d.error) {
        st.className = "cd-try-st bad";
        st.textContent = "试运行失败：" + d.error;
        return;
      }
      const ok = !!d.ok;
      st.className = "cd-try-st " + (ok ? "ok" : "bad");
      st.textContent = (d.timed_out ? "运行超时，已被终止" : (ok ? "执行成功" : "执行失败")) +
        " · 退出码 " + (d.exit_code == null ? "-" : d.exit_code) +
        " · 耗时 " + cronFmtDur(d.duration) +
        (d.truncated ? " · 输出过长，只显示末尾部分" : "");
      out.textContent = d.output || "（脚本没有任何输出）";
      cronTryRenderFields(d.fields);
      cronTrySnapshot(d);                          // 记下这次输出，改模板时本地即时重渲染预览
      cronTryPreview();
      if (hint) {
        const tailN = d.tail ? String(d.tail).split("\n").length : 0;
        const nf = Object.keys(d.fields || {}).length;
        hint.textContent = !d.tail
          ? "脚本没有输出：通知内容选「仅脚本输出」时会回退成执行结果。"
          : "通知里会带上末尾 " + (lines ? Math.min(lines, tailN) : tailN) + " 行输出；" +
            "想自定义文案可切到「自定义模板」，用 {output} 引用这段输出。";
        if (nf) hint.textContent += "已解析出 " + nf + " 个输出字段，可在「自定义模板」里点选插入。";
      }
    } catch (e) {
      st.className = "cd-try-st bad";
      st.textContent = "试运行失败：" + (e && e.message ? e.message : e);
    } finally {
      btn.disabled = false;
    }
  }
  function cronTryCopy() {
    const out = $("cronTryOut");
    const text = out ? out.textContent : "";
    if (!text) { toast("还没有输出可复制", "warn"); return; }
    const done = () => toast("已复制脚本输出", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => cronTryCopyFallback(text, done));
    } else {
      cronTryCopyFallback(text, done);
    }
  }
  function cronTryCopyFallback(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); }
    catch (_) { toast("复制失败，请手动选中文本", "err"); }
    ta.remove();
  }
  /* 把试运行结果接进自定义通知：切到「自定义模板」，按输出字段生成一段骨架 */
  function cronTryToTpl() {
    const sel = $("cronNotifyContent");
    if (sel && sel.value !== "custom") sel.value = "custom";
    if (sel) cronTaskNotifySync();
    const bodyEl = $("cronNotifyBody");
    if (bodyEl) {
      if (!bodyEl.value.trim()) {
        const keys = Object.keys(CRON.tryFields || {});
        // 有 JSON 字段就顺手写成「order_count：{order_count}，error_count：{error_count}」
        const line = keys.slice(0, 6).map(k => k + "：{" + k + "}").join("，");
        bodyEl.value = "任务「{task}」{event}。" + (line ? "\n" + line : "") + "\n\n{output}";
      } else if (bodyEl.value.indexOf("{output}") < 0) {
        bodyEl.value = bodyEl.value.replace(/\s*$/, "") + "\n\n{output}";
      }
      bodyEl.focus();
    }
    toast("已切到「自定义模板」，改改文案即可", "ok");
  }

  /* AI 生成一版好看的自定义通知文案（需要先在「设置 → AI 助手」配好接口） */
  async function cronTryAi() {
    const btn = $("cronTryAi");
    const snap = CRON.trySnap;
    if (!snap) { toast("先点「测试运行」，让 AI 知道脚本会输出什么", "warn"); return; }
    const cmd = $("cronCmd").value.trim();
    if (!cmd) { toast("请先填写执行命令", "warn"); return; }
    if (!btn || btn.disabled) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-stars"></i> 生成中…';
    try {
      const d = await cronAct("/api/cron/notify-ai", {
        name: $("cronName").value.trim(),
        command: cmd,
        output: snap.tail || "",
        fields: snap.fields || {},
        ok: !!snap.ok, exit: snap.exit, duration: snap.dur,
        channels: cronTryChannelNames(),
      });
      if (d.error) { toast(d.error, "err"); return; }
      if (!d.title && !d.body) { toast("AI 没有返回可用文案，请重试", "warn"); return; }
      const sel = $("cronNotifyContent");
      if (sel) { sel.value = "custom"; cronTaskNotifySync(); }
      const tEl = $("cronNotifyTitle"), bEl = $("cronNotifyBody");
      if (tEl && d.title) tEl.value = d.title;
      if (bEl && d.body) bEl.value = d.body;
      cronTryPreview();                          // 直接赋值不会触发 input 事件，这里手动刷预览
      toast("AI 文案已填好，微调后保存即可", "ok");
    } catch (e) {
      toast("AI 生成失败：" + (e && e.message ? e.message : e), "err");
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }
  function cronTryChannelNames() {
    const box = $("cronNotifyChannels");
    if (!box) return "";
    return [...box.querySelectorAll(".cd-chip.on")]
      .map(c => c.textContent.trim()).filter(Boolean).join("、");
  }

  async function cronSave() {
    const err = $("cronFormErr");
    // 输出行数：留空用默认 20，填 0 表示不限行（仍受单条通知长度上限约束）
    let nLines = 20;
    const lnEl = $("cronNotifyLines");
    if (lnEl && String(lnEl.value).trim() !== "") {
      const n = parseInt(lnEl.value, 10);
      nLines = isNaN(n) ? 20 : Math.max(0, Math.min(n, 200));
    }
    // 通知渠道：界面还没就绪（加载中 / 读取失败）时保持原值，避免误清空
    const chVal = cronTaskChannelsValue();
    const nChannels = chVal === null ? String(CRON.editChRaw || "") : chVal;
    const body = {
      id: CRON.editing ? CRON.editing.id : "",
      name: $("cronName").value.trim(),
      command: $("cronCmd").value.trim(),
      cron: $("cronExpr").value.trim(),
      cwd: $("cronCwd").value.trim(),
      remark: $("cronRemark").value.trim(),
      timeout: parseInt($("cronTimeout").value, 10) || 0,
      enabled: $("cronEnabled").checked,
      // 通知：是否发送 + 内容（仅结果 / 带脚本输出 / 仅输出 / 自定义模板）
      notify: $("cronNotify") ? $("cronNotify").checked : true,
      notify_content: $("cronNotifyContent") ? $("cronNotifyContent").value : "status",
      notify_lines: nLines,
      notify_title: $("cronNotifyTitle") ? $("cronNotifyTitle").value.trim() : "",
      notify_body: $("cronNotifyBody") ? $("cronNotifyBody").value.trim() : "",
      notify_channels: nChannels,
    };
    if (!body.name) { err.textContent = "请填写任务名称"; return; }
    if (!body.command) { err.textContent = "请填写要执行的命令"; return; }
    if (!body.cron) { err.textContent = "请填写 cron 表达式"; return; }
    err.textContent = "";
    const d = await cronAct("/api/cron/save", body);
    if (d.error) { err.textContent = d.error; return; }
    cronCloseModal();
    toast((CRON.editing ? "已保存：" : "已创建：") + d.task.name, "ok");
    loadCron({ silent: true });
  }

  /* 从文件右键「添加定时任务…」：按文件类型推断解释器，预填名称 / 命令 / 工作目录。
     任务名称默认取【项目文件夹名】（当前打开的项目根目录名，如 File_Flask），
     项目没打开时退回文件所在目录名，再退回文件名。 */
  const cronLastSeg = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  async function cronFromFile(path, name) {
    let sug = {};
    try {
      const r = await fetch("/api/cron/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path }),
      });
      sug = await r.json();
      if (sug.error) sug = {};
    } catch (_) { sug = {}; }
    const proj = (typeof ROOT !== "undefined" && ROOT) ? cronLastSeg(ROOT) : "";
    const fallback = cronLastSeg(sug.cwd || path);
    const stem = String(name || "").replace(/\.[^.]+$/, "") || name || "定时任务";
    cronOpenEditor(null, {
      name: proj || fallback || stem,
      command: sug.command || path,
      cwd: sug.cwd || (typeof ROOT !== "undefined" ? ROOT : ""),
      cron: "0 0 * * *",                     // 默认每天 0 点，进编辑器可直接改
      timeout: 0,
      enabled: true,
    });
    toast(sug.runner ? ("已按 " + sug.runner + " 预填命令，改成需要的时间后保存即可")
                     : "已预填文件路径，补全命令与时间后保存即可", "info");
  }

  /* ---------- 执行记录 + 日志 ---------- */
  async function cronOpenRuns(t, keepLog) {
    const ov = cronEnsureModal();
    CRON.runTask = t;
    if (!keepLog || !ov.querySelector(".cron-runs-dialog")) {
      const pre = CRON.logRun ? CRON.logRun.id : "";
      CRON.logRun = null; CRON.logOffset = 0; CRON.notifyRun = null; CRON.notifyKey = undefined;
      ov.innerHTML =
        '<div class="cron-dialog cron-runs-dialog">' +
          '<div class="cd-head"><i class="bi bi-list-ul"></i><span></span>' +
            '<button class="cd-x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
          '<div class="cr-body">' +
            '<div class="cr-list scroll-thin" id="cronRunList"><div class="ph">加载中…</div></div>' +
            '<div class="cr-logwrap">' +
              '<div class="cr-log-head"><span id="cronLogTitle">选择左侧的一条记录查看日志</span>' +
                '<span class="cd-spacer"></span>' +
                '<button class="cr-mini" id="cronLogRefresh" title="刷新日志"><i class="bi bi-arrow-clockwise"></i></button>' +
              '</div>' +
              '<pre class="cr-log scroll-thin" id="cronLog"></pre>' +
              '<div class="cr-nf" id="cronNotify">' +
                '<div class="cr-nf-head" id="cronNotifyHead" title="点击折叠 / 展开">' +
                  '<i class="bi bi-bell"></i><span>通知记录</span>' +
                  '<span class="cr-nf-sum" id="cronNotifySum"></span>' +
                  '<span class="cd-spacer"></span>' +
                  '<button class="cr-mini" id="cronNotifyRefresh" title="刷新通知记录"><i class="bi bi-arrow-clockwise"></i></button>' +
                  '<i class="bi bi-chevron-down cr-nf-arrow"></i>' +
                '</div>' +
                '<div class="cr-nf-list scroll-thin" id="cronNotifyList"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="cd-foot"><span class="cd-spacer"></span>' +
            '<button class="cd-btn" id="cronRunsClear" title="清空非运行中的执行记录">清空记录</button>' +
            '<button class="cd-btn" id="cronRunsClose">关闭</button></div>' +
        '</div>';
      ov.style.display = "flex";
      ov.querySelector(".cd-x").onclick = cronCloseModal;
      $("cronRunsClose").onclick = cronCloseModal;
      $("cronRunsClear").onclick = async () => {
        const ok = await uiConfirm("清空执行记录", "确定清空「" + t.name + "」的历史执行记录与日志吗？（正在运行的会保留）", "清空", true);
        if (!ok) return;
        const d = await cronAct("/api/cron/clear-runs", { id: t.id });
        if (d.error) { toast(d.error, "err"); return; }
        toast("已清空 " + (d.removed || 0) + " 条记录", "ok");
        cronLoadRuns(t, pre);
      };
      $("cronLogRefresh").onclick = () => cronLoadLog(CRON.logRun, true);
      // 通知记录：点标题折叠 / 展开，刷新按钮重新拉取当前这次执行的推送结果
      const nfHead = $("cronNotifyHead"), nfBox = $("cronNotify");
      if (nfHead && nfBox) {
        nfHead.onclick = (e) => {
          if (e.target.closest("button")) return;
          nfBox.classList.toggle("off");
        };
      }
      const nfBtn = $("cronNotifyRefresh");
      if (nfBtn) {
        nfBtn.onclick = (e) => {
          e.stopPropagation();
          cronLoadNotify(CRON.logRun);
        };
      }
    }
    ov.querySelector(".cd-head span").textContent = "执行记录 · " + t.name;
    cronLoadRuns(t, keepLog ? (CRON.logRun ? CRON.logRun.id : "") : "");
  }
  async function cronLoadRuns(t, selectId) {
    const r = await fetch("/api/cron/runs?task_id=" + encodeURIComponent(t.id) + "&limit=60");
    const d = await r.json().catch(() => ({}));
    const runs = d.runs || [];
    CRON.runs = runs;
    const box = $("cronRunList");
    if (!box) return;
    if (!runs.length) {
      box.innerHTML = '<div class="ph">还没有执行记录</div>';
      $("cronLogTitle").textContent = "还没有执行记录";
      $("cronLog").textContent = "";
      const nf = $("cronNotifyList");
      if (nf) nf.innerHTML = '<div class="cr-nf-empty">还没有执行记录</div>';
      return;
    }
    box.innerHTML = "";
    const target = runs.find(x => x.id === selectId) || runs[0];
    runs.forEach(x => {
      const [sText, sCls] = cronStatusInfo(x.status);
      const row = document.createElement("div");
      row.className = "cr-row" + (target && x.id === target.id ? " on" : "");
      row.setAttribute("data-rid", x.id);
      const byManual = x.trigger === "manual";
      row.innerHTML = '<span class="cr-dot ' + sCls + '"></span>' +
        '<div class="cr-row-m"><div class="cr-row-t">' + esc(cronFmtTime(x.started_at)) +
          ' <span class="cr-by" title="' + (byManual ? "手动触发" : "定时触发") + '">' +
            '<i class="bi ' + (byManual ? "bi-hand-index" : "bi-clock") + '"></i>' +
            (byManual ? "手动" : "定时") + '</span></div>' +
          '<div class="cr-row-s">' + esc(sText) + (x.status !== "running" ? " · " + cronFmtDur(x.duration) : "") + '</div></div>';
      row.onclick = () => {
        box.querySelectorAll(".cr-row").forEach(e => e.classList.remove("on"));
        row.classList.add("on");
        cronLoadLog(x);
      };
      box.appendChild(row);
    });
    if (target) cronLoadLog(target);
  }
  function cronLoadLog(run, force) {
    if (!run) return;
    CRON.logRun = run;
    const pre = $("cronLog");
    const title = $("cronLogTitle");
    if (!pre) return;
    if (force) { CRON.logOffset = 0; pre.textContent = ""; }
    const [sText] = cronStatusInfo(run.status);
    title.textContent = cronFmtTime(run.started_at) + " · " + sText +
      (run.exit_code === null || run.exit_code === undefined ? "" : " · 退出码 " + run.exit_code);
    cronLoadNotify(run);
    clearTimeout(CRON.logTimer);
    const pull = () => {
      fetch("/api/cron/log?run_id=" + encodeURIComponent(run.id) + "&offset=" + CRON.logOffset)
        .then(r => r.json()).then(d => {
          if (d.error) { pre.textContent += "\n[读取失败] " + d.error; return; }
          if (d.text) {
            CRON.logOffset = d.offset;
            const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 60;
            pre.textContent += d.text;
            if (nearBottom) pre.scrollTop = pre.scrollHeight;
          }
          if (d.running) CRON.logTimer = setTimeout(pull, 1000);
          else {
            cronRefreshRunRow(run.id, d.status);
            // 通知是在执行结束后才发的：稍等一下再拉一次，避免停在「没有通知」
            setTimeout(() => {
              if (CRON.logRun && CRON.logRun.id === run.id && $("cronNotifyList")) cronLoadNotify(run);
            }, 1200);
          }
        }).catch(() => { CRON.logTimer = setTimeout(pull, 1500); });
    };
    pull();
  }
  function cronRefreshRunRow(rid, status) {
    const [sText, sCls] = cronStatusInfo(status);
    const row = document.querySelector('#cronRunList .cr-row[data-rid="' + rid + '"]');
    if (row) {                                    // 执行结束：是圆点和文字一起更新，别只换个颜色
      const dot = row.querySelector(".cr-dot");
      if (dot) dot.className = "cr-dot " + sCls;
      const sEl = row.querySelector(".cr-row-s");
      if (sEl) sEl.textContent = sText;
    }
    if (CRON.logRun && CRON.logRun.id === rid) {   // 日志标题里的状态也跟着改
      CRON.logRun.status = status;
      const title = $("cronLogTitle");
      if (title) {
        title.textContent = cronFmtTime(CRON.logRun.started_at) + " · " + sText +
          (CRON.logRun.exit_code === null || CRON.logRun.exit_code === undefined
            ? "" : " · 退出码 " + CRON.logRun.exit_code);
      }
    }
    loadCron({ silent: true });
  }

  /* ---------- 通知记录（本次执行推送了哪些渠道、成功与否） ---------- */
  const CRON_NF_CH = { desktop: "桌面", email: "邮件", smtp: "邮件",
                       dingtalk: "钉钉", telegram: "Telegram", pushplus: "PushPlus" };
  const CRON_NF_EVENT = { success: ["执行成功", "ok"], fail: ["执行失败", "bad"],
                          timeout: ["执行超时", "warn"], retry: ["安排重试", "warn"] };
  const CRON_NF_SKIP = { disabled: "通知总开关未开启", "event-off": "该事件未勾选",
                         "task-off": "任务关闭了「执行后发送通知」" };
  async function cronLoadNotify(run) {
    const list = $("cronNotifyList");
    if (!list || !run) return;
    // 同一条执行重复刷新时保留已有内容（不再闪「加载中」），否则高度会一跳一跳
    const sameRun = CRON.notifyRun === run.id && CRON.notifyKey !== undefined;
    CRON.notifyRun = run.id;
    if (!sameRun) {
      CRON.notifyKey = null;
      const sum = $("cronNotifySum");
      if (sum) sum.textContent = "";
      list.innerHTML = '<div class="cr-nf-empty">加载中…</div>';
    }
    let key, recs = null, errText = "";
    try {
      // 读该次执行日志旁的 .notify.json：只含这一次执行自己的通知，不会混进别的任务
      const r = await fetch("/api/cron/notify-log?run_id=" + encodeURIComponent(run.id));
      const d = await r.json().catch(() => ({}));
      if (CRON.notifyRun !== run.id) return;       // 期间切了别的执行记录：丢弃
      if (!r.ok && !d.error) errText = "通知记录接口不可用，请重启服务后重试";
      else if (d.error) errText = String(d.error);
      else recs = d.records || [];
    } catch (_) {
      if (CRON.notifyRun !== run.id) return;
      errText = "通知记录加载失败";
    }
    if (errText) {
      key = "err:" + errText;
      if (key === CRON.notifyKey) return;
      CRON.notifyKey = key;
      list.innerHTML = '<div class="cr-nf-empty">' + esc(errText) + '</div>';
      return;
    }
    key = run.id + "|" + JSON.stringify(recs);
    if (key === CRON.notifyKey) return;            // 数据没变：不重绘，避免布局抖动
    CRON.notifyKey = key;
    cronRenderNotify(recs);
  }
  function cronRenderNotify(recs) {
    const list = $("cronNotifyList"), sum = $("cronNotifySum");
    if (!list) return;
    if (!recs.length) {
      if (sum) sum.textContent = "";
      list.innerHTML = '<div class="cr-nf-empty">本次执行没有通知记录' +
        '<div>可能是该事件没勾选 / 通知总开关关闭，或这条执行早于功能更新' +
        '（从更新后新发起的执行开始记录）。</div></div>';
      return;
    }
    let okN = 0, badN = 0;
    recs.forEach(r => {
      const chs = Object.keys(r.channels || {});
      if (!chs.length) return;
      if (chs.every(k => (r.channels[k] || {}).ok)) okN++;
      else badN++;
    });
    if (sum) sum.textContent = "共 " + recs.length + " 条" + (okN + badN ? " · 成功 " + okN + " / 失败 " + badN : "");
    list.innerHTML = cronNotifyItemsHtml(recs);
    list.onclick = (e) => {                        // 点渠道 / 正文展开：看完整文案与各渠道明细
      const hit = e.target.closest(".cr-nf-chs, .cr-nf-body");
      if (hit) hit.parentElement.classList.toggle("open");
    };
  }
  /* 通知条目 HTML（抽屉与大页详情共用；样式见 .cr-nf-*） */
  function cronNotifyItemsHtml(recs) {
    return recs.map(r => {
      const [evText, evCls] = CRON_NF_EVENT[r.event] || ["通知", ""];
      const chs = Object.keys(r.channels || {});
      const chips = chs.length
        ? chs.map(k => {
            const c = r.channels[k] || {};
            return '<span class="cr-nf-ch ' + (c.ok ? "ok" : "bad") + '" title="' +
              esc(c.detail || "") + '"><i class="bi ' + (c.ok ? "bi-check-circle" : "bi-x-circle") +
              '"></i>' + esc(CRON_NF_CH[k] || k) + '</span>';
          }).join("")
        : '<span class="cr-nf-ch skip"><i class="bi bi-slash-circle"></i>' +
            esc(CRON_NF_SKIP[r.skipped] || (r.skipped ? "未发送" : "没有启用的渠道")) + '</span>';
      const title = String(r.title || "").trim() || (r.skipped ? "未发送通知" : "（无标题）");
      const body = String(r.body || "").trim();
      // 这条通知整体成没成功（渠道都没启用时按「未发送」算）。
      // 逐个渠道分开显示、各自用自己的颜色：成功的绿、失败的红，一眼看出谁挂了。
      const okN = chs.filter(k => (r.channels[k] || {}).ok).length;
      const badN = chs.length - okN;
      let rCls = "skip", rIco = "bi-slash-circle", rHtml = "";
      if (!chs.length) {
        rHtml = '<span class="skip"><i class="bi bi-exclamation-triangle-fill"></i>未发送：' +
          esc(CRON_NF_SKIP[r.skipped] || (r.skipped ? "本次未推送" : "没有启用的渠道")) + '</span>';
      } else {
        rHtml = chs.map(k => {
          const c = r.channels[k] || {};
          // 成功 → 对勾；失败 → 叉（每个渠道各自一枚图标，颜色随成功 / 失败）
          return '<span class="' + (c.ok ? "ok" : "bad") + '">' +
            '<i class="bi ' + (c.ok ? "bi-check-circle-fill" : "bi-x-circle-fill") + '"></i>' +
            esc(CRON_NF_CH[k] || k) + (c.ok ? " 成功" : " 失败") + '</span>';
        }).join('<span class="cr-nf-sep">·</span>');
        if (!badN) { rCls = "ok"; rIco = "bi-check-circle"; }
        else if (!okN) { rCls = "bad"; rIco = "bi-x-circle"; rHtml += '<span class="cr-nf-hint">（点渠道看原因）</span>'; }
        else { rCls = "warn"; rIco = "bi-exclamation-triangle"; }
      }
      // 展开后逐渠道显示发送结果（成功是「已发送」，失败是接口返回的错误原因）
      const detail = chs.length
        ? '<div class="cr-nf-detail">' + chs.map(k => {
            const c = r.channels[k] || {};
            return '<div class="cr-nf-dl ' + (c.ok ? "ok" : "bad") + '">' +
              '<i class="bi ' + (c.ok ? "bi-check-circle" : "bi-x-circle") + '"></i>' +
              '<b>' + esc(CRON_NF_CH[k] || k) + '</b>' +
              '<span>' + esc(c.detail || (c.ok ? "已发送" : "发送失败")) + '</span></div>';
          }).join("") + '</div>'
        : "";
      return '<div class="cr-nf-item">' +
        '<div class="cr-nf-top">' +
          '<span class="cr-nf-ev ' + evCls + '">' + evText + '</span>' +
          '<span class="cr-nf-t" title="' + esc(title) + '">' + esc(title) + '</span>' +
          '<span class="cr-nf-time">' + cronFmtTime(r.ts) + '</span>' +
        '</div>' +
        '<div class="cr-nf-chs" title="点击展开 / 收起发送明细">' + chips + '</div>' +
        (body ? '<div class="cr-nf-body" title="点击展开 / 收起">' + esc(body) + '</div>' : "") +
        '<div class="cr-nf-result ' + rCls + '"><i class="bi ' + rIco + '"></i>' +
          '<span class="cr-nf-rlist">' + rHtml + '</span></div>' +
        detail +
      '</div>';
    }).join("");
  }

  function cronTick() {                             // 面板可见时刷新状态（运行中 2s，空闲 5s）
    clearTimeout(CRON.timer);
    if (!$("cronPanel") || !$("cronPanel").classList.contains("active")) return;
    const busy = (CRON.tasks || []).some(t => t.running);
    CRON.timer = setTimeout(async () => {
      // 出错也要续期：否则一次请求失败后侧栏就再也不刷新了
      try { await loadCron({ silent: true }); } catch (e) { console.warn("[cron] 侧栏刷新失败", e); }
      cronTick();
    }, busy ? 2000 : 5000);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("cronModal") && $("cronModal").style.display !== "none") cronCloseModal();
  });

  /* ==================================================================
     编辑区「定时任务管理」大页（标签页形式）
       · 顶部：统计概览 + 搜索 / 状态筛选 + 刷新 / 新建
       · 勾选若干行 → 批量启用 / 停用 / 运行 / 删除
       · 中部表格：名称 / 计划(含下次运行) / 状态 / 命令 / 上次运行 / 操作
       · 右侧详情：任务信息 + 执行记录 + 实时日志（点记录即看）
     数据全部走 /api/cron/*，与侧栏、悬浮框共用同一套状态。
     ================================================================== */
  const CRON_VIEW_PATH = "\u0000cron";
  CRON.view = { sel: {}, kw: "", filter: "all", cur: "", runs: [], logRun: null,
                logOffset: 0, log: "", logTimer: null, timer: null, dsig: "", batchN: 0,
                notify: null, nfOpen: true };

  function cronOpenView(tid) {
    let tab = findTab(CRON_VIEW_PATH);
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host cron-view-host";
      host.innerHTML = '<div class="cron-view" id="cronView"></div>';
      const dw = currentWrap();
      (dw || edGroups).appendChild(host);
      tab = {
        path: CRON_VIEW_PATH, host: host, cm: null, original: "", dirty: false,
        group: curGroup, name: "定时任务", displayPath: "定时任务", relPath: "",
        iconHtml: '<i class="bi bi-alarm" style="color:#e2c08a"></i>',
      };
      tab.onBeforeClose = () => {
        clearTimeout(CRON.view.timer); clearTimeout(CRON.view.logTimer);
        CRON.view.timer = CRON.view.logTimer = null;
        return true;
      };
      // 切回本标签时立刻同步一次（否则要等一个周期才看到最新状态）
      tab.onActivate = () => cronViewOnActivate();
      tabs.push(tab);
      renderTabsAll();
    }
    activate(tab);
    // catch 兜底：首次渲染若报错也要把轮询救起来，否则界面会一直停在打开时的状态
    cronViewRefresh(true).catch(e => console.warn("[cron] 首次加载失败", e)).then(() => {
      try { if (tid) cronViewSelect(tid); } catch (e) { console.warn("[cron] 选中任务失败", e); }
      cronViewTick();
    });
    return tab;
  }
  function cronViewActive() { return !!findTab(CRON_VIEW_PATH) && active && active.path === CRON_VIEW_PATH; }
  function cronViewOnActivate() {
    // 延到下一个事件循环：DOM 刚切过来，避免和 activate 内部的渲染抢执行
    setTimeout(() => {
      if (!cronViewActive()) return;
      cronViewFitCols();                            // 后台标签页创建时宽度是 0，切回来要重算列
      cronViewRefresh().catch(() => {});
      cronViewTick();
    }, 0);
  }
  /* 自动刷新：运行中 1.5s 一次，空闲 5s 一次；
     无论这一轮成功还是抛异常都必须续上，否则一次渲染报错就会让界面永久停在旧状态。 */
  function cronViewTick() {
    clearTimeout(CRON.view.timer);
    if (!cronViewActive()) return;
    const runs = CRON.view.runs || [];
    const busy = (CRON.tasks || []).some(t => t.running) || runs.some(x => x.status === "running");
    CRON.view.timer = setTimeout(async () => {
      try { await cronViewRefresh(); } catch (e) { console.warn("[cron] 自动刷新失败", e); }
      cronViewTick();
    }, busy ? 1500 : 5000);
  }

  /* ---------- 数据 ---------- */
  async function cronViewRefresh(force) {
    if (!findTab(CRON_VIEW_PATH)) return;
    try {
      const r = await fetch("/api/cron/tasks");
      const d = await r.json();
      CRON.tasks = d.tasks || [];
      cronUpdateBadge();
    } catch (_) { /* 保留旧数据，不打断界面 */ }
    // 选中任务若已被删除：清掉详情
    if (CRON.view.cur && !(CRON.tasks || []).some(t => t.id === CRON.view.cur)) {
      CRON.view.cur = ""; CRON.view.runs = []; CRON.view.logRun = null;
      CRON.view.log = ""; CRON.view.logOffset = 0;
      clearTimeout(CRON.view.logTimer);
    }
    // 详情里的执行记录也要同步（执行中 → 成功 / 失败，否则会一直亮着「执行中」）
    if (CRON.view.cur) await cronViewRunsQuiet();
    try {
      if (force || !$("cvTbody")) cronViewRender();
      else { cronViewPaintHead(); cronViewPaintRows(); }
      if ($("cvDetail")) cronViewPaintDetail();
      // 侧栏面板也停在同一页时才重建（避免无谓重绘）
      if ($("cronPanel") && $("cronPanel").classList.contains("active")) renderCronList();
    } catch (e) {
      console.warn("[cron] 刷新界面失败", e);      // 渲染异常不能中断轮询，见 cronViewTick
    }
  }
  /* 只更新执行记录数据，不重建详情（避免日志框被反复重置滚动位置） */
  async function cronViewRunsQuiet() {
    const tid = CRON.view.cur;
    if (!tid) return;
    try {
      const r = await fetch("/api/cron/runs?task_id=" + encodeURIComponent(tid) + "&limit=80");
      const d = await r.json();
      if (CRON.view.cur !== tid) return;           // 期间切了任务：丢弃
      CRON.view.runs = d.runs || [];
    } catch (_) { /* 网络抖动：保留旧数据 */ }
  }
  /* 详情区的内容指纹：任务状态 / 统计 / 执行记录状态，任一变化才重建 */
  function cronViewDetailSig() {
    const t = (CRON.tasks || []).find(x => x.id === CRON.view.cur);
    if (!t) return CRON.view.cur ? "missing:" + CRON.view.cur : "";
    const runs = CRON.view.runs || [];
    return [t.id, t.running ? 1 : 0, t.last_status || "", t.run_count || 0,
            t.ok_count || 0, t.fail_count || 0, (CRON.view.logRun || {}).id || "",
            runs.map(x => x.id + ":" + x.status + ":" + (x.duration || 0)).join("|")].join("~");
  }
  function cronViewPaintDetail(force) {
    const sig = cronViewDetailSig();
    if (!force && sig === CRON.view.dsig) return;
    CRON.view.dsig = sig;
    cronViewRenderDetail();
  }
  function cronViewStats() {
    const list = CRON.tasks || [];
    return {
      total: list.length,
      enabled: list.filter(t => t.enabled).length,
      running: list.filter(t => t.running).length,
      ok: list.reduce((a, t) => a + (t.ok_count || 0), 0),
      fail: list.reduce((a, t) => a + (t.fail_count || 0), 0),
    };
  }
  function cronViewFiltered() {
    const kw = (CRON.view.kw || "").trim().toLowerCase();
    const f = CRON.view.filter;
    return (CRON.tasks || []).filter(t => {
      if (f === "enabled" && !t.enabled) return false;
      if (f === "disabled" && t.enabled) return false;
      if (f === "running" && !t.running) return false;
      if (!kw) return true;
      return [t.name, t.command, t.cron, t.remark].some(v => String(v || "").toLowerCase().indexOf(kw) >= 0);
    });
  }

  /* ---------- 渲染 ---------- */
  function cronViewStatsHtml() {
    const s = cronViewStats();
    return '<span class="cv-stat"><b>' + s.total + '</b> 总任务</span>' +
      '<span class="cv-stat ok"><b>' + s.enabled + '</b> 已启用</span>' +
      '<span class="cv-stat run"><b>' + s.running + '</b> 运行中</span>' +
      '<span class="cv-stat ok"><b>' + s.ok + '</b> 成功</span>' +
      '<span class="cv-stat bad"><b>' + s.fail + '</b> 失败</span>';
  }
  function cronViewBatchHtml() {
    const n = Object.keys(CRON.view.sel).length;
    if (!n) return "";
    return '<div class="cv-batch" id="cvBatch">已选 <b>' + n + '</b> 项：' +
      '<button class="cv-btn" data-batch="enable"><i class="bi bi-toggle-on"></i> 启用</button>' +
      '<button class="cv-btn" data-batch="disable"><i class="bi bi-toggle-off"></i> 停用</button>' +
      '<button class="cv-btn" data-batch="run"><i class="bi bi-play-fill"></i> 立即运行</button>' +
      '<button class="cv-btn danger" data-batch="delete"><i class="bi bi-trash"></i> 删除</button>' +
      '<button class="cv-btn" data-batch="none">取消选择</button></div>';
  }
  function cronViewPaintHead() {
    const st = $("cvStats");
    if (st) {
      const html = cronViewStatsHtml();
      if (st.innerHTML !== html) st.innerHTML = html;   // 统计没变就不动，避免每次刷新都闪一下
    }
    const n = Object.keys(CRON.view.sel).length;
    const old = $("cvBatch");
    if (!n) {
      if (old) old.remove();
      CRON.view.batchN = 0;
      return;
    }
    // 勾选数量没变就不重建批量栏（重建会让整行布局抖一下）
    if (old && CRON.view.batchN === n) return;
    if (old) old.remove();
    const head = $("cvHead");
    if (head) head.insertAdjacentHTML("beforeend", cronViewBatchHtml());
    CRON.view.batchN = n;
    cronViewBindBatch();
  }
  /* 一行内容的签名：只有这些字段真的变了才替换这一行（运行中每 1.5s 刷新也不会整表重绘） */
  function cronViewRowSig(t) {
    return JSON.stringify([t.id, t.running ? 1 : 0, t.enabled ? 1 : 0, t.last_status || "",
                           t.last_at || 0, t.last_ms || 0, t.run_count || 0,
                           (t.next && t.next[0]) || "", CRON.view.cur === t.id ? 1 : 0,
                           t.name || "", t.remark || "", t.cron || "", t.command || ""]);
  }
  function cronViewPaintRows() {
    const tb = $("cvTbody");
    if (!tb) return;
    const list = cronViewFiltered();
    if (!list.length) {
      const html = '<tr><td colspan="7" class="cv-empty">没有匹配的任务。可点右上角「新建任务」，' +
        '或在资源管理器里右键文件 →「添加定时任务…」。</td></tr>';
      if (tb.innerHTML !== html) tb.innerHTML = html;
      const all0 = $("cvAll");
      if (all0) all0.checked = false;
      return;
    }
    const rows = tb.querySelectorAll("tr[data-tid]");
    let sameShape = rows.length === list.length;
    if (sameShape) {
      for (let i = 0; i < list.length; i++) {
        if (rows[i].dataset.tid !== list[i].id) { sameShape = false; break; }
      }
    }
    if (!sameShape) {                                  // 行数 / 顺序变了：整表重建
      tb.innerHTML = list.map(cronViewRowHtml).join("");
      const fresh = tb.querySelectorAll("tr[data-tid]");
      list.forEach((t, i) => { if (fresh[i]) fresh[i].dataset.sig = cronViewRowSig(t); });
      const all1 = $("cvAll");
      if (all1) all1.checked = list.length > 0 && list.every(t => CRON.view.sel[t.id]);
      cronViewBindRows();
      return;
    }
    let changed = false;
    list.forEach((t, i) => {
      const tr = rows[i];
      const sig = cronViewRowSig(t);
      if (tr.dataset.sig === sig) return;              // 这一行没变化：原样保留
      const tmp = document.createElement("tbody");
      tmp.innerHTML = cronViewRowHtml(t);
      const fresh = tmp.firstElementChild;
      if (!fresh) return;
      fresh.dataset.sig = sig;
      tr.replaceWith(fresh);
      changed = true;
    });
    if (changed) cronViewBindRows();
    const all2 = $("cvAll");
    if (all2) all2.checked = list.length > 0 && list.every(t => CRON.view.sel[t.id]);
  }
  function cronViewRender() {
    const box = $("cronView");
    if (!box) return;
    box.innerHTML =
      '<div class="cv-head" id="cvHead">' +
        '<div class="cv-title"><i class="bi bi-alarm"></i><span>定时任务</span>' +
          '<span class="cv-stats" id="cvStats">' + cronViewStatsHtml() + '</span></div>' +
        '<div class="cv-tools">' +
          '<input class="cv-search" id="cvSearch" placeholder="搜索名称 / 命令 / cron / 备注…" spellcheck="false" autocomplete="off" value="' + escAttr(CRON.view.kw) + '">' +
          '<select class="cv-filter" id="cvFilter">' +
            [["all", "全部"], ["enabled", "已启用"], ["disabled", "已停用"], ["running", "运行中"]]
              .map(x => '<option value="' + x[0] + '"' + (CRON.view.filter === x[0] ? " selected" : "") + '>' + x[1] + '</option>').join("") +
          '</select>' +
          '<button class="cv-btn" id="cvRefresh" title="刷新"><i class="bi bi-arrow-clockwise"></i></button>' +
          '<button class="cv-btn primary" id="cvNew" title="新建定时任务"><i class="bi bi-plus-lg"></i> 新建任务</button>' +
        '</div>' +
        cronViewBatchHtml() +
      '</div>' +
      '<div class="cv-body">' +
        '<div class="cv-table-wrap scroll-thin"><table class="cv-table"><thead><tr>' +
          '<th class="cv-c"><input type="checkbox" id="cvAll" title="全选"></th>' +
          '<th>名称</th><th>计划</th><th>状态</th><th>命令</th><th>上次运行</th><th class="cv-a">操作</th>' +
        '</tr></thead><tbody id="cvTbody"></tbody></table></div>' +
        '<div class="cv-detail" id="cvDetail"></div>' +
      '</div>';
    cronViewBindHead();
    cronViewPaintRows();
    cronViewRenderDetail();
    cronViewWatchSize();
  }
  /* 表格宽度自适应：右侧详情展开后主区会变窄（约 700px），固定列宽会把「计划」挤没，
     所以窄的时候把「命令」列折进名称下方，把宽度让给名称 / 计划；再窄就把「上次运行」也收起。 */
  var cronViewRO = null;
  function cronViewFitCols() {
    const view = $("cronView");
    const wrap = document.querySelector("#cronView .cv-table-wrap");
    if (!view || !wrap) return;
    const w = wrap.clientWidth || 0;
    view.classList.toggle("cv-narrow", w > 0 && w < 900);
    view.classList.toggle("cv-tiny", w > 0 && w < 640);
  }
  function cronViewWatchSize() {
    cronViewFitCols();
    const wrap = document.querySelector("#cronView .cv-table-wrap");
    if (!wrap || typeof ResizeObserver === "undefined") return;
    if (!cronViewRO) cronViewRO = new ResizeObserver(cronViewFitCols);
    cronViewRO.disconnect();                        // 整页重建过：旧节点已经不在文档里
    cronViewRO.observe(wrap);
  }
  function cronViewRowHtml(t) {
    const stKey = t.running ? "running" : (t.last_status || "");
    const si = stKey ? cronStatusInfo(stKey) : ["未运行", ""];
    const on = CRON.view.cur === t.id ? " on" : "";
    const off = t.enabled ? "" : " off";
    const sel = CRON.view.sel[t.id] ? " checked" : "";
    return '<tr class="cv-row' + on + off + '" data-tid="' + t.id + '">' +
      '<td class="cv-c"><input type="checkbox" data-sel="' + t.id + '"' + sel + '></td>' +
      '<td class="cv-name"><div class="cv-name-t" title="' + escAttr(t.name) + '">' + esc(t.name) + '</div>' +
        (t.remark ? '<div class="cv-sub" title="' + escAttr(t.remark) + '">' + esc(t.remark) + '</div>' : "") +
        /* 窄屏下命令列会被折叠，这里留一份，避免看不到执行命令 */
        '<div class="cv-sub cv-name-cmd" title="' + escAttr(t.command) + '">' + esc(t.command) + '</div></td>' +
      '<td class="cv-plan"><code>' + esc(t.cron) + '</code>' +
        (t.next && t.next.length
          ? '<div class="cv-next" title="接下来的运行时间：' + escAttr(t.next.join(" · ")) + '">下次 ' +
            esc(t.next[0]) + '</div>'
          : "") + '</td>' +
      '<td><span class="ci-st ' + si[1] + '">' + esc(si[0]) + '</span>' +
        '<div class="cv-tgl">' +
          '<button class="cv-tgl-btn ' + (t.enabled ? "off" : "on") + '" data-act="toggle" title="' +
            (t.enabled ? "停止：不再按 cron 计划自动触发（不影响手动运行）"
                       : "启动：按 cron 计划自动触发") + '">' +
            '<i class="bi ' + (t.enabled ? "bi-pause-circle" : "bi-play-circle") + '"></i>' +
            (t.enabled ? "停止" : "启动") + '</button>' +
        '</div></td>' +
      '<td class="cv-cmd" title="' + escAttr(t.command) + '"><span class="cv-cmd-t">' + esc(t.command) + '</span></td>' +
      /* 列宽有限：列表里只到分钟，完整到秒的时间放 title */
      '<td class="cv-last" title="' + (t.last_at ? escAttr(cronFmtTime(t.last_at)) : "从未运行") + '">' + (t.last_at
        ? esc(cronFmtTime(t.last_at).slice(0, 11)) + '<div class="cv-sub">' + cronFmtDur(t.last_ms) + ' · 共 ' + (t.run_count || 0) + ' 次</div>'
        : '<span class="cv-sub">从未运行</span>') + '</td>' +
      '<td class="cv-a">' +
        (t.running
          ? '<button class="cv-ico v-stop" data-act="stop" title="停止本次执行"><i class="bi bi-stop-fill"></i></button>'
          : '<button class="cv-ico v-run" data-act="run" title="立即运行一次"><i class="bi bi-play-fill"></i></button>') +
        '<button class="cv-ico v-edit" data-act="edit" title="编辑"><i class="bi bi-pencil-square"></i></button>' +
        '<button class="cv-ico v-copy" data-act="copy" title="复制一份（默认停用）"><i class="bi bi-copy"></i></button>' +
        '<button class="cv-ico v-del" data-act="del" title="删除"><i class="bi bi-trash"></i></button>' +
      '</td></tr>';
  }
  function cronViewKV(k, v, mono) {
    return '<div class="cv-kv"><span class="cv-k">' + esc(k) + '</span>' +
      '<span class="cv-v' + (mono ? " mono" : "") + '">' +
      esc(String(v == null || v === "" ? "—" : v)) + '</span></div>';
  }
  function cronViewRenderDetail() {
    const box = $("cvDetail");
    if (!box) return;
    const t = (CRON.tasks || []).find(x => x.id === CRON.view.cur);
    if (!t) {
      CRON.view.dsig = cronViewDetailSig();
      box.innerHTML = '<div class="cv-d-empty"><i class="bi bi-list-ul"></i>' +
        '<div>点击左侧任意一行，查看任务详情、执行记录与日志</div></div>';
      return;
    }
    const si = cronStatusInfo(t.running ? "running" : (t.last_status || ""));
    const runs = CRON.view.runs || [];
    box.innerHTML =
      '<div class="cv-d-head">' +
        '<div class="cv-d-title" title="' + escAttr(t.name) + '">' + esc(t.name) + '</div>' +
        '<span class="ci-st ' + si[1] + '">' + esc(si[0]) + '</span>' +
        '<span class="cv-sp"></span>' +
        (t.running
          ? '<button class="cv-btn danger" data-dact="stop"><i class="bi bi-stop-fill"></i> 停止</button>'
          : '<button class="cv-btn primary" data-dact="run"><i class="bi bi-play-fill"></i> 运行</button>') +
        '<button class="cv-btn" data-dact="edit"><i class="bi bi-pencil-square"></i> 编辑</button>' +
        '<button class="cv-btn" data-dact="runs" title="刷新执行记录"><i class="bi bi-arrow-clockwise"></i></button>' +
      '</div>' +
      '<div class="cv-d-info">' +
        cronViewKV("cron 表达式", t.cron) +
        cronViewKV("下次运行", (t.next && t.next.length) ? t.next.join("   ·   ") : "") +
        cronViewKV("执行命令", t.command, true) +
        cronViewKV("工作目录", t.cwd || "（默认：任务所在项目目录）", true) +
        cronViewKV("超时", t.timeout ? (t.timeout + " 秒") : "不限时") +
        cronViewKV("运行统计", "共 " + (t.run_count || 0) + " 次 · 成功 " + (t.ok_count || 0) + " · 失败 " + (t.fail_count || 0)) +
        (t.notify_channels
          ? cronViewKV("通知渠道", String(t.notify_channels).split(",").map(cronTaskChannelName).join(" / "))
          : "") +
        (t.remark ? cronViewKV("备注", t.remark) : "") +
      '</div>' +
      '<div class="cv-d-sub">执行记录 <span class="cv-sub">（' + runs.length + ' 条，点一行看日志）</span>' +
        '<span class="cv-sp"></span>' +
        '<button class="cv-btn" data-dact="clearruns" title="清空非运行中的历史记录">清空记录</button></div>' +
      '<div class="cv-run-list scroll-thin" id="cvRunList">' + (runs.length ? runs.map(x => {
        const xi = cronStatusInfo(x.status);
        const on = (CRON.view.logRun && CRON.view.logRun.id === x.id) ? " on" : "";
        return '<div class="cv-run-row' + on + '" data-rid="' + x.id + '">' +
          '<span class="cr-dot ' + xi[1] + '"></span>' +
          '<span class="cv-run-t">' + esc(cronFmtTime(x.started_at)) + '</span>' +
          '<span class="cv-sub cv-trigger" title="' + (x.trigger === "manual" ? "手动触发" : "定时触发") + '">' +
            '<i class="bi ' + (x.trigger === "manual" ? "bi-hand-index" : "bi-clock") + '"></i>' +
            (x.trigger === "manual" ? "手动" : "定时") + '</span>' +
          '<span class="cv-sp"></span>' +
          '<span class="cv-run-s">' + esc(xi[0]) +
            (x.status !== "running" ? " · " + cronFmtDur(x.duration) : "") + '</span></div>';
      }).join("") : '<div class="cv-d-empty-line">还没有执行记录</div>') + '</div>' +
      '<div class="cv-d-sub">日志' +
        (CRON.view.logRun ? ' <span class="cv-sub">' + esc(cronFmtTime(CRON.view.logRun.started_at)) + '</span>' : "") +
        '<span class="cv-sp"></span>' +
        '<button class="cv-btn" data-dact="logrefresh" title="重新加载日志"><i class="bi bi-arrow-clockwise"></i></button></div>' +
      '<pre class="cv-log scroll-thin" id="cvLog">' + esc(CRON.view.log || "") + '</pre>' +
      '<div class="cv-d-sub">通知记录' + cronViewNotifySumHtml() +
        '<span class="cv-sp"></span>' +
        '<button class="cv-btn" data-dact="notifyrefresh" title="刷新通知记录"><i class="bi bi-bell"></i></button>' +
        '<button class="cv-btn" data-dact="notifytoggle" title="折叠 / 展开通知记录"><i class="bi ' +
          (CRON.view.nfOpen === false ? "bi-chevron-right" : "bi-chevron-down") + '"></i></button></div>' +
      '<div class="cv-notify scroll-thin" id="cvNotify"' +
        (CRON.view.nfOpen === false ? ' style="display:none"' : "") + '>' +
        cronViewNotifyHtml() + '</div>';
    const pre = $("cvLog");
    if (pre) pre.scrollTop = pre.scrollHeight;
    cronViewBindDetail();
    CRON.view.dsig = cronViewDetailSig();           // 记下这一帧，避免轮询重复重建
  }

  /* ---------- 事件绑定 ---------- */
  function cronViewBindHead() {
    const se = $("cvSearch");
    if (se) se.oninput = () => { CRON.view.kw = se.value; cronViewPaintRows(); };
    const fl = $("cvFilter");
    if (fl) fl.onchange = () => { CRON.view.filter = fl.value; cronViewPaintRows(); };
    const rf = $("cvRefresh");
    if (rf) rf.onclick = () => cronViewRefresh(true);
    const nw = $("cvNew");
    if (nw) nw.onclick = () => cronOpenEditor(null);
    const all = $("cvAll");
    if (all) {
      all.onchange = () => {
        const list = cronViewFiltered();
        CRON.view.sel = {};
        if (all.checked) list.forEach(t => { CRON.view.sel[t.id] = 1; });
        cronViewPaintRows(); cronViewPaintHead();
      };
    }
    cronViewBindBatch();
  }
  function cronViewBindBatch() {
    const b = $("cvBatch");
    if (!b) return;
    b.querySelectorAll("[data-batch]").forEach(btn => { btn.onclick = () => cronViewBatch(btn.dataset.batch); });
  }
  function cronViewBindRows() {
    document.querySelectorAll("#cvTbody .cv-row").forEach(row => {
      const tid = row.dataset.tid;
      row.onclick = (e) => {
        if (e.target.closest("button") || e.target.closest("input")) return;
        cronViewSelect(tid);
      };
      const act = (name, fn) => {
        const el = row.querySelector('[data-act="' + name + '"]');
        if (el) el.onclick = (ev) => { ev.stopPropagation(); fn(); };
      };
      const task = () => (CRON.tasks || []).find(x => x.id === tid);
      act("run", () => cronViewRun(tid));
      act("stop", () => cronViewStop(tid));
      act("toggle", () => cronViewToggle(tid));
      act("edit", () => cronOpenEditor(task()));
      act("copy", () => cronViewCopy(task()));
      act("del", () => cronViewDelete(task()));
      const cb = row.querySelector("[data-sel]");
      if (cb) cb.onchange = () => {
        if (cb.checked) CRON.view.sel[tid] = 1; else delete CRON.view.sel[tid];
        cronViewPaintHead();
      };
    });
  }
  function cronViewBindDetail() {
    document.querySelectorAll("#cvDetail [data-dact]").forEach(btn => {
      btn.onclick = () => cronViewDetailAct(btn.dataset.dact);
    });
    const nfBox = $("cvNotify");
    if (nfBox) {
      nfBox.onclick = (e) => {                     // 点渠道 / 正文展开：看完整文案与各渠道明细
        const hit = e.target.closest(".cr-nf-chs, .cr-nf-body");
        if (hit) hit.parentElement.classList.toggle("open");
      };
    }
    const box = $("cvRunList");
    if (!box) return;
    box.querySelectorAll(".cv-run-row").forEach(row => {
      row.onclick = () => {
        const run = (CRON.view.runs || []).find(x => x.id === row.dataset.rid);
        if (!run) return;
        box.querySelectorAll(".cv-run-row").forEach(e => e.classList.toggle("on", e === row));
        cronViewLoadLog(run, true);
      };
    });
  }

  /* ---------- 操作 ---------- */
  function cronViewSelect(tid) {
    const same = CRON.view.cur === tid;
    CRON.view.cur = tid;
    if (!same) {                                 // 换任务才清空记录与日志；同一任务刷新时保留，避免闪空
      CRON.view.runs = []; CRON.view.logRun = null;
      CRON.view.log = ""; CRON.view.logOffset = 0;
      CRON.view.notify = null;
      CRON.view.dsig = "";
      clearTimeout(CRON.view.logTimer);
    }
    cronViewPaintRows();
    cronViewRenderDetail();
    cronViewLoadRuns(tid);
  }
  async function cronViewLoadRuns(tid) {
    if (!findTab(CRON_VIEW_PATH)) return;
    try {
      const r = await fetch("/api/cron/runs?task_id=" + encodeURIComponent(tid) + "&limit=80");
      const d = await r.json();
      if (CRON.view.cur !== tid) return;
      CRON.view.runs = d.runs || [];
    } catch (_) { CRON.view.runs = []; }
    cronViewRenderDetail();
    const first = (CRON.view.runs || [])[0];
    if (first) cronViewLoadLog(first, true);
  }
  function cronViewLoadLog(run, force) {
    if (!run) return;
    CRON.view.logRun = run;
    if (force) { CRON.view.log = ""; CRON.view.logOffset = 0; }
    clearTimeout(CRON.view.logTimer);
    const pre = $("cvLog");
    if (pre) pre.textContent = CRON.view.log;
    const pull = () => {
      if (!findTab(CRON_VIEW_PATH)) return;
      fetch("/api/cron/log?run_id=" + encodeURIComponent(run.id) + "&offset=" + CRON.view.logOffset)
        .then(r => r.json()).then(d => {
          if (d.error) { CRON.view.log += "\n[读取失败] " + d.error; }
          else if (d.text) { CRON.view.logOffset = d.offset; CRON.view.log += d.text; }
          const el = $("cvLog");
          if (el && (d.text || d.error)) {
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            const keep = el.scrollTop;
            el.textContent = CRON.view.log;
            el.scrollTop = nearBottom ? el.scrollHeight : keep;
          }
          if (d.running) CRON.view.logTimer = setTimeout(pull, 1000);
          else {
            // 这一轮结束了：立刻同步一次任务 / 执行记录状态，别等下一个轮询周期
            cronViewRefresh().catch(() => {});
            // 通知是在执行结束后才发的：稍等一下再拉一次
            setTimeout(() => {
              if (CRON.view.logRun && CRON.view.logRun.id === run.id) cronViewLoadNotify(run, true);
            }, 1200);
          }
        }).catch(() => { CRON.view.logTimer = setTimeout(pull, 1500); });
    };
    pull();
    cronViewLoadNotify(run);
  }
  /* ---------- 大页详情里的「通知记录」 ---------- */
  function cronViewNotifySumHtml() {
    const nf = CRON.view.notify, rid = (CRON.view.logRun || {}).id || "";
    if (!nf || nf.rid !== rid || !nf.recs) return "";
    return ' <span class="cv-sub">（' + nf.recs.length + ' 条）</span>';
  }
  function cronViewNotifyHtml() {
    const rid = (CRON.view.logRun || {}).id || "";
    if (!rid) return '<div class="cr-nf-empty">选择一条执行记录</div>';
    const nf = CRON.view.notify;
    if (!nf || nf.rid !== rid || !nf.recs) return '<div class="cr-nf-empty">加载中…</div>';
    if (!nf.recs.length) {
      return '<div class="cr-nf-empty">本次执行没有通知记录' +
        '<div>可能是该事件没勾选 / 通知总开关关闭，或这条执行早于功能更新。</div></div>';
    }
    return cronNotifyItemsHtml(nf.recs);
  }
  function cronViewPaintNotify() {
    const box = $("cvNotify");
    if (box) box.innerHTML = cronViewNotifyHtml();
    const sum = $("cvNotifySum");
    if (sum) sum.innerHTML = cronViewNotifySumHtml();
  }
  function cronViewLoadNotify(run, force) {
    if (!run) return;
    const rid = run.id;
    const cur = CRON.view.notify;
    if (!force && cur && cur.rid === rid && cur.recs) { cronViewPaintNotify(); return; }
    if (!cur || cur.rid !== rid) {                 // 换记录才显示「加载中」，同一条刷新保留旧内容
      CRON.view.notify = { rid: rid, recs: null };
      cronViewPaintNotify();
    }
    fetch("/api/cron/notify-log?run_id=" + encodeURIComponent(rid))
      .then(r => r.json()).then(d => {
        const nf = CRON.view.notify;
        if (!nf || nf.rid !== rid) return;
        const recs = (d && d.records) || [];
        if (nf.recs && JSON.stringify(nf.recs) === JSON.stringify(recs)) return;   // 没变化不重绘
        nf.recs = recs;
        cronViewPaintNotify();
      }).catch(() => {
        const nf = CRON.view.notify;
        if (!nf || nf.rid !== rid || nf.recs) return;
        nf.recs = [];
        cronViewPaintNotify();
      });
  }
  async function cronViewToggle(tid) {             // 状态列的快捷按钮：启动 / 停止定时调度
    const t = (CRON.tasks || []).find(x => x.id === tid);
    if (!t) return;
    const d = await cronAct("/api/cron/toggle", { id: tid, enabled: !t.enabled });
    if (d.error) { toast(d.error, "err"); return; }
    toast((t.enabled ? "已停止定时调度：" : "已启动定时调度：") + t.name, "ok");
    await cronViewRefresh();
  }
  async function cronViewRun(tid) {
    const t = (CRON.tasks || []).find(x => x.id === tid);
    const d = await cronAct("/api/cron/run", { id: tid });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已开始执行：" + ((t && t.name) || tid), "ok");
    // 局部刷新：整页重建会让搜索框失焦、滚动位置跳动；同一任务只需重拉执行记录
    await cronViewRefresh();
    if (CRON.view.cur === tid) cronViewLoadRuns(tid);
    else cronViewSelect(tid);
  }
  async function cronViewStop(tid) {
    const d = await cronAct("/api/cron/stop", { id: tid });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已停止", "warn");
    await cronViewRefresh();
    if (CRON.view.cur === tid) cronViewLoadRuns(tid);
  }
  async function cronViewCopy(t) {
    if (!t) return;
    const d = await cronAct("/api/cron/save", {
      name: t.name + " 副本", cron: t.cron, command: t.command, cwd: t.cwd || "",
      remark: t.remark || "", timeout: t.timeout || 0, enabled: false,
    });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已复制为「" + d.task.name + "」（默认停用，改好再启用）", "ok");
    cronViewRefresh();
  }
  async function cronViewDelete(t) {
    if (!t) return;
    const ok = await uiConfirm("删除定时任务",
      "确定删除「" + t.name + "」吗？它的执行记录与日志文件会一起清掉，此操作不可撤销。", "删除", true);
    if (!ok) return;
    const d = await cronAct("/api/cron/delete", { id: t.id });
    if (d.error) { toast(d.error, "err"); return; }
    delete CRON.view.sel[t.id];
    if (CRON.view.cur === t.id) { CRON.view.cur = ""; CRON.view.runs = []; CRON.view.logRun = null; CRON.view.log = ""; }
    toast("已删除：" + t.name, "ok");
    cronViewRefresh();
  }
  async function cronViewBatch(action) {
    const ids = Object.keys(CRON.view.sel);
    if (action === "none") { CRON.view.sel = {}; cronViewPaintRows(); cronViewPaintHead(); return; }
    if (!ids.length) return;
    const tasks = ids.map(id => (CRON.tasks || []).find(x => x.id === id)).filter(Boolean);
    if (action === "delete") {
      const ok = await uiConfirm("批量删除", "确定删除选中的 " + tasks.length + " 个定时任务吗？执行记录与日志会一起清掉。", "删除", true);
      if (!ok) return;
    }
    if (action === "run") {
      const ok = await uiConfirm("批量运行", "立即运行选中的 " + tasks.length + " 个任务？", "运行", false);
      if (!ok) return;
    }
    let okN = 0, failN = 0;
    for (const t of tasks) {
      let d = null;
      if (action === "enable") d = await cronAct("/api/cron/toggle", { id: t.id, enabled: true });
      else if (action === "disable") d = await cronAct("/api/cron/toggle", { id: t.id, enabled: false });
      else if (action === "run") d = await cronAct("/api/cron/run", { id: t.id });
      else if (action === "delete") d = await cronAct("/api/cron/delete", { id: t.id });
      else break;
      if (d && d.error) failN++; else okN++;
    }
    if (action === "delete") CRON.view.sel = {};
    const label = { enable: "启用", disable: "停用", run: "运行", delete: "删除" }[action] || action;
    toast("批量" + label + "完成：" + okN + " 个成功" + (failN ? "，" + failN + " 个失败" : ""), failN ? "warn" : "ok");
    await cronViewRefresh();
    if (action === "run" && CRON.view.cur) cronViewSelect(CRON.view.cur);
  }
  async function cronViewDetailAct(act) {
    const t = (CRON.tasks || []).find(x => x.id === CRON.view.cur);
    if (!t) return;
    if (act === "run") return cronViewRun(t.id);
    if (act === "stop") return cronViewStop(t.id);
    if (act === "edit") return cronOpenEditor(t);
    if (act === "runs") return cronViewLoadRuns(t.id);
    if (act === "logrefresh") return cronViewLoadLog(CRON.view.logRun, true);
    if (act === "notifyrefresh") return cronViewLoadNotify(CRON.view.logRun, true);
    if (act === "notifytoggle") {                   // 折叠 / 展开通知记录（状态在重建详情后保留）
      CRON.view.nfOpen = CRON.view.nfOpen === false;
      const box = $("cvNotify");
      if (box) box.style.display = CRON.view.nfOpen ? "" : "none";
      const ico = document.querySelector('#cvDetail [data-dact="notifytoggle"] i');
      if (ico) ico.className = "bi " + (CRON.view.nfOpen ? "bi-chevron-down" : "bi-chevron-right");
      return;
    }
    if (act === "clearruns") {
      const ok = await uiConfirm("清空执行记录", "确定清空「" + t.name + "」的历史执行记录与日志吗？（正在运行的会保留）", "清空", true);
      if (!ok) return;
      const d = await cronAct("/api/cron/clear-runs", { id: t.id });
      if (d.error) { toast(d.error, "err"); return; }
      toast("已清空 " + (d.removed || 0) + " 条记录", "ok");
      CRON.view.logRun = null; CRON.view.log = ""; CRON.view.logOffset = 0;
      cronViewLoadRuns(t.id);
    }
  }

  /* ==================================================================
     设置弹窗（日志自动清理 + 通知渠道）与备份 / 恢复
     ================================================================== */
  const CRON_CH_NAMES = {
    desktop: "桌面通知", email: "邮件（全局 SMTP）", dingtalk: "钉钉机器人",
    telegram: "Telegram（全局）", pushplus: "PushPlus",
  };
  const CRON_EV_NAMES = { fail: "执行失败", timeout: "执行超时", retry: "安排重试" };

  function cronOpenSettings() {
    const ov = cronEnsureModal();
    CRON.logRun = null;                            // 设置弹窗不涉及日志
    ov.innerHTML =
      '<div class="cron-dialog cd-settings">' +
        '<div class="cd-head"><i class="bi bi-gear"></i><span>定时任务设置</span>' +
          '<button class="cd-x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
        '<div class="cd-body" id="cronSetBody"><div class="ph">加载中…</div></div>' +
        '<div class="cd-foot">' +
          '<span class="cd-spacer"></span>' +
          '<button class="cd-btn" id="cronSetCancel">取消</button>' +
          '<button class="cd-btn primary" id="cronSetSave">保存</button>' +
        '</div>' +
      '</div>';
    ov.style.display = "flex";
    ov.querySelector(".cd-x").onclick = cronCloseModal;
    $("cronSetCancel").onclick = cronCloseModal;
    $("cronSetSave").onclick = cronSaveSettings;
    fetch("/api/cron/settings").then(r => r.json()).then(d => {
      if (d.error) { $("cronSetBody").innerHTML = '<div class="ph">' + esc(d.error) + '</div>'; return; }
      cronRenderSettings(d);
    }).catch(() => {
      $("cronSetBody").innerHTML = '<div class="ph">读取设置失败</div>';
    });
  }

  function cronRenderSettings(d) {
    const n = d.notify || {};
    const events = n.events || {}, chs = n.channels || {};
    const ding = n.dingtalk || {}, pp = n.pushplus || {};
    const chRow = (key) =>
      '<div class="cs-ch">' +
        '<label class="cd-check"><input type="checkbox" data-ch="' + key + '"' + (chs[key] ? " checked" : "") +
          '> ' + esc(CRON_CH_NAMES[key]) + '</label>' +
        '<button class="cd-btn cs-test" data-test="' + key + '" title="向该渠道发一条测试通知">测试</button>' +
      '</div>';
    $("cronSetBody").innerHTML =
      '<div class="cs-sec">日志自动清理</div>' +
      '<div class="cd-row2">' +
        '<div class="cd-row cd-row-sm"><label>保留天数（0 = 永久保留）</label>' +
          '<input id="csLogDays" type="number" min="0" step="1" value="' + escAttr(d.log_days || 0) + '"></div>' +
        '<div class="cd-row cd-row-sm"><label>每任务保留执行记录（条）</label>' +
          '<input id="csKeepRuns" type="number" min="1" step="1" value="' + escAttr(d.keep_runs || 50) + '"></div>' +
      '</div>' +
      '<div class="cs-sec">通知推送</div>' +
      '<label class="cd-check"><input type="checkbox" id="csNotifyOn"' + (n.enabled ? " checked" : "") +
        '> 启用通知（任务失败 / 超时时按下面的事件与渠道推送）</label>' +
      '<div class="cs-row-lbl">触发事件</div>' +
      '<div class="cs-ev">' + Object.keys(CRON_EV_NAMES).map(k =>
        '<label class="cd-check"><input type="checkbox" data-ev="' + k + '"' + (events[k] ? " checked" : "") +
          '> ' + esc(CRON_EV_NAMES[k]) + '</label>').join("") + '</div>' +
      '<div class="cs-row-lbl">推送渠道（邮件 / Telegram 用「设置 → 通知」里的全局配置）</div>' +
      '<div class="cs-chs">' + Object.keys(CRON_CH_NAMES).map(chRow).join("") + '</div>' +
      '<div class="cd-row"><label>钉钉机器人 Webhook（含 access_token）</label>' +
        '<input id="csDingWebhook" spellcheck="false" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" value="' +
          escAttr(ding.webhook || "") + '"></div>' +
      '<div class="cd-row"><label>钉钉加签密钥（SEC 开头，留空 = 不加签）</label>' +
        '<input id="csDingSecret" spellcheck="false" placeholder="SEC…" value="' + escAttr(ding.secret || "") + '"></div>' +
      '<div class="cd-row"><label>PushPlus Token（www.pushplus.plus 获取）</label>' +
        '<input id="csPpToken" spellcheck="false" placeholder="推送 token" value="' + escAttr(pp.token || "") + '"></div>' +
      '<div class="cd-row"><label>PushPlus 群组编码（可选，留空发给自己）</label>' +
        '<input id="csPpTopic" spellcheck="false" value="' + escAttr(pp.topic || "") + '"></div>' +
      '<div class="cd-err" id="cronSetErr"></div>';
    ov.querySelectorAll("[data-test]").forEach(b => {
      b.onclick = async () => {
        b.disabled = true; b.textContent = "发送中…";
        await cronSaveSettings(true);                 // 先保存，测试用的才是刚填的配置
        const d2 = await cronAct("/api/cron/notify-test", { channel: b.dataset.test });
        b.disabled = false; b.textContent = "测试";
        const r = d2.results || {};
        const key = b.dataset.test;
        if (r[key] && r[key].ok) toast(CRON_CH_NAMES[key] + "：发送成功", "ok");
        else toast(CRON_CH_NAMES[key] + "：发送失败 " + ((r[key] && r[key].detail) || ""), "err");
      };
    });
  }

  async function cronSaveSettings(silent) {
    const err = $("cronSetErr");
    const ev = {}, ch = {};
    document.querySelectorAll("#cronModal [data-ev]").forEach(x => { ev[x.dataset.ev] = x.checked; });
    document.querySelectorAll("#cronModal [data-ch]").forEach(x => { ch[x.dataset.ch] = x.checked; });
    const body = {
      log_days: parseInt($("csLogDays").value, 10) || 0,
      keep_runs: parseInt($("csKeepRuns").value, 10) || 50,
      notify: {
        enabled: $("csNotifyOn").checked, events: ev, channels: ch,
        dingtalk: {
          webhook: $("csDingWebhook").value.trim(),
          secret: $("csDingSecret").value.trim(),
        },
        pushplus: {
          token: $("csPpToken").value.trim(),
          topic: $("csPpTopic").value.trim(),
        },
      },
    };
    const d = await cronAct("/api/cron/settings", body);
    if (d.error) { if (!silent && err) err.textContent = d.error; toast(d.error, "err"); return false; }
    if (!silent) { cronCloseModal(); toast("设置已保存", "ok"); }
    return true;
  }

  /* ---------- 备份 / 恢复 ---------- */
  async function cronViewBackup() {
    try {
      const r = await fetch("/api/cron/backup");
      const d = await r.json();
      if (d.error) { toast(d.error, "err"); return; }
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      const dt = new Date(), p2 = n => String(n).padStart(2, "0");
      a.href = URL.createObjectURL(blob);
      a.download = "cron-backup-" + dt.getFullYear() + p2(dt.getMonth() + 1) + p2(dt.getDate()) +
        "-" + p2(dt.getHours()) + p2(dt.getMinutes()) + p2(dt.getSeconds()) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast("已导出 " + ((d.tasks || []).length) + " 个任务（通知密钥已脱敏）", "ok");
    } catch (e) {
      toast("备份失败：" + (e.message || e), "err");
    }
  }

  function cronViewRestore() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      let data = null;
      try { data = JSON.parse(await file.text()); } catch (e) { toast("备份文件解析失败", "err"); return; }
      const tasks = (data && Array.isArray(data.tasks)) ? data.tasks : (Array.isArray(data) ? data : []);
      if (!tasks.length) { toast("备份文件里没有任务数据", "err"); return; }
      const ok = await uiConfirm("恢复备份",
        "将从备份导入 " + tasks.length + " 个任务（保留现有任务；尽量沿用原任务 id，依赖关系一并恢复）。继续吗？",
        "恢复", false);
      if (!ok) return;
      const d = await cronAct("/api/cron/restore",
        { tasks: tasks, settings: (data && data.settings) || {}, mode: "merge" });
      if (d.error) { toast(d.error, "err"); return; }
      toast("已导入 " + d.imported + " 个任务" + (d.skipped ? "，跳过 " + d.skipped + " 条无效数据" : ""), "ok");
      cronViewRefresh();
    };
    inp.click();
  }

  /* 面板工具栏按钮 + 首屏同步一次（刷新后角标数量正确） */
  (function initCronPanel() {
    const add = $("cronNew");
    if (add) add.onclick = () => cronOpenEditor(null);
    const rf = $("cronRefresh");
    if (rf) rf.onclick = () => loadCron();
    const ov = $("cronOpenView");
    if (ov) ov.onclick = () => cronOpenView();
  })();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => loadCron({ silent: true }));
  } else {
    setTimeout(() => loadCron({ silent: true }), 0);
  }
