<template>
  <!--
    启动器「检查更新」的二级窗口。
    ────────────────────────────────────────────────────────────────────────
    为什么做成遮罩式二级窗口，而不是跳到 /about 或插一行提示：
      用户的要求原话是"点击弹出一个二级窗口显示更新内容，点击更新显示进度"。
      更新是**模态**操作：它会把启动器自己换成新版本并让进程退出，
      在一张会被别的操作打断的页面里做这件事，用户很容易在中途点走。

    样式来源（**没有新增任何设计令牌**）：
      · 承载面 --surface-1 / 描边 --line / 阴影 --shadow-2 / 圆角 --r-modal，
        全部是 theme.css 里已有的令牌，深浅两套主题各有一档；
      · 按钮直接用 PillButton，版本徽标用 StatusBadge，
        图标用 IconGlyph —— 与设置页/关于页同一套组件；
      · 进度条沿用 DownloadProgress.vue 的画法（满宽 + scaleX 的轨道），
        尺寸与速率/ETA 的取值口径也一致，避免同一个应用里两套进度语言。
  -->
  <!--
    为什么整块 Teleport 到 <body>：
      启动器是 frame:false 的无边框窗口，最上面那条 44px 的自绘标题栏
      （AppLayout 的 .titlebar）是 **窗口的拖动区域**（-webkit-app-region: drag）。
      实测（CDP：opaque 遮罩 + clip 截图）：只要遮罩还留在 .shell 里，
      标题栏就会**画在遮罩之上** —— 把遮罩改成纯黑、把 z-index 提到 9999
      都不起作用；而同一个遮罩一旦挂到 <body> 末尾就立刻盖住了它。
      根因是拖动区域参与的是窗口级的命中/合成，普通的层叠上下文压不住它。
      所以这里用 Teleport 把整窗遮罩放到 body 末尾 —— 不改 AppLayout、
      不改标题栏的拖动行为，也不动任何设计令牌。
      （渲染层的层序：遮罩 z-index 80 > 标题栏 3；toast 是 9999，仍然在最上面。）
  -->
  <Teleport to="body">
    <div
      v-if="mounted"
      class="upd-mask"
      :class="{ 'is-in': entered, 'is-out': !visOpen }"
      role="dialog"
      aria-modal="true"
      aria-label="检查更新"
      data-testid="upd-mask"
      @click.self="onMaskClick"
      @animationend="onMaskAnimEnd"
    >
      <div
        v-if="visOpen"
        class="upd"
        data-testid="update-dialog"
      >
        <header class="upd-head">
          <span class="upd-title">
            <IconGlyph name="download" class="upd-title-ico" />
            检查更新
          </span>
          <button
            class="upd-x"
            type="button"
            aria-label="关闭"
            data-testid="update-close"
            @click="close"
          >
            <IconGlyph name="close" />
          </button>
        </header>

        <!-- ==================================================== 第一屏：版本信息 -->
        <section v-if="!isDownloading" class="upd-body">
          <div class="upd-vers">
            <span class="upd-vbox">
              <span class="upd-vlabel">当前版本</span>
              <span class="upd-vnum">v{{ currentText }}</span>
            </span>
            <span class="upd-arrow" aria-hidden="true">→</span>
            <span class="upd-vbox">
              <span class="upd-vlabel">最新版本</span>
              <span class="upd-vnum" :class="{ hot: hasUpdate }">{{ latestText }}</span>
            </span>
            <StatusBadge v-if="statusBadge" :tone="statusBadge.tone">
              {{ statusBadge.text }}
            </StatusBadge>
          </div>

          <!--
            下载完成（ready）：进度屏结束后回到这一屏，所以这里必须给一句
            **明确的完成结论** —— 否则用户看到的是"进度条突然消失、只剩更新内容"，
            会怀疑到底下没下完。字节数是主进程校验通过的真实值。
          -->
          <div v-if="phase === 'ready'" class="upd-note upd-note-ok" data-testid="update-ready">
            <IconGlyph name="check" class="upd-note-ico" />
            <span class="upd-note-text">{{ readyMessage }}</span>
          </div>

          <!-- 检查中 -->
          <div v-if="phase === 'checking'" class="upd-note upd-note-quiet">
            <LoadingSpinner size="sm" inline />
            <span>正在检查更新…</span>
          </div>

          <!-- 检查失败：**原样**显示主进程给的真实原因 -->
          <template v-else-if="phase === 'error'">
            <div class="upd-note upd-note-err" data-testid="update-error">
              <IconGlyph name="info" class="upd-note-ico" />
              <span class="upd-note-text">{{ realMessage }}</span>
            </div>
            <p v-if="!configured" class="upd-hint">
              更新源是主进程里的一个常量：仓库地址还没填时这里不会去访问任何网络，
              所以「重试」不会有任何变化 —— 请先配置更新源。
            </p>
          </template>

          <!--
            更新说明：**有新版与「已是最新」两种情况都要显示**。
            原来整块包在 v-if="hasUpdate" 里 —— 于是"已是最新"时用户只看到一句
            "已是最新版本"，什么更新内容都看不到（哪怕 Release 里写了说明）。
            现在两种情况共用同一份数据（主进程返回的 Release notes = u.notes）：
              · 有新版   → 那是**最新版**的说明，标题带最新版号；
              · 已是最新 → 仓库的最新发布就是用户正在用的这一版，即**当前版本**的说明。
            两种情况都只按纯文本渲染（{{ }} 插值），绝不 v-html。
          -->
          <template v-else>
            <!-- 已是最新：先给结论行（有新版时结论由上方版本对照 + 徽标给出） -->
            <div v-if="!hasUpdate" class="upd-note upd-note-ok" data-testid="update-latest">
              <IconGlyph name="check" class="upd-note-ico" />
              <span class="upd-note-text">{{ realMessage || `已是最新版本（${currentText}）` }}</span>
            </div>

            <!-- 说明块：只有真的查出结果（有新版本 / 已是最新 / 下载完成）才出现 -->
            <div v-if="showNotes" class="upd-notes" data-testid="update-notes">
              <div class="upd-notes-head">
                <span class="upd-notes-title">{{ notesTitle }}</span>
                <span v-if="publishedText" class="upd-notes-date">发布于 {{ publishedText }}</span>
              </div>
              <!--
                ⚠️ Release notes 是**外部文本**，只按纯文本渲染（{{ }} 插值），
                绝不 v-html —— 上游 Release body 里可以写任意 HTML/脚本。
                这里只做"按行 / 要点"的排版：列表标记单独成一列，正文按原样显示。
              -->
              <div v-if="notesLines.length" class="upd-notes-body">
                <div
                  v-for="(line, i) in notesLines"
                  :key="i"
                  class="upd-line"
                  :class="{ bullet: line.bullet, heading: line.heading, sub: line.level >= 3 }"
                >
                  <span v-if="line.bullet" class="upd-dot" aria-hidden="true">•</span>
                  <span class="upd-line-text">{{ line.text }}</span>
                </div>
              </div>
              <p v-else class="upd-note upd-note-quiet">
                {{ notesEmptyText }}
              </p>
            </div>

            <p v-if="assetText" class="upd-hint">安装包：{{ assetText }}</p>
          </template>
        </section>

        <!-- ==================================================== 第二屏：下载进度 -->
        <section v-else class="upd-body">
          <div class="upd-pline">
            <span class="upd-pnum" data-testid="update-percent">{{ percentText }}</span>
            <span class="upd-pbar">
              <i :style="{ transform: 'scaleX(' + percent / 100 + ')' }" />
            </span>
          </div>

          <div class="upd-pmeta">
            <span v-if="bytesText">{{ bytesText }}</span>
            <span v-if="rateText" class="upd-prate">{{ rateText }}</span>
            <span v-if="etaText">{{ etaText }}</span>
            <span v-if="channelText" class="upd-pchan" :title="channelText">
              来源 {{ channelText }}
            </span>
          </div>

          <p class="upd-hint">
            {{ downloadHint }}
          </p>

          <!--
            失败通道明细：这是"逐通道如实记录原因"的落点。
            全部通道失败时主进程会把每条原因放在 message 里，同时 attempts 里
            也有结构化的一份 —— 这里按结构化数据逐条列出，用户能直接看出
            是哪个镜像挂了、为什么挂（HTTP 404 / 超时 / 字节数不符）。
          -->
          <div v-if="attempts.length" class="upd-attempts" data-testid="update-attempts">
            <div v-for="(a, i) in attempts" :key="i" class="upd-attempt">
              <span class="upd-attempt-ch">{{ a.channel }}</span>
              <span class="upd-attempt-msg">{{ a.message }}</span>
            </div>
          </div>
        </section>

        <!-- ==================================================== 底部操作 -->
        <footer class="upd-foot">
          <template v-if="!isDownloading">
            <!--
              「上次检查时间 / 缓存」必须留在屏幕上，且**取的是真实检查时刻**。
              窗口在 TTL 内直接复用缓存时，这里会如实写"来自缓存 · 检查于 HH:MM:SS"，
              绝不会因为"刚打开窗口"就显示成"刚刚查过" —— 那正是要避免的误导。
            -->
            <span
              v-if="statusLabel"
              class="upd-status"
              :class="{ cached: u.fromCache }"
              data-testid="update-cache-note"
            >
              <IconGlyph :name="u.fromCache ? 'info' : 'check'" class="upd-status-ico" />
              <span>{{ statusLabel }}</span>
            </span>
            <span class="upd-spacer" />
            <PillButton
              v-if="canRecheck"
              variant="ghost"
              size="sm"
              icon="refresh"
              :loading="checking"
              data-testid="update-recheck"
              @click="recheck"
            >
              重新检查
            </PillButton>
            <PillButton variant="plain" size="sm" data-testid="update-later" @click="close">
              稍后
            </PillButton>
            <PillButton
              v-if="hasUpdate && phase === 'available'"
              variant="solid"
              size="sm"
              icon="download"
              data-testid="update-start"
              @click="startDownload"
            >
              更新
            </PillButton>
            <PillButton
              v-else-if="phase === 'ready'"
              variant="solid"
              size="sm"
              icon="check"
              data-testid="update-install"
              @click="doInstall"
            >
              重启并安装
            </PillButton>
          </template>

          <template v-else>
            <!--
              这里**不再重复**上面的 downloadHint：同一句话在正文与页脚各写一遍，
              用户会以为是两条不同的信息（"为什么说了两次？"）。
              下载中只有「取消」这一件事需要留在页脚。
            -->
            <span class="upd-spacer" />
            <PillButton variant="plain" size="sm" icon="close" @click="onCancel">取消</PillButton>
          </template>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/components/UpdateDialog.vue
