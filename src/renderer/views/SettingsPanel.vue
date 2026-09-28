<template>
  <div class="panel" :class="{ 'pane-anim': paneAnim }">
    <!--
      顶部横向标签栏。
      旧版（Tauri + React）是「标签栏在顶、内容在下」的形态，本页照这个形态重做：
      七个面板一次只在屏幕上渲染一个，设置页从"一条 2000px 的长卷"变成
      "一屏一类设置"，用户不必在滚动中找项目。

      标签用 role="tablist"/"tab" + aria-selected：这是语义上的一组页签，
      读屏会念成"设置分类，数据，第 2 项，共 7 项"而不是七个孤立按钮。
    -->
    <div class="tabs" role="tablist" aria-label="设置分类">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ on: tab === t.id }"
        :aria-selected="tab === t.id ? 'true' : 'false'"
        :data-testid="`settings-tab-${t.id}`"
        @click="tab = t.id"
      >
        <IconGlyph :name="t.icon" class="tab-ico" />
        <span>{{ t.label }}</span>
      </button>
    </div>

    <p class="tip">
      <IconGlyph name="info" class="tip-ico" />
      <span>
        设置改动会先留在本页，点底部「应用」才写入设置文件；「取消」放弃本次改动。
        主题模式与主题色是即时生效的显示设置，点一下立刻生效并记住。
      </span>
      <PillButton variant="ghost" size="sm" icon="refresh" :loading="reloading" @click="reload">
        重新载入
      </PillButton>
    </p>

    <!-- ============================================================ 个性化 -->
    <template v-if="tab === 'appearance'">
      <PanelCard title="主题模式" desc="界面明暗，点一下立即生效并持久化">
        <FieldRow label="界面主题">
          <SegmentedControl
            v-model="themePref"
            label="界面主题"
            :disabled="themeBusy"
            :options="THEME_OPTIONS"
          />
          <span class="field-note">{{ themeNote }}</span>
        </FieldRow>
      </PanelCard>

      <!--
        主题色自定义。
        ────────────────────────────────────────────────────────────────────
        这是本次重做的重点：此前**完全没有**这个功能，强调色是写死的单一蓝
        （见 AppLayout.syncTheme()，它把 --theme-color 内联成 var(--accent)）。
        实现方式刻意选"叠加变量层"而不是"改 CSS 文件"：
          · 所有颜色在设计上都是**单一来源** —— theme.css 的 --accent 一族；
          · 本页只往 documentElement 上**追加**一条 <style>（保存旧值，卸载时还原），
            不写 theme.css、不改 AppLayout，也不在 JS 里复制一套 token；
          · 派生色（hover / tint / line / 实底上的文字色）由选中的基色**算出来**，
            不是再抄几个写死的字面量，所以任何一个色号都不会出现
            "淡底不跟手"或"实底白字看不清"的破版。
      -->
      <PanelCard title="主题色" desc="预设色 / 自定义取色 / 恢复默认">
        <FieldRow label="预设色">
          <div class="presets">
            <button
              v-for="p in PRESET_COLORS"
              :key="p.value"
              type="button"
              class="swatch"
              :class="{ on: accentColor.toLowerCase() === p.value.toLowerCase() }"
              :style="{ background: p.value }"
              :title="p.name"
              :aria-label="p.name"
              @click="setAccent(p.value)"
            >
              <IconGlyph
                v-if="accentColor.toLowerCase() === p.value.toLowerCase()"
                name="check"
                class="swatch-ico"
              />
            </button>
          </div>
        </FieldRow>

        <FieldRow label="自定义颜色">
          <input v-model="accentDraft" class="color-input" type="color" aria-label="自定义主题色" />
          <TextInput
            v-model="accentDraft"
            mono
            placeholder="#2760e8"
            :maxlength="7"
            @keyup.enter="applyCustomAccent"
          />
          <PillButton
            variant="ghost"
            size="sm"
            icon="check"
            :disabled="!accentDraftValid || accentDraft.toLowerCase() === accentColor.toLowerCase()"
            @click="applyCustomAccent"
          >
            应用
          </PillButton>
        </FieldRow>

        <FieldRow label="当前主题色">
          <span class="accent-now">
            <i class="accent-dot" :style="{ background: accentColor }" aria-hidden="true" />
            <code>{{ accentColor }}</code>
          </span>
          <span class="field-note">即时生效；点「恢复默认」回到主题自带的强调色</span>
          <PillButton variant="plain" size="sm" icon="refresh" @click="resetAccent">恢复默认</PillButton>
        </FieldRow>
      </PanelCard>
    </template>

    <!-- ================================================================ 数据 -->
    <template v-else-if="tab === 'data'">
      <PanelCard title="数据占用" desc="按麦麦真实数据目录分类统计（只读）">
        <template #head>
          <PillButton variant="ghost" size="sm" icon="refresh" :loading="dataLoading" @click="loadDataStats">
            刷新
          </PillButton>
        </template>

        <FieldRow label="数据根目录">
          <TextInput :model-value="dataRoot || '—'" mono disabled />
        </FieldRow>

        <p v-if="dataLoading && !dataStats.length" class="field-note">正在统计目录占用…</p>
        <p v-else-if="!dataStats.length" class="field-note">
          未找到可展示的数据分类（目录可能尚未创建）。
        </p>
        <div v-else class="list">
          <div v-for="c in dataStats" :key="c.key" class="list-row">
            <div class="list-main">
              <div class="list-title">
                <span class="list-name">{{ c.label }}</span>
                <StatusBadge v-if="!c.exists" tone="neutral">未创建</StatusBadge>
                <StatusBadge v-else-if="c.keepDays > 0" tone="warn">清理时保留 {{ c.keepDays }} 天</StatusBadge>
                <StatusBadge v-else tone="err">可清理</StatusBadge>
              </div>
              <div class="list-sub">
                <span>{{ fmtBytes(c.bytes) }}</span>
                <span>文件 {{ c.files }} 个</span>
                <span v-if="c.truncated">已达统计上限</span>
                <span class="list-path">{{ c.dir }}</span>
              </div>
            </div>
            <PillButton
              v-if="c.exists && c.bytes > 0"
              variant="danger"
              size="sm"
              icon="trash"
              :loading="cleaningKey === c.key"
              @click="cleanCategory(c)"
            >
              清理
            </PillButton>
          </div>
        </div>

        <span class="field-note">
          统计的是启动器自己管理的目录（数据根 / 应用日志目录），<b>不会</b>去动麦麦安装目录里的文件。
          文件数与体积为实时遍历结果，超大目录会被统计上限截断（行内会标出）。
        </span>
      </PanelCard>

      <!--
        已安装版本（列出 / 真删除）。
        ────────────────────────────────────────────────────────────────────
        这里列的是**磁盘事实**，不是编出来的版本号清单：本启动器没有
        `versions/<tag>` 的多版本布局，磁盘上"同时躺着多份麦麦"只来自
        升级备份（<installDir>.backup-<时间戳>）与安装残留（<installDir>.old-<时间戳>），
        外加受管父目录里同级的其它麦麦副本（见 services/versions.js 顶部文档）。
        deletable / reason 由主进程给出（它是唯一权威），本页只负责呈现 ——
        「正在使用 / 正在运行」的项照原样禁用并写出主进程给的原因，
        删除前的确认框也照 services/versions.js 的语义说清"不可撤销、要重装得重新下载"。
      -->
      <PanelCard title="已安装版本" desc="受管目录里的麦麦版本；删除是不可撤销的真删除">
        <template #head>
          <PillButton
            variant="ghost"
            size="sm"
            icon="refresh"
            :loading="versionsLoading"
            @click="loadVersions"
          >
            刷新
          </PillButton>
        </template>

        <p v-if="versionsLoading && !versions.length" class="field-note">正在读取已安装版本…</p>
        <p v-else-if="!versions.length" class="field-note">
          未发现受管版本{{ versionsMessage ? `：${versionsMessage}` : '（设置里可能还没配置可用的 MaiBot 目录）' }}。
        </p>
        <div v-else class="list" data-testid="settings-versions">
          <div
            v-for="v in versions"
            :key="v.path"
            class="list-row"
            data-testid="settings-version-row"
          >
            <div class="list-main">
              <div class="list-title">
                <span class="list-name">{{ versionTitle(v) }}</span>
                <StatusBadge v-if="v.isActive" tone="ok">正在使用</StatusBadge>
                <StatusBadge v-if="v.running" tone="warn">正在运行</StatusBadge>
                <StatusBadge v-if="!v.isActive && v.kindLabel" tone="neutral">{{ v.kindLabel }}</StatusBadge>
                <StatusBadge v-if="!v.exists" tone="err">目录不存在</StatusBadge>
              </div>
              <div class="list-sub">
                <span class="list-path">{{ v.path }}</span>
                <span v-if="v.sizeBytes > 0">体积 {{ fmtBytes(v.sizeBytes) }}</span>
                <span v-if="v.mtimeMs > 0">修改时间 {{ fmtTime(v.mtimeMs) }}</span>
                <span v-if="v.hasUserData" class="version-note">含用户数据（{{ v.userDataItems.join('、') }}）</span>
                <span v-if="v.reason" class="version-note">{{ v.reason }}</span>
              </div>
            </div>
            <div class="list-actions">
              <PillButton
                variant="solid"
                size="sm"
                icon="refresh"
                :disabled="!canRestore(v)"
                :title="canRestore(v) ? `用备份 ${v.path} 还原成当前使用的安装` : restoreDisabledReason(v)"
                :loading="restoringPath === v.path"
                @click="restoreVersion(v)"
              >
                还原
              </PillButton>
              <PillButton
                variant="danger"
                size="sm"
                icon="trash"
                :disabled="!v.deletable"
                :title="v.deletable ? `删除 ${v.path}` : v.reason || '该版本不允许删除'"
                :loading="deletingPath === v.path"
                @click="removeVersion(v)"
              >
                删除
              </PillButton>
            </div>
          </div>
        </div>

        <span class="field-note">
          受管范围：{{ versionsRootsText }}。这些是麦麦安装目录本身及其升级备份，
          「还原」可以把某个备份换回成当前使用的安装（当前版本会先被保留为一个新备份），
          删除则会直接抹掉该目录（<b>不可撤销</b>），要再装回来只能重新下载；
          正在使用、正在运行或不满足还原条件的项由主进程硬性拒绝（按钮已禁用并写明原因）。
        </span>
      </PanelCard>
    </template>

    <!-- ================================================================ 路径 -->
    <template v-else-if="tab === 'paths'">
      <PanelCard title="麦麦相关目录" desc="每一项都可以用系统文件管理器直接打开">
        <template #head>
          <PillButton variant="ghost" size="sm" icon="refresh" @click="loadPathInfo">刷新</PillButton>
        </template>

        <p v-if="pathLoading" class="field-note">正在读取路径…</p>
        <template v-else>
          <p v-if="!store.paths" class="field-note">
            读不到路径信息（paths:get 没有返回结果）。请先在「总览」或「安装器」里
            配置一个麦麦实例，或检查启动器数据目录是否可读写。
          </p>
          <div v-for="r in pathRows" :key="r.label" class="list-row">
            <div class="list-main">
              <div class="list-title">
                <span class="list-name">{{ r.label }}</span>
                <StatusBadge v-if="!r.path" tone="neutral">未配置</StatusBadge>
              </div>
              <div class="list-sub">
                <span class="list-path" :class="{ empty: !r.path }">{{ r.path || r.desc }}</span>
              </div>
            </div>
            <PillButton
              variant="ghost"
              size="sm"
              icon="folder"
              :disabled="!r.path"
              :title="r.path ? '在文件管理器中打开' : '该目录尚未配置'"
              @click="openPathTarget(r.path)"
            >
              打开
            </PillButton>
          </div>
          <span class="field-note">
            「打开」走系统的文件管理器；目录被删掉后系统会报"找不到路径"，
            这时按提示重新在「高级」里选一次目录即可。
          </span>
        </template>
      </PanelCard>
    </template>

    <!-- ================================================================ 调试 -->
    <template v-else-if="tab === 'debug'">
      <PanelCard title="应用日志" desc="启动器自身的运行日志（launcher.log）">
        <FieldRow label="日志文件">
          <TextInput :model-value="store.appLogFile || '—'" mono disabled />
        </FieldRow>
        <div class="btn-row">
          <PillButton variant="ghost" size="sm" icon="stream" :loading="logLoading" @click="viewAppLog">
            查看最近 200 行
          </PillButton>
          <PillButton variant="ghost" size="sm" icon="folder" @click="openLogDir">打开所在目录</PillButton>
          <PillButton
            v-if="logText"
            variant="plain"
            size="sm"
            :icon="logExpanded ? 'chev-up' : 'chev-down'"
            @click="logExpanded = !logExpanded"
          >
            {{ logExpanded ? '收起' : '展开' }}（{{ logLineCount }} 行）
          </PillButton>
        </div>
        <pre v-if="logText && logExpanded" class="log-box">{{ logText }}</pre>
      </PanelCard>

      <PanelCard title="缓存管理" desc="两类本地缓存，清除后会自动重建">
        <div class="list-row">
          <div class="list-main">
            <div class="list-title"><span class="list-name">安装扫描缓存</span></div>
            <div class="list-sub"><span>{{ scanCacheInfo }}</span></div>
          </div>
          <PillButton variant="ghost" size="sm" icon="trash" @click="clearScanCache">清除</PillButton>
        </div>
        <div class="list-row">
          <div class="list-main">
            <div class="list-title"><span class="list-name">界面设置缓存</span></div>
            <div class="list-sub">
              <span>菜单栏折叠状态、引导进度、自定义主题色等界面偏好（{{ uiCacheKeys.length }} 项）</span>
            </div>
          </div>
          <PillButton variant="ghost" size="sm" icon="trash" @click="clearUiCache">清除</PillButton>
        </div>
        <span class="field-note">
          只清界面偏好与扫描结果缓存，<b>不会</b>动设置文件、日志、麦麦目录里的任何数据。
        </span>
      </PanelCard>

      <PanelCard title="诊断与维护" desc="导出报告、重载界面、恢复默认">
        <div class="list-row">
          <div class="list-main">
            <div class="list-title"><span class="list-name">导出诊断报告</span></div>
            <div class="list-sub">
              <span>汇总版本、平台、端口占用、设置与最近日志，便于排查问题（凭据字段已脱敏）</span>
            </div>
          </div>
          <PillButton variant="ghost" size="sm" icon="download" @click="exportDiagnostics">导出</PillButton>
        </div>
        <div class="list-row">
          <div class="list-main">
            <div class="list-title"><span class="list-name">重载窗口</span></div>
            <div class="list-sub"><span>重新加载前端界面，不退出应用、不影响正在运行的服务</span></div>
          </div>
          <PillButton variant="ghost" size="sm" icon="refresh" @click="reloadWindow">重载</PillButton>
        </div>
        <div class="list-row">
          <div class="list-main">
            <div class="list-title"><span class="list-name danger">恢复全部默认设置</span></div>
            <div class="list-sub">
              <span>清空全部自定义设置与界面缓存，回到出厂状态（不可撤销）</span>
            </div>
          </div>
          <PillButton variant="danger" size="sm" icon="refresh" @click="restoreAllDefaults">
            恢复默认
          </PillButton>
        </div>
      </PanelCard>

      <PanelCard title="进程管理" desc="异常退出后的看门狗行为">
        <FieldRow label="异常自动重启上限">
          <TextInput
            v-model.number="form.service.autoRestartLimit"
            type="number"
            numeric
            :min="0"
            :max="20"
            step="1"
          />
          <span class="field-note">0 = 关闭看门狗（不自动重启）</span>
        </FieldRow>
        <FieldRow label="启动超时">
          <TextInput
            v-model.number="form.service.startupTimeoutMs"
            type="number"
            numeric
            :min="1000"
            :max="300000"
            step="1000"
          />
          <span class="field-note">毫秒，等待端口就绪的最长时间，超时判定为启动失败</span>
        </FieldRow>
        <span class="field-note">
          本项目没有"内存限制 / 崩溃延迟 / 控制台可见"这类进程开关，
          所以这里只给出**真实存在且真的会被主进程读取**的两项。
        </span>
      </PanelCard>

      <PanelCard title="启动参数" desc="由主进程按当前目录实测出来的命令行（只读）">
        <template #head>
          <PillButton variant="ghost" size="sm" icon="refresh" @click="loadStartPayloads">探测</PillButton>
        </template>
        <template v-for="p in startPayloads" :key="p.key">
          <FieldRow :label="p.label">
            <TextInput :model-value="p.text" mono disabled />
          </FieldRow>
        </template>
        <span class="field-note">{{ startPayloadNote }}</span>
        <span class="field-note">
          附加启动参数（例如给 bot.py 追加 <code>--debug</code>）在设置文件里没有对应字段，
          主进程也不读取它，所以本页不做一个"填了也不生效"的输入框。
        </span>
      </PanelCard>

      <PanelCard title="环境检测" desc="Python 版本与依赖；不自动检测，点按钮才开始">
        <template #head>
          <PillButton
            variant="solid"
            size="sm"
            icon="scan"
            :loading="envChecking"
            @click="checkEnvironment"
          >
            开始检测
          </PillButton>
        </template>

        <FieldRow label="Python 解释器">
          <TextInput :model-value="form.service.pythonPath || 'python'" mono disabled />
        </FieldRow>

        <p v-if="!envResult" class="field-note">
          点击右上角「开始检测」，检查 Python 版本与麦麦依赖是否就绪。
        </p>
        <template v-else>
          <div class="list-row">
            <div class="list-main">
              <div class="list-title">
                <span class="list-name">Python</span>
                <StatusBadge :tone="envResult.pythonOk ? 'ok' : 'err'">
                  {{ envResult.pythonOk ? '满足要求' : '版本偏低或未找到' }}
                </StatusBadge>
              </div>
              <div class="list-sub"><span>{{ envResult.pythonText }}</span></div>
            </div>
          </div>
          <div class="list-row">
            <div class="list-main">
              <div class="list-title">
                <span class="list-name">Python 依赖</span>
                <StatusBadge :tone="envResult.missingCount ? 'warn' : 'ok'">
                  {{ envResult.missingCount ? `缺失 ${envResult.missingCount} 个` : '全部就绪' }}
                </StatusBadge>
              </div>
              <div class="list-sub"><span>{{ envResult.depsText }}</span></div>
            </div>
            <PillButton
              variant="solid"
              size="sm"
              icon="download"
              :loading="depsInstalling"
              :disabled="depsInstalling"
              @click="installMissingDeps"
            >
              安装缺失依赖
            </PillButton>
          </div>
          <pre v-if="depsProgress" class="log-box">{{ depsProgress }}</pre>
        </template>
        <span class="field-note">
          检测只读取版本与包列表，不修改任何文件；「安装缺失依赖」会调用麦麦目录里的 Python
          执行 pip，属于真实安装操作，请确认环境后再点。
        </span>
      </PanelCard>
    </template>

    <!-- ================================================================ 关于 -->
    <template v-else-if="tab === 'about'">
      <PanelCard title="关于" desc="版本信息与启动器自身的更新">
        <div class="list-row">
          <div class="list-main">
            <div class="list-title"><span class="list-name">MaiBot Launcher</span></div>
            <div class="list-sub">
              <span>版本 {{ store.info.version || '—' }} · {{ store.info.platform || 'win32' }}</span>
            </div>
          </div>
          <PillButton variant="solid" size="sm" icon="info" @click="goAbout">打开关于页</PillButton>
        </div>

        <!--
          「检查更新」入口就挨着上面那行版本信息 ——
          用户要找"有没有新版本"时，视线落点必然是版本号那一行，
          放到页面别的角落等于让人去找。
          点击打开的是二级窗口（UpdateDialog），更新内容与下载进度都在它里面。

          ⚠️ 这里不是"关于页那份"的副本：本页的「关于」标签是**薄壳**
          （只给版本号 + 一个去关于页的入口，正文在 AboutPanel.vue），
          所以两处各有各的入口，各自服务自己那一屏；这不是重复入口
          （重复入口指同一屏里出现两个按钮）。
        -->
        <div class="list-row">
          <div class="list-main">
            <div class="list-title">
              <span class="list-name">检查更新</span>
              <StatusBadge v-if="updateBadge" :tone="updateBadge.tone">{{ updateBadge.text }}</StatusBadge>
            </div>
            <div class="list-sub">
              <span>{{ updateSummary }}</span>
            </div>
          </div>
          <PillButton
            variant="ghost"
            size="sm"
            icon="download"
            data-testid="settings-check-update"
            @click="openUpdateDialog"
          >
            检查更新
          </PillButton>
        </div>

        <FieldRow label="数据目录">
          <TextInput :model-value="store.info.userData || '—'" mono disabled />
        </FieldRow>
        <span class="field-note">
          许可、源码链接、技术架构与免责声明都在关于页，本页不重复一份（复制两份的内容必然会漂移）。
        </span>
      </PanelCard>
    </template>

    <!-- ================================================================ 高级 -->
    <template v-else-if="tab === 'advanced'">
      <PanelCard title="高级设置" desc="技术细节，默认折叠；改错会让服务起不来">
        <template #head>
          <PillButton
            variant="ghost"
            size="sm"
            :icon="advancedOpen ? 'chev-up' : 'chev-down'"
            @click="advancedOpen = !advancedOpen"
          >
            {{ advancedOpen ? '收起' : '展开' }}
          </PillButton>
        </template>

        <p v-if="!advancedOpen" class="field-note">
          已收起：端口、启动超时、自动重启上限、下载并发数都在这里，点右上角「展开」。
        </p>

        <template v-else>
          <FieldRow label="MaiBot 主服务端口">
            <TextInput
              v-model.number="form.service.ports.maibot"
              type="number"
              numeric
              :min="1"
              :max="65535"
            />
            <span class="field-note">默认 8080，用于判断 MaiBot 是否真正启动完成</span>
          </FieldRow>
          <FieldRow label="MaiBot WebUI 端口">
            <TextInput
              v-model.number="form.service.ports.webui"
              type="number"
              numeric
              :min="1"
              :max="65535"
            />
            <span class="field-note">
              默认 <b>8001</b>：这是 MaiBot <b>自己的控制台页面</b>（麦麦的 WebUI）端口，
              与 SnowLuma 的 WebUI 不是一回事。默认值来自 MaiBot 源码
              <code>startup_bindings.py</code> 的 <code>_DEFAULT_WEBUI_BIND_ADDRESS</code>；
              历史错误值（8090 / 6099）会在读设置时被后端自动纠正回 8001。
            </span>
          </FieldRow>
          <FieldRow label="SnowLuma WebUI 端口">
            <TextInput
              v-model.number="form.service.snowlumaPorts.webui"
              type="number"
              numeric
              :min="1"
              :max="65535"
            />
            <span class="field-note">
              默认 5099，会写进 SnowLuma 自己的 <code>config/runtime.json</code>
            </span>
          </FieldRow>
          <FieldRow label="SnowLuma OneBot 端口">
            <TextInput
              v-model.number="form.service.snowlumaPorts.onebot"
              type="number"
              numeric
              :min="1"
              :max="65535"
            />
            <span class="field-note">
              默认 7988，是本启动器与 MaiBot 侧适配器约定的端口 —— <b>不是 SnowLuma 出厂默认值</b>：
              SnowLuma 只自带 WebUI，OneBot 服务器要你在它自己的 WebUI 里现建，
              端口必须与这里、以及麦麦那边 <code>MaiBot-SnowLuma-Adapter</code> 插件的
              server / port 完全一致（也<b>不要</b>填成上面那个 5099）。
            </span>
          </FieldRow>
          <FieldRow label="启动超时">
            <TextInput
              v-model.number="form.service.startupTimeoutMs"
              type="number"
              numeric
              :min="1000"
              :max="300000"
              step="1000"
            />
            <span class="field-note">毫秒，等待端口就绪的最长时间</span>
          </FieldRow>
          <FieldRow label="自动重启上限">
            <TextInput
              v-model.number="form.service.autoRestartLimit"
              type="number"
              numeric
              :min="0"
              :max="20"
              step="1"
            />
            <span class="field-note">异常退出后自动重启的次数上限；0 表示关闭看门狗</span>
          </FieldRow>
          <!--
            下载并发数的旋钮为什么留在设置里：
            实测同一个源上单连接 6.63 MB/s、自动分 5 段并发 21.23 MB/s（3.2 倍）；
            但并发不是越多越好 —— 镜像会限流，连太多反而每段都变慢。
            后端两处都把值夹在 0~8，所以界面也照这个范围限制，免得填 999 打死网络。
          -->
          <FieldRow label="下载并发数">
            <TextInput
              v-model.number="form.github.downloadThreads"
              type="number"
              numeric
              :min="0"
              :max="8"
              step="1"
            />
            <span class="field-note">
              0 = 自动（按文件大小分 4~8 段），1 = 强制单连接。上限 8：
              瓶颈在单条 TCP 上，再加连接对总吞吐帮助很小，却会加重镜像站负担
            </span>
          </FieldRow>
        </template>
      </PanelCard>
    </template>

    <!-- ============================================================== 通用项 -->
    <!--
      这些是"不属于上面任何一类、但一个都不能丢"的设置：
      仓库 / 镜像 / 目录 / Python 路径 / 启动行为 / 系统集成 / 日志保留。
      没有单独开一个标签（用户给的分类里没有这一类），而是放在「调试」页最下方：
      它们都是"配好就不动"的系统级开关，和调试维护是同一档使用频率。
    -->
    <template v-if="tab === 'debug'">
      <PanelCard title="服务与目录" desc="Python 解释器、服务目录、仓库与镜像">
        <FieldRow label="Python 路径">
          <div class="path-row">
            <TextInput v-model="form.service.pythonPath" placeholder="python" mono />
            <PillButton
              variant="ghost"
              size="sm"
              icon="folder"
              title="选择 Python 可执行文件"
              @click="pickFile('service.pythonPath', { title: '选择 Python 可执行文件' })"
            >
              浏览
            </PillButton>
          </div>
          <span class="field-note">留空使用 PATH 中的 python；也可指定 python.exe 的完整路径</span>
        </FieldRow>

        <FieldRow label="MaiBot 目录">
          <div class="path-row">
            <TextInput v-model="form.service.maibotDir" mono />
            <PillButton
              variant="ghost"
              size="sm"
              icon="folder"
              title="选择 MaiBot 安装目录"
              @click="pickDir('service.maibotDir', { title: '选择 MaiBot 安装目录（含 bot.py）' })"
            >
              浏览
            </PillButton>
          </div>
          <span class="field-note">目录里应当有 <code>bot.py</code>（MaiBot 从来没有 main.py）</span>
        </FieldRow>

        <FieldRow label="SnowLuma 目录">
          <div class="path-row">
            <TextInput v-model="form.service.snowlumaDir" mono />
            <PillButton
              variant="ghost"
              size="sm"
              icon="folder"
              title="选择 SnowLuma 安装目录"
              @click="pickDir('service.snowlumaDir', { title: '选择 SnowLuma 安装目录' })"
            >
              浏览
            </PillButton>
          </div>
          <span class="field-note">
            目录里应当有 <code>index.mjs</code> 与 <code>node.exe</code>；
            只有 <code>index.mjs</code> 时会退回用系统 PATH 里的 node 启动。
            下载安装入口在「安装器」页，本页不再放一个会跑真实下载的按钮。
          </span>
        </FieldRow>

        <FieldRow label="MaiBot 仓库">
          <TextInput v-model="form.github.repo" mono placeholder="Mai-with-u/MaiBot" />
        </FieldRow>
        <FieldRow label="SnowLuma 仓库">
          <TextInput v-model="form.github.snowlumaRepo" placeholder="SnowLuma/SnowLuma" />
          <span class="field-note">「安装器」页一键下载与「版本下载」的预设值都用它</span>
        </FieldRow>

        <FieldRow label="GitHub Token">
          <TextInput v-model="form.github.token" type="password" placeholder="可选，用于提高限额" />
          <span class="field-note">只用于 GitHub API 拉取发布版本，留空即匿名访问</span>
        </FieldRow>

        <FieldRow label="使用镜像">
          <ToggleSwitch v-model="form.github.useMirror" />
          <span class="field-note">直连 GitHub 失败时依次尝试 ghproxy 类镜像</span>
        </FieldRow>

        <div class="roots">
          <div class="roots-head">
            <span class="roots-title">扫描范围</span>
            <span class="field-note">自动查找本地 MaiBot / SnowLuma 安装的目录</span>
          </div>
          <div v-if="!form.general.scanRoots.length" class="roots-empty">
            未自定义，使用系统默认：<span class="roots-defaults">{{ defaultRootsText }}</span>
          </div>
          <!--
            key 用稳定的行 id（不用路径、不用下标）：
            用下标时删中间一行会让后面所有行重建、输入框失焦；
            用路径时每敲一个字符 key 就变一次，同样每键失焦。
          -->
          <div v-for="(root, i) in form.general.scanRoots" :key="rootIdAt(i)" class="path-row">
            <TextInput :model-value="root" mono @update:model-value="(v) => setRoot(i, v)" />
            <PillButton variant="ghost" size="sm" icon="close" title="移除" @click="removeRoot(i)">
              移除
            </PillButton>
          </div>
          <div class="roots-tools">
            <PillButton
              variant="ghost"
              size="sm"
              icon="folder"
              :disabled="form.general.scanRoots.length >= 12"
              @click="addRoot"
            >
              添加目录
            </PillButton>
            <PillButton
              variant="plain"
              size="sm"
              icon="refresh"
              :disabled="!defaultRoots.length"
              title="用系统默认根目录填充列表（之后可逐个删除）"
              @click="useDefaultRoots"
            >
              填入默认目录
            </PillButton>
            <span v-if="form.general.scanRoots.length >= 12" class="field-note">已达上限 12 个</span>
          </div>
          <span class="field-note">
            留空表示使用系统默认目录。裸盘符根（如 <code>C:\</code>）会被拒绝 ——
            全盘扫描耗时很长且几乎必然误报。
          </span>
        </div>
      </PanelCard>

      <PanelCard title="通用" desc="启动行为、系统集成与日志保留">
        <FieldRow label="启动后自动拉起服务">
          <ToggleSwitch v-model="form.general.autoStart" />
          <span class="field-note">
            启动器就绪后自动启动已配置路径的 MaiBot / SnowLuma（找不到入口会自动跳过）
          </span>
        </FieldRow>

        <!--
          开机登录自启：这个开关会真实写入系统登录项（Windows 注册表 Run 键），
          走独立通道而不是普通设置保存，因为需要立刻反馈"系统是否接受了设置"。
        -->
        <FieldRow label="开机登录自启">
          <ToggleSwitch
            :model-value="loginItem.enabled"
            :disabled="!loginItem.supported || loginBusy"
            @update:model-value="onToggleLoginItem"
          />
          <span class="field-note" :class="{ warn: loginItem.supported === false }">
            {{ loginItem.message || '写入系统登录项，登录 Windows 后自动启动本启动器' }}
          </span>
        </FieldRow>

        <FieldRow label="系统通知">
          <ToggleSwitch v-model="form.general.desktopNotify" />
          <span class="field-note">
            服务异常退出或放弃自动重启时发出 Windows 通知（窗口隐藏时也能看到）
          </span>
        </FieldRow>

        <FieldRow label="日志保留行数">
          <TextInput
            v-model.number="form.general.logRetentionLines"
            type="number"
            numeric
            :min="100"
            :max="20000"
            step="100"
          />
          <span class="field-note">日志页默认展示的行数上限</span>
        </FieldRow>
      </PanelCard>
    </template>

    <!--
      吸底保存栏。
      只在真有"需要点应用才生效"的字段时出现（个性化页全是即时生效的设置，
      底下挂一条永远禁用的「应用」只会让人以为坏了）。
      未保存就切页由 onBeforeRouteLeave 拦一道（见脚本里的说明）。
    -->
    <div v-if="showSaveBar" class="save-bar">
      <PillButton variant="plain" size="sm" icon="refresh" @click="onReset">恢复默认</PillButton>
      <PillButton variant="plain" size="sm" icon="save" @click="onExport">导出</PillButton>
      <span class="bar-spacer" />
      <button class="act-cancel" type="button" :disabled="!dirty" title="放弃修改" @click="onCancel">
        <IconGlyph name="close" />
        <span>取消</span>
      </button>
      <button class="act-apply" type="button" :disabled="!dirty || saving" title="保存设置" @click="onApply">
        <LoadingSpinner v-if="saving" size="sm" inline />
        <span v-else>应用</span>
      </button>
    </div>

    <!--
      检查更新的二级窗口。
      挂在设置页的根容器里（不是 .panel 内部），因为它是 fixed 定位的模态层，
      位置与页面排版无关；放这里的好处是生命周期与设置页一致 ——
      离开设置页就自动卸载，不会留一个订阅在后台。
    -->
    <UpdateDialog v-model:open="updateOpen" />
  </div>
