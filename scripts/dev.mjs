/*
================================================================================
技术文档：scripts/dev.mjs
职责：一体化开发启动器 —— Vite dev server + 主进程/preload 监听重建 + Electron。
================================================================================
  流程：
    1) 启动 Vite dev server（渲染进程，HMR）
    2) 以监听模式启动 esbuild 构建主进程/preload
    3) 等产物就绪后启动 Electron，并通过 VITE_DEV_SERVER_URL 告知主进程加载 URL
    4) 主进程源码变更 → esbuild 重建 → 自动重启 Electron
    5) Ctrl+C → 依次关闭 Electron / esbuild / Vite

  用法：npm run dev
================================================================================
*/
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_OUT = path.join(ROOT, 'dist', 'main', 'main.cjs');
const PRELOAD_OUT = path.join(ROOT, 'dist', 'preload', 'preload.cjs');

const NATIVE_EXTERNALS = ['node-pty'];
const BUILTIN_EXTERNALS = [
  'electron',
  'child_process', 'fs', 'fs/promises', 'path', 'os', 'net', 'http', 'https',
  'url', 'crypto', 'stream', 'stream/promises', 'events', 'util', 'assert',
  'constants', 'dns', 'perf_hooks', 'tty', 'readline', 'zlib', 'worker_threads'
];

let electronProc = null;
let restarting = false;
let shuttingDown = false;
const esbuildCtxs = [];

/** 启动（或重启）Electron 子进程 */
function startElectron(devServerUrl) {
  if (shuttingDown) return;
  if (electronProc) {
    restarting = true;
    electronProc.removeAllListeners('exit');
    electronProc.kill();
    electronProc = null;
  }

  const electronBin = path.join(
    ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  );
  if (!fs.existsSync(electronBin)) {
    console.error('[dev] 未找到 Electron 可执行文件，请先运行 npm install');
    process.exit(1);
  }

  electronProc = spawn(electronBin, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl, NODE_ENV: 'development' }
  });

  electronProc.on('exit', (code) => {
    if (restarting) {
      restarting = false;
      return; /* 主进程源码变更导致的重启，不需要退出整个 dev */
    }
    if (!shuttingDown) {
      console.log(`[dev] Electron 已退出（code=${code}），关闭开发服务`);
      shutdown(code ?? 0);
    }
  });
}

/** 统一的关闭流程 */
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProc) {
    electronProc.removeAllListeners('exit');
    electronProc.kill();
    electronProc = null;
  }
  for (const ctx of esbuildCtxs) {
    try { await ctx.dispose(); } catch (_) { /* 忽略关闭异常 */ }
  }
  process.exit(code);
}

async function main() {
  /* ---------- 1) 渲染进程 dev server ---------- */
  const server = await createServer({
    /*
      只显式指定 configFile 所在目录，**不要**传 root：
      vite.config.mjs 里 root = src/renderer，才是 index.html 所在目录。
      在这里传 root 会以内联选项覆盖配置文件的 root，
      导致 dev server 从仓库根目录提供服务、访问 / 直接 404。

      用 configFile 指向 .mjs 而非省略：明确表达配置文件名，
      避免依赖 Vite 的默认探测顺序（.js → .mjs → .ts）。
    */
    configFile: path.join(ROOT, 'vite.config.mjs'),
    server: { port: 5173, strictPort: true }
  });
  await server.listen();
  const info = server.resolvedUrls?.local?.[0];
  if (!info) throw new Error('Vite dev server 未返回可用 URL');
  const devServerUrl = info.replace(/\/$/, '');

  /*
    启动自检：确认 dev server 的 root 指向 src/renderer，
    且该目录下确实存在 index.html。
    没有这道检查时，"root 被覆盖成仓库根" 只会表现为访问 / 得到 404 +
    界面白屏，排查成本很高（本项目真踩过这个坑）。
  */
  const servedRoot = server.config.root;
  const expectedRoot = path.join(ROOT, 'src', 'renderer');
  if (path.resolve(servedRoot) !== path.resolve(expectedRoot)) {
    console.error(`[dev] ✗ dev server root 不正确\n        实际: ${servedRoot}\n        期望: ${expectedRoot}\n        请检查 vite.config.mjs 的 root，以及此处是否误传了 root 选项。`);
    await server.close();
    process.exit(1);
  }
  if (!fs.existsSync(path.join(servedRoot, 'index.html'))) {
    console.error(`[dev] ✗ ${servedRoot} 下缺少 index.html`);
    await server.close();
    process.exit(1);
  }

  console.log(`[dev] 渲染进程 dev server: ${devServerUrl}`);
  console.log(`[dev] root: ${servedRoot}`);

  /* ---------- 2) 主进程 / preload 监听重建 ---------- */
  const targets = [
    { entry: path.join(ROOT, 'src', 'main', 'main.js'), outfile: MAIN_OUT, label: 'main' },
    { entry: path.join(ROOT, 'src', 'preload', 'preload.js'), outfile: PRELOAD_OUT, label: 'preload' }
  ];

  let readyCount = 0;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.outfile), { recursive: true });
    let first = true;
    const ctx = await context({
      entryPoints: [t.entry],
      outfile: t.outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      sourcemap: 'inline',
      logLevel: 'warning',
      external: [...BUILTIN_EXTERNALS, ...NATIVE_EXTERNALS],
      plugins: [
        {
          name: 'dev-reload',
          setup(b) {
            b.onEnd((result) => {
              if (result.errors.length) {
                console.error(`[dev] ${t.label} 构建失败，已保留上次产物`);
                return;
              }
              console.log(`[dev] ${t.label} 已构建`);
              if (first) {
                first = false;
                readyCount += 1;
                if (readyCount === targets.length) resolveReady();
              } else {
                /* main 变更才需要重启 Electron；preload 变更刷新窗口即可 */
                if (t.label === 'main') startElectron(devServerUrl);
              }
            });
          }
        }
      ]
    });
    await ctx.watch();
    esbuildCtxs.push(ctx);
  }

  await ready;
  console.log('[dev] 主进程产物就绪，启动 Electron');
  startElectron(devServerUrl);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((e) => {
  console.error('[dev] 启动失败:', e);
  shutdown(1);
});
