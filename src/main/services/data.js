/*
================================================================================
技术文档：src/main/services/data.js
职责：数据目录统计与分类清理。
================================================================================
  相对重构前的修正：
    1) dirSize() 使用 readdirSync + statSync 递归 —— 在主进程里同步遍历整个
       数据目录，目录稍大就会**冻结窗口**（Electron 主进程被阻塞，UI 无响应）。
       现在：fsp 异步遍历 + 并发受限 + 总量上限。
    2) 清理策略不可靠：logs 用文件名排序"保留最新一个"，
       但日志文件名不一定字典序等价于时间序，可能删掉最新的、保留最旧的。
       现在：按 mtime 排序，并支持"保留最近 N 天"的明确策略。
    3) 清理只返回 removed 计数，不校验是否真的删掉（rmSync 失败被静默吞掉）。
       现在：分别统计成功/失败，并如实汇报。
    4) 无进度反馈，大目录统计没有中间状态。
    5) 清理是**真删、不进回收站、也没有预演**：records/models/cache/exports 的
       keepDays=0 意味着"全删"，用户点确认之前看不到到底会删掉多少东西。
       现在：cleanDataCategory(category, { dryRun:true }) 只列清单不删，
       且预演与真删**共用同一份 planClean() 计划** —— 预演说删什么，真删就删什么。
       注意本模块只负责"删自己托管的数据目录"，不碰用户其它文件。
================================================================================
*/
const fsp = require('fs/promises');
const path = require('path');
const logging = require('../logging');
const paths = require('../paths');

/** 数据分类定义 */
const CATEGORIES = [
  {
    key: 'logs',
    label: '运行日志',
    dir: 'logs',
    /** 日志按时间保留最近 N 天，其余删除 */
    keepDays: 7,
    description: '保留最近 7 天的日志文件'
  },
  {
    key: 'models',
    label: '模型文件',
    dir: 'models',
    keepDays: 0,
    description: '全部删除（需重新下载模型）'
  },
  {
    key: 'records',
    label: '聊天记录',
    dir: 'records',
    keepDays: 0,
    description: '全部删除（不可恢复）'
  },
  {
    key: 'cache',
    label: '缓存文件',
    dir: 'cache',
    keepDays: 0,
    description: '全部删除（可自动重建）'
  },
  {
    key: 'exports',
    label: '导出文件',
    dir: 'exports',
    keepDays: 0,
    description: '全部删除'
  }
];

/** 统计限制：避免超大目录把统计过程拖成分钟级 */
const MAX_FILES_PER_CATEGORY = 200000;
const STAT_CONCURRENCY = 16;

/** 预演时最多回传多少个条目名（界面只展示前若干项，完整清单没必要过 IPC） */
const MAX_PREVIEW_ITEMS = 50;

/** 分类 → 绝对目录 */
function categoryDir(cat) {
  /*
    日志分类必须指向**真实的**应用日志目录（paths.appLogDir → userData/logs），
    而不是 dataRoot()/logs。
    这里曾长期错位：logging.js 写 userData/logs/launcher.log，
    而本模块的 'logs' 分类却去统计 userData/maibot-data/logs（永远为空的目录），
    导致「清理运行日志」对真实日志完全无效，且界面上显示的体积恒为 0。
  */
  if (cat.dir === 'logs') return paths.appLogDir();
  return path.join(paths.dataRoot(), cat.dir);
}

/**
 * 并发受限的目录遍历，统计字节数与文件数。
 * @param {string} root
 * @returns {Promise<{bytes:number, files:number, truncated:boolean}>}
 */
