/*
================================================================================
脚本：scripts/smoke-test.mjs
职责：无人工介入的主进程启动冒烟测试。
================================================================================
  为什么需要它：
    渲染层能构建成功，并不代表主进程能启动 —— 主进程的模块是运行时
    require 的，一个路径写错、一个模块循环依赖，只在真正启动时才暴露。
    本项目重构前就长期处于"能构建、一启动就白屏"的状态。

  做法：
    1) 用 electron 启动应用（隔离的 userData 目录，不污染真实配置）
    2) 等待主进程写出 launcher.log
    3) 校验日志里出现关键启动里程碑
    4) 杀掉整棵进程树并清理临时 userData

  用法：
    node scripts/smoke-test.mjs [--keep] [--timeout 25000]

  注意：本脚本读取的是 dist/ 下的**构建产物**，因此务必先 npm run build
        （或直接使用 npm run smoke，它会自动先构建）。
================================================================================
*/
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const timeoutArg = argv.indexOf('--timeout');
const TIMEOUT_MS = timeoutArg > -1 ? Number(argv[timeoutArg + 1]) || 25000 : 25000;

/* 隔离的 userData：避免污染用户真实设置与日志 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-smoke-'));

const electronBin = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

function fail(msg) {
  console.error(`\n[smoke] ✗ ${msg}\n`);
  cleanup();
  process.exit(1);
}

let child = null;

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (_) {
      /* 进程可能已退出 */
    }
  }
}

function cleanup() {
  if (child?.pid) killTree(child.pid);
  if (!KEEP) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch (_) {
      /* 忽略 */
    }
  }
}

/* ---------------------------------------------------------------- 前置检查 */
if (!fs.existsSync(electronBin)) {
  fail(`未找到 Electron 可执行文件: ${electronBin}\n       请先执行 npm install`);
}
for (const rel of ['dist/main/main.cjs', 'dist/preload/preload.cjs', 'dist/renderer/index.html']) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    fail(`缺少构建产物 ${rel}\n       请先执行 npm run build`);
  }
}

console.log('[smoke] 启动 Electron（隔离 userData）…');
console.log(`[smoke]   electron : ${electronBin}`);
console.log(`[smoke]   userData : ${SANDBOX}`);
console.log(`[smoke]   超时     : ${TIMEOUT_MS}ms\n`);

child = spawn(
  electronBin,
  ['.'],
  {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      ELECTRON_ENABLE_LOGGING: '1',
      /*
        通过环境变量重定向 userData（见 src/main/main.js 的 redirectUserData）。
        必须在环境变量里传，而不是命令行参数：单实例锁是基于 userData 路径的，
        只有提前重定向才能与用户正在运行的正式实例互不干扰。
      */
      MAIBOT_LAUNCHER_USER_DATA: SANDBOX
    }
  }
);

let stdout = '';
let stderr = '';
child.stdout?.on('data', (d) => {
  stdout += d.toString();
});
child.stderr?.on('data', (d) => {
  stderr += d.toString();
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

const logFile = path.join(SANDBOX, 'logs', 'launcher.log');
const startedAt = Date.now();

/** 主进程成功启动应出现的里程碑（文案与源码逐条核对过） */
const MILESTONES = [
  { key: '日志系统', pattern: /日志系统就绪/ },
  { key: '服务层 IPC', pattern: /服务层 IPC 注册完成/ },
  { key: '主窗口+托盘+服务层', pattern: /\[main\] 主窗口 \+ 托盘 \+ 服务层已就绪/ },
  { key: '会话头', pattern: /会话启动 · v/ },
  /* 渲染层真的挂载成功（不是白屏）——由 src/renderer/main.js 上报 */
  { key: '渲染层已挂载', pattern: /\[renderer\] 界面已挂载/ }
];

function readLog() {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * 等待主进程写出"就绪"日志。
 * 超时视为失败 —— 否则"渲染层只是慢"会被误判成通过，
 * 而这恰恰是最需要被发现的故障形态（白屏）。
 */
async function waitForLog() {
  while (Date.now() - startedAt < TIMEOUT_MS) {
     
    if (exited) {
      fail(
        `Electron 在写出就绪日志前就退出了（code=${exited.code} signal=${exited.signal}）\n` +
          `        stdout: ${stdout.slice(-600) || '(空)'}\n` +
          `        stderr: ${stderr.slice(-600) || '(空)'}`
      );
    }
    const text = readLog();
    if (/界面已挂载/.test(text)) return text;
    await new Promise((r) => setTimeout(r, 400));
  }
  /* 超时：给出已捕获到的内容，便于判断卡在哪一步 */
  fail(
    `等待 ${TIMEOUT_MS}ms 后仍未看到"界面已挂载"（渲染层可能白屏或未加载）\n` +
      `        已捕获日志:\n${(readLog() || '(空)')
        .split('\n')
        .filter(Boolean)
        .map((l) => `          ${l}`)
        .join('\n')}`
  );
}

const log = await waitForLog();

/* ---------------------------------------------------------------- 结果判定 */
console.log('[smoke] ── 主进程日志 ──────────────────────────────');
console.log(
  log
    .split('\n')
    .filter(Boolean)
    .map((l) => `  ${l}`)
    .join('\n') || '  (无日志输出)'
);
console.log('[smoke] ───────────────────────────────────────────\n');

const missing = MILESTONES.filter((m) => !m.pattern.test(log));

/* 渲染层异常必须视为失败：这正是 DataCloneError 那次事故的教训 —— 
   "能启动"不等于"能用"，未捕获异常必须让测试红掉。 */
const rendererErrors = log.split('\n').filter((l) => /\[ERROR\].*\[renderer/.test(l));

/* 常见启动期崩溃特征（含 preload 加载失败 —— 开启 sandbox 后最容易出问题的一环） */
const crashSignatures = [
  'Cannot find module',
  'MODULE_NOT_FOUND',
  'Unable to load preload script',
  'preload script',
  'ERR_REQUIRE_ESM',
  'UnhandledPromiseRejection'
];
const crashLine = crashSignatures.find((s) => log.includes(s) || stderr.includes(s));

if (log.length === 0) {
  fail(
    `主进程完全没有写出日志（${TIMEOUT_MS}ms 内）\n` +
      `        stdout: ${stdout.slice(-800) || '(空)'}\n` +
      `        stderr: ${stderr.slice(-800) || '(空)'}`
  );
}
if (crashLine) {
  fail(`检测到启动崩溃特征 "${crashLine}"\n        详见上方日志`);
}
if (missing.length) {
  fail(`缺少启动里程碑: ${missing.map((m) => m.key).join('、')}`);
}
if (rendererErrors.length) {
  fail(
    `渲染层报告了 ${rendererErrors.length} 条异常（界面可能白屏或功能不可用）:\n` +
      rendererErrors.map((l) => `        ${l}`).join('\n')
  );
}
if (/\[ERROR\]/.test(log)) {
  console.warn('[smoke] ⚠ 日志中存在 [ERROR] 级别记录，请人工确认是否影响功能');
}

console.log('[smoke] ✓ 启动成功');
console.log(`[smoke]   日志文件: ${logFile}`);
console.log(`[smoke]   日志行数: ${log.split('\n').filter(Boolean).length}`);
console.log(`[smoke]   已校验里程碑: ${MILESTONES.map((m) => m.key).join(' / ')}`);
console.log('[smoke]   渲染层未捕获异常: 0 条\n');

cleanup();
process.exit(0);
