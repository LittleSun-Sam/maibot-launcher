<template>
  <!--
    ══════════════════════════════════════════════════════════════════════════
    主页（UI v4：完全模仿 docs/reference/dsh-x-reference.png）
    ──────────────────────────────────────────────────────────────────────────
    ⚠️ 本轮（服务启停）对版式的改动 —— 与 v4 规格的**有意偏离**，写在这里备案：
      v4 §2 写的是"主页只留：麦麦的名字 + 状态 + 启动/停止 + 打开 WebUI"，
      于是 SnowLuma 卡与两张工具卡都被 v-if="false" 归档了。
      但产品目标是「用户拿到这个启动器就可以开始部署」，而**部署至少需要两个
      服务**（MaiBot + SnowLuma 协议端）：只能启停其中一个，用户就得先钻进
      设置页/引导流程才能把另一个跑起来 —— 一个点了没反应的按钮做不到的
      事，一个"藏在死块里的按钮"同样做不到。
      所以这里把入口**挂回来**（不是重写）：
        · 主卡仍是第一张（版本 + 麦麦启停 + WebUI，改成 flex 居中，位置不变）；
        · 下面两张卡：SnowLuma 协议端（含启停/重启/WebUI/接线自检/标准输入）、
          快捷操作 + 系统占用（全部启动/全部停止/清理残留 + CPU/内存）。
      三张卡共用同一套 token 与 .home-card 尺寸，没有重新设计页面。
    ══════════════════════════════════════════════════════════════════════════
  -->
  <div class="panel">
    <div class="home-stage">
      <section class="home-card">
        <!-- ① 小灰标签「版本」 -->
        <p class="home-label">版本</p>

        <!-- ② 一行：版本选择框 + 两个方形图标按钮 -->
        <div class="home-row">
          <!--
            版本选择框。外观照目标图抄（高 42 / 圆角 10 / 底 --surface-field /
            细边框 / 13px 灰字 / 右侧 ▾），行为仍然是原来的"点开实例列表"：
            @click="openPicker" + 键盘可达，一行没改。
          -->
          <div
            class="ver-box"
            role="button"
            tabindex="0"
            title="点击选择要运行的麦麦版本"
            @click="openPicker"
            @keydown.enter.prevent="openPicker"
            @keydown.space.prevent="openPicker"
          >
            <span class="ver-text">{{ versionText }}</span>
            <IconGlyph class="ver-caret" name="chev-down" />
          </div>

          <!--
            蓝色方钮 = 启动麦麦；运行时语义变"重新启动"。
            两个分支接的都是**原有**动作：startMaiBot / restartMaiBot
            （它们内部再走 resolvePayload + 原有的 runServiceAction 那套，
            没有新写任何启动逻辑）。
          -->
          <button
            v-if="!running"
            type="button"
            class="ico-btn ico-btn-start"
            title="启动麦麦"
            aria-label="启动麦麦"
            :disabled="!selected || selected.runnable === false"
            @click="startMaiBot"
          >
            <LoadingSpinner v-if="busy === 'maibot'" size="sm" />
            <IconGlyph v-else name="play" />
          </button>
          <button
            v-else
            type="button"
            class="ico-btn ico-btn-start"
            title="重新启动麦麦"
            aria-label="重新启动麦麦"
            @click="restartMaiBot"
          >
            <LoadingSpinner v-if="busy === 'maibot-restart'" size="sm" />
            <IconGlyph v-else name="refresh" />
          </button>

          <!-- 红色方钮 = 停止。未运行时禁用变灰（形态照目标图，颜色走 token） -->
          <button
            type="button"
            class="ico-btn ico-btn-stop"
            :disabled="!running || busy === 'maibot'"
            :title="running ? '停止麦麦' : '麦麦未在运行'"
            :aria-label="running ? '停止麦麦' : '麦麦未在运行'"
            @click="stopMaiBot"
          >
            <IconGlyph name="stop" />
          </button>
        </div>

        <!--
          ③ 底部一行状态。人话，不是术语：
             未运行 →「已停止 · 点左侧按钮启动麦麦」
             运行中 → 可点的 WebUI 地址（蓝色下划线链接，同目标图）
          链接同样接**原有**的 openExternal()，没有新增 IPC。
        -->
        <p class="home-state">
          <template v-if="running">
            <span class="st-txt">运行中 · </span>
            <a
              class="webui-link"
              :href="webuiUrl"
              :title="`在浏览器里打开麦麦 WebUI：${webuiUrl}`"
              @click.prevent="openWebui"
            >{{ webuiUrl }}</a>
          </template>
          <span v-else class="st-txt">
                已停止 · 点左侧按钮启动麦麦<template v-if="!eulaNoticeAck">（首次需先阅读其 EULA）</template>
              </span>
        </p>
      </section>

      <!--
        ══════════════════════════════════════════════════════════════════════
        SnowLuma 协议端：**本轮的第二个启停入口**
        ══════════════════════════════════════════════════════════════════════
        SnowLuma 是独立 Node 程序（自带运行时、自带 WebUI，不注入 QQ），
        现在也是唯一的 QQ 接入路径，所以这里不再有任何"二选一/切换后端"
        的概念 —— 卡片固定出现，用户不会看到一张"取决于某个设置值"时而
        消失的协议端卡片（那种设计会让人以为功能坏了）。

        为什么必须把它的入口挂回来：主卡只启停 MaiBot，而部署要两个服务都在跑。
        这张卡里的每个动作都是**原有实现**（startSnowLuma / stopSnowLuma /
        restartSnowLuma / openSnowLumaWebui / checkSnowlumaWiring / sendStdin），
        一行启动逻辑都没有新建。
        ══════════════════════════════════════════════════════════════════════
      -->
      <PanelCard title="SnowLuma 协议端" desc="独立 Node 程序，自带 WebUI，无需注入 QQ">
        <template #head>
          <PillButton variant="ghost" size="sm" icon="refresh" :loading="refreshing" @click="reload">
            刷新
          </PillButton>
        </template>

        <div class="svc">
          <div class="svc-left">
            <span class="svc-dot" :class="{ on: snowluma.running }" />
            <div class="svc-meta">
              <span class="svc-name">SnowLuma 协议端</span>
              <!--
                运行中给 PID（可核对），未配置给"未配置目录"，其余给真实安装路径。
                绝不用"未运行"当副行 —— 右边的徽标已经写着「已停止」了。
              -->
              <span class="svc-sub" :title="snowlumaSub">{{ snowlumaSub }}</span>
            </div>
          </div>
          <div class="svc-right">
            <StatusBadge :tone="snowlumaBadge.tone" dot>{{ snowlumaBadge.text }}</StatusBadge>
            <!-- 未安装：不给一个点了没反应的按钮，直接给"去安装" -->
            <PillButton
              v-if="snowlumaKnownMissing && !snowluma.running"
              variant="solid"
              size="sm"
              icon="download"
              title="去「设置」页的 SnowLuma 区块下载官方运行时（自带 Node，无需额外装环境）"
              @click="goInstallSnowluma"
            >
              去安装
            </PillButton>
            <template v-else>
              <PillButton
                v-if="!snowluma.running"
                variant="solid"
                size="sm"
                icon="play"
                :loading="busy === 'snowluma'"
                :title="snowlumaProbe?.message || '启动 SnowLuma 协议端'"
                @click="startSnowLuma"
              >
                启动
              </PillButton>
              <PillButton
                v-else
                variant="danger"
                size="sm"
                icon="stop"
                :loading="busy === 'snowluma'"
                @click="stopSnowLuma"
              >
                停止
              </PillButton>
              <PillButton
                v-if="snowluma.running"
                variant="ghost"
                size="sm"
                icon="refresh"
                :loading="busy === 'snowluma-restart'"
                title="重启（先停干净再启动）"
                @click="restartSnowLuma"
              >
                重启
              </PillButton>
            </template>
            <PillButton
              variant="ghost"
              size="sm"
              icon="link"
              :loading="snowlumaWebuiOpening"
              title="在浏览器中打开 SnowLuma WebUI（首次登录、同意协议、配置 OneBot 连接）"
              @click="openSnowLumaWebui"
            >
              WebUI
            </PillButton>
          </div>
        </div>

        <!--
          首次登录凭据。
          必须在界面上露出来：它每次冷启动都会**重新随机生成**，
          而原文只打印一次 —— 用户错过日志就只能删掉 config 重来。
        -->
        <div v-if="snowlumaCred" class="sl-cred">
          <IconGlyph name="copy" :size="14" />
          <span class="sl-cred-txt">
            WebUI 初始账号
            <b>{{ snowlumaCred.user }}</b>
            / 密码
            <b>{{ snowlumaCred.password }}</b>
          </span>
          <PillButton variant="ghost" size="sm" icon="copy" @click="copySnowlumaCred">复制</PillButton>
        </div>

        <!--
          没装 / 扫描到可用的那两种情形分开说。
          这里以前的条件是 `!snowluma.running` —— 那等于把"没在运行"当成"没安装"：
          已经装好只是没启动的用户会看到一句假话，然后去重复下载。
        -->
        <p v-if="!snowluma.running && snowlumaKnownMissing" class="sl-hint">
          没找到可用的 SnowLuma 运行时。到「设置」页的 SnowLuma 区块可以一键下载官方运行时
          （自带 Node，无需额外装环境）。
          <PillButton variant="solid" size="sm" icon="download" @click="goInstallSnowluma">
            去「设置」页安装
          </PillButton>
        </p>
        <p v-else-if="!snowluma.running && snowlumaAdoptable" class="sl-hint">
          扫描发现机器上已有 SnowLuma（最新 v{{ snowlumaAdoptable.version || '版本未知' }}，共
          {{ scannedSnowluma.length }} 份），但还没指定给启动器用。
          <PillButton variant="solid" size="sm" icon="check" @click="adoptSnowluma(snowlumaAdoptable)">
            就用这个
          </PillButton>
        </p>

        <!--
          服务标准输入。
          SnowLuma / MaiBot 在控制台交互时（y/n 确认、需要交互的回答）需要能写入 stdin。
          主进程侧 writeServiceInput 早就实现了（还专门把 stdio 从 ignore 改成 pipe），
          不给入口就等于这条能力不存在。
        -->
        <div v-if="snowluma.running || running" class="stdin-bar">
          <select v-model="stdinTarget" class="stdin-target">
            <option v-if="running" value="maibot">MaiBot</option>
            <option v-if="snowluma.running" value="snowluma">SnowLuma</option>
          </select>
          <TextInput
            v-model="stdinText"
            placeholder="向服务标准输入发送内容（如 y 确认、交互回答）"
            mono
            @keyup.enter="sendStdin"
          />
          <PillButton variant="ghost" size="sm" icon="bolt" @click="sendStdin">发送</PillButton>
        </div>

        <!--
          接线自检 + 操作指引。
          实测 SnowLuma 默认**只开 WebUI（5099）**，OneBot 正向 WS 需要在它自己的
          WebUI 里手动启用、端口也由那边决定 —— 启动器没有可靠的落点替用户写，
          所以这里只做真实探测 + 说清下一步，不写任何文件。
        -->
        <div class="sl-wiring">
          <div class="sl-wiring-head">
            <span class="sl-wiring-title">接线状态</span>
            <PillButton
              variant="ghost"
              size="sm"
              icon="bolt"
              :loading="snowlumaChecking"
              @click="checkSnowlumaWiring"
            >
              检查
            </PillButton>
          </div>

          <template v-if="snowlumaCheck">
            <div class="sl-line">
              <StatusBadge :tone="snowlumaCheck.webui ? 'ok' : 'neutral'" dot>
                WebUI {{ snowlumaCheck.webui ? '已就绪' : '未监听' }}
              </StatusBadge>
              <span class="sl-line-txt">
                {{ store.settings?.service?.snowlumaPorts?.webui || 5099 }} 端口
              </span>
            </div>
            <div class="sl-line">
              <StatusBadge :tone="snowlumaCheck.onebot ? 'ok' : 'warn'" dot>
                OneBot {{ snowlumaCheck.onebot ? '已就绪' : '未开启' }}
              </StatusBadge>
              <span class="sl-line-txt">
                {{ store.settings?.service?.snowlumaPorts?.onebot || 7988 }} 端口
              </span>
            </div>
            <!--
              插件那半边。这条是启动器**真的读了文件系统**得出的结论，
              不是照抄设置里的字符串 —— 装错插件（第三方分支）也能查出来。
            -->
            <div class="sl-line">
              <StatusBadge
                :tone="snowlumaCheck.adapter?.found && !snowlumaCheck.adapter?.nameMismatch ? 'ok' : 'warn'"
                dot
              >
                适配器插件
                {{ !snowlumaCheck.adapter?.found ? '未找到' : snowlumaCheck.adapter?.nameMismatch ? '疑似第三方分支' : '已就位' }}
              </StatusBadge>
              <span class="sl-line-txt">
                {{
                  snowlumaCheck.adapter?.found
                    ? snowlumaCheck.adapter.name
                    : snowlumaCheck.adapter?.expectedDir || 'plugins/MaiBot-SnowLuma-Adapter'
                }}
              </span>
            </div>
            <p v-if="snowlumaCheck.adapter?.reason === 'no-dir'" class="sl-steps">
              还没设置 MaiBot 目录，没法检查适配器插件。先到「设置」页把 MaiBot 目录选好
              （或者用扫描功能找一下），再回来点「检查」。
            </p>
            <p v-else-if="snowlumaCheck.adapter && !snowlumaCheck.adapter.found" class="sl-steps">
              麦麦的 <code>plugins/</code> 下没找到 SnowLuma 适配器。需要装官方那份：
              <br />① 目录名用
              <b>{{ snowlumaCheck.adapter.expectedDir }}</b>
              <br />② 插件目录里必须有 <code>_manifest.json</code>，否则 1.2.x 根本不认它
              <br />③ 装完去 WebUI 的「插件管理」里<b>启用</b>它（默认是禁用的）
              <br /><span class="sl-warn">
                社区里那份 <code>plugins/snowluma-adapter</code>（配置版本 1.0.0）是第三方分支，
                和官方这份不是同一个插件，别混装。
              </span>
            </p>
            <p v-else-if="snowlumaCheck.adapter && snowlumaCheck.adapter.nameMismatch" class="sl-steps sl-warn">
              检测到的是「{{ snowlumaCheck.adapter.name }}」，名字不像官方的
              MaiBot-SnowLuma-Adapter。两者配置版本不同（官方是
              {{ snowlumaCheck.adapter.expectedConfigVersion }}），配置结构也不一样 ——
              装错会导致"接完线连不上，且报错指不到原因"。建议换成官方那份。
            </p>
            <p v-if="!snowlumaCheck.onebot" class="sl-steps">
              OneBot 端口没开，麦麦的适配器就连不上。需要到 SnowLuma 的 WebUI 里：
              <br />① 先同意 EULA 与隐私条款，解锁面板
              <br />② 新建一个
              <b>OneBot 正向 WebSocket</b> 服务器（端口填
              <b>{{ store.settings?.service?.snowlumaPorts?.onebot || 7988 }}</b>）
              <br />③ 在麦麦的插件里启用适配器插件，让它连
              <b>127.0.0.1:{{ store.settings?.service?.snowlumaPorts?.onebot || 7988 }}</b>
              <br /><span class="sl-warn">
                别填成 3001：那是别的 OneBot 实现的常用端口，SnowLuma 默认不开它。
              </span>
            </p>
          </template>
          <!--
            未检查时的说明。
            原来只有一句"点「检查」会真的去连端口" —— 用户不知道会连哪两个端口、
            也不知道会不会动自己的文件（在一个"接线/装插件"的场景里，
            这两点是决定他敢不敢点的主要原因）。这里把端口和"只读"说清楚，
            端口值取自真实设置，不是写死的示例。
          -->
          <p v-else class="sl-steps">
            还没检查过。点「检查」会真实连接下面两个端口，并读取 SnowLuma 目录下的适配器插件：
            <br />① SnowLuma WebUI：<b>{{ store.settings?.service?.snowlumaPorts?.webui || 5099 }}</b>
            <br />② OneBot 正向 WS：<b>{{ store.settings?.service?.snowlumaPorts?.onebot || 7988 }}</b>
            <br />整个过程只读，不会改动任何文件。
          </p>
        </div>
      </PanelCard>

      <!--
        ══════════════════════════════════════════════════════════════════════
        快捷操作 + 系统占用（**挂回来的两张工具卡**）
        ══════════════════════════════════════════════════════════════════════
        它们此前和上面几张卡一样挂在 v-if="false" 上，于是 QuickActions 与
        SystemPerf 两个组件**在界面上完全不可达**（只被死块引用）。
        但「全部启动 / 全部停止 / 清理残留」恰恰是"拿来就能部署"最需要的三个动作，
        CPU/内存占用也是用户判断"麦麦还在正常吃资源、不是卡死"的直接依据 ——
        所以它们是**复活**，不是删除。

        两张卡并排一行：它们都是"一眼扫过"的辅助信息，占满一整行会把
        主卡与协议端卡挤出首屏。窄窗口（<880px）自动竖排。
        ══════════════════════════════════════════════════════════════════════
      -->
      <div class="home-row-cards">
        <PanelCard title="快捷操作" desc="常用动作一键直达">
          <QuickActions />
        </PanelCard>

        <PanelCard title="系统占用" desc="本机 CPU 与内存实时占用">
          <SystemPerf />
        </PanelCard>
      </div>
    </div>



    <!--
      ============ 选择实例：二级弹窗 ============
      由主卡里那个版本选择框（@click="openPicker"）驱动 —— 它是**可达**的：
      点版本框就弹（见下面 EULA 弹窗旁边那段说明，入口不能是"能点却没功能"）。
    -->
    <Transition name="picker" :css="animOk">
      <!--
        v-if="pickerOpen" —— 这个弹窗**必须真的能弹**。
        卡片上那个「版本」框（@click="openPicker"）是切换版本的**唯一入口**，
        它曾经被临时写成 v-if="false"（当时在按"先把入口去掉"收拾版面），
        结果就是"版本框看着像下拉、点下去毫无反应" —— 用户判定为假控件、直接骂人。
        结论：入口可以改位置，但不能出现"能点却没功能"的控件。
      -->
      <!--
        EULA 闸门。三条底线：不预勾、不代点、不把"同意"当默认。
        原文位置直接写出来（本机路径 + 仓库地址），避免依赖任何新的主进程通道。

        无障碍（此前完全缺失，见审计 R-05）：
          · role="dialog" + aria-modal="true" —— 读屏会把焦点范围收进弹窗，
            而不是继续往后念被遮住的卡片；
          · aria-labelledby 指向标题 —— 进入时先念"启动前的提示：请先阅读 MaiBot 的 EULA"，
            否则读屏只说"对话框"，用户不知道该同意什么；
          · Esc 关闭（见 onModalKeydown）—— 键盘用户的主退出路径，
            之前只能 Tab 到「取消」或精准点遮罩。
      -->
      <div
        v-if="eulaOpen"
        class="modal-mask"
        @click.self="eulaOpen = false"
        @keydown="onModalKeydown($event, () => (eulaOpen = false))"
      >
        <div
          ref="eulaModalEl"
          class="modal eula-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="eula-dialog-title"
        >
          <h3 id="eula-dialog-title" class="eula-title">启动前的提示：请先阅读 MaiBot 的 EULA</h3>
          <p class="eula-text">
            MaiBot 有自己的最终用户许可协议（EULA）。<b>它的条款以原文为准</b> ——
            本启动器<b>不复述、不解释、也不代为同意</b>。
            是否同意，请在 MaiBot 自己的流程中由你本人作出。
          </p>
          <ul class="eula-list">
            <li>原文位置：MaiBot 安装目录下的 <code>EULA.md</code>（本机当前实例：<code>{{ selected?.path || '—' }}</code>）</li>
            <li>上游仓库：<code>github.com/Mai-with-u/MaiBot</code></li>
            <li>
              本启动器不是 MaiBot 的许可方，也不与它存在隶属、代理或授权关系；
              本提示<b>不构成</b>你与本启动器之间的任何协议，本启动器<b>不收集、不上传</b>你的任何选择。
            </li>
            <li>不同意就不要启动 —— 你随时可以改用官方方式自行运行麦麦。</li>
          </ul>
          <label class="eula-check">
            <!--
              焦点由 focusModal() 主动移进来（见脚本里的弹窗键盘/焦点段），
              不用 autofocus 属性：原生 autofocus 在元素插入时触发，
              时机早于我们的 nextTick，两条机制会打架，
              而且它无法在关闭时把焦点还回触发按钮。
            -->
            <input v-model="eulaChecked" type="checkbox" />
            <span>我已知悉：需要先阅读 MaiBot 的 EULA，并会在 MaiBot 自己的流程里决定是否同意</span>
          </label>
          <div class="eula-btns">
            <PillButton variant="plain" size="sm" @click="eulaOpen = false">取消</PillButton>
            <!--
              ⚠️ variant 必须是 solid，不能是 primary。
              PillButton 只实现了 solid / ghost / danger / plain 四档（见 PillButton.vue:103-150），
              **没有 .v-primary 这条规则** —— 写 primary 时 class 里多一个 `v-primary`
              但没有任何样式命中，按钮退回 `.pill` 基类（透明底 + 继承色），
              于是"继续启动"和左边的「取消」长得一模一样，
              主操作与次操作无法区分（审计 R-02）。
            -->
            <PillButton variant="solid" size="sm" :disabled="!eulaChecked" @click="ackEulaNoticeAndStart">
              知道了，继续启动
            </PillButton>
          </div>
        </div>
      </div>

      <div
        v-if="pickerOpen"
        class="modal-mask"
        @click.self="closePicker"
        @keydown="onModalKeydown($event, closePicker)"
      >
        <div
          ref="pickerModalEl"
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="picker-dialog-title"
        >
          <header class="m-head">
            <div class="m-head-main">
              <h4 id="picker-dialog-title">选择实例</h4>
              <p class="m-sub">点击一行即可切换要运行的 MaiBot 版本</p>
            </div>
            <PillButton variant="plain" size="sm" icon="close" icon-only title="关闭" @click="closePicker" />
          </header>

          <div v-if="running" class="m-note">运行中的实例需先停止，才能切换到其他版本</div>

          <div class="m-list">
            <button
              v-for="(v, idx) in versions"
              :key="v.path"
              type="button"
              class="m-item"
              :class="{ cur: isCur(v), locked: running && !isCur(v) }"
              :style="{ animationDelay: (idx * 35) + 'ms' }"
              :disabled="running && !isCur(v)"
              @click="choose(v)"
            >
              <span class="m-tag" :class="{ old: v.supported === 'unsupported' }">
                {{ v.version || '版本未知' }}
              </span>
              <span class="m-meta">
                <span class="m-name">{{ v.name }}</span>
                <span class="m-path" :title="v.path">{{ v.path }}</span>
              </span>
              <!-- 低于支持范围（0.x）的实例也列出来（用户可能想自己看），但明确标注该重装 -->
              <span v-if="v.supported === 'unsupported'" class="m-old">需重装到 1.2.x</span>
              <!-- 无入口文件的目录也列出来（用户可能想自己修），但明确标注 -->
              <span v-if="v.runnable === false" class="m-norun">无入口</span>
              <IconGlyph v-if="isCur(v)" name="check" class="m-check" />
            </button>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import PanelCard from '../components/ui/PanelCard.vue';
