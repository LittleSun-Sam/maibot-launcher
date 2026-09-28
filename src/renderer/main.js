import './styles/theme.css';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router/index.js';
import { installChunkRecovery } from './recover.js';

/*
================================================================================
技术文档：src/renderer/main.js
职责：渲染层入口 —— 全局错误捕获 + 应用挂载。
================================================================================
  为什么必须有全局错误捕获：
    重构前渲染层没有任何 window.onerror / unhandledrejection 钩子，
    主进程也从不接收渲染层异常。后果是：
      · 渲染层崩溃只体现在开发者控制台，打包后用户完全看不到；
      · preload 暴露的 reportLog 通道形同虚设（零调用方）；
      · res/launcher.log 里只有主进程日志，排查问题缺少一半信息。
    现在渲染层的未捕获异常会真实写入 launcher.log，与主进程日志同源。
================================================================================
*/

/** 还原 Error 的可读信息（含堆栈），用于写盘 */
function describe(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack || '(无堆栈)'}`;
  if (err && typeof err === 'object') {
    /* DOMException 等非 Error 异常对象 */
    try {
      const name = err.name || 'Object';
      const msg = err.message || '';
      const stack = err.stack || '(无堆栈)';
      return `${name}: ${msg}\n${stack}`;
    } catch (_) {
      return String(err);
    }
  }
  return String(err);
}

/** 写入主进程持久日志（同时保留控制台输出，便于开发期查看） */
function report(level, text) {
  try {
    window.maibotApi?.reportLog?.(level, text);
  } catch (_) {
    /* 上报通道不可用时不能再次抛出，否则会形成异常循环 */
  }
}

let reported = 0;

window.addEventListener('error', (e) => {
  /* 资源加载失败（img/script）没有 error 对象，单独给出可读描述 */
  const detail = e.error
    ? describe(e.error)
    : `资源加载失败: ${e.target?.src || e.target?.href || '(未知)'}`;
  reported += 1;
  report('error', `[renderer/onerror] ${detail}`);
});

window.addEventListener('unhandledrejection', (e) => {
  reported += 1;
  report('error', `[renderer/unhandledrejection] ${describe(e.reason)}`);
});

const app = createApp(App);

/*
  组件内部异常：Vue 默认只打印到控制台。
  这里同时落盘，避免"界面上某个面板崩了但日志里查不到"。
*/
app.config.errorHandler = (err, instance, info) => {
  const name = instance?.$options?.name || instance?.$?.type?.__name || '(匿名组件)';
  reported += 1;
  report('error', `[renderer/vue] ${name} · ${info}\n${describe(err)}`);
  /* 仍然打印，保持开发体验 */
  console.error(`[renderer] 组件 ${name} 异常 (${info})`, err);
};

/*
  Vue 的警告（props 类型不符、缺少 key、模板里访问了 undefined 的属性…）。
  ──────────────────────────────────────────────────────────────────────
  ⚠️ 装了这个 handler 就**顶掉**了 Vue 内置的默认实现 —— 内置那个是
  `console.warn(...)`。所以只 report() 不 console.warn 的后果是：
  警告被从 DevTools 控制台里**拿走**了，只落到启动器自己的日志文件里。
  而开发时看警告的方式就是"盯着控制台"，没人会去翻 backend 日志找一条 warn。
  → 结果：这个项目里"界面上莫名其妙不对"的问题，本来 Vue 已经明确告诉你了，
    却因为你把那条消息转走了而看不见。这与本文件 errorHandler 上面那句
    "仍然打印，保持开发体验"是同一个道理，之前只做了一半。

  保留 report()：打包后没有控制台，落盘是唯一线索。
  两者都做，代价只是一行 console.warn。
  说明：warnHandler 只在开发版 Vue 里会被调用，生产构建里这段代码不会触发。
*/
app.config.warnHandler = (msg, instance, trace) => {
  report('warn', `[renderer/vue-warn] ${msg}${trace ? `\n${trace}` : ''}`);
  /* 与 errorHandler 对齐：先给开发者看见，再落盘 */
  console.warn(`[renderer/vue-warn] ${msg}${trace ? `\n${trace}` : ''}`);
};

/*
  界面分块加载失败的兜底（见 recover.js 的说明）。
  必须在 mount 之前装好：
    · 首屏那次 import 失败也要能兜住；
    · 而且要早于用户点第一个标签。
  路由懒加载失败原本是**完全静默**的 —— 用户只看到"点了没反应"，
  连"关掉窗口重开"都救不回来（关闭只 hide 到托盘，进程不退，
  再启动会被单实例锁挡回去）。现在会明确提示并给出一键重载。
*/
const chunkRecovery = installChunkRecovery();
router.onError((err) => {
  /* 分块失败已由兜底 UI 处理；其它路由错误照旧落盘，便于排查 */
  if (!chunkRecovery.handleNavigationError(err)) {
    report('error', `[renderer/router] ${describe(err)}`);
  }
});

app.use(router);
app.mount('#app');
/* 启动完成标记：便于在日志中确认渲染层真的挂载成功（而非白屏） */
report('info', `[renderer] 界面已挂载 · 捕获器就绪 · 已报告异常 ${reported} 条`);
