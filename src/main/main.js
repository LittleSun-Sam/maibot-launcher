/*
================================================================================
技术文档：src/main/main.js
职责：Electron 主进程入口（Bootstrap）。
================================================================================
  启动顺序：
    1) 单实例锁（第二次启动只聚焦已有窗口）
    2) 注册基础 IPC（窗口信息 / 应用信息 / 退出）
    3) app ready → 初始化日志 → 统一路径 → 主窗口 → 托盘 → 服务层 IPC
    4) 启动服务看门狗（真实存在性探测 + 退避重启）
    5) 退出时：先杀子进程树并等待真正结束，再落盘日志，最后退出

  相对重构前的修正：
    - 移除 execSync('chcp 65001')：每次启动都会弹一个控制台窗口，且只影响子 shell
      代码页，对 Electron 自身 stdout 无效。中文乱码的正解是给子进程设置
      PYTHONIOENCODING/PYTHONUTF8（见 services/process.js）。
    - 移除 autoplay-policy 开关：本项目无任何音频播放，属于无意义放宽。
    - 退出流程改为 await 等待子进程真正结束，解决"绿色版残留后台进程"。
    - uncaughtException 不再仅仅 console.error，而是记录到持久日志。
================================================================================
*/
/*
  nativeTheme 不再直接使用：主题的读写与推送统一收口在 windows.js
  （applyPersistedTheme / applyTheme / initThemeBridge），
  这里只调用入口，避免两处各写一份 themeSource 而互相覆盖。
*/
const { app, BrowserWindow, ipcMain } = require('electron');

const logging = require('./logging');
const paths = require('./paths');
const windows = require('./windows');
const tray = require('./tray');
const services = require('./services');
const { APP } = require('./constants');

/* ============================================================================
 *  0-a) userData 重定向（必须在 requestSingleInstanceLock 之前）
 *  ---------------------------------------------------------------------------
 *  为什么需要：
 *    1) 自动化冒烟测试需要一个干净的、用完即删的数据目录，
 *       否则会污染用户真实设置，且受"单实例锁"影响而无法与已运行实例共存。
 *    2) 便携版部署时用户可以把数据放到 U 盘/程序目录，
 *       只需设置环境变量 MAIBOT_LAUNCHER_USER_DATA，无需改动代码。
 *
 *  注意：单实例锁是基于 userData 路径生成的，
 *  因此必须在申请锁之前完成重定向，否则两个实例会争夺同一个锁。
 * ========================================================================== */
(function redirectUserData() {
  const override = process.env.MAIBOT_LAUNCHER_USER_DATA;
  if (!override || typeof override !== 'string' || !override.trim()) return;
  try {
    const fs = require('fs');
    const target = override.trim();
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (e) {
    /* 重定向失败不应阻止启动，退回默认路径即可 */
    process.stderr.write(`[main] userData 重定向失败，使用默认路径: ${e.message}\n`);
  }
})();

/* ============================================================================
 *  0-b) 进程级异常兜底
 *  重构前只 console.error，且被劫持后的 console 本身就可能出错。
 *  这里先接住异常，再交给持久日志。
 * ========================================================================== */
process.on('uncaughtException', (error) => {
  try {
    logging.log('error', `[uncaughtException] ${error?.stack || error}`);
  } catch (_) {
    /* 日志系统本身不可用时退回 stderr，绝不二次抛出 */
    process.stderr.write(`uncaughtException: ${error}\n`);
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    logging.log('error', `[unhandledRejection] ${reason instanceof Error ? reason.stack : reason}`);
  } catch (_) {
    process.stderr.write(`unhandledRejection: ${reason}\n`);
  }
});

/* ============================================================================
 *  1) 单实例锁
 * ========================================================================== */

/*
  任务栏图标 / 分组标识。
  ★ 这两行是"图标是 Electron 默认图标"的直接原因：
    Windows 的任务栏按钮既不只看窗口图标（WM_SETICON），也看进程的
    AppUserModelID。开发模式下进程是 electron.exe，没有自己的 AUMID，
    Windows 就把整个进程按 electron.exe 处理 —— 任务栏显示的、
    以及"固定到任务栏"存的，都是 Electron 的默认原子图标，
    窗口上设的 icon 只影响标题栏那一小块。
  electron-builder 打包时会用 package.json 的 build.appId 自动写这个 ID，
    但开发模式下没人替你写，所以必须自己设。

  ★ 开发模式必须用**不同的** AUMID：
    实测（把 AUMID 写成和正式版一样的 com.maibot.launcher）后，
    任务栏出现的是这个 ID 对应的**旧缓存图标**（一个麦麦吉祥物），
    我们新画的 build/icon.ico 根本不显示 —— 因为 Windows 认为
    "这个 ID 就是那个已装好的应用"，直接取它记住的图标。
    加 .dev 后缀后，未注册的 AUMID 会让 Windows 回退到窗口图标
    （也就是我们 .ico 里的 7 帧），开发时才是所见即所得。
  正式版仍然用 build.appId，保证任务栏分组、快捷方式都指向同一个应用。
*/
const APP_ID = 'com.maibot.launcher';
app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  /* 已有实例在运行：立即退出，由已有实例处理 second-instance */
  app.quit();
} else {
  app.on('second-instance', () => {
    windows.focusMainWindow();
  });

  bootstrap();
}

