/*
================================================================================
技术文档：src/main/windows.js
职责：主窗口生命周期管理。
================================================================================
  相对重构前的修正：
    - resolvePreload() 原来逐个探测 7 个候选路径，其中 5 个在打包后必定不存在，
      属于"猜路径"。现在构建产物位置固定（dist/preload/preload.cjs），
      只保留「开发态源码路径兜底」，逻辑可推理。
    - sandbox **保持开启**（见下方 webPreferences 里的说明）：preload 只用
      contextBridge 建立白名单，不 require 任何 Node 内置模块，沙箱内完全可用。
      （旧注释写的是"保持关闭 + preload 需要 Node"，与代码不符。）
    - 旧注释里的 canNavigate 限制**在代码中从未存在**，已删除这句表述。
      "禁止导航到站外"现在真的实现了：见 isAllowedNavigation() 与
      will-navigate / will-redirect 两个守卫。
    - 关闭窗口 → 隐藏到托盘的行为保留，但显式绑定 quit 标记，避免无法退出；
      另外可由 setCloseToTray(false) 关掉"隐藏到托盘"（托盘创建失败时的降级出口）。
================================================================================
*/
const { BrowserWindow, shell, app, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { APP } = require('./constants');
const logging = require('./logging');

let mainWindow = null;
let quitting = false;
/*
  关闭按钮是否"隐藏到托盘"。
  ⚠️ 必须可关：托盘创建失败（脚本图标缺失 / 资源未打包 / Tray 构造抛错）时，
  把它置为 false 让关闭按钮真的退出应用。否则窗口一藏、托盘又没有，
  再叠加"渲染层没起来"（渲染层内的退出入口自然点不到），用户就只剩
  任务栏右键一条路 —— 这不是崩溃，但用户会认为应用"不见了"。
*/
let closeToTray = true;

/**
 * 解析 preload 脚本路径。
 * 生产态：dist/main/main.cjs 的同级兄弟目录 dist/preload/preload.cjs
 * 开发态：若产物尚未生成，回退到源码位置（esbuild 监听会很快产出）
 */
function resolvePreload() {
  const candidates = [
    path.join(__dirname, '..', 'preload', 'preload.cjs'),
    path.join(app.getAppPath(), 'dist', 'preload', 'preload.cjs'),
    path.join(app.getAppPath(), 'src', 'preload', 'preload.js')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error('[windows] 未找到 preload 产物，已尝试:', candidates.join(' | '));
  return candidates[0];
}

/** 解析渲染层入口 HTML */
function resolveRendererIndex() {
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'index.html'),
    path.join(app.getAppPath(), 'dist', 'renderer', 'index.html')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error('[windows] 未找到渲染层产物，已尝试:', candidates.join(' | '));
  return candidates[0];
}

/* ============================================================================
 *  导航守卫（防钓鱼跳转）
 * ---------------------------------------------------------------------------
 *  will-navigate / will-redirect 共用同一套判据，避免两处规则跑偏。
 * ========================================================================== */

/** 渲染层产物目录；file:// 只允许落在它里面 */
function rendererDir() {
  return path.join(__dirname, '..', 'renderer');
}

/**
 * 该 file:// URL 是否指向本应用自己的渲染层产物（dist/renderer/**）。
 *
 * ⚠️ 不能只判断 `url.startsWith('file://')` —— 那等于放行**任意**本地 HTML：
 *    页面里放一个 `<a href="file:///C:/Users/.../evil.html">` 就能把主窗口
 *    导航到一个本地文件上。file:// 页面继承本应用 webContents 的 preload，
 *    而 preload 里挂着 window.__MAIBOT__ 白名单（含退出 / 打开外部 / 各种 IPC），
 *    等于把受限能力交给一个攻击者可控的文档。
 *    UNC（file://host/share/x.html）同样按"非本目录"拒绝：hostname 非空即拦。
 */
function isOwnRendererFileUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return false; /* 连 URL 都解析不出来的，一律不放行 */
  }
  if (parsed.protocol !== 'file:') return false;
  /*
    hostname 非空即非本机文件路径，一律拒绝：
      · UNC / 远端共享：file://evil.host/share/x.html。
    注意 `file://localhost/...` **不需要**单独处理：实测 Node 的 WHATWG URL
    已把它归一化成 `file:///...`（hostname === ''），剩下仍由下面的目录判据
    兜住 —— 不在 renderer 目录内的照样拦。
  */
  if (parsed.hostname) return false;

  /* decodeURIComponent 处理中文/空格路径（URL.pathname 是百分号编码的） */
  let p;
  try {
    p = decodeURIComponent(parsed.pathname);
  } catch (_) {
    return false; /* 非法转义序列 */
  }
  /* Windows 上 pathname 形如 /C:/...，去掉前导斜杠再归一化 */
  const fsPath = path.resolve(/^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p);
  const base = path.resolve(rendererDir());
  const rel = path.relative(base, fsPath);
  /* rel 为空 = 目录本身；以 .. 开头 = 逃出目录；绝对路径 = 换了盘符 */
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 是否允许 webContents 导航到这个 URL。
 *
 * 开发态：与 dev server **同源**才放行。
 *   ⚠️ 不能用 url.startsWith(devUrl)：`http://localhost:5173.evil.com/`、
 *   `http://localhost:51730/` 都是 `http://localhost:5173` 的前缀串，
 *   前缀匹配会把钓鱼页放进来。用 URL().origin 精确比对。
 * 生产态：只放行本应用 renderer 产物目录里的 file://，其余一律不放行。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedNavigation(url) {
  const raw = String(url || '');
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    try {
      return new URL(raw).origin === new URL(devUrl).origin;
    } catch (_) {
      return false;
    }
  }
  return isOwnRendererFileUrl(raw);
}

