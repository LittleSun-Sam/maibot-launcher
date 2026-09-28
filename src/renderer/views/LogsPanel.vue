<template>
  <!--
    ============================================================================
    技术文档：src/renderer/views/LogsPanel.vue
    职责：运行日志页 —— 单一日志流（MaiBot 与 SnowLuma 按时间合并，可筛选来源）。
    ============================================================================
      本文件是"清空后 3 秒自动复活"这个 bug 的现场，改动说明：

      原实现的三处叠加缺陷：
        1) setInterval 每 3 秒调 loadServiceLogs('maibot', 400)，
           而 loadServiceLogs 会把这 400 条无去重 append 进共享的 store.logs；
           同时 onServiceLogBatch 也在实时推送同一份内容 → 数据被写两遍。
           → 现在：删除定时轮询。实时日志唯一来源是主进程事件推送；
             历史日志只在进入页面时加载一次，且 store 侧改为整体替换。
        2) clearZone('maibot') 调用的 clearLogs(key) 内部执行 store.logs = []，
           把 SnowLuma 分区一起清空，但提示文案还说"MaiBot 日志已清空"。
           → 现在：按 key 分桶，只清对应分区，文案如实。
        3) 导出把日志内容交给渲染层下载，且扩展名为 .html，
           日志中的脚本标签会被浏览器执行（存储型 XSS）。
           → 现在：主进程直接写 .log 文件并返回路径，前端只展示路径。

      注意：本注释必须写在 <template> 内部。
      放在 SFC 顶层时，Vue 编译器会把它当作模板内容解析并报语法错误。
    ============================================================================
  -->
  <div class="logs-page">
    <!--
      【用户要求】日志页去掉顶部标题与按钮：
      原先这里是「Logs / 运行日志」标题 + 刷新 + 日志目录两个按钮。
      日志页要的就是"一整块日志"，标题与这些动作都不要了。
      函数本体保留（下面还有别处引用它们，删掉会造成 eslint 未使用告警，
      将来要恢复这一行 UI 直接加回来即可）。
    -->

    <!--
      服务页签：一个「全部」+ 每个日志来源一项，项里带上它**当前**的运行状态
      （状态值只读 store.services，见 serviceState 的注释，不是写死的文案）。
      点页签 = 切换看哪个来源的日志，走的仍是原来那套 focusLogs(key)/store.logsFocus
      —— 和外壳里双击「日志」弹出的胶囊共用同一份状态，没有第二套筛选状态。
      【用户要求】原来的级别筛选（全部/错误/警告/成功/信息）整条从 UI 去掉；
      级别信息仍由每行自己的左边框与字色表达（.log-line.l-error 等），
      不再占一行高度、也不再需要"每级多少条"的计数。
      三个动作仍在同一行的右端，日志块因此能直接铺满整块。
    -->
    <div class="level-row">
      <button
        v-for="t in tabs"
        :key="t.key || 'all'"
        type="button"
        class="lv-chip"
        :class="{ active: (store.logsFocus || null) === t.key }"
        @click="focusLogs(t.key)"
      >
        {{ t.label }}
        <span v-if="t.state" class="lv-state" :class="`lv-state-${t.tone}`">· {{ t.state }}</span>
      </button>
      <span class="level-tools">
        <button class="ztool" :disabled="reloading" title="重新读取日志文件" @click="reloadAll">
          {{ reloading ? '刷新中' : '刷新' }}
        </button>
        <button class="ztool" title="打开日志所在目录" @click="openLogDir">日志目录</button>
        <button class="ztool" title="复制当前显示的全部日志" @click="copyVisible">复制</button>
        <button class="ztool" :title="exportTitle" @click="exportVisible">{{ exportLabel }}</button>
        <button class="ztool ztool-danger" :title="clearTitle" @click="clearVisible">清空</button>
      </span>
    </div>

    <!--
      ★ 只有**一个**日志区（不再分成几个框）。
      原先是「MaiBot | SnowLuma」两列 + 启动器一行共三个独立分区（启动器已移除），
      现在改成单一日志流：
        · 所有来源按时间合并进同一个滚动区
        · 每行前面挂一个来源标签区分归属（合并时必须显示；只看单个来源时
          回到 OUT / ERR 表示"哪条流"）
        · 顶部双击「日志」弹出的胶囊负责筛选来源（全部 / MaiBot / SnowLuma）
      合并之后"这一行是谁输出的"再也不能靠"它躺在哪个框里"表达，
      必须由行内标签自己说清楚 —— 这是合并视图唯一的新增信息量。
    -->
    <!-- 只有 MaiBot 与 SnowLuma 两个来源（启动器日志不在这里） -->
    <section class="log-console" :aria-label="activeZone.name">
      <!--
        【用户要求】去掉日志区顶部那条头：来源名 + 条数 + 实时 + 复制/导出/清空。
        原来它占一行高度、把日志正文往下压；去掉之后日志正文直接铺满整块。
      -->

      <!--
        合并视图下的"有服务在等确认"提示。
        EULA 输入栏只在选中单个服务时出现（合并视图没有明确的写入对象），
        但"某个服务正卡在确认上"必须仍然看得见 ——
        否则用户切到"全部"就再也看不到麦麦在等一行「同意」，
        而它明明就卡在那里。按钮把视图切到那个来源，输入栏随之出现。
      -->
      <div v-if="consentTip" class="console-tip">
        <span class="zi-eula-txt">{{ consentTip.hint }}</span>
        <button
          v-if="consentTip.canAccept"
          type="button"
          class="zi-agree"
          @click="focusLogs(consentTip.key)"
        >
          去输入「同意」
        </button>
      </div>

      <div ref="boxRef" class="log-box">
        <div v-for="l in visibleRows" :key="l.id" class="log-line" :class="`l-${l.level}`">
          <span class="log-ts" :title="fullTime(l.ts)">{{ clock(l.ts) }}</span>
          <!-- 单个来源视图下 srcTag 返回空串，这一列整个不渲染（见 srcTag 注释） -->
          <span v-if="srcTag(l)" class="log-src" :class="srcClass(l)" :title="srcTitle(l)">{{ srcTag(l) }}</span>
          <!--
            v-html 是必要的（要把 ANSI 渲成颜色），安全性由 rowHtml 保证：
            它先转义 &<>"'，再插入自己拼的 <span style>。
            eslint-disable 只针对这一行的 no-v-html。
          -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span class="log-text" v-html="rowHtml(l)"></span>
        </div>
        <div v-if="!visibleRows.length" class="log-empty">{{ emptyHint() }}</div>
      </div>

      <!--
        服务输入栏：把 stdin 交回给用户。
        ----------------------------------------------------------------
        麦麦首次启动会卡在 bot.py 的 input() 上等你输入「同意」。
        它的 stdout 我们收进了日志，但 stdin 之前**界面上没有任何入口** ——
        于是界面显示"已启动"，麦麦却在等一行永远不来的输入，静默卡死。
        行为和 cmd 里敲一行回车一致。

        只在选中单个"可输入"的服务时出现：合并视图里没有明确的"发给谁"，
        给一个不知道往哪写的输入框就是假功能。
      -->
      <div v-if="inputZone" class="zone-input">
        <!--
          EULA 横幅有两种：
            · canAccept=true  麦麦那种"在终端等一行同意" → 额外给个填入按钮
            · state='webui-consent'  SnowLuma 那种"去它自己的 WebUI 点同意"
              → 只提示、**不给填入按钮**（往 stdin 写「同意」对它是无效的，
                给了按钮等于引导用户做一件没用的事）
        -->
        <div v-if="eulaOf(inputZone.key).canAccept" class="zi-eula">
          <span class="zi-eula-txt">{{ eulaOf(inputZone.key).hint }}</span>
          <button type="button" class="zi-agree" @click="fillDraft(inputZone.key, '同意')">
            填入「同意」
          </button>
        </div>
        <div v-else-if="eulaOf(inputZone.key).state === 'webui-consent'" class="zi-eula">
          <span class="zi-eula-txt">{{ eulaOf(inputZone.key).hint }}</span>
        </div>
        <form class="zi-form" @submit.prevent="sendToService(inputZone.key)">
          <span class="zi-prompt">›</span>
          <input
            v-model="drafts[inputZone.key]"
            class="zi-field"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="inputPlaceholder(inputZone.key)"
            :disabled="!serviceRunning(inputZone.key)"
          />
          <button
            type="submit"
            class="zi-send"
            :disabled="
              !serviceRunning(inputZone.key) || !String(drafts[inputZone.key] || '').length
            "
          >
            发送
          </button>
        </form>
        <p v-if="!serviceRunning(inputZone.key)" class="zi-note">
          {{ inputZone.name }} 未在运行，先启动服务才能向它输入。
        </p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { toast } from '../composables/useToast.js';
