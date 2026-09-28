/*
================================================================================
技术文档：src/main/services/process.js
职责：子进程生命周期托管（启动 / 停止 / 状态 / 看门狗 / 端口探测）。
================================================================================
  本模块修掉了重构前 5 个"假装在工作"的实现：

  1) 假停止
     child.kill('SIGINT') 在 Windows 上对 python.exe 无效，但函数立刻
     services.delete(key) 并返回 {ok:true}，前端显示"已停止"而进程仍在跑。
     → 现在：taskkill /T /F 杀整棵进程树，**await 到进程真正消失**才返回成功。

  2) 死分支
     原 stopService 中 `setTimeout(() => { if (services.has(key)) ... }, 1500)`
     兜底，但同函数下一行就 services.delete(key)，该分支永远为假。
     → 现在：单一明确的停止路径，无嵌套兜底。

  3) 假看门狗
     getWatchdogStatus() 硬编码 return { shouldNotify: false }，
     外层每 3 秒轮询一次却永远无事发生，而 UI/注释宣称"自动重启"。
     → 现在：真实存在性探测（signal 0）+ 指数退避重启 + 次数上限 + 事件上报。

  4) 死输入通道
     spawn 用 stdio:['ignore','pipe','pipe']，child.stdin 恒为 null，
     但 service:send-input 仍去调用 rec.child.stdin.write() → TypeError。
     → 现在：stdin 为 'pipe'，提供可用的 writeServiceInput()。

  5) 猜启动结果
     用 setTimeout(800ms) 猜"启动成功"，秒退/长启动都判不准。
     → 现在：进程存活 + 可选端口就绪探测，返回结构化启动结果。
================================================================================
*/
const net = require('net');
const { EventEmitter } = require('events');
const { spawnHidden, isAlive, killTree, findProcesses, queryProcessIdentity } = require('./winproc');
const logging = require('../logging');
const { DEFAULT_SETTINGS, APP } = require('../constants');
const { explainExit } = require('./exit-codes');

/**
 * 取默认端口。
 *
 * **不要再写 `|| 6199` 这种字面量兜底。**
 * 那两个字面量正是"协议端端口 = 6199"这个错误猜测的复制源头：
 * constants.js、process.js、app-store.js 三处各写一遍，
 * 改对一处也修不好，而 6199 根本不是协议端的端口
 * （旧的 QQ 注入式协议端正向 WS 默认 3001、WebUI 6099）。
 * 统一从 DEFAULT_SETTINGS 取，保证只有一个定义点。
 */
function defaultPort(key) {
  const n = Number(DEFAULT_SETTINGS?.service?.ports?.[key]);
  return Number.isFinite(n) ? n : null;
}

/** 服务注册表：key → record */
const registry = new Map();

/** 全局事件总线：services/index.js 订阅后转发给渲染进程 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

const WATCHDOG_INTERVAL_MS = 4000;
/** 退避基数：第 n 次重启前等待 RESTART_BASE_MS * 2^(n-1) */
const RESTART_BASE_MS = 1500;
const RESTART_MAX_DELAY_MS = 30000;

let watchdogTimer = null;

/* ============================================================================
 *  工具
 * ========================================================================== */

/** 生成短 id */
function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

/** 取当前设置里的重启上限（实时读取，改设置后立刻生效） */
function restartLimit() {
  try {
    /* 延迟 require 避免与 settings.js 形成加载环 */
    const settings = require('./settings');
    const v = settings.getBackendSettings()?.service?.autoRestartLimit;
    return Number.isFinite(Number(v)) ? Number(v) : DEFAULT_SETTINGS.service.autoRestartLimit;
  } catch (_) {
    return DEFAULT_SETTINGS.service.autoRestartLimit;
  }
}

/** 取当前设置里的启动超时 */
function startupTimeout() {
  try {
    const settings = require('./settings');
    const v = settings.getBackendSettings()?.service?.startupTimeoutMs;
    return Number.isFinite(Number(v)) ? Number(v) : DEFAULT_SETTINGS.service.startupTimeoutMs;
  } catch (_) {
    return DEFAULT_SETTINGS.service.startupTimeoutMs;
  }
}

/* ============================================================================
 *  启动参数构建（主进程侧，单一来源）
 *  ---------------------------------------------------------------------------
 *  为什么放在主进程：
 *    「启动后自动拉起服务」这个功能必须在没有任何渲染层参与的情况下工作 ——
 *    用户可能开机自启，窗口都还没建好就要拉服务。
 *    渲染层原有的 buildStartPayload 依赖 store.draft（用户正在编辑的草稿），
 *    主进程没有这个概念，只认已保存的设置。
 *    因此这里基于**已保存设置**计算，渲染层仍然保留自己的草稿版本用于
 *    "改完设置立刻启动"的场景。
 *
 *  与渲染层的差异（有意为之，避免"假装成功"）：
 *    这里额外做入口文件探测，目录不存在或找不到入口时返回 null 并说明原因，
 *    而不是把明显无效的命令交给 spawn 去失败。
 * ========================================================================== */

/**
 * 推导某个服务的启动参数。
 *
 * ⚠️ 是 async：探测过程中要读文件、写运行时配置，都是异步的。
 *
 * @param {'maibot'|'snowluma'} key
 * @param {{dir?:string}} [opts] dir —— 用指定目录覆盖设置里的路径。
 *   存在的唯一理由是「设置改了还没保存就想启动」：渲染层只能提供一个
 *   **目录**，命令与参数依旧由这里推导，绝不由调用方指定。
 * @returns {Promise<null|{key,command,args,cwd,readyPort}>}
 *   返回 null 表示"这个服务在当前设置下起不来"，调用方据此跳过并给出原因。
 */
async function buildStartPayload(key, opts = {}) {
  const fs = require('fs');
  let cfg = {};
  try {
    const settings = require('./settings');
    cfg = settings.getBackendSettings()?.service || {};
  } catch (_) {
    cfg = {};
  }
  /* MaiBot 那支要用它取主服务端口；SnowLuma 走自己的 snowlumaPorts */
  const ports = cfg.ports || {};

  /*
    --- SnowLuma：现在**唯一**的协议端 ---
    它是**独立 Node 程序**，不注入 QQ、也不需要用户装 QQ，
    所以没有"必须先关 QQ"这个限制。
    端口命名空间是 snowlumaPorts，不是 ports，别拿错。
  */
  if (key === 'snowluma') {
    /*
      目录解析：设置里的值优先，但为空或指向不存在的路径时，
      再试**默认模块位置** —— 程序可能已经装好只是设置没填
      （用户没走「下载安装」按钮，或装了没点保存）。
      没有这个兜底，装好的运行时会被当成"未配置"，用户会去重装一遍。
    */
    const dirOverride = typeof opts.dir === 'string' ? opts.dir.trim() : '';
    let dir = dirOverride || String(cfg.snowlumaDir || '').trim();
    if (!dir || !fs.existsSync(dir)) {
      const fallback = snowlumaDefaultDirs().find((d) => fs.existsSync(d));
      if (fallback && fs.existsSync(fallback)) {
        if (dir && dir !== fallback) {
          logging.log(
            'warn',
            `[service:snowluma] 设置里的目录不存在（${dir}），改用默认模块位置：${fallback}`
          );
        }
        dir = fallback;
      } else {
        return null;
      }
    }
    const slPorts = cfg.snowlumaPorts || {};
    const launch = buildSnowlumaLaunch(dir, slPorts);
    if (!launch) return null;
    if (launch.written) {
      logging.log('info', `[service:snowluma] runtime.json 就绪 → ${launch.written}`);
    }
    return {
      key: 'snowluma',
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      readyPort: launch.readyPort
    };
  }

  /*
    ⚠️ 这里以前还有一大段旧 QQ 注入式协议端的启动分支（含"快速登录"免扫码、
    自己拼注入参数、退回官方 .bat 兜底等三档策略）。
    用户明确要求抛弃它、只用 SnowLuma，所以整段连同它的辅助函数
    一起删了 —— 留着就是永远走不到的死代码。
  */

  /*
    目录来源：调用方指定的目录优先（仅限"设置还没保存"这一种场景），
    但**命令仍然在这里推导** —— 这就是 service:start 敢拒绝渲染层
    command 字段的原因：换目录不需要换执行者。
  */
  const dirOverride = typeof opts.dir === 'string' ? opts.dir.trim() : '';
  const dir = dirOverride && fs.existsSync(dirOverride) ? dirOverride : String(cfg.maibotDir || '').trim();
  if (!dir || !fs.existsSync(dir)) return null;

  /*
    ⚠️ 入口必须用"探测到的那个文件名"，不能写死 main.py。
    ────────────────────────────────────────────────────────────────
    这里曾经是：
        if (!findEntryIn(dir, ['main.py', 'bot.py'])) return null;
        return { args: ['main.py'] };          // ← 写死
    两处不一致：探测能接受 bot.py（所以预检通过、界面显示"路径没问题"），
    但真正执行的是 main.py —— 检查的和使用的不是同一个东西。

    而 MaiBot **从来没有过 main.py**：
      · 官方文档的源码部署写的是 `uv run bot.py`
      · 用户机器上的 0.6.3 目录里只有 bot.py，没有 main.py
    后果：python main.py 直接报 "can't open file 'main.py'"，进程秒退。
    用户看到的是"点启动没反应"，而预检还说路径是对的。

    修法：探测一次、把结果既用于判定也用于拼 args。
  */
  const entry = findEntryIn(dir, MAIBOT_ENTRIES);
  if (!entry) return null;
  /*
    就绪端口以**安装目录自己的 .env** 为准。
    ─────────────────────────────────────────────────────────────────
    实测（用户机器）：MaiBot 1.2.4 的 .env 里写的是 PORT=8000，
    而设置里 ports.maibot 还是默认的 8080。
    后果：进程明明起来了、也确实在监听，探针却一直探 8080，
    15 秒后甩出一句"进程已启动，但端口 8080 在 15s 内未就绪" ——
    用户以为没启动成功，其实只是探错了端口。
    "检查的端口"和"实际监听的端口"必须是同一个，这条在本项目踩过一次了。
  */
  const envPort = readEnvPort(dir, 'PORT');
  const cfgPort = Number(ports.maibot) || 0;
  if (envPort && cfgPort && envPort !== cfgPort) {
    logging.log(
      'info',
      `[service:maibot] 就绪端口以安装目录的 .env 为准：${envPort}（设置里写的是 ${cfgPort}）`
    );
  }
  return {
    key: 'maibot',
    command: resolveMaiBotPython(dir, cfg.pythonPath),
    args: [entry],
    cwd: dir,
    readyPort: envPort || cfgPort || defaultPort('maibot')
  };
}

/**
 * 读安装目录 `.env` 里声明的端口（MaiBot 用 `PORT=8000` 这种形式写）。
 *
 * 读不到、或值不是合法端口，都返回 0 —— 由调用方退回设置里的值，
 * 绝不猜一个数字出来（猜错的后果比"没读到"严重得多）。
 *
 * @param {string} dir MaiBot 安装目录
 * @param {string} key 变量名，如 'PORT'
 * @returns {number} 端口，未知为 0
 */
function readEnvPort(dir, key) {
  const fs = require('fs');
  const nodePath = require('path');
  try {
    const raw = fs.readFileSync(nodePath.join(dir, '.env'), 'utf8');
    const m = new RegExp('^[ \\t]*' + key + '[ \\t]*=[ \\t]*["\']?(\\d{2,5})', 'm').exec(raw);
    if (!m) return 0;
    const p = Number(m[1]);
    return p > 0 && p < 65536 ? p : 0;
  } catch (_) {
    return 0; /* 没有 .env 是正常情况（不是每个安装都带） */
  }
}

