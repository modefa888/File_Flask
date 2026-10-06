  // ---------- 预览 ----------
  // 缩略图懒加载：横向缩略图条可能有上百张，逐个创建 <img> 并设 src 会一次性并发
  // 几十上百个请求（横向滚动容器里 loading="lazy" 基本不生效）。
  // 这里改为先只记 URL，元素进入可视区附近才真正加载。
  var _pvThumbObserver = null;
  function observePvThumb(el) {
    var url = el.dataset && el.dataset.src;
    if (!url) return;
    if (typeof IntersectionObserver === "undefined") {   // 老浏览器：直接加载
      el.src = url;
      return;
    }
    if (!_pvThumbObserver) {
      _pvThumbObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var img = en.target;
          if (!img.getAttribute("src") && img.dataset.src) img.src = img.dataset.src;
          _pvThumbObserver.unobserve(img);
        });
      }, { rootMargin: "160px 0px" });                   // 左右各预载 160px
    }
    _pvThumbObserver.observe(el);
  }

  function openPreview(item, contextItems) {
    // 上一次看图留下的缩略图观察器先清掉（缩略图条马上会重建）
    if (_pvThumbObserver) { _pvThumbObserver.disconnect(); _pvThumbObserver = null; }
    document.getElementById("previewBody").classList.remove("fullscreen");   // 复位上一次的全屏态
    var ext = extOf(item.name);
    var abs = itemAbs(item);
    // 音频走独立播放器，不占用预览遮罩（避免遮罩停留在“加载中…”）
    if (AUDIO_EXT.indexOf(ext) >= 0) {
      openAudioPlayer(item, contextItems);
      return;
    }
    // 视频直接进新版播放器：不占用预览遮罩，也不再出现中间卡片
    if (VIDEO_EXT.indexOf(ext) >= 0) {
      vpOpenVideo(item, abs, contextItems);
      return;
    }
    // 图片走 PhotoSwipe 全屏看图器（自带缩放 / 滑动切换），不占用预览遮罩
    if (MOBILE_IMG_EXT.indexOf(ext) >= 0) {
      openImageGallery(item, contextItems);
      return;
    }
    var mask = document.getElementById("previewMask");
    var body = document.getElementById("previewBody");
    body.innerHTML = '<div class="preview-msg">加载中…</div>';
    document.getElementById("previewClose").style.display = "";
    mask.classList.add("show");

    if (TEXT_EXT.indexOf(ext) >= 0) {
      fetchTimeout("/api/preview?path=" + encodeURIComponent(abs), 15000)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { body.innerHTML = '<div class="preview-msg">' + esc(d.error) + '</div>'; return; }
          var bin = atob(d.content);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var text = new TextDecoder("utf-8").decode(bytes);
          buildTextPreview(item, text);
        })
        .catch(function (e) {
          var msg = (e && e.name === "AbortError") ? "加载超时" : (e.message || e);
          body.innerHTML = '<div class="preview-msg">预览失败: ' + esc(msg) + '</div>';
        });
      return;
    }
    // 压缩包：直接打开压缩包查看器（浏览/解压/下载包内文件）
    if (ext === "zip" || ext === "rar") {
      mask.classList.remove("show");
      body.innerHTML = "";
      openZipViewer(item);
      return;
    }
    body.innerHTML = '<div class="preview-msg">暂不支持预览该类型<br/>（移动版仅支持 图片 / 视频 / 文本 / 压缩包）</div>';
  }
  // ---------- 视频：直接进新版播放器（不再有中间预览卡片） ----------
  var VP_MIN_SIZE = 5 * 1024 * 1024;   // 小于 5MB 的小视频不进播放队列（当前播放项除外）

  // 播放队列：外部上下文（媒体集合 / 搜索结果）> 当前目录 > 同级目录
  function vpBuildQueue(list, dirAbs, curAbs, curName) {
    var out = [], hasCur = false;
    (list || []).forEach(function (it) {
      if (isDir(it) || VIDEO_EXT.indexOf(extOf(it.name)) < 0) return;
      var abs = it.abs_path || joinPath(dirAbs, it.name);
      if (abs === curAbs) {
        hasCur = true;                       // 当前项一定保留（再小也留着）
      } else if (it.size != null && it.size < VP_MIN_SIZE) {
        return;
      }
      out.push({ name: it.name, abs: abs });
    });
    if (!hasCur) out.unshift({ name: curName, abs: curAbs });
    return out;
  }

  function vpQueueIndex(queue, abs) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].abs === abs) return i;
    }
    return 0;
  }

  function vpOpenVideo(item, abs, contextItems) {
    var dirAbs = abs.slice(0, abs.lastIndexOf("/")) || "/";
    var ctx = (contextItems || []).filter(function (it) {
      return !isDir(it) && VIDEO_EXT.indexOf(extOf(it.name)) >= 0;
    });
    if (ctx.length > 1) {
      var q1 = vpBuildQueue(ctx, dirAbs, abs, item.name);
      openVPlayer(q1, vpQueueIndex(q1, abs));
      return;
    }
    if (normDirPath(dirAbs) === normDirPath(state.path) && state.items && state.items.length) {
      var q2 = vpBuildQueue(state.items, dirAbs, abs, item.name);
      openVPlayer(q2, vpQueueIndex(q2, abs));
      return;
    }
    // 媒体集合里的文件不一定在当前目录：拉同级目录视频作为播放队列
    fetchTimeout("/api/files?path=" + encodeURIComponent(dirAbs) + "&limit=0&offset=0", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var q3 = vpBuildQueue(d.items || [], dirAbs, abs, item.name);
        openVPlayer(q3, vpQueueIndex(q3, abs));
      })
      .catch(function () {
        openVPlayer([{ name: item.name, abs: abs }], 0);   // 拉取失败：至少能播当前这个
      });
  }

  // 图片查看器：PhotoSwipe（全屏看图，自带双指缩放 / 双击放大 / 左右滑动切换 / 下滑关闭）
  // 打开前批量取原图真实尺寸（服务端只读文件头），避免初始构图跳动、双击放大比例不准。
  function openImageGallery(item, contextItems) {
    var abs = itemAbs(item);
    var dirAbs = abs.slice(0, abs.lastIndexOf("/")) || "/";
    // 预览遮罩若残留（例如刚看完文本），先收起，避免盖住看图器
    var mask = document.getElementById("previewMask");
    if (mask && mask.classList.contains("show")) {
      mask.classList.remove("show");
      document.getElementById("previewBody").innerHTML = "";
      document.getElementById("previewClose").style.display = "";
    }

    function open(list) {
      if (!list.length) list = [{ path: abs, name: item.name }];
      pswpOpen(list, abs);
    }

    var ctx = pswpCollect(contextItems, dirAbs);
    if (ctx.length > 1) { open(ctx); return; }          // 媒体集合 / 搜索结果等上下文优先
    if (normDirPath(dirAbs) === normDirPath(state.path) && state.items && state.items.length) {
      var cur = pswpCollect(state.items, dirAbs);
      if (cur.length) { open(cur); return; }            // 当前目录：可左右滑动切换同级图片
    }
    // 媒体集合里的图片不一定在当前目录：拉同级目录补齐
    fetchTimeout("/api/files?path=" + encodeURIComponent(dirAbs) + "&limit=0&offset=0", 10000)
      .then(function (r) { return r.json(); })
      .then(function (d) { open(pswpCollect(d.items || [], dirAbs)); })
      .catch(function () { open([]); });
  }

  // 目录项 → 图片列表（过滤目录与非图片）
  function pswpCollect(items, dirAbs) {
    var out = [];
    (items || []).forEach(function (it) {
      if (isDir(it) || MOBILE_IMG_EXT.indexOf(extOf(it.name)) < 0) return;
      out.push({ path: it.abs_path || joinPath(dirAbs, it.name), name: it.name });
    });
    return out;
  }

  // 批量取原图尺寸（服务端只读文件头，很快）
  function pswpFetchSizes(paths) {
    return fetchTimeout("/api/imagesize", 10000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: paths })
    }).then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.sizes) || {}; })
      .catch(function () { return {}; });
  }

  // 尺寸缺失（接口异常 / SVG 等无法解析）时，用缩略图的实际像素补上：
  // 比例正确才能避免图片被拉伸，缩略图本身随后会被查看器当占位图复用（走浏览器缓存）。
  function pswpFillSizes(list, sizes) {
    var jobs = [];
    list.forEach(function (it) {
      if (sizes[it.path]) return;
      jobs.push(new Promise(function (resolve) {
        var im = new Image();
        im.onload = function () {
          if (im.naturalWidth && im.naturalHeight) sizes[it.path] = [im.naturalWidth, im.naturalHeight];
          resolve();
        };
        im.onerror = function () { resolve(); };
        im.src = "/api/thumbnail?path=" + encodeURIComponent(it.path);
      }));
    });
    return Promise.all(jobs).then(function () { return sizes; });
  }

  // 浏览器不能直接渲染的格式（TIFF / HEIC 等）交给服务端转码成 JPEG，
  // 其余图片仍走 /api/raw 原图直出。
  var PSWP_TRANSCODE_EXT = ["tif", "tiff", "heic", "heif", "avif"];
  function pswpSlideSrc(path, stamp) {
    if (PSWP_TRANSCODE_EXT.indexOf(extOf(path)) >= 0) {
      return "/api/image?path=" + encodeURIComponent(path) + "&max=2560&_=" + stamp;
    }
    return "/api/raw?path=" + encodeURIComponent(path) + "&_=" + stamp;
  }

  function pswpOpen(list, curPath) {
    if (typeof window.PhotoSwipe !== "function") {
      toast("图片查看器组件未加载，请刷新页面重试", "error");
      return;
    }
    var index = 0, i;
    for (i = 0; i < list.length; i++) { if (list[i].path === curPath) { index = i; break; } }
    var paths = list.map(function (it) { return it.path; });
    pswpFetchSizes(paths)
      .then(function (sizes) { return pswpFillSizes(list, sizes); })
      .then(function (sizes) {
        var stamp = String(Date.now());
        var ds = list.map(function (it) {
          var s = sizes[it.path];
          var w = Number(s && s[0]) || 1200;
          var h = Number(s && s[1]) || 1600;
          return {
            src: pswpSlideSrc(it.path, stamp),   // 原图直出（浏览器不支持的格式自动走服务端转码）
            width: Math.max(1, Math.round(w)),
            height: Math.max(1, Math.round(h)),
            alt: it.name,
            name: it.name,
            absPath: it.path,
            // 只给底部缩略图条用；不设 msrc/element，避免缩略图被渲染进看图区
            thumb: "/api/thumbnail?path=" + encodeURIComponent(it.path)
          };
        });
        pswpShow(ds, index);
      });
  }

  function pswpShow(ds, index) {
    var pswp = new window.PhotoSwipe({
      dataSource: ds,
      index: index,
      bgOpacity: 1,                 // 完全不透明：否则下层列表页会隐约透出来
      showHideAnimationType: "fade",
      initialZoomLevel: "fit",
      secondaryZoomLevel: 1,        // 双击放大到 100% 像素
      maxZoomLevel: 4,
      spacing: 0.08,
      preload: [1, 2],
      loop: false,
      pinchToClose: true,
      closeOnVerticalDrag: true,
      wheelToZoom: true,
      clickToCloseNonZoomable: false,
      imageClickAction: "zoom-or-close",
      bgClickAction: "close",
      tapAction: "toggle-controls",
      doubleTapAction: "zoom",
      maxWidthToAnimate: 4000,
      errorMsg: "图片加载失败",
      closeTitle: "关闭",
      zoomTitle: "缩放",
      arrowPrevTitle: "上一张",
      arrowNextTitle: "下一张",
      indexIndicatorSep: " / ",
      mainClass: "pswp--imgviewer"
    });
    // 锁住列表页滚动（用内联样式而不是 .lock 类，避免和确认框的 lock 互相抵消）
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    pswpRaiseDialogs(true);
    pswp.on("uiRegister", function () { pswpRegisterUI(pswp); });
    // 内容重建（切图回来 / 延迟加载完成）后按记录的角度恢复旋转
    pswp.on("change", function () { pswpApplyRot(pswp.currSlide); });
    pswp.on("contentLoad", function () { pswpApplyRot(pswp.currSlide); });
    // 缩放 / 拖动时同步旋转尺寸（第二个参数 true = 不重试，避免高频调用堆积定时器）
    pswp.on("zoomPanUpdate", function () { pswpApplyRot(pswp.currSlide, true); });
    pswp.on("close", function () {
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
      pswpRaiseDialogs(false);
      if (_pvThumbObserver) { _pvThumbObserver.disconnect(); _pvThumbObserver = null; }
      // 收起动画结束后销毁实例与 DOM，避免多次打开堆积节点
      setTimeout(function () { try { pswp.destroy(); } catch (e) {} }, 400);
    });
    pswp.init();
  }

  // 看图器层级是 100000，项目里的确认框 / 下载进度框 / 分享面板都在它下面。
  // 打开看图器期间临时把它们提到最上层，这样二次确认、分享面板都能浮在图片之上。
  function pswpRaiseDialogs(on) {
    var ids = ["confirmBox", "dlProgBox", "delProgBox",
               "shareMask", "shareSheet", "sharePage", "toastWrap"];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.zIndex = on ? "100001" : "";
    });
  }

  // ---------- 图片旋转 ----------
  // 旋转时交换图片宽高并让 PhotoSwipe 按新方向重排；图片本身按“未旋转”的比例定尺寸后整体旋转，
  // 旋转后的视觉尺寸正好等于容器，因此居中、撑满、不留黑边。
  // 旋转落点：优先 content 容器（.pswp__content，或它自身就是 <img>）。
  // holderElement（.pswp__zoom-wrap）承载 PhotoSwipe 的 translate/scale，绝不能加旋转。
  function pswpRotTarget(slide) {
    if (!slide) return null;
    var content = slide.content && slide.content.element;
    var holder = slide.holderElement;
    var list = [];
    if (content && content !== holder) list.push(content);
    if (holder) list.push(holder);
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r.querySelector !== "function") continue;
      if (r.tagName === "IMG") return r;          // 内容本身就是图片
      var im = r.querySelector("img");
      if (im) return im;
    }
    // 兜底：看图器内水平方向可见的那张图（前后各有一张预加载的）
    var all = document.querySelectorAll(".pswp .pswp__img");
    for (var k = 0; k < all.length; k++) {
      var rct = all[k].getBoundingClientRect();
      if (rct.width > 0 && rct.left < window.innerWidth && rct.right > 0) return all[k];
    }
    return null;
  }

  function pswpApplyRot(slide, retry) {
    if (!slide || !slide.data) return;
    var rot = Number(slide.data.rot) || 0;
    var img = pswpRotTarget(slide);
    if (!img) {
      // 内容还没创建好（刚切过来）时补一次
      if (!retry) setTimeout(function () { pswpApplyRot(slide, true); }, 150);
      return;
    }
    if (!rot) {                                   // 0°：清掉旋转样式
      img.classList.remove("pswp-rot-q", "rot-90", "rot-270");
      img.style.transform = "";
      img.style.transformOrigin = "";
      return;
    }
    if (rot % 180 === 0) {                        // 180°：比例不变，直接翻转
      img.classList.remove("pswp-rot-q", "rot-90", "rot-270");
      img.style.transformOrigin = "50% 50%";
      img.style.transform = "rotate(" + rot + "deg)";
      return;
    }
    // 90 / 270：按“未旋转”的比例给图片定尺寸（宽高互换）再整体旋转。
    // 尺寸统一由 slide 尺寸 × 当前缩放算出（幂等），缩放/拖动时同步刷新即可，无需读 DOM。
    var zoom = Number(slide.currZoomLevel) || 1;
    var w = (Number(slide.width) || 0) * zoom;
    var h = (Number(slide.height) || 0) * zoom;
    if (!w || !h) {
      if (!retry) setTimeout(function () { pswpApplyRot(slide, true); }, 150);
      return;
    }
    img.style.setProperty("--pswp-rot-w", h + "px");
    img.style.setProperty("--pswp-rot-h", w + "px");
    img.classList.add("pswp-rot-q", "rot-" + rot);
  }

  function pswpRotate(pswp) {
    var slide = pswp && pswp.currSlide;
    if (!slide || !slide.data) return;
    var d = slide.data;
    d.rot = ((Number(d.rot) || 0) + 90) % 360;   // 记录角度，切回来仍保持
    // 90/270 时交换宽高：让 PhotoSwipe 按旋转后的方向重新布局并重算缩放边界
    if (d.rot % 180 === 90) {
      var t = d.width; d.width = d.height; d.height = t;
    }
    // 不用 refreshSlideContent —— 它会重建内容并重新下载原图；
    // 把新尺寸同步给当前 slide，让 PhotoSwipe 重算布局与缩放边界就够了
    try {
      slide.width = d.width;
      slide.height = d.height;
    } catch (e) {}
    if (pswp.updateSize) pswp.updateSize(true);
    pswpApplyRot(slide);
    setTimeout(function () { pswpApplyRot(slide, true); }, 80);   // 布局完成后校正一次
  }

  function pswpRegisterUI(pswp) {
    // 当前文件名：放在图片下方（顶栏只留计数器与操作按钮）
    pswp.ui.registerElement({
      name: "filename", className: "pswp-fname", order: 50, isButton: false, appendTo: "root",
      onInit: function (el) {
        function upd() {
          var s = pswp.currSlide;
          el.textContent = (s && s.data && s.data.name) || "";
        }
        upd();
        pswp.on("change", upd);
      }
    });
    // 旋转（每次顺时针 90°）
    pswp.ui.registerElement({
      name: "rotate", order: 6, isButton: true, appendTo: "bar",
      title: "旋转", ariaLabel: "旋转",
      html: { isCustomSVG: true, size: 24, inner: '<path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11a7.9 7.9 0 0 0-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.91v2.02c1.39-.22 2.68-.74 3.81-1.47l-1.44-1.44c-.73.53-1.55.86-2.37.89zm3.89-1.62l1.42 1.42A7.9 7.9 0 0 0 19.93 13h-2.02c-.14.87-.48 1.72-1.02 2.47z"/>' },
      onClick: function (e, el, pswp) { pswpRotate(pswp); }
    });
    // 下载当前图片
    pswp.ui.registerElement({
      name: "download", order: 8, isButton: true, appendTo: "bar",
      title: "下载", ariaLabel: "下载",
      html: { isCustomSVG: true, size: 24, inner: '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>' },
      onClick: function (e, el, pswp) {
        var s = pswp.currSlide;
        if (!s || !s.data || !s.data.absPath) return;
        var item = { name: s.data.name, abs_path: s.data.absPath };
        // 二次确认后再下载（确认框已被临时提到看图器之上，不用退出看图）
        confirmBox({
          title: "下载文件",
          message: "确认下载「" + item.name + "」？",
          okText: "下载",
          onOk: function () { download(item); }
        });
      }
    });
    // 分享当前图片
    pswp.ui.registerElement({
      name: "share", order: 9, isButton: true, appendTo: "bar",
      title: "分享", ariaLabel: "分享",
      html: { isCustomSVG: true, size: 24, inner: '<path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/>' },
      onClick: function (e, el, pswp) {
        var s = pswp.currSlide;
        if (!s || !s.data || !s.data.absPath) return;
        // 分享面板层级已在打开看图器时提升，直接浮在图片上方，不退出预览
        openShareSheet({ name: s.data.name, abs_path: s.data.absPath });
      }
    });
    // 底部缩略图条（同级图片，点击切图）
    pswp.ui.registerElement({
      name: "thumbbar", className: "pswp-tb", order: 100, isButton: false, appendTo: "root",
      html: '<div class="pswp-tb-track"></div>',
      onInit: function (el) { pswpBuildThumbBar(el.querySelector(".pswp-tb-track"), pswp); }
    });
  }

  function pswpBuildThumbBar(track, pswp) {
    if (!track) return;
    var n = pswp.getNumItems ? pswp.getNumItems() : 0;
    if (n <= 1) { track.parentNode.style.display = "none"; return; }
    for (var i = 0; i < n; i++) {
      var d = pswp.getItemData(i) || {};
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pswp-tb-item" + (i === pswp.currIndex ? " cur" : "");
      btn.setAttribute("data-i", i);
      btn.title = d.name || "";
      var im = document.createElement("img");
      im.alt = "";
      im.dataset.src = d.thumb;           // 进入可视区附近才真正加载
      btn.appendChild(im);
      (function (idx) {
        btn.addEventListener("click", function () { pswp.goTo(idx); });
      })(i);
      track.appendChild(btn);
      observePvThumb(im);
    }
    pswpMarkThumb(track, pswp.currIndex);
    pswp.on("change", function () { pswpMarkThumb(track, pswp.currIndex); });
  }

  function pswpMarkThumb(track, idx) {
    var nodes = track.children;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle("cur", Number(nodes[i].getAttribute("data-i")) === idx);
    }
    var cur = track.querySelector(".pswp-tb-item.cur");
    if (cur) try { cur.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }); } catch (e) {}
  }
  // ---------- 轻量语法高亮（查看模式用；纯前端正则实现，无额外依赖） ----------
  var HL_MAX_LINES = 4000;            // 行数超过这个就不高亮，避免大文件卡顿
  var HL_KW = {
    js: "const let var function return if else for while do switch case break continue new this class extends import export from default await async try catch finally throw typeof instanceof delete in of null undefined true false void yield static get set",
    ts: "const let var function return if else for while new this class extends interface type enum import export from await async try catch throw typeof as public private readonly null undefined true false",
    py: "def class return if elif else for while import from as with try except finally raise lambda None True False and or not in is pass break continue yield async await global nonlocal self",
    sh: "if then else elif fi for do done while case esac function return export local readonly echo cd exit source set unset",
    conf: "true false yes no on off null",
    css: "important media import from to"
  };
  var HL_LANG_BY_EXT = {
    js: "js", jsx: "js", mjs: "js", cjs: "js",
    ts: "ts", tsx: "ts",
    py: "py",
    sh: "sh", bash: "sh", zsh: "sh",
    json: "json",
    html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
    css: "css", scss: "css", less: "css",
    yml: "conf", yaml: "conf", ini: "conf", cfg: "conf", conf: "conf", toml: "conf", env: "conf"
  };
  function hlLang(name) { return HL_LANG_BY_EXT[extOf(name)] || "txt"; }
  function hlEsc(s) {
    // 不转义引号：高亮是在文本节点里输出，引号无需 &quot;，保留后正则才好识别字符串
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // 找注释起点（跳过字符串内的 # 与 //）
  function hlCommentAt(line, marks) {
    var inStr = null;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      for (var m = 0; m < marks.length; m++) {
        if (line.substr(i, marks[m].length) === marks[m]) return i;
      }
    }
    return -1;
  }
  // 普通片段（不含字符串）：关键字 + 数字
  function hlPlain(text, lang) {
    var t = hlEsc(text);
    var kws = HL_KW[lang];
    if (kws) {
      t = t.replace(/[A-Za-z_$][\w$]*/g, function (w) {
        return kws.indexOf(" " + w + " ") >= 0 ? '<span class="hl-kw">' + w + "</span>" : w;
      });
    }
    return t.replace(/\b\d+(\.\d+)?\b/g, '<span class="hl-num">$&</span>');
  }
  // 代码片段：字符串单独成块，其余片段再上关键字/数字 —— 分段处理才不会互相污染
  function hlCode(code, lang) {
    var re = /("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)/g;
    var out = "", last = 0, m;
    while ((m = re.exec(code)) !== null) {
      out += hlPlain(code.slice(last, m.index), lang);
      out += '<span class="hl-str">' + hlEsc(m[1]) + "</span>";
      last = m.index + m[1].length;
    }
    return out + hlPlain(code.slice(last), lang);
  }
  // HTML / XML：先用占位符标出属性名与标签名，最后统一包成 span
  // （不能边替换边匹配，否则会匹配到自己刚刚生成的 class="hl-tag"）
  function hlTagLine(line) {
    var out = hlEsc(line);
    out = out.replace(/([A-Za-z_][\w:.-]*)(=)/g, "\u0001$1\u0001$2");
    out = out.replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g, "$1\u0002$2\u0002");
    out = out.replace(/\u0001([^\u0001]+)\u0001/g, '<span class="hl-attr">$1</span>');
    return out.replace(/\u0002([^\u0002]+)\u0002/g, '<span class="hl-tag">$1</span>');
  }
  function hlLine(line, lang) {
    if (!line) return "";
    if (!lang || lang === "txt") return hlEsc(line);
    if (lang === "html") {
      var hi = line.indexOf("<!--");
      var hb = hi >= 0 ? line.slice(0, hi) : line;
      var hm = hi >= 0 ? line.slice(hi) : "";
      return hlTagLine(hb) + (hm ? '<span class="hl-cmt">' + hlEsc(hm) + "</span>" : "");
    }
    var marks = lang === "css" ? ["/*"]
      : (lang === "py" || lang === "sh" || lang === "conf") ? ["#"] : ["//"];
    var ci = hlCommentAt(line, marks);
    var code = ci >= 0 ? line.slice(0, ci) : line;
    var cmt = ci >= 0 ? line.slice(ci) : "";
    return hlCode(code, lang) + (cmt ? '<span class="hl-cmt">' + hlEsc(cmt) + "</span>" : "");
  }

  // 文本预览卡片：文件名 + 操作栏（含搜索）+ 带行号的内容区
  function buildTextPreview(item, text) {
    var body = document.getElementById("previewBody");
    var card = document.createElement("div");
    card.className = "pv-card";
    card.innerHTML =
      '<div class="pv-head">' +
        '<span class="pv-title">' + esc(item.name) + '</span>' +
        '<span class="pv-badge">未修改</span>' +
        '<button type="button" class="pv-tbtn" data-op="copy" title="复制">📋</button>' +
        '<button type="button" class="pv-tbtn" data-op="edit" title="编辑">✏️</button>' +
        '<button type="button" class="pv-tbtn hide" data-op="save" title="保存">💾</button>' +
        '<button type="button" class="pv-tbtn hide" data-op="cancel" title="取消">✖️</button>' +
        '<button type="button" class="pv-tbtn" data-op="more" title="更多">⋯</button>' +
        '<button type="button" class="pv-close" data-op="close">✕</button>' +
      '</div>' +
      '<div class="pv-meta"></div>' +
      '<div class="pv-more">' +
        '<button type="button" data-op="wrap">↩️ 换行</button>' +
        '<button type="button" data-op="search">🔍 搜索</button>' +
        '<button type="button" data-op="download">⬇️ 下载</button>' +
        '<button type="button" data-op="zoom">🔍 字号 100%</button>' +
      '</div>' +
      '<div class="pv-search">' +
        '<input type="text" placeholder="搜索关键字…">' +
        '<span class="pv-scount"></span>' +
        '<button type="button" data-op="prev">▲</button>' +
        '<button type="button" data-op="next">▼</button>' +
        '<button type="button" data-op="sclose">✕</button>' +
      '</div>';
    var pre = document.createElement("pre");
    pre.className = "pv-pre";
    var lines = [], contentSpans = [];
    var lang = hlLang(item.name);       // 按扩展名选高亮语言
    var hlOn = true;                    // 行数过多时自动关闭高亮
    function lineHtml(t) { return hlOn ? hlLine(t, lang) : esc(t); }
    function renderContent(t) {
      lines = t.replace(/\r\n?/g, "\n").split("\n");
      hlOn = lines.length <= HL_MAX_LINES;
      contentSpans = [];
      pre.innerHTML = "";
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var row = document.createElement("span"); row.className = "pv-line";
        var ln = document.createElement("span"); ln.className = "ln"; ln.textContent = i + 1;
        var lc = document.createElement("span"); lc.className = "lc"; lc.innerHTML = lineHtml(lines[i]);
        row.appendChild(ln); row.appendChild(lc);
        frag.appendChild(row); contentSpans.push(lc);
      }
      pre.appendChild(frag);
    }
    renderContent(text);

    // ===== 字号缩放：双指捏合 / 菜单「字号」循环（像图片查看器那样放大看代码） =====
    // 这里用改字号而不是 transform 缩放：文字始终清晰，行号与滚动都是原生的，不会和滚动打架。
    var FS_MIN = 9, FS_MAX = 34, fsBase = 13, fsCur = 13;
    var FS_STEPS = [1, 1.25, 1.5, 1.85, 2.3, 0.85];
    function syncFsLabel() {
      var b = card.querySelector('[data-op="zoom"]');
      if (b) b.textContent = "🔍 字号 " + Math.round(fsCur / fsBase * 100) + "%";
    }
    function applyFs(v) {
      var before = fsCur;
      fsCur = Math.max(FS_MIN, Math.min(FS_MAX, v));
      card.style.setProperty("--pv-fs", fsCur + "px");
      syncFsLabel();
      return before;
    }
    // 以查看区内的 (x,y) 为锚点缩放：改完字号把该点内容拉回原位，观感与图片缩放一致
    function zoomTextAt(x, y, v) {
      var sl = pre.scrollLeft, st = pre.scrollTop;
      var before = applyFs(v);
      if (!before || before === fsCur) return;
      var k = fsCur / before;
      pre.scrollLeft = (sl + x) * k - x;
      pre.scrollTop = (st + y) * k - y;
    }
    function cycleFs() {
      var r = fsCur / fsBase, i;
      for (i = 0; i < FS_STEPS.length; i++) { if (FS_STEPS[i] > r + 0.03) break; }
      if (i >= FS_STEPS.length) i = 0;
      applyFs(fsBase * FS_STEPS[i]);
    }
    // 双指捏合：单指仍可正常滚动、双击仍能选中单词
    var fsPinch = null;
    function pdist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    }
    pre.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 2) { fsPinch = null; return; }
      var r = pre.getBoundingClientRect();
      fsPinch = {
        d0: pdist(e.touches), f0: fsCur,
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top
      };
    }, { passive: true });
    pre.addEventListener("touchmove", function (e) {
      if (!fsPinch || e.touches.length !== 2) return;
      e.preventDefault();                  // 别让浏览器把双指当成页面缩放
      var r = pre.getBoundingClientRect();
      zoomTextAt(
        (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
        (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top,
        fsPinch.f0 * pdist(e.touches) / fsPinch.d0
      );
    }, { passive: false });
    pre.addEventListener("touchend", function (e) {
      if (e.touches.length < 2) fsPinch = null;
    });
    pre.addEventListener("touchcancel", function () { fsPinch = null; });

    // 编辑用文本框（带行号栏）
    var editWrap = document.createElement("div"); editWrap.className = "pv-editwrap";
    var gutter = document.createElement("div"); gutter.className = "pv-gutter";
    var ta = document.createElement("textarea");
    ta.className = "pv-edit"; ta.setAttribute("wrap", "off"); ta.value = text;
    editWrap.appendChild(gutter); editWrap.appendChild(ta);
    editWrap.style.display = "none";
    card.appendChild(editWrap);
    function syncGutter() {
      var n = ta.value.split("\n").length, s = "";
      for (var i = 1; i <= n; i++) s += i + "\n";
      gutter.textContent = s;
      gutter.scrollTop = ta.scrollTop;
    }
    ta.addEventListener("scroll", function () { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener("input", syncGutter);
    // 修改状态跟踪：内容与原文件不一致时徽标变红
    function updateModified() {
      var changed = ta.value !== text;
      badge.textContent = changed ? "已修改" : "未修改";
      badge.classList.toggle("dirty", changed);
      saveBtn.disabled = !changed;   // 未修改时禁止保存
      updateMeta(ta.value);
    }
    ta.addEventListener("input", updateModified);
    // 文件信息：大小 / 行数 / 字符数
    var meta = card.querySelector(".pv-meta");
    function fmtBytes(n) {
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
      return (n / 1073741824).toFixed(2) + " GB";
    }
    function updateMeta(t) {
      meta.textContent = fmtBytes(new Blob([t]).size) + " · " +
        t.split("\n").length.toLocaleString() + " 行 · " +
        t.length.toLocaleString() + " 字符";
    }
    updateMeta(text);

    card.appendChild(pre);
    body.innerHTML = "";
    body.appendChild(card);
    // 文本预览铺满整屏：代码行较长、内容较多，全屏看/编辑更实用
    card.classList.add("full");
    body.classList.add("fullscreen");
    // 文本预览使用卡片内关闭按钮，隐藏遮罩右上角的关闭圆钮
    document.getElementById("previewClose").style.display = "none";

    // ---- 关键字搜索 / 高亮 ----
    var sbar = card.querySelector(".pv-search");
    var sInput = sbar.querySelector("input");
    var sCount = sbar.querySelector(".pv-scount");
    var hits = [], hitIdx = -1, dirty = [], debounceT = null;
    var editing = false, editHits = [], editHitIdx = -1;

    function escHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function clearHits() {
      // 恢复成高亮 HTML（而不是纯文本），否则清掉搜索后语法配色就没了
      for (var k = 0; k < dirty.length; k++) contentSpans[dirty[k]].innerHTML = lineHtml(lines[dirty[k]]);
      dirty = []; hits = []; hitIdx = -1; sCount.textContent = "";
    }
    function doSearch() {
      if (editing) { doSearchEdit(); return; }
      clearHits();
      var q = sInput.value;
      if (!q) return;
      var lq = q.toLowerCase();
      for (var i = 0; i < lines.length; i++) {
        var ll = lines[i].toLowerCase();
        if (ll.indexOf(lq) < 0) continue;
        var html = "", pos = 0, idx;
        while ((idx = ll.indexOf(lq, pos)) >= 0) {
          html += escHtml(lines[i].slice(pos, idx)) +
                  "<mark class='pv-hit'>" + escHtml(lines[i].slice(idx, idx + q.length)) + "</mark>";
          pos = idx + q.length;
        }
        html += escHtml(lines[i].slice(pos));
        contentSpans[i].innerHTML = html;
        dirty.push(i);
      }
      hits = Array.prototype.slice.call(pre.querySelectorAll("mark.pv-hit"));
      if (hits.length) goHit(0); else sCount.textContent = "无匹配";
    }
    function goHit(n) {
      if (!hits.length) return;
      if (hitIdx >= 0 && hits[hitIdx]) hits[hitIdx].classList.remove("cur");
      hitIdx = (n % hits.length + hits.length) % hits.length;
      var m = hits[hitIdx];
      m.classList.add("cur");
      sCount.textContent = (hitIdx + 1) + "/" + hits.length;
      pre.scrollTop = m.offsetTop - pre.clientHeight / 2;
    }

    // 编辑模式搜索：定位匹配处并选中
    function doSearchEdit() {
      editHits = []; editHitIdx = -1;
      var q = sInput.value;
      if (!q) { sCount.textContent = ""; return; }
      var lv = ta.value.toLowerCase(), lq = q.toLowerCase();
      var idx = lv.indexOf(lq);
      while (idx >= 0) { editHits.push(idx); idx = lv.indexOf(lq, idx + q.length); }
      if (!editHits.length) { sCount.textContent = "无匹配"; return; }
      goEditHit(0);
    }
    function goEditHit(n) {
      if (!editHits.length) return;
      editHitIdx = (n % editHits.length + editHits.length) % editHits.length;
      var start = editHits[editHitIdx], end = start + sInput.value.length;
      ta.focus();
      ta.setSelectionRange(start, end);
      sCount.textContent = (editHitIdx + 1) + "/" + editHits.length;
      var lineNum = (ta.value.slice(0, start).match(/\n/g) || []).length;
      var lineH = parseFloat(getComputedStyle(ta).lineHeight) || 19.5;
      ta.scrollTop = lineNum * lineH - ta.clientHeight / 2;
      gutter.scrollTop = ta.scrollTop;
    }
    function navHit(d) { if (editing) goEditHit(editHitIdx + d); else goHit(hitIdx + d); }

    card.querySelector('[data-op="search"]').addEventListener("click", function () {
      moreMenu.classList.remove("show");
      var show = !sbar.classList.contains("show");
      sbar.classList.toggle("show", show);
      this.classList.toggle("on", show);
      if (show) sInput.focus();
      else { sInput.value = ""; clearHits(); editHits = []; editHitIdx = -1; }
    });
    sInput.addEventListener("input", function () {
      clearTimeout(debounceT);
      debounceT = setTimeout(doSearch, 300);
    });
    sInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); navHit(1); }
      else if (e.key === "Escape") { card.querySelector('[data-op="search"]').click(); }
    });
    card.querySelector('[data-op="prev"]').addEventListener("click", function () { navHit(-1); });
    card.querySelector('[data-op="next"]').addEventListener("click", function () { navHit(1); });
    card.querySelector('[data-op="sclose"]').addEventListener("click", function () {
      card.querySelector('[data-op="search"]').click();
    });

    // ---- 换行切换 / 复制 / 下载 ----
    card.querySelector('[data-op="wrap"]').addEventListener("click", function () {
      var wrapOn = pre.style.whiteSpace === "pre-wrap";
      pre.style.whiteSpace = wrapOn ? "pre" : "pre-wrap";
      pre.style.wordBreak = wrapOn ? "normal" : "break-all";
      pre.classList.toggle("wrap", !wrapOn);
      this.classList.toggle("on", !wrapOn);
    });
    // 复制：用统一的复制方法（含 iOS 兼容与失败提示）
    card.querySelector('[data-op="copy"]').addEventListener("click", function () {
      copyText(text);
    });
    // ---- ⋯ 更多菜单：点开 / 收起，点别处自动收起 ----
    var moreMenu = card.querySelector(".pv-more");
    card.querySelector('[data-op="more"]').addEventListener("click", function (e) {
      e.stopPropagation();
      moreMenu.classList.toggle("show");
    });
    card.addEventListener("click", function (e) {
      if (!(e.target.closest && e.target.closest('.pv-more, [data-op="more"]'))) {
        moreMenu.classList.remove("show");
      }
    });
    // 下载：收起菜单 + 二次确认（与图片查看器一致，用全局确认框）
    card.querySelector('[data-op="download"]').addEventListener("click", function () {
      moreMenu.classList.remove("show");
      confirmBox({
        title: "下载文件",
        message: "确认下载「" + item.name + "」？",
        okText: "下载",
        onOk: function () { download(item); }
      });
    });
    // 字号：点一次按 100% → 125% → 150% → 185% → 230% → 85% 循环，按钮上显示当前比例
    card.querySelector('[data-op="zoom"]').addEventListener("click", function () {
      moreMenu.classList.remove("show");
      cycleFs();
    });

    // ---- 编辑 / 保存 ----
    var abs = itemAbs(item);
    var editBtn = card.querySelector('[data-op="edit"]');
    var saveBtn = card.querySelector('[data-op="save"]');
    var cancelBtn = card.querySelector('[data-op="cancel"]');
    var badge = card.querySelector(".pv-badge");
    var viewBtns = ["copy", "wrap", "download"].map(function (op) {
      return card.querySelector('[data-op="' + op + '"]');
    });
    function setEditMode(on) {
      editing = on;
      editWrap.style.display = on ? "" : "none";
      pre.style.display = on ? "none" : "";
      editBtn.classList.toggle("hide", on);
      saveBtn.classList.toggle("hide", !on);
      cancelBtn.classList.toggle("hide", !on);
      // 复制/换行/下载 仅查看状态显示；搜索两种状态都可用
      viewBtns.forEach(function (b) { b.classList.toggle("hide", on); });
      badge.classList.toggle("show", on);
      if (on) {
        confirmBox.classList.remove("show");
        ta.value = text;
        syncGutter();
        badge.textContent = "未修改";
        badge.classList.remove("dirty");
        saveBtn.disabled = true;   // 未修改时不可保存
        clearHits();
        if (sbar.classList.contains("show") && sInput.value) {
          doSearchEdit();
        } else {
          ta.scrollTop = 0; gutter.scrollTop = 0;   // 停在顶部，不跳到末行
        }
        ta.setSelectionRange(0, 0);
      } else {
        editHits = []; editHitIdx = -1;
        // 退出编辑时自动清除搜索状态
        if (sbar.classList.contains("show")) {
          sbar.classList.remove("show");
          card.querySelector('[data-op="search"]').classList.remove("on");
          sInput.value = "";
          clearHits();
        }
      }
    }
    editBtn.addEventListener("click", function () { setEditMode(true); });
    cancelBtn.addEventListener("click", function () { setEditMode(false); });
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true; saveBtn.textContent = "保存中…";
      fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: abs, content: ta.value })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { toast(d.error, "error"); return; }
        text = ta.value;
        renderContent(text);
        setEditMode(false);
        toast("已保存", "success");
      }).catch(function () { toast("保存失败", "error"); })
        .finally(function () { saveBtn.disabled = false; saveBtn.textContent = "💾 保存"; });
    });

    // 卡片内关闭按钮
    card.querySelector('[data-op="close"]').addEventListener("click", function () {
      var mask = document.getElementById("previewMask");
      mask.classList.remove("show");
      document.getElementById("previewBody").innerHTML = "";
      document.getElementById("previewClose").style.display = "";
    });
  }
  document.getElementById("previewClose").addEventListener("click", function () {
    var mask = document.getElementById("previewMask");
    mask.classList.remove("show");
    document.getElementById("previewBody").innerHTML = "";
  });
  document.getElementById("previewMask").addEventListener("click", function (e) {
    if (e.target === this) {
      this.classList.remove("show");
      document.getElementById("previewBody").innerHTML = "";
    }
  });
