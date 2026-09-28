<template><div class="app-root"><AppLayout /></div></template>
<script setup>import AppLayout from './components/AppLayout.vue';</script>

<style scoped>
/*
  ⚠️ 这里**故意不写** `.app-root { height: 100% }`。
  ──────────────────────────────────────────────────────────────────────
  高度链的唯一声明点是 theme.css 的 D 段：html/body/#app 的 height:100%
  之后紧跟的那条 `.app-root`，它比这里多一个 min-height:0（滚动链要用）。

  这里曾经重复声明同一行，两处注释都自称"整页高度塌掉"的根因 ——
  于是删掉哪一处界面都不报错，哪个生效只能靠特异性去猜：scoped 会编成
  `.app-root[data-v-*]`（0,2,0），比 theme.css 的 `.app-root`（0,1,0）高一级，
  实际一直是**这里**赢。同一件事有两个"根因"、又无法验证，就是这次要消掉的噪声。
  现在只留 theme.css 一处：要改高度（含 min-height）请改那里。
*/
</style>
