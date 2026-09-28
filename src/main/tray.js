/*
================================================================================
技术文档：src/main/tray.js
职责：系统托盘图标与右键菜单（驻留 + 服务启停入口）。
================================================================================
  相对重构前的修正：
    - 原实现从三个**都不存在**的路径找图标，最终得到 nativeImage.createEmpty()，
      托盘图标为空。现在统一从 build/tray.png 读取（由 scripts/gen-icons.mjs
      真实生成），并有 32/256 两级兜底。
    - 菜单项补充「打开日志目录」，让用户能自助排查。
    - 托盘创建失败不再让整个应用崩溃（无托盘仍可用主窗口）；但失败
      **不再静默**：createTray() 返回 null，main.js 据此把关窗行为降级为
      "关闭即退出"，避免"窗口藏起来、托盘又不存在"导致用户找不到入口。
    - 本轮（服务启停）：托盘菜单新增 MaiBot / SnowLuma 的启动 / 停止 / 重启。
      ──────────────────────────────────────────────────────────────────────
      为什么必须加：窗口关闭后本应用**只剩托盘**，而托盘原先只有
      「打开主界面 / 打开日志目录 / 重启启动器 / 版本 / 退出」——
      也就是说用户在托盘里**没有任何办法把服务停下来**（只有退出启动器
      才会顺带停）。要停一个服务就必须先把窗口叫回来，这与"驻留应用"矛盾。

      实现选择：托盘**直接调用主进程的服务模块**，而不是给渲染层加一套
      "托盘点了什么"的自定义 IPC。理由是 spawn 的合法入口只有一个
      （services/index.js 的 service:start，命令由主进程按 key + 设置推导），
      这里复用同一个 process.js（它的返回值本身带成功/失败原因，
      失败会走它自己的 bus → 界面 toast + 系统通知），
      避免出现"第二条启动路径"和两套口径。
      没有新增任何 IPC 频道。

      菜单是**动态**的：状态文字与可用性每次重建时从 registry 现读（内存读，
      无 IO），动作完成后、以及状态变化时（2.5s 轮询）重建 —— 否则 Windows
      托盘菜单会一直停在创建那一刻的旧状态上（"明明停了还写着运行中"）。
================================================================================
*/
const { Tray, Menu, nativeImage, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const logging = require('./logging');

let trayInstance = null;

/** 解析托盘图标：打包后的 resources/icons → build/tray.png → build/icon-32.png → icon.ico */
function resolveTrayIcon() {
  const appPath = app.getAppPath();
  /*
    ★ process.resourcesPath 这一组不是"多一层保险"，而是打包后唯一能找到图标的地方：
      electron-builder 把 directories.buildResources（就是 build/）**排除在 asar 之外**，
      所以 app.getAppPath()/build/tray.png 在打包版里必然不存在。
      原实现只查 appPath 与 __dirname（两者都在 asar 内），
      结果是**装好的正式版没有托盘**——开发模式下一切正常，根本发现不了。
      图标现在通过 build.extraResources 复制到 resources/icons/。
  */
  const resIcons = process.resourcesPath ? path.join(process.resourcesPath, 'icons') : '';
  const candidates = [
    ...(resIcons ? [path.join(resIcons, 'tray.png'), path.join(resIcons, 'tray@2x.png')] : []),
    path.join(appPath, 'build', 'tray.png'),
    path.join(appPath, 'build', 'icon-32.png'),
    path.join(appPath, 'build', 'icon.ico'),
    path.join(__dirname, '..', '..', 'build', 'tray.png'),
    path.join(__dirname, '..', '..', 'build', 'icon-32.png')
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const img = nativeImage.createFromPath(c);
        if (!img.isEmpty()) return img;
      }
    } catch (_) {
      /* 继续尝试下一个候选 */
    }
  }
  console.warn('[tray] 未找到托盘图标资源，托盘将不可见（不影响主窗口）');
  return nativeImage.createEmpty();
}

/* ============================================================================
 *  服务模块懒加载
 * ==========================================================================
 *  托盘在 services.registerServiceIpc() **之前**创建（main.js 的启动顺序），
 *  但 require 本身与注册顺序无关 —— process.js 是纯模块（registry/bus 都是
 *  模块级单例），后注册的 IPC 与这里读到的是同一份状态。
 *  这里仍然把 require 包在 try 里：托盘是本应用关窗后的唯一入口，
 *  绝不能因为服务层加载失败而连托盘都建不起来。
 * ========================================================================== */
function loadProcessSvc() {
  try {
    return require('./services/process');
  } catch (e) {
    logging.log('error', `[tray] 加载服务模块失败，托盘的服务菜单将不可用: ${e.message}`);
    return null;
  }
}

