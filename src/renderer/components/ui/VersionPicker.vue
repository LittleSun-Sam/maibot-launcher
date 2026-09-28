<template>
  <!--
    版本选择器：胶囊按钮 + 下拉清单。
    ⚠️ 下拉清单的定位基准是这个 .vp（position: relative），
    而不是按钮本身 —— 按钮会被后续元素挤走，清单跟着按钮走就会出现
    "清单与按钮错位"。外层留出 padding-bottom 给清单悬停用。
  -->
  <div ref="rootRef" class="vp">
    <button
      class="vp-btn"
      type="button"
      :disabled="disabled || loading"
      :title="titleText"
      @click="toggle"
    >
      <span class="vp-text" :class="{ latest: !isPinned }">{{ displayText }}</span>
      <IconGlyph :name="open ? 'chev-up' : 'chev-down'" class="vp-chev" />
    </button>

    <div v-if="open" class="vp-pop" :class="{ up: dropUp }">
      <div class="vp-head">
        <span>{{ repo || '仓库未配置' }}</span>
        <button class="vp-mini" type="button" :disabled="loading" @click="fetchVersions">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>

      <div v-if="error" class="vp-err">{{ error }}</div>

      <ul v-else class="vp-list">
        <li>
          <button class="vp-item" type="button" :class="{ on: !isPinned }" @click="pick('latest')">
            <span class="vp-tag">最新版(latest)</span>
            <span class="vp-hint">安装时解析当前最新正式版</span>
          </button>
        </li>
        <li v-for="rel in options" :key="rel.tag_name">
          <button
            class="vp-item"
            type="button"
            :class="{ on: rel.tag_name === modelValue }"
            @click="pick(rel.tag_name)"
          >
            <span class="vp-tag">{{ rel.tag_name }}</span>
            <span v-if="rel.prerelease" class="vp-pre">预发布</span>
            <span v-if="rel.published_at" class="vp-date">
              {{ new Date(rel.published_at).toLocaleDateString() }}
            </span>
          </button>
        </li>
      </ul>

      <!--
        列表为空时给一句说明，而不是留一片空白：
        MaiBot 的 Release 是**纯源码发布、不带附件**（实测 30 个版本里仅 3 个老版挂了文件），
        版本号只来自 tag，安装走 codeload 源码归档 —— 即使没有任何附件也照样能装。
        不解释的话用户会把"这里没有附件信息"理解成"没拉到版本"。
      -->
      <div v-if="!loading && !error && !options.length" class="vp-hint">
        该仓库没有返回可选的版本号（或网络不可用）。用「最新版(latest)」仍可安装。
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import IconGlyph from '../IconGlyph.vue';
import { loadReleases, store } from '../../stores/app-store.js';

const props = defineProps({
  /** 目标仓库（owner/name）。留空表示未配置，此时只能装 latest */
  repo: { type: String, default: '' },
  /** 当前选中的 tag，'latest' 表示跟随最新正式版 */
  modelValue: { type: String, default: 'latest' },
  disabled: { type: Boolean, default: false }
});
const emit = defineEmits(['update:modelValue', 'change']);

const open = ref(false);
const loading = ref(false);
const error = ref('');
const releases = ref([]);

/**
 * 手上这份列表是从哪个仓库拉来的。
 *
 * 为什么必须记住这件事：
 *   loadReleases() 把结果写进**全局单桶** store.releases，而且返回值只有
 *   {ok, repo, count}，列表本身只能从 store 里取。安装器页现在有两行
 *   （MaiBot / SnowLuma），下载页也共用同一个桶 —— 谁后拉谁覆盖。
 *   若不记录来源，MaiBot 这一行就可能列着 SnowLuma 的 tag，
 *   选完之后装下去的是另一个仓库的版本（而且不报错）。
 *   仓库对不上时一律视为"这份列表无效"。
 */
const loadedRepo = ref('');

