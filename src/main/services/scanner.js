/*
================================================================================
技术文档：src/main/services/scanner.js
职责：扫描本机已安装的 MaiBot / SnowLuma 目录。
================================================================================
  相对重构前的修正：
    1) 误报严重：MAIBOT_MARKERS 含 'main.py' / 'app.py' / 'requirements.txt'，
       这意味着**任何一个 Python 项目**都会被识别为 MaiBot 安装
       （含 .venv、任意爬虫、Django 工程）。命中后还会 return 跳过整个子树，
       一个假命中就能让真正的安装目录被漏掉。
       → 现在采用"强特征优先 + 多特征计分"判定，并要求正向证据。
    2) 默认扫描 D:/ E:/ F:/ G:/ 整盘根目录 + MAX_DIRS=40000 深度 4 的串行 DFS，
       单次可跑数分钟，且**不可取消**（用户离开总览页也照跑）。
       → 现在限制为家目录下的常见位置，数量/深度收紧，并支持 AbortSignal 取消。
    3) 每次进入总览页都会自动全盘扫描。
       → 现在由前端显式触发 + 结果缓存复用。
    4) require('path') 写在 readdir 的 map 回调里（每文件一次），纯冗余。
    5) 缺少结果上限，命中上千个目录时会一次性推给渲染层。

  第三轮修正（用户实测报上来的，上面第 1 条那次只治了一半）：
    6) "名字长得像"仍然被当成"就是它"：
         · `Documents\Tencent Files` 里有个以协议端命名的文件夹（只存 data/temp）
           → 报成协议端安装
         · `...\modules` 里有个和协议端同名的子目录 → 被判成协议端安装，
           而且**命中即不下钻**，把里面真正的协议端和 MaiBot 全挡住了
           （启动器自己下载的模块目录就是这么被漏掉的）
         · 一个只放了几个 txt 的桌面文件夹，因为里面有个 `bot_config.toml`
           → 报成 MaiBot 安装
         · zhenxun_bot（另一个框架）、AstrBot、MaiBotOneKey 因为
           `requirements.txt + main.py` → 全部报成 MaiBot 安装
       → 判定改成"必须是**文件**而非同名目录"+"MaiBot 独有结构"，
         并且**只接受目录路径**：仅凭名字无法区分"这里是安装"和
         "这里有个同名子文件夹"，那种调用一律不判（宁可漏报也不误报）。
    7) 版本乱显示：统一读 pyproject.toml/package.json，
       于是 zhenxun_bot 显示 0.2.4、真实 0.6.3 安装显示 0.1.0（脚手架版本）。
       → 按产品线各读各的（0.6.x 读 src/config/config.py 的 mai_version_main；
         1.2.x 与上游 src/common/version.py 一致，读 pyproject.toml 的 [project] version），
         读不到就留空、界面显示"版本未知"。
    8) 低于支持线的版本（0.x）和可用安装混在一起，看不出该重装。
       → 结果里带上 supported 字段，界面据此区分。
================================================================================
*/
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { SCAN } = require('../constants');
const logging = require('../logging');

/** 正在进行的扫描：scanId → AbortController */
const activeScans = new Map();
let scanSeq = 0;

/* ---------------------------------------------------------------------------
 *  特征判定
 * ------------------------------------------------------------------------- */

/*
  ────────────────────────────────────────────────────────────────────────────
  判定原则（这一版是**重写**。前两版都栽在同一件事上：把"看起来像"当成了"是"）。
  ────────────────────────────────────────────────────────────────────────────
    1) 命中必须证明"这个目录**本身就是**那个软件的安装根"，
       而不是"这个目录里有一个名字相关的条目"。
       反例（实测）：`...\modules` 里有个和协议端同名的**子目录**，旧版就判定
       它是协议端安装；更糟的是旧版"命中即不下钻"，于是启动器**自己下载的
       真协议端反而永远扫不到**（它就在那个同名子目录里面）。
       同理 `Documents\Tencent Files` 里有个以协议端命名的文件夹（其实只存 data/temp），
       也被报成了协议端安装。

    2) MaiBot 的证据必须是 MaiBot **独有**的，不能是"任何 Python 项目都有的东西"。
       反例（实测）：`requirements.txt + main.py` 让 AstrBot 的 backend\app、
       MaiBotOneKey 全部中招；`template/` 目录、根级 `bot_config.toml`
       让一个只放了几个 txt 的桌面文件夹中招（它里面正好有一个 bot_config.toml）。

    3) 版本只能来自 MaiBot 自己的声明，而且**两条产品线的来源不一样**：
         · 0.6.x：`src/config/config.py` 里的 `mai_version_main = "0.6.3"`
         · 1.2.x：由 `src/common/version.py` 读 `pyproject.toml` 的 `[project] version`
           （已核对上游源码 src/common/version.py:read_project_version）
       实测：真实 0.6.3 安装的 pyproject.toml 写的是 `version = "0.1.0"`（脚手架版本），
       旧实现统一读 pyproject.toml，于是把 0.6.3 显示成 0.1.0 —— 是**错的**。

  判据来源（全部来自实际磁盘 + 上游仓库根目录核对，不是猜的）：
    MaiBot 0.6.x 根: bot.py + src/ + config/ + template/ + depends-data/ + EULA.md
    MaiBot 1.2.x 根: bot.py + src/ + depends-data/ + plugins/ + locales/ + prompts/
    两条线的共同点 = 可用的判据: bot.py(文件) + src/(目录) + (src/config/config.py 或 depends-data)

    SnowLuma 根    : package.json(name=@snowluma/runtime) + index.mjs + node.exe
                     + native/ + client/ + launcher.bat
                     （不需要注入 QQ 进程，是独立 Node 程序，自带 WebUI）

  已删除：旧的 QQ 注入式协议端的判定。用户明确要求抛弃它、改用 SnowLuma。
*/

