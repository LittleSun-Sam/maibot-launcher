/*
================================================================================
技术文档：src/renderer/stores/app-store.js
职责：渲染层全局状态与主进程调用的唯一封装层。
================================================================================
  这是原项目问题最集中的文件之一。逐条修正：

  1) 日志重复灌入 + 清空后自动复活（用户最容易撞到的 bug）
     原实现：store.logs 是**单一数组**，LogsPanel 每 3 秒调 loadServiceLogs()
     把后端返回的整批日志**无去重 append** 进同一个数组（上限 1200 条），
     而实时通道 onServiceLogBatch 也在推同样的内容 → 同一份日志被写两遍。
     清空时 clearLogs(key) 又执行 `store.logs = []`（无视 key 清空全部），
     于是：清空 → 3 秒后 400 条日志全量倒灌回来 → 用户以为清空失效。
     现在：按 key 分桶（logsByKey）+ id 去重 + 只清本 key + **取消轮询**，
     实时日志只走 onServiceLogBatch 一条通道。

  2) 【每次启动必崩的隐藏异常】structuredClone 用在 Vue 响应式对象上
     本文件原先有 6 处 `structuredClone(store.xxx)`，其中 store 是 reactive()，
     返回的是 Proxy —— 而 structuredClone **无法克隆 Proxy**，
     必然抛 DataCloneError。用户侧表现为"启动后界面偶发报错/部分面板空白"，
     控制台里只有一句 `[object DOMException]`，极难定位。
     现在：统一走 deepClone()，它先用 toRaw 递归解包代理再结构化克隆，
     并且只在真正无法克隆时才回退 JSON；toPlain() 也不再静默返回 null，
     而是明确告知调用方失败原因。
     （排查过程：为渲染层补上 onerror/unhandledrejection 钩子 + 真实落盘，
       才拿到 `DataCloneError ... AppLayout` 的完整堆栈。）

  3) 事件订阅只加不减（AppLayout 挂载时 subscribeLogs() 的返回函数
     在 onBeforeUnmount 里被漏掉一半），热更新一次叠一层监听。
     现在：集中管理订阅句柄，提供 disposeAll()。

  4) refreshServices() 只在手动调用时更新，服务状态长期陈旧。
     现在：由 useServicePoller 组合式函数统一管理（含页面隐藏时暂停）。
================================================================================
*/
import { reactive, toRaw } from 'vue';
/*
  引导的开关决策抽在 onboarding/gate.js 里（纯函数，可单测）。
  第一版把"别再自动弹"和"永远不能再打开"合并成一个标记，
  导致关一次引导就彻底消失 —— 这类 bug 不报错、只让入口静默消失，
  所以决策逻辑必须有断言守着，详见 scripts/verify-onboarding.mjs。
*/
import { KEYS, readState, decideAutoOpen, decideMode } from '../onboarding/gate.js';

/* ---------------------------------------------------------------- 桥接 */
const api = () => window.maibotApi || {};
const bus = () => window.maibotEvents || {};

/** 每个服务的日志上限 */
const LOG_LIMIT_PER_KEY = 1500;

/* ============================================================================
 *  工具
 * ========================================================================== */

/**
 * 深拷贝一个可能是 Vue 响应式对象的普通数据。
 *
 * 为什么不能直接用 structuredClone：
 *   structuredClone 无法克隆 Proxy。而 Vue 的 reactive() 返回的正是 Proxy，
 *   因此 structuredClone(reactiveObj) 必然抛 DataCloneError。
 *
 * 为什么不直接用 toRaw：
 *   toRaw 只解开**最外层**代理；嵌套对象仍可能是代理，
 *   于是 structuredClone 依旧失败。所以这里先递归解包，再克隆。
 *
 * @param {any} value
 * @returns {any} 深拷贝结果；无法克隆时退回 JSON 往返
 */
export function deepClone(value) {
  const unwrap = (v, depth = 0) => {
    /* 深度上限防御：避免异常数据造成无限递归 */
    if (depth > 64) return null;
    if (v === null || typeof v !== 'object') return v;
    const raw = toRaw(v);
    if (Array.isArray(raw)) return raw.map((item) => unwrap(item, depth + 1));
    /* 只处理纯对象，其它（Date/Map/RegExp 等）交给 structuredClone 处理 */
    if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) {
      return raw;
    }
    const out = {};
    for (const key of Object.keys(raw)) out[key] = unwrap(raw[key], depth + 1);
    return out;
  };

  const plain = unwrap(value);
  try {
    return structuredClone(plain);
  } catch (_) {
    try {
      return JSON.parse(JSON.stringify(plain));
    } catch (e) {
      /* 彻底无法克隆：返回原值，由调用方决定如何处理 */
      return value;
    }
  }
}

/**
 * 把 Vue 响应式对象深度解包为可结构化克隆的普通对象。
 * @returns {{ok:true, value:any}|{ok:false, message:string}}
 */
export function toPlain(value) {
  if (value === null || value === undefined) return { ok: true, value };
  if (typeof value !== 'object') return { ok: true, value };

  try {
    return { ok: true, value: deepClone(value) };
  } catch (e) {
    return { ok: false, message: `参数无法序列化：${e?.message || e}` };
  }
}

/** 判断主进程返回是否为成功结果 */
function isOk(result) {
  return Boolean(result && result.ok !== false);
}

/** 从主进程结果中提取错误消息 */
function errMessage(result, fallback = '操作失败') {
  if (!result) return fallback;
  if (typeof result === 'string') return result;
  return result.message || fallback;
}

/* ============================================================================
 *  状态
 * ========================================================================== */

export const store = reactive({
  /** 应用信息（版本/平台/默认设置/日志路径） */
  info: {
    name: 'MaiBot Launcher',
    version: '',
    platform: '',
    arch: '',
    electron: '',
    node: '',
    chrome: '',
    userData: '',
    logFile: '',
    defaults: null,
    defaultsMeta: null
  },
  /** 已保存的设置 + 编辑草稿 */
  settings: null,
  draft: null,
  /** 托管中的服务列表 */
  services: [],
  /** 扫描到的安装 */
  installations: [],
  /** 扫描状态 */
  scan: { scanning: false, scanId: '', elapsedMs: 0, scannedDirs: 0, truncated: false },
  /** release 列表 */
  releases: [],
  /**
   * 按「来源」分桶的日志。
   *   maibot / snowluma —— 被托管子进程的 stdout/stderr
   *   launcher          —— 启动器自身的日志（主进程 + 渲染层上报）
   */
  logsByKey: { maibot: [], snowluma: [], launcher: [] },
  /**
   * 日志区只看哪个来源（双击顶部「日志」的胶囊切换）。
   *   null        —— 所有来源按时间合并成一条流（默认）
   *   'maibot' / 'snowluma' —— 只看该来源
   * 放在 store 而不是 LogsPanel 里，是因为切换入口在外壳、消费在页面 ——
   * 放页面里就得靠 query 参数或 provide/inject 绕一圈。
   */
  logsFocus: null,
  /** 日志自增 id */
  logSeq: 0,
  /** 启动器日志的落盘路径（用于界面提示与「打开日志目录」） */
  appLogFile: '',
  /** 一次性的界面提示（服务异常退出等） */
  alerts: [],
  /** 路径信息 */
  paths: null,
  /**
   * 新手引导（右侧抽屉）。
   *
   * ⚠️ 「不要再自动弹」和「永远不能再打开」是两件事，别合并成一个标记 ——
   * 合并之后用户点一次关闭就再也找不到引导了（第一版就是这个 bug）。
   *
   *   onboardingOpen       当前抽屉是否可见（任何时刻都能点开）
   *   onboardingGuideMode  true=可勾选的交互式引导；false=只读参考资料
   *   onboardingTotal     总步骤数（顶栏进度徽标用）
   *   onboardingDoneCount 已完成步骤数
   *
   * 是否**自动**展开由 initOnboarding() 决定（只看 autoOpened 标记）。
   * 手动入口是顶栏那个常驻按钮，不依赖任何标记。
   */
  onboardingOpen: false,
  onboardingGuideMode: true,
  onboardingTotal: 0,
  onboardingDoneCount: 0,
  /** 终端能力信息 */
  terminal: { backend: 'unknown', ptyAvailable: false, shells: [], note: '' },
  /**
   * 启动器**自身**的更新状态。
   *
   * 为什么放在全局 store 而不是弹窗组件内部：
   *   下载是长任务，用户中途可能把弹窗关掉再打开看进度（甚至切到别的页）。
   *   状态挂在组件里的话，一关窗就丢，再打开会显示"已是最新"或回到第一屏，
   *   而主进程那边的下载**还在跑** —— 界面与实际彻底脱节。
   *   放在 store 里，弹窗只是这份状态的一个视图。
   *
   * phase 取值与含义（与 services/updater.js 的 PHASE 对齐）：
   *   idle        还没检查过
   *   checking    正在检查
   *   available   有新版本，等用户点「更新」
   *   latest      已是最新版本
   *   error       检查失败（message 是真实原因，比如"未配置更新源"）
   *   downloading 正在下载（percent/bytesPerSec/etaSec/channel 有真实值）
   *   ready       下载完成且字节数校验通过，等用户点「重启并安装」
   *   install-failed 安装没启动成功（message 说明原因）
   */
  update: {
    phase: 'idle',
    current: '',
    latest: '',
    configured: true,
    hasUpdate: false,
    notes: '',
    publishedAt: '',
    asset: null,
    message: '',
    /* 下载进度（真实值；未知时保持 null，界面就不显示，而不是编一个数） */
    received: 0,
    total: 0,
    percent: 0,
    bytesPerSec: 0,
    etaSec: null,
    channel: '',
    /* 每个失败通道的真实原因，界面会逐条列出来 */
    attempts: [],
    /*
     * 检查结果的"时间戳"（缓存用）。
     *
     * 为什么这两项在 store 里而不是组件里：
     *   缓存要跨越"关窗再开窗"（组件是 v-if 挂载/卸载的），
     *   挂在组件里的话每次开窗都会重来一次，缓存等于没有。
     *
     * fetchedAt —— 真正打网络的那一次完成的时刻（毫秒时间戳）。
     *              它是缓存 TTL 的唯一依据；**从来不会被"读缓存"改写**，
     *              否则每读一次缓存 TTL 就被续一次，缓存永远不会过期。
     * checkedAt —— 界面**显示**用的时刻。读缓存时它保持原值，
     *              所以用户看到的永远是"真正查过的那一次"的时间，
     *              不会把"刚打开窗口"误报成"刚查过"。
     * fromCache —— 当前显示的结果是否来自缓存（界面要如实标注）。
     */
    fetchedAt: 0,
    checkedAt: 0,
    fromCache: false
  }
});

/* 便捷读取器 */
export function logsOf(key) {
  return store.logsByKey[key] || [];
}

