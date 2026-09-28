<template>
  <span
    class="spinner"
    :class="{ inline: label, [`s-${size}`]: true }"
  >
    <i class="ring" />
    <span v-if="label" class="lbl">{{ label }}</span>
  </span>
</template>

<script setup>
defineProps({
  label: { type: String, default: '' },
  size: { type: String, default: 'md' }
});
</script>

<style scoped>
.spinner {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

/*
  环的"底"原来是写死的 rgba(20,30,48,.1)：深色主题下这条底完全看不见，
  转圈时只剩一段孤零零的蓝色弧（用户看不出"这是加载中"还是"这是个图标"）。
  走 --fill-selected 叠加 token：浅色黑 13%、深色白 14%，两套都能看清整圈。
*/
.ring {
  width: 18px;
  height: 18px;
  border: 2.4px solid var(--fill-selected);
  border-top-color: var(--theme-color);
  border-radius: 50%;
  animation: ring-spin 0.7s linear infinite;
}

.spinner.s-sm .ring {
  width: 13px;
  height: 13px;
  border-width: 2px;
}

.spinner.s-lg .ring {
  width: 30px;
  height: 30px;
  border-width: 3px;
}

.spinner.inline .ring {
  width: 13px;
  height: 13px;
  border-width: 2px;
}

.lbl {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
}

@keyframes ring-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
