/*
================================================================================
技术文档：src/renderer/components/AppLayout.vue
职责：应用外壳（自绘标题栏 / 页面菜单栏 / 事件订阅生命周期）。
================================================================================
  本文件在 UI v3（docs/UI-BRIEF-v3.md）里的定位：责任 B —— 骨架。
  ──────────────────────────────────────────────────────────────────────────
  只改了**呈现层**：模板的标签与 class、scoped 样式、
  以及为了标题栏/主题而必须新增的少量纯 UI 状态与事件绑定。
  下列逻辑一行都没有改动、没有删除：
    · store 调用（loadAppInfo / loadSettings / loadPaths / loadTerminalCapability
      / refreshServices / initOnboarding / openOnboarding / dismissOnboarding /
      focusLogs / pushAlert / dismissAlert / clearAlerts / hideToTray）
    · IPC 名称与桥接对象（业务仍走 window.maibotApi / window.maibotEvents）
    · 事件处理函数与订阅（subscribeServiceLogs / subscribeServiceEvents）
    · 计算属性语义（guideDone / guideTip / isFullRoute）
    · watch（route.path / route.fullPath）、生命周期钩子
    · alive / subs.dispose() 订阅清理机制、告警托盘占位、toast、引导
    · 可见性变化轮询（8s 兜底 + document.hidden 停表）
  唯一被替换的是 syncTheme() 的**消费方式**：它原本把路由色写到
  --theme-color 等变量上；v3 规格改为"单一蓝色强调 + 深浅两套主题"，
  同一份路由色现在写到 --route-ink / --route-tint。
  v5：syncTheme() 改为内联 var() 引用（不再解析成字面量），
  随之删掉了失去调用者的 resolveCssColor / rgba / HUE。
  v6（自检假绿清理）删掉的都是**不可达**的东西，逐条列在这里，便于回溯：
    · 模板里那块 v-if="false" 的旧分段导航（nav.nav），以及只喂它的
      .nav*/.more-* scoped 样式、primaryNav / moreNav / moreActive /
      toggleMore、PRIMARY_LABELS / MORE_PATHS / MORE_LABELS / FALLBACK_ICON；
    · 同样 v-if="false" 的主题按钮，以及只喂它的 themeMarkup / themeTip /
      ICON_SHAPES.sun / ICON_SHAPES.moon / toggleTheme；
    · logsFocusLabel、以及 onDocMouseDown 白名单里已经不存在于模板的
      .more-menu / .nav-more 两个选择器。
  为什么"不可达也必须删"：scripts/verify-shell.mjs 第 ④ 段当时拿
  "源码里出现过某个字符串"当合格证，而那两个字符串**只出现在死块里** ——
  死代码越多门禁越绿，同时"双击日志弹出来源胶囊"这条功能被死块带成了
  界面上不可达。现在 dblclick 绑定落回真正渲染的 .menubar-item，
  断言也改成对真实数据的断言（见该脚本 ④ 段）。
================================================================================
*/
<template>
  <div class="shell" :class="{ 'is-scrolled': bodyScrolled }">
    <!--
      ══════════════════════════════════════════════════════════════════════
      ⓪ 左下角大插画（v4 规格 §1.2）
      ══════════════════════════════════════════════════════════════════════
      目标图那个角落有一张"被窗口左/下边缘裁掉、压在内容下面"的角色插画。
      本项目仓库里没有角色图，所以这里用**应用图标放大到 480px、opacity .5**
      顶上（规格 §1.2 明确允许这么占位）。

      🔁 换成自己的插画：把角色图放到仓库根 `resources/hero.png`，
         删掉下面这行 <img> 与对应的 import，改用：
             import HERO_IMG from '../../../resources/hero.png';
         就这一处（样式 .hero-art 无需改动，尺寸/透明度/裁切/层级都是现成的）。
         不要写死 file:// 绝对路径 —— 打包后那条路径一定不存在。
      说明：build/icon-256.png 是 scripts/gen-icons.mjs 生成的多尺寸图标
      （256px 那档），由 Vite 解析成产物内的相对 URL，dev 与打包两种形态都能显示。

      · pointer-events: none —— 它铺在内容层下面，绝不能挡住按钮；
      · z-index: 0，内容层 .body 是 1，所以插画永远在文字后面；
      · 深浅两套由 --hero-opacity 给（浅 .5 / 深 .28），组件里不写死数值；
      · 它**故意**超出窗口左/下边缘（负偏移），被 .shell 的 overflow:hidden
        裁掉 —— 目标图里那半张脸就是这么来的。
    -->
    <img class="hero-art" :src="HERO_ART" alt="" aria-hidden="true" />

    <!--
      ══════════════════════════════════════════════════════════════════════
      ① 自绘标题栏（v4 规格 §1.1，照 docs/reference/dsh-x-reference.png 抄）
      ══════════════════════════════════════════════════════════════════════
      · 整条 44px（--titlebar-h）、-webkit-app-region: drag；里面的**每一个**
        可点元素都必须标 no-drag，否则点击会被窗口拖拽吃掉（表现为
        "按钮点了没反应"）。
      · 双击整条 = 最大化/还原（Windows 习惯）。按钮上的双击不会冒泡到这里：
        no-drag 元素上的 dblclick 事件 currentTarget 是自己，不是标题栏。
      · 从左到右是三团东西：左端「产品名 + 版本号」，**紧接着就是页面菜单栏**
        （见 ② 的 .menubar），两组之间留白，右端仍是「帮助 pill → 齿轮 →
        三个窗口键」。
        v3 那条"主页/安装麦麦/日志/更多"分段导航一度被收进齿轮面板成了二级菜单，
        现在按用户要求以菜单栏的形态回到标题栏左侧：单击直接切页。
    -->
    <header class="titlebar" @dblclick="onTitlebarDblClick">
      <!--
        左：产品名 + 版本号。
        ──────────────────────────────────────────────────────────────────
        原先照"目标图"做成"加粗亮蓝 19px 产品名 + 灰色 13px 版本号"，
        用户看过成品后否掉了这一版（太吵，像十年前的安装器）。现在的规格：
          · 品牌名走**正文色**（--ink），不用强调色 —— 强调色是留给"可交互/选中态"的
            （导航选中项、帮助按钮、主按钮），品牌不该跟它们抢同一份颜色；
          · 13px / 字重 600，与导航项同级，而不是压过整个界面；
          · 版本号降到 11px / --text-4，只作为安静的附注；
          · 平面即可：不加投影、渐变、动画（用户要求"不堆砌动画特效"）。
        窗口图标已由系统任务栏承担，标题栏不再放第二个图标。
      -->
      <div class="brand">
        <span class="brand-name">{{ appName }}</span>
        <span class="brand-ver">v{{ appVersion }}</span>
      </div>

      <!--
        ══════════════════════════════════════════════════════════════════
        ② 页面菜单栏（横向，单击直接切页）
        ══════════════════════════════════════════════════════════════════
        用户原话：「把这一堆功能放到左侧就是标题栏那个地方改成菜单栏，然后
        可以直接切换，而不要点 2 级菜单」—— "这一堆功能"指的是齿轮弹窗里的
        页面入口。所以这 6 项提到标题栏，单击即 go() → router.push() 切页，
        不再需要"先点齿轮、再点条目"两步。

        ⚠️ 齿轮弹窗里因此**只留「关于 + 隐藏到托盘」**（见 ③ 的 .gear-menu）：
        同一个页面入口在菜单栏与弹窗里各有一份，两处必然各自漂移。

        位置：紧跟产品名 + 版本号之后（左端第二团）。右端 .win-tools 有
        margin-left: auto，所以"中间留白"自动落在菜单栏与右端控件之间，
        右端那四个控件永远贴在窗口最右侧。

        🔴 三条硬约束，少一条就会被用户当场报 bug：
          1. 标题栏整条是 -webkit-app-region: drag，所以**本块与每一个条目**
             都必须 no-drag —— 否则单击会变成"拖窗口"，切页完全失效
             （表现为"点了没反应"）。见样式里的 .menubar / .menubar-item。
          2. 每项都是**原生 <button>**：天然进 Tab 序列、Enter/Space 可激活；
             aria-current="page" 标出当前页（读屏软件据此播报"当前页"），
             aria-label 给不依赖可见文字的读屏用户。
          3. 窄窗口下先收自己、绝不压右端：.menubar 允许收缩 + 兜底
             overflow:hidden，而 .win-tools 是 flex:none（见样式段与文件末尾的
             窄窗口降级）。宁可菜单栏自己少显示，也不能把最小化/关闭挤掉。
      -->
      <!--
        收缩开关：默认收起，只有点这个箭头才展开右侧几个页面按钮。
        按钮一个都没删，只是不再一直占着标题栏。
      -->
      <button
        class="menu-toggle"
        type="button"
        :class="{ open: menuOpen }"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        :title="menuOpen ? '收起菜单' : '展开菜单'"
        @click="toggleMenu"
      >
        <span class="menu-toggle-glyph" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>
      <Transition name="menu-slide" :css="!skipSwap">
        <nav v-show="menuOpen" class="menubar" aria-label="页面菜单" data-testid="titlebar-menubar">
          <!--
            ⚠️ 每条目都绑了 @dblclick="onTabDblClick($event, t, $event.currentTarget)"
            —— 这不是装饰：「双击日志条目 → 弹出来源筛选胶囊」是这个手势**唯一**
            的入口（见 onTabDblClick 上方那段长注释）。历史上一度只有被
            v-if="false" 关掉的旧分段导航绑了这个事件，于是脚本里的胶囊在界面上
            完全不可达 —— 门禁却因为"源码里出现过这段字符串"而一直是绿的。
            现在绑定落在真正渲染的 .menubar-item 上，行为与注释一致。
            对非日志项，onTabDblClick 第一行就 `if (!tab.meta?.full) return;`
            —— 双击等于再点一次，不会误开胶囊。
          -->
          <button
            v-for="t in MENUBAR_ITEMS"
            :key="t.path"
            type="button"
            class="menubar-item"
            :class="{ active: t.path === route.path }"
            :data-testid="`menubar-${t.key}`"
            :title="`打开${t.label}`"
            :aria-label="`打开${t.label}`"
            :aria-current="t.path === route.path ? 'page' : 'false'"
            @click="go(t.path)"
            @dblclick="onTabDblClick($event, t, $event.currentTarget)"
          >
            {{ t.label }}
          </button>
        </nav>
      </Transition>

      <!--
        ══════════════════════════════════════════════════════════════════
        ③ 右侧工具区（v4 规格 §1.1，从右往左数）
        ══════════════════════════════════════════════════════════════════
        目标图从窗口最右边往左依次是：
          最小化 / 最大化 / 关闭（三个细线字形，中心间距约 48px）
          → 留白 28px → 齿轮（34×34 圆角 10 的淡蓝方块）
          → ★ 形 pill「帮助」（高 34、圆角 17、淡蓝底蓝字）
        这四组的顺序、尺寸、留白都照着图来；本块用 `margin-left: auto`
        死死钉在标题栏最右侧（绝不能被中间的弹性内容挤走 —— 上一版就是
        因为这三个键"在 DOM 里但屏幕上看不见"而被用户投诉无法关窗口）。

        🔴 上一版三键不显示的**真实根因**（本轮修掉的就是它）：
        它们当初写成 `<span class="glyph" v-html="ICONS.minimize">`，
        而 ICONS.minimize 的值是**裸的 SVG 形状字符串**（`<path d="…"/>`），
        不带外层 `<svg>`。用 innerHTML 把 `<path>` 塞进一个 HTML `<span>`
        里，浏览器按 "HTML unknown element" 处理（不是 SVG 命名空间），
        于是它什么都没有画 —— span 还占着 14×14 的位置，但屏幕上是空的。
        主题按钮（v-html="themeIcon"）和帮助 pill 的星形是同一个写法，
        所以那两颗也一起是空的（帮助 pill 只剩文字，才勉强看得见）。
        修法：这三个（以及保留代码里的主题 / 星形）字形一律改成**行内真实
        `<svg>` 元素**，并在 `<style scoped>` 里给 .glyph / .wc-svg 显式
        尺寸与描边 —— 不再依赖任何"往 span 里塞 SVG 片段"的写法。
      -->
      <div class="win-tools">
        <!--
          ★ 形「帮助」pill：点开新手引导抽屉。
          2026-09-28 按用户要求**暂时收起入口**：整块由 GUIDE_ENTRY_VISIBLE 控制。
          教程本身没删（抽屉组件、步骤定义、进度存储都在），改回 true 即恢复。
        -->
        <button
          v-if="GUIDE_ENTRY_VISIBLE"
          type="button"
          class="help-pill"
          data-testid="titlebar-help"
          :title="guideTip"
          aria-label="打开新手引导"
          @click="openGuide"
        >
          <!-- 真实 <svg>：见上面根因说明，这里**不能**再写 v-html -->
          <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m12 3.6 2.5 5.1 5.6.8-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z" />
          </svg>
          <span class="help-txt">帮助</span>
          <span v-if="guideDone" class="guide-badge done">✓</span>
          <!--
            `0/10` 这种写法只有已经点开过引导的人才看得懂：
            没点过的人不知道分母是什么、也不知道该干什么。
            一步没做时直接说「未开始」，做了一部分才显示分数。
          -->
          <span v-else-if="store.onboardingDoneCount === 0" class="guide-badge">未开始</span>
          <span v-else-if="store.onboardingTotal" class="guide-badge">
            {{ store.onboardingDoneCount }}/{{ store.onboardingTotal }}
          </span>
        </button>

        <!--
          齿轮：**只剩两个不方便放进菜单栏的动作**（关于 + 隐藏到托盘）。
          ────────────────────────────────────────────────────────────────
          页面入口（安装麦麦 / 日志 / 终端 / 工具箱 / 设置）已经上提到标题栏
          左侧的菜单栏（见 ② 的 .menubar），这里不再重复列出；
          「关于」按用户要求留在弹窗里（它不是一个需要天天切的页面），
          「隐藏到托盘」不是页面、是动作，本来也不该混进菜单栏。

          面板用 Teleport 挂到 body（和下面的日志来源胶囊同一手法）：
          标题栏只有 44px 且 .shell 是 overflow:hidden，就地绝对定位会被
          裁掉半截；挂到 body 后 fixed 定位不受任何祖先裁剪影响。
        -->
        <div ref="gearWrapRef" class="gear-wrap">
          <button
            ref="gearBtnRef"
            type="button"
            class="gear-btn"
            data-testid="titlebar-gear"
            aria-haspopup="menu"
            aria-label="更多功能"
            :aria-expanded="gearOpen ? 'true' : 'false'"
            title="更多功能（关于 / 隐藏到托盘）"
            @click="toggleGear"
          >
            <!-- 齿轮形状与 IconGlyph 的观感对齐（24 视框、1.8 描边、圆头圆角） -->
            <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3.1" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>

        <!-- 目标图里"齿轮与三个窗口键之间"的那 28px 留白 -->
        <span class="wc-sep" aria-hidden="true"></span>

        <!--
          主题切换按钮**已删除**（v4 规格 §1.1 之后它一直挂在 v-if="false" 上）。
          ────────────────────────────────────────────────────────────────
          删它的直接原因不是"目标图里没有它"，而是它是一条**不可达入口**：
          v-if="false" 恒定不渲染，于是它绑定的 themeMarkup / themeTip、
          ICON_SHAPES 里的 sun / moon 形状、以及 toggleTheme() 全部失去调用者。
          同时 scripts/verify-shell.mjs 曾拿"源码里出现过某段字符串"当合格证，
          死代码越多门禁越绿 —— 删掉它是让那条门禁无法再被死代码骗过。

          主题能力保留了**跟随外部**的那一半（一条没删）：theme / isDark /
          applyTheme / initTheme / syncTheme / syncThemeAttr / fadeThemeSwitch
          与主进程 theme:changed 订阅都还在（见 <script> 的主题段），
          主进程推主题依旧会正确落到界面上。
          ⚠️ 但手动切换那半（toggleTheme）已随之删除 —— 所以"标题栏能换主题"
          这句话现在**不成立**，别再照着旧注释去找那个按钮。
          要恢复：把按钮加回 .win-tools、恢复 sun / moon 形状与 themeMarkup，
          并重写 toggleTheme（取反 isDark → applyTheme → shell.setTheme）。
        -->

        <button
          type="button"
          class="icon-btn"
          data-testid="titlebar-min"
          title="最小化"
          aria-label="最小化窗口"
          @click="onMinimize"
        >
          <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5.4 12h13.2" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          data-testid="titlebar-max"
          :title="isMaximized ? '向下还原' : '最大化'"
          :aria-label="isMaximized ? '向下还原窗口' : '最大化窗口'"
          @click="onToggleMaximize"
        >
          <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="maxMarkup"></svg>
        </button>
        <button
          type="button"
          class="icon-btn wc-close"
          data-testid="titlebar-close"
          title="关闭"
          aria-label="关闭窗口"
          @click="onClose"
        >
          <svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6.8 6.8 17.2 17.2M17.2 6.8 6.8 17.2" />
          </svg>
        </button>
      </div>
    </header>

    <!--
      齿轮面板（Teleport 到 body）。
      ------------------------------------------------------------------
      **只剩两项**：关于（页面）+ 隐藏到托盘（动作）。
      为什么：用户要求"不要再点 2 级菜单"，页面入口全部提到了标题栏菜单栏
      （见 ② 的 .menubar）。同一个入口在两处各留一份，早晚会各自漂移；
      所以这里只留"不适合放进菜单栏"的那两个：
        · 关于 —— 用户明确点名要留在弹窗里；
        · 隐藏到托盘 —— 它不是页面，点下去窗口会消失，放进横向菜单栏会被
          当成"又一个页面"，而且它是破坏性动作（窗口没了），不该混在切页里。
      路由与页面逻辑一个字没动 —— goFromMore() → go() → router.push()，
      hideFromMore() → onHideToTray()，都是原函数。
      坐标用 fixed 现算（见 openGear），所以缩放窗口后重开一定对得上。
    -->
    <Teleport to="body">
      <div
        v-if="gearOpen"
        class="gear-menu"
        :style="{ left: gearPos.left + 'px', top: gearPos.top + 'px' }"
        role="menu"
        aria-label="更多功能"
      >
        <!--
          关于：齿轮弹窗里**唯一**的页面入口（active 判定用 route.path，
          所以从菜单栏或首页快捷入口进到 /about 时它同样会亮）。
        -->
        <button
          type="button"
          class="gear-item"
          :class="{ active: route.path === '/about' }"
          role="menuitem"
          aria-label="打开关于"
          @click="goFromMore('/about')"
        >
          <IconGlyph class="gi-ico" name="info" />
          <span>关于</span>
        </button>

        <!--
          隐藏到托盘：**功能只增不减**（旧外壳右上角有这个按钮）。
          它不是一个页面，所以单独放一条动作项，并且用一条细分隔线与上面
          那条页面项分开 —— 混在一起会让人以为点下去会跳页。
        -->
        <button
          type="button"
          class="gear-item gear-action"
          role="menuitem"
          title="隐藏到系统托盘（服务继续运行）"
          @click="hideFromMore"
        >
          <IconGlyph class="gi-ico" name="chev-down" />
          <span>隐藏到托盘</span>
        </button>
      </div>
    </Teleport>

    <!--
      双击「日志」弹出的服务切换胶囊。
      用 Teleport 挂到 body 而不是就地绝对定位：
      挂到 body 后不受任何祖先 transform 影响（fixed 的包含块问题），
      也不会被标题栏的 drag 区域吃掉点击。
    -->
    <Teleport to="body">
      <div
        v-if="logMenu"
        class="log-menu"
        :style="{ left: logMenuPos.left + 'px', top: logMenuPos.top + 'px' }"
        role="menu"
        aria-label="选择日志来源"
      >
        <button
          v-for="t in LOG_TARGETS"
          :key="t.label"
          type="button"
          class="lm-item"
          :class="{ active: (store.logsFocus || null) === t.key }"
          @click="pickLogTarget(t.key)"
        >
          {{ t.label }}
        </button>
      </div>
    </Teleport>

    <!--
      ══════════════════════════════════════════════════════════════════════
      ④ 内容区：铺满 + 独立滚动（v4 规格 §1.3）
      ══════════════════════════════════════════════════════════════════════
      外壳**不再**把页面压成"居中 640px 窄列"（v3 的做法会让每一页都长得
      一样，首页那张卡也被挤在中间一条缝里）。现在容器铺满，由页面自己排版：
      主页自己会把那张 745px 的卡水平居中、放到窗口 45%~65% 的高度处。
      路由 meta.full（日志页）例外：它要铺满，见 .body-full。
    -->
    <main ref="bodyRef" class="body" :class="{ 'body-full': isFullRoute }" :style="bodyStyle" @scroll.passive="onBodyScroll">
      <!--
        ⚠️ 三个挂载点共用同一个 <component>，过渡由 skipSwap 决定挂在哪一个上
        （<transition> 和 <component> 必须在**同一个**父级里配对，不能抽成子组件）。
        skipSwap 为真时走"无过渡"那一支，换页变成瞬时替换 —— 见 skipSwap 的注释。
      -->
      <router-view v-slot="{ Component }">
        <component :is="Component" v-if="skipSwap" />
        <transition v-else :name="swapName" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!--
      新手引导（右侧抽屉，非模态）。
      ------------------------------------------------------------------
      为什么是抽屉而不是全屏弹层：正确的安装顺序是"先检查环境 → 再配置 →
      最后才安装"，所以引导到"安装麦麦"那一步时用户必须能去安装器页面
      操作。全屏弹层会把安装器挡住，逼着在引导里重做一遍安装表单
      （那会与 InstallerPanel 的一千多行逻辑重复并必然漂移）。
      抽屉的遮罩不吃点击，底下的页面照常可操作。

      ⚠️ 入口位置的最新落点：引导步骤里"点顶部去安装麦麦"的说法，
      对应的是标题栏左侧菜单栏的第二项（见 ② 的 .menubar）——单击直达，
      **不再**经过"右上角齿轮 → 安装麦麦"这条二级菜单（v4~v5 一度是那样）。
      功能与路由都没变，只是入口位置变了。

      guide-mode 为 false 时是只读参考资料（步骤全做完后再看就是这个形态）。
    -->
    <OnboardingWizard
      :open="store.onboardingOpen"
      :guide-mode="store.onboardingGuideMode"
      @close="closeOnboarding"
      @progress="onOnboardingProgress"
    />

    <!--
      告警区（可关闭的持久告警，与一闪而过的 toast 互补）
      ------------------------------------------------------------------
      为什么必须有：主进程在「服务异常退出」「连续重启失败已放弃」这类
      关键时刻会发出真正重要的事件，但只有 toast —— 3~6 秒后消失，
      用户离开座位再回来就完全不知道发生过什么。
      store.alerts 里已经有 pushAlert()/dismissAlert() 与 20 条上限。
    -->
    <Transition name="alerts" :css="!skipSwap">
      <section v-if="store.alerts.length" ref="alertTrayRef" class="alert-tray">
        <header class="at-head">
          <span class="at-title">
            <IconGlyph name="info" />
            需要关注 {{ store.alerts.length }} 条
          </span>
          <button type="button" class="at-clear" @click="clearAlerts">全部忽略</button>
        </header>
        <ul class="at-list">
          <li
            v-for="a in store.alerts"
            :key="a.id"
            class="at-item"
            :class="a.level || 'info'"
          >
            <span class="at-ico"><IconGlyph :name="a.level === 'error' ? 'bolt' : 'info'" /></span>
            <div class="at-main">
              <span class="at-item-title">
                {{ a.title }}
                <em v-if="a.count > 1" class="at-count">×{{ a.count }}</em>
              </span>
              <span v-if="a.text" class="at-text">{{ a.text }}</span>
            </div>
            <button
              type="button"
              class="at-close"
              title="忽略这条"
              aria-label="忽略这条告警"
              @click="dismissAlert(a.id)"
            >
              <IconGlyph name="close" />
            </button>
          </li>
        </ul>
      </section>
    </Transition>

    <ToastStack />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import IconGlyph from './IconGlyph.vue';
