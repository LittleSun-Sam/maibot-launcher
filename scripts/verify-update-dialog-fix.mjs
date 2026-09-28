/**
 * 「检查更新」二级窗口三项修复的**实测**脚本（CDP 真跑）。
 *
 * 为什么要用到"主进程日志"来数请求：
 *   主进程的检查走 node:https（见 src/main/services/updater.js 顶部「HTTP 传输层」），
 *   不经过 Chromium 网络栈，所以 CDP 的 Network.requestWillBeSent **看不到**它
 *   （本脚本也把这条当成证据之一打印出来）。
 *   真正能数清"打了几次网络"的信号是主进程自己在**响应返回后**写的那行日志：
 *     [updater] 检查更新：当前 x / 最新 y → …
 *   每成功打一次 GitHub API 就恰好一行；读缓存时一行都不会新增。
 *
 * 场景：①打开 → ②关掉再打开 → ③点「重新检查」
 * 每个场景都打三个数：主进程检查日志增量、渲染层 IPC 往返耗时、CDP 网络事件数。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, evaluate } from './probe-upd-modal.mjs';

const LOG = join(process.env.APPDATA, 'maibot-launcher', 'logs', 'launcher.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connect();
await cdp.send('Page.enable');
await cdp.send('Network.enable');

const netUrls = [];
cdp.on((msg) => {
  if (msg.method === 'Network.requestWillBeSent') netUrls.push(msg.params.request.url);
});
const cdpGithub = () => netUrls.filter((u) => /api\.github\.com/i.test(u)).length;

/** 主进程"检查更新成功"的日志行数（每行 = 一次真实的 GitHub API 往返） */
function mainCheckCount() {
  try {
    const text = readFileSync(LOG, 'utf8');
    return (text.match(/\[updater\] 检查更新：/g) || []).length;
  } catch {
    return -1;
  }
}

const ev = (expr) => evaluate(cdp, expr);

/* 建立"渲染层真的发出了一次检查 IPC"的观测点（包装 window.maibotApi 上的方法）
   ⚠️ preload 经 contextBridge 暴露的对象可能是冻结的，包不上就如实记下来，
      不硬来 —— 主进程日志那条证据不受它影响。 */
const probeWrapped = await ev(
  `(() => {
     try {
       const api = window.maibotApi;
       if (!api || api.__probed) return 'already';
       const raw = api.checkLauncherUpdate;
       if (typeof raw !== 'function') return 'no-method';
       window.__checkProbe = { count: 0, ms: 0 };
       api.checkLauncherUpdate = async (...a) => {
         const t0 = performance.now();
         window.__checkProbe.count += 1;
         try {
           return await raw(...a);
         } finally {
           window.__checkProbe.ms = performance.now() - t0;
         }
       };
       api.__probed = true;
       return api.checkLauncherUpdate === raw ? 'frozen-ignored' : 'wrapped';
     } catch (e) {
       return 'failed: ' + String(e && e.message);
     }
   })()`
);
console.log('# 渲染层 IPC 探针:', probeWrapped);

async function openDialog() {
  await ev(`document.querySelector('[data-testid="settings-check-update"]')?.click()`);
}
async function clickLater() {
  await ev(`document.querySelector('[data-testid="update-later"]')?.click()`);
}
async function waitSettled() {
  for (let i = 0; i < 60; i += 1) {
    const busy = await ev(
      `!!document.querySelector('[data-testid="update-cache-note"]')?.innerText.includes('正在检查')`
    );
    if (!busy) break;
    await sleep(250);
  }
  await sleep(1800);
}

/** 一个场景的观测：主进程日志增量 / IPC 调用次数与耗时 / 界面标注 */
async function snapshot(label, before) {
  const main = mainCheckCount();
  const probe = await ev(`({ ...window.__checkProbe })`);
  const note = await ev(`document.querySelector('[data-testid="update-cache-note"]')?.innerText ?? null`);
  const row = {
    label,
    mainLogDelta: main - before.main,
    mainLogTotal: main,
    ipcBefore: before.probe.count,
    ipcAfter: probe.count,
    ipcDelta: probe.count - before.probe.count,
    lastIpcMs: Math.round(probe.ms),
    cdpGithub: cdpGithub(),
    note
  };
  console.log(
    `  ${label}: 主进程检查日志 +${row.mainLogDelta}（累计 ${row.mainLogTotal}）` +
      ` · 检查 IPC 调用 +${row.ipcDelta} · 本次 IPC 往返 ${row.lastIpcMs}ms · 标注「${note}」`
  );
  return row;
}

