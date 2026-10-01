  // ---------- 压缩 / 解压记录 ----------
  var _ahItems = [];
  function openAhPage() {
    document.getElementById("histPage").classList.add("show");
    document.body.classList.add("lock");
    loadAh();
  }
  function closeAhPage() {
    document.getElementById("histPage").classList.remove("show");
    document.body.classList.remove("lock");
  }
  function loadAh() {
    var box = document.getElementById("ahList");
    var stat = document.getElementById("ahStat");
    box.innerHTML = '<div class="tr-empty">加载中…</div>';
    fetchTimeout("/api/archive-history", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          box.innerHTML = '<div class="tr-empty">' + esc(d.error) + '</div>';
          stat.textContent = "";
          return;
        }
        var items = d.items || [];
        _ahItems = items;
        var zc = items.filter(function (x) { return x.kind === "zip"; }).length;
        stat.textContent = items.length
          ? "共 " + items.length + " 条 · 压缩 " + zc + " · 解压 " + (items.length - zc)
          : "";
        if (!items.length) {
          box.innerHTML = '<div class="tr-empty">📜<br>暂无压缩 / 解压记录</div>';
          return;
        }
        box.innerHTML = items.map(function (it, idx) {
          var isZip = it.kind === "zip";
          return '<div class="tr-item" data-i="' + idx + '">' +
            '<div class="tr-row">' +
              '<span class="tr-ico">' + (isZip ? "🗜️" : "📂") + '</span>' +
              '<span class="tr-name">' + esc(it.name || "(未知)") + '</span>' +
              '<span class="tr-acts"><button class="tr-purge" data-act="del">删除</button></span>' +
            '</div>' +
            '<div class="tr-meta">' + (isZip ? "压缩至" : "解压至") + '：' + esc(it.path || "—") + '</div>' +
            '<div class="tr-sub">' + (isZip ? "压缩" : "解压") +
              (it.detail ? " · " + esc(it.detail) : "") + ' · ' + fmtTrTime(it.time) + '</div>' +
          '</div>';
        }).join("");
      })
      .catch(function () {
        box.innerHTML = '<div class="tr-empty">加载失败，请重试</div>';
        stat.textContent = "";
      });
  }
  // 点击记录 → 跳转到目标目录并高亮对应文件/文件夹（点「删除」按钮除外）
  function clearPinned() {
    Array.prototype.forEach.call(document.querySelectorAll(".item.item-pinned"), function (el) {
      el.classList.remove("item-pinned");
    });
  }
  // 用户任意点击即清除高亮（点目标本身也会取消，符合预期）
  document.addEventListener("click", clearPinned);
  function highlightItemByName(name) {
    clearPinned();
    var rows = document.querySelectorAll("#list .item");
    for (var i = 0; i < rows.length; i++) {
      var n = rows[i].querySelector(".name");
      if (n && n.textContent === name) {
        rows[i].classList.add("item-pinned");
        rows[i].scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
    }
    return false;
  }
  // 通用：跳转到 dir 目录并高亮 name 条目（先探测存在性，已删除只提示不跳转）
  function gotoAndHighlight(dir, name) {
    if (!dir || !name) { toast("缺少目标路径", "info"); return Promise.resolve(false); }
    var targetAbs = (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;
    return fetchTimeout("/api/properties?path=" + encodeURIComponent(targetAbs) + "&light=1", 8000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.error) {
          toast("「" + name + "」已被删除或移动", "info");
          return false;
        }
        if (normDirPath(dir) === normDirPath(state.path)) {
          highlightItemByName(name);
          return true;
        }
        return load(dir).then(function () { highlightItemByName(name); return true; });
      })
      .catch(function () { toast("检查目标状态失败", "error"); return false; });
  }
  function gotoAhTarget(it) {
    var dir = it.path || "";
    var name = it.name || "";
    if (!dir || !name) { toast("该记录缺少目标路径", "info"); return; }
    gotoAndHighlight(dir, name).then(function (ok) { if (ok) closeAhPage(); });
  }
  document.getElementById("ahList").addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("button[data-act]");
    var row = e.target.closest && e.target.closest(".tr-item");
    if (!row) return;
    var it = _ahItems[parseInt(row.getAttribute("data-i"), 10)];
    if (!it) return;
    if (btn) {   // 删除该条记录
      fetchTimeout("/api/archive-history/one", 10000, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { toast(d.error, "error"); return; }
          toast("已删除该条记录", "success");
          loadAh();
        })
        .catch(function () { toast("删除失败", "error"); });
      return;
    }
    gotoAhTarget(it);
  });
  document.getElementById("ahClear").addEventListener("click", function () {
    if (!_ahItems.length) { toast("暂无记录可清空", "info"); return; }
    confirmBox({
      title: "清空记录",
      message: "将删除全部 " + _ahItems.length + " 条压缩/解压记录，仅清记录、不影响文件。确定继续？",
      okText: "清空", danger: true,
      onOk: function () {
        fetchTimeout("/api/archive-history/clear", 15000, {
          method: "POST", headers: { "Content-Type": "application/json" }
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); loadAh(); return; }
            toast("已清空 " + d.removed + " 条记录", "success");
            loadAh();
          })
          .catch(function () { toast("清空失败", "error"); });
      }
    });
  });
  document.getElementById("mmHistBtn").addEventListener("click", function () {
    toggleMoreMenu(false); openAhPage();
  });
  document.getElementById("ahBack").addEventListener("click", closeAhPage);