/** SnowLuma 官方运行时的 package.json name，最硬的判据 */
const SNOWLUMA_PKG_NAME = '@snowluma/runtime';

/** MaiBot 判定所需的三个要素 */
const MAIBOT_ENTRY_FILE = 'bot.py';
const MAIBOT_SRC_DIR = 'src';
/** 两条产品线都存在这个文件，是 MaiBot 独有路径 */
const MAIBOT_CONFIG_PY = ['src', 'config', 'config.py'];
/** 同样是 MaiBot 独有目录，作为 config.py 缺失时的替代证据 */
const MAIBOT_DEPENDS_DIR = 'depends-data';

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function readTextFile(p, maxBytes = 262144) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    /* fd 必须在这里关：原实现把 closeSync 放在 readSync 之后，
       一旦 readSync 抛错（EISDIR/EBADF/EIO…）或 Buffer.alloc 抛 RangeError，
       fd 就永久泄漏。扫描是高频循环（每个候选目录都要读 pyproject/package.json），
       泄漏累积到 EMFILE 后 openSync 一律失败、readTextFile 全部返回 ''，
       表面症状就是"扫描突然什么都找不到"。 */
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* 关闭失败无处可报，也不能再抛：调用方依赖"读不到就返回空串" */
      }
    }
  }
}

/**
 * 读一个 `name = "值"` / `name: str = "值"` / `name = True` 形式的赋值。
 * 只匹配**行首就是该名字**的赋值，所以 `if is_test:` 这类语句不会被误取。
 *
 * @returns {string|boolean|null} 字符串/布尔值；不是字面量或找不到时 null
 */
