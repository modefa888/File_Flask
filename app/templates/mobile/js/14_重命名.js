  // ---------- 重命名 ----------
  function doRename(item) {
    showDialog("重命名为", item.name, function (newName) {
      newName = (newName || "").trim();
      if (!newName || newName === item.name) return;
      var abs = itemAbs(item);
      fetch("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: abs, new_name: newName })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.success) { toast("已重命名", "success"); load(state.path); }
          else toast(d.error || "重命名失败", "error");
        })
        .catch(function () { toast("重命名失败", "error"); });
    });
  }
