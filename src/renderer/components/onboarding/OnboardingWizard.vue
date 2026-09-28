<!--
================================================================================
组件：OnboardingWizard.vue
职责：首次启动的「保姆级」新手引导。
================================================================================
  设计原则（与用户明确约定）：
    1. **纯只读** —— 只检测环境、只告诉你下一步去哪点，绝不替你改任何文件。
       需要动手的步骤给出「打开对应页面」的跳转，而不是代劳。
    2. **不自动勾选** —— 每一步都必须用户自己点「完成」。
       自动打勾会制造"看起来配好了"的假象，而那正是这个项目要消灭的东西。
    3. **给真实证据** —— 每一步都显示探测到的真实值（SnowLuma 目录与入口、
       Python 版本、MaiBot 版本、适配器插件…），而不是一段空泛的说明文字。

  步骤来源：官方文档 docs.mai-mai.org（已联网核对），不是照源码猜的。
  关键事实：
    · 协议端只有 SnowLuma：独立 Node 程序，自带 WebUI，**不需要装 QQ 客户端**
    · 官方 SnowLuma 适配器只支持 MaiBot ≥ 1.2.0
    · 0.6.x 是完全不同的架构（配置字段/适配器形态/WS 方向/依赖数据库都不同）
    · 首次启动 MaiBot 必须在终端输入中文「同意」（不是 yes/y）
    · WebUI 在 http://localhost:8001，登录用终端打印的临时 Token（每次启动都变）
    · 必须先配 LLM 模型，否则麦麦不会说话
    · SnowLuma 默认只开 WebUI，OneBot 正向 WS 服务器要在它自己的 WebUI 里现建
    · 适配器的 enable_chat_list_filter 默认 true 且名单为空 → 消息全被丢弃
