/*
================================================================================
技术文档：src/main/services/index.js
职责：服务层装配 —— IPC 通道注册、模块热重载友好加载、事件转发、生命周期。
================================================================================
  相对重构前的修正：
    1) 删除假的 log:report 处理器
       原实现：`ipcMain.on('log:report', (_e,{level,msg}) => { if (level&&msg)
       logging.getLogs(1); })` —— 用"读一行日志"冒充"写一行日志"，
       而真正正确的 logging.registerRendererLogIpc() 从未被调用。
       现在：渲染层日志真的落盘（见 base/日志 分组）。
    2) 事件转发从"各处手动 broadcast" 收敛为 bus → sendToRenderer 单点。
       LLM 流事件现在携带 requestId（渲染层据此隔离并发请求）。
    3) 看门狗从假的 getWatchdogStatus() 改为真实实现（process.startWatchdog）。
    4) 新增：终端写入/尺寸/关闭、端口占用检查、磁盘空间、数据分类元数据、
       取消扫描、中止 LLM、系统信息、打开日志目录等真实可用的通道。
    5) 所有 handle 统一包裹错误处理，避免异常以 "Error invoking remote method"
       的原始堆栈形式暴露到渲染层。
================================================================================
*/
const { ipcMain, shell, app } = require('electron');

const logging = require('../logging');
const paths = require('../paths');
const windows = require('../windows');
const { APP, DEFAULT_SETTINGS, DEFAULT_PORTS, MIN_PYTHON, REPOS } = require('../constants');

/* ============================================================================
 *  模块加载（静态字面量映射表）
 *  ---------------------------------------------------------------------------
 *  必须写成静态 require 字面量，不能写 require(`./${name}`)：
 *  动态 require 无法被 esbuild 静态分析，会被原样保留成运行时 require，
 *  打包后 dist/ 缺少兄弟模块 → "Cannot find module" 或服务静默失效。
 *  （这个坑原项目已经踩过一次，注释也写了，这里继续保持正确做法。）
 * ========================================================================== */
const MODULES = {
  process: () => require('./process'),
  terminal: () => require('./terminal'),
  scanner: () => require('./scanner'),
  llm: () => require('./llm'),
  github: () => require('./github'),
  data: () => require('./data'),
  settings: () => require('./settings'),
  system: () => require('./system'),
  prereq: () => require('./prereq'),
  dialog: () => require('./dialog'),
  loginitem: () => require('./loginitem'),
  notify: () => require('./notify'),
  serviceLog: () => require('./log'),
  /* 新手引导用的环境探测（目录归属 / MaiBot 版本 / Python） */
  envcheck: () => require('./envcheck'),
  /* MaiBot 侧可检测状态（WebUI 登录 Token） */
  maibotConnect: () => require('./maibot-connect'),
  /* 受管麦麦版本：列出磁盘上实际存在的版本 + 真删除（设置页「已安装版本」） */
  versions: () => require('./versions'),
  /*
    启动器**自身**的更新（检查 / 下载安装包 / 启动安装程序）。
    ⚠️ 与 github 分开：github 管的是"被管理的服务"（MaiBot / SnowLuma），
    本模块管的是把启动器自己换成新版本，落点是系统临时目录而非麦麦目录。
  */
  updater: () => require('./updater')
};

/**
 * 把设置里的 general.launchOnLogin 同步到系统登录项（幂等）。
 * 抽成模块级函数是因为 settings:save 与 settings:reset 都要用。
 * 失败只记录日志，不影响设置保存本身的结果 ——
 * 用户的主要意图是"保存设置"，系统登录项属于附带效果。
 */
function syncLoginItem(nextSettings) {
  try {
    const login = mod('loginitem');
    if (!login) return;
    const desired = Boolean(nextSettings?.general?.launchOnLogin);
    login.apply(desired);
  } catch (e) {
    logging.log('warn', `[loginitem] 保存设置时同步失败: ${e.message}`);
  }
}

/** 服务 key → 界面可读名称 */
function serviceLabel(key) {
  const MAP = { maibot: 'MaiBot', snowluma: 'SnowLuma' };
  return MAP[key] || String(key || '服务');
}

/**
 * 按设置决定是否发系统通知。
 * 读取 general.desktopNotify（默认开启）；读取失败时按开启处理 ——
 * 通知属于"宁可多提醒"的场景，静默失败比误发更糟。
 */
function notifyIfEnabled(payload) {
  try {
    const notify = mod('notify');
    if (!notify) return;
    const settings = mod('settings');
    const enabled = settings?.getBackendSettings?.()?.general?.desktopNotify;
    if (enabled === false) return;
    notify.show(payload);
  } catch (e) {
    logging.log('warn', `[notify] 发送失败: ${e.message}`);
  }
}

const loaded = new Map();

/** 懒加载领域模块；失败时记录但不阻塞其他模块 */
function mod(name) {
  if (loaded.has(name)) return loaded.get(name);
  const loader = MODULES[name];
  if (!loader) {
    logging.log('error', `[services] 未知模块: ${name}`);
    loaded.set(name, null);
    return null;
  }
  try {
    const instance = loader();
    loaded.set(name, instance);
    return instance;
  } catch (e) {
    logging.log('error', `[services] 模块 ${name} 加载失败: ${e.stack || e.message}`);
    loaded.set(name, null);
    return null;
  }
}

/* ============================================================================
 *  统一 handler 包装：把异常转换成 {ok:false,message} 而不是抛到渲染层
 * ========================================================================== */
function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      logging.log('error', `[ipc] ${channel} 执行失败: ${e.stack || e.message}`);
      return { ok: false, message: String(e.message || e), channel };
    }
  });
}

/** 单向消息的安全包装 */
function safeOn(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      fn(event, ...args);
    } catch (e) {
      logging.log('error', `[ipc] ${channel} 处理失败: ${e.stack || e.message}`);
    }
  });
}

/* ============================================================================
 *  第 1 组：基础 IPC（窗口 / 应用信息 / 日志 / 退出）
 * ========================================================================== */
