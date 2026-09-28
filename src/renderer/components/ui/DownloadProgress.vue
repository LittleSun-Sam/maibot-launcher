<template>
  <!--
    一行下载进度。刻意做成纯展示组件（只有 data 一个必填 prop）：
    安装器页与下载页都要显示同一套字段，而两处原先各写了一份 describeProgress，
    已经漂移成两种口径（一处带速率、一处没有）——"多线程到底有没有生效"这种
    问题在两个页面上得到不同答案。抽成一份就再也不会分叉。
  -->
  <!--
    title 里保留来源主机：主进程会按测速结果换源，host 是判断
    "到底走了直连还是镜像"的唯一线索。但它太长（一行放不下），
    所以只作为悬停提示，不占用正文宽度。
  -->
  <div class="dp" :class="{ err: failed }" :title="host">
    <span v-if="label" class="dp-label">{{ label }}</span>

    <!--
      下载阶段只画进度条；校验/完成时进度条已经没有意义（停在 99% 或跳回 0），
      继续显示反而制造"卡住了"的错觉，所以换成对应的结论/状态文字。
    -->
    <span v-if="!failed && !isVerify && !isDone" class="dp-bar">
      <i :style="{ transform: 'scaleX(' + barPercent / 100 + ')' }" />
    </span>

    <template v-if="failed">
      <span class="dp-num">{{ barPercent }}%</span>
      <span class="dp-txt dp-msg">{{ data.message || '下载失败' }}</span>
    </template>

    <span v-else-if="isVerify" class="dp-txt dp-verify">
      <IconGlyph name="refresh" class="dp-ico" />
      校验中…
    </span>

    <template v-else-if="isDone">
      <span v-if="verifyText" class="dp-txt dp-ok">
        <IconGlyph name="check" class="dp-ico" />
        {{ verifyText }}
      </span>
      <span v-if="doneSize" class="dp-num">{{ doneSize }}</span>
    </template>

    <template v-else>
      <span class="dp-num">{{ percent }}%</span>
      <span class="dp-bytes">{{ bytesText }}</span>
      <span v-if="rateText" class="dp-rate">{{ rateText }}</span>
      <span v-if="etaText" class="dp-eta">{{ etaText }}</span>
      <!--
        还没收到任何字节时，把主进程给的阶段说明显示出来。
        实测点下下载后有 3~4 秒在测速选源（直连 GitHub 要等超时），
        这段时间进度条一动不动 —— 没有这句说明，用户会以为卡死了。
        一旦开始收字节就撤掉："分 8 段并发下载"这类话在传输中已经没有信息量，
        继续占位反而把速率和 ETA 挤走。
      -->
      <span v-if="phaseMessage" class="dp-stage">{{ phaseMessage }}</span>
      <!--
        segments===1 时写"单连接"而不是"1 线程"：主进程会先探测 Range，
        服务器不支持分段时会**自动退回单连接**，把它显示成"1 线程"
        会让用户以为多线程功能坏了。
      -->
      <span v-if="threadText" class="dp-thread" :class="{ solo: solo }">{{ threadText }}</span>
      <span v-if="verifyText" class="dp-txt dp-ok">
        <IconGlyph name="check" class="dp-ico" />
        {{ verifyText }}
      </span>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import IconGlyph from '../IconGlyph.vue';

const props = defineProps({
  /** 主进程经 IPC 推送的进度负载（契约见 services/github.js 的 createMeter） */
  data: { type: Object, default: null },
  /** 行首标签，如 "MaiBot"；纯展示用 */
  label: { type: String, default: '' }
});

const failed = computed(() => props.data?.phase === 'error');
const isVerify = computed(() => props.data?.phase === 'verify');
const isDone = computed(() => props.data?.phase === 'done');
/** 仅为悬停提示保留：主进程换源后这里会变成实际下载来源 */
const host = computed(() => (props.data?.host ? `来源：${props.data.host}` : ''));

const percent = computed(() => {
  const n = Number(props.data?.percent);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
});

/*
  进度条宽度。
  done 阶段的 percent 是 100，但那一帧我们根本不画进度条；
  error 阶段主进程**不带 percent**，若照旧取 0 会让进度条瞬间缩回 0%，
  看起来像"下载被清空了"。所以失败时保留上一次的宽度 ——
  父组件是整体替换进度对象，这里拿不到历史值，
  于是退化成"满格但标红"，语义上更接近"止步于此"，不会误导。
*/
const barPercent = computed(() => (failed.value ? 100 : percent.value));

/*
  ⚠️ 必须是 computed，不能是普通函数。
  模板里写的是 {{ bytesText }} —— 如果 bytesText 是普通函数，
  Vue 插值会把它**函数源码本身**当字符串渲染出来，
  界面上就会出现一段 `function bytesText(){const got=...}` 的 JS 代码，
  而"已下/总"的数字永远不显示。
  这个 bug 静态检查（eslint/build）完全看不出来，
  只有真机跑一次下载、把 DOM 读出来才会暴露。
*/
const bytesText = computed(() => {
  const got = humanSize(props.data?.received);
  const all = Number(props.data?.total) > 0 ? humanSize(props.data?.total) : '';
  if (!got) return '';
  return all ? `${got} / ${all}` : got;
});

const doneSize = computed(() => (isDone.value ? humanSize(props.data?.received) : ''));

