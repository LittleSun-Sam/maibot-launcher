/*
================================================================================
技术文档：src/main/services/updater.js
职责：**启动器自身**的检查更新 / 下载安装包 / 启动安装程序。
================================================================================
  为什么单独一个模块，而不是塞进 services/github.js：
    github.js 管的是"被管理的服务"（MaiBot / SnowLuma）的安装升级 ——
    它的路径策略、备份交换、版本目录布局全都围绕**用户数据目录**展开。
    而启动器更新是另一件事：附件要落到系统临时目录、校验依据是 Release
    元数据里的字节数、安装动作是"启动一个 NSIS 安装包然后自己退出"。
    两者的失败后果与安全边界都不同，混在一个文件里必然互相牵连
    （最典型的是路径白名单：安装包落在临时目录，和麦麦安装目录毫无关系）。

  本模块提供的三件事（IPC 名见 services/index.js）：
    check()   —— 读 GitHub 最新 Release，与 app.getVersion() 做语义化版本比较
    download()—— 按通道顺序下载安装包，边下边推真实进度，最后校验字节数
    install() —— 用系统默认方式启动已校验的安装包，然后退出启动器

  ⚠️ 三条不许退让的诚实性要求（都是"看起来能用、实际骗人"的重灾区）：
    1) 未配置更新源时**如实返回"未配置更新源"**，绝不假装检查成功 ——
       假装成功会让用户以为"已是最新"，从此永远收不到更新。
    2) 每个下载通道失败时**逐个记下真实原因**（HTTP 状态 / 超时 / 字节数不符），
       全部失败时把这些原因一起给用户。笼统一句"网络错误"等于没有信息。
    3) 安装前必须说明**会发生什么**（退出启动器 + 打开安装程序），
       并且只有"真的下载并校验通过"的包才允许安装 —— 不做任何猜测性启动。
================================================================================
*/
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { app, shell } = require('electron');

const logging = require('../logging');
const { sendToRenderer } = require('../windows');
const { UPDATE } = require('../constants');

/* ============================================================================
 *  HTTP 传输层：为什么必须是 node:https，而不是全局 fetch
 * --------------------------------------------------------------------------
 *  真实故障（2026-09-27 实测，CDP 直调 checkLauncherUpdate）：
 *      {"ok":false,"configured":true,"reason":"network","current":"2.1.0",
 *       "message":"连接更新服务器失败：fetch failed（…/releases/latest）"}
 *    而**同一个 URL** 用 PowerShell Invoke-RestMethod、用原生 node（非 Electron）
 *    请求都是通的（api.github.com 约 2.8s 返回）。
 *
 *  真因（2026-09-27 现场实测，比"吊销检查"更具体）：本机 hosts 把
 *  api.github.com 指向 127.0.0.1，而 :443 被本机 HTTPS 加速器
 *  （Steam++ Accelerator / Watt Toolkit，pid 11400）占用，它用自签的
 *  `CN=SteamTools Certificate, O=BeyondDimension` 根证书重新签发。
 *  该根证书装在 **Windows 证书存储**里（Cert:\LocalMachine\Root），
 *  因此走系统存储的客户端（PowerShell / Schannel）一切正常；
 *  而 Electron 的 fetch 走 Chromium 网络栈、node:https 走 Node 自带的
 *  CA 列表 —— 两者都**不读 Windows 根存储**，于是都判"证书不受信任"：
 *      · node:https 原始报错：unable to verify the first certificate
 *      · Electron fetch 只剩一句：fetch failed（真因挂在 e.cause 上）
 *      · curl 同一条线路：schannel: CRYPT_E_NO_REVOCATION_CHECK
 *
 *  这也是为什么**不能**用 net.request（同样是 Chromium 栈，同一个病根），
 *  更**不能**用 ignore-certificate-errors 之类的开关：那是"把证书校验整体关掉"
 *  ——为了一个本机网络特性把整条 TLS 校验拿掉，是拿安全性换连通性。
 *
 *  修法是两件事一起做（缺一不可，实测缺第二件就必然是
 *  "unable to verify the first certificate"）：
 *    1) 传输改用 node:http/https（Node 自己的 OpenSSL 栈），
 *       不再走 Chromium 网络栈；
 *    2) 把 **Windows 根证书存储**里的根证书作为额外 trust anchor 喂给它
 *       （见 loadOsCaBundle）。这不是"关掉校验"：证书链、主机名、
 *       有效期、签名该验的一样没验；只是把"操作系统认为可信的根"
 *       也纳入 Node 的信任集合 —— 与 Edge / PowerShell 的判断基准一致。
 *       原来的公共 CA 列表**继续有效**（ca 选项是**追加**，不是替换）。
 *
 *  超时/停滞/进度/重定向的全部原语义在下面逐个保留：
 *    · timeoutMs —— 检查更新的请求总超时（含响应体读取）
 *    · stallMs   —— 下载时多久没收到字节就判定通道卡死
 *    · progressThrottleMs —— 进度帧节流（在 downloadOnce 里）
 *    · 重定向必须跟（GitHub 与各加速通道都会 302）
 * ========================================================================== */

/** 单次请求的兜底超时（防止某个 URL 在 DNS/TCP 阶段无声挂住） */
const HTTP_CONNECT_TIMEOUT_MS = 15000;

/** 跟随重定向的最大跳数（GitHub Release 附件 → objects/release-assets 一般 1~2 跳） */
const MAX_REDIRECTS = 10;

/**
 * 读取 Windows 根证书存储，拼成 PEM，作为额外的 trust anchor。
 *
 * 为什么要这么绕（而不是 `--use-system-ca`）：
 *   `--use-system-ca` 是**命令行开关**，而启动器是用户双击起来的 ——
 *   没法保证它带上这个开关（改用户快捷方式更不是启动器该做的事）。
 *   所以这件事必须在代码里做。
 *
 * ⚠️ 安全边界（写清楚，避免以后有人"顺手放宽"）：
 *   · 只读 **Root** 存储里的根证书，且只把它们当**根**用 ——
 *     链上每一环该验的还是 Node/OpenSSL 在验；
 *   · 不做指纹白名单（那会把"用户装的合法企业根"一起挡掉，
 *     也会让这份代码变成"只有本机能用"）；
 *   · 读取失败（非 Windows、PowerShell 不可用、超时）就**退回自带 CA 列表**
 *     并如实记一条日志 —— 绝不因为"读不到系统根"就放宽为不校验证书。
 *   · 想关掉这个行为：环境变量 MAIBOT_LAUNCHER_UPDATE_OS_CA=0。
 *
 * @returns {Promise<Buffer|null>} PEM 内容；读不到时 null
 */
let osCaPromise = null;

function loadOsCaBundle() {
  if (osCaPromise) return osCaPromise;

  osCaPromise = (async () => {
    if (process.platform !== 'win32') return null;
    if (String(process.env.MAIBOT_LAUNCHER_UPDATE_OS_CA || '') === '0') {
      logging.log('info', '[updater] 已按 MAIBOT_LAUNCHER_UPDATE_OS_CA=0 关闭系统根证书加载');
      return null;
    }

    /*
      用 PowerShell 读证书存储：
        两个 Root 存储都读（LocalMachine 是机器级，CurrentUser 是用户级，
        企业/代理根通常其中一个有）；去重交给 OpenSSL（重复根无害）。
      输出走 Base64：证书主题里有中文/特殊字符时，直接输出 PEM 会踩控制台
      编码的坑（本机实测就是 GBK 代码页），Base64 与编码无关。
    */
    const script = [
      "$ErrorActionPreference='Stop'",
      '$pem = @()',
      "foreach ($store in 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root') {",
      '  try {',
      '    foreach ($c in Get-ChildItem $store) {',
      '      $b = [Convert]::ToBase64String($c.RawData, "InsertLineBreaks")',
      '      $pem += "-----BEGIN CERTIFICATE-----`n$b`n-----END CERTIFICATE-----"',
      '    }',
      '  } catch { }',
      '}',
      '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($pem -join "`n"))))'
    ].join('\n');

    let stdout = '';
    try {
      const { execFile } = require('child_process');
      stdout = await new Promise((resolve, reject) => {
        const child = execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
          (err, out) => (err ? reject(err) : resolve(String(out || '')))
        );
        /* unref 掉，避免一个仍在跑的 powershell 拖住启动器退出 */
        if (child && typeof child.unref === 'function') child.unref();
      });
    } catch (e) {
      logging.log('warn', `[updater] 读取 Windows 根证书存储失败（改用 Node 自带 CA 列表）：${e?.message || e}`);
      return null;
    }

    const text = Buffer.from(stdout.trim(), 'base64').toString('utf8').trim();
    if (!/-----BEGIN CERTIFICATE-----/.test(text)) {
      logging.log('warn', '[updater] Windows 根证书存储读取结果为空（改用 Node 自带 CA 列表）');
      return null;
    }
    logging.log('info', `[updater] 已加载 Windows 根证书存储作为额外 trust anchor（${text.length} 字节 PEM）`);
    return Buffer.from(text, 'utf8');
  })();

  return osCaPromise;
}

