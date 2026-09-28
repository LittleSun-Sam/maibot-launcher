/*
================================================================================
技术文档：src/main/services/versions.js
职责：受管麦麦版本的**列出**与**真删除**（设置页「已安装版本」）。
================================================================================
  先把事实写清楚（这是查过磁盘与全部相关代码之后写的，不是假设）：

  1) 本启动器**没有** `versions/<tag>` / `MaiBot-<tag>` 这种"一个版本一个文件夹"
     的布局，也没有记录"当前版本"的指针文件。受启动器托管、真正被使用的
     只有一个目录：设置 service.maibotDir 指向的那个（默认 <目标目录>/maibot，
     见 github.js installMaiBot 的 installRoot）。

  2) 但"多个版本的麦麦同时躺在磁盘上"是**真实存在**的，来源只有两个，
     而且都是启动器自己造成的：
       · 升级：github.upgradeMaiBot 把旧目录整体改名成
         `<installDir>.backup-<ISO时间戳>` 保留下来（旧版本完整可回滚）；
       · 安装：swapDirectory 在目标已存在时留下 `<installDir>.old-<时间戳>`。
     两者都是**一整套旧版本安装**（含它自己的 config/ data/），删掉就是真的少一个版本。

  3) 同一个受管父目录里还可能躺着别的麦麦副本（用户自己解压的、别的启动器装的）。
     scanner.detectType() 能认出它们，但它们**不**是"已识别的版本号列表"，
     所以本模块只按磁盘事实列出，认不出类型的一律不进列表。

  因此本模块的"受管版本根目录"就是（main 侧自己算，绝不采信渲染层传的根）：
    · 当前配置的 MaiBot 安装目录的**上一级** —— 旧版本备份与同级副本都在这里；
    · 启动器自己的数据根 paths.dataRoot() —— 启动器独占，可安全清理。

  删除的硬性条件（任何一条不满足都返回 { ok:false, message }，绝不静默放行）：
    · 目标真实存在且是目录；解析 realpath 之后仍在受管根**内部**（防 .. 与软链接逃逸）；
    · 目标本身是麦麦安装（bot.py + src/ + MaiBot 独有结构），或名字符合备份命名规则；
    · 不是"正在使用"的那一个（设置里的 maibotDir），也不是它的上级；
    · 没有托管中的麦麦进程正在用它（process registry 的 cwd）；
    · 真删：fsp.rm(recursive)，失败**如实报错**（文件被占用就报占用），不假装成功。
================================================================================
*/
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const logging = require('../logging');
const paths = require('../paths');
const scanner = require('./scanner');
const github = require('./github');
const { USER_DATA_KEEP } = require('../constants');

/* ============================================================================
 *  小工具
 * ========================================================================== */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/** 解析真实路径（解掉 junction / 符号链接）；失败则退回 resolve 的结果 */
