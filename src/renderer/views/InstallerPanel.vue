<template>
  <!--
    ============================================================================
    技术文档：src/renderer/views/InstallerPanel.vue
    职责：MaiBot / SnowLuma 的安装、升级与前置环境检查。
    ============================================================================
      相对重构前的修正：
        1) store.draft.service 空指针（真实崩溃点）
           原代码：`if (store.draft) store.draft.service.maibotDir = r.path;`
           只判了 draft 存在，没有判 .service —— 而 loadSettings() 失败时
           draft 可能来自兜底默认值（无 service 字段），此时直接抛
           "Cannot set properties of undefined"，且抛在 finally 之前的
           try 块里会被 catch 吞掉，用户看到"安装成功"但目录没保存。
           → 现在：写入前逐层保证对象存在（ensureDraftService()）。
        2) 安装完成后只改了 draft，**没有调用 applySettings 落盘**，
           用户下次启动发现目录又空了。
           → 现在：安装成功后明确询问并保存。
        3) 旧的 QQ 注入式协议端曾把安装包文件名硬编码（上游一旦改名就 404），
           而它的安装链路现已整体移除。留下这条只为说明**当前**两条链路
           （MaiBot / SnowLuma）为什么都不传 fileName：
           主进程会自己从 release 附件里挑，渲染层硬编码文件名必被上游改名打穿。
        4) 进度条读取 progress.maibot.percent，而旧主进程只在下载结束时报
           percent:100 → 进度条永远瞬间跳满。现在主进程真流式上报，
           这里同时展示已下载体积与来源镜像。
        5) 'all_ok' 字段不存在（后端返回的是 ok）→ 检查结果提示永远走
           "存在未满足项" 分支，即使全部满足也报警告。
           → 现在：使用 r.ok。
        6) 升级入口缺失：本项目明明有 upgradeMaiBot（且旧实现会删掉备份），
           界面上却无法触发。现在提供升级按钮并展示备份路径。
        7) 只能装 latest：installMaiBot / installSnowluma
           早就支持 opts.version（主进程按 tag 解析），界面却没有入口，
           用户想回退到某个已知可用的版本时完全无路可走。
           → 现在每行都有 VersionPicker（默认「最新版(latest)」），
             并把选定的 tag 原样透传。
        8) SnowLuma 的安装入口只在设置页，且不带版本选择。
           用户要的是"在 MaiBot 和 SnowLuma 里挑一个版本装"，
           所以这里也加了一行（仓库取设置里的 snowlumaRepo）。
        9) 进度条是全局一条、按固定的服务名两行渲染，
           多个服务同时在场时分不清是谁在下；而且只显示"已下/总 · host"，
           多线程与 SHA-256 校验这些**主进程已经上报**的信息完全看不到。
           → 现在每个服务各占一行，展示逻辑抽成 DownloadProgress.vue
             （安装器页与下载页共用，避免两处口径分叉）。
    ============================================================================
  -->
  <div class="panel">
    <!--
      子标签：本页已合并原来的独立「下载」页。
      ────────────────────────────────────────────────────────────────
      为什么合：
        两页本来就是同一条链的两半 —— 这里负责「检测环境 + 装上游」，
        下载页负责「浏览上游 Release + 取任意附件」，却各自让用户填一遍
        仓库名，且下载页默认只填 MaiBot、连不上 SnowLuma 的仓库
        （渲染层此前一个仓库常量都没有，见 router/index.js 的重定向注释）。

      实现上刻意用 <template v-if> 而不是给原内容套一层 div：
        .panel 是 flex + gap 布局，直接子元素的数量决定间距；
        套一层 div 会让「安装与环境」分支的 DOM 结构和合并前不再一致，
        有回归风险。<template v-if> 不产生额外节点，老分支原样保留。

      子标签状态与 ?tab= 查询参数双向对应，所以 #/download 这条旧地址
      重定向过来能直接落在「版本下载」上（见 router/index.js）。
    -->
    <div class="sub-tabs" role="tablist">
      <button
        class="sub-tab"
        :class="{ on: sub === 'install' }"
        role="tab"
        :aria-selected="sub === 'install'"
        @click="setSub('install')"
      >
        <IconGlyph name="bolt" class="sub-ico" />
        安装与环境
      </button>
      <button
        class="sub-tab"
        :class="{ on: sub === 'download' }"
        role="tab"
        :aria-selected="sub === 'download'"
        @click="setSub('download')"
      >
        <IconGlyph name="download" class="sub-ico" />
        版本下载
        <span v-if="store.releases.length" class="sub-badge">{{ store.releases.length }}</span>
      </button>
    </div>

    <template v-if="sub === 'install'">
    <!--
      ==========================================================================
      首跑部署流程（「拿到就能部署」的那条连贯路径）
      ==========================================================================
        为什么放在这个页面最上面：
          下面几张卡各自都能用，但它们是**并列的功能**（安装信息 / 前置检查 /
          安装与升级 / 磁盘），没有一个地方的答案是"我现在到底该先做哪一步"。
          新用户拿到软件的第一分钟问的就是这个 —— 所以这里给一条按真实状态
          推进的清单，每一步都写清"来源是什么、下一步照做什么"。

        判定逻辑全部在 src/renderer/onboarding/deploy-flow.js（纯函数，可断言），
        这里只负责：喂真实快照、把动作接到本页已有的函数上。
        与「新手引导」的分工：引导讲"装好之后怎么接通 QQ"，这里讲"怎么装到能跑"。
      ==========================================================================
    -->
    <PanelCard
      title="首跑部署流程"
      :desc="`${deployProgress.done}/${deployProgress.total} 步 · ${deployProgress.text}`"
    >
      <div class="dep-flow">
        <ol class="dep-steps">
          <li
            v-for="s in deploySteps"
            :key="s.id"
            class="dep-step"
            :class="[s.status, { done: s.done, cur: s.current }]"
          >
            <div class="dep-head" @click="depCursor = depCursor === s.id ? '' : s.id">
              <span class="dep-mark">
                <IconGlyph v-if="s.done" name="check" />
                <template v-else>{{ s.index + 1 }}</template>
              </span>
              <span class="dep-title">{{ s.title }}</span>
              <span class="dep-sum">{{ s.summary }}</span>
              <span class="dep-tag">{{ DEPLOY_TAG[s.status] }}</span>
              <IconGlyph :name="depCursor === s.id ? 'chev-up' : 'chev-down'" class="dep-chev" />
            </div>

            <div v-if="depCursor === s.id" class="dep-body">
              <p class="dep-why">{{ s.why }}</p>

              <!-- 真实证据：每一行都指得到来源（见 deploy-flow.js 各步骤注释） -->
              <ul class="dep-facts">
                <li v-for="(f, k) in s.facts" :key="k" :class="f.tone || ''">
                  <span class="dep-dot" />{{ f.text }}
                </li>
              </ul>

              <p v-if="s.next" class="dep-next">
                <IconGlyph name="info" class="dep-next-ico" />{{ s.next }}
              </p>

              <div class="dep-actions">
                <PillButton
                  v-for="a in visibleDeployActions(s.actions)"
                  :key="a.key"
                  :variant="a.primary ? 'solid' : 'ghost'"
                  size="sm"
                  :icon="a.icon"
                  :disabled="Boolean(a.disabled) || deployBusy !== ''"
                  :loading="deployBusy === a.key"
                  @click="runDeployAction(a)"
                >
                  {{ a.label }}
                </PillButton>
                <!-- 允许用户手动标记的只有"选位置"这一步（见 deploy-flow.js 的说明） -->
                <PillButton
                  v-if="s.id === DEPLOY_IDS.dir && !s.done && s.status !== 'blocked'"
                  variant="ghost"
                  size="sm"
                  icon="check"
                  @click="markDeployDone(s)"
                >
                  位置已定，继续
                </PillButton>
                <PillButton
                  v-else-if="s.manual"
                  variant="plain"
                  size="sm"
                  icon="close"
                  @click="unmarkDeployDone(s)"
                >
                  取消标记
                </PillButton>
              </div>
            </div>
          </li>
        </ol>

        <div class="dep-foot">
          <span class="dep-note">
            这一栏只做**检测 + 跳转 + 调用本页已有的安装通道**；
            标记为“已完成”的步骤一旦被真实状态反证（目录没了、服务没在跑）会自动变回未完成。
          </span>
          <PillButton variant="ghost" size="sm" icon="refresh" :loading="deployRefreshing" @click="refreshDeploySnapshot">
            重新检查
          </PillButton>
        </div>
      </div>
    </PanelCard>

    <PanelCard
      title="安装信息"
      :desc="`仓库 ${repo} · Python ${python} · 目标目录 ${targetDir || '未设置'}`"
    >
      <FieldRow label="仓库" :width="84">
        <TextInput v-model="repo" mono placeholder="Mai-with-u/MaiBot" />
      </FieldRow>
      <FieldRow label="Python" :width="84">
        <TextInput
          v-model="python"
          mono
          placeholder="python"
          @focus="pythonFocused = true"
          @blur="pythonFocused = false"
        />
        <PillButton variant="ghost" size="sm" icon="scan" @click="detectPython">检测</PillButton>
      </FieldRow>
      <FieldRow label="目标目录" :width="84">
        <TextInput
          v-model="targetDir"
          mono
          placeholder="例如 D:\\MaiBot"
          @focus="targetFocused = true"
          @blur="targetFocused = false"
        />
        <PillButton variant="ghost" size="sm" icon="folder" @click="pickTargetDir">浏览…</PillButton>
      </FieldRow>

      <div v-if="!targetDir" class="hint warn">
        <IconGlyph name="info" class="hint-ico" />
        尚未设置目标目录，安装将无法进行。
      </div>
      <!-- 路径问题就地提示，而不是等到点「安装」才弹窗告知 -->
      <div v-else-if="targetIssue.level === 'block'" class="hint err">
        <IconGlyph name="info" class="hint-ico" />
        {{ targetIssue.message }}
      </div>
      <div v-else-if="targetIssue.level === 'warn'" class="hint warn">
        <IconGlyph name="info" class="hint-ico" />
        {{ targetIssue.message }}
      </div>
      <div v-else-if="targetIsMaibot" class="hint ok">
        <IconGlyph name="check" class="hint-ico" />
        该目录下已存在 MaiBot 安装，可使用下方「升级」。
      </div>
    </PanelCard>

    <!-- 前置检查 -->
    <PanelCard title="前置检查" desc="Python 版本与运行依赖（读取目标目录的 requirements.txt）">
      <div class="pre-row">
        <div class="pre-item">
          <span class="pre-label">Python</span>
          <span v-if="pythonCheck" class="chip" :class="{ ok: pythonCheck.ok }">
            {{ pythonCheck.version || pythonCheck.message || '未知' }}
          </span>
          <span v-else class="pre-muted">未检查</span>
        </div>
        <div class="pre-item">
          <span class="pre-label">依赖</span>
          <span v-if="deps.length" class="dep-count">
            <em :class="{ warn: missing.length }">{{ depOkCount }}/{{ deps.length }}</em> 已满足
          </span>
          <span v-else class="pre-muted">未检查</span>
        </div>
        <span v-if="depSource" class="dep-source">来源：{{ depSource }}</span>
        <span class="dep-mode" :title="depMode === 'full' ? '完整检查：读取 pip 版本号，较慢' : '快速检查：只判断是否可导入，约 0.3 秒'">
          {{ depMode === 'full' ? '完整' : '快速' }}
        </span>
        <PillButton variant="ghost" size="sm" icon="refresh" :loading="checking" @click="check()">
          重新检查
        </PillButton>
        <!--
          完整检查只在用户主动点的时候跑：pip list 全量枚举实测约 2.6 秒，
          而快速模式（模块级探测）只要约 0.34 秒。
          代价是快速模式拿不到版本号，所以两种都要有。
        -->
        <PillButton
          variant="plain"
          size="sm"
          icon="info"
          :loading="checkingFull"
          title="读取每个依赖的准确版本号（较慢）"
          @click="check({ mode: 'full' })"
        >
          完整检查
        </PillButton>
      </div>

      <div v-if="missing.length" class="missing">
        <div class="missing-head">
          缺少 {{ missing.length }} 个依赖：
          <span class="missing-names">{{ missing.map((d) => d.name).join('、') }}</span>
        </div>
      </div>

      <div v-if="deps.length" class="dep-grid">
        <span
          v-for="d in visibleDeps"
          :key="d.name"
          class="dep-chip"
          :class="{ ok: d.ok }"
          :title="d.desc"
        >
          {{ d.name }}
        </span>
      </div>
      <!--
        截断提示：此前固定 slice(0, 40) 且不作任何说明，
        依赖多于 40 项时用户以为列表就是全部，看不到后面的缺失项。
      -->
      <div v-if="deps.length > DEP_CHIP_LIMIT" class="dep-more">
        仅显示前 {{ DEP_CHIP_LIMIT }} 项，另有 {{ deps.length - DEP_CHIP_LIMIT }} 项未展示
        <button type="button" class="mini-btn" @click="showAllDeps = !showAllDeps">
          {{ showAllDeps ? '收起' : '展开全部' }}
        </button>
      </div>

      <div class="pre-actions">
        <PillButton
          variant="solid"
          size="sm"
          icon="bolt"
          :loading="depsBusy"
          :disabled="anyBusy || !targetDir"
          @click="installDeps"
        >
          安装 / 更新依赖
        </PillButton>
        <span v-if="depsLog" class="deps-log" :class="{ err: depsFailed }">{{ depsLog }}</span>
      </div>
    </PanelCard>

    <!-- 安装与升级 -->
    <PanelCard title="安装与升级" desc="选择版本 → 多线程下载 → 校验 → 原子替换（升级保留备份）">
      <div class="install-row">
        <div class="install-cell">
          <IconGlyph name="cube" class="install-ico" />
          <div class="install-txt">
            <strong>MaiBot</strong>
            <span>下载源码归档并解压，校验入口文件后落盘</span>
          </div>
          <!--
            版本选择器。
            ⚠️ 这里**不要**因为「该版本没有附件」而报错：MaiBot 的 Release
            是纯源码发布、不带附件，版本号只取自 tag，安装走 codeload 源码归档。
            没有附件是完全正常的，不影响安装。
          -->
          <VersionPicker
            v-model="versions.maibot"
            :repo="repo"
            :disabled="anyBusy"
          />
          <PillButton
            variant="ghost"
            size="sm"
            icon="download"
            :disabled="!targetDir || anyBusy"
            :loading="busy === 'maibot'"
            :title="installTitle('MaiBot', versions.maibot)"
            @click="doInstallMaiBot(versions.maibot)"
          >
            安装
          </PillButton>
          <PillButton
            variant="ghost"
            size="sm"
            icon="refresh"
            :disabled="!targetIsMaibot || anyBusy"
            :loading="busy === 'upgrade'"
            title="升级到最新版本，旧版本会完整保留为备份"
            @click="doUpgradeMaiBot"
          >
            升级
          </PillButton>
        </div>

        <!--
          SnowLuma 行。
          用户明确要求"在 MaiBot 和 SnowLuma 里选一个版本下载安装"，而此前
          installSnowluma 只在设置页有一个不带版本选择的「一键下载」按钮 ——
          安装器页看不到它，也就无从"选版本"。
          仓库取 store.draft/settings.github.snowlumaRepo（与主进程 constants.js
          同源，渲染层不硬编码仓库名）。
        -->
        <div class="install-cell">
          <IconGlyph name="bolt" class="install-ico" />
          <div class="install-txt">
            <strong>SnowLuma</strong>
            <span>从 Release 附件挑 Windows 完整包（自动排除不带 node 的 lite 包）</span>
          </div>
          <VersionPicker
            v-model="versions.snowluma"
            :repo="snowlumaRepo"
            :disabled="anyBusy"
          />
          <PillButton
            variant="ghost"
            size="sm"
            icon="download"
            :disabled="!targetDir || anyBusy"
            :loading="busy === 'snowluma'"
            :title="installTitle('SnowLuma', versions.snowluma)"
            @click="doInstallSnowLuma(versions.snowluma)"
          >
            安装
          </PillButton>
          <!--
            这里刻意**没有**「升级」按钮：主进程只暴露了 installSnowluma，
            没有升级入口。放一个按不动或被 v-if 藏住的按钮只会让用户以为
            功能坏了；想要新版本就直接再装一次（安装会整体替换该服务目录）。
          -->
        </div>

        <!--
          每行自己的进度：装在哪个服务上一眼可见。
          原先只有卡片底部一个共用的进度区，还按固定的服务名硬编码两行渲染 ——
          多个服务同时在场时根本分不清是哪一行在下载。
          现在有几行安装卡片就渲染几行进度（MaiBot 与 SnowLuma）。
        -->
        <div v-if="progress.maibot" class="row-prog">
          <DownloadProgress :data="progress.maibot" label="MaiBot" />
        </div>
        <div v-if="progress.snowluma" class="row-prog">
          <DownloadProgress :data="progress.snowluma" label="SnowLuma" />
        </div>
      </div>

      <!--
        磁盘与备份信息条。
        安装/升级动辄数百 MB，且升级会刻意保留旧版本备份 ——
        过去这两件事在界面上都不可见：用户不知道盘还剩多少，
        也不知道每升一次级就多出一份几百 MB 的备份。
      -->
      <div v-if="targetDir" class="disk-bar">
        <span class="disk-item">
          <IconGlyph name="cube" class="disk-ico" />
          <span>可用空间</span>
          <strong :class="{ low: diskLow }">
            {{ disk.ok ? diskFreeText : disk.message || '读取中…' }}
          </strong>
        </span>
        <span v-if="backups.length" class="disk-item">
          <IconGlyph name="refresh" class="disk-ico" />
          <span>升级备份</span>
          <strong>{{ backups.length }} 个 · {{ backupTotalText }}</strong>
          <button
            class="mini-btn"
            type="button"
            :disabled="backupBusy"
            title="删除全部升级备份（当前版本不受影响）"
            @click="doCleanBackups"
          >
            {{ backupBusy ? '清理中…' : '清理' }}
          </button>
        </span>
        <span class="bar-spacer" />
        <button class="mini-btn" type="button" @click="refreshDiskAndBackups">刷新</button>
      </div>

      <div v-if="diskLow" class="disk-warn">
        <IconGlyph name="info" />
        可用空间低于 {{ humanSize(MIN_FREE_BYTES) }}，安装或解压可能中途失败。
      </div>

      <div v-if="lastResult" class="result" :class="{ err: !lastResult.ok }">
        <IconGlyph :name="lastResult.ok ? 'check' : 'close'" class="result-ico" />
        <div class="result-txt">
          <div>{{ lastResult.message }}</div>
          <div v-if="lastResult.path" class="result-path" :title="lastResult.path">
            {{ lastResult.path }}
            <button class="mini-btn" @click="reveal(lastResult.path)">打开位置</button>
          </div>
          <div v-if="lastResult.backupDir" class="result-path">
            备份：{{ lastResult.backupDir }}
            <button class="mini-btn" @click="reveal(lastResult.backupDir)">打开位置</button>
          </div>
          <div v-if="lastResult.available?.length" class="result-path">
            该版本可用附件：{{ lastResult.available.join('、') }}
          </div>
        </div>
      </div>
    </PanelCard>
    </template>

    <!--
      「版本下载」子标签：直接内嵌原下载页组件，不复制它的逻辑。
      组件挂载时自己会 loadPaths() + loadReleases()，所以这里不需要额外接线。
    -->
    <DownloadPanel v-else />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PanelCard from '../components/ui/PanelCard.vue';
