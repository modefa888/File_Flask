  /* 53_ 包管理器（requirements.txt 工具栏 🔍 按钮）
   * 浮层内：选镜像源 → 搜索 PyPI → 安装 / 升级 / 下载；「已安装」页查看版本并支持升级 / 卸载。
   * 安装 / 升级 / 卸载成功后由后端自动改写 requirements.txt，返回新 content 同步回编辑器（免手写）。
   * 须放在 16_（关闭大 IIFE）之前引入：复用闭包内的 $ / esc / toast / saveTab */
  window.openPkgManager = function (tab) {
    if (!tab || !tab.cm) { toast("请先打开 requirements.txt", "warn"); return; }

    // 重复点击 = 关掉旧的重新打开
    const old = document.querySelector(".pkgmgr-mask");
    if (old) old.remove();

    const INDEXES = [["", "默认源"], ["tsinghua", "清华"], ["aliyun", "阿里云"], ["douban", "豆瓣"],
      ["ustc", "中科大"], ["tencent", "腾讯"], ["huawei", "华为"], ["pypi", "PyPI 官方"]];
    const idxOpts = INDEXES.map(i =>
      '<option value="' + i[0] + '">' + i[1] + '</option>').join("");

    const mask = document.createElement("div");
    mask.className = "pkgmgr-mask";
    mask.innerHTML =
      '<div class="pkgmgr-dlg">' +
        '<div class="pmgr-head">' +
          '<i class="bi bi-box-seam"></i><b>Python 包管理器</b>' +
          '<span class="pmgr-venv"></span>' +
          '<button class="pmgr-close" title="关闭 (Esc)"><i class="bi bi-x-lg"></i></button>' +
        '</div>' +
        '<div class="pmgr-bar">' +
          '<select class="pmgr-index" title="安装 / 下载使用的镜像源">' + idxOpts + '</select>' +
          '<input class="pmgr-q" placeholder="输入包名或关键词，回车搜索（支持模糊匹配，如 req → requests）" spellcheck="false">' +
          '<button class="pmgr-search"><i class="bi bi-search"></i>搜索</button>' +
        '</div>' +
        '<div class="pmgr-tabs">' +
          '<button class="pmgr-tab on" data-tab="search"><i class="bi bi-binoculars"></i>搜索结果</button>' +
          '<button class="pmgr-tab" data-tab="installed"><i class="bi bi-check2-square"></i>已安装 <b class="pmgr-icount"></b></button>' +
          '<span class="pmgr-upd"></span>' +
        '</div>' +
        '<div class="pmgr-body">' +
          '<div class="pmgr-pane" data-pane="search"></div>' +
          '<div class="pmgr-pane" data-pane="installed" style="display:none"></div>' +
        '</div>' +
        '<div class="pmgr-log" title="pip 命令输出"></div>' +
      '</div>';
    document.body.appendChild(mask);

    const qEl = mask.querySelector(".pmgr-q");
    const idxEl = mask.querySelector(".pmgr-index");
    const searchBtn = mask.querySelector(".pmgr-search");
    const venvEl = mask.querySelector(".pmgr-venv");
    const logEl = mask.querySelector(".pmgr-log");
    const panes = {
      search: mask.querySelector('[data-pane="search"]'),
      installed: mask.querySelector('[data-pane="installed"]'),
    };
    const icountEl = mask.querySelector(".pmgr-icount");
    const updEl = mask.querySelector(".pmgr-upd");

    const st = {
      index: localStorage.getItem("cb-pip-index") || "tsinghua",
      installed: {},       // {归一化名: {name, version}}
      latest: {},          // {归一化名: 最新版本}  来自 /api/pip/latest 与搜索/升级结果
      latestLoading: false,
      results: [],
      busy: false,
      view: "search",
      lastQ: "",
    };
    if (idxEl.querySelector('option[value="' + st.index + '"]')) idxEl.value = st.index;
    idxEl.addEventListener("change", () => {
      localStorage.setItem("cb-pip-index", idxEl.value);
      st.index = idxEl.value;
      st.latest = {};          // 换了源 → 最新版本要重新算
      loadLatestCache();
      renderInstalled();
      loadLatest();
    });

    /* 「最新版本」结果缓存到 localStorage：第二次打开浮层时状态立刻就是对的，
       不会先显示一堆「升级」再突然变成「最新版本」 */
    const LATEST_CACHE_KEY = "cb-pip-latest";
    const LATEST_CACHE_TTL = 30 * 60 * 1000;
    function loadLatestCache() {
      try {
        const c = JSON.parse(localStorage.getItem(LATEST_CACHE_KEY) || "null");
        if (!c || !c.map || c.index !== st.index) return;
        if (Date.now() - (c.ts || 0) > LATEST_CACHE_TTL) return;
        Object.assign(st.latest, c.map);
      } catch (_) { /* 缓存坏了就当没有 */ }
    }
    function saveLatestCache() {
      try {
        localStorage.setItem(LATEST_CACHE_KEY,
          JSON.stringify({ ts: Date.now(), index: st.index, map: st.latest }));
      } catch (_) { }
    }
    loadLatestCache();

    /* ---------------- 基础 ---------------- */
    function keyOf(name) { return String(name || "").toLowerCase().replace(/[-_.]+/g, "_"); }
    // 版本比较（够用版：1.2.3 / 4.15.0 / 2024.6.1 / 1.0rc1 这类），返回 -1 / 0 / 1
    function verParts(v) {
      return String(v || "").replace(/^v/i, "").split(/[.+_-]/).filter(function (s) { return s !== ""; })
        .map(function (s) { return /^\d+$/.test(s) ? parseInt(s, 10) : s; });
    }
    function verCmp(a, b) {
      const A = verParts(a), B = verParts(b), n = Math.max(A.length, B.length);
      for (let i = 0; i < n; i++) {
        const x = A[i], y = B[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x === "number" && typeof y === "number") { if (x !== y) return x < y ? -1 : 1; continue; }
        if (x === y) continue;
        if (typeof x === "number") return -1;      // 数字段 < 字母段（近似 PEP 440）
        if (typeof y === "number") return 1;
        return String(x) < String(y) ? -1 : 1;
      }
      return 0;
    }
    function log(msg, cls) {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
      while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
    }
    function setBusy(on, hint) {
      st.busy = on;
      [searchBtn].concat([].slice.call(mask.querySelectorAll(".pmgr-row button"))).forEach(b => {
        if (!b || b.classList.contains("latest")) return;   // 「最新版本」始终保持禁用
        b.disabled = on;
      });
      searchBtn.innerHTML = on ? '<i class="spin"></i>' + (hint || "执行中…") : '<i class="bi bi-search"></i>搜索';
    }
    async function pmPost(url, body) {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ path: tab.path, index: idxEl.value }, body)),
      });
      let d;
      try { d = await r.json(); }
      catch (_) { throw new Error("接口返回异常（后端可能需要重启）"); }
      if (d.error && !d.ok) throw new Error(d.error);
      return d;
    }
    // 后端改写完 requirements.txt → 同步回编辑器并清除未保存标记
    function applyContent(content) {
      if (typeof content !== "string" || !tab.cm) return;
      tab.cm.setValue(content);
      tab.original = content;
      tab.dirty = false;
      if (tab.el) tab.el.classList.remove("dirty");
      if (typeof refreshTreeDirty === "function") refreshTreeDirty();
    }
    // 安装 / 升级成功后：立即把行内版本号改成实际安装的版本（不等 pip list 回来），
    // 并把该版本视为最新版，于是按钮立刻变成「最新版本」不可点。
    function applyVersions(d) {
      const versions = d && d.versions;
      if (!versions) return;
      Object.keys(versions).forEach(function (k) {
        const v = versions[k];
        if (!v) return;
        st.latest[k] = v;
        if (st.installed[k]) st.installed[k].version = v;
      });
      saveLatestCache();
      renderInstalled();
      if (st.view === "search" && st.results.length) renderSearch();
    }
    function afterChange(d) {
      if (d.content) applyContent(d.content);
      applyVersions(d);
      if (d.stdout) log(d.stdout.trim().split("\n").slice(-6).join("\n"));
      if (d.stderr && d.stderr.trim()) log(d.stderr.trim().split("\n").slice(-3).join("\n"), "pmgr-log-err");
      refreshInstalled();
      if (typeof tab.reqCheck === "function") tab.reqCheck();
    }

    /* ---------------- 搜索 ---------------- */
    async function doSearch() {
      const q = qEl.value.trim();
      if (!q) { toast("请输入要搜索的包名或关键词", "warn"); return; }
      if (st.busy) return;
      st.lastQ = q;
      setBusy(true, "搜索中…");
      panes.search.innerHTML = '<div class="pmgr-empty"><i class="spin"></i> 正在搜索…</div>';
      switchView("search");
      try {
        const d = await pmPost("/api/pip/search", { q: q });
        if (d.warn) log(d.warn, "pmgr-log-warn");
        st.results = d.results || [];
        renderSearch();
        if (!st.results.length) {
          panes.search.innerHTML = '<div class="pmgr-empty"><i class="bi bi-emoji-frown"></i>没有找到与「' + esc(q) + '」相关的包</div>';
        }
      } catch (e) {
        panes.search.innerHTML = '<div class="pmgr-empty"><i class="bi bi-wifi-off"></i>' + esc(e.message || e) + '</div>';
      }
      setBusy(false);
    }
    function installedVer(name) {
      const it = st.installed[name.toLowerCase().replace(/[-_.]+/g, "_")];
      return it ? it.version : null;
    }
    function renderSearch() {
      // 搜索页拿到的 PyPI 最新版本顺手记下来，「已安装」页可直接复用
      st.results.forEach(function (p) { if (p.version) st.latest[keyOf(p.name)] = p.version; });
      panes.search.innerHTML = st.results.map(function (p) {
        const iv = installedVer(p.name);
        const latest = p.version || st.latest[keyOf(p.name)] || "";
        const cmp = (iv && latest) ? verCmp(latest, iv) : 0;
        const canUp = !!(iv && latest && cmp > 0);
        const isLatest = !!(iv && latest && cmp <= 0);
        return '<div class="pmgr-row" data-pkg="' + esc(p.name) + '">' +
          '<div class="pmgr-info">' +
            '<div class="pmgr-nm"><i class="bi bi-box"></i><b>' + esc(p.name) + '</b>' +
              (latest ? '<span class="pmgr-ver" title="最新版本">v' + esc(latest) + '</span>' : "") +
              (iv ? '<span class="pmgr-chip ok" title="当前 venv 已安装">已装 v' + esc(iv) + '</span>' : "") +
              (canUp ? '<span class="pmgr-chip up" title="有新版本">可升级</span>' : "") +
              (isLatest ? '<span class="pmgr-chip ok" title="与最新版一致">已是最新</span>' : "") +
            '</div>' +
            (p.summary ? '<div class="pmgr-desc">' + esc(p.summary) + '</div>' : "") +
            (p.requires_python ? '<div class="pmgr-meta">要求 Python ' + esc(p.requires_python) + '</div>' : "") +
          '</div>' +
          '<div class="pmgr-acts">' +
            (iv
              ? (canUp
                  ? '<button data-act="upgrade" title="升级到最新版 v' + esc(latest) + '"><i class="bi bi-arrow-up-circle"></i>升级</button>'
                  : (isLatest ? '<button class="latest" disabled title="已是最新版本 v' + esc(iv) + '"><i class="bi bi-check2"></i>最新</button>' : ''))
              : '<button data-act="install" class="pri" title="安装最新版并写入 requirements.txt"><i class="bi bi-box-arrow-in-down"></i>安装</button>') +
            '<button data-act="download" title="下载 wheel / sdist 到 pip_downloads/ 目录"><i class="bi bi-download"></i>下载</button>' +
          '</div>' +
        '</div>';
      }).join("");
    }

    /* ---------------- 已安装 ---------------- */
    async function refreshInstalled() {
      try {
        // 带上编辑器里的内容：requirements.txt 改了还没保存时也能正确分组
        const d = await pmPost("/api/pip/installed", { content: tab.cm ? tab.cm.getValue() : undefined });
        st.installed = {};
        (d.items || []).forEach(it => {
          st.installed[keyOf(it.name)] = it;
        });
        venvEl.textContent = d.venv ? "venv: " + (d.venv.split(/[\\/]/).pop() || d.venv) : "";
        icountEl.textContent = (d.items || []).length;
        renderInstalled();
        if (st.view === "search" && st.results.length) renderSearch();
        loadLatest();          // 后台查最新版本，回来后再点亮「最新版本」按钮
      } catch (e) {
        icountEl.textContent = "?";
        if (st.view === "installed") {
          panes.installed.innerHTML = '<div class="pmgr-empty"><i class="bi bi-exclamation-triangle"></i>' + esc(e.message || e) + '</div>';
        }
      }
    }
    // 批量查 PyPI 最新版本（只查还不知道的），失败就静默——此时按钮保持可升级
    async function loadLatest() {
      if (st.latestLoading) return;
      const names = Object.keys(st.installed)
        .filter(k => !st.latest[k])
        .map(k => st.installed[k].name);
      if (!names.length) return;
      st.latestLoading = true;
      updEl.innerHTML = '<i class="spin"></i>检查更新…';
      try {
        for (let i = 0; i < names.length; i += 30) {
          const d = await pmPost("/api/pip/latest", { names: names.slice(i, i + 30) });
          Object.assign(st.latest, d.latest || {});
          // 这里刻意不重绘列表：检查要好几秒，中途重建 DOM 会让升级按钮在
          // 点击瞬间被替换掉，表现成「检查中按钮点不动」。查完统一刷新一次即可。
        }
        saveLatestCache();
        refreshStates();
      } catch (_) {
        /* 拿不到最新版本就不下结论，升级按钮继续可点 */
        refreshStates();
      }
      updEl.textContent = "";
      st.latestLoading = false;
    }
    // 统一刷新一次状态；若用户正按着某个按钮，等松手后再刷新，避免点击被打断
    function refreshStates() {
      if (st.busy) return;    // 动作执行中：结束后 refreshInstalled() 会重绘
      if (mask.querySelector(".pmgr-acts button:active")) {
        setTimeout(refreshStates, 120);
        return;
      }
      renderInstalled();
      if (st.view === "search" && st.results.length) renderSearch();
    }
    // 「已安装」页分组：requirements.txt 里的 / venv 自带的 / 其余依赖
    const GROUPS = [
      { key: "req", title: "当前 requirements.txt", icon: "bi-file-earmark-text" },
      { key: "base", title: "venv 自带", icon: "bi-box-seam" },
      { key: "other", title: "其他依赖（间接安装）", icon: "bi-boxes" },
    ];
    function installedRowHtml(it) {
      const lv = st.latest[keyOf(it.name)] || "";
      const cmp = (lv && it.version) ? verCmp(lv, it.version) : 0;
      const isLatest = !!(lv && it.version && cmp <= 0);   // 本地 >= 源上最新 → 已最新
      const canUp = !!(lv && it.version && cmp > 0);
      return '<div class="pmgr-row slim" data-pkg="' + esc(it.name) + '">' +
        '<div class="pmgr-info">' +
          '<div class="pmgr-nm"><i class="bi bi-check-circle"></i><b>' + esc(it.name) + '</b>' +
            '<span class="pmgr-ver">v' + esc(it.version) + '</span>' +
            (isLatest ? '<span class="pmgr-chip ok" title="与 PyPI 最新版一致">已是最新</span>' : "") +
            (canUp ? '<span class="pmgr-chip up" title="PyPI 最新版 v' + esc(lv) + '">可升级 v' + esc(lv) + '</span>' : "") +
          '</div>' +
        '</div>' +
        '<div class="pmgr-acts">' +
          (isLatest
            ? '<button class="latest" disabled title="已是最新版本 v' + esc(it.version) + '"><i class="bi bi-check2"></i>最新版本</button>'
            : '<button data-act="upgrade" title="' + (lv ? "升级到 v" + esc(lv) : "升级到最新版") + '"><i class="bi bi-arrow-up-circle"></i>升级</button>') +
          '<button data-act="uninstall" class="danger" title="卸载并从 requirements.txt 移除"><i class="bi bi-trash3"></i>卸载</button>' +
        '</div>' +
      '</div>';
    }
    function renderInstalled() {
      const items = Object.keys(st.installed).map(k => st.installed[k])
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      if (!items.length) {
        panes.installed.innerHTML = '<div class="pmgr-empty"><i class="bi bi-inbox"></i>当前 venv 还没有安装任何包</div>';
        return;
      }
      const bucket = { req: [], base: [], other: [] };
      items.forEach(function (it) { (bucket[it.group] || bucket.other).push(it); });
      panes.installed.innerHTML = GROUPS.map(function (g) {
        const list = bucket[g.key];
        if (!list.length) return "";
        return '<div class="pmgr-group"><i class="bi ' + g.icon + '"></i>' +
            '<span>' + g.title + '</span><b>' + list.length + '</b></div>' +
          list.map(installedRowHtml).join("");
      }).join("");
    }

    /* ---------------- 动作 ---------------- */
    async function runAct(act, pkg) {
      if (!pkg) return;
      if (st.busy) { toast("上一个操作还在执行，请稍候", "warn"); return; }
      setBusy(true, act === "download" ? "下载中…" : (act === "uninstall" ? "卸载中…" : (act === "upgrade" ? "升级中…" : "安装中…")));
      log("$ pip " + (act === "uninstall" ? "uninstall -y " : act === "upgrade" ? "install -U " :
        act === "download" ? "download --no-deps " : "install ") + pkg);
      try {
        if (act === "install") {
          const d = await pmPost("/api/pip/install", { packages: [pkg], sync_req: true });
          if (d.ok) { toast(pkg + " 安装完成，requirements.txt 已同步", "ok"); log("✔ 安装成功" + (d.content ? "，requirements.txt 已更新" : "")); }
          else throw new Error(d.stderr || d.error || "pip 返回码 " + d.returncode);
          afterChange(d);
        } else if (act === "upgrade") {
          const key = keyOf(pkg);
          const oldv = st.installed[key] ? st.installed[key].version : "";
          const d = await pmPost("/api/pip/upgrade", { packages: [pkg] });
          if (!d.ok) throw new Error(d.stderr || d.error || "pip 返回码 " + d.returncode);
          const nv = (d.versions || {})[key] || "";
          if (oldv && nv && oldv === nv) {
            // pip 判定「Requirement already satisfied」：本来就没有更新的版本
            toast(pkg + " 已是最新版本（v" + nv + "）", "info");
            log("✔ 已是最新版本 v" + nv);
          } else {
            toast(pkg + (nv ? " 升级到 v" + nv : " 升级完成") + "，requirements.txt 已同步", "ok");
            log("✔ 升级成功" + (nv ? " → v" + nv : ""));
          }
          afterChange(d);
        } else if (act === "uninstall") {
          if (typeof uiConfirm === "function" && !(await uiConfirm("卸载包",
            "确定卸载 " + pkg + " ？\n会同时从 requirements.txt 移除对应行。", "卸载", true))) { setBusy(false); return; }
          const d = await pmPost("/api/pip/uninstall", { packages: [pkg] });
          if (d.ok) {
            toast(pkg + " 已卸载，requirements.txt 已同步", "ok");
            log("✔ 卸载成功");
            delete st.latest[keyOf(pkg)];      // 以后重装时重新查最新版
          } else throw new Error(d.stderr || d.error || "pip 返回码 " + d.returncode);
          afterChange(d);
        } else if (act === "download") {
          const d = await pmPost("/api/pip/download", { packages: [pkg] });
          if (d.ok) { toast(pkg + " 已下载到 " + (d.dir || "pip_downloads/"), "ok"); log("✔ 已保存到 " + d.dir + "\n" + (d.files || []).join("\n")); }
          else throw new Error(d.stderr || d.error || "pip 返回码 " + d.returncode);
          if (d.stdout) log(d.stdout.trim().split("\n").slice(-4).join("\n"));
        }
      } catch (e) {
        toast((act === "download" ? "下载" : act === "uninstall" ? "卸载" : act === "upgrade" ? "升级" : "安装") +
          "失败：" + (e.message || e), "err");
        log("✘ " + (e.message || e), "pmgr-log-err");
        refreshInstalled();
      }
      setBusy(false);
    }

    /* ---------------- 事件 ---------------- */
    function switchView(v) {
      st.view = v;
      mask.querySelectorAll(".pmgr-tab").forEach(t => t.classList.toggle("on", t.dataset.tab === v));
      panes.search.style.display = v === "search" ? "" : "none";
      panes.installed.style.display = v === "installed" ? "" : "none";
    }
    mask.querySelector(".pmgr-tabs").addEventListener("click", function (e) {
      const t = e.target.closest(".pmgr-tab");
      if (!t) return;
      switchView(t.dataset.tab);
      if (t.dataset.tab === "installed") {
        if (!mask.querySelector('[data-pane="installed"] .pmgr-row')) refreshInstalled();
        else loadLatest();     // 之前没查到最新版本（离线 / 超时）→ 再试一次
      }
    });
    mask.querySelector(".pmgr-body").addEventListener("click", function (e) {
      const btn = e.target.closest(".pmgr-row button");
      if (!btn || btn.disabled) return;
      const row = btn.closest(".pmgr-row");
      runAct(btn.dataset.act, row ? row.dataset.pkg : "");
    });
    searchBtn.addEventListener("click", doSearch);
    qEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doSearch(); }
    });
    function close() { mask.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    mask.querySelector(".pmgr-close").addEventListener("click", close);
    mask.addEventListener("mousedown", function (e) { if (e.target === mask) close(); });
    document.addEventListener("keydown", onKey);

    // 打开即搜索一次常用词？不——聚焦输入框，拉一遍已安装列表备用
    setTimeout(() => qEl.focus(), 0);
    refreshInstalled();
  };
