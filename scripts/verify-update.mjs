/*
================================================================================
脚本：scripts/verify-update.mjs
职责：启动器自身「检查更新 / 下载 / 安装」能力的**可重复离线**自测。
================================================================================
  为什么必须离线、且必须自己起 HTTP 服务：
    "下载失败就换下一个通道"最可怕的失败方式不是报错，而是**汇报了一个假的结论** ——
    比如某个通道明明返回了半截文件却算成功、或者全部通道都失败却报 ok:true。
    这类问题只有把服务端行为**钉死**（让第一个通道必然失败、让某个通道少发字节）
    才能断言出来，靠真机网络是撞运气。
    所以这里把 api.github.com 与所有镜像通道都指向 127.0.0.1 上的假服务端。

  小节的执行顺序是有意义的（见 E 的说明）：
    A 纯函数：语义化版本比较（含 2.10.0 > 2.9.0、预发布、构建元数据这些经典坑）
    B 附件挑选：.blockmap / .yml 不能当选，多个 exe 时优先 setup
    C check()：未配置更新源 → 如实报"未配置"，且**不发任何请求**
    D check()：已配置 → 版本比较、更新内容、附件大小都来自真实响应
    E install() 空状态：一次都没下载过时必须拒绝，且不许调用 openPath
    F download()：第一个通道失败（HTTP 500）→ 第二个通道成功，字节数一致
    G download()：所有通道都少发字节 → 判失败（不许把大小不符当成成功）
    H download()：所有通道都不可用 → 逐个通道如实记录原因
    I install()：拒绝临时目录之外的路径、拒绝没下载过的文件（**不真的启动安装程序**）

  全程不下载、不安装、不删除用户的任何东西（只在系统临时目录里写测试文件）。
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** 让断言脚本永远不"崩在半个地方"：异常也走同一套汇总 */
process.on('uncaughtException', (e) => {
  console.error(`\n[verify-update] ✗ 未捕获异常：${e?.stack || e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n[verify-update] ✗ 未处理的 Promise 拒绝：${e?.stack || e}`);
  process.exit(1);
});

/*
  在 require updater.js **之前**把 electron 换成桩。
  为什么必须这样：updater.js 里 `const { app, shell } = require('electron')`，
  而 electron 的 index.js 在 Node 下导出的是**可执行文件路径字符串**（真实
  app/shell 由 Electron 运行时注入），于是 app 会是 undefined，
  app.getVersion() 直接抛 "Cannot read properties of undefined"。
  离线的自测必须能把"主进程服务模块"整个跑起来，所以这里补一个最小实现：
    · app.getVersion() —— 返回 package.json 的 version，语义与 Electron 里一致；
    · shell.openPath() —— **不真的启动任何东西**，只记录被请求的路径，
      这样 install() 的安全闸门（拒绝越界 / 拒绝未下载过的文件）可以在
      不弹安装程序的前提下被完整验证；同时"有没有真的走到启动那一步"
      也变成可断言的（opened.length 必须为 0）。
    · app.quit() —— 直接抛错。测试里绝不允许真的退出应用。
*/
const electronStub = {
  app: {
    getVersion: () => pkg.version,
    quit: () => {
      throw new Error('verify-update 不允许真的退出应用');
    }
  },
  shell: {
    opened: [],
    async openPath(p) {
      electronStub.shell.opened.push(p);
      return '';
    }
  }
};
const Module = require('node:module');
const electronPath = require.resolve('electron', { paths: [ROOT] });
const electronMod = new Module(electronPath, null);
electronMod.filename = electronPath;
electronMod.loaded = true;
electronMod.exports = electronStub;
require.cache[electronPath] = electronMod;

/*
  ⚠️ 接着必须先改 windows（updater.js 在模块加载时解构了 sendToRenderer），
  再 require updater.js —— 否则进度帧会被真的丢给一个不存在的窗口。
  与 scripts/verify-download.mjs 的做法一致。
*/
const windowsMod = require(path.join(ROOT, 'src/main/windows.js'));
const progressFrames = [];
windowsMod.sendToRenderer = (channel, payload) => {
  progressFrames.push({ channel, ...payload });
  return true;
};

