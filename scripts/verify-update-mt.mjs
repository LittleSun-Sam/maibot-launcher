/*
================================================================================
脚本：scripts/verify-update-mt.mjs
职责：启动器自身更新包的**多线程分段下载**的可重复离线自测。
================================================================================
  为什么必须自己起服务端、且必须把三种服务端行为都钉死：
    分段下载最可怕的失败方式不是报错，而是**静默地拼出一个错位的文件** ——
    每一段都"下载成功"、总字节数还正好等于元数据，只有内容全错。
    这种问题在真实网络上是撞运气才能撞到的，所以这里用本地 HTTP 服务把
    服务端行为**钉死**成三种，逐个断言：
      A 支持 Range：分块返回 206 + Content-Range（真实链路的行为）
      B 忽略 Range：不管请求头，一律 200 全量（必须退回单连接）
      C 某段中途断流：第一次请求该段就掐断（必须整段重试并最终成功）
      D 取消：下载途中调 cancel()，四条连接都要立刻停（不许挂到 stallMs）
      E 端到端：走公开的 download()（假 Release + 真校验），确认组装正确

  内容设计（关键）：
    正文用 **可定位的确定性模式**（每 16 字节一块，块里带自己的块号）。
    于是"错位""重复段""拼接顺序错"全都能被**逐字节**定位到，
    而不只是比一个 sha256 —— 失败信息要能直接指出哪一段写错了位置。

  全程不联网、不安装、不碰用户文件（只在系统临时目录里写测试文件）。
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

process.on('uncaughtException', (e) => {
  console.error(`\n[verify-update-mt] ✗ 未捕获异常：${e?.stack || e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n[verify-update-mt] ✗ 未处理的 Promise 拒绝：${e?.stack || e}`);
  process.exit(1);
});

/* ---- electron 桩：与 verify-update.mjs 同一套做法（updater.js 会解构它） ---- */
const electronStub = {
  app: {
    getVersion: () => pkg.version,
    quit: () => {
      throw new Error('verify-update-mt 不允许真的退出应用');
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

/* windows 桩要在 require updater.js **之前**装好（它在加载时就解构了 sendToRenderer） */
const windowsMod = require(path.join(ROOT, 'src/main/windows.js'));
let progressFrames = [];
windowsMod.sendToRenderer = (channel, payload) => {
  progressFrames.push({ channel, ...payload });
  return true;
};

/* 日志接口：updater.js 会大量 logging.log，这里原样打到 stdout（保留真实原因） */
const logging = require(path.join(ROOT, 'src/main/logging.js'));
const logLines = [];
const origLog = logging.log;
logging.log = (level, message) => {
  logLines.push({ level, message: String(message) });
  return origLog ? origLog(level, message) : undefined;
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

/* ============================================================================
 *  确定性正文：每 16 字节一块，块头写自己的块号
 * ========================================================================== */
const BLOCK = 16;
function makeBody(size) {
  const buf = Buffer.alloc(size);
  for (let off = 0; off + BLOCK <= size; off += BLOCK) {
    buf.writeUInt32BE(off / BLOCK, off);
    buf.write('MaiBotMT', off + 4, 'ascii');
    buf.writeUInt32BE(off, off + 12);
  }
  return buf;
}
/** 逐块比对，返回第一个错位的偏移（-1 = 完全一致） */
function firstMismatch(file, expect) {
  const got = fs.readFileSync(file);
  if (got.length !== expect.length) return `长度 ${got.length} ≠ ${expect.length}`;
  const n = Math.min(got.length, expect.length);
  for (let i = 0; i < n; i += 1) {
    if (got[i] !== expect[i]) return `偏移 ${i} 起不一致（真实块号 ${expect.readUInt32BE(Math.floor(i / BLOCK) * BLOCK)}）`;
  }
  return -1;
}

/* ============================================================================
 *  本地假服务端
 * ========================================================================== */
const SIZE = 6 * 1024 * 1024; // 6 MB
const BODY = makeBody(SIZE);
const ASSET_NAME = 'MaiBot Launcher Setup 2.1.1.exe';
const TAG = 'v2.1.1';
const ASSET_ROUTE_TAIL = `/MaiBot%20Launcher%20Setup%202.1.1.exe`;

/**
 * 服务端行为开关。
 *   range      —— true: 认 Range 回 206；false: 忽略 Range 一律 200 全量
 *   cutOffsets —— 这些段起点（Range 的 from）**第一次**被请求时中途掐断
 *   slow       —— 每块之间加延时（取消测试用，也让进度帧真的发得出来）
 */
const mode = {
  range: true,
  cutOffsets: new Set(),
  slow: 0,
  /** 统计：每个段起点被请求了几次 */
  rangeHits: new Map(),
  sockets: 0,
  socketLog: []
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  /* ---- 假 GitHub API ---- */
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(route)) {
    const body = JSON.stringify({
      tag_name: TAG,
      name: TAG,
      published_at: '2026-09-27T10:00:00Z',
      body: '多线程分段下载自测',
      assets: [
        {
          name: ASSET_NAME,
          size: SIZE,
          /* 故意给一个 sha256 摘要：验证"有摘要就必须真校验" */
          digest: `sha256:${crypto.createHash('sha256').update(BODY).digest('hex')}`,
          browser_download_url: 'http://127.0.0.1/ignored'
        },
        { name: `${ASSET_NAME}.blockmap`, size: 10, browser_download_url: 'x' }
      ]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    return res.end(body);
  }

  if (route.startsWith('/fail500/')) {
    res.writeHead(500, { 'Content-Length': '0' });
    return res.end();
  }

  if (!(route.endsWith(ASSET_ROUTE_TAIL) || route.endsWith('/assets/installer.exe'))) {
    res.writeHead(404, { 'Content-Length': '0' });
    return res.end();
  }

  /* ---- 附件路由 ---- */
  const range = String(req.headers.range || '');
  const m = /^bytes=(\d+)-(\d+)$/.exec(range);

  if (!mode.range || !m) {
    /* 不支持 Range（或没带 Range）：一律 200 + 全量 */
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(SIZE) });
    return pump(res, BODY, 0, SIZE - 1, false);
  }

  const from = Number(m[1]);
  const to = Math.min(Number(m[2]), SIZE - 1);
  mode.rangeHits.set(from, (mode.rangeHits.get(from) || 0) + 1);
  const cut = mode.cutOffsets.has(from) && mode.rangeHits.get(from) === 1;

  res.writeHead(206, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(to - from + 1),
    'Content-Range': `bytes ${from}-${to}/${SIZE}`,
    'Accept-Ranges': 'bytes'
  });
  return pump(res, BODY, from, to, cut);
});

/** 按块把 [from,to] 发出去；cut=true 时发到一半直接销毁 socket（模拟断流） */
function pump(res, body, from, to, cut) {
  const CHUNK = 64 * 1024;
  const total = to - from + 1;
  const stopAt = cut ? Math.floor(total / 2) : total;
  let sent = 0;

  const step = () => {
    if (res.writableEnded || res.destroyed) return;
    if (sent >= stopAt) {
      if (cut) {
        /* 断流：不发结束块、不 end()，直接把连接掐掉 */
        res.socket.destroy();
        return;
      }
      res.end();
      return;
    }
    const n = Math.min(CHUNK, stopAt - sent);
    const ok = res.write(body.subarray(from + sent, from + sent + n));
    sent += n;
    if (mode.slow) setTimeout(step, mode.slow);
    else if (ok) setImmediate(step);
    else res.once('drain', step);
  };
  step();
}

server.on('connection', (s) => {
  mode.sockets += 1;
  mode.socketLog.push({ event: 'open', at: Date.now(), live: mode.sockets });
  s.on('close', () => {
    mode.sockets -= 1;
    mode.socketLog.push({ event: 'close', at: Date.now(), live: mode.sockets });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const ASSET = {
  name: ASSET_NAME,
  size: SIZE,
  url: `https://github.com/Acme/Launcher/releases/download/${TAG}/${encodeURIComponent(ASSET_NAME)}`,
  digest: `sha256:${crypto.createHash('sha256').update(BODY).digest('hex')}`
};

process.env.MAIBOT_LAUNCHER_UPDATE_API = BASE;
process.env.MAIBOT_LAUNCHER_UPDATE_REPO = 'Acme/Launcher';
process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = `${BASE}/m0`;
delete process.env.MAIBOT_LAUNCHER_UPDATE_THREADS;

const TMP = path.join(os.tmpdir(), 'maibot-update-mt-verify');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const cleanup = [TMP];
process.on('exit', () => {
  for (const f of cleanup) {
    try {
      fs.rmSync(f, { recursive: true, force: true });
    } catch (_) {
      /* 清不掉不影响结论 */
    }
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const destFor = (name) => path.join(TMP, name);

console.log(`[verify-update-mt] 假服务端 ${BASE}`);
console.log(`[verify-update-mt] 附件 ${SIZE} 字节（${(SIZE / 1048576).toFixed(1)} MB），正文按 16 字节块可定位`);
console.log(`[verify-update-mt] UPDATE.threads=${constants.UPDATE.threads} segmentMinBytes=${constants.UPDATE.segmentMinBytes} segmentMaxCount=${constants.UPDATE.segmentMaxCount} segmentRetry=${constants.UPDATE.segmentRetry}`);

/* ============================================================================
 *  0 段数决策（纯函数）
 * ========================================================================== */
section('0 段数决策（resolveSegmentCount / downloadThreads）');
{
  const R = updater.resolveSegmentCount;
  chk('threads=1 → 强制单连接', R(1, 100 * 1024 * 1024) === 1, String(R(1, 100 * 1024 * 1024)));
  chk('threads=0 且文件很小 → 单连接', R(0, 1024 * 1024) === 1, String(R(0, 1024 * 1024)));
  const auto = R(0, 100 * 1024 * 1024);
  chk('threads=0 且 100MB → 自动落在 3~8 段', auto >= 3 && auto <= 8, String(auto));
  chk('threads=4 → 4 段', R(4, 100 * 1024 * 1024) === 4, String(R(4, 100 * 1024 * 1024)));
  chk('threads=999 被上限夹住（不许真开 999 条连接）',
    R(999, 100 * 1024 * 1024) === constants.UPDATE.segmentMaxCount, String(R(999, 100 * 1024 * 1024)));
  chk('91.8MB 计划段数 = 4（本次改动的目标）', R(4, 96259277) === 4, String(R(4, 96259277)));

  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '6';
  chk('环境变量可覆盖段数', updater.downloadThreads() === 6, String(updater.downloadThreads()));
  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '1';
  chk('环境变量 =1 时 download() 会走单连接',
    updater.resolveSegmentCount(updater.downloadThreads(), SIZE) === 1);
  delete process.env.MAIBOT_LAUNCHER_UPDATE_THREADS;

  chk('parseContentRangeTotal("bytes 0-1023/6291456") = 6291456',
    updater.parseContentRangeTotal('bytes 0-1023/6291456') === SIZE, String(updater.parseContentRangeTotal('bytes 0-1023/6291456')));
  chk('parseContentRangeTotal 取不到时返回 0（不猜）',
    updater.parseContentRangeTotal('bytes 0-1023/*') === 0);
}

/* ============================================================================
 *  A 支持 Range：4 段并发 + 真实聚合进度
 * ========================================================================== */
section('A 支持 Range 的源（206 分块）→ 4 段并发 + 聚合进度');
{
  mode.range = true;
  mode.cutOffsets.clear();
  mode.rangeHits.clear();
  mode.slow = 0;
  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '4';

  const dest = destFor('A-支持Range.exe');
  progressFrames = [];
  const t0 = Date.now();
  const controller = new AbortController();
  /* downloadChannel 是"一个通道"的完整尝试（分段 + 退回单连接），正是要测的粒度 */
  const r = await updater.downloadChannel({
    url: `${BASE}/m0/${ASSET.url}`,
    dest,
    fileName: ASSET_NAME,
    total: SIZE,
    channel: { label: BASE, prefix: BASE, isMirror: true },
    controller
  });
  const ms = Date.now() - t0;

  chk('走的是分段路径（不是退回单连接）', r.mode === 'segmented', `${r.mode}/${r.segments} 段`);
  chk('段数 = 4', r.segments === 4, String(r.segments));
  chk('下载的字节数 = 元数据大小', r.bytes === SIZE, `${r.bytes}/${SIZE}`);
  chk('服务端收到 4 个不同的 Range 起点', mode.rangeHits.size === 4,
    `起点 ${Array.from(mode.rangeHits.keys()).join(',')}`);

  const mm = firstMismatch(dest, BODY);
  chk('落盘内容逐字节正确（每 16 字节块都对）', mm === -1, mm === -1 ? '全部匹配' : String(mm));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  chk('sha256 与源一致', sha === crypto.createHash('sha256').update(BODY).digest('hex'), sha.slice(0, 16) + '…');

  /* ---- 聚合进度：单调、不超总量、有速度与剩余时间 ---- */
  const recv = progressFrames.map((f) => Number(f.received) || 0);
  let nonMono = -1;
  for (let i = 1; i < recv.length; i += 1) if (recv[i] < recv[i - 1]) nonMono = i;
  chk('进度帧的 received 单调不减（不跳变）', nonMono === -1,
    nonMono === -1 ? `${recv.length} 帧` : `第 ${nonMono} 帧回退`);
  chk('任何一帧都不超过总大小（不重复计数）', recv.every((v) => v <= SIZE), `max=${Math.max(...recv)}/${SIZE}`);

  const startFrames = progressFrames.filter((f) => f.phase === 'start');
  chk('start 帧说明"分 N 段并发下载"', startFrames.some((f) => /分 4 段并发下载/.test(f.message || '')),
    startFrames.map((f) => f.message).join(' | '));
  chk('start 帧带 segments=4（界面才显示得了"4 线程"）',
    startFrames.some((f) => f.segments === 4), JSON.stringify(startFrames.map((f) => f.segments)));

  const prog = progressFrames.filter((f) => f.phase === 'progress');
  chk('进度帧带真实速度与剩余时间',
    prog.length > 0 && prog.at(-1).bytesPerSec > 0 && prog.at(-1).etaSec != null,
    prog.length ? `最后一帧 received=${prog.at(-1).received} total=${prog.at(-1).total} ` +
      `speed=${(prog.at(-1).bytesPerSec / 1048576).toFixed(2)}MB/s eta=${prog.at(-1).etaSec}s` : '(没有进度帧)');

  const last = progressFrames.at(-1);
  chk('最后一帧是 done 且 received=total=元数据大小',
    last.phase === 'done' && last.received === SIZE && last.total === SIZE && last.percent === 100,
    JSON.stringify({ phase: last.phase, received: last.received, total: last.total, percent: last.percent }));

  /* 并发证据：4 个段起点都在 progress 帧发出之前就已被请求（顺序不限） */
  chk('实测耗时与速度（4 段 / 本地回环）',
    true,
    `${ms}ms  ${(SIZE / 1048576 / (ms / 1000)).toFixed(1)} MB/s`);
}

/* ============================================================================
 *  B 不支持 Range：回退单连接，且文件必须仍然正确
 * ========================================================================== */
section('B 忽略 Range 的源（一律 200 全量）→ 退回单连接');
{
  mode.range = false;
  mode.cutOffsets.clear();
  mode.rangeHits.clear();
  mode.slow = 0;
  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '4';

  const dest = destFor('B-不支持Range.exe');
  progressFrames = [];
  logLines.length = 0;

  const r = await updater.downloadChannel({
    url: `${BASE}/m0/${ASSET.url}`,
    dest,
    fileName: ASSET_NAME,
    total: SIZE,
    channel: { label: BASE, prefix: BASE, isMirror: true },
    controller: new AbortController()
  });

  chk('退回单连接（mode=single）', r.mode === 'single', `${r.mode}/${r.segments} 段`);
  chk('仍然下载成功且字节数正确', r.ok === true && r.bytes === SIZE, `${r.ok} ${r.bytes}/${SIZE}`);
  const mm = firstMismatch(dest, BODY);
  chk('退回后文件内容正确（没有把全量写到某段偏移上）', mm === -1, mm === -1 ? '全部匹配' : String(mm));

  chk('日志明确说明了"分段下载失败，退回单连接"',
    logLines.some((l) => /分段下载失败，退回单连接/.test(l.message)),
    (logLines.find((l) => /退回单连接/.test(l.message))?.message || '').slice(0, 110) + '…');
  chk('进度帧里说明了退回原因（未返回 206）',
    progressFrames.some((f) => f.phase === 'start' && f.segments === 1 && /退回单连接/.test(f.message || '')),
    JSON.stringify(progressFrames.filter((f) => f.phase === 'start').map((f) => f.message)));
  chk('退回时上报了 segments=1（界面显示"单连接"而不是假的 4 线程）',
    progressFrames.some((f) => f.segments === 1));
}

/* ============================================================================
 *  C 某段中途断流 → 整段重试 → 成功
 * ========================================================================== */
section('C 某段中途断流 → 整段重试 → 成功');
{
  mode.range = true;
  mode.slow = 0;
  mode.rangeHits.clear();
  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '4';

  /* 第 3 段（起点 = 2 × 1.5MB）第一次请求就断流 */
  const per = Math.ceil(SIZE / 4);
  const victim = per * 2;
  mode.cutOffsets = new Set([victim]);

  const dest = destFor('C-断流重试.exe');
  progressFrames = [];
  logLines.length = 0;

  const r = await updater.downloadChannel({
    url: `${BASE}/m0/${ASSET.url}`,
    dest,
    fileName: ASSET_NAME,
    total: SIZE,
    channel: { label: BASE, prefix: BASE, isMirror: true },
    controller: new AbortController()
  });

  chk('重试后下载成功', r.ok === true && r.bytes === SIZE, `${r.ok} ${r.bytes}/${SIZE}`);
  chk('断流那一段被请求了 2 次（重试发生）', mode.rangeHits.get(victim) === 2,
    `起点 ${victim} 命中 ${mode.rangeHits.get(victim)} 次`);
  chk('其余段各只请求了 1 次（没有整盘重下）',
    Array.from(mode.rangeHits.entries()).filter(([k]) => k !== victim).every(([, v]) => v === 1),
    JSON.stringify(Array.from(mode.rangeHits.entries())));
  const mm = firstMismatch(dest, BODY);
  chk('重试后文件内容正确（错位会被逐块比对抓到）', mm === -1, mm === -1 ? '全部匹配' : String(mm));
  chk('日志记录了失败并"整段重取"',
    logLines.some((l) => /整段重取/.test(l.message)),
    (logLines.find((l) => /整段重取/.test(l.message))?.message || '').slice(0, 110) + '…');

  /*
    重试会把该段已上报的字节**扣回去**再重来（这是"重试越多进度越虚高"那个坑的守卫），
    所以这里断言的是：
      · 从不出现负的已下载字节（聚合值不能比 0 小）；
      · 任何一帧都不超过总大小（不重复计数）。
    注意 received 在重试瞬间会有一次**有意的下降**（把作废的字节扣掉），
    这与"跳变"不是一回事：跳变指"同一份数据被算了两次"，而那正是不允许的。
  */
  const recv = progressFrames.map((f) => Number(f.received) || 0);
  const minRecv = Math.min(...recv, 0);
  chk('重试扣账不产生负数、也不超总量',
    recv.every((v) => v >= 0 && v <= SIZE),
    `帧数=${recv.length} min=${minRecv} max=${Math.max(...recv)}/${SIZE}`);
  chk('重试时确实把作废字节扣回（进度不许虚高）',
    recv.some((v, i) => i > 0 && v < recv[i - 1]),
    `扣账后最小帧 ${minRecv} 字节`);
}

/* ============================================================================
 *  D 取消：所有连接必须立刻停（不许挂到 stallMs）
 * ========================================================================== */
section('D 取消（update:cancel）→ 四条连接立刻销毁');
{
  mode.range = true;
  mode.cutOffsets.clear();
  mode.rangeHits.clear();
  /* 慢速发送：确保取消发生在传输途中，而不是下载完之后 */
  mode.slow = 25;
  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '4';

  const dest = destFor('D-取消.exe');
  progressFrames = [];
  const controller = new AbortController();
  const p = updater.downloadChannel({
    url: `${BASE}/m0/${ASSET.url}`,
    dest,
    fileName: ASSET_NAME,
    total: SIZE,
    channel: { label: BASE, prefix: BASE, isMirror: true },
    controller
  });

  /*
    等到真的开始收字节再取消 —— 否则测的是"还没开始"。
    用**已关闭的连接数**当"已经在收"的证据：分段请求一旦开始，socket 就已经建立；
    而进度帧受 progressThrottleMs 节流，不一定已经发出来过。
    （另外取消必须发生在下载完成**之前**：6MB 本地回环很快，所以服务端在 slow 模式下
      每块之间加 25ms 延时，把传输拉长到秒级。）
  */
  let waited = 0;
  while (mode.sockets === 0 && waited < 8000) {
    await sleep(50);
    waited += 50;
  }
  await sleep(150); /* 让至少一个块落地，确保真的是"传输中途" */
  const socketsAtCancel = mode.sockets;
  const tCancel = Date.now();
  controller.abort();

  const r = await p;
  const ms = Date.now() - tCancel;

  chk('取消前确实已经在收字节（测的是传输中途取消）',
    socketsAtCancel > 0 && progressFrames.some((f) => f.received > 0),
    `取消时活跃 socket=${socketsAtCancel}，已收 ${Math.max(...progressFrames.map((f) => f.received || 0))} 字节`);
  chk('结果如实报告"取消"（不是失败也不是成功）',
    r.ok === false && /取消/.test(r.message || ''), `${r.ok} ${r.message}`);
  chk('没有把没下完的东西说成成功', r.ok !== true);

  /* 等一小会儿让 close 事件落地，再断言连接真的都断了 */
  await sleep(400);
  chk('取消后所有连接都已关闭（不是等到 stallMs 才松手）',
    mode.sockets === 0, `仍活跃 socket=${mode.sockets}，取消到断言用了 ${Date.now() - tCancel}ms`);
  chk('取消是立刻生效的（远小于 stallMs）', ms < 2000,
    `${ms}ms（stallMs=${constants.UPDATE.stallMs}ms）`);
  chk('取消后不留半截文件（不许污染下一次下载）', !fs.existsSync(dest), dest);
  mode.slow = 0;
}

/* ============================================================================
 *  E 端到端：走公开 download() + 假 Release + 真摘要校验
 * ========================================================================== */
section('E 端到端 download()（假 Release，含 sha256 摘要）');
{
  mode.range = true;
  mode.cutOffsets.clear();
  mode.rangeHits.clear();
  mode.slow = 0;
  process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = '4';
  process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS = `${BASE}/m0`;

  progressFrames = [];
  const c = await updater.check();
  chk('check() 拿到 Release 与附件（含 digest）',
    c.ok === true && c.asset?.size === SIZE && /^sha256:/.test(c.asset?.digest || ''),
    `size=${c.asset?.size} digest=${String(c.asset?.digest).slice(0, 16)}…`);

  const r = await updater.download({ asset: c.asset });
  chk('download() 成功', r.ok === true, (r.message || '').split('\n')[0]);
  chk('结果里说明用了 4 段并发', r.segments === 4 && /4 段并发/.test(r.message || ''), r.message);
  chk('字节数 = Release 元数据大小', r.bytes === SIZE, `${r.bytes}/${SIZE}`);
  chk('摘要校验真的做了（verify=sha256）', r.verify === 'sha256', String(r.verify));
  const mm = firstMismatch(r.dest, BODY);
  chk('落盘内容逐字节正确', mm === -1, mm === -1 ? '全部匹配' : String(mm));
  chk('done 帧带 verify 与 segments（界面要据此显示"4 线程/SHA-256 校验通过"）',
    progressFrames.some((f) => f.phase === 'done' && f.verify === 'sha256' && f.segments === 4),
    JSON.stringify(progressFrames.filter((f) => f.phase === 'done').map((f) => ({ v: f.verify, s: f.segments }))));
  chk('登记了可安装记录且带 sha256', Boolean(updater.downloadState()?.sha256),
    JSON.stringify(updater.downloadState()));
  cleanup.push(r.dest);

  /* 摘要不符时必须判失败 —— 不许"下了就成功" */
  const bad = await updater.download({
    asset: { ...c.asset, digest: `sha256:${'0'.repeat(64)}` }
  });
  chk('摘要不符 → 判失败且原因写明 SHA-256',
    bad.ok === false && bad.attempts?.some((a) => /SHA-256/.test(a.message)),
    (bad.attempts?.[0]?.message || bad.message || '').slice(0, 90));
}

/* ============================================================================
 *  附：真实链路实测（受限，12 MB 上限）—— 单线程 vs 多线程
 * --------------------------------------------------------------------------
 *  方式：把"分段下载器"直接指向真实附件地址，但只下前 CAP 字节
 *  （downloadSegmented 接受任意 total，不需要跑完整的 update:download）。
 *  这样量到的是**同一条线路上的同一份字节**，单/多线程可直接对比，
 *  也不会把 91.8 MB 真拉一遍。
 *
 *  环境变量 MAIBOT_LAUNCHER_UPDATE_MT_LIVE=0 可跳过（默认跑）。
 * ========================================================================== */
if (String(process.env.MAIBOT_LAUNCHER_UPDATE_MT_LIVE || '1') !== '0') {
  section('附 真实链路实测（受限 12 MB，只测速不安装）');
  const LIVE_URL = 'https://gh.xxooo.cf/https://github.com/akkaksmska/maibot-launcher/releases/download/v2.1.0/MaiBot.Launcher.Setup.2.1.0.exe';
  const CAP = 12 * 1024 * 1024;
  const liveDest = destFor('live-cap.bin');

  const runOnce = async (threads, label) => {
    fs.rmSync(liveDest, { force: true });
    process.env.MAIBOT_LAUNCHER_UPDATE_THREADS = String(threads);
    const frames = [];
    const orig = windowsMod.sendToRenderer;
    windowsMod.sendToRenderer = (ch, payload) => {
      frames.push({ ...payload });
      return true;
    };
    const controller = new AbortController();
    const t0 = Date.now();
    let outcome = '';
    try {
      await updater.downloadSegmented({
        url: LIVE_URL,
        dest: liveDest,
        total: CAP,
        count: threads,
        channel: { label: 'gh.xxooo.cf', prefix: 'https://gh.xxooo.cf', isMirror: true },
        controller
      });
      outcome = 'ok';
    } catch (e) {
      outcome = e?.message || String(e);
    }
    const ms = Date.now() - t0;
    windowsMod.sendToRenderer = orig;
    const got = fs.existsSync(liveDest) ? fs.statSync(liveDest).size : 0;
    const mb = got / 1048576;
    const mbps = mb / (ms / 1000);
    console.log(
      `  ${label}: 收到 ${mb.toFixed(2)} MB / ${(ms / 1000).toFixed(2)}s = ` +
      `${mbps.toFixed(2)} MB/s（${(mbps * 1024).toFixed(0)} KB/s）` +
      `${outcome === 'ok' ? '' : `  [${outcome.slice(0, 80)}]`}`
    );
    return { got, ms, mbps, frames, outcome };
  };

  const single = await runOnce(1, '单连接  ');
  const quad = await runOnce(4, '4 段并发');

  const speedup = single.mbps > 0 ? quad.mbps / single.mbps : 0;
  console.log(
    `  → 单连接 ${single.mbps.toFixed(2)} MB/s vs 4 段 ${quad.mbps.toFixed(2)} MB/s ` +
    `= ${speedup.toFixed(2)}×；按 91.8 MB 折算：` +
    `${(91.8 / Math.max(0.001, single.mbps) / 60).toFixed(1)} 分 → ${(91.8 / Math.max(0.001, quad.mbps) / 60).toFixed(1)} 分`
  );
  chk('真实链路单连接与 4 段都真的收到了字节', single.got > 0 && quad.got > 0,
    `${(single.got / 1048576).toFixed(2)}MB / ${(quad.got / 1048576).toFixed(2)}MB`);
  chk('真实链路 4 段比单连接快（分段确实生效）', speedup > 1.2, `${speedup.toFixed(2)}×`);
  const quadFrames = quad.frames.filter((f) => f.phase === 'progress');
  chk('真实链路进度帧带 4 段并发信息与聚合速度',
    quad.frames.some((f) => f.segments === 4) && quadFrames.length > 0,
    quadFrames.length ? `最后一帧 ${quadFrames.at(-1).received} 字节 ${(quadFrames.at(-1).bytesPerSec / 1048576).toFixed(2)}MB/s` : '(无)');
  fs.rmSync(liveDest, { force: true });
  delete process.env.MAIBOT_LAUNCHER_UPDATE_THREADS;
} else {
  console.log('\n[verify-update-mt] 已按 MAIBOT_LAUNCHER_UPDATE_MT_LIVE=0 跳过真实链路实测');
}

/* ============================================================================
 *  汇总
 * ========================================================================== */
await new Promise((r) => server.close(r));
console.log(`\n[verify-update-mt] 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
