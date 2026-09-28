/*
================================================================================
技术文档：src/main/services/settings.js
职责：后端设置的读写、校验与原子持久化。
================================================================================
  相对重构前的修正：
    1) writeFileSync 直接覆盖目标文件 —— 若写入过程中断电/崩溃，
       会留下被截断的 JSON，下次启动所有设置丢失。
       现在：先写 .tmp 再 rename（同分区 rename 是原子操作）。
    2) exportBackendSettings(destPath) 不校验入参，遇到 null/undefined 时
       path.dirname(null) 抛 TypeError，且错误直接冒泡成未处理异常。
       现在：显式校验并返回结构化错误。
    3) 无写入节流：前端可能连续多次保存，每次都全量落盘。
       现在：合并短时间内的重复写入。
    4) DEFAULTS 在前端 SettingsPanel.vue 里被复制了一份 —— 改后端默认值
       前端不会同步。现在前端通过 settings:defaults 读取同一份定义。
================================================================================
*/
const fs = require('fs');
const path = require('path');
const { settingsFile, ensureDir, exportDir } = require('../paths');
const { DEFAULT_SETTINGS, DEFAULT_PORTS, DEFAULT_SNOWLUMA_PORTS } = require('../constants');
const logging = require('../logging');

const SETTINGS_SCHEMA_VERSION = 1;

function defaults() {
  /* 深拷贝，避免调用方修改污染常量 */
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

/** 深合并：patch 覆盖 base（对象递归，数组/标量直接替换） */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== 'object') return patch === undefined ? base : patch;

  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 把任意输入规整为合法设置（类型纠正 + 范围钳制） */
