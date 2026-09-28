/*
================================================================================
技术文档：scripts/build-main.mjs
职责：构建 Electron 主进程 / preload 进程（替代已移除的 vite-plugin-electron）。
================================================================================
  为什么不用 vite-plugin-electron：
    该项目曾依赖 'vite-plugin-electron/simple'，但它从未写入 package.json，
    一次 npm install 之后 node_modules 里的包被清理，npm run build 永久失败。
    这里改用项目已装好的 esbuild 直接构建，零额外插件依赖，行为完全可控。

  用法：
    node scripts/build-main.mjs                # 一次性构建（开发态，含 sourcemap）
    node scripts/build-main.mjs --production   # 一次性构建（生产态，压缩、去 sourcemap）
    node scripts/build-main.mjs --watch        # 监听重建（开发态，由 scripts/dev.mjs 调用）

  产物：
    dist/main/main.cjs        —— 主进程入口（CJS，Electron main 字段指向它）
    dist/preload/preload.cjs  —— 渲染进程预加载桥（CJS）
================================================================================
*/
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWatch = process.argv.includes('--watch');
const isProd = process.argv.includes('--production');

/*
  原生模块必须保持 external：node-pty 是编译产物（.node 文件），
  被 rollup/esbuild 内联会直接损坏。缺失时运行时会自动降级（见 services/terminal.js）。
*/
const NATIVE_EXTERNALS = ['node-pty'];

/* Electron 与 Node 内置模块一律 external —— 它们由运行时提供 */
const BUILTIN_EXTERNALS = [
  'electron',
  'child_process', 'fs', 'fs/promises', 'path', 'os', 'net', 'http', 'https',
  'url', 'crypto', 'stream', 'stream/promises', 'events', 'util', 'assert',
  'constants', 'dns', 'perf_hooks', 'tty', 'readline', 'zlib', 'worker_threads',
  'node:child_process', 'node:fs', 'node:fs/promises', 'node:path', 'node:os',
  'node:net', 'node:http', 'node:https', 'node:url', 'node:crypto', 'node:stream',
  'node:stream/promises', 'node:events', 'node:util', 'node:assert',
  'node:constants', 'node:dns', 'node:perf_hooks', 'node:tty', 'node:readline',
  'node:zlib', 'node:worker_threads', 'node:module'
];

function common(entry, outfile) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: isProd ? false : 'inline',
    minify: isProd,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: false,
    external: [...BUILTIN_EXTERNALS, ...NATIVE_EXTERNALS],
    /* 主进程用 __dirname 解析同目录的 preload，CJS 格式下无需 shim */
    define: {
      'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development')
    }
  };
}

const TARGETS = [
  common(
    path.join(ROOT, 'src', 'main', 'main.js'),
    path.join(ROOT, 'dist', 'main', 'main.cjs')
  ),
  common(
    path.join(ROOT, 'src', 'preload', 'preload.js'),
    path.join(ROOT, 'dist', 'preload', 'preload.cjs')
  )
];

function ensureDirs() {
  for (const t of TARGETS) fs.mkdirSync(path.dirname(t.outfile), { recursive: true });
}

async function run() {
  ensureDirs();

  if (!isWatch) {
    for (const t of TARGETS) await build(t);
    const sizes = TARGETS.map((t) => {
      const kb = (fs.statSync(t.outfile).size / 1024).toFixed(1);
      return `${path.relative(ROOT, t.outfile)} (${kb} KB)`;
    });
    console.log(`[build:main] 构建完成 → ${sizes.join(', ')}`);
    return;
  }

  /* 监听模式：每个目标一个独立 context，各自增量重建 */
  const ctxs = [];
  for (const t of TARGETS) {
    const ctx = await context({
      ...t,
      plugins: [
        {
          name: 'rebuild-notify',
          setup(b) {
            b.onEnd((result) => {
              const rel = path.relative(ROOT, t.outfile);
              if (result.errors.length) console.error(`[build:main] ${rel} 构建失败`);
              else console.log(`[build:main] 已重建 ${rel}`);
            });
          }
        }
      ]
    });
    await ctx.watch();
    ctxs.push(ctx);
  }
  console.log('[build:main] 已进入监听模式');
}

run().catch((e) => {
  console.error('[build:main] 构建异常:', e);
  process.exit(1);
});