</template>

<script setup>
/*
================================================================================
技术文档：src/renderer/views/SettingsPanel.vue
职责：设置页（顶部标签栏 + 七个面板）。
================================================================================
  本次重做的三件事：

  1) 结构：从"一条纵向长卷"改成**顶部横向标签栏**，七个面板：
       个性化 / 数据 / 路径 / 调试 / 关于 / 高级
       外加「服务与目录」「通用」两张卡挂在调试页下方
       （这两类设置既不属于上面任何一类，又是"一个都不能丢"的既有能力）。
     照的是旧版 Tauri + React 设置页的**功能与交互**（SettingsPage.tsx），
     不是照抄它的语法：那是 Chakra UI + React，这里是 Vue 3 + 自研组件。

  2) 新增（旧版有、这里原本没有的）：
       · 主题色自定义：预设色 + 自定义取色 + 恢复默认（此前完全没有）；
       · 数据面板：按真实数据目录分类统计 + 带"不可撤销"确认的清理；
       · 路径面板：各目录逐项「打开」；
       · 调试面板：应用日志查看 / 缓存管理 / 诊断与维护 / 进程管理 / 启动参数 /
         环境检测（开始检测 + 安装缺失依赖）；
       · 关于：只放入口，正文在已有的 AboutPanel.vue，不重复造第二份。

  3) 删除：**LLM 配置整块**（Base URL / 模型 / API Key / Temperature /
     Max Tokens / GitHub Token 之外的自定义 LLM 接口）。
     用户明确要求从设置界面、状态、事件里彻底移除。
     ⚠️ 主进程的 LLM 接口（src/main/services/llm.js、llm:call / llm:custom /
     llm:models / llm:abort 等 IPC 通道）**一个都没动** ——
     工具箱的「AI 对话」还在用它们。本次只删渲染层设置页里的 UI 与相关状态。
     保留的 GitHub「Token」是拉取 Release 用的，不是 LLM 凭据。
================================================================================
*/
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import PanelCard from '../components/ui/PanelCard.vue';
import FieldRow from '../components/ui/FieldRow.vue';
import TextInput from '../components/ui/TextInput.vue';
import ToggleSwitch from '../components/ui/ToggleSwitch.vue';
import SegmentedControl from '../components/ui/SegmentedControl.vue';
import PillButton from '../components/ui/PillButton.vue';
import StatusBadge from '../components/ui/StatusBadge.vue';
import IconGlyph from '../components/IconGlyph.vue';
import LoadingSpinner from '../components/ui/LoadingSpinner.vue';
/* 本页「关于」标签的检查更新入口所打开的二级窗口（模态，含更新内容与下载进度） */
import UpdateDialog from '../components/UpdateDialog.vue';
import { toast } from '../composables/useToast.js';
import {
  applySettings,
  checkPorts,
  checkPrerequisites,
  cleanDataCategory,
  confirmDialog,
  deleteManagedVersion,
  discardDraft,
  exportSettings,
  getDataStats,
  getDefaultScanRoots,
  getThemePreference,
  installDependencies,
  isDirty,
  listManagedVersions,
  loadAppLogs,
  loadLoginItemState,
  loadPaths,
  loadSettings,
  openPath,
  resetSettings,
  resolveStartPayload,
  restoreBackup,
  saveFileDialog,
  selectDirectory,
  selectFile,
  setLoginItem,
  setThemePreference,
  store,
  subscribeDepsStatus
} from '../stores/app-store.js';