/** 拦截后：只有 http(s) 才转交系统浏览器，file:// 之类的**不**外开 */
function openExternalIfHttp(url) {
  if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const { width, height, minWidth, minHeight } = APP.window;

  /*
    窗口图标优先用 .ico：
      Windows 的标题栏/Alt+Tab 需要 16/24/32 等小尺寸，给一张 256 的 PNG
      让系统自己缩，边缘会发虚；.ico 里我们准备了 7 帧（16~256），
      系统按当前 DPI 挑最合适的那一帧，小尺寸下明显更清楚。
    PNG 作为兜底：非 Windows 平台不认 .ico。
  */
  const iconCandidates = [
    /* 打包后 build/ 不在 asar 里（electron-builder 把它排除掉了），只能走 extraResources */
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'icons', 'icon.ico')] : []),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon-256.png')
  ];
  const windowIcon = iconCandidates.find((p) => fs.existsSync(p)) || '';

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    /*
      无边框自绘标题栏（UI v3）。
      ──────────────────────────────────────────────────────────────────
      frame: false 去掉系统标题栏，标题栏由渲染层自绘（高 40px，
      整条 -webkit-app-region: drag）。titleBarStyle: 'hidden' 与 frame:false
      的作用一致，同时给将来需要保留系统按钮的平台留一条退路；
      两者同时设置不会改变行为（Windows 上 frame:false 优先）。

      backgroundColor 是**渐变基色**：渲染层用 CSS 渐变覆盖整个窗口，
      但窗口创建到首帧之间仍是这张纯色底，所以取浅色渐变的起点
      #f8fbff（原来是 #e8ecf1，一个偏灰的蓝，与 v3 配色不符）。
      深色主题由渲染层在首帧前设置 data-theme，不依赖这里。
    */
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#f8fbff',
    autoHideMenuBar: true,
    title: APP.name,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      /*
        渲染进程沙箱：开启。
        preload 只 require('electron') 来建立 contextBridge 白名单，
        不触碰任何 Node 内置模块，因此在沙箱内完全可用。
        开启后渲染进程即使被注入脚本，也无法读取文件系统或启动进程。
        （重构前此处为 sandbox: false，理由是"preload 需要 Node 能力"，
          但该 preload 从未使用过 Node 能力，属于无根据的放宽。）
      */
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  /*
    权限请求：默认拒绝，只放行剪贴板写入。
    ──────────────────────────────────────────────────────────────────
    Electron 对媒体（摄像头/麦克风）、通知、地理位置、剪贴板读取等权限
    有自己的一套默认行为，而这个启动器**一个都不需要**。
    不显式拒绝的话，渲染层一旦被注入脚本，就能直接申请到这些权限 ——
    contextIsolation / sandbox / CSP 都拦不住"申请权限"这条路。

    唯一要放行的是 clipboard-sanitized-write：日志页的「复制」按钮
    走的是标准剪贴板 API，拒掉它功能就废了。读取剪贴板**不放行**，
    启动器没有任何理由去读用户复制的东西。
  */
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
  try {
    const ses = mainWindow.webContents.session;
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      if (ALLOWED_PERMISSIONS.has(permission)) return callback(true);
      require('./logging').log('warn', `[window] 已拒绝权限请求: ${permission}`);
      callback(false);
    });
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  } catch (e) {
    require('./logging').log('warn', `[window] 权限处理器注册失败: ${e.message}`);
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    if (process.argv.includes('--debug') || process.argv.includes('-debug')) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(resolveRendererIndex());
  }

  /* 就绪后再显示，避免白屏闪烁 */
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) mainWindow.show();
  });

  /* 外部链接一律交给系统浏览器，不在应用内开新窗口 */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  /*
    禁止窗口被导航到站外地址（防钓鱼跳转）。
    ⚠️ 原实现是 `devUrl ? url.startsWith(devUrl) : url.startsWith('file://')`：
      · dev 态：前缀匹配 → `http://localhost:5173.evil.com` 能过；
       · 生产态：`file://` 前缀匹配 → 任意本地 HTML / UNC 路径都能过。
    现在两态都走 isAllowedNavigation()（见上方注释）。
    拦截后仅把 http(s) 交给系统浏览器；file:// 等协议不转交，
    否则等于给了攻击者一个"打开本地文件"的原语。
  */
  const guardNavigation = (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    logging.log('warn', `[window] 已拦截窗口导航: ${url}`);
    openExternalIfHttp(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  /*
    重定向是同一条攻击路径的第二段：will-navigate 只看用户/脚本发起的
    导航，服务端 302 走的是 will-redirect。只堵前者的话，
    一个放行过的 http(s) 地址只要 302 到 file:// 或站外就能绕过去。
  */
  mainWindow.webContents.on('will-redirect', guardNavigation);

  /* 关闭 = 隐藏到托盘；真正退出由 before-quit 置位 quitting */
  mainWindow.on('close', (event) => {
    /*
      closeToTray 为 false 时不拦：窗口真的关掉。
      触发条件是"托盘没建起来"（见 main.js 对 createTray 返回值的处理）——
      那种情况下必须保证点关闭 = 退出应用，否则窗口一藏就没入口了。
      这里不额外 setQuitting(true)：窗口全关后由 before-quit 的既有流程
      负责停子进程、落盘日志，不绕过它。
    */
    if (!quitting && closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  /*
    窗口真正销毁后清空引用。
    注意：这个监听器必须注册在 createMainWindow 内 —— 它曾一度被误放进
    runPageSelfCheck()（只在自检模式调用），导致正常运行时 mainWindow
    关闭后不被置空、变成悬空引用，getMainWindow() 会拿到已销毁的实例。
  */
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /*
    窗口最大化状态变化 → 推送给渲染层。
    ──────────────────────────────────────────────────────────────────
    自绘标题栏后，最大化/还原按钮的图标不会再由系统自动切换，
    必须由主进程告诉渲染层当前状态（事件名 window:state，见 ui-brief v3）。
    maximize / unmaximize 覆盖按钮与双击标题栏两条路径；
    resize 是兜底：Windows 上把窗口拖到屏幕顶端触发的"贴靠最大化"
    不一定走 maximize 事件，只表现为尺寸变化 —— 不补这一条，
    按钮图标会和真实状态脱节。状态没变时 emitWindowState 不发送，
    所以 resize 期间不会刷事件洪峰。
  */
  mainWindow.on('maximize', () => emitWindowState());
  mainWindow.on('unmaximize', () => emitWindowState());
  mainWindow.on('resize', () => emitWindowState());

  /*
    页面自检（仅 MAIBOT_LAUNCHER_SELFCHECK=1 时启用）。

    「界面已挂载」只能证明默认页能渲染；路由都是懒加载的，
    其他页面要真正进去一次才知道会不会炸（模板里读 undefined 之类）。
    这里逐个导航并抓取渲染层异常，把结果写进日志，
    让 `npm run selfcheck` 能用一份日志覆盖到每个页面。

    自检期间要屏蔽新手引导的自动展开：向导的右侧抽屉虽然遮罩不吃点击，
    但它的节点文本会混进各路由的断言内容里，让"页面渲染正常"的判定失真。
    标记由 preload 在页面脚本执行前挂上（见 preload.js 顶部），
    这里不重复注入 —— 而且 executeJavaScript 会撞上 CSP 的 script-src 'self'。
  */
  if (process.env.MAIBOT_LAUNCHER_SELFCHECK === '1') {
    runPageSelfCheck(mainWindow).catch((e) => {
      logging.log('error', `[selfcheck] 页面自检失败: ${e.message}`);
    });
  }

  return mainWindow;
}

/**
 * 需要自检的路由（与 renderer/router/index.js 保持一致）。
 *
 * ⚠️ 只列**有 meta.title 的页面路由**：'download' 已经并入 'installer'
 *    （只剩一条 redirect），把它留在这里会拿不到 verdict 行 ——
 *    重定向后 location.hash 变成 #/installer，verdict 的 route 名也就成了
 *    installer，于是"页面数 vs verdict 数"对不上，selfcheck 会误判失败。
 */
const SELFCHECK_ROUTES = [
  'overview',
  'installer',
  'logs',
  'terminal',
  'toolbox',
  'settings',
  'about'
];

/**
 * 依次导航到每个路由，收集渲染层异常与 Vue 警告。
 * @param {Electron.BrowserWindow} win
 */
async function runPageSelfCheck(win) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 页面就绪前导航会拿到空白文档，先等首帧 */
  await new Promise((resolve) => {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
    else resolve();
  });
  await sleep(1500);

  const results = [];
  for (const route of SELFCHECK_ROUTES) {
    try {
      const res = await win.webContents.executeJavaScript(
        `(async () => {
           const errs = [];
           const onErr = (e) => errs.push(String(e.message || e.reason || e));
           window.addEventListener('error', onErr);
           window.addEventListener('unhandledrejection', onErr);
           location.hash = '#/${route}';
           await new Promise((r) => setTimeout(r, 900));
           const app = document.querySelector('#app');
           const html = app ? app.innerHTML : '';
           window.removeEventListener('error', onErr);
           window.removeEventListener('unhandledrejection', onErr);
           /*
             主题色一并采集。
             syncTheme() 会把路由元数据里的 var(--route-xxx) 解析成真实颜色再写回
             --theme-color / --theme-tint。这条链路任何一环断掉（变量名写错、
             getComputedStyle 读到空、rgba() 算出非法值），界面会静默退化成
             无色主题，但页面依然"渲染正常" —— 单看节点长度是发现不了的。
             所以这里把解析结果带出来，由下面的断言判定。
           */
           const cs = getComputedStyle(document.documentElement);
           const themeColor = cs.getPropertyValue('--theme-color').trim();
           const themeTint = cs.getPropertyValue('--theme-tint').trim();
           /*
             滚动几何采集。
             为什么必须查：内容更高的页面只能靠 .body 这个内部滚动容器滚，
             高度链一旦有一环断掉（flex 子项没约束住、父级用了 auto 高度），
             .body 会随内容一起长高 —— 页面看起来"渲染正常"，
             但用户滚不动，而且底部内容永远看不见。
             节点长度、文本内容这些断言全都发现不了这种情况。
           */
           const body = document.querySelector('.body');
           const geo = (el) => {
             if (!el) return null;
             const c = getComputedStyle(el);
             return {
               ch: el.clientHeight,
               sh: el.scrollHeight,
               ov: c.overflowY,
               fg: c.flexGrow,
               minH: c.minHeight
             };
           };
           const scroll = {
             doc: geo(document.documentElement),
             app: geo(document.querySelector('#app')),
             root: geo(document.querySelector('.app-root')),
             shell: geo(document.querySelector('.shell')),
             body: geo(body)
           };
           /*
             文本采集长度：260 → 1400。
             260 字符会在设置页的「LLM 引擎」那一段就截断，而服务的
             SnowLuma 目录 / 端口这些字段排在更后面 ——
             截断意味着这些字段**整个消失也检测不出来**。
             1400 足够覆盖设置页（最长的一页）里所有关键字段。
           */
            /*
              常驻入口的**存在性按元素判定，不按文案判定**。
              data-testid="titlebar-help" 是 AppLayout 上那个入口 pill 的稳定钩子，
              而 AppLayout 是所有路由共用的外壳，所以它必须在每个页面都查得到。
              以前这里靠 text 里有没有「新手引导」四个字来判断 ——
              那是**用户可见的文案**：pill 的文字后来改成「帮助」+ 徽标
              （"从零开始 0/10 步"，因为"新手引导"这词对新手不友好），
              于是入口明明每个页面都在，断言却报 0/7 可见。
              断言钉死一句会被反复打磨的文案，就必然误报；钩子属性比文案稳定得多。
            */
            const helpPill = !!document.querySelector('[data-testid="titlebar-help"]');
            return { route: '${route}', len: html.length, text: (app ? app.innerText : '').slice(0, 1400), helpPill, errs, themeColor, themeTint, scroll };
         })()`,
        true
      );
      results.push(res);
      /*
        滚动可达性判定。
        ────────────────────────────────────────────────────────────────
        真实故障（用户反馈"所有页面无法上下滚动"）：.app-root 缺高度规则，
        高度链断开，.body 的高度跟着内容走 → 内部滚动容器永远没有可滚高度。
        这类问题**渲染完全正常**（节点长度、文本、主题色全过），
        所以必须单独判：内容比容器高的时候，必须真的有地方能滚。
        判定条件（满足其一即可）：
          · .body 可滚（sh > ch，且 overflow-y 允许滚动）—— 正常路径
          · 整个文档可滚（doc 可滚）—— 兜底路径
          · 内容没超出容器 —— 本来就不需要滚
        三者都不满足 = 有内容被裁掉且用户够不到，判为异常。
      */
      const sc = res.scroll || {};
      const canScroll = (g) =>
        Boolean(g) && g.sh > g.ch + 2 && !/hidden|clip/.test(String(g.ov || ''));
      const bodyG = sc.body;
      const fits = Boolean(bodyG) && bodyG.sh <= bodyG.ch + 2;
      const bodyScrollable = canScroll(bodyG);
      const docScrollable = canScroll(sc.doc);
      const reachable = fits || bodyScrollable || docScrollable;

      const bad = res.errs.length > 0 || res.len < 200 || !reachable;
      /*
        ⚠️ 状态标记必须是**独立的机器可读字段**，不能靠在正文里搜"异常"两个字。
        这个坑真实踩过：设置页有一句「服务异常退出或放弃自动重启时发出 Windows
        通知」，正文里含"异常" —— 于是健康页面被判成渲染异常。
        它埋了很久没暴露，是因为文本只采集 260 字符、恰好截不到那句话；
        把长度放宽到 1400 之后立刻现形。
        所以判定只看 res.errs / res.len，正文里出现什么词都不影响。
      */
      logging.log(
        bad ? 'error' : 'info',
        `[selfcheck] ${res.route.padEnd(10)} ${bad ? '异常' : '正常'} 节点长度=${res.len}` +
          ` 主题=${res.themeColor || '(空)'}` +
          (res.errs.length ? ` 错误=${JSON.stringify(res.errs)}` : '') +
          ` 内容="${String(res.text).replace(/\s+/g, ' ').trim()}"`
      );
      /*
        单独一行、结构化的判定结果。
        ────────────────────────────────────────────────────────────────
        为什么不复用上面那行做判定：上面那行带 1400 字页面正文，正文里
        完全可能出现"异常"两个字（用户可见文案，例如通知说明）。曾经就是
        靠在整行里搜"异常"来判页面坏了 —— 设置页那句「服务异常退出…」
        直接把健康页面判成了渲染异常。
        这一行不含任何页面内容，格式固定为 `<route>=ok|bad`，只能靠
        res.errs / res.len 推导，不会被文案污染。
      */
      logging.log(
        'info',
        `[selfcheck] verdict ${res.route}=${bad ? 'bad' : 'ok'}${
          reachable ? '' : ' 原因=内容超出容器却无处可滚'
        }`
      );
      /* 滚动几何单独一行：诊断"页面滚不动"这类问题必须有真实数字 */
      {
        const s = res.scroll || {};
        const fmt = (g) => (g ? `ch=${g.ch} sh=${g.sh}${g.sh > g.ch ? '(可滚)' : ''}` : 'null');
        logging.log(
          'info',
          `[selfcheck] 滚动 ${res.route} doc=${fmt(s.doc)} app=${fmt(s.app)} ` +
            `root=${fmt(s.root)} shell=${fmt(s.shell)} body=${fmt(s.body)}` +
            (s.body ? ` bodyOv=${s.body.ov}` : '')
        );
      }
    } catch (e) {
      results.push({ route, errs: [e.message], len: 0 });
      logging.log('error', `[selfcheck] ${route} 导航失败: ${e.message}`);
    }
  }

  /*
    主题解析断言。
    1) 每个页面的 --theme-color 必须是合法颜色（非空、不是 "var(...)"、
       不是 color-mix 之类的未解析形态）；
    2) 各页面的颜色必须**互不相同** —— router/index.js 里每页一个色值，
       如果全部退化成同一个兜底色（HUE），说明 var(--route-xxx) 没解析成功，
       而这正是本轮"把主题色收敛到 CSS 变量"改造最容易踩的坑。
  */
  const themeProblems = [];
  for (const r of results) {
    const c = String(r.themeColor || '');
    if (!c || /^var\(/i.test(c) || !/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|color\()/i.test(c)) {
      themeProblems.push(`${r.route}: --theme-color 非法（"${c}"）`);
    }
    /*
      --theme-tint 由 rgba(color, 0.15) 生成。
      如果走到 color-mix 兜底分支，说明颜色不是 hex —— 这里要明确报出来，
      因为 tint 是界面上大面积使用的背景色，退化成非法值会直接丢样式。
    */
    if (r.themeTint && !/^rgba?\(/i.test(String(r.themeTint))) {
      themeProblems.push(`${r.route}: --theme-tint 非 rgba（"${r.themeTint}"）`);
    }
  }
  const distinct = new Set(results.map((r) => String(r.themeColor || '').toLowerCase()));
  if (results.length > 1 && distinct.size === 1) {
    /*
      ⚠️ 这条原本是 `themeProblems.push(...)`，会把"各页主题色相同"报成**故障**。
      但 v3 规格把"单一蓝色强调 + 深浅两套主题"定为设计（见 AppLayout 顶部注释），
      AppLayout 现在显式写 `--theme-color = var(--accent)`，
      所以**所有路由的 --theme-color 本来就该是同一个值**；
      per-route 的颜色搬到了 --route-ink / --route-tint。
      于是这条断言每次自检都会报一个"主题问题 1 项"的假警报 ——
      又一次"断言钉住了已被设计取代的旧行为"。
      → 降级为 info 日志（保留可观测性），不再计入 themeProblems。
      真正该盯的是 --route-ink 是否按路由表解析出不同颜色：
      探针目前没采集该字段，属已知覆盖缺口（见交付文档"已知未修"一节），
      补它需要在 executeJavaScript 的采集脚本里新增一个字段。
    */
    logging.log(
      'info',
      `[selfcheck] 各页 --theme-color 相同（${[...distinct][0]}）` +
        '—— v3 下这是预期；per-route 颜色已搬到 --route-ink'
    );
  }

  const failed = results.filter((r) => (r.errs && r.errs.length) || r.len < 200);

  /*
    新手引导入口必须**每个页面都在**。
    它挂在 AppLayout 上（所有路由共用的外壳），所以每个页面的文本里
    都应该出现「新手引导」。如果哪天有人把它挪进某个具体页面、
    或者给入口加上了"关过就不再显示"的条件，这条断言会立刻失败 ——
    这正是用户报过的"收起后就没了"那类回归。
  */
  /*
    新手引导入口必须**每个页面都在**。
    它挂在 AppLayout 上（所有路由共用的外壳），所以每个页面里都该查得到
    `[data-testid="titlebar-help"]`。如果哪天有人把它挪进某个具体页面、
    或者给入口加上了"关过就不再显示"的条件，这条断言会立刻失败 ——
    这正是用户报过的"收起后就没了"那类回归。

    ⚠️ 判据从"text 里含「新手引导」"改成"查得到那个钩子元素"，原因：
      pill 的可见文案后来改成了「帮助」（+ "从零开始 0/10 步" 徽标），
      而 aria-label/title 里才留「新手引导」—— innerText 取不到 aria-label，
      于是文案一改，入口**明明在 7 个页面上都在**，断言却报 0/7 可见。
      断言不该钉死一句会随文案打磨而变的中文；钩子属性本就是给测试用的。
      下面保留 text 兜底，是为了兼容旧版 main.cjs（打包产物未更新时仍能判定）。
  */
  const missingGuide = results.filter(
    (r) => !r.helpPill && !String(r.text || '').includes('新手引导')
  );
  logging.log(
    missingGuide.length ? 'error' : 'info',
    `[selfcheck] 新手引导常驻入口：${results.length - missingGuide.length}/${results.length} 个页面可见` +
      (missingGuide.length ? `，缺失页面: ${missingGuide.map((f) => f.route).join(', ')}` : '')
  );

  /*
    关键服务设置必须真的渲染在设置页上。
    这些字段控制的是"能不能把服务拉起来"，一旦因为模板改错而整块消失，
    界面照样"渲染正常"（节点长度依旧够长），只有靠断言才拦得住。
  */
  const settingsPage = results.find((r) => r.route === 'settings');
  const missingKeys = settingsPage
    ? [
        'MaiBot 主服务端口',
        'MaiBot WebUI 端口',
        /* SnowLuma 是唯一的协议端，这一组少一个用户就配不对，
           而"渲染正常"断言照样会通过（节点长度依旧够长） */
        'SnowLuma 目录',
        'SnowLuma WebUI 端口',
        'SnowLuma OneBot 端口'
      ].filter((k) => !String(settingsPage.text || '').includes(k))
    : [];
  logging.log(
    missingKeys.length ? 'error' : 'info',
    `[selfcheck] 设置页关键服务字段：${missingKeys.length ? `缺失 ${missingKeys.join('、')}` : '齐全'}`
  );

  logging.log(
    themeProblems.length ? 'error' : 'info',
    `[selfcheck] 主题色解析：${themeProblems.length ? '异常' : '正常'}（${distinct.size} 种不同颜色）` +
      (themeProblems.length ? `\n  - ${themeProblems.join('\n  - ')}` : '')
  );
  logging.log(
    failed.length || themeProblems.length ? 'error' : 'info',
    `[selfcheck] 完成：${results.length - failed.length}/${results.length} 个页面渲染正常` +
      (failed.length ? `，异常页面: ${failed.map((f) => f.route).join(', ')}` : '') +
      (themeProblems.length ? `，主题问题 ${themeProblems.length} 项` : '') +
      (missingGuide.length ? `，引导入口缺失 ${missingGuide.length} 个页面` : '')
  );

  /* 结果写盘后退出，供 CI / 脚本采集 */
  if (process.env.MAIBOT_LAUNCHER_SELFCHECK_EXIT === '1') {
    await logging.flush?.();
    setTimeout(() => app.exit(failed.length || themeProblems.length ? 1 : 0), 400);
  }

}

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createMainWindow();
}

function setQuitting(value) {
  quitting = Boolean(value);
}

/**
 * 设置"关闭按钮是否隐藏到托盘"。
 * 托盘创建失败时由 main.js 调用 setCloseToTray(false)：让关闭按钮真的退出，
 * 保证"窗口消失 + 无托盘 + 渲染层没起来"这三种情况叠加时用户仍有正常出口。
 * @param {boolean} value
 */
function setCloseToTray(value) {
  closeToTray = Boolean(value);
}

/** 当前"关闭到托盘"开关状态（供自检 / 诊断读取） */
function isCloseToTray() {
  return closeToTray;
}

function isQuitting() {
  return quitting;
}

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/**
 * 向渲染进程安全投递事件。
 * 重构前各处手写 `if (win && !win.isDestroyed()) win.webContents.send(...)`，
 * 且大量使用 webContents.getAllWebContents() 广播（导致 LLM 流串台）。统一收口在这里。
 */
function sendToRenderer(channel, payload) {
  const win = getMainWindow();
  if (!win || win.webContents.isDestroyed()) return false;
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch (e) {
    console.warn(`[windows] 事件投递失败 ${channel}:`, e.message);
    return false;
  }
}

/* ============================================================================
 *  窗口最大化状态（自绘标题栏用）
 * ========================================================================== */

/** 渲染层最后一次收到的最大化状态，用于去重（null = 还没同步过） */
let lastWindowState = null;

/**
 * 读当前窗口是否最大化。
 * 窗口还没建好时返回 null —— 与"未最大化"区分开：
 * 前者是"不知道"，让调用方有机会在窗口建好后重新推一次。
 */
function readWindowState() {
  const win = getMainWindow();
  if (!win) return null;
  return win.isMaximized();
}

/**
 * 把最新最大化状态推给渲染层（值没变就不发）。
 * @param {{force?:boolean}} [opts] force = 忽略去重，强制推送
 * @returns {boolean} 是否真的发送了
 */
function emitWindowState(opts = {}) {
  const maximized = readWindowState();
  if (maximized === null) return false;
  if (!opts.force && maximized === lastWindowState) return false;
  lastWindowState = maximized;
  sendToRenderer('window:state', { ok: true, maximized });
  return true;
}

/**
 * 切换最大化 / 还原，返回**新状态**。
 * 渲染层点击标题栏按钮后据此立刻换图标，不必再发一次 window:is-maximized。
 * @returns {{ok:boolean, maximized:boolean}}
 */
function toggleMaximize() {
  const win = getMainWindow();
  if (!win) return { ok: false, maximized: false };
  /*
    先读取旧状态，因为 maximize() / unmaximize() 之后的 isMaximized()
    在部分 Windows 环境下要等下一帧才更新（实测偶发读到旧值），
    直接用"取反"作为目标状态更可靠。
  */
  const wasMaximized = win.isMaximized();
  if (wasMaximized) win.unmaximize();
  else win.maximize();
  lastWindowState = !wasMaximized;
  return { ok: true, maximized: !wasMaximized };
}

/* ============================================================================
 *  双主题（浅色 / 深色）
 * ---------------------------------------------------------------------------
 *  权威来源分两层：
 *    · 原生层 —— nativeTheme.themeSource 决定 shouldUseDarkColors，
 *      也决定滚动条、原生控件、系统菜单的明暗；
 *    · 渲染层 —— 由 data-theme 属性 + theme.css 的 token 决定。
 *  主进程只负责原生层与"当前主题是什么"的推送；渲染层的属性由它自己设。
 * ========================================================================== */

/**
 * 用户持久化的主题偏好（三值）。'system' 是默认值，也是"用户从未手动选过"的状态。
 *
 * ⚠️ 这里必须保存**三值**，不能压缩成 `followSystem: boolean`。
 * 原实现就是压成布尔（followSystemTheme），于是启动路径只剩两支：
 * 跟随系统 → 'system'，否则**一律 'light'** —— 上次选 dark 的用户
 * 重启后被设成浅色。'light' 和 'dark' 是两种不同的手动选择，
 * 用一个布尔装不下，丢掉的那一档就必然被当成另一档。
 */
let themePreference = 'system';

/** 渲染层最后一次收到的主题，用于去重 */
let lastTheme = null;

/** 解析当前应生效的主题；'light' | 'dark' */
function resolveTheme() {
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch (e) {
    /* 读不到就按浅色处理：v3 的浅色是默认视觉，出错时也保持可读 */
    console.warn('[windows] 读取系统主题失败:', e.message);
    return 'light';
  }
}

/**
 * 解析**持久化偏好**下应生效的主题；'light' | 'dark'。
 *
 * ⚠️ 'light' / 'dark' 两种偏好下不能读 shouldUseDarkColors：
 * 那个值反映的是"系统是深色还是浅色"，与用户的手动选择无关。
 * 一旦两者不一致（用户在深色系统上选了浅色），读它就会得出错误的主题 ——
 * 表现为"选了浅色还是深色界面"。手动选择直接就是它自己。
 */
function resolveThemeFor(source) {
  if (source === 'light' || source === 'dark') return source;
  return resolveTheme();
}

/**
 * 应用主题。
 * @param {'light'|'dark'} theme
 * @param {{source?:'light'|'dark'|'system', broadcast?:boolean, force?:boolean}} [opts]
 *   source    写进 nativeTheme.themeSource 的值（'system' = 跟随系统）
 *   broadcast 是否推送 theme:changed（默认 true）
 *   force     忽略去重
 * @returns {{theme:string, changed:boolean}}
 */
function applyTheme(theme, opts = {}) {
  const next = theme === 'dark' ? 'dark' : 'light';
  const source = opts.source || next;
  try {
    nativeTheme.themeSource = source;
  } catch (e) {
    console.warn('[windows] 设置 nativeTheme.themeSource 失败:', e.message);
  }
  const changed = next !== lastTheme;
  if (opts.broadcast !== false && (changed || opts.force)) {
    lastTheme = next;
    sendToRenderer('theme:changed', { ok: true, theme: next });
  } else {
    lastTheme = next;
  }
  return { theme: next, changed };
}

/**
 * 登记用户的主题偏好（三值）。
 *
 * 现状：主进程与渲染层是两个进程，"当前偏好是什么"必须由调用方显式告知 ——
 * windows.js 不读设置文件（那会与 services/settings.js 形成双向依赖）。
 * 因此 services/index.js 在 app ready 前调用一次（启动路径），
 * 每次 theme:set 之后再调用一次（运行期）。
 *
 * @param {'light'|'dark'|'system'} value 非法值按 'system' 处理
 */
function setThemePreference(value) {
  themePreference = value === 'light' || value === 'dark' ? value : 'system';
}

/** 读取当前登记的持久化偏好；'light' | 'dark' | 'system' */
function getThemePreference() {
  return themePreference;
}

/**
 * @param {boolean} value 是否跟随系统主题
 * @deprecated 用 setThemePreference()。布尔表达不了 light 与 dark 的区别，
 *   保留这个入口只会让"偏好被降级"的 bug 再次长回来。
 */
function setFollowSystem(value) {
  setThemePreference(value ? 'system' : 'light');
}

/**
 * 注册"系统主题变化"监听：**只在跟随系统时**才应用并推送。
 * 用户手动选过 light / dark 之后，改系统主题不应把他的选择顶掉。
 *
 * 注意这里**不写设置**：跟随系统时 general.theme 本来就是 'system'，
 * 把解析出来的 'dark' 写回去等于把"跟随系统"这个选择永久丢掉。
 */
function initThemeBridge() {
  try {
    nativeTheme.on('updated', () => {
      /* 只有"跟随系统"时，系统主题变化才应该顶掉用户看到的东西 */
      if (getThemePreference() !== 'system') return;
      applyTheme(resolveTheme(), { source: 'system' });
    });
  } catch (e) {
    console.warn('[windows] 系统主题监听注册失败:', e.message);
  }
}

/**
 * 把持久化的主题偏好应用到原生层。
 * 由 main.js 在 app ready 时、建窗口之前调用 ——
 * 必须早于渲染层首帧，否则深色用户会先看到一帧浅色。
 *
 * ⚠️ 这里**必须**走 resolveThemeFor(三值偏好)，不能再自己拼 source。
 * 原实现是 `const source = followSystemTheme() ? 'system' : 'light'`：
 * 偏好一被压成布尔，'dark' 就只剩 'light' 一条路，
 * 表现为"上次选了深色，重启后界面回到浅色"，而注释还在说已修。
 * 三值偏好 → source 是一一对应的：system→'system'，light/dark→自身。
 */
function applyPersistedTheme() {
  const pref = getThemePreference();
  const source = pref === 'light' || pref === 'dark' ? pref : 'system';
  const theme = applyTheme(resolveThemeFor(pref), { source, broadcast: false });
  /*
    即使不广播，也要把 lastTheme 记上：
    否则渲染层挂载后自己拉一次 theme:get 得到同样的值，
    下一次系统主题变化时 changed 判定会多推一次（无害但没必要）。
  */
  lastTheme = theme.theme;
  return theme.theme;
}

module.exports = {
  createMainWindow,
  focusMainWindow,
  setQuitting,
  isQuitting,
  /* 关闭行为降级（托盘创建失败时用） */
  setCloseToTray,
  isCloseToTray,
  getMainWindow,
  sendToRenderer,
  /* 窗口状态 */
  emitWindowState,
  toggleMaximize,
  /* 主题 */
  applyTheme,
  resolveTheme,
  resolveThemeFor,
  setThemePreference,
  getThemePreference,
  setFollowSystem,
  initThemeBridge,
  applyPersistedTheme
};
