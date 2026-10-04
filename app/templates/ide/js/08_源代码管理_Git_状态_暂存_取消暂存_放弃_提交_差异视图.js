  /* ==================================================================
     源代码管理（Git）：状态 / 暂存 / 取消暂存 / 放弃 / 提交 / 差异视图
     ================================================================== */
  const gitState = { isRepo: false, repo: "", branch: "", last: null };
  // 视图模式从全局设置 JSON 恢复（设置页 → 文件 可改），切换时写回永久保存
  let gitViewMode = ideSettingGet("gitViewMode", "list") === "tree" ? "tree" : "list";
  let gitGraph = [];             // 最近提交（图形区块）

  function gitPost(url, body, okMsg) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        if (okMsg) toast(okMsg, "ok");
        loadGitStatus();
        return true;
      })
      .catch(e => { toast("操作失败：" + (e.message || e), "err"); return false; });
  }

  function renderGitMessage(msg, withInit) {
    $("gitBranch").textContent = "—";
    $("gitSync").textContent = "";
    const box = $("gitList");
    box.innerHTML = "";
    const e = document.createElement("div");
    e.className = "git-empty";
    e.textContent = msg;
    box.appendChild(e);
    if (withInit) {
      const b = document.createElement("button");
      b.className = "g-btn";
      b.textContent = "初始化 Git 仓库";
      b.onclick = async () => {
        if (!(await uiConfirm("初始化仓库", "将在 " + ROOT + " 下执行 git init 创建仓库。", "初始化", false))) return;
        gitPost("/api/git/init", { repo: ROOT }, "仓库已初始化");
      };
      e.appendChild(document.createElement("div"));
      e.appendChild(b);
    }
  }

  function gitStatusMean(status) {
    const m = {
      "U": "新增", "?": "新增",
      "M": "已修改",
      "A": "已暂存",
      "D": "已删除",
      "R": "已重命名",
      "C": "已复制",
      "T": "类型变更"
    };
    return m[status] || "";
  }

  function gitFileRow(sec, f, depth) {
    const name = f.name || baseName(f.path);
    const dir = f.path.indexOf("/") >= 0 ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
    const st = f.status === "?" ? "U" : f.status;                        // 归一化未跟踪标记
    // 文件名按状态着色：删除=红（中划线），修改/重命名/类型变更=绿，新增=蓝
    const stCls = st === "D" ? "st-D" : (st === "M" || st === "R" || st === "C" || st === "T" ? "st-M" : "st-U");
    const row = document.createElement("div");
    row.className = "git-file " + stCls;
    const full = (gitState.repo || ROOT || "") + "/" + f.path;           // 悬浮显示完整路径 · 状态
    row.title = full + (gitStatusMean(f.status) ? " · " + gitStatusMean(f.status) : "");
    row.style.paddingLeft = (8 + (depth || 0) * 12) + "px";
    // 树形视图下层级已经体现目录，不再重复展示目录名；
    // 行尾顺序：操作按钮在前、状态字母在最右（状态含义仍保留在悬浮提示里）
    row.innerHTML = '<span class="ic">' + iconFor(name, false) + '</span>' +
      '<span class="gf-name">' + esc(name) + '</span>' +
      (gitViewMode === "list" && dir ? '<span class="gf-dir">' + esc(dir) + '</span>' : '') +
      '<span class="gf-acts"></span>' +
      '<span class="gf-st">' + esc(f.status) + '</span>';
    const acts = row.querySelector(".gf-acts");
    const addBtn = (icon, title, fn) => {
      const b = document.createElement("button");
      b.innerHTML = '<i class="bi ' + icon + '"></i>';
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(e); };
      acts.appendChild(b);
    };
    const isU = !!sec.untracked || f.status === "U" || f.status === "?";   // 未跟踪文件（合并进“更改”后按文件判断）
    if (sec.staged) {
      addBtn("bi-dash-lg", "取消暂存", () => gitPost("/api/git/unstage", { repo: gitState.repo, files: [f.path] }, "已取消暂存"));
    } else {
      addBtn("bi-plus-lg", "暂存更改", () => gitPost("/api/git/stage", { repo: gitState.repo, files: [f.path] }, "已暂存 " + name));
      if (!isU) {
        addBtn("bi-arrow-counterclockwise", "放弃更改", async (e) => {
          const ok = await uiConfirmPop(e.currentTarget.closest(".gf-acts") || acts,
            { title: "放弃更改", msg: "将丢弃 " + f.path + " 的未暂存修改，此操作不可撤销。", okText: "放弃更改", danger: true });
          if (ok) gitPost("/api/git/discard", { repo: gitState.repo, files: [f.path] }, "已放弃更改");
        });
      }
    }
    row.onclick = (e) => { if (e.target.closest("button")) return; openDiffTab(f.path, sec.staged, isU); };
    return row;
  }

  /* 按目录层级构建树（VS Code 树形视图） */
  function gitTreeFrom(files) {
    const root = { dirs: new Map(), files: [] };
    files.forEach(f => {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const dn = parts[i];
        if (!node.dirs.has(dn)) node.dirs.set(dn, { dirs: new Map(), files: [] });
        node = node.dirs.get(dn);
      }
      node.files.push(Object.assign({}, f, { name: parts[parts.length - 1] }));
    });
    return root;
  }
  function gitTreeCount(node) {
    let n = node.files.length;
    node.dirs.forEach(d => { n += gitTreeCount(d); });
    return n;
  }
  function renderGitTree(node, depth, sec, dirPath) {
    const frag = document.createDocumentFragment();
    Array.from(node.dirs.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "zh"))
      .forEach(([dn, child]) => {
        const fullPath = dirPath ? dirPath + "/" + dn : dn;
        const head = document.createElement("div");
        head.className = "git-dir";
        head.style.paddingLeft = (8 + depth * 12) + "px";
        head.innerHTML = '<i class="bi bi-chevron-down git-dir-tw"></i><i class="bi bi-folder2 git-dir-ic"></i>' +
          '<span class="gf-dirname">' + esc(dn) + '</span>' +
          '<span class="gf-dot"></span><span class="gf-st">' + gitTreeCount(child) + '</span>';
        const body = document.createElement("div");
        body.className = "git-dir-body";
        body.dataset.dirPath = fullPath;
        body.appendChild(renderGitTree(child, depth + 1, sec, fullPath));
        const setDirCollapsed = (collapsed) => {
          body.style.display = collapsed ? "none" : "";
          head.querySelector(".git-dir-tw").className =
            "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " git-dir-tw";
          try { localStorage.setItem("gitDirCollapsed:" + sec.title + ":" + fullPath, collapsed ? "1" : "0"); } catch (e) {}
        };
        head.onclick = () => setDirCollapsed(body.style.display !== "none");
        frag.appendChild(head);
        frag.appendChild(body);
        // 恢复上次状态
        try {
          const saved = localStorage.getItem("gitDirCollapsed:" + sec.title + ":" + fullPath);
          if (saved === "1") setDirCollapsed(true);
        } catch (e) {}
      });
    node.files.slice()
      .sort((a, b) => a.name.localeCompare(b.name, "zh"))
      .forEach(f => frag.appendChild(gitFileRow(sec, f, depth)));
    return frag;
  }

  function gitSection(sec) {
    const wrap = document.createElement("div");
    wrap.className = "git-sec changes-sec";
    const head = document.createElement("div");
    head.className = "git-sec-head";
    head.innerHTML = '<i class="bi bi-chevron-down git-sec-tw"></i><span class="git-sec-title">' + sec.title +
      '</span><span class="git-acts"></span><span class="git-cnt">' + sec.files.length + '</span>';
    const body = document.createElement("div");
    if (gitViewMode === "tree") {
      body.appendChild(renderGitTree(gitTreeFrom(sec.files), 0, sec));
    } else {
      sec.files.slice().sort((a, b) => a.path.localeCompare(b.path, "zh"))
        .forEach(f => body.appendChild(gitFileRow(sec, f, 0)));
    }
    // 分组级批量操作
    const acts = head.querySelector(".git-acts");
    const addAct = (icon, title, fn) => {
      const b = document.createElement("button");
      b.innerHTML = '<i class="bi ' + icon + '"></i>';
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(e); };
      acts.appendChild(b);
      return b;
    };
    if (sec.staged) {
      // 「打开更改」：同样放在分组标题的操作区，避免全部暂存后找不到入口
      addAct("bi-file-diff", "打开更改（在一个标签页中查看所有变更文件）", () => openAllChangesTab());
      addAct("bi-dash-lg", "取消暂存所有更改", async (e) => {
        const ok = await uiConfirmPop(e.currentTarget,
          { title: "取消暂存所有更改", msg: "将把暂存区的全部文件退回未暂存状态。", okText: "全部取消暂存", danger: false });
        if (ok) gitPost("/api/git/unstage", { repo: gitState.repo, all: true }, "已取消暂存所有更改");
      });
    } else {
      // 「打开更改」：把全部变更文件汇总到同一个标签页中查看
      addAct("bi-file-diff", "打开更改（在一个标签页中查看所有变更文件）", () => openAllChangesTab());
      addAct("bi-arrow-counterclockwise", "放弃所有更改（仅已跟踪文件）", async (e) => {
        const ok = await uiConfirmPop(e.currentTarget,
          { title: "放弃所有更改", msg: "将丢弃所有未暂存的修改（未跟踪的新文件不受影响），此操作不可撤销。", okText: "全部放弃", danger: true });
        if (ok) gitPost("/api/git/discard", { repo: gitState.repo, all: true }, "已放弃所有更改");
      });
      addAct("bi-plus-lg", "暂存所有更改（含未跟踪文件）", () => gitPost("/api/git/stage", { repo: gitState.repo, all: true }, "已暂存所有更改"));
    }
    // 树形视图：折叠/展开全部目录
    const dirBodies = () => body.querySelectorAll(".git-dir-body");
    if (gitViewMode === "tree" && dirBodies().length) {
      const dirToggle = document.createElement("button");
      dirToggle.innerHTML = '<i class="bi bi-chevron-double-up"></i>';
      dirToggle.title = "折叠/展开全部目录";
      const updateDirToggleIcon = () => {
        const bodies = dirBodies();
        const allCollapsed = bodies.length && Array.from(bodies).every(b => b.style.display === "none");
        dirToggle.querySelector("i").className = "bi " + (allCollapsed ? "bi-chevron-double-down" : "bi-chevron-double-up");
        dirToggle.title = allCollapsed ? "展开全部目录" : "折叠全部目录";
      };
      dirToggle.onclick = (e) => {
        e.stopPropagation();
        const bodies = dirBodies();
        const allCollapsed = bodies.length && Array.from(bodies).every(b => b.style.display === "none");
        bodies.forEach(b => {
          const collapsed = !allCollapsed;
          b.style.display = collapsed ? "none" : "";
          const h = b.previousElementSibling;
          if (h) h.querySelector(".git-dir-tw").className = "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " git-dir-tw";
          try { localStorage.setItem("gitDirCollapsed:" + sec.title + ":" + b.dataset.dirPath, collapsed ? "1" : "0"); } catch (e) {}
        });
        updateDirToggleIcon();
      };
      acts.appendChild(dirToggle);
      updateDirToggleIcon();
    }
    const setCollapsed = (collapsed) => {
      body.style.display = collapsed ? "none" : "";
      const iconClass = collapsed ? "bi-chevron-right" : "bi-chevron-down";
      head.querySelector(".git-sec-tw").className = "bi " + iconClass + " git-sec-tw";
      try { localStorage.setItem("gitSecCollapsed:" + sec.title, collapsed ? "1" : "0"); } catch (e) {}
    };
    head.onclick = () => setCollapsed(body.style.display !== "none");
    // 恢复上次折叠状态
    try {
      const saved = localStorage.getItem("gitSecCollapsed:" + sec.title);
      if (saved === "1") setCollapsed(true);
    } catch (e) {}
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  /* 图形：最近提交（含工具栏：转到当前 / 抓取 / 拉取 / 发布 / 刷新 / 更多） */
  let gitCommitFileMode = ideSettingGet("gitCommitFileMode", "tree") === "list" ? "list" : "tree";   // 提交内文件清单：list / tree（默认树形，全局设置持久化）

  function showGitMoreMenu(anchor) {
    let menu = $("gitMoreMenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "ctx-menu";
      menu.id = "gitMoreMenu";
      document.body.appendChild(menu);
      document.addEventListener("click", () => { menu.style.display = "none"; });
    }
    const items = [
      { label: "以列表形式查看", on: gitCommitFileMode === "list", act: () => { gitCommitFileMode = "list"; ideSettingSet("gitCommitFileMode", "list"); reloadCommitLists(); } },
      { label: "以树形式查看", on: gitCommitFileMode === "tree", act: () => { gitCommitFileMode = "tree"; ideSettingSet("gitCommitFileMode", "tree"); reloadCommitLists(); } },
      { label: "设置远程仓库", act: () => setGitRemote() },
    ];
    menu.innerHTML = "";
    items.forEach(it => {
      const el = document.createElement("div");
      el.className = "mi";
      el.innerHTML = '<span style="width:14px;display:inline-block">' + (it.on ? "✓" : "") + "</span><span>" + it.label + "</span>";
      el.onclick = (e) => { e.stopPropagation(); menu.style.display = "none"; it.act(); };
      menu.appendChild(el);
    });
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 200) + "px";
    // 默认向下弹；若下方空间不够（图形区在面板底部时），改为向上弹出
    menu.style.top = "";
    menu.style.bottom = "";
    menu.style.display = "block";
    const mh = menu.offsetHeight || 110;
    if (r.bottom + 2 + mh > window.innerHeight - 4) {
      menu.style.bottom = (window.innerHeight - r.top + 2) + "px";
    } else {
      menu.style.top = (r.bottom + 2) + "px";
    }
  }

  function gotoCurrentCommit() {
    const first = document.querySelector(".git-graph .git-commit-row");
    if (!first) { toast("没有历史记录项", "warn"); return; }
    first.scrollIntoView({ block: "center" });
    first.classList.add("flash");
    setTimeout(() => first.classList.remove("flash"), 1200);
  }

  /* 提交悬停信息卡：作者 / 相对时间 / 完整信息 / 变更统计 / 哈希（模拟 VS Code 图形视图） */
  let gitCard = null, gitCardShow = null, gitCardHide = null;
  const gitStatsCache = {};

  function gitRelTime(s) {
    const t = new Date(String(s).replace(" ", "T"));
    if (isNaN(t.getTime())) return "";
    const sec = (Date.now() - t.getTime()) / 1000;
    if (sec < 60) return "刚刚";
    if (sec < 3600) return Math.floor(sec / 60) + "分钟前";
    if (sec < 86400) return Math.floor(sec / 3600) + "小时前";
    if (sec < 86400 * 30) return Math.floor(sec / 86400) + "天前";
    if (sec < 86400 * 365) return Math.floor(sec / 86400 / 30) + "个月前";
    return Math.floor(sec / 86400 / 365) + "年前";
  }

  function hideCommitCard() {
    clearTimeout(gitCardShow); clearTimeout(gitCardHide);
    if (gitCard) { gitCard.remove(); gitCard = null; }
  }

  function showCommitCard(row, c) {
    hideCommitCard();
    const card = document.createElement("div");
    card.className = "git-hover-card";
    let fullHash = "";
    const rel = gitRelTime(c.date);
    card.innerHTML =
      '<div class="ghc-author"><i class="bi bi-person-circle"></i><span>' + esc(c.author) + '</span>' +
      (rel ? '<span class="ghc-time">' + esc(rel) + ' (' + esc(c.date) + ')</span>' : "") + "</div>" +
      '<div class="ghc-msg">' + esc(c.subject) + "</div>" +
      '<div class="ghc-stats"></div>' +
      '<div class="ghc-hash" title="点击复制完整哈希">' + esc(c.hash) + "</div>";
    card.addEventListener("mouseenter", () => clearTimeout(gitCardHide));
    card.addEventListener("mouseleave", () => { gitCardHide = setTimeout(hideCommitCard, 200); });
    card.querySelector(".ghc-hash").onclick = (e) => {
      e.stopPropagation();
      copyText(fullHash || c.hash);
      toast("已复制提交哈希", "ok");
    };

    const statsEl = card.querySelector(".ghc-stats");
    const fillStats = (st) => {
      if (!st || !st.files) { statsEl.style.display = "none"; return; }
      let html = "已更改 " + st.files + " 个文件";
      if (st.insertions) html += '，<span class="ins">' + st.insertions + ' 行插入(+)</span>';
      if (st.deletions) html += '，<span class="del">' + st.deletions + ' 行删除(-)</span>';
      statsEl.innerHTML = html;
    };
    if (gitStatsCache[c.hash]) {
      fillStats(gitStatsCache[c.hash].stats);
      fullHash = gitStatsCache[c.hash].full || "";
    } else {
      statsEl.textContent = "统计加载中…";
      fetch("/api/git/show?path=" + encodeURIComponent(gitState.repo) + "&hash=" + encodeURIComponent(c.hash))
        .then(r => r.json())
        .then(d => {
          if (d.error || !d.stats) { if (card.isConnected) statsEl.style.display = "none"; return; }
          gitStatsCache[c.hash] = { stats: d.stats, full: (d.commit && d.commit.full) || "" };
          if (!card.isConnected) return;
          fillStats(d.stats);
          if (d.commit && d.commit.full) fullHash = d.commit.full;
        })
        .catch(() => { if (card.isConnected) statsEl.style.display = "none"; });
    }

    document.body.appendChild(card);
    const r = row.getBoundingClientRect();
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = r.right + 10;
    if (x + cw > window.innerWidth - 8) x = Math.max(8, r.left - cw - 10);
    if (x + cw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - cw - 8);
    let y = r.top - 4;
    if (y + ch > window.innerHeight - 8) y = window.innerHeight - ch - 8;
    if (y < 8) y = 8;
    card.style.left = x + "px";
    card.style.top = y + "px";
    gitCard = card;
  }

  function attachCommitHover(row, c) {
    row.addEventListener("mouseenter", () => {
      clearTimeout(gitCardHide);
      gitCardShow = setTimeout(() => showCommitCard(row, c), 300);
    });
    row.addEventListener("mouseleave", () => {
      clearTimeout(gitCardShow);
      gitCardHide = setTimeout(hideCommitCard, 200);
    });
  }
  document.addEventListener("mousedown", (e) => { if (gitCard && !gitCard.contains(e.target)) hideCommitCard(); });
  window.addEventListener("scroll", hideCommitCard, true);
  window.addEventListener("resize", hideCommitCard);

  async function setGitRemote() {
    if (!gitState.isRepo) { toast("当前不是 Git 仓库", "warn"); return; }
    let current = "", currentName = "origin";
    try {
      const d = await fetch("/api/git/remote?path=" + encodeURIComponent(gitState.repo)).then(r => r.json());
      if (d.ok) {
        const o = (d.remotes || []).find(x => x.name === "origin");
        if (o) { current = o.url; currentName = o.name; }
        else if (d.remotes && d.remotes[0]) { current = d.remotes[0].url; currentName = d.remotes[0].name; }
      }
    } catch (e) {}
    const url = await gitRemoteDialog(current, currentName);
    if (!url) return;
    fetch("/api/git/remote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: gitState.repo, name: currentName, url: url.trim() })
    })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); toast(d.message || "已设置远程仓库", "ok"); loadGitStatus(); })
      .catch(e => toast("设置失败：" + (e.message || e), "err"));
  }

  /* 设置远程仓库弹窗：输入地址 + 测试连接 + 默认分支信息 */
  function gitRemoteDialog(currentUrl, name) {
    return new Promise((resolve) => {
      const ov = $("modalOverlay");
      ov.innerHTML =
        '<div class="ide-modal">' +
          '<div class="m-title"><i class="bi bi-pencil-square"></i><span>设置远程仓库 ' + esc(name || "origin") + '</span></div>' +
          '<div class="m-body">' +
            '<div class="m-row">' +
              '<label>远程仓库地址</label>' +
              '<input id="grUrl" spellcheck="false" autocomplete="off" placeholder="例如 https://github.com/用户名/仓库名.git">' +
              '<div class="hint">支持 HTTPS / SSH / Git 协议</div>' +
            '</div>' +
            '<div class="m-row">' +
              '<button id="grTest" class="gr-test-btn"><i class="bi bi-wifi"></i> 测试连接</button>' +
              '<div id="grStatus" class="gr-status gr-status-na">未测试</div>' +
            '</div>' +
            '<div class="m-row">' +
              '<button id="grCreds" class="gr-creds-btn"><i class="bi bi-gear"></i> 前往 Git 认证设置</button>' +
            '</div>' +
          '</div>' +
          '<div class="m-foot">' +
            '<button class="m-cancel" id="grCancel">取消</button>' +
            '<button class="m-ok" id="grOk">确定</button>' +
          '</div>' +
        '</div>';
      ov.classList.add("show");
      const inp = $("grUrl");
      const status = $("grStatus");
      const testBtn = $("grTest");
      const okBtn = $("grOk");
      const cancelBtn = $("grCancel");
      const credsBtn = $("grCreds");
      inp.value = currentUrl || "";
      const setStatus = (type, html) => {
        status.className = "gr-status gr-status-" + type;
        status.innerHTML = html;
      };
      const doTest = async () => {
        const url = inp.value.trim();
        if (!url) { setStatus("warn", '<i class="bi bi-exclamation-circle"></i> 请先输入远程仓库地址'); return; }
        setStatus("info", '<i class="bi bi-arrow-repeat spin"></i> 正在测试连接…');
        testBtn.disabled = true;
        okBtn.disabled = true;
        try {
          const r = await fetch("/api/git/remote/test", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: gitState.repo, name: name || "origin", url })
          });
          const d = await r.json();
          if (d.error) throw new Error(d.error);
          setStatus("ok", '<i class="bi bi-check-circle"></i> ' + esc(d.message || "连接成功"));
        } catch (e) {
          setStatus("err", '<i class="bi bi-x-circle"></i> ' + esc(e.message || "连接失败"));
        } finally {
          testBtn.disabled = false;
          okBtn.disabled = false;
        }
      };
      testBtn.onclick = doTest;
      const close = (val) => { ov.classList.remove("show"); ov.innerHTML = ""; resolve(val); };
      okBtn.onclick = () => {
        const url = inp.value.trim();
        if (!url) { setStatus("warn", '<i class="bi bi-exclamation-circle"></i> 地址不能为空'); inp.focus(); return; }
        close(url);
      };
      cancelBtn.onclick = () => close(null);
      credsBtn.onclick = () => { close(null); openSettingsTab("sec-git-creds"); };
      ov.onmousedown = (e) => { if (e.target === ov) close(null); };
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doTest(); } };
      inp.focus();
      inp.select();
    });
  }

  /* ---------- 设置 → Git 认证：可视化配置 Token，自动用于 push/pull/fetch ---------- */
  let gcState = { type: "none", hasToken: false, loading: false };
  function gitCredsMountSettings(host) {
    const q = (s) => host.querySelector(s);
    const typeEl = q("#gcType");
    const tokenWrap = q("#gcTokenWrap");
    const usernameWrap = q("#gcUsernameWrap");
    const hostWrap = q("#gcHostWrap");
    const tokenEl = q("#gcToken");
    const usernameEl = q("#gcUsername");
    const hostEl = q("#gcHost");
    const testBtn = q("#gcTest");
    const saveBtn = q("#gcSave");
    const tipEl = q("#gcTip");
    const summaryEl = q("#gcSummary");

    function setTip(type, html) {
      tipEl.className = "gc-tip gc-tip-" + type;
      tipEl.innerHTML = html;
    }
    function renderSummary(d) {
      if (!d || d.type === "none" || !d.has_token) {
        summaryEl.innerHTML = '<span class="gc-sum-na"><i class="bi bi-info-circle"></i> 当前未启用认证</span>';
        return;
      }
      const parts = ['<span class="gc-sum-ok"><i class="bi bi-check-circle"></i> 已启用 HTTPS Token 认证</span>'];
      if (d.username) parts.push('用户名：<b>' + esc(d.username) + '</b>');
      if (d.host) parts.push('限定主机：<b>' + esc(d.host) + '</b>');
      parts.push('Token：<b>' + esc(d.token || "已保存") + '</b>');
      summaryEl.innerHTML = parts.join(' <span class="gc-sum-div">|</span> ');
    }
    function updateFields() {
      const on = typeEl.value === "https_token";
      tokenWrap.style.display = on ? "" : "none";
      usernameWrap.style.display = on ? "" : "none";
      hostWrap.style.display = on ? "" : "none";
      summaryEl.style.display = on ? "" : "none";
    }
    async function loadCreds() {
      try {
        const d = await fetch("/api/git/credentials").then(r => r.json());
        if (d.error) throw new Error(d.error);
        gcState.type = d.type || "none";
        gcState.hasToken = !!d.has_token;
        typeEl.value = gcState.type;
        usernameEl.value = d.username || "";
        hostEl.value = d.host || "";
        tokenEl.placeholder = d.has_token ? "已保存（留空沿用）" : "输入 Token";
        tokenEl.value = "";
        renderSummary(d);
        updateFields();
      } catch (e) {
        setTip("err", "读取认证配置失败：" + esc(e.message || e));
      }
    }
    async function saveCreds() {
      if (gcState.loading) return;
      gcState.loading = true;
      saveBtn.disabled = true;
      testBtn.disabled = true;
      setTip("info", "正在保存…");
      try {
        const payload = {
          type: typeEl.value,
          username: usernameEl.value.trim(),
          host: hostEl.value.trim(),
          token: tokenEl.value.trim()
        };
        const d = await fetch("/api/git/credentials", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(r => r.json());
        if (d.error) throw new Error(d.error);
        gcState.hasToken = !!d.has_token;
        usernameEl.value = d.username || "";
        hostEl.value = d.host || "";
        tokenEl.placeholder = d.has_token ? "已保存（留空沿用）" : "输入 Token";
        tokenEl.value = "";
        renderSummary(d);
        setTip("ok", "已保存 Git 认证设置");
      } catch (e) {
        setTip("err", "保存失败：" + esc(e.message || e));
      } finally {
        gcState.loading = false;
        saveBtn.disabled = false;
        testBtn.disabled = false;
      }
    }
    async function testCreds() {
      if (!gitState.isRepo) { setTip("warn", "当前不是 Git 仓库，无法测试"); return; }
      if (typeEl.value !== "https_token") { setTip("warn", "请先选择「HTTPS Token」认证方式"); return; }
      if (gcState.loading) return;
      // 先保存，使当前输入的 Token / 用户名 / 主机生效后再测
      await saveCreds();
      if (tipEl.classList.contains("gc-tip-err")) return;
      gcState.loading = true;
      saveBtn.disabled = true;
      testBtn.disabled = true;
      setTip("info", '<i class="bi bi-arrow-repeat spin"></i> 正在测试…');
      try {
        const rd = await fetch("/api/git/remote?path=" + encodeURIComponent(gitState.repo)).then(r => r.json());
        if (rd.error) throw new Error(rd.error);
        const origin = (rd.remotes || []).find(x => x.name === "origin");
        if (!origin || !origin.url) throw new Error("当前仓库没有配置 origin 远程仓库");
        const td = await fetch("/api/git/remote/test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: gitState.repo, url: origin.url })
        }).then(r => r.json());
        if (td.error) throw new Error(td.error);
        setTip("ok", esc(td.message || "连接成功"));
      } catch (e) {
        setTip("err", esc(e.message || "测试失败"));
      } finally {
        gcState.loading = false;
        saveBtn.disabled = false;
        testBtn.disabled = false;
      }
    }
    typeEl.addEventListener("change", updateFields);
    saveBtn.onclick = saveCreds;
    testBtn.onclick = testCreds;
    loadCreds();
  }

  function remoteOp(verb, label, done) {
    if (!gitState.isRepo) { toast("当前不是 Git 仓库", "warn"); return; }
    toast(label + "中…");
    fetch("/api/git/" + verb, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: gitState.repo }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        toast(label + "完成", "ok");
        if (verb === "pull") refreshTree(ROOT); else loadGitStatus();
        if (done) done(d);
      })
      .catch(e => toast(label + "失败：" + String(e.message || e).replace(/\s+/g, " ").slice(0, 120), "err"));
  }

  function gitGraphSection() {
    const wrap = document.createElement("div");
    wrap.className = "git-sec git-graph";
    const head = document.createElement("div");
    head.className = "git-sec-head git-graph-head";
    head.innerHTML = '<i class="bi bi-chevron-down git-sec-tw"></i><span class="git-sec-title">图形</span>' +
      '<span class="g-auto" title="自动抓取由 Git 服务提供程序管理"><i class="bi bi-diagram-3"></i>自动</span>' +
      '<span class="git-acts"></span><span class="git-cnt">' + (gitGraph.length || "") + '</span>';
    const acts = head.querySelector(".git-acts");
    const addAct = (icon, title, fn) => {
      const b = document.createElement("button");
      b.innerHTML = '<i class="bi ' + icon + '"></i>';
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      acts.appendChild(b);
      return b;
    };
    addAct("bi-crosshair", "转到当前历史记录项", gotoCurrentCommit);
    addAct("bi-cloud-download", "从所有远程存储库中抓取", () => remoteOp("fetch", "抓取"));
    addAct("bi-arrow-down-circle", "拉取", () => remoteOp("pull", "拉取"));
    addAct("bi-cloud-upload", "发布分支 / 推送", () => remoteOp("push", "发布分支"));
    addAct("bi-arrow-clockwise", "刷新", () => loadGitStatus(true));
    addAct("bi-three-dots", "更多操作", () => {});
    acts.lastChild.onclick = (e) => { e.stopPropagation(); showGitMoreMenu(acts.lastChild); };

    const body = document.createElement("div");
    if (!gitGraph.length) {
      const e = document.createElement("div");
      e.className = "git-empty";
      e.textContent = "没有任何源代码管理历史记录项。";
      body.appendChild(e);
    } else {
      gitGraph.forEach((c, i) => {
        const refs = (c.refs || [])
          .map(r => r.replace(/^HEAD -> /, ""))
          .filter(r => r && r !== "HEAD")
          .slice(0, 2);
        const item = document.createElement("div");
        // first/head：首行时间线从圆心开始且加粗；last：末行时间线在圆心结束
        item.className = "git-commit-item" +
          (i === 0 ? " first head" : "") + (i === gitGraph.length - 1 ? " last" : "");
        const row = document.createElement("div");
        row.className = "git-commit-row";
        row.innerHTML = '<span class="gc-node"></span>' +
          '<span class="gc-sub">' + esc(c.subject) + '</span>' +
          '<span class="gc-author">' + esc(c.author) + '</span>' +
          refs.map(r => '<span class="gc-ref' + (r.startsWith("tag:") ? " tag" : "") + '">' +
            (r.startsWith("tag:") ? "" : '<i class="bi bi-diagram-2-fill"></i>') +
            esc(r.replace(/^tag: /, "")) + '</span>').join("") +
          '<span class="gc-acts"><button title="复制提交哈希"><i class="bi bi-copy"></i></button></span>';
        row.querySelector(".gc-acts button").onclick = (e) => {
          e.stopPropagation();
          copyText((gitStatsCache[c.hash] && gitStatsCache[c.hash].full) || c.hash);
          toast("已复制提交哈希", "ok");
        };
        const files = document.createElement("div");
        files.className = "git-commit-files";
        files.style.display = "none";
        let loaded = false;
        row.onclick = () => {
          const show = files.style.display === "none";
          files.style.display = show ? "" : "none";
          if (show && !loaded) { loaded = true; loadCommitFiles(c.hash, files); }
        };
        item.appendChild(row);
        item.appendChild(files);
        attachCommitHover(row, c);
        body.appendChild(item);
      });
    }
    const setCollapsed = (collapsed) => {
      body.style.display = collapsed ? "none" : "";
      // 折叠时收成一行并贴到面板最底部（与 Trae 一致）；展开时占满剩余空间
      wrap.classList.toggle("collapsed", collapsed);
      const iconClass = collapsed ? "bi-chevron-right" : "bi-chevron-down";
      head.querySelector(".git-sec-tw").className = "bi " + iconClass + " git-sec-tw";
      try { localStorage.setItem("gitSecCollapsed:图形", collapsed ? "1" : "0"); } catch (e) {}
    };
    head.onclick = () => setCollapsed(body.style.display !== "none");
    // 恢复上次折叠状态
    try {
      const saved = localStorage.getItem("gitSecCollapsed:图形");
      if (saved === "1") setCollapsed(true);
    } catch (e) {}
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  /* 展开提交：列出该提交变更的文件，点击可查看该文件在此提交中的差异/源码 */
  function commitFileRow(f, depth, hash) {
    const name = f.name || baseName(f.path);
    const dir = f.path.indexOf("/") >= 0 ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
    const row = document.createElement("div");
    row.className = "git-commit-file";
    row.style.paddingLeft = (34 + (depth || 0) * 12) + "px";
    row.title = f.path + "（" + f.status + "）— 点击查看该提交中的差异/源码";
    row.innerHTML = '<span class="ic">' + iconFor(name, false) + '</span>' +
      '<span class="gcf-name">' + esc(name) + '</span>' +
      (gitCommitFileMode === "list" && dir ? '<span class="gcf-dir">' + esc(dir) + '</span>' : '') +
      '<span class="gf-st">' + esc(f.status) + '</span>';
    row.onclick = (e) => { e.stopPropagation(); openDiffTab(f.path, false, false, hash); };
    return row;
  }

  function renderCommitTree(node, depth, hash) {
    const frag = document.createDocumentFragment();
    Array.from(node.dirs.entries())
      .sort((a, b) => a[0].localeCompare(b[0], "zh"))
      .forEach(([dn, child]) => {
        const head = document.createElement("div");
        head.className = "git-commit-dir";
        head.style.paddingLeft = (34 + (depth || 0) * 12) + "px";
        head.innerHTML = '<i class="bi bi-chevron-down gcf-tw"></i><i class="bi bi-folder2 gcf-ic"></i>' +
          '<span class="gcf-name">' + esc(dn) + '</span><span class="gf-st">' + gitTreeCount(child) + '</span>';
        const box = document.createElement("div");
        box.appendChild(renderCommitTree(child, depth + 1, hash));
        head.onclick = (e) => {
          e.stopPropagation();
          const hide = box.style.display !== "none";
          box.style.display = hide ? "none" : "";
          head.querySelector(".gcf-tw").className = "bi " + (hide ? "bi-chevron-right" : "bi-chevron-down") + " gcf-tw";
        };
        frag.appendChild(head);
        frag.appendChild(box);
      });
    node.files.slice()
      .sort((a, b) => (a.name || a.path).localeCompare(b.name || b.path, "zh"))
      .forEach(f => frag.appendChild(commitFileRow(f, depth, hash)));
    return frag;
  }

  function renderCommitFileList(box, files, hash) {
    box.innerHTML = "";
    if (!files.length) { box.innerHTML = '<div class="gcf-msg">该提交没有文件变更。</div>'; return; }
    if (gitCommitFileMode === "tree") {
      box.appendChild(renderCommitTree(gitTreeFrom(files), 0, hash));
    } else {
      files.forEach(f => box.appendChild(commitFileRow(f, 0, hash)));
    }
  }

  function reloadCommitLists() {
    document.querySelectorAll(".git-commit-files").forEach(box => {
      if (box._files) renderCommitFileList(box, box._files, box._hash);
    });
  }

  function loadCommitFiles(hash, box) {
    box.innerHTML = '<div class="gcf-msg">加载中…</div>';
    fetch("/api/git/show?path=" + encodeURIComponent(gitState.repo) + "&hash=" + encodeURIComponent(hash))
      .then(r => r.json())
      .then(d => {
        if (d.error) { box.innerHTML = '<div class="gcf-msg">读取失败：' + esc(d.error) + '</div>'; return; }
        box._files = d.files || [];
        box._hash = hash;
        renderCommitFileList(box, box._files, hash);
        if (d.truncated) {
          const m = document.createElement("div");
          m.className = "gcf-msg";
          m.textContent = "文件过多，仅显示前 500 个。";
          box.appendChild(m);
        }
      })
      .catch(e => { box.innerHTML = '<div class="gcf-msg">读取失败：' + esc(e.message || e) + '</div>'; });
  }

  function renderGitStatus(d) {
    $("gitBranch").textContent = d.branch || "（无分支）";
    const msgEl = $("gitCommitMsg");                 // 占位文案带上当前分支（对齐 VS Code）
    if (msgEl) msgEl.placeholder = "提交变更内容（Ctrl+Enter 在 “" + (d.branch || "HEAD") + "” 上提交）";
    $("gitSync").textContent = (d.ahead ? "↑" + d.ahead : "") + (d.behind ? "↓" + d.behind : "");
    const box = $("gitList");
    box.innerHTML = "";
    const sections = [
      { title: "已暂存的更改", files: d.staged || [], staged: true },
      { title: "更改", files: (d.changed || []).concat(d.untracked || []), staged: false },
    ];
    const total = sections.reduce((s, x) => s + x.files.length, 0);
    if (total) {
      sections.forEach(sec => { if (sec.files.length) box.appendChild(gitSection(sec)); });
    } else {
      const e = document.createElement("div");
      e.className = "git-empty";
      e.textContent = "没有检测到更改。";
      box.appendChild(e);
    }
    box.appendChild(gitGraphSection());
  }

  function updateBranchStatus(d) {
    const el = $("sbBranch");
    el.style.cursor = "pointer";
    if (!d || !d.is_repo) {
      el.innerHTML = '<i class="bi bi-git"></i> 未检测到仓库';
      el.title = "点击打开源代码管理";
      return;
    }
    const n = (d.counts ? (d.counts.staged + d.counts.changed + d.counts.untracked) : 0);
    el.innerHTML = '<i class="bi bi-git"></i> ' + esc(d.branch || "HEAD") +
      (d.ahead ? " ↑" + d.ahead : "") + (d.behind ? " ↓" + d.behind : "") + (n ? "  ●" + n : "");
    el.title = "分支 " + (d.branch || "") + "，共 " + n + " 个更改";
  }

  function applyGitDecorations(d) {
    const map = new Map();
    if (d && d.is_repo) {
      (d.staged || []).forEach(f => map.set(f.path, "staged"));
      (d.changed || []).forEach(f => map.set(f.path, "modified"));
      (d.untracked || []).forEach(f => { if (!map.has(f.path)) map.set(f.path, "untracked"); });
    }
    const repo = (d && d.repo) ? d.repo : "";
    document.querySelectorAll(".tree-row").forEach(r => {
      r.classList.remove("git-modified", "git-untracked", "git-staged");
      if (!map.size || r.dataset.isdir === "1" || !r.dataset.path) return;
      if (repo && !r.dataset.path.startsWith(repo + "/")) return;
      const rel = repo ? r.dataset.path.substring(repo.length + 1) : r.dataset.path;
      const kind = map.get(rel);
      if (kind) r.classList.add("git-" + kind);
    });
  }

  /* git 活动栏角标：显示未提交变更总数（暂存 + 修改 + 未跟踪） */
  function setGitBadge(d) {
    const gb = $("actGitBadge");
    if (!gb) return;
    const n = d && d.is_repo ? ((d.staged || []).length + (d.changed || []).length + (d.untracked || []).length) : 0;
    if (n > 0) { gb.textContent = n > 99 ? "99+" : n; gb.style.display = ""; }
    else gb.style.display = "none";
  }

  function loadGitStatus(showToast) {
    // 状态与提交历史并行拉取，一次渲染，避免闪烁
    return Promise.all([
      fetch("/api/git/status?path=" + encodeURIComponent(ROOT)).then(r => r.json()),
      fetch("/api/git/log?path=" + encodeURIComponent(ROOT) + "&limit=30")
        .then(r => r.json()).catch(() => ({ commits: [] })),
    ])
      .then(([d, lg]) => {
        gitGraph = (lg && lg.commits) || [];
        gitState.last = d;
        gitState.isRepo = !!d.is_repo;
        gitState.repo = d.repo || ROOT;
        gitState.branch = d.branch || "";
        $("gitPanel").classList.toggle("not-repo", !d.is_repo);   // 非仓库时隐藏提交区
        updateBranchStatus(d);
        applyGitDecorations(d);
        setGitBadge(d);
        if (!d.is_repo) { renderGitMessage(d.error || "当前文件夹不是 Git 仓库，可点击下方按钮初始化。", true); return; }
        if (!d.ok) { renderGitMessage(d.error || "读取 Git 状态失败"); return; }
        renderGitStatus(d);
        scheduleReloadAllChanges();          // 已打开的「更改」汇总标签页跟随刷新
        if (showToast) toast("Git 状态已刷新", "ok");
      })
      .catch(e => renderGitMessage("Git 状态读取失败：" + (e.message || e)));
  }

  /* 分栏差异：把 unified diff 解析为左右对齐的行对（VS Code 风格） */
  function buildSplitDiff(diffText) {
    const lines = String(diffText || "").split("\n");
    while (lines.length && !lines[lines.length - 1]) lines.pop();   // 去掉尾部空行（避免解析出假行）
    const rows = [];                             // {l1,t1,l2,t2,k}  k: ctx / add / del
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) { i++; continue; }
      let l1 = parseInt(m[1], 10), l2 = parseInt(m[3], 10);
      i++;
      let block = [];                            // 收集同一块内的行，按序配对 del/add
      while (i < lines.length) {
        const t = lines[i];
        if (t.startsWith("@@") || t.startsWith("diff ")) break;
        if (t.startsWith("+")) block.push({ l1: null, t1: "", l2: l2++, t2: t.slice(1), k: "add" });
        else if (t.startsWith("-")) block.push({ l1: l1++, t1: t.slice(1), l2: null, t2: "", k: "del" });
        else if (t.startsWith("\\")) { /* "\ No newline at end of file" 忽略 */ }
        else if (t.startsWith(" ") || t === "") block.push({ l1: l1++, t1: t.slice(1), l2: l2++, t2: t.slice(1), k: "ctx" });
        else break;                              // 其它残片（如截断输出）：结束当前 hunk
        i++;
      }
      // 把连续的 del 块与 add 块按下标配对，使修改行左右对齐；多余一侧留空（fill）
      let p = 0;
      while (p < block.length) {
        if (block[p].k === "del") {
          const dels = [];
          while (p < block.length && block[p].k === "del") dels.push(block[p++]);
          const adds = [];
          while (p < block.length && block[p].k === "add") adds.push(block[p++]);
          const n = Math.max(dels.length, adds.length);
          for (let j = 0; j < n; j++) {
            const d = dels[j], a = adds[j];
            rows.push({
              l1: d ? d.l1 : null, t1: d ? d.t1 : "",
              l2: a ? a.l2 : null, t2: a ? a.t2 : "",
              k: d && a ? "mod" : (d ? "del" : "add"),
            });
          }
        } else {
          rows.push(block[p++]);                 // ctx / add（无配对 del 的纯新增）
        }
      }
    }
    return collapseUnchanged(rows);
  }

  /* 未更改区域两侧保留的上下文行数（对齐 VS Code 折叠未更改区域的行为） */
  const DIFF_CTX = 3;

  /* 把过长的连续未更改行折叠成一条可展开的 “gap” 行 */
  function collapseUnchanged(rows) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].k !== "ctx") { out.push(rows[i++]); continue; }
      let j = i;
      while (j < rows.length && rows[j].k === "ctx") j++;
      const run = rows.slice(i, j);
      if (run.length > DIFF_CTX * 2) {
        for (let k = 0; k < DIFF_CTX; k++) out.push(run[k]);
        out.push({ k: "gap", hidden: run.slice(DIFF_CTX, run.length - DIFF_CTX) });
        for (let k = run.length - DIFF_CTX; k < run.length; k++) out.push(run[k]);
      } else {
        run.forEach(r => out.push(r));
      }
      i = j;
    }
    return out;
  }

  /* 把一行文本拆成 token 列表（复用 CodeMirror 模式；失败则退回单个纯文本 token） */
  function syntaxTokens(line, mode) {
    const plain = [{ t: line, cls: null }];
    if (!mode || typeof CodeMirror === "undefined" || !CodeMirror.getMode) return plain;
    /* 用 getMode 拿到带 token/startState 的真实模式对象（CodeMirror.modes[name] 可能是函数或 {mode,indent,...}） */
    let m = null;
    try { m = CodeMirror.getMode({ indentUnit: 2 }, mode); } catch (_) { m = null; }
    if (!m || typeof m.token !== "function") return plain;
    const out = [];
    try {
      let stream = new CodeMirror.StringStream(line), state = CodeMirror.startState(m);
      while (!stream.eol()) {
        const tok = m.token(stream, state);
        const s0 = stream.start, text = line.substring(s0, stream.pos);
        if (!text) { stream.start = stream.pos; continue; }
        const cls = tok && tok !== "string" && text.replace(/\s/g, "") !== "" ? tok : null;
        out.push({ t: text, cls });
        stream.start = stream.pos;
      }
    } catch (_) { return plain; }
    return out.length ? out : plain;
  }

  /* 把 token 列表渲染成 HTML；ranges 为需要叠加词级高亮的字符区间 [start,end) */
  function tokensHTML(tokens, ranges) {
    const rs = ranges || [];
    const tok = (tk, text) => !text ? "" :
      (tk.cls ? '<span class="cm-' + tk.cls + '">' + esc(text) + "</span>" : esc(text));
    let html = "", pos = 0;
    for (let n = 0; n < tokens.length; n++) {
      const tk = tokens[n], s = pos, e = pos + tk.t.length;
      pos = e;
      let cur = s;
      for (let k = 0; k < rs.length; k++) {
        const a = Math.max(rs[k][0], s), b = Math.min(rs[k][1], e);
        if (b <= a) continue;
        if (a > cur) html += tok(tk, tk.t.slice(cur - s, a - s));
        html += '<span class="sd-wd">' + tok(tk, tk.t.slice(a - s, b - s)) + "</span>";
        cur = b;
      }
      if (cur < e) html += tok(tk, tk.t.slice(cur - s, e - s));
    }
    return html;
  }

  /* 行内词级差异：用公共前后缀裁出改动区间（对齐 VS Code 的行内高亮） */
  function inlineRanges(a, b) {
    const A = a || "", B = b || "";
    let s = 0;
    const n = Math.min(A.length, B.length);
    while (s < n && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    return { ra: ea > s ? [[s, ea]] : [], rb: eb > s ? [[s, eb]] : [] };
  }

  /* 给差异单元格填充内容：token 着色 + 行内词级高亮（语言未就绪时先渲染纯文本，就绪后回填） */
  function highlightDiffCells(tab, root) {
    if (!tab || tab.diffView !== "diff") return;
    const codes = (root || tab.cmBox).querySelectorAll(".sd-code");
    if (!codes.length) return;
    const paint = (mode) => {
      let changed = false;
      codes.forEach(c => {
        if (!c._line) return;
        const h = tokensHTML(syntaxTokens(c._line, mode), c._ranges);
        if (h) { c.innerHTML = h; changed = true; }
      });
      if (changed) refreshDiffNav(tab);
    };
    paint(null);
    ensureMode(getExt(tab.relPath)).then(m => { if (m && tab.diffView === "diff") paint(m); });
  }

  function mountSplitDiff(tab) {
    tab.cmBox.innerHTML = "";
    const text = tab.diffText || "";
    const rows = buildSplitDiff(text);
    const wrap = document.createElement("div");
    wrap.className = "sd-wrap";
    if (!rows.length) {
      wrap.innerHTML = '<div style="padding:30px;color:#888;">' + esc(text || "（没有差异）") + "</div>";
      tab.cmBox.appendChild(wrap);
      return;
    }
    // 从 diff 头部 index 行取新旧版本号（工作区新版本为 0000000 时显示“工作区”）
    let oldRev = "旧版本", newRev = "新版本";
    const im = text.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m);
    if (im) {
      oldRev = "旧版本 " + im[1].slice(0, 7);
      newRev = /^[0]+$/.test(im[2]) ? "新版本（工作区）" : "新版本 " + im[2].slice(0, 7);
    } else if (tab.untracked) {
      oldRev = "旧版本（无）"; newRev = "新版本（工作区）";
    }
    const hasOld = rows.some(r => r.l1 != null);
    const hasNew = rows.some(r => r.l2 != null);
    const single = !hasOld || !hasNew;           // 新文件 / 删除文件：只渲染非空一侧
    const grid = document.createElement("div");
    grid.className = "sd-grid cm-s-material-darker";   // 复用 CodeMirror 主题，token 配色与「源码」视图一致
    grid.style.gridTemplateColumns = single ? "1fr" : "1fr 1fr";
    grid.style.minWidth = single ? "480px" : "860px";
    const cell = (cls, ln, tx, ranges) => {
      const c = document.createElement("div");
      c.className = "sd-cell " + cls;
      const codeEl = document.createElement("span");
      codeEl.className = "sd-code";
      codeEl._line = tx == null ? "" : tx;
      codeEl._ranges = ranges || null;
      c.innerHTML = '<span class="sd-ln">' + (ln == null ? "" : ln) + '</span>' +
        '<span class="sd-tx"></span>';
      c.querySelector(".sd-tx").appendChild(codeEl);
      if (cls === "add" || cls === "del" || cls === "mod") c.className += " cellR";
      return c;
    };
    /* 一行 diff 对应的单元格：分栏模式左右各一个，单栏模式只生成非空一侧。
       sd-cl / sd-cr 标记所属侧，底部自定义水平滚动条按侧统一平移其内容 */
    const rowCells = (r) => {
      if (single) {
        const c = hasNew ? cell("add", r.l2, r.t2, null) : cell("del", r.l1, r.t1, null);
        c.classList.add("sd-cl");
        return [c];
      }
      const kL = r.k === "add" ? "fill" : (r.k === "mod" ? "del" : r.k);
      const kR = r.k === "del" ? "fill" : (r.k === "mod" ? "add" : r.k);
      const ir = r.k === "mod" ? inlineRanges(r.t1, r.t2) : null;
      const cl = cell(kL, r.l1, r.t1, ir ? ir.ra : null);
      const cr = cell(kR, r.l2, r.t2, ir ? ir.rb : null);
      cl.classList.add("sd-cl"); cr.classList.add("sd-cr");
      return [cl, cr];
    };
    /* 折叠的未更改区域：默认只显示一条横条，点击展开（对齐 VS Code） */
    const gapRow = (r) => {
      const g = document.createElement("div");
      g.className = "sd-gap";
      g.innerHTML = '<span class="gd-ic">⋯</span><span class="gd-n">展开 ' +
        r.hidden.length + ' 行未更改内容</span>';
      g.onclick = () => {
        const frag = document.createDocumentFragment();
        r.hidden.forEach(rr => rowCells(rr).forEach(c => frag.appendChild(c)));
        g.replaceWith(frag);
        highlightDiffCells(tab, grid);
        refreshDiffNav(tab);
        requestAnimationFrame(() => refreshDiffScrollbars(tab));
      };
      return g;
    };
    if (single) {
      grid.appendChild(cell("sd-head", null,
        hasNew ? newRev + "（新文件）" : oldRev + "（文件已删除）", null));
    } else {
      grid.appendChild(cell("sd-head", null, oldRev, null));
      grid.appendChild(cell("sd-head", null, newRev, null));
    }
    rows.forEach(r => {
      if (r.k === "gap") grid.appendChild(gapRow(r));
      else rowCells(r).forEach(c => grid.appendChild(c));
    });
    const body = document.createElement("div");
    body.className = "sd-body";
    body.appendChild(grid);
    wrap.appendChild(body);
    wrap.appendChild(buildDiffScrollbars(tab, single));   // 底部左右两条自定义水平滚动条
    tab.cmBox.appendChild(wrap);
    // 语法高亮 + 行内词级高亮（语言未就绪时先渲染纯文本，就绪后回填）
    highlightDiffCells(tab, grid);
    // 差异导航：只在最右侧显示总览条（不再显示右上角的迷你悬浮部件）。
    // 汇总视图每个文件块共用一个滚动条，右条会相互叠加，故只给独占标签页渲染
    if (tab.host) buildDiffNavWidget(tab);
    // 布局完成后测量长行宽度，决定自定义水平滚动条滑块大小
    requestAnimationFrame(() => refreshDiffScrollbars(tab));
  }

  /* 差异代码所在的网格（底部滚动条、水平平移都基于它） */
  function diffGrid(tab) {
    const box = diffScroller(tab);
    return box ? box.querySelector(".sd-grid") : null;
  }

  /* 底部左右两条自定义水平滚动条：点击 / 拖动滑块（或轨道）滚动对应一侧的长行 */
  function buildDiffScrollbars(tab, single) {
    const row = document.createElement("div");
    row.className = "sd-sbars";
    (single ? ["l"] : ["l", "r"]).forEach(side => {
      const bar = document.createElement("div");
      bar.className = "sd-sbar";
      bar.dataset.pane = side;
      bar.title = "水平滚动代码";
      bar.innerHTML = '<div class="sd-sb-thumb"></div>';
      bindDiffHScroll(tab, bar);
      row.appendChild(bar);
    });
    return row;
  }

  /* 两侧各自水平滚动量的 CSS 变量：改一次变量，该侧所有行一起平移（O(1)） */
  const DIFF_HVAR = { l: "--sd-txl", r: "--sd-txr" };
  const SB_PAD = 4;             // .sd-sbar 左右内边距，与 CSS 保持一致

  /* 按当前偏移量摆放滑块位置与长度 */
  function layoutSbThumb(bar) {
    const th = bar.querySelector(".sd-sb-thumb");
    if (!th) return;
    const max = bar._max || 0;
    if (max <= 0) { th.style.display = "none"; return; }
    th.style.display = "";
    const trackW = Math.max(1, bar.clientWidth - SB_PAD * 2);
    const ratio = bar._contentW ? bar._viewW / bar._contentW : 1;
    const tw = Math.max(24, Math.min(trackW, Math.round(trackW * ratio)));
    const left = SB_PAD + ((bar._off || 0) / max) * (trackW - tw);
    th.style.width = tw + "px";
    th.style.left = left.toFixed(1) + "px";
  }

  /* 设置某一侧的水平偏移量（0 ~ 最大可滚距离） */
  function setDiffHScroll(tab, side, off) {
    const grid = diffGrid(tab);
    if (!grid || !tab.cmBox) return;
    const bar = tab.cmBox.querySelector('.sd-sbar[data-pane="' + side + '"]');
    const max = (bar && bar._max) || 0;
    const v = Math.max(0, Math.min(max, off));
    grid.style.setProperty(DIFF_HVAR[side], (-v).toFixed(1) + "px");
    if (bar) { bar._off = v; layoutSbThumb(bar); }
  }

  /* 点击 / 拖动滚动条：把点击位置换算成水平偏移量（视口中心对准点击点） */
  function bindDiffHScroll(tab, bar) {
    const apply = (e) => {
      if (!bar._max) return;
      const r = bar.getBoundingClientRect();
      const trackW = Math.max(1, r.width - SB_PAD * 2);
      const ratio = (e.clientX - r.left - SB_PAD) / trackW;
      setDiffHScroll(tab, bar.dataset.pane, ratio * bar._contentW - bar._viewW / 2);
    };
    bar.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      bar.classList.add("dragging");
      apply(e);
      const move = (ev) => apply(ev);
      const up = () => {
        bar.classList.remove("dragging");
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  /* 重新测量两侧内容宽度，并对齐/刷新底部自定义水平滚动条的轨道与滑块 */
  function refreshDiffScrollbars(tab) {
    const grid = diffGrid(tab);
    if (!grid) return;
    const sbars = tab.cmBox ? tab.cmBox.querySelector(".sd-sbars") : null;
    const baseRect = sbars ? sbars.getBoundingClientRect() : null;
    (sbars ? sbars.querySelectorAll(".sd-sbar") : []).forEach(bar => {
      const cells = grid.querySelectorAll(".sd-cell.sd-" +
        (bar.dataset.pane === "r" ? "cr" : "cl") + " .sd-tx");
      if (!cells.length) { bar.style.display = "none"; return; }
      // 轨道对齐到该侧代码列的实际位置与宽度（面板很窄时也能对得上）
      if (baseRect && cells[0].parentElement) {
        const r = cells[0].parentElement.getBoundingClientRect();
        bar.style.left = (r.left - baseRect.left) + "px";
        bar.style.width = r.width + "px";
      }
      let contentW = 0;
      cells.forEach(tx => { if (tx.scrollWidth > contentW) contentW = tx.scrollWidth; });
      bar._viewW = cells[0].clientWidth;
      bar._contentW = contentW;
      bar._max = Math.max(0, contentW - bar._viewW);
      bar._off = Math.max(0, Math.min(bar._max, bar._off || 0));
      grid.style.setProperty(DIFF_HVAR[bar.dataset.pane], (-bar._off).toFixed(1) + "px");
      layoutSbThumb(bar);
    });
  }

  /* 差异代码区真正的滚动容器（.sd-body）；总览定位与跳转都基于它计算 */
  function diffScroller(tab) {
    if (!tab.cmBox) return null;
    return tab.cmBox.querySelector(".sd-body") || tab.cmBox.querySelector(".sd-wrap") || tab.cmBox;
  }

  /* 取滚动容器相对某个差异单元格顶部的偏移（换算成不随滚动变化的绝对坐标） */
  function diffCellTop(el, box) {
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    return r.top - b.top + box.scrollTop;
  }

  /* 合并相邻/紧邻的差异单元格，得到若干连续“差异块”（用于画总览条上的色块） */
  function calcDiffBlocks(tab, box) {
    const cells = Array.from(box.querySelectorAll(".sd-cell.cellR"));
    const out = [];
    for (const c of cells) {
      const top = diffCellTop(c, box), h = c.offsetHeight || 20;
      const last = out[out.length - 1];
      if (last && top <= last.bottom + 2) last.bottom = Math.max(last.bottom, top + h);
      else out.push({ kind: c.className.indexOf("del") >= 0 ? "del" : "add", top, bottom: top + h });
    }
    return out;
  }

  /* 刷新最右侧的总览竖条：差异色块 + 当前视口滑块（可点击/拖拽跳转） */
  function refreshDiffNav(tab) {
    const box = diffScroller(tab);
    if (!box) return;
    const ov = tab.diffOv || (tab.cmBox && tab.cmBox.querySelector(".diff-overview"));
    if (!ov) return;
    const H = box.scrollHeight, vH = box.clientHeight;
    const blocks = calcDiffBlocks(tab, box);
    const oH = ov.clientHeight || 100;
    const so = H > 0 ? oH / H : 0;
    ov.innerHTML = blocks.map(b => {
      const top = b.top * so, h = Math.max(2, (b.bottom - b.top) * so - 0.6);
      return '<div class="do-mark ' + b.kind + '" style="top:' + top.toFixed(1) + "px;height:" + h.toFixed(1) + 'px"></div>';
    }).join("");
    const oThumbH = Math.max(6, vH * so);
    const oTop = vH > 0 && H > vH ? (box.scrollTop / (H - vH)) * (oH - oThumbH) : 0;
    const oThumb = document.createElement("div");
    oThumb.className = "do-thumb";
    oThumb.style.top = oTop.toFixed(1) + "px";
    oThumb.style.height = oThumbH.toFixed(1) + "px";
    ov.appendChild(oThumb);
    tab.diffOThumb = oThumb;
  }

  /* 按比例把总览条/竖条上的点击位置换算成滚动位置并跳转 */
  function jumpByRatio(tab, el, ratio) {
    const box = diffScroller(tab);
    if (!box) return;
    const H = box.scrollHeight;
    const top = Math.max(0, Math.min(1, ratio || 0)) * H;
    const half = Math.max(2, box.clientHeight * 0.28);
    box.scrollTop = Math.max(0, Math.min(H, top - half));
    const marks = box.querySelectorAll(".sd-cell.cellR");
    let best = null, bestD = Infinity;
    marks.forEach(c => {
      const d = Math.abs(diffCellTop(c, box) - top);
      if (d < bestD) { bestD = d; best = c; }
    });
    box.querySelectorAll(".sd-current").forEach(x => x.classList.remove("sd-current"));
    if (best) best.classList.add("sd-current");
    refreshDiffNav(tab);
  }

  /* 监听差异视图滚动：同步滑块位置，并清理不再属于当前视口的“当前差异”标记 */
  function bindDiffScroll(tab) {
    if (tab._diffScrollFn) tab._diffScrollFn();
    const box = diffScroller(tab);
    if (!box) return;
    let raf = 0;
    const fn = () => {
      raf = 0;
      refreshDiffNav(tab);
      // 面板很窄时 .sd-body 会整体横向滚动，需重新对齐底部滚动条轨道
      if (box.scrollLeft !== tab._sdLastLeft) {
        tab._sdLastLeft = box.scrollLeft;
        refreshDiffScrollbars(tab);
      }
      if (!tab._diffJump) {
        const box2 = diffScroller(tab), H = box2.scrollHeight;
        const vTop = box2.scrollTop, vBot = vTop + box2.clientHeight;
        const cur = box2.querySelector(".sd-current");
        if (cur) {
          const t = diffCellTop(cur, box2);
          if (t + cur.offsetHeight < vTop || t > vBot) cur.classList.remove("sd-current");
        }
      }
    };
    box.addEventListener("scroll", () => {
      if (!raf) raf = requestAnimationFrame(fn);
    }, { passive: true });
    const unbind = () => {
      box.removeEventListener("scroll", fn);
      if (raf) cancelAnimationFrame(raf);
      tab._diffScrollFn = null;
    };
    tab._diffScrollFn = unbind;
  }

  /* 在总览条 / 竖条上按下并拖拽：实时滚动到对应位置 */
  function bindDiffDrag(tab, el, getRatio) {
    const move = (e) => jumpByRatio(tab, el, getRatio(e));
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      tab._diffJump = false;
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      tab._diffJump = true;
      move(e);
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  /* 构建差异导航：只在差异区最右侧显示一条总览竖条（红/绿标记 + 点击或拖拽跳转） */
  function buildDiffNavWidget(tab) {
    const box = tab.cmBox;
    if (!box) return;
    box.querySelectorAll(".diff-overview").forEach(n => n.remove());
    const ov = document.createElement("div");
    ov.className = "diff-overview";
    ov.title = "差异总览：点击或拖拽跳转";
    box.appendChild(ov);          // 全局显示区块：差异区最右侧（自动滚动条在它左边）
    tab.diffNav = null;
    tab.diffOv = ov;
    bindDiffDrag(tab, ov, e =>
      (e.clientY - ov.getBoundingClientRect().top) / ov.clientHeight);
    bindDiffScroll(tab);
    refreshDiffNav(tab);
  }

  /* 把当前视图（差异 / 源码）挂载到标签页 */
  function mountDiffTab(tab) {
    tab.cmBox.innerHTML = "";
    if (tab.diffView === "diff") {
      mountSplitDiff(tab);
    } else {
      // 源码视图不显示差异导航控件
      const ov = tab.cmBox.querySelector(".diff-overview");
      if (ov) ov.remove();
      tab.diffNav = null;
      tab.diffOv = null;
      if (tab._diffScrollFn) tab._diffScrollFn();
      const text = tab.srcText || "";
      tab.cm = CodeMirror(tab.cmBox, {
        value: text, mode: "text/plain", theme: "material-darker",
        lineNumbers: true, lineWrapping: false, readOnly: true, styleActiveLine: true,
      });
      // 源码视图：套用对应语言的语法高亮
      ensureMode(getExt(tab.relPath)).then(m => {
        if (tab.cm) { tab.cm.setOption("mode", m || "text/plain"); tab.cm.refresh(); }
      });
    }
    activate(tab);
    scheduleRefresh(tab);
  }

  /* 在“差异”和“源码”之间切换（源码 = 该版本的文件原文，带语法高亮） */
  function setDiffView(tab, view) {
    if (tab.diffView === view) return;
    tab.diffView = view;
    tab.tools.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    if (view === "src" && tab.srcText === undefined) {
      tab.cmBox.innerHTML = '<div style="padding:30px;color:#888;">正在加载源码…</div>';
      tab.cm = null;
      const req = tab.hash
        ? fetch("/api/git/file?path=" + encodeURIComponent(gitState.repo) +
                "&rev=" + encodeURIComponent(tab.hash) + "&file=" + encodeURIComponent(tab.relPath))
            .then(r => r.json())
        : loadFileText(tab.displayPath, baseName(tab.relPath));
      req.then(d => {
        if (d.error) { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法加载源码：' + esc(d.error) + '</div>'; return; }
        tab.srcText = tab.hash ? d.content : d.text;
        mountDiffTab(tab);
      }).catch(e => { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法加载源码：' + esc(e.message || e) + '</div>'; });
      return;
    }
    tab.cm = null;
    mountDiffTab(tab);
  }

  /* 差异工具条右侧显示本次更改的行数（+新增 / −删除） */
  function setDiffToolStat(tab) {
    if (!tab || !tab.tools) return;
    if (!tab.diffStatEl) {
      const el = document.createElement("span");
      el.className = "dt-stat";
      tab.tools.appendChild(el);
      tab.diffStatEl = el;
    }
    const c = countDiffLines(tab.diffText || "");
    tab.diffStatEl.innerHTML = (c.adds || c.dels)
      ? '<span class="dt-add">+' + c.adds + '</span> <span class="dt-del">−' + c.dels + "</span>"
      : "";
  }

  function openDiffTab(relPath, staged, untracked, hash) {
    const abs = gitState.repo + "/" + relPath;
    const key = abs + "\u0001diff" + (staged ? "1" : "0") + (hash ? ":" + hash : "");
    let tab = findTab(key);
    if (tab) { activate(tab); return; }
    const host = document.createElement("div");
    host.className = "cm-host diff-host";
    host.innerHTML = '<div class="diff-tools"><span class="dt-label">' +
      (hash ? "提交 " + esc(String(hash).slice(0, 7)) : (staged ? "已暂存" : "工作区")) + '</span>' +
      '<button data-view="diff" class="active">差异</button>' +
      '<button data-view="src">源码</button></div><div class="diff-cm"></div>';
    const dw = currentWrap();
    (dw || edGroups).appendChild(host);
    tab = {
      path: key, host, cm: null, original: "", dirty: false, group: curGroup,
      name: hash ? (baseName(relPath) + " @" + String(hash).slice(0, 7)) : baseName(relPath),
      big: false, diff: true, displayPath: abs, diffView: "diff",
      relPath, staged, untracked, hash,
      cmBox: host.querySelector(".diff-cm"),
      tools: host.querySelector(".diff-tools"),
    };
    tabs.push(tab);
    renderTabsAll();
    activate(tab);   // 统一激活（成功后 mountDiffTab 会再激活一次，幂等）
    tab.cmBox.innerHTML = '<div style="padding:30px;color:#888;">正在生成差异…</div>';
    tab.tools.querySelectorAll("button").forEach(b => { b.onclick = () => setDiffView(tab, b.dataset.view); });
    const url = "/api/git/diff?path=" + encodeURIComponent(gitState.repo) +
      "&file=" + encodeURIComponent(relPath) + (staged ? "&staged=1" : "") +
      (untracked ? "&untracked=1" : "") + (hash ? "&hash=" + encodeURIComponent(hash) : "");
    fetch(url)
      .then(r => r.json())
      .then(d => {
        if (d.error) { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法生成差异：' + esc(d.error) + '</div>'; return; }
        tab.diffText = d.diff || "（没有差异）";
        setDiffToolStat(tab);
        mountDiffTab(tab);
        if (d.truncated) toast("差异内容过大，已截断显示", "warn");
      })
      .catch(e => { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法生成差异：' + esc(e.message || e) + '</div>'; });
  }

  /* ---------- 选择以进行比较：任意两个文件的差异（复用差异标签的渲染） ---------- */
  function openCompareTab(pathA, pathB) {
    const key = pathA + "\u0001cmp\u0001" + pathB;
    let tab = findTab(key);
    if (tab) { activate(tab); return; }
    const host = document.createElement("div");
    host.className = "cm-host diff-host";
    host.innerHTML = '<div class="diff-tools"><span class="dt-label">比较：' +
      esc(baseName(pathA)) + ' ↔ ' + esc(baseName(pathB)) + '</span>' +
      '<button data-view="diff" class="active">差异</button></div><div class="diff-cm"></div>';
    const dw = currentWrap();
    (dw || edGroups).appendChild(host);
    tab = {
      path: key, host, cm: null, original: "", dirty: false, group: curGroup,
      name: baseName(pathA) + " ↔ " + baseName(pathB),
      big: false, diff: true, displayPath: pathB, diffView: "diff",
      relPath: baseName(pathB), cmBox: host.querySelector(".diff-cm"),
      tools: host.querySelector(".diff-tools"),
    };
    tabs.push(tab);
    renderTabsAll();
    activate(tab);   // 统一激活（成功后 mountDiffTab 会再激活一次，幂等）
    tab.cmBox.innerHTML = '<div style="padding:30px;color:#888;">正在比较…</div>';
    fetch("/api/git/diff-files?a=" + encodeURIComponent(pathA) + "&b=" + encodeURIComponent(pathB))
      .then(r => r.json())
      .then(d => {
        if (d.error) { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法比较：' + esc(d.error) + '</div>'; return; }
        tab.diffText = d.empty ? "两个文件内容相同。" : d.diff;
        setDiffToolStat(tab);
        mountDiffTab(tab);
        if (d.truncated) toast("差异内容过大，已截断显示", "warn");
      })
      .catch(e => { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法比较：' + esc(e.message || e) + '</div>'; });
  }

  /* ---------- 打开更改：在一个标签页中汇总查看多个变更文件的差异 ----------
     复用单文件差异的渲染管线（mountSplitDiff）：每个文件块用一个轻量上下文
     {cmBox, relPath, diffText, diffView} 渲染，因此配色 / 折叠未更改区域 /
     语法高亮 / 行内词级高亮与逐个打开文件时的差异视图完全一致。 */
  const ALL_DIFF_ICON = '<i class="bi bi-file-diff" style="color:#e2a03f"></i>';

  function openAllChangesTab() {
    if (!gitState.isRepo) { toast("当前不是 Git 仓库", "warn"); return null; }
    const key = gitState.repo + "\u0001diff-all";
    const exist = findTab(key);
    if (exist) { activate(exist); loadAllChanges(exist); return exist; }

    const host = document.createElement("div");
    host.className = "cm-host diff-host";
    host.innerHTML =
      '<div class="diff-tools ad-tools"><span class="dt-label">Git: 更改</span>' +
      '<button class="ad-expand">全部展开</button>' +
      '<button class="ad-collapse">全部折叠</button>' +
      '<button class="ad-reload" title="重新加载所有变更"><i class="bi bi-arrow-clockwise"></i></button>' +
      '<span class="ad-count"></span></div><div class="diff-cm all-diff-body"></div>';
    const dw = currentWrap();
    (dw || edGroups).appendChild(host);
    const tab = {
      path: key, host, cm: null, original: "", dirty: false, group: curGroup,
      name: "更改", big: false, diff: true, allDiff: true, diffView: "diff",
      displayPath: gitState.repo, relPath: "", iconHtml: ALL_DIFF_ICON,
      cmBox: host.querySelector(".all-diff-body"),
      tools: host.querySelector(".diff-tools"),
    };
    tabs.push(tab);
    renderTabsAll();
    activate(tab);   // 走统一激活：标签高亮 + active 状态 + 面包屑（此前只加 host.active，标签条不高亮）
    tab.tools.querySelector(".ad-expand").onclick = (e) => { e.stopPropagation(); setAllChangesCollapsed(tab, false); };
    tab.tools.querySelector(".ad-collapse").onclick = (e) => { e.stopPropagation(); setAllChangesCollapsed(tab, true); };
    tab.tools.querySelector(".ad-reload").onclick = (e) => { e.stopPropagation(); loadAllChanges(tab); };
    loadAllChanges(tab);
    return tab;
  }

  function loadAllChanges(tab) {
    if (!tab || !tab.allDiff) return;
    tab.cmBox.innerHTML = '<div class="ad-loading">正在收集变更…</div>';
    const seq = (tab._loadSeq = (tab._loadSeq || 0) + 1);
    fetch("/api/git/all-diff?path=" + encodeURIComponent(gitState.repo))
      .then(r => r.text().then(body => ({
        ok: r.ok,
        isJson: (r.headers.get("Content-Type") || "").indexOf("json") >= 0,
        body: body,
      })))
      .then(res => {
        let d = null;
        if (res.ok && res.isJson) { try { d = JSON.parse(res.body); } catch (_) { d = null; } }
        if (seq !== tab._loadSeq) return;             // 已有更新的请求，丢弃旧结果
        // 旧版后端没有聚合接口（请求返回 404 的 HTML 页面）：退回逐个文件取差异，功能照常可用
        if (!d) { loadAllChangesPerFile(tab, seq); return; }
        if (d.error) { tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法打开更改：' + esc(d.error) + '</div>'; return; }
        renderAllChanges(tab, d);
      })
      .catch(e => {
        if (seq !== tab._loadSeq) return;
        tab.cmBox.innerHTML = '<div style="padding:30px;color:#c66;">无法打开更改：' + esc(e.message || e) + '</div>';
      });
  }

  /* 统计 unified diff 的增删行数（跳过 +++/--- 文件头） */
  function countDiffLines(text) {
    let adds = 0, dels = 0;
    String(text || "").split("\n").forEach(line => {
      if (line.startsWith("+++") || line.startsWith("---")) return;
      if (line.charAt(0) === "+") adds++;
      else if (line.charAt(0) === "-") dels++;
    });
    return { adds: adds, dels: dels };
  }

  /* 兜底路径：后端没有 /api/git/all-diff 时，按当前状态逐个文件请求 /api/git/diff 再汇总 */
  function loadAllChangesPerFile(tab, seq) {
    const st = gitState.last || {};
    const list = [];
    (st.staged || []).forEach(f => list.push({ path: f.path, status: f.status, staged: true, untracked: false }));
    (st.changed || []).forEach(f => list.push({ path: f.path, status: f.status, staged: false, untracked: false }));
    (st.untracked || []).forEach(f => list.push({ path: f.path, status: "U", staged: false, untracked: true }));
    if (!list.length) { renderAllChanges(tab, { files: [], counts: {} }); return; }
    Promise.all(list.map(f => {
      const url = "/api/git/diff?path=" + encodeURIComponent(gitState.repo) +
        "&file=" + encodeURIComponent(f.path) + (f.staged ? "&staged=1" : "") +
        (f.untracked ? "&untracked=1" : "");
      return fetch(url).then(r => r.json()).then(d => ({ f: f, diff: d.diff || "" }))
        .catch(() => ({ f: f, diff: "" }));
    })).then(items => {
      if (seq !== tab._loadSeq) return;
      let ins = 0, del = 0;
      const files = items.map(it => {
        const c = countDiffLines(it.diff);
        ins += c.adds; del += c.dels;
        return { path: it.f.path, status: it.f.status, staged: it.f.staged,
                 untracked: it.f.untracked, diff: it.diff, additions: c.adds, deletions: c.dels };
      });
      renderAllChanges(tab, { ok: true, files: files,
        counts: { files: files.length, insertions: ins, deletions: del } });
    });
  }

  function renderAllChanges(tab, d) {
    const files = d.files || [];
    const counts = d.counts || {};
    // 标签名带上文件数，与 VS Code 的「Git: 更改 (N 个文件)」一致
    tab.name = files.length ? "更改 (" + files.length + " 个文件)" : "更改";
    if (tab.el) { const nm = tab.el.querySelector(".t-nm"); if (nm) nm.textContent = tab.name; }
    const cnt = tab.tools.querySelector(".ad-count");
    if (cnt) {
      cnt.innerHTML = files.length
        ? files.length + " 个文件" +
          (counts.insertions ? ' <span class="ad-add">+' + counts.insertions + "</span>" : "") +
          (counts.deletions ? ' <span class="ad-del">−' + counts.deletions + "</span>" : "")
        : "";
    }
    const box = tab.cmBox;
    box.innerHTML = "";
    tab.allBlocks = [];
    if (!files.length) {
      box.innerHTML = '<div class="ad-loading">没有检测到更改。</div>';
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "ad-wrap";
    files.forEach(f => wrap.appendChild(allChangeFileBlock(tab, f)));
    box.appendChild(wrap);
    if (d.truncated) toast("变更内容较多，已截断显示", "warn");
  }

  function allChangeFileBlock(tab, f) {
    const name = baseName(f.path);
    const dir = f.path.indexOf("/") >= 0 ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
    const sec = document.createElement("div");
    sec.className = "ad-file";
    const head = document.createElement("div");
    head.className = "ad-file-head";
    head.innerHTML =
      '<i class="bi bi-chevron-down ad-tw"></i>' +
      '<span class="ic">' + iconFor(name, false) + '</span>' +
      '<span class="ad-name">' + esc(name) + '</span>' +
      (dir ? '<span class="ad-dir">' + esc(dir) + '</span>' : "") +
      (f.staged ? '<span class="ad-tag staged">已暂存</span>'
                : (f.untracked ? '<span class="ad-tag new">新文件</span>' : "")) +
      '<span class="ad-stat">' +
        (f.additions ? '<span class="ad-add">+' + f.additions + "</span> " : "") +
        (f.deletions ? '<span class="ad-del">−' + f.deletions + "</span>" : "") +
      '</span>' +
      '<span class="ad-open" title="在单独标签页中打开"><i class="bi bi-box-arrow-up-right"></i></span>';
    const body = document.createElement("div");
    body.className = "ad-file-body";
    sec.appendChild(head);
    sec.appendChild(body);
    head.onclick = (e) => {
      // 点右侧「在单独标签页中打开」时，打开该文件的独立差异标签
      if (e.target.closest(".ad-open")) { e.stopPropagation(); openDiffTab(f.path, f.staged, f.untracked); return; }
      const collapsed = sec.classList.toggle("collapsed");
      head.querySelector(".ad-tw").className = "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " ad-tw";
    };
    tab.allBlocks.push({ sec: sec, head: head });
    if (!f.diff || !f.diff.trim()) {
      body.innerHTML = '<div class="ad-loading">（没有差异）</div>';
      return sec;
    }
    try {
      mountSplitDiff({ cmBox: body, relPath: f.path, untracked: f.untracked,
                       diffText: f.diff, diffView: "diff" });
    } catch (e) {
      body.innerHTML = '<div class="ad-loading">无法生成差异：' + esc(e.message || e) + "</div>";
    }
    return sec;
  }

  function setAllChangesCollapsed(tab, collapsed) {
    (tab.allBlocks || []).forEach(b => {
      b.sec.classList.toggle("collapsed", collapsed);
      b.head.querySelector(".ad-tw").className = "bi " + (collapsed ? "bi-chevron-right" : "bi-chevron-down") + " ad-tw";
    });
  }

  /* Git 状态变化后（暂存 / 取消暂存 / 放弃 / 提交等），自动刷新已打开的汇总标签页 */
  let _allDiffReloadTimer = 0;
  function scheduleReloadAllChanges() {
    const tab = tabs.find(t => t.allDiff);
    if (!tab || !tab.cmBox) return;
    clearTimeout(_allDiffReloadTimer);
    _allDiffReloadTimer = setTimeout(() => loadAllChanges(tab), 150);
  }

  /* ---------- 打开时间线：该文件的提交历史（点击条目看那次改动） ---------- */
  async function openFileTimeline(path, name) {
    if (!gitState.isRepo) { toast("当前目录不是 Git 仓库，无法查看时间线", "warn"); return; }
    const rel = relPathOf(path);
    let commits = [];
    try {
      const r = await fetch("/api/git/file-log?path=" + encodeURIComponent(gitState.repo) +
                            "&file=" + encodeURIComponent(rel) + "&limit=40");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      commits = d.commits || [];
    } catch (e) { toast("读取历史失败：" + (e.message || e), "err"); return; }

    const html = commits.length
      ? '<div class="timeline">' + commits.map(c =>
          '<div class="tl-item" data-hash="' + esc(c.hash) + '">' +
            '<span class="tl-dot"></span><div class="tl-main">' +
            '<div class="tl-sub">' + esc(c.subject) + '</div>' +
            '<div class="tl-meta">' + esc(c.author) + " · " + esc(c.date) + " · " + esc(c.short) + '</div>' +
          '</div></div>').join("") + "</div>"
      : '<div class="m-msg">没有找到该文件的提交记录（可能还未提交过）。</div>';
    uiModal({ title: "时间线 — " + name, icon: "bi-clock-history", html, wide: true, hideCancel: true, okText: "关闭" });
    document.querySelectorAll("#modalOverlay .tl-item").forEach(el => {
      el.onclick = () => {
        const h = el.dataset.hash;
        $("umOk").click();                 // 关掉弹窗（走统一关闭逻辑，避免遗留 Promise）
        openDiffTab(rel, false, false, h); // 复用 Git 差异标签查看这次提交的改动
      };
    });
  }

  // 按恢复的视图模式同步切换按钮初始图标（list 显示"切到树形"图标，反之亦然）
  (() => {
    const tg = $("gitViewToggle");
    tg.innerHTML = '<i class="bi ' + (gitViewMode === "tree" ? "bi-list-ul" : "bi-diagram-3") + '"></i>';
    tg.title = gitViewMode === "tree" ? "切换到列表视图" : "切换到树形视图";
  })();
  $("gitViewToggle").onclick = () => {
    gitViewMode = gitViewMode === "tree" ? "list" : "tree";
    ideSettingSet("gitViewMode", gitViewMode);   // 写入全局设置 JSON，永久记住
    $("gitViewToggle").innerHTML = '<i class="bi ' + (gitViewMode === "tree" ? "bi-list-ul" : "bi-diagram-3") + '"></i>';
    $("gitViewToggle").title = gitViewMode === "tree" ? "切换到列表视图" : "切换到树形视图";
    if (gitState.isRepo && gitState.last) renderGitStatus(gitState.last);
  };
  $("gitRefresh").onclick = () => loadGitStatus(true);
  $("gitStageAll").onclick = () => {
    if (!gitState.isRepo) { toast("当前不是 Git 仓库", "warn"); return; }
    gitPost("/api/git/stage", { repo: gitState.repo, all: true }, "已暂存所有更改");
  };
  /* 提交模式：commit=提交 / amend=提交(修改上次) / push=提交并推送 / sync=提交并同步(拉取+推送) */
  let gitCommitMode = "commit";
  const COMMIT_MODES = [
    { id: "commit", label: "提交" },
    { id: "amend", label: "提交（修改）" },
    { id: "push", label: "提交和推送" },
    { id: "sync", label: "提交和同步" },
  ];
  const commitModeLabel = (id) => (COMMIT_MODES.find(m => m.id === id) || COMMIT_MODES[0]).label;
  function updateCommitBtnLabel() { $("gitCommitBtnLabel").textContent = commitModeLabel(gitCommitMode); }
  function doGitCommit(mode) {
    mode = mode || gitCommitMode;
    if (!gitState.isRepo) { toast("当前不是 Git 仓库", "warn"); return; }
    const msg = $("gitCommitMsg").value.trim();
    const amend = mode === "amend";
    if (!msg && !amend) { toast("请填写提交信息", "warn"); return; }   // amend 留空 = 沿用上次信息
    const d = gitState.last || {};
    const hasStaged = (d.staged || []).length > 0;
    const hasChanged = (d.changed || []).length > 0;
    const hasUntracked = (d.untracked || []).length > 0;
    if (!hasStaged && !amend) {
      if (hasUntracked) {
        toast("没有已暂存的文件。请先在下方文件右侧点击 + 暂存，或点击分组标题右侧的 + 暂存全部，然后再提交。", "warn");
      } else if (hasChanged) {
        toast("存在未暂存的已跟踪改动。请先暂存文件后再提交。", "warn");
      } else {
        toast("没有要提交的更改。", "warn");
      }
      return;
    }
    gitPost("/api/git/commit", { repo: gitState.repo, message: msg, amend: amend },
        commitModeLabel(mode) + "成功")
      .then(ok => {
        if (!ok) return;
        $("gitCommitMsg").value = "";
        gitAutoGrowMsg();                              // 清空后收回单行高度
        refreshTree(ROOT);
        if (mode === "push") remoteOp("push", "推送");
        if (mode === "sync") remoteOp("pull", "拉取", () => remoteOp("push", "推送"));
      });
  }
  /* 提交按钮下拉菜单（VS Code 式拆分按钮） */
  function showCommitMenu(anchor) {
    let menu = $("gitCommitMenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "ctx-menu";
      menu.id = "gitCommitMenu";
      document.body.appendChild(menu);
      document.addEventListener("click", () => { menu.style.display = "none"; });
    }
    menu.innerHTML = "";
    COMMIT_MODES.forEach(m => {
      const el = document.createElement("div");
      el.className = "mi";
      el.innerHTML = '<span style="width:14px;display:inline-block">' + (m.id === gitCommitMode ? "✓" : "") + "</span><span>" + m.label + "</span>";
      el.onclick = (e) => { e.stopPropagation(); menu.style.display = "none"; gitCommitMode = m.id; updateCommitBtnLabel(); doGitCommit(m.id); };
      menu.appendChild(el);
    });
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 180) + "px";
    menu.style.top = "";
    menu.style.bottom = "";
    menu.style.display = "block";
    const mh = menu.offsetHeight || 120;
    if (r.bottom + 2 + mh > window.innerHeight - 4) menu.style.bottom = (window.innerHeight - r.top + 2) + "px";
    else menu.style.top = (r.bottom + 2) + "px";
  }
  $("gitCommitBtn").onclick = () => doGitCommit();
  $("gitCommitMore").onclick = (e) => {
    e.stopPropagation();
    const menu = $("gitCommitMenu");
    if (menu && menu.style.display === "block") { menu.style.display = "none"; return; }  // 再点一次箭头收起
    showCommitMenu(e.currentTarget);
  };
  $("gitCommitMsg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doGitCommit(); }
  });
  /* 提交框随内容自增高（约 1~5 行），AI 生成的多行提交信息能完整显示 */
  function gitAutoGrowMsg() {
    const el = $("gitCommitMsg");
    if (!el) return;
    if (!el.value) { el.style.height = "30px"; return; }
    el.style.height = "auto";
    el.style.height = Math.max(30, Math.min(el.scrollHeight, 132)) + "px";
  }
  $("gitCommitMsg").addEventListener("input", gitAutoGrowMsg);
  /* ---------- AI 生成提交内容（提交框右侧按钮 / Ctrl+Alt+G） ---------- */
  let gitGenRunning = false;
  function gitGenBusy(busy) {
    const box = document.querySelector(".g-ai-split");
    if (box) box.classList.toggle("busy", !!busy);
    const b = $("gitGenMsg");
    if (b) b.disabled = !!busy;
  }
  async function gitGenerateCommitMsg() {
    if (!gitState.isRepo) { toast("当前不是 Git 仓库", "warn"); return; }
    if (gitGenRunning) return;                       // 防止连点重复请求
    gitGenRunning = true;
    gitGenBusy(true);
    const btn = $("gitGenMsg");
    if (btn) btn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
    try {
      const r = await fetch("/api/ai/commit-message", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: gitState.repo }),
      });
      const isJson = (r.headers.get("Content-Type") || "").indexOf("json") >= 0;
      const d = isJson ? await r.json().catch(() => ({})) : {};
      if (!r.ok || d.error) {
        if (d.need_config) {                         // 未配置接口：引导去设置
          const ok = await uiConfirm("需要配置 AI 接口", d.error + "\n\n现在打开「设置 → 系统 AI」吗？", "打开设置", false);
          if (ok) aiOpenSettings("sec-sysai");
          return;
        }
        if (!isJson) throw new Error("服务端接口不可用（可能仍是旧版本），请重启服务后重试");
        throw new Error(d.error || ("HTTP " + r.status));
      }
      $("gitCommitMsg").value = d.message || "";
      gitAutoGrowMsg();                              // 多行提交信息：输入框自动长高
      $("gitCommitMsg").focus();
      toast("已生成提交内容（" + (d.model || "AI") + " · " + (d.files || 0) + " 个文件），可继续编辑", "ok");
    } catch (e) {
      toast("生成失败：" + (e.message || e), "err");
    } finally {
      gitGenRunning = false;
      gitGenBusy(false);
      if (btn) btn.innerHTML = '<i class="bi bi-stars"></i>';
    }
  }
  /* 生成按钮右侧的小箭头：更多生成相关操作 */
  function showGenMsgMenu(anchor) {
    let menu = $("gitGenMenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "ctx-menu";
      menu.id = "gitGenMenu";
      document.body.appendChild(menu);
      document.addEventListener("click", () => { menu.style.display = "none"; });
    }
    const items = [
      { label: "生成提交内容", act: () => gitGenerateCommitMsg() },
      { label: "配置 AI 接口…", act: () => aiOpenSettings("sec-sysai") },
    ];
    menu.innerHTML = "";
    items.forEach(it => {
      const el = document.createElement("div");
      el.className = "mi";
      el.innerHTML = "<span>" + it.label + "</span>";
      el.onclick = (e) => { e.stopPropagation(); menu.style.display = "none"; it.act(); };
      menu.appendChild(el);
    });
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
    menu.style.top = "";
    menu.style.bottom = "";
    menu.style.display = "block";
    const mh = menu.offsetHeight || 60;
    if (r.bottom + 2 + mh > window.innerHeight - 4) menu.style.bottom = (window.innerHeight - r.top + 2) + "px";
    else menu.style.top = (r.bottom + 2) + "px";
  }
  $("gitGenMsg").onclick = () => gitGenerateCommitMsg();
  $("gitGenMsgMore").onclick = (e) => {
    e.stopPropagation();
    const menu = $("gitGenMenu");
    if (menu && menu.style.display === "block") { menu.style.display = "none"; return; }
    showGenMsgMenu(e.currentTarget);
  };
  $("sbBranch").onclick = () => { showPanel("git"); loadGitStatus(); };

