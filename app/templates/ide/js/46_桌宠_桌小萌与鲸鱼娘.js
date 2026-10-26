/* IDE 桌宠：小 Buddy (Buddy)、桌小萌 (Deskie)、鲸鱼娘 (Kujira)、奶龙 (Nailong)、肥嘟嘟 (Dudu)。
   - 可拖动到任意位置（localStorage 记忆），会眨眼、呼吸/漂浮、眼神跟随鼠标
   - 单击说话（按时间段问候 + 随机吐槽），双击跳一下
   - 右键菜单：说点什么 / 随便动一下 / 跳一下 / 回到右下角 /
     换个表情 + 换个颜色 / 换个伙伴（五个角色任选）/ 隐身
   - 角色选择记忆在 localStorage；隐身后右下角留小圆钮召唤
   - 小 Buddy 的造型直接复用欢迎页（#welcome .wc-mascot）的吉祥物 SVG，
     只把渐变 id 换成 dkBd* 前缀，避免与欢迎页同时渲染时 id 冲突；
     五个角色各有 9 种表情（*_FACES）、一组配色（*_HUES）、8 套动作（*_ACTS），
     空闲时每 5~12 秒自己动一下 + 换表情，偶尔换颜色 / 说句话
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
  /* 桌小萌的外壳：脸（眼睛 + 屏幕上的字符）放进 .dk-face-slot，由表情表 DESKIE_FACES 渲染 */
  var DESKIE_HTML =
    '<div class="dk-foot l"></div><div class="dk-foot r"></div>' +
    '<div class="dk-bulb"></div><div class="dk-rod"></div>' +
    '<div class="dk-body">' +
      '<div class="dk-blush l"></div><div class="dk-blush r"></div>' +
      '<div class="dk-face-slot"></div>' +
    '</div>';

  /* 小 Buddy：与欢迎页吉祥物同源的一份 SVG（造型 / 配色 / 比例完全一致）。
     viewBox 取 6 -2 128 140（宽高比 128:140 ≈ 84:92），正好让造型铺满外壳且四周留白均匀。
     屏幕里的表情由 .dk-face-slot 承载（JS 按 BUDDY_FACES 渲染），发光渐变的两端改用
     .dk-bd-c1 / .dk-bd-c2 两个 class，颜色靠 CSS 变量 --bd-c1 / --bd-c2 驱动，
     因此换表情、换眼色都不必重建整只宠物。 */
  var BUDDY_HTML =
    '<svg class="dk-bd" viewBox="6 -2 128 140" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="dkBdBody" x1="20" y1="28" x2="120" y2="126" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" stop-color="#fbfdff"/><stop offset=".55" stop-color="#dde6f0"/><stop offset="1" stop-color="#bfcbd9"/>' +
        '</linearGradient>' +
        '<linearGradient id="dkBdScreen" x1="33" y1="42" x2="107" y2="96" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" stop-color="#2c3748"/><stop offset="1" stop-color="#131922"/>' +
        '</linearGradient>' +
        '<linearGradient id="dkBdGlow" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" class="dk-bd-c1"/><stop offset="1" class="dk-bd-c2"/>' +
        '</linearGradient>' +
      '</defs>' +
      /* 头顶天线 + 呼吸灯 */
      '<line x1="70" y1="26" x2="70" y2="14" stroke="#a7b4c4" stroke-width="4.5" stroke-linecap="round"/>' +
      '<circle class="dk-bd-bulb" cx="70" cy="11" r="6.5" fill="url(#dkBdGlow)"/>' +
      /* 两侧耳朵 / 金属外壳 / 深色屏幕 */
      '<rect x="10" y="52" width="15" height="32" rx="7.5" fill="url(#dkBdBody)"/>' +
      '<rect x="115" y="52" width="15" height="32" rx="7.5" fill="url(#dkBdBody)"/>' +
      '<rect x="18" y="30" width="104" height="84" rx="30" fill="url(#dkBdBody)"/>' +
      '<rect x="32" y="44" width="76" height="56" rx="24" fill="url(#dkBdScreen)"/>' +
      /* 表情槽（默认由 JS 填「认真」表情：双箭头 > >） */
      '<g class="dk-face-slot"></g>' +
      /* 下巴 / 指示灯 / 小脚 */
      '<rect x="44" y="108" width="52" height="24" rx="12" fill="url(#dkBdBody)"/>' +
      '<circle cx="70" cy="120" r="5" fill="#9fb2c6"/>' +
      '<rect x="27" y="112" width="16" height="9" rx="4.5" fill="#dbe3ec"/>' +
      '<rect x="97" y="112" width="16" height="9" rx="4.5" fill="#dbe3ec"/>' +
    '</svg>';

  // ---------- 小 Buddy 的表情表 ----------
  // 所有表情都画在屏幕内（x 36~104 / y 48~96），笔触统一引用 #dkBdGlow，换眼色即整体变色。
  var EYE_GLOW = 'stroke="url(#dkBdGlow)"';
  var BUDDY_FACES = {
    /* 认真：欢迎页同款双箭头 */
    normal:
      '<g class="dk-gaze">' +
        '<path class="dk-eye" d="M54 60l8 12-8 12" ' + EYE_GLOW + ' stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path class="dk-eye" d="M82 60l8 12-8 12" ' + EYE_GLOW + ' stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g>',
    /* 开心：弯月眼 ^ ^ + 笑嘴 */
    happy:
      '<g class="dk-gaze">' +
        '<path class="dk-eye" d="M50 70q9-15 18 0" ' + EYE_GLOW + ' stroke-width="5.6" stroke-linecap="round"/>' +
        '<path class="dk-eye" d="M76 70q9-15 18 0" ' + EYE_GLOW + ' stroke-width="5.6" stroke-linecap="round"/>' +
      '</g>' +
      '<path class="dk-mouth" d="M62 84q11 7 22 0" ' + EYE_GLOW + ' stroke-width="4" stroke-linecap="round"/>',
    /* 眨眼：左眼箭头，右眼弯线 */
    wink:
      '<g class="dk-gaze">' +
        '<path class="dk-eye" d="M54 60l8 12-8 12" ' + EYE_GLOW + ' stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path class="dk-eye" d="M78 72q10-9 20 0" ' + EYE_GLOW + ' stroke-width="5.6" stroke-linecap="round"/>' +
      '</g>' +
      '<path class="dk-mouth" d="M64 85q9 7 18 0" ' + EYE_GLOW + ' stroke-width="3.6" stroke-linecap="round"/>',
    /* 犯困：两条横线眼（微弧，避免零高度 bbox 让渐变笔触失效）+ 微张嘴 */
    sleep:
      '<g class="dk-gaze">' +
        '<path class="dk-eye bd-drowse" d="M50 72q8 1.6 16 0" ' + EYE_GLOW + ' stroke-width="5" stroke-linecap="round"/>' +
        '<path class="dk-eye bd-drowse" d="M78 72q8 1.6 16 0" ' + EYE_GLOW + ' stroke-width="5" stroke-linecap="round"/>' +
      '</g>' +
      '<ellipse class="dk-mouth" cx="73" cy="86" rx="5" ry="3.4" ' + EYE_GLOW + ' stroke-width="3"/>',
    /* 惊讶：圆眼放大 + 小 o 嘴 */
    surprised:
      '<g class="dk-gaze">' +
        '<circle class="dk-eye bd-pop" cx="60" cy="70" r="10.5" fill="none" ' + EYE_GLOW + ' stroke-width="5"/>' +
        '<circle class="dk-eye bd-pop" cx="86" cy="70" r="10.5" fill="none" ' + EYE_GLOW + ' stroke-width="5"/>' +
      '</g>' +
      '<circle class="dk-mouth" cx="73" cy="87" r="4.2" fill="none" ' + EYE_GLOW + ' stroke-width="3.4"/>',
    /* 喜欢：爱心眼 + 笑嘴 */
    love:
      /* 心形放在 <g> 里定位：心跳动画写的是 path 自己的 transform，不会覆盖定位用的 transform */
      '<g class="dk-gaze">' +
        '<g transform="translate(60 69)"><path class="dk-eye bd-heart" d="M0 8C-13-2-7-13 0-4C7-13 13-2 0 8Z" fill="url(#dkBdGlow)"/></g>' +
        '<g transform="translate(86 69)"><path class="dk-eye bd-heart" d="M0 8C-13-2-7-13 0-4C7-13 13-2 0 8Z" fill="url(#dkBdGlow)"/></g>' +
      '</g>' +
      '<path class="dk-mouth" d="M62 82q11 9 22 0" ' + EYE_GLOW + ' stroke-width="4" stroke-linecap="round"/>',
    /* 生气：倒八字眉 + 竖线眼 */
    angry:
      '<path class="dk-brow" d="M49 55l15 7" ' + EYE_GLOW + ' stroke-width="4.2" stroke-linecap="round"/>' +
      '<path class="dk-brow" d="M97 55l-15 7" ' + EYE_GLOW + ' stroke-width="4.2" stroke-linecap="round"/>' +
      '<g class="dk-gaze">' +
        '<path class="dk-eye" d="M58 68v13" ' + EYE_GLOW + ' stroke-width="6" stroke-linecap="round"/>' +
        '<path class="dk-eye" d="M88 68v13" ' + EYE_GLOW + ' stroke-width="6" stroke-linecap="round"/>' +
      '</g>' +
      '<path class="dk-mouth" d="M66 88q7 1.4 14 0" ' + EYE_GLOW + ' stroke-width="4" stroke-linecap="round"/>',
    /* 思考：一点一箭头 + 平嘴 */
    think:
      '<g class="dk-gaze">' +
        '<circle class="dk-eye bd-blink-soft" cx="58" cy="72" r="4" fill="url(#dkBdGlow)"/>' +
        '<path class="dk-eye" d="M78 62l10 10-10 10" ' + EYE_GLOW + ' stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g>' +
      '<path class="dk-mouth" d="M64 87q8 1.4 16 0" ' + EYE_GLOW + ' stroke-width="4" stroke-linecap="round"/>',
    /* 难过：八字眼 + 泪滴 + 下撇嘴 */
    sad:
      '<g class="dk-gaze">' +
        '<path class="dk-eye" d="M50 64l14 11" ' + EYE_GLOW + ' stroke-width="5.6" stroke-linecap="round"/>' +
        '<path class="dk-eye" d="M96 64l-14 11" ' + EYE_GLOW + ' stroke-width="5.6" stroke-linecap="round"/>' +
      '</g>' +
      '<circle class="dk-tear" cx="53" cy="82" r="2.6" fill="url(#dkBdGlow)"/>' +
      '<path class="dk-mouth" d="M66 90q7-7 14 0" ' + EYE_GLOW + ' stroke-width="3.6" stroke-linecap="round"/>'
  };
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
      /* 腮红（固定不变）+ 表情槽（眼睛 / 嘴由 WHALE_FACES 渲染，保证画在蝴蝶结之上） */
      '<ellipse cx="24" cy="57" rx="4.5" ry="2.6" fill="rgba(255,140,165,.45)"/>' +
      '<ellipse cx="60" cy="57" rx="4.5" ry="2.6" fill="rgba(255,140,165,.45)"/>' +
      '<g class="dk-face-slot"></g>' +
    '</svg>';

  /* 奶龙：参考官方的黄橙色小恐龙 —— 头身连成一体、大绿眼睛、张嘴笑、
     左手举起打招呼（掌心粉肉垫 + 三颗小爪）、短腿、翘起的粗尾巴。
     配色走 --nd-c1 / --nd-c2（身体渐变）、--nd-b1 / --nd-b2（肚皮渐变）、
     --nd-paw（爪 / 脚趾）、--nd-ink（眼睛与嘴的墨色）。 */
  var NAILONG_HTML =
    '<svg class="dk-nd" viewBox="0 0 84 92" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="dkNdBody" x1="26" y1="4" x2="62" y2="90" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" class="dk-nd-s1"/><stop offset="1" class="dk-nd-s2"/>' +
        '</linearGradient>' +
        '<linearGradient id="dkNdBelly" x1="42" y1="50" x2="42" y2="88" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" class="dk-nd-b1"/><stop offset="1" class="dk-nd-b2"/>' +
        '</linearGradient>' +
      '</defs>' +
      /* 尾巴（在身后，会轻摆） */
      '<path class="dk-nd-tail" d="M23 79 C11 84 2 76 6 65 C10 73 17 74 24 71 Z" fill="url(#dkNdBody)"/>' +
      /* 短腿 + 脚趾 */
      '<ellipse cx="33" cy="83" rx="9.5" ry="7" fill="url(#dkNdBody)"/>' +
      '<ellipse cx="51" cy="83" rx="9.5" ry="7" fill="url(#dkNdBody)"/>' +
      '<g style="fill:var(--nd-paw,#a9702f)">' +
        '<circle cx="27" cy="88" r="1.8"/><circle cx="32" cy="89" r="1.8"/><circle cx="37" cy="88" r="1.8"/>' +
        '<circle cx="47" cy="88" r="1.8"/><circle cx="52" cy="89" r="1.8"/><circle cx="57" cy="88" r="1.8"/>' +
      '</g>' +
      /* 身体 + 大肚皮 */
      '<ellipse cx="42" cy="66" rx="24" ry="22" fill="url(#dkNdBody)"/>' +
      '<ellipse cx="42" cy="69" rx="15.5" ry="17" fill="url(#dkNdBelly)"/>' +
      /* 左手（举起打招呼）+ 粉色肉垫 + 小爪 */
      '<g transform="rotate(-18 13 55)">' +
        '<ellipse cx="13" cy="55" rx="9" ry="7" fill="url(#dkNdBody)"/>' +
        '<ellipse cx="14.5" cy="55.5" rx="3.6" ry="2.8" fill="#ffb0a0"/>' +
        '<g style="fill:var(--nd-paw,#a9702f)">' +
          '<circle cx="7" cy="50.5" r="1.9"/><circle cx="12" cy="49.5" r="1.9"/><circle cx="17" cy="50.5" r="1.9"/>' +
        '</g>' +
      '</g>' +
      /* 右手（垂下）+ 小爪 */
      '<g transform="rotate(14 72 59)">' +
        '<ellipse cx="72" cy="59" rx="7.5" ry="6.5" fill="url(#dkNdBody)"/>' +
        '<g style="fill:var(--nd-paw,#a9702f)">' +
          '<circle cx="69" cy="64" r="1.7"/><circle cx="73" cy="65" r="1.7"/><circle cx="77" cy="64" r="1.7"/>' +
        '</g>' +
      '</g>' +
      /* 圆头（与身体同渐变，重叠处看不出接缝） */
      '<ellipse cx="42" cy="32" rx="25" ry="26" fill="url(#dkNdBody)"/>' +
      /* 表情槽：眼睛 + 嘴 */
      '<g class="dk-face-slot"></g>' +
    '</svg>';

  /* 肥嘟嘟：一坨圆滚滚的糯米团子 —— 头顶卷毛 + 短手短脚 + 圆肚皮。
     配色走 --dd-c1 / --dd-c2 / --dd-belly / --dd-ink。 */
  var DUDU_HTML =
    '<svg class="dk-dd" viewBox="0 0 84 92" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="dkDdBody" x1="16" y1="20" x2="68" y2="88" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" class="dk-dd-s1"/><stop offset="1" class="dk-dd-s2"/>' +
        '</linearGradient>' +
      '</defs>' +
      /* 小脚 + 短手 */
      '<ellipse cx="30" cy="86" rx="9" ry="5.5" style="fill:var(--dd-c2,#f2c7d6)"/>' +
      '<ellipse cx="54" cy="86" rx="9" ry="5.5" style="fill:var(--dd-c2,#f2c7d6)"/>' +
      '<ellipse cx="11" cy="61" rx="7" ry="5.5" style="fill:var(--dd-c2,#f2c7d6)"/>' +
      '<ellipse cx="73" cy="61" rx="7" ry="5.5" style="fill:var(--dd-c2,#f2c7d6)"/>' +
      /* 圆身体 */
      '<ellipse cx="42" cy="57" rx="31" ry="30" fill="url(#dkDdBody)"/>' +
      /* 肚皮 */
      '<ellipse cx="42" cy="65" rx="19" ry="16" style="fill:var(--dd-belly,#fff7fa)"/>' +
      /* 头顶卷毛（会轻轻摆动） */
      '<path class="dk-dd-curl" d="M41 28 C34 22 38 13 44 17 C50 11 57 18 51 26" fill="none" style="stroke:var(--dd-ink,#7a5a66)" stroke-width="2.8" stroke-linecap="round"/>' +
      /* 腮红 + 表情槽 */
      '<ellipse cx="21" cy="63" rx="5.5" ry="3.2" fill="rgba(255,105,145,.5)"/>' +
      '<ellipse cx="63" cy="63" rx="5.5" ry="3.2" fill="rgba(255,105,145,.5)"/>' +
      '<g class="dk-face-slot"></g>' +
    '</svg>';

  // ---------- 桌小萌 / 鲸鱼娘的表情表 ----------
  /* 桌小萌：14×14 的小眼睛 SVG + 屏幕上的一行字符，配色靠 currentColor（--dk-c1） */
  var D_ST = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  function dkEye(inner) { return '<svg class="dk-eye" viewBox="0 0 14 14">' + inner + '</svg>'; }

  var DESKIE_FACES = {
    normal:
      '<div class="dk-gaze">' +
        dkEye('<path d="M4 2 L1 7 L4 12" ' + D_ST + '/>') +
        dkEye('<path d="M10 2 L13 7 L10 12" ' + D_ST + '/>') +
      '</div><div class="dk-belly">&lt;/&gt;</div>',
    happy:
      '<div class="dk-gaze">' +
        dkEye('<path d="M1 9 Q7 1 13 9" ' + D_ST + '/>') +
        dkEye('<path d="M1 9 Q7 1 13 9" ' + D_ST + '/>') +
      '</div><div class="dk-belly">^_^</div>',
    wink:
      '<div class="dk-gaze">' +
        dkEye('<path d="M4 2 L1 7 L4 12" ' + D_ST + '/>') +
        dkEye('<path d="M2 8 Q7 2 12 8" ' + D_ST + '/>') +
      '</div><div class="dk-belly">;P</div>',
    sleep:
      '<div class="dk-gaze">' +
        dkEye('<path d="M1 7 H13" ' + D_ST + '/>') +
        dkEye('<path d="M1 7 H13" ' + D_ST + '/>') +
      '</div><div class="dk-belly">zz</div>',
    surprised:
      '<div class="dk-gaze">' +
        dkEye('<circle cx="7" cy="7" r="5" ' + D_ST + '/>') +
        dkEye('<circle cx="7" cy="7" r="5" ' + D_ST + '/>') +
      '</div><div class="dk-belly">O_O</div>',
    love:
      '<div class="dk-gaze">' +
        dkEye('<path d="M7 13 C0 7.5 2.5 0.5 7 4.2 C11.5 0.5 14 7.5 7 13 Z" fill="currentColor"/>') +
        dkEye('<path d="M7 13 C0 7.5 2.5 0.5 7 4.2 C11.5 0.5 14 7.5 7 13 Z" fill="currentColor"/>') +
      '</div><div class="dk-belly">&lt;3</div>',
    angry:
      '<div class="dk-gaze">' +
        dkEye('<path d="M1 2 L7 9 L13 2" ' + D_ST + '/>') +
        dkEye('<path d="M1 2 L7 9 L13 2" ' + D_ST + '/>') +
      '</div><div class="dk-belly">!!</div>',
    think:
      '<div class="dk-gaze">' +
        dkEye('<circle cx="7" cy="7" r="2.2" fill="currentColor"/>') +
        dkEye('<path d="M4 2 L1 7 L4 12" ' + D_ST + '/>') +
      '</div><div class="dk-belly">?</div>',
    sad:
      '<div class="dk-gaze">' +
        dkEye('<path d="M2 4 L11 10" ' + D_ST + '/>') +
        dkEye('<path d="M12 4 L3 10" ' + D_ST + '/>') +
      '</div><div class="dk-belly">T_T</div>'
  };

  /* 鲸鱼娘：眼睛 / 嘴直接画在 84×92 的 SVG 里，颜色全部取 --wh-hair 等变量 */
  var WHALE_FACES = {
    normal:
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
      '<path d="M39 58 Q42 61 45 58" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.5" stroke-linecap="round"/>',
    happy:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M28 51 Q33 44 38 51" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M46 51 Q51 44 56 51" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M37 57 Q42 64 47 57 Z" style="fill:var(--wh-hair)"/>',
    wink:
      '<g class="dk-gaze">' +
        '<g class="dk-eye">' +
          '<ellipse cx="33" cy="50" rx="5" ry="6" style="fill:var(--wh-hair)"/>' +
          '<circle cx="34.8" cy="47.4" r="2" fill="#fff"/>' +
        '</g>' +
        '<g class="dk-eye"><path d="M46 51 Q51 44 56 51" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M38 58 Q42 63 46 58" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.6" stroke-linecap="round"/>',
    sleep:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M28 50 H38" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M46 50 H56" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<ellipse cx="42" cy="59" rx="2.2" ry="1.6" style="fill:var(--wh-hair)"/>',
    surprised:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><circle cx="33" cy="50" r="5" fill="none" style="stroke:var(--wh-hair)" stroke-width="2"/></g>' +
        '<g class="dk-eye"><circle cx="51" cy="50" r="5" fill="none" style="stroke:var(--wh-hair)" stroke-width="2"/></g>' +
      '</g>' +
      '<ellipse cx="42" cy="60" rx="1.9" ry="2.4" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.4"/>',
    love:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M33 55 C27 51 29 45 33 48 C37 45 39 51 33 55 Z" style="fill:var(--wh-ribbon)"/></g>' +
        '<g class="dk-eye"><path d="M51 55 C45 51 47 45 51 48 C55 45 57 51 51 55 Z" style="fill:var(--wh-ribbon)"/></g>' +
      '</g>' +
      '<path d="M38 58 Q42 62 46 58" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.6" stroke-linecap="round"/>',
    angry:
      '<path d="M27 45 L37 48" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M57 45 L47 48" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.8" stroke-linecap="round"/>' +
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M31 47 V53" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M53 47 V53" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M38 60 H46" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.8" stroke-linecap="round"/>',
    think:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><circle cx="33" cy="50" r="2.2" style="fill:var(--wh-hair)"/></g>' +
        '<g class="dk-eye">' +
          '<ellipse cx="51" cy="50" rx="5" ry="6" style="fill:var(--wh-hair)"/>' +
          '<circle cx="52.8" cy="47.4" r="2" fill="#fff"/>' +
        '</g>' +
      '</g>' +
      '<path d="M40 59.5 H46" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.6" stroke-linecap="round"/>',
    sad:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M28 47 L36 52" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M56 47 L48 52" fill="none" style="stroke:var(--wh-hair)" stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<circle cx="29" cy="58" r="1.8" style="fill:var(--wh-blow)"/>' +
      '<path d="M39 61 Q42 57 45 61" fill="none" style="stroke:var(--wh-hair)" stroke-width="1.6" stroke-linecap="round"/>'
  };

  /* 奶龙 / 肥嘟嘟：眼睛和嘴都画在自己的坐标系里（头部区域），颜色取各自的 ink 变量 */
  var ND_S = 'style="stroke:var(--nd-ink,#3c2a12)"';
  var ND_F = 'style="fill:var(--nd-ink,#3c2a12)"';
  var DD_S = 'style="stroke:var(--dd-ink,#7a5a66)"';
  var DD_F = 'style="fill:var(--dd-ink,#7a5a66)"';
  /* 奶龙的绿色大眼（官方形象固定绿眼）+ 深色瞳孔 + 两点反光 */
  function ndEye(cx, sc) {
    sc = sc || 1;
    return '<ellipse cx="' + cx + '" cy="30" rx="' + (6.2 * sc) + '" ry="' + (7.2 * sc) + '" fill="#3fbf6a"/>' +
           '<ellipse cx="' + (cx + 0.4) + '" cy="31" rx="' + (3.4 * sc) + '" ry="' + (4.4 * sc) + '" ' + ND_F + '/>' +
           '<circle cx="' + (cx - 1.6) + '" cy="27.2" r="2.2" fill="#fff"/>' +
           '<circle cx="' + (cx + 2.2) + '" cy="33.2" r="1.2" fill="rgba(255,255,255,.65)"/>';
  }
  /* 奶龙的招牌笑嘴：深色口腔 + 上排白牙 */
  var ND_SMILE =
    '<path d="M31.5 43.8 Q42 43 52.5 43.8 Q42 57 31.5 43.8 Z" fill="#6b2f22"/>' +
    '<path d="M33.4 44.4 Q42 46.2 50.6 44.4 L50.2 47.4 Q42 49.2 33.8 47.4 Z" fill="#fff"/>';
  /* 奶龙：头 cx42 cy32 rx25 ry26 → 眼在 y30、嘴在 y44~50 */
  var NAILONG_FACES = {
    normal:
      '<g class="dk-gaze"><g class="dk-eye">' + ndEye(32) + '</g><g class="dk-eye">' + ndEye(52) + '</g></g>' +
      ND_SMILE,
    happy:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M26 31 Q32 22 38 31" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M46 31 Q52 22 58 31" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' + ND_SMILE,
    wink:
      '<g class="dk-gaze">' +
        '<g class="dk-eye">' + ndEye(32) + '</g>' +
        '<g class="dk-eye"><path d="M46 31 Q52 22 58 31" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' + ND_SMILE,
    sleep:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M26 30 H38" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M46 30 H58" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<ellipse cx="42" cy="47" rx="2.4" ry="1.8" ' + ND_F + '/>',
    surprised:
      '<g class="dk-gaze"><g class="dk-eye">' + ndEye(32, 1.12) + '</g><g class="dk-eye">' + ndEye(52, 1.12) + '</g></g>' +
      '<ellipse cx="42" cy="48" rx="3" ry="3.8" fill="none" ' + ND_S + ' stroke-width="1.5"/>',
    love:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M32 36 C26 31 28 25 32 28 C36 25 38 31 32 36 Z" style="fill:#ff6f9c"/></g>' +
        '<g class="dk-eye"><path d="M52 36 C46 31 48 25 52 28 C56 25 58 31 52 36 Z" style="fill:#ff6f9c"/></g>' +
      '</g>' + ND_SMILE,
    angry:
      '<path d="M26 25 L38 28" fill="none" ' + ND_S + ' stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M58 25 L46 28" fill="none" ' + ND_S + ' stroke-width="1.8" stroke-linecap="round"/>' +
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M30 29 V36" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M54 29 V36" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M36 48 H48" fill="none" ' + ND_S + ' stroke-width="1.8" stroke-linecap="round"/>',
    think:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><circle cx="32" cy="30" r="2.4" ' + ND_F + '/></g>' +
        '<g class="dk-eye">' + ndEye(52) + '</g>' +
      '</g>' +
      '<path d="M38 48 H47" fill="none" ' + ND_S + ' stroke-width="1.6" stroke-linecap="round"/>',
    sad:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M26 27 L36 32" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M58 27 L48 32" fill="none" ' + ND_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<circle cx="27" cy="38" r="1.8" fill="#8fd8ff"/>' +
      '<path d="M35 50 Q42 44 49 50" fill="none" ' + ND_S + ' stroke-width="1.6" stroke-linecap="round"/>'
  };
  /* 肥嘟嘟：身体 cx42 cy57 rx31 ry30 → 眼在 y52、嘴在 y63~66 */
  var DUDU_FACES = {
    normal:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><ellipse cx="32" cy="52" rx="5.8" ry="7" ' + DD_F + '/><circle cx="34" cy="48.6" r="2.2" fill="#fff"/></g>' +
        '<g class="dk-eye"><ellipse cx="52" cy="52" rx="5.8" ry="7" ' + DD_F + '/><circle cx="53.8" cy="49.4" r="2" fill="#fff"/></g>' +
      '</g>' +
      '<path d="M38 63 Q42 67 46 63" fill="none" ' + DD_S + ' stroke-width="1.6" stroke-linecap="round"/>',
    happy:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M27 55 Q32 46 37 55" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M47 55 Q52 46 57 55" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M37 62 Q42 70 47 62 Z" ' + DD_F + '/>',
    wink:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><ellipse cx="32" cy="52" rx="5.8" ry="7" ' + DD_F + '/><circle cx="34" cy="48.6" r="2.2" fill="#fff"/></g>' +
        '<g class="dk-eye"><path d="M47 55 Q52 46 57 55" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M38 63 Q42 68 46 63" fill="none" ' + DD_S + ' stroke-width="1.6" stroke-linecap="round"/>',
    sleep:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M27 52 H37" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M47 52 H57" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<ellipse cx="42" cy="64" rx="2.2" ry="1.6" ' + DD_F + '/>',
    surprised:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><circle cx="32" cy="52" r="5" fill="none" ' + DD_S + ' stroke-width="2"/></g>' +
        '<g class="dk-eye"><circle cx="52" cy="52" r="5" fill="none" ' + DD_S + ' stroke-width="2"/></g>' +
      '</g>' +
      '<ellipse cx="42" cy="66" rx="2" ry="2.6" fill="none" ' + DD_S + ' stroke-width="1.4"/>',
    love:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M32 58 C26 53 28 47 32 50 C36 47 38 53 32 58 Z" style="fill:#ff6f9c"/></g>' +
        '<g class="dk-eye"><path d="M52 58 C46 53 48 47 52 50 C56 47 58 53 52 58 Z" style="fill:#ff6f9c"/></g>' +
      '</g>' +
      '<path d="M38 62 Q42 68 46 62" fill="none" ' + DD_S + ' stroke-width="1.6" stroke-linecap="round"/>',
    angry:
      '<path d="M26 45 L37 48" fill="none" ' + DD_S + ' stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M58 45 L47 48" fill="none" ' + DD_S + ' stroke-width="1.8" stroke-linecap="round"/>' +
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M30 49 V56" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M54 49 V56" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<path d="M38 65 H46" fill="none" ' + DD_S + ' stroke-width="1.8" stroke-linecap="round"/>',
    think:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><circle cx="32" cy="52" r="2.2" ' + DD_F + '/></g>' +
        '<g class="dk-eye"><ellipse cx="52" cy="52" rx="5.8" ry="7" ' + DD_F + '/><circle cx="53.8" cy="49.4" r="2" fill="#fff"/></g>' +
      '</g>' +
      '<path d="M40 64 H46" fill="none" ' + DD_S + ' stroke-width="1.6" stroke-linecap="round"/>',
    sad:
      '<g class="dk-gaze">' +
        '<g class="dk-eye"><path d="M27 49 L36 54" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
        '<g class="dk-eye"><path d="M57 49 L48 54" fill="none" ' + DD_S + ' stroke-width="2.2" stroke-linecap="round"/></g>' +
      '</g>' +
      '<circle cx="28" cy="60" r="1.8" fill="#8fd8ff"/>' +
      '<path d="M38 67 Q42 62 46 67" fill="none" ' + DD_S + ' stroke-width="1.6" stroke-linecap="round"/>'
  };

  // ---------- 通用的「表情 / 颜色 / 动作」 ----------
  var FACE_ORDER = ['normal', 'happy', 'wink', 'sleep', 'surprised', 'love', 'angry', 'think', 'sad'];
  var FACE_NAME = {
    normal: '认真', happy: '开心', wink: '眨眼', sleep: '犯困', surprised: '惊讶',
    love: '喜欢', angry: '生气', think: '思考', sad: '难过'
  };
  /* 色板：每项是一组 CSS 变量，换色就是换变量值，SVG / CSS 里统一引用 */
  var BUDDY_HUES = [
    { '--bd-c1': '#7fe0ff', '--bd-c2': '#37a9ff' },   // 冰蓝
    { '--bd-c1': '#9ef7d0', '--bd-c2': '#22c98a' },   // 薄荷
    { '--bd-c1': '#ffd39a', '--bd-c2': '#ff9a2e' },   // 琥珀
    { '--bd-c1': '#ffc2d6', '--bd-c2': '#ff5f9e' },   // 樱粉
    { '--bd-c1': '#d3b8ff', '--bd-c2': '#8b5cf6' },   // 薰衣草
    { '--bd-c1': '#ffe98a', '--bd-c2': '#ffc531' },   // 柠檬
    { '--bd-c1': '#ffb3a8', '--bd-c2': '#ff4d4d' }    // 珊瑚
  ];
  /* 桌小萌：眼睛 + 头顶呼吸灯同色 */
  var DESKIE_HUES = [
    { '--dk-c1': '#3aa4ff', '--dk-glow': 'rgba(58,164,255,.55)' },  // 电光蓝
    { '--dk-c1': '#22c98a', '--dk-glow': 'rgba(34,201,138,.55)' },  // 薄荷
    { '--dk-c1': '#ff9a2e', '--dk-glow': 'rgba(255,154,46,.55)' },  // 琥珀
    { '--dk-c1': '#ff5f9e', '--dk-glow': 'rgba(255,95,158,.55)' },  // 樱粉
    { '--dk-c1': '#8b5cf6', '--dk-glow': 'rgba(139,92,246,.55)' },  // 薰衣草
    { '--dk-c1': '#ffc531', '--dk-glow': 'rgba(255,197,49,.55)' },  // 柠檬
    { '--dk-c1': '#ff4d4d', '--dk-glow': 'rgba(255,77,77,.55)' }    // 珊瑚
  ];
  /* 鲸鱼娘：整体换装（身体 / 头发 / 蝴蝶结 / 喷水） */
  var WHALE_HUES = [
    { '--wh-c-body1': '#66cbff', '--wh-c-body2': '#1f6fd0', '--wh-c-ribbon': '#ff7fa8', '--wh-c-hair': '#22355e', '--wh-c-blow': '#bfe9ff' }, // 海蓝
    { '--wh-c-body1': '#8ff0c8', '--wh-c-body2': '#14a06c', '--wh-c-ribbon': '#ffcf6b', '--wh-c-hair': '#1d3b33', '--wh-c-blow': '#c8ffe8' }, // 薄荷
    { '--wh-c-body1': '#ffb8d8', '--wh-c-body2': '#e0508f', '--wh-c-ribbon': '#ffd166', '--wh-c-hair': '#4a2340', '--wh-c-blow': '#ffd9e8' }, // 樱花
    { '--wh-c-body1': '#c9b6ff', '--wh-c-body2': '#6b46d6', '--wh-c-ribbon': '#ffb3d1', '--wh-c-hair': '#2c2350', '--wh-c-blow': '#e6dcff' }, // 薰衣草
    { '--wh-c-body1': '#ffd08a', '--wh-c-body2': '#e07a1f', '--wh-c-ribbon': '#ff8f6b', '--wh-c-hair': '#4a2f16', '--wh-c-blow': '#ffe9c7' }, // 琥珀
    { '--wh-c-body1': '#9be3ff', '--wh-c-body2': '#2a7fb8', '--wh-c-ribbon': '#8fe0c8', '--wh-c-hair': '#123244', '--wh-c-blow': '#d6f4ff' }  // 冰川
  ];
  /* 奶龙：整体换皮（身体渐变、肚皮渐变、爪子、墨色） */
  var NAILONG_HUES = [
    { '--nd-c1': '#ffe14a', '--nd-c2': '#ffa62b', '--nd-b1': '#fffbe0', '--nd-b2': '#ffe9a0', '--nd-paw': '#a9702f', '--nd-ink': '#3c2a12' }, // 奶黄
    { '--nd-c1': '#fff08a', '--nd-c2': '#e8b93c', '--nd-b1': '#fffdf0', '--nd-b2': '#fff3c8', '--nd-paw': '#9a7a2f', '--nd-ink': '#4a3a14' }, // 柠檬
    { '--nd-c1': '#ffcf8a', '--nd-c2': '#ef8b32', '--nd-b1': '#fff3e0', '--nd-b2': '#ffdfb0', '--nd-paw': '#a05a2a', '--nd-ink': '#4a2c12' }, // 蜜桃
    { '--nd-c1': '#b4f2d0', '--nd-c2': '#3fb87e', '--nd-b1': '#f0fff7', '--nd-b2': '#d6f7e6', '--nd-paw': '#2f7a55', '--nd-ink': '#17402c' }, // 薄荷
    { '--nd-c1': '#b0e0ff', '--nd-c2': '#3f8ede', '--nd-b1': '#f0f9ff', '--nd-b2': '#d8ecff', '--nd-paw': '#2f5f8a', '--nd-ink': '#16324a' }, // 天蓝
    { '--nd-c1': '#ffd0e0', '--nd-c2': '#e8618f', '--nd-b1': '#fff5f8', '--nd-b2': '#ffe0ea', '--nd-paw': '#a04a68', '--nd-ink': '#4a1f30' }, // 樱花
    { '--nd-c1': '#dcc8ff', '--nd-c2': '#8b5cf6', '--nd-b1': '#f7f2ff', '--nd-b2': '#ece0ff', '--nd-paw': '#5f4a9a', '--nd-ink': '#2c2050' }  // 芋泥
  ];
  /* 肥嘟嘟：整体换皮（身体亮/暗、肚皮、墨色） */
  var DUDU_HUES = [
    { '--dd-c1': '#ffd7e3', '--dd-c2': '#f2b8c8', '--dd-belly': '#fff7fa', '--dd-ink': '#7a5a66' }, // 奶白
    { '--dd-c1': '#ffb8ca', '--dd-c2': '#e87ba0', '--dd-belly': '#fff0f4', '--dd-ink': '#5c2b3c' }, // 草莓
    { '--dd-c1': '#c8f0d4', '--dd-c2': '#8ed4a8', '--dd-belly': '#f2fff6', '--dd-ink': '#2f5040' }, // 抹茶
    { '--dd-c1': '#d9c4ff', '--dd-c2': '#a98ee8', '--dd-belly': '#f6f0ff', '--dd-ink': '#3a2b58' }, // 芋泥
    { '--dd-c1': '#ffe1a8', '--dd-c2': '#e8b356', '--dd-belly': '#fff8e8', '--dd-ink': '#5a4320' }, // 芝士
    { '--dd-c1': '#b8ddff', '--dd-c2': '#7aaee8', '--dd-belly': '#eff7ff', '--dd-ink': '#22405c' }  // 蓝莓
  ];
  /* 动作表：一个动作 = 一套整体动画 + 一个表情 + 一句台词（三个角色各说各的） */
  var BUDDY_ACTS = [
    { mv: 'shake', face: 'angry', line: '别、别晃我，头晕啦…' },
    { mv: 'tilt', face: 'think', line: '嗯……让我想一下。' },
    { mv: 'spin', face: 'happy', line: '转一圈，灵感就来啦！' },
    { mv: 'squash', face: 'surprised', line: '哎呀，被压扁了！' },
    { mv: 'nod', face: 'normal', line: '收到，这就安排上。' },
    { mv: 'wobble', face: 'love', line: '嘿嘿，好开心 ~' },
    { mv: 'peek', face: 'wink', line: '偷偷看你写了什么…' },
    { mv: 'stretch', face: 'sleep', line: '伸个懒腰，继续干活。' }
  ];
  var DESKIE_ACTS = [
    { mv: 'shake', face: 'angry', line: '别晃啦，代码都被你抖乱了！' },
    { mv: 'tilt', face: 'think', line: '让我想想这段该怎么改…' },
    { mv: 'spin', face: 'happy', line: '转一圈，好运连连！' },
    { mv: 'squash', face: 'surprised', line: '喂喂，别压我呀！' },
    { mv: 'nod', face: 'normal', line: '嗯嗯，收到！' },
    { mv: 'wobble', face: 'love', line: '嘿嘿，你最好啦 ~' },
    { mv: 'peek', face: 'wink', line: '我在看你的代码哦。' },
    { mv: 'stretch', face: 'sleep', line: '伸个懒腰，继续写 ~' }
  ];
  var WHALE_ACTS = [
    { mv: 'shake', face: 'angry', line: '咕噜！水都被你晃浑了。' },
    { mv: 'tilt', face: 'think', line: '唔…让我潜下去想一想。' },
    { mv: 'spin', face: 'happy', line: '转个圈，溅你一身水花！' },
    { mv: 'squash', face: 'surprised', line: '呜哇，被压扁啦！' },
    { mv: 'nod', face: 'normal', line: '咕噜咕噜，明白啦。' },
    { mv: 'wobble', face: 'love', line: '最喜欢和你一起写代码了。' },
    { mv: 'peek', face: 'wink', line: '偷偷浮上来看一眼…' },
    { mv: 'stretch', face: 'sleep', line: '海面好安静，有点困了…' }
  ];
  var NAILONG_ACTS = [
    { mv: 'shake', face: 'angry', line: '哎哟别晃，我头都晕啦！' },
    { mv: 'tilt', face: 'think', line: '让我想想…要不先吃口饭？' },
    { mv: 'spin', face: 'happy', line: '转一圈，转出个好运气！' },
    { mv: 'squash', face: 'surprised', line: '啊！我是不是变扁了？' },
    { mv: 'nod', face: 'normal', line: '好嘞，这就去办！' },
    { mv: 'wobble', face: 'love', line: '你最好啦，给你一个抱抱 ~' },
    { mv: 'peek', face: 'wink', line: '偷偷看一眼你在写什么…' },
    { mv: 'stretch', face: 'sleep', line: '吃饱了就困…先眯一会儿。' }
  ];
  var DUDU_ACTS = [
    { mv: 'shake', face: 'angry', line: '别晃别晃，肉都要甩出去啦！' },
    { mv: 'tilt', face: 'think', line: '嗯…嘟嘟正在思考中。' },
    { mv: 'spin', face: 'happy', line: '转转转，圆圆满满！' },
    { mv: 'squash', face: 'surprised', line: '哇，我又弹回来啦！' },
    { mv: 'nod', face: 'normal', line: '收到收到，嘟嘟记下了。' },
    { mv: 'wobble', face: 'love', line: '抱起来软软的吧 ~' },
    { mv: 'peek', face: 'wink', line: '嘿，被我偷看到啦。' },
    { mv: 'stretch', face: 'sleep', line: '困了…嘟嘟要缩成一团了。' }
  ];

  var MOOD = {
    buddy: { faces: BUDDY_FACES, hues: BUDDY_HUES, acts: BUDDY_ACTS },
    deskie: { faces: DESKIE_FACES, hues: DESKIE_HUES, acts: DESKIE_ACTS },
    whale: { faces: WHALE_FACES, hues: WHALE_HUES, acts: WHALE_ACTS },
    nailong: { faces: NAILONG_FACES, hues: NAILONG_HUES, acts: NAILONG_ACTS },
    dudu: { faces: DUDU_FACES, hues: DUDU_HUES, acts: DUDU_ACTS }
  };
  /* 每个角色各自记住当前表情与配色序号，切换伙伴再切回来不会丢 */
  var STATE = {};
  for (var _pid in MOOD) if (Object.prototype.hasOwnProperty.call(MOOD, _pid)) STATE[_pid] = { face: 'normal', hue: 0 };

  var moveTimer = null, faceTimer = null;

  function moodNow() { return MOOD[curId] || null; }
  function stateNow() { return STATE[curId] || STATE.buddy; }

  /* 换表情：只重绘 .dk-face-slot，身体 / 渐变 / 配色都复用 */
  function paintFace(f) {
    var m = moodNow();
    if (!m) return;
    if (!m.faces[f]) f = 'normal';
    stateNow().face = f;
    var slot = el.querySelector('.dk-face-slot');
    if (!slot) return;
    slot.innerHTML = m.faces[f];
    bindGaze();
  }
  function paintHue() {
    var m = moodNow();
    if (!m || !m.hues.length) return;
    var vars = m.hues[stateNow().hue % m.hues.length];
    for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) el.style.setProperty(k, vars[k]);
  }
  function setHue(i) {
    var m = moodNow();
    if (!m || !m.hues.length) return;
    stateNow().hue = ((i % m.hues.length) + m.hues.length) % m.hues.length;
    paintHue();
  }
  /* 换一个和当前不同的颜色 */
  function nextHue() {
    var m = moodNow();
    if (!m || m.hues.length < 2) return;
    setHue(stateNow().hue + 1 + Math.floor(Math.random() * (m.hues.length - 1)));
  }
  function playMove(mv) {
    var all = ['a-shake', 'a-tilt', 'a-spin', 'a-squash', 'a-nod', 'a-wobble', 'a-peek', 'a-stretch'];
    for (var i = 0; i < all.length; i++) el.classList.remove(all[i]);
    void el.offsetWidth;                                  // 重启动画
    var cls = 'a-' + mv;
    el.classList.add(cls);
    clearTimeout(moveTimer);
    moveTimer = setTimeout(function () { el.classList.remove(cls); }, 1300);
  }
  /* 播一套动作（换表情 + 动起来 + 可选台词），2.8s 后表情自动回到「认真」 */
  function doAct(index, quiet) {
    var m = moodNow();
    if (!m || !m.acts.length) return null;
    var a = (typeof index === 'number' && m.acts[index]) ? m.acts[index] : pick(m.acts);
    paintFace(a.face);
    playMove(a.mv);
    clearTimeout(faceTimer);
    faceTimer = setTimeout(function () { if (MOOD[curId]) paintFace('normal'); }, 2800);
    if (!quiet && a.line) say(a.line, 2800);
    return a;
  }
  /* 空闲时自己玩耍：每 5~12 秒来一次小动作，偶尔换个颜色 / 嘀咕一句 */
  (function autoPlay() {
    setTimeout(function () {
      if (MOOD[curId] && !el.classList.contains('hide') && !document.hidden) {
        doAct(null, Math.random() > 0.78);
        if (Math.random() < 0.5) nextHue();
      }
      autoPlay();
    }, 5200 + Math.random() * 6800);
  })();

  var PETS = {
    buddy: {
      name: '小 Buddy', icon: 'bi-stars', html: BUDDY_HTML,
      hello: 'Hi Buddy ~ 我在这儿陪着你！',
      greet: [
        [5, 9, '早上好！今天想先写哪段代码？'],
        [9, 12, '上午好，任务清单过了几项啦？'],
        [12, 14, '中午啦，起来走两步再回来 ~'],
        [14, 18, '下午好，泡杯茶继续吧。'],
        [18, 23, '晚上好，晚上写码最安静了。'],
        [23, 24, '夜深了，收个尾就去睡吧。'],
        [0, 5, '还醒着？我陪你到这段写完。']
      ],
      lines: [
        'Hi Buddy，需要我帮忙吗？',
        '拖我到顺手的位置吧，我会记住的。',
        '双击我会跳一下哦！',
        'Ctrl + P 搜文件，Ctrl + Shift + F 搜内容。',
        'F5 运行当前文件，我在这儿看着输出。',
        '右边的 AI 助手可以做更多事，试试它。',
        '写完记得 Ctrl + S，别丢了进度。',
        '右键有我，可以换个伙伴陪我。',
        '定时任务别忘了检查一遍。',
        '终端里的命令，先看一眼再回车。',
        '今天的 bug，明天就是经验啦。',
        '我就是欢迎页上的那个小伙伴 ~'
      ]
    },
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
    },
    nailong: {
      name: '奶龙 (Nailong)', icon: 'bi-emoji-laughing', html: NAILONG_HTML,
      hello: '嗷呜 ~ 奶龙来陪你写代码啦！',
      greet: [
        [5, 9, '早上好！先吃早饭再写代码哦 ~'],
        [9, 12, '上午好，写累了就捏捏我的肚子。'],
        [12, 14, '午饭时间！奶龙也要吃一口。'],
        [14, 18, '下午啦，来杯奶茶续命吧 ~'],
        [18, 23, '晚上好，灯光暗了记得调亮屏幕。'],
        [23, 24, '夜深啦，写完这段就去睡吧。'],
        [0, 5, '还醒着？奶龙陪你一起熬…']
      ],
      lines: [
        '我是奶龙，圆滚滚的那种！',
        '双击我，我就蹦给你看 ~',
        '肚子软软的，可以当抱枕。',
        '报错了别慌，先看最后一行。',
        'Ctrl + S 是你的存档点。',
        'F5 跑一下，看看结果如何。',
        '写不出来就先站起来走两步。',
        '尾巴会甩，说明我很开心。',
        '右键可以换表情，我有很多表情！',
        '你的代码在长大，我也在长大。',
        '困了就眯一会儿，我守着。',
        '奶龙最擅长的技能是：陪着你。'
      ]
    },
    dudu: {
      name: '肥嘟嘟 (Dudu)', icon: 'bi-emoji-heart-eyes', html: DUDU_HTML,
      hello: '嘿嘿，肥嘟嘟来啦 ~',
      greet: [
        [5, 9, '早呀，今天也要圆圆满满！'],
        [9, 12, '上午好，坐久了记得伸个懒腰。'],
        [12, 14, '吃饭啦吃饭啦 ~ 嘟嘟最期待这个。'],
        [14, 18, '下午好，喝口水再继续吧。'],
        [18, 23, '晚上好，今天也很努力呢。'],
        [23, 24, '该睡啦，明天再战。'],
        [0, 5, '还没睡？嘟嘟陪你数 bug。']
      ],
      lines: [
        '我是一坨圆滚滚的嘟嘟。',
        '双击我，我会弹一下！',
        '肉多一点，抱着才舒服。',
        'Git 提交前先看一眼 diff 哦。',
        '别急，慢慢来比较快。',
        '我的卷毛会晃，看到没？',
        '右键可以给我换颜色 ~',
        '写代码的时候记得喝水。',
        '今天也要开心呀。',
        '累了就靠在我身上休息。',
        '我软软的，压力都被吸走了。',
        '嘟嘟永远站你这边。'
      ]
    }
  };
  var ORDER = ['buddy', 'deskie', 'whale', 'nailong', 'dudu'];
  var curId = 'buddy';     // 未手动选过伙伴时，默认就是和欢迎页一致的「小 Buddy」

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

  var gazes = [];
  /* 重新抓取当前表情里的眼球容器（换表情会重建表情槽，必须重新取） */
  function bindGaze() { gazes = el.querySelectorAll('.dk-gaze'); }

  function renderPet() {
    var p = curPet();
    for (var i = 0; i < ORDER.length; i++) el.classList.remove('is-' + ORDER[i]);
    el.classList.add('is-' + curId);
    el.innerHTML = '<div class="dk-stage"><div class="dk-shadow"></div>' + p.html + '</div>';
    bindGaze();
    if (MOOD[curId]) {                 // 换回来时沿用这个伙伴上次的表情与配色
      paintFace(stateNow().face);
      paintHue();
    }
    summon.title = '召唤' + p.name;
    summon.innerHTML = '<i class="bi ' + p.icon + '"></i>';
  }

  function renderMenu() {
    var h =
      '<div class="dk-mi" data-act="say"><i class="bi bi-chat-dots"></i>说点什么</div>' +
      '<div class="dk-mi" data-act="act"><i class="bi bi-magic"></i>随便动一下</div>' +
      '<div class="dk-mi" data-act="hop"><i class="bi bi-arrow-up-square"></i>跳一下</div>' +
      '<div class="dk-mi" data-act="home"><i class="bi bi-house"></i>回到右下角</div>';
    // 所有伙伴都有：换个表情 / 换个颜色
    if (MOOD[curId]) {
      var curF = stateNow().face;
      h += '<div class="dk-sep"></div><div class="dk-cap">换个表情</div><div class="dk-chips">';
      for (var k = 0; k < FACE_ORDER.length; k++) {
        var f = FACE_ORDER[k];
        h += '<div class="dk-chip' + (f === curF ? ' on' : '') + '" data-face="' + f + '">' +
               FACE_NAME[f] + '</div>';
      }
      h += '</div><div class="dk-chips">' +
             '<div class="dk-chip" data-hue="1"><i class="bi bi-palette"></i> 换个颜色</div>' +
           '</div>';
    }
    h += '<div class="dk-sep"></div><div class="dk-cap">换个伙伴</div>';
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
    if ((ev.detail || 0) >= 2) {                   // 双击：跳一下
      if (MOOD[curId]) { paintFace('happy'); nextHue(); }
      hop('哇，被抓到了 ~');
    } else if (MOOD[curId]) {                      // 单击：随机来套动作 + 换表情
      doAct();
      if (Math.random() < 0.6) nextHue();
    } else {
      say();
    }
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
    if (!gazes.length) return;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height * 0.55;
    var ang = Math.atan2(ev.clientY - cy, ev.clientX - cx);
    var d = Math.min(3.5, Math.hypot(ev.clientX - cx, ev.clientY - cy) / 60);
    var tf = 'translate(' + (Math.cos(ang) * d).toFixed(1) + 'px,' + (Math.sin(ang) * d).toFixed(1) + 'px)';
    for (var i = 0; i < gazes.length; i++) gazes[i].style.transform = tf;
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
    renderMenu();                                  // 打开前重绘，保证表情高亮 / 伙伴勾选是最新的
    var r = el.getBoundingClientRect();
    openMenu(ev.clientX || r.left, ev.clientY || r.top);
  });
  menu.addEventListener('click', function (ev) {
    var chip = ev.target.closest && ev.target.closest('.dk-chip');
    if (chip) {                                    // 表情 / 颜色：点完不关菜单，方便连着试
      if (chip.dataset.face) { paintFace(chip.dataset.face); renderMenu(); }
      else if (chip.dataset.hue) nextHue();
      return;
    }
    var mi = ev.target.closest('.dk-mi');
    if (!mi) return;
    closeMenu();
    if (mi.dataset.pet) { use(mi.dataset.pet); return; }
    var act = mi.dataset.act;
    if (act === 'say') {
      if (MOOD[curId]) doAct(null); else say(pick(curPet().lines));
    } else if (act === 'act') {
      if (MOOD[curId]) doAct(); else hop();
    } else if (act === 'hop') hop();
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
    current: function () { return curId; },
    /* 当前伙伴的表情 / 颜色 / 动作 */
    face: function (f) { paintFace(f); },
    faces: FACE_ORDER.slice(),
    color: function (i) { setHue(typeof i === 'number' ? i : 0); },
    nextColor: nextHue,
    act: function (i) { doAct(i); },
    acts: function () { return (moodNow() ? moodNow().acts : []).map(function (a) { return a.mv; }); }
  };
  window.addEventListener('deskie-say', function (ev) {
    if (ev && ev.detail) say(String(ev.detail));
  });
  })();