async function measureDir(root) {
  let bytes = 0;
  let files = 0;
  let truncated = false;

  /* 工作队列（广度优先，避免深层递归栈） */
  let queue = [root];

  while (queue.length) {
    const batch = queue.splice(0, STAT_CONCURRENCY);
     
    const results = await Promise.all(
      batch.map(async (dir) => {
        try {
          return { dir, entries: await fsp.readdir(dir, { withFileTypes: true }) };
        } catch (_) {
          return { dir, entries: [] }; /* 权限不足或目录消失：跳过 */
        }
      })
    );

    for (const { dir, entries } of results) {
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
        } else if (entry.isFile()) {
          files += 1;
          if (files > MAX_FILES_PER_CATEGORY) {
            truncated = true;
            break;
          }
          try {
            const st = await fsp.stat(full);
            bytes += st.size;
          } catch (_) {
            /* 文件在统计过程中被删除 */
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  return { bytes, files, truncated };
}

/** 人类可读体积 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * 统计各分类占用。
 * @returns {Promise<{ok:boolean, root:string, stats:Array, elapsedMs:number}>}
 */
async function getDataStats() {
  const root = paths.dataRoot();
  const startedAt = Date.now();

  const stats = await Promise.all(
    CATEGORIES.map(async (cat) => {
      const dir = categoryDir(cat);
      let exists = false;
      try {
        const st = await fsp.stat(dir);
        exists = st.isDirectory();
      } catch (_) {
        exists = false;
      }

      const measured = exists ? await measureDir(dir) : { bytes: 0, files: 0, truncated: false };
      return {
        key: cat.key,
        label: cat.label,
        dir,
        exists,
        description: cat.description,
        keepDays: cat.keepDays,
        bytes: measured.bytes,
        files: measured.files,
        truncated: measured.truncated,
        humanSize: humanSize(measured.bytes)
      };
    })
  );

  return { ok: true, root, stats, elapsedMs: Date.now() - startedAt };
}

/** 单个条目（文件或目录）的递归体积与文件数；读不到按 0 计（不影响删除决策） */
async function measureEntry(full, isDir) {
  if (isDir) return measureDir(full);
  try {
    const st = await fsp.stat(full);
    return { bytes: st.size, files: 1, truncated: false };
  } catch (_) {
    /* 统计过程中被删/无权限 */
    return { bytes: 0, files: 0, truncated: false };
  }
}

/**
 * 生成清理计划：**预演与真删共用同一份计划**。
 *
 * 为什么必须共用：
 *   "先预演再执行"的可信度完全取决于两者规则一致。若预演用 stats 的体积、
 *   真删用另一套筛选，用户看到的"将删除 3 项 / 12MB"与实际删除的东西不符 ——
 *   这比没有预演更糟（用户据此做了决定）。所以筛选（keepDays + mtime）、
 *   计数、体积都在这里算一次，dryRun 与真删都只读这份结果。
 *
 * @param {object} cat CATEGORIES 里的一项
 * @returns {Promise<{dir:string, missing?:boolean, error?:string, items:Array, toRemove:Array,
 *   kept:number, files:number, bytes:number, truncated:boolean}>}
 */
async function planClean(cat) {
  const dir = categoryDir(cat);

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { dir, missing: true, items: [], toRemove: [], kept: 0, files: 0, bytes: 0, truncated: false };
    }
    return { dir, error: `无法读取目录: ${e.message}`, items: [], toRemove: [], kept: 0, files: 0, bytes: 0, truncated: false };
  }

  /* 带 mtime 与体积的条目列表 */
  const items = [];
  let truncated = false;
  let countedFiles = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    let mtime = 0;
    let measured = { bytes: 0, files: 0, truncated: false };
    if (isDir) {
      measured = await measureEntry(full, true);
      try {
        mtime = (await fsp.stat(full)).mtimeMs;
      } catch (_) {
        mtime = 0;
      }
    } else {
      try {
        const st = await fsp.stat(full);
        mtime = st.mtimeMs;
        measured = { bytes: st.size, files: 1, truncated: false };
      } catch (_) {
        mtime = 0;
      }
    }
    items.push({ name: entry.name, full, mtime, isDir, files: measured.files, bytes: measured.bytes });
    if (measured.truncated) truncated = true;
    countedFiles += measured.files;
    if (countedFiles > MAX_FILES_PER_CATEGORY) {
      truncated = true;
      break;
    }
  }

  /* 按保留策略筛选 */
  let toRemove = items;
  if (cat.keepDays > 0) {
    const cutoff = Date.now() - cat.keepDays * 24 * 60 * 60 * 1000;
    toRemove = items.filter((it) => it.mtime > 0 && it.mtime < cutoff);
  }
  const kept = items.length - toRemove.length;

  /* 只统计"将被删除"那部分的文件数与体积（保留的不算，否则预演会虚高） */
  let files = 0;
  let bytes = 0;
  for (const it of toRemove) {
    files += it.files;
    bytes += it.bytes;
  }

  return { dir, items, toRemove, kept, files, bytes, truncated };
}

