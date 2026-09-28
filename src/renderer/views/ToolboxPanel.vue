<template>
  <div class="panel">
    <!--
      页签补齐无障碍语义。
      此前只有 role="tablist" / role="tab"，缺 aria-selected 与连接
      tab ↔ tabpanel 的 id/aria-controls —— 屏幕阅读器无法播报
      "当前选中第几个页签"，键盘用户也拿不到 tab 与内容区的关联。
    -->
    <div class="tab-bar" role="tablist" aria-label="工具分类">
      <button
        id="tb-tab-data"
        type="button"
        role="tab"
        aria-controls="tb-panel-data"
        :aria-selected="tab === 'data'"
        :tabindex="tab === 'data' ? 0 : -1"
        :class="['tab', { active: tab === 'data' }]"
        @click="tab = 'data'"
      >
        <IconGlyph name="cube" />数据工具
      </button>
      <button
        id="tb-tab-chat"
        type="button"
        role="tab"
        aria-controls="tb-panel-chat"
        :aria-selected="tab === 'chat'"
        :tabindex="tab === 'chat' ? 0 : -1"
        :class="['tab', { active: tab === 'chat' }]"
        @click="tab = 'chat'"
      >
        <IconGlyph name="chat" />AI 对话
      </button>
      <button
        id="tb-tab-optimize"
        type="button"
        role="tab"
        aria-controls="tb-panel-optimize"
        :aria-selected="tab === 'optimize'"
        :tabindex="tab === 'optimize' ? 0 : -1"
        :class="['tab', { active: tab === 'optimize' }]"
        @click="tab = 'optimize'"
      >
        <IconGlyph name="wand" />提示词优化
      </button>
    </div>

    <!--
      这里刻意保留 v-show 而不是 v-if：
      AiChat / PromptOptimizer 各自持有对话历史与输入草稿，
      用 v-if 会在切页签时把它们整段丢掉。
      三个子组件都很重，因此用 v-show 保持挂载是正确的取舍 ——
      但它们内部的定时器必须在面板卸载时停掉（见 script 里的清理）。
    -->
    <div
      v-show="tab === 'data'"
      id="tb-panel-data"
      class="tab-body"
      role="tabpanel"
      aria-labelledby="tb-tab-data"
      :tabindex="0"
    >
    <PanelCard title="数据占用" desc="MaiBot 运行数据的磁盘占用统计">
      <template #head>
        <PillButton variant="ghost" size="sm" icon="refresh" :loading="loadingStats" @click="loadStats">
          刷新
        </PillButton>
      </template>

      <div v-if="stats.length" class="stat-list">
        <div v-for="s in stats" :key="s.key" class="stat">
          <div class="stat-main">
            <span class="stat-name">{{ labelOf(s.key) }}</span>
            <span class="stat-path">{{ s.dir }}</span>
          </div>
          <div class="stat-meta">
            <!--
              s.humanSize 由主进程给出且**恒为非空字符串**（"0 B" 也是真值），
              原来的 `s.humanSize || human(s.bytes)` 后半段永远不可达。
              这里只用一个来源，避免"看起来有两套逻辑、实际只跑一套"。
            -->
            <span class="stat-size">{{ s.exists ? s.humanSize : '不存在' }}</span>
            <span class="stat-files">{{ s.exists ? `${s.files || 0} 个文件` : '—' }}</span>
          </div>
        </div>
        <div v-if="root" class="stat-root">根目录：{{ root }}</div>
        <!--
          主进程在超过扫描上限（MAX_FILES_PER_CATEGORY = 20 万）时会提前中断，
          此时 bytes / files 都是**部分值**。此前界面从不读 truncated 字段，
          用户会把偏小的体积当成真实占用。
        -->
        <div v-if="truncatedKeys.length" class="stat-trunc">
          以下分类文件数超过扫描上限，显示的是<strong>部分统计</strong>（实际占用更大）：{{
            truncatedKeys.map(labelOf).join('、')
          }}
        </div>
      </div>
      <EmptyState v-else icon="cube" text="尚未获取到数据统计" />
    </PanelCard>

    <PanelCard title="清理数据" desc="按类别删除可回收的运行数据">
      <FieldRow label="数据类别" :width="72">
        <select v-model="category" class="select">
          <option v-for="c in categories" :key="c.key" :value="c.key">
            {{ c.label }}（{{ c.keepDays > 0 ? `保留 ${c.keepDays} 天` : '全部删除' }}）
          </option>
        </select>
        <PillButton variant="danger" size="sm" icon="trash" :loading="cleaning" @click="clean">
          清理
        </PillButton>
      </FieldRow>

      <!-- 清理前明确告知策略，避免用户以为"清理日志 = 全删" -->
      <div class="rule-note">
        当前策略：<strong>{{ ruleOf(category) }}</strong>
        <span v-if="category === 'logs'"> —— 近期日志会保留，只删除过期文件</span>
      </div>

      <div v-if="cleanResult" class="result" :class="{ err: !cleanResult.ok }">
        <div>{{ cleanResult.message }}</div>
        <div class="result-detail">
          已删除 {{ cleanResult.removed ?? 0 }} 项
          <span v-if="cleanResult.kept"> · 保留 {{ cleanResult.kept }} 项</span>
          <span v-if="cleanResult.failed"> · 失败 {{ cleanResult.failed }} 项</span>
        </div>
        <div v-if="cleanResult.failures?.length" class="result-detail">
          失败示例：{{ cleanResult.failures.join('；') }}
        </div>
      </div>
    </PanelCard>

    <PanelCard title="导出设置" desc="导出当前已保存的设置（未保存的修改不会被导出）">
      <FieldRow label="导出到" :width="72">
        <TextInput v-model="dest" mono placeholder="选择导出文件路径…" />
        <PillButton variant="ghost" size="sm" icon="folder" @click="useDefaultDest">默认路径</PillButton>
        <PillButton variant="solid" size="sm" icon="download" :loading="exporting" @click="doExport">
          导出
        </PillButton>
      </FieldRow>
      <div v-if="exportMsg" class="result">{{ exportMsg }}</div>
    </PanelCard>
    </div>

    <div
      v-show="tab === 'chat'"
      id="tb-panel-chat"
      class="tab-body"
      role="tabpanel"
      aria-labelledby="tb-tab-chat"
      :tabindex="0"
    >
      <AiChat />
    </div>

    <div
      v-show="tab === 'optimize'"
      id="tb-panel-optimize"
      class="tab-body"
      role="tabpanel"
      aria-labelledby="tb-tab-optimize"
      :tabindex="0"
    >
      <PromptOptimizer />
    </div>
  </div>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/views/ToolboxPanel.vue
