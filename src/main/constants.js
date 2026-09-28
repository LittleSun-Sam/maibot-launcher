/*
================================================================================
技术文档：src/main/constants.js
职责：主进程共享常量与默认配置的**唯一来源**。
================================================================================
  为什么单独抽出来：
    重构前，默认仓库 'MaiBot/MaiBot'、默认端口 8080/6199/8090、依赖清单、
    LLM 默认值等散落在 settings.js / InstallerPanel.vue / DownloadPanel.vue
    等多处，改一处就会不一致。现在全部收敛到这里，渲染层通过 IPC 读取。
================================================================================
*/

/** 应用标识 */
const APP = {
  id: 'com.maibot.launcher',
  name: 'MaiBot Launcher',
  /**
   * 主窗口尺寸基准。
   * 注意：本项目是纯 Electron 实现（main/preload/renderer + contextBridge），
   * 项目目录名中的 "tauri" 只是历史遗留，与实现无关。
   */
  window: { width: 1280, height: 720, minWidth: 960, minHeight: 560 }
};

/**
 * 上游仓库。
 * 说明：MaiBot 官方仓库同时存在 'Mai-with-u/MaiBot' 与旧名 'MaiBot/MaiBot'。
 * 这里以官方现名为主，同时保留候选列表用于 releases 拉取失败时依次回退。
 */
const REPOS = {
  maibot: 'Mai-with-u/MaiBot',
  maibotFallbacks: ['Mai-with-u/MaiBot', 'MaiBot/MaiBot'],
  /**
   * SnowLuma 官方仓库。
   * 核实过：组织名就叫 SnowLuma，仓库名也是 SnowLuma（github.com/SnowLuma/SnowLuma），
   * 描述是 "Next Remote Protocol Framework"。别被 MaiBot 那边的
   * 'MaiBot-SnowLuma-Adapter' 混淆 —— 那是**适配器插件**，不是这个运行时本体。
   */
  snowluma: 'SnowLuma/SnowLuma'
};

/* ============================================================================
 *  启动器自身的更新源
 * ==========================================================================
 *  ⚠️ 这里是**启动器自己**（MaiBot Launcher）的 Release 来源，
 *  与上面 REPOS 里那两个「被管理的服务」（MaiBot / SnowLuma）完全是两回事：
 *  那两个是本启动器要去安装、启动、看日志的对象，这个是要把启动器**自己**
 *  换成新版本的来源。混在一起会写出"检查更新时去拉 MaiBot 的 release"这种错。
 *
 *  owner / repo 必须**分开写**，不能只写 'OWNER/REPO' 一个字符串：
 *   · 语义化版本比较要拿 repo 去和 app.getVersion() 配；
 *   · 检查更新与拼接附件地址走的是同一个来源，只有分开存才能保证
 *     "拉到的 release"和"下载的附件"出自同一个仓库（写成一个字符串时
 *     很容易被某处 split('/') 出错，结果是"检查的是 A、下载的是 B"）。
 *
 *  configured 由 owner/repo 是否还是占位值推导（见 updateConfigured()），
 *  不单独存一个布尔 —— 那种"标记说已配置、实际仍是占位"的漂移最难查。
 *
 *  未配置时**必须如实返回"未配置更新源"**，不许伪造一次成功的检查：
 *  假装检查成功会让用户以为"已经是最新版"，从而永远收不到更新。
 * ========================================================================== */
