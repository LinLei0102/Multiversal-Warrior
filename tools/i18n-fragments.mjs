/**
 * 静态碎片扫描（补运行时巡检的盲区）
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   运行时巡检只能看到「已经渲染到 DOM 的文本」。像装备、宝物、药水这类
 *   需要先拥有实物才会出现在界面上的名字，用毕业存档也伪造不出来，
 *   收集器和 DOM 扫描都看不到。这一层只能从源码里静态抽取。
 *
 * 做法：
 *   扫描 fullRevamp.js 里所有模板字符串，把 ${...} 换成占位符，
 *   再取标签之间的文字——这正好等于浏览器最终生成的文本节点内容。
 *   另外单独处理「模板开头就是文字、紧跟 <span>」的碎片
 *   （例如 `Slime multiplies Essence ×<span>…`）。
 *
 * 用法：
 *   node tools/i18n-fragments.mjs           # 列表
 *   node tools/i18n-fragments.mjs --todo    # 输出可粘贴的空词条
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODO = process.argv.includes('--todo');

/* ------------------------------------------------------------- 载入词典 */

const localeFile = path.join(ROOT, 'i18n', 'locales', 'zh-CN.js');
let dict = null;
vm.runInNewContext(fs.readFileSync(localeFile, 'utf8'), {
  window: { I18N: { register: (_c, d) => { dict = d; } } },
  console: { warn() {}, info() {}, log() {} },
}, { filename: localeFile });

const norm = (s) => String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// 与引擎一致的解析：先词条，再模式，%n 递归
function resolve(text, depth = 4) {
  const key = norm(text);
  if (!key) return null;
  const w = dict.words[key];
  if (w != null) return w;
  if (depth <= 0) return null;

  for (const [re, rep] of dict.patterns) {
    const m = key.match(re);
    if (!m) continue;
    const args = m.slice(1);
    if (rep.indexOf('%') >= 0 || rep.indexOf('$') >= 0) {
      return rep
        .replace(/\$(\d)/g, (_, i) => (args[+i - 1] == null ? '' : args[+i - 1]))
        .replace(/%(\d)/g, (_, i) => {
          const v = args[+i - 1];
          if (v == null) return '';
          const r = resolve(v, depth - 1);
          return r == null ? v : r;
        });
    }
    return rep;
  }
  return null;
}

/* ------------------------------------------------------------------ 扫描 */

const src = fs.readFileSync(path.join(ROOT, 'fullRevamp.js'), 'utf8');
const missing = new Map();

function consider(raw) {
  const text = raw.replace(/&nbsp;?/g, ' ').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 3) return;
  if (!/[A-Za-z]{3}/.test(text)) return;
  if (/^[\d.,eE+\-×/()%° ]+$/.test(text)) return;       // 纯数值
  if (/^(content|c2_|fp\d|IUniversal|_)/.test(text)) return;
  if (resolve(text) != null) return;
  missing.set(text, (missing.get(text) || 0) + 1);
}

const literalRe = /`((?:[^`\\]|\\.)*)`/g;
let m;
while ((m = literalRe.exec(src))) {
  // 插值换成占位符，保留标签结构
  let s = m[1].replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '0');

  // 1) 标签之间的文字 = 真实文本节点
  const tagRe = />([^<>]+)</g;
  let t;
  while ((t = tagRe.exec(s))) consider(t[1]);

  // 2) 模板以文字开头、紧跟 <span> 的碎片（不会命中上面的规则）
  if (!s.trimStart().startsWith('<')) {
    const head = s.split('<')[0];
    if (head && /[A-Za-z]{3}/.test(head) && head.trim().endsWith('×')) consider(head);
    else if (head && /[A-Za-z]{3}/.test(head) && /[A-Za-z]\s+$/.test(head)) consider(head);
  }
}

const list = [...missing.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

console.log(`词典：${Object.keys(dict.words).length} 词条 / ${dict.patterns.length} 模式`);
console.log(`静态扫描发现未翻译文本：${list.length} 条\n`);

if (TODO) {
  for (const [text] of list) console.log(`      ${JSON.stringify(text)}: '',`);
} else {
  for (const [text, count] of list) console.log(`${String(count).padStart(3)}  ${text}`);
}

fs.mkdirSync(path.join(ROOT, 'i18n', '_build'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'i18n', '_build', 'fragments.json'),
  JSON.stringify(list.map(([text, count]) => ({ text, count })), null, 2),
  'utf8'
);