import ToastStack from './ui/ToastStack.vue';
import OnboardingWizard from './onboarding/OnboardingWizard.vue';
import { buildSteps } from '../onboarding/steps.js';
import { toast } from '../composables/useToast.js';
/*
  左下角大插画（v4 §1.2）。
  当前用的是应用图标 —— 仓库里没有角色图，规格允许先拿它占位。
  🔁 换成自己的插画：把图放到仓库根 resources/hero.png，然后只改下面这一行：
       import HERO_ART from '../../../resources/hero.png';
     模板与 <style> 里的 .hero-art 都不用动。
  （原来这份 import 是给标题栏那个 20px 小图标用的；v4 的标题栏照目标图
    去掉了方形图标，所以它改行"当插画"。）
*/
/*
  左下角大插画（v4 §1.2）= **用户自己的 mai.png**（1024×1040，橙色圆滚滚 + 绿芽）。
  已由我放进 resources/hero.png。

  为什么不再用 build/icon-256.png：那是**应用图标**（托盘/窗口/exe 用的方形小图，
  本身带蓝色圆角方块底），放大到几百像素当背景插画会变成一个巨大的蓝色方块，
  用户判定"丑的跟大便一样、还是原来那个图标"。职责分开：
  图标继续只做图标（托盘/窗口/exe），插画只用专门的角色图。
  🔁 换图只需替换 resources/hero.png：Vite 会把它打成带 hash 的静态资源，
  开发态与打包态走同一条路径，不需要动 extraResources。
*/
import HERO_ART from '../../../resources/hero.png';
import {
  clearAlerts,
  createSubscriptionScope,
  dismissAlert,
  dismissOnboarding,
  focusLogs,
  GUIDE_ENTRY_VISIBLE,
  hideToTray,
  initOnboarding,
  loadAppInfo,
  loadPaths,
  loadSettings,
  loadTerminalCapability,
  openOnboarding,
  pushAlert,
  refreshServices,
  store,
  subscribeServiceEvents,
  subscribeServiceLogs
} from '../stores/app-store.js';

/* ============================================================================
 *  标题栏 / 主题：纯呈现层状态（不写 store，避免碰业务状态契约）
 * ========================================================================== */

/** 外壳桥（preload 暴露）。页面里读一次，避免每处都写 window.launcher？. */
const shell = window.launcher;

