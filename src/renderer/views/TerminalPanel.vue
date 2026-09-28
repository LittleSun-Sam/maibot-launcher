<!--
  说明：SFC 顶层只能出现 <template>/<script>/<style> 等已知块，
  普通注释放在顶层会被部分工具链误判，因此把技术文档放进 <script> 内。
-->
<template>
  <div class="term-page">
    <div class="page-head">
      <div class="head-title">
        <span class="head-eyebrow">Terminal</span>
        <h2 class="head-h2">终端</h2>
      </div>
      <div class="head-actions">
        <span class="backend" :class="`b-${capability.backend}`" :title="capability.note">
          <span class="dot" />
          {{ capability.backend === 'pty' ? 'PTY 完整模式' : '管道降级模式' }}
        </span>
        <PillButton variant="ghost" size="sm" icon="play" :disabled="opening" @click="newSession">
          新建终端
        </PillButton>
        <PillButton
          variant="ghost"
          size="sm"
          icon="trash"
          :disabled="!sessions.length"
          @click="closeAll"
        >
          关闭全部
        </PillButton>
      </div>
    </div>

    <!-- 后端能力提示：只在降级时出现，不隐藏事实 -->
    <div v-if="capability.backend !== 'pty'" class="warn-strip">
      <strong>管道降级模式</strong>：{{ capability.ptyError || capability.note }}
      <br />该模式下无 TTY，彩色输出与交互式程序（如 top、vim）可能无法正常显示。
    </div>

    <!-- 会话标签 -->
    <div v-if="sessions.length" class="session-row">
      <button
        v-for="s in sessions"
        :key="s.id"
        type="button"
        class="sess-tab"
        :class="{ active: s.id === activeId, dead: s.exited }"
        @click="activate(s.id)"
      >
        <span class="sess-dot" :class="s.exited ? 'off' : 'on'" />
        <span class="sess-name">{{ s.shell }}</span>
        <span class="sess-cwd" :title="s.cwd">{{ shortCwd(s.cwd) }}</span>
        <span class="sess-close" title="关闭该终端" @click.stop="closeSession(s.id)">×</span>
      </button>
    </div>

    <div class="term-stage">
      <!-- 空状态 -->
      <div v-if="!sessions.length" class="term-empty">
        <IconGlyph class="empty-ico" name="terminal" />
        <p class="empty-title">还没有打开终端</p>
        <p class="empty-sub">
          点击「新建终端」在本机启动一个 shell，可直接运行 python / pip / git 等命令。
        </p>
        <PillButton variant="solid" size="md" icon="play" :loading="opening" @click="newSession">
          新建终端
        </PillButton>
      </div>

      <!--
        所有终端容器常驻 DOM（用 display 切换），
        这样切换标签不会销毁 xterm 实例、不会丢失回滚缓冲。
      -->
      <div
        v-for="s in sessions"
        v-show="s.id === activeId"
        :key="s.id"
        :ref="(el) => registerHost(s.id, el)"
        class="term-host"
      />
    </div>

    <!-- 会话创建参数 -->
    <div v-if="sessions.length" class="term-foot">
      <label class="foot-field">
        <span>Shell</span>
        <select v-model="shellChoice" class="foot-input" @change="onShellChange">
          <option v-for="sh in capability.shells" :key="sh.id" :value="sh.id">{{ sh.label }}</option>
        </select>
      </label>
      <label class="foot-field grow">
        <span>启动目录</span>
        <input v-model="cwdChoice" class="foot-input" placeholder="默认用户主目录" />
      </label>
      <PillButton variant="ghost" size="sm" icon="folder" @click="pickCwd">浏览…</PillButton>
    </div>
  </div>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/views/TerminalPanel.vue
职责：交互式终端页 —— 让 src/main/services/terminal.js 真正可达。
================================================================================
  为什么新增这个页面：
    重构前的 terminal.js（94 行）+ preload 的 terminalSpawn 是**完全不可达**的
    死代码 —— 没有任何路由或按钮能打开终端，而 node-pty 甚至没进 package.json。
    用户的要求是"假装的改成真的"，所以这里不是删掉它，而是把它接上：
    xterm.js（渲染）+ node-pty（主进程）构成一个真能用的终端。

  实现要点：
    · 终端实例与主进程会话严格一对一，切换标签时复用已有实例
    · onData → terminalWrite；尺寸变化 → terminalResize（PTY 模式才有意义）
    · 组件卸载时必须 kill 主进程会话，否则留下孤儿 shell 进程
    · 展示后端模式（PTY / 管道降级），让用户知道能力边界而不是被骗