/** 日志来源的合法取值（与 logsByKey 的桶一一对应，见 focusLogs） */
const LOG_FOCUS_KEYS = ['maibot', 'snowluma'];

/**
 * 设置日志区只看哪个来源。传 null / 未知值 = 恢复"全部来源合并"。
 * 之所以在这里收口而不是让调用方直接写 store.logsFocus：
 * 合法取值是固定的几个 key，写错一个字（比如 'MaiBot'）会让日志区过滤出空流，
 * 界面上看起来就是"日志没了"。
 * @param {'maibot'|'snowluma'|null} key
 */
export function focusLogs(key) {
  store.logsFocus = LOG_FOCUS_KEYS.includes(key) ? key : null;
  return store.logsFocus;
}

/* ============================================================================
 *  应用信息与路径
 * ========================================================================== */

export async function loadAppInfo() {
  const r = await safeInvoke('appInfo');
  if (isOk(r)) store.info = { ...store.info, ...r };
  return store.info;
}

export async function loadPaths() {
  const r = await safeInvoke('getMaibotPaths');
  if (isOk(r)) store.paths = r;
  return store.paths;
}

/** 统一的调用包装：捕获异常并转为结构化结果，绝不抛给调用方 */
async function safeInvoke(method, ...args) {
  const fn = api()[method];
  if (typeof fn !== 'function') {
    return { ok: false, message: `桥接方法不存在: ${method}` };
  }
  try {
    return await fn(...args);
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

export { safeInvoke };

/* ============================================================================
 *  设置
 * ========================================================================== */

export async function loadSettings() {
  const r = await safeInvoke('getBackendSettings');
  if (isOk(r) && r.llm) {
    store.settings = deepClone(r);
  } else {
    /* 兜底：使用主进程随 appInfo 下发的默认值，避免前端硬编码副本 */
    store.settings = store.info.defaults ? deepClone(store.info.defaults) : {};
  }
  store.draft = deepClone(store.settings);
  return store.settings;
}

/** 放弃草稿，恢复为已保存的设置 */
export function discardDraft() {
  if (store.settings) store.draft = deepClone(store.settings);
}

/**
 * 保存草稿。
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
export async function applySettings() {
  const plain = toPlain(store.draft);
  if (!plain.ok) return { ok: false, message: plain.message };

  const r = await safeInvoke('saveBackendSettings', plain.value || {});
  if (isOk(r)) {
    store.settings = deepClone(r.settings || plain.value);
    store.draft = deepClone(store.settings);
    return { ok: true, message: '设置已保存' };
  }
  return { ok: false, message: errMessage(r, '保存失败') };
}

export async function resetSettings() {
  const r = await safeInvoke('resetBackendSettings');
  if (isOk(r)) {
    store.settings = deepClone(r.settings);
    store.draft = deepClone(r.settings);
    return { ok: true, message: '已恢复默认设置' };
  }
  return { ok: false, message: errMessage(r, '重置失败') };
}

/** 导出设置到指定路径 */
export async function exportSettings(destPath) {
  const r = await safeInvoke('exportBackendSettings', destPath);
  return isOk(r) ? { ok: true, path: r.path, message: r.message || '已导出' } : { ok: false, message: errMessage(r) };
}

/**
 * 稳定序列化：先递归按键名排序，再 JSON.stringify。
 *
 * 为什么不能直接 JSON.stringify 比较：键序取决于**属性插入顺序**。
 * 而 store.draft 是 ensureDraft() 用 deepMerge 把 defaults 并进来的产物，
 * store.settings 则是主进程回写的对象 —— 两者值完全相同，键序却可能不同，
 * 于是"刚进设置页、一个字都没改"也会被判成脏。
 * 后果不只是"应用"按钮亮着：上一轮给设置页加的「未保存就离开」拦截
 * 会因此误报，用户什么都没动却被弹窗问一次，久了就会习惯性点确定，
 * 那时拦截就彻底失效了 —— 狼来了比没有狼更糟。
 */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
      .join(',') +
    '}'
  );
}

/** 当前草稿是否与已保存设置不同 */
export function isDirty() {
  if (!store.settings || !store.draft) return false;
  try {
    return stableStringify(store.settings) !== stableStringify(store.draft);
  } catch (_) {
    return true;
  }
}

/* ============================================================================
 *  服务 / 进程
 * ========================================================================== */

/*
  服务状态请求序号。

  为什么必须有序号：
    AppLayout 有 8 秒兜底轮询，且 6 个服务事件回调都会各自调一次本函数，
    startService / stopService / cleanupZombies 内部也会再调一次 ——
    任意时刻都可能有多路并发在途。而这里原来是直接
    `store.services = ...`，**先发的慢响应会覆盖后发的快响应**。
    典型表现：点了「停止」并已成功，界面却短暂（甚至持续到下次轮询）
    显示"仍在运行"，因为一个更早发起的查询此刻才返回。
  只让**最新一次**请求有权写 store。
*/
let servicesReqSeq = 0;

export async function refreshServices() {
  const seq = ++servicesReqSeq;
  const r = await safeInvoke('getServicesStatus');
  const list = Array.isArray(r) ? r : [];
  if (seq !== servicesReqSeq) {
    /* 已有更新的请求在途：丢弃这次结果，但把最新值返回给调用方 */
    return store.services;
  }
  store.services = list;
  return store.services;
}

export function serviceOf(key) {
  return store.services.find((s) => s.key === key) || { key, running: false };
}

export async function startService(payload) {
  const plain = toPlain(payload);
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('startService', plain.value);
  await refreshServices();
  return isOk(r) ? r : { ok: false, message: errMessage(r, '启动失败') };
}

export async function stopService(key) {
  const r = await safeInvoke('stopService', key);
  await refreshServices();
  return isOk(r) ? r : { ok: false, message: errMessage(r, '停止失败') };
}

export async function sendServiceInput(key, text) {
  return safeInvoke('sendServiceInput', key, text);
}

/**
 * 手动重启单个服务（主进程侧一次原子操作：停干净 → 再启动）。
 * @param {string} key
 * @param {object} [payload] 可选，覆盖主进程推导的启动参数
 */
export async function restartService(key, payload) {
  const body = { key };
  if (payload) {
    const plain = toPlain(payload);
    if (plain.ok) body.payload = plain.value;
  }
  const r = await safeInvoke('restartService', body.key, body.payload);
  await refreshServices();
  return isOk(r)
    ? { ok: true, key, pid: r.pid, message: r.message || '已重启' }
    : { ok: false, key, stage: r?.stage, message: errMessage(r, '重启失败') };
}

export async function checkPorts(ports) {
  const plain = toPlain(ports);
  if (!plain.ok) return [];
  const r = await safeInvoke('checkPorts', plain.value || []);
  return Array.isArray(r) ? r : [];
}

/**
 * 探测某个端口上是否**真的有服务在监听**。
 *
 * 主进程的 service:check-ports 语义是「能否 bind」——
 * inUse=true 表示端口被占用（也就是有服务在监听）。
 * 这里把它翻译成更直白的 open 布尔值，避免调用方去记 inUse 的反向含义。
 *
 * @param {number} port
 * @returns {Promise<boolean>} 探测过程出错时返回 false（宁可提示"没起来"）
 */
export async function isPortOpen(port) {
  const n = Number(port);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return false;
  const results = await checkPorts([n]);
  const hit = Array.isArray(results) ? results.find((r) => Number(r?.port) === n) : null;
  return Boolean(hit?.inUse);
}

/* ============================================================================
 *  新手引导的环境探测
 * --------------------------------------------------------------------------
 *  这些只返回事实，**不判断"这步算不算完成"**。
 *  完成状态由用户在引导里自己点击确认 —— 自动打勾会制造
 *  "看起来配好了"的假象，而那正是这个项目一直要消灭的东西。
 * ========================================================================== */

/** 判定目录是 MaiBot / SnowLuma / 都不是（与"扫描常见目录"用同一套特征） */
export async function detectDirKind(dir) {
  const r = await safeInvoke('envDetectKind', String(dir || ''));
  if (!isOk(r)) {
    return { ok: false, kind: 'unknown', message: errMessage(r, '目录判定失败') };
  }
  return r;
}

/** 一次性汇总引导所需的全部环境事实 */
export async function detectAll() {
  const r = await safeInvoke('envDetectAll');
  if (!isOk(r)) {
    return { ok: false, message: errMessage(r, '环境探测失败') };
  }
  return r;
}

/**
 * MaiBot 版本识别 —— 本项目此前的最大盲区。
 *
 * 官方 SnowLuma 适配器只支持 MaiBot ≥ 1.2.0；0.6.x 是完全不同的
 * 架构（配置字段、适配器形态、WebSocket 方向、依赖数据库都不同）。
 * 判错版本会让用户「每一步都照做了却永远连不上」。
 */
export async function detectMaiBotVersion(dir) {
  const r = await safeInvoke('envDetectMaibotVersion', String(dir || ''));
  if (!isOk(r)) {
    return { ok: false, kind: 'unknown', evidence: [], message: errMessage(r, '版本识别失败') };
  }
  return r;
}

/** 工具链：Python 3.12+ / Git / uv */
export async function detectTools(pythonExe) {
  const r = await safeInvoke('envDetectTools', String(pythonExe || ''));
  if (!isOk(r)) {
    return { ok: false, message: errMessage(r, '工具链检测失败') };
  }
  return r;
}

/** MaiBot 的 WebUI 登录 Token（从它的启动日志里读，只读不写） */
export async function maibotWebuiToken() {
  const r = await safeInvoke('maibotWebuiToken');
  if (!isOk(r)) {
    return { ok: false, token: '', message: errMessage(r, '读取 WebUI Token 失败') };
  }
  return r;
}

/* ============================================================================
 *  新手引导的开关逻辑
 * --------------------------------------------------------------------------
 *  ⚠️ 这里有两个**必须分开**的概念，混在一起就会出 bug：
 *
 *      「不要再自动弹了」  ≠  「永远不能再打开了」
 *
 *    第一版就是把它们合成一个 dismissed 标记，后果是用户点一次关闭，
 *    引导就彻底消失了 —— 只有一个右下角小浮动按钮，很不显眼，
 *    想照着教程走一遍的人根本找不到。
 *
 *    现在的模型：
 *      · onboardingAutoOpened —— 只记录"首次启动是否已经自动展开过"，
 *        仅用于决定要不要**自动**弹。关掉它不影响手动打开。
 *      · onboardingOpen       —— 抽屉当前是否可见，任何时候都能被点开。
 *      · 常驻入口：顶栏「新手引导」按钮（一直存在，带完成进度）。
 *
 *    参考过 MaiBot OneKey（GPL-3.0-only）的做法：它用
 *    localStorage 'maibot-startup-wizard-seen' 记录"看过没"，
 *    但模态框故意做成不可关闭（ignoreWizardOpenChange + preventDefault），
 *    想再看只能「重置启动器 → 清空设置」重载页面。
 *    那个交互对用户不友好，这里**故意不照抄** —— 只借它"用 localStorage
 *    记一次性标志"这个思路，入口做成常驻的。
 *
 *  selfcheck / 探针通过时用标记屏蔽自动展开，否则向导会盖在
 *  8 个路由的断言上（遮罩虽然不吃点击，但节点文本会混进断言内容）。
 * ========================================================================== */