import FieldRow from '../components/ui/FieldRow.vue';
import TextInput from '../components/ui/TextInput.vue';
import PillButton from '../components/ui/PillButton.vue';
import IconGlyph from '../components/IconGlyph.vue';
/* 版本选择与进度展示都抽成了共用组件：两处复制必然分叉（速率/校验口径） */
import VersionPicker from '../components/ui/VersionPicker.vue';
import DownloadProgress from '../components/ui/DownloadProgress.vue';
import DownloadPanel from './DownloadPanel.vue';
import { toast } from '../composables/useToast.js';
import {
  applySettings,
  buildStartPayload,
  checkPorts,
  checkPythonVersion,
  cleanBackups,
  checkDependencies,
  confirmDialog,
  detectAdapter,
  detectAll,
  getDiskSpace,
  installDependencies,
  GUIDE_ENTRY_VISIBLE,
  installMaiBot,
  installSnowluma,
  isPortOpen,
  listBackups,
  loadPaths,
  logsOf,
  openExternal,
  openOnboarding,
  openPath,
  probeDirs,
  resolveStartPayload,
  selectDirectory,
  startService,
  store,
  subscribeDepsStatus,
  subscribeDownload,
  upgradeMaiBot
} from '../stores/app-store.js';
import { readEulaState } from '../onboarding/eula-prompt.js';
import {
  DEPLOY_IDS,
  MIN_FREE_BYTES as DEPLOY_MIN_FREE_BYTES,
  buildDeploySteps,
  deploySummary,
  diskRootOf,
  installDirFor,
  normalizePath as deployNormalizePath,
  /*
    目录校验的**判定**统一来自 deploy-flow（纯函数、有断言），
    这里只做别名，避免与本页原有的 validateTargetDir 重名 ——
    两者口径必须一致（block/warn/ok 与系统目录清单都一样），
    所以新增判定一律写在 deploy-flow 里，本页那份只服务旧的行内提示。
  */
  validateTargetDir as deployValidateTargetDir
} from '../onboarding/deploy-flow.js';

const repo = ref(store.settings?.github?.repo || 'Mai-with-u/MaiBot');
const python = ref(store.draft?.service?.pythonPath || 'python');
/*
  安装目标目录的语义是**父目录**：主进程会在这里新建 maibot/ 与 snowluma/
  （installMaiBot 的 installRoot = <targetDir>/maibot）。
  而设置里的 maibotDir 是**安装目录本身**（…\modules\maibot）。

  这里原来直接写的是 maibotDir，于是安装页一打开就把"已经装好的那个目录"
  摆进输入框：点「安装」会往里面再套一层 —— 得到 …\modules\maibot\maibot，
  用户看到的是"装完了但启动器还是找不到"。所以预填时先退到父级。
*/
const targetDir = ref(parentOf(store.draft?.service?.maibotDir) || '');

/*
  子标签状态（'install' | 'download'）。
  与 ?tab= 查询参数同步的两个理由：
    1) #/download 旧地址重定向到 /installer?tab=download，要能直接落在下载上；
    2) 刷新或把地址发给别人后，仍停在同一个子标签。
  用 replace 而不是 push：子标签属于页内视图状态，不该污染「后退」历史。
*/
const route = useRoute();
const router = useRouter();
const sub = ref(route.query.tab === 'download' ? 'download' : 'install');

