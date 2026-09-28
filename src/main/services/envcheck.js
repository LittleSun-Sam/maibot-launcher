/*
================================================================================
技术文档：src/main/services/envcheck.js
职责：新手引导用的环境探测——目录归属判定、MaiBot 版本、可运行性、工具链。
================================================================================
  为什么单独抽一层：
    引导向导要"每一步都能给出真实证据"，而不是只显示一段说明文字。
    它需要问两件事，而这两件事散落在别处、且各有各的坑：

      1) 用户选的那个目录到底是 MaiBot 还是 SnowLuma？
         → 复用 scanner.detectType（与"扫描常见目录"用的是同一套特征），
            避免两处判定规则漂移，出现"扫描能认出来、手选却说不认识"。

      2) 该目录能不能真的跑起来？
         → 入口文件探测。与 process.js 的启动参数探测保持同一候选清单，
           否则会出现"向导说可以跑，点启动却失败"。

  设计原则：**探测只用于提示，不用来替用户打勾。**
    所以这里只如实返回事实，不做"是否算完成"的判断 ——
    那属于渲染层 steps.js 的职责，且必须由用户点击确认。
================================================================================
*/
const fs = require('fs');
const path = require('path');
const constants = require('../constants');

/*
  ⚠️ 这里删掉了 detectQq()（本机 QQ 安装探测）和它对 qqnt.js 的依赖。
  它存在的唯一理由是 QQ 注入式协议端需要 QQ.exe 才能 Hook；
  SnowLuma 是独立 Node 程序，自己实现协议、不碰 QQ 客户端。
  继续探测只会让向导显示一条"没检测到 QQ"的无用警告。
*/

/** 目录归属判定：返回 maibot / snowluma / unknown，并给出可运行性 */
function detectDirKind(dir) {
  const target = String(dir || '').trim();
  if (!target) {
    return { ok: false, kind: 'unknown', message: '未指定目录' };
  }
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    return { ok: false, kind: 'unknown', message: `无法读取目录：${e.message}` };
  }

  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  /*
    复用 scanner 的判定，**必须把 entries 一起传进去**。
    判定要看"那个同名条目到底是文件还是目录"：
    `Documents\Tencent Files` 里那个以协议端命名的目录只存 data/temp，不是安装。
    只传名字做不到这件事 —— 而这里以前正是只传名字，
    于是"某个框架的 modules 文件夹"会被报成协议端安装。
  */
  const scanner = require('./scanner');
  const hit = scanner.inspectDir(target, entries);
  const kind = hit ? hit.type : 'unknown';

  /* 入口候选必须与 process.js 的启动探测保持一致，否则会自相矛盾 */
  const ENTRIES = {
    maibot: ['bot.py', 'main.py', 'maibot.py', 'launcher.py', 'run.py'],
    snowluma: ['index.mjs', 'launcher.bat']
  };
  /* 判定给出的入口优先（它是真实存在的那个文件），否则再按候选表找 */
  const candidates = hit?.entry ? [hit.entry, ...(ENTRIES[kind] || [])] : ENTRIES[kind] || [];
  const entry = candidates.find((c) => names.has(c.toLowerCase())) || '';

  const versionText = hit?.version ? `，版本 ${hit.version}` : '';
  /*
    两条版本线必须分开说（详见 README「版本线：这里有两条，别混」）：
      · 启动器准入线 —— 主版本 < 1（0.x）不给启动，这条决定 supported 的值；
      · SnowLuma 适配器线 —— 官方适配器要求 MaiBot ≥ 1.2.0。
    只报第一条会给出一个"照做仍然连不上"的建议（"重装到 1.0.0 或更新"），
    用户装完 1.0.x 依旧接不上 SnowLuma、而且拿不到任何指向版本的解释。
    阈值本身**不变**（仍是 MIN_MAIBOT_MAJOR.0.0），只是把目标版本说清楚。
    断言依赖：scripts/verify-scan.mjs:523 要求本消息仍包含 `1.0.0`。
  */
  const legacyWarn =
    hit?.type === 'maibot' && hit.supported === 'unsupported'
      ? `。这个版本（${hit.version}）低于启动器支持的最低版本（${scanner.MIN_MAIBOT_MAJOR}.0.0），启动器不会启动它` +
        `；要接 SnowLuma 还需要 1.2.0 或更新（官方适配器的要求），建议直接重装到 1.2.x`
      : '';

  return {
    ok: true,
    kind,
    dir: target,
    entry,
    runnable: Boolean(entry),
    /* 把判定依据、版本、是否受支持一并返回：界面能解释"为什么说它是 MaiBot"，
       也能直接告诉用户"这个版本的配置格式已经不支持了" */
    evidence: hit?.evidence || '',
    version: hit?.version || '',
    versionSource: hit?.versionSource || '',
    supported: hit?.supported || 'unknown',
    message:
      kind === 'unknown'
        ? '这个目录看起来既不是 MaiBot 也不是 SnowLuma，请确认选对了'
        : kind === 'maibot'
          ? entry
            ? `识别为 MaiBot（入口 ${entry}${versionText}）${legacyWarn}`
            : `识别为 MaiBot，但没找到可用的入口文件${versionText}${legacyWarn}`
          : entry
            ? `识别为 SnowLuma（入口 ${entry}${versionText}）`
            : `识别为 SnowLuma，但没找到可用的启动入口${versionText}`
  };
}

