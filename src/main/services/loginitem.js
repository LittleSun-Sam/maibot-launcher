/*
================================================================================
技术文档：src/main/services/loginitem.js
职责：Windows 登录自启动注册（真实读写系统登录项）。
================================================================================
  为什么需要这个文件：
    重构后的设置页里有「开机登录自启」开关，constants.js 里有
    general.launchOnLogin 默认值，settings.js 里也做了布尔校验 ——
    但**主进程从来没有任何代码读取它**。
    用户拨动开关只会写进 backend-settings.json，系统层面毫无变化，
    是个纯装饰的假开关。本模块把它接到真实的系统登录项上。

  Electron 的 app.setLoginItemSettings 在 Windows 上写的是注册表
  HKCU\...\CurrentVersion\Run；在 macOS 上是 Login Items。
  因此这里以「系统真实状态」为准，而不是以设置文件里的意图为准 ——
  用户可能在系统设置里手动关掉自启，两者会不一致。

  设计要点：
    1) apply() 是**幂等**的：无论调用多少次，结果都与期望值一致。
       启动时调用一次即可修正"设置文件说开启、系统里其实没开"的漂移。
    2) 开发模式下 Electron 可执行文件与真实安装版不同路径，
       注册 dev 路径毫无意义且会污染注册表，所以显式跳过并说明原因。
    3) 只读查询与写入分离，UI 可以只查状态而不产生副作用。
================================================================================
*/
const { app } = require('electron');

const logging = require('../logging');

/** 是否运行在打包后的应用内（而非 npm run dev / electron .） */
function isPackaged() {
  return app.isPackaged === true;
}

/**
 * 开发模式判定。
 * app.isPackaged 为 false 时说明是源码直跑，此时注册自启会指向
 * electron.exe + 项目路径，重启后行为不可预期。
 */
function canRegister() {
  return isPackaged();
}

/**
 * 计算要注册的可执行文件与参数。
 * 打包后 exePath 就是应用自身；开发模式下不存在有意义的注册目标。
 *
 * 参数从空开始：这里曾无条件 push('--launched-at-login')，
 * 但全项目**没有任何代码读取该参数** —— 它只会污染注册表里的启动命令行。
 * 若将来确实需要区分"自启拉起"与"手动启动"（例如自启时不弹主窗口），
 * 再加参数并在 main.js 里真正消费它。
 */
function targetPaths() {
  return { exePath: process.execPath, args: [] };
}

/**
 * 直接读 Windows 注册表 Run 键，判断本项目是否已注册自启。
 *
 * 为什么不能只依赖 app.getLoginItemSettings()：
 *   实测（打包版、Electron 37.10.3、Windows 10 19045）在
 *   setLoginItemSettings({openAtLogin:true}) 之后**立即**回读，
 *   openAtLogin 仍返回 false，尽管注册表项已经写入成功。
 *   旧实现据此判定"系统未接受该设置"并 return ok:false ——
 *   功能明明生效了却给用户报错，属于典型的假阴性。
 *
 * 注册表才是操作系统的真实状态，所以写入后用注册表复核。
 *
 * @returns {boolean|null} true/false 表示确定状态，null 表示无法判定
 */
function readRegistryRunKey() {
  if (process.platform !== 'win32') return null;
  try {
    /* 延迟 require：非 Windows 或读取失败时不影响其他平台 */
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    );
    /*
      Electron 在 Windows 上写入的值名形如 "electron.app.<AppName>"，
      值内容是 exe 路径（可能带参数）。这里以"值里出现当前 exe 路径"为准，
      比匹配固定值名更稳（应用改名后依然有效）。
    */
    const exe = process.execPath.toLowerCase();
    return out
      .split(/\r?\n/)
      .some((line) => line.toLowerCase().includes(exe));
  } catch (_) {
    return null;
  }
}

/**
 * 查询系统当前的登录自启状态。
 * @returns {{ok:boolean, supported:boolean, enabled:boolean, message:string, exePath?:string}}
 */