================================================================================
*/
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, nextTick } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import IconGlyph from '../components/IconGlyph.vue';
import PillButton from '../components/ui/PillButton.vue';
import { toast } from '../composables/useToast.js';
import {
  killTerminal,
  loadTerminalCapability,
  resizeTerminal,
  selectDirectory,
  spawnTerminal,
  store,
  subscribeTerminal,
  writeTerminal
} from '../stores/app-store.js';

const capability = reactive({
  backend: 'unknown',
  ptyAvailable: false,
  ptyError: '',
  note: '',
  shells: []
});

const sessions = ref([]);
const activeId = ref('');
const opening = ref(false);
const shellChoice = ref('powershell');
const cwdChoice = ref('');

/** sessionId → { term, fit, host, ro } —— 用 shallowRef 避免 Vue 代理 xterm 实例 */
const runtime = shallowRef(new Map());

/*
  ---------------------------------------------------------------- xterm 主题

  为什么这里还看得见十六进制：xterm.js 用 canvas 逐字符绘制，
  它只接受 CSS 颜色的**字面值**，给它 'var(--x)' 会被判为非法颜色而丢弃。
  所以这些值不能再写成 var() —— 但也不再把「当前用什么颜色」定义在这里：
  真正的定义集中在 src/renderer/styles/theme.css 的 --term-* / --ansi-* 变量块，
  下面这份只是**镜像兜底**：万一读取发生在样式表生效之前（极端时序），
  终端仍然拿到一套合法配色，而不是黑底黑字。
  换句话说：改配色请改 theme.css；只有当你要同时改动兜底值时才动这里。
*/
const TERM_FALLBACK = {
  background: 'var(--fill-hover)',
  foreground: '#c3ccd9',
  cursorAccent: 'var(--fill-hover)',
  selection: 'rgba(79, 176, 198, 0.32)',
  black: '#1d232d',
  red: '#e06060',
  green: '#45b189',
  yellow: '#e0a13c',
  blue: '#5aa9e6',
  magenta: '#aa88dd',
  cyan: '#4fb0c6',
  white: '#c3ccd9',
  brightBlack: '#5a6478',
  brightRed: '#ffb3ab',
  brightGreen: '#a8e6c6',
  brightYellow: '#ffd9a0',
  brightBlue: '#8fc7f0',
  brightMagenta: '#c9b0ee',
  brightCyan: '#8fdce8',
  brightWhite: '#eef3f9'
};

/** 光标色兜底：与 theme.css 的 --theme-color 默认值一致 */
const CURSOR_FALLBACK = '#66ccff';

/** 读一次 :root 上的 --theme-color / --term-* / --ansi-*（每个终端实例创建时调用，开销可忽略） */
function readCssVars() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    cursor: read('--theme-color', CURSOR_FALLBACK),
    background: read('--term-bg', TERM_FALLBACK.background),
    foreground: read('--term-fg', TERM_FALLBACK.foreground),
    cursorAccent: read('--term-cursor-accent', TERM_FALLBACK.cursorAccent),
    selectionBackground: read('--term-selection', TERM_FALLBACK.selection),
    black: read('--ansi-black', TERM_FALLBACK.black),
    red: read('--ansi-red', TERM_FALLBACK.red),
    green: read('--ansi-green', TERM_FALLBACK.green),
    yellow: read('--ansi-yellow', TERM_FALLBACK.yellow),
    blue: read('--ansi-blue', TERM_FALLBACK.blue),
    magenta: read('--ansi-magenta', TERM_FALLBACK.magenta),
    cyan: read('--ansi-cyan', TERM_FALLBACK.cyan),
    white: read('--ansi-white', TERM_FALLBACK.white),
    brightBlack: read('--ansi-bright-black', TERM_FALLBACK.brightBlack),
    brightRed: read('--ansi-bright-red', TERM_FALLBACK.brightRed),
    brightGreen: read('--ansi-bright-green', TERM_FALLBACK.brightGreen),
    brightYellow: read('--ansi-bright-yellow', TERM_FALLBACK.brightYellow),
    brightBlue: read('--ansi-bright-blue', TERM_FALLBACK.brightBlue),
    brightMagenta: read('--ansi-bright-magenta', TERM_FALLBACK.brightMagenta),
    brightCyan: read('--ansi-bright-cyan', TERM_FALLBACK.brightCyan),
    brightWhite: read('--ansi-bright-white', TERM_FALLBACK.brightWhite)
  };
}

