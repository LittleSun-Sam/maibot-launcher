/*
================================================================================
模块：src/renderer/onboarding/gate.js
职责：新手引导「该不该自动弹 / 打开时用什么形态」的纯决策逻辑。
================================================================================
  为什么把它单独抽出来：
    第一版把「不要再自动弹」和「永远不能再打开」合并成一个 dismissed 标记，
    结果用户点一次关闭，引导就彻底消失、再也找不到 —— 这正是用户反馈的
    「收起后直接就没了」。
    这类 bug **不会报错**，只会让入口静默消失，所以必须有断言守住。
    抽成纯函数后，scripts/verify-onboarding.mjs 可以直接喂各种
    localStorage 状态组合，逐条断言，不需要跑起 Electron。

  核心不变量（最重要的一条）：
    「已经自动弹过」永远**不能**推导出「不能手动打开」。
    换句话说：autoOpen 只影响"自动"，manual 入口永远可用。
================================================================================
*/

/** 持久化键 */
export const KEYS = {
  /** 是否已经自动弹过一次（只用于抑制自动展开，不影响手动打开） */
  autoOpened: 'onboarding.autoOpened',
  /** 已完成步骤 id 列表 */
  doneIds: 'onboarding.doneIds',
  /** 自检/探针环境标记：不自动弹，避免干扰路由断言 */
  suppress: 'onboarding.suppress',
  /** 第一版用过的旧键，等价于 autoOpened，仅为兼容老用户 */
  legacyDismissed: 'onboarding.dismissed'
};

/** 从 localStorage 形态的普通对象解析出引导状态（纯函数，便于测试） */
export function readState(read, totalSteps = 0) {
  const get = (k, d = '') => {
    try {
      const v = typeof read === 'function' ? read(k) : undefined;
      return v == null ? d : v;
    } catch (_) {
      return d;
    }
  };

  let doneIds = [];
  try {
    const parsed = JSON.parse(get(KEYS.doneIds, '[]'));
    if (Array.isArray(parsed)) doneIds = parsed.filter((x) => typeof x === 'string');
  } catch (_) {
    doneIds = [];
  }

  const total = Number(totalSteps) || 0;
  return {
    /* 旧键也算"弹过"，否则升级上来的用户会被再弹一次 */
    autoOpened: get(KEYS.autoOpened) === '1' || get(KEYS.legacyDismissed) === '1',
    suppressed: get(KEYS.suppress) === '1',
    doneIds,
    doneCount: doneIds.length,
    total,
    allDone: total > 0 && doneIds.length >= total
  };
}

/**
 * 决定应用启动时要不要**自动**展开引导。
 *
 * 注意返回值里没有任何"禁止打开"的字段 —— 这个函数无权关掉手动入口。
 *
 * @returns {{open:boolean, markAutoOpened:boolean, reason:string}}
 */
export function decideAutoOpen(state) {
  if (state.suppressed) {
    return { open: false, markAutoOpened: false, reason: 'suppressed' };
  }
  if (state.autoOpened) {
    return { open: false, markAutoOpened: false, reason: 'already-auto-opened' };
  }
  if (state.allDone) {
    /* 全部做完了就别自己蹦出来了，但入口照旧常驻 */
    return { open: false, markAutoOpened: true, reason: 'completed' };
  }
  return { open: true, markAutoOpened: true, reason: 'first-run' };
}

/**
 * 决定手动打开时用哪种形态。
 *   guide     —— 交互式，能勾选
 *   reference —— 只读参考资料（全做完之后再让你勾一遍没意义）
 */
export function decideMode(state, requested) {
  if (requested === 'guide' || requested === 'reference') return requested;
  return state.allDone ? 'reference' : 'guide';
}

/** 顶栏徽标要显示的文字（纯函数，便于断言） */
export function badgeText(state) {
  if (state.total <= 0) return '';
  if (state.allDone) return '✓';
  return `${state.doneCount}/${state.total}`;
}
