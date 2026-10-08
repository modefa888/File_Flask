  /* ==================================================================
     后台任务管理：列出所有「运行中 / 已暂停 / 已结束」的任务。
     卡片上可直接：查看日志 / 启动 / 暂停（挂起进程）/ 继续 / 重启 / 停止 / 移除，
     并实时显示该任务（含它拉起的子进程）的 CPU 与内存占用。
     数据来自服务端持久化的任务注册表 + 日志文件，所以：
       · 关掉浏览器页面 -> 后台程序照常在跑；
       · 重启本服务 -> 自动重新接管仍在运行的进程，继续跟踪日志。
     var 声明，避免 showPanel 提前调用时命中 TDZ。
     ================================================================== */
  var RUNNER = { timer: null, tasks: [], holdUntil: 0 };
  const RUNNER_EMPTY_HTML =
    '<div class="ph">暂时没有运行任务。<br>在「运行和调试」面板点「运行当前文件」或「后台运行（服务模式）」。</div>';

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + "m" + (s ? s + "s" : "");
    return Math.floor(m / 60) + "h" + (m % 60) + "m";
  }
  function fmtSize(n) {
    n = n || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function setRunnerBadge(n) {
    const el = $("actRunnerBadge");
    if (!el) return;
    if (n > 0) { el.textContent = n > 99 ? "99+" : n; el.style.display = ""; }
    else el.style.display = "none";
  }

  /* ---------- 资源占用：CPU / 内存 / 进程数 ----------
     数值由后端按「进程树」聚合（含 npm 拉起的 node 这类子进程），前端只负责显示。
     CPU 以单核为 100%，多核 / 多线程程序可能超过 100%（与 top 一致）。 */
  function fmtCpu(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return (v >= 10 ? Math.round(v) : Number(v).toFixed(1)) + "%";
  }
  function cpuCls(v) {                      // 高占用变色，一眼看出是谁在吃 CPU
    if (v === null || v === undefined || isNaN(v)) return "";
    return v >= 80 ? " hot" : (v >= 50 ? " warm" : "");
  }
  /* 端口链接：点击在新标签打开 http://<当前访问主机>:<端口>（本机 / 内网都能直达该服务） */
  function portUrl(p) {
    let host = (typeof location !== "undefined" && location.hostname) || "localhost";
    if (host.indexOf(":") >= 0 && host.charAt(0) !== "[") host = "[" + host + "]";   // IPv6 需加方括号
    return "http://" + host + ":" + p + "/";
  }
  function resLine(t) {
    if (!t.running) return "";              // 已结束的进程读不到占用，整行不显示
    const n = t.procs || 1;
    const ports = (t.ports || []).filter(p => p > 0);
    const portHtml = ports.map(p => {
      const url = portUrl(p);
      return '<a class="res port" href="' + escAttr(url) + '" target="_blank" rel="noopener" ' +
        'title="在新标签打开 ' + escAttr(url) + '"><i class="bi bi-box-arrow-up-right"></i> ' + p + '</a>';
    }).join("");
    return '<div class="ri-meta ri-res">' +
      '<span class="res cpu' + cpuCls(t.cpu) + '" title="CPU 占用：该任务及其子进程合计（单核为 100%）">' +
        '<i class="bi bi-cpu"></i> ' + fmtCpu(t.cpu) + '</span>' +
      '<span class="res mem" title="内存占用：常驻内存（RSS）合计，含子进程">' +
        '<i class="bi bi-memory"></i> ' + fmtSize(t.mem || 0) + '</span>' +
      (n > 1 ? '<span class="res dim" title="该任务共拉起 ' + n + ' 个进程">' + n + ' 进程</span>' : "") +
      portHtml +
      '</div>';
  }
  /* 操作按钮：全部用彩色图标按钮（一行放得下），末尾统一带「查看详细信息」 */
  function actsHtml(t) {
    let h = '<button data-act="view" class="ico v-view" title="查看日志（底部输出面板）"><i class="bi bi-file-earmark-text"></i></button>';
    if (t.running && t.paused) {
      h += '<button data-act="resume" class="ico v-go" title="继续运行（从挂起点恢复，不丢进程状态）"><i class="bi bi-play-fill"></i></button>' +
           '<button data-act="restart" class="ico v-re" title="重启（先停止再重新启动）"><i class="bi bi-arrow-clockwise"></i></button>' +
           '<button data-act="stop" class="ico v-stop" title="停止（终止进程，可再启动）"><i class="bi bi-stop-fill"></i></button>';
    } else if (t.running) {
      h += '<button data-act="pause" class="ico v-pause" title="暂停（挂起进程：CPU 归零，端口仍占用）"><i class="bi bi-pause-fill"></i></button>' +
           '<button data-act="restart" class="ico v-re" title="重启（先停止再重新启动）"><i class="bi bi-arrow-clockwise"></i></button>' +
           '<button data-act="stop" class="ico v-stop" title="停止（终止进程，可再启动）"><i class="bi bi-stop-fill"></i></button>';
    } else {
      h += '<button data-act="restart" class="ico v-go" title="启动（用原来的文件与参数重新运行）"><i class="bi bi-play-fill"></i></button>' +
           '<button data-act="remove" class="ico v-del" title="移除这条记录（连同日志文件）"><i class="bi bi-trash"></i></button>';
    }
    h += '<button data-act="info" class="ico v-info" title="查看详细信息"><i class="bi bi-info-circle"></i></button>';
    return h;
  }

  /* ---------- 查看详细信息：点「ⓘ」弹出一个悬浮卡片，展示该任务的全部信息 ---------- */
  let _taskInfo = { el: null, tid: "" };
  function taskStatusText(t) {
    if (t.paused && t.running) return "已暂停（进程挂起中，端口仍占用）";
    if (t.running) return "运行中";
    return "已结束" + (t.exit_code === null || t.exit_code === undefined ? "" : "（退出码 " + t.exit_code + "）") +
      (t.timed_out ? " · 超时终止" : "") + (t.stopped_by_user ? " · 手动停止" : "");
  }
  function taskInfoRows(t) {
    const ports = (t.ports || []).filter(p => p > 0);
    const state = taskStatusText(t);
    const rows = [
      ["名称", t.name || "-"],
      ["目标文件", t.target || "-"],
      ["完整命令", t.command || "-", "mono"],
      ["工作目录", t.cwd || "-", "mono"],
      ["模式", t.mode === "bg" ? (t.promoted ? "后台（已转）" : "后台") : "前台"],
      ["状态", state],
      ["PID", String(t.pid || "-")],
      ["进程数", String(t.procs || (t.running ? 1 : 0))],
      ["CPU", fmtCpu(t.cpu)],
      ["内存", fmtSize(t.mem || 0)],
      ["启动时间", t.started_at || "-"],
      ["运行时长", fmtDur(t.duration)],
      ["日志", (t.lines || 0) + " 行 / " + fmtSize(t.log_size || 0)],
      ["日志文件", t.log_path || "-", "mono"],
    ];
    let html = "";
    rows.forEach(([k, v, cls]) => {
      html += '<div class="ti-row"><span class="ti-k">' + esc(k) + '</span>' +
        '<span class="ti-v' + (cls ? " " + cls : "") + '">' + esc(String(v)) + '</span></div>';
    });
    if (ports.length) {
      html += '<div class="ti-row"><span class="ti-k">监听端口</span><span class="ti-v">' +
        ports.map(p => '<a class="ti-port" href="' + escAttr(portUrl(p)) + '" target="_blank" rel="noopener" ' +
          'title="在新标签打开 ' + escAttr(portUrl(p)) + '"><i class="bi bi-box-arrow-up-right"></i> ' + p + '</a>')
          .join(" ") + '</span></div>';
    }
    return html;
  }
  function refreshTaskInfo() {
    if (!_taskInfo.el || !_taskInfo.tid) return;
    const t = (RUNNER.tasks || []).filter(x => x.id === _taskInfo.tid)[0];
    if (!t) { hideTaskInfo(); return; }
    const body = _taskInfo.el.querySelector(".ti-body");
    if (body) body.innerHTML = taskInfoRows(t);
  }
  function hideTaskInfo() {
    if (_taskInfo.el) { _taskInfo.el.remove(); _taskInfo.el = null; }
    _taskInfo.tid = "";
  }
  function showTaskInfo(t, anchor) {
    if (_taskInfo.el && _taskInfo.tid === t.id) { hideTaskInfo(); return; }   // 再次点击 → 收起
    hideTaskInfo();
    const pop = document.createElement("div");
    pop.className = "runner-info-pop";
    pop.innerHTML =
      '<div class="ti-head"><i class="bi bi-info-circle"></i><span class="ti-title"></span>' +
      '<button class="ti-close" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
      '<div class="ti-body"></div>';
    pop.querySelector(".ti-title").textContent = t.name || "任务详情";
    pop.querySelector(".ti-body").innerHTML = taskInfoRows(t);
    pop.querySelector(".ti-close").onclick = () => hideTaskInfo();
    document.body.appendChild(pop);
    _taskInfo = { el: pop, tid: t.id };
    // 定位到按钮附近：优先放下面，空间不足则放上面
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - pr.width - 8));
    let top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  document.addEventListener("click", (e) => {                 // 点外部 / Esc 关闭详情悬浮框
    if (!_taskInfo.el) return;
    if (e.target.closest && (e.target.closest(".runner-info-pop") || e.target.closest('[data-act="info"]'))) return;
    hideTaskInfo();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTaskInfo(); });
  // 面板滚动时按钮会移走：同步收起详情悬浮框，避免它孤零零地停在原处
  document.addEventListener("scroll", (e) => {
    if (_taskInfo.el && e.target && e.target.closest && e.target.closest("#runnerPanel")) hideTaskInfo();
  }, true);
  async function runAct(url, id) {          // 任务操作统一走 POST {id}
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id }),
    });
    return await r.json();
  }

  async function loadRunnerList(opts) {
    try {
      const r = await fetch("/api/run/tasks");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      RUNNER.tasks = d.tasks || [];
      setRunnerBadge(d.running || 0);
      renderRunnerList();
      refreshTaskInfo();   // 详情悬浮框开着时，同步刷新内容
      // 行号旁的 ▶/⏸ 跟随后端真实状态（刷新后也不会退回 ▶）
      if (window.syncRunButtons) window.syncRunButtons();
      if (opts && opts.autofocus) maybeAttachOnLoad();
    } catch (e) {
      if (!(opts && opts.silent) && $("runnerHint")) {
        $("runnerHint").textContent = "读取任务列表失败：" + (e.message || e);
      }
    }
  }

  function renderRunnerList() {
    const box = $("runnerList");
    if (!box) return;
    if (Date.now() < RUNNER.holdUntil) return;   // 用户正按着卡片：跳过本次重绘，别把他要点的按钮换掉
    const list = RUNNER.tasks || [];
    if (!list.length) {
      box.innerHTML = RUNNER_EMPTY_HTML;
      return;
    }
    box.innerHTML = "";
    list.forEach(t => {
      const item = document.createElement("div");
      item.className = "runner-item" + (t.running ? " running" : "") + (t.paused ? " paused" : "");
      item.setAttribute("data-tid", t.id);       // 移除后可按 id 直接删掉这张卡片（不重新拉列表）
      const tag = t.mode === "bg" ? (t.promoted ? "后台·已转" : "后台") : "前台";
      const status = t.paused
        ? '<span class="dot paused"></span>已暂停'
        : t.running
          ? '<span class="dot"></span>运行中'
          : '<span class="dot off"></span>已结束' +
            (t.exit_code === null || t.exit_code === undefined ? "" : "（代码 " + t.exit_code + "）");
      item.innerHTML =
        '<div class="ri-top">' + status +
          '<span class="ri-name" title="' + escAttr(t.target) + '">' + esc(t.name) + '</span>' +
          '<span class="ri-tag">' + esc(tag) + '</span></div>' +
        '<div class="ri-cmd" title="' + escAttr(t.command) + '">' + esc(t.command) + '</div>' +
        '<div class="ri-meta">pid ' + (t.pid || "-") + ' · ' + esc(t.cwd) + '</div>' +
        resLine(t) +                               // CPU / 内存 / 进程数（仅运行中显示）
        '<div class="ri-meta">' + fmtDur(t.duration) + ' · ' + t.lines + ' 行日志 / ' + fmtSize(t.log_size) +
          ' · 启动于 ' + esc(t.started_at) + '</div>' +
        '<div class="ri-acts">' + actsHtml(t) + '</div>';
      const bind = (act, fn) => {
        const b = item.querySelector('[data-act="' + act + '"]');
        if (b) b.onclick = fn;
      };
      bind("view", () => attachTask(t));
      bind("pause", () => pauseTaskById(t));
      bind("resume", () => resumeTaskById(t));
      bind("restart", () => restartTaskById(t));
      bind("stop", () => stopTaskById(t));
      bind("remove", () => removeTaskById(t));
      bind("info", (ev) => showTaskInfo(t, ev.currentTarget));   // 查看详细信息悬浮框
      box.appendChild(item);
    });
  }

  // 把某个任务的日志挂到底部面板（生成/选中标签，回放历史并持续推送）
  // auto=true（刷新后自动恢复）：不强行打开被用户关闭的底部面板
  function attachTask(t, auto) {
    ensureLogTab(t, auto);              // 内部会 selectLogTab（auto 时按需打开底部面板）
    if (!LOGS[t.id].es && !LOGS[t.id].done) streamLog(t.id);
    RUNBG.id = t.id; RUNBG.name = t.name; RUNBG.target = t.target;
    RUNBG.mode = t.mode || "bg";
    bpKillMode();
    if (window.syncRunButtons) window.syncRunButtons();  // 启动按钮跟着变 ⏸
    loadRunnerList({ silent: true });
  }

  /* 项目名：任务的工作目录名（cwd 就是所在项目根目录，如 .../CODE/api-node）。
     确认框里只显示它，不再铺开整条命令行与路径 —— 想看完整路径可在任务列表里悬停。 */
  function taskProject(t) {
    const cwd = String((t && t.cwd) || "").replace(/\/+$/, "");
    if (cwd && cwd !== "/" && cwd !== "." && cwd !== "..") {
      const n = cwd.split("/").pop();
      if (n) return n;
    }
    const parts = String((t && t.target) || "").replace(/\/+$/, "").split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : (parts.pop() || "");
  }
  /* ---------- 暂停 / 继续：挂起进程（SIGSTOP），进程还在、CPU 归零 ---------- */
  async function pauseTaskById(t) {
    try {
      const d = await runAct("/api/run/pause", t.id);
      if (d.error) throw new Error(d.error);
      toast("已暂停：" + t.name + "（端口仍被占用）", "warn");
      loadRunnerList({ silent: true });
    } catch (e) {
      toast("暂停失败：" + (e.message || e), "err");
    }
  }
  async function resumeTaskById(t) {
    try {
      const d = await runAct("/api/run/resume", t.id);
      if (d.error) throw new Error(d.error);
      toast("已继续运行：" + t.name, "ok");
      loadRunnerList({ silent: true });
    } catch (e) {
      toast("继续失败：" + (e.message || e), "err");
    }
  }
  /* ---------- 启动 / 重启：沿用原文件、工作目录与参数重新拉起 ----------
     运行中的任务会先被停止（后端会等旧进程真正退出再启动，避免端口没释放导致启动失败）；
     返回的新任务复用启动路径接回日志面板，旧记录保留在列表里，历史日志仍可回看。 */
  async function restartTaskById(t) {
    if (t.running) {
      const proj = taskProject(t);
      const ok = await uiConfirm("重启任务",
        "确定重启「" + t.name + "」吗？会先停止当前进程，再用原参数启动。" + (proj ? "\n项目：" + proj : ""),
        "重启", false);
      if (!ok) return;
    }
    try {
      const d = await runAct("/api/run/restart", t.id);
      if (d.error) throw new Error(d.error);
      startRunStream(d, d.target || t.target, d.mode || "bg", "");   // 新任务自动接上日志并持续推送
      toast((t.running ? "已重启：" : "已启动：") + t.name, "ok");
      loadRunnerList({ silent: true });
    } catch (e) {
      toast("启动失败：" + (e.message || e), "err");
    }
  }

  async function stopTaskById(t) {
    if (t.running) {
      const proj = taskProject(t);
      const ok = await uiConfirm("停止任务",
        "确定终止「" + t.name + "」吗？" + (proj ? "\n项目：" + proj : ""), "停止", false);
      if (!ok) return;
    }
    try {
      const r = await fetch("/api/run/stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      toast("已发送终止信号：" + t.name, "warn");
      setTimeout(() => loadRunnerList({ silent: true }), 500);
    } catch (e) {
      toast("停止失败：" + (e.message || e), "err");
    }
  }

  /* 移除成功后直接删掉这张卡片（以及本地缓存里的记录），不重新请求列表：
     避免多请求一次、也避免列表整体重绘导致其他卡片闪烁 / 按钮被换掉。 */
  function removeTaskCard(tid) {
    const box = $("runnerList");
    if (box) {
      const el = box.querySelector('.runner-item[data-tid="' + tid + '"]');
      if (el) el.remove();
    }
    RUNNER.tasks = (RUNNER.tasks || []).filter(x => x.id !== tid);
    setRunnerBadge((RUNNER.tasks || []).filter(x => x.running).length);
    if (box && !RUNNER.tasks.length) box.innerHTML = RUNNER_EMPTY_HTML;
    if (_taskInfo.tid === tid) hideTaskInfo();     // 详情悬浮框正开着这条 → 一并收起
  }

  async function removeTaskById(t) {
    const proj = taskProject(t);
    const ok = await uiConfirm("移除任务记录",
      "确定移除「" + t.name + "」这条记录吗？会连同它的日志文件一起删除，此操作不可撤销。" +
      (proj ? "\n项目：" + proj : ""), "移除", true);
    if (!ok) return;
    try {
      const r = await fetch("/api/run/remove", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (RUNBG.id === t.id) bgReset();
      removeTaskCard(t.id);                        // 直接删除当前卡片，不请求列表
      toast("已移除记录：" + t.name, "ok");
    } catch (e) {
      toast("移除失败：" + (e.message || e), "err");
    }
  }

  /* 刷新后恢复：把刷新前正在查看的那个任务接回来（重建日志标签、回放历史并继续推送）。
     只在"确实看过"时才恢复 —— 没看过就不弹面板，避免平白干扰。 */
  function maybeAttachOnLoad() {
    let last = "";
    try { last = localStorage.getItem("ide.run.lastLog") || ""; } catch (e) { last = ""; }
    if (!last) return;
    const t = (RUNNER.tasks || []).filter(x => x.id === last)[0];
    if (!t) {                                    // 任务已被移除 / 清理 → 忘掉它
      try { localStorage.removeItem("ide.run.lastLog"); } catch (e) { /* 忽略 */ }
      return;
    }
    attachTask(t, true);                         // 刷新自动恢复：不覆盖用户「已关闭底部面板」的意图
  }

  /* 页面加载后主动同步一次后端状态：刷新前在跑的任务要恢复成
     「行号旁 ⏸」＋「上次在看的输出面板」，而不是退回到未运行的样子。 */
  function restoreRunnerState() {
    loadRunnerList({ silent: true }).then(() => {
      if (window.restoreFgOnLoad) window.restoreFgOnLoad(RUNNER.tasks);   // 前台：接回「输出」面板
      maybeAttachOnLoad();                                                // 后台：接回上次看的日志
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", restoreRunnerState);
  } else {
    setTimeout(restoreRunnerState, 0);           // 等 01_ 注册好 setRunningTargets
  }

  // 面板可见时每 3s 刷新一次状态（不可见就停，不产生无谓请求）
  function runnerTick() {
    clearTimeout(RUNNER.timer);
    if (!$("runnerPanel") || !$("runnerPanel").classList.contains("active")) return;
    RUNNER.timer = setTimeout(async () => {
      await loadRunnerList({ silent: true });
      runnerTick();
    }, 3000);
  }

  // 「清理已结束记录」入口已移除：每张卡片有「移除」，后端也会自动清理过期记录

  /* 鼠标按在任务卡片上时，短暂跳过自动刷新：面板可见时每 3s 会重建整块列表，
     若恰好落在「按下 → 抬起」之间，按钮会被换成新 DOM，这一下点击就丢了。 */
  document.addEventListener("pointerdown", e => {
    const el = e.target && e.target.closest ? e.target.closest("#runnerList") : null;
    if (el) RUNNER.holdUntil = Date.now() + 1200;
  }, true);