/**
 * 标题栏里那个**会随状态换形状**的字形（最大化 / 还原）。
 * ────────────────────────────────────────────────────────────────────────
 * ⚠️ 这里是上一版"三个窗口键在 DOM 里却一个都看不见"的根因所在，改回去必再犯：
 *   v3 的写法是 `<span class="glyph" v-html="ICONS.minimize"></span>`，
 *   而值是 `<path d="…"/>` 这种**没有外层 <svg> 的片段**。innerHTML 把
 *   `<path>` 塞进 HTML 命名空间的 <span> 里，浏览器不会把它当图形元素画 ——
 *   元素在 DOM 里、还占着 14×14，屏幕上却什么都没有。于是"最小化/最大化/
 *   关闭"三个键集体隐形（用户因此关不掉窗口），主题按钮同样隐形，
 *   帮助 pill 只剩文字才勉强看得见。
 *
 * 现在的规矩（三层都改到位，缺一处就复发）：
 *   1. 模板里凡是字形，一律写**真实的行内 `<svg>` 元素**（命名空间才对）；
 *      需要换形状时，只把**内层形状字符串**交给 v-html —— svg 元素本身在
 *      模板里，内层片段会被按 SVG 解析。
 *   2. 下面这个 computed 只负责"选哪段形状"（没有任何业务语义）。
 *   3. `<style scoped>` 里给 .glyph 显式尺寸与描边，不依赖外层是不是 svg。
 *
 * 为什么最小化/关闭不用 computed：它们的形状是固定的，直接写在模板里
 * 更不容易再被"改成 v-html"这种写法带跑。
 *
 * 为什么少了 sun / moon：它们唯一的使用者是模板里那个 v-if="false" 的
 * 主题按钮，按钮已删（不可达入口 + 门禁假绿），形状随之失去调用者。
 * 恢复主题按钮时要把这两段形状一起加回来。
 */
const ICON_SHAPES = {
  maximize: '<rect x="5.6" y="5.6" width="12.8" height="12.8" rx="1.6"/>',
  /* 还原：两个错开的方框（Windows 习惯） */
  restore:
    '<rect x="4.6" y="7.6" width="11.8" height="11.8" rx="1.6"/><path d="M8.4 7.6V5.6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2"/>'
};

/*
  ══════════════════════════════════════════════════════════════════════════
  标题栏菜单栏的 6 个页面入口（数组顺序 = 屏幕上的左右顺序）
  ══════════════════════════════════════════════════════════════════════════
  用户原话：「把这一堆功能放到左侧就是标题栏那个地方改成菜单栏，然后可以直接
  切换，而不要点 2 级菜单。除了关于和隐藏的托盘。」—— 所以这里是"齿轮弹窗里
  那些页面入口"的新家，**关于**除外（它按用户要求留在齿轮弹窗里）。

  为什么是**静态表**而不是去路由表里按 meta.title 筛：
    1) 路由 meta.title 是给开发看的（"总览 / 安装器"），而菜单栏是给新手看的
       （"主页 / 安装麦麦"）—— 这两个名字**故意不同**，不该由路由表决定；
    2) label 必须"不可能为空"。本项目发生过一次"菜单项只有图标、没有文字"的
       事故，成因就是菜单取到了 meta.title 缺失的路由对象。把名字写死在这里，
       那一类事故就不可能复发。
       ⚠️ 这条是**测试护栏**级别的结论：scripts/verify-shell.mjs 现在直接断言
       本表里就是那 6 条人话名字（而不是断言"源码里某处出现过某个字符串"）——
       谁把它改回 meta.title，门禁会红。
    ⚠️ 代价：以后加页面要回来补一行（这是有意的取舍 —— 少一个页面入口是
       显式可见的，而"空白行"是不可诊断的）。

  🔴 日志（/logs）与终端（/terminal）是**两个独立条目、两条独立路由**：
     · /logs   —— 铺满整屏的合并日志流（meta.full，MaiBot + SnowLuma 合流，
                  双击条目可只看某个来源）；
     · /terminal —— xterm 交互终端（另一个组件、另一套 IPC）。
     它们不是同一个页面的两个 tab 参数，**绝不能合并**（合并必然让其中一个
     功能从界面上消失）。这里保持两行、各跳各的，与旧弹窗里的两个入口一致。

  为什么没有图标：这 6 项要挤在标题栏左侧，图标会让整条菜单栏宽出约 90px，
  窄窗口下就会先去压右端的窗口三键 —— 文字已经能一眼认出来，图标在这里是净负债。
*/
/*
  菜单栏是否展开。
  用户要求"收缩形式：只有点击箭头才展开"，所以默认是**收起**。
  这是本机界面偏好，不是业务设置 —— 放 localStorage，不进 backend-settings。
*/
const MENUBAR_KEY = 'maibot-launcher.menubar-open.v1';
const menuOpen = ref((() => {
  try {
    return localStorage.getItem(MENUBAR_KEY) === '1';
  } catch {
    return false;
  }
})());

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  try {
    localStorage.setItem(MENUBAR_KEY, menuOpen.value ? '1' : '0');
  } catch {
    /* 写不进去就只在本次会话生效，不报错 */
  }
}

const MENUBAR_ITEMS = [
  { path: '/overview', key: 'overview', label: '总览' },
  { path: '/installer', key: 'installer', label: '安装麦麦' },
  { path: '/logs', key: 'logs', label: '日志' },
  { path: '/terminal', key: 'terminal', label: '终端' },
  { path: '/toolbox', key: 'toolbox', label: '工具箱' },
  { path: '/settings', key: 'settings', label: '设置' }
];

/*
  已被删除的导航表（以及为什么）：MORE_PATHS / MORE_LABELS / FALLBACK_ICON。
  ────────────────────────────────────────────────────────────────────────
  这三张表唯一的消费者是模板里那块 v-if="false" 的旧分段导航（它的 .more-menu
  下拉与 primaryNav/moreNav 两个 computed）。那块模板已删，表随之失去调用者；
  留着就是"没人读的兜底逻辑"，还会让门禁对着死代码发合格证。
    · MORE_PATHS —— 「更多」下拉收哪些路由；
    · MORE_LABELS —— 「更多」里 4 条的人话名字（原来还有 FALLBACK_ICON 兜图标）；
    · FALLBACK_ICON —— meta.icon 缺失时的兜底图标（IconGlyph 自己也有兜底，
      见 IconGlyph.vue 的 ICONS 回退）。
  现在标题栏菜单栏的名字唯一来源是上面的 MENUBAR_ITEMS（静态、不可能为空）；
  齿轮弹窗只剩两条硬编码项（关于 / 隐藏到托盘，见模板 ③），不需要查表。
*/

/** 名称与版本号来自主进程 app:info（store.info），不硬编码 */
const appName = computed(() => store.info?.name || '麦麦启动器');
const appVersion = computed(() => store.info?.version || '—');

/** 主题：'light' | 'dark'，只影响 html[data-theme] */
const theme = ref('light');
/*
  isDark 是"当前主题是不是深色"的唯一读法，现在**没有模板消费者**（唯一的
  themeMarkup/themeTip 都随 v-if="false" 的主题按钮删掉了），所以必须显式
  声明"有意保留"：它属于上面那段"跟随外部主题"的能力（谁要读当前主题都得用它），
  删掉就等于把这份能力也一起删了 —— 那不是本次清理的目的。
  据项目惯例用 eslint-disable 标注（而不是塞进未使用变量里让 lint 变红）。
  🔁 恢复标题栏主题按钮时，第一件事就是把这两行注解删掉。
*/
// eslint-disable-next-line no-unused-vars -- 有意保留：见上方说明（主题能力的读取入口）
const isDark = computed(() => theme.value === 'dark');

/**
 * 写 data-theme 到 <html>。
 * 为什么挂在 html 上而不是 .shell：theme.css 的深色覆盖层写成
 * `[data-theme='dark']`（见 UI-BRIEF §6.4），挂在根元素才能一起覆盖
 * 挂到 body 的 Teleport 层（toast / 日志菜单）。
 * 同时**不写 store**：主题由主进程持久化，渲染层只负责反映。
 */
/* 主题淡变用到的两个状态。放在 applyTheme 之前声明：
   它俩是 let，不是 var，写在下面会出现"用早于声明"的 TDZ 问题。 */
let themeFadeTimer = 0;
let themeAppliedOnce = false;

function applyTheme(next) {
  const value = next === 'dark' ? 'dark' : 'light';
  const changed = theme.value !== value;
  theme.value = value;
  document.documentElement.setAttribute('data-theme', value);
  /*
    §14：首次落主题只登记、不淡变（那是启动过程，淡变看起来像闪一下）；
    之后只有值**真的变了**才淡变 —— 主进程推回来那次常常与本地刚设的相同。
  */
  if (!themeAppliedOnce) themeAppliedOnce = true;
  else if (changed) fadeThemeSwitch();
  /*
    换主题后必须**重算强调色**：--accent 在深浅两套里取值不同
    （浅 #2b6cff / 深 #5b8dff），而 syncTheme 写在 <html> 上的内联值
    优先级高于样式表 —— 不重算的话，深色主题下按钮会一直是浅色那支蓝。
    （syncTheme 是函数声明，存在提升，这里调用没有 TDZ 问题。）
  */
  syncTheme();
}

/** 让主题落到 DOM 上（启动时 / 外部改主题时） */
/*
  主题值的两种形状都要认（与同文件 readMaximized 同一个约定）：
    · 字符串 'light' | 'dark' —— DOM 属性、本地调用
    · 主进程推来的 { ok, theme } —— theme:changed 的负载
  只认字符串就是原来那个 bug：推送进来的是对象，两个判断都不成立，
  于是推送被静默丢掉，出现"状态说深色、界面还是浅色"。
*/
function syncThemeAttr(themeValue) {
  const value =
    typeof themeValue === 'string'
      ? themeValue
      : themeValue && typeof themeValue === 'object'
        ? themeValue.theme
        : null;
  if (value === 'light' || value === 'dark') applyTheme(value);
}

/*
  §14：主题切换不做"亮度突跳"。
  启动后第一次落主题不挂（那是启动过程，不是用户动作，淡变看起来像闪一下）；
  减少动效偏好下也不挂 —— reduce 要的是"更温和"，不是"更多动画"。
*/
function fadeThemeSwitch() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.documentElement;
  el.classList.add('theme-fading');
  window.clearTimeout(themeFadeTimer);
  themeFadeTimer = window.setTimeout(() => el.classList.remove('theme-fading'), 320);
}

/*
  切换主题的**本地动作**（toggleTheme）已随标题栏那个 v-if="false" 的主题按钮
  一起删除：它唯一的调用者就是那个按钮，而按钮恒定不渲染 —— 于是这个函数
  永远不可能被触发，只是挂在文件里骗过阅读者（让人以为"标题栏能换主题"）。
  ────────────────────────────────────────────────────────────────────────
  仍然**完整保留**的主题能力（一条都没删）：
    · initTheme()   —— 启动时读主进程里用户上次选的主题；
    · applyTheme()  —— 把主题落到 html[data-theme]（syncTheme 随之重算强调色）；
    · syncThemeAttr() —— 消化主进程推来的 theme:changed（含 { ok, theme } 形状）；
    · isDark / theme、fadeThemeSwitch()、以及 onMounted 里的
      shell.onThemeChanged 订阅。
  也就是说"主题跟随主进程/外部改变"照旧工作，只是标题栏没有手动切换入口。
  🔁 要恢复手动切换：把主题按钮加回 .win-tools，并写一个 toggleTheme()：
     取反 isDark → applyTheme(next) → shell.setTheme(next)（持久化失败只记日志，
     不要让按钮"点了没反应"）。不要只加回按钮而漏掉函数（会变成空图标/无反应）。
*/

/** 启动时读一次主进程里的主题（用户上次选的） */
async function initTheme() {
  const get = shell?.getTheme;
  if (typeof get !== 'function') {
    /* 没有这条通道时，跟随已经在 DOM 上的属性（theme.css / index.html 的默认值） */
    syncThemeAttr(document.documentElement.getAttribute('data-theme'));
    return;
  }
  try {
    const r = await get();
    syncThemeAttr(typeof r === 'string' ? r : r?.theme);
    /* 主进程回了空/异常值（例如通道存在但还没接主题）时，
       以 DOM 上已有的 data-theme 为准，别把深色"闪回"浅色 */
    syncThemeAttr(document.documentElement.getAttribute('data-theme'));
  } catch (e) {
    console.error('[shell] 读取主题失败:', e);
    syncThemeAttr(document.documentElement.getAttribute('data-theme'));
  }
}

/* -------------------------------------------------------------- 窗口控制 */

/** 最大化状态：标题栏那个按钮的图标跟着它换 */
const isMaximized = ref(false);

/** 最大化 / 还原字形（同样是"内层形状"，外层 svg 在模板里 —— 见 ICON_SHAPES） */
const maxMarkup = computed(() =>
  isMaximized.value ? ICON_SHAPES.restore : ICON_SHAPES.maximize
);

/**
 * 从主进程回包里取最大化状态。
 * `window:is-maximized` 的既有实现返回布尔（preload 注释即契约），但主进程
 * 侧现在给的是 { ok, maximized }（services/index.js）。两种都接受，
 * 免得通道形状微调一次就要回来改这里。
 */
function readMaximized(r) {
  if (typeof r === 'boolean') return r;
  if (r && typeof r === 'object') {
    if (typeof r.maximized === 'boolean') return r.maximized;
    if (typeof r.isMaximized === 'boolean') return r.isMaximized;
  }
  return null;
}

async function refreshMaximized() {
  const fn = shell?.isMaximized;
  if (typeof fn !== 'function') return;
  try {
    const state = readMaximized(await fn());
    if (state !== null) isMaximized.value = state;
  } catch (e) {
    /* 状态读不到就维持现状，绝不影响其它功能 */
    console.error('[shell] 读取窗口最大化状态失败:', e);
  }
}

/** 主进程推送的窗口状态（最大化/还原）→ 换按钮图标 */
function onWindowState(payload) {
  const state = readMaximized(payload);
  if (state !== null) isMaximized.value = state;
}

/**
 * 调一个外壳通道，并且**永远不把异常漏到控制台之外**。
 * 为什么必须 catch：ipcRenderer.invoke 在"主进程还没注册这条通道"时
 * 会 reject（Error: No handler registered for 'window:close'），
 * 不接就是一条未处理的 Promise 拒绝 —— 用户点关闭没反应，控制台只有红字。
 * 这里降级成一条可读日志，界面其余部分不受影响。
 */
