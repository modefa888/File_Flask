  // ---------- ⭐ 收藏夹 ----------
  var favs = [];
  var favGroupOrder = [];         // 分组 tab 顺序（含 "__ungrouped__" = 「其他」位置），服务端持久化
  function loadFavs() {
    return fetchTimeout("/api/favorites", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        favs = (d && d.items) || [];
        favGroupOrder = (d && d.groups) || [];
        return favs;
      })
      .catch(function () { return favs; });
  }
  function isCurFav() {
    return favs.some(function (f) {
      return normDirPath(f.path || "") === normDirPath(state.path || "");
    });
  }
  function updateFavLabel() {
    var b = document.getElementById("addFavBtn");
    if (b) b.innerHTML = isCurFav() ? "💔 取消收藏当前文件夹" : "⭐ 收藏当前文件夹";
  }
  function toggleFav() {
    var wasFav = isCurFav();
    fetch("/api/favorites", {
      method: wasFav ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.path || "/" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        toast(wasFav ? "已取消收藏" : "已收藏当前文件夹", "success");
        return loadFavs().then(updateFavLabel);
      })
      .catch(function () { toast("操作失败", "error"); });
  }
  function addFav(path, group) {
    return fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path, group: group || "" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        toast("已收藏", "success");
        return loadFavs().then(updateFavLabel);
      })
      .catch(function () { toast("操作失败", "error"); });
  }
  function setFavGroup(path, group) {
    return fetch("/api/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path, group: group || "" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        return loadFavs();
      });
  }
  function favGroups() {
    var map = {}, names = [], seen = {};
    favs.forEach(function (f) {
      var g = f.group || "";
      if (!map[g]) map[g] = [];
      map[g].push(f);
    });
    // 先按保存的 tab 顺序，再补上未登记的分组
    favGroupOrder.forEach(function (g) {
      if (g && g !== "__ungrouped__" && map[g] && !seen[g]) { names.push(g); seen[g] = 1; }
    });
    Object.keys(map).forEach(function (g) {
      if (g && !seen[g]) { names.push(g); seen[g] = 1; }
    });
    return { names: names, map: map };
  }
  // 分组选择弹层（cb 收到分组名；"" = 其他，"__new__" = 新建分组；cur = 当前所在分组，用于标记）
  function pickGroup(cb, cur) {
    var head = document.getElementById("sheetHead");
    var btns = document.getElementById("sheetBtns");
    loadFavs().then(function () {   // 拉最新分组（含新建的空分组）
      head.innerHTML = '<span>选择分组</span><button class="sheet-new-grp" id="newGrpBtn">＋ 新建分组</button>';
      btns.innerHTML = "";
      function opt(label, ico, val) {
        var isCur = (cur || "") === val;
        var b = document.createElement("button");
        b.className = "sheet-btn";
        b.innerHTML = '<span class="ico">' + ico + '</span><span>' + label +
          (isCur ? ' <span style="color:var(--accent,#4a7dff);font-size:12px;">（当前）</span>' : '') + '</span>';
        if (isCur) b.style.fontWeight = "600";
        b.addEventListener("click", function () { closeSheet(); cb(val); });
        btns.appendChild(b);
      }
      opt("其他", "📁", "");
      // 服务端登记的分组（含空分组）+ 有收藏但未登记的分组
      var names = [], seen = {};
      favGroupOrder.forEach(function (g) {
        if (g && g !== "__ungrouped__" && !seen[g]) { names.push(g); seen[g] = 1; }
      });
      favs.forEach(function (f) {
        var g = f.group || "";
        if (g && !seen[g]) { names.push(g); seen[g] = 1; }
      });
      names.forEach(function (g) { opt(esc(g), "🏷️", g); });
      document.getElementById("newGrpBtn").addEventListener("click", function () { closeSheet(); cb("__new__"); });
      document.getElementById("sheetMask").classList.add("show");
      document.getElementById("sheet").classList.add("show");
    });
  }
  function newGroupThen(cb) {
    closeSheet();
    showDialog("新建分组", "", function (v) {
      v = (v || "").trim();
      if (!v) { toast("分组名不能为空", "warn"); return; }
      cb(v);
    });
  }
  document.getElementById("addFavBtn").addEventListener("click", function () {
    toggleAddMenu(false);
    if (isCurFav()) { toggleFav(); return; }
    pickGroup(function (g) {
      if (g === "__new__") newGroupThen(function (name) { addFav(name); });
      else addFav(g);
    });
  });
  // 收藏夹弹层：按分组展示，点条目跳转，✏️ 改分组/重命名，🗑️ 删除分组/取消收藏
  function fmtAdded(s) {          // 收藏时间（epoch 秒）→ 简短显示
    if (!s) return "";
    var d = new Date(s * 1000);
    if (isNaN(d.getTime())) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return fmtTime(d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()));
  }
  function renderFavRows(list, wrap) {
    list.forEach(function (f) {
      var row = document.createElement("div");
      row.className = "fav-row";
      row.title = f.path;
      row.innerHTML = '<span class="ico">' + iconFor(f) + '</span><span class="fav-name">' + esc(f.name || f.path) + '</span>' +
        '<span class="fav-time">' + esc(fmtAdded(f.added)) + '</span>' +
        '<button class="fav-mini" data-a="grp" title="移动到其他分组">🏷️</button>' +
        '<button class="fav-mini" data-a="del" title="取消收藏">💔</button>';
      row.addEventListener("click", function () {
        if (f.is_dir === false) {          // 文件收藏：跳到所在文件夹并高亮
          closeSheet();
          gotoAndHighlight(dirnameOf(f.path), f.name || f.path.split("/").pop());
          return;
        }
        closeSheet(); load(f.path);
      });
      row.querySelector('[data-a="grp"]').addEventListener("click", function (e) {
        e.stopPropagation();
        pickGroup(function (g) {
          if (g === (f.group || "")) { openFavSheet(); return; }
          if (g === "__new__") {
            newGroupThen(function (name) {
              setFavGroup(f.path, name).then(function () {
                toast("已移至分组「" + name + "」", "success");
                openFavSheet();
              });
            });
            return;
          }
          setFavGroup(f.path, g).then(function () {
            toast(g ? "已移至分组「" + g + "」" : "已移至其他", "success");
            openFavSheet();
          });
        }, f.group || "");
      });
      row.querySelector('[data-a="del"]').addEventListener("click", function (e) {
        e.stopPropagation();
        confirmBox({
          title: "取消收藏",
          message: "取消收藏「" + (f.name || f.path) + "」？",
          okText: "取消收藏", danger: true,
          onOk: function () {
            fetch("/api/favorites", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: f.path }),
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d.error) { toast(d.error, "error"); return; }
                toast("已取消收藏", "success");
                loadFavs().then(openFavSheet);
              });
          }
        });
      });
      wrap.appendChild(row);
    });
  }
  function favGroupHead(g, btns) {
    var head = document.createElement("div");
    head.className = "fav-grp-head";
    head.innerHTML = '<span>🏷️ ' + esc(g) + '</span><span class="fav-acts">' +
      '<button class="fav-mini" data-a="ren" title="重命名分组">✏️</button>' +
      '<button class="fav-mini" data-a="rm" title="删除分组">🗑️</button></span>';
    head.querySelector('[data-a="ren"]').addEventListener("click", function () {
      showDialog("重命名分组", g, function (v) {
        v = (v || "").trim();
        if (!v || v === g) return;
        fetch("/api/favorites/group", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old: g, name: v }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.error) { toast(d.error, "error"); return; }
            toast("分组已重命名", "success");
            openFavSheet();
          });
      });
    });
    head.querySelector('[data-a="rm"]').addEventListener("click", function () {
      confirmBox({
        title: "删除分组",
        message: "删除分组「" + g + "」？其中的收藏会保留（移入「其他」）",
        okText: "删除分组", danger: true,
        onOk: function () {
          fetch("/api/favorites/group", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: g }),
          })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.error) { toast(d.error, "error"); return; }
              toast("分组已删除", "success");
              openFavSheet();
            });
        }
      });
    });
    btns.appendChild(head);
  }
  function openFavSheet() {
    loadFavs().then(function () {
      document.getElementById("sheetHead").textContent = "⭐ 收藏夹";
      document.getElementById("sheet").classList.add("favmode");
      var btns = document.getElementById("sheetBtns");
      btns.innerHTML = "";
      if (!favs.length) {
        var tip = document.createElement("div");
        tip.className = "sheet-tip";
        tip.textContent = "还没有收藏：点右上角 ＋ → 「收藏当前文件夹」";
        btns.appendChild(tip);
        document.getElementById("sheetMask").classList.add("show");
        document.getElementById("sheet").classList.add("show");
        return;
      }
      var gs = favGroups();
      // 分组 tab（横向滚动，吸顶）：全部 / 各分组 / 其他；带数量统计，可长按拖动排序（除「全部」）
      var tabRow = document.createElement("div");
      tabRow.className = "fav-tabs";
      var favList = document.createElement("div");   // 列表内容容器：切换 tab 时只清它，不让 tab 行重挂导致滚动复位
      var favTabDragEnd = 0;        // 拖动结束时间戳，防止误触发 click
      // tab 顺序：已保存顺序 → 未登记分组 → 其他（"__ungrouped__" 占位）
      var tabSeq = [];
      (function () {
        var seen = {}, hasUngrouped = !!gs.map[""];
        favGroupOrder.forEach(function (g) {
          if (g === "__ungrouped__") {
            if (hasUngrouped && !seen[""]) { tabSeq.push(""); seen[""] = 1; }
            return;
          }
          if (g && !seen[g]) { tabSeq.push(g); seen[g] = 1; }   // 空分组（还没有收藏）也显示
        });
        gs.names.forEach(function (g) { if (g && !seen[g]) { tabSeq.push(g); seen[g] = 1; } });
        if (hasUngrouped && !seen[""]) tabSeq.push("");
      })();
      function centerTab(t) {
        var r = t.getBoundingClientRect(), pr = tabRow.getBoundingClientRect();
        if (r.left < pr.left + 4 || r.right > pr.right - 4) {
          tabRow.scrollLeft = Math.max(0, t.offsetLeft - (tabRow.clientWidth - t.offsetWidth) / 2);
        }
      }
      function renderList(active) {
        // active: "__all__" = 全部分组；"" = 其他；其它 = 分组名
        favList.innerHTML = "";
        Array.prototype.forEach.call(tabRow.children, function (t) {
          var on = t.dataset.g === active;
          t.classList.toggle("on", on);
          if (on) centerTab(t);
        });
        if (active === "__all__") {
          if (gs.map[""]) renderFavRows(gs.map[""], favList);
          gs.names.forEach(function (g) {
            if (!g) return;
            favGroupHead(g, favList);
            renderFavRows(gs.map[g], favList);
          });
        } else {
          if (active) favGroupHead(active, favList);   // 单分组视图也保留重命名/删除入口
          renderFavRows(gs.map[active] || [], favList);
        }
        var tip2 = document.createElement("div");
        tip2.className = "sheet-tip";
        tip2.textContent = "点名称跳转 · 长按 tab 拖动排序 · 🏷️ 改分组/重命名 · 🗑️ 删除分组/取消收藏";
        favList.appendChild(tip2);
      }
      function addTab(label, val, cnt, draggable) {
        var t = document.createElement("button");
        t.className = "fav-tab";
        t.innerHTML = esc(label) + (typeof cnt === "number" ? '<span class="cnt">' + cnt + '</span>' : "");
        t.dataset.g = val;
        t.addEventListener("click", function () {
          if (Date.now() < favTabDragEnd) return;
          renderList(val);
        });
        if (draggable) makeTabDraggable(t);
        tabRow.appendChild(t);
      }
      // 长按 tab 拖动换位，松手后把新顺序持久化到服务端
      function makeTabDraggable(t) {
        var timer = null, sx = 0, sy = 0, moved = false;
        t.addEventListener("touchstart", function (e) {
          var tc = e.touches[0];
          sx = tc.clientX; sy = tc.clientY; moved = false;
          timer = setTimeout(function () { moved = true; t.classList.add("dragging"); }, 300);
        }, { passive: true });
        t.addEventListener("touchmove", function (e) {
          if (!moved) {
            var tc = e.touches[0];
            if (Math.abs(tc.clientX - sx) > 8 || Math.abs(tc.clientY - sy) > 8) {
              clearTimeout(timer); moved = false; timer = null;
            }
            return;
          }
          e.preventDefault();
          var tc = e.touches[0], target = null;
          Array.prototype.forEach.call(tabRow.children, function (o) {
            if (o === t || o.dataset.g === "__all__" || o.classList.contains("fav-tab-add")) return;
            var r = o.getBoundingClientRect();
            if (tc.clientX >= r.left && tc.clientX <= r.right && tc.clientY >= r.top && tc.clientY <= r.bottom) target = o;
          });
          if (target) {
            var r = target.getBoundingClientRect();
            tabRow.insertBefore(t, tc.clientX < r.left + r.width / 2 ? target : target.nextSibling);
          }
        }, { passive: false });
        t.addEventListener("touchend", function () {
          if (timer) { clearTimeout(timer); timer = null; }
          if (!moved) return;
          t.classList.remove("dragging");
          moved = false;
          favTabDragEnd = Date.now() + 400;
          var order = [];
          Array.prototype.forEach.call(tabRow.children, function (o) {
            var g = o.dataset.g;
            if (g !== "__all__" && !o.classList.contains("fav-tab-add")) {
              order.push(g === "" ? "__ungrouped__" : g);
            }
          });
          favGroupOrder = order;
          fetch("/api/favorites/group", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groups: order }),
          }).catch(function () { toast("排序保存失败", "error"); });
        });
      }
      addTab("全部", "__all__", favs.length, false);
      tabSeq.forEach(function (g) {
        if (g === "") addTab("其他", "", (gs.map[""] || []).length, true);
        else addTab(g, g, (gs.map[g] || []).length, true);
      });
      // ＋ 新建分组
      var plus = document.createElement("button");
      plus.className = "fav-tab fav-tab-add";
      plus.textContent = "＋";
      plus.title = "新建分组";
      plus.addEventListener("click", function () {
        if (Date.now() < favTabDragEnd) return;
        showDialog("新建分组", "", function (v) {
          v = (v || "").trim();
          if (!v) { toast("分组名不能为空", "warn"); return; }
          fetch("/api/favorites/group", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: v }),
          })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d.error) { toast(d.error, "error"); return; }
              toast("分组已创建", "success");
              loadFavs().then(openFavSheet);
            });
        });
      });
      tabRow.appendChild(plus);
      btns.appendChild(tabRow);     // tab 行只挂一次，切换分組不重挂 → 不抖动
      btns.appendChild(favList);
      renderList("__all__");
      document.getElementById("sheetMask").classList.add("show");
      document.getElementById("sheet").classList.add("show");
    });
  }
  document.getElementById("favBtn").addEventListener("click", openFavSheet);
  loadFavs();