const ONBOARDING_AUTO_OPENED = KEYS.autoOpened;
/** 旧键名，仅用于兼容性清理（第一版用过） */
const ONBOARDING_DISMISSED_LEGACY = KEYS.legacyDismissed;
const ONBOARDING_DONE_IDS = KEYS.doneIds;

function lsGet(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}
function lsSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (_) {
    /* 存不了只影响持久化 */
  }
}
function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {
    /* 忽略 */
  }
}

/** 测试/自检环境：不自动展开向导，避免干扰路由断言 */
function onboardingSuppressed() {
  try {
    /*
      preload 经 contextBridge 暴露的自检标记（window.maibotApi.isSelfcheck）。
      必须走桥、不能读 globalThis.__DSH_ONBOARDING_SUPPRESS__：
      contextIsolation:true 下 preload 是**隔离世界**，它设的 globalThis
      与页面世界的 window 是两个对象，页面里那个属性恒为 undefined ——
      以前就是这么写的，于是本函数恒返回 false，自检时引导向导照样自动展开
      并把节点文本混进路由断言（见 preload.js 顶部说明）。
    */
    if (api().isSelfcheck === true) return true;
  } catch (_) {
    /* 忽略 */
  }
  return lsGet(KEYS.suppress) === '1';
}

/** 读当前引导状态（决策逻辑在 onboarding/gate.js，这里只负责取数据） */
function onboardingState(totalSteps) {
  return readState(
    (k) => lsGet(k, ''),
    totalSteps || store.onboardingTotal || 0
  );
}

/** 已完成步骤数（供顶栏进度徽标使用） */
export function onboardingProgress() {
  const s = onboardingState();
  return { doneCount: s.doneCount, doneIds: s.doneIds, allDone: s.allDone };
}

/**
 * 「新手教程」入口的总开关（2026-09-28 按用户要求暂时收起入口）。
 *
 * 注意这里只关**入口**，教程本身一行都没删：步骤定义（onboarding/steps.js）、
 * 抽屉组件（components/onboarding/OnboardingWizard.vue）、进度存储、
 * 重来一遍（replayOnboarding）全都还在。关掉的入口有三处：
 *   ① 标题栏那颗「帮助」pill（AppLayout.vue）
 *   ② 首次启动自动展开（本文件的 initOnboarding）
 *   ③ 安装页部署流程里的「打开新手引导」按钮（InstallerPanel.vue）
 * 三处都读这一个常量，想恢复改回 true 即可，不需要改别的地方。
 */
export const GUIDE_ENTRY_VISIBLE = false;

/**
 * 应用启动时调用一次：决定要不要**自动**展开引导。
 *
 * 只影响"自动"，不影响"手动"。入口开关关闭时（GUIDE_ENTRY_VISIBLE=false），
 * 这里连"自动"也一并关掉 —— 否则用户会在首跑时被推到一个没有入口再打开的抽屉里。
 * @param {number} totalSteps 总步骤数（由步骤定义决定）
 */
export function initOnboarding(totalSteps) {
  const total = Number(totalSteps) || 0;
  store.onboardingTotal = total;

  const s = onboardingState(total);
  /* 自检环境额外短路：gate 只认 localStorage 标记，这里补上内存标记 */
  const decision = (GUIDE_ENTRY_VISIBLE && !onboardingSuppressed())
    ? decideAutoOpen(s)
    : { open: false, markAutoOpened: false, reason: GUIDE_ENTRY_VISIBLE ? 'suppressed' : 'entry-hidden' };

  store.onboardingDoneCount = s.doneCount;
  if (decision.markAutoOpened) lsSet(ONBOARDING_AUTO_OPENED, '1');
  if (decision.open) {
    store.onboardingGuideMode = true;
    store.onboardingOpen = true;
  } else {
    store.onboardingOpen = false;
  }
  return { opened: decision.open, reason: decision.reason };
}

/**
 * 用户关掉引导抽屉。
 *
 * 只是把抽屉收起来 —— **不再永久禁用引导**。
 * 右上角「新手引导」按钮随后仍可随时把它打开（就是用户要的"收起后还能展开"）。
 */
export function dismissOnboarding() {
  store.onboardingOpen = false;
  /* 记下"已经自动弹过"，这样下次启动不会又自己蹦出来 */
  lsSet(ONBOARDING_AUTO_OPENED, '1');
  return { ok: true, doneCount: onboardingProgress().doneCount };
}

/**
 * 打开引导抽屉（右上角常驻入口/设置页都走这里）。
 * @param {{mode?:'guide'|'reference'}} [opts]
 */
export function openOnboarding(opts = {}) {
  const s = onboardingState();
  const mode = decideMode(s, opts.mode);
  store.onboardingGuideMode = mode === 'guide';
  store.onboardingOpen = true;
  return { ok: true, guideMode: store.onboardingGuideMode, mode };
}

/** 重走一遍引导：清掉所有进度，从第一步开始 */
export function replayOnboarding() {
  lsRemove(ONBOARDING_AUTO_OPENED);
  lsRemove(ONBOARDING_DISMISSED_LEGACY);
  lsRemove(ONBOARDING_DONE_IDS);
  store.onboardingDoneCount = 0;
  store.onboardingGuideMode = true;
  store.onboardingOpen = true;
  return { ok: true };
}

/**
 * 清理残留进程。
 * @param {{dryRun?:boolean}} [opts] dryRun 时只统计不终止
 */
export async function cleanupZombies(opts = {}) {
  const r = await safeInvoke('cleanupZombies', opts);
  await refreshServices();
  return isOk(r)
    ? { ok: true, found: r.found || 0, killed: r.killed || 0, message: r.message }
    : { ok: false, found: 0, killed: 0, message: errMessage(r, '清理失败') };
}

/**
 * 语法糖：旧组件使用 killZombie 这个命名。
 * 保留别名以免旧调用点直接失败，实际行为与 cleanupZombies 一致。
 */
export const killZombie = cleanupZombies;

/**
 * 导出设置为 JSON 文件。
 * 与 exportSettings 的区别：本函数直接接收目标路径（不做对话框）。
 */
export async function exportBackendSettings(destPath) {
  return exportSettings(destPath);
}

/**
 * 依据当前设置构造启动载荷（**渲染层兜底版**）。
 *
 * ⚠️ 这只是一个降级路径，不是主路径。
 *    真正生效的是主进程的 process.buildStartPayload —— 它能真的探测目录与入口，
 *    而这里只能看设置里的字符串。两处曾各自演化出不同的 bug：
 *      · 主进程写死 args:['main.py']，而 MaiBot 从来没有 main.py
 *      · 这里也写死 args:['main.py']（**同一个 bug 的第二份**）
 *      · 这里还写死过端口 6199（那是 AstrBot 的反向 WS 端口，与本项目无关）
 *    所以：能拿到主进程结果时就不要用这里（见 resolvePayload）。
 *    这里只保证"别编出一个明显错的命令"。
 *
 * @param {'maibot'|'snowluma'} key
 * @param {'draft'|'settings'} [source] 用草稿还是已保存设置
 * @returns {{key:string, command:string, args?:string[], cwd:string, readyPort:number}|null}
 */
export function buildStartPayload(key, source = 'draft') {
  const cfg = (source === 'draft' ? store.draft : store.settings) || store.settings || {};
  const svc = cfg.service || {};
  const ports = svc.ports || {};

  /*
    端口兜底值必须来自主进程下发的 defaults，**不能写死字面量**。
    这里原来写死 `|| 6199`，还导致同一份默认值散落在
    constants.js / process.js / 本文件三处，改对一处也修不好。
    现在统一以 store.info.defaults 为唯一来源。
  */
  const defPort = (k) => {
    const n = Number(store.info?.defaults?.service?.ports?.[k]);
    return Number.isFinite(n) ? n : null;
  };

  if (key === 'snowluma') {
    const dir = String(svc.snowlumaDir || '').trim();
    if (!dir) return null;
    const slPorts = svc.snowlumaPorts || {};
    const slDef = store.info?.defaults?.service?.snowlumaPorts || {};
    const sep = dir.includes('\\') ? '\\' : '/';
    return {
      key: 'snowluma',
      /* 自带 node.exe 是完整包的标志；没有就用系统 node（与主进程一致） */
      command: dir + sep + 'node.exe',
      args: ['index.mjs'],
      cwd: dir,
      readyPort: Number(slPorts.webui) || Number(slDef.webui) || null
    };
  }

  const dir = String(svc.maibotDir || '').trim();
  if (!dir) return null;
  /*
    ⚠️ 入口用 bot.py，**不是 main.py**。
    MaiBot 从来没有 main.py：官方文档的源码部署写的是 `uv run bot.py`，
    实际仓库与用户安装目录里也只有 bot.py。原先这里写死 main.py，
    python 会直接报 "can't open file 'main.py'" 并退出，
    而界面上显示的是"启动失败"却指不到原因。
    渲染层无法列目录，所以这里只能用这个已知正确的默认值；
    真正精确的探测在主进程侧。
  */
  return {
    key: 'maibot',
    command: String(svc.pythonPath || 'python').trim() || 'python',
    args: ['bot.py'],
    cwd: dir,
    readyPort: Number(ports.maibot) || defPort('maibot')
  };
}

/* ============================================================================
 *  安装扫描
 * ========================================================================== */

export async function scanInstallations(roots) {
  store.scan.scanning = true;
  store.scan.scanId = `scan_${Date.now().toString(36)}`;
  try {
    const payload = { scanId: store.scan.scanId };
    if (Array.isArray(roots) && roots.length) payload.roots = roots;

    const r = await safeInvoke('scanInstallations', payload);
    if (isOk(r)) {
      store.installations = Array.isArray(r.installations) ? r.installations : [];
      store.scan.elapsedMs = r.elapsedMs || 0;
      store.scan.scannedDirs = r.scannedDirs || 0;
      store.scan.truncated = Boolean(r.truncated);
      return { ok: true, count: store.installations.length, ...r };
    }
    return { ok: false, message: errMessage(r, '扫描失败') };
  } finally {
    store.scan.scanning = false;
  }
}