function callShell(method) {
  const fn = shell?.[method];
  if (typeof fn !== 'function') return;
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') {
      r.catch((e) => console.error(`[shell] ${method} 失败:`, e));
    }
  } catch (e) {
    console.error(`[shell] ${method} 失败:`, e);
  }
}

function onMinimize() {
  callShell('minimize');
}

/**
 * 最大化 / 还原。
 * 切换语义由主进程决定，渲染层不自己判断（见 preload 注释）。
 * 主进程的 window:maximize 会**返回切换后的新状态**（windows.toggleMaximize），
 * 因此这里直接用回包换图标；同时主进程还会推 window:state，
 * 两条路都通向同一个 ref，重复设成同值是幂等的。
 */
function onToggleMaximize() {
  const fn = shell?.maximize;
  if (typeof fn !== 'function') return;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      r.then((res) => {
        const state = readMaximized(res);
        if (state !== null) isMaximized.value = state;
      }).catch((e) => console.error('[shell] maximize 失败:', e));
    } else {
      const state = readMaximized(r);
      if (state !== null) isMaximized.value = state;
    }
  } catch (e) {
    console.error('[shell] maximize 失败:', e);
  }
}

function onClose() {
  callShell('close');
}

/** 双击标题栏空白处 = 最大化/还原（Windows 习惯） */
function onTitlebarDblClick(ev) {
  /* 点在按钮上时不触发：按钮自己的 dblclick 已经处理过（双击标签 = 切换日志来源） */
  if (ev.target?.closest?.('button')) return;
  onToggleMaximize();
}

/** 引导是否已全部走完（决定徽标显示进度还是 ✓、以及默认打开形态） */
const guideDone = computed(
  () => store.onboardingTotal > 0 && store.onboardingDoneCount >= store.onboardingTotal
);

const guideTip = computed(() => {
  if (store.onboardingOpen) return '关闭新手引导';
  /* computed 里读另一个 computed 必须写 .value —— 模板才会自动解包，
     这里不是模板作用域，漏了就永远拿到真值对象（恒为真） */
  if (guideDone.value) return '重新查看新手教程（已全部完成，可点「重来一遍」）';
  const n = store.onboardingTotal - store.onboardingDoneCount;
  return `继续新手引导（还剩 ${n} 步）`;
});

/**
 * 标题栏入口。抽屉已开时再点就收起（同一个按钮切换，符合直觉）。
 * 不做成"关掉就消失"的浮动按钮 —— 教程要随时翻得到。
 */
function openGuide() {
  if (store.onboardingOpen) {
    dismissOnboarding();
    return;
  }
  /* 全部做完 → 当参考资料打开（只读，不再让你勾一遍） */
  openOnboarding(guideDone.value ? { mode: 'reference' } : { mode: 'guide' });
}

/** 引导内部勾选/取消步骤时同步进度，让标题栏徽标实时更新 */
function onOnboardingProgress(p) {
  if (!p) return;
  store.onboardingDoneCount = Number(p.done) || 0;
  store.onboardingTotal = Number(p.total) || store.onboardingTotal;
}

/** 关闭引导：只收起抽屉，标题栏入口仍在（不再永久禁用） */
function closeOnboarding() {
  dismissOnboarding();
}

/** 服务 key → 界面可读名称（提示文案里不能直接甩 'maibot' 给用户看） */
function svcName(key) {
  return key === 'snowluma' ? 'SnowLuma' : key === 'maibot' ? 'MaiBot' : String(key || '服务');
}

const route = useRoute();
const router = useRouter();

/*
  齿轮面板（.gear-menu）的开关状态。
  ────────────────────────────────────────────────────────────────────────
  ⚠️ 名字里的 "more" 是**历史遗留**：它原来同时管两块东西 ——
  模板里 v-if="false" 的旧「更多」下拉（.more-menu）与现在生效的齿轮面板。
  旧下拉与它的 moreNav / moreActive / toggleMore 已删（死代码），
  只剩齿轮面板在用这一份状态，所以保留原名以免与注释/cookie 式引用脱节；
  将来要改名请连同 closeMore / gearOpen 一起改。
*/
const moreOpen = ref(false);

function closeMore() {
  moreOpen.value = false;
}

function goFromMore(path) {
  closeMore();
  go(path);
}

/** 「更多」里的动作项：隐藏到托盘（先收起菜单，避免窗口隐藏时菜单还挂着） */
function hideFromMore() {
  closeMore();
  onHideToTray();
}

function go(path) {
  if (path !== route.path) router.push(path);
}

/* ---------------------------------------------------------------------------
 * 齿轮面板（v4 §1.1：v3 那条分段导航的入口搬到这里）
 * -------------------------------------------------------------------------
 * 为什么**复用** moreOpen / closeMore，而不是另起一套 gearOpen：
 *   · 齿轮面板的前身就是 v3 的「更多」下拉，两者一直共用同一份开关状态
 *     （moreOpen；收起走 closeMore，展开由 toggleGear 自己写 —— 它比原来那个
 *      toggleMore 多一步"算面板坐标"），再复制一套状态必然漂移；
 *   · 收起逻辑是现成的、且已被三条路径复用：换页的 watch(route.path)、
 *     Esc（onDocKeydown）、点别处（onDocMouseDown 的捕获阶段监听）。
 *     自己再写一套 = 多一份"忘了收起"的 bug 面。
 * 唯一需要新增的东西是**面板位置**：它 Teleport 到 body 后用 fixed 定位，
 * 所以要在打开前读一次齿轮按钮的屏幕坐标（见 openGear）。
 *
 * 新增的只有"呈现层交互状态"：一个 ref（坐标）+ 几个 ref="…" 引用，
 * 没有碰任何 store / IPC / 事件订阅 / 计算属性语义。
 * ------------------------------------------------------------------------- */
const gearBtnRef = ref(null);
const gearWrapRef = ref(null);
/** 面板坐标（fixed）。用 left/top 而不是 right，是为了不随窗口缩放漂移 */
const gearPos = ref({ left: 0, top: 0 });
/** 齿轮是否处于展开态（用于给按钮加一点选中观感） */
const gearOpen = computed(() => moreOpen.value);

/**
 * 按齿轮按钮的实际位置算面板坐标。
 * 水平**右对齐**按钮右缘（照目标图右上角那套控件的对齐习惯），
 * 再夹回窗口内 —— 窄窗口时按钮贴边，不夹的话面板会伸出窗口外。
 */
function openGear() {
  const r = gearBtnRef.value?.getBoundingClientRect?.();
  if (!r) return;
  /* 面板实际宽度在渲染后才量得到；用固定宽度常量做夹取，够用且不会跳 */
  const PANEL_W = 168;
  const left = Math.max(8, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8));
  gearPos.value = { left, top: Math.round(r.bottom + 8) };
}

/** 点齿轮：收起 / 展开（收起走 closeMore；展开前先算面板坐标，见 openGear） */
function toggleGear() {
  if (moreOpen.value) {
    closeMore();
    return;
  }
  openGear();
  moreOpen.value = true;
}

/* ---------------------------------------------------------------------------
 * 双击「日志」标签 → 弹出来源筛选胶囊
 * -------------------------------------------------------------------------
 * 需求：双击顶部「日志」，从它下面弹出一个胶囊，用来切换只看 MaiBot
 * 还是只看 SnowLuma 的日志。
 *
 * 日志区已经从"三个独立框"改成**一条合并流**（见 LogsPanel），
 * 所以这个胶囊就是它的来源筛选器：全部 / MaiBot / SnowLuma。
 *
 * 三个容易做错的地方，这里都按"会坏"的方式防住了：
 *   1) 用户双击的是标签，所以单击行为不能被吃掉 —— dblclick 之后浏览器
 *      已经派发过一次 click，路由其实已经跳转到日志页了，这里不能再
 *      "先判断有没有跳转"，直接幂等 toggle 即可。
 *   2) 胶囊会把当前选择标出来（active），否则用户不知道自己在看哪个。
 *   3) 点空白处 / 按 Esc / 换到别的页面都必须收起，不然它会一直挂在
 *      屏幕角落挡内容。
 *   4) 胶囊要挂在**被双击的那个条目**下面（见 anchor 参数）：日志条目在
 *      标题栏左侧菜单栏里，锚点取错就会飘到窗口中间去。
 * ------------------------------------------------------------------------- */
const isFullRoute = computed(() => Boolean(route.meta?.full));

/*
  §12：渐变遮罩只在"内容真的滚到浮动界面下面"时出现。
  静止在顶部时内容与 chrome 并不重叠，此时压一道阴影是凭空多出来的分隔。
  用一个布尔量跟踪即可，不需要每帧读 scrollTop。
*/
const bodyScrolled = ref(false);
function onBodyScroll(e) {
  bodyScrolled.value = e.target.scrollTop > 4;
}

const LOG_TARGETS = [
  /* 文案用"人话"：光写「全部」新手不知道"全部什么" */
  { key: null, label: '全部来源' },
  { key: 'maibot', label: 'MaiBot' },
  { key: 'snowluma', label: 'SnowLuma' },
];

const logMenu = ref(false);
/* 用 fixed 坐标：胶囊挂在被双击标签的正下方、水平居中 */
const logMenuPos = ref({ left: 0, top: 0 });

/*
  这里原本还有一个 logsFocusLabel computed（把 store.logsFocus 翻成"人话"标签，
  喂给旧分段导航上那个 .nav-focus 小药丸）。那个 span 在 v-if="false" 的死块里，
  已随死块删除，computed 随之失去调用者 —— 所以一并删掉，而不是留着"以防万一"。
  ⚠️ 副作用（**已知**）：当前界面不再有"现在只看 MaiBot / 只看 SnowLuma"的
  文字痕迹。胶囊内部的 .lm-item.active 仍然标出选中项，但那只在胶囊打开时可见。
  要恢复常驻痕迹，应该把它加到**真正渲染**的 .menubar-item 上
  （即 logs 那一条），不要重建一块死模板。
*/

function closeLogMenu() {
  logMenu.value = false;
}

/**
 * 双击「日志」条目 → 开关来源筛选胶囊。
 * @param {MouseEvent} ev      双击事件（用 preventDefault 挡住标题栏的拖拽/选中）
 * @param {object} tab         被双击的菜单条目（只有 meta.full 的日志项有效）
 * @param {Element} [anchor]   胶囊的定位锚点。模板里传 $event.currentTarget
 *   —— 因为 $event 是原生事件，在它被异步读取前就读出 currentTarget；
 *   做成参数是为了不依赖"currentTarget 在调用栈里还有效"这个隐含前提
 *   （事件派发结束后 currentTarget 会被浏览器置空）。
 */
function onTabDblClick(ev, tab, anchor) {
  /* 只有日志页有服务可切；其它标签双击保持原样（等于再点一次） */
  if (!tab.meta?.full) return;
  ev.preventDefault();
  if (logMenu.value) {
    closeLogMenu();
    return;
  }
  const el = anchor || ev.currentTarget;
  const r = el?.getBoundingClientRect?.();
  if (r) logMenuPos.value = { left: r.left + r.width / 2, top: r.bottom + 10 };
  logMenu.value = true;
}

function pickLogTarget(key) {
  focusLogs(key);
  closeLogMenu();
  go('/logs');
}

/* 收起胶囊/齿轮面板：Esc、点击别处、换页。
   mousedown 而不是 click —— 否则"点按钮"会先冒泡到 window 把菜单关掉，
   再触发按钮自己的 click，用户会感觉第一次点没反应。
   ⚠️ 白名单里必须同时有 .gear-menu（齿轮面板本身，它 Teleport 到了 body）
   与 .gear-wrap（齿轮按钮，自己会 toggle）—— 少了任何一个，点齿轮都会
   出现"关掉又立刻打开"的抖动。选择器是纯呈现层的东西，逻辑没变。
   （v3「更多」下拉的 .more-menu / .nav-more 两项已随死模板一起删掉：
     那两个类名在模板里已经不存在，留着永远不会命中。）*/
function onDocMouseDown(ev) {
  const el = ev.target;
  const inMenu = (sel) => el && typeof el.closest === 'function' && el.closest(sel);
  if (!inMenu('.log-menu')) closeLogMenu();
  /* 齿轮按钮自己会 toggle，点它时不能在这里又收一次 */
  if (!inMenu('.gear-menu') && !inMenu('.gear-wrap')) {
    closeMore();
  }
}
function onDocKeydown(ev) {
  if (ev.key === 'Escape') {
    closeLogMenu();
    closeMore();
  }
}

onMounted(() => {
  window.addEventListener('mousedown', onDocMouseDown, true);
  window.addEventListener('keydown', onDocKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDocMouseDown, true);
  window.removeEventListener('keydown', onDocKeydown);
});
/* 换页时两个浮层都必须收起，否则会挂在屏幕角落里挡内容 */
watch(() => route.path, () => {
  closeLogMenu();
  closeMore();
});

/** 隐藏到托盘 */
async function onHideToTray() {
  const r = await hideToTray();
  if (r.ok) {
    /* 给出明确反馈：窗口消失是预期行为，不是崩溃 */
    toast('已隐藏到系统托盘，服务继续运行', 'info', 3200);
  } else {
    toast(r.message || '隐藏失败', 'error');
  }
}

/* ------------------------------------------------------------------ 主题色 */
/*
  v5：这里原本还有 HUE / resolveCssColor() / rgba() 三个"读一个 CSS 变量再把
  它算成具体色值"的工具函数，唯一的调用者就是下面那个把强调色内联到 <html>
  的 syncTheme()。改成内联 var() 引用之后它们全部失去调用者，eslint 的
  no-unused-vars 直接把构建卡住 —— 所以一并删掉。
  真正被保留的能力是："强调色的唯一定义在 theme.css，JS 侧不持有第二份颜色"。
  这一点现在是靠"JS 只写 var(--accent)，解析交给浏览器"实现的，比在 JS 里
  复制一份解析逻辑更可靠（也顺带修掉了深色主题被浅色值锁死的问题，见下）。
*/