const updater = require(path.join(ROOT, 'src/main/services/updater.js'));
const constants = require(path.join(ROOT, 'src/main/constants.js'));

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

/** 安装包正文：确定性内容（不用随机数，失败时好比对） */
const ASSET_SIZE = 900 * 1024;
const ASSET = Buffer.alloc(ASSET_SIZE, 0x4d);
const ASSET_ROUTE_TAIL = '/MaiBot%20Launcher%20Setup%202.1.1.exe';

const NOTES = [
  '## 本次更新',
  '- 修复了下载通道切换时可能卡住的问题',
  '- 新增「检查更新」二级窗口',
  '',
  '### 注意',
  '1. 安装过程会自动退出启动器',
  '2. 安装完成后手动重新打开'
].join('\n');

const TAG = 'v2.1.1';
const CURRENT = `v${pkg.version}`;

/** 各路由的行为由测试用例通过这个开关切换 */
const mode = {
  /** 假 API 的响应状态（200 = 正常） */
  apiStatus: 200,
  /** 附件路由：'ok' | 'half' */
  assetMode: 'ok'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  /* ---- 假 GitHub API（owner/repo 任意，只要是 releases/latest） ---- */
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(route)) {
    if (mode.apiStatus !== 200) {
      res.writeHead(mode.apiStatus, { 'Content-Length': '0' });
      return res.end();
    }
    const body = JSON.stringify({
      tag_name: TAG,
      name: TAG,
      published_at: '2026-09-27T10:00:00Z',
      body: NOTES,
      assets: [
        {
          name: 'MaiBot Launcher Setup 2.1.1.exe',
          size: ASSET_SIZE,
          browser_download_url: 'http://127.0.0.1/assets/installer.exe'
        },
        /* 元数据附件：必须被 pickAsset 排除掉 */
        { name: 'MaiBot Launcher Setup 2.1.1.exe.blockmap', size: 1234, browser_download_url: 'x' },
        { name: 'latest.yml', size: 321, browser_download_url: 'x' }
      ]
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body))
    });
    return res.end(body);
  }

  /*
    让某些通道必然失败（用来验证回退与"逐个通道记录原因"）。
    ⚠️ 这两条**必须排在附件路由之前**：失败通道的前缀后面同样挂着附件路径，
    放到后面会被附件路由先接住 → "必然失败"的通道反而成功了，
    于是"回退""全部失败"两个用例会以**假成功**的形式静默失效。
  */
  if (route.startsWith('/fail500/')) {
    res.writeHead(500, { 'Content-Length': '0' });
    return res.end();
  }
  if (route.startsWith('/nope/')) {
    res.writeHead(404, { 'Content-Length': '0' });
    return res.end();
  }

  /* ---- 附件路由 ----
     必须按"路径末尾是不是这个文件名"来判，不能写死一条 /assets/... 的路径：
     真实通道的用法是「通道前缀 + 原始 GitHub 地址直接拼起来」，所以路径长这样：
       /c1/https://github.com/Acme/Launcher/releases/download/v2.1.1/MaiBot%20Launcher%20Setup%202.1.1.exe
     写死前缀的假服务端会一律回 404 —— 于是"回退到第二个通道成功"这条根本
     测不到，而且会**看起来像是回退逻辑坏了**（典型的假失败）。 */
  if (route.endsWith(ASSET_ROUTE_TAIL) || route.endsWith('/assets/installer.exe')) {
    if (mode.assetMode === 'half') {
      /* 故意少发 4096 字节：模拟"镜像缓存了半截包" */
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(ASSET.subarray(0, ASSET_SIZE - 4096));
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(ASSET_SIZE)
    });
    return res.end(ASSET);
  }

  res.writeHead(404, { 'Content-Length': '0' });
  return res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

