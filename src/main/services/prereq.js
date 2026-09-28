/*
================================================================================
技术文档：src/main/services/prereq.js
职责：Python 运行环境与依赖检查、依赖安装（带真实进度）。
================================================================================
  相对重构前的修正：
    1) checkDependencies() 内部又调用了一次 checkPythonVersion()，
       而 checkPrerequisites() 也会调 —— 同一次检查跑两遍 python -V。
    2) installDependencies() 里 `MAIBOT_REQUIRED_DEPS.filter((n) => n)` 恒等于原数组，
       是毫无作用的"看起来在过滤"的代码。
    3) 依赖清单硬编码，与 MaiBot 实际 requirements.txt 可能脱节；
       现在优先读取目标目录的 requirements.txt，解析出真实包名再比对。
    4) 进度上报是"取最后一行文本"的粗糙做法，且没有完成态百分比。
       现在：结构化进度（stage / percent / message / elapsedMs）。
    5) 未使用 `python -u`，pip 的进度输出会被缓冲，前端长时间看不到变化。
================================================================================
*/
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const logging = require('../logging');
const paths = require('../paths');
const { MAIBOT_REQUIRED_DEPS, MIN_PYTHON } = require('../constants');
const { sendToRenderer } = require('../windows');

/** 依赖安装进度事件通道 */
const DEPS_EVENT = 'deps-install-status';

/** 单条命令输出上限，避免超长输出撑爆内存 */
const MAX_OUTPUT_CHARS = 200000;

/* ============================================================================
 *  渲染层输入的收口（修复 pip argv 注入）
 * ----------------------------------------------------------------------------
 *  旧实现把渲染层给的 `opts.packages` 原样展开进 pip 的 argv：
 *      args = ['-u','-m','pip','install','--disable-pip-version-check', ...packages]
 *  而 packages 直接来自 preload 的 installDependencies({installDir,pythonExe,packages})。
 *  包名位置**不受位置限制**，于是一个"包名"可以写成 `--index-url`，
 *  后面的"包名"就是它的值 —— 一次 IPC 调用即可让 pip 从攻击者的索引安装任意包
 *  （安装期执行代码 = 以启动器权限执行任意代码）。`-r <任意文件>`、`--target <任意目录>`
 *  同理。单看"包名"这个词会以为 argv 数组天然安全，实际上 pip 的选项与包名同层。
 *
 *  因此这里改成**白名单**：只有内置依赖清单里出现过的正规包名才允许进 argv，
 *  且逐项校验字符集/长度/数量 —— 任何以 `-` 开头的东西（= pip 选项）都进不来。
 * ========================================================================== */

/** 合法包名（PEP 508 名，不含 extras/版本约束）：字母数字开头，允许 . _ - */
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PACKAGES = 60;
const MAX_PACKAGE_NAME_CHARS = 64;
/** requirements.txt 体积上限：再大就不该整份交给 pip 解析 */
const MAX_REQUIREMENTS_BYTES = 1024 * 1024;
/** 判断"这里确实是个 MaiBot 目录"时的入口文件名（scanner 判定不可用时的兜底） */
const MAIBOT_ENTRY_FILES = ['bot.py', 'main.py', 'maibot.py', 'launcher.py', 'run.py'];

/** 内置清单里允许出现的包名集合（pkg 与 import 名，小写） */
function allowedPackageNames() {
  const set = new Set();
  for (const d of MAIBOT_REQUIRED_DEPS) {
    if (!d) continue;
    if (d.pkg) set.add(String(d.pkg).toLowerCase());
    if (d.imp) set.add(String(d.imp).toLowerCase());
  }
  return set;
}

/**
 * 校验渲染层传来的依赖清单。
 * @param {unknown} raw
 * @returns {{error:string, packages:string[]}} error 非空表示拒绝
 */