/* --------------------------------------------------------------- 标签与页面 */

/** 标签表（图标名对应 IconGlyph 内置的形状表） */
const TABS = [
  { id: 'appearance', label: '个性化', icon: 'wand' },
  { id: 'data', label: '数据', icon: 'cube' },
  { id: 'paths', label: '路径', icon: 'folder' },
  { id: 'debug', label: '调试', icon: 'sliders' },
  { id: 'about', label: '关于', icon: 'info' },
  { id: 'advanced', label: '高级', icon: 'bolt' }
];

const tab = ref('appearance');

/*
  标签切换的入场动画（2026-09-28 按用户要求补上）。
  ────────────────────────────────────────────────────────────────────────
  为什么这样写，而不是给内容再套一层 <Transition>：
    · 内容区是 `<template v-if / v-else-if>` 的一串分支，直接渲染在 .panel 下，
      而 .panel 是纵向排布（卡片之间的间距由 .panel 的 gap/子元素边距决定）。
      套一层包裹 div 会把它们变成一个 flex/grid 子项，间距会整体塌掉 ——
      为了动画改布局不划算。
    · 所以只改一个类：`.panel.pane-anim > .tip ~ *` 命中"提示条之后的所有内容节点"，
      标签栏自己不动（否则点一下标签，标签栏也跟着跳）。
  · 用 animation 而不是 transition：内容是 v-if 直接挂上来的，没有"起始状态"，
    animation 每次都从头播（先摘类、下一帧加回来，就是让浏览器重新起一次动画）。
  · 时长/缓动与全项目二级窗口一致：--dur-base(180ms) + --ease-standard。
    减弱动效由 theme.css 的全局规则统一压到 --dur-fast，这里不用再写一遍。
*/
const paneAnim = ref(true);
let paneRaf = 0;
watch(tab, () => {
  paneAnim.value = false;
  cancelAnimationFrame(paneRaf);
  paneRaf = requestAnimationFrame(() => {
    paneAnim.value = true;
  });
});
onBeforeUnmount(() => cancelAnimationFrame(paneRaf));

/**
 * 是否需要吸底保存栏。
 * 个性化页全是即时生效的显示设置；关于页没有可编辑项 ——
 * 这两页挂一条永远禁用的「应用」按钮只会让人以为坏了，所以直接不显示。
 */
const showSaveBar = computed(() => tab.value !== 'appearance' && tab.value !== 'about');

const router = useRouter();
function goAbout() {
  router.push('/about');
}

/* ------------------------------------------------------------ 检查更新入口 */

/**
 * 二级窗口的开关。
 * 这里**不自己发检查请求**：窗口一打开自己会检查（见 UpdateDialog 的 onMounted），
 * 避免"点一次按钮发两次请求"（两个地方都调 checkLauncherUpdate 的经典重复）。
 */
const updateOpen = ref(false);

function openUpdateDialog() {
  updateOpen.value = true;
}

/**
 * 版本行右侧的徽标。
 * ⚠️ 只有**真的检查出了结论**才显示徽标：没查过就什么都不显示，
 * 而不是默认挂一个"已是最新" —— 那等于替上游打包票（用户可能落后好几个版本）。
 */
const updateBadge = computed(() => {
  const p = store.update?.phase;
  if (p === 'available') return { tone: 'theme', text: '有新版本' };
  if (p === 'ready') return { tone: 'ok', text: '已下载' };
  if (p === 'latest') return { tone: 'ok', text: '已是最新' };
  if (p === 'error') return { tone: 'err', text: '检查失败' };
  if (p === 'downloading') return { tone: 'warn', text: '下载中' };
  return null;
});

/** 版本行下面的说明：显示真实结论或真实失败原因，不编话 */
const updateSummary = computed(() => {
  const u = store.update;
  if (!u || u.phase === 'idle') return '从官方 Release 检查启动器自身的新版本';
  if (u.phase === 'checking') return '正在检查更新…';
  if (u.phase === 'available') return u.message || `发现新版本 ${u.latest}`;
  if (u.phase === 'latest') return u.message || '已是最新版本';
  if (u.phase === 'downloading') return `正在下载 ${Math.round(Number(u.percent) || 0)}%`;
  if (u.phase === 'ready') return '安装包已下载并校验，打开窗口点「重启并安装」即可';
  return u.message || '检查更新失败';
});

/* ------------------------------------------------------------------ 设置草稿 */

const reloading = ref(false);
const saving = ref(false);
/** 高级页默认折叠（技术细节不该是第一眼看到的东西） */
const advancedOpen = ref(false);

/**
 * 写入嵌套字段（'service.pythonPath' → form.service.pythonPath）。
 * 必须取 .value —— form 是 computed ref；直接写 form.xxx 会挂到 ref 对象自身上，
 * 结果是"点完浏览什么都没变，而且 isDirty() 恒为 false，应用按钮一直禁用"。
 */
