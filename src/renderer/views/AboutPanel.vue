<template>
  <div class="panel">
    <PanelCard>
      <div class="hero">
        <div class="hero-logo"><IconGlyph name="bot" /></div>
        <div class="hero-meta">
          <h2 class="hero-name">MaiBot Launcher</h2>
          <p class="hero-desc">MaiBot 桌面启动器 —— Electron 内核 + Vue 3 自研界面（代码主要由 AI 辅助生成）</p>
          <div class="hero-badges">
            <StatusBadge tone="theme">v{{ info.version || '—' }}</StatusBadge>
            <StatusBadge tone="neutral">{{ info.platform || 'win32' }}</StatusBadge>
          </div>
        </div>
      </div>
    </PanelCard>

    <!--
      「运行环境」放在最前面（紧跟标题卡）。
      原因不只是排版：**版本号 + 「检查更新」** 是这一页唯一的可操作项，
      而它原来排在 6 张说明卡的后面 —— 用户要"检查更新"得先滚过几千字的许可声明。
      现在版本号与入口都在首屏，剩下的许可/来源说明在下面按文档顺序读。
    -->
    <PanelCard title="运行环境" desc="本机启动器运行信息">
      <FieldRow label="版本">
        <TextInput :model-value="info.version || '—'" mono disabled />
        <!--
          「检查更新」就挨着版本号这一行 —— 用户想看"有没有新版本"时，
          视线落在的就是版本号，放到页面底部等于让人去找。
          点击打开二级窗口（更新内容 + 下载进度都在它里面）。
        -->
        <PillButton
          variant="ghost"
          size="sm"
          icon="download"
          data-testid="about-check-update"
          @click="updateOpen = true"
        >
          检查更新
        </PillButton>
      </FieldRow>
      <FieldRow label="平台">
        <TextInput :model-value="info.platform || '—'" mono disabled />
      </FieldRow>
      <FieldRow label="数据目录">
        <TextInput :model-value="info.userData || '—'" mono disabled />
      </FieldRow>
      <span v-if="updateNote" class="update-note">{{ updateNote }}</span>
    </PanelCard>

    <UpdateDialog v-model:open="updateOpen" />

    <PanelCard title="许可与合规" desc="界面来源、技术隔离与商标说明">
      <div class="prose">
        <p>
          本启动器的界面为自研设计：布局、配色、组件与交互均为本项目自主设计，
          <b>未复制任何第三方项目的源代码、图片、音效或字体文件</b>，
          也未打包任何字体（界面只用操作系统内置字体）。
          界面与业务代码（HTML / CSS / JavaScript / 组件）的<b>代码实现</b>{{ ' ' }}并<b>非完全由人工原创编写</b>。
        </p>
        <!--
          AI 使用说明（如实标注）。
          原文写的是"界面代码为完全原创编写"，与事实不符：本项目绝大部分代码由
          AI 编程助手生成或辅助编写，只经人工审阅、修改与测试。
          对可能不受著作权保护的对象主张"完全原创"是错的，也与各国对 AI 生成内容的
          标识要求相冲突，故改为按事实陈述（措辞与 README「代码来源与 AI 使用说明」
          及 NOTICE.md 一致，三处说法必须相同）。
          排版只复用本页已有的 .prose / code，未新增任何设计令牌，也未改
          src/renderer/styles/**。
        -->
        <p>
          <b>代码来源</b>：本项目<b>绝大部分代码由 AI 编程助手生成或辅助编写</b>
          （由 DeepSeek 系列模型驱动），随后经<b>人工审阅与测试</b>。
          人工贡献在于需求取舍、架构与判定逻辑的设计、对 AI 输出的审查与修正、以及真机验证。
          AI 生成部分在不同法域下可能不受著作权保护，本项目<b>不对其主张独占著作权</b>。
        </p>
        <p>
          <b>视觉风格不受版权保护，具体素材才受保护</b> —— 本项目把这条边界守住了：
          项目内的全部图标均由 <code>scripts/gen-icons.mjs</code> 在构建时
          以代码程序化生成（手写 PNG 编码，无外部素材输入），
          界面字体仅使用操作系统内置字体，未打包任何字体文件。
        </p>
        <p>
          启动器与所管理的服务之间{{ ' ' }}<b>通过独立进程通信</b>
          （命令行调用、标准输出与本地 IPC）：<b>不链接其代码、不修改其文件</b>，
          也不改动它们的启动逻辑。
        </p>
        <p class="notice-line">
          完整来源说明与第三方许可清单见随包 <code>NOTICE.md</code> 与
          <code>THIRD_PARTY_NOTICES/</code>；
          数据存放与联网行为的披露见随包 <code>NOTICE-TO-USER.md</code>（使用须知）。
        </p>
      </div>
    </PanelCard>

    <PanelCard title="所管理服务的许可" desc="MaiBot 与 SnowLuma 都是独立进程，许可互不相同">
      <div class="prose">
        <p>
          <b>MaiBot</b>、<b>SnowLuma</b> 各自以自己的许可证发布，
          <b>条款一律以它们目录下的原文为准</b>。本启动器<b>不复述、不解释、不代为同意</b>，
          也不记录你的选择；是否同意，由你在它们自己的流程中决定。
          原文位置：MaiBot 目录下的 <code>LICENSE</code> 与 <code>EULA.md</code>。
        </p>
        <p>
          本启动器<b>不修改</b>所管理的项目，也<b>不重新实现</b>它们的启动逻辑：
          只以独立进程方式调用它们（命令行调用 + 标准输出捕获），
          不链接其代码、不修改其文件。
        </p>
        <p class="notice-line">
          完整许可原文与逐项说明见仓库根目录的 <code>NOTICE.md</code> 与
          <code>THIRD_PARTY_NOTICES/</code>。
        </p>
      </div>
    </PanelCard>

    <!--
      这里原本是一张与 v1 界面风格相关的游戏商标声明卡。
      v1 界面用过 BA 风格，所以当时需要它；现在风格已整体废弃、界面里没有任何
      游戏素材与相关商标使用，继续保留这段声明等于在讲一个不存在的设计，故删除。
      （合规要点"无第三方游戏素材、无打包字体"已并入上面的许可卡与 NOTICE.md。）
    -->

    <PanelCard title="源码与上游项目" desc="点击右侧按钮可复制链接，在浏览器中打开">
      <div v-for="l in links" :key="l.url" class="link-row">
        <div class="link-main">
          <span class="link-name">{{ l.name }}</span>
          <span class="link-url">{{ l.url }}</span>
        </div>
        <PillButton variant="ghost" size="sm" icon="link" @click="open(l.url)">打开</PillButton>
        <PillButton variant="plain" size="sm" icon="copy" @click="copy(l.url)">复制</PillButton>
      </div>
    </PanelCard>

    <!--
      「运行环境」三行。
      去掉了 :width="80"：FieldRow 的标签列默认 108px，而这里单独写 80px，
      结果同一个应用里"标签列"有 80 / 108 两种宽度（设置页全是 108）。
      标签列宽是版式骨架的一部分，一页一个值会让跨页切换时控件左边界跳动，
      所以统一回默认值（只影响呈现）。
    -->
    <PanelCard title="第三方开源组件" desc="随启动器一起分发的东西及其许可">
      <div class="prose">
        <p>
          运行时依赖 4 个，全部是宽松许可（MIT）：
          <code>vue</code>、<code>vue-router</code>、<code>@xterm/xterm</code>、
          <code>@xterm/addon-fit</code>；可选的原生模块 <code>node-pty</code> 同为 MIT
          （终端在没有它时会自动降级，不装也能用）。
        </p>
        <p>
          包体最大的两个三方件是 <code>Electron</code> 与其内嵌的
          <code>Chromium</code>（MIT / BSD 类许可），它们的许可原文<b>随包分发</b>在安装目录：
          <code>LICENSE.electron.txt</code> 与 <code>LICENSES.chromium.html</code>。
        </p>
        <p>
          构建与打包期只使用 <code>electron</code>、<code>esbuild</code>、<code>vite</code>
          等 MIT 许可的工具链，不把它们的源码随界面一起分发。
        </p>
        <p>
          所管理的 MaiBot / SnowLuma 是<b>独立进程</b>，不是本项目的组件，
          各自适用各自的许可（见上一张卡）。
        </p>
        <p class="notice-line">
          逐项清单与许可原文见随包 <code>THIRD_PARTY_NOTICES/README.md</code>。
        </p>
      </div>
    </PanelCard>

    <!--
      AGPL-3.0 的「适当法律声明」（§5(d)）在界面上的落点：
      版权行 + 无担保声明（§15/§16）+ 许可证名称与链接 + 随包声明文件的入口。
      样式全部复用 .disclaimer / .prose 已有的令牌与排版，没有新增任何设计令牌。
    -->
    <div class="disclaimer">
      <p>
        本启动器为第三方非官方工具，与 MaiBot 官方、SnowLuma 官方
        <b>均无隶属关系</b>。请遵守所管理软件的许可证与使用条款。
      </p>
      <p>
        Copyright (C) 2026 MaiBot Launcher Contributors
      </p>
      <!--
        版权行与上面的 AI 说明必须能同时成立，否则看着像自相矛盾：
        这行的落点是「人工撰写/人工修改的部分 + 整体汇编」，不含 AI 生成部分。
      -->
      <p>
        上述版权声明的范围为<b>本项目的人工撰写与人工修改部分及整体汇编</b>；
        由 AI 生成的部分，本项目不主张独占著作权（详见上方「许可与合规」的代码来源说明）。
      </p>
      <p>
        本项目以 <b>GNU AGPL-3.0-or-later</b> 发布；许可全文随包提供
        （<code>LICENSE</code>，原文见
        <code>https://www.gnu.org/licenses/agpl-3.0.html</code>）。
        对应源码见上方「本项目源码」。
      </p>
      <p>
        <b>本程序不提供任何担保</b>：不担保它能满足你的用途或能与其它软件一起正常工作，
        使用本程序的风险由你自己承担；因使用或无法使用本程序造成的损失，
        作者与贡献者不承担责任（详见 AGPL 第 15、16 条）。
      </p>
      <p>
        完整的第三方组件声明与许可原文随安装包一同分发：
        见随包 <code>NOTICE.md</code> 与 <code>THIRD_PARTY_NOTICES/</code>
        （其中 Electron / Chromium 的声明为随包的
        <code>LICENSE.electron.txt</code>、<code>LICENSES.chromium.html</code>）；
        数据存放与联网行为的披露见随包 <code>NOTICE-TO-USER.md</code>（使用须知）。
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import PanelCard from '../components/ui/PanelCard.vue';
import FieldRow from '../components/ui/FieldRow.vue';
import TextInput from '../components/ui/TextInput.vue';
import PillButton from '../components/ui/PillButton.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import IconGlyph from '../components/IconGlyph.vue';
/* 检查更新的二级窗口（更新内容 + 下载进度），与设置页「关于」用的是同一个组件 */
import UpdateDialog from '../components/UpdateDialog.vue';
import { toast } from '../composables/useToast.js';
import { openExternal, store } from '../stores/app-store.js';

