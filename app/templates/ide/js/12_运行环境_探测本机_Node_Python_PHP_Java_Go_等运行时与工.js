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
    showPanel("env");
    loadEnv(false);
  }

  function openRunnerPanel() {
    $("sidebar").classList.remove("collapsed");
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

  async function loadEnvPlans(id) {
    try {
      const r = await fetch("/api/env/install?id=" + encodeURIComponent(id));
      ENV.plans[id] = await r.json();
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
      loadEnvPlans(id).then(() => { if (ENV.openId === id) renderEnv(); });
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
    const box = $("envToolOut");
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
  $("envVarAdd").onclick = async () => {
    const k = await uiPrompt("环境变量名", "", "例如 JAVA_HOME、PIP_INDEX_URL（只允许字母数字下划线）");
    if (k === null) return;
    const name = k.trim();
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { toast("变量名不合法", "warn"); return; }
    const v = await uiPrompt("环境变量值（" + name + "）", "", "会注入「运行当前文件」与内置终端");
    if (v === null) return;
    const vars = Object.assign({}, (ENV.data && ENV.data.custom_env) || {});
    vars[name] = v;
    try { await saveEnvConfig({ env: vars }); toast("已保存", "ok"); await loadEnv(true); $("envVarsBox").style.display = "block"; }
    catch (e) { toast("保存失败：" + (e.message || e), "err"); }
  };

