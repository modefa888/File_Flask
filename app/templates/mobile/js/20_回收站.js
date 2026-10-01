  // ---------- 回收站 ----------
  var _trItems = [];
  function trIco(name, isDir) {
    if (isDir) return "📁";
    var e = (name.split(".").pop() || "").toLowerCase();
    if (["jpg","jpeg","png","gif","webp","bmp","svg","ico"].indexOf(e) >= 0) return "🖼️";
    if (["mp4","mkv","avi","mov","wmv","flv","ts","webm","m4v"].indexOf(e) >= 0) return "🎬";
    if (["mp3","flac","wav","aac","ogg","m4a","wma"].indexOf(e) >= 0) return "🎵";
    if (["zip","rar","7z","tar","gz","bz2","xz"].indexOf(e) >= 0) return "🗜️";
    if (["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","md","epub"].indexOf(e) >= 0) return "📝";
    if (["exe","msi","apk","deb","dmg","appimage"].indexOf(e) >= 0) return "⚙️";
    return "📄";
  }
  function fmtTrTime(ts) {
    if (!ts) return "";
    var diff = Date.now() / 1000 - ts;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " 天前";
    var dte = new Date(ts * 1000), p2 = function (x) { return (x < 10 ? "0" : "") + x; };
    return dte.getFullYear() + "-" + p2(dte.getMonth() + 1) + "-" + p2(dte.getDate());
  }
  function openTrash() {
    document.getElementById("trashPage").classList.add("show");
    document.body.classList.add("lock");
    loadTrash();
  }
  function closeTrash() {
    document.getElementById("trashPage").classList.remove("show");
    document.body.classList.remove("lock");
  }
  function loadTrash() {
    var box = document.getElementById("trList");
    var stat = document.getElementById("trStat");
    box.innerHTML = '<div class="tr-empty">加载中…</div>';
    fetchTimeout("/api/delete-history", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          box.innerHTML = '<div class="tr-empty">' + esc(d.error) + '</div>';
          stat.textContent = "";
          return;
        }
        var items = d.items || [];
        _trItems = items;
        var alive = items.filter(function (x) { return x.exists; });
        var bytes = alive.reduce(function (s, x) { return s + (x.is_dir ? 0 : (x.size || 0)); }, 0);
        stat.textContent = items.length
          ? "共 " + items.length + " 项 · 可恢复 " + alive.length + " 项 · 约 " + fmtDelBytes(bytes)
          : "";
        if (!items.length) {
          box.innerHTML = '<div class="tr-empty">🗑<br>回收站是空的</div>';
          return;
        }
        box.innerHTML = items.map(function (it, idx) {
          var gone = !it.exists;
          var sizeTxt = it.is_dir ? "文件夹" : (fmtDelBytes(it.size || 0));
          return '<div class="tr-item' + (gone ? " gone" : "") + '" data-i="' + idx + '">' +
            '<div class="tr-row">' +
              '<span class="tr-ico">' + trIco(it.name || "", it.is_dir) + '</span>' +
              '<span class="tr-name">' + esc(it.name || "(未命名)") + '</span>' +
              '<span class="tr-acts">' +
                (it.exists ? '<button class="tr-restore" data-act="restore">恢复</button>' : '') +
                (it.exists ? '<button class="tr-purge" data-act="purge">彻底删除</button>' : '') +
              '</span>' +
            '</div>' +
            '<div class="tr-meta">原位置：' + esc(it.original_path || "—") + '</div>' +
            '<div class="tr-sub">' + sizeTxt + ' · 删除于 ' + fmtTrTime(it.deleted_at) +
              (gone ? ' · 已不在回收站' : '') + '</div>' +
          '</div>';
        }).join("");
      })
      .catch(function () {
        box.innerHTML = '<div class="tr-empty">加载失败，请重试</div>';
        stat.textContent = "";
      });
  }
  document.getElementById("trList").addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("button[data-act]");
    if (!btn) return;
    var card = btn.closest(".tr-item");
    var it = _trItems[parseInt(card.getAttribute("data-i"), 10)];
    if (!it) return;
    if (btn.getAttribute("data-act") === "restore") trRestore(it);
    else trPurge(it);
  });
  function trRestore(it) {
    fetchTimeout("/api/undo-delete", 30000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trash_id: it.id })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); }
        else if (d.success) toast("已恢复到原位置", "success");
        else toast(d.message || "已恢复", "warn");
        var orig = it.original_path || "";
        if (orig && normDirPath(dirnameOf(orig)) === normDirPath(state.path)) load(state.path);
        loadTrash();
      })
      .catch(function () { toast("恢复失败", "error"); });
  }
  function trPurge(it) {
    confirmBox({
      title: "彻底删除",
      message: "永久删除「" + (it.name || "") + "」？此操作不可恢复。",
      okText: "删除", danger: true,
      onOk: function () {
        fetchTimeout("/api/delete-history/one", 60000, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trash_id: it.id })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); loadTrash(); return; }
            toast("已彻底删除「" + (d.removed || it.name) + "」", "success");
            loadTrash();
          })
          .catch(function () { toast("删除失败", "error"); });
      }
    });
  }
  document.getElementById("trClear").addEventListener("click", function () {
    var alive = (_trItems || []).filter(function (x) { return x.exists; });
    if (!alive.length) { toast("回收站没有可清空的项目", "info"); return; }
    confirmBox({
      title: "清空回收站",
      message: "将永久删除回收站内 " + alive.length + " 项，不可恢复。确定继续？",
      okText: "全部删除", danger: true,
      onOk: function () {
        toast("正在清空，文件较多时请稍候…", "info");
        fetchTimeout("/api/delete-history/clear", 300000, {
          method: "POST", headers: { "Content-Type": "application/json" }
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); loadTrash(); return; }
            toast("已清空 " + d.removed + " 项", "success");
            loadTrash();
          })
          .catch(function () {
            toast("清空失败或超时，请稍后刷新查看", "error");
            loadTrash();
          });
      }
    });
  });
  document.getElementById("mmTrashBtn").addEventListener("click", function () {
    toggleMoreMenu(false); openTrash();
  });
  document.getElementById("trBack").addEventListener("click", closeTrash);
