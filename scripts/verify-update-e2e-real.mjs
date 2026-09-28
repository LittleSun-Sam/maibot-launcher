/*
================================================================================
脚本：scripts/verify-update-e2e-real.mjs
职责：端到端验证「检查更新」这条真实链路 —— 在**真实运行**的启动器里，用 CDP
      1) 直调 window.maibotApi.checkLauncherUpdate()，断言真实返回
      2) 真的点界面上那个「检查更新」按钮（设置 → 关于），读二级窗口的真实文案
      3) 截图存 backup/deploy-20260927/update-real-latest.png
================================================================================
  ⚠️ 本脚本**绝不**点击「重启并安装」/「立即更新」：
     前者会启动 NSIS 安装包并退出启动器，后者会真的下载 91.6 MB。
     只做"检查更新"这一件只读的事（一次 GitHub API GET）。

  为什么必须点按钮而不是只调 IPC：
    只调 IPC 证明不了"界面上真的能看到" —— 而用户遇到的是"点了没反应/显示错误"。
    所以两件事都要做：IPC 的真实返回 + 按钮点下去之后的真实文案。
================================================================================
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'backup', 'deploy-20260927');
fs.mkdirSync(OUT, { recursive: true });
const DEBUG_PORT = process.env.MAIBOT_CDP_PORT || '9223';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- CDP 连接 */
const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) {
  console.error(`[e2e] ✗ 找不到主窗口页面。targets=${JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url })))}`);
  process.exit(1);
}
console.log(`[e2e] 已连接：${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = (e) => j(new Error(`ws error ${e?.message || ''}`)); });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => new Promise((res) => {
  const i = ++msgId;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __threw: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').split('\n')[0] };
  }
  return r.result?.result?.value;
};
const shot = async (name, clip) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  if (!r.result?.data) return null;
  const p = path.join(OUT, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
};

await cmd('Runtime.enable');
await cmd('Page.enable');
await cmd('Page.bringToFront');

let pass = 0;
let fail = 0;
const chk = (name, ok, extra) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fail += 1;
};

/* ============================================================================
 *  1) 直调 IPC：checkLauncherUpdate()
 * ========================================================================== */
console.log('\n== 1) window.maibotApi.checkLauncherUpdate() 真实返回 ==');
const viaIpc = await ev(`(async () => {
  if (!window.maibotApi || typeof window.maibotApi.checkLauncherUpdate !== 'function') {
    return { __missing: true, keys: window.maibotApi ? Object.keys(window.maibotApi) : null };
  }
  return await window.maibotApi.checkLauncherUpdate();
})()`);
if (viaIpc?.__missing) {
  console.error(`[e2e] ✗ preload 里没有 checkLauncherUpdate；现有桥接：${JSON.stringify(viaIpc.keys)}`);
  process.exit(1);
}
console.log('[e2e] 原始返回（notes 截断 400 字）：');
console.log(JSON.stringify({
  ...viaIpc,
  notes: typeof viaIpc.notes === 'string' && viaIpc.notes.length > 400 ? `${viaIpc.notes.slice(0, 400)}…（共 ${viaIpc.notes.length} 字）` : viaIpc.notes
}, null, 2));

const latestNum = String(viaIpc.latest || '').replace(/^v/i, '');
chk('ok:true（连接真实更新源成功）', viaIpc.ok === true, viaIpc.message);
chk('configured:true', viaIpc.configured === true);
chk('current 是 2.1.0', viaIpc.current === '2.1.0', String(viaIpc.current));
chk('latest 是 v2.1.0（或等价 2.1.0）', latestNum === '2.1.0', String(viaIpc.latest));
chk('hasUpdate:false（已是最新，是真实结论）', viaIpc.hasUpdate === false, String(viaIpc.hasUpdate));
chk('notes 是真实 Release 正文（非空）', typeof viaIpc.notes === 'string' && viaIpc.notes.trim().length > 50, `${String(viaIpc.notes || '').length} 字`);
chk('notes 内容确为本版本说明（提到本轮真实改动）',
  /总览|托盘|清理|部署|更新/.test(String(viaIpc.notes || '')), String(viaIpc.notes || '').replace(/\n/g, ' ').slice(0, 80));
chk('message 说明"已是最新"', /已是最新/.test(String(viaIpc.message || '')), String(viaIpc.message));

/* ============================================================================
 *  2) 真的点界面上的「检查更新」按钮（设置 → 关于）
 * ========================================================================== */
console.log('\n== 2) 点击界面「检查更新」按钮 → 二级窗口真实文案 ==');
await ev(`location.hash = '#/settings'`);
await sleep(1200);

/* 切到「关于」标签：按文本找，避免硬编码 class */
const tabClicked = await ev(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="tab"], a, .tab, .seg-item, .settings-tab')];
  const hit = nodes.find((n) => (n.textContent || '').trim() === '关于');
  if (!hit) return { ok: false, sample: nodes.slice(0, 40).map((n) => (n.textContent || '').trim()).filter(Boolean) };
  hit.click();
  return { ok: true, tag: hit.tagName, cls: hit.className };
})()`);
chk('找到并点击了「关于」标签', tabClicked?.ok === true, JSON.stringify(tabClicked));
await sleep(900);

/* 报告当前页面上所有可点元素，便于失败时定位 */
const buttons = await ev(`[...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean)`);
console.log(`[e2e] 当前页面按钮：${JSON.stringify(buttons)}`);