职责：启动器「检查更新」的二级窗口（版本信息屏 + 下载进度屏）。
================================================================================
  与主界面的关系：
    · 状态**不在本组件里**，而是读 app-store 的 store.update ——
      用户把窗口关掉再打开时进度不会丢（下载是长任务，主进程还在跑）；
    · 进度订阅在本组件挂载时建立、卸载时释放（createSubscriptionScope），
      不往全局登记，避免"关掉弹窗进度还在改状态"这类泄漏。
================================================================================
*/
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconGlyph from './IconGlyph.vue';
import PillButton from './ui/PillButton.vue';
import StatusBadge from './ui/StatusBadge.vue';
import LoadingSpinner from './ui/LoadingSpinner.vue';
import { toast } from '../composables/useToast.js';
import {
  cancelLauncherUpdate,
  checkLauncherUpdate,
  createSubscriptionScope,
  downloadLauncherUpdate,
  installLauncherUpdate,
  recheckLauncherUpdate,
  store,
  subscribeLauncherUpdateProgress
} from '../stores/app-store.js';

const props = defineProps({
  /** 窗口是否可见（v-if 由父组件控制时传 true 即可） */
  open: { type: Boolean, default: false }
});
const emit = defineEmits(['close', 'update:open']);

/** 更新状态（store 是响应式的，这里只是取个短名字） */
const u = computed(() => store.update);
const phase = computed(() => u.value.phase);
const checking = computed(() => phase.value === 'checking');
const hasUpdate = computed(() => Boolean(u.value.hasUpdate));
const configured = computed(() => u.value.configured !== false);
const isDownloading = computed(() => phase.value === 'downloading');

