/*
================================================================================
技术文档：src/main/logging.js
职责：主进程应用日志（落盘 + 内存环形缓冲 + 渲染进程上报接管）。
================================================================================
  重构前的问题（全部修掉）：
    1) 劫持 console.* 写日志 → 内部又调用 console.error 报错 = 无限递归风险
    2) writeQueue 计数器只自增自减、从未被读取 —— 纯装饰性死代码
    3) 每次启动 writeFileSync(path, '') 清空日志，历史完全丢失
    4) registerRendererLogIpc() 写得好好的，却从未被调用；另一边
       services/index.js 里挂了个假处理器，用"读一次日志"冒充"写一条日志"，
       两个同名通道一个空转一个永不执行。
    5) 无任何落盘错误处理

  本实现：
    - 单一 log() API + 真实写盘（appendFile 队列 + 串行化，避免并发写乱序）
    - 由小到大单文件轮转（launcher.log → launcher.log.1/.2），保留历史
    - 内存环形缓冲供 getMainLogs() 按行尾读取
    - 渲染进程 log:report 真正落盘
================================================================================
*/
const fs = require('fs');
const { app } = require('electron');
const { appLogFile, appLogDir, ensureDir } = require('./paths');
const { APP_LOG_MAX_LINES } = require('./constants');

/* ---- 内存环形缓冲：{ ts, level, text } ---- */
const ring = [];
/* ---- 落盘状态 ---- */
let fileReady = false;
let currentFile = '';
/* ---- 串行写队列：保证 append 顺序，且不需要 await 调用方 ---- */
let writeChain = Promise.resolve();
/* ---- 单文件大小上限（超过则轮转） ---- */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ROTATE_KEEP = 2;

/*
  实时订阅者集合。
  必须声明在 push() 之前：push() 会在模块求值阶段就被调用
  （initLogging → log → push），若声明在后会命中 TDZ 而抛
  "Cannot access 'listeners' before initialization"。
*/
const listeners = new Set();

function push(level, text) {
  const entry = { ts: Date.now(), level, text };
  ring.push(entry);
  if (ring.length > APP_LOG_MAX_LINES) ring.splice(0, ring.length - APP_LOG_MAX_LINES);
  /*
    实时广播给订阅者（由 services/index.js 转发到渲染层）。
    这样日志页的「启动器日志」区可以像服务日志一样实时刷新，
    而不是每次都要手动点刷新去取一份快照。
    订阅者异常绝不能影响日志写入本身。
  */
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch (_) {
      /* 忽略订阅者异常 */
    }
  }
  return entry;
}

/**
 * 订阅启动器日志。
 * @param {(entry:{ts:number,level:string,text:string}) => void} fn
 * @returns {() => void} 取消订阅
 */
function onLog(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 轮转：launcher.log → .1 → .2（超出丢弃最旧） */
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
  } catch (_) {
    return; /* 文件不存在则无需轮转 */
  }
  try {
    for (let i = ROTATE_KEEP; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      if (fs.existsSync(from)) {
        if (i === ROTATE_KEEP && fs.existsSync(to)) fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      }
    }
  } catch (e) {
    /* 轮转失败不影响当前写入 */
    console.warn('[logging] 日志轮转失败:', e.message);
  }
}

/**
 * 把任意文本压成**物理一行**：CR / LF 转义成可见占位 `\n`。
 *
 * 为什么必须转义（真实缺陷，不是防御性编程）：
 *   日志文件里的行 = 审计/自检的证据单位。渲染层可以经 log:report
 *   （preload.js 的 reportLog → services/index.js 的 log:report）把任意字符串
 *   写进这里；只要字符串里带一个真的 \n，它就能伪造出一条**看起来像主进程
 *   写出**的完整日志行，例如：
 *     msg = 'x\n[selfcheck] verdict installer=ok'
 *   而 scripts/selfcheck.mjs 是按行搜集 `[selfcheck] verdict <route>=ok|bad`
 *   的，于是"真实运行结果是 =bad"会被这条伪造的 =ok 掩盖。
 *   转义之后，一条日志永远只占一行，渲染层再也伪造不出独立的日志行。
 *
 * 可读性取舍：文件里多行内容（例如 Error.stack）会显示成 `\n` 占位，
 *   但 stdout 上的原始 console 输出不受影响（attachConsole 仍先调用原函数），
 *   所以人肉看终端仍是真实换行，文件侧则是"一条日志一行"的机器可读格式。
 *   getMainLogs() 的磁盘回读按 \n 切分，转义后每条日志恰好一行，切分依然正确。
 */