const UPDATE = {
  /**
   * 真实更新源：https://github.com/LittleSun-Sam/maibot-launcher
   * 2026-09-27 建立（公开仓库），源码已推送、由 Git Credential Manager 授权。
   * 发布新版本 = 在本地打包后往这个仓库发 Release 并挂上 NSIS 安装包附件，
   * 启动器就会在这里检查到新版本并走国内加速通道下载。
   */
  owner: 'LittleSun-Sam',
  repo: 'maibot-launcher',
  /** 占位值的字面量；已配置，保留它用于兜底判定（见 updateConfigured） */
  placeholders: ['OWNER', 'REPO'],
  /**
   * 更新包的下载通道，**按顺序**尝试；空字符串代表直连 GitHub 官方。
   *
   * 顺序的依据是实测（见 scripts/verify-update.mjs 与真机记录）：
   *   · GitHub Release 附件直连不通（objects.githubusercontent.com 超时）；
   *   · https://gh.xxooo.cf/ 实测约 1.1 MB/s（91.6 MB 约 85 秒）；
   *   · https://ghproxy.net/ 备用。
   * 用法是把原始地址直接拼在通道前缀后面（通道前缀自带结尾的 /）。
   */
  mirrors: ['https://gh.xxooo.cf/', 'https://ghproxy.net/', ''],
  /** 检查更新走 GitHub REST（api.github.com 直连实测可用，约 2.8s） */
  timeoutMs: 12000,
  /** 下载时的停滞超时：多久没收到任何字节就判定该通道不可用 */
  stallMs: 45000,
  /** 进度事件节流（与 github.js 的 PROGRESS_THROTTLE_MS 同值，避免两套节奏） */
  progressThrottleMs: 120,

  /* --------------------------------------------------------------------------
   *  多线程分段下载（2026-09-27 加入）
   * ------------------------------------------------------------------------
   *  为什么必须分段：真机实测同一个 gh.xxooo.cf 通道、
   *    单连接  1 MB / 6.06 s = 0.17 MB/s  →  91.8 MB 要约 9 分钟
   *    4 段并发 4 MB / 6.89 s = 0.58 MB/s  →  91.8 MB 约 2.6 分钟
   *  也就是说瓶颈不在总带宽，而在**单条连接被限速**（每段都返回 206，
   *  说明该通道支持 Range）。所以段数才是这里的那个杠杆。
   *
   *  threads 的语义与 github.js 的 downloadThreads 保持一致（同一个词表，
   *  用户在两处看到的是同一种行为）：
   *    0  = 按文件大小自动（SEGMENT_MIN_COUNT ~ SEGMENT_MAX_COUNT）
   *    1  = 强制单连接（排查网络问题时的逃生门）
   *    >=2 = 指定段数，上限 SEGMENT_MAX_COUNT
   *  可用环境变量 MAIBOT_LAUNCHER_UPDATE_THREADS 覆盖（自测脚本与"临时试一段"
   *  都靠它，不必改代码重新打包）。
   * ------------------------------------------------------------------------ */
  threads: 4,
  /** 小于这个大小就不值得分段（连接建立/握手的开销会盖过收益） */
  segmentMinBytes: 4 * 1024 * 1024,
  /** 自动模式下按这个粒度估段数（8 MB 一段 → 91.8 MB ≈ 12 段，再被上限夹住） */
  segmentTargetBytes: 8 * 1024 * 1024,
  /** 段数下限 / 上限：上限是为了不把对方服务器打成拒绝服务（也不能真被配成 999） */
  segmentMinCount: 3,
  segmentMaxCount: 8,
  /**
   * 单段失败后的整段重取次数（不含第一次尝试）。
   * 为什么要重取整段而不是"从断点续传"：见 updater.js 里 downloadSegmented
   * 的说明 —— 读到的字节数 ≠ 已落盘的字节数，拿它当续传偏移会写出**错位**文件。
   */
  segmentRetry: 2
};