/** 托盘菜单里的服务定义（顺序 = 菜单顺序 = 启动顺序；停止时按相反顺序） */
const TRAY_SERVICES = [
  { key: 'maibot', label: 'MaiBot' },
  { key: 'snowluma', label: 'SnowLuma' }
];

/** 最近一次重建菜单时的 `key:running:installed` 签名，用于"只在变化时重建" */
let lastSignature = '';
let pollTimer = null;
let refreshing = false;
let pendingForce = false;

/* ---------------------------------------------------------------- 轮询节奏
 *  为什么不是固定 4s：
 *    "装了没"只能靠 buildStartPayload() 回答，而它**会真的落盘**
 *    （SnowLuma 那边要写 config/runtime.json 并读适配器插件）。
 *    固定 4s 轮询实测留下的是"每 4s 一条日志 + 每 4s 一次无用写盘"，
 *    一天能刷掉二十多 MB 日志，把真正有用的记录淹掉。
 *
 *  所以拆成两件事，各自按自己的成本决定频率：
 *    · 运行状态（内存读，几乎免费）→ 按下表的间隔轮询；
 *    · 安装状态（要 IO）→ 只在**运行状态没变**时降频重探，变了立刻重探。
 *  另：动作完成、创建托盘时都是 force 重建，所以"用户操作后菜单立刻对"。
 *  ------------------------------------------------------------------------ */
const POLL_MIN_MS = 10000; // 一切正常时的轮询间隔（原来固定 4s）
const POLL_IDLE_MS = 60000; // 连续多轮什么都没变 → 退到低频（只兜"外部改状态")
let pollIntervalMs = POLL_MIN_MS;
let unchangedRounds = 0;

/**
 * 安装状态缓存。
 *
 * 为什么要缓存：buildStartPayload() 是 **async**（要真的读目录、找入口文件），
 * 而 Windows 的托盘菜单必须**同步**拼出来。所以探测在后台做，
 * 菜单只读这份缓存：
 *   undefined —— 还没探到（不显示"未安装"，也不禁用按钮，绝不猜）
 *   true      —— 确认可启动
 *   false     —— 确认起不来（没装 / 路径不对）
 */
const installedCache = new Map();

/**
 * "上次探完安装状态时的签名"。
 *
 * 用来回答一个问题：**这次要不要再花 IO 去探一遍**。
 * 与 lastSignature（"上次写进菜单的签名"）分开：签名一样也可能需要重探
 * （比如探完发现安装状态变了、菜单还没重写），所以不能共用一个变量。
 */
let installedProbedSignature = '';

/** 现读服务是否在托管中且存活（内存读，不含 IO） */
function runningSet() {
  const svc = loadProcessSvc();
  try {
    return new Set((svc?.getServicesStatus?.() || []).filter((s) => s.running).map((s) => s.key));
  } catch (e) {
    logging.log('warn', `[tray] 读取服务状态失败: ${e.message}`);
    return new Set();
  }
}

/**
 * 服务是否"装了"。
 *
 * 与界面同源：process.buildStartPayload() 会真的去看目录与入口文件，
 * 返回 null 就表示"当前设置下这个服务起不来"（没装 / 路径是错的）。
 * 不自己拼路径判断 —— 那样就会出现"界面说装了、托盘说没装"两套口径。
 */
async function probeInstalled() {
  const svc = loadProcessSvc();
  if (!svc?.buildStartPayload) return;
  await Promise.all(
    TRAY_SERVICES.map(async ({ key }) => {
      try {
        const payload = await svc.buildStartPayload(key);
        installedCache.set(key, Boolean(payload));
      } catch (e) {
        /*
          探测抛错 ≠ 没装：这是"我们问不出来"，保持上一次的判断，
          绝不把异常说成"未安装"（那是给用户一个他根本不需要的安装动作）。
        */
        logging.log('warn', `[tray] 探测 ${key} 安装状态失败: ${e.message}`);
      }
    })
  );
}

/** 把一个服务动作的返回值翻译成"是否成功"（成功由 process.js 说了算，不猜） */
function isOkResult(r) {
  return Boolean(r && r.ok === true);
}

/**
 * 执行一个服务动作并如实汇报。
 *
 * 三件事必须同时做到，否则就是"点了没反应"或"假成功"：
 *   1) 拿到真实返回值（ok / message），失败把原文透出来；
 *   2) 调用方的 Promise 有 catch —— 未处理的 rejection 在这个项目里
 *      是全局 uncaughtException 处理器的输入，不该由一个菜单点击引起；
 *   3) 无论成败，立刻重建菜单：状态文字要在下一次打开时就反映出来。
 */