/**
 * 用哪个 Python 跑 MaiBot。
 *
 * ⚠️ 这里以前是 `String(cfg.pythonPath || 'python')` —— 而设置里 pythonPath 的
 * 默认值恰好就是 "python"，于是**永远**用 PATH 里的全局解释器。
 * 实测（用户机器）：全局 python 3.12.8 里没有 MaiBot 的任何依赖 ——
 * maim_message / sqlmodel / openai / aiohttp 这些全在 <MaiBot>\.venv 里，
 * 一共 201 个包。后果是：预检说"路径没问题"，一点启动就
 * ModuleNotFoundError 秒退，用户只看到"启动失败"。
 *
 * 优先级：
 *   1) 设置里**显式**填的 pythonPath（只有不是默认的 "python"/"python.exe" 才算显式）
 *      ⚠️ 这一条必须先过 sanitizeMaiBotInterpreter 校验：它是渲染层能直接写的
 *         设置项，不校验就等于把"主进程以启动器身份执行任意程序"送出去。
 *   2) <maibotDir>\.venv\Scripts\python.exe  ← 依赖装在这里，实测可用
 *   3) PATH 里的 python（兜底）
 * 第 2 条是这次新增的：MaiBot 基本都是 `uv sync` 或一键包装出来的，
 * 依赖不会进全局环境，所以默认就得用安装目录自带的那一个。
 */
/**
 * MaiBot 版本准入闸门：只允许 **≥ 1.0.0**。
 *
 * 用户原话："启动器只能启动1.0.0以上 记住几死"。
 * 0.x（实测机器上有 0.6.x / 0.11.6）是**另一代** MaiBot：
 * 配置格式、协议端接入方式、WebUI 都不是一套东西，
 * 就算进程起来了也接不通，用户只会看到"启动了但没用"。
 *
 * 判定用扫描器导出的原件，保证"列表里被过滤掉的版本"和
 * "这里拒绝启动的版本"永远是同一个标准，不会各说各话。
 *
 * 读不出版本时**不拦** —— "没认出来"不等于"太旧"，
 * 误杀一个真正的新版本比放过一个旧版本更糟（同 isBelowMinVersion 的约定）。
 *
 * @param {string} dir MaiBot 安装目录
 * @returns {string|null} 非 null 即为给用户看的拒绝原因
 */
/*
  让服务的颜色活下来。
  ----------------------------------------------------------------------
  两件事，都为了同一个目标：服务输出的颜色能真的到日志页。

  1) Python（麦麦）：colorama 一旦发现 stdout 不是终端，就把 ANSI 颜色码
     全部删掉 —— 它不认任何环境变量（0.4.6 实测 FORCE_COLOR / CLICOLOR_FORCE /
     TERM 全试过，一律被删）。而启动器**正是**用管道接走输出的那一方，
     结果麦麦 bot.py 里用 colorama 打的彩虹彩蛋到日志页就成了一行白字。
     但"接收端不支持颜色"这个前提在这里是假的：日志页现在是真会渲染 ANSI 的
     （LogsPanel.vue 里有 256 色 / 真彩色 / 加粗的解析器）。
     所以我们挂一个只做一件事的 sitecustomize 垫片
     （resources/ansi-shim/sitecustomize.py），把 colorama 的 strip / convert
     关掉。它只对启动器拉起的子进程生效，不碰麦麦的任何文件；
     你自己在 cmd 里跑麦麦时不会被加载。
     ⚠️ 那个目录会进 PYTHONPATH，所以里面**只能有** sitecustomize.py ——
     别往里加别的模块，免得遮蔽用户环境里同名的东西。

  2) Node / 其它 CLI：标准做法是 FORCE_COLOR=1（chalk、picocolors 之类认它）。
     同时把 NO_COLOR 删掉：Node 同时看到 NO_COLOR 和 FORCE_COLOR 时
     会往 stderr 打一条警告，那条警告会混进日志里。
     TERM 也一起给上：不少工具（git / ls / 各类 TUI）靠它决定要不要上色，
     这里和终端页保持一致用 xterm-256color。
*/
function ansiShimDir() {
  const path = require('path');
  const fs = require('fs');
  const candidates = [];
  /* 打包后：extraResources 把 resources/ansi-shim 放到 resources/ansi-shim */
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ansi-shim'));
  /* 开发态：本文件在 dist/main/，往上两层就是项目根 */
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'ansi-shim'));
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 找不到就试下一个 */
    }
  }
  return '';
}

/** 给子进程补上"让颜色活下来"的环境变量（就地改传入的对象） */
function applyColorEnv(env) {
  const shim = ansiShimDir();
  if (shim) {
    const path = require('path');
    env.PYTHONPATH = env.PYTHONPATH ? `${shim}${path.delimiter}${env.PYTHONPATH}` : shim;
    /*
      禁止 Python 在垫片目录里写字节码。
      ────────────────────────────────────────────────────────────────
      垫片目录会被放进 PYTHONPATH，Python 导入 sitecustomize.py 时
      默认会在旁边生成 __pycache__/sitecustomize.cpython-3xx.pyc ——
      开发态生成在 resources/ansi-shim/，然后被打包进正式版
      （实测 release/win-unpacked/resources/ansi-shim/__pycache__/…pyc 已在包里）。
      而上面注释明确写着"那个目录只能有 sitecustomize.py"：
      多出来的 .pyc 既是打包污染，也会让沙箱/校验类断言与实际不符。
      从源头禁掉比事后删除可靠 —— 用户机器上生成的 .pyc 是删不掉的。
    */
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  delete env.NO_COLOR;
  env.FORCE_COLOR = '1';
  env.TERM = 'xterm-256color';
}

function refuseTooOldMaiBot(dir) {
  if (!dir) return null;
  let scanner = null;
  try {
    scanner = require('./scanner');
  } catch (_) {
    return null; /* 判定原件不可用时不做误杀 */
  }
  let version = '';
  try {
    version = String(scanner.readMaiBotVersion(dir)?.version || '').trim();
  } catch (_) {
    return null;
  }
  if (!version) return null;
  if (!scanner.isBelowMinVersion(version)) return null;
  return (
    `这个 MaiBot 是 v${version}，低于启动器支持的最低版本 ` +
    `${scanner.MIN_MAIBOT_MAJOR}.0.0，启动器不会启动它。` +
    `0.x 是另一代 MaiBot（配置格式、协议端接入都不同），起来也接不通。` +
    `请到「安装器」装 1.0.0 或更新的版本。`
  );
}

/* ============================================================================
 *  解释器路径收口（审计：settings.pythonPath → resolveMaiBotPython 提权链）
 * ----------------------------------------------------------------------------
 *  为什么必须在这里再收一次：
 *    services/index.js 的 sanitizeInterpreter() 只覆盖"渲染层**直接递上来**的
 *    pythonExe 参数"（prereq / envcheck 那几条通道）。而这条链根本不经过它：
 *        渲染层 → settings:save 把 service.pythonPath 写成任意路径
 *              → service:start → 主进程**从设置里读出来** → 直接 spawn
 *    settings.js 的 sanitize() 只把 pythonPath 裁剪成字符串（settings.js:96），
 *    不做任何路径校验；buildStartPayload 又把它原样当 command 用。
 *    于是渲染层两步就能让主进程以启动器身份执行任意可执行文件。
 *
 *  判据刻意与 services/index.js 的 sanitizeInterpreter() 同源（都用 github.js 的
 *  isPathAllowed / isExecutablePath / isUnder），**唯一必要的差异**是位置判据：
 *    index.js 那条把"设置里已记录的解释器路径"当作合法来源之一；而在这里，
 *    被校验的值**就是**设置里那个字符串 —— 那条判据会变成自证循环（恒成立），
 *    所以这里换成"位置白名单"：受管/已配置目录、用户机器上常见的 Python 安装根、
 *    以及"本次要使用的麦麦目录"。
 *
 *  ⚠️ 诚实说明这挡不住什么（详见交付报告）：
 *    · 服务端**无法区分**"用户用文件选择器选的"与"渲染层直接塞的"：
 *      dialog:select-file 只返回一个路径字符串，不留下任何凭据，settings:save
 *      存下去的也只是同一个字符串。所以这里只能做"形状校验 + 位置白名单"。
 *    · 因此它挡不住"指向一个本来就在允许位置、且确实叫 python.exe 的既有文件"
 *      —— 但那不构成提权（只是换成了另一个解释器）。
 *    · 它挡不住"通过其它文件写原语把 python.exe 投放到允许位置"；
 *      下载功能那两条落点（启动器数据目录 / 系统下载目录）已整片拒绝，
 *      见 interpreterDownloadHosts()。
 *    · 修到"完全无法伪造"需要主进程侧的**可信选择凭据**（例如
 *      dialog:select-file 命中后由主进程记账），那要改 index.js/settings.js，
 *      不在本次写范围内。
 * ========================================================================== */

/** 与 services/index.js 的 PYTHON_EXE_NAME_RE 逐字一致（那边的常量未导出） */
const PYTHON_EXE_NAME_RE = /^(python|pythonw|py)(\d+(\.\d+)*)?(\.exe|\.cmd|\.bat)?$/i;

/**
 * 下载功能的落点：启动器数据目录 + 系统下载目录。
 *
 * ⚠️ 这两个宿主必须与 services/index.js 的 downloadHosts() 保持一致：
 *    它们是"能被下载写进去"的地方，拿里面的东西当解释器执行，
 *    等于把"下载"和"执行"接成一条链（M-02 → M-11 那条）。
 */
function interpreterDownloadHosts() {
  const nodePath = require('path');
  const out = [];
  try {
    out.push(require('../paths').dataRoot());
  } catch (_) {
    /* 非 ready 阶段取不到就跳过 */
  }
  try {
    const app = require('electron').app;
    const dl = app && typeof app.getPath === 'function' ? app.getPath('downloads') : '';
    if (dl) out.push(dl);
  } catch (_) {
    /* 拿不到下载目录就不加这一条 */
  }
  return out
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => nodePath.resolve(p));
}

/**
 * 用户机器上"正常安装的 Python"可能出现的位置。
 *
 * 存在的唯一理由：放行真实用户选出来的解释器（设置页的文件选择器默认就从这些
 * 地方选），同时把"任意目录里的可执行文件"挡在外面。
 * 刻意**不含** %TEMP% / 下载目录 / 启动器数据目录 —— 那些是投放落点。
 */
function interpreterInstallRoots() {
  const nodePath = require('path');
  const env = process.env;
  const out = [];
  const push = (...parts) => {
    const base = parts.filter(Boolean).join('');
    if (!base) return;
    try {
      out.push(nodePath.resolve(base));
    } catch (_) {
      /* 无法解析的环境变量跳过 */
    }
  };
  /* 全机安装：C:\Program Files\Python312\python.exe ← 设置页最常见的合法选择 */
  push(env.ProgramFiles);
  push(env['ProgramFiles(x86)']);
  /* 每用户安装：%LOCALAPPDATA%\Programs\Python\Python312\python.exe */
  push(env.LOCALAPPDATA, '\\Programs');
  /* 商店版 Python 的别名目录：%LOCALAPPDATA%\Microsoft\WindowsApps */
  push(env.LOCALAPPDATA, '\\Microsoft\\WindowsApps');
  /* conda / scoop / pyenv-win 这些常见的非标准安装 */
  push(env.ProgramData, '\\anaconda3');
  push(env.ProgramData, '\\miniconda3');
  push(env.USERPROFILE, '\\anaconda3');
  push(env.USERPROFILE, '\\miniconda3');
  push(env.USERPROFILE, '\\miniforge3');
  push(env.USERPROFILE, '\\scoop');
  push(env.USERPROFILE, '\\.pyenv');
  return out;
}