const isPinned = computed(() => Boolean(props.modelValue) && props.modelValue !== 'latest');
const displayText = computed(() => (isPinned.value ? props.modelValue : '最新版(latest)'));
const titleText = computed(() => `选择安装版本${props.repo ? `（${props.repo}）` : ''}`);
const options = computed(() =>
  loadedRepo.value && loadedRepo.value === props.repo ? releases.value : []
);

async function fetchVersions() {
  if (!props.repo) {
    error.value = '未配置仓库，只能安装最新版';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    /* 拉 30 个足够覆盖"选一个自己想要的历史版本"这个场景，再多也没人翻 */
    const r = await loadReleases(props.repo, 30);
    if (!r || !r.ok) {
      releases.value = [];
      loadedRepo.value = '';
      error.value = r?.message || '获取版本列表失败';
      return;
    }
    /* 先记来源再从 store 取数据；反过来的话中途被别的调用覆盖会串仓库 */
    loadedRepo.value = props.repo;
    releases.value = Array.isArray(store.releases) ? store.releases : [];
  } finally {
    loading.value = false;
  }
}

function toggle() {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  dropUp.value = shouldOpenUp();
  bindDoc(true);
  fetchVersions();
}

/*
  下方空间不够时改成向上展开。
  ────────────────────────────────────────────────────────────────
  为什么这是必须的，而不是"好看一点"：
  SnowLuma 是安装器页安装行的**最后一行**，向下展开会直接顶到视口外面。
  浮层在 .body 这个 overflow-y:auto 容器里是 absolute 定位，
  它会被算进滚动高度 —— 也就是说"想看到下面的版本列表就得滚动"。
  但滚动条在组件外面，在它上面按下鼠标会被 outside-click 判定成"点了别处"，
  于是**一滚就把下拉关掉了**，用户根本选不到老版本。
  向上展开就没有这个问题：整个列表都在已经可见的区域里。
*/
const dropUp = ref(false);

function shouldOpenUp() {
  const el = rootRef.value;
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  /* 262 是 .vp-pop 的 max-height，12 是它与按钮的间距 + 余量 */
  const need = 262 + 12;
  const roomBelow = window.innerHeight - rect.bottom;
  return roomBelow < need && rect.top > need;
}

/*
  关闭下拉的三个途径：再点按钮、点别处、按 Esc。
  ────────────────────────────────────────────────────────────────
  为什么非要有"点别处/Esc"：这是个 absolute 浮层，展开后盖在下面的安装按钮上。
  用户点一下旁边想干别的，浮层却还挂在那儿挡着按钮 —— 只能再回来点一次小箭头，
  在"就想按安装"的路径上非常容易卡住。
  监听挂 document、且用**捕获阶段**：气泡阶段可能被页面上的其它处理器拦下
  （AppLayout 有一堆全局点击处理），捕获阶段才能保证一定收到。
  组件卸载时必须解绑，否则浮层状态早就没了，监听器还挂在 document 上。
*/
const rootRef = ref(null);

function onDocDown(e) {
  const el = rootRef.value;
  /* contains(null) 返回 false，所以不用额外判空 e.target */
  if (el && !el.contains(e.target)) close();
}

function onDocKey(e) {
  if (e.key === 'Escape') close();
}

function bindDoc(on) {
  const fn = on ? 'addEventListener' : 'removeEventListener';
  document[fn]('mousedown', onDocDown, true);
  document[fn]('keydown', onDocKey, true);
}

function close() {
  if (!open.value) return;
  open.value = false;
  bindDoc(false);
}

onBeforeUnmount(() => bindDoc(false));

function pick(tag) {
  const next = tag || 'latest';
  if (next !== props.modelValue) {
    emit('update:modelValue', next);
    emit('change', next);
  }
  close();
}

/*
  仓库变了（用户在「安装信息」里改了仓库名，或设置页改了仓库）：
  已选的 tag 在新仓库里可能根本不存在，继续留着会让安装直接报"未找到版本 xxx"。
  所以退回 latest 并作废旧列表。
*/
watch(
  () => props.repo,
  () => {
    loadedRepo.value = '';
    releases.value = [];
    error.value = '';
    if (props.modelValue !== 'latest') emit('update:modelValue', 'latest');
    if (open.value) fetchVersions();
  }
);
</script>

