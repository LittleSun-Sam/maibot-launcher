/*
================================================================================
技术文档：src/main/services/llm.js
职责：OpenAI 兼容接口的流式调用（SSE），支持并发隔离与主动中止。
================================================================================
  重构前的问题（全部修掉）：
    1) 事件用 webContents.getAllWebContents() 广播，且事件不携带请求标识。
       渲染层只判断 e.type === 'delta' —— 于是：
         · 同时开「AI 对话」与「提示词优化」两个面板 → 输出互相污染
         · 切换会话后再发送 → 旧流的增量拼进新会话
       现在：每次调用分配 requestId，所有事件携带 requestId，前端按 id 过滤。
    2) 无法中止。请求一旦发出只能干等；sending 期间输入框锁定且没有取消入口。
       现在：llm:abort 通道 + AbortController，真正断开连接。
    3) SSE 解析不完整：只处理单行 `data:`，不处理 `event:` 行、
       多行 data、CRLF、以及 UTF-8 多字节被 chunk 边界切断的情况。
       现在：按规范解析事件块，并用 TextDecoder({stream:true}) 处理分片。
    4) getMaibotModels() 只扫 .gguf/.bin —— 对 MaiBot（走 API 的框架）毫无意义，
       模型名应由后端 /v1/models 提供。现在改为真实查询接口，失败再退化为目录扫描。
    5) 前端选择的模型名被丢弃（callLlm 忽略 params.model，永远用设置里的 model）。
       现在：显式使用调用方传入的 model。
    6) baseUrl 与 apiKey 各自独立地从 params 回落到磁盘设置 —— 渲染层只要传一个
       baseUrl、不传 apiKey，磁盘里的密钥就会被发到那个 URL（凭据外发）。
       现在：两者必须成对来自同一来源（见 resolveLlmEndpoint 的注释）。
    7) 对话流完全没有超时（AbortSignal.timeout 只加在 listModels 上）。服务端
       接受连接后挂住不返回 → fetch 永不 settle → 输入框被 sending 永久锁死。
       现在：空闲超时 + 总时长上限，超时即 abort 并抛出可读错误。
================================================================================
*/
const { EventEmitter } = require('events');
const logging = require('../logging');
const { getBackendSettings } = require('./settings');

/** requestId → AbortController */
const inflight = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(50);

let seq = 0;
function nextRequestId() {
  seq += 1;
  return `llm_${Date.now().toString(36)}_${seq}`;
}

/* ============================================================================
 *  端点与凭据的绑定（item 5）
 * ========================================================================== */

/**
 * 解析本次请求实际使用的 baseUrl / apiKey。
 *
 * 契约（**baseUrl 与 apiKey 必须成对来自同一来源**）：
 *   · 渲染层只要显式给了 baseUrl 或 apiKey 中**任意一个**，本次请求就以渲染层为准：
 *       - 两个都给了 → 都用渲染层的值（空串也是值，表示"这个端点不需要密钥"）；
 *       - 只给 baseUrl  → apiKey 取空，**绝不回落磁盘密钥**。这正是要修的缺口：
 *         回落磁盘密钥等于把用户密钥发到任意 URL（渲染层被注入、或诱导用户
 *         填一个攻击者域名即可外发）。
 *       - 只给 apiKey   → baseUrl 回落磁盘端点（用户自己配置的端点），无害，
 *         而且是"临时换 key、端点不动"的正常用法；密钥仍只发给受信端点。
 *   · 渲染层两个都没给 → 整对（磁盘 baseUrl + 磁盘 apiKey）一起用。
 *
 * 注意 `''` 与 `undefined` 的区别：`''`/空白是"显式给了值"（例如本地 Ollama
 * 不需要密钥），`undefined` 才是"没给"。
 *
 * @param {object} params 渲染层传入的参数
 * @param {{baseUrl?:string, apiKey?:string}} fallback 磁盘设置中的同源配置
 * @returns {{baseUrl:string, apiKey:string, source:'params'|'settings'}}
 */
function resolveLlmEndpoint(params, fallback) {
  const settings = fallback || {};
  const paramBaseUrl = typeof params.baseUrl === 'string' && params.baseUrl.trim() ? params.baseUrl : '';
  const paramApiKey = params.apiKey === undefined ? undefined : String(params.apiKey ?? '');

  if (paramBaseUrl || paramApiKey !== undefined) {
    return {
      baseUrl: paramBaseUrl || settings.baseUrl || '',
      apiKey: paramApiKey === undefined ? '' : paramApiKey,
      source: 'params'
    };
  }
  return {
    baseUrl: settings.baseUrl || '',
    apiKey: String(settings.apiKey ?? ''),
    source: 'settings'
  };
}

/* ============================================================================
 *  超时预算（item 14）
 * ========================================================================== */

