  /* ================================================================
     后台变更自动刷新（资源管理器文件树 / 源代码管理 Git）
     - 文件树：轮询「根目录 + 当前已展开目录」的列表签名，签名变化才重建树
       （未展开的目录内容本来就不显示，展开时会重新拉取，无需轮询）
     - Git：轮询 /api/git/status，与上次结果不同才调用 loadGitStatus() 重渲染，
       避免「更改」汇总标签页被无谓刷新
     - 浏览器标签页隐藏时暂停；侧栏折叠时跳过文件树轮询；上一轮未完成则跳过
     ================================================================ */
  (function () {
    const AUTO_REFRESH_MS = 5000;
    let treeSig = null;        // null = 尚未初始化（首次只记录签名，不触发刷新）
    let gitSig = null;
    let polling = false;

    async function fetchJson(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }

    async function pollTree() {
      if (!ROOT) return;
      const sb = $("sidebar");
      if (sb && sb.classList.contains("collapsed")) return;
      const rootKids = explorerPanel.querySelector(".tree-children");
      if (!rootKids) return;
      // 根目录 + 所有已展开目录：这些位置的变更对用户可见，才需要自动刷新
      const bases = new Set([ROOT]);
      explorerPanel.querySelectorAll(".tree-children.open").forEach(k => {
        if (k._loaded && k._base) bases.add(k._base);
      });
      const parts = [];
      for (const base of bases) {
        const d = await fetchJson("/api/files?path=" + encodeURIComponent(base) + (showHidden ? "&hidden=1" : ""));
        const items = (d.items || [])
          .filter(it => showAllFiles || !TREE_IGNORE.has(it.name))
          .map(it => [it.name, it.is_dir ? 1 : 0, it.mtime, it.size]);
        parts.push(base + "::" + JSON.stringify(items));
      }
      const sig = parts.join("\n");
      if (treeSig !== null && sig !== treeSig && typeof refreshTree === "function") {
        await refreshTree();     // refreshTree 会保留展开目录、选中项与滚动位置
      }
      treeSig = sig;
    }

    async function pollGit() {
      if (!ROOT || typeof loadGitStatus !== "function") return;
      const d = await fetchJson("/api/git/status?path=" + encodeURIComponent(ROOT));
      const sig = JSON.stringify(d);
      if (gitSig !== null && sig !== gitSig) loadGitStatus();
      gitSig = sig;
    }

    setInterval(async () => {
      if (polling || document.hidden) return;
      polling = true;
      try { await pollTree(); } catch (_) {}
      try { await pollGit(); } catch (_) {}
      polling = false;
    }, AUTO_REFRESH_MS);
  })();