/** 造一个语义与 fetch 的 AbortError 一致的错误（describeFetchError 认得它） */
function abortError(message) {
  const e = new Error(message || 'The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * 发出一次 HTTP(S) 请求并把响应流交出来。**不跟重定向**（见 requestStream / requestBuffer）。
 *
 * 为什么不用 fetch：
 *   见本段开头 —— 在 Electron 主进程里它走 Chromium 网络栈，
 *   会在本机这条线路上被证书吊销检查卡死（fetch failed）。
 *   这里用 Node 自己的 http/https 模块，走 OpenSSL，不做吊销检查。
 *
 * @returns {Promise<{status:number, statusText:string, headers:object, stream:stream.Readable, req:object}>}
 *   4xx/5xx 也走 resolve（调用方才能拿到真实状态码去拼可操作的中文报错），
 *   只有"连接根本没建立起来"（DNS/TCP/TLS）才 reject。
 */
function rawRequest(url, { method = 'GET', headers = {}, timeoutMs = HTTP_CONNECT_TIMEOUT_MS, body = null, ca = null } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new Error(`无效的 URL：${url}`));
      return;
    }

    const mod = target.protocol === 'http:' ? http : https;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    const req = mod.request(
      target,
      {
        method,
        /*
          ca 是**追加**到 Node 自带公共 CA 列表之上的额外 trust anchor
          （见 loadOsCaBundle 的说明）：公共 CA 依旧可信，只是把
          "操作系统认为可信的根"也纳入进来 —— 本机 HTTPS 加速器
          重新签发的链路就靠这一条才能验过去。
        */
        ...(ca ? { ca } : {}),
        headers: {
          /*
            Accept-Encoding 显式写成 identity：
            请求压缩响应会拿到 gzip 字节流，而后面按 Content-Length 与
            "收到多少字节"做进度/校验，压缩会让这两件事同时失真。
          */
          'Accept-Encoding': 'identity',
          ...headers
        }
      },
      (res) => {
        /*
          响应头到手后必须**撤掉这个兜底超时**：
          req.setTimeout 是"socket 空闲"的看门狗，而下载大文件时
          "响应体慢慢来"是正常状态 —— 留着它会在下载中途误杀请求。
          下载的停滞判定由 downloadOnce 的 stallMs（专门计时"收到字节"）负责。
        */
        req.setTimeout(0);
        settled = true;
        resolve({
          status: Number(res.statusCode) || 0,
          statusText: String(res.statusMessage || ''),
          headers: res.headers || {},
          stream: res,
          req
        });
      }
    );

    req.on('error', (e) => fail(e));
    /* 单次请求的兜底超时：是"连接建立/响应头"的看门狗，
       与下载用的 stallMs（收到字节的停滞）是两件事，语义不重叠。 */
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`请求超时（${timeoutMs}ms）`);
      e.name = 'TimeoutError';
      req.destroy(e);
    });

    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 流式请求：跟随重定向，把**最终响应**的流交给调用方自己消费。
 * 下载走这条（大文件不能先读进内存）。
 *
 * @param {string} url
 * @param {object} opts { headers, timeoutMs, onAbort(cb) }
 *   onAbort —— 把"外部想取消"这件事注册进来：调用方给一个
 *   `(abortFn) => ...`，收到 abortFn 后调用即可销毁底层请求。
 *   用回调而不是 AbortSignal，是为了让"取消/stall 超时"在 http/https
 *   上只有一条销毁路径（req.destroy），不会出现"信号已 abort 但 socket 还在读"。
 *
 *   ⚠️ 多线程分段时是**每条连接各调一次**（每段一个 onAbort），
 *   每次注册的销毁函数只作用于自己那条连接 —— 各段之间互不牵连。
 */
async function requestStream(url, { headers = {}, timeoutMs = HTTP_CONNECT_TIMEOUT_MS, onAbort = null } = {}) {
  const ca = await loadOsCaBundle();
  let current = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await rawRequest(current, { method: 'GET', headers, timeoutMs, ca });
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.location) {
      /* 重定向必须跟：GitHub 与各加速通道都会 302 到真正的存储地址 */
      res.stream.resume();
      current = new URL(String(res.headers.location), current).toString();
      continue;
    }
    if (onAbort) {
      /*
        onAbort 的契约放宽了一点点（多线程需要）：回调**只拿到销毁函数**时就
        必须立刻生效（不再要求调用方自己再调一次）。这样"注册"与"销毁"
        之间不存在窗口 —— 分段下载会在注册之后立刻查一次 controller.signal，
        于是"响应头已回来、取消按钮才被点"这种时序也能被覆盖。
      */
      onAbort((message) => res.req.destroy(abortError(message)));
    }
    return { ...res, url: current };
  }
  throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）：${url}`);
}

/** 读干一个响应流（带兜底超时，防止服务端发了头就不再发体） */
function collectBody(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    const timer = setTimeout(() => {
      const e = new Error(`请求超时（${timeoutMs}ms）`);
      e.name = 'TimeoutError';
      stream.destroy(e);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      clearTimeout(timer);
      finish(resolve, Buffer.concat(chunks));
    });
    stream.on('error', (e) => {
      clearTimeout(timer);
      finish(reject, e);
    });
  });
}

/**
 * 一次性请求（跟重定向），返回状态与**缓冲后的正文**。
 * 检查更新走这条 —— 响应体只有几 KB，先读进来再解析最简单可靠。
 *
 * @returns {Promise<{status:number, statusText:string, headers:object, body:string}>}
 */
async function requestBuffer(url, { method = 'GET', headers = {}, timeoutMs = HTTP_CONNECT_TIMEOUT_MS, body = null } = {}) {
  const ca = await loadOsCaBundle();
  let current = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await rawRequest(current, { method, headers, timeoutMs, body, ca });
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.stream.resume();
      current = new URL(String(res.headers.location), current).toString();
      continue;
    }
    const buf = await collectBody(res.stream, timeoutMs);
    return { status, statusText: res.statusText, headers: res.headers, body: buf.toString('utf8') };
  }
  throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）：${url}`);
}

/* ============================================================================
 *  常量与通道
 * ========================================================================== */

/** 进度与结果事件通道（preload 的 onUpdateProgress 订阅它） */
const PROGRESS_CHANNEL = 'update-progress';

/**
 * 进度阶段（与 github.js 的 phase 词表保持一致，界面可以复用同一套判断）：
 *   start     —— 刚开始，还没收到任何字节（正在探测通道）
 *   progress  —— 正在收字节
 *   verify    —— 收完了，正在核对字节数
 *   done      —— 校验通过
 *   error     —— 失败（message 里是真实原因）
 *   aborted   —— 用户取消
 */
const PHASE = {
  start: 'start',
  progress: 'progress',
  verify: 'verify',
  done: 'done',
  error: 'error',
  aborted: 'aborted'
};

/** 进行中的下载（支持取消）。同一时刻只允许一个 —— 下载的是同一个安装包。 */
let activeDownload = null;

/**
 * 把所有"还在飞的连接"销毁掉。
 *
 * 为什么多线程下这个必须单独存在：单连接时"取消"= 销毁那一个 req，
 * 而分段下载同时有四条连接 —— 只 abort 掉 AbortController 是不够的，
 * 各段要等到自己的下一次 stall 判定（最长 45 秒）才会松手，
 * 用户看到的是"点了取消，网卡还在满速跑 45 秒"。
 * 所以每条连接一建立就把自己的销毁函数交到这里登记，段结束时注销。
 *
 * 独立于 update:cancel 与"换通道"两种场景：两条路都要求"这一刻起不再收字节"。
 */
function abortAllActive(message) {
  if (!activeDownload) return;
  for (const destroy of Array.from(activeDownload.destroys)) {
    try {
      destroy(message || '下载已取消');
    } catch (_) {
      /* 已经销毁过了 —— 无害 */
    }
  }
}

/** 登记一条连接的销毁函数，返回注销函数 */
function registerActive(destroy) {
  if (!activeDownload) return () => {};
  activeDownload.destroys.add(destroy);
  return () => activeDownload.destroys.delete(destroy);
}

/**
 * 最近一次**成功**下载的记录，是 install() 的准入依据。
 * 只有 download() 的成功分支（经 rememberDownload）能写它 ——
 * 单独收口的原因是：install() 最终会启动一个 .exe，
 * "这个文件是本会话真下载并核对过字节数的"必须是唯一来源的事实，
 * 不能由渲染层递进来的路径自称。
 */
let lastDownload = null;

/* ============================================================================
 *  更新源配置
 * ========================================================================== */

/**
 * 读取更新源仓库（owner/repo 分开，理由见 constants.js 的 UPDATE 注释）。
 *
 * 环境变量 MAIBOT_LAUNCHER_UPDATE_REPO 可以整体覆盖成 'owner/repo'，
 * 唯一目的是让**测试不依赖真实网络**（scripts/verify-update.mjs 起本地假 API）。
 * 生产环境不设置这个变量，因此走常量里的真实值。
 *
 * @returns {{owner:string, repo:string, full:string}}
 */
