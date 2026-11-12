  /* ==================================================================
     调试运行（pdb）：交互式调试当前 Python 文件

     与普通运行（F5）的区别：
     - 后端把 python -m pdb 接到 PTY，输出经 SSE 增量推到「调试」页签；
     - 输出按行渲染并分色：pdb 调试输出 / 程序输出 / 错误 / 操作提示
       各用不同背景（dbgClassifyLine 分类，见 62_ CSS）；
     - 输入框 / 工具按钮把 n / s / c / r / p / b / q 等命令写回 PTY；
     - 断点按文件保存在浏览器本地：编辑器行号左侧有专门的「断点列」，
       点击即添加 / 再点取消（dbgBindGutter，列在 00_preamble gutters 里），
       F9 / 侧栏按钮也可操作；启动时自动把断点注入 pdb；
     - 「变量」按钮弹层：读取当前作用域变量列表（locals+globals），
       点击某个变量用 pdb 的 pp 命令查看内容（dbgSys* 状态机解析回显）。

     放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / ROOT / active / tabs /
     toast / esc / uiPrompt / uiConfirm / saveQuiet / getExt / baseName /
     toggleBottom / setBottomPane / bpKillMode 等。
     ================================================================== */
  const DBG_BP_KEY = "ide.debug.breakpoints." + ((typeof ROOT !== "undefined" && ROOT) ? ROOT : location.pathname);
  const DBG_SESSION_KEY = "ide.debug.session";
  const DBG_MAX_LINES = 1200;                          // 输出区保留的行数上限
  const DBG = {
    id: null, target: "", pid: 0, offset: 0,
    es: null, timer: null, lines: [], pending: "", raf: 0,
    hist: [], hi: -1,
    done: true, paused: false, finished: false,
    sys: null,                                         // 变量读取状态机：{kind,name,buf,echoDone,t}
  };

  function dbgBpLoad() {
    try {
      const d = JSON.parse(localStorage.getItem(DBG_BP_KEY) || "{}");
      if (d && typeof d === "object" && !Array.isArray(d)) {
        const out = {};
        Object.keys(d).forEach(p => {
          if (!Array.isArray(d[p])) return;
          out[p] = d[p].map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 50);
        });
        return out;
      }
    } catch (_) { /* 本地数据损坏：忽略 */ }
    return {};
  }
  let DBG_BPS = dbgBpLoad();

  function dbgBpSave() {
    try { localStorage.setItem(DBG_BP_KEY, JSON.stringify(DBG_BPS)); } catch (_) { /* 配额不足：忽略 */ }
  }
  function dbgBpOf(path) {
    return (DBG_BPS[path] || []).slice().sort((a, b) => a - b);
  }
  function dbgCurPath() {
    return (active && (active.displayPath || active.path)) || DBG.target || "";
  }

  /* ---------- 断点：侧栏列表 ---------- */
  function dbgRenderBp() {
    const box = $("dbgBpList");
    if (box) {
      const path = dbgCurPath();
      const lines = dbgBpOf(path);
      box.innerHTML = "";
      const cnt = $("dbgBpCnt");
      if (cnt) cnt.textContent = lines.length;
      if (!lines.length) {
        const empty = document.createElement("div");
        empty.className = "dbg-bp-empty";
        empty.textContent = "暂无断点。点击编辑器行号左侧空白即可添加（再点取消），或按 F9。";
        box.appendChild(empty);
      } else {
        lines.forEach(n => {
          const item = document.createElement("div");
          item.className = "dbg-bp-item";
          const ln = document.createElement("span");
          ln.className = "dbg-bp-ln";
          ln.textContent = "L" + n;
          const nm = document.createElement("span");
          nm.className = "dbg-bp-nm";
          nm.textContent = baseName(path);
          nm.title = path + ":" + n + "（点击跳转到该行）";
          nm.onclick = () => {
            if (!active || !active.cm) return;
            try {
              active.cm.setCursor({ line: Math.max(0, n - 1), ch: 0 });
              active.cm.focus();
              active.cm.scrollIntoView({ line: Math.max(0, n - 1), ch: 0 }, 80);
            } catch (_) { /* 忽略 */ }
          };
          const x = document.createElement("button");
          x.className = "dbg-bp-x";
          x.title = "删除此断点";
          x.innerHTML = '<i class="bi bi-x"></i>';
          x.onclick = () => dbgToggleBp(n, path);
          item.appendChild(document.createElement("span")).className = "dbg-bp-dot";
          item.appendChild(ln); item.appendChild(nm); item.appendChild(x);
          box.appendChild(item);
        });
      }
    }
    dbgSyncGutter();
  }

  /* 编辑器行号槽红点：setGutterMarker 只打在 dbg-bp-col 这一列，不污染行号 / 折叠列；
     整行淡红背景用 addLineClass（跟行走，虚拟滚动 / 重绘不丢） */
  function dbgSyncGutter() {
    (typeof tabs !== "undefined" ? tabs : []).forEach(t => {
      const cm = t && t.cm;
      if (!cm || typeof cm.setGutterMarker !== "function") return;
      const path = t.displayPath || t.path;
      const prev = cm._dbgBpMarked || [];
      prev.forEach(n => {
        try { cm.setGutterMarker(n - 1, "dbg-bp-col", null); } catch (_) { /* 忽略 */ }
      });
      const prevBg = cm._dbgBpLines || [];
      prevBg.forEach(n => {
        try { cm.removeLineClass(n - 1, "background", "dbg-bp-line"); } catch (_) { /* 忽略 */ }
      });
      const lines = dbgBpOf(path).filter(n => n <= cm.lineCount());
      lines.forEach(n => {
        try {
          const dot = document.createElement("div");
          dot.className = "dbg-bp-dot";
          dot.title = "断点：行 " + n;
          cm.setGutterMarker(n - 1, "dbg-bp-col", dot);
          cm.addLineClass(n - 1, "background", "dbg-bp-line");
        } catch (_) { /* 忽略 */ }
      });
      cm._dbgBpMarked = lines;
      cm._dbgBpLines = lines;
    });
  }

  /* 断点列点击：添加 / 取消断点。由 00_preamble 创建编辑器时调用。
     只认 dbg-bp-col 列，折叠箭头与行号点击不受影响 */
  function dbgBindGutter(cm) {
    if (!cm || cm._dbgGutterBound) return;
    cm._dbgGutterBound = true;
    cm.on("gutterClick", (cm2, line, gutter) => {
      if (gutter !== "dbg-bp-col") return;
      const tabsArr = (typeof tabs !== "undefined" ? tabs : []);
      const t = tabsArr.find(x => x && x.cm === cm2);
      const path = t ? (t.displayPath || t.path) : dbgCurPath();
      if (!path || getExt(path) !== "py") return;
      dbgToggleBp(line + 1, path);
    });
  }

  function dbgToggleBp(line, path) {
    path = path || dbgCurPath();
    if (!path || getExt(path) !== "py") { toast("断点仅支持 Python 文件", "warn"); return; }
    line = Number(line);
    if (!Number.isInteger(line) || line < 1) return;
    const list = dbgBpOf(path);
    const had = list.indexOf(line) >= 0;
    const next = had ? list.filter(n => n !== line) : list.concat([line]);
    if (next.length) DBG_BPS[path] = next; else delete DBG_BPS[path];
    dbgBpSave();
    dbgRenderBp();
    // 会话正在调试同一个文件：把新增 / 删除断点同步给运行中的 pdb
    if (DBG.id && !DBG.done && DBG.target === path) {
      dbgRaw(had ? "cl " + path + ":" + line : "b " + path + ":" + line);
    }
    toast((had ? "已移除断点 " : "已添加断点 ") + baseName(path) + ":" + line, "ok");
  }

  function dbgToggleBpAtCursor() {
    if (!active || !active.cm) { toast("请先打开一个 Python 文件并把光标放到目标行", "warn"); return; }
    dbgToggleBp(active.cm.getCursor().line + 1, active.displayPath || active.path);
  }

  /* ---------- 输出显示：按行解析 + 分色 ----------
     PTY 输出按 \n 切行（残尾留在 pending，(Pdb) 提示符无换行也能显示），
     每行按内容分类上背景：pdb / out / err / hint */
  function dbgClassifyLine(s) {
    const t = s.trim();
    if (!t) return "out";
    if (/^\(Pdb\+*\)/.test(t)) return "pdb";                 // 提示符与回显命令
    if (/^>+\s+\S+\(\d+\)/.test(t)) return "pdb";            // > /path/file.py(20)<module>()
    if (/^(->|--Return--|--Call--)/.test(t)) return "pdb";   // 当前行源码 / 函数返回
    if (/^Breakpoint \d+/.test(t)) return "pdb";             // 断点设置信息
    if (/^\^C/.test(t)) return "pdb";                        // Ctrl+C 中断标记
    if (t.indexOf("[提示]") === 0 || /^The program finished/.test(t)) return "hint";
    if (/^Traceback \(/.test(t) || /^\*\*\*/.test(t) || /[A-Za-z](Error|Exception):/.test(t)) return "err";
    return "out";                                            // 程序 print / 正常输出
  }
  function dbgAppend(text) {
    if (!text) return;
    DBG.pending += String(text);
    let idx;
    while ((idx = DBG.pending.indexOf("\n")) >= 0) {
      dbgPushLine(DBG.pending.slice(0, idx));
      DBG.pending = DBG.pending.slice(idx + 1);
    }
    dbgRenderLines();
  }
  function dbgPushLine(line) {
    DBG.lines.push({ cls: dbgClassifyLine(line), text: line });
    if (DBG.lines.length > DBG_MAX_LINES) DBG.lines.splice(0, DBG.lines.length - DBG_MAX_LINES);
    if (DBG.sys) dbgSysFeed(line);                           // 变量读取状态机吃同一份输出
  }
  function dbgRenderLines() {
    if (DBG.raf) return;                                     // rAF 合帧，避免高频重建
    DBG.raf = requestAnimationFrame(() => {
      DBG.raf = 0;
      const body = $("dbgBody");
      if (!body) return;
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
      // 增量渲染：只追加新增行；行数被裁剪（超上限）或刚清空过才整体重建。
      // 之前每帧 innerHTML 全量重建最多 1200 行，输出洪峰（程序狂打印 / pdb 刷屏）时
      // 主线程被持续打满，整个页面像死住一样——增量后每帧成本只与新增行数相关。
      if ((body._dbgRendered || 0) > DBG.lines.length) {
        body.innerHTML = "";
        body._dbgRendered = 0;
      }
      const frag = document.createDocumentFragment();
      for (let i = body._dbgRendered || 0; i < DBG.lines.length; i++) {
        const it = DBG.lines[i];
        const div = document.createElement("div");
        div.className = "dbg-line dbg-line-" + it.cls;
        div.textContent = it.text;
        frag.appendChild(div);
      }
      const pend = body.querySelector(".dbg-pending");       // 没换行结尾的 (Pdb) 提示符：
      if (pend) pend.remove();                               // 先撤掉上一帧的临时行再补
      if (DBG.pending) {
        const div = document.createElement("div");
        div.className = "dbg-line dbg-line-" + (DBG.pending.indexOf("(Pdb") === 0 ? "pdb" : "out") + " dbg-pending";
        div.textContent = DBG.pending;
        frag.appendChild(div);
      }
      body.appendChild(frag);
      body._dbgRendered = DBG.lines.length;
      if (nearBottom) body.scrollTop = body.scrollHeight;    // 只有本来就在底部才跟随滚动
    });
  }
  function dbgClear() {
    DBG.lines = [];
    DBG.pending = "";
    const body = $("dbgBody");
    if (body) { body.innerHTML = ""; body._dbgRendered = 0; }
  }
  function dbgSetState(text, cls) {
    const el = $("dbgState");
    if (!el) return;
    el.textContent = text;
    el.className = "dbg-state" + (cls ? " " + cls : "");
  }
  function dbgRefreshButtons() {
    const ids = ["dbgBtnCont", "dbgBtnNext", "dbgBtnStep", "dbgBtnWhere",
                 "dbgBtnVar", "dbgBtnInt", "dbgBtnStop", "dbgSendBtn"];
    ids.forEach(id => {
      const b = $(id);
      if (b) b.disabled = !!(DBG.done || !DBG.id);
    });
    const inp = $("dbgInput");
    if (inp) inp.disabled = !!(DBG.done || !DBG.id);
    const prompt = $("dbgPrompt");
    if (prompt) prompt.textContent = DBG.id && !DBG.done ? "(Pdb)" : "$";
    if (typeof bpKillMode === "function") bpKillMode();
  }

  /* ---------- 会话生命周期 ---------- */
  function dbgCloseStreams() {
    if (DBG.es) { try { DBG.es.close(); } catch (_) { /* 忽略 */ } DBG.es = null; }
    clearTimeout(DBG.timer);
    DBG.timer = null;
  }
  function dbgResetView() {
    dbgCloseStreams();
    dbgVarClose();
    dbgClear();
    DBG.id = null; DBG.target = ""; DBG.pid = 0; DBG.offset = 0;
    DBG.done = true; DBG.paused = false; DBG.finished = false; DBG.hist = []; DBG.hi = -1;
    const f = $("dbgFile"); if (f) f.textContent = "";
    dbgSetState("未启动", "");
    dbgRefreshButtons();
  }
  function dbgApply(d) {
    const incoming = (d.chunks || []).join("");
    (d.chunks || []).forEach(t => dbgAppend(t));
    if (typeof d.offset === "number") DBG.offset = d.offset;
    DBG.paused = !!d.paused;
    if (typeof d.target === "string" && d.target) DBG.target = d.target;
    if (typeof d.pid === "number") DBG.pid = d.pid;
    // python -m pdb 在脚本跑完后会「重启」回第一行继续等命令，不会自己退出：
    // 明确告诉用户此时可以查变量，也可以输入 q / 点「停止」结束会话
    if (!DBG.finished && incoming.indexOf("The program finished and will be restarted") >= 0) {
      DBG.finished = true;
      dbgAppend("\n[提示] 脚本已执行完，pdb 回到入口等待输入：可继续用 p 查看变量，输入 q 或点「停止」结束调试。\n");
    }
    const f = $("dbgFile");
    if (f && DBG.target) f.textContent = baseName(DBG.target) + (DBG.pid ? " · pid " + DBG.pid : "");
    if (!DBG.done) {
      dbgSetState(DBG.finished ? "程序已结束（等待 q）" : (DBG.paused ? "已暂停 (Pdb)" : "运行中"),
                  DBG.finished ? "pause" : (DBG.paused ? "pause" : "live"));
    }
  }
  function dbgOnDone(d) {
    if (DBG.done) return;
    DBG.done = true;
    dbgCloseStreams();
    dbgVarClose();
    dbgAppend("\n[调试会话结束 · 退出码 " + ((d && d.exit_code != null) ? d.exit_code : -1) + "]\n");
    dbgSetState("已结束", "dead");
    dbgRefreshButtons();
    try { localStorage.removeItem(DBG_SESSION_KEY); } catch (_) { /* 忽略 */ }
  }

  function dbgStream() {
    dbgCloseStreams();
    if (!DBG.id || DBG.done) return;
    if (!window.EventSource) { dbgPoll(); return; }
    let es;
    try {
      es = new EventSource("/api/debug/stream?id=" + encodeURIComponent(DBG.id) + "&offset=" + DBG.offset);
    } catch (_) { dbgPoll(); return; }
    DBG.es = es;
    es.onmessage = ev => {
      let d;
      try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (!DBG.id || d.id !== DBG.id) return;
      dbgApply(d);
      if (d.done) dbgOnDone(d);
    };
    es.onerror = () => {
      try { es.close(); } catch (_) { /* 忽略 */ }
      if (DBG.es === es) DBG.es = null;
      if (!DBG.done && DBG.id) DBG.timer = setTimeout(dbgPoll, 500);   // 断线退回轮询，不丢输出
    };
  }

  function dbgPoll() {
    if (DBG.done || !DBG.id) return;
    const id = DBG.id;
    fetch("/api/debug/log?id=" + encodeURIComponent(id) + "&offset=" + DBG.offset)
      .then(r => r.json())
      .then(d => {
        if (!DBG.id || DBG.id !== id || DBG.done) return;
        if (d.error) { dbgOnDone({ exit_code: -1 }); return; }
        dbgApply(d);
        if (d.done) { dbgOnDone(d); return; }
        DBG.timer = setTimeout(dbgPoll, 800);
      })
      .catch(() => { if (!DBG.done && DBG.id === id) DBG.timer = setTimeout(dbgPoll, 1500); });
  }

  async function dbgStart() {
    if (!active || !active.cm || active.diff) { toast("请先打开一个 Python 文件", "warn"); return; }
    const target = active.displayPath || active.path;
    if (getExt(target) !== "py") { toast("调试运行目前仅支持 .py 文件（其它语言请用 F5 运行）", "warn"); return; }
    if (active.dirty) {
      const ok = await uiConfirm("调试前保存", "文件有未保存的修改，是否先保存再调试？", "保存并调试", false);
      if (!ok) return;
      try { await saveQuiet(active); } catch (e) { toast("保存失败：" + (e.message || e), "err"); return; }
    }
    if (DBG.id && !DBG.done) {
      const ok = await uiConfirm("已有调试会话",
        "「" + baseName(DBG.target) + "」正在调试，要停止它并开始新的调试吗？", "停止并重新调试", false);
      if (!ok) return;
      await dbgStop(true);
      await new Promise(r => setTimeout(r, 350));
    }
    dbgResetView();
    toggleBottom(true, "debug");
    dbgSetState("启动中…", "");
    dbgAppend("$ python -m pdb " + target + "\n");
    try {
      const r = await fetch("/api/debug/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, args: "", breakpoints: dbgBpOf(target) }),
      });
      const d = await r.json();
      if (d.error) {
        dbgAppend("[启动失败] " + d.error + "\n");
        dbgSetState("启动失败", "dead");
        toast("调试启动失败：" + d.error, "err");
        return;
      }
      DBG.id = d.id; DBG.target = d.target || target; DBG.pid = d.pid || 0;
      DBG.done = false; DBG.offset = 0;
      try { localStorage.setItem(DBG_SESSION_KEY, JSON.stringify({ id: d.id, target: DBG.target })); } catch (_) {}
      const bps = d.breakpoints || [];
      dbgAppend(bps.length
        ? "（已注入 " + bps.length + " 个断点并 continue，命中断点后会自动停在 (Pdb)）\n\n"
        : "（已停在脚本入口；可直接单步，或先在行号左侧点击设断点再点「继续」）\n\n");
      dbgSetState("调试中", "live");
      dbgRefreshButtons();
      dbgStream();
      const inp = $("dbgInput"); if (inp) inp.focus();
    } catch (e) {
      dbgAppend("[启动失败] " + (e.message || e) + "\n");
      dbgSetState("启动失败", "dead");
      toast("调试启动失败：" + (e.message || e), "err");
    }
  }

  async function dbgRaw(command) {
    if (!DBG.id || DBG.done) return { error: "会话未启动" };
    try {
      const r = await fetch("/api/debug/input", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: DBG.id, command: command }),
      });
      return await r.json();
    } catch (e) { return { error: e.message || String(e) }; }
  }

  async function dbgSend(command) {
    const cmd = String(command == null ? "" : command).replace(/\n+$/, "");
    if (!cmd.trim()) return;
    if (!DBG.id || DBG.done) { toast("调试会话未启动，请先点「调试运行」", "warn"); return; }
    DBG.hist.push(cmd); DBG.hi = DBG.hist.length;
    const d = await dbgRaw(cmd);
    if (d && d.error) {
      dbgAppend("[命令发送失败] " + d.error + "\n");
      toast("命令发送失败：" + d.error, "err");
    }
  }

  async function dbgInterrupt() {
    if (!DBG.id || DBG.done) { toast("当前没有运行中的调试会话", "warn"); return; }
    try {
      const r = await fetch("/api/debug/interrupt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: DBG.id }),
      });
      const d = await r.json();
      if (d.error) toast("中断失败：" + d.error, "err");
      else dbgAppend("^C\n");
    } catch (e) { toast("中断失败：" + (e.message || e), "err"); }
  }

  async function dbgStop(quiet) {
    if (!DBG.id) { if (!quiet) toast("当前没有调试会话", "warn"); return; }
    const id = DBG.id;
    dbgVarClose();
    try {
      await fetch("/api/debug/stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id }),
      });
    } catch (_) { /* 忽略 */ }
    try { localStorage.removeItem(DBG_SESSION_KEY); } catch (_) {}
    if (DBG.id !== id) return;
    DBG.done = true;
    dbgCloseStreams();
    dbgAppend("\n[已手动停止调试]\n");
    dbgSetState("已结束", "dead");
    dbgRefreshButtons();
    if (!quiet) toast("已停止调试", "ok");
  }

  /* 刷新页面后接回仍在运行的会话（后端会话在内存，服务重启则需重新调试） */
  async function dbgRestore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DBG_SESSION_KEY) || "null"); } catch (_) {}
    if (!saved || !saved.id) return;
    try {
      const r = await fetch("/api/debug/log?id=" + encodeURIComponent(saved.id) + "&offset=0");
      const d = await r.json();
      if (d.error) { localStorage.removeItem(DBG_SESSION_KEY); return; }
      DBG.id = d.id; DBG.target = d.target || saved.target || "";
      DBG.pid = d.pid || 0; DBG.offset = 0; DBG.done = !!d.done; DBG.finished = false;
      dbgClear();
      dbgApply(d);
      if (DBG.done) { dbgOnDone(d); }
      else { dbgRefreshButtons(); dbgStream(); }
    } catch (_) { /* 服务刚重启 / 网络异常：忽略，用户重新点调试即可 */ }
  }

  /* 切到「调试」页签时聚焦输入框；由 setBottomPane 调用 */
  function dbgOnShow() {
    const inp = $("dbgInput");
    if (inp && !inp.disabled) inp.focus();
  }

  /* ---------- 变量查看弹层 ----------
     通过 pdb 命令读取：列表用 p "|".join(locals+globals 的键)，内容用 pp 变量名。
     dbgSys* 是一个小状态机：跳过回显行，收集结果行，遇到下一个 (Pdb) 提示符
     （或 800ms 静默）认为结束。原始输出照常显示在调试输出区。 */
  function dbgVarStatus(msg) {
    const list = $("dbgVarList");
    if (list) list.innerHTML = '<span class="dbg-var-empty">' + esc(msg) + "</span>";
  }
  function dbgVarSetView(msg) {
    const v = $("dbgVarView");
    if (v) v.textContent = msg;
  }
  function dbgVarClose() {
    const pop = $("dbgVarPop");
    if (pop) pop.style.display = "none";
    if (DBG.sys) { clearTimeout(DBG.sys.t); DBG.sys = null; }
  }
  function dbgSysArm() {
    if (!DBG.sys) return;
    clearTimeout(DBG.sys.t);
    DBG.sys.t = setTimeout(dbgSysFinish, 800);   // 输出静默即认为收集完成
  }
  function dbgSysStart(kind, cmd, name) {
    if (DBG.sys) clearTimeout(DBG.sys.t);
    DBG.sys = { kind: kind, name: name || "", buf: "", echoDone: false, t: 0 };
    dbgSysArm();
    dbgRaw(cmd);
  }
  function dbgSysFeed(line) {
    const s = DBG.sys;
    if (!s) return;
    const t = line.trim();
    if (!s.echoDone) {                            // 第一行 (Pdb) 是命令回显，跳过
      if (/^\(Pdb\+*\)/.test(t)) s.echoDone = true;
      return;
    }
    if (/^\(Pdb\+*\)/.test(t)) { dbgSysFinish(); return; }   // 提示符再现：收集结束
    if (s.kind === "vars" || s.kind === "types") s.buf += line;
    else s.buf += line + "\n";
    dbgSysArm();
  }
  function dbgSysFinish() {
    const s = DBG.sys;
    if (!s) return;
    clearTimeout(s.t);
    DBG.sys = null;
    if (s.kind === "vars" || s.kind === "types") {
      const list = $("dbgVarList");
      if (!list) return;
      const raw = s.buf.trim();
      // p 命令输出形如 {'x': 'int', 'items': 'list'}（repr 字典），按 "键: 类型名" 解析
      const re = /'((?:[^'\\]|\\.)+)':\s*'([A-Za-z_][\w.]*)'/g;
      const vars = [];
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m[1] && !/^__/.test(m[1])) vars.push({ name: m[1], type: m[2] });
      }
      if (!vars.length) {
        dbgVarStatus("未读取到变量：可能程序未暂停在 (Pdb)，或当前作用域为空");
        return;
      }
      vars.sort((a, b) => ((a.name[0] === "_" ? 1 : 0) - (b.name[0] === "_" ? 1 : 0)) || a.name.localeCompare(b.name));
      // 按数据类型分组展示
      const GROUPS = [
        ["数组 / 元组 / 集合", t => /^(list|tuple|set|frozenset|range)$/.test(t), "t-coll"],
        ["字典", t => t === "dict", "t-dict"],
        ["方法 / 函数 / 类", t => /function|method|type|class/.test(t), "t-func"],
        ["字符串", t => t === "str", "t-str"],
        ["数字", t => /^(int|float|complex|decimal\.Decimal)$/.test(t), "t-num"],
        ["布尔 / 空值", t => /^(bool|NoneType)$/.test(t), "t-bool"],
      ];
      const groups = new Map();
      vars.forEach(v => {
        let g = null;
        for (let i = 0; i < GROUPS.length; i++) {
          if (GROUPS[i][1](v.type)) { g = { label: GROUPS[i][0], cls: GROUPS[i][2] }; break; }
        }
        if (!g) g = { label: "其它对象", cls: "t-obj" };
        if (!groups.has(g.label)) groups.set(g.label, { cls: g.cls, items: [] });
        groups.get(g.label).items.push(v);
      });
      list.innerHTML = "";
      groups.forEach((g, label) => {
        const head = document.createElement("div");
        head.className = "dbg-var-group " + g.cls;
        head.innerHTML = '<i class="bi bi-collection"></i>' + esc(label) +
          '<span class="dbg-var-gcnt">' + g.items.length + "</span>";
        list.appendChild(head);
        const wrap = document.createElement("div");
        wrap.className = "dbg-var-chips";
        g.items.forEach(v => {
          const chip = document.createElement("button");
          chip.className = "dbg-var-chip " + g.cls;
          chip.title = v.name + " : " + v.type + "（点击查看内容，pdb 的 pp 命令）";
          chip.innerHTML = esc(v.name) + '<span class="dbg-var-type">' + esc(v.type) + "</span>";
          chip.onclick = () => dbgInspect(v.name);
          wrap.appendChild(chip);
        });
        list.appendChild(wrap);
      });
    } else {
      const view = $("dbgVarView");
      if (view) view.textContent = s.name + " = " + (s.buf.replace(/\n+$/, "") || "（无输出）");
    }
  }
  function dbgVarsToggle() {
    const pop = $("dbgVarPop");
    if (!pop) return;
    if (pop.style.display === "block") { dbgVarClose(); return; }
    if (!DBG.id || DBG.done) { toast("调试会话未启动，请先点「调试运行」", "warn"); return; }
    pop.style.display = "block";
    dbgVarSetView("");
    dbgVarStatus(DBG.paused
      ? "正在读取当前作用域变量…"
      : "程序运行中：读取命令已排队，将在下次暂停 (Pdb) 时返回…");
    dbgSysStart("types", 'p {k: type(v).__name__ for k, v in dict(list(globals().items()) + list(locals().items())).items()}');
  }
  function dbgInspect(name) {
    if (!DBG.id || DBG.done) { toast("调试会话已结束", "warn"); return; }
    dbgVarSetView("读取 " + name + " …");
    dbgSysStart("inspect", "pp " + name, name);
  }

  /* ---------- 事件绑定 ---------- */
  /* 弹层拖动：按住标题栏拖到任意位置（缩放用右下角原生 resize 柄，见 62_ CSS） */
  function dbgVarDragInit() {
    const pop = $("dbgVarPop");
    const head = pop && pop.querySelector(".dbg-var-head");
    if (!pop || !head || head._dbgDrag) return;
    head._dbgDrag = true;
    head.addEventListener("mousedown", e => {
      if (e.target.closest("button")) return;            // 点「关闭」等按钮不触发拖动
      if (pop.style.display !== "block") return;
      const pane = $("paneDebug") || document.body;
      const pr = pane.getBoundingClientRect();
      const r = pop.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = ev => {
        let x = ev.clientX - pr.left - ox, y = ev.clientY - pr.top - oy;
        x = Math.max(0, Math.min(x, pr.width - 80));
        y = Math.max(0, Math.min(y, pr.height - 40));
        pop.style.left = x + "px";
        pop.style.top = y + "px";
        pop.style.bottom = "auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
  }
  dbgVarDragInit();

  if ($("runPanelDebug")) $("runPanelDebug").onclick = () => dbgStart();
  if ($("dbgBpAdd")) $("dbgBpAdd").onclick = () => dbgToggleBpAtCursor();
  if ($("dbgBpClear")) $("dbgBpClear").onclick = () => {
    const path = dbgCurPath();
    const lines = dbgBpOf(path);
    if (!lines.length) { toast("当前文件没有断点", "warn"); return; }
    delete DBG_BPS[path];
    dbgBpSave(); dbgRenderBp();
    if (DBG.id && !DBG.done && DBG.target === path) {
      lines.forEach(n => dbgRaw("cl " + path + ":" + n));
    }
    toast("已清空 " + baseName(path) + " 的断点", "ok");
  };

  const DBG_CMDS = [
    ["dbgBtnCont", "c"], ["dbgBtnNext", "n"], ["dbgBtnStep", "s"], ["dbgBtnWhere", "w"],
  ];
  DBG_CMDS.forEach(pair => {
    const b = $(pair[0]);
    if (b) b.onclick = () => dbgSend(pair[1]);
  });
  if ($("dbgBtnVar")) $("dbgBtnVar").onclick = () => dbgVarsToggle();
  if ($("dbgBtnBp")) $("dbgBtnBp").onclick = () => dbgToggleBpAtCursor();
  if ($("dbgBtnInt")) $("dbgBtnInt").onclick = () => dbgInterrupt();
  if ($("dbgBtnStop")) $("dbgBtnStop").onclick = () => dbgStop();
  if ($("dbgBtnClear")) $("dbgBtnClear").onclick = () => dbgClear();
  if ($("dbgSendBtn")) $("dbgSendBtn").onclick = () => {
    const inp = $("dbgInput");
    if (!inp || inp.disabled) return;
    const v = inp.value; inp.value = "";
    dbgSend(v);
  };
  if ($("dbgVarClose")) $("dbgVarClose").onclick = () => dbgVarClose();

  if ($("dbgInput")) $("dbgInput").addEventListener("keydown", e => {
    const inp = e.target;
    if (e.key === "Enter") {
      e.preventDefault();
      const v = inp.value; inp.value = "";
      dbgSend(v);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!DBG.hist.length) return;
      DBG.hi = Math.max(0, (DBG.hi === -1 ? DBG.hist.length : DBG.hi) - 1);
      inp.value = DBG.hist[DBG.hi] || "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!DBG.hist.length) return;
      DBG.hi = Math.min(DBG.hist.length, DBG.hi + 1);
      inp.value = DBG.hist[DBG.hi] || "";
    } else if (e.key === "Escape") {
      const pop = $("dbgVarPop");
      if (pop && pop.style.display === "block") dbgVarClose();
    } else if (e.key.toLowerCase() === "c" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      dbgInterrupt();
    } else if (e.key.toLowerCase() === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      dbgClear();
    }
  });

  /* 切换 / 打开文件后重画断点红点与列表 */
  if (window.IDE && IDE.events && typeof IDE.events.on === "function") {
    IDE.events.on("activeTabChanged", () => dbgRenderBp());
    IDE.events.on("fileOpened", () => dbgSyncGutter());
    IDE.events.on("sessionRestored", () => dbgRenderBp());
  }

  dbgRenderBp();
  dbgRefreshButtons();
  dbgRestore();
