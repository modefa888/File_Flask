/* ================================================================
   后台变更自动刷新（资源管理器文件树 / 源代码管理 Git）
   - 文件树：轮询「根目录 + 当前已展开目录」的条目【结构】签名
     （名称 + 是否目录；不含 mtime/size）。只有【上一轮已在监视中的目录】
     内发生增删/改名才重建树。
     · 用户新展开一个目录 ⇒ 只是把它加入监视，不触发重建
       （此前把"展开集合变化"也计入签名，导致刚点开的文件夹在下一轮
        轮询里被整树重绘，看起来像自己折叠了 —— 即"抖动"）。
     · 忽略 mtime/size ⇒ logs / __pycache__ / 数据库等高频写盘的目录
       不再每隔几秒无谓重建整棵树。
   - 用户点击/展开后短暂静默，绝不打断刚打开的状态。
   - Git：轮询 /api/git/status，与上次结果不同才重渲染。
   - 浏览器标签页隐藏时暂停；侧栏折叠时跳过文件树轮询；上一轮未完成则跳过。
   ================================================================ */
(function () {
  const AUTO_REFRESH_MS = 5000;
  const QUIET_MS = 2000;      // 用户操作后的静默窗口
  const sigMap = new Map();   // base 路径 → 该目录的条目结构签名
  let gitSig = null;          // null = 尚未初始化（首次只记录，不触发刷新）
  let polling = false;
  let lastUserAct = 0;

  // 用户在资源管理器里点/展开/右键后，短暂内不做自动重建，
  // 否则刚点开的文件夹会在下一轮轮询里被整体重绘。
  ["click", "dblclick", "contextmenu"].forEach(t => {
    explorerPanel.addEventListener(t, () => { lastUserAct = Date.now(); }, true);
  });

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // 仅比较目录结构：名称 + 是否目录。忽略 mtime/size，
  // 否则频繁写盘的目录会让树每隔几秒重建一次（抖动）。
  function itemsSig(items) {
    return (items || [])
      .filter(it => showAllFiles || !TREE_IGNORE.has(it.name))
      .map(it => (it.is_dir ? "d:" : "f:") + it.name)
      .sort()
      .join(",");
  }

  async function pollTree() {
    if (!ROOT) return;
    const sb = $("sidebar");
    if (sb && sb.classList.contains("collapsed")) return;
    if (!explorerPanel.querySelector(".tree-children")) return;
    if (Date.now() - lastUserAct < QUIET_MS) return;   // 用户刚操作，本轮跳过

    // 根目录 + 所有已展开目录：这些位置的内容对用户可见
    const bases = new Set([ROOT]);
    explorerPanel.querySelectorAll(".tree-children.open").forEach(k => {
      if (k._loaded && k._base) bases.add(k._base);
    });
    // 已折叠/不再展示的目录从监视表移除（移除本身不算变化）
    for (const b of [...sigMap.keys()]) if (!bases.has(b)) sigMap.delete(b);

    let changed = false;
    for (const base of bases) {
      const d = await fetchJson("/api/files?path=" + encodeURIComponent(base) + (showHidden ? "&hidden=1" : ""));
      const sig = itemsSig(d.items);
      const prev = sigMap.get(base);
      // 只有【之前已在监视中】的目录内容变化才触发重建；
      // 用户新展开的目录只登记签名（展开时已加载最新内容）
      if (prev !== undefined && prev !== sig) changed = true;
      sigMap.set(base, sig);
    }

    if (changed && typeof refreshTree === "function") {
      await refreshTree();     // refreshTree 会保留展开目录、选中项与滚动位置
    }
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
