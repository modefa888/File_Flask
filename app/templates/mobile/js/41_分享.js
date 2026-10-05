  // ---------- 分享：文件分享（链接 / 密码 / 有效期 / 二维码）+ 分享记录 ----------
  var _shareTarget = null;     // 待分享的文件 { name, abs, sizeStr, thumbHtml }
  var _shareRec = null;        // 当前分享记录
  var _shareExisting = null;   // 该文件已有的分享（存在则走 update，避免覆盖原密码）
  var _shItems = [];           // 当前 tab 的分享记录列表
  var _shTab = "active";       // active（有效）| history（历史）
  var _shActive = [];          // 有效分享
  var _shHistory = [];         // 已取消 / 已过期 / 次数用完

  var SH_EXPIRES = [
    ["1h", "1 小时"], ["1d", "1 天"], ["7d", "7 天"], ["30d", "30 天"], ["forever", "永久有效"]
  ];

  function shareStateText(st) {
    if (st === "expired") return "已过期";
    if (st === "exhausted") return "次数已用完";
    if (st === "revoked") return "已取消";
    return "有效";
  }
  function shareStateCls(st) {
    if (st === "ok") return "ok";
    if (st === "expired" || st === "exhausted") return "expired";
    return "bad";
  }

  function shareSheetOpen(title) {
    document.getElementById("ssTitle").textContent = title || "分享";
    document.getElementById("shareMask").classList.add("show");
    document.getElementById("shareSheet").classList.add("show");
    // 底部面板与迷你播放条重叠：打开时先收起，关闭后恢复
    var mp = document.getElementById("miniPlayer");
    if (mp.classList.contains("show")) {
      mp.classList.remove("show");
      mp.setAttribute("data-share-restore", "1");
    }
  }
  function shareSheetClose() {
    document.getElementById("shareMask").classList.remove("show");
    document.getElementById("shareSheet").classList.remove("show");
    _shareTarget = null;
    var mp = document.getElementById("miniPlayer");
    if (mp.getAttribute("data-share-restore")) {
      mp.removeAttribute("data-share-restore");
      mp.classList.add("show");
    }
  }
  document.getElementById("shareMask").addEventListener("click", shareSheetClose);
  document.getElementById("ssClose").addEventListener("click", shareSheetClose);

  // 文件信息块（文件名 + 副标题）
  function ssFileHtml(name, sub, iconInner) {
    return '<div class="ss-file">' +
      '<span class="ss-ico">' + (iconInner || "🔗") + '</span>' +
      '<div class="ss-main">' +
        '<div class="ss-fname">' + esc(name || "") + '</div>' +
        '<div class="ss-fsub">' + esc(sub || "") + '</div>' +
      '</div></div>';
  }

  // ===== 创建分享：从文件操作弹窗进入 =====
  function openShareSheet(item) {
    _shareTarget = {
      name: item.name,
      abs: itemAbs(item),
      sizeStr: item.size_str || "",
      thumbHtml: _titleThumbHtml(item)
    };
    _shareRec = null;
    _shareExisting = null;
    renderShareCreate();
    shareSheetOpen("分享文件");

    // 该文件若已有分享，回填已有设置（次数/密码提示），避免再次生成时把原设置改掉
    var abs = _shareTarget.abs;
    fetchTimeout("/api/shares", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!_shareTarget || _shareTarget.abs !== abs) return;   // 面板已关闭或换了文件
        var hit = null;
        (d.items || []).forEach(function (x) { if (!hit && x.abs_path === abs) hit = x; });
        if (!hit) return;
        _shareExisting = hit;
        var mvEl = document.getElementById("ssMaxViews");
        if (mvEl) mvEl.value = hit.max_views || 0;
        var pwdEl = document.getElementById("ssPwd");
        if (pwdEl && hit.has_password) pwdEl.placeholder = "已设置密码，留空表示保持不变";
        var hint = document.getElementById("ssCreateHint");
        if (hint) {
          hint.innerHTML = "该文件已有分享（已访问 " + (hit.views || 0) + " 次 · " +
            esc(hit.expires_str || "") + "），生成后会更新这条链接的设置。";
        }
      })
      .catch(function () {});
  }

  function renderShareCreate() {
    var t = _shareTarget || {};
    var body = document.getElementById("ssBody");
    body.innerHTML =
      ssFileHtml(t.name, t.sizeStr || "生成链接后即可发送给朋友", t.thumbHtml) +
      '<div class="ss-label">有效期</div>' +
      '<select class="ss-select" id="ssExp">' +
        SH_EXPIRES.map(function (e) {
          return '<option value="' + e[0] + '"' + (e[0] === "7d" ? " selected" : "") + '>' + e[1] + '</option>';
        }).join("") +
      '</select>' +
      '<div class="ss-label">访问密码（可选）</div>' +
      '<input class="ss-input" id="ssPwd" type="text" autocomplete="off" placeholder="留空表示无需密码" />' +
      '<div class="ss-label">访问次数上限（0 表示不限）</div>' +
      '<input class="ss-input" id="ssMaxViews" type="number" min="0" step="1" inputmode="numeric" value="0" />' +
      '<button class="ss-primary" id="ssMake">生成分享链接</button>' +
      '<div class="ss-hint" id="ssCreateHint">同一个文件重复分享会复用同一条链接，只更新有效期、密码与访问次数。</div>';
    document.getElementById("ssMake").addEventListener("click", doShareCreate);
  }

  function doShareCreate() {
    if (!_shareTarget) return;
    var btn = document.getElementById("ssMake");
    var exp = document.getElementById("ssExp");
    var pwd = document.getElementById("ssPwd");
    var mv = document.getElementById("ssMaxViews");
    var payload = {
      password: (pwd && pwd.value || "").trim(),
      expires_in: exp ? exp.value : "forever",
      max_views: Math.max(0, parseInt((mv && mv.value) || "0", 10) || 0)
    };
    // 已有分享 → 走 update（密码留空表示保持原样）；否则新建
    var url;
    if (_shareExisting && _shareExisting.id) {
      payload.id = _shareExisting.id;
      if (!payload.password) delete payload.password;
      url = "/api/share/update";
    } else {
      payload.path = _shareTarget.abs;
      url = "/api/share";
    }
    btn.disabled = true;
    btn.textContent = "生成中…";
    fetchTimeout(url, 15000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          toast(d.error, "error");
          btn.disabled = false; btn.textContent = "生成分享链接";
          return;
        }
        _shareRec = d;
        renderShareResult();
        toast("分享链接已生成", "success");
      })
      .catch(function () {
        toast("生成失败，请重试", "error");
        btn.disabled = false; btn.textContent = "生成分享链接";
      });
  }

  // ===== 已生成：链接 + 二维码 + 操作 =====
  function renderShareResult() {
    var rec = _shareRec || {};
    var body = document.getElementById("ssBody");
    var url = rec.full_url || "";
    var canShare = !!(navigator.share);
    body.innerHTML =
      ssFileHtml(rec.name || (_shareTarget && _shareTarget.name),
        (rec.size_str || "") + (rec.has_password ? " · 🔒 已加密" : " · 无需密码"),
        (_shareTarget && _shareTarget.thumbHtml) || "🔗") +
      '<div class="ss-label">分享链接</div>' +
      '<div class="ss-linkrow">' +
        '<input class="ss-link" id="ssLink" readonly value="' + esc(url) + '">' +
        '<button class="ss-btn primary" id="ssCopyLink" style="flex:none">📋</button>' +
      '</div>' +
      '<div class="ss-qr"><img src="/share/' + encodeURIComponent(rec.token || "") + '/qr" alt="分享二维码"></div>' +
      '<div class="ss-qr-tip">用另一台设备扫码打开分享页</div>' +
      '<div class="ss-btns">' +
        (canShare ? '<button class="ss-btn" id="ssSysShare">📤 系统分享</button>' : '') +
        '<button class="ss-btn" id="ssOpenLink">🌐 打开链接</button>' +
        '<button class="ss-btn wide" id="ssManage">🔗 查看全部分享</button>' +
        (rec.id ? '<button class="ss-btn danger wide" id="ssCancelShare">🗑️ 取消该分享</button>' : '') +
      '</div>' +
      '<div class="ss-meta">有效期：' + esc(rec.expires_str || "永久有效") +
        ' · 已访问 ' + (rec.views || 0) + ' 次</div>';

    var link = document.getElementById("ssLink");
    if (link) link.addEventListener("click", function () { link.select(); });
    document.getElementById("ssCopyLink").addEventListener("click", function () {
      copyText(url, "分享链接已复制");
    });
    document.getElementById("ssOpenLink").addEventListener("click", function () {
      if (url) window.open(url, "_blank");
    });
    var sys = document.getElementById("ssSysShare");
    if (sys) sys.addEventListener("click", function () {
      navigator.share({ title: rec.name || "文件分享", url: url }).catch(function () {});
    });
    document.getElementById("ssManage").addEventListener("click", function () {
      shareSheetClose();
      openSharePage();
    });
    var cancel = document.getElementById("ssCancelShare");
    if (cancel) cancel.addEventListener("click", function () {
      cancelShare(rec, function () { shareSheetClose(); });
    });
  }

  // ===== 分享设置（分享记录页进入：改有效期 / 密码 / 次数上限） =====
  var SH_EXPIRES_KEEP = [
    ["", "保持不变"], ["1h", "1 小时"], ["1d", "1 天"], ["7d", "7 天"],
    ["30d", "30 天"], ["forever", "永久有效"]
  ];

  function openShareSettings(rec) {
    _shareTarget = null;
    _shareRec = rec;
    var body = document.getElementById("ssBody");
    body.innerHTML =
      ssFileHtml(rec.name, (rec.size_str || "") + " · 已访问 " + (rec.views || 0) + " 次",
        iconHtmlFor({ name: rec.name })) +
      '<div class="ss-label">有效期（当前：' + esc(rec.expires_str || "永久有效") + '）</div>' +
      '<select class="ss-select" id="ssExpSet">' +
        SH_EXPIRES_KEEP.map(function (e) {
          return '<option value="' + e[0] + '">' + e[1] + '</option>';
        }).join("") +
      '</select>' +
      '<div class="ss-label">访问密码（可选）</div>' +
      '<input class="ss-input" id="ssPwdSet" type="text" autocomplete="off" placeholder="' +
        (rec.has_password ? "已设置密码，留空表示保持不变" : "留空表示无需密码") + '" />' +
      '<div class="ss-label">访问次数上限（0 表示不限）</div>' +
      '<input class="ss-input" id="ssMaxViews" type="number" min="0" step="1" inputmode="numeric" value="' +
        (rec.max_views || 0) + '" />' +
      '<button class="ss-primary" id="ssSaveSet">保存设置</button>' +
      '<div class="ss-hint">链接不变，改完立即生效；把有效期改到未来可以让已过期的分享重新可用。</div>' +
      '<div class="ss-btns" style="margin-top:14px">' +
        '<button class="ss-btn danger wide" id="ssCancelShareSet">🗑️ 取消分享（链接立即失效）</button>' +
      '</div>';
    document.getElementById("ssSaveSet").addEventListener("click", doShareUpdate);
    document.getElementById("ssCancelShareSet").addEventListener("click", function () {
      cancelShare(_shareRec, function () { shareSheetClose(); });
    });
    shareSheetOpen("分享设置");
  }

  function doShareUpdate() {
    var rec = _shareRec;
    if (!rec || !rec.id) return;
    var btn = document.getElementById("ssSaveSet");
    var exp = document.getElementById("ssExpSet");
    var pwd = document.getElementById("ssPwdSet");
    var mv = document.getElementById("ssMaxViews");
    var payload = {
      id: rec.id,
      max_views: Math.max(0, parseInt((mv && mv.value) || "0", 10) || 0)
    };
    if (exp && exp.value) payload.expires_in = exp.value;       // 空 = 保持不变
    if (pwd && pwd.value.trim()) payload.password = pwd.value.trim();
    btn.disabled = true;
    btn.textContent = "保存中…";
    fetchTimeout("/api/share/update", 15000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          toast(d.error, "error");
          btn.disabled = false; btn.textContent = "保存设置";
          return;
        }
        _shareRec = d;
        toast("设置已保存", "success");
        shareSheetClose();
        if (document.getElementById("sharePage").classList.contains("show")) loadShares();
      })
      .catch(function () {
        toast("保存失败，请重试", "error");
        btn.disabled = false; btn.textContent = "保存设置";
      });
  }

  // ===== 二维码弹窗（分享记录页进入） =====
  function showShareQr(rec) {
    _shareTarget = null;
    _shareRec = rec;
    var body = document.getElementById("ssBody");
    var url = rec.full_url || "";
    body.innerHTML =
      ssFileHtml(rec.name, shareStateText(rec.state) + " · " + (rec.expires_str || ""),
        iconHtmlFor({ name: rec.name })) +
      '<div class="ss-qr"><img src="/share/' + encodeURIComponent(rec.token || "") + '/qr" alt="分享二维码"></div>' +
      '<div class="ss-qr-tip">用另一台设备扫码打开</div>' +
      '<div class="ss-linkrow" style="margin-top:14px">' +
        '<input class="ss-link" id="ssLink" readonly value="' + esc(url) + '">' +
        '<button class="ss-btn primary" id="ssCopyLink" style="flex:none">📋</button>' +
      '</div>' +
      '<div class="ss-btns">' +
        '<button class="ss-btn" id="ssOpenLink">🌐 打开链接</button>' +
        '<button class="ss-btn danger" id="ssQrCancel">🗑️ 取消分享</button>' +
      '</div>';
    document.getElementById("ssCopyLink").addEventListener("click", function () {
      copyText(url, "分享链接已复制");
    });
    document.getElementById("ssOpenLink").addEventListener("click", function () {
      if (url) window.open(url, "_blank");
    });
    document.getElementById("ssQrCancel").addEventListener("click", function () {
      cancelShare(rec, function () { shareSheetClose(); });
    });
    shareSheetOpen("分享二维码");
  }

  // 取消分享：软取消（链接立即失效），记录保留在「历史」里，可恢复或彻底删除
  function cancelShare(rec, after) {
    if (!rec || !rec.id) return;
    confirmBox({
      title: "取消分享",
      message: "取消后「" + (rec.name || "") + "」的链接立即失效，记录会保留在「历史」中（可恢复）。确定继续？",
      okText: "取消分享", danger: true,
      onOk: function () {
        fetchTimeout("/api/share", 10000, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: rec.id, soft: true })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); return; }
            toast("已取消分享，可在「历史」里恢复", "success");
            if (typeof after === "function") after();
            if (document.getElementById("sharePage").classList.contains("show")) loadShares();
          })
          .catch(function () { toast("取消失败，请重试", "error"); });
      }
    });
  }

  // 从历史里恢复一条被取消的分享（revoked → 有效，链接重新可用）
  function restoreShare(rec) {
    if (!rec || !rec.id) return;
    fetchTimeout("/api/share/update", 10000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rec.id, revoked: false })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        toast("已恢复分享，链接重新可用", "success");
        loadShares();
      })
      .catch(function () { toast("恢复失败，请重试", "error"); });
  }

  // 从历史里彻底删除记录（写操作的终点，不可恢复）
  function purgeShare(rec) {
    if (!rec || !rec.id) return;
    confirmBox({
      title: "彻底删除",
      message: "将从历史中永久删除「" + (rec.name || "") + "」这条记录，不可恢复。确定继续？",
      okText: "彻底删除", danger: true,
      onOk: function () {
        fetchTimeout("/api/share", 10000, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: rec.id })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); return; }
            toast("已彻底删除", "success");
            loadShares();
          })
          .catch(function () { toast("删除失败，请重试", "error"); });
      }
    });
  }

  // ===== 分享记录页（有效 / 历史） =====
  function openSharePage() {
    document.getElementById("sharePage").classList.add("show");
    document.body.classList.add("lock");
    loadShares();
  }
  function closeSharePage() {
    document.getElementById("sharePage").classList.remove("show");
    document.body.classList.remove("lock");
  }

  function loadShares() {
    var box = document.getElementById("shList");
    var stat = document.getElementById("shStat");
    box.innerHTML = '<div class="tr-empty">加载中…</div>';
    // 一次把「有效」和「含已取消」两份都取回来，tab 上就能显示各自的数量
    Promise.all([
      fetchTimeout("/api/shares", 10000).then(function (r) { return r.json(); }),
      fetchTimeout("/api/shares?include_revoked=1", 10000).then(function (r) { return r.json(); })
    ])
      .then(function (arr) {
        var all = (arr[1] && arr[1].items) || [];
        var live = (arr[0] && arr[0].items) || all;
        _shActive = live.filter(function (x) { return x.state === "ok"; });
        _shHistory = all.filter(function (x) { return x.state !== "ok"; });
        renderShareTabs();
        renderShareList();
      })
      .catch(function () {
        box.innerHTML = '<div class="tr-empty">加载失败，请重试</div>';
        stat.textContent = "";
      });
  }

  function renderShareTabs() {
    var tabs = document.getElementById("shTabs");
    if (!tabs) return;
    tabs.innerHTML =
      '<button class="sh-tab' + (_shTab === "active" ? " on" : "") + '" data-tab="active">有效<b>' + _shActive.length + '</b></button>' +
      '<button class="sh-tab' + (_shTab === "history" ? " on" : "") + '" data-tab="history">历史<b>' + _shHistory.length + '</b></button>';
    Array.prototype.forEach.call(tabs.querySelectorAll(".sh-tab"), function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-tab");
        if (_shTab === t) return;
        _shTab = t;
        renderShareTabs();
        renderShareList();
      });
    });
  }

  function shareRowHtml(it, i) {
    var history = it.state !== "ok";
    var acts = '<button data-act="copy">📋 复制</button>' +
      '<button data-act="qr">🔳 二维码</button>' +
      (history
        ? '<button data-act="restore">♻️ 恢复</button>' +
          '<button class="danger" data-act="purge">🗑 删除</button>'
        : '<button data-act="settings">⚙️ 设置</button>' +
          '<button data-act="open">🌐 打开</button>' +
          '<button class="danger" data-act="del">🗑 取消</button>');
    return '<div class="shr-item" data-i="' + i + '">' +
      '<div class="shr-top">' +
        '<span class="shr-ico">' + iconHtmlFor({ name: it.name }) + '</span>' +
        '<div class="shr-main">' +
          '<div class="shr-name">' + esc(it.name || "(未知)") + '</div>' +
          '<div class="shr-link">' + esc(it.full_url || "") + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="shr-meta">' +
        '<span class="shr-badge ' + shareStateCls(it.state) + '">' + shareStateText(it.state) + '</span>' +
        '<span>👁 ' + (it.views || 0) + (it.max_views ? "/" + it.max_views : "") + '</span>' +
        '<span>⏱ ' + esc(it.expires_str || "") + '</span>' +
        (it.has_password ? '<span>🔒 已加密</span>' : '') +
        (it.size_str ? '<span>' + esc(it.size_str) + '</span>' : '') +
      '</div>' +
      '<div class="shr-acts">' + acts + '</div>' +
    '</div>';
  }

  function renderShareList() {
    var box = document.getElementById("shList");
    var stat = document.getElementById("shStat");
    var items = (_shTab === "active") ? _shActive : _shHistory;
    _shItems = items;                 // 供点击分发按行号取用
    var total = _shActive.length + _shHistory.length;
    stat.textContent = total
      ? "共 " + total + " 个分享 · 有效 " + _shActive.length + " · 历史 " + _shHistory.length
      : "";
    if (!items.length) {
      box.innerHTML = (_shTab === "active")
        ? '<div class="tr-empty">🔗<br>还没有可用的分享<br>在任意文件上点「⋯」→「分享」即可生成链接</div>'
        : '<div class="tr-empty">🗂<br>暂无历史记录<br>已取消 / 已过期 / 次数用完的分享会留在这里，可恢复或彻底删除</div>';
      return;
    }
    box.innerHTML = items.map(shareRowHtml).join("");
  }

  document.getElementById("shList").addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("button[data-act]");
    if (!btn) return;
    var row = e.target.closest(".shr-item");
    if (!row) return;
    var it = _shItems[parseInt(row.getAttribute("data-i"), 10)];
    if (!it) return;
    var act = btn.getAttribute("data-act");
    if (act === "copy") copyText(it.full_url || "", "分享链接已复制");
    else if (act === "open") { if (it.full_url) window.open(it.full_url, "_blank"); }
    else if (act === "qr") showShareQr(it);
    else if (act === "settings") openShareSettings(it);
    else if (act === "restore") restoreShare(it);
    else if (act === "purge") purgeShare(it);
    else if (act === "del") cancelShare(it, null);
  });

  document.getElementById("shRefresh").addEventListener("click", loadShares);
  document.getElementById("shBack").addEventListener("click", closeSharePage);
  document.getElementById("mmShareBtn").addEventListener("click", function () {
    toggleMoreMenu(false);
    openSharePage();
  });
