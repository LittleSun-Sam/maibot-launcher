/*
================================================================================
脚本：scripts/run.mjs
职责：构建并以「用户可见」的方式启动应用，然后交还控制权。
================================================================================
  为什么需要单独一个脚本：
    直接 `electron .` 会把窗口绑在调用它的进程上 —— 在自动化/后台场景里
    进程树被回收时窗口会跟着消失，或者反过来让调用方永远挂着不返回。
    这里用 detached + unref 启动，窗口独立存活，脚本立刻返回。

  它做的事：
    1) 可选构建（默认构建，保证看到的是最新代码，不是过期 dist）
    2) 检查是否已有实例在跑（单实例锁会让新进程直接退出、只聚焦旧窗口）
    3) 启动 Electron（不重定向 userData，用你的真实配置）
    4) 轮询确认真的出现了可见窗口，并打印日志路径与最后几行

  用法：
    node scripts/run.mjs                 # 构建 + 启动（默认）
    node scripts/run.mjs --no-build      # 跳过构建，直接启动现有产物
    node scripts/run.mjs --fresh         # 先用隔离的临时 userData 启动（不动真实配置）
    node scripts/run.mjs --wait          # 前台运行，Ctrl+C 一起退出

  对应 npm 脚本：npm start（直接 electron）、npm run app（本脚本）
================================================================================
*/
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const NO_BUILD = argv.includes('--no-build');
const FRESH = argv.includes('--fresh');
const WAIT = argv.includes('--wait');

const electronBin = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

function die(msg) {
  console.error(`\n[app] ✗ ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(electronBin)) {
  die(`未找到 Electron: ${electronBin}\n      请先执行 npm install`);
}

/* ---------------------------------------------------------------- 1) 构建 */
if (!NO_BUILD) {
  console.log('[app] 构建中（--no-build 可跳过）…');
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  if (r.status !== 0) die('构建失败，已中止启动');
}

for (const rel of ['dist/main/main.cjs', 'dist/preload/preload.cjs', 'dist/renderer/index.html']) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    die(`缺少构建产物 ${rel}\n      请先执行 npm run build`);
  }
}

/* ------------------------------------------------- 2) 已有实例检测 */
/*
  单实例锁是基于 userData 路径生成的：若已有一个实例在跑，
  新进程会立刻退出（只把旧窗口聚焦到前台）。
  这里先讲清楚，避免用户以为"启动失败"。

  实现注意：用 -EncodedCommand 传脚本，而不是裸命令字符串。
  裸字符串经 cmd/PowerShell 两层解析后，引号与管道符很容易被吃掉，
  表现为"探测不到窗口"然后静默启动第二个实例 —— 实测踩过。
*/
function findRunning() {
  if (process.platform !== 'win32') return null;
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$p = Get-Process | Where-Object { $_.MainWindowTitle -eq 'MaiBot Launcher' } | Select-Object -First 1",
    'if ($p) { [Console]::Out.Write($p.Id) }'
  ].join('; ');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');

  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const pid = Number(String(out.stdout || '').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** 把指定 pid 的窗口调到前台 */
function focusWindow(pid) {
  if (process.platform !== 'win32') return;
  const ps = `$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate(${pid}) | Out-Null`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: 8000,
    stdio: 'ignore'
  });
}

if (!FRESH) {
  const running = findRunning();
  if (running) {
    console.log(`[app] 已有实例在运行（pid=${running}）—— 单实例锁会让新进程直接退出。`);
    console.log('[app] 直接把已有窗口调到前台。');
    focusWindow(running);
    console.log('[app] 若要开一个独立实例，用 --fresh（隔离数据目录，不影响你的配置）');
    process.exit(0);
  }
}

/* ---------------------------------------------------------------- 3) 启动 */
const userData = FRESH ? fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-run-')) : null;

const child = spawn(electronBin, ['.'], {
  cwd: ROOT,
  /* 交付给用户的窗口必须独立存活，所以 detached + 忽略 stdio */
  detached: !WAIT,
  stdio: WAIT ? 'inherit' : 'ignore',
  windowsHide: false,
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    ...(userData ? { MAIBOT_LAUNCHER_USER_DATA: userData } : {})
  }
});

if (WAIT) {
  console.log('[app] 前台运行中，Ctrl+C 退出。');
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  /* 脱离父进程：脚本退出后窗口继续存在 */
  child.unref();
}

const realUserData = userData || path.join(process.env.APPDATA || '', 'maibot-launcher');
const logFile = path.join(realUserData, 'logs', 'launcher.log');

console.log(`[app] 已启动 (pid=${child.pid})`);
console.log(`[app]   userData : ${realUserData}${FRESH ? '  （临时目录）' : ''}`);
console.log(`[app]   日志     : ${logFile}`);

if (WAIT) process.exit(0);

/* --------------------------------------------- 4) 确认窗口真的出现了 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
for (let i = 0; i < 20; i++) {
  await sleep(700);
  if (findRunning()) {
    ok = true;
    break;
  }
}

const tail = (() => {
  try {
    return fs
      .readFileSync(logFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-6)
      .map((l) => `      ${l}`);
  } catch (_) {
    return ['      (暂无日志)'];
  }
})();

console.log('');
console.log('[app] ── 启动日志（末尾）───────────────');
console.log(tail.join('\n'));
console.log('[app] ────────────────────────────────────');
console.log('');

if (ok) {
  console.log('[app] ✓ 窗口已出现，可以直接操作了。');
} else {
  console.log('[app] ⚠ 未检测到窗口。请查看上方日志；');
  console.log(`[app]   进程可能已退出，或窗口标题不含 "MaiBot Launcher"。`);
}