/** 取消正在进行的扫描 */
export async function cancelScan() {
  if (!store.scan.scanId) return { ok: false, message: '当前没有进行中的扫描' };
  const r = await safeInvoke('cancelScan', store.scan.scanId);
  return isOk(r) ? { ok: true } : { ok: false, message: errMessage(r) };
}

export async function getDefaultScanRoots() {
  const r = await safeInvoke('getDefaultScanRoots');
  return Array.isArray(r) ? r : [];
}

/* ============================================================================
 *  GitHub / 安装
 * ========================================================================== */

export async function loadReleases(repo, perPage = 30) {
  const r = await safeInvoke('getGithubReleases', repo, perPage);
  if (isOk(r)) {
    store.releases = Array.isArray(r.releases) ? r.releases : [];
    return { ok: true, repo: r.repo, count: store.releases.length };
  }
  store.releases = [];
  return { ok: false, message: errMessage(r, '获取版本失败') };
}

export async function downloadAsset(opts) {
  const plain = toPlain(opts);
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('downloadAsset', plain.value);
  return isOk(r) ? r : { ok: false, message: errMessage(r, '下载失败') };
}

export async function installMaiBot(opts) {
  const plain = toPlain(opts);
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('installMaiBot', plain.value);
  return isOk(r) ? r : { ok: false, message: errMessage(r, '安装失败') };
}

export async function upgradeMaiBot(opts) {
  const plain = toPlain(opts);
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('upgradeMaiBot', plain.value);
  return isOk(r) ? r : { ok: false, message: errMessage(r, '升级失败') };
}

/**
 * 适配器插件检测（接线的"插件那半边"）。
 *
 * opts 可省略，也可以只给 { dir }：主进程会自己从设置里取 maibotDir。
 * 「接线」的另一半（SnowLuma 上那个 OneBot 正向 WS 服务器）只能在
 * SnowLuma 自己的 WebUI 里由用户现建，启动器没有可靠落点去读它，
 * 所以那一半靠端口探测 + 指引，检测不了就说检测不了。
 */
export async function detectAdapter(opts) {
  const plain = toPlain(opts || {});
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('detectAdapter', plain.value);
  return isOk(r) ? r : { ok: false, message: errMessage(r, '适配器检测失败') };
}

/**
 * 下载安装 SnowLuma（现在唯一的 QQ 协议端：独立 Node 程序，不注入 QQ 进程）。
 *
 * opts 可省略：不传 targetDir 时由主进程用它自己的工作目录，
 * 所以这里要先把 undefined 补成 {} —— toPlain(undefined) 会判为非法入参，
 * 那样"一键下载"按钮点下去会直接失败在参数校验上。
 */
export async function installSnowluma(opts) {
  const plain = toPlain(opts || {});
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('installSnowluma', plain.value);
  return isOk(r) ? r : { ok: false, message: errMessage(r, 'SnowLuma 安装失败') };
}

/**
 * 列出某个安装目录旁边的升级备份。
 * @param {string} installDir
 * @returns {Promise<{ok:boolean, backups:Array}>}
 */
export async function listBackups(installDir) {
  if (!installDir) return { ok: true, backups: [] };
  const r = await safeInvoke('listBackups', installDir);
  return isOk(r) ? { ok: true, backups: Array.isArray(r.backups) ? r.backups : [] } : { ok: false, backups: [], message: errMessage(r, '无法读取备份列表') };
}

/** 清理升级备份（dryRun 只统计不删除） */
export async function cleanBackups({ installDir, paths, dryRun = false } = {}) {
  const r = await safeInvoke('cleanBackups', { installDir, paths, dryRun });
  /*
    修正：原来丢掉了主进程返回的 failed[]（github.js:1031-1039 会给出每项的失败原因），
    调用方只看得到 ok:false 和一句概括，无从知道"哪个备份没删掉、为什么"。
  */
  return isOk(r)
    ? {
        ok: true,
        removed: r.removed || [],
        failed: Array.isArray(r.failed) ? r.failed : [],
        freedBytes: r.freedBytes || 0,
        message: r.message || ''
      }
    : {
        ok: false,
        removed: [],
        failed: Array.isArray(r?.failed) ? r.failed : [],
        freedBytes: 0,
        message: errMessage(r, '清理失败')
      };
}

/**
 * 把一个备份目录还原成"当前使用的安装"。
 * 主进程（github.restoreBackup）会重新校验：备份确实是一套麦麦安装、
 * 麦麦没有在运行、路径在受管根内部、命名符合备份规则；并把当前版本
 * 先另存为新备份再原子交换，失败自动回滚。返回里带交换明细与新备份名。
 * @param {string} path 备份目录
 * @returns {Promise<{ok:boolean, message:string, restoredFrom?:string, restoredTo?:string,
 *                    newBackupDir?:string, swapped?:Array, elapsedMs?:number, deniedReason?:string}>}
 */
export async function restoreBackup(path) {
  const target = typeof path === 'string' ? path.trim() : '';
  if (!target) return { ok: false, message: '未指定要还原的备份目录' };
  const r = await safeInvoke('restoreBackup', { path: target });
  return isOk(r) ? r : { ok: false, ...(r || {}), message: errMessage(r, '还原失败') };
}

/**
 * 探测一批候选目录是否已存在及是否有内容（只读）。
 * 安装前用它判断 <targetDir>/maibot|snowluma 是否会被主进程永久删除。
 * @param {string[]} dirs
 * @returns {Promise<{ok:boolean, results:Array<{path:string,exists:boolean,empty:boolean,fileCount:number}>, sep:string}>}
 */
export async function probeDirs(dirs) {
  const list = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d.trim()) : [];
  if (!list.length) return { ok: true, results: [], sep: '\\' };
  const r = await safeInvoke('probeDirs', list);
  return isOk(r)
    ? { ok: true, results: Array.isArray(r.results) ? r.results : [], sep: r.sep || '\\' }
    : { ok: false, results: [], sep: '\\', message: errMessage(r, '无法探测目标目录') };
}

/* ============================================================================
 *  受管麦麦版本（列出 / 真删除）
 * ---------------------------------------------------------------------------
 *  事实依据（见 src/main/services/versions.js 顶部的技术文档）：
 *  本启动器**没有** versions/<tag> 的多版本布局，磁盘上"同时躺着多份麦麦"
 *  只来自启动器自己的升级备份（<installDir>.backup-<时间戳>）与安装残留
 *  （<installDir>.old-<时间戳>），加上受管父目录里同级的其它麦麦副本。
 *  所以这里列的是**磁盘事实**，不是编出来的版本号清单。
 *
 *  返回值里 deletable / reason 由主进程给出（它是唯一权威）；
 *  渲染层只负责把它呈现出来 —— 真正的硬性拒绝在主进程侧。
 * ========================================================================== */

/**
 * 列出受管版本（当前使用的 + 备份 + 同级副本）。
 * @returns {Promise<{ok:boolean, versions:Array, activePath:string, running:object, managedRoots:string[], message:string}>}
 */
export async function listManagedVersions() {
  const r = await safeInvoke('listManagedVersions');
  if (!isOk(r)) {
    return {
      ok: false,
      versions: [],
      activePath: '',
      running: { running: false, pid: null, cwd: '' },
      managedRoots: [],
      message: errMessage(r, '无法读取已安装版本')
    };
  }
  return {
    ok: true,
    versions: Array.isArray(r.versions) ? r.versions : [],
    activePath: r.activePath || '',
    activeExists: Boolean(r.activeExists),
    running: r.running || { running: false, pid: null, cwd: '' },
    managedRoots: Array.isArray(r.managedRoots) ? r.managedRoots : [],
    message: r.message || ''
  };
}

/**
 * 真删一个受管版本目录。
 * 主进程会重新校验受管根 / 目录身份 / 是否正在使用或运行，越界一律拒绝；
 * 失败时带上原文错误（被占用等），这里原样向调用方上报，绝不改成成功。
 * @param {string} dir
 * @returns {Promise<{ok:boolean, message:string, path?:string, version?:string, freedBytes?:number, userDataItems?:string[]}>}
 */
export async function deleteManagedVersion(dir) {
  const target = typeof dir === 'string' ? dir.trim() : '';
  if (!target) return { ok: false, message: '未指定要删除的版本目录' };
  const r = await safeInvoke('deleteManagedVersion', target);
  return isOk(r)
    ? {
        ok: true,
        path: r.path || target,
        kind: r.kind || '',
        version: r.version || '',
        userDataItems: Array.isArray(r.userDataItems) ? r.userDataItems : [],
        freedBytes: Number(r.freedBytes) || 0,
        message: r.message || '已删除'
      }
    : { ok: false, path: target, freedBytes: 0, message: errMessage(r, '删除失败') };
}

export function subscribeDownload(label, cb) {
  const fn = bus().onDownloadProgress;
  if (typeof fn !== 'function') return () => {};
  return fn(label, cb) || (() => {});
}

/* ============================================================================
 *  启动器自身的更新
 * --------------------------------------------------------------------------
 *  与上面 github:* 的区别（很容易混，写错就会"检查的是别的项目"）：
 *    github:*  —— 被管理的服务（MaiBot / SnowLuma）的安装升级
 *    下面这些 —— 把**启动器自己**换成新版本
 *  所以更新源、附件落点、安装方式全都是另一套，由主进程 services/updater.js
 *  负责，渲染层只做展示与转发。
 * ========================================================================== */

/*
  这里原来有一个 resetUpdateState()：检查前把整个 update 清成 idle。
  现在**刻意删掉**，因为"清成 idle"会连 fetchedAt/checkedAt 一起清掉 ——
  而那两个时间戳是"上次检查时间"的唯一依据，清掉就等于：
  用户刚看到过一次"上次检查：20:33"，一点「重新检查」那行时间就消失了。
  现在改成在 checkLauncherUpdate 里只清**结论字段**（phase/hasUpdate/notes/
  asset/message/…），历史时间戳一律保留。
*/

/**
 * 检查结果的缓存有效期。
 *
 * 为什么放在渲染层、而不写进 src/main/constants.js：
 *   TTL 是**界面策略**（"用户反复开关窗口时别每次都打网络"），
 *   不是主进程的更新源配置；主进程只负责"真的去查一次"。
 *   放渲染层还有一个直接原因：main/constants.js 是与另一路并行修改的文件，
 *   把界面策略塞进去既越界又会制造冲突。
 *
 * 6 分钟：GitHub Releases 的更新不是秒级事件，用户在一个会话里反复开关
 * 那个二级窗口的时间尺度就是几分钟；超过这个尺度再自动打一次网络是合理的。
 * 想要立刻拿最新结果，用户可以点「重新检查」（force）——那是明确意图。
 */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 1000;

