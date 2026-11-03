/**
 * 汉化覆盖巡检（毕业存档自动旅游）
 * ---------------------------------------------------------------
 * 注入「毕业存档」→ 逐个点开全部页签 → 收集界面上仍未翻译的文本。
 * 用于在没时间真玩到后期时，也能把后期界面全部扫一遍。
 *
 * 用法：
 *   node tools/i18n-tour.mjs                                  # 注入 saves/graduation.json 并巡检
 *   node tools/i18n-tour.mjs --save=saves/graduation.json
 *   node tools/i18n-tour.mjs --keep                           # 保留浏览器配置目录，便于手工接着看
 *   node tools/i18n-tour.mjs --out=i18n/_build/tour.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (n) => process.argv.slice(2).includes(`--${n}`);

const SAVE_PATH = path.resolve(ROOT, arg('save', 'saves/graduation.json'));
const OUT = path.resolve(ROOT, arg('out', 'i18n/_build/tour.json'));
const PORT = 8200 + Math.floor(Math.random() * 400);   // 避开 Windows 预留端口段（9560-9659 等）
const BASE_URL = arg('url', 'http://127.0.0.1:8123/index.html?lang=zh-CN');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge/Chrome'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-tour-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 等待启动 */ }
    await sleep(250);
  }
  throw new Error('无法连接调试端口');
}

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  return {
    send(method, params = {}) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    events,
  };
}

const evaluate = (client, expression) => client.send('Runtime.evaluate', {
  expression, returnByValue: true, awaitPromise: true,
}).then((r) => r.result?.value);

let client;
try {
  const ws = new WebSocket(await targetUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  client = rpc(ws);
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Page.enable');

  // 1. 先打开一次页面，把毕业存档塞进 localStorage
  await client.send('Page.navigate', { url: BASE_URL });
  await sleep(5000);

  const saveJson = fs.readFileSync(SAVE_PATH, 'utf8');
  await evaluate(client, `(() => {
    localStorage.setItem('GameSave', ${JSON.stringify(saveJson)});
    localStorage.removeItem('GameSaveOff');
    localStorage.setItem('mw.i18n.lang', 'zh-CN');
    return 'stored';
  })()`);

  // 2. 重载，让游戏读档
  await client.send('Page.navigate', { url: BASE_URL });
  await sleep(9000);

  const loaded = await evaluate(client, `(() => {
    const t = document.body.innerText;
    return { chars: t.length, head: t.slice(0, 120).replace(/\\s+/g, ' ') };
  })()`);
  console.log('读档后页面文本量：', loaded.chars, '字符');
  console.log('开头：', loaded.head);

  await evaluate(client, `I18N.collectMissing(true)`);

  // 3. 逐个点开页签（含主页面切换与山内各面板）
  const tabs = await evaluate(client, `(() => {
    const ids = [];
    document.querySelectorAll('[id^="fp2_content2_"][id$="_container"], #fp2_content1_8, #fp2_achievements, #fp2_content2_5, #fp2_content2_pageSel, #fp2_content3_pageSel')
      .forEach(el => { if (el.id && !el.id.endsWith('_image')) ids.push(el.id); });
    return [...new Set(ids)];
  })()`);

  const visited = [];
  for (const id of tabs) {
    const res = await evaluate(client, `(async () => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return { id: ${JSON.stringify(id)}, ok: false };
      const btn = el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el);
      btn.click();
      await new Promise(r => setTimeout(r, 650));
      return { id: ${JSON.stringify(id)}, ok: true };
    })()`);
    visited.push(res);
  }

  await sleep(1500);

  // 4. 结果：只统计「可见/已渲染」的文本即可，隐藏面板的内容同样会被扫到
  const report = await evaluate(client, `(() => {
    const missing = I18N.getMissing();
    const stats = I18N.stats();

    // 二次校验：直接扫 DOM，找出「翻译后仍含拉丁字母」的文本节点。
    // 有些碎片会被部分翻译（例如只替换了括号），收集器不会把它记为未命中，这里能兜住。
    const residual = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      if (!v || !/[A-Za-z]{3,}/.test(v)) continue;
      if (!node.parentElement) continue;
      if (node.parentElement.closest('[data-i18n-skip]')) continue;
      const tag = node.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      residual.push(v.replace(/\\s+/g, ' ').trim().slice(0, 90));
    }

    const panels = [...document.querySelectorAll('[id^="fp2_content2_"][id$="_container"]')].map(el => ({
      id: el.id,
      visible: getComputedStyle(el).display !== 'none',
      chars: el.innerText ? el.innerText.trim().length : 0,
    }));
    return { missing, stats, panels, residual: [...new Set(residual)] };
  })()`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), save: SAVE_PATH, report, visited }, null, 2), 'utf8');

  console.log(`\n页签数量：${tabs.length}`);
  console.log(`已翻译节点：${report.stats.translatedNodes}，未命中：${report.stats.misses}`);
  console.log(`收集器记录的未翻译：${report.missing.length} 条`);
  report.missing.slice(0, 20).forEach((m) => console.log(`  ${String(m.count).padStart(4)}  ${m.text}`));

  console.log(`\nDOM 残留英文文本：${report.residual.length} 条`);
  report.residual.slice(0, 30).forEach((t) => console.log('  · ' + t));
  console.log(`\n明细：${path.relative(ROOT, OUT)}`);

  const errors = client.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => (e.params.exceptionDetails.exception?.description || '').split('\n')[0])
    .filter(Boolean);
  console.log(`\n页面异常：${errors.length} 条`);
  errors.slice(0, 5).forEach((t) => console.log(' ! ' + t));
} finally {
  child.kill();
  if (!has('keep')) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  } else {
    console.log(`浏览器配置保留：${profile}`);
  }
}
