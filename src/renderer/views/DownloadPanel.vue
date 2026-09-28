<template>
  <div class="panel">
    <PanelCard title="下载源" desc="指定 GitHub 仓库与保存目录">
      <FieldRow label="仓库" :width="96">
        <TextInput v-model="repo" placeholder="MaiBot/MaiBot" @keyup.enter="load" />
        <PillButton variant="solid" size="sm" icon="refresh" :loading="loading" @click="load">获取版本</PillButton>
      </FieldRow>
      <!--
        常用源快捷按钮。
        ────────────────────────────────────────────────────────────────
        为什么必须给：此前只有手填仓库名这一条路，默认值是 MaiBot，而 MaiBot 的
        Release **不上传附件**（实测 30 个版本里只有 3 个老的 pre 版挂了文件）——
        于是打开就是满屏「该版本没有可下载的附件」，用户也无从知道仓库名可以改成
        SnowLuma，更不知道它的每个版本都有 Windows 包。

        两个值全部取自设置（github.repo / snowlumaRepo），
        与主进程 constants.js 的 REPOS 是同一份来源，渲染层不硬编码仓库名。
      -->
      <div class="presets">
        <span class="presets-label">常用源</span>
        <PillButton
          v-for="p in presets"
          :key="p.label"
          variant="ghost"
          size="sm"
          :class="{ on: repo.trim() === p.repo }"
          @click="pickRepo(p.repo)"
        >
          {{ p.label }}
        </PillButton>
      </div>
      <FieldRow label="保存目录" :width="96">
        <TextInput v-model="destDir" mono placeholder="默认保存到 MaiBot 缓存目录" />
        <PillButton variant="ghost" size="sm" icon="folder" @click="useCacheDir">用缓存目录</PillButton>
      </FieldRow>
    </PanelCard>

    <PanelCard title="可用版本" :desc="`共 ${store.releases.length} 个版本`">
      <template #head>
        <PillButton
          v-if="activeCount"
          variant="ghost"
          size="sm"
          icon="close"
          @click="clearProgress"
        >
          清除进度
        </PillButton>
      </template>

      <div v-if="store.releases.length" class="rel-list">
        <div v-for="rel in store.releases" :key="rel.id || rel.tag_name" class="rel">
          <div class="rel-head">
            <div class="rel-title">
              <span class="rel-tag">{{ rel.tag_name }}</span>
              <span v-if="rel.prerelease" class="rel-flag">预发布</span>
            </div>
            <span class="rel-name">{{ rel.name || rel.tag_name }}</span>
            <span v-if="rel.published_at" class="rel-date">
              {{ new Date(rel.published_at).toLocaleDateString() }}
            </span>
          </div>

          <div v-if="assetsOf(rel).length" class="assets">
            <div v-for="a in assetsOf(rel)" :key="a.id || a.name" class="asset">
              <div class="asset-top">
                <div class="asset-info">
                  <span class="asset-name">{{ a.name }}</span>
                  <span class="asset-size">{{ humanSize(a.size) }}</span>
                </div>
                <PillButton
                  variant="ghost"
                  size="sm"
                  icon="download"
                  :loading="downloading === a.name"
                  @click="download(rel, a)"
                >
                  下载
                </PillButton>
              </div>
              <!--
                进度另起一行，满宽显示。
                原先它挤在按钮左边的一小段里，只有一根 84px 的条和一句
                「已下/总 · host」—— 速率、剩余时间、线程数、校验结论
                一个都放不下，于是"多线程"和"SHA-256 校验"在界面上完全不可见，
                用户只能从日志里猜它们有没有生效。
                展示逻辑与安装器页共用 DownloadProgress.vue，避免两处口径分叉。
              -->
              <DownloadProgress v-if="progress[a.name]" :data="progress[a.name]" />
            </div>
          </div>
          <div v-else class="no-asset">
            该版本没有可下载的附件
            <span v-if="isMaibotRepo" class="no-asset-tip">
              —— MaiBot 的 Release 只发源码、不上传附件，所以这里没得下。
              要装源码请用上方「安装与环境」标签的安装/升级；要下带附件的包，
              点上面的「常用源」切到 SnowLuma。
            </span>
            <span v-else class="no-asset-tip">—— 换个版本，或换个仓库试试。</span>
          </div>
        </div>
      </div>

      <EmptyState v-else icon="download" text="尚未获取版本列表" />
    </PanelCard>
  </div>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/views/DownloadPanel.vue
