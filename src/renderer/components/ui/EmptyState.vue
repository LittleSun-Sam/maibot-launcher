<template>
  <div class="empty">
    <IconGlyph class="empty-ico" :name="icon" />
    <p class="empty-text">{{ text }}</p>
  </div>
</template>

<script setup>
import IconGlyph from '../IconGlyph.vue';

defineProps({
  icon: { type: String, default: 'cube' },
  text: { type: String, default: '暂无数据' }
});
</script>

<style scoped>
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2.125rem 0.75rem;
  color: var(--ink-faint);
}

.empty-ico {
  font-size: 26px;
  opacity: 0.65;
}

.empty-text {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
}
</style>
