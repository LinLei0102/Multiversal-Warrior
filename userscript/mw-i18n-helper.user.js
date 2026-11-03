// ==UserScript==
// @name         Multiversal Warrior 汉化质检 & 快进
// @namespace    https://github.com/LinLei0102/Multiversal-Warrior
// @version      1.0.0
// @description  一键拉满资源/解锁后期界面，顺便收集界面上还没翻译的英文
// @author       LinLei0102
// @match        *://*.github.io/*
// @match        *://localhost/*
// @match        *://127.0.0.1/*
// @match        file:///*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* =============================================================================
 * 用途
 * -----------------------------------------------------------------------------
 * 1) 快进：直接改运行时状态（不是存档），点一下立刻生效，无需刷新。
 *    原理：游戏用 Vue，`document.body.__vue_app__._instance.proxy.$data`
 *    里的 `universal` 就是游戏内部的 IUniversal 本体，改它就是改游戏。
 *
 * 2) 质检：边玩边收集「还没翻译的英文」。
 *    - 引擎层：i18n 的 I18N.getMissing()（它记得每次没命中的原文）
 *    - DOM 层：直接扫页面文本节点与 title/alt 等属性，兜住「半截翻译」
 *    右上角数字就是当前累计，点「导出」存成 JSON 发给译者即可。
 *
 * 快捷键：Alt + M 显示 / 隐藏面板
 * ========================================================================== */