const info = computed(() => store.info || {});

/* 二级窗口开关。检查动作由窗口自己发起（避免这里再发一次造成重复请求）。 */
const updateOpen = ref(false);

/** 版本卡下的一行结论：只在真的查过之后才出现，没查过一个字都不显示 */
const updateNote = computed(() => {
  const p = store.update?.phase;
  if (!p || p === 'idle' || p === 'checking') return '';
  return store.update.message || '';
});

/*
  链接清单。
  注意措辞：这两个项目是**风格灵感来源**，本项目没有复用它们的代码。
  早先写成"AGPLv3 参考项目"会让人以为用了 AGPL 代码，反而招来
  "你必须开源"的质疑 —— 而实际关系是"看过、受启发、未复用"。
*/
const links = [
  /*
    AGPL §5(d)/§13：分发物必须给出「对应源码」的获取途径。
    这里原来指向 https://www.gnu.org/licenses/agpl-3.0.html —— 那是**许可证原文**，
    不是本项目源码，用户照它永远拿不到对应源码（本仓库发出去的那一版实测就是这样）。
    真实公开源码仓库（与主进程更新源 UPDATE 里的 owner/repo 同一个）：
  */
  {
    name: '本项目源码（AGPL-3.0-or-later 对应源码）',
    url: 'https://github.com/LittleSun-Sam/maibot-launcher'
  },
  { name: 'MaiBot 主仓库（所管理的服务）', url: 'https://github.com/Mai-with-u/MaiBot' },
  { name: 'SnowLuma 协议端（所管理的服务）', url: 'https://github.com/SnowLuma/SnowLuma' },
];