/** 第一屏的"当前版本"：优先用主进程回传的，其次用 app:info 里的 */
const currentText = computed(() => u.value.current || store.info.version || '—');
const latestText = computed(() => u.value.latest || '—');

/* ----------------------------------------------------- 缓存 / 重新检查 */

/**
 * 「上次检查时间」。
 *
 * ⚠️ 取的是 store.update.checkedAt —— 那是**真正打过网络的那一次**的时刻。
 *    缓存命中时它保持原值，所以界面上的时间是真实的，
 *    不会因为"窗口刚打开"而变成当前时刻（那是要避免的误导）。
 */
const checkedClock = computed(() => {
  const t = Number(u.value.checkedAt);
  if (!Number.isFinite(t) || t <= 0) return '';
  return new Date(t).toLocaleTimeString();
});

/**
 * 页脚那句"上次检查"。
 *   · 检查中     → 正在检查更新…
 *   · 有结论     → 来自缓存 · 检查于 20:33:19   /   刚刚检查于 20:33:19
 *   · 没查过     → 空（一个字都不显示，不编一个时间）
 */
const statusLabel = computed(() => {
  if (checking.value) return '正在检查更新…';
  if (!checkedClock.value) return '';
  return u.value.fromCache
    ? `来自缓存 · 上次检查 ${checkedClock.value}`
    : `刚刚检查（${checkedClock.value}）`;
});