import {
  clearServiceLogs,
  exportServiceLogs,
  focusLogs,
  loadServiceLogs,
  logsOf,
  openPath,
  refreshServices,
  sendServiceInput,
  store
} from '../stores/app-store.js';
import { readEulaState } from '../onboarding/eula-prompt.js';

/**
 * 两个日志来源：MaiBot 与 SnowLuma。
 *
 * 启动器自身的日志**不在这一页**（用户明确要求去掉）：
 * 它照旧写 <userData>/logs/launcher.log，右上角「日志目录」按钮能直接定位到它，
 * 也就是说"启动器自己出问题"依然查得到，只是不再和两个服务抢这块屏幕。
 */
/*
  两个来源都是"实时"，都走 log:batch 推送。
  （此前三个都写 live:true，而模板里有 `zone.live ? '实时' : '快照'` 的分支 ——
   快照那一侧永远不可达，属于需要靠"猜"才能确认是死代码的写法。
   现在把语义写清楚：live 是唯一真相，不再有第二个到不了的取值。）

  inputtable：是否显示"向该服务 stdin 输入"的输入栏。
  只有被托管为子进程的服务才有 stdin，所以这里两项都是 true。

  snowluma 的确认协议**不在终端**：它把 EULA 同意放在自己的 WebUI 里点
  （实测启动日志 `awaiting EULA/PRIVACY consent before the panel unlocks`）。
  所以它的输入栏主要用途是 Ctrl+C 之类的通用输入，而不是"输入同意"。

  tabLabel：页签上的来源名。
  和 name 分开是有意的 —— name 进的是 aria-label 与提示文案（"MaiBot 日志已清空"），
  页签上要的是用户认得出的产品名（官方 UI 里叫 MaiBot Core）。改页签文案
  不该顺带改掉按钮提示里的服务名。
*/
const ZONES = [
  { key: 'maibot', name: 'MaiBot', tabLabel: 'MaiBot Core', icon: 'bot', live: true, inputtable: true },
  { key: 'snowluma', name: 'SnowLuma', tabLabel: 'SnowLuma', icon: 'cube', live: true, inputtable: true }
];

/*
  某个服务**当前**的运行状态 —— 只读 store.services，绝不写死。
  数据来源：主进程 getServicesStatus()（src/main/services/process.js:1585），
  元素形如 { key, running, pid, startedAt, lastExit, ... }。
    · running === true                          → 运行中
    · 记录还在、但 running 为 false 且带 lastExit → 已退出（最近一次退出的真实记录）
    · 其余（含服务从未被托管、压根不在列表里）    → 未运行
  ⚠️ 「已退出」要求 store.services 里有该服务的记录且带 lastExit；而主进程在
  进程退出时会删掉注册表记录（process.js:1181-1183），所以实测通常只看得见
  「运行中 / 未运行」。这里不编第三种状态：有 lastExit 才显示。
*/
function serviceState(key) {
  const s = store.services.find((x) => x.key === key);
  if (s?.running) return { label: '运行中', tone: 'on' };
  if (s?.lastExit) return { label: '已退出', tone: 'off' };
  return { label: '未运行', tone: 'idle' };
}

/*
  顶部页签 = 「全部」+ 每个日志来源。
  一个按钮同时回答两件事："看哪个来源的日志"（label）与"它现在活着没有"（state）。
  切换动作仍是 focusLogs(key)/store.logsFocus，不新造筛选状态。
*/
const tabs = computed(() => [
  { key: null, label: '全部', state: '', tone: '' },
  ...ZONES.map((z) => {
    const st = serviceState(z.key);
    return { key: z.key, label: z.tabLabel, state: st.label, tone: st.tone };
  })
]);

const reloading = ref(false);

/*
  当前显示哪些来源的日志。
  store.logsFocus 由外壳里「双击日志标签」弹出的胶囊设置（AppLayout 的 log-menu）：
    · null      → 所有来源按时间合并成一条流（默认）
    · 'maibot' | 'snowluma' → 只看该来源
  必须过滤而不是"隐藏"，因为下面的 derived 只遍历 sources ——
  否则只看 SnowLuma 时日志流里还混着 MaiBot 的行，用户会以为筛选坏了。
*/
const sources = computed(() =>
  store.logsFocus ? ZONES.filter((z) => z.key === store.logsFocus) : ZONES
);

/* key → 来源定义；合并视图里每行都要按 key 取标签与配色，做成常量表避免每行 find */
const ZONE_BY_KEY = Object.fromEntries(ZONES.map((z) => [z.key, z]));

/** 合并视图里的来源标签（"谁输出的"只能靠它表达） */
const TAG_BY_KEY = { maibot: 'MaiBot', snowluma: 'SnowLuma' };

/*
  表头标题。
  合并视图没有单一来源，用一个合成出来的"全部日志" ——
  直接复用 ZONES[0] 会出现"表头写着 MaiBot、内容里混着 SnowLuma"。
*/
const ALL_ZONE = { key: 'all', name: '全部日志', icon: 'stream' };
const activeZone = computed(
  () => (store.logsFocus ? ZONE_BY_KEY[store.logsFocus] : ALL_ZONE) || ALL_ZONE
);