/**
 * 一次性汇总引导所需的全部环境事实。
 * 让渲染层一次拿齐，避免向导里连打六七个 IPC 造成逐条闪动。
 *
 * @param {object} deps
 * @param {object} deps.settings settings 服务
 * @param {object} deps.services 服务状态读取函数（getServicesStatus）
 */
async function detectAll(deps = {}) {
  const settings = deps.settings;
  let svc = {};
  try {
    svc = settings?.getBackendSettings?.()?.service || {};
  } catch (_) {
    svc = {};
  }

  const maibot = detectDirKind(svc.maibotDir);
  /* 协议端只有 SnowLuma 一种了（用户明确要求抛弃 QQ 注入那套） */
  const snowluma = detectDirKind(svc.snowlumaDir);
  const maibotVersion = detectMaiBotVersion(svc.maibotDir);
  const tools = await detectTools(svc.pythonPath);

  let running = null;
  try {
    /*
      注意是同步的：getServicesStatus() 读的是内存里的进程注册表，
      返回数组而不是 Promise。这里不加 await（加了也不报错但会误导读者）。
    */
    running = typeof deps.getServicesStatus === 'function' ? deps.getServicesStatus() : null;
  } catch (_) {
    running = null;
  }

  return {
    ok: true,
    maibot,
    maibotVersion,
    snowluma,
    tools,
    running,
    dirs: {
      maibotDir: svc.maibotDir || '',
      snowlumaDir: svc.snowlumaDir || '',
      pythonPath: svc.pythonPath || 'python'
    }
  };
}

/** 该目录下的 config 子目录是否存在（MaiBot 和 SnowLuma 都有这个概念） */
function hasConfigDir(dir) {
  const target = String(dir || '').trim();
  if (!target) return false;
  try {
    return fs.existsSync(path.join(target, 'config'));
  } catch (_) {
    return false;
  }
}