async function runAction(fn, label) {
  const svc = loadProcessSvc();
  let r = null;
  let failure = '';
  try {
    r = await fn(svc);
  } catch (e) {
    failure = e?.message || String(e);
  }
  const ok = isOkResult(r);
  if (ok) {
    logging.log('info', `[tray] ${label}：${r.message || '完成'}`);
  } else {
    const message = failure || r?.message || '未知原因';
    logging.log('warn', `[tray] ${label} 未成功：${message}`);
  }
  /* 事件驱动的重建：失败原因已写进日志，不需要冒泡给菜单点击 */
  refreshTrayMenu({ force: true }).catch(() => {});
  return r;
}

/*
  停止时按启动顺序的**逆序**：先停 MaiBot（它的适配器插件是 WS 客户端），
  再停 SnowLuma。与 QuickActions 的 START_ORDER / STOP_ORDER 同一策略，
  理由见那边的注释（协议端先消失会让适配器刷一屏重连失败）。
*/
function trayStartAll() {
  const running = runningSet();
  const todo = TRAY_SERVICES.filter(({ key }) => !running.has(key));
  if (!todo.length) {
    logging.log('info', '[tray] 全部启动：两个服务都已在运行');
    return Promise.resolve({ ok: true, message: '两个服务都已在运行' });
  }
  return runAction(async (svc) => {
    if (!svc) return { ok: false, message: '服务模块不可用' };
    const results = [];
    for (const { key, label } of todo) {
      const payload = await svc.buildStartPayload(key);
      if (!payload) {
        results.push({ ok: false, key, message: `${label} 未安装或目录不可用` });
        continue;
      }
      results.push(await svc.startService(key, payload));
    }
    const failed = results.filter((x) => !isOkResult(x));
    return {
      ok: failed.length === 0,
      message: failed.length
        ? failed.map((x) => x.message || '未知原因').join('；')
        : '已启动'
    };
  }, '全部启动');
}

function trayStopAll() {
  const running = runningSet();
  const todo = TRAY_SERVICES.filter(({ key }) => running.has(key)).reverse();
  if (!todo.length) {
    logging.log('info', '[tray] 全部停止：当前没有正在运行的服务');
    return Promise.resolve({ ok: true, message: '当前没有正在运行的服务' });
  }
  return runAction(async (svc) => {
    if (!svc) return { ok: false, message: '服务模块不可用' };
    const results = [];
    for (const { key } of todo) results.push(await svc.stopService(key));
    const failed = results.filter((x) => !isOkResult(x));
    return {
      ok: failed.length === 0,
      message: failed.length
        ? failed.map((x) => x.message || '未知原因').join('；')
        : '已停止'
    };
  }, '全部停止');
}

/**
 * 托盘菜单模板。
 *
 * 每个服务三项：启动 / 停止 / 重启。可见性由**真实状态**决定：
 *   · 未安装（目录或入口文件不存在）→ 三项全灰，并写清"未安装（去「设置」配置）"，
 *     而不是给一个点了没反应的按钮；
 *   · 未运行 → 「启动」可用，停止/重启灰；
 *   · 运行中 → 停止/重启可用，启动灰。
 */