/*
  合并视图下哪些服务在等确认。
  只在合并视图用：选中单个来源时，输入栏自己会显示同一条提示，不重复占地方。
*/
const consentTip = computed(() => {
  if (store.logsFocus) return null;
  for (const z of ZONES) {
    if (!z.inputtable) continue;
    const e = eulaOf(z.key);
    if (e.canAccept || e.state === 'webui-consent') return { key: z.key, name: z.name, ...e };
  }
  return null;
});

/** 输入栏：只有选中单个"可输入"的服务时才存在 */
const inputZone = computed(() => {
  const z = store.logsFocus ? ZONE_BY_KEY[store.logsFocus] : null;
  return z && z.inputtable ? z : null;
});

/* ------------------------------------------------------- 服务输入（stdin） */

/** 每个分区各自的输入草稿，避免多个框互相串内容 */
const drafts = ref({ maibot: '', snowluma: '' });

/**
 * 服务是否在运行（决定输入栏是否可写）。
 * store.services 是**数组**（元素形如 { key, running, pid }），不是以 key 为下标的对象 ——
 * 用 store.services[key] 会静默拿到 undefined，输入框就会永远显示"未运行"。
 */
function serviceRunning(key) {
  return Boolean(store.services.find((s) => s.key === key)?.running);
}

/**
 * 从该分区已有日志里判断 EULA 状态。
 * 返回 { state, canAccept, hint }；不需要确认时 canAccept 为 false，模板不显示横幅。
 */
function eulaOf(key) {
  const lines = logsOf(key) || [];
  /*
    只看尾部若干行。
    EULA 闸门问的是"**当前**是不是还在等确认"，而等待期间服务不会再输出，
    所以提示必然落在最后几行里。反过来，拼接整个桶（上限 1500 行）
    会在每条新日志到达时重算一次，合并视图下还要乘 2 个服务 ——
    纯属白烧 CPU。取 80 行给足余量。
  */
  const text = lines
    .slice(-80)
    .map((l) => l.text || '')
    .join('\n');

  /*
    SnowLuma 的同意闸门与麦麦**机制不同**：
      麦麦：在终端 input() 等一行「同意」→ 所以下面那个输入栏正好用得上
      SnowLuma：`awaiting EULA/PRIVACY consent before the panel unlocks`
                → 同意是在它自己的 WebUI 里点的，往 stdin 写「同意」没有意义
    所以这里单独判定，提示语要指向 WebUI，不能照搬麦麦那套
    （照搬会让用户敲一行「同意」发现毫无反应）。
  */
  if (key === 'snowluma') {
    const waiting = /awaiting EULA\/PRIVACY consent/i.test(text);
    return {
      state: waiting ? 'webui-consent' : 'none',
      canAccept: false,
      hint: waiting
        ? 'SnowLuma 已启动，但需要先打开它的 WebUI（默认 5099）同意协议才会解锁面板'
        : ''
    };
  }

  return readEulaState(text);
}

function inputPlaceholder(key) {
  /* 名称从 ZONES 取，避免三元表达式硬编码 —— 加第三个服务时就会漏改 */
  const name = ZONES.find((z) => z.key === key)?.name || key;
  if (!serviceRunning(key)) return `${name} 未运行`;
  const e = eulaOf(key);
  if (e.canAccept) return '在这里输入「同意」后按回车';
  if (e.state === 'webui-consent') return 'SnowLuma 的协议同意在它自己的 WebUI 里操作';
  return '输入一行内容发给该服务，按回车发送';
}

/** 把文字填进草稿框（不直接发送 —— 让用户看清内容再自己按发送） */
function fillDraft(key, text) {
  drafts.value = { ...drafts.value, [key]: text };
}

/**
 * 发送一行到服务 stdin。
 * 发送前先 trim 校验非空；换行由主进程统一补齐（见 process.js writeServiceInput）。
 */
async function sendToService(key) {
  const raw = String(drafts.value[key] || '');
  /* 只去掉首尾空白判断是否为空，中间空格保留（有些应答需要保留原文） */
  if (!raw.trim()) return;
  const r = await sendServiceInput(key, raw);
  if (r && r.ok) {
    drafts.value = { ...drafts.value, [key]: '' };
    toast(`已发送给 ${ZONES.find((z) => z.key === key)?.name || key}`, 'success');
  } else {
    toast(r?.message || '发送失败（服务可能未运行）', 'warn');
  }
}

/* ---------------------------------------------------------------- 派生数据 */

/*
  一次遍历得到：合并排序后的可见日志。

  只剩一个日志区之后，"合并"得自己做：两个来源各自的桶按时间归并成一条流。
  稳定排序在这里是**功能的一部分** —— 同一毫秒内的先后由 ZONES 顺序
  （MaiBot → SnowLuma）决定，而不是随排序实现变化；
  否则同一批日志每次重算的顺序都可能变，看起来就是"日志自己在跳"。

  这里曾经同时算一份"各级别条数"给顶部级别筛选条用；级别筛选整条去掉之后
  那份计数没有任何消费者，一并删掉 —— 页面仍然只扫一遍、只分配一个数组：
  桶上限 LOG_LIMIT_PER_KEY = 1500，服务持续输出时这条路径会被高频触发
  （见文件开头关于"日志越多越卡"的说明）。
*/
const derived = computed(() => {
  const rows = [];
  for (const z of sources.value) {
    for (const l of logsOf(z.key)) rows.push(l);
  }
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return rows;
});

/* ------------------------------------------------------------ ANSI 上色 */

/*
  ⚠️ 这里以前是 `<span class="log-text">{{ l.text }}</span>` —— 原样输出。
  ──────────────────────────────────────────────────────────────────────
  实测（真实麦麦 MaiBot 1.2.4）它的 stdout 从头到尾都是 256 色 ANSI：
      \x1b[38;5;117m09-26 10:31:32\x1b[0m \x1b[1;38;5;154m[配置]\x1b[0m 正在品鉴配置文件...
  不做处理，页面上显示的就是 "[38;5;117m09-26…[0m" 这种乱码。
  而日志页最主要的使用场景恰恰就是看麦麦的输出 —— 等于主场景是坏的。
  终端页（TerminalPanel）用 xterm.js，ANSI 是它自带的；日志页是手写的，
  得自己转。

  两条铁律：
    1) **先转义、再上色**。日志文本来自被监控的子进程，直接 v-html 等于
       把注入面交给它。所以 & < > " ' 先全部转义，之后只插入我们自己拼的
       <span style="...">。
    2) **认不出来的一律丢掉**，绝不留在页面上。宁可少一个颜色，
       也不能让用户看到一坨控制码。
*/
const ANSI_16 = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white'
];