function setByPath(pathStr, value) {
  const root = form.value;
  if (!root) return;
  const parts = pathStr.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 选择目录并写入指定字段 */
async function pickDir(pathStr, opts = {}) {
  const r = await selectDirectory(opts);
  if (!r?.ok) {
    if (r?.message && r.message !== '已取消') toast(r.message, 'warn');
    return;
  }
  if (r.path) setByPath(pathStr, r.path);
}

/** 选择文件并写入指定字段 */
async function pickFile(pathStr, opts = {}) {
  const r = await selectFile(opts);
  if (!r?.ok) {
    if (r?.message && r.message !== '已取消') toast(r.message, 'warn');
    return;
  }
  if (r.path) setByPath(pathStr, r.path);
}

/** 默认值唯一来源是主进程（store.info.defaults），前端不持有默认常量副本 */
function defaults() {
  return store.info.defaults || { github: {}, service: { ports: {} }, general: {} };
}

/** 深合并：patch 覆盖 base（对象递归合并，数组/标量直接替换） */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (!patch || typeof patch !== 'object') return patch === undefined ? base : patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * 保证 SnowLuma 的嵌套字段存在。
 * deepMerge(defaults, draft) 正常会补上，但界面不能只依赖后端默认值：
 * 若 defaults 里还没有这几个字段（版本错配），模板里的
 * form.service.snowlumaPorts.webui 会在渲染期抛 TypeError，整页打空。
 * 这里只补结构、不动已有值。
 */
function ensureSnowlumaShape(target) {
  const svc = (target || store.draft)?.service;
  if (!svc) return;
  if (typeof svc.snowlumaDir !== 'string') svc.snowlumaDir = '';
  if (!svc.snowlumaPorts || typeof svc.snowlumaPorts !== 'object') {
    svc.snowlumaPorts = { webui: 5099, onebot: 7988 };
  } else {
    if (svc.snowlumaPorts.webui === undefined) svc.snowlumaPorts.webui = 5099;
    if (svc.snowlumaPorts.onebot === undefined) svc.snowlumaPorts.onebot = 7988;
  }
}

/**
 * 补齐 draft 结构。
 * 注意：设置页**不再持有 LLM 相关结构** —— 上面这层只保证模板一定会访问到的
 * 四组（github / service / service.ports / general）存在。
 * settings.llm 仍然原样留在 draft 里（主进程的 AI 工具箱要用），
 * 只是本页既不改它、也不显示它。
 */
function ensureDraft() {
  const merged = deepMerge(defaults(), store.draft || {});
  merged.github = merged.github || {};
  merged.service = merged.service || {};
  merged.service.ports = merged.service.ports || {};
  merged.general = merged.general || {};
  if (!Array.isArray(merged.general.scanRoots)) merged.general.scanRoots = [];
  store.draft = merged;
  ensureSnowlumaShape(merged);
  return store.draft;
}

const form = computed(() => {
  if (!store.draft) ensureDraft();
  return store.draft;
});

/* 首次补齐必须在 form 声明之后（ensureSnowlumaShape 从 form 取值，否则踩 TDZ） */
ensureDraft();

const dirty = computed(() => isDirty());

/* ------------------------------------------------------------- 扫描根目录 */

const defaultRoots = ref([]);
const defaultRootsText = computed(() =>
  defaultRoots.value.length ? defaultRoots.value.join('、') : '读取中…'
);

async function addRoot() {
  if (form.value.general.scanRoots.length >= 12) {
    toast('最多 12 个自定义根目录', 'warn');
    return;
  }
  const r = await selectDirectory({ title: '选择要扫描的目录' });
  if (!r?.ok) {
    if (r?.message && r.message !== '已取消') toast(r.message, 'warn');
    return;
  }
  if (!r.path) return;
  if (form.value.general.scanRoots.includes(r.path)) {
    toast('该目录已在列表中', 'info');
    return;
  }
  form.value.general.scanRoots.push(r.path);
}

let rootIdSeq = 0;
let rootIds = [];

function rootIdAt(i) {
  while (rootIds.length <= i) rootIds.push(`r${++rootIdSeq}`);
  return rootIds[i];
}

function removeRoot(i) {
  form.value.general.scanRoots.splice(i, 1);
  /* 同步删掉同一位置的 id：只截断尾部会让后面所有行配到上一行的 id */
  rootIds.splice(i, 1);
}

function setRoot(i, value) {
  form.value.general.scanRoots[i] = value;
}

function useDefaultRoots() {
  form.value.general.scanRoots = defaultRoots.value.slice(0, 12);
}

/*
  让行 id 的数量始终跟行数一致，无论行是从哪条路径变化的。
  flush:'sync' 是为了在渲染前就对齐，避免出现一帧的错配。
*/
watch(
  () => form.value?.general?.scanRoots?.length ?? 0,
  (n) => {
    if (rootIds.length > n) rootIds = rootIds.slice(0, n);
    for (let i = rootIds.length; i < n; i += 1) rootIds.push(`r${++rootIdSeq}`);
  },
  { flush: 'sync' }
);

/* ------------------------------------------------------------ 开机自启状态 */

/** 系统「开机自启」的真实注册状态（来自主进程，不是设置文件里的意图） */
const loginItem = ref({ ok: false, enabled: false, supported: true, message: '' });
const loginBusy = ref(false);

async function onToggleLoginItem(next) {
  loginBusy.value = true;
  try {
    const r = await setLoginItem(Boolean(next));
    loginItem.value = {
      ok: r.ok,
      enabled: r.enabled,
      supported: r.supported,
      message: r.message
    };
    if (!r.ok) toast(r.message || '设置开机自启失败', 'error', 5000);
    else if (!r.supported) toast('开发模式下不会注册系统登录项', 'info', 4000);
    else toast(r.enabled ? '已开启开机自启' : '已关闭开机自启', 'success');
  } finally {
    loginBusy.value = false;
  }
}

/** 每次进页面都重新读，因为用户可能在系统设置里改过 */
async function refreshLoginItem() {
  const r = await loadLoginItemState();
  loginItem.value = {
    ok: r.ok,
    enabled: r.enabled,
    supported: r.supported,
    message: r.message
  };
}

/* ------------------------------------------------------------ 主题（模式 + 色） */

/*
  主题模式三选一。
  'system' 放最后：它是默认值，但用户最常主动选的是明确的浅/深两档。
*/
const THEME_OPTIONS = [
  { value: 'light', label: '浅色', hint: '始终使用浅色界面' },
  { value: 'dark', label: '深色', hint: '始终使用深色界面' },
  { value: 'system', label: '跟随系统', hint: '跟随 Windows 的浅色 / 深色设置' }
];

const themePref = ref('system');
/** 换主题期间禁用控件，避免连点产生竞态（主进程每次都要写盘） */
const themeBusy = ref(false);
/** 解析后的实际主题，仅用于解释"跟随系统"当前落到了哪一档 */
const themeResolved = ref('light');

const themeNote = computed(() => {
  if (themePref.value !== 'system') {
    return '立即生效并记住选择，与 Windows 的深浅色设置无关';
  }
  return `跟随 Windows 设置，当前为${themeResolved.value === 'dark' ? '深色' : '浅色'}`;
});

/**
 * 从主进程读一次偏好。
 * 读盘（而不是只信 draft）：设置文件是用户可编辑的纯文本，draft 里的值可能已过期。
 */
async function refreshThemePreference() {
  const r = await getThemePreference();
  if (!r.ok) return;
  themeSyncing = true;
  themePref.value = r.preference;
  themeResolved.value = r.theme;
  await nextTick();
  themeSyncing = false;
}

/** 标记"这次 themePref 变化来自读盘、不是用户操作"，避免进页面就白写一次设置文件 */
let themeSyncing = false;

/**
 * 切换主题模式：立即生效 + 持久化，不经过「应用」。
 * 主进程套用主题后会自己推 theme:changed，外壳（AppLayout）收到就换 data-theme，
 * 所以这里不需要自己去写 documentElement。
 */
async function switchTheme(next) {
  if (themeBusy.value) return;
  themeBusy.value = true;
  try {
    const r = await setThemePreference(next);
    if (!r.ok) {
      toast(r.message || '主题设置失败', 'error');
      await refreshThemePreference();
      return;
    }
    themeResolved.value = r.theme;
  } finally {
    themeBusy.value = false;
  }
}

/* flush:'sync' 是正确性要求：默认的 'pre' 会把回调推迟到组件更新前的微任务里，
   而 refreshThemePreference 是"置守卫 → 改值 → await nextTick → 清守卫"，
   推迟执行时守卫已经在 await 那一拍被清掉，读盘会被误判成用户操作。 */
watch(
  themePref,
  (v, old) => {
    if (v === old || themeSyncing) return;
    switchTheme(v);
  },
  { flush: 'sync' }
);

/* ---------------------------------------------------------------- 主题色自定义 */

/** 预设色：都是"实底能压得住白字"或"当文字色能过 AA"的中深色号 */
const PRESET_COLORS = [
  { name: '默认蓝', value: '#2760e8' },
  { name: '青色', value: '#0f7b8a' },
  { name: '绿色', value: '#128a5a' },
  { name: '琥珀', value: '#a2620a' },
  { name: '珊瑚', value: '#c2413c' },
  { name: '洋红', value: '#a8308f' },
  { name: '紫罗兰', value: '#5b3fd6' },
  { name: '石板', value: '#4a5568' }
];

const ACCENT_KEY = 'maibot-launcher.accent.v1';
/** 主进程/主题自带的强调色（"恢复默认"就是把这个叠加层整个摘掉） */
const DEFAULT_ACCENT = '#2760e8';

const accentColor = ref(readSavedAccent());
const accentDraft = ref(accentColor.value);
const accentDraftValid = computed(() => /^#[0-9a-fA-F]{6}$/.test(accentDraft.value.trim()));

function readSavedAccent() {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : DEFAULT_ACCENT;
  } catch (_) {
    return DEFAULT_ACCENT;
  }
}

/* 便捷的 hex ↔ rgb ↔ hsl 工具（都不依赖任何库） */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const p = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

/** 与 black / white 逐通道混合（ratio 的 1 = 白色） */
function mixWith({ r, g, b }, ratio, target) {
  const t = target === 0 ? 0 : 255;
  return { r: r + (t - r) * ratio, g: g + (t - g) * ratio, b: b + (t - b) * ratio };
}

/**
 * 实底强调色上的文字色。
 * 走 WCAG 的相对亮度：亮底用深墨字、暗底用白字 ——
 * 所以不管用户选多亮的黄，按钮上的文字都还看得清（写死白字会直接糊掉）。
 */
function relLuminance(rgb) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

function readableOn(rgb) {
  return relLuminance(rgb) > 0.42 ? '#101216' : '#ffffff';
}

/**
 * 强调色族里"彩色文字"那一支（--accent-ink）必须**浅深各算各的**。
 * ──────────────────────────────────────────────────────────────────────
 * 🔴 实测复现的 P0：注入层原来用一条 `:root[data-theme]` 同时喂两套主题，
 *    算出来的墨色（默认蓝 → #09422b）在深色下压在 --seg-active-bg
 *    （--surface-3 = #292d34）上只有 **1.2:1**，"个性化/数据/…"选中的那一颗
 *    以及 .seg-btn.on 基本读不出来；浅色下同一颗是 11.5:1（正常）。
 *    根因就是这条选择器深浅通吃，把 theme.css 里 `[data-theme='dark']`
 *    自带的 --accent-ink:#6997ff 一起盖掉了。
 *
 * 规则（与 theme.css 一致）：浅色 = 往黑里压、深色 = 往白里提。
 * 但**幅度必须按对比度算**，不能写死比值 —— 写死 0.52 这种值
 * 在亮色号（比如琥珀 #a2620a）上仍然过不了 AA。
 * 这里直接解 WCAG：给定底色的相对亮度，求需要多黑 / 多白的墨。
 *   · 浅底（卡片色）：L_ink ≤ (L_bg + 0.05) / R − 0.05
 *   · 深底（深色卡片）：L_ink ≥ R × (L_bg + 0.05) − 0.05
 * 然后二分出"刚好过线"的混合比例，再留一档余量，避免卡在临界值上。
 */
const INK_CONTRAST_TARGET = 4.6;
/* 浅色的底：最亮的一层是 --paper-full；深色的底：卡片里最亮的是 --surface-3 */
const INK_LIGHT_BG = { r: 255, g: 255, b: 255 };
const INK_DARK_BG = { r: 41, g: 45, b: 52 };

function mixToward(rgb, ratio, toWhite) {
  const t = toWhite ? 255 : 0;
  return { r: rgb.r + (t - rgb.r) * ratio, g: rgb.g + (t - rgb.g) * ratio, b: rgb.b + (t - rgb.b) * ratio };
}

/** 混到"刚好满足 target 对比度"，再退回一档让它有余量而不是压线 */
function inkFor(rgb, bg, toWhite) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const l = relLuminance(mixToward(rgb, mid, toWhite));
    const lBg = relLuminance(bg);
    const cr = toWhite ? (l + 0.05) / (lBg + 0.05) : (lBg + 0.05) / (l + 0.05);
    if (cr >= INK_CONTRAST_TARGET) hi = mid;
    else lo = mid;
  }
  return rgbToHex(mixToward(rgb, Math.min(1, hi * 1.25), toWhite));
}

/*
  两套主题各自的强调色基色。
  ──────────────────────────────────────────────────────────────────────
  默认从 <html> 上读**计算后**的 --accent（探测时会依次挂 light / dark
  两个 data-theme，见 probeThemeAccent），所以 theme.css 以后改基色这里自动跟手。
  探测失败时（极老的引擎 / 拿不到计算值）退回这两个实测值 ——
  它们就是 theme.css 里 :root[data-theme='light'|'dark'] 的 --accent。
*/
const ACCENT_FALLBACK = { light: '#2760e8', dark: '#5b8dff' };