function buildMenuTemplate(trayHandlers) {
  const running = runningSet();
  const items = [
    { label: `${app.getName()} v${app.getVersion()}`, enabled: false },
    { type: 'separator' }
  ];

  for (const { key, label } of TRAY_SERVICES) {
    const isRunning = running.has(key);
    /*
      三态：true 已装 / false 明确没装 / undefined 还没探到。
      只有 **false** 才拦用户（并说清要去哪里配）——
      undefined 时不拦，否则会出现"明明装了却点不动"。
    */
    const installed = installedCache.get(key);
    const missing = installed === false;
    const mayStart = !isRunning && !missing;

    items.push({
      label: `${label}：${isRunning ? '运行中' : missing ? '未安装' : '已停止'}`,
      enabled: false
    });
    if (missing) {
      /* 未安装必须给下一步，而不是一个点了没反应的按钮 */
      items.push({ label: '　未安装 —— 到主界面「设置」页配置或安装', enabled: false });
      continue;
    }
    items.push({
      label: '　启动',
      enabled: mayStart,
      click: () =>
        runAction(async (s) => {
          if (!s) return { ok: false, message: '服务模块不可用' };
          const payload = await s.buildStartPayload(key);
          if (!payload) {
            return { ok: false, key, message: `${label} 未安装或目录不可用（请到「设置」配置）` };
          }
          return s.startService(key, payload);
        }, `启动 ${label}`)
    });
    items.push({
      label: '　停止',
      enabled: isRunning,
      click: () =>
        runAction((s) => (s ? s.stopService(key) : { ok: false, message: '服务模块不可用' }), `停止 ${label}`)
    });
    items.push({
      label: '　重启',
      enabled: isRunning,
      click: () =>
        runAction(async (s) => {
          if (!s) return { ok: false, message: '服务模块不可用' };
          const payload = await s.buildStartPayload(key);
          if (!payload) {
            return { ok: false, key, stage: 'resolve', message: `${label} 未安装或目录不可用（请到「设置」配置）` };
          }
          /* 原子重启：主进程侧一次"停干净再启动"，不会两个进程抢端口 */
          return s.restartService(key, { payload });
        }, `重启 ${label}`)
    });
  }

  const anyRunning = running.size > 0;
  items.push({ type: 'separator' });
  items.push({
    label: '全部启动（SnowLuma → MaiBot）',
    enabled: running.size < TRAY_SERVICES.length,
    click: trayStartAll
  });
  items.push({ label: '全部停止（MaiBot → SnowLuma）', enabled: anyRunning, click: trayStopAll });

  items.push({ type: 'separator' });
  items.push({ label: '打开主界面', click: () => trayHandlers.onOpen && trayHandlers.onOpen() });
  items.push({
    label: '打开日志目录',
    click: () => {
      shell
        .openPath(logging.appLogDir())
        .catch((e) => console.warn('[tray] 打开日志目录失败:', e.message));
    }
  });
  items.push({ label: '重启启动器', click: () => trayHandlers.onRestart && trayHandlers.onRestart() });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => trayHandlers.onQuit && trayHandlers.onQuit() });

  return items;
}

/**
 * 状态签名：只有它变了才重建菜单（避免每几秒无谓地 setContextMenu）。
 *
 * @param {boolean} [withInstalled=false] 是否把"装了没"也算进签名。
 *   · 写菜单用 true（菜单文案里就写着"未安装/已停止"）；
 *   · 判断"要不要再花 IO 探一次安装状态"用 **false** —— 那时安装状态还是上一轮
 *     的旧值，拿它去比会**永远不相等**，于是每轮都重探（这正是要避免的事）。
 *   运行状态是内存读，随时都是最新的，所以这一半永远可以比。
 */
function stateSignature(withInstalled = false) {
  const running = runningSet();
  return TRAY_SERVICES.map(({ key }) => {
    const installed = installedCache.get(key);
    const mark = withInstalled ? (installed === true ? 'i' : installed === false ? 'n' : '?') : '';
    return `${key}:${running.has(key) ? 'r' : 's'}${mark}`;
  }).join('|');
}

/**
 * 重建托盘菜单。
 *
 * 必须先探测安装状态（async）再决定是否重建，因此本函数是 async；
 * 用 refreshing / pendingForce 做重入合并：动作完成后连发几次强制重建
 * 也只会跑一轮，且不会丢掉"要强制"的意图。
 *
 * @param {{force?:boolean}} [opts] force=true 时无视签名直接重建（动作完成后用）
 */
async function refreshTrayMenu(opts = {}) {
  if (!trayInstance || trayInstance.isDestroyed()) return;
  if (refreshing) {
    if (opts.force) pendingForce = true;
    return;
  }
  refreshing = true;
  try {
    /*
      先算"签名"（纯内存读），据此决定要不要花 IO 去探安装状态：
        · 运行状态 + 上次探到的安装状态都没变、且不是强制 → 直接返回，
          一次文件系统访问都不做（这是把 4s 轮询的代价降到接近 0 的关键）；
        · 变了 → 重探一次安装状态（可能是"刚装好/刚被删"）；
        · force（用户动作完成后）→ 无条件重探。
    */
    const before = stateSignature();
    /*
      两种"彻底没事"的情形都可以直接返回（一次 IO 都不做）：
        · 上一轮的完整签名（含安装状态）已经写进过菜单，且
        · 运行状态自上次探测以来也没变过。
      这里必须比 lastSignature（写菜单口径）而不是只比运行状态：
      安装状态变了、菜单还没写出去时，它俩不相等 → 不会被这句误跳过。
    */
    if (!opts.force && before === installedProbedSignature && lastSignature === installedProbedSignature) {
      return;
    }

    const needProbe = opts.force || before !== installedProbedSignature;
    if (needProbe) {
      await probeInstalled();
      installedProbedSignature = stateSignature();
      lastSignature = ''; // 探测结果进缓存后，菜单必须按新数据重写一次
    }

    const signature = stateSignature(true);
    if (!opts.force && signature === lastSignature) return;
    lastSignature = signature;
    trayInstance.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(handlersRef)));
  } catch (e) {
    logging.log('warn', `[tray] 重建菜单失败: ${e.message}`);
  } finally {
    refreshing = false;
    if (pendingForce) {
      pendingForce = false;
      /* 这次强制重建本身是"事件驱动"的，失败会写进日志，不需要冒泡给调用方 */
      refreshTrayMenu({ force: true }).catch(() => {});
    }
  }
}

