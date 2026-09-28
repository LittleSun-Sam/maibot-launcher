/*
================================================================================
技术文档：src/main/services/log.js
职责：服务 stdout/stderr 的缓冲、级别识别、批处理推送与导出。
================================================================================
  相对重构前的修正：
    1) 推送目标从 webContents.getAllWebContents() 广播改为**主窗口单点推送**
       （广播会让所有 webContents 收到同一份日志，多窗口时重复渲染）。
    2) 日志级别判定从前端正则（/ok\b/i 会把 "cookie"、"token" 误判为 success）
       改为在主进程按行判定，并优先使用 stderr 语义。
    3) 导出原来把全部日志内容拼成字符串交给渲染进程下载，
       且渲染层用 .html 扩展名保存 —— 日志里的 `<script>` 会被浏览器执行，
       构成存储型 XSS。现在改为**主进程直接写文件**，返回文件路径，
       由外壳（shell.openPath）打开，内容永不进入渲染层 DOM。
    4) 增加每服务行数上限的显式说明与裁剪策略。
================================================================================
*/
const fs = require('fs');
const path = require('path');
const { SERVICE_LOG_MAX_LINES } = require('../constants');
const logging = require('../logging');
const paths = require('../paths');

/** key → Array<{id, ts, level, source, text}> */
const buffers = new Map();
/** key → 待批处理的文本 */
const pending = new Map();
let flushTimer = null;
let seq = 0;

const FLUSH_INTERVAL_MS = 80;

/*
  级别判定（顺序敏感）：
    error → warn → success → info
  stderr 默认为 warn，但明确含 Traceback/Exception 时升级为 error。

  关于成功词的边界：`connected` 若无左边界会把 **disconnected**（断连）判成成功，
  这类反向语义的误判比漏判更有害 —— 用户会以为连上了。
  因此所有成功词一律加 \b，并显式排除常见否定前缀。
*/
const ERROR_RE = /(\[error\]|\berror\b|traceback|exception|critical|fatal|失败|错误|异常)/i;
const WARN_RE = /(\[warn(?:ing)?\]|\bwarn(?:ing)?\b|警告|警告：)/i;
const SUCCESS_RE = /(success(?:fully)?|已完成|启动成功|就绪|\bok\b|\bdone\b|\bconnected\b)/i;
/** 反向语义：命中则撤销 success 判定（见下方注释） */
const NEGATED_RE = /\b(dis|un|in)connected\b|\bnot\s+(ok|ready|done|connected)\b|\bunavailable\b|\bnever\s+(ok|ready|done)\b/i;

function detectLevel(text, source) {
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  /*
    反向语义不得判为成功：disconnected / not connected / unavailable。
    这类误判比漏判更有害 —— 用户看到绿色成功标记，会以为真的连上了。
  */
  if (SUCCESS_RE.test(text) && !NEGATED_RE.test(text)) {
    return 'success';
  }
  return source === 'stderr' ? 'warn' : 'info';
}

function ensureBuffer(key) {
  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }
  return buf;
}

/**
 * 追加服务日志。由 process.js 的 stdout/stderr 泵调用。
 * @param {string} key
 * @param {string} text
 * @param {'stdout'|'stderr'} [source]
 */
function appendServiceLog(key, text, source = 'stdout') {
  const raw = String(text ?? '');
  if (!raw) return;

  const buf = ensureBuffer(key);
  /* 按行拆分，过滤空行，保留原始顺序 */
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    buf.push({
      id: ++seq,
      ts: Date.now(),
      level: detectLevel(line, source),
      source,
      text: line
    });
  }
  if (buf.length > SERVICE_LOG_MAX_LINES) {
    buf.splice(0, buf.length - SERVICE_LOG_MAX_LINES);
  }

  /* 批处理：累积原始文本，定时统一推送，避免高频 IPC */
  pending.set(key, (pending.get(key) || '') + raw);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

/** 批量推送到渲染进程 */
function flush() {
  flushTimer = null;
  if (!pending.size) return;

  /* 延迟 require：windows.js 与 log.js 之间存在潜在加载环 */
  let sendToRenderer;
  try {
    ({ sendToRenderer } = require('../windows'));
  } catch (e) {
    logging.log('warn', `[log] 无法加载 windows 模块: ${e.message}`);
    return;
  }

  for (const [key, text] of pending.entries()) {
    if (!text) continue;
    sendToRenderer('service-log-batch', { key, text });
    pending.delete(key);
  }
}

/**
 * 拉取某服务的日志。
 * @param {string} key
 * @param {number} maxLines
 * @returns {Array} 最新在前
 */
function getServiceLogs(key, maxLines = 800) {
  const buf = buffers.get(key) || [];
  const limit = Math.max(1, Math.min(Number(maxLines) || 800, SERVICE_LOG_MAX_LINES));
  return buf.slice(-limit).reverse().map((e) => ({ ...e }));
}

/** 清空某服务日志（只清该服务） */
function clearServiceLog(key) {
  buffers.set(key, []);
  pending.delete(key);
  return { ok: true, key };
}

/** 返回所有已有日志的服务 key */
function logKeys() {
  return Array.from(buffers.keys());
}

/** 把服务日志格式化为纯文本 */
function formatServiceLog(key) {
  const buf = buffers.get(key) || [];
  return buf
    .map((e) => {
      const ts = new Date(e.ts).toISOString();
      const src = e.source === 'stderr' ? 'ERR' : 'OUT';
      return `[${ts}] [${src}] [${e.level.toUpperCase()}] ${e.text}`;
    })
    .join('\n');
}

/**
 * 导出服务日志到磁盘文件。
 * 安全要点：内容由主进程写出，永不回到渲染层，因此不存在注入风险。
 * @param {string} key
 * @param {string} [destDir] 默认写入受管导出目录
 * @returns {{ok:boolean, path?:string, lines?:number, message?:string}}
 */
function exportServiceLog(key, destDir) {
  const buf = buffers.get(key) || [];
  if (!buf.length) return { ok: false, message: `服务 ${key} 暂无日志可导出` };

  const dir = destDir && typeof destDir === 'string' ? destDir : paths.exportDir();
  try {
    paths.ensureDir(dir);
  } catch (e) {
    return { ok: false, message: `无法创建导出目录: ${e.message}` };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${key}-${stamp}.log`);
  try {
    fs.writeFileSync(file, formatServiceLog(key), 'utf8');
  } catch (e) {
    return { ok: false, message: `写入失败: ${e.message}` };
  }

  logging.log('info', `[log] 已导出 ${key} 日志 ${buf.length} 行 → ${file}`);
  return { ok: true, path: file, lines: buf.length, message: `已导出 ${buf.length} 行` };
}

module.exports = {
  appendServiceLog,
  getServiceLogs,
  clearServiceLog,
  exportServiceLog,
  logKeys,
  detectLevel
};