/*
  ESC 用字符串拼进 RegExp，而不是写成正则字面量：
  正则字面量里出现 \x1b 会被 eslint 的 no-control-regex 拦下，
  而这里确实必须匹配控制字符 —— 用字符串拼是最诚实的写法。

  ⚠️ 结尾字符类里**绝不能有 m**。
  "非 SGR"指的是光标移动/清屏这一类（A B C D E F G H J K S T f h l n p s u），
  而 `m` 恰恰是 SGR（颜色）的结尾字符 —— 一旦把 m 混进来，这个正则会把
  `\x1b[38;5;117m` 当成"非 SGR 序列"整段删掉，颜色就全没了。
  （实测踩过：单测里 ansiToHtml 的 span 数是 0，根因就是这个字符类。）
*/
const ESC = '\u001b';
const RE_HAS_ESC = new RegExp(ESC);
const RE_NON_SGR = new RegExp(ESC + '\\[[0-9;?]*[A-HJKSTfhlnpsu]', 'g');
const RE_SGR = new RegExp(ESC + '\\[([0-9;]*)m', 'g');

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);

/*
  256 色表：
    0-15   → 用主题里的 --ansi-*（和终端页同一个调色板，换主题一起变）
    16-231 → 6×6×6 色立方，标准算法
    232-255 → 24 级灰阶
  越界返回空串，调用方就保持原色（不猜）。
*/
function ansi256(n) {
  const i = Number(n);
  if (!Number.isFinite(i) || i < 0 || i > 255) return '';
  if (i < 16) return `var(--ansi-${ANSI_16[i]}, #c3ccd9)`;
  if (i < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const v = i - 16;
    return `rgb(${steps[Math.floor(v / 36) % 6]},${steps[Math.floor(v / 6) % 6]},${steps[v % 6]})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** 把一行日志里的 ANSI 转成安全的 HTML（颜色/加粗/下划线/斜体） */
function ansiToHtml(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text) return '';
  /* 没有 ESC 的行占绝大多数，走最短路径 */
  if (!RE_HAS_ESC.test(text)) return escHtml(text);

  /* 光标移动、清屏这类非 SGR 序列整段删掉，它们本来就不是给人看的 */
  const body = text.replace(RE_NON_SGR, '');
  const style = { color: '', bg: '', bold: false, dim: false, italic: false, underline: false };
  const css = () => {
    const p = [];
    if (style.color) p.push(`color:${style.color}`);
    if (style.bg) p.push(`background:${style.bg}`);
    if (style.bold) p.push('font-weight:600');
    if (style.dim) p.push('opacity:.72');
    if (style.italic) p.push('font-style:italic');
    if (style.underline) p.push('text-decoration:underline');
    return p.join(';');
  };

  let out = '';
  let open = false;
  const closeSpan = () => {
    if (open) {
      out += '</span>';
      open = false;
    }
  };
  const write = (chunk) => {
    if (!chunk) return;
    if (!open) {
      const c = css();
      if (c) {
        out += `<span style="${c}">`;
        open = true;
      }
    }
    out += escHtml(chunk);
  };

  const apply = (params) => {
    const codes = (params === '' ? '0' : params).split(';').map((x) => (x === '' ? 0 : Number(x)));
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) {
        style.color = ''; style.bg = ''; style.bold = false;
        style.dim = false; style.italic = false; style.underline = false;
      } else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) { style.bold = false; style.dim = false; }
      else if (c === 23) style.italic = false;
      else if (c === 24) style.underline = false;
      else if (c === 39) style.color = '';
      else if (c === 49) style.bg = '';
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        style.color = `var(--ansi-${ANSI_16[c >= 90 ? c - 82 : c - 30]}, #c3ccd9)`;
      } else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) {
        style.bg = `var(--ansi-${ANSI_16[c >= 100 ? c - 92 : c - 40]}, #1d232d)`;
      } else if (c === 38 || c === 48) {
        const target = c === 38 ? 'color' : 'bg';
        if (codes[i + 1] === 5) {
          const col = ansi256(codes[i + 2]);
          if (col) style[target] = col;
          i += 2;
        } else if (codes[i + 1] === 2) {
          const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
          if ([r, g, b].every((x) => Number.isFinite(x))) {
            style[target] = `rgb(${r | 0},${g | 0},${b | 0})`;
          }
          i += 4;
        }
      }
      /* 其余（闪烁、隐藏、上划线…）忽略：颜色少一个无所谓，控制码不能露出来 */
    }
  };

  RE_SGR.lastIndex = 0;
  let last = 0;
  let m = RE_SGR.exec(body);
  while (m !== null) {
    write(body.slice(last, m.index));
    closeSpan();
    apply(m[1]);
    last = m.index + m[0].length;
    m = RE_SGR.exec(body);
  }
  write(body.slice(last));
  closeSpan();
  return out;
}

/** 去掉控制码的纯文本（复制/导出用，别把 \x1b 带进剪贴板和文件） */
function stripAnsi(raw) {
  return String(raw == null ? '' : raw).replace(RE_NON_SGR, '').replace(RE_SGR, '');
}

/*
  按行缓存。
  每次来新日志都会重渲染整个列表（桶上限 1500 行），逐行重新解析 ANSI
  是纯浪费；行对象在 store 里是稳定的，用 WeakMap 缓存既快又不会泄漏。
*/
const ansiCache = new WeakMap();
function rowHtml(l) {
  if (!l || typeof l.text !== 'string') return '';
  let hit = ansiCache.get(l);
  if (hit === undefined) {
    hit = ansiToHtml(l.text);
    ansiCache.set(l, hit);
  }
  return hit;
}


/** 当前显示的日志行（来源过滤 + 时间合并） */
const visibleRows = computed(() => derived.value);

/* ------------------------------------------------ 行内来源标签（合并视图用） */

/*
  每一行属于哪个来源，靠条目自带的 key（仓储层写入，见 app-store 的
  pushServiceLog / loadServiceLogs）。
  没有 key 的条目（旧数据）返回空串，由 srcClass 退回按 source 上色，
  绝不显示 "undefined" —— 那种徽标用户只会以为界面坏了。
*/
function srcKeyOf(l) {
  if (l.key && ZONE_BY_KEY[l.key]) return l.key;
  return '';
}

/*
  合并视图：标出来源（MaiBot / SnowLuma）—— 这是唯一的归属信息。
  单个来源视图：**不再贴 OUT / ERR 标签**。

  用户原话："不要显示错误等内容，就是正常的 cmd 样式"。
  他指的是每行前面那个 OUT / ERR 徽标 —— 正常 cmd 窗口不会给每行贴
  "这是标准输出 / 这是标准错误"的牌子，一列粉红色的 ERR 还会让人以为
  满屏都是错误。stdout/stderr 的区分本来就不该由用户来读：
    · 行文字的颜色已经按级别上色（l-error / l-warn），该红的自然红；
    · 单来源视图里的正文顺序就是原始输出顺序，不需要每行再贴一个牌子。
  合并视图里的来源标签要留着 —— 两路日志并成一条流时，
  不标来源就分不清这句话是谁说的（那也不是"错误标记"）。
*/
function srcTag(l) {
  if (store.logsFocus) return '';
  return TAG_BY_KEY[srcKeyOf(l)] || (l.source === 'stderr' ? 'ERR' : 'OUT');
}

