/**
 * i18n 运行时探针（Chrome DevTools Protocol）
 * ---------------------------------------------------------------
 * 用无头 Edge 打开真实页面，执行任意 JS 表达式并回收控制台错误。
 * 排查「词条明明有、界面上却没变」这类问题，以及回归时确认没有报错。
 *
 * 用法：
 *   node tools/i18n-probe.mjs --eval="I18N.stats()"
 *   node tools/i18n-probe.mjs --eval="I18N.t('Iron Golem × (')"
 *   node tools/i18n-probe.mjs --eval="document.title" --url="http://127.0.0.1:8123/index.html?lang=zh-CN"
 *   node tools/i18n-probe.mjs --eval="[...document.querySelectorAll('div')].map(d=>d.textContent).filter(t=>/Iron Golem/.test(t))"
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const URL_TARGET = arg('url', 'http://127.0.0.1:8123/index.html?lang=zh-CN');
const EXPR = arg('eval', 'I18N.stats()');
const WAIT_MS = Number(arg('wait', '4000'));
const PORT = 9333 + Math.floor(Math.random() * 200);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

if (!EDGE) { console.error('未找到 Edge/Chrome'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-probe-'));
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
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
    } else if (msg.method) {
      events.push(msg);
    }
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

try {
  const wsUrl = await getTarget();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const client = rpc(ws);

  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Page.enable');

  const saveFile = arg('save', '');
  if (saveFile) {
    const saveJson = fs.readFileSync(path.resolve(saveFile), 'utf8');
    await client.send('Page.navigate', { url: URL_TARGET });
    await sleep(4000);
    await client.send('Runtime.evaluate', {
      expression: `localStorage.setItem('GameSave', ${JSON.stringify(saveJson)}); localStorage.removeItem('GameSaveOff'); 'ok'`,
      returnByValue: true,
    });
  }

  await client.send('Page.navigate', { url: URL_TARGET });
  await sleep(WAIT_MS);

  // 可选：把一份脚本（例如油猴脚本）注入页面执行，用于联调
  const injectFile = arg('inject', '');
  if (injectFile) {
    const code = fs.readFileSync(path.resolve(injectFile), 'utf8');
    await client.send('Runtime.evaluate', { expression: code, returnByValue: false });
    await sleep(1500);
  }

  const result = await client.send('Runtime.evaluate', {
    expression: EXPR,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result?.value;
  console.log('—— 表达式结果 ——');
  console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));

  const outFile = arg('out', '');
  if (outFile && typeof value === 'string') {
    const out = path.resolve(outFile);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, value, 'utf8');
    console.log(`\n已写入：${out}（${value.length} 字符）`);
  }

  const shot = arg('shot', '');
  if (shot) {
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const cap = await client.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(shot);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(cap.data, 'base64'));
    console.log(`\n截图：${out}`);
  }

  const errors = client.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => e.params.entry.text);
  const exceptions = client.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);

  const all = [...errors, ...exceptions].filter((t) => !/QQBrowser|task_manager|PostClientToServerMessage/.test(t));
  console.log(`\n—— 控制台错误（${all.length}）——`);
  all.slice(0, 6).forEach((t) => console.log(' ! ' + t.split('\n').slice(0, 6).join('\n    ')));

  ws.close();
} finally {
  child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