/** 速率：拿不到 bytesPerSec 就返回空串，绝不显示编出来的数字 */
function formatRate(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB/s`;
  return `${Math.round(n)} B/s`;
}

/**
 * ETA：etaSec 为 null 时**一个字符都不显示**。
 * 主进程只在"有总大小且确实在收数据"时才给这个值，
 * 其它情况（未知大小、已下完）一律 null —— 此时显示任何数字都是假的。
 */
function formatEta(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 60) return `剩余 ${Math.round(n)} 秒`;
  if (n < 3600) return `剩余 ${Math.floor(n / 60)} 分 ${Math.round(n % 60)} 秒`;
  return `剩余 ${Math.floor(n / 3600)} 小时 ${Math.round((n % 3600) / 60)} 分`;
}

/** 线程数：0/undefined 表示主进程没报（旧负载），不显示而不是猜 1 */
const threadText = computed(() => {
  const n = Number(props.data?.segments);
  if (!Number.isFinite(n) || n < 1) return '';
  return n > 1 ? `${n} 线程` : '单连接';
});
const solo = computed(() => Number(props.data?.segments) === 1);

const rateText = computed(() => formatRate(props.data?.bytesPerSec));
const etaText = computed(() => formatEta(props.data?.etaSec));

/*
  阶段说明只在"还没开始收字节"时显示。
  注意这是 start 阶段的 message，和 error 阶段的 message 是两个不同字段的用法：
  error 由上面的 failed 分支先接管，走不到这里。
*/
const phaseMessage = computed(() => {
  const got = Number(props.data?.received);
  if (Number.isFinite(got) && got > 0) return '';
  return props.data?.message || '';
});

/*
  校验结论必须**如实**反映做到了哪一步（verify 字段由主进程给出）：
    sha256 → 真的与上游发布摘要逐字节比对通过
    size   → 只比了字节数，**不能**说成"校验通过"
    none   → 什么都没校验，一个字都不该提
  这正是不把主进程的 verify 直接映射成"完成"的原因。
*/
const verifyText = computed(() => {
  const v = props.data?.verify;
  if (v === 'sha256') return 'SHA-256 校验通过';
  if (v === 'size') return '已校验大小';
  return '';
});

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
</script>

<style scoped>
/*
  用 flex-wrap：安装器页那一行塞得下 百分比+体积+速率+ETA+线程数，
  下载页的附件行更窄，允许换行总比截断掉速率或线程数好
  （被截断的恰好是最能证明多线程生效的那两个字段）。
*/
.dp {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
   gap: var(--sp-2);
  min-width: 0;
}

.dp-label {
  letter-spacing: var(--ls-sm);
  flex: none;
   font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--ink-strong);
}

.dp-bar {
  flex: 1 1 84px;
  min-width: 64px;
  height: 6px;
   border-radius: var(--r-pill);
  /* 底原来是写死的 rgba(20,30,48,.1)：深色主题下这条"槽"几乎与卡片同色，
     进度条没有参照物就看不出走了多少。--fill-disabled 是叠加色，
     浅色是黑 4%、深色是白 4%，两套主题都能看出槽的形状（图形元素 ≥3:1 不适用，
     槽只做参照，不承载信息）。 */
  background: var(--fill-disabled);
  overflow: hidden;
}

.dp-bar i {
  display: block;
  height: 100%;
  /* §11：同 SystemPerf —— 满宽 + scaleX，轨道负责圆角与裁切 */
  width: 100%;
  transform-origin: left center;
  will-change: transform;
  background: var(--theme-color);
  transition: transform var(--dur-slow) var(--ease-standard);
}

/* 失败时进度条整条标红，和文字同色系 */
.dp.err .dp-bar i {
  background: var(--err);
}

.dp-num {
  letter-spacing: var(--ls-sm);
  flex: none;
  min-width: 34px;
  text-align: right;
   font-size: var(--fs-sm);
  color: var(--ink-soft);
}

.dp-bytes,
.dp-rate,
.dp-eta,
.dp-thread,
.dp-txt {
  letter-spacing: var(--ls-sm);
  flex: none;
   font-size: var(--fs-sm);
  color: var(--ink-soft);
  white-space: nowrap;
}

/* 速率与线程数是"多线程真的生效了"的证据，用主题色提高可读性 */
.dp-rate,
.dp-thread {
  color: var(--theme-color);
  font-weight: 600;
}

/* 单连接是如实降级，不是异常，保持普通字重普通颜色 */
.dp-thread.solo {
  color: var(--ink-faint);
  font-weight: 600;
}

.dp-eta {
  color: var(--ink-faint);
}

/*
  阶段说明（"正在测速选择最快的下载源…"）。
  用普通字色 + 斜体，和右侧那些"测量值"（速率/ETA）区分开：
  它是**过程说明**，不是结果，不该看起来像数据。
*/
.dp-stage {
  letter-spacing: var(--ls-sm);
  flex: none;
   font-size: var(--fs-sm);
  font-style: italic;
  color: var(--ink-faint);
  white-space: nowrap;
}

.dp-ok,
.dp-verify {
  display: inline-flex;
  align-items: center;
   gap: var(--sp-1);
}

.dp-ok {
  color: var(--ok-ink);
  font-weight: 600;
}

.dp-verify {
  color: var(--ink-soft);
}

.dp-ico {
  letter-spacing: var(--ls-sm);
  flex: none;
  font-size: 12px;
}

/*
  失败信息允许换行并占满整行：message 里常带 HTTP 状态码 / 分段重试原因，
  截断掉就等于把"为什么失败"又藏起来了。
*/
.dp-msg {
  flex: 1 1 100%;
  white-space: normal;
  color: var(--err-ink);
}
</style>
