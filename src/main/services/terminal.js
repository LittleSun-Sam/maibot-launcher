/*
================================================================================
技术文档：src/main/services/terminal.js
职责：交互式终端会话（真正的可输入终端，替代原来的空壳）。
================================================================================
  重构前这个模块是彻底的"假功能"：
    · require('node-pty') —— node-pty 从未写进 package.json，必然加载失败
    · preload 只暴露了 terminalSpawn，terminal:write / resize / kill
      三个通道渲染层根本没有对应方法
    · 界面上也没有任何入口
    结论：94 行代码 + 3 个通道，零可达路径。而注释还写着"用户确认保留"。

  现在它是真的，且有**双后端**：
    后端 A（PTY）：node-pty（N-API 预编译，win32-x64 开箱可用）
        —— 完整 TTY 语义：彩色输出、进度条、Ctrl+C、交互式程序
    后端 B（管道）：
        —— 当 node-pty 不可用（其他架构/编译失败）时的降级路径。
           用 child_process + stdin/stdout 管道，未命中 TTY 的程序会退化为
           行缓冲模式，但常见命令（python / pip / npm / git）依然可用。
           通过 PYTHONUNBUFFERED 等环境变量减轻缓冲问题。

  两条路径共用同一套 IPC 通道，渲染层无需区分，只通过 mode 字段展示后端类型。

  收尾（killSession / 退出流程）都走 killTree 且**带身份校验**：
  会话记录里的 pid 会随会话长期持有，PID 一旦被系统复用给无关进程，
  裸 `taskkill /PID N /T /F` 就会误杀别人的整棵进程树。
  见 killIdentityOf() —— 复用 winproc.verifyIdentity 的时间戳判据，不另写一套。
================================================================================
*/
const { spawn } = require('child_process');
const logging = require('../logging');
const { sendToRenderer } = require('../windows');
/*
  复用进程树原语，而不是在这里再写一遍 taskkill：
  · killTree 会 taskkill /T /F 杀掉**整棵树**并 await 到进程真正消失；
  · proc.kill() 只对直接子进程发信号，Windows 上 shell 的子进程全都留了下来 ——
    这正是"退出启动器后任务管理器里还有残留 shell / python"的来源。
  winproc 只依赖 child_process / fs / path，require 它不会形成加载环。
*/
const { killTree, isAlive } = require('./winproc');

/* ---- 尝试加载 node-pty（可选依赖） ---- */
let pty = null;
let ptyLoadError = '';
try {
  /*
    node-pty 是 optionalDependencies（N-API 预编译产物），
    npm install 时可能被跳过，因此这里必须容错并降级到管道后端。
    （原来这里挂着一条 `eslint-disable-next-line import/no-unresolved`，
     而项目从未安装 eslint-plugin-import —— 那条注释保护的是一个
     根本不存在的规则，属于纯粹的噪音，已删除。）
  */
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e.message;
  logging.log('warn', `[terminal] node-pty 不可用，将使用管道降级后端: ${e.message}`);
}

/** sessionId → 会话记录 */
const sessions = new Map();
let seq = 0;

/** 输出推送节流间隔（避免高频小包刷爆 IPC） */
const DATA_FLUSH_MS = 16;

/* ============================================================================
 *  后端探测
 * ========================================================================== */

/** 终端能力信息（供前端展示与提示） */
function capability() {
  return {
    /** 'pty' = 完整终端；'pipe' = 管道降级 */
    backend: pty ? 'pty' : 'pipe',
    ptyAvailable: Boolean(pty),
    ptyError: ptyLoadError,
    platform: process.platform,
    shells: detectShells(),
    note: pty
      ? '完整 PTY 模式：支持彩色输出与交互式程序'
      : '管道降级模式：node-pty 不可用，部分交互式程序可能无法正常运行'
  };
}

/**
 * 探测本机可用的 shell。
 *
 * ⚠️ 启动开关（-NoProfile / -NoLogo）必须**定义在每个 shellDef 自己的 args 里**，
 * 不能到 spawn 时统一追加。
 * 原来的管道后端是 `[...shellDef.args, '-NoProfile', '-NoLogo']` ——
 * 那两个开关只属于 PowerShell 家族：cmd.exe 收到 `-NoProfile` 会把它当成
 * 一条要执行的命令（"'-NoProfile' 不是内部或外部命令"）后立刻退出，
 * bash 收到 `-NoLogo` 会当成非法选项直接报错退出。
 * 结果就是"node-pty 不可用时的降级终端一打开就死"，而日志里看不出是参数问题。
 *
 * 这里同时给 PowerShell 家族带上 -NoLogo：
 *   -NoLogo 去掉启动横幅，-NoProfile 跳过用户 profile（profile 里的
 *   Set-Location / conda activate 会污染我们指定的 cwd）。
 */