/**
 * 缓存是否仍然可用。
 *
 * 三个条件缺一不可，每一条都对应一类"看起来对、其实错"的结果：
 *   · phase 有结论（idle/checking 时没有可复用的结果）；
 *   · 上一次不是失败（错误提示是当时那一刻的事实，缓存它就等于把
 *     一个可能早就恢复的故障钉在界面上 —— 失败一律立刻重试）；
 *   · fetchedAt 在 TTL 之内。**用 fetchedAt 而不是 checkedAt**：
 *     checkedAt 是显示用的时刻，拿它算 TTL 会让"读一次缓存"续一次命。
 */
function isUpdateResultFresh(now = Date.now()) {
  const u = store.update;
  if (!u.fetchedAt) return false;
  if (u.phase !== 'available' && u.phase !== 'latest') return false;
  if (u.configured === false) return false;
  return now - u.fetchedAt < UPDATE_CHECK_TTL_MS;
}

/** 把一次**真实网络检查**的结果落到 store（缓存判定与它无关，只负责写） */
function applyUpdateResult(r, now) {
  store.update.current = r.current || store.info.version || '';
  store.update.latest = r.latest || '';
  store.update.configured = r.configured !== false;
  store.update.notes = r.notes || '';
  store.update.publishedAt = r.publishedAt || '';
  store.update.asset = r.asset || null;
  store.update.message = r.message || '';
  /* 这次真的打过网络：两个时间戳一起落 */
  store.update.fetchedAt = now;
  store.update.checkedAt = now;

  if (r.ok !== true) {
    store.update.phase = 'error';
    store.update.hasUpdate = false;
    return;
  }
  store.update.hasUpdate = Boolean(r.hasUpdate);
  store.update.phase = r.hasUpdate ? 'available' : 'latest';
}

/**
 * 检查启动器更新（**带缓存**）。
 *
 * 关键：**把主进程给的真实原因原样带出去**。
 * 三种结局必须能被界面区分开，它们的用户动作完全不同：
 *   · configured:false → 更新源还没配置好（去填仓库地址，重试没有用）
 *   · ok:false 其它     → 网络 / 限流 / 仓库不存在（message 里有具体原因）
 *   · ok:true           → 有新版或已是最新
 * 统一成一句"检查失败"会让第一种情况的用户永远在点重试。
 *
 * 缓存语义（这是"每次打开都重新请求"的修法）：
 *   · 默认（force=false）：TTL 内**直接返回上次结果**，一个字节的网络都不打，
 *     并把 fromCache 置 true，界面据此如实标注"上次检查时间/缓存"；
 *   · force=true（「重新检查」按钮 / 用户明确要求）：无论多新都真的再查一次。
 *
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<object>} store.update 的快照
 */
export async function checkLauncherUpdate(opts = {}) {
  const force = opts.force === true;
  const now = Date.now();

  if (!force && isUpdateResultFresh(now)) {
    /* 复用缓存：时间戳一个字都不改 —— 界面显示的必须是真正查过的那一次 */
    store.update.fromCache = true;
    return { ...store.update };
  }
  store.update.fromCache = false;

  if (store.update.phase !== 'checking') {
    /*
      置 checking 之前先清掉上一次的**结论**（避免旧版本号/旧说明残留在屏幕上），
      但**不清 fetchedAt/checkedAt**：那两个是"历史事实"，清掉就没法显示
      "上次检查时间"了。
    */
    Object.assign(store.update, {
      phase: 'checking',
      configured: true,
      hasUpdate: false,
      notes: '',
      publishedAt: '',
      asset: null,
      message: ''
    });
  }

  const r = await safeInvoke('checkLauncherUpdate');
  if (!r || typeof r !== 'object') {
    store.update.phase = 'error';
    store.update.message = '检查更新失败：主进程没有返回结果（可能是桥接方法缺失）';
    return { ...store.update };
  }

  applyUpdateResult(r, now);
  return { ...store.update };
}

/**
 * 强制重新检查（语义糖，给「重新检查」按钮用）。
 * @returns {Promise<object>} store.update 的快照
 */
export function recheckLauncherUpdate() {
  return checkLauncherUpdate({ force: true });
}

/**
 * 下载更新安装包。
 * 进度由主进程经 update-progress 推送（见 subscribeLauncherUpdateProgress），
 * 这里的返回值只表示**最终结果**（成功 / 全部通道失败 / 用户取消）。
 *
 * @param {{asset?:object}} [opts]
 * @returns {Promise<{ok:boolean, canceled?:boolean, message:string, channel?:string, bytes?:number}>}
 */
export async function downloadLauncherUpdate(opts = {}) {
  const plain = toPlain(opts);
  if (!plain.ok) return { ok: false, message: plain.message };

  store.update.phase = 'downloading';
  store.update.received = 0;
  store.update.percent = 0;
  store.update.bytesPerSec = 0;
  store.update.etaSec = null;
  store.update.attempts = [];
  store.update.channel = '';
  store.update.total = Number(store.update.asset?.size) || 0;

  const r = await safeInvoke('downloadLauncherUpdate', plain.value || {});

  if (r?.ok === true) {
    store.update.phase = 'ready';
    store.update.percent = 100;
    store.update.received = Number(r.bytes) || store.update.total;
    store.update.channel = r.channel || '';
    store.update.message = r.message || '下载完成，已校验字节数';
    return { ok: true, message: store.update.message, channel: store.update.channel, bytes: r.bytes };
  }

  store.update.attempts = Array.isArray(r?.attempts) ? r.attempts : [];
  if (r?.canceled) {
    /*
      取消是用户自己的选择，不是故障：回到"有新版本"这一屏，
      保留 message 说明"已取消"，但 phase 不置 error ——
      否则界面会把一次正常取消渲染成红色失败。
    */
    store.update.phase = 'available';
    store.update.percent = 0;
    store.update.received = 0;
    store.update.message = r.message || '下载已取消';
    return { ok: false, canceled: true, message: store.update.message };
  }

  store.update.phase = 'error';
  store.update.message = errMessage(r, '下载失败');
  return { ok: false, message: store.update.message, attempts: store.update.attempts };
}

/** 取消进行中的下载 */
export async function cancelLauncherUpdate() {
  const r = await safeInvoke('cancelLauncherUpdate');
  return isOk(r) ? { ok: true, message: r.message || '已请求取消' } : { ok: false, message: errMessage(r) };
}

/**
 * 启动已下载的安装包并退出启动器。
 *
 * ⚠️ 这个函数一旦成功，**本进程就会退出** —— 调用方不要指望它返回后再做别的事，
 *    但必须等在返回之后再提示用户"即将退出"（主进程刻意把 app.quit 排在这一帧之后）。
 *    dest 传的是刚下载的那个路径；主进程会重新校验它（临时目录内 + 本会话校验过）。
 *
 * @param {string} [dest]
 */
export async function installLauncherUpdate(dest) {
  const r = await safeInvoke('installLauncherUpdate', dest ? { dest } : {});
  if (r?.ok === true) {
    store.update.phase = 'installing';
    return { ok: true, message: r.message, path: r.path };
  }
  store.update.phase = 'install-failed';
  const message = errMessage(r, '无法启动安装程序');
  store.update.message = message;
  return { ok: false, message };
}

/**
 * 订阅更新进度 / 结果帧。
 * 返回取消函数（与其它 subscribe* 一致），由调用方在自己的作用域里释放。
 * @param {(payload:object)=>void} cb
 */
export function subscribeLauncherUpdateProgress(cb) {
  const fn = bus().onUpdateProgress;
  if (typeof fn !== 'function') return () => {};
  return trackDisposer(
    fn((payload) => {
      if (!payload || typeof payload !== 'object') return;
      applyUpdateProgress(payload);
      cb?.(payload);
    }) || (() => {})
  );
}

/**
 * 把一帧进度落到 store。
 *
 * ⚠️ 只有**下载成功帧**才允许把 phase 置为 ready。
 *   主进程的 done 帧是在字节数核对通过之后才发的，所以这里可以信它；
 *   但 error 帧之后可能还有一个 abort 帧在途（用户点了取消），
 *   所以 error 一旦落定就不再被后面的 progress 帧改回 downloading ——
 *   否则界面会在"失败"与"下载中"之间来回闪。
 */
function applyUpdateProgress(p) {
  const u = store.update;
  if (p.phase === 'error') {
    u.phase = 'error';
    u.message = p.message || u.message || '下载失败';
    if (Array.isArray(p.attempts)) u.attempts = p.attempts;
    return;
  }
  if (p.phase === 'aborted') {
    u.phase = 'available';
    u.message = '下载已取消';
    return;
  }
  if (p.phase === 'start' || p.phase === 'progress' || p.phase === 'verify') {
    /* 已经失败/已完成的下载，不再被中途帧拉回"下载中" */
    if (u.phase === 'error' || u.phase === 'ready') return;
    u.phase = 'downloading';
    u.received = Number(p.received) || 0;
    u.total = Number(p.total) || u.total || 0;
    u.percent = Number(p.percent) || 0;
    u.bytesPerSec = Number(p.bytesPerSec) || 0;
    u.etaSec = p.etaSec == null ? null : Number(p.etaSec);
    u.channel = p.channel || u.channel;
    if (Array.isArray(p.attempts)) u.attempts = p.attempts;
    if (p.phase === 'verify') u.percent = 99;
    return;
  }
  if (p.phase === 'done') {
    u.phase = 'ready';
    u.received = Number(p.received) || u.received;
    u.total = Number(p.total) || u.total;
    u.percent = 100;
    u.bytesPerSec = 0;
    u.etaSec = null;
    u.channel = p.channel || u.channel;
    u.message = '下载完成，已校验字节数';
  }
}

/* ============================================================================
 *  数据
 * ========================================================================== */

export async function getDataStats() {
  const r = await safeInvoke('getDataStats');
  return isOk(r) ? r : { ok: false, stats: [], message: errMessage(r, '统计失败') };
}

/* ============================================================================
 *  前置环境检查
 * ========================================================================== */

/**
 * 检查 Python 版本。
 * @param {string} pythonExe
 * @returns {Promise<{ok:boolean, exe:string, version:string, message:string}>}
 */
export async function checkPythonVersion(pythonExe) {
  const r = await safeInvoke('checkPythonVersion', pythonExe);
  if (isOk(r)) return r;
  return {
    ok: false,
    exe: pythonExe || 'python',
    version: '',
    minVersion: store.info.defaultsMeta?.minPython?.label || '3.12',
    message: errMessage(r, 'Python 检测失败')
  };
}

/**
 * 一键前置检查（Python + 依赖）。
 * @param {{installDir?:string, pythonExe?:string}} payload
 */
export async function checkPrerequisites(payload) {
  const plain = toPlain(payload);
  if (!plain.ok) {
    return { ok: false, python: null, dependencies: [], message: plain.message };
  }
  const r = await safeInvoke('checkPrerequisites', plain.value || {});
  if (isOk(r) || r?.python) return r;
  return {
    ok: false,
    python: null,
    dependencies: [],
    installedCount: 0,
    missingCount: 0,
    message: errMessage(r, '前置检查失败')
  };
}