function terminalTheme() {
  return readCssVars();
}

/*
  已存在的终端实例不会自动重新读色，所以在外壳切换主题色之后
  （切页面会改 --theme-color）需要显式刷新一次，
  否则「光标跟随主题」只在新建终端时成立。
*/
function refreshTerminalThemes() {
  for (const rt of runtime.value.values()) {
    if (!rt?.term) continue;
    try {
      rt.term.options.theme = terminalTheme();
    } catch (_) {
      /* 实例已销毁，忽略 */
    }
  }
}

/* ---------------------------------------------------------------- 宿主注册 */

function registerHost(id, el) {
  if (!el) return;
  const rt = runtime.value.get(id);
  if (!rt) return;
  if (rt.host === el) return;
  rt.host = el;
  if (!el.contains(rt.term.element)) {
    rt.term.open(el);
    /* 字号影响行高，打开后再 fit 一次才准确 */
    requestAnimationFrame(() => safeFit(id));
  }
}

/** 安全的 fit（容器尺寸为 0 时会抛错，需吞掉） */
function safeFit(id) {
  const rt = runtime.value.get(id);
  if (!rt || !rt.host || !rt.host.clientWidth) return;
  try {
    rt.fit.fit();
    const { cols, rows } = rt.term;
    if (cols > 0 && rows > 0) resizeTerminal(id, cols, rows);
  } catch (_) {
    /* 布局尚未稳定，忽略 */
  }
}

/* ---------------------------------------------------------------- 会话操作 */

function shortCwd(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? cwd : `…\\${parts.slice(-2).join('\\')}`;
}

/** 同时打开的终端上限（每个会话 = 一个真实 shell 进程 + 一个 5000 行回滚缓冲） */
const SESSION_LIMIT = 8;

async function newSession() {
  if (opening.value) return;

  /*
    会话数上限。
    此前没有任何限制：每点一次「新建」就 spawn 一个真实 shell 进程
    并创建一个 xterm 实例（scrollback 5000 行），
    连点就会把系统进程数与渲染内存一起推上去，且没有回收路径 ——
    主进程侧同样没有上限（terminal.js 只在 kill 时 sessions.delete）。
  */
  if (sessions.value.length >= SESSION_LIMIT) {
    toast(`最多同时打开 ${SESSION_LIMIT} 个终端，请先关闭一些`, 'warn', 4500);
    return;
  }

  opening.value = true;
  try {
    /*
      必须包 catch：spawnTerminal 走 IPC，桥接异常时会直接抛。
      原实现只有 finally，用户点了「新建」什么都不会发生。
    */
    const r = await spawnTerminal({
      shell: shellChoice.value,
      cwd: cwdChoice.value || undefined,
      cols: 100,
      rows: 30
    });

    if (!r || !r.ok) {
      toast(r?.message || '终端启动失败', 'error', 5000);
      return;
    }
    if (!r.sessionId) {
      toast('终端已启动但未返回会话标识，无法接管', 'error', 5000);
      return;
    }

    const rt = createRuntime(r.sessionId);
    sessions.value.push({
      id: r.sessionId,
      shell: r.shell || shellChoice.value,
      cwd: cwdChoice.value || '',
      mode: r.mode,
      exited: false
    });
    activeId.value = r.sessionId;

    /* 其余已打开的终端也同步一次主题色（用户可能刚换了页面/主题） */
    refreshTerminalThemes();

    await nextTick();
    /* 卸载守卫：nextTick 之后组件可能已不在，safeFit 会去查一个空的 runtime */
    if (!alive) return;
    safeFit(r.sessionId);
    rt.term.focus();

    if (r.mode === 'pipe') {
      toast('已使用管道降级模式启动终端', 'warn', 4000);
    }
  } catch (e) {
    toast('终端启动失败：' + (e?.message || e), 'error', 5000);
  } finally {
    opening.value = false;
  }
}

/**
 * 创建 xterm 实例并绑定输入输出。
 * 说明：这里**不需要** mode 参数 —— 唯一用到 mode 的地方是构造选项里的
 * convertEol，已就地判断。原签名收下 mode 后又塞进 runtime 对象，
 * 而那个字段从未被读取，属于"看起来像有降级逻辑、实际没有"的噪音。
 */