/** GitHub REST */
const GITHUB = {
  api: 'https://api.github.com',
  /**
   * 下载镜像前缀；空字符串代表直连官方，按顺序尝试。
   *
   * ⚠️ 镜像准入不变量（改动前务必读 github.js 的 candidateUrls / downloadToFile）：
   * 镜像**不是**无条件可用的。它是一个第三方，可能缓存错版本、也可能递给你
   * 一个同大小的木马包。所以能不能用镜像，取决于"这次下载有没有一个独立于
   * 镜像的校验依据"：
   *   · 有 expectSha256（Release 附件有）→ 摘要说了算，允许镜像；
   *   · 只有 expectSize（来自 Release 元数据，独立于镜像）→ 允许镜像；
   *   · 两者都没有（codeload 源码归档就是这种）→ **只准官方源**。
   * 最后一种由 github.js 的 downloadToFile 自动推导为 mirrorPolicy:
   * 'official-only'，downloadSourceArchive 还额外显式传了一次。
   *
   * 为什么不干脆把镜像默认关掉：镜像的提速是实测出来的真需求
   * （直连约 69 KB/s vs gh-proxy 约 2463 KB/s，差 36 倍），关掉会让
   * 大文件下载退回"进度条几乎不动"。所以正确的做法是按可验证性分流，
   * 而不是一刀切。
   */
  mirrors: ['', 'https://ghproxy.net/', 'https://gh-proxy.com/']
};

/**
 * 默认端口。
 *
 * 两个值都在上游源码里核实过，不是我猜的：
 *   MaiBot 主服务  8080 → `src/config/startup_bindings.py:23`
 *                         `_DEFAULT_MAIN_BIND_ADDRESS = BindAddress(hosts=["127.0.0.1"], port=8080)`
 *   MaiBot WebUI   8001 → 同文件 L24
 *                         `_DEFAULT_WEBUI_BIND_ADDRESS = BindAddress(hosts=["127.0.0.1","::1"], port=8001)`
 *                         （`ports.webui` 的唯一消费方就是界面上那个「打开 WebUI」按钮）
 *
 * ⚠️ 这里以前还给 QQ 注入式协议端留过一个写死 6199 的端口键，那是**凭空猜的**，
 *    会让"启动是否成功"的判定完全失效：6199 其实是 AstrBot 的 OneBot 反向 WS
 *    端口，被社区误传成了协议端的端口。协议端整体删掉后这个键也一起删了。
 *    与此同时 `webui` 从 6099（那是 QQ 注入式协议端的 WebUI 端口）改成了上面
 *    核实过的 8001 —— 以前那个值会让「打开 WebUI」按钮指向错误的进程。
 *    用户旧配置里残留的 6199/6099 由 settings.js 的迁移层剥掉/纠正（见那里）。
 *
 * SnowLuma 的两个端口**不在这个命名空间里**，见下面 DEFAULT_SNOWLUMA_PORTS。
 */
const DEFAULT_PORTS = { maibot: 8080, webui: 8001 };

/**
 * SnowLuma 的默认端口：
 *   webui  5099 → 实测启动日志 `[WebUI] listening http://0.0.0.0:5099`，
 *                 也是 config/runtime.json 里 webuiPort 的值
 *   onebot 7988 → SnowLuma 的 OneBot 正向 WebSocket 端口，
 *                 也就是 MaiBot 的 SnowLuma 适配器插件要去连的那个
 *
 * 参考实现（MaiBot OneKey）里这两个值分别是 SNOWLUMA_WEBUI_PORT=5099、
 * SNOWLUMA_ONEBOT_PORT=7988，并且它的就绪判定就是等 [5099, 7988] 两个端口。
 * 我们照抄的是这个**协议约定**，不是它的代码。
 *
 * ⚠️ 而且要清楚这个 onebot 值的**性质**：它不是 SnowLuma 可以被写入的配置项。
 *    实测（真跑了一次 v1.14.19）它自己生成的 config/runtime.json 里没有 OneBot 段，
 *    进程默认只监听 5099；OneBot 正向 WS 服务器是用户**在它自己的 WebUI 里创建**的，
 *    端口也由用户在那一步填。所以这个值的正确用途是：
 *    作为「建议端口」展示给用户，并保证它与麦麦适配器侧要连的端口一致。
 */
const DEFAULT_SNOWLUMA_PORTS = { webui: 5099, onebot: 7988 };