/**
 * 检查依赖。
 * @param {{installDir?:string, pythonExe?:string}} payload
 */
export async function checkDependencies(payload) {
  const plain = toPlain(payload);
  if (!plain.ok) return { ok: false, dependencies: [], message: plain.message };
  const r = await safeInvoke('checkDependencies', plain.value || {});
  if (isOk(r) || Array.isArray(r?.dependencies)) return r;
  return { ok: false, dependencies: [], message: errMessage(r, '依赖检查失败') };
}

/**
 * 安装依赖（带真实进度，通过 subscribeDepsStatus 接收）。
 * @param {{installDir?:string, pythonExe?:string, packages?:string[]}} payload
 */
export async function installDependencies(payload) {
  const plain = toPlain(payload);
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('installDependencies', plain.value || {});
  return isOk(r) ? r : { ok: false, message: errMessage(r, '依赖安装失败') };
}

export async function getDataCategories() {
  const r = await safeInvoke('getDataCategories');
  return Array.isArray(r) ? r : [];
}

export async function cleanDataCategory(key) {
  const r = await safeInvoke('cleanDataCategory', key);
  return isOk(r) ? r : { ok: false, message: errMessage(r, '清理失败') };
}

/* ============================================================================
 *  LLM
 * ========================================================================== */

export async function listModels() {
  const r = await safeInvoke('listModels');
  /*
    成功与失败都要把 source / message 带出去。
    主进程 llm:models 有三种结局：source='api'（真实拉到后端 /v1/models）、
    source='local'（后端不可用，退化成扫描本地模型目录）、
    source='none'（两者都没有，并附带说明原因）。
    原来的失败分支只回 { ok:false, models:[], message:'获取模型列表失败' } ——
    把 source 和**后端给出的真实原因**一起丢了，于是界面上只剩笼统的"无可用模型"，
    用户分不清是"没配 Base URL"、"网络超时"还是"真的没有模型"。
    这里保留 source，并优先采用后端消息。
  */
  if (isOk(r)) return { ok: true, models: r.models || [], source: r.source, message: r.message };
  return {
    ok: false,
    models: [],
    source: r?.source || 'none',
    message: errMessage(r, '获取模型列表失败')
  };
}

/**
 * 发起流式对话。
 * @param {object} params 调用参数（含 messages / model 等）
 * @param {{onDelta:Function, onStart:Function, onDone:Function, onError:Function}} handlers
 * @returns {Promise<{requestId:string, promise:Promise<string>}>}
 */