function setSub(next) {
  const v = next === 'download' ? 'download' : 'install';
  sub.value = v;
  const cur = route.query.tab === 'download' ? 'download' : 'install';
  if (cur === v) return;
  router.replace({ path: '/installer', query: v === 'download' ? { tab: 'download' } : {} });
}

watch(
  () => route.query.tab,
  (t) => {
    sub.value = t === 'download' ? 'download' : 'install';
  }
);

const checking = ref(false);
/** 完整检查（pip list）单独一个 loading，避免和快速检查的按钮状态互相干扰 */
const checkingFull = ref(false);

/*
  统一的进行中标志（''=空闲）。
  此前这里是两套互不知情的标志：`installing`（依赖安装）与 `busy`（安装/升级）。
  两者各自为政 → 用户可以一边"安装依赖"一边"安装 MaiBot"，
  两个操作同时写同一个目录（pip 装依赖 + 解压覆盖源码），结果不可预期。
  现在合并成单一来源：
    'deps' | 'maibot' | 'upgrade' | 'snowluma'
  取值集合必须与所有 busy.value = ... 的赋值严格一致：
  多写一个不存在的取值只会让人以为还有别的分支（这类"幽灵状态"最误导人）。
*/
const busy = ref('');

/** 任一操作进行中 —— 用于禁用所有会改动目标目录的按钮 */
const anyBusy = computed(() => busy.value !== '');
/** 依赖安装相关按钮的 loading */
const depsBusy = computed(() => busy.value === 'deps');

const depsLog = ref('');
const depsFailed = ref(false);
const pythonCheck = ref(null);
const deps = ref([]);
const depSource = ref('');
/** 当前依赖结果的来源模式：quick | full */
const depMode = ref('quick');
const lastResult = ref(null);

/*
  依赖 chip 的默认展示上限。
  此前是模板里裸写的 slice(0, 40)：超出部分既不显示也不提示，
  用户看不到后面还有缺失的依赖。现在给出上限常量 + 明确的展开入口。
*/
const DEP_CHIP_LIMIT = 40;
const showAllDeps = ref(false);
const visibleDeps = computed(() =>
  showAllDeps.value ? deps.value : deps.value.slice(0, DEP_CHIP_LIMIT)
);

/*
  各服务的下载进度。
  每个可安装的服务（MaiBot / SnowLuma）都要有独立槽位：
  共用一个字段的话，同时装两个服务时进度会互相覆盖，
  界面上会出现"这一行显示着另一个服务的速率"这种张冠李戴。
*/
const progress = reactive({ maibot: null, snowluma: null });

/* ---------------------------------------------------------------- 磁盘与备份 */

/**
 * 目标盘的可用空间。
 * 安装/升级动辄几百 MB，磁盘满了会在下载中途失败并留下半个目录，
 * 所以要在点按钮之前就把可用空间摆出来，并在空间不足时拦一下。
 * （getDiskSpace 这个后端能力此前完全没被前端调用过。）
 */
const disk = ref({ ok: false, freeBytes: 0, totalBytes: 0, message: '' });

/** 升级备份（旧版本会一直被保留，需要给用户一个发现与清理的入口） */
const backups = ref([]);
const backupBusy = ref(false);

/** 安装所需的最低可用空间（含解压余量），低于此值给出警告 */
const MIN_FREE_BYTES = 800 * 1024 * 1024;

/*
  目标目录校验。
  之前这个字段是**完全自由的文本**：可以填 C:\Windows、盘根 D:\、甚至相对路径。
  而安装函数会以 keepBackup:false 调 swapDirectory —— 也就是**永久删除**目标下的
  maibot/ 或 snowluma/ 子目录。填错一个盘根就等于往系统盘里塞目录。
  分三级处置：
    block  直接拒绝（系统关键目录）
    warn   需用户明确接受（盘根 / 相对路径）
    ok     放行
*/
const IS_WINDOWS = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');

/** 真正的盘根 C:\ 或 UNC 共享根 \\server\share */
const ROOT_PATH_RE = /^[a-zA-Z]:[\\/]?$|^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/;

/*
  绝不允许作为安装目标的系统关键位置。

  ⚠️ 这里原来还列着 `Users`，匹配的是 `^C:\Users\` —— 也就是把
  **整个用户目录树**都判成了系统关键目录。而"把机器人装在桌面/文档里"
  恰恰是最常见的用法（本机实测：用户的安装目录就在
  C:\Users\<用户>\Desktop\桌面所有文件夹\modules\maibot），
  结果安装页上来就是一条通红的中止提示，用户完全不知道自己做错了什么。

  现在只拦真正的系统位置：Windows / Program Files / ProgramData / …
  以及 `C:\Users` 这个目录**本身**（往里装等于污染所有用户的家目录），
  但它的子目录一律放行 —— 那是用户自己的地盘。
*/
const FORBIDDEN_RE =
  /^[a-zA-Z]:[\\/](Windows|Program Files(?: \(x86\))?|ProgramData|System32|SysWOW64|PerfLogs|Recovery|Boot|System Volume Information)(?:[\\/]|$)/i;
/** C:\Users 本身（不含子目录） */
const USERS_ROOT_RE = /^[a-zA-Z]:[\\/]Users[\\/]?$/i;

/**
 * 从"安装目录"退到"安装目标目录（父目录）"。
 * · …\modules\maibot      → …\modules
 * · …\modules\snowluma    → …\modules
 * · 目录名被用户改过（不以 maibot/snowluma 结尾）→ 取其父级
 */
function parentOf(dir) {
  const p = String(dir || '').trim();
  if (!p) return '';
  const m = /^(.*)[\\/](?:maibot|snowluma)[\\/]?$/i.exec(p);
  if (m && m[1]) return m[1];
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return cut > 2 ? p.slice(0, cut) : p;
}

/**
 * 依赖检查 / 升级真正要作用的安装目录。
 * targetDir 是**父目录**，实际安装位置是 <targetDir>/maibot；
 * 但也允许用户把安装目录本身填进来（那种情况下以它为准）。
 * 优先按已知安装记录判断，避免在渲染层猜路径。
 */
function effectiveInstallDir() {
  const parent = String(targetDir.value || '').trim();
  if (!parent) return undefined;
  const nested = parent.replace(/[\\/]+$/, '') + '\\maibot';
  const paths = (store.installations || []).map((i) => i.path);
  if (paths.includes(nested)) return nested;
  if (paths.includes(parent)) return parent;
  return nested;
}