function readPyAssignment(text, name) {
  const m = text.match(new RegExp(`^[ \\t]*${name}[ \\t]*(?::[ \\t]*[\\w\\[\\].]+[ \\t]*)?=([^\\n]*)`, 'm'));
  if (!m) return null;
  const raw = m[1].replace(/#.*$/, '').trim();
  const s = raw.match(/^["']([^"']*)["']$/);
  if (s) return s[1];
  if (/^True$/i.test(raw)) return true;
  if (/^False$/i.test(raw)) return false;
  return null;
}

/**
 * 复刻 MaiBot 自己的版本拼装逻辑（上游 src/config/config.py L25-39）：
 *
 *   is_test = False
 *   mai_version_main = "0.6.3"
 *   mai_version_fix  = "fix-2"
 *   if mai_version_fix:
 *       mai_version = f"test-{main}-{fix}" if is_test else f"{main}-{fix}"
 *   else:
 *       mai_version = f"test-{main}"       if is_test else main
 *
 * ⚠️ 关键是**不能只读 mai_version_main**。
 * 实测用户那套装的就是 main="0.6.3" + fix="fix-2"，
 * 真实版本（也就是 MaiBot 自己日志里 `MaiCore当前版本: …` 打的那个）是
 * **`0.6.3-fix-2`** —— 只读 main 会显示成 "0.6.3"，少了一截。
 * 所以这里必须把 is_test / fix 一起读出来并照样拼。
 *
 * @returns {string} 拼好的版本；连 main 都没有时返回空串
 */
function readLegacyMaiVersion(configPy) {
  const main = readPyAssignment(configPy, 'mai_version_main');
  if (typeof main !== 'string' || !main.trim()) return '';
  const fixRaw = readPyAssignment(configPy, 'mai_version_fix');
  const fix = typeof fixRaw === 'string' ? fixRaw.trim() : '';
  const isTest = readPyAssignment(configPy, 'is_test') === true;
  const base = isTest ? `test-${main.trim()}` : main.trim();
  return fix ? `${base}-${fix}` : base;
}

/**
 * 读 MaiBot 的版本号。**按产品线各读各的**，读不到就返回空 —— 不猜。
 *
 * 三条产品线的版本来源完全不同，这是被真实磁盘教出来的：
 *
 *   ① 0.6.x  ：config.py 里 mai_version_main / mai_version_fix / is_test 拼出来
 *              → 实测 main="0.6.3" + fix="fix-2" ⇒ 0.6.3-fix-2
 *
 *   ② 0.7.x / 0.11.x / 0.12.x ：config.py 里 **MMC_VERSION 直接写字面量**
 *              → 实测 `MMC_VERSION = "0.12.2"` ⇒ 真实版本 0.12.2
 *              → 实测 `MMC_VERSION = "0.7.0"`  ⇒ 真实版本 0.7.0
 *
 *   ③ 1.2.x  ：config.py 里 `MMC_VERSION: str = read_project_version(PROJECT_ROOT)`
 *              真正去 pyproject.toml 的 [project].version 取
 *
 * ⚠️ 这里踩过大坑：②这条线**也有一份 pyproject.toml，而且写的是脚手架的 0.1.0**。
 *    上一版对 ①②③ 统一去读 pyproject，结果把
 *      `MMC_VERSION = "0.12.2"` 的安装显示成 **0.11.6**（pyproject 没跟着改），
 *      `MMC_VERSION = "0.7.0"`  的安装显示成 **0.1.0**。
 *    用户直接质问"哪来的 0.6？会看版本号吗" —— 因为 0.12.2 才是他认得的值。
 *    所以顺序必须是：先 mai_version 拼装 → 再 MMC_VERSION 字面量 → 最后才 pyproject。
 *
 * @returns {{version:string, source:string}}
 */
function readMaiBotVersion(dir) {
  const configPy = readTextFile(path.join(dir, ...MAIBOT_CONFIG_PY));
  if (configPy) {
    /* ① 0.6.x 的拼装 */
    const legacy = readLegacyMaiVersion(configPy);
    if (legacy) return { version: legacy, source: 'src/config/config.py mai_version' };

    /*
      ② 0.7.x / 0.11.x / 0.12.x 的字面量。
      1.2.x 写的是 `MMC_VERSION: str = read_project_version(PROJECT_ROOT)`，
      readPyAssignment 对函数调用返回 null，正好落到下面的 pyproject 分支。
    */
    const mmc = readPyAssignment(configPy, 'MMC_VERSION');
    if (typeof mmc === 'string' && mmc.trim()) {
      return { version: mmc.trim(), source: 'src/config/config.py MMC_VERSION' };
    }
  }

  /*
    ③ 1.2.x：MMC_VERSION = read_project_version(...) → pyproject.toml 的 [project].version。
    能走到这一步说明 bot.py + src/ + MaiBot 独有结构都已确认，
    这个 pyproject.toml 一定是 MaiBot 自己的，不是别的项目的。
    只认 [project] 节，避开 [tool.poetry] 里那个同名但无关的 version 字段。
  */
  const v = readPyprojectProjectVersion(dir);
  if (v) return { version: v, source: 'pyproject.toml [project]' };

  return { version: '', source: '' };
}

/**
 * 只认 `[project]` 节里的 version。
 * 为什么不能直接全文正则：pyproject.toml 里还常有
 * `[tool.poetry] version`、`[tool.commitizen] version` 等等，
 * 谁先出现就取谁，会取到与主程序版本无关的值。
 */
function readPyprojectProjectVersion(dir) {
  const raw = readTextFile(path.join(dir, 'pyproject.toml'));
  if (!raw) return '';
  let inProject = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const sec = t.match(/^\[([^\]]+)\]/);
    if (sec) {
      inProject = sec[1].trim() === 'project';
      continue;
    }
    if (!inProject) continue;
    const m = t.match(/^version\s*=\s*["']([^"']+)["']/);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

/**
 * 版本是否落在启动器支持的范围内。
 *
 * 既定约束：只支持 MaiBot 1.2.x，0.x 一律引导重装。
 * 这里额外把 1.0/1.1 也判为不支持（它们同样不是 1.2.x 的配置格式），
 * 但**不去判死更高的主版本** —— 将来出了 2.x，标成"不支持"是错的，
 * 该由真正的兼容性检查（identity 校验）去决定。
 *
 * @returns {'supported'|'unsupported'|'unknown'} unknown = 版本读不到，不猜
 */
/**
 * 扫描结果只保留主版本 >= 此值的 MaiBot。
 *
 * 用户明确要求："我只需要扫 1.0.0 以上的"。
 * 机器上翻出的一堆 0.6.x / 0.7.x / 0.12.x 历史遗留会把列表撑爆，
 * 真正能用的那几个反而被淹没。
 */
const MIN_MAIBOT_MAJOR = 1;

/**
 * 这条版本是否**确定**低于 MIN_MAIBOT_MAJOR.0.0。
 *
 * 只有"读出来了版本号、并且主版本更小"才返回 true。
 * 读不出（unknown）一律返回 false —— 我们没认出来不代表它旧，
 * 不能拿"没读到"当"太旧了"来处理，那样会误杀真正的新版本。
 *
 * @param {string} version
 * @returns {boolean}
 */
function isBelowMinVersion(version) {
  const m = /(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false; /* 读不到 → 不过滤 */
  return Number(m[1]) < MIN_MAIBOT_MAJOR;
}

function classifyVersion(version) {
  /*
    不锚定行首：版本串可能带前后缀，例如 0.6.x 那条线拼出来的
    `0.6.3-fix-2` 或 `test-0.6.3-fix-2`。取第一个 x.y 来判断主次版本。
  */
  const m = /(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return 'unknown';
  const major = Number(m[1]);
  /*
    ⚠️ 用户死规矩（原话）："启动器只能启动1.0.0以上 记住几死"。
    ────────────────────────────────────────────────────────────────
    这里以前是 `major === 1 && minor >= 2` —— 把 1.0 / 1.1 也判成
    "不支持"，理由是"它们的配置格式不是 1.2.x 的"。
    但那是**协议端适配器**的要求，不该拿来当启动器的准入线：
    1.0 / 1.1 本身是能跑起来的 MaiBot，判成不支持只会让用户
    白重装一个没必要的版本。准入线就是主版本 >= 1（≥ 1.0.0），
    与 MIN_MAIBOT_MAJOR 保持同一个数字，别再各说各话。
  */
  if (major >= 1) return 'supported';
  return 'unsupported';
}

/**
 * 读 SnowLuma 的版本：`package.json` 的 `version`。
 *
 * 实测官方运行时的 package.json：
 *   { "name": "@snowluma/runtime", "version": "1.14.19", "main": "index.mjs" }
 * 这个 version 就是它的产品版本，直接拿来用。
 *
 * @returns {{version:string, source:string}}
 */
function readSnowLumaVersion(dir) {
  const raw = readTextFile(path.join(dir, 'package.json'), 65536);
  if (!raw) return { version: '', source: '' };
  try {
    const pkg = JSON.parse(raw);
    const v = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
    if (v) return { version: v, source: 'package.json version' };
  } catch (_) {
    /* package.json 坏了也不影响"这是 SnowLuma"的判定 */
  }
  return { version: '', source: '' };
}

/**
 * 判定某个目录是不是 MaiBot / SnowLuma 的安装根。
 *
 * ⚠️ 以前这里还认旧的 QQ 注入式协议端。用户明确要求**抛弃它、改用 SnowLuma**
 *    （SnowLuma 不需要注入 QQ 进程，是独立 Node 程序，自带 WebUI），
 *    所以那套判定连同它的一整套服务代码都删掉了。
 *    留着"认出来但不给用"只会变成死代码 —— 那正是用户在骂的东西。
 *
 * @param {string} dir 目录绝对路径
 * @param {import('fs').Dirent[]} entries readdir(withFileTypes) 的结果
 * @returns {null|{type:'maibot'|'snowluma', entry:string, evidence:string,
 *                version:string, versionSource:string, supported:string}}
 */
function inspectDir(dir, entries) {
  const files = new Set();
  const dirs = new Set();
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (e.isDirectory()) dirs.add(n);
    else files.add(n);
  }

  /*
    ---- SnowLuma：只认 package.json 里那个官方包名 ----

    刻意**只留这一条判据**，不再加"node.exe + index.mjs + native/ + client/"
    那种组合兜底。理由是被这轮误报教育过了：
      · "看着像"的兜底判据是误报的直接来源（之前拿目录名当判据，
        把 Tencent Files 里一个以协议端命名的数据目录都算成了安装）；
      · SnowLuma 要么是启动器自己下的（位置我们自己知道，见 knownRoots），
        要么来自官方 release —— 两种情况的 package.json 都有这个包名；
      · 万一上游改了包名导致漏报，用户会看到"少了一个"，能反馈；
        而误报是用户看到"多了一堆不相干的东西"，这次已经为此发火了。
    宁可漏报也不误报。
  */
  if (files.has('package.json')) {
    const raw = readTextFile(path.join(dir, 'package.json'), 65536);
    if (raw && raw.includes(SNOWLUMA_PKG_NAME)) {
      const { version, source } = readSnowLumaVersion(dir);
      return {
        type: 'snowluma',
        entry: 'index.mjs',
        evidence: `package.json 里声明了 ${SNOWLUMA_PKG_NAME}`,
        version,
        versionSource: source,
        supported: 'unknown' /* SnowLuma 是独立产品，不套 MaiBot 的版本支持线 */
      };
    }
  }

  /* ---- MaiBot：bot.py + src/ 是骨架，再加一个 MaiBot 独有证据 ---- */
  if (files.has(MAIBOT_ENTRY_FILE) && dirs.has(MAIBOT_SRC_DIR)) {
    const hasConfigPy = isFile(path.join(dir, ...MAIBOT_CONFIG_PY));
    const hasDepends = isDir(path.join(dir, MAIBOT_DEPENDS_DIR));
    if (hasConfigPy || hasDepends) {
      const { version, source } = readMaiBotVersion(dir);
      return {
        type: 'maibot',
        entry: MAIBOT_ENTRY_FILE,
        evidence: hasConfigPy
          ? 'bot.py + src/ + src/config/config.py'
          : 'bot.py + src/ + depends-data/',
        version,
        versionSource: source,
        supported: classifyVersion(version)
      };
    }
  }

  return null;
}

/**
 * 兼容旧调用点的入口。
 *
 * ⚠️ 刻意**只接受目录路径**（entries 可省略，会自己 readdir）。
 * 不再支持"只传一堆文件名"的用法：仅凭名字无法区分
 * "这里是协议端安装" 和 "这里有个和协议端同名的子文件夹"，
 * 而那正是上一版误报的根源。传文件名集合时一律返回 null（宁可漏报也不误报）。
 *
 * @param {string|Set<string>|string[]} dir 目录路径
 * @param {import('fs').Dirent[]} [entries]
 * @returns {'maibot'|'snowluma'|null}
 */
function detectType(dir, entries) {
  if (typeof dir !== 'string' || !dir) return null;
  let list = entries;
  if (!Array.isArray(list)) {
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return null;
    }
  }
  const hit = inspectDir(dir, list);
  return hit ? hit.type : null;
}

/* ---------------------------------------------------------------------------
 *  默认扫描根
 * ------------------------------------------------------------------------- */

/**
 * 枚举本机固定磁盘的根目录（C:\ D:\ E:\ …）。
 *
 * 为什么必须包含盘符根：用户的安装**根本不在家目录里**。实测这台机器上：
 *   D:\文件夹\MaiM-with-u\MaiBot
 *   D:\所有文件夹\MaiM-with-u\MaiBot-main\MaiBot-main
 *   E:\新建文件夹\MaiBot OneKey\resources\modules\MaiBot
 * 只扫家目录的话这些永远找不到 —— 用户会直接问"会扫盘吗"。
 *
 * 只探测 C..Z（不碰 A/B 软驱），不存在的盘符 fs.existsSync 会很快返回 false。
 */
function fixedDriveRoots() {
  const out = [];
  const sys = String(process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    if (`${letter}:` === sys) continue;
    const p = `${letter}:\\`;
    try {
      if (fs.existsSync(p)) out.push(p);
    } catch (_) {
      /* 空光驱 / 未就绪的盘符：跳过 */
    }
  }
  try {
    if (fs.existsSync(`${sys}\\`)) out.unshift(`${sys}\\`);
  } catch (_) {
    /* 拿不到系统盘就算了，其他盘符照样能扫 */
  }
  return out;
}

/**
 * 构建默认扫描根：**深路径优先 + 整盘根目录兜底**。
 *
 * 这里推翻了之前"刻意不含盘符根"的决定，理由是被实测打脸：
 * 用户十几个麦麦里有一半在 D:/E: 上，不扫盘就等于没扫。
 *
 * ⚠️ 顺序**极其重要**，而且不能用"父目录已覆盖"来去掉子目录：
 *
 *   深度是从**根**算起的。同一个安装的相对深度天差地别：
 *     C:\Users\x\AppData\Roaming\MaiBotOneKeyDesktop\<hash>\modules\MaiBot
 *       从 C:\ 算 = 8 层
 *       从 %APPDATA% 算 = 4 层
 *   所以"C:\ 已经覆盖了 %APPDATA%，可以不要它"是**错的** ——
 *   实际上从 C:\ 出发根本够不到，只有从 %APPDATA% 出发才够得到。
 *   （这正是上一版漏掉一大堆 1.x 安装的原因。）
 *
 *   因此这里**只去重完全相同的路径，不做嵌套剔除**，
 *   并且把"深路径"排在前面：万一撞到 maxDirs 上限，
 *   被截断的也只是兜底的盘符根，而不是这些真正装着麦麦的位置。
 */
function defaultRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const list = [];

  /* 第一梯队：从这些根出发才够得到的真实安装位置（实测都有货） */
  for (const key of ['APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) list.push(process.env[key]);
  }
  if (home) {
    list.push(
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      home
    );
  }

  /* 第二梯队：整盘兜底，捞"装在别的盘/别的角落"的那些 */
  list.push(...fixedDriveRoots());

  /* 只去重完全相同的路径 */
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const norm = path.resolve(p).toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    try {
      if (fs.existsSync(p)) out.push(path.resolve(p));
    } catch (_) {
      /* 不可访问则跳过 */
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 *  扫描实现
 * ------------------------------------------------------------------------- */

/**
 * 取"启动器已知的安装目录"，它们**永远**参与扫描。
 *
 * 为什么必须加（两条都是实测出来的）：
 *   1) 用户的真实安装经常不在默认根目录里。实测：一直在用的装在
 *      `D:\文件夹\MaiM-with-u\MaiBot`，而默认根只有家目录下那几个位置，
 *      于是扫描永远报"没检测到"，用户自然会认为扫描是坏的。
 *   2) 启动器自己下载的模块在
 *      `%LOCALAPPDATA%\com.maibot.launcher\resources\modules\<name>`，
 *      挂在默认根 AppData\Local 下面**正好比 maxDepth 深一层**，
 *      靠遍历够不到。
 *
 * ⚠️ 这里以前还收旧 QQ 注入式协议端的目录键。那套协议端已经整体删掉了，改成 snowlumaDir。
 *
 * 只收 scanner 认得的类型（maibot / snowluma），目录不存在就跳过。
 */
function knownRoots() {
  let svc;
  try {
    /* 延迟 require 避免与 settings.js 形成加载环 */
    svc = require('./settings').getBackendSettings()?.service;
  } catch (_) {
    return [];
  }
  if (!svc || typeof svc !== 'object') return [];
  const out = [];
  for (const key of ['maibotDir', 'snowlumaDir']) {
    const v = String(svc[key] || '').trim();
    if (!v) continue;
    try {
      if (fs.existsSync(v) && fs.statSync(v).isDirectory()) out.push(path.resolve(v));
    } catch (_) {
      /* 盘符不存在 / 无权限：跳过 */
    }
  }
  return out;
}

/** 合并多组根目录并去重（大小写不敏感，Windows 下同一个目录可能有多种写法） */
function mergeRoots(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const p of list || []) {
      if (!p) continue;
      const abs = path.resolve(p);
      const norm = abs.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(abs);
    }
  }
  return out;
}

/**
 * 计算本次扫描实际使用的根目录，并说明来源。
 *
 * 优先级：调用方显式传入 > （设置的已知安装目录 + 自定义根 + 系统默认根）。
 * 之所以读设置而不是只依赖调用方传参：
 *   「自定义扫描根」是用户希望**长期生效**的偏好，
 *   而前端每次刷新/进页面都会重新触发扫描，不可能每次都把偏好带上。
 *
 * @param {string[]} [explicit]
 * @returns {{roots:string[], source:'explicit'|'settings'|'defaults', skipped:string[], knownRoots:string[]}}
 */
function resolveRoots(explicit) {
  /* 调用方点名要扫哪些目录时完全照办，不再擅自掺入其他根 */
  if (Array.isArray(explicit) && explicit.length) {
    return { roots: mergeRoots(explicit), source: 'explicit', skipped: [], knownRoots: [] };
  }

  let configured = [];
  try {
    /* 延迟 require 避免与 settings.js 形成加载环 */
    const settings = require('./settings');
    const raw = settings.getBackendSettings()?.general?.scanRoots;
    if (Array.isArray(raw)) configured = raw;
  } catch (_) {
    configured = [];
  }

  /*
    已知安装目录排在最前面：它们命中率最高，
    而且结果列表是按发现顺序排的，用户最关心的那条应该在最上面。
  */
  const known = knownRoots();

  /*
    ⚠️ 自定义扫描根是**追加**，不是替换。

    原实现写成"有自定义根就只扫自定义根"，后果很坑：
    用户为了把 D 盘的安装纳入范围，填了一个根目录，
    结果家目录那一堆全都不扫了 —— 原来能扫到的另外几个安装**凭空消失**。
    实测：加一个根之后扫描目录数从 3691 掉到 10，界面上 0.11.6 那两个直接没了。
    用户说的是"这里也要扫"，不是"只扫这里"。

    顺序：已配置安装目录 → 自定义根 → 系统默认根（命中率高的在前）。
  */
  if (!configured.length) {
    return {
      roots: mergeRoots(known, defaultRoots()),
      source: 'defaults',
      skipped: [],
      knownRoots: known
    };
  }

  /*
    过滤掉已不存在的目录（用户可能删了/换了盘符）。
    不静默丢弃：把跳过的项返回给调用方，让界面能提示"某目录已不存在"，
    而不是让用户以为扫描覆盖了它。
  */
  const roots = [];
  const skipped = [];
  for (const p of configured) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) roots.push(p);
      else skipped.push(p);
    } catch (_) {
      skipped.push(p);
    }
  }

  /*
    自定义根全部失效时，source 要如实退回 'defaults'：
    界面上的来源文案是给用户看的，这时实际生效的只有默认根，
    再标成"自定义"就是在骗人（失效的那几个由 skipped 单独说明）。
  */
  const validCustom = roots.length > 0;
  return {
    roots: mergeRoots(known, roots, defaultRoots()),
    source: validCustom ? 'settings' : 'defaults',
    skipped,
    knownRoots: known
  };
}

