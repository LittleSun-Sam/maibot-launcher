<template>
  <label class="row">
    <span class="row-label" :style="labelStyle">{{ label }}</span>
    <span class="row-ctrl"><slot /></span>
  </label>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  label: { type: String, default: '' },
  width: { type: Number, default: 108 }
});

const labelStyle = computed(() => ({ width: props.width + 'px' }));
</script>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 32px;
}

.row-label {
  letter-spacing: var(--ls-sm);
  flex: none;
  font-size: 12px;
  color: var(--ink);
  line-height: 1.4;
  word-break: break-word;
}

.row-ctrl {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