function detectShells() {
  const fs = require('fs');
  const list = [];
  const pwsh = process.env.PWSH_PATH || 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  if (process.platform === 'win32') {
    if (fs.existsSync(pwsh)) {
      list.push({ id: 'pwsh', label: 'PowerShell 7', exe: pwsh, args: ['-NoLogo', '-NoProfile'] });
    }
    list.push({
      id: 'powershell',
      label: 'Windows PowerShell',
      exe: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile']
    });
    /* cmd.exe 没有任何等价的"跳过 profile"开关，args 保持为空 */
    list.push({
      id: 'cmd',
      label: '命令提示符',
      exe: process.env.ComSpec || 'cmd.exe',
      args: []
    });
  } else {
    /* -l 是登录 shell：非 Windows 上保持原有行为，不加任何 PowerShell 开关 */
    list.push({ id: 'bash', label: 'bash', exe: process.env.SHELL || '/bin/bash', args: ['-l'] });
  }
  return list;
}

/** 解析请求的 shell */
function resolveShell(requested) {
  const shells = detectShells();
  if (!requested) return shells[0];
  return shells.find((s) => s.id === requested) || shells[0];
}

/* ============================================================================
 *  会话管理
 * ========================================================================== */

/**
 * 启动一个终端会话。
 *
 * @param {object} opts
 * @param {string} [opts.shell] shell id（pwsh / powershell / cmd / bash）
 * @param {string} [opts.cwd] 工作目录
 * @param {string} [opts.command] 启动后立即执行的命令（如 `python main.py`）
 * @param {object} [opts.env] 额外环境变量
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @returns {{ok:boolean, sessionId?:string, mode?:string, shell?:string, message:string}}
 */
function spawnSession(opts = {}) {
  const shellDef = resolveShell(opts.shell);
  if (!shellDef) return { ok: false, message: '未找到可用的 shell' };

  const cwd = resolveCwd(opts.cwd);
  const cols = clampInt(opts.cols, 20, 500, 100);
  const rows = clampInt(opts.rows, 5, 200, 30);
  const env = {
    ...process.env,
    /* 让 Python / Node 程序不做块缓冲，输出更实时 */
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    TERM: pty ? 'xterm-256color' : 'dumb',
    ...(opts.env || {})
  };

  const sessionId = `term_${Date.now().toString(36)}_${++seq}`;

  /* ---- 后端 A：node-pty ---- */
  if (pty) {
    try {
      const proc = pty.spawn(shellDef.exe, shellDef.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: process.platform === 'win32'
      });

      const session = createSession(sessionId, {
        mode: 'pty',
        shell: shellDef.label,
        cwd,
        cols,
        rows,
        /*
          pid 必须记下来：正常关闭（killSession）走 killTree(pid) 杀整棵树。
          node-pty 的 proc.kill() 对它拉起来的子进程（python 等）无效，
          只靠它就会留下孤儿进程。
        */
        pid: proc.pid,
        proc,
        write: (data) => proc.write(data),
        resize: (c, r) => proc.resize(c, r),
        kill: () => proc.kill()
      });

      proc.onData((data) => pushData(session, data));
      proc.onExit(({ exitCode, signal }) => finalizeSession(session, exitCode, signal));

      attachInitialCommand(session, opts.command);

      logging.log('info', `[terminal] PTY 会话已创建 ${sessionId} (${shellDef.label}, ${cols}x${rows})`);
      return { ok: true, sessionId, mode: 'pty', shell: shellDef.label, message: '终端已启动（PTY）' };
    } catch (e) {
      logging.log('warn', `[terminal] node-pty 启动失败，回退管道后端: ${e.message}`);
    }
  }

  /* ---- 后端 B：管道降级 ---- */
  try {
    /*
      ⚠️ 这里**不再**追加 -NoProfile / -NoLogo。
      那两个开关只对 PowerShell 家族合法，已经挪进 detectShells() 各自的
      shellDef.args —— 详见那个函数的说明。
    */
    const proc = spawn(shellDef.exe, shellDef.args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const session = createSession(sessionId, {
      mode: 'pipe',
      shell: shellDef.label,
      cwd,
      cols,
      rows,
      pid: proc.pid,
      proc,
      write: (data) => {
        if (proc.stdin.writable) proc.stdin.write(data);
      },
      resize: () => {
        /* 管道模式无窗口尺寸概念，忽略 */
      },
      /*
        kill 只负责"发起"：真正的收尾统一走 killSession →
        terminateSessionTree（它 await killTree 的结果，并按结果决定是否 finalize）。
        直接选 proc.kill() 的话，Windows 上被杀掉的只有 shell 本身，
        它拉起来的子进程会活成孤儿。
      */
      kill: () => proc.kill()
    });

    proc.stdout.on('data', (d) => pushData(session, d.toString()));
    proc.stderr.on('data', (d) => pushData(session, d.toString()));
    proc.stdin.on('error', (e) => {
      if (e.code !== 'EPIPE') logging.log('warn', `[terminal] stdin 错误: ${e.message}`);
    });
    proc.on('error', (e) => {
      pushData(session, `\r\n\x1b[31m[终端错误] ${e.message}\x1b[0m\r\n`);
      finalizeSession(session, -1, null);
    });
    proc.on('exit', (code) => finalizeSession(session, code, null));

    attachInitialCommand(session, opts.command);

    logging.log('info', `[terminal] 管道会话已创建 ${sessionId} (${shellDef.label})`);
    return {
      ok: true,
      sessionId,
      mode: 'pipe',
      shell: shellDef.label,
      message: ptyLoadError
        ? '终端已启动（管道降级模式：node-pty 不可用）'
        : '终端已启动（管道模式）'
    };
  } catch (e) {
    logging.log('error', `[terminal] 创建会话失败: ${e.message}`);
    return { ok: false, message: `终端启动失败: ${e.message}` };
  }
}

