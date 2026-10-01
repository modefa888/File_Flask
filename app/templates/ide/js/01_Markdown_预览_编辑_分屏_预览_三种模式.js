  /* ==================================================================
     Markdown 预览：编辑 / 分屏 / 预览 三种模式
     - 编辑：纯 CodeMirror
     - 分屏：左编辑右预览，实时刷新 + 滚动同步
     - 预览：整页渲染结果（保留后台编辑器，保存/查找不受影响）
     ================================================================== */
  // 轻量 Markdown 渲染器：先整体转义，代码块/行内代码/图片/链接用占位符
  // 保护起来最后还原，避免渲染结果里混入未转义的 HTML
  function renderMarkdown(src) {
    const stash = [];
    const keep = (h) => { stash.push(h); return "\u0000" + (stash.length - 1) + "\u0000"; };
    let text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    // 围栏代码块先取出，内部不做任何语法处理
    text = text.replace(/```(\w*)[ \t]*\n([\s\S]*?)(?:\n[ \t]*```|$)/g,
      (m, lang, code) => "\n" + keep('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : "") + ">" + esc(code) + "</code></pre>") + "\n");
    text = esc(text);
    // 行内语法（内容均已转义）
    text = text.replace(/`([^`\n]+)`/g, (m, c) => keep("<code>" + c + "</code>"));
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => keep('<img src="' + url.replace(/"/g, "") + '" alt="' + alt + '">'));
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) => keep('<a href="' + url.replace(/"/g, "") + '" target="_blank" rel="noopener">' + t + "</a>"));
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    const lines = text.split("\n");
    const out = [];
    let i = 0;
    const isBlank = (l) => /^\s*$/.test(l);
    const isFence = (l) => /^\u0000\d+\u0000$/.test(l.trim());
    const taskMark = (h) => h.replace(/^\[( |x|X)\]\s+/, (m, c) => '<input type="checkbox" disabled' + (c.toLowerCase() === "x" ? " checked" : "") + "> ");
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      if (isFence(line)) { out.push(line.trim()); i++; continue; }   // 代码块占位
      // 表格：当前行 |...| 且下一行是 |---| 分隔行
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        const heads = cells(line);
        const aligns = cells(lines[i + 1]).map(c => {
          const l = c.startsWith(":"), r = c.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        const al = (k) => aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "";
        let html = "<table><thead><tr>" + heads.map((h, k) => "<th" + al(k) + ">" + h + "</th>").join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const row = cells(lines[i]);
          html += "<tr>" + heads.map((_, k) => "<td" + al(k) + ">" + (row[k] || "") + "</td>").join("") + "</tr>";
          i++;
        }
        out.push(html + "</tbody></table>"); continue;
      }
      let m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) { const n = m[1].length; out.push("<h" + n + ">" + m[2] + "</h" + n + ">"); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*&gt;\s?/.test(line)) {   // esc 后 > 变成 &gt;
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
        out.push("<blockquote>" + buf.join("<br>") + "</blockquote>"); continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        let html = ordered ? "<ol>" : "<ul>";
        while (i < lines.length && re.test(lines[i])) { html += "<li>" + taskMark(lines[i].replace(re, "$1")) + "</li>"; i++; }
        out.push(html + (ordered ? "</ol>" : "</ul>")); continue;
      }
      // 普通段落：连续非空行合并，行间 <br>
      const buf = [line]; i++;
      while (i < lines.length && !isBlank(lines[i]) && !isFence(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*&gt;/.test(lines[i]) &&
             !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push("<p>" + buf.join("<br>") + "</p>");
    }
    // 还原受保护片段（代码块 / 行内代码 / 图片 / 链接）
    return out.join("\n").replace(/\u0000(\d+)\u0000/g, (m, k) => stash[+k]);
  }

  // 文件原始内容服务地址（HTML 预览的资源基址，逐段编码保证中文/空格可用）
  function rawFileUrl(p) { return "/api/raw" + p.split("/").map(encodeURIComponent).join("/"); }

  // 把可预览标签页改造成 编辑/预览 双面板结构（CodeMirror 移入左侧面板）
  function setupPreviewTab(tab, previewEl, openHref) {
    const host = tab.host;
    const cmEl = host.querySelector(".CodeMirror");
    if (!cmEl) return;
    const wrap = document.createElement("div");
    wrap.className = "md-wrap mode-edit";
    const body = document.createElement("div");
    body.className = "md-body";
    const editPane = document.createElement("div");
    editPane.className = "md-edit";
    editPane.appendChild(cmEl);
    body.appendChild(editPane); body.appendChild(previewEl);
    wrap.appendChild(body);
    const tb = document.createElement("div");
    tb.className = "md-toolbar";
    tb.innerHTML =
      '<button data-m="edit" class="active" title="编辑模式"><i class="bi bi-pencil"></i>编辑</button>' +
      '<button data-m="split" title="分屏：左编辑右预览，实时同步 (Ctrl+Shift+M)"><i class="bi bi-layout-split"></i>分屏</button>' +
      '<button data-m="preview" title="预览模式 (Ctrl+Shift+V)"><i class="bi bi-eye"></i>预览</button>' +
      (openHref ? '<span class="md-tb-sep"></span><a href="' + openHref + '" target="_blank" rel="noopener" title="在新标签页打开（本机用，含路径）"><i class="bi bi-box-arrow-up-right"></i></a>' : "") +
      '<span class="md-tb-sep"></span>' +
      '<button class="md-share" title="复制分享链接：随机短链，不暴露服务器路径"><i class="bi bi-share"></i>分享</button>';
    tb.querySelectorAll("button").forEach(b => {
      b.addEventListener("mousedown", (e) => e.preventDefault());   // 不抢编辑器焦点
      if (b.dataset.m) b.addEventListener("click", () => setMdMode(tab, b.dataset.m));
    });
    const shareBtn = tb.querySelector(".md-share");
    if (shareBtn) shareBtn.addEventListener("click", async () => {
      try {
        const r = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: tab.path }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        await copyText(location.origin + d.url);
        toast("分享链接已复制（" + (d.name || "文件") + "）", "ok");
      } catch (e) {
        toast("分享失败：" + (e.message || e), "err");
      }
    });
    wrap.appendChild(tb);
    host.appendChild(wrap);
    tab.mdWrap = wrap; tab.mdPreview = previewEl; tab.mdMode = "edit";
    // 分屏下编辑器滚动 → 预览按比例跟随
    tab.cm.on("scroll", () => {
      if (tab.mdMode !== "split" || !tab.mdPreview) return;
      const info = tab.cm.getScrollInfo();
      const max = info.height - info.clientHeight;
      const pmax = tab.mdPreview.scrollHeight - tab.mdPreview.clientHeight;
      if (max > 0 && pmax > 0) tab.mdPreview.scrollTop = (info.top / max) * pmax;
    });
  }
  function setupMarkdownView(tab) {
    const preview = document.createElement("div");
    preview.className = "md-preview scroll-thin";
    setupPreviewTab(tab, preview, rawFileUrl(tab.path));
  }
  function setupHtmlView(tab) {
    const preview = document.createElement("div");
    preview.className = "md-preview raw";
    const frame = document.createElement("iframe");
    frame.className = "md-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-same-origin allow-modals");
    preview.appendChild(frame);
    setupPreviewTab(tab, preview, rawFileUrl(tab.path));
    tab.mdFrame = frame;
  }
  // .gitignore：浮动工具栏，点击弹出项目文件/文件夹选择器，自动插入忽略规则
  function setupGitignoreView(tab) {
    if (tab.host.querySelector(".gitignore-toolbar")) return;
    const tb = document.createElement("div");
    tb.className = "gitignore-toolbar";
    tb.innerHTML = '<button title="选择项目中的文件/文件夹，自动插入到 .gitignore"><i class="bi bi-folder-plus"></i>添加忽略路径</button>';
    const btn = tb.querySelector("button");
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => showGitignorePicker(tab));
    tab.host.appendChild(tb);
  }

  /* requirements.txt：检测当前独立 venv 中哪些包已安装，在编辑器内显示并支持一键安装 */
  function setupRequirementsView(tab) {
    if (tab.host.querySelector(".req-toolbar")) return;

    // 添加自定义 gutter（保留原有行号）
    tab.cm.setOption("gutters", ["CodeMirror-linenumbers", "pip-status-gutter"]);
    tab.cm.refresh();

    const tb = document.createElement("div");
    tb.className = "req-toolbar";
    tb.innerHTML = '<span class="status"><i class="bi bi-info-circle"></i><span class="t">准备检测…</span></span>' +
      '<select class="index-select" title="安装时使用的 PyPI 镜像源">' +
      '<option value="">默认源</option>' +
      '<option value="tsinghua">清华</option>' +
      '<option value="aliyun">阿里云</option>' +
      '<option value="douban">豆瓣</option>' +
      '<option value="ustc">中科大</option>' +
      '<option value="tencent">腾讯</option>' +
      '<option value="huawei">华为</option>' +
      '<option value="pypi">PyPI 官方</option>' +
      '</select>' +
      '<button class="refresh" title="重新检测"><i class="bi bi-arrow-clockwise"></i>刷新</button>' +
      '<button class="install" title="安装所有缺失包" disabled><i class="bi bi-box-arrow-in-down"></i>一键安装缺失</button>';
    tab.host.appendChild(tb);

    tab.reqState = { checking: false, items: [], venv: null, error: null };

    const statusEl = tb.querySelector(".status");
    const textEl = tb.querySelector(".status .t");
    const indexSelect = tb.querySelector(".index-select");
    const refreshBtn = tb.querySelector("button.refresh");
    const installBtn = tb.querySelector("button.install");

    const savedIndex = localStorage.getItem("cb-pip-index");
    if (savedIndex && indexSelect.querySelector('option[value="' + savedIndex + '"]')) {
      indexSelect.value = savedIndex;
    }
    indexSelect.addEventListener("change", () => {
      localStorage.setItem("cb-pip-index", indexSelect.value);
    });

    function setSpin(el, on) {
      if (on) { if (!el.querySelector(".spin")) el.insertBefore(makeSpan('<i class="spin"></i>'), el.firstChild); }
      else { const s = el.querySelector(".spin"); if (s) s.remove(); }
    }

    function makeSpan(html) { const e = document.createElement("span"); e.innerHTML = html; return e; }

    function makeMarker(cls, title, handler) {
      const el = document.createElement("div");
      el.className = "cm-pip-" + cls;
      el.title = title;
      el.innerHTML = cls === "ok" ? "<i class=\"bi bi-check-circle\"></i>" :
                   cls === "miss" ? "<i class=\"bi bi-exclamation-triangle\"></i>" :
                   "<i class=\"bi bi-dot\"></i>";
      if (handler) el.addEventListener("click", handler);
      return el;
    }

    function render() {
      const st = tab.reqState;
      // 清空旧标记
      const last = tab.cm.lineCount();
      for (let i = 0; i < last; i++) tab.cm.setGutterMarker(i, "pip-status-gutter", null);

      if (st.error) {
        statusEl.className = "status err";
        textEl.textContent = st.error;
        installBtn.disabled = true;
        return;
      }
      if (st.checking) {
        statusEl.className = "status";
        textEl.textContent = "检测中…";
        installBtn.disabled = true;
        return;
      }

      const installed = st.items.filter(it => it.type === "req" && it.installed).length;
      const missing = st.items.filter(it => it.type === "req" && !it.installed).length;
      const skip = st.items.filter(it => it.type === "skip").length;
      statusEl.className = "status " + (missing ? "warn" : "ok");
      textEl.textContent = `venv：${baseName(st.venv || "未找到")} · ${installed} 已安装 / ${missing} 未安装` +
        (skip ? ` · ${skip} 行已跳过` : "");
      installBtn.disabled = missing === 0;

      st.items.forEach(it => {
        if (it.type === "skip") {
          tab.cm.setGutterMarker(it.line, "pip-status-gutter",
            makeMarker("skip", "注释 / 空行 / 选项"));
          return;
        }
        if (it.installed) {
          tab.cm.setGutterMarker(it.line, "pip-status-gutter",
            makeMarker("ok", `${it.name}${it.version ? " " + it.version : ""} 已安装`));
        } else {
          tab.cm.setGutterMarker(it.line, "pip-status-gutter",
            makeMarker("miss", `${it.name}${it.spec ? " " + it.spec : ""} 未安装\n点击安装单个包`,
              () => installPackages([it.name])));
        }
      });
    }

    async function check() {
      if (!tab.cm) return;
      tab.reqState.checking = true;
      tab.reqState.error = null;
      render();
      try {
        const r = await fetch("/api/pip/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: tab.path, content: tab.cm.getValue() })
        });
        const raw = await r.text();
        let d;
        try {
          d = JSON.parse(raw);
        } catch (parseErr) {
          if (raw.trim().startsWith("<")) {
            throw new Error("接口返回 HTML，说明后端还没加载新路由，请重启服务后刷新页面");
          }
          throw parseErr;
        }
        tab.reqState.checking = false;
        if (d.error) { tab.reqState.error = d.error; tab.reqState.items = []; tab.reqState.venv = null; }
        else { tab.reqState.items = d.items || []; tab.reqState.venv = d.venv; tab.reqState.error = null; }
      } catch (e) {
        tab.reqState.checking = false;
        tab.reqState.error = "检测失败：" + (e.message || e);
      }
      render();
    }

    async function installPackages(packages, allMissing) {
      if (tab.reqState.installing) return;
      tab.reqState.installing = true;
      installBtn.disabled = true;
      refreshBtn.disabled = true;
      setSpin(installBtn, true);
      const oldHtml = installBtn.innerHTML;
      installBtn.innerHTML = '<i class="spin"></i>安装中…';
      try {
        const body = { path: tab.path, index: indexSelect.value };
        if (allMissing) body.all_missing = true;
        else if (packages && packages.length) body.packages = packages;
        const r = await fetch("/api/pip/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const raw = await r.text();
        let d;
        try {
          d = JSON.parse(raw);
        } catch (parseErr) {
          if (raw.trim().startsWith("<")) {
            throw new Error("接口返回 HTML，请重启服务后刷新页面");
          }
          throw parseErr;
        }
        if (d.ok && d.returncode === 0) toast("安装完成", "ok");
        else toast("安装失败：" + (d.error || d.stderr || "未知错误"), "err");
      } catch (e) {
        toast("安装失败：" + (e.message || e), "err");
      } finally {
        tab.reqState.installing = false;
        installBtn.innerHTML = oldHtml;
        refreshBtn.disabled = false;
        setSpin(installBtn, false);
        render();
        check();
      }
    }

    refreshBtn.addEventListener("click", () => check());
    installBtn.addEventListener("click", () => installPackages(null, true));
    tab.cm.on("change", () => {
      if (tab.reqTimer) clearTimeout(tab.reqTimer);
      tab.reqTimer = setTimeout(() => check(), 800);
    });

    check();
  }

  // 解析 .gitignore 内容为归一化规则列表（去掉注释 / 空行 / 前后斜杠 / 取反规则）
  function parseGitignoreRules(text) {
    return (text || "").split(/\r?\n/).map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && !l.startsWith("!"))
      .map(l => l.replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter(l => l.length > 0);
  }
  // 判断某个文件/目录是否已被现有规则覆盖
  function giRuleMatches(rule, rel, name) {
    if (rule === rel || rule === name) return true;          // 全路径或文件名精确匹配
    if (rule.indexOf("*") >= 0) {                            // 通配符（* 不跨路径段）
      const re = new RegExp("^" + rule.split("*")
        .map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
      if (re.test(rel) || re.test(name)) return true;
    }
    return rel.startsWith(rule + "/");                       // 目录规则覆盖其下所有内容
  }
  async function showGitignorePicker(tab) {
    const selected = new Set();
    const existingRules = parseGitignoreRules(tab.cm ? tab.cm.getValue() : "");
    const tree = document.createElement("div");
    tree.className = "gi-tree";
    const loading = document.createElement("div");
    loading.className = "gi-empty"; loading.textContent = "加载中…";
    tree.appendChild(loading);
    const html = '<div class="gi-picker"><div class="gi-tree"></div><div style="color:#9d9d9d;font-size:12px;">勾选文件或文件夹，点击「插入」后自动写入相对路径；文件夹会自动补 / 后缀。</div></div>';
    const modal = uiModal({
      title: "选择要忽略的文件/文件夹", icon: "bi-folder-plus", html, wide: true,
      okText: "插入", cancelText: "取消"
    });
    const body = document.querySelector("#modalOverlay .ide-modal .m-body");
    if (!body) return;
    body.querySelector(".gi-tree").replaceWith(tree);
    await renderGiTree(tree, ROOT, 0, selected, existingRules);
    const res = await modal;
    if (!res) return;
    if (!selected.size) { toast("未选择任何文件/文件夹", "warn"); return; }
    const rules = Array.from(selected).sort();
    const keep = new Set(rules);
    for (const r of rules) {
      if (!keep.has(r)) continue;
      for (const other of rules) {
        if (r !== other && other.startsWith(r)) keep.delete(other);
      }
    }
    insertAtCursor(tab.cm, Array.from(keep).join("\n") + "\n");
  }
  async function renderGiTree(container, path, depth, selected, existingRules) {
    try {
      const d = await apiFiles(path, true);
      const items = (d.items || [])
        .filter(it => !(path === ROOT && it.name === ".gitignore"))
        .sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, "zh"));
      container.textContent = "";
      if (!items.length) { container.innerHTML = '<div class="gi-empty">空文件夹</div>'; return; }
      for (const it of items) {
        const rel = path === ROOT ? it.name : path.substring(ROOT.length + 1) + "/" + it.name;
        const rule = it.is_dir ? rel + "/" : rel;
        const row = document.createElement("div");
        row.className = "gi-row";
        row.style.paddingLeft = (8 + depth * 18) + "px";
        row.dataset.rel = rule;
        row.dataset.isdir = it.is_dir ? "1" : "0";

        const twist = document.createElement("span");
        twist.className = "gi-tw";
        if (it.is_dir) {
          twist.innerHTML = '<i class="bi bi-chevron-right"></i>';
        }
        row.appendChild(twist);

        const cb = document.createElement("input");
        cb.type = "checkbox";
        row.appendChild(cb);

        const nm = document.createElement("span");
        nm.className = "gi-name";
        nm.textContent = it.name;
        row.appendChild(nm);

        // 已存在于 .gitignore 的规则自动勾选；不计入待插入集合，避免重复写入
        if (existingRules && existingRules.some(r => giRuleMatches(r, rel, it.name))) {
          cb.checked = true;
          const hint = document.createElement("span");
          hint.className = "gi-hint";
          hint.textContent = "已在文件中";
          row.appendChild(hint);
        }

        const update = () => {
          if (cb.checked) selected.add(rule); else selected.delete(rule);
        };
        cb.addEventListener("change", (e) => { e.stopPropagation(); update(); });
        row.addEventListener("click", (e) => {
          if (e.target === cb || e.target.closest("input")) return;
          if (!it.is_dir) { cb.checked = !cb.checked; update(); return; }
          let body = row._body;
          if (!body) {
            body = document.createElement("div");
            body.style.display = "none";
            row._body = body;
            row.after(body);
            renderGiTree(body, path + "/" + it.name, depth + 1, selected, existingRules);
          }
          const open = body.style.display === "none";
          body.style.display = open ? "" : "none";
          const twi = twist.querySelector("i");
          if (twi) twi.className = "bi " + (open ? "bi-chevron-down" : "bi-chevron-right");
        });
        container.appendChild(row);
      }
    } catch (e) {
      container.innerHTML = '<div class="gi-empty">加载失败：' + esc(e.message || e) + "</div>";
    }
  }
  function insertAtCursor(cm, text) {
    if (!cm) return;
    const doc = cm.getDoc();
    const cursor = doc.getCursor();
    doc.replaceRange(text, cursor);
    cm.focus();
  }
  function renderMdPreview(tab) {
    if (!tab.mdPreview || !tab.cm) return;
    tab.mdPreview.innerHTML = renderMarkdown(tab.cm.getValue());
  }
  // 根相对路径（/xxx）在 HTML 预览里怎么解析：
  //   1) 页面所在目录下确实存在同名条目 → 按“站点根 = 页面所在目录”解析（静态站常见约定）
  //   2) 否则保持站点根语义（例如 Flask 项目里的 /static/... 由应用根提供，
  //      若一律改写成 /api/raw/<页面目录>/... 会让所有样式与脚本 404、预览变成裸页面）
  const _previewRootCache = new Map();          // "dir\u0001seg" -> Promise<boolean>
  function previewUseDirAsRoot(dir, seg) {
    const key = dir + "\u0001" + seg;
    if (!_previewRootCache.has(key)) {
      _previewRootCache.set(key,
        fetch("/api/files?path=" + encodeURIComponent(dir))
          .then(r => r.json())
          .then(d => !d.error && (d.items || []).some(x => x.name === seg))
          .catch(() => false));
    }
    return _previewRootCache.get(key);
  }

  // 组装 HTML 预览文档：注入 <base> 指向 raw 服务（相对路径按页面目录解析）；
  // useDir=true 时再把根相对路径 /xxx 也按页面目录改写
  function buildHtmlPreviewDoc(tab, useDir) {
    let src = tab.cm.getValue();
    const dir = tab.path.slice(0, tab.path.lastIndexOf("/")) || "/";
    const base = rawFileUrl(dir) + "/";
    if (useDir) {
      src = src.replace(/(\s(?:href|src|action|poster)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi,
        (m, pre, q, rest) => pre + q + base + rest + q);
    }
    const baseTag = '<base href="' + base + '">';
    if (/<head[^>]*>/i.test(src)) src = src.replace(/<head[^>]*>/i, (m) => m + "\n" + baseTag);
    else src = baseTag + src;
    return src;
  }
  function renderHtmlPreview(tab) {
    if (!tab.mdFrame || !tab.cm) return;
    const src = tab.cm.getValue();
    const dir = tab.path.slice(0, tab.path.lastIndexOf("/")) || "/";
    const m = src.match(/(?:\s(?:href|src|action|poster)\s*=\s*)(["'])\/(?!\/)([^"'?#]*)/i);
    const seg = m ? m[2].split("/")[0] : "";
    const seq = (tab._hpSeq = (tab._hpSeq || 0) + 1);
    const paint = (useDir) => {
      if (seq !== tab._hpSeq || !tab.mdFrame) return;   // 期间已重新刷新 / 标签已关闭
      tab.mdFrame.srcdoc = buildHtmlPreviewDoc(tab, useDir);
    };
    if (!seg) { paint(true); return; }
    previewUseDirAsRoot(dir, seg).then(paint, () => paint(true));
  }
  function renderPreviewNow(tab) {
    if (tab.mdFrame) renderHtmlPreview(tab);
    else if (tab.mdPreview) renderMdPreview(tab);
  }
  function schedulePreviewUpdate(tab) {
    clearTimeout(tab._mdT);
    tab._mdT = setTimeout(() => renderPreviewNow(tab), tab.mdFrame ? 400 : 250);
  }
  function setMdMode(tab, mode) {
    if (!tab.mdWrap) return;
    tab.mdMode = mode;
    tab.mdWrap.classList.remove("mode-edit", "mode-split", "mode-preview");
    tab.mdWrap.classList.add("mode-" + mode);
    tab.mdWrap.querySelectorAll(".md-toolbar button").forEach(b => b.classList.toggle("active", b.dataset.m === mode));
    if (mode !== "edit") renderPreviewNow(tab);
    scheduleRefresh(tab);   // 面板显隐变化后重绘，避免编辑器尺寸错位
  }
  // 菜单 / 快捷键入口：只作用于当前活动的可预览标签
  function mdSetMode(mode) {
    if (!active || !active.mdWrap) { toast("当前标签不支持预览（仅 Markdown / HTML）", "warn"); return; }
    setMdMode(active, mode);
  }
  function mdTogglePreview() {
    if (!active || !active.mdWrap) { toast("当前标签不支持预览（仅 Markdown / HTML）", "warn"); return; }
    setMdMode(active, active.mdMode === "preview" ? "edit" : "preview");
  }

  /* ---------- 面包屑 / 状态栏 ---------- */
  function renderBreadcrumbs(path) {
    const parts = path.split("/").filter(Boolean);
    let acc = "", html = "";
    parts.forEach((p, i) => {
      acc += "/" + p;
      const cur = i === parts.length - 1 ? " cur" : "";
      html += '<span class="bc' + cur + '">' + esc(p) + "</span>";
      if (i < parts.length - 1) html += '<span class="sep">/</span>';
    });
    $("breadcrumbs").innerHTML = html;
    $("sbPath").textContent = baseName(path);
  }
  function updateStatus() {
    if (!active || !active.cm) {
      $("sbPos").textContent = "行 1, 列 1"; $("sbLang").textContent = "纯文本"; return;
    }
    const c = active.cm.getCursor();
    $("sbPos").textContent = "行 " + (c.line + 1) + ", 列 " + (c.ch + 1);
    const ext = getExt(active.name);
    const names = { js: "JavaScript", py: "Python", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", json: "JSON", md: "Markdown", xml: "XML", c: "C", cpp: "C++", h: "C/C++", java: "Java", go: "Go", rs: "Rust", php: "PHP", rb: "Ruby", sh: "Shell", yml: "YAML", sql: "SQL", lua: "Lua" };
    $("sbLang").textContent = names[ext] || (ext ? ext.toUpperCase() : "纯文本");
  }
  function refreshTreeDirty() {
    document.querySelectorAll(".tree-row").forEach(r => {
      const t = findTab(r.dataset.path);
      r.classList.toggle("dirty", !!(t && t.dirty));
    });
  }

