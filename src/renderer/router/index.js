import { createRouter, createWebHashHistory } from 'vue-router';

/*
  路由元数据只放渲染真正要用的字段：
    · title —— 顶部标签栏（AppLayout 的 tabs computed 按 meta.title 过滤，
      没有 title 的路由天然不进标签栏，比如 /download 重定向）；
    · icon  —— 标签/菜单图标；
    · full  —— 铺满模式（日志页）。
  ⚠️ 每项原来还带 `color: 'var(--route-overview)'` 之类的"每页一色"引用，**已删**。
  这里原先的注释描述的机制（消费方 AppLayout.vue 的 syncTheme() 在路由切换时用
  getComputedStyle 把变量解析成当前值，再派生出 --theme-color / --theme-tint /
  --theme-line）**在 v5 已经不存在**：syncTheme() 改成把 `var(--accent)` 这类
  引用**内联**写到 <html>，压根不读 meta.color（见该函数注释；"单一蓝色强调 +
  深浅两套主题"是 v3 的硬要求，"每页一色"是 v1 要被去掉的手游味）。
  所以这些 color 只是"只有字符串、没有消费者"的死链：theme.css 里对应的 8 个
  --route-* 令牌已同步删除 —— 否则静态 grep 会把它们算成"活的引用"，正是那类
  查不出来的死链（详见 theme.css E 段"每页一色"那段）。
  要恢复"每页一色"：在这里加回 color 并让 syncTheme() 真的读它，两处必须同时成立。
*/
const routes = [
  { path: '/', redirect: '/overview' },
  {
    path: '/overview',
    name: 'overview',
    component: () => import('../views/OverviewPanel.vue'),
    meta: { title: '总览', icon: 'grid' }
  },
  {
    path: '/installer',
    name: 'installer',
    component: () => import('../views/InstallerPanel.vue'),
    meta: { title: '安装器', icon: 'bolt' }
  },
  {
    /*
      下载页已并入安装器页。
      ────────────────────────────────────────────────────────────────
      理由：这两页本来就是同一件事的两半 —— 安装器负责「检测环境 + 装上游」，
      下载页负责「浏览上游 Release + 取任意附件」，却各自要用户填一遍仓库名。
      合并后由安装器页内的「版本下载」子标签承载下载能力。

      这条重定向留着，是为了不让 #/download 这个旧地址落到 catch-all 而跳回总览，
      并让旧书签/外部链接直接落在合并页的下载子标签上（?tab=download）。
      注意：它没有 meta.title，所以不会再出现在顶部标签栏里（AppLayout 按
      meta.title 过滤），自检路由表也同步少一项（见 src/main/windows.js）。
    */
    path: '/download',
    redirect: '/installer?tab=download'
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('../views/LogsPanel.vue'),
    /*
      full: true —— 日志页铺满整个软件（菜单栏底下）。
      外壳据此去掉 .body 的内边距、并把它自己的滚动条关掉
      （见 AppLayout 的 .body-full 与 LogsPanel 的 .logs-page）：
      日志是"看内容"的页面，多一圈留白就少一屏日志，
      而且外层能滚 + 内层也能滚会出两条滚动条。
    */
    meta: { title: '日志', icon: 'stream', full: true }
  },
  {
    /*
      终端页：让 src/main/services/terminal.js 真正可达。
      重构前该模块有 94 行实现 + 3 个 IPC 通道，却没有任何入口，
      且 node-pty 从未被声明为依赖 —— 完全不可达的死代码。
    */
    path: '/terminal',
    name: 'terminal',
    component: () => import('../views/TerminalPanel.vue'),
    meta: { title: '终端', icon: 'terminal' }
  },
  {
    path: '/toolbox',
    name: 'toolbox',
    component: () => import('../views/ToolboxPanel.vue'),
    meta: { title: '工具箱', icon: 'wand' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsPanel.vue'),
    meta: { title: '设置', icon: 'sliders' }
  },
  {
    path: '/about',
    name: 'about',
    component: () => import('../views/AboutPanel.vue'),
    meta: { title: '关于', icon: 'info' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/overview' }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});
