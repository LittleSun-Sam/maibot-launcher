/*
================================================================================
脚本：scripts/verify-update-net.mjs
职责：断言 updater.js 的 HTTP 传输层**真的**改成了 node:http/https 原生实现，
      且这次改造没有把原有的超时/重定向/错误原因上报语义弄丢。
================================================================================
  为什么必须单独一个脚本（而不是并进 verify-update.mjs）：
    这件事的核心主张是"**不再使用全局 fetch**" —— 而"没有用某样东西"这件事
    没法靠读代码断言。所以这里做两件在别的脚本里做不到的事：

    1) 在 require updater.js 之前把 **globalThis.fetch 换成会抛错的桩**，
       再跑真实请求。只要实现里还残留一处全局 fetch，桩就会立刻炸出来；
       全部走 node:http/https 时，一切照常工作。这是"绕开 Chromium 网络栈
       （证书吊销检查失败导致 fetch failed）"这个修复真正要证明的东西。
    2) 断言重定向被跟随（GitHub 与各加速通道都会 302）、
       状态码与真实原因被如实上报、请求头超时生效。

  全程只连 127.0.0.1 上的本地假服务端，不碰真实网络、不写用户文件。
================================================================================
*/
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

process.on('uncaughtException', (e) => {
  console.error(`\n[verify-update-net] ✗ 未捕获异常：${e?.stack || e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n[verify-update-net] ✗ 未处理的 Promise 拒绝：${e?.stack || e}`);
  process.exit(1);
});

/*
  ⚠️ 顺序很重要：**先**把全局 fetch 打成桩，**再** require updater.js。
  桩刻意抛出一条不可能与网络错误混淆的信息，方便失败时一眼看出
  "是哪一条路径又用回了 fetch"。

  Electron 也要打桩（原因同 verify-update.mjs：Node 下 require('electron')
  拿到的是可执行文件路径字符串，app/shell 会是 undefined）。
*/
globalThis.fetch = () => {
  throw new Error('[verify-update-net] 实现里仍有全局 fetch 调用（本次修复要求全部走 node:http/https）');
};
globalThis.AbortSignal.timeout = () => {
  throw new Error('[verify-update-net] 实现里仍在使用 AbortSignal.timeout（应改为 node:http/https 的请求超时）');
};

const electronStub = {
  app: { getVersion: () => pkg.version, quit: () => { throw new Error('不允许退出应用'); } },
  shell: { async openPath() { return ''; } }
};
const Module = require('node:module');
const electronPath = require.resolve('electron', { paths: [ROOT] });
const electronMod = new Module(electronPath, null);
electronMod.filename = electronPath;
electronMod.loaded = true;
electronMod.exports = electronStub;
require.cache[electronPath] = electronMod;

const windowsMod = require(path.join(ROOT, 'src/main/windows.js'));
const progressFrames = [];
windowsMod.sendToRenderer = (channel, payload) => {
  progressFrames.push({ channel, ...payload });
  return true;
};

const updater = require(path.join(ROOT, 'src/main/services/updater.js'));

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
const section = (t) => console.log(`\n== ${t} ==`);

/* ------------------------------------------------------------- 假服务端夹具 */

const ASSET_SIZE = 512 * 1024;
const ASSET = Buffer.alloc(ASSET_SIZE, 0x6e);
const TAG = 'v9.9.9';
const NOTES = '## 假更新说明\n- 用于 verify-update-net';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  /* 重定向链：/r1 → /r2 → /r3 → 最终资源。
     每一跳都是 302，用来证明"重定向真的会被跟随"（而不是只跟一跳）。 */
  if (route === '/r1') {
    res.writeHead(302, { Location: '/r2' });
    return res.end();
  }
  if (route === '/r2') {
    res.writeHead(302, { Location: '/r3' });
    return res.end();
  }
  /* 相对跳转（Location 不带 host），GitHub 也会这么干 */
  if (route === '/r3') {
    res.writeHead(302, { Location: '/api/repos/LittleSun-Sam/maibot-launcher/releases/latest' });
    return res.end();
  }
  /* 无限重定向：必须被 MAX_REDIRECTS 拦住，不能挂到天荒地老 */
  if (route === '/loop') {
    res.writeHead(302, { Location: '/loop' });
    return res.end();
  }
  /* 发了响应头就再也不发正文：必须在超时后如实报"请求超时" */
  if (route === '/stall') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '9999' });
    res.write('{');
    return; /* 故意不 end() */
  }

  if (/^\/api\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(route)) {
    /* /api 前缀版本（重定向终点）：与 /repos 同体 */
    const body = JSON.stringify({
      tag_name: TAG,
      name: TAG,
      published_at: '2026-09-27T10:00:00Z',
      body: NOTES,
      assets: [{ name: 'MaiBot Launcher Setup 9.9.9.exe', size: ASSET_SIZE }]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    return res.end(body);
  }
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(route)) {
    const body = JSON.stringify({
      tag_name: TAG,
      name: TAG,
      published_at: '2026-09-27T10:00:00Z',
      body: NOTES,
      assets: [
        { name: 'MaiBot Launcher Setup 9.9.9.exe', size: ASSET_SIZE },
        { name: 'MaiBot Launcher Setup 9.9.9.exe.blockmap', size: 999 }
      ]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    return res.end(body);
  }
  if (route.startsWith('/fail500/')) {
    res.writeHead(500, { 'StatusText': 'x', 'Content-Length': '0' });
    return res.end();
  }
  if (route.startsWith('/redir302/')) {
    /* 通道把附件 302 到真正的存储地址（GitHub 与各加速通道都会这样） */
    res.writeHead(302, { Location: `/asset${route.slice('/redir302'.length)}` });
    return res.end();
  }
  if (route.endsWith('/MaiBot%20Launcher%20Setup%209.9.9.exe') || route === '/asset/installer.exe') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(ASSET_SIZE) });
    return res.end(ASSET);
  }
  res.writeHead(404, { 'Content-Length': '0' });
  return res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.MAIBOT_LAUNCHER_UPDATE_REPO = 'Acme/Launcher';
