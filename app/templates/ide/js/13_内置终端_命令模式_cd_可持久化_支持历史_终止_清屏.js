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

  // 把绝对路径折成项目名，用于终端标题、操作范围等展示
  function termProjName(p) {
    if (!p) return "项目";
    return p.replace(/\/+$/, "").split(/[\\/]/).pop() || "项目";
  }

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
        const _tProj = termProjName(d.cwd);
        termAppendTo(s, "内置终端（命令模式）· " + _tProj + "\n" +
        "支持 git / npm / ls 等命令；cd 会保持目录；Ctrl+C 终止当前命令，Ctrl+L 清屏。\n" +
        "AI 助手：直接用中文描述需求（如「查看当前ip」）回车，由 AI 生成命令并解读输出（输入框左侧 ✦ 可切换 AI 模式）。\n" +
        "（不支持 vim、top 等需要 TTY 的全屏程序）\n" +
        (d.scope ? "操作范围：" + termProjName(d.scope) + "（仅允许在此目录下执行文件操作，越界路径会被拦截）\n" : "") +
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
        return { blocked: true, reason: v.reason };
      }
      if (v.level === "confirm") {
        const ok = await uiConfirm("执行高风险命令",
          "命令：\n" + line + "\n\n风险：" + v.reason + "\n\n确定要继续执行吗？", "仍然执行", true);
        if (!ok) { termAppend("（已取消执行）\n", "term-dim"); return { cancelled: true }; }
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
        return { blocked: true, reason: d.reason || d.error };
      }
      if (d.need_confirm) {
        termAppend("（该命令需要确认后才能执行，已取消）\n", "term-dim");
        toast("已取消执行", "warn");
        return { cancelled: true };
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
      return d;                               // 供终端 AI 助手解读输出（普通调用方忽略返回值）
    } catch (e) {
      termAppend("✘ " + (e.message || e) + "\n", "term-err", T);
    } finally {
      T.busy = false;
    }
  }

  /* 在集成终端中打开指定目录：没有会话就新建一个（默认 cwd=ROOT），已在该目录则不重复 cd */
  async function termOpenAt(dir) {
    if (!(await termEnsure())) return;
    toggleBottom(true, "term");
    const cwd = curTerm && curTerm.cwd;
    if (dir && dir !== cwd) await termRun('cd "' + String(dir).replace(/"/g, '\\"') + '"');
    const inp = $("termInput");
    if (inp) inp.focus();
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
  // 标签行末尾的「+」：直接开一个新的 bash 终端（termNew 内部会展开面板并聚焦输入）
  if ($("bpNewTerm")) $("bpNewTerm").onclick = () => { termNew(); };
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

  // 只认绝对路径且仍然存在的记录：相对路径会被后端当成失效路径回退到别的目录
  function recentOk(x) {
    return !!x && typeof x.path === "string" && x.path.startsWith("/") && x.exists !== false;
  }

  function recentFolders() { return RECENT.filter(recentOk).map(x => x.path); }

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

  /* 可视化文件夹选择器：列表里只有文件夹（选不到文件），单击即进入；
     顶部可跳上级 / 当前项目 / 根目录，底部按钮确认当前所在目录。
     返回 Promise<string|null>（取消为 null）。

     可作为子层嵌在别的对话框里（如「新建项目」点「浏览」）：此时把下层对话框整体隐藏，
     而不是清空 overlay —— 原来是直接 ov.innerHTML = ""，会把外层连同已填内容一起销毁，
     表现为「选完目录后整个新建项目窗口就没了」。
     文案可用 opts 定制：{ title, okText, hint }。 */
  function pickFolderDialog(startPath, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const ov = $("modalOverlay");
      const outer = ov.querySelector(".ide-modal");     // 下层对话框（若有）
      const prevKeydown = ov.onkeydown;
      const prevMousedown = ov.onmousedown;
      if (outer) outer.style.display = "none";
      // 起点必须是绝对路径：相对路径会被后端回退到最近存在的上级目录，
      // 结果就是「路径栏写着 A、列表却是 B 的内容」。这里先归一化。
      let cur = String(startPath || "").replace(/\/+$/, "");
      if (!cur.startsWith("/")) cur = (ROOT && ROOT.startsWith("/")) ? ROOT.replace(/\/+$/, "") : "/";
      let busy = false;
      const box = document.createElement("div");
      box.className = "ide-modal wide";
      box.innerHTML =
        '<div class="m-title"><i class="bi bi-folder2-open"></i><span>' + esc(opts.title || "打开文件夹") + "</span></div>" +
        '<div class="m-body">' +
          '<div class="fp-bar">' +
            '<button class="fp-nav fp-up" title="上一级"><i class="bi bi-arrow-up"></i></button>' +
            '<div class="fp-path" title="当前文件夹"></div>' +
            '<button class="fp-nav fp-project">当前项目</button>' +
            '<button class="fp-nav fp-root">根目录</button>' +
          "</div>" +
          '<div class="fp-recent"></div>' +
          '<div class="fp-notice" hidden></div>' +
          '<div class="fp-list"></div>' +
          '<div class="fp-hint">' + esc(opts.hint || "这里只显示文件夹；单击文件夹进入下一级，确认后打开当前所在的文件夹。") + "</div>" +
        "</div>" +
        '<div class="m-foot"><button class="m-cancel">取消</button>' +
        (opts.extraText ? '<button class="m-extra">' + esc(opts.extraText) + "</button>" : "") +
        '<button class="m-ok">' + esc(opts.okText || "打开此文件夹") + "</button></div>";
      ov.appendChild(box);                              // 不清空 overlay：下层对话框要留着
      ov.classList.add("show");
      const list = box.querySelector(".fp-list");
      const pathEl = box.querySelector(".fp-path");
      const recentEl = box.querySelector(".fp-recent");
      const noticeEl = box.querySelector(".fp-notice");
      const close = (val) => {
        box.remove();
        if (outer) outer.style.display = "";             // 原样恢复下层对话框（DOM 未重建，已填内容还在）
        else ov.classList.remove("show");
        ov.onkeydown = prevKeydown;
        ov.onmousedown = prevMousedown;
        resolve(val);
      };

      function notice(msg) {
        noticeEl.textContent = msg || "";
        noticeEl.hidden = !msg;
      }

      const parentOf = (p) => {
        const s = String(p || "").replace(/\/+$/, "");
        const i = s.lastIndexOf("/");
        return i <= 0 ? "/" : s.slice(0, i);
      };

      function renderRecent() {
        const items = RECENT.filter(recentOk).slice(0, 5);
        recentEl.innerHTML = items.length
          ? '<span class="fp-recent-lb">最近：</span>' + items.map(x =>
              '<a class="fp-recent-i" data-path="' + esc(x.path) + '" title="' + esc(x.path) + '">' +
              esc(x.name || String(x.path).split("/").pop() || x.path) + "</a>").join("")
          : "";
        recentEl.querySelectorAll(".fp-recent-i").forEach(a => { a.onclick = () => go(a.dataset.path); });
      }

      async function go(path) {
        let target = String(path || "").replace(/\/+$/, "");
        if (!target.startsWith("/")) {        // 相对路径一律不认（后端会把它回退到别的目录）
          target = (ROOT && ROOT.startsWith("/")) ? ROOT.replace(/\/+$/, "") : "/";
        }
        if (!target) target = "/";
        if (busy) return;
        busy = true;
        pathEl.textContent = target;
        list.innerHTML = '<div class="fp-empty">加载中…</div>';
        notice("");
        try {
          // 只取目录：文件根本不出现在列表里，从交互上就选不到文件
          const d = await apiFiles(target, true);
          // 后端对失效路径会「逐级回退到最近存在的上级目录」并照常返回 200，
          // 所以以它返回的实际目录为准，否则路径栏会显示一个其实没打开的位置
          const actual = String(d.current_path_abs || "").replace(/\/+$/, "");
          if (actual && actual !== target) {
            cur = actual;
            pathEl.textContent = actual;
            notice("「" + target + "」不存在，已回到 " + actual);
          } else {
            cur = target;
          }
          const dirs = (d.items || []).filter(it => it.is_dir)
            .sort((a, b) => a.name.localeCompare(b.name, "zh"));
          if (!dirs.length) {
            list.innerHTML = '<div class="fp-empty">这个文件夹里没有子文件夹</div>';
            return;
          }
          list.innerHTML = dirs.map(it => {
            // /api/files 每个条目的 path 是「相对当前目录」的（见 filecore.get_file_info），
            // 直接当完整路径用会命中 go() 的「非绝对路径回退 ROOT」分支，点任意文件夹都会跳回项目根。
            // 与主资源管理器一致：只有以 / 开头才当地址，否则用「当前目录 + 名称」拼绝对路径。
            const full = (it.path && it.path.startsWith("/")) ? it.path : (cur === "/" ? "/" + it.name : cur + "/" + it.name);
            return '<div class="fp-item" data-path="' + esc(full) + '">' +
              '<i class="bi bi-folder2"></i><span class="fp-name">' + esc(it.name) + "</span></div>";
          }).join("");
          list.querySelectorAll(".fp-item").forEach(el => { el.onclick = () => go(el.dataset.path); });
          list.scrollTop = 0;
        } catch (e) {
          list.innerHTML = '<div class="fp-empty fp-err">' + esc(e.message || "无法读取该文件夹") + "</div>";
        } finally {
          busy = false;
        }
      }

      box.querySelector(".fp-up").onclick = () => go(parentOf(cur));
      box.querySelector(".fp-project").onclick = () => { if (ROOT) go(ROOT); };
      box.querySelector(".fp-root").onclick = () => go("/");
      box.querySelector(".m-cancel").onclick = () => close(null);
      box.querySelector(".m-ok").onclick = () => close({ path: cur, action: "ok" });
      if (opts.extraText) box.querySelector(".m-extra").onclick = () => close({ path: cur, action: "extra" });
      ov.onmousedown = (e) => { if (e.target === ov) close(null); };
      ov.onkeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter") { e.preventDefault(); close({ path: cur, action: "ok" }); }
      };
      renderRecent();
      go(cur);
      box.querySelector(".m-ok").focus();
    });
  }

  /* 目录选择器（「打开文件夹…」与右键菜单「添加文件夹到工作区…」共用同一个界面）。
     opts.mode === "add"：追加语义 —— 主按钮直接是「添加到工作区」，当前项目保持不变，
     不用再在「打开此文件夹」和「添加到工作区」之间二次选择。 */
  async function openFolderDialog(opts) {
    const addMode = !!(opts && opts.mode === "add");
    await loadRecentFolders();                       // 「最近」列表用于快速跳转
    let dlg;
    if (addMode) {
      dlg = {
        title: "添加文件夹到工作区",
        okText: "添加到工作区",
        hint: "选择一个文件夹加入工作区，当前项目（" + (baseName(ROOT) || ROOT || "—") +
              "）保持不变。这里只显示文件夹；单击文件夹进入下一级，确认后把当前所在的文件夹加入工作区。",
      };
    } else {
      // 已有主项目时提供「添加到工作区」选项：默认点「打开此文件夹」直接切换工作区，
      // 搜索 / 终端 / AI 全部跟随选中的文件夹；需要保留多项目再点「添加到工作区」。
      dlg = { title: "打开文件夹" };
      if (ROOT) dlg.extraText = "添加到工作区";
    }
    const res = await pickFolderDialog(ROOT || recentFolders()[0] || "/", dlg);
    if (!res) return;
    const path = res.path;
    try {
      const r = await fetch("/api/files?path=" + encodeURIComponent(path));
      const d = await r.json();
      if (d.error) { toast("无法打开：" + d.error, "err"); return; }
      addRecentFolder(path);
      if (addMode || res.action === "extra") {       // 添加到工作区：与「当前项目」同级显示（仅浏览/编辑）
        if (addWorkspaceFolder(path)) revealWorkspaceFolder(path);   // 折叠状态下自动展开，保证新增项目看得见
        return;
      }
      // 默认：切换工作区 —— 选中的文件夹成为主项目，搜索 / 终端 / AI 全部跟随它
      location.href = "/ide?path=" + encodeURIComponent(path);
    } catch (e) {
      toast("无法打开：" + (e.message || e), "err");
    }
  }

  /* ---------- 新建项目：选「系统任意位置」的目录 + 项目名 → 创建目录 → 打开为项目 ----------
     与「打开文件夹」的区别：从零建目录（父目录不存在会一并建出），
     且位置不受当前工作区限制 —— 浏览用的是同一个全盘可用的目录选择器。 */
  function newProjectDialog() {
    return new Promise((resolve) => {
      const ov = $("modalOverlay");
      let busy = false;
      const box = document.createElement("div");
      box.className = "ide-modal np-modal wide";
      box.innerHTML =
        '<div class="m-title"><i class="bi bi-diagram-3"></i><span>新建项目</span>' +
          '<button class="m-x" title="关闭（Esc）"><i class="bi bi-x-lg"></i></button></div>' +
        '<div class="m-body np-wiz">' +
          '<div class="np-wiz-steps"></div>' +
          // ① 位置
          '<div class="np-page" data-p="loc">' +
            '<div class="np-pg-t">项目创建在哪个目录？</div>' +
            '<div class="np-pg-d">可选系统里任意可用的目录，项目会在它下面新建一个文件夹；目录不存在时会自动逐级创建。</div>' +
            '<div class="np-loc">' +
              '<input class="np-loc-input" spellcheck="false" autocomplete="off" placeholder="如 /home/you/Desktop/CODE">' +
              '<button class="np-pick" title="浏览文件夹…"><i class="bi bi-folder2-open"></i></button>' +
            "</div>" +
          "</div>" +
          // ② 初始框架（非 AI 时在这里填项目名）
          '<div class="np-page" data-p="tpl" hidden>' +
            '<div class="np-pg-t">用哪种初始框架？</div>' +
            '<div class="np-pg-d">内置模板直接铺好骨架；选「AI 生成」则按你的一句话描述来搭建，项目名也由 AI 提供候选。</div>' +
            '<div class="np-tpl"></div>' +
            '<div class="np-row np-row-name"><span class="np-lb">项目名</span>' +
              '<input class="np-name-input" spellcheck="false" autocomplete="off" placeholder="必填，例如 my-project">' +
            "</div>" +
          "</div>" +
          // ③ 项目描述（仅 AI）
          '<div class="np-page" data-p="brief" hidden>' +
            '<div class="np-pg-t">用一句话描述你的项目</div>' +
            '<div class="np-pg-d">写清技术栈和要做的功能。AI 会直接把项目骨架写出来（目录名先随机生成 28 位哈希），' +
              '代码写完后它再根据实际生成的内容给项目起正式名字并自动改名。</div>' +
            '<textarea class="np-brief" rows="4" spellcheck="false"' +
              ' placeholder="例如：一个带用户登录和 SQLite 的 Flask 博客"></textarea>' +
            '<div class="np-brief-foot">' +
              '<span class="np-egs"></span>' +
              '<span class="np-brief-cnt">0/500</span>' +
            "</div>" +
          "</div>" +
          // ④ 构建：左边可视化文件夹列表，右边「AI 任务单 + 思考过程」
          '<div class="np-page" data-p="run" hidden>' +
            '<div class="np-run-hd">' +
              '<div class="np-pg-t np-run-t">正在构建项目…</div>' +
              '<span class="np-run-time"></span>' +
            "</div>" +
            '<div class="np-steps"></div>' +
            '<div class="np-split">' +
              '<div class="np-tree-wrap">' +
                '<div class="np-prog-hd"><span class="np-prog-ic"><i class="bi bi-hourglass-split"></i></span>' +
                  '<span class="np-prog-msg"></span>' +
                  '<span class="np-prog-num"></span></div>' +
                '<div class="np-tree"></div>' +
              "</div>" +
              '<div class="np-side">' +
                '<div class="np-tasks">' +
                  '<div class="np-side-hd"><i class="bi bi-list-check"></i><span>AI 任务单</span>' +
                    '<span class="np-tasks-n"></span></div>' +
                  '<div class="np-tasks-body"></div>' +
                "</div>" +
                '<div class="np-live">' +
                  '<div class="np-side-hd"><i class="bi bi-lightbulb"></i><span>思考过程</span>' +
                    '<span class="np-live-n"></span></div>' +
                  '<div class="np-live-body"></div>' +
                "</div>" +
              "</div>" +
            "</div>" +
          "</div>" +
          // ⑤ 项目名：AI 候选 + 可编辑，确认后重命名并打开
          '<div class="np-page" data-p="name" hidden>' +
            '<div class="np-pg-t">给项目起个名字</div>' +
            '<div class="np-pg-d">AI 已经读过刚生成的项目。可以点下面的候选，也可以自己改；确认后会重命名目录并打开。</div>' +
            '<div class="np-names"></div>' +
            '<div class="np-row np-row-name2"><span class="np-lb">项目名</span>' +
              '<input class="np-name2" spellcheck="false" autocomplete="off"' +
                ' placeholder="留空则保持临时目录名">' +
            "</div>" +
          "</div>" +
          '<div class="np-msg"></div>' +
        "</div>" +
        // 关闭二次确认：盖在弹窗自身之上的一层（不能再用 #modalOverlay，那会把本弹窗一起冲掉）
        '<div class="np-confirm" hidden>' +
          '<div class="np-cf">' +
            '<div class="np-cf-t"><i class="bi bi-exclamation-triangle-fill"></i><span>关闭「新建项目」？</span></div>' +
            '<div class="np-cf-d"></div>' +
            '<div class="np-cf-f">' +
              '<button class="np-cf-no">继续填写</button>' +
              '<button class="np-cf-yes">关闭</button>' +
            "</div>" +
          "</div>" +
        "</div>" +
        '<div class="np-info">' +
          '<div class="np-path">即将创建：<b class="np-preview-path">—</b></div>' +
          '<label class="np-model" hidden title="本次 AI 生成使用的模型（响应太慢就换一个）">' +
            '<i class="bi bi-cpu"></i><select class="np-model-sel"></select>' +
          "</label>" +
        "</div>" +
        '<div class="m-foot">' +
          '<button class="m-back" hidden>上一步</button>' +
          '<span class="np-need"></span>' +
          '<button class="m-cancel">取消</button>' +
          '<button class="m-ok">下一步</button>' +
        "</div>";
      ov.innerHTML = "";
      ov.appendChild(box);
      ov.classList.add("show");
      const locInp = box.querySelector(".np-loc-input");
      const nameInp = box.querySelector(".np-name-input");
      const nameRow = box.querySelector(".np-row-name");
      const tplsEl = box.querySelector(".np-tpl");
      const briefInp = box.querySelector(".np-brief");
      const briefCnt = box.querySelector(".np-brief-cnt");
      const egsEl = box.querySelector(".np-egs");
      const wizEl = box.querySelector(".np-wiz-steps");   // 顶部向导步骤条
      const runTitle = box.querySelector(".np-run-t");
      const runTime = box.querySelector(".np-run-time");   // 构建总耗时
      const stepsEl = box.querySelector(".np-steps");
      const liveEl = box.querySelector(".np-live");          // 右侧「思考过程」
      const liveBody = box.querySelector(".np-live-body");
      const liveN = box.querySelector(".np-live-n");
      const tasksBody = box.querySelector(".np-tasks-body");  // 右侧「AI 任务单」
      const tasksN = box.querySelector(".np-tasks-n");
      const namesEl = box.querySelector(".np-names");         // 「项目名」页的候选
      const nameInp2 = box.querySelector(".np-name2");
      const treeEl = box.querySelector(".np-tree");
      const progIc = box.querySelector(".np-prog-ic");
      const progMsg = box.querySelector(".np-prog-msg");
      const progNum = box.querySelector(".np-prog-num");
      const previewEl = box.querySelector(".np-preview-path");
      const modelBox = box.querySelector(".np-model");        // 底部「模型」下拉
      const modelSel = box.querySelector(".np-model-sel");
      const msgEl = box.querySelector(".np-msg");
      const okBtn = box.querySelector(".m-ok");
      const backBtn = box.querySelector(".m-back");
      const cancelBtn = box.querySelector(".m-cancel");
      const needEl = box.querySelector(".np-need");      // 底部「还差：项目名」提示
      const cfEl = box.querySelector(".np-confirm");       // 关闭二次确认层
      const cfD = box.querySelector(".np-cf-d");
      const cfNo = box.querySelector(".np-cf-no");
      const cfYes = box.querySelector(".np-cf-yes");
      let abortCtrl = null;                        // 创建中的中断句柄
      let briefMax = 500;
      let runErr = false;                          // 构建是否失败（向导步骤条上标红）
      // 耗时统计：每步「run → ok/err」的间隔 + 整体构建总耗时（先声明，close 里要用）
      let stepT0 = {}, stepMs = {}, runT0 = 0, runTimer = 0;
      let onKey = null;                            // 挂在 document 上的键盘监听（关闭时解绑）
      let liveTimer = 0;                           // 思考过程的合并渲染定时器
      const close = (val) => {
        if (runTimer) { clearInterval(runTimer); runTimer = 0; }   // 别让计时器在关闭后继续跑
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
        if (onKey) { document.removeEventListener("keydown", onKey, true); onKey = null; }
        ov.classList.remove("show"); ov.innerHTML = "";
        ov.onkeydown = null; ov.onmousedown = null;
        resolve(val);
      };
      // 关闭：正在构建时先把 SSE 掐掉（已写好的文件保留），避免关掉窗口后后台还在跑
      function hardClose() {
        try { if (abortCtrl) abortCtrl.abort(); } catch (e) { /* 忽略 */ }
        close(null);
      }
      // 关闭二次确认：只有「关闭按钮 / Esc」会走到这里，防止误关丢掉填写内容或中断构建
      function askClose() {
        if (!cfEl.hidden) return;                       // 已经弹着就别重复弹
        cfD.textContent = busy
          ? "项目正在构建中，关闭会中断构建（已经写好的文件会保留）。确定要关闭吗？"
          : "当前填写的内容不会保存，确定要关闭「新建项目」吗？";
        cfEl.hidden = false;
        cfNo.focus();                                   // 焦点落在「继续填写」，回车不会误关
      }
      function hideConfirm() { cfEl.hidden = true; }
      cfNo.onclick = hideConfirm;
      cfYes.onclick = () => hardClose();
      cfEl.onmousedown = (e) => { if (e.target === cfEl) hideConfirm(); };

      function say(msg, err) {
        msgEl.textContent = msg || "";
        msgEl.className = "np-msg" + (err ? " err" : "");
      }
      function cleanName() { return nameInp.value.trim().replace(/^\/+|\/+$/g, ""); }
      function targetOf() {
        const p = locInp.value.trim().replace(/\/+$/, "");
        const n = cleanName();
        if (!p || !n) return "";
        return (p === "/" ? "" : p) + "/" + n;
      }
      function nameError(n) {
        if (!n) return "请输入项目名";
        if (n === "." || n === "..") return "项目名无效";
        if (/[\/\\]/.test(n)) return "项目名不能包含路径分隔符";
        if (/[<>:"|?*]/.test(n)) return '项目名不能包含 < > : " | ? * 等字符';
        if (n.length > 128) return "项目名过长（上限 128 字符）";
        return "";
      }
      // ---- 初始框架：内置模板 + AI 生成（列表来自后端，避免两边各维护一份）----
      const AI_TPL = "ai";               // 与后端 scaffold.AI_KEY 一致
      let TPLS = [{ key: "blank", label: "空项目", icon: "bi-folder2", hint: "只建目录" }];
      let tpl = "blank";
      let aiPick = null;                 // 底部下拉手动选的模型 {provider_id, model}；null = 跟随系统 AI
      let buildResult = null;            // 构建完成后的结果（含临时路径 / 候选名），供「项目名」这一步用
      // 「AI 生成」：描述 → 直接用 28 位哈希当临时目录名把项目建出来 →
      // 代码写完后 AI 根据实际内容起正式名并自动重命名（见后端 create-stream 的 naming 步骤）

      function renderTpls() {
        // 「AI 生成」在「设置 → 系统 AI」里被停用时不出现在可选列表里（后端也会拒绝）
        const aiOff = (typeof sysAiOff === "function") && sysAiOff("scaffold");
        if (aiOff && tpl === AI_TPL) tpl = "blank";        // 正选着被停用的项 → 回退到空项目
        const list = TPLS.filter(t => !(aiOff && t.key === AI_TPL));
        tplsEl.innerHTML = list.map(t =>
          '<button type="button" class="np-tpl-i' + (t.key === tpl ? " on" : "") +
            '" data-k="' + esc(t.key) + '" title="' + esc(t.hint || t.label) + '">' +
            '<i class="bi ' + esc(t.icon || "bi-folder2") + '"></i>' + esc(t.label) + "</button>").join("");
        tplsEl.querySelectorAll(".np-tpl-i").forEach(b => {
          b.onclick = () => {
            const was = tpl;
            tpl = b.dataset.k;
            if (was !== tpl && (page === "brief" || page === "run")) page = "tpl";
            renderTpls();
            syncPages();
          };
        });
      }

      // 底部模型下拉：列出「设置 → AI 助手」里配好的接口 / 模型，默认跟随系统 AI。
      // 某个模型太慢导致超时时，用户可以在这里临时换一个。
      function loadModels() {
        fetch("/api/projects/ai/models")
          .then(r => r.json())
          .then(d => {
            if (!d || !d.items || !d.items.length) return;
            const cur = d.current || {};
            modelSel.innerHTML = "";
            const opt0 = document.createElement("option");
            opt0.value = "";
            opt0.textContent = "跟随系统 AI" + (cur.model ? "（" + cur.model + "）" : "");
            modelSel.appendChild(opt0);
            const groups = {};
            d.items.forEach(it => { (groups[it.provider] = groups[it.provider] || []).push(it); });
            Object.keys(groups).forEach(pn => {
              const og = document.createElement("optgroup");
              og.label = pn;
              groups[pn].forEach(it => {
                const o = document.createElement("option");
                o.value = it.provider_id + "|" + it.model;
                o.textContent = it.model + (it.provider_id === cur.provider_id && it.model === cur.model
                  ? "（当前）" : "");
                og.appendChild(o);
              });
              modelSel.appendChild(og);
            });
          })
          .catch(() => { /* 拉不到就只用系统默认，不影响创建 */ });
      }
      modelSel.onchange = () => {
        const v = modelSel.value;
        if (!v) { aiPick = null; return; }
        const i = v.indexOf("|");
        aiPick = { provider_id: v.slice(0, i), model: v.slice(i + 1) };
      };

      function loadTpls() {
        fetch("/api/projects/templates")
          .then(r => r.json())
          .then(d => {
            if (d && d.brief_max) briefMax = d.brief_max;
            if (d && d.templates && d.templates.length) { TPLS = d.templates; renderTpls(); }
            refresh();
          })
          .catch(() => { /* 拉不到就保持只有「空项目」，不影响创建 */ });
      }

      // ---- 向导：一屏一步；顶部步骤条指示进度，可直接点回已完成的步骤 ----
      const WIZ_LABEL = { loc: "位置", tpl: "初始框架", brief: "项目描述", run: "创建", name: "项目名" };
      let page = "loc";
      function pagesOf() {
        // AI 生成：构建完成后多一步「项目名」，由用户确认/修改后再重命名并打开
        return tpl === AI_TPL ? ["loc", "tpl", "brief", "run", "name"] : ["loc", "tpl", "run"];
      }
      function renderWiz() {
        const pages = pagesOf();
        const cur = Math.max(0, pages.indexOf(page));
        wizEl.innerHTML = pages.map((k, i) => {
          const st = i < cur ? "done" : (i === cur ? (k === "run" && runErr ? "err" : "cur") : "pending");
          return (i ? '<span class="np-ws-line' + (i <= cur ? " done" : "") + '"></span>' : "") +
            '<div class="np-ws ' + st + (i < cur ? " can-back" : "") + '" data-k="' + k + '">' +
              '<span class="np-ws-n">' + (st === "done" ? '<i class="bi bi-check-lg"></i>' : String(i + 1)) + "</span>" +
              '<span class="np-ws-t">' + esc(WIZ_LABEL[k] || k) + "</span>" +
            "</div>";
        }).join("");
        wizEl.querySelectorAll(".np-ws.can-back").forEach(el => {
          el.onclick = () => gotoPage(el.dataset.k);
        });
      }
      function syncPages() {
        const pages = pagesOf();
        if (pages.indexOf(page) < 0) page = pages[0];       // 换框架后当前页可能已不存在
        box.querySelectorAll(".np-page").forEach(el => { el.hidden = (el.dataset.p !== page); });
        backBtn.hidden = busy || pages.indexOf(page) <= 0;
        backBtn.disabled = busy;
        renderWiz();
        refresh();
        if (!busy) {                                        // 每页把光标放到该填的地方
          if (page === "loc") locInp.focus();
          else if (page === "tpl" && tpl !== AI_TPL) nameInp.focus();
          else if (page === "brief") briefInp.focus();
          else if (page === "name") { nameInp2.focus(); nameInp2.select(); }
        }
      }
      function gotoPage(k) {
        if (busy) return;
        const pages = pagesOf();
        if (pages.indexOf(k) < 0) k = pages[0];
        page = k;
        say("", false);
        syncPages();
      }

      // 只负责「当前页」的提示 / 底部按钮 / 路径预览，页面切换由 syncPages 处理
      function refresh() {
        const p = locInp.value.trim();
        const brief = briefInp.value.trim();
        const isAI = tpl === AI_TPL;
        nameRow.hidden = isAI;                     // AI 模式不手填项目名：先用哈希，建完再起正式名
        modelBox.hidden = !isAI;                   // 模型下拉只在 AI 生成时有用
        briefCnt.textContent = briefInp.value.length + "/" + briefMax;
        briefCnt.classList.toggle("over", briefInp.value.length > briefMax);
        // 路径预览：AI 模式还不知道最终名字，用「28 位哈希」占位
        const nm = isAI ? "" : cleanName();
        let pv = "";
        if (p) {
          const base = p.replace(/\/+$/, "");
          pv = base + "/" + (nm || "<28位哈希，建完自动改名>");
          if (!pv.startsWith("/")) pv = "/" + pv;
        }
        // 「项目名」这一步：预览跟着输入的名字走（空则回落到临时目录名）
        if (page === "name" && buildResult && buildResult.temp_path) {
          const tmp = buildResult.temp_path;
          const base2 = tmp.slice(0, tmp.lastIndexOf("/") + 1);
          const nm2 = nameInp2.value.trim();
          pv = base2 + (nm2 || tmp.slice(tmp.lastIndexOf("/") + 1));
        }
        previewEl.textContent = pv || "—";
        previewEl.classList.toggle("dim", !nm);
        // 当前页的必填项（底部左侧脚注，不拦点击，点了也会再提示一次）
        const miss = [];
        if (!p) miss.push("位置");
        else if (!p.startsWith("/")) miss.push("位置（需绝对路径）");
        if (page === "tpl" && !isAI) {
          const ne = nameError(cleanName());
          if (ne) miss.push(ne === "请输入项目名" ? "项目名" : ne);
        }
        if (page === "brief") {
          if (!brief) miss.push("项目描述");
          else if (briefInp.value.length > briefMax) miss.push("项目描述（超长）");
        }
        needEl.textContent = miss.length ? "还差：" + miss.join("、") : "";
        // 底部按钮：按当前步骤给文案
        okBtn.disabled = busy;
        if (page === "loc") okBtn.textContent = "下一步";
        else if (page === "tpl") okBtn.textContent = isAI ? "下一步" : "创建并打开";
        else if (page === "brief") okBtn.textContent = "开始构建";
        else if (page === "name") okBtn.textContent = busy ? "处理中…" : "完成并打开";
        else okBtn.textContent = busy ? "构建中…"
          : (buildResult ? "下一步" : (runErr ? "重试" : "完成"));
        // 用户开始补内容就把红框撤掉，别一直红着
        if (p.startsWith("/")) locInp.classList.remove("bad");
        if (cleanName()) nameInp.classList.remove("bad");
        if (brief) briefInp.classList.remove("bad");
      }

      // 点底部主按钮：按当前步骤推进（不直接建项目）
      function onNext() {
        if (busy) return;
        if (page === "loc") {
          const p = locInp.value.trim();
          if (!p) { say("请先选择项目要创建在哪个目录", true); locInp.classList.add("bad"); locInp.focus(); return; }
          if (!p.startsWith("/")) {
            say("位置必须是绝对路径（以 / 开头）", true); locInp.classList.add("bad"); locInp.focus(); return;
          }
          return gotoPage("tpl");
        }
        if (page === "tpl") {
          if (tpl === AI_TPL) return gotoPage("brief");
          const badErr = nameError(cleanName());
          if (badErr) {
            say(badErr + "（输入框里的「必填，例如 my-project」只是提示文字）", true);
            nameInp.classList.add("bad"); nameInp.focus(); return;
          }
          return startCreate();                       // 内置模板：直接建
        }
        if (page === "brief") {
          const brief = briefInp.value.trim();
          if (!brief) { say("请先用一句话描述你的项目，或点下面的示例", true); briefInp.classList.add("bad"); briefInp.focus(); return; }
          if (briefInp.value.length > briefMax) {
            say("描述过长（上限 " + briefMax + " 字）", true); briefInp.classList.add("bad"); briefInp.focus(); return;
          }
          return startCreate();                        // 直接构建：先用哈希目录，建完再起名
        }
        if (page === "run" && !busy) {
          if (buildResult) return gotoPage("name");   // 已经建好：只是回去看一眼，别重建
          return startCreate();                       // 失败后「重试」
        }
        if (page === "name") return confirmRename();         // 确认名字 → 重命名并打开
      }

      // ---- 常用描述速填：点一下就填进输入框，省得每次现编 ----
      [
        "一个带用户登录和 SQLite 的 Flask 博客",
        "FastAPI + MySQL 的任务管理接口，带 JWT 鉴权",
        "Express + MongoDB 的商城后端，含商品与订单",
        "纯静态个人主页，含作品集与联系方式",
      ].forEach(t => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "np-eg";
        b.textContent = t;
        b.onclick = () => {
          briefInp.value = t;
          refresh();
          briefInp.focus();
        };
        egsEl.appendChild(b);
      });

      // ---- 步骤条：完全由后端 SSE 的 steps / step 事件驱动 ----
      // AI 模板把「生成代码 / 生成文件树 / 创建目录 / 写入文件」合并成一步「Agent 构建」
      const STEP_ALL = [
        { id: "check", label: "校验参数" },
        { id: "ai", label: "Agent 构建" },
        { id: "tree", label: "生成文件树" },
        { id: "dirs", label: "创建目录" },
        { id: "files", label: "写入文件" },
        { id: "naming", label: "生成项目名" },
        { id: "done", label: "完成" },
      ];
      const ST_ICON = { pending: "bi-circle", run: "bi-arrow-repeat",
                        ok: "bi-check-circle-fill", err: "bi-x-circle-fill" };
      // 耗时统计：进度条上每步显示自己花了多久，标题右侧显示总耗时
      function fmtSec(ms) { return (ms / 1000).toFixed(1) + "s"; }
      function fillStepTimes() {
        Object.keys(stepMs).forEach(id => {
          const t = stepsEl.querySelector('.np-step[data-id="' + id + '"] .np-step-t');
          if (t) t.textContent = fmtSec(stepMs[id]);
        });
      }
      function startRunTimer() {
        runT0 = Date.now();
        runTime.textContent = "总耗时 0.0s";
        if (runTimer) clearInterval(runTimer);
        runTimer = setInterval(() => {
          runTime.textContent = "总耗时 " + fmtSec(Date.now() - runT0);
          // 正在跑的那一步也走秒：否则只有结束后才冒数字，等待时看着像卡死
          const cur = stepsEl.querySelector(".np-step.run");
          if (cur) {
            const t = cur.querySelector(".np-step-t");
            const t0 = stepT0[cur.dataset.id];
            if (t && t0) t.textContent = fmtSec(Date.now() - t0);
          }
        }, 100);
      }
      function stopRunTimer() {
        if (runTimer) { clearInterval(runTimer); runTimer = 0; }
        const total = runT0 ? Date.now() - runT0 : 0;
        if (runT0) runTime.textContent = "总耗时 " + fmtSec(total);
        return total;
      }
      function renderSteps(list) {
        const items = (list && list.length) ? list : STEP_ALL;
        stepsEl.innerHTML = items.map((s, i) =>
          (i ? '<span class="np-step-line"></span>' : "") +
          '<div class="np-step pending" data-id="' + esc(s.id) + '">' +
            '<span class="np-step-d"><i class="bi bi-circle"></i></span>' +
            '<span class="np-step-lb">' + esc(s.label) + "</span>" +
            '<span class="np-step-t"></span>' +
          "</div>").join("");
        fillStepTimes();                 // 重绘后把已经跑完的步骤耗时补回去
      }
      function setStep(id, state, msg) {
        const el = stepsEl.querySelector('.np-step[data-id="' + id + '"]');
        if (el) {
          if (state === "run") {
            stepT0[id] = Date.now();     // 开始计时
          } else if ((state === "ok" || state === "err") && stepT0[id]) {
            stepMs[id] = Date.now() - stepT0[id];
            const t = el.querySelector(".np-step-t");
            if (t) t.textContent = fmtSec(stepMs[id]);
          }
          el.className = "np-step " + state;
          const ic = el.querySelector(".np-step-d i");
          if (ic) ic.className = "bi " + (ST_ICON[state] || ST_ICON.pending);
        }
        if (msg) progMsg.textContent = msg;
      }

      // ---- 文件树：plan 事件一次性给出完整目录 + 文件，之后 dir / file 事件逐个点亮 ----
      let TREE = null;                 // { root, nodes, byId, seq }
      let PLAN_PATHS = [];             // 文件写入顺序（用于提示「下一个要写的是谁」）
      function buildTree(items, dirs) {
        const nodes = {}, byId = {};
        let seq = 0;
        const root = { id: 0, name: "", depth: 0, dir: true, children: [], collapsed: false, state: "ok" };
        byId[0] = root;
        const dirNode = (path) => {
          if (!path) return root;
          if (nodes[path]) return nodes[path];
          const cut = path.lastIndexOf("/");
          const parent = dirNode(cut > 0 ? path.slice(0, cut) : "");
          const n = { id: ++seq, path: path, name: path.slice(cut + 1), depth: parent.depth + 1,
                      dir: true, children: [], collapsed: false, state: "pending", size: 0 };
          parent.children.push(n);
          nodes[path] = n;
          byId[n.id] = n;
          return n;
        };
        (dirs || []).forEach(d => dirNode(String(d)));
        (items || []).forEach(it => {
          const p = String((it && it.path) || it || "");
          if (!p) return;
          const cut = p.lastIndexOf("/");
          const parent = dirNode(cut > 0 ? p.slice(0, cut) : "");
          const n = { id: ++seq, path: p, name: p.slice(cut + 1), depth: parent.depth + 1,
                      dir: false, children: [], state: "pending", size: (it && it.size) || 0 };
          parent.children.push(n);
          nodes[p] = n;
          byId[n.id] = n;
        });
        (function sortDown(n) {
          n.children.sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name, "zh")
                                                   : (a.dir ? -1 : 1));
          n.children.forEach(sortDown);
        })(root);
        return { root: root, nodes: nodes, byId: byId, seq: seq };
      }
      // Agent 边生成边写文件时，plan 里可能没有这个路径（模型没给 <plan> 或中途加文件）：
      // 这里按需把节点补进树里，返回是否新增了节点（新增过就需要重绘）
      function ensurePath(path) {
        if (!TREE) TREE = buildTree([], []);
        if (!path || TREE.nodes[path]) return false;
        const seg = String(path).split("/");
        let acc = "";
        for (let i = 1; i < seg.length; i++) {
          const d = seg.slice(0, i).join("/");
          if (!TREE.nodes[d]) {
            const parent = TREE.nodes[acc] || TREE.root;
            const n = { id: ++TREE.seq, path: d, name: seg[i - 1], depth: parent.depth + 1,
                        dir: true, children: [], collapsed: false, state: "pending", size: 0 };
            parent.children.push(n);
            parent.children.sort((a, b) => a.dir === b.dir
              ? a.name.localeCompare(b.name, "zh") : (a.dir ? -1 : 1));
            TREE.nodes[d] = n;
            TREE.byId[n.id] = n;
          }
          acc = d;
        }
        const nm = seg[seg.length - 1];
        if (!nm) return false;
        const parent = TREE.nodes[acc] || TREE.root;
        const f = { id: ++TREE.seq, path: path, name: nm, depth: parent.depth + 1,
                    dir: false, children: [], state: "pending", size: 0 };
        parent.children.push(f);
        parent.children.sort((a, b) => a.dir === b.dir
          ? a.name.localeCompare(b.name, "zh") : (a.dir ? -1 : 1));
        TREE.nodes[path] = f;
        TREE.byId[f.id] = f;
        return true;
      }
      function countFiles(n) {
        let c = 0;
        (n.children || []).forEach(ch => { c += ch.dir ? countFiles(ch) : 1; });
        return c;
      }
      function flattenTree(n, out) {
        (n.children || []).forEach(c => {
          out.push(c);
          if (c.dir && !c.collapsed) flattenTree(c, out);
        });
        return out;
      }
      function rowOf(n) {
        const pad = 6 + n.depth * 14;
        const st = '<i class="np-tr-st bi ' + (ST_ICON[n.state] || ST_ICON.pending) + '"></i>';
        if (n.dir) {
          return '<div class="np-tr dir ' + n.state + (n.collapsed ? " collapsed" : "") +
            '" data-i="' + n.id + '" style="padding-left:' + pad + 'px">' +
            '<i class="np-tr-car bi bi-chevron-down"></i>' +
            '<span class="np-tr-ic">' + iconFor(n.name, true) + "</span>" +
            '<span class="np-tr-nm">' + esc(n.name) + "</span>" +
            '<span class="np-tr-sz">' + countFiles(n) + " 项</span>" + st + "</div>";
        }
        return '<div class="np-tr file ' + n.state + '" data-i="' + n.id +
          '" style="padding-left:' + pad + 'px">' +
          '<i class="np-tr-car"></i>' +
          '<span class="np-tr-ic">' + iconFor(n.name, false) + "</span>" +
          '<span class="np-tr-nm">' + esc(n.name) + "</span>" +
          '<span class="np-tr-sz">' + (n.size ? fmtSize(n.size) : "") + "</span>" + st + "</div>";
      }
      function renderTree() {
        if (!TREE) return;
        const keep = treeEl.scrollTop;
        treeEl.innerHTML = flattenTree(TREE.root, []).map(rowOf).join("");
        treeEl.scrollTop = keep;
        treeEl.querySelectorAll(".np-tr").forEach(el => {
          const n = TREE.byId[el.dataset.i];
          if (!n) return;
          n.el = el;
          if (n.dir) {
            el.onclick = () => { n.collapsed = !n.collapsed; renderTree(); };
          }
        });
      }
      function patchRow(n) {
        if (!n || !n.el) return;
        n.el.classList.remove("pending", "run", "ok", "bad");
        n.el.classList.add(n.state);
        const st = n.el.querySelector(".np-tr-st");
        if (st) st.className = "np-tr-st bi " + (ST_ICON[n.state] || ST_ICON.pending);
        if (n.dir) n.el.classList.toggle("collapsed", !!n.collapsed);
      }
      function markPath(path, state, scroll) {
        if (!TREE) return;
        const n = TREE.nodes[path];
        if (!n) return;
        n.state = state;
        patchRow(n);
        // 祖先目录跟着亮：视觉上相当于「目录从根往下一层层长出来」
        let cut = path.lastIndexOf("/");
        while (cut > 0) {
          const dn = TREE.nodes[path.slice(0, cut)];
          if (dn && state !== "bad") { dn.state = "ok"; patchRow(dn); }
          cut = path.slice(0, cut).lastIndexOf("/");
        }
        if (scroll && n.el && n.el.scrollIntoView) {
          try { n.el.scrollIntoView({ block: "nearest" }); } catch (e) { /* 老浏览器忽略 */ }
        }
      }

      // 构建结束：规划里列了、但模型最终没写的文件标成「未生成」，别让它们一直灰着像还没跑完
      function markLeftover() {
        if (!TREE) return;
        Object.keys(TREE.nodes).forEach(p => {
          const n = TREE.nodes[p];
          if (!n.dir && n.state === "pending") { n.state = "bad"; patchRow(n); }
        });
      }

      // 流式创建：后端按 SSE 逐步回报阶段，这里逐帧回调
      async function createStream(payload, onEvent, signal) {
        const resp = await fetch("/api/projects/create-stream", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload), signal: signal,
        });
        if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status);
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          let k;
          while ((k = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, k);
            buf = buf.slice(k + 2);
            const line = raw.split("\n").find(l => l.indexOf("data:") === 0);
            if (!line) continue;
            try { onEvent(JSON.parse(line.slice(5).trim())); } catch (e) { /* 忽略坏帧 */ }
          }
        }
      }

      function progIcon(kind) {
        progIc.className = "np-prog-ic " + kind;
        progIc.innerHTML = '<i class="bi ' + (kind === "ok" ? "bi-check-circle-fill"
          : kind === "err" ? "bi-x-circle-fill" : "bi-arrow-repeat") + '"></i>';
      }

      // 右栏：思考过程 + AI 任务单（左栏是目录树，三者同时可见）
      let liveText = "";
      let liveFollow = true;          // 是否贴底跟随（用户往上翻看时就不硬拽回底部）
      function liveReset() {
        liveText = "";
        liveFollow = true;
        liveBody.innerHTML = "";
        liveBody.classList.remove("np-stream");
        liveN.textContent = "等待模型响应…";
        liveEl.hidden = false;
      }
      function liveShow() { liveEl.hidden = false; }
      // 逐文件生成时每个文件重新开一段：清空上一轮的思考，换成「正在写 xxx」的占位
      function liveRestart(label) {
        liveText = "";
        liveFollow = true;
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
        liveEl.hidden = false;
        liveBody.classList.add("np-stream");
        liveBody.innerHTML = '<div class="np-wait">' + esc(label || "模型正在思考…") + "</div>";
        liveN.textContent = label || "等待模型响应…";
      }
      // 思考过程按 Markdown 渲染：模型输出的是带标题/列表/代码块的 Markdown，
      // 直接 textContent 会显示成一堆 ** 和 # 符号。
      function paintLive() {
        liveTimer = 0;
        const keepTop = liveBody.scrollTop;
        const html = (typeof renderMarkdown === "function")
          ? renderMarkdown(liveText)
          : esc(liveText).replace(/\n/g, "<br>");
        liveBody.innerHTML = '<div class="np-md">' + html + "</div>";
        liveBody.scrollTop = liveFollow ? liveBody.scrollHeight : keepTop;
      }
      function scheduleLive() {
        // 流式增量合并渲染：没必要每个 token 都重排整段（100ms 一次足够顺滑）
        if (liveTimer) return;
        liveTimer = setTimeout(paintLive, 100);
      }
      function livePush(evt) {
        liveShow();
        if (evt.kind === "reason") {
          liveBody.classList.add("np-stream");        // 末尾光标闪烁，表示还在输出
          // 贴底时才自动跟随；用户主动往上翻就保持他看的位置
          liveFollow = liveBody.scrollHeight - liveBody.scrollTop - liveBody.clientHeight < 32;
          liveText += evt.text || "";
          scheduleLive();
          liveN.textContent = liveText.length + " 字";
        } else if (evt.kind === "body") {
          liveN.textContent = "已接收 " + (evt.n || 0) + " 字";
          if (!liveText) {
            // 模型没给思考、直接吐正文：把占位文字换成实时字数，让人知道确实在动
            liveBody.classList.add("np-stream");
            const w = liveBody.querySelector(".np-wait");
            if (w) w.textContent = "正在写内容，已接收 " + (evt.n || 0) + " 字…";
          }
        }
      }
      function liveDone() {
        liveBody.classList.remove("np-stream");
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
        paintLive();                                   // 收尾再刷一次，确保最后一段完整
      }

      // AI 任务单：plan 里的文件清单，写一个勾一个
      let TASK_MAP = {}, TASK_N = 0, TASK_DONE = 0;
      function tasksReset() {
        TASK_MAP = {};
        TASK_N = 0;
        TASK_DONE = 0;
        // 还没拿到 plan 时给个占位，别让任务单看起来是空的
        tasksBody.innerHTML = '<div class="np-task np-task-hint">等待 Agent 规划文件清单…</div>';
        tasksN.textContent = "";
      }
      function tasksPlan(paths) {
        tasksReset();
        tasksBody.innerHTML = "";            // 去掉「等待规划」占位，换成真实的文件清单
        const list = paths || [];
        TASK_N = list.length;
        tasksN.textContent = "0 / " + TASK_N;
        list.forEach(p => {
          const row = document.createElement("div");
          row.className = "np-task";
          const ic = document.createElement("i");
          ic.className = "bi bi-circle";
          const t = document.createElement("span");
          t.textContent = p;                 // 用 textContent，避免路径里的字符被当成标签
          row.appendChild(ic);
          row.appendChild(t);
          tasksBody.appendChild(row);
          TASK_MAP[p] = row;
        });
      }
      function tasksMark(path) {
        let row = TASK_MAP[path];
        if (!row) {                          // plan 里没有的文件（模型中途加的）→ 追加一行
          row = document.createElement("div");
          row.className = "np-task";
          row.innerHTML = '<i class="bi bi-circle"></i><span></span>';
          row.querySelector("span").textContent = path;
          tasksBody.appendChild(row);
          TASK_MAP[path] = row;
          TASK_N++;
        }
        if (row.classList.contains("ok")) return;
        row.classList.add("ok");
        row.querySelector("i").className = "bi bi-check-circle-fill";
        TASK_DONE++;
        tasksN.textContent = TASK_DONE + " / " + TASK_N;
        tasksBody.scrollTop = tasksBody.scrollHeight;
      }

      // 「项目名」这一步：AI 候选 + 手改，确认后调后端重命名，最后打开
      function fillNames(res) {
        const list = (res && res.suggested) || [];
        nameInp2.value = list.length ? (list[0].name || list[0]) : "";
        if (!list.length) {
          namesEl.innerHTML = '<span class="np-names-hint">' +
            esc((res && res.naming_note) || "AI 没能给出合适的名字，自己起一个吧") + "</span>";
          return;
        }
        namesEl.innerHTML = '<div class="np-name-list">' + list.map((n, i) => {
          const nm = n.name || n, why = n.why || "";
          return '<button type="button" class="np-name-i" data-i="' + i + '">' +
            '<i class="bi bi-folder2"></i><span class="np-name-t">' + esc(nm) + "</span>" +
            (why ? '<span class="np-name-w">' + esc(why) + "</span>" : "") + "</button>";
        }).join("") + "</div>";
        namesEl.querySelectorAll(".np-name-i").forEach(b => {
          b.onclick = () => {
            const n = list[+b.dataset.i];
            nameInp2.value = (n && (n.name || n)) || "";
            renderNameSel();
            refresh();
          };
        });
        renderNameSel();
      }
      function renderNameSel() {
        const cur = nameInp2.value.trim();
        namesEl.querySelectorAll(".np-name-i").forEach(b => {
          const t = b.querySelector(".np-name-t");
          b.classList.toggle("on", !!t && t.textContent === cur);
        });
      }
      async function confirmRename() {
        if (busy) return;
        const target = (buildResult && buildResult.temp_path) || "";
        if (!target) { close(null); return; }
        const name = nameInp2.value.trim().replace(/^\/+|\/+$/g, "");
        busy = true;
        say("", false);
        refresh();
        try {
          const r = await fetch("/api/projects/rename", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target, name: name }),   // name 为空 = 保持临时目录名
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) throw new Error(d.error || ("HTTP " + r.status));
          close(d.path || target);
        } catch (e) {
          say("重命名失败：" + (e.message || e), true);
        } finally {
          busy = false;
          refresh();
        }
      }

      // 最后一步：真正建项目（内置模板直接写文件；AI 模板先用 28 位哈希目录，建完再起名）
      async function startCreate() {
        if (busy) return;
        const rawParent = locInp.value.trim();
        const isAI = tpl === AI_TPL;
        const brief = briefInp.value.trim();
        const name = isAI ? "" : cleanName();     // AI 模板不带名字：后端先给 28 位哈希临时名
        page = "run";
        runErr = false;
        buildResult = null;              // 重新构建：清掉上一次的结果
        busy = true;
        abortCtrl = new AbortController();
        cancelBtn.textContent = "中断";
        say("", false);
        treeEl.innerHTML = "";
        TREE = null;
        PLAN_PATHS = [];
        liveReset();
        tasksReset();
        progNum.textContent = "";
        runTitle.textContent = isAI ? "正在让 AI 构建项目…" : "正在构建项目…";
        syncPages();
        progIcon("loading");
        progMsg.textContent = tpl === AI_TPL ? "正在让 AI 生成项目代码，请稍候…" : "正在创建项目…";
        stepT0 = {};                      // 每步耗时重新计
        stepMs = {};
        startRunTimer();                  // 总耗时开始计时
        // 先用本地默认步骤把步骤条画出来（后端会立刻用 steps 事件覆盖，避免闪空）
        renderSteps(STEP_ALL.filter(s =>
          tpl === AI_TPL ? (s.id === "check" || s.id === "ai" || s.id === "naming" || s.id === "done")
                         : (s.id !== "ai" && s.id !== "naming")));

        let result = null;
        try {
          await createStream({
            parent: rawParent.replace(/\/+$/, "") || "/", name, template: tpl, brief,
            provider_id: aiPick ? aiPick.provider_id : "",   // 空 = 跟随「设置 → 系统 AI」
            model: aiPick ? aiPick.model : "",
          }, evt => {
            if (evt.stage === "steps") {
              renderSteps(evt.steps || []);
            } else if (evt.stage === "step") {
              setStep(evt.id, evt.state || "run", evt.msg || "");
              if (evt.id === "ai" && evt.state === "run") {
                liveShow();                              // 先把思考链面板亮出来，别留一块空白
                liveN.textContent = "等待模型响应…";
              }
              if (evt.id === "naming") {
                if (evt.state === "run") runTitle.textContent = "代码写完了，正在给项目起名…";
                else if (evt.state === "ok") runTitle.textContent = "已给项目起好名字";
              }
              if (evt.id === "files" && evt.state === "run" && PLAN_PATHS[0]) {
                markPath(PLAN_PATHS[0], "run", true);   // 高亮「正在写的那一个」
              }
            } else if (evt.stage === "think") {
              livePush(evt);                             // 模型的思考片段 / 正文进度
            } else if (evt.stage === "plan") {
              liveDone();
              TREE = buildTree(evt.items || evt.files || [], evt.dirs || []);
              PLAN_PATHS = (evt.items || evt.files || [])
                .map(it => (typeof it === "string" ? it : it.path)).filter(Boolean);
              renderTree();
              tasksPlan(PLAN_PATHS);                     // 右栏「AI 任务单」
              progNum.textContent = "0 / " + (evt.n || 0);
              // 顺带把前面的步骤标完成：即便后端是旧版本（只发 plan/file 不发 step），步骤条也不会一直灰着。
              // 注意 AI 模板的「Agent 构建」要等文件全写完才结束，不能在这里标 ok。
              setStep("check", "ok");
              if (tpl !== AI_TPL) setStep("tree", "ok");
            } else if (evt.stage === "dir") {
              markPath(evt.path, "ok", true);
              setStep("dirs", "run");
              progMsg.textContent = "创建目录 " + evt.i + " / " + evt.n + "：" + evt.path;
            } else if (evt.stage === "gen") {
              // 逐文件生成：先把「正在写的那个」点亮，等待期间也有明确进度
              if (ensurePath(evt.path)) renderTree();
              markPath(evt.path, "run", true);
              progMsg.textContent = "正在生成 " + evt.i + " / " + evt.n + "：" + evt.path;
              progNum.textContent = (evt.i - 1) + " / " + evt.n;
              // 思考面板换成本文件的开头，接着流式显示这个文件的思考 / 正文进度
              liveRestart("正在写 " + evt.path.split("/").pop() + "（" + evt.i + "/" + evt.n + "）");
              setStep("files", "run");
            } else if (evt.stage === "file") {
              if (ensurePath(evt.path)) renderTree();   // 树里还没有这个文件 → 补上再点亮
              markPath(evt.path, evt.ok ? "ok" : "bad", true);
              tasksMark(evt.path);                      // 任务单里勾掉这个文件
              const nxt = PLAN_PATHS[PLAN_PATHS.indexOf(evt.path) + 1];
              if (nxt) markPath(nxt, "run", false);
              progNum.textContent = (evt.i || 0) + " / " + (evt.n || 0);
              progMsg.textContent = (evt.ok ? "写入 " : "写入失败 ") + evt.path;
              setStep("dirs", "ok");
              setStep("files", "run");
            } else if (evt.stage === "done") {
              result = evt;
              markLeftover();                           // 规划了但模型没写的文件，标出来别一直灰着
              setStep("files", "ok");
              setStep("done", "ok");
            } else if (evt.stage === "error") {
              result = { error: evt.msg, need_config: evt.need_config };
            }
          }, abortCtrl.signal);

          if (!result) throw new Error("连接中断，未能确认创建结果，请刷新页面查看");
          if (result.error) {
            runErr = true;
            stopRunTimer();
            progIcon("err");
            progMsg.textContent = "失败：" + result.error;
            say(result.error, true);
            return;
          }
          const nok = (result.written || []).length;
          const nskip = (result.skipped || []).length;
          const totalMs = stopRunTimer();          // 停表并把总耗时写回标题右侧
          progIcon("ok");
          progMsg.textContent = "完成：" + (result.dirs || []).length + " 个目录 / " + nok +
            " 个文件 · " + fmtSize(result.bytes || 0) +
            (nskip ? "（跳过 " + nskip + " 个）" : "") + " · 总耗时 " + fmtSec(totalMs);
          progNum.textContent = nok + " / " + nok;
          tasksN.textContent = TASK_N + " / " + TASK_N;
          // 不直接打开：进入「项目名」这一步，由用户确认 / 修改后再重命名
          buildResult = result;
          fillNames(result);
          page = "name";
          await new Promise(r => setTimeout(r, 420));   // 让「完成」状态停留一下
          syncPages();
        } catch (e) {
          runErr = true;
          stopRunTimer();
          if (e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")))) {
            progIcon("err");
            progMsg.textContent = "已中断：已建好的目录和文件会保留";
            say("已中断这次创建", true);
          } else {
            progIcon("err");
            progMsg.textContent = "创建失败：" + (e.message || e);
            say("创建失败：" + (e.message || e), true);
          }
        } finally {
          busy = false;
          abortCtrl = null;
          cancelBtn.textContent = "取消";
          if (!runErr) runTitle.textContent = "构建完成";
          syncPages();                  // 恢复向导按钮 / 步骤条状态
        }
      }

      box.querySelector(".np-pick").onclick = async () => {
        const cur = locInp.value.trim();
        const picked = await pickFolderDialog(cur.startsWith("/") ? cur : (ROOT || "/"), {
          title: "选择项目位置",
          okText: "选择此文件夹",
          hint: "单击文件夹进入下一级；确认后把当前位置作为项目的创建位置。",
        });
        if (picked && picked.path) { locInp.value = picked.path; refresh(); gotoPage("tpl"); }  // 选好目录 → 直接进下一步
      };
      locInp.addEventListener("input", refresh);
      nameInp.addEventListener("input", refresh);
      nameInp2.addEventListener("input", () => { renderNameSel(); refresh(); });
      briefInp.addEventListener("input", refresh);
      okBtn.onclick = onNext;
      backBtn.onclick = () => {
        if (busy) return;
        const pages = pagesOf();
        const i = pages.indexOf(page);
        if (i > 0) gotoPage(pages[i - 1]);
      };
      renderTpls();
      loadTpls();
      loadModels();
      // 创建过程中「取消」变成「中断」：立刻掐断 SSE，已建好的目录/文件保留（不会回滚误删）
      cancelBtn.onclick = () => {
        if (busy) {
          try { if (abortCtrl) abortCtrl.abort(); } catch (e) { /* 忽略 */ }
          return;
        }
        close(null);
      };
      // 关闭只认右上角那个按钮（外加 Esc），并且都要过一层二次确认；
      // 点弹窗外的遮罩一律不关 —— 这里显式置空，防止别的弹窗遗留的遮罩点击处理器进来。
      box.querySelector(".m-x").onclick = askClose;
      ov.onmousedown = null;
      // 键盘绑到 document：焦点不在弹窗里时 Esc / 回车照样生效（绑在 ov 上要靠焦点，经常失灵）
      onKey = (e) => {
        if (!ov.classList.contains("show")) return;
        if (!cfEl.hidden) {                       // 确认框开着：Esc / 回车都等于「继续填写」
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault(); e.stopPropagation(); hideConfirm();
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          askClose();                             // Esc 也走二次确认，不再直接关
        } else if (e.key === "Enter" && e.target !== briefInp) {
          e.preventDefault();                      // 描述框里回车用来换行，不直接提交
          onNext();
        }
      };
      document.addEventListener("keydown", onKey, true);
      locInp.value = (ROOT || recentFolders()[0] || "").replace(/\/+$/, "");
      syncPages();                                 // 从第一步「位置」开始
    });
  }

  /* 新建项目入口：建好后记为最近打开，并直接把新项目作为「当前项目」打开。
     不再用「添加文件夹到工作区」的方式挂到原项目里 —— 那样新项目会显示成原项目的
     一个子分区（资源管理器里出现「原项目（+1 个项目）」），看起来不像打开了新项目。 */
  async function newProjectFlow() {
    await loadRecentFolders();
    const path = await newProjectDialog();
    if (!path) return;
    addRecentFolder(path);
    // 同名目录如果之前被加进过工作区，先摘掉，避免同一个目录显示两次
    if (typeof extraRoots !== "undefined" && extraRoots.indexOf(path) >= 0) removeWorkspaceFolder(path);
    location.href = "/ide?path=" + encodeURIComponent(path);   // 切换到新项目（与「打开文件夹」一致）
  }

  // 在项目根目录新建（文件菜单 / Ctrl+N / 命令面板 / 侧边栏按钮共用）：
  // 统一走树内联输入（仿 VS Code），不再弹模态框
  async function newInRoot(isDir) { return treeInlineCreate(ROOT, isDir); }
  $("sideNewFile").onclick = () => newInRoot(false);
  $("sideNewFolder").onclick = () => newInRoot(true);
  $("sideTreeToggle").onclick = () => {
    if (treeHasOpenDirs()) treeCollapseAll(); else treeExpandAll();
  };
  // 启动时按恢复的「显示全部」状态同步眼睛按钮样式（图标/高亮/悬浮提示）
  (() => {
    const btn = $("sideShowAll");
    if (!btn) return;
    const on = showAllFiles || showHidden;
    btn.querySelector("i").className = on ? "bi bi-eye" : "bi bi-eye-slash";
    btn.classList.toggle("on", on);
    btn.title = on ? "隐藏全部（依赖目录与隐藏文件）" : "显示全部（含 node_modules、.gitignore 等）";
  })();
  $("sideShowAll").onclick = () => {
    showAllFiles = !showAllFiles;
    showHidden = !showHidden;
    ideSettingSet("showAllFiles", showAllFiles);   // 写入全局设置 JSON，永久记住
    const btn = $("sideShowAll");
    const on = showAllFiles || showHidden;
    btn.querySelector("i").className = on ? "bi bi-eye" : "bi bi-eye-slash";
    btn.classList.toggle("on", on);
    btn.title = on ? "隐藏全部（依赖目录与隐藏文件）" : "显示全部（含 node_modules、.gitignore 等）";
    refreshTree(ROOT);
  };
  $("tbSave").onclick = () => { if (active) saveTab(active); };