================================================================================
-->
<template>
  <Transition name="wiz" :css="animOk">
    <div v-if="open" class="wiz-mask">
      <!-- 遮罩不吃点击：左侧导航与安装器页仍要能正常操作 -->
      <aside class="wiz" role="dialog" aria-label="新手引导">
        <header class="wiz-head">
          <div class="wiz-head-l">
            <IconGlyph name="wand" class="wiz-ico" />
            <div>
              <p class="wiz-title">
                从零开始
                <span v-if="!guideMode" class="wiz-mode">参考资料</span>
              </p>
              <p class="wiz-sub">{{ doneCount }}/{{ steps.length }} 步 · {{ progressText }}</p>
            </div>
          </div>
          <PillButton variant="ghost" size="sm" icon="close" icon-only title="收起（右上角「新手引导」随时可再打开）" @click="close" />
        </header>

        <div class="wiz-bar"><span class="wiz-bar-fill" :style="{ transform: 'scaleX(' + pct / 100 + ')' }" /></div>

        <div class="wiz-body">
          <!-- 全部完成：撒花 -->
          <div v-if="allDone" class="wiz-done">
            <div class="confetti" aria-hidden="true">
              <i v-for="i in 40" :key="i" :style="confettiStyle(i)" />
            </div>
            <p class="done-title">🎉 全部搞定，可以开始聊天了！</p>
            <p class="done-sub">
              去群里 @ 一下麦麦试试。如果没反应，先到「总览」页做一次接线自检 ——
              OneBot 端口与适配器插件两项都得就绪；适配器的群聊名单默认是空的，
              不把群号加进去，消息会被全部丢掉。
            </p>
            <p class="done-sub done-hint">
              这份教程随时可以在右上角「新手引导」里重新打开 ——
              它不是看过一次就消失的弹窗。
            </p>
            <PillButton variant="solid" size="sm" icon="link" @click="openMaibotWebui">
              打开 MaiBot WebUI
            </PillButton>
          </div>

          <ol v-else class="steps">
            <li
              v-for="(s, i) in steps"
              :key="s.id"
              class="step"
              :class="{ done: s.done, cur: i === cursor && !s.done, far: i > cursor && !s.done }"
            >
              <div class="step-head" @click="cursor = i">
                <span class="step-mark">
                  <IconGlyph v-if="s.done" name="check" />
                  <template v-else>{{ i + 1 }}</template>
                </span>
                <span class="step-title">{{ s.title }}</span>
                <IconGlyph :name="i === cursor ? 'chev-up' : 'chev-down'" class="step-chev" />
              </div>

              <div v-if="i === cursor || s.done" class="step-body">
                <p class="step-why">{{ s.why }}</p>

                <!-- 真实证据 -->
                <ul v-if="s.facts && s.facts.length" class="facts">
                  <li v-for="(f, k) in s.facts" :key="k" :class="f.tone || ''">
                    <span class="fact-dot" />{{ f.text }}
                  </li>
                </ul>

                <p v-if="s.warn" class="step-warn">{{ s.warn }}</p>

                <!-- 动作：只跳转/复制，不改文件 -->
                <div class="step-actions">
                  <PillButton
                    v-for="a in s.actions"
                    :key="a.key"
                    :variant="a.primary ? 'solid' : 'ghost'"
                    size="sm"
                    :icon="a.icon"
                    :loading="busy === a.key"
                    @click="runAction(a)"
                  >
                    {{ a.label }}
                  </PillButton>

                  <template v-if="guideMode">
                    <PillButton
                      v-if="!s.done"
                      :variant="s.ready ? 'solid' : 'ghost'"
                      size="sm"
                      icon="check"
                      @click="markDone(s)"
                    >
                      我已完成
                    </PillButton>
                    <PillButton v-else variant="ghost" size="sm" @click="unmark(s)">
                      撤销
                    </PillButton>
                  </template>
                </div>
              </div>
            </li>
          </ol>
        </div>

        <footer class="wiz-foot">
          <span class="foot-note">
            引导只做检测和跳转，<strong>不会修改你的任何文件</strong>
          </span>
          <div class="foot-btns">
            <PillButton variant="ghost" size="sm" :loading="detecting" @click="detect">
              重新检测
            </PillButton>
            <PillButton
              v-if="guideMode && doneCount > 0"
              variant="ghost"
              size="sm"
              icon="refresh"
              title="清空勾选，从第一步重新走一遍"
              @click="restart"
            >
              重来一遍
            </PillButton>
          </div>
        </footer>
      </aside>
    </div>
  </Transition>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/*
  ---------------------------------------------------------------- 过渡的"保命开关"

  ⚠️ 窗口不可见时（最小化 / 被别的窗口完全遮住）Chromium **不产生帧**：
       · 过渡的 transitionend 永远不会来；
       · Vue 的 nextFrame()（双 rAF）永远不触发；
       · 兜底的 setTimeout 被限流到秒/分钟级。
     于是 <Transition> 的离场收不了尾 —— 实测：点弹窗的「取消」后节点既不从
     DOM 移除、类名也停在 picker-enter-from picker-enter-active，
     表现就是"取消 / Esc / 点遮罩都关不掉"，用户被弹窗挡住。

  正解是让 Vue 在这种情况下**不要挂过渡**：
     <Transition :css="animOk">，animOk 只在窗口可见时为真。
     依据是 Vue 自己的实现（@vue/runtime-dom 的 resolveTransitionProps）：
         if (rawProps.css === false) { return baseProps; }
     css=false 时它不加类、不 nextFrame、不等 transitionend，
     元素同步插入/移除，不依赖任何帧。可见时照旧走原来的动画。

  同源问题在 AppLayout 的换页过渡里已经用 skipSwap 处理过（那里注释更细）。
*/
const animOk = ref(true);
function syncAnimOk() {
  animOk.value = document.visibilityState === 'visible';
}
onMounted(() => {
  syncAnimOk();
  document.addEventListener('visibilitychange', syncAnimOk);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', syncAnimOk));
import IconGlyph from '../IconGlyph.vue';
import PillButton from '../ui/PillButton.vue';
import { toast } from '../../composables/useToast.js';
import {
  detectAll,
  maibotWebuiToken,
  openExternal,
  isPortOpen
} from '../../stores/app-store.js';
import { buildSteps } from '../../onboarding/steps.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  /**
   * true  = 交互式引导：能勾选步骤、有「我已完成」按钮
   * false = 只读参考资料：步骤展开可看，但不显示勾选（全部做完后再看就是这个形态，
   *         再让你勾一遍没有意义，但内容仍然随时可查）
   */
  guideMode: { type: Boolean, default: true }
});
const emit = defineEmits(['close', 'all-done', 'progress']);

