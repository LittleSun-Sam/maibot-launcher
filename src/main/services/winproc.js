/*
================================================================================
技术文档：src/main/services/winproc.js
职责：Windows 进程树操作的可靠原语（隐藏启动、真停止、存在性探测）。
================================================================================
  为什么必须单独抽出来：
    重构前 process.js 用 `child.kill('SIGINT')` 来停止 MaiBot，
    在 Windows 上对 shell:false 启动的 python.exe **完全没有效果**
    （没有进程组概念，Node 只能对直接子进程发信号，且 SIGINT 在 Windows
    上是"直接终止"，对 Python 更不生效），于是：
        用户点「停止」→ 界面显示"已停止" → 进程仍在后台运行
    同一份代码里还留着 `if (services.has(key))` 的 taskkill 兜底，
    但前一行已经把该 key 从表里删掉了 —— 这个兜底分支永远进不去。

  本模块提供：
    spawnHidden()      —— 统一 windowsHide 启动，避免黑框闪现
    killTree()         —— taskkill /T /F 杀整棵进程树，并**等待真正结束**
    isAlive()          —— 跨平台进程存在性探测（用于真看门狗）
    waitForExit()      —— 等待进程退出，带超时，返回是否成功
    verifyIdentity()   —— kill 前校验 PID 身份（防 PID 复用误杀）
    findProcesses()    —— 枚举匹配进程；**枚举失败必须返回 ok:false**，
                          "查不到"与"查失败"是两回事，不许混为一谈

  ⚠️ 为什么 killTree 必须能做身份校验：
    Windows 的 PID 会被回收。记录里存着 pid=N，若那个进程早已退出、
    而 N 被系统分给了别的进程（可能是用户自己的 python.exe、编辑器，
    甚至系统进程），killTree(N) 就会 taskkill /T /F 把无关进程的整棵树杀掉。
    这是"停止服务"里后果最重的一类错误，所以 killTree 支持 opts.identity：
      真正 taskkill 之前先用一次 CIM 查询比对该 PID 的创建时间戳
      （顺带比对可执行文件名），不匹配就拒绝动手并如实回报。
    性能：只在"即将 kill"时查一次，绝不在 isAlive 这类轮询路径上查。
================================================================================
*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

/** 进程名白名单：进程名本来就不需要引号、空格、通配符 */
const PROCESS_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 命令行关键字长度上限（只用于 JS 侧 includes，不进命令行） */
const MAX_KEYWORD_CHARS = 200;

/** Get-CimInstance 的 JSON 输出上限，异常情况下不把内存撑爆 */
const MAX_CSIM_JSON_CHARS = 4 * 1024 * 1024;

let powershellPath = '';

/**
 * 解析 PowerShell 的**绝对路径**，不裸依赖 PATH。
 * 理由：PATH 上先被找到的同名 powershell.exe 会顶替系统那份 ——
 * 而"能往某个 PATH 目录里写文件"正是本文件其它条目在防的事。
 * 找不到（非标准安装）时如实退回 'powershell'，不改变原有行为。
 */
function powershellExe() {
  if (powershellPath) return powershellPath;
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(candidate)) powershellPath = candidate;
  } catch (_) {
    /* 退回 PATH */
  }
  if (!powershellPath) powershellPath = 'powershell';
  return powershellPath;
}

/**
 * 以隐藏窗口方式启动一个进程。
 * @param {string} command
 * @param {string[]} args
 * @param {import('child_process').SpawnOptions} [options]
 */
function spawnHidden(command, args = [], options = {}) {
  return spawn(command, args, {
    windowsHide: true,
    ...options
  });
}

/**
 * 判断进程是否仍然存活。
 * 用 signal 0 探测：不发送任何信号，仅做权限与存在性检查。
 * @param {number} pid
 */
function isAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    /* ESRCH = 进程不存在；EPERM = 存在但无权限（视为存活） */
    return e.code === 'EPERM';
  }
}

/**
 * 允许的创建时间偏差（子进程 spawn 到系统记下 CreationDate 之间的正常抖动）。
 * 取宽一点只会降低"误杀"概率，代价只是极少数真需要杀的场景会被多问一次。
 */
const IDENTITY_TOLERANCE_MS = 5000;

/** 把 CIM 的 CreationDate 转成 epoch 毫秒；无法解析返回 null */
function toEpochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 查询一个 PID 的当前身份（创建时间戳 + 可执行文件路径）。
 * 未找到（进程已退出）返回 null；查询失败或系统不支持返回 { unknown:true }。
 *
 * @param {number} pid
 * @returns {Promise<{pid:number, createdAt:number|null, exeName:string, exePath:string}|{unknown:true}|null>}
 */