function probeThemeAccent() {
  const el = document.documentElement;
  const read = (theme) => {
    const prev = el.getAttribute('data-theme');
    el.setAttribute('data-theme', theme);
    const v = getComputedStyle(el).getPropertyValue('--accent').trim();
    if (prev === null) el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', prev);
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
  };
  try {
    const light = read('light') || ACCENT_FALLBACK.light;
    const dark = read('dark') || ACCENT_FALLBACK.dark;
    return { light, dark };
  } catch (_) {
    return { ...ACCENT_FALLBACK };
  }
}

/*
  叠加层。用一个**内联注入的 <style>** 表达，而不是去改 theme.css ——
  theme.css 是全局共享文件（本次改造明确不允许改它），
  而"用户选的色"本来就是运行期状态，不是设计常量。
  只覆盖 --accent 一族：--theme-color / --theme-tint / --theme-line /
  --route-ink / --route-tint 全都是 `var(--accent…)` 的别名，
  改基色它们自动跟手，不需要在 JS 里再抄一份。
*/
let accentStyleEl = null;

function applyAccentToDom(hex) {
  const rgb = hexToRgb(hex);
  const hover = rgbToHex(mixWith(rgb, 0.14, 0));
  const active = rgbToHex(mixWith(rgb, 0.26, 0));
  const deep = rgbToHex(mixWith(rgb, 0.3, 1));
  /*
    浅 / 深各算各的墨色（见上面 inkFor 的说明）。
    基色用**当前这套主题**的计算值：浅色的基色是 #2760e8 那一支，
    深色是 #5b8dff 那一支 —— 用户选的色只是把它们整体替换，
    两套主题各自的明暗关系仍然成立。
  */
  const { light: lightAccent, dark: darkAccent } = probeThemeAccent();
  const inkLight = inkFor(hexToRgb(lightAccent), INK_LIGHT_BG, false);
  const inkDark = inkFor(hexToRgb(darkAccent), INK_DARK_BG, true);
  const soft = `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, 0.1)`;
  const strong = `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, 0.16)`;
  const line = `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, 0.32)`;
  const onAccent = readableOn(rgb);

  if (!accentStyleEl) {
    accentStyleEl = document.createElement('style');
    accentStyleEl.id = 'maibot-accent-override';
    document.head.appendChild(accentStyleEl);
  }
  /*
    ⚠️ 选择器必须写 `:root[data-theme]` 而不是裸 `:root`。
    theme.css 里浅色是**两层**声明的：基础 `:root{--accent:…}` 之外还有一层
    `:root[data-theme='light']{--accent:…}`（深色则是 `[data-theme='dark']`）——
    带属性选择器的那层优先级是 (0,2,0)，压得过裸 `:root` 的 (0,1,0)。
    实测：注入 `:root{--accent:#c2413c}` 后 getComputedStyle 仍然读到 #2760e8，
    页面上一点变化都没有。加上 [data-theme] 后优先级追平，靠"后加载者胜"拿到想要的色，
    且浅色 / 深色两套各自成立（此时深浅差异只是明暗，不该再把强调色锁回蓝色）。

    🔴 但"能用一条规则"不等于"该用一条规则"：--accent-ink 恰恰是**不该**合并的那一个
    （它是文字色，浅底要深墨、深底要亮墨，两种取值互相排斥）。所以这里拆成
    light / dark 两条，与 theme.css 的两层声明的优先级关系保持完全一致
    （同样是 (0,2,0)，同样靠后加载者胜），只是不再互相覆盖。
  */
  const common =
    `--accent:${hex};` +
    `--accent-hover:${hover};` +
    `--accent-active:${active};` +
    `--accent-deep:${deep};` +
    `--accent-tint:${soft};` +
    `--accent-tint-soft:${soft};` +
    `--accent-tint-strong:${strong};` +
    `--accent-line:${line};` +
    `--focus-ring:0 0 0 2px ${line};`;
  accentStyleEl.textContent =
    `:root[data-theme='light']{${common}--accent-ink:${inkLight};}` +
    `:root[data-theme='dark']{${common}--accent-ink:${inkDark};}`;

  /*
    实底控件上的文字色必须**内联**到 <html>：
    theme.css 里 [data-theme='dark'] 把 --on-accent 定成深墨字，
    而那条规则会盖掉上面样式表里的声明；内联优先级更高，正好用来表达
    "这一颗自定义色的对比色"。
    卸载 / 恢复默认时**直接摘掉**这条内联声明（见 removeAccentOverride 的说明），
    不保存、也不回写任何捕获值。
  */
  document.documentElement.style.setProperty('--on-accent', onAccent);
}

function removeAccentOverride() {
  if (accentStyleEl) {
    accentStyleEl.remove();
    accentStyleEl = null;
  }
  /*
    🔴 这里**不能**把"注入前捕获的旧 --on-accent"写回 html.style。
    那个值是按捕获那一刻的底色算出来的（浅色底 → #ffffff、深色底 → #101216），
    用户在设置页里切了主题（比如切成深色）再离开时它已经过期；而内联声明优先级
    最高，写回去就等于把深色主题永久钉在浅色文字色上，直到重启才恢复。
    直接摘掉内联声明，让 theme.css 重新接管 —— 三层都有定义，不会退化成空值：
      · :root{--on-accent:#ffffff}                （theme.css:138）
      · [data-theme='dark']{--on-accent:#101216}  （theme.css:400）
      · :root[data-theme='light']{--on-accent:#ffffff}（theme.css:514）
  */
  document.documentElement.style.removeProperty('--on-accent');
}