/**
 * 是否显示「重新检查」。
 * 凡是**已经有过一次检查动作**的状态都给这个入口 —— 用户想立刻拿最新结果时
 * 不该被迫先关窗再开窗（原来的实现只在失败时才给，等于把最需要它的场景漏掉了）。
 * 下载中不给：那时页脚只有「取消」一件事。
 */
const canRecheck = computed(() => {
  const p = String(u.value.phase || '');
  if (p === 'downloading' || p === 'checking') return false;
  return p === 'error' || p === 'idle' ? true : p !== '';
});

/**
 * 说明块是否显示。
 * 只在**真的查出过结果**时显示：有新版本（available）/ 已是最新（latest）/
 * 安装包已下载完成（ready，此时说明仍是那一次检查的最新版说明）。
 * 检查中、失败、还没查（idle）时一个字都不显示 —— 那几种状态没有可信的说明可给。
 */
const showNotes = computed(() =>
  ['available', 'latest', 'ready'].includes(String(u.value.phase || ''))
);

/**
 * 说明块的标题。
 *   · 有新版   → 这份 notes 是**最新版**的 → 「更新内容（v2.2.0）」
 *   · 已是最新 → 仓库的最新发布就是当前这一版 → 「当前版本说明（v2.1.0）」
 * 版本号取 Release 的 tag（拿不到才退回当前版本号），不编造。
 * ⚠️ tag 形如 `v2.1.0`（自带 v），app.getVersion() 形如 `2.1.0`（不带）——
 *    统一补一次 v，否则会渲染成 "vv2.1.0"（实测踩到过）。
 */
const notesTitle = computed(() => {
  const raw = String(u.value.latest || currentText.value || '').trim();
  const tag = /^v/i.test(raw) ? raw : `v${raw}`;
  return hasUpdate.value ? `更新内容（${tag}）` : `当前版本说明（${tag}）`;
});

/** Release notes 为空时的说明：区分"最新版没写"与"当前版本没写"，都不编内容 */
const notesEmptyText = computed(() =>
  hasUpdate.value
    ? '这次发布没有填写更新说明（Release notes 为空）。'
    : '当前版本对应的 Release 没有填写更新说明（Release notes 为空）。'
);

/**
 * 真实消息。**不做任何替换**：
 * 主进程给什么就显示什么（"未配置更新源…" / "HTTP 404…" / "字节数不符…"）。
 * 这里唯一做的是在没有 message 时给一句中性的兜底，而不是编一个"网络错误"。
 */
const realMessage = computed(() => u.value.message || '检查更新没有返回任何说明');

const statusBadge = computed(() => {
  if (phase.value === 'checking') return { tone: 'neutral', text: '检查中' };
  if (phase.value === 'error') return { tone: 'err', text: '检查失败' };
  if (phase.value === 'latest') return { tone: 'ok', text: '已是最新' };
  if (hasUpdate.value) return { tone: 'theme', text: '可更新' };
  return null;
});

const publishedText = computed(() => {
  const raw = u.value.publishedAt;
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString();
});