/**
 * 主题色同步（换页时执行，保留原有 watch 形态）。
 * ────────────────────────────────────────────────────────────────────────
 * v3 的硬要求是"**单一蓝色强调 + 深浅两套主题**"，而 v1 是"每页一个主题色"：
 * 路由表里 meta.color 给的是 8 个不同颜色（--route-overview 蓝、
 * --route-toolbox 紫、--route-settings 棕…），旧实现把它写到 --theme-color，
 * 于是**每换一页整页控件都换色** —— 这正是要改掉的手游味。
 *
 * 所以这里不再读路由色，而是把强调色固定成 theme.css 的 --accent
 * （深浅两套各自由 [data-theme] 覆盖，仍然是 token，不是硬编码色值）。
 *
 * 为什么要显式再写一遍 --theme-color / --theme-tint / --theme-line：
 *   · 页面与组件（约 119 处）仍在读这几个 v1 别名；
 *   · 它们是内联在 <html> 上的，优先级高于样式表。
 *
 * ⚠️ v5 修正（真实 bug，不是洁癖）：
 *   原来写的是 `const accent = resolveCssColor('var(--accent)')` ——
 *   把变量**当场解析成具体色值**再内联，等于给主题上了锁：
 *     · initTheme() 是异步的（读完主进程主题再回调 applyTheme），
 *       只要它在"浅色"状态下跑过一次，内联值就永久是浅色那支蓝；
 *     · 内联样式优先级最高，theme.css 里 [data-theme='dark'] 的 --accent
 *       **再也没机会生效** —— 深色下所有按钮/图标/开关都停在浅色蓝。
 *   实测量到：`data-theme=dark` 时 --accent = #5b8dff，
 *   而 --theme-color = #2a67f5（浅色值，且 html.style 里确实是字面量）。
 *   修法：内联**变量引用**而不是解析结果。var() 在计算值阶段按当前主题重新
 *   解析，切主题天然跟着走，不再依赖"每次都记得重算"。
 *   tint / line 直接别名到已有 token，省掉 JS 里的 alpha 计算。
 */
function syncTheme() {
  const el = document.documentElement;
  /* 读不到 --accent（css 还没加载）时留着样式表自己的声明，不写脏值 */
  if (!getComputedStyle(el).getPropertyValue('--accent').trim()) return;
  el.style.setProperty('--theme-color', 'var(--accent)');
  el.style.setProperty('--theme-tint', 'var(--accent-tint)');
  el.style.setProperty('--theme-line', 'var(--accent-line)');
  /* 语义化别名：留给以后需要"当前强调色"的组件用 */
  el.style.setProperty('--route-ink', 'var(--accent)');
  el.style.setProperty('--route-tint', 'var(--accent-tint)');
}

watch(() => route.path, syncTheme, { immediate: true });

/* ---------------------------------------------------------------------------
 * 换页回到顶部
 * -------------------------------------------------------------------------
 * `.body` 是**所有页面共用的那一个**滚动容器（见模板里的 <main class="body">）。
 * 浏览器只在滚动容器自己被替换时才重置滚动位置，而这里换页只是换掉里面的
 * 组件，容器本身一直在 —— 于是从设置页（滚得很深）切到主页，新页面会
 * 直接停在半中间，**标题和顶部内容被切掉**，看起来像页面渲染坏了。
 *
 * 实测：设置页 scrollTop=1409 时切到主页，主页的 scrollTop 仍是 290。
 * 修法就是换页后把容器的滚动位置归零。用 path 作触发源，
 * 这样连"同一路由只换 query"也会正确重置。
 * ------------------------------------------------------------------------- */
const bodyRef = ref(null);

watch(
  () => route.fullPath,
  () => {
    const el = bodyRef.value;
    if (!el) return;
    /* 等 DOM 换完再归零，否则会被旧页面的高度算回去 */
    nextTick(() => {
      el.scrollTop = 0;
    });
  }
);

/* ---------------------------------------------------------------------------
 * 告警托盘要"占位"，不能只是浮在内容上面
 * -------------------------------------------------------------------------
 * 托盘是 position:absolute + bottom:18px 的浮层，压在 .body 的右下角。
 * 问题是设置页的「应用 / 取消」正好在面板底部右侧 —— 一旦有告警，
 * 按钮就被托盘盖住。实测 elementFromPoint 命中的是告警条目本身，
 * 按钮根本点不到，用户必须先「全部忽略」才能保存设置。
 *
 * 这里量出托盘的真实高度，作为 .body 的额外下内边距：
 * 内容因此**总能滚动到托盘上方**，按钮永远点得到。
 * 用 ResizeObserver 而不是只看告警条数：同一条数下高度也会变
 * （文案长短、条目增减都会影响）。
 * ------------------------------------------------------------------------- */
const alertTrayRef = ref(null);
const alertTrayH = ref(0);
let trayObserver = null;

function measureTray() {
  const el = alertTrayRef.value;
  alertTrayH.value = el ? Math.ceil(el.offsetHeight) : 0;
}

watch(
  () => alertTrayRef.value,
  (el, prev) => {
    if (!trayObserver) trayObserver = new ResizeObserver(measureTray);
    if (prev) trayObserver.unobserve(prev);
    if (el) {
      trayObserver.observe(el);
      measureTray();
    } else {
      /* 托盘消失（全部忽略）→ 收掉占位 */
      alertTrayH.value = 0;
    }
  },
  { immediate: true, flush: 'post' }
);

onBeforeUnmount(() => {
  trayObserver?.disconnect();
  trayObserver = null;
});

/* 有托盘时改成"托盘高度 + 间距"，内容才滚得出来 */
const bodyStyle = computed(() => ({
  paddingBottom: alertTrayH.value ? `${alertTrayH.value + 30}px` : ''
}));

/* -------------------------------------------------------------- 生命周期 */

/** 低频兜底轮询句柄（必须保存，否则无法清理 → 定时器泄漏） */
let servicePollTimer = null;

/*
  ════════════════════════════════════════════════════════════════════════════
  换页过渡的"保命开关"：窗口不可见时必须关掉 <transition mode="out-in">
  ════════════════════════════════════════════════════════════════════════════
  🔴 这是一个**实测复现**的卡死，不是理论风险。

  现象：窗口被最小化 / 被别的窗口完全遮住时切换页面，界面**永久停在旧页面**；
  等窗口重新可见的瞬间，它才"补"一次换页（用户体感就是"点了没反应，过一会儿
  自己跳了"，或者以为整个程序卡死）。

  根因链条（每一步都实测过，见下面的复现步骤）：
    1) 窗口不可见时 Chromium 把渲染进程标成 hidden，**requestAnimationFrame
       完全停摆** —— 实测 hidden 时 1 秒 0 帧，可见时 1 秒 62 帧；
    2) Vue 的 <transition> 不靠 transitionend 收尾：它在 nextFrame() 里用
       requestAnimationFrame 去读计算样式、判断过渡是否结束（见
       @vue/runtime-dom 的 nextFrame / whenTransitionEnds）；
    3) rAF 不来 → 离场结束回调永不触发 → 节点拿不到 transitionend；
    4) 更关键的是 Vue 在**进入过渡之前**就校验了过渡：
       `if (!hasCSSTransform(el)) { done(); return }` —— 而 hidden 时元素没有
       合成层，getComputedStyle(el).transitionDuration 实测解析成 `var(--dur-fast)`
       （transitionProperty 也是 `none`）。于是 done() 虽然被调用，元素上
       Vue 加的那些类**不会被清掉**；
    5) mode="out-in" 的语义是"旧节点离场完成后才挂新节点"，离场既然没收尾，
       新页面就永远不挂载。DOM 里留下的是：
         <main class="body"><div class="panel swap-leave-from swap-leave-active">
       实测连续观察 8.4 秒，class 一次都没变过。

  为什么不能只用 CSS 兜底（比如给 .swap-leave-active 加 animation 强制结束）：
  Vue 是否收尾取决于它自己的 rAF 回调，跟样式无关 —— 在 hidden 时那条路径
  压根不会被跑到。唯一可靠的做法是**在不可见时不使用过渡**。

  为什么不用 `:css="false"` 或给 transition 加超时：
    前者要自己接管 enter/leave 的 done 回调（多一份手写动画状态机）；
    后者等于给 Vue 的过渡打补丁。都不如"不可见时直接不挂 transition"干净。

  代价：窗口隐藏期间的换页没有淡入淡出 —— 用户根本看不见，等于零成本。

  复现/回归方法（本仓库已有工具）：
    Electron 起来后最小化窗口，再从托盘/快捷键切页；
    或 CDP 里直接读 main.body 子元素的 className，
    出现 `swap-leave-active` 且 3 秒不消失即为复发。
  ════════════════════════════════════════════════════════════════════════════
*/
const skipSwap = ref(false);

/*
  §7/§8：换页的方向感。
  ────────────────────────────────────────────────────────────────────────
  原来不管从哪一页去哪一页，位移都是"新页从下方进、旧页往上出"。
  后退时（例如 设置 → 工具箱）方向与前进一模一样：既不是"从哪来回哪去"（§7），
  也没有把去向提前告诉用户（§8）。
  以菜单顺序为基准判定前进/后退：往菜单后面走 = 前进，往前面走 = 后退。
  不在菜单里的路由（例如关于页）按前进处理，保持原来的观感。
  曲线也要镜像（§7）：回程用反向控制点的 cubic-bezier（--ease-standard-in），
  否则"去"和"回"的手感不一致。
*/
const NAV_ORDER = MENUBAR_ITEMS.map((t) => t.path);
const swapDir = ref('fwd');
watch(
  () => route.fullPath,
  (to, from) => {
    const clean = (p) => String(p || '').split('?')[0];
    const i = NAV_ORDER.indexOf(clean(to));
    const j = NAV_ORDER.indexOf(clean(from));
    swapDir.value = i > -1 && j > -1 && i < j ? 'back' : 'fwd';
  }
);
const swapName = computed(() => (swapDir.value === 'back' ? 'swap-back' : 'swap'));

function syncSkipSwap() {
  /*
    document.visibilityState 在 Electron 里同时反映"窗口被隐藏/最小化"与
    "窗口被完全遮挡"两种情况，正是 rAF 停摆的判据。
    （不做"偷偷 detach 再 attach transition 组件"的花活：改一个 ref
     让模板自己换分支，Vue 会正确地卸载 / 挂载。）
  */
  skipSwap.value = document.visibilityState !== 'visible';
}

/* 兜底间隔：服务状态以事件驱动为主，这里只防"事件丢失导致状态陈旧" */
const FALLBACK_POLL_MS = 8000;

function startFallbackPoll() {
  stopFallbackPoll();
  servicePollTimer = window.setInterval(() => {
    /* 窗口不可见时不打 IPC，省电且避免无意义唤醒 */
    if (document.hidden) return;
    refreshServices();
  }, FALLBACK_POLL_MS);
}

function stopFallbackPoll() {
  if (servicePollTimer !== null) {
    window.clearInterval(servicePollTimer);
    servicePollTimer = null;
  }
}

/*
  可见性变化：真的把定时器停掉/起回来。
  原来只是在回调里 `if (document.hidden) return;` ——
  定时器依然每 8 秒唤醒一次渲染进程（Electron 里就是每 8 秒一次真实的
  定时器与主进程调度机会），注释却写着"暂停/省电"，
  属于**注释描述了一个并未实现的行为**。
*/
function onVisibilityChange() {
  /*
    换页过渡的保命开关：必须**先**同步它，再管轮询。
    窗口重新可见时，上一次"卡在离场"的过渡会在 rAF 恢复后自行收尾
    （实测：窗口被聚焦的瞬间旧 .panel 才被换掉），所以这里不需要补救动作，
    只需要保证"不可见期间的每一次换页都不过渡、也就不会卡"。
  */
  syncSkipSwap();

  if (document.hidden) {
    stopFallbackPoll();
    return;
  }
  /* 重新可见：立刻同步一次，并恢复兜底轮询 */
  refreshServices();
  startFallbackPoll();
}

/*
  属于本组件自己的订阅作用域。
  此前这里的清理走 disposeAllSubscriptions()（模块级全局数组），
  会把 TerminalPanel / InstallerPanel 等**其他组件**的订阅也一并拆掉。
  改用作用域后，dispose() 只影响本组件登记的那些。
*/
const subs = createSubscriptionScope();

/*
  卸载标记。
  本 hook 里有 5 个 await：期间组件可能已经卸载，此时
  清理函数早已跑过（servicePollTimer 当时还是 null，clearInterval 落空），
  而后面的代码仍会继续执行，把 8 秒定时器与 visibilitychange 监听
  **永久**挂上去 —— 一个已经不存在的组件仍在后台每 8 秒打 IPC。
*/
let alive = true;