function normalizeTargetPath(input) {
  let p = String(input || '').trim();
  if (!p) return { ok: false, message: '请先设置目标目录' };
  /* 统一分隔符：用户常从别处粘贴带正斜杠的路径 */
  if (IS_WINDOWS) p = p.replace(/\//g, '\\');
  /* 去掉末尾分隔符（但保留 D:\ 这种盘根本身） */
  if (p.length > 3 && /[\\/]$/.test(p)) p = p.replace(/[\\/]+$/, '');
  return { ok: true, path: p };
}

function validateTargetDir(input) {
  const norm = normalizeTargetPath(input);
  if (!norm.ok) return { level: 'block', message: norm.message };
  const p = norm.path;

  if (FORBIDDEN_RE.test(p) || USERS_ROOT_RE.test(p)) {
    return {
      level: 'block',
      message: `${p} 是系统关键目录，不能作为安装目标。请改用普通数据目录，例如 D:\\MaiBot`
    };
  }
  if (ROOT_PATH_RE.test(p)) {
    return {
      level: 'warn',
      message: `${p} 是${/^[\\/]{2}/.test(p) ? '共享根' : '盘根'}目录。安装会在其中新建 maibot/ 与 snowluma/，容易与其他内容混在一起。`
    };
  }
  if (!IS_WINDOWS && !/^[\\/]/.test(p)) {
    return { level: 'warn', message: `${p} 是相对路径，安装结果会随启动目录变化，建议改用绝对路径。` };
  }
  return { level: 'ok', path: p };
}

/**
 * 安装前的路径校验闸门。
 * 返回归一化后的路径供调用方使用；用户拒绝或路径非法时返回空串。
 */
async function guardTargetDir() {
  const v = validateTargetDir(targetDir.value);
  if (v.level === 'block') {
    toast(v.message, 'error', 7000);
    return '';
  }
  if (v.level === 'ok') {
    /* 归一化后回写，后续所有路径拼接都用这个形式 */
    if (v.path !== targetDir.value) targetDir.value = v.path;
    return targetDir.value;
  }
  const go = await confirmDialog({
    type: 'warning',
    title: '目标目录建议更换',
    message: v.message,
    detail: `即将使用的目录：${v.path || targetDir.value}`,
    buttons: ['返回修改', '仍然使用'],
    defaultId: 0
  });
  if (!go) return '';
  if (v.path) targetDir.value = v.path;
  return targetDir.value;
}

const diskFreeText = computed(() => humanSize(disk.value.freeBytes));

/** 当前的路径问题（空 / 系统目录 / 盘根 / 相对路径），用于内联提示 */
const targetIssue = computed(() => {
  if (!targetDir.value) return { level: 'none', message: '' };
  const v = validateTargetDir(targetDir.value);
  return v.level === 'ok' ? { level: 'none', message: '' } : v;
});
const diskLow = computed(() => disk.value.ok && disk.value.freeBytes > 0 && disk.value.freeBytes < MIN_FREE_BYTES);
const backupTotalText = computed(() => humanSize(backups.value.reduce((s, b) => s + (b.sizeBytes || 0), 0)));

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * 读取目标目录所在磁盘的可用空间与备份列表。
 *
 * 备份路径语义（曾是本功能完全失效的原因）：
 *   主进程的 listBackups(d) 扫描的是 **dirname(d)**，匹配 `<basename(d)>.backup-*` /
 *   `<basename(d)>.old-*`。而真实备份落点是每个服务安装目录的**同级**：
 *     MaiBot   : `<maibotDir>.backup-<ts>`
 *     SnowLuma : `<snowlumaDir>.backup-<ts>`
 *   这里曾只传 targetDir（那是个**父目录**，如 D:\MaiBot），
 *   于是去扫 D:\ 找 `D:\MaiBot.backup-*` —— 永远为空。
 *   后果：备份列表恒空 → 「升级备份」区块与「清理」按钮永不显示 → 备份静默堆积数百 MB。
 *
 * 因此必须分别用 maibotDir 与 snowlumaDir 各查一次。备份条目上带 installDir，
 * 供 cleanBackups 按同一父目录分组校验（它会拒绝删除非同级目录）。
 */
async function refreshDiskAndBackups() {
  const dir = targetDir.value;
  if (!dir) {
    disk.value = { ok: false, freeBytes: 0, totalBytes: 0, message: '' };
    backups.value = [];
    return;
  }
  const d = await getDiskSpace(dir);

  /*
    每个服务的安装目录各查一次：备份只可能躺在安装目录的同级，
    而 MaiBot 与 SnowLuma 装在哪由设置决定（两者可以指向完全不同的盘）。
    这里用 service.*Dir 而不是 targetDir —— 后者是它们共同的**父目录**。
  */
  const candidates = [store.draft?.service?.maibotDir, store.draft?.service?.snowlumaDir]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  const merged = new Map();
  await Promise.all(
    candidates.map(async (installDir) => {
      const r = await listBackups(installDir);
      if (!r || !r.ok || !Array.isArray(r.backups)) return;
      for (const b of r.backups) {
        /* 去重：两个服务指向同一目录时不重复列出 */
        if (!merged.has(b.path)) merged.set(b.path, { ...b, installDir });
      }
    })
  );

  disk.value = d.ok
    ? { ok: true, freeBytes: d.freeBytes || 0, totalBytes: d.totalBytes || 0, message: '' }
    : { ok: false, freeBytes: 0, totalBytes: 0, message: d.message || '无法读取磁盘空间' };
  backups.value = [...merged.values()];
}

/**
 * 空间不足时拦一道（用户可确认继续）。
 *
 * 先刷新再判断：disk.value 只在挂载、targetDir 变化（异步、未 await）
 * 和手动刷新时更新。用户手输目录后立刻点安装时，这里读到的可能还是
 * **上一个目录所在磁盘**的剩余空间；而初始值 ok:false 会被直接放行，
 * 于是空间不足完全没有拦截。刷新一次成本很低（一次 IPC 的 statfs）。
 */
async function guardDiskSpace() {
  await refreshDiskAndBackups();
  if (!disk.value.ok) {
    /* 读不到就如实说明，不假装充足、也不硬拦 */
    return confirmDialog({
      type: 'warning',
      title: '无法读取磁盘剩余空间',
      message: `未能读取 ${targetDir.value} 所在磁盘的可用空间：${disk.value.message || '未知原因'}`,
      detail: '如果空间不足，下载或解压可能中途失败并留下不完整目录。仍要继续吗？',
      buttons: ['取消', '仍然继续'],
      defaultId: 0
    });
  }
  if (disk.value.freeBytes >= MIN_FREE_BYTES) return true;
  return confirmDialog({
    type: 'warning',
    title: '磁盘可用空间不足',
    message: `${targetDir.value} 所在磁盘仅剩 ${diskFreeText.value}，低于建议的 ${humanSize(MIN_FREE_BYTES)}。`,
    detail: '下载或解压可能在中途失败，并留下不完整的目录。仍要继续吗？',
    buttons: ['取消', '仍然继续'],
    defaultId: 0
  });
}

/**
 * 安装前的破坏性操作拦阻。
 *
 * 背景（这是本项目最危险的一处行为）：
 *   主进程的 installMaiBot / installSnowLuma 会以 keepBackup:false
 *   调用 swapDirectory，而该分支会 `fsp.rm(backup)` ——
 *   即**永久删除**被替换掉的旧安装目录，不留任何备份。
 *   而 installRoot 固定是 <targetDir>/maibot 或 <targetDir>/snowluma
 *   （两个服务同构，唯一的差别就是这个名字）。
 *   所以"点一次安装"就可能把用户已有的安装（含配置、登录态）
 *   连同备份一起抹掉，且无法回滚。
 *
 * 本函数在动手前探测这些目录，并按情况给出不同处置：
 *   不存在/空目录 → 放行（真正的全新安装）
 *   已有内容     → 默认「取消」，引导走可回滚的「升级」；
 *                  用户坚持时才明确接受"删除且无备份"
 *
 * @param {'maibot'|'snowluma'} kind
 * @returns {Promise<boolean>} true = 继续安装
 */
async function guardExistingInstall(kind) {
  const root = String(targetDir.value || '').trim();
  if (!root) return false;

  const probe = await probeDirs([`${root}\\${kind}`]);
  if (!probe.ok) {
    /* 探测失败不能当成"安全"：宁可让用户确认一次 */
    return confirmDialog({
      type: 'warning',
      title: '无法确认目标目录状态',
      message: `无法探测 ${root}\\${kind} 是否已存在：${probe.message || '未知原因'}`,
      detail: '如果该目录已有内容，安装会将其永久删除且不保留备份。仍要继续吗？',
      buttons: ['取消', '仍然继续'],
      defaultId: 0
    });
  }

  const hit = (probe.results || []).find((x) => x.exists && !x.empty);
  if (!hit) return true; /* 不存在或空目录：安全 */

  /* 各服务对外显示名 —— 用查表而不是三元表达式（再加服务时三元必漏一路） */
  const LABEL = { maibot: 'MaiBot', snowluma: 'SnowLuma' };
  const label = LABEL[kind] || kind;
  const known = store.installations.find((i) => i.type === kind && String(i.path) === String(hit.path));
  const versionText = known?.version ? `（已识别版本 ${known.version}）` : '';

  /*
    默认按钮是「取消」(defaultId:0)：破坏性操作不应让回车直接执行。
    提示语按服务区分：只有 MaiBot 有可回滚的「升级」按钮，
    SnowLuma 没有升级入口（主进程也没提供），对它说"改用升级"是空指向 ——
    用户会去找一个不存在的按钮。
  */
  const safePathHint =
    kind === 'maibot'
      ? `如果只是想更新版本，请改用上方的「升级 ${label}」按钮：它会先把旧版本完整备份，失败可回滚。`
      : '如果只是想更新版本，请先手动把该目录改名留档，再重新安装（当前没有可回滚的自动升级入口）。';

  const choice = await confirmDialog({
    type: 'warning',
    title: `目标位置已存在 ${label}`,
    message: `${hit.path} ${versionText} 已有内容（${hit.fileCount} 项）。`,
    detail:
      '继续「安装」会用新版本整体替换该目录，并且**不保留备份** —— ' +
      '其中的配置、插件与登录态会一并丢失，无法回滚。\n\n' +
      `${safePathHint}\n\n` +
      '确定要用安装方式覆盖吗？',
    buttons: ['取消', '仍然覆盖安装'],
    defaultId: 0,
    cancelId: 0
  });

  if (!choice) {
    /* 同样按服务给可执行的下一步，不指向不存在的按钮 */
    const nextStep = kind === 'maibot' ? `请使用「升级 ${label}」` : '请先手动改名留档';
    toast(`已取消。若要更新 ${label}，${nextStep}`, 'info', 5000);
    return false;
  }
  return true;
}

/** 清理全部备份（先 dryRun 告诉用户会释放多少） */
async function doCleanBackups() {
  if (!backups.value.length) {
    toast('没有需要清理的备份', 'info');
    return;
  }

  /*
    按 installDir 分组：cleanBackups 要求同一次调用的 paths 都属于 installDir 的
    同级目录，否则会以「拒绝删除非同级目录」整体拒绝。
    MaiBot 与 SnowLuma 的备份位于各自安装目录的同级，必须分开调用。
  */
  const groups = new Map();
  for (const b of backups.value) {
    const key = b.installDir || targetDir.value;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b.path);
  }

  const call = (dryRun) =>
    Promise.all([...groups.entries()].map(([installDir, paths]) => cleanBackups({ installDir, paths, dryRun })));

  backupBusy.value = true;
  try {
    const previews = await call(true);
    const failedPreview = previews.find((p) => !p || !p.ok);
    if (failedPreview) {
      toast(failedPreview.message || '无法预览清理结果', 'error');
      return;
    }

    const totalText = previews.map((p) => p.message).filter(Boolean).join('；');
    const freed = previews.reduce((s, p) => s + (p.freedBytes || 0), 0);

    const yes = await confirmDialog({
      type: 'warning',
      title: '清理升级备份',
      message: totalText || '将删除全部升级备份',
      detail: `备份是旧版本，删除后无法回滚到该版本（当前版本不受影响）。预计释放 ${humanSize(freed)}。`,
      buttons: ['取消', '删除备份'],
      defaultId: 0
    });
    if (!yes) return;

    const results = await call(false);
    const okGroups = results.filter((r) => r && r.ok).length;
    const failGroups = results.length - okGroups;
    /* removed / failed 都是数组（github.js:1031-1039），必须取 length */
    const removedCount = results.reduce((s, r) => s + (r?.removed?.length || 0), 0);
    const failedCount = results.reduce((s, r) => s + (r?.failed?.length || 0), 0);
    /* 如实汇报部分失败，而不是笼统说"已清理" */
    if (failGroups || failedCount) {
      const firstErr = results.find((r) => r && !r.ok);
      const firstFailed = results.flatMap((r) => r?.failed || [])[0];
      const reason = firstErr?.message || firstFailed?.message || '未知原因';
      toast(`已删除 ${removedCount} 项，${failedCount || '若干'} 项失败：${reason}`, 'warn', 6000);
    } else {
      toast(`已删除 ${removedCount} 项备份，释放约 ${humanSize(freed)}`, 'success', 5200);
    }
    await refreshDiskAndBackups();
  } catch (e) {
    /* 此前只有 finally 没有 catch：失败时用户只看到按钮转圈，没有任何原因 */
    toast(`清理备份失败：${e?.message || e}`, 'error', 5000);
  } finally {
    backupBusy.value = false;
  }
}

/* ================================================================ 首跑部署流程 */

/*
  这一段的判定逻辑一行都不在这里 —— 全在 src/renderer/onboarding/deploy-flow.js
  （纯函数，由 scripts/verify-deploy-flow.mjs 用真实机器数据断言）。
  本组件只做两件事：
    1) 把真实状态拼成 snapshot（每一项都注明来源频道）；
    2) 把步骤里的 action 接到本页**已有的**函数上（安装 / 依赖 / 启动），
       不新增任何写文件的旁路。

  ⚠️ 所有探测都是只读的：detect-* / system:disk-space / github:probe-dirs。
     真正的下载与启动只发生在用户点具体按钮时，走的是本页原来的通道。
*/
const deployRefreshing = ref(false);
/** 探测期间又来了一次请求：记下来，跑完补一趟（丢弃会让界面停在旧快照） */
let deployPending = false;
/** 展开中的步骤 id（'' = 全收起；默认展开"当前这一步"） */
const depCursor = ref('');
const deployBusy = ref('');