import PillButton from '../components/ui/PillButton.vue';
import TextInput from '../components/ui/TextInput.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import LoadingSpinner from '../components/ui/LoadingSpinner.vue';
import IconGlyph from '../components/IconGlyph.vue';
import QuickActions from '../components/dashboard/QuickActions.vue';
import SystemPerf from '../components/dashboard/SystemPerf.vue';
import { toast } from '../composables/useToast.js';
import {
  applySettings,
  buildStartPayload,
  isPortOpen,
  detectAdapter,
  maibotWebuiToken,
  openExternal,
  refreshServices,
  resolveStartPayload,
  restartService,
  sendServiceInput,
  serviceOf,
  startService,
  stopService,
  store
} from '../stores/app-store.js';

/* 路径归一化：去尾部斜杠 + 统一大小写，用于比对「当前实例」 */
const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

/* 未安装 SnowLuma 时"去安装"要把用户送到设置页，所以页面需要路由 */
const router = useRouter();

const busy = ref('');
const refreshing = ref(false);
const pickerOpen = ref(false);

/* ---------------------------------------------------------------- EULA 知悉提示
   ⚠️ 法律框架（别改错）：
     本启动器**不是 MaiBot 的许可方**，与它没有隶属或代理关系。
     所以本界面**不做"同意 EULA"这件事** —— 只做两件事：
       1) 转达上游的要求：MaiBot 要求使用前阅读并同意它的 EULA；
       2) 指向原文位置（本机安装目录下的 EULA.md / 上游仓库）。
     是否同意，由用户**在 MaiBot 自己的流程里**作出；本启动器不记录、不上传、
     不代替用户作出同意，也不解释、不复述其条款（条款一律以原文为准）。
     本提示不构成用户与本启动器之间的任何协议。
   标记语义：只表示"这位用户看过本提示"，不表示"已同意 EULA"。
   第一次点「启动麦麦」弹一次，用户确认看过之后不再打扰（localStorage，本机）。
*/
const EULA_KEY = 'maibot-launcher.eula-notice-ack.v1';
/* 旧键（eula-accepted）语义是错的：它冒充"用户已同意 MaiBot 的 EULA"。
   本启动器无权经手那份合同，所以旧键直接丢弃，不用它做任何迁移。 */
