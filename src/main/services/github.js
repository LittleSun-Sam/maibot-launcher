/*
================================================================================
技术文档：src/main/services/github.js
职责：GitHub Releases 查询、流式下载、MaiBot/SnowLuma 安装与安全升级。
================================================================================
  这是本次重构中最危险的一块。原实现的问题：

  1) 升级会破坏自己正在使用的目录（数据丢失级）
     tmpZip / tmpDir 都创建在 installDir **内部**，随后"把 installDir 下所有条目
     搬进 backupDir"的循环会把正在读写中的临时目录一起搬走，
     紧接着又去 rename 已经不存在的路径 → 抛异常，且此时 installDir 已被搬空。
     同一函数末尾还有 `fs.rmSync(backupDir, {recursive:true})`，
     把唯一的回滚副本也删了 —— 所谓"备份"从未留给用户。
     → 现在：全程在系统临时目录作业；采用"构建新目录 → 原子目录交换"策略；
       旧版本完整保留为 backup，失败自动回滚，成功后也不删备份。

  2) 假进度条
     `Buffer.from(await res.arrayBuffer())` 先整体读进内存再写盘，
     `onProgress({percent:100})` 只在下载**结束**时调用一次。
     旧的 QQ 注入式协议端的包上百 MB，既吃内存又让进度条永远只有 0% → 100% 两帧。
     → 现在：真流式写盘 + 节流进度事件。

  3) 路径穿越
     fileName 直接参与 path.join(destDir, fileName)，若上游给出
     "../../evil.zip" 就能写到任意位置。
     → 现在：文件名白名单校验（禁止分隔符与 ..）。

  4) 无用镜像
     对 api.github.com 套 ghproxy 前缀只会得到 404，白等一轮超时。
     → 现在：镜像仅用于 codeload/release 资源地址，且按需启用。
================================================================================
*/
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const logging = require('../logging');
const paths = require('../paths');
const { REPOS, GITHUB, USER_DATA_KEEP } = require('../constants');

/**
 * GitHub API 基址。
 *
 * 允许用环境变量覆盖，唯一目的是**让测试不依赖网络**：
 *   verify-repo-fallback 原本直连真实 api.github.com，于是
 *   "旧仓库名自动切候选"这条断言实际依赖 GitHub 的可用性与配额 ——
 *   未认证配额只有 60 次/小时，一旦用尽（返回 403），
 *   resolveRepo 出于"403 不能证明仓库不存在"的保守策略会沿用配置值，
 *   测试就报出 switched=false 的假失败。实测确实撞上过（remaining=0）。
 *   有覆盖能力之后，测试自己起一个本地假 API，行为完全确定。
 * 生产环境不设置这个变量，因此走常量里的真实地址。
 */
function apiBase() {
  const override = String(process.env.MAIBOT_LAUNCHER_GITHUB_API || '').trim();
  return (override || GITHUB.api).replace(/\/+$/, '');
}
const { getBackendSettings } = require('./settings');
const { sendToRenderer } = require('../windows');

/* ============================================================================
 *  通用工具
 * ========================================================================== */

/** 下载进度节流间隔 */
const PROGRESS_THROTTLE_MS = 120;

/**
 * 停滞超时：多久没收到**任何**字节就判定这个源不可用并换下一个。
 *
 * 45 秒是权衡后的值：
 *   · 太短会把"慢但在传"的源误杀（实测慢源也有 69KB/s，
 *     45 秒能收 3MB，绝不会触发）；
 *   · 太长则用户盯着不动的进度条干等。
 * 注意它计的是**两次收到数据之间的间隔**，不是总时长 ——
 * 下载 37MB 花了 5 分钟也不会被它中断，只要数据一直在流。
 */
const STALL_TIMEOUT_MS = 45000;

/** 下载事件标签 */
const TAG = {
  maibot: 'download-progress-maibot',
  snowluma: 'download-progress-snowluma',
  asset: 'download-progress-asset'
};

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MaiBot-Launcher'
  };
  try {
    const token = getBackendSettings()?.github?.token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (_) {
    /* 设置不可用时匿名请求 */
  }
  return headers;
}

/** 是否启用镜像（读取设置，默认启用） */
function mirrorEnabled() {
  try {
    return getBackendSettings()?.github?.useMirror !== false;
  } catch (_) {
    return true;
  }
}

/**
 * 下载并发数。
 *
 * 0 = 按文件大小自动（4~8 段）；1 = 强制单连接；>=2 = 用户指定。
 * 上下限在 resolveSegmentCount 里再夹一次 —— 设置文件是用户可以直接编辑的，
 * 里面写个 999 不该让启动器真的开 999 条连接把对方服务器打死。
 */
function downloadThreads() {
  try {
    const n = Number(getBackendSettings()?.github?.downloadThreads);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * 生成候选 URL 列表（官方优先，其次镜像）。
 *
 * @param {string} url
 * @param {'auto'|'official-only'} [policy]
 *   'official-only' 用于**没有独立校验依据**的下载：此时镜像既是交付方、
 *   又是唯一的"证据提供方"，让它参与等于把"这份字节可信吗"交给它自己回答。
 */
function candidateUrls(url, policy = 'auto') {
  if (policy === 'official-only' || !mirrorEnabled()) return [url];
  return [url, ...GITHUB.mirrors.filter(Boolean).map((m) => m.replace(/\/+$/, '') + '/' + url)];
}

/* ============================================================================
 *  下载源测速
 *  ---------------------------------------------------------------------------
 *  为什么需要（实测数据，不是猜的）：
 *    candidateUrls 的顺序是「官方直连优先，镜像垫后」，而在这个网络环境下
 *    官方直连只有约 **69 KB/s**，gh-proxy.com 有约 **2463 KB/s** —— 差 36 倍。
 *    于是每个大文件（SnowLuma 的包就有 37MB）都会**先用最慢的源**
 *    慢慢爬，用户看到的是"进度条几乎不动"，很容易以为启动器卡死了。
 *
 *    对 SnowLuma 更严重：37MB ÷ 69KB/s ≈ 9 分钟，界面在那之前一直是"下载中"。
 *
 *  做法：下载前先花 ~1 秒给每个候选源发一个 Range 请求，量一下谁快，
 *        选最快的那个当**首选**，其余仍按原顺序垫后（首选断了还能退回去）。
 *  代价可控：每个源只读最多 64KB 就主动断开，总耗时约等于最慢那个源的
 *        首字节时间，不会真的把文件下一遍。
 *  缓存：同一 URL 的结果缓存 10 分钟，避免"下载/升级/重试"反复测速。
 * ========================================================================== */

/** 测速采样上限：够区分快慢，又不至于真的多下多少流量 */
const PROBE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 3500;
const PROBE_CACHE_MS = 10 * 60 * 1000;
const probeCache = new Map();

/**
 * 量一个 URL 的下载速度。
 * 用 Range 只取开头一小段；`redirect: 'follow'` 很重要 ——
 * release 附件会 302 到 objects.githubusercontent.com，
 * 不跟随的话量到的是握手快慢而不是真实速度。
 * @returns {Promise<number>} 字节/秒；失败返回 -1
 */
async function measureSpeed(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MaiBot-Launcher', Range: `bytes=0-${PROBE_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!res.ok && res.status !== 206) return -1;
    if (!res.body) return -1;

    let got = 0;
    const reader = res.body.getReader();
    while (got < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value ? value.length : 0;
    }
    try {
      await reader.cancel();
    } catch (_) {
      /* 已经读完了，取消失败无所谓 */
    }
    const ms = Math.max(1, Date.now() - started);
    if (got <= 0) return -1;
    return (got / ms) * 1000;
  } catch (_) {
    return -1;
  }
}

/**
 * 把候选 URL 按实测速度重排（最快在前）。
 *
 * 只在有多个候选时才有意义；全部测速失败时**原样返回**，
 * 保持原来的顺序语义（官方优先），不会因为测速不可用就把用户卡住。
 *
 * @param {string[]} urls
 * @param {string} tag 仅用于日志归类
 */
async function orderBySpeed(urls, tag) {
  if (!Array.isArray(urls) || urls.length < 2) return urls;

  const key = urls.join('|');
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.order.slice();

  /* 并行测速：串行的话最坏要等 3.5s × 源数 */
  const speeds = await Promise.all(urls.map((u) => measureSpeed(u)));
  const ranked = urls
    .map((u, i) => ({ u, kbps: speeds[i] }))
    .filter((x) => x.kbps > 0)
    .sort((a, b) => b.kbps - a.kbps);

  if (!ranked.length) {
    logging.log('warn', `[github] ${tag} 所有下载源测速都失败，按原顺序尝试`);
    return urls;
  }

  const order = [
    ...ranked.map((x) => x.u),
    /* 测速失败的源仍排在最后再试一次，不直接丢弃 */
    ...urls.filter((u) => !ranked.some((x) => x.u === u))
  ];

  logging.log(
    'info',
    `[github] ${tag} 下载源测速：` +
      ranked.map((x) => `${safeHost(x.u)}=${Math.round(x.kbps / 1024)}KB/s`).join('  ') +
      ` → 首选 ${safeHost(order[0])}`
  );
  probeCache.set(key, { at: Date.now(), order });
  return order;
}

/**
 * 校验并规范化文件名，防止路径穿越。
 * @param {string} name
 * @returns {string|null} 合法则返回文件名，否则 null
 */
function safeFileName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed.includes('..')) return null;
  /*
    这里**故意**匹配控制字符（\x00-\x1f）：文件名来自 GitHub Release 附件，
    属于服务端提供的不可信数据。带控制字符的名字会让写盘抛错，
    或者在日志/终端里破坏显示（甚至被用来伪造换行注入日志内容）。
    规则 no-control-regex 的前提是"不需要匹配控制字符"，与本函数用途正好相反。
  */
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f<>:"|?*]/.test(trimmed)) return null;
  return trimmed;
}

/** 校验 owner/repo 形式 */
function safeRepo(repo) {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) ? repo.trim() : null;
}

/**
 * 按候选顺序解析出**真实存在**的仓库。
 *
 * 为什么需要它：
 *   安装/升级走的是 codeload 直链下载（downloadSourceArchive），
 *   **完全绕过 getReleases**。于是 getReleases 里那套候选回退对安装毫无帮助：
 *   上游改名后，老配置里留着旧仓库名（例如 `MaiBot/MaiBot`，现已 404）
 *   的用户，点「安装」只会拿到一个 codeload 的失败响应，
 *   而 fallback 列表里明明就有可用的新名字。
 *
 * 策略：用户显式配置的排第一（可能指向他自己的 fork，必须尊重），
 * 其后追加常量表里的候选；用一次轻量 HEAD 探测确认仓库存在。
 *
 * @param {string|null} repo 用户配置的仓库
 * @param {string} kind 'maibot' | 'snowluma'
 * @returns {Promise<{repo:string, switched:boolean}>}
 *          switched=true 表示用户配置的仓库不可用、已自动改用候选
 */
async function resolveRepo(repo, kind) {
  /*
    ⚠️ 这里必须按 kind 选候选，否则 kind='snowluma' 会掉进
    REPOS.maibotFallbacks 分支 —— 于是去查 MaiBot 的 releases，
    再按 "win-x64 非 lite 的 zip" 去挑附件，最后要么挑不到、
    要么装下一个完全不相干的东西（MaiBot 的发布包里也可能有 win zip）。
    属于"看起来成功、装错项目"的那类问题，所以显式列出来。
  */
  const FALLBACKS = {
    snowluma: [REPOS.snowluma],
    maibot: REPOS.maibotFallbacks
  };
  const fallbackList = FALLBACKS[kind] || FALLBACKS.maibot;
  const preferred = safeRepo(repo);
  const primary = preferred || fallbackList[0];
  const order = [primary, ...fallbackList.filter((r) => r !== primary)];

  for (const candidate of order) {
    try {
      const res = await fetch(`${apiBase()}/repos/${candidate}`, {
        method: 'GET',
        headers: githubHeaders(),
        signal: AbortSignal.timeout(8000)
      });
      /* 404 = 不存在（或私有），换下一个候选 */
      if (res.status === 404) {
        logging.log('warn', `[github] 仓库 ${candidate} 不存在，尝试下一个候选`);
        continue;
      }
      /*
        其它状态（403 限流、超时等）不能证明仓库不存在 ——
        此时**必须沿用用户配置的那个**，否则会因为一次网络抖动
        就把用户的 fork 静默换成官方仓库，造成"装错项目"这类更难查的问题。
      */
      if (!res.ok && res.status !== 403) continue;
      return { repo: candidate, switched: Boolean(preferred && candidate !== preferred) };
    } catch (e) {
      logging.log('warn', `[github] 探测仓库 ${candidate} 失败: ${e.message}，沿用已配置的仓库`);
      return { repo: candidate, switched: false };
    }
  }

  /* 全部候选都试过仍不可用：交回调用方，让它照常报错并给出仓库名 */
  return { repo: primary, switched: false };
}

