  /* ==================================================================
     内置终端（命令模式）：cd 可持久化，支持历史、终止、清屏
     ================================================================== */
  /* ---------- 多终端会话：默认不显示，菜单「新建终端」时才创建，最多 6 个 ---------- */
  const TERMS = [];                 // 会话对象：{ sid, name, cwd, user, host, home, hist, hi, busy, el, body }
  let curTerm = null;               // 当前选中的会话
  const TERM_MAX = 6;

  function termBodyOf(s) { return s.body; }

  // 追加输出：写到指定会话的 body（省略时写当前会话）
  function termAppendTo(s, text, cls) {
    if (!s || !s.body) return;
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    s.body.appendChild(span);
    s.body.scrollTop = s.body.scrollHeight;
  }

  // 解析 ANSI SGR 序列 → 带颜色 class 的片段（其它控制序列直接丢弃）
  function applySgr(n, cls) {
    const clearFg = (a, b) => { for (let i = a; i <= b; i++) cls.delete("t-fg" + i); };
    const clearBg = (a, b) => { for (let i = a; i <= b; i++) cls.delete("t-bg" + i); };
    if (n === 0) cls.clear();
    else if (n === 1) cls.add("t-bold");
    else if (n === 2) cls.add("t-dim");
    else if (n === 22) { cls.delete("t-bold"); cls.delete("t-dim"); }
    else if (n >= 30 && n <= 37) { clearFg(30, 37); cls.add("t-fg" + n); }
    else if (n >= 90 && n <= 97) { clearFg(90, 97); cls.add("t-fg" + n); }
    else if (n === 39) { clearFg(30, 37); clearFg(90, 97); }
    else if (n >= 40 && n <= 47) { clearBg(40, 47); cls.add("t-bg" + n); }
    else if (n === 49) clearBg(40, 47);
    // 38;5;x / 48;2;r;g;b 等复杂色：忽略，保持默认色
  }
  function ansiSegments(text) {
    const clean = String(text || "")
      .replace(/\x1b\][^\x07]*\x07/g, "")              // OSC
      .replace(/\x1b\[[0-9;?]*[a-ln-zA-LN-Z]/g, "");   // 非 SGR 控制序列
    const parts = clean.split(/\x1b\[([0-9;]*)m/);
    const out = [];
    const cls = new Set();
    for (let i = 0; i < parts.length; i += 2) {
      const seg = (parts[i] || "").replace(/\r/g, "");
      if (seg) out.push({ text: seg, cls: Array.from(cls) });
      const code = parts[i + 1];
      if (code !== undefined) {
        const nums = code.split(";").filter(x => x !== "").map(Number);
        (nums.length ? nums : [0]).forEach(n => applySgr(n, cls));
      }
    }
    return out;
  }
  function termAppendAnsi(text, s) {
    s = s || curTerm;
    if (!s) return;
    ansiSegments(text).forEach(seg => {
      const span = document.createElement("span");
      if (seg.cls.length) span.className = seg.cls.join(" ");
      span.textContent = seg.text;
      s.body.appendChild(span);
    });
    s.body.scrollTop = s.body.scrollHeight;
  }
  function termAppendHtml(html, s) {
    s = s || curTerm;
    if (!s) return;
    const span = document.createElement("span");
    span.innerHTML = html;
    s.body.appendChild(span);
    s.body.scrollTop = s.body.scrollHeight;
  }
  function termAppend(text, cls, s) { termAppendTo(s || curTerm, text, cls); }

  // 提示符路径：家目录显示为 ~，过长时中间折叠
  function termPathLabel(s) {
    s = s || curTerm || {};
    let p = s.cwd || ROOT || "";
    if (s.home) {
      if (p === s.home) p = "~";
      else if (p.startsWith(s.home + "/")) p = "~" + p.slice(s.home.length);
    }
    if (p.length > 46) {
      const segs = p.split("/").filter(Boolean);
      if (segs.length > 3) p = (p.startsWith("/") ? "/" : "") + segs[0] + "/…/" + segs.slice(-2).join("/");
    }
    return p || "~";
  }
  function termPromptHtml(s) {
    s = s || curTerm || {};
    return '<span class="tp-user">' + esc((s.user || "user") + "@" + (s.host || "localhost")) + "</span>:" +
           '<span class="tp-path">' + esc(termPathLabel(s)) + "</span>" +
           '<span class="tp-sign">$</span>';
  }
  function termPrompt() { $("termPrompt").innerHTML = termPromptHtml(); }

  /* ---------- 会话管理：新建 / 切换 / 关闭 ---------- */
  function termNew() {
    if (TERMS.length >= TERM_MAX) { toast("最多同时打开 " + TERM_MAX + " 个终端", "warn"); return Promise.resolve(null); }
    return fetch("/api/term/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: ROOT, scope: ROOT }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { toast("无法打开终端：" + d.error, "err"); return null; }
        const s = {
          sid: d.id, cwd: d.cwd, user: d.user || "user", host: d.host || "localhost",
          home: d.home || "", hist: [], hi: -1, busy: false, el: null, body: null,
        };
        // body：每个会话独立的输出区
        const body = document.createElement("pre");
        body.className = "term-body scroll-thin";
        body.style.display = "none";
        $("termBodies").appendChild(body);
        s.body = body;
        // 标签：bash / bash·2 / bash·3 …
        const n = TERMS.length + 1;
        s.name = n === 1 ? "bash" : "bash·" + n;
        const el = document.createElement("button");
        el.className = "bp-tab bp-term-tab";
        el.dataset.term = s.sid;
        el.title = "终端 " + s.name + "（点 × 关闭此终端）";
        el.innerHTML = '<span class="lt-nm">' + esc(s.name) + '</span><span class="lt-x"><i class="bi bi-x"></i></span>';
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (e.target.closest(".lt-x")) { closeTerm(s); return; }
          selectTerm(s);
        });
        $("bpTermTabs").appendChild(el);
        s.el = el;
        $("bpTermTabs").style.display = "";
        TERMS.push(s);
        termAppendTo(s, "内置终端（命令模式）· " + d.cwd + "\n" +
        "支持 git / npm / ls 等命令；cd 会保持目录；Ctrl+C 终止当前命令，Ctrl+L 清屏。\n" +
        "（不支持 vim、top 等需要 TTY 的全屏程序）\n" +
        (d.scope ? "操作范围：" + d.scope + "（仅允许在此目录下执行文件操作，越界路径会被拦截）\n" : "") +
        "安全策略：危险命令自动拦截，高风险命令执行前二次确认（终端菜单 → 命令安全策略）。\n\n", "term-dim");
        selectTerm(s);
        toggleBottom(true, "term");
        $("termInput").focus();
        return s;
      })
      .catch(e => { toast("无法打开终端：" + (e.message || e), "err"); return null; });
  }

  function selectTerm(s) {
    curTerm = s;
    TERMS.forEach(t => {
      t.body.style.display = (t === s) ? "" : "none";
      t.el.classList.toggle("active", t === s);
    });
    setBottomPane("term");
    termPrompt();
    if (s && s.body) s.body.scrollTop = s.body.scrollHeight;
  }

  function closeTerm(s) {
    const i = TERMS.indexOf(s);
    if (i < 0) return;
    fetch("/api/term/kill", {                                   // 顺带结束该会话正在执行的命令
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.sid }),
    }).catch(() => {});
    s.el.remove(); s.body.remove();
    TERMS.splice(i, 1);
    if (curTerm === s) {
      curTerm = null;
      if (TERMS.length) selectTerm(TERMS[Math.min(i, TERMS.length - 1)]);
      else { setBottomPane("output"); $("bpTermTabs").style.display = "none"; }
    }
  }

  // 兼容旧调用：确保当前有会话（没有就新建一个）
  function termEnsure() {
    if (curTerm) return Promise.resolve(true);
    return termNew().then(s => !!s);
  }

  async function termRun(cmd) {
    const line = String(cmd || "").replace(/\n+$/, "");
    if (!line.trim()) return;
    if (line.trim() === "clear" || line.trim() === "cls") { if (curTerm) curTerm.body.innerHTML = ""; return; }
    if (curTerm && curTerm.busy) { toast("该终端已有命令正在执行，请稍候（可点“终止”）", "warn"); return; }
    if (!(await termEnsure()) || !curTerm) return;
    const T = curTerm;                                        // 会话可能在等待期间被切换/关闭

    // 危险命令防护（第一层）：执行前先让服务端校验，高风险命令需用户确认
    let force = false;
    try {
      const cr = await fetch("/api/term/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: line }),
      });
      const v = await cr.json();
      if (v.level === "blocked") {
        termAppendHtml('<span class="term-err">⛔ 已拦截：' + esc(v.reason) + "</span>\n");
        termAppend("（规则可在 config.py 的 EXEC_BLOCK_PATTERNS 中调整；终端菜单 → 命令安全策略）\n", "term-dim");
        toast("已拦截危险命令：" + v.reason, "err");
        return;
      }
      if (v.level === "confirm") {
        const ok = await uiConfirm("执行高风险命令",
          "命令：\n" + line + "\n\n风险：" + v.reason + "\n\n确定要继续执行吗？", "仍然执行", true);
        if (!ok) { termAppend("（已取消执行）\n", "term-dim"); return; }
        force = true;
      }
    } catch (_) { /* 校验接口异常时不阻断，仍有服务端强制校验兜底 */ }

    T.hist.push(line); T.hi = T.hist.length;
    termAppendHtml(termPromptHtml(T) + ' <span class="term-cmd">' + esc(line) + "</span>\n", T);
    T.busy = true;
    try {
      const r = await fetch("/api/term/exec", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: T.sid, command: line, force: force }),
      });
      const d = await r.json();
      if (d.blocked) {                       // 服务端兜底拦截
        termAppendHtml('<span class="term-err">⛔ 已拦截：' + esc(d.reason || d.error) + "</span>\n");
        toast("已拦截危险命令：" + (d.reason || ""), "err");
        return;
      }
      if (d.need_confirm) {
        termAppend("（该命令需要确认后才能执行，已取消）\n", "term-dim");
        toast("已取消执行", "warn");
        return;
      }
      if (d.error && String(d.error).indexOf("会话") >= 0) { /* 会话失效：提示重建 */ }
      if (d.stdout) { termAppendAnsi(d.stdout, T); termAppend("\n", "", T); }
      if (d.stderr) {
        // 带颜色的 stderr（如 ls 报错）按原色渲染，纯文本 stderr 用红色
        if (/\x1b\[/.test(d.stderr)) { termAppendAnsi(d.stderr, T); termAppend("\n", "", T); }
        else termAppend(d.stderr + "\n", "term-err", T);
      }
      if (d.error) termAppend("✘ " + d.error + "\n", "term-err", T);
      else if (d.exit_code) termAppend("（退出码 " + d.exit_code + " · 用时 " + d.duration + "s）\n", "term-dim", T);
      if (d.cwd) { T.cwd = d.cwd; termPrompt(); }
    } catch (e) {
      termAppend("✘ " + (e.message || e) + "\n", "term-err", T);
    } finally {
      T.busy = false;
    }
  }

  async function showTermRules() {
    try {
      const r = await fetch("/api/term/rules");
      const d = await r.json();
      if (!d.enabled) {
        uiAlert("命令安全策略",
          "当前已关闭命令安全校验（config.EXEC_ENFORCE_SAFETY = False）。\n终端命令不会被拦截，请谨慎操作。");
        return;
      }
      const col = (arr) =>
        '<ul class="rule-list">' + (arr.length ? arr.map(x => "<li>" + esc(x) + "</li>").join("") : "<li>无</li>") + "</ul>";
      const html =
        '<div class="rule-block"><div class="rule-head">⛔ 直接拦截（不会执行）</div>' + col(d.blocked || []) + "</div>" +
        '<div class="rule-block"><div class="rule-head">⚠ 需要二次确认</div>' + col(d.confirm || []) + "</div>" +
        '<div class="rule-note">规则可在 config.py 的 EXEC_BLOCK_PATTERNS / EXEC_CONFIRM_PATTERNS 中自行增删。</div>';
      uiModal({ title: "命令安全策略", icon: "bi-shield-check", html, wide: true, hideCancel: true, okText: "知道了" });
    } catch (e) {
      toast("获取安全策略失败：" + (e.message || e), "err");
    }
  }

  async function termKill() {
    if (!curTerm) { toast("终端未启动", "warn"); return; }
    try {
      const r = await fetch("/api/term/kill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: curTerm.sid }),
      });
      const d = await r.json();
      termAppend(d.killed ? "^C 已终止当前命令\n" : "（当前没有正在执行的命令）\n", "term-dim");
    } catch (e) { /* 忽略 */ }
  }

  async function runSelectionInTerminal() {
    if (!active || !active.cm || active.diff) { toast("请先打开一个文件", "warn"); return; }
    const sel = active.cm.getSelection();
    if (!sel || !sel.trim()) { toast("请先在编辑器中选中要运行的文本", "warn"); return; }
    await termEnsure();
    termRun(sel.replace(/\s*\n\s*/g, " ").trim());
  }

  $("termInput").addEventListener("keydown", (e) => {
    const input = e.target;
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value;
      input.value = "";
      termRun(v);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!curTerm || !curTerm.hist.length) return;
      curTerm.hi = Math.max(0, (curTerm.hi === -1 ? curTerm.hist.length : curTerm.hi) - 1);
      input.value = curTerm.hist[curTerm.hi] || "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!curTerm || !curTerm.hist.length) return;
      curTerm.hi = Math.min(curTerm.hist.length, curTerm.hi + 1);
      input.value = curTerm.hist[curTerm.hi] || "";
    } else if (e.key.toLowerCase() === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (curTerm) curTerm.body.innerHTML = "";
    } else if (e.key.toLowerCase() === "c" && e.ctrlKey) {
      e.preventDefault();
      termKill();
    }
  });

  document.querySelectorAll(".bp-tab").forEach(b => {
    b.onclick = () => {
      const same = b.dataset.pane === bottomPane && $("bottomPanel").classList.contains("show");
      if (same) toggleBottom(false);
      else toggleBottom(true, b.dataset.pane);
    };
  });
  $("bpClear").onclick = clearOutput;
  $("bpClose").onclick = () => toggleBottom(false);
  $("bpKill").onclick = () => {
    if (bottomPane === "term") { termKill(); return; }  // 终端标签：结束终端会话
    if (activeKillId()) stopBackground();               // 输出/运行日志：终止对应程序
  };

  $("runPanelRun").onclick = () => runCurrentFile();
  $("runPanelBg").onclick = () => runBackground();

  /* ---------- 后台任务面板 ---------- */
  $("runnerPorts").onclick = () => togglePorts();
  // 打开页面立即同步一次：有仍在运行的任务就自动挂上日志，方便接着看
  loadRunnerList({ autofocus: true });

  /* ---------- 顶部按钮 ---------- */
  /* ---------- 打开文件夹：输入/选择路径后切换 IDE 工作区 ----------
     最近打开存到服务端（data/storage/.file_recent_folders.json），不同设备 / 浏览器都能看到同一份记录 */
  let RECENT = [];                           // [{path, name, opened_at, exists}]

  function recentFolders() { return RECENT.map(x => x.path); }

  async function loadRecentFolders() {
    try {
      const r = await fetch("/api/recent/folders");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      RECENT = d.folders || [];
    } catch (e) { RECENT = []; }
  }

  async function addRecentFolder(path) {
    if (!path) return;
    try {
      await fetch("/api/recent/folders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      await loadRecentFolders();              // 重新拉取，补上 name / exists 等展示字段
    } catch (e) { /* 忽略：记录失败不影响打开文件夹 */ }
  }

  async function openFolderDialog() {
    const recent = recentFolders();
    const def = ROOT || recent[0] || "";
    const tip = recent.length ? "（最近：" + recent.slice(0, 3).join("、") + "）" : "";
    const p = await uiPrompt("打开文件夹", def, "输入文件夹的绝对路径" + tip);
    if (!p || !p.trim()) return;
    let path = p.trim();
    if (path.length > 1) path = path.replace(/\/+$/, "");      // 去掉尾部斜杠（保留根 "/"）
    try {
      const r = await fetch("/api/files?path=" + encodeURIComponent(path));
      const d = await r.json();
      if (d.error) { toast("无法打开：" + d.error, "err"); return; }
      addRecentFolder(path);
      location.href = "/ide?path=" + encodeURIComponent(path);
    } catch (e) {
      toast("无法打开：" + (e.message || e), "err");
    }
  }

  async function newInRoot(isDir) {
    const nm = await uiPrompt(isDir ? "新建文件夹" : "新建文件", isDir ? "新建文件夹" : "新建文件.txt", "在项目根目录下创建，输入名称");
    if (!nm) return;
    fetch("/api/files/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: ROOT, name: nm, is_dir: isDir }) })
      .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); toast("已创建：" + nm, "ok"); refreshTree(ROOT); if (!isDir) openFile(d.path, nm); })
      .catch(e => toast("创建失败：" + (e.message || e), "err"));
  }
  $("tbNewFile").onclick = () => newInRoot(false);
  $("tbNewFolder").onclick = () => newInRoot(true);
  $("sideNewFile").onclick = () => newInRoot(false);
  $("sideNewFolder").onclick = () => newInRoot(true);
  $("sideTreeToggle").onclick = () => {
    if (treeHasOpenDirs()) treeCollapseAll(); else treeExpandAll();
  };
  $("sideShowAll").onclick = () => {
    showAllFiles = !showAllFiles;
    showHidden = !showHidden;
    const btn = $("sideShowAll");
    const on = showAllFiles || showHidden;
    btn.querySelector("i").className = on ? "bi bi-eye" : "bi bi-eye-slash";
    btn.classList.toggle("on", on);
    btn.title = on ? "隐藏全部（依赖目录与隐藏文件）" : "显示全部（含 node_modules、.gitignore 等）";
    refreshTree(ROOT);
  };
  $("tbSave").onclick = () => { if (active) saveTab(active); };

