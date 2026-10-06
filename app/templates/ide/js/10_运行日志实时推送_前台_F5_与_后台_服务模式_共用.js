  /* ==================================================================
     运行日志实时推送：前台(F5) 与 后台(服务模式) 共用
     用 SSE（EventSource）建立一条长连接，后端一有输出就推过来；
     日志再多也只有 1 次请求，不会像轮询那样刷出成百上千条
     /api/run/log 记录。SSE 断开时自动退回轮询兜底。
     ================================================================== */
  const RUNBG = { id: null, name: "", target: "", mode: "fg", timeout: 0, args: "", es: null, promoted: false };

  /* ---------- 运行日志：底部面板的动态标签，每个任务一个，互不覆盖 ----------
     - Ctrl+F5 后台运行 / 「查看日志」→ 生成「任务名」标签并实时推送；
     - 多个任务各自一个标签，切换查看，历史互不覆盖；
     - F5 前台运行（会结束的脚本）输出仍走「输出」面板。 */
  const LOGS = {};                    // taskId -> { name, el, buf:[{m,c}], offset, es, timer, done, promoted }
  const LOG_BUF_MAX = 3000;           // 每个标签在内存中保留的行数
  let currentLogId = null;            // 当前显示的日志标签

  function runLineClass(c) {
    return c === "err" ? "op-err" : c === "head" ? "op-cmd"
         : c === "ok" ? "op-ok" : c === "dim" ? "op-dim" : "";
  }

  function logPush(id, m, cls) {
    const L = LOGS[id];
    if (!L) return;
    L.buf.push({ m: String(m), c: cls || "" });
    if (L.buf.length > LOG_BUF_MAX) L.buf.splice(0, 500);
    if (currentLogId !== id) return;
    const body = $("logBody");
    const d = document.createElement("div");
    d.className = "log-line" + (cls ? " " + cls : "");
    d.textContent = m;
    body.appendChild(d);
    while (body.childElementCount > LOG_BUF_MAX) body.firstElementChild.remove();
    // 用户停在底部附近才自动滚动，往上翻历史时不打扰
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  // 确保某任务的日志标签存在并选中（不存在则创建）
  function ensureLogTab(t) {
    let L = LOGS[t.id];
    if (!L) {
      L = LOGS[t.id] = { name: t.name || "运行", buf: [], offset: 0, es: null, timer: null,
                         done: false, promoted: false, target: t.target || "" };
      const el = document.createElement("button");
      el.className = "bp-tab bp-log-tab";
      el.dataset.task = t.id;
      el.title = L.name + " 的运行日志（点 × 关闭）";
      el.innerHTML = '<span class="lt-nm">' + esc(L.name) + '</span><span class="lt-x"><i class="bi bi-x"></i></span>';
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.closest(".lt-x")) { closeLogTab(t.id); return; }
        selectLogTab(t.id);
      });
      $("bpLogTabs").appendChild(el);
      $("bpLogTabs").style.display = "";                // 首个标签出现时显示容器
      L.el = el;
    }
    if (t.target) L.target = t.target;                  // 供启动按钮判断「这个文件是否在跑」
    selectLogTab(t.id);
    return L;
  }

  function selectLogTab(id) {
    currentLogId = id;
    document.querySelectorAll(".bp-log-tab").forEach(b => b.classList.toggle("active", b.dataset.task === id));
    // 重绘该任务的完整缓冲（切换标签时）
    const L = LOGS[id], body = $("logBody");
    body.innerHTML = "";
    if (L) {
      const frag = document.createDocumentFragment();
      L.buf.forEach(l => {
        const d = document.createElement("div");
        d.className = "log-line" + (l.c ? " " + l.c : "");
        d.textContent = l.m;
        frag.appendChild(d);
      });
      body.appendChild(frag);
    }
    body.scrollTop = body.scrollHeight;
    toggleBottom(true, "log");
    bpKillMode();                                      // 切换日志标签时刷新右侧按钮状态
  }

  // 结束一个日志标签：标签变灰（保留内容可回看），断开推送
  function endLog(id, d) {
    const L = LOGS[id];
    if (!L || L.done) return;
    L.done = true;
    if (L.es) { try { L.es.close(); } catch (e) { /* 忽略 */ } L.es = null; }
    clearTimeout(L.timer);
    if (L.el) L.el.classList.add("ended");
    if (d && (d.stopped_by_user || d.timed_out || d.exit_code !== null)) {
      toast(d.stopped_by_user ? "已手动终止：" + L.name
           : d.timed_out ? "执行超时已终止：" + L.name
           : (d.exit_code === 0 ? "运行完成：" : "进程已退出（代码 " + d.exit_code + "）：") + L.name,
           d.stopped_by_user || d.timed_out ? "warn" : (d.exit_code === 0 ? "ok" : "warn"));
    }
    if (RUNBG.id === id && RUNBG.mode === "bg") bgReset();
    loadRunnerList({ silent: true });
    syncRunButtons();
  }

  function closeLogTab(id) {
    const L = LOGS[id];
    if (!L) return;
    if (L.es) { try { L.es.close(); } catch (e) { /* 忽略 */ } }
    clearTimeout(L.timer);
    if (L.el) L.el.remove();
    delete LOGS[id];
    if (RUNBG.id === id) bgReset();
    if (currentLogId === id) {
      currentLogId = null;
      const rest = Object.keys(LOGS);
      if (rest.length) selectLogTab(rest[rest.length - 1]);
      else { setBottomPane("output"); $("bpLogTabs").style.display = "none"; }
    }
  }

  // 单个任务的实时日志流（SSE，断线退回轮询）
  function streamLog(id) {
    const L = LOGS[id];
    if (!L || L.es || L.done) return;
    if (!window.EventSource) { pollLog(id); return; }
    let es;
    try {
      es = new EventSource("/api/run/stream?id=" + encodeURIComponent(id) + "&offset=" + L.offset);
    } catch (e) { pollLog(id); return; }
    L.es = es;
    es.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      L.offset = d.offset || L.offset;
      (d.lines || []).forEach(l => logPush(id, l.m, runLineClass(l.c)));
      if (d.mode === "bg") L.promoted = true;
      if (d.done) endLog(id, d);
    };
    es.onerror = () => {
      try { es.close(); } catch (e) { /* 忽略 */ }
      if (L.es === es) L.es = null;
      if (!L.done) L.timer = setTimeout(() => pollLog(id), 500);   // 断线退回轮询，不丢日志
    };
  }

  // 兜底：轮询单个任务的增量日志
  function pollLog(id) {
    const L = LOGS[id];
    if (!L || L.done) return;
    fetch("/api/run/log?id=" + encodeURIComponent(id) + "&offset=" + L.offset)
      .then(r => r.json())
      .then(d => {
        if (!LOGS[id] || LOGS[id].done) return;
        L.offset = d.offset || L.offset;
        (d.lines || []).forEach(l => logPush(id, l.m, runLineClass(l.c)));
        if (d.done) { endLog(id, d); return; }
        L.timer = setTimeout(() => pollLog(id), 800);
      })
      .catch(() => { if (LOGS[id] && !LOGS[id].done) L.timer = setTimeout(() => pollLog(id), 1500); });
  }

  // 终止按钮的目标：跟随当前所在标签——输出=前台运行，运行日志=当前查看的任务，终端=由 termKill 处理
  function activeKillId() {
    if (bottomPane === "term") return null;
    if (bottomPane === "log") {
      return (currentLogId && LOGS[currentLogId] && !LOGS[currentLogId].done) ? currentLogId : null;
    }
    if (RUNBG.id && (!LOGS[RUNBG.id] || !LOGS[RUNBG.id].done)) return RUNBG.id;
    return null;
  }

  // 底部面板右侧按钮随当前标签变化：清空=清当前内容；⊘=仅在有可终止对象时显示
  function bpKillMode() {
    const clear = $("bpClear"), kill = $("bpKill"), toBg = $("bpToBg");
    if (!clear || !kill) return;
    const noBg = () => { if (toBg) toBg.style.display = "none"; };
    if (bottomPane === "term") {
      kill.style.display = "";
      kill.classList.remove("danger");
      kill.innerHTML = '<i class="bi bi-x-circle"></i>';
      kill.title = "结束当前终端会话";
      noBg();
    } else if (bottomPane === "log") {
      const L = currentLogId ? LOGS[currentLogId] : null;
      const running = !!(L && !L.done);
      kill.style.display = running ? "" : "none";
      kill.classList.toggle("danger", running);
      kill.innerHTML = '<i class="bi bi-stop-fill"></i>';
      kill.title = running ? "终止「" + L.name + "」" : "";
      noBg();                                          // 后台任务 / 日志标签无需再转
    } else {                                           // 输出
      // 前台运行中，或已转后台但仍在运行（输出面板显示的就是它的输出）→ 都显示 ⊘
      const running = !!(RUNBG.id && (!LOGS[RUNBG.id] || !LOGS[RUNBG.id].done));
      kill.style.display = running ? "" : "none";
      kill.classList.toggle("danger", running);
      kill.innerHTML = '<i class="bi bi-stop-fill"></i>';
      kill.title = running ? "终止正在运行的程序" + (RUNBG.mode === "bg" ? "（已转后台）" : "") : "";
      // 「转后台」只在仍是前台且确实在跑时出现（超时不再自动转，这里是唯一入口）
      if (toBg) {
        toBg.style.display = (running && RUNBG.mode !== "bg") ? "" : "none";
        toBg.title = "转为后台运行（不再计时，可在「后台任务」查看）";
      }
    }
  }

  // 手动把前台运行中的任务转为后台（超时不再自动转，这里就是那个手动入口）。
  // 转成后后端会推送 mode=bg 的帧，applyFgData 会接着建「运行日志」标签继续跟踪。
  if ($("bpToBg")) {
    $("bpToBg").onclick = async () => {
      const tid = RUNBG.id;
      if (!tid || RUNBG.mode === "bg") return;
      try {
        const r = await fetch("/api/run/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: tid })
        });
        const d = await r.json();
        if (d.error) { toast("转后台失败：" + d.error, "err"); return; }
        toast("已转为后台运行，可在「后台任务」面板结束", "ok");
      } catch (e) {
        toast("转后台失败：" + (e.message || e), "err");
      }
    };
  }

  // 前台运行结束后清理状态（后台任务由 endLog 负责）
  function bgReset() {
    RUNBG.id = null; RUNBG.mode = "fg"; RUNBG.timeout = 0; RUNBG.promoted = false;
    clearTimeout(RUNBG.timer);
    if (RUNBG.es) { try { RUNBG.es.close(); } catch (e) { /* 忽略 */ } RUNBG.es = null; }
    bpKillMode();
    syncRunButtons();
  }

  /* 把「当前在跑哪些文件」推给启动按钮（01_ 文件里画 ▶ / ⏸）。
     前台看 RUNBG，后台看未结束的日志标签 —— 两处都要带上原始文件路径。 */
  function runningTargets() {
    const map = {};
    if (RUNBG.id && RUNBG.target) map[RUNBG.target] = RUNBG.id;
    Object.keys(LOGS).forEach(id => {
      const L = LOGS[id];
      if (L && !L.done && L.target) map[L.target] = id;
    });
    return map;
  }

  function syncRunButtons() {
    if (typeof window.setRunningTargets === "function") window.setRunningTargets(runningTargets());
  }
  window.syncRunButtons = syncRunButtons;              // 11_ 后台任务面板恢复任务后也要刷一次

  // F5 前台运行：输出走「输出」面板（会结束的脚本，打印完就退出）
  function startRunStream(d, target, mode, argsStr) {
    RUNBG.id = d.id; RUNBG.offset = 0;
    RUNBG.name = baseName(target); RUNBG.target = target;
    RUNBG.mode = mode; RUNBG.timeout = d.timeout || 0; RUNBG.args = argsStr || "";
    RUNBG.promoted = false;
    syncRunButtons();                                  // 启动按钮变成 ⏸
    if (mode === "fg") {
      toggleBottom(true, "output");
      opLine("$ " + d.command + "    （工作目录：" + d.cwd + "）", "op-cmd");
      opLine("  pid " + d.pid + " · 超时提醒 " + (d.timeout || 0) + "s（到点只提醒，不会自动转后台或终止；可点右上「↓」手动转后台）", "op-dim");
      bpKillMode();
      fgStream();
      return;
    }
    // 后台运行：生成「任务名」日志标签并实时推送
    RUNBG.id = d.id; RUNBG.name = baseName(target);
    ensureLogTab({ id: d.id, name: baseName(target), target: target });
    logPush(d.id, "▶ 后台运行：" + baseName(target) + "（pid " + d.pid + "）· 点右上 ⊘ 可终止", "op-cmd");
    bpKillMode();
    streamLog(d.id);
    loadRunnerList({ silent: true });                  // 同步「后台任务」面板与角标
  }

  // 前台运行的 SSE 流：行写「输出」面板；若超时转后台，后续切到日志标签
  function fgStream() {
    clearTimeout(RUNBG.timer);
    if (!RUNBG.id) return;
    if (!window.EventSource) { fgPoll(); return; }
    const tid = RUNBG.id;
    let es;
    try {
      es = new EventSource("/api/run/stream?id=" + encodeURIComponent(tid) + "&offset=" + RUNBG.offset);
    } catch (e) { fgPoll(); return; }
    RUNBG.es = es;
    es.onmessage = ev => {
      if (tid !== RUNBG.id) { try { es.close(); } catch (e) { /* 忽略 */ } return; }
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      applyFgData(d);
    };
    es.onerror = () => {
      try { es.close(); } catch (e) { /* 忽略 */ }
      if (RUNBG.es === es) RUNBG.es = null;
      if (tid !== RUNBG.id) return;
      RUNBG.timer = setTimeout(fgPoll, 500);
    };
  }

  function fgPoll() {
    clearTimeout(RUNBG.timer);
    if (!RUNBG.id) return;
    const tid = RUNBG.id;
    fetch("/api/run/log?id=" + encodeURIComponent(tid) + "&offset=" + RUNBG.offset)
      .then(r => r.json())
      .then(d => {
        if (tid !== RUNBG.id) return;
        if (applyFgData(d)) return;
        RUNBG.timer = setTimeout(fgPoll, 400);
      })
      .catch(e => {
        if (tid !== RUNBG.id) return;
        opLine("✘ 读取运行输出失败：" + (e.message || e), "op-err");
        bgReset();
      });
  }

  // 前台运行的一帧数据：写「输出」面板；超时转后台时把任务转给日志标签
  function applyFgData(d) {
    if (d.error) { opLine("✘ " + d.error, "op-err"); bgReset(); return true; }
    RUNBG.offset = d.offset;
    (d.lines || []).forEach(l => opLine(l.m, runLineClass(l.c)));
    if (d.mode) RUNBG.mode = d.mode;
    if (d.mode === "bg" && !RUNBG.promoted) {
      // 转后台（由用户点右上「↓」手动触发）：建日志标签接续跟踪，输出面板保留已打印内容
      RUNBG.promoted = true;
      ensureLogTab({ id: RUNBG.id, name: RUNBG.name, target: RUNBG.target });
      logPush(RUNBG.id, "⏱ 已转为后台运行，后续日志请看「运行日志」标签", "op-head");
      streamLog(RUNBG.id);
      bpKillMode();                                    // 已转后台 → 收起「转后台」按钮
      syncRunButtons();                                // 前台转后台，按钮保持 ⏸
    }
    if (d.done) {
      const okExit = d.exit_code === 0;
      opLine((okExit ? "✔ " : "✘ ") + "进程已退出，代码 " + d.exit_code +
             " · 用时 " + d.duration + "s", okExit ? "op-ok" : "op-err");
      toast(okExit ? "运行完成" : "运行结束（退出码 " + d.exit_code + "）", okExit ? "ok" : "warn");
      bgReset();
      loadRunnerList({ silent: true });
      return true;
    }
    return false;
  }

  async function runBackground(argsStr) {
    if (!active || !active.cm || active.diff) { toast("请先打开一个可运行的文件", "warn"); return; }
    const target = active.displayPath || active.path;
    const ext = getExt(target);
    if (!RUN_LABELS[ext]) { toast("暂不支持直接运行 ." + ext + " 文件", "warn"); return; }
    if (active.dirty) {
      const ok = await uiConfirm("运行前保存", "文件有未保存的修改，是否先保存再运行？", "保存并运行", false);
      if (!ok) return;
      try { await saveQuiet(active); } catch (e) { toast("保存失败：" + (e.message || e), "err"); return; }
    }
    try {
      const r = await fetch("/api/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, args: argsStr || "", background: true }),
      });
      const d = await r.json();
      if (d.error) { toast("启动失败：" + d.error, "err"); return; }
      startRunStream(d, target, "bg", argsStr);
      toast("已在后台运行：" + RUNBG.name, "ok");
    } catch (e) {
      toast("启动失败：" + (e.message || e), "err");
    }
  }

  async function stopBackground(silent) {
    const id = activeKillId();
    if (!id) { if (!silent) toast("当前没有正在运行的程序", "warn"); return; }
    try {
      const r = await fetch("/api/run/stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (d.error) { toast(d.error, "err"); return; }
      if (!silent) toast("已发送终止信号…", "warn");
    } catch (e) {
      toast("终止失败：" + (e.message || e), "err");
    }
  }

  function loadRuntimes() {
    fetch("/api/run/runtimes").then(r => r.json()).then(d => {
      const items = d.runtimes || [];
      const avail = items.filter(x => x.available);
      $("runRuntimes").textContent = avail.length
        ? "可用：" + avail.map(x => x.label).join(" / ")
        : "未检测到可用的解释器（Python / Node / Bash 等）";
      const list = $("runList");
      list.innerHTML = "";
      items.forEach(it => {
        const row = document.createElement("div");
        row.className = "run-item";
        row.title = it.available ? it.path : "未安装";
        row.innerHTML = '<span class="dot' + (it.available ? "" : " off") + '"></span>' +
          '<span>' + esc(it.label) + '</span>' +
          '<span class="run-exe">' + esc(it.exts.map(e => "." + e).join(" ")) + '</span>';
        list.appendChild(row);
      });
      const more = document.createElement("div");
      more.className = "run-item";
      more.style.cursor = "pointer";
      more.innerHTML = '<i class="bi bi-cpu"></i> <span>运行环境管理…</span>';
      more.onclick = openEnvPanel;
      list.appendChild(more);
    }).catch(() => { $("runRuntimes").textContent = "运行时检测失败"; });
  }