/**
 * "把 Python 装到根目录下"这个约定俗成的落点：C:\Python312 / D:\Python / D:\Python312。
 *
 * 为什么单独给一条：python.org 安装器改路径时的默认值就是 C:\Python312，
 * 而中文教程普遍让人装到 D:\Python —— 这类路径不在上面任何环境变量根下，
 * 一刀切拒绝会把这些**完全正常**的用户挡在启动之外。
 *
 * 风险为什么可接受：在盘符根目录下建目录/写文件在默认策略下需要管理员权限，
 * 而"能写这里"的攻击者本来就已经是管理员了；真正要防的"下载落点"
 * （启动器数据目录 / 系统下载目录）另有整片拒绝。
 */
const PYTHON_INSTALL_DIR_RE = /^[a-zA-Z]:\\python[0-9.]*$/i;

/**
 * 校验"要用哪个 Python"。
 *
 * @param {unknown} raw 待校验的值（设置里的 service.pythonPath，或我们推导出的 venv 路径）
 * @param {{dir?:string}} [ctx] dir —— 本次要使用的麦麦目录。
 *   它本身已经是我们决定要执行 bot.py 的地方，所以落在它里面的解释器一并放行：
 *   "设置改了还没保存就想启动"这条合法流程，用的正是这个目录。
 * @returns {{ok:true, exe:string, kind:'default'|'bare'|'path'}|{ok:false, reason:string, message:string}}
 */
function sanitizeMaiBotInterpreter(raw, ctx = {}) {
  const fs = require('fs');
  const nodePath = require('path');

  const c = String(raw == null ? '' : raw).trim();
  /* 1) 空 —— 与既有行为一致：交给系统 PATH 解析 */
  if (!c) return { ok: true, exe: 'python', kind: 'default' };

  /* 2) 裸命令名（不含路径分隔符、也不是盘符绝对路径）：仍由 PATH 解析 */
  if (!/[\\/]/.test(c) && !/^[a-zA-Z]:/.test(c)) {
    if (PYTHON_EXE_NAME_RE.test(c)) return { ok: true, exe: c, kind: 'bare' };
    return {
      ok: false,
      reason: 'bad-name',
      message: `只接受 python / python3 / pythonw / py 这类解释器名，或一个真实存在的 Python 可执行文件路径（当前填的是：${c}）`
    };
  }

  /* 3) 显式路径 */
  let abs;
  try {
    abs = nodePath.resolve(c);
  } catch (_) {
    return { ok: false, reason: 'bad-path', message: `解释器路径无法解析：${c}` };
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    return { ok: false, reason: 'missing', message: `找不到解释器：${abs}` };
  }
  if (!st.isFile()) return { ok: false, reason: 'not-file', message: `解释器不是文件：${abs}` };

  const base = nodePath.basename(abs);
  if (!PYTHON_EXE_NAME_RE.test(base)) {
    return {
      ok: false,
      reason: 'bad-name',
      message: `只允许选择 Python 解释器本身（python.exe / python3 / pythonw.exe / py.exe），当前是：${base}`
    };
  }

  /*
    路径策略不可用时**拒绝**（与 index.js sanitizeInterpreter 的 fail-closed 一致）：
    宁可让用户看到一句明确错误，也不要在没有判据的情况下执行一个来路不明的路径。
  */
  let guard = null;
  try {
    guard = require('./github');
  } catch (_) {
    guard = null;
  }
  if (
    !guard ||
    typeof guard.isPathAllowed !== 'function' ||
    typeof guard.isExecutablePath !== 'function' ||
    typeof guard.isUnder !== 'function'
  ) {
    logging.log('error', '[service:maibot] 路径策略不可用，已拒绝设置里的解释器路径');
    return { ok: false, reason: 'guard-unavailable', message: '解释器校验不可用，已拒绝启动' };
  }
  if (!guard.isExecutablePath(abs)) {
    return { ok: false, reason: 'not-executable', message: `解释器不是可执行类型：${abs}` };
  }

  /* 下载落点整片拒绝（与 services/index.js downloadHosts() 同一策略） */
  for (const host of interpreterDownloadHosts()) {
    if (guard.isUnder(abs, host)) {
      return {
        ok: false,
        reason: 'download-host',
        message: `解释器不能位于启动器的数据目录/下载目录内（那里能被下载写进去），已拒绝：${abs}`
      };
    }
  }

  /* 位置白名单：受管/已配置目录 → 本次要用的麦麦目录 → 常见 Python 安装根 */
  if (guard.isPathAllowed(abs, { mode: 'open' }).ok) return { ok: true, exe: abs, kind: 'path' };
  const dir = typeof ctx.dir === 'string' ? ctx.dir.trim() : '';
  if (dir && guard.isUnder(abs, dir)) return { ok: true, exe: abs, kind: 'path' };
  for (const root of interpreterInstallRoots()) {
    if (guard.isUnder(abs, root)) return { ok: true, exe: abs, kind: 'path' };
  }
  /* C:\Python312 / D:\Python 这类"盘符根下的标准安装名" */
  if (PYTHON_INSTALL_DIR_RE.test(nodePath.dirname(abs))) return { ok: true, exe: abs, kind: 'path' };

  return {
    ok: false,
    reason: 'not-listed',
    message:
      `解释器路径不在受管/已配置范围内，已拒绝：${abs}` +
      '（可把 Python 放在麦麦目录等已配置位置，或先在「设置」里重新选择并保存该解释器路径）'
  };
}

/**
 * 设置里填的解释器路径不可用（形状/落点/可执行类型不合格）时抛出。
 * 由 buildStartPayload 抛出 → IPC 的 safeHandle 会把它转成 {ok:false,message}
 * 直接显示给用户；autoStartConfigured 里自行捕获并如实记 failed。
 */
class InterpreterRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InterpreterRejectedError';
    this.code = 'E_INTERPRETER_REJECTED';
  }
}

function resolveMaiBotPython(dir, configured) {
  const fs = require('fs');
  const nodePath = require('path');
  const c = String(configured || '').trim();
  const isDefault = !c || /^python(\.exe)?$/i.test(c);

  /*
    ① 设置里**显式**填的解释器 —— 提权链的入口，先校验再使用。
       非法时**明确失败**，不静默换成 'python'：静默替换会让用户以为
       "配置生效了"，实际跑的是另一个解释器（正是本文件其它条目批评过的行为），
       而且把一次真实的攻击/错误配置伪装成"启动失败"。
  */
  if (!isDefault) {
    const verdict = sanitizeMaiBotInterpreter(c, { dir });
    if (!verdict.ok) {
      const message =
        `设置里的 Python 解释器不可用，已拒绝用它启动 MaiBot：${verdict.message}` +
        '。请到「设置 → 服务」重新选择 python.exe 并保存，或清空该项以使用麦麦目录自带的 .venv。';
      logging.log('error', `[service:maibot] ${message}`);
      bus.emit('service:interpreter-rejected', { configured: c, reason: verdict.reason, message });
      throw new InterpreterRejectedError(message);
    }
    return verdict.exe;
  }

  /*
    ② 麦麦目录自带的 venv（依赖装在这里，实测可用）。
       这条路径是**我们推导出来的**，同样过一遍校验 —— 它由 maibotDir/启动目录
       派生，而那两个值渲染层能改（settings:save / service:start 的 cwd）。
       校验不过时**退回 PATH 里的 python**（等价于"venv 不存在"这个既有分支），
       并留一条 error 日志说明原因: 这里不硬失败，是因为 venv 不是用户手填的值，
       某些部署里它可能是个包装脚本/链接，硬失败会误伤；
       而"不用它"本身已经达到了安全目的（不会执行来路不明的可执行文件）。
  */
  const venv = nodePath.join(dir, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venv)) {
    const verdict = sanitizeMaiBotInterpreter(venv, { dir });
    if (verdict.ok) return verdict.exe;
    logging.log(
      'error',
      `[service:maibot] 麦麦目录自带的 .venv 未通过校验（${verdict.message}），改用 PATH 里的 python`
    );
  }
  return c || 'python';
}

/**
 * MaiBot 的入口文件候选，按优先级排列。
 * bot.py 放第一 —— 这是官方文档（uv run bot.py）和实际仓库里唯一的入口。
 * 其余几个是为早期/衍生版本留的兼容，顺序不重要，反正返回值会被真正使用。
 */
const MAIBOT_ENTRIES = ['bot.py', 'main.py', 'maibot.py', 'launcher.py', 'run.py'];

/*
  ⚠️ 这里删掉了两个函数：一个靠注册表找 QQ.exe，
  另一个拼注入用的环境变量和 Hook 脚本。
  它们都是"把协议端注入 QQ 进程"那套方案的产物。
  SnowLuma 是**独立 Node 进程**，不注入、不碰 QQ.exe，所以这一整套
  （连同它依赖的注册表探测）都没有存在意义了。留着就是死代码。
*/

/** 在目录内按候选顺序找第一个存在的入口文件，返回文件名或 '' */
function findEntryIn(dir, candidates) {
  const fs = require('fs');
  const nodePath = require('path');
  for (const name of candidates) {
    try {
      if (fs.existsSync(nodePath.join(dir, name))) return name;
    } catch (_) {
      /* 继续探测下一个 */
    }
  }
  return '';
}

/**
 * SnowLuma 运行时目录的判定标志。
 * 核实自官方发布包 SnowLuma-v<版本>-win-x64.zip 的解压结果：
 *   node.exe（自带运行时）、index.mjs（入口）、native/、client/、
 *   package.json（name = "@snowluma/runtime"）
 * 只要 index.mjs 在，就认为是 SnowLuma 目录 —— node.exe 可能缺失
 * （lite 包不含 node.exe，那时退回用系统 node）。
 */
const SNOWLUMA_ENTRIES = ['index.mjs'];

/**
 * SnowLuma 运行时的**默认模块位置**（解压安装的落点）。
 *
 * 为什么要有这个兜底：
 *   snowlumaDir 是设置里的一项，用户没走过「下载安装」按钮、或者
 *   装了之后没点保存，它就是空的 —— 而此时程序其实**已经装好了**，
 *   界面却显示"未配置"，用户会以为得重装一遍。
 *   （这不是假设：实测时就是这么发生的，装好的运行时因为设置里是空字符串而不被识别。）
 *
 * 优先用 %LOCALAPPDATA%\<APP.id>\resources\modules\snowluma，
 * 与其它模块的存放位置保持一致（同一个 modules 根目录）。
 */
function snowlumaDefaultDirs() {
  const nodePath = require('path');
  const out = [];
  try {
    const candidates = [process.env.LOCALAPPDATA, process.env.APPDATA];
    for (const base of candidates) {
      if (!base) continue;
      out.push(nodePath.join(base, APP.id, 'resources', 'modules', 'snowluma'));
    }
  } catch (_) {
    /* 环境变量缺失就算了，兜底只是锦上添花 */
  }
  return out;
}