/**
 * 复制到剪贴板。
 * 只走 navigator.clipboard —— 原实现还有一段 document.execCommand('copy')
 * 兜底，该 API 已废弃且此处永远不可达（clipboard 在 Electron 中始终可用）。
 */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  } catch (e) {
    toast('复制失败，请手动选择复制：' + (e?.message || e), 'warn', 4500);
  }
}

/** 在系统默认浏览器中打开链接（主进程只放行 http/https） */
async function open(url) {
  const r = await openExternal(url);
  if (!r?.ok) toast(r?.message || '无法打开链接', 'error');
}
</script>

<style scoped>
/*
  页面容器：与设置页同一套（v4 起外壳不再给 .body padding，页面自己排版）。
  改之前实测 .panel 的 rect = [0,44,1270,902]、padding 0 —— 6 张卡片左右贴住
  窗口边缘，14px 卡片圆角被窗口边切平；正文段落一行能到 1224px 宽
  （中文正文超过 45 个字符/行就开始难读）。这里收成居中 880px 一列。
*/
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: 100%;
  max-width: 880px;
  padding: var(--sp-5);
  margin: 0 auto;
}

.hero {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}

.hero-logo {
  width: 54px;
  height: 54px;
  flex: none;
  border-radius: var(--r-card);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-color);
  color: var(--paper-full);
  box-shadow: 0 5px 16px var(--theme-tint);
}
.hero-logo .glyph {
  width: 30px;
  height: 30px;
}