function sanitizePackages(raw) {
  if (raw === undefined || raw === null) return { error: '', packages: [] };
  if (!Array.isArray(raw)) return { error: '依赖清单格式不正确（应为数组）', packages: [] };
  if (!raw.length) return { error: '', packages: [] };
  if (raw.length > MAX_PACKAGES) {
    return { error: `依赖项过多（最多 ${MAX_PACKAGES} 项）`, packages: [] };
  }
  const allowed = allowedPackageNames();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: '依赖项必须是字符串', packages: [] };
    const name = item.trim();
    /*
      两道闸门：
        1) 字符集白名单 —— 以 '-' 开头（pip 选项）、含空格/引号/分号/路径分隔符/URL 的一律不合法；
        2) 必须在内置清单内 —— 渲染层没有"安装任意第三方包"这个需求，
           收紧到内置集合不会影响任何正常调用（正常调用根本不传 packages）。
    */
    if (!PACKAGE_NAME_RE.test(name) || name.length > MAX_PACKAGE_NAME_CHARS) {
      return { error: `依赖名不合法: ${name.slice(0, MAX_PACKAGE_NAME_CHARS)}`, packages: [] };
    }
    if (!allowed.has(name.toLowerCase())) {
      return { error: `依赖不在内置清单内: ${name.slice(0, MAX_PACKAGE_NAME_CHARS)}`, packages: [] };
    }
    out.push(name);
  }
  return { error: '', packages: out };
}

/** 用户显式配置过的安装目录（settings.service.maibotDir / snowlumaDir 及其 maibot 子目录） */
function trustedInstallDirs() {
  const set = new Set();
  let cfg = null;
  try {
    cfg = require('./settings').getBackendSettings();
  } catch (_) {
    return set;
  }
  for (const raw of [cfg?.service?.maibotDir, cfg?.service?.snowlumaDir]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let abs;
    try {
      abs = path.resolve(raw.trim());
    } catch (_) {
      continue;
    }
    set.add(abs.toLowerCase());
    /* 配置的是父目录（安装器里的 targetDir）时，实际安装位置是 <父>/maibot */
    set.add(path.join(abs, 'maibot').toLowerCase());
  }
  return set;
}

/** 该目录是否确实是一个 MaiBot 安装目录（用 scanner 自己的判定，不新造判定） */
function looksLikeMaibotInstall(dir) {
  try {
    const scanner = require('./scanner');
    if (scanner && typeof scanner.detectType === 'function') {
      const type = scanner.detectType(dir);
      if (type) return type === 'maibot';
    }
  } catch (_) {
    /* scanner 不可用时退回入口文件判断 */
  }
  return MAIBOT_ENTRY_FILES.some((f) => {
    try {
      return fs.existsSync(path.join(dir, f));
    } catch (_) {
      return false;
    }
  });
}

/**
 * 校验安装目录，并判断能否把它的 requirements.txt 交给 pip 的 `-r`。
 *
 * 为什么 `-r` 要额外信任条件：`-r` 指向的文件**内容会被 pip 当命令行参数读**，
 * 谁能往某个目录写文件（例如下载页），谁就能靠伪造 bot.py/src/config.py + requirements.txt
 * 让 pip 执行任意参数。所以只有"用户自己在设置里配过的安装目录，且确实是 MaiBot 安装目录"
 * 才采用它；其余情况一律走内置清单，并把原因写进返回消息（不静默降级）。
 *
 * @param {unknown} raw
 * @returns {{dir:string, requirementsTrusted:boolean, error:string}}
 */
function resolveInstallDir(raw) {
  const dir = typeof raw === 'string' ? raw.trim() : '';
  if (!dir) return { dir: '', requirementsTrusted: false, error: '' };
  let abs;
  try {
    abs = path.resolve(dir);
  } catch (_) {
    return { dir: '', requirementsTrusted: false, error: `安装目录无法解析: ${dir.slice(0, 200)}` };
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    return { dir: '', requirementsTrusted: false, error: `安装目录不存在: ${abs}` };
  }
  if (!st.isDirectory()) {
    return { dir: '', requirementsTrusted: false, error: `安装目录不是目录: ${abs}` };
  }
  const trusted = trustedInstallDirs().has(abs.toLowerCase()) && looksLikeMaibotInstall(abs);
  return { dir: abs, requirementsTrusted: trusted, error: '' };
}