/* 让 check() 走本地假 API；让下载通道全部指向本地假服务端 */
process.env.MAIBOT_LAUNCHER_UPDATE_API = BASE;
/*
  用一个**非占位**的假仓库名。
  不能图省事写 OWNER/REPO：那正好等于 constants.js 里的占位值，
  updateConfigured() 会（正确地）判成"未配置"，后面所有网络分支都跑不到。
*/
process.env.MAIBOT_LAUNCHER_UPDATE_REPO = 'Acme/Launcher';

/** 切换下载通道（顺序即"按顺序尝试"的顺序） */
function setChannels(list) {
  process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = list.join(',');
}
/** 所有通道都指向假服务端的同一条附件路由 */
const localChannels = (n = 2) => Array.from({ length: n }, (_, i) => `${BASE}/c${i}`);

const cleanup = [];
process.on('exit', () => {
  for (const f of cleanup) {
    try {
      fs.rmSync(f, { force: true });
    } catch (_) {
      /* 清不掉不影响结论 */
    }
  }
});

console.log(`[verify-update] 假 API / 假通道：${BASE}`);
console.log(`[verify-update] 当前版本 ${CURRENT}，假 Release ${TAG}，附件 ${ASSET_SIZE} 字节`);

/* ============================================================================
 *  A 语义化版本比较
 * ========================================================================== */
section('A 语义化版本比较（compareVersions）');
{
  const cases = [
    ['v2.1.1', 'v2.1.0', 1, '补丁号更大'],
    ['v2.1.0', '2.1.0', 0, 'v 前缀不影响相等'],
    ['2.10.0', '2.9.0', 1, '2.10.0 必须大于 2.9.0（字符串比较会判反）'],
    ['v3.0.0', 'v2.99.99', 1, '主版本优先'],
    ['1.0.0-beta.1', '1.0.0', -1, '预发布小于正式版'],
    ['1.0.0-beta.2', '1.0.0-beta.1', 1, '预发布序号递增'],
    ['2.1', '2.1.0', 0, '缺省段按 0 处理'],
    ['2.1.0', '2.1.1', -1, '反向比较'],
    ['v2.1.0+abc', '2.1.0', 0, '构建元数据不参与比较']
  ];
  for (const [a, b, want, why] of cases) {
    const got = updater.compareVersions(a, b);
    chk(`${a} vs ${b} → ${want}`, got === want, `实际 ${got}（${why}）`);
  }
  chk('无法解析的版本返回 NaN（不许猜）', Number.isNaN(updater.compareVersions('latest', '2.1.0')));
  const parsed = updater.parseVersion('v2.10.3-rc.1');
  chk(
    'parseVersion 解析 v2.10.3-rc.1',
    parsed &&
      parsed.major === 2 &&
      parsed.minor === 10 &&
      parsed.patch === 3 &&
      parsed.pre.join('.') === 'rc.1',
    JSON.stringify(parsed)
  );
}

/* ============================================================================
 *  B 附件挑选
 * ========================================================================== */
section('B 附件挑选（pickAsset）');
{
  const release = {
    tag_name: 'v9.9.9',
    assets: [
      { name: 'notes.txt', size: 10 },
      { name: 'MaiBot Launcher Setup 9.9.9.exe.blockmap', size: 99999 },
      { name: 'latest.yml', size: 88888 },
      { name: 'MaiBot Launcher Setup 9.9.9.exe', size: 55555 },
      { name: 'portable.exe', size: 44444 }
    ]
  };
  const picked = updater.pickAsset(release, 'OWNER', 'REPO');
  chk('挑中 setup exe', picked?.name === 'MaiBot Launcher Setup 9.9.9.exe', picked?.name);
  chk('.blockmap / .yml 被排除', picked?.name !== 'latest.yml' && !/blockmap/.test(picked?.name || ''));
  chk(
    '附件地址由 owner/repo/tag 自行拼（不信任 API 字段）',
    picked?.url ===
      'https://github.com/OWNER/REPO/releases/download/v9.9.9/MaiBot%20Launcher%20Setup%209.9.9.exe',
    picked?.url
  );
  chk('没有可用附件时返回 null', updater.pickAsset({ assets: [{ name: 'a.yml', size: 1 }] }, 'o', 'r') === null);
}