/** 构造会话记录（含输出节流缓冲） */
function createSession(sessionId, base) {
  const session = {
    sessionId,
    ...base,
    createdAt: Date.now(),
    /** 待推送的输出缓冲 */
    pending: '',
    flushTimer: null,
    closed: false
  };
  sessions.set(sessionId, session);
  return session;
}

/** 把初始命令写入会话（cwd 切换 + 用户命令） */
function attachInitialCommand(session, command) {
  const cmd = String(command || '').trim();
  if (!cmd) return;
  /* 稍作延迟，等 shell 完成初始化，避免命令被吞掉 */
  setTimeout(() => {
    if (session.closed) return;
    try {
      session.write(`${cmd}\r`);
    } catch (e) {
      logging.log('warn', `[terminal] 写入初始命令失败: ${e.message}`);
    }
  }, 350);
}

/** 校验并用真实存在的目录作为 cwd */
function resolveCwd(requested) {
  const fs = require('fs');
  const fallback = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const target = String(requested || '').trim();
  if (!target) return fallback;
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return target;
  } catch (_) {
    /* 使用回退目录 */
  }
  logging.log('warn', `[terminal] 工作目录不可用，回退到 ${fallback}`);
  return fallback;
}

/** 输出节流推送 */
function pushData(session, text) {
  if (session.closed || !text) return;
  session.pending += text;
  if (session.flushTimer) return;
  session.flushTimer = setTimeout(() => {
    session.flushTimer = null;
    if (session.closed || !session.pending) return;
    const payload = session.pending;
    session.pending = '';
    sendToRenderer('terminal:data', { sessionId: session.sessionId, data: payload });
  }, DATA_FLUSH_MS);
  session.flushTimer.unref?.();
}

/** 会话结束 */
function finalizeSession(session, exitCode, signal) {
  if (session.closed) return;
  session.closed = true;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  /* 冲刷剩余输出 */
  if (session.pending) {
    sendToRenderer('terminal:data', { sessionId: session.sessionId, data: session.pending });
    session.pending = '';
  }
  sessions.delete(session.sessionId);
  sendToRenderer('terminal:exit', { sessionId: session.sessionId, exitCode, signal });
  logging.log('info', `[terminal] 会话结束 ${session.sessionId} code=${exitCode} signal=${signal ?? 'none'}`);
}