/** 运行一个命令并收集输出 */
function runCommand(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const { cwd, timeoutMs = 60000, onOutput } = opts;
    let child;
    try {
      child = spawn(exe, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: e.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* 忽略 */
      }
      finish({ ok: false, code: null, stdout, stderr, error: `命令超时（${timeoutMs}ms）` });
    }, timeoutMs);
    timer.unref?.();

    const collect = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += text;
      } else if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += text;
      }
      if (onOutput) onOutput(text, isErr);
    };

    child.stdout.on('data', (d) => collect(d, false));
    child.stderr.on('data', (d) => collect(d, true));
    child.on('error', (e) => finish({ ok: false, code: null, stdout, stderr, error: e.message }));
    child.on('exit', (code) => finish({ ok: code === 0, code, stdout, stderr, error: null }));
  });
}

/** 解析 "3.12.8" → {major, minor, patch, ok} */
function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return { major: 0, minor: 0, patch: 0, raw: '' };
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] || 0),
    raw: m[0]
  };
}

/**
 * 校验 Python 版本。
 * @param {string} pythonExe
 */
async function checkPythonVersion(pythonExe) {
  const exe = String(pythonExe || 'python').trim() || 'python';
  const res = await runCommand(exe, ['-V'], { timeoutMs: 15000 });
  const text = `${res.stdout}\n${res.stderr}`.trim();

  if (res.error && !text) {
    return {
      ok: false,
      exe,
      version: '',
      minVersion: MIN_PYTHON.label,
      message: `无法执行 ${exe}: ${res.error}`
    };
  }

  const parsed = parseVersion(text);
  if (!parsed.raw) {
    return {
      ok: false,
      exe,
      version: text.slice(0, 80),
      minVersion: MIN_PYTHON.label,
      message: `无法识别 Python 版本（输出: ${text.slice(0, 80) || '空'}）`
    };
  }

  const ok =
    parsed.major > MIN_PYTHON.major ||
    (parsed.major === MIN_PYTHON.major && parsed.minor >= MIN_PYTHON.minor);

  return {
    ok,
    exe,
    version: parsed.raw,
    minVersion: MIN_PYTHON.label,
    message: ok ? `Python ${parsed.raw}` : `需要 Python ≥ ${MIN_PYTHON.label}，当前 ${parsed.raw}`
  };
}

/* ============================================================================
 *  文本解码：requirements.txt 不一定是 UTF-8
 * ----------------------------------------------------------------------------
 *  为什么必须自己判编码（这不是"防御性编程"，是实测踩到的真实故障）：
 *    用户机器上那份 requirements.txt 是 **UTF-16 LE**（开头 FF FE）。
 *    用 PowerShell 的 `>` 重定向写文件得到的就是这个编码，
 *    上游仓库的 UTF-8 文件被本地工具重写过也可能变成这样。
 *
 *    若一律 fsp.readFile(p, 'utf8')，每一行会变成
 *      "\uFEFFA\u0000P\u0000S\u0000c\u0000h\u0000e\u0000d\u0000u\u0000l\u0000e\u0000r\u0000"
 *    这种夹着 NUL 的垃圾。解析出的"包名"永远匹配不上 pip list 里的任何一项，
 *    于是依赖检查**恒定报告 0/42 已满足**，把已经装好的 aiohttp / loguru /
 *    numpy / pillow / pydantic / requests / setuptools … 全列为"缺少"。
 *    用户按提示去装就是白装一遍 —— 属于"看起来在工作、其实全错"那类问题。
 *
 *    BOM 也要吃掉：带 BOM 的 UTF-8 文件若不去 BOM，
 *    第一行会变成 "\uFEFFapscheduler"，同样匹配不上。
 * ========================================================================== */