export function streamChat(params, handlers = {}) {
  const requestId = `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const plain = toPlain(params);
  if (!plain.ok) {
    handlers.onError?.({ message: plain.message, requestId });
    return { requestId, promise: Promise.reject(new Error(plain.message)) };
  }

  /* 只处理属于本次请求的事件 —— 解决多会话/多面板串台 */
  const off = subscribeLlm((payload) => {
    if (!payload || payload.requestId !== requestId) return;
    switch (payload.type) {
      case 'start':
        handlers.onStart?.(payload);
        break;
      case 'delta':
        handlers.onDelta?.(payload.content || '', payload);
        break;
      case 'done':
      case 'aborted':
        handlers.onDone?.(payload.content || '', payload);
        break;
      case 'error':
        handlers.onError?.(payload);
        break;
      default:
        break;
    }
  });

  const useCustom = Boolean(params.useCustom);
  const method = useCustom ? 'callCustomLlm' : 'callLlm';
  const promise = safeInvoke(method, { ...plain.value, requestId })
    .then((text) => {
      /* 主进程返回完整文本；若事件流已结束此处即为最终结果 */
      return typeof text === 'string' ? text : '';
    })
    .catch((e) => {
      handlers.onError?.({ message: String(e?.message || e), requestId });
      return '';
    })
    .finally(() => {
      off();
    });

  return { requestId, promise };
}

/** 中止指定请求 */
export async function abortLlm(requestId) {
  const r = await safeInvoke('abortLlm', requestId);
  return isOk(r) ? { ok: true } : { ok: false, message: errMessage(r) };
}

/* ============================================================================
 *  系统
 * ========================================================================== */

export async function getSystemUsage() {
  const r = await safeInvoke('getSystemUsage');
  return isOk(r) ? r : null;
}

export async function getDiskSpace(target) {
  const r = await safeInvoke('getDiskSpace', target);
  /*
    修正：原来失败时返回 null，调用方只能写 if (!r) 而拿不到失败原因，
    且成功时把主进程的原始字段直接透出（调用方无从判断"0 字节"是
    真的空盘还是读取失败）。现在统一成可判别结构。
  */
  return isOk(r)
    ? {
        ok: true,
        freeBytes: Number(r.freeBytes) || 0,
        totalBytes: Number(r.totalBytes) || 0,
        usedPercent: Number(r.usedPercent) || 0,
        message: ''
      }
    : {
        ok: false,
        freeBytes: 0,
        totalBytes: 0,
        usedPercent: 0,
        message: errMessage(r, '无法读取磁盘空间')
      };
}

/* ============================================================================
 *  日志（核心重写部分）
 * ========================================================================== */

/**
 * 追加一行服务日志到对应桶。
 * @param {string} key 服务 key
 * @param {string} text 单行文本
 * @param {'stdout'|'stderr'} source
 */
export function pushServiceLog(key, text, source = 'stdout') {
  if (!key || !text) return;
  if (!store.logsByKey[key]) store.logsByKey[key] = [];
  const bucket = store.logsByKey[key];

  const line = String(text).replace(/\r/g, '');
  if (!line.trim()) return;

  const level = detectLevel(line, source);
  store.logSeq += 1;
  /*
    key 必须写进条目本身。
    日志页现在把三个来源**合并成一条流**，"这一行是谁输出的"只能由条目自己说 ——
    以前靠"它躺在哪个框里"表达，合并之后那个信息就没了。
  */
  bucket.push({ id: store.logSeq, ts: Date.now(), level, source, text: line, key });

  if (bucket.length > LOG_LIMIT_PER_KEY) {
    bucket.splice(0, bucket.length - LOG_LIMIT_PER_KEY);
  }
}

/**
 * 与主进程 log.js 保持一致的级别判定。
 * 注意否定守卫：`disconnected` / `not ok` 不能被判成 success ——
 * 主进程那边修过同一个缺陷（见 src/main/services/log.js），
 * 这里是它的镜像实现，必须同步，
 * 否则同一条日志在服务区（主进程判定）与回退路径（此处判定）显示不同颜色。
 */
const SUCCESS_RE = /(success(?:fully)?|已完成|启动成功|就绪|\bok\b|\bdone\b|\bconnected\b)/i;
const NEGATED_RE =
  /\b(dis|un|in)connected\b|\bnot\s+(ok|ready|done|connected)\b|\bunavailable\b|\bnever\s+(ok|ready|done)\b/i;

function detectLevel(text, source) {
  if (/(\[error\]|\berror\b|traceback|exception|critical|fatal|失败|错误|异常)/i.test(text)) return 'error';
  if (/(\[warn(?:ing)?\]|\bwarn(?:ing)?\b|警告)/i.test(text)) return 'warn';
  if (SUCCESS_RE.test(text) && !NEGATED_RE.test(text)) return 'success';
  return source === 'stderr' ? 'warn' : 'info';
}

/**
 * 从主进程拉取某服务的历史日志，**整体替换**该桶（不追加）。
 * 仅在首次进入日志页与用户手动刷新时调用 —— 不再参与定时轮询。
 *
 * 失败时**必须保留原有内容**。
 * 原实现是 `const list = Array.isArray(r) ? r : []` 然后无条件覆盖 ——
 * 桥接异常或通道返回错误结构时，整个桶被替换成空数组，而且返回 ok:true。
 * 用户看到的是"日志页突然全空了"，没有任何提示，
 * 只有一条 unhandled rejection 留在控制台。
 *
 * @param {string} key
 * @param {number} maxLines
 */
export async function loadServiceLogs(key, maxLines = 800) {
  const r = await safeInvoke('getServiceLogs', key, maxLines);
  if (!Array.isArray(r)) {
    return { ok: false, message: errMessage(r, '读取服务日志失败'), count: 0 };
  }
  /* 主进程返回最新在前，这里翻正为时间升序 */
  const ordered = r.slice().reverse();
  store.logsByKey[key] = ordered.map((e, i) => ({
    id: `${key}_${e.ts}_${i}`,
    /*
      时间戳只接受正数：解析失败的条目保持 0（界面显示 --:--:--），
      绝不用 Date.now() 冒充 —— 那会让"不知道时间"变成"刚刚"，
      并且把排序彻底打乱（同一时刻的行顺序随机）。
    */
    ts: Number.isFinite(e.ts) && e.ts > 0 ? e.ts : 0,
    level: e.level || detectLevel(e.text || '', e.source),
    source: e.source || 'stdout',
    text: e.text || '',
    /* 同 pushServiceLog：合并视图靠这个字段标出来源 */
    key
  }));
  return { ok: true, count: ordered.length };
}

/**
 * 清空**指定服务**的日志（只影响该 key）。
 * 原实现的 `store.logs = []` 会连另一个服务的日志一起清掉。
 */
export async function clearServiceLogs(key) {
  store.logsByKey[key] = [];
  const r = await safeInvoke('clearServiceLog', key);
  return isOk(r) ? { ok: true, message: '已清空' } : { ok: false, message: errMessage(r, '清空失败') };
}

/** 导出某服务日志到磁盘（主进程写文件，返回路径） */
export async function exportServiceLogs(key) {
  const r = await safeInvoke('exportServiceLog', key);
  return isOk(r) ? { ok: true, path: r.path, lines: r.lines, message: r.message } : { ok: false, message: errMessage(r, '导出失败') };
}

/* 启动器日志的读取/清空/订阅见文件后半部分（launcher 区，含快照替换逻辑） */

/* ============================================================================
 *  事件订阅管理
 * ========================================================================== */

/**
 * 登记一个取消函数。
 *
 * 现在**不再真的登记** —— 每个 subscribe* 已经把取消函数返回给调用方，
 * 调用方用 createSubscriptionScope() 管理即可。原实现往一个模块级数组里 push，
 * 而组件自行调用 off() 时那个条目不会被移除：
 * 每次路由切换/热更新都往里塞一份，数组无界增长并持有已卸载组件的闭包。
 * 保留函数本身（原样返回入参）是为了不改动所有 subscribe* 的写法。
 */
function trackDisposer(off) {
  return off;
}

/** 订阅服务日志批处理（实时通道 —— 日志的唯一实时来源） */
export function subscribeServiceLogs() {
  const fn = bus().onServiceLogBatch;
  if (typeof fn !== 'function') return () => {};
  return trackDisposer(
    fn((payload) => {
      if (!payload || !payload.key) return;
      /* 主进程按批推送原始文本，这里按行拆分 */
      for (const line of String(payload.text || '').split('\n')) {
        if (line.trim()) pushServiceLog(payload.key, line, payload.source);
      }
    })
  );
}

/** 订阅服务生命周期事件 */
export function subscribeServiceEvents(handlers = {}) {
  const b = bus();
  const pairs = [
    ['onServiceExit', handlers.onExit],
    ['onServiceStarted', handlers.onStarted],
    ['onServiceStopped', handlers.onStopped],
    ['onServiceReady', handlers.onReady],
    ['onRestartScheduled', handlers.onRestartScheduled],
    ['onRestartGiveup', handlers.onRestartGiveup],
    /* 手动重启的过程事件 */
    ['onServiceRestarting', handlers.onRestarting],
    ['onServiceRestartFailed', handlers.onRestartFailed]
  ];
  const offs = [];
  for (const [method, cb] of pairs) {
    if (typeof b[method] !== 'function' || typeof cb !== 'function') continue;
    const off = b[method](cb);
    if (typeof off === 'function') {
      offs.push(off);
      trackDisposer(off);
    }
  }
  return () => offs.forEach((f) => f());
}

/** 订阅 LLM 流（内部使用；外部应通过 streamChat 的 handlers） */
function subscribeLlm(cb) {
  const fn = bus().onLlmStream;
  if (typeof fn !== 'function') return () => {};
  return fn(cb) || (() => {});
}

/** 订阅依赖安装进度 */
export function subscribeDepsStatus(cb) {
  const fn = bus().onDepsInstallStatus;
  if (typeof fn !== 'function') return () => {};
  return trackDisposer(fn(cb));
}

/** 订阅终端数据/退出 */
export function subscribeTerminal(handlers = {}) {
  const b = bus();
  const offs = [];
  if (typeof b.onTerminalData === 'function' && handlers.onData) {
    const off = b.onTerminalData(handlers.onData);
    if (typeof off === 'function') {
      offs.push(off);
      trackDisposer(off);
    }
  }
  if (typeof b.onTerminalExit === 'function' && handlers.onExit) {
    const off = b.onTerminalExit(handlers.onExit);
    if (typeof off === 'function') {
      offs.push(off);
      trackDisposer(off);
    }
  }
  return () => offs.forEach((f) => f());
}

/**
 * 释放全部已登记的事件订阅。
 *
 * @deprecated 全局清理会把**其他组件**的订阅一起拆掉（见 createSubscriptionScope 说明）。
 * 已改为空操作：disposers 不再累积任何条目，各组件用自己的作用域清理。
 * 保留导出只是为了让旧引用不至于报错，新代码请勿使用。
 */
export function disposeAllSubscriptions() {
  /* 有意留空 */
}

/**
 * 创建一个**属于调用方自己**的订阅作用域。
 *
 * 为什么需要它（原设计有真实缺陷）：
 *   原来是一个模块级全局数组 + disposeAllSubscriptions() 一次性清空，
 *   会把**所有人**的订阅一起拆掉。AppLayout / TerminalPanel / InstallerPanel
 *   都往同一个数组里登记，任何一个卸载时调用它，另外两个的订阅也没了
 *   —— 表现是"切到某页再切回来，另一个页的事件就再也不更新了"。
 *   另外组件若自己调用了 off()，全局数组里的那个条目不会被移除，
 *   每次挂载都往里塞一份，数组无界增长并持有已卸载组件的闭包。
 *   （现已取消全局登记：trackDisposer 只原样返回，不再累积。）
 *
 * 用法：
 *   const scope = createSubscriptionScope();
 *   onMounted(() => { scope.add(subscribeXxx(cb)); });
 *   onBeforeUnmount(() => scope.dispose());
 *
 * 返回的 off 函数同时支持：
 *   - add(off)        登记一个取消函数
 *   - dispose()       只取消**本作用域**的，并清空自己的列表
 *   - scope.size      当前登记数（调试用）
 */
export function createSubscriptionScope() {
  let offs = [];
  return {
    add(off) {
      if (typeof off === 'function') offs.push(off);
      return off;
    },
    dispose() {
      const list = offs;
      offs = [];
      for (const off of list) {
        try {
          off();
        } catch (_) {
          /* 忽略取消失败 */
        }
      }
    },
    get size() {
      return offs.length;
    }
  };
}

/* ============================================================================
 *  启动器自身日志（launcher 区）
 * ========================================================================== */

/** 单条启动器日志入桶（带 id 去重，避免与快照加载重复） */
function pushAppLog(entry) {
  if (!entry) return;
  const bucket = store.logsByKey.launcher;
  const seq = ++store.logSeq;
  bucket.push({
    id: entry.id ?? `launcher-${seq}-${entry.ts}`,
    ts: entry.ts || Date.now(),
    level: entry.level || 'info',
    /* 必须给 source，否则模板的 `s-${l.source}` 变成 s-undefined（徽标无配色） */
    source: entry.source || 'app',
    text: entry.text || '',
    /* 合并视图靠它标出"这行是启动器输出的" */
    key: 'launcher'
  });
  if (bucket.length > LOG_LIMIT_PER_KEY) bucket.splice(0, bucket.length - LOG_LIMIT_PER_KEY);
}

/**
 * 读取启动器日志快照（磁盘/内存缓冲），并写入 launcher 区。
 * maxLines 由调用方按设置里的 logRetentionLines 传入。
 */
export async function loadAppLogs(maxLines = 600) {
  const r = await safeInvoke('getAppLog', maxLines);
  /* 失败时保留已有内容，不要清空（同 loadServiceLogs 的说明） */
  if (!isOk(r)) return { ok: false, entries: [], message: errMessage(r, '读取启动器日志失败') };

  store.appLogFile = r.file || '';

  const entries = Array.isArray(r.entries) ? r.entries : [];
  const bucket = store.logsByKey.launcher;
  /*
    整体替换而不是追加：快照已经是完整历史，
    追加会把每次刷新都重复叠一份（重构前服务日志正是栽在这个坑上）。
  */
  bucket.splice(0, bucket.length);

  /*
    ★ 主进程返回的是**最新在前**（见 main/logging.js 里 getAppLog 的注释）。
    以前服务日志翻了正、启动器日志没翻 ——
    所以"启动器"那一块一直是倒着显示的：最新的在最上面，越往下越旧，
    用户按时间读会完全读反。合并成一条流之后这个顺序会直接污染整页。
  */
  const ordered = entries.slice().reverse();

  let seq = 0;
  /*
    ★ 解析不出时间的行（多行堆栈、没有时间戳前缀的输出）继承上一行的时间。
    原实现是 `e.ts || Date.now()`：既把"不知道时间"谎报成"刚刚"，
    又让这些行全挤在同一个时间点上，排序结果完全看运气
    （实测整页时间戳都变成"当前时刻"，而主进程明明给了真实时间）。
    第一行就解析失败时保持 0 —— 界面显示 --:--:--，这是诚实的"不知道"。
  */
  let lastTs = 0;
  for (const e of ordered) {
    const known = Number.isFinite(e.ts) && e.ts > 0;
    const ts = known ? e.ts : lastTs;
    if (known) lastTs = e.ts;
    bucket.push({
      id: e.id ?? `launcher-snap-${seq++}-${e.ts}`,
      ts,
      level: e.level || 'info',
      /*
        source 必须给值。
        日志页的徽标绑定 `s-${l.source}`，而这里与 pushAppLog 原来都**不写**
        source 字段 → 类名变成 `s-undefined`，CSS 里没有这个类，
        启动器分区的 "APP" 徽标因此完全没有配色（服务分区正常）。
      */
      source: e.source || 'app',
      text: e.text || '',
      /* 同 pushAppLog：快照条目也要带 key，合并视图才能标来源 */
      key: 'launcher'
    });
  }
  store.logSeq = Math.max(store.logSeq, seq);
  return { ok: true, entries, file: store.appLogFile };
}

/** 清空内存中的启动器日志缓冲（磁盘历史保留） */
export async function clearAppLogs() {
  const r = await safeInvoke('clearAppLog');
  if (!isOk(r)) return { ok: false, message: errMessage(r, '清空失败') };
  store.logsByKey.launcher.splice(0, store.logsByKey.launcher.length);
  return { ok: true, file: r.file || store.appLogFile };
}

/** 定位启动器日志文件（不复制副本，直接给真实路径） */
export async function exportAppLog() {
  const r = await safeInvoke('exportAppLog');
  return isOk(r)
    ? { ok: true, path: r.file, size: r.size || 0 }
    : { ok: false, path: r?.file || '', message: errMessage(r, '日志文件尚不可用') };
}

/** 订阅启动器日志实时推送 */
export function subscribeAppLogs() {
  const fn = bus().onAppLog;
  if (typeof fn !== 'function') return () => {};
  return trackDisposer(fn(pushAppLog));
}

/* ============================================================================
 *  提示
 * ========================================================================== */

/** 同类告警的去重窗口（毫秒）：避免同一故障反复弹出刷屏 */
const ALERT_DEDUPE_WINDOW = 30000;

/**
 * 记录一条持久告警（由 AppLayout 的告警区渲染，需用户手动忽略）。
 *
 * 与 toast 的分工：
 *   toast     —— 一闪而过的即时反馈，适合"已启动/已停止"。
 *   pushAlert —— 需要用户事后处理的事件（异常退出、放弃重启），
 *                留在界面上直到被忽略。
 */
export function pushAlert(alert) {
  const title = String(alert?.title || '');
  const now = Date.now();

  /* 去重：同标题告警在窗口期内只保留一条，否则崩溃循环会瞬间刷满 20 条上限 */
  const dup = store.alerts.find(
    (a) => a.title === title && now - a.ts < ALERT_DEDUPE_WINDOW
  );
  if (dup) {
    dup.count = (dup.count || 1) + 1;
    dup.ts = now;
    /* 同一条被反复触发时同步刷新正文，保留最后一次的真实原因 */
    if (alert.text) dup.text = alert.text;
    return;
  }

  store.alerts.push({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, ts: now, count: 1, ...alert });
  if (store.alerts.length > 20) store.alerts.shift();
}

/** 忽略单条告警 */
export function dismissAlert(id) {
  const i = store.alerts.findIndex((a) => a.id === id);
  if (i > -1) store.alerts.splice(i, 1);
}

/** 忽略全部告警 */
export function clearAlerts() {
  store.alerts.splice(0, store.alerts.length);
}

/* ============================================================================
 *  终端
 * ========================================================================== */

export async function loadTerminalCapability() {
  const r = await safeInvoke('terminalCapability');
  if (isOk(r)) store.terminal = r;
  return store.terminal;
}

export async function spawnTerminal(opts) {
  const plain = toPlain(opts);
  if (!plain.ok) return { ok: false, message: plain.message };
  const r = await safeInvoke('terminalSpawn', plain.value);
  return isOk(r) ? r : { ok: false, message: errMessage(r, '终端启动失败') };
}

/*
  ---------------------------------------------------------------- 终端写入/尺寸/关闭

  这三个原来都是 `api().terminalXxx?.(...)` 的即发即忘调用，原因在主进程侧：
  terminal:write / resize / kill 注册在 ipcMain.on 上（单向），preload 用 send，
  根本没有返回值 —— 主进程精心构造的 {ok:false, message}
  （会话不存在 / 写入失败 / 杀进程失败）结构上无法到达渲染层，失败全静默。

  现在三端一起改成 invoke（preload → ipcRenderer.invoke，
  主进程 → safeHandle），这里统一用 safeInvoke 收口：
  · 桥接方法缺失 / 主进程抛异常 / 通道没注册 都会被转成 {ok:false, message}，
    绝不把 promise 拒绝抛给调用方 —— 调用点（xterm 的 onData、fit 回调）
    根本没地方接，抛出去就是一个未处理的 rejection；
  · 调用方按需读 {ok:false, message} 提示用户（见 TerminalPanel）。
*/

/** 写入数据（键盘输入）。失败静默不了：返回值里有 {ok:false, message} */
export function writeTerminal(sessionId, data) {
  return safeInvoke('terminalWrite', sessionId, data);
}

/** 调整尺寸（仅 PTY 后端有意义，管道后端主进程侧直接忽略） */
export function resizeTerminal(sessionId, cols, rows) {
  return safeInvoke('terminalResize', sessionId, cols, rows);
}

/** 关闭单个会话（会话不存在时返回 {ok:false}，不再是"调用成功"） */
export function killTerminal(sessionId) {
  return safeInvoke('terminalKill', sessionId);
}

/* ============================================================================
 *  外壳能力
 * ========================================================================== */

export async function openExternal(url) {
  return safeInvoke('openExternal', url);
}

export async function openPath(target) {
  const r = await safeInvoke('openPath', target);
  return isOk(r) ? { ok: true } : { ok: false, message: errMessage(r) };
}

export async function showItemInFolder(target) {
  return safeInvoke('showItemInFolder', target);
}

export async function selectDirectory(opts) {
  const r = await safeInvoke('selectDirectory', opts);
  return isOk(r) ? { ok: true, path: r.path } : { ok: false, canceled: r?.canceled, message: errMessage(r, '未选择') };
}

export async function selectFile(opts) {
  const r = await safeInvoke('selectFile', opts);
  return isOk(r) ? { ok: true, path: r.path } : { ok: false, canceled: r?.canceled, message: errMessage(r, '未选择') };
}

export async function saveFileDialog(opts) {
  const r = await safeInvoke('saveFile', opts);
  return isOk(r) ? { ok: true, path: r.path } : { ok: false, canceled: r?.canceled, message: errMessage(r, '未选择') };
}

/** 原生确认框（替代 window.confirm） */
export async function confirmDialog(opts) {
  const r = await safeInvoke('confirm', opts);
  return Boolean(r?.confirmed);
}

export async function exitApp() {
  api().exitApp?.();
}

/* ============================================================================
 *  窗口控制
 * ---------------------------------------------------------------------------
 *  说明：主窗口使用原生标题栏（frame 默认 true），系统已提供最小化/最大化/关闭。
 *  这里额外暴露「隐藏到托盘」与「最小化」，用于需要从界面内触发的场景 ——
 *  否则 src/main/services/index.js 里注册的 window:* 通道将没有任何调用方。
 * ========================================================================== */

/** 最小化主窗口 */
export async function minimizeWindow() {
  const r = await safeInvoke('minimizeWindow');
  return isOk(r) ? { ok: true } : { ok: false, message: errMessage(r) };
}

/** 隐藏到系统托盘（保留进程与子服务运行） */
export async function hideToTray() {
  const r = await safeInvoke('hideToTray');
  return isOk(r) ? { ok: true } : { ok: false, message: errMessage(r) };
}

/** 查询主窗口是否最大化 */
export async function isMaximized() {
  const r = await safeInvoke('isMaximized');
  return Boolean(r?.maximized);
}

/** 上报一条渲染层日志（主进程会真实写入 launcher.log） */
export function reportLog(level, msg) {
  api().reportLog?.(level, msg);
}

/* ============================================================================
 *  系统集成：登录自启 / 系统通知 / 启动参数探测
 * ========================================================================== */

/**
 * 查询系统真实的登录自启状态（读注册表，不是设置文件里的意图）。
 * @returns {Promise<{ok:boolean, supported:boolean, enabled:boolean, message:string}>}
 */
export async function loadLoginItemState() {
  const r = await safeInvoke('getLoginItemState');
  return isOk(r)
    ? { ok: true, supported: r.supported !== false, enabled: Boolean(r.enabled), message: r.message || '' }
    : { ok: false, supported: false, enabled: false, message: errMessage(r, '无法读取开机自启状态') };
}

/**
 * 写入系统登录项。
 * @param {boolean} enabled
 * @returns {Promise<{ok:boolean, supported:boolean, enabled:boolean, changed:boolean, message:string}>}
 */
export async function setLoginItem(enabled) {
  const r = await safeInvoke('setLoginItem', Boolean(enabled));
  if (!isOk(r)) {
    return { ok: false, supported: false, enabled: false, changed: false, message: errMessage(r, '设置失败') };
  }
  /* 主进程同时会把结果写回设置文件，这里同步本地副本避免界面显示不一致 */
  if (r.supported && store.settings?.general) {
    store.settings.general.launchOnLogin = Boolean(r.enabled);
    if (store.draft?.general) store.draft.general.launchOnLogin = Boolean(r.enabled);
  }
  return {
    ok: true,
    supported: r.supported !== false,
    enabled: Boolean(r.enabled),
    changed: Boolean(r.changed),
    message: r.message || ''
  };
}

/** 发一条 Windows 系统通知 */
export async function notifySystem({ title, body, level = 'info', silent = false } = {}) {
  const r = await safeInvoke('notify', { title, body, level, silent });
  return isOk(r) ? { ok: true, supported: r.supported !== false } : { ok: false, message: errMessage(r, '通知发送失败') };
}

/*
  主题偏好的合法取值。与主进程 settings.js:234 的归一化列表、constants.js:163
  的默认值必须一致；写错一个字会被主进程退化成"跟随系统"而磁盘上留下非法值。
*/
const THEME_PREFERENCES = ['light', 'dark', 'system'];

/**
 * 读取界面主题偏好。
 *
 * 主进程 `theme:get` 的契约（services/index.js:206-217）：
 *   preference —— 用户**持久化的偏好**，取值 'light' | 'dark' | 'system'
 *   theme      —— 当前**已解析**的主题，只有 'light' | 'dark'
 *   resolved / isDark —— theme 的别名与布尔形态（兼容旧调用方）
 *
 * ⚠️ 这两个必须分开取：只拿 theme 会把"跟随系统"当成"手动浅色"，
 * 设置页的三选一就会显示错项（用户明明选了跟随系统，界面却高亮"浅色"）。
 *
 * @returns {Promise<{ok:boolean, preference:'light'|'dark'|'system', theme:'light'|'dark', message?:string}>}
 */
export async function getThemePreference() {
  const r = await safeInvoke('getTheme');
  if (!isOk(r)) {
    return { ok: false, preference: 'system', theme: 'light', message: errMessage(r, '无法读取主题偏好') };
  }
  /*
    偏好字段的读取顺序：
      1) r.preference —— 主进程 theme:get 的正式字段
      2) store.settings.general.theme —— 兼容尚未补 preference 的旧主进程
      3) 'system' —— 默认值，与 constants.js:163 一致
    第 2 步是**必要的**兼容层：只认 r.preference 时，旧主进程下三选一
    会永远显示"跟随系统"，用户点了浅色再进来又变回去 —— 看起来就是"设置没保存"。
  */
  const raw = r.preference ?? store.settings?.general?.theme;
  const preference = THEME_PREFERENCES.includes(raw) ? raw : 'system';
  return {
    ok: true,
    preference,
    theme: r.theme === 'dark' || r.isDark === true ? 'dark' : 'light'
  };
}

/**
 * 设置界面主题偏好（并立刻生效 + 持久化）。
 *
 * 为什么走独立的 `theme:set` 通道，而不是像其它字段那样改 draft、等用户点「应用」：
 *   主题是**即时可见**的显示设置，Windows 上所有应用的惯例都是点一下就变。
 *   更重要的是：改动 draft 会让设置页立刻变成 dirty，用户切个主题就被
 *   离开拦截拦住（onBeforeRouteLeave），这是不合理的。
 *
 * 副作用必须一起处理：主进程在写入设置文件的同时会把 general.theme 更新掉
 * （services/index.js:238-292），所以这里也要同步本地 settings / draft，
 * 否则用户点「应用」时会把**旧的** general.theme 写回去，主题被打回原样。
 * 这也是为什么主题不能只靠 `saveBackendSettings` 那条路（两条路会互相覆盖）。
 *
 * @param {'light'|'dark'|'system'} preference
 * @returns {Promise<{ok:boolean, preference:string, theme:'light'|'dark', followingSystem:boolean, changed:boolean, message?:string}>}
 */
export async function setThemePreference(preference) {
  const pref = THEME_PREFERENCES.includes(preference) ? preference : 'system';
  const r = await safeInvoke('setTheme', pref);
  if (!isOk(r)) {
    return {
      ok: false,
      preference: pref,
      theme: 'light',
      followingSystem: pref === 'system',
      changed: false,
      message: errMessage(r, '主题设置失败')
    };
  }
  const theme = r.theme === 'dark' ? 'dark' : 'light';
  /*
    同步两个本地副本（都不存在时静默跳过）。
    draft 也要改：否则「应用」会把旧值写回（见上面的注释）。
  */
  for (const holder of [store.settings?.general, store.draft?.general]) {
    if (holder) holder.theme = pref;
  }
  return {
    ok: true,
    preference: pref,
    theme,
    followingSystem: r.following !== false && pref === 'system',
    changed: Boolean(r.changed)
  };
}

/**
 * 让主进程探测某个服务的真实启动参数（会检查目录与入口文件是否存在）。
 * 用于在界面上提前判断"能不能启动"，而不是点了按钮才知道路径错了。
 */
export async function resolveStartPayload(key) {
  const r = await safeInvoke('resolveStartPayload', key);
  return isOk(r) ? { ok: true, payload: r.payload } : { ok: false, message: errMessage(r, '路径无效') };
}