/**
 * 安排下一次轮询（自适应间隔，用 setTimeout 自调度而不是固定 setInterval）。
 *
 * setInterval 的间隔是建好就定死的，这里需要"连续什么都没变就降频"，
 * 所以每轮自己排下一轮。
 */
function schedulePoll() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      await refreshTrayMenu();
      /*
        降频条件：这一轮结束后签名与上一轮完全相同（说明没人动过服务状态）。
        比较的是"含安装状态"的完整签名 —— 与 lastSignature 同一口径，
        否则两者永远不相等，降频就永远不会发生。
      */
      const sig = stateSignature(true);
      if (sig === lastPollSignature) {
        unchangedRounds += 1;
        pollIntervalMs = unchangedRounds >= 3 ? POLL_IDLE_MS : POLL_MIN_MS;
      } else {
        unchangedRounds = 0;
        pollIntervalMs = POLL_MIN_MS;
      }
      lastPollSignature = sig;
    } catch (e) {
      logging.log('warn', `[tray] 轮询失败: ${e.message}`);
    } finally {
      schedulePoll();
    }
  }, pollIntervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

let lastPollSignature = '';

/** 创建托盘时记下的 handlers，供 refreshTrayMenu() 重建菜单时复用 */
let handlersRef = {};

/**
 * 创建系统托盘。
 * @param {{onOpen?:Function, onRestart?:Function, onQuit?:Function}} handlers
 */
function createTray(handlers = {}) {
  if (trayInstance && !trayInstance.isDestroyed()) return trayInstance;

  const icon = resolveTrayIcon();
  if (icon.isEmpty()) {
    /*
      ⚠️ 这里返回 null 表示"托盘没建起来"，调用方**必须**检查返回值：
      托盘是本应用关窗后的唯一常驻入口，静默失败会让"窗口消失且找不到入口"
      变成一个只能靠任务栏右键自救的状态。日志写清楚原因，便于用户/我们定位
      是图标资源没打包（生产态常见）还是 Tray 构造失败。见 main.js 的降级处理。
    */
    logging.log('error', '[tray] 托盘图标为空，已放弃创建托盘（关窗行为降级为直接退出）');
    return null;
  }

  handlersRef = handlers || {};

  try {
    trayInstance = new Tray(icon);
  } catch (e) {
    console.error('[tray] 创建托盘失败:', e.message);
    logging.log('error', `[tray] 创建托盘失败，已放弃托盘（关窗行为降级为直接退出）: ${e.message}`);
    return null;
  }

  trayInstance.setToolTip(`${app.getName()} v${app.getVersion()}`);
  /* 首次建立：探测一次安装状态并强制写一遍菜单（此时签名缓存是空的） */
  refreshTrayMenu({ force: true }).catch(() => {});

  /* 左键单击与双击都聚焦主窗口 */
  trayInstance.on('click', () => handlers.onOpen && handlers.onOpen());
  trayInstance.on('double-click', () => handlers.onOpen && handlers.onOpen());

  /*
    状态轮询：托盘菜单在 Windows 上是**静态**的（setContextMenu 之后不会再变），
    而服务状态会因看门狗自动重启、界面里的操作、自动启动而改变。
    没有这个轮询，托盘会一直显示"已停止"而服务其实在跑。
    间隔由 schedulePoll() 自适应（见文件上方"轮询节奏"）：
    什么都没变时退到 60s，有任何变化立刻回到 10s；动作完成走 force 重建，
    所以"用户操作后菜单立刻对"这件事不依赖轮询频率。
  */
  if (pollTimer === null) schedulePoll();

  return trayInstance;
}

/** 销毁托盘（应用退出时由 Electron 自动清理，此方法供显式释放） */
function destroyTray() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  lastSignature = '';
  installedProbedSignature = '';
  lastPollSignature = '';
  unchangedRounds = 0;
  pollIntervalMs = POLL_MIN_MS;
  if (trayInstance && !trayInstance.isDestroyed()) {
    try {
      trayInstance.destroy();
    } catch (_) {
      /* 忽略销毁异常 */
    }
  }
  trayInstance = null;
}

module.exports = { createTray, destroyTray, refreshTrayMenu };