function decodeTextFile(buf) {
  if (!buf || !buf.length) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));

  /* UTF-16 LE（BOM FF FE） */
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return b.subarray(2).toString('utf16le');
  }
  /* UTF-16 BE（BOM FE FF）：Node 没有内置 utf16be，换字节后按 LE 解 */
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const rest = Buffer.from(b.subarray(2));
    if (rest.length % 2 === 0) {
      rest.swap16();
      return rest.toString('utf16le');
    }
    return b.toString('utf8');
  }
  /* UTF-8 BOM（EF BB BF） */
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return b.subarray(3).toString('utf8');
  }

  /*
    无 BOM 的 UTF-16 LE：ASCII 文本会每隔一个字节出现一个 0x00。
    取前 64 字节采样，若"第二个字节"里 80% 以上是 0x00 就判定为 UTF-16 LE。
    纯 ASCII/UTF-8 的 requirements.txt 不会满足这个条件，
    所以不会把正常文件误判掉。
  */
  const probe = b.subarray(0, Math.min(64, b.length));
  const pairs = Math.floor(probe.length / 2);
  if (pairs > 0) {
    let zeros = 0;
    for (let i = 1; i < probe.length; i += 2) if (probe[i] === 0x00) zeros += 1;
    if (zeros / pairs > 0.8) return b.toString('utf16le');
  }

  return b.toString('utf8');
}

/** 读取文本文件并按实际编码解码（读不出来返回空串，由调用方决定回退） */
async function readTextFile(filePath) {
  const buf = await fsp.readFile(filePath);
  return decodeTextFile(buf);
}

/** 解析 requirements.txt 得到包名列表（忽略版本约束/注释/选项行） */
function parseRequirements(text) {
  const names = new Set();
  /*
    先做一次统一清洗：吃掉 BOM、NUL 和零宽字符。
    即使上游文件编码再古怪，这里也不该把不可见字符带进包名 ——
    否则包名看起来"有值"，却永远匹配不上，正是上面那种 0/42 假结果。
  */
  const cleaned = String(text || '')
    .replace(/^\uFEFF/, '')
    /*
      NUL 用 split/join 去掉，而不是写成 /\u0000/g：
      字面量控制字符会触发 ESLint 的 no-control-regex，
      而这里若用 eslint-disable 关掉规则，等于把"正则里混进控制字符"
      这类真实隐患一起放行 —— 换成 split/join 既达成目的又不关规则。
    */
    .split('\u0000')
    .join('')
    .replace(/[\u200B-\u200D\u2060]/g, '');

  for (const rawLine of cleaned.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    /* 去掉环境标记与注释 */
    line = line.split('#')[0].split(';')[0].trim();
    /* 去掉 extras 与版本约束：requirements 里形如 foo[bar]>=1.2  */
    const name = line.split(/[<>=!~[ ]/)[0].trim();
    /*
      只接受"像包名"的字符串：字母数字开头，由 A-Za-z0-9._- 组成。
      这一步能挡住解析残渣（例如编码没处理好时留下的乱码），
      避免把一个无意义的字符串当成依赖名去比对、再报成"缺少"。
    */
    if (name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) names.add(name.toLowerCase());
  }
  return [...names];
}

/**
 * 检查依赖。
 * @param {string} installDir
 * @param {string} pythonExe
 * @param {{skipPythonCheck?:boolean}} [opts]
 */
async function checkDependencies(installDir, pythonExe, opts = {}) {
  const exe = String(pythonExe || 'python').trim() || 'python';

  /* 优先使用目标目录的 requirements.txt（真实需求），否则退回内置清单 */
  let required = MAIBOT_REQUIRED_DEPS.map((d) => d.pkg.toLowerCase());
  let source = 'builtin';
  if (installDir) {
    try {
      const reqPath = path.join(installDir, 'requirements.txt');
      /* 必须按实际编码解码，否则 UTF-16/BOM 会让包名全变乱码 → 恒定 0/N */
      const text = await readTextFile(reqPath);
      const parsed = parseRequirements(text);
      if (parsed.length) {
        required = parsed;
        source = 'requirements.txt';
      } else {
        /*
          文件存在却解析不出任何包名：不要静默退回内置清单装作没事 ——
          这说明文件内容不是预期格式（空文件、编码异常等），
          如实记一条日志，便于排查"为什么检查结果不对"。
        */
        logging.log('warn', `[prereq] ${reqPath} 解析不出任何依赖名，改用内置清单`);
      }
    } catch (_) {
      /* 没有 requirements.txt 则使用内置清单 */
    }
  }

  /*
    两种模式：
      quick —— 一次 Python 调用做模块级探测（find_spec），
               实测 ~340ms，用于进入安装页时的即时反馈。
      full  —— `pip list` 全量枚举，实测 ~2600ms，
               但能给出**准确版本号**。
    快速模式之所以必要：安装页一进来就要跑依赖检查，
    2.6 秒的白屏等待在每次切页时都会重复出现。
  */
  if (opts.mode === 'quick') {
    return quickCheck(exe, installDir, required, source);
  }

  const res = await runCommand(exe, ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], {
    cwd: installDir || undefined,
    timeoutMs: 60000
  });

  if (!res.ok) {
    return {
      ok: false,
      mode: 'full',
      source,
      dependencies: [],
      installedCount: 0,
      missingCount: required.length,
      message: `无法读取已安装依赖: ${res.error || res.stderr.slice(0, 200) || `退出码 ${res.code}`}`
    };
  }

  let installedMap = new Map();
  try {
    const arr = JSON.parse(res.stdout || '[]');
    /*
      键用 canonName（PEP 503 归一化），不是裸的小写 ——
      pip list 里登记的是 quick-algo，requirements.txt 里写的是 quick_algo，
      不归一化就会把已装好的包判成"缺少"。
    */
    installedMap = new Map(arr.map((it) => [canonName(it.name), it.version || '']));
  } catch (e) {
    return {
      ok: false,
      mode: 'full',
      source,
      dependencies: [],
      message: `解析 pip 输出失败: ${e.message}（可能是 pip 版本不兼容）`
    };
  }

  const dependencies = required.map((pkg) => {
    const version = installedMap.get(canonName(pkg));
    return {
      name: pkg,
      installed: version || '',
      ok: Boolean(version),
      desc: version ? `已安装 ${version}` : '未安装'
    };
  });

  const missing = dependencies.filter((d) => !d.ok);
  return {
    ok: missing.length === 0,
    mode: 'full',
    source,
    dependencies,
    installedCount: dependencies.length - missing.length,
    missingCount: missing.length,
    missing: missing.map((d) => d.name),
    message: missing.length ? `缺少 ${missing.length} 个依赖` : '依赖完整'
  };
}

