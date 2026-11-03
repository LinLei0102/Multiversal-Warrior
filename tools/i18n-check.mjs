/**
 * i18n 覆盖率 / 回归检查
 * ---------------------------------------------------------------
 * 用无头浏览器渲染真实页面，统计「界面上仍然是英文」的文本，
 * 用于汉化进度验收，以及每次同步上游后的回归检查。
 *
 * 用法：
 *   node tools/i18n-check.mjs                     # 默认 http://127.0.0.1:8123/index.html?lang=zh-CN
 *   node tools/i18n-check.mjs --url="http://127.0.0.1:8123/index.html?lang=zh-CN&i18nDebug=1"
 *   node tools/i18n-check.mjs --file=i18n/_build/dom-zh.html   # 分析已保存的 DOM 快照
 *   node tools/i18n-check.mjs --todo              # 输出可直接粘贴进词典的待办清单
 *
 * 依赖：本机 Edge（Windows 自带），无需安装 Playwright。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'i18n', '_build');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const URL_TARGET = arg('url', 'http://127.0.0.1:8123/index.html?lang=zh-CN');
const FILE_TARGET = arg('file', '');
const DUMP_OUT = path.join(BUILD, 'dom-zh.html');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

/* ------------------------------------------------------------- 载入词典 */

function loadDictionary(locale = 'zh-CN') {
  const file = path.join(ROOT, 'i18n', 'locales', `${locale}.js`);
  const code = fs.readFileSync(file, 'utf8');
  let captured = null;
  const sandbox = {
    window: { I18N: { register: (_c, d) => { captured = d; } } },
    console: { warn() {}, info() {}, log() {} },
  };
  vm.runInNewContext(code, sandbox, { filename: file });
  if (!captured) throw new Error('词典未能注册，检查 locales 文件是否调用了 I18N.register');

  const norm = (s) => String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const words = new Map();
  for (const [k, v] of Object.entries(captured.words || {})) words.set(norm(k), v);
  const patterns = (captured.patterns || []).map(([re, rep]) => [re instanceof RegExp ? re : new RegExp(re), rep]);
  return { words, patterns, norm };
}

/* --------------------------------------------------------------- 取 DOM */

function dumpDom(url) {
  const browser = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome，无法渲染页面');
  fs.mkdirSync(BUILD, { recursive: true });
  const html = execFileSync(browser, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=15000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(DUMP_OUT, html, 'utf8');
  return html;
}

/* --------------------------------------------------------------- 分析 */

const { words, patterns, norm } = loadDictionary();

const html = FILE_TARGET
  ? fs.readFileSync(path.resolve(ROOT, FILE_TARGET), 'utf8')
  : dumpDom(URL_TARGET);

// 只统计 <body> 内的可见文本，忽略脚本
const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
const body = (bodyMatch ? bodyMatch[1] : html).replace(/<script[\s\S]*?<\/script>/gi, ' ');

const untranslated = new Map();
const re = />([^<>]+)</g;
let m;
while ((m = re.exec(body))) {
  const raw = m[1].replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, '');
  const text = norm(raw);
  if (!text || text.length > 120) continue;
  if (!/[A-Za-z]{2}/.test(text)) continue;
  if (words.has(text)) continue;
  if (patterns.some(([re2]) => re2.test(text))) continue;
  untranslated.set(text, (untranslated.get(text) || 0) + 1);
}

const list = [...untranslated.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

console.log(`词典词条：${words.size}    动态模式：${patterns.length}`);
console.log(`页面来源：${FILE_TARGET || URL_TARGET}`);
console.log(`仍是英文的文本：${list.length} 条\n`);

if (hasFlag('todo')) {
  for (const [text] of list) console.log(`      '${text.replace(/'/g, "\\'")}': '',`);
} else {
  for (const [text, count] of list.slice(0, 40)) console.log(`${String(count).padStart(3)}  ${text}`);
  if (list.length > 40) console.log(`... 另有 ${list.length - 40} 条，用 --todo 输出完整待办`);
}

fs.writeFileSync(path.join(BUILD, 'untranslated.json'), JSON.stringify(list.map(([text, count]) => ({ text, count })), null, 2), 'utf8');
console.log(`\n明细：${path.relative(ROOT, path.join(BUILD, 'untranslated.json'))}`);