function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const merged = deepMerge(defaults(), src);

  /* --- LLM --- */
  merged.llm = merged.llm || {};
  merged.llm.baseUrl = String(merged.llm.baseUrl || '').trim();
  merged.llm.model = String(merged.llm.model || '').trim();
  merged.llm.apiKey = String(merged.llm.apiKey ?? '');
  merged.llm.temperature = clampNumber(merged.llm.temperature, 0, 2, DEFAULT_SETTINGS.llm.temperature);
  merged.llm.maxTokens = clampInt(merged.llm.maxTokens, 1, 200000, DEFAULT_SETTINGS.llm.maxTokens);
  merged.llm.custom = merged.llm.custom || {};
  merged.llm.custom.baseUrl = String(merged.llm.custom.baseUrl || '').trim();
  merged.llm.custom.model = String(merged.llm.custom.model || '').trim();
  merged.llm.custom.apiKey = String(merged.llm.custom.apiKey ?? '');

  /* --- GitHub --- */
  merged.github = merged.github || {};
  merged.github.token = String(merged.github.token ?? '').trim();
  merged.github.repo = String(merged.github.repo || DEFAULT_SETTINGS.github.repo).trim();
  /* 仓库名必须是 owner/name 形式，否则后续拼接 URL 会产生非法地址 */
  if (!/^[\w.-]+\/[\w.-]+$/.test(merged.github.repo)) {
    logging.log('warn', `[settings] 仓库名 "${merged.github.repo}" 格式非法，已回退默认值`);
    merged.github.repo = DEFAULT_SETTINGS.github.repo;
  }
  merged.github.snowlumaRepo = String(
    merged.github.snowlumaRepo || DEFAULT_SETTINGS.github.snowlumaRepo
  ).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(merged.github.snowlumaRepo)) {
    logging.log('warn', `[settings] SnowLuma 仓库名 "${merged.github.snowlumaRepo}" 格式非法，已回退默认值`);
    merged.github.snowlumaRepo = DEFAULT_SETTINGS.github.snowlumaRepo;
  }
  merged.github.useMirror = Boolean(merged.github.useMirror);
  /*
    下载并发数（"多线程下载"）。
    ────────────────────────────────────────────────────────────────
    0 = 按文件大小自动（4~8 段），1 = 强制单连接，2~8 = 指定并发数。
    为什么要夹上限：设置文件是用户可以直接编辑的纯文本，
    里面写个 999 不该让启动器真的开 999 条连接 ——
    那会把镜像站和自家网络一起打死，属于"用户自己造成的拒绝服务"。
    上限在 github.js 的 resolveSegmentCount 里也会再夹一次，两处都挡。
  */
  merged.github.downloadThreads = clampInt(merged.github.downloadThreads, 0, 8, 0);

  /* --- 服务 --- */
  merged.service = merged.service || {};
  merged.service.pythonPath = String(merged.service.pythonPath || 'python').trim() || 'python';
  merged.service.maibotDir = normalizeDir(merged.service.maibotDir);
  merged.service.ports = merged.service.ports || {};

  /*
    一次性迁移：剥掉"QQ 注入式协议端"留下的配置。
    ────────────────────────────────────────────────────────────────
    上一版把这块协议端做成了与 SnowLuma 并列的后端（还带"快速登录"免扫码），
    用户明确要求抛弃它、只用 SnowLuma。功能删了，配置里的键也必须一起清掉，
    否则会留下三件坏事：
      · 设置文件里永远躺着几个没有任何代码读的键，看起来像"还能用"；
      · 校验层会因为"不认识这些键"每启动一次刷一条警告（用户已经抱怨过这个）；
      · ports.napcat=3001 会被界面当成一个真实存在的端口去显示。

    下面这些键一律剥掉（不迁移、不保留）：
      napcatDir / napcatQuickLogin / qqBackend / github.napcatRepo / ports.napcat
  */
  const LEGACY_QQ_BACKEND_KEYS = ['napcatDir', 'napcatQuickLogin', 'qqBackend'];
  const removedLegacy = [];
  for (const key of LEGACY_QQ_BACKEND_KEYS) {
    if (key in merged.service) {
      delete merged.service[key];
      removedLegacy.push(`service.${key}`);
    }
  }
  if ('napcatRepo' in merged.github) {
    delete merged.github.napcatRepo;
    removedLegacy.push('github.napcatRepo');
  }
  if ('napcat' in merged.service.ports) {
    delete merged.service.ports.napcat;
    removedLegacy.push('service.ports.napcat');
  }
  if (removedLegacy.length) {
    /* 只记一条 info：这是正常的版本升级，不是用户配错了。
       不额外留"迁移标记"字段 —— 那会变成一个没人认识的键，
       而且下次读取时清掉它又会触发一次写盘，纯属自找麻烦。 */
    logging.log(
      'info',
      `[settings] 已移除 QQ 注入式协议端的遗留配置（协议端现在只有 SnowLuma）：${removedLegacy.join('、')}`
    );
  }

  /*
    一次性迁移：修掉早期版本写进用户配置里的**错误**默认端口。
    ────────────────────────────────────────────────────────────────
    · webui: 8090 → 8001
        8090 是早期**前端硬编码**的 DEFAULTS.ports.webui，凭空多出来的值。
        8090 实际是 MaiBot 的 **API Server** 端口（bot_config.toml 的
        api_server_port）；而 ports.webui 的唯一消费方是总览页的「打开 WebUI」
        按钮，它必须指向 **MaiBot 自己的 WebUI**，实测默认是 8001
        （startup_bindings.py:24 `_DEFAULT_WEBUI_BIND_ADDRESS`）。
        以前这里迁移到 6099 是错的 —— 那是 QQ 注入式协议端的 WebUI 端口，
        会打开一个连不上的地址。协议端删掉后改回正确的 8001。
    · webui: 6099 → 8001
        上一版迁移留下的值，同样指向已经删掉的协议端，一并纠正。

    为什么这里要**替用户改**，而不是只提示：
      这两个值都不是用户自己选的偏好，而是被我们写坏的默认值 ——
      用户从未主动设置过它们。所以只针对"恰好等于那个已知错误常量"的
      情况做精确迁移；用户自己填的任何其它值一律不动。

    迁移会写日志，并在设置里留下标记，保证可追溯（下次读取时自动清除）。
  */
  const STALE_PORTS = {
    webui: { bad: [8090, 6099], why: 'MaiBot WebUI 端口（旧值是 QQ 注入式协议端的端口，已废弃）' }
  };
  const migrated = [];
  for (const [key, info] of Object.entries(STALE_PORTS)) {
    if (info.bad.includes(Number(merged.service.ports[key]))) {
      logging.log(
        'warn',
        `[settings] 端口 ${key}=${merged.service.ports[key]} 是早期版本的错误默认值，已迁移为 ${DEFAULT_PORTS[key]}（${info.why}）`
      );
      merged.service.ports[key] = DEFAULT_PORTS[key];
      migrated.push(`${key}: ${info.bad.join('/')} → ${DEFAULT_PORTS[key]}`);
    }
  }
  if (migrated.length) merged.service.portsMigrated = migrated;
  /*
    迁移标记是一次性的：值已经对了就清掉，避免这个临时字段
    永久留在用户配置文件里变成垃圾（用户看不出它是什么）。
  */
  else delete merged.service.portsMigrated;

  for (const key of Object.keys(DEFAULT_PORTS)) {
    merged.service.ports[key] = clampInt(merged.service.ports[key], 1, 65535, DEFAULT_PORTS[key]);
  }
  merged.service.startupTimeoutMs = clampInt(
    merged.service.startupTimeoutMs,
    1000,
    120000,
    DEFAULT_SETTINGS.service.startupTimeoutMs
  );
  merged.service.autoRestartLimit = clampInt(
    merged.service.autoRestartLimit,
    0,
    10,
    DEFAULT_SETTINGS.service.autoRestartLimit
  );

  /*
    --- SnowLuma（现在唯一的协议端）---
    全部给默认值，保证旧设置文件读进来也能直接用。
  */
  merged.service.snowlumaDir = typeof merged.service.snowlumaDir === 'string'
    ? merged.service.snowlumaDir.trim()
    : '';
  const SNOWLUMA_PORT_DEFAULTS = DEFAULT_SNOWLUMA_PORTS;

  merged.service.snowlumaPorts = merged.service.snowlumaPorts || {};
  for (const key of Object.keys(SNOWLUMA_PORT_DEFAULTS)) {
    merged.service.snowlumaPorts[key] = clampInt(
      merged.service.snowlumaPorts[key],
      1,
      65535,
      SNOWLUMA_PORT_DEFAULTS[key]
    );
  }

  /* --- 通用 --- */
  merged.general = merged.general || {};
  merged.general.autoStart = Boolean(merged.general.autoStart);
  merged.general.launchOnLogin = Boolean(merged.general.launchOnLogin);
  /* 默认开启：读取不到时（旧设置文件）按"要通知"处理 */
  merged.general.desktopNotify =
    merged.general.desktopNotify === undefined
      ? DEFAULT_SETTINGS.general.desktopNotify
      : Boolean(merged.general.desktopNotify);

  /*
    界面主题偏好（UI v3）。
    'system' 是默认值（跟随 Windows）；'light' / 'dark' 是用户的手动选择。
    这里必须显式归一化：设置文件是用户可以直接编辑的纯文本，
    里面写成 "Dark" / "深色" / 空串时，主进程的 theme:get 会退化成
    "跟随系统"，但磁盘上会一直躺着一个没人认识的非法值 ——
    与 ports / scanRoots 一样，在读取层收敛成合法取值并写回。
  */
  if (!['light', 'dark', 'system'].includes(merged.general.theme)) {
    merged.general.theme = DEFAULT_SETTINGS.general.theme;
  }

  /*
    自定义扫描根目录。
    校验要点：
      1) 只接受非空字符串，去重（同一目录写两遍会让扫描跑两遍）。
      2) 拒绝裸盘符根（'C:\\'）—— 全盘扫描会挂住很久且几乎必然误报，
         这条限制在 scanner.defaultRoots() 里也有，两处一致。
      3) 数量上限 12：界面上的列表也要保持可读。
  */
  merged.general.scanRoots = Array.isArray(merged.general.scanRoots)
    ? Array.from(
        new Set(
          merged.general.scanRoots
            .map((p) => String(p || '').trim())
            .filter((p) => p && !/^[a-zA-Z]:[\\/]?$/.test(p))
        )
      ).slice(0, 12)
    : [];

  merged.general.logRetentionLines = clampInt(
    merged.general.logRetentionLines,
    200,
    20000,
    DEFAULT_SETTINGS.general.logRetentionLines
  );

  merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return merged;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 统一目录写法：去尾部斜杠，空串保持为空 */