function registerBaseIpc() {
  /* ---- 应用信息 ---- */
  safeHandle('app:info', () => ({
    ok: true,
    name: APP.name,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    logFile: logging.logFilePath(),
    defaults: DEFAULT_SETTINGS,
    defaultsMeta: { defaultPorts: DEFAULT_PORTS, minPython: MIN_PYTHON, repos: REPOS }
  }));

  /* ---- 窗口控制 ---- */
  safeHandle('window:minimize', () => {
    const win = windows.getMainWindow();
    win?.minimize();
    return { ok: true };
  });
  safeHandle('window:hide-to-tray', () => {
    windows.getMainWindow()?.hide();
    return { ok: true };
  });
  safeHandle('window:is-maximized', () => {
    const win = windows.getMainWindow();
    return { ok: true, maximized: win ? win.isMaximized() : false };
  });
  /*
    最大化 / 还原切换。
    返回值里带上切换后的新状态：自绘标题栏的按钮图标要立刻换，
    如果只返回 ok，渲染层还得再发一次 window:is-maximized 才知道往哪边换。
  */
  safeHandle('window:maximize', () => windows.toggleMaximize());

  /*
    关闭窗口 = 隐藏到托盘。
    ⚠️ 这里**不能**调 win.close()：windows.js 的 'close' 监听器在非退出状态下
    会 preventDefault 并 hide()，行为等价于 hide-to-tray。
    自绘标题栏的"关闭"按钮与托盘一致地用 hide()，语义更直白，
    也避免将来有人把 close 监听器改成真关闭时行为漂移。
    真正退出仍走 app:exit（见下）。
  */
  safeHandle('window:close', () => {
    windows.getMainWindow()?.hide();
    return { ok: true };
  });

  /* ---- 主题（浅色 / 深色） ---- */
  /*
    主题偏好存在现有设置存储的 general.theme 里，取值：
      'light' | 'dark' —— 用户手动选过
      'system'         —— 跟随 Windows（默认值，见 constants.js）

    返回**两个不同的东西**，调用方别混用：
      preference —— 用户的持久化偏好（三值）。设置页的三选一读它。
      theme      —— 现在**实际生效**的主题（只有 light/dark）。
                    渲染层换 data-theme 读它。

    只返回 theme 时，设置页无法区分"手动选了浅色"和"跟随系统且系统现在是浅色"，
    三选一会把后者的"跟随系统"错显成"浅色"。两个字段的语义必须分开。
  */
  safeHandle('theme:get', () => {
    const win = windows.getMainWindow();
    /*
      ⚠️ 用 resolveThemeFor(偏好) 而不是 resolveTheme()。
      resolveTheme() 读的是 nativeTheme.shouldUseDarkColors —— 那是**系统**的
      明暗，与用户的手动选择无关；两者不一致时（浅色系统上选了深色），
      theme 字段会和 preference 字段互相打架：偏好写着 'dark'，实际主题却报 'light'，
      渲染层按 theme 设 data-theme，于是"设置页显示深色、界面还是浅色"。
      两个字段必须来自同一个解析结果，才可能自洽。
    */
    const preference = windows.getThemePreference();
    const theme = windows.resolveThemeFor(preference);
    return {
      ok: true,
      theme,
      /* 持久化偏好（三值）。设置页的三选一读它 */
      preference,
      /* 字段别名：渲染层/store 两条读法都能取到，避免形状错配导致主题静默不生效 */
      resolved: theme,
      isDark: theme === 'dark',
      maximized: win ? win.isMaximized() : false
    };
  });

  /*
    ⚠️ 这里原本还有两个辅助函数，**已删除**（不是搬走）：
        currentManualTheme()      —— 读设置给出 'light' | 'dark'
        isFollowingSystemTheme()  —— 读设置给出"是否跟随系统"（布尔）
    它们是我第一轮修主题问题时的**绕行方案**：当时 `windows.js` 的启动路径
    把三值偏好压成了布尔（`followSystemTheme() ? 'system' : 'light'`），
    于是 `theme:get` 只能在 index.js 这一侧自己再读一遍设置、把偏好拼回来。

    后来根因在 `windows.js` 被真正修掉了 —— 现在有
        windows.getThemePreference()  → 三值偏好
        windows.resolveThemeFor(pref) → 解析成 light/dark
    两者都从同一处读设置，所以上面那两个函数再没有任何调用者，
    `theme:get` 直接用 windows 这两个即可（见 212-234 行）。

    **保留这段说明而不是直接删干净**，是因为"布尔化偏好"正是审计 M-06 的根因：
    这个坑的位置值得被记住。同时它也是一个通用教训 ——
    绕行方案如果不连同"为什么绕行"一起清理，就会在根因修好后变成死代码，
    而且 lint 会以 `no-unused-vars` 报出来（本轮 `npm run lint` 仅剩的 2 个 error
    就是它们）。绕行被根治后要**连注释一起收掉**，否则下一个人读到的是一套
    已经在别处实现的逻辑。
  */

  /**
   * 读取持久化的主题偏好并**保持三值**（'light' | 'dark' | 'system'）。
   *
   * 与已删除的 isFollowingSystemTheme() 的区别（那是 M-06 的根因）：
   *   那个函数把偏好压成一个布尔（"是否跟随系统"），布尔一进去，
   *   'light' 与 'dark' 就分不开了。
   *
   * 用 mod('settings') 而不是外层作用域里的 settings：
   * 那是个 const，注册在 registerServiceIpc 里，而本函数在 registerBaseIpc
   * 阶段就会被调用（早于它初始化），直接引用会撞上 TDZ 并抛 ReferenceError。
   * 读不到或值非法时按 'system' 处理 —— 那是默认行为，比锁死某一档更贴近预期。
   */
  function inferPersistedThemePreference() {
    try {
      const value = mod('settings')?.getBackendSettings?.()?.general?.theme;
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch (e) {
      logging.log('warn', `[theme] 读取主题偏好失败，按跟随系统处理: ${e.message}`);
      return 'system';
    }
  }

  safeHandle('theme:set', (_e, arg) => {
    /*
      参数兼容两种形状：主题直接作为参数（theme:set('dark')），
      或包在对象里（theme:set({ theme: 'dark' })）。
      渲染层两种写法都很常见，形状错配的后果是"点了切换没反应"且不报错，
      所以这里两种都接住。
    */
    const raw =
      typeof arg === 'string'
        ? arg
        : arg && typeof arg === 'object'
          ? arg.theme ?? arg.value ?? arg.mode
          : undefined;
    const value = String(raw || '').toLowerCase();
    const follow = value === 'system';
    if (!follow && value !== 'light' && value !== 'dark') {
      return { ok: false, message: '主题只能是 light / dark / system' };
    }

    /*
      登记偏好用**三值**，不要再降级成布尔：
      windows.applyPersistedTheme() 要按 light/dark/system 分别决定原生层主题，
      压成"是否跟随系统"之后 light 与 dark 就分不开了（M-06 的根因）。
    */
    windows.setThemePreference(follow ? 'system' : value);
    const theme = windows.applyTheme(follow ? windows.resolveTheme() : value, {
      source: follow ? 'system' : value,
      force: true
    }).theme;

    /*
      持久化。失败要如实告诉调用方：用户点了"深色"却只在本次运行生效，
      重启又变回去，是必须让他知道的（否则会被当成"设置没保存上"的神秘 bug）。

      ⚠️ 同样必须用 mod('settings')：这里的 settings 已由 registerBaseIpc
      执行，而 registerServiceIpc 里的 const settings 那时还没初始化。
    */
    let persisted = true;
    try {
      const settingsSvc = mod('settings');
      if (!settingsSvc?.saveBackendSettings) {
        persisted = false;
      } else {
        settingsSvc.saveBackendSettings(
          { general: { theme: follow ? 'system' : value } },
          { immediate: true }
        );
      }
    } catch (e) {
      persisted = false;
      logging.log('error', `[theme] 主题偏好保存失败: ${e.message}`);
    }

    logging.log('info', `[theme] 主题已切换为 ${theme}${follow ? '（跟随系统）' : ''}`);
    return persisted
      ? { ok: true, theme, following: follow }
      : {
          ok: true,
          theme,
          following: follow,
          persisted: false,
          message: '主题已切换，但没能保存，重启后会恢复上次的选择'
        };
  });

  /*
    系统主题变化监听的初始同步。
    注册在基础 IPC 里（app ready 之前就会调用），这样监听在渲染层挂载前就绪，
    不会漏掉"用户在系统设置里切了深色"这类事件。
    setThemePreference 必须在这里就位：main.js 的 applyPersistedTheme() 依赖它
    决定"跟随系统"还是锁定用户选择（light 与 dark 是两档不同的选择），
    而那是 app ready 之后立刻执行的。
  */
  windows.setThemePreference(inferPersistedThemePreference());
  windows.initThemeBridge();

  /* ---- 退出 ---- */
  safeOn('app:exit', () => {
    windows.setQuitting(true);
    app.quit();
  });

  /* ---- 打开外部链接 / 本地路径 ---- */
  safeHandle('shell:open-external', (_e, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, message: '仅允许打开 http/https 链接' };
    }
    shell.openExternal(url).catch((e) => logging.log('warn', `[shell] 打开链接失败: ${e.message}`));
    return { ok: true };
  });

  safeHandle('shell:open-path', async (_e, target) => {
    if (typeof target !== 'string' || !target.trim()) {
      return { ok: false, message: '路径无效' };
    }
    const fs = require('fs');
    const p = target.trim();
    if (!fs.existsSync(p)) return { ok: false, message: `路径不存在: ${p}` };

    /*
      「打开路径」= 让 Windows 用文件关联去执行它。这是一条链的最后一跳：
        渲染层 → 下载页把 .exe/.ps1 写进某个自己能写的目录 → openPath 执行
      （审计里的 M-02 与 M-11 正是同一条链的两端）。所以这里必须自己判断：
        ① 只允许白名单目录 —— 启动器数据目录 / 用户配置过的目录 /
           启动器自己创建过的目录（安装结果页的「打开位置」靠它） / 系统下载目录；
           系统目录与自启动位置是硬拒绝，优先级高于白名单；
        ② 可执行/脚本类型（.exe/.bat/.ps1/.lnk/…）一律不交给文件关联执行。
      判断与下载页的落地检查共用 github.js 的同一份策略，避免两处口径不一致。
    */
    const guard = mod('github');
    if (!guard || typeof guard.isPathAllowed !== 'function') {
      logging.log('error', '[shell] 路径策略不可用，已拒绝打开路径');
      return { ok: false, message: '路径校验不可用，已拒绝打开' };
    }
    const verdict = guard.isPathAllowed(p, { mode: 'open' });
    if (!verdict.ok) {
      logging.log('warn', `[shell] 拒绝打开路径: ${p}（${verdict.reason}）`);
      return { ok: false, message: verdict.message };
    }
    if (typeof guard.isExecutablePath === 'function' && guard.isExecutablePath(verdict.resolved)) {
      logging.log('warn', `[shell] 拒绝用文件关联打开可执行/脚本文件: ${verdict.resolved}`);
      return { ok: false, message: '该文件属于可执行/脚本类型，已拒绝用「打开」执行它' };
    }
    const err = await shell.openPath(verdict.resolved);
    if (err) return { ok: false, message: err };
    return { ok: true };
  });

  safeHandle('shell:show-item', (_e, target) => {
    if (typeof target !== 'string' || !target.trim()) {
      return { ok: false, message: '路径无效' };
    }
    const fs = require('fs');
    const p = target.trim();
    /*
      原实现无条件返回 {ok:true}：在资源管理器里定位一个不存在的路径时，
      界面照样报"已定位"，用户点了几次都不知道什么都没发生。
      这里如实校验存在性；路径同样走白名单（这个入口只"定位"、不执行，
      所以不拦可执行类型，但仍不允许把系统/自启动位置暴露出来）。
    */
    if (!fs.existsSync(p)) return { ok: false, message: `路径不存在: ${p}` };
    const guard = mod('github');
    if (!guard || typeof guard.isPathAllowed !== 'function') {
      logging.log('error', '[shell] 路径策略不可用，已拒绝定位');
      return { ok: false, message: '路径校验不可用，已拒绝定位' };
    }
    const verdict = guard.isPathAllowed(p, { mode: 'open' });
    if (!verdict.ok) {
      logging.log('warn', `[shell] 拒绝定位路径: ${p}（${verdict.reason}）`);
      return { ok: false, message: verdict.message };
    }
    shell.showItemInFolder(verdict.resolved);
    return { ok: true };
  });

  /* ---- 应用日志 ---- */
  safeHandle('log:get-main', (_e, maxLines) => ({
    ok: true,
    entries: logging.getMainLogs(maxLines),
    file: logging.logFilePath()
  }));

  /* 清空内存缓冲（磁盘历史保留，日志页会明确说明这一点） */
  safeHandle('log:clear-main', () => {
    logging.clearBuffer();
    logging.log('info', '[logging] 内存日志缓冲已由用户清空（磁盘历史保留）');
    return { ok: true, file: logging.logFilePath() };
  });

  /*
    启动器日志导出。
    与服务日志不同，启动器日志**本来就已经在磁盘上**
    （userData/logs/launcher.log），所以"导出"不需要搬文件 ——
    直接返回真实路径，由界面在文件管理器中定位即可，避免复制出第二份副本。
  */
  safeHandle('log:export-main', async () => {
    const file = logging.logFilePath();
    try {
      await logging.flush();
      const fs = require('fs');
      if (!fs.existsSync(file)) {
        return { ok: false, file, message: '日志文件尚未生成' };
      }
      const st = fs.statSync(file);
      return { ok: true, file, size: st.size, message: '已定位到日志文件' };
    } catch (e) {
      return { ok: false, file, message: e.message };
    }
  });

  /*
    启动器日志实时推送。
    服务日志早就有了实时通道，但启动器自身的日志只能靠手动刷新取快照 ——
    而"启动器自己出了问题"恰恰是最需要实时看到的。
    注意：这个订阅注册在 registerBaseIpc（应用刚起来就调用），
    早于任何窗口创建，因此发送时必须判空（windows.sendToRenderer 已处理）。
  */
  logging.onLog((entry) => {
    windows.sendToRenderer('app-log', entry);
  });

  /*
    渲染进程日志上报 —— 真落盘。
    重构前这里用 logging.getLogs(1) 冒充写入，是真·形式主义。

    渲染层的文本是**唯一**能把任意字符串写进日志文件的入口（不可信输入）：
    logging.formatLine 已经把 CR/LF 转义成可见占位，所以渲染层伪造不出
    "整行 [时间戳] [级别] ..."；但自检脚本按"行尾形如
    `[selfcheck] verdict <route>=ok|bad`"搜集判定，一条**以该形状结尾**的
    渲染层日志仍会被数成一个 verdict。`[selfcheck]` 是主进程专用的自检标记，
    渲染层没有任何合法用途，所以在信任边界上直接抹掉 —— 否则伪造的 =ok
    会抢在真实 =bad 之前被 .find() 取走，真实结果被掩盖。
    （彻底根治还要 selfcheck.mjs 把 verdict 正则锚定到日志行首，见提交说明。）
  */
  safeOn('log:report', (_e, payload) => {
    const level = String(payload?.level || 'info').toLowerCase();
    const raw = String(payload?.msg ?? payload?.message ?? '');
    if (!raw) return;
    const msg = raw.replace(/\[\s*selfcheck\s*\]/gi, '[selfcheck-redacted]');
    const allowed = new Set(['info', 'warn', 'error', 'debug']);
    logging.log(allowed.has(level) ? level : 'info', `[renderer] ${msg}`);
  });
}