function createRuntime(sessionId) {
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
    fontSize: 12.5,
    lineHeight: 1.28,
    cursorBlink: true,
    convertEol: currentModeOf(sessionId) === 'pipe', /* 管道模式无 TTY，需自行处理换行 */
    scrollback: 5000,
    theme: terminalTheme(),
    allowProposedApi: true
  });

  const fit = new FitAddon();
  term.loadAddon(fit);

  /* 键盘输入 → 主进程 */
  term.onData((data) => {
    writeTerminal(sessionId, data);
  });

  runtime.value.set(sessionId, { term, fit, host: null });
  return { term, fit };
}

/** 从已登记的会话里取模式（createRuntime 调用时该会话已 push） */
function currentModeOf(sessionId) {
  return sessions.value.find((s) => s.id === sessionId)?.mode || 'pty';
}

function activate(id) {
  activeId.value = id;
  /* 切回来时对齐当前主题色：光标色跟着外壳走，而不是停留在创建时的颜色 */
  refreshTerminalThemes();
  nextTick(() => {
    safeFit(id);
    runtime.value.get(id)?.term.focus();
  });
}

function closeSession(id) {
  /*
    killTerminal 现在是 invoke（有返回值），主进程的失败结果**真的能拿到**了。
    原来它走 send，返回值恒为 undefined，Promise 也永远不 reject ——
    {ok:false, message}（会话不存在 / 进程杀不掉）在结构上不可达，
    这座 catch 只是"看起来有错误处理"。
    现在两条路都要覆盖：
      · 返回值 ok:false —— 主进程明确说没杀掉（如权限不足残留进程）；
      · 抛异常 —— 桥接层本身出问题（此时 safeInvoke 已转成 ok:false，
        这层 throw 只是双保险）。
    无论哪条，都不阻断界面清理：标签与列表必须和用户看到的一致；
    但"进程还在"这件事必须说出来，否则就是"标签消失了 shell 还在"。
  */
  Promise.resolve()
    .then(() => killTerminal(id))
    .then((r) => {
      if (r && r.ok === false) {
        toast('终端进程未能结束：' + (r.message || '未知原因'), 'warn', 5000);
      }
    })
    .catch((e) => {
      toast('关闭终端失败：' + (e?.message || e), 'warn', 4000);
    });
  disposeRuntime(id);
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (activeId.value === id) {
    activeId.value = sessions.value[0]?.id || '';
    if (activeId.value) nextTick(() => safeFit(activeId.value));
  }
}

function closeAll() {
  for (const s of [...sessions.value]) {
    /* 同上：失败只提示，不阻断清理。返回值 now 有内容，异常仍兜住 */
    Promise.resolve()
      .then(() => killTerminal(s.id))
      .catch(() => {});
    disposeRuntime(s.id);
  }
  sessions.value = [];
  activeId.value = '';
}

function disposeRuntime(id) {
  const rt = runtime.value.get(id);
  if (!rt) return;
  try {
    rt.term.dispose();
  } catch (_) {
    /* 已销毁 */
  }
  runtime.value.delete(id);
}

async function pickCwd() {
  try {
    const r = await selectDirectory({ title: '选择终端启动目录' });
    if (r && r.ok) cwdChoice.value = r.path;
    else if (r?.message) toast(r.message, 'warn');
  } catch (e) {
    toast('选择目录失败：' + (e?.message || e), 'error');
  }
}

/** 切换 shell 只影响之后新建的会话 */
function onShellChange() {
  if (sessions.value.length) toast('Shell 变更将在下一个新终端生效', 'info');
}

/* ---------------------------------------------------------------- 事件订阅 */

let offTerminal = null;
let resizeObserver = null;

/*
  卸载标记。
  onMounted 里有一次 await loadTerminalCapability()，
  nextTick 之后也还有代码要跑。若组件在此期间卸载，清理函数早已执行完
  （当时 offTerminal 还是 null、resizeObserver 还是 null），
  随后这里仍会 subscribeTerminal 并 observe —— 一个已经不存在的页面
  永远占着终端数据通道与尺寸监听，而且**再没有任何机会**被取消。
*/
let alive = true;