function normalizeDir(value) {
  const s = String(value || '').trim();
  return s.replace(/[\\/]+$/, '');
}

/** 读取设置（带默认值 + 类型纠正） */
function getBackendSettings() {
  const file = settingsFile();
  if (!fs.existsSync(file)) return defaults();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const clean = sanitize(parsed);

    /*
      自愈：如果校验真的改动了内容（手工编辑、旧版本遗留、或写过非法值），
      就把修正后的结果写回磁盘。

      为什么需要：
        getBackendSettings() 只在**内存**里清洗。若磁盘上留着
        `scanRoots: ["C:\\", "D:", ""]` 或 `logRetentionLines: 999999`，
        运行期一切正常（用的是清洗后的值），但用户打开配置文件会看到一堆
        非法项，也无从知道"以哪份为准"。让磁盘与运行期一致，避免二义性。

      只在内容确实变化时写，避免每次启动都无谓地落盘。
    */
    if (JSON.stringify(clean) !== JSON.stringify(parsed)) {
      try {
        writeSettingsFile(clean);
        logging.log('info', '[settings] 检测到非法/过期配置项，已按校验规则修正并写回');
      } catch (e) {
        /* 写回失败不影响本次读取：内存里已经是清洗后的值 */
        logging.log('warn', `[settings] 配置自愈写回失败（不影响本次运行）: ${e.message}`);
      }
    }

    return clean;
  } catch (e) {
    logging.log('error', `[settings] 解析失败，已回退默认值: ${e.message}`);
    /* 保留损坏文件供排查，而不是静默覆盖 */
    try {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      logging.log('warn', `[settings] 损坏的设置已备份至 ${backup}`);
    } catch (_) {
      /* 备份失败不影响回退 */
    }
    return defaults();
  }
}