/* ============================================================================
 *  第 2 组：服务层 IPC
 * ========================================================================== */
/**
 * 把渲染层递上来的启动参数收敛成主进程认可的形状。
 *
 * 只保留"目录"这一项可校验的覆盖，命令与参数全部由 buildStartPayload 推导。
 * @returns {Promise<{payload:object}|{error:string}>}
 */
async function sanitizeStartPayload(key, raw) {
  const fs = require('fs');
  const req = raw && typeof raw === 'object' ? raw : {};
  const cwd = typeof req.cwd === 'string' ? req.cwd.trim() : '';
  if (cwd) {
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch (_) {
      isDir = false;
    }
    if (!isDir) return { error: `启动目录不存在或不是目录：${cwd}` };
  }
  const processSvc = mod('process');
  const derived = await processSvc.buildStartPayload(key, cwd ? { dir: cwd } : {});
  if (!derived) {
    return { error: '找不到可用的启动参数（目录不存在，或目录里没有入口文件）。请检查「设置」里的路径。' };
  }
  return { payload: derived };
}

/* ----------------------------------------------------------------------------
 *  解释器路径收口（审计 item 10 / R1：任意可执行文件被 spawn）
 * ----------------------------------------------------------------------------
 *  为什么必须收口：渲染层递上来的 pythonExe 会被 prereq / envcheck
 *  **直接交给 spawn**（prereq.js runCommand → child_process.spawn(exe, ['-V']
 *  或 ['-m','pip',...])）。shell:false 挡的是 shell 注入，挡不住"指向哪个
 *  可执行文件"—— 只要能往渲染层注入一段脚本，它就能把 pythonExe 指向任意
 *  程序，以启动器身份执行（安装依赖那条还会带渲染层给的 packages 参数）。
 *
 *  只接受三类，其余一律**拒绝并给出可操作错误**（不静默换成 'python'
 *  假装检测过了 —— 那是文档里明确批评过的"静默丢弃用户填的路径"）：
 *    1) 空 —— 默认 'python'，与 prereq 的既有默认一致；
 *    2) 裸命令名 —— python / python3 / python3.12 / pythonw / py（可带 .exe），
 *       仍由系统 PATH 解析，与"默认 python"是同一件事；
 *    3) 显式路径 —— 必须真实存在、是文件、**文件名必须像 Python 解释器**，
 *       扩展名落在 github.js 的可执行类型清单里，且要么位于受管/已配置目录内
 *       （github.js isPathAllowed：麦麦目录、扫描根、数据目录…，
 *        覆盖 <麦麦目录>\.venv\Scripts\python.exe 这种真实部署），
 *       要么与设置里**已记录**的解释器路径一致（用户自己填/选过的那个）。
 *
 *  "文件名必须像 Python 解释器"这一条不能省：isPathAllowed 的 open 白名单
 *  包含启动器数据目录与下载目录，而那正是下载功能能落盘的地方（M-02→M-11
 *  那条链）。只查白名单的话，渲染层把 evil.exe 下载到 userData/maibot-data
 *  下、再当 pythonExe 递进来就能执行。反过来，真实用户选的解释器
 *  （Program Files 下的 python.exe、venv 里的 python.exe）都符合这个形状，
 *  功能不受影响。
 *
 *  但"名字像"只挡得住乱七八糟的文件名，挡不住"投放一个也叫 python.exe 的
 *  恶意文件"—— 所以下载落点（启动器数据目录 + 系统下载目录）还要整片拒绝，
 *  见 downloadHosts()。
 *
 *  @param {unknown} raw
 *  @returns {{ok:true, exe:string}|{ok:false, message:string}}
 */
