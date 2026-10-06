  /* ==================================================================
     后台任务管理：列出所有「运行中 / 已结束」的任务，可查看日志、停止、移除。
     数据来自服务端持久化的任务注册表 + 日志文件，所以：
       · 关掉浏览器页面 -> 后台程序照常在跑；
       · 重启本服务 -> 自动重新接管仍在运行的进程，继续跟踪日志。
     var 声明，避免 showPanel 提前调用时命中 TDZ。
     ================================================================== */
  var RUNNER = { timer: null, tasks: [] };

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

  async function loadRunnerList(opts) {
    try {
      const r = await fetch("/api/run/tasks");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      RUNNER.tasks = d.tasks || [];
      setRunnerBadge(d.running || 0);
      renderRunnerList();
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
    const list = RUNNER.tasks || [];
    if (!list.length) {
      box.innerHTML = '<div class="ph">暂时没有运行任务。<br>在「运行和调试」面板点「运行当前文件」或「后台运行（服务模式）」。</div>';
      return;
    }
    box.innerHTML = "";
    list.forEach(t => {
      const item = document.createElement("div");
      item.className = "runner-item" + (t.running ? " running" : "");
      const tag = t.mode === "bg" ? (t.promoted ? "后台·已转" : "后台") : "前台";
      const status = t.running
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
        '<div class="ri-meta">' + fmtDur(t.duration) + ' · ' + t.lines + ' 行日志 / ' + fmtSize(t.log_size) +
          ' · 启动于 ' + esc(t.started_at) + '</div>' +
        '<div class="ri-acts">' +
          '<button data-act="view">查看日志</button>' +
          (t.running
            ? '<button data-act="stop" class="danger">停止</button>'
            : '<button data-act="remove" class="danger">移除</button>') +
        '</div>';
      item.querySelector('[data-act="view"]').onclick = () => attachTask(t);
      const stop = item.querySelector('[data-act="stop"]');
      if (stop) stop.onclick = () => stopTaskById(t);
      const rem = item.querySelector('[data-act="remove"]');
      if (rem) rem.onclick = () => removeTaskById(t);
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

  async function stopTaskById(t) {
    if (t.running) {
      const ok = await uiConfirm("停止任务", "确定终止「" + t.name + "」吗？\n" + t.command, "停止", false);
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

  // 页面重新打开时不自动打开日志：只有手动点「查看日志」才显示（避免干扰）
  function maybeAttachOnLoad() { /* 已停用：日志标签仅手动打开 */ }

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