function queryProcessIdentity(pid) {
  return new Promise((resolve) => {
    const target = Number(pid);
    if (!IS_WINDOWS || !target) {
      /* 非 Windows 没有 CIM；调用方会看到"未知"从而走保守路径 */
      resolve({ unknown: true });
      return;
    }

    /*
      常量脚本，唯一的外部输入是**数字** PID，且以独立 argv 传入并再窄化成 [uint32]，
      不参与任何字符串拼接（与 findProcesses 同一套注入防护思路）。
      进程不存在时 $p 为 $null，ConvertTo-Json 输出 'null' → 解析为 null → 未找到。
    */
    const ps = [
      `$ErrorActionPreference='SilentlyContinue';`,
      `$p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [uint32]${target});`,
      `if ($null -eq $p) { 'null' } else {`,
      `[pscustomobject]@{`,
      `C=[int64]([datetime]$p.CreationDate).ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds;`,
      `N=[string]$p.Name;P=[string]$p.ExecutablePath`,
      `} | ConvertTo-Json -Compress }`
    ].join(' ');

    let child;
    try {
      child = spawnHidden(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps]);
    } catch (_) {
      resolve({ unknown: true });
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const limit = 8192;
    child.stdout.on('data', (d) => {
      if (out.length < limit) out += d.toString();
    });
    child.on('error', () => finish({ unknown: true }));
    child.on('exit', () => {
      const text = out.trim();
      if (!text) {
        finish({ unknown: true });
        return;
      }
      if (text === 'null') {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed) {
          finish(null);
          return;
        }
        finish({
          pid: target,
          createdAt: toEpochMs(parsed.C),
          exeName: String(parsed.N || ''),
          exePath: String(parsed.P || '')
        });
      } catch (_) {
        finish({ unknown: true });
      }
    });
  });
}

/**
 * kill 前校验：这个 PID 现在还是不是"当初那个进程"。
 *
 * 判据（按可靠性排序）：
 *   1) 创建时间戳 —— 必须落在 spawn 之后 IDENTITY_TOLERANCE_MS 之内。
 *      PID 被复用时，新进程的创建时间必然远晚于 pidStartedAt，直接判不匹配。
 *   2) 可执行文件名 —— 记了名字时，现名必须是旧名；PID 复用得越久越可能是别的程序。
 *
 * @param {{pid?:number, startedAt?:number, exePath?:string}} identity
 * @returns {Promise<{known:boolean, matches:boolean, skipped?:boolean, reason?:string, actual?:object}>}
 */
async function verifyIdentity(identity) {
  const pid = Number(identity?.pid);
  if (!pid) return { known: true, matches: false, reason: '未提供有效 PID' };

  const actual = await queryProcessIdentity(pid);
  if (!actual) {
    /*
      查不到 = 进程已经不在了。pid 早已退出，此时 PID 即使被复用也还没发生，
      立刻回去 kill 没有风险（而且 isAlive 可能只是抓到了最后一瞬间）。
    */
    return { known: true, matches: true, skipped: true, reason: '进程已不存在' };
  }
  if (actual.unknown) {
    return { known: false, matches: false, reason: '无法查询该 PID 的创建时间（CIM 不可用）' };
  }

  /*
    可执行文件名比对：可选的第二道判据。调用方若提供了期望名（如 'python.exe'），
    就要求现名一致 —— PID 复用后新进程往往连程序都换了。
    没提供时只靠创建时间戳（调用方从 child.pid 拿进程名并不总是可靠）。
  */
  const expectedNames = [];
  if (identity.exeName) expectedNames.push(String(identity.exeName).toLowerCase());
  if (identity.exePath) expectedNames.push(path.basename(String(identity.exePath)).toLowerCase());
  if (expectedNames.length && actual.exeName && !expectedNames.includes(actual.exeName.toLowerCase())) {
    return {
      known: true,
      matches: false,
      actual,
      reason: `可执行文件已变（期望 ${expectedNames.join('/')}，实际 ${actual.exeName}）`
    };
  }

  const startedAt = Number(identity.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    if (actual.createdAt === null) {
      return { known: false, matches: false, reason: '拿到进程信息但创建时间不可解析', actual };
    }
    const delta = actual.createdAt - startedAt;
    if (delta < -IDENTITY_TOLERANCE_MS) {
      return {
        known: true,
        matches: false,
        actual,
        reason: `该 PID 的创建时间（${new Date(actual.createdAt).toISOString()}）早于我们启动它的时间，属于复用`
      };
    }
    if (delta > IDENTITY_TOLERANCE_MS) {
      return {
        known: true,
        matches: false,
        actual,
        reason: `该 PID 的创建时间（${new Date(actual.createdAt).toISOString()}）远晚于我们启动它的时间，已被复用`
      };
    }
  }

  return { known: true, matches: true, actual };
}