/**
 * 扫描安装目录。
 *
 * @param {object} [options]
 * @param {string[]} [options.roots] 自定义扫描根
 * @param {string}   [options.scanId] 客户端提供的 id，用于取消
 * @returns {Promise<{ok:boolean, scanId:string, installations:Array,
 *                    scannedDirs:number, truncated:boolean, cancelled:boolean,
 *                    rootsUsed:string[], rootsSource:string, skippedRoots:string[]}>}
 */
async function scanInstallations(options = {}) {
  const scanId = options.scanId || `scan_${++scanSeq}`;
  const { roots, source, skipped, knownRoots: known } = resolveRoots(options.roots);

  const controller = new AbortController();
  activeScans.set(scanId, controller);

  const found = [];
  const stats = { dirs: 0, truncated: false };
  const startedAt = Date.now();

  logging.log(
    'info',
    `[scanner] 开始扫描 ${roots.length} 个根目录 (scanId=${scanId}, 来源=${source}` +
      (skipped.length ? `, 跳过无效目录 ${skipped.length} 个` : '') +
      ')'
  );

  try {
    for (const root of roots) {
      if (controller.signal.aborted) break;
      if (found.length >= SCAN.maxResults) {
        stats.truncated = true;
        break;
      }
       
      await walk(root, found, SCAN.maxDepth, stats, controller.signal);
    }
  } catch (e) {
    logging.log('error', `[scanner] 扫描异常: ${e.message}`);
  } finally {
    activeScans.delete(scanId);
  }

  const cancelled = controller.signal.aborted;

  /*
    ===== 只保留 1.0.0 及以上的 MaiBot =====

    用户的诉求很直接："我只需要扫 1.0.0 以上的"。
    他要的是"能用的麦麦"，而不是把机器上所有历史遗留的旧版本全倒出来。
    实测这台机器上就翻出 0.6.3-fix-2 / 0.7.0 / 0.12.2×2 四个老古董，
    混在 1.x 中间让列表从 6 条膨胀到 10 条，反而看不清真正能用的那几个。

    ⚠️ 两个刻意的边界：
      1) 只过滤 MaiBot，**SnowLuma 不过滤**。SnowLuma 没有"1.0.0 以上"这回事，
         它跟 MaiBot 版本线是独立的，拿 MaiBot 的版本规则去卡它是错的。
      2) 版本**读不出来**的不过滤。读不到只能说明我们没认出来，
         不能据此断定它低于 1.0.0 —— 宁可多显示一条也不误杀。
         过滤只以"确实读出来且主版本 < 1"为依据。

    被过滤掉的不静默丢弃：数量通过 hiddenOldCount 返回，界面上说明一句，
    否则用户会以为扫描又漏了。
  */
  const all = dedupe(found);
  const installations = [];
  let hiddenOld = 0;
  for (const item of all) {
    if (item.type === 'maibot' && isBelowMinVersion(item.version)) {
      hiddenOld += 1;
      continue;
    }
    installations.push(item);
  }

  logging.log(
    'info',
    `[scanner] 扫描结束 目录=${stats.dirs} 命中=${installations.length}` +
      (hiddenOld ? `（另有 ${hiddenOld} 个低于 ${MIN_MAIBOT_MAJOR}.0.0 的旧版本已隐藏）` : '') +
      ` 用时=${Date.now() - startedAt}ms` +
      (cancelled ? '（已取消）' : '') +
      (stats.truncated ? '（达到结果上限）' : '')
  );

  return {
    ok: true,
    scanId,
    installations,
    scannedDirs: stats.dirs,
    truncated: stats.truncated,
    cancelled,
    elapsedMs: Date.now() - startedAt,
    /* 被"只要 1.0.0 以上"这条规则挡掉的旧版本数量，界面用它说明一句 */
    hiddenOldCount: hiddenOld,
    /* 让界面能说明"这次到底扫了哪些目录"，而不是让用户盲猜 */
    rootsUsed: roots,
    rootsSource: source,
    skippedRoots: skipped,
    /*
      单独返回"启动器已知的安装目录"。
      界面据此说明"你配置的那个安装目录也已经扫过了"——
      否则用户配了目录却没看到结果时，分不清是没扫还是没扫到。
    */
    knownRoots: known || []
  };
}

