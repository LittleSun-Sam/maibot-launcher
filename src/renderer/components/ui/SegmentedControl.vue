<template>
  <!--
    三选一的分段控件（浅色 / 深色 / 跟随系统）。
    ──────────────────────────────────────────────────────────────────────
    为什么用 role="radiogroup" + role="radio" 而不是三个普通 button：
      这是一组互斥的**选项**，语义上是单选；读屏会念成"单选按钮组，浅色，
      已选中第 1 项，共 3 项"，而不是三个各自孤立的按钮。
    键盘：方向键在选项间移动（roving tabindex，只有当前选中项可 Tab 到），
      这是 WAI-ARIA radiogroup 的标准交互，也是 Windows 上原生单选组的习惯。
  -->
  <div class="seg" role="radiogroup" :aria-label="label">
    <button
      v-for="(opt, i) in options"
      :key="opt.value"
      type="button"
      role="radio"
      class="seg-btn"
      :class="{ on: modelValue === opt.value }"
      :aria-checked="modelValue === opt.value ? 'true' : 'false'"
      :tabindex="modelValue === opt.value || (modelValue == null && i === 0) ? 0 : -1"
      :disabled="disabled"
      :title="opt.hint"
      :data-testid="`seg-${opt.value}`"
      @click="$emit('update:modelValue', opt.value)"
      @keydown="onKeydown($event, i)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<script setup>
/*
  通用分段选择器。
  抽出来是因为设置页需要它，而仓库里此前没有这个控件（只有各页手写的 tab 条）。
  props 刻意保持最小：只做"单个值 + 一组选项"，不引入多选 / 尺寸变体 ——
  用不到的能力等于以后要维护的负担。
*/
const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  /** [{ value, label, hint? }] */
  options: { type: Array, default: () => [] }
});

const emit = defineEmits(['update:modelValue']);

/*
  方向键漫游：左右/上下都接受（radiogroup 两者都常用），Home/End 跳首尾。
  选中即切换（不留"移动焦点但没选中"的中间态）—— 主题这种按钮，
  用户按下方向键的意图就是"换到这个"。
*/
function onKeydown(e, i) {
  const n = props.options.length;
  if (!n) return;
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % n;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + n) % n;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = n - 1;
  if (next === null || props.disabled) return;
  e.preventDefault();
  const target = props.options[next];
  emit('update:modelValue', target.value);
  /* 把焦点也移过去，否则 Tab 出去再回来会跳回旧项 */
  const btns = e.currentTarget.parentElement?.querySelectorAll('.seg-btn');
  btns?.[next]?.focus();
}
</script>

<style scoped>
/*
  托盘走 --seg-bg / 选中项 --seg-active-bg（这两个 token 此前零引用，
  见审计 R-14；它们是专为"分段控件"补的，深色下不会翻转成亮底）。
  高度走 --h-ctl-sm（28px），与同类小控件对齐（审计 R-09）。
*/
.seg {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  flex: none;
  padding: 0.125rem;
  height: var(--h-ctl-sm);
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--seg-bg);
}

.seg-btn {
  position: relative;
  height: 100%;
  padding: 0 0.75rem;
  border: none;
  border-radius: var(--r-menu);
  background: transparent;
  color: var(--ink-soft);
  font-family: inherit;
  font-size: 12px;
  font-weight: var(--fw-medium);
  letter-spacing: 0.2px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

/* 命中区：视觉尺寸刻意做得紧凑（主题三选一实测 48x22 / 73x22，短边差 2px），
   小于"能舒服点中"的 24px 下限。用不吃布局的伪元素向外扩（与 ToggleSwitch 同一手法），
   视觉尺寸与留白完全不变，只把可点区域补足。 */
.seg-btn::after {
  content: '';
  position: absolute;
  inset: -2px 0;
}

.seg-btn:hover:not(:disabled):not(.on) {
  background: var(--row-bg-hover);
  color: var(--ink-strong);
}

/* 选中项：浮起底 + 强调字，不用实底蓝（设置页里三颗实底蓝会过重） */
.seg-btn.on {
  background: var(--seg-active-bg);
  color: var(--accent-ink);
  box-shadow: var(--seg-active-shadow);
}

/*
  ⚠️ 焦点环必须用 --focus-ring（而不是就地写 2.5px 的 --theme-tint）：
  tint 只有 10% 透明度，键盘用户几乎看不到当前位置（审计 R-19）。
  :focus-visible 而不是 :focus —— 鼠标点完不要留一圈环。
*/
.seg-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.seg-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
