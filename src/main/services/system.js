/*
================================================================================
技术文档：src/main/services/system.js
职责：系统资源占用采样（CPU / 内存 / 磁盘可用空间）。
================================================================================
  相对重构前的修正：
    - CPU 采样依赖两次调用之间的差分，首次调用必然返回 0%。
      原实现不做任何说明，前端首次进页面显示 0% 会让用户以为读不到数据。
      现在：返回 samplingReady 标记，首次调用主动等待一个短间隔完成基线采样。
    - 补充磁盘可用空间（安装 MaiBot 前用户最关心的其实是这个）。
    - 补充进程自身内存占用，便于判断启动器是否异常膨胀。
================================================================================
*/
const os = require('os');
const fsp = require('fs/promises');
const { app } = require('electron');

/*
  CPU 计时基线。
  说明：这里只需要**上一次的计数值**——使用率由两次累计计时之差算出，
  与墙上时间无关。原来还有一个 `lastSampleTs` 被赋值却从未被读取，
  属于"看起来在按时间窗口算、其实纯粹按差值算"的误导性残留，已删除。
*/
let lastCpu = null;

/**
 * 正在进行中的"基线采样"。
 *
 * 为什么需要：基线采样要读一次 CPU 计时 → 睡 220ms → 再读一次算差值。
 * 若两个调用并发进来（面板初始化 + 用户手动刷新、或两个页面同时挂载），
 * 原实现会让两边**各自**建立基线、各自睡 220ms，然后两次差值都接近 0 ——
 * 界面于是显示 0% CPU。用户看到的是"CPU 读数偶尔失灵"。
 * 现在把这次采样做成一个共享 promise：并发调用等同一份结果，只有真正
 * 拿到差值之后才继续，不会互相把对方的基线冲掉。
 */
let baselineSample = null;

/** 基线采样间隔：太短差值噪声大，太长界面首帧等得久 */
const BASELINE_SAMPLE_MS = 220;

/** 读取 CPU 累计计时 */
function readCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

/** 计算自上次采样以来的 CPU 使用率（0-100） */
function computeCpuPercent() {
  const now = readCpuTimes();

  let percent = null;
  if (lastCpu && now.total > lastCpu.total) {
    const idleDelta = now.idle - lastCpu.idle;
    const totalDelta = now.total - lastCpu.total;
    if (totalDelta > 0) {
      percent = Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10;
      percent = Math.min(100, Math.max(0, percent));
    }
  }

  lastCpu = now;
  return percent;
}

/**
 * 建立 CPU 采样基线：显式地"取差值"，而不是先算一次再睡一觉。
 *
 * 实现上就是把原来的 computeCpuPercent() + 220ms 睡眠写清楚：
 *   采样1 → 等待 → 采样2 → 立刻算差值并返回。
 * 这样做的好处是**中间那次等待的结果一定被用上**，
 * 而不是像原来那样"睡完之后再来一次 computeCpuPercent 赌 baseline 还在"。
 *
 * 并发安全：同一时刻只有一个基线采样在跑，其余调用复用同一个 promise。
 */
function sampleBaseline() {
  if (baselineSample) return baselineSample;
  baselineSample = (async () => {
    try {
      const before = readCpuTimes();
      /*
        ⚠️ 这里的定时器**不能** unref()。
        unref 过的定时器不会撑住事件循环：在启动器里进程一直活着所以看不出来，
        但任何"跑完就退出"的场景（本项目的脚本/测试）会在 220ms 之前就结束，
        await 永远不 settle —— 表现为"采样函数把整个进程挂住"。
        原始实现用的是没有 unref 的 setTimeout，这里保持一致。
      */
      await new Promise((r) => setTimeout(r, BASELINE_SAMPLE_MS));
      const after = readCpuTimes();
      lastCpu = after;
      const totalDelta = after.total - before.total;
      const idleDelta = after.idle - before.idle;
      if (totalDelta <= 0) return 0;
      const percent = Math.round(((totalDelta - idleDelta) / totalDelta) * 1000) / 10;
      return Math.min(100, Math.max(0, percent));
    } finally {
      /* 无论成功失败都要清掉，否则一次异常会让后续所有采样卡在旧 promise 上 */
      baselineSample = null;
    }
  })();
  return baselineSample;
}

/**
 * 采样系统占用。
 * @param {{ensureBaseline?:boolean}} [opts]
 * @returns {Promise<object>}
 */
async function getSystemUsage(opts = {}) {
  /*
    首次调用：先建立基线并**直接用这次差值**，避免返回恒定的 0%。
    并发调用由 sampleBaseline 内部合并，不会互相冲掉基线。
  */
  let baselinePercent = null;
  if (opts.ensureBaseline !== false && !lastCpu) {
    baselinePercent = await sampleBaseline();
  }

  const cpuPercent = baselinePercent !== null ? baselinePercent : computeCpuPercent();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const mem = process.memoryUsage();
  const loadAvg = os.loadavg();

  return {
    ok: true,
    cpuPercent: cpuPercent === null ? 0 : cpuPercent,
    samplingReady: cpuPercent !== null,
    cores: os.cpus().length || 1,
    loadAverage: Array.isArray(loadAvg) ? loadAvg.map((n) => Math.round(n * 100) / 100) : [0, 0, 0],
    memoryUsedMB: Math.round(usedMem / 1048576),
    memoryTotalMB: Math.round(totalMem / 1048576),
    memoryPercent: totalMem ? Math.round((usedMem / totalMem) * 1000) / 10 : 0,
    /** 启动器自身占用，便于排查内存泄漏 */
    appMemoryMB: Math.round(mem.rss / 1048576),
    /*
      ⚠️ 两个 uptime 原来名字与取值**恰好互换**：
        uptimeSec        = os.uptime()      —— 其实是**系统**开机时长
        systemUptimeSec  = process.uptime() —— 其实是**启动器进程**存活时长
      名字反过来讲的是另一个故事，任何人按字段名读都会读错。
      修法：字段名改成不会歧义的自述形式（osXxx / processXxx），取值各归其位。
      全仓库核查过：只有这里定义、渲染层没有任何读取点，
      所以改名不会打断现有调用（新增字段比"换值保名"更不容易留下误解）。
    */
    osUptimeSec: Math.round(os.uptime()),
    processUptimeSec: Math.round(process.uptime()),
    cpuModel: os.cpus()[0]?.model || '',
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    appVersion: app.getVersion(),
    sampleTs: Date.now()
  };
}

/**
 * 查询磁盘可用空间（用于安装前提示）。
 * @param {string} targetPath
 */
async function getDiskSpace(targetPath) {
  try {
    const st = await fsp.statfs(targetPath);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return {
      ok: true,
      path: targetPath,
      totalBytes: total,
      freeBytes: free,
      freeGB: Math.round((free / 1073741824) * 10) / 10,
      totalGB: Math.round((total / 1073741824) * 10) / 10
    };
  } catch (e) {
    return { ok: false, path: targetPath, message: `无法读取磁盘信息: ${e.message}` };
  }
}

module.exports = { getSystemUsage, getDiskSpace };