/** 构造下载 URL（tag 为 'latest' 时使用 releases/latest/download 形式） */
function releaseAssetUrl(repo, tag, fileName) {
  const safe = safeFileName(fileName);
  if (!safe) throw new Error('文件名不合法');
  if (!tag || tag === 'latest') {
    return `https://github.com/${repo}/releases/latest/download/${safe}`;
  }
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${safe}`;
}

/* ============================================================================
 *  Releases 查询
 * ========================================================================== */

/**
 * 拉取 release 列表。主仓库失败时自动尝试候选仓库。
 * @param {string} repo
 * @param {number} perPage
 */
async function getReleases(repo, perPage = 30) {
  const target = safeRepo(repo) || REPOS.maibot;

  /*
    候选顺序 = 用户配置的仓库优先，其后追加常量表里还没试过的候选。
    修正的两个问题：
      1) 原判定是 `target === REPOS.maibot ? REPOS.maibotFallbacks : [target]` ——
         只要用户配的不是常量里那个"官方现名"，就**完全不回退**。
         上游改名后，老配置里留着 `MaiBot/MaiBot`（已 404）的用户
         会直接看到"仓库不存在"的报错，而 fallback 列表里恰好就写着这个名字，
         说明它是被预期兼容的。现在任何 404 都会继续尝试后续候选。
      2) 用户显式填的仓库必须排在最前，不能被常量表顶掉 ——
         有人会指向自己的 fork，那必须优先用他的。
  */
  const list = [target, ...REPOS.maibotFallbacks.filter((r) => r !== target)];
  let lastError = '';
  /* 记录哪些候选是"仓库不存在"，用于最后给出可操作的报错 */
  const notFound = [];
  const tried = [];

  for (const candidate of list) {
     
    const url = `${apiBase()}/repos/${candidate}/releases?per_page=${Math.min(Number(perPage) || 30, 100)}`;
    tried.push(candidate);
    try {
      const res = await fetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(15000)
      });
      if (res.status === 404) {
        lastError = `仓库不存在: ${candidate}`;
        notFound.push(candidate);
        continue;
      }
      if (res.status === 403) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        lastError = remaining === '0'
          ? 'GitHub API 访问频率受限，请在设置中填入 Token'
          : 'GitHub API 拒绝访问（403）';
        continue;
      }
      if (!res.ok) {
        lastError = `GitHub API ${res.status} ${res.statusText}`;
        continue;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        lastError = 'GitHub 返回了非预期数据';
        continue;
      }
      /* 与首个候选不同 → 说明发生了自动切换，回传真实使用的仓库名 */
      return {
        ok: true,
        repo: candidate,
        releases: data.map(normalizeRelease),
        message: candidate === target ? `共 ${data.length} 个版本` : `共 ${data.length} 个版本（已改用 ${candidate}）`
      };
    } catch (e) {
      lastError = e.name === 'TimeoutError' ? '请求 GitHub 超时' : e.message;
    }
  }

  /*
    全部候选都试过仍失败。
    如果**所有**候选都是"仓库不存在"，那问题多半出在仓库名上，
    这时把试过的名字都列出来，用户才知道该去设置页改哪一个 ——
    原实现只报最后一个候选（"仓库不存在: MaiBot/MaiBot"），
    既没说明还有别的候选，也没指出这就是他配置的那个值。
  */
  const allMissing = notFound.length > 0 && notFound.length === tried.length;
  const detail = allMissing
    ? `所有候选仓库都不存在（已尝试: ${tried.join('、')}），请在「设置」中检查仓库名`
    : lastError;

  logging.log('error', `[github] 获取 releases 失败: ${detail}`);
  throw new Error(detail || '获取版本列表失败');
}

/** 获取最新版本 */
async function getLatestRelease(repo) {
  const result = await getReleases(repo, 10);
  const latest = result.releases.find((r) => !r.prerelease) || result.releases[0];
  if (!latest) throw new Error('该仓库暂无发布版本');
  return { ok: true, repo: result.repo, release: latest };
}

/** 只保留前端需要的字段，避免把整个 release JSON 推给渲染层 */
function normalizeRelease(rel) {
  return {
    id: rel.id,
    tag_name: rel.tag_name,
    name: rel.name,
    prerelease: Boolean(rel.prerelease),
    draft: Boolean(rel.draft),
    published_at: rel.published_at,
    body: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '',
    assets: Array.isArray(rel.assets)
      ? rel.assets.map((a) => {
          rememberAssetUrl(a && a.browser_download_url);
          return {
            id: a.id,
            name: a.name,
            size: a.size,
            /*
              GitHub 会为附件发布 sha256 摘要（形如 "sha256:abc..."）。
              这是**唯一**能证明"下下来的字节确实等于作者上传的字节"的东西 ——
              只比大小的话，镜像返回一个同样大小的错误文件是查不出来的。
              API 对老附件可能没有这个字段，所以下面解析失败即为空串，
              后续校验会如实地降级为"只校验大小"，而不是假装校验过了。
            */
            digest: parseDigest(a.digest),
            download_count: a.download_count,
            browser_download_url: a.browser_download_url
          };
        })
      : []
  };
}

/**
 * 解析 GitHub 的 digest 字段。
 *
 * 只认 sha256（GitHub 目前也只发这一种）。其它算法一律返回空串，
 * 因为"用一个我们不支持的算法算出来的值"没法比对，
 * 与其记下来装样子，不如当作没有。
 *
 * @param {unknown} raw 例如 "sha256:0123abcd..."
 * @returns {string} 64 位小写十六进制，无则空串
 */
function parseDigest(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s.startsWith('sha256:')) return '';
  const hex = s.slice('sha256:'.length);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

/* ============================================================================
 *  流式下载（真进度）
 * ========================================================================== */

/**
 * 单连接流式下载到文件，并持续上报进度。
 *
 * 这是下载的**兜底路径**：源不支持 Range、分片失败、或用户把线程数设为 1
 * 时都走它。逻辑保持原样（双超时 + 边读边写 + 换源）。
 *
 * @param {object} opts
 * @param {string} opts.url 下载地址
 * @param {string} opts.destFile 目标文件绝对路径
 * @param {string} [opts.tag] 进度事件标签
 * @param {string} [opts.fileName] 展示用文件名
 * @param {number} [opts.expectSize] 预期大小（用于无 content-length 时估算）
 * @param {boolean} [opts.direct] url 是否已是最终单源（不再套镜像前缀）
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, message?:string}>}
 */
async function downloadSingle(opts) {
  const {
    url,
    destFile,
    tag = TAG.asset,
    fileName = path.basename(destFile),
    expectSize = 0,
    direct = false,
    segments = 1
  } = opts;

  /*
    先测速再下载：否则会按"官方优先"的顺序用最慢的源慢慢爬
    （实测官方直连 69KB/s vs 镜像 2463KB/s，差 36 倍，37MB 要多等 9 分钟）。
    测速失败时 orderBySpeed 会原样返回，行为退回原来的顺序。

    direct=true 时 url 已经是选定好的单个地址（分段失败回退、或调用方
    自己已经测过速），此时**绝不能再套镜像前缀** ——
    给一个镜像地址再套一层会得到 ghproxy/ghproxy/https://... 这种必然 404 的地址。
  */
  const urls = direct ? [url] : await orderBySpeed(candidateUrls(url), fileName);
  let lastError = '';

  for (const candidate of urls) {
     
    const host = safeHost(candidate);
    let stallTimer = null;
    let aborter = null;
    try {
      paths.ensureDir(destFile, { asFile: true });

      /*
        两个超时，缺一不可（原来一个都没有）：
          · connect：源根本没响应就挂住 → 永远不进入读取阶段，
            没有它的话整个下载会静静地卡死（实测直连 GitHub 就是这样）。
          · stall：连上了、传了一半然后不动 → 也必须断开换下一个源，
            否则进度条停在那里，用户只能强退启动器。
        用 AbortController 把两者作用到同一个请求上。
      */
      aborter = new AbortController();
      stallTimer = setTimeout(() => aborter.abort(), STALL_TIMEOUT_MS);

      const res = await fetch(candidate, {
        redirect: 'follow',
        headers: { 'User-Agent': 'MaiBot-Launcher' },
        signal: aborter.signal
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        emitProgress(tag, { phase: 'error', fileName, message: `HTTP ${res.status}`, host, segments });
        continue;
      }
      if (!res.body) {
        lastError = '响应无正文';
        continue;
      }

      const total = Number(res.headers.get('content-length') || expectSize || 0);
      let received = 0;
      let lastEmit = 0;
      const startedAt = Date.now();

      emitProgress(tag, { phase: 'start', fileName, total, percent: 0, host, segments });

      /* 真流式：边读边写，内存占用恒定 */
      const source = Readable.fromWeb(res.body);
      const out = fs.createWriteStream(destFile);

      source.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        /*
          每收到一块就重置"停滞"计时器。归零说明是"有数据但很慢"
          —— 那种情况不该中断，用户至少能看到进度在动。
        */
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => aborter.abort(), STALL_TIMEOUT_MS);
        }
        if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
          lastEmit = now;
          const elapsedMs = Math.max(1, now - startedAt);
          const bytesPerSec = received / (elapsedMs / 1000);
          emitProgress(tag, {
            phase: 'progress',
            fileName,
            received,
            total,
            /* 实测速率与剩余时间：用户能自己判断"是慢还是卡了" */
            kbps: Math.round(received / elapsedMs),
            bytesPerSec: Math.round(bytesPerSec),
            etaSec:
              total && bytesPerSec > 0 && received < total
                ? Math.max(0, Math.round((total - received) / bytesPerSec))
                : null,
            percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
            host,
            segments
          });
        }
      });

      await pipeline(source, out);

      /* 校验：有 content-length 时必须完全一致，防止半截文件被当成成功 */
      if (total > 0 && received !== total) {
        lastError = `下载不完整（${received}/${total} 字节）`;
        fs.rmSync(destFile, { force: true });
        continue;
      }

      /*
        这里**刻意不发 done**：字节只是传完了，还没校验。
        发 done 会让界面先显示"完成"，紧接着校验失败又翻成错误 ——
        而校验可能要一两秒，用户会看到"完成"闪一下再变红。
        权威的 done 由 downloadToFile 在校验通过后统一发出。
      */
      emitProgress(tag, {
        phase: 'progress', fileName, received, total: total || received,
        percent: 99, host, segments
      });
      return { ok: true, path: destFile, bytes: received, host, message: '传输完成' };
    } catch (e) {
      /*
        区分"停滞超时"和其它错误，因为用户的下一步动作完全不同：
        停滞要提示换源/检查网络，其它错误多半是文件或权限问题。
      */
      const stalled = e?.name === 'AbortError';
      lastError = stalled ? `连接停滞超过 ${Math.round(STALL_TIMEOUT_MS / 1000)}s` : e.message;
      logging.log('warn', `[github] 下载失败(${host}): ${lastError}`);
      emitProgress(tag, { phase: 'error', fileName, message: lastError, host, segments });
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  return { ok: false, message: `下载失败: ${lastError}` };
}

/* ============================================================================
 *  多线程（分段并发）下载 + SHA-256 校验
 *  ---------------------------------------------------------------------------
 *  为什么要分段：
 *    实测这个网络下单连接就在 2~3 MB/s 徘徊，换更快的镜像也一样 ——
 *    瓶颈在**单条 TCP 连接**上，不在源上。而 SnowLuma 的 Windows 包 45MB，
 *    单连接要等几十秒到一分多钟，中途抖一下还得整条重来。
 *    分成 4~8 段并发取，同一源就能快数倍，
 *    并且**每段可断点续传** —— 某段失败只补它缺的那一截。
 *
 *  为什么要校验：
 *    镜像站是第三方。只比 content-length 的话，一个"大小一样但内容被替换或
 *    损坏"的文件会被当成成功装进用户目录 —— 而协议端是要被直接执行的程序，
 *    这不是学术问题。
 *    GitHub 的 Release API 会发布附件的 sha256（实测 SnowLuma 的
 *    每个 zip 都有），我们下完自己算一遍比对。这是唯一能真正证明
 *    "落盘的字节等于作者上传的字节"的手段。
 * ========================================================================== */

/** 小于这个大小不值得分段：多出来的请求开销比省下的时间还多 */
const SEGMENT_MIN_BYTES = 4 * 1024 * 1024;
/** 自动模式下的目标分片大小 */
const SEGMENT_TARGET_BYTES = 8 * 1024 * 1024;
/** 自动模式的分片数上下限 */
const SEGMENT_MIN_COUNT = 4;
const SEGMENT_MAX_COUNT = 8;
/** 单段最多额外重试几次（续传，只补缺的那一截） */
const SEGMENT_RETRY = 2;
/** 探测是否支持 Range 的超时 */
const RANGE_PROBE_TIMEOUT_MS = 8000;

const UA = 'MaiBot-Launcher';

/**
 * 算文件的 SHA-256。
 * 流式读，40MB 约 0.2 秒，不会把整个文件读进内存。
 */
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
 * 探测某地址是否支持 Range，顺便拿到真实总大小。
 *
 * 只取 1 字节（`bytes=0-0`）：支持则回 206 + `Content-Range: bytes 0-0/总长`。
 * 必须**每个候选源各探一次** —— 镜像站有的支持有的不支持，
 * 探一次就假定所有源都一样会写出坏文件。
 */
async function probeRange(url) {
  let res = null;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(RANGE_PROBE_TIMEOUT_MS)
    });
    if (res.status !== 206) return { ranges: false, total: 0 };
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    const total = m ? Number(m[1]) : 0;
    return { ranges: total > 0, total };
  } catch (_) {
    /* 探测失败就当不支持，退回单连接 —— 保守，但绝不会因此下坏文件 */
    return { ranges: false, total: 0 };
  } finally {
    try {
      await res?.body?.cancel();
    } catch (_) {
      /* 正文已消费或不存在 */
    }
  }
}

/**
 * 决定分几段。
 * @param {number} threads 0/未设=按大小自动；1=强制单连接；>=2=指定并发数
 * @param {number} total 总大小
 */
function resolveSegmentCount(threads, total) {
  const n = Number(threads) || 0;
  if (n === 1) return 1;
  if (!total || total < SEGMENT_MIN_BYTES) return 1;
  if (n >= 2) return Math.min(SEGMENT_MAX_COUNT, n);
  const bySize = Math.round(total / SEGMENT_TARGET_BYTES);
  return Math.max(SEGMENT_MIN_COUNT, Math.min(SEGMENT_MAX_COUNT, bySize));
}

/**
 * 分段并发下载同一个 URL 到同一个文件。
 *
 * 关键实现点：
 *   · 先把文件预置成**完整长度**（稀疏文件），各段才能用 'r+' 按偏移写。
 *   · 每段独立 AbortController + 停滞计时器，互不影响。
 *   · 每段记录已写字节，重试从 `start + received` 继续 —— 断点续传。
 *   · 服务端不认 Range（回 200 而非 206）时**立刻抛错**，
 *     绝不把整个文件写到某个段的偏移上（那会写出一堆重复数据）。
 *
 * @returns {Promise<number>} 实际写入的总字节数
 * @throws 任一段重试耗尽则抛，由调用方退回单连接
 */
async function downloadSegmented(opts) {
  const { url, destFile, total, count, onBytes } = opts;

  await fsp.writeFile(destFile, '');
  await fsp.truncate(destFile, total);

  const per = Math.ceil(total / count);
  const segs = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    if (start > end) break;
    segs.push({ start, end, received: 0 });
  }

  const runSegment = async (seg) => {
    const need = seg.end - seg.start + 1;

    for (let attempt = 0; attempt <= SEGMENT_RETRY; attempt += 1) {
      if (attempt > 0 && seg.received) {
        /*
          上一次尝试的字节作废（下面会从本段起点整体重写），
          必须从进度总量里扣回来，否则重试越多进度条越虚高 ——
          显示 80% 而盘上只有 50%，比没有进度条更糟。
        */
        onBytes(-seg.received);
        seg.received = 0;
      }

      /*
        每一段都固定从 seg.start 开始写，**刻意不做"按已读字节续传"**。
        原因：source 读到的字节数 ≠ 已经落盘的字节数 ——
        WriteStream 可能有已排队但未刷盘的块，pipeline 报错时这些块会被丢弃。
        若拿"读到的字节"当断点，续传就会从错误的位置接着写，
        把一个好文件写成**错位**文件，而且只有最后的 sha256 才发现。
        从段起点用 'r+' 偏移重写是幂等的：无论上次写进去多少，
        这次都会用正确的数据原样覆盖那段区间，不存在错位可能。
        代价只是重取这一段（几十 MB / 8 ≈ 几 MB），远比下坏文件划算。
      */
      const from = seg.start;
      const aborter = new AbortController();
      let stallTimer = setTimeout(() => aborter.abort(), STALL_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': UA, Range: `bytes=${from}-${seg.end}` },
          signal: aborter.signal
        });
        if (res.status !== 206 || !res.body) {
          throw new Error(`分段请求未返回 206（实际 ${res.status}）`);
        }

        const source = Readable.fromWeb(res.body);
        const out = fs.createWriteStream(destFile, { flags: 'r+', start: from });

        source.on('data', (chunk) => {
          seg.received += chunk.length;
          onBytes(chunk.length);
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => aborter.abort(), STALL_TIMEOUT_MS);
        });

        await pipeline(source, out);

        if (seg.received >= need) return;
        throw new Error(`本段只收到 ${seg.received}/${need} 字节`);
      } catch (e) {
        if (attempt >= SEGMENT_RETRY) {
          throw new Error(`分段 ${seg.start}-${seg.end} 失败: ${e.message}`);
        }
        logging.log(
          'warn',
          `[github] 分段 ${seg.start}-${seg.end} 第 ${attempt + 1} 次失败，整段重取: ${e.message}`
        );
      } finally {
        clearTimeout(stallTimer);
      }
    }
    throw new Error(`分段 ${seg.start}-${seg.end} 重试耗尽`);
  };

  await Promise.all(segs.map(runSegment));
  return segs.reduce((sum, s) => sum + s.received, 0);
}

/**
 * 把"已收字节"换算成百分比 / 速率 / 剩余时间。
 * 分段并发时每个段都往里加，所以 received 是可信的聚合值。
 */
function createMeter({ tag, fileName, total, host, segments }) {
  const startedAt = Date.now();
  let received = 0;
  let lastEmit = 0;

  const payload = (phase) => {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - startedAt);
    const bytesPerSec = received / (elapsedMs / 1000);
    return {
      phase,
      fileName,
      received,
      total,
      host,
      segments,
      /* 平均速率：bytesPerSec 给界面用；kbps 保留以兼容既有订阅方 */
      bytesPerSec: Math.round(bytesPerSec),
      kbps: Math.round(received / elapsedMs),
      /*
        剩余秒数。只在"有总大小且在收数据"时给，
        否则宁可为 null 让界面不显示，也不编一个一直跳动的假数字。
      */
      etaSec:
        total && bytesPerSec > 0 && received < total
          ? Math.max(0, Math.round((total - received) / bytesPerSec))
          : null,
      percent: total ? Math.min(99, Math.floor((received / total) * 100)) : 0
    };
  };

  return {
    add(n) {
      received += n;
      const now = Date.now();
      if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      emitProgress(tag, payload('progress'));
    },
    flush(phase = 'progress') {
      emitProgress(tag, payload(phase));
    }
  };
}

/**
 * 校验落盘的文件。
 *
 * 返回的 verify 字段如实标明**到底校验到了什么程度**：
 *   'sha256' —— 与上游发布的摘要逐字节比对通过（真校验）
 *   'size'   —— 只有大小可比对
 *   'none'   —— 既没有摘要也没有预期大小
 * 界面据此显示不同文案，绝不把"只对了大小"说成"校验通过"。
 *
 * @returns {Promise<{ok:boolean, bytes:number, sha256:string, verify:string, message?:string}>}
 */
async function verifyFile(file, opts) {
  const { expectSize = 0, expectSha256 = '', tag, fileName, host, segments } = opts;

  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch (_) {
    bytes = 0;
  }

  if (expectSize > 0 && bytes !== expectSize) {
    return {
      ok: false, bytes, sha256: '', verify: 'size',
      message: `文件大小不符（${bytes}/${expectSize} 字节）`
    };
  }

  /*
    校验阶段单独报一次，界面才能显示"校验中…"——
    116MB 的包算 sha256 要一两秒，没有这个事件的话
    进度条会停在 99% 不动，用户会以为卡死了。
  */
  emitProgress(tag, {
    phase: 'verify', fileName, received: bytes, total: bytes, percent: 99, host, segments
  });

  const sha256 = await hashFile(file);

  if (expectSha256) {
    if (sha256 !== String(expectSha256).toLowerCase()) {
      return {
        ok: false, bytes, sha256, verify: 'sha256',
        message: `SHA-256 校验不通过（期望 ${String(expectSha256).slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…）`
      };
    }
    return { ok: true, bytes, sha256, verify: 'sha256' };
  }

  return { ok: true, bytes, sha256, verify: expectSize > 0 ? 'size' : 'none' };
}

/**
 * 下载文件到本地：**分段并发 + SHA-256 校验 + 换源回退**。
 *
 * 每个候选源依次尝试：
 *   1) 探测是否支持 Range → 决定分几段
 *   2) 段数 > 1 → 分段并发；失败则同一个源退回单连接
 *   3) 单连接流式下载（内含停滞超时）
 *   4) 校验大小 + SHA-256；不符就**删掉文件**换下一个源重来
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.destFile
 * @param {string} [opts.tag]
 * @param {string} [opts.fileName]
 * @param {number} [opts.expectSize]
 * @param {string} [opts.expectSha256] GitHub 发布的 sha256；没有则只校验大小
 * @param {number} [opts.threads] 0/未设=自动，1=单连接，>=2=指定并发
 */
async function downloadToFile(opts) {
  const {
    url,
    destFile,
    tag = TAG.asset,
    fileName = path.basename(destFile),
    expectSize = 0,
    expectSha256 = '',
    threads = 0,
    mirrorPolicy = ''
  } = opts;

  /*
    镜像准入按"可验证性"分流，而不是一刀切开或一刀关。
    ──────────────────────────────────────────────────────────────────────
    背景：镜像本身是刻意加的（见 orderBySpeed 上方的实测：直连约 69 KB/s，
    gh-proxy 约 2463 KB/s，差 36 倍），关掉它会让大文件下载退回"进度条几乎
    不动"的老问题。但镜像同时是**潜在的攻击者**，所以真正该问的不是
    "用不用镜像"，而是"这次下载有没有一个独立于镜像的校验依据"：

      · 有 expectSha256  → 摘要说了算，来源无所谓              → 允许镜像
      · 只有 expectSize  → 大小来自 Release 元数据，独立于镜像，
                            能拦住"镜像缓存了另一个版本"        → 允许镜像
      · 两者都没有      → 镜像既是交付方又是唯一的证据提供方：
                            verifyFile 只能拿它自报的 Content-Range
                            回头验它自己（verify:'none'）        → 只准官方

    这是原实现真正的洞：`const total = expectSize || probe.total || 0` 在
    两者都没有时退回"镜像自报的总长"，然后拿这个数去校验这个镜像下的文件 ——
    一个自洽的谎言永远能通过。调用方可以显式传 mirrorPolicy 覆盖推导结果。
  */
  const effectiveMirrorPolicy = mirrorPolicy
    || (expectSha256 || expectSize > 0 ? 'auto' : 'official-only');
  if (effectiveMirrorPolicy === 'official-only' && mirrorEnabled()) {
    logging.log(
      'warn',
      `[github] ${fileName} 无独立 sha256/大小依据，本次仅从官方源下载（不经第三方镜像）`
    );
  }

  /*
    先发一帧"还没开始"的说明，再去测速选源。
    ────────────────────────────────────────────────────────────────
    为什么需要：orderBySpeed 会并行探测所有候选源（含直连 GitHub）。
    实测直连在这台机器上是失败的，要等它超时，于是**头 3~4 秒进度条一动不动**。
    界面看着像卡死，用户会去点第二次、甚至以为下载坏了。
    这一帧必须在 orderBySpeed **之前**发，否则等测速回来才有内容，等于没发。
    segments 故意给 0：此刻还不知道会不会分段，给 1 会让界面显示"单连接"，
    那是**猜**出来的结论，文件大的时候下一帧就会变成"8 线程"，等于自己打自己脸。
    界面在 segments < 1 时选择不显示线程信息。
  */
  emitProgress(tag, {
    phase: 'start',
    fileName,
    total: expectSize,
    percent: 0,
    received: 0,
    segments: 0,
    message: '正在测速选择最快的下载源…'
  });

  const urls = await orderBySpeed(candidateUrls(url, effectiveMirrorPolicy), fileName);
  let lastError = '';

  for (const candidate of urls) {
    const host = safeHost(candidate);
    let segments = 1;
    try {
      paths.ensureDir(destFile, { asFile: true });

      const probe = await probeRange(candidate);
      /*
        优先用 GitHub API 声明的 size，而不是镜像自己报的 Content-Range 总长。
        为什么：expectSize 来自 Release 元数据，独立于镜像；
        而镜像的 Content-Range 是它自己说的 —— 如果某个镜像缓存了**另一个版本**
        的文件，它报的总长会和我们要的版本不一样，只信它就会漏掉这种"下载了对的
        仓库、错的版本"。用 API 的 size 当基准，这种错配立刻被大小校验拦住。
        探测到的 total 只在调用方没给 size 时兜底（例如源码归档）。
      */
      const total = expectSize || probe.total || 0;
      const count = resolveSegmentCount(threads, total);
      segments = count;

      emitProgress(tag, {
        phase: 'start', fileName, total, percent: 0, host, segments: count,
        /* 明确告诉界面用了几线程 —— 用户才看得见"多线程"真的生效了 */
        message: count > 1 ? `分 ${count} 段并发下载` : '单连接下载'
      });

      let bytes = 0;
      if (count > 1) {
        const meter = createMeter({ tag, fileName, total, host, segments: count });
        try {
          bytes = await downloadSegmented({
            url: candidate, destFile, total, count, onBytes: (n) => meter.add(n)
          });
          meter.flush('progress');
        } catch (e) {
          logging.log('warn', `[github] 分段下载失败(${host})，退回单连接: ${e.message}`);
          /* 清掉半成品，免得单连接把尾巴接在残缺文件后面 */
          fs.rmSync(destFile, { force: true });
          bytes = 0;
          segments = 1;
          emitProgress(tag, {
            phase: 'start', fileName, total, percent: 0, host, segments: 1,
            message: '分段失败，已退回单连接'
          });
        }
      }

      if (!bytes) {
        const r = await downloadSingle({
          url: candidate, destFile, tag, fileName, expectSize: total, direct: true, segments
        });
        if (!r.ok) {
          lastError = r.message || '下载失败';
          continue;
        }
        bytes = r.bytes || 0;
      }

      const v = await verifyFile(destFile, {
        /* total 已优先取 API 的 size；为 0 表示确实不知道大小，那就只算哈希不装作比过大小 */
        expectSize: total, expectSha256, tag, fileName, host, segments
      });

      if (!v.ok) {
        logging.log('error', `[github] ${fileName} ${v.message}（来源 ${host}）`);
        fs.rmSync(destFile, { force: true });
        lastError = v.message;
        emitProgress(tag, {
          phase: 'error', fileName, message: v.message, host, segments
        });
        continue;
      }

      emitProgress(tag, {
        phase: 'done', fileName, received: v.bytes, total: v.bytes, percent: 100,
        host, segments, sha256: v.sha256, verify: v.verify, bytesPerSec: 0, etaSec: 0
      });
      logging.log(
        'info',
        `[github] 下载完成 ${fileName} ${(v.bytes / 1048576).toFixed(2)}MB ← ${host}` +
          `（${segments > 1 ? segments + ' 线程' : '单连接'}，校验=${v.verify}）`
      );

      return {
        ok: true, path: destFile, bytes: v.bytes, host,
        sha256: v.sha256, verify: v.verify, segments,
        message: v.verify === 'sha256' ? '下载完成，SHA-256 校验通过' : '下载完成'
      };
    } catch (e) {
      lastError = e.message;
      logging.log('warn', `[github] 下载失败(${host}): ${lastError}`);
      emitProgress(tag, { phase: 'error', fileName, message: lastError, host, segments });
    }
  }

  return { ok: false, message: `下载失败: ${lastError}` };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return 'invalid-url';
  }
}

/**
 * 安全投递进度事件（只发主窗口，不再广播）。
 *
 * 必须包 try/catch：进度上报只是"通知界面"，它失败**绝不能**影响下载本身。
 * 窗口可能已经销毁、webContents 可能正在导航 —— 那些都会抛。
 * 之前这里裸调用，于是"界面关了/正在重载"这类与下载无关的状况,
 * 会顺着 emitProgress 把整个下载流程炸掉，用户看到的是"下载失败"，
 * 而真实原因是通知失败。宁可丢一帧进度，也不能丢文件。
 */
function emitProgress(tag, payload) {
  try {
    sendToRenderer(tag, payload);
  } catch (_) {
    /* 界面不在或已销毁：忽略这一帧进度 */
  }
}

/* ============================================================================
 *  路径策略：哪些路径允许被"写入下载文件 / 打开 / 定位"
 * ----------------------------------------------------------------------------
 *  为什么必须有一份统一策略：
 *    渲染层的 downloadAsset({destDir}) 与 shell:open-path(target) 都是
 *    "把一个渲染层给的字符串变成文件系统动作"。原实现只校验了**文件名**，
 *    destDir / target 完全不设限，于是同一条链上任意一环都能被接走：
 *      downloadAsset → 写 %APPDATA%\…\Start Menu\Programs\StartUp\x.exe  → 开机执行
 *      shell.openPath → 立刻执行刚下载下来的 .exe
 *    这里把"允许的根目录"集中定义，写入与打开共用同一份判断。
 *
 *  允许来源：
 *    A 启动器自己的数据目录（userData/maibot-data 子树：缓存/模型/记录/导出）
 *    B 用户显式配置过的目录（settings.service.maibotDir / snowlumaDir / general.scanRoots）
 *      —— **只对"打开/定位"放开**，下载不允许落到安装目录里（否则又是一条"先落盘再装依赖"的链）
 *    C 本进程自己创建出来的目录（安装/升级/备份的落点，由 swapDirectory 登记）
 *    D 系统的"下载"目录（用户想另存到那儿是正常需求）
 *  另有一份硬拒绝清单（系统目录 / 自动执行位置 / 启动器自身目录），优先级高于一切白名单。
 * ========================================================================== */

/** 本进程创建过的目录（安装/升级/备份落点），供"打开位置"用 */
const APP_CREATED_PATHS = new Set();
const MAX_APP_CREATED_PATHS = 200;

/** 本次会话里 GitHub 真的返回过的附件地址（见 rememberAssetUrl） */
const SEEN_ASSET_URLS = new Set();
const MAX_SEEN_ASSET_URLS = 4000;

function rememberAssetUrl(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url.trim())) return;
  if (SEEN_ASSET_URLS.size >= MAX_SEEN_ASSET_URLS) SEEN_ASSET_URLS.clear();
  SEEN_ASSET_URLS.add(url.trim());
}

/** 路径归一化：绝对化 + 去尾分隔符 + 小写（Windows 不区分大小写） */
function normKey(p) {
  let abs = path.resolve(String(p));
  if (abs.length > 3 && /[\\/]$/.test(abs)) abs = abs.replace(/[\\/]+$/, '');
  return abs.toLowerCase();
}

/** child 是否等于 root 或位于 root 之下 */
function isUnder(child, root) {
  const c = normKey(child);
  const r = normKey(root);
  if (!r) return false;
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 解析真实路径（解开 junction / 符号链接）；失败则原样返回 */
function realKey(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch (_) {
    return p;
  }
}

/** 启动器的数据目录（下载只允许落在这里，**不包含 userData 根** —— 那里有 backend-settings.json） */
function appWriteRoots() {
  const out = [];
  try {
    out.push(paths.dataRoot());
  } catch (_) {
    /* paths 不可用时没有可写根 */
  }
  try {
    const app = require('electron').app;
    const dl = app && typeof app.getPath === 'function' ? app.getPath('downloads') : '';
    if (dl) out.push(dl);
  } catch (_) {
    /* 非 electron 环境（脚本/探针）：没有下载目录 */
  }
  return out;
}

/** 允许"打开/定位"的启动器自身目录（含 userData 根：日志、设置、数据都在里面） */
function appOpenRoots() {
  const out = appWriteRoots();
  try {
    out.push(paths.userDataDir());
  } catch (_) {
    /* 忽略 */
  }
  return out;
}

/** 用户显式配置过的目录（安装目录、扫描根） */
function userConfiguredRoots() {
  const out = [];
  let cfg = null;
  try {
    cfg = getBackendSettings();
  } catch (_) {
    return out;
  }
  const push = (p) => {
    if (typeof p !== 'string' || !p.trim()) return;
    try {
      out.push(path.resolve(p.trim()));
    } catch (_) {
      /* 忽略无法解析的配置 */
    }
  };
  push(cfg?.service?.maibotDir);
  push(cfg?.service?.snowlumaDir);
  if (Array.isArray(cfg?.general?.scanRoots)) cfg.general.scanRoots.forEach(push);
  return out;
}

/** 安装目录本身 + 其父目录 + 同级的标准子目录（安装器里的 targetDir 是父目录） */
function installRelatedRoots() {
  const out = [];
  let cfg = null;
  try {
    cfg = getBackendSettings();
  } catch (_) {
    return out;
  }
  for (const raw of [cfg?.service?.maibotDir, cfg?.service?.snowlumaDir]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let abs;
    try {
      abs = path.resolve(raw.trim());
    } catch (_) {
      continue;
    }
    out.push(abs, path.dirname(abs), path.join(abs, 'maibot'), path.join(abs, 'snowluma'));
  }
  return out;
}

/** 硬拒绝清单：系统目录、自动执行位置、启动器自身目录 */
function deniedRoots() {
  const out = [];
  const push = (p) => {
    if (!p) return;
    try {
      out.push(path.resolve(String(p)));
    } catch (_) {
      /* 忽略 */
    }
  };
  push(process.env.SystemRoot || process.env.windir);
  push(process.env.ProgramFiles);
  push(process.env['ProgramFiles(x86)']);
  /*
    自启动位置（当前用户 + 所有用户）：往这里写文件 = 持久化执行。
    注意这里**不**整片拒绝 %ProgramData% —— 有些用户确实会把程序装在
    ProgramData 下，而无差别拒绝会把正常安装/下载挡掉；StartUp 子目录本身仍被拒绝。
  */
  for (const base of [process.env.APPDATA, process.env.ProgramData || process.env.ALLUSERSPROFILE]) {
    if (!base) continue;
    push(path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'));
    push(path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'));
  }
  if (process.resourcesPath) push(process.resourcesPath);
  if (process.execPath) push(path.dirname(process.execPath));
  try {
    const app = require('electron').app;
    if (app && typeof app.getAppPath === 'function') push(app.getAppPath());
  } catch (_) {
    /* 忽略 */
  }
  return out;
}

/**
 * 判断一个路径是否允许被打开/定位（mode='open'）或写入下载文件（mode='write'）。
 * 硬拒绝优先：即使某个白名单根目录把系统目录"包含"进来（例如用户把 C:\ 配成扫描根），也一律拒绝。
 *
 * @param {unknown} target
 * @param {{mode?:'open'|'write'}} [opts]
 * @returns {{ok:boolean, resolved:string, reason:string, message:string}}
 */
function isPathAllowed(target, opts = {}) {
  const mode = opts.mode === 'write' ? 'write' : 'open';
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, resolved: '', reason: 'empty', message: '路径无效' };
  }
  let abs;
  try {
    abs = path.resolve(target.trim());
  } catch (_) {
    return { ok: false, resolved: '', reason: 'bad', message: '路径无法解析' };
  }
  const real = realKey(abs);

  /* 硬拒绝：abs 与真实路径任一落在禁止区就拒绝（junction 指向系统目录也挡得住） */
  for (const p of new Set([abs, real])) {
    for (const d of deniedRoots()) {
      if (isUnder(p, d)) {
        return {
          ok: false,
          resolved: abs,
          reason: 'denied',
          message: `该位置属于系统/自动执行目录，不允许操作: ${abs}`
        };
      }
    }
  }

  const roots =
    mode === 'write'
      ? [...appWriteRoots(), ...APP_CREATED_PATHS]
      : [...appOpenRoots(), ...userConfiguredRoots(), ...installRelatedRoots(), ...APP_CREATED_PATHS];
  for (const p of new Set([abs, real])) {
    for (const r of roots) {
      if (isUnder(p, r)) return { ok: true, resolved: abs, reason: '', message: '' };
    }
  }

  return {
    ok: false,
    resolved: abs,
    reason: 'not-listed',
    message:
      mode === 'write'
        ? `保存目录不在允许范围内，已拒绝下载。可保存到：${writeHints()}（当前填的是 ${abs}）`
        : `该路径不在允许打开的范围内: ${abs}`
  };
}

/** 给用户看的"能存哪儿"提示：缓存目录在最前（下载页默认值就是它） */
function writeHints() {
  let cache = '';
  try {
    cache = paths.getMaibotPaths().cacheDir;
  } catch (_) {
    cache = '';
  }
  const roots = appWriteRoots().filter((r) => r && r.toLowerCase() !== (cache || '').toLowerCase());
  return [cache, ...roots].filter(Boolean).join(' / ');
}

/** 只做"硬拒绝"判断（安装目标目录是用户自己选的，不做白名单，但不能是系统/自启动位置） */
function isDeniedPath(target) {
  if (typeof target !== 'string' || !target.trim()) return false;
  return isPathAllowed(target).reason === 'denied';
}

/*
  用"文件关联"打开这些扩展名，等于把它们交给自己声明的解释器去执行：
  .exe/.com/.scr 直接跑，.bat/.cmd/.ps1/.vbs/.js/.wsf/.jar 交给脚本宿主，
  .msi/.msp/.mst 交给安装器，.lnk/.url/.pif/.hta/.reg 交给外壳。
  下载页能把文件写进启动器数据目录 —— 所以"打开"这一环必须自己判断类型，
  不能因为路径在白名单里就放行（这正是 M-02 → M-11 那条链的最后一跳）。
*/
const EXECUTABLE_LIKE_EXTS = new Set([
  '.exe', '.com', '.scr', '.pif', '.bat', '.cmd', '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ws', '.msi', '.msp', '.mst',
  '.lnk', '.url', '.reg', '.hta', '.cpl', '.dll', '.jar', '.jnlp', '.scf',
  '.application', '.gadget', '.msc', '.inf', '.chm', '.sh', '.py', '.pyw'
]);

/** 该路径是否属于"打开即执行"的类型 */
function isExecutablePath(target) {
  if (typeof target !== 'string' || !target.trim()) return false;
  try {
    return EXECUTABLE_LIKE_EXTS.has(path.extname(target.trim()).toLowerCase());
  } catch (_) {
    return true;
  }
}

/**
 * 登记"这个目录是本进程创建出来的"（安装/升级/备份的落点）。
 * 登记后 shell:open-path 才允许打开它 —— 安装结果页的「打开位置」正走这条路。
 */
function noteAppCreatedPath(target) {
  if (typeof target !== 'string' || !target.trim()) return;
  try {
    const abs = path.resolve(target.trim());
    if (APP_CREATED_PATHS.size >= MAX_APP_CREATED_PATHS) APP_CREATED_PATHS.clear();
    APP_CREATED_PATHS.add(abs);
    const parent = path.dirname(abs);
    if (parent && parent !== abs) APP_CREATED_PATHS.add(parent);
  } catch (_) {
    /* 忽略 */
  }
}

/**
 * 校验下载落地目录，并算出最终文件路径。
 * 目录必须是**已存在**的目录；最终文件必须确实落在该目录内（第二道防穿越）。
 *
 * @param {unknown} destDir
 * @param {string} fileName 已经过 safeFileName
 * @returns {{ok:boolean, destFile:string, message:string}}
 */
function resolveDownloadDest(destDir, fileName) {
  const check = isPathAllowed(destDir, { mode: 'write' });
  if (!check.ok) return { ok: false, destFile: '', message: check.message };
  const dir = check.resolved;
  let st;
  try {
    st = fs.statSync(dir);
  } catch (_) {
    return { ok: false, destFile: '', message: `保存目录不存在: ${dir}` };
  }
  if (!st.isDirectory()) return { ok: false, destFile: '', message: `保存位置不是目录: ${dir}` };
  const destFile = path.resolve(path.join(dir, fileName));
  if (normKey(path.dirname(destFile)) !== normKey(dir)) {
    return { ok: false, destFile: '', message: '文件名不合法（最终路径越出保存目录）' };
  }
  return { ok: true, destFile, message: '' };
}

/** 附件地址是否可信：本次会话的 release 列表里出现过，或本模块自己就能构造出来 */
function isKnownAssetUrl(url, repo, tag, fileName) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const u = url.trim();
  if (SEEN_ASSET_URLS.has(u)) return true;
  try {
    if (releaseAssetUrl(repo, tag, fileName) === u) return true;
  } catch (_) {
    /* fileName 不合法等：由调用方另行报错 */
  }
  return false;
}

/**
 * 下载 release 附件（供「下载」页使用）。
 * @param {{repo:string, tag:string, fileName:string, assetUrl?:string, destDir:string}} opts
 */
async function downloadAsset(opts = {}) {
  const repo = safeRepo(opts.repo);
  if (!repo) return { ok: false, message: '仓库名格式不正确（应为 owner/name）' };

  const fileName = safeFileName(opts.fileName);
  if (!fileName) return { ok: false, message: '文件名不合法' };

  /* 落地位置：白名单 + 必须已存在的目录 + 最终路径复检 */
  const dest = resolveDownloadDest(opts.destDir, fileName);
  if (!dest.ok) {
    logging.log(
      'warn',
      `[github] 拒绝下载到不受信任的位置: ${String(opts.destDir).slice(0, 200)}（${dest.message}）`
    );
    return { ok: false, message: dest.message };
  }

  /*
    附件地址只接受"本次会话里 GitHub 真的返回过"的地址，
    或本模块自己按 repo/tag/fileName 构造出来的地址。
    否则渲染层能把下载页变成"从任意 URL 取文件写到本机"（任意内容落盘 + SSRF）。
  */
  let url;
  if (opts.assetUrl !== undefined && opts.assetUrl !== null && opts.assetUrl !== '') {
    if (!isKnownAssetUrl(opts.assetUrl, repo, opts.tag, fileName)) {
      logging.log('warn', `[github] 拒绝非 release 列表内的附件地址: ${String(opts.assetUrl).slice(0, 200)}`);
      return { ok: false, message: '附件地址不在本次会话的 release 列表内，已拒绝下载' };
    }
    url = String(opts.assetUrl).trim();
  } else {
    url = releaseAssetUrl(repo, opts.tag, fileName);
  }

  return downloadToFile({
    url,
    destFile: dest.destFile,
    tag: TAG.asset,
    fileName,
    expectSize: Number(opts.size) || 0,
    /* GitHub 发布的 sha256；传空则只校验大小（verify 会如实标注） */
    expectSha256: String(opts.sha256 || ''),
    threads: downloadThreads()
  });
}

/* ============================================================================
 *  解压
 * ========================================================================== */

/** tar 输出上限（列条目与解压输出共用），避免异常情况下把内存撑爆 */
const MAX_TAR_OUTPUT_CHARS = 200000;
/** 压缩包条目数上限：正常发布包远小于这个数 */
const MAX_ZIP_ENTRIES = 20000;

/*
  解压后的总体积上限（zip bomb）。
  ──────────────────────────────────────────────────────────────────────
  条目数与 tar 输出字符数都有上限，但**解压出来的字节数此前没有任何上限**：
  一个 200 KB 的包可以合法地膨胀成几百 GB，把 %TEMP% 写满 ——
  而我们的工作目录就在 %TEMP%（paths.workDir），写满会连带影响整台机器。
  8 GiB 远大于任何真实 MaiBot 源码树（实测解压后约 20 MB 量级），
  所以正常安装不会碰到它。
*/
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * tar 可执行文件：优先用系统绝对路径。
 * 理由同 winproc 里的 PowerShell —— PATH 上先被找到的同名 tar 会顶替系统那份，
 * 而"能往某个 PATH 目录写文件"正是本文件其它条目在防的事。
 */
function tarExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'tar.exe');
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch (_) {
    /* 退回 PATH */
  }
  return 'tar';
}

/**
 * 判断压缩包条目名是否安全（Zip-Slip）。
 * 拒绝：绝对路径、盘符、UNC、以及任何一段为 '..' 的条目。
 */
function isUnsafeZipEntry(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (n.startsWith('/') || n.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(n)) return true;
  if (n.startsWith('//')) return true;
  return n.split(/[\\/]+/).some((seg) => seg === '..');
}

/**
 * 列出压缩包条目（先看清单，再决定解不解）。
 *
 * ⚠️ 截断必须留痕（truncated）。
 * ──────────────────────────────────────────────────────────────────────
 * 原来这里是：
 *     if (out.length < MAX_TAR_OUTPUT_CHARS) out += d.toString();
 * 超限之后**静默停止追加**，但 exit code 仍是 0，于是照常返回 ok:true。
 * 后果是这条防线可以被合法地绕开：
 *   · `names` 只是真实清单的前缀，`isUnsafeZipEntry` 只能校验它看得到的那部分；
 *   · `MAX_ZIP_ENTRIES` 变成对**残表**计数 —— 20000 这个数字形同虚设；
 *   · 攻击者只要把 `../../` 条目排在输出预算之外（例如前面塞够长的合法路径），
 *     整个包就会通过校验，再被 runExtract 全量解开。
 * 这正是本文件 :1565-1569 那段注释声称已经防住的事，所以必须 fail-closed：
 * 只要截断过，就由调用方拒绝解压 —— 一个装不下的清单，等于一份没有校验过的清单。
 *
 * @returns {Promise<{ok:boolean,names:string[],truncated:boolean,message:string}>}
 */
function listZipEntries(zipFile) {
  return new Promise((resolve) => {
    const child = spawn(tarExe(), ['-tf', zipFile], { windowsHide: true });
    let out = '';
    let err = '';
    let truncated = false;
    child.stdout.on('data', (d) => {
      if (truncated) return;
      const s = d.toString();
      if (out.length + s.length > MAX_TAR_OUTPUT_CHARS) {
        out += s.slice(0, Math.max(0, MAX_TAR_OUTPUT_CHARS - out.length));
        truncated = true;
        return;
      }
      out += s;
    });
    child.stderr.on('data', (d) => {
      if (err.length < MAX_TAR_OUTPUT_CHARS) err += d.toString();
    });
    child.on('error', (e) => resolve({ ok: false, names: [], truncated: false, message: e.message }));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          names: [],
          truncated,
          message: (err || `tar -tf 退出码 ${code}`).trim().slice(0, 300)
        });
        return;
      }
      const names = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve({ ok: true, names, truncated, message: '' });
    });
  });
}

/**
 * 估算压缩包解压后的总体积（防 zip bomb）。
 *
 * 解析 `tar -tvf` 的详细清单。bsdtar 的明细行形如
 *   -rw-r--r--  3 0 0     1234 Jan  1 12:00 repo-tag/file.txt
 * 前 5 个字段是固定的（权限/硬链接数/属主/属组/字节数），所以从左侧按空白切分取
 * 下标 4 即可，文件名里带空格也不会影响（我们从左往右读，不依赖右侧字段）。
 *
 * 这里是**尽力而为**的估算，解析不出来时返回 ok:false，由调用方决定怎么办 ——
 * 不要在这里假装成功。
 *
 * @returns {Promise<{ok:boolean,total:number,parsed:number,message:string}>}
 */
function probeUncompressedBytes(zipFile) {
  return new Promise((resolve) => {
    const child = spawn(tarExe(), ['-tvf', zipFile], { windowsHide: true });
    let out = '';
    let truncated = false;
    child.stdout.on('data', (d) => {
      if (truncated) return;
      const s = d.toString();
      if (out.length + s.length > MAX_TAR_OUTPUT_CHARS) {
        out += s.slice(0, Math.max(0, MAX_TAR_OUTPUT_CHARS - out.length));
        truncated = true;
        return;
      }
      out += s;
    });
    child.on('error', (e) => resolve({ ok: false, total: 0, parsed: 0, message: e.message }));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, total: 0, parsed: 0, message: `tar -tvf 退出码 ${code}` });
        return;
      }
      /* 截断的明细不能用来算总和：算出来只会偏小，等于给了假的安全感 */
      if (truncated) {
        resolve({ ok: false, total: 0, parsed: 0, message: '明细输出超出预算，无法估算体积' });
        return;
      }
      let total = 0;
      let parsed = 0;
      for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const parts = t.split(/\s+/);
        const size = Number(parts[4]);
        if (!Number.isFinite(size) || size < 0) continue;
        const occupied = parts.slice(4).some((p) => /^\d{4}-\d{2}-\d{2}$/.test(p));
        if (!occupied && !/^[dlbcps-]/.test(parts[0])) continue;
        total += size;
        parsed += 1;
        if (total > MAX_UNCOMPRESSED_BYTES) break;
      }
      resolve({ ok: true, total, parsed, message: '' });
    });
  });
}

/** 真正解压（条目已校验过） */
function runExtract(zipFile, destDir) {
  return new Promise((resolve) => {
    const child = spawn(tarExe(), ['-xf', zipFile, '-C', destDir], { windowsHide: true });
    let output = '';
    const collect = (d) => {
      if (output.length < MAX_TAR_OUTPUT_CHARS) output += d.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => resolve({ ok: false, message: `解压失败: ${e.message}` }));
    child.on('exit', (code) =>
      resolve({ ok: code === 0, code, output: output.slice(-1500) })
    );
  });
}

/**
 * 解压 zip。
 * Windows 10+ 自带 tar.exe（bsdtar）可解 zip，无需额外依赖。
 *
 * 安全（修复 Zip-Slip 与输出无上限）：
 *   · 解压前先 `tar -tf` 列条目，自己判断有没有「..／绝对路径／盘符／UNC」，
 *     有就整个包拒绝 —— 不再把"安不安全"这件事交给 PATH 上的 tar 去决定；
 *   · 条目数、tar 输出都有上限，异常压缩包不会把内存吃干；
 *   · tar 用系统绝对路径调用（见 tarExe）。
 */
async function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const listed = await listZipEntries(zipFile);
  if (!listed.ok) {
    return { ok: false, code: null, output: '', message: `无法读取压缩包条目: ${listed.message}` };
  }
  /*
    fail-closed：清单被截断 = 有没校验到的条目 = 拒绝整个包。
    这条必须排在 MAX_ZIP_ENTRIES 之前 —— 截断时 names.length 本身
    就是个偏小的残值，拿它和 20000 比毫无意义。
  */
  if (listed.truncated) {
    logging.log(
      'warn',
      `[github] 压缩包条目清单超出 ${MAX_TAR_OUTPUT_CHARS} 字符预算，无法完整校验，已拒绝解压`
    );
    return {
      ok: false,
      code: null,
      output: '',
      message: '压缩包条目过多，无法完整校验条目安全性，已拒绝解压'
    };
  }
  if (listed.names.length > MAX_ZIP_ENTRIES) {
    return {
      ok: false,
      code: null,
      output: '',
      message: `压缩包条目过多（${listed.names.length} > ${MAX_ZIP_ENTRIES}），已拒绝解压`
    };
  }
  const unsafe = listed.names.filter(isUnsafeZipEntry);
  if (unsafe.length) {
    logging.log(
      'warn',
      `[github] 压缩包含不安全条目（${unsafe.length} 个），已拒绝解压: ${unsafe.slice(0, 5).join(' | ')}`
    );
    return {
      ok: false,
      code: null,
      output: '',
      message: `压缩包含不安全条目（${unsafe.length} 个，例如 ${unsafe[0].slice(0, 120)}），已拒绝解压`
    };
  }
  /*
    体积上限（zip bomb）。
    前置估算能拦下绝大多数构造包；估不出来时**不因此拒绝**（bsdtar 明细格式
    可能因版本/locale 而异，拿它当硬门禁会误伤正常安装），改用解压后复核兜底 ——
    这样最坏情况是多写了一次磁盘，而不是让正常用户装不上。
  */
  const volume = await probeUncompressedBytes(zipFile);
  if (volume.ok && volume.total > MAX_UNCOMPRESSED_BYTES) {
    logging.log(
      'warn',
      `[github] 压缩包解压后约 ${volume.total} 字节，超出上限 ${MAX_UNCOMPRESSED_BYTES}，已拒绝解压`
    );
    return {
      ok: false,
      code: null,
      output: '',
      message: `压缩包解压后体积过大（约 ${Math.round(volume.total / 1024 / 1024)} MB），已拒绝解压`
    };
  }
  if (!volume.ok) {
    logging.log('info', `[github] 无法估算解压体积（${volume.message}），改由解压后复核兜底`);
  }

  const extracted = await runExtract(zipFile, destDir);
  /* 解压后复核：前置估算没拦住（或没估出来）时，这里实测一次 */
  if (extracted.ok) {
    const measured = dirTotalBytes(destDir, MAX_UNCOMPRESSED_BYTES);
    if (measured > MAX_UNCOMPRESSED_BYTES) {
      logging.log(
        'warn',
        `[github] 解压结果实测 ${measured} 字节，超出上限，已清理并拒绝`
      );
      try {
        fs.rmSync(destDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      } catch (_) {
        /* 清理失败不应掩盖真正的原因 */
      }
      return {
        ok: false,
        code: extracted.code,
        output: '',
        message: '解压结果体积过大，已中止并清理（疑似压缩炸弹）'
      };
    }
  }
  return extracted;
}

/**
 * 递归统计目录总字节数，累计超过 limit 就提前返回（不必走完整个炸弹）。
 * 越界、权限失败一律按 0 计 —— 这只是兜底复核，不该因为它自身报错就中断安装。
 */
function dirTotalBytes(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          total += fs.statSync(full).size;
          if (total > limit) return total;
        }
      } catch (_) {
        /* 跳过读不到的条目 */
      }
    }
  }
  return total;
}

/** 找到解压后的单一顶层目录（GitHub archive 会包一层 repo-tag/） */
function findTopLevel(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return entries.length === 1 ? path.join(dir, entries[0].name) : dir;
}

/** 校验目录内存在指定入口文件 */
function findEntry(dir, candidates) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(dir, c))) return c;
    } catch (_) {
      /* 继续 */
    }
  }
  return '';
}

/**
 * 下载 GitHub 源码归档（archive/refs/tags/<tag>.zip）。
 * 注意：仅当 release 列表里没有可用附件时才走这条路。
 */
async function downloadSourceArchive(repo, tag, destFile, progressTag) {
  /*
    把 'latest' 解析成**真实 tag**，不要用 HEAD。
    ──────────────────────────────────────────────────────────────────────
    原来这一行是：
        const ref = !tag || tag === 'latest' ? 'HEAD' : `refs/tags/...`;
    codeload 的 `HEAD` 是**默认分支顶端**，不是最近一次发布。于是"安装最新版"
    实际拿到的是漂移的开发分支：可能包含未发布的改动、也可能根本跑不起来，
    而界面与日志显示的都是"最新版" —— 用户以为自己装的是 release，其实不是。
    这种"悄悄降级"比直接失败更糟，因为没有任何人会发现。

    现在复用 getLatestRelease()（它已经带了多镜像回退与"所有候选仓库都不存在"
    的错误聚合），解析不出来就**明确失败**，绝不退回 HEAD。
  */
  let resolvedTag = String(tag || '').trim();
  if (!resolvedTag || resolvedTag === 'latest') {
    try {
      const info = await getLatestRelease(repo);
      resolvedTag = String(info?.release?.tag_name || '').trim();
    } catch (e) {
      logging.log('error', `[github] 解析 latest 失败，拒绝退回默认分支: ${e.message}`);
      return { ok: false, message: `无法解析最新版本标签：${e.message}` };
    }
    if (!resolvedTag) {
      logging.log('error', '[github] 仓库没有可用的发布标签，拒绝退回默认分支');
      return { ok: false, message: '该仓库没有可用的发布版本，无法下载源码包' };
    }
    logging.log('info', `[github] 源码包 ref: latest → ${resolvedTag}（不再使用 HEAD）`);
  }
  const ref = `refs/tags/${encodeURIComponent(resolvedTag)}`;
  const url = `https://codeload.github.com/${repo}/zip/${ref}`;
  const dl = await downloadToFile({
    url,
    destFile,
    tag: progressTag,
    fileName: path.basename(destFile),
    /*
      codeload 的源码归档**没有**上游 sha256 可比对（GitHub 只为 Release 附件
      发布 digest），GitHub API 也不提供 archive 的字节数。所以这里：
        · 不传 expectSha256 —— 不假装做过哈希校验；
        · 也不传 expectSize —— 一但没有它，downloadToFile 推导出的
          mirrorPolicy 就是 'official-only'，第三方镜像不参与本次下载。
          这正是我们要的：唯一的证据提供方不能同时是交付方。
        · 落地后改用**压缩包结构自检**兜底（见下）。
      多线程仍然生效：codeload 支持 Range。
    */
    mirrorPolicy: 'official-only',
    threads: downloadThreads()
  });
  if (!dl.ok) return dl;

  /*
    结构自检：这个包能不能被正常列出条目。
    一个被截断、或被中途改写坏的 zip 会在这一步暴露。这比"对了大小"强 ——
    它检验的是文件自身的一致性，而不是我们**期望**它多大，
    所以不需要任何上游元数据就能成立。
  */
  const shape = await listZipEntries(destFile);
  if (!shape.ok || shape.truncated) {
    logging.log(
      'error',
      `[github] 源码包结构自检失败（${shape.message || '条目清单被截断'}），已丢弃`
    );
    try {
      fs.rmSync(destFile, { force: true });
    } catch (_) {
      /* 删不掉也不该掩盖真正的原因 */
    }
    return {
      ok: false,
      message: `下载的源码包已损坏或不完整：${shape.message || '条目清单异常'}`
    };
  }
  logging.log('info', `[github] 源码包结构自检通过（${shape.names.length} 个条目）`);
  return dl;
}

/* ============================================================================
 *  安装 MaiBot
 * ========================================================================== */

/**
 * 全新安装 MaiBot。
 * @param {{targetDir:string, version?:string, repo?:string}} opts
 */
async function installMaiBot(opts = {}) {
  /* 先做不花钱的本地校验，再去探测仓库 —— 参数不对就不该发网络请求 */
  if (!opts.targetDir || typeof opts.targetDir !== 'string') {
    return { ok: false, message: '未指定安装目录' };
  }
  /*
    安装目标目录是用户自己选的（不做白名单），但**不能**是系统目录或自动执行位置 ——
    把一个机器人装进"启动"文件夹没有任何正当用途，只会被当成持久化手法。
  */
  if (isDeniedPath(opts.targetDir)) {
    logging.log('warn', `[install] 拒绝安装到系统/自动执行目录: ${opts.targetDir}`);
    return { ok: false, message: `该位置属于系统/自动执行目录，不允许安装: ${opts.targetDir}` };
  }
  const { repo, switched } = await resolveRepo(opts.repo, 'maibot');
  const version = opts.version || 'latest';
  const work = paths.workDir('maibot-install');
  const tmpZip = path.join(work, 'source.zip');
  const tmpDir = path.join(work, 'extract');

  let installRoot = '';
  try {
    installRoot = path.join(opts.targetDir, 'maibot');

    /*
      先拦一道：绝不"安装"到一个已经装着 MaiBot 的目录上。
      ──────────────────────────────────────────────────────────────────
      原来的流程是 swapDirectory(top, installRoot, { keepBackup: false })：
      把旧目录改名 → 把新目录搬进来 → **删掉备份**。
      也就是说 config/、data/、plugins/ 这些用户数据会随旧目录永久消失，
      而且没有任何回滚点。偏偏默认安装位置就是 <目标目录>/maibot，
      而用户在设置里填的"目标目录"常常正是自己正在用的那一个
      （本机实测：C:\Users\...\modules\maibot）——
      于是"手滑再点一次安装"就等于把在用的机器人数据清空。

      这里改成拒绝：让用户明确选「升级」（保留配置 + 自动备份旧版本），
      或者换一个空目录。宁可多问一句，也不能替用户删数据。
    */
    const existing = detectExistingInstall(installRoot);
    if (existing) {
      logging.log('warn', `[install] 拒绝覆盖已存在的 MaiBot 安装：${installRoot}（发现 ${existing}）`);
      return {
        ok: false,
        refused: true,
        path: installRoot,
        message:
          `目标位置已经是一个 MaiBot 安装：${installRoot}（发现 ${existing}）。` +
          '直接安装会清空 config/、data/ 等用户数据，已中止。' +
          '要更新版本请用「升级」（保留配置并自动备份旧版本）；' +
          '确实要重装请先自行备份，或把「目标目录」改成一个空目录。'
      };
    }

    logging.log('info', `[install] 开始安装 MaiBot repo=${repo} version=${version} → ${installRoot}`);

    const dl = await downloadSourceArchive(repo, version, tmpZip, TAG.maibot);
    if (!dl.ok) return { ok: false, message: dl.message };

    const ex = await extractZip(tmpZip, tmpDir);
    if (!ex.ok) return { ok: false, message: `解压失败: ${ex.message || ex.output}` };

    const top = findTopLevel(tmpDir);
    const entry = findEntry(top, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py']);
    if (!entry) {
      return { ok: false, message: '解压后未找到 MaiBot 入口文件（main.py / bot.py），请确认仓库与版本' };
    }

    /*
      目标已存在则先整体移到临时备份，避免出现半新半旧的混合目录。
      keepBackup 从 false 改成 true：上面那道检查已经拦住了"覆盖已有安装"，
      能走到这里的只剩空目录/残留目录，但万一判断有漏，
      留着备份总比永久删除安全（备份名形如 maibot.old-<时间戳>）。
    */
    await swapDirectory(top, installRoot, { keepBackup: true });

    logging.log('info', `[install] MaiBot 安装完成 → ${installRoot}（入口 ${entry}）`);
    return {
      ok: true,
      path: installRoot,
      entry,
      version,
      repo,
      /* 用户配的仓库不可用、已自动换成候选时如实告知，不静默替换 */
      message: switched
        ? `MaiBot 安装完成（配置的仓库不可用，已自动改用 ${repo}）`
        : 'MaiBot 安装完成'
    };
  } catch (e) {
    logging.log('error', `[install] 安装失败: ${e.message}`);
    return { ok: false, message: `安装失败: ${e.message}` };
  } finally {
    paths.removeDir(work);
  }
}

/* ============================================================================
 *  安全升级 MaiBot
 * ========================================================================== */

/**
 * 升级已安装的 MaiBot。
 *
 * 策略（与重构前完全不同）：
 *   1) 全部临时产物放在系统临时目录，**绝不触碰 installDir**
 *   2) 在 tmp 中构建完整新版本，并把旧版本的用户数据白名单迁移进去
 *   3) 原子交换：installDir → backup，newDir → installDir
 *   4) 校验失败 → 自动回滚（backup 搬回 installDir）
 *   5) 成功时**保留 backup**，用户可自行确认后再删除
 *
 * @param {{installDir:string, version?:string, repo?:string}} opts
 */
async function upgradeMaiBot(opts = {}) {
  const installDir = typeof opts.installDir === 'string' ? opts.installDir.trim() : '';
  if (!installDir) return { ok: false, message: '未指定要升级的安装目录' };

  const { repo } = await resolveRepo(opts.repo, 'maibot');
  const version = opts.version || 'latest';

  /* --- 前置校验：必须在升级前就失败，而不是搞坏目录之后再失败 --- */
  if (!fs.existsSync(installDir)) {
    return { ok: false, message: `安装目录不存在: ${installDir}` };
  }
  const stat = fs.statSync(installDir);
  if (!stat.isDirectory()) {
    return { ok: false, message: `安装路径不是目录: ${installDir}` };
  }
  const oldEntry = findEntry(installDir, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py']);
  if (!oldEntry) {
    return { ok: false, message: '目标目录不像 MaiBot 安装目录（未找到入口文件），已中止升级' };
  }

  /*
    服务正在运行时不要替换安装目录。
    升级的最后一步是把 installDir 改名再把新版本搬进去；此刻 python 还在
    用这个目录里的文件，Windows 上目录改名会失败（文件被占用），
    轻则升级报错回滚，重则留下"一半旧一半新"的目录。
    先拦住并说清该怎么做 —— isServiceRunning 一直都在，只是没人调用。
  */
  const runningNow = isMaiBotRunning();
  if (runningNow) {
    logging.log('warn', '[upgrade] MaiBot 正在运行，拒绝升级');
    return {
      ok: false,
      running: true,
      message: 'MaiBot 正在运行，升级会替换它正在使用的安装目录。请先点「停止」再升级。'
    };
  }
  /* 父目录必须可写，否则交换步骤会中途失败 */
  const parentDir = path.dirname(installDir);
  try {
    fs.accessSync(parentDir, fs.constants.W_OK);
  } catch (_) {
    return { ok: false, message: `无权写入安装位置的父目录: ${parentDir}` };
  }

  const work = paths.workDir('maibot-upgrade');
  const tmpZip = path.join(work, 'source.zip');
  const tmpDir = path.join(work, 'extract');
  const staging = path.join(work, 'staging');
  const backupDir = `${installDir}.backup-${timestamp()}`;
  let swapped = false;

  try {
    logging.log('info', `[upgrade] 开始升级 ${installDir} → version=${version} repo=${repo}`);

    /* ---- 1) 下载 ---- */
    const dl = await downloadSourceArchive(repo, version, tmpZip, TAG.maibot);
    if (!dl.ok) return { ok: false, message: dl.message };

    /* ---- 2) 解压 ---- */
    const ex = await extractZip(tmpZip, tmpDir);
    if (!ex.ok) return { ok: false, message: `解压失败: ${ex.message || ex.output}` };
    const extracted = findTopLevel(tmpDir);

    /* ---- 3) 校验新版本结构 ---- */
    const newEntry = findEntry(extracted, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py']);
    if (!newEntry) {
      return { ok: false, message: '下载的版本缺少入口文件，已中止（原目录未改动）' };
    }

    /* ---- 4) 在 staging 里组装：新版本 + 迁移的旧用户数据 ---- */
    fs.mkdirSync(staging, { recursive: true });
    await fsp.cp(extracted, staging, { recursive: true });

    const migrated = [];
    for (const name of USER_DATA_KEEP) {
      const from = path.join(installDir, name);
      const to = path.join(staging, name);
      try {
        if (!fs.existsSync(from)) continue;
        /* 目标已存在则不覆盖：以新版本的默认配置为准，避免配置结构不兼容 */
        if (fs.existsSync(to)) {
          const note = path.join(staging, `${name}.old-kept`);
          await fsp.cp(from, note, { recursive: true });
          migrated.push({ name, action: 'kept-as', target: `${name}.old-kept` });
        } else {
          await fsp.cp(from, to, { recursive: true });
          migrated.push({ name, action: 'migrated' });
        }
      } catch (e) {
        logging.log('warn', `[upgrade] 迁移 ${name} 失败（跳过）: ${e.message}`);
        migrated.push({ name, action: 'failed', error: e.message });
      }
    }

    /* ---- 5) 组装结果再校验一次 ---- */
    if (!findEntry(staging, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py'])) {
      return { ok: false, message: '组装后的新版本缺少入口文件，已中止（原目录未改动）' };
    }

    /* ---- 6) 原子交换 ---- */
    /*
      再查一次：下载+组装可能要几分钟，用户完全可能在这期间点了「启动」。
      和上面那次检查是同一件事，只是时间点更靠近真正的危险操作。
    */
    if (isMaiBotRunning()) {
      logging.log('warn', '[upgrade] 交换前发现 MaiBot 已启动，中止升级（原目录未改动）');
      return {
        ok: false,
        running: true,
        message: '升级准备期间 MaiBot 被启动了，为避免破坏正在使用的数据已中止（原目录未改动）。请先停止 MaiBot 再试。'
      };
    }
    /*
      落位空间预检 —— 必须在"把旧目录改名搬走"**之前**做。
      ────────────────────────────────────────────────────────────────
      跨卷时 movePath 会退化成"复制整个 staging"，这时如果目标卷装不下，
      时序就变成：旧目录已搬走 → 新目录复制到一半失败 → 只能回滚。
      用户看到的是"升级失败已回滚"，而真正的原因（磁盘空间不足）
      一个字都没提到，他只会反复重试。
      同卷 rename 是纯元数据操作、不需要空间，多算一次也无害。
      探测失败时**不拦**：空间真的不够仍会被复制失败 + 回滚兜住，
      不能因为统计接口在某些文件系统上不可用就让所有人都升不了级。
    */
    try {
      const staged = dirStats(staging);
      const probeTarget = fs.existsSync(installDir) ? installDir : path.dirname(installDir);
      const st = await fsp.statfs(probeTarget);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      /* 留 15% 余量：解压临时文件、日志、备份都会占用同一个分区 */
      const needBytes = Math.ceil(staged.bytes * 1.15);
      if (Number.isFinite(freeBytes) && freeBytes > 0 && freeBytes < needBytes) {
        const mb = (n) => Math.round(n / 1048576);
        logging.log(
          'warn',
          `[upgrade] 目标卷剩余 ${mb(freeBytes)} MB < 所需 ${mb(needBytes)} MB，已中止（原目录未改动）`
        );
        return {
          ok: false,
          message: `目标磁盘剩余空间不足（需约 ${mb(needBytes)} MB，剩余 ${mb(freeBytes)} MB），已中止升级，原目录未改动。`
        };
      }
    } catch (e) {
      logging.log('info', `[upgrade] 跳过磁盘空间预检: ${e.message}`);
    }

    await movePath(installDir, backupDir);
    try {
      await movePath(staging, installDir);
      swapped = true;
    } catch (e) {
      /* 交换失败：立刻把备份搬回去，保证用户目录可用 */
      logging.log('error', `[upgrade] 目录交换失败，正在回滚: ${e.message}`);
      await movePath(backupDir, installDir);
      return { ok: false, message: `升级失败已回滚: ${e.message}` };
    }

    if (!findEntry(installDir, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py'])) {
      logging.log('error', '[upgrade] 交换后校验失败，正在回滚');
      await rollback(installDir, backupDir);
      return { ok: false, message: '升级后校验失败，已回滚到原版本' };
    }

    logging.log('info', `[upgrade] 升级完成。旧版本保留在 ${backupDir}`);
    /* 登记安装/备份落点，供安装结果页的「打开位置」使用（见 noteAppCreatedPath） */
    noteAppCreatedPath(installDir);
    noteAppCreatedPath(backupDir);
    return {
      ok: true,
      path: installDir,
      version,
      entry: newEntry,
      backupDir,
      migrated,
      message: `升级完成（旧版本已备份到 ${path.basename(backupDir)}）`
    };
  } catch (e) {
    logging.log('error', `[upgrade] 升级异常: ${e.message}`);
    /* 已交换但后续出错 → 尝试回滚 */
    if (swapped) {
      try {
        await rollback(installDir, backupDir);
        return { ok: false, message: `升级异常，已回滚: ${e.message}` };
      } catch (re) {
        return { ok: false, message: `升级异常且回滚失败: ${e.message} / ${re.message}（备份位于 ${backupDir}）` };
      }
    }
    return { ok: false, message: `升级失败: ${e.message}` };
  } finally {
    paths.removeDir(work);
  }
}

/**
 * MaiBot 现在是否由启动器托管且进程还活着。
 * 懒加载 require：process.js 与 github.js 互相可见，顶层 require 容易成环。
 */
function isMaiBotRunning() {
  try {
    return require('./process').isServiceRunning('maibot');
  } catch (e) {
    /* 拿不到状态时宁可放行也不要卡住升级流程，但要留痕 */
    logging.log('warn', `[upgrade] 无法确认 MaiBot 运行状态: ${e.message}`);
    return false;
  }
}

/**
 * 目标目录里是否已经有一份 MaiBot（用于拦住"安装覆盖"）。
 * @returns {string} 命中说明；'' 表示可以安全安装
 */
function detectExistingInstall(dir) {
  if (!dir || !fs.existsSync(dir)) return '';
  try {
    if (!fs.statSync(dir).isDirectory()) return '';
  } catch (_) {
    return '';
  }
  const entry = findEntry(dir, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py']);
  if (entry) return `入口文件 ${path.basename(entry)}`;
  for (const name of ['config', 'data', '.env', 'pyproject.toml', 'plugins']) {
    if (fs.existsSync(path.join(dir, name))) return `${name}`;
  }
  try {
    if (fs.readdirSync(dir).length > 0) return '非空目录';
  } catch (_) {
    /* 读不了就当空目录处理，后面 swapDirectory 仍会保留备份 */
  }
  return '';
}

/** 回滚：删除当前目录，把备份搬回 */
async function rollback(installDir, backupDir) {
  if (!fs.existsSync(backupDir)) throw new Error('备份目录不存在，无法回滚');
  await fsp.rm(installDir, { recursive: true, force: true });
  await movePath(backupDir, installDir);
  logging.log('warn', '[upgrade] 已回滚到升级前版本');
}

/**
 * 目录替换：把 source 的内容放到 dest。
 * 用于全新安装（keepBackup=false 时会清理旧目录）。
 */
async function swapDirectory(source, dest, opts = {}) {
  const { keepBackup = true } = opts;
  const backup = `${dest}.old-${timestamp()}`;
  const destExists = fs.existsSync(dest);

  if (destExists) {
    await movePath(dest, backup);
  }
  try {
    await movePath(source, dest);
  } catch (e) {
    if (destExists && fs.existsSync(backup)) await movePath(backup, dest);
    throw e;
  }
  if (destExists && !keepBackup) {
    await fsp.rm(backup, { recursive: true, force: true });
  }
  /*
    登记安装/备份落点：安装结果页的「打开位置」要能打开它们，
    而 open-path 只放行"启动器自己创建过的目录"（见 isPathAllowed）。
  */
  noteAppCreatedPath(dest);
  if (destExists && keepBackup) noteAppCreatedPath(backup);
  return { backup: destExists && keepBackup ? backup : '' };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 跨卷安全的目录/文件移动 —— `fsp.rename` 的替代品，**抛错语义完全一致**。
 *
 * 为什么必须换掉 rename：
 * ──────────────────────────────────────────────────────────────────────
 * Windows 上 `rename` 不能跨卷。而我们的 staging 目录在 %TEMP%（一般 C:），
 * 用户却完全可能把 MaiBot 装在 D:/E: —— 这是很常见的做法。此时 rename 抛
 * EXDEV，调用点的可见后果是：
 *   · 全新安装：`swapDirectory` 抛出 → "安装失败"，用户不知道错在哪；
 *   · 升级：`:2161` 已经把旧目录改名搬走，`:2163` 才失败 → 走回滚，
 *     用户看到"升级失败已回滚"，同样猜不到只是盘符不同。
 * 也就是说：**跨盘的机器上，安装和升级都直接不可用**，而错误信息对此只字未提。
 *
 * 兜底顺序（复制 → 校验 → 删源）是刻意选的：
 *   1. 先复制，源目录**还在** —— 中途失败不丢数据；
 *   2. 复制完比对条目数与总字节数，确认完整；
 *   3. 只有前两步都过了才删源。宁可留下一份多余的 staging，
 *      也绝不能出现"旧的已经删了、新的没到"。
 *
 * 保持"失败即抛错"是为了让 7 个既有调用点的 try/catch 与回滚逻辑原样可用。
 */
async function movePath(from, to) {
  try {
    await movePath(from, to);
    return;
  } catch (e) {
    /* 只有跨卷才兜底；其它错误（权限、占用、目标已存在）照原样抛出去 */
    if (!e || e.code !== 'EXDEV') throw e;
    logging.log('info', `[github] 跨卷移动（EXDEV），改用复制+校验: ${from} → ${to}`);
  }
  try {
    await fsp.cp(from, to, { recursive: true, force: true });
  } catch (e) {
    throw new Error(`跨卷复制失败（${path.basename(from)} → ${to}）: ${e.message}`);
  }
  const src = dirStats(from);
  const dst = dirStats(to);
  if (src.files !== dst.files || src.bytes !== dst.bytes) {
    /*
      不完整就**不删源**，让调用方的回滚逻辑拿到的仍是完好的一份。
      这里必须抛错而不是"尽力而为地继续" —— 一个缺文件的安装目录
      比一次失败难排查得多。
    */
    throw new Error(
      `跨卷复制不完整（源 ${src.files} 项/${src.bytes} 字节，目标 ${dst.files} 项/${dst.bytes} 字节），已保留原目录`
    );
  }
  await fsp.rm(from, { recursive: true, force: true });
}

/**
 * 统计目录的条目数与总字节数，用于跨卷复制后的完整性比对。
 * 两侧用同一套口径（目录也计入 files），所以可比。读不到的条目在两侧
 * 同样跳过，偏差会在比对时暴露出来而不是被抹平。
 */
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isSymbolicLink()) {
          files += 1;
        } else if (e.isDirectory()) {
          files += 1;
          stack.push(full);
        } else if (e.isFile()) {
          files += 1;
          bytes += fs.statSync(full).size;
        }
      } catch (_) {
        /* 读不到就不计入 */
      }
    }
  }
  return { files, bytes };
}

/**
 * SnowLuma 可识别的入口文件名。
 * 官方发布包（SnowLuma-v<ver>-win-x64.zip）解压后根目录就有 index.mjs，
 * 同目录还有 node.exe / native/ / client/ / package.json。
 * 只认 index.mjs：它是 package.json 里声明的 main，也是 launcher.bat 的入口。
 */
const SNOWLUMA_ENTRIES = ['index.mjs'];

/**
 * 从一次 release 的附件里挑出该下载哪个（纯函数，便于测试）。
 *
 * 挑选顺序（从严到宽）：
 *   1. win + x64 + 非 lite   ← 正是我们要的完整包
 *   2. 任意 win + 非 lite
 *   3. 任意非 lite 的 zip
 *
 * ⚠️ lite 变体在**每一档**都被排除，顺序放宽也绝不选它。
 *    官方发布资产里有两种：
 *      SnowLuma-v1.14.19-win-x64.zip       36.1MB  自带 node.exe
 *      SnowLuma-v1.14.19-win-x64-lite.zip   4.5MB  不含 node.exe
 *    lite 包要求用户机器上自备 Node，而启动器承诺开箱即用。
 *    只做"优先选非 lite"是不够的 —— 一旦哪次发布没有完整包，
 *    就会静默退到 lite，用户装完启动失败却看不出原因。
 *
 * @param {Array<{name:string,browser_download_url:string}>} assets
 * @returns {object|null}
 */
function pickSnowLumaAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const isZip = (a) => /\.zip$/i.test(String(a?.name || ''));
  const notLite = (a) => !/lite/i.test(String(a?.name || ''));
  return (
    list.find((a) => isZip(a) && notLite(a) && /win/i.test(a.name) && /x64|amd64/i.test(a.name)) ||
    list.find((a) => isZip(a) && notLite(a) && /win/i.test(a.name)) ||
    list.find((a) => isZip(a) && notLite(a)) ||
    null
  );
}

/* ============================================================================
 *  安装 SnowLuma
 * ========================================================================== */

/**
 * 下载并安装 SnowLuma。
 *
 * 几条**有意为之**的规则：
 *   · 发布包命名是 `SnowLuma-v<版本>-<平台>.zip`，win 平台还有 lite 变体。
 *     必须**排除 lite** —— lite 包不含 node.exe，要求用户机器上自备 Node，
 *     而我们的启动器承诺开箱即用（自带运行时才对）。
 *   · 平台限定 win-x64（启动器本身就是 Windows 桌面程序）。
 *
 * 默认安装到 <targetDir>/snowluma。
 */
async function installSnowLuma(opts = {}) {
  /*
    本地校验放在探测仓库**之前**：installMaiBot 早就是这么做的
    （原顺序是 resolveRepo → 再检查 targetDir，参数不对也先发一次网络请求）。
  */
  if (!opts.targetDir || typeof opts.targetDir !== 'string') {
    return { ok: false, message: '未指定安装目录' };
  }
  if (isDeniedPath(opts.targetDir)) {
    logging.log('warn', `[install] 拒绝安装到系统/自动执行目录: ${opts.targetDir}`);
    return { ok: false, message: `该位置属于系统/自动执行目录，不允许安装: ${opts.targetDir}` };
  }
  const { repo } = await resolveRepo(opts.repo, 'snowluma');
  const version = opts.version || 'latest';
  const work = paths.workDir('snowluma-install');
  const tmpZip = path.join(work, 'snowluma.zip');
  const tmpDir = path.join(work, 'extract');

  try {
    const installRoot = path.join(opts.targetDir, 'snowluma');

    let fileName = safeFileName(opts.fileName);
    let assetUrl = '';
    /* 上游发布的 sha256（SnowLuma 每个 zip 都有），用于下完逐字节比对 */
    let assetSha = '';

    if (!fileName) {
      const info = await getReleases(repo, 30);
      const release =
        version === 'latest'
          ? info.releases.find((r) => !r.prerelease) || info.releases[0]
          : info.releases.find((r) => r.tag_name === version);
      if (!release) return { ok: false, message: `未找到版本 ${version}` };

      /*
        挑附件交给纯函数，规则集中在 pickSnowLumaAsset 里（含"绝不选 lite"）。
      */
      const asset = pickSnowLumaAsset(release.assets);

      if (!asset) {
        return {
          ok: false,
          message: `版本 ${release.tag_name} 中没有可用的 Windows 完整包（已排除 lite）`,
          available: release.assets.map((a) => a.name)
        };
      }
      fileName = safeFileName(asset.name);
      assetUrl = asset.browser_download_url;
      assetSha = String(asset.digest || '');
      opts.resolvedTag = release.tag_name;
    }

    const url = assetUrl || releaseAssetUrl(repo, version, fileName);
    const dl = await downloadToFile({
      url,
      destFile: tmpZip,
      tag: TAG.snowluma,
      fileName,
      expectSha256: assetSha,
      threads: downloadThreads()
    });
    if (!dl.ok) return { ok: false, message: dl.message };

    const ex = await extractZip(tmpZip, tmpDir);
    if (!ex.ok) return { ok: false, message: `解压失败: ${ex.message || ex.output}` };

    const top = findTopLevel(tmpDir);
    const entry = findEntry(top, SNOWLUMA_ENTRIES);
    if (!entry) {
      return {
        ok: false,
        message: '解压后未找到 SnowLuma 入口（index.mjs），可能下到了 lite 包或错误的附件'
      };
    }

    /*
      完整性校验：没有 node.exe 说明拿到的不是我们想要的那个包。
      这里**只告警不失败** —— 用户机器上装了 Node 时它仍能跑，
      直接判失败会误伤；但日志和返回值里要如实说明，免得后面启动失败时找不到原因。
    */
    const hasBundledNode = fs.existsSync(path.join(top, 'node.exe'));
    if (!hasBundledNode) {
      logging.log(
        'warn',
        '[install] SnowLuma 包内没有 node.exe（可能是 lite 包），将改用系统 PATH 里的 node 启动'
      );
    }

    await swapDirectory(top, installRoot, { keepBackup: false });

    logging.log('info', `[install] SnowLuma 安装完成 → ${installRoot}（入口 ${entry}）`);
    return {
      ok: true,
      path: installRoot,
      entry,
      hasBundledNode,
      version: opts.resolvedTag || version,
      fileName,
      message: hasBundledNode
        ? 'SnowLuma 安装完成'
        : 'SnowLuma 安装完成（包内无 node.exe，启动将使用系统 node）'
    };
  } catch (e) {
    logging.log('error', `[install] SnowLuma 安装失败: ${e.message}`);
    return { ok: false, message: `SnowLuma 安装失败: ${e.message}` };
  } finally {
    paths.removeDir(work);
  }
}

/* ============================================================================
 *  升级备份目录的发现与清理
 *  ---------------------------------------------------------------------------
 *  为什么需要：
 *    upgradeMaiBot 与安装时的目录替换都**故意保留**旧版本备份（这是正确的，
 *    用户需要能回退）。但重构前没有任何"发现这些备份"的接口，
 *    每升级一次就多出一份完整旧版本（MaiBot 含依赖可达数百 MB），
 *    用户既看不到也不知道能删，磁盘被静默吃掉。
 *    这里提供列出与清理能力，把决定权交回用户。
 * ========================================================================== */

/**
 * 备份目录的命名规则（**唯一来源**，列出与删除必须用同一份）。
 *   <name>.backup-<ISO时间戳>   升级产生（upgradeMaiBot）
 *   <name>.old-<ISO时间戳>      安装时替换产生（swapDirectory）
 *
 * 抽成函数的原因：versions.js 的"删除受管版本"也要按同一规则认目录 ——
 * 规则写在两处，迟早会一边改了另一边没改，那就变成"列得出、删不掉"或者反向的灾难。
 *
 * @param {string} installDir 当前安装目录（如 D:\MaiBot 或 D:\x\snowluma）
 * @returns {RegExp}
 */
function backupNamePattern(installDir) {
  const base = path.basename(String(installDir || '').trim());
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}\\.(backup|old)-\\d{4}-\\d{2}-\\d{2}T`);
}

/**
 * 扫描某个安装位置旁边的所有备份目录。
 * 识别两类命名（与写入方保持一致）：
 *   <name>.backup-<ISO时间戳>   升级产生
 *   <name>.old-<ISO时间戳>      安装时替换产生
 *
 * @param {string} installDir 当前安装目录（如 D:\MaiBot 或 D:\x\snowluma）
 * @returns {Promise<Array<{path:string, name:string, sizeBytes:number, fileCount:number, mtimeMs:number}>>}
 */
async function listBackups(installDir) {
  const dir = typeof installDir === 'string' ? installDir.trim() : '';
  if (!dir) return [];

  const parent = path.dirname(dir);
  let entries = [];
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  /* 只认「同名前缀 + 已知后缀」的兄弟目录，绝不误删用户其他目录 */
  const pattern = backupNamePattern(dir);

  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !pattern.test(ent.name)) continue;
    const full = path.join(parent, ent.name);
    let sizeBytes = 0;
    let fileCount = 0;
    let mtimeMs = 0;
    try {
      const st = await fsp.stat(full);
      mtimeMs = st.mtimeMs;
      const measured = await measureTree(full);
      sizeBytes = measured.sizeBytes;
      fileCount = measured.fileCount;
    } catch (_) {
      /* 单个备份统计失败不应中断整个列表 */
    }
    out.push({ path: full, name: ent.name, sizeBytes, fileCount, mtimeMs });
  }

  /* 新的在前 */
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * 递归统计目录体积与文件数（有上限保护，避免超大目录卡死主进程）。
 * @param {string} root
 */
async function measureTree(root, limits = { maxFiles: 50000, maxMs: 8000 }) {
  let sizeBytes = 0;
  let fileCount = 0;
  const start = Date.now();
  const stack = [root];

  while (stack.length) {
    if (fileCount > limits.maxFiles || Date.now() - start > limits.maxMs) break;
    const cur = stack.pop();
    let items = [];
    try {
      items = await fsp.readdir(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const it of items) {
      const full = path.join(cur, it.name);
      try {
        if (it.isDirectory()) {
          stack.push(full);
        } else if (it.isFile()) {
          const st = await fsp.stat(full);
          sizeBytes += st.size;
          fileCount += 1;
        }
      } catch (_) {
        /* 跳过无法访问的条目 */
      }
    }
  }
  return { sizeBytes, fileCount };
}

/**
 * 清理备份目录。
 *
 * 安全设计（这是删除用户数据，必须保守）：
 *   1) 只允许删除**父目录与当前安装目录相同**、且目录名匹配备份模式的路径 ——
 *      即使前端被篡改传入任意路径，也不会删掉无关目录。
 *   2) 必须显式传入 paths 数组，不支持"全部删除"这种一键操作。
 *   3) 支持 dryRun 预览，前端可以先展示将释放多少空间。
 *
 * @param {{installDir:string, paths:string[], dryRun?:boolean}} opts
 */
async function cleanBackups(opts = {}) {
  const installDir = typeof opts.installDir === 'string' ? opts.installDir.trim() : '';
  const want = Array.isArray(opts.paths) ? opts.paths.filter((p) => typeof p === 'string' && p) : [];
  const dryRun = Boolean(opts.dryRun);

  if (!installDir) return { ok: false, message: '未指定安装目录' };
  if (!want.length) return { ok: false, message: '未指定要清理的备份目录' };

  const parent = path.dirname(installDir);
  const pattern = backupNamePattern(installDir);

  /* 先做全量校验：任何一项不合法就整体拒绝，不做"部分删除" */
  const resolved = [];
  for (const p of want) {
    const full = path.resolve(p);
    if (path.dirname(full) !== path.resolve(parent)) {
      return { ok: false, message: `拒绝删除非同级目录: ${p}` };
    }
    if (!pattern.test(path.basename(full))) {
      return { ok: false, message: `目录名不符合备份命名规则: ${p}` };
    }
    if (!fs.existsSync(full)) continue;
    resolved.push(full);
  }

  if (!resolved.length) return { ok: true, removed: [], freedBytes: 0, message: '没有需要清理的备份' };

  if (dryRun) {
    let freed = 0;
    for (const full of resolved) {
      try {
        freed += (await measureTree(full)).sizeBytes;
      } catch (_) {
        /* 忽略 */
      }
    }
    return {
      ok: true,
      dryRun: true,
      removed: resolved,
      freedBytes: freed,
      message: `将删除 ${resolved.length} 个备份，释放约 ${humanSize(freed)}`
    };
  }

  const removed = [];
  let freedBytes = 0;
  const failed = [];
  for (const full of resolved) {
    try {
      const measured = await measureTree(full);
      await fsp.rm(full, { recursive: true, force: true, maxRetries: 2 });
      removed.push(full);
      freedBytes += measured.sizeBytes;
      logging.log('info', `[cleanup] 已删除备份 ${path.basename(full)}（释放 ${humanSize(measured.sizeBytes)}）`);
    } catch (e) {
      failed.push({ path: full, message: e.message });
      logging.log('warn', `[cleanup] 删除备份失败 ${full}: ${e.message}`);
    }
  }

  return {
    ok: failed.length === 0,
    removed,
    failed,
    freedBytes,
    message: failed.length
      ? `已删除 ${removed.length} 个，${failed.length} 个失败（可能被占用）`
      : `已删除 ${removed.length} 个备份，释放 ${humanSize(freedBytes)}`
  };
}

/* ============================================================================
 *  还原备份（把某个备份目录换回成"当前使用的安装"）
 *  ---------------------------------------------------------------------------
 *  为什么需要：
 *    listBackups 能看见旧版本、cleanBackups 能删掉旧版本，但**没有一条路能把
 *    旧版本换回来** —— 升级时那次自动回滚是 upgradeMaiBot 的内部逻辑，
 *    用户按不到。于是磁盘上明明躺着完整的旧版本备份，用户却只能"删"。
 *    这里补上"还原"这一半，并把每一步的真实结果如实返回。
 *
 *  顺序（有意如此，任何一条不满足都**在动磁盘之前**拒绝）：
 *    ① 入参解析 → 路径存在且是目录；
 *    ② 备份不能是"当前正在使用"的那个目录本身；
 *    ③ MaiBot 正在运行 → 拒绝（改目录名会失败/破坏它正在用的文件）；
 *    ④ 备份必须真的是一套麦麦安装（findEntry + scanner.detectType，不靠名字）；
 *    ⑤ 受管根限制：复用 versions.managedRoots()（realpath 前缀判据，不另写一套）；
 *    ⑥ 必须是"当前安装目录"的同级目录，且命名符合备份规则（<dir>.backup-…/.old-…）；
 *    ⑦ 交换：当前目录 → <目录>.backup-<新时间戳>，备份 → 当前目录。
 *
 *  ⚠️ ⑤ 特意排在 ⑥ 之前：两条判据用的都是 realpath，若先判同级，那么
 *  "realpath 的上级 == 当前安装的上级"一旦成立，realpath 必然已在受管根内部，
 *  ⑤ 就永远不可能失败、成了测不到的摆设。现在的顺序让两条都真能拦到东西。
 *
 *  交换用 fsp.rename（同卷纯元数据操作，原子）而**不是** movePath：
 *    movePath 在本文件里是"跨卷兜底"的实现，而它的第一行就是
 *    `await movePath(from, to)` 递归调用自己（:2343-2345），一调用就栈溢出。
 *    还原的目标与来源永远是同一个受管父目录下的兄弟目录（上面第 ⑤ 条保证），
 *    必然同卷，rename 就够；真出 EXDEV 也**照原样报错回滚**，绝不静默复制。
 *
 *  @param {{path:string}} opts 渲染层给的目标备份目录（**不可信**，逐条重校验）
 * @returns {Promise<{ok:boolean, message:string, restoredFrom?:string, restoredTo?:string,
 *                    newBackupDir?:string, swapped?:Array, elapsedMs?:number, deniedReason?:string}>}
 */
async function restoreBackup(opts = {}) {
  const startedAt = Date.now();
  const raw = typeof opts?.path === 'string' ? opts.path.trim() : '';
  if (!raw) return { ok: false, deniedReason: 'invalid', message: '未指定要还原的备份目录' };

  let abs;
  try {
    abs = path.resolve(raw);
  } catch (_) {
    return { ok: false, deniedReason: 'invalid', message: `路径无法解析：${raw}` };
  }

  /* ---- ① 备份必须真实存在且是目录 ---- */
  if (!fs.existsSync(abs)) {
    return { ok: false, deniedReason: 'missing', message: `备份目录不存在（可能已被删除）：${abs}` };
  }
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    return { ok: false, deniedReason: 'missing', message: `无法读取备份目录 ${abs}：${e.message}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, deniedReason: 'not-directory', message: `该路径不是目录，已拒绝：${abs}` };
  }
  const real = realKey(abs);

  /* ---- 当前正在使用的安装目录（唯一权威来源：设置 service.maibotDir） ---- */
  const { activeMaibotDir, managedRoots } = require('./versions');
  const active = activeMaibotDir();
  if (!active) {
    return {
      ok: false,
      deniedReason: 'no-active',
      message:
        '设置里没有可用的「MaiBot 目录」，无法确定要把这个备份还原到哪里。' +
        '请先在「设置 → 服务与目录」里指定麦麦安装目录。'
    };
  }
  const activeReal = realKey(active);
  /*
    "当前安装目录的上一级"就是受管根（versions.managedRoots() 的第一项），
    也是备份必须待的地方 —— 先算出来，⑤⑥ 两条判据都用它。
  */
  const parent = path.dirname(activeReal);

  /* ---- ② 不能还原"当前正在使用"的那个目录 ---- */
  if (normKey(real) === normKey(activeReal)) {
    return {
      ok: false,
      deniedReason: 'is-active',
      message: `「${path.basename(real)}」就是当前正在使用的麦麦目录（${activeReal}），不需要还原。`
    };
  }

  /* ---- ③ 麦麦正在运行时拒绝（与 upgradeMaiBot 同一判据、同一理由） ---- */
  if (isMaiBotRunning()) {
    logging.log('warn', `[restore] MaiBot 正在运行，拒绝还原 ${real}`);
    return {
      ok: false,
      deniedReason: 'running',
      running: true,
      message:
        'MaiBot 正在运行，还原会替换它正在使用的安装目录（Windows 上目录改名会失败，' +
        '还可能留下半新半旧的目录）。请先在总览页点「停止」，再回来还原。'
    };
  }

  /* ---- ④ 备份必须真的是一套麦麦安装（名字像不算数） ---- */
  let scanner = null;
  try {
    scanner = require('./scanner');
  } catch (e) {
    return {
      ok: false,
      deniedReason: 'detect-failed',
      message: `无法加载目录识别模块，已拒绝还原（不猜）：${e.message}`
    };
  }
  const entry = findEntry(real, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py']);
  const kind = scanner.detectType(real);
  if (kind !== 'maibot') {
    logging.log('warn', `[restore] 拒绝还原非麦麦目录: ${real}（detectType=${kind || 'null'}）`);
    return {
      ok: false,
      deniedReason: 'not-maibot',
      detectedKind: kind || null,
      entry: entry || '',
      message:
        `${real} 不像麦麦安装（scanner 的判据是 bot.py + src/ + MaiBot 独有结构，` +
        `当前识别结果：${kind || '认不出'}${
          entry ? `；只找到入口文件 ${entry}，缺少 src/ 或 MaiBot 独有结构` : '；连入口文件都没有'
        }）。还原只接受**确实是麦麦安装**的目录，已拒绝。`
    };
  }

  /* ---- ⑤ 受管根限制：复用 versions.managedRoots() 的 realpath 前缀判据 ---- */
  /*
    为什么这一步排在"必须同级"**之前**（而不是紧跟其后）：
      两条判据用的都是 realpath。若先判同级，那么"realpath 的上级 == 当前安装的
      上级"一旦成立，realpath 必然落在受管根（当前安装目录的上一级就是受管根）
      内部 —— 这一条就永远不可能失败，变成一段测不到的摆设。
      两条判据各挡一类，顺序让它们**都能真正拦到东西**：
        · 这一条先挡"压根不在受管根里"的路径（含 junction/符号链接逃逸到外面）；
        · 下一条再挡"在受管根里、但不是当前安装的同级目录"的路径。
  */
  const roots = managedRoots();
  const inside = roots.some((r) => isUnder(real, r) && normKey(real) !== normKey(r));
  /*
    注意这里**不**把"等于父目录"混进 inside 的判定：
    ① 父目录本身在受管根里 —— 这一条只需要回答"在不在根内部"；
    ② "它正好是当前安装的上一级"由下一关的同级判据去挡
       （否则换成相对路径写法就绕过去了，两件事混在一起最容易出错）。
  */
  if (!inside) {
    logging.log('warn', `[restore] 拒绝还原受管根之外的备份: ${real}`);
    return {
      ok: false,
      deniedReason: 'out-of-root',
      managedRoots: roots,
      message:
        `只允许还原启动器受管目录**内部**的备份（${roots.join(' / ') || '（当前没有可用受管根）'}）；` +
        `${real} 不在其中，已拒绝。`
    };
  }

  /* ---- ⑥ 必须是当前安装目录的同级目录 ---- */
  /* 同样基于 realpath：junction 指到哪儿就以哪儿为准（防软链接逃逸）。 */
  if (normKey(path.dirname(real)) !== normKey(parent)) {
    return {
      ok: false,
      deniedReason: 'not-sibling',
      message:
        `备份必须是当前安装目录的同级目录才能还原（当前安装目录：${activeReal}）。` +
        `而 ${real} 的上级是 ${path.dirname(real)}，不是 ${parent}，已拒绝。`
    };
  }
  if (!backupNamePattern(path.basename(activeReal)).test(path.basename(real))) {
    return {
      ok: false,
      deniedReason: 'bad-name',
      message:
        `目录名不符合备份命名规则（应为 ${path.basename(activeReal)}.backup-<时间戳> ` +
        `或 ${path.basename(activeReal)}.old-<时间戳>）：${path.basename(real)}，已拒绝。`
    };
  }

  /* ---- ⑦ 交换：当前 → 新备份，旧备份 → 当前（失败必须回滚回去） ---- */
  let newBackupDir = `${activeReal}.backup-${timestamp()}`;
  for (let i = 1; fs.existsSync(newBackupDir) && i <= 50; i += 1) {
    newBackupDir = `${activeReal}.backup-${timestamp()}-${i}`;
  }
  if (fs.existsSync(newBackupDir)) {
    return {
      ok: false,
      deniedReason: 'backup-name-conflict',
      message: `无法为当前版本生成可用的新备份名（${newBackupDir} 已存在），已中止，原目录未改动。`
    };
  }

  const swapped = [];
  const elapsed = () => Date.now() - startedAt;

  /*
    当前目录可能不存在（用户在设置里指了一个还没装的路径）。
    这时不需要"先备份当前"，直接落位即可 —— 但要**如实说明**，
    不能让用户以为"当前版本已被保留为新备份"。
  */
  const activeExists = fs.existsSync(activeReal);

  try {
    if (activeExists) {
      await fsp.rename(activeReal, newBackupDir);
      swapped.push({ from: activeReal, to: newBackupDir });
      logging.log('info', `[restore] 当前版本已保留为新备份: ${path.basename(newBackupDir)}`);
    }
  } catch (e) {
    logging.log('error', `[restore] 备份当前版本失败，未做任何交换: ${e.message}`);
    return {
      ok: false,
      deniedReason: 'backup-current-failed',
      message:
        `无法把当前版本改名为新备份${e.code ? `（${e.code}）` : ''}：${e.message}。` +
        '已中止，原目录未改动（可能被其它进程占用）。'
    };
  }

  try {
    await fsp.rename(real, activeReal);
    swapped.push({ from: real, to: activeReal });
  } catch (e) {
    /* 交换失败 → 立刻把当前版本搬回去，保证用户目录可用 */
    if (activeExists && fs.existsSync(newBackupDir)) {
      try {
        await fsp.rename(newBackupDir, activeReal);
        logging.log('warn', '[restore] 交换失败，已把当前版本回滚回原位');
      } catch (re) {
        logging.log('error', `[restore] 回滚也失败: ${re.message}`);
        return {
          ok: false,
          deniedReason: 'swap-and-rollback-failed',
          restoredFrom: real,
          restoredTo: activeReal,
          newBackupDir,
          swapped,
          elapsedMs: elapsed(),
          message:
            `还原失败${e.code ? `（${e.code}）` : ''}：${e.message}；` +
            `且把当前版本搬回 ${activeReal} 也失败：${re.message}。` +
            `当前版本仍在 ${newBackupDir}，备份仍在 ${real} —— 请手动处理这两个目录。`
        };
      }
    }
    logging.log('error', `[restore] 交换失败，已回滚: ${e.message}`);
    return {
      ok: false,
      deniedReason: 'swap-failed',
      restoredFrom: real,
      restoredTo: activeReal,
      swapped,
      elapsedMs: elapsed(),
      message:
        `还原失败${e.code ? `（${e.code}）` : ''}：${e.message}。` +
        (activeExists
          ? '已把当前版本回滚回原位，备份保持未改动。'
          : '当前目录原本不存在，已保持原状。')
    };
  }

  /* ---- 落位后再确认一次：新位置真的是麦麦安装，否则回滚 ---- */
  const afterEntry = findEntry(activeReal, ['main.py', 'bot.py', 'maibot.py', 'launcher.py', 'run.py']);
  if (!afterEntry) {
    logging.log('error', '[restore] 交换后校验失败，正在回滚');
    try {
      await fsp.rename(activeReal, real);
      if (activeExists && fs.existsSync(newBackupDir)) await fsp.rename(newBackupDir, activeReal);
      return {
        ok: false,
        deniedReason: 'verify-failed-rolled-back',
        swapped,
        elapsedMs: elapsed(),
        message: '交换后新位置没找到入口文件，已回滚到还原前的状态（两个目录都在原处）。'
      };
    } catch (re) {
      return {
        ok: false,
        deniedReason: 'verify-failed',
        swapped,
        elapsedMs: elapsed(),
        message: `交换后的目录缺少入口文件，且自动回滚失败：${re.message}。请手动检查 ${activeReal} 与 ${real}。`
      };
    }
  }

  /* 登记落点，供安装结果页的「打开位置」使用（与 upgradeMaiBot 一致） */
  try {
    noteAppCreatedPath(activeReal);
    if (activeExists) noteAppCreatedPath(newBackupDir);
  } catch (_) {
    /* 登记失败不影响还原结果 */
  }

  const lines = [
    `已用备份「${path.basename(real)}」还原当前安装`,
    `当前安装目录：${activeReal}（入口 ${afterEntry}）`,
    activeExists
      ? `还原前的当前版本已保留为新备份：${path.basename(newBackupDir)}`
      : '还原前当前目录不存在，因此没有产生新备份',
    `交换：${swapped.map((s) => `${path.basename(s.from)} → ${path.basename(s.to)}`).join('；')}`,
    `耗时 ${elapsed()} ms`
  ];
  logging.log('warn', `[restore] ${lines.join(' | ')}`);

  return {
    ok: true,
    restoredFrom: real,
    restoredTo: activeReal,
    entry: afterEntry,
    newBackupDir: activeExists ? newBackupDir : '',
    swapped,
    elapsedMs: elapsed(),
    message: lines.join('\n')
  };
}