const PYTHON_EXE_NAME_RE = /^(python|pythonw|py)(\d+(\.\d+)*)?(\.exe|\.cmd|\.bat)?$/i;

/**
 * 下载功能的落点：启动器数据目录（paths.dataRoot）与系统下载目录。
 * 这两处能通过"下载"被写入任意文件，因此绝不能拿它们里面的东西当解释器执行
 * （github.js 的 isPathAllowed(..., {mode:'write'}) 白名单就是这两处 + 安装落点）。
 * @returns {string[]} 存在的根目录列表（取不到就跳过）
 */
function downloadHosts() {
  const out = [];
  try {
    const root = paths.dataRoot();
    if (root) out.push(root);
  } catch (_) {
    /* 非 ready 阶段取不到就跳过 */
  }
  try {
    const dl = app.getPath('downloads');
    if (dl) out.push(dl);
  } catch (_) {
    /* 忽略：拿不到下载目录就不加这一条 */
  }
  return out;
}

function sanitizeInterpreter(raw) {
  const fs = require('fs');
  const path = require('path');

  /* 缺省：与 prereq 的 `String(pythonExe || 'python')` 行为一致 */
  if (raw == null || raw === '') return { ok: true, exe: 'python' };
  if (typeof raw !== 'string') {
    return { ok: false, message: '解释器参数类型非法（应为字符串路径）' };
  }
  const exe = raw.trim();
  if (!exe) return { ok: true, exe: 'python' };

  /* 2) 裸命令名：不含路径分隔符、也不是盘符绝对路径 */
  if (!/[\\/]/.test(exe) && !/^[a-zA-Z]:/.test(exe)) {
    if (PYTHON_EXE_NAME_RE.test(exe)) return { ok: true, exe };
    return {
      ok: false,
      message: `不允许用「${exe}」当 Python 解释器：只接受 python / python3 / pythonw / py，或一个真实存在的 Python 可执行文件路径`
    };
  }

  /* 3) 显式路径 */
  let abs;
  try {
    abs = path.resolve(exe);
  } catch (_) {
    return { ok: false, message: `解释器路径无法解析：${exe}` };
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    return { ok: false, message: `找不到解释器：${abs}` };
  }
  if (!st.isFile()) return { ok: false, message: `解释器不是文件：${abs}` };

  const base = path.basename(abs);
  if (!PYTHON_EXE_NAME_RE.test(base)) {
    return {
      ok: false,
      message: `只允许选择 Python 解释器本身（python.exe / python3 / pythonw.exe / py.exe），当前是：${base}`
    };
  }

  const guard = mod('github');
  if (
    !guard ||
    typeof guard.isPathAllowed !== 'function' ||
    typeof guard.isExecutablePath !== 'function'
  ) {
    logging.log('error', '[prereq] 路径策略不可用，已拒绝解释器路径');
    return { ok: false, message: '解释器校验不可用，已拒绝执行' };
  }
  if (!guard.isExecutablePath(abs)) {
    return { ok: false, message: `解释器不是可执行类型：${abs}` };
  }

  /*
    拒绝"先投放、再执行"：启动器自己的数据目录与系统下载目录正是下载功能的
    落点（github.js 的 mode:'write' 白名单）。名字检查挡得住 evil.exe，却挡不住
    "投放一个**也叫 python.exe** 的恶意文件" —— 所以这两处必须整片拒绝。
    （真实用户的 Python 不会装在启动器数据目录或下载目录里，功能无影响。）
  */
  for (const host of downloadHosts()) {
    const root = path.resolve(host).toLowerCase();
    const target = abs.toLowerCase();
    if (target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      return {
        ok: false,
        message: `解释器不能位于启动器的数据目录/下载目录内（可能是在这里落盘的可执行文件），已拒绝：${abs}`
      };
    }
  }

  if (guard.isPathAllowed(abs, { mode: 'open' }).ok) return { ok: true, exe: abs };

  /* "已记录的解释器路径"：设置里存着的那个（用户显式保存过的选择） */
  let recorded = '';
  try {
    recorded = String(mod('settings')?.getBackendSettings?.()?.service?.pythonPath || '').trim();
  } catch (_) {
    recorded = '';
  }
  if (recorded) {
    try {
      if (path.resolve(recorded).toLowerCase() === abs.toLowerCase()) return { ok: true, exe: abs };
    } catch (_) {
      /* 配置里的路径无法解析：当作没记录 */
    }
  }

  return {
    ok: false,
    message:
      `解释器路径不在受管/已配置范围内，已拒绝：${abs}` +
      '（请把 Python 放在麦麦目录等已配置位置，或先在「设置」里保存该解释器路径）'
  };
}