/* ============================================================================
 *  快速依赖检查（模块级探测）
 * ========================================================================== */

/* ============================================================================
 *  包名归一化（PEP 503）
 * ----------------------------------------------------------------------------
 *  同一个包，requirements.txt 与 pip list 可能写法不同：
 *      requirements.txt : quick_algo   tomli_w   maim_message
 *      pip list         : quick-algo   tomli-w   maim_message
 *  PEP 503 明确规定 `-`、`_`、`.` 三者等价，它们**就是同一个包**。
 *  直接拿小写字符串比较，会把已经装好的包报成"缺少" ——
 *  实测 quick_algo 就是这么被误报的（pip list 里登记为 quick-algo），
 *  用户在安装页看到一条永远消不掉的红字，点多少次安装都没用。
 * ========================================================================== */
function canonName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

/** 内置包名 → import 名映射（pip 名与导入名不一致的那些） */
const IMPORT_NAME_FALLBACK = {
  pillow: 'PIL',
  pyyaml: 'yaml',
  'python-dateutil': 'dateutil',
  'beautifulsoup4': 'bs4',
  'scikit-learn': 'sklearn',
  'opencv-python': 'cv2',
  'msgpack-python': 'msgpack',
  'python-dotenv': 'dotenv',
  /*
    下面三条是实测漏掉过的，每个都对应一个"永远消不掉的缺少依赖"：
      faiss-cpu          真实 import 名是 faiss
      python-igraph      真实 import 名是 igraph
      strawberry-graphql 真实 import 名是 strawberry
    注意这张表现在只是**兜底**：主路径已经改用 importlib.metadata
    直接按分发名查（见 QUICK_PROBE_SOURCE），不再靠猜 import 名。
  */
  'faiss-cpu': 'faiss',
  'python-igraph': 'igraph',
  'strawberry-graphql': 'strawberry'
};