/** 人类可读体积（与 data.js 口径一致，避免两处显示不同） */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  getReleases,
  getLatestRelease,
  downloadAsset,
  downloadToFile,
  installMaiBot,
  upgradeMaiBot,
  installSnowLuma,
  listBackups,
  cleanBackups,
  restoreBackup,
  /* 备份命名规则：versions.js 的"删除受管版本"复用同一份（避免两处漂移） */
  backupNamePattern,
  /* 路径与体积工具：versions.js 复用同一份口径 */
  isUnder,
  normKey,
  measureTree,
  humanSize,
  /* 导出以便测试 */
  safeFileName,
  safeRepo,
  resolveRepo,
  candidateUrls,
  /* 纯函数，便于对"绝不选 lite 包"这条规则做回归测试 */
  pickSnowLumaAsset,
  /* 下载源测速（导出以便验证"真的会选快的那个"） */
  measureSpeed,
  orderBySpeed,
  /* 多线程下载与校验的纯逻辑，导出以便回归测试 */
  parseDigest,
  normalizeRelease,
  resolveSegmentCount,
  hashFile,
  /* 路径策略：shell:open-path（index.js）复用同一份判断 */
  isPathAllowed,
  isDeniedPath,
  isExecutablePath,
  noteAppCreatedPath,
  resolveDownloadDest,
  /* 解压（含 Zip-Slip 前置校验），导出以便回归测试 */
  extractZip,
  isUnsafeZipEntry,
  SEGMENT_MIN_BYTES,
  SEGMENT_MAX_COUNT,
  SEGMENT_MIN_COUNT
};
