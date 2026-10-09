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
          '<button data-act="open" title="连接并打开终端"><i class="bi bi-play-fill"></i></button>' +
          '<button data-act="edit" title="编辑"><i class="bi bi-pencil-square"></i></button>' +
          '<button data-act="dup" title="复制连接"><i class="bi bi-files"></i></button>' +
          '<button data-act="del" title="删除"><i class="bi bi-trash"></i></button>' +
        '</div>';
      item.querySelector('[data-act="open"]').onclick = () => connectSsh(c);
      item.querySelector('[data-act="edit"]').onclick = () => openSshEditor(c);
      item.querySelector('[data-act="dup"]').onclick = () => openSshEditor(Object.assign({}, c, { id: "", name: c.name + " 副本" }));
      item.querySelector('[data-act="del"]').onclick = () => deleteSsh(c);
      box.appendChild(item);
    });
  }

  /* ---------------- 连接 / 编辑器区终端 ---------------- */
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
    const tab = {
      path: path, name: c.name || (c.user + "@" + c.host), host: host,
      iconHtml: '<i class="bi bi-hdd-network"></i>', isSshTerm: true, connId: c.id,
    };
    tabs.push(tab);
    renderTabsAll();
    buildSshTerm(tab, c, sid);
    activate(tab);
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
    // 用真实尺寸纠正后端 PTY 大小
    api("/api/ssh/resize", { method: "POST", body: JSON.stringify({ id: sid, cols: term.cols, rows: term.rows }) });

    term.onData(d => { api("/api/ssh/input", { method: "POST", body: JSON.stringify({ id: sid, data: d }) }); });

    // 终端容器尺寸变化 → 重新适配并告知远端
    const ro = new ResizeObserver(() => {
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
    es.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.eof) { term.write("\r\n[33m[连接已关闭]\x1b[0m\r\n"); return; }
      if (m.data) term.write(base64ToBytes(m.data));
    };
    es.onerror = () => { try { es.close(); } catch (e) { /* 已关闭 */ } };

    function doClose() {
      try { ro.disconnect(); } catch (e) {}
      try { es.close(); } catch (e) {}
      try { term.dispose(); } catch (e) {}
      api("/api/ssh/close", { method: "POST", body: JSON.stringify({ id: sid }) });
      delete SESS[sid];
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

  /* ---------------- 初始化 ---------------- */
  (function init() {
    const mk = $("sshNew"); if (mk) mk.onclick = () => openSshEditor(null);
    const rf = $("sshRefresh"); if (rf) rf.onclick = () => loadSshConns();
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
