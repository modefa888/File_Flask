  /* ==================================================================
     分享管理：编辑器工具栏「分享」按钮的落地弹层
     - 上半部分：当前文件的分享设置（有效期 / 访问次数 / 密码 / 链接）
     - 下半部分：分享记录管理（查看全部记录、复制、打开、改设置、取消、删除）
     须放在 16_ 之前加载（同属 00_preamble 的大 IIFE），才能复用闭包内的
     $ / esc / escAttr / toast / copyText。
     ================================================================== */
  const _SHM_STATE_TEXT = { ok: "有效", expired: "已过期", exhausted: "次数已用完", revoked: "已取消" };
  let _shmOverlay = null;
  let _shmFile = "";            // 当前文件绝对路径（弹层上方设置区绑定它）
  let _shmCur = null;           // 当前文件对应的分享记录
  let _shmPickId = null;        // 手动从列表「设置」选中的记录 id
  let _shmFilter = "active";    // 列表筛选：active(有效) / all(含已失效)
  let _shmAll = [];             // 最近一次拉取到的全部记录

  function _shmStateText(state) { return _SHM_STATE_TEXT[state] || "有效"; }

  async function _shmLoad(includeRevoked) {
    try {
      const r = await fetch("/api/shares" + (includeRevoked ? "?include_revoked=1" : ""));
      const d = await r.json();
      return d.items || [];
    } catch (e) { return []; }
  }

  /* ---------- 入口：打开分享管理弹层 ---------- */
  function openShareManager(filePath) {
    if (typeof filePath === "string" && filePath) _shmFile = filePath;
    _shmPickId = null;
    if (_shmOverlay) { _shmOverlay.remove(); _shmOverlay = null; }

    const hasFile = !!_shmFile;
    const fileName = hasFile ? (_shmFile.split("/").pop() || _shmFile) : "";
    const ov = document.createElement("div");
    ov.className = "shm-overlay";
    ov.innerHTML =
      '<div class="shm-panel" role="dialog" aria-label="分享管理">' +
        '<div class="shm-head">' +
          '<span class="shm-title"><i class="bi bi-share"></i> 分享管理</span>' +
          '<span class="shm-count" id="shmCount"></span>' +
          '<span class="shm-flex"></span>' +
          '<button class="shm-icon-btn" id="shmRefreshBtn" title="刷新记录"><i class="bi bi-arrow-clockwise"></i></button>' +
          '<button class="shm-icon-btn" id="shmCloseBtn" title="关闭"><i class="bi bi-x-lg"></i></button>' +
        '</div>' +
        '<div class="shm-body">' +
          (hasFile
            ? '<div class="shm-section">' +
                '<div class="shm-sec-title"><i class="bi bi-file-earmark"></i> 当前文件分享' +
                  '<span class="shm-state-badge" id="shmCurState" style="display:none"></span></div>' +
                '<div class="shm-file-row"><i class="bi bi-file-earmark-text"></i>' +
                  '<span class="shm-file-name" title="' + escAttr(_shmFile) + '">' + esc(fileName) + '</span></div>' +
                '<div class="shm-field"><label>分享链接</label>' +
                  '<div class="shm-link-row">' +
                    '<input type="text" class="shm-link" id="shmLink" readonly placeholder="尚未创建分享，点下方按钮生成">' +
                    '<button class="shm-btn ghost" id="shmCopyBtn" title="复制链接"><i class="bi bi-clipboard"></i></button>' +
                    '<button class="shm-btn ghost" id="shmOpenBtn" title="打开链接"><i class="bi bi-box-arrow-up-right"></i></button>' +
                  '</div>' +
                '</div>' +
                '<div class="shm-grid">' +
                  '<div class="shm-field"><label>有效期</label>' +
                    '<select id="shmExpire">' +
                      '<option value="forever">永久有效</option>' +
                      '<option value="1h">1 小时</option>' +
                      '<option value="1d">1 天</option>' +
                      '<option value="7d">7 天</option>' +
                      '<option value="30d">30 天</option>' +
                    '</select>' +
                  '</div>' +
                  '<div class="shm-field"><label>访问次数上限</label>' +
                    '<input type="number" id="shmMaxViews" min="0" step="1" placeholder="0 = 不限">' +
                  '</div>' +
                '</div>' +
                '<div class="shm-field"><label>访问密码（可选）</label>' +
                  '<input type="text" id="shmPassword" placeholder="留空表示无需密码"></div>' +
                '<div class="shm-hint" id="shmHint"></div>' +
                '<div class="shm-actions">' +
                  '<button class="shm-btn danger" id="shmRevokeBtn" style="display:none"><i class="bi bi-slash-circle"></i> 取消分享</button>' +
                  '<span class="shm-flex"></span>' +
                  '<button class="shm-btn primary" id="shmSaveBtn"><i class="bi bi-check2"></i> 生成分享</button>' +
                '</div>' +
              '</div>'
            : '') +
          '<div class="shm-section">' +
            '<div class="shm-sec-title"><i class="bi bi-clock-history"></i> 分享记录' +
              '<span class="shm-filter" id="shmFilter">' +
                '<button data-f="active">有效</button>' +
                '<button data-f="all">全部</button>' +
              '</span>' +
            '</div>' +
            '<div class="shm-list" id="shmList"><div class="shm-empty"><i class="bi bi-hourglass-split"></i>加载中…</div></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    _shmOverlay = ov;

    ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeShareManager(); });
    const closeBtn = ov.querySelector("#shmCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeShareManager);
    const refreshBtn = ov.querySelector("#shmRefreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => _shmRefresh());

    // 筛选切换
    const filterEl = ov.querySelector("#shmFilter");
    if (filterEl) {
      filterEl.querySelectorAll("button").forEach(b => {
        b.addEventListener("click", () => {
          _shmFilter = b.dataset.f || "active";
          filterEl.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
          _shmRenderList();
        });
        b.classList.toggle("on", b.dataset.f === _shmFilter);
      });
    }

    // 上方设置区事件
    if (hasFile) {
      const linkEl = ov.querySelector("#shmLink");
      ov.querySelector("#shmCopyBtn").addEventListener("click", () => {
        if (!linkEl.value) { toast("请先生成分享链接", "warn"); return; }
        copyText(linkEl.value);
      });
      ov.querySelector("#shmOpenBtn").addEventListener("click", () => {
        if (linkEl.value) window.open(linkEl.value, "_blank");
      });
      ov.querySelector("#shmSaveBtn").addEventListener("click", _shmSubmit);
      ov.querySelector("#shmRevokeBtn").addEventListener("click", async (e) => {
        if (!_shmCur) return;
        await _shmRevoke(_shmCur.id, e.currentTarget);
      });
    }

    // 列表事件委托
    const listEl = ov.querySelector("#shmList");
    if (listEl) {
      listEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-op]");
        if (!btn) return;
        const item = btn.closest(".shm-item");
        if (!item) return;
        const rec = _shmAll.find(x => String(x.id) === item.dataset.id);
        if (!rec) return;
        const op = btn.dataset.op;
        if (op === "copy") copyText(rec.full_url);
        else if (op === "open") { if (rec.full_url) window.open(rec.full_url, "_blank"); }
        else if (op === "edit") _shmSelectForEdit(rec);
        else if (op === "revoke") _shmRevoke(rec.id, btn);
        else if (op === "del") _shmDelete(rec, btn);
      });
    }

    _shmRefresh();
  }

  function closeShareManager() {
    if (_shmOverlay) { _shmOverlay.remove(); _shmOverlay = null; }
  }

  /* ---------- 拉取记录并刷新整块界面 ---------- */
  async function _shmRefresh() {
    _shmAll = await _shmLoad(true);
    const countEl = _shmOverlay && _shmOverlay.querySelector("#shmCount");
    if (countEl) {
      const active = _shmAll.filter(x => x.state === "ok").length;
      countEl.textContent = _shmAll.length ? (active + " 个有效 · 共 " + _shmAll.length + " 条") : "";
    }
    if (_shmFile && _shmOverlay) {
      let rec = null;
      if (_shmPickId) rec = _shmAll.find(x => String(x.id) === String(_shmPickId)) || null;
      if (!rec) rec = _shmAll.find(x => x.abs_path === _shmFile && x.state === "ok") || null;
      _shmCur = rec;
      _shmFillForm(rec);
    }
    _shmRenderList();
  }

  /* ---------- 上方表单：按记录填充 ---------- */
  function _shmFillForm(rec) {
    if (!_shmOverlay) return;
    const linkEl = _shmOverlay.querySelector("#shmLink");
    const expireEl = _shmOverlay.querySelector("#shmExpire");
    const mvEl = _shmOverlay.querySelector("#shmMaxViews");
    const pwEl = _shmOverlay.querySelector("#shmPassword");
    const hintEl = _shmOverlay.querySelector("#shmHint");
    const stateEl = _shmOverlay.querySelector("#shmCurState");
    const revokeBtn = _shmOverlay.querySelector("#shmRevokeBtn");
    const saveBtn = _shmOverlay.querySelector("#shmSaveBtn");
    const openBtn = _shmOverlay.querySelector("#shmOpenBtn");
    if (!linkEl) return;

    // 同步「当前文件分享」里的文件名：从列表点「载入上方设置」时会切换到别的文件
    const fileEl = _shmOverlay.querySelector(".shm-file-name");
    if (fileEl) {
      const p = _shmFile || "";
      fileEl.textContent = p ? (p.split("/").pop() || p) : "（未选择文件）";
      fileEl.title = p;
    }

    linkEl.value = rec ? (rec.full_url || "") : "";
    if (openBtn) openBtn.style.opacity = rec ? "" : "0.5";
    if (revokeBtn) revokeBtn.style.display = (rec && rec.state === "ok") ? "" : "none";
    if (saveBtn) saveBtn.innerHTML = '<i class="bi bi-check2"></i> ' + (rec ? "保存设置" : "生成分享");

    if (stateEl) {
      if (rec) {
        stateEl.style.display = "";
        stateEl.className = "shm-state-badge " + rec.state;
        stateEl.textContent = _shmStateText(rec.state);
      } else stateEl.style.display = "none";
    }

    mvEl.value = (rec && rec.max_views) ? rec.max_views : "";
    pwEl.value = "";
    pwEl.placeholder = (rec && rec.has_password) ? "已设置密码，留空表示保持不变" : "留空表示无需密码";

    // 已有记录：按剩余时间回填最近的有效期预设
    if (rec && rec.expires_at && rec.expires_at * 1000 > Date.now()) {
      const left = rec.expires_at * 1000 - Date.now();
      expireEl.value = left <= 3600e3 ? "1h" : left <= 86400e3 ? "1d" : left <= 7 * 86400e3 ? "7d" : "30d";
    } else {
      expireEl.value = "forever";
    }

    hintEl.innerHTML = rec
      ? '已访问 <strong>' + (rec.views || 0) + '</strong> 次' + (rec.max_views ? " / 上限 " + rec.max_views : "") +
        ' · ' + esc(rec.expires_str || "永久有效") + ' · 同一文件复用同一链接'
      : "创建的链接不包含服务器路径信息，对方打开即可查看或下载。";
  }

  /* ---------- 保存 / 生成分享 ---------- */
  async function _shmSubmit() {
    const linkEl = _shmOverlay.querySelector("#shmLink");
    const expireEl = _shmOverlay.querySelector("#shmExpire");
    const mvEl = _shmOverlay.querySelector("#shmMaxViews");
    const pwEl = _shmOverlay.querySelector("#shmPassword");
    const saveBtn = _shmOverlay.querySelector("#shmSaveBtn");
    const password = (pwEl.value || "").trim();
    const payload = {
      expires_in: expireEl.value,
      max_views: parseInt(mvEl.value || "0", 10) || 0,
    };
    // 已有密码且输入为空 → 保持原密码不变
    if (password || !_shmCur || !_shmCur.has_password) payload.password = password;

    let url, body;
    // 已取消的记录不复用（后端也只复用 revoked=0 的记录）：直接新建一条，旧的进历史
    if (_shmCur && _shmCur.id && _shmCur.state !== "revoked") {
      url = "/api/share/update";
      body = Object.assign({ id: _shmCur.id }, payload);
    } else {
      url = "/api/share";
      body = Object.assign({ path: _shmFile }, payload);
    }
    saveBtn.disabled = true;
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || "请重试");
      _shmCur = d;
      _shmPickId = d.id;
      toast("分享已就绪", "ok");
      linkEl.value = d.full_url || "";
      copyText(d.full_url);
      _shmRefresh();
    } catch (e) {
      toast("分享失败：" + (e.message || e), "err");
    } finally {
      saveBtn.disabled = false;
    }
  }

  function _shmSelectForEdit(rec) {
    _shmPickId = rec.id;
    _shmFile = rec.abs_path || _shmFile;
    if (!_shmOverlay) return;
    // 若上次打开时没有当前文件区（无文件入口），补一个最简单的编辑入口：直接打开带该文件的弹层
    const linkEl = _shmOverlay.querySelector("#shmLink");
    if (!linkEl) { openShareManager(rec.abs_path); return; }
    _shmCur = rec;
    _shmFillForm(rec);
    _shmRenderList();   // 同步列表里的选中高亮
    const section = _shmOverlay.querySelector(".shm-section");
    if (section && section.scrollIntoView) section.scrollIntoView({ block: "start" });
  }

  /* 二次确认：优先贴着触发按钮弹自定义悬浮框，兜底用居中弹窗 */
  function _shmAsk(anchor, title, msg, okText) {
    if (anchor && typeof uiConfirmPop === "function") {
      return uiConfirmPop(anchor, { title, msg, okText, danger: true });
    }
    return uiConfirm(title, msg, okText, true);
  }

  /* ---------- 取消分享（软删除，保留记录） ---------- */
  async function _shmRevoke(id, anchor) {
    const rec = _shmAll.find(x => String(x.id) === String(id)) || _shmCur || {};
    const ok = await _shmAsk(anchor, "取消分享",
      "取消后「" + (rec.name || "该文件") + "」的链接立即失效，记录仍保留在分享列表中。", "取消分享");
    if (!ok) return;
    try {
      const r = await fetch("/api/share/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, revoked: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || "请重试");
      toast("已取消分享", "ok");
      if (String(_shmPickId) === String(id)) _shmPickId = id; // 保留选中，显示为已取消
      _shmRefresh();
    } catch (e) {
      toast("操作失败：" + (e.message || e), "err");
    }
  }

  /* ---------- 彻底删除记录 ---------- */
  async function _shmDelete(rec, anchor) {
    const ok = await _shmAsk(anchor, "删除分享记录",
      "将彻底删除「" + (rec.name || "") + "」的分享记录，链接同时失效，不可恢复。", "删除");
    if (!ok) return;
    try {
      const r = await fetch("/api/share", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rec.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || "请重试");
      toast("分享记录已删除", "ok");
      if (String(_shmPickId) === String(rec.id)) _shmPickId = null;
      _shmRefresh();
    } catch (e) {
      toast("删除失败：" + (e.message || e), "err");
    }
  }

  /* ---------- 下方列表渲染 ---------- */
  function _shmRenderList() {
    if (!_shmOverlay) return;
    const listEl = _shmOverlay.querySelector("#shmList");
    if (!listEl) return;
    const items = _shmFilter === "all" ? _shmAll : _shmAll.filter(x => x.state === "ok");
    if (!items.length) {
      listEl.innerHTML = '<div class="shm-empty"><i class="bi bi-share"></i>' +
        (_shmFilter === "all" ? "还没有创建过分享" : "当前没有有效的分享") + '</div>';
      return;
    }
    listEl.innerHTML = items.map(it => {
      const limit = it.max_views ? " / " + it.max_views : "";
      const icon = it.state === "ok" ? "check-circle" : "exclamation-circle";
      const sel = (_shmCur && String(_shmCur.id) === String(it.id)) ? " sel" : "";
      return '' +
        '<div class="shm-item ' + it.state + sel + '" data-id="' + it.id + '">' +
          '<div class="shmi-icon"><i class="bi bi-file-earmark"></i></div>' +
          '<div class="shmi-info">' +
            '<div class="shmi-name" title="' + escAttr(it.abs_path || "") + '">' + esc(it.name || "") + '</div>' +
            '<div class="shmi-link" title="' + escAttr(it.full_url || "") + '">' + esc(it.full_url || "") + '</div>' +
            '<div class="shmi-meta">' +
              '<span class="shmi-state ' + it.state + '"><i class="bi bi-' + icon + '"></i> ' + _shmStateText(it.state) + '</span>' +
              '<span><i class="bi bi-eye"></i> ' + (it.views || 0) + limit + '</span>' +
              '<span><i class="bi bi-clock"></i> ' + esc(it.expires_str || "永久有效") + '</span>' +
              (it.has_password ? '<span><i class="bi bi-shield-lock"></i> 已加密</span>' : "") +
            '</div>' +
          '</div>' +
          '<div class="shmi-ops">' +
            '<button class="shm-icon-btn" data-op="copy" title="复制链接"><i class="bi bi-clipboard"></i></button>' +
            '<button class="shm-icon-btn" data-op="open" title="打开链接"><i class="bi bi-box-arrow-up-right"></i></button>' +
            '<button class="shm-icon-btn" data-op="edit" title="载入上方设置"><i class="bi bi-sliders"></i></button>' +
            (it.state === "ok"
              ? '<button class="shm-icon-btn" data-op="revoke" title="取消分享"><i class="bi bi-slash-circle"></i></button>'
              : "") +
            '<button class="shm-icon-btn danger" data-op="del" title="彻底删除"><i class="bi bi-trash3"></i></button>' +
          '</div>' +
        '</div>';
    }).join("");
  }