/*
  外部链接集中在这里，再注入给 buildSteps —— 步骤定义是纯函数，
  不该硬编码网址，否则改一个链接要动两处逻辑。
*/
const DOCS_WIN = 'https://docs.mai-mai.org/manual/deployment/windows';
const ONEKEY = 'https://github.com/Mai-with-u/MaiBotOneKey/releases';
const ADAPTER = 'https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter';
const ADAPTER_DOCS = 'https://docs.mai-mai.org/manual/adapters/snowluma';
const SNOWLUMA_REPO = 'https://github.com/SnowLuma/SnowLuma';
const MAIBOT_WEBUI = 'http://127.0.0.1:8001';

const detecting = ref(false);
const busy = ref('');
const cursor = ref(0);
const env = ref(null);
/** 用户手动点过「我已完成」的步骤 id */
const doneIds = ref(loadDone());

function storageKey() {
  return 'onboarding.doneIds';
}
function loadDone() {
  try {
    const raw = localStorage.getItem(storageKey());
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}
function saveDone() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(doneIds.value));
  } catch (_) {
    /* 存不了就只影响持久化，不影响本次使用 */
  }
}

/*
  步骤由纯函数构造，便于单独测试（scripts/verify-onboarding.mjs）。
  这里只负责把探测结果喂进去 + 把动作接上。
*/
const steps = computed(() =>
  buildSteps({
    env: env.value,
    doneIds: doneIds.value,
    docs: { DOCS_WIN, ONEKEY, ADAPTER, ADAPTER_DOCS, SNOWLUMA_REPO }
  })
);

const doneCount = computed(() => steps.value.filter((s) => s.done).length);
const allDone = computed(() => steps.value.length > 0 && doneCount.value === steps.value.length);
const pct = computed(() =>
  steps.value.length ? Math.round((doneCount.value / steps.value.length) * 100) : 0
);
const progressText = computed(() => {
  if (allDone.value) return '已就绪';
  const next = steps.value.find((s) => !s.done);
  return next ? `下一步：${next.title}` : '';
});

/** 自动把光标移到第一个未完成项 */
watch(
  steps,
  (list) => {
    const idx = list.findIndex((s) => !s.done);
    if (idx >= 0) cursor.value = idx;
  },
  { immediate: true }
);

watch(allDone, (v) => {
  if (v) emit('all-done');
});

/*
  把进度上报给外壳，让右上角那个常驻入口的徽标能实时跟着变。
  放在 watch 里而不是 markDone/unmark 里，是因为 doneCount 也可能
  因为"重来一遍"或外部改动而变化 —— 一处上报覆盖所有来源。
*/
watch(
  [doneCount, () => steps.value.length],
  ([d, t]) => emit('progress', { done: d, total: t }),
  { immediate: true }
);

/** 清空勾选，从第一步重新走（只影响引导进度，不碰任何配置文件） */
function restart() {
  doneIds.value = [];
  saveDone();
  cursor.value = 0;
  toast('已清空引导进度，可以重新走一遍了', 'success');
}

async function detect() {
  if (detecting.value) return;
  detecting.value = true;
  try {
    const r = await detectAll();
    if (r.ok) {
      env.value = r;
    } else {
      toast(r.message || '环境检测失败', 'warn');
    }
  } finally {
    detecting.value = false;
  }
}