/* ============================================================================
 *  MaiBot 版本识别
 * --------------------------------------------------------------------------
 *  ⚠️ 这是本项目此前**完全缺失**、且后果最严重的一项检查。
 *
 *  事实（已联网核对官方文档 + 实机核对用户磁盘）：
 *    · 官方当前文档与官方协议端适配器 v1.4.0 只支持 **MaiBot ≥ 1.2.0**
 *    · 但 2025 年 5 月的 **0.6.x** 是完全不同的架构：
 *        - 配置在 `template/bot_config_template.toml`，[bot] 里是 `qq = <整数>`
 *        - 平台走 `[platforms]` 的 URL 点对点
 *        - 需要一个**独立程序**适配器（`main.py`），协议端要开
 *          **WebSocket 客户端** 指向适配器的 8095
 *        - 依赖 MongoDB
 *    · 1.2.x 则是插件化：`config/bot_config.toml`（`qq_account` 字符串）、
 *      `plugins/<名>/_manifest.json`、协议端开**正向 WS 服务**
 *      （旧的 QQ 注入式协议端默认 3001；SnowLuma 的默认端口见 constants.js）
 *
 *  混起来的后果：把 0.6.x 当 1.2.x 引导，用户每一步都"照做了"但永远连不上，
 *  而且没有任何地方告诉他根因是版本。
 *
 *  所以这里给出明确的三态：supported / unsupported / unknown。
 *  **判定不出来就说判定不出来**，不猜 —— 猜错等于骗用户。
 * ========================================================================== */

/** 读一个 JSON 文件，失败返回 null（不抛） */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 1.2.x 的插件清单：`plugins/<名>/_manifest.json` */
function listPlugins(dir) {
  const base = path.join(String(dir || ''), 'plugins');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const manifest = readJson(path.join(base, e.name, '_manifest.json'));
      return {
        name: e.name,
        hasManifest: Boolean(manifest),
        /* 没有 _manifest.json 的目录不会被 1.2.x 识别（官方文档明确写了） */
        version: manifest?.version ? String(manifest.version) : '',
        enabled: null
      };
    });
}

/**
 * 找官方 SnowLuma 适配器插件。
 *
 * ⚠️ 匹配规则要**排除** `snowluma` 这个裸名字：
 *    社区里流传一份第三方打包的 `plugins/snowluma-adapter`（配置版本 1.0.0），
 *    与官方 `MaiBot-SnowLuma-Adapter`（配置版本 1.0.6）**不是同一个插件**。
 *    如果一个目录同时存在两者，正确的那个是官方的，所以这里优先官方名，
 *    并且把"只找到第三方那份"的情况如实标出来（kind 字段），
 *    交给界面提示用户 —— 否则用户会以为装对了，接完线却连不上。
 *
 * @returns {{name,hasManifest,version,enabled,kind:'official'|'fork'}|null}
 */
function findSnowlumaAdapter(plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  const byName = (re) => list.find((p) => re.test(p.name));
  /* 官方名优先（大小写与连字符都可能被用户改，所以用宽松匹配） */
  const official =
    byName(/MaiBot[-\s_]?SnowLuma[-\s_]?Adapter/i) ||
    byName(/snowluma.*adapter/i) ||
    null;
  if (official) {
    /*
      `snowluma-adapter` / `SnowLuma-Adapter` 这种没有 MaiBot 前缀的，
      无法确定是官方还是第三方 —— 归为 fork 让界面去提示，
      总比默默当成官方的强。
    */
    const isOfficialName = /MaiBot[-\s_]?SnowLuma[-\s_]?Adapter/i.test(official.name);
    return { ...official, kind: isOfficialName ? 'official' : 'fork' };
  }
  return null;
}

/**
 * 检测 SnowLuma 适配器插件是否已就位。
 *
 * 这是「接线」里启动器**能真正验证**的那一半：
 *   端口那半边只能探测（SnowLuma 的 OneBot 服务器要在它自己的 WebUI 里建），
 *   但"插件装没装、有没有 _manifest.json、是不是官方那个"是可以直接看文件系统确认的。
 *   装错的后果是接完线连不上且报错指不到原因，所以值得单独查。
 *
 * ⚠️ 以前这里还有个 `backend` 参数，用来在两种协议端之间选检测哪一份插件。
 *    协议端只剩 SnowLuma 了，那个参数和它的分支一起删掉。
 *
 * @param {{dir?:string}} opts
 */