/* ============================================================================
 *  会话操作
 * ========================================================================== */

/** 写入数据（键盘输入） */
function writeSession(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, message: '会话不存在或已结束' };
  try {
    session.write(String(data ?? ''));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `写入失败: ${e.message}` };
  }
}

/** 调整尺寸 */
function resizeSession(sessionId, cols, rows) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, message: '会话不存在' };
  const c = clampInt(cols, 20, 500, session.cols);
  const r = clampInt(rows, 5, 200, session.rows);
  session.cols = c;
  session.rows = r;
  try {
    session.resize(c, r);
    return { ok: true, cols: c, rows: r };
  } catch (e) {
    return { ok: false, message: `调整尺寸失败: ${e.message}` };
  }
}

/*
  PTY 后端杀不干净时的兜底等待时长。
  600ms 是原实现"无条件宣布会话结束"的时刻，实测对慢启动的 shell 太短：
  进程还在收尾，我们就发 terminal:exit 并把它从 sessions 里删掉了 ——
  界面标签消失、进程留着。现在这个时长只用来决定"要不要再补一刀"。
*/
const KILL_FALLBACK_MS = 600;

/**
 * 构造 killTree 所需的"身份"信息（防 PID 复用误杀整棵终端进程树）。
 *
 * 为什么终端这里同样需要（与 process.js:1437 killIdentityOf 同款问题）：
 *   sessions 里存的是 pid。会话早已退出、而 Windows 把这个 PID 分给了
 *   别的进程（用户自己的 python.exe、编辑器、甚至系统进程）时，
 *   一次 `taskkill /PID N /T /F` 会把**无关进程的整棵子进程树**一起杀掉。
 *   终端恰恰是最容易撞上这件事的地方：用户开一个标签跑 python、自己
 *   Ctrl+C 掉，标签还挂着，之后点关闭 —— 中间隔着任意长的时间。
 *
 * 时间戳来源（已核对，不是猜的）：
 *   createSession() 里 `createdAt: Date.now()`（terminal.js:278），
 *   而它是在 pty.spawn()/child_process.spawn() **返回之后**才调用的，
 *   所以 createdAt 必然略**晚于**进程的真实创建时刻 —— 是个合法上界。
 *   于是 actual.createdAt - startedAt 通常是个很小的**负数**（几毫秒），
 *   winproc.verifyIdentity 对正负两侧都按 IDENTITY_TOLERANCE_MS(5s) 容差处理，
 *   合法进程稳过；PID 一旦被复用，新进程的创建时间必定**远晚于** createdAt
 *   （正向超出容差）→ 判复用并拒绝动手。这正是我们要的 fail-closed 行为。
 *
 * ⚠️ 不传 exeName：这里拿不到可靠的期望名 —— PTY 的 proc.pid 直接来自
 *   ConPTY，pipe 后端交给 CreateProcess 的则是 shellDef.exe/args 组合，
 *   两者实际进程名不一定等于 shellDef.exe。塞一个猜的名字进来只会制造
 *   误判（把本该杀的进程判成"可执行文件已变"而拒绝），比不加更糟。
 *   故只用可靠的时间戳判据，与 process.js 的做法保持一致。
 *
 * ⚠️ 绝不要在这里做 PowerShell 查询：本函数会在 killSession / killAllSessions
 *   （退出流程）路径上被调用，加同步查询等于给关闭终端平白加上几百毫秒。
 *   查询由 killTree 在**确认要动手之前**做一次。
 *
 * @param {object} session
 * @returns {{pid:number, startedAt:number}|null}
 */
function killIdentityOf(session) {
  if (!session || !session.pid) return null;
  return { pid: session.pid, startedAt: Number(session.createdAt) || 0 };
}

/**
 * 把 winproc 的"拒绝执行"结果整形成本模块统一的失败返回。
 *
 * 为什么要显式补 pid：winproc.killTree 的 identity-* 返回里**没有** pid 字段，
 * 而本模块的调用方（killSession → IPC/界面）在失败分支一律读 result.pid。
 * 不补的话，身份拒绝这条路径恰好是唯一一条拿不到 pid 的失败路径 ——
 * 界面会说"有进程没结束"却给不出是哪个 pid，用户无从核对。
 *
 * @param {object} refused winproc.killTree 的 identity-* 返回值
 * @param {number} pid
 * @returns {{ok:false, method:string, refused:true, pid:number, message?:string}}
 */