/** 取消一个正在进行的扫描 */
function cancelScan(scanId) {
  const controller = activeScans.get(scanId);
  if (!controller) return { ok: false, message: '该扫描任务不存在或已结束' };
  controller.abort();
  return { ok: true, scanId };
}

/** 递归遍历（异步，每层让出事件循环，不阻塞主进程） */
async function walk(dir, found, depth, stats, signal) {
  if (depth <= 0 || stats.dirs >= SCAN.maxDirs || found.length >= SCAN.maxResults) return;
  if (signal.aborted) return;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return; /* 权限不足/目录消失：静默跳过 */
  }
  stats.dirs += 1;

  /* 收集目录项（命中判定需要真实的 Dirent，见 inspectDir 的说明） */
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    if (!entry.name.startsWith('.') && !SCAN.skipNames.has(lower)) {
      dirs.push(entry.name);
    }
  }

  const hit = inspectDir(dir, entries);
  if (hit) {
    found.push(buildInstallation(dir, hit));
    return; /* 命中即不下钻：真安装里面必然还有 src/、plugins/、native/ 等子目录，下钻会重复命中 */
  }

  for (const name of dirs) {
    if (signal.aborted) return;
    if (stats.dirs >= SCAN.maxDirs || found.length >= SCAN.maxResults) return;

    await walk(path.join(dir, name), found, depth - 1, stats, signal);
  }
}

