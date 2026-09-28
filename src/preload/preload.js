/*
================================================================================
技术文档：src/preload/preload.js
职责：渲染进程与主进程之间的白名单桥（contextBridge）。
================================================================================
  相对重构前的修正：
    1) 补齐终端的 write / resize / kill —— 原实现只暴露了 terminalSpawn，
       而主进程却注册了这三个通道，渲染层根本无法调用（假通道）。
    2) 删除死通道：killZombie（改名为语义明确的 cleanupZombies）、
       getLogDir（与真实日志目录不一致）、sendServiceInput 的必崩实现。
    3) 所有 invoke 统一返回 {ok, ...} 结构，失败时不再抛出
       "Error invoking remote method" 原始堆栈。
    4) 事件订阅全部返回**取消函数**，且 on/off 成对，避免监听器泄漏
       （重构前 AppLayout 挂载时订阅却不清理，每次热更新都会叠加一层）。
    5) 暴露一个轻量 log() 给渲染层上报日志（主进程真落盘）。
================================================================================
*/
const { contextBridge, ipcRenderer } = require('electron');

/*
  "自检中"标记：在页面脚本执行之前算好，供渲染层**同步**读取
  （onMounted 里就要决定要不要自动展开新手引导，晚一步就来不及了）。

  为什么非屏蔽不可：自检要逐个路由抓取页面文本做断言，
  而引导抽屉的节点文本会混进断言内容，让"页面渲染正常"的判定失真。
  （注意：沙箱化 preload 的 process.argv 不含自定义 Electron 开关，
    所以这里读的是环境变量。）

  ⚠️ 这个标记**必须经 contextBridge 送进页面世界**（下面 api.isSelfcheck）。
  以前这里是 `globalThis.__DSH_ONBOARDING_SUPPRESS__ = true`，看起来能用，
  实际是个死通道：contextIsolation:true 下 preload 有独立的隔离世界，
  它的 globalThis 与页面世界的 window 是**两个对象**，页面里的渲染代码
  永远读不到这个属性 —— 于是 onboardingSuppressed() 恒为 false，
  自检时引导向导照样自动展开、混进断言内容。而主进程事后
  executeJavaScript 注入会被 CSP（script-src 'self'）拒掉，补不回来。
  走 contextBridge 暴露一个原始布尔值则两侧都成立：同步、无需 IPC 往返、
  也不依赖任何异步初始化顺序。
*/
let selfcheckMode = false;
try {
  selfcheckMode = process.env.MAIBOT_LAUNCHER_SELFCHECK === '1';
} catch (_) {
  /* 读不到环境变量就当作普通启动 */
}

/* ============================================================================
 *  请求 / 响应
 * ========================================================================== */