/*
  为什么需要两组超时，而不是一个：
    · IDLE：从"请求发出"到"首字节到达"，以及任意两次数据之间的最大间隔。
      服务端接受了连接却一直不吐字（挂住/被中间设备黑洞）时，靠它兜底；
      正常的长回答只要持续有 token 就永远不会触发。
    · TOTAL：整条流的硬上限，防止"每 30 秒吐一个字"这种能把连接拖到天荒地老
      的行为（不设上限时发送状态可以永远挂着）。
  两者都可被调用方覆盖（params.idleTimeoutMs / params.totalTimeoutMs），
  便于将来做成设置项而不用改这里的逻辑。
*/
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;

/** 把调用方传入的超时收敛到合法区间（非法/缺失即用默认值） */
function resolveTimeout(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 1000), 60 * 60 * 1000);
}

/**
 * 给一个 AbortController 装上"空闲超时 + 总时长上限"。
 * @returns {{touch:()=>void, clear:()=>void, timedOut:()=>boolean}}
 */
function createTimeoutGuard(controller, idleTimeoutMs, totalTimeoutMs) {
  let idleFired = false;
  let totalFired = false;

  /* 手动 abort（llm:abort）与超时 abort 都走同一个 signal，靠标记区分文案 */
  const idleTimer = setTimeout(() => {
    idleFired = true;
    controller.abort();
  }, idleTimeoutMs);

  const totalTimer = setTimeout(() => {
    totalFired = true;
    controller.abort();
  }, totalTimeoutMs);

  /* 定时器不该拖住进程退出（与 settings.js 的 writeTimer 同款写法） */
  idleTimer.unref?.();
  totalTimer.unref?.();

  return {
    /* 每收到一个 chunk 调用一次：重置空闲计时 */
    touch() {
      if (!idleFired && !totalFired) idleTimer.refresh();
    },
    clear() {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    },
    timedOut() {
      return idleFired || totalFired;
    }
  };
}

/* ============================================================================
 *  SSE 解析
 * ========================================================================== */

/**
 * 规范化 baseUrl：接受
 *   https://api.openai.com/v1        → .../chat/completions
 *   https://api.openai.com/v1/       → 同上
 *   https://api.openai.com           → .../v1/chat/completions
 *   https://host/v1/chat/completions → 原样使用
 */
function resolveChatUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置 LLM Base URL');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 解析一个 SSE 事件块，抽出增量文本。
 * @param {string} block 形如 "data: {...}\n\n"
 * @param {(delta:string, raw:object)=>void} onDelta
 * @returns {{done:boolean}}
 */
function parseSseBlock(block, onDelta) {
  const dataLines = [];
  for (const line of block.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed || trimmed.startsWith(':')) continue; /* 注释/心跳 */
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ''));
    }
    /* event: / id: / retry: 行按需忽略，不影响内容抽取 */
  }
  if (!dataLines.length) return { done: false };

  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return { done: true };

  try {
    const obj = JSON.parse(payload);
    /* 兼容 OpenAI Chat Completions 与部分兼容实现的差异 */
    const choice = obj?.choices?.[0];
    const delta =
      choice?.delta?.content ??
      choice?.delta?.reasoning_content ??
      choice?.text ??
      '';
    if (delta) onDelta(delta, obj);
    return { done: false };
  } catch (_) {
    /* 单块解析失败不应中断整条流 */
    return { done: false };
  }
}

/* ============================================================================
 *  流式请求
 * ========================================================================== */

/**
 * 发起流式对话请求。
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.idleTimeoutMs] 首字节/两次数据之间的最大间隔
 * @param {number} [opts.totalTimeoutMs] 整条流的硬上限
 * @param {string} opts.requestId
 * @param {(delta:string)=>void} onDelta
 */
