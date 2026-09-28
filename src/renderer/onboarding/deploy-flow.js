/*
================================================================================
模块：src/renderer/onboarding/deploy-flow.js
职责：首跑部署流程的「纯函数」判定逻辑 —— 从零到服务跑起来的那条路。
================================================================================
  为什么要有这个文件（与 onboarding/steps.js 的分工）：
    · onboarding/steps.js 回答的是「麦麦装好之后，怎么把它接通 QQ」；
    · 本文件回答的是**它之前**那一段：「这台机器现在到底缺什么、
      下一步该点哪里、点下去会发生什么」。
    新用户拿到启动器的第一件事是后者 —— 而此前启动器把这段完全跳过了：
    引导只做检测 + 跳转，装完 MaiBot 之后没有任何地方告诉用户
    「还要装依赖」和「还要启动服务」，于是"装完了但没跑起来"。

  设计上必须守住的四条（每一条都对应一类真实故障）：
    1. **状态全部来自真实数据**，不猜、不默认通过。
       每个 fact 都必须能指到它的来源频道（见各步骤里的「来源：」注释）。
       所以本模块不自己做任何 IO —— 它只吃一份 snapshot，吐一份步骤表，
       由 scripts/verify-deploy-flow.mjs 喂真实机器数据逐条断言。
    2. **可重入**：步骤的 done 由**当前的磁盘 / 进程事实**推导，
       不依赖"用户上一轮点到哪了"。中途退出再进来，看到的就是现在这一步。
       只有那两件启动器**看不到**的事（选目录、启动服务）才允许用户手动标记，
       而且一旦事实反证（目录没了 / 服务没在跑），标记立刻失效。
    3. **不假通过**：status 只有 done / ready / blocked 三态，
       没有"看起来配好了"。检测不到就写"检测不到"，不写成绿灯。
    4. **每条文案都能照着做**：next 字段必须是用户可以立刻执行的一步
       （点哪个按钮 / 去哪一页 / 敲哪条命令），不是"请配置环境"这种空话。

  ⚠️ 本模块**不写任何文件、不发起任何下载、不启动任何进程**。
     它只产出「该显示什么、按钮该接哪个已有动作」。
================================================================================
*/

/**
 * 部署流程的步骤 id。
 * 与 onboarding/steps.js 的 STEP_IDS **刻意不同名**：
 *   两者共用一个 doneIds 存储键（onboarding.doneIds），
 *   同名会让"引导第 3 步已完成"与"部署第 3 步已完成"互相污染。
 * 改名会让老用户的进度丢失，保持稳定。
 */
export const DEPLOY_IDS = {
  env: 'deploy-env',
  dir: 'deploy-dir',
  install: 'deploy-install',
  deps: 'deploy-deps',
  start: 'deploy-start',
  out: 'deploy-out'
};

/** 安装一个服务建议预留的可用空间（含解压余量），与安装器页 MIN_FREE_BYTES 同值 */
export const MIN_FREE_BYTES = 800 * 1024 * 1024;

/** 状态三态 —— 没有第四态，避免出现"看起来配好了" */
export const STATUS_DONE = 'done';
export const STATUS_READY = 'ready';
export const STATUS_BLOCKED = 'blocked';

/** 文本兜底：snapshot 里任何字段都可能是 null / 数字 / 对象 */
function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

/** 事实行：{ text, tone }，tone 只用于给圆点上色（ok / warn / err），不带语义 */
function fact(text, tone = '') {
  return { text: String(text), tone };
}

/** 安装目录名（MaiBot 的 installRoot = <目标目录>/maibot） */
const SUBDIR = { maibot: 'maibot', snowluma: 'snowluma' };

/** 目标目录表单里禁止出现的系统位置 —— 与 InstallerPanel 的行内提示口径一致 */
const FORBIDDEN_RE =
  /^[a-zA-Z]:[\\/](Windows|Program Files(?: \(x86\))?|ProgramData|System32|SysWOW64|PerfLogs|Recovery|Boot|System Volume Information)(?:[\\/]|$)/i;
const USERS_ROOT_RE = /^[a-zA-Z]:[\\/]Users[\\/]?$/i;
/** 真正的盘根（C:\ 、\\server\share），可以装但会和别的东西混在一起 */
const ROOT_PATH_RE = /^[a-zA-Z]:[\\/]?$|^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/;

