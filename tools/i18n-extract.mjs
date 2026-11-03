/**
 * i18n 候选字符串抽取器
 * ---------------------------------------------------------------
 * 从 index.html 与 fullRevamp.js 中抽取「可能出现在界面上的英文文案」，
 * 供人工翻译 / 与词典做覆盖率比对。
 *
 * 用法：
 *   node tools/i18n-extract.mjs            # 抽取 → i18n/_build/candidates.json + 控制台统计
 *   node tools/i18n-extract.mjs --missing  # 只列出「已抽取但词典里没有」的文案
 *   node tools/i18n-extract.mjs --json     # 仅输出 JSON 到 stdout
 *
 * 设计原则：不改上游文件，只读。抽取结果只是「候选」，允许有噪声，
 * 真正的准绳是运行时未翻译收集器（window.I18N.exportMissing()）。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'i18n', '_build');

const args = new Set(process.argv.slice(2));
const ONLY_MISSING = args.has('--missing');
const JSON_ONLY = args.has('--json');

/* ---------------------------------------------------------------- 归一化 */

export function normalize(text) {
  return String(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------- 质量判定 */

// 明显属于代码/样式/路径的片段
const CODE_NOISE = [
  /\b(function|return|const|let|var|class|new|import|export|window|document|this|typeof|undefined|null)\b/,
  /\b(addEventListener|querySelector|getElementById|setTimeout|requestAnimationFrame|classList)\b/,
  /^[a-z0-9]+([_-][a-z0-9]+)+$/i,             // kebab-case / snake_case 标识符
  /^[a-z]+[A-Z][A-Za-z0-9]*$/,                // camelCase 变量名
  /^[A-Za-z0-9_\-/\\]+\.(js|mjs|css|png|jpg|jpeg|webp|svg|json|html|txt)$/i,
  /^[^{}]*\(\)\s*(\{|=>)/,                    // 函数签名残影
  /^(rgba?|hsla?)\(/i,
  /\$\{/,                                     // 残留插值
  /[<>{};`$\\|^~]/,                           // 代码字符
  /^[A-Za-z]$/,                               // 单字母
];

// 允许的字符集：字母、数字、空格、常用标点
const ALLOWED = /^[\w\s.,:;!?'"()\-+%/=×÷°·…—–\[\]&@#*]*$/;

// 纯技术词汇：CSS 属性、HTML 标签名、布尔字面量等
const TECH_WORDS = new Set([
  'opacity', 'draggable', 'size', 'width', 'height', 'color', 'display', 'position',
  'transform', 'filter', 'cursor', 'top', 'left', 'right', 'bottom', 'margin', 'padding',
  'div', 'span', 'true', 'false', 'none', 'auto', 'num', 'key', 'drag', 'item', 'items',
  'source', 'level', 'uni', 'equipment', 'expedition', 'potion', 'inventory', 'unlocked',
  'elemental', 'soul', 'content', 'text', 'title', 'value', 'name', 'class', 'style',
]);

// 至少 2 个连续拉丁字母，且字母占比不至于太低
function looksLikeCopy(s) {
  if (!s) return false;
  if (s.length < 2 || s.length > 160) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (CODE_NOISE.some((re) => re.test(s))) return false;
  if (!ALLOWED.test(s)) return false;

  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters / s.length < 0.45) return false;

  // 纯小写单词多为对象键 / CSS 值，界面文案一般是首字母大写或全大写
  if (/^[a-z][a-z']*$/.test(s)) return false;
  if (TECH_WORDS.has(s.toLowerCase())) return false;

  // 不含空格却混着数字，基本是 id / 类名（content2_6_、height100、1vw）
  if (/\d/.test(s) && !/\s/.test(s)) return false;

  return true;
}

/* ------------------------------------------------------- 文本归一化去重 */

const candidates = new Map(); // normalized text -> { count, sources: Set }

function addCandidate(raw, source) {
  const text = normalize(raw);
  if (!looksLikeCopy(text)) return;
  const hit = candidates.get(text);
  if (hit) {
    hit.count += 1;
    hit.sources.add(source);
  } else {
    candidates.set(text, { count: 1, sources: new Set([source]) });
  }
}

/* ------------------------------------------------------------ index.html */

function extractFromHtml(html) {
  let src = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  // 标签之间的纯文本
  const re = />([^<>]+)</g;
  let m;
  while ((m = re.exec(src))) addCandidate(m[1], 'index.html');
}

/* -------------------------------------------------------- fullRevamp.js */

function extractFromJs(code) {
  // 抓取字符串字面量（含模板字符串的静态片段）
  const re = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(code))) {
    const raw = m[2];
    if (raw.length > 400) continue;

    // 模板字符串里可能夹着 HTML：先取 >文本< 的部分，再整体判断
    if (/[<>]/.test(raw)) {
      const tagText = /<[^>]*>([^<>]+)</g;
      let t;
      while ((t = tagText.exec(raw))) addCandidate(t[1], 'fullRevamp.js');
      continue;
    }
    addCandidate(raw, 'fullRevamp.js');
  }
}

/* ------------------------------------------------------------------ 词典 */

function loadDictionaryKeys() {
  const file = path.join(ROOT, 'i18n', 'locales', 'zh-CN.js');
  if (!fs.existsSync(file)) return { words: new Set(), patterns: 0 };

  // 用沙箱真正执行词典文件，避免正则解析被转义引号干扰
  let captured = null;
  const sandbox = {
    window: { I18N: { register: (_c, d) => { captured = d; } } },
    console: { warn() {}, info() {}, log() {} },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  if (!captured) return { words: new Set(), patterns: 0 };

  const words = new Set(Object.keys(captured.words || {}).map(normalize));
  return { words, patterns: (captured.patterns || []).length };
}

/* ------------------------------------------------------------------ main */

const files = {
  'index.html': fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'),
  'fullRevamp.js': fs.readFileSync(path.join(ROOT, 'fullRevamp.js'), 'utf8'),
};

extractFromHtml(files['index.html']);
extractFromJs(files['fullRevamp.js']);

const dict = loadDictionaryKeys();
const all = [...candidates.entries()]
  .map(([text, meta]) => ({ text, count: meta.count, sources: [...meta.sources] }))
  .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

const missing = all.filter((c) => !dict.words.has(c.text));

if (JSON_ONLY) {
  console.log(JSON.stringify({ total: all.length, missing: missing.length, items: ONLY_MISSING ? missing : all }, null, 2));
  process.exit(0);
}

if (ONLY_MISSING) {
  console.log(`未翻译候选：${missing.length} / ${all.length}\n`);
  for (const c of missing) console.log(`${String(c.count).padStart(4)}  ${c.text}`);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'candidates.json');
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), total: all.length, missing: missing.length, items: all }, null, 2), 'utf8');

console.log(`抽取候选文案：${all.length} 条`);
console.log(`词典已有：${dict.words.size} 条（其中可能含未被抽取器识别的运行时文案）`);
console.log(`尚缺翻译：${missing.length} 条`);
console.log(`输出：${path.relative(ROOT, outFile)}`);