/**
 * 杀死整棵进程树并**等待其真正结束**。
 *
 * Windows：taskkill /PID <pid> /T /F —— /T 连带子进程，/F 强制。
 *          必须 await 这个子进程结束，否则父进程先退出会导致
 *          taskkill 还没执行完，残留后台进程（原代码的"绿色版残留"问题）。
 * 其他平台：先 SIGTERM，超时后 SIGKILL。
 *
 * @param {number} pid
 * @param {{timeoutMs?:number, label?:string, identity?:{pid?:number, startedAt?:number, exePath?:string}}} [opts]
 *   opts.identity 存在时，taskkill 之前先校验该 PID 还是不是当初那个进程
 *   （见文件头"为什么 killTree 必须能做身份校验"）。校验不通过则拒绝 kill。
 * @returns {Promise<{ok:boolean, method:string, message?:string, refused?:string, actual?:object}>}
 */
function killTree(pid, opts = {}) {
  const { timeoutMs = 5000, label = '', identity = null } = opts;
  const target = Number(pid);
  if (!target) return Promise.resolve({ ok: false, method: 'none', message: '无效 PID' });
  if (!isAlive(target)) return Promise.resolve({ ok: true, method: 'skipped', message: '进程已不存在' });

  if (identity) {
    return (async () => {
      let check;
      try {
        check = await verifyIdentity(identity);
      } catch (e) {
        /*
          校验本身失败（查询异常等）时**保守拒绝**：
          与其赌一个可能已被复用的 PID，不如让调用方看到"没能确认身份"。
          历史上这里没有任何校验，所以"拒绝"不会比原来更危险。
        */
        check = { known: false, matches: false, reason: `身份校验异常: ${e.message}` };
      }
      if (!check.known) {
        const message = `无法确认 pid ${target} 的身份，已拒绝结束进程以免误杀：${check.reason || '未知原因'}`;
        if (!check.skipped) logRefuse(message);
        return { ok: false, method: 'identity-unknown', message };
      }
      if (!check.matches) {
        const message =
          `pid ${target} 已不是当初托管的进程（${check.reason || '身份不匹配'}），已拒绝结束进程以免误杀无关进程树`;
        logRefuse(message);
        return { ok: false, method: 'identity-mismatch', message, refused: check.reason, actual: check.actual };
      }
      return killTreeUnchecked(target, { timeoutMs, label });
    })();
  }

  return killTreeUnchecked(target, { timeoutMs, label });
}

/** 校验失败/无法校验时的统一告警（独立出来便于 lint 与阅读） */
function logRefuse(message) {
  console.warn(`[winproc] ${message}`);
}

/**
 * 真正执行 taskkill / SIGTERM，不做身份校验（内部使用，且只在校验通过后被调用）。
 * @param {number} target
 * @param {{timeoutMs:number, label:string}} opts
 * @returns {Promise<{ok:boolean, method:string, message?:string}>}
 */
function killTreeUnchecked(target, { timeoutMs, label }) {
  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child;
      try {
        child = spawnHidden('taskkill', ['/PID', String(target), '/T', '/F']);
      } catch (e) {
        done({ ok: false, method: 'taskkill', message: `taskkill 启动失败: ${e.message}` });
        return;
      }

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => done({ ok: false, method: 'taskkill', message: e.message }));
      child.on('exit', () => {
        /* taskkill 退出后仍可能有一瞬间的收尾，轮询确认真死 */
        waitExit(target, timeoutMs)
          .then((gone) =>
            done(
              gone
                ? { ok: true, method: 'taskkill' }
                : { ok: false, method: 'taskkill', message: `进程 ${target} 仍未退出${stderr ? `: ${stderr.trim()}` : ''}` }
            )
          )
          .catch(() => done({ ok: !isAlive(target), method: 'taskkill' }));
      });

      /* 兜底：taskkill 本身卡住 */
      setTimeout(() => {
        if (!settled) {
          done({ ok: !isAlive(target), method: 'taskkill-timeout', message: 'taskkill 超时' });
        }
      }, timeoutMs + 1500).unref?.();
      void label;
    });
  }

  /* ---- POSIX：先温和后强制 ---- */
  return (async () => {
    try {
      process.kill(target, 'SIGTERM');
    } catch (_) {
      /* 已不存在 */
    }
    if (await waitExit(target, Math.min(timeoutMs, 2500))) return { ok: true, method: 'SIGTERM' };
    try {
      process.kill(target, 'SIGKILL');
    } catch (_) {
      /* 已不存在 */
    }
    const gone = await waitExit(target, timeoutMs);
    return gone
      ? { ok: true, method: 'SIGKILL' }
      : { ok: false, method: 'SIGKILL', message: `进程 ${target} 未退出` };
  })();
}

