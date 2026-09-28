/*
================================================================================
技术文档：src/main/services/notify.js
职责：Windows 系统通知（Toast）。
================================================================================
  为什么需要：
    服务异常退出、连续重启失败这类事件目前只有渲染层的 toast ——
    窗口最小化到托盘、或被用户切到别的应用时，toast 根本看不见，
    而"MaiBot 后台挂了"恰恰是最需要立刻知道的。
    系统通知会进入 Windows 操作中心，用户回来还能看到。

  实现要点：
    1) 用 Electron 内置的 Notification（底层就是 Windows Toast），
       不引入任何第三方通知库。
    2) isSupported() 为假时（部分精简版 Windows / 服务账号）静默降级，
       返回 supported:false 让调用方知道"没发出去"，而不是假装成功。
    3) 点击通知时聚焦主窗口 —— 这是通知唯一有用的交互。
    4) 通知内容做长度截断：Windows Toast 对超长正文显示不友好。
================================================================================
*/
const { Notification, BrowserWindow } = require('electron');

const logging = require('../logging');

/** Windows 通知标题/正文的合理长度上限 */
const MAX_TITLE = 64;
const MAX_BODY = 200;

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 系统是否支持通知 */
function isSupported() {
  try {
    return Notification.isSupported();
  } catch (_) {
    return false;
  }
}

/**
 * 聚焦主窗口（通知被点击时调用）。
 * 拆出来是为了在窗口被隐藏到托盘的情况下也能正确恢复。
 */
function focusMainWindow() {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const win = wins[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * 发送一条系统通知。
 * @param {{title?:string, body?:string, level?:'info'|'warn'|'error', silent?:boolean}} opts
 * @returns {{ok:boolean, supported:boolean, message:string}}
 */
function show(opts = {}) {
  const title = clip(opts.title || 'MaiBot Launcher', MAX_TITLE);
  const body = clip(opts.body || '', MAX_BODY);

  if (!isSupported()) {
    return { ok: false, supported: false, message: '当前系统不支持通知' };
  }
  if (!body) {
    return { ok: false, supported: true, message: '通知内容为空，已忽略' };
  }

  try {
    const n = new Notification({
      title,
      body,
      silent: Boolean(opts.silent),
      urgency: opts.level === 'error' ? 'critical' : 'normal'
    });

    n.on('click', focusMainWindow);
    /* 通知本身的异常（如系统拒绝）不应影响主进程 */
    n.on('failed', (_e, error) => {
      logging.log('warn', `[notify] 通知发送失败: ${error}`);
    });

    n.show();
    logging.log('info', `[notify] ${title} — ${body}`);
    return { ok: true, supported: true, message: '已发送' };
  } catch (e) {
    logging.log('warn', `[notify] 发送通知异常: ${e.message}`);
    return { ok: false, supported: true, message: e.message };
  }
}

module.exports = { show, isSupported, focusMainWindow };