process.env.MAIBOT_LAUNCHER_UPDATE_API = `${BASE}/api`;

console.log(`[verify-update-net] 假服务端：${BASE}`);
console.log('[verify-update-net] 全局 fetch 已被替换为"一调用就抛错"的桩');

/* ============================================================================
 *  A 传输层本身：不走 fetch、跟重定向、报真实状态
 * ========================================================================== */
section('A 传输层（requestBuffer / rawRequest）');
{
  const r = await updater.requestBuffer(`${BASE}/repos/Acme/Launcher/releases/latest`);
  chk('普通 GET 返回 200 且正文完整', r.status === 200 && JSON.parse(r.body).tag_name === TAG);
  chk('响应头可按小写键取用', r.headers['content-type'] === 'application/json', String(r.headers['content-type']));

  const redir = await updater.requestBuffer(`${BASE}/r1`);
  chk('连续 3 跳 302（含相对 Location）全部跟随', redir.status === 200 && JSON.parse(redir.body).tag_name === TAG);

  const notFound = await updater.requestBuffer(`${BASE}/nope`);
  chk('404 走 resolve（调用方拿得到真实状态码）', notFound.status === 404, `status=${notFound.status}`);

  let loopErr = null;
  try {
    await updater.requestBuffer(`${BASE}/loop`);
  } catch (e) {
    loopErr = e;
  }
  chk('无限重定向被 MAX_REDIRECTS 拦住', Boolean(loopErr) && /重定向次数过多/.test(loopErr.message),
    loopErr?.message || '(没有抛错)');

  const t0 = Date.now();
  let timeErr = null;
  try {
    await updater.requestBuffer(`${BASE}/stall`, { timeoutMs: 1200 });
  } catch (e) {
    timeErr = e;
  }
  const waited = Date.now() - t0;
  chk('服务端只发响应头不发正文 → 超时止损', Boolean(timeErr) && timeErr.name === 'TimeoutError',
    `${timeErr?.name} / ${waited}ms`);
  chk('超时耗时确实受 timeoutMs 约束（未拖到 15s）', waited < 6000, `${waited}ms`);
}

/* ============================================================================
 *  B check()：在"全局 fetch 一调用就抛"的环境里跑通真实请求
 * ========================================================================== */
section('B check()（全局 fetch 被禁用的情况下）');
{
  const r = await updater.check();
  chk('ok:true（证明没有走全局 fetch）', r.ok === true, r.message);
  chk('latest 来自真实响应体', r.latest === TAG, r.latest);
  chk('hasUpdate 正确（9.9.9 > 2.1.0）', r.hasUpdate === true);
  chk('notes 原样带出', r.notes === NOTES, JSON.stringify(r.notes));
  chk('asset.size 来自 Release 元数据', r.asset?.size === ASSET_SIZE, String(r.asset?.size));

  /* 真实错误原因必须上报，且带着 URL（不许笼统一句"网络错误"） */
  process.env.MAIBOT_LAUNCHER_UPDATE_API = 'http://127.0.0.1:1';
  const down = await updater.check();
  chk('连不上时 ok:false / reason:network', down.ok === false && down.reason === 'network', down.message);
  chk('错误信息里带真实原因与 URL', /127\.0\.0\.1:1/.test(down.message) && /连接更新服务器失败/.test(down.message),
    down.message);
  process.env.MAIBOT_LAUNCHER_UPDATE_API = `${BASE}/api`;
}

/* ============================================================================
 *  C download()：重定向 + 字节校验 + 通道回退，全部不碰 fetch
 * ========================================================================== */
