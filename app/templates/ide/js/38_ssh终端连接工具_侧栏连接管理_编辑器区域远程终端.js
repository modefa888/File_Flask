/* ============================================================================
 * 38_ SSH 终端连接工具：侧栏连接管理 + 编辑器区远程终端（仿 Xshell / FinalShell）
 *
 *   · 侧栏列出已保存的远程主机，可新建 / 编辑 / 复制 / 删除、一键连接；
 *   · 点击「连接」在右侧编辑器区打开一个真正的 PTY 终端（xterm.js），
 *     通过 SSE 收远端输出、POST 转发本地按键，支持 resize；
 *   · 连接信息（密码 / 私钥）加密保存在本机，前端提交经 transport 层再落库。
 *  后端：app/routes/ide/sshconn.py（paramiko）。
 *  本文件 include 在 16_ 之前，可复用闭包内的 showPanel / panels / activate /
 *  findTab / renderTabsAll / tabs / toast / esc / escAttr / uiConfirm 等。
 * ========================================================================== */
(function () {
  "use strict";

  // 注册侧栏面板（与插件系统一致：panels[id] 指向对应 .side-panel 的 id）
  if (typeof panels !== "undefined") panels.sshconn = "sshconnPanel";
  if (typeof titles !== "undefined") titles.sshconn = "终端连接";

  const SSH_VIEW_PREFIX = "\u0000ssh:";        // 编辑器区终端 tab 的 path 前缀（不可见字符，避免与文件路径冲突）
  const SESS = {};                          // sid -> { term, fit, es, cols, rows, tab }
  const SSHC = { conns: [], editing: null, paramiko: true };

  function api(path, opts) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts))
      .then(r => r.json()).catch(() => ({ error: "请求失败" }));
  }
  function base64ToBytes(b64) {
    const bin = atob(b64), len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- 侧栏列表 ---------------- */
  async function loadSshConns() {
    const d = await api("/api/ssh/list", { method: "GET" });
    if (d.error) { toast(d.error, "err"); return; }
    SSHC.conns = d.connections || [];
    SSHC.paramiko = d.paramiko !== false;
    renderSshList();
    // 首次加载完成后，恢复上次刷新前打开的 SSH 终端标签（自动重连；只做一次，手动点刷新不重复触发）
    if (!SSHC.restored) {
      SSHC.restored = true;
      setTimeout(sshSessionRestore, 0);              // 等本调用栈收尾，避免和其它模块的会话恢复抢布局
    }
  }
  function renderSshList() {
    const box = $("sshList");
    if (!box) return;
    if (!SSHC.paramiko) {
      box.innerHTML = '<div class="ph warn">后端未安装 paramiko，无法连接远程主机。\n请执行 <code>pip install paramiko</code> 后重启服务。</div>';
      return;
    }
    if (!SSHC.conns.length) {
      box.innerHTML = '<div class="ph">还没有 SSH 连接。<br>点上方「新建连接」添加一台远程主机（host / 端口 / 用户 / 密码或私钥）。</div>';
      return;
    }
    box.innerHTML = "";
    SSHC.conns.forEach(c => {
      const open = !!findTab(SSH_VIEW_PREFIX + c.id);
      const item = document.createElement("div");
      item.className = "ssh-item" + (open ? " open" : "");
      item.dataset.id = c.id;
      item.innerHTML =
        '<div class="ssh-main">' +
          '<i class="bi bi-hdd-network"></i>' +
          '<div class="ssh-meta">' +
            '<div class="ssh-name">' + esc(c.name) + '</div>' +
            '<div class="ssh-sub">' + esc(c.user || "root") + '@' + esc(c.host) + ':' + esc(String(c.port || 22)) +
              (c.remark ? ' · ' + esc(c.remark) : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ssh-acts">' +
          (open
            ? '<button data-act="open" title="断开并关闭终端" class="ssh-stop"><i class="bi bi-stop-fill"></i></button>'
            : '<button data-act="open" title="连接并打开终端"><i class="bi bi-play-fill"></i></button>') +
          '<button data-act="edit" title="编辑"><i class="bi bi-pencil-square"></i></button>' +
          '<button data-act="dup" title="复制连接"><i class="bi bi-files"></i></button>' +
          '<button data-act="del" title="删除"><i class="bi bi-trash"></i></button>' +
        '</div>';
      item.querySelector('[data-act="open"]').onclick = () => {
        if (!open) { connectSsh(c); return; }
        // 已打开：按钮变成「停止」，断开会话并关闭对应终端标签
        const tab = findTab(SSH_VIEW_PREFIX + c.id);
        if (!tab) return;
        if (typeof closeTab === "function") { closeTab(tab); return; }
        try { if (typeof tab.onBeforeClose === "function") tab.onBeforeClose(); } catch (e) { /* 忽略 */ }
        try { tab.host.remove(); } catch (e) { /* 忽略 */ }
        const i = tabs.indexOf(tab);
        if (i >= 0) tabs.splice(i, 1);
        renderTabsAll();
      };
      item.querySelector('[data-act="edit"]').onclick = () => openSshEditor(c);
      item.querySelector('[data-act="dup"]').onclick = () => openSshEditor(Object.assign({}, c, { id: "", name: c.name + " 副本" }));
      item.querySelector('[data-act="del"]').onclick = () => deleteSsh(c);
      box.appendChild(item);
    });
  }

  /* ---------------- 连接 / 编辑器区终端 ---------------- */

  /* ---------- 会话持久化：已打开的 SSH 终端标签 ----------
     通用会话恢复（00_preamble 的 sessionSaveTabs）跳过了 SSH 终端（刷新后连接已断开），
     这里单独记一份「打开的连接 id」到 localStorage；刷新后等连接列表加载完，
     按原顺序逐个重连，还原打开状态。 */
  const SSH_OPEN_KEY = "ide.session.sshTabs";
  function sshSessionAllowed() {
    return (typeof ideSettingGet !== "function") || !!ideSettingGet("restoreSession", true);
  }
  function sshSessionSave() {
    if (!sshSessionAllowed()) return;
    try {
      const ids = tabs.filter(t => t && t.isSshTerm && t.connId).map(t => t.connId);
      localStorage.setItem(SSH_OPEN_KEY, JSON.stringify(ids));
    } catch (_) { /* localStorage 不可用则放弃 */ }
  }
  function sshSessionRestore() {
    if (!sshSessionAllowed() || !SSHC.paramiko) return;
    // 先清掉历史遗留的「SSH 假标签」：旧版会话快照恢复出来的 ssh:<id> 空白标签
    // （名字 / 图标都是路径，不是真正的终端），不清理会和重连出来的真标签并存
    const stale = tabs.filter(t => t && !t.isSshTerm &&
      /^[\u0000-\u001f]*ssh:[^/]*$/i.test(String(t.path || "")));
    if (stale.length) {
      stale.forEach(t => {
        try { t.host.remove(); } catch (e) { /* 忽略 */ }
        const i = tabs.indexOf(t);
        if (i >= 0) tabs.splice(i, 1);
      });
      renderTabsAll();
      if (typeof sessionSaveTabs === "function") sessionSaveTabs();
    }
    let ids;
    try { ids = JSON.parse(localStorage.getItem(SSH_OPEN_KEY) || "[]"); } catch (_) { return; }
    if (!Array.isArray(ids) || !ids.length) return;
    ids.forEach(id => {
      const c = SSHC.conns.find(x => x && x.id === id);
      if (c) connectSsh(c);                        // 已打开的会被 connectSsh 去重，只聚焦不重复建连
    });
  }

  async function connectSsh(c) {
    const tab = findTab(SSH_VIEW_PREFIX + c.id);
    if (tab) { activate(tab); return; }            // 已打开则聚焦
    const r = await api("/api/ssh/open", { method: "POST", body: JSON.stringify({ id: c.id }) });
    if (r.error) { toast(r.error, "err"); return; }
    openSshTermTab(c, r.id);
  }

  function openSshTermTab(c, sid) {
    const path = SSH_VIEW_PREFIX + c.id;
    const host = document.createElement("div");
    host.className = "cm-host ssh-host";
    // 标签名清掉控制字符（\u0000 会被浏览器画成方框），空则退回 user@host
    let tn = String(c.name == null ? "" : c.name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!tn || /^ssh:/.test(tn)) tn = (c.user || "root") + "@" + (c.host || "远程主机");
    const tab = {
      path: path, name: tn, host: host,
      iconHtml: '<i class="bi bi-hdd-network"></i>',
      isSshTerm: true, connId: c.id,
    };
    tabs.push(tab);
    renderTabsAll();
    buildSshTerm(tab, c, sid);
    activate(tab);
    sshSessionSave();
  }

  // 终端配色跟随界面主题（白天 / 黑夜），<html>.theme-light 由设置页切换
  function sshIsLight() { return document.documentElement.classList.contains("theme-light"); }
  function sshTermTheme() {
    return sshIsLight()
      ? { background: "#ffffff", foreground: "#333333", cursor: "#333333", cursorAccent: "#ffffff",
          selectionBackground: "#add6ff",
          black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
          blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
          brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00",
          brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5" }
      : { background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4",
          selectionBackground: "#264f78", black: "#1e1e1e", brightBlack: "#666" };
  }

  function buildSshTerm(tab, c, sid) {
    const wrap = document.createElement("div");
    wrap.className = "ssh-term-wrap";
    const bar = document.createElement("div");
    bar.className = "ssh-term-bar";
    bar.innerHTML = '<span class="ssh-term-t"><i class="bi bi-hdd-network"></i> ' +
      esc(tab.name) + ' · ' + esc(c.user || "root") + '@' + esc(c.host) + ':' + esc(String(c.port || 22)) + '</span>';
    const aiBtn = document.createElement("button");
    aiBtn.className = "ssh-term-ai";
    aiBtn.innerHTML = (window.TermAI && window.TermAI.icon)
      ? window.TermAI.icon("bi-stars") + '<span>AI</span>'
      : '<i class="bi bi-stars"></i> AI';
    aiBtn.title = "AI 助手：用中文描述要执行的命令，判断风险并解读输出（Ctrl+Shift+I）";
    bar.appendChild(aiBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "ssh-term-x";
    closeBtn.innerHTML = '<i class="bi bi-x-lg"></i>';
    closeBtn.title = "断开并关闭";
    bar.appendChild(closeBtn);

    const termBox = document.createElement("div");
    termBox.className = "ssh-term-box";
    wrap.appendChild(bar);
    wrap.appendChild(termBox);
    tab.host.appendChild(wrap);

    const term = new Terminal({
      fontSize: 13, fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      cursorBlink: true, scrollback: 5000,
      theme: sshTermTheme(),
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termBox);
    try { fit.fit(); } catch (e) { /* 容器未布局时忽略 */ }

    const sess = SESS[sid] = { term, fit, es: null, cols: term.cols, rows: term.rows, tab: tab, alive: true };
    tab.sshSid = sid;                              // 侧栏「常用命令」通过 tab 找到当前会话
    // 用真实尺寸纠正后端 PTY 大小
    api("/api/ssh/resize", { method: "POST", body: JSON.stringify({ id: sid, cols: term.cols, rows: term.rows }) });

    /* ---------- AI 助手支撑：输出回读 + 人话拦截 ---------- */
    sess.dec = new TextDecoder();
    // 执行 AI 给出的命令后，把远端输出收集起来交给模型解读：
    // 首包到达后按「1.8s 无新输出」判定命令结束；一直没输出则 8s 结束；最长 20s 兜底。
    function sshRun(cmd) {
      return new Promise((resolve) => {
        const cap = { text: "", done: false, idle: null, max: null };
        const finish = () => {
          if (cap.done) return;
          cap.done = true;
          clearTimeout(cap.idle);
          clearTimeout(cap.max);
          if (sess.capture === cap) sess.capture = null;
          const raw = cap.text;
          const clean = (window.TermAI && window.TermAI.stripAnsi)
            ? window.TermAI.stripAnsi(raw) : raw;
          resolve({ stdout: clean, stderr: "", exit_code: null });
        };
        cap.finish = finish;
        sess.capture = cap;
        cap.idle = setTimeout(finish, 8000);                 // 完全没有输出
        cap.max = setTimeout(finish, 20000);                 // 长任务兜底
        api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: cmd + "\r" }) })
          .catch(() => finish());
      });
    }

    function aiOpts(prefill) {
      return {
        label: (c.user || "root") + "@" + c.host,
        env: "远程主机 " + (c.user || "root") + "@" + c.host + ":" + (c.port || 22) + "（SSH 连接的远程 Linux 服务器）",
        prefill: prefill || "",
        run: sshRun,
        paste: (cmd) => {
          api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: cmd }) });
          try { term.focus(); } catch (e) { /* 忽略 */ }
        },
      };
    }
    /* ---------- AI 助手：右上角「AI」按钮打开可拖动的浮动面板 ---------- */
    function openAi(prefill) {
      if (!window.TermAI || typeof window.TermAI.openSsh !== "function") {
        toast("AI 模块未加载，请刷新页面后重试", "err");
        return;
      }
      const cur = $("taiPop");
      if (cur) {                                    // 已打开：带上这句话并聚焦
        const ta = cur.querySelector(".tai-pop-in");
        if (ta) {
          if (prefill) { ta.value = prefill; try { ta.setSelectionRange(prefill.length, prefill.length); } catch (e) {} }
          ta.focus();
        }
        return;
      }
      window.TermAI.openSsh(aiOpts(prefill || ""));
    }
    aiBtn.onclick = () => openAi("");
    // Ctrl+Shift+I：有面板就关，没有就打开（44_ 里的全局快捷键调用这里）
    tab.aiToggleMode = () => { if ($("taiPop")) window.TermAI.close(); else openAi(""); };

    // 本地跟踪当前输入行：中文需求回车不再丢给远端（远端会报 command not found），
    // 而是用 Ctrl+U 撤掉这一行并唤起 AI 面板。
    let lineBuf = "";
    function sendInput(d) {
      if (d.indexOf("\r") >= 0) {
        const text = (lineBuf + d.split("\r")[0]).replace(/\u007f/g, "");
        lineBuf = "";
        if (text.trim() && window.TermAI && window.TermAI.sshNatural(text)) {
          api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: "\u0015" }) });
          setTimeout(() => openAi(text.trim()), 80);
          return;                                        // 不把回车发给远端
        }
      } else if (d === "\u007f" || d === "\b") {
        lineBuf = lineBuf.slice(0, -1);
      } else if (d.charAt(0) === "\u001b") {
        lineBuf = "";                                    // 方向键 / 历史命令：跟踪失效，放弃这一行
      } else if (d >= " ") {
        lineBuf = (lineBuf + d).slice(-300);
      }
      api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: d }) });
    }
    term.onData(sendInput);

    /* ---------- 复制 / 粘贴支持 ----------
       xterm 默认把 Ctrl+V / Ctrl+C 当普通按键发给远端（出现 ^V / ^C）。
       本页多为 HTTP（navigator.clipboard 不可用），所以：
       · Ctrl+V 只拦下不让 ^V 发出去，粘贴交给浏览器原生 paste 事件 → xterm onData → 远端；
       · Ctrl+C 只复制（有选中时），不再发 ^C；中断改由 Ctrl+Z 发送（发 \x03 给远端）。 */
    function sshCopySel() {
      const sel = term.getSelection();
      if (!sel) return false;
      if (typeof copyText === "function") copyText(sel);   // 项目统一的复制（HTTP 下有 execCommand 兜底）
      else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sel).catch(() => {});
      try { term.clearSelection(); } catch (e) { /* 忽略 */ }
      return true;
    }
    function sshPaste(text) {
      if (!text) return;
      sendInput(text.replace(/\r\n/g, "\r").replace(/\n/g, "\r"));
      try { term.focus(); } catch (e) { /* 忽略 */ }
    }
    // 右键菜单「粘贴」用：HTTPS 下读系统剪贴板；HTTP 下读不到，提示直接按 Ctrl+V
    function sshReadClipboard() {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(sshPaste).catch(() => toast("浏览器拒绝了剪贴板读取，请直接按 Ctrl+V 粘贴", "warn"));
      } else {
        toast("HTTP 页面无法读取系统剪贴板，请直接按 Ctrl+V 粘贴", "info");
      }
    }
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== "keydown") return true;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && !ev.altKey && (ev.key === "c" || ev.key === "C")) {
        sshCopySel();                                      // Ctrl+C / Ctrl+Shift+C：有选中就复制，无选中不做任何事
        return false;                                      // 不再把 ^C 发给远端
      }
      if (ctrl && !ev.altKey && !ev.shiftKey && (ev.key === "z" || ev.key === "Z")) {
        api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: "\u0003" }) });
        lineBuf = "";                                      // Ctrl+Z：中断远端当前命令（原 Ctrl+C 的行为）
        return false;
      }
      if (ctrl && !ev.altKey && (ev.key === "v" || ev.key === "V")) {
        return false;                                      // Ctrl+V：拦下 ^V，粘贴由浏览器原生 paste 事件完成
      }
      return true;
    });
    // 挂到 tab 上：编辑器右键菜单（02_ 的 openEditorCtxMenu）识别 SSH 终端标签后，
    // 「复制 / 粘贴」直接走终端的选区和系统剪贴板，不再需要单独的右键菜单
    tab.sshHasSel = () => !!term.getSelection();
    tab.sshCopy = () => sshCopySel();
    tab.sshPasteFromClipboard = sshReadClipboard;

    // 终端容器尺寸变化 → 重新适配并告知远端
    const ro = new ResizeObserver(() => {
      if (termBox.style.display === "none") return;      // Agent 模式下 xterm 被隐藏，不要按 0 尺寸去 fit
      try { fit.fit(); } catch (e) { return; }
      const nc = term.cols, nr = term.rows;
      if (nc !== sess.cols || nr !== sess.rows) {
        sess.cols = nc; sess.rows = nr;
        api("/api/ssh/resize", { method: "POST", body: JSON.stringify({ id: sid, cols: nc, rows: nr }) });
      }
    });
    ro.observe(termBox);

    const es = new EventSource("/api/ssh/stream/" + sid);
    sess.es = es;

    /* ---------- 首次连接：首屏欢迎信息（MOTD）→ 中文说明卡片 ----------
       收集登录后的第一段输出，出现 shell 提示符（行尾 $ / #）或停顿 5 秒后，
       用本地规则解析 MOTD 生成中文说明（不走 AI，秒出）。 */
    let motdRaw = "", motdDone = false, motdTimer = null;
    function motdStrip(s) {
      if (window.TermAI && window.TermAI.stripAnsi) return window.TermAI.stripAnsi(s);
      return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
    }
    function motdShowCard() {
      let card = wrap.querySelector(".ssh-motd");
      if (card) return card;
      card = document.createElement("div");
      card.className = "ssh-motd";
      card.innerHTML =
        '<div class="ssh-motd-head"><i class="bi bi-translate"></i><span>连接信息 · 中文说明</span>' +
          '<span class="ssh-motd-host">' + esc((c.user || "root") + "@" + c.host) + '</span>' +
          '<span class="ssh-motd-acts">' +
            '<button data-m="tgl" title="收起 / 展开"><i class="bi bi-chevron-up"></i></button>' +
            '<button data-m="x" title="关闭"><i class="bi bi-x-lg"></i></button>' +
          '</span></div>' +
        '<div class="ssh-motd-body"><span class="ssh-motd-txt"></span></div>';
      wrap.insertBefore(card, termBox);
      const body = card.querySelector(".ssh-motd-body");
      card.querySelector('[data-m="tgl"]').onclick = () => {
        const hid = body.style.display === "none";
        body.style.display = hid ? "" : "none";
        card.classList.toggle("folded", !hid);
      };
      card.querySelector('[data-m="x"]').onclick = () => card.remove();
      return card;
    }
    /* 本地规则解析 MOTD（Ubuntu / Debian 风格欢迎信息），返回中文说明行数组 */
    function motdParse(s) {
      const lines = [];
      const g1 = re => { const m = s.match(re); return m ? m[1].trim() : ""; };
      // 系统版本（Welcome to Ubuntu 24.04.4 LTS (GNU/Linux ...) / Debian GNU/Linux ...）
      const sys = g1(/Welcome to ((?:Ubuntu|Debian|CentOS|AlmaLinux|Rocky|Fedora)[^\r\n]*)/i);
      if (sys) lines.push("**系统版本**：" + sys + "。");
      // 资源概览：直接从 System load: 字段行开始截取（标题与字段之间可能有空行，不能锚定标题）
      const si = s.match(/System\s+load\s*:[\s\S]*?(?=\n\s*\n|$)/);
      if (si) {
        const gb = re => { const m = si[0].match(re); return m ? m[1].trim() : ""; };
        const bits = [];
        const load = gb(/System load:\s*([0-9.]+)/);
        const procs = gb(/Processes:\s*(\d+)/);
        const disk = gb(/Usage of \/\s*:\s*([^\n]+)/);
        const mem = gb(/Memory usage:\s*([^\n]+)/);
        const swap = gb(/Swap usage:\s*([^\n]+)/);
        const users = gb(/Users logged in:\s*([^\n]+)/);
        const ip = gb(/IPv4 address for [^\s:]+:\s*([^\n]+)/);
        if (load) bits.push("负载 " + load);
        if (procs) bits.push("进程 " + procs + " 个");
        if (disk) {
          const dm = disk.match(/([0-9.]+%)\s*of\s*([0-9.]+\s*\S+)/);
          bits.push(dm ? "根分区已用 " + dm[1] + "（共 " + dm[2].trim() + "）" : "根分区 " + disk);
        }
        if (mem) bits.push("内存占用 " + mem);
        if (swap && !/^0%/.test(swap)) bits.push("Swap 已用 " + swap);
        if (users) bits.push(users + " 个用户在线");
        if (ip) bits.push("内网地址 " + ip);
        const zmb = s.match(/There\s+(?:is|are)\s+(\d+)\s+zombie\s+process/i);
        if (zmb && zmb[1] !== "0") bits.push("⚠️ 有 " + zmb[1] + " 个僵尸进程");
        if (bits.length) lines.push("**资源概览**：" + bits.join("，") + "。");
      }
      // 可更新软件包
      const upd = s.match(/(\d+)\s+updates?\s+can\s+be\s+applied\s+immediately/i);
      if (upd) {
        const sec = s.match(/(\d+)\s+of\s+these\s+updates\s+are\s+(?:standard\s+)?security\s+updates/i);
        lines.push("**可更新软件包**：⚠️ 共 **" + upd[1] + "** 个待安装更新" +
          (sec ? "，其中 **" + sec[1] + "** 个为安全更新" : "") +
          "，可运行 `apt list --upgradable` 查看，`apt upgrade` 安装。");
      }
      // ESM 扩展安全维护
      if (/Expanded\s+Security\s+Maintenance[\s\S]{0,160}?is\s+not\s+enabled/i.test(s)) {
        lines.push("**安全维护（ESM）**：⚠️ 扩展安全维护未启用，无法获取额外安全更新，可运行 `sudo pro status` 或访问 ubuntu.com/esm 了解开通方式。");
      }
      // 新版本可用
      const rel = s.match(/New\s+release:\s*([^\s]+)\s+available/i);
      if (rel) lines.push("**版本升级**：⚠️ 检测到新版本 **" + rel[1] + "** 可用，如需升级请运行 `do-release-upgrade`。");
      // 上次登录（服务器时间是英文格式，这里解析后按北京时间显示）
      const ll = s.match(/Last\s+login:\s*([^\r\n]+)/i);
      if (ll) {
        const lm = ll[1].match(/^(.*?\d{4})\s+from\s+(\S+)/);
        const from = lm ? lm[2] : "";
        const raw = (lm ? lm[1] : ll[1]).trim();
        // "Mon Oct 19 00:03:40 2026" → 手工解析，避免 Date 直接 parse 把 CST 当美国时区
        const MM = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
                     Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
        let when = raw;
        const dm = raw.match(/^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(\d{4})/);
        if (dm && MM[dm[2]]) {
          let h = +dm[4], min = +dm[5], sec = dm[6] ? +dm[6] : 0;
          const tz = (ll[1].match(/\b(UTC|GMT)\b/) || [])[1];      // 标注为 UTC/GMT 的换算到东八区
          if (tz) { h = (h + 8) % 24; }
          const pad = n => String(n).padStart(2, "0");
          when = dm[7] + "-" + MM[dm[2]] + "-" + pad(+dm[3]) + " " +
                 pad(h) + ":" + pad(min) + ":" + pad(sec) + "（北京时间）";
        }
        lines.push("**上次登录**：" + when + (from ? "，来自 " + from : "") + "。");
      }
      return lines;
    }
    function motdFinish() {
      if (motdDone) return;
      motdDone = true;
      clearTimeout(motdTimer);
      const clean = motdStrip(motdRaw).replace(/\u0000/g, "").trim();
      if (clean.length < 60) return;                   // 没什么欢迎信息，不做说明
      const rows = motdParse(clean);
      if (!rows.length) return;                        // 没解析出任何已知字段就不弹卡片
      const txt = motdShowCard().querySelector(".ssh-motd-txt");
      // 最小渲染：**粗体**、`代码`、⚠️ 原样
      txt.innerHTML = esc(rows.join("\n"))
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>");
    }
    function motdFeed(text) {
      if (motdDone || !text) return;
      motdRaw += text;
      if (motdRaw.length > 20000) { motdFinish(); return; }
      const clean = motdStrip(motdRaw).trim();
      // 行尾出现 $ / # 视为已到 shell 提示符，欢迎信息结束
      if (clean.length > 60 && /[$#]\s*$/.test(clean)) { motdFinish(); return; }
      clearTimeout(motdTimer);
      motdTimer = setTimeout(motdFinish, 5000);        // 输出停顿 5 秒也视为结束
    }
    es.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.eof) {                                     // 远端主动断开（服务器关闭连接 / exit 退出等）
        sess.alive = false;
        term.write("\r\n[33m[连接已关闭]\x1b[0m\r\n");
        toast((tab.name || "SSH") + " 连接已断开", "warn");
        return;
      }
      if (!m.data) return;
      let text = "";
      try { text = sess.dec.decode(base64ToBytes(m.data), { stream: true }); } catch (e) { return; }
      term.write(text);
      motdFeed(text);                                  // 首屏输出 → 中文说明
      const cap = sess.capture;                        // AI 执行命令后的输出回读
      if (cap && !cap.done && text) {
        cap.text += text;
        if (cap.text.length > 400000) cap.text = cap.text.slice(-400000);
        clearTimeout(cap.idle);
        cap.idle = setTimeout(cap.finish, 1800);
      }
    };
    es.onerror = () => {                                 // SSE 意外断开（网络掉线 / 后端重启等）
      try { es.close(); } catch (e) { /* 已关闭 */ }
      if (sess.alive) {
        sess.alive = false;
        term.write("\r\n\x1b[33m[连接已断开]\x1b[0m\r\n");
        toast((tab.name || "SSH") + " 连接已断开", "warn");
      }
    };

    function doClose() {
      sess.alive = false;                                // 主动关闭：不再触发「连接已断开」提示
      try { if (sess.capture && !sess.capture.done) sess.capture.finish(); } catch (e) { /* 忽略 */ }
      try { ro.disconnect(); } catch (e) {}
      try { es.close(); } catch (e) {}
      try { term.dispose(); } catch (e) {}
      api("/api/ssh/close", { method: "POST", body: JSON.stringify({ id: sid }) });
      delete SESS[sid];
      // 延后一拍再保存：走标签「×」关闭时，closeTab 会在 onBeforeClose 之后才把 tab 移出 tabs
      setTimeout(sshSessionSave, 0);
    }
    closeBtn.onclick = doClose;
    tab.onBeforeClose = doClose;          // 点标签栏「×」关闭时由 00_preamble 的 closeTab 回调
  }

  /* ---------------- 新建 / 编辑 连接 ---------------- */
  function openSshEditor(conn) {
    const isEdit = !!(conn && conn.id);
    SSHC.editing = isEdit ? conn.id : null;
    const c = conn || {};
    const ov = $("modalOverlay");
    ov.innerHTML =
      '<div class="ssh-modal">' +
        '<div class="ssh-modal-head"><i class="bi bi-hdd-network"></i><span>' + (isEdit ? "编辑 SSH 连接" : "新建 SSH 连接") + '</span>' +
          '<button class="ssh-modal-x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
        '<div class="ssh-form">' +
          row("名称", '<input class="ssh-in" id="sshName" spellcheck="false" placeholder="如 生产服务器" value="' + escAttr(c.name || "") + '">') +
          row("主机", '<input class="ssh-in" id="sshHost" spellcheck="false" placeholder="192.168.1.10 / example.com" value="' + escAttr(c.host || "") + '">') +
          row("端口", '<input class="ssh-in ssh-port" id="sshPort" spellcheck="false" placeholder="22" value="' + escAttr(c.port || "22") + '">') +
          row("用户", '<input class="ssh-in" id="sshUser" spellcheck="false" placeholder="root" value="' + escAttr(c.user || "root") + '">') +
          '<div class="ssh-row"><span class="ssh-lb">认证</span>' +
            '<select class="ssh-in" id="sshAuth">' +
              '<option value="password"' + (c.auth !== "key" ? " selected" : "") + '>密码</option>' +
              '<option value="key"' + (c.auth === "key" ? " selected" : "") + '>私钥</option>' +
            '</select></div>' +
          '<div class="ssh-row ssh-pwd-row"><span class="ssh-lb">密码</span>' +
            '<input class="ssh-in" id="sshPwd" type="password" spellcheck="false" placeholder="' +
              (isEdit && c.hasPassword ? "留空表示不修改（已保存 " + (c.hasPassword ? "●" : "") + "）" : "登录密码") + '"></div>' +
          '<div class="ssh-row ssh-key-row" style="display:none"><span class="ssh-lb">私钥</span>' +
            '<textarea class="ssh-in ssh-key" id="sshKey" spellcheck="false" placeholder="粘贴私钥内容（-----BEGIN ... PRIVATE KEY-----）">' + esc(c.key || "") + '</textarea></div>' +
          '<div class="ssh-row ssh-keypass-row" style="display:none"><span class="ssh-lb">私钥口令</span>' +
            '<input class="ssh-in" id="sshKeypass" type="password" spellcheck="false" placeholder="留空表示不修改 / 私钥无口令"></div>' +
          row("备注", '<input class="ssh-in" id="sshRemark" spellcheck="false" placeholder="可选" value="' + escAttr(c.remark || "") + '">') +
        '</div>' +
        '<div class="ssh-tip"><i class="bi bi-info-circle"></i> 密码 / 私钥经传输层加密后落库；编辑时留空表示沿用已保存的值。</div>' +
        '<div class="ssh-modal-acts">' +
          '<button class="g-btn outline" id="sshTest"><i class="bi bi-plug"></i> 测试连接</button>' +
          '<span class="ssh-sp"></span>' +
          '<button class="g-btn outline" id="sshCancel">取消</button>' +
          '<button class="g-btn" id="sshSave"><i class="bi bi-check-lg"></i> ' + (isEdit ? "保存" : "创建") + '</button>' +
        '</div>' +
      '</div>';
    ov.classList.add("show");

    const authSel = ov.querySelector("#sshAuth");
    const pwdRow = ov.querySelector(".ssh-pwd-row");
    const keyRow = ov.querySelector(".ssh-key-row");
    const keypassRow = ov.querySelector(".ssh-keypass-row");
    const syncAuth = () => {
      const key = authSel.value === "key";
      pwdRow.style.display = key ? "none" : "";
      keyRow.style.display = key ? "" : "none";
      keypassRow.style.display = key ? "" : "none";
    };
    authSel.onchange = syncAuth; syncAuth();

    const closeModal = () => { ov.classList.remove("show"); ov.innerHTML = ""; };
    ov.querySelector(".ssh-modal-x").onclick = closeModal;
    ov.querySelector("#sshCancel").onclick = closeModal;
    ov.querySelector("#sshTest").onclick = () => testSsh(ov, () => toast("连接测试成功", "ok"));
    ov.querySelector("#sshSave").onclick = () => saveSsh(ov, closeModal);
  }
  function row(label, ctrl) {
    return '<div class="ssh-row"><span class="ssh-lb">' + label + '</span>' + ctrl + '</div>';
  }

  function collect(ov) {
    return {
      id: SSHC.editing || "",
      name: ov.querySelector("#sshName").value.trim() || ov.querySelector("#sshHost").value.trim(),
      host: ov.querySelector("#sshHost").value.trim(),
      port: parseInt(ov.querySelector("#sshPort").value, 10) || 22,
      user: ov.querySelector("#sshUser").value.trim() || "root",
      auth: ov.querySelector("#sshAuth").value,
      password: window.TP ? TP.encrypt(ov.querySelector("#sshPwd").value) : ov.querySelector("#sshPwd").value,
      key: window.TP ? TP.encrypt(ov.querySelector("#sshKey").value) : ov.querySelector("#sshKey").value,
      keypass: window.TP ? TP.encrypt(ov.querySelector("#sshKeypass").value) : ov.querySelector("#sshKeypass").value,
      remark: ov.querySelector("#sshRemark").value.trim(),
    };
  }
  async function saveSsh(ov, closeModal) {
    const body = collect(ov);
    if (!body.host) { toast("请填写主机地址", "warn"); return; }
    if (body.auth === "key" && !body.key) { toast("请填写私钥", "warn"); return; }
    if (body.auth === "password" && !body.password) { toast("请填写密码", "warn"); return; }
    const d = await api("/api/ssh/save", { method: "POST", body: JSON.stringify(body) });
    if (d.error) { toast(d.error, "err"); return; }
    if (closeModal) closeModal();
    toast((body.id ? "已保存：" : "已创建：") + d.conn.name, "ok");
    loadSshConns();
  }
  async function testSsh(ov, ok) {
    const body = collect(ov);
    if (!body.host) { toast("请填写主机地址", "warn"); return; }
    if (body.auth === "key" && !body.key) { toast("请填写私钥", "warn"); return; }
    if (body.auth === "password" && !body.password) { toast("请填写密码", "warn"); return; }
    const d = await api("/api/ssh/test", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) { if (ok) ok(); }
    else toast("连接失败：" + (d.error || "未知错误"), "err");
  }
  async function deleteSsh(c) {
    const ok = await uiConfirm("删除 SSH 连接", "确定删除「" + c.name + "」吗？此操作不可撤销。", "删除", true);
    if (!ok) return;
    const d = await api("/api/ssh/delete", { method: "POST", body: JSON.stringify({ id: c.id }) });
    if (d.error) { toast(d.error, "err"); return; }
    toast("已删除：" + c.name, "ok");
    loadSshConns();
  }

  /* ---------------- 常用命令：保存管理 + 一键发送到当前终端 ----------------
     命令保存在本机 localStorage；点击列表中的命令 → 发送到当前激活的 SSH
     终端并执行；悬浮按钮可「仅粘贴」（不回车）/ 编辑 / 删除。 */
  const SSH_CMDS_KEY = "ide.session.sshCmds";
  function sshCmdsLoad() {
    try { const a = JSON.parse(localStorage.getItem(SSH_CMDS_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  }
  function sshCmdsSave(list) {
    try { localStorage.setItem(SSH_CMDS_KEY, JSON.stringify(list)); } catch (_) { /* 忽略 */ }
  }
  function activeSshSid() {
    try {
      if (typeof active !== "undefined" && active && active.isSshTerm &&
          active.sshSid && SESS[active.sshSid] && SESS[active.sshSid].alive) return active.sshSid;
    } catch (e) { /* 忽略 */ }
    const keys = Object.keys(SESS);                  // 兜底：任意一个还活着的 SSH 会话
    return keys.length ? keys[0] : "";
  }
  function sshCmdSend(m, exec) {
    const cmdText = String(m.cmd || "").trim();
    if (!cmdText) return;
    const sid = activeSshSid();
    if (!sid) { toast("请先连接并打开一个 SSH 终端", "warn"); return; }
    api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: cmdText + (exec ? "\r" : "") }) });
    const s = SESS[sid];
    try { if (s && s.term) s.term.focus(); } catch (e) { /* 忽略 */ }
    toast((exec ? "已在当前终端执行：" : "已粘贴到当前终端：") + (m.name || cmdText), "ok");
  }
  function renderSshCmds() {
    const box = $("sshCmds");
    if (!box) return;
    const list = sshCmdsLoad();
    if (!list.length) {
      box.innerHTML = '<div class="ph">还没有常用命令。点上方 <b>+</b> 添加（如 df -h、docker ps），点击即可在当前 SSH 终端执行。</div>';
      return;
    }
    box.innerHTML = "";
    list.forEach(m => {
      const item = document.createElement("div");
      item.className = "ssh-item ssh-cmd";
      item.innerHTML =
        '<div class="ssh-main">' +
          '<i class="bi bi-terminal"></i>' +
          '<div class="ssh-meta">' +
            '<div class="ssh-name">' + esc(m.name || m.cmd) + '</div>' +
            (m.name ? '<div class="ssh-sub">' + esc(m.cmd) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ssh-acts">' +
          '<button data-act="paste" title="仅粘贴到终端，不执行"><i class="bi bi-clipboard"></i></button>' +
          '<button data-act="edit" title="编辑"><i class="bi bi-pencil-square"></i></button>' +
          '<button data-act="del" title="删除"><i class="bi bi-trash"></i></button>' +
        '</div>';
      item.querySelector(".ssh-main").onclick = () => sshCmdSend(m, true);   // 点击 = 发送并执行
      item.querySelector('[data-act="paste"]').onclick = e => { e.stopPropagation(); sshCmdSend(m, false); };
      item.querySelector('[data-act="edit"]').onclick = e => { e.stopPropagation(); openSshCmdEditor(m); };
      item.querySelector('[data-act="del"]').onclick = async e => {
        e.stopPropagation();
        const ok = await uiConfirm("删除常用命令", "确定删除「" + (m.name || m.cmd) + "」吗？", "删除", true);
        if (!ok) return;
        sshCmdsSave(sshCmdsLoad().filter(x => x.id !== m.id));
        renderSshCmds();
        toast("已删除常用命令", "ok");
      };
      box.appendChild(item);
    });
  }
  function openSshCmdEditor(item) {
    const isEdit = !!(item && item.id);
    const ov = $("modalOverlay");
    ov.innerHTML =
      '<div class="ssh-modal">' +
        '<div class="ssh-modal-head"><i class="bi bi-terminal"></i><span>' + (isEdit ? "编辑常用命令" : "新建常用命令") + '</span>' +
          '<button class="ssh-modal-x" title="关闭"><i class="bi bi-x-lg"></i></button></div>' +
        '<div class="ssh-form">' +
          row("名称", '<input class="ssh-in" id="sshCmdName" spellcheck="false" placeholder="可选，默认显示命令本身" value="' + escAttr(item && item.name || "") + '">') +
          '<div class="ssh-row"><span class="ssh-lb">命令</span>' +
            '<textarea class="ssh-in ssh-key" id="sshCmdText" spellcheck="false" placeholder="如：df -h">' + esc(item && item.cmd || "") + '</textarea></div>' +
        '</div>' +
        '<div class="ssh-tip"><i class="bi bi-info-circle"></i> 命令保存在本机浏览器；点击列表中的命令会在当前打开的 SSH 终端里执行。</div>' +
        '<div class="ssh-modal-acts"><span class="ssh-sp"></span>' +
          '<button class="g-btn outline" id="sshCmdCancel">取消</button>' +
          '<button class="g-btn" id="sshCmdSave"><i class="bi bi-check-lg"></i> ' + (isEdit ? "保存" : "添加") + '</button></div>' +
      '</div>';
    ov.classList.add("show");
    const close = () => { ov.classList.remove("show"); ov.innerHTML = ""; };
    ov.querySelector(".ssh-modal-x").onclick = close;
    ov.querySelector("#sshCmdCancel").onclick = close;
    ov.querySelector("#sshCmdSave").onclick = () => {
      const cmdText = ov.querySelector("#sshCmdText").value.replace(/\r?\n/g, " ").trim();
      if (!cmdText) { toast("请填写命令", "warn"); return; }
      const name = ov.querySelector("#sshCmdName").value.trim();
      const list = sshCmdsLoad();
      if (isEdit) {
        const it = list.find(x => x.id === item.id);
        if (it) { it.name = name; it.cmd = cmdText; }
      } else {
        list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name, cmd: cmdText });
      }
      sshCmdsSave(list);
      close();
      renderSshCmds();
      toast(isEdit ? "已保存常用命令" : "已添加常用命令", "ok");
    };
  }

  // 暴露给其它模块（如 44_ 终端 AI 助手的命令卡片「加入常用」按钮）：
  // 添加一条常用命令，已存在相同命令时去重不重复添加，返回 { added: bool }
  window.sshCmdsAdd = function (name, cmdText) {
    const c = String(cmdText || "").replace(/\r?\n/g, " ").trim();
    if (!c) return null;
    const list = sshCmdsLoad();
    const added = !list.some(x => x.cmd === c);
    if (added) {
      list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name || "").trim(), cmd: c });
      sshCmdsSave(list);
    }
    renderSshCmds();
    return { added: added };
  };

  /* ---------------- 初始化 ---------------- */
  (function init() {
    const mk = $("sshNew"); if (mk) mk.onclick = () => openSshEditor(null);
    const rf = $("sshRefresh"); if (rf) rf.onclick = () => loadSshConns();
    const cn = $("sshCmdNew"); if (cn) cn.onclick = () => openSshCmdEditor(null);
    renderSshCmds();
    // 界面主题切换（黑夜 / 白天）时，实时刷新已打开远程终端的配色
    new MutationObserver(() => {
      const th = sshTermTheme();
      Object.keys(SESS).forEach(sid => { const s = SESS[sid]; if (s && s.term) s.term.options.theme = th; });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // 活动栏图标：点击侧栏图标时刷新列表（showPanel 由通用机制驱动）
    const act = $("actSsh");
    if (act) act.onclick = () => { if (typeof showPanel === "function") showPanel("sshconn"); loadSshConns(); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => loadSshConns());
    } else {
      setTimeout(() => loadSshConns(), 0);
    }
  })();
})();