try {
  localStorage.removeItem('maibot-launcher.eula-accepted.v1');
} catch {
  /* 读不到 localStorage 就算了，不影响功能 */
}
const eulaNoticeAck = ref((() => {
  try {
    return localStorage.getItem(EULA_KEY) === '1';
  } catch {
    return false;
  }
})());
const eulaOpen = ref(false);
const eulaChecked = ref(false);

/*
  ---------------------------------------------------------------- 过渡的"保命开关"

  ⚠️ 窗口不可见时（最小化 / 被别的窗口完全遮住）Chromium **不产生帧**：
       · 过渡的 transitionend 永远不会来；
       · Vue 的 nextFrame()（双 rAF）永远不触发；
       · 兜底的 setTimeout 被限流到秒/分钟级。
     于是 <Transition> 的离场收不了尾 —— 实测：点弹窗的「取消」后节点既不从
     DOM 移除、类名也停在 picker-enter-from picker-enter-active，
     表现就是"取消 / Esc / 点遮罩都关不掉"，用户被弹窗挡住。

  正解是让 Vue 在这种情况下**不要挂过渡**：
     <Transition :css="animOk">，animOk 只在窗口可见时为真。
     依据是 Vue 自己的实现（@vue/runtime-dom 的 resolveTransitionProps）：
         if (rawProps.css === false) { return baseProps; }
     css=false 时它不加类、不 nextFrame、不等 transitionend，
     元素同步插入/移除，不依赖任何帧。可见时照旧走原来的动画。

  同源问题在 AppLayout 的换页过渡里已经用 skipSwap 处理过（那里注释更细）。
*/
const animOk = ref(true);
function syncAnimOk() {
  animOk.value = document.visibilityState === 'visible';
}
onMounted(() => {
  syncAnimOk();
  document.addEventListener('visibilitychange', syncAnimOk);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', syncAnimOk));


/* ---------------------------------------------------------------- 弹窗键盘与焦点
  ⚠️ 两件事此前都缺失（审计 R-05），而且都是**可用性缺陷**而不是合规装饰：

  1) Esc 关闭。本页两个弹窗都靠"点遮罩"或"点里面的按钮"退出 ——
     纯键盘用户没有退出路径（Tab 只能循环在按钮之间）。
     键盘用户量级不小，而且这里挡的是「启动」主流程。

  2) 焦点管理。弹窗打开时焦点留在触发它的按钮上：
     用户在 EULA 弹窗里按空格，触发的是**背后那颗「启动麦麦」**，
     于是弹窗还开着却又启动了一次。所以打开时把焦点移进弹窗，
     关闭时还回触发元素。

  实现选择：@keydown 挂在遮罩上（而不是 window 监听）。
  挂 window 需要自己判断"哪个弹窗开着"、还要在卸载时摘掉监听；
  挂在遮罩上时，只要焦点在弹窗内（我们会保证如此），事件就会冒泡到遮罩。
  两个弹窗互斥（pickerOpen / eulaOpen 不会同时为真），所以不需要额外判断。
*/
const eulaModalEl = ref(null);
const pickerModalEl = ref(null);
/** 打开弹窗前的焦点元素，关闭时还回去 */
let lastFocused = null;

/** 弹窗内的可聚焦元素（按钮、输入框、链接等） */
function focusablesIn(root) {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onModalKeydown(e, close) {
  if (e.key === 'Escape') {
    e.preventDefault();
    /* stopPropagation：避免 Escape 继续冒泡到外壳，被当成"关闭抽屉/退出全屏"之类 */
    e.stopPropagation();
    close();
    return;
  }
  /*
    Tab 焦点环：默认行为下 Tab 会走出弹窗、落到被遮住的卡片上 ——
    用户看不见焦点在哪，再按回车就点到别的功能了。
    这里在首尾之间循环，把焦点锁在弹窗内（轻量 focus trap）。
  */
  if (e.key !== 'Tab') return;
  const list = focusablesIn(e.currentTarget);
  if (list.length < 2) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * 弹窗打开时把焦点移进去。
 * 用 nextTick 而不是立即：v-if 刚变成 true 的那一帧元素还不存在。
 */
async function focusModal(elRef) {
  lastFocused = document.activeElement;
  await nextTick();
  const list = focusablesIn(elRef.value);
  /* 优先聚焦第一个输入框（EULA 的复选框），没有就聚焦第一个按钮 */
  const preferred = list.find((el) => el.matches('input, select, textarea')) || list[0];
  preferred?.focus();
}

/** 关闭弹窗后把焦点还给触发它的那个按钮，否则焦点会掉到 <body> 上（Tab 从头开始） */
function restoreFocus() {
  const el = lastFocused;
  lastFocused = null;
  if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
}

watch(eulaOpen, (open) => {
  if (open) focusModal(eulaModalEl);
  else restoreFocus();
});

watch(pickerOpen, (open) => {
  if (open) focusModal(pickerModalEl);
  else restoreFocus();
});

function openEulaDialog() {
  eulaChecked.value = false; // 每次打开都从"未勾选"开始，绝不留上次的勾
  eulaOpen.value = true;
}

function ackEulaNoticeAndStart() {
  if (!eulaChecked.value) return; // 没勾就不放行（按钮也是 disabled，这里再兜一层）
  try {
    localStorage.setItem(EULA_KEY, '1');
  } catch {
    /* 写不进去（隐私模式等）：本次会话照常放行，下次启动会再问一次 —— 宁可多问，不可默认同意 */
  }
  eulaNoticeAck.value = true;
  eulaOpen.value = false;
  startMaiBot();
}

/* 服务标准输入（交互确认等场景：只有交互才能继续时必须有入口） */
const stdinTarget = ref('maibot');
const stdinText = ref('');

/* 当前已配置的 MaiBot 目录（草稿优先） */
const configuredDir = computed(
  () => store.draft?.service?.maibotDir || store.settings?.service?.maibotDir || ''
);

/*
  全部候选版本：扫描结果 + 已配置目录兜底（保证运行中的那条始终可选）。

  必须按 type 过滤：store.installations 里同时装着扫描到的 **SnowLuma 运行时**，
  那些条目也带 path/version，混进来会被当成"可以切换的 MaiBot 版本"，
  用户点到它就会把 maibotDir 指向一个 Node 程序目录，启动必然失败。
*/
const versions = computed(() => {
  const list = store.installations
    .filter((i) => i.type === 'maibot')
    .map((i) => ({
      name: i.name || 'MaiBot',
      path: i.path,
      version: i.version || '',
      /*
        这几个字段必须透传下去。
        原实现只映射了 name/path/version，于是：
          · 模板里的 `v.runnable === false` 永远不成立 →「无入口」标记从不显示
          · `selected.runnable === false` 也永远不成立 →
            用户能选中一个没有入口文件的目录点「启动」，然后无解释地失败
            （而下方注释还写着"主进程已经算出 runnable"，其实被这里丢掉了）
          · supported 丢掉后，0.x 老版本与 1.2.x 在界面上长得一模一样，
            看不出"这个版本该重装"
      */
      runnable: i.runnable,
      supported: i.supported || 'unknown',
      versionSource: i.versionSource || '',
      evidence: i.evidence || ''
    }));

  const dir = configuredDir.value;
  if (dir && !list.some((i) => norm(i.path) === norm(dir))) {
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'MaiBot';
    /* 已配置但没被扫到：版本/支持度都未知，不编 */
    list.unshift({
      name,
      path: dir,
      version: '',
      runnable: undefined,
      supported: 'unknown',
      versionSource: '',
      evidence: ''
    });
  }
  return list;
});

/* 卡片只展示一个实例：优先已配置目录，否则取扫描到的第一个 */
const selected = computed(() => {
  if (!versions.value.length) return null;
  return versions.value.find((v) => norm(v.path) === norm(configuredDir.value)) || versions.value[0];
});

const isCur = (v) => !!selected.value && norm(v.path) === norm(selected.value.path);

const running = computed(() => !!serviceOf('maibot').running);

/*
  SnowLuma 的运行状态。
  用 store 里的**同一条**记录（serviceOf 只保证 running，pid 要自己取），
  免得模板里出现"两个来源各说一套"。
*/
const snowlumaSvc = computed(() => serviceOf('snowluma'));
const snowluma = computed(() => ({
  running: !!snowlumaSvc.value.running,
  pid: snowlumaSvc.value.pid
}));

/* 当前已配置的 SnowLuma 目录（草稿优先，和 MaiBot 那边同一套读法） */
const configuredSnowlumaDir = computed(
  () => store.draft?.service?.snowlumaDir || store.settings?.service?.snowlumaDir || ''
);

/*
  扫描发现的 SnowLuma 运行时（版本高的在前）。

  为什么必须有这一段：
    扫描器现在能靠 package.json 里的 @snowluma/runtime 认出 SnowLuma 了，
    但结果原先只被用来数个数 —— 用户磁盘上明明躺着装好的运行时，
    总览页却只会说"还没装？去设置页下载"，扫了等于白扫。
    这里把扫描结果变成可执行的一步：直接把 snowlumaDir 指过去。

  只认 type==='snowluma' 且 runnable !== false 的条目 ——
  没有入口文件（index.mjs / launcher.bat）的目录拿来启动必然失败。
  （这正是 MaiBot 那版 `versions` 踩过的坑：不过滤类型就会把 SnowLuma
   目录当成可切换的 MaiBot 版本列出来。）
*/
function snowlumaVerNum(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : -1;
}

const scannedSnowluma = computed(() =>
  store.installations
    .filter((i) => i.type === 'snowluma' && i.runnable !== false)
    .slice()
    .sort((a, b) => snowlumaVerNum(b.version) - snowlumaVerNum(a.version))
);

/** 没配过目录、但机器上扫到了 SnowLuma → 值得直接提示"就用这个" */
const snowlumaAdoptable = computed(() =>
  configuredSnowlumaDir.value ? null : scannedSnowluma.value[0] || null
);

/**
 * 既没配目录、也一个都没扫到 —— 这是**扫描口径**下的"看起来还没装"。
 *
 * ⚠️ 它与 snowlumaKnownMissing（主进程的真实探测结果）不是一回事，所以
 * 只用来说"扫描没找到"，绝不用它决定"未安装"这个结论：
 *   · 用户可能把运行时装在扫描根之外（扫描没扫到，但确实是装好的）；
 *   · 反过来，扫到了也不能保证入口文件齐全（scannedSnowluma 已经过滤了
 *     runnable === false，所以这条其实是有保证的那一半）。
 * 结论只认主进程的探测结果，这条只喂副行文案（"未配置安装目录"）。
 */
const snowlumaMissing = computed(
  () => !configuredSnowlumaDir.value && scannedSnowluma.value.length === 0
);

/** 把扫描到的 SnowLuma 指定为启动器要用的那一份（写设置，失败回滚草稿） */
async function adoptSnowluma(v) {
  if (!v?.path) return;
  if (!store.draft) store.draft = {};
  if (!store.draft.service) store.draft.service = {};
  const previous = store.draft.service.snowlumaDir;
  store.draft.service.snowlumaDir = v.path;
  try {
    const saved = await applySettings();
    if (!saved || !saved.ok) {
      store.draft.service.snowlumaDir = previous;
      toast(saved?.message || '指定 SnowLuma 目录失败，已还原', 'error');
      return;
    }
    toast(`已指定 SnowLuma：${v.version || v.path}`, 'success');
  } catch (e) {
    store.draft.service.snowlumaDir = previous;
    toast('指定 SnowLuma 目录失败，已还原：' + (e?.message || e), 'error');
  }
}

/** 接线自检结果（null = 还没查过） */
const snowlumaCheck = ref(null); // null | { onebot, webui, adapter }
const snowlumaChecking = ref(false);

/**
 * 从 SnowLuma 的启动日志里抓 WebUI 初始凭据。
 *
 * 为什么必须抓：
 *   它首次生成随机密码后**只打印一次**，原文还特别注明
 *   「若跳过初始改密，下次启动将自动生成新的随机密码」。
 *   用户没记下来就只能删配置重来。把它显示在界面上是最省事的补救。
 *
 * 实测输出形如：
 *   [WebUI] initial credentials: user=admin password=a96f24db50b0cca0
 */
const snowlumaCred = computed(() => {
  const lines = store.logsByKey?.snowluma || [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /user=(\S+)\s+password=(\S+)/.exec(String(lines[i]?.text || ''));
    if (m) return { user: m[1], password: m[2] };
  }
  return null;
});

/* ============================================================================
 *  服务卡片的状态与"装了没"
 * --------------------------------------------------------------------------
 *  为什么需要"装了没"：只显示"已停止"是不够的 —— 用户分不清
 *  「装好了、只是没启动」和「根本没装」，于是会去点一个点了必然失败的「启动」，
 *  或者反过来以为已经装好了。这一层的唯一目的就是让这两种情形**看起来不一样**。
 *
 *  判定来源只用一个：service:resolve-payload（主进程真的去看目录与入口文件）。
 *  和"能不能启动"用的是同一份推导，所以不会出现"界面说能启动、一启动就失败"。
 * ========================================================================== */

/** 探测结果：null = 还没探到；{ok:false} = 确认起不来（没装/路径不对） */
const snowlumaProbe = ref(null);

/** 确认没装（探测已经回来且明确失败）—— 只有它才拦按钮、才显示"去安装" */
const snowlumaKnownMissing = computed(() => snowlumaProbe.value?.ok === false);

/** 状态徽标：未安装 / 运行中 / 已停止 三态，绝不把"没装"说成"已停止" */
const snowlumaBadge = computed(() => {
  if (snowluma.value.running) return { tone: 'ok', text: '运行中' };
  if (snowlumaKnownMissing.value) return { tone: 'warn', text: '未安装' };
  return { tone: 'neutral', text: '已停止' };
});

/** 副行：运行中给 PID（可核对），否则给真实路径 / 未配置提示 */
const snowlumaSub = computed(() => {
  if (snowluma.value.running) return `运行中 · PID ${snowluma.value.pid || '-'}`;
  const dir = configuredSnowlumaDir.value;
  if (dir) return dir;
  /* 没配目录时再说清"扫描到了没有"（snowlumaMissing 的唯一用途，见它的注释） */
  return snowlumaMissing.value ? '未配置安装目录' : '未指定安装目录';
});

/**
 * 探一次"到底装没装"。
 *
 * 只在挂载时探一次：它是一次 IPC 往返（主进程要读目录/找入口文件），
 * 没必要轮询 —— 服务起来之后状态由 store 的 running 表达，
 * 而"是否安装"在用户改设置、重新进本页时会再探一次。
 */
async function probeSnowluma() {
  try {
    const r = await resolveStartPayload('snowluma');
    snowlumaProbe.value = r && typeof r === 'object' ? r : { ok: false, message: '探测失败' };
  } catch (e) {
    /* 探测失败 ≠ 没装：保持 null（不拦按钮），失败原因在点启动时会如实报出来 */
    snowlumaProbe.value = null;
    console.warn('[overview] 探测 SnowLuma 安装状态失败:', e?.message || e);
  }
}

/** 未安装时把用户送到真正的安装入口（SnowLuma 的下载按钮在设置页） */
function goInstallSnowluma() {
  toast('SnowLuma 的下载入口在「设置」页的 SnowLuma 区块（自带 Node，无需额外装环境）', 'info', 6000);
  router.push('/settings');
}

/* ===== 二级弹窗：切换选中 ===== */

function openPicker() {
  pickerOpen.value = true;
}

function closePicker() {
  pickerOpen.value = false;
}

async function choose(v) {
  if (isCur(v)) {
    closePicker();
    return;
  }
  if (running.value) return;

  if (!store.draft) store.draft = {};
  if (!store.draft.service) store.draft.service = {};

  /*
    保存失败必须回滚草稿。
    原实现只 toast 就 return，草稿已被改成新目录而设置文件仍是旧值 ——
    界面显示的是新实例，实际启动的却是旧实例，且这个不一致会一直留到
    用户下次在设置页点「应用」为止。用户完全无从察觉。
  */
  const previous = store.draft.service.maibotDir;
  store.draft.service.maibotDir = v.path;

  try {
    const saved = await applySettings();
    if (!saved || !saved.ok) {
      store.draft.service.maibotDir = previous;
      toast(saved?.message || '切换实例失败，已还原', 'error');
      return;
    }
    closePicker();
    toast(`已切换到 ${v.version || v.name}`, 'success');
  } catch (e) {
    store.draft.service.maibotDir = previous;
    toast('切换实例失败，已还原：' + (e?.message || e), 'error');
  }
}

/* ===== 启动 / 停止 / 重启当前实例 ===== */

/**
 * 服务动作的统一包装。
 *
 * 存在的理由（原来六个函数各写一遍，问题也都各犯一遍）：
 *   1) 重入守卫必须在**第一个 await 之前**生效。
 *      原实现是 `const payload = await resolvePayload(key)` 之后才设 busy ——
 *      resolvePayload 是一次 IPC 往返，这期间按钮仍可点，
 *      连点两次会让同一服务收到两个启动/重启请求。
 *   2) 原来 stopMaiBot / stopSnowLuma / restart* 的 finally 里没有 catch，
 *      动作抛错会变成 unhandled rejection（界面毫无反馈）。
 *
 * @param {string} key busy 标识
 * @param {string} label 文案前缀，如 'MaiBot'
 * @param {string} okText 成功提示
 * @param {() => Promise<{ok?:boolean,message?:string}>} fn 实际动作
 */
async function runServiceAction(key, label, okText, fn) {
  if (busy.value) return;
  busy.value = key;
  try {
    const r = await fn();
    /*
      分档提示（原来只有成功/失败两档）：
        · stopped  —— 这次启动被主动停止收尾了，不是失败，且停止流程已经提示过；
        · busy     —— 上一次启动还在进行中，告诉用户"等一下"，不是错误；
        · degraded —— 进程起来了但端口还没就绪，用警告色，不给绿色假确认。
    */
    if (r?.stopped) {
      /* 已在停止流程提示，不重复 */
    } else if (r?.busy) {
      toast(r.message || `${label}正在启动中，请稍候`, 'warn', 3000);
    } else if (r && r.ok && r.degraded) {
      toast(r.message || `${label}已启动，但端口未就绪（仍在后台等待）`, 'warn', 5000);
    } else if (r && r.ok) toast(okText, 'success');
    else toast(r?.message || `${label}操作失败`, 'error', 4500);
  } catch (e) {
    toast(`${label}操作失败：${e?.message || e}`, 'error');
  } finally {
    busy.value = '';
    await refreshServices();
  }
}

/**
 * 取得真正可用的启动参数。
 *
 * 关键：优先问主进程。
 * 渲染层的 buildStartPayload 只能读设置里的字符串，无法确认目录真的存在，
 * 也**无法探测协议端真实的入口文件名**（旧实现把某个 exe 名字硬编码在
 * 注释声称"已探测"的代码里）。主进程的 buildStartPayload 会真的
 * 去目录里按优先级找入口，找不到就明确返回失败，而不是让 spawn 抛一个
 * 难以理解的错误。
 */
async function resolvePayload(key) {
  const probe = await resolveStartPayload(key);
  if (probe.ok && probe.payload) return probe.payload;
  /* 主进程探测失败时回退到渲染层草稿，保证"设置刚改还没保存"也能启动 */
  const fallback = buildStartPayload(key);
  if (fallback) return fallback;
  return { error: probe.message };
}

/**
 * 启动/重启 MaiBot。
 * 若已有实例在跑，交给主进程的 restartService 处理 ——
 * 它会把这次停止标记为"主动停止"，看门狗不会误判为异常退出。
 * （之前这里直接 stopService + startService，中间可能出现两个进程。）
 */
async function startMaiBot() {
  /* 没同意过 EULA 就不启动：先弹确认框，由用户本人勾选后经 ackEulaNoticeAndStart() 再进来。 */
  if (!eulaNoticeAck.value) {
    openEulaDialog();
    return;
  }
  if (busy.value) return;
  const payload = await resolvePayload('maibot');
  if (payload.error) {
    toast(payload.error, 'warn');
    return;
  }
  await runServiceAction(
    'maibot',
    'MaiBot',
    `已启动 ${selected.value?.version || 'MaiBot'}`,
    () => (running.value ? restartService('maibot', payload) : startService(payload))
  );
}

async function stopMaiBot() {
  await runServiceAction('maibot', 'MaiBot', 'MaiBot 已停止', () => stopService('maibot'));
}

/** 重启 MaiBot（主进程侧一次原子操作，避免端口被两个进程争抢） */
async function restartMaiBot() {
  if (busy.value) return;
  const payload = await resolvePayload('maibot');
  if (payload.error) {
    toast(payload.error, 'warn');
    return;
  }
  await runServiceAction('maibot-restart', 'MaiBot', 'MaiBot 已重启', () =>
    restartService('maibot', payload)
  );
}

/* ===== SnowLuma ===== */

/*
  SnowLuma 是**独立 Node 程序**，不注入 QQ、也不需要用户装 QQ ——
  它自带运行时和自带 WebUI，代价是有一套自己的端口（默认 WebUI 5099 /
  OneBot 7988）。界面上这两个端口必须始终显示真实值（读取设置，不写死），
  否则用户会照着错的端口去它的 WebUI 里配 OneBot 服务器。
*/
async function startSnowLuma() {
  if (busy.value) return;
  const payload = await resolvePayload('snowluma');
  if (payload.error) {
    toast(payload.error, 'warn', 6000);
    return;
  }
  await runServiceAction('snowluma', 'SnowLuma', 'SnowLuma 已启动', () =>
    snowluma.value.running ? restartService('snowluma', payload) : startService(payload)
  );
}

async function stopSnowLuma() {
  await runServiceAction('snowluma', 'SnowLuma', 'SnowLuma 已停止', () => stopService('snowluma'));
}

async function restartSnowLuma() {
  if (busy.value) return;
  const payload = await resolvePayload('snowluma');
  if (payload.error) {
    toast(payload.error, 'warn');
    return;
  }
  await runServiceAction('snowluma-restart', 'SnowLuma', 'SnowLuma 已重启', () =>
    restartService('snowluma', payload)
  );
}

/**
 * 打开 SnowLuma 的 WebUI。
 *
 * 它在 5099 上提供自带面板，**首次登录的凭据只在启动日志里打印一次**，
 * 所以这里除了打开浏览器，还要把凭据提示出来（见模板里的 cred 区块）。
 *
 * 打开前先探端口：它启动到 WebUI 监听之间有若干秒空档，
 * 直接打开会得到浏览器的"无法访问此网站"，容易被误判成启动器坏了。
 */
const snowlumaWebuiOpening = ref(false);

async function openSnowLumaWebui() {
  if (snowlumaWebuiOpening.value) return;
  const port = Number(store.settings?.service?.snowlumaPorts?.webui) || 5099;
  const url = `http://127.0.0.1:${port}`;
  snowlumaWebuiOpening.value = true;
  try {
    const open = await isPortOpen(port);
    if (!open) {
      toast(
        `SnowLuma WebUI（端口 ${port}）尚未就绪。请先启动 SnowLuma，等待几秒后重试；` +
          `若长时间无响应，可在「日志」页查看它的输出。`,
        'warn',
        6000
      );
      return;
    }
    const r = await openExternal(url);
    if (r && r.ok === false) {
      toast(r.message || `无法打开浏览器，请手动访问 ${url}`, 'error', 6000);
      return;
    }
    toast(`已在浏览器打开 ${url}`, 'success', 3000);
  } catch (e) {
    toast(`打开 SnowLuma WebUI 失败：${e.message}`, 'error', 5000);
  } finally {
    snowlumaWebuiOpening.value = false;
  }
}

/** 复制 SnowLuma 的初始凭据（密码只在日志里出现一次，复制比手抄可靠） */
async function copySnowlumaCred() {
  if (!snowlumaCred.value) return;
  const { user, password } = snowlumaCred.value;
  try {
    await navigator.clipboard.writeText(`用户名：${user}\n密码：${password}`);
    toast('已复制 SnowLuma 初始账号密码', 'success', 2500);
  } catch (e) {
    toast(`复制失败，请手动记录：${user} / ${password}`, 'warn', 8000);
  }
}

/* ===== SnowLuma 接线自检 ===== */

/*
  为什么做"自检"而不是"自动写配置"：
    实测（真跑了一次 SnowLuma）它生成的 config/runtime.json 里**只有 WebUI / 日志**
    这些项，压根没有 OneBot 段，进程也只监听 5099。也就是说它的 OneBot 正向 WS
    服务器是**要在它自己的 WebUI 里手动开**的，开在哪个端口也由那边决定。
    启动器没有可靠的落点可以替用户写这个配置，硬写一个自己猜的文件结构
    只会制造"看起来配好了、其实没生效"。

  所以这里沿用项目里已有的做法（新手引导第 9 步也是这么做的）：
    **启动器只做检测 + 告诉用户去哪一步操作**，不替他改文件。
  但检测必须是真的（真的去连端口），不能只看设置里的数字。
*/

async function checkSnowlumaWiring() {
  if (snowlumaChecking.value) return;
  snowlumaChecking.value = true;
  try {
    const svc = store.settings?.service || {};
    const webuiPort = Number(svc.snowlumaPorts?.webui) || 5099;
    const onebotPort = Number(svc.snowlumaPorts?.onebot) || 7988;

    /*
      两部分一起查，因为它们回答的是不同问题、且都会导致"接不上"：
        · 端口：SnowLuma 那边 OneBot 服务器开没开（只能探测，它要在自己 WebUI 里建）
        · 插件：麦麦那边适配器装没装对（能直接看文件系统，装错名字/版本也查得出来）
      只查一半会出现"端口通了但插件是第三方分支"这种查不出来的坑。

      插件检测传空对象：检测哪一份插件已经固定下来了（只有 SnowLuma 适配器
      这一种），MaiBot 目录由主进程自己从设置里取，这里无从指定。
    */
    const [webui, onebot, adapter] = await Promise.all([
      isPortOpen(webuiPort),
      isPortOpen(onebotPort),
      detectAdapter({})
    ]);
    snowlumaCheck.value = { webui, onebot, adapter };

    if (!adapter?.ok) {
      toast(adapter?.message || '适配器检测失败', 'warn', 5000);
    } else if (adapter.reason === 'no-dir') {
      /* 没配目录是"还没设置"，不是故障 —— 提示要可操作 */
      toast('还没设置 MaiBot 目录，先去设置页选一下，才能检查适配器插件', 'warn', 6000);
    } else if (!adapter.found) {
      toast(
        `没在麦麦里找到 SnowLuma 适配器插件（应该在 ${adapter.expectedDir}）。` +
          `装完插件还要去 WebUI 的「插件管理」里手动启用它。`,
        'warn',
        9000
      );
    } else if (adapter.nameMismatch) {
      toast(
        `检测到的是「${adapter.name}」，它看起来是第三方分支，` +
          `官方那个叫 MaiBot-SnowLuma-Adapter（配置版本 ${adapter.expectedConfigVersion}）。` +
          `两者配置结构不同，装错会连不上。`,
        'warn',
        10000
      );
    } else if (!onebot) {
      toast(
        `SnowLuma 在运行，但 OneBot 端口 ${onebotPort} 没开 —— ` +
          `需要到它的 WebUI 里启用 OneBot 正向 WebSocket 并填这个端口。`,
        'warn',
        8000
      );
    } else if (!webui) {
      toast(`SnowLuma 看起来没在运行（WebUI 端口 ${webuiPort} 也没开）`, 'warn', 5000);
    } else {
      toast('接线检查通过：端口与适配器插件都就位', 'success', 4000);
    }
  } catch (e) {
    toast(`自检失败：${e.message}`, 'error', 5000);
  } finally {
    snowlumaChecking.value = false;
  }
}

/* ===== 服务标准输入 ===== */

/**
 * 向服务 stdin 发送内容。
 * 用于 y/n 确认等只有交互才能继续的场景。
 * 发送后自动追加换行：绝大多数 CLI 读取的是一整行。
 */
const stdinSending = ref(false);

async function sendStdin() {
  /*
    防重发。输入框绑的是 @keyup.enter，按住回车时浏览器会**重复触发** keyup，
    每一次都发一条 stdin —— 对交互式 CLI 来说等于连续回车，
    可能直接跳过确认或重复执行命令。
  */
  if (stdinSending.value) return;

  const text = String(stdinText.value || '');
  if (!text.trim()) {
    toast('请输入要发送的内容', 'warn');
    return;
  }
  const target = stdinTarget.value;
  stdinSending.value = true;
  try {
    const r = await sendServiceInput(target, `${text}\n`);
    if (r && r.ok) {
      toast(`已发送到 ${target === 'snowluma' ? 'SnowLuma' : 'MaiBot'}`, 'success', 2200);
      stdinText.value = '';
    } else {
      toast(r?.message || '发送失败：进程可能未在托管中', 'error', 4000);
    }
  } catch (e) {
    toast('发送失败：' + (e?.message || e), 'error');
  } finally {
    stdinSending.value = false;
  }
}

/**
 * 服务运行状态变化时，让下拉框始终指向一个真实在跑的服务。
 *
 * 注意这里**必须写 snowluma.value.running**：
 * ref/computed 的自动解包只发生在模板里。本函数是 JS 作用域的 getter，
 * 写 `snowluma.running` 得到的是 `undefined`（computed 对象上没有 running 属性）——
 * 于是 SnowLuma 单独运行时下拉框会落到 'maibot'，
 * 用户输入的确认会被发到一个并不存在的进程上；
 * 依赖数组也因此退化成只观察 running，pid 变化不会触发纠正。
 *
 * 另外：如果当前选中的服务**仍在运行**就不要动它 ——
 * 两个都在跑时用户手动选了 SnowLuma，不该被无关的状态刷新改回去。
 */
watch(
  () => [running.value, snowluma.value.running],
  () => {
    const options = [];
    if (running.value) options.push('maibot');
    if (snowluma.value.running) options.push('snowluma');
    if (options.includes(stdinTarget.value)) return;
    stdinTarget.value = options[0] || 'maibot';
  }
);

/**
 * 手动刷新服务状态。
 * 原实现只 await refreshServices()，而它内部失败时会把 store.services
 * 静默清空（见 app-store.js）—— 界面于是从"运行中"变成"什么都没有"，
 * 却没有任何提示。这里比对前后数量，异常时明确告知。
 */
async function reload() {
  refreshing.value = true;
  const before = Array.isArray(store.services) ? store.services.length : 0;
  try {
    await refreshServices();
    const after = Array.isArray(store.services) ? store.services.length : 0;
    if (after === 0 && before > 0) {
      toast('未能读取服务状态，列表可能不完整', 'warn', 4500);
    }
  } catch (e) {
    toast('刷新失败：' + (e?.message || e), 'error');
  } finally {
    refreshing.value = false;
  }
}

/* ============================================================================
 * 主页唯一那张卡要用到的显示值（纯呈现层，UI v4）
 * --------------------------------------------------------------------------
 * 只做"把已有状态翻译成人话 + 拼一个地址"，不涉及任何业务动作：
 *   · versionText  —— 版本号拼上"已装"，同目标图里「0.1.7-rc.2 · 已装 · 最新」
 *   · webuiUrl     —— 麦麦 WebUI 地址（端口读设置里的真实值，不写死）
 *   · webuiToken   —— 从启动日志里读出来的登录 Token，拼进地址省掉手抄
 * 启动/停止仍然走下面原有的 startMaiBot / stopMaiBot / restartMaiBot
 * （即原有的 runServiceAction 那一套），这里一行启动逻辑都没有新增。
 * ========================================================================== */

/**
 * 版本选择框里的那行字。
 * 目标图的格式是「<版本> · 已装 · 最新」；本项目没有"检测上游最新版"这个
 * 能力（那需要联网比对 release），所以**不编**"最新"这两个字，只用
 * 真正知道的两件事：版本号 + 这个实例确实在本地（本地扫出来的 = 已装）。
 */
const versionText = computed(() => {
  const v = selected.value;
  if (!v) return '未检测到麦麦';
  return `${v.version || v.name || '版本未知'} · 已装`;
});

/**
 * 麦麦 WebUI 地址。
 * 端口读设置里的真实值（默认 8001，见 src/main/constants.js 的 DEFAULT_PORTS），
 * 与「安装麦麦」页 / 新手引导里那个地址是同一个来源 —— 不写死 8001。
 * 只展示主机与端口；Token 作为查询参数拼在真正打开的链接上（见 openWebui），
 * 因为那是一串每次都变的随机字符，摆在界面上既读不懂也容易抄错。
 */
const webuiUrl = computed(() => {
  const port = Number(store.settings?.service?.ports?.webui) || 8001;
  return `http://127.0.0.1:${port}`;
});

/** WebUI 登录 Token（首次启动时麦麦只打印一次，启动器读出来免得用户去翻终端） */
const webuiToken = ref('');

/**
 * 读一次 Token。
 * 不放在 onMounted：麦麦**还没启动**时日志里当然没有 Token，那次读取只会拿到
 * "还没抓到"的失败回包。等 running 变 true 之后再读，一次就够
 * （它每次冷启动才重新生成，重启会让 running 抖动一次，同样会重新读取）。
 */
async function fetchWebuiToken() {
  try {
    const r = await maibotWebuiToken();
    webuiToken.value = r && r.ok ? r.token || '' : '';
  } catch (_) {
    /* 读不到就不带 Token 打开，让用户在页面里手输 —— 不能因为这一步失败
       就连 WebUI 都打不开 */
    webuiToken.value = '';
  }
}

watch(running, (now) => {
  if (now) fetchWebuiToken();
});

/**
 * 打开麦麦 WebUI（底部那行蓝色链接）。
 * 接的是**原有**的 openExternal()，没有新增任何 IPC 通道。
 * 带上 Token 是为了让用户点一下就能进去，而不是回到终端里翻那串字符。
 */
async function openWebui() {
  if (!webuiToken.value) await fetchWebuiToken();
  const url = webuiToken.value
    ? `${webuiUrl.value}/?token=${encodeURIComponent(webuiToken.value)}`
    : webuiUrl.value;
  try {
    const r = await openExternal(url);
    if (r && r.ok === false) toast(r.message || `无法打开浏览器，请手动访问 ${webuiUrl.value}`, 'error', 6000);
  } catch (e) {
    toast(`打开 WebUI 失败：${e?.message || e}`, 'error', 5000);
  }
}

onMounted(() => {
  reload();
  /* 探一次 SnowLuma 装没装：卡片据此决定显示「启动」还是「去安装」 */
  probeSnowluma();
});
</script>

<style scoped>
/* ============================================================================
 *  本页（含第二/第三张卡）的样式
 * --------------------------------------------------------------------------
 *  颜色**一律走 theme.css 的 token**，本文件不出现任何硬编码色值 ——
 *  这样深浅两套主题只需要 theme.css 里覆盖一次，这里不会漂移。
 *  用到的 token 都是 theme.css 里已有的：
 *    --surface-1 / --card-line / --shadow-card          → 卡片底 / 淡蓝描边 / 蓝调阴影
 *    --r-card(14) / --r-ctl(10)                         → 圆角 14 / 10
 *    --surface-field                                    → 版本选择框的底（#f7f9fc）
 *    --accent-tint-soft / --accent-tint-strong / --accent-line / --accent-ink
 *                                                       → 蓝色方钮与链接
 *    --err-tint-soft / --err-line-soft / --err-tint / --err-ink → 红色停止方钮
 *    --ok-tint / --ok-ink / --warn-tint / --warn-ink     → 服务状态点与徽标
 * ==========================================================================*/

/*
 *  舞台：负责"水平居中 + 卡片之间留白"。
 *  ────────────────────────────────────────────────────────────────────────
 *  ⚠️ 这里曾经有一句 `left: calc(50vw - 50% - 24px)`（把舞台整体右移，
 *     去抵掉外壳 `.body` 当年的 24px 内边距）。现在**已经删掉**，原因：
 *
 *  ① 外壳改了。AppLayout 的 `.body` 现在是 `padding: 0`、也没有
 *     `max-width: 640px`（v4 把"每页压成居中窄列"那套去掉了），实测：
 *       .body  {x:0, w:1280, padding:0rem, maxWidth:none}
 *       .panel {x:0, w:1280, maxWidth:none}
 *     也就是说 `.home-stage` 自己就占满视口宽度，本来就已经居中 ——
 *     **再右移就是过移**。
 *  ② 那句位移是"按一个已经不存在的 24px 内边距"算的，于是变成一个纯负偏移。
 *     `left` 的百分比在 calc 里按**自身宽度**解析，舞台宽 1280 ⇒ 50% = 640：
 *       left = 50vw - 640 - 24 = 640 - 640 - 24 = -24px
 *     实测复核：`.home-stage` 的 computed left = **-24px**，x = -24（比窗口宽出去 24px），
 *     卡片中心 x = 616 而视口中心 = 640 —— **整卡偏左 24px**。
 *     （修复前 .home-card x=243.5 w=745，中心 616；视口中心 640。）
 *
 *  现在的做法是最朴素的那种，不再依赖任何外壳尺寸：
 *    · `.panel` 铺满 → 舞台宽度 = 视口宽度；
 *    · `align-items: center` 负责水平居中（卡片自带 width: 745px）。
 *    · flex:1 + justify-content:center 负责"居中一屏时垂直居中"。
 *
 *  ⚠️ 本轮的偏差备案（见文件顶部说明）：舞台上现在有 3 组卡片（主卡 /
 *     SnowLuma 协议端 / 快捷操作 + 系统占用），超过一屏高度时如果仍然
 *     `justify-content: center`，flex 会把内容**居中溢出** —— 顶部那块
 *     会被裁掉且滚不到（经典 flex 居中溢出问题）。
 *     所以这里改成"内容不足一屏时居中、超过一屏时从顶部正常排布"：
 *     `justify-content: safe center`（安全居中，溢出时退回 flex-start）。
 *     竖向留白也从 32vh 收到 4vh/6vh —— 三张卡再加 32vh 的空白，
 *     首屏就只剩卡片之外的东西了。
 */
.home-stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: safe center;
  gap: 1rem;
  position: relative;
  padding: 1.5rem 0 3rem;
}

/*
 * 窄窗口（≤880px）：卡片自带 `max-width: calc(100vw - 48px)` 会自己缩，
 * 这里只需要把竖向留白再收一点（横向已经由 align-items: center 居中）。
 */
@media (max-width: 880px) {
  .home-stage {
    padding: 1rem 0 2rem;
  }
}

/* ===== 那一张卡：宽约 745 / 圆角 14 / 纯白 / 1px 淡蓝描边 / 柔和蓝阴影 / 内边距 22 ===== */
.home-card {
  width: 745px;
  /*
   * 上限用视口算，而不是 100%：100% 会被外壳的 640px 上限带着一起塌成
   * 640px（这正是 ② 里那个坑）。目标图里窗口再窄、卡片也是"离两边各留
   * 一点"的观感，所以按视口减两次 24px 来收。
   */
  max-width: calc(100vw - 48px);
  padding: 1.375rem;
  border-radius: var(--r-card);
  background: var(--surface-1);
  border: 1px solid var(--card-line);
  box-shadow: var(--shadow-card);
}

/* ① 小灰标签「版本」 */
.home-label {
  margin: 0 0 0.625rem;
  font-size: 13px;
  line-height: var(--lh-body);
  color: var(--ink-faint);
}

/* ② 选择框 + 两个方钮：一行，左框占满剩余宽度 */
.home-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

/* 选择框：高 42 / 圆角 10 / 底 --surface-field / 细边框 / 13px 灰字 */
.ver-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 auto;
  min-width: 0;
  height: 42px;
  padding: 0 0.875rem;
  border-radius: var(--r-ctl);
  border: 1px solid var(--line);
  background: var(--surface-field);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.ver-box:hover {
  border-color: var(--accent-line);
}

.ver-box:focus-visible {
  outline: none;
  border-color: var(--accent-line);
  box-shadow: var(--focus-ring);
}

.ver-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: var(--lh-body);
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ver-caret {
  letter-spacing: var(--ls-title);
  flex: none;
  font-size: 15px;
  color: var(--ink-faint);
}

/* 两个方形图标按钮：各 42×42、圆角 10（同目标图） */
.ico-btn {
  letter-spacing: var(--ls-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 42px;
  height: 42px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-ctl);
  font-family: inherit;
  font-size: 17px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease), opacity var(--dur) var(--ease);
}

.ico-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ico-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* 蓝：启动（未运行时）/ 重新启动（运行时） */
.ico-btn-start {
  background: var(--accent-tint-soft);
  color: var(--accent-ink);
}

.ico-btn-start:hover:not(:disabled) {
  background: var(--accent-tint-strong);
}

/* 红：停止。未运行时禁用变灰（透明度由 .ico-btn:disabled 统一处理） */
.ico-btn-stop {
  background: var(--err-tint-soft);
  border-color: var(--err-line-soft);
  color: var(--err-ink);
}

.ico-btn-stop:hover:not(:disabled) {
  background: var(--err-tint);
}

/* ③ 底部一行状态 */
.home-state {
  margin: 0.875rem 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

/*
 *  ⚠️ 这里**故意没有** `.st-txt { color: … }` 这条规则。
 *     原来写的是 `color: var(--ink-faint)`，而那正是两处不合格的地方：
 *
 *     · 对比度不达标：--ink-faint 就是 --text-4（#8a9099），
 *       theme.css 自己对它的注释写得很清楚 ——
 *       "白底 3.22:1 → 不达 4.5:1，只用于 11~12px 非必读标签/单位/元信息；
 *        必须读懂的句子请用 --text-3 或更深"（见 theme.css --text-4 的注释）。
 *       而这句话恰恰是**必须读懂的操作指引**：
 *         "已停止 · 点左侧按钮启动麦麦" —— 用户不读它就不知道该点哪儿。
 *       实测（白卡底）：--ink-faint → 3.22:1；--ink-soft（#6b7280）→ 4.83:1。
 *     · 与父级自相矛盾：父级 .home-state 已经给了 --ink-soft，
 *       子级却又把它降回 faint —— 同一个 <p> 里出现两种灰，属于意外而非设计。
 *
 *  所以直接删掉这条规则，让 .st-txt 继承 .home-state 的 --ink-soft：
 *  这里出现两种状态（"运行中 · " 前缀、整句"已停止 …"）一起修好。
 *  不写 `color: var(--ink-soft)` 是有意的 —— 以后调父级只改一处。
 *  （保留 .st-txt 这个 class 而不从模板里删：它是这一小段的语义钩子，
 *    将来若要单独调它仍有落点；删 class 会让模板改动面无谓变大。）
 */

/* 蓝色下划线链接（目标图底部那一行的形态） */
.webui-link {
  color: var(--accent-ink);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.webui-link:hover {
  color: var(--accent-hover);
}

/* ============================================================================
 *  第二 / 第三组卡片（SnowLuma 协议端 + 快捷操作 / 系统占用）
 * --------------------------------------------------------------------------
 *  尺寸与主卡一致（745 / 居中）：三张卡竖着排出来要像"同一页的东西"，
 *  而不是"主卡 + 两个附件"。宽度上限的算法与 .home-card 相同。
 * ========================================================================== */
.home-stage > .card,
.home-row-cards {
  width: 745px;
  max-width: calc(100vw - 48px);
}

/* 并排的两张工具卡：窄窗口竖排 */
.home-row-cards {
  display: flex;
  align-items: stretch;
  gap: 1rem;
}

/* min-width: 0 必须写：否则卡里那条长路径会把 flex 子项撑宽，横向溢出 */
.home-row-cards > .card {
  flex: 1 1 0;
  min-width: 0;
}

@media (max-width: 880px) {
  .home-row-cards {
    flex-direction: column;
  }
}

/* ===== 服务行：左（状态点 + 名字/副行） + 右（徽标 + 按钮组） ===== */
.svc {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--r-ctl);
  border: 1px solid var(--line);
  background: var(--surface-field);
}

.svc-left {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-width: 0;
}

/*
  状态点。运行中用 --ok（绿），停止用 --ink-faint（灰）。
  不用 emoji/图标字形的另一个原因：状态点在深浅两套主题里都要稳定，
  走 token 最省事。
*/
.svc-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-faint);
}

.svc-dot.on {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-tint);
}

