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
  function resLine(t) {
    if (!t.running) return "";              // 已结束的进程读不到占用，整行不显示
    const n = t.procs || 1;
    return '<div class="ri-meta ri-res">' +
      '<span class="res' + cpuCls(t.cpu) + '" title="CPU 占用：该任务及其子进程合计（单核为 100%）">' +
        '<i class="bi bi-cpu"></i> ' + fmtCpu(t.cpu) + '</span>' +
      '<span class="res" title="内存占用：常驻内存（RSS）合计，含子进程">' +
        '<i class="bi bi-memory"></i> ' + fmtSize(t.mem || 0) + '</span>' +
      (n > 1 ? '<span class="res dim" title="该任务共拉起 ' + n + ' 个进程">' + n + ' 进程</span>' : "") +
      '</div>';
  }
  /* 操作按钮：查看日志占满剩余宽度，其余用图标（一行放得下，不挤成两行） */
  function actsHtml(t) {
    let h = '<button data-act="view" class="wide">查看日志</button>';
    if (t.running && t.paused) {
      h += '<button data-act="resume" class="ico" title="继续运行（从挂起点恢复，不丢进程状态）"><i class="bi bi-play-fill"></i></button>' +
           '<button data-act="restart" class="ico" title="重启（先停止再重新启动）"><i class="bi bi-arrow-clockwise"></i></button>' +
           '<button data-act="stop" class="ico danger" title="停止（终止进程，可再启动）"><i class="bi bi-stop-fill"></i></button>';
    } else if (t.running) {
      h += '<button data-act="pause" class="ico" title="暂停（挂起进程：CPU 归零，端口仍占用）"><i class="bi bi-pause-fill"></i></button>' +
           '<button data-act="restart" class="ico" title="重启（先停止再重新启动）"><i class="bi bi-arrow-clockwise"></i></button>' +
           '<button data-act="stop" class="ico danger" title="停止（终止进程，可再启动）"><i class="bi bi-stop-fill"></i></button>';
    } else {
      h += '<button data-act="restart" class="ico" title="启动（用原来的文件与参数重新运行）"><i class="bi bi-play-fill"></i></button>' +
           '<button data-act="remove" class="ico danger" title="移除这条记录（连同日志文件）"><i class="bi bi-trash"></i></button>';
    }
    return h;
  }
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
      box.innerHTML = '<div class="ph">暂时没有运行任务。<br>在「运行和调试」面板点「运行当前文件」或「后台运行（服务模式）」。</div>';
      return;
    }
    box.innerHTML = "";
    list.forEach(t => {
      const item = document.createElement("div");
      item.className = "runner-item" + (t.running ? " running" : "") + (t.paused ? " paused" : "");
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
        '<div class="ri-meta">pid ' + (t.pid || "-") +
          (t.ports && t.ports.length ? ' · <span style="color:#4fc1ff">端口 ' + t.ports.join(", ") + '</span>' : "") +
          ' · ' + esc(t.cwd) + '</div>' +
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
      box.appendChild(item);
    });
  }

  // 把某个任务的日志挂到底部面板（生成/选中标签，回放历史并持续推送）
  function attachTask(t) {
    ensureLogTab(t);                    // 内部会 selectLogTab + 打开底部面板
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

  async function removeTaskById(t) {
    try {
      const r = await fetch("/api/run/remove", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      if (RUNBG.id === t.id) bgReset();
      toast("已移除记录：" + t.name, "ok");
      loadRunnerList({ silent: true });
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
    attachTask(t);
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