function registerServiceIpc() {
  const processSvc = mod('process');
  const terminal = mod('terminal');
  const scanner = mod('scanner');
  const llm = mod('llm');
  const github = mod('github');
  const dataSvc = mod('data');
  const settings = mod('settings');
  const system = mod('system');
  const prereq = mod('prereq');
  const serviceLog = mod('serviceLog');
  const versions = mod('versions');

  /* ---------------- 进程 / 服务生命周期 ---------------- */
  if (processSvc) {
    /*
      启动：**只接受 key 与目录**。
      ──────────────────────────────────────────────────────────────────
      这条通道以前是 startService(key, payload || {})，payload 里的
      command / args / env 全部直通 spawn。也就是说，只要能往渲染层
      注入一段脚本（任何回显到页面的文本都是入口），就等于拿到了
      "以启动器身份执行任意程序"的能力 —— contextIsolation 与 sandbox
      挡的是渲染层直接碰 Node，挡不住它通过这条合法通道把命令递给主进程。
      现在的规矩：命令与参数一律由主进程按 key + 设置推导（见
      sanitizeStartPayload），渲染层最多只能提供一个**存在且是目录**的 cwd
      （用于"设置改了还没保存就想启动"）。多传的字段一律丢弃。
    */
    safeHandle('service:start', async (_e, payload) => {
      const key = String(payload?.key || 'maibot');
      const safe = await sanitizeStartPayload(key, payload);
      if (safe.error) return { ok: false, key, message: safe.error };
      return processSvc.startService(key, safe.payload);
    });

    safeHandle('service:stop', (_e, key) => processSvc.stopService(String(key || 'maibot')));

    /*
      手动重启：一次原子操作（停干净 → 再启动）。
      走主进程而不是让前端"点停止再点启动"，是因为两次调用之间
      看门狗可能已经介入，出现两个进程抢同一端口。
    */
    /* 重启走同一条收口逻辑：同样不接受渲染层指定的命令 */
    safeHandle('service:restart', async (_e, payload) => {
      const key = String(payload?.key || 'maibot');
      const safe = await sanitizeStartPayload(key, payload?.payload);
      if (safe.error) return { ok: false, key, stage: 'resolve', message: safe.error };
      return processSvc.restartService(key, {
        payload: safe.payload,
        timeoutMs: payload?.timeoutMs
      });
    });

    safeHandle('service:status', () => processSvc.getServicesStatus());

    /* ---------------- 新手引导的环境探测 ---------------- */
    /*
      引导向导要求"每一步都能给出真实证据"，而不是只显示说明文字。
      这三个通道提供真实事实；**是否算完成由用户点击决定**，
      探测只用于提示，绝不替用户打勾。
    */
    const envcheck = mod('envcheck');

    /** 判定某个目录是 MaiBot / SnowLuma / 都不是（与扫描用同一套特征） */
    safeHandle('env:detect-kind', (_e, dir) => envcheck.detectDirKind(dir));

    /*
      MaiBot 版本识别。
      这是此前完全缺失、后果最严重的一项：
      官方协议端适配器只支持 MaiBot ≥ 1.2.0，而 0.6.x 是另一套架构。
      把 0.6.x 当 1.2.x 引导，用户每一步都"照做了"却永远连不上，
      而且没有任何地方告诉他根因是版本。
    */
    safeHandle('env:detect-maibot-version', (_e, dir) => {
      let target = String(dir || '');
      if (!target) {
        try {
          target = settings?.getBackendSettings?.()?.service?.maibotDir || '';
        } catch (_) {
          target = '';
        }
      }
      return envcheck.detectMaiBotVersion(target);
    });

    /**
     * 适配器插件检测（接线里启动器**能真正验证**的那一半）。
     *
     * 为什么需要：装错适配器插件的后果是"接完线连不上，且报错指不到原因"——
     * 社区里流传的 `snowluma-adapter`（第三方分支）与官方
     * `MaiBot-SnowLuma-Adapter` 名字和配置版本都不同，装错了从日志里看不出来。
     * 这里直接看文件系统：插件目录在不在、有没有 _manifest.json（没有就不被 1.2.x 识别）、
     * 以及是不是官方那一个。
     */
    safeHandle('env:detect-adapter', (_e, opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      let target = String(o.dir || '');
      try {
        const svc = settings?.getBackendSettings?.()?.service || {};
        if (!target) target = svc.maibotDir || '';
      } catch (_) {
        /* 读不到设置就用传入的目录（没有就交给 detectAdapter 走 no-dir 分支） */
      }
      return envcheck.detectAdapter({ dir: target });
    });

    /** 工具链检测：Python 3.12+ / Git / uv（官方源码部署的前置） */
    safeHandle('env:detect-tools', (_e, pythonExe) => {
      let exe = String(pythonExe || '');
      if (!exe) {
        try {
          exe = settings?.getBackendSettings?.()?.service?.pythonPath || 'python';
        } catch (_) {
          exe = 'python';
        }
      }
      /* 这里同样会把 exe 交给 spawn（探版本），走与 prereq 同一套收口校验 */
      const safe = sanitizeInterpreter(exe);
      if (!safe.ok) return { ok: false, message: safe.message };
      return envcheck.detectTools(safe.exe);
    });

    /*
      一次性汇总引导所需的全部环境事实，避免向导里有十几步各打一个 IPC
      造成逐条闪动。
    */
    safeHandle('env:detect-all', () =>
      envcheck.detectAll({
        settings,
        /* 服务运行状态是同步的（读内存里的进程注册表），直接传结果 */
        getServicesStatus: () => processSvc?.getServicesStatus?.() || null
      })
    );

    /*
      MaiBot 的 WebUI 登录 Token。
      官方文档写明：首次启动时终端会打印「🔑 WebUI 登录 Token: <token>」，
      而且**每次冷启动都会重新生成**，用户每次都要去终端里翻一串长字符。
      启动器本来就在捕获 MaiBot 的 stdout，所以直接替他读出来。
      只读，不写任何文件。
    */
    safeHandle('maibot:webui-token', () => {
      const mb = mod('maibotConnect');
      let dir = '';
      try {
        dir = settings?.getBackendSettings?.()?.service?.maibotDir || '';
      } catch (_) {
        dir = '';
      }
      return mb.getWebuiToken({
        maibotDir: dir,
        logText: (() => {
          try {
            return serviceLog?.formatServiceLog ? serviceLog.formatServiceLog('maibot') : '';
          } catch (_) {
            return '';
          }
        })()
      });
    });

    /*
      真实启动参数探测：主进程检查目录与入口文件是否存在。
      渲染层的 buildStartPayload 只能看设置里的字符串，无法确认目录真的存在，
      于是"启动"按钮点了之后才知道路径是错的。这个通道让界面能提前给出判断。
    */
    safeHandle('service:resolve-payload', async (_e, key) => {
      const k = String(key || 'maibot');
      /*
        必须 await：buildStartPayload 是 async（内部要读文件、写运行时配置）。
        漏掉 await 的话拿到的是 Promise 对象，
        它恒为真 —— 后面 payload.command 是 undefined，
        界面会显示"路径没问题"，实际一启动就炸。
      */
      const payload = await processSvc.buildStartPayload(k);
      return payload
        ? { ok: true, key: k, payload }
        : { ok: false, key: k, message: '目录不存在或找不到入口文件，请检查设置中的路径' };
    });
    safeHandle('service:send-input', (_e, payload) =>
      processSvc.writeServiceInput(String(payload?.key || ''), payload?.text ?? '')
    );
    safeHandle('service:check-ports', (_e, ports) => processSvc.checkPorts(Array.isArray(ports) ? ports : []));

    /*
      残留进程清理：支持 dryRun 预演（真的返回发现数量与「将杀哪些 PID/命令行」）。
      ⚠️ 返回值里 ok:false 有**两种**含义，渲染层必须都当失败处理、不能读成"很干净"：
        · 带 reason + found:null + known:false —— 枚举失败（"我没查成功"）
        · 带 refused / failed 明细 —— 身份校验拒绝动手，或终止失败
    */
    safeHandle('service:cleanup-zombies', (_e, opts) =>
      processSvc.cleanupZombies({
        name: opts?.name || 'python.exe',
        keyword: opts?.keyword || 'maibot',
        dryRun: Boolean(opts?.dryRun)
      })
    );

    /* ---- 事件转发：service:exit / restart 等 ---- */
    processSvc.bus.on('service:exit', (payload) => {
      windows.sendToRenderer('service:exit', payload);
      /* 异常退出时同时给一条应用日志，便于事后追溯 */
      if (payload.abnormal) {
        logging.log(
          'error',
          `[service] ${payload.key} 异常退出 code=${payload.code}` +
            (payload.reason ? `（${payload.reason}）` : '')
        );
        notifyIfEnabled({
          level: 'error',
          title: `${serviceLabel(payload.key)} 异常退出`,
          /*
            优先用主进程解释好的 display / reason。
            以前这里只有 `退出码 ${payload.code}`，于是系统通知里会出现
            "退出码 -1073741510" —— Windows 通知面板空间有限，用户看到这串
            数字完全无从判断，只能来问。现在直接说清原因。
          */
          body: payload.message || payload.display || payload.reason || '可在「日志」页查看原因'
        });
      }
    });
    processSvc.bus.on('service:started', (p) => windows.sendToRenderer('service:started', p));
    processSvc.bus.on('service:stopped', (p) => windows.sendToRenderer('service:stopped', p));
    /*
      "启动判定已经超时、但端口后来真的开了" —— 由 process.js 的
      watchReadyInBackground 补发。界面据此把状态从「已启动（端口未就绪）」
      翻成「已就绪」，否则用户永远停在那个中间态，只能自己去点刷新猜。
    */
    processSvc.bus.on('service:ready', (p) => windows.sendToRenderer('service:ready', p));

    /* 手动重启的过程事件：让界面能显示"正在重启…"而不只是静默等待 */
    processSvc.bus.on('service:restarting', (p) => windows.sendToRenderer('service:restarting', p));
    processSvc.bus.on('service:restart-failed', (p) => {
      windows.sendToRenderer('service:restart-failed', p);
      logging.log('error', `[service] ${p.key} 重启失败（${p.stage}）: ${p.message}`);
      notifyIfEnabled({
        level: 'error',
        title: `${serviceLabel(p.key)} 重启失败`,
        body: p.message || '请检查日志'
      });
    });

    processSvc.bus.on('service:restart-scheduled', (p) => windows.sendToRenderer('service:restart-scheduled', p));
    processSvc.bus.on('service:restart-giveup', (p) => {
      windows.sendToRenderer('service:restart-giveup', p);
      /*
        放弃自动重启是"需要用户介入"的终态：
        界面 toast 在窗口隐藏时看不到，所以必须发系统通知。

        ⚠️ 字段名是 attempts（复数），见 process.js:1044-1049 的 emit。
        这里原来读的是 p.attempt，那个字段根本不存在 ——
        于是系统通知永远显示"连续失败 undefined 次"。
        渲染层 AppLayout.vue:483 已经修成 attempts，主进程这条漏了。
        优先用主进程已经准备好的 message（里面带着真实次数），
        兜底时才自己拼，且缺字段时显示 '?' 而不是 undefined。
      */
      notifyIfEnabled({
        level: 'error',
        title: `${serviceLabel(p.key)} 已放弃自动重启`,
        body: p.message || `连续失败 ${p.attempts ?? p.attempt ?? '?'} 次，请检查日志后手动启动。`
      });
    });
  }

  /* ---------------- 服务日志 ---------------- */
  if (serviceLog) {
    safeHandle('log:get-service', (_e, payload) =>
      serviceLog.getServiceLogs(String(payload?.key || 'maibot'), payload?.maxLines)
    );
    safeHandle('log:clear-service', (_e, key) => serviceLog.clearServiceLog(String(key || '')));
    safeHandle('log:export-service', (_e, payload) =>
      serviceLog.exportServiceLog(String(payload?.key || ''), payload?.destDir)
    );
    safeHandle('log:keys', () => serviceLog.logKeys());
  }

  /* ---------------- 安装扫描 ---------------- */
  if (scanner) {
    safeHandle('scan:installations', (_e, payload) =>
      scanner.scanInstallations({
        roots: Array.isArray(payload?.roots) ? payload.roots : undefined,
        scanId: typeof payload?.scanId === 'string' ? payload.scanId : undefined
      })
    );
    safeHandle('scan:cancel', (_e, scanId) => scanner.cancelScan(String(scanId || '')));
    safeHandle('scan:default-roots', () => scanner.defaultRoots());
  }

  /* ---------------- 受管版本（列出 / 真删除） ---------------- */
  /*
    只认磁盘事实：受管安装目录 + 它旁边的旧版本备份 + 受管父目录里同级的
    其它麦麦副本。**没有** versions/<tag> 这种布局，所以这里也不编一个出来。
    version:delete 的入参只有一个 path；受管根限制、目录身份（是不是麦麦）、
    "正在使用/正在运行不可删"全部由主进程重新判定（见 services/versions.js）。
  */
  if (versions) {
    safeHandle('version:list', () => versions.listManagedVersions());
    safeHandle('version:delete', (_e, opts) => versions.deleteVersion(opts?.path));
  }

  /* ---------------- 启动器自身的更新 ---------------- */
  /*
    三条通道的分工与"谁负责诚实"：
      update:check    —— 未配置更新源时**如实**返回 { ok:false, configured:false }，
                         界面据此引导用户去填仓库，而不是显示笼统的"检查失败"。
      update:download —— 进度经 update-progress 事件推给渲染层（updater.js 里直接
                         sendToRenderer，不在这里转发：那样要多绕一层，
                         而且中途的状态帧会与最终结果帧的时序脱节）。
      update:install  —— 真启动 NSIS 安装包并退出启动器；安装程序启动后才退出，
                         保证渲染层先收到 { ok:true } 再看到窗口关闭。
                         参数 dest 只是"期望的那个包"，真正的准入校验
                         （路径必须在临时目录内、必须是本会话下载并核对过的）
                         全部在 updater.install 里重新做一遍。
  */
  {
    const updater = mod('updater');
    if (updater) {
      safeHandle('update:check', () => updater.check());
      safeHandle('update:download', (_e, opts) => updater.download(opts || {}));
      safeHandle('update:install', (_e, opts) => updater.install(opts || {}));
      safeHandle('update:cancel', () => updater.cancel());
      safeHandle('update:state', () => ({ ok: true, download: updater.downloadState() }));
    } else {
      /* 模块加载失败时给出可读失败，而不是让界面永远等一个不存在的通道 */
      for (const ch of ['update:check', 'update:download', 'update:install', 'update:cancel']) {
        safeHandle(ch, () => ({ ok: false, message: '更新服务不可用（主进程模块加载失败）' }));
      }
    }
  }

  /* ---------------- LLM ---------------- */
  if (llm) {
    safeHandle('llm:call', (_e, params) => llm.callLlm(params || {}));
    safeHandle('llm:custom', (_e, params) => llm.callCustomLlm(params || {}));
    safeHandle('llm:abort', (_e, requestId) => llm.abortLlm(String(requestId || '')));
    safeHandle('llm:abort-all', () => llm.abortAll());
    safeHandle('llm:models', () => llm.listModels());

    /* 关键：转发时保留 requestId，渲染层据此隔离并发流 */
    llm.bus.on('stream', (payload) => windows.sendToRenderer('llm-stream', payload));
  }

  /* ---------------- GitHub / 安装升级 ---------------- */
  if (github) {
    safeHandle('github:releases', (_e, payload) =>
      github.getReleases(payload?.repo, payload?.perPage)
    );
    safeHandle('github:latest', (_e, repo) => github.getLatestRelease(repo));
    safeHandle('github:download', (_e, opts) => github.downloadAsset(opts || {}));
    safeHandle('github:install-maibot', (_e, opts) => github.installMaiBot(opts || {}));
    safeHandle('github:upgrade-maibot', (_e, opts) => github.upgradeMaiBot(opts || {}));

    /*
      SnowLuma 安装 —— 它是**唯一**的协议端（独立 Node 程序，不注入 QQ）。
      只做安装不做升级：SnowLuma 的发布包是自包含运行时，目录里没有用户
      配置（配置在 config/ 下，首次启动由它自己生成），所以"重装"是安全的；
      但仍先走 installSnowLuma 自己的换目录逻辑，失败不会破坏旧目录。
    */
    safeHandle('github:install-snowluma', (_e, opts) => github.installSnowLuma(opts || {}));

    /*
      升级备份的发现与清理。
      upgradeMaiBot 会刻意保留旧版本备份（正确做法），
      但过去没有任何接口能列出它们，几百 MB 的备份只能靠用户自己翻文件夹。
    */
    safeHandle('github:list-backups', (_e, installDir) => github.listBackups(String(installDir || '')));
    safeHandle('github:clean-backups', (_e, opts) => github.cleanBackups(opts || {}));

    /*
      还原备份：把某个备份目录换回成"当前使用的安装"。
      ──────────────────────────────────────────────────────────────
      在此之前只有"列出"与"删除"两条路，升级时的自动回滚是 upgradeMaiBot
      的内部逻辑、用户按不到 —— 磁盘上躺着完整旧版本却换不回来。
      入参只有一个 path；**全部硬性判定都在主进程**（github.restoreBackup）：
      备份得真是一套麦麦安装、麦麦不能在运行、路径得在受管根内部
      （复用 versions.managedRoots() 的 realpath 判据）、交换前必须先把
      当前安装改名成新备份、交换失败必须回滚。返回里带回"交换了哪些目录、
      新备份名、耗时"，绝不静默成功。
    */
    safeHandle('github:restore-backup', (_e, opts) => github.restoreBackup(opts || {}));

    /*
      探测一批候选安装目录是否已存在。
      用途：安装前判断 <targetDir>/maibot 是否已有内容 ——
      主进程的 installMaiBot 会以 keepBackup:false 调用
      swapDirectory，该分支会 **永久删除** 被替换掉的旧目录（含配置）。
      渲染层必须在动手前拿到这个事实，才能拦住或改走可回滚的升级路径。
      只读，不产生任何副作用。
    */
    safeHandle('github:probe-dirs', (_e, dirs) => {
      const fs = require('fs');
      const path = require('path');
      const list = Array.isArray(dirs) ? dirs.slice(0, 8) : [];
      const out = [];
      for (const raw of list) {
        const p = String(raw || '').trim();
        if (!p) continue;
        let exists = false;
        let fileCount = 0;
        try {
          if (fs.existsSync(p)) {
            exists = true;
            /* 只看一层：有内容才说明"这里有东西会被删掉" */
            fileCount = fs.readdirSync(p).length;
          }
        } catch (_) {
          /* 无权限等：当作不存在处理，交由后续步骤报错 */
        }
        out.push({ path: p, exists, empty: exists && fileCount === 0, fileCount });
      }
      return { ok: true, results: out, sep: path.sep };
    });
  }

  /* ---------------- 数据统计与清理 ---------------- */
  if (dataSvc) {
    safeHandle('data:stats', () => dataSvc.getDataStats());
    /*
      载荷兼容两种写法：
        'records'                        —— 旧的纯字符串（老渲染层调用不会坏）
        { category:'records', dryRun:true } —— 预演：只列清单，不删任何东西
      预演与真删在 data.js 里共用同一份 planClean()，所以预演结果就是实际结果。
    */
    safeHandle('data:clean', (_e, payload) => {
      const req = typeof payload === 'string' ? { category: payload } : (payload || {});
      return dataSvc.cleanDataCategory(String(req.category || ''), { dryRun: Boolean(req.dryRun) });
    });
    safeHandle('data:categories', () => dataSvc.listCategories());
  }

  /* ---------------- 设置 ---------------- */
  if (settings) {
    safeHandle('settings:get', () => settings.getBackendSettings());

    /*
      保存设置后立即把「开机登录自启」同步到系统登录项。
      这是把设置页的 launchOnLogin 开关变成真实功能的接线点 ——
      在此之前该字段只被写进 JSON，系统层面毫无变化。
    */
    safeHandle('settings:save', async (_e, patch) => {
      const result = await settings.saveBackendSettings(patch || {});
      if (result?.ok !== false) {
        syncLoginItem(result?.settings ?? settings.getBackendSettings?.());
      }
      return result;
    });

    safeHandle('settings:export', (_e, destPath) => settings.exportBackendSettings(destPath));

    safeHandle('settings:reset', async () => {
      const result = await settings.resetBackendSettings();
      if (result?.ok !== false) syncLoginItem(result?.settings);
      return result;
    });
  }

  /* ---------------- 登录自启 / 系统通知 ---------------- */
  {
    const login = mod('loginitem');
    if (login) {
      safeHandle('app:login-item-state', () => login.getState());
      safeHandle('app:set-login-item', (_e, payload) => {
        const r = login.apply(Boolean(payload?.enabled));
        /*
          同步写回设置文件，避免"系统已开启、设置里显示关闭"的漂移；
          用 immediate 立即落盘，因为这个操作本身就是用户明确的意图。
        */
        if (settings && r.ok && r.supported) {
          settings.saveBackendSettings(
            { general: { launchOnLogin: r.enabled } },
            { immediate: true }
          );
        }
        return r;
      });
    }
  }

  /* ---------------- 系统通知 ---------------- */
  {
    const notify = mod('notify');
    if (notify) {
      safeHandle('app:notify', (_e, payload) =>
        notify.show({
          title: payload?.title,
          body: payload?.body,
          level: payload?.level,
          silent: Boolean(payload?.silent)
        })
      );
    }
  }

  /* ---------------- 路径 ---------------- */
  safeHandle('paths:get', () => paths.getMaibotPaths());
  safeHandle('paths:user-data', () => ({ ok: true, userData: paths.userDataDir() }));

  /* ---------------- 系统信息 ---------------- */
  if (system) {
    safeHandle('system:usage', (_e, opts) => system.getSystemUsage(opts || {}));
    safeHandle('system:disk-space', (_e, target) => system.getDiskSpace(target || paths.dataRoot()));
  }

  /* ---------------- 前置检查 ---------------- */
  if (prereq) {
    /*
      形状错配修在这里而不是上游：preload 的 checkPythonVersion 传的是
      **字符串**（用户填的 python 路径），而 prereq.checkPythonVersion 读的是
      payload.pythonExe —— 于是用户自定义的解释器路径被静默丢弃，
      检测结果的其实是"python"这条 PATH 命令，用户以为检测过了。
      这里把两种形状都接住：字符串当 pythonExe，对象原样透传。
    */
    /*
      形状兼容：checkPythonVersion(pythonExe) 要的是**字符串**（可执行文件路径），
      而 preload 里的测试探针（checkPython）传的是 { pythonExe: 'python' }。
      这里统一成字符串再传 —— 两种调用都能工作，也避免再出现
      "把对象一路喂到 spawn 里" → 界面显示 `无法执行 [object Object]: spawn [object Object] ENOENT`。
      统一的字符串再经 sanitizeInterpreter 收口：这条通道最终会 spawn(exe, ['-V'])，
      解释器由渲染层指定，必须按"受管目录 / 已记录路径"白名单拦住（见函数注释）。
    */
    safeHandle('prereq:check-python', (_e, arg) => {
      const exe =
        typeof arg === 'string'
          ? arg
          : arg && typeof arg === 'object'
            ? String(arg.pythonExe || arg.exe || arg.path || '')
            : '';
      const safe = sanitizeInterpreter(exe);
      if (!safe.ok) return { ok: false, message: safe.message };
      return prereq.checkPythonVersion(safe.exe);
    });
    /*
      依赖检查支持 quick / full 两种模式：
        quick —— 模块级探测，约 340ms，用于进页面时的即时反馈。
        full  —— pip list 全量枚举，约 2600ms，能给出准确版本号。
      默认 quick：省掉每次切页都要等的 2.6 秒；用户点「完整检查」时再走 full。
    */
    safeHandle('prereq:check-deps', (_e, payload) => {
      const safe = sanitizeInterpreter(payload?.pythonExe);
      if (!safe.ok) return { ok: false, message: safe.message };
      return prereq.checkDependencies(payload?.installDir, safe.exe, {
        mode: payload?.mode === 'full' ? 'full' : 'quick'
      });
    });
    safeHandle('prereq:install-deps', (_e, payload) => {
      const safe = sanitizeInterpreter(payload?.pythonExe);
      if (!safe.ok) return { ok: false, message: safe.message };
      return prereq.installDependencies(payload?.installDir, safe.exe, {
        packages: payload?.packages
      });
    });
    safeHandle('prereq:check-all', (_e, payload) => {
      const safe = sanitizeInterpreter(payload?.pythonExe);
      if (!safe.ok) return { ok: false, message: safe.message };
      return prereq.checkPrerequisites(payload?.installDir, safe.exe);
    });
  }

  /* ---------------- 终端（真实现） ---------------- */
  if (terminal) {
    safeHandle('terminal:capability', () => terminal.capability());
    /*
      终端：只透传 shell / cwd / 尺寸 / env，**不再接受 command**。
      shell 已经在 terminal.js 里走白名单（id → 可执行文件），cwd 也会校验；
      但 command 是"启动后自动敲进去的一行字"—— 渲染层从没传过它
      （TerminalPanel 只传 shell/cwd/cols/rows），留着就是给注入留一条
      "自动执行"的通路。要用终端就由用户自己敲。
    */
    safeHandle('terminal:spawn', (_e, opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      return terminal.spawnSession({
        shell: o.shell,
        cwd: o.cwd,
        cols: o.cols,
        rows: o.rows
      });
    });
    /*
      这三个通道必须是 safeHandle（invoke）而不是 safeOn（send）。
      ──────────────────────────────────────────────────────────────────
      terminal.js 里的 writeSession / resizeSession / killSession 都精心
      构造了 {ok:false, message}（会话不存在 / 写入失败 / 进程杀不掉），
      但原来走的是 ipcMain.on —— 单向消息没有返回值，于是那些失败结果
      **结构上不可达**：渲染层永远拿到 undefined，失败被彻底静默。
      改成 handle 之后返回值才存在，配合 preload 的 invoke 才真的能上报。
      ⚠️ preload（terminalWrite/Resize/Kill）与渲染层调用点必须同步改，
         send 发到 handle 注册的通道不会有任何响应。
    */
    safeHandle('terminal:write', (_e, payload) =>
      terminal.writeSession(String(payload?.sessionId || ''), payload?.data)
    );
    safeHandle('terminal:resize', (_e, payload) =>
      terminal.resizeSession(String(payload?.sessionId || ''), payload?.cols, payload?.rows)
    );
    safeHandle('terminal:kill', (_e, sessionId) => terminal.killSession(String(sessionId || '')));
    safeHandle('terminal:list', () => ({ ok: true, count: terminal.sessionCount() }));
  }

  /* ---------------- 原生对话框 ---------------- */
  const dialogSvc = mod('dialog');
  if (dialogSvc) {
    /* dialog 模块自带 registerIpc(ipcMain) 形式，直接调用 */
    try {
      dialogSvc.registerIpc(ipcMain);
    } catch (e) {
      logging.log('error', `[services] dialog 注册失败: ${e.message}`);
    }
  } else {
    /* 兜底：模块加载失败时至少保证前端调用不会挂起 */
    for (const ch of ['dialog:select-folder', 'dialog:select-file', 'dialog:save-file', 'dialog:confirm']) {
      safeHandle(ch, () => ({ ok: false, canceled: true, message: '对话框服务不可用' }));
    }
  }

  logging.log('info', '[services] 服务层 IPC 注册完成');
}