/* ============================================================================
 *  2) 正常启动流程
 * ========================================================================== */
function bootstrap() {
  /* 基础 IPC 必须在窗口创建前注册，否则早期 invoke 会落空 */
  services.registerBaseIpc();

  /*
    未处理 rejection 的兜底。
    ──────────────────────────────────────────────────────────────────
    下面这整段启动逻辑（建窗口、起托盘、注册 IPC、对齐开机自启…）
    以前没有任何 catch：任何一步抛错都会变成"进程在跑、但没有窗口"，
    而 Electron 只把异常打到 stderr —— 用户根本看不到，
    现象就是"点了图标什么都没发生"。这里至少在屏幕上给出原因。
  */
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    console.error('[main] 未处理的 Promise 异常:', msg);
    try {
      require('electron').dialog.showErrorBox('启动器遇到未处理的错误', String(msg).slice(0, 1500));
    } catch (_) {
      /* 连弹框都失败就只能靠 stderr 了 */
    }
  });

  app.whenReady().then(async () => {
    /*
      主题：把用户上次的选择应用到原生层（UI v3 深浅双主题）。
      ──────────────────────────────────────────────────────────────────
      ⚠️ 这里原来是硬编码的 `nativeTheme.themeSource = 'light'`，
      它会把界面上任何主题切换都压回浅色，也正是"重启后主题丢失"的根因：
      用户选了深色，下次启动这一行又强制浅色。
      现在改为从设置读取（general.theme，默认 'system'）：
        · 'system' —— 跟随 Windows（nativeTheme.shouldUseDarkColors）
        · 'light' / 'dark' —— 保持用户的手动选择
      必须放在建窗口之前，否则深色用户会先看到一帧浅色。
    */
    windows.applyPersistedTheme();

    /* 日志系统必须先就绪，后续所有模块的日志才有落点 */
    logging.initLogging();
    logging.attachConsole();

    /* 统一创建托管目录（唯一一次副作用，集中在启动阶段） */
    paths.ensureManagedDirs();

    console.log(`[main] ${APP.name} v${app.getVersion()} 启动`, {
      userData: app.getPath('userData'),
      logFile: logging.logFilePath(),
      electron: process.versions.electron,
      node: process.versions.node
    });

    /*
      仓库解析探针：只探测 GitHub，**不建窗口**，验证完立刻退出。
      必须放在 createMainWindow() 之前 —— 否则会为一个纯网络检查
      白拉起整个界面（托盘、服务层、渲染层全都会跑一遍）。
      判定用环境变量而非 argv：沙箱化 preload 读不到自定义命令行开关（实测）。
    */
    if (process.env.MAIBOT_LAUNCHER_GITHUB_PROBE === '1') {
      runGithubProbe();
      return;
    }

    /* 主窗口 */
    windows.createMainWindow();

    /*
      IPC 契约探针（仅测试用，由环境变量 MAIBOT_LAUNCHER_IPC_PROBE=1 触发）。
      registerBaseIpc 只能保证"注册动作没抛异常"，
      无法证明渲染层真的能调通每个通道、返回结构也对。
      selfcheck 只验证页面渲染，这一层缺口由 scripts/verify-ipc.mjs 补上。
    */
    if (process.env.MAIBOT_LAUNCHER_IPC_PROBE === '1') setupIpcProbe();

    /* 系统托盘 */
    const trayHandlers = {
      onOpen: () => windows.focusMainWindow(),
      /*
        托盘「重启启动器」必须先走完清理。
        app.relaunch() 只是**安排**下次启动，app.exit(0) 是立刻退进程 ——
        两者之间原实现没有任何停止服务的步骤，于是 MaiBot / SnowLuma
        会变成孤儿进程继续占着 8000 / 5099，重启后的启动器再拉它们时端口冲突，
        用户看到的是"重启之后起不来了"。这里复用退出流程的同一套清理。
      */
      onRestart: async () => {
        windows.setQuitting(true);
        services.stopWatchdog();
        try {
          await services.shutdownAll({ timeoutMs: 6000 });
          await logging.flush();
        } catch (e) {
          console.warn('[main] 重启前清理异常:', e?.message || e);
        }
        app.relaunch();
        app.exit(0);
      },
      onQuit: () => {
        windows.setQuitting(true);
        app.quit();
      }
    };

    /*
      ⚠️ 必须检查返回值：createTray() 在"图标缺失"或"Tray 构造抛错"时返回 null，
      而 windows.js 的 close 处理器默认把关闭按钮变成"隐藏到托盘"。
      两者叠加就是：用户点关闭 → 窗口消失 → 没有托盘 → 找不到入口；
      如果渲染层此刻也没起来，连界面里的退出入口都点不到，
      只剩任务栏右键一条路（不算崩溃，但用户会认为应用不见了）。
      所以托盘失败时降级为"关闭窗口即退出"，保证出口始终存在。
    */
    const trayInstance = tray.createTray(trayHandlers);
    if (!trayInstance) {
      windows.setCloseToTray(false);
      logging.log(
        'error',
        '[main] 托盘创建失败：已将关闭行为降级为「关闭窗口即退出」' +
          '（日志目录可从设置页打开；也可用任务栏右键 → 关闭窗口退出）'
      );
    }

    /* 服务层 IPC（进程 / 扫描 / LLM / GitHub / 数据 / 设置 / 日志 / 系统 / 前置检查 / 终端） */
    services.registerServiceIpc();

    /* 真实看门狗 */
    services.startWatchdog();

    /*
      开机自启对齐：把设置文件里的意图同步到系统登录项。
      用户可能在 Windows 设置里手动关掉过自启，两者会不一致；
      放在这里做一次幂等对齐，保证界面显示的状态就是系统真实状态。
    */
    services.reconcileLoginItem();

    console.log('[main] 主窗口 + 托盘 + 服务层已就绪');

    /*
      自动拉起服务（general.autoStart）。
      必须放在窗口创建之后：启动过程会产生 started/failed 事件，
      渲染层订阅后才能收到并提示用户。
      延迟 1.2s 是为了让渲染层完成挂载与事件订阅，避免用户
      "服务已经在跑，但界面显示未运行"。
    */
    setTimeout(async () => {
      try {
        const summary = await services.autoStartConfigured();
        if (summary.started.length || summary.failed.length) {
          console.log('[main] 自动启动结果', summary);
        }
      } catch (e) {
        logging.log('warn', `[main] 自动启动异常: ${e.message}`);
      }
    }, 1200);
  });

  /* macOS：Dock 点击时若无窗口则重建 */
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createMainWindow();
  });

  /* 保持托盘常驻，关窗不退出 */
  app.on('window-all-closed', () => {
    /* 有意留空：托盘应用不随窗口关闭而退出 */
  });

  registerQuitFlow();
}