.hero-meta {
  min-width: 0;
}

.hero-name {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--ink-strong);
  letter-spacing: 0.3px;
}

.hero-desc {
  margin: var(--sp-1) 0 var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}

.hero-badges {
  display: flex;
  gap: var(--sp-2);
}

/*
  「运行环境」卡里的更新结论行。
  用 --ink-soft（不是 --ink-faint）：失败原因可能是"未配置更新源…"这类
  需要用户照着去改的信息，11px 的 faint 在页底渐变上只有约 3.1:1，读不清。
*/
.update-note {
  display: block;
  padding-top: var(--sp-1);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--ink-soft);
  word-break: break-word;
}

.prose {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.prose p {
  margin: 0;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--ink);
}

.prose b {
  color: var(--ink-strong);
}

.prose i {
  font-style: italic;
}

/* 行内的文件名/脚本名，用等宽字体与浅底与正文区分。
   底色原来是写死的 rgba(20,30,48,.06)：深色主题下几乎不可见（等于没有"码块"感），
   改走叠加 token（浅色黑 5% / 深色白 6%），两套主题都把 code 与正文分开。 */
.prose code {
  padding: 0.125rem 0.25rem;
  border-radius: 6px;
  background: var(--fill-hover);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--ink-strong);
  word-break: break-all;
}

/* 指向 NOTICE.md 的收尾行，弱化处理，不抢正文注意力 */
.prose .notice-line {
  padding-top: 0.125rem;
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}

/*
  链接行。
  底色原来是写死的 rgba(255,255,255,.62)：浅色下是"白底叠白卡"，几乎看不出
  这是一行独立条目；深色主题下直接变成一块糊在深卡上的白斑。
  改走 --surface-3（hover 底/表头那档）：浅色 #f1f5fb、深色 #292d34，
  两套主题都是"比卡片略深/略浅的一行"，描边继续用 --line。

  justify-content 从 space-between 改成默认（flex-start）+ .link-main 吸收余量：
  space-between 会把「打开」和「复制」这一对**同类操作**推到行的两端
  （实测隔着 250px 的空白），看起来像两个不相干的按钮；
  改成 flex-start 后它们紧挨在右侧，"打开/复制"是一组、"名称+URL"是一栏。
*/
.link-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-md);
  background: var(--surface-3);
  border: 1px solid var(--line);
}

.link-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.link-name {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--ink-strong);
}

/*
  URL 用等宽字体，10.5px 对一串带斜杠的英文来说太挤；
  颜色走 --accent-ink 而不是 --theme-color：后者（浅色 #2b6cff）是给
  "实底 + 白字"准备的，当 11px 文字压在白底上只有 4.48:1，
  刚好差一点点不过 AA；--accent-ink 是 5.84:1 / 深色 5.86:1。
*/
.link-url {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--accent-ink);
  word-break: break-all;
}

/*
  「复制」是 PillButton 的 plain 变体（默认色 --ink-soft）。它单独放在白卡上时
  有 4.83:1，够用；但这里的承载面是上面那层 --surface-3（#f1f5fb），
  实测掉到 4.42:1 —— 差 0.08 不过 AA。PillButton 是公共组件，
  不该为了这一页去改它的默认色（会把别处的层次也一起拉深），
  所以在承载面这一层把它提到 --ink（7.4:1）。「打开」是 ghost 变体，
  本来就是 --ink，两个按钮的文字色于是也对齐了。
*/
.link-row .v-plain {
  color: var(--ink);
}

/*
  页脚的合规声明。
  原来是 --ink-faint（= --text-4 #8a9099）：11px 文字压在页面渐变底上实测
  3.1:1，属于"用户看得出来有字、但看不清写的是什么"。
  这类"免责声明/许可说明"是必须能读的，所以提到 --ink-soft（4.66:1），
  强调部分再用 --ink 拉开一档层次。

  ⚠️ 本次合规返工又补了一层承载面：版权行/无担保声明/许可链接按 AGPL §5(d)
  必须"显眼可读"，而这段文字原来**直接压在左下角的装饰插画上**
  （页面外壳的 hero.png 是固定装饰，实测版权行与「不提供任何担保」正好落在
  橙色插画上，对比度不可用）。这里只沿用卡片已有的令牌给它一层底
  （--surface-1 底 + --line 描边 + --radius-md 圆角），**没有新增任何设计令牌**，
  也没有改 src/renderer/styles/**。
*/
.disclaimer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-1);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--ink-soft);
}

.disclaimer p {
  margin: 0;
}

.disclaimer b {
  color: var(--ink);
}

.disclaimer code {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
</style>
