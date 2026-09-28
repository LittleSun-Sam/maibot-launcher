<template>
  <section class="card">
    <header v-if="title || $slots.head" class="card-head">
      <div class="card-head-main">
        <h3 v-if="title" class="card-title">{{ title }}</h3>
        <p v-if="desc" class="card-desc">{{ desc }}</p>
      </div>
      <slot name="head" />
    </header>
    <div class="card-body">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  desc: { type: String, default: '' }
});
</script>

<style scoped>
/*
  UI v4（docs/UI-BRIEF-v4-imitate.md §1.3 / §责任 C）：卡片的形态照目标图抄。
    · 圆角 14px（--r-card，原来是 12）
    · 淡蓝描边 1px（--card-line：浅色 rgba(43,108,255,.06) / 深色白 8%）
    · 蓝调阴影（--shadow-card：浅色 0 8px 24px rgba(43,108,255,.08)；
      深色必须换成中性黑阴影，蓝阴影在深底上等于看不见）
    · **去掉 backdrop-filter**: 目标图那张卡是"实白卡 + 描边 + 阴影"，
      没有任何玻璃模糊；而且 blur 会让卡后面的 hero 插画透上来，
      在浅色主题下把正文对比度拖下去（上一版 P0 之一）。
    · 三处写死的浅色值（rgba(255,255,255,.72) 描边、rgba(20,30,48,.05) 阴影）
      全部换成 token —— 深色主题下白描边 + 黑阴影是"深色外壳里冒白卡"的元凶。
*/
.card {
  position: relative;
  border-radius: var(--r-card);
  background: var(--card-bg);
  border: 1px solid var(--card-line);
  box-shadow: var(--shadow-card);
  padding: 1.375rem; /* 目标图卡片内边距约 22px（原来是 15/17/16） */
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}

/*
  head 插槽里放**多个**元素时，它们不会被父组件的 scoped 样式选中
  （scoped 只给本组件模板里的元素加 data 属性），所以父级的 gap 管不到它们 ——
  两个按钮/徽章会紧贴在一起。用 :slotted() 才能穿透到插槽内容。
  这里做两件事：让插槽内的元素成为 flex 子项（获得 gap 间距），并让它们成组靠右。
*/
.card-head :slotted(*) {
  flex: none;
  align-self: center;
}

/* 插槽里放了多个元素时，给它们自己一点间距，避免贴在一起 */
.card-head :slotted(* + *) {
  margin-left: 0.5rem;
}

.card-head-main {
  flex: 1;
  min-width: 0;
}

/*
  卡片标题。
  ──────────────────────────────────────────────────────────────────────
  原来写的是 font-size: 13px / font-weight: 600，两处都违反 theme.css 自己立的规矩：
    · theme.css:56 定义了 --fs-title: 15px / --lh-title: 22px，注释明写"标题 15/600"；
    · theme.css:58 明写"字重上限 600：中文在 700 会糊"，并给了 --fw-bold = 600。
  实测（1280×720 逐页量）也印证了问题：全站字号出现 13.5px 这个**非整数值**，
  而标题档 15px 在整站只有极少数地方用到 —— 说明这个 token 基本没被消费，
  标题层级只能靠"加粗到 700"来撑，于是又踩了字重上限。

  改走 token 后同时解决三件事：
    1) 标题与正文的层级差从"0.5px + 100 字重"变成"2px + 规范字重"，更清楚；
    2) line-height 与字号成对绑定（22px），不会再出现"改字号忘行高"；
    3) 全站标题只由 theme.css 一处控制。
*/
.card-title {
  margin: 0;
  font-size: var(--fs-title);
  line-height: var(--lh-title);
  font-weight: var(--fw-bold);
  color: var(--ink-strong);
  letter-spacing: 0.2px;
}

.card-desc {
  letter-spacing: var(--ls-sm);
  margin: 0.25rem 0 0;
  font-size: 12px;
  color: var(--ink-soft);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