function detectAdapter(opts = {}) {
  const dir = String(opts.dir || '').trim();
  const wanted = constants.ADAPTER;

  /*
    没配 MaiBot 目录时返回 ok:true + found:false，而不是 ok:false。
    区别很重要：这是一个**已知且可解释**的状态（用户还没设置目录），
    界面应该显示"请先设置 MaiBot 目录"，而不是走异常分支显示"检测失败"。
    对用户来说前者是可操作的，后者只会让人以为程序坏了。
  */
  if (!dir) {
    return {
      ok: true,
      found: false,
      reason: 'no-dir',
      message: '还没设置 MaiBot 目录，无法检查适配器插件',
      expectedDir: wanted.snowlumaDir,
      expectedConfigVersion: wanted.snowlumaConfigVersion,
      name: '',
      version: '',
      hasManifest: false,
      pluginCount: 0,
      plugins: []
    };
  }

  const plugins = listPlugins(dir);
  const hit = findSnowlumaAdapter(plugins);
  return {
    ok: true,
    expectedDir: wanted.snowlumaDir,
    expectedConfigVersion: wanted.snowlumaConfigVersion,
    found: Boolean(hit),
    name: hit?.name || '',
    version: hit?.version || '',
    hasManifest: Boolean(hit?.hasManifest),
    /* 'official' | 'fork' | '' —— 界面据此提示"你装的可能是第三方那份" */
    kind: hit?.kind || '',
    /* 第三方分支的配置版本与官方不同，写错会连不上 */
    nameMismatch: Boolean(hit) && hit.kind === 'fork',
    pluginCount: plugins.length,
    plugins: plugins.map((p) => p.name)
  };
}

/*
  官方 SnowLuma 适配器要求的 MaiBot 最低版本。
  ⚠️ 这是**第二条线**，不是启动器准入线：启动器准入线是 scanner.MIN_MAIBOT_MAJOR
  （≥1.0.0，见 scanner.classifyVersion 里记录的用户要求）。两条线混起来会得出
  "文档说 1.2.0、代码说 1.0.0，实现不一致"的错误结论 —— 它们本来就不是一回事。
  详见 README「版本线：这里有两条，别混」。
*/
const MIN_ADAPTER_MAIBOT = { major: 1, minor: 2 };

/** 该版本是否低于适配器线（读不到版本号 → 返回 false，不猜） */
function isBelowAdapterLine(version) {
  const m = /(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== MIN_ADAPTER_MAIBOT.major) return major < MIN_ADAPTER_MAIBOT.major;
  return minor < MIN_ADAPTER_MAIBOT.minor;
}

/**
 * 用 scanner 的单目录探测器读出**真实版本号**（例如 `1.1.4`）。
 * 读不到返回 '' —— 调用方必须把空串当成"不知道"，不许当成"够新"。
 * 懒 require：envcheck ↔ scanner 互相引用，顶层 require 会成环。
 */
function readNumericVersion(dir) {
  try {
    const scanner = require('./scanner');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const hit = scanner.inspectDir(dir, entries);
    return hit?.type === 'maibot' && hit.version ? String(hit.version) : '';
  } catch (_) {
    return '';
  }
}

/**
 * 判定一个 MaiBot 目录属于哪一代。
 * @param {string} dir
 * @returns {{ok:boolean, kind:'supported'|'unsupported'|'unknown', evidence:string[], ...}}
 */