/**
 * 按 SnowLuma 的约定拼启动参数并准备它需要的配置文件。
 *
 * 契约来源（对照参考实现 MaiBot OneKey 的 SnowLuma 分支核实过）：
 *   · 命令：<root>\node.exe  <root>\index.mjs   （没有 node.exe 就用系统 node）
 *   · cwd ：SnowLuma 根目录（它会相对 cwd 找 config/ 和 client/）
 *   · 配置：<root>\config\runtime.json，至少要写 webuiPort
 *   · 就绪：等 WebUI 端口（默认 5099）
 *
 * ⚠️ 为什么不能走它自带的 launcher.bat：
 *    内容是 `node ./index.mjs` + **pause**（实测 23 字节，CRLF=1）。
 *    我们是拿管道当 stdin 的，pause 会吃掉后续写进去的输入。
 *    这个坑在旧的 QQ 注入式协议端的启动 .bat 上已经踩过一次。
 *
 * ⚠️ 关于 hookAutoLoad：
 *    参考实现写死 false。SnowLuma 本身具备注入 QQ 的能力（native/ 下那个
 *    dll/node 模块），但**开机自动注入**会带来"用户没打算注入却被注入了"
 *    的问题。这里同样默认 false，注入与否交给用户在 SnowLuma 自己的
 *    WebUI 里决定 —— 我们只负责把它正确拉起来。
 *
 * @returns {null|{command:string,args:string[],cwd:string,readyPort:number,written?:string}}
 */
function buildSnowlumaLaunch(dir, ports) {
  const fs = require('fs');
  const nodePath = require('path');

  const entry = findEntryIn(dir, SNOWLUMA_ENTRIES);
  if (!entry) return null;

  /*
    node 的取值顺序：
      1) 自带的 node.exe —— 官方完整包（win-x64.zip）里就有，
         这样即使用户机器上没装 Node 也能跑（lite 包才需要系统 node）。
      2) 系统 PATH 里的 node。
    拿不到任何一个就没法启动，返回 null 让上层明确报"缺 node"，
    而不是 spawn 一个必然失败的命令。
  */
  const bundled = nodePath.join(dir, 'node.exe');
  const command = fs.existsSync(bundled) ? bundled : 'node';

  /*
    写 config/runtime.json。
    webuiPort 用用户配置的值（默认 5099）—— SnowLuma 自己会在这个端口起 WebUI，
    写错了用户就打不开它的面板。
    已存在时**合并**而不是覆盖：这份文件里还有 webuiHost / webuiTls /
    logMaxTotalMb 等用户在 SnowLuma 面板里改过的项，覆盖掉等于抹掉用户设置。
  */
  let written = '';
  try {
    const cfgDir = nodePath.join(dir, 'config');
    const cfgFile = nodePath.join(cfgDir, 'runtime.json');
    fs.mkdirSync(cfgDir, { recursive: true });

    let cur = {};
    try {
      cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (_) {
      /* 不存在或不是合法 JSON，按空对象处理，下面整体重写 */
    }
    const next = {
      ...cur,
      webuiPort: Number(ports.webui) || 5099,
      /* 见上面注释：不替用户开启自动注入 */
      hookAutoLoad: cur.hookAutoLoad === true
    };
    const text = JSON.stringify(next, null, 2);
    /* 内容一致就不重写，避免每次启动都改动文件时间戳 */
    let same = false;
    try {
      same = fs.readFileSync(cfgFile, 'utf8') === text;
    } catch (_) {
      same = false;
    }
    if (!same) {
      fs.writeFileSync(cfgFile, text, 'utf8');
      written = cfgFile;
    } else {
      written = cfgFile;
    }
  } catch (e) {
    logging.log('warn', `[service:snowluma] 写入 runtime.json 失败（不影响启动）: ${e.message}`);
  }

  return {
    command,
    args: [entry],
    cwd: dir,
    readyPort: Number(ports.webui) || 5099,
    written
  };
}

/**
 * 启动后自动拉起已配置的服务（general.autoStart）。
 * 由 main.js 在主窗口就绪后调用。
 * @returns {Promise<{started:string[], skipped:string[], failed:Array<{key:string,message:string}>}>}
 */
async function autoStartConfigured() {
  const summary = { started: [], skipped: [], failed: [] };

  let enabled = false;
  try {
    const settings = require('./settings');
    enabled = Boolean(settings.getBackendSettings()?.general?.autoStart);
  } catch (_) {
    enabled = false;
  }
  if (!enabled) return summary;

  /*
    启动顺序：**先起 SnowLuma，后起 MaiBot。**
    原实现是 ['maibot', 另一个后端] —— 顺序反了。

    为什么顺序不能反：
      MaiBot 的官方适配器插件（MaiBot-SnowLuma-Adapter）是
      **WebSocket 客户端**，连的是 SnowLuma 那边的**正向 WS 服务器**。
      如果 MaiBot 先起，它会连不上、不断重试并刷错误日志；
      虽然后端起来后通常能自动连上，但用户会先看到一屏"连接失败"，
      很容易误判成装坏了。
      而且下面 startService 会等到 readyPort 就绪才返回，所以先起 SnowLuma
      能保证轮到 MaiBot 时那个端口已经真的在监听。

    ⚠️ 这里以前还有一个"按 qqBackend 决定谁先谁后"的分支。
    协议端只剩 SnowLuma 一种了，二选一这个概念不存在，顺序也就固定了。
  */
  const backendOrder = ['snowluma'];

  for (const key of [...backendOrder, 'maibot']) {
    /* 已在运行则跳过（例如用户手动先启动了） */
    if (isServiceRunning(key)) {
      summary.skipped.push(key);
      continue;
    }
    /*
      解释器配置非法时 buildStartPayload 会抛 InterpreterRejectedError
      （见 resolveMaiBotPython）。这里**按 key 捕获**，绝不让一个服务的坏配置
      把整轮自动启动连坐掉（SnowLuma 本该先起、后面的服务也要照常处理），
      同时如实记进 failed —— 不是"未配置"那种 skipped。
    */
    let payload = null;
    try {
      payload = await buildStartPayload(key);
    } catch (e) {
      summary.failed.push({ key, message: e.message });
      logging.log('error', `[autostart] ${key} 启动参数推导失败，已跳过: ${e.message}`);
      continue;
    }
    if (!payload) {
      summary.skipped.push(key);
      logging.log('info', `[autostart] ${key} 未配置或找不到入口，跳过`);
      continue;
    }
    try {
      const r = await startService(key, payload);
      if (r?.ok) summary.started.push(key);
      else summary.failed.push({ key, message: r?.message || '启动失败' });
    } catch (e) {
      summary.failed.push({ key, message: e.message });
    }
  }

  if (summary.started.length) {
    logging.log('info', `[autostart] 已自动启动: ${summary.started.join(', ')}`);
  }
  for (const f of summary.failed) {
    logging.log('warn', `[autostart] ${f.key} 自动启动失败: ${f.message}`);
  }
  return summary;
}

/** 探测单个端口是否已被监听（即服务已就绪） */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch (_) {
      finish(false);
    }
  });
}

/**
 * 查出正在监听某个端口的进程 PID（Windows：解析 netstat -ano）。
 *
 * 为什么要它：probePort 只能回答"这个端口有人监听吗"，
 * **回答不了"是不是我们自己的服务在监听"**。
 * 实测踩到的坑：MaiBot 因 ImportError 秒退，而 8080 恰好被另一个程序
 * （zhenxun_bot）占着，于是就绪探针立刻返回"端口已就绪"，
 * 界面/log 显示「已启动并就绪（端口 8080）」—— 服务其实是崩的。
 * 用户看到"就绪"却用不了，比明确报错更难排查。
 *
 * 这里只在**启动前**调用一次（不在轮询里），成本可以接受。
 * @returns {Promise<number|null>} 监听该端口的 PID，查不到返回 null
 */
function findPortOwnerPid(port) {
  const p = Number(port);
  if (!Number.isFinite(p)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      /* -a 全部连接 -n 不反查 -o 带 PID；只关心 LISTENING */
      child = spawnHidden('netstat', ['-ano', '-p', 'TCP'], {});
    } catch (_) {
      resolve(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* 忽略 */
      }
      finish(null);
    }, 4000);
    timer.unref?.();
    child.stdout?.on('data', (d) => {
      if (out.length < 400000) out += d.toString();
    });
    child.on('error', () => finish(null));
    child.on('exit', () => {
      const suffix = `:${p}`;
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        /* 形如: TCP  0.0.0.0:8080  0.0.0.0:0  LISTENING  25836 */
        if (cols.length < 5) continue;
        if (!cols[1].endsWith(suffix)) continue;
        const pid = Number(cols[cols.length - 1]);
        if (Number.isFinite(pid)) finish(pid);
        return;
      }
      finish(null);
    });
  });
}

/**
 * 检查端口占用情况（用"能否 bind"判断，比 connect 更准）。
 * @param {number[]} ports
 */
async function checkPorts(ports = []) {
  const out = [];
  for (const raw of ports) {
    const port = Number(raw);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      out.push({ port: raw, valid: false, inUse: false });
      continue;
    }
    const inUse = await isPortBusy(port);
    out.push({ port, valid: true, inUse });
  }
  return out;
}

/**
 * 某个端口在这台机器上是否已被占用。
 *
 * 为什么不能只 bind 127.0.0.1：
 *   服务若监听在通配地址（0.0.0.0 / ::，MaiBot 的 HOST 就可能是它），
 *   Windows 允许另一个进程再 bind 到 127.0.0.1 上 —— 于是"能否 bind"
 *   这个判据会返回"能"，把**已经被占用**的端口报成空闲。用户看到的是
 *   「端口可用」，启动却立刻失败。
 *
 * 三个地址都试一遍，只要有一个报"地址已被占用/无权限"就算占用；
 * :: 在不支持 IPv6 的机器上会报 EAFNOSUPPORT，那不算占用。
 */
async function isPortBusy(port) {
  const tryBind = (host) =>
    new Promise((resolve) => {
      const server = net.createServer();
      const done = (busy) => {
        server.removeAllListeners();
        try {
          server.close();
        } catch (_) {
          /* 未开始监听时 close 会抛，忽略 */
        }
        resolve(busy);
      };
      server.once('error', (err) => {
        const code = err && err.code;
        done(code === 'EADDRINUSE' || code === 'EACCES');
      });
      server.once('listening', () => done(false));
      try {
        server.listen(port, host);
      } catch (err) {
        const code = err && err.code;
        done(code === 'EADDRINUSE' || code === 'EACCES');
      }
    });

  for (const host of ['0.0.0.0', '::', '127.0.0.1']) {
    if (await tryBind(host)) return true;
  }
  return false;
}

/* ============================================================================
 *  服务启动
 * ========================================================================== */

/**
 * 启动一个被托管的服务。
 *
 * @param {string} key 'maibot' | 'snowluma'
 * @param {{command:string, args?:string[], cwd?:string, env?:object,
 *          readyPort?:number, detach?:boolean}} options
 * @returns {Promise<{ok:boolean, key:string, pid?:number, ready?:boolean,
 *                    readyVia?:string, message:string, restartCount?:number}>}
 */
async function startService(key, options = {}) {
  /*
    并发守卫（见 startInFlight 的注释）。放在最外层：连点两次「启动」时，
    第二次拿到的是一句明确的"正在启动中"，而不是第二个子进程。
  */
  if (startInFlight.has(key)) {
    logging.log('warn', `[service:${key}] 启动请求被忽略：上一次启动还在进行中`);
    return { ok: false, key, busy: true, message: '该服务正在启动中，请稍候' };
  }

  /*
    手动启动 = 用户的全新意图，先把上一轮的连续失败计数清零。
    （看门狗自己发起的重启不走这里，走 restartServiceInternal，
      否则每轮都会把自己刚记上的次数抹掉 —— 那正是原来的 bug 形态。）
  */
  clearRestartCount(key);

  startInFlight.set(key, { restartToken: null, counted: false });
  try {
    return await startServiceImpl(key, options);
  } finally {
    startInFlight.delete(key);
  }
}