function markDone(s) {
  if (!doneIds.value.includes(s.id)) {
    doneIds.value = [...doneIds.value, s.id];
    saveDone();
  }
}
function unmark(s) {
  doneIds.value = doneIds.value.filter((x) => x !== s.id);
  saveDone();
}

/** 动作表：全部是"跳转 / 复制 / 打开"，没有任何写文件操作 */
async function runAction(a) {
  if (busy.value) return;
  busy.value = a.key;
  try {
    if (a.kind === 'external') {
      const r = await openExternal(a.url);
      if (!r?.ok) toast(r?.message || '打开浏览器失败', 'warn');
    } else if (a.kind === 'maibot-webui') {
      await openMaibotWebui();
    } else if (a.kind === 'copy-token') {
      const t = await maibotWebuiToken();
      if (!t.ok) {
        toast(t.message, 'warn', 7000);
        return;
      }
      const copied = await copyText(t.token);
      toast(
        copied
          ? `已复制 WebUI Token（登录 http://127.0.0.1:8001 时粘贴）`
          : '复制失败，请手动从下方选中复制',
        copied ? 'success' : 'warn',
        6000
      );
    } else if (a.kind === 'copy') {
      const copied = await copyText(a.text);
      toast(copied ? '已复制' : '复制失败', copied ? 'success' : 'warn');
    } else if (a.kind === 'route') {
      emit('close');
      location.hash = a.hash;
    }
  } finally {
    busy.value = '';
  }
}

