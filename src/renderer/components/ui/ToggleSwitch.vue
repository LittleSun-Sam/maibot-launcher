<template>
  <button
    class="switch"
    :class="{ on: modelValue, disabled }"
    :disabled="disabled"
    type="button"
    role="switch"
    :aria-checked="String(!!modelValue)"
    @click="$emit('update:modelValue', !modelValue)"
  >
    <span class="knob" />
  </button>
</template>

<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
});

defineEmits(['update:modelValue']);
</script>

<style scoped>
/*
  开关的两处颜色原来都是写死的浅色：
    · 轨道 rgba(20,30,48,.16) —— 深色主题下是"深灰压深灰"，几乎看不见轨道，
      用户根本分不清这是开关还是一个小灰块；
    · 滑块 --paper-full（= --surface-1）—— 深色下等于卡片底色，
      关状态时滑块与轨道混成一块（对比度约 1.6:1，图形元素至少要 3:1）。
  现在轨道走叠加 token（--fill-selected：浅色是黑 13%、深色是白 14%），
  滑块走 --switch-knob（唯一的非翻转色，理由见 theme.css 里的注释）。
*/
.switch {
  position: relative;
  width: 44px;
  height: 24px;
  flex: none;
  padding: 0;
  border: none;
  border-radius: var(--r-pill);
  background: var(--fill-selected);
  cursor: pointer;
  transition: background var(--dur-slow) var(--ease);
  outline: none;
}

/*
  命中区：视觉尺寸只有 44×24，比"能舒服点中"的 36px 短边小一截，
  而它旁边紧跟着一行说明文字（间距 8px），直接加 padding 会把行高撑开。
  用一个不吃布局的伪元素向外扩 6px（44+12=56 × 24+12=36），
  既不动视觉尺寸也不挤到说明文字。
*/
.switch::before {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: var(--r-pill);
}

.switch.on {
  background: var(--theme-color);
}

/* 悬停/按下反馈：原来整颗开关没有任何交互态（鼠标压上去毫无变化）。
   关状态用 brightness 压暗一档（轨道是半透明叠加，直接换 token 反而会更亮），
   开状态与 PillButton 的实底按钮同一档提亮 —— 免得"只有开关看起来是死的"。 */
.switch:hover:not(:disabled) {
  filter: brightness(0.94);
}

.switch.on:hover:not(:disabled) {
  filter: brightness(1.06);
}

.switch:focus-visible {
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

.switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--switch-knob);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur-slow) cubic-bezier(0.25, 0, 0.25, 1);
}

.switch.on .knob {
  transform: translateX(20px);
}

/* 按下时滑块微微缩小：点下去要有"按到了"的手感（纯呈现，无逻辑） */
.switch:active:not(:disabled) .knob {
  transform: scale(0.92);
}

.switch.on:active:not(:disabled) .knob {
  transform: translateX(20px) scale(0.92);
}
</style>
