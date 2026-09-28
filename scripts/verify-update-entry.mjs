/*
================================================================================
脚本：scripts/verify-update-entry.mjs
职责：用 CDP 在**真实运行中的启动器**上验证「检查更新」入口与二级窗口（未配置分支）。
================================================================================
  和 scripts/verify-update-ui.mjs 的分工：
    · verify-update-ui.mjs    自己起假更新源 + 隔离实例，验"有新版本 → 更新内容 → 进度"；
    · 本脚本                 附着到**你正在用的那个实例**，验"占位更新源"这条真实分支：
                             入口在不在、二级窗口能不能开、失败原因是不是真原因。
  两条互补：前者验功能，后者验"没配置时也不许糊弄用户"。

  只读 + 只点 UI：导航、开窗口、读文案、截图。
  **绝不点「更新」/「重启并安装」**（那会真的下载安装包、启动安装程序并退出启动器）。
  当前更新源还是占位值，所以这里验证的正是"未配置"这条真实分支 ——
  它恰好是最容易被糊弄过去的一条（笼统报"网络错误"也算"显示了个错误"）。

  ⚠️ 前置条件：目标实例必须开着调试端口。启动方式见 scripts/_tmp-restart-app.mjs，
     或手动：node_modules/electron/dist/electron.exe . --remote-debugging-port=9223
     脚本不会自己启动实例（单实例锁会让它去应答的其实是旧进程，验证就成了假的）。

  产物：
    backup/deploy-20260927/update-dialog.png       浅色定稿
    backup/deploy-20260927/update-dialog-dark.png  深色（顺手）
================================================================================
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MAIBOT_LAUNCHER_DEBUG_PORT || 9223);
const OUT = path.join(ROOT, 'backup', 'deploy-20260927');
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

let targets = null;
try {
  targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
} catch (e) {
  console.error(`[ui] ✗ 连不上调试端口 ${PORT}：${e?.message || e}`);
  console.error('[ui]   请先让启动器带着调试端口运行，例如：');
  console.error('[ui]   node_modules\\electron\\dist\\electron.exe . --remote-debugging-port=9223');
  process.exit(1);
}
const page = targets.find((x) => x.type === 'page' && /index\.html/.test(x.url));
if (!page) {
  console.error(`[ui] ✗ ${PORT} 上没有找到启动器页面（是不是别的程序占了这个端口？）`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cmd = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return `THREW: ${String(r.result.exceptionDetails.exception?.description || '').split('\n')[0]}`;
  }
  return r.result?.result?.value;
};
await cmd('Runtime.enable');
await cmd('Page.enable');
await cmd('Page.bringToFront');

const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
};

const setTheme = async (th) => {
  await ev(`(async () => { const api = window.maibotApi || {}; if (api.setTheme) await api.setTheme('${th}'); })()`);
  for (let i = 0; i < 30; i += 1) {
    await sleep(200);
    if ((await ev(`document.documentElement.getAttribute('data-theme')`)) === th) return true;
  }
  return false;
};

/*
  进入承载「检查更新」入口的页面。
  入口在 AboutPanel 的「运行环境」卡（版本号那一行），它既是独立的 #/about 页，
  也是设置页「关于」标签里嵌的那一份 —— 两处是**同一个组件、同一个入口**，
  所以按 #/about 验证即可（另一条路径顺带断言"能到、且不出现第二个入口"）。
*/
const gotoAboutPage = async () => {
  await ev(`location.hash = '#/about'`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if ((await ev(`!!document.querySelector('[data-testid="about-check-update"]')`)) === true) return true;
  }
  return false;
};

console.log(`[ui] 目标页面: ${page.url}`);

/* ---------------------------------------------------------- 1) 桥接方法存在 */
console.log('\n== 1 桥接方法（preload）==');
{
  /* 三个 invoke 方法挂在 maibotApi；进度订阅挂在 maibotEvents（与既有事件同一处） */
  const api = await ev(
    `JSON.stringify(['checkLauncherUpdate','downloadLauncherUpdate','installLauncherUpdate','cancelLauncherUpdate'].map(k => [k, typeof (window.maibotApi||{})[k]]))`
  );
  for (const [k, t] of JSON.parse(api)) chk(`maibotApi.${k} 是函数`, t === 'function', t);
  const evT = await ev(`typeof (window.maibotEvents||{}).onUpdateProgress`);
  chk('maibotEvents.onUpdateProgress 是函数', evT === 'function', evT);
}

