/* =============================================================================
 * i18n/i18n.js — Multiversal Warrior 运行时多语言层
 * -----------------------------------------------------------------------------
 * 设计目标：**零侵入**上游源码。
 *
 *   上游（index.html / fullRevamp.js）一个字都不改，本文件只在 DOM 层工作：
 *   拦截文本节点与若干属性，用词典做「原文 → 译文」替换。因此每次
 *   `git pull upstream` 都不会和汉化工作产生冲突，唯一需要维护的是
 *   locales/*.js 里的词条。
 *
 * 工作方式：
 *   1. 启动时全量遍历一次文档，把词典命中的文本节点替换掉；
 *   2. 之后用 MutationObserver 监听新增节点与文本变更，增量翻译；
 *   3. 每个被改写的节点都在 WeakMap 里记住原文，切换语言可无损回滚。
 *
 * 词典接口：
 *   I18N.register('zh-CN', {
 *     name: '简体中文',
 *     words: { 'Power': '力量', ... },            // 整段文本精确匹配
 *     patterns: [[/^Tier (\\d+)$/, '等级 $1'], ...]  // 含数字/变量的动态文案
 *   });
 *
 * 对外 API（window.I18N）：
 *   setLang(code) / getLang() / toggle()
 *   t(text)                 —— 程序内取译文，未命中返回原文
 *   collectMissing(on)      —— 开始记录未翻译文本
 *   exportMissing()         —— 把未翻译文本导出为 JSON 文件
 *   stats()                 —— 运行统计（改写次数 / 未命中数）
 * ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'mw.i18n.lang';
  var DEFAULT_LANG = 'en';
  var MAX_SOURCE_LEN = 900;   // 剧情段落可达 700+ 字符，上限要留够
  var CACHE_LIMIT = 20000;

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1
  };
  var TRANSLATE_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  /* ------------------------------------------------------------ 基础工具 */

  function norm(s) {
    return String(s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasLetter(s) {
    return /[A-Za-z]/.test(s);
  }

  /* ---------------------------------------------------------------- 状态 */

  var locales = Object.create(null);
  var order = [];
  var lang = DEFAULT_LANG;
  var dict = null;
  var started = false;

  var cache = new Map();          // 原文 -> 译文 | null
  var srcOf = new WeakMap();      // textNode -> 原文
  var writtenOf = new WeakMap();  // textNode -> 我们最后一次写入的值
  var attrSrcOf = new WeakMap();  // element -> { attr: 原文 }
  var attrWrittenOf = new WeakMap();

  var queue = new Set();
  var flushScheduled = false;
  var observer = null;

  var collecting = false;
  var missing = new Map();        // 未翻译原文 -> 出现次数
  var stats = { translated: 0, misses: 0, passes: 0 };

  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) lang = saved;
  } catch (e) { /* 隐私模式下忽略 */ }
  var savedLang = !!saved;

  /* ------------------------------------------------------------ 词典接口 */

  function register(code, data) {
    if (!code || !data) return;
    var words = new Map();
    var raw = data.words || {};
    for (var k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) {
        words.set(norm(k), raw[k]);
      }
    }
    if (data.aliases) {
      for (var a in data.aliases) {
        if (Object.prototype.hasOwnProperty.call(data.aliases, a)) {
          var target = words.get(norm(data.aliases[a]));
          if (target != null) words.set(norm(a), target);
        }
      }
    }
    var patterns = [];
    (data.patterns || []).forEach(function (p) {
      if (!p || p.length < 2) return;
      var re = p[0];
      if (!(re instanceof RegExp)) re = new RegExp(re);
      if (re.flags.indexOf('g') >= 0) re = new RegExp(re.source, re.flags.replace(/g/g, ''));
      patterns.push({ re: re, rep: p[1] });
    });

    locales[code] = { name: data.name || code, words: words, patterns: patterns };
    if (order.indexOf(code) < 0) order.push(code);
    cache.clear();
    if (!dict) dict = locales[code];
  }

  // 展开替换串：$1..$9 直接取捕获组，%1..%9 先递归查词条/模式再取（查不到就保留原文）
  function expand(rep, args, depth) {
    return rep
      .replace(/\$(\d)/g, function (_, i) {
        var v = args[+i - 1];
        return v == null ? '' : v;
      })
      .replace(/%(\d)/g, function (_, i) {
        var v = args[+i - 1];
        if (v == null) return '';
        var w = depth > 0 ? resolve(v, depth - 1) : null;
        return w == null ? v : w;
      });
  }

  // 真正的查词：先精确词条，再模式；depth 限制递归层数，防止互相套娃
  function resolve(text, depth) {
    if (!dict) return null;
    var key = norm(text);
    if (!key) return null;

    var w = dict.words.get(key);
    if (w != null) return w;

    if (depth <= 0) return null;

    for (var i = 0; i < dict.patterns.length; i++) {
      var p = dict.patterns[i];
      var m = key.match(p.re);
      if (!m) continue;
      if (typeof p.rep === 'function') return p.rep.apply(null, m);
      if (p.rep.indexOf('%') >= 0 || p.rep.indexOf('$') >= 0) return expand(p.rep, m.slice(1), depth - 1);
      return p.rep;
    }
    return null;
  }

  function lookup(text) {
    var hit = cache.get(text);
    if (hit !== undefined) return hit;

    var out = resolve(text, 4);   // 允许多层组合：'Woodcutter price /2 (' → 伐木者价格
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(text, out);
    return out;
  }

  /* ------------------------------------------------------------ 文本翻译 */

  // 返回译文；返回 null 表示「保持原样」
  function render(src) {
    if (!dict || lang === 'en') return null;
    if (!src || src.length > MAX_SOURCE_LEN || !hasLetter(src)) return null;

    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(src);
    var core = m[2];
    if (!core) return null;

    var tr = lookup(core);
    if (tr == null) {
      noteMissing(core);
      return null;
    }
    return m[1] + tr + m[3];
  }

  // 纯数值/纯单位串（8.1s、×9.77e6、1.00e40/1.66e8、-300.0s）不需要翻译
  function numericOnly(text) {
    var rest = text
      .replace(/[\d.,eE+\-×*/%()\s]/g, '')
      .replace(/^s$/, '')
      .replace(/^x$/i, '');
    return !/[A-Za-z\u4e00-\u9fa5]/.test(rest);
  }

  function noteMissing(text) {
    stats.misses++;
    if (!collecting) return;
    if (text.length < 2 || text.length > MAX_SOURCE_LEN) return;
    if (!hasLetter(text)) return;
    if (numericOnly(text)) return;
    missing.set(text, (missing.get(text) || 0) + 1);
  }

  function writeNode(node, value) {
    if (node.nodeValue === value) return;
    writtenOf.set(node, value);
    node.nodeValue = value;
    stats.translated++;
  }

  function translateTextNode(node) {
    if (!node || !dict) return;
    var cur = node.nodeValue;
    if (cur == null || cur.length > MAX_SOURCE_LEN) return;
    if (!hasLetter(cur)) return;

    var src = srcOf.get(node);
    var lastWritten = writtenOf.get(node);

    // 游戏代码写入了新内容（与我们上次写入的不同），视为新的原文
    if (src === undefined || (lastWritten !== undefined && cur !== lastWritten)) {
      src = cur;
      srcOf.set(node, src);
      writtenOf.delete(node);
    }

    var out = render(src);
    if (out == null) {
      // 切回英文或本条无译文时，恢复原文
      if (cur !== src) writeNode(node, src);
      return;
    }
    writeNode(node, out);
  }

  function shouldSkip(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.hasAttribute && (el.hasAttribute('data-i18n-skip') || el.hasAttribute('translate') && el.getAttribute('translate') === 'no')) return true;
    return false;
  }

  /* ---------------------------------------------------------- 属性翻译 */

  function translateAttrs(el) {
    if (!dict || el.nodeType !== 1) return;

    var store = attrSrcOf.get(el);
    var writtenStore = attrWrittenOf.get(el);

    for (var i = 0; i < TRANSLATE_ATTRS.length; i++) {
      var attr = TRANSLATE_ATTRS[i];
      var cur = el.getAttribute && el.getAttribute(attr);
      if (cur == null) continue;
      if (!hasLetter(cur)) continue;

      if (!store) { store = Object.create(null); attrSrcOf.set(el, store); }
      if (!writtenStore) { writtenStore = Object.create(null); attrWrittenOf.set(el, writtenStore); }

      var src = store[attr];
      if (src === undefined || (writtenStore[attr] !== undefined && cur !== writtenStore[attr])) {
        src = cur;
        store[attr] = src;
        delete writtenStore[attr];
      }

      var out = render(src);
      var next = out == null ? src : out;
      if (next !== cur) {
        writtenStore[attr] = next;
        el.setAttribute(attr, next);
      }
    }
  }

  /* -------------------------------------------------------- 遍历与调度 */

  var nodeFilter = {
    acceptNode: function (n) {
      if (n.nodeType === 1) return shouldSkip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  };

  // 同步微任务刷新：在浏览器绘制之前完成替换，避免「先显示英文再跳成中文」的闪烁
  function queueNode(n) {
    queue.add(n);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { queueNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && shouldSkip(root)) return;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, nodeFilter, false);
    var n;
    while ((n = walker.nextNode())) queueNode(n);
    queueAttrs(root);
  }

  function queueAttrs(root) {
    if (!dict || !root.querySelectorAll) return;
    var list = root.querySelectorAll('[title],[placeholder],[aria-label],[alt]');
    for (var i = 0; i < list.length; i++) {
      if (!shouldSkip(list[i])) translateAttrs(list[i]);
    }
  }

  function schedule() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  }

  function flush() {
    flushScheduled = false;
    if (!queue.size) return;
    stats.passes++;

    var budgetStart = performance.now();
    var batch = [];
    queue.forEach(function (n) { batch.push(n); });
    queue.clear();

    for (var i = 0; i < batch.length; i++) {
      var node = batch[i];
      if (!node.isConnected) continue;
      translateTextNode(node);
      // 单次处理超过 10ms 就把剩下的留到下一轮，避免长时间占用主线程
      if (performance.now() - budgetStart > 10) {
        for (var j = i + 1; j < batch.length; j++) queue.add(batch[j]);
        if (!flushScheduled) { flushScheduled = true; queueMicrotask(flush); }
        return;
      }
    }
  }

  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'characterData') {
        queueNode(r.target);
        continue;
      }
      for (var j = 0; j < r.addedNodes.length; j++) {
        var n = r.addedNodes[j];
        if (n.nodeType === 3) queueNode(n);
        else if (n.nodeType === 1) walk(n);
      }
    }
  }

  /* ------------------------------------------------------------ 语言切换 */

  function applyDocumentLang() {
    var html = document.documentElement;
    html.setAttribute('lang', lang);
    html.setAttribute('data-mw-lang', lang);
  }

  function reapplyAll() {
    if (!document.body) return;
    cache.clear();

    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, nodeFilter, false);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { translateAttrs(n); continue; }
      var src = srcOf.get(n);
      if (src === undefined) { translateTextNode(n); continue; }
      if (lang === 'en') writeNode(n, src);
      else {
        var out = render(src);
        writeNode(n, out == null ? src : out);
      }
    }
    translateTitle();
    syncSwitcher();
  }

  function setLang(code) {
    // 'en' 是源语言，不需要词典；其它语言必须已注册
    if (code !== DEFAULT_LANG && !locales[code]) return false;
    if (code === lang) { syncSwitcher(); return true; }

    lang = code;
    dict = locales[code] || null;
    cache.clear();
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }

    applyDocumentLang();
    reapplyAll();
    return true;
  }

  var originalTitle = null;

  function translateTitle() {
    if (!dict || lang === 'en') {
      if (originalTitle != null && document.title !== originalTitle) document.title = originalTitle;
      return;
    }
    var t = document.title;
    if (!t || !hasLetter(t)) return;
    var tr = lookup(t);
    if (tr != null) {
      if (originalTitle == null) originalTitle = t;
      document.title = tr;
    }
  }

  /* -------------------------------------------------------------- 切换器 */

  var SWITCH_ID = 'mw-i18n-switch';

  function injectStyle() {
    if (document.getElementById(SWITCH_ID + '-style')) return;
    var style = document.createElement('style');
    style.id = SWITCH_ID + '-style';
    style.textContent = [
      '#' + SWITCH_ID + '{position:fixed;left:10px;bottom:10px;z-index:2147483000;',
      'display:flex;gap:4px;padding:3px;border-radius:6px;',
      'background:rgba(0,0,0,.55);backdrop-filter:blur(3px);',
      'font:11px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'opacity:.45;transition:opacity .18s;user-select:none;cursor:pointer;',
      'box-shadow:0 1px 6px rgba(0,0,0,.35)}',
      '#' + SWITCH_ID + ':hover{opacity:1}',
      '#' + SWITCH_ID + ' button{all:unset;padding:2px 7px;border-radius:4px;color:#e8e8e8;cursor:pointer;',
      'font:inherit;letter-spacing:.02em;white-space:nowrap}',
      '#' + SWITCH_ID + ' button[data-active="1"]{background:rgba(255,255,255,.9);color:#111;font-weight:600}',
      'html[data-mw-lang="zh-CN"] #' + SWITCH_ID + ' button{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif}'
    ].join('');
    document.head.appendChild(style);
  }

  function mountSwitcher() {
    if (document.getElementById(SWITCH_ID)) return;
    if (!order.length) return;

    injectStyle();
    var box = document.createElement('div');
    box.id = SWITCH_ID;
    box.setAttribute('data-i18n-skip', '');

    var codes = [DEFAULT_LANG].concat(order.filter(function (c) { return c !== DEFAULT_LANG; }));
    codes.forEach(function (code) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.lang = code;
      btn.textContent = code === 'en' ? 'EN' : (locales[code] ? locales[code].name : code);
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        setLang(code);
      });
      box.appendChild(btn);
    });

    document.body.appendChild(box);
    syncSwitcher();
  }

  function syncSwitcher() {
    var box = document.getElementById(SWITCH_ID);
    if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].dataset.active = btns[i].dataset.lang === lang ? '1' : '0';
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    if (started) return;
    started = true;

    // 支持 ?lang=zh-CN 强制指定语言（便于分享链接 / 调试），?i18nDebug=1 打开未翻译收集
    try {
      var qs = new URLSearchParams(location.search);
      var forced = qs.get('lang');
      if (forced && (forced === DEFAULT_LANG || locales[forced])) {
        lang = forced;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
      } else if (!savedLang) {
        // 没有历史选择时跟随浏览器语言：中文环境自动进中文，其余保持原文
        var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
        if (nav.indexOf('zh') === 0 && locales['zh-CN']) lang = 'zh-CN';
      }
      if (qs.get('i18nDebug') === '1') { collecting = true; console.info('[i18n] 未翻译收集已开启，结束后执行 I18N.exportMissing()'); }
    } catch (e) { /* 老浏览器忽略 */ }

    dict = locales[lang] || null;
    applyDocumentLang();
    mountSwitcher();

    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

    walk(document.body);
    translateTitle();
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    started = false;
  }

  /* ---------------------------------------------------------------- API */

  var API = {
    register: register,
    setLang: setLang,
    getLang: function () { return lang; },
    toggle: function () {
      var codes = [DEFAULT_LANG].concat(order.filter(function (c) { return c !== DEFAULT_LANG; }));
      var i = codes.indexOf(lang);
      return setLang(codes[(i + 1) % codes.length]);
    },
    t: function (text) {
      var tr = lookup(text);
      return tr == null ? text : tr;
    },
    collectMissing: function (on) { collecting = on !== false; return collecting; },
    getMissing: function () {
      var items = [];
      missing.forEach(function (count, text) { items.push({ text: text, count: count }); });
      items.sort(function (a, b) { return b.count - a.count; });
      return items;
    },
    exportMissing: function () {
      var items = [];
      missing.forEach(function (count, text) { items.push({ text: text, count: count }); });
      items.sort(function (a, b) { return b.count - a.count; });
      var data = JSON.stringify({ lang: lang, generatedAt: new Date().toISOString(), total: items.length, items: items }, null, 2);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'i18n-missing-' + lang + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      return items.length;
    },
    stats: function () {
      return {
        lang: lang,
        translatedNodes: stats.translated,
        passes: stats.passes,
        misses: stats.misses,
        distinctMissing: missing.size,
        dictionaries: order.length,
        started: started
      };
    },
    _flush: flush,
    stop: stop
  };

  window.I18N = API;

  if (document.readyState === 'complete') boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