<style scoped>
.vp {
  position: relative;
  flex: none;
}

.vp-btn {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 210px;
  height: 26px;
  padding: 0 0.5rem;
  border: 1px solid var(--line-strong);
  /* v4 明令去掉药丸按钮：这一颗原来是 999px，跟外壳里的其他按钮
     （--r-ctl 10px）不是一套语言。改回控件圆角，与 TextInput / PillButton 统一。 */
  border-radius: var(--radius-sm);
  background: var(--paper-solid);
  color: var(--ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color var(--dur-base), color var(--dur-base);
}

.vp-btn:hover:not(:disabled) {
  border-color: var(--theme-line);
  color: var(--theme-color);
}

.vp-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.vp-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 未固定版本时用主题色，和"已选定某个具体版本"在视觉上区分开 */
.vp-text.latest {
  color: var(--theme-color);
}

.vp-chev {
  letter-spacing: var(--ls-sm);
  flex: none;
  font-size: 12px;
}

/*
  下拉清单纯浮层（absolute + z-index）。
  不用 <select>：原生下拉在 Electron 里由系统绘制，无法用主题变量配色，
  而本项目的规则是"不写死颜色"。
*/
.vp-pop {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 30;
  width: 248px;
  max-height: 262px;
  overflow-y: auto;
  padding: 0.375rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--paper-full);
  /* 阴影原来写死 rgba(20,30,48,.16)：深色主题下"深色阴影压深色界面"等于没有，
     下拉浮层与背后的卡片分不开。--shadow-2 两套主题各有一档（深色是黑 55%）。 */
  box-shadow: var(--shadow-2);
}

/* 下方空间不足时向上展开（见 shouldOpenUp 的说明） */
.vp-pop.up {
  top: auto;
  bottom: calc(100% + 5px);
}

.vp-head {
  letter-spacing: var(--ls-2xs);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.125rem 0.25rem 0.375rem;
  font-size: 10px;
  color: var(--ink-faint);
}

.vp-mini {
  letter-spacing: var(--ls-2xs);
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font-size: 10px;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  cursor: pointer;
}

.vp-mini:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.vp-err {
  letter-spacing: var(--ls-sm);
  padding: 0.5rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--err-bg);
  color: var(--err-ink);
  font-size: 12px;
}

.vp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.vp-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.vp-item:hover {
  background: var(--theme-tint);
}

.vp-item.on {
  background: var(--theme-tint);
  color: var(--theme-color);
}

.vp-tag {
  letter-spacing: var(--ls-sm);
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 预发布必须显式标注：装错通道是很常见的一步之差 */
.vp-pre {
  letter-spacing: var(--ls-2xs);
  flex: none;
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  background: var(--warn-tint);
  /* 用 --warn-ink 而不是 --warn：--warn 是给 8px 状态点/图标这类图形元素
     （≥3:1）准备的，压在 12% 淡橙底上实测只有 2.62:1，10px 文字读不出来；
     --warn-ink 在同一底上是 5.12:1（浅色）/ 6.34:1（深色），这正是
     theme.css 里"彩色文字一律用 *-ink"那条约定的用法。 */
  color: var(--warn-ink);
  font-size: 10px;
  font-weight: 600;
}

.vp-date {
  letter-spacing: var(--ls-2xs);
  margin-left: auto;
  flex: none;
  font-size: 10px;
  color: var(--ink-faint);
}

.vp-hint {
  letter-spacing: var(--ls-sm);
  padding: 0.375rem 0.5rem;
  font-size: 12px;
  color: var(--ink-faint);
  line-height: 1.5;
}

/* 默认项按钮里的说明文字：靠右、不换行，避免撑高整行 */
.vp-item .vp-hint {
  margin-left: auto;
  padding: 0;
  text-align: right;
  white-space: nowrap;
}
</style>