/** 部署进度本地标记：只用于「选位置」这一件启动器看不到结论的事 */
const DEPLOY_MARKS_KEY = 'deploy.doneIds';
function loadDeployMarks() {
  try {
    const raw = localStorage.getItem(DEPLOY_MARKS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch (_) {
    return [];
  }
}
function saveDeployMarks() {
  try {
    localStorage.setItem(DEPLOY_MARKS_KEY, JSON.stringify(deployMarks.value));
  } catch (_) {
    /* 存不了只影响持久化，不影响本次使用 */
  }
}
const deployMarks = ref(loadDeployMarks());

/** 状态徽标文案（三态，没有"看起来配好了"） */
const DEPLOY_TAG = { done: '已完成', ready: '下一步', blocked: '待处理' };

const deploySnap = ref({
  tools: null,
  disk: null,
  diskTarget: '',
  maibot: null,
  maibotVersion: null,
  snowluma: null,
  targetDir: '',
  suggestedTarget: '',
  diskProbe: null,
  installations: [],
  deps: null,
  eula: { state: 'none' },
  running: [],
  ports: {},
  minFreeBytes: DEPLOY_MIN_FREE_BYTES
});

/** 目录的父级（与下面 parentOf 同一口径：…\modules\maibot → …\modules） */
function deployParentOf(dir) {
  const p = deployNormalizePath(dir);
  if (!p) return '';
  const m = /^(.*)[\\/](?:maibot|snowluma)[\\/]?$/i.exec(p);
  if (m && m[1]) return m[1];
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return cut > 2 ? p.slice(0, cut) : p;
}

/**
 * 把当前真实状态拼成 snapshot。
 * 每一项的来源：
 *   detectAll()          → env:detect-all（tools / maibot / maibotVersion / snowluma / running）
 *   detectAdapter()      → env:detect-adapter（适配器插件是否就位，env:detect-all 里没有）
 *   detectDirKind()      → env:detect-kind（**要装进去的那个目录**当前是什么）
 *   probeDirs()          → github:probe-dirs（目标下 maibot\/snowluma\ 是否已有内容）
 *   getDiskSpace()       → system:disk-space（真实 statfs）
 *   store.services       → service:status（进程注册表，同步读）
 *   store.info.userData  → app:info（默认安装位置的依据）
 *
 * ⚠️ 重入必须**排队**而不是丢弃：
 *   本函数由挂载、目录变化、检查依赖、安装完成、启动完成多处触发，
 *   一次探测（env:detect-all 要 spawn 几条版本命令 + statfs）必然与其中
 *   某几次调用重叠。此前是"在跑就直接 return" —— 被丢掉的那次
 *   通常正是**带着最新结果**的那次（依赖检查/安装完成刚回来的那次），
 *   表现是界面永远停在旧快照："依赖 0/0"、"还没安装"这类过期结论。
 *   实测在安装器页复现（全页截图里第 1 步是新的、2-6 步还是空的，就是它）。
 *   现在改成：在跑就记一个 pending，跑完再补一次，保证最后一次一定落地。
 */
async function refreshDeploySnapshot() {
  if (deployRefreshing.value) {
    deployPending = true;
    return;
  }
  deployRefreshing.value = true;
  try {
    do {
      deployPending = false;
      await runDeployProbe();
    } while (deployPending);
  } finally {
    deployRefreshing.value = false;
  }
}

/** 真正干活的那一趟（失败的报错在 refreshDeploySnapshot 的调用方之外不抛） */
async function runDeployProbe() {
  try {
    const all = await detectAll();
    if (!all?.ok) throw new Error(all?.message || '环境探测失败');

    /*
      适配器插件要在**启动器真正认的那一个 MaiBot 目录**里找。
      这里此前直接读 store.draft.service.maibotDir —— 用户在别处改过设置、
      或该目录已被搬走时两者就不一致，表现是"MaiBot 目录里明明有官方插件，
      部署清单却说没检测到"（实测踩到）。
      env:detect-all 给的 all.maibot.dir 是**真实读盘识别出来**的那一份，
      以它为准；识别不出来才退回设置里写的值。
    */
    const adapterDir =
      all.maibot?.ok !== false && all.maibot?.kind === 'maibot'
        ? String(all.maibot.dir || '')
        : String(store.draft?.service?.maibotDir || store.settings?.service?.maibotDir || '');
    const adapter = await detectAdapter({ dir: adapterDir });

    /* 磁盘要探测"真正会写入的那个位置"（见下面 deployEffectiveTarget 的说明） */
    const disk = await getDiskSpace(diskRootOf(installDirFor(deployEffectiveTarget(), 'maibot')) || '');

    const targetDirValue = deployEffectiveTarget();
    /*
      目标下 maibot\ / snowluma\ 现在有没有内容。
      这是"检测到就提示复用、不要默认覆盖"的一半依据（另一半是 detect-all
      识别出的那份真实安装）；探测结果就是 exists / empty / fileCount，不做二次解释。
    */
    const targetProbe = targetDirValue
      ? await probeDirs([installDirFor(targetDirValue, 'maibot'), installDirFor(targetDirValue, 'snowluma')])
      : null;

    /*
      EULA 状态：从**麦麦自己的输出**里读（onboarding/eula-prompt.js 的判定，
      依据是 bot.py 里真实存在的三条分支，不是猜文本）。
      为什么这一项对"首跑部署"是必需的：首次启动麦麦会卡在 input() 上等
      中文「同意」，界面上表现成"点了启动、显示已启动、但什么都没有" ——
      部署流程必须能指出"它现在停在协议确认上"，否则用户无从下手。
      ⚠️ 这里只读状态，**不代用户同意任何条款**（见 eula-prompt.js 顶部说明）。
    */
    const eula = readEulaState(
      (logsOf('maibot') || []).map((l) => l.text || '').join('\n')
    );

    deploySnap.value = {
      ...deploySnap.value,
      tools: all.tools || null,
      maibot: all.maibot || null,
      maibotVersion: { ...(all.maibotVersion || {}), adapter: adapter?.ok ? adapter.adapter : null },
      snowluma: all.snowluma || null,
      running: Array.isArray(all.running) ? all.running : [],
      installations: Array.isArray(store.installations) ? store.installations : [],
      disk: disk?.ok
        ? { ok: true, freeBytes: Number(disk.freeBytes) || 0, totalBytes: Number(disk.totalBytes) || 0 }
        : { ok: false, message: disk?.message || '无法读取磁盘空间' },
      diskTarget: diskRootOf(installDirFor(targetDirValue, 'maibot')),
      targetDir: targetDirValue,
      diskProbe: targetProbe,
      suggestedTarget: deploySuggestedTarget(),
      ports: {
        maibot: Number(store.draft?.service?.ports?.maibot) || 8080,
        maibotWebui: Number(store.draft?.service?.ports?.webui) || 8001,
        snowlumaWebui: Number(store.draft?.service?.snowlumaPorts?.webui) || 5099,
        snowlumaOnebot: Number(store.draft?.service?.snowlumaPorts?.onebot) || 7988
      },
      deps: deployDepsSnapshot(),
      eula,
      minFreeBytes: DEPLOY_MIN_FREE_BYTES
    };
  } catch (e) {
    toast(`部署检查失败：${e?.message || e}`, 'error', 5000);
  }
}

/*
  麦麦的输出是流式的：首次启动时"它在等协议确认"这件事只会出现在新日志里。
  所以只重算**这一项**（不重跑整套探测 —— 那会让界面每来一行日志就闪一次），
  并且做 800ms 防抖：冷启动时日志是一串一串来的，逐行重算没有意义。
*/
let eulaTimer = null;
watch(
  () => (logsOf('maibot') || []).length,
  () => {
    if (eulaTimer) window.clearTimeout(eulaTimer);
    eulaTimer = window.setTimeout(() => {
      eulaTimer = null;
      const eula = readEulaState((logsOf('maibot') || []).map((l) => l.text || '').join('\n'));
      if (eula.state !== deploySnap.value.eula?.state) {
        deploySnap.value = { ...deploySnap.value, eula };
      }
    }, 800);
  }
);

/**
 * "要装进哪"的当前值。
 * 优先用户在本页输入框里填的；没填就用已保存安装目录的父级 ——
 * 这与本页 targetDir 的预填规则完全一致（见上面的注释），不许出现第二套口径。
 */
function deployEffectiveTarget() {
  const typed = deployNormalizePath(targetDir.value);
  if (typed) {
    /*
      用户填的位置先归一化（统一反斜杠、去尾分隔符）再回写：
      否则字符串比较会出现"D:\MaiBot\" 与 "D:\MaiBot" 被当成两个位置，
      探测缓存、备份查询、安装都不会命中。
      校验结果这里不用（步骤表里会给出 block/warn 与原因），只借它的归一化。
    */
    const v = deployValidateTargetDir(typed);
    if (v.path && v.path !== targetDir.value) targetDir.value = v.path;
    return v.path || typed;
  }
  const configured = deployParentOf(store.draft?.service?.maibotDir || store.settings?.service?.maibotDir || '');
  return configured;
}

/**
 * 推荐位置：启动器自己的数据目录旁边。
 * 理由（要显示给用户）：它一定存在、是启动器有权写的普通目录，不需要管理员权限；
 * 而且和数据/日志在一起，将来找备份不会找不到。
 * app:info 拿不到（极少数情况）时返回空串 —— 那时界面只说"点选择目录"，不编一个路径。
 */
function deploySuggestedTarget() {
  const ud = String(store.info?.userData || '').trim();
  if (!ud) return '';
  return deployNormalizePath(ud.replace(/[\\/]+$/, '')) + '\\MaiBot';
}

/** 依赖检查结果 → snapshot 里 deps 的形状（字段名与主进程一致，不做二次翻译） */
function deployDepsSnapshot() {
  if (!Array.isArray(deps.value) || !deps.value.length) return null;
  return {
    ok: true,
    source: depSource.value,
    mode: depMode.value,
    dependencies: deps.value
  };
}

const deploySteps = computed(() =>
  buildDeploySteps(deploySnap.value, { doneIds: deployMarks.value })
);
const deployProgress = computed(() => deploySummary(deploySteps.value));

/* 当前这一步自动展开（可重入的关键：任何时候打开都停在"现在该做的那一步"） */
watch(
  () => deploySteps.value.find((s) => s.current)?.id || '',
  (id) => {
    if (!depCursor.value || deploySteps.value.every((s) => s.id !== depCursor.value)) {
      depCursor.value = id;
    }
  },
  { immediate: true }
);

function markDeployDone(s) {
  if (!deployMarks.value.includes(s.id)) {
    deployMarks.value = [...deployMarks.value, s.id];
    saveDeployMarks();
  }
}
function unmarkDeployDone(s) {
  deployMarks.value = deployMarks.value.filter((x) => x !== s.id);
  saveDeployMarks();
}

/**
 * 动作表：**只跳转 / 打开 / 调用本页已有的安装通道**。
 * 每个 kind 都在这里显式列出，没有 default 兜底 ——
 * 兜底会把"新加了动作却忘了接线"变成静默无反应（本项目踩过这个坑）。
 */
/**
 * 部署流程的按钮列表：教程入口收起时，把「打开新手引导」这个动作**从界面上摘掉**。
 *
 * 只过滤显示，不改 deploy-flow.js 的步骤定义（那是纯函数，另有测试断言其分支），
 * 所以恢复入口时把 GUIDE_ENTRY_VISIBLE 改回 true 即可，这一步不用动。
 * @param {Array<{kind?:string}>} actions
 */
function visibleDeployActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return GUIDE_ENTRY_VISIBLE ? list : list.filter((a) => a?.kind !== 'open-guide');
}

async function runDeployAction(a) {
  if (deployBusy.value) return;
  deployBusy.value = a.key;
  try {
    if (a.kind === 'external') {
      const r = await openExternal(a.url);
      if (!r?.ok) toast(r?.message || '打开浏览器失败', 'warn');
    } else if (a.kind === 'open-guide') {
      openOnboarding({ mode: 'guide' });
    } else if (a.kind === 'refresh') {
      await refreshDeploySnapshot();
    } else if (a.kind === 'pick-dir') {
      await pickTargetDir();
      await refreshDeploySnapshot();
    } else if (a.kind === 'use-suggested') {
      const s = String(deploySnap.value.suggestedTarget || '');
      if (!s) {
        toast('拿不到推荐位置，请点「选择目录」自己挑一个', 'warn');
        return;
      }
      targetDir.value = s;
      await refreshDeploySnapshot();
    } else if (a.kind === 'install-maibot') {
      await doInstallMaiBot(versions.maibot);
      await refreshDeploySnapshot();
    } else if (a.kind === 'check-deps') {
      await check();
      await refreshDeploySnapshot();
    } else if (a.kind === 'install-deps') {
      await installDeps();
      await refreshDeploySnapshot();
    } else if (a.kind === 'start-service') {
      await deployStartService(a.service);
    } else if (a.kind === 'open-webui') {
      await openMaiBotWebui();
    } else if (a.kind === 'route') {
      location.hash = a.hash;
    }
  } finally {
    deployBusy.value = '';
  }
}

/**
 * 启动一个服务。
 * 入口靠主进程探测（resolveStartPayload），渲染层只能拼一个硬编码文件名 ——
 * SnowLuma 的入口名随版本变（index.mjs / launcher.bat），猜错就是 spawn 失败。
 * 探测不可用时才退回本页已有的 buildStartPayload。
 */
async function deployStartService(key) {
  const label = key === 'snowluma' ? 'SnowLuma' : 'MaiBot';
  const probe = await resolveStartPayload(key);
  const payload = probe?.ok && probe.payload ? probe.payload : buildStartPayload(key);
  if (!payload) {
    toast(`${label} 还没配置目录，请先安装或在「设置」里填目录`, 'warn', 5000);
    return;
  }
  const r = await startService(payload);
  await refreshDeploySnapshot();
  if (r?.busy) {
    toast(`${label} 正在启动中，稍等几秒看日志页`, 'info', 5000);
  } else if (r?.degraded) {
    toast(`${label} 已启动，但端口还没就绪 —— 去日志页看它在等什么`, 'warn', 6000);
  } else if (r?.ok) {
    toast(`${label} 已启动`, 'success', 4500);
  } else {
    toast(`${label} 启动失败：${r?.message || '未知原因'}（日志页有完整输出）`, 'error', 7000);
  }
}

/**
 * 打开麦麦 WebUI。
 * 先探端口：没在跑就直接开浏览器只会看到"无法访问"，不如说清原因。
 * 端口取自设置（不硬编码 8001）。
 */
async function openMaiBotWebui() {
  const port = Number(store.draft?.service?.ports?.webui) || 8001;
  const alive = await isPortOpen(port);
  if (!alive) toast(`MaiBot 好像还没启动（${port} 端口没在监听），请先启动它`, 'warn', 6000);
  const r = await openExternal(`http://127.0.0.1:${port}`);
  if (!r?.ok) toast(r?.message || '打开浏览器失败', 'warn');
}

const depOkCount = computed(() => deps.value.filter((d) => d.ok).length);
const missing = computed(() => deps.value.filter((d) => !d.ok));

/*
  每个服务的版本选择（'latest' 表示跟随最新正式版）。
  取值会原样交给 installMaiBot / installSnowluma 的 opts.version ——
  主进程按 tag 解析，渲染层不做任何版本名转换（转换过就会两边不一致）。
*/
const versions = reactive({ maibot: 'latest', snowluma: 'latest' });

/*
  可安装服务对应的仓库：SnowLuma 取自设置，与主进程 constants.js 的 REPOS 同源，
  渲染层不硬编码仓库名。
  优先读 draft（设置页可能刚改完还没保存，用户看到的就是这个值），
  没有 draft 时退回 settings —— 直接用 store.settings 的话，
  用户改完仓库名回来点安装，实际用的还是旧仓库，和界面上显示的对不上。
  写成 computed 而不是普通值：设置是异步加载的（loadSettings 之后才填充），
  取值的时刻必须是"用的时候"，否则会在 null 上取下标。
  （MaiBot 的仓库不在这里读设置：它是安装信息卡片里可直接编辑的输入框。）
*/
const snowlumaRepo = computed(
  () => store.draft?.github?.snowlumaRepo || store.settings?.github?.snowlumaRepo || 'SnowLuma/SnowLuma'
);

/** 安装按钮的提示语：把"装的是哪个版本"写进 title，避免按钮点下去才知道 */
function installTitle(label, tag) {
  return `安装 ${label} ${tag || 'latest'}`;
}

/** 目标目录下是否已有 MaiBot（决定「升级」是否可用） */
/*
  目标目录下是否已经有一份 MaiBot —— 判定要用 <targetDir>/maibot，
  因为那才是主进程真正写入的位置（原来拿 targetDir 本身去比对安装记录，
  而记录里存的是安装目录，两者永远不可能相等）。
*/
const targetIsMaibot = computed(() =>
  Boolean(
    store.installations.find(
      (i) => i.path === targetDir.value || i.path === targetDir.value + '\\maibot'
    )
  )
);

/* ---------------------------------------------------------------- 工具 */

/**
 * 确保 draft.service 存在再写入。
 * 原实现只判 store.draft，未判 .service，是真实的空指针崩溃点。
 */
function ensureDraftService() {
  if (!store.draft) store.draft = {};
  if (!store.draft.service) store.draft.service = {};
  return store.draft.service;
}

async function reveal(path) {
  const r = await openPath(path);
  if (!r.ok) toast(r.message || '无法打开', 'error');
}

/* ---------------------------------------------------------------- 目录与 Python */

async function pickTargetDir() {
  const r = await selectDirectory({ title: '选择安装目标目录' });
  if (r.ok) targetDir.value = r.path;
}

async function detectPython() {
  const r = await checkPythonVersion(python.value.trim() || 'python');
  pythonCheck.value = r;
  if (r.ok) toast(`检测到 Python ${r.version}`, 'success');
  else toast(r.message || '未检测到可用的 Python', 'warn', 4000);
}

/* ---------------------------------------------------------------- 检查 */

/*
  检查请求序号。
  此前 finally 里无条件把 checking 与 checkingFull **都**置 false ——
  进页面自动跑的快速检查尚未返回时点「完整检查」，先完成的一方
  会把另一方的 loading 清掉：按钮提前恢复可点（能再点一次），
  而慢的那次返回后又会用**过期结果**覆盖 deps 列表。
  用序号保证只有最后一次请求有权写状态与清 loading。
*/
let checkSeq = 0;

/**
 * 前置检查。
 *
 * 默认走**快速模式**（模块级探测，实测约 var(--dur-slow)）：
 *   进页面就自动跑一次，2.6 秒的 pip list 会让每次切页都有明显白屏。
 * 用户点「完整检查」时才走 full 模式，换取准确版本号。
 *
 * @param {{mode?:'quick'|'full'}} [opts]
 */
async function check(opts = {}) {
  const mode = opts.mode === 'full' ? 'full' : 'quick';
  const seq = ++checkSeq;
  if (mode === 'full') checkingFull.value = true;
  else checking.value = true;
  depsLog.value = '';
  depsFailed.value = false;
  try {
    const exe = python.value.trim() || 'python';

    /* Python 版本 + 依赖并行：两者互不依赖，串行只是白白多等一轮 */
    const [py, depsRes] = await Promise.all([
      checkPythonVersion(exe),
      checkDependencies({
        /*
          依赖检查读的是**安装目录**里的 requirements.txt / pyproject.toml，
          而 targetDir 是"父目录"（安装会在其中新建 maibot/）。
          父目录下通常没有 requirements.txt，主进程于是退回内置清单 ——
          界面上就显示成"13/13 依赖已满足"这种与真实安装无关的数字
          （真实安装是 36 个依赖，全在 <安装目录>\.venv 里）。
          所以这里优先指向 <targetDir>/maibot。
        */
        installDir: effectiveInstallDir(),
        pythonExe: exe,
        mode
      })
    ]);

    /* 已有更新的请求在跑：丢弃这次的结果，不要用过期的覆盖 */
    if (seq !== checkSeq) return;

    pythonCheck.value = py?.ok === false ? { message: py.message } : py || null;

    if (depsRes && depsRes.ok === false && !depsRes.dependencies?.length) {
      toast(depsRes.message || '依赖检查失败', 'error');
      deps.value = [];
      return;
    }

    deps.value = Array.isArray(depsRes?.dependencies) ? depsRes.dependencies : [];
    depSource.value = depsRes?.source || '';
    depMode.value = depsRes?.mode || mode;

    const missingCount = deps.value.filter((d) => !d.ok).length;
    if (!missingCount) {
      toast(mode === 'full' ? '依赖完整（含版本号）' : '依赖完整', 'success');
    } else {
      toast(`缺少 ${missingCount} 个依赖`, 'warn');
    }
  } catch (e) {
    if (seq === checkSeq) toast('检查失败：' + (e?.message || e), 'error');
  } finally {
    /* 只清自己那一个标志，且只在仍是最新请求时清 */
    if (seq === checkSeq) {
      checking.value = false;
      checkingFull.value = false;
    }
  }
}

async function installDeps() {
  if (!targetDir.value) {
    toast('请先设置目标目录', 'warn');
    return;
  }
  /* 依赖安装只读 requirements.txt，但仍要拦住系统目录/相对路径这类明显错误的目标 */
  if (!(await guardTargetDir())) return;
  /*
    防重入：此前唯一的守卫是"缺 targetDir"。
    按钮上的 :loading/:disabled 要等点击处理函数返回后才生效，
    双击即可让两次 pip 并发写同一个 site-packages
    （典型后果：安装损坏、WinError 32 文件被占用）。
    现在 busy 是安装器唯一的进行中标志，它同时挡住了
    "安装依赖"与"安装服务"并发（此前是两套互不知情的标志）。
  */
  if (anyBusy.value) return;
  busy.value = 'deps';
  depsFailed.value = false;
  depsLog.value = '正在启动 pip…';
  try {
    const r = await installDependencies({
      installDir: targetDir.value,
      pythonExe: python.value.trim() || 'python'
    });
    if (r?.ok) {
      depsLog.value = `完成（用时 ${Math.round((r.elapsedMs || 0) / 1000)}s）`;
      toast('依赖安装完成', 'success');
      await check();
    } else {
      depsFailed.value = true;
      depsLog.value = r?.message || '安装失败';
      toast(r?.message || '依赖安装失败', 'error', 5000);
    }
  } catch (e) {
    depsFailed.value = true;
    depsLog.value = String(e?.message || e);
    toast('依赖安装失败：' + (e?.message || e), 'error');
  } finally {
    busy.value = '';
  }
}

/* ---------------------------------------------------------------- 安装 */

/**
 * 安装成功后询问是否写入并保存设置。
 *
 * 两个曾经的缺陷：
 *  1) 无条件写 store.draft（全局单一草稿），再调 applySettings() 落盘整个 draft。
 *     用户在「设置」页改了端口 / API Key 尚未保存时来这里装一次东西并选择保存，
 *     那些**未经确认**的改动会被一并提交。
 *  2) r.message 未加可选链：applySettings() 返回 undefined 时抛 TypeError，
 *     而该函数内没有 try/catch，异常会冒到调用方的 catch，
 *     把"安装成功"误报成"安装失败"。
 *
 * 现在：先只改草稿中该字段，落盘失败时把草稿回滚，且不再无保护地读 r.message。
 */
async function persistDir(field, value) {
  const svc = ensureDraftService();
  const previous = svc[field];
  svc[field] = value;

  const yes = await confirmDialog({
    title: '保存设置',
    message: `是否将新目录写入设置并立即保存？`,
    detail: `${field} = ${value}`,
    buttons: ['稍后再说', '写入并保存'],
    defaultId: 1
  });
  if (!yes) {
    toast('已写入草稿，请在「设置」页保存', 'info', 4000);
    return;
  }

  let r;
  try {
    r = await applySettings();
  } catch (e) {
    r = { ok: false, message: e?.message || String(e) };
  }
  if (r && r.ok) {
    toast('设置已保存', 'success');
  } else {
    /* 回滚，避免界面显示新目录而实际设置仍是旧值（下次启动会"跳回"旧目录） */
    svc[field] = previous;
    toast(r?.message || '保存失败，已还原草稿', 'error', 5000);
  }
}

/*
  注意函数名里是 **MaiBot**（大写 B）。
  此函数原名 doInstallMaiBot，而模板里写的是 @click="doInstallMaiBot" ——
  两个不同的标识符。Vue 模板引用未定义的属性既不报错也不警告，
  点「安装」按钮只是**什么都不发生**（静默失效，最难排查的一类问题）。
  已统一为大写 B，并在 eslint 配置里加了能自动发现这类错配的规则。

  @param {string} [tag] 版本 tag；'latest' 或未传 = 跟随最新正式版。
                       MaiBot 的 Release **不带附件**（纯源码发布），
                       版本号只取自 tag，安装走 codeload 源码归档 ——
                       所以这里不需要（也不应该）做"有没有附件"的检查。
*/
async function doInstallMaiBot(tag) {
  if (!targetDir.value || anyBusy.value) return;

  /*
    先校验路径（系统目录直接拒），再做破坏性确认。
    「安装」是破坏性操作，必须先确认目标位置没有既有安装：
    主进程 installMaiBot 的 installRoot = <targetDir>/maibot，
    并且调用 swapDirectory(top, installRoot, { keepBackup: false }) ——
    该函数在 keepBackup:false 分支会 `fsp.rm(backup)`，
    也就是**永久删除**掉移走的旧目录（github.js:592-609）。
    此前这里没有任何确认，点一下就会把用户已有的 MaiBot
    （含配置与登录态）连同备份一起抹掉，无法回滚。
  */
  if (!(await guardInstallTarget('maibot'))) return;
  busy.value = 'maibot';
  lastResult.value = null;
  progress.maibot = { percent: 0, phase: 'start' };

  let r;
  try {
    r = await installMaiBot({
      targetDir: targetDir.value,
      /* 用户选定的 tag 原样透传；主进程按 tag 解析，不做二次拼装 */
      version: tag || 'latest',
      repo: repo.value.trim()
    });
  } catch (e) {
    r = { ok: false, message: e?.message || String(e) };
  }
  lastResult.value = r;

  if (!r?.ok) {
    toast(r?.message || 'MaiBot 安装失败', 'error', 6000);
    busy.value = '';
    return;
  }

  /*
    安装本身已成功 —— 从这里开始的都属于"后置步骤"。
    此前这些步骤和安装写在同一个 try 里：后置步骤一旦抛错就落到同一个 catch，
    弹出"安装失败"，而磁盘上其实已经装好了。用户于是重复安装，
    每次都走一遍破坏性替换。现在把两者分开，如实区分。
  */
  toast(`MaiBot 已安装到 ${r.path}`, 'success', 4500);
  const after = await runPostInstallSteps('MaiBot', async () => {
    await persistDir('maibotDir', r.path);
    await check();
    await refreshDiskAndBackups();
  });
  if (!after.ok) {
    toast(`MaiBot 已安装，但后续步骤未完成：${after.message}`, 'warn', 7000);
  }
  /* 成功了才清进度条；失败保留以便用户看到停在哪个阶段 */
  progress.maibot = null;
  busy.value = '';
}

/**
 * 安装前的统一闸门：路径校验 → 既有安装确认 → 磁盘空间。
 *
 * 抽出来是因为现在有两个安装入口（MaiBot / SnowLuma），
 * 三道检查各自都有一段"为什么必须存在"的理由（见各函数注释）。
 * 复制两遍必然出现某一路漏检 —— 而漏检的后果是**永久删除用户已有安装**，
 * 这类错误不允许靠"记得抄一遍"来避免。
 *
 * @param {'maibot'|'snowluma'} kind
 * @returns {Promise<boolean>} true = 可以继续安装
 */
async function guardInstallTarget(kind) {
  if (!(await guardTargetDir())) return false;
  if (!(await guardExistingInstall(kind))) return false;
  if (!(await guardDiskSpace())) return false;
  return true;
}

/**
 * 执行"安装成功之后"的收尾步骤。
 *
 * 这些步骤（写设置、重新检查、刷新备份）失败**不代表安装失败** ——
 * 目录已经落在磁盘上了。此前它们与安装共用一个 try/catch，
 * 任何一步抛错都会被报成"安装失败"，误导用户重复安装（重复走破坏性替换）。
 *
 * @returns {Promise<{ok:boolean, message:string}>}
 */
async function runPostInstallSteps(label, fn) {
  try {
    await fn();
    return { ok: true, message: '' };
  } catch (e) {
    const message = e?.message || String(e);
    depsLog.value = `[${label}] 后置步骤失败: ${message}`;
    return { ok: false, message };
  }
}

async function doUpgradeMaiBot() {
  if (!targetDir.value || anyBusy.value) return;
  if (!(await guardTargetDir())) return;
  if (!(await guardDiskSpace())) return;

  const yes = await confirmDialog({
    type: 'warning',
    title: '升级 MaiBot',
    message: '将下载最新版本并替换现有安装目录。',
    detail:
      '当前版本会被完整保留为备份目录（不会删除），配置与数据文件会尝试迁移。\n' +
      '升级期间请先停止 MaiBot 服务。',
    buttons: ['取消', '开始升级'],
    defaultId: 1
  });
  if (!yes) return;

  /* 升级前检查端口是否仍被占用（服务没停干净会导致替换失败） */
  const ports = await checkPorts([
    { key: 'maibot', port: Number(store.draft?.service?.ports?.maibot) || 8080 }
  ]);
  if (ports.some((p) => p.inUse)) {
    const go = await confirmDialog({
      type: 'warning',
      title: '端口仍被占用',
      message: '检测到 MaiBot 端口仍在使用中，可能服务尚未完全停止。',
      buttons: ['仍要继续', '先去停止服务'],
      defaultId: 1
    });
    if (!go) return;
  }

  busy.value = 'upgrade';
  lastResult.value = null;
  progress.maibot = { percent: 0, phase: 'start' };

  let r;
  try {
    r = await upgradeMaiBot({
      installDir: targetDir.value,
      version: 'latest',
      repo: repo.value.trim()
    });
  } catch (e) {
    r = { ok: false, message: e?.message || String(e) };
  }
  lastResult.value = r;

  if (!r?.ok) {
    toast(r?.message || '升级失败', 'error', 7000);
    busy.value = '';
    return;
  }
  toast(r.message || '升级完成', 'success', 6000);
  /* 后置步骤失败不等于升级失败（新版本已落盘），如实区分 */
  const after = await runPostInstallSteps('MaiBot', async () => {
    await check();
    await refreshDiskAndBackups();
  });
  if (!after.ok) toast(`MaiBot 已升级，但后续步骤未完成：${after.message}`, 'warn', 7000);
  progress.maibot = null;
  busy.value = '';
}

/**
 * 安装 SnowLuma（用户要求的那条"MaiBot / SnowLuma 二选一装"的路径）。
 *
 * 这条链路与 MaiBot 那一条的差异（都是主进程 installSnowluma 的既定行为，
 * 这里只是如实接线）：
 *   · 附件挑选会**排除 lite 包**（lite 不含 node.exe，要求用户自备 Node）
 *   · 上游每个 zip 都发布了 sha256 摘要，所以这里的进度会真的走到
 *     "SHA-256 校验通过"，而不是只比大小
 *
 * 目标目录必须显式给出：主进程在没有 targetDir 时会用它自己的工作目录，
 * 而安装器页的语义是"装到用户指定的目录"，两者混用会让用户
 * 在别的地方找不到刚装的东西，也会让 snowlumaDir 指向一个意外的位置。
 *
 * @param {string} [tag] 版本 tag；'latest' 或未传 = 主进程按最新正式版解析
 */
async function doInstallSnowLuma(tag) {
  if (!targetDir.value || anyBusy.value) return;
  /* 同样会以 keepBackup:false 替换 <targetDir>/snowluma，三道闸门一个都不能少 */
  if (!(await guardInstallTarget('snowluma'))) return;
  busy.value = 'snowluma';
  lastResult.value = null;
  progress.snowluma = { percent: 0, phase: 'start' };

  let r;
  try {
    r = await installSnowluma({
      targetDir: targetDir.value,
      version: tag || 'latest',
      repo: snowlumaRepo.value
    });
  } catch (e) {
    r = { ok: false, message: e?.message || String(e) };
  }
  lastResult.value = r;

  if (!r?.ok) {
    toast(r?.message || 'SnowLuma 安装失败', 'error', 6000);
    busy.value = '';
    return;
  }
  toast(`SnowLuma 已安装到 ${r.path}`, 'success', 4500);
  /* 后置步骤失败不等于安装失败（新版本已落盘），如实区分 */
  const after = await runPostInstallSteps('SnowLuma', async () => {
    await persistDir('snowlumaDir', r.path);
    await refreshDiskAndBackups();
  });
  if (!after.ok) toast(`SnowLuma 已安装，但后续步骤未完成：${after.message}`, 'warn', 7000);
  /* 成功了才清进度条；失败保留以便用户看到停在哪个阶段 */
  progress.snowluma = null;
  busy.value = '';
}

/* ---------------------------------------------------------------- 订阅 */

const offs = [];
let alive = true;

/*
  安装/下载可能持续几分钟。
  组件一旦卸载（用户切到别的页签），订阅被取消、进度就不再更新；
  回到本页时看到的是**切页那一刻的旧进度**，甚至什么都没有 ——
  用户会以为安装已经停了或从未开始。

  做法：只要本页挂载着且确实有下载在进行，就周期性向主进程查询一次
  当前进度（订阅通道在离线期间丢掉的帧，靠轮询补齐）。
  这是"补齐"而非"替代"：有订阅时几乎不产生额外开销，
  只在进度处于进行中才开定时器。
*/
const progressPollTimer = ref(null);

function progressActive() {
  const p = (d) => d && d.phase && d.phase !== 'done' && d.phase !== 'error';
  /* 每个有进度槽位的服务都要看：漏掉哪一个，那一行在切页期间就不会补进度 */
  return p(progress.maibot) || p(progress.snowluma);
}

function startProgressPoll() {
  if (progressPollTimer.value) return;
  progressPollTimer.value = window.setInterval(async () => {
    if (!alive) return;
    if (!progressActive()) return;
    /* refreshDiskAndBackups 不涉及进度，这里只需要备份列表随安装结果变化 */
    await refreshDiskAndBackups().catch(() => {});
  }, 4000);
}

function stopProgressPoll() {
  if (progressPollTimer.value) {
    window.clearInterval(progressPollTimer.value);
    progressPollTimer.value = null;
  }
}

onMounted(async () => {
  alive = true;
  if (!store.paths) await loadPaths();

  offs.push(
    subscribeDownload('maibot', (p) => {
      progress.maibot = p;
    })
  );
  /*
    SnowLuma 的进度必须单独订阅：主进程是按下载目标标签分别广播的
    （github.js 里的下载标签），订阅标签与安装目标必须严格对应 ——
    挂到别的标签上会一条都收不到，表现就是"装了但界面永远是 0%"。
  */
  offs.push(
    subscribeDownload('snowluma', (p) => {
      progress.snowluma = p;
    })
  );
  offs.push(
    subscribeDepsStatus((p) => {
      /* 新主进程推送的是结构化对象，旧实现当字符串用 */
      if (p && typeof p === 'object') {
        depsLog.value = p.message || '';
        if (p.stage === 'error') depsFailed.value = true;
      } else if (typeof p === 'string') {
        depsLog.value = p;
      }
    })
  );

  await check();
  await refreshDiskAndBackups();
  /*
    首跑部署流程的首次探测。
    放在这里而不是单独的 onMounted：它要用的 store.info（app:info）与
    设置草稿在上面的 loadPaths / check 之后才齐，早跑会读到空的默认位置。
  */
  await refreshDeploySnapshot();
  startProgressPoll();
});

/** 目录变了 → 磁盘、备份、（部署流程里的）"这个位置现在是什么"都要重算 */
watch(targetDir, async () => {
  refreshDiskAndBackups();
  await refreshDeploySnapshot();
});

onBeforeUnmount(() => {
  alive = false;
  stopProgressPoll();
  /* 部署流程的 EULA 防抖定时器：切页后不能再往已卸载的组件里写状态 */
  if (eulaTimer) {
    window.clearTimeout(eulaTimer);
    eulaTimer = null;
  }
  while (offs.length) {
    const off = offs.pop();
    try {
      off?.();
    } catch (_) {
      /* 忽略 */
    }
  }
});

/*
  设置页改了目录/解释器后同步过来。
  但**用户正在这个输入框里打字时不能同步** ——
  否则设置页任何一次 draft 变动都会把用户刚敲的内容覆盖掉
  （表现为"打字打到一半被改回去"）。
  做法：记录聚焦状态，聚焦期间跳过同步；失焦后自然恢复同步。
*/
const targetFocused = ref(false);
const pythonFocused = ref(false);

watch(
  () => store.draft?.service?.maibotDir,
  (v) => {
    if (targetFocused.value) return;
    /* 同上：设置里存的是安装目录，字段要的是父目录 */
    const parent = typeof v === 'string' ? parentOf(v) : '';
    if (parent && parent !== targetDir.value) targetDir.value = parent;
  }
);
watch(
  () => store.draft?.service?.pythonPath,
  (v) => {
    if (pythonFocused.value) return;
    if (typeof v === 'string' && v !== python.value) python.value = v;
  }
);
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

/*
  子标签栏（合并原「下载」页后新增）。
  align-self: flex-start 让它按内容宽度收缩 —— .panel 是 flex column，
  不加这行会被拉伸成整行宽，看起来像一个空面板。
*/
.sub-tabs {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem;
  border-radius: var(--radius-md);
  background: var(--bar-bg);
  border: 1px solid var(--line);
  align-self: flex-start;
}

.sub-tab {
  letter-spacing: var(--ls-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-soft);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-base) ease, color var(--dur-base) ease;
}