function updateSource() {
  const override = String(process.env.MAIBOT_LAUNCHER_UPDATE_REPO || '').trim();
  if (override) {
    const [owner, ...rest] = override.split('/');
    return { owner, repo: rest.join('/'), full: override };
  }
  return {
    owner: String(UPDATE.owner || ''),
    repo: String(UPDATE.repo || ''),
    full: `${UPDATE.owner}/${UPDATE.repo}`
  };
}

/** 更新源是否已经配置好（占位值不算配置好） */
function updateConfigured() {
  const { owner, repo } = updateSource();
  if (!owner || !repo) return false;
  const holders = new Set((UPDATE.placeholders || []).map((s) => String(s).toUpperCase()));
  return !holders.has(owner.toUpperCase()) && !holders.has(repo.toUpperCase());
}

/**
 * 检查更新用的 API 基址。
 * 与 github.js 的 apiBase() 同样的可覆盖设计：让测试指向本地 HTTP 服务，
 * 从而"检查更新"这条路径可以在完全离线的环境里被真实跑通。
 */
function apiBase() {
  const override = String(process.env.MAIBOT_LAUNCHER_UPDATE_API || '').trim();
  return (override || 'https://api.github.com').replace(/\/+$/, '');
}

/**
 * 下载通道列表（按顺序尝试）。
 *
 * 每一项是一个**通道**而不是裸字符串，因为失败时要如实报告"是谁失败了"：
 * 只保留 URL 的话，界面上只能显示"第 2 个通道失败"，用户无从判断
 * 是镜像站挂了还是直连不通。label 就是给用户看的那个名字。
 *
 * @returns {Array<{label:string, prefix:string, isMirror:boolean}>}
 */
function downloadChannels() {
  const override = String(process.env.MAIBOT_LAUNCHER_UPDATE_MIRRORS || '').trim();
  const list = override
    ? override.split(',').map((s) => s.trim()).filter(Boolean)
    : (UPDATE.mirrors || []);

  return list.map((prefix) => {
    const clean = String(prefix || '').replace(/\/+$/, '');
    if (!clean) return { label: 'https://github.com（直连）', prefix: '', isMirror: false };
    return { label: clean, prefix: clean, isMirror: true };
  });
}

/** 把原始 GitHub 地址挂到某个通道前缀上（空前缀 = 直连原始地址） */
function viaChannel(url, prefix) {
  const clean = String(prefix || '').replace(/\/+$/, '');
  return clean ? `${clean}/${url}` : url;
}

/** 供界面显示的来源主机名（进度事件的 host 字段） */
function channelHost(channel) {
  if (!channel?.prefix) return 'github.com';
  try {
    return new URL(channel.prefix).host;
  } catch (_) {
    return channel.prefix;
  }
}

/** Release 附件地址（tag 形如 v2.1.1） */
function releaseAssetUrl(owner, repo, tag, fileName) {
  const name = String(fileName || '').split(/[\\/]/).pop();
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/* ============================================================================
 *  语义化版本比较
 * --------------------------------------------------------------------------
 *  为什么不能用字符串比较 / parseFloat：
 *    · 'v2.10.0' > 'v2.9.0' 字符串比较会判成**小于**（'1' < '9'），
 *      于是 2.10.0 用户永远收不到 2.9.0 之后的更新；
 *    · parseFloat('2.10.0') = 2.1，同样把 2.10.0 与 2.1.0 判成相等。
 *  所以这里做完整的 semver 比较：主.次.修订 + 预发布标识。
 *  预发布规则（与 semver 一致）：1.0.0-beta < 1.0.0 ——
 *  否则测试版会被当成正式版推给所有人。
 * ========================================================================== */

/**
 * 解析版本字符串 → { major, minor, patch, pre:[] }
 * 接受 'v' 前缀、缺省段（'2.1' → 2.1.0）、预发布（'-beta.1'）、
 * 构建元数据（'+sha'，semver 规定它**不参与**比较，所以先剥掉再看其余部分）。
 * 无法解析时返回 null（调用方必须如实报"无法比较"，不许猜）。
 */
function parseVersion(text) {
  const raw = String(text || '').trim().replace(/^[vV]/, '').split('+')[0];
  if (!raw) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
    pre: m[4] ? m[4].split('.').filter(Boolean) : [],
    raw
  };
}

/** 比较预发布标识数组：空数组（正式版）比任何预发布都大 */
function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
      continue;
    }
    /* 数字标识 < 字母标识（semver 规定） */
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个版本。
 * @returns {number} a>b → 1，a<b → -1，相等 → 0；任一无法解析 → NaN
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  return comparePre(pa.pre, pb.pre);
}

/* ============================================================================
 *  进度事件
 * ========================================================================== */

/**
 * 统一的进度帧。
 *   · received/total/percent —— 真实字节数，total 未知时为 0（界面不显示假百分比）
 *   · bytesPerSec/etaSec    —— 只在"确实在收且有总大小"时给，否则 null
 *   · channel               —— 当前走的通道（用户能看到是镜像还是直连）
 *   · attempts              —— 已失败并切走的通道明细（真实原因）
 */
function emitProgress(payload) {
  sendToRenderer(PROGRESS_CHANNEL, payload);
}

/* ============================================================================
 *  检查更新
 * ========================================================================== */

/**
 * 从 Release 里挑出**给 Windows 用的安装包**。
 *
 * 判据（顺序即优先级）：
 *   1) 排除 .blockmap / .yml / .json 这类元数据 —— 它们也在 assets 里，
 *      但下载它们等于下了一个几百字节的校验文件，装不上；
 *   2) 优先名字里带 'setup' / 'installer' 的 .exe（electron-builder 的
 *      NSIS 产物默认叫 <product> Setup <version>.exe）；
 *   3) 退而取最大的 .exe —— 安装包一定比别的可执行附件大；
 *   4) 再退而取最大的任意附件（有些发布只传了一个 zip）。
 *
 * @returns {{name:string,size:number,url:string}|null}
 */
function pickAsset(release, owner, repo) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const usable = assets.filter((a) => {
    const n = String(a?.name || '').toLowerCase();
    if (!n) return false;
    if (n.endsWith('.blockmap') || n.endsWith('.yml') || n.endsWith('.yaml')) return false;
    return true;
  });
  if (!usable.length) return null;

  const exes = usable.filter((a) => String(a.name).toLowerCase().endsWith('.exe'));
  const preferred = exes.filter((a) => /setup|installer/i.test(String(a.name)));
  const pool = preferred.length ? preferred : exes.length ? exes : usable;
  const best = pool.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
  if (!best) return null;

  const tag = release?.tag_name || release?.name || 'latest';
  return {
    name: best.name,
    size: Number(best.size) || 0,
    /*
      digest / sha256 一并带出来（GitHub REST 的 asset.digest 形如 'sha256:abc…'）。
      有它就能做**真正的哈希校验**，而不是"只对了大小"；没有也照样下，
      只是结果里会如实说成 verify:'size'。绝不因为"没有摘要"就跳过大小校验。
    */
    digest: String(best.digest || ''),
    sha256: String(best.sha256 || ''),
    /* 附件地址用 GitHub 的原始地址拼，而不是直接信任 API 返回的
       browser_download_url：那个字段在某些代理/镜像场景下会被改写，
       而"我们下载的到底是哪个仓库的哪个 tag"必须由我们自己确定。 */
    url: releaseAssetUrl(owner, repo, tag, best.name)
  };
}

/**
 * 检查更新。
 *
 * @returns {Promise<object>} 形状固定为
 *   { ok, configured, current, latest, hasUpdate, notes, publishedAt, asset, message }
 *   · ok:false 时 message 是**真实原因**（未配置 / HTTP 状态 / 超时 / 解析失败）
 *   · ok:true 且 hasUpdate:false 时 message 说明"已是最新版本"
 */