onMounted(async () => {
  alive = true;
  await loadAppInfo();
  await loadSettings();
  await loadPaths();
  await loadTerminalCapability();
  await refreshServices();

  /* 卸载早于这里就不要再挂任何东西 */
  if (!alive) return;

  /* 日志实时通道（唯一来源，不再轮询） */
  subs.add(subscribeServiceLogs());

  /*
    外壳自己的两件事，也必须走同一个订阅作用域：
      1) 主题（可能被主进程/快捷键改）→ 跟着换 data-theme
      2) 窗口最大化状态 → 标题栏中间的按钮换图标
    都登记进 subs，卸载时一次性取消，不留监听器泄漏。
  */
  subs.add(shell?.onThemeChanged?.(syncThemeAttr));
  subs.add(shell?.onWindowState?.(onWindowState));

  /* 启动时先对齐主题与最大化状态（用户上次的选择 / 上次的窗口状态） */
  await initTheme();
  await refreshMaximized();

  /*
    新手引导：首次启动自动展开。
    规则刻意保守 —— 用户主动关过、或已全部完成，就不再自动弹，
    只在主页留一个「继续新手引导」入口。
    总步数由步骤定义本身决定，这样以后加减步骤不用改两处。
  */
  initOnboarding(buildSteps({}).length);

  /* 服务生命周期事件 → 立即刷新状态并提示用户 */
  subs.add(subscribeServiceEvents({
    onExit: (p) => {
      refreshServices();
      if (p?.abnormal) {
        /*
          系统通知已由主进程在事件产生的源头发出（services/index.js）。
          这里只负责界面内的持久告警与 toast，不重复发通知 ——
          否则用户会在 Windows 通知中心看到两条一样的提醒。
        */
        pushAlert({
          level: 'error',
          title: `${svcName(p.key)} 异常退出`,
          /*
            展示顺序：主进程给的人话解释 > 原始退出码 > 兜底文案。
            主进程的 exit-codes.js 会把 Windows 的 NTSTATUS 翻译成中文原因
            （例如 -1073741510 → "控制台会话被中断"），并已把这类
            "用户主动中断"从 abnormal 里排除掉，能走到这里的都是真异常。
            code 可能为 null：看门狗发现进程消失时并不知道退出码
            （process.js 明确发 code: null），直接拼 `${p.code}`
            会显示"退出码 null"，比不显示更让人困惑。
          */
          text:
            p.message ||
            p.display ||
            (p.code === null || p.code === undefined ? '进程已意外终止' : `退出码 ${p.code}`)
        });
        toast(
          `${svcName(p.key)} 异常退出`,
          'error',
          4000
        );
      }
    },
    onStarted: (p) => {
      refreshServices();
      /*
        启动结果有三种，而这里以前只有一句绿色「已启动」：
          · ok 且 ready    → 真的就绪（端口开了，或进程稳定存活超过判定窗口）
          · ok 但 degraded → 进程活着，但端口在判定窗口内没开（还在装依赖/建库）
          · ok === false   → 没起来（秒退、版本闸门拒绝、上一次启动还没结束…）
        把后两种也说成绿色成功，就是在给用户假确认：他会以为服务好了、
        转头去连它然后失败，却不知道界面刚才骗了他。
      */
      if (p?.ok === false) {
        /* 被主动停止收尾的启动不算失败，停止流程自己会提示 */
        if (p.stopped) return;
        toast(`${svcName(p.key)} 启动失败：${p.message || '未知原因'}`, 'error', 5000);
        return;
      }
      if (p?.degraded || (p?.ready === false && p?.readyVia === 'timeout')) {
        toast(`${svcName(p.key)} 已启动，但端口未就绪（仍在后台等待）`, 'warn', 5000);
        return;
      }
      toast(`${svcName(p.key)} 已启动`, 'success');
    },
    /* 超时之后端口终于开了：把中间态补成"已就绪" */
    onReady: (p) => {
      refreshServices();
      toast(`${svcName(p.key)} 已就绪（端口 ${p?.port ?? ''}）`, 'success');
    },
    onStopped: (p) => {
      refreshServices();
      /*
        process.js:623 发出的是 { key, pid, method } —— **没有** intentional 字段，
        所以原来的 `if (!p?.intentional)` 守卫恒为真，用户主动停止也会弹提示。
        改用 method 判断：'skipped' 表示进程本就不存在，不必再提示一次。
      */
      if (p?.method !== 'skipped') toast(`${svcName(p.key)} 已停止`, 'info');
    },
    onRestartScheduled: (p) => {
      refreshServices();
      toast(
        `${svcName(p.key)} 将在 ${Math.round((p.delayMs || 0) / 1000)} 秒后自动重启（第 ${p.attempt} 次）`,
        'warn',
        4000
      );
    },
    onRestartGiveup: (p) => {
      refreshServices();
      /*
        字段名是 attempts（复数）—— process.js:544-549。
        此处原读 p.attempt，导致告警永远显示"连续失败 undefined 次"，
        并且丢弃了主进程已经准备好的 message。
      */
      const times = p?.attempts ?? p?.attempt ?? '?';
      pushAlert({
        level: 'error',
        title: `${svcName(p.key)} 自动重启已放弃`,
        text: p?.message || `连续失败 ${times} 次，请检查日志后手动启动。`
      });
      toast(`${svcName(p.key)} 连续启动失败，已放弃自动重启`, 'error', 6000);
    }
  }));

  /*
    守卫**紧贴订阅点**。
    ──────────────────────────────────────────────────────────────────
    从上面那次判断到这里，中间没有 await，所以实际上不存在
    "订阅挂上之后没人清理"的窗口（审计报告把这段判成泄漏窗口，实测不成立：
    JS 单线程，没有让出点，卸载插不进来；且 onBeforeUnmount 第一件事就是
    alive=false + subs.dispose()）。

    但风险图景是真的：这段区间**必须保持无 await**，而以后往这里加一次
    数据加载（很容易发生）就会引入真正的泄漏 —— 已卸载组件的回调会被
    每个 service:* 事件驱动，每次打 6 个 IPC。
    所以把守卫放在离订阅最近的位置，并在下面注释里写清前置条件，
    让后来者改到这里时立刻看到约束。
  */
  if (!alive) {
    stopFallbackPoll();
    subs.dispose();
    return;
  }

  startFallbackPoll();
  /*
    先按**当前**可见性定一次换页过渡的开关，再挂监听。
    少了这一行：若应用是被"隐藏到托盘 / 最小化"后启动的（或者启动后才
    变可见），skipSwap 会一直停在初始的 false，第一次换页照样会卡
    —— 而 onVisibilityChange 只有"变化"才会被调用，不变化就永远不修正。
  */
  syncSkipSwap();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  /*
    必须先置 alive=false：若卸载发生在 onMounted 的某个 await 期间，
    后面的代码看到这个标记就会放弃挂载，而不是挂上之后没人清理。
  */
  alive = false;
  /* 必须清理：定时器 + 事件监听 + 本组件自己的订阅 */
  stopFallbackPoll();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  subs.dispose();
});

/* 供模板/调试使用 */
defineExpose({ store });
</script>

<style scoped>
/* ============================================================================
 *  外壳（v4 规格 §1.2 背景 + §1.1 标题栏）
 * ==========================================================================
 *  颜色一律走 theme.css 的 token —— 本文件**不**自己定义深浅两套色值：
 *    · 渐变底    --app-gradient（浅 160deg #f4f8ff→#eaf2ff→#e4eeff / 深近黑）
 *    · 插画浓度  --hero-opacity（浅 .5 / 深 .28）
 *    · 产品名蓝  --titlebar-ink（浅 = --accent #2b6cff / 深 = #5b8dff）
 *    · 窗口字形  --titlebar-glyph（= --text-3）
 *    · 标题栏高  --titlebar-h（44px）
 *  这样"深色"只需要在 theme.css 的 [data-theme='dark'] 里覆盖一次，
 *  组件侧不会各写一份而漂移（上一版的 P0 缺陷就是在 .vue 里写死颜色）。
 * ==========================================================================*/
.shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  /* 极淡蓝白渐变底（不是纯色，也不是玻璃拟态） */
  background: var(--app-gradient);
}

/*
  左下角大插画（v4 §1.2）。
  ──────────────────────────────────────────────────────────────────────
  目标图：约 520px 宽、被窗口左/下边缘裁掉、压在卡片下面、低饱和。
  · pointer-events: none —— 它铺在内容层下面，绝不能挡住按钮；
  · z-index: 0，内容层 .body 是 1，所以它永远在文字后面；
  · opacity 走 --hero-opacity（深浅两套由 theme.css 给），组件里不写死；
  · 用**负偏移**让左/下两边被 .shell 的 overflow:hidden 裁掉 ——
    目标图里那"半张脸探出来"的观感就是这么来的（不是把图缩小放全）；
  · 它**故意**不与内容互斥：v4 的内容区由页面自己排版（主页那张卡是居中
    的 745px），窗口宽时两者不会打架；窄窗口下它被裁在左下角，
    挡住的也只是空白，而且不吃点击。
  ⚠️ 换成自己的插画：把图放到仓库根 resources/hero.png，只改 <script> 里
     那一行 import 即可（模板与这里都不用动）。
*/
.hero-art {
  position: absolute;
  left: -60px;
  bottom: -40px;
  z-index: 0;
  width: 480px;
  height: 480px;
  object-fit: contain;
  opacity: var(--hero-opacity);
  pointer-events: none;
  /* 不被选中、不参与 tab 序列：纯装饰 */
  user-select: none;
}

/* ============================================================================
 *  ① 标题栏（v4 §1.1，尺寸/留白照 dsh-x-reference.png）
 * ==========================================================================*/
.titlebar {
  /*
    §12：chrome 是"浮在内容之上的一层"，不是占掉固定高度的实心条。
    改成 fixed 之后它脱离 flex 流，.body 自然拿到整窗高度，
    内容于是在它下面滚过 —— 背面的半透明材质才有东西可透。
  */
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 3;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  border-bottom: 1px solid var(--line);
  box-shadow: 0 1px 0 rgba(16, 24, 40, 0.02);
  height: var(--titlebar-h);
  /* 右边只留 8px：三个窗口键要贴到窗口最右侧（目标图就是这样） */
  padding: 0 var(--sp-2) 0 var(--sp-4);
  /* 目标图这条标题栏没有分隔线、也没有独立底色，它和页面同一层渐变 ——
     所以这里刻意不给 border-bottom / background，只留内容 */
  /* 整条可拖动；下面的按钮逐个 no-drag */
  -webkit-app-region: drag;
  user-select: none;
}

/* 左侧：产品名 + 版本号（纯文字，无方形图标 —— 见模板注释） */
.brand {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
  /*
    不能被右侧控件的 flex 布局压缩掉（长产品名要能完整显示）。
    ⚠️ 本轮从 0 1 auto 改成 **0 0 auto**（收缩因子 1 → 0），原因：
    标题栏里现在有三团内容（品牌 / 菜单栏 / 右端工具），一旦空间不够，
    flex 会按比例同时压缩"品牌"和"菜单栏"。而 .brand-name 是 nowrap、
    .brand 又带 min-width:0，它被压缩时文字**不会截断**，只会溢出到菜单栏
    底下叠着显示 —— 那是"字压在字上"的硬伤。改成不收缩后，被压的只有
    菜单栏（它自己 overflow:hidden，裁的是自己），品牌永远完整。
  */
  flex: 0 0 auto;
}

.brand-name {
  /*
    品牌名走正文色而不是强调色：强调色在标题栏里已经被"当前页"占用，
    品牌再来一份就成了两个重点（MS 颜色规范：强调色用于强调重要元素与交互状态，且要克制）。
    14px/600：达到规范里"标题 14px Semibold"的可读下限（12px Regular 是绝对下限），
    层级由字重而不是放大来建立 —— 导航项是 13px/500，两者同一视觉档。
  */
  font-size: 14px;
  font-weight: 600;
  letter-spacing: var(--ls-body);
  line-height: 1.2;
  color: var(--ink);
  white-space: nowrap;
}