/** 待写入缓冲（短时间内的多次保存合并成一次落盘） */
let pendingWrite = null;
let writeTimer = null;
const WRITE_DEBOUNCE_MS = 120;
/*
  最近一次延迟写盘的失败。
  ──────────────────────────────────────────────────────────────────────
  为什么必须有这个字段：
    非 immediate 的 saveBackendSettings 是"先返回 {ok:true}，120ms 后落盘"。
    原实现里那个 setTimeout 回调没有 try/catch，而 writeSettingsFile 会 throw
    （磁盘满 / 权限不足 / 目录被占用）—— 定时器里的异常没有任何调用方可以接，
    直接冒泡成 uncaughtException。后果是：界面显示"已保存"，文件却没有变化，
    用户重启后发现设置全丢，且日志里只有一条和操作对不上号的未捕获异常。
  现在：定时器内 try/catch，把失败记在这里；下一次 save 时以
  {ok:false, message} 如实上报一次（报完清空，避免反复骚扰）。

  ⚠️ 上报点只有 save 家族（settings:save / theme:set / reset）与 flushSettings()，
  **不包括 getBackendSettings()**：那个函数的返回形状就是设置对象本身
  （几十个调用方直接当 settings 用），硬塞一个 ok:false 进去会把它变成
  "读设置失败"的语义，反而制造新的形状错配 —— 那是这个项目已经踩过的坑。
  代价是"只读不写"的用户要等到下次保存才会看到上一次写失败，
  相比原来的"静默丢设置 + uncaughtException"已经是可接受的折中。
*/
let pendingWriteError = null;

/**
 * 取出并清除"上一次延迟写盘失败"。
 *
 * 语义是"上报一次就够"：设置页保存后一般还会再拉一次 settings:get，
 * 两条路都会带上这个错误；谁先取到谁负责告诉用户，之后就不再重复刷屏。
 */
function takePendingWriteError() {
  const err = pendingWriteError;
  pendingWriteError = null;
  return err;
}

/** 统一的延迟落盘动作：内部消化异常，绝不从定时器里抛出去 */
function flushPendingWrite() {
  const data = pendingWrite;
  pendingWrite = null;
  if (!data) return;
  try {
    writeSettingsFile(data);
    /* 这次成功了，上一次的失败记录已经没有参考价值 */
    pendingWriteError = null;
  } catch (e) {
    /*
      这里是原来 uncaughtException 的来源。
      宁可"记下来 + 下次如实上报"，也不能让一个定时器回调把主进程打崩。
    */
    pendingWriteError = e.message || String(e);
    logging.log('error', `[settings] 延迟写盘失败（会在下次保存/flushSettings 时上报）: ${pendingWriteError}`);
  }
}