.sub-tab:hover {
  color: var(--ink);
}

.sub-tab.on {
  background: var(--theme-tint);
  color: var(--accent-ink);
}

.sub-ico {
  flex: none;
}

/* 已获取的版本数，切到下载前就能看到有没有数据 */
.sub-badge {
  letter-spacing: var(--ls-sm);
  padding: 0 0.375rem;
  border-radius: 999px;
  background: var(--overlay-tint);
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
}

/* ==========================================================================
   首跑部署流程
   --------------------------------------------------------------------------
   全部使用应用既有令牌（颜色/圆角/时长），不新增任何硬编码色值 ——
   src/renderer/styles/** 由别的责任区维护，这里只消费它。
   ========================================================================== */

.dep-flow {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.dep-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.dep-step {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--paper-solid);
  overflow: hidden;
}

/* 当前该做的那一步：主题色描边，一眼能看到"现在在这" */
.dep-step.cur {
  border-color: var(--theme-color);
}

.dep-step.done {
  opacity: 0.78;
}

/* 待处理（缺东西）：用错误色描边，不让它看起来和"下一步"一样 */
.dep-step.blocked {
  border-color: var(--err);
}

.dep-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.625rem;
  cursor: pointer;
  user-select: none;
}

.dep-mark {
  letter-spacing: var(--ls-sm);
  width: 19px;
  height: 19px;
  flex: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  background: var(--line);
  color: var(--ink-soft);
}

