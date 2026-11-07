/* 访客 IP 信息悬浮框：点击标题栏 🌐（tbIpCard）图标弹出，
   展示 ippure.com 实时生成的访客 IP 信息卡图片；
   每次弹出都带时间戳重新拉取（保证 IP 最新），图片加载期间
   显示「获取中…」旋转占位，加载失败提示重试；
   点击弹层外任意位置或按 Esc 关闭。 */
(function () {
  var btn = document.getElementById('tbIpCard');
  var pop = document.getElementById('tbIpPop');
  var img = document.getElementById('tbIpPopImg');
  var loading = document.getElementById('tbIpPopLoading');
  if (!btn || !pop || !img || !loading) return;

  var CARD_URL = 'https://my.ippure.com/v1/card';

  function showLoading(text) {
    // 旋转部分用 CSS 圆环（bi 字形在字框里不居中，转起来会抖）
    loading.innerHTML = '<span class="tb-ip-ring"></span> ' + text;
    loading.style.display = 'flex';
    img.classList.add('tb-ip-hide');
  }

  function showImg() {
    loading.style.display = 'none';
    img.classList.remove('tb-ip-hide');
  }

  function position() {
    var r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 8) + 'px';
    pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }

  function open() {
    showLoading('获取中…');
    position();
    pop.hidden = false;
    btn.classList.add('on');
    // 带时间戳强制绕过浏览器缓存，保证每次弹出都是当前最新的 IP 信息
    img.src = CARD_URL + '?t=' + Date.now();
  }

  function close() {
    pop.hidden = true;
    btn.classList.remove('on');
  }

  img.addEventListener('load', showImg);
  img.addEventListener('error', function () {
    // 加载失败：显示错误提示，点击占位区可重试
    loading.innerHTML = '<i class="bi bi-wifi-off"></i> IP 信息获取失败，点击重试';
    loading.style.cursor = 'pointer';
    loading.onclick = function () {
      loading.onclick = null;
      loading.style.cursor = '';
      showLoading('获取中…');
      img.src = CARD_URL + '?t=' + Date.now();
    };
  });

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (pop.hidden) open(); else close();
  });

  /* 弹层内的点击不冒泡关闭（比如复制图片） */
  pop.addEventListener('click', function (e) { e.stopPropagation(); });

  document.addEventListener('click', function () { if (!pop.hidden) close(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pop.hidden) close();
  });

  /* 窗口缩放 / 侧栏开关导致按钮移动时，若弹层开着就跟随重定位 */
  window.addEventListener('resize', function () { if (!pop.hidden) position(); });
})();