function setAccent(hex) {
  const v = String(hex || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
  accentColor.value = v.toLowerCase();
  accentDraft.value = accentColor.value;
  applyAccentToDom(accentColor.value);
  try {
    localStorage.setItem(ACCENT_KEY, accentColor.value);
  } catch (_) {
    /* 存不了只影响持久化 */
  }
  toast(`主题色已切换为 ${accentColor.value}`, 'success', 1800);
}

function applyCustomAccent() {
  if (!accentDraftValid.value) {
    toast('请输入 #RRGGBB 形式的颜色值', 'warn');
    return;
  }
  setAccent(accentDraft.value.trim());
}

/** 把"内存里的主题色 + 已注入的叠加层"一起恢复默认（不碰 localStorage、不弹提示） */
function resetAccentState() {
  accentColor.value = DEFAULT_ACCENT;
  accentDraft.value = DEFAULT_ACCENT;
  removeAccentOverride();
}

function resetAccent() {
  resetAccentState();
  try {
    localStorage.removeItem(ACCENT_KEY);
  } catch (_) {
    /* 忽略 */
  }
  toast('已恢复默认主题色', 'success', 1800);
}

/* ------------------------------------------------------------------ 数据面板 */

const dataStats = ref([]);
const dataRoot = ref('');
const dataLoading = ref(false);
const cleaningKey = ref('');

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = v / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

async function loadDataStats() {
  dataLoading.value = true;
  try {
    const r = await getDataStats();
    dataStats.value = Array.isArray(r?.stats) ? r.stats : [];
    dataRoot.value = r?.root || '';
    if (!r?.ok) toast(r?.message || '统计失败', 'error');
    return r;
  } finally {
    dataLoading.value = false;
  }
}

/**
 * 清理某个分类。
 * 用户要求"清理前要有明确的不可撤销确认"，所以这里用主进程的原生确认框
 * （不是 window.confirm）：标题、警告文案、默认落在「取消」上。
 */
async function cleanCategory(cat) {
  /*
    先预演（dryRun）：按主进程**同一套**保留规则算出"到底会删多少"，再让用户确认。
    此前确认框里用的是分类目录的总占用（cat.bytes / cat.files）—— 对 logs 这种
    "只删 7 天前"的分类明显虚高，用户看不到真正会删掉什么、删多少。
    预演失败时如实报错并**中止**：绝不能把"没算出来"当成"没什么可删的"。
  */
  let preview = null;
  try {
    preview = await cleanDataCategory({ category: cat.key, dryRun: true });
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

  const yes = await confirmDialog({
    type: 'warning',
    title: `清理「${cat.label}」`,
    message: `预演结果：将删除 ${preview.wouldRemove} 项（${preview.files} 个文件，${preview.humanSize}）。`,
    detail:
      (cat.keepDays > 0
        ? `只保留最近 ${cat.keepDays} 天的内容，更早的会被永久删除。此操作不可撤销。`
        : '此操作不可撤销，删除后无法恢复。')
      + (preview.kept ? `\n保留 ${preview.kept} 项。` : '')
      + (preview.items?.length
        ? `\n例如：${preview.items.slice(0, 5).join('、')}${preview.itemsTruncated ? ' …' : ''}`
        : ''),
    buttons: ['取消', '确认清理'],
    defaultId: 0
  });
  if (!yes) return;

  cleaningKey.value = cat.key;
  const before = Number(cat.bytes) || 0;
  try {
    const r = await cleanDataCategory({ category: cat.key, dryRun: false });
    if (!r.ok) {
      toast(r.message || '清理失败', 'error', 5000);
      return;
    }
    toast(r.message || '清理完成', 'success', 3500);
    /* 释放量用"清理前后实测差值"，而不是估算：主进程只回删除计数，不回占用字节 */
    await loadDataStats();
    const now = (dataStats.value.find((c) => c.key === cat.key) || {}).bytes;
    const freed = Number.isFinite(Number(now)) ? Math.max(0, before - Number(now)) : 0;
    if (freed > 0) {
      toast(`「${cat.label}」释放了 ${fmtBytes(freed)}`, 'success', 4000);
    }
  } finally {
    cleaningKey.value = '';
  }
}

/* -------------------------------------------------------------- 已安装版本 */

/*
  数据来源：app-store.js 的 listManagedVersions()（IPC version:list）。
  它回的是主进程给出的磁盘事实，每项形如：
    { path, name, version, versionSource, kind, exists, deletable, reason,
      running, pid, sizeBytes, fileCount, mtimeMs, hasUserData, userDataItems }
  `kind` 三态：active（当前使用的目录）/ backup（升级备份）/ install（同级副本）。

  ⚠️ 这里**不**自己算 deletable：主进程是唯一权威（受管根前缀、目录身份、
  "正在使用/正在运行"都在 services/versions.js 里重新校验）。界面只把
  deletable/reason 呈现出来，禁用项也照抄主进程给的原因，不改写、不软化。

  还原（「还原」按钮）同理：这里只做**呈现层**的启停判断（哪个按钮看起来能按），
  真正的五条硬性判定全在主进程 github.restoreBackup 里 —— 备份得真是一套麦麦安装、
  麦麦不能在运行、路径得在受管根内部、命名得符合备份规则、交换前先把当前版本
  另存为新备份。渲染层的禁用只是提示，绝不是安全边界。
*/
const versions = ref([]);
const versionsLoading = ref(false);
const versionsMessage = ref('');
const versionsRoots = ref([]);
const deletingPath = ref('');
/** 正在还原哪一个备份（按钮的进行中状态；一次只允许一个） */
const restoringPath = ref('');
/**
 * 主进程报告的"托管中的麦麦进程还在跑"（IPC version:list 的 running 字段）。
 * 还原会替换它正在使用的安装目录，所以只要它活着就禁用「还原」按钮并写明原因；
 * 真正的硬性拒绝仍在主进程 github.restoreBackup 里。
 */
const versionsRunning = ref(false);
/** 主进程给出的"当前使用的版本目录"，用来给那一行打「正在使用」标记 */
const activePath = ref('');

/** 列表为空时，把受管根写出来，便于用户判断"为什么一个都没有" */
const versionsRootsText = computed(() =>
  versionsRoots.value.length ? versionsRoots.value.join('；') : '（主进程未返回受管根）'
);

/** `kind` → 中文标签 */
function versionKindLabel(kind) {
  if (kind === 'active') return '当前使用';
  if (kind === 'backup') return '升级备份';
  if (kind === 'install') return '同级副本';
  return '';
}

/** 主标题：优先"麦麦 <版本号>"，没有版本号就用目录名 */
function versionTitle(v) {
  const ver = String(v?.version || '').trim();
  if (ver) return `MaiBot ${ver}${v.versionSource === 'directory' ? '（目录名）' : ''}`;
  return v?.name || v?.path || '未知版本';
}

function fmtTime(ms) {
  const t = Number(ms) || 0;
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 主进程返回值 → 视图模型（只做展示派生，不改判定） */
function toVersionRow(v) {
  const kind = String(v?.kind || '');
  return {
    path: String(v?.path || ''),
    name: String(v?.name || ''),
    version: String(v?.version || ''),
    versionSource: String(v?.versionSource || ''),
    kind,
    kindLabel: versionKindLabel(kind),
    exists: v?.exists !== false,
    /* 主进程说能删才给点；它没给字段时也不猜成"能删"（fail-closed） */
    deletable: v?.deletable === true,
    reason: String(v?.reason || ''),
    running: v?.running === true,
    pid: v?.pid ?? null,
    isActive: kind === 'active' || (Boolean(activePath.value) && v?.path === activePath.value),
    sizeBytes: Number(v?.sizeBytes) || 0,
    fileCount: Number(v?.fileCount) || 0,
    mtimeMs: Number(v?.mtimeMs) || 0,
    hasUserData: v?.hasUserData === true,
    userDataItems: Array.isArray(v?.userDataItems) ? v.userDataItems : []
  };
}

async function loadVersions() {
  versionsLoading.value = true;
  try {
    const r = await listManagedVersions();
    activePath.value = r.activePath || '';
    versions.value = (Array.isArray(r.versions) ? r.versions : []).map(toVersionRow);
    versionsRoots.value = Array.isArray(r.managedRoots) ? r.managedRoots : [];
    /* 麦麦是否正在运行：主进程给的事实，用来决定「还原」按钮能不能按 */
    versionsRunning.value = r?.running?.running === true;
    versionsMessage.value = r.message || '';
    if (!r.ok) toast(r.message || '无法读取已安装版本', 'error', 5000);
    return r;
  } finally {
    versionsLoading.value = false;
  }
}

/**
 * 删除一个受管版本。
 * 二次确认走主进程的原生确认框（与「清理数据分类」一致，不用 window.confirm）：
 * 文案要说清"删哪个、删了就没有了、要重装得重新下载"，默认按钮落在「取消」。
 */
async function removeVersion(v) {
  if (!v?.deletable) {
    toast(v?.reason || '该版本不允许删除', 'warn', 4000);
    return;
  }
  const title = versionTitle(v);
  const yes = await confirmDialog({
    type: 'warning',
    title: `删除版本「${title}」`,
    message: `将永久删除这个目录：${v.path}`,
    detail:
      '删除后该版本就没了，无法恢复；要再用它只能重新下载安装。' +
      (v.hasUserData
        ? `注意：这个目录里还有用户数据（${v.userDataItems.join('、')}），会一并被删除。`
        : '') +
      (v.running ? '它当前正在运行，主进程会拒绝删除。' : ''),
    buttons: ['取消', '删除'],
    defaultId: 0
  });
  if (!yes) return;

  deletingPath.value = v.path;
  try {
    const r = await deleteManagedVersion(v.path);
    if (r.ok) {
      const freed = Number(r.freedBytes) || 0;
      toast(
        freed > 0
          ? `${r.message || '已删除'}，释放 ${fmtBytes(freed)}`
          : r.message || '已删除该版本',
        'success',
        4000
      );
    } else {
      toast(r.message || '删除失败', 'error', 6000);
    }
  } finally {
    deletingPath.value = '';
    /* 成功要刷新（那一项不该再出现），失败也要刷新（磁盘状态可能已变，
       且主进程的拒绝原因可能更新）—— 两种结果都必须让列表回到磁盘事实 */
    await loadVersions();
  }
}

/* ---------------------------------------------------------- 还原备份（UI 侧） */

/**
 * 这一行是不是"可以还原的备份"，以及为什么不能。
 *
 * 只有升级/安装留下的备份目录（kind==='backup'，名字是 <目录>.backup-…/.old-…）
 * 才是可还原对象 —— 同级副本（kind==='install'）不符合备份命名规则，
 * 主进程的 ⑤ 会拒绝，所以这里也不给按钮。
 *
 * `deletable` 是主进程对备份行硬编码为 true 的字段（versions.js），
 * 借它当"主进程确认这一行是受管备份"的信号，不在这里另立一套判据。
 */
function canRestore(v) {
  if (!v) return false;
  if (v.kind !== 'backup') return false;
  if (!v.exists || !v.deletable) return false;
  /* 麦麦在运行时主进程会硬性拒绝（它正用着安装目录），按钮先禁掉并写明 */
  if (versionsRunning.value) return false;
  return true;
}

/** 按钮禁用时给用户的理由（与主进程的拒绝理由一致，不软化） */
function restoreDisabledReason(v) {
  if (!v) return '没有可还原的备份';
  if (v.kind !== 'backup') {
    return '只有升级/安装留下的备份目录才能还原（这一项不是备份）';
  }
  if (!v.exists) return '目录不存在，无法还原';
  if (!v.deletable) return v.reason || '主进程判定这一项不允许操作';
  if (versionsRunning.value) {
    return 'MaiBot 正在运行：还原会替换它正在使用的安装目录，请先在总览页点「停止」';
  }
  return '该备份不允许还原';
}

/**
 * 还原：用这个备份替换当前使用的安装。
 *
 * 二次确认走应用既有的原生 confirmDialog（与「删除版本」「清理数据」一致，
 * 不用 window.confirm），默认按钮落在「取消」(defaultId:0)。
 * 文案必须说清三件事：会用这个备份替换当前版本、当前版本会被保留为一个新备份、
 * 期间麦麦会被停止。
 * 成功后 toast + 刷新列表（新增了一条"还原前的当前版本"备份）；
 * 失败同样 toast 真实原因 + 刷新（磁盘状态可能已经变了）。
 */
async function restoreVersion(v) {
  if (!canRestore(v)) {
    toast(restoreDisabledReason(v), 'warn', 4000);
    return;
  }
  const yes = await confirmDialog({
    type: 'warning',
    title: `用备份「${v.name || v.path}」还原`,
    message: `会用这个备份替换当前正在使用的版本：${v.path}`,
    detail:
      '当前版本会先被完整保留为一个**新的备份目录**（不会丢），' +
      '然后这个备份被换到当前使用的位置。\n' +
      '还原期间 MaiBot 会被停止（正在运行的话主进程会直接拒绝）。\n' +
      (v.hasUserData
        ? `注意：这个备份里带用户数据（${v.userDataItems.join('、')}），还原后生效的就是它们。`
        : '注意：这个备份里没有 config/、data/ 等用户数据，还原后用的是它自带的内容。') +
      '还原完成后建议在总览页重新「启动」麦麦确认能跑起来。',
    buttons: ['取消', '还原'],
    defaultId: 0
  });
  if (!yes) return;

  restoringPath.value = v.path;
  try {
    const r = await restoreBackup(v.path);
    if (r.ok) {
      const newName = r.newBackupDir ? r.newBackupDir.split(/[\\/]/).pop() : '';
      toast(
        `已用备份「${v.name || v.path}」还原` +
          (newName ? `；还原前的当前版本已保留为 ${newName}` : '') +
          (Number.isFinite(Number(r.elapsedMs)) ? `（耗时 ${r.elapsedMs} ms）` : ''),
        'success',
        6000
      );
    } else {
      toast(r.message || '还原失败', 'error', 8000);
    }
  } finally {
    restoringPath.value = '';
    /* 成功要刷新（多了一条新备份、当前版本已变），失败也要刷新
       （主进程的拒绝原因可能更新）—— 两种结果都必须回到磁盘事实 */
    await loadVersions();
  }
}

/* ------------------------------------------------------------------ 路径面板 */

/*
  路径来自 store.paths（由 loadPaths() 走 paths:get 填充）。
  store 是 reactive 的，所以这里是"跟手"的；不再另存一份 ref ——
  两处副本必然漂移，而 store 里那份是其它页面（安装器 / 下载 / 工具箱）也在用的。
*/
const pathLoading = ref(false);

/** 启动器数据目录（设置文件与日志的上级目录）—— 主进程的 app:info 已经带出来 */
const userDataDir = computed(() => store.info.userData || '');

/** 每一项：label / 路径（空 = 未配置）/ 说明 */
const pathRows = computed(() => {
  const p = store.paths || {};
  const svc = form.value?.service || {};
  const out = [
    { label: '数据根目录', path: p.base || '', desc: '启动器管理的运行数据根' },
    { label: '应用日志', path: p.base ? p.logsDir : '', desc: 'launcher.log 所在目录' },
    { label: '模型数据', path: p.base ? p.modelsDir : '', desc: '缓存的模型与权重' },
    { label: '运行记录', path: p.base ? p.recordsDir : '', desc: '运行期记录文件' },
    { label: '缓存目录', path: p.base ? p.cacheDir : '', desc: '可自动重建的缓存' },
    { label: '导出目录', path: p.exportDir || '', desc: '导出文件落盘位置' },
    { label: '启动器数据目录', path: userDataDir.value || '', desc: '设置文件与日志的上级目录' }
  ];
  if (svc.maibotDir) {
    out.unshift({ label: 'MaiBot 目录', path: svc.maibotDir, desc: 'bot.py 与核心代码所在目录' });
  } else {
    out.unshift({ label: 'MaiBot 目录', path: '', desc: '尚未配置 —— 请在下方「服务与目录」里选择' });
  }
  out.splice(1, 0, {
    label: 'SnowLuma 目录',
    path: svc.snowlumaDir || '',
    desc: '尚未配置 —— index.mjs 与 node.exe 所在目录'
  });
  return out;
});

async function loadPathInfo() {
  pathLoading.value = true;
  try {
    const r = await loadPaths();
    if (!r) toast('无法读取路径信息', 'warn');
  } finally {
    pathLoading.value = false;
  }
}

async function openPathTarget(target) {
  if (!target) return;
  const r = await openPath(target);
  if (!r?.ok) toast(r.message || `无法打开：${target}`, 'error', 4500);
}

/* ------------------------------------------------------------------ 调试面板 */

/* --- 应用日志 --- */
const logText = ref('');
const logLoading = ref(false);
const logExpanded = ref(false);
const logLineCount = computed(() => (logText.value ? logText.value.split('\n').length : 0));

async function viewAppLog() {
  logLoading.value = true;
  try {
    const r = await loadAppLogs(200);
    if (!r.ok) {
      toast(r.message || '读取日志失败', 'error');
      return;
    }
    const lines = (store.logsByKey.launcher || []).map((e) => e.text);
    logText.value = lines.slice(-200).join('\n') || '（日志为空）';
    logExpanded.value = true;
    toast(`已载入最近 ${lines.length} 行启动器日志`, 'success', 2500);
  } finally {
    logLoading.value = false;
  }
}

/** 打开日志文件所在目录（拿不到文件路径时退回启动器数据目录） */
async function openLogDir() {
  const file = store.appLogFile;
  let dir = '';
  if (file) dir = file.replace(/[\\/][^\\/]*$/, '');
  if (!dir) dir = store.info.userData || '';
  if (!dir) {
    toast('暂时拿不到日志目录', 'warn');
    return;
  }
  const r = await openPath(dir);
  if (!r?.ok) toast(r.message || '无法打开日志目录', 'error', 4500);
}

/* --- 缓存管理 --- */

/** 安装扫描结果缓存（旧版用这两个键；本项目扫描是即时的，所以常态是"无缓存"） */
const SCAN_CACHE_KEYS = ['maibot_installs_cache', 'maibot_installs_cache_ts'];
const scanCacheTick = ref(0);

const scanCacheInfo = computed(() => {
  /* 依赖 tick 才能在清除后重算 */
  void scanCacheTick.value;
  try {
    const raw = localStorage.getItem('maibot_installs_cache');
    const ts = Number(localStorage.getItem('maibot_installs_cache_ts') || 0);
    if (!raw) return '当前没有安装扫描缓存（扫描结果不落盘，每次都是实时结果）';
    let count = 0;
    try {
      const list = JSON.parse(raw);
      count = Array.isArray(list) ? list.length : 0;
    } catch (_) {
      count = 0;
    }
    if (!ts) return `已缓存 ${count} 个安装（无时间戳）`;
    const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    const age = ageSec < 60 ? `${ageSec} 秒` : `${Math.floor(ageSec / 60)} 分钟`;
    return `已缓存 ${count} 个安装 · ${age}前`;
  } catch (_) {
    return '无法读取缓存';
  }
});

function clearScanCache() {
  let removed = 0;
  for (const k of SCAN_CACHE_KEYS) {
    try {
      if (localStorage.getItem(k) !== null) {
        localStorage.removeItem(k);
        removed += 1;
      }
    } catch (_) {
      /* 忽略 */
    }
  }
  scanCacheTick.value += 1;
  toast(removed ? `已清除 ${removed} 项扫描缓存` : '没有需要清除的扫描缓存', 'success', 2500);
}

/**
 * 界面设置缓存：本项目用 `maibot-launcher.*` / `onboarding.*` 两个前缀存界面偏好。
 * 排除用户内容（对话记录 maibot_chat_sessions、提示词 maibot_saved_prompt_presets），
 * 它们不是"界面设置"，清掉等于删用户的资料。
 */
const UI_CACHE_PREFIXES = ['maibot-launcher.', 'onboarding.'];
const USER_CONTENT_KEYS = ['maibot_chat_sessions', 'maibot_saved_prompt_presets'];
const uiCacheTick = ref(0);

const uiCacheKeys = computed(() => {
  void uiCacheTick.value;
  try {
    return Object.keys(localStorage).filter(
      (k) => UI_CACHE_PREFIXES.some((p) => k.startsWith(p)) && !USER_CONTENT_KEYS.includes(k)
    );
  } catch (_) {
    return [];
  }
});

function clearUiCache() {
  const keys = uiCacheKeys.value;
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch (_) {
      /* 忽略 */
    }
  }
  /*
    🔴 ACCENT_KEY（maibot-launcher.accent.v1）会被 UI_CACHE_PREFIXES 前缀命中，
    但它不只是 localStorage 里的一行：内存里的 accentColor / accentDraft、已注入的
    <style> 叠加层、<html> 上的内联 --on-accent 都是它的"活副本"。
    只删存储、不管另外三处，就会出现"toast 说已清除、颜色纹丝不动，下次重启却又
    静默变回默认"；而且 accentColor 没变，
    「应用」按钮会被 :disabled="accentDraft === accentColor" 卡死，
    用户连重新选回同一个色都做不到。
    所以这里把三处活副本一起重置 —— 文案本来就写明"自定义主题色"属于这份缓存，
    重置后 toast 与实际效果一致。
  */
  if (keys.includes(ACCENT_KEY)) resetAccentState();
  uiCacheTick.value += 1;
  toast(keys.length ? `已清除 ${keys.length} 项界面缓存` : '没有需要清除的界面缓存', 'success', 2500);
}

/* --- 诊断与维护 --- */

/*
  诊断报告里的凭据脱敏。
  ──────────────────────────────────────────────────────────────────────────
  store.settings 是**整份**设置，里面就含 llm.apiKey / llm.custom.apiKey /
  github.token（见 src/main/constants.js 的 DEFAULT_SETTINGS）。报告却是要拿出去
  （贴 issue、发聊天窗口）的东西，所以导出前必须过一遍脱敏：
    · **键名与结构原样保留** —— 报告是用来排查"哪一项没配"的，
      只把值换成 '***'，用户才看得懂这份 JSON；
    · 按**键名**判定（token / apiKey / secret / password / credential 一族，
      camelCase 也拆开看），不枚举具体字段名，以后新增凭据字段自动覆盖；
    · 只脱敏**非空字符串** —— 空串说明"本来就没配"，写 '***' 会误导成"有密钥"；
      数字 / 布尔原样保留，否则 maxTokens 这类名字里带 Token 的数值配置会被误伤。
    · 位于凭据键下面的整棵子树一并脱敏（`apiKeys: { a: 'x' }` 也不会漏）。
*/
function isSecretKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return false;
  const joined = words.join('');
  if (!/(token|apikey|secret|passwd|password|credential|privatekey)/.test(joined)) return false;
  /* 例外：maxTokens / maxOutputTokens 这类"数值上限"，名字里的 token 不是凭据 */
  return !/^max(?:output|input|new|context)?tokens?$/.test(joined);
}

/**
 * 递归脱敏：返回一份新对象（不改动入参）。
 * @param {unknown} value 待处理的值
 * @param {boolean} inheritedSecret 上层键名已判定为凭据 → 整棵子树都算凭据
 * @param {number} depth 深度上限，防止超深/自引用结构把导出拖死
 */
function redactSecrets(value, inheritedSecret = false, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    return inheritedSecret && value.trim() ? '***' : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, inheritedSecret, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v, inheritedSecret || isSecretKey(k), depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 导出诊断报告。
 * 报告内容就地取自主进程已经暴露的只读接口（版本 / 平台 / 端口 / 设置 / 日志），
 * 不新增 IPC，也不去读麦麦目录里的用户文件。
 * ⚠️ 这里的 settings 是**脱敏后**的（redactSecrets）：凭据只留键名、值统一换成
 *    '***'，所以这份 JSON 可以放心贴给别人；别把 store.settings 原样塞进来。
 * 落盘方式用浏览器下载：Electron 会弹系统保存对话框，用户自己选位置。
 */
async function exportDiagnostics() {
  try {
    const [ports, log] = await Promise.all([checkPorts(portList()), loadAppLogs(120)]);
    const report = {
      generatedAt: new Date().toISOString(),
      app: {
        name: store.info.name,
        version: store.info.version,
        platform: store.info.platform,
        arch: store.info.arch,
        electron: store.info.electron,
        node: store.info.node,
        chrome: store.info.chrome
      },
      paths: {
        userData: store.info.userData,
        logFile: store.info.logFile
      },
      ports,
      /* 脱敏后才进报告：键名保留、凭据值换成 '***'（见 redactSecrets 的说明） */
      settings: redactSecrets(store.settings),
      recentLogLines: log.ok ? (store.logsByKey.launcher || []).slice(-120).map((e) => e.text) : []
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maibot-diagnostics-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('诊断报告已生成，请在系统保存对话框中确认位置', 'success', 5000);
  } catch (e) {
    toast(`导出失败：${e?.message || e}`, 'error', 5000);
  }
}

/** 报告里要探测的端口（来自当前设置，取不到就退回主进程默认值） */
function portList() {
  const svc = form.value?.service || {};
  const list = [
    Number(svc.ports?.maibot),
    Number(svc.ports?.webui),
    Number(svc.snowlumaPorts?.webui),
    Number(svc.snowlumaPorts?.onebot)
  ];
  return list.filter((n) => Number.isFinite(n) && n > 0);
}

async function reloadWindow() {
  const yes = await confirmDialog({
    type: 'question',
    title: '重载窗口',
    message: '将重新加载界面。',
    detail: '未保存的设置改动会丢失；正在运行的服务不受影响。',
    buttons: ['取消', '重载'],
    defaultId: 1
  });
  if (!yes) return;
  toast('正在重载界面…', 'info', 1500);
  setTimeout(() => window.location.reload(), 400);
}

/** 恢复全部默认设置：后端设置 + 界面缓存 + 自定义主题色 */
async function restoreAllDefaults() {
  const yes = await confirmDialog({
    type: 'warning',
    title: '恢复全部默认设置',
    message: '将清空全部自定义设置与界面缓存，立即恢复出厂状态。',
    detail: '目录路径、仓库、端口、界面偏好都会被重置。此操作不可撤销。',
    buttons: ['取消', '恢复默认'],
    defaultId: 0
  });
  if (!yes) return;

  const r = await resetSettings();
  clearUiCache();
  resetAccent();
  if (r.ok) {
    ensureDraft();
    toast('已恢复全部默认设置', 'success', 3500);
  } else {
    toast(r.message || '重置失败', 'error');
  }
}

/* --- 启动参数（只读探测） --- */

const startPayloads = ref([
  { key: 'maibot', label: 'MaiBot', text: '未探测' },
  { key: 'snowluma', label: 'SnowLuma', text: '未探测' }
]);
const startPayloadNote = ref('点右上角「探测」让主进程按当前目录算一次真实命令行。');

async function loadStartPayloads() {
  const out = [];
  for (const item of [
    { key: 'maibot', label: 'MaiBot' },
    { key: 'snowluma', label: 'SnowLuma' }
  ]) {
    const r = await resolveStartPayload(item.key);
    if (!r.ok || !r.payload) {
      out.push({ ...item, text: r.message || '未配置入口，无法启动' });
      continue;
    }
    const p = r.payload;
    const args = Array.isArray(p.args) ? p.args.join(' ') : '';
    out.push({ ...item, text: [p.command, args].filter(Boolean).join(' '), cwd: p.cwd, port: p.readyPort });
  }
  startPayloads.value = out;
  const missing = out.filter((o) => !o.cwd).length;
  startPayloadNote.value = missing
    ? `${missing} 个服务尚未配置目录，先在下面「服务与目录」里选好路径再探测。`
    : '以上命令由主进程按当前设置与目录实测得到；工作目录与就绪端口一并核对。';
}

/* --- 环境检测 --- */

const envChecking = ref(false);
const envResult = ref(null);
const depsInstalling = ref(false);
const depsProgress = ref('');
const offDepsStatus = ref(null);

async function checkEnvironment() {
  envChecking.value = true;
  try {
    const pyPath = String(form.value?.service?.pythonPath || 'python');
    /*
      用 checkPrerequisites（= prereq:check-all）而不是"自己拼两条请求"：
      它一次返回 python{ok,version,minVersion,message} + dependencies[] +
      missingCount，形状在 prereq.js 里是稳定的；
      这样界面不必去猜 env:detect-all 的内部结构。
    */
    const r = await checkPrerequisites({
      installDir: form.value?.service?.maibotDir || '',
      pythonExe: pyPath
    });

    const py = r?.python || null;
    const depsList = Array.isArray(r?.dependencies) ? r.dependencies : [];
    const missing = depsList.filter((d) => !d.ok);

    envResult.value = {
      pythonOk: Boolean(py?.ok),
      pythonText: py
        ? `${py.version ? `Python ${py.version}` : '版本未知'} · 需要 ≥ ${py.minVersion || '3.12'}${
            py.message ? ` · ${py.message}` : ''
          }`
        : `未拿到 Python 检测结果（解释器：${pyPath}）`,
      missingCount: Number.isFinite(Number(r?.missingCount)) ? Number(r.missingCount) : missing.length,
      depsText: depsList.length
        ? `共 ${depsList.length} 个依赖，${depsList.length - missing.length} 个已就绪${
            missing.length ? `；缺失：${missing.map((d) => d.name || d.pkg).join('、')}` : ''
          }`
        : r?.message || '依赖列表为空（可能尚未配置麦麦目录，或 requirements.txt 不可读）'
    };
    toast('环境检测完成', 'success');
  } catch (e) {
    toast(`检测失败：${e?.message || e}`, 'error', 4500);
  } finally {
    envChecking.value = false;
  }
}

async function installMissingDeps() {
  const yes = await confirmDialog({
    type: 'warning',
    title: '安装缺失依赖',
    message: '将调用麦麦目录里的 Python 执行 pip 安装缺失的包。',
    detail: '这会真实改动麦麦的 Python 环境（下载并安装第三方包），请确认后再继续。',
    buttons: ['取消', '开始安装'],
    defaultId: 0
  });
  if (!yes) return;

  depsInstalling.value = true;
  depsProgress.value = '准备安装…';
  try {
    const r = await installDependencies({
      installDir: form.value?.service?.maibotDir || '',
      pythonExe: String(form.value?.service?.pythonPath || 'python')
    });
    toast(r.message || (r.ok ? '依赖安装完成' : '依赖安装失败'), r.ok ? 'success' : 'error', 5000);
    await checkEnvironment();
  } catch (e) {
    toast(`安装失败：${e?.message || e}`, 'error', 5000);
  } finally {
    depsInstalling.value = false;
    setTimeout(() => {
      depsProgress.value = '';
    }, 4000);
  }
}

/* ---------------------------------------------------------------- 保存/导出 */

async function reload() {
  reloading.value = true;
  try {
    await loadSettings();
    ensureDraft();
    await refreshLoginItem();
    await refreshThemePreference();
    toast('已重新载入设置', 'success');
  } catch (e) {
    toast('载入失败：' + (e?.message || e), 'error');
  } finally {
    reloading.value = false;
  }
}

async function onApply() {
  saving.value = true;
  try {
    const r = await applySettings();
    toast(r.ok ? '设置已保存' : r.message || '保存失败', r.ok ? 'success' : 'error');
  } finally {
    saving.value = false;
  }
}

function onCancel() {
  discardDraft();
  ensureDraft();
  toast('已放弃未保存的修改');
}

/** 恢复默认（只重置后端设置，会真实写盘，需二次确认） */
async function onReset() {
  const yes = await confirmDialog({
    type: 'warning',
    title: '恢复默认设置',
    message: '将把全部设置恢复为默认值并立即保存。',
    detail: '目录路径、仓库、端口等自定义内容会被清空，此操作不可撤销。',
    buttons: ['取消', '恢复默认'],
    defaultId: 0
  });
  if (!yes) return;

  const r = await resetSettings();
  if (r.ok) {
    ensureDraft();
    toast('已恢复默认设置', 'success');
  } else {
    toast(r.message || '重置失败', 'error');
  }
}

/** 导出设置为 .json（主进程写文件，返回真实路径） */
async function onExport() {
  const picked = await saveFileDialog({
    title: '导出设置',
    defaultPath: 'maibot-settings.json',
    filters: [{ name: 'JSON 文件', extensions: ['json'] }]
  });
  if (!picked.ok) return;

  const r = await exportSettings(picked.path);
  if (r.ok) toast(`已导出到 ${r.path}`, 'success', 4500);
  else toast(r.message || '导出失败', 'error');
}

/*
  ────────────────────────────────────────────────────────────────────────────
  「切标签整块横向跳 5px」的修法：给**本页的**滚动容器常驻滚动条槽。
  ────────────────────────────────────────────────────────────────────────────
  实测：无溢出页卡片 x=224、有溢出页 x=219（10px 经典滚动条占位导致
  clientWidth 1280 → 1270，而设置页整列 margin:0 auto 居中，于是整页横跳）。
  设置页六个标签正好是"有的溢出、有的不溢出"，所以切标签必抖。

  为什么在这里注入而不是直接写进 AppLayout.vue 的 `.body`：
  `.body` 是所有页面共用的滚动容器，本页没有任何权利改它的基础样式
  （改了会影响总览/日志/终端/工具箱）。这里做两件事把影响**严格限制在设置页**：
    1) 只在本组件挂载期间给 .body 挂一个 data 属性，离开时摘掉；
    2) 规则选择器带上那个属性，所以只有"设置页在屏上"时 `.body` 才有槽位。
  选择器权重 (0,2,0) 高于 `.body` 的 (0,1,0)，且这段 <style> 在 head 末尾，
  所以后加载者胜 —— 不依赖 AppLayout 里那条规则在文件中的位置。
  卸载时复原，其它页面的 .body 与本次改动前逐字节一致（实测见 _verify-after.txt
  的 OTHER overview / toolbox / terminal 三行：gutter=stable 只在本页生效，
  它们的 padding / clientWidth / scrollHeight 全部未变）。
*/
const SCROLL_GUTTER_FLAG = 'data-settings-gutter';
let scrollGutterStyleEl = null;

function applyScrollGutterFix() {
  const body = document.querySelector('.body');
  if (!body) return;
  if (!scrollGutterStyleEl) {
    scrollGutterStyleEl = document.createElement('style');
    scrollGutterStyleEl.id = 'maibot-settings-scroll-gutter';
    scrollGutterStyleEl.textContent =
      '.body[' + SCROLL_GUTTER_FLAG + ']{scrollbar-gutter:stable;}';
    document.head.appendChild(scrollGutterStyleEl);
  }
  body.setAttribute(SCROLL_GUTTER_FLAG, '');
}

function removeScrollGutterFix() {
  document.querySelectorAll('.body[' + SCROLL_GUTTER_FLAG + ']').forEach((el) => {
    el.removeAttribute(SCROLL_GUTTER_FLAG);
  });
  if (scrollGutterStyleEl) {
    scrollGutterStyleEl.remove();
    scrollGutterStyleEl = null;
  }
}

/*
  未保存就切页 —— 拦一下。
  改动只活在 store.draft 里，切页不会丢，但用户不会知道它没生效：
  他改完路径就去点「总览」，下次启动读的还是旧值。
*/
onBeforeRouteLeave(() => {
  if (!isDirty()) return true;
  return window.confirm('设置有未保存的修改。\n\n点「确定」放弃这些修改并离开，点「取消」回去保存。');
});

onMounted(async () => {
  ensureDraft();
  applyScrollGutterFix();
  /* 主题色是"用户选的色"，进页面时重新套一遍（其它页面不负责它） */
  if (accentColor.value.toLowerCase() !== DEFAULT_ACCENT) applyAccentToDom(accentColor.value);
  offDepsStatus.value = subscribeDepsStatus((msg) => {
    depsProgress.value = typeof msg === 'string' ? msg : msg?.message || '';
  });
  defaultRoots.value = await getDefaultScanRoots();
  await refreshLoginItem();
  await refreshThemePreference();
  await Promise.all([loadDataStats(), loadPathInfo(), loadVersions()]);
});

onBeforeUnmount(() => {
  offDepsStatus.value?.();
  removeScrollGutterFix();
  /*
    离开设置页时**还原**主题色叠加层。
    理由：注入的变量会改全局外观，而"设置页的样式"不应该在用户离开后继续影响
    其它页面 —— 下次进设置页会重新套上，用户点开就能看到自己选的颜色。
    （跨页持久生效需要在应用外壳里初始化，那属于本页写入范围之外的文件。）
  */
  removeAccentOverride();
});

/* 界面缓存项在标签切换后用真实值刷新一次，避免显示上一次进页面时的旧数字 */
watch(tab, () => {
  uiCacheTick.value += 1;
  scanCacheTick.value += 1;
  if (tab.value === 'data' && !dataStats.value.length) loadDataStats();
  /* 已安装版本跟着"数据"页一起刷新：磁盘上的备份可能已经被别处删掉了 */
  if (tab.value === 'data' && !versionsLoading.value) loadVersions();
  if (tab.value === 'paths' && !store.paths) loadPathInfo();
});
</script>

<style scoped>
/*
  ────────────────────────────────────────────────────────────────────────────
  页面容器（v4 起外壳不再给 .body 任何 padding，由页面自己排版）
  居中一列 + 上限 880px：这页是表单页，本来就该有一列可读宽度。
  ────────────────────────────────────────────────────────────────────────────
*/
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: 100%;
  max-width: 880px;
  /*
    短页面也要把保存条顶到内容区底部（「高级」页收起时实测保存条 y=337.6，
    下面从 382 到 720 一大片空白）。
    `.body` 是 flex 列容器里的滚动区，行内只给 padding，所以百分比 min-height
    会正确解析成它的**内容盒高度**（= 内容区可视高度），
    `box-sizing` 是全局 border-box，因此这里减掉自身的上下 padding
    （--sp-5 = 24px，上下各 24px）就是"刚好铺满、不产生新滚动条"的高度。
    测试环境若没解析出百分比，`100vh - 44` 那半截兜底同样够用
    （标题栏 --titlebar-h = 44px，即内容区高度）。
    末尾不加任何补偿：实测内容区可视高度 720px、.body 上下 padding 80px 时
    `calc(100% - var(--sp-5) * 2)` 解析成 634px，保存条底边正好落在
    内容区底部留白之上（见 _verify-after.txt 的 saveBar / visibleBottomGap）。
  */
  min-height: calc(100% - (var(--sp-5) * 2));
  min-height: calc(100vh - var(--titlebar-h) - (var(--sp-5) * 2));
  /* 底部不留白：吸底保存栏自己占位（它是 sticky，不是 fixed） */
  padding: var(--sp-5) var(--sp-5) 0;
  margin: 0 auto;
}

/* --------------------------------------------------------------- 顶部标签栏 */

/*
  标签切换动画：只作用于「提示条之后的内容节点」，标签栏自身不动。
  时长与缓动跟全项目二级窗口同一套（--dur-base + --ease-standard），
  位移压到 6px —— 设置页是"换一屏内容"，不是"弹出一个窗口"，
  动作幅度大了会显得页面整体在抖。
*/
.panel.pane-anim > .tip ~ * {
  animation: settings-pane-in var(--dur-base) var(--ease-standard);
}

@keyframes settings-pane-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1);
  padding: 0.25rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--seg-bg);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: var(--h-ctl-sm);
  padding: 0 0.75rem;
  border: none;
  border-radius: var(--r-menu);
  background: transparent;
  color: var(--ink-soft);
  font-family: inherit;
  font-size: 12px;
  font-weight: var(--fw-medium);
  letter-spacing: 0.2px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.tab:hover:not(.on) {
  background: var(--row-bg-hover);
  color: var(--ink-strong);
}