function asRefusal(refused, pid) {
  return {
    ok: false,
    method: refused.method || 'identity-unknown',
    refused: true,
    pid,
    message: refused.message
  };
}

/**
 * 真正结束一个会话进程：**优先杀整棵进程树并按其结果收尾**。
 *
 * 为什么不能只 proc.kill()：
 *   Windows 上 proc.kill() 只作用于直接子进程（shell 本身），
 *   shell 拉起来的 python / node 全都活成孤儿。用户退出启动器后
 *   在任务管理器里看到一堆残留，就是这么来的。
 * 为什么不能 600ms 后无条件 finalize：
 *   那是"假装杀掉了"。进程可能还在，界面却已认定会话结束。
 *   现在改成：killTree 结果说了算；只有 tree 超时未确认时才去补一刀，
 *   并如实把 timeout 报给界面。
 *
 * 另外两刀都带 identity（见 killIdentityOf）：pid 若已被系统复用给无关进程，
 * 直接拒绝动手并经 asRefusal() 返回 method='identity-*' / refused / pid，
 * **不** finalize 会话。
 *
 * @param {object} session
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, method:string, message?:string, refused?:boolean, pid?:number}>}
 */
async function terminateSessionTree(session, opts = {}) {
  const pid = session.pid;
  /* 没有 pid（某些后端的进程句柄拿不到）时退回后端自己的 kill */
  if (!pid) {
    try {
      session.kill();
      return { ok: true, method: 'backend-kill' };
    } catch (e) {
      return { ok: false, method: 'backend-kill', message: `结束时失败: ${e.message}` };
    }
  }

  /*
    身份信息只构造一次并复用到两刀上：startedAt 是"我们启动它"的基准时刻，
    第一刀之后并不会变，重复构造只会多一次无意义的计算。
  */
  const identity = killIdentityOf(session);
  const killOpts = () => ({
    timeoutMs: opts.timeoutMs ?? 4000,
    label: session.sessionId,
    identity
  });

  /* 第一刀：先校验身份，再杀整棵树并等它真的消失 */
  const first = await killTree(pid, killOpts());
  /*
    ⚠️ 身份不符/无法校验时 killTree **没有执行 taskkill**，pid 还活着。
    这种情况下绝不能往下走"重试 + 最终 finalizeSession 宣布 killed"：
      · 把它当"还没死"去补第二刀，等于把刚被拒绝的误杀又试一遍；
      · finalizeSession 会把会话从 sessions 摘掉并报 killed，
        而真正的那个 pid 可能仍被无关程序占着 —— 又是一句假话。
    所以立刻 fail-closed 返回，并原样带上 method/refused 让调用方与界面
    知道"没杀，也没成功"。不 finalize：会话记录留着，用户仍能重试或看到真 pid。
  */
  if (first.refused) {
    logging.log(
      'error',
      `[terminal] 会话 ${session.sessionId} 的 pid ${pid} 身份校验未通过，` +
        `已拒绝结束进程树以免误杀无关进程（${first.message || first.method}）`
    );
    return asRefusal(first, pid);
  }
  if (first.ok || !isAlive(pid)) {
    finalizeSession(session, null, 'killed');
    return { ok: true, method: first.method };
  }

  /*
    还没死：等 KILL_FALLBACK_MS 再确认一次。
    这一步是"重试 kill"，不是"到点就宣布结束" —— 顺序反过来才是原来的 bug。
  */
  await new Promise((r) => {
    const t = setTimeout(r, KILL_FALLBACK_MS);
    t.unref?.();
  });
  if (!isAlive(pid)) {
    finalizeSession(session, null, 'killed');
    return { ok: true, method: first.method };
  }

  /* 第二刀（补一刀）：仍以"进程是否真的消失"为准；同样带身份校验（间隔后 PID 更可能被复用） */
  const second = await killTree(pid, killOpts());
  if (second.refused) {
    logging.log(
      'error',
      `[terminal] 会话 ${session.sessionId} 的 pid ${pid} 补刀前身份校验未通过，` +
        `已拒绝结束进程树以免误杀无关进程（${second.message || second.method}）`
    );
    return asRefusal(second, pid);
  }
  if (second.ok || !isAlive(pid)) {
    finalizeSession(session, null, 'killed');
    return { ok: true, method: second.method };
  }

  /*
    两刀都没杀掉（权限不足是常见原因）：**照样**把会话从表里摘掉，
    否则这个 sessionId 会永远留在 sessions 里，退出流程也会一直等它。
    但必须如实返回 ok:false + 真实 pid，让界面能告诉用户"这个进程还在"，
    而不是像原来那样一律 ok:true 把残留藏起来。
  */
  finalizeSession(session, null, 'kill-timeout');
  return {
    ok: false,
    method: second.method || 'taskkill',
    pid,
    message: `终端进程 ${pid} 仍未退出（可能权限不足），请在任务管理器中手动结束`
  };
}