function srcClass(l) {
  const k = srcKeyOf(l);
  if (store.logsFocus || !k) return `s-${l.source || 'stdout'}`;
  return `s-${k}`;
}

function srcTitle(l) {
  const z = ZONE_BY_KEY[srcKeyOf(l)];
  return `${z ? z.name : '未知来源'} · ${l.source || 'stdout'}`;
}

/*
  空状态。
  级别筛选去掉之后，"有日志但被筛没了"这种空状态不复存在 ——
  这里只剩一种情况：当前看的来源一条日志都没有，原因只有"没在运行/还没输出"。
*/
function emptyHint() {
  if (store.logsFocus) {
    return store.services.find((s) => s.key === store.logsFocus)?.running
      ? '服务运行中，等待输出…'
      : '暂无日志（服务未运行或尚未产生输出）';
  }
  /* 合并视图：直接告诉用户为什么这里是空的，以及去哪让它不空 */
  return '暂无日志 —— MaiBot 和 SnowLuma 都没在运行。到「总览」页的「MaiBot」「SnowLuma 协议端」卡片启动它们，日志会实时出现在这里。';
}

/*
  行首时间。
  今天的行只给 HH:MM:SS；**不是今天的行必须带月-日**。
  理由：合并成一条流之后，日志文件里本来就跨天（一次会话一天的输出都在），
  只显示时分秒会出现 "22:18:11 → 08:18:50" 这种"看起来倒序"的相邻两行 ——
  实测合并流里就有这么一对，用户只会以为排序坏了。
  非法时间戳退化成 --:--:--（不显示 NaN）。
*/
function clock(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const hm = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const md = [d.getMonth() + 1, d.getDate()]
    .map((n) => String(n).padStart(2, '0'))
    .join('-');
  return `${md} ${hm}`;
}

/** 悬停给出完整时间（含日期）—— 行首那一列是有意压缩过的 */
function fullTime(ts) {
  /* ts=0 是"解析不出时间"的哨兵值，别显示成 1970 年 */
  if (!ts) return '时间未知';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '时间未知';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/* ---------------------------------------------------------------- 操作 */

/** 仅在进入页面 / 手动刷新时拉取历史日志（不再轮询） */
async function reloadAll() {
  reloading.value = true;
  try {
    /* 两个服务的历史快照一起拉（启动器日志不再进这个页面） */
    const [a, b] = await Promise.all([
      loadServiceLogs('maibot', 1200),
      loadServiceLogs('snowluma', 1200)
    ]);
    /*
      检查返回值。
      仓储层此前在失败时会把桶整体清空并返回 ok:true，界面表现为
      "点一下刷新，日志全没了"且毫无提示。现在仓储层失败会保留旧内容
      并返回 ok:false，这里必须如实告知，否则用户以为日志真的没了。
    */
    const failedZones = [
      ['MaiBot', a],
      ['SnowLuma', b]
    ].filter(([, r]) => r && r.ok === false);
    if (failedZones.length) {
      const first = failedZones[0][1]?.message || '未知原因';
      toast(
        `${failedZones.map(([n]) => n).join('、')} 日志读取失败（已保留原有内容）：${first}`,
        'error',
        6000
      );
    }
    await refreshServices();
    await scrollAllToBottom();
  } finally {
    reloading.value = false;
  }
}

/**
 * 清空当前显示的来源。
 *   合并视图 —— 两个服务一起清（"我看到的都没了"）。
 *   单个来源 —— 只清它。
 * 关键修正（历史 bug）：只清对应的 key，且**没有定时器会把它拉回来**。
 */
async function clearVisible() {
  if (!store.logsFocus) {
    const rs = await Promise.all([clearServiceLogs('maibot'), clearServiceLogs('snowluma')]);
    const bad = rs.find((r) => r && r.ok === false);
    if (bad) toast(bad.message || '清空失败', 'error');
    else toast('已清空全部日志', 'success');
    return;
  }

  const zone = ZONE_BY_KEY[store.logsFocus];
  const r = await clearServiceLogs(store.logsFocus);
  if (r.ok) toast(`${zone?.name || ''} 日志已清空`, 'success');
  else toast(r.message || '清空失败', 'error');
}

/** 导出按钮的文案与说明随当前来源变化（合并视图导出两个服务） */
const exportLabel = computed(() => '导出');
const exportTitle = computed(() =>
  store.logsFocus
    ? '导出为 .log 文件'
    : '把两个服务的日志各导出一个 .log 文件'
);
const clearTitle = computed(() => '仅清空日志缓冲');

/**
 * 导出当前显示的来源：
 * 单个服务，或合并视图下的两个服务 —— 主进程把缓冲区写成 .log 文件。
 */
async function exportVisible() {
  const keys = store.logsFocus ? [store.logsFocus] : ['maibot', 'snowluma'];
  const rs = await Promise.all(keys.map((k) => exportServiceLogs(k)));
  const okPaths = rs.filter((r) => r.ok).map((r) => r.path);
  if (!okPaths.length) {
    toast(rs.find((r) => !r.ok)?.message || '导出失败', 'warn');
    return;
  }
  toast(
    okPaths.length === 1
      ? `已导出到 ${okPaths[0]}`
      : `已导出 ${okPaths.length} 个服务的日志：${okPaths.join('  ·  ')}`,
    'success',
    6000
  );
  /* 部分成功必须如实说，否则用户以为两个都导出来了 */
  if (okPaths.length < keys.length) {
    toast(rs.find((r) => !r.ok)?.message || '有服务导出失败（可能尚未产生日志）', 'warn', 6000);
  }
}

async function copyVisible() {
  const list = visibleRows.value;
  if (!list.length) {
    toast('当前没有可复制的日志', 'warn');
    return;
  }
  /* 复制/导出的文本先去掉控制码：剪贴板和 .log 文件里不该出现 \x1b */
  const text = list
    .map((l) => `[${clock(l.ts)}] [${srcTag(l)}] [${l.level}] ${stripAnsi(l.text)}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${list.length} 行`, 'success');
  } catch (_) {
    toast('复制失败，请改用「导出」', 'error');
  }
}

async function openLogDir() {
  const dir = store.info.logFile
    ? store.info.logFile.replace(/[\\/][^\\/]+$/, '')
    : '';
  if (!dir) {
    toast('尚未获取到日志目录', 'warn');
    return;
  }
  const r = await openPath(dir);
  if (!r.ok) toast(r.message || '无法打开目录', 'error');
}

/* ---------------------------------------------------------------- 滚动 */

/*
  只剩一个滚动区，滚到底比原来（遍历多个 .log-box）简单得多。
*/
const boxRef = ref(null);