职责：工具箱（数据占用统计 / 分类清理 / 配置导出 / AI 对话 / 提示词优化）。
================================================================================
  相对重构前的修正：
    1) window.confirm 阻塞渲染进程（真实问题）
       原代码在 clean() 里用 `if (!window.confirm(...)) return;`。
       在 Electron 中 window.confirm 会**同步阻塞整个渲染进程**，
       期间的动画、日志推送全部停摆；且样式与整个应用完全不一致。
       → 现在：改用主进程原生对话框（store.confirmDialog）。
    2) 本地硬编码了一份分类表 LABELS，与后端 CATEGORIES 重复；
       后端新增/调整分类（例如 keepDays 保留策略）前端一无所知。
       → 现在：分类从 data:categories 读取，并把「保留天数」如实展示，
         让用户在清理前知道"日志只删 7 天前的"而不是以为全删。
    3) 导出路径由前端自己拼接（base + settings-export.json），
       导出的其实是一份**旧设置**，而按钮文案写"导出配置"，
       用户在设置页改了值再点导出会拿到旧副本，极易误解。
       → 现在：文案明确为"导出当前已保存的设置"，并优先用
         主进程提供的 exportDir 作为默认位置。
    4) 清理结果的 removed/failed/kept 三项计数未展示，只有一句 message。
       → 现在：完整展示，失败时标红。