.svc-meta {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.svc-name {
  letter-spacing: var(--ls-title);
  font-size: var(--fs-title);
  line-height: var(--lh-title);
  font-weight: var(--fw-bold);
  color: var(--ink-strong);
}

/* 副行可能是安装路径（很长）：截断 + title 里给全量，不让它把卡片撑破 */
.svc-sub {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.svc-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: none;
}

/* ===== 首次登录凭据 / 提示行 / 接线状态 ===== */
.sl-cred {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--r-ctl);
  background: var(--theme-tint);
  color: var(--accent-ink);
  font-size: 12px;
}

.sl-cred-txt {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 提示行：与状态徽标同一套语义色，但用 warn 底（未安装/未指定是"要你做点事"） */
.sl-hint,
.sl-steps {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-soft);
}

.sl-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  border-radius: var(--r-ctl);
  background: var(--warn-tint);
  border: 1px solid var(--warn-line);
  color: var(--note-warn-ink, var(--warn-ink));
}

.sl-steps code,
.sl-warn code {
  letter-spacing: var(--ls-sm);
  font-size: 11px;
  word-break: break-all;
}

/* 警告句：10~12px 小字必须用 ink 档（--warn 在白底上只有 2.95:1） */
.sl-warn {
  color: var(--warn-ink);
}