/* ============================================================================
 *  第 3 组：看门狗与退出
 * ========================================================================== */

function startWatchdog() {
  const processSvc = mod('process');
  if (processSvc) processSvc.startWatchdog();
}

function stopWatchdog() {
  const processSvc = mod('process');
  if (processSvc) processSvc.stopWatchdog();
}

/**
 * 启动后自动拉起已配置的服务（general.autoStart）。
 * 由 main.js 在主窗口就绪后调用；未开启时立即返回，不产生任何副作用。
 */
function autoStartConfigured() {
  const processSvc = mod('process');
  if (!processSvc) return Promise.resolve({ started: [], skipped: [], failed: [] });
  return processSvc.autoStartConfigured();
}

/**
 * 把设置文件里的开机自启意图对齐到系统登录项。
 * 解决"用户在系统设置里手动关掉了自启，但设置文件仍写着开启"的漂移。
 */
function reconcileLoginItem() {
  try {
    const login = mod('loginitem');
    const settings = mod('settings');
    if (!login || !settings) return null;
    return login.reconcile(Boolean(settings.getBackendSettings()?.general?.launchOnLogin));
  } catch (e) {
    logging.log('warn', `[loginitem] 启动对齐失败: ${e.message}`);
    return null;
  }
}

/**
 * 退出前的完整清理：
 *   终端会话 → 托管子进程 → 待写设置 → 待写日志
 * @param {{timeoutMs?:number}} [opts]
 */