function escapeOneLine(text) {
  /* 先吃掉 \r\n / 单独的 \r，再把剩余的 \n 统一转成可见占位 */
  return String(text).replace(/\r\n?/g, '\\n').replace(/\n/g, '\\n');
}

function formatLine(level, text) {
  return `[${new Date().toISOString()}] [${escapeOneLine(String(level).toUpperCase())}] ${escapeOneLine(text)}\n`;
}

/**
 * 写入一条应用日志。
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} text
 */
function log(level, text) {
  const line = String(text == null ? '' : text);
  push(String(level || 'info').toLowerCase(), line);
  if (!fileReady) return;

  writeChain = writeChain
    .then(async () => {
      rotateIfNeeded(currentFile);
      await fs.promises.appendFile(currentFile, formatLine(level, line), 'utf8');
    })
    .catch((e) => {
      /* 写盘失败只提示一次，避免刷屏；不影响业务 */
      if (!log.writeFailed) {
        log.writeFailed = true;
        console.warn('[logging] 日志写入失败（后续同类错误不再重复提示）:', e.message);
      }
    });
}
log.writeFailed = false;

/**
 * 初始化日志系统。必须在 app ready 之后调用。
 * 与重构前不同：**不清空历史**，只在文件过大时轮转。
 */
function initLogging() {
  try {
    ensureDir(appLogDir());
    currentFile = appLogFile();
    rotateIfNeeded(currentFile);
    /* 写入一次会话分隔头，便于在连续日志中区分多次启动 */
    fs.appendFileSync(
      currentFile,
      `\n${'='.repeat(72)}\n[${new Date().toISOString()}] 会话启动 · v${app.getVersion()} · pid ${process.pid} · ${process.platform}\n${'='.repeat(72)}\n`,
      'utf8'
    );
    fileReady = true;
    log('info', '日志系统就绪');
  } catch (e) {
    fileReady = false;
    console.error('[logging] 初始化失败:', e);
  }
}

/**
 * 接管 console.*，使既有 console.log 调用自动落盘。
 * 注意：内部**绝不**再调用 console.error，避免递归。
 */
function attachConsole() {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };
  const render = (args) =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch (_) {
          return String(a);
        }
      })
      .join(' ');

  console.log = (...a) => { original.log(...a); log('info', render(a)); };
  console.info = (...a) => { original.info(...a); log('info', render(a)); };
  console.debug = (...a) => { original.debug(...a); log('debug', render(a)); };
  console.warn = (...a) => { original.warn(...a); log('warn', render(a)); };
  console.error = (...a) => { original.error(...a); log('error', render(a)); };
}

/**
 * 读取应用日志。
 * @param {number} maxLines 最多返回多少行
 * @returns {{ts:number, level:string, text:string}[]} 最新在前
 */
function getMainLogs(maxLines = 500) {
  const limit = Math.max(1, Math.min(Number(maxLines) || 500, APP_LOG_MAX_LINES));
  /* 优先返回内存缓冲（本会话），不足时从磁盘补齐历史 */
  if (ring.length >= limit) {
    return ring.slice(-limit).reverse().map((e) => ({ ...e }));
  }
  try {
    const file = appLogFile();
    if (!fs.existsSync(file)) return ring.slice().reverse().map((e) => ({ ...e }));
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    return lines
      .slice(-limit)
      .reverse()
      .map((text) => {
        const m = text.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
        const ts = m ? Date.parse(m[1]) : 0;
        const level = m ? m[2].toLowerCase() : 'info';
        return { ts: Number.isFinite(ts) ? ts : 0, level, text: m ? m[3] : text };
      });
  } catch (e) {
    console.warn('[logging] 读取日志失败:', e.message);
    return ring.slice().reverse().map((e) => ({ ...e }));
  }
}

/** 清空内存缓冲（磁盘日志保留，便于回溯） */
function clearBuffer() {
  ring.length = 0;
}

/** 返回日志文件绝对路径（供"打开日志目录"功能） */
function logFilePath() {
  return appLogFile();
}

/** 等待所有待写日志落盘（退出前调用） */
async function flush() {
  try {
    await writeChain;
  } catch (_) {
    /* 忽略：已在上方 catch 中处理 */
  }
}

module.exports = {
  initLogging,
  attachConsole,
  log,
  onLog,
  getMainLogs,
  clearBuffer,
  logFilePath,
  flush,
  appLogDir,
  appLogFile
};
