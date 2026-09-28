/*
================================================================================
技术文档：src/main/paths.js
职责：主进程全部文件系统路径的**唯一解析入口**。
================================================================================
  重构前的严重问题：
    1) 存在三个互不相同的"日志目录"：
         paths.getLogDir()      → userData/logs
         paths.getMaibotPaths() → userData/maibot-data/logs
         logging.js             → userData/maibot.log（连目录都不是）
       前端拿到的路径与实际写入位置对不上。
    2) getMaibotPaths() 每次调用都 mkdirSync 五个目录 —— 连读接口都有副作用。
    3) 服务日志导出由主进程拼接字符串、渲染进程落文件，写出的是可执行 HTML
       （.html 扩展名 + 后端内容 = 存储型 XSS 风险）。

  本模块只做「路径计算」，不产生任何副作用（不创建目录）。
  需要目录存在的地方显式调用 ensureDir()。
================================================================================
*/
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

/** userData 根目录（Electron 保证存在） */
function userDataDir() {
  return app.getPath('userData');
}

/** 应用级日志目录（唯一的日志目录） */
function appLogDir() {
  return path.join(userDataDir(), 'logs');
}

/** 主进程应用日志文件 */
function appLogFile() {
  return path.join(appLogDir(), 'launcher.log');
}

/** 后端设置持久化文件 */
function settingsFile() {
  return path.join(userDataDir(), 'backend-settings.json');
}

/** 启动器托管数据根目录（models / records / cache / exports） */
function dataRoot() {
  return path.join(userDataDir(), 'maibot-data');
}

/** 导出目录（用户从工具箱导出的配置文件等，统一收纳） */
function exportDir() {
  return path.join(dataRoot(), 'exports');
}

/**
 * 返回启动器管理的全部数据目录（纯计算，不创建）。
 *
 * 字段清理说明：此前同时返回 base/dataDir、logsDir/logDir 等**同值别名**，
 * 以及指向根设置文件的 settingsPath —— 经全量调用点核查，
 * dataDir / settingsPath / logDir 三个字段**无任何调用方**，已移除。
 * logsDir 保留（指向唯一的应用日志目录），不再是第二个日志目录。
 */
function getMaibotPaths() {
  const base = dataRoot();
  return {
    base,
    logsDir: appLogDir(),
    modelsDir: path.join(base, 'models'),
    recordsDir: path.join(base, 'records'),
    cacheDir: path.join(base, 'cache'),
    exportDir: exportDir()
  };
}

/** 需要预先创建的目录清单 */
function managedDirs() {
  const p = getMaibotPaths();
  return [p.base, p.logsDir, p.modelsDir, p.recordsDir, p.cacheDir, p.exportDir];
}

/** 确保某个路径存在（文件则创建其父目录） */
function ensureDir(target, { asFile = false } = {}) {
  const dir = asFile ? path.dirname(target) : target;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 确保全部托管目录存在；在 app ready 后调用一次即可 */
function ensureManagedDirs() {
  const created = [];
  for (const dir of managedDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    } catch (e) {
      console.error('[paths] 创建目录失败:', dir, e.message);
    }
  }
  return created;
}

/**
 * 系统临时工作目录 —— 安装/升级过程中解压等操作一律在此进行。
 * 关键：绝不能在目标安装目录内创建临时目录，
 * 否则"把安装目录整体搬走做备份"的步骤会把临时文件一起搬走（详见 github.js）。
 */
function workDir(prefix = 'maibot') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return dir;
}

/** 安全删除临时目录 */
function removeDir(target) {
  if (!target) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    console.warn('[paths] 删除目录失败:', target, e.message);
  }
}

module.exports = {
  userDataDir,
  appLogDir,
  appLogFile,
  settingsFile,
  dataRoot,
  exportDir,
  getMaibotPaths,
  managedDirs,
  ensureDir,
  ensureManagedDirs,
  workDir,
  removeDir
};