function getState() {
  try {
    const settings = app.getLoginItemSettings();
    const viaApi = Boolean(settings.openAtLogin);
    const viaReg = readRegistryRunKey();
    /* 注册表结果优先：它是操作系统的真实状态 */
    const enabled = viaReg === null ? viaApi : viaReg;

    return {
      ok: true,
      supported: canRegister(),
      enabled,
      exePath: process.execPath,
      message: canRegister()
        ? enabled
          ? '已注册开机自启'
          : '未注册开机自启'
        : '开发模式下不注册系统登录项（避免把 electron.exe 写进注册表）'
    };
  } catch (e) {
    logging.log('warn', `[loginitem] 读取登录项状态失败: ${e.message}`);
    return { ok: false, supported: false, enabled: false, message: e.message };
  }
}

/**
 * 应用登录自启设置（幂等）。
 * @param {boolean} enabled 期望状态
 * @returns {{ok:boolean, supported:boolean, enabled:boolean, changed:boolean, message:string}}
 */
function apply(enabled) {
  const want = Boolean(enabled);

  if (!canRegister()) {
    const cur = getState();
    return {
      ok: true,
      supported: false,
      enabled: cur.enabled,
      changed: false,
      message: cur.message
    };
  }

  try {
    const before = getState().enabled;
    const { exePath, args } = targetPaths();

    app.setLoginItemSettings({
      openAtLogin: want,
      path: exePath,
      args
    });

    /*
      用注册表复核真实结果，而不是 app.getLoginItemSettings()。
      见 readRegistryRunKey() 的说明：Electron 在 Windows 上回读有滞后，
      直接采信会得到假阴性。
    */
    const viaReg = readRegistryRunKey();
    const after = viaReg === null ? Boolean(app.getLoginItemSettings().openAtLogin) : viaReg;
    const changed = before !== after;

    if (after !== want) {
      /*
        写入后状态仍不符：注册表读取失败时可能只是读不到，
        因此区分"确定不符"与"无法确认"，不轻易断言失败。
      */
      const uncertain = viaReg === null;
      const message = uncertain
        ? `已执行${want ? '开启' : '关闭'}操作，但无法回读注册表确认结果`
        : `系统未接受该设置（期望 ${want}，实际 ${after}）`;
      logging.log(uncertain ? 'warn' : 'error', `[loginitem] ${message}`);
      return {
        ok: uncertain,
        supported: true,
        enabled: after,
        changed,
        uncertain,
        message
      };
    }

    const message = want ? '已设置为开机自启' : '已取消开机自启';
    if (changed) logging.log('info', `[loginitem] ${message}（${exePath}）`);
    return { ok: true, supported: true, enabled: after, changed, message };
  } catch (e) {
    logging.log('error', `[loginitem] 设置登录项失败: ${e.message}`);
    /*
      不要臆断 enabled:false。写入抛异常时系统的真实状态**未知**，
      谎报"已关闭"会让开关显示成关的，而注册表里其实还开着。
      回读一次真实状态；若也读不到，退回调用前的状态。
    */
    let cur = null;
    try {
      cur = getState();
    } catch (_) {
      /* 连状态都读不到：交给下方兜底 */
    }
    return {
      ok: false,
      supported: true,
      enabled: cur && cur.ok ? cur.enabled : null,
      changed: false,
      uncertain: true,
      message: `设置失败：${e.message}`
    };
  }
}

/**
 * 启动时对齐系统状态与设置文件的意图。
 * @param {boolean} desired
 */
function reconcile(desired) {
  const cur = getState();
  /* 记一行诊断：开机自启没生效时，这是判断"卡在哪一步"的第一手信息 */
  logging.log(
    'info',
    `[loginitem] 启动对齐检查: 期望=${Boolean(desired)} 系统=${cur.enabled} 可用=${cur.supported} 原因=${cur.message}`
  );
  if (!cur.ok || !cur.supported) return cur;
  if (cur.enabled === Boolean(desired)) return cur;
  logging.log(
    'info',
    `[loginitem] 检测到状态漂移（系统=${cur.enabled}，设置=${Boolean(desired)}），正在对齐`
  );
  return apply(desired);
}

module.exports = { getState, apply, reconcile, canRegister };