================================================================================
*/
import { onBeforeUnmount, onMounted, ref } from 'vue';
import PanelCard from '../components/ui/PanelCard.vue';
import FieldRow from '../components/ui/FieldRow.vue';
import TextInput from '../components/ui/TextInput.vue';
import PillButton from '../components/ui/PillButton.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import IconGlyph from '../components/IconGlyph.vue';
import AiChat from '../components/toolbox/AiChat.vue';
import PromptOptimizer from '../components/toolbox/PromptOptimizer.vue';
import { toast } from '../composables/useToast.js';
import {
  cleanDataCategory,
  confirmDialog,
  exportBackendSettings,
  getDataCategories,
  getDataStats,
  loadPaths,
  store
} from '../stores/app-store.js';

const tab = ref('data');

/** 组件是否仍挂载（防止卸载后继续写状态 / 发请求） */
let alive = true;

const stats = ref([]);
const root = ref('');
const loadingStats = ref(false);
/*
  哪些分类只统计了部分文件。
  注意：主进程 **没有** 顶层 truncated 字段，只有每个 stat 自己的
  `truncated`（data.js:177）—— 必须由这里汇总，不能读 r.truncated。
*/
const truncatedKeys = ref([]);

/** 分类元数据来自主进程（含 keepDays 保留策略） */
const categories = ref([]);
const category = ref('logs');
const cleaning = ref(false);
const cleanResult = ref(null);

const dest = ref('');
const exporting = ref(false);
const exportMsg = ref('');

function labelOf(key) {
  return categories.value.find((c) => c.key === key)?.label || key;
}

function ruleOf(key) {
  const c = categories.value.find((x) => x.key === key);
  if (!c) return '';
  return c.keepDays > 0 ? `保留最近 ${c.keepDays} 天` : '全部删除';
}

/* 说明：这里原来还有一个 human(bytes)——主进程已经把 humanSize 算好返回
   （data.js:178），模板从未调用过这个本地实现，属死代码，已删除。 */

async function loadStats() {
  loadingStats.value = true;
  try {
    const r = await getDataStats();
    /*
      失败时**不要先清空**。
      原实现无条件 `stats.value = ... : []` 然后才 toast：
      点「刷新」时一旦 data:stats 失败，已加载的列表会先被清空、
      页面退化成空状态，只有一条容易被忽略的 warn。
      用户看到的是"我的数据统计没了"，而不是"这次没读到"。
    */
    if (r?.ok === false) {
      toast(r.message || '获取统计失败（已保留上次结果）', 'warn', 5000);
      return;
    }
    stats.value = Array.isArray(r?.stats) ? r.stats : [];
    root.value = r?.root || '';
    /* 从各分类汇总"只统计了部分文件"的情况（主进程无顶层 truncated） */
    truncatedKeys.value = stats.value.filter((s) => s?.truncated).map((s) => s.key);
  } catch (e) {
    toast('获取统计失败：' + (e?.message || e), 'error');
  } finally {
    loadingStats.value = false;
  }
}

async function loadCategories() {
  try {
    const list = await getDataCategories();
    if (Array.isArray(list) && list.length) {
      categories.value = list;
      if (!list.find((c) => c.key === category.value)) category.value = list[0].key;
    } else {
      /* 之前失败时静默留空：策略显示为空但「清理」照旧可点 */
      toast('未能读取数据分类，清理策略不可用', 'warn', 4500);
    }
  } catch (e) {
    toast('未能读取数据分类：' + (e?.message || e), 'warn', 4500);
  }
}

function useDefaultDest() {
  const dir = store.paths?.exportDir || store.paths?.base || '';
  if (!dir) {
    toast('尚未获取到导出目录', 'warn');
    return;
  }
  const sep = dir.includes('\\') ? '\\' : '/';
  dest.value = `${dir}${sep}maibot-settings.json`;
}