.sl-wiring {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
}

.sl-wiring-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.sl-wiring-title {
  letter-spacing: var(--ls-title);
  font-size: 13px;
  font-weight: var(--fw-bold);
  color: var(--ink-strong);
}

.sl-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.sl-line-txt {
  letter-spacing: var(--ls-sm);
  min-width: 0;
  font-size: 12px;
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}

/* ===== 服务标准输入 ===== */
.stdin-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.stdin-target {
  flex: none;
  height: var(--h-ctl-sm);
  padding: 0 0.5rem;
  font-family: inherit;
  font-size: 12px;
  color: var(--ink);
  background: var(--surface-field);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

/* ===== 选择实例弹窗（由主卡里的版本框触发，可达） ===== */
/* EULA 弹窗内部排版（外框沿用 .modal / .modal-mask，不另造一套） */
.eula-modal {
  max-width: 560px;
}
.eula-title {
  letter-spacing: var(--ls-title);
  margin: 0 0 0.625rem;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}
.eula-text {
  margin: 0 0 0.625rem;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.eula-list {
  margin: 0 0 0.875rem;
  padding-left: 1.125rem;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}
.eula-list code {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  word-break: break-all;
}
.eula-check {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin-bottom: 0.875rem;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-1);
  cursor: pointer;
}
.eula-btns {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--modal-mask);
  /*
    这里原本还给遮罩加了一层"玻璃模糊"（backdrop 滤镜）。
    它随弹窗一起暂时下线：v4 的全局约定是界面里不出现玻璃模糊
    （docs/UI-BRIEF-v4-imitate.md §3，grep 必须干净）。
    弹窗挂回来时若还想要那层模糊，把对应属性加回来即可 —— 只影响观感。
  */
}