const readState = async () => ({
  main: mainCheckCount(),
  probe: await ev(`({ ...window.__checkProbe })`)
});

const report = { phases: [] };

/* ---------------------------------------------------------------- 准备 */
await ev(`location.hash = '#/settings'`);
await sleep(1200);
await ev(`document.querySelector('[data-testid="settings-tab-about"]')?.click()`);
await sleep(900);

/* ------------------------------------------------------- 场景一：打开 */
console.log('■ 场景一：第一次打开二级窗口（应当真的打一次网络）');
let before = await readState();
const t0 = Date.now();
await openDialog();
/* 等界面出现"有结论"的状态 */
for (let i = 0; i < 80; i += 1) {
  if (await ev(`!!document.querySelector('[data-testid="update-dialog"]')`)) break;
  await sleep(120);
}
const visibleAfterMs = Date.now() - t0;
await waitSettled();
const p1 = await snapshot('第一次打开', before);
p1.dialogVisibleAfterMs = visibleAfterMs;
report.phases.push(p1);

/* ------------------------------------- 场景一附：入场动画的计算值 */
report.enterAnimation = await ev(
  `(() => {
     const m = document.querySelector('.upd-mask');
     const d = document.querySelector('.upd');
     const cm = m ? getComputedStyle(m) : null;
     const cd = d ? getComputedStyle(d) : null;
     return {
       mask: { name: cm?.animationName, duration: cm?.animationDuration, easing: cm?.animationTimingFunction, classes: m?.className },
       dialog: { name: cd?.animationName, duration: cd?.animationDuration, easing: cd?.animationTimingFunction, opacity: cd?.opacity, transform: cd?.transform }
     };
   })()`
);
console.log('  入场动画:', JSON.stringify(report.enterAnimation));

/* 几何：遮罩是否盖住 y=0..44 的标题栏 */
report.geometry = await ev(
  `(() => {
     const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
       return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom }; };
     const mask = document.querySelector('.upd-mask');
     const bar = document.querySelector('.titlebar');
     const mb = r(mask); const bb = r(bar);
     return {
       viewport: { w: window.innerWidth, h: window.innerHeight },
       mask: mb,
       maskZIndex: getComputedStyle(mask).zIndex,
       maskPosition: getComputedStyle(mask).position,
       maskInset: getComputedStyle(mask).inset,
       maskAppRegion: getComputedStyle(mask).getPropertyValue('-webkit-app-region'),
       maskParent: mask.parentElement.tagName,
       titlebar: bb,
       titlebarZIndex: getComputedStyle(bar).zIndex,
       titlebarAppRegion: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
       overlapWith_0_44: Math.max(0, Math.min(mb.bottom, 44) - Math.max(mb.top, 0)),
       hitAt_titlebarCenter: (() => { const el = document.elementFromPoint(40, 22); return el ? el.tagName + '.' + String(el.className).split(' ')[0] : null; })(),
       hitAt_titlebarRight: (() => { const el = document.elementFromPoint(1200, 22); return el ? el.tagName + '.' + String(el.className).split(' ')[0] : null; })()
     };
   })()`
);
console.log('  几何:', JSON.stringify(report.geometry));

/* ------------------------------------------------------- 场景二：关掉再打开 */
console.log('■ 场景二：关闭后再次打开（TTL 内应当一次网络都不打）');
await clickLater();
await sleep(120);
report.leaveAnimation = await ev(
  `(() => { const m = document.querySelector('.upd-mask'); if (!m) return { gone: true };
     const c = getComputedStyle(m); return { name: c.animationName, duration: c.animationDuration, easing: c.animationTimingFunction, classes: m.className }; })()`
);
console.log('  出场动画:', JSON.stringify(report.leaveAnimation));
await sleep(1000);
report.removedAfterLeaveAnimation = await ev(`!document.querySelector('.upd-mask')`);

before = await readState();
await openDialog();
await waitSettled();
const p2 = await snapshot('第二次打开', before);
report.phases.push(p2);

/* ------------------------------------------------------- 场景三：重新检查 */
console.log('■ 场景三：点「重新检查」（应当再 +1 次网络）');
report.recheckButton = await ev(
  `(() => { const b = document.querySelector('[data-testid="update-recheck"]'); return b ? b.innerText.trim() : null; })()`
);
before = await readState();
await ev(`document.querySelector('[data-testid="update-recheck"]')?.click()`);
await waitSettled();
const p3 = await snapshot('重新检查', before);
report.phases.push(p3);

report.cdpNetworkGithubRequests = cdpGithub();
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(report, null, 2));
cdp.close();