/* ============================================================================
 *  C 未配置更新源：如实返回，且不发请求
 * ========================================================================== */
section('C 未配置更新源（占位值）');
{
  /* 临时把常量改回占位值，验证"未配置"这条分支不会假装成功 */
  const savedOwner = constants.UPDATE.owner;
  const savedRepo = constants.UPDATE.repo;
  constants.UPDATE.owner = 'OWNER';
  constants.UPDATE.repo = 'REPO';
  delete process.env.MAIBOT_LAUNCHER_UPDATE_REPO;

  chk('updateConfigured() 认得出占位值', updater.updateConfigured() === false);
  const r = await updater.check();
  chk('ok=false 且 configured=false', r.ok === false && r.configured === false, `ok=${r.ok} configured=${r.configured}`);
  chk('hasUpdate 不得为真', r.hasUpdate === false);
  chk('message 明确说"未配置更新源"', /未配置更新源/.test(r.message), r.message.slice(0, 60) + '…');

  constants.UPDATE.owner = savedOwner;
  constants.UPDATE.repo = savedRepo;
  /*
    换一个**非占位**的仓库名。判据是 owner/repo 整体是否就是 OWNER/REPO，
    所以真实 owner 完全可能叫 xxx-OWNER —— 不能把子串当占位。
  */
  process.env.MAIBOT_LAUNCHER_UPDATE_REPO = 'Acme/Launcher-Fork';
  chk('填好之后 updateConfigured() 为真', updater.updateConfigured() === true);
  /* 回到假服务端会响应的那个假仓库名（路由不挑名字，这里只是保持一致） */
  process.env.MAIBOT_LAUNCHER_UPDATE_REPO = 'Acme/Launcher';
}

/* ============================================================================
 *  D check()：真实响应 → 版本比较与更新内容
 * ========================================================================== */
section('D check()（本地假 API）');
{
  mode.apiStatus = 200;
  const r = await updater.check();
  chk('ok:true 且 configured:true', r.ok === true && r.configured === true);
  chk('current 来自 app.getVersion()', r.current === pkg.version, `${r.current}`);
  chk('latest 来自 tag_name', r.latest === TAG, r.latest);
  chk('hasUpdate:true（2.1.1 > 2.1.0）', r.hasUpdate === true);
  chk('notes 原样带出（供界面按行渲染）', r.notes.includes('修复了下载通道切换'), `长度 ${r.notes.length}`);
  chk('asset 大小来自 Release 元数据', r.asset?.size === ASSET_SIZE, String(r.asset?.size));
  chk('asset 名字是 setup exe', /Setup/.test(r.asset?.name || ''), r.asset?.name);

  /* 假 API 返回 404 时必须是可操作的报错，而不是笼统一句"网络错误" */
  mode.apiStatus = 404;
  const r404 = await updater.check();
  chk('HTTP 404 → 说明仓库/发布不存在', r404.ok === false && /不存在/.test(r404.message), r404.message);
  mode.apiStatus = 200;
}

/* ============================================================================
 *  E install() 空状态
 * --------------------------------------------------------------------------
 *  这一段**必须排在第一个成功下载之前**执行：install 的准入依据是
 *  "本会话下载过"，一旦前面有任何一次下载成功，install({dest:''}) 就会
 *  退回"记得的那个包"（这是刻意的设计），空状态便再也测不到 ——
 *  而且失败方式很难看：测试自己会去 shell.openPath（真的弹出安装程序）。
 * ========================================================================== */