function detectMaiBotVersion(dir) {
  const target = String(dir || '').trim();
  if (!target) {
    return { ok: false, kind: 'unknown', evidence: [], message: '未指定目录' };
  }
  if (!fs.existsSync(target)) {
    return { ok: false, kind: 'unknown', evidence: [], message: `目录不存在：${target}` };
  }

  const evidence = [];
  const has = (rel) => fs.existsSync(path.join(target, rel));

  /* ---- 0.6.x 的确凿特征 ---- */
  const oldMarkers = [
    'src/heart_flow',
    'src/individuality',
    'template/bot_config_template.toml',
    'template/template.env'
  ];
  const oldHits = oldMarkers.filter(has);
  if (oldHits.length) {
    evidence.push(...oldHits.map((m) => `0.6.x 特征: ${m}`));
  }

  /* ---- 1.2.x 的确凿特征 ---- */
  const newMarkers = ['config/bot_config.toml', 'src/config/startup_bindings.py', 'plugins'];
  const newHits = newMarkers.filter(has);
  if (newHits.length) {
    evidence.push(...newHits.map((m) => `1.2.x 特征: ${m}`));
  }

  const plugins = listPlugins(target);
  const adapter = findSnowlumaAdapter(plugins);
  const botConfigPath = path.join(target, 'config', 'bot_config.toml');
  const hasBotConfig = fs.existsSync(botConfigPath);

  let scheme = null;
  if (hasBotConfig) {
    const cfg = fs.readFileSync(botConfigPath, 'utf8');
    /* 两个字段的差异就是两代的分水岭：0.6.x 是 qq = 整数，1.2.x 是 qq_account = 字符串 */
    const hasQqAccount = /^\s*qq_account\s*=/m.test(cfg);
    const hasLegacyQq = /^\s*qq\s*=\s*\d+/m.test(cfg);
    if (hasQqAccount) scheme = 'qq_account';
    else if (hasLegacyQq) scheme = 'qq(整数)';
  }

  const base = {
    ok: true,
    dir: target,
    evidence,
    plugins,
    adapter,
    hasConfigDir: has('config'),
    hasBotConfig,
    scheme
  };

  /*
    判定优先级：0.6.x 特征一旦命中就判 unsupported。
    因为 `src/heart_flow` 这类目录名在 1.2.x 里根本不存在，
    命中即铁证；反过来 1.2.x 的 `plugins/` 在 0.6.x 里也可能被用户手建，
    所以 1.2.x 需要更多证据才敢认。
  */
  if (oldHits.length && !hasBotConfig) {
    return {
      ...base,
      kind: 'unsupported',
      version: '0.6.x',
      message:
        '这是 MaiBot 0.6.x 老版本，官方 SnowLuma 适配器只支持 ≥ 1.2.0。' +
        '两代架构完全不同（配置字段、适配器形态、WebSocket 方向、依赖数据库都不一样），' +
        '在同一套配置下无法接通。请改装 1.2.0 或更新的版本。'
    };
  }
  if (oldHits.length && hasBotConfig && scheme === 'qq(整数)') {
    return {
      ...base,
      kind: 'unsupported',
      version: '0.6.x',
      message:
        'bot_config.toml 里用的是老字段 `qq = <数字>`（0.6.x 写法），' +
        '而 1.2.x 要求 `qq_account = "<字符串>"`。这仍是旧版本，请重装 1.2.0+。'
    };
  }

  if (scheme === 'qq_account' || newHits.length >= 2) {
    /*
      ⚠️ 结构新 ≠ 版本够。
      1.0.x / 1.1.x 的目录结构与 1.2.x **完全一样**（config/bot_config.toml +
      `qq_account` 字符串），只按结构判会把它们一律报成 "MaiBot 1.2.x" ——
      用户于是既看不到真实版本，也拿不到任何"版本不足"的提示；等适配器插件装
      不上时，没有任何线索指向版本。这正是"照做了却接不上"的那类坑。
      所以这里补读真实版本号：读到了就如实报，低于适配器线时额外说明；
      **读不到就保持原来的 '1.2.x' 标签**（判定不出来就说判定不出来，不猜）。
      kind 仍然是 supported —— 启动器准入线是 ≥1.0.0，不因适配器线抬高。
    */
    const numeric = readNumericVersion(target);
    const belowAdapterLine = isBelowAdapterLine(numeric);
    const versionLabel = numeric || '1.2.x';
    const adapterLineNote = belowAdapterLine
      ? `。⚠️ 实测版本 ${numeric}，**低于官方 SnowLuma 适配器要求的 1.2.0**：` +
        '启动器能启动它，但适配器插件会装不上或启用不了，请升级到 1.2.0 或更新'
      : '';
    return {
      ...base,
      kind: 'supported',
      version: versionLabel,
      /* 供界面区分"能启动"与"接得上"：两条线各有各的结论 */
      belowAdapterLine,
      message: adapter
        ? `MaiBot ${versionLabel}，已检测到适配器插件「${adapter.name}」${adapterLineNote}`
        : `MaiBot ${versionLabel}（尚未安装 SnowLuma 适配器插件）${adapterLineNote}`
    };
  }

  return {
    ...base,
    kind: 'unknown',
    version: '',
    message: hasBotConfig
      ? '找到了 bot_config.toml，但字段既不像 0.6.x 也不像 1.2.x，无法判定版本'
      : '这个目录里没有找到能判定 MaiBot 版本的标志文件（可能还没初始化或选错了目录）'
  };
}