/** 默认后端设置。渲染层通过 app:info 的 defaults 字段获取，避免前端硬编码副本 */
const DEFAULT_SETTINGS = {
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    temperature: 0.7,
    maxTokens: 2048,
    custom: { baseUrl: '', model: '', apiKey: '' }
  },
  github: {
    token: '',
    repo: REPOS.maibot,
    /**
     * SnowLuma 仓库单独可配。
     * 上游换名/换组织时用户能自己改，而不是等我们发版。
     * 这个值会一路传到 installSnowLuma({ repo })（github.js 的 resolveRepo），
     * 以及合并后安装器页「版本下载」子标签的预设按钮。
     */
    snowlumaRepo: REPOS.snowluma,
    useMirror: true,
    /**
     * 下载并发数（多线程分段下载）。
     *   0 = 按文件大小自动（4~8 段）
     *   1 = 强制单连接（镜像不支持 Range 时的兜底行为）
     *   2~8 = 用户指定的并发数
     * 上限 8 是刻意的：单连接实测就在 2~3 MB/s，瓶颈在单条 TCP 上，
     * 再往上加连接对总吞吐帮助很小，却会明显加重镜像站和本机负担。
     */
    downloadThreads: 0
  },
  service: {
    pythonPath: 'python',
    maibotDir: '',
    /*
      ⚠️ 这里以前还有三个键：协议端目录、"快速登录"免扫码、后端二选一。
      QQ 注入式协议端（含它的"快速登录"免扫码功能）已经整体移除，
      协议端只剩 SnowLuma 一种，所以"二选一"这个概念本身也不存在了。
      旧配置文件里残留的这几个键由 settings.js 的迁移层剥掉。
    */
    /** SnowLuma 运行时目录（解压后的 node.exe + index.mjs 所在处） */
    snowlumaDir: '',
    /**
     * SnowLuma 端口。
     * 与 service.ports 分开命名空间：那两个（MaiBot 主服务 / MaiBot WebUI）
     * 语义完全不同，混在一个对象里很容易被 `ports.webui` 这类写法串味。
     */
    snowlumaPorts: { ...DEFAULT_SNOWLUMA_PORTS },
    ports: { ...DEFAULT_PORTS },
    /** 启动后等待端口就绪的最长毫秒数 */
    startupTimeoutMs: 15000,
    /** 异常退出后自动重启次数上限；0 = 关闭看门狗 */
    autoRestartLimit: 3
  },
  general: {
    /**
     * 启动器启动后自动拉起已配置的服务。
     * 说明：该字段此前存在于设置与校验中，但主进程从未读取 ——
     * 设置页的开关写了等于没写。现在由 main.js 在就绪后真正执行。
     */
    autoStart: false,
    /** 写入 Windows 登录项（真实读写注册表，见 services/loginitem.js） */
    launchOnLogin: false,
    /** 服务异常退出 / 放弃重启时是否发系统通知 */
    desktopNotify: true,
    /**
     * 界面主题偏好（UI v3 的深浅双主题）。
     *   'system' —— 跟随 Windows（默认；首次启动时读 nativeTheme.shouldUseDarkColors）
     *   'light' / 'dark' —— 用户手动选过，重启后保持
     * 主进程侧的读写与实现在 services/index.js 的 theme:get / theme:set，
     * 以及 windows.js 的 applyTheme / applyPersistedTheme。
     * ⚠️ 它与"每个页面一个主题色"的旧机制（--route-*，见 router/index.js）无关：
     *    那套是页面配色，这套是整体明暗。
     */
    theme: 'system',
    /**
     * 安装扫描的自定义根目录。
     * 空数组 = 使用系统默认根（桌面/下载/文档/用户目录/APPDATA/LOCALAPPDATA）。
     * 允许用户添加自定义目录，因为很多用户会把 MaiBot 装在别的盘。
     */
    scanRoots: [],
    /** 日志页默认展示的日志行数 */
    logRetentionLines: 2000
  }
};

