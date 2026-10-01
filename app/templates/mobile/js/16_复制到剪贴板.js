  // ---------- 复制到剪贴板 ----------
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || "已复制", "success"); };
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败", "error"); }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  // 旧同步压缩接口兜底（后端未升级时使用，无进度条）
  function legacyZipCreate(paths, destDir, name) {
    fetch("/api/zip/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: paths, dest_dir: destDir, name: name })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        toast("已生成 " + (d.name || name) + (d.size_str ? "（" + d.size_str + "）" : ""), "success");
        if (normDirPath(destDir) === normDirPath(state.path)) {
          localAddItem({ name: d.name || name + ".zip", path: d.name || name + ".zip",
            is_dir: false, size: d.size || 0, size_str: d.size_str || "",
            ext: "zip", type: "ZIP", mtime: nowStrLocal() });
        }
      })
      .catch(function () { toast("压缩失败", "error"); });
  }
