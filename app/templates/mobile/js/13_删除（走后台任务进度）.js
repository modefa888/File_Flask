  // ---------- 删除（走后台任务进度） ----------
  function startDelete(paths, onDone) {
    bgStart("del", "/api/delete/start", { paths: paths }, {
      title: paths.length > 1 ? "正在删除 " + paths.length + " 项…" : "正在删除…",
      label: "删除",
      onDone: function (ok) {
        if (ok) toast("删除成功", "success");
        if (onDone) onDone(ok);
      },
      legacy: function () { legacyDelete(paths); }
    });
  }
  function legacyDelete(paths) {   // 旧同步接口兜底（无进度条）
    fetchTimeout("/api/delete", 120000, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: paths })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        if (d.errors && d.errors.length) toast("删除完成，部分失败", "error");
        else toast("删除成功", "success");
        localRemoveItems(paths);
      })
      .catch(function () { toast("删除请求失败", "error"); });
  }