/* ============================================================================
 *  2.5) IPC 契约探针（仅测试路径）
 * ==========================================================================
 *  由 `--ipc-probe` 开启，配合 scripts/verify-ipc.mjs 使用。
 *  渲染层的探针脚本通过 additionalArguments 传入（见 windows.js 读取
 *  MAIBOT_LAUNCHER_IPC_PROBE），执行完把结果发到 'test:ipc-report'。
 *  这里只负责打印成机器可解析的一行，然后退出进程。
 *  生产运行不会进入这段代码。
 * ========================================================================== */
function setupIpcProbe() {
  try {
    ipcMain.on('test:ipc-report', (_e, report) => {
      console.log(`__IPC_REPORT__${JSON.stringify(report || {})}__END__`);
      /* 给 stdout 一点时间 flush，再退出 */
      setTimeout(() => app.exit(0), 250);
    });
  } catch (e) {
    console.error('[main] IPC 探针注册失败:', e?.message || e);
  }
}

/* ============================================================================
 *  仓库解析探针（仅测试用，由 MAIBOT_LAUNCHER_GITHUB_PROBE=1 触发）
 * --------------------------------------------------------------------------
 *  为什么需要它：
 *    resolveRepo() 依赖 Electron 主进程的 fetch 去探测 GitHub，
 *    纯 Node 环境跑不了同样的行为（这也是为什么不能用单元测试覆盖）。
 *    而它要解决的正是"老配置里留着已改名的仓库"这类真实故障。
 *
 *  ⚠️ 但**不能直连真实 API**：未认证配额只有 60 次/小时，
 *    一旦用尽（返回 403），resolveRepo 出于"403 不能证明仓库不存在"的
 *    保守策略会沿用配置值，断言就报出 switched=false 的**假失败**。
 *    实测撞到过（remaining=0），该测试因此长期不稳定。
 *    现在改为：测试先用 MAIBOT_LAUNCHER_GITHUB_API 指一个本地假 API，
 *    这里再针对假 API 的固定行为断言，完全离线且确定。
 *
 *  覆盖的场景与假 API 的约定（见 scripts/verify-repo-fallback.mjs）：
 *    1) MaiBot/MaiBot        → 404 → 必须自动切到候选仓库
 *    2) not a repo!!         → 非法输入，不发请求 → 回退默认仓库
 *    3) Mai-with-u/MaiBot    → 200 → 必须原样使用，不能"多此一举"切换
 *    4) SnowLuma/SnowLuma    → 200 → 按 snowluma 候选解析
 *    5) rate-limit-test/*    → 403 → **必须沿用配置值**（网络抖动不代表仓库没了）
 *
 *  输出一行机器可解析的结果，供 scripts/verify-repo-fallback.mjs 断言。
 * ========================================================================== */