function realKey(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

/**
 * 当前正在使用的 MaiBot 目录。
 *
 * 事实：启动器里**没有**"当前版本"的指针文件，唯一权威来源就是设置里的
 * service.maibotDir（它就是 process.buildStartPayload 的 cwd）。
 */
function activeMaibotDir() {
  let raw = '';
  try {
    /* 延迟 require：与 settings.js 的加载顺序解耦（github.js / scanner.js 同样做法） */
    raw = String(require('./settings').getBackendSettings()?.service?.maibotDir || '').trim();
  } catch (e) {
    logging.log('warn', `[versions] 读取设置里的 MaiBot 目录失败: ${e.message}`);
    return '';
  }
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch (_) {
    return '';
  }
}

/**
 * 受管版本根目录（去重、realpath 归一）。
 * 删除只允许发生在这些根的内部 —— 渲染层无法影响这个列表。
 */
function managedRoots() {
  const raw = [];
  const active = activeMaibotDir();
  if (active) raw.push(path.dirname(active));
  try {
    raw.push(paths.dataRoot());
  } catch (_) {
    /* paths 不可用（非 electron 环境）：至少还有安装目录的上一级 */
  }

  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const real = realKey(item);
    const key = github.normKey(real);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

/**
 * 正在运行的托管麦麦进程（进程与版本目录的关联就在这里）：
 * process.js 的 registry 记录里存着启动时用的 cwd。
 * @returns {null|{pid:number, cwd:string}}
 */
function runningMaiBot() {
  try {
    const status = require('./process').getServicesStatus();
    const hit = Array.isArray(status)
      ? status.find((s) => s && s.key === 'maibot' && s.running)
      : null;
    if (!hit) return null;
    return { pid: hit.pid, cwd: typeof hit.cwd === 'string' ? hit.cwd : '' };
  } catch (e) {
    /* 拿不到状态时按"没在运行"处理，但留下痕迹；文件被占用时真删会如实报错 */
    logging.log('warn', `[versions] 无法确认 MaiBot 运行状态: ${e.message}`);
    return null;
  }
}

/** 目录里存在的用户数据项（配置 / 存档等），用于确认文案如实说明会带走什么 */
function userDataItems(dir) {
  const out = [];
  for (const name of USER_DATA_KEEP) {
    try {
      if (fs.existsSync(path.join(dir, name))) out.push(name);
    } catch (_) {
      /* 读不到就当不存在，不猜 */
    }
  }
  return out;
}

/** 复用 scanner 的版本解析（三条产品线各读各的），绝不在这里再写一套 */
function versionOf(dir) {
  try {
    const r = scanner.readMaiBotVersion(dir) || {};
    return { version: String(r.version || ''), versionSource: String(r.source || '') };
  } catch (_) {
    return { version: '', versionSource: '' };
  }
}

/* ============================================================================
 *  列出
 * ========================================================================== */

/**
 * 列出受管版本的磁盘事实。
 *
 * 只读、不产生任何副作用；不测体积（避免设置页卡在几百 MB 的目录遍历上），
 * 备份的体积与文件数由 github.listBackups 顺带给出。
 *
 * @returns {Promise<{ok:boolean, activePath:string, activeExists:boolean,
 *                    running:{running:boolean,pid:number|null,cwd:string},
 *                    managedRoots:string[], versions:Array, message:string}>}
 */
async function listManagedVersions() {
  const active = activeMaibotDir();
  const run = runningMaiBot();
  const versions = [];

  if (active) {
    const exists = isDir(active);
    const activeItems = exists ? userDataItems(active) : [];
    const runningIt = Boolean(run && run.cwd && github.isUnder(run.cwd, active));
    const v = exists ? versionOf(active) : { version: '', versionSource: '' };

    versions.push({
      path: active,
      name: path.basename(active) || active,
      version: v.version,
      versionSource: v.versionSource,
      kind: 'active',
      exists,
      /* 正在使用 / 正在运行的版本永远不可删：这里只是界面层的呈现，
         真正的硬性拒绝对 DeleteVersion 里那道判断负责。 */
      deletable: false,
      reason: !exists
        ? '设置里配置的 MaiBot 目录不存在（检查「服务与目录」里的路径）'
        : runningIt
          ? `正在运行（pid ${run.pid}）且是当前使用的版本，需先在总览页点「停止」`
          : '当前正在使用的版本，不允许从启动器删除',
      running: runningIt,
      pid: runningIt && run ? run.pid : null,
      sizeBytes: 0,
      fileCount: 0,
      mtimeMs: 0,
      hasUserData: activeItems.length > 0,
      userDataItems: activeItems
    });

    if (exists) {
      const known = new Set([github.normKey(active)]);

      /* 1) 升级/替换留下的旧版本备份（与安装目录同级、命名有严格规则） */
      const backups = await github.listBackups(active);
      for (const b of backups) {
        const items = userDataItems(b.path);
        const bv = versionOf(b.path);
        known.add(github.normKey(b.path));
        versions.push({
          path: b.path,
          name: b.name,
          version: bv.version,
          versionSource: bv.versionSource,
          kind: 'backup',
          exists: true,
          deletable: true,
          reason: '',
          running: false,
          pid: null,
          sizeBytes: Number(b.sizeBytes) || 0,
          fileCount: Number(b.fileCount) || 0,
          mtimeMs: Number(b.mtimeMs) || 0,
          hasUserData: items.length > 0,
          userDataItems: items
        });
      }

      /*
        2) 受管父目录里**同级**的其它麦麦副本。
        只认 scanner.detectType 判定为麦麦安装的目录 —— 名字像不算数
        （scanner.js 的判定规则就是被"名字长得像"教出来的）。
      */
      const parent = path.dirname(active);
      let entries = [];
      try {
        entries = await fsp.readdir(parent, { withFileTypes: true });
      } catch (e) {
        logging.log('warn', `[versions] 读取受管目录失败 ${parent}: ${e.message}`);
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const full = path.join(parent, ent.name);
        const key = github.normKey(full);
        if (known.has(key)) continue;
        if (scanner.detectType(full) !== 'maibot') continue;
        known.add(key);
        const items = userDataItems(full);
        const iv = versionOf(full);
        versions.push({
          path: full,
          name: ent.name,
          version: iv.version,
          versionSource: iv.versionSource,
          kind: 'install',
          exists: true,
          deletable: true,
          reason: '',
          running: false,
          pid: null,
          sizeBytes: 0,
          fileCount: 0,
          mtimeMs: 0,
          hasUserData: items.length > 0,
          userDataItems: items
        });
      }
    }
  }

  return {
    ok: true,
    activePath: active,
    activeExists: Boolean(active && isDir(active)),
    running: run ? { running: true, pid: run.pid, cwd: run.cwd } : { running: false, pid: null, cwd: '' },
    managedRoots: managedRoots(),
    versions,
    message: active
      ? ''
      : '尚未配置「MaiBot 目录」，只列得出启动器受管目录里的内容；请先在「服务与目录」里指定麦麦安装目录'
  };
}

/* ============================================================================
 *  删除（真删）
 * ========================================================================== */

/**
 * 删除一个受管版本目录。
 *
 * @param {unknown} target 渲染层给的目录路径（**不可信**：下面逐条重新校验）
 * @returns {Promise<{ok:boolean, message:string, path?:string, kind?:string,
 *                    version?:string, userDataItems?:string[], freedBytes?:number}>}
 */
async function deleteVersion(target) {
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, message: '未指定要删除的版本目录' };
  }

  let abs;
  try {
    abs = path.resolve(target.trim());
  } catch (_) {
    return { ok: false, message: `路径无法解析：${target}` };
  }

  /* ① 必须真实存在且是目录（"不存在的版本"在这里如实失败） */
  if (!fs.existsSync(abs)) {
    return { ok: false, message: `该版本目录不存在（可能已被删除）：${abs}` };
  }
  if (!isDir(abs)) {
    return { ok: false, message: `目标不是目录，已拒绝：${abs}` };
  }

  /* realpath：junction / 符号链接指到哪儿就以哪儿为准（防软链接逃逸） */
  const real = realKey(abs);

  /* ② 正在使用的版本：硬性拒绝（不靠前端禁用） */
  const active = activeMaibotDir();
  if (active) {
    const activeReal = realKey(active);
    if (github.normKey(real) === github.normKey(activeReal)) {
      return {
        ok: false,
        path: real,
        message:
          `「${path.basename(real)}」是设置里正在使用的 MaiBot 版本（${real}），不允许删除。` +
          '要换版本请在总览页切换实例，或先在「服务与目录」里改指到别的版本。'
      };
    }
    /* 目标如果是当前版本的上级，删了会连带删掉正在用的那份 */
    if (github.isUnder(activeReal, real)) {
      return {
        ok: false,
        path: real,
        message: `该目录包含正在使用的 MaiBot 版本（${activeReal}），删除会连带删掉它，已拒绝。`
      };
    }
  }

  /* ③ 正在运行的版本：先让用户停止 */
  const run = runningMaiBot();
  if (run && run.cwd) {
    const cwdReal = realKey(run.cwd);
    if (github.isUnder(cwdReal, real) || github.isUnder(real, cwdReal)) {
      return {
        ok: false,
        path: real,
        message:
          `MaiBot 正在运行（pid ${run.pid}，工作目录 ${cwdReal}），这份版本正被进程使用。` +
          '请先在总览页点「停止」，再回来删除。'
      };
    }
  }

  /* ④ 路径限制：只允许删除受管根**内部**的目录 */
  const roots = managedRoots();
  const inside = roots.some((r) => github.isUnder(real, r) && github.normKey(real) !== github.normKey(r));
  if (!inside) {
    logging.log('warn', `[versions] 拒绝删除受管目录之外的路径: ${real}`);
    return {
      ok: false,
      path: real,
      message:
        `只允许删除启动器受管目录**内部**的版本（${roots.join(' / ') || '（当前没有可用受管根）'}）；` +
        `${real} 不在其中，已拒绝。`
    };
  }

  /* ⑤ 身份校验：必须是麦麦安装，或符合启动器自己的备份命名 */
  const backupRe = active ? github.backupNamePattern(active) : null;
  const isBackupName = backupRe ? backupRe.test(path.basename(real)) : false;
  const kind = scanner.detectType(real);
  if (kind !== 'maibot' && !isBackupName) {
    logging.log('warn', `[versions] 拒绝删除非麦麦目录: ${real}`);
    return {
      ok: false,
      path: real,
      message:
        `${real} 不像麦麦安装（未找到 bot.py + src/ + MaiBot 独有结构），` +
        '也不是启动器的备份命名，已拒绝删除。'
    };
  }

  /* ⑥ 兜底：系统目录 / 自动执行位置 / 启动器自身目录一律拒绝 */
  if (github.isDeniedPath(real)) {
    return { ok: false, path: real, message: `该位置属于系统/自动执行/启动器自身目录，不允许删除：${real}` };
  }

  const items = userDataItems(real);
  const ver = versionOf(real).version;

  /* ⑦ 真删。force:false —— 目录/文件被占用时如实抛错，不假装成功 */
  let freed = 0;
  try {
    const measured = await github.measureTree(real);
    freed = Number(measured.sizeBytes) || 0;
    await fsp.rm(real, { recursive: true, force: false, maxRetries: 2, retryDelay: 150 });
  } catch (e) {
    const code = e && e.code ? `（${e.code}）` : '';
    logging.log('error', `[versions] 删除失败 ${real}: ${e.message}`);
    return {
      ok: false,
      path: real,
      message:
        `删除失败${code}：${e.message}。` +
        '目录可能正被进程占用（例如麦麦还在运行、资源管理器停在里面），请停止相关进程后重试。'
    };
  }

  /* 删完再确认一次：磁盘上真的没了才回成功 */
  if (fs.existsSync(real)) {
    logging.log('error', `[versions] 删除后目录仍存在: ${real}`);
    return { ok: false, path: real, message: `删除命令已执行，但 ${real} 仍然存在，未确认删除成功。` };
  }

  logging.log(
    'warn',
    `[versions] 已删除受管版本 ${real}` +
      `${ver ? `（版本 ${ver}）` : ''}${items.length ? `，含用户数据 ${items.join('/')}` : ''}` +
      `（释放约 ${github.humanSize(freed)}）`
  );
  return {
    ok: true,
    path: real,
    kind: isBackupName ? 'backup' : 'install',
    version: ver,
    userDataItems: items,
    freedBytes: freed,
    message: `已从磁盘删除 ${real}${freed ? `（释放约 ${github.humanSize(freed)}）` : ''}`
  };
}

module.exports = {
  listManagedVersions,
  deleteVersion,
  /* 导出给回归测试用（纯逻辑，便于单独断言受管根与当前版本口径） */
  managedRoots,
  activeMaibotDir
};
