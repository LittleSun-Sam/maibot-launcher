<template>
  <!--
    无障碍：这是一块"会自己出现的状态播报区"。
    屏幕阅读器需要 aria-live 才会朗读新插入的内容，
    polite 表示"等当前朗读结束再读"，不会打断用户操作。
  -->
  <transition-group
    name="toast"
    tag="div"
    class="toast-stack"
    role="status"
    aria-live="polite"
    aria-atomic="false"
  >
    <div v-for="t in visible" :key="t.key" class="toast" :class="`t-${t.type}`">
      <IconGlyph class="toast-ico" :name="iconOf(t.type)" />
      <span class="toast-msg">{{ t.message }}</span>
      <!--
        同一条消息连续出现多次时不再堆成四行。
        实测现象：模型列表读取失败会连发四遍，四条一模一样的提示从菜单栏底下
        一路堆到页面中部，把版本卡片盖住 —— 该说的是"这件事失败了四次"，
        而不是把同一句话印四遍。合并后信息量不减，遮挡面积变成一条。
      -->
      <span v-if="t.count > 1" class="toast-count">×{{ t.count }}</span>
    </div>
  </transition-group>
</template>

<script setup>
import { computed } from 'vue';
import IconGlyph from '../IconGlyph.vue';
import { toastState } from '../../composables/useToast.js';

function iconOf(type) {
  if (type === 'success') return 'check';
  if (type === 'error') return 'close';
  if (type === 'warn') return 'bolt';
  return 'info';
}

/*
  合并规则：同类型 + 同文案视为同一条，只保留最新的一条并把次数累加。
  最多同时显示 3 条（超出的保留在队列里，前面的消失后自然顶上来）。
  SKILL §12 的"材料要有轻重"在这里的对应是：屏幕上的浮层面积要被限制住，
  否则提示一多就变成一堵墙，反而读不出任何一条。
*/
const visible = computed(() => {
  const byMsg = new Map();
  for (const t of toastState.items) {
    const key = `${t.type}|${t.message}`;
    const hit = byMsg.get(key);
    if (hit) hit.count += 1;
    else byMsg.set(key, { ...t, key, count: 1 });
  }
  return [...byMsg.values()].slice(-3);
});
</script>

<style scoped>
/*
  ⚠️ top 必须让开标题栏，不能写 14px。
  ──────────────────────────────────────────────────────────────────────
  原来 top: 14px + z-index: 9999，而标题栏是 44px 高（--titlebar-h）且承载
  **整条页面菜单栏**（AppLayout 的 .menubar：主页 / 安装麦麦 / 日志 / 更多 …）。
  于是每条提示都精确压在菜单栏上，实测表现是：
    · 提示出现的那两秒里，鼠标点菜单 = 点在 toast 上（toast 是 fixed + 高层级，
      虽然本容器 pointer-events:none，但 .toast 子项没关，会吃掉点击）；
    · 视觉上提示与导航文字叠在一起，两条信息都读不清。
  提示是"事后反馈"，导航是"随时要用" —— 冲突时提示必须让位。
  放到标题栏下沿再留 12px，居中位置不变，视觉权重也没丢。
*/
.toast-stack {
  position: fixed;
  top: calc(var(--titlebar-h) + 12px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  z-index: 9999;
  /* 容器不吃点击：它横跨整条顶部，否则会挡住下面的所有东西 */
  pointer-events: none;
}

.toast {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: flex-start;
  gap: 0.5rem;
  /* 460px 的胶囊装不下长消息（例如"一键启动"把两个服务的结果拼在一起），
     这里放宽到 600px / 92vw，并允许换行 */
  max-width: min(600px, 92vw);
  padding: 0.5rem 1rem;
  /* 圆角走 token（原来写死 12px，是 4/5/6/8/10/12/14/15/17 那串漂移值之一）。
     toast 属于浮层控件族，取控件档 --r-ctl。 */
  border-radius: var(--r-ctl);
  /*
    面与字都走 token：toast 恒为深底，字必须恒为亮色。
    原来 color 用的是 --paper-full（浅色=白，深色=#1c1f24），
    深色主题下就是"深灰字压深灰底"，实测 1.2:1，提示整条看不见。
  */
  background: var(--toast-bg);
  color: var(--toast-ink);
  font-size: 12px;
  /* 字重走 token：theme.css:58 立了"字重上限 600、中文在 700 会糊"的规矩，
     这里写死 500 数字本身没问题，但改成 token 后全站调字重只改一处。 */
  font-weight: var(--fw-medium);
  line-height: var(--lh-sm);
  box-shadow: var(--toast-shadow);
  /*
    子项也保持穿透。
    ⚠️ 不要在这里写 `pointer-events: auto`：toast 里目前**没有任何可点元素**
    （只有图标 + 文本，没有关闭按钮），恢复接收点击的唯一效果是
    "提示浮在谁头上，谁就点不动了 3 秒" —— 纯损失。
    以后**真的**加了关闭按钮时，把 auto 加在那个按钮上即可，
    不要加在 .toast 整体上。
  */
  pointer-events: none;
}

.toast-ico {
  font-size: var(--fs-body);
  flex: none;
}

/* 次数标记：数字用等宽字形，避免 ×2 与 ×11 宽度跳动导致提示条自己抖一下 */
.toast-count {
  flex: none;
  margin-left: 0.125rem;
  padding: 0 0.375rem;
  border-radius: var(--r-menu);
  background: rgb(255 255 255 / 14%);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
  opacity: 0.9;
}

.t-success .toast-ico {
  color: var(--toast-ok-ink);
}

.t-error .toast-ico {
  color: var(--toast-err-ink);
}

.t-warn .toast-ico {
  color: var(--toast-warn-ink);
}

.t-info .toast-ico {
  color: var(--toast-info-ink);
}

/*
  消息必须能读完。
  ──────────────────────────────────────────────────────────────────
  原来是 nowrap + ellipsis：超出 460px 的部分被直接吃掉，
  用户看到的是一个语义不完整的句子（"…启动失败：运行"），
  既不知道原因，也没有任何地方能查到全文 —— 提示等于没提示。
  改成允许换行、按需撑高，图标对齐首行。
*/
.toast-msg {
  white-space: normal;
  overflow-wrap: anywhere;
  min-width: 0;
}

/* 进出场走统一曲线：原来只写时长，曲线是浏览器默认的 ease，与全站不一致 */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur-slow) var(--ease-standard),
    transform var(--dur-slow) var(--ease-standard);
}

/* 进出场同一条路径（SKILL §7）：从上方 8px 处进来，也从上方 8px 处离开 */
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* 位置变化时不要瞬移，跟着曲线滑 */
.toast-move {
  transition: transform var(--dur-slow) var(--ease-standard);
}
</style>
