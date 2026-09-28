/*
  图标尺寸契约（写下来，免得下次又被当成"五种随手值"）
  --------------------------------------------------------------------------
  .glyph 用的是 width: 1em / height: 1em —— 图标尺寸**跟随所在文字的字号**。
  这是刻意的：小字旁边的小图标、标题旁边的大图标，本来就应该同比例，
  否则同一行里图标和文字会显得一大一小（SKILL §16.7：对齐与比例必须是有意的）。

  因此：
    · 默认不要给图标写死 width/height，让它跟着字号走；
    · 需要脱离文字单独站着的图标（导航、工具栏、空状态）才覆盖尺寸，
      并且只允许两档：14px（与正文同期，内联固定用）和 16px（强调用）；
    · 30px 以上的属于插画级装饰（空状态大图标），不算图标档位。
*/<template>
  <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="markup"></svg>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, default: 'grid' }
});

const shapes = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  puzzle: '<path d="M10 3.5h3.2a.8.8 0 0 1 .8.8v1.9a2.1 2.1 0 1 0 0 4.2v1.9a.8.8 0 0 1-.8.8H11v2.6a2.1 2.1 0 1 1-4.2 0V13H4.9a.8.8 0 0 1-.8-.8 2.1 2.1 0 1 1 0-4.2.8.8 0 0 1 .8-.8h1.9V5.3a.8.8 0 0 1 .8-.8H10z"/>',
  download: '<path d="M12 4v10"/><path d="m7.2 10.2 4.8 4.8 4.8-4.8"/><path d="M4.8 19h14.4"/>',
  stream: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.4" cy="6.5" r="1.4"/><circle cx="4.4" cy="12" r="1.4"/><circle cx="4.4" cy="17.5" r="1.4"/>',
  wand: '<path d="M14.8 6.4a3.6 3.6 0 0 0 4.8 4.8L10 20.8a1.9 1.9 0 0 1-2.7-2.7z"/><path d="M18 2.4v2.6M21.6 6h-2.6M19.6 3.6l1.9 1.9"/>',
  sliders: '<path d="M4 6.5h8M16.5 6.5H20M4 12h3.5M12 12h8M4 17.5h9M17 17.5h3"/><circle cx="14.2" cy="6.5" r="1.9"/><circle cx="9.7" cy="12" r="1.9"/><circle cx="15" cy="17.5" r="1.9"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11.2v5"/><circle cx="12" cy="8.2" r="0.9" fill="currentColor" stroke="none"/>',
  play: '<path d="M8.5 5.6v12.8L19 12z"/>',
  stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.2 4.2v4.2H16"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.6 7l.9 12.4h9l.9-12.4"/>',
  check: '<path d="m5 12.4 4.2 4.2L19 6.8"/>',
  close: '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
  scan: '<path d="M4 8.4V5.4a1.4 1.4 0 0 1 1.4-1.4h3M15.6 4h3A1.4 1.4 0 0 1 20 5.4v3M20 15.6v3a1.4 1.4 0 0 1-1.4 1.4h-3M8.4 20h-3A1.4 1.4 0 0 1 4 18.6v-3"/><path d="M4 12h16"/>',
  folder: '<path d="M3.6 7.2a1.2 1.2 0 0 1 1.2-1.2h4.4l2 2h8a1.2 1.2 0 0 1 1.2 1.2v8.4a1.2 1.2 0 0 1-1.2 1.2H4.8a1.2 1.2 0 0 1-1.2-1.2z"/>',
  bolt: '<path d="M13.4 2.6 5 13.4h5.4l-.8 8 8.4-10.8h-5.4z"/>',
  cube: '<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z"/><path d="M4 7.6 12 12l8-4.4M12 12v8.8"/>',
  link: '<path d="M9.6 14.4 14.4 9.6"/><path d="M11 6.8l1.6-1.6a3.4 3.4 0 0 1 4.8 4.8L15.8 11.6"/><path d="M13 17.2l-1.6 1.6a3.4 3.4 0 0 1-4.8-4.8L8.2 12.4"/>',
  bot: '<rect x="4.3" y="8.2" width="15.4" height="11.2" rx="3.4"/><path d="M12 4.7v3.5"/><circle cx="12" cy="3.5" r="1.3"/><circle cx="9.4" cy="12.6" r="1.4"/><circle cx="14.6" cy="12.6" r="1.4"/><path d="M9.7 16.5h4.6"/>',
  cat: '<path d="M6.3 9.3 5.1 4.4l4.4 2.3M17.7 9.3l1.2-4.9-4.4 2.3"/><circle cx="12" cy="12.4" r="6.3"/><circle cx="9.5" cy="11.4" r="1.05"/><circle cx="14.5" cy="11.4" r="1.05"/><path d="M2.8 12.4h2.6M18.6 12.4h2.6"/>',
  chat: '<path d="M4.2 6.4A2.2 2.2 0 0 1 6.4 4.2h11.2a2.2 2.2 0 0 1 2.2 2.2v8.2a2.2 2.2 0 0 1-2.2 2.2H10.4L6.8 20.4V16.8H6.4a2.2 2.2 0 0 1-2.2-2.2z"/>',
  save: '<path d="M7 4h8.6L19 7.4V16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><rect x="8" y="12.4" width="8" height="5.2" rx="1"/><path d="M9 8.8h6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.6 15H5a1.4 1.4 0 0 1-1.4-1.4V5.4A1.4 1.4 0 0 1 5 4h8.2A1.4 1.4 0 0 1 14.6 5.4V6"/>',
  'chev-down': '<path d="m6.6 9.4 5.4 5.4 5.4-5.4"/>',
  'chev-up': '<path d="m6.6 14.6 5.4-5.4 5.4 5.4"/>',
  terminal: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.4"/><path d="m7.4 10.2 2.4 2.4-2.4 2.4M12.6 15h4"/>'
};

const markup = computed(() => shapes[props.name] || shapes.grid);
</script>

<style scoped>
.glyph {
  width: 1em;
  height: 1em;
  display: block;
}
</style>
