<template>
  <!--
    UI v4（docs/UI-BRIEF-v4-imitate.md §责任 C）：**从"彩色药丸"改成"小圆点 + 文字"**。
    目标图里 MaiBot 的状态是「● 已停止」这种形态 —— 一个 8px 的实心圆点 + 一行
    中性色文字，底色/描边全部去掉。原来的彩色胶囊（胶囊底 + 同色字）在目标图里
    找不到对应物，而且四张卡片堆叠时满屏色块，正是上一版"不像"的原因之一。

    颜色分工（对照 theme.css 的语义色注释）：
      · 圆点是图形元素 → 用 --ok/--warn/--err/--stop 本体（对比度只需 ≥3:1）
      · 文字是要读的   → 用 *-ink（白底/深底都 ≥4.5:1），绝不能拿本体色当文字色
  -->
  <span class="badge" :class="`b-${tone}`">
    <i v-if="dot" class="dot" aria-hidden="true" />
    <span class="badge-txt"><slot /></span>
  </span>
</template>

<script setup>
defineProps({
  tone: { type: String, default: 'neutral' },
  /*
    v4：圆点默认**开着**。目标图里每个状态前面都有点，而 dot 的旧默认是 false，
    调用方（OverviewPanel / AboutPanel）有的传了有的没传 —— 默认 false 会让同一
    个组件在两张卡上长得不一样。默认 true 后，不传也能得到目标图那种「● 文字」。
  */
  dot: { type: Boolean, default: true }
});
</script>

<style scoped>
/* 去药丸：没有底、没有描边、没有 999px，只是一行点 + 字 */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0;
  background: none;
  border: none;
  border-radius: 0;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  line-height: var(--lh-sm);
  letter-spacing: 0.2px;
  white-space: nowrap;
  color: var(--ink-soft);
}

/* 8px 圆点：目标图里状态点的尺寸。flex: none 防止被长文字挤扁 */
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--stop);
}

.badge-txt {
  min-width: 0;
}

/* --- 中性：已停止 / 未知。用 --stop（灰）而不是画一个假的状态色 ---------- */
.b-neutral {
  color: var(--ink-soft);
}

.b-neutral .dot {
  background: var(--stop);
  box-shadow: 0 0 0 1px var(--stop-line);
}

/* --- 强调：版本号这类"品牌色"标签 ---------------------------------------- */
/*
  ⚠️ 文字必须用 --accent-ink，不能直接用 --accent：
  --accent（浅色 #2b6cff）是给"实底 + 白字"准备的，拿它当 12px 正文色时
  对白底只有 4.48:1，刚好压在 AA 线下（主题注释里也写了这一档是 AA 临界）。
  --accent-ink 浅色 var(--accent-hover) = 5.84:1、深色 #7ba4ff = 5.86:1，两套都稳过。
  圆点仍然用 --accent 本体（图形只需 3:1，且要和按钮同色系）。
*/
.b-theme {
  color: var(--accent-ink);
}

.b-theme .dot {
  background: var(--theme-color);
}

/* --- 运行中（绿） -------------------------------------------------------- */
.b-ok {
  color: var(--ok-ink);
}

.b-ok .dot {
  background: var(--ok);
  box-shadow: 0 0 0 1px var(--ok-line);
}

/* --- 需要注意（黄） ------------------------------------------------------ */
.b-warn {
  color: var(--warn-ink);
}

.b-warn .dot {
  background: var(--warn);
  box-shadow: 0 0 0 1px var(--warn-line);
}

/* --- 出错 / 不可用（红） ------------------------------------------------- */
.b-err {
  color: var(--err-ink);
}

.b-err .dot {
  background: var(--err);
  box-shadow: 0 0 0 1px var(--err-line);
}
</style>