async function shutdownAll(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const summary = {
    terminals: 0,
    /* 杀不掉的终端进程数（如实汇报残留，别谎报"已全部关闭"） */
    terminalsFailed: 0,
    services: [],
    remaining: [],
    settingsFlushed: false
  };

  /* 1) 终端会话（先关，避免它们继续产出输出） */
  const terminal = mod('terminal');
  if (terminal) {
    /*
      必须 await：killAllSessions 现在会等每个会话的进程树真的结束
      （原来 fire-and-forget，返回的 closed 只是"发过 kill"的个数）。
      summary.failed 记录杀不掉的个数，退出日志里能看出有没有残留。
    */
    const r = await terminal.killAllSessions({ timeoutMs: Math.min(4000, timeoutMs) });
    summary.terminals = r.closed || 0;
    summary.terminalsFailed = r.failed || 0;
    logging.log(
      'info',
      `[shutdown] 已关闭 ${summary.terminals} 个终端会话` +
        (summary.terminalsFailed ? `（${summary.terminalsFailed} 个未能结束）` : '')
    );
  }

  /* 2) 托管子进程（真等待结束） */
  const processSvc = mod('process');
  if (processSvc) {
    const r = await processSvc.shutdownAll({ timeoutMs });
    summary.services = r.stopped || [];
    summary.remaining = r.remaining || [];
  }

  /* 3) 设置缓冲落盘 */
  const settings = mod('settings');
  if (settings) {
    try {
      settings.flushSettings();
      summary.settingsFlushed = true;
    } catch (e) {
      logging.log('error', `[shutdown] 设置落盘失败: ${e.message}`);
    }
  }

  /* 4) LLM 进行中的请求全部中止 */
  const llm = mod('llm');
  if (llm) {
    const r = llm.abortAll();
    if (r.aborted) logging.log('info', `[shutdown] 已中止 ${r.aborted} 个进行中的 LLM 请求`);
  }

  return summary;
}

module.exports = {
  registerBaseIpc,
  registerServiceIpc,
  startWatchdog,
  stopWatchdog,
  autoStartConfigured,
  reconcileLoginItem,
  shutdownAll,
  mod
};