/** 复制到剪贴板；优先用 navigator.clipboard（需安全上下文），退回 execCommand */
async function copyText(text) {
  const s = String(text || '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_) {
    /* 继续走兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

async function openMaibotWebui() {
  /* 先探测端口：没在跑就直接开浏览器只会看到"无法访问"，不如说清楚 */
  const alive = await isPortOpen(8001);
  if (!alive) {
    toast('MaiBot 好像还没启动（8001 端口没在监听），请先启动它', 'warn', 6000);
  }
  const r = await openExternal(MAIBOT_WEBUI);
  if (!r?.ok) toast(r?.message || '打开浏览器失败', 'warn');
}

function close() {
  emit('close');
}

/* 打开时重新检测一次，保证显示的是当前真实状态 */
watch(
  () => props.open,
  (v) => {
    if (v) detect();
  }
);

onMounted(() => {
  if (props.open) detect();
});

/** 撒花粒子：纯 CSS 动画，不引第三方库、不用 canvas */
function confettiStyle(i) {
  const hue = (i * 37) % 360;
  const left = (i * 2.5 + (i % 7) * 3) % 100;
  const delay = (i % 10) * 0.12;
  const dur = 1.8 + (i % 5) * 0.25;
  return {
    left: `${left}%`,
    background: `hsl(${hue} 80% 60%)`,
    animationDelay: `${delay}s`,
    animationDuration: `${dur}s`
  };
}
</script>

<style scoped>
/* 遮罩不吃点击：只有向导本体接收事件，左侧界面照常可用 */
.wiz-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  pointer-events: none;
  display: flex;
  justify-content: flex-end;
}
.wiz {
  pointer-events: auto;
  width: 372px;
  max-width: 92vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--paper);
  border-left: 1px solid var(--line-strong);
  box-shadow: -12px 0 34px rgba(10, 18, 30, 0.18);
}
.wiz-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.75rem 0.875rem 0.625rem;
}
.wiz-head-l {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.wiz-ico {
  width: 20px;
  height: 20px;
  color: var(--theme-color);
}
.wiz-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}
.wiz-sub {
  letter-spacing: var(--ls-sm);
  margin: 0.125rem 0 0;
  font-size: 12px;
  color: var(--ink-faint);
}
/* 参考资料模式的小标（步骤已全做完后再打开就是这个形态） */
.wiz-mode {
  letter-spacing: var(--ls-2xs);
  margin-left: 0.25rem;
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  background: var(--theme-tint);
  color: var(--theme-color);
  font-size: 10px;
  font-weight: 600;
  vertical-align: 1px;
}
.wiz-bar {
  height: 3px;
  background: var(--line);
  margin: 0 0.875rem 0.25rem;
  border-radius: 999px;
  overflow: hidden;
}
.wiz-bar-fill {
  display: block;
  height: 100%;
  /* §11：满宽 + scaleX；圆角由 .wiz-bar 的 overflow:hidden 负责 */
  width: 100%;
  transform-origin: left center;
  will-change: transform;
  background: var(--theme-color);
  transition: transform var(--dur-slow) var(--ease-standard);
}
.wiz-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0.375rem 0.875rem 0.75rem;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.step {
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--paper-solid);
}
.step.cur {
  border-color: var(--theme-color);
}
.step.done {
  opacity: 0.72;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  cursor: pointer;
  user-select: none;
}
.step-mark {
  letter-spacing: var(--ls-sm);
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: var(--line);
  color: var(--ink-soft);
}
.step.done .step-mark {
  background: var(--ok-tint);
  color: var(--ok-ink-strong);
}
.step.cur .step-mark {
  background: var(--theme-tint);
  color: var(--theme-color);
}
.step.done .step-mark :deep(svg) {
  width: 11px;
  height: 11px;
}
.step-title {
  letter-spacing: var(--ls-sm);
  flex: 1 1 auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
}
.step-chev {
  width: 13px;
  height: 13px;
  color: var(--ink-faint);
  flex: 0 0 auto;
}
.step-body {
  padding: 0 0.625rem 0.625rem 2.3125rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.step-why {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.facts li {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  font-size: 12px;
  color: var(--ink-faint);
}
.fact-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-faint);
  flex: 0 0 auto;
  align-self: center;
}
.facts li.ok .fact-dot {
  background: var(--ok-ink);
}
.facts li.warn .fact-dot {
  background: var(--warn-ink);
}
.facts li.err .fact-dot {
  background: var(--err-ink);
}
.step-warn {
  letter-spacing: var(--ls-sm);
  margin: 0;
  padding: 0.375rem 0.5rem;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  background: var(--warn-tint);
  color: var(--warn-ink-deep);
}
.step-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: center;
}
.wiz-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.875rem;
  border-top: 1px solid var(--line);
}
.foot-note {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  color: var(--ink-faint);
  line-height: 1.4;
}
.foot-btns {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 0 0 auto;
}
.done-hint {
  color: var(--ink-faint);
}
.wiz-done {
  position: relative;
  padding: 1.625rem 0.625rem 0.625rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  text-align: center;
}
.done-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}
.done-sub {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-soft);
}
/* 撒花：40 个粒子的纯 CSS 下落动画 */
.confetti {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.confetti i {
  position: absolute;
  top: -12px;
  width: 6px;
  height: 9px;
  border-radius: 1px;
  opacity: 0.95;
  animation-name: confetti-fall;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
@keyframes confetti-fall {
  0% {
    transform: translateY(-14px) rotate(0deg);
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  100% {
    transform: translateY(340px) rotate(560deg);
    opacity: 0;
  }
}
/*
  抽屉过渡：与全项目二级窗口统一 —— 时长 --dur-base(180ms) + 缓动 --ease-standard。
  遮罩只淡入淡出；面板按"抽屉的方向语言"从右侧轻推入位（16px，幅度与居中式
  弹窗的 translateY(8px) 相当，观感是同一套动作）。
*/
.wiz-enter-active,
.wiz-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.wiz-enter-active .wiz,
.wiz-leave-active .wiz {
  transition: transform var(--dur-base) var(--ease-standard);
}
.wiz-enter-from,
.wiz-leave-to {
  opacity: 0;
}
.wiz-enter-from .wiz,
.wiz-leave-to .wiz {
  transform: translateX(16px);
}
</style>
