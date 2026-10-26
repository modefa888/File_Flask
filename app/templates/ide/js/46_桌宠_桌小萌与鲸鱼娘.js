/* IDE 桌宠：小 Buddy (Buddy)、桌小萌 (Deskie)、鲸鱼娘 (Kujira)、奶龙 (Nailong)、肥嘟嘟 (Dudu)。
   - 可拖动到任意位置（localStorage 记忆），会眨眼、呼吸/漂浮、眼神跟随鼠标
   - 单击说话（按时间段问候 + 随机吐槽），双击跳一下
   - 右键菜单：和我聊聊天 / 说点什么 / 随便动一下 / 跳一下 / 回到右下角 /
     换个表情 + 换个颜色 / 换个伙伴（二级菜单，五个角色任选）/ 隐身
   - AI 对话（showChat）：桌宠头顶的对话小按钮或右键菜单进入，走 POST /api/ai/chat 流式；
     每个伙伴一份记忆（localStorage，最近 80 条，请求带最近 12 轮），
     面板右上角地球按钮 = 按需联网：请求体带 web_tool=1，只把 web_search 工具交给模型，
     由它判断要不要查（不做「回复前预搜索」，不做无谓的搜索延迟），
     「项目」开关 = 智能体模式：带 repo + use_tools，模型可 list_dir / read_file /
     search_files / code_intel 读取当前项目文件（perm=readonly，只读），
     工具过程通过 SSE 的 step / result 事件显示在顶部提示条上；
     对话超过 30 条时自动把早期内容压成摘要（LS_SUM），只保留最近 16 条原文，
     摘要随 system 消息一起发送 —— 长对话不会越聊越贵，也不再显示「记忆 N 轮」；
     「Agent」开关 = 界面操作：模型在正文里写 <ide>{"act":…}</ide>，前端边流式边执行
     （开/关侧栏面板、打开文件、切标签、运行、终端、搜索、设置…），并把标签从文本里剥掉；
     发消息时还会把「当前左侧面板的可点条目清单」（序号 + 文字）附进 system，
     所以模型能按 click 动作精确点第 N 个远程连接 / 某个任务卡片，而不只是"打开面板"
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
  /* 固定颜色：锁住之后，空闲自动玩耍 / 漫步到站都不再随机换色，
     只有手动点「换个颜色」才会变（每个伙伴各记一份） */
  function colorLocked() {
    try { return localStorage.getItem('ide.deskie.colorlock.' + curId) === '1'; } catch (e) { return false; }
  }
  function setColorLock(on) {
    try { localStorage.setItem('ide.deskie.colorlock.' + curId, on ? '1' : '0'); } catch (e) {}
  }
  /* 换一个和当前不同的颜色；force = 用户主动点的，锁定时也算数 */
  function nextHue(force) {
    if (!force && colorLocked()) return;
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
      // 漫步途中不另外插动作：走路本身已经在动，再叠一套会显得抽风
      if (MOOD[curId] && !el.classList.contains('hide') && !document.hidden && !wanderMoving) {
        doAct(null, Math.random() > 0.78 || chatOpen());   // 对话面板开着时只动嘴不动手，别抢话
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
    el.innerHTML = '<div class="dk-stage"><div class="dk-shadow"></div>' + p.html + '</div>' +
                   '<div class="dk-chatbtn" title="和我聊聊天（AI 对话）"><i class="bi bi-chat-dots-fill"></i></div>';
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
      '<div class="dk-mi" data-act="chat"><i class="bi bi-chat-heart"></i>和我聊聊天<i class="bi bi-stars dk-new"></i></div>' +
      '<div class="dk-mi" data-act="say"><i class="bi bi-chat-dots"></i>说点什么</div>' +
      '<div class="dk-mi" data-act="act"><i class="bi bi-magic"></i>随便动一下</div>' +
      '<div class="dk-mi" data-act="hop"><i class="bi bi-arrow-up-square"></i>跳一下</div>' +
      '<div class="dk-mi" data-act="wander"><i class="bi ' + (wanderOn() ? 'bi-toggle-on' : 'bi-toggle-off') + '"></i>自动漫步' +
        (wanderOn() ? '<span class="dk-tick">✔</span>' : '') + '</div>' +
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
             '<div class="dk-chip" data-hue="1" title="手动换一个颜色"><i class="bi bi-palette"></i> 换个颜色</div>' +
             '<div class="dk-chip' + (colorLocked() ? ' on' : '') + '" data-lock="1"' +
               ' title="' + (colorLocked() ? '已固定：不再自动变色' : '固定当前颜色，不再自动变色') + '">' +
               '<i class="bi ' + (colorLocked() ? 'bi-lock-fill' : 'bi-unlock') + '"></i> 固定颜色</div>' +
           '</div>';
    }
    // 「换个伙伴」收进二级菜单：hover 或点击展开，避免主菜单拉得太长
    var subs = '';
    for (var i = 0; i < ORDER.length; i++) {
      var id = ORDER[i], p = PETS[id];
      subs += '<div class="dk-mi' + (id === curId ? ' on' : '') + '" data-pet="' + id + '">' +
                '<i class="bi ' + p.icon + '"></i>' + p.name +
                (id === curId ? '<span class="dk-tick">✔</span>' : '') +
              '</div>';
    }
    h += '<div class="dk-sep"></div>' +
         '<div class="dk-mi has-sub" data-act="pets"><i class="bi bi-people"></i>换个伙伴' +
           '<i class="bi bi-chevron-right dk-caret"></i>' +
           '<div class="dk-sub">' + subs + '</div>' +
         '</div>' +
         '<div class="dk-mi" data-act="hide"><i class="bi bi-moon-stars"></i>隐身</div>';
    menu.innerHTML = h;
  }

  function use(id) {
    if (!PETS[id] || id === curId) return;
    if (chatOpen() && chatAbort) { try { chatAbort.abort(); } catch (e) {} }   // 换人前先停掉上一场对话
    curId = id;
    try { localStorage.setItem(LS_PET, id); } catch (e) {}
    renderPet();
    renderMenu();
    if (chatOpen()) { chatPosition(); chatRender(); }   // 对话面板跟着换成新伙伴的记忆
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
  /* 气泡位置：右 → 左 → 上 → 下。
     以前只有「上 / 下」两种，顶部放不下就掉到脚下，正好压住文件树、Git 提交框，
     所以优先摆到左右两侧；实在没地方才放下方。方位同时写进 class，尖角好跟着换方向。 */
  function moveBubble() {
    var r = el.getBoundingClientRect();
    var bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    var pad = 8, gap = 12;
    var vw = window.innerWidth, vh = window.innerHeight;

    var cx = r.left + r.width / 2 - bw / 2;
    var cy = r.top + r.height / 2 - bh / 2;
    var cands = [
      { pos: 'right',  x: r.right + gap,     y: cy },               // 右
      { pos: 'left',   x: r.left - bw - gap, y: cy },               // 左
      { pos: 'top',    x: cx,                y: r.top - bh - gap }, // 上
      { pos: 'bottom', x: cx,                y: r.bottom + gap }    // 下（兜底）
    ];
    var fit = function (x, y) {
      return x >= pad && y >= pad && x + bw <= vw - pad && y + bh <= vh - pad;
    };
    var pick = cands[2];
    for (var i = 0; i < cands.length; i++) {
      if (fit(cands[i].x, cands[i].y)) { pick = cands[i]; break; }
    }
    var x = Math.max(pad, Math.min(pick.x, vw - bw - pad));
    var y = Math.max(pad, Math.min(pick.y, vh - bh - pad));

    bubble.classList.remove('ar-top', 'ar-bottom', 'ar-left', 'ar-right');
    bubble.classList.add('ar-' + pick.pos);
    // 尖角对准桌面伙伴中心，并夹在气泡范围内（免得跑到圆角外面）
    if (pick.pos === 'left' || pick.pos === 'right') {
      var ay = r.top + r.height / 2 - y - 5;
      bubble.style.setProperty('--ar-y', Math.max(9, Math.min(ay, bh - 19)).toFixed(0) + 'px');
    } else {
      var ax = r.left + r.width / 2 - x - 5;
      bubble.style.setProperty('--ar-x', Math.max(9, Math.min(ax, bw - 19)).toFixed(0) + 'px');
    }
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
    if (chatOpen()) syncChatToPet();          // 拖桌宠时对话框跟着一起走
  }
  function savePos() {
    try { localStorage.setItem(LS_POS, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); } catch (e) {}
  }
  function goHome() {
    stopWander();                               // 回家的路上不再自己乱走
    wanderPauseUntil = Date.now() + 8000;
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
  el.addEventListener('click', function (ev) {    // 头顶的对话小按钮
    if (ev.target.closest && ev.target.closest('.dk-chatbtn')) {
      ev.stopPropagation();
      showChat();
    }
  }, true);
  el.addEventListener('pointerdown', function (ev) {
    if (ev.target.closest && ev.target.closest('.dk-chatbtn')) return;   // 点对话按钮不触发拖动
    if (ev.button !== 0) return;                 // 右键交给 contextmenu
    // 漫步半路被抓住：按「当前视觉位置」定住，避免撤掉过渡时被拽一下
    freezeWander();
    wanderPauseUntil = Date.now() + 12000;       // 摸过它之后先安分一会儿
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
      if (MOOD[curId]) { paintFace('happy'); nextHue(true); }   // 用户主动逗它，固定颜色也照样换
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

  // ---------- 自动漫步：一小跳一小跳地挪，到了就跳一下 / 转个圈 ----------
  // 一次出行拆成若干小跳：每跳挪 50~70px，配一次「蓄力-腾空-落地」姿态，跳完喘口气再跳下一段。
  // 平均速度 ≈ 70px/s（比原先的匀速滑行慢四成），看起来才像走走停停，而不是一路滑过去。
  // 用户一碰它 / 打开对话面板 / 隐身 / 切到别的标签页，都会自动停下或不再出发。
  var wanderTimer = null, wanderChain = null, wanderQueue = [], wanderMoving = false, wanderPauseUntil = 0;
  var HOP_MS = 680;        // 单次跳跃用时（含腾空）
  var HOP_GAP = 170;       // 落地后喘口气再跳

  function wanderOn() {
    try { return localStorage.getItem('ide.deskie.wander') !== '0'; } catch (e) { return true; }   // 默认开启
  }
  function wanderSet(on) {
    try { localStorage.setItem('ide.deskie.wander', on ? '1' : '0'); } catch (e) {}
  }
  function wanderCan() {
    return wanderOn() && !wanderMoving && !drag
        && !el.classList.contains('hide') && !document.hidden
        && !chatOpen() && !menu.classList.contains('open')
        && Date.now() > wanderPauseUntil;
  }
  /* 立刻停住（召唤回原位 / 打开对话 / 隐身时用） */
  function stopWander() {
    clearTimeout(wanderChain);
    wanderChain = null;
    wanderQueue = [];
    wanderMoving = false;
    el.classList.remove('wander', 'stepping');
  }
  /* 停在「眼前这个位置」：过渡还在走时 left/top 已经是目标值，
     直接撤掉过渡会瞬间跳过去 —— 所以先把当前视觉坐标写回去，再撤。 */
  function freezeWander() {
    if (!wanderMoving) { stopWander(); return; }
    var r0 = el.getBoundingClientRect();
    stopWander();
    el.style.left = Math.round(r0.left) + 'px';
    el.style.top = Math.round(r0.top) + 'px';
  }
  function wanderLoop() {
    clearTimeout(wanderTimer);
    wanderTimer = setTimeout(wanderStep, 4200 + Math.random() * 7000);
  }
  /* 蹦下一小步；队列空了就算到站 */
  function wanderHopNext() {
    if (!wanderQueue.length) {
      el.classList.remove('wander', 'stepping');
      wanderMoving = false;
      // 到站了就耍一下：跳 / 转圈 / 换表情（quiet，不吭声，免得一路叨叨）
      var r = Math.random();
      if (r < 0.26) hop();
      else if (r < 0.7) doAct(null, true);
      wanderLoop();
      return;
    }
    var p = wanderQueue.shift();
    el.style.setProperty('--wd', (HOP_MS / 1000).toFixed(2) + 's');
    el.classList.add('wander');
    el.classList.remove('stepping');
    void el.offsetWidth;                       // 强制回流，让跳跃动画从头播
    el.classList.add('stepping');
    setPos(p.x, p.y);
    wanderChain = setTimeout(wanderHopNext, HOP_MS + HOP_GAP);
  }
  function wanderStep() {
    if (!wanderCan()) { wanderLoop(); return; }
    var w = el.offsetWidth || W, h = el.offsetHeight || H;
    var maxX = window.innerWidth - w - 8, maxY = window.innerHeight - h - 8;
    if (maxX < 40 || maxY < 40) { wanderLoop(); return; }   // 窗口太小就别乱跑了

    var cx = el.offsetLeft, cy = el.offsetTop;
    var tx = cx, ty = cy, tries = 0;
    // 目标点至少挪 90px，免得在原地小碎步打转
    while (Math.hypot(tx - cx, ty - cy) < 90 && tries++ < 8) {
      tx = 8 + Math.random() * (maxX - 8);
      ty = 8 + Math.random() * (maxY - 8);
    }
    var dx = tx - cx, dy = ty - cy;
    var dist = Math.hypot(dx, dy);
    if (dist < 40) { wanderLoop(); return; }

    // 拆成若干小跳：每跳 46~68px，最后一跳把余量补足
    var steps = Math.max(2, Math.round(dist / (46 + Math.random() * 22)));
    wanderQueue = [];
    for (var i = 1; i <= steps; i++) {
      wanderQueue.push({ x: cx + dx * i / steps, y: cy + dy * i / steps });
    }
    wanderMoving = true;
    clearTimeout(wanderChain);
    wanderHopNext();
  }
  wanderPauseUntil = Date.now() + 2600;      // 刚进页面先让人看清楚它在哪，别马上乱跑
  wanderLoop();

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
    menu.classList.remove('sub-up');
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var mx = Math.max(4, Math.min(x, window.innerWidth - mw - 4));
    menu.style.left = mx + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + 'px';
    // 右边放不下二级菜单时，让它从左侧展开
    menu.classList.toggle('sub-left', mx + mw + 176 > window.innerWidth);
    // 下方放不下整份伙伴列表时，二级菜单改为向上展开（否则会被视口底部切掉）
    var subMi = menu.querySelector('.dk-mi.has-sub');
    if (subMi) {
      var sub = subMi.querySelector('.dk-sub');
      var need = 0;
      if (sub) {                              // 绝对定位 + 隐藏测量，不会闪也不会撑开主菜单
        sub.style.visibility = 'hidden';
        sub.style.display = 'block';
        need = sub.offsetHeight;
        sub.style.display = '';
        sub.style.visibility = '';
      }
      if (need) {
        var r = subMi.getBoundingClientRect();
        if (r.top + need > window.innerHeight - 6) menu.classList.add('sub-up');
      }
    }
  }
  function closeMenu() {
    menu.classList.remove('open');
    var op = menu.querySelector('.dk-mi.open');
    if (op) op.classList.remove('open');
  }
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
      else if (chip.dataset.hue) nextHue(true);
      else if (chip.dataset.lock) {
        var lk = !colorLocked();
        setColorLock(lk);
        renderMenu();                            // 重绘，锁图标 / 高亮立刻变
        say(lk ? '颜色固定住啦，不再乱变 ~' : '好，我又开始自己换颜色了。', 2600);
      }
      return;
    }
    var mi = ev.target.closest('.dk-mi');
    if (!mi) return;
    if (mi.dataset.act === 'pets') {               // 二级菜单：点一下展开 / 收起（触屏没有 hover）
      mi.classList.toggle('open');
      return;
    }
    closeMenu();
    if (mi.dataset.pet) { use(mi.dataset.pet); return; }
    var act = mi.dataset.act;
    if (act === 'chat') showChat();
    else if (act === 'say') {
      if (MOOD[curId]) doAct(null); else say(pick(curPet().lines));
    } else if (act === 'act') {
      if (MOOD[curId]) doAct(); else hop();
    } else if (act === 'hop') hop();
    else if (act === 'wander') {
      var won = !wanderOn();
      wanderSet(won);
      if (won) { wanderPauseUntil = Date.now() + 1200; wanderLoop(); }
      else stopWander();
      say(won ? '好呀，我去溜达一圈 ~' : '那我就在这儿待着。', 2400);
    }
    else if (act === 'home') { goHome(); say('回我的小窝啦 ~', 2200); }
    else if (act === 'hide') hide();
  });
  document.addEventListener('pointerdown', function (ev) {
    if (menu.classList.contains('open') && !menu.contains(ev.target) && !el.contains(ev.target)) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', function () {
    setPos(el.offsetLeft, el.offsetTop);
    if (chatOpen()) chatPosition();
  });

  // ---------- 隐身 / 召唤 ----------
  function show() {
    el.classList.remove('hide');
    summon.classList.remove('show');
    wanderPauseUntil = Date.now() + 4000;       // 刚召唤回来先站一会儿再溜达
    try { localStorage.setItem(LS_HIDDEN, '0'); } catch (e) {}
    say('我回来啦！', 2200);
  }
  function hide() {
    stopWander();                               // 隐身了就别在半路上飘
    el.classList.add('hide');
    bubble.classList.remove('show');
    closeMenu();
    summon.classList.add('show');
    try { localStorage.setItem(LS_HIDDEN, '1'); } catch (e) {}
  }
  summon.addEventListener('click', show);
  try { if (localStorage.getItem(LS_HIDDEN) === '1') { el.classList.add('hide'); summon.classList.add('show'); } } catch (e) {}

  // ---------- 桌宠 AI 对话（带记忆 + 可选联网） ----------
  // 记忆：每个伙伴一份，存在 localStorage（key = ide.deskie.chat.<id>），最多 80 条；
  //       每次请求带上最近 12 轮，模型因此能接上下文，刷新页面也不会忘。
  // 联网：面板右上角「联网」开关，打开后请求带 web_search=true，服务端会先搜索再把结果注入系统消息。
  var CHAT_TURNS = 12, CHAT_KEEP = 80;
  var LS_CHAT = 'ide.deskie.chat.', LS_WEB = 'ide.deskie.web', LS_PROJ = 'ide.deskie.proj', LS_AGENT = 'ide.deskie.agent';
  /* 上下文压缩：条数超过 TRIGGER 就把早期对话压成一段摘要（存 LS_SUM），
     只保留最近 KEEP 条原文 —— 长对话不会越聊越贵，也不会顶到上下文上限。 */
  var LS_SUM = 'ide.deskie.summary.';
  var CHAT_SUM_TRIGGER = 30, CHAT_SUM_KEEP = 16;
  var chatCompacting = false;

  var PERSONA = {
    buddy: '你是「小 Buddy」，住在在线 IDE 右下角的机器人桌面伙伴，性格开朗、有点俏皮，说话简短温暖。',
    deskie: '你是「桌小萌」，一个圆头机器小助手，活泼爱吐槽但很贴心，自称"我"。',
    whale: '你是「鲸鱼娘」，住在海里的鲸鱼少女，语气软萌，偶尔说"咕噜"，喜欢用海洋做比喻。',
    nailong: '你是「奶龙」，一只圆滚滚的黄橙色小恐龙，单纯贪吃、说话幼稚可爱，会提到吃饭和睡觉。',
    dudu: '你是「肥嘟嘟」，一坨软软的粉色糯米团子，说话慢悠悠、暖乎乎的，喜欢鼓励人。'
  };
  var CHAT_RULE = '你现在在桌宠对话框里和用户聊天：回答口语化、简短（一般 2~3 句），不要输出 Markdown 表格或大段代码；' +
                  '需要实时 / 事实性信息（天气、新闻、股价、赛事、最近发生的事、你没把握的数据）时，' +
                  '可以直接调用 web_search 工具查询后再回答；普通聊天、解释概念、写代码不必联网；' +
                  '上下文里出现「[联网搜索结果]」说明结果已查好，直接据此回答并注明「据网络检索」，不要说“我无法联网”；' +
                  '用户问技术问题时给要点式建议，不确定就直说。';
  var PROJ_RULE = '你现在可以读取用户当前项目里的文件（列出目录 / 搜索文件 / 读取文件内容，只读不改）。' +
                  '回答与这个项目有关的问题（某个功能在哪、某个文件写了什么、怎么实现的）之前，先用工具查证再回答，' +
                  '不要凭空猜测代码；回答时直接给结论，不要复述你调用了哪些工具。';

  /* Agent 模式：模型在正文里输出 <ide>{"act":…,"arg":…}</ide>，前端立即执行并从文本里剥掉。
     这样桌宠就能"替用户点" IDE 的按钮 —— 打开面板、打开文件、运行、切换终端等。 */
  var AGENT_RULE = '【界面操作能力】你可以在回复里插入 <ide>{"act":"动作","arg":"参数"}</ide>，' +
    '前端会立即执行并把这段标签从显示文本中删掉，不要向用户解释这个标签。可用动作：\n' +
    '- panel：arg=explorer|search|git|run|runner|env|dbconn|api|cron|sshconn|fm|ext（打开对应侧栏面板）\n' +
    '- file：arg=项目内相对路径（如 app/config.py），在左侧文件树里打开它\n' +
    '- tab：arg=标签名关键字（切换到已打开的标签）；closetab：arg=标签名关键字，留空=当前标签\n' +
    '- save：保存当前文件；run：运行当前文件；stop：终止正在运行的程序\n' +
    '- terminal：打开底部终端；output：打开底部输出面板\n' +
    '- sidebar：arg=1 显示 / 0 隐藏左侧边栏；bottom：arg=1 显示 / 0 隐藏底部面板\n' +
    '- zen：切换专注模式；settings：打开设置；ai：打开右侧 AI 助手\n' +
    '- search：arg=关键字，在项目中搜索；refresh：刷新资源管理器\n' +
    '- click：arg=序号（如 "2"）或文字（如 "11月18日过期" / "保存"），点击左侧面板条目或弹窗按钮\n' +
    '- fill：arg=字段名（照「[当前弹窗]」清单），value=要填的值；select 的 value 写选项文字\n' +
    '系统消息会附带「[当前界面]」（侧栏条目 + 序号）和「[当前弹窗]」（字段名 + 当前值 + 按钮清单）。' +
    '用户说「第一个 / 那个 xx」时照清单用 click / fill，不要反问；' +
    '若同一条回复里先切了面板再点条目，click 请用文字（切面板后序号会重新编号）。\n' +
    '规则：一次最多 8 个动作、按顺序写；填表单时先 fill 各字段、最后 click 保存；' +
    '本轮动作刚打开一个新表单时，不要猜字段名，等下一轮看到「[当前弹窗]」清单再填；' +
    '「[当前界面]」清单里同时包含面板条目和面板上的按钮（如「新建任务」「刷新」），都在同一份序号里。\n' +
    '常见面板的入口按钮：定时任务=「新建任务」、数据库连接=「新建连接」、API=「新建请求」、' +
    'SSH=「新建连接」、后台任务=「新建任务」；切完面板可以直接跟上 click 这些按钮名。\n' +
    '只在用户确实要操作界面时用；没有对应动作就不要编造。' +
    '用户让你操作界面时，必须真的用 <ide> 动作去做，不要只用文字说「我无法操作 / 你自己点一下」。\n' +
    '例：用户说「打开 Git 面板」，你回答：好嘞，打开啦～<ide>{"act":"panel","arg":"git"}</ide>\n' +
    '例：用户说「打开 config 然后跑一下」，你回答：走着～<ide>{"act":"file","arg":"app/config.py"}</ide>' +
    '<ide>{"act":"run"}</ide>\n' +
    '例：用户说「建一个每天早上 9 点的定时任务」，你回答：好嘞～<ide>{"act":"panel","arg":"cron"}</ide>' +
    '<ide>{"act":"click","arg":"新建任务"}</ide>\n' +
    '注意：新建 / 创建类请求里，只打开面板不算完成，必须紧接着点该面板的「新建」按钮；' +
    '表单弹出后前端会自动再给你一轮，那时候再 fill 各字段 + click 保存。';

  var chatEl = null, chatListEl = null, chatInEl = null, chatBtnEl = null, chatWebEl = null;
  var chatTipEl = null, chatMaxEl = null, chatProjEl = null, chatAgentEl = null, chatAnchor = null;
  var histEl = null;                       // 历史对话下拉列表
  var chatAbort = null, chatBusy = false;
  /* 本轮 Agent 已经执行过的动作 + 用户原话：用来判断「是不是只做了一半」 */
  var ideActLog = [], chatLastUserText = '';
  var chatMaxed = false, chatPrevPos = null, chatSyncing = false;

  /* ---------- 多会话：每个伙伴可以有多段彼此独立的对话 ----------
     存储：ide.deskie.sess.<petId> = { cur: 当前会话 id, list: [ { id, title, ts, msgs, sum } ] }
     旧版本把消息直接放在 ide.deskie.chat.<petId>（一个数组），首次读取时自动迁移成第一段会话，
     所以老用户升级后原来的聊天记录不会丢。摘要（LS_SUM）也搬进会话对象，切会话时一起跟着走。 */
  var SESS_MAX = 15;
  var LS_SESS = 'ide.deskie.sess.';

  function sessNewId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  /* 会话标题：取第一条用户消息（截 16 字），没消息就是「新对话」 */
  function sessTitle(msgs) {
    var l = msgs || [];
    for (var i = 0; i < l.length; i++) {
      if (l[i].role === 'user' && l[i].content) {
        var t = String(l[i].content).replace(/\s+/g, ' ').trim();
        return t.length > 16 ? t.slice(0, 16) + '…' : t;
      }
    }
    return '新对话';
  }
  function sessSaveFor(petId, o) {
    try { localStorage.setItem(LS_SESS + petId, JSON.stringify(o)); } catch (e) {}
  }
  function sessLoadFor(petId) {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(LS_SESS + petId) || 'null'); } catch (e) {}
    if (!o || !Array.isArray(o.list) || !o.list.length) {
      // 迁移旧格式
      var old = [], legacySum = null;
      try { old = JSON.parse(localStorage.getItem(LS_CHAT + petId) || '[]') || []; } catch (e2) {}
      try { legacySum = JSON.parse(localStorage.getItem(LS_SUM + petId) || 'null'); } catch (e3) {}
      var id = sessNewId();
      o = { cur: id, list: [{ id: id, title: sessTitle(old), ts: Date.now(), msgs: old, sum: legacySum }] };
      sessSaveFor(petId, o);
    }
    var hit = false;
    for (var i = 0; i < o.list.length; i++) if (o.list[i].id === o.cur) { hit = true; break; }
    if (!hit) o.cur = o.list[0].id;
    return o;
  }
  /* 当前会话对象 + 所属整包（写回用） */
  function sessCur(petId) {
    var o = sessLoadFor(petId);
    for (var i = 0; i < o.list.length; i++) if (o.list[i].id === o.cur) return { s: o.list[i], o: o };
    return { s: o.list[0], o: o };
  }

  /* 记忆按「伙伴 id + 当前会话」存取：切伙伴 / 切会话时，正在生成的那一轮仍写回它自己那段 */
  function chatLoadFor(petId) { return sessCur(petId).s.msgs || []; }
  function chatStoreFor(petId, list) {
    var r = sessCur(petId), s = r.s;
    s.msgs = (list || []).slice(-CHAT_KEEP);
    s.ts = Date.now();
    s.title = sessTitle(s.msgs);           // 标题随第一条用户消息自动生成
    sessSaveFor(petId, r.o);
  }
  function chatLoad() { return chatLoadFor(curId); }
  function chatStore(list) { chatStoreFor(curId, list); }

  /* 早前对话的压缩摘要：现在跟着会话走，换会话不会再串味 */
  function chatSumLoadFor(petId) { return sessCur(petId).s.sum || null; }
  function chatSumSaveFor(petId, obj) {
    var r = sessCur(petId);
    r.s.sum = (obj && obj.text) ? obj : null;
    sessSaveFor(petId, r.o);
  }

  /* 读一个 SSE 响应，把 delta 拼成纯文本（给摘要压缩用） */
  function readSseText(res) {
    return new Promise(function (resolve) {
      if (!res || !res.body) { resolve(''); return; }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '', text = '';
      (function pump() {
        reader.read().then(function (rd) {
          if (rd.done) { resolve(text); return; }
          buf += dec.decode(rd.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            var chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            var lines = chunk.split('\n');
            for (var k = 0; k < lines.length; k++) {
              var ln = lines[k];
              if (ln.indexOf('data:') !== 0) continue;
              var payload = ln.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              var obj;
              try { obj = JSON.parse(payload); } catch (e) { continue; }
              if (obj.delta) text += obj.delta;
            }
          }
          pump();
        }).catch(function () { resolve(text); });
      })();
    });
  }

  /* 上下文压缩：条数超过阈值时，把早期对话交给模型压成一段摘要，
     然后只保留最近 CHAT_SUM_KEEP 条原文。摘要会随 system 消息一起发送。 */
  function chatCompact(petId) {
    if (chatCompacting) return;
    var list = chatLoadFor(petId);
    if (list.length <= CHAT_SUM_TRIGGER) return;
    var cut = list.length - CHAT_SUM_KEEP;
    if (cut < 6) return;

    var old = chatSumLoadFor(petId);
    var body = list.slice(0, cut).map(function (m) {
      var t = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      return (m.role === 'user' ? '用户：' : '我：') + t;
    }).join('\n');
    var ask = (old && old.text ? '【已有摘要】\n' + old.text + '\n\n' : '') +
              '【新增对话】\n' + body +
              '\n\n把以上内容合并压缩成一段不超过 200 字的中文摘要，保留：用户的目标与偏好、已经确认的结论、' +
              '待办与未解决的问题、重要上下文（路径、名字、数字）。只输出摘要正文，不要任何解释。';

    chatCompacting = true;
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: '你是对话摘要助手，只做信息压缩，不回答问题、不闲聊。' },
          { role: 'user', content: ask }
        ],
        use_tools: false,
        perm: 'readonly'
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return readSseText(res);
    }).then(function (text) {
      text = String(text || '').trim();
      if (!text) return;
      var cur = chatLoadFor(petId);              // 重新读一次，避免覆盖压缩期间新产生的消息
      chatStoreFor(petId, cur.slice(-CHAT_SUM_KEEP));
      chatSumSaveFor(petId, { text: text.slice(0, 1500), at: Date.now() });
      if (curId === petId) {
        chatRender();
        if (chatOpen()) chatTip('已把早前对话压缩成摘要（悬停列表顶部可查看）');
      }
    }).catch(function () {
      /* 压缩失败就保持原样，下次对话结束再试 */
    }).then(function () { chatCompacting = false; });
  }
  function chatWebOn() { try { return localStorage.getItem(LS_WEB) === '1'; } catch (e) { return false; } }
  function chatSetWeb(on) { try { localStorage.setItem(LS_WEB, on ? '1' : '0'); } catch (e) {} }
  function chatOpen() { return !!(chatEl && chatEl.classList.contains('show')); }

  /* 「智能体」模式：允许模型读当前项目文件（list_dir / read_file / search_files / code_intel）。
     项目根目录的取法与 IDE 前端一致：?path 优先，其次 localStorage 里上次打开的路径。 */
  function chatProjOn() { try { return localStorage.getItem(LS_PROJ) === '1'; } catch (e) { return false; } }
  function chatSetProj(on) { try { localStorage.setItem(LS_PROJ, on ? '1' : '0'); } catch (e) {} }
  function ideRoot() {
    var p = '';
    try { p = new URLSearchParams(location.search).get('path') || ''; } catch (e) {}
    if (!p) { try { p = localStorage.getItem('ide_last_path') || ''; } catch (e) {} }
    if (!p) {                                   // 兜底：地址栏的 ?id 是路径混淆后的 token
      try {
        var id = new URLSearchParams(location.search).get('id') || '';
        if (id) {
          var bytes = Uint8Array.from(atob(id), function (c) { return c.charCodeAt(0); });
          var s = '';
          for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ^ 0x5f);
          p = s;
        }
      } catch (e2) {}
    }
    p = String(p || '').replace(/\/+$/, '');
    return p.charAt(0) === '/' ? p : '';        // 只认绝对路径
  }
  var TOOL_LABEL = {
    list_dir: '查看目录', read_file: '读取文件', search_files: '搜索文件',
    code_intel: '分析代码', web_search: '联网搜索', todo_write: '更新任务清单',
    generate_image: '生成图片'
  };

  /* ---------- Agent：直接操作 IDE 界面 ----------
     模型输出 <ide>{"act":"panel","arg":"git"}</ide>，这里落地成真实的点击/切换。 */
  function chatAgentOn() { try { return localStorage.getItem(LS_AGENT) === '1'; } catch (e) { return false; } }
  function chatSetAgent(on) { try { localStorage.setItem(LS_AGENT, on ? '1' : '0'); } catch (e) {} }

  var IDE_PANELS = {
    explorer: '资源管理器', search: '搜索', git: '源代码管理', run: '运行和调试', runner: '后台任务',
    env: '运行环境', dbconn: '数据库', api: 'API 调试', cron: '定时任务', sshconn: '终端连接',
    fm: '文件夹管理器', ext: '扩展'
  };
  function ideQ(sel) { return document.querySelector(sel); }
  function ideClick(el) { if (!el) return false; try { el.click(); } catch (e) { return false; } return true; }
  function ideVisible(el) { return !!(el && el.offsetWidth > 0 && el.offsetHeight > 0); }

  /* 当前可见侧栏面板里的可点条目：抓最内层的 item / card / task / 文件树行，
     每次发消息时快照一次，随 system 一起给模型看，点击时按序号或文字定位。 */
  var ideSnapItems = [];
  var ideFormFields = [], ideFormButtons = [];

  /* 当前最上层的弹窗（浮层）：类名或 id 里带 overlay / modal / mask 的可见元素里挑一个 */
  function ideOverlayNow() {
    var sel = '[class*="overlay"], [class*="modal"], [class*="-ov"], [class*="mask"], [id*="Modal"], [id*="Overlay"]';
    var list = document.querySelectorAll(sel);
    var best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el.offsetWidth || !el.offsetHeight) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var z = parseInt(cs.zIndex, 10);
      if (isNaN(z)) z = 0;
      // 带输入框的优先，其次 z-index 高的
      var score = (el.querySelector('input, textarea, select') ? 1000 : 0) + z;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  /* 字段名：label > 前一个兄弟 > 父级里的 label 元素 > placeholder > name/id */
  function ideFieldLabel(el) {
    var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
    var box = el.closest && el.closest('label');
    if (box) {
      var t = clean(box.textContent);
      if (t && t.length <= 40) return t;
    }
    var pv = el.previousElementSibling;
    if (pv) {
      var t2 = clean(pv.textContent);
      if (t2 && t2.length <= 40) return t2;
    }
    var p = el.parentElement;
    for (var i = 0; i < 3 && p; i++, p = p.parentElement) {
      var lb = p.querySelector('label, [class*="label"], [class*="lbl"]');
      if (lb && !lb.contains(el)) {
        var t3 = clean(lb.textContent);
        if (t3 && t3.length <= 40) return t3;
      }
    }
    return el.placeholder || el.name || el.id || '';
  }

  function ideSnapshot() {
    ideSnapItems = [];
    ideFormFields = [];
    ideFormButtons = [];

    var wrap = document.getElementById('sidebar');
    var title = '';
    if (wrap) {
      var panels = wrap.querySelectorAll('.side-panel');
      var panel = null;
      for (var i = 0; i < panels.length; i++) {
        if (panels[i].offsetHeight > 0) { panel = panels[i]; break; }
      }
      if (panel) {
        var tEl = document.getElementById('sideTitle');
        title = tEl ? String(tEl.textContent || '').trim() : '';
        var ITEM_SEL = '[class*="item"], [class*="card"], [class*="task"], .tree-row';
        var seenTxt = {};
        var pushItem = function (el, maxLen) {
          if (!el || !el.offsetHeight || ideSnapItems.length >= 32) return;
          var txt = String(el.innerText || el.textContent || el.title || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > (maxLen || 120)) return;
          if (seenTxt[txt]) return;                          // 同名条目 / 重复按钮只留一个
          seenTxt[txt] = 1;
          ideSnapItems.push({ el: el, text: txt });
        };
        // ① 面板里的条目（任务卡片 / 连接 / 文件行…）
        var cands = panel.querySelectorAll(ITEM_SEL);
        for (var k = 0; k < cands.length && ideSnapItems.length < 22; k++) {
          var el = cands[k];
          if (!el.offsetHeight) continue;
          if (el.querySelector(ITEM_SEL)) continue;          // 只取最内层，避免父子重复
          pushItem(el, 120);
        }
        // ② 面板工具栏的按钮（新建任务 / 刷新 / 打开管理面板…）——
        //    之前漏了这类 <button class="g-btn">，模型看不到「新建任务」就没法点
        var btns = panel.querySelectorAll('button, [class*="btn"], [class*="g-ico"]');
        for (var b = 0; b < btns.length; b++) {
          var bt = btns[b];
          if (!bt.offsetHeight) continue;
          if (bt.querySelector('button')) continue;
          pushItem(bt, 24);
        }
      }
    }

    // 弹窗：字段 + 按钮（新建定时任务、SSH 连接编辑这类表单）
    var ov = ideOverlayNow();
    var form = null;
    if (ov) {
      var ins = ov.querySelectorAll('input, textarea, select');
      for (var m = 0; m < ins.length && ideFormFields.length < 20; m++) {
        var f = ins[m];
        if (!f.offsetHeight) continue;
        var tp = String(f.type || f.tagName).toLowerCase();
        if (tp === 'hidden' || tp === 'file') continue;
        ideFormFields.push({
          el: f, label: ideFieldLabel(f), type: tp,
          value: String(f.value == null ? '' : f.value), ph: f.placeholder || ''
        });
      }
      var seenBtn = {};
      var pushBtn = function (el) {
        if (!el || !el.offsetHeight || ideFormButtons.length >= 18) return;
        if (el.querySelector('button')) return;                    // 取最内层按钮
        var t = String(el.innerText || el.textContent || el.title || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24) return;
        if (seenBtn[t]) return;
        seenBtn[t] = 1;
        ideFormButtons.push({ el: el, text: t });
      };
      // 底部操作区优先：预设按钮很多，先把「保存 / 取消」捞进来，避免被上限挤掉
      var footBtns = ov.querySelectorAll('.cd-foot button, [class*="foot"] button, [class*="action"] button');
      for (var fi = 0; fi < footBtns.length; fi++) pushBtn(footBtns[fi]);
      var allBtns = ov.querySelectorAll('button, [role="button"], [class*="btn"]');
      for (var bi = 0; bi < allBtns.length; bi++) pushBtn(allBtns[bi]);
      var tt = ov.querySelector('.cd-head span, .m-title, [class*="head"] span, [class*="title"]');
      form = { title: tt ? String(tt.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '表单',
               fields: ideFormFields, buttons: ideFormButtons };
    }

    return { name: title, items: ideSnapItems, form: form };
  }

  function ideSnapText(snap) {
    var lines = [];
    if (snap && snap.items.length) {
      lines.push('[当前界面] 左侧面板：' + (snap.name || '未知') +
                 '（下面是当前可点的条目，click 动作用这里的序号或文字）');
      for (var i = 0; i < snap.items.length; i++) lines.push((i + 1) + ') ' + snap.items[i].text);
    }
    var fm = snap && snap.form;
    if (fm && (fm.fields.length || fm.buttons.length)) {
      lines.push('[当前弹窗] ' + (fm.title || '表单'));
      if (fm.fields.length) {
        lines.push('字段（fill 动作：arg=字段名，value=要填的值）：');
        for (var k = 0; k < fm.fields.length; k++) {
          var f = fm.fields[k];
          lines.push('- ' + (f.label || '(未命名)') + ' [' + f.type + '] 当前="' +
                     f.value.slice(0, 60) + '"' + (f.ph ? ' 提示:' + f.ph : ''));
        }
      }
      if (fm.buttons.length) {
        lines.push('按钮（click 动作：arg=按钮文字）：' +
                   fm.buttons.map(function (b) { return b.text; }).join(' / '));
      }
    }
    return lines.join('\n');
  }

  /* 往表单控件写值：input / textarea / select / checkbox 都兼顾，并派发 input+change 事件 */
  function ideSetValue(el, val) {
    if (!el) return;
    var tag = String(el.tagName || '').toUpperCase();
    var tp = String(el.type || '').toLowerCase();
    if (tag === 'SELECT') {
      var hit = false, i;
      for (i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (String(o.value) === val || String(o.textContent || '').trim() === val) { el.selectedIndex = i; hit = true; break; }
      }
      if (!hit) {
        for (i = 0; i < el.options.length; i++) {
          if (String(el.options[i].textContent || '').indexOf(val) >= 0) { el.selectedIndex = i; break; }
        }
      }
    } else if (tp === 'checkbox' || tp === 'radio') {
      el.checked = !(val === '' || val === '0' || val === 'false' || val === '否');
    } else {
      el.value = val;
    }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e2) {}
  }

  function ideDo(spec) {
    var act = String((spec && spec.act) || '').toLowerCase();
    var arg = spec && spec.arg != null ? String(spec.arg) : '';
    var rows, hit, i;

    if (act === 'panel') {
      if (!IDE_PANELS[arg]) return { ok: false, msg: '没有这个面板：' + arg };
      if (!ideClick(ideQ('.activitybar .act[data-panel="' + arg + '"]'))) return { ok: false, msg: '找不到面板按钮' };
      ideSnapshot();                                   // 面板换了，后面的 click 要按新清单来
      return { ok: true, msg: '已打开「' + IDE_PANELS[arg] + '」面板' };
    }

    if (act === 'file') {                              // 在文件树里找到并打开
      var want = arg.replace(/^\.?\//, '');
      if (!want) return { ok: false, msg: '缺少文件路径' };
      var findRow = function () {
        var list = [].slice.call(document.querySelectorAll('#explorerPanel .tree-row[data-path]'));
        for (var k = 0; k < list.length; k++) {
          var p = list[k].dataset.path || '';
          if (p === want || p.slice(-(want.length + 1)) === '/' + want || list[k].dataset.name === want) return list[k];
        }
        return null;
      };
      hit = findRow();
      if (hit) {
        if (hit.dataset.isdir === '1') { hit.click(); return { ok: true, msg: '已展开目录 ' + (hit.dataset.name || want) }; }
        hit.click();
        return { ok: true, msg: '已打开 ' + (hit.dataset.name || want) };
      }
      // 没找到：先展开它的父目录再找一次（树是懒加载的）
      var segs = want.split('/');
      if (segs.length > 1) {
        var dirWant = segs.slice(0, -1).join('/');
        var dirRow = [].slice.call(document.querySelectorAll('#explorerPanel .tree-row[data-path]'))
          .filter(function (r) { return (r.dataset.path || '').slice(-(dirWant.length + 1)) === '/' + dirWant; })[0];
        if (dirRow) {
          dirRow.click();
          return new Promise(function (res) {
            setTimeout(function () {
              var h2 = findRow();
              if (h2) { h2.click(); res({ ok: true, msg: '已打开 ' + (h2.dataset.name || want) }); }
              else res({ ok: false, msg: '展开目录后仍没找到 ' + arg });
            }, 450);
          });
        }
      }
      return { ok: false, msg: '文件树里没有 ' + arg + '（需要先在资源管理器展开该目录）' };
    }

    if (act === 'tab' || act === 'closetab') {
      var tabs = [].slice.call(document.querySelectorAll('.tab'));
      var t = arg ? tabs.filter(function (x) { return (x.textContent || '').indexOf(arg) >= 0; })[0]
                  : document.querySelector('.tab.active');
      if (!t) return { ok: false, msg: '没有找到标签：' + (arg || '当前') };
      if (act === 'tab') { t.click(); return { ok: true, msg: '已切换到「' + arg + '」' }; }
      var x = t.querySelector('.t-close');
      if (!x) return { ok: false, msg: '该标签没有关闭按钮' };
      x.click();
      return { ok: true, msg: '已关闭标签' };
    }

    if (act === 'save') return ideClick(ideQ('#tbSave')) ? { ok: true, msg: '已保存当前文件' } : { ok: false, msg: '找不到保存按钮' };
    if (act === 'run') return ideClick(ideQ('#runPanelRun')) ? { ok: true, msg: '已运行当前文件' } : { ok: false, msg: '找不到运行按钮' };
    if (act === 'stop') return ideClick(ideQ('#bpKill')) ? { ok: true, msg: '已终止运行' } : { ok: false, msg: '找不到终止按钮' };
    if (act === 'refresh') return ideClick(ideQ('#sideRefresh')) ? { ok: true, msg: '已刷新资源管理器' } : { ok: false, msg: '找不到刷新按钮' };
    if (act === 'zen') return ideClick(ideQ('#tbZen')) ? { ok: true, msg: '已切换专注模式' } : { ok: false, msg: '找不到专注模式按钮' };
    if (act === 'settings') return ideClick(ideQ('#actSettings')) ? { ok: true, msg: '已打开设置' } : { ok: false, msg: '找不到设置入口' };

    if (act === 'terminal' || act === 'output') {
      var bp = document.getElementById('bottomPanel');
      if (!ideVisible(bp)) ideClick(ideQ('#tbBottom'));
      ideClick(ideQ(act === 'terminal' ? '.bp-tab[data-pane="term"]' : '.bp-tab[data-pane="output"]'));
      return { ok: true, msg: act === 'terminal' ? '已打开终端' : '已打开输出面板' };
    }

    if (act === 'sidebar' || act === 'bottom') {
      var isSide = act === 'sidebar';
      var el = document.getElementById(isSide ? 'sidebar' : 'bottomPanel');
      var wantShow = arg === '1' || arg === 'show' || arg === 'open';
      if (ideVisible(el) !== wantShow) ideClick(ideQ(isSide ? '#tbSide' : '#tbBottom'));
      return { ok: true, msg: (wantShow ? '已显示' : '已隐藏') + (isSide ? '侧边栏' : '底部面板') };
    }

    if (act === 'ai') {
      if (!ideVisible(ideQ('#aiPanel'))) ideClick(ideQ('#aiToggle'));
      return { ok: true, msg: '已打开 AI 助手' };
    }

    if (act === 'search') {
      if (!arg) return { ok: false, msg: '缺少搜索关键字' };
      ideClick(ideQ('.activitybar .act[data-panel="search"]'));
      var inp = document.getElementById('searchInput');
      if (!inp) return { ok: false, msg: '找不到搜索框' };
      inp.value = arg;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return { ok: true, msg: '已在项目中搜索「' + arg + '」' };
    }

    if (act === 'click') {                             // 点左侧面板条目 / 弹窗按钮
      var a = String(arg || '').trim();
      var tryClick = function () {
        var idx = -1;
        if (/^\d+$/.test(a)) idx = parseInt(a, 10) - 1;
        if (!(idx >= 0 && idx < ideSnapItems.length)) {
          idx = -1;
          for (var n = 0; n < ideSnapItems.length; n++) {
            if (ideSnapItems[n].text.indexOf(a) >= 0) { idx = n; break; }
          }
        }
        if (idx >= 0 && idx < ideSnapItems.length) {
          var it = ideSnapItems[idx];
          if (!it.el.isConnected || !it.el.offsetHeight) return { ok: false, msg: '该条目已不在当前面板，请再说一次' };
          try { it.el.click(); } catch (e) { return { ok: false, msg: '点击失败：' + (e && e.message || e) }; }
          return { ok: true, msg: '已点击「' + it.text.slice(0, 22) + '」' };
        }
        for (var m = 0; m < ideFormButtons.length; m++) { // 弹窗里的按钮（保存 / 取消 …）
          if (ideFormButtons[m].text.indexOf(a) >= 0) {
            var btn = ideFormButtons[m];
            if (!btn.el.isConnected || !btn.el.offsetHeight) return { ok: false, msg: '弹窗已关闭' };
            try { btn.el.click(); } catch (e2) { return { ok: false, msg: '点击失败：' + (e2 && e2.message || e2) }; }
            return { ok: true, msg: '已点击「' + btn.text + '」' };
          }
        }
        return null;
      };
      var first = tryClick();
      if (first) return first;
      // 找不到多半是刚切了面板、列表还在异步加载：等 420ms 重新抓一次再试
      return new Promise(function (res) {
        setTimeout(function () {
          ideSnapshot();
          res(tryClick() || { ok: false, msg: '界面清单里没有「' + a + '」' });
        }, 420);
      });
    }

    if (act === 'fill' || act === 'set') {             // 填弹窗里的字段
      var fname = String(arg || '').trim();
      var val = spec && spec.value != null ? String(spec.value) : '';
      if (!fname) return { ok: false, msg: '缺少字段名' };
      var fld = null, q;
      for (q = 0; q < ideFormFields.length; q++) {
        if (ideFormFields[q].label === fname) { fld = ideFormFields[q]; break; }
      }
      if (!fld) {
        for (q = 0; q < ideFormFields.length; q++) {
          var L = ideFormFields[q].label || '';
          if (L && (L.indexOf(fname) >= 0 || fname.indexOf(L) >= 0)) { fld = ideFormFields[q]; break; }
        }
      }
      if (!fld) {
        for (q = 0; q < ideFormFields.length; q++) {
          if ((ideFormFields[q].ph || '').indexOf(fname) >= 0) { fld = ideFormFields[q]; break; }
        }
      }
      if (!fld) return { ok: false, msg: '弹窗里没有「' + fname + '」字段（先打开表单）' };
      if (!fld.el.isConnected) return { ok: false, msg: '弹窗已关闭' };
      ideSetValue(fld.el, val);
      fld.value = String(fld.el.value == null ? '' : fld.el.value);
      return { ok: true, msg: '已填写「' + (fld.label || fname) + '」= ' + String(val).slice(0, 30) };
    }

    return { ok: false, msg: '不认识的动作：' + (act || '(空)') };
  }

  /* 渲染前把动作标签剥掉（未闭合的那半截也隐藏，避免闪出来） */
  function stripIde(t) {
    return String(t || '')
      .replace(/<ide>[\s\S]*?<\/ide>/gi, '')
      .replace(/<ide>[\s\S]*$/i, '');
  }

  /* 边流式边扫描：每凑齐一个闭合标签就执行一条；改成串行（上一条动作完成后再做下一条），
     否则「切面板 → 点新建任务」这种有依赖的连续动作会并发，顺序就乱了。 */
  function ideScan(reply) {
    if (!chatAgentOn() || !reply || reply._ideBusy) return;
    var m = /<ide>([\s\S]*?)<\/ide>/i.exec(reply.content);
    if (!m) return;
    reply.content = reply.content.slice(0, m.index) + reply.content.slice(m.index + m[0].length);

    var spec;
    try {
      spec = JSON.parse(m[1].trim());
    } catch (e) {
      chatTip('动作格式不对，已忽略', true, 5000);
      ideScan(reply);
      return;
    }

    reply._ideBusy = true;
    var done = function (res) {
      reply._ideBusy = false;
      if (res) {
        // 记一笔：本轮到底做了什么，自动续轮时要用
        ideActLog.push({ act: spec.act, arg: String(spec.arg == null ? '' : spec.arg), ok: !!res.ok, msg: String(res.msg || '') });
        chatTip((res.ok ? '✓ ' : '✗ ') + res.msg, !res.ok, 4200);
      }
      ideScan(reply);                       // 接着处理下一条
    };
    var r;
    try {
      r = ideDo(spec);
    } catch (e2) {
      r = { ok: false, msg: String((e2 && e2.message) || e2) };
    }
    if (r && typeof r.then === 'function') r.then(done, function () { done(null); });
    else done(r);
  }

  function dkEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function chatBuild() {
    if (chatEl) return;
    chatEl = document.createElement('div');
    chatEl.id = 'deskie-chat';
    chatEl.innerHTML =
      '<div class="dkc-head">' +
        '<span class="dkc-title"><i class="bi bi-stars"></i><b id="dkcName">伙伴</b></span>' +
        '<button class="dkc-ico" id="dkcWeb" title="按需联网：需要实时信息时我才会去查"><i class="bi bi-globe2"></i></button>' +
        '<button class="dkc-ico" id="dkcProj" title="智能体：允许读取当前项目里的文件来回答（只读）"><i class="bi bi-folder2-open"></i></button>' +
        '<button class="dkc-ico" id="dkcAgent" title="Agent：可以直接替你操作界面（开关面板 / 打开文件 / 运行 / 终端 …）"><i class="bi bi-robot"></i></button>' +
        '<button class="dkc-ico" id="dkcNew" title="新建对话（当前这段会存进历史，从空白重新开始）"><i class="bi bi-plus-lg"></i></button>' +
        '<button class="dkc-ico" id="dkcHist" title="历史对话（所有会话都在这里，可点任意一段继续聊）"><i class="bi bi-clock-history"></i></button>' +
        '<button class="dkc-ico" id="dkcMax" title="放大窗口"><i class="bi bi-arrows-angle-expand"></i></button>' +
        '<button class="dkc-ico" id="dkcClose" title="关闭（Esc）"><i class="bi bi-x-lg"></i></button>' +
        /* 提示条 / 历史列表都挂在标题栏里、绝对定位浮在消息区上方：出现 / 消失都不会顶动消息 */
        '<div class="dkc-tip" id="dkcTip"></div>' +
        '<div class="dkc-hist" id="dkcHistList"></div>' +
      '</div>' +
      '<div class="dkc-list scroll-thin" id="dkcList"></div>' +
      '<div class="dkc-foot">' +
        '<textarea id="dkcIn" rows="1" spellcheck="false"' +
          ' placeholder="和我说点什么…" title="Enter 发送 / Shift+Enter 换行"></textarea>' +
        '<button class="dkc-send" id="dkcSend" title="发送"><i class="bi bi-send"></i></button>' +
      '</div>';
    document.body.appendChild(chatEl);

    chatListEl = chatEl.querySelector('#dkcList');
    chatInEl = chatEl.querySelector('#dkcIn');
    chatBtnEl = chatEl.querySelector('#dkcSend');
    chatWebEl = chatEl.querySelector('#dkcWeb');
    chatProjEl = chatEl.querySelector('#dkcProj');
    chatAgentEl = chatEl.querySelector('#dkcAgent');
    chatMaxEl = chatEl.querySelector('#dkcMax');
    chatTipEl = chatEl.querySelector('#dkcTip');
    histEl = chatEl.querySelector('#dkcHistList');

    chatEl.querySelector('#dkcClose').addEventListener('click', hideChat);
    chatEl.querySelector('#dkcNew').addEventListener('click', function () {
      hideHist();
      sessNew();
    });
    chatEl.querySelector('#dkcHist').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (histEl.classList.contains('open')) hideHist();
      else showHist();
    });
    /* 历史列表：点条目切会话、点 × 删会话、底部两个动作（清空当前 / 新建对话） */
    histEl.addEventListener('click', function (ev) {
      var del = ev.target.closest && ev.target.closest('.dkc-hdel');
      if (del) { ev.stopPropagation(); sessDel(del.dataset.del); return; }
      var act = ev.target.closest && ev.target.closest('.dkc-hbtn');
      if (act) {
        if (act.dataset.act === 'new') sessNew();
        else if (act.dataset.act === 'clear') sessClear();
        return;
      }
      var item = ev.target.closest && ev.target.closest('.dkc-hitem');
      if (item) sessUse(item.dataset.id);
    });
    document.addEventListener('click', function (ev) {
      if (!histEl.classList.contains('open')) return;
      if (histEl.contains(ev.target)) return;
      if (ev.target.closest && ev.target.closest('#dkcHist')) return;
      hideHist();
    });
    chatWebEl.addEventListener('click', function () {
      var on = !chatWebOn();
      chatSetWeb(on);
      chatWebEl.classList.toggle('on', on);
      say(on ? '联网打开啦，需要的时候我会自己去查 ~' : '联网关掉啦，我靠自己。', 2400);
    });
    chatProjEl.addEventListener('click', function () {
      var on = !chatProjOn();
      if (on && !ideRoot()) {                            // 没打开项目就没得读
        chatTip('没找到当前项目路径：先在 IDE 里打开一个文件夹', true, 8000);
        return;
      }
      chatSetProj(on);
      chatProjEl.classList.toggle('on', on);
      say(on ? '好，我可以翻你的项目文件了（只读）~' : '不翻文件啦，就纯聊天。', 2400);
    });
    chatAgentEl.addEventListener('click', function () {
      var on = !chatAgentOn();
      chatSetAgent(on);
      chatAgentEl.classList.toggle('on', on);
      say(on ? 'Agent 上线！要开什么面板、跑什么，直接说 ~' : 'Agent 退啦，我只动嘴不动手。', 2600);
    });
    chatBtnEl.addEventListener('click', function () {
      if (chatBusy) { if (chatAbort) { try { chatAbort.abort(); } catch (e) {} } return; }
      chatSend();
    });
    chatMaxEl.addEventListener('click', chatToggleMax);
    chatInEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); chatSend(); }
    });
    chatInEl.addEventListener('input', chatAutoGrow);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && chatOpen()) hideChat();
    });

    // 标题栏可拖动（只挪面板，不会带动桌宠）；松手后把新位置记成「相对桌宠」的偏移，
    // 之后拖桌宠时面板仍按这个新偏移跟随。
    var headEl = chatEl.querySelector('.dkc-head');
    var cDrag = null;
    headEl.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || chatMaxed) return;                 // 最大化后不拖
      if (ev.target.closest && ev.target.closest('button, .dkc-hist')) return;   // 按钮 / 历史列表不当作拖拽把手
      cDrag = { sx: ev.clientX, sy: ev.clientY,
                ox: chatEl.offsetLeft, oy: chatEl.offsetTop,   // 面板起点
                px: el.offsetLeft, py: el.offsetTop };         // 桌宠起点
      chatEl.classList.add('dragging');
      headEl.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    headEl.addEventListener('pointermove', function (ev) {
      if (!cDrag) return;
      var dx = ev.clientX - cDrag.sx, dy = ev.clientY - cDrag.sy;

      // 先让桌宠跟着走（chatSyncing 期间 setPos 不会反过来再推面板，避免循环抖动）
      chatSyncing = true;
      setPos(cDrag.px + dx, cDrag.py + dy);
      chatSyncing = false;

      var x = Math.max(4, Math.min(cDrag.ox + dx, window.innerWidth - chatEl.offsetWidth - 4));
      var y = Math.max(4, Math.min(cDrag.oy + dy, window.innerHeight - chatEl.offsetHeight - 4));
      chatEl.style.left = x + 'px';
      chatEl.style.top = y + 'px';
    });
    headEl.addEventListener('pointerup', function () {
      if (!cDrag) return;
      cDrag = null;
      chatEl.classList.remove('dragging');
      // 松手后把「面板相对桌宠」的偏移重新记下来，两边仍保持联动
      chatAnchor = { dx: chatEl.offsetLeft - el.offsetLeft, dy: chatEl.offsetTop - el.offsetTop };
      savePos();
    });
    headEl.addEventListener('pointercancel', function () {
      cDrag = null;
      chatEl.classList.remove('dragging');
    });
  }

  function chatRender() {
    if (!chatEl) return;
    var p = PETS[curId] || PETS.buddy;
    var nameEl = chatEl.querySelector('#dkcName');
    if (nameEl) nameEl.textContent = p.name.replace(/\s*\(.*\)\s*$/, '');
    chatWebEl.classList.toggle('on', chatWebOn());
    if (chatProjEl) chatProjEl.classList.toggle('on', chatProjOn());
    if (chatAgentEl) chatAgentEl.classList.toggle('on', chatAgentOn());

    var list = chatLoad();

    // 有压缩摘要在就先挂一条提示（悬停可看摘要内容）
    var sum = chatSumLoadFor(curId);
    var html = '';
    if (sum && sum.text) {
      html += '<div class="dkc-sum" title="' + dkEsc(String(sum.text).slice(0, 500)) + '">' +
                '<i class="bi bi-archive"></i>早前对话已压缩成摘要（悬停查看）</div>';
    }
    if (!list.length) {
      html += '<div class="dkc-empty">' +
                '<i class="bi bi-chat-heart"></i>' +
                '<div>' + dkEsc(p.hello || '你好呀 ~') + '</div>' +
                '<span>我会记住我们聊过的话，聊技术、聊心情都行。</span>' +
              '</div>';
    } else {
      for (var k = 0; k < list.length; k++) {
        var isMe = list[k].role === 'user';
        var role = isMe ? 'me' : 'pet';
        // 自己说的话保持纯文本（所见即所发），伙伴的回复走 Markdown 渲染（动作标签先剥掉）
        var body = isMe ? dkEsc(list[k].content) : mdToHtml(stripIde(list[k].content));
        html += '<div class="dkc-msg ' + role + '"><div class="dkc-body">' + body + '</div></div>';
      }
    }
    chatListEl.innerHTML = html;
    chatScroll();
    if (histOpen()) histRender();          // 历史面板开着时一起刷新（删 / 切会话后即时反映）
  }

  /* ---------- 会话操作：新建 / 切换 / 删除 / 清空 ---------- */
  function dkFmtTime(ts) {
    var d = new Date(ts || Date.now()), n = new Date();
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === n.toDateString()) return '今天 ' + hm;
    var y = new Date(n.getTime() - 864e5);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function histRender() {
    if (!histEl) return;
    var o = sessLoadFor(curId);
    var h = '<div class="dkc-hist-cap"><span><i class="bi bi-clock-history"></i> 历史对话</span>' +
              '<span class="dkc-hist-n">' + o.list.length + ' 段</span></div>' +
            '<div class="dkc-hist-items scroll-thin">';
    for (var i = 0; i < o.list.length; i++) {
      var s = o.list[i], cnt = (s.msgs || []).length;
      h += '<div class="dkc-hitem' + (s.id === o.cur ? ' on' : '') + '" data-id="' + s.id + '">' +
             '<div class="dkc-hmain">' +
               '<div class="dkc-ht">' + dkEsc(s.title || '新对话') + '</div>' +
               '<div class="dkc-hm">' + dkFmtTime(s.ts) + ' · ' + cnt + ' 条' +
                 (s.id === o.cur ? '<span class="dkc-htag">当前</span>' : '') + '</div>' +
             '</div>' +
             '<button class="dkc-hdel" data-del="' + s.id + '" title="删除这段对话"><i class="bi bi-x-lg"></i></button>' +
           '</div>';
    }
    h += '</div><div class="dkc-hist-foot">' +
           '<button class="dkc-hbtn" data-act="clear" title="只清空当前这段，其他历史保留"><i class="bi bi-eraser"></i> 清空当前</button>' +
           '<button class="dkc-hbtn primary" data-act="new"><i class="bi bi-plus-lg"></i> 新建对话</button>' +
         '</div>';
    histEl.innerHTML = h;
  }
  function histOpen() { return !!(histEl && histEl.classList.contains('open')); }
  function showHist() { histRender(); histEl.classList.add('open'); }
  function hideHist() { if (histEl) histEl.classList.remove('open'); }

  /* 新建对话：当前这段留着进历史，从空白开始；当前本来就是空的就直接复用 */
  function sessNew() {
    if (chatBusy) { chatTip('等这轮说完再开新对话 ~', true, 3000); return; }
    var r = sessCur(curId);
    if (!r.s.msgs.length) {
      hideHist();
      if (chatInEl) { chatInEl.value = ''; chatInEl.focus(); }
      chatTip('当前就是一段新对话，直接说就好');
      return;
    }
    var id = sessNewId();
    r.o.list.unshift({ id: id, title: '新对话', ts: Date.now(), msgs: [], sum: null });
    r.o.cur = id;
    if (r.o.list.length > SESS_MAX) r.o.list.length = SESS_MAX;   // 最早的那些丢掉
    sessSaveFor(curId, r.o);
    chatRender();
    hideHist();
    if (chatInEl) { chatInEl.value = ''; chatInEl.focus(); }
    say('开新对话啦，刚才那段收进历史了 ~', 2600);
  }

  /* 切回某段历史继续聊 */
  function sessUse(id) {
    if (chatBusy) { chatTip('等这轮说完再切 ~', true, 3000); return; }
    var o = sessLoadFor(curId), ok = false;
    for (var i = 0; i < o.list.length; i++) if (o.list[i].id === id) ok = true;
    if (!ok) return;
    hideHist();
    if (o.cur === id) return;
    o.cur = id;
    sessSaveFor(curId, o);
    chatRender();
    if (chatInEl) chatInEl.focus();
  }

  function sessDel(id) {
    if (chatBusy) { chatTip('等这轮说完再删 ~', true, 3000); return; }
    var o = sessLoadFor(curId), idx = -1;
    for (var i = 0; i < o.list.length; i++) if (o.list[i].id === id) idx = i;
    if (idx < 0) return;
    if (o.list.length <= 1) {                   // 只剩一段：清空内容，不删壳
      o.list[0].msgs = [];
      o.list[0].sum = null;
      o.list[0].title = '新对话';
      o.list[0].ts = Date.now();
    } else {
      o.list.splice(idx, 1);
      if (o.cur === id) o.cur = o.list[0].id;
    }
    sessSaveFor(curId, o);
    chatRender();
    histRender();
  }

  /* 清空当前这段（其他历史保留） */
  function sessClear() {
    if (chatBusy) { chatTip('等这轮说完再清空 ~', true, 3000); return; }
    var r = sessCur(curId);
    r.s.msgs = [];
    r.s.sum = null;
    r.s.title = '新对话';
    r.s.ts = Date.now();
    sessSaveFor(curId, r.o);
    chatRender();
    hideHist();
    say('这段我忘掉啦 ~', 2200);
  }

  function chatScroll() {
    if (chatListEl) chatListEl.scrollTop = chatListEl.scrollHeight;
  }

  /* 输入框自动长高：先把高度归零再量 scrollHeight，并用 rAF 合并连续 input，
     以前直接写 height:auto 会让「min-height → 内容高」来回量，肉眼就是一直抖。 */
  var growQueued = false;
  function chatAutoGrow() {
    if (!chatInEl || growQueued) return;
    growQueued = true;
    requestAnimationFrame(function () {
      growQueued = false;
      chatInEl.style.height = '0px';
      var h = Math.max(33, Math.min(chatInEl.scrollHeight, 84));
      chatInEl.style.height = h + 'px';
      chatScroll();                     // 输入区变高时消息仍贴着底部，不跳动
    });
  }

  /* ---------- 轻量 Markdown 渲染 ----------
     先摘出代码块 / 行内代码 → 整体转义 HTML → 再做行内与块级替换，因此不存在 XSS；
     未闭合的 ``` 也能正常渲染（流式输出时经常来不及闭合）。
     支持：代码块、行内代码、粗体、斜体、删除线、链接、标题、有序/无序列表、引用、分隔线。 */
  function mdToHtml(src) {
    var s = String(src == null ? '' : src);
    var blocks = [], inlines = [];

    s = s.replace(/```([\w+-]*)[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      blocks.push({ lang: lang || '', code: code.replace(/\r?\n$/, '') });
      return '\u0001' + (blocks.length - 1) + '\u0001';
    });
    s = s.replace(/`([^`\n]+)`/g, function (m, code) {
      inlines.push(code);
      return '\u0002' + (inlines.length - 1) + '\u0002';
    });

    s = dkEsc(s);

    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
         .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
         .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
         .replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g,
                  '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    var lines = s.split('\n'), out = [], list = null, para = [];
    function flushPara() {
      if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
    }
    function flushList() {
      if (list) { out.push('</' + list + '>'); list = null; }
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var mUl = /^\s*[-*+]\s+(.*)$/.exec(ln);
      var mOl = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
      var mHd = /^\s*(#{1,6})\s+(.*)$/.exec(ln);
      if (/^\s*$/.test(ln)) { flushPara(); flushList(); continue; }
      // 独占一行的代码块占位：直接作为块级元素输出，别被包进 <p>
      if (/^\u0001\d+\u0001$/.test(ln.trim())) { flushPara(); flushList(); out.push(ln.trim()); continue; }
      if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(ln)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if (mHd) { flushPara(); flushList(); out.push('<div class="dkc-h">' + mHd[2] + '</div>'); continue; }
      if (mUl) {
        flushPara();
        if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + mUl[1] + '</li>');
        continue;
      }
      if (mOl) {
        flushPara();
        if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + mOl[1] + '</li>');
        continue;
      }
      if (/^\s*&gt;\s?/.test(ln)) {
        flushPara(); flushList();
        out.push('<blockquote>' + ln.replace(/^\s*&gt;\s?/, '') + '</blockquote>');
        continue;
      }
      flushList();
      para.push(ln);
    }
    flushPara();
    flushList();

    return out.join('')
      .replace(/\u0002(\d+)\u0002/g, function (m, n) {
        return '<code>' + dkEsc(inlines[+n] || '') + '</code>';
      })
      .replace(/\u0001(\d+)\u0001/g, function (m, n) {
        var b = blocks[+n] || { code: '' };
        return '<pre class="dkc-pre"><code>' + dkEsc(b.code) + '</code></pre>';
      });
  }
  /* 顶部提示条：联网检索结果 / 失败原因（不然模型一句“我没法联网”根本没法排查） */
  function chatTip(text, isErr, ms) {
    if (!chatTipEl) return;
    chatTipEl.textContent = text;
    chatTipEl.classList.toggle('err', !!isErr);
    chatTipEl.classList.add('show');
    clearTimeout(chatTipEl._t);
    chatTipEl._t = setTimeout(function () { chatTipEl.classList.remove('show'); }, ms || 7000);
  }
  /* 流式输出：只重绘最后一条气泡，并用 rAF 合并高频 delta（Markdown 重渲染不会一卡一卡） */
  var patchQueued = false, patchText = '';
  function chatPatch(text) {
    patchText = text;
    if (!chatListEl) return;
    if (patchQueued) return;
    patchQueued = true;
    requestAnimationFrame(function () {
      patchQueued = false;
      var items = chatListEl.querySelectorAll('.dkc-msg');
      var last = items[items.length - 1];
      var body = last && last.querySelector('.dkc-body');
      if (!body) { chatRender(); return; }
      body.innerHTML = mdToHtml(stripIde(patchText));
      chatScroll();
    });
  }
  function chatSetBusy(on) {
    if (!chatBtnEl) return;
    chatBtnEl.classList.toggle('busy', !!on);
    chatBtnEl.innerHTML = on ? '<i class="bi bi-stop-fill"></i>' : '<i class="bi bi-send"></i>';
    chatBtnEl.title = on ? '停止生成' : '发送';
  }

  /* 放大态：铺开并居中，且不再跟随桌宠（不然刚放大就被拖走） */
  function chatCenter() {
    if (!chatEl) return;
    var w = chatEl.offsetWidth, h = chatEl.offsetHeight;
    chatEl.style.left = Math.max(8, Math.round((window.innerWidth - w) / 2)) + 'px';
    chatEl.style.top = Math.max(8, Math.round((window.innerHeight - h) / 2)) + 'px';
  }
  function chatToggleMax() {
    if (!chatEl) return;
    chatMaxed = !chatMaxed;
    if (chatMaxed) {
      chatPrevPos = { left: chatEl.offsetLeft + 'px', top: chatEl.offsetTop + 'px' };
      chatEl.classList.add('maxed');
      chatCenter();
    } else {
      chatEl.classList.remove('maxed');
      if (chatPrevPos) {
        chatEl.style.left = chatPrevPos.left;
        chatEl.style.top = chatPrevPos.top;
      }
      chatAnchor = { dx: chatEl.offsetLeft - el.offsetLeft, dy: chatEl.offsetTop - el.offsetTop };
    }
    if (chatMaxEl) {
      chatMaxEl.innerHTML = '<i class="bi ' +
        (chatMaxed ? 'bi-arrows-angle-contract' : 'bi-arrows-angle-expand') + '"></i>';
      chatMaxEl.title = chatMaxed ? '还原窗口' : '放大窗口';
    }
    chatScroll();
  }

  /* 面板位置：右 → 左 → 下 → 上，挑第一个能完整塞进视口的方向。
     以前只判断了左右，桌宠漫步到上方时「底对齐」会算出负数、被夹到屏幕顶端，
     结果面板直接压住桌宠（还挡住左侧文件树）。 */
  function chatPosition() {
    if (!chatEl) return;
    if (chatMaxed) { chatCenter(); return; }

    var vw = window.innerWidth, vh = window.innerHeight;
    var pad = 8, gap = 12;
    var CW = Math.min(304, vw - pad * 2);        // 与 CSS 的 max-width / max-height 对齐
    var CH = Math.min(396, vh - pad * 2);
    var r = el.getBoundingClientRect();

    // 竖直：默认与桌宠底边齐平；靠上时改成顶对齐，免得顶出屏幕
    var baseY = r.top + r.height - CH;
    if (baseY < pad) baseY = r.top;
    baseY = Math.max(pad, Math.min(baseY, vh - CH - pad));
    var midX = Math.max(pad, Math.min(r.left + r.width / 2 - CW / 2, vw - CW - pad));

    var fit = function (x, y) {
      return x >= pad && y >= pad && x + CW <= vw - pad && y + CH <= vh - pad;
    };
    var x = midX, y = baseY;
    var rightX = r.right + gap;
    var leftX = r.left - CW - gap;
    var belowY = r.bottom + gap;
    var aboveY = r.top - CH - gap;

    if (fit(rightX, baseY)) { x = rightX; y = baseY; }
    else if (fit(leftX, baseY)) { x = leftX; y = baseY; }
    else if (fit(midX, belowY)) { x = midX; y = belowY; }
    else if (fit(midX, aboveY)) { x = midX; y = aboveY; }

    x = Math.max(pad, Math.min(x, vw - CW - pad));
    y = Math.max(pad, Math.min(y, vh - CH - pad));
    chatEl.style.left = x + 'px';
    chatEl.style.top = y + 'px';
    // 记住「对话框相对桌宠」的偏移，拖动桌宠时按这个偏移同步平移
    chatAnchor = { dx: x - el.offsetLeft, dy: y - el.offsetTop };
  }
  function syncChatToPet() {
    if (chatSyncing || chatMaxed || !chatOpen() || !chatAnchor) return;
    var x = el.offsetLeft + chatAnchor.dx;
    var y = el.offsetTop + chatAnchor.dy;
    x = Math.max(4, Math.min(x, window.innerWidth - chatEl.offsetWidth - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - chatEl.offsetHeight - 4));
    chatEl.style.left = x + 'px';
    chatEl.style.top = y + 'px';
  }

  function showChat() {
    freezeWander();                      // 聊天时别一边说话一边满屏跑（停在眼前位置）
    chatBuild();
    chatPosition();
    chatEl.classList.add('show');
    chatRender();
    setTimeout(function () { if (chatInEl) chatInEl.focus(); }, 40);
    if (MOOD[curId]) { paintFace('happy'); setTimeout(function () { paintFace('normal'); }, 1400); }
  }
  function hideChat() {
    if (!chatEl) return;
    hideHist();                          // 收起面板时历史列表也一并收掉
    chatEl.classList.remove('show');
    if (chatAbort) { try { chatAbort.abort(); } catch (e) {} }
  }

  /* Agent 续轮（每轮最多补一次）：
     A. 表单已经弹出来 → 把最新字段清单交给模型，直接填完保存；
     B. 用户要的是「新建 / 创建」这类多步请求，但这一轮只做了「打开面板」——
        自动再给一轮机会，把「点新建」补齐（用户不用再催一句）。 */
  // 一条消息最多自动补 3 轮：①点「新建」→ ②填字段 → ③点保存/收尾。
  // 每轮都要重新判断（不能只判断一次），否则「打开面板」后表单弹出来了却没人填。
  var followCount = 0;
  /* 用户这句是不是「要建东西」——覆盖新建 / 创建 / 定一个 / 设一个 / 提醒我 这些说法 */
  function chatWantsCreate() {
    return /(新建|创建|新增|添加|加一?个|建一?个|开一?个|定一?个|设一?个|设置一?个|帮我(建|加|定|设|开)|给我(建|加|定|设|开)|提醒我)/.test(chatLastUserText || '');
  }
  function chatActSummary() {
    return ideActLog.slice(-3).map(function (a) {      // 只列最近 3 条，免得提示词越滚越长
      return (a.ok ? '' : '（失败）') + a.act + (a.arg ? '「' + String(a.arg).slice(0, 20) + '」' : '');
    }).join('、');
  }
  function chatAutoFollow(petId) {
    if (!chatAgentOn() || chatBusy || followCount >= 3) return false;
    var snap = ideSnapshot();                    // 重新抓：这一轮的动作可能刚把表单弹出来
    var hasForm = !!(snap.form && snap.form.fields.length);

    // 只做了一半：用户要建东西、表单还没出现、而且还没成功点过「新建」
    // （模型光说不做、只开了面板、点了别的东西，都算「没做到位」，值得再给一轮）
    var halfDone = false;
    if (!hasForm && chatWantsCreate() && ideActLog.length <= 2) {
      var clickedNew = false;
      for (var i = 0; i < ideActLog.length; i++) {
        // 只有「点新建且成功」才算做到位；点了但失败（面板还没渲染完之类）仍要再给一轮
        if (ideActLog[i].act === 'click' && ideActLog[i].ok &&
            /新建|创建|添加|新增/.test(ideActLog[i].arg)) clickedNew = true;
      }
      // 已经点过「新建」但表单没出来（可能点错了），就不再纠缠，免得来回绕圈
      halfDone = !clickedNew;
    }
    if (!hasForm && !halfDone) return false;
    followCount++;

    var snapText = ideSnapText(snap);
    var sysText = (PERSONA[petId] || PERSONA.buddy) + '\n' + CHAT_RULE + '\n' + AGENT_RULE;
    if (snapText) sysText += '\n\n' + snapText;
    if (hasForm) {
      sysText += '\n\n[系统] 界面刚刚更新（上面是弹窗字段与按钮）。若用户请求还没完成，' +
                 '就用 fill 填好字段、再 click 保存；已完成就用一句话告诉用户结果，不要重复做过的动作。';
    } else {
      sysText += '\n\n[系统] 这是自动续接。你上一轮只做了：' + (chatActSummary() || '（没有任何界面动作）') + '。' +
                 '用户要的是「新建」，但表单还没打开，任务并没有完成。' +
                 '请立刻继续用 <ide> 动作：click 面板里的「新建」按钮（定时任务是「新建任务」，' +
                 '数据库 / SSH 是「新建连接」，API 是「新建请求」，后台任务是「新建任务」）。' +
                 '不要再用文字解释，也不要重复已经做过的动作。';
    }

    var list = chatLoadFor(petId);
    var msgs = [{ role: 'system', content: sysText }];
    var ctx = list.slice(-CHAT_TURNS * 2);
    for (var i = 0; i < ctx.length; i++) {
      if (ctx[i].role === 'user' || ctx[i].role === 'assistant') {
        msgs.push({ role: ctx[i].role, content: ctx[i].content });
      }
    }

    var reply = { role: 'assistant', content: '' };
    list.push(reply);
    chatStoreFor(petId, list);
    chatRender();
    chatPatch('（继续操作…）');

    chatBusy = true;
    chatSetBusy(true);
    if (curId === petId && MOOD[curId]) paintFace('think');
    chatAbort = new AbortController();

    (async function () {
      try {
        var res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: msgs,
            web_tool: chatWebOn(),
            web_event: 1,
            use_tools: true,
            perm: 'readonly',
            repo: (chatProjOn() && ideRoot()) || ''
          }),
          signal: chatAbort.signal
        });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
        while (true) {
          var rd = await reader.read();
          if (rd.done) break;
          buf += dec.decode(rd.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            var lines = chunk.split('\n');
            for (var li = 0; li < lines.length; li++) {
              var ln = lines[li];
              if (ln.indexOf('data:') !== 0) continue;
              var payload = ln.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              var obj;
              try { obj = JSON.parse(payload); } catch (e3) { continue; }
              if (obj.error) throw new Error(obj.error);
              if (obj.delta) {
                reply.content += obj.delta;
                ideScan(reply);
                if (curId === petId) chatPatch(reply.content);
              }
            }
          }
        }
      } catch (err) {
        if (!reply.content) reply.content = '';
      } finally {
        chatBusy = false;
        chatAbort = null;
        chatSetBusy(false);
        ideScan(reply);
        if (!reply.content) {
          chatStoreFor(petId, list.filter(function (m) { return m !== reply; }));
        } else {
          chatStoreFor(petId, list);
        }
        if (curId === petId) chatRender();
        // 这一轮可能只是把表单点出来了：同样等一拍再看要不要继续补（填字段 / 保存），
        // 否则「面板 → 新建 → 填表」会断在第二步，用户还得自己再催一次。
        // 模型这一轮要是啥都没吐（网络抖动 / 接口报错），就别再自动续了，免得空转。
        var gotContent = !!reply.content;
        setTimeout(function () {
          if (!gotContent || !chatAutoFollow(petId)) chatCompact(petId);
        }, 520);
      }
    })();
    return true;
  }

  function chatSend() {
    chatBuild();
    if (chatBusy) return;
    followCount = 0;                      // 新一轮消息：自动补轮次数归零
    ideActLog = [];                       // 新一轮：动作记录与用户原话都重记，供续轮判断
    var text = (chatInEl.value || '').trim();
    if (!text) return;
    chatLastUserText = text;
    chatInEl.value = '';
    chatInEl.style.height = '33px';    // 回到单行，和 CSS 基准高度一致（用 auto 会再量一次，容易抖）

    var petId = curId;                 // 本轮归属：中途换伙伴也不会串记忆
    var list = chatLoadFor(petId);
    list.push({ role: 'user', content: text });
    chatStoreFor(petId, list);

    // 「智能体」模式：允许读项目文件（只读），项目根目录按 IDE 当前打开的文件夹给
    var proj = chatProjOn() && !!ideRoot();
    // 上下文 = 人设 + 早前对话摘要（压缩记忆）+ 最近 12 轮原文
    var sumObj = chatSumLoadFor(petId);
    var agent = chatAgentOn();
    var sysText = (PERSONA[petId] || PERSONA.buddy) + '\n' + CHAT_RULE +
                  (proj ? '\n' + PROJ_RULE : '') + (agent ? '\n' + AGENT_RULE : '');
    if (agent) {                                  // 发消息时抓一份「当前界面清单」，模型才看得见具体条目
      var snapText = ideSnapText(ideSnapshot());
      if (snapText) sysText += '\n\n' + snapText;
    }
    if (sumObj && sumObj.text) sysText += '\n\n[早前对话摘要（更早的内容已被压缩）]\n' + sumObj.text;
    var msgs = [{ role: 'system', content: sysText }];
    var ctx = list.slice(-CHAT_TURNS * 2);
    for (var i = 0; i < ctx.length; i++) {
      if (ctx[i].role === 'user' || ctx[i].role === 'assistant') {
        msgs.push({ role: ctx[i].role, content: ctx[i].content });
      }
    }

    var reply = { role: 'assistant', content: '' };
    list.push(reply);
    chatStoreFor(petId, list);
    chatRender();
    chatPatch('（思考中…）');

    chatBusy = true;
    chatSetBusy(true);
    if (curId === petId && MOOD[curId]) paintFace('think');

    chatAbort = new AbortController();
    (async function () {
      try {
        var res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: msgs,
            // 按需联网：不给「回复前预搜索」，只把 web_search 工具交给模型自己判断
            web_tool: chatWebOn(),
            web_event: 1,                 // 预搜索时服务端会回推检索实况（此处通常不触发）
            use_tools: true,              // 具体给哪类工具由服务端按 repo / web_tool 决定
            perm: 'readonly',
            repo: proj ? ideRoot() : ''   // 项目根目录（文件工具的相对路径基于它）
          }),
          signal: chatAbort.signal
        });
        if (!res.ok) {
          var em = 'HTTP ' + res.status;
          try { var j = await res.json(); em = j.error || em; } catch (e2) {}
          throw new Error(em);
        }
        if (!res.body) throw new Error('当前浏览器不支持流式读取');

        var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
        while (true) {
          var rd = await reader.read();
          if (rd.done) break;
          buf += dec.decode(rd.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            var lines = chunk.split('\n');
            for (var li = 0; li < lines.length; li++) {
              var ln = lines[li];
              if (ln.indexOf('data:') !== 0) continue;
              var payload = ln.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              var obj;
              try { obj = JSON.parse(payload); } catch (e3) { continue; }
              if (obj.type === 'web') {                 // 服务端回报联网检索实况
                if (obj.ok) chatTip('已联网检索到 ' + obj.count + ' 条结果');
                else chatTip('联网检索失败：' + (obj.error || '没拿到结果') +
                             '（确认服务器能访问外网 / Bing）', true, 9000);
                continue;
              }
              if (obj.type === 'step') {                // 智能体正在调用工具
                chatTip('正在' + (TOOL_LABEL[obj.tool] || obj.tool) + '…', false, 15000);
                continue;
              }
              if (obj.type === 'result') {              // 工具执行完，回报读到了什么
                var sg = String(obj.summary || TOOL_LABEL[obj.tool] || obj.tool).slice(0, 70);
                chatTip((obj.ok ? '✓ ' : '✗ ') + sg, !obj.ok, 6000);
                continue;
              }
              if (obj.error) throw new Error(obj.error);
              if (obj.delta) {
                if (!reply.content && curId === petId && MOOD[curId]) paintFace('happy');
                reply.content += obj.delta;
                ideScan(reply);                       // 凑齐一个 <ide>…</ide> 就立刻执行
                if (curId === petId) chatPatch(reply.content);
              }
            }
          }
        }
        if (!reply.content) reply.content = '（没收到内容，检查一下「设置 → AI 接口」是否配置好了？）';
      } catch (err) {
        if (err && err.name === 'AbortError') {
          reply.content = reply.content || '（已停止）';
        } else {
          reply.content = reply.content || ('啊…出了点问题：' + (err && err.message ? err.message : err));
        }
      } finally {
        chatBusy = false;
        chatAbort = null;
        chatSetBusy(false);
        ideScan(reply);                      // 兜底：最后一帧才闭合的动作也别漏
        chatStoreFor(petId, list);
        if (curId === petId) {
          chatRender();
          if (MOOD[curId]) {
            paintFace('happy');
            setTimeout(function () { paintFace('normal'); }, 1800);
          }
        }
        // 本轮动作打开了表单 / 只做了一半 → 自动续一轮把剩下的事做完；否则再考虑压缩记忆。
        // 等 520ms：最后一条动作可能是带重试的 click（面板刚切、列表还在渲染），
        // 先让动作真正落定，续轮判断和快照才不会错位。
        setTimeout(function () {
          if (!chatAutoFollow(petId)) chatCompact(petId);
        }, 520);
      }
    })();
  }

  // ---------- 对外 API ----------
  window.Deskie = {
    say: function (text, ms) { show(); say(text, ms); },
    hop: function () { hop(); },
    show: show,
    hide: hide,
    use: use,
    pets: ORDER.slice(),
    current: function () { return curId; },
    chat: function () { showChat(); },        // 打开 / 聚焦桌宠 AI 对话面板
    /* 当前伙伴的表情 / 颜色 / 动作 */
    face: function (f) { paintFace(f); },
    faces: FACE_ORDER.slice(),
    color: function (i) { setHue(typeof i === 'number' ? i : 0); },
    nextColor: function () { nextHue(true); },       // 主动换色：固定颜色也照样换
    lockColor: function (on) { setColorLock(!!on); }, // 固定 / 解除固定当前颜色
    colorLocked: colorLocked,
    act: function (i) { doAct(i); },
    acts: function () { return (moodNow() ? moodNow().acts : []).map(function (a) { return a.mv; }); }
  };
  window.addEventListener('deskie-say', function (ev) {
    if (ev && ev.detail) say(String(ev.detail));
  });
  })();
