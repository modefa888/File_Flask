  // ---------- 文件信息 ----------
  function showProperties(item) {
    var mask = document.getElementById("propsMask");
    var card = document.getElementById("propsCard");
    var headThumb = '<span class="sh-thumb">' + _titleThumbHtml(item) + '</span>';
    card.innerHTML = '<div class="props-title">' + headThumb + '<span>属性</span></div><div class="empty">加载中…</div>';
    mask.classList.add("show");
    fetch("/api/properties?path=" + encodeURIComponent(itemAbs(item)))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) {
          card.innerHTML = '<div class="props-title">' + headThumb + '<span>属性</span></div><div class="empty">' + esc(d.error) + '</div>';
          return;
        }
        card.innerHTML = buildPropsHtml(d, headThumb);
      })
      .catch(function () {
        card.innerHTML = '<div class="props-title">' + headThumb + '<span>属性</span></div><div class="empty">加载失败</div>';
      });
  }
  function buildPropsHtml(d, headThumb) {
    function row(label, value, copyable) {
      if (value == null || value === "") value = "-";
      return '<div class="prop-row"><span class="prop-label">' + label + '</span>' +
        '<span class="prop-value' + (copyable ? ' copyable" data-copy="' + esc(value) : '') + '">' +
        esc(value) + '</span></div>';
    }
    var h = '<div class="props-title">' + (headThumb || "") +
      '<span>' + (d.is_dir ? "文件夹属性" : "属性") + '</span></div>';
    h += row("名称", d.name, true);
    h += row("类型", d.is_dir ? "文件夹" : (d.mime_type || "未知"));
    h += row("大小", d.size_str);
    if (!d.is_dir && d.ext) h += row("扩展名", d.ext);
    h += row("路径", d.path, true);
    h += row("所在目录", d.parent, true);
    h += row("创建时间", d.created);
    h += row("修改时间", d.modified);
    h += row("权限", d.permissions);
    if (d.is_dir) {
      h += '<div class="prop-row"><span class="prop-label">内容</span><span class="prop-value">子文件夹 ' +
        (d.sub_dirs || 0) + ' 个 · 子文件 ' + (d.sub_files || 0) + ' 个</span></div>';
      h += '<div class="prop-row"><span class="prop-label">总计</span><span class="prop-value">' +
        (d.total_dirs || 0) + ' 个文件夹 · ' + (d.total_files || 0) + ' 个文件 · ' + (d.size_str || "-") + '</span></div>';
    }
    h += '<button class="props-close">关闭</button>';
    return h;
  }
  document.getElementById("propsMask").addEventListener("click", function (e) {
    if (e.target === this) this.classList.remove("show");
  });
  document.getElementById("propsCard").addEventListener("click", function (e) {
    if (e.target.closest(".props-close")) {
      document.getElementById("propsMask").classList.remove("show");
      return;
    }
    var c = e.target.closest(".prop-value.copyable");
    if (c) copyText(c.getAttribute("data-copy"), "已复制");
  });