/** 统一分隔符、去掉末尾分隔符（保留盘根本身） */
export function normalizePath(input) {
  let p = str(input);
  if (!p) return '';
  p = p.replace(/\//g, '\\');
  if (p.length > 3) p = p.replace(/\\+$/, '');
  return p;
}

/**
 * 目标目录的静态校验。
 * @returns {{level:'ok'|'warn'|'block', message:string, path:string}}
 */
export function validateTargetDir(input) {
  const p = normalizePath(input);
  if (!p) return { level: 'block', message: '还没有选择安装位置', path: '' };
  if (FORBIDDEN_RE.test(p) || USERS_ROOT_RE.test(p)) {
    return {
      level: 'block',
      message: `${p} 是系统关键目录，不能作为安装位置。请改用普通数据目录，例如 D:\\MaiBot`,
      path: p
    };
  }
  if (ROOT_PATH_RE.test(p)) {
    return {
      level: 'warn',
      message: `${p} 是${/^\\\\/.test(p) ? '共享根' : '盘根'}目录。安装会在其中新建 maibot\\ 与 snowluma\\，容易与其他内容混在一起。`,
      path: p
    };
  }
  return { level: 'ok', message: '', path: p };
}

/** 目标目录所在磁盘的探测根：盘符根，拿不到就交给上层兜底 */
export function diskRootOf(dir) {
  const p = normalizePath(dir);
  if (!p) return '';
  const unc = /^(\\\\[^\\]+\\[^\\]+)/.exec(p);
  if (unc) return unc[1];
  const drive = /^([a-zA-Z]:)/.exec(p);
  if (drive) return `${drive[1]}\\`;
  return p;
}

/** 服务安装目录：<目标目录>/maibot | <目标目录>/snowluma */
export function installDirFor(targetDir, kind) {
  const p = normalizePath(targetDir);
  if (!p) return '';
  const sub = SUBDIR[kind] || kind;
  return p.replace(/\\+$/, '') + '\\' + sub;
}

/** 目标目录下这个子目录是否已存在内容（probeDirs 的结果） */
function probeHit(diskProbe, path) {
  if (!diskProbe || !Array.isArray(diskProbe.results)) return null;
  const want = normalizePath(path).toLowerCase();
  return (
    diskProbe.results.find((r) => normalizePath(r?.path).toLowerCase() === want) || null
  );
}

/** 安装信息的真实目录（只有它落盘了才算数：不能凭"设置里写了"就当成已安装） */
function installedDirOf(snap, kind) {
  const kindInfo = kind === 'maibot' ? snap?.maibot : snap?.snowluma;
  const dir = str(kindInfo?.dir);
  if (!dir) return '';
  if (kindInfo?.ok === false) return '';
  if (kind !== 'maibot') return kindInfo?.kind === 'snowluma' ? dir : '';
  if (kindInfo?.kind !== 'maibot') return '';
  /* 版本识别给了明确结论才认（unknown = 目录在但判不出是不是 MaiBot，不算已装） */
  const vk = str(snap?.maibotVersion?.kind);
  if (vk && vk !== 'supported' && vk !== 'unsupported') return '';
  return dir;
}

/** 服务是否在跑（services 来自 getServicesStatus，进程注册表同步读） */
function runningOf(snap, key) {
  const list = Array.isArray(snap?.running) ? snap.running : [];
  return list.some((s) => s && s.key === key && s.running);
}

/* ============================================================================
 *  第 1 步：环境体检 —— 逐项给真实结果
 * --------------------------------------------------------------------------
 *  来源：
 *    Python / Git / uv / Node → env:detect-tools（真实 spawn 版本命令，
 *      Python 还会真正比较 3.12 这条线，不是"命令能跑就算过"）
 *    磁盘可用空间 → system:disk-space（fs.statfs 等价物，读不到就如实说读不到）
 *    目录归属 → env:detect-kind（复用 scanner 的判定）
 *  不许编造：拿不到的工具项显示"检测不到"，tone 给 warn 而不是 ok。
 * ========================================================================== */
function buildEnvStep(snap) {
  const tools = snap?.tools || null;
  const disk = snap?.disk || null;
  const py = tools?.python || null;
  const git = tools?.git || null;
  const uv = tools?.uv || null;

  const facts = [];
  const missing = [];

  if (!tools) {
    facts.push(fact('还没做工具链检测（点「重新体检」）', 'warn'));
  } else {
    /* Python：found 与 ok 必须分开说 —— 3.10 也能跑，但官方要求 3.12+ */
    if (!py?.found) {
      facts.push(fact(py?.message || '没有找到 Python', 'err'));
      missing.push('python');
    } else if (py?.ok) {
      facts.push(fact(`Python ${py.version}（满足 3.12+）`, 'ok'));
    } else {
      facts.push(fact(py?.message || `Python ${py.version} 版本过低`, 'err'));
      missing.push('python');
    }

    if (git?.ok) facts.push(fact(`Git ${git.version}`, 'ok'));
    else {
      facts.push(fact(git?.message || '没有找到 Git', 'err'));
      missing.push('git');
    }

    /* uv 是官方推荐但非必需 —— 缺了给 warn，不能报成阻断 */
    if (uv?.ok) facts.push(fact(`uv ${uv.version}`, 'ok'));
    else {
      facts.push(
        fact(`${uv?.message || '没有找到 uv'}（可选：缺了就用 pip 装依赖）`, 'warn')
      );
    }
  }

  /* 磁盘：读不到就明说读不到，不假装充足 */
  const need = Number(snap?.minFreeBytes) > 0 ? Number(snap.minFreeBytes) : MIN_FREE_BYTES;
  if (!disk || disk.ok === false) {
    facts.push(
      fact(
        disk?.message
          ? `无法读取磁盘可用空间：${disk.message}`
          : '还没有读取磁盘可用空间',
        'warn'
      )
    );
  } else {
    const free = Number(disk.freeBytes) || 0;
    facts.push(fact(`可用空间 ${humanSize(free)}（建议 ≥ ${humanSize(need)}）`, free >= need ? 'ok' : 'err'));
    if (free < need) missing.push('disk');
  }

  const blocked = missing.length > 0;
  return {
    id: DEPLOY_IDS.env,
    title: '环境体检',
    status: blocked ? STATUS_BLOCKED : tools ? STATUS_DONE : STATUS_READY,
    summary: blocked
      ? `还差 ${missing.length} 项，按下面的「去安装」补齐再体检`
      : tools
        ? 'Python / Git / uv / 磁盘都读到了真实版本'
        : '还没开始体检',
    why:
      '官方 Windows 部署要求 Python 3.12+ 与 Git；uv 是官方推荐的依赖管理工具。' +
      '这几样缺一个都会在后面完全想不到的地方报错，所以先查清楚。' +
      '这里的每一项都是真的去跑命令 / 读磁盘得到的，不是默认值。',
    facts,
    next: blocked
      ? '缺什么装什么：Python 装 3.12 以上，Git 用安装器默认选项即可；装完回来点「重新体检」。uv 没装不影响，依赖会用 pip 装。'
      : '工具链齐了，下一步选安装位置。',
    /* 只跳转/打开，不改任何文件 */
    actions: [
      {
        key: 'env-python',
        kind: 'external',
        label: '下载 Python 3.12+',
        icon: 'link',
        url: 'https://www.python.org/downloads/'
      },
      {
        key: 'env-git',
        kind: 'external',
        label: '下载 Git',
        icon: 'link',
        url: 'https://git-scm.com/downloads'
      },
      {
        key: 'env-uv',
        kind: 'external',
        label: '安装 uv（可选）',
        icon: 'link',
        url: 'https://docs.astral.sh/uv/getting-started/installation/'
      },
      { key: 'env-recheck', kind: 'refresh', label: '重新体检', icon: 'refresh', primary: blocked }
    ]
  };
}

/* ============================================================================
 *  第 2 步：选安装位置
 * --------------------------------------------------------------------------
 *  来源：
 *    settings:get / store.draft → 已保存的 maibotDir / snowlumaDir
 *    scan:installations / github:probe-dirs → 磁盘上真实的目录占用
 *    paths:user-data → 启动器自己的数据目录（默认值的依据）
 *  关键：**检测到已有安装就不再默认覆盖**，默认动作变成「复用」。
 * ========================================================================== */
function buildDirStep(snap) {
  const target = normalizePath(snap?.targetDir);
  const v = validateTargetDir(target);
  const mbDir = installedDirOf(snap, 'maibot');
  const slDir = installedDirOf(snap, 'snowluma');
  const mbTarget = target ? installDirFor(target, 'maibot') : '';
  const probe = snap?.diskProbe || null;
  const mbHit = mbTarget ? probeHit(probe, mbTarget) : null;

  const facts = [];
  let status = STATUS_READY;
  let summary = '';
  let next = '';

  if (mbDir) {
    /* 已经有一份真的装好的 MaiBot：默认复用，不覆盖 */
    status = STATUS_DONE;
    facts.push(fact(`已检测到 MaiBot ${str(snap?.maibotVersion?.version) || ''}：${mbDir}`, 'ok'));
    summary = '已检测到现成的 MaiBot，直接复用它（不覆盖）';
    next =
      '这台机器上已经有一份可用的 MaiBot，**不需要重新下载**。' +
      '如果你就想用它，跳过「安装麦麦」直接去准备依赖；想换一份全新的，' +
      '才需要在这里填一个新的父目录（例如 D:\\MaiBot）。';

    /*
      目标目录里已有内容时必须说清"点安装会换成新的"，
      但**已经检测到安装**时不能只说前半句 —— 那会被读成"要覆盖掉你现在这份"，
      而实际上当前这份就是它（复用的那条路径）。
      所以把结论写全：先说是哪一份，再说换版本会发生什么。
    */
    const sameParts = target
      ? normalizePath(mbDir).toLowerCase().split('\\').filter(Boolean)
      : [];
    const targetParts = target.toLowerCase().split('\\').filter(Boolean);
    const sharesTarget = target && sameParts.slice(0, targetParts.length).join('\\') === targetParts.join('\\');
    if (target && sharesTarget) {
      facts.push(
        fact(
          `${mbTarget} 就是启动器正在用的这一份（「安装」会换成新下载的版本并保留旧目录为备份）`,
          'ok'
        )
      );
    } else if (mbTarget && probeHit(probe, mbTarget)?.exists && !probeHit(probe, mbTarget)?.empty) {
      facts.push(
        fact(
          `${mbTarget} 已有内容（${probeHit(probe, mbTarget).fileCount} 项），而且**不是**上面识别出的那一份 —— 「安装」会把它整体替换且不留备份`,
          'err'
        )
      );
    }
  } else {
    facts.push(fact('磁盘上还没检测到可用的 MaiBot 安装', 'warn'));
    summary = target ? `将装到 ${mbTarget}` : '还没选安装位置';
  }

  if (mbHit && mbHit.exists && !mbHit.empty && !mbDir) {
    facts.push(
      fact(
        `${mbHit.path} 已有内容（${mbHit.fileCount} 项）—— 「安装」会整体替换且不留备份`,
        'err'
      )
    );
  } else if (!mbDir && mbTarget) {
    facts.push(fact(`${mbTarget} ${mbHit ? '不存在或为空，可以安全安装' : '状态未探测'}`, mbHit ? 'ok' : 'warn'));
  }

  if (slDir) {
    facts.push(fact(`已检测到 SnowLuma（可选组件）：${slDir}`, 'ok'));
  } else {
    facts.push(fact('没有检测到 SnowLuma —— 它是可选组件，装不装都不影响麦麦先跑起来', 'warn'));
  }

  if (target && v.level === 'block') {
    status = STATUS_BLOCKED;
    facts.push(fact(v.message, 'err'));
    next = '这个位置不能用，点「选择目录」换一个普通数据目录（例如 D:\\MaiBot）。';
  } else if (target && v.level === 'warn') {
    facts.push(fact(v.message, 'warn'));
  }

  /*
    默认值必须给理由（用户要求）。
    理由链：优先复用启动器自己的数据目录所在盘 —— 它一定存在、且是启动器有权写的地方；
    用户数据目录读不到时才退回"已保存过的目录的盘根"。
  */
  const suggested = str(snap?.suggestedTarget);

  if (!target) {
    next = suggested
      ? `还没选位置。推荐直接用 ${suggested} —— 它在启动器自己的数据目录旁边（一定存在、不需要管理员权限），` +
        '点「使用推荐位置」即可；想装在别的盘就点「选择目录」。'
      : '还没选位置。点「选择目录」挑一个普通数据目录（例如 D:\\MaiBot），不要选 C:\\Windows、C:\\Program Files 这类系统位置。';
  } else if (!next) {
    next = `位置已填好：${mbTarget}。点「安装麦麦」开始下载，或先确认这个位置对不对。`;
  }

  const actions = [];
  if (suggested && normalizePath(suggested) !== target) {
    actions.push({ key: 'dir-suggest', kind: 'use-suggested', label: '使用推荐位置', icon: 'wand', primary: !target });
  }
  actions.push({ key: 'dir-pick', kind: 'pick-dir', label: target ? '换一个目录' : '选择目录', icon: 'folder', primary: Boolean(target) });
  actions.push({ key: 'dir-scan', kind: 'route', label: '扫描本机已有安装', icon: 'scan', hash: '#/' });

  return {
    id: DEPLOY_IDS.dir,
    title: '选安装位置',
    status,
    summary,
    why:
      '安装位置决定两件事：文件落在哪，以及**启动器下次去哪找它**。' +
      '默认推荐启动器数据目录旁边，是因为那里一定存在、不需要管理员权限。' +
      '已经检测到安装时，默认动作是复用而不是覆盖 —— 覆盖会连配置和登录态一起换掉。',
    facts,
    next,
    suggested,
    target,
    resolve: mbTarget,
    actions
  };
}

/* ============================================================================
 *  第 3 步：安装麦麦
 * --------------------------------------------------------------------------
 *  来源：env:detect-kind / env:detect-maibot-version（真实读目录与 pyproject.toml）
 *       下载进度 → 主进程按下载标签广播的 subscribeDownload
 *  已装好就是 done；没装好时说清"点下去会发生什么、失败后在哪一步停"。
 * ========================================================================== */
function buildInstallStep(snap) {
  const mbDir = installedDirOf(snap, 'maibot');
  const v = snap?.maibotVersion || null;
  const adapter = v?.adapter || null;
  const facts = [];
  let status = STATUS_READY;
  let summary = '';
  let next = '';

  if (mbDir) {
    status = STATUS_DONE;
    const versionText = str(v?.version) || '（版本号读不出来）';
    facts.push(fact(`MaiBot ${versionText} 已就位：${mbDir}`, 'ok'));
    if (v?.kind === 'unsupported') {
      facts.push(fact(v.message || '这个版本不受支持', 'err'));
    }
    summary = `已安装 MaiBot ${versionText}`;
    next = '麦麦的源码已经在磁盘上了，下一步是把它要用的依赖装齐。';
  } else if (snap?.maibot?.dir && snap?.maibot?.ok !== false && snap?.maibot?.kind !== 'maibot') {
    facts.push(fact(snap.maibot.message || '这个目录看起来不是 MaiBot', 'err'));
    summary = '目录里没有可用的 MaiBot';
    next = '扫描本机已有的麦麦安装，或回上一步换一个干净目录。';
  } else {
    facts.push(fact('还没有安装 MaiBot', 'warn'));
    facts.push(fact('安装流程：下载源码归档 → 校验 → 解压 → 原子替换（失败会回滚）', ''));
    summary = '还没安装';
    next =
      '点「安装麦麦」开始。整个过程会显示真实的下载/校验/解压阶段；' +
      '失败时按钮下方会写明停在哪一步、磁盘上现在是什么状态，可以直接重试。';
  }

  /* 适配器是"能不能接通 QQ"的一半，但它不属于"能不能跑起来"，所以只提示不给红灯 */
  if (mbDir) {
    if (adapter && adapter.kind === 'official') {
      facts.push(fact(`适配器插件「${adapter.name}」${adapter.version ? ' v' + adapter.version : ''} 已就位`, 'ok'));
    } else if (adapter && adapter.kind === 'fork') {
      facts.push(fact(`检测到的是社区分支「${adapter.name}」，不是官方那份（接线时配置版本不同）`, 'warn'));
    } else {
      facts.push(fact('没有检测到 SnowLuma 适配器插件（接 QQ 时才需要，不挡安装）', 'warn'));
    }
  }

  return {
    id: DEPLOY_IDS.install,
    title: '安装麦麦',
    status,
    summary,
    why:
      '推荐走启动器的安装通道：它按 Release 取源码、逐个文件上报进度，' +
      '下载完做校验、解压到临时目录后原子替换，失败会回滚 —— ' +
      '而不是把半个目录留在你的磁盘上。',
    facts,
    next,
    actions: [
      {
        key: 'ins-go',
        kind: 'install-maibot',
        label: mbDir ? '重新安装 / 换版本' : '安装麦麦',
        icon: 'download',
        primary: !mbDir
      },
      { key: 'ins-docs', kind: 'external', label: '官方部署文档', icon: 'info', url: 'https://docs.mai-mai.org/manual/deployment/windows' }
    ]
  };
}

/* ============================================================================
 *  第 4 步：依赖 / 环境准备
 * --------------------------------------------------------------------------
 *  来源：prereq:check-deps（读安装目录的 requirements.txt / pyproject.toml 后
 *        真的去探测每个模块能不能 import），mode=quick 约 0.3s
 *  按检查结果驱动：缺什么装什么；全齐就是 done，不重复装。
 * ========================================================================== */
function buildDepsStep(snap) {
  const mbDir = installedDirOf(snap, 'maibot');
  const deps = snap?.deps || null;
  const py = snap?.tools?.python || null;
  const facts = [];
  let status = STATUS_READY;
  let summary = '';
  let next = '';

  if (!mbDir) {
    status = STATUS_BLOCKED;
    facts.push(fact('还没安装麦麦，依赖检查没有对象', 'warn'));
    summary = '等麦麦装好再检查依赖';
    next = '先回上一步把麦麦装上，这一步会自动读出它的 requirements 清单。';
  } else if (!py?.found) {
    status = STATUS_BLOCKED;
    facts.push(fact('没有找到 Python，无法检查/安装依赖', 'err'));
    summary = '缺 Python';
    next = '先装 Python 3.12+（第 1 步有下载入口），装完回来重新体检。';
  } else if (!deps) {
    facts.push(fact('还没检查依赖（进这一页会自动跑一次快速检查）', 'warn'));
    summary = '还没检查依赖';
    next = '点「检查依赖」看缺什么。快速检查只判断模块能不能导入，约 0.3 秒。';
  } else if (deps.ok === false && !Array.isArray(deps.dependencies)) {
    facts.push(fact(deps.message || '依赖检查失败', 'err'));
    summary = '依赖检查失败';
    next = '按上面的原因处理后在终端里确认；也可以直接点「重新检查」。';
  } else {
    const list = Array.isArray(deps.dependencies) ? deps.dependencies : [];
    const miss = list.filter((d) => !d.ok);
    facts.push(fact(`依赖清单来源：${str(deps.source) || '未标注'}（${deps.mode === 'full' ? '完整检查' : '快速检查'}）`, ''));
    facts.push(fact(`${list.length - miss.length}/${list.length} 已满足`, miss.length ? 'warn' : 'ok'));
    if (miss.length) {
      facts.push(fact(`缺少：${miss.map((d) => d.name).join('、')}`, 'err'));
    }
    if (!list.length) {
      summary = '读不到依赖清单';
      next =
        '安装目录里没有 requirements.txt / pyproject.toml —— 先确认麦麦装完整了，' +
        '或者用「完整检查」再试一次。';
    } else if (miss.length) {
      summary = `缺 ${miss.length} 个依赖`;
      next =
        '点「安装缺失依赖」，它会用 uv（没有就用 pip）按清单装，过程会实时打印；' +
        '装完自动复查，不需要你自己判断成功与否。';
    } else {
      status = STATUS_DONE;
      summary = `${list.length} 个依赖都满足`;
      next = '依赖齐了，下一步启动服务。';
    }
  }

  return {
    id: DEPLOY_IDS.deps,
    title: '依赖 / 环境准备',
    status,
    summary,
    why:
      '麦麦的源码不等于它能跑：它还依赖几十个 Python 包（数据库、Web 框架、协议库…）。' +
      '缺包的报错通常出现在启动后的第三条日志里、而且看不出是缺包 ——' +
      '所以在这一步按清单一次装齐，比启动后逐条排错快得多。',
    facts,
    next,
    actions: [
      { key: 'dep-check', kind: 'check-deps', label: '检查依赖', icon: 'scan', primary: !deps },
      { key: 'dep-install', kind: 'install-deps', label: '安装缺失依赖', icon: 'download', primary: Boolean(deps && deps.dependencies?.some((d) => !d.ok)) }
    ]
  };
}

/* ============================================================================
 *  第 5 步：启动服务并给出口
 * --------------------------------------------------------------------------
 *  来源：service:status（进程注册表，同步读）、store 里的端口设置、
 *        EULA 状态来自麦麦自己 stdout 里的真实标记（onboarding/eula-prompt.js）
 *  两个出口：麦麦 WebUI（8001）与 SnowLuma WebUI（端口取自设置）。
 *  SnowLuma 没装时**明确说可选**，不能让它看起来像必装项。
 * ========================================================================== */
function buildStartStep(snap) {
  const mbDir = installedDirOf(snap, 'maibot');
  const slDir = installedDirOf(snap, 'snowluma');
  const mbRunning = runningOf(snap, 'maibot');
  const slRunning = runningOf(snap, 'snowluma');
  const eula = snap?.eula || null;
  const ports = snap?.ports || {};
  const webuiPort = Number(ports.maibotWebui) || 8001;
  const slWebuiPort = Number(ports.snowlumaWebui) || 5099;
  const facts = [];
  let status = STATUS_READY;
  let summary = '';
  let next = '';

  if (mbRunning) {
    status = STATUS_DONE;
    summary = '麦麦正在运行';
    facts.push(fact(`MaiBot 进程在运行中 → http://127.0.0.1:${webuiPort}`, 'ok'));
  } else {
    facts.push(fact(mbDir ? 'MaiBot 已装好，但当前没有运行' : 'MaiBot 还没装好，先回第 3 步', mbDir ? 'warn' : 'err'));
    summary = mbDir ? '麦麦还没启动' : '还没安装麦麦';
    next = mbDir
      ? `点「启动麦麦」。启动后终端会打印一行 WebUI 登录 Token（每次冷启动都会变），` +
        `启动器会自动把它读出来给你复制，登录地址 http://127.0.0.1:${webuiPort}。`
      : '先回第 3 步把麦麦装上。';
    if (!mbDir) status = STATUS_BLOCKED;
  }

  /* 首次启动会停在用户协议上等输入 —— 这是最容易"点了启动但什么都没发生"的一步 */
  if (eula?.state === 'need-confirm') {
    status = STATUS_BLOCKED;
    facts.push(fact('麦麦正在等你确认用户协议（终端停在输入那一行）', 'err'));
    next =
      '它现在停在协议确认上，必须由你本人在终端里输入中文「同意」并回车（yes / y 都不行）——' +
      '启动器不替你同意任何条款。点下面的「去终端输入同意」即可。';
  } else if (eula?.state === 'confirmed') {
    facts.push(fact('用户协议已由你确认过，不需要再次输入', 'ok'));
  }

  if (slDir) {
    facts.push(
      fact(
        slRunning
          ? `SnowLuma 正在运行 → http://127.0.0.1:${slWebuiPort}`
          : `SnowLuma 已装好（可选组件），当前未运行 → http://127.0.0.1:${slWebuiPort}`,
        slRunning ? 'ok' : 'warn'
      )
    );
  } else {
    facts.push(fact(`没有安装 SnowLuma —— 它是**可选**的：只跑麦麦/网页端不需要它，接 QQ 时才装`, 'warn'));
  }

  const actions = [];
  if (mbDir) {
    actions.push({
      key: 'st-maibot',
      kind: 'start-service',
      service: 'maibot',
      label: mbRunning ? '重启麦麦' : '启动麦麦',
      icon: 'play',
      primary: true,
      disabled: mbRunning
    });
  }
  if (eula?.state === 'need-confirm') {
    actions.unshift({ key: 'st-eula', kind: 'route', label: '去终端输入同意', icon: 'terminal', primary: true, hash: '#/terminal' });
  }
  if (slDir && !slRunning) {
    actions.push({ key: 'st-snowluma', kind: 'start-service', service: 'snowluma', label: '启动 SnowLuma（可选）', icon: 'play' });
  }
  actions.push({ key: 'st-webui', kind: 'open-webui', label: '打开麦麦 WebUI', icon: 'link', disabled: !mbRunning });
  actions.push({ key: 'st-logs', kind: 'route', label: '看启动日志', icon: 'stream', hash: '#/logs' });

  return {
    id: DEPLOY_IDS.start,
    title: '启动服务，拿到入口',
    status,
    summary,
    why:
      '装好不等于跑起来。这一步真的去拉起进程，并把两个出口摆出来：' +
      '麦麦的 WebUI（配模型、看日志）与 SnowLuma 的 WebUI（登录 QQ、建 OneBot 连接）。' +
      'SnowLuma 是可选的：只有要接 QQ 才需要它。',
    facts,
    next,
    actions
  };
}

/* ============================================================================
 *  第 6 步：出口清单（部署完成后"我在哪、下一步去哪"）
 * ========================================================================== */
function buildOutStep(snap) {
  const mbRunning = runningOf(snap, 'maibot');
  const slDir = installedDirOf(snap, 'snowluma');
  const adapter = snap?.maibotVersion?.adapter || null;
  const ports = snap?.ports || {};
  const webuiPort = Number(ports.maibotWebui) || 8001;
  const slWebuiPort = Number(ports.snowlumaWebui) || 5099;

  const facts = [
    fact(`麦麦 WebUI：http://127.0.0.1:${webuiPort}（登录 Token 由启动器从日志里读，点上面的按钮复制）`, mbRunning ? 'ok' : 'warn'),
    slDir
      ? fact(`SnowLuma WebUI：http://127.0.0.1:${slWebuiPort}`, 'ok')
      : fact('SnowLuma 未安装（可选）—— 要接 QQ 再装，不接就不需要', 'warn'),
    fact(
      adapter && adapter.kind === 'official'
        ? 'SnowLuma 适配器插件已就位，接下来按引导做 OneBot 接线'
        : '适配器插件还没就位 —— 接线（麦麦 ↔ SnowLuma）那一段在「新手引导」里有逐步说明',
      adapter && adapter.kind === 'official' ? 'ok' : 'warn'
    )
  ];

  return {
    id: DEPLOY_IDS.out,
    title: '出口与后续',
    status: mbRunning ? STATUS_DONE : STATUS_READY,
    summary: mbRunning ? '部署完成，服务在跑' : '服务还没跑起来',
    why:
      '部署的终点不是"文件装好了"，而是"你有地方能进去操作"。' +
      '这一页把入口集中摆出来；接 QQ、配模型、让麦麦回第一句话的完整顺序在「新手引导」里。',
    facts,
    next: mbRunning
      ? '可以开始用了。首次使用建议顺序：登录 WebUI → 配一个 LLM 模型 → （可选）接 SnowLuma 与 QQ。'
      : '先让麦麦跑起来（上一步），再回来看这一页。',
    actions: [
      { key: 'out-guide', kind: 'open-guide', label: '打开新手引导', icon: 'wand', primary: true },
      { key: 'out-logs', kind: 'route', label: '日志页', icon: 'stream', hash: '#/logs' },
      { key: 'out-settings', kind: 'route', label: '设置页', icon: 'sliders', hash: '#/settings' }
    ]
  };
}

/** 字节 → 人读的大小（与安装器页同一口径，避免两处显示不一致） */
export function humanSize(bytes) {
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

/**
 * 构造首跑部署流程。
 *
 * @param {object} snap 真实状态快照（全部来自 IPC / 磁盘，见文件头"来源"注释）
 * @param {object} [opts]
 * @param {string[]} [opts.doneIds] 用户手动标记过的步骤 id
 * @returns {Array} 步骤数组（含派生进度信息）
 */
export function buildDeploySteps(snap = {}, opts = {}) {
  const marked = Array.isArray(opts.doneIds) ? opts.doneIds : [];
  const steps = [
    buildEnvStep(snap),
    buildDirStep(snap),
    buildInstallStep(snap),
    buildDepsStep(snap),
    buildStartStep(snap),
    buildOutStep(snap)
  ];

  /*
    手动标记只对**启动器看不到结论的那一件事**生效：选安装位置。
    其余每一步（装没装、依赖齐没齐、服务在不在跑）都能从磁盘/进程直接读出来，
    一律由事实说了算 —— 包括"启动"这一步：用户上次标记过"已启动"、
    这次进程其实没在跑，就必须显示未完成，否则就是假象。

    ⚠️ 这里曾把「启动」也放进可标记集合，验证脚本当场抓到：
    进程没在跑却显示已完成。这类"看起来配好了"正是本项目要消灭的东西。
  */
  const canBeMarked = (id) => id === DEPLOY_IDS.dir;

  const withDone = steps.map((s) => {
    /*
      blocked 的步骤不接受手动标记：状态是"必须先去处理它"，
      用户点一下"已完成"不能把红灯变成绿灯。
    */
    const manual = s.status !== STATUS_BLOCKED && marked.includes(s.id) && canBeMarked(s.id);
    if (manual && s.status !== STATUS_DONE) {
      /*
        手动标记不改写 status 的事实判断：它只把"该不该继续往下带"这件事
        标成用户说了算，事实行照旧显示真实结果。
      */
      return { ...s, done: true, manual: true };
    }
    return { ...s, done: s.status === STATUS_DONE, manual: false };
  });

  const doneCount = withDone.filter((s) => s.done).length;
  const firstOpen = withDone.find((s) => !s.done) || null;
  return withDone.map((s, i) => ({
    ...s,
    index: i,
    current: firstOpen ? s.id === firstOpen.id : false,
    doneCount,
    total: withDone.length
  }));
}

/** 一句话进度（顶栏/卡片头用） */
export function deploySummary(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;
  const done = list.filter((s) => s.done).length;
  const next = list.find((s) => !s.done) || null;
  return {
    done,
    total,
    pct: total ? Math.round((done / total) * 100) : 0,
    allDone: total > 0 && done === total,
    nextTitle: next ? next.title : '',
    text: total && done === total ? '部署流程已走完' : next ? `下一步：${next.title}` : ''
  };
}

export default { DEPLOY_IDS, buildDeploySteps, deploySummary, validateTargetDir, normalizePath, diskRootOf, installDirFor, humanSize, MIN_FREE_BYTES };