.modal {
  width: 420px;
  max-width: calc(100vw - 48px);
  padding: 1rem;
  border-radius: var(--radius-lg);
  background: var(--card-bg);
  border: 1px solid var(--line);
  box-shadow: var(--modal-shadow);
}

/*
  弹窗过渡：与全项目二级窗口统一 —— 时长 --dur-base(180ms) + 缓动 --ease-standard。
  打开：遮罩淡入 + 面板轻微上浮/缩放；关闭：反向（比打开略短的感觉来自同一时长，
  不再像旧版那样"进 260ms 带过冲、出 180ms"，两下不同步）。
  旧写法把 transition 声明挂在 enter-from / leave-to 上（那里不是过渡生效的位置），
  而且只给 .modal 写了 from/to、遮罩没有任何状态，于是遮罩实际上是"瞬间出现"的。
*/
.picker-enter-from,
.picker-leave-to {
  opacity: 0;
}

.picker-enter-from .modal,
.picker-leave-to .modal {
  opacity: 0;
  transform: translateY(8px) scale(0.97);
}

.picker-enter-active,
.picker-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}

.picker-enter-active .modal,
.picker-leave-active .modal {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-standard);
}

.m-head {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}

.m-head-main {
  flex: 1;
  min-width: 0;
}

.m-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-strong);
}