/**
 * Release notes → 按行渲染的数据。
 *
 * 只做"这行是什么"这一件事，**不改写正文**：
 *   · 行首的 - / * / • / 数字.        → 列表项：单独一列圆点，正文去掉那个标记；
 *   · 行首的 ## / ### …（ATX 标题）    → 标题：去掉 # 号，用字重区分（级别带出来）；
 *   · 其余行原样显示（空行保留为空行，用来分段）。
 *
 * 之所以不去解析 markdown / 不注入 HTML：notes 是外部文本，
 * 一旦给它渲染成富文本，就等于把"显示更新内容"变成"执行上游给的标记"
 * （Release body 里可以写任意 HTML/脚本）。
 * 这里去掉的只是 `#` 与 `-` 这类**纯文本排版符号**，输出始终是文本节点。
 */
const notesLines = computed(() => {
  const raw = String(u.value.notes || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .slice(0, 200)
    .map((line) => {
      const head = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        return { heading: true, level: head[1].length, text: head[2], bullet: false };
      }
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) return { bullet: true, text: m[1], heading: false, level: 0 };
      return { bullet: false, text: line, heading: false, level: 0 };
    });
});

/* -------------------------------------------------------------- 进度（真实值） */

const percent = computed(() => {
  const n = Number(u.value.percent);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
});
const percentText = computed(() => `${Math.round(percent.value)}%`);

/** 已下 / 总：总大小未知时只显示已下多少，不编一个分母 */
const bytesText = computed(() => {
  const got = humanSize(u.value.received);
  const all = Number(u.value.total) > 0 ? humanSize(u.value.total) : '';
  if (!got) return '';
  return all ? `${got} / ${all}` : got;
});

