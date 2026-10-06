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
            const full = it.path || (cur === "/" ? "/" + it.name : cur + "/" + it.name);
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
      box.querySelector(".m-ok").onclick = () => close(cur);
      ov.onmousedown = (e) => { if (e.target === ov) close(null); };
      ov.onkeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter") { e.preventDefault(); close(cur); }
      };
      renderRecent();
      go(cur);
      box.querySelector(".m-ok").focus();
    });
  }

  async function openFolderDialog() {
    await loadRecentFolders();                       // 「最近」列表用于快速跳转
    const path = await pickFolderDialog(ROOT || recentFolders()[0] || "/");
    if (!path) return;
    try {
      const r = await fetch("/api/files?path=" + encodeURIComponent(path));
      const d = await r.json();
      if (d.error) { toast("无法打开：" + d.error, "err"); return; }
      addRecentFolder(path);
      // 已有主项目：不再跳转，而是把新文件夹「添加为第二个项目」，与主项目在资源管理器同级显示
      if (ROOT) { addWorkspaceFolder(path); return; }
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
        '<div class="m-title"><i class="bi bi-diagram-3"></i><span>新建项目</span></div>' +
        '<div class="m-body">' +
          '<div class="np-row"><span class="np-lb">位置</span>' +
            '<div class="np-loc">' +
              '<input class="np-loc-input" spellcheck="false" autocomplete="off" placeholder="项目创建在哪个目录，如 /home/you/Desktop/CODE">' +
              '<button class="np-pick" title="浏览文件夹…"><i class="bi bi-folder2-open"></i></button>' +
            "</div>" +
          "</div>" +
          '<div class="np-row"><span class="np-lb">项目名</span>' +
            '<input class="np-name-input" spellcheck="false" autocomplete="off" placeholder="my-project">' +
          "</div>" +
          '<div class="np-row np-row-tpl"><span class="np-lb">初始框架</span>' +
            '<div class="np-tpl"></div>' +
          "</div>" +
          '<div class="np-row np-brief-row" hidden><span class="np-lb"></span>' +
            '<input class="np-brief" spellcheck="false" autocomplete="off" placeholder="✨ 一句话描述你的项目，如：一个带用户登录和 SQLite 的 Flask 博客">' +
          "</div>" +
          '<div class="np-preview">即将创建：<b class="np-preview-path">—</b></div>' +
          '<div class="np-tip"><i class="bi bi-info-circle"></i>位置可选系统任意可用目录（不受当前工作区限制），不存在时会自动逐级创建。</div>' +
          '<div class="np-prog" hidden>' +
            '<div class="np-prog-hd"><span class="np-prog-ic"><i class="bi bi-hourglass-split"></i></span>' +
              '<span class="np-prog-msg"></span></div>' +
            '<div class="np-prog-list"></div>' +
          "</div>" +
          '<div class="np-msg"></div>' +
        "</div>" +
        '<div class="m-foot"><button class="m-cancel">取消</button>' +
        '<button class="m-ok">创建并打开</button></div>';
      ov.innerHTML = "";
      ov.appendChild(box);
      ov.classList.add("show");
      const locInp = box.querySelector(".np-loc-input");
      const nameInp = box.querySelector(".np-name-input");
      const tplsEl = box.querySelector(".np-tpl");
      const briefRow = box.querySelector(".np-brief-row");
      const briefInp = box.querySelector(".np-brief");
      const progEl = box.querySelector(".np-prog");
      const progIc = box.querySelector(".np-prog-ic");
      const progMsg = box.querySelector(".np-prog-msg");
      const progList = box.querySelector(".np-prog-list");
      const previewEl = box.querySelector(".np-preview-path");
      const msgEl = box.querySelector(".np-msg");
      const okBtn = box.querySelector(".m-ok");
      const close = (val) => { ov.classList.remove("show"); ov.innerHTML = ""; ov.onkeydown = null; resolve(val); };

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

      function renderTpls() {
        tplsEl.innerHTML = TPLS.map(t =>
          '<button type="button" class="np-tpl-i' + (t.key === tpl ? " on" : "") +
            '" data-k="' + esc(t.key) + '" title="' + esc(t.hint || t.label) + '">' +
            '<i class="bi ' + esc(t.icon || "bi-folder2") + '"></i>' + esc(t.label) + "</button>").join("");
        tplsEl.querySelectorAll(".np-tpl-i").forEach(b => {
          b.onclick = () => {
            tpl = b.dataset.k;
            renderTpls();
            refresh();
            if (tpl === AI_TPL) briefInp.focus();
          };
        });
      }

      function loadTpls() {
        fetch("/api/projects/templates")
          .then(r => r.json())
          .then(d => {
            if (d && d.templates && d.templates.length) { TPLS = d.templates; renderTpls(); refresh(); }
          })
          .catch(() => { /* 拉不到就保持只有「空项目」，不影响创建 */ });
      }

      function refresh() {
        const p = locInp.value.trim();
        previewEl.textContent = targetOf() || "—";
        briefRow.hidden = (tpl !== AI_TPL);          // 只有选「AI 生成」才要描述
        okBtn.disabled = !p.startsWith("/") || !!nameError(cleanName()) ||
                         (tpl === AI_TPL && !briefInp.value.trim());
      }

      // ---- 创建进度：逐条列出框架里的文件，边写边点亮 ----
      let progRows = {};
      function progReset() {
        progRows = {};
        progList.innerHTML = "";
        progMsg.textContent = "";
        progIc.className = "np-prog-ic";
        progIc.innerHTML = '<i class="bi bi-hourglass-split"></i>';
        progEl.hidden = true;
      }
      function progShow(msg) {
        progEl.hidden = false;
        if (msg) progMsg.textContent = msg;
      }
      function progPlan(files) {
        progRows = {};
        progList.innerHTML = "";
        files.forEach(p => {
          const row = document.createElement("div");
          row.className = "np-prog-i";
          row.innerHTML = '<i class="bi bi-circle"></i><span></span>';
          row.querySelector("span").textContent = p;       // 用 textContent 塞路径，避免注入
          progList.appendChild(row);
          progRows[p] = row;
        });
      }
      function progFile(path, ok) {
        const row = progRows[path];
        if (!row) return;
        row.classList.add(ok ? "ok" : "bad");
        row.querySelector("i").className = "bi " + (ok ? "bi-check-circle-fill" : "bi-exclamation-circle-fill");
      }

      // 流式创建：后端按 SSE 逐步回报阶段，这里逐帧回调
      async function createStream(payload, onEvent) {
        const resp = await fetch("/api/projects/create-stream", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

      async function submit() {
        if (busy) return;
        const rawParent = locInp.value.trim();
        const name = cleanName();
        if (!rawParent) { say("请选择项目要创建在哪个目录", true); locInp.focus(); return; }
        if (!rawParent.startsWith("/")) { say("位置必须是绝对路径", true); locInp.focus(); return; }
        const bad = nameError(name);
        if (bad) { say(bad, true); nameInp.focus(); return; }
        const brief = briefInp.value.trim();
        if (tpl === AI_TPL && !brief) { say("请先用一句话描述你的项目", true); briefInp.focus(); return; }
        busy = true;
        okBtn.disabled = true;
        okBtn.textContent = tpl === AI_TPL ? "AI 生成中…" : "创建中…";
        say("", false);
        progReset();
        progShow(tpl === AI_TPL ? "正在让 AI 规划项目结构，请稍候…" : "正在创建项目…");
        if (tpl === AI_TPL) progIc.className = "np-prog-ic loading";
        let result = null;
        try {
          await createStream({
            parent: rawParent.replace(/\/+$/, "") || "/", name, template: tpl, brief,
          }, evt => {
            if (evt.stage === "ai") {
              progIc.className = "np-prog-ic loading";
              progShow(evt.msg);
            } else if (evt.stage === "plan") {
              progIc.className = "np-prog-ic";
              progShow(evt.msg);
              progPlan(evt.files || []);
            } else if (evt.stage === "file") {
              progFile(evt.path, evt.ok);
              progShow("正在创建 " + evt.i + " / " + evt.n + "：" + evt.path);
            } else if (evt.stage === "done") {
              result = evt;
            } else if (evt.stage === "error") {
              result = { error: evt.msg, need_config: evt.need_config };
            }
          });
          if (!result) { say("连接中断，未能确认创建结果，请刷新页面查看", true); return; }
          if (result.error) {
            progIc.className = "np-prog-ic err";
            progIc.innerHTML = '<i class="bi bi-x-circle-fill"></i>';
            progShow("失败：" + result.error);
            say(result.error, true);
            return;
          }
          const nok = (result.written || []).length;
          const nskip = (result.skipped || []).length;
          progIc.className = "np-prog-ic ok";
          progIc.innerHTML = '<i class="bi bi-check-circle-fill"></i>';
          progShow("完成：创建 " + nok + " 个文件" + (nskip ? "，跳过 " + nskip + " 个" : ""));
          await new Promise(r => setTimeout(r, 450));   // 让「完成」状态停留一下，便于看清
          close(result.path);                           // 成功后把新路径交回调用方去打开
        } catch (e) {
          say("创建失败：" + (e.message || e), true);
        } finally {
          busy = false;
          okBtn.disabled = false;
          okBtn.textContent = "创建并打开";
        }
      }

      box.querySelector(".np-pick").onclick = async () => {
        const cur = locInp.value.trim();
        const picked = await pickFolderDialog(cur.startsWith("/") ? cur : (ROOT || "/"), {
          title: "选择项目位置",
          okText: "选择此文件夹",
          hint: "单击文件夹进入下一级；确认后把当前位置作为项目的创建位置。",
        });
        if (picked) { locInp.value = picked; refresh(); nameInp.focus(); }
      };
      locInp.addEventListener("input", refresh);
      nameInp.addEventListener("input", refresh);
      briefInp.addEventListener("input", refresh);
      okBtn.onclick = submit;
      renderTpls();
      loadTpls();
      box.querySelector(".m-cancel").onclick = () => close(null);
      ov.onmousedown = (e) => { if (e.target === ov) close(null); };
      ov.onkeydown = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
        else if (e.key === "Enter") { e.preventDefault(); submit(); }
      };
      locInp.value = (ROOT || recentFolders()[0] || "").replace(/\/+$/, "");
      refresh();
      nameInp.focus();
    });
  }

  /* 新建项目入口：建好后记为最近打开，并按当前情况打开
     （没有主项目 → 直接跳转；已有主项目 → 追加为工作区里的第二个项目，与「打开文件夹」一致） */
  async function newProjectFlow() {
    await loadRecentFolders();
    const path = await newProjectDialog();
    if (!path) return;
    addRecentFolder(path);
    if (ROOT) { addWorkspaceFolder(path); return; }
    location.href = "/ide?path=" + encodeURIComponent(path);
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

