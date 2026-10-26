/* IDE 桌宠：桌小萌 (Deskie) 与 鲸鱼娘 (Kujira)。
   - 可拖动到任意位置（localStorage 记忆），会眨眼、呼吸/漂浮、眼神跟随鼠标
   - 单击说话（按时间段问候 + 随机吐槽），双击跳一下
   - 右键菜单：说点什么 / 跳一下 / 回到右下角 / 换个伙伴（两个角色任选）/ 隐身
   - 角色选择记忆在 localStorage；隐身后右下角留小圆钮召唤
   - 对外暴露 window.Deskie = { say, hop, show, hide, use, pets, current }，其他模块可调用；
     也可派发自定义事件 window.dispatchEvent(new CustomEvent('deskie-say', {detail:'文本'}))
   本文件自包含（不依赖 00_preamble 闭包），在所有模块之后加载。 */
  (function () {
  'use strict';
  if (window.Deskie) return; // 防重复注入

  var LS_POS = 'ide.deskie.pos', LS_HIDDEN = 'ide.deskie.hidden', LS_PET = 'ide.deskie.pet';
  var W = 84, H = 92;               // 与 CSS 中 #deskie 尺寸一致
  var DRAG_TH = 5;                  // 位移超过该像素判定为拖动，否则算单击

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ---------- 角色定义 ----------
  var DESKIE_HTML =
    '<div class="dk-foot l"></div><div class="dk-foot r"></div>' +
    '<div class="dk-bulb"></div><div class="dk-rod"></div>' +
    '<div class="dk-body">' +
      '<div class="dk-blush l"></div><div class="dk-blush r"></div>' +
      '<div class="dk-gaze">' +
        '<svg class="dk-eye" viewBox="0 0 14 14"><path d="M4 2 L1 7 L4 12" fill="none" stroke="#3aa4ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<svg class="dk-eye" viewBox="0 0 14 14"><path d="M10 2 L13 7 L10 12" fill="none" stroke="#3aa4ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>' +
      '<div class="dk-belly">&lt;/&gt;</div>' +
    '</div>';

  var WHALE_HTML =
    '<svg class="dk-wh" viewBox="0 0 84 92">' +
      '<defs>' +
        '<linearGradient id="dkWhBody" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" class="dk-wh-s1"/><stop offset="100%" class="dk-wh-s2"/>' +
        '</linearGradient>' +
      '</defs>' +
      /* 头顶喷水 */
      '<g><circle class="dk-drop d1" cx="42" cy="18" r="3"/>' +
        '<circle class="dk-drop d2" cx="35" cy="14" r="2.2"/>' +
        '<circle class="dk-drop d3" cx="49" cy="15" r="2.5"/></g>' +
      /* 尾鳍（身后，左右两瓣） */
      '<g class="dk-tail">' +
        '<path d="M42 76 C34 84 24 90 14 90 C22 84 30 80 36 74 Z" style="fill:var(--wh-body2)"/>' +
        '<path d="M42 76 C50 84 60 90 70 90 C62 84 54 80 48 74 Z" style="fill:var(--wh-body2)"/>' +
      '</g>' +
      /* 双马尾 */
      '<g class="dk-plait"><path d="M20 40 C10 48 7 62 11 74 C11 60 15 52 21 46 Z" style="fill:var(--wh-hair)"/></g>' +
      '<g class="dk-plait"><path d="M64 40 C74 48 77 62 73 74 C73 60 69 52 63 46 Z" style="fill:var(--wh-hair)"/></g>' +
      /* 身体 */
      '<ellipse cx="42" cy="56" rx="27" ry="25" fill="url(#dkWhBody)"/>' +
      /* 腹部 + 腹褶 */
      '<ellipse cx="42" cy="64" rx="18" ry="14" style="fill:var(--wh-belly)"/>' +
      '<g fill="none" style="stroke:var(--wh-line)" stroke-width="1.2" stroke-linecap="round">' +
        '<path d="M30 60 Q42 64 54 60"/><path d="M28 66 Q42 70 56 66"/><path d="M30 72 Q42 76 54 72"/>' +
      '</g>' +
      /* 侧鳍（小手臂） */
      '<ellipse class="dk-fin l" cx="16" cy="64" rx="9" ry="5" style="fill:var(--wh-body2)"/>' +
      '<ellipse class="dk-fin r" cx="68" cy="64" rx="9" ry="5" style="fill:var(--wh-body2)"/>' +
      /* 刘海 */
      '<path d="M17 46 C16 30 28 22 42 22 C56 22 68 30 67 46 C62 36 54 32 42 32 C30 32 22 36 17 46 Z" style="fill:var(--wh-hair)"/>' +
      /* 蝴蝶结 */
      '<path d="M62 30 L52 25 L52 35 Z" style="fill:var(--wh-ribbon)"/>' +
      '<path d="M62 30 L72 25 L72 35 Z" style="fill:var(--wh-ribbon)"/>' +
      '<circle cx="62" cy="30" r="2.4" style="fill:var(--wh-ribbon)"/>' +
      /* 腮红 + 嘴 */
      '<ellipse cx="24" cy="57" rx="4.5" ry="2.6" fill="rgba(255,140,165,.45)"/>' +
      '<ellipse cx="60" cy="57" rx="4.5" ry="2.6" fill="rgba(255,140,165,.45)"/>' +
      '<path d="M39 58 Q42 61 45 58" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.5" stroke-linecap="round"/>' +
      /* 眼睛（.dk-gaze 整体跟随鼠标，.dk-eye 各自眨眼） */
      '<g class="dk-gaze">' +
        '<g class="dk-eye">' +
          '<ellipse cx="33" cy="50" rx="5" ry="6" style="fill:var(--wh-hair)"/>' +
          '<circle cx="34.8" cy="47.4" r="2" fill="#fff"/>' +
          '<circle cx="31" cy="52" r="1" fill="rgba(255,255,255,.55)"/>' +
        '</g>' +
        '<g class="dk-eye">' +
          '<ellipse cx="51" cy="50" rx="5" ry="6" style="fill:var(--wh-hair)"/>' +
          '<circle cx="52.8" cy="47.4" r="2" fill="#fff"/>' +
          '<circle cx="49" cy="52" r="1" fill="rgba(255,255,255,.55)"/>' +
        '</g>' +
      '</g>' +
    '</svg>';

  var PETS = {
    deskie: {
      name: '桌小萌 (Deskie)', icon: 'bi-robot', html: DESKIE_HTML,
      hello: '你好呀，我是桌小萌 ~',
      greet: [
        [5, 9, '早上好！新的一天从打开编辑器开始 ~'],
        [9, 12, '上午好，代码写得顺利吗？'],
        [12, 14, '中午啦，记得休息一下眼睛哦。'],
        [14, 18, '下午茶时间，起来活动活动吧！'],
        [18, 23, '晚上好，晚上的灵感总是特别多 ~'],
        [23, 24, '夜深了，写完这段就早点休息吧。'],
        [0, 5, '还在熬夜？小心头发……和 bug。']
      ],
      lines: [
        '拖我可以换个位置，右键有菜单哦。',
        '双击我会跳一下！',
        '今天也要好好写代码呀。',
        'F5 一按，bug 退散。',
        'Git 提交信息想好了吗？',
        '定时任务记得检查一遍哦。',
        '存档点已就位：Ctrl + S。',
        '我叫桌小萌，也可以叫我 Deskie。',
        '有什么难题，去问右侧的 AI 助手吧！',
        '删文件不用怕，还有回收站兜底 ~',
        '终端里可以说中文，AI 助手帮你翻译成命令。',
        '想换鲸鱼娘陪你？右键菜单里选一下就行。'
      ]
    },
    whale: {
      name: '鲸鱼娘 (Kujira)', icon: 'bi-droplet', html: WHALE_HTML,
      hello: '咕噜~ 我是鲸鱼娘，请多指教！',
      greet: [
        [5, 9, '咕噜~ 早上好！今天也是清澈的一天。'],
        [9, 12, '上午好呀，代码顺流而下吗？'],
        [12, 14, '午休时间，来海里泡一泡吧 ~'],
        [14, 18, '下午好，记得喝口水补充水分哦。'],
        [18, 23, '晚上好，今晚的月亮映在海面上呢。'],
        [23, 24, '夜深了哦，别把浪花熬干了…'],
        [0, 5, '还在熬夜？深海都要打烊啦。']
      ],
      lines: [
        '咕噜咕噜~',
        '我的肚子能装下整个项目的日志呢！',
        '代码像海水一样，深不可测呀。',
        '内存够不够？鲸鱼的记忆可是很大的哦。',
        '别紧张，深呼吸——呼——',
        '我喷水柱是给你加油的意思哦！',
        '双击我，我会溅你一身水花！',
        'Git 提交就像吐泡泡，一串一串的。',
        '听说删库跑路要游到深海里去…危险，别学。',
        '终端报错时，先看看是不是浪太大了。',
        '拖动我可以把我放到任意一片海里 ~',
        '想我了吗？随时可以右键切换回来。'
      ]
    }
  };
  var ORDER = ['deskie', 'whale'];
  var curId = 'deskie';

  function curPet() { return PETS[curId] || PETS.deskie; }
  function greetNow() {
    var h = new Date().getHours(), g = curPet().greet || [];
    for (var i = 0; i < g.length; i++) if (h >= g[i][0] && h < g[i][1]) return g[i][2];
    return pick(curPet().lines);
  }

  // ---------- DOM ----------
  var el = document.createElement('div');
  el.id = 'deskie';
  el.className = 'dk-pet';
  document.body.appendChild(el);

  var bubble = document.createElement('div');
  bubble.id = 'deskie-bubble';
  document.body.appendChild(bubble);

  var menu = document.createElement('div');
  menu.id = 'deskie-menu';
  document.body.appendChild(menu);

  var summon = document.createElement('div');
  summon.id = 'deskie-summon';
  document.body.appendChild(summon);

  var gaze = null;
  function renderPet() {
    var p = curPet();
    for (var i = 0; i < ORDER.length; i++) el.classList.remove('is-' + ORDER[i]);
    el.classList.add('is-' + curId);
    el.innerHTML = '<div class="dk-stage"><div class="dk-shadow"></div>' + p.html + '</div>';
    gaze = el.querySelector('.dk-gaze');
    summon.title = '召唤' + p.name;
    summon.innerHTML = '<i class="bi ' + p.icon + '"></i>';
  }

  function renderMenu() {
    var h =
      '<div class="dk-mi" data-act="say"><i class="bi bi-chat-dots"></i>说点什么</div>' +
      '<div class="dk-mi" data-act="hop"><i class="bi bi-arrow-up-square"></i>跳一下</div>' +
      '<div class="dk-mi" data-act="home"><i class="bi bi-house"></i>回到右下角</div>' +
      '<div class="dk-sep"></div>' +
      '<div class="dk-cap">换个伙伴</div>';
    for (var i = 0; i < ORDER.length; i++) {
      var id = ORDER[i], p = PETS[id];
      h += '<div class="dk-mi' + (id === curId ? ' on' : '') + '" data-pet="' + id + '">' +
             '<i class="bi ' + p.icon + '"></i>' + p.name +
             (id === curId ? '<span class="dk-tick">✔</span>' : '') +
           '</div>';
    }
    h += '<div class="dk-sep"></div>' +
         '<div class="dk-mi" data-act="hide"><i class="bi bi-moon-stars"></i>隐身</div>';
    menu.innerHTML = h;
  }

  function use(id) {
    if (!PETS[id] || id === curId) return;
    curId = id;
    try { localStorage.setItem(LS_PET, id); } catch (e) {}
    renderPet();
    renderMenu();
    say(PETS[id].hello, 2800);
  }

  (function initPet() {
    try {
      var id = localStorage.getItem(LS_PET);
      if (id && PETS[id]) curId = id;
    } catch (e) {}
    renderPet();
    renderMenu();
  })();

  // ---------- 气泡 ----------
  var bubbleTimer = null;
  function say(text, ms) {
    bubble.textContent = text || greetNow();
    bubble.classList.add('show');
    moveBubble();
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { bubble.classList.remove('show'); }, ms || 3600);
  }
  function moveBubble() {
    var r = el.getBoundingClientRect();
    var bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    var x = r.left + r.width / 2 - bw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
    var y = r.top - bh - 12;
    if (y < 8) y = r.bottom + 12;               // 顶部放不下就放脚下
    bubble.style.left = x + 'px';
    bubble.style.top = y + 'px';
  }

  // ---------- 位置 ----------
  function clamp(x, y) {
    return {
      x: Math.max(4, Math.min(x, window.innerWidth - W - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - H - 4))
    };
  }
  function setPos(x, y) {
    var p = clamp(x, y);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    if (bubble.classList.contains('show')) moveBubble();
  }
  function savePos() {
    try { localStorage.setItem(LS_POS, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); } catch (e) {}
  }
  function goHome() {
    setPos(window.innerWidth - W - 24, window.innerHeight - H - 46);
    savePos();
  }
  (function restore() {
    try {
      var p = JSON.parse(localStorage.getItem(LS_POS) || 'null');
      if (p && typeof p.x === 'number') { setPos(p.x, p.y); return; }
    } catch (e) {}
    goHome();
  })();

  // ---------- 拖动 / 单击 / 双击 ----------
  var drag = null;
  el.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;                 // 右键交给 contextmenu
    el.setPointerCapture(ev.pointerId);
    drag = { sx: ev.clientX, sy: ev.clientY, ox: el.offsetLeft, oy: el.offsetTop, moved: false };
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (Math.abs(dx) > DRAG_TH || Math.abs(dy) > DRAG_TH) drag.moved = true;
    if (drag.moved) setPos(drag.ox + dx, drag.oy + dy);
  });
  el.addEventListener('pointerup', function (ev) {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    el.classList.remove('dragging');
    if (moved) { savePos(); return; }
    closeMenu();
    if ((ev.detail || 0) >= 2) hop('哇，被抓到了 ~');
    else say();
  });
  el.addEventListener('pointercancel', function () {
    drag = null;
    el.classList.remove('dragging');
  });

  function hop(line) {
    el.classList.remove('hop');
    void el.offsetWidth;                          // 重启动画
    el.classList.add('hop');
    setTimeout(function () { el.classList.remove('hop'); }, 700);
    if (line) say(line, 2600);
  }
  el.addEventListener('dblclick', function () { hop(); });

  // ---------- 眨眼 ----------
  (function blinkLoop() {
    setTimeout(function () {
      el.classList.add('blink');
      setTimeout(function () { el.classList.remove('blink'); }, 130);
      blinkLoop();
    }, 2200 + Math.random() * 4200);
  })();

  // ---------- 眼神跟随鼠标 ----------
  document.addEventListener('mousemove', function (ev) {
    if (!gaze) return;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height * 0.55;
    var ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
    var d = Math.min(3.5, Math.hypot(ev.clientX - cx, ev.clientY - cy) / 60);
    gaze.style.transform = 'translate(' + (Math.cos(ang) * d).toFixed(1) + 'px,' + (Math.sin(ang) * d).toFixed(1) + 'px)';
  });

  // ---------- 右键菜单 ----------
  function openMenu(x, y) {
    menu.classList.add('open');
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + 'px';
  }
  function closeMenu() { menu.classList.remove('open'); }
  el.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    var r = el.getBoundingClientRect();
    openMenu(ev.clientX || r.left, ev.clientY || r.top);
  });
  menu.addEventListener('click', function (ev) {
    var mi = ev.target.closest('.dk-mi');
    if (!mi) return;
    closeMenu();
    if (mi.dataset.pet) { use(mi.dataset.pet); return; }
    var act = mi.dataset.act;
    if (act === 'say') say(pick(curPet().lines));
    else if (act === 'hop') hop();
    else if (act === 'home') { goHome(); say('回我的小窝啦 ~', 2200); }
    else if (act === 'hide') hide();
  });
  document.addEventListener('pointerdown', function (ev) {
    if (menu.classList.contains('open') && !menu.contains(ev.target) && !el.contains(ev.target)) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', function () { setPos(el.offsetLeft, el.offsetTop); });

  // ---------- 隐身 / 召唤 ----------
  function show() {
    el.classList.remove('hide');
    summon.classList.remove('show');
    try { localStorage.setItem(LS_HIDDEN, '0'); } catch (e) {}
    say('我回来啦！', 2200);
  }
  function hide() {
    el.classList.add('hide');
    bubble.classList.remove('show');
    closeMenu();
    summon.classList.add('show');
    try { localStorage.setItem(LS_HIDDEN, '1'); } catch (e) {}
  }
  summon.addEventListener('click', show);
  try { if (localStorage.getItem(LS_HIDDEN) === '1') { el.classList.add('hide'); summon.classList.add('show'); } } catch (e) {}

  // ---------- 对外 API ----------
  window.Deskie = {
    say: function (text, ms) { show(); say(text, ms); },
    hop: function () { hop(); },
    show: show,
    hide: hide,
    use: use,
    pets: ORDER.slice(),
    current: function () { return curId; }
  };
  window.addEventListener('deskie-say', function (ev) {
    if (ev && ev.detail) say(String(ev.detail));
  });
  })();
