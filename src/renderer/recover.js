/*
================================================================================
技术文档：src/renderer/recover.js
职责：界面分块（懒加载 chunk）加载失败时的可视化兜底。
================================================================================
  为什么需要它 —— 这不是假想问题，是真实踩到过的"变砖"：

  各页面组件都是 `() => import('../views/XxxPanel.vue')` 懒加载的。
  Vite 构建时给每个分块的文件名带上内容哈希，并且在重建 dist 前会
  **先清空 assets/ 目录**。于是只要"启动器还开着的时候重新构建了 dist"，
  旧窗口里那份 index.js 记的还是旧文件名（如 LogsPanel-BQQBsKnm.js），
  而磁盘上已经是新文件（LogsPanel-DnflBmkU.js）—— 点标签时动态 import 失败。

  更糟的是退出路径也是封死的：窗口的关闭按钮只 hide 到托盘
  （windows.js 的 mainWindow.on('close')），进程不退；再启动一次会被
  单实例锁挡回去。用户看到的现象就是「点哪儿都没反应，关掉重开也没用」。

  而渲染层对此**完全静默**：动态导入失败既没有 toast，也没有任何提示，
  只有开发者控制台里一行 Failed to fetch dynamically imported module。

  这个模块把"静默变砖"变成一句人话 + 一个能用的按钮：
  捕获分块加载失败 → 显示说明 → 一键重新载入（reload 后就是新构建的界面）。

  刻意用原生 DOM 而不是 Vue 组件：分块加载失败时，出问题的可能正是
  路由/组件树本身，兜底 UI 不能依赖它要拯救的东西。
  配色沿用 theme.css 的变量，并在变量不可用时回退为字面量。
================================================================================ */

import { toast } from './composables/useToast.js';

/** 各种引擎/打包器对"分块加载失败"的不同措辞 */
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Loading chunk \d+ failed/i,
  /Unable to preload CSS/i
];

/** 判断一个异常是不是"界面分块加载失败" */
export function isChunkLoadError(err) {
  const msg = String((err && (err.message || err)) || '');
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(msg));
}

/** 读主题色变量，取不到就给字面量兜底（兜底 UI 不能因为变量缺失而看不见） */
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch (_) {
    return fallback;
  }
}

/* ============================================================================
 *  状态说明（这两个状态必须分开，合并就会重新变成"静默变砖"）
 *
 *  overlayEl —— 兜底浮层**当前是否挂在页面上**。
 *               用户点「稍后」会摘掉浮层，此时必须能再次弹出，
 *               否则第二次失败又回到"点哪儿都没反应"。
 *
 *  lastNoticeAt —— 上一次**已经通知过用户**的时刻。
 *               只用来做提示节流（浮层还在屏幕上时就别刷 toast），
 *               绝不能拿它当"已经处理过、以后都别再管"的开关。
 *
 *  修复前的写法是 `let handled = false; if (handled) return;`：
 *  handled 一旦置 true 就**永不复位**，而 overlayShown 会被「稍后」复位。
 *  于是「失败 → 用户点稍后 → 再次失败」这条最正常的路径里，
 *  第二次失败既不弹浮层、也不 toast、连上报日志都被 return 掉 ——
 *  彻底静默，正是本文件要防的那个变砖场景。
 * ========================================================================== */
let overlayEl = null;
let lastNoticeAt = 0;

/** 记录用户"已经看到过提示"的时刻（节流用；不是"已处理完"的开关） */
const NOTICE_THROTTLE_MS = 15000;

/** 浮层是否正显示在页面上 */
function isOverlayShown() {
  return Boolean(overlayEl && overlayEl.isConnected);
}

/** 摘掉浮层（用户点了「稍后」，或浮层已脱离文档） */
function disposeOverlay() {
  try {
    overlayEl?.remove();
  } catch (_) {
    /* 浮层可能已被别处移除 */
  }
  overlayEl = null;
}

/**
 * 渲染兜底浮层。
 * 同一时刻只允许存在一个：已有一个在页面上就不重复创建。
 * 用户点「稍后」摘掉之后，下一次失败仍然能重新弹出（这是必须的行为）。
 */
