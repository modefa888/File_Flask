  // ---------- 新建文件夹 / 文件 ----------
  function promptCreate(title, defName, isDir) {
    showDialog(title, defName, function (name) {
      name = (name || "").trim();
      if (!name) return;
      if (!isDir && name.indexOf(".") < 0) name += ".txt";   // 无扩展名时按文本文件创建
      fetch("/api/files/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.path || "", name: name, is_dir: isDir })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { toast(d.error, "error"); return; }
          toast("已创建 " + (d.name || name), "success");
          load(state.path);
        })
        .catch(function () { toast("创建失败", "error"); });
    });
  }
  function doNewFolder() { promptCreate("新建文件夹", "新文件夹", true); }
  function doNewFile() { promptCreate("新建文件", "新文件.txt", false); }