.m-sub {
  letter-spacing: var(--ls-sm);
  margin: 0.25rem 0 0;
  font-size: 12px;
  color: var(--ink-soft);
}

.m-note {
  letter-spacing: var(--ls-sm);
  margin-bottom: 0.625rem;
  padding: 0.5rem 0.625rem;
  border-radius: 8px;
  font-size: 12px;
  color: var(--note-warn-ink);
  background: var(--warn-tint);
  border: 1px solid var(--warn-line);
}

.m-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 46vh;
  overflow-y: auto;
}

.m-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  text-align: left;
  font: inherit;
  border-radius: var(--radius-md);
  background: var(--row-bg);
  border: 1px solid var(--line);
  cursor: pointer;
  transition: border-color var(--dur-base), background var(--dur-base), box-shadow var(--dur-base);
  animation: m-item-in var(--dur-slow) both;
}

/* 列表项交错进场（关闭时不加动画，避免淡出时逐条延迟） */
.picker-leave-active .m-item {
  animation: none;
}

@keyframes m-item-in {
  from {
    opacity: 0;
    transform: translateY(7px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.m-item:hover:not(:disabled) {
  border-color: var(--theme-line);
  background: var(--row-bg-hover);
}

.m-item.cur {
  border-color: var(--theme-line);
  box-shadow: 0 0 0 3px var(--theme-tint);
}

.m-item.locked {
  opacity: 0.45;
  cursor: not-allowed;
}

.m-tag {
  letter-spacing: var(--ls-2xs);
  flex: none;
  min-width: 44px;
  padding: 0.25rem 0.5rem;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
  color: var(--theme-color);
  background: var(--theme-tint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「无入口文件」标记：与 m-tag 同区，但用警告色以示区别 */
.m-norun {
  letter-spacing: var(--ls-2xs);
  flex: none;
  padding: 0.25rem 0.5rem;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  /* 10px 小字必须用 ink 档：--warn 是图形档（白底 2.95:1），压在同色淡底上只剩 2.62:1；
     --warn-ink 实测 5.12:1（深色 6.37:1）。 */
  color: var(--warn-ink);
  background: var(--warn-tint);
  white-space: nowrap;
}

.m-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

/* 低于支持范围的版本号：红一点，和可用的 1.2.x 一眼区分开 */
.m-tag.old {
  color: var(--err-ink);
  background: var(--err-tint);
}

/* 「需重装到 1.2.x」标记 */
.m-old {
  letter-spacing: var(--ls-2xs);
  padding: 0.25rem 0.5rem;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--err-ink);
  background: var(--err-tint);
  white-space: nowrap;
}

.m-name {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-path {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  color: var(--ink-soft);
  font-family: 'Cascadia Mono', 'Consolas', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.m-check {
  letter-spacing: var(--ls-title);
  flex: none;
  font-size: 15px;
  color: var(--theme-color);
}
</style>
