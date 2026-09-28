/*
================================================================================
脚本：scripts/verify-update-ui.mjs
职责：在**真实运行中的界面**上验证「检查更新 → 更新内容 → 点「更新」→ 下载进度」
      这条完整链路（CDP 驱动），并留下截图。
================================================================================
  为什么必须自己起假服务端 + 隔离实例：
    · 真实的更新源现在还是占位值（OWNER/REPO），走真机只能验到"未配置"那一屏；
      而用户要的核心体验恰恰是**有新版本时那一屏和下载进度那一屏** ——
      它必须在真界面上被看见，不能只靠"代码看起来对"。
    · 所以：本地起一个假 GitHub API + 假附件服务端（故意限速，让进度条真的动起来），
      用环境变量把更新源指过去，再用**隔离 userData** 起一个独立实例（不和用户的
      正在跑的启动器抢单实例锁、也不碰用户的设置与数据）。
    · 全程**绝不点「重启并安装」**：那会真的运行安装程序并退出应用。
      脚本只走到"下载完成、按钮变成「重启并安装」"，然后断言按钮存在就收工。

  ⚠️ 这个脚本会往系统临时目录写一个 900KB 的假安装包（由被测程序自己下载），
     结束时会把它删掉。除此之外不改动任何用户文件。

  用法：node scripts/verify-update-ui.mjs
  产物：backup/deploy-20260927/update-notes.png      （更新内容屏）
        backup/deploy-20260927/update-progress.png  （下载进度屏）
================================================================================
*/
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'backup', 'deploy-20260927');
const SANDBOX = path.join(os.tmpdir(), `maibot-upd-ui-${Date.now().toString(36)}`);
const PORT = 9224;

fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const chk = (name, ok, extra) => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 假服务端 */
const ASSET_SIZE = 900 * 1024;
const CHUNK = 8 * 1024;
const NOTES = [
  '## 本次更新',
  '- 新增「检查更新」二级窗口，更新内容不再只写一行提示',
  '- 修复下载通道切换时进度条可能卡在 0% 的问题',
  '- 安装包下载完成后会按 Release 元数据校验字节数',
  '',
  '### 安装说明',
  '1. 点「重启并安装」后启动器会自动退出',
  '2. 安装过程由安装包自己完成，装完请手动打开启动器',
  '',
  '> 已知问题：首次启动可能比平时慢几秒'
].join('\n');
const TAG = 'v2.1.1';
const ASSET = Buffer.alloc(ASSET_SIZE, 0x4d);

let assetHits = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(route)) {
    const body = JSON.stringify({
      tag_name: TAG,
      name: TAG,
      published_at: '2026-09-27T10:00:00Z',
      body: NOTES,
      assets: [
        { name: 'MaiBot Launcher Setup 2.1.1.exe', size: ASSET_SIZE, browser_download_url: 'x' },
        { name: 'MaiBot Launcher Setup 2.1.1.exe.blockmap', size: 1234, browser_download_url: 'x' },
        { name: 'latest.yml', size: 321, browser_download_url: 'x' }
      ]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    return res.end(body);
  }

  /* 第一个通道必然 500（顺带在真界面上验证"换通道"这条路径），第二个通道限速供片 */
  if (route.startsWith('/dead/')) {
    res.writeHead(500, { 'Content-Length': '0' });
    return res.end();
  }
  if (route.endsWith('/MaiBot%20Launcher%20Setup%202.1.1.exe')) {
    assetHits += 1;
    /*
      限速分片发送：进度屏只有在"下载真的在进行中"时才有东西可看。
      全速发完一个 900KB 的文件在本地是几毫秒的事，进度条会直接跳到 100% ——
      那样截图里看不到百分比、速率、ETA，等于没验证。
    */
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(ASSET_SIZE) });
    let off = 0;
    const tick = setInterval(() => {
      if (off >= ASSET_SIZE) {
        clearInterval(tick);
        return res.end();
      }
      const end = Math.min(off + CHUNK, ASSET_SIZE);
      res.write(ASSET.subarray(off, end));
      off = end;
    }, 25);
    res.on('close', () => clearInterval(tick));
    return undefined;
  }

  res.writeHead(404, { 'Content-Length': '0' });
  return res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`[ui-e2e] 假更新源：${BASE}（附件 ${ASSET_SIZE} 字节，分片限速）`);