/*
  选中项：与 SegmentedControl 用同一套 token（--seg-active-bg / --accent-ink）。
  不写实底蓝：标签栏里六颗实底蓝会把整页压得很重，而这一页的留白风格
  正是"极简、不塞满"。
*/
.tab.on {
  background: var(--seg-active-bg);
  color: var(--accent-ink);
  box-shadow: var(--seg-active-shadow);
}

.tab:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.tab-ico {
  font-size: 13px;
  flex: none;
}

/* ------------------------------------------------------------------ 提示条 */

.tip {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-md);
  background: var(--theme-tint);
  font-size: var(--fs-sm);
  color: var(--ink);
}

.tip span {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
}

.tip-ico {
  letter-spacing: var(--ls-title);
  font-size: 15px;
  color: var(--theme-color);
  flex: none;
}

/* ------------------------------------------------------------- 行与列表布局 */

/* 路径输入 + 按钮：输入框占满剩余宽度，按钮不被压缩 */
.path-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  min-width: 0;
}

/* 同一行里的按钮必须和输入框一样高，否则基线看起来是歪的 */
.path-row > .pill {
  align-self: stretch;
  height: auto;
}

.path-row > :first-child {
  flex: 1;
  min-width: 0;
}

.path-row > :last-child {
  flex: none;
}