.dep-step.done .dep-mark {
  background: var(--ok-tint);
  color: var(--ok-ink-strong);
}

.dep-step.cur .dep-mark {
  background: var(--theme-tint);
  color: var(--theme-color);
}

.dep-step.blocked .dep-mark {
  background: var(--err-tint);
  color: var(--err-ink-strong);
}

.dep-step.done .dep-mark :deep(svg) {
  width: 11px;
  height: 11px;
}

.dep-title {
  letter-spacing: var(--ls-sm);
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-strong);
}

/* 每步一句话结论：真实状态的一句话摘要 */
.dep-sum {
  letter-spacing: var(--ls-sm);
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dep-tag {
  letter-spacing: var(--ls-2xs);
  flex: none;
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  background: var(--overlay-tint);
  color: var(--ink-soft);
  font-size: 10px;
  font-weight: 600;
}

.dep-step.done .dep-tag {
  background: var(--ok-tint);
  color: var(--ok-ink-strong);
}

.dep-step.cur .dep-tag {
  background: var(--theme-tint);
  color: var(--accent-ink);
}

.dep-step.blocked .dep-tag {
  background: var(--err-tint);
  color: var(--err-ink-strong);
}

.dep-chev {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--ink-faint);
}

.dep-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0 0.625rem 0.625rem 2.3125rem;
}

