  /* ==================================================================
     定时任务（参考青龙面板）：
       · 侧栏列出所有任务，可启用 / 停用、立即运行、停止、编辑、删除；
       · 编辑器里校验 cron 表达式并实时显示「下次运行时间」；
       · 每次执行都留一条记录（状态 / 退出码 / 耗时），可回看完整日志。
     后端：/api/cron/*（services/ide/cronsvc.py 每 5s 扫描一次调度）。
     var 声明，避免 showPanel 提前调用时命中 TDZ。
     ================================================================== */
  var CRON = { timer: null, tasks: [], editing: null, runs: [], runTask: null, logRun: null, logOffset: 0, logTimer: null };

  const CRON_PRESETS = [
    ["每分钟", "* * * * *"], ["每 5 分钟", "*/5 * * * *"], ["每 30 分钟", "*/30 * * * *"],
    ["每小时", "0 * * * *"], ["每天 0 点", "0 0 * * *"], ["每天 9 点", "0 9 * * *"],
    ["每周一 9 点", "0 9 * * 1"], ["每月 1 号", "0 0 1 * *"],
  ];
  const CRON_STATUS = {
    running: ["执行中", "run"], success: ["成功", "ok"], fail: ["失败", "bad"],
    killed: ["已停止", "bad"], timeout: ["超时", "warn"],
  };

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
      cronSetBadge(d.running || 0);
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
  function cronSetBadge(n) {
    const el = $("actCronBadge");
    if (!el) return;
    if (n > 0) { el.textContent = n > 99 ? "99+" : n; el.style.display = ""; }
    else el.style.display = "none";
  }
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
    cronSetBadge((CRON.tasks || []).filter(x => x.running).length);
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
    setTimeout(() => { const n = $("cronName"); if (n) n.focus(); }, 30);
  }
  async function cronSave() {
    const err = $("cronFormErr");
    const body = {
      id: CRON.editing ? CRON.editing.id : "",
      name: $("cronName").value.trim(),
      command: $("cronCmd").value.trim(),
      cron: $("cronExpr").value.trim(),
      cwd: $("cronCwd").value.trim(),
      remark: $("cronRemark").value.trim(),
      timeout: parseInt($("cronTimeout").value, 10) || 0,
      enabled: $("cronEnabled").checked,
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
      CRON.logRun = null; CRON.logOffset = 0;
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
      return;
    }
    box.innerHTML = "";
    const target = runs.find(x => x.id === selectId) || runs[0];
    runs.forEach(x => {
      const [sText, sCls] = cronStatusInfo(x.status);
      const row = document.createElement("div");
      row.className = "cr-row" + (target && x.id === target.id ? " on" : "");
      row.setAttribute("data-rid", x.id);
      row.innerHTML = '<span class="cr-dot ' + sCls + '"></span>' +
        '<div class="cr-row-m"><div class="cr-row-t">' + esc(cronFmtTime(x.started_at)) +
          ' <span class="cr-by">' + (x.trigger === "manual" ? "手动" : "定时") + '</span></div>' +
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
          else cronRefreshRunRow(run.id, d.status);
        }).catch(() => { CRON.logTimer = setTimeout(pull, 1500); });
    };
    pull();
  }
  function cronRefreshRunRow(rid, status) {
    const row = document.querySelector('#cronRunList .cr-row[data-rid="' + rid + '"]');
    if (!row) return;
    const dot = row.querySelector(".cr-dot");
    if (dot) dot.className = "cr-dot " + cronStatusInfo(status)[1];
    loadCron({ silent: true });
  }

  function cronTick() {                             // 面板可见时每 5s 刷新状态
    clearTimeout(CRON.timer);
    if (!$("cronPanel") || !$("cronPanel").classList.contains("active")) return;
    CRON.timer = setTimeout(async () => {
      await loadCron({ silent: true });
      cronTick();
    }, 5000);
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
                logOffset: 0, log: "", logTimer: null, timer: null };

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
      tabs.push(tab);
      renderTabsAll();
    }
    activate(tab);
    cronViewRefresh(true).then(() => {
      if (tid) cronViewSelect(tid);
      cronViewTick();
    });
    return tab;
  }
  function cronViewActive() { return !!findTab(CRON_VIEW_PATH) && active && active.path === CRON_VIEW_PATH; }
  function cronViewTick() {
    clearTimeout(CRON.view.timer);
    if (!cronViewActive()) return;
    CRON.view.timer = setTimeout(() => { cronViewRefresh().then(cronViewTick); }, 5000);
  }

  /* ---------- 数据 ---------- */
  async function cronViewRefresh(force) {
    if (!findTab(CRON_VIEW_PATH)) return;
    try {
      const r = await fetch("/api/cron/tasks");
      const d = await r.json();
      CRON.tasks = d.tasks || [];
      cronSetBadge(d.running || 0);
    } catch (_) { /* 保留旧数据，不打断界面 */ }
    if (force || !$("cvTbody")) cronViewRender();
    else { cronViewPaintHead(); cronViewPaintRows(); }
    // 侧栏面板也停在同一页时才重建（避免无谓重绘）
    if ($("cronPanel") && $("cronPanel").classList.contains("active")) renderCronList();
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
    if (st) st.innerHTML = cronViewStatsHtml();
    const old = $("cvBatch");
    if (old) old.remove();
    const head = $("cvHead");
    if (head) head.insertAdjacentHTML("beforeend", cronViewBatchHtml());
    cronViewBindBatch();
  }
  function cronViewPaintRows() {
    const tb = $("cvTbody");
    if (!tb) return;
    const list = cronViewFiltered();
    tb.innerHTML = list.length ? list.map(cronViewRowHtml).join("")
      : '<tr><td colspan="7" class="cv-empty">没有匹配的任务。可点右上角「新建任务」，' +
        '或在资源管理器里右键文件 →「添加定时任务…」。</td></tr>';
    const all = $("cvAll");
    if (all) all.checked = list.length > 0 && list.every(t => CRON.view.sel[t.id]);
    cronViewBindRows();
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
        (t.remark ? '<div class="cv-sub" title="' + escAttr(t.remark) + '">' + esc(t.remark) + '</div>' : "") + '</td>' +
      '<td class="cv-plan"><code>' + esc(t.cron) + '</code>' +
        (t.next && t.next.length ? '<div class="cv-next" title="接下来的运行时间">' + esc(t.next.slice(0, 2).join("  ·  ")) + '</div>' : "") + '</td>' +
      '<td><span class="ci-st ' + si[1] + '">' + esc(si[0]) + '</span>' +
        '<div class="cv-sub">' + (t.enabled ? "已启用" : "已停用") + '</div></td>' +
      '<td class="cv-cmd" title="' + escAttr(t.command) + '">' + esc(t.command) + '</td>' +
      '<td class="cv-last">' + (t.last_at
        ? esc(cronFmtTime(t.last_at)) + '<div class="cv-sub">' + cronFmtDur(t.last_ms) + ' · 共 ' + (t.run_count || 0) + ' 次</div>'
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
          '<span class="cv-sub">' + (x.trigger === "manual" ? "手动" : "定时") + '</span>' +
          '<span class="cv-sp"></span>' +
          '<span class="cv-run-s">' + esc(xi[0]) +
            (x.status !== "running" ? " · " + cronFmtDur(x.duration) : "") + '</span></div>';
      }).join("") : '<div class="cv-d-empty-line">还没有执行记录</div>') + '</div>' +
      '<div class="cv-d-sub">日志' +
        (CRON.view.logRun ? ' <span class="cv-sub">' + esc(cronFmtTime(CRON.view.logRun.started_at)) + '</span>' : "") +
        '<span class="cv-sp"></span>' +
        '<button class="cv-btn" data-dact="logrefresh" title="重新加载日志"><i class="bi bi-arrow-clockwise"></i></button></div>' +
      '<pre class="cv-log scroll-thin" id="cvLog">' + esc(CRON.view.log || "") + '</pre>';
    const pre = $("cvLog");
    if (pre) pre.scrollTop = pre.scrollHeight;
    cronViewBindDetail();
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
    CRON.view.cur = tid;
    CRON.view.runs = []; CRON.view.logRun = null; CRON.view.log = ""; CRON.view.logOffset = 0;
    clearTimeout(CRON.view.logTimer);
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
        }).catch(() => { CRON.view.logTimer = setTimeout(pull, 1500); });
    };
    pull();
  }
  async function cronViewRun(tid) {
    const t = (CRON.tasks || []).find(x => x.id === tid);
    const d = await cronAct("/api/cron/run", { id: tid });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已开始执行：" + ((t && t.name) || tid), "ok");
    await cronViewRefresh(true);
    cronViewSelect(tid);
  }
  async function cronViewStop(tid) {
    const d = await cronAct("/api/cron/stop", { id: tid });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已停止", "warn");
    await cronViewRefresh(true);
    if (CRON.view.cur === tid) cronViewSelect(tid);
  }
  async function cronViewCopy(t) {
    if (!t) return;
    const d = await cronAct("/api/cron/save", {
      name: t.name + " 副本", cron: t.cron, command: t.command, cwd: t.cwd || "",
      remark: t.remark || "", timeout: t.timeout || 0, enabled: false,
    });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已复制为「" + d.task.name + "」（默认停用，改好再启用）", "ok");
    cronViewRefresh(true);
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
    cronViewRefresh(true);
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
    await cronViewRefresh(true);
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
