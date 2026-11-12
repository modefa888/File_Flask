  /* ==================================================================
     调试运行（pdb）：交互式调试当前 Python 文件

     与普通运行（F5）的区别：
     - 后端把 python -m pdb 接到 PTY，输出经 SSE 增量推到「调试」页签；
     - 输出按行渲染并分色：pdb 调试输出 / 程序输出 / 错误 / 操作提示
       各用不同背景（dbgClassifyLine 分类，见 62_ CSS）；
     - 输入框 / 工具按钮把 n / s / c / r / p / b / q 等命令写回 PTY；
     - 断点按文件保存在浏览器本地：行号本身即断点列（仿 VS Code）——悬停行号出现幽灵红点，
       点击行号即添加 / 再点取消（dbgBindGutter 只认 CodeMirror-linenumbers 列），
       F9 / 侧栏按钮也可操作；启动时自动把断点注入 pdb；
     - 「变量」按钮弹层：读取当前作用域变量列表（locals+globals），
       点击某个变量用 pdb 的 pp 命令查看内容（dbgSys* 状态机解析回显）。

     放在 16_（关闭大 IIFE）之前，复用闭包内的 $ / ROOT / active / tabs /
     toast / esc / uiPrompt / uiConfirm / saveQuiet / getExt / baseName /
     toggleBottom / setBottomPane / bpKillMode 等。
     ================================================================== */
  const DBG_BP_KEY = "ide.debug.breakpoints." + ((typeof ROOT !== "undefined" && ROOT) ? ROOT : location.pathname);
  const DBG_SESSION_KEY = "ide.debug.session";
  const DBG_DETAILS_KEY = "ide.debug.showPdbDetails";
  const DBG_MAX_LINES = 1200;                          // 输出区保留的行数上限
  /* pdb 协议细节（定位行 / 源码行 / 命令回显 / (Pdb) 提示符）默认隐藏，工具栏「细节」可切换 */
  let DBG_SHOW_DETAILS = false;
  try { DBG_SHOW_DETAILS = localStorage.getItem(DBG_DETAILS_KEY) === "1"; } catch (_) { /* 忽略 */ }
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
        empty.textContent = "暂无断点。点击编辑器行号即可添加（再点取消），或按 F9。";
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
    // 断点增删 / 切标签都会走这里：行内 ▶ 与悬浮按钮的「调试运行」态跟着刷新
    if (typeof redrawRunButtons === "function") redrawRunButtons();
  }

  /* 行号槽红点：断点直接画在行号位置（仿 VS Code，不占独立列）——
     addLineClass(n, "gutter", "dbg-bp-gutter") 只给该行的行号槽包装层加类，
     CSS（62_调试运行面板.css）据此隐藏行号文字、用 ::before 画红点；
     整行淡红背景用 addLineClass background（跟行走，虚拟滚动 / 重绘不丢）。
     仅 py 文件挂 dbg-bp-avail：控制行号 pointer 光标与悬停幽灵红点 */
  function dbgSyncGutter() {
    (typeof tabs !== "undefined" ? tabs : []).forEach(t => {
      const cm = t && t.cm;
      if (!cm || typeof cm.addLineClass !== "function") return;
      const path = t.displayPath || t.path;
      const prevGt = cm._dbgBpGutters || [];
      prevGt.forEach(n => {
        try { cm.removeLineClass(n - 1, "gutter", "dbg-bp-gutter"); } catch (_) { /* 忽略 */ }
      });
      const prevBg = cm._dbgBpLines || [];
      prevBg.forEach(n => {
        try { cm.removeLineClass(n - 1, "background", "dbg-bp-line"); } catch (_) { /* 忽略 */ }
      });
      const lines = dbgBpOf(path).filter(n => n <= cm.lineCount());
      lines.forEach(n => {
        try { cm.addLineClass(n - 1, "gutter", "dbg-bp-gutter"); } catch (_) { /* 忽略 */ }
      });
      cm._dbgBpGutters = lines;
      cm._dbgBpLines = lines;
      try {
        cm.getWrapperElement().classList.toggle("dbg-bp-avail", getExt(path) === "py");
      } catch (_) { /* 忽略 */ }
    });
  }

  /* 行号点击：添加 / 取消断点。由 00_preamble 创建编辑器时调用。
     只认行号列（CodeMirror-linenumbers）；折叠箭头有自己的 mousedown 处理，不受影响。
     仅 py 文件生效（非 py 直接 return；行号上也没有 pointer / 幽灵点，见 dbgSyncGutter） */
  function dbgBindGutter(cm) {
    if (!cm || cm._dbgGutterBound) return;
    cm._dbgGutterBound = true;
    cm.on("gutterClick", (cm2, line, gutter) => {
      if (gutter !== "CodeMirror-linenumbers") return;
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
    if (t.indexOf("[提示]") === 0 || /^The program (finished|exited via sys\.exit)/.test(t)) return "hint";
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
    // pdb 停在某个位置会输出 "> 路径(行号)函数()"：据此让编辑器跳到该行并高亮
    const loc = /^>+\s+(\S+)\((\d+)\)/.exec(line);
    if (loc) dbgCurShow(loc[1], Number(loc[2]));
  }

  /* pdb 停驻行定位：解析出「文件 + 行号」后，在目标文件的编辑器里
     加 dbg-cur-line 琥珀黄背景（区别于断点淡红）并滚动到可视区。
     用行句柄记录位置——调试期间用户编辑代码行号漂移也能准确清掉。
     pdb 打印的是绝对路径，DBG.target 是工作区相对路径：按文件名匹配；
     新停驻自动清掉上一处；会话结束 / 重置时清除（dbgOnDone / dbgResetView）。 */
  let DBG_CUR = null;                                        // { cm, handle } 当前定位
  function dbgCurClear() {
    if (!DBG_CUR) return;
    try {
      const n = DBG_CUR.cm.getLineNumber(DBG_CUR.handle);
      if (n != null) DBG_CUR.cm.removeLineClass(n, "background", "dbg-cur-line");
    } catch (_) { /* 忽略 */ }
    DBG_CUR = null;
  }
  function dbgCurShow(absPath, lineNo) {
    // 程序已结束（pdb 只在入口等待）后不再点亮：重启位置没有调试意义
    if (!DBG.id || DBG.done || DBG.finished || !absPath) return;
    if (baseName(absPath) !== baseName(DBG.target)) return;  // u/d 切帧时可能是其它文件
    const tabsArr = (typeof tabs !== "undefined" ? tabs : []);
    const t = tabsArr.find(x => x && x.cm && (x.displayPath || x.path) === DBG.target)
           || tabsArr.find(x => x && x.cm && baseName(x.displayPath || x.path) === baseName(DBG.target));
    if (!t || !t.cm || typeof t.cm.addLineClass !== "function") return;
    const cm = t.cm;
    if (!(lineNo >= 1) || lineNo > cm.lineCount()) return;
    dbgCurClear();
    try {
      const handle = cm.getLineHandle(lineNo - 1);
      cm.addLineClass(lineNo - 1, "background", "dbg-cur-line");
      DBG_CUR = { cm, handle };
      cm.scrollIntoView({ line: lineNo - 1, ch: 0 }, 80);    // 自动跳到当前停驻行
    } catch (_) { /* 忽略 */ }
  }
  /* pdb 协议噪音行（定位 / 源码 / 命令回显 / (Pdb) 提示符）默认不渲染——
     只显示程序输出、变量结果、报错和提示。^C 中断标记保留（它是状态信号）。
     过滤在渲染层做：缓冲区仍存全量原文，「细节」开关切换后整体重绘即可，
     行号跳转解析（dbgPushLine）也不受影响。 */
  function dbgIsNoise(it) {
    return !DBG_SHOW_DETAILS && it.cls === "pdb" && !/^\^C/.test(it.text);
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
        if (dbgIsNoise(it)) continue;                        // 默认隐藏 pdb 协议细节
        const div = document.createElement("div");
        div.className = "dbg-line dbg-line-" + it.cls;
        div.textContent = it.text;
        frag.appendChild(div);
      }
      const pend = body.querySelector(".dbg-pending");       // 没换行结尾的 (Pdb) 提示符：
      if (pend) pend.remove();                               // 先撤掉上一帧的临时行再补
      if (DBG.pending) {
        const pendCls = DBG.pending.indexOf("(Pdb") === 0 ? "pdb" : "out";
        if (!dbgIsNoise({ cls: pendCls, text: DBG.pending })) {
          const div = document.createElement("div");
          div.className = "dbg-line dbg-line-" + pendCls + " dbg-pending";
          div.textContent = DBG.pending;
          frag.appendChild(div);
        }
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
    // 调试状态变化（启动中 / 调试中 / 已结束 / 启动失败）→ 行内 ▶ 与悬浮按钮的
    // 「调试中」样式跟着变（实现见 01_ 运行按钮模块）
    if (typeof redrawRunButtons === "function") redrawRunButtons();
  }
  function dbgRefreshButtons() {
    const ids = ["dbgBtnCont", "dbgBtnNext", "dbgBtnStep", "dbgBtnWhere",
                 "dbgBtnVar", "dbgBtnInt", "dbgBtnStop", "dbgSendBtn"];
    const dead = !!(DBG.done || !DBG.id);
    // 程序执行完毕（pdb 回到入口等待）：禁用「继续 c」——此时按 c 只会把整个
    // 脚本从头再跑一遍，设了断点的文件会陷入循环执行；查变量 / 单步 / 停止仍可用
    const finished = !!(DBG.finished && !DBG.done);
    ids.forEach(id => {
      const b = $(id);
      if (!b) return;
      b.disabled = dead || (finished && id === "dbgBtnCont");
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
    if (DBG.autoStopTimer) { clearTimeout(DBG.autoStopTimer); DBG.autoStopTimer = null; }
    dbgCloseStreams();
    dbgVarClose();
    dbgCurClear();                                           // 清掉上一会话的停驻行高亮
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
    // python -m pdb 在脚本跑完后会「重启」回第一行继续等命令，不会自己退出，
    // 结束消息有两种（Lib/pdb.py）：正常结束 finished / sys.exit 退出 exited via sys.exit()。
    // 两种都要按「已结束」处理——否则「继续」按钮不禁用，按 c 就会从头循环再跑
    if (!DBG.finished && /The program (finished|exited via sys\.exit)/.test(incoming)) {
      DBG.finished = true;
      dbgCurClear();         // 程序结束：pdb 重启停在入口，停驻行高亮没有调试意义，撤掉
      dbgRefreshButtons();   // 立即禁用「继续」：程序跑完后按 c 只会从头循环再跑
      dbgAppend("\n[提示] 脚本已执行完，本次调试将自动结束（断点已保留，可再次点「调试运行」重跑）。\n");
      // 自动结束：程序跑完后 pdb 只会在入口空等，继续调试没有意义——短暂延时
      // 等尾部输出（重启位置 / (Pdb) 提示符）落盘后，自动停止整个调试会话
      if (DBG.autoStopTimer) clearTimeout(DBG.autoStopTimer);
      DBG.autoStopTimer = setTimeout(() => {
        DBG.autoStopTimer = null;
        if (DBG.id && !DBG.done && DBG.finished) dbgStop(true, true);
      }, 800);
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
    if (DBG.autoStopTimer) { clearTimeout(DBG.autoStopTimer); DBG.autoStopTimer = null; }
    dbgCloseStreams();
    dbgVarClose();
    dbgCurClear();                                           // 会话结束：撤掉停驻行高亮
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
        : "（已停在脚本入口；可直接单步，或先点击行号设断点再点「继续」）\n\n");
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

  async function dbgStop(quiet, auto) {
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
    if (DBG.autoStopTimer) { clearTimeout(DBG.autoStopTimer); DBG.autoStopTimer = null; }
    DBG.done = true;
    dbgCloseStreams();
    dbgCurClear();                                       // 保险：停驻行高亮一并撤掉
    dbgAppend(auto ? "\n[脚本已执行完，调试会话已自动结束]\n" : "\n[已手动停止调试]\n");
    dbgSetState(auto ? "已自动结束" : "已结束", "dead");
    dbgRefreshButtons();
    if (!quiet && !auto) toast("已停止调试", "ok");
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
  /* 「细节」开关：默认隐藏 pdb 协议噪音（定位 / 源码 / 命令回显 / (Pdb) 提示符），
     只看程序输出、变量结果、报错与提示。偏好写入 localStorage，切换后整体重绘 */
  if ($("dbgBtnDetails")) {
    const btnDetails = $("dbgBtnDetails");
    const syncDetailsBtn = () => {
      btnDetails.classList.toggle("active", DBG_SHOW_DETAILS);
      btnDetails.innerHTML = '<i class="bi ' + (DBG_SHOW_DETAILS ? "bi-eye" : "bi-eye-slash") + '"></i> 细节';
      btnDetails.title = DBG_SHOW_DETAILS
        ? "隐藏 pdb 协议细节（定位行 / 源码行 / 命令回显 / (Pdb) 提示符），只看程序输出与结果"
        : "显示 pdb 协议细节（定位行 / 源码行 / 命令回显 / (Pdb) 提示符）";
    };
    syncDetailsBtn();
    btnDetails.onclick = () => {
      DBG_SHOW_DETAILS = !DBG_SHOW_DETAILS;
      try { localStorage.setItem(DBG_DETAILS_KEY, DBG_SHOW_DETAILS ? "1" : "0"); } catch (_) { /* 忽略 */ }
      syncDetailsBtn();
      const body = $("dbgBody");
      if (body) { body.innerHTML = ""; body._dbgRendered = 0; }
      dbgRenderLines();
    };
  }
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
