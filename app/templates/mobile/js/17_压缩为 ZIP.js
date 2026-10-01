  // ---------- 压缩为 ZIP ----------
  function doCompress(item) {
    var abs = itemAbs(item);
    var destDir = dirnameOf(abs);
    // 默认压缩包名：条目名_日期时间（精确到秒）
    var d = new Date();
    var ts = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
      + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
    showDialog("压缩为 ZIP（存于 " + destDir + "）", (item.name || "压缩包") + "_" + ts, function (name) {
      name = (name || "").trim();
      if (!name) { toast("请输入压缩包名称", "warn"); return; }
      // 走后台任务进度（同解压），可挂后台胶囊显示挂载状态
      bgStart("zip", "/api/zip/create/start", { paths: [abs], dest_dir: destDir, name: name }, {
        title: "正在压缩…",
        label: "压缩",
        onDone: function (ok, dd) {
          if (ok && dd && dd.result) {
            toast("已生成 " + dd.result.name + (dd.result.size_str ? "（" + dd.result.size_str + "）" : ""), "success");
          }
          // 本地插入新 zip 条目，不重新请求 /api/files（大目录会超时）
          if (ok && dd && dd.result && normDirPath(dirnameOf(abs)) === normDirPath(state.path)) {
            localAddItem({ name: dd.result.name, path: dd.result.name, abs_path: dd.result.path,
              is_dir: false, size: dd.result.size || 0,
              size_str: dd.result.size_str || fmtDelBytes(dd.result.size || 0),
              ext: "zip", type: "ZIP", mtime: nowStrLocal() });
          }
        },
        legacy: function () { legacyZipCreate([abs], destDir, name); }
      });
    });
  }