/**
 * 看门狗内部重启入口。
 *
 * 与 startService 的唯一区别：**不清零**重启计数。
 * 抽成独立函数而不是加一个 `{ internal: true }` 选项，是为了让
 * "谁会清零计数"这件事在代码里一眼可查 —— 只有手动入口会清。
 */
async function restartServiceInternal(key, options = {}) {
  if (startInFlight.has(key)) {
    logging.log('warn', `[service:${key}] 自动重启被忽略：上一次启动还在进行中`);
    return { ok: false, key, busy: true, message: '该服务正在启动中，请稍候' };
  }
  startInFlight.set(key, { restartToken: 'auto-restart', counted: false });
  try {
    return await startServiceImpl(key, options);
  } finally {
    startInFlight.delete(key);
  }
}

async function startServiceImpl(key, options = {}) {
  const {
    command,
    args = [],
    cwd,
    env = {},
    readyPort,
    detach = false
  } = options;

  if (!command) {
    return { ok: false, key, message: '缺少可执行命令' };
  }

  /* 已存在则等待旧进程真正结束，避免端口占用导致新进程起不来 */
  if (registry.has(key)) {
    const prev = registry.get(key);
    if (isAlive(prev.pid)) {
      logging.log('warn', `[service:${key}] 已存在运行实例 pid=${prev.pid}，先停止`);
      await stopService(key, { [KEEP_RESTART_COUNT]: true });
    } else {
      registry.delete(key);
    }
  }

  /* 校验工作目录：原实现只在启动失败后才报错，这里提前给出明确提示 */
  if (cwd) {
    const fs = require('fs');
    if (!fs.existsSync(cwd)) {
      return { ok: false, key, message: `工作目录不存在: ${cwd}` };
    }
  }

  /*
    用户死规矩（原话）："启动器只能启动1.0.0以上 记住几死"。
    ──────────────────────────────────────────────────────────────────
    这里是**唯一**真正 spawn 子进程的地方：界面点「启动」、点「重启」、
    开机自启、点「全部启动」，最后都会落进这个函数 ——
    闸门装在这里，上面那几条路就全被拦住了。
    为什么不能只在界面上拦：渲染层可以拿草稿里的路径直接发 payload，
    主进程要是照单 spawn，界面那层"禁用按钮"就只是装饰。
  */
  if (key === 'maibot') {
    const refuse = refuseTooOldMaiBot(cwd);
    if (refuse) {
      logging.log('warn', `[service:maibot] 拒绝启动：${refuse}`);
      return { ok: false, key, message: refuse, blockedBy: 'version' };
    }
  }

  /* 子进程统一 UTF-8，解决中文日志乱码（替代原来无效的 chcp 65001） */
  const childEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    ...env
  };

  /* 颜色能不能活下来，取决于这几个环境变量（见 applyColorEnv 的注释） */
  applyColorEnv(childEnv);

  /*
    启动前的端口基线。
    ----------------------------------------------------------------------
    probePort 只回答"有人监听吗"。如果这个端口**在我们启动之前就已经被别人占着**，
    那么它开着这件事跟我们自己的服务没有任何关系，绝不能拿它当"已就绪"的证据。

    实测事故：MaiBot 因 ModuleNotFoundError 秒退，而 8080 正好被另一个程序
    （zhenxun_bot）占着 —— 就绪探针立刻通过，日志和界面都显示
    「已启动并就绪（端口 8080）」，服务其实是崩的。用户会以为一切正常。

    所以先记下基线；若启动前就被占用，waitForStartup 会放弃用端口判定就绪，
    退回"进程存活"判定，并在消息里说清是谁占着。
  */
  const readyPortNum = Number.isFinite(Number(readyPort)) ? Number(readyPort) : null;
  let portPreOccupiedBy = null;
  if (readyPortNum) {
    if (await probePort(readyPortNum)) {
      portPreOccupiedBy = await findPortOwnerPid(readyPortNum);
      logging.log(
        'warn',
        `[service:${key}] 端口 ${readyPortNum} 在启动前已被占用` +
          (portPreOccupiedBy ? `（pid ${portPreOccupiedBy}）` : '') +
          '，不会用该端口判断本次启动是否就绪'
      );
    }
  }

  let child;
  try {
    child = spawnHidden(command, args, {
      cwd: cwd || undefined,
      env: childEnv,
      /*
        关键修正：stdin 必须是 'pipe'。
        重构前用 'ignore'，child.stdin 为 null，导致 send-input 必然 TypeError。
        对于 detach（带自己 GUI/守护逻辑的协议端）仍保留 stdin 以便写指令。
      */
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });
  } catch (e) {
    logging.log('error', `[service:${key}] spawn 失败: ${e.message}`);
    return { ok: false, key, message: `启动失败: ${e.message}` };
  }

  const record = {
    key,
    child,
    pid: child.pid,
    command,
    args,
    cwd: cwd || '',
    /*
      存一份本次真正用的环境变量。
      看门狗自动重启时原样复用 —— 修之前 scheduleRestart 只传
      command/args/cwd/readyPort/detach，用户的自定义环境变量
      （以及我们补的 PYTHONPATH/FORCE_COLOR/TERM）在自动重启后就静默消失了，
      表现为"手动启动正常、自动重启后行为不一样"。
    */
    env: { ...env },
    startedAt: Date.now(),
    /** 是否为主动停止（主动停止不触发看门狗重启） */
    intentionalStop: false,
    /**
     * 看门狗已重启次数 —— **只作快照**，权威值是 restartCounts。
     * 这个字段会随 record 一起被 exit 处理器删掉，所以谁都不能拿它当计数器
     * （原来就是这么丢的）。保留它只是为了 status 返回值的形状不变。
     */
    restartCount: getRestartCount(key),
    /** 最近一次退出的信息 */
    lastExit: null,
    readyPort: readyPortNum,
    /** 启动前该端口是否已被别的程序占用（占用者 pid，未占用为 null） */
    portPreOccupiedBy,
    detach: Boolean(detach),
    /** 启动代次：用于丢弃过期进程的事件（避免重启竞态） */
    generation: shortId()
  };
  registry.set(key, record);

  attachChildListeners(record);

  logging.log(
    'info',
    `[service:${key}] 已启动 pid=${child.pid} cmd="${command} ${args.join(' ')}" cwd=${cwd || '(inherit)'}`
  );

  /* ---- 等待启动结果：先看是否秒退，再（可选）等端口就绪 ---- */
  const result = await waitForStartup(record);

  bus.emit('service:started', {
    key,
    pid: record.pid,
    ok: result.ok,
    ready: result.ready,
    readyVia: result.readyVia,
    message: result.message
  });

  return { key, pid: record.pid, restartCount: getRestartCount(key), ...result };
}

/**
 * 内部重启把参数原样透传给 stopService 时用的标记。
 *
 * 为什么需要：startServiceImpl 在"已被托管且仍存活"时会先 stopService 收掉旧实例，
 * 而 stopService 会清零重启计数（那对用户手动停止是对的）。
 * 但自动重启这条路上清零＝每轮都从 1 重新数，正是无限重启的老 bug。
 * 所以自动重启给 stopService 带上这个标记，让它别动计数。
 */
const KEEP_RESTART_COUNT = Symbol('keepRestartCount');

/**
 * 判定启动是否成功。
 * 策略：
 *   1) 若进程在 1.2s 内就退出，直接判定失败并带上退出码（原本要等到用户手动刷新才发现）
 *   2) 若声明了 readyPort，轮询该端口直到就绪或超时 —— 这才是"真正启动完成"
 *   3) 否则视为"进程存活即启动成功"
 */
function waitForStartup(record) {
  /* 只取真正用到的两个字段；其余信息（如 key）在需要时直接读 record */
  const { pid, readyPort } = record;
  const timeoutMs = startupTimeout();

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(payload);
    };

    const poll = setInterval(async () => {
      /*
        主动停止优先于一切判断。
        点「停止」之后，启动判定往往还没结束（最长 15s）：进程一死，
        下面那条 isAlive 判断就会走"进程启动后立即退出"分支，
        界面于是收到一条**假失败**（红色提示 + 系统通知），
        而用户明明是自己停的。所以这里先看 intentionalStop。
      */
      if (record.intentionalStop) {
        finish({ ok: false, stopped: true, ready: false, message: '已主动停止' });
        return;
      }

      /* 进程已死 → 启动失败 */
      if (!isAlive(pid)) {
        const exit = record.lastExit;
        const ex = explainExit(exit?.code ?? null, exit?.signal ?? null);
        finish({
          ok: false,
          ready: false,
          message: exit
            ? `进程启动后立即退出 —— ${ex.display}`
            : '进程启动后立即退出（未取得退出码）'
        });
        return;
      }

      /* 无端口要求：存活超过 1.2s 即认为启动成功 */
      if (!readyPort) {
        if (Date.now() - startedAt >= 1200) {
          finish({ ok: true, ready: true, readyVia: 'process-alive', message: '已启动' });
        }
        return;
      }

      /* 有端口要求：等端口就绪 */
       
      const open = await probePort(readyPort);
      if (open && !record.portPreOccupiedBy) {
        finish({
          ok: true,
          ready: true,
          readyVia: 'port',
          message: `已启动并就绪（端口 ${readyPort}）`
        });
        return;
      }

      /*
        端口开着，但它**启动前就被别人占着** —— 这不能证明我们的服务起来了。
        （见 startService 里 portPreOccupiedBy 的说明：不这样区分的话，
        MaiBot 崩了也会显示"已启动并就绪（端口 8080）"。）
        退回"进程存活"判定，并把真实情况说清楚，不要给一个假的"就绪"。
      */
      if (open && record.portPreOccupiedBy) {
        if (Date.now() - startedAt >= 1200) {
          const who = `pid ${record.portPreOccupiedBy}`;
          finish({
            ok: true,
            ready: false,
            readyVia: 'process-alive',
            message:
              `进程已启动，但端口 ${readyPort} 在启动前就被 ${who} 占用，` +
              '无法据此判断本服务是否就绪（请先关掉占用该端口的程序，或改用其它端口）'
          });
        }
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        /*
          超时不是"失败"，但也绝不是"已就绪"。
          原实现返回 ok:true 且不带任何标记，界面随即弹绿色「已启动」——
          服务可能还在装依赖、也可能卡在半死不活的状态，用户拿到的是假确认。
          现在拆成两件事：
            · ok 仍为 true（进程确实活着，不该按失败处理，也不该触发看门狗）；
            · 额外带 degraded:true，界面据此显示**警告色**的
              「已启动（端口未就绪，仍在等待）」，而不是绿色成功。
          同时在后台继续等端口，真的开了再补发 service:ready。
        */
        finish({
          ok: true,
          ready: false,
          degraded: true,
          readyVia: 'timeout',
          message: `进程已启动，但端口 ${readyPort} 在 ${Math.round(timeoutMs / 1000)}s 内未就绪（仍在后台等待）`
        });
        watchReadyInBackground(record);
      }
    }, 400);

    /* 立即探一次，避免最短 400ms 的额外延迟 */
    setTimeout(() => {
      if (record.intentionalStop && !settled) {
        finish({ ok: false, stopped: true, ready: false, message: '已主动停止' });
        return;
      }
      if (!isAlive(pid) && !settled) {
        const exit = record.lastExit;
        finish({
          ok: false,
          ready: false,
          message: exit
            ? `进程启动后立即退出 —— ${explainExit(exit.code ?? null, exit.signal ?? null).display}`
            : '进程启动后立即退出（未取得退出码）'
        });
      }
    }, 250);
  });
}