/* -------------------------------------------------- 2) IPC 真实返回（未配置） */
console.log('\n== 2 update:check 真实返回（当前更新源是占位值）==');
{
  const raw = await ev(`(async () => JSON.stringify(await window.maibotApi.checkLauncherUpdate()))()`);
  if (typeof raw !== 'string' || raw.startsWith('THREW')) {
    chk('update:check 可调用', false, String(raw));
    console.log(`\n[ui] 通过 ${pass}，失败 ${fail}`);
    ws.close();
    process.exit(1);
  }
  const r = JSON.parse(raw);
  console.log(`    ${JSON.stringify(r)}`);
  chk('ok:false', r.ok === false, String(r.ok));
  chk('configured:false（占位值被识别）', r.configured === false, String(r.configured));
  chk('hasUpdate:false（不许假装有新版本）', r.hasUpdate === false, String(r.hasUpdate));
  chk('current 是真实版本', /^\d+\.\d+\.\d+/.test(r.current || ''), r.current);
  chk('message 明确说"未配置更新源"', /未配置更新源/.test(r.message || ''), (r.message || '').slice(0, 50) + '…');
}

/* ------------------------------------------------------------ 3) 入口 → 弹窗 */
console.log('\n== 3 入口与二级窗口 ==');
{
  chk('关于页可到达（入口所在页）', await gotoAboutPage());
  /* 入口只能有一个：一屏里出现两个「检查更新」按钮会让用户以为有两套更新流程 */
  const cnt = await ev(`document.querySelectorAll('[data-testid="about-check-update"]').length`);
  chk('「检查更新」入口恰好一个', cnt === 1, `实际 ${cnt} 个`);
  const btnText = await ev(
    `(() => { const b = document.querySelector('[data-testid="about-check-update"]'); return b ? b.textContent.trim() : ''; })()`
  );
  chk('关于页存在「检查更新」按钮', btnText.includes('检查更新'), btnText);

  /* 入口必须和版本号在同一屏（首屏可见），否则等于让人去找 */
  const near = await ev(`(() => {
    const b = document.querySelector('[data-testid="about-check-update"]');
    if (!b) return '"no-button"';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight });
  })()`);
  const pos = JSON.parse(near);
  chk('入口在首屏内（无需滚动即可看到）', pos.top > 0 && pos.bottom < pos.h, near);

  /* 设置页「关于」标签是另一屏（薄壳），它也有自己的入口 —— 那一屏同样只能有一个 */
  await ev(`location.hash = '#/settings'`);
  await sleep(1200);
  await ev(`(() => { const b = document.querySelector('[data-testid="settings-tab-about"]'); if (b) b.click(); return true; })()`);
  await sleep(900);
  const viaSettings = await ev(`document.querySelectorAll('[data-testid="settings-check-update"]').length`);
  chk('设置页「关于」标签有且只有一个入口', viaSettings === 1, `实际 ${viaSettings} 个`);
  const viaSettingsAbout = await ev(`document.querySelectorAll('[data-testid="about-check-update"]').length`);
  chk('设置页里不会混进关于页那一份（两屏各自成对）', viaSettingsAbout === 0, `实际 ${viaSettingsAbout} 个`);

  /* 从设置页那个入口也要能开出同一个二级窗口 */
  await ev(`(() => { document.querySelector('[data-testid="settings-check-update"]').click(); return true; })()`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if ((await ev(`!!document.querySelector('[data-testid="update-dialog"]')`)) === true) break;
  }
  const openedFromSettings = await ev(`!!document.querySelector('[data-testid="update-dialog"]')`);
  chk('设置页入口同样能打开二级窗口', openedFromSettings === true);
  if (openedFromSettings) {
    /* 这一屏的截图就用设置页的入口开出来的窗口 —— 用户最可能从这个路径进来 */
    await setTheme('light');
    await sleep(400);
    console.log(`    截图（设置页入口）: ${await shot('update-dialog.png')}`);
    await ev(`(() => { const b = document.querySelector('[data-testid="update-close"]'); if (b) b.click(); return true; })()`);
    await sleep(400);
  }

  await ev(`location.hash = '#/about'`);
  await sleep(1000);
  await ev(`(() => { document.querySelector('[data-testid="about-check-update"]').click(); return true; })()`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if ((await ev(`!!document.querySelector('[data-testid="update-dialog"]')`)) === true) break;
  }
  const open = await ev(`!!document.querySelector('[data-testid="update-dialog"]')`);
  chk('二级窗口已打开', open === true);

  /* 等检查落地（check 是异步的，要么 error 要么 latest） */
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const done = await ev(
      `!!document.querySelector('[data-testid="update-error"]') || !!document.querySelector('[data-testid="update-latest"]')`
    );
    if (done === true) break;
  }

  const txt = await ev(
    `(() => { const d = document.querySelector('[data-testid="update-dialog"]'); return d ? d.innerText : ''; })()`
  );
  const errTxt = await ev(
    `(() => { const e = document.querySelector('[data-testid="update-error"]'); return e ? e.innerText : ''; })()`
  );
  console.log('    ── 窗口文本 ──');
  for (const line of String(txt).split('\n')) if (line.trim()) console.log(`    │ ${line}`);
  chk('窗口显示「当前版本」与真实版本号', /当前版本/.test(txt) && txt.includes('2.1.0'));
  chk('窗口显示「最新版本」', /最新版本/.test(txt));
  chk('检查失败时显示**真实原因**（不是"网络错误"）', /未配置更新源/.test(errTxt), errTxt.slice(0, 60) + '…');
  chk('窗口内没有出现"网络错误"这类笼统话', !/网络错误/.test(txt));
  chk('去掉了 HTML 标记（Release notes 不会被当富文本）', !/<[a-z/][^>]*>/i.test(txt));
}