.dep-why {
  letter-spacing: var(--ls-sm);
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-soft);
}

.dep-facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.dep-facts li {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-faint);
}

.dep-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: none;
  align-self: center;
  background: var(--ink-faint);
}

.dep-facts li.ok .dep-dot {
  background: var(--ok-ink);
}

.dep-facts li.warn .dep-dot {
  background: var(--warn-ink);
}

.dep-facts li.err .dep-dot {
  background: var(--err-ink);
}

/* "下一步照做"：整块高亮，因为这是用户唯一需要读的那句话 */
.dep-next {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  margin: 0;
  padding: 0.5rem 0.625rem;
  border-radius: var(--radius-sm);
  background: var(--theme-tint);
  color: var(--ink-strong);
  font-size: 12px;
  line-height: 1.6;
}

.dep-next-ico {
  flex: none;
  margin-top: 0.125rem;
  color: var(--theme-color);
}

.dep-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: center;
}

.dep-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem;
  padding-top: 0.25rem;
  border-top: 1px solid var(--line);
}

.dep-note {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  line-height: 1.5;
  color: var(--ink-faint);
}

.hint {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 12px;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
}

.hint-ico {
  flex: none;
}

.hint.warn {
  background: var(--warn-tint);
  color: var(--warn);
}

.hint.ok {
  background: var(--ok-bg-strong);
  color: var(--ok-ink);
}

/* 硬性拒绝（如目标目录是系统关键目录）：比 warn 更强，用错误色 */
.hint.err {
  background: var(--err-bg);
  color: var(--err);
}

/* 依赖列表被截断时的说明行 + 展开入口 */
.dep-more {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  font-size: 12px;
  color: var(--ink-faint);
}

.pre-row {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  flex-wrap: wrap;
}

.pre-item {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 12px;
}

.pre-label {
  color: var(--ink-soft);
  font-weight: 600;
}

.pre-muted {
  letter-spacing: var(--ls-sm);
  color: var(--ink-faint);
  font-size: 12px;
}

.dep-count em {
  font-style: normal;
  font-weight: 600;
  color: var(--ok-ink);
}

.dep-count em.warn {
  color: var(--warn);
}

.dep-source {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-faint);
}

.chip {
  letter-spacing: var(--ls-sm);
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--warn-bg-strong);
  color: var(--warn);
}

.chip.ok {
  background: var(--ok-tint);
  color: var(--ok-ink-strong);
}

.missing {
  letter-spacing: var(--ls-sm);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--warn-tint);
  font-size: 12px;
  color: var(--warn);
}

.missing-head {
  line-height: 1.5;
}

.missing-names {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-weight: 600;
}

.dep-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  max-height: 108px;
  overflow-y: auto;
}

.dep-chip {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  background: var(--warn-tint);
  color: var(--warn-ink);
  font-family: Consolas, 'Cascadia Mono', monospace;
}

.dep-chip.ok {
  background: var(--ok-bg-strong);
  color: var(--ok-ink);
}

.pre-actions {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex-wrap: wrap;
}

.deps-log {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
  font-family: Consolas, 'Cascadia Mono', monospace;
  max-width: 58%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deps-log.err {
  color: var(--err-ink);
}

.install-row {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.install-cell {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--card-bg);
  border: 1px solid var(--line);
}

.install-ico {
  font-size: 18px;
  color: var(--theme-color);
  flex: none;
}

.install-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.install-txt strong {
  font-size: 13px;
  color: var(--ink-strong);
}

.install-txt span {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-soft);
}

/*
  每行自己的进度条。
  缩进同 .install-cell 的 padding，让它看起来"属于上面那一行" ——
  共用一条进度区时，用户分不清是哪个服务在下（三个服务同构，行内文案才是唯一线索）。
*/
.row-prog {
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--row-bg);
  border: 1px solid var(--line);
}

.result {
  letter-spacing: var(--ls-sm);
  display: flex;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--ok-bg);
  border: 1px solid var(--ok-line);
  font-size: 12px;
  color: var(--ok-ink);
}

.result.err {
  background: var(--err-bg);
  border-color: var(--err-line);
  color: var(--err-ink);
}

.result-ico {
  flex: none;
  margin-top: 0.125rem;
}

.result-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.result-path {
  letter-spacing: var(--ls-sm);
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 12px;
  word-break: break-all;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.mini-btn {
  position: relative;
  letter-spacing: var(--ls-2xs);
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font-size: 10px;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  cursor: pointer;
  opacity: 0.85;
}

/* 命中区：视觉尺寸刻意做得紧凑（「刷新」实测 38x21，短边差 3px），
   小于"能舒服点中"的 24px 下限。用不吃布局的伪元素向外扩（与 ToggleSwitch 同一手法），
   视觉尺寸与留白完全不变，只把可点区域补足。
   ⚠️ 这里必须 -3px 而不是 -2px：绝对定位伪元素的包含块是**内边距盒**，
   而本按钮有 1px 边框，写 -2px 时上边只多出 1px、下边被边框吃掉 0px，
   实测"下沿探点"仍落在父容器上 —— 命中区实际只有 22px。多给 1px 才是对称的 25px。 */
.mini-btn::after {
  content: '';
  position: absolute;
  inset: -3px 0;
}

.mini-btn:hover {
  opacity: 1;
}

.mini-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ------------------------------------------------------------- 磁盘 / 备份 */
.disk-bar {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.875rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-md);
  background: var(--overlay-tint);
  font-size: 12px;
  color: var(--ink-soft);
}

.disk-item {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.disk-item strong {
  color: var(--ink-strong);
  font-variant-numeric: tabular-nums;
}

/* 空间不足时把数字染红，比只写一句提示更容易被注意到 */
.disk-item strong.low {
  color: var(--err-ink-strong);
}

.disk-ico {
  letter-spacing: var(--ls-sm);
  font-size: 12px;
  color: var(--ink-faint);
}

.bar-spacer {
  flex: 1;
  min-width: 0;
}

.disk-warn {
  letter-spacing: var(--ls-sm);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-md);
  background: var(--warn-tint);
  border: 1px solid var(--warn-line-bright);
  font-size: 12px;
  color: var(--warn-ink-strong);
}

/* 当前依赖检查模式标记：让用户知道"没有版本号"是模式差异而不是功能缺失 */
.dep-mode {
  letter-spacing: var(--ls-2xs);
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--theme-tint);
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
}
</style>