.brand-ver {
  /* 版本号只作附注：12px（规范记录的可读下限）/ --text-4 / 等宽数字 */
  font-size: 12px;
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ============================================================================
 *  ② 页面菜单栏（标题栏左侧，横向；单击直接切页）
 * ==========================================================================
 *  形态规格（用户逐条给的，已定稿）：
 *    · 每项高 28px、圆角 8px、字号 13px、左右内边距 10px、项间距 2~4px；
 *    · 当前页 = 淡蓝底 + 蓝字；hover 用现有浅底 token；未选中为灰字；
 *    · 颜色**一律走 token**（定义在 theme.css），组件里不写死任何色值 ——
 *      这样深浅两套主题各自成立，不会出现"深色下白底黑字的块"。
 *
 *  ⚠️ 为什么"淡蓝底 + 蓝字"用的是 --accent-tint / --accent-ink 而不是
 *     用户口述里的 rgba(43,108,255,.10) / #2b6cff：
 *     那两个字面量是**旧版调色板**（v3 的 #2b6cff 实测白底 4.48:1、差 0.02
 *     不达 AA，已在 v5 换成 #2760e8）。token 就是那两个字的"修正后的同一支蓝"，
 *     而且要按主题翻转（深色下 --accent-ink 是 #7ba4ff）—— 写死字面量等于
 *     把深色主题锁死成浅色值，所以这里必须用 token。
 * ==========================================================================*/
.menubar {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  /* 项间距 3px：落在用户给的 2~4px 区间内，也是这一排"同一节奏"的手感 */
  gap: 0.25rem;
  /*
    · 紧跟品牌：标题栏的 gap 是 12px，这里只再补 4px = 16px，
      比"中间留白"明显更近，读起来是"名字后面就是菜单"；
    · flex: 0 1 auto + min-width: 0 —— 空间不够时**先压自己**：
      .brand 与 .win-tools 都是 flex:none，不会跟着变；
    · overflow: hidden —— 兜底，极端窄窗口下裁掉的是菜单栏自己的尾部，
      绝不会盖到右端的帮助/齿轮/最小化/最大化/关闭上。
  */
  margin-left: var(--sp-1);
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  /*
    🔴 关键：标题栏整条是 -webkit-app-region: drag，可点区域必须显式 no-drag，
    否则在这一块上按下鼠标会被系统当成"拖动窗口"，切页完全不生效。
    容器与每个条目**都写一遍**是有意的冗余：将来有人重写 .menubar-item 时，
    容器的 no-drag 仍然兜住；反过来只有容器写了、条目被移出容器也不会失效。
  */
  -webkit-app-region: no-drag;
}

.menubar-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 0.625rem;
  border: none;
  /* 8px 是用户给的值。theme.css 里没有 8px 这一档圆角 token
     （最近的是 --r-menu 6 / --r-ctl 10），而且圆角不是颜色，
     不受"颜色必须走 token"的约束，所以这里直接写 8px。 */
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  font-family: inherit;
  font-size: 13px;
  /* 字重固定 500（不给 .active 单独加粗）：否则切页时该条目宽度会变，
     整条菜单栏跟着抖一下（六个条目都会左右挪位）。 */
  font-weight: var(--fw-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.menubar-item:hover {
  /* 浅底 token：浅色下是 5% 黑、深色下是 6% 白，两套主题都成立 */
  background: var(--fill-hover);
  color: var(--text-1);
}

.menubar-item:active {
  background: var(--fill-active);
}

/*
  当前所在页：淡蓝底 + 蓝字（与齿轮弹窗里 .gear-item.active 同一套语义色）。
  · 用 --accent-tint（浅色 rgba(39,96,232,.10) / 深色 rgba(91,141,255,.16)）
    而不是实底强调色：菜单栏在标题栏里，实心蓝块会在这一排里太抢眼，
    而"当前页"是**状态**、不是主行动按钮。
  · 蓝字用 --accent-ink（浅 var(--accent-hover) / 深 #7ba4ff），它在淡蓝底上实测过对比度。
*/
.menubar-item.active {
  background: var(--accent-tint);
  color: var(--accent-ink);
}

/* 键盘可达性：全局 :focus-visible 的焦点环（theme.css 的 --focus-ring）
   已经覆盖，这里不再自写 outline —— 免得两个环叠在一起。 */

/* ============================================================================
 *  ②′ 旧「分段导航」的样式：**已整体删除**
 * ==========================================================================
 *  模板里那块 <nav v-if="false" class="nav"> 与它绑定的脚本
 *  （primaryNav / moreNav / moreActive / toggleMore / PRIMARY_LABELS /
 *   MORE_PATHS / MORE_LABELS / FALLBACK_ICON）已一并删除，理由：
 *    · 它恒定不渲染（v-if="false"），是**不可达**的界面；
 *    · 它引用的 onTabDblClick 一度是"双击日志弹出来源胶囊"的**唯一**绑定点
 *      —— 死块把整条功能一起带成了不可达，而门禁只 grep 源码字符串，
 *      于是给死代码发了合格证（scripts/verify-shell.mjs 第 ④ 段）。
 *      现在这个绑定落在真正渲染的 .menubar-item 上（见模板 ②）。
 *    · 删掉样式而不是留着"回滚路径"：留着没有任何消费者，只会让
 *      "CSS 里还有这条规则吗"变成不能用"类名是否出现在模板里"判定的问题。
 *  被删掉的选择器：.nav / .nav-item / .nav-item:hover / .nav-item.active /
 *  .nav-ico / .nav-txt / .nav-focus / .nav-more / .nav-more.active .glyph /
 *  .more-wrap / .more-menu / .more-item / .more-item:hover / .more-item.active /
 *  .more-action / .more-action:hover / .more-txt / .mi-ico。
 *  （.glyph 本身**不能**删：帮助 pill / 齿轮 / 三个窗口键都在用它。）
 * ==========================================================================*/

/*
  标题栏里的小箭头 / 图标统一尺寸与线宽（与 IconGlyph 的观感对齐）。
  ⚠️ 这个 .glyph **本身就是 <svg> 元素**（模板里所有字形都写成了真实
     <svg class="glyph">），所以尺寸/描边必须能作用在元素自己身上 ——
     上一版是 `<span class="glyph" v-html="裸 path">`，那种写法下：
       · span 不是 SVG 命名空间，<path> 什么都不画；
       · 只写 `.glyph :deep(svg)`（要求内部还有一个 svg）也永远不匹配。
     两条叠加 = 三个窗口键彻底隐形。下面这段因此把两件事都写实。
*/
.glyph {
  display: block;
  width: 14px;
  height: 14px;
  flex: none;
  /* SVG 元素自己就是绘制层：颜色/描边都从按钮继承（单色细线字形） */
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ============================================================================
 *  右侧工具区（v4 §1.1：帮助 pill → 齿轮 → 三个窗口键）
 * ==========================================================================*/
.win-tools {
  display: flex;
  align-items: center;
  /*
   * 间距走 --sp-2（8px），不走 --sp-1（4px）。
   * ──────────────────────────────────────────────────────────────────────
   * 实测的问题：帮助 pill 右缘 1057、齿轮左缘 1061 —— 两颗**同类**的
   * 淡蓝控件只隔 4px，看起来像粘在一起；而同一排里
   *   · 齿轮 → 窗口键   = 32px（.wc-sep 的 1px + 左右各 14px margin）
   *   · 窗口键 → 窗口键 = 16px（.icon-btn + .icon-btn 的 margin-left）
   * 也就是说这一排同时存在 4 / 16 / 32 三种间距，4px 那一处是唯一的"紧贴"。
   *
   * 为什么不直接删掉 gap、改成给 .help-pill 单独加 margin：
   *   那会动到"左键选择器 + 元素自身 margin"两处，将来再插控件容易漏。
   *   统一调 gap 是改动面最小、也最符合"同一排用同一个节奏"的做法。
   * 为什么是 8px 而不是 16px：这一排从右往左是
   *   帮助 pill(72) + 8 + 齿轮(34) + 32 + 三键(36*3 + 16*2) ，
   * 8px 既让两颗蓝控件分开，又比三键之间更紧凑 —— 符合
   * "越靠右的同类键越紧凑、两组之间留白更大"的层次。
   */
  gap: var(--sp-2);
  /*
    · flex: none   —— 绝不被左边的品牌/内容压扁（压扁过一次就是"按钮不见了"）；
    · margin-left: auto —— 死死钉在标题栏最右侧。
      两条同时留着是有意的：即使将来标题栏里再加第三团内容，
      .win-tools 也仍然靠右，不会因为 space-between 的分法变化而跑到中间。
  */
  flex: none;
  margin-left: auto;
  -webkit-app-region: no-drag;
}

/*
  齿轮（34×34、圆角 10、淡蓝底、蓝字形）。
  目标图里它与右边三个窗口键之间隔着约 28px（由 .wc-sep 的左右外边距给出）。
*/
.gear-wrap {
  display: flex;
  align-items: center;
  flex: none;
  -webkit-app-region: no-drag;
}

.gear-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: var(--accent-tint-soft);
  color: var(--accent-ink);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.gear-btn:hover,
.gear-btn[aria-expanded='true'] {
  background: var(--accent-tint-strong);
}

.gear-btn:active {
  background: var(--accent-tint-strong);
}

/* 齿轮 16px、线宽略细（14px 的窗口字形在这颗方块里会显得偏粗） */
.gear-btn .glyph {
  width: 16px;
  height: 16px;
  stroke-width: 1.5;
}

/* 帮助 pill：★ 形 + 文字，都是蓝的；淡蓝底、高 34、圆角 17（目标图的 Star 按钮） */
.help-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: 34px;
  padding: 0 0.75rem;
  border: none;
  border-radius: var(--r-pill);
  background: var(--accent-tint-soft);
  color: var(--accent-ink);
  font-family: inherit;
  font-size: 13px;
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.help-pill:hover {
  background: var(--accent-tint-strong);
}

/* pill 里的星形 14px（与文字同高，看着才像一颗"图标 + 文字"的胶囊） */
.help-pill .glyph {
  width: 14px;
  height: 14px;
}

.help-txt {
  white-space: nowrap;
}

/*
  进度徽标：「帮助」pill 后面那个小方块（未开始 / 2/10 / ✓）。
  ──────────────────────────────────────────────────────────────────────
  它此前写着"入口暂时关闭、代码保留"，实现方式是 `display: none` ——
  但模板里的 `<span class="guide-badge">` 从来没有 v-if="false"：
  也就是说这是**代码保留 + 样式隐藏**，比死块更隐蔽（grep 死块查不到它），
  而它承载的信息是"这个新手引导做到第几步了"。
  本轮的规矩是"要么复活、要么连死代码一起删"，所以这里复活它：
  删掉那一行 display:none，徽标按它原本的形态回来（未开始 / 分数 / ✓）。
  模板、guideDone / guideTip 一行没动。
*/
.guide-badge {
  letter-spacing: var(--ls-2xs);
  min-width: 26px;
  height: 16px;
  padding: 0 0.25rem;
  border-radius: var(--r-menu);
  background: var(--surface-1);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: var(--fw-bold);
  line-height: 16px;
  text-align: center;
}

.guide-badge.done {
  min-width: 16px;
  background: var(--ok-tint);
  color: var(--ok-ink);
}

/*
  窗口控件（最小化 / 最大化 / 关闭）。
  目标图：细线单色字形、无背景无边框、中心间距约 48px（36px 宽 + 12px 间距），
  hover 出浅灰底（补到 44px 宽、圆角 6 的完整矩形，Windows 的习惯观感），
  关闭键 hover 红底白字。色值一律走 token。
*/
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--titlebar-glyph);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.icon-btn + .icon-btn {
  margin-left: 0.75rem;
}

.icon-btn:hover {
  background: var(--fill-hover);
  color: var(--text-1);
}

.icon-btn:active {
  background: var(--fill-active);
}

/* 关闭：hover 红底白字（Windows 习惯；色值走 theme.css 的专用 token） */
.wc-close:hover {
  background: var(--close-hover-bg);
  color: var(--close-hover-ink);
}

/* 齿轮与三个窗口键之间那约 28px 留白（目标图 §1.1 第 2 条） */
.wc-sep {
  width: 1px;
  height: 16px;
  /*
    分隔线本身几乎看不见（--line 是 6% 黑），它在这里的作用是"占位"：
    左右各 14px = 齿轮与最小化键之间约 28px 的呼吸。
    这么做而不是用 margin，是因为将来把上面那个 v-if="false" 的主题按钮
    放回来时，它会自动分到同一份间距，不用再调数值。
  */
  margin: 0 0.875rem;
  background: var(--line);
}

/* ============================================================================
 *  ③ 齿轮面板（Teleport 到 body；v3 分段导航的入口都搬进来了）
 * ==========================================================================*/
.gear-menu {
  position: fixed;
  z-index: 60;
  min-width: 168px;
  padding: 0.375rem;
  border-radius: var(--r-ctl);
  background: var(--surface-1);
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow-2);
}

.gear-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  height: 34px;
  padding: 0 0.625rem;
  border: none;
  border-radius: var(--r-menu);
  background: transparent;
  color: var(--text-2);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.gear-item:hover {
  background: var(--fill-hover);
  color: var(--text-1);
}

/* 当前停留的页面：淡蓝底 + 蓝字（和 v3「更多」下拉的选中态完全一致） */
.gear-item.active {
  color: var(--accent-ink);
  background: var(--accent-tint);
}

/*
  动作项（隐藏到托盘）与页面项之间用细分隔线分开：
  它点下去窗口会消失、不跳页，混在一起会被当成"又一个页面"。
*/
.gear-action {
  margin-top: 0.375rem;
  padding-top: 0.375rem;
  border-top: 1px solid var(--line);
  border-radius: 0 0 var(--r-menu) var(--r-menu);
  height: 38px;
  color: var(--text-3);
}

.gear-action:hover {
  color: var(--text-1);
}

.gear-item .gi-ico {
  width: 14px;
  height: 14px;
  flex: none;
  font-size: 13px;
  color: currentColor;
}

/* ============================================================================
 *  ④ 内容区：铺满 + 独立滚动（v4 §1.3）
 * --------------------------------------------------------------------------
 *  v3 这里把每个页面都压成"居中 640px 窄列"，结果是所有页面长得一样、
 *  首页那张卡也被挤在中间一条缝里。v4 改成"容器铺满、由页面自己排版"：
 *  主页自己会把那张 745px 的卡居中，日志页继续铺满。
 * ==========================================================================*/
.body {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0;
  /*
    常驻滚动条槽。
    ──────────────────────────────────────────────────────────────────────
    🔴 实测的"切标签整块横向跳 5px"：同一页里内容够长的那一档会挂出
    10px 的经典滚动条，内容窄了 10px，而设置页整列是 margin:0 auto 居中的
    —— 于是卡片左边从 224 变成 219（右边从 1056 变成 1051），切标签时整页
    横向抖一下。设置页的六个标签正好是"有的溢出、有的不溢出"。
    保留槽位后无论有没有滚动条，clientWidth 都不变，卡片 x 恒定。
    ⚠️ 这条只在**经典**滚动条下有意义（overlay 滚动条不占位、也无需槽位），
      所以它是纯增量：本来就不占位的环境行为完全不变。
    ⚠️ .body-full（日志页 meta.full）自己 overflow:hidden，滚动条与槽位都由
      页面内部处理，这里给它单独复位，免得日志区左边多出一条 10px 空槽。
  */
  scrollbar-gutter: stable;
}

/*
  铺满模式（路由 meta.full，目前只有日志页）。
  关掉外壳自己的滚动条：日志页要"从标题栏底下铺到窗口底部"，
  而它内部本来就有一个滚动区 —— 外壳再滚一次就是两条滚动条打架。
  ⚠️ 这里不能用 padding: 0 就完事：行内样式可能还在设 padding-bottom
     （告警托盘要给内容留位置），行内优先级更高，所以那条会继续生效 ——
     这正是想要的：有告警时日志区自动让出底部空间，托盘不会盖住日志。
*/
.body-full {
  padding: 0;
  overflow: hidden;
  /* 见 .body 的说明：铺满页不滚动，槽位只会平白吃掉 10px 宽 */
  scrollbar-gutter: auto;
}

/* 「双击日志标签」弹出的服务切换胶囊（Teleport 到 body） */
.log-menu {
  position: fixed;
  z-index: 70;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: var(--r-ctl);
  background: var(--surface-1);
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow-2);
}