const api = {
  /* ---------- 应用与窗口 ---------- */
  appInfo: () => ipcRenderer.invoke('app:info'),
  exitApp: () => ipcRenderer.send('app:exit'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  hideToTray: () => ipcRenderer.invoke('window:hide-to-tray'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /* ---------- 系统集成（登录自启 / 系统通知） ---------- */
  getLoginItemState: () => ipcRenderer.invoke('app:login-item-state'),
  setLoginItem: (enabled) => ipcRenderer.invoke('app:set-login-item', { enabled }),
  notify: (payload) => ipcRenderer.invoke('app:notify', payload),
  /** 探测服务的真实启动参数（主进程侧做入口文件检测，不存在则返回 null） */
  resolveStartPayload: (key) => ipcRenderer.invoke('service:resolve-payload', key),

  /* SnowLuma：现在**唯一**的协议端（独立 Node 程序，不注入 QQ） */
  installSnowluma: (opts) => ipcRenderer.invoke('github:install-snowluma', opts),
  /* 适配器插件检测：接线里"能真正验证"的那一半（端口那半只能探测） */
  detectAdapter: (opts) => ipcRenderer.invoke('env:detect-adapter', opts),

  /* ---------- 新手引导的环境探测 ---------- */
  /*
    探测只提供事实，**不替用户判断"这步算不算完成"**。
    完成状态一律由用户点击确认，避免"看起来做完了"的假象。
  */
  envDetectKind: (dir) => ipcRenderer.invoke('env:detect-kind', dir),
  envDetectAll: () => ipcRenderer.invoke('env:detect-all'),
  /**
   * MaiBot 版本识别。
   * 官方 SnowLuma 适配器只支持 MaiBot ≥ 1.2.0，0.6.x 是完全不同的架构；
   * 判错版本会让用户"每一步都照做了却永远连不上"。
   */
  envDetectMaibotVersion: (dir) => ipcRenderer.invoke('env:detect-maibot-version', dir),
  /** 工具链：Python 3.12+ / Git / uv（官方源码部署前置） */
  envDetectTools: (pythonExe) => ipcRenderer.invoke('env:detect-tools', pythonExe),
  /** MaiBot 的 WebUI 登录 Token（从它的启动日志里读，只读不写） */
  maibotWebuiToken: () => ipcRenderer.invoke('maibot:webui-token'),

  /* ---------- 外壳能力 ---------- */
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openPath: (target) => ipcRenderer.invoke('shell:open-path', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:show-item', target),

  /* ---------- 日志 ---------- */
  getAppLog: (maxLines) => ipcRenderer.invoke('log:get-main', maxLines),
  clearAppLog: () => ipcRenderer.invoke('log:clear-main'),
  exportAppLog: () => ipcRenderer.invoke('log:export-main'),
  reportLog: (level, msg) => ipcRenderer.send('log:report', { level, msg }),

  /* ---------- 服务 / 进程 ---------- */
  startService: (payload) => ipcRenderer.invoke('service:start', payload),
  stopService: (key) => ipcRenderer.invoke('service:stop', key),
  restartService: (key, payload) => ipcRenderer.invoke('service:restart', { key, payload }),
  getServicesStatus: () => ipcRenderer.invoke('service:status'),
  sendServiceInput: (key, text) => ipcRenderer.invoke('service:send-input', { key, text }),
  checkPorts: (ports) => ipcRenderer.invoke('service:check-ports', ports),
  /** 清理残留进程；dryRun=true 时只统计不杀 */
  cleanupZombies: (opts) => ipcRenderer.invoke('service:cleanup-zombies', opts || {}),

  /* ---------- 服务日志 ---------- */
  getServiceLogs: (key, maxLines) => ipcRenderer.invoke('log:get-service', { key, maxLines }),
  clearServiceLog: (key) => ipcRenderer.invoke('log:clear-service', key),
  exportServiceLog: (key, destDir) => ipcRenderer.invoke('log:export-service', { key, destDir }),
  getLogKeys: () => ipcRenderer.invoke('log:keys'),

  /* ---------- 安装扫描 ---------- */
  scanInstallations: (opts) => ipcRenderer.invoke('scan:installations', opts || {}),
  cancelScan: (scanId) => ipcRenderer.invoke('scan:cancel', scanId),
  getDefaultScanRoots: () => ipcRenderer.invoke('scan:default-roots'),

  /* ---------- 受管版本（列出 / 真删除） ---------- */
  /** 列出受管麦麦版本：当前使用的 + 升级备份的旧版本 + 受管目录里同级的其它副本 */
  listManagedVersions: () => ipcRenderer.invoke('version:list'),
  /**
   * 删除一个受管版本目录（真删）。
   * 主进程侧硬性拒绝"正在使用/正在运行"的版本、受管根之外的路径、
   * 以及不是麦麦安装的目录；失败会带原文错误（文件被占用等）。
   */
  deleteManagedVersion: (path) => ipcRenderer.invoke('version:delete', { path }),

  /* ---------- LLM ---------- */
  callLlm: (params) => ipcRenderer.invoke('llm:call', params),
  callCustomLlm: (params) => ipcRenderer.invoke('llm:custom', params),
  abortLlm: (requestId) => ipcRenderer.invoke('llm:abort', requestId),
  abortAllLlm: () => ipcRenderer.invoke('llm:abort-all'),
  listModels: () => ipcRenderer.invoke('llm:models'),

  /* ---------- GitHub ---------- */
  getGithubReleases: (repo, perPage) => ipcRenderer.invoke('github:releases', { repo, perPage }),
  getGithubLatest: (repo) => ipcRenderer.invoke('github:latest', repo),
  downloadAsset: (opts) => ipcRenderer.invoke('github:download', opts),
  installMaiBot: (opts) => ipcRenderer.invoke('github:install-maibot', opts),
  upgradeMaiBot: (opts) => ipcRenderer.invoke('github:upgrade-maibot', opts),
  /** 列出某安装目录旁边由升级/替换产生的备份目录 */
  listBackups: (installDir) => ipcRenderer.invoke('github:list-backups', installDir),
  /** 清理指定备份目录（主进程做路径白名单校验，dryRun 可预览） */
  cleanBackups: (opts) => ipcRenderer.invoke('github:clean-backups', opts),
  /**
   * 把某个备份目录还原成"当前使用的安装"。
   * 主进程侧硬性校验：备份确实是一套麦麦安装、麦麦没有在运行、
   * 路径在受管根内部、交换前先把当前版本另存为新备份，失败自动回滚；
   * 返回里带交换明细 / 新备份名 / 耗时，绝不静默成功。
   */
  restoreBackup: (opts) => ipcRenderer.invoke('github:restore-backup', opts),
  /**
   * 探测一批候选目录是否已存在及是否有内容（只读）。
   * 安装前用它判断 <targetDir>/maibot 是否已有内容会被永久删除。
   */
  probeDirs: (dirs) => ipcRenderer.invoke('github:probe-dirs', dirs),

  /* ---------- 启动器自身的更新 ---------- */
  /**
   * 检查启动器是否有新版本。
   *
   * 返回 { ok, configured, current, latest, hasUpdate, notes, publishedAt, asset, message }。
   * ⚠️ configured:false 表示"更新源还没配置"（constants.js 里仍是占位值），
   * 这不是网络故障 —— 界面必须据此给出**不同的**提示，
   * 否则用户会对着一个永远修不好的"检查失败"反复点重试。
   */
  checkLauncherUpdate: () => ipcRenderer.invoke('update:check'),
  /**
   * 下载更新安装包（按通道顺序回退，进度经 onUpdateProgress 推送）。
   * 只有字节数与 Release 元数据一致才算成功（ok:true）。
   */
  downloadLauncherUpdate: (opts) => ipcRenderer.invoke('update:download', opts || {}),
  /**
   * 启动已下载并校验过的安装包，并退出启动器。
   * 主进程会重新校验路径与字节数；返回的 message 说明**会发生什么**。
   */
  installLauncherUpdate: (opts) => ipcRenderer.invoke('update:install', opts || {}),
  /** 取消进行中的下载 */
  cancelLauncherUpdate: () => ipcRenderer.invoke('update:cancel'),

  /* ---------- 数据 ---------- */
  getDataStats: () => ipcRenderer.invoke('data:stats'),
  cleanDataCategory: (category) => ipcRenderer.invoke('data:clean', category),
  getDataCategories: () => ipcRenderer.invoke('data:categories'),

  /* ---------- 设置 ---------- */
  getBackendSettings: () => ipcRenderer.invoke('settings:get'),
  saveBackendSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  exportBackendSettings: (destPath) => ipcRenderer.invoke('settings:export', destPath),
  resetBackendSettings: () => ipcRenderer.invoke('settings:reset'),

  /* ---------- 路径 ---------- */
  getMaibotPaths: () => ipcRenderer.invoke('paths:get'),
  getUserDataDir: () => ipcRenderer.invoke('paths:user-data'),

  /* ---------- 系统 ---------- */
  getSystemUsage: () => ipcRenderer.invoke('system:usage'),
  getDiskSpace: (target) => ipcRenderer.invoke('system:disk-space', target),

  /* ---------- 前置检查 ---------- */
  checkPythonVersion: (pythonExe) => ipcRenderer.invoke('prereq:check-python', pythonExe),
  checkDependencies: (payload) => ipcRenderer.invoke('prereq:check-deps', payload),
  installDependencies: (payload) => ipcRenderer.invoke('prereq:install-deps', payload),
  checkPrerequisites: (payload) => ipcRenderer.invoke('prereq:check-all', payload),

  /* ---------- 终端（真实现） ---------- */
  terminalCapability: () => ipcRenderer.invoke('terminal:capability'),
  terminalSpawn: (opts) => ipcRenderer.invoke('terminal:spawn', opts),
  /*
    这三个必须是 invoke，不能是 send。
    send 是单向的：主进程那边拿不到返回通道，terminal.js 里
    writeSession / resizeSession / killSession 构造的 {ok:false, message}
    （会话不存在 / 写入失败 / 进程杀不掉）在渲染层永远读不到 —— 失败全静默。
    主进程侧已同步改为 ipcMain.handle（services/index.js 的 terminal:write/resize/kill）。
  */
  terminalWrite: (sessionId, data) => ipcRenderer.invoke('terminal:write', { sessionId, data }),
  terminalResize: (sessionId, cols, rows) =>
    ipcRenderer.invoke('terminal:resize', { sessionId, cols, rows }),
  terminalKill: (sessionId) => ipcRenderer.invoke('terminal:kill', sessionId),
  terminalList: () => ipcRenderer.invoke('terminal:list'),

  /* ---------- 对话框 ---------- */
  selectDirectory: (opts) => ipcRenderer.invoke('dialog:select-folder', opts || {}),
  selectFile: (opts) => ipcRenderer.invoke('dialog:select-file', opts || {}),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts || {}),
  saveFile: (opts) => ipcRenderer.invoke('dialog:save-file', opts || {})
};

/* ============================================================================
 *  事件订阅：统一返回取消函数
 * ==========================================================================
 *  先定义 subscribe 再定义 launcher / events：
 *  两者都在**模块求值阶段**就调用 subscribe 生成订阅方法，
 *  const 提升只到暂时性死区，写在后面会直接抛
 *  "Cannot access 'subscribe' before initialization"（TDZ）。
 * ========================================================================== */
function subscribe(channel, cb) {
  const listener = (_event, payload) => {
    try {
      cb(payload);
    } catch (e) {
      /* 渲染层回调异常不应影响主进程事件通道 */
      console.error(`[preload] ${channel} 回调异常:`, e);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* ============================================================================
 *  launcher：外壳（自绘标题栏 + 主题）专用桥
 * ==========================================================================
 *  为什么单独开一个对象，而不是继续往 maibotApi 上堆：
 *    自绘标题栏与主题切换属于**窗口外壳**的能力，与"麦麦的服务/日志/安装"
 *    是两件事。分开之后，外壳组件只依赖 window.launcher，业务页面继续用
 *    window.maibotApi / window.maibotEvents —— 边界清楚，也便于测试时
 *    单独打桩。
 *
 *  ⚠️ 通道名是固定契约，不要改（docs/UI-BRIEF-v3.md §1）：
 *      window:minimize / window:maximize / window:close / window:is-maximized
 *      theme:get / theme:set / theme:changed（主→渲染推送）
 *    「最大化」按钮是**切换**语义：主进程根据当前状态自行决定最大化或还原，
 *    渲染层不需要（也不该）自己判断，否则两侧状态一旦不同步就会点反。
 *
 *  写法与命名风格沿用上面的 api / events：invoke 用于请求-响应，
 *  on* 用于订阅且**必须**返回取消函数。
 * ========================================================================== */
const launcher = {
  /* ---------- 窗口控制 ---------- */
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /* ---------- 主题 ---------- */
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  /* ---------- 订阅（统一返回取消函数） ---------- */
  /** 主题被改（可能是别的窗口/快捷键改的）→ 渲染层跟着换 data-theme */
  onThemeChanged: (cb) => subscribe('theme:changed', cb),
  /** 窗口最大化状态变化 → 标题栏中间的按钮换图标 */
  onWindowState: (cb) => subscribe('window:state', cb)
};

const events = {
  /* 子进程生命周期 */
  onServiceExit: (cb) => subscribe('service:exit', cb),
  onServiceStarted: (cb) => subscribe('service:started', cb),
  onServiceStopped: (cb) => subscribe('service:stopped', cb),
  onServiceReady: (cb) => subscribe('service:ready', cb),
  onRestartScheduled: (cb) => subscribe('service:restart-scheduled', cb),
  onRestartGiveup: (cb) => subscribe('service:restart-giveup', cb),
  onServiceRestarting: (cb) => subscribe('service:restarting', cb),
  onServiceRestartFailed: (cb) => subscribe('service:restart-failed', cb),

  /* 服务日志批处理 */
  onServiceLogBatch: (cb) => subscribe('service-log-batch', cb),

  /* 启动器自身日志（实时，单条推送） */
  onAppLog: (cb) => subscribe('app-log', cb),

  /* LLM 流（payload 含 requestId，调用方需自行过滤） */
  onLlmStream: (cb) => subscribe('llm-stream', cb),

  /* 下载进度：label 取值 'maibot' | 'snowluma' | 'asset' */
  onDownloadProgress: (label, cb) => subscribe(`download-progress-${label}`, cb),

  /*
    启动器更新的进度 / 结果帧（channel 固定为 'update-progress'）。
    phase 取值：start | progress | verify | done | error | aborted；
    失败帧的 message 是主进程给出的**真实原因**（HTTP 状态 / 超时 / 字节数不符），
    界面必须原样显示，不要自己替换成"网络错误"。
  */
  onUpdateProgress: (cb) => subscribe('update-progress', cb),

  /* 依赖安装进度 */
  onDepsInstallStatus: (cb) => subscribe('deps-install-status', cb),

  /* 终端 */
  onTerminalData: (cb) => subscribe('terminal:data', cb),
  onTerminalExit: (cb) => subscribe('terminal:exit', cb)
};

/* ============================================================================
 *  暴露
 * ========================================================================== */
/*
  getTheme / setTheme 原先只挂在 launcher 上，而渲染层统一经 safeInvoke 走
  maibotApi（stores/app-store.js）。实测：设置页点主题只弹「桥接方法不存在: setTheme」，
  主题不换；主题行也读不到持久化的偏好。
  这里补到 api 上，且直接复用 launcher 上的同一份实现 —— 不复制 IPC 通道名，
  免得将来通道名只改一处。launcher 保持原样，AppLayout 继续走它。
*/
api.getTheme = launcher.getTheme;
api.setTheme = launcher.setTheme;

/*
  自检模式标记（bool，非 IPC）—— contextBridge 允许直接暴露原始值，
  页面世界读 window.maibotApi.isSelfcheck 即可，且**同步可用**：
  渲染层的 onboardingSuppressed() 在 onMounted 里就要做判断，
  不能依赖任何异步通道（app:info 之类的 IPC 一旦失败或晚到，
  屏蔽就失效，向导会盖到自检断言上，见本文件顶部说明）。
  这里刻意不做成 ipcRenderer.invoke：那只会多一次往返与一个失败点。
*/
api.isSelfcheck = selfcheckMode;

contextBridge.exposeInMainWorld('maibotApi', api);
contextBridge.exposeInMainWorld('maibotEvents', events);
/*
  外壳桥。原有 maibotApi / maibotEvents 的通道**一个都不动**：
  业务页面（app-store.js 里的 api()/bus()）仍读旧对象，
  只有自绘标题栏与主题切换走这个新对象。
*/
contextBridge.exposeInMainWorld('launcher', launcher);

/* ============================================================================
 *  IPC 契约探针（仅测试路径）
 * ==========================================================================
 *  scripts/verify-ipc.mjs 以 --ipc-probe 启动时执行。
 *
 *  关键设计：探针代码是**静态写在下面**的，不通过 argv 注入、不用 eval。
 *  原因有二：
 *    1) 渲染进程 CSP 是 `script-src 'self'`（无 unsafe-eval），任何
 *       eval / new Function 都会当场抛 EvalError；
 *    2) 往 preload 注入任意代码等于给自己留后门，与"白名单桥"的定位相悖。
 *  这里只做一件事：按固定清单调用真实 IPC 通道，回报结构是否正常。
 *
 *  不传 --ipc-probe 时整段直接返回，零开销、零副作用。
 * ========================================================================== */
(function runIpcProbeIfRequested() {
  /*
    用环境变量判定，而不是 process.argv：
    沙箱化 preload 的 process 是受限对象，argv 里拿不到 Electron 的
    自定义命令行开关（实测 --ipc-probe 传不进来，探针会静默不执行）。
    env 则始终可见。
  */
  if (process.env.MAIBOT_LAUNCHER_IPC_PROBE !== '1') return;

  const out = {};
  const report = (extra) => {
    try {
      ipcRenderer.send('test:ipc-report', Object.assign(out, extra || {}));
    } catch (_) {
      /* 无处可报，忽略 */
    }
  };

  /* 每个探针：名字 → 返回 Promise 的调用；只记录形状，不记录敏感值 */
  const PROBES = {
    /*
      app:info 需要看到 defaults.service.ports 才能断言"默认端口是上游真实值"。
      这也是唯一一处把深字段带进报告的探针 —— 端口号不是敏感信息。
    */
    appInfo: async () => {
      const r = await ipcRenderer.invoke('app:info');
      return {
        value: r,
        shape: { defaultsPorts: r?.defaults?.service?.ports || null }
      };
    },
    getServicesStatus: () => ipcRenderer.invoke('service:status'),
    getBackendSettings: () => ipcRenderer.invoke('settings:get'),
    getMaibotPaths: () => ipcRenderer.invoke('paths:get'),
    getUserDataDir: () => ipcRenderer.invoke('paths:user-data'),
    getDataStats: () => ipcRenderer.invoke('data:stats'),
    getDataCategories: () => ipcRenderer.invoke('data:categories'),
    getLoginItemState: () => ipcRenderer.invoke('app:login-item-state'),
    getAppLog: () => ipcRenderer.invoke('log:get-main', 50),
    getLogKeys: () => ipcRenderer.invoke('log:keys'),
    getSystemUsage: () => ipcRenderer.invoke('system:usage'),
    getDiskSpace: () => ipcRenderer.invoke('system:disk-space', 'C:\\'),
    checkPorts: () => ipcRenderer.invoke('service:check-ports', []),
    defaultScanRoots: () => ipcRenderer.invoke('scan:default-roots'),
    scanInstallations: () => ipcRenderer.invoke('scan:installations'),
    terminalCapability: () => ipcRenderer.invoke('terminal:capability'),
    terminalList: () => ipcRenderer.invoke('terminal:list'),
    llmModels: () => ipcRenderer.invoke('llm:models'),
    checkPython: () => ipcRenderer.invoke('prereq:check-python', { pythonExe: 'python' }),
    /* 新手引导的环境探测 */
    envDetectAll: () => ipcRenderer.invoke('env:detect-all'),
    envDetectKindBad: () => ipcRenderer.invoke('env:detect-kind', 'Z:\\__definitely_missing__'),
    envDetectMaibotVersion: () => ipcRenderer.invoke('env:detect-maibot-version', 'Z:\\__missing__'),
    envDetectTools: () => ipcRenderer.invoke('env:detect-tools', 'python'),
    /*
      适配器插件检测（接线里"能真的验证"的那一半）。
      隔离环境里没有 MaiBot 目录 → 必须是 found:false 而不是抛异常，
      所以这条同时验证了"通道通了"和"缺目录时优雅降级"。
    */
    envDetectAdapter: () => ipcRenderer.invoke('env:detect-adapter', { dir: 'Z:\\__missing__\\MaiBot' }),
    envDetectAdapterNoArg: () => ipcRenderer.invoke('env:detect-adapter', undefined),
    maibotWebuiToken: () => ipcRenderer.invoke('maibot:webui-token'),
    /* 空 patch 保存：验证设置通道的 sanitize/落盘往返是通的，且不改变任何值 */
    saveSettingsNoop: () => ipcRenderer.invoke('settings:save', {}),
    /* 本轮新增：安装前目录探测（破坏性操作防护的依赖） */
    probeDirsEmpty: () => ipcRenderer.invoke('github:probe-dirs', []),
    probeDirsReal: () => ipcRenderer.invoke('github:probe-dirs', ['C:\\Windows', 'Z:\\__nope__']),
    probeDirsBadType: () => ipcRenderer.invoke('github:probe-dirs', 'not-an-array'),
    listBackupsEmpty: () => ipcRenderer.invoke('github:list-backups', ''),
    /*
      启动器自身的更新：只探**只读**通道（check / state）。
      download 与 install 不探 —— 它们会真的下载、真的启动安装程序，
      探针跑在隔离 userData 下也一样会动真格的东西，不能拿来做冒烟测试。
    */
    updateCheck: () => ipcRenderer.invoke('update:check'),
    updateState: () => ipcRenderer.invoke('update:state'),
    /* 确定性拒绝：确认主进程对非法外部链接有白名单 */
    openExternalJs: () => ipcRenderer.invoke('shell:open-external', 'javascript:alert(1)')
  };

  /*
    内容断言：只验证"有返回值"是不够的 ——
    恒真的假实现（例如永远返回 {ok:true, results:[]}）同样能通过形状检查。
    这里对关键通道核对真实语义。
    返回 true 表示通过，返回字符串表示失败原因。
  */
  const ASSERTIONS = {
    /* 本轮的破坏性操作防护完全依赖这个通道，必须真的能分辨存在/不存在 */
    probeDirsReal: (r) => {
      const list = r && r.results;
      if (!Array.isArray(list) || list.length !== 2) return `期望 2 条结果，实际 ${list && list.length}`;
      const win = list.find((x) => String(x.path).startsWith('C:'));
      const none = list.find((x) => String(x.path).startsWith('Z:'));
      if (!win) return '缺少 C:\\Windows 的结果';
      if (!win.exists) return 'C:\\Windows 应判定为存在，实际 exists=false';
      if (!none) return '缺少 Z:\\__nope__ 的结果';
      if (none.exists) return 'Z:\\__nope__ 不存在，却判定 exists=true';
      return true;
    },
    /* 非法类型必须被安全地当成空列表，而不是崩溃 */
    probeDirsBadType: (r) => (Array.isArray(r && r.results) && r.results.length === 0
      ? true
      : '非数组入参应返回空 results'),

    /*
      适配器检测通道的内容断言。
      只验"有返回值"不够 —— 一个永远返回 {ok:true,found:false} 的假实现
      同样能过形状检查。这里核对真实语义：
        · 指向不存在的目录时，必须 found:false 但**仍给出期望目录与配置版本**，
          否则界面就没法告诉用户"该把插件放到哪、官方版本是多少"；
        · 完全不给参数（走设置里的值）也不能抛。
    */
    envDetectAdapter: (r) => {
      if (!r || r.ok !== true) return `期望 ok:true，实际 ${JSON.stringify(r)}`;
      if (r.found !== false) return `不存在的目录应 found:false，实际 ${r.found}`;
      if (r.expectedDir !== 'plugins/MaiBot-SnowLuma-Adapter') {
        return `期望目录应为官方 MaiBot-SnowLuma-Adapter，实际 ${r.expectedDir}`;
      }
      if (r.expectedConfigVersion !== '1.0.6') {
        return `期望配置版本应为 1.0.6，实际 ${r.expectedConfigVersion}`;
      }
      return true;
    },
    /*
      无参调用时主进程会走设置里的 MaiBot 目录。
      隔离沙箱里通常没配 → 期望走 reason:'no-dir' 这条**可解释**分支：
      ok 仍为 true（不是故障）、message 有可操作提示。
      这里不写死"必须 found:false"，因为真机上配了目录就该真的去查。
    */
    envDetectAdapterNoArg: (r) => {
      if (!r || r.ok !== true) return `期望 ok:true（缺目录是可解释状态），实际 ${JSON.stringify(r)}`;
      if (r.found === false && r.reason === 'no-dir') {
        if (typeof r.message !== 'string' || !r.message) return 'no-dir 分支缺少可操作提示 message';
        return true;
      }
      if (r.found === true) return true;
      return `既不是 found:true 也不是可解释的 no-dir，实际 ${JSON.stringify(r)}`;
    },

    /* 真实数据目录必须存在（否则启动阶段 ensureManagedDirs 没生效） */
    getMaibotPaths: (r) => (r && typeof r.base === 'string' && r.base
      ? true
      : 'base 路径为空'),
    /*
      默认端口必须是上游真实端口。
      历史故障：本启动器曾把协议端端口写成 6199 —— 那是 AstrBot 的端口，
      在协议端自身的构建产物里作为独立数字出现 0 次。协议端整体删掉后，
      这里只剩下两个**核实过**的 MaiBot 端口：
        MaiBot 主服务 8080 → startup_bindings.py:23
        MaiBot WebUI  8001 → startup_bindings.py:24
      值错了的后果很隐蔽：启动器会去探测一个永远不存在的端口，
      于是每次都误报"进程已启动，但端口在 15s 内未就绪"。
      字面量原本在三个文件里各写了一遍，读代码很难看出问题，所以在这里钉死。
    */
    appInfo: (r) => {
      const p = r?.defaults?.service?.ports;
      if (!p) return '缺少 defaults.service.ports';
      if (Number(p.maibot) !== 8080) return `MaiBot 主服务端口应为 8080，实际 ${p.maibot}`;
      if (Number(p.webui) !== 8001) return `MaiBot WebUI 端口应为 8001，实际 ${p.webui}`;
      /* 协议端相关的键必须**不存在** —— 残留一个就是没删干净 */
      if ('napcat' in p) return 'ports 里还残留着已废弃的协议端端口键';
      return true;
    },
    /* 磁盘空间：C: 总容量必须大于 0，防"读失败也返回 0 当成功" */
    getDiskSpace: (r) => (r && r.ok && Number(r.totalBytes) > 0
      ? true
      : `totalBytes 应 > 0，实际 ${r && r.totalBytes}`),
    /* 外部链接白名单：javascript: 必须被拒 */
    openExternalJs: (r) => (r && r.ok === false ? true : 'javascript: 链接未被拒绝，存在注入风险'),
    /*
      更新检查通道必须**如实**回答，而不是永远给一句"检查失败"：
        · 未配置更新源（本仓库当前就是这种）→ configured:false + 提到"未配置"；
        · 已配置但网络不通 → configured:true + 带具体原因；
        · 真发现有新版本 → 必须给出 latest 与 hasUpdate。
      三种都必须带可读 message。这条断言同时钉住了"不许假装检查成功"：
      未配置时 hasUpdate 为 true 是**最坏**的结果（用户会以为有新版本可装）。
    */
    updateCheck: (r) => {
      if (!r || typeof r !== 'object') return '未返回对象';
      if (typeof r.ok !== 'boolean' || typeof r.configured !== 'boolean') return 'ok/configured 不是布尔值';
      if (typeof r.message !== 'string' || !r.message) return '缺少可读 message';
      if (typeof r.current !== 'string' || !/^\d+\.\d+\.\d+/.test(r.current)) return `current 不是版本号：${r.current}`;
      if (r.configured === false && r.hasUpdate !== false) return '未配置更新源却声称 hasUpdate';
      if (r.configured === false && !/未配置/.test(r.message)) return '未配置时 message 没说明是未配置';
      if (r.ok === true && typeof r.hasUpdate !== 'boolean') return 'ok:true 却没给 hasUpdate';
      return true;
    },
    /* 更新状态通道：形状固定为 {ok:true, download}（没下载过时 download 为空） */
    updateState: (r) => {
      if (!r || r.ok !== true) return `期望 ok:true，实际 ${JSON.stringify(r)}`;
      if (!('download' in r)) return '缺少 download 字段';
      if (r.download !== null && typeof r.download !== 'object') return 'download 既不是 null 也不是对象';
      return true;
    },
    /* 设置保存往返：ok 且带回落盘路径 */
    saveSettingsNoop: (r) => (r && r.ok && r.settings
      ? true
      : '空 patch 保存应成功并回显设置'),
    /* 服务状态必须是对象（用于界面渲染，不能是 null） */
    getServicesStatus: (r) => (r && typeof r === 'object' ? true : '服务状态不是对象'),
    /* 终端能力探测必须给出 backend 字段（TerminalPanel 依赖它区分 PTY/降级） */
    terminalCapability: (r) => (r && typeof r.backend === 'string' && r.backend
      ? true
      : '缺少 backend 字段'),
    /* 扫描结果必须带 rootsUsed（总览页用它说明"扫了哪些目录"） */
    scanInstallations: (r) => (r && Array.isArray(r.rootsUsed) ? true : '缺少 rootsUsed'),
    /* 数据分类必须非空（清理面板的下拉依赖它） */
    getDataCategories: (r) => (Array.isArray(r) && r.length > 0 ? true : '分类列表为空'),
    /* 汇总探测：必须把引导需要的全部事实都给齐 */
    envDetectAll: (r) => {
      if (!r || typeof r !== 'object' || r.ok !== true) return '未成功返回';
      for (const k of ['maibot', 'maibotVersion', 'snowluma', 'tools', 'dirs']) {
        if (!r[k] || typeof r[k] !== 'object') return `缺少 ${k}`;
      }
      if (!['supported', 'unsupported', 'unknown'].includes(r.maibotVersion.kind)) {
        return `maibotVersion.kind 非法：${r.maibotVersion.kind}`;
      }
      /* 探测结果里不该再有任何"QQ 注入式协议端"的痕迹 */
      if ('qq' in r || 'napcat' in r) return '探测结果里残留了已废弃的协议端字段';
      return true;
    },
    /* 目录不存在时必须优雅返回 unknown，而不是抛异常 */
    envDetectKindBad: (r) => {
      if (!r || typeof r !== 'object') return '未返回对象';
      if (r.kind !== 'unknown') return `不存在的目录应判为 unknown，实际 ${r.kind}`;
      return true;
    },
    /*
      版本识别：目录不存在时必须说 unknown 而不是猜一个版本。
      猜错版本会让用户"每一步都照做了却永远连不上"，比不判更糟。
    */
    envDetectMaibotVersion: (r) => {
      if (!r || typeof r !== 'object') return '未返回对象';
      if (!['supported', 'unsupported', 'unknown'].includes(r.kind)) return `kind 非法：${r.kind}`;
      if (typeof r.message !== 'string' || !r.message) return '缺少可读 message';
      if (!Array.isArray(r.evidence)) return 'evidence 不是数组';
      return true;
    },
    /* 工具链：Python 必须真的比较版本号，不能只看命令能跑 */
    envDetectTools: (r) => {
      if (!r || typeof r !== 'object') return '未返回对象';
      for (const k of ['python', 'git', 'uv', 'node']) {
        if (!r[k] || typeof r[k] !== 'object') return `缺少 ${k}`;
        if (typeof r[k].ok !== 'boolean') return `${k}.ok 不是布尔值`;
      }
      if (!/^\d+\.\d+\.\d+$/.test(r.python.version || '')) return `Python 版本未解析：${r.python.version}`;
      return true;
    },
    /* WebUI Token：隔离环境没跑过 MaiBot，所以应当是"没抓到"而不是抛异常 */
    maibotWebuiToken: (r) => {
      if (!r || typeof r !== 'object') return '未返回对象';
      if (typeof r.ok !== 'boolean') return 'ok 不是布尔值';
      if (typeof r.token !== 'string') return 'token 不是字符串';
      if (typeof r.message !== 'string' || !r.message) return '缺少可读 message';
      if (r.ok && !r.token) return 'ok=true 却没有 token';
      if (!r.ok && r.token) return 'ok=false 却带着 token';
      return true;
    }
  };

  (async () => {
    for (const [name, fn] of Object.entries(PROBES)) {
      try {
        const r = await fn();
        /*
          探针默认只记录"形状"（ok + 前 8 个 key），不记录值，避免把敏感内容
          写进测试报告。但有些断言（比如校验默认端口是不是上游的真实值）
          必须看到深字段，所以允许探针返回 { value, shape }：
          断言拿到完整 value，报告里只出现 shape 里显式列出的字段。
        */
        const wrapped = r && typeof r === 'object' && 'value' in r && 'shape' in r;
        const value = wrapped ? r.value : r;
        let rec;
        if (wrapped) {
          rec = { keys: Object.keys(r.value || {}).slice(0, 8), ...r.shape };
        } else if (value === undefined) {
          rec = 'undefined';
        } else if (value && typeof value === 'object') {
          rec = { ok: value.ok, keys: Object.keys(value).slice(0, 8) };
        } else {
          rec = String(value).slice(0, 80);
        }
        /* 附加断言：只有形状没有内容的话，恒真的假实现也能"通过" */
        const extra = ASSERTIONS[name];
        if (extra) {
          const verdict = extra(value);
          if (verdict !== true) rec = Object.assign({}, rec, { ASSERT_FAIL: verdict });
        }
        out[name] = rec;
      } catch (e) {
        out[name] = `REJECTED: ${e.message}`;
      }
    }
    report();
  })().catch((e) => report({ fatal: e.message }));
})();
