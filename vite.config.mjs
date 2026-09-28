/*
================================================================================
技术文档：vite.config.mjs
职责：渲染进程（Vue 3）构建配置。主进程 / preload 由 scripts/build-main.mjs 构建。
================================================================================
  设计说明：
    - 文件后缀为 .mjs：本配置是纯 ESM，但 package.json 未声明 "type": "module"
      （即默认 CommonJS），Vite 会因此按 CJS 加载 .js 配置，每次构建都打印
      "The CJS build of Vite's Node API is deprecated"。
      改成 .mjs 后 Vite 直接以 ESM 加载，警告消失。
      注意：不要为此在 package.json 里加 "type": "module" —— 那会破坏
      主进程 / preload 的 CJS 产物（它们由 esbuild 以 cjs 格式输出）。
    - 本项目不再使用 vite-plugin-electron。该插件从未被写入 package.json，
      导致 npm run build 永久失败（Cannot find module 'vite-plugin-electron/simple'）。
      现在主进程/preload 由 esbuild 独立构建，职责边界清晰。
    - base: './'  —— 生产环境通过 loadFile 以 file:// 加载，必须用相对路径。
    - root: src/renderer —— 渲染进程源码根，index.html 位于其中。
    - outDir: dist/renderer —— 与 dist/main、dist/preload 分离，避免 emptyOutDir 互删。
================================================================================
*/
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(ROOT, 'src', 'renderer'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: path.join(ROOT, 'dist', 'renderer'),
    emptyOutDir: true,
    minify: 'esbuild',
    /* Electron 37 内置 Chromium 138，可放心使用现代语法 */
    target: 'chrome138',
    rollupOptions: {
      output: {
        /*
          终端库体积较大且不常变动，单独成块以利缓存。
          注意：必须使用新包名 @xterm/* —— 旧的 xterm / xterm-addon-fit
          已废弃并从依赖中移除，继续引用会导致
          "Could not resolve entry module \"xterm\"" 构建失败。
        */
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit']
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  /* 生产构建保留 console.error/warn，去掉噪声日志 */
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['debugger'] : []
  }
});