/** 绑定子进程事件：日志泵、退出处理、看门狗登记 */
function attachChildListeners(record) {
  const { child, key, generation } = record;

  /* ---- stdout / stderr → 服务日志缓冲（按行拆分，60ms 聚合在 log.js 内） ---- */
  const pump = (chunk, source) => {
    /* 过期代次的进程（已被重启替换）不再写入日志，避免串台 */
    const current = registry.get(key);
    if (!current || current.generation !== generation) return;
    try {
      const logStore = require('./log');
      logStore.appendServiceLog(key, chunk.toString(), source);
    } catch (e) {
      logging.log('warn', `[service:${key}] 日志写入失败: ${e.message}`);
    }
  };

  child.stdout?.on('data', (d) => pump(d, 'stdout'));
  child.stderr?.on('data', (d) => pump(d, 'stderr'));

  /* stdin 错误（如管道被关闭）不应导致主进程崩溃 */
  child.stdin?.on('error', (e) => {
    if (e.code !== 'EPIPE') logging.log('warn', `[service:${key}] stdin 错误: ${e.message}`);
  });

  child.on('error', (err) => {
    logging.log('error', `[service:${key}] 进程错误: ${err.message}`);
    record.lastExit = { code: null, signal: null, error: err.message, at: Date.now() };
  });

  child.on('exit', (code, signal) => {
    /* 只有仍然是"当前代次"时才做退出处理 */
    const current = registry.get(key);
    if (!current || current.generation !== generation) {
      logging.log('debug', `[service:${key}] 旧代次进程退出（已忽略）pid=${record.pid}`);
      return;
    }

    record.lastExit = { code, signal, at: Date.now() };
    const intentional = record.intentionalStop;
    registry.delete(key);
    clearReadyWatcher(key);

    /*
      退出码解释（详见 services/exit-codes.js）。
      关键点：Windows 上 0xC000013A（Node 报成 -1073741510）表示控制台会话被
      Ctrl+C 或窗口关闭中断 —— 那是**用户主动行为**，不是崩溃。
      原实现只看 `code !== 0`，于是把"用户按了 Ctrl+C"也当成异常退出：
      界面弹红色告警、发系统通知，甚至触发看门狗自动重启一个用户刚停掉的服务。
      这里把 expected 纳入判定，避免这类误报与误重启。
    */
    const explain = explainExit(code, signal);
    const abnormal = !intentional && code !== 0 && !explain.expected;

    logging.log(
      intentional || explain.expected ? 'info' : abnormal ? 'error' : 'info',
      `[service:${key}] 进程退出 pid=${record.pid} code=${code} signal=${signal ?? 'none'}` +
        (intentional ? '（主动停止）' : explain.reason ? `（${explain.reason}）` : '')
    );

    bus.emit('service:exit', {
      key,
      pid: record.pid,
      code,
      signal,
      intentional,
      abnormal,
      /* 供渲染层直接展示，避免它在界面上再拼一个裸数字 */
      reason: explain.reason,
      display: explain.display,
      at: Date.now(),
      /* 读 restartCounts 而不是 record：进程退出后 record 马上就被删了 */
      restartCount: getRestartCount(key)
    });

    /*
      真看门狗：异常退出且未超重启上限 → 退避后自动拉起。
      重构前这里是 `shouldNotify:false` 的假实现，永远不会重启。
    */
    if (abnormal) scheduleRestart(key, record);
  });
}

/* ============================================================================
 *  自动重启（真看门狗）
 * ========================================================================== */

const restartTimers = new Map();

/*
  正在启动中的服务（并发守卫）。
  ──────────────────────────────────────────────────────────────────────
  原实现的顺序是：registry.has(key) → 判断/停止旧实例 → 探测端口基线 → spawn
  → registry.set(key, record)。这中间隔着 3 个 await 和一次 spawn，
  而 registry 直到最后一行才写上记录 —— 于是"has 为空"这个前提在整个
  启动过程中一直成立：连点两次「启动」（或界面按钮没来得及禁用、或
  「全部启动」与手动点击撞在一起）就会 spawn 出两个进程。
  后一个 registry.set 覆盖前一个，前一个进程再也没人管得着：它占着端口、
  能被看见、但停止/看门狗都找不到它。

  修法：在函数入口用这个 Map 占位，直到本次启动彻底结束（含失败）才释放。
  第二个并发调用直接拿到 busy 结果，不会走到 spawn。

  ⚠️ Map 的 value 是"名额 token"，不是单纯的布尔占位：
  见 restartCounts 的说明 —— 看门狗自己发起的重启必须能穿过
  「手动启动清零重启计数」那道闸门，token 就是它的通行证。
*/
const startInFlight = new Map();

/*
  自动重启计数（key → 已连续异常退出的次数）。
  ──────────────────────────────────────────────────────────────────────
  为什么要独立于 registry 存：
    原实现把计数挂在 record.restartCount 上，靠"await startService 之后再
    registry.get(key) 回写"来跨代次继承。但秒退（端口冲突 / 缺依赖 / 配置错）
    时 exit 处理器**先** registry.delete(key)，回写拿到的永远是 undefined ——
    计数每轮都归零，于是 attempt 恒为 1、指数退避永远停在 1.5s、
    上限永不触发、service:restart-giveup 永不发出。
    实测（scripts/_tmp-procfix-process.mjs，修复前快照）：
      25 秒内 restart-scheduled 13 次，attempt 序列
      [1,1,1,2,1,1,1,1,1,1,1,1,1]，delayMs 恒为 1500，giveup 0 次 —— 无限重启。

    看门狗的计数代表"这个 key 连续失败了几次"，与某一条 record 的生死无关，
    所以它必须有自己的容器：record 被删掉不该抹掉这段历史。
*/
const restartCounts = new Map();

/** 读取某 key 已连续异常退出的次数（record 已删除也照样读得到） */
function getRestartCount(key) {
  return restartCounts.get(key) || 0;
}

/** 记录某 key 的重启尝试次数 */
function setRestartCount(key, n) {
  const value = Number(n);
  restartCounts.set(key, Number.isFinite(value) && value > 0 ? value : 0);
}

/**
 * 清零重启计数。
 *
 * 什么时候调、为什么：
 *   · 用户手动启动 / 手动重启一个服务 —— 这是全新的意图，上次的连续失败
 *     不该继续算在它头上（否则用户修好配置后点一次「启动」，
 *     第一次崩溃就直接 giveup，等于把"重试机会"偷走了）；
 *   · 用户主动停止 —— 计数器跟着生命周期一起结束。
 *   ⚠️ 自动重启自己**不能**清零，否则每轮都从 1 重新数（就是原来的 bug）。
 */
function clearRestartCount(key) {
  restartCounts.delete(key);
}

/*
  启动判定超时之后继续盯端口的观察者（见 watchReadyInBackground）。
  key → interval 句柄。任何一次真正的停止/退出都会把它清掉。
*/
const readyWatchers = new Map();
/** 超时后继续等待端口就绪的时长上限 */
const READY_WATCH_MS = 120000;

function clearReadyWatcher(key) {
  const t = readyWatchers.get(key);
  if (t) {
    clearInterval(t);
    readyWatchers.delete(key);
  }
}

/**
 * 启动判定已经超时（进程活着但端口没开）时，继续在后台等端口。
 *
 * 为什么要接着等：MaiBot 首次启动要装依赖、建库、加载模型，15s 的判定窗口
 * 经常不够；直接报"未就绪"会让用户以为坏了，而实际上再等 20s 它就好了。
 * 这里在端口真正打开时补发一条 service:ready，界面可以据此把状态从
 * 「启动中（端口未就绪）」翻成「已就绪」，而不是一直停在中间态。
 */
function watchReadyInBackground(record) {
  const { key, pid, readyPort, generation } = record;
  if (!readyPort || readyWatchers.has(key)) return;
  const deadline = Date.now() + READY_WATCH_MS;
  const timer = setInterval(async () => {
    const cur = registry.get(key);
    const stillOurs = cur && cur.generation === generation;
    if (!stillOurs || !isAlive(pid) || record.intentionalStop || Date.now() > deadline) {
      clearReadyWatcher(key);
      return;
    }
    /* 端口启动前就被别人占着时，它开着证明不了什么，不必再等 */
    if (record.portPreOccupiedBy) {
      clearReadyWatcher(key);
      return;
    }
    if (await probePort(readyPort)) {
      clearReadyWatcher(key);
      logging.log('info', `[service:${key}] 端口 ${readyPort} 已就绪（判定超时后补报）`);
      bus.emit('service:ready', { key, pid, port: readyPort, via: 'port', at: Date.now() });
    }
  }, 1000);
  timer.unref?.();
  readyWatchers.set(key, timer);
}

function scheduleRestart(key, record) {
  const limit = restartLimit();
  if (limit <= 0) {
    logging.log('info', `[service:${key}] 自动重启已关闭（autoRestartLimit=0），不拉起`);
    return;
  }

  /*
    计数从 restartCounts 读，不从 record 读。
    record 可能已经不在 registry 里了（秒退场景 exit 处理器先删了它），
    而 record 上的 restartCount 在那种情况下永远是 0 —— 这正是无限重启的根因。
    详见 restartCounts 的注释。
  */
  const count = getRestartCount(key);
  if (count >= limit) {
    logging.log(
      'warn',
      `[service:${key}] 已连续重启 ${count} 次，达到上限 ${limit}，停止自动重启`
    );
    bus.emit('service:restart-giveup', {
      key,
      attempts: count,
      limit,
      message: `${key} 连续异常退出 ${count} 次，已停止自动重启`
    });
    return;
  }

  const attempt = count + 1;
  const delay = Math.min(RESTART_BASE_MS * 2 ** (attempt - 1), RESTART_MAX_DELAY_MS);

  /*
    在这里就把计数写进 restartCounts —— 而不是等重启回来再回写。
    原因同上：回写点在 await startService 之后，秒退时那个 record
    早就被 exit 处理器删掉了，回写必然落空。计数必须在"决定要重启"的
    那一刻就落在一个不会被删的容器里。
  */
  setRestartCount(key, attempt);

  logging.log(
    'warn',
    `[service:${key}] 检测到异常退出，${Math.round(delay / 1000)}s 后进行第 ${attempt}/${limit} 次自动重启`
  );
  bus.emit('service:restart-scheduled', { key, attempt, limit, delayMs: delay });

  /* 同一 key 只允许一个待执行的重启任务 */
  const existing = restartTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    restartTimers.delete(key);
    /* 必须走 restartServiceInternal：它不清零计数，计数才能跨代次累加 */
    const res = await restartServiceInternal(key, {
      command: record.command,
      args: record.args,
      cwd: record.cwd,
      env: record.env || {},
      readyPort: record.readyPort,
      detach: record.detach
    });
    /* 计数已在上面 setRestartCount 落定，这里只补一条日志（便于排查"重启失败"） */
    logging.log(
      res.ok ? 'info' : 'error',
      `[service:${key}] 第 ${attempt} 次自动重启${res.ok ? '成功' : '失败'}: ${res.message}`
    );
  }, delay);
  timer.unref?.();
  restartTimers.set(key, timer);
}

/* ============================================================================
 *  停止 / 状态
 * ========================================================================== */

