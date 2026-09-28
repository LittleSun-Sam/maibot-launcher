<template>
  <button
    class="pill"
    :class="[`v-${variant}`, `s-${size}`, { 'is-icon': iconOnly }]"
    :disabled="disabled || loading"
    :title="title"
    @click="$emit('click', $event)"
  >
    <LoadingSpinner v-if="loading" class="pill-spin" />
    <IconGlyph v-else-if="icon" class="pill-ico" :name="icon" />
    <span v-if="!iconOnly" class="pill-txt"><slot /></span>
  </button>
</template>

<script setup>
import IconGlyph from '../IconGlyph.vue';
import LoadingSpinner from './LoadingSpinner.vue';

defineProps({
  variant: { type: String, default: 'ghost' },
  size: { type: String, default: 'md' },
  icon: { type: String, default: '' },
  iconOnly: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' }
});

defineEmits(['click']);
</script>

<style scoped>
/*
  UI v4（docs/UI-BRIEF-v4-imitate.md §责任 C）：**去药丸**。
  目标图里没有胶囊按钮了 —— 全是圆角矩形（选择框/方钮 10px、星形 pill 17px）。
  所以这里把原来那个"半高圆角"（胶囊值）一律换掉：
    · 普通按钮（默认/图标方钮）→ var(--radius-sm)，即 --r-ctl = 10px
    · 想还原"胶囊"形态的调用方（标题栏那颗星形「帮助」）自己在自己的
      scoped 样式里覆盖 border-radius；不要在公共组件里再写胶囊圆角。
  组件名仍叫 PillButton（改名会牵动 9 个页面的 import），但形态已不是药丸。
*/
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-weight: 600;
  /*
    ⚠️ <button> **不继承** body 的字体：UA 样式表把它设成 Arial。
    少了这一行时，实测同一屏里 "刷新 / 日志目录 / 新建终端" 这些按钮是
    Arial，而旁边的 .head-h2 / .zone-name 是 'Segoe UI Variable Text' ——
    中文字形与数字宽度两套混排，就是"排版错位"观感的一部分。
    （LogsPanel 的 .lv-chip/.ztool、TerminalPanel 的 .sess-tab 同类问题已就地修掉。）
  */
  font-family: inherit;
  letter-spacing: 0.2px;
  transition: background var(--dur-slow), border-color var(--dur-slow), color var(--dur-base), box-shadow var(--dur-slow), opacity var(--dur-base);
  white-space: nowrap;
}

.pill:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.s-sm {
  letter-spacing: var(--ls-sm);
  height: var(--h-ctl-sm);
  padding: 0 0.75rem;
  font-size: 12px;
}

.s-md {
  letter-spacing: var(--ls-sm);
  height: var(--h-ctl);
  padding: 0 1rem;
  font-size: 12px;
}

.pill.is-icon {
  width: var(--h-ctl);
  padding: 0;
}

.s-sm.is-icon {
  width: var(--h-ctl-sm);
}

.pill-ico {
  font-size: 13px;
  flex: none;
}

.s-sm .pill-ico {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
}

.pill-spin {
  font-size: 13px;
}

.v-solid {
  background: var(--theme-color);
  /* 不能写 --paper-full：浅色下它恰好是白色（看着对），深色下等于 --surface-1
     = #1c1f24，于是变成"深墨字压亮蓝底"。--on-accent 是专为实底强调色准备的，
     浅色 #ffffff（对 #2b6cff 4.48:1）/ 深色 #101216（对 #5b8dff 5.98:1）。 */
  color: var(--on-accent);
  box-shadow: 0 3px 10px var(--theme-tint);
}

.v-solid:hover:not(:disabled) {
  filter: brightness(1.06);
}

.v-ghost {
  background: var(--paper-solid);
  border-color: var(--line-strong);
  color: var(--ink);
}

.v-ghost:hover:not(:disabled) {
  border-color: var(--theme-line);
  color: var(--theme-color);
  /* v4：hover 底改成淡蓝强调叠色 —— 原来写的是 rgba(255,255,255,.7)，
   * 在白卡上等于"没变化"，在深色主题里更是一块突兀的白斑 */
  background: var(--theme-tint);
}

.v-danger {
  background: var(--danger-bg);
  color: var(--err-ink);
  /* 目标图的红色方钮是"淡红底 + 红描边"，不是实心红 */
  border-color: var(--err-line-bright);
}

.v-danger:hover:not(:disabled) {
  background: var(--danger-bg-hover);
}

.v-plain {
  background: transparent;
  color: var(--ink-soft);
}

.v-plain:hover:not(:disabled) {
  /* v4：同上，白叠加换成 token 化叠加（深浅两套都成立） */
  background: var(--fill-hover);
  color: var(--ink);
}
</style>
