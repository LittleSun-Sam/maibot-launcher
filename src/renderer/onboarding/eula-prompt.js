/*
================================================================================
模块：src/renderer/onboarding/eula-prompt.js
职责：从麦麦的启动输出里判断「它是不是正卡在 EULA/隐私条款确认上」。
================================================================================
  为什么需要这个：
    MaiBot 的 bot.py 里 check_eula() 是**最先执行的**，在 print("检查EULA和隐私
    条款完成") 之前。首次运行（或协议更新后）它会：

        while True:
            user_input = input().strip().lower()      # ← 阻塞在这里
            if user_input in ["同意", "confirmed"]: break

    我们的启动器把麦麦的 stdout 收进日志、stdin 留成管道，但**界面上没有
    任何地方能让用户输入**。结果：全新安装点「启动」之后，界面显示"已启动"，
    麦麦却在等一行永远不会到来的输入 —— 静默卡死，没有任何报错。

  为什么不用环境变量绕过（OneKey 的做法）：
    bot.py 支持 EULA_AGREE=<md5> / PRIVACY_AGREE=<md5> 跳过确认。
    但 EULA.md 2.1 / 1.2 条要求用户**实际阅读并同意**协议内容，
    代用户注入 hash 等于在他没看过协议的情况下替他同意。
    所以这里只做"提示 + 把输入通道交回给用户"，让他在终端里自己敲「同意」。

  判定依据（对应 bot.py:159-203 的三条分支）：
    1. 只有 eula.confirmed / privacy.confirmed **两个文件都匹配当前 hash**
       → eula_confirmed && privacy_confirmed → 直接 return，**不打印任何东西**。
       所以"看到「检查EULA和隐私条款完成」"就说明确认这一步已经过了。
    2. 任一没匹配 → eula_updated || privacy_updated → 进入 input() 循环。
       这一支才是"需要用户输入"。
    3. hash 匹配环境变量 → 也是直接过，不打印。

  ⚠️ 最容易搞错的一点：
    bot.py 的提示文本里**总是**带着
    『或设置环境变量"EULA_AGREE=xxx"』这句话，即使它压根没读环境变量、
    也没真的卡住。所以绝不能拿 "EULA_AGREE" 这个词当"需要确认"的信号 ——
    那样每次启动都会误报一个"请确认协议"的横幅。
================================================================================
*/

/** bot.py:185 的提示：进入 input() 循环时打印 */
const NEED_CONFIRM_MARKERS = [
  '或设置环境变量"EULA_AGREE=',
  '或设置环境变量“EULA_AGREE=',
  /* 兼容不带引号 / 半角引号的各种落地形式 */
  '或设置环境变量EULA_AGREE='
];

/** bot.py:215 的输出：「已经确认过」的唯一正向证据 */
const CONFIRMED_MARKERS = ['检查EULA和隐私条款完成'];

/**
 * bot.py:183 的两行提示**同属一个分支**：
 *
 *     if eula_updated or privacy_updated:          # bot.py:182
 *         critical("EULA或隐私条款内容已更新…")      # 183
 *         critical('输入"同意"或"confirmed"…')       # 185
 *         while True: input()                       # 187-188  ← 卡在这
 *         return                                    # 201
 *     elif eula_confirmed and privacy_confirmed: return   # 202-203（什么都不打印）
 *
 * 所以「内容已更新」**不是**一个独立状态 —— 它只出现在"正在等输入"的那一支里。
 * 曾经这里按 `已更新 出现在 提示行 附近` 又分出一个 'updated' 状态，
 * 结果真机上误判：把「在等确认」判成了「协议更新」。
 * 那个 ±400 字符的启发式既假设了输出顺序、又假设了两行之间的距离，
 * 而真机输出里两行就是紧挨着的（间距约 35 字），全靠运气。
 * 现在合并成一个状态，判定只依赖 bot.py 里真实存在的分支差异。
 */

/**
 * 从日志里判断麦麦的 EULA 状态。
 *
 * 只看**最后**出现的相关标记：日志可能是跨多次启动累积的，
 * 上次卡住、这次已经确认过，用旧标记会得出错误结论。
 *
 * @param {string} logText 麦麦服务的 stdout/stderr 全文
 * @returns {{state:'none'|'need-confirm'|'confirmed', canAccept:boolean, hint:string}}
 *   state      none=还没走到这步 / need-confirm=在等输入 / confirmed=确认已完成
 *   canAccept  是否应该给用户一个输入通道
 *   hint       给界面直接显示的一句话
 */
export function readEulaState(logText) {
  const text = typeof logText === 'string' ? logText : '';
  if (!text) {
    return { state: 'none', canAccept: false, hint: '' };
  }

  /* 取每种标记的最后一次出现位置，谁最靠后谁才是当前状态 */
  const lastIndexOfAny = (markers) => {
    let best = -1;
    for (const m of markers) {
      const i = text.lastIndexOf(m);
      if (i > best) best = i;
    }
    return best;
  };

  const iNeed = lastIndexOfAny(NEED_CONFIRM_MARKERS);
  const iDone = lastIndexOfAny(CONFIRMED_MARKERS);

  if (iNeed < 0) {
    /* 没看到"在等输入"的提示。若看到"检查完成"，就是确认过了 */
    if (iDone >= 0) {
      return { state: 'confirmed', canAccept: false, hint: '已确认过 EULA 与隐私政策，无需再次输入' };
    }
    return { state: 'none', canAccept: false, hint: '' };
  }

  /*
    关键：如果"检查完成"出现在"等待输入"**之后**，说明用户已经输入过、
    流程走过去了 —— 这时候不能再提示"请确认"，否则横幅会一直挂着不消失。
    反之若等待输入是最新的，那就是真的卡着。
  */
  if (iDone > iNeed) {
    return { state: 'confirmed', canAccept: false, hint: '已确认过 EULA 与隐私政策，无需再次输入' };
  }

  return {
    state: 'need-confirm',
    canAccept: true,
    hint: 'MaiBot 正在等你确认 EULA 与隐私政策，请在下面输入「同意」'
  };
}

/**
 * 合法的确认词。
 * bot.py:189 只认这两个（且 user_input 已被 .lower() 处理过）。
 * 其余任何输入都会走到 else 分支，打印「请输入"同意"或"confirmed"以继续运行」
 * 并**再次进入循环** —— 所以界面不该只给一个"同意"按钮就以为万事大吉。
 */
export const ACCEPT_WORDS = ['同意', 'confirmed'];

/** 判断用户输入是否能被 bot.py 接受（用于输入框的前置校验/提示） */
export function isValidAcceptWord(word) {
  const w = String(word ?? '').trim().toLowerCase();
  return ACCEPT_WORDS.includes(w);
}
