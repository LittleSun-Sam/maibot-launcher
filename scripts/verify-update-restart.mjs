/*
================================================================================
脚本：scripts/verify-update-restart.mjs
职责：把启动器重启到**最新构建**（dist/），并以 CDP 可用为准确认就绪。
================================================================================
  为什么不能用 `npm start` / 直接前台起 electron：
    · 单实例锁：旧进程还活着的话，新进程会直接退出（只剩"聚焦旧窗口"的效果），
      于是后面 CDP 验证到的还是**旧代码** —— 这会伪装成"修复没生效"；
    · 前台启动会把窗口绑在本脚本的进程树上，脚本一退出窗口就没了。
  所以：只杀**本项目**的 Electron（按命令行里的仓库根路径过滤，绝不误杀别的
  Electron 应用），再用 detached + unref 起新的。

  ⚠️ 只动 Electron 进程，不启停用户的任何真实服务。
================================================================================
*/
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_WIN = ROOT.replace(/\//g, '\\');
const DEBUG_PORT = process.env.MAIBOT_CDP_PORT || '9223';
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 列出**本项目**的 Electron 进程（PID + 命令行） */
function findOurElectrons() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" |',
    '  ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
  ].join(' ');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  const lines = String(out.stdout || '').split(/\r?\n/).filter(Boolean);
  const hits = [];
  for (const line of lines) {
    const [pidStr, ...rest] = line.split('\t');
    const cmd = rest.join('\t');
    if (!cmd) continue;
    if (!(cmd.includes(ROOT_WIN) || cmd.includes(ROOT))) continue;
    hits.push({ pid: Number(pidStr), cmd });
  }
  return hits;
}

if (!fs.existsSync(electronBin)) {
  console.error(`[restart] ✗ 找不到 Electron：${electronBin}`);
  process.exit(1);
}

const before = findOurElectrons();
const roots = before.filter((p) => !/--type=/.test(p.cmd));
console.log(`[restart] 发现本项目 Electron ${before.length} 个（其中主进程 ${roots.length} 个：${roots.map((p) => p.pid).join(', ') || '无'}）`);

/* 1) 杀掉旧的主进程（带子进程树） */
if (roots.length) {
  for (const p of roots) {
    spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 20000 });
  }
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    if (!findOurElectrons().some((p) => !/--type=/.test(p.cmd))) break;
  }
}
/* 2) 清掉残留的渲染/GPU 子进程，避免占着调试端口 */
for (const p of findOurElectrons()) {
  spawnSync('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true, timeout: 10000 });
}
const stillAlive = findOurElectrons().filter((p) => !/--type=/.test(p.cmd));
if (stillAlive.length) {
  console.error(`[restart] ✗ 旧进程没被杀掉，仍在运行：${stillAlive.map((p) => p.pid).join(', ')}`);
  process.exit(1);
}
console.log('[restart] 旧进程已全部退出');

/* 3) 用最新构建启动（detached：脚本退出后窗口继续活着） */
const child = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
  /* NODE_OPTIONS 清空：避免外部注入的 node 参数影响 Electron 主进程 */
  env: { ...process.env, NODE_OPTIONS: '' }
});
child.unref();
console.log(`[restart] 已启动新进程 pid=${child.pid}，等待窗口与调试端口就绪…`);

/* 4) 确认窗口与调试端口真的可用（不能只看"进程在"） */
let ready = false;
const t0 = Date.now();
for (let i = 0; i < 80; i += 1) {
  await sleep(700);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    if (list.some((t) => t.type === 'page' && /index\.html/.test(t.url))) { ready = true; break; }
  } catch (_) { /* 还没起来 */ }
}
console.log(ready
  ? `[restart] ✓ 就绪（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，CDP ${DEBUG_PORT} 可列出页面）`
  : '[restart] ✗ 超时：未能列出页面');

/* 5) 再等一段时间让主进程把服务状态、主题等初始化完（用户要求等 24 秒） */
if (ready) {
  const extra = Number(process.env.MAIBOT_RESTART_EXTRA_WAIT_MS || 24000);
  console.log(`[restart] 再等 ${extra}ms 让界面初始化完成…`);
  await sleep(extra);
}
process.exit(ready ? 0 : 1);