section('C download()（302 通道 → 字节数校验）');
{
  /* 通道前缀本身返回 302，最终落到 /asset/... —— GitHub 的真实形态 */
  process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = `${BASE}/redir302,${BASE}`;
  progressFrames.length = 0;
  const r = await updater.download();
  chk('下载成功（302 被跟随）', r.ok === true, (r.message || '').split('\n')[0]);
  chk('字节数与 Release 元数据一致', r.bytes === ASSET_SIZE, `${r.bytes}/${ASSET_SIZE}`);
  chk('来源通道是第一个（带 302 的那个）', /redir302/.test(r.channel || ''), String(r.channel));
  if (r.dest) {
    chk('落盘文件大小正确', fs.statSync(r.dest).size === ASSET_SIZE);
    fs.rmSync(r.dest, { force: true });
  }
  const phases = progressFrames.map((f) => f.phase);
  chk('进度帧仍有 start → progress → verify → done',
    phases.includes('start') && phases.includes('progress') && phases.includes('verify') && phases.at(-1) === 'done',
    phases.join(','));

  /* 全部通道失败时逐条记录真实原因 */
  process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = `${BASE}/fail500,http://127.0.0.1:1`;
  const bad = await updater.download();
  chk('全通道失败 → ok:false', bad.ok === false);
  chk('第一个通道原因是真实 HTTP 500', /HTTP 500/.test(bad.attempts?.[0]?.message || ''), JSON.stringify(bad.attempts?.[0]));
  chk('第二个通道原因是真实连接错误（非空且不是笼统话术）',
    Boolean(bad.attempts?.[1]?.message) && bad.attempts[1].message.length > 3,
    JSON.stringify(bad.attempts?.[1]?.message || ''));
  chk('报告里逐条列出通道名与原因', bad.attempts.every((a) => bad.message.includes(a.channel)));
}

/* ============================================================================
 *  D 取消：必须真的销毁底层请求（不能"信号 abort 了但还在下"）
 * ========================================================================== */
section('D download() 取消路径');
{
  const slow = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (route.endsWith('.exe')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(50 * 1024 * 1024) });
      /* 只发 64KB，然后一直挂着：模拟"下到一半用户点取消" */
      res.write(Buffer.alloc(64 * 1024, 1));
      return;
    }
    /* 检查更新的假响应（download() 没给 asset 时会先走 check()） */
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      tag_name: TAG,
      body: NOTES,
      assets: [{ name: 'MaiBot Launcher Setup 9.9.9.exe', size: 50 * 1024 * 1024 }]
    }));
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const SLOW = `http://127.0.0.1:${slow.address().port}`;
  process.env.MAIBOT_LAUNCHER_UPDATE_API = SLOW;
  process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = SLOW;

  const t0 = Date.now();
  /*
    显式给 asset：这样 download() 不会先走一次 check()，
    也就绝不会去碰真正的 github.com（本脚本必须全程离线）。
  */
  const task = updater.download({
    asset: { name: 'MaiBot Launcher Setup 9.9.9.exe', size: 50 * 1024 * 1024, url: `${SLOW}/installer.exe` }
  });
  setTimeout(() => updater.cancel(), 400);
  const r = await task;
  const waited = Date.now() - t0;
  chk('取消后下载判失败/取消', r.ok === false && r.canceled === true, JSON.stringify({ ok: r.ok, canceled: r.canceled, message: r.message }));
  chk('取消是及时生效的（远早于 stallMs 45s）', waited < 10000, `${waited}ms`);
  chk('取消原因如实（不伪装成网络失败）', /取消/.test(r.message || ''), String(r.message));

  /* 取消之后再取消：必须如实说"当前没有进行中的下载" */
  chk('无进行中的任务时 cancel 如实返回', updater.cancel().ok === false);

  process.env.MAIBOT_LAUNCHER_UPDATE_API = `${BASE}/api`;
  process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = `${BASE}/redir302,${BASE}`;
  await new Promise((r2) => slow.close(r2));
}

/* ============================================================================
 *  E 静态断言：实现文件里不许再出现全局 fetch / net.request
 * ========================================================================== */
section('E 实现文件静态断言');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main/services/updater.js'), 'utf8');
  /* 去掉注释再断言，避免把说明文字里的 "fetch" 当成调用 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  chk('代码里没有裸 fetch( 调用', !/(^|[^.\w])fetch\s*\(/.test(code));
  chk('代码里没有 net.request', !/net\.request/.test(code));
  chk('代码里没有 rejectUnauthorized / ignore-certificate-errors',
    !/rejectUnauthorized|ignore-certificate-errors|NODE_TLS_REJECT_UNAUTHORIZED/i.test(code));
  chk('用了 node 原生 http/https', /require\('https'\)/.test(code) && /require\('http'\)/.test(code));
}

await new Promise((r) => server.close(r));
console.log(`\n[verify-update-net] 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