/**
 * 保存设置（合并 + 校验 + 原子写）。
 * @param {object} patch
 * @param {{immediate?:boolean}} [opts]
 */
function saveBackendSettings(patch, opts = {}) {
  const current = getBackendSettings();
  const merged = sanitize(deepMerge(current, patch || {}));

  if (opts.immediate) {
    writeSettingsFile(merged);
    pendingWriteError = null;
    return { ok: true, path: settingsFile(), settings: merged };
  }

  pendingWrite = merged;
  if (!writeTimer) {
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flushPendingWrite();
    }, WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
  }

  /*
    本次请求本身没问题（合并、校验都过了），正常情况下回 ok:true；
    但若上一次延迟写盘失败过，这里必须改成 ok:false 并带上原因 ——
    否则用户连续保存两次，第一次的失败就被第二次的 {ok:true} 永久盖掉了
    （这正是原实现"界面说已保存、文件却没变"的成因，所以宁可这次保守地报失败）。
    代价：调用方看到的 ok:false 描述的是"上一次"的失败，message 里已写清，
    并保证只上报一次（takePendingWriteError 取完即清）。
  */
  const previousError = takePendingWriteError();
  if (previousError) {
    return {
      ok: false,
      path: settingsFile(),
      settings: merged,
      message: `上一次设置未能写入磁盘：${previousError}`
    };
  }
  return { ok: true, path: settingsFile(), settings: merged };
}

/** 立即落盘（退出前调用，确保缓冲不丢） */
function flushSettings() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  /*
    退出路径同样不能抛：这个函数在 app 退出流程里被调用，
    抛出去会让"杀子进程 / 落盘日志"这些收尾步骤全部中断。
    失败必须被如实返回（而不是吞掉），由调用方决定要不要提示。
  */
  if (pendingWrite) flushPendingWrite();
  return { ok: !pendingWriteError, message: pendingWriteError || undefined };
}

