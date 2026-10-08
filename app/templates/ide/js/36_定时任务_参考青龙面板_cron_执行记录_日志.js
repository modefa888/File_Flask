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

  /* 面板工具栏按钮 + 首屏同步一次（刷新后角标数量正确） */
  (function initCronPanel() {
    const add = $("cronNew");
    if (add) add.onclick = () => cronOpenEditor(null);
    const rf = $("cronRefresh");
    if (rf) rf.onclick = () => loadCron();
  })();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => loadCron({ silent: true }));
  } else {
    setTimeout(() => loadCron({ silent: true }), 0);
  }