async function check() {
  const current = app.getVersion();
  const { owner, repo, full } = updateSource();

  if (!updateConfigured()) {
    /*
      未配置更新源：如实返回，**不发任何网络请求**。
      这不是"失败"，而是"这条能力还没接线" —— 界面上应当引导用户去配置，
      而不是显示一个含糊的"检查失败"让他反复重试。
    */
    return {
      ok: false,
      configured: false,
      reason: 'unconfigured',
      current,
      latest: '',
      hasUpdate: false,
      notes: '',
      publishedAt: '',
      asset: null,
      message: `未配置更新源：启动器的更新仓库地址仍是占位值（当前 ${full}）。请先在 src/main/constants.js 的 UPDATE 里填入真实的 owner / repo。`
    };
  }

  const url = `${apiBase()}/repos/${owner}/${repo}/releases/latest`;
  let res;
  try {
    /* 用 node:https（requestBuffer），不用全局 fetch ——
       原因见文件开头「HTTP 传输层」：Electron 里的 fetch 走 Chromium 网络栈，
       会因证书吊销检查失败而整条请求报 "fetch failed"（真因在 e.cause 里）。 */
    res = await requestBuffer(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MaiBot-Launcher-Updater',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeoutMs: UPDATE.timeoutMs
    });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `请求超时（${UPDATE.timeoutMs}ms）`
      : String(e?.message || e);
    logging.log('warn', `[updater] 检查更新失败：${reason}`);
    return {
      ok: false, configured: true, reason: 'network', current, latest: '', hasUpdate: false,
      notes: '', publishedAt: '', asset: null,
      message: `连接更新服务器失败：${reason}（${url}）`
    };
  }

  if (res.status < 200 || res.status >= 300) {
    /* 404 单独说清楚：仓库/发布不存在，比"检查失败"可操作得多 */
    const hint = res.status === 404
      ? `仓库或发布不存在：${full}（请确认 UPDATE 里的 owner/repo 与是否已发过 Release）`
      : res.status === 403
        ? 'GitHub API 限流（未认证请求每小时 60 次），请稍后再试'
        : `HTTP ${res.status} ${res.statusText || ''}`.trim();
    logging.log('warn', `[updater] 检查更新失败：HTTP ${res.status}`);
    return {
      ok: false, configured: true, reason: `http-${res.status}`, current,
      latest: '', hasUpdate: false, notes: '', publishedAt: '', asset: null,
      message: `检查更新失败：${hint}`
    };
  }

  let release;
  try {
    release = JSON.parse(res.body);
  } catch (e) {
    return {
      ok: false, configured: true, reason: 'parse', current, latest: '', hasUpdate: false,
      notes: '', publishedAt: '', asset: null,
      message: `更新信息解析失败：${e?.message || e}`
    };
  }

  const tag = String(release?.tag_name || release?.name || '').trim();
  if (!tag) {
    return {
      ok: false, configured: true, reason: 'no-tag', current, latest: '', hasUpdate: false,
      notes: '', publishedAt: '', asset: null,
      message: '最新的 Release 没有 tag 名称，无法比较版本'
    };
  }

  const cmp = compareVersions(tag, current);
  if (Number.isNaN(cmp)) {
    /* 版本号解析不了就如实说，绝不退回字符串比较去猜一个结论 */
    return {
      ok: false, configured: true, reason: 'bad-version', current, latest: tag,
      hasUpdate: false, notes: '', publishedAt: release?.published_at || '', asset: null,
      message: `无法比较版本号：最新发布是「${tag}」，当前版本是「${current}」`
    };
  }

  const hasUpdate = cmp > 0;
  const asset = pickAsset(release, owner, repo);
  const notes = String(release?.body || '');
  const publishedAt = String(release?.published_at || '');

  logging.log(
    'info',
    `[updater] 检查更新：当前 ${current} / 最新 ${tag} → ${hasUpdate ? '有新版本' : '已是最新'}`
  );

  return {
    ok: true,
    configured: true,
    current,
    latest: tag,
    hasUpdate,
    notes,
    publishedAt,
    asset,
    message: hasUpdate
      ? `发现新版本 ${tag}（当前 ${current}）`
      : `已是最新版本（${current}）`
  };
}

/* ============================================================================
 *  进度帧：单连接与多线程**共用同一套**数字
 * --------------------------------------------------------------------------
 *  为什么必须抽出来共用（而不是各写一份）：
 *    received / total / bytesPerSec / etaSec / percent 这五个数字是用户在
 *    进度条上唯一能看到的东西。一旦多线程那条路径自己算一份，两条路径就会
 *    慢慢漂移（比如一条算"平均速度"、另一条算"瞬时速度"），
 *    于是同一个下载任务在不同通道下显示的速度差好几倍 —— 用户没法判断
 *    到底是网络变了还是启动器在编数字。
 *
 *  多线程下 received 之所以仍然可信：每个段每收到一块就 add(chunk.length)，
 *  段重试时把该段已报过的字节**扣回去再从头报**（见 downloadSegmented），
 *  所以它是"盘上最终会有多少字节"的单调累加，不会重复计数、也不会跳变。
 * ========================================================================== */

/**
 * 造一帧进度（纯函数，不发事件）。
 *
 * @param {object} o
 * @param {string} o.phase
 * @param {string} o.fileName
 * @param {number} o.received 已下载总字节（分段时是各段之和）
 * @param {number} o.total    总大小（0 = 未知，此时不给百分比）
 * @param {number} o.startedAt 本次下载的起点（算平均速度用）
 * @param {string} o.channel  通道主机名（界面那一行只放得下主机名）
 * @param {number} [o.segments] 段数；只有多线程那条路径才给（单连接保持原样不给，
 *        免得改动老进度帧的形状 —— 界面在缺这个字段时不显示线程数，不会猜）
 */
function buildProgressPayload({ phase, fileName, received, total, startedAt, channel, segments }) {
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const bytesPerSec = received > 0 ? (received / elapsedMs) * 1000 : 0;
  const remaining = total > 0 ? total - received : 0;
  const payload = {
    phase,
    fileName,
    received,
    total,
    channel,
    bytesPerSec: Math.round(bytesPerSec),
    /*
      剩余时间只在"有总大小、确实在收数据、还没下完"时给。
      否则宁可为 null 让界面一个字都不显示 —— 编一个一直跳动的假数字
      比不显示更糟（用户会拿它做决定："再等 3 秒就好"）。
    */
    etaSec: total > 0 && bytesPerSec > 0 && remaining > 0
      ? Math.max(0, Math.round(remaining / bytesPerSec))
      : null,
    percent: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0
  };
  if (segments != null) payload.segments = segments;
  return payload;
}

/**
 * 一个下载通道上的"进度表"：聚合所有段的字节 + 按 progressThrottleMs 节流。
 * @returns {{add:(n:number)=>void, flush:(phase?:string, extra?:object)=>void}}
 */
function createProgressMeter({ fileName, total, channel, startedAt, segments = null }) {
  let received = 0;
  let lastEmit = 0;

  const payload = (phase, extra) => ({
    ...buildProgressPayload({ phase, fileName, received, total, startedAt, channel, segments }),
    ...(extra || {})
  });

  return {
    add(n) {
      received += n;
      const now = Date.now();
      if (now - lastEmit < UPDATE.progressThrottleMs) return;
      lastEmit = now;
      emitProgress(payload(PHASE.progress));
    },
    /** 无条件发一帧（start / verify / done / error / aborted 这些阶段帧不能丢） */
    flush(phase = PHASE.progress, extra) {
      lastEmit = Date.now();
      emitProgress(payload(phase, extra));
    }
  };
}

/* ============================================================================
 *  多线程分段下载
 * --------------------------------------------------------------------------
 *  参考实现是 services/github.js 的 downloadSegmented/resolveSegmentCount
 *  （那边管的是"被管理的服务"的安装包）。这里**刻意不 require 它**：
 *    · github.js 依赖设置模块、路径策略、备份交换那一整套（见本文件开头
 *      的对比说明），为了一个纯传输函数把那些牵连全拖进更新路径，
 *      任何一处变动都会同时影响两条互不相干的链路；
 *    · 更新下载另有自己的语义：按镜像回退、stallMs 停滞判定、
 *      update-progress 的进度形状、update:cancel 的取消路径。
 *  所以保留同一套**语义与算法**（0/1/>=2 的段数约定、段重试、206 判定），
 *  但按本模块的需求重写实现。
 * ========================================================================== */

/**
 * 更新下载的段数。
 *
 * 语义与 github.js 的 downloadThreads 完全一致（0=自动、1=单连接、>=2=指定），
 * 环境变量 MAIBOT_LAUNCHER_UPDATE_THREADS 优先于常量 —— 自测脚本与
 * "临时想试单连接/试 8 段"都靠它，不必改代码重新打包。
 */
