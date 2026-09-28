<template>
  <div class="perf">
    <div v-if="loading" class="perf-loading">
      <LoadingSpinner />
    </div>
    <!--
      采样失败态：此前失败会永久停在 loading 转圈上，
      用户无法区分"还在读"与"读不到"。这里显式说明并等待下一次自动重试。
    -->
    <div v-else-if="failed" class="perf-failed">
      <span class="pf-text">无法读取系统占用</span>
      <span class="pf-sub">将在 {{ SAMPLE_INTERVAL_MS / 1000 }} 秒后自动重试</span>
    </div>
    <template v-else>
      <div class="perf-tiles">
        <div class="tile">
          <div class="tile-top">
            <span class="tile-label">CPU</span>
            <span class="tile-val" :class="`lv-${cpuLevel}`">{{ usage.cpuPercent }}%</span>
          </div>
          <div class="bar">
            <div
              class="bar-fill"
              :class="`lv-${cpuLevel}`"
              :style="{ transform: 'scaleX(' + clamp(usage.cpuPercent) / 100 + ')' }"
            />
          </div>
          <div class="tile-sub">{{ coreLabel }}</div>
        </div>
        <div class="tile">
          <div class="tile-top">
            <span class="tile-label">内存</span>
            <span class="tile-val" :class="`lv-${memLevel}`">{{ usage.memoryPercent }}%</span>
          </div>
          <div class="bar">
            <div
              class="bar-fill"
              :class="`lv-${memLevel}`"
              :style="{ transform: 'scaleX(' + clamp(usage.memoryPercent) / 100 + ')' }"
            />
          </div>
          <div class="tile-sub">{{ memSub }}</div>
        </div>
      </div>
      <div class="perf-foot">
        <span>综合负载 <b>{{ combined }}%</b></span>
        <span>{{ coreLabel }} · {{ memSub }}</span>
      </div>
    </template>
  </div>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/components/dashboard/SystemPerf.vue
职责：系统性能卡片（CPU / 内存占用）。
================================================================================
  相对重构前的修正：
    1) 内存数字永远是 NaN（真实显示 bug）
       主进程返回的字段是 memoryUsedMB / memoryTotalMB，
       而这里读取的是 usage.memoryUsed / usage.memoryTotal —— 均为 undefined，
       于是 (undefined/1024).toFixed(1) 得到字符串 "NaN"，
       界面长期显示「NaN / NaN GB」，而 tile-sub 又被覆盖成这个假值，
       用户完全看不到真实内存占用。
       → 现在：统一使用 memoryUsedMB / memoryTotalMB 字段名。
    2) fmtGB() 是死函数：从未被任何地方调用（memSub 自己算了一遍），
       且函数体本身也写错了（把同一个值当分子和分母）。
       → 现在：删除，只保留 memSub。
    3) 首次采样必然为 0%：CPU 占用率依赖两次采样差分。
       现在主进程会在首次调用时主动建立基线，这里不再用
       「usage.cores || 4」之类假默认值掩盖缺失字段。
================================================================================
*/
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import LoadingSpinner from '../ui/LoadingSpinner.vue';
import { getSystemUsage } from '../../stores/app-store.js';

/** 与主进程返回结构一致的初始值（字段名必须对齐，否则会算出 NaN） */
const usage = ref({
  cpuPercent: 0,
  memoryPercent: 0,
  memoryUsedMB: 0,
  memoryTotalMB: 0,
  cores: 0,
  samplingReady: false
});
const loading = ref(true);
/** 采样失败标记：用于区分"读取中"与"读不到"，避免永久转圈 */
const failed = ref(false);
let timer = null;
let running = true;

/** 采样间隔（毫秒）。原先散落在 setInterval 里的字面量 2000，抽出来便于统一调整 */
const SAMPLE_INTERVAL_MS = 2000;

/** 阈值：抽常量，避免 cpuColor / memColor 各写一遍 85/60 */
const THRESHOLD_HIGH = 85;
const THRESHOLD_MID = 60;

function clamp(v) {
  const n = Number(v) || 0;
  return Math.min(100, Math.max(0, n));
}

/*
  占用率分档，只负责「是哪一档」，具体颜色交给 CSS 变量
  （--err / --warn / --perf-bar-*-low，见 styles/theme.css）。
  原先这里直接返回 '#ef4444' / '#f59e0b' / '#3b82f6' 这类字面量，
  既和全局设计参数脱钩，也让「红色=高负载」这条规则在 JS 里各写一遍。
  低档 CPU 与内存各自一个冷色，所以档位名区分开。
*/
function levelOf(percent) {
  if (percent > THRESHOLD_HIGH) return 'high';
  if (percent > THRESHOLD_MID) return 'mid';
  return 'low';
}