onMounted(async () => {
  alive = true;
  const cap = await loadTerminalCapability();
  Object.assign(capability, cap || {});
  if (capability.shells?.length) {
    /* 默认选 PowerShell（更现代），否则用列表首个 */
    const preferred = capability.shells.find((s) => s.id === 'powershell') || capability.shells[0];
    shellChoice.value = preferred.id;
  }
  cwdChoice.value = store.info.userData || '';

  /* 卸载早于这里：不要再订阅，否则没有任何东西能取消它 */
  if (!alive) return;

  /* 主进程输出 → 对应终端实例 */
  offTerminal = subscribeTerminal({
    onData: (payload) => {
      if (!payload?.sessionId) return;
      const rt = runtime.value.get(payload.sessionId);
      if (rt) rt.term.write(payload.data);
    },
    onExit: (payload) => {
      if (!payload?.sessionId) return;
      const rt = runtime.value.get(payload.sessionId);
      if (rt) {
        const code = payload.exitCode;
        rt.term.write(
          `\r\n\x1b[38;5;245m── 进程已退出${code === null || code === undefined ? '' : `（退出码 ${code}）`} ──\x1b[0m\r\n`
        );
      }
      const s = sessions.value.find((x) => x.id === payload.sessionId);
      if (s) s.exited = true;
    }
  });

  /* 窗口尺寸变化 → 重新 fit */
  resizeObserver = new ResizeObserver(() => {
    if (activeId.value) safeFit(activeId.value);
  });
  const stage = document.querySelector('.term-stage');
  if (stage) resizeObserver.observe(stage);
});

onBeforeUnmount(() => {
  alive = false;
  if (offTerminal) offTerminal();
  if (resizeObserver) resizeObserver.disconnect();
  /* 关键：必须杀掉主进程会话，否则留下孤儿 shell */
  closeAll();
  runtime.value.clear();
});
</script>

<style scoped>
/*
  页面内边距。
  ⚠️ 这里原来是 **0**（外壳 .body 自己不设 padding，由每页自己排）。
  实测：.head-eyebrow / .head-h2 的左边界 x=0、.term-stage 横跨 0..1280 ——
  "Terminal / 终端"这几个字和整块终端区**贴着窗口左边缘和右边缘**，
  而日志页同样的标题是 x=12、终端区是 12..1268。
  两页并排看就是"一页有留白、一页顶到边"，必须统一到日志页同一组数值。
*/
.term-page {
  display: flex;
  flex-direction: column;
  /* 10/12 不是 token 档位（4/8/12/16），统一到 --sp-3，
     这样 .page-head / 会话条 / 终端区之间的节奏与日志页一致 */
  gap: var(--sp-3);
  height: 100%;
  padding: 0.625rem 0.75rem 0.75rem;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.75rem;
}

.head-eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.head-h2 {
  letter-spacing: var(--ls-lg);
  margin: 0.125rem 0 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--ink-strong);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.backend {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: var(--h-ctl-sm);
  padding: 0 0.75rem;
  /* 999px 药丸 → v4 控件圆角；26px 高的是同一排的 sm 按钮高度 */
  border-radius: var(--r-ctl);
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--line-strong);
  /* 写死的 rgba(255,255,255,.8) 在深色主题下是一块白底 ——
     它只在这个徽标处于 unknown 初态时露出来，但同样是"组件里写死颜色"，
     换成 --surface-2 由主题给值 */
  background: var(--surface-2);
  color: var(--ink-soft);
}

.backend .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-faint);
}

.backend.b-pty {
  color: var(--ok-ink);
  border-color: var(--ok-line-strong);
  background: var(--ok-bg);
}

.backend.b-pty .dot {
  background: var(--ok);
}

.backend.b-pipe {
  color: var(--warn-ink);
  border-color: var(--warn-line-strong);
  background: var(--warn-bg);
}

.backend.b-pipe .dot {
  background: var(--warn);
}

.warn-strip {
  letter-spacing: var(--ls-sm);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  color: var(--warn-ink-deep);
  font-size: 12px;
  line-height: 1.6;
}

.session-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

/*
  会话标签。
  ⚠️ 三处旧写法：
    · background: rgba(255,255,255,0.85) —— 深色主题下合成出 #dcdcdd 的白底，
      而字色 var(--ink)=#c2c7ce，实测对比度 **1.24:1**：标签上的 shell 名
      等于看不见（这正是"白卡糊脸"那一类）。
    · 没有 font-family —— <button> 不继承 body 字体，实测落到 **Arial**，
      与同一行的 .backend / .head-h2（Segoe UI Variable Text）不是一套字形。
    · height 28px vs 同一排 sm 按钮 26px、radius 7px vs 平台 --r-ctl 10px。
*/
.sess-tab {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 240px;
  height: var(--h-ctl-sm);
  padding: 0 0.5rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--ink);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--dur-base), background var(--dur-base);
}