职责：浏览上游 Release 并下载任意附件。
================================================================================
  相对重构前的修正：
    1) load() 把返回对象当数组用（真实显示 bug）
       原代码：`const list = await loadReleases(...)` 然后 `list.length`。
       而 loadReleases 返回的是 {ok, repo, count} 对象（数组在 store.releases），
       于是提示永远是"获取到 undefined 个版本"，即便实际成功。
       → 现在：读取 r.count。
    2) 进度对象只增不减，且下载完成后仅删当前项 —— 其余历史条目永久残留
       （旧实现里下载成功才 delete，失败的会一直挂在界面上显示 0%）。
       → 现在：失败保留并标红，成功清除，并提供"全部清除"。
    3) 下载失败不汇报镜像来源，用户无法判断是网络还是文件名问题。
       → 现在：展示 phase / 已下载体积 / 来源主机。
    4) 仓库名作为进度订阅键 —— 同一仓库不同附件会互相覆盖。
       现在主进程改用固定的 'asset' 标签 + fileName 区分。
    5) 进度只有一根 84px 的细条 + 「已下/总 · host」，多线程与 SHA-256 校验
       在界面上完全不可见（主进程明明已经上报了 segments / bytesPerSec /
       etaSec / verify）。→ 现在改用共用的 DownloadProgress.vue，
       把速率、ETA、线程数与校验结论如实展示出来；两页共用一份实现，
       避免安装器页与下载页各写一套导致口径分叉。
================================================================================
*/
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PanelCard from '../components/ui/PanelCard.vue';
import FieldRow from '../components/ui/FieldRow.vue';
import TextInput from '../components/ui/TextInput.vue';
import PillButton from '../components/ui/PillButton.vue';
import EmptyState from '../components/ui/EmptyState.vue';
/* 进度展示与安装器页共用同一份实现（速率/ETA/线程数/校验结论） */
import DownloadProgress from '../components/ui/DownloadProgress.vue';
import { toast } from '../composables/useToast.js';
import {
  downloadAsset,
  loadPaths,
  loadReleases,
  store,
  subscribeDownload
} from '../stores/app-store.js';

const repo = ref(store.settings?.github?.repo || 'Mai-with-u/MaiBot');
const destDir = ref(store.paths?.cacheDir || '');
const loading = ref(false);
const downloading = ref('');
/** fileName → 进度对象 */
const progress = ref({});

let offProgress = null;

const activeCount = computed(() => Object.keys(progress.value).length);

/*
  常用源。两个值都来自设置，不在这里写死仓库名 ——
  主进程 constants.js 的 REPOS 才是唯一来源（settings.js 会校验格式并兜底）。
*/
const presets = computed(() => [
  { label: 'MaiBot', repo: store.settings?.github?.repo || 'Mai-with-u/MaiBot' },
  { label: 'SnowLuma', repo: store.settings?.github?.snowlumaRepo || 'SnowLuma/SnowLuma' }
]);

/** 当前是不是 MaiBot 仓库 —— 决定「没有附件」时给哪段解释 */
const isMaibotRepo = computed(
  () => repo.value.trim() === (store.settings?.github?.repo || 'Mai-with-u/MaiBot')
);

function pickRepo(next) {
  if (!next) return;
  if (next === repo.value.trim()) {
    load();
    return;
  }
  /* 赋值即可：下面 watch(repo) 会去拉该仓库的 releases */
  repo.value = next;
}

function assetsOf(rel) {
  return Array.isArray(rel?.assets) ? rel.assets : [];
}

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

async function useCacheDir() {
  if (!store.paths) await loadPaths();
  destDir.value = store.paths?.cacheDir || '';
  if (!destDir.value) toast('尚未获取到缓存目录', 'warn');
}

/** 附件下载进度统一走 'asset' 标签 */
function subscribeProgress() {
  if (offProgress) {
    offProgress();
    offProgress = null;
  }
  offProgress = subscribeDownload('asset', (p) => {
    if (p?.fileName) {
      progress.value = { ...progress.value, [p.fileName]: p };
    }
  });
}

function clearProgress() {
  progress.value = {};
}

async function load() {
  loading.value = true;
  try {
    const r = await loadReleases(repo.value.trim() || undefined);
    /* 关键修正：loadReleases 返回 {ok, count}，旧实现误当数组取 .length */
    if (r.ok) toast(`获取到 ${r.count} 个版本`, r.count ? 'success' : 'info');
    else toast(r.message || '获取失败', 'error', 5000);
  } finally {
    loading.value = false;
  }
}