/** 原子写：写临时文件 → rename 覆盖 */
function writeSettingsFile(data) {
  const file = settingsFile();
  const tmp = `${file}.tmp`;
  try {
    ensureDir(file, { asFile: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    logging.log('error', `[settings] 写入失败: ${e.message}`);
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* 忽略清理失败 */
    }
    throw new Error(`设置保存失败: ${e.message}`);
  }
}

/**
 * 导出设置到指定文件。
 *
 * 安全边界（三条，缺一不可）：
 *   1) 只允许写进用户文档 / 下载 / 桌面 / 启动器自己的导出目录。
 *      原来只校验"绝对路径 + .json 结尾"，等于渲染层只要能传一个字符串，
 *      就能往任意位置落一个 JSON（开机自启目录、其它应用的配置目录……
 *      见 item 11）。这是主进程侧的最终防线，渲染层再怎么校验都不能替代它。
 *   2) 导出内容对 github.token / llm.apiKey / llm.custom.apiKey 脱敏 ——
 *      导出物的用途是备份/求助/贴给他人，明文密钥会随文件离开这台机器。
 *   3) 仍然允许覆盖已存在的 .json 文件：渲染侧的调用方走 saveFileDialog，
 *      用户**故意**选一个已有文件覆盖是正常需求（"重新导出一份最新的"），
 *      直接拒绝反而会把正常操作变成失败。真正的风险是"能写到哪"，
 *      不是"能不能覆盖"，所以这里用目录白名单收口，而不是拒绝覆盖。
 *
 * @param {string} destPath 必须是绝对路径、以 .json 结尾、且位于允许目录内
 */
function exportBackendSettings(destPath) {
  if (typeof destPath !== 'string' || !destPath.trim()) {
    return { ok: false, message: '导出路径无效' };
  }
  const target = destPath.trim();
  if (!path.isAbsolute(target)) {
    return { ok: false, message: '导出路径必须是绝对路径' };
  }
  if (!/\.json$/i.test(target)) {
    return { ok: false, message: '导出文件必须以 .json 结尾' };
  }

  const allowed = resolveExportAllowedRoots();
  if (!allowed.length || !isInsideAny(target, allowed)) {
    logging.log('warn', `[settings] 拒绝导出到允许目录之外: ${target}`);
    return {
      ok: false,
      message: `出于安全考虑，只能导出到「文档」「下载」「桌面」或启动器的导出目录（${exportDir()}）`
    };
  }

  try {
    ensureDir(target, { asFile: true });
    const settings = redactSecretsForExport(getBackendSettings());
    fs.writeFileSync(target, JSON.stringify(settings, null, 2), 'utf8');
    logging.log('info', `[settings] 已导出设置（凭据已脱敏）→ ${target}`);
    return { ok: true, path: target, message: '已导出（API Key / Token 已脱敏）' };
  } catch (e) {
    return { ok: false, message: `导出失败: ${e.message}` };
  }
}

/**
 * 允许导出到的根目录。
 *
 * 用 Electron 的 app.getPath 而不是硬编码 `C:\Users\...`：
 * 用户名、漫游目录（OneDrive 重定向）、多语言系统目录名各不相同。
 * Electron 不可用（脚本/单测环境）时静默跳过对应的根目录，
 * 只保留启动器自己的导出目录 —— 与 github.js 里 require('electron') 的写法一致。
 */
function appPath(name) {
  try {
    const app = require('electron').app;
    if (!app || typeof app.getPath !== 'function') return '';
    const p = app.getPath(name);
    return typeof p === 'string' ? p : '';
  } catch (e) {
    logging.log('warn', `[settings] 读取系统目录 ${name} 失败（导出白名单将跳过它）: ${e.message}`);
    return '';
  }
}

function resolveExportAllowedRoots() {
  const roots = [exportDir(), appPath('documents'), appPath('downloads'), appPath('desktop')];
  return Array.from(new Set(roots.map((p) => safeResolve(p)).filter(Boolean)));
}

/** 解析成绝对路径；失败或为空返回 '' */
function safeResolve(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  try {
    return path.resolve(p);
  } catch (_) {
    return '';
  }
}

/**
 * target 是否位于 roots 中任一目录内。
 *
 * 比较前统一去掉尾部分隔符：否则 `C:\Users\me\Documents` 与
 * `C:\Users\me\Documents\` 会互相判否（github.js:isPathAllowed 的 isUnder 同款处理）。
 * Windows 文件系统大小写不敏感，比较时按小写归一，避免大小写不同被误拒。
 */
function isInsideAny(target, roots) {
  const t = safeResolve(target);
  if (!t) return false;
  const cmp = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const tn = cmp(t.replace(/[\\/]+$/, ''));
  return roots.some((root) => {
    const rn = cmp(String(root).replace(/[\\/]+$/, ''));
    return tn === rn || tn.startsWith(rn.endsWith(path.sep) ? rn : rn + path.sep);
  });
}

/**
 * 导出前的凭据脱敏：保留键名与"是否已配置"的信息，抹掉值本身。
 * 只留后 4 位是为了让用户能辨认"导出的是哪一把 key"，同时又不足以复用。
 */
function redactSecretsForExport(settings) {
  const safe = JSON.parse(JSON.stringify(settings || {}));
  safe.llm = safe.llm || {};
  safe.github = safe.github || {};
  safe.llm.custom = safe.llm.custom || {};
  safe.llm.apiKey = maskSecret(safe.llm.apiKey);
  safe.llm.custom.apiKey = maskSecret(safe.llm.custom.apiKey);
  safe.github.token = maskSecret(safe.github.token);
  return safe;
}

/** 空 → 原样返回空串；非空 → `***` 或 `***` + 末 4 位 */
function maskSecret(value) {
  const s = String(value ?? '');
  if (!s) return '';
  return s.length > 4 ? `***${s.slice(-4)}` : '***';
}

/** 重置为默认值 */
function resetBackendSettings() {
  const def = defaults();
  writeSettingsFile(def);
  return { ok: true, path: settingsFile(), settings: def };
}

module.exports = {
  getBackendSettings,
  saveBackendSettings,
  exportBackendSettings,
  resetBackendSettings,
  flushSettings,
  defaults,
  sanitize,
  /* 供其它导出路径复用同一份脱敏规则（SettingsPanel / verify 脚本） */
  redactSecretsForExport,
  settingsFilePath: settingsFile
};