async function scrollAllToBottom() {
  await nextTick();
  const el = boxRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/* 新日志到达时自动滚到底部（仅在用户本就贴近底部时，避免打断回看） */
watch(
  () => visibleRows.value.length,
  async () => {
    await nextTick();
    const el = boxRef.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }
);

/*
  切换来源（双击标签的胶囊）后跳到最新一行。
  不跳的话：从"全部"切到只看某个服务时，滚动位置会被沿用，
  用户看到的是一段和刚才完全无关的中间内容，体感像"日志没刷出来"。
*/
watch(
  () => store.logsFocus,
  () => {
    scrollAllToBottom();
  }
);

/*
  实时日志由 AppLayout（常驻组件）订阅，这样离开日志页期间产生的日志
  也会被收集，回到页面时不会"中间这段日志凭空消失"。
  这里只负责进入页面时拉一次历史快照。
  （启动器自身日志不再订阅、也不在这一页显示：它照旧写盘，
    右上角「日志目录」按钮能直接定位到。）
*/
onMounted(() => {
  /* 必须 catch：reloadAll 是 async，失败时没人接管会变成 unhandled rejection */
  reloadAll().catch((e) => toast('日志加载失败：' + (e?.message || e), 'error'));
});
</script>

<style scoped>
/*
  铺满整个软件（菜单栏底下）。
  外壳在日志路由下会去掉内边距、并关掉自己的滚动（AppLayout 的 .body-full），
  这里就负责把高度吃到 100%，滚动全部交给每个 .log-box。
  · 用 height:100% 而不是 min-height:100vh ——
    外壳是 flex 列布局，.body 是 flex:1，页面高度得"跟着容器走"；
    100vh 会把顶部菜单栏也算进去，直接撑出多余滚动条。
  · 只留 10/12px 的呼吸位：日志是看内容的地方，多一圈留白就少一屏日志。
*/
.logs-page {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  height: 100%;
  min-height: 0;
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

/*
  「实时」标记：让用户知道这块日志会不会自己动。
  ⚠️ 颜色不能再用 --theme-color / --theme-tint：
  日志/终端这一整块**在两套主题下都是深色**（--console-* 固定），
  而 --theme-color 是按"浅底上的字"选的强调色 —— 浅色主题下 #2b6cff 压在
  --console-head(#232529) 上实测只有 **3.12:1**（深色主题 4.77:1），
  一个 9.5px 的小徽标根本读不出来。
  改用 ANSI 调色板里的亮蓝：它是"给深色控制台看的"一档，
  浅/深两套主题下都 ≥7:1；底色用控制台自己的叠加色。
*/
.zone-live {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  font-weight: 600;
  color: var(--ansi-bright-blue);
  background: var(--console-tint);
  /* v4 起按钮/徽标不再用 999px 药丸；这里是 22px 高的小徽标，
     用平台给的 --r-pill-ctl（17px > 高度一半 → 视觉上仍是全圆角，
     但不再是被点名的 "999px 残留"） */
  border-radius: var(--r-pill-ctl);
  padding: 0.125rem 0.5rem;
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
  gap: 0.5rem;
}

/* 间距走 token：原来是 7px，和同一屏里的 8px/10px 混着来，没有体系 */
.level-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/*
  级别筛选胶囊。
  ──────────────────────────────────────────────────────────────────
  三处旧写法各自都有实测后果：

  ① background: rgba(255,255,255,0.8) —— 写死的浅色。
     深色主题下合成出 #d0d0d0 的**白底**，而 color 是 var(--ink)=#c2c7ce，
     实测文字对比度 **1.11:1**（截图里那四颗就是"白胶囊上看不见字"）。
     换成 --surface-2：浅色 #fbfcfe、深色 #23272d，由主题自己给值。

  ② 没有 font-family —— <button> 不继承 body 的字体（UA 样式表把它设成
     Arial）。实测同一个视口里 .lv-chip/.lv-state/.ztool 是 **Arial**，
     而 .head-h2/.zone-name 是 **Segoe UI Variable Text**，
     中文和数字在两套字形之间跳，正是"排版错位"的来源之一。

  ③ height: 28px 与页面上 PillButton size="sm" 的 26px 不是一档；
     border-radius: 999px 是被 v4 明令去掉的药丸。
     统一到 --h-ctl-sm / --r-ctl。
*/
.lv-chip {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: var(--h-ctl-sm);
  padding: 0 var(--sp-3);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-ctl);
  background: var(--surface-2);
  color: var(--ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color var(--dur-base), color var(--dur-base), background var(--dur-base);
}

.lv-chip:hover {
  border-color: var(--theme-line);
  color: var(--theme-color);
}

.lv-chip.active {
  background: var(--theme-color);
  border-color: var(--theme-color);
  /* 实底强调色上的文字有专门的 token：浅色下是白字(4.48:1)、
     深色下是深墨字(5.27:1)。用 --paper-full 只是"碰巧同值"，
     语义上不是"强调底上的字"，换主题时容易漂。 */
  color: var(--on-accent);
}

/*
  页签里的运行状态（"· 运行中 / · 未运行 / · 已退出"）。
  颜色一律走语义令牌，不写死色值：
    · 运行中 → --ok-ink（它是"当字用"的一档：浅色 5.40:1、深色 8.53:1）
    · 已退出 → --warn-ink（不是错误，是"结束了、值得看一眼"）
    · 未运行 → --ink-soft
  这三个都是按浅底选的，而页签本身用 --surface-2 做底 —— 同一个方向，两套主题都对。
  （这里原来是 .lv-count：级别筛选的条数，级别筛选整条去掉后没有消费者。）
*/
.lv-state-on {
  color: var(--ok-ink);
}

.lv-state-off {
  color: var(--warn-ink);
}

.lv-state-idle {
  color: var(--ink-soft);
}

/*
  选中的页签是**实心强调色底**：状态文字必须跟着换成"强调底上的字"，
  否则绿色/灰色压在 --theme-color 上读不出来（浅色下 --ok-ink 压 #2b6cff 不足 2:1）。
*/
.lv-chip.active .lv-state {
  color: var(--on-accent);
  opacity: 0.85;
}

/*
  【用户要求】日志页就是"一整块日志"：
    · 页面自身不再留四周内边距、区块之间也没有间距 → 日志块直接贴到内容区四边；
    · 日志块去掉圆角与左/右/下描边，它是一整块，不再是一张浮在页面上的卡片；
    · 上面那条页签行保留自己的内边距，三个动作（复制/导出/清空）靠右排在同一行里，
      不再单独占一行高度 —— 这就是原来那条"来源名 + 条数 + 实时 + 动作"的头被去掉的原因。
  放在这些规则之后声明，同选择器同优先级下后写者生效，不需要 !important。
*/
.logs-page {
  position: relative;
  gap: 0;
  /* 标题栏是浮在最上层的一条 44px（内容从 0 开始排），这里让开它 ——
     日志块因此从标题栏正下方一直铺到页面底边。 */
  padding: calc(var(--titlebar-h, 44px)) 0 0;
  overflow: hidden;
}

/*
  页签与动作不再单独占一行：它们浮在日志块自己的顶上。
  这样"底下一整块"就是真正的整块 —— 没有浅色横条，也没有中间那片空白，
  日志块从标题栏下方一直覆盖到底边。
*/
.level-row {
  position: absolute;
  z-index: 2;
  top: calc(var(--titlebar-h, 44px) + 0.5rem);
  left: 0.75rem;
  right: 0.75rem;
  align-items: center;
  padding: 0;
}

.level-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: auto;
}

/*
  这三个动作原先有一条"压在深色日志块上必须换亮色"的覆盖
  （color: rgb(255 255 255 / 72%) / hover #fff）—— 那是按官方深色配色写死的。
  【用户要求】深色块底色是程序自带的，但浮在上面这一行不该跟着硬编码深色：
  整条覆盖删掉，回到 .ztool 自己的 --console-muted / --console-title
  （控制台区域的既有令牌，两套主题下都由主题给值）。
*/

/*
  页签同理：原先这里有一条"照官方深色页签"的覆盖
  （transparent 底 + rgb(255 255 255 / …) 描边与文字）—— 已整条删除。
  现在页签直接吃 .lv-chip 的基础规则：--surface-2 底 / --line-strong 描边 /
  --ink 字 / 选中用 --theme-color + --on-accent，
  和页面其余按钮同一套令牌，不再为这一行单独做一套深色。
*/

.log-console {
  border: 0;
  border-radius: 0;
  /* 明确允许收缩：否则内容会把整块撑高 */
  flex: 1 1 0;
  min-height: 0;
  /* 通到窗口左右边缘：抵消内容区左右各 18px 的页面边距（实测 18 与 1262），
     这样深色块就和标题栏一样通到两侧，不再是一条浮在浅色底上的卡片 */
  margin: 0 -18px;
}

/* 给浮在上面的那一行留出空间，日志正文不会被它压住 */
.log-box {
  padding-top: 2.5rem;
}

/*
  单一日志区：铺满剩余高度。
  原实现是 grid 两列（MaiBot | SnowLuma）+ 启动器一行的三个独立框，
  现在只有一个框：flex:1 + min-height:0 交给它，
  滚动全部由内部的 .log-box 承担（外层不再有第二条滚动条）。
*/
.log-console {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--console-bg);
  border: 1px solid var(--console-outline);
}