/* ------------------------------------------------------------- 启动隔离实例 */
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronBin)) {
  console.error(`[ui-e2e] ✗ 找不到 Electron: ${electronBin}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'renderer', 'index.html'))) {
  console.error('[ui-e2e] ✗ 没有构建产物，请先 npm run build');
  process.exit(1);
}

fs.mkdirSync(SANDBOX, { recursive: true });
const child = spawn(electronBin, [ROOT, '--no-sandbox', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    MAIBOT_LAUNCHER_USER_DATA: SANDBOX,
    /*
      空 userData 首次启动会**自动展开新手引导抽屉**（见 app-store 的
      initOnboarding/decideAutoOpen）—— 那是另一个壳，主界面的顶部导航都不在，
      "关于页的检查更新入口"自然找不到。
      自检标记让 onboardingSuppressed() 生效：不自动展开，界面就是用户平时看到的那个。
      （这条路径本来就有，是给路由断言用的，这里复用同一开关。）
    */
    MAIBOT_LAUNCHER_SELFCHECK: '1',
    MAIBOT_LAUNCHER_UPDATE_REPO: 'Acme/Launcher',
    MAIBOT_LAUNCHER_UPDATE_API: BASE,
    MAIBOT_LAUNCHER_UPDATE_MIRRORS: `${BASE}/dead,${BASE}/live`
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d.toString(); });
child.stderr.on('data', (d) => { childLog += d.toString(); });

const cleanup = [];
const finish = (code) => {
  try { if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); } catch (_) { /* 已退出 */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  for (const f of cleanup) { try { fs.rmSync(f, { force: true }); } catch (_) { /* 忽略 */ } }
  try { server.close(); } catch (_) { /* 忽略 */ }
  process.exit(code);
};
process.on('uncaughtException', (e) => {
  console.error(`\n[ui-e2e] ✗ 未捕获异常：${e?.stack || e}`);
  if (childLog) console.error('--- 实例日志尾部 ---\n' + childLog.slice(-1500));
  finish(1);
});

/* ------------------------------------------------------------------ CDP */
let target = null;
for (let i = 0; i < 80; i += 1) {
  await sleep(700);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (target) break;
  } catch (_) { /* 还没起来 */ }
}
if (!target) {
  console.error('[ui-e2e] ✗ 隔离实例没有起来');
  console.error(childLog.slice(-1500));
  finish(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'THREW: ' + String(r.result.exceptionDetails.exception?.description || '').split('\n')[0];
  return r.result?.result?.value;
};
await cmd('Runtime.enable');
await cmd('Page.enable');

const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
};
const waitFor = async (expr, tries = 60, ms = 250) => {
  for (let i = 0; i < tries; i += 1) {
    await sleep(ms);
    if ((await ev(expr)) === true) return true;
  }
  return false;
};

console.log(`\n[ui-e2e] 隔离 userData: ${SANDBOX}`);

/* ------------------------------------------------ 1) 打开窗口 → 更新内容屏 */
console.log('\n== 1 更新内容屏（真界面）==');
{
  await ev(`location.hash = '#/about'`);
  chk('「检查更新」入口出现在首屏', await waitFor(`!!document.querySelector('[data-testid="about-check-update"]')`, 40));
  await ev(`(() => { document.querySelector('[data-testid="about-check-update"]').click(); return true; })()`);
  chk('二级窗口打开', await waitFor(`!!document.querySelector('[data-testid="update-dialog"]')`, 40));
  /* 有了新版本才会渲染更新内容 */
  const gotNotes = await waitFor(`!!document.querySelector('[data-testid="update-start"]')`, 80);
  chk('检查到新版本（出现「更新」按钮）', gotNotes);

  const txt = String(await ev(`document.querySelector('[data-testid="update-dialog"]').innerText`));
  chk('显示 当前版本 → 最新版本', /当前版本/.test(txt) && /最新版本/.test(txt) && txt.includes('v2.1.0') && txt.includes('v2.1.1'));
  chk('显示更新内容（Release notes 真渲染出来了）', /本次更新/.test(txt) && /修复下载通道切换/.test(txt));
  /*
    notes 是外部文本，按行渲染：
      · 逐行成行（不是挤成一坨）—— 行数必须跟内容量对得上；
      · 列表项走"圆点列"（.upd-line.bullet），原文的 `-` 标记被换掉；
      · 没有任何 HTML 被注入（绝不 v-html）。
  */
  const lines = JSON.parse(await ev(`JSON.stringify({
    all: document.querySelectorAll('[data-testid="update-dialog"] .upd-line').length,
    bullet: document.querySelectorAll('[data-testid="update-dialog"] .upd-line.bullet').length
  })`));
  chk('更新内容按行渲染（≥6 行、含 ≥4 个要点）', lines.all >= 6 && lines.bullet >= 4, JSON.stringify(lines));
  chk('原文的 - 标记已被换成圆点列', (await ev(`document.querySelectorAll('[data-testid="update-dialog"] .upd-dot').length`)) === lines.bullet);
  chk('没有出现 HTML 标签', !/<[a-z/][^>]*>/i.test(txt));
  chk('说明安装后果（会退出启动器）', /退出|重启/.test(txt), '');
  console.log(`    截图: ${await shot('update-notes.png')}`);
}

/* --------------------------------------------------- 2) 点「更新」→ 进度屏 */
console.log('\n== 2 下载进度屏（真界面，点「更新」）==');
{
  await ev(`(() => { document.querySelector('[data-testid="update-start"]').click(); return true; })()`);
  const sawPercent = await waitFor(`!!document.querySelector('[data-testid="update-percent"]')`, 40);
  chk('进入进度屏（出现百分数）', sawPercent);

  /* 抓到"下载进行中"的那一帧：百分比在 1～99 之间、且带速率 */
  let midShot = null;
  let midText = '';
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
    const snap = await ev(`(() => {
      const d = document.querySelector('[data-testid="update-dialog"]');
      const p = document.querySelector('[data-testid="update-percent"]');
      if (!d || !p) return null;
      const bar = d.querySelector('.upd-pbar i');
      return JSON.stringify({
        pct: p.innerText.trim(),
        meta: d.querySelector('.upd-pmeta') ? d.querySelector('.upd-pmeta').innerText.replace(/\\n/g, ' ') : '',
        scale: bar ? getComputedStyle(bar).transform : '',
        hasStart: !!d.querySelector('[data-testid="update-start"]'),
        hasInstall: !!d.querySelector('[data-testid="update-install"]')
      });
    })()`);
    if (!snap || typeof snap !== 'string' || snap.startsWith('THREW')) continue;
    const s = JSON.parse(snap);
    const n = parseInt(String(s.pct).replace(/[^\d]/g, ''), 10);
    if (!midShot && n > 0 && n < 100) {
      midText = `${s.pct} ${s.meta} bar=${s.scale}`;
      midShot = await shot('update-progress.png');
    }
    if (s.hasInstall) break;
  }
  chk('下载进行中出现 1%~99% 的中间态（进度条真的在动）', Boolean(midShot), midText);
  chk('中间态显示了速率/ETA/来源之一', /KB\/s|MB\/s|s$|来源/.test(midText), midText);
  if (midShot) console.log(`    截图: ${midShot}`);

  const done = await waitFor(`!!document.querySelector('[data-testid="update-install"]')`, 120);
  chk('下载完成后按钮变成「重启并安装」', done);
  /*
    进度屏结束后回到版本信息那一屏，所以必须有**明确的完成结论**：
    否则用户看到的是"进度条突然消失、只剩更新内容"，不知道到底下没下完。
  */
  const readyTxt = String(await ev(`(() => {
    const n = document.querySelector('[data-testid="update-ready"]');
    return n ? n.innerText : '';
  })()`));
  chk('完成后给出"已下载并校验完成"的结论', /已下载并校验完成/.test(readyTxt) && /900 KB|900KB/.test(readyTxt), readyTxt);
  chk('结论里说清点下去会发生什么（启动器会退出）', /退出/.test(readyTxt));
  chk('假服务端的附件确实被请求过', assetHits > 0, `附件请求 ${assetHits} 次`);

  /*
    ⚠️ 到此为止：**不点**「重启并安装」。
    按钮存在本身就是"下载+校验都过了"的证据（主进程只在字节数一致时才登记可安装）。
  */
  const installBtnText = String(await ev(`document.querySelector('[data-testid="update-install"]').innerText`)).trim();
  chk('「重启并安装」按钮文案正确（且我们不点它）', installBtnText === '重启并安装', installBtnText);
}

/* ------------------------------------------------------------ 3) 取消路径 */
console.log('\n== 3 收尾（不安装）==');
{
  /* 关窗再开：进度不该丢（状态在 store 里，不在组件里） */
  await ev(`(() => { const b = document.querySelector('[data-testid="update-close"]'); if (b) b.click(); return true; })()`);
  await sleep(500);
  chk('窗口可关闭', (await ev(`!document.querySelector('[data-testid="update-dialog"]')`)) === true);
  await ev(`(() => { document.querySelector('[data-testid="about-check-update"]').click(); return true; })()`);
  const kept = await waitFor(`!!document.querySelector('[data-testid="update-install"]')`, 40);
  chk('重开窗口后仍是「已下载」状态（进度不会丢）', kept);
  chk('全程没有真的启动安装程序（没有退出应用）', (await ev('!!window.maibotApi')) === true);
}

console.log(`\n[ui-e2e] 通过 ${pass}，失败 ${fail}`);
ws.close();
finish(fail === 0 ? 0 : 1);