/**
 * 关闭单个会话。
 *
 * 必须是 async（即使"会话不存在"这条早退分支也要返回 Promise）：
 * 主进程侧走 ipcMain.handle，handler 可以是 async 也可以是同步 —— 但
 * 同一个通道时而回 Promise、时而回裸对象，会让"调用方是不是 await"这件事
 * 变得不可推理（渲染层这次就踩过：send 时代返回值根本不存在）。
 * 统一成 Promise 之后，IPC 契约只有一种形状。
 */
async function killSession(sessionId, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, message: '会话不存在' };
  /*
    主动 kill 是"我们要求它停"，不是异常退出：
    先标 intentionalStop，免得 PTY 的 onExit 回调把它当成崩溃再推一条误导提示。
  */
  session.intentionalStop = true;
  const result = await terminateSessionTree(session, opts);
  if (result.ok) return { ok: true, sessionId, method: result.method };
  /*
    ⚠️ 身份校验拒绝（method 以 identity- 开头）必须原样透出，不能和普通失败混在一起：
      · 它的语义是"我们**没有**杀任何东西"，不是"杀了但没成功"；
      · 上层 killAllSessions / 退出流程要据此区别对待（见下面的统计），
        把它们算成"权限不足杀不掉"会误导用户去任务管理器找一个
        根本不存在的残留进程。
    与 process.js 里 stopService 对 refusedByIdentity 的处理保持同款语义。
  */
  return {
    ok: false,
    sessionId,
    message: result.message,
    pid: result.pid,
    method: result.method,
    ...(result.refused ? { refused: true } : {})
  };
}

/**
 * 关闭全部会话（退出流程调用）。
 *
 * 改成 async：退出流程必须**等**每个会话的进程树真的结束再往下走。
 * 原来 fire-and-forget 的写法会立刻返回 {ok:true, closed:N}，
 * 而 N 个 shell 还在后台——"已关闭 N 个终端"是一句假话。
 */
async function killAllSessions(opts = {}) {
  const ids = Array.from(sessions.keys());
  const results = await Promise.all(ids.map((id) => killSession(id, opts).catch(() => ({ ok: false }))));
  const closed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  /*
    身份校验拒绝要单独计数：它的含义是"这个 pid 已经不是我们的终端了，
    我们**没有**杀任何东西"，和"权限不足、真有残留"是两件完全不同的事。
    混在一起报"When N 个未能结束"会让用户去任务管理器找一个不存在的残留。
  */
  const refused = failed.filter((r) => r.refused);
  const realFailed = failed.length - refused.length;
  if (realFailed) {
    logging.log('warn', `[terminal] 退出时仍有 ${realFailed} 个终端进程未能结束`);
  }
  if (refused.length) {
    logging.log(
      'warn',
      `[terminal] ${refused.length} 个会话的 pid 身份校验未通过，已拒绝结束其进程树` +
        '（这些 pid 已被系统复用给无关进程，原本的终端进程应已退出，未误杀）'
    );
  }
  return {
    ok: failed.length === 0,
    closed,
    failed: failed.length,
    refused: refused.length,
    total: ids.length
  };
}

function sessionCount() {
  return sessions.size;
}

/**
 * 取某个会话的 shell 进程 pid。
 * 供诊断/测试使用（"这个标签背后到底是哪个进程"），也便于
 * 排查"标签关了但进程还在"时去任务管理器里对照。
 */
function sessionPid(sessionId) {
  return sessions.get(sessionId)?.pid ?? null;
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  spawnSession,
  writeSession,
  resizeSession,
  killSession,
  killAllSessions,
  sessionCount,
  sessionPid,
  capability,
  detectShells
};