const cpuLevel = computed(() => levelOf(usage.value.cpuPercent));
const memLevel = computed(() => {
  const lv = levelOf(usage.value.memoryPercent);
  return lv === 'low' ? 'low-mem' : lv;
});
const combined = computed(() =>
  Math.round(((Number(usage.value.cpuPercent) || 0) + (Number(usage.value.memoryPercent) || 0)) / 2)
);

/** 内存描述：字段名与主进程一致（*MB） */
const memSub = computed(() => {
  const used = Number(usage.value.memoryUsedMB) || 0;
  const total = Number(usage.value.memoryTotalMB) || 0;
  if (!total) return '读取中…';
  return `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GB`;
});

const coreLabel = computed(() => (usage.value.cores ? `${usage.value.cores} 核` : '—'));

/** 采样在途标记：防止慢响应叠加（2 秒一次，而 IPC 偶尔会慢） */
let sampling = false;

async function tick() {
  if (!running || sampling) return;
  sampling = true;
  try {
    const s = await getSystemUsage();
    if (!s) {
      /*
        采样失败：必须给出可见反馈。
        此前是 `if (!s) return;`，而 loading 只在成功路径被置 false ——
        system:usage 一旦失败就永久转圈，用户无法区分"加载中"和"坏了"。
        （主进程首次采样需 var(--dur-base) 建立 CPU 基线，属正常等待，不在此列。）
      */
      loading.value = false;
      failed.value = true;
      return;
    }
    failed.value = false;
    usage.value = s;
    loading.value = false;
  } finally {
    sampling = false;
  }
}

function startTimer() {
  if (timer !== null) return;
  timer = window.setInterval(() => {
    if (document.hidden || !running) return;
    tick();
  }, SAMPLE_INTERVAL_MS);
}

function stopTimer() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/*
  隐藏时**真正**停表。
  原来只在回调里 return，定时器仍每 2 秒唤醒 ——
  对一个"实时占用"面板来说，窗口看不见时的采样完全是浪费。
*/
function onVisibilityChange() {
  if (document.hidden) {
    stopTimer();
    return;
  }
  /* 回到前台立刻采一次，避免显示的是切走前的旧数值 */
  tick();
  startTimer();
}

onMounted(async () => {
  running = true;
  await tick();
  /*
    卸载守卫：这一行 await 期间组件可能已被卸载（/overview 是默认落地页，
    而首次 system:usage 要在主进程等 var(--dur-base) 建 CPU 基线，窗口真实存在）。
    此前卸载早于此处时 running 已为 false、timer 仍为 null，
    clearInterval 落空，随后这里照样创建定时器 —— 每 2 秒永久唤醒并持有闭包。
  */
  if (!running) return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  startTimer();
});

onBeforeUnmount(() => {
  running = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopTimer();
});
</script>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 100%;
  justify-content: center;
}

.perf-loading {
  display: flex;
  justify-content: center;
  padding: 1.5rem 0;
}

/* 采样失败：与 loading 区分开，明确是"读不到"而非"在读" */
.perf-failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 1.25rem 0;
  color: var(--ink-soft);
}

.perf-failed .pf-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--err);
}

.perf-failed .pf-sub {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
}

.perf-tiles {
  display: flex;
  gap: 0.875rem;
}

.tile {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.75rem;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid var(--line);
}

.tile-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tile-label {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-soft);
}

.tile-val {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.bar {
  height: 6px;
  border-radius: 99px;
  background: var(--neutral-tint);
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  /*
    §11：进度必须画在合成器上。原来动 width，每帧触发布局 + 重绘；
    现在元素恒为满宽、只用 scaleX 表达进度 —— transform 由合成器处理。
    填充层自己的圆角去掉了：轨道已 overflow:hidden + 圆角，
    而且 scaleX 会把填充层的圆角压成椭圆。
  */
  width: 100%;
  transform-origin: left center;
  will-change: transform;
  transition: transform var(--dur-slow) var(--ease-standard);
}

/*
  分档配色。tile-val 用文字色，bar-fill 用背景色 ——
  同一个 lv-* 类同时服务两者，避免颜色值在两个地方各写一遍。
*/
.tile-val.lv-high,
.bar-fill.lv-high {
  color: var(--err);
  background: var(--err);
}

.tile-val.lv-mid,
.bar-fill.lv-mid {
  color: var(--warn);
  background: var(--warn);
}

.tile-val.lv-low {
  color: var(--perf-bar-cpu-low);
}

.bar-fill.lv-low {
  background: var(--perf-bar-cpu-low);
}

/* 内存的「正常」档用另一个冷色，避免和 CPU 条混在一起 */
.tile-val.lv-low-mem,
.bar-fill.lv-low-mem {
  color: var(--perf-bar-mem-low);
  background: var(--perf-bar-mem-low);
}

.tile-sub {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  color: var(--ink-faint);
}

.perf-foot {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.125rem;
  font-size: 12px;
  color: var(--ink-soft);
}

.perf-foot b {
  font-size: 13px;
  color: var(--ink-strong);
}
</style>