async function runGithubProbe() {
  const out = { cases: [], errors: [] };
  try {
    const github = require('./services/github');

    const cases = [
      { name: 'stale-old-name', repo: 'MaiBot/MaiBot', kind: 'maibot' },
      { name: 'invalid-name', repo: 'not a repo!!', kind: 'maibot' },
      { name: 'valid-primary', repo: 'Mai-with-u/MaiBot', kind: 'maibot' },
      { name: 'snowluma-default', repo: '', kind: 'snowluma' },
      /*
        403（限流/被拒）必须沿用用户配置的仓库，不能静默换成官方仓库 ——
        否则一次网络抖动就会把用户的 fork 换掉，变成"装错项目"。
        假 API 对这个前缀固定返回 403。
      */
      { name: 'rate-limited', repo: 'rate-limit-test/keep-me', kind: 'maibot' }
    ];

    for (const c of cases) {
      try {
        const r = await github.resolveRepo(c.repo, c.kind);
        out.cases.push({ name: c.name, input: c.repo, repo: r.repo, switched: r.switched });
      } catch (e) {
        out.errors.push(`${c.name}: ${e.message}`);
      }
    }
  } catch (e) {
    out.errors.push(`探针执行失败: ${e.message}`);
  }
  console.log(`__GITHUB_PROBE__${JSON.stringify(out)}__END__`);
  setTimeout(() => app.exit(0), 250);
}

/* ============================================================================
 *  3) 退出流程 —— 关键：必须等子进程真正结束
 * ========================================================================== */
let quitting = false;
/** 清理是否已经跑完（只有它跑完才允许真正退进程） */
let cleanupDone = false;

function registerQuitFlow() {
  app.on('before-quit', (event) => {
    windows.setQuitting(true);
    services.stopWatchdog();

    /*
      退出流程的重入保护。
      原实现是"二次进入就直接 return"，也就是不再 preventDefault ——
      Electron 会立刻退进程，把正在进行的 taskkill 与日志 flush 打断，
      子进程可能残留、最后几行日志丢失。
      现在：清理没跑完就一直阻止默认退出，真正的退出只由下面 finally 里的
      app.exit(0) 触发（那是唯一出口）。
    */
    if (quitting) {
      if (!cleanupDone) event.preventDefault();
      return;
    }
    quitting = true;

    /* 阻止默认退出，先完成清理再真正退出 */
    event.preventDefault();

    console.log('[main] 开始优雅退出：停止全部子进程…');

    services
      .shutdownAll({ timeoutMs: 6000 })
      .then(() => logging.flush())
      .catch((e) => console.warn('[main] 退出清理出现异常:', e?.message || e))
      .finally(() => {
        cleanupDone = true;
        console.log('[main] 清理完成，退出进程');
        app.exit(0);
      });
  });
}
