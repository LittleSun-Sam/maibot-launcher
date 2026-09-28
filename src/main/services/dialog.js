/*
================================================================================
技术文档：src/main/services/dialog.js
职责：系统原生对话框封装（选择目录/文件、保存文件、确认框）。
================================================================================
  相对重构前的修正：
    1) 原来用 BrowserWindow.getFocusedWindow() —— 当用户从托盘菜单触发、
       或窗口刚失焦时返回 null，于是静默返回 {ok:false, canceled:true}。
       用户看到的是"我刚点了确定却被当作取消了"。
       现在：回退到主窗口，保证对话框一定挂载在正确父窗口上。
    2) 补上保存文件对话框与原生确认框（替代渲染层的 window.confirm，
       后者在 Electron 中样式突兀且会阻塞渲染进程）。
    3) 所有分支都返回结构化结果，便于前端区分"取消"与"失败"。
================================================================================
*/
const { dialog, BrowserWindow } = require('electron');

const logging = require('../logging');

/**
 * 统一的异常兜底包装。
 *
 * 本模块此前直接用 ipcMain.handle 注册，没有任何 try/catch：
 * 对话框抛出时异常会冒泡成渲染层的 "Error invoking remote method" 原始堆栈，
 * 而返回值也没有 ok:false 的分支 —— 与全项目「invoke 统一返回 {ok,...}」的约定不一致。
 * 这里补齐，使调用方永远能拿到结构化结果。
 *
 * @param {string} channel
 * @param {Function} fn
 * @returns {(event:any, ...args:any[]) => Promise<any>}
 */
function handler(channel, fn) {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      logging.log('error', `[dialog] ${channel} 失败: ${e.message}`);
      return { ok: false, canceled: true, message: `对话框打开失败: ${e.message}` };
    }
  };
}

/** 取可用的父窗口：优先聚焦窗口，其次主窗口 */
function parentWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return all[0] || null;
}

function registerIpc(ipcMain) {
  ipcMain.handle('dialog:select-folder', handler('dialog:select-folder', async (_e, opts = {}) => {
    const win = parentWindow();
    const config = {
      title: opts.title || '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: opts.defaultPath || undefined,
      buttonLabel: opts.buttonLabel || undefined
    };
    const result = win
      ? await dialog.showOpenDialog(win, config)
      : await dialog.showOpenDialog(config);

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true, message: '已取消' };
    }
    return { ok: true, canceled: false, path: result.filePaths[0] };
  }));

  ipcMain.handle('dialog:select-file', handler('dialog:select-file', async (_e, opts = {}) => {
    const win = parentWindow();
    const config = {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: Array.isArray(opts.filters) && opts.filters.length
        ? opts.filters
        : [{ name: '所有文件', extensions: ['*'] }],
      defaultPath: opts.defaultPath || undefined,
      buttonLabel: opts.buttonLabel || undefined
    };
    const result = win
      ? await dialog.showOpenDialog(win, config)
      : await dialog.showOpenDialog(config);

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true, message: '已取消' };
    }
    return { ok: true, canceled: false, path: result.filePaths[0] };
  }));

  /* 保存文件：渲染层传入默认文件名与过滤器 */
  ipcMain.handle('dialog:save-file', handler('dialog:save-file', async (_e, opts = {}) => {
    const win = parentWindow();
    const config = {
      title: opts.title || '保存文件',
      defaultPath: opts.defaultPath || undefined,
      filters: Array.isArray(opts.filters) && opts.filters.length
        ? opts.filters
        : [{ name: '所有文件', extensions: ['*'] }]
    };
    const result = win
      ? await dialog.showSaveDialog(win, config)
      : await dialog.showSaveDialog(config);

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, message: '已取消' };
    }
    return { ok: true, canceled: false, path: result.filePath };
  }));

  /*
    原生确认框：替代 window.confirm。

    返回值的语义修正（原实现有真实缺陷）：
      原来判定 `confirmed: result.response === config.defaultId` ——
      把「默认按钮」当成了「确定按钮」。这两者**不是一回事**：
      对破坏性操作，正确的做法是把**默认**设为「取消」（defaultId:0），
      但「确定」按钮仍然应当能返回 confirmed:true。
      按原逻辑，defaultId:0 时用户点「确定」会得到 confirmed:false，
      于是调用方（如安装前的覆盖确认）永远拿不到同意，确认框形同失效。
      现在按惯例取**最后一个按钮**为「确定」，与 defaultId 解耦。
  */
  ipcMain.handle('dialog:confirm', handler('dialog:confirm', async (_e, opts = {}) => {
    const win = parentWindow();
    const buttons =
      Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons : ['取消', '确定'];
    const confirmId = buttons.length - 1;
    const config = {
      type: opts.type || 'question',
      title: opts.title || '请确认',
      message: String(opts.message || '确定要继续吗？'),
      detail: opts.detail ? String(opts.detail) : undefined,
      buttons,
      defaultId: Number.isInteger(opts.defaultId) ? opts.defaultId : confirmId,
      cancelId: Number.isInteger(opts.cancelId) ? opts.cancelId : 0,
      noLink: true
    };
    const result = win
      ? await dialog.showMessageBox(win, config)
      : await dialog.showMessageBox(config);

    return {
      ok: true,
      confirmed: result.response === confirmId,
      response: result.response,
      confirmId
    };
  }));
}

module.exports = { registerIpc, parentWindow };