/**
 * 轮询等待进程消失。
 * @param {number} pid
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true = 已消失
 */
function waitExit(pid, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!isAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * 按命令行特征查找进程（用于清理残留）。
 * 返回 `{ ok, processes, reason, error }`，供调用方决定是否终止。
 *
 * ⚠️ 为什么必须区分"没查到"与"查失败"（本次加固的核心）：
 *   本函数此前把**每一条**失败路径都 `resolve([])`：
 *     枚举输出超限被截断 / PowerShell 无输出 / JSON 解析失败 / spawn 失败。
 *   于是 process.cleanupZombies 拿到空数组，界面「清理残留」就报
 *   "未发现残留进程" —— **查询失败被说成了机器很干净**。
 *   一台还在跑着残留麦麦的机器被报告成绿色，用户不会再去看第二眼。
 *   现在：只要能证明"我没查成功"，就返回 ok=false + reason + error；
 *   调用方（process.cleanupZombies）不得把它翻译成"没有残留"。
 *
 * 另外每条结果带 `createdAt`（该 PID 的创建时间戳）：清理残留路径要拿它做
 * PID 复用校验 —— 枚举到动手之间，PID 可能已被系统回收并分给无关进程。
 *
 * 注意：原实现还用**退出码 0 判定"清理成功"**，但即使一个进程都没匹配到，
 * PowerShell 也返回 0 —— 于是永远提示"已清理残留进程"。
 * 这里改为真正返回匹配列表，由调用方按数量如实汇报。
 *
 * 安全（修复注入）：nameFilter / cmdlineKeyword 都来自渲染层
 * （preload 的 cleanupZombies({name,keyword}) → index.js:633 → process.cleanupZombies）。
 * 旧实现把它们拼进 PowerShell 字符串，且用「单引号翻倍」当转义 —— 这**不足以**防注入：
 *   `Get-CimInstance Win32_Process -Filter "Name='${name}'"`
 * nameFilter 落在**双引号**字符串里，PowerShell 会在其中求值 `$(...)` 与反引号，
 * 于是 nameFilter = `python.exe$(Start-Process calc.exe)` 就能执行任意命令
 * （实测：`powershell -Command "Write-Output \"Name='probe$(Write-Output X)'\""` → `Name='probeX'`）。
 * 现在渲染层的字符串**一个字节都不进命令行**：
 *   · 脚本是常量，只做「枚举全部进程」；
 *   · 过滤（进程名精确匹配 + 命令行包含关键字）改在 JS 侧做；
 *   · 进程名再叠一层白名单兜底（进程名本来就只有 A-Za-z0-9._-）。
 *
 * @param {string} nameFilter 进程名（如 'python.exe'）
 * @param {string} cmdlineKeyword 命令行关键字（如 'maibot'）
 * @returns {Promise<{ok:boolean, processes:Array<{pid:number,name:string,cmdline:string,createdAt:number|null}>, reason?:string, error?:string}>}
 *   ok=false 表示**枚举失败，结果不可信**，绝不能被当成"没有残留"。
 */
function findProcesses(nameFilter, cmdlineKeyword) {
  if (!IS_WINDOWS) {
    return Promise.resolve({
      ok: false,
      processes: [],
      reason: 'unsupported-platform',
      error: `当前平台 ${process.platform} 不做 Windows 进程枚举`
    });
  }

  const name = typeof nameFilter === 'string' ? nameFilter.trim() : '';
  const keyword = typeof cmdlineKeyword === 'string' ? cmdlineKeyword.trim() : '';

  /* 白名单兜底：进程名不含引号/空格/通配符，非法值明确报错（而不是伪装成"没找到"） */
  if (!PROCESS_NAME_RE.test(name)) {
    const error = `进程名不合法（只允许 A-Za-z0-9._-）: ${JSON.stringify(name).slice(0, 120)}`;
    console.warn(`[winproc] ${error}`);
    return Promise.resolve({ ok: false, processes: [], reason: 'invalid-argument', error });
  }
  /* 关键字只用于 JS 侧 includes，仍限长，避免拿超长字符串做无意义匹配 */
  if (keyword.length > MAX_KEYWORD_CHARS) {
    const error = `命令行关键字过长（${keyword.length} > ${MAX_KEYWORD_CHARS}）`;
    console.warn(`[winproc] ${error}`);
    return Promise.resolve({ ok: false, processes: [], reason: 'invalid-argument', error });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    /** 失败一律如实带原因返回；**绝不**退回空列表 */
    const fail = (reason, error) => {
      console.warn(`[winproc] 进程枚举失败（${reason}）: ${String(error).slice(0, 300)}`);
      finish({ ok: false, processes: [], reason, error: String(error) });
    };

    /*
      仅输出数据，不执行任何终止动作 —— 终止交给 killTree，
      这样"发现"与"处置"分离，可分别测试与汇报。
      下面是**常量**脚本，不含任何外部输入。
      最后一个计算属性 C = 创建时间（epoch 毫秒），供 PID 复用校验使用。

      ⚠️ 第一行必须以 `;` 结尾：这些片段是用空格拼成一条命令的，
      少了分号就变成 `$ErrorActionPreference='SilentlyContinue' Get-CimInstance …`
      —— PowerShell 直接报 ParserError、**一个进程都枚举不出来**。
      （这正是"清理残留"长期恒回"未发现残留进程"的根因：脚本从未跑成功过，
        旧代码又把"无输出"吞成空列表。queryProcessIdentity 里的同类脚本
        第一行本来就带 `;`，这里补齐成一致写法。）
    */
    const ps = [
      `$ErrorActionPreference='SilentlyContinue';`,
      `Get-CimInstance Win32_Process |`,
      `Select-Object ProcessId,Name,CommandLine,`,
      `@{n='C';e={[int64]([datetime]$_.CreationDate).ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds}} |`,
      `ConvertTo-Json -Compress -Depth 3`
    ].join(' ');

    let child;
    try {
      child = spawnHidden(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps]);
    } catch (e) {
      fail('spawn-failed', `PowerShell 启动失败: ${e.message}`);
      return;
    }

    let out = '';
    let err = '';
    let truncated = false;
    child.stdout.on('data', (d) => {
      if (out.length >= MAX_CSIM_JSON_CHARS) {
        truncated = true;
        return;
      }
      out += d.toString();
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => fail('spawn-failed', `PowerShell 不可用: ${e.message}`));
    child.on('exit', (code) => {
      const text = out.trim();
      const stderrTail = err.trim().slice(0, 300);
      if (truncated) {
        fail('output-truncated', `进程列表超过 ${MAX_CSIM_JSON_CHARS} 字符已截断，未得到完整列表，结果不可信`);
        return;
      }
      if (!text) {
        fail('empty-output', `PowerShell 无输出（exit=${code}）${stderrTail ? `: ${stderrTail}` : ''}`);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        fail('parse-failed', `解析进程列表 JSON 失败: ${e.message}；原始输出前 200 字符: ${text.slice(0, 200)}`);
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const wanted = name.toLowerCase();
      const needle = keyword.toLowerCase();
      finish({
        ok: true,
        processes: list
          .filter((p) => p && p.ProcessId)
          .map((p) => ({
            pid: Number(p.ProcessId),
            name: String(p.Name || ''),
            cmdline: String(p.CommandLine || ''),
            createdAt: toEpochMs(p.C)
          }))
          /*
            JS 侧过滤，等价于原来的
              Name='<name>'  与  CommandLine -like '*<keyword>*'
            （-like 大小写不敏感；$null 命令行在 PowerShell 里也匹配不上 '**'，
              所以这里同样要求命令行非空。）
          */
          .filter((p) => p.name.toLowerCase() === wanted)
          .filter((p) => {
            if (!p.cmdline) return false;
            return !needle || p.cmdline.toLowerCase().includes(needle);
          })
      });
    });
  });
}

module.exports = {
  IS_WINDOWS,
  spawnHidden,
  isAlive,
  killTree,
  waitExit,
  findProcesses,
  /* 身份校验：killTree 内部用；导出便于测试与调用方先行判断 */
  verifyIdentity,
  queryProcessIdentity
};