/**
 * 构造 killTree 所需的"身份"信息（防 PID 复用误杀整棵树）。
 *
 * 为什么必须有：
 *   托管表里存的是 pid。若该进程早已退出、而 Windows 把这个 PID 分给了
 *   别的进程（用户自己的 python.exe、编辑器、甚至系统进程），
 *   一次 `taskkill /PID N /T /F` 就会连**无关进程的整棵子进程树**一起杀掉。
 *   winproc.killTree 拿到这里的身份后会先 CIM 查一次该 PID 的创建时间戳比对，
 *   不匹配就拒绝动手并如实回报（method: 'identity-mismatch'）。
 *
 * 判据只用记录里已有的 startedAt（spawn 后立即写入）：
 *   进程的真实创建时刻必然略晚于 startedAt，容差 5s 由 winproc 负责。
 *   PID 一旦被复用，新进程的创建时间必定远晚于它，因此能可靠区分。
 *
 * ⚠️ 绝不要在这里做 PowerShell 查询：这个函数会在 stopAll / shutdownAll /
 *   自动重启"先停旧实例"等路径上被调用，加同步查询就等于给停止操作
 *   平白加上几百毫秒。查询由 killTree 在**确认要动手之前**做一次。
 */
function killIdentityOf(record) {
  if (!record || !record.pid) return null;
  return { pid: record.pid, startedAt: Number(record.startedAt) || 0 };
}

/**
 * 停止服务并等待进程真正消失。
 * @param {string} key
 * @param {{timeoutMs?:number, [KEEP_RESTART_COUNT]?:boolean}} [opts]
 *   opts[KEEP_RESTART_COUNT] 仅自动重启内部使用：保留重启计数（见该常量的说明）
 */
async function stopService(key, opts = {}) {
  const record = registry.get(key);
  if (!record) {
    return { ok: false, key, message: '服务未在托管中' };
  }

  /* 标记为主动停止：看门狗不得因这次退出而拉起 */
  record.intentionalStop = true;
  /* 启动判定超时后可能还留着一个等端口的观察者，一并收掉 */
  clearReadyWatcher(key);

  /* 取消待执行的重启任务 */
  const pending = restartTimers.get(key);
  if (pending) {
    clearTimeout(pending);
    restartTimers.delete(key);
  }

  /*
    用户主动停止 = 这一轮连续失败结束了，计数一并清零。
    不清的话：用户停掉一个刚崩过的服务、修好配置再点启动，
    第一次崩溃就会直接撞上上限并 giveup（手动启动那条路虽然也会清零，
    但"停止"本身就该结束这段历史，不该把一个陈旧计数留在 Map 里）。

    ⚠️ 唯一的例外是自动重启内部的"先停旧实例"（KEEP_RESTART_COUNT）：
    那一次 stopService 不是用户的意图，清零会让计数每轮归零 —— 无限重启复发。
  */
  if (!opts[KEEP_RESTART_COUNT]) clearRestartCount(key);

  const pid = record.pid;
  const wasAlive = isAlive(pid);

  logging.log('info', `[service:${key}] 正在停止 pid=${pid}（taskkill /T /F，先校验进程身份）…`);
  const result = await killTree(pid, {
    timeoutMs: opts.timeoutMs ?? 5000,
    label: key,
    identity: killIdentityOf(record)
  });

  /*
    被拒绝执行（method 以 identity- 开头）= 我们**没有**杀任何东西。
    这时 isAlive(pid) 可能仍为 true，但那多半是"同一个 PID 已经被系统
    分给了别的进程"，绝不能把它当成"我们的服务还活着/停止失败（权限不足）"上报。
  */
  const refusedByIdentity = String(result.method || '').startsWith('identity-');
  if (refusedByIdentity) {
    const actual = result.method === 'identity-mismatch' ? await queryProcessIdentity(pid) : null;
    const message = actual
      ? `pid ${pid} 已不是本次托管的进程（现为 ${actual.exeName || '未知程序'}，`
        + `创建于 ${actual.createdAt ? new Date(actual.createdAt).toISOString() : '未知时间'}），`
        + '已拒绝结束进程以免误杀无关程序；原来那个进程应已退出，可重新启动服务'
      : result.message || `无法确认 pid ${pid} 的身份，已拒绝结束进程以免误杀无关程序`;

    logging.log('warn', `[service:${key}] ${message}`);
    bus.emit('service:stop-refused', { key, pid, reason: result.method, message });
    return { ok: false, key, pid, wasAlive, method: result.method, refused: true, message };
  }

  /* 无论 taskkill 结果如何，都以"进程是否真的消失"为准 */
  const gone = !isAlive(pid);
  if (gone) {
    registry.delete(key);
    logging.log('info', `[service:${key}] 已确认停止（pid ${pid} 不存在）`);
    bus.emit('service:stopped', { key, pid, method: result.method });
    return { ok: true, key, pid, method: result.method, message: '已停止' };
  }

  logging.log('error', `[service:${key}] 停止失败: ${result.message || '进程仍存活'}`);
  return {
    ok: false,
    key,
    pid,
    wasAlive,
    method: result.method,
    message: result.message || `无法终止进程 ${pid}（可能权限不足）`
  };
}

/**
 * 手动重启单个服务。
 *
 * 为什么需要：
 *   在此之前界面上只有「启动 / 停止」，用户改完配置想让它生效
 *   必须点两次（停止 → 等状态刷新 → 启动），中间还可能点到"已在运行"。
 *   重启必须是**一次原子操作**：先确认真的停干净，再启动，
 *   并且整个过程对看门狗标记为主动停止 —— 否则看门狗会把它
 *   当成"异常退出"再自动重启一次，出现两个进程抢同一个端口。
 *
 * @param {string} key
 * @param {{payload?:object, timeoutMs?:number}} [opts]
 */
async function restartService(key, opts = {}) {
  const record = registry.get(key);
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : null;

  let stopResult = null;
  if (record) {
    /* stopService 内部会设置 intentionalStop 并取消待执行的重启 */
    stopResult = await stopService(key, { timeoutMs: opts.timeoutMs ?? 6000 });
    if (!stopResult.ok) {
      /*
        进程仍在：绝不能继续启动，否则会出现同一服务两个实例
        （MaiBot 会因端口占用失败，协议端则可能出现两个重复的登录实例）。
      */
      logging.log('error', `[restart:${key}] 旧进程未能停止，已中止重启`);
      bus.emit('service:restart-failed', { key, stage: 'stop', message: stopResult.message });
      return {
        ok: false,
        key,
        stage: 'stop',
        message: `旧进程未能停止，已中止重启：${stopResult.message}`
      };
    }
  }

  /*
    启动参数：优先使用调用方给的 payload（界面上的当前草稿/设置），
    否则由主进程按已保存的设置自行推导。
  */
  const effective = payload || (await buildStartPayload(key));
  if (!effective) {
    bus.emit('service:restart-failed', {
      key,
      stage: 'resolve',
      message: '找不到可用的启动参数'
    });
    return { ok: false, key, stage: 'resolve', message: '目录不存在或找不到入口文件，请检查设置中的路径' };
  }

  bus.emit('service:restarting', { key });
  const started = await startService(key, effective);
  return { ...started, restarted: true, stage: started.ok ? 'start' : 'start-failed' };
}

/**
 * 立即强制结束（不等待）。
 * 用于退出流程的兜底。
 *
 * 改动：不再直接 `spawnHidden('taskkill', ...)`。
 *   那条路径只按 PID 动手，退出流程里如果 PID 已被系统复用，
 *   就会杀掉无关进程的整棵树。改为走 killTree(..., identity)——
 *   同一套身份校验，只是不等待结果（真正的收尾由 waitAllStopped 负责）。
 *   killTree 返回 Promise，这里刻意不 await（函数语义就是"不等待"）。
 */
function killServiceNow(key) {
  const record = registry.get(key);
  if (!record) return false;
  record.intentionalStop = true;
  clearReadyWatcher(key);

  /* 进程本来就不在了：这时候摘记录是安全的 */
  if (!isAlive(record.pid)) {
    registry.delete(key);
    return false;
  }

  /*
    身份校验不通过时**绝不能**标记 killing 后交给 waitAllStopped：
    那个 PID 已经属于别人，waitAllStopped 会一直等一个永远不会消失的进程。
    所以这里按结果分流：被拒绝就只告警、不进入 killing 状态。
  */
  Promise.resolve(killTree(record.pid, { timeoutMs: 4000, label: key, identity: killIdentityOf(record) }))
    .then((r) => {
      if (r && r.ok) {
        record.killing = true;
        return;
      }
      if (r && String(r.method || '').startsWith('identity-')) {
        logging.log('warn', `[service:${key}] 退出清理拒绝结束 pid=${record.pid}：${r.message}`);
        return;
      }
      logging.log('warn', `[service:${key}] 退出时 taskkill 失败: ${r?.message || '未知原因'}`);
    })
    .catch((e) => logging.log('warn', `[service:${key}] 退出时 taskkill 失败: ${e.message}`));

  return true;
}

/**
 * 停止全部托管服务，并等待它们真正结束。
 * @param {{timeoutMs?:number}} [opts]
 */
async function stopAll(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const keys = Array.from(registry.keys());
  if (!keys.length) return { ok: true, stopped: [], failed: [] };

  const results = await Promise.all(keys.map((k) => stopService(k, { timeoutMs })));
  const stopped = results.filter((r) => r.ok).map((r) => r.key);
  const failed = results.filter((r) => !r.ok).map((r) => ({ key: r.key, message: r.message }));
  return { ok: failed.length === 0, stopped, failed };
}

/** 查询托管中的服务状态 */
function getServicesStatus() {
  const list = [];
  for (const [key, rec] of registry.entries()) {
    /*
      最后一次退出也带上解释。
      渲染层刷新后走的是这条路径（而不是 service:exit 事件），
      以前它只能拿到裸的 lastExit.code，于是"服务已停止"的详情里
      依然会出现 -1073741510 这种没人看得懂的数字。
    */
    let lastExit = rec.lastExit;
    if (lastExit && lastExit.code !== 0) {
      const ex = explainExit(lastExit.code ?? null, lastExit.signal ?? null);
      lastExit = { ...lastExit, reason: ex.reason, display: ex.display, expected: ex.expected };
    }
    list.push({
      key,
      running: isAlive(rec.pid),
      pid: rec.pid,
      command: rec.command,
      args: rec.args,
      cwd: rec.cwd,
      startedAt: rec.startedAt,
      readyPort: rec.readyPort,
      /* 同上：权威值在 restartCounts，record 上那份只是快照 */
      restartCount: getRestartCount(key),
      lastExit
    });
  }
  return list;
}

/** 是否在托管中且存活 */
function isServiceRunning(key) {
  const rec = registry.get(key);
  return Boolean(rec && isAlive(rec.pid));
}

/* ============================================================================
 *  向服务 stdin 写入
 * --------------------------------------------------------------------------
 *  ⚠️ 必须补换行，否则「同意」这个功能是假的。
 *
 *  Python 的 input() 读的是**一整行**，它以换行符为结束标志。
 *  若只写 "同意" 而不写换行，input() 会一直等这一行结束 ——
 *  界面上显示"已发送"，麦麦却永远卡在那儿，是最难查的那种假成功。
 *
 *  这里统一按"行"处理：调用方给 "同意"、给 "同意\n"、给 "同意\r\n"
 *  都等价，最终都写出恰好一个 "\n" 结尾。
 * ========================================================================== */

/**
 * @param {string} key
 * @param {string} text 要发送的一行内容（换行会自动补齐）
 */