/** 取某个 pip 包名对应的 import 名 */
function importNameOf(pkg) {
  const lower = String(pkg || '').toLowerCase();
  const known = MAIBOT_REQUIRED_DEPS.find((d) => d.pkg.toLowerCase() === lower);
  if (known?.imp) return known.imp;
  if (IMPORT_NAME_FALLBACK[lower]) return IMPORT_NAME_FALLBACK[lower];
  /* 多数包名可直接当 import 名用，把 - 换成 _ 即可 */
  return lower.replace(/-/g, '_');
}

/**
 * 探测脚本。
 *
 * 【为什么从 find_spec 改成 importlib.metadata】
 * 老版本按"猜出来的 import 名"去 find_spec，例如把 pip 名里的 `-` 换成 `_`：
 *     faiss-cpu          → import faiss_cpu          （不存在！真实是 faiss）
 *     python-igraph      → import python_igraph      （不存在！真实是 igraph）
 *     strawberry-graphql → import strawberry_graphql （不存在！真实是 strawberry）
 * 这三个包明明装好了，快速检查却永远报"缺少"，而且**点多少次安装都不会消失** ——
 * 因为问题不在环境，在这个猜测本身。手写映射表治标不治本：上游每多一个
 * 名字不一致的包，就得再补一行，漏一个就又是一条消不掉的红字。
 *
 * 现在直接问 Python 自己：importlib.metadata.version(分发名) 会抛出
 * PackageNotFoundError 表示没装，成功则**顺带返回真实版本号**。
 * 它内部按 PEP 503 归一化（- _ . 等价），所以 quick_algo / quick-algo
 * 这类写法差异也自动消化掉了。
 *
 * 仍然保留 find_spec 兜底：极少数包的元数据缺失/不规范，
 * 但模块确实存在，这时按映射表猜的名字再试一次，避免误报"缺少"。
 * 用 find_spec 而不是真 import 的原因不变：
 *   - 不执行包代码，不会因为 torch 这类包初始化慢而拖垮整体；
 *   - 不触发包的副作用（起服务、写文件）。
 *
 * 参数格式：每个参数是 "分发名\t兜底import名"（用制表符分隔）。
 */
const QUICK_PROBE_SOURCE = [
  'import importlib.metadata as md, importlib.util, json, sys',
  'out = {}',
  'for arg in sys.argv[1:]:',
  '    pipname, _, impname = arg.partition("\\t")',
  '    ver = ""',
  '    try:',
  '        ver = md.version(pipname)',
  '    except Exception:',
  '        ver = ""',
  '    ok = bool(ver)',
  '    if not ok and impname:',
  '        try:',
  '            ok = importlib.util.find_spec(impname) is not None',
  '        except Exception:',
  '            ok = False',
  '    out[pipname] = {"ok": ok, "version": ver}',
  'sys.stdout.write("::RESULT::" + json.dumps(out))'
].join('\n');

/**
 * 快速依赖检查：一次 Python 调用判断全部依赖是否存在。
 * @returns {Promise<object>} 与 full 模式同构的结果，mode='quick'
 */