/**
 * 清理某个分类，或只预演。
 *
 * @param {string} category 分类 key
 * @param {{dryRun?:boolean}} [opts] dryRun=true 时**只列出会删什么，不真删**
 * @returns {Promise<{ok:boolean, dryRun:boolean, removed:number, wouldRemove:number,
 *   failed:number, kept:number, files:number, bytes:number, humanSize:string, message:string}>}
 */
async function cleanDataCategory(category, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const cat = CATEGORIES.find((c) => c.key === category);
  if (!cat) {
    return { ok: false, dryRun, removed: 0, wouldRemove: 0, failed: 0, kept: 0, message: `未知分类: ${category}` };
  }

  const plan = await planClean(cat);
  if (plan.error) {
    return { ok: false, dryRun, removed: 0, wouldRemove: 0, failed: 0, kept: 0, dir: plan.dir, message: plan.error };
  }

  const base = {
    dryRun,
    category: cat.key,
    label: cat.label,
    dir: plan.dir,
    kept: plan.kept,
    files: plan.files,
    bytes: plan.bytes,
    humanSize: humanSize(plan.bytes),
    truncated: plan.truncated
  };

  if (plan.missing) {
    return { ...base, ok: true, removed: 0, wouldRemove: 0, items: [], message: '目录不存在，无需清理' };
  }

  const names = plan.toRemove.map((it) => it.name);
  const previewItems = names.slice(0, MAX_PREVIEW_ITEMS);
  const itemsTruncated = names.length > previewItems.length;

  /* --- 预演：一个字节都不删 --- */
  if (dryRun) {
    const message = plan.toRemove.length
      ? `预演：将删除 ${plan.toRemove.length} 项（${plan.files} 个文件，${humanSize(plan.bytes)}）`
        + (plan.kept ? `，保留 ${plan.kept} 项（${cat.keepDays} 天内）` : '')
      : '预演：没有符合清理条件的项目（按当前保留策略）';
    logging.log('info', `[data] 预演 ${cat.key}: ${message}`);
    return {
      ...base,
      ok: true,
      wouldRemove: plan.toRemove.length,
      removed: 0,
      failed: 0,
      items: previewItems,
      itemsTruncated,
      message
    };
  }

  /* --- 真删：遍历的就是上面预演那份 plan.toRemove --- */
  let removed = 0;
  let failed = 0;
  const failures = [];
  for (const item of plan.toRemove) {
    try {
      await fsp.rm(item.full, { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      failed += 1;
      if (failures.length < 5) failures.push(`${item.name}: ${e.message}`);
    }
  }

  const parts = [`已删除 ${removed} 项（${plan.files} 个文件，${humanSize(plan.bytes)}）`];
  if (plan.kept) parts.push(`保留 ${plan.kept} 项（${cat.keepDays} 天内）`);
  if (failed) parts.push(`${failed} 项失败`);
  const message = parts.join('，');

  logging.log(failed ? 'warn' : 'info', `[data] 清理 ${cat.key}: ${message}`);
  return {
    ...base,
    ok: failed === 0,
    wouldRemove: plan.toRemove.length,
    removed,
    failed,
    failures,
    items: previewItems,
    itemsTruncated,
    message
  };
}

/** 返回分类元数据（供前端渲染下拉与说明） */
function listCategories() {
  return CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    description: c.description,
    keepDays: c.keepDays
  }));
}

module.exports = {
  getDataStats,
  cleanDataCategory,
  listCategories,
  humanSize,
  CATEGORIES
};