.btn-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/*
  列表行（数据 / 路径 / 缓存 / 维护）。
  底色走 --surface-3 而不是写死浅色：深色主题下写死浅色会变成糊在深卡上的白斑。
*/
.list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 100%;
  min-width: 0;
}

.list-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-3);
  min-width: 0;
}

.list-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/*
  行右侧的操作按钮组（已安装版本行：「还原」+「删除」）。
  两枚按钮必须并排且不换行，否则窄窗口下会把路径挤成两行。
*/
.list-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 0 0 auto;
}

.list-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.list-name {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--ink-strong);
}

.list-name.danger {
  color: var(--err-ink);
}

.list-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--ink-soft);
  line-height: 1.5;
}

.list-path {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--ink);
  word-break: break-all;
  min-width: 0;
}

.list-path.empty {
  color: var(--ink-soft);
  font-family: inherit;
}

/*
  已安装版本行里的提醒：主进程给出的"不可删除"原因、以及"目录里还有用户数据"。
  用既有的 --warn-ink（浅深两套都已定义），不新造颜色令牌。
*/
.version-note {
  font-family: inherit;
  color: var(--warn-ink);
}

/* 日志 / 诊断输出的代码块 */
.log-box {
  margin: 0;
  max-height: 300px;
  overflow: auto;
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-all;
}

/* --------------------------------------------------------------- 主题色选择 */

.presets {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/*
  色块。
  32×32 圆角方块（旧版也是这个尺寸）；选中态用**描边 + 对勾**而不是外发光：
  外发光在浅色卡片上与白底混在一起看不见。
*/
.swatch {
  position: relative;
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur-base) var(--ease), box-shadow var(--dur-base) var(--ease);
}

.swatch:hover {
  transform: scale(1.08);
}

.swatch.on {
  box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--ink-strong);
}

/* 对勾的颜色由底色决定不了，所以两色描边：白勾 + 深色投影，深浅底都看得见 */
.swatch-ico {
  letter-spacing: var(--ls-title);
  font-size: 15px;
  color: #fff;
  filter: drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.85));
}

/*
  自定义取色。
  原生 <input type="color"> 的默认外观在各平台差异很大（Windows 上是带白边的方块），
  这里统一压成 32px 圆角方块，与预设色块对齐。
*/
.color-input {
  width: 32px;
  height: 32px;
  flex: none;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  cursor: pointer;
}

.color-input::-webkit-color-swatch-wrapper {
  padding: 0.125rem;
}

.color-input::-webkit-color-swatch {
  border: none;
  border-radius: 6px;
}

.accent-now {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--fs-sm);
  color: var(--ink);
}

.accent-dot {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
}

/* ------------------------------------------------------------- 扫描范围 */

.roots {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 100%;
  min-width: 0;
  padding-top: var(--sp-2);
  border-top: 1px solid var(--line);
}

.roots-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.roots-title {
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--ink-strong);
}

.roots-empty {
  font-size: var(--fs-xs);
  color: var(--ink-soft);
  line-height: 1.6;
  word-break: break-all;
}

.roots-defaults {
  color: var(--ink-strong);
}

.roots-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

/* ------------------------------------------------------------------ 说明文字 */

.field-note {
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--ink-soft);
  flex: 1 1 auto;
  /*
    🔴 "带说明文字的行普遍折行"的第二个成因：min-width:200px。
    这一行（设置页最宽 880px 的卡片里，控件容器约 786px）控件本身常常
    只有 100~250px，剩下的空间完全够放下说明文字；但 200px 这个下限把它
    钉在"最少 200px"上，一旦控件 + 200px > 786px，整条说明就被挤到下一行
    —— 实测调试页 8 行高 57.6~76.2px（邻居 32px），个性化页"界面主题"那行
    的说明也因此换行。
    改成 0：说明文字与控件**共享同一行**，放得下就一行（控件 flex:none 时
    说明吃掉全部剩余宽度），真的放不下时才由上面的 flex-wrap 整体折行。
  */
  min-width: 0;
}

/* 开机自启不可用（开发模式）时给出警示色，避免用户以为开关坏了 */
.field-note.warn {
  color: var(--field-warn-ink);
}

.field-note code {
  padding: 0.125rem 0.25rem;
  border-radius: 6px;
  background: var(--fill-hover);
  font-size: var(--fs-xs);
  /* 显式抬到 --ink：叠上灰片后 --ink-soft 会掉到 AA 线下 */
  color: var(--ink);
}

/* FieldRow 的控件容器默认一行不换行；允许换行后说明文字能自己决定跟不跟着控件 */
:deep(.row-ctrl) {
  flex-wrap: wrap;
}

/*
  🔴 "自定义颜色"整行竖堆成三层（色块 / 输入框 / 按钮 x 相同、y 不同，行高 108px，
     邻居行 32px）的根因就是这个 width:100%。
  TextInput.vue 的 `.tinput{width:100%}` 在一个 flex 行里等价于
  `flex-basis:100%` —— 它一个人就吃掉整行，后面的「应用」按钮必然被挤到下一行；
  再加上上面那条 wrap，"一行三个控件"就变成三层。
  修法：只在这一行内把输入框的弹性改回 `auto`（basis:auto → 按内容/上限算），
  并给一个上限，让色块 + 输入框 + 按钮稳稳排在同一行。
  为什么是 `> * + .tinput`（不是给所有 .tinput 限宽）：
  只有"输入框前面还有别的控件"那种行才需要限宽（色块 + 输入框 + 按钮）；
  独占一行的输入框（数据根目录、日志文件、端口…）本来就该占满整行，
  给它们限宽会白白缩窄成 352px —— 实测过，是明确要避免的副作用。
  用 `:deep()` 是因为 TextInput 是子组件，scoped 选择器落不到它的根元素上。
*/
:deep(.row-ctrl) > * + .tinput {
  flex: 0 1 auto;
  max-width: 22rem;
}

/* ---------------------------------------------------------------- 吸底保存栏 */

/*
  「应用 / 取消」必须永远在视野里：设置项分散在多个标签页，用户改完一项
  很可能直接点左边导航走人。sticky 贴住滚动容器底部，再配合
  onBeforeRouteLeave 拦截(未保存则问一句)。

  底色走 --surface-1（浅色 = 白卡色、深色 = 卡片深色），不写死白色 ——
  写死白色在深色主题下就是一条横贯窗口的白带子。
*/
.save-bar {
  position: sticky;
  bottom: 0;
  z-index: 6;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-2);
  /*
    `margin-top:auto` 在 .panel 这个 flex 列里把保存条推到最底：
    内容短（高级页收起）时它贴住内容区底边，内容长（调试页）时
    margin 归零、由上面的 sticky 继续把它钉在视口底部 —— 两种情形都要。
  */
  margin-top: auto;
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-1);
  border-top: 1px solid var(--line-strong);
  border-radius: var(--r-card) var(--r-card) 0 0;
}

.bar-spacer {
  flex: 1;
}

/*
  「取消 / 应用」与同页 PillButton 保持同一套形态（--h-ctl-sm + --radius-sm），
  不再用 999px 胶囊 + 32px 高（那会让同一根栏里出现两种高度、两种圆角）。
  「取消」用淡红底 + 红字：实心红上的白字只有 4.38:1，压在 AA 线下。
*/
.act-cancel {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--h-ctl-sm);
  padding: 0 0.75rem;
  border: 1px solid var(--err-line-soft);
  border-radius: var(--radius-sm);
  background: var(--err-tint);
  color: var(--err-ink);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-base), opacity var(--dur-base);
}

.act-cancel:hover:not(:disabled) {
  background: var(--err-tint-strong);
}

.act-apply {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  height: var(--h-ctl-sm);
  padding: 0 1rem;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--theme-color);
  /* 实底强调色上的文字必须走 --on-accent：浅色白字、深色深墨字，
     两套主题的对比度都在 theme.css 里算过。写 --paper-full 是错的。 */
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: filter var(--dur-base), background var(--dur-slow), opacity var(--dur-base);
}

.act-apply:hover:not(:disabled) {
  filter: brightness(1.06);
}

.act-cancel:active:not(:disabled),
.act-apply:active:not(:disabled) {
  filter: brightness(0.94);
}

.act-cancel:disabled,
.act-apply:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