const rateText = computed(() => {
  const n = Number(u.value.bytesPerSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB/s`;
  return `${Math.round(n)} B/s`;
});

/** 剩余时间：主进程只在"有总大小且在收数据"时给，null 就一个字都不显示 */
const etaText = computed(() => {
  const n = Number(u.value.etaSec);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 60) return `剩余 ${Math.round(n)} 秒`;
  if (n < 3600) return `剩余 ${Math.floor(n / 60)} 分 ${Math.round(n % 60)} 秒`;
  return `剩余 ${Math.floor(n / 3600)} 小时 ${Math.round((n % 3600) / 60)} 分`;
});

const channelText = computed(() => String(u.value.channel || ''));
const attempts = computed(() => (Array.isArray(u.value.attempts) ? u.value.attempts : []));

/**
 * 安装包一行说明：文件名 + 大小。
 * 大小来自 Release 元数据（也就是下载时用来校验的那个数），
 * 不显示"预计 91.6 MB"这种估出来的数字。
 */
const assetText = computed(() => {
  const a = u.value.asset;
  if (!a || !a.name) return '';
  const size = Number(a.size) > 0 ? `（${humanSize(a.size)}）` : '';
  return `${a.name}${size}`;
});

const downloadHint = computed(() => {
  if (phase.value === 'error') return u.value.message || '下载失败';
  if (percent.value >= 99) return '下载完成，正在核对字节数…';
  if (!Number(u.value.received)) return '正在连接下载通道（按加速通道顺序尝试）…';
  return '正在下载安装包，可随时取消；下载完成后需点「重启并安装」。';
});

/**
 * 下载完成后的结论行。
 * 写清三件事：下完了、校验过了（多少字节）、点下去会发生什么（启动器会退出）。
 */
const readyMessage = computed(() => {
  const size = humanSize(u.value.received || u.value.total);
  return `安装包已下载并校验完成${size ? `（${size}）` : ''}。点「重启并安装」后启动器会退出，安装过程由安装包自己完成。`;
});

/* -------------------------------------------------- 开关窗口的进出场动画 */

/**
 * 入场/出场过渡（淡入 + 轻微缩放/位移，180ms）。
 *
 * 为什么不用 Vue <Transition> 的 CSS 过渡钩子、而是自己按 animationend 收尾：
 *   ① 出场动画需要节点**先留在 DOM 里播完再移除**，所以遮罩不能直接 v-if="open"，
 *      中间要有一个"退场中"的中间态；
 *   ② 用 CSS transition 时类名必须等到下一帧才加得上（否则浏览器把两次样式
 *      变更合并成一次计算、动画根本不播），而 after-leave 依赖 transitionend
 *      在"元素中途消失/被样式打断"时不会触发，会留下一个再也关不掉的遮罩。
 *   ③ animation + animationend + 兜底定时器两者都稳：**无论动画有没有真的播放，
 *      状态一定在 duration 内收敛**（兜底时长与样式表里的时长同源）。
 *
 * 尊重 prefers-reduced-motion: reduce —— 样式块里那个媒体查询把 mask 的动画
 * 整个关掉（animation: none），这里读到的 animationDuration 因此是 0s，
 * 于是不加任何过渡类、也不等待，立刻进入静止态或直接移除（该设置下无动画）。
 */
const mounted = ref(props.open); // 遮罩是否在 DOM 里（含退场动画期间）
const visOpen = ref(props.open); // 内容是否可见（false = 正在退场）
const entered = ref(false); // 是否已到静止态
let pendingTimer = null;

/**
 * 读当前生效的动画时长。
 * 从**计算样式**读、不写死在 JS 里 —— 这样 prefers-reduced-motion 的降级
 * 只需要改 CSS，JS 侧自动跟随，不会出现"CSS 关了动画、JS 还在等 180ms"的错位。
 */
function motionDurationMs() {
  const el = document.querySelector('.upd-mask');
  if (!el) return 0;
  const raw = String(getComputedStyle(el).animationDuration || '0s').split(',')[0].trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

function clearPendingTimer() {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/** 入场：先落回初始态（rendered → 下一帧才加 .is-in），动画才会真的播 */
async function playEnter() {
  clearPendingTimer();
  entered.value = false;
  mounted.value = true;
  visOpen.value = true;
  await nextTick();
  const dur = motionDurationMs();
  if (dur <= 0) {
    /* prefers-reduced-motion: reduce：不做动画，直接到静止态 */
    entered.value = true;
    return;
  }
  requestAnimationFrame(() => {
    entered.value = true;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      entered.value = true;
    }, dur + 120);
  });
}

/** 出场：先回到初始态播淡出，动画结束后再真正移除节点 */
async function playLeave() {
  clearPendingTimer();
  visOpen.value = false;
  const dur = motionDurationMs();
  if (dur <= 0) {
    entered.value = false;
    mounted.value = false;
    return;
  }
  entered.value = false;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    mounted.value = false;
  }, dur + 120);
}

/** 遮罩的动画结束：只在退场时推进（入场不需要在这里做任何事） */
function onMaskAnimEnd(ev) {
  /* 只认遮罩自己的动画，别被冒泡上来的子元素动画带跑 */
  if (ev.target !== ev.currentTarget) return;
  if (visOpen.value) return;
  clearPendingTimer();
  mounted.value = false;
}

/* ------------------------------------------------------------------ 生命周期 */

const scope = createSubscriptionScope();

onMounted(() => {
  /* 进度/结果帧：主进程直接推 update-progress */
  scope.add(subscribeLauncherUpdateProgress());
  if (props.open) {
    playEnter();
    /*
      打开窗口时**不无条件打网络**：checkLauncherUpdate 默认走 TTL 缓存，
      TTL 内直接复用上次结果并把 fromCache 置 true，界面据此如实标注
      "来自缓存 · 上次检查 HH:MM:SS"。想立刻拿最新结果就点「重新检查」。
    */
    if (phase.value !== 'checking') runCheck();
  }
});

onBeforeUnmount(() => {
  clearPendingTimer();
  scope.dispose();
});

watch(
  () => props.open,
  (now) => {
    if (now) {
      playEnter();
      /* 只在还没有任何结论时自动查一次；TTL 缓存命中时 runCheck 内部不会再发请求 */
      if (phase.value !== 'checking') runCheck();
    } else {
      playLeave();
    }
  }
);

/* -------------------------------------------------------------------- 动作 */

/**
 * 打开窗口时的那一次检查（**可能只是读缓存**）。
 * @param {{force?:boolean}} [opts]
 */
async function runCheck(opts = {}) {
  const r = opts.force ? await recheckLauncherUpdate() : await checkLauncherUpdate();
  /* 从缓存读出来的"已是最新"不再弹 toast：它不是这一次查到的结论 */
  if (r.phase === 'latest' && !r.fromCache) toast('已是最新版本', 'success');
  /*
    失败**不弹 toast**：失败原因必须留在窗口里让用户读完
    （"未配置更新源"这类信息需要照着去改配置）。
    一闪而过的提示等于把它藏起来。
  */
}

/** 「重新检查」：用户明确要求，无视 TTL 真的再查一次 */
async function recheck() {
  await runCheck({ force: true });
}

async function startDownload() {
  const r = await downloadLauncherUpdate({ asset: u.value.asset });
  if (r.ok) {
    toast('下载完成，已校验字节数', 'success');
    return;
  }
  if (!r.canceled) toast('下载失败，详情见窗口内的通道原因', 'error', 4200);
}

async function onCancel() {
  await cancelLauncherUpdate();
}

async function doInstall() {
  /*
    ⚠️ 这一步之后**启动器会退出**（安装程序需要换掉正在运行的 exe）。
    所以先把"会发生什么"再明确说一次，再真的动手 —— 一个不说清就消失的
    应用，用户只会以为是崩溃。
  */
  const r = await installLauncherUpdate();
  if (r.ok) {
    toast('安装程序已启动，启动器即将退出', 'success', 4000);
    close();
    return;
  }
  toast(r.message || '无法启动安装程序', 'error', 4500);
}

function close() {
  emit('update:open', false);
  emit('close');
}

/** 点遮罩关闭：正在下载时不关（避免用户以为"关了就是取消了"） */
function onMaskClick() {
  if (isDownloading.value) {
    toast('下载仍在进行中，请先点「取消」再关闭', 'warn', 3200);
    return;
  }
  close();
}

/** 与 DownloadProgress.vue 同一口径的体积格式化 */
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
/* ---------------------------------------------------------------- 遮罩
   整窗覆盖：inset:0 + z-index 80（高过标题栏的 3），并且不可拖拽。
   ⚠️ 仅靠这两条**不够** —— 标题栏是窗口的拖动区域，实测它会画在留在
      .shell 里的任何浮层之上，所以模板里整块 Teleport 到了 <body>。
   -webkit-app-region: no-drag 是第二道保险：万一将来有人把这个遮罩挪回
     可拖动区域内部，它也不会变成第二个窗口拖动把手。 */
.upd-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  background: rgba(8, 12, 20, 0.42);
  /* 入场起点；.is-in 是静止态。时长与缓动都用既有令牌（--dur-base 180ms /
     --ease-standard），不新增设计令牌。 */
  opacity: 0;
}

.upd-mask.is-in {
  opacity: 1;
  animation: upd-fade-in var(--dur-base) var(--ease-standard) both;
}

.upd-mask.is-out {
  animation: upd-fade-out var(--dur-base) var(--ease-standard) both;
}

/*
  动作幅度刻意压得很小（96%→100%、上移 4px）：
  这是个"确认信息 + 一个按钮"的小窗口，不是页面级转场；
  位移/缩放一大，用户会觉得整个界面在跳。
*/
.upd-mask.is-in .upd {
  animation: upd-pop-in var(--dur-base) var(--ease-standard) both;
}

.upd-mask.is-out .upd {
  animation: upd-pop-out var(--dur-base) var(--ease-standard) both;
}

@keyframes upd-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes upd-fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@keyframes upd-pop-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes upd-pop-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(2px) scale(0.97);
  }
}

/*
  §14 无障碍：该设置下**完全不做动画**。
  注意不能只写 transition-duration: 0s —— 这里用的是 animation，
  必须把 animation 整个关掉（theme.css 的全局降级只压 duration，
  对本组件的 animation 简写不生效），JS 侧读到的 animationDuration
  随之变成 0s，于是它会立刻进入静止态/直接移除节点。
*/
@media (prefers-reduced-motion: reduce) {
  .upd-mask,
  .upd-mask.is-in,
  .upd-mask.is-out,
  .upd-mask.is-in .upd,
  .upd-mask.is-out .upd {
    animation: none !important;
  }
  .upd-mask,
  .upd-mask.is-in {
    opacity: 1;
  }
}

.upd {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  max-height: 82vh;
  border: 1px solid var(--line);
  border-radius: var(--r-modal);
  background: var(--surface-1);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

.upd-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--line);
}

.upd-title {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-title);
  font-weight: 700;
  color: var(--ink-strong);
  letter-spacing: var(--ls-sm);
}

.upd-title-ico {
  color: var(--theme-color);
  font-size: 15px;
}

.upd-x {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
}

.upd-x:hover {
  background: var(--fill-hover);
  color: var(--ink-strong);
}

.upd-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  overflow-y: auto;
}

/* ------------------------------------------------------------ 版本对照 */
.upd-vers {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-3);
}

.upd-vbox {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.upd-vlabel {
  font-size: var(--fs-xs);
  color: var(--ink-soft);
  letter-spacing: var(--ls-sm);
}

.upd-vnum {
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--ink-strong);
}

.upd-vnum.hot {
  color: var(--theme-color);
}

.upd-arrow {
  flex: none;
  color: var(--ink-faint);
  font-size: 14px;
  line-height: 1;
}

/* ------------------------------------------------------------ 说明/结论块 */
.upd-note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--ink);
}

.upd-note-ico {
  flex: none;
  margin-top: 0.15rem;
  font-size: 14px;
}

.upd-note-text {
  min-width: 0;
  word-break: break-word;
}

.upd-note-err {
  border-color: var(--err-line);
  background: var(--err-bg);
  color: var(--err-ink);
}

.upd-note-ok {
  border-color: var(--ok-line);
  background: var(--ok-bg);
  color: var(--ok-ink);
}

.upd-note-quiet {
  color: var(--ink-soft);
  background: var(--surface-2);
}

/* ------------------------------------------------------------ 更新内容 */
.upd-notes {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.upd-notes-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
}

.upd-notes-title {
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--ink-strong);
}

.upd-notes-date {
  font-size: var(--fs-xs);
  color: var(--ink-faint);
}

.upd-notes-body {
  max-height: 260px;
  overflow-y: auto;
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-inset);
}

.upd-line {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--ink);
}

.upd-line-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.upd-dot {
  flex: none;
  color: var(--theme-color);
  font-weight: 700;
}

/*
  小标题（上游 Release body 里的 ## / ###）。
  只加字重与一点上间距，**不放大字号** —— 更新说明里标题往往有好几个，
  放大字号会让整个说明块看起来像文档目录，反而更难扫。
  颜色提到 --ink-strong，与正文拉开一档层次。
*/
.upd-line.heading .upd-line-text {
  font-weight: 600;
  color: var(--ink-strong);
}

.upd-line.heading:not(:first-child) {
  padding-top: var(--sp-2);
}

/* 三级及以下标题（###）弱一档：它是"标题里的补充说明"，不该和二级标题抢眼 */
.upd-line.heading.sub .upd-line-text {
  font-weight: 600;
  color: var(--ink);
}

.upd-hint {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--ink-soft);
}

/* ------------------------------------------------------------ 下载进度 */
.upd-pline {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.upd-pnum {
  flex: none;
  min-width: 46px;
  text-align: right;
  font-size: var(--fs-lg);
  font-weight: 700;
  color: var(--theme-color);
  letter-spacing: var(--ls-sm);
}

/* 与 DownloadProgress.vue 同一画法：满宽 + scaleX 的轨道 */
.upd-pbar {
  flex: 1 1 auto;
  height: 8px;
  border-radius: var(--r-pill);
  background: var(--fill-disabled);
  overflow: hidden;
}

.upd-pbar i {
  display: block;
  height: 100%;
  width: 100%;
  transform-origin: left center;
  will-change: transform;
  background: var(--theme-color);
  transition: transform var(--dur-slow) var(--ease-standard);
}

.upd-pmeta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}

.upd-prate {
  color: var(--theme-color);
  font-weight: 600;
}

.upd-pchan {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-faint);
}

/* 失败通道明细 */
.upd-attempts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3);
  border: 1px solid var(--err-line);
  border-radius: var(--radius-md);
  background: var(--err-bg);
}

.upd-attempt {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
}

.upd-attempt-ch {
  flex: none;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--err-ink);
}

.upd-attempt-msg {
  min-width: 0;
  color: var(--err-ink);
  word-break: break-word;
}

/* ------------------------------------------------------------ 底部 */
.upd-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--line);
  background: var(--surface-2);
}

/*
  「上次检查时间 / 来自缓存」。
  它是**事实陈述**，不是警告，所以用最低调的一档文字色；
  缓存时整体走 --ink-soft，让"这不是刚查的"一眼可辨，但不抢按钮的注意力。
*/
.upd-status {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--ink-faint);
}

.upd-status.cached {
  color: var(--ink-soft);
}

.upd-status-ico {
  flex: none;
  font-size: 12px;
}

.upd-spacer {
  flex: 1 1 auto;
}
</style>