function downloadThreads() {
  const override = String(process.env.MAIBOT_LAUNCHER_UPDATE_THREADS ?? '').trim();
  if (override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
    logging.log('warn', `[updater] 环境变量 MAIBOT_LAUNCHER_UPDATE_THREADS=${override} 不是合法的段数（需 ≥0 的整数），改用常量 ${UPDATE.threads}`);
  }
  const n = Number(UPDATE.threads);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 按 threads 语义与文件大小决定实际段数。上下限这里再夹一次：
 * 常量文件是用户可以改的，写个 999 不该让启动器真的开 999 条连接。
 * @returns {number} 1 = 单连接
 */
function resolveSegmentCount(threads, total) {
  const n = Number(threads) || 0;
  if (n === 1) return 1;
  const minBytes = Number(UPDATE.segmentMinBytes) || 4 * 1024 * 1024;
  if (!total || total < minBytes) return 1;
  const max = Math.max(1, Number(UPDATE.segmentMaxCount) || 8);
  if (n >= 2) return Math.min(max, Math.round(n));
  const target = Number(UPDATE.segmentTargetBytes) || 8 * 1024 * 1024;
  const bySize = Math.round(total / target);
  const min = Math.max(1, Number(UPDATE.segmentMinCount) || 3);
  return Math.max(min, Math.min(max, bySize));
}

/**
 * 从 Content-Range 头里取**服务端自报的总长**。
 * 形如 `bytes 0-1023/1048576`（也兼容 `bytes 0-1023/*`）。取不到返回 0。
 */
function parseContentRangeTotal(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 算文件的 SHA-256（流式读，91.8 MB 约 0.3 秒，不会整份读进内存） */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 把 Release 附件里可能的摘要字段规范成一个小写 hex sha256。
 * · asset.digest —— GitHub REST 的 `digest` 字段，形如 `sha256:abc…`
 * · asset.sha256 —— 有些发布工具会额外挂一个 `*.sha256` 附件/字段
 * 拿不到就返回 ''（此时**只**校验大小，并在结果里如实说成 size，不谎称 sha256）。
 */
function assetSha256(asset) {
  const d = String(asset?.digest || '').trim();
  if (d) {
    const hex = d.includes(':') ? d.slice(d.indexOf(':') + 1) : d;
    if (/^[0-9a-f]{64}$/i.test(hex.trim())) return hex.trim().toLowerCase();
  }
  const s = String(asset?.sha256 || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  return '';
}

/**
 * 分段并发下载同一个 URL 到同一个文件。
 *
 * 关键实现点（每一条都对应一个具体的坏结果）：
 *   · 先把文件预置成**完整长度**，各段用 'r+' 按偏移写 ——
 *     否则多段并发追加写会互相踩，出来的是乱序文件。
 *   · 每段独立销毁路径 + 独立停滞计时器：一段卡死不该拖住其它段。
 *   · 段失败**整段重取**（而不是从"已读字节"续传）：
 *     读到的字节数 ≠ 已落盘的字节数（WriteStream 里可能有排队未刷盘的块，
 *     pipeline 报错时那些块会被丢弃），拿它当断点会从错位的位置接着写，
 *     写出一个只有 sha256 才能发现的好文件 —— 重取几 MB 远比下坏文件划算。
 *   · 重取前把该段已上报的字节从进度里扣回去，否则重试越多进度越虚高。
 *   · 任一段回 200 而不是 206 → 立刻抛错（说明服务端不认 Range，
 *     把全量数据写到某段的偏移上会得到一堆重复数据）；调用方据此退回单连接。
 *
 * @returns {Promise<{ok:true, bytes:number, segments:number, total:number}>}
 * @throws 任一段重试耗尽 / 不支持 Range → 抛错，由调用方退回单连接
 */
async function downloadSegmented({ url, dest, total, count, channel, controller }) {
  const startedAt = Date.now();
  /*
    目录必须先建出来 —— 分段下载要先把文件预置成完整长度（稀疏文件），
    各段才能用 'r+'+start 按偏移写。单连接那条路径是在 downloadOnce 里建的，
    分段这条是独立的落盘流程，少了这一步会以
    "ENOENT: no such file or directory, open '<dest>'" 失败三轮然后退回单连接 ——
    表现成"多线程没生效"，但真因是文件根本没被创建。
  */
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const meter = createProgressMeter({
    fileName: path.basename(dest), total, channel: channelHost(channel), startedAt, segments: count
  });

  /*
    预置成**完整长度**的稀疏文件（truncate 到 0 再 truncate 到 total，
    确保目标是全新内容而不是上一次的残骸）。各段用 'r+'+start 按偏移写，
    互不重叠 —— 这是"并发写同一个文件"能成立的前提。
  */
  await fsp.writeFile(dest, '');
  await fsp.truncate(dest, total);

  const per = Math.ceil(total / count);
  const segs = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    if (start > end) break;
    segs.push({ index: segs.length, start, end, received: 0, attempts: 0 });
  }

  /* 分段请求用的固定头 */
  const headers = { 'User-Agent': 'MaiBot-Launcher-Updater' };
  const retry = Math.max(0, Number(UPDATE.segmentRetry) || 0);
  const SE = Symbol('segment-failed');

  const runSegment = async (seg) => {
    const need = seg.end - seg.start + 1;

    for (let attempt = 0; attempt <= retry; attempt += 1) {
      if (attempt > 0 && seg.received) {
        /* 上一次尝试的字节作废（下面从段起点整体重写），必须扣回进度 */
        meter.add(-seg.received);
        seg.received = 0;
      }
      if (controller.signal.aborted) throw abortError('下载已取消');

      seg.attempts = attempt + 1;
      let abort = null;
      let abortMessage = '';
      let lastByteAt = Date.now();
      let stallTimer = null;
      const abortNow = (message) => {
        abortMessage = message;
        if (abort) abort(message);
      };

      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (Date.now() - lastByteAt >= UPDATE.stallMs) abortNow(`传输停滞超过 ${UPDATE.stallMs}ms`);
          else armStall();
        }, UPDATE.stallMs);
        if (typeof stallTimer.unref === 'function') stallTimer.unref();
      };

      const onAbort = () => abortNow('下载已取消');
      controller.signal.addEventListener('abort', onAbort, { once: true });
      armStall();

      try {
        const from = seg.start;
        /*
          每一段都固定从 seg.start 开始写（刻意不做"按已读字节续传"，理由见函数注释）。
        */
        const res = await requestStream(url, {
          headers: { ...headers, Range: `bytes=${from}-${seg.end}` },
          onAbort: (destroy) => {
            abort = destroy;
            /* 请求已建立：把"外部取消"的注册补上（见 requestStream 的说明） */
            registerActive(destroy);
            if (controller.signal.aborted) abortNow('下载已取消');
          }
        });

        if (controller.signal.aborted) abortNow('下载已取消');

        if (res.status !== 206) {
          throw new Error(
            `分段请求未返回 206（实际 ${res.status}）—— 该通道不支持 Range 分段`
          );
        }
        /*
          服务端自报的总长（Content-Range: bytes a-b/TOTAL）。它与 Release 元数据
          是我们**唯一**的独立对照：如果某个镜像缓存了**另一个版本**的文件，
          这里的 TOTAL 会和元数据不一样 —— 立刻判该通道不可信并换下一个，
          绝不照着错的总长去拼一个"自己和自己一致"的坏包。
        */
        const serverTotal = parseContentRangeTotal(res.headers['content-range']);
        if (serverTotal > 0 && serverTotal !== total) {
          res.stream.resume();
          throw new Error(
            `该通道返回的文件总长是 ${serverTotal} 字节，Release 元数据是 ${total} 字节（镜像可能缓存了别的版本）`
          );
        }
        if (!res.stream) throw new Error('响应没有正文（服务端返回空）');

        const out = fs.createWriteStream(dest, { flags: 'r+', start: from });
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            seg.received += chunk.length;
            meter.add(chunk.length);
            lastByteAt = Date.now();
            cb(null, chunk);
          }
        });

        await pipeline(res.stream, counter, out);

        if (seg.received >= need) return;
        throw new Error(`本段只收到 ${seg.received}/${need} 字节`);
      } catch (e) {
        const why = abortMessage ? describeFetchError(abortError(abortMessage)) : describeFetchError(e);
        if (controller.signal.aborted) throw abortError('下载已取消');
        if (attempt >= retry) {
          const err = new Error(`分段 ${seg.start}-${seg.end} 重试 ${retry} 次后仍失败：${why}`);
          err[SE] = true;
          throw err;
        }
        logging.log(
          'warn',
          `[updater] 分段 ${seg.start}-${seg.end} 第 ${attempt + 1} 次失败，整段重取：${why}`
        );
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        controller.signal.removeEventListener('abort', onAbort);
      }
    }
    const err = new Error(`分段 ${seg.start}-${seg.end} 重试耗尽`);
    err[SE] = true;
    throw err;
  };

  emitProgress({
    phase: PHASE.start,
    fileName: path.basename(dest),
    received: 0,
    total,
    percent: 0,
    channel: channelHost(channel),
    segments: segs.length,
    message: `分 ${segs.length} 段并发下载`
  });

  try {
    await Promise.all(segs.map(runSegment));
  } finally {
    /* 取消/失败时把还在飞的段全部销毁 —— 否则换了通道还有旧连接在偷带宽 */
    abortAllActive();
  }

  const bytes = segs.reduce((sum, s) => sum + s.received, 0);
  if (bytes !== total) {
    const err = new Error(`各段合计 ${bytes} 字节，Release 元数据是 ${total} 字节`);
    err[SE] = true;
    throw err;
  }

  meter.flush(PHASE.progress);
  logging.log(
    'info',
    `[updater] 分段下载完成：${path.basename(dest)}（${bytes} 字节 / ${segs.length} 段，` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s，` +
      `${(bytes / 1048576 / Math.max(0.001, (Date.now() - startedAt) / 1000)).toFixed(2)} MB/s）`
  );
  return { ok: true, bytes, segments: segs.length, total };
}

/**
 * 选定要下载的附件。
 * 允许调用方直接给 asset（界面从 check 结果里带回来），避免"检查完再查一次"
 * 之间上游又发了新版本 —— 那会导致校验用的大小和实际下载的文件不是一回事。
 *
 * @returns {Promise<{asset:object}|{error:string}>}
 */
async function resolveAsset(opts) {
  const given = opts?.asset;
  if (given && typeof given === 'object' && given.url) {
    return {
      asset: {
        name: String(given.name || 'MaiBot-Launcher-Setup.exe'),
        size: Number(given.size) || 0,
        url: String(given.url),
        /* 摘要要一路带到 download()，否则"有 sha256 却只校验大小" */
        digest: String(given.digest || ''),
        sha256: String(given.sha256 || '')
      }
    };
  }
  const r = await check();
  if (!r.ok) return { error: r.message };
  if (!r.hasUpdate) return { error: r.message || '当前已是最新版本，无需下载' };
  if (!r.asset) return { error: `最新发布 ${r.latest} 里没有可用的安装包附件` };
  return { asset: { ...r.asset, tag: r.latest } };
}

/**
 * 下载一个通道：流式落盘 + 真实进度 + 停滞超时。
 * 失败时**自己把半截文件删掉**，不给下一个通道留下污染。
 *
 * @returns {Promise<{ok:true, bytes:number, dest:string}|{ok:false, message:string, bytes:number}>}
 */
async function downloadOnce({ url, dest, fileName, total, channel, controller, expected }) {
  const startedAt = Date.now();
  let received = 0;
  let lastEmit = 0;
  let lastTick = Date.now();
  let stallTimer = null;
  /*
    这条通道的"销毁路径"。为什么要单独一个变量而不是直接用 controller.signal：
    node:https 的取消只有一种正确做法 —— 把底层 req 销毁（req.destroy），
    所以 requestStream 会把销毁函数交回来，由这里统一用它响应
    「用户取消」与「停滞超时」两件事。
    abortMessage 记录**为什么**中断（是用户取消还是卡死），
    这样 describeFetchError 报出来的原因仍然如实（不会一律说成"用户取消"）。
  */
  let abortRequest = null;
  let abortMessage = '';
  const abortNow = (message) => {
    abortMessage = message;
    if (abortRequest) abortRequest(message);
  };
  /* 让"取消 / 换通道"能立刻销毁这条连接（与多线程那条路径同一套登记表） */
  let unregisterActive = () => {};

  const payload = (phase) => buildProgressPayload({
    phase,
    fileName,
    received,
    total: expected,
    startedAt,
    /* 进度帧里的 channel 用**主机名**（gh.xxooo.cf / ghproxy.net / github.com），
       不用通道的完整 URL：界面上那行只有一行宽，写全 URL 会被省略号截掉，
       用户反而看不出走的是哪个通道。
       （下载结果与 attempts 里保留完整的通道标识，日志里也留全。） */
    channel: channelHost(channel)
  });

  const emitThrottled = () => {
    const now = Date.now();
    if (now - lastEmit < UPDATE.progressThrottleMs) return;
    lastEmit = now;
    emitProgress(payload(PHASE.progress));
  };

  emitProgress({ ...payload(PHASE.start), total: expected, percent: 0, received: 0 });

  /* 用户可能在"探测通道"这一瞬间就点了取消 —— 那就不必再发请求了 */
  if (controller.signal.aborted) {
    return { ok: false, message: describeFetchError(abortError('下载已取消')), bytes: 0 };
  }
  controller.signal.addEventListener('abort', () => abortNow('下载已取消'), { once: true });

  let res;
  try {
    /* 同样走 node:https（requestStream）而不是 fetch：见文件开头「HTTP 传输层」。
       重定向在这里跟随（GitHub 与加速通道都会 302）。 */
    res = await requestStream(url, {
      headers: { 'User-Agent': 'MaiBot-Launcher-Updater' },
      onAbort: (destroy) => {
        abortRequest = destroy;
        unregisterActive = registerActive(destroy);
      }
    });
  } catch (e) {
    return { ok: false, message: `请求失败：${describeFetchError(e)}`, bytes: 0 };
  }

  /*
    ⚠️ 这里必须再查一次 signal：如果用户在"请求已发出、响应头还没回来"的窗口里
    点了取消，abort 事件在 abortRequest 注册之前就派发完了 ——
    只靠上面的 listener 会漏掉这次取消（请求照旧跑完）。
    （checked 在 abortRequest 赋值之后，所以这个窗口已经闭合。）
  */
  if (controller.signal.aborted) abortNow('下载已取消');

  if (res.status < 200 || res.status >= 300) {
    /* 错误响应体要读掉，否则 socket 会挂着不释放 */
    res.stream.resume();
    return {
      ok: false,
      message: `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`,
      bytes: 0
    };
  }
  if (!res.stream) return { ok: false, message: '响应没有正文（服务端返回空）', bytes: 0 };

  /* 停滞监测：超过 stallMs 没收到任何字节说明这条通道虽然握手成功但已经卡死，
     继续等下去用户只会盯着不动的进度条。 */
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      const idle = Date.now() - lastTick;
      if (idle >= UPDATE.stallMs) abortNow(`传输停滞超过 ${UPDATE.stallMs}ms`);
      else armStall();
    }, UPDATE.stallMs);
    if (typeof stallTimer.unref === 'function') stallTimer.unref();
  };
  armStall();

  let written = 0;
  let failed = null;
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        lastTick = Date.now();
        emitThrottled();
        cb(null, chunk);
      }
    });
    /* 源就是 node:https 的响应流，直接进管道（不必再从 Web 流转一次） */
    await pipeline(res.stream, counter, fs.createWriteStream(dest));
    written = received;
  } catch (e) {
    written = received;
    /*
    中止（用户取消 / 停滞超时）在 Node 里表现为流被销毁后抛出的
    ERR_STREAM_PREMATURE_CLOSE / AbortError，这里统一翻译成同一句话，
    与 fetch 版本的报错语义保持一致。
    */
    if (abortMessage) {
      const e2 = abortError(abortMessage);
      e2.cause = e;
      failed = describeFetchError(e2);
    } else {
      failed = describeFetchError(e);
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    unregisterActive();
  }

  if (failed) {
    /* 半截文件必须删掉：留着会让下一个通道的"追加/覆盖"判断出错 */
    try {
      await fsp.rm(dest, { force: true });
    } catch (_) {
      /* 删不掉也不影响失败结果的上报 */
    }
    return { ok: false, message: failed, bytes: written };
  }

  if (total > 0 && written !== total) {
    try {
      await fsp.rm(dest, { force: true });
    } catch (_) {
      /* 同上 */
    }
    return {
      ok: false,
      bytes: written,
      message: `字节数不符：收到 ${written} 字节，Release 元数据里是 ${total} 字节`
    };
  }

  return { ok: true, bytes: written, dest };
}

/** 把 fetch / 流的异常翻译成用户看得懂的一句话 */
function describeFetchError(e) {
  const name = e?.name || '';
  const msg = String(e?.message || e || '');
  if (name === 'AbortError' || /aborted/i.test(msg)) {
    return `传输中断（超过 ${Math.round(UPDATE.stallMs / 1000)} 秒没有收到数据，或连接被重置）`;
  }
  if (name === 'TimeoutError') return '连接超时';
  return msg || '未知错误';
}

/**
 * 在一个通道上下载：**优先多线程分段，失败/不支持 Range 时退回单连接**。
 *
 * 为什么两条路径都要在（而不是"只留多线程"）：
 *   `gh.xxooo.cf` 实测支持 Range（4 段各返回 206），但发布渠道是会被换的，
 *   任何一条通道都可能回 200 全量。此时若还按"段"去写，就会把整个文件
 *   写到某段的偏移上 —— 得到一个字节数看着对、内容全错的文件。
 *   所以：206 判定不过就立刻退回单连接，并且**用日志说明退回了**。
 *
 * @returns {Promise<{ok:boolean, bytes:number, message?:string, segments:number, mode:string}>}
 */
async function downloadChannel({ url, dest, fileName, total, channel, controller }) {
  const segments = resolveSegmentCount(downloadThreads(), total);

  if (segments > 1) {
    try {
      const r = await downloadSegmented({ url, dest, total, count: segments, channel, controller });
      return { ok: true, bytes: r.bytes, segments: r.segments, mode: 'segmented' };
    } catch (e) {
      const why = e?.name === 'AbortError' ? '下载已取消' : (e?.message || String(e));
      if (controller.signal.aborted) return { ok: false, bytes: 0, segments, mode: 'segmented', message: why };

      logging.log('warn', `[updater] 通道「${channel.label}」分段下载失败，退回单连接：${why}`);
      /*
        退回单连接前必须把半成品删掉：
        分段留下的是一个被 truncate 到 total 的稀疏文件，单连接 pipeline 会从
        偏移 0 覆盖写，一旦中途失败就会和残骸混在一起，字节数还可能是"对的"。
      */
      try {
        await fsp.rm(dest, { force: true });
      } catch (_) {
        /* 删不掉也不影响结论：下面单连接会重新写整份 */
      }
      emitProgress({
        phase: PHASE.start,
        fileName,
        received: 0,
        total,
        percent: 0,
        channel: channelHost(channel),
        segments: 1,
        message: '分段不可用，已退回单连接'
      });
    }
  }

  const r = await downloadOnce({
    url, dest, fileName, total, expected: total, channel, controller
  });
  return { ...r, segments: 1, mode: 'single' };
}

/**
 * 校验落盘的安装包。**两件事**，都不许自欺：
 *   1) 字节数必须等于 Release 元数据里的 size —— 这是最重要的一道，
 *      元数据独立于任何镜像，能同时拦住"下了一半"和"镜像缓存了别的版本"；
 *   2) 元数据里给了 sha256/digest 就一并比对（没有就只校验大小，
 *      并在结果里如实说成 size，绝不谎称"哈希校验通过"）。
 *
 * @returns {Promise<{ok:boolean, bytes:number, sha256:string, verify:string, message?:string}>}
 */
async function verifyDownloadedFile({ dest, expectSize, expectSha256 }) {
  let bytes = 0;
  try {
    bytes = (await fsp.stat(dest)).size;
  } catch (e) {
    return { ok: false, bytes: 0, sha256: '', verify: 'none', message: `安装包不可读：${e.message}` };
  }

  if (expectSize > 0 && bytes !== expectSize) {
    return {
      ok: false,
      bytes,
      sha256: '',
      verify: 'size',
      message: `字节数不符：磁盘上 ${bytes} 字节，Release 元数据里是 ${expectSize} 字节`
    };
  }

  if (!expectSha256) {
    return { ok: true, bytes, sha256: '', verify: expectSize > 0 ? 'size' : 'none' };
  }

  const sha256 = await hashFile(dest);
  if (sha256 !== String(expectSha256).toLowerCase()) {
    return {
      ok: false,
      bytes,
      sha256,
      verify: 'sha256',
      message: `SHA-256 校验不通过（期望 ${String(expectSha256).slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…）`
    };
  }
  return { ok: true, bytes, sha256, verify: 'sha256' };
}

/**
 * 下载安装包。
 *
 * 通道按 constants.js 里 UPDATE.mirrors 的顺序尝试（gh.xxooo.cf → ghproxy.net → 直连），
 * 每个通道失败都**记下真实原因**并继续下一个；全部失败时把这些原因一起返回。
 * 每个通道内**默认多线程分段**（段数见 UPDATE.threads / resolveSegmentCount），
 * 不支持 Range 或分段失败就退回单连接；同一通道内退回算**同一次尝试**
 * （通道回退与连接模式回退是两件事，不该把单连接也算成"又失败了一个通道"）。
 * 任一通道下载完成后，**必须**字节数与 Release 元数据一致才算成功。
 *
 * @param {object} [opts]
 * @param {object} [opts.asset] 可选的 {name,size,url,digest}（来自 check 的结果）
 * @returns {Promise<object>} { ok, dest, bytes, channel, segments, verify, attempts[], message }
 */
async function download(opts = {}) {
  if (activeDownload) {
    return { ok: false, message: '已有下载任务在进行中', busy: true };
  }

  const resolved = await resolveAsset(opts);
  if (resolved.error) return { ok: false, message: resolved.error };

  const asset = resolved.asset;
  const fileName = String(asset.name || '').split(/[\\/]/).pop();
  const dest = path.join(os.tmpdir(), 'maibot-launcher-update', fileName);
  const channels = downloadChannels();
  const controller = new AbortController();
  /*
    destroys 是"这一刻所有还在飞的连接"的销毁函数集合（多线程时有好几条）。
    取消、停滞、以及"分段失败退回单连接"都靠它把旧连接立刻收干净，
    不留下"点了取消但网卡还在满速跑"的尾巴。
  */
  activeDownload = { controller, dest, destroys: new Set() };

  const expectSha256 = assetSha256(asset);
  /** 每个通道的尝试记录（真实原因，不吞） */
  const attempts = [];
  const planned = resolveSegmentCount(downloadThreads(), Number(asset.size) || 0);
  logging.log(
    'info',
    `[updater] 开始下载 ${fileName}（${asset.size || '未知'} 字节，计划 ${planned > 1 ? `${planned} 段并发` : '单连接'}），` +
      `通道顺序：${channels.map((c) => c.label).join(' → ')}`
  );

  try {
    for (let i = 0; i < channels.length; i += 1) {
      const channel = channels[i];
      const url = viaChannel(asset.url, channel.prefix);
      const r = await downloadChannel({
        url,
        dest,
        fileName,
        total: Number(asset.size) || 0,
        channel,
        controller
      });

      if (r.ok) {
        /*
          校验阶段单独报一帧：91.8 MB 算 sha256 要几百毫秒，
          没有这一帧进度条会停在 99% 不动，用户会以为卡死了。
        */
        emitProgress({
          phase: PHASE.verify,
          fileName,
          received: r.bytes,
          total: r.bytes,
          percent: 99,
          channel: channelHost(channel),
          segments: r.segments,
          bytesPerSec: 0,
          etaSec: null,
          attempts
        });

        const v = await verifyDownloadedFile({
          dest, expectSize: Number(asset.size) || 0, expectSha256
        });
        if (!v.ok) {
          /* 校验不过 = 这条通道给的东西不对，删掉换下一个通道（不许当成功） */
          try {
            await fsp.rm(dest, { force: true });
          } catch (_) {
            /* 删不掉不影响"这条通道失败"的结论 */
          }
          logging.log('error', `[updater] ${fileName} ${v.message}（来源 ${channel.label}）`);
          attempts.push({ channel: channel.label, url, message: v.message, bytes: v.bytes });
          continue;
        }

        emitProgress({
          phase: PHASE.done,
          fileName,
          received: v.bytes,
          total: v.bytes,
          percent: 100,
          /*
            进度帧里的 channel 用**主机名**（gh.xxooo.cf / ghproxy.net / github.com），
            不用通道的完整 URL：界面上那行只有一行宽，
            写全 URL 会被省略号截掉，用户反而看不出走的是哪个通道。
            （下载结果与 attempts 里保留完整的通道标识，日志里也留全。）
          */
          channel: channelHost(channel),
          segments: r.segments,
          bytesPerSec: 0,
          etaSec: null,
          verify: v.verify,
          attempts
        });
        logging.log(
          'info',
          `[updater] 下载完成：${fileName}（${v.bytes} 字节，${r.segments > 1 ? `${r.segments} 段并发` : '单连接'}，` +
            `校验=${v.verify}，来源 ${channel.label}）`
        );
        /* 只有走到这里（字节数与 Release 元数据一致）才登记为"可安装" */
        rememberDownload({
          dest, bytes: v.bytes, channel: channel.label, sha256: v.sha256, verify: v.verify
        });
        return {
          ok: true,
          dest,
          bytes: v.bytes,
          /* 结果里给完整通道标识（是"哪条通道"，不是展示用的短名） */
          channel: channel.label,
          url,
          fileName,
          segments: r.segments,
          verify: v.verify,
          sha256: v.sha256,
          attempts,
          message: `已下载 ${fileName}（${v.bytes} 字节，${r.segments > 1 ? `${r.segments} 段并发` : '单连接'}），来源：${channel.label}`
        };
      }

      const record = {
        channel: channel.label,
        url,
        message: r.message,
        bytes: r.bytes
      };
      attempts.push(record);
      logging.log(
        'warn',
        `[updater] 通道「${channel.label}」失败：${r.message}` +
          (i + 1 < channels.length ? '，切换到下一个通道' : '（已是最后一个通道）')
      );

      /* 换通道之前把这条通道的连接全收掉，别让旧连接继续偷带宽 */
      abortAllActive();

      /* 用户点了取消：不再尝试剩余通道 */
      if (controller.signal.aborted) {
        emitProgress({
          phase: PHASE.aborted,
          fileName,
          received: r.bytes,
          total: Number(asset.size) || 0,
          percent: 0,
          channel: channelHost(channel),
          attempts
        });
        return { ok: false, canceled: true, attempts, message: '下载已取消' };
      }
    }

    const detail = attempts.map((a) => `· ${a.channel}：${a.message}`).join('\n');
    const message = `全部 ${channels.length} 个下载通道都失败了：\n${detail}`;
    activeDownload = null;
    emitProgress({
      phase: PHASE.error,
      fileName,
      received: 0,
      total: Number(asset.size) || 0,
      percent: 0,
      message,
      attempts
    });
    return { ok: false, dest: '', attempts, message };
  } finally {
    activeDownload = null;
  }
}

/**
 * 取消进行中的下载（用户在进度页点「取消」）。
 *
 * 两件事一起做，缺一不可：
 *   1) controller.abort() —— 让 downloadOnce / downloadSegmented 里那些
 *      "abort 事件监听"把控制流从 await 中拉出来（不然只是销毁了 socket，
 *      pipeline 的 Promise 还在原地等）；
 *   2) abortAllActive() —— 把**此刻所有还在飞的连接**（多线程时是好几条）
 *      立刻销毁。只做第 1 件的话，各段要等到自己下一次 stall 判定
 *      （最长 stallMs = 45 秒）才会松手 —— 用户点了取消，网卡还在满速跑。
 */
function cancel() {
  if (!activeDownload) return { ok: false, message: '当前没有进行中的下载' };
  try {
    activeDownload.controller.abort();
  } catch (_) {
    /* abort 本身不会抛，这里只是防御 */
  }
  abortAllActive();
  return { ok: true, message: '已请求取消下载' };
}

/* ============================================================================
 *  安装
 * ========================================================================== */

/**
 * 启动已下载并校验通过的安装包。
 *
 * ⚠️ 这个动作**必须**先把"会发生什么"说清楚：
 *    NSIS 一键安装包（electron-builder 的 oneClick）会自己完成安装，
 *    而正在运行的启动器占着要替换的 exe，所以只能先退出。
 *    一个不说清就消失的应用，用户会以为是崩溃。
 *
 * 四道拒绝（都不许"猜着继续"）：
 *   1) 没有下载过的包 → 拒绝（不可能"直接装一个不存在的文件"）；
 *   2) 安装包必须落在本模块自己的临时目录里 → 拒绝执行任意路径
 *      （这条通道最终会 spawn/openPath 一个 .exe，不能接受渲染层给的路径）；
 *   3) 附件必须是 .exe / .msi → 否则 openPath 只是"打开压缩软件"，装不上还退出了启动器；
 *   4) 文件不存在 / 字节数与 Release 元数据不一致 → 拒绝并说明差在哪。
 *
 * @param {object} [opts]
 * @param {string} [opts.dest] 期望的安装包路径（默认用刚下载的那个）
 * @returns {Promise<object>} { ok, path, willQuit, message }
 */
async function install(opts = {}) {
  const requested = String(opts?.dest || '').trim();
  const remembered = lastDownload?.dest || '';
  const dest = requested || remembered;

  if (!dest) {
    return { ok: false, message: '还没有下载好的安装包，请先点「更新」完成下载' };
  }

  const staging = path.join(os.tmpdir(), 'maibot-launcher-update');
  const resolved = path.resolve(dest);
  const allowedRoot = path.resolve(staging) + path.sep;
  if (!resolved.toLowerCase().startsWith(allowedRoot.toLowerCase())) {
    return {
      ok: false,
      message: `拒绝启动这个路径下的程序：${resolved}（只允许启动由本启动器下载到 ${staging} 的安装包）`
    };
  }

  /*
    附件必须是**安装程序**（.exe / .msi）。
    为什么单列一道：shell.openPath 是"用系统默认方式打开它"，
    如果 Release 里挂的是 .zip / .7z / .tar.gz，那这一下就是"打开压缩软件"
    —— 启动器随后退出，用户却什么都没装上（甚至不知道刚才发生了什么）。
    宁可在这里说清楚"这个附件不是安装程序"。
    （放在"存在性"之前：路径类型不对时，"不是安装程序"比 ENOENT 更可操作。）
  */
  if (!/\.(exe|msi)$/i.test(resolved)) {
    return {
      ok: false,
      message: `拒绝启动这个文件：${path.basename(resolved)} 不是安装程序（只支持 .exe / .msi）。请确认 Release 里挂的是安装包。`
    };
  }

  let size = 0;
  try {
    size = (await fsp.stat(resolved)).size;
  } catch (e) {
    return { ok: false, message: `安装包不存在或不可读：${resolved}（${e.message}）` };
  }

  /* 只有"本次会话里真下载过、且记录过期望大小"的包才允许安装。
     拿磁盘上一个陌生文件去执行是本项目一直在防的那类问题。 */
  if (!lastDownload || path.resolve(lastDownload.dest) !== resolved) {
    return {
      ok: false,
      message: `拒绝安装未经本启动器校验的文件：${resolved}。请先点「更新」重新下载一次。`
    };
  }

  const expected = Number(lastDownload.expectedSize) || 0;
  if (expected > 0 && size !== expected) {
    return {
      ok: false,
      message: `安装包字节数不符（磁盘上 ${size}，Release 元数据里 ${expected}），已拒绝安装`
    };
  }

  /*
    下载时校验过摘要，这里**再校验一次**：
    下载完成到用户点「重启并安装」之间，文件一直躺在临时目录里 ——
    这段时间足够别的进程把它换掉。安装前重算一次 sha256 成本约 0.3 秒，
    而漏掉它意味着"我们以为自己在安装一个校验过的包"这句话不再成立。
  */
  if (lastDownload.sha256) {
    const actual = await hashFile(resolved);
    if (actual !== String(lastDownload.sha256).toLowerCase()) {
      return {
        ok: false,
        message: `安装包 SHA-256 与下载时不一致（磁盘上 ${actual.slice(0, 12)}…，校验记录 ${String(lastDownload.sha256).slice(0, 12)}…），已拒绝安装`
      };
    }
  }

  try {
    /* shell.openPath 就是"用系统默认方式打开它" —— 对 .exe 即是启动安装程序。
       不用 spawn：spawn 需要我们自己管 detached/stdio，而这里要的正是
       "交给系统、我们随后退出"这个语义。 */
    const err = await shell.openPath(resolved);
    if (err) return { ok: false, message: `启动安装程序失败：${err}` };
  } catch (e) {
    return { ok: false, message: `启动安装程序失败：${e?.message || e}` };
  }

  logging.log('info', `[updater] 已启动安装程序 ${resolved}，启动器即将退出`);

  /*
    排在本次 IPC 回复**之后**再退出：
    如果这里直接 app.quit()，渲染层拿不到 {ok:true}，
    界面会停在"正在安装…"上，而应用已经没了 —— 用户看到的是"点了没反应然后崩了"。
  */
  setImmediate(() => {
    try {
      const windows = require('../windows');
      windows.setQuitting(true);
    } catch (_) {
      /* 取不到窗口模块也照样退出 */
    }
    app.quit();
  });

  return {
    ok: true,
    path: resolved,
    size,
    willQuit: true,
    message: '安装程序已启动，启动器即将退出。安装过程由安装包自己完成，完成后请手动重新打开启动器。'
  };
}

/* ============================================================================
 *  会话内记录：只有"本会话真下载并校验通过"的包才允许安装
 * ========================================================================== */

/**
 * 记录一次成功下载。由 download() 在成功分支调用 ——
 * 单独抽成函数是为了让"谁有权写这个记录"只有一个入口。
 * sha256/verify 一并记下来：install() 要用同一个依据再核对一次磁盘上的文件，
 * 而不是"下载时校验过就永远算数"（中间文件可能被换掉）。
 */
function rememberDownload(info) {
  lastDownload = info
    ? {
        dest: info.dest,
        expectedSize: Number(info.bytes) || 0,
        channel: info.channel || '',
        sha256: info.sha256 || '',
        verify: info.verify || '',
        at: Date.now()
      }
    : null;
  return lastDownload;
}

/** 供界面查询"现在有没有可安装的包" */
function downloadState() {
  return lastDownload ? { ...lastDownload } : null;
}

module.exports = {
  check,
  download,
  install,
  cancel,
  downloadState,
  /* 纯函数导出：给自测脚本逐条断言，不需要起网络也不需要 Electron 的窗口 */
  parseVersion,
  compareVersions,
  pickAsset,
  releaseAssetUrl,
  viaChannel,
  downloadChannels,
  updateConfigured,
  PROGRESS_CHANNEL,
  /*
    HTTP 传输层导出：同样只为自测。
    这样 verify-update-net.mjs 可以在**不起 Electron、不碰真实网络**的前提下
    断言"这条路径根本不使用全局 fetch"（全局 fetch 被替换成会抛错的桩），
    以及重定向跟随、超时语义、真实错误原因的上报。
  */
  requestBuffer,
  requestStream,
  loadOsCaBundle,
  describeFetchError,
  abortError,
  MAX_REDIRECTS,
  /*
    多线程分段下载的导出：同样只为自测。
    verify-update-mt.mjs 要用**本地 HTTP 服务**分别扮演
    "支持 Range"、"忽略 Range 只回 200"、"某段中途断流"三种源，
    并断言聚合进度、总字节、断流重试、退回单连接。
    要断言这些就必须能单独驱动"一个通道上的下载"，而不是整个 download()
    （后者会真的去解析 Release、拼通道、写真实临时目录）。
  */
  downloadSegmented,
  downloadChannel,
  resolveSegmentCount,
  downloadThreads,
  parseContentRangeTotal,
  buildProgressPayload,
  verifyDownloadedFile,
  assetSha256,
  hashFile
};