/** 用原生对话框确认（不再阻塞渲染进程） */
async function clean() {
  const label = labelOf(category.value);
  const rule = ruleOf(category.value);

  /*
    先预演（dryRun）：只列清单、不删任何文件。
    预演与真删在主进程里共用同一份计划，所以这里的数字就是真删会发生的事。
    预演失败时**不能**继续走确认框（否则用户会以为"没有可删的"）——如实报错并中止。
  */
  let preview = null;
  try {
    preview = await cleanDataCategory({ category: category.value, dryRun: true });
  } catch (e) {
    toast('预演失败：' + (e?.message || e), 'error', 5000);
    return;
  }
  if (!preview || preview.ok === false) {
    toast(preview?.message || '预演失败，未执行任何清理', 'error', 5000);
    return;
  }
  if (!preview.wouldRemove) {
    toast(preview.message || '没有符合清理条件的项目', 'info', 4000);
    return;
  }

  const previewLine =
    `预演结果：将删除 ${preview.wouldRemove} 项` +
    `（${preview.files} 个文件，${preview.humanSize}）` +
    (preview.kept ? `，保留 ${preview.kept} 项` : '') +
    (preview.items?.length
      ? `\n例如：${preview.items.slice(0, 5).join('、')}${preview.itemsTruncated ? ' …' : ''}`
      : '');

  const yes = await confirmDialog({
    type: 'warning',
    title: `清理「${label}」`,
    message: `确定要清理「${label}」吗？`,
    detail: `策略：${rule}。\n${previewLine}\n此操作不可撤销，被删除的文件无法恢复。`,
    buttons: ['取消', '确认清理'],
    defaultId: 1
  });
  if (!yes) return;

  cleaning.value = true;
  cleanResult.value = null;
  try {
    const r = await cleanDataCategory({ category: category.value, dryRun: false });
    cleanResult.value = r;
    if (r.ok) {
      toast(r.message || `已清理${label}`, 'success');
      await loadStats();
    } else {
      toast(r.message || '清理未完全成功', 'warn', 5000);
      await loadStats();
    }
  } finally {
    cleaning.value = false;
  }
}

/** 导出「当前已保存的」设置（修改未保存的草稿不会被导出） */
async function doExport() {
  if (!dest.value.trim()) {
    toast('请先指定导出路径', 'warn');
    return;
  }
  exporting.value = true;
  exportMsg.value = '';
  try {
    const r = await exportBackendSettings(dest.value.trim());
    if (r.ok) {
      exportMsg.value = `已导出到 ${r.path}`;
      toast('设置已导出', 'success');
    } else {
      exportMsg.value = r.message || '导出失败';
      toast(exportMsg.value, 'error', 5000);
    }
  } finally {
    exporting.value = false;
  }
}

onMounted(async () => {
  /*
    卸载守卫：loadPaths 是一次 IPC 往返，期间用户可能已经切走了。
    没有这个标记时，卸载后仍会继续发两次 IPC 并把结果写进
    一个已经不渲染的组件 —— 属于"幽灵请求"。
  */
  alive = true;
  if (!store.paths) await loadPaths();
  if (!alive) return;
  await loadCategories();
  await loadStats();
});

onBeforeUnmount(() => {
  alive = false;
});
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

/*
  页签栏。
  --------------------------------------------------------------------------
  原来底是写死的 rgba(255,255,255,.5)："半透明白膜"这种写法本身没法按主题
  翻转 —— 深色下把 alpha 链合成出来是 #8A8B8D 的亮灰，未选中页签文字
  （--ink-soft = --text-3 = #8f959d）落在上面只有 **1.13:1**（实测），
  整条页签栏等于糊成一片。现在走 --bar-bg（浅色 #f4f7fb / 深色 #101215）。
*/
.tab-bar {
  display: flex;
  gap: 0.375rem;
  padding: 0.25rem;
  border-radius: var(--radius-md);
  background: var(--bar-bg);
  border: 1px solid var(--line);
}

.tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0 0.875rem;
  /* 原来靠 padding 撑高度（7px 上下 → 33px），和同页的按钮（26px）对不上。
     改成固定行高，页签栏与 PillButton 小号取同一档体系。 */
  height: var(--h-ctl-sm);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background var(--dur-base) ease, color var(--dur-base) ease;
}

.tab svg {
  width: 16px;
  height: 16px;
  flex: none;
}

.tab:hover {
  color: var(--ink-strong);
  background: var(--row-bg-hover);
}

