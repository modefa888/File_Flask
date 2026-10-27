  /* ==================================================================
     运行环境：探测本机 Node / Python / PHP / Java / Go 等运行时与工具链，
     可视化查看版本与路径、切换自定义解释器、配置镜像源、维护环境变量。
     ================================================================== */
  const ENV = {
    data: null, filter: "", onlyInstalled: false,
    openId: null, details: {}, plans: {}, sys: null, groups: {},
  };

  function openEnvPanel() {
    $("sidebar").classList.remove("collapsed");
    sidebarSyncState();   // 展开侧栏也要落盘，避免刷新后按旧「收起」值恢复
    showPanel("env");
    loadEnv(false);
  }

  function openRunnerPanel() {
    $("sidebar").classList.remove("collapsed");
    sidebarSyncState();   // 同上
    showPanel("runner");
    loadRunnerList().then(runnerTick);
  }

  /* ---------- 端口占用查询（后台任务面板内）：查看 / 搜索端口 / 强制结束占用进程 ---------- */
  let PORT_SEARCH = null;                    // 非空时只显示该端口的查询结果

  async function loadPorts() {
    const box = $("portBox");
    if (!box || box.style.display === "none") return;
    const head = box.querySelector(".pb-head span");
    try {
      const r = await fetch("/api/port/list");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      let items = d.ports || d || [];
      if (PORT_SEARCH !== null) {
        const hits = items.filter(p => p.port === PORT_SEARCH);
        if (head) head.textContent = hits.length
          ? "端口 " + PORT_SEARCH + " 已被占用"
          : "端口 " + PORT_SEARCH + " 未被占用 ✓";
        const list = box.querySelector(".pb-list");
        if (!list) return;
        list.innerHTML = "";
        if (!hits.length) {
          list.innerHTML = '<div class="port-row" style="color:#8a8a8a">端口 ' + esc(PORT_SEARCH) +
            ' 当前没有被任何进程监听，可以直接使用。</div>';
          return;
        }
        items = hits;
      } else if (head) {
        head.textContent = "监听中的端口（" + items.length + "）";
      }
      const list = box.querySelector(".pb-list");
      if (!list) return;
      if (!items.length) { list.innerHTML = '<div class="port-row" style="color:#8a8a8a">当前没有监听中的端口。</div>'; return; }
      list.innerHTML = "";
      items.forEach(p => {
        const row = document.createElement("div");
        row.className = "port-row";
        const name = p.name || "未知进程";
        const cmdText = p.cmd || (p.cwd || "");
        row.innerHTML =
          '<div class="pr-top">' +
            '<span class="pr-port">:' + esc(p.port) + '</span>' +
            '<span class="pr-proto">' + esc(p.proto || "?") + '</span>' +
            '<span class="pr-name" title="' + escAttr(name) + '">' + esc(name) + '</span>' +
            (p.mine ? '' : '<span class="pr-other">其他用户</span>') +
            (p.can_kill || !p.pid ? '' : '<span class="pr-other">不可结束</span>') +
            '<span class="pr-other">pid ' + esc(p.pid || "-") + '</span>' +
          '</div>' +
          '<div class="pr-foot">' +
            '<div class="pr-cmd" title="' + escAttr((p.cmd || "") + (p.cwd ? "  ·  " + p.cwd : "")) + '">' +
              esc(cmdText || "-") + '</div>' +
          '</div>';
        if (p.can_kill) {
          const btn = document.createElement("button");
          btn.className = "pr-kill";
          btn.textContent = "强制停止";
          btn.onclick = async () => {
            if (btn.disabled) return;
            const ok = await uiConfirm("强制结束进程",
              "将结束占用端口 " + p.port + " 的进程：\n" +
              "pid " + p.pid + " · " + (p.name || "?") + "\n" + (p.cmd || ""), "强制停止", false);
            if (!ok) return;
            btn.disabled = true; btn.textContent = "正在结束…";
            try {
              const r2 = await fetch("/api/port/kill", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pid: p.pid, port: p.port }),
              });
              const d2 = await r2.json();
              if (d2.error) { toast(d2.error, "err"); }
              else { toast("已结束 pid " + p.pid + "（端口 " + p.port + "）", "ok"); loadRunnerList({ silent: true }); }
            } catch (e) { toast("操作失败：" + (e.message || e), "err"); }
            loadPorts();
          };
          row.querySelector(".pr-foot").appendChild(btn);
        }
        list.appendChild(row);
      });
    } catch (e) {
      if (head) head.textContent = "端口读取失败：" + (e.message || e);
    }
  }

  function togglePorts(force, searchPort) {
    const box = $("portBox");
    if (!box) return;
    const show = force !== undefined ? force : box.style.display === "none";
    box.style.display = show ? "" : "none";
    if (searchPort !== undefined) PORT_SEARCH = searchPort;
    if (!show) PORT_SEARCH = null;
    if (show && !box.dataset.ready) {
      box.dataset.ready = "1";
      box.innerHTML =
        '<div class="pb-head"><span>正在读取端口…</span>' +
        '<button id="portRefresh" title="重新扫描"><i class="bi bi-arrow-clockwise"></i></button></div>' +
        '<div class="pb-list"></div>';
      $("portRefresh").onclick = () => loadPorts();
    }
    if (show) loadPorts();
  }

  // 标题栏的端口搜索框：输入端口号回车 → 展示占用情况（可强制结束）
  $("sidePortSearch").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const v = ($("sidePortSearch").value || "").trim();
    if (!/^\d{1,5}$/.test(v)) { toast("请输入 1-5 位数字的端口号", "warn"); return; }
    const port = parseInt(v, 10);
    if (port < 1 || port > 65535) { toast("端口号范围：1 - 65535", "warn"); return; }
    togglePorts(true, port);
  });
  // 清空后回车 → 恢复显示全部端口
  $("sidePortSearch").addEventListener("input", e => {
    if (!e.target.value.trim() && PORT_SEARCH !== null) { PORT_SEARCH = null; if ($("portBox") && $("portBox").style.display !== "none") loadPorts(); }
  });

  function escAttr(s) { return esc(String(s == null ? "" : s)).replace(/"/g, "&quot;"); }

  async function loadEnv(force) {
    if (!ENV.data) $("envList").innerHTML = '<div class="env-sum">正在检测运行环境…</div>';
    try {
      const r = await fetch("/api/env/runtimes" + (force ? "?refresh=1" : ""));
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      ENV.data = d;
      if (force) {
        ENV.details = {}; ENV.plans = {}; ENV.sys = null;
        if ($("envSysBox").style.display !== "none") loadEnvSystem();
      }
      const s = d.summary || {};
      $("envSummary").classList.remove("err");
      $("envSummary").innerHTML = "已安装 <b>" + s.installed + "</b> / " + s.total + " 项 · 检测于 " +
        esc(d.detected_at || "-") + (d.cached ? "（缓存）" : "");
      renderEnv();
      renderEnvVars();
      if (typeof envViewRender === "function" && $("envView")) envViewRender();   // 编辑区「运行管理」页开着就同步刷
    } catch (e) {
      $("envSummary").textContent = "检测失败：" + (e.message || e);
      $("envSummary").classList.add("err");
    }
  }

  function envMatches(it) {
    if (ENV.onlyInstalled && !it.installed) return false;
    const q = ENV.filter.trim().toLowerCase();
    if (!q) return true;
    return (it.label + " " + it.id + " " + it.category + " " + (it.path || "")).toLowerCase().includes(q);
  }

  function renderEnv() {
    const box = $("envList");
    box.innerHTML = "";
    if (!ENV.data) return;
    const items = (ENV.data.items || []).filter(envMatches);
    if (!items.length) { box.innerHTML = '<div class="env-sum">没有匹配项</div>'; return; }
    const byCat = {};
    items.forEach(it => { (byCat[it.category] = byCat[it.category] || []).push(it); });
    (ENV.data.categories || Object.keys(byCat)).forEach(cat => {
      const list = byCat[cat];
      if (!list || !list.length) return;
      const collapsed = ENV.groups[cat] === false;
      const head = document.createElement("div");
      head.className = "env-group";
      head.innerHTML = '<i class="bi ' + (collapsed ? "bi-caret-right" : "bi-caret-down") + '"></i>' + esc(cat) +
        ' <span class="cnt">' + list.filter(x => x.installed).length + "/" + list.length + "</span>";
      head.onclick = () => { ENV.groups[cat] = collapsed; renderEnv(); };
      box.appendChild(head);
      if (collapsed) return;
      list.forEach(it => box.appendChild(envItemEl(it)));
    });
    // 展开中的条目若还没有详情数据（如刚强制刷新过），自动补加载
    if (ENV.openId && !ENV.details[ENV.openId]) loadEnvDetail(ENV.openId);
    envBind();
  }

  function envItemEl(it) {
    const wrap = document.createElement("div");
    wrap.className = "env-item";
    const open = ENV.openId === it.id;
    const row = document.createElement("div");
    row.className = "env-row" + (it.installed ? "" : " off") + (open ? " open" : "");
    row.title = it.installed ? it.path : (it.hint || "未安装");
    row.innerHTML = '<span class="ic"><i class="bi ' + escAttr(it.icon || "bi-box") + '"></i></span>' +
      '<span class="nm">' + esc(it.label) + "</span>" +
      (it.custom ? '<span class="env-badge">自定义</span>' : "") +
      '<span class="env-ver' + (it.installed ? "" : " off") + '">' +
      esc(it.version || (it.installed ? "已安装" : "未安装")) + "</span>";
    row.onclick = () => envToggleDetail(it.id);
    wrap.appendChild(row);
    if (open) wrap.appendChild(envDetailEl(it));
    return wrap;
  }

  function envKv(k, v) {
    return '<div class="env-kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>";
  }

  function envDetailEl(it) {
    const box = document.createElement("div");
    box.className = "env-detail";
    const d = ENV.details[it.id];
    if (!d) { box.textContent = "正在加载详情…"; return box; }
    if (d.error && d.installed !== false) { box.innerHTML = '<span class="err">' + esc(d.error) + "</span>"; return box; }
    let h = "";
    if (d.installed === false) {
      h += envKv("状态", "未安装");
      h += envInstallSection(it, d);
    } else {
      h += envKv("版本", d.version_raw || d.version || "-");
      h += envKv("路径", d.path || "-");
      h += envKv("来源", it.custom ? "自定义路径" : "系统 PATH");
    }
    if ((d.candidates || []).length) {
      h += '<div class="env-sec-head" style="cursor:default"><i class="bi bi-layers"></i> 检测到的可执行文件</div>';
      d.candidates.forEach(c => {
        h += '<div class="env-kv"><span class="k">' + esc(c.exe) + '</span><span class="v">' + esc(c.path) +
             (c.version ? ' <span class="ver">' + esc(c.version) + "</span>" : "") +
             (c.custom ? ' <span class="env-badge">当前使用</span>' : "") + "</span></div>";
      });
    }
    const exeName = (d.path || "").split("/").pop();
    h += '<div class="env-acts">';
    if (d.installed === false) {
      h += '<button class="env-btn ev-ai-btn" data-act="ai-install" data-id="' + escAttr(it.id) +
           '" title="让 AI 按本机系统给出安装步骤"><i class="bi bi-stars"></i> AI 安装</button>';
    }
    h += '<button class="env-btn" data-act="copy" data-text="' + escAttr(d.path) + '"><i class="bi bi-copy"></i> 复制路径</button>';
    if (d.path) {
      h += '<button class="env-btn" data-act="term" data-cmd="' +
           escAttr(exeName + " " + (it.version_args || "").trim()) + '"><i class="bi bi-terminal"></i> 在终端验证</button>';
    }
    h += '<button class="env-btn" data-act="custom" data-id="' + escAttr(it.id) + '">自定义路径…</button>';
    if (it.custom) h += '<button class="env-btn warn" data-act="default" data-id="' + escAttr(it.id) + '">恢复默认</button>';
    if (d.site) h += '<button class="env-btn" data-act="site" data-url="' + escAttr(d.site) + '">官网 / 文档</button>';
    h += '<button class="env-btn" data-act="reload" data-id="' + escAttr(it.id) + '">重新加载</button>';
    h += "</div>";
    if (d.hint && d.installed !== false) h += '<div class="env-out">安装提示：' + esc(d.hint) + "</div>";
    (d.installed === false ? [] : (d.tools || [])).forEach(t => {
      h += '<div class="env-sec-head" style="cursor:default"><i class="bi bi-gear-wide-connected"></i> ' + esc(t.title) + "</div>";
      if (t.values && t.values.length) {
        h += '<div class="env-acts">' + t.values.map(v =>
          '<button class="env-btn" data-act="tool" data-id="' + escAttr(it.id) + '" data-key="' + escAttr(t.key) +
          '" data-value="' + escAttr(v.value) + '">' + esc(v.label) + "</button>").join("") + "</div>";
      } else if (t.fixed) {
        h += '<div class="env-acts"><button class="env-btn primary" data-act="tool" data-id="' + escAttr(it.id) +
             '" data-key="' + escAttr(t.key) + '">应用</button></div>';
      } else {
        h += '<div class="env-acts"><input class="env-tool-input" data-for="' + escAttr(t.key) +
             '" value="' + escAttr(t.arg_default) + '" placeholder="' + escAttr(t.arg_placeholder) +
             '"><button class="env-btn primary" data-act="tool-input" data-id="' + escAttr(it.id) +
             '" data-key="' + escAttr(t.key) + '">执行</button></div>';
      }
      if (t.note) h += '<div class="env-sum" style="padding:0 0 2px">' + esc(t.note) + "</div>";
    });
    h += '<div class="env-out" id="envToolOut" style="display:none"></div>';
    (d.sections || []).forEach(sec => {
      h += '<div class="env-sec-head" style="cursor:default"><i class="bi bi-terminal"></i> ' + esc(sec.title) + "</div>";
      h += '<div class="env-out">' + (sec.cmd ? '<span class="h">$ ' + esc(sec.cmd) + "</span>\n" : "") +
           esc(sec.output) + "</div>";
    });
    box.innerHTML = h;
    return box;
  }

  /* ---------- 一键安装（用户级方案自动执行，系统包方案给命令复制） ---------- */
  function envInstallSection(it, d) {
    let h = '<div class="env-sec-head" style="cursor:default"><i class="bi bi-download"></i> 安装</div>';
    const pd = ENV.plans[it.id];
    if (!pd) return h + '<div class="env-out">正在获取安装方案…</div>';
    if (pd.error) return h + '<div class="env-out"><span class="err">' + esc(pd.error) + "</span></div>";
    if (!pd.plans || !pd.plans.length) {
      h += '<div class="env-plan-note">' + esc(pd.message || "该运行时不提供一键安装，请参考官网文档手动安装。") + "</div>";
      return h;
    }
    pd.plans.forEach(p => {
      const user = p.mode === "user";
      h += '<div class="env-plan">';
      h += '<div class="env-plan-head"><i class="bi ' + (user ? "bi-download" : "bi-shield-exclamation") + '"></i>' +
           esc(p.label) + "</div>";
      const meta = [];
      if (p.version) meta.push("最新版本 " + p.version);
      else if (p.resolving) meta.push("版本解析中…（可直接装最新稳定版）");
      if (p.size) meta.push(p.size);
      meta.push(user ? "安装到 " + (p.install_dir || "~/.local") : "需要管理员权限");
      h += '<div class="env-plan-meta">' + esc(meta.join(" · ")) + "</div>";
      if (p.note) h += '<div class="env-plan-note">' + esc(p.note) + "</div>";
      if (p.error) h += '<div class="env-plan-note err">' + esc(p.error) + "</div>";
      if (user && !pd.enabled) h += '<div class="env-plan-note err">已禁用一键安装（config.ENABLE_AUTO_INSTALL = False）</div>';
      h += '<div class="env-acts">';
      if (user) {
        const dis = (!p.enabled || !!p.error) ? " disabled" : "";
        h += '<button class="env-btn primary" data-act="install" data-id="' + escAttr(it.id) +
             '" data-key="' + escAttr(p.key) + '"' + dis + '><i class="bi bi-download"></i> 一键安装</button>';
        if (p.error) h += '<button class="env-btn" data-act="plans" data-id="' + escAttr(it.id) + '">重新获取版本</button>';
        if (p.url) h += '<button class="env-btn" data-act="copy" data-text="' + escAttr(p.url) + '">复制下载地址</button>';
      } else if (p.command) {
        h += '<button class="env-btn" data-act="copy" data-text="' + escAttr(p.command) +
             '"><i class="bi bi-copy"></i> 复制安装命令</button>';
      }
      h += "</div></div>";
    });
    h += '<div class="env-acts" id="envInstallBar" style="display:none">' +
         '<button class="env-btn warn" data-act="inst-cancel"><i class="bi bi-x-circle"></i> 取消安装</button></div>';
    h += '<div class="env-out" id="envInstallLog" style="display:none"></div>';
    return h;
  }

  /* 安装方案：先要静态方案（resolve=0，服务端不联网，秒回），再后台补「最新版本 / 下载地址」。
     以前直接请求解析版本，官方源不通时要等几十秒，界面一直停在「正在获取安装方案…」。 */
  async function loadEnvPlans(id) {
    try {
      const r = await fetch("/api/env/install?id=" + encodeURIComponent(id) + "&resolve=0");
      const d = await r.json();
      ENV.plans[id] = d;
      if ((d.plans || []).some(p => p.resolving)) {
        fetch("/api/env/install?id=" + encodeURIComponent(id) + "&resolve=1")
          .then(x => x.json())
          .then(full => {
            ENV.plans[id] = full;
            if (ENV.openId === id) renderEnv();                       // 侧栏展开中的详情
            if (ENV.view.openId === id && typeof envViewFillSlot === "function") envViewFillSlot(id, true);
          })
          .catch(() => {});                                           // 解析失败就保持「版本待确认」
      }
    } catch (e) {
      ENV.plans[id] = { error: "获取安装方案失败：" + (e.message || e), plans: [] };
    }
  }

  const INSTALL = { tid: null, timer: null, offset: 0 };

  function envInstallBusy(on) {
    const bar = $("envInstallBar");
    if (bar) bar.style.display = on ? "flex" : "none";
  }

  function envInstallLog(html) {
    const box = $("envInstallLog");
    if (!box) return;
    box.style.display = "block";
    box.innerHTML = html;
  }
  function envInstallAppend(html) {
    const box = $("envInstallLog");
    if (!box) return;
    box.style.display = "block";
    box.insertAdjacentHTML("beforeend", html + "\n");
    box.scrollTop = box.scrollHeight;
  }

  async function envInstall(id, key) {
    const pd = ENV.plans[id] || {};
    const plan = (pd.plans || []).find(p => p.key === key) || {};
    const ok = await uiConfirm("一键安装：" + (plan.label || id),
      "版本：" + (plan.version || "最新稳定版") + "\n" +
      "大小：" + (plan.size || "未知") + "\n" +
      "安装到：" + (plan.install_dir || "~/.local") + "\n\n" +
      (plan.url ? "下载地址：" + plan.url + "\n\n" : "") +
      "安装到用户目录，不使用管理员权限；可随时删除安装目录卸载。",
      "开始安装", false);
    if (!ok) return;
    envInstallLog('<span class="h">正在启动安装任务…</span>');
    try {
      const r = await fetch("/api/env/install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, key }),
      });
      const d = await r.json();
      if (d.error) { envInstallLog('<span class="err">' + esc(d.error) + "</span>"); toast(d.error, "err"); return; }
      INSTALL.tid = d.tid; INSTALL.offset = 0;
      envInstallLog('<span class="h">' + esc(d.title || "安装中…") + "</span>");
      envInstallBusy(true);
      envInstallPoll();
    } catch (e) {
      envInstallLog('<span class="err">' + esc(e.message || e) + "</span>");
    }
  }

  function envInstallPoll() {
    clearTimeout(INSTALL.timer);
    if (!INSTALL.tid) return;
    fetch("/api/env/install/log?tid=" + encodeURIComponent(INSTALL.tid) + "&offset=" + INSTALL.offset)
      .then(r => r.json())
      .then(d => {
        if (d.error) { envInstallAppend('<span class="err">' + esc(d.error) + "</span>"); INSTALL.tid = null; return; }
        INSTALL.offset = d.offset;
        (d.lines || []).forEach(l => envInstallAppend('<span class="' + esc(l.c || "") + '">' + esc(l.m) + "</span>"));
        if (!d.done) { INSTALL.timer = setTimeout(envInstallPoll, 700); return; }
        INSTALL.tid = null;
        envInstallBusy(false);
        if (d.ok) {
          const where = (d.installed && d.installed.length) ? "：" + esc(d.installed.join("  ")) : "";
          envInstallAppend('<span class="ok">✔ 安装完成' + where + "</span>");
          toast("安装完成，正在刷新环境检测", "ok");
          setTimeout(() => loadEnv(true), 800);
        } else {
          envInstallAppend('<span class="err">✘ 安装失败：' + esc(d.error || "") + "</span>");
          toast("安装失败：" + (d.error || ""), "err");
        }
        // 编辑区「运行管理」开着的话，右侧的安装记录（数据库）同步刷新
        if ($("envView") && typeof envHistLoad === "function") setTimeout(envHistLoad, 400);
      })
      .catch(e => { envInstallAppend('<span class="err">' + esc(e.message || e) + "</span>"); INSTALL.tid = null; });
  }

  function envToggleDetail(id) {
    if (ENV.openId === id) { ENV.openId = null; renderEnv(); return; }
    ENV.openId = id;
    renderEnv();          // 详情缺失时由 renderEnv 触发加载，避免刷新后详情区空着
  }

  async function loadEnvDetail(id) {
    try {
      const r = await fetch("/api/env/detail?id=" + encodeURIComponent(id));
      ENV.details[id] = await r.json();
    } catch (e) { ENV.details[id] = { error: "加载失败：" + (e.message || e) }; }
    if (ENV.openId === id) renderEnv();          // 先渲染详情，不等待安装方案
    const d = ENV.details[id];
    if (d && d.installed === false && !ENV.plans[id]) {
      // 安装方案需要联网解析版本，异步补充（期间显示“正在获取安装方案…”）
      loadEnvPlans(id).then(() => {
        if (ENV.openId === id) renderEnv();
        // 编辑区大页同样要补（它用自己的 openId，否则会一直停在“正在获取安装方案…”）
        if (typeof envViewFillSlot === "function" && ENV.view.openId === id) envViewFillSlot(id, true);
      });
    }
  }

  function renderEnvVars() {
    const vars = (ENV.data && ENV.data.custom_env) || {};
    const keys = Object.keys(vars);
    $("envVarsCnt").textContent = keys.length ? "(" + keys.length + ")" : "";
    const box = $("envVars");
    if (!keys.length) {
      box.innerHTML = '<div class="env-sum">未配置自定义环境变量（保存后对「运行当前文件」与内置终端生效）</div>';
      return;
    }
    box.innerHTML = keys.map(k =>
      '<div class="env-var"><span class="k">' + esc(k) + '</span><span class="v" title="' + escAttr(vars[k]) + '">' +
      esc(vars[k]) + '</span><button class="x" data-act="var-del" data-key="' + escAttr(k) + '" title="删除">×</button></div>'
    ).join("");
    envBind();
  }

  async function loadEnvSystem() {
    if (ENV.sys) { renderEnvSystem(); return; }
    $("envSys").innerHTML = "加载中…";
    try {
      const r = await fetch("/api/env/system");
      ENV.sys = await r.json();
      renderEnvSystem();
    } catch (e) { $("envSys").innerHTML = '<span class="err">加载失败：' + esc(e.message || e) + "</span>"; }
  }

  function renderEnvSystem() {
    const s = ENV.sys;
    if (!s) return;
    let h = "";
    const row = (k, v) => '<div class="r"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>";
    h += row("操作系统", (s.os || "") + (s.distro ? " · " + s.distro : ""));
    h += row("架构 / 主机", (s.arch || "") + " · " + (s.hostname || ""));
    h += row("CPU / 内存", s.cpu + " 核 · " + fmtSize(s.mem_total));
    h += row("运行用户", s.user || "-");
    h += row("服务端 Python", (s.server_python || "") + "（" + (s.server_executable || "") + "）");
    h += '<div class="env-sec-head" style="cursor:default"><i class="bi bi-sliders"></i> 相关环境变量</div>';
    const envs = (s.envs || []).filter(e => e.value);
    h += envs.length ? envs.map(e =>
      '<div class="r"><span class="k">' + esc(e.key) + '</span><span class="v">' + esc(e.value) + "</span></div>").join("")
      : row("", "（未设置 JAVA_HOME / GOPATH / VIRTUAL_ENV 等）");
    h += '<div class="env-sec-head" style="cursor:default"><i class="bi bi-diagram-3"></i> PATH（' +
         (s.path_entries || []).length + " 项）</div>";
    h += (s.path_entries || []).map(p => '<div class="path">' + esc(p) + "</div>").join("");
    $("envSys").innerHTML = h;
  }

  /* 复制到剪贴板（http 访问时 navigator.clipboard 不可用，回退到 execCommand） */
  function copyText(text) {
    const ok = () => toast("已复制到剪贴板", "ok");
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); ok(); } catch (_) { toast("复制失败，请手动选择", "warn"); }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    } else fallback();
  }

  async function saveEnvConfig(payload) {
    const r = await fetch("/api/env/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d;
  }

  function envToolOut(html) {
    /* 侧栏面板与大页可能各有一个展开中的详情（同名 #envToolOut）：优先写当前可见的那个 */
    const boxes = Array.prototype.slice.call(document.querySelectorAll("#envToolOut"));
    const box = boxes.find(b => b.offsetParent !== null) || boxes[0];
    if (!box) return;
    box.style.display = "block";
    box.innerHTML = html;
  }

  async function envRunTool(id, key, value) {
    envToolOut('<span class="h">$ 执行中…</span>');
    try {
      const r = await fetch("/api/env/tool-action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, key, value: value || "", cwd: ROOT }),
      });
      const d = await r.json();
      if (d.error) { envToolOut('<span class="err">' + esc(d.error) + "</span>"); toast(d.error, "err"); return; }
      let out = '<span class="h">$ ' + esc(d.command) + "</span>\n";
      if (d.cwd) out += '<span class="h">cwd: ' + esc(d.cwd) + "</span>\n";
      out += (d.ok ? '<span class="ok">✔ 执行成功（退出码 0）</span>\n' : '<span class="err">✘ 退出码 ' + esc(d.exit_code) + "</span>\n");
      if (d.stdout) out += esc(d.stdout) + "\n";
      if (d.stderr) out += '<span class="err">' + esc(d.stderr) + "</span>\n";
      if (d.note) out += '<span class="h">' + esc(d.note) + "</span>";
      envToolOut(out);
      toast(d.ok ? "配置已更新" : "命令执行失败", d.ok ? "ok" : "warn");
    } catch (e) {
      envToolOut('<span class="err">' + esc(e.message || e) + "</span>");
      toast("执行失败：" + (e.message || e), "err");
    }
  }

  async function envAct(el) {
    const act = el.dataset.act;
    if (act === "ai-install") {                  // 点名的运行时预填进 AI 需求框
      const id = el.dataset.id;
      const it = ((ENV.data && ENV.data.items) || []).find(x => x.id === id);
      const seed = "安装 " + ((it && it.label) || id) + "（本机未安装），以及跑通它常用的配套工具";
      if (!$("envView") || !active || active.path !== ENV_VIEW_PATH) envViewOpen();   // 大页没开就先打开
      setTimeout(() => envAiOpen(seed, [id]), 80);      // 等大页渲染完再填
      return;
    }
    if (act === "copy") { copyText(el.dataset.text || ""); return; }
    if (act === "site") { window.open(el.dataset.url, "_blank", "noopener"); return; }
    if (act === "term") {
      await termEnsure();                    // 无终端会自动新建并打开面板
      termRun(el.dataset.cmd || "");
      return;
    }
    if (act === "custom") {
      const id = el.dataset.id;
      const cur = (ENV.data && ENV.data.overrides && ENV.data.overrides[id]) || "";
      const p = await uiPrompt("自定义解释器路径（" + id + "）", cur,
        "填写可执行文件的绝对路径，例如 /usr/local/bin/python3.12；留空则恢复系统 PATH");
      if (p === null) return;
      try { await saveEnvConfig({ overrides: { [id]: p.trim() } }); toast("已保存自定义路径", "ok"); await loadEnv(true); }
      catch (e) { toast("保存失败：" + (e.message || e), "err"); }
      return;
    }
    if (act === "default") {
      try { await saveEnvConfig({ overrides: { [el.dataset.id]: "" } }); toast("已恢复默认", "ok"); await loadEnv(true); }
      catch (e) { toast("操作失败：" + (e.message || e), "err"); }
      return;
    }
    if (act === "reload") {
      delete ENV.details[el.dataset.id];
      delete ENV.plans[el.dataset.id];
      await loadEnvDetail(el.dataset.id);
      return;
    }
    if (act === "plans") {                 // 重新获取安装方案（版本解析失败时用）
      delete ENV.plans[el.dataset.id];
      await loadEnvPlans(el.dataset.id);
      renderEnv();
      return;
    }
    if (act === "install") { await envInstall(el.dataset.id, el.dataset.key); return; }
    if (act === "inst-cancel") {
      if (!INSTALL.tid) return;
      try {
        await fetch("/api/env/install/cancel", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tid: INSTALL.tid }),
        });
        toast("已请求取消安装", "warn");
      } catch (_) { toast("取消失败", "err"); }
      return;
    }
    if (act === "tool") { envRunTool(el.dataset.id, el.dataset.key, el.dataset.value || ""); return; }
    if (act === "tool-input") {
      const box = el.closest(".env-acts");
      const inp = box && box.querySelector(".env-tool-input");
      envRunTool(el.dataset.id, el.dataset.key, inp ? inp.value.trim() : "");
      return;
    }
    if (act === "var-del") {
      const vars = Object.assign({}, (ENV.data && ENV.data.custom_env) || {});
      delete vars[el.dataset.key];
      try { await saveEnvConfig({ env: vars }); toast("已删除变量", "ok"); await loadEnv(true); }
      catch (e) { toast("删除失败：" + (e.message || e), "err"); }
      return;
    }
  }

  function envBind() {
    document.querySelectorAll("#envPanel [data-act]").forEach(el => { el.onclick = () => envAct(el); });
  }

  /* 面板交互绑定 */
  $("envFilter").addEventListener("input", (e) => { ENV.filter = e.target.value; renderEnv(); });
  $("envRefresh").onclick = () => { toast("正在重新检测运行环境…", "ok"); loadEnv(true); };
  $("envOnlyInstalled").onclick = () => {
    ENV.onlyInstalled = !ENV.onlyInstalled;
    $("envOnlyInstalled").classList.toggle("on", ENV.onlyInstalled);
    renderEnv();
  };
  $("envVarsHead").onclick = () => {
    const box = $("envVarsBox"), open = box.style.display === "none";
    box.style.display = open ? "block" : "none";
    $("envVarsHead").querySelector("i").className = "bi " + (open ? "bi-caret-down" : "bi-caret-right");
    if (open) { if (!ENV.data) loadEnv(false); else renderEnvVars(); }
  };
  $("envSysHead").onclick = () => {
    const box = $("envSysBox"), open = box.style.display === "none";
    box.style.display = open ? "block" : "none";
    $("envSysHead").querySelector("i").className = "bi " + (open ? "bi-caret-down" : "bi-caret-right");
    if (open) loadEnvSystem();
  };
  /* ---------- 添加环境变量：可视化表单（变量名候选 / 常用值 / 路径浏览 / 校验） ----------
     以前是连着弹两次原生输入框（先名字再值），容易填错、也看不到常用取值。
     这里改成一张表单：点候选名 → 自动给出该变量的常用值；路径类变量可直接浏览文件夹。 */
  const ENV_VAR_PRESETS = [
    { k: "JAVA_HOME", d: "JDK 根目录（bin/java 的上一级）", path: true,
      v: ["/usr/lib/jvm/java-17-openjdk-amd64", "/usr/lib/jvm/default-java", "~/Desktop/CODE/jdk"] },
    { k: "GOPATH", d: "Go 工作区目录", path: true, v: ["~/go"] },
    { k: "VIRTUAL_ENV", d: "Python 虚拟环境目录", path: true, v: ["venv", ".venv"] },
    { k: "NODE_ENV", d: "Node 运行模式", v: ["development", "production", "test"] },
    { k: "PIP_INDEX_URL", d: "pip 镜像源",
      v: ["https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.aliyun.com/pypi/simple/", "https://pypi.org/simple"] },
    { k: "NPM_CONFIG_REGISTRY", d: "npm 镜像源", v: ["https://registry.npmmirror.com", "https://registry.npmjs.org"] },
    { k: "HTTP_PROXY", d: "HTTP 代理", v: ["http://127.0.0.1:10808", "http://127.0.0.1:7890"] },
    { k: "HTTPS_PROXY", d: "HTTPS 代理", v: ["http://127.0.0.1:10808", "http://127.0.0.1:7890"] },
    { k: "TZ", d: "时区", v: ["Asia/Shanghai", "UTC"] },
  ];

  function uiEnvVarForm() {
    return new Promise((resolve) => {
      const ov = $("modalOverlay");
      const cur = (ENV.data && ENV.data.custom_env) || {};
      const box = document.createElement("div");
      box.className = "ide-modal env-var-modal";
      box.innerHTML =
        '<div class="m-title evf-title">' +
          '<span class="evf-badge"><i class="bi bi-braces"></i></span>' +
          '<span class="evf-tt"><b>添加环境变量</b><small>写入项目配置，对「运行当前文件」与内置终端生效</small></span>' +
        "</div>" +
        '<div class="m-body">' +
          '<div class="m-row"><label class="evf-lab"><i class="bi bi-tag"></i>变量名</label>' +
            '<input id="evfName" spellcheck="false" autocomplete="off" placeholder="例如 JAVA_HOME（字母 / 数字 / 下划线）">' +
          "</div>" +
          '<div class="evf-chips" id="evfNameChips"></div>' +
          '<div class="m-row"><label class="evf-lab"><i class="bi bi-lightning-charge"></i>变量值</label>' +
            '<div class="evf-val">' +
              '<input id="evfValue" spellcheck="false" autocomplete="off" placeholder="选择下面的常用值，或直接填写">' +
              '<button class="evf-browse" id="evfBrowse" type="button" title="浏览本机文件夹（路径类变量）"><i class="bi bi-folder2-open"></i></button>' +
            "</div>" +
          "</div>" +
          '<div class="evf-vlist" id="evfValueChips"></div>' +
          '<div class="evf-tip" id="evfTip"><i class="bi bi-info-circle"></i><span>可以从常用值里选一个，或直接填写</span></div>' +
        "</div>" +
        '<div class="m-foot"><button class="m-cancel" id="evfCancel">取消</button>' +
        '<button class="m-ok" id="evfOk">保存</button></div>';
      ov.appendChild(box);
      ov.classList.add("show");

      const nameEl = box.querySelector("#evfName");
      const valEl = box.querySelector("#evfValue");
      const nChips = box.querySelector("#evfNameChips");
      const vChips = box.querySelector("#evfValueChips");
      const tipEl = box.querySelector("#evfTip");
      const browseEl = box.querySelector("#evfBrowse");

      const close = (val) => {
        ov.classList.remove("show");
        ov.innerHTML = "";
        ov.onkeydown = null; ov.onmousedown = null;
        resolve(val);
      };
      const tip = (msg, cls) => {
        tipEl.querySelector("span").textContent = msg;
        tipEl.className = "evf-tip" + (cls ? " " + cls : "");
      };
      const presetOf = name => ENV_VAR_PRESETS.find(p => p.k === name);

      /* 变量名候选：点一下填进去 */
      ENV_VAR_PRESETS.forEach(p => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "evf-chip";
        b.title = p.d;
        b.textContent = p.k;
        b.onclick = () => { nameEl.value = p.k; refresh(p.k); valEl.focus(); };
        nChips.appendChild(b);
      });

      /* 值候选：按变量名给常用值（路径类补上当前项目里的 venv 等） */
      function refresh(name) {
        const p = presetOf(name);
        vChips.innerHTML = "";
        let values = p ? p.v.slice() : [];
        if (p && p.path) {
          const root = (typeof ROOT === "string" && ROOT) ? ROOT.replace(/\/+$/, "") : "";
          if (root) values = values.map(v => (v.indexOf("/") < 0 ? root + "/" + v : v));
        }
        /* 本机已有的同名变量值：直接可点（省得手抄路径） */
        const sysEnv = ((ENV.sys && ENV.sys.envs) || []).find(e => e.key === name);
        if (sysEnv && sysEnv.value && values.indexOf(sysEnv.value) < 0) values.unshift(sysEnv.value);
        values.forEach(v => {
          const b = document.createElement("button");
          b.type = "button";
          /* 候选值带图标：URL 链接 / 路径文件夹 / 其他变量 */
          const icon = /^https?:\/\//i.test(v) ? "bi-link-45deg" : /[/\\]/.test(v) ? "bi-folder2" : "bi-tag";
          b.className = "evf-vrow";
          b.innerHTML = '<i class="bi ' + icon + '"></i><span></span>';
          b.querySelector("span").textContent = v;
          b.title = v;
          b.onclick = () => { valEl.value = v; tip("已填入：" + v); };
          vChips.appendChild(b);
        });
        nChips.querySelectorAll(".evf-chip").forEach(c => c.classList.toggle("on", c.textContent === name));
        const dup = name && Object.prototype.hasOwnProperty.call(cur, name);
        if (dup) tip("已存在同名变量（当前值：" + (cur[name] || "空") + "），保存后会覆盖", "warn");
        else if (p) tip(p.d + "；可以从下面选一个常用值");
        else tip("保存后对「运行当前文件」与内置终端生效");
      }

      nameEl.addEventListener("input", () => refresh(nameEl.value.trim()));
      nameEl.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); valEl.focus(); }
        if (e.key === "Escape") { e.preventDefault(); close(null); }
      });
      valEl.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        if (e.key === "Escape") { e.preventDefault(); close(null); }
      });
      browseEl.onclick = async () => {
        const start = (valEl.value || "").trim() || (typeof ROOT === "string" && ROOT) || "/";
        const picked = await pickFolderDialog(start.startsWith("/") ? start : (ROOT || "/"), {
          title: "选择文件夹", okText: "用这个文件夹",
          hint: "只显示文件夹；选中后会把绝对路径填进变量值。",
        });
        if (picked) { valEl.value = picked; tip("已填入：" + picked); }
        nameEl.focus();
      };

      function submit() {
        const name = (nameEl.value || "").trim();
        const value = (valEl.value || "").trim();
        if (!name) { tip("请先填变量名，或点上面的常用变量", "err"); nameEl.focus(); return; }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { tip("变量名只能包含字母、数字、下划线，且不能以数字开头", "err"); nameEl.focus(); return; }
        if (!value) { tip("变量值不能为空", "err"); valEl.focus(); return; }
        close({ key: name, value: value });
      }

      box.querySelector("#evfOk").onclick = submit;
      box.querySelector("#evfCancel").onclick = () => close(null);
      ov.onmousedown = (e) => { if (e.target === ov) close(null); };
      ov.onkeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
      refresh("");
      nameEl.focus();
    });
  }

  $("envVarAdd").onclick = async () => {
    const r = await uiEnvVarForm();
    if (!r) return;
    const vars = Object.assign({}, (ENV.data && ENV.data.custom_env) || {});
    vars[r.key] = r.value;
    try {
      await saveEnvConfig({ env: vars });
      toast("已保存 " + r.key, "ok");
      await loadEnv(true);
      $("envVarsBox").style.display = "block";
    } catch (e) { toast("保存失败：" + (e.message || e), "err"); }
  };

  /* ==================================================================
     编辑区「运行管理」标签页：大屏总览（统计卡片 / 分类列表 / 展开详情 /
     自定义环境变量 / 系统信息）。数据与侧栏面板共用 ENV 缓存与 API，
     任何一侧刷新或改动，另一侧都会同步（loadEnv 末尾会回调 envViewRender）。
     ================================================================== */
  const ENV_VIEW_PATH = "\u0000envview";
  ENV.view = { openId: null, filter: "", onlyInstalled: false };
  /* AI 安装方案：内置接口 POST /api/env/ai-install（模型由「设置 → 系统 AI」的 envinstall 模块决定）
     query 存使用者的需求描述，inst 是一键安装的队列状态（逐项跑 /api/env/install 并轮询日志） */
  ENV.ai = {
    open: false, busy: false, data: null, error: "", ids: [], query: "",
    started: 0, timer: null,
    inst: { busy: false, total: 0, idx: 0, tid: "", log: [] },
  };
  /* 安装记录（数据库 env_install_history）：items 为最近 N 条，open 是展开的 seq，logs 缓存展开过的日志 */
  ENV.hist = { items: null, total: 0, open: 0, logs: {}, error: "" };

  function envViewOpen() {
    let tab = findTab(ENV_VIEW_PATH);
    if (!tab) {
      const host = document.createElement("div");
      host.className = "cm-host env-view-host";
      host.innerHTML = '<div class="env-view scroll-thin" id="envView"></div>';
      const dw = currentWrap();
      (dw || edGroups).appendChild(host);
      tab = {
        path: ENV_VIEW_PATH, host: host, cm: null, original: "", dirty: false,
        group: curGroup, name: "运行管理", displayPath: "运行管理", relPath: "",
        iconHtml: '<i class="bi bi-cpu" style="color:#6fcf8a"></i>',
      };
      tab.onBeforeClose = () => { ENV.view.openId = null; return true; };
      // 切回本标签时同步一次（期间可能在侧栏改过自定义路径 / 环境变量）
      tab.onActivate = () => setTimeout(() => {
        if (findTab(ENV_VIEW_PATH) && active && active.path === ENV_VIEW_PATH) envViewRefresh();
      }, 0);
      tabs.push(tab);
      renderTabsAll();
    }
    activate(tab);
    envViewRefresh();
    return tab;
  }

  async function envViewRefresh() {
    if (!findTab(ENV_VIEW_PATH)) return;
    if (!ENV.data) { try { await loadEnv(false); } catch (_) {} }   // 侧栏还没检测过：先拉一次
    if (!ENV.sys) loadEnvSystem().then(() => { if ($("envView")) envViewRenderSide(); }).catch(() => {});   // 系统信息后台补，到了自然重绘
    envViewRender();
  }

  /* ---------- 渲染 ---------- */
  function envViewRender() {
    const box = $("envView");
    if (!box) return;
    const keepScroll = box.scrollTop;      // 整页重绘会丢滚动位置，先存后还（否则看起来像跳一下）
    const data = ENV.data;
    if (!data) {
      box.innerHTML = '<div class="ev-loading"><i class="ev-spin"></i> 正在检测运行环境…</div>';
      return;
    }
    const items = data.items || [];
    const cats = data.categories || [];
    const s = data.summary || {};
    const inst = items.filter(x => x.installed).length;
    /* 顶部：标题 + 摘要 + 操作 */
    let h = '<div class="ev-head">' +
      '<div class="ev-title"><i class="bi bi-cpu"></i><div><b>运行管理</b>' +
      '<span class="ev-sub">已安装 <b>' + (s.installed != null ? s.installed : inst) + "</b> / " +
      (s.total != null ? s.total : items.length) + " 项 · 检测于 " +
      esc(data.detected_at || "-") + (data.cached ? "（缓存）" : "") + "</span></div></div>" +
      '<div class="ev-acts">' +
      '<button class="env-btn' + (ENV.view.onlyInstalled ? " primary" : "") + '" data-vact="only">' +
      '<i class="bi bi-funnel"></i> 只看已安装</button>' +
      '<button class="env-btn" data-vact="refresh"><i class="bi bi-arrow-clockwise"></i> 重新检测</button>' +
      '<button class="env-btn ev-ai-btn" data-vact="ai-install"><i class="bi bi-stars"></i> AI 安装</button>' +
      "</div></div>";
    /* 统计卡片：总数 + 各分类 + 自定义变量 */
    const card = (ic, num, lbl, cls) =>
      '<div class="ev-card ' + (cls || "") + '"><i class="bi ' + ic + '"></i><b>' + num + "</b><span>" + esc(lbl) + "</span></div>";
    h += '<div class="ev-cards">' +
      card("bi-check2-circle", inst + "/" + items.length, "已安装 / 检测项", "ok") +
      cats.map(c => {
        const list = items.filter(x => x.category === c);
        return list.length
          ? card("bi-collection", list.filter(x => x.installed).length + "/" + list.length, c)
          : "";
      }).join("") +
      card("bi-braces", Object.keys(data.custom_env || {}).length, "自定义变量") +
      "</div>";
    /* 主体两列：左边分类列表（可筛选 / 展开详情），右边环境变量 + 系统信息 */
    h += '<div class="ev-cols"><div class="ev-left">' +
      '<div class="ev-filter"><i class="bi bi-search"></i>' +
      '<input id="envViewFilter" placeholder="筛选运行时 / 工具…" value="' + escAttr(ENV.view.filter) + '" spellcheck="false"></div>' +
      '<div class="ev-list" id="envViewList"></div></div>' +
      '<div class="ev-right" id="envViewSide"></div></div>';
    box.innerHTML = h;
    box.scrollTop = keepScroll;
    envViewRenderList();
    envViewRenderSide();
    envAiRestore();                 // AI 安装方案是独立节点，重绘后按状态补回来
    /* 交互绑定（筛选框不重建，输入不丢焦点；var-add 在 envViewRenderSide 里单独绑，这里不要覆盖它） */
    box.querySelectorAll('[data-vact="only"],[data-vact="refresh"],[data-vact="ai-install"]').forEach(el => {
      el.onclick = async () => {
        const a = el.dataset.vact;
        if (a === "only") { ENV.view.onlyInstalled = !ENV.view.onlyInstalled; envViewRender(); }
        else if (a === "refresh") {
          toast("正在重新检测运行环境…", "ok");
          ENV.sys = null;
          await loadEnv(true);
          envViewRefresh();
        } else if (a === "ai-install") {
          envAiOpen("");
        }
      };
    });
    const fin = $("envViewFilter");
    if (fin) fin.addEventListener("input", () => { ENV.view.filter = fin.value; envViewRenderList(); });
  }

  /* 左列：分类 + 条目列表（复用侧栏的 .env-row 样式；点击展开详情） */
  function envViewRenderList() {
    const box = $("envViewList");
    if (!box) return;
    const keep = box.scrollTop;
    const data = ENV.data;
    if (!data) { box.innerHTML = '<div class="env-sum">正在检测…</div>'; return; }
    const q = ENV.view.filter.trim().toLowerCase();
    let any = false, h = "";
    (data.categories || []).forEach(cat => {
      let list = (data.items || []).filter(x => x.category === cat);
      if (ENV.view.onlyInstalled) list = list.filter(x => x.installed);
      if (q) list = list.filter(x => (x.label + " " + x.id + " " + x.category + " " + (x.path || "")).toLowerCase().includes(q));
      if (!list.length) return;
      any = true;
      h += '<div class="env-group" style="cursor:default"><i class="bi bi-collection"></i>' + esc(cat) +
        ' <span class="cnt">' + list.filter(x => x.installed).length + "/" + list.length + "</span></div>";
      list.forEach(it => {
        const open = ENV.view.openId === it.id;
        h += '<div class="env-item">' +
          '<div class="env-row' + (it.installed ? "" : " off") + (open ? " open" : "") +
          '" data-vitem="' + escAttr(it.id) + '" title="' +
          escAttr(it.installed ? (it.path || "") : (it.hint || "未安装")) + '">' +
          '<span class="ic"><i class="bi ' + escAttr(it.icon || "bi-box") + '"></i></span>' +
          '<span class="nm">' + esc(it.label) + "</span>" +
          (it.custom ? '<span class="env-badge">自定义</span>' : "") +
          '<span class="env-ver' + (it.installed ? "" : " off") + '">' +
          esc(it.version || (it.installed ? "已安装" : "未安装")) + "</span></div>" +
          (open ? '<div class="ev-detail-slot" data-slot="' + escAttr(it.id) + '"><span class="env-sum">正在加载详情…</span></div>' : "") +
          "</div>";
      });
    });
    box.innerHTML = any ? h : '<div class="env-sum" style="padding:14px 6px">没有匹配项</div>';
    box.scrollTop = keep;
    box.querySelectorAll("[data-vitem]").forEach(el => {
      el.onclick = () => envViewToggleItem(el.dataset.vitem);
    });
    /* 展开项就地填详情：不重建整张列表，避免每次点击都跳一下 */
    if (ENV.view.openId) envViewFillSlot(ENV.view.openId, true);
  }

  /* 展开 / 收起某一项：只动对应的 slot，不动列表其余部分（列表 DOM 不重建 = 滚动位置不跳） */
  function envViewToggleItem(id) {
    const list = $("envViewList");
    if (!list) return;
    const keep = list.scrollTop;
    if (ENV.view.openId === id) {
      ENV.view.openId = null;
      list.querySelectorAll(".env-row.open").forEach(r => r.classList.remove("open"));
      const old = list.querySelector(".ev-detail-slot");
      if (old) old.remove();
      list.scrollTop = keep;
      return;
    }
    ENV.view.openId = id;
    list.querySelectorAll(".env-row.open").forEach(r => r.classList.remove("open"));
    const old = list.querySelector(".ev-detail-slot");
    if (old) old.remove();
    const row = list.querySelector('.env-row[data-vitem="' + CSS.escape(id) + '"]');
    if (row) {
      row.classList.add("open");
      const slot = document.createElement("div");
      slot.className = "ev-detail-slot";
      slot.dataset.slot = id;
      row.parentNode.appendChild(slot);          // 与 .env-row 同在 .env-item 内
    }
    list.scrollTop = keep;
    envViewFillSlot(id);
  }

  /* 把详情填进 slot（复用侧栏的 envDetailEl：安装方案 / 工具 / 候选文件全都有） */
  function envViewFillSlot(id, create) {
    const list = $("envViewList");
    if (!list) return;
    let slot = list.querySelector('.ev-detail-slot[data-slot="' + CSS.escape(id) + '"]');
    if (!slot && create) {
      const row = list.querySelector('.env-row[data-vitem="' + CSS.escape(id) + '"]');
      if (!row) return;
      slot = document.createElement("div");
      slot.className = "ev-detail-slot";
      slot.dataset.slot = id;
      row.parentNode.appendChild(slot);
    }
    if (!slot) return;
    const it = ((ENV.data && ENV.data.items) || []).find(x => x.id === id);
    if (!it) return;
    if (!ENV.details[id]) {
      slot.innerHTML = '<span class="env-sum">正在加载详情…</span>';
      loadEnvDetail(id).then(() => { if (ENV.view.openId === id) envViewFillSlot(id, true); });
      return;
    }
    const keepScroll = $("envView") ? $("envView").scrollTop : 0;
    slot.innerHTML = "";
    slot.appendChild(envDetailEl(it));
    slot.querySelectorAll("[data-act]").forEach(el => {
      el.onclick = async () => { await envAct(el); if (ENV.view.openId === id) envViewFillSlot(id, true); };
    });
    if ($("envView")) $("envView").scrollTop = keepScroll;
  }

  /* 右列：自定义环境变量 + 系统信息 */
  function envViewRenderSide() {
    const box = $("envViewSide");
    if (!box) return;
    const data = ENV.data || {};
    /* 环境变量 */
    const vars = data.custom_env || {};
    const vk = Object.keys(vars);
    let h = '<div class="ev-panelbox"><div class="ev-box-head"><i class="bi bi-braces"></i> 自定义环境变量' +
      '<button class="env-btn primary ev-mini" data-vact="var-add">+ 添加</button></div>';
    h += vk.length ? vk.map(k =>
      '<div class="env-var"><span class="k">' + esc(k) + '</span><span class="v" title="' + escAttr(vars[k]) + '">' +
      esc(vars[k]) + '</span><button class="x" data-act="var-del" data-key="' + escAttr(k) +
      '" title="删除"><i class="bi bi-x-lg"></i></button></div>').join("")
      : '<div class="env-sum" style="padding:2px 5px 8px">未配置（保存后对「运行当前文件」与内置终端生效）</div>';
    h += "</div>";
    /* 系统信息（与 renderEnvSystem 同源，但渲染进本页容器） */
    h += '<div class="ev-panelbox"><div class="ev-box-head"><i class="bi bi-motherboard"></i> 系统信息</div>';
    const sy = ENV.sys;
    if (sy) {
      const row = (k, v) => '<div class="r"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>";
      h += '<div class="env-sys">' +
        row("操作系统", (sy.os || "") + (sy.distro ? " · " + sy.distro : "")) +
        row("架构 / 主机", (sy.arch || "") + " · " + (sy.hostname || "")) +
        row("CPU / 内存", sy.cpu + " 核 · " + fmtSize(sy.mem_total)) +
        row("运行用户", sy.user || "-") +
        row("服务端 Python", (sy.server_python || "") + "（" + (sy.server_executable || "") + "）");
      const envs = (sy.envs || []).filter(e => e.value);
      h += envs.length ? envs.map(e =>
        '<div class="r"><span class="k">' + esc(e.key) + '</span><span class="v">' + esc(e.value) + "</span></div>").join("")
        : row("", "（未设置 JAVA_HOME / GOPATH / VIRTUAL_ENV 等）");
      h += "</div>";
    } else {
      h += '<div class="env-sum" style="padding:2px 5px 8px">加载中…</div>';
    }
    h += "</div>";
    /* 安装记录（落库的 env_install_history：每次一键安装一行，可展开看完整日志） */
    h += '<div class="ev-panelbox"><div class="ev-box-head"><i class="bi bi-clock-history"></i> 安装记录' +
      '<span class="ev-hist-tip" id="evHistTip"></span>' +
      '<button class="env-btn ev-mini" data-vact="hist-clear" title="只清空历史记录，不影响已装好的运行时">清空</button></div>' +
      '<div class="ev-hist" id="evHistList"></div></div>';
    box.innerHTML = h;
    box.querySelectorAll("[data-act='var-del']").forEach(el => {
      el.onclick = async () => { await envAct(el); envViewRefresh(); };
    });
    box.querySelectorAll("[data-vact='var-add']").forEach(el => { el.onclick = () => envViewVarAdd(); });
    box.querySelectorAll("[data-vact='hist-clear']").forEach(el => { el.onclick = () => envHistClear(); });
    envHistPaint();                      // 先用缓存画一遍，再去拉最新
    envHistLoad();
  }

  /* 大页里添加环境变量（与侧栏 envVarAdd 用同一张可视化表单） */
  async function envViewVarAdd() {
    const r = await uiEnvVarForm();
    if (!r) return;
    const vars = Object.assign({}, (ENV.data && ENV.data.custom_env) || {});
    vars[r.key] = r.value;
    try {
      await saveEnvConfig({ env: vars });
      toast("已保存 " + r.key, "ok");
      await loadEnv(true);          // 末尾会回调 envViewRender 同步本页
    } catch (e) { toast("保存失败：" + (e.message || e), "err"); }
  }

  /* ==================================================================
     安装记录（数据库 env_install_history）：侧栏一键安装与「AI 安装」共用一张表，
     开始安装就落一条 running，结束补结果 / 耗时 / 装出的可执行文件 / 完整日志；
     这里只负责展示（列表 + 点开看日志 + 清空）。
     ================================================================== */
  function envHistTime(ts) {
    const t = Number(ts || 0);
    if (!t) return "-";
    const d = new Date(t * 1000);
    const p = n => (n < 10 ? "0" + n : "" + n);
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function envHistState(r) {
    if (r.cancelled) return { cls: "cancel", icon: "bi-slash-circle", text: "已取消" };
    if (r.ok) return { cls: "ok", icon: "bi-check-circle-fill", text: "成功" };
    if (!r.finished_at) return { cls: "run", icon: "bi-question-circle", text: "未完成" };
    return { cls: "fail", icon: "bi-x-circle-fill", text: "失败" };
  }

  async function envHistLoad() {
    try {
      const r = await fetch("/api/env/install/history?limit=30");
      const d = await r.json();
      if (d && d.error) throw new Error(d.error);
      ENV.hist.items = d.items || [];
      ENV.hist.total = d.total || 0;
      ENV.hist.error = "";
    } catch (e) {
      ENV.hist.error = (e && e.message) || String(e);
    }
    envHistPaint();
  }

  function envHistPaint() {
    const box = $("evHistList");
    if (!box) return;
    const tip = $("evHistTip");
    const items = ENV.hist.items;
    if (tip) {
      tip.textContent = items
        ? (ENV.hist.total > items.length ? "最近 " + items.length + " / " + ENV.hist.total + " 条" : "共 " + items.length + " 条")
        : "";
    }
    if (ENV.hist.error) {
      box.innerHTML = '<div class="env-sum" style="padding:2px 5px">读取失败：' + esc(ENV.hist.error) + "</div>";
      return;
    }
    if (!items) { box.innerHTML = '<div class="env-sum" style="padding:2px 5px 8px">读取中…</div>'; return; }
    if (!items.length) {
      box.innerHTML = '<div class="env-sum" style="padding:2px 5px 8px">还没有安装记录（面板一键安装与「AI 安装」都会记在这里）</div>';
      return;
    }
    box.innerHTML = items.map(r => {
      const st = envHistState(r);
      const open = ENV.hist.open === r.seq;
      const meta = [
        envHistTime(r.started_at),
        r.finished_at ? (r.elapsed ? r.elapsed + " 秒" : "") : "（未正常结束）",
        r.source === "ai" ? "AI 安装" : "面板安装",
      ].filter(Boolean).join(" · ");
      const head = [];
      if (r.plan_key) head.push("方案 " + r.plan_key);
      if (r.mode) head.push(r.mode === "user" ? "用户级（~/.local）" : r.mode);
      if (r.installed) head.push("装出 " + String(r.installed).split("\n").filter(Boolean).join("、"));
      return '<div class="ev-hist-row' + (open ? " open" : "") + '" data-hseq="' + r.seq + '">' +
        '<span class="st ' + st.cls + '"><i class="bi ' + st.icon + '"></i></span>' +
        '<div class="main"><div class="nm">' + esc(r.label || r.rid || "未知") +
        (r.version ? ' <b>' + esc(r.version) + "</b>" : "") +
        ' <span class="tg ' + st.cls + '">' + st.text + "</span></div>" +
        '<div class="rs">' + esc(meta) + (r.error ? " · " + esc(r.error) : "") + "</div></div>" +
        '<span class="exp"><i class="bi bi-chevron-' + (open ? "up" : "down") + '"></i></span></div>' +
        (open ? '<div class="ev-hist-log">' +
          (head.length ? '<div class="ev-hist-meta">' + esc(head.join(" · ")) + "</div>" : "") +
          esc(ENV.hist.logs[r.seq] != null ? ENV.hist.logs[r.seq] : "正在读取日志…") + "</div>" : "");
    }).join("");
    box.querySelectorAll("[data-hseq]").forEach(el => {
      el.onclick = () => envHistToggle(Number(el.dataset.hseq));
    });
  }

  async function envHistToggle(seq) {
    ENV.hist.open = (ENV.hist.open === seq) ? 0 : seq;
    envHistPaint();
    if (!ENV.hist.open || ENV.hist.logs[seq] != null) return;
    try {
      const r = await fetch("/api/env/install/history/log?seq=" + seq);
      const d = await r.json();
      ENV.hist.logs[seq] = d.error ? ("读取失败：" + d.error) : (d.log || "（这次安装没有输出日志）");
    } catch (e) {
      ENV.hist.logs[seq] = "读取日志失败：" + (e.message || e);
    }
    if (ENV.hist.open === seq) envHistPaint();
  }

  async function envHistClear() {
    if (ENV.hist.items && !ENV.hist.items.length) { toast("没有可清空的记录", "info"); return; }
    const n = ENV.hist.total || (ENV.hist.items || []).length;
    const ok = await uiConfirm("清空安装记录",
      "将删除数据库里全部 " + n + " 条安装记录。\n已装好的运行环境不受影响，只是历史记录没了。", "清空", true);
    if (!ok) return;
    try {
      const r = await fetch("/api/env/install/history/clear", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = await r.json();
      if (d && d.error) throw new Error(d.error);
      ENV.hist = { items: [], total: 0, open: 0, logs: {}, error: "" };
      envHistPaint();
      toast("已清空安装记录", "ok");
    } catch (e) { toast("清空失败：" + (e.message || e), "err"); }
  }

  /* ==================================================================
     AI 安装运行环境：内置接口 POST /api/env/ai-install
     流程：填写需求（语言 / 版本 / 框架 / 服务）→ AI 给安装建议 → 一键安装（带进度条）。
     一键安装只跑白名单里的用户级方案（~/.local，不需要管理员权限），逐项调
     /api/env/install 并轮询 /api/env/install/log；系统包 / 手动项只给命令供复制。
     ================================================================== */

  const EV_AI_CHIPS = [
    { label: "Python + Flask", text: "做一个 Flask 后端项目，需要 Python 3.12、pip、venv，能跑 pytest" },
    { label: "Node + Vue 前端", text: "做一个 Vue 3 + Vite 前端项目，需要 Node.js LTS、npm 或 pnpm" },
    { label: "Java 17 + Maven", text: "做 Spring Boot 项目，需要 JDK 17 和 Maven" },
    { label: "PHP + Nginx + MySQL", text: "跑一个 PHP 网站，需要 PHP 8、Nginx、MySQL，最好有 Composer" },
  ];

  function envAiOs() {
    const sy = ENV.sys || {};
    const os = sy.os || "";
    return os ? (os + (sy.distro ? " " + sy.distro : "")) : "本机系统";
  }

  /* 方案卡片是独立节点，插在统计卡后面：不参与整页重绘，关闭时直接移除 */
  function envAiBoxEl() {
    let box = $("envAiBox");
    if (box) return box;
    const cards = document.querySelector(".env-view .ev-cards");
    if (!cards || !cards.parentNode) return null;
    box = document.createElement("div");
    box.className = "ev-panelbox ev-aibox";
    box.id = "envAiBox";
    if (cards.nextSibling) cards.parentNode.insertBefore(box, cards.nextSibling);
    else cards.parentNode.appendChild(box);
    return box;
  }

  function envAiRestore() {
    if (!ENV.ai.open) return;
    if (envAiBoxEl()) envAiPaint();
  }

  function envAiPaint() {
    const box = envAiBoxEl();
    if (!box) return;
    const a = ENV.ai;
    const d = a.data;
    let h = '<div class="ev-box-head"><i class="bi bi-stars"></i> AI 安装方案' +
      '<span class="ev-ai-tip">' + (d && d.model
        ? esc(d.model) + " · " + (Math.round((d.elapsed_ms || 0) / 100) / 10) + " 秒"
        : "描述需求 → 建议 → 一键安装") + "</span>" +
      '<span class="ev-ai-acts">' +
      '<button class="env-btn" data-vact="ai-close" title="收起"><i class="bi bi-x-lg"></i></button>' +
      "</span></div>";
    /* 需求输入区：AI 按这里的内容给建议（回车提交，Shift+回车换行） */
    h += '<div class="ev-ai-form">' +
      '<textarea id="evAiQuery" spellcheck="false" rows="2" placeholder="说说你要做什么：语言 / 版本 / 框架 / 需要哪些服务…&#10;例：Flask 项目，需要 Python 3.12、pip、Redis，能跑 pytest">' +
      esc(a.query || "") + "</textarea>" +
      '<div class="ev-ai-chips">' + EV_AI_CHIPS.map((c, i) =>
        '<button class="ev-chip" data-chip="' + i + '">' + esc(c.label) + "</button>").join("") + "</div>" +
      '<div class="ev-ai-form-act"><span class="ev-ai-hint">会按本机系统（' + esc(envAiOs()) + "）给建议</span>" +
      '<button class="env-btn primary" data-vact="ai-plan"' + (a.busy ? " disabled" : "") +
      '><i class="bi bi-stars"></i> ' + (a.busy ? "分析中…" : "让 AI 给方案") + "</button></div></div>";

    if (a.busy) {
      h += '<div class="ev-ai-loading"><i class="ev-spin"></i> 正在分析需求…已等待 <b id="evAiTime">0 秒</b></div>';
    } else if (a.error) {
      h += '<div class="env-out"><span class="err">' + esc(a.error) + "</span></div>" +
        '<div class="ev-ai-off">也可以到「设置 → 系统 AI」检查「运行环境 AI 安装」用的是哪个接口与模型</div>';
    } else if (d) {
      const items = d.items || [];
      h += '<div class="ev-ai-sum">' + esc(d.summary || (items.length ? "建议安装 " + items.length + " 项" : "没有需要新装的环境")) + "</div>";
      if (d.parse_error) h += '<div class="ev-ai-off">' + esc(d.parse_error) + "</div>";
      if (items.length) {
        const live = (ENV.data && ENV.data.items) || [];
        items.forEach((it, i) => {
          it._k = i;
          /* 用最新探测结果校正「是否已安装」：装完刷新后建议清单里就不再显示旧状态 */
          const cur = live.find(x => x.id === it.id);
          if (cur) { it.installed = !!cur.installed; it.installed_version = cur.version || ""; }
          if (!it._state) it._state = it.installed ? "skip" : "";
        });
        h += '<div class="ev-ai-prog" id="evAiProg"><span id="evAiProgBar"></span><b id="evAiProgTxt"></b></div>';
        h += '<div class="ev-ai-list" id="evAiList">' + items.map(envAiItemHtml).join("") + "</div>";
      }
      if ((d.notes || []).length) {
        h += '<div class="ev-ai-notes">' + d.notes.map(n => "· " + esc(n)).join("<br>") + "</div>";
      }
      if (d.risk) h += '<div class="ev-ai-risk"><i class="bi bi-shield-exclamation"></i> ' + esc(d.risk) + "</div>";
      if (!items.length && d.text) {                 // 模型没按 JSON 回：退化成纯文本
        h += '<div class="ev-ai-body"><div class="bubble ai-md ev-ai-md">' +
          (typeof aiMd === "function" ? aiMd(d.text) : esc(d.text).replace(/\n/g, "<br>")) + "</div></div>";
      }
      if (items.length) {
        const nAuto = items.filter(x => x.auto && !x.installed).length;
        h += '<div class="ev-ai-run">' +
          '<button class="env-btn primary" data-vact="ai-install-all"' +
          (a.inst.busy || !nAuto ? " disabled" : "") +
          '><i class="bi bi-download"></i> ' +
          (a.inst.busy ? "正在安装…" : "一键安装" + (nAuto ? "（" + nAuto + " 项）" : "")) + "</button>" +
          (a.inst.busy ? '<button class="env-btn warn" data-vact="ai-install-cancel"><i class="bi bi-x-circle"></i> 取消</button>' : "") +
          '<span class="ev-ai-hint">只自动执行 ~/.local 用户级安装；系统包 / 手动项请复制命令自行执行</span></div>';
        h += '<div class="ev-ai-log" id="evAiLog"></div>';
      }
    }
    box.innerHTML = h;
    box.onclick = envAiOnClick;
    const ta = $("evAiQuery");
    if (ta) {
      ta.addEventListener("input", () => { ENV.ai.query = ta.value; });
      ta.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); envAiPlan(); }
      });
    }
    if (d) { envAiProgress(); envAiRestoreLog(); }
  }

  /* 方案里的单项：状态图标 + 名称 / 版本 / 理由 + 右侧操作（手动项给复制命令） */
  function envAiIcon(st) {
    if (st === "run") return '<i class="ev-spin"></i>';
    if (st === "ok") return '<i class="bi bi-check-circle-fill"></i>';
    if (st === "fail") return '<i class="bi bi-x-circle-fill"></i>';
    if (st === "skip") return '<i class="bi bi-dash-circle"></i>';
    return '<i class="bi bi-circle"></i>';
  }

  function envAiItemHtml(it) {
    const st = it._state || "";
    const tag = it.installed
      ? '<span class="tg ok">已安装' + (it.installed_version ? " " + esc(it.installed_version) : "") + "</span>"
      : (it.auto ? '<span class="tg auto">可一键安装</span>' : '<span class="tg man">需管理员 / 手动</span>');
    const op = (!it.auto && it.command)
      ? '<button class="env-btn" data-copy="' + escAttr(it.command) + '"><i class="bi bi-clipboard"></i> 复制命令</button>'
      : "";
    return '<div class="ev-ai-item' + (it.auto ? "" : " manual") + '" data-k="' + (it._k == null ? "" : it._k) +
      '" data-state="' + st + '">' +
      '<span class="st">' + envAiIcon(st) + "</span>" +
      '<div class="main"><div class="nm">' + esc(it.label || it.name || it.id) +
      (it.version ? ' <b>' + esc(it.version) + "</b>" : "") + " " + tag + "</div>" +
      (it.reason ? '<div class="rs">' + esc(it.reason) + "</div>" : "") +
      (it._err ? '<div class="rs err">' + esc(it._err) + "</div>" : "") +
      "</div>" + (op ? '<div class="op">' + op + "</div>" : "") + "</div>";
  }

  /* 只替换该行 DOM（不动输入框 / 日志 / 其它行 = 不会闪、不丢焦点） */
  function envAiSetState(it, st) {
    it._state = st;
    const list = $("envAiList");
    if (!list || it._k == null) return;
    const row = list.querySelector('.ev-ai-item[data-k="' + it._k + '"]');
    if (!row) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = envAiItemHtml(it);
    row.replaceWith(tmp.firstChild);
  }

  function envAiProgress() {
    const d = ENV.ai.data;
    if (!d) return;
    const items = d.items || [];
    if (!items.length) return;
    const ok = items.filter(x => x._state === "ok").length;
    const fail = items.filter(x => x._state === "fail").length;
    const autoN = items.filter(x => x.auto && !x.installed).length;
    const bar = $("evAiProgBar"), txt = $("evAiProgTxt"), prog = $("evAiProg");
    if (!autoN) {
      if (bar) bar.style.width = "0%";
      if (txt) txt.textContent = "无可自动安装项";
      if (prog) prog.classList.remove("run");
      return;
    }
    if (bar) bar.style.width = Math.min(100, Math.round(((ok + fail) / autoN) * 100)) + "%";
    if (txt) txt.textContent = (ok + fail) + "/" + autoN + (fail ? "（失败 " + fail + "）" : "");
    if (prog) prog.classList.toggle("run", !!ENV.ai.inst.busy);
  }

  function envAiLog(msg, cls) {
    ENV.ai.inst.log.push({ m: msg, c: cls || "" });
    if (ENV.ai.inst.log.length > 400) ENV.ai.inst.log.shift();
    const box = $("evAiLog");
    if (!box) return;
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  /* 重绘后把日志补回来（否则刷新一次历史安装输出就没了） */
  function envAiRestoreLog() {
    const box = $("evAiLog");
    if (!box) return;
    box.innerHTML = "";
    (ENV.ai.inst.log || []).forEach(l => {
      const line = document.createElement("div");
      if (l.c) line.className = l.c;
      line.textContent = l.m;
      box.appendChild(line);
    });
    box.scrollTop = box.scrollHeight;
  }

  /* 方案卡片上的点击统一委托 */
  function envAiOnClick(e) {
    const chip = e.target.closest("[data-chip]");
    if (chip) {
      const c = EV_AI_CHIPS[parseInt(chip.dataset.chip, 10)];
      if (!c) return;
      ENV.ai.query = c.text;
      const ta = $("evAiQuery");
      if (ta) { ta.value = c.text; ta.focus(); }
      return;
    }
    const cp = e.target.closest("[data-copy]");
    if (cp) { copyText(cp.dataset.copy || ""); return; }
    const btn = e.target.closest("[data-vact]");
    if (!btn) return;
    const a = btn.dataset.vact;
    if (a === "ai-plan") envAiPlan();
    else if (a === "ai-install-all") envAiInstallAll();
    else if (a === "ai-install-cancel") { btn.disabled = true; envAiCancel(); }
    else if (a === "ai-close") {
      ENV.ai.open = false; ENV.ai.busy = false; ENV.ai.error = "";
      envAiStopTimer();
      const box = $("envAiBox");
      if (box && box.parentNode) box.parentNode.removeChild(box);
    }
  }

  function envAiStartTimer() {
    envAiStopTimer();
    ENV.ai.timer = setInterval(() => {
      // 只改秒数文字：整块重绘会重建 <i>，让旋转动画不断从头开始、看起来一抖一抖
      const t = $("evAiTime");
      if (t) t.textContent = Math.round((Date.now() - ENV.ai.started) / 1000) + " 秒";
    }, 800);
  }

  function envAiStopTimer() {
    if (ENV.ai.timer) { clearInterval(ENV.ai.timer); ENV.ai.timer = null; }
  }

  /* 打开方案卡片（seed 为预填的需求描述，ids 为点名的目标） */
  function envAiOpen(seed, ids) {
    if (!envAiBoxEl()) { toast("请先打开「运行管理」标签页", "warn"); return; }
    ENV.ai.open = true;
    if (ids && ids.length) ENV.ai.ids = ids.slice();
    if (seed && !String(ENV.ai.query || "").trim()) ENV.ai.query = seed;
    envAiPaint();
    const ta = $("evAiQuery");
    if (ta && !ENV.ai.busy) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  /* 让 AI 按需求出方案 */
  async function envAiPlan() {
    const a = ENV.ai;
    if (a.busy) return;
    if (a.inst.busy) { toast("正在安装中，等这一轮装完再重新生成", "warn"); return; }
    const q = String(a.query || "").trim();
    if (!q) {
      toast("先说说你的环境要求：语言 / 版本 / 需要哪些服务", "warn");
      const ta = $("evAiQuery");
      if (ta) ta.focus();
      return;
    }
    if (typeof sysAiOff === "function" && sysAiOff("envinstall")) {
      a.error = "该功能已在「设置 → 系统 AI」中关闭，开启后即可使用";
      envAiPaint();
      return;
    }
    a.busy = true;
    a.data = null;
    a.error = "";
    a.started = Date.now();
    a.inst.log = [];
    envAiPaint();
    envAiStartTimer();
    try {
      const r = await fetch("/api/env/ai-install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, ids: a.ids || [] }),
      });
      const d = await r.json();
      if (d && d.error) a.error = d.error;
      else a.data = d;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 「Failed to fetch」是请求根本没到服务端（后端没重启 / 端口变了 / 进程挂了），单独说明更省事
      a.error = /failed to fetch|networkerror|load failed/i.test(msg)
        ? "请求没有到达服务端（" + msg + "）：确认后端已重启、页面地址与端口没变，再点一次「让 AI 给方案」"
        : "调用 AI 接口失败：" + msg;
    } finally {
      a.busy = false;
      envAiStopTimer();
      envAiPaint();
    }
  }

  /* 一键安装：只跑「用户级白名单方案」，逐项执行 + 进度条 + 实时日志 */
  async function envAiInstallAll() {
    const a = ENV.ai;
    const d = a.data;
    if (!d || a.inst.busy) return;
    const todo = (d.items || []).filter(it => it.auto && !it.installed);
    if (!todo.length) {
      toast("方案里没有可自动安装的项（其余需要管理员权限，可复制命令自行执行）", "warn");
      return;
    }
    const ok = await uiConfirm("一键安装",
      "将依次安装（装到 ~/.local，不需要管理员权限）：\n" +
      todo.map((it, i) => (i + 1) + ". " + (it.label || it.name || it.id) + (it.version ? " " + it.version : "")).join("\n") +
      "\n\n安装过程可以在下面看到实时日志；中途可取消，已装好的部分会保留（删掉安装目录即可卸载）。",
      "开始安装", false);
    if (!ok) return;

    a.inst = { busy: true, total: todo.length, idx: 0, tid: "", log: [] };
    todo.forEach(it => { it._state = ""; it._err = ""; });
    ENV.ai.open = true;
    envAiPaint();                                   // 重画一次：装按钮置灰 + 出现「取消」按钮
    envAiLog("准备安装 " + todo.length + " 项（装到 ~/.local）…", "h");

    let okN = 0, failN = 0;
    for (let i = 0; i < todo.length; i++) {
      if (!a.inst.busy) break;                      // 用户取消
      const it = todo[i];
      a.inst.idx = i;
      envAiSetState(it, "run");
      envAiLog("[" + (i + 1) + "/" + todo.length + "] " + (it.label || it.name || it.id) + " · 开始安装…", "h");
      try {
        await envAiInstallOne(it);
        it._err = "";
        envAiSetState(it, "ok");
        okN++;
        envAiLog("✔ " + (it.label || it.name || it.id) + " 安装完成", "ok");
        envAiProgress();
      } catch (e) {
        if (!a.inst.busy) {                         // 取消导致的中断：不算失败
          envAiSetState(it, "");
          break;
        }
        it._err = (e && e.message) || String(e);
        envAiSetState(it, "fail");
        failN++;
        envAiLog("✘ " + (it.label || it.name || it.id) + "：" + it._err, "err");
        envAiProgress();
      }
    }

    a.inst.busy = false;
    a.inst.tid = "";
    envAiProgress();
    if (okN || failN) {
      envAiLog("—— 结束：成功 " + okN + " 项" + (failN ? "，失败 " + failN + " 项" : ""), okN && !failN ? "ok" : "h");
      toast("安装结束：成功 " + okN + " 项" + (failN ? "，失败 " + failN + " 项" : ""), failN ? "warn" : "ok");
      setTimeout(() => loadEnv(true), 600);         // 刷新版本与「已安装」状态
    }
    envAiPaint();
    envHistLoad();                                  // 安装记录（数据库）同步刷新
  }

  /* 装单项：POST 启动任务 → 轮询日志到结束；失败抛错（由调用方标红） */
  async function envAiInstallOne(it) {
    const plan = (it.plans || []).find(p => p.mode === "user") || null;
    if (!plan || !it.auto) throw new Error("没有可自动执行的用户级安装方案");
    const r = await fetch("/api/env/install", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, key: plan.key, source: "ai" }),   // 安装记录里标记来源
    });
    const d = await r.json();
    if (!d || d.error) throw new Error((d && d.error) || "启动安装任务失败");
    ENV.ai.inst.tid = d.tid || "";
    let offset = 0;
    for (;;) {
      if (!ENV.ai.inst.busy) {                      // 已取消：通知后端停掉任务
        try {
          await fetch("/api/env/install/cancel", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tid: d.tid }),
          });
        } catch (_) {}
        throw new Error("已取消");
      }
      const rr = await fetch("/api/env/install/log?tid=" + encodeURIComponent(d.tid) + "&offset=" + offset);
      const dd = await rr.json();
      if (!dd || dd.error) throw new Error((dd && dd.error) || "读取安装日志失败");
      if (dd.offset != null) offset = dd.offset;
      (dd.lines || []).forEach(l => envAiLog(String(l.m || ""), l.c || ""));
      if (dd.done) {
        if (!dd.ok) throw new Error(dd.error || "安装失败");
        return dd;
      }
      await new Promise(res => setTimeout(res, 700));
    }
  }

  function envAiCancel() {
    if (!ENV.ai.inst.busy) return;
    ENV.ai.inst.busy = false;
    envAiLog("已取消：当前任务正在停止", "err");
  }

  /* 侧栏「打开管理面板」按钮 */
  (function initEnvViewPanel() {
    const b = $("envOpenView");
    if (b) b.onclick = () => envViewOpen();
  })();