/* 合并视图下"某个服务在等确认"的提示条（与输入栏里的 EULA 横幅同色同义） */
.console-tip {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 0.75rem;
  background: var(--warn-tint);
  border-bottom: 1px solid var(--console-outline-soft);
}

.console-tip .zi-eula-txt {
  flex: 1;
  min-width: 0;
}

.zone-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--console-head);
  border-bottom: 1px solid var(--console-outline-soft);
}

.zone-ico {
  color: var(--theme-color);
  font-size: 13px;
}

.zone-name {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--console-title);
}

.zone-count {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--console-muted-dim);
  font-variant-numeric: tabular-nums;
}

.zone-tools {
  margin-left: auto;
  display: flex;
  gap: 0.25rem;
}

.ztool {
  letter-spacing: var(--ls-sm);
  border: none;
  background: transparent;
  color: var(--console-muted);
  font-size: 12px;
  /* 同 .lv-chip：<button> 必须显式继承字体，否则落到 UA 的 Arial */
  font-family: inherit;
  padding: 0.25rem var(--sp-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur-base), color var(--dur-base);
}

.ztool:hover {
  background: var(--console-tint);
  color: var(--console-title);
}

.ztool-danger:hover {
  background: var(--err-bg-strong);
  color: var(--ansi-bright-red);
}