/** 构造安装条目 */
function buildInstallation(dir, hit) {
  return {
    name: path.basename(dir) || dir,
    path: dir,
    type: hit.type,
    /*
      版本读不到时给空串，**不**从别处"找个数字顶上"。
      旧实现会去读 pyproject.toml / package.json / version.txt，
      于是随便一个 Python 项目的版本号都被当成 MaiBot 版本显示出来
      （实测 zhenxun_bot 显示成 0.2.4，真实 0.6.3 安装显示成 0.1.0）。
      给个错的版本比不给更糟 —— 用户会照着它做判断。
      同时带上 versionSource，出问题时能直接看出数字是从哪个文件来的。
    */
    version: hit.version || '',
    versionSource: hit.versionSource || '',
    /* supported / unsupported / unknown（unknown = 版本读不到，不猜） */
    supported: hit.supported || 'unknown',
    /* 判定依据：把"为什么认为这是 MaiBot"写进结果，以后误报不用再靠猜 */
    evidence: hit.evidence || '',
    entry: hit.entry || '',
    runnable: Boolean(hit.entry),
    discoveredAt: Date.now()
  };
}

/** 去重：若某路径被另一路径包含，保留外层 */
function dedupe(list) {
  const sorted = [...list].sort((a, b) => a.path.length - b.path.length);
  const result = [];
  for (const item of sorted) {
    const p = item.path.toLowerCase();
    const nested = result.some((r) => {
      const base = r.path.toLowerCase();
      return p === base || p.startsWith(base + path.sep);
    });
    if (!nested) result.push(item);
  }
  return result;
}

module.exports = {
  scanInstallations,
  cancelScan,
  defaultRoots,
  knownRoots,
  mergeRoots,
  resolveRoots,
  detectType,
  /* 导出给回归测试与 envcheck 用的判定原件 */
  inspectDir,
  classifyVersion,
  readMaiBotVersion,
  readSnowLumaVersion,
  SNOWLUMA_PKG_NAME,
  isBelowMinVersion,
  MIN_MAIBOT_MAJOR,
  activeScanCount: () => activeScans.size
};
