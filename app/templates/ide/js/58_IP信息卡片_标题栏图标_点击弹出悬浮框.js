/* 访客 IP 信息悬浮框：点击标题栏 🌐（tbIpCard）图标弹出，
   展示 ippure.com 实时生成的访客 IP 信息卡图片；
   图片首次弹出才加载（避免每次进 IDE 都请求外域），
   点击弹层外任意位置或按 Esc 关闭。 */
(function () {
  var btn = document.getElementById('tbIpCard');
  var pop = document.getElementById('tbIpPop');
  var img = document.getElementById('tbIpPopImg');
  if (!btn || !pop || !img) return;

  var CARD_URL = 'https://my.ippure.com/v1/card';

  function position() {
    var r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 8) + 'px';
    pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  }

  function open() {
    if (!img.getAttribute('src')) img.src = CARD_URL + '?t=' + Date.now();
    position();
    pop.hidden = false;
    btn.classList.add('on');
  }

  function close() {
    pop.hidden = true;
    btn.classList.remove('on');
  }

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