/*
  唯一的日志滚动区。
  min-height 从 380px、max-height 从 56vh 改成"吃满剩余高度"：
  这两个写死的值就是"日志只占半屏"的元凶。min-height:0 必须有，
  否则内容一多就会把 .log-console 撑高而不是自己滚（外层已经 overflow:hidden）。
*/
.log-box {
  letter-spacing: var(--ls-sm);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 0.625rem;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.log-line {
  display: flex;
  gap: 0.5rem;
  padding: 0.125rem 0 0.125rem 0.5rem;
  border-left: 2px solid transparent;
}

.log-line.l-error {
  border-left-color: var(--err);
}
.log-line.l-warn {
  border-left-color: var(--warn);
}
.log-line.l-success {
  border-left-color: var(--ok);
}
.log-line.l-info {
  border-left-color: transparent;
}

/*
  时间列：**固定宽度**，不是 min-width。
  ──────────────────────────────────────────────────────────────────────
  clock() 对"今天的行"输出 HH:MM:SS（8 字符），对跨天的行输出 MM-DD HH:MM:SS
  （14 字符）。原来是 `flex: none; min-width: 58px` —— flex-basis:auto 时
  宽度取内容，min-width 只在内容更窄时兜底，于是同一份列表里出现两种列宽：
      今天的行   .log-ts = 58px   → 正文列 x=124.4
      跨天的行   .log-ts = 94.3px → 正文列 x=160.8
  下面每一行的来源徽标与正文跟着右移 36.4px，整片日志看起来就是"歪的"
  （实测数据来自 scripts/legacy/ui5-logs-fake.mjs 注入同构假行后的量测）。
  等宽字体下按字符数给宽度：14 字符 × 6.74px ≈ 94.3px，
  8.6em(=98.9px) 留 4% 余量，两套主题、字体回退下都不会再溢出。
*/
.log-ts {
  flex: none;
  width: 8.6em;
  color: var(--console-muted-faint);
  font-variant-numeric: tabular-nums;
}

/*
  来源徽标 = 一行日志的"栏"。
  ──────────────────────────────────────────────────────────────────────
  时间列修好之后，同一份列表里**还剩一处错位**：徽标宽度跟着文字长度变
  （实测 MaiBot 45.2px / SnowLuma 56.9px / OUT 27.6px），
  于是正文列的起点在 192 → 203.8 → 174.5 之间跳，最大差 **29.3px**。
  合并视图（默认视图）里两路日志交替出现，正文左边界就一直在抖。

  这里把这一列钉成固定宽度：取最宽的标签（SnowLuma 实测 56.9px，
  border-box 下含内边距）向上取整到 58px。min-width 而不是 width：
  以后真出现更长的来源名，徽标会自己变宽、字不会被裁，只是那一行错位 —— 
  比"把字切掉"安全。ERR/OUT 这类短标签同样撑到 58px，成为规整的一栏。

  行高与上边距：原来是 `align-self: flex-start; margin-top: 0.25rem`，
  徽标高 16px、首行行框 18px → 徽标中心比首行中线**低 2px**
  （"图标与文字不齐"那一类）。这里用 line-height 1.5 + padding 2px
  把高度固定成 16px，再配 margin-top 2px，中线差收敛到 0px。
*/
.log-src {
  letter-spacing: var(--ls-2xs);
  flex: none;
  min-width: 58px;
  padding: 0.125rem 0.25rem;
  font-size: 10px;
  line-height: 1.5;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
  border-radius: 3px;
  align-self: flex-start;
  margin-top: 0.125rem;
}

/*
  以下四种徽标的配色一律取自 **ANSI 调色板**，而不是语义色里的 *-ink。
  理由：--info-ink / --ok-ink 这些是"压在浅底上的深色字"，
  而日志区在两套主题下都是深色控制台（--console-*）——
  实测浅色主题下 .s-snowluma 的文字只有 2.52:1、.s-maibot 3.12:1，
  等于没有颜色。--ansi-* 是给深色控制台准备的一档，两套主题都亮。
*/
.log-src.s-stdout {
  color: var(--ansi-bright-cyan);
  background: var(--console-tint);
}

.log-src.s-stderr {
  color: var(--ansi-bright-red);
  background: var(--err-bg);
}

/*
  兜底色：来源既不是 maibot 也不是 snowluma 时（旧数据、或以后新增来源），
  给一个中性配色，而不是让徽标"没上色"看不出是什么。
  这里以前是启动器专用的 .s-app（启动器日志已不再进入这一页）。
  中性色也必须在深色控制台上可读，所以用 --console-muted 而不是 --ink-soft。
*/
.log-src.s-app,
.log-src.s-undefined {
  color: var(--console-muted);
  background: var(--console-tint);
}

/* 合并视图下的来源徽标配色：让"这行是谁输出的"一眼可辨 */
.log-src.s-maibot {
  color: var(--ansi-bright-blue);
  background: var(--console-tint);
}

.log-src.s-snowluma {
  color: var(--ansi-bright-green);
  background: var(--console-tint);
}

.log-text {
  flex: 1;
  min-width: 0;
  color: var(--console-foreground);
  word-break: break-word;
  white-space: pre-wrap;
}

.log-line.l-error .log-text {
  color: var(--ansi-bright-red);
}
.log-line.l-warn .log-text {
  color: var(--ansi-bright-yellow);
}
.log-line.l-success .log-text {
  color: var(--ansi-bright-green);
}

/*
  空状态。
  原来用 --console-faint(#5a6068)，它是"装饰/分隔"档（theme.css 注释里写明
  "不承载信息"）—— 而这里恰恰是日志页唯一告诉用户"为什么是空的、去哪解决"
  的句子。实测对比度 **2.66:1（浅色）/ 2.91:1（深色）**，远低于 AA 4.5:1。
  改用 --console-muted(#9aa0a8)：实测 5.82:1 / 6.49:1。
*/
.log-empty {
  letter-spacing: var(--ls-sm);
  padding: 2.5rem 0;
  text-align: center;
  color: var(--console-muted);
  font-size: 12px;
}

.log-box::-webkit-scrollbar {
  width: 8px;
}
.log-box::-webkit-scrollbar-thumb {
  background: var(--console-scrollbar);
  border-radius: 6px;
}
.log-box::-webkit-scrollbar-thumb:hover {
  background: var(--console-scrollbar-hover);
}

/* ------------------------------------------------- 服务输入栏（stdin）与 EULA 横幅 */
/*
  ★ 这一组样式以前**全项目都不存在**：`.zone-input` / `.zi-*` 这些类名
  在模板里用着，但没有任何 CSS 规则（src/ 下搜不到一条）。
  也就是说这个"把 stdin 交回给用户"的输入框一直在用浏览器默认外观 ——
  深色日志区里塞一个原生白底 input 和系统灰按钮。
  这里按控制台配色补齐：字段、发送按钮、EULA 横幅、说明文字。
*/
.zone-input {
  flex: none;
  padding: 0.5rem 0.625rem 0.5rem;
  background: var(--console-head);
  border-top: 1px solid var(--console-outline-soft);
}

.zi-eula {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-bottom: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--warn-tint);
  border: 1px solid var(--warn);
}

.zi-eula-txt {
  letter-spacing: var(--ls-sm);
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--hint-warn-ink);
}

.zi-agree {
  letter-spacing: var(--ls-sm);
  flex: none;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--warn);
  /* 与全站控件同一档圆角（v4 去掉了药丸） */
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--hint-warn-ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.zi-agree:hover {
  /* 原写法（实心 --warn 底 + --paper-full 字）浅色下只有 2.95:1。
     实测过三种"只换字色"的方案，都不成立：
       --paper-full / --on-accent → 浅色 2.95:1 ✗（浅色下两者都是白）
       --ink-strong               → 浅色 5.73:1 ✓ 但深色 1.74:1 ✗（ink 档方向相反）
       --warn-ink 压实心底        → 1.95:1 ✗（同族同明度）
     所以改用警告族自己的配对：淡底 + ink 档 = 5.12:1（浅）/ 6.37:1（深），
     两套主题都过 AA，且与常态的字色（--hint-warn-ink）同族。 */
  background: var(--warn-tint);
  color: var(--warn-ink);
}

.zi-form {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0;
}

.zi-prompt {
  color: var(--console-muted);
  font-family: 'Cascadia Mono', Consolas, monospace;
}

.zi-field {
  letter-spacing: var(--ls-sm);
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 0.5rem;
  border: 1px solid var(--console-outline);
  border-radius: var(--radius-sm);
  background: var(--console-bg);
  color: var(--console-foreground);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  outline: none;
}

.zi-field:focus {
  border-color: var(--theme-color);
  box-shadow: 0 0 0 2px var(--theme-tint);
}

.zi-field:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.zi-send {
  letter-spacing: var(--ls-sm);
  flex: none;
  height: 26px;
  padding: 0 0.75rem;
  border: 1px solid var(--theme-color);
  border-radius: var(--r-ctl);
  background: var(--theme-color);
  /* 实底强调色上的文字有专门的 token：浅色下与 --paper-full 同值（都是白，5.35:1），
     深色下 --paper-full(#1c1f24) 5.27:1 → --on-accent(#101216) 5.98:1。
     与同文件 .lv-chip.active 的写法保持一致，避免换主题时漂移。 */
  color: var(--on-accent);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

/* 主按钮的 hover 反馈：原来只有 :disabled，按下去/悬停完全没有变化 */
.zi-send:not(:disabled):hover {
  border-color: var(--accent-hover);
  background: var(--accent-hover);
}

.zi-send:disabled {
  background: transparent;
  border-color: var(--console-outline);
  color: var(--console-muted-faint);
  cursor: not-allowed;
}

/*
  说明文字用 --console-muted-dim 而不是 *-faint：
  "服务未在运行，先启动服务才能向它输入"是**必须读懂**的操作前提，
  --console-muted-faint 实测 3.58:1（深色）/ 3.91:1（浅色），不达 AA。
*/
.zi-note {
  letter-spacing: var(--ls-sm);
  margin: 0.375rem 0 0;
  font-size: 12px;
  color: var(--console-muted-dim);
}
</style>
