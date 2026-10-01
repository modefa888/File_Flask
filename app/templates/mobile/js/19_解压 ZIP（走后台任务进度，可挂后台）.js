  // ---------- 解压 ZIP（走后台任务进度，可挂后台） ----------
  function doUnzip(item) {
    var abs = itemAbs(item);
    var opts = { path: abs };
    if (typeof _zipPwd === "string" && _zipPwd) opts.password = _zipPwd;   // 加密 RAR 透传密码
    bgStart("uz", "/api/zip/unzip/start", opts, {
      title: "正在解压…",
      label: "解压",
      onDone: function (ok, d) {
        if (ok && d && d.result && d.result.files != null) {
          toast("已解压 " + d.result.files + " 个文件到「" + d.result.name + "」", "success");
        }
        // 本地插入解压出的目录条目，不重新请求 /api/files（大目录会超时）
        if (ok && d && d.result && d.result.name && d.result.path &&
            normDirPath(dirnameOf(d.result.path)) === normDirPath(state.path)) {
          localAddItem({ name: d.result.name, path: d.result.name, abs_path: d.result.path,
            is_dir: true, size: 0, size_str: "", mtime: nowStrLocal() });
        }
      },
      legacy: function () { legacyUnzip(item); }
    });
  }
  function legacyUnzip(item) {   // 旧同步接口兜底（无进度条）
    var abs = itemAbs(item);
    fetchTimeout("/api/zip/unzip", 120000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: abs })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        toast("已解压 " + d.files + " 个文件到「" + d.name + "」", "success");
        if (d.path && normDirPath(dirnameOf(d.path)) === normDirPath(state.path)) {
          localAddItem({ name: d.name, path: d.name, abs_path: d.path,
            is_dir: true, size: 0, size_str: "", mtime: nowStrLocal() });
        }
      })
      .catch(function () { toast("解压失败", "error"); });
  }