async function download(rel, asset) {
  if (!destDir.value) {
    toast('请先指定保存目录', 'warn');
    return;
  }
  downloading.value = asset.name;
  progress.value = {
    ...progress.value,
    [asset.name]: { percent: 0, received: 0, total: asset.size, phase: 'start' }
  };
  try {
    const r = await downloadAsset({
      repo: repo.value.trim(),
      tag: rel.tag_name,
      fileName: asset.name,
      assetUrl: asset.browser_download_url,
      destDir: destDir.value,
      size: asset.size,
      /*
        必须把上游摘要传下去。
        GitHub Release 会给每个附件发布 sha256（digest 字段），主进程的
        normalizeRelease 已把它解析成 64 位小写十六进制。**不传**的话后端
        只能退化成"只比大小"，而界面照样显示"下载完成" ——
        用户会以为文件校验过了，其实一次哈希都没算。这种"静默降级"没有症状，
        所以这里漏传一次就等于整个校验特性白做。
        digest 为空串是正常情况（老附件或未发布摘要），后端会如实降级为只校验大小。
      */
      sha256: asset.digest
    });
    if (r?.ok) {
      /* 如实说明校验到了哪一步，不能一律报"完成" */
      const how =
        r.verify === 'sha256' ? '，SHA-256 校验通过' : r.verify === 'size' ? '，已校验大小' : '';
      toast(`已下载 ${asset.name}（${humanSize(r.bytes)}${how}）`, 'success', 4000);
      /* 成功后移除该条目，避免残留 100% 行 */
      const next = { ...progress.value };
      delete next[asset.name];
      progress.value = next;
    } else {
      progress.value = {
        ...progress.value,
        [asset.name]: { ...(progress.value[asset.name] || {}), phase: 'error', message: r?.message }
      };
      toast(r?.message || '下载失败', 'error', 6000);
    }
  } catch (e) {
    toast('下载失败：' + (e?.message || e), 'error');
  } finally {
    downloading.value = '';
  }
}

/*
  仓库输入的去抖。
  ──────────────────────────────────────────────────────────────────
  这个 watch 原来直接绑在输入框上：每敲一个字符就打一次 github:releases。
  输入 "SnowLuma/SnowLuma"（19 字符）＝ 19 次 GitHub API 请求，
  而 GitHub 匿名调用是有速率限制的 —— 用户只是正常打一个仓库名，
  就可能把自己打进 403，然后看到"版本列表加载失败"。
  现在等 500ms 没有新输入再发一次；离开页面时清掉定时器。
*/
let repoDebounce = 0;
watch(repo, (val) => {
  if (repoDebounce) clearTimeout(repoDebounce);
  const v = String(val || '').trim();
  if (!v) return;
  repoDebounce = window.setTimeout(() => {
    repoDebounce = 0;
    loadReleases(v);
  }, 500);
});

onMounted(async () => {
  if (!store.paths) await loadPaths();
  destDir.value = store.paths?.cacheDir || '';
  subscribeProgress();
  await load();
});

onBeforeUnmount(() => {
  if (repoDebounce) clearTimeout(repoDebounce);
  if (offProgress) offProgress();
});
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.rel-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.rel {
  padding: 0.75rem 0.75rem;
  border-radius: var(--radius-md);
  background: var(--row-bg);
  border: 1px solid var(--line);
}

.rel-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.rel-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.rel-tag {
  font-size: 13px;
  font-weight: 700;
  color: var(--theme-color);
}

.rel-flag {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  font-weight: 600;
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  background: var(--warn-tint);
  /* --warn 是给图形元素（≥3:1）的：压在 18% 淡橙底上只有 2.95:1，
     10px 文字读不出来。改用 --warn-ink（5.12:1 / 深色 6.34:1），
     这也是 theme.css 里"彩色文字一律用 *-ink"那条约定。 */
  color: var(--warn-ink);
}

.rel-name {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rel-date {
  letter-spacing: var(--ls-sm);
  margin-left: auto;
  flex: none;
  font-size: 12px;
  color: var(--ink-faint);
}

.assets {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.asset {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-sm);
  background: var(--field-bg);
  border: 1px solid var(--line);
}

/* 文件名/大小在左，下载按钮在右；进度另占下面一行 */
.asset-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem;
}

.asset-info {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.asset-name {
  letter-spacing: var(--ls-sm);
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  color: var(--ink-strong);
  word-break: break-all;
}

.asset-size {
  letter-spacing: var(--ls-sm);
  flex: none;
  font-size: 12px;
  color: var(--ink-faint);
}

.no-asset {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-faint);
}

/* 「没有附件」时的解释文字：比主句更淡，且允许换行 */
.no-asset-tip {
  color: var(--ink-faint);
  opacity: 0.85;
}

/* 常用源快捷按钮行 */
.presets {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}

.presets-label {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-faint);
  margin-right: 0.125rem;
}

/*
  PillButton 是子组件，class 落在它的根节点（.pill）上，
  scoped 选择器要有 :deep 才能命中。
*/
.presets :deep(.pill.on) {
  color: var(--theme-color);
  background: var(--theme-tint);
  border-color: transparent;
}
</style>