async function quickCheck(exe, installDir, required, source) {
  let dir = '';
  try {
    dir = paths.workDir('dep-probe');
    const file = path.join(dir, 'probe.py');
    await fsp.writeFile(file, QUICK_PROBE_SOURCE, 'utf8');

    /* 每个依赖传 "分发名\t兜底import名"，主探测按分发名走元数据 */
    const args = required.map((p) => `${p}\t${importNameOf(p)}`);
    const res = await runCommand(exe, [file, ...args], {
      cwd: installDir || undefined,
      timeoutMs: 20000
    });

    if (!res.ok) {
      return {
        ok: false,
        mode: 'quick',
        source,
        dependencies: [],
        installedCount: 0,
        missingCount: required.length,
        message: `快速检查失败: ${res.error || res.stderr.slice(0, 200) || `退出码 ${res.code}`}`
      };
    }

    const marker = '::RESULT::';
    const line = String(res.stdout || '')
      .split(/\r?\n/)
      .find((l) => l.includes(marker));
    if (!line) {
      return {
        ok: false,
        mode: 'quick',
        source,
        dependencies: [],
        message: '快速检查没有返回结果（可能是 Python 环境异常）'
      };
    }

    const map = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
    const dependencies = required.map((pkg) => {
      /*
        按**分发名**取结果（键就是传进去的 pkg 原文）。
        老代码在这里是 map[importNameOf(pkg)] —— 键是猜的 import 名，
        猜错就等于查了一个不存在的键，恒为 undefined → 恒报"未安装"。
      */
      const info = map[pkg] || {};
      const found = Boolean(info && info.ok);
      const version = found ? String(info.version || '') : '';
      return {
        name: pkg,
        /* 现在能拿到真实版本号了（importlib.metadata 顺带给的），拿不到就如实留空 */
        installed: version,
        ok: found,
        desc: found ? (version ? `已安装 ${version}` : '已安装（未能读取版本号）') : '未安装'
      };
    });

    const missing = dependencies.filter((d) => !d.ok);
    return {
      ok: missing.length === 0,
      mode: 'quick',
      source,
      dependencies,
      installedCount: dependencies.length - missing.length,
      missingCount: missing.length,
      missing: missing.map((d) => d.name),
      message: missing.length ? `缺少 ${missing.length} 个依赖` : '依赖完整'
    };
  } catch (e) {
    return {
      ok: false,
      mode: 'quick',
      source,
      dependencies: [],
      message: `快速检查异常: ${e.message}`
    };
  } finally {
    if (dir) paths.removeDir(dir);
  }
}

/** 上报依赖安装进度 */
function emitDeps(payload) {
  sendToRenderer(DEPS_EVENT, payload);
}

/**
 * 安装依赖。
 * @param {string} installDir
 * @param {string} pythonExe
 * @param {{packages?:string[]}} [opts]
 */