.sess-tab.active {
  border-color: var(--theme-color);
  background: var(--surface-1);
  box-shadow: 0 0 0 2px var(--theme-tint);
}

.sess-tab.dead {
  opacity: 0.62;
}

/* 键盘可达性：标签本身是 <button>，全局 :focus-visible 已经给 ring；
   这里只补一个 hover 反馈（原来完全没有 hover 态） */
.sess-tab:hover {
  border-color: var(--theme-line);
}

.sess-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.sess-dot.on {
  background: var(--ok);
}
.sess-dot.off {
  background: var(--term-switch-off);
}

.sess-name {
  font-weight: 600;
  white-space: nowrap;
}

/*
  启动目录（被 ellipsis 截断的路径）。
  原来用 --ink-faint(=--text-4)：浅色 3.19:1 / 深色 3.39:1，实现在标签里
  唯一能区分两个终端的**内容**就是这行路径，属于必须读的信息 → 提到 --ink-soft
  （浅色 4.83:1 / 深色 5.47:1）。它本来就有 title 给全路径，截断逻辑不动。
*/
.sess-cwd {
  letter-spacing: var(--ls-sm);
  color: var(--ink-soft);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 关闭键：15px 的 "×"，原来也是 --ink-faint（3.19:1），是**可点**元素，
   比装饰更需要看得见 */
.sess-close {
  margin-left: 0.125rem;
  width: 15px;
  height: 15px;
  line-height: 13px;
  text-align: center;
  border-radius: 6px;
  color: var(--ink-soft);
  font-size: 13px;
  flex: none;
}

.sess-close:hover {
  background: var(--term-hover-bg);
  color: var(--term-hover-ink);
}

.term-stage {
  position: relative;
  flex: 1;
  min-height: 340px;
  border-radius: var(--radius-md);
  background: var(--console-bg);
  border: 1px solid var(--console-outline);
  overflow: hidden;
}

.term-host {
  position: absolute;
  inset: 0;
  padding: 0.5rem 0.25rem 0.5rem 0.625rem;
}

.term-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  text-align: center;
  padding: 1.25rem;
}

.empty-ico {
  font-size: 34px;
  color: var(--term-empty-ico);
}

.empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--term-empty-title);
}

.empty-sub {
  letter-spacing: var(--ls-sm);
  margin: 0 0 0.375rem;
  font-size: 12px;
  /* 这是空状态下**唯一**告诉用户下一步做什么的句子，
     原来用 --console-muted-faint：实测 3.58:1（浅色）/ 3.91:1（深色），
     不达 AA。改用 --console-muted（5.82:1 / 6.49:1）。 */
  color: var(--console-muted);
  max-width: 380px;
  line-height: 1.6;
}

.term-foot {
  display: flex;
  align-items: flex-end;
  gap: 0.625rem;
  flex-wrap: wrap;
}

.foot-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 150px;
}

.foot-field.grow {
  flex: 1;
}

.foot-field > span {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  font-weight: 600;
  /* 字段标签（Shell / 启动目录）：原来是 --ink-faint，
     浅色 3.10:1 / 深色 3.86:1 —— 不看清标签就不知道这个框填什么。
     提到 --ink-soft（4.83:1 / 5.47:1）。 */
  color: var(--ink-soft);
}

/*
  底部参数输入框。
  ① rgba(255,255,255,.9) 写死浅底 → 深色主题下合成 #e8e8e8 白底 +
     var(--ink)=#c2c7ce 浅字，实测 **1.39:1**（输入框里的内容完全看不见）。
  ② height 28px vs 同一排 "浏览…"（PillButton sm = 26px）差 2px：
     容器是 align-items:flex-end，两件东西**底对齐、顶不齐**。
  ③ radius 7px 不在圆角档位里（v4 是 6/10/14）。
  统一切到 --surface-2 / --h-ctl-sm / --r-ctl。
*/
.foot-input {
  letter-spacing: var(--ls-sm);
  height: var(--h-ctl-sm);
  padding: 0 0.5rem;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--ink);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.foot-input:focus {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 2px var(--theme-tint);
}
</style>
