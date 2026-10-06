  // ---------- 复制到剪贴板 ----------
  // 注意：用 http://192.168.x.x 这类局域网地址访问时不是安全上下文，navigator.clipboard
  // 不可用，只能退回 execCommand("copy")；而 execCommand 失败时不抛错、只返回 false，
  // 所以必须检查返回值再提示成功；iOS 上还得配合 setSelectionRange 才能真正选中内容。
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || "已复制", "success"); };
    var fail = function () { toast("复制失败，请长按链接手动复制", "error"); };
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;" +
        "border:0;outline:0;opacity:0;font-size:16px;";
      document.body.appendChild(ta);
      var ok = false;
      try {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);   // iOS 仅 select() 选不中内容
        ok = document.execCommand("copy");
      } catch (e) { ok = false; }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      if (ok) done(); else fail();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
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