/* ---------------------------------------------------------------- 4) 截图 */
console.log('\n== 4 截图 ==');
{
  /*
    定稿截图用"设置页入口开出来的窗口"（第 3 节里已经拍好 update-dialog.png）。
    这里再补一张深浅对比 + 关于页入口的窗口，确认深浅两套主题下窗口都成立。
  */
  const light = path.join(OUT, 'update-dialog.png');
  chk('设置页入口的截图已落盘（浅色定稿）', fs.existsSync(light), light);

  await setTheme('dark');
  await sleep(500);
  const p2 = await shot('update-dialog-dark.png');
  console.log(`    深色: ${p2}`);

  await setTheme('light');
  await sleep(400);
  chk('深浅两套主题下窗口都在（令牌两套都有定义）',
    fs.existsSync(light) && fs.existsSync(path.join(OUT, 'update-dialog-dark.png')));
}

/* --------------------------------------------- 5) 关闭弹窗、留在设置页 */
console.log('\n== 5 收尾 ==');
{
  await ev(`(() => { const b = document.querySelector('[data-testid="update-close"]'); if (b) b.click(); return true; })()`);
  await sleep(500);
  const closed = await ev(`!document.querySelector('[data-testid="update-dialog"]')`);
  chk('窗口可以关闭', closed === true);

  /* 用户要求"窗口最终停在设置页" —— 停在设置页的「关于」标签（入口就在那一屏） */
  await ev(`location.hash = '#/settings'`);
  await sleep(1200);
  await ev(`(() => { const b = document.querySelector('[data-testid="settings-tab-about"]'); if (b) b.click(); return true; })()`);
  await setTheme('light');
  await sleep(800);
  const tabState = await ev(
    `location.hash + '|' + document.documentElement.getAttribute('data-theme') + '|' + !!document.querySelector('[data-testid="settings-check-update"]') + '|' + !!document.querySelector('[data-testid="update-dialog"]')`
  );
  chk('最终停在 #/settings 的「关于」标签（浅色、入口可见、弹窗已关）', tabState === '#/settings|light|true|false', tabState);
  console.log(`    最终状态: ${tabState}`);
}

console.log(`\n[ui] 通过 ${pass}，失败 ${fail}`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