/* ============================================================================
 *  工具链检测（Python / Git / uv）
 * --------------------------------------------------------------------------
 *  官方 Windows 源码部署要求：Python 3.12+、Git，以及推荐用 uv 装依赖。
 *  这三样任一缺失，用户都会卡在一个和后文毫无关系的报错上，
 *  所以要在引导最前面就说清楚。
 * ========================================================================== */

/** 跑一个命令取版本行；失败返回 { ok:false } 而不是抛 */
function probeVersion(exe, args, timeoutMs = 12000) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    try {
      execFile(
        exe,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 },
        (err, stdout, stderr) => {
          const text = `${stdout || ''}\n${stderr || ''}`.trim();
          if (err && !text) {
            resolve({ ok: false, raw: '', message: `${exe} 不可用` });
            return;
          }
          resolve({ ok: true, raw: text.split(/\r?\n/)[0] || '' });
        }
      );
    } catch (e) {
      resolve({ ok: false, raw: '', message: `${exe} 启动失败：${e.message}` });
    }
  });
}

async function detectTools(pythonExe) {
  const py = await probeVersion(String(pythonExe || 'python').trim() || 'python', ['-V']);
  /* Python 版本必须真正比较，不能只看命令能不能跑 —— 3.10 也能跑但官方要求 3.12+ */
  let pythonOk = false;
  let pythonVersion = py.raw;
  if (py.ok) {
    const m = py.raw.match(/(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      const [maj, min] = [Number(m[1]), Number(m[2])];
      pythonOk = maj > 3 || (maj === 3 && min >= 12);
      pythonVersion = `${m[1]}.${m[2]}.${m[3]}`;
    }
  }

  const git = await probeVersion('git', ['--version']);
  const uv = await probeVersion('uv', ['--version']);
  const node = await probeVersion('node', ['--version']);

  return {
    ok: true,
    python: {
      ok: pythonOk,
      found: py.ok,
      version: pythonVersion,
      message: !py.ok
        ? `没有找到 ${pythonExe || 'python'}，请先安装 Python 3.12+`
        : pythonOk
          ? `Python ${pythonVersion}`
          : `Python ${pythonVersion} 版本过低，官方要求 3.12+`
    },
    git: {
      ok: git.ok,
      version: (git.raw.match(/(\d+\.\d+\.\d+)/) || [])[1] || git.raw,
      message: git.ok ? git.raw : '没有找到 Git（源码部署与安装插件需要它）'
    },
    uv: {
      ok: uv.ok,
      version: (uv.raw.match(/(\d+\.\d+\.\d+)/) || [])[1] || uv.raw,
      message: uv.ok
        ? uv.raw
        : '没有找到 uv（官方推荐的依赖管理工具；也可以直接用 pip）'
    },
    node: { ok: node.ok, version: node.raw }
  };
}

module.exports = {
  detectDirKind,
  detectMaiBotVersion,
  detectTools,
  detectAll,
  detectAdapter,
  hasConfigDir
};