/*
  选中页签。
  文字色从 --theme-color 改为 --ink-strong：
  蓝字压在浮起底（浅色 #fff）上只有 4.48:1，12.5px 正文不达 AA 4.5；
  图标保留 --theme-color 做强调（图形元素阈值 3:1，且它才是"选中"的视觉信号）。
  浮起底与投影都走 token：深色下 --seg-active-shadow 为 none，
  改由 --seg-active-bg 提亮一档来分层（黑阴影在深底上本来也看不见）。
*/
.tab.active {
  color: var(--ink-strong);
  background: var(--seg-active-bg);
  box-shadow: var(--seg-active-shadow);
}

.tab.active svg {
  color: var(--theme-color);
}

/* 键盘可达性：页签是 role=tab 的按钮，必须看得见焦点 */
.tab:focus-visible {
  box-shadow: var(--focus-ring);
  outline: none;
}

.tab-body {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.stat-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/*
  统计行。
  --------------------------------------------------------------------------
  底原本是写死的 rgba(255,255,255,.62)：深色下合成出 #A9AAAC 亮灰，
  行内每一处文字都掉到不可读（实测 title 1.93:1 / path 2.00:1 / files 1.30:1）。
  现在走 --row-bg（浅色 = 卡片白，深色 = 比卡片亮一档的 #23272d）。

  路径与根目录从 --ink-faint 提到 --ink-soft：
  --ink-faint（--text-4）在规格里被明确定义成"只用于非必读标签"，
  而"数据到底存在哪个目录"是这一页最需要核对的信息，不是装饰。
  10.5px 的路径在白底 3.22:1 → 4.83:1（--text-3），深色底 3.55:1 → 5.47:1。
*/
.stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-md);
  background: var(--row-bg);
  border: 1px solid var(--line);
  transition: background var(--dur-base) ease;
}

/* 行级 hover 反馈：原来完全没有，鼠标扫过列表没有任何"这一行是可交互的"提示 */
.stat:hover {
  background: var(--row-bg-hover);
}

.stat-main {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.stat-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.stat-path {
  letter-spacing: var(--ls-sm);
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  color: var(--ink-faint);
  word-break: break-all;
}

.stat-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.125rem;
  flex: none;
}

.stat-size {
  font-size: 13px;
  font-weight: 600;
  /* 用 --accent-ink 而不是 --theme-color：后者深色下是 #5b8dff，压在卡片底
     (#1c1f24) 上过 AA，但这一行落在 #292d34 的浅一档底上，实测只有 4.41:1；
     --accent-ink 深色是 #7ba4ff（5.86:1）。这是"彩色文字用 *-ink"那条约定。 */
  color: var(--accent-ink);
}

.stat-files {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
}

.stat-root {
  letter-spacing: var(--ls-sm);
  margin-top: 0.125rem;
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  color: var(--ink-faint);
  word-break: break-all;
}

/* 「仅部分统计」提示：用警告色，避免把偏小的体积当成真实占用 */
.stat-trunc {
  letter-spacing: var(--ls-sm);
  margin-top: 0.375rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn);
  background: rgba(224, 161, 60, 0.13);
}

.select {
  letter-spacing: var(--ls-sm);
  flex: none;
  height: 32px;
  padding: 0 0.625rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  /* 底原本是写死的 rgba(255,255,255,.9)：深色主题下这一颗下拉是整页唯一
     不跟着主题走的白块（审计脚本按"深色主题下的亮底"直接报了出来）。
     走 --surface-2，与 TextInput 同底，深浅两套各自成立。 */
  background: var(--surface-2);
  font-size: 12px;
  color: var(--ink-strong);
  outline: none;
}

.select:focus {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 2.5px var(--theme-tint);
}

.result {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
  line-height: 1.6;
  padding-left: 0.125rem;
  word-break: break-all;
}

.result.err {
  color: var(--err-ink);
}

.result-detail {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-faint);
  margin-top: 0.125rem;
}

.rule-note {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--theme-tint);
}

.rule-note strong {
  color: var(--accent-ink);
}
</style>