function renderOverlay(detail) {
  if (isOverlayShown() || !document.body) return;
  overlayEl = null;

  const mask = document.createElement('div');
  mask.setAttribute('role', 'alertdialog');
  mask.setAttribute('aria-label', '界面需要重新载入');
  Object.assign(mask.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '9999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(18, 26, 40, 0.42)',
    backdropFilter: 'blur(3px)',
    padding: '24px'
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    width: 'min(520px, 100%)',
    background: cssVar('--paper-full', '#ffffff'),
    border: `1.5px solid ${cssVar('--err-line-strong', '#e2a0a0')}`,
    borderRadius: cssVar('--radius-lg', '14px'),
    boxShadow: '0 18px 48px rgba(20, 30, 48, 0.24)',
    padding: '22px 22px 18px',
    fontFamily: 'inherit',
    color: cssVar('--ink-strong', '#1d2733')
  });

  const title = document.createElement('div');
  title.textContent = '界面文件已更新，需要重新载入';
  Object.assign(title.style, { fontSize: '15px', fontWeight: '650', marginBottom: '10px' });

  const body = document.createElement('div');
  body.textContent =
    '启动器运行期间界面被重新构建过，当前窗口引用的旧文件已经不存在，' +
    '所以点标签没有反应。重新载入即可恢复（不会影响正在运行的服务和你的设置）。';
  Object.assign(body.style, {
    fontSize: '12.5px',
    lineHeight: '1.7',
    color: cssVar('--ink-soft', '#4a5766')
  });

  if (detail) {
    const pre = document.createElement('div');
    pre.textContent = detail;
    Object.assign(pre.style, {
      marginTop: '10px',
      padding: '8px 10px',
      borderRadius: cssVar('--radius-sm', '8px'),
      background: cssVar('--paper-solid', 'rgba(0,0,0,0.04)'),
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: '11px',
      color: cssVar('--ink-faint', '#71808f'),
      wordBreak: 'break-all'
    });
    card.append(title, body, pre);
  } else {
    card.append(title, body);
  }

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '10px', marginTop: '18px' });

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = '重新载入';
  Object.assign(reload.style, {
    height: '34px',
    padding: '0 18px',
    border: 'none',
    borderRadius: '999px',
    cursor: 'pointer',
    background: cssVar('--theme-color', '#66ccff'),
    /* 字色也必须走变量：写死 #0b2233 压在浅色主题的 --theme-color(#2760e8) 上
       只有 3.04:1；--on-accent 实测 5.35:1（深色 5.98:1）。
       第二参数保留 #0b2233 —— 它与上面 --theme-color 的兜底 #66ccff 是配对的
       （深墨字压浅蓝 = 9.02:1），换成白色会让"变量缺失"这条兜底路径反而不可读。 */
    color: cssVar('--on-accent', '#0b2233'),
    fontSize: '13px',
    fontWeight: '600'
  });
  reload.addEventListener('click', () => location.reload());

  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = '稍后';
  Object.assign(later.style, {
    height: '34px',
    padding: '0 16px',
    borderRadius: '999px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${cssVar('--line-strong', '#d6dde6')}`,
    color: cssVar('--ink-soft', '#4a5766'),
    fontSize: '13px'
  });
  later.addEventListener('click', () => {
    /*
      只摘浮层、并把"最后一次通知"的时间钉在这一刻：
      这不是"以后都别再提示"，只是给节流一个起点。
      下一次分块失败（超过节流窗口）会重新弹出来。
    */
    disposeOverlay();
    lastNoticeAt = Date.now();
  });

  row.append(reload, later);
  card.append(row);
  mask.append(card);
  document.body.append(mask);
  overlayEl = mask;
}

function report(text) {
  try {
    window.maibotApi?.reportLog?.('error', text);
  } catch (_) {
    /* 上报通道不可用时不能再抛，否则形成异常循环 */
  }
}

/**
 * 安装兜底。返回一个 router.onError 处理器。
 * 请尽早调用（在 mount 之前），这样首屏分块失败也能兜住。
 */
export function installChunkRecovery() {
  /* 失败累计次数：只用于日志里说清"第几次"，不作为"以后别再管"的开关 */
  let failureCount = 0;

  const trigger = (detail) => {
    failureCount += 1;
    const text = detail || '(无详情)';
    const at = Date.now();
    const throttled = lastNoticeAt !== 0 && at - lastNoticeAt < NOTICE_THROTTLE_MS;

    /* 1) 每一次失败都必须留下上报（静默是这整套兜底最不能接受的结果） */
    report(`[renderer/chunk] 界面分块加载失败（第 ${failureCount} 次）: ${text}`);

    /* 2) 浮层已经挂在页面上：用户正看着提示，不必再打扰，但日志已记 */
    if (isOverlayShown()) return;

    /* 3) 刚提示过（多半是用户点了「稍后」）：只做提示节流，不丢上报 */
    if (throttled) return;

    renderOverlay(text);

    /* 4) 浮层可能还没渲染（body 未就绪）时，至少给一条 toast */
    if (!isOverlayShown()) {
      toast('界面文件已更新，请重新载入窗口', 'error', 8000);
    }
    lastNoticeAt = at;
  };

  /*
    Vite 在预加载分块失败时会派发这个事件（Vite 5 起）。
    它比 router.onError 更早、更直接。
  */
  window.addEventListener('vite:preloadError', (e) => {
    trigger(String(e?.payload?.message || 'vite:preloadError'));
  });

  return {
    /**
     * 给 router.onError 用。
     * @returns {boolean} 是否是分块加载失败（调用方可据此决定是否吞掉）
     */
    handleNavigationError(err) {
      if (!isChunkLoadError(err)) return false;
      trigger(String(err?.message || err));
      return true;
    }
  };
}