/**
 * MaiBot 运行必需依赖。
 * 说明：原来是一个裸字符串数组并被 `filter((n) => n)` 过滤（恒为真，纯装饰）。
 * 这里改为对象数组，标注包名与展示名，便于前端给出准确提示。
 *
 * `imp` 是 **import 名**，与 pip 包名并不总是一致
 * （Pillow→PIL、pyyaml→yaml 是经典例子）。
 * 「快速检查」用它做模块级探测，所以两者都要写准：
 * 写错会导致明明装了却报缺失。
 */
const MAIBOT_REQUIRED_DEPS = [
  { pkg: 'openai', name: 'openai', imp: 'openai' },
  { pkg: 'httpx', name: 'httpx', imp: 'httpx' },
  { pkg: 'fastapi', name: 'fastapi', imp: 'fastapi' },
  { pkg: 'uvicorn', name: 'uvicorn', imp: 'uvicorn' },
  { pkg: 'websockets', name: 'websockets', imp: 'websockets' },
  { pkg: 'pydantic', name: 'pydantic', imp: 'pydantic' },
  { pkg: 'aiohttp', name: 'aiohttp', imp: 'aiohttp' },
  { pkg: 'loguru', name: 'loguru', imp: 'loguru' },
  { pkg: 'rich', name: 'rich', imp: 'rich' },
  { pkg: 'pyyaml', name: 'pyyaml', imp: 'yaml' },
  { pkg: 'pillow', name: 'Pillow', imp: 'PIL' },
  { pkg: 'psutil', name: 'psutil', imp: 'psutil' },
  { pkg: 'tenacity', name: 'tenacity', imp: 'tenacity' }
];

/** Python 最低版本要求 */
const MIN_PYTHON = { major: 3, minor: 12, label: '3.12' };

/** 服务日志环形缓冲上限（每服务） */
const SERVICE_LOG_MAX_LINES = 3000;

/** 主进程应用日志环形缓冲上限 */
const APP_LOG_MAX_LINES = 4000;

/**
 * 安装目录扫描限制。
 *
 * 演进过程（每次都是被真实漏报逼出来的）：
 *   最初：扫 D:/ E:/ F:/ G:/ 整盘根目录 + maxDirs=40000 的串行 DFS，
 *         单次可跑数分钟且**不可取消**。→ 收紧成家目录下的常见位置。
 *   现在：**又被"扫不到"打脸了**。用户实测：机器上明明有十几个麦麦，
 *         扫描只报出 4 个，而且漏掉的都是新版本（1.0.11 / 1.2.0 / 1.2.3 / 1.2.5）。
 *
 *   漏报的根因是 **maxDepth 太小**，跟"扫哪"无关：
 *     walk(root, depth=4) 会检查 root 本身，子目录拿到 depth=3…
 *     也就是说从某个根算起，**最多只到第 3 层**，第 4 层的目录根本不会被看一眼。
 *     而真实安装路径恰好就卡在第 4 层：
 *       %APPDATA%\MaiBotOneKeyDesktop\<hash>\modules\MaiBot   ← 4 层
 *       %LOCALAPPDATA%\com.maibot.launcher\resources\modules\<模块> ← 4 层
 *       D:\所有文件夹\MaiM-with-u\MaiBot-main\MaiBot-main        ← 4 层
 *     所以这些一律漏掉。实测把深度放开到能覆盖第 4 层之后，命中数从 4 涨到 14。
 *
 *   maxDepth 的含义：从根目录往下还能走几层（根自己算第 0 层，被检查）。
 *   取 6 = 覆盖到第 5 层，给"再套一层版本号目录"留余量。
 *
 *   maxDirs 是**安全阀**，不是目标：配合 AbortSignal 取消与耗时上限，
 *   宁可扫得深一点。顺序是先扫"已知安装目录"，所以就算被截断，
 *   最相关的那些也已经拿到了。
 */