async function streamChat(opts, onDelta) {
  const { requestId } = opts;
  const url = resolveChatUrl(opts.baseUrl);

  const body = {
    model: opts.model,
    messages: opts.messages || [],
    stream: true,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048
  };

  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const controller = new AbortController();
  inflight.set(requestId, controller);
  const idleTimeoutMs = resolveTimeout(opts.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  const totalTimeoutMs = resolveTimeout(opts.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
  const guard = createTimeoutGuard(controller, idleTimeoutMs, totalTimeoutMs);

  /*
    超时文案统一在 process 侧拼装：用户在界面上看到的是
    "LLM 请求超时（… 内没有收到数据，总时长上限 …），已中止"，
    既知道发生了什么，也知道该调什么（换端点 / 查服务端）。
    @param {boolean} afterFirstByte 是否已经收到过数据（用于区分两种超时）
  */
  const timeoutMessage = (afterFirstByte) =>
    afterFirstByte
      ? `LLM 请求超时（${Math.round(idleTimeoutMs / 1000)}s 内没有收到新数据，总时长上限 ${Math.round(totalTimeoutMs / 1000)}s），已中止`
      : `LLM 请求超时（${Math.round(idleTimeoutMs / 1000)}s 内没有响应，总时长上限 ${Math.round(totalTimeoutMs / 1000)}s），已中止`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    guard.clear();
    inflight.delete(requestId);
    if (e.name === 'AbortError') {
      if (guard.timedOut()) throw new Error(timeoutMessage(false));
      throw new Error('请求已取消');
    }
    throw new Error(`无法连接 LLM 服务（${url}）: ${e.message}`);
  }

  if (!res.ok) {
    guard.clear();
    inflight.delete(requestId);
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch (_) {
      /* 忽略读取正文失败 */
    }
    throw new Error(`LLM 返回 ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }

  if (!res.body) {
    guard.clear();
    inflight.delete(requestId);
    throw new Error('LLM 响应无正文流');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let stopped = false;

  try {
     
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      /* 收到数据就把空闲计时重置：只要还在持续吐字就不会被超时打断 */
      guard.touch();
      buffer += decoder.decode(value, { stream: true });

      /*
        SSE 事件以空行分隔。这里同时兼容 \n\n 与 \r\n\r\n，
        且保留最后一个不完整块等待后续 chunk。
      */
      let sepIndex;
       
      while ((sepIndex = findBlockBoundary(buffer)) !== -1) {
        const block = buffer.slice(0, sepIndex.index);
        buffer = buffer.slice(sepIndex.index + sepIndex.length);
        const { done: streamDone } = parseSseBlock(block, (delta) => {
          full += delta;
          onDelta(delta);
        });
        if (streamDone) {
          stopped = true;
          break;
        }
      }
    }
    /* 处理结尾残留（某些实现最后一块没有空行收尾） */
    if (!stopped && buffer.trim()) {
      parseSseBlock(buffer, (delta) => {
        full += delta;
        onDelta(delta);
      });
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      /*
        主动取消与超时必须区分：
          · 用户点「停止」→ 静默收尾，已经流出来的内容保留（原行为）。
          · 超时中止 → 必须**抛错**。只返回 aborted 的话，界面上表现为
            "回答莫名其妙停住了"，用户既不知道发生了什么，也无从判断
            该重试还是该换端点。抛错会经 runWithEvents 落一条 error 事件
            与一条日志，UI 拿到明确文案；已经收到的部分文本仍在 full 里，
            由调用方决定要不要保留。
      */
      if (guard.timedOut()) {
        throw new Error(timeoutMessage(full.length > 0));
      }
      return { text: full, aborted: true };
    }
    throw e;
  } finally {
    guard.clear();
    inflight.delete(requestId);
    try {
      reader.releaseLock();
    } catch (_) {
      /* 忽略 */
    }
  }

  return { text: full, aborted: false };
}

/** 找到 SSE 事件块边界，返回 {index, length} */
function findBlockBoundary(buf) {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1 && b === -1) return -1;
  if (a !== -1 && (b === -1 || a < b)) return { index: a, length: 2 };
  return { index: b, length: 4 };
}

/* ============================================================================
 *  对外调用
 * ========================================================================== */

/**
 * 使用设置中的默认 LLM 引擎。
 * @param {{messages:Array, model?:string, temperature?:number, maxTokens?:number}} params
 */
async function callLlm(params = {}) {
  const settings = getBackendSettings();
  const llm = settings.llm || {};
  const requestId = params.requestId || nextRequestId();
  /* item 5：baseUrl 与 apiKey 成对取自同一来源，详见 resolveLlmEndpoint */
  const endpoint = resolveLlmEndpoint(params, llm);

  return runWithEvents(requestId, {
    baseUrl: endpoint.baseUrl,
    model: params.model || llm.model,
    apiKey: endpoint.apiKey,
    temperature: params.temperature !== undefined ? params.temperature : llm.temperature,
    maxTokens: params.maxTokens !== undefined ? params.maxTokens : llm.maxTokens,
    idleTimeoutMs: params.idleTimeoutMs,
    totalTimeoutMs: params.totalTimeoutMs,
    messages: params.messages || []
  });
}

/**
 * 使用独立配置的自定义 LLM 引擎（会话级覆盖）。
 */
async function callCustomLlm(params = {}) {
  const settings = getBackendSettings();
  const llm = settings.llm || {};
  const custom = llm.custom || {};
  const requestId = params.requestId || nextRequestId();

  /*
    自定义引擎没配 baseUrl 时回落到默认引擎 —— 注意回落的是**整对**
    （默认 baseUrl + 默认 apiKey），而不是"自定义 baseUrl + 默认 apiKey"。
    后者正是 item 5 要消灭的混合来源。
  */
  const fallback = custom.baseUrl
    ? { baseUrl: custom.baseUrl, apiKey: custom.apiKey }
    : { baseUrl: llm.baseUrl, apiKey: llm.apiKey };
  const endpoint = resolveLlmEndpoint(params, fallback);
  const model = params.model || custom.model || llm.model;

  if (!endpoint.baseUrl) throw new Error('未配置自定义 LLM 的 Base URL');
  if (!model) throw new Error('未配置自定义 LLM 的模型标识');

  return runWithEvents(requestId, {
    baseUrl: endpoint.baseUrl,
    model,
    apiKey: endpoint.apiKey,
    temperature: params.temperature !== undefined ? params.temperature : llm.temperature,
    maxTokens: params.maxTokens !== undefined ? params.maxTokens : llm.maxTokens,
    idleTimeoutMs: params.idleTimeoutMs,
    totalTimeoutMs: params.totalTimeoutMs,
    messages: params.messages || []
  });
}

/** 统一的流式执行 + 事件派发 */
async function runWithEvents(requestId, opts) {
  const started = Date.now();
  bus.emit('stream', { requestId, type: 'start', at: started });

  try {
    const result = await streamChat(opts, (delta) => {
      bus.emit('stream', { requestId, type: 'delta', content: delta });
    });

    bus.emit('stream', {
      requestId,
      type: result.aborted ? 'aborted' : 'done',
      content: result.text,
      elapsedMs: Date.now() - started
    });

    logging.log(
      'info',
      `[llm] ${requestId} ${result.aborted ? '已取消' : '完成'} model=${opts.model} 字符=${result.text.length} 耗时=${Date.now() - started}ms`
    );

    return result.text;
  } catch (e) {
    bus.emit('stream', {
      requestId,
      type: 'error',
      message: String(e.message || e),
      elapsedMs: Date.now() - started
    });
    logging.log('error', `[llm] ${requestId} 失败 model=${opts.model}: ${e.message}`);
    throw e;
  }
}

/**
 * 中止一个进行中的请求。
 * @param {string} requestId
 */
function abortLlm(requestId) {
  const controller = inflight.get(requestId);
  if (!controller) return { ok: false, message: '该请求不存在或已结束' };
  try {
    controller.abort();
    return { ok: true, requestId };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/** 中止全部进行中的请求（退出/切页时使用） */
function abortAll() {
  const ids = Array.from(inflight.keys());
  for (const id of ids) abortLlm(id);
  return { ok: true, aborted: ids.length };
}

function inflightCount() {
  return inflight.size;
}

/* ============================================================================
 *  模型列表
 * ========================================================================== */

/**
 * 查询可用模型。
 * 优先请求后端 /v1/models（真实可用模型），失败后退化为扫描本地模型目录。
 */
async function listModels() {
  const settings = getBackendSettings();
  const llm = settings.llm || {};

  if (llm.baseUrl) {
    try {
      const base = String(llm.baseUrl).trim().replace(/\/+$/, '');
      const url = /\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
      const headers = {};
      if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data?.data) ? data.data : [];
        const models = list
          .map((m) => String(m?.id || '').trim())
          .filter(Boolean)
          .map((id) => ({ id, name: id, source: 'api' }));
        if (models.length) {
          logging.log('info', `[llm] 从 ${url} 获取到 ${models.length} 个模型`);
          return { ok: true, models, source: 'api', message: `共 ${models.length} 个模型` };
        }
      }
    } catch (e) {
      logging.log('warn', `[llm] 拉取模型列表失败，回退本地扫描: ${e.message}`);
    }
  }

  /* 退化路径：扫描受管的 models 目录（适合本地部署 llama.cpp 等场景） */
  const fs = require('fs');
  const paths = require('../paths');
  const modelsDir = paths.getMaibotPaths().modelsDir;
  try {
    if (!fs.existsSync(modelsDir)) {
      return { ok: false, models: [], source: 'none', message: '后端未提供模型列表，且本地模型目录不存在' };
    }
    const files = fs
      .readdirSync(modelsDir)
      .filter((f) => /\.(gguf|bin|safetensors)$/i.test(f))
      .map((f) => ({ id: f, name: f, source: 'local' }));
    return {
      ok: files.length > 0,
      models: files,
      source: 'local',
      message: files.length ? `本地目录发现 ${files.length} 个模型` : '本地模型目录为空'
    };
  } catch (e) {
    return { ok: false, models: [], source: 'none', message: `扫描模型目录失败: ${e.message}` };
  }
}

module.exports = {
  bus,
  callLlm,
  callCustomLlm,
  abortLlm,
  abortAll,
  inflightCount,
  listModels,
  nextRequestId,
  resolveChatUrl,
  resolveLlmEndpoint,
  parseSseBlock
};