(function () {
  'use strict';

  /* -------------------------------------------------------------- 环境检查 */

  // 只在游戏页面上工作，避免污染其它站点
  if (!document.getElementById('bodyMain') || !document.getElementById('gamePage')) return;

  const STORE_PANEL = 'mw.cheat.panelOpen';

  /* ---------------------------------------------------------------- 状态 */

  const S = {
    speed: 1,
    autoScan: true,
    panelOpen: localStorage.getItem(STORE_PANEL) !== '0',
    counts: { engine: 0, dom: 0 },
  };

  /** 取游戏运行时数据（Vue 的根 data） */
  function gameData() {
    const app = document.body.__vue_app__;
    const vm = app && app._instance && app._instance.proxy;
    return (vm && vm.$data) || null;
  }

  function U() {
    const d = gameData();
    return d && d.universal;
  }

  function T() {
    const d = gameData();
    return d && d.training;
  }

  function D(x) {
    if (window.Decimal) return new window.Decimal(String(x));
    return Number(x);
  }

  function isDecimal(v) {
    return v && typeof v === 'object' && typeof v.e === 'number' && typeof v.m === 'number';
  }

  /* ------------------------------------------------------------ 数值操作 */

  // 有些字段是 Decimal，有些是 number/string，按当前类型写回去
  function write(obj, key, value) {
    if (!obj || !(key in obj)) return false;
    const cur = obj[key];
    if (isDecimal(cur)) obj[key] = D(value);
    else if (typeof cur === 'number') obj[key] = Number(value);
    else obj[key] = value;
    return true;
  }

  function multiply(obj, key, times) {
    if (!obj || !(key in obj)) return false;
    const cur = obj[key];
    if (isDecimal(cur)) obj[key] = cur.mul(D(times));
    else if (typeof cur === 'number') obj[key] = cur * times;
    else if (typeof cur === 'string' && Number.isFinite(Number(cur))) obj[key] = String(Number(cur) * times);
    else return false;
    return true;
  }

  /* IUniversal 里这些是「货币」，可以放心放大；*R / *Size / *Sel 是结构字段，不能碰 */
  const RESOURCES = [
    'size', 'heat', 'fireShards', 'fire', 'wood', 'coal', 'magma', 'light', 'rotation',
    'water', 'elisir', 'ambrosia', 'erbs', 'fluidFire', 'waterGem', 'pyroFrost',
    'intent', 'origin', 'sacredEnergy', 'nobility', 'divinity',
    'earth', 'golem', 'iron', 'silver', 'obsidian', 'mithril',
    'ironGolem', 'silverGolem', 'obsidianGolem', 'Uron', 'celesteDust', 'skyDust',
    'wind', 'ore', 'metal', 'soul', 'demon', 'ash', 'hellEnergy', 'soulEnergy', 'demonEnergy',
    'fame', 'maxFame', 'hope', 'maxHope', 'trust', 'maxTrust',
    'hellPowers1Points', 'hellPowers1PointsMax', 'hellPowers2Points', 'hellPowers2PointsMax',
    'hellPowers3Points', 'hellPowers3PointsMax',
    'massaConfusa', 'primaMateria', 'apocalypseHunts',
  ];

  /* ------------------------------------------------------------ 快进功能 */

  /** 资源 ×N */
  function multiplyResources(times) {
    const u = U();
    if (!u) return fail('拿不到游戏状态，可能页面还没加载完');
    let n = 0;
    for (const key of RESOURCES) if (multiply(u, key, times)) n++;
    toast(`资源 ×${times}（${n} 项）`);
  }

  /** 树节点全开 + 满级 */
  function unlockTrees() {
    const u = U();
    if (!u) return fail('拿不到游戏状态');
    const trees = ['fireTree', 'waterTree', 'earthTree', 'windTree', 'metalTree'];
    let n = 0;
    for (const name of trees) {
      const tree = u[name];
      if (!tree) continue;
      for (const id of Object.keys(tree)) {
        const node = tree[id];
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
        if ('active' in node && !node.active) { node.active = true; n++; }
        if ('unlocked' in node) node.unlocked = true;
        if ('click' in node) node.click = true;
        if ('level' in node) write(node, 'level', 10);
      }
    }
    toast(`已点亮 ${n} 个树节点`);
  }

  /** 子系统解锁：自动化 / 远征 / 宝物 / 熔炉 / 矿场 */
  function unlockSystems() {
    const u = U();
    if (!u) return fail('拿不到游戏状态');
    const groups = ['automation', 'expeditions', 'treasures', 'forge', 'mine', 'spires'];
    let n = 0;
    for (const g of groups) {
      const obj = u[g];
      if (!obj) continue;
      for (const id of Object.keys(obj)) {
        const item = obj[id];
        if (!item || typeof item !== 'object') continue;
        if ('unlocked' in item) item.unlocked = true;
        if (g === 'treasures' && 'active' in item) { item.active = true; n++; }
        if (g === 'expeditions' && 'level' in item) write(item, 'level', 1);
        if ((g === 'forge' || g === 'mine') && 'level' in item) write(item, 'level', 1);
      }
    }
    toast('子系统已解锁');
    return n;
  }

  /** 宇宙层数 */
  function setUniverse(value) {
    const u = U();
    if (!u) return fail('拿不到游戏状态');
    write(u, 'universe', value);
    toast(`宇宙 → ${value}`);
  }

  /** 飞升点 */
  function setAscension(value) {
    const u = U();
    if (!u) return fail('拿不到游戏状态');
    write(u, 'ascensionPoint', value);
    write(u, 'ascensionPointMax', value);
    toast(`飞升点 → ${value}`);
  }

  /** 训练：直接把等级与总量拉起来（力量的主要来源） */
  function boostTraining() {
    const t = T();
    if (!t || !t.base) return fail('拿不到训练数据');
    let n = 0;
    for (const key of Object.keys(t.base)) {
      const item = t.base[key];
      if (!item) continue;
      write(item, 'level', 100);
      if ('tot' in item) write(item, 'tot', '1e30');
      if ('active' in item) item.active = true;
      n++;
    }
    toast(`训练拉满（${n} 项）`);
  }

  /** 一键全做 */
  function everything() {
    unlockTrees();
    unlockSystems();
    multiplyResources('1e10');
    setUniverse(200);
    setAscension(9999);
    boostTraining();
  }

  /* ------------------------------------------------------------ 时间加速 */

  // 游戏的进度靠 Date.now() 差值算，所以把时钟调快就等于加速。
  // 副作用：存档里的 lastTick 会跑到未来，这里在写存档时顺手改回真实时间。
  const realNow = Date.now.bind(Date);
  let realBase = realNow();
  let virtBase = realBase;
  let factor = 1;

  const origSetItem = Storage.prototype.setItem;

  // 恢复存档时，页面卸载会触发游戏把「当前状态」写进 GameSaveOff，
  // 下次加载会把这份旧状态合并回来、把恢复的内容盖掉。这里直接拦掉。
  let restorePending = false;

  Storage.prototype.setItem = function (key, value) {
    if (restorePending && key === 'GameSaveOff') return;

    if (key === 'GameSave' && factor !== 1 && typeof value === 'string') {
      try {
        const obj = JSON.parse(value);
        if (obj && obj.IGameData) obj.IGameData.lastTick = realNow();
        value = JSON.stringify(obj);
      } catch (e) { /* 不是 JSON 就原样存 */ }
    }
    return origSetItem.call(this, key, value);
  };

  Date.now = function () {
    if (factor === 1) return realNow();
    return Math.round(virtBase + (realNow() - realBase) * factor);
  };

  function setSpeed(k) {
    // 重新基准，避免切换瞬间产生巨大的时间跳跃
    virtBase = Date.now();
    realBase = realNow();
    factor = k;
    S.speed = k;
    document.querySelectorAll('[data-speed]').forEach((el) => {
      el.style.background = el.dataset.speed === String(k) ? '#1e8449' : '';
      el.style.color = el.dataset.speed === String(k) ? '#fff' : '';
    });
    toast(k === 1 ? '时间恢复正常' : `时间 ×${k}`);
  }

  /* ------------------------------------------------------------ 漏翻收集 */

  const NUMERIC = /^[\s\d.,eE+\-×/()%×~°]*$/;

  function numericOnly(text) {
    const rest = text.replace(/[\d.,eE+\-×*/%()\s~]/g, '').replace(/^s$/, '');
    return !/[A-Za-z\u4e00-\u9fa5]/.test(rest);
  }

  function where(el) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.id) return '#' + cur.id;
      cur = cur.parentElement;
    }
    return el.tagName.toLowerCase();
  }

  function scanNow(push) {
    const result = { at: new Date().toISOString(), url: location.href, engine: [], dom: [], attrs: [] };

    try {
      if (window.I18N) result.engine = window.I18N.getMissing();
    } catch (e) { /* ignore */ }

    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue;
      if (!raw || !/[A-Za-z]{3,}/.test(raw)) continue;
      const pe = node.parentElement;
      if (!pe || pe.closest('[data-i18n-skip]')) continue;
      if (pe.tagName === 'SCRIPT' || pe.tagName === 'STYLE') continue;
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text.length > 200 || NUMERIC.test(text) || numericOnly(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      result.dom.push({ text, where: where(pe) });
    }

    document.querySelectorAll('[title],[placeholder],[alt],[aria-label]').forEach((el) => {
      ['title', 'placeholder', 'alt', 'aria-label'].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (!v || !/[A-Za-z]{3,}/.test(v) || numericOnly(v)) return;
        result.attrs.push({ text: v.trim(), attr, where: where(el) });
      });
    });

    S.counts = { engine: result.engine.length, dom: result.dom.length + result.attrs.length };
    refreshCounters();

    if (push) {
      // 累积到一张总表里，边玩边攒，最后一次性导出
      const acc = loadAccum();
      const add = (kind, text) => {
        const key = kind + '|' + text;
        if (!acc.map[key]) acc.map[key] = { kind, text, count: 0, where: [] };
        acc.map[key].count++;
      };
      result.engine.forEach((x) => add('engine', x.text));
      result.dom.forEach((x) => add('dom', x.text));
      result.attrs.forEach((x) => add('attr', x.text));
      saveAccum(acc);
    }
    return result;
  }

  /* 累计表存在 localStorage，刷新页面也不丢 */
  const ACC_KEY = 'mw.i18n.missingAccum';

  function loadAccum() {
    try {
      const raw = localStorage.getItem(ACC_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { map: {} };
  }

  function saveAccum(acc) {
    try { localStorage.setItem(ACC_KEY, JSON.stringify(acc)); } catch (e) { /* ignore */ }
  }

  function exportMissing() {
    scanNow(true);
    const acc = loadAccum();
    const items = Object.values(acc.map).sort((a, b) => b.count - a.count);
    const payload = {
      game: 'Multiversal Warrior',
      lang: window.I18N ? window.I18N.getLang() : 'unknown',
      exportedAt: new Date().toISOString(),
      total: items.length,
      items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mw-missing-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已导出 ${items.length} 条`);
  }

  /* ------------------------------------------------------------ 存档备份 */

  const BACKUP_KEY = 'GameSave.cheatBackup';

  function backupSave() {
    const cur = localStorage.getItem('GameSave');
    if (!cur) return fail('当前没有存档');
    localStorage.setItem(BACKUP_KEY, cur);
    toast('存档已备份');
  }

  function restoreSave() {
    const bak = localStorage.getItem(BACKUP_KEY);
    if (!bak) return fail('没有备份');
    restorePending = true;
    localStorage.setItem('GameSave', bak);
    localStorage.removeItem('GameSaveOff');
    toast('已恢复，正在刷新…');
    setTimeout(() => location.reload(), 600);
  }

  /* ---------------------------------------------------------------- UI */

  const CSS = `
    #mwq{position:fixed;right:12px;bottom:12px;z-index:2147483000;width:236px;
      font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8e8e8;
      background:rgba(22,24,29,.94);border:1px solid rgba(255,255,255,.12);border-radius:10px;
      box-shadow:0 6px 24px rgba(0,0,0,.45);backdrop-filter:blur(6px);user-select:none}
    #mwq header{display:flex;align-items:center;justify-content:space-between;
      padding:7px 10px;cursor:move;border-bottom:1px solid rgba(255,255,255,.1)}
    #mwq header b{font-weight:600;font-size:12px;letter-spacing:.02em}
    #mwq .x{cursor:pointer;opacity:.6;padding:0 4px}
    #mwq .x:hover{opacity:1}
    #mwq .body{padding:8px 10px 10px}
    #mwq .row{display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap}
    #mwq button{all:unset;flex:1;text-align:center;padding:4px 6px;border-radius:5px;
      background:rgba(255,255,255,.09);cursor:pointer;font-size:11px;white-space:nowrap;
      transition:background .12s}
    #mwq button:hover{background:rgba(255,255,255,.2)}
    #mwq button.primary{background:rgba(46,125,50,.85)}
    #mwq button.primary:hover{background:rgba(56,142,60,1)}
    #mwq button.warn{background:rgba(151,42,42,.8)}
    #mwq .label{opacity:.55;font-size:10px;margin:8px 0 4px;letter-spacing:.05em}
    #mwq .stat{display:flex;justify-content:space-between;font-size:11px;opacity:.85;margin-bottom:4px}
    #mwq .stat b{color:#ffd166;font-weight:600}
    #mwq.collapsed .body{display:none}
  `;

  let panel, counterEl;

  function toast(msg) {
    if (!panel) return;
    let tip = panel.querySelector('.tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      tip.style.cssText = 'position:absolute;left:0;right:0;top:-26px;text-align:center;font-size:11px;color:#9ae6b4;transition:opacity .3s';
      panel.appendChild(tip);
    }
    tip.textContent = msg;
    tip.style.opacity = '1';
    clearTimeout(tip._t);
    tip._t = setTimeout(() => { tip.style.opacity = '0'; }, 1400);
  }

  function fail(msg) { toast('⚠ ' + msg); }

  function btn(label, fn, cls) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  }

  function row(...children) {
    const r = document.createElement('div');
    r.className = 'row';
    children.forEach((c) => r.appendChild(c));
    return r;
  }

  function label(text) {
    const d = document.createElement('div');
    d.className = 'label';
    d.textContent = text;
    return d;
  }

  function refreshCounters() {
    if (!counterEl) return;
    counterEl.innerHTML = `<span>引擎未命中 <b>${S.counts.engine}</b></span><span>页面残留 <b>${S.counts.dom}</b></span>`;
  }

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'mwq';
    panel.setAttribute('data-i18n-skip', '');
    if (!S.panelOpen) panel.classList.add('collapsed');

    const head = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = '汉化质检 / 快进';
    const close = document.createElement('span');
    close.className = 'x';
    close.textContent = '—';
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'body';

    /* 快进 */
    body.append(label('资源（即时生效）'));
    body.append(row(
      btn('×10', () => multiplyResources(10)),
      btn('×1e6', () => multiplyResources('1e6')),
      btn('×1e10', () => multiplyResources('1e10'), 'primary')
    ));
    body.append(row(
      btn('点亮全树', unlockTrees),
      btn('解锁子系统', unlockSystems)
    ));
    body.append(label('进度'));
    body.append(row(
      btn('宇宙 +10', () => { const u = U(); if (u) write(u, 'universe', String(Number(u.universe) + 10)); }),
      btn('宇宙 =200', () => setUniverse(200))
    ));
    body.append(row(
      btn('训练拉满', boostTraining),
      btn('一键全做', everything, 'primary')
    ));

    /* 时间 */
    body.append(label('时间流速'));
    const speeds = [1, 2, 5, 10];
    body.append(row(...speeds.map((k) => {
      const b = btn(k === 1 ? '×1' : '×' + k, () => setSpeed(k));
      b.dataset.speed = String(k);
      if (k === 1) { b.style.background = '#1e8449'; b.style.color = '#fff'; }
      return b;
    })));

    /* 质检 */
    body.append(label('漏翻收集'));
    counterEl = document.createElement('div');
    counterEl.className = 'stat';
    body.append(counterEl);
    body.append(row(
      btn('扫描一次', () => { scanNow(true); toast('已记录'); }),
      btn('导出 JSON', exportMissing, 'primary')
    ));
    body.append(row(
      btn('清空累计', () => { localStorage.removeItem(ACC_KEY); if (window.I18N) window.I18N.clearMissing(); scanNow(false); toast('已清空'); })
    ));

    /* 存档 */
    body.append(label('存档'));
    body.append(row(
      btn('备份存档', backupSave),
      btn('恢复备份', restoreSave, 'warn')
    ));

    panel.append(head, body);
    document.body.appendChild(panel);

    /* 折叠 / 拖动 */
    close.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      S.panelOpen = !panel.classList.contains('collapsed');
      localStorage.setItem(STORE_PANEL, S.panelOpen ? '1' : '0');
    });

    let drag = null;
    head.addEventListener('mousedown', (e) => {
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = (e.clientX - drag.dx) + 'px';
      panel.style.top = (e.clientY - drag.dy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        close.click();
      }
    });
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    buildPanel();
    refreshCounters();

    // 自动开启引擎收集：边玩边记，用户什么也不用做
    if (window.I18N && S.autoScan) {
      try { window.I18N.collectMissing(true); } catch (e) { /* ignore */ }
    }

    // 每 3 秒刷新一次计数（只有面板展开时）
    setInterval(() => {
      if (!panel || panel.classList.contains('collapsed')) return;
      scanNow(false);
    }, 3000);
  }

  // 游戏初始化可能比脚本晚，等 Vue 挂载完再启动
  let tries = 0;
  const timer = setInterval(() => {
    if (gameData() || ++tries > 40) {
      clearInterval(timer);
      boot();
    }
  }, 250);
})();