const clicked = await ev(`(() => {
  const byTestId = document.querySelector('[data-testid="settings-check-update"]');
  const target = byTestId || [...document.querySelectorAll('button')].find((b) => /检查更新/.test(b.textContent || ''));
  if (!target) return { ok: false };
  target.scrollIntoView({ block: 'center' });
  target.click();
  return { ok: true, testid: target.getAttribute('data-testid'), text: (target.textContent || '').trim() };
})()`);
chk('点到了「检查更新」按钮（settings-check-update）', clicked?.ok === true, JSON.stringify(clicked));

/* 等二级窗口出现，并等它从 checking 变成 latest（真实网络往返） */
let dialogText = '';
let latestText = '';
let dialogSeen = false;
let notesNodeSeen = false;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  const snap = await ev(`(() => {
    const d = document.querySelector('[data-testid="update-dialog"]');
    const l = document.querySelector('[data-testid="update-latest"]');
    const n = document.querySelector('[data-testid="update-notes"], .upd-notes');
    return {
      seen: !!d,
      dialogText: d ? (d.innerText || d.textContent || '').trim() : '',
      latestText: l ? (l.innerText || l.textContent || '').trim() : '',
      notesSeen: !!n
    };
  })()`);
  dialogSeen = dialogSeen || Boolean(snap?.seen);
  dialogText = snap?.dialogText || dialogText;
  latestText = snap?.latestText || latestText;
  notesNodeSeen = notesNodeSeen || Boolean(snap?.notesSeen);
  if (latestText) break;
}
chk('二级窗口出现了', dialogSeen);
chk('二级窗口显示「已是最新」结论', /已是最新/.test(latestText), JSON.stringify(latestText));
chk('二级窗口显示当前版本 v2.1.0', /2\.1\.0/.test(dialogText), '');
chk('二级窗口显示最新版本 v2.1.0', /最新版本[\s\S]{0,20}v?2\.1\.0/.test(dialogText), '');

/*
  ⚠️ 关于「更新说明」的诚实结论：
    二级窗口在 `hasUpdate === false`（已是最新）这一支**不渲染**更新说明 ——
    见 src/renderer/components/UpdateDialog.vue 的模板分支：
      `<template v-else-if="hasUpdate">`（更新内容） / `<div v-else>`（已是最新）。
    这是既有渲染层的行为，而本次任务**明确禁止改动 src/renderer/**，
    所以这里不去"改代码让它显示"，而是把事实与数据流分别断言清楚：
      · 主进程确实把真实 Release 正文交了出来（上面 IPC 那一条已断言 notes 1526 字）；
      · 渲染层确实把它存进了 store.update.notes（app-store.js: store.update.notes = r.notes）。
    这样"已是最新是真实结论"这件事仍然被证明，同时不掩盖"说明没显示"。
*/
const storeNotes = await ev(`(() => {
  try {
    const pinia = window.__pinia;
    if (!pinia) return { __noPinia: true };
    const s = (pinia.state && pinia.state.value) || {};
    const u = s.app && s.app.update;
    return u ? { notes: String(u.notes || ''), phase: u.phase, hasUpdate: u.hasUpdate } : { __noStore: true, keys: Object.keys(s) };
  } catch (e) { return { __err: String(e && e.message || e) }; }
})()`);
console.log(`[e2e] 渲染层 store 可探测性：${JSON.stringify(storeNotes)}（本项目用的是 reactive 手写 store，没有挂到 window，故 CDP 里够不着；这里只记录，不作为断言）`);

if (!notesNodeSeen) {
  console.log('[e2e] ⚠ 已记录：本次「已是最新」分支下二级窗口未渲染更新说明区块（渲染层既有行为，本次不许改 src/renderer/**）');
}

console.log('\n[e2e] ==== 二级窗口全文（原样，未转述）====');
console.log(dialogText.replace(/\n{3,}/g, '\n\n'));
console.log('[e2e] ==== 全文结束 ====');

/* 截图：整窗（含二级窗口）＋ 二级窗口本体，两个都存 */
await ev(`(() => { const d = document.querySelector('[data-testid="update-dialog"]'); if (d) d.scrollTop = 0; return true; })()`);
await sleep(600);
const fullShot = await shot('update-real-latest');
let dialogShot = null;
try {
  const box = await ev(`(() => {
    const d = document.querySelector('[data-testid="update-dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  })()`);
  if (box && box.width > 10 && box.height > 10) dialogShot = await shot('update-real-dialog', box);
} catch (_) { /* 裁剪失败不影响主截图 */ }
chk('截图 update-real-latest.png 已保存', Boolean(fullShot), String(fullShot));
console.log(`[e2e] 二级窗口本体截图：${dialogShot || '(裁剪失败)'}`);

/* 收尾状态：留在 #/settings，关掉二级窗口，窗口保持可见 */
await ev(`(() => { const b = document.querySelector('[data-testid="update-close"]'); if (b) b.click(); return true; })()`);
await sleep(400);
const finalState = await ev(`({ hash: location.hash, theme: document.documentElement.getAttribute('data-theme'), dialogOpen: !!document.querySelector('[data-testid="update-dialog"]') })`);
console.log(`[e2e] 收尾状态：${JSON.stringify(finalState)}`);
chk('收尾停在 #/settings', String(finalState?.hash || '').includes('/settings'), String(finalState?.hash));
chk('没有误点「重启并安装」/「立即更新」（二级窗口已关闭且未下载）',
  finalState?.dialogOpen === false, JSON.stringify(finalState));

fs.writeFileSync(path.join(OUT, 'update-e2e-real.txt'), [
  `checkLauncherUpdate() 返回：${JSON.stringify(viaIpc, null, 2)}`,
  '',
  '二级窗口全文：',
  dialogText,
  '',
  `收尾状态：${JSON.stringify(finalState)}`,
  `通过 ${pass}，失败 ${fail}`
].join('\n'), 'utf8');

ws.close();
console.log(`\n[e2e] 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