function writeServiceInput(key, text) {
  const rec = registry.get(key);
  if (!rec) return { ok: false, message: `服务 ${key} 未在托管中` };
  const stdin = rec.child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    return { ok: false, message: `服务 ${key} 的输入通道不可写` };
  }
  try {
    /*
      先把所有 \r\n / \r 归一成 \n，再确保恰好一个结尾 \n。
      不做归一的话，调用方传 "\r\n" 会变成 "\n\n" —— 对 input() 来说
      就是"额外送了一个空行"，某些交互里会被当成第二次输入。
    */
    const line = String(text ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n+$/, '');
    stdin.write(`${line}\n`);
    return { ok: true, message: '已发送' };
  } catch (e) {
    return { ok: false, message: `写入失败: ${e.message}` };
  }
}

/* ============================================================================
 *  残留进程清理（真实现：失败就说失败，动手前先校验身份并列出目标）
 * ========================================================================== */

/** 命令行摘要（日志与预演共用）：压成单行并限长，避免超长命令行刷爆日志 */
function cmdlineBrief(cmdline, max = 160) {
  const text = String(cmdline || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 查找并终止匹配特征的残留进程。
 * 与重构前的区别：真的返回"发现/终止"数量，而不是凭 PowerShell 退出码 0 谎报成功。
 *
 * 本次加固的三件事：
 *   1) **枚举失败不再伪装成"没有残留"**。winproc.findProcesses 现在返回
 *      `{ok:false, reason, error}`；这里原样把失败带出去（found=null 而不是 0，
 *      因为 0 会被界面读成"很干净"）。此前它 resolve([]) → 这里回
 *      "未发现残留进程"，把"查询失败"说成了"没有残留"。
 *   2) **真杀之前做 PID 身份校验**。此前这条路径调 killTree 时**没传 identity**
 *      （对照正常停止路径传了），而 killTree 只在"有 identity"时才做 PID 复用校验
 *      —— 于是 taskkill /T /F 会连"名叫 python.exe 且命令行含 maibot"的
 *      **非本启动器托管**进程树一起杀掉。现在用枚举时拿到的 createdAt
 *      作为 startedAt 交给 killTree；拿不到创建时间的保守拒绝，不闭眼杀。
 *   3) **dryRun 预演**：只列出"将终止哪些 PID、命令行分别是什么"，不碰任何进程；
 *      真杀前也把同一份清单写进日志与返回值。
 *
 * @param {{name?:string, keyword?:string, dryRun?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, dryRun:boolean, found:number|null, killed:number, targets:Array, message:string, reason?:string, error?:string}>}
 */
async function cleanupZombies(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const name = opts.name || 'python.exe';
  const keyword = opts.keyword || 'maibot';

  const probe = await findProcesses(name, keyword);

  /* ① 枚举失败：如实说"我没查成功"，绝不说"没有残留" */
  if (!probe || probe.ok !== true) {
    const reason = probe?.reason || 'unknown';
    const detail = probe?.error || '未知原因';
    const message =
      `残留进程枚举失败（${reason}）：${detail}。当前**无法确认**是否存在残留进程，`
      + '请不要把这次结果当成"没有残留"。';
    logging.log('error', `[zombie] ${message}`);
    return {
      ok: false,
      dryRun,
      /* null 而不是 0：0 会被调用方读成"很干净"，这里必须表达"未知" */
      found: null,
      known: false,
      killed: 0,
      targets: [],
      reason,
      error: detail,
      message
    };
  }

  /* 排除当前正在被托管的进程，避免把正常运行的实例误杀 */
  const managedPids = new Set(Array.from(registry.values()).map((r) => r.pid));
  const plan = probe.processes
    .filter((p) => !managedPids.has(p.pid))
    .map((p) => ({ pid: p.pid, name: p.name, cmdline: p.cmdline, createdAt: p.createdAt }));
  const excludedManaged = probe.processes.length - plan.length;

  /* ② dryRun：只列清单，一个进程都不碰 */
  if (dryRun) {
    const lines = plan.map((p) => `pid ${p.pid} ${cmdlineBrief(p.cmdline)}`);
    const message = plan.length
      ? `预演：将终止 ${plan.length} 个残留进程（未执行）：${lines.join('；')}`
      : '预演：未发现匹配的残留进程（枚举已成功，结果可信）';
    logging.log('info', `[zombie] dryRun found=${plan.length} 跳过托管=${excludedManaged} ${lines.join(' | ')}`);
    return {
      ok: true,
      dryRun: true,
      found: plan.length,
      known: true,
      killed: 0,
      failed: 0,
      refused: 0,
      excludedManaged,
      targets: plan,
      message
    };
  }

  /* ③ 真杀：先把"将杀哪些 PID、命令行是什么"完整列出来（日志 + 返回值） */
  if (plan.length) {
    logging.log(
      'warn',
      `[zombie] 即将终止 ${plan.length} 个残留进程（每个都先做 PID 身份校验）：`
        + plan.map((p) => `pid ${p.pid} ${cmdlineBrief(p.cmdline)}`).join(' | ')
    );
  }

  const killed = [];
  const failed = [];
  const refused = [];
  for (const p of plan) {
    /*
      拿不到创建时间 → 无法做 PID 复用校验。
      保守拒绝：宁可留下一个残留进程（用户还能再点一次），
      也不能闭着眼睛 taskkill /T /F 赌这个 PID 还是当初那个进程。
    */
    if (!Number.isFinite(Number(p.createdAt)) || Number(p.createdAt) <= 0) {
      const message = `pid ${p.pid} 未拿到创建时间，无法做 PID 复用校验，已拒绝终止以免误杀`;
      logging.log('warn', `[zombie] ${message}`);
      refused.push({ ...p, method: 'identity-unknown', message });
      continue;
    }
    const r = await killTree(p.pid, {
      timeoutMs: 4000,
      label: `zombie:${p.pid}`,
      identity: { pid: p.pid, exeName: p.name, startedAt: Number(p.createdAt) }
    });
    if (r.ok) {
      killed.push(p.pid);
    } else if (String(r.method || '').startsWith('identity-')) {
      /* 拒绝动手 = 没有杀任何东西，如实记录（这正是 PID 复用保护生效） */
      refused.push({ ...p, method: r.method, message: r.message });
      logging.log('warn', `[zombie] 已拒绝终止 pid ${p.pid}：${r.message}`);
    } else {
      failed.push({ pid: p.pid, message: r.message });
    }
  }

  const parts = [];
  if (!plan.length) {
    parts.push('未发现残留进程（枚举已成功，结果可信）');
  } else {
    parts.push(`发现 ${plan.length} 个残留进程，已终止 ${killed.length} 个`);
    if (refused.length) parts.push(`${refused.length} 个因身份校验未通过被拒绝（未终止，避免误杀）`);
    if (failed.length) parts.push(`${failed.length} 个终止失败`);
  }
  if (excludedManaged) parts.push(`跳过 ${excludedManaged} 个正在托管的进程`);
  const message = parts.join('，');

  logging.log(failed.length || refused.length ? 'warn' : 'info', `[zombie] ${message}`);

  return {
    ok: failed.length === 0 && refused.length === 0,
    dryRun: false,
    found: plan.length,
    known: true,
    killed: killed.length,
    failed: failed.length,
    refused: refused.length,
    excludedManaged,
    killedPids: killed,
    failedTargets: failed,
    refusedTargets: refused,
    targets: plan,
    message
  };
}

/* ============================================================================
 *  真看门狗：周期性存在性校验
 * ========================================================================== */

/**
 * 启动看门狗。
 * 作用：捕获 exec 事件之外的情况（例如进程被外部挂起/句柄异常，
 * 或 child 对象仍在但 PID 已消失的极端情形）。
 * 与重建方式不同：这里只做"发现 → 触发既有的重启调度"，不重复实现重启逻辑。
 */
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    for (const [key, rec] of Array.from(registry.entries())) {
      if (isAlive(rec.pid)) continue;
      /*
        进程已消失但 exit 事件尚未处理（或已被吞掉）——视为异常退出。
        这里主动清理并交给 scheduleRestart，避免出现"幽灵条目"。
      */
      logging.log('warn', `[watchdog] 发现 ${key} (pid=${rec.pid}) 已不存在但仍在托管表中，清理并尝试重启`);
      registry.delete(key);
      const lostExplain = explainExit(null, null);
      bus.emit('service:exit', {
        key,
        pid: rec.pid,
        code: null,
        signal: null,
        intentional: false,
        abnormal: true,
        reason: lostExplain.reason,
        display: lostExplain.display,
        at: Date.now(),
        source: 'watchdog',
        restartCount: rec.restartCount
      });
      if (!rec.intentionalStop) scheduleRestart(key, rec);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();
  logging.log('info', `[watchdog] 已启动（间隔 ${WATCHDOG_INTERVAL_MS}ms）`);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    logging.log('info', '[watchdog] 已停止');
  }
  for (const t of restartTimers.values()) clearTimeout(t);
  restartTimers.clear();
}

/**
 * 退出流程：停止看门狗、终止全部子进程、等待真正结束。
 * @param {{timeoutMs?:number}} [opts]
 */
async function shutdownAll(opts = {}) {
  stopWatchdog();
  const deadline = Date.now() + (opts.timeoutMs ?? 6000);

  const res = await stopAll({ timeoutMs: Math.max(1500, deadline - Date.now()) });

  /* 二次确认：仍有存活则强制再杀一轮，并给出如实结果 */
  const stillAlive = Array.from(registry.values()).filter((r) => isAlive(r.pid));
  if (stillAlive.length) {
    logging.log('warn', `[shutdown] ${stillAlive.length} 个子进程未在首次尝试中结束，强制清理`);
    /*
      同样带 identity：这是退出流程的最后一刀，最容易踩到"PID 已被系统复用"。
      身份不符时 killTree 会拒绝执行并如实回报，绝不误杀无关进程树。
    */
    await Promise.all(
      stillAlive.map((r) =>
        killTree(r.pid, {
          timeoutMs: Math.max(800, deadline - Date.now()),
          label: r.key,
          identity: killIdentityOf(r)
        }).then((kr) => {
          if (kr && String(kr.method || '').startsWith('identity-')) {
            logging.log('warn', `[shutdown] ${r.key} 拒绝结束 pid=${r.pid}：${kr.message}`);
          }
          return kr;
        })
      )
    );
    for (const r of stillAlive) {
      if (!isAlive(r.pid)) registry.delete(r.key);
    }
  }

  const remaining = Array.from(registry.values()).filter((r) => isAlive(r.pid)).map((r) => r.key);
  if (remaining.length) {
    logging.log('error', `[shutdown] 以下子进程可能仍在运行: ${remaining.join(', ')}`);
  } else {
    logging.log('info', '[shutdown] 全部子进程已结束');
  }

  return { ...res, remaining };
}

module.exports = {
  /* 事件总线 */
  bus,
  /* 生命周期 */
  startService,
  stopService,
  restartService,
  killServiceNow,
  stopAll,
  shutdownAll,
  getServicesStatus,
  isServiceRunning,
  writeServiceInput,
  /* 启动参数构建与开机自启 */
  buildStartPayload,
  autoStartConfigured,
  /* 看门狗 */
  startWatchdog,
  stopWatchdog,
  /* 工具 */
  checkPorts,
  probePort,
  cleanupZombies,
  /* 解释器路径收口：导出便于对"设置里塞一个任意可执行文件必须被拒"做回归测试 */
  sanitizeMaiBotInterpreter,
  /* 常量导出便于测试 */
  _registry: registry,
  /* 重启计数（权威容器，独立于 registry；回归脚本用它断言跨代次累加） */
  _restartCounts: restartCounts
};