async function installDependencies(installDir, pythonExe, opts = {}) {
  const exe = String(pythonExe || 'python').trim() || 'python';
  const startedAt = Date.now();

  /* 安装目录：结构校验；同时判断它的 requirements.txt 是否值得信任（见 resolveInstallDir） */
  const dirInfo = resolveInstallDir(installDir);
  if (dirInfo.error) {
    logging.log('warn', `[prereq] 拒绝安装依赖：${dirInfo.error}`);
    return { ok: false, elapsedMs: Date.now() - startedAt, message: dirInfo.error };
  }

  /* 渲染层给的依赖清单：只允许内置清单里的合法包名（挡 pip 选项注入） */
  const pkgInfo = sanitizePackages(opts.packages);
  if (pkgInfo.error) {
    logging.log('warn', `[prereq] 拒绝渲染层传来的依赖清单: ${pkgInfo.error}`);
    return { ok: false, elapsedMs: Date.now() - startedAt, message: pkgInfo.error };
  }

  /* 确定安装源：受信任的 requirements.txt 优先，否则内置清单 */
  let args = null;
  let sourceLabel;
  let note = '';
  const reqPath = dirInfo.dir ? path.join(dirInfo.dir, 'requirements.txt') : '';

  if (reqPath && dirInfo.requirementsTrusted) {
    try {
      const st = await fsp.stat(reqPath);
      if (st.isFile() && st.size > 0 && st.size <= MAX_REQUIREMENTS_BYTES) {
        args = ['-u', '-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqPath];
        sourceLabel = 'requirements.txt';
      } else if (st.isFile() && st.size > MAX_REQUIREMENTS_BYTES) {
        note = `（requirements.txt 超过 ${Math.round(MAX_REQUIREMENTS_BYTES / 1024)}KB，已改用内置依赖清单）`;
        logging.log('warn', `[prereq] ${reqPath} 过大（${st.size} 字节），改用内置清单`);
      }
    } catch (_) {
      args = null;
    }
  } else if (reqPath) {
    try {
      await fsp.access(reqPath);
      /*
        目录里有 requirements.txt，但该目录不在"用户配置过的安装目录"里：
        不把文件交给 pip，改用内置清单，并**如实说明**——不静默换源。
      */
      note = '（该目录不在启动器已知的安装目录内，未采用其 requirements.txt，已改用内置依赖清单）';
      logging.log('warn', `[prereq] 忽略不受信任的 requirements.txt: ${reqPath}（非已配置的安装目录）`);
    } catch (_) {
      args = null;
    }
  }

  if (!args) {
    const packages = pkgInfo.packages.length
      ? pkgInfo.packages
      : MAIBOT_REQUIRED_DEPS.map((d) => d.pkg);
    args = ['-u', '-m', 'pip', 'install', '--disable-pip-version-check', ...packages];
    sourceLabel = '内置依赖清单';
  }

  logging.log('info', `[prereq] 开始安装依赖（${sourceLabel}）: ${exe} ${args.join(' ')}`);
  emitDeps({ stage: 'start', message: `开始安装依赖（来源：${sourceLabel}）${note}`, elapsedMs: 0 });

  /* 输出节流：只把有意义的新行推给前端 */
  let buffer = '';
  let lastEmit = 0;
  const onOutput = (text) => {
    buffer += text;
    const now = Date.now();
    if (now - lastEmit < 200) return;
    lastEmit = now;

    const lines = buffer.split(/\r?\n/).filter((l) => l.trim());
    buffer = '';
    /* 取最后一行作为当前进度（pip 是覆盖式进度条） */
    const line = lines[lines.length - 1] || '';
    emitDeps({
      stage: 'progress',
      message: line.trim().slice(0, 160) || '安装中…',
      elapsedMs: Date.now() - startedAt
    });
  };

  const res = await runCommand(exe, args, {
    cwd: dirInfo.dir || undefined,
    timeoutMs: 30 * 60 * 1000, /* pip 安装可能很慢 */
    onOutput
  });

  const elapsedMs = Date.now() - startedAt;
  if (res.ok) {
    emitDeps({ stage: 'done', message: `依赖安装完成${note}`, elapsedMs });
    logging.log('info', `[prereq] 依赖安装完成，用时 ${Math.round(elapsedMs / 1000)}s`);
    return { ok: true, elapsedMs, message: `依赖安装完成${note}`, output: res.stdout.slice(-3000) };
  }

  const errText = (res.stderr || res.stdout || res.error || '').slice(-3000);
  emitDeps({ stage: 'error', message: `依赖安装失败${res.error ? `: ${res.error}` : `（退出码 ${res.code}）`}`, elapsedMs });
  logging.log('error', `[prereq] 依赖安装失败: ${errText.slice(0, 600)}`);
  return {
    ok: false,
    elapsedMs,
    code: res.code,
    message: res.error || `依赖安装失败（退出码 ${res.code}）`,
    output: errText
  };
}

/**
 * 一次性前置检查。
 * @param {string} installDir
 * @param {string} pythonExe
 */
async function checkPrerequisites(installDir, pythonExe) {
  const python = await checkPythonVersion(pythonExe);

  if (!python.ok) {
    return {
      ok: false,
      python,
      dependencies: [],
      installedCount: 0,
      missingCount: 0,
      message: python.message
    };
  }

  /* 复用已得到的 python 结果，不再重复执行 python -V */
  const deps = await checkDependencies(installDir, python.exe);
  return {
    ok: python.ok && deps.ok,
    python,
    dependencies: deps.dependencies,
    depSource: deps.source,
    installedCount: deps.installedCount,
    missingCount: deps.missingCount,
    missing: deps.missing || [],
    message: deps.message
  };
}

module.exports = {
  checkPythonVersion,
  checkDependencies,
  installDependencies,
  checkPrerequisites,
  parseRequirements,
  /* 编码解码单独导出，便于 verify-deps 直接回归（这是本次修复的核心） */
  decodeTextFile,
  readTextFile,
  /* 包名归一化单独导出：PEP 503 的 - _ . 等价是另一个"永远消不掉的缺少依赖"的根因 */
  canonName,
  DEPS_EVENT
};