section('E install() 空状态（尚未下载任何安装包）');
{
  const never = await updater.install({ dest: '' });
  chk('没有下载记录时给出可操作提示', never.ok === false && /先点「更新」/.test(never.message), never.message);
  chk('空状态下不许声称会退出应用', never.willQuit !== true);
  chk('空状态下没有调用过 openPath', electronStub.shell.opened.length === 0,
    `openPath 调用次数=${electronStub.shell.opened.length}`);
}

/* ============================================================================
 *  F 通道回退：第一个失败 → 第二个成功
 * ========================================================================== */
section('F 通道回退（第一个通道 500 → 第二个成功）');
{
  mode.assetMode = 'ok';
  setChannels([`${BASE}/fail500`, `${BASE}/c1`]);
  progressFrames.length = 0;

  const r = await updater.download();
  chk('下载成功', r.ok === true, (r.message || '').split('\n')[0]);
  chk('最终字节数与 Release 元数据一致', r.bytes === ASSET_SIZE, `${r.bytes}/${ASSET_SIZE}`);
  /* 结果里的 channel 是完整通道标识（进度帧里才是短主机名） */
  chk('来源通道是第二个', r.channel === `${BASE}/c1` && /\/c1\//.test(r.url || ''), `${r.channel} ← ${r.url}`);
  chk(
    '第一个通道的原因被如实记录',
    r.attempts?.length === 1 && /HTTP 500/.test(r.attempts[0].message),
    JSON.stringify(r.attempts)
  );
  const doneSize = r.dest && fs.existsSync(r.dest) ? fs.statSync(r.dest).size : -1;
  chk('落盘文件大小正确', doneSize === ASSET_SIZE, `${doneSize} 字节`);
  if (r.dest) cleanup.push(r.dest);

  const phases = progressFrames.map((f) => f.phase);
  chk(
    '进度帧顺序包含 start → progress → verify → done',
    phases.includes('start') && phases.includes('progress') && phases.includes('verify') && phases[phases.length - 1] === 'done',
    phases.join(',')
  );
  const last = progressFrames[progressFrames.length - 1];
  chk(
    'done 帧 percent=100 且带来源',
    Boolean(last) && last.percent === 100 && !!last.channel,
    last ? JSON.stringify({ percent: last.percent, channel: last.channel, received: last.received }) : '(没有进度帧)'
  );
  const mid = progressFrames.find((f) => f.phase === 'progress');
  chk(
    'progress 帧有真实字节数、总大小与速率',
    Boolean(mid) && mid.received > 0 && mid.total === ASSET_SIZE && mid.bytesPerSec > 0,
    mid
      ? `received=${mid.received} total=${mid.total} ${Math.round(mid.bytesPerSec / 1024)}KB/s eta=${mid.etaSec}s`
      : '(没有 progress 帧)'
  );

  /* 下载记录：install 的准入依据 */
  const st = updater.downloadState();
  chk('登记了可安装记录', st?.dest === r.dest && st.expectedSize === ASSET_SIZE, JSON.stringify(st));
}

/* ============================================================================
 *  G 字节数不符 → 必须失败
 * ========================================================================== */
section('G 字节数不符（所有通道都少发 4096 字节）');
{
  mode.assetMode = 'half';
  setChannels(localChannels(3));
  progressFrames.length = 0;

  const r = await updater.download();
  chk('判为失败（不许把大小不符当成功）', r.ok === false, (r.message || '').split('\n')[0]);
  chk('三个通道都被试过', r.attempts?.length === 3);
  chk(
    '原因里写明字节数不符',
    r.attempts.every((a) => /字节数不符/.test(a.message)),
    '\n    ' + r.attempts.map((a) => `· ${a.message}`).join('\n    ')
  );
  chk('失败帧是 error 且带 message', progressFrames.some((f) => f.phase === 'error' && /字节数不符/.test(f.message || '')));
  /*
    半截文件必须被删掉：留着的话下一次"下载成功"的故事里就混进了一个
    上一次的残骸，用户会拿到一个装不上的包。
  */
  const leftover = path.join(os.tmpdir(), 'maibot-launcher-update', 'MaiBot Launcher Setup 2.1.1.exe');
  chk('半截文件已从磁盘删除', !fs.existsSync(leftover), leftover);
  mode.assetMode = 'ok';
}

/* ============================================================================
 *  H 全部通道不可用 → 逐个通道如实记录原因
 * ========================================================================== */
section('H 全部通道不可用（HTTP 404 / 连不上）');
{
  setChannels([`${BASE}/nope`, 'https://127.0.0.1:1/unreachable']);
  const r = await updater.download();
  chk('判为失败', r.ok === false);
  chk('两条通道各有原因', r.attempts?.length === 2, JSON.stringify(r.attempts?.map((a) => a.message)));
  chk(
    '报告里逐条列出通道名与原因',
    /·\s/.test(r.message) && r.attempts.every((a) => r.message.includes(a.channel)),
    r.message.replace(/\n/g, ' | ')
  );
}

/* ============================================================================
 *  I install() 的安全闸门（不真的启动任何安装程序）
 * ========================================================================== */
section('I install() 拒绝越界（不启动安装程序）');
{
  /*
    ⚠️ 真实的"启动安装程序并退出启动器"这一条**刻意不测**：
    它会真的执行一个 .exe 并让进程退出，属于用户明确禁止的动作。
    所以这里只验证两道拒绝闸门 —— 它们恰好是"不能出错"的那部分：
    install() 最终会调用 shell.openPath（用系统默认方式打开一个 exe），
    参数一旦能由渲染层自由指定，就等于开了一条"执行任意程序"的通道。
    桩里的 openPath 会记录被请求的路径，所以"有没有真的走到启动那一步"
    也是可断言的（opened.length 必须保持 0）。
  */
  mode.assetMode = 'ok';
  setChannels(localChannels(1));
  const dl = await updater.download();
  if (dl.dest) cleanup.push(dl.dest);

  const outside = await updater.install({ dest: 'C:\\Windows\\System32\\calc.exe' });
  chk('拒绝临时目录之外的路径', outside.ok === false && /拒绝启动/.test(outside.message), outside.message);

  const unknown = await updater.install({ dest: path.join(os.tmpdir(), 'someone-else.exe') });
  chk('拒绝未下载过的文件', unknown.ok === false && /拒绝/.test(unknown.message), unknown.message);

  /*
    附件类型闸门：Release 里挂的可能不是安装程序（.zip / .7z）。
    shell.openPath 对压缩包就是"打开压缩软件" —— 启动器随后退出，用户却什么都没装上。
    所以这里必须拒绝，而且理由要指向"Release 里的附件不对"。
  */
  const notInstaller = await updater.install({
    dest: path.join(os.tmpdir(), 'maibot-launcher-update', 'MaiBot-2.1.1-portable.7z')
  });
  chk(
    '拒绝非安装程序附件（.7z 不许当安装包打开）',
    notInstaller.ok === false && /不是安装程序/.test(notInstaller.message),
    notInstaller.message
  );

  chk('全程没有真的启动任何程序', electronStub.shell.opened.length === 0,
    `openPath 调用次数=${electronStub.shell.opened.length}`);
}

/* ============================================================================
 *  附：全部通道失败的原始输出（汇报用原文，不转述）
 * ========================================================================== */
section('附：全部通道失败的原始输出');
{
  setChannels([`${BASE}/fail500`, `${BASE}/nope`]);
  const r = await updater.download();
  console.log(`ok=${r.ok}`);
  console.log(`message:\n${r.message}`);
  console.log(`attempts:\n${JSON.stringify(r.attempts, null, 2)}`);
}

/* ============================================================================
 *  汇总
 * ========================================================================== */
await new Promise((r) => server.close(r));
console.log(`\n[verify-update] 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