.lm-item {
  letter-spacing: var(--ls-sm);
  border: 0;
  cursor: pointer;
  border-radius: var(--r-menu);
  padding: 0.25rem 0.75rem;
  font-size: 12px;
  font-weight: var(--fw-medium);
  font-family: inherit;
  color: var(--text-3);
  background: transparent;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.lm-item:hover {
  background: var(--fill-hover);
  color: var(--text-1);
}

.lm-item.active {
  background: var(--accent);
  /*
    实底强调色上的文字走 --on-accent（不是写死 #fff）：
    浅色主题下它就是白字（对 #2b6cff 4.48:1），深色主题下是深墨字
    （对提亮后的 #5b8dff 5.27:1）—— theme.css 里已经按主题算好了对比度。
    写死 #fff 的话，深色主题下这颗选中胶囊会掉到 3.13:1（不达 AA）。
  */
  color: var(--on-accent);
}

/* 换页过渡：短、无循环动画 */
.swap-enter-active,
.swap-leave-active {
  transition: opacity var(--dur-base) var(--ease), transform var(--dur-base) var(--ease);
  /* §11：运动临近时才提示合成器，平时不占用图层 */
  will-change: opacity, transform;
}

/*
  §7 镜像 / §8 方向提示：后退的位移与曲线都取反。
  前进 = 新页自下方来、旧页向上离场；后退 = 新页自上方来、旧页向下离场。
  曲线取反向控制点（cubic-bezier(.2,.8,.2,1) 的逆是 (.8,0,.8,.2)），
  这样"回程"和"去程"是同一条路径的两个方向，不会一个急一个缓。
*/
.swap-back-enter-active,
.swap-back-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard-in), transform var(--dur-base) var(--ease-standard-in);
  will-change: opacity, transform;
}

.swap-back-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.swap-back-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ============================================================================
 *  告警区（持久告警，与 toast 互补）
 * ==========================================================================*/
.alert-tray {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 40;
  width: min(400px, calc(100% - 36px));
  max-height: 46vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--r-card);
  background: var(--surface-1);
  border: 1px solid var(--err-line-strong);
  box-shadow: var(--shadow-2);
}

.at-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--line);
  background: var(--err-tint-soft);
}

.at-title {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 12px;
  font-weight: var(--fw-bold);
  color: var(--err-ink-strong);
}

.at-clear {
  letter-spacing: var(--ls-sm);
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
  padding: 0.125rem 0.375rem;
  border-radius: var(--r-menu);
}

.at-clear:hover {
  background: var(--fill-hover);
  color: var(--text-1);
}

.at-list {
  list-style: none;
  margin: 0;
  padding: 0.375rem;
  overflow-y: auto;
}

.at-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem;
  border-radius: var(--r-ctl);
  background: var(--fill-hover);
  margin-bottom: 0.25rem;
}

.at-item:last-child {
  margin-bottom: 0;
}

.at-item.error .at-ico {
  color: var(--err-ink-strong);
}

.at-ico {
  flex: none;
  margin-top: 0.125rem;
  font-size: 13px;
  color: var(--text-3);
}

.at-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.at-item-title {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  font-weight: var(--fw-medium);
  color: var(--text-1);
  word-break: break-word;
}

.at-count {
  letter-spacing: var(--ls-sm);
  font-style: normal;
  font-size: 12px;
  font-weight: var(--fw-bold);
  color: var(--err-ink-strong);
  background: var(--err-tint);
  border-radius: var(--r-menu);
  padding: 0.125rem 0.375rem;
  margin-left: 0.25rem;
}

.at-text {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--text-3);
  word-break: break-word;
}

.at-close {
  letter-spacing: var(--ls-sm);
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-4);
  cursor: pointer;
  font-size: 12px;
  padding: 0.125rem;
  border-radius: var(--r-menu);
}

.at-close:hover {
  background: var(--fill-hover);
  color: var(--text-1);
}

.alerts-enter-active,
.alerts-leave-active {
  transition: opacity var(--dur-base) var(--ease), transform var(--dur-base) var(--ease);
}

.alerts-enter-from,
.alerts-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* ============================================================================
 *  窄窗口降级
 * ==========================================================================
 *  三条，取舍顺序固定为"先让位给标题栏右边的控件"：
 *    · 菜单栏（本轮新增）：先收紧内边距 —— 但**一个条目都不隐藏**；
 *    · 版本号太长 → 收掉版本号（产品名是识别度最高的，最后才动它）；
 *    · 再窄 → 收掉「帮助」两个字，只留 ★（pin 住 pill 的形态与位置）。
 *  ⚠️ v3 这里还有一条 @media (max-width: 960px) 把左下角插画 opacity 归零，
 *     本轮删掉了：v4 的内容区由页面自己排版（不再强制 640px 居中窄列），
 *     插画压在左下角也只与空白重叠；而且目标图里那半张脸本身就是
 *     "被窗口边缘裁掉"的观感，窄窗口下更该保留（它不吃点击、不挡按钮）。
 * ==========================================================================*/

/*
  菜单栏在窄窗口下**只收紧、不隐藏**。
  ──────────────────────────────────────────────────────────────────────
  实测（默认 1280 窗口、浅色）：品牌 ≈205 + 菜单栏 ≈330 + 右端工具 ≈275
  + 标题栏内边距 24 ≈ 834px，所以窗口最小宽度（constants.js 的
  minWidth = 960）下本来就有富余；这一档把富余再拉大约 29px，
  让"约 900px"这种更苛刻的宽度也**不会进入裁剪状态**。

  ⚠️ 为什么一个条目都不隐藏（虽然需求允许"隐藏次要项"）：
    工具箱在别处没有第二个入口（首页快捷入口只有 设置 / 日志 / 终端），
    藏掉它就等于这个功能从界面上消失 —— 那比"菜单栏挤一点"严重得多。
    真到了连这一档都放不下的宽度，兜底是 .menubar 的 overflow:hidden：
    裁的是菜单栏自己的尾部，右端的帮助 / 齿轮 / 三个窗口键永远完整可点。
*/
@media (max-width: 1100px) {
  .menubar {
    gap: 0.125rem;
  }

  .menubar-item {
    padding: 0 0.5rem;
  }
}

@media (max-width: 900px) {
  .brand-ver {
    display: none;
  }
}

@media (max-width: 820px) {
  .help-txt {
    display: none;
  }
}

/*
  内容区顶部呼吸空间。
  原来 .body 的 padding-top 是 0：分栏条（安装与环境/版本下载）和标签条
  （数据工具/AI 对话/提示词优化）直接贴在标题栏下沿（实测 top=44 = 标题栏底边），
  一点缝都没有，显得"挤在顶上"。这里补 16px。
  用 longhand 写在所有简写之后，只影响 top 一侧，不动左右与底部（bodyStyle 的行内
  padding-bottom 仍然生效）。
*/
.body {
  padding-top: 1rem;
}

/*
  铺满模式（日志页）保持原来的 0：它的设计就是"从标题栏底下铺到窗口底部"，
  多这 16px 会在它顶部露一条缝，和它自己的滚动区打架。
  这是本规则唯一的例外，写在这里免得以后有人以为忘了。
*/
.body-full {
  padding-top: 0;
}

/*
  ============================ 顶部菜单栏（方案 C：分段控件）============================
  形态：「整组收进浅灰槽」+ 可收缩（箭头展开/收起）。
  ⚠️ 选中态**不是**"白底浮起"：本文件 ② 段（.menubar-item.active 那一节）已经
  定死"当前页 = 淡蓝底 + 蓝字（--accent-tint / --accent-ink）"，而且给了理由
  ——菜单栏在标题栏里，实心白/蓝块在这一排里太抢眼，而"当前页"是**状态**、
  不是主行动按钮。原来这段末尾又用 `.menubar > .active{background:#ffffff}`
  把选中态改回白底药丸，等于同一条需求有了两个相反的实现（已删，见下方
  "覆盖层：已收敛"那段）。
  下面这个 .menu-toggle 是**展开/收起箭头**，不是菜单项：它自己一套尺寸，
  不参与 .menubar-item 的 28px 规格。
*/
.menu-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 0.125rem;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background var(--dur-base), color var(--dur-base);
}
.menu-toggle:hover {
  background: var(--fill-hover);
  color: var(--text-1);
}
.menu-toggle-glyph {
  display: grid;
  place-items: center;
  transition: transform var(--dur-base) var(--ease-standard);
}
.menu-toggle.open .menu-toggle-glyph {
  transform: rotate(90deg);
}
.menu-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/*
  ==================== 顶部菜单栏（方案 C）· 覆盖层：已收敛 ====================
  ⚠️ 这里原来堆了**三套**互相覆盖的 .menubar / .menubar > * 规则（方案 C 那版、
  "标签无关版"、以及再下一版），谁生效完全取决于"同特异性看谁写在后面"：
    · `.menubar > .active { background: #ffffff }` (0,1,1)
      压过 :1802 的 `.menubar-item.active { background: var(--accent-tint) }` (0,1,0)
      → 选中项实际渲染成**白底药丸**，与本文件 ② 段开头写的
        "当前页 = 淡蓝底 + 蓝字"和 :166 的注释**直接相反**；
        深色下还要再靠 `#2f3947` 这条硬编码救回来。
    · `.menubar > * { height: 26px }` (0,1,1)
      压过 :1789 的 `.menubar-item { height: 28px }` (0,1,0)
      → 菜单项实际高 26px，而 ② 段规格逐字写的是 28px。
  两处都是"实现与注释相反"，而且都靠硬编码色值（#ffffff / #2f3947 / #8ab0ff /
  #9aa4b5 / #e8ecf3 / #232b36）在救 —— 正是 ② 段那条"组件里不写死任何色值"
  要禁止的东西。

  → 收敛为：**只保留真正生效的那一份语义**，颜色一律走 token：
    · 选中态由 :1802 的 `.menubar-item.active`（+ 基类的 token 色）负责，
      这里不再覆盖它 —— 于是"淡蓝底 + 蓝字"在深浅两套下都成立；
    · 尺寸只由 :1789 `.menubar-item`（高 28px）定义，这里不再压它；
    · 容器底改用 --surface-3 token（浅 #f1f5fb / 深 #292d34），
      深色下不再需要 `#232b36` 那条硬编码。
  被删掉的（它们全部**已被上面几条覆盖**，留着只会再次把注释反着实现）：
    .menubar .menu-item / .menubar button / 其 :hover / .on / [aria-current]
    + 对应深色硬编码、.menubar > * / 其 :hover / .on / .active /
    .router-link-active / [aria-current] + 对应深色硬编码。
  （.menu-item / .router-link-active 是"标签无关版"的猜测，当前模板里不存在；
    真实标签是 <button class="menubar-item">，见模板 ②。）
  ⚠️ 若以后菜单项真的换成 <a>/<router-link>，别再把 `.menubar > *` 那套加回来
  —— 给它补一个与 .menubar-item 同级的类名，样式保持单点定义。
*/
.menubar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  margin-left: 0.125rem;
  border: 0;
  border-radius: 12px;
  /* 浅灰槽（"分段控件"的槽底）：浅 #f1f5fb / 深 #292d34 */
  background: var(--surface-3);
}

/*
  ==================== 菜单伸缩动画 ====================
  为什么用 max-width 而不是 width：nav 的宽度由内容决定（6 个按钮 ≈ 360px），
  写死 width 会在换字号/加页时错位；max-width 给一个足够大的上限即可，
  收起时归零 + overflow:hidden + 透明度 + 轻微位移，视觉上就是"从箭头里长出来"。
*/
.menubar {
  max-width: 460px;
  overflow: hidden;
  transform-origin: left center;
}
.menu-slide-enter-active,
.menu-slide-leave-active {
  transition: max-width var(--dur-slow) var(--ease-standard),
    opacity var(--dur-base) ease,
    transform var(--dur-slow) var(--ease-standard),
    margin-left var(--dur-slow) ease,
    padding-left var(--dur-slow) ease,
    padding-right var(--dur-slow) ease;
}
.menu-slide-enter-from,
.menu-slide-leave-to {
  max-width: 0;
  opacity: 0;
  transform: translateX(-10px) scaleX(0.96);
  margin-left: 0;
  padding-left: 0;
  padding-right: 0;
}

/*
  ==================== 内容区四边留边 ====================
  用户："安装麦麦/终端/日志/工具箱 的卡片太靠窗口边框了"。
  根因：.body 只有 padding-top（我上一轮加的），左右与底部是 0 —— 卡片直接顶到窗口边缘。
  这里补 18px 左右 + 20px 底部；顶部仍是 16px（标题栏下留白，上一轮已确认）。
  为什么左右用同一个值：四个页面共用这一个滚动容器，统一才不会出现"某页贴边、某页不贴"。
*/
.body {
  /* 顶部留出标题栏高度：内容仍从栏下开始，但滚动时会从它下面穿过 */
  padding: calc(var(--titlebar-h) + 1rem) 1.125rem 1.25rem;
}
/*
  日志页是铺满模式：顶部必须保持 0（它要从标题栏底下铺到窗口底部），
  但左右照样要给边距，否则日志内容同样贴边。
*/
.body-full {
  padding: 0 1.125rem;
}
</style>
