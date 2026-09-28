/*
================================================================================
技术文档：src/main/services/exit-codes.js
职责：把 Windows / NTSTATUS 的进程退出码翻译成人能读懂的原因。

为什么需要这一层：
    Windows 上被托管的服务异常退出时，Node 给出的 code 往往是一个巨大的负数，
    例如控制台会话被 Ctrl+C 或窗口关闭中断时的 `-1073741510`
    （无符号即 0xC000013A = STATUS_CONTROL_C_EXIT）。
    原实现直接把这个数字抛给用户看：
        「MaiBot 异常退出（退出码 -1073741510）」
    用户既不知道发生了什么，也不知道该怎么办，只能来问。而绝大多数情况下
    真正的原因是"你按了 Ctrl+C"或"那个命令行窗口被关掉了"——这属于正常操作，
    不该被当成崩溃来吓人。

设计取舍：
  · 只覆盖**托管服务真的会碰到**的常见码，不做全表照抄（几百个 NTSTATUS
    全列出来只会变成噪音，维护成本也高）。
  · 返回对象而不是字符串，把「是否属于正常/预期结束」一并给出，
    让调用方可以据此决定告警级别 —— 这正是本模块最大的价值：
    Ctrl+C 结束不该报红色错误，更不该触发看门狗重启。
  · 无法识别时返回 null 的 reason，由调用方决定怎么展示原始码，
    绝不编造一个看着像模像样的解释。
================================================================================
*/

/**
 * 常见 Windows 退出码表。
 * key 为**无符号 32 位**十六进制（大写，不带 0x）。
 */
const WINDOWS_EXIT_CODES = {
  C000013A: {
    reason: '控制台会话被中断（通常是按了 Ctrl+C，或命令行窗口被关闭）',
    expected: true
  },
  C0000139: {
    reason: '程序尝试读取一个并非控制台的输入句柄（常见于后台运行时缺少控制台）',
    expected: false
  },
  C0000005: {
    reason: '内存访问冲突（程序内部错误，或被安全软件注入/拦截）',
    expected: false
  },
  C000001D: { reason: '执行了非法指令（程序文件可能已损坏，或 CPU 不支持）', expected: false },
  C0000094: { reason: '整数除零错误（程序内部错误）', expected: false },
  C00000FD: { reason: '栈溢出（程序内部错误）', expected: false },
  C0000409: {
    reason: '检测到缓冲区溢出，已强制终止（通常由系统安全机制触发）',
    expected: false
  },
  C0000374: { reason: '堆内存被破坏（程序内部错误，也可能与注入的模块冲突）', expected: false },
  C0000142: {
    reason: 'DLL 初始化失败（依赖的运行库缺失或版本不匹配）',
    expected: false
  },
  C0000135: {
    reason: '找不到所需的 DLL（通常是缺少 Visual C++ 运行库或 Node 原生模块）',
    expected: false
  },
  C000012F: { reason: '映像文件校验失败（程序文件不完整，建议删除后重新安装）', expected: false },
  C000007B: { reason: '映像格式无效（下载的包架构不对或已损坏，建议重新下载）', expected: false },
  C0000420: { reason: '断言失败（程序内部错误）', expected: false }
};

/** Unix 风格信号码（Windows 上很少见，但跨平台兜底） */
const SIGNAL_REASONS = {
  SIGINT: '收到中断信号（Ctrl+C）',
  SIGTERM: '收到终止请求',
  SIGKILL: '进程被强制杀死',
  SIGHUP: '控制终端已断开'
};

/**
 * 解释一个进程退出结果。
 *
 * @param {number|null|undefined} code  Node 给出的退出码（Windows 上常为负）
 * @param {string|null} [signal]        退出信号（Windows 上通常为 null）
 * @returns {{reason:string|null, expected:boolean, hex:string|null, display:string}}
 *          reason 为 null 表示无法识别；display 是可直接展示的短文本。
 */
function explainExit(code, signal) {
  /* 正常退出 */
  if (code === 0 && !signal) {
    return { reason: '进程正常结束', expected: true, hex: '0', display: '正常结束（退出码 0）' };
  }

  /* 被信号结束：Windows 上少见，但真出现时要能说清 */
  if ((code === null || code === undefined) && signal) {
    const reason = SIGNAL_REASONS[signal] || null;
    return {
      reason,
      expected: signal === 'SIGTERM' || signal === 'SIGINT',
      hex: null,
      display: reason ? `${reason}（signal=${signal}）` : `被信号结束（signal=${signal}）`
    };
  }

  /* 看门狗只发现了"进程消失"，既没有码也没有信号 */
  if (code === null || code === undefined) {
    return { reason: null, expected: false, hex: null, display: '进程已意外终止（未取得退出码）' };
  }

  /*
    归一化为无符号 32 位再查表。
    Node 在 Windows 上把 0xC000013A 报成 -1073741510，
    两者是同一个数的有符号/无符号表示，必须统一后再匹配。
  */
  const unsigned = code >>> 0;
  const hex = unsigned.toString(16).toUpperCase().padStart(8, '0');
  const hit = WINDOWS_EXIT_CODES[hex];

  if (hit) {
    return {
      reason: hit.reason,
      expected: hit.expected,
      hex: `0x${hex}`,
      display: `${hit.reason}（退出码 ${code} / 0x${hex}）`
    };
  }

  return {
    reason: null,
    expected: false,
    hex: `0x${hex}`,
    display: `退出码 ${code}（0x${hex}，未识别的退出码）`
  };
}

module.exports = { explainExit, WINDOWS_EXIT_CODES };