const SCAN = {
  maxDepth: 6,
  maxDirs: 40000,
  maxResults: 200,
  /** 命中即整棵跳过的目录名（小写） */
  skipNames: new Set([
    'node_modules', '$recycle.bin', 'system volume information', 'windows',
    'winsxs', 'temp', 'tmp', 'cache', 'site-packages', 'dist-info',
    '__pycache__', '.git', '.svn', '.hg', '.venv', 'venv', 'env',
    '.idea', '.vscode', 'appdata', 'application data', 'program files',
    'program files (x86)', 'programdata', 'recovery', 'perflogs',
    /* 整盘扫描会遇到的"又大又不可能放麦麦"的系统/构建目录 */
    'driverstore', 'drivers', 'assembly', 'servicing', 'installer',
    '$windows.~bt', '$windows.~ws', 'windowsapps', 'packages',
    'softwaredistribution', 'd3dscache', 'crashdumps', 'nvidia',
    'driverpacks', 'onedrivetemp', 'wpsystem', 'pip', 'pipcache', 'npm-cache',
    'cargo', 'rustup', 'go-build', 'nuget', 'gradle', 'maven', 'vcpkg'
  ])
};

/** 升级/安装时需要保留的用户数据（相对安装目录） */
const USER_DATA_KEEP = ['config', 'data', 'logs', 'models', '.env', 'bot_config.toml'];

/**
 * MaiBot 侧的适配器插件目录与配置版本。
 *
 * ⚠️ 状态：**已定义但未被任何代码消费**（grep 只命中本文件）。
 *    接线相关的事情由界面做「真实探测 + 操作指引」，不写用户文件（理由见下）。
 *
 * 分歧已实测解决 —— 以**官方适配器仓库**为准：
 *   直接读官方插件源码 `snowluma_adapter/settings.py` 得到
 *       SUPPORTED_CONFIG_VERSION = "1.0.6"
 *    且它连的是 `ws://{server}:{port}`（一个**正向** WebSocket 客户端），
 *    字段提示原文是 "Keep this consistent with the SnowLuma WebSocket listening port."
 *   → 官方插件目录名是 `MaiBot-SnowLuma-Adapter`，配置版本 1.0.6。
 *
 *   而参考实现（MaiBot OneKey）里那份 `plugins/snowluma-adapter` + `1.0.0`
 *   是**第三方打包的分支**，不是官方那份。两者名字、版本、配置结构都不同。
 *   所以下面这两个值保留为 1.0.6 / 官方目录名，别再抄 OneKey 的那组。
 *
 * 为什么仍然"不写这些文件"：
 *   实测真跑了一次 SnowLuma（v1.14.19），它自己生成的 `config/runtime.json` 里
 *   只有 WebUI / 日志 / 代理这些项，**完全没有 OneBot 段**，进程也只监听 5099。
 *   它的 OneBot 正向 WS 服务器是用户在**它自己的 WebUI 里现建**的，端口也由用户填。
 *   启动器没有可靠的落点可以替用户写配置，硬写一份猜结构的只会制造
 *   "看起来配好了、其实没生效"。所以接线做成「探测端口 + 指引」（见 OverviewPanel）。
 */
const ADAPTER = {
  /**
   * 官方 SnowLuma 适配器的目录名。
   * ⚠️ 不是 'snowluma-adapter'（那是第三方分支的名字）。
   */
  snowlumaDir: 'plugins/MaiBot-SnowLuma-Adapter',
  /** 官方插件 settings.py 里 SUPPORTED_CONFIG_VERSION 的值 */
  snowlumaConfigVersion: '1.0.6'
};

module.exports = {
  APP,
  REPOS,
  UPDATE,
  GITHUB,
  DEFAULT_PORTS,
  DEFAULT_SNOWLUMA_PORTS,
  DEFAULT_SETTINGS,
  ADAPTER,
  MAIBOT_REQUIRED_DEPS,
  MIN_PYTHON,
  SERVICE_LOG_MAX_LINES,
  APP_LOG_MAX_LINES,
  SCAN,
  USER_DATA_KEEP
};
