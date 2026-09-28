# MaiBot Launcher 开源协议合规审计报告

- **审计对象**：`MaiBot Launcher` v2.1.0（Electron + Vue3 桌面启动器）
- **审计日期**：2026-09-27
- **审计范围**：仓库工作区 + `release/win-unpacked/` + `release/MaiBot Launcher Setup 2.1.0.exe`
- **方法**：只读实测。所有结论均有 `文件:行` 或命令原始输出支撑；无证据者一律标注「不确定」。
- **免责**：本报告是工程角度的合规自查，**不构成法律意见**。

> ⚠️ 本报告**未**修改任何源码/`package.json`，**未** commit/push，**未**改动 GitHub 仓库或 Release。

---

## 一、结论摘要

**结论：存在 AGPL-3.0 的违规项。**

最严重的一条：**按 AGPL-3.0 第 5(d) 条分发的二进制，既没有给终端用户任何版权声明（本项目至今无任何带年份/权利人的版权行），也没有在界面上给出获取「对应源码」的途径，也没有无担保声明，许可全文虽随包但被关在 `app.asar` 内用户无法触达。**

次要但独立的一条：**产物中实际分发的 `release/win-unpacked` 与安装包，是从 2026-09-26 的旧源码打出来的**，其中「关于」页把「本项目源码」链接指向了 `https://www.gnu.org/licenses/agpl-3.0.html`。

| # | 项 | 结论 |
|---|---|---|
| 1 | 自身许可文本 vs `package.json` | ⚠️ 文本是 AGPL-3.0 的标准全文，**但不含项目自己的"or later"授权声明**，两者不能算"一致" |
| 2 | AGPL §5(d) Appropriate Legal Notices | ❌ **违规**（版权声明缺失 + 源码获取途径缺失 + 无担保声明未呈现） |
| 3 | AGPL §13 网络交互 | ✅ **不适用**（无任何对外监听的 HTTP/WS 服务；唯一 `net.createServer()` 是端口探测） |
| 4 | 随附三方组件许可 | ⚠️ 依赖侧**无 copyleft/专有**，Electron/Chromium 声明**齐全**；但 `THIRD_PARTY_NOTICES/` **覆盖不全**且有事实错误 |
| 5 | 上游归属与商标 | ✅ 文案准确、不冒充官方（个别小瑕疵） |
| 6 | 代码来源合规 | ✅ 无「照抄未标源」证据；参考实现（MaiBot OneKey）**已在注释中明示** |
| 7 | 发布物合规 | ⚠️ 公开仓库含 `LICENSE`（✅）；但产物陈旧、"关于"页谎报源码链接（见上） |

---

## 二、违规项列表（按严重度）

### V1【高】AGPL §5(d)：分发物上没有任何版权声明，也没有给用户获取「对应源码」的途径

**证据链**

1. 全仓库找不到任何带年份/权利人的版权行（`||`/`if` 是 PowerShell 里的"无匹配则打印提示"写法）：
   ```
   $ git grep -n -i -E "copyright|\(c\) *[0-9]{4}" -- src
   src: (no match)
   $ git grep -n -i -E "copyright|\(c\) *[0-9]{4}" -- NOTICE.md NOTICE-TO-USER.md README.md
   NOTICE/README: (no match)
   $ git grep -n "版权" -- src NOTICE.md NOTICE-TO-USER.md README.md
   src/renderer/views/AboutPanel.vue:61:  <b>视觉风格不受版权保护，具体素材才受保护</b> …   ← 唯一命中，且是"版权不保护风格"的论述
   ```
   唯一的"权利人"表述是无年份的占位串：
   - `package.json:6` → `"author": "MaiBot Launcher Contributors"`
   - 打进包里的 `app.asar!/package.json`（570 B，实测）同样只有这一行。

2. 界面上「关于」页没有版权声明、没有无担保声明：
   `src/renderer/views/AboutPanel.vue:145-153`
   ```html
   <div class="disclaimer">
     <p>本启动器为第三方非官方工具，与 MaiBot 官方、SnowLuma 官方<b>均无隶属关系</b>。…</p>
     <p>本项目以 GNU AGPL-3.0-or-later 发布（见仓库根目录 <code>LICENSE</code>）。</p>
   </div>
   ```
   只有"非官方 + 许可名"，**没有 Copyright、没有 NO WARRANTY**。

3. 界面上「获取源码」的途径是**坏的**——"本项目源码"指向 GPL 许可证网页：
   `src/renderer/views/AboutPanel.vue:188-195`
   ```js
   const links = [
     { name: '本项目源码（对应源码随发行包提供，见发行说明）',
       url: 'https://www.gnu.org/licenses/agpl-3.0.html' },     // ← 不是源码地址
     { name: 'MaiBot 主仓库（所管理的服务）', url: 'https://github.com/Mai-with-u/MaiBot' },
     { name: 'SnowLuma 协议端（所管理的服务）', url: 'https://github.com/SnowLuma/SnowLuma' },
   ];
   ```
   **实测实际发行产物同样如此**（从 `release/win-unpacked/resources/app.asar` 抽出的
   `dist/renderer/assets/AboutPanel-Dy5fUx1J.js`，见 V6）：
   ```
   $ node <asar 解析脚本>   # 见附录 A 命令
   https://www.gnu.org/licenses/agpl-3.0.html   ← "本项目源码"的真实落点
   https://github.com/Mai-with-u/MaiBot
   https://github.com/SnowLuma/SnowLuma
   ```
   而真实的对应源码仓库 `https://github.com/LittleSun-Sam/maibot-launcher` **只存在于
   更新检查的内部常量里**（`src/main/constants.js:64,69-70`），
   **全仓库 `NOTICE.md` / `README.md` / 安装包内任何界面文案都没有出现过这个地址**：
   ```
   $ git grep -n "LittleSun-Sam" -- src
   src/main/constants.js:64:   * 真实更新源：https://github.com/LittleSun-Sam/maibot-launcher
   src/main/constants.js:69:  owner: 'LittleSun-Sam',
   $ git grep -n "LittleSun-Sam" -- README.md NOTICE.md NOTICE-TO-USER.md THIRD_PARTY_NOTICES
   （无匹配）
   ```

4. 许可全文**确实**随包（这点没问题），但用户拿不到：
   `app.asar` 内 `/LICENSE|34020`、`/NOTICE.md|7098`、`/THIRD_PARTY_NOTICES/README.md|9141`。
   界面上没有任何"查看许可原文"的入口，只有一句路径文字
   （`AboutPanel.vue:72-73`、`:140`、`:151`）。
   而且即使做入口也不能用现有的"打开路径"：`src/main/services/index.js:397-410` 的
   `shell:open-path` 只允许白名单目录，`app.asar` 内部路径不可达。

**为什么这是违规**：AGPL §5(d) 要求分发对象（二进制/界面）给出
「appropriate legal notices」，§4 要求随副本提供许可并**保留**版权声明，
GPL 系列 §1/§5 均以"conspicuous and appropriate copyright notice"为前提。
当前状态：版权声明不存在 → 义务无从履行；源码途径是一个 GPL 网页而非源码地址 →
用户按界面指引**无法获得对应源码**（虽然仓库实际公开，但界面没告诉他在哪）。

**修法（最小改动、三处）**

1. `src/renderer/views/AboutPanel.vue:190`：把 URL 换成
   `https://github.com/LittleSun-Sam/maibot-launcher`，文案改为
   「对应源码（AGPL-3.0-or-later）」。
2. 同文件 `:145-153` 的 `disclaimer` 增加两行：
   `Copyright (C) 2026 MaiBot Launcher Contributors` 与
   「本程序不提供任何担保（NO WARRANTY），详见 LICENSE §15/§16」。
3. `package.json` 增加 `"copyright": "Copyright (C) 2026 MaiBot Launcher Contributors"`
   （electron-builder 会把它写进 exe 版本信息），并在 `build.files` 里
   **加入 `README.md`**，把 `NOTICE-TO-USER.md` 一并带上（见 V4）。

### V2【中】AGPL §5(d)："无担保声明"没有呈现给最终用户

- `LICENSE:227-229` 有标准无担保段（随包，✅）。
- `NOTICE-TO-USER.md:16-17` 也写了"不提供任何明示或默示担保"——**但该文件没进包**（V4）。
- 界面「关于」页、安装向导、安装包页面上**都没有**无担保声明（V1 证据 2）。
- NSIS 配置也没把许可/声明做成安装页：`release/builder-debug.yml:193-196` 只有
  `!ifmacrodef addLicenseFiles` / `!insertmacro addLicenseFiles` 的条件宏，
  该宏未定义 → 实际没有许可页；`package.json:66-74` 的 `nsis` 段无 `license` 字段。

**修法**：在 V1 第 2 步里和版权声明一起写进「关于」页；如希望安装时可见，
在 `package.json` 的 `nsis` 里加 `"license": "NOTICE-TO-USER.md"`（注意该文件须已在
`build.files` 内）。

### V3【中】`NOTICE-TO-USER.md` 未随包分发，而界面却指引用户去看它

**证据**

1. `package.json:19-29` 的 `build.files` 白名单：`dist/**`、`package.json`、`LICENSE`、
   `NOTICE.md`、`THIRD_PARTY_NOTICES/**/*`、`node_modules/node-pty/**/*`
   —— **没有 `NOTICE-TO-USER.md`**。
2. 构建器实测确认（`release/builder-debug.yml:9,28` 的 `firstOrDefaultFilePatterns`）
   只出现 `LICENSE` / `NOTICE.md` / `THIRD_PARTY_NOTICES/**/*`，**全文无 `NOTICE-TO-USER`**。
3. `app.asar` 根目录实测只有：`node_modules`、`LICENSE`(34020)、`NOTICE.md`(7098)、
   `THIRD_PARTY_NOTICES`、`dist`、`package.json` —— **无 `NOTICE-TO-USER.md`**。
4. 而界面明确叫用户去看它：`AboutPanel.vue:73`
   `…数据存放与联网行为的披露见 <code>NOTICE-TO-USER.md</code>（使用须知）。`

即：**文档里承诺分发的披露文件，产物里没有**（同时也造成说明书与实物不一致）。

**修法**：`package.json` 的 `build.files` 加 `"NOTICE-TO-USER.md"`，
重新打包；顺带把 `AboutPanel.vue:73` 的措辞改成"随包内 `NOTICE-TO-USER.md`"。

### V4【中】许可/声明文件对终端用户不可达（只有 asar 内部，没有界面入口、没有落地文件）

- 随包位置全部在 `app.asar` 内部：`/LICENSE`、`/NOTICE.md`、`/THIRD_PARTY_NOTICES/*`。
- `release/win-unpacked/`（免安装版）里**看不到**这些文件——实测该目录根只有
  `LICENSE.electron.txt`、`LICENSES.chromium.html`（Electron 自带），
  项目自己的 `LICENSE`/`NOTICE.md` 只在 asar 内。
- 界面无查看入口（V1 证据 4）。

**修法（任选其一，建议都做）**：
- 在「关于」页加"查看许可全文/第三方声明"按钮，读 asar 内文本渲染到页面上（不依赖 `shell:open-path`）；
- 或把 `LICENSE`、`NOTICE.md`、`NOTICE-TO-USER.md`、`THIRD_PARTY_NOTICES/` 用
  `extraResources` 落到 `resources/` 下，界面上给"打开所在文件夹"。

### V5【中】"关于"页的「第三方开源组件」卡未提及 Electron / Chromium——而它们恰恰是包体最大的三方件

**证据**

- 随包确实**有**它们的声明（这是好事，见"已合规"节）：
  `release/win-unpacked/LICENSE.electron.txt`(1096 B)、
  `release/win-unpacked/LICENSES.chromium.html`(15 271 935 B)。
- 但 `AboutPanel.vue:123-142` 的正文只讲 `vue`/`vue-router`/`@xterm/*`/`node-pty`，
  **一个字都没提 Electron / Chromium / V8**；
- `THIRD_PARTY_NOTICES/README.md`（第 5 节表格，:127-142）同样只列那 5 个 npm 包，
  没有 Electron/Chromium 行；
- 且该 README 有一句**事实错误**：`:142` 写"各包自带的 `LICENSE` 文件随其文件一同包含在
  `app.asar` 内"——实测 `app.asar` 内只有 `node-pty/LICENSE` 与
  `node-pty/deps/winpty/LICENSE` 两个许可文件；
  `vue`/`vue-router`/`@xterm/*` 是被 Vite 编译进 `dist/renderer` 的，
  保留下来的是 `@license MIT` 注释（`THIRD_PARTY_NOTICES/README.md:149-150` 的说法正确），
  两句话自相矛盾。

**修法**：`THIRD_PARTY_NOTICES/README.md` 第 5 节加 Electron/Chromium 两行
（来源 `node_modules/electron/dist/LICENSE` + `LICENSES.chromium.html`，已随包）；
`:142` 改成"仅以独立包形式分发的依赖（`node-pty`）携带许可原文；
Vue/xterm 的许可声明以构建产物中的 `@license` 注释形式保留"。

### V6【中】产物是从旧源码打出来的，发行包内容与当前仓库不一致

**证据**

```
$ (Get-Item 'release\win-unpacked\resources\app.asar').LastWriteTimeUtc
2026-09-26 07:47:27Z            # 距今 >1 天，早于多次功能/文档提交

$ app.asar!/package.json 里声明:  "qrcode-generator": "^2.0.4"
$ git grep -n "qrcode" -- .     # 当前仓库：无匹配
$ npm ls --omit=dev --json      # 当前依赖：@xterm/addon-fit, @xterm/xterm, node-pty, vue, vue-router（5 个）
```

并且 asar 内的渲染层产物文件名与当前构建**不同**（同一份源码不可能产出两种 hash）：

| 文件 | asar 内（发行版） | 当前 `dist/` |
|---|---|---|
| AboutPanel chunk | `AboutPanel-Dy5fUx1J.js` (6382 B) | `AboutPanel-C2PFw1US.js` (7076 B) |
| index chunk | `index-F5NGqY5N.js` (163197 B) | `index-BCRNBm_D.js` (176937 B) |

具体后果（合规相关）：

1. 发行版「关于」页**带旧版"灵感来源"文案**，其链接里出现
   `https://github.com/Yun-Hydrogen/blue-random`、`https://github.com/Yun-Hydrogen/riz-ui`
   （从 asar 抽出的 AboutPanel chunk 实测 URL 列表）——
   即**发行版保留了旧 NOTICE 的归属声明，而当前仓库已把这段整体删除**。
2. 发行版「关于」页**完全没有**"本项目源码"以外的源码途径（`LittleSun-Sam` 在 asar 内 `ABSENT`），
   与 V1 叠加。

**修法**：在改完 V1/V3/V4 的文案与 `build.files` 后**重新执行 `npm run dist`**，
把 `release/` 下三个产物（`win-unpacked/`、`Setup 2.1.0.exe`、`.blockmap`）一起更新；
发 Release 前用 `scripts/verify-packaged-assets.mjs` 之类的门禁核对
（注意：该脚本目前**没有任何 LICENSE/NOTICE 断言**，实测 `Select-String` 无匹配，
建议顺带补上）。

### V7【中】`resources/hero.png` 的授权状态未落实为可执行的合规动作

**证据**

- 该图**确实**被打进产物：`dist/renderer/assets/hero-BUl_scLP.png`(177 204 B)
  与 `resources/hero.png`(177 204 B) 同尺寸同源；`app.asar!/dist/renderer/assets/hero-BUl_scLP.png`
  在 asar 清单中（177 204 B）。
- 来源自述：`src/renderer/components/AppLayout.vue:521-522`
  `左下角大插画（v4 §1.2）= **用户自己的 mai.png**（1024×1040，橙色圆滚滚 + 绿芽）。已由我放进 resources/hero.png。`
  以及 `docs/UI-BRIEF-v4-imitate.md:28`
  `🔴 **必须用 resources/hero.png（用户自己桌面上的 mai.png，1024×1040，我已复制进仓库）**`。
- `NOTICE.md:10-12` 已声明：`resources/hero.png` 由使用者本人提供，**不属于本项目
  AGPL-3.0-or-later 的授权范围**；若要公开分发含该图的产物，请自行确认权利状态。
  但 `NOTICE.md` 只声明"你（打包者）自己确认"，**没有把它排除出构建**，
  也没有给出"不含该图的构建"开关。

风险：仓库是**公开**的（`src/main/constants.js:64-65` 记载 2026-09-27 建立公开仓库），
AGPL 的"对应源码"对前端静态资源同样有效，一张来源为"用户本机 mai.png"的角色插画一旦被
公开克隆/再分发，将把一个**权属不明的美术资源**带进 AGPL 授权链条。

**修法**：二选一——(a) 从仓库与产物中移除 `resources/hero.png`，改用
`scripts/gen-icons.mjs` 程序化生成的图形（图标已证明可字节级复现）；或
(b) 保留但在 `README.md` + `THIRD_PARTY_NOTICES/README.md` 明确标注
"该文件不在 AGPL 授权范围内，仓库仅为可复现构建而保留，未经授权不得再分发"，
并在 `build.files` 里提供一条排除它的路径。**注意：这是需权利人确认的事项，本报告不下法律结论。**

### V8【低】`resources/ansi-shim/sitecustomize.py` 没有许可头

- 文件：`resources/ansi-shim/sitecustomize.py`(3018 B)，随包落到
  `release/win-unpacked/resources/ansi-shim/sitecustomize.py`(3018 B)。
- 它是本项目自己的代码（内容是启动器写的 colorama 垫片），但文件头只有 docstring，
  **没有版权/许可行**，`THIRD_PARTY_NOTICES/README.md` 也未提及它。
- 单文件、非独立分发，风险低。

**修法**：文件头加 3 行（`SPDX-License-Identifier: AGPL-3.0-or-later` + 版权行 + 一句话来源）。

### V9【低】`THIRD_PARTY_NOTICES/` 覆盖不全，且含失效条目

**实测覆盖情况**

`THIRD_PARTY_NOTICES/` 现有 2 个文件：`README.md`(8671 B)、`合规审计报告.md`(16420 B)。

| 实际随包的三方件 | 是否在 NOTICES 中被说明 |
|---|---|
| `node-pty`（含 `prebuilds/**`、`deps/winpty/**`、`third_party/conpty/1.23.251008001/**`） | README 表格有 `node-pty` 一行；**子组件（winpty / Windows Terminal ConPTY 的 `OpenConsole.exe`、`conpty.dll`）未单列** |
| `vue` / `vue-router` / `@xterm/xterm` / `@xterm/addon-fit` | 有（README 第 5 节表格） |
| Electron / Chromium / V8 | 随包有声明文件，但 NOTICES 与"关于"页**均未列**（见 V5） |
| `resources/ansi-shim/sitecustomize.py` | 未提 |
| 构建期工具链（electron-builder/esbuild/vite/eslint…） | README 有说明"不随包分发"，✅ |
| 旧条目：`THIRD_PARTY_NOTICES/合规审计报告.md` 第 6/8 节大量引用
  Blue Random / RizUI 的结论 | 已被当前 `NOTICE.md` 删除对应章节，**该报告未同步**，现为**唯一仍在仓库里给出这些归属描述的文件**（`合规审计报告.md:138-139,164-169,226,267,311`） |

另外 README 第 6 节（`THIRD_PARTY_NOTICES/README.md:156-163`）是一张**只有表头的空表格**
（表头在 `:160-161`）：
```
| 项目 | 许可 | 使用情况 |
|---|---|---|
```
—— 属排版残缺，容易被读成"这里有内容但没写"。

**修法**：

1. README 第 5 节补 Electron/Chromium 行 + `node-pty` 子组件（winpty、ConPTY）行；
2. 删掉第 6 节空表或补内容；
3. `合规审计报告.md` 与当前 `NOTICE.md` 的"灵感来源已删除"这一变更**对齐**，否则会构成反向误导。

### V10【低】"权利人"表述无年份、无主体

`package.json:6` `"author": "MaiBot Launcher Contributors"`（无年份）；
仓库中唯一带年份的版权行是**第三方**的（`LICENSE:4` 是 FSF 的、`node-pty/LICENSE` 是上游的）。
GPL/AGPL 的 "appropriate legal notices" 实践中通常要求
`Copyright (C) <year> <name>`。→ 修法见 V1 第 3 步。

---

## 三、未发现问题的项（逐项给证据）

### ✅ 3.1 AGPL §13（网络交互）**不适用**

结论依据（代码级自查，穷举了服务端 API）：

| 检查 | 结果 |
|---|---|
| `net/http` 服务监听 | 全 `src/` 只有 **1 处** `net.createServer()`：`src/main/services/process.js:1029`，配合 `:1045 server.listen(port, host)` |
| 该处用途 | `process.js:1014-1056` 的 `isPortBusy(port)` —— **端口探测**：绑定成功后立刻 `server.close()` 并把结果当"空闲"，`done(false)`；不接收连接、不提供任何内容（注释 `:1017-1025` 解释为何要试 `0.0.0.0`/`::`/`127.0.0.1`） |
| HTTP 框架 | `git grep -E "express|fastify|koa|http2" -- src` → 无匹配 |
| 渲染层如何加载 | `src/main/windows.js:246`（dev）`mainWindow.loadURL(devUrl)`；`:251`（prod）`mainWindow.loadFile(resolveRendererIndex())` —— 生产态是 `file://`，不经网络 |
| 其它 `127.0.0.1:8001` 引用 | `src/main/services/maibot-connect.js:22,144`、`OnboardingWizard.vue:218,348`、`onboarding/steps.js:207-212` —— 全是**管理 MaiBot 自己的 WebUI**（上游服务的端口），不是本启动器提供的服务 |
| Vite dev server（5173） | 仅开发态；`src/renderer/index.html:29` 注明"开发模式需要连接 Vite dev server 的 HMR WebSocket" |

→ 启动器自身**不通过计算机网络向用户提供服务**，§13 的"提供源码获取方式"义务不被触发。
（**但**这不豁免 §4/§5 的分发义务——所以 V1 仍然成立。）

### ✅ 3.2 Electron / Chromium / Node 的声明**确实随包分发**

```
release\win-unpacked\LICENSE.electron.txt        1 096 B   （Copyright (c) Electron contributors / 2013-2020 GitHub Inc.，MIT）
release\win-unpacked\LICENSES.chromium.html 15 271 935 B   （Chromium 全量三方许可）
```
与 `node_modules/electron/dist/` 下的同名文件一致（均为 1096 / 15271935 B），
即 electron-builder 的标准行为没被破坏。→ 这一条**已合规**。

### ✅ 3.3 生产依赖无 copyleft / 无专有 / 无"许可未知"

```
$ npm ls --omit=dev --json           # 直接依赖 5 个，problems 为空
@xterm/addon-fit 0.10.0 / @xterm/xterm 5.5.0 / node-pty 1.1.0 / vue-router 4.6.4 / vue 3.5.43

$ node <prod closure 脚本>            # 生产闭包 28 个包（含 @vue/*、@babel/*、postcss 等）
--- prod packages WITHOUT license field ---  none
--- prod packages with unconventional license ---  none
--- full prod closure ---
@babel/helper-string-parser, @babel/helper-validator-identifier, @babel/parser, @babel/types,
@jridgewell/sourcemap-codec, @vue/compiler-core, @vue/compiler-dom, @vue/compiler-sfc,
@vue/compiler-ssr, @vue/devtools-api, @vue/reactivity, @vue/runtime-core, @vue/runtime-dom,
@vue/server-renderer, @vue/shared, @xterm/addon-fit, @xterm/xterm, csstype, entities,
estree-walker, magic-string, nanoid, node-pty, picocolors, postcss, source-map-js, vue, vue-router

$ node <lockfile license 白名单脚本>   # 全 lockfile 扫描
none                                  # 无 SSPL / BSL / CC-BY-NC / GPL-2.0-only / UNLICENSED 等
```
逐个 `node_modules/<pkg>/package.json` 复核：`vue`=MIT、`vue-router`=MIT、
`@xterm/xterm`=MIT、`@xterm/addon-fit`=MIT（The xterm.js authors）、`node-pty`=MIT
（Microsoft Corporation）。**AGPL-3.0 与 MIT 兼容，无混用疑问。**

### ✅ 3.4 图标素材来源干净

`build/*.ico|png` 由 `scripts/gen-icons.mjs` 在构建期程序化生成
（文件头注释 `scripts/gen-icons.mjs:1-30` 说明用纯 Node `zlib` + 自写 CRC32 手写 PNG/ICO
编码，无图像库、无外部素材输入；图形为自绘"麦穗"几何形状，明示"没有照搬任何官方 logo"）。
→ 无第三方素材权属问题。

### ✅ 3.5 无打包字体

```
$ Get-ChildItem -Recurse -File -Include *.ttf,*.otf,*.woff,*.woff2 | Where-Object { $_.FullName -notmatch "node_modules" }
（无匹配）
```
`AboutPanel.vue:58,64`、`NOTICE.md:8` 的"仅用系统内置字体、未打包字体"表述**与实测一致**。

### ✅ 3.6 上游归属与商标：文案准确、不冒充官方

- `NOTICE.md:14`：`本项目是**第三方非官方工具**，与 MaiBot 官方、SnowLuma 官方**无任何隶属、合作、赞助或授权关系**。`
- `NOTICE-TO-USER.md:8-11`：同上，并明确"不隶属、不代理、不赞助、不授权"。
- `AboutPanel.vue:147-149`、`OverviewPanel.vue:443,571`（"本启动器不是 MaiBot 的许可方"）一致。
- UI 里的"官方"一词全部是**指向上游**的中性用法（`constants.js:27-28,330-339`、
  `envcheck.js:72-81,226-240`），没有"官方合作/官方推荐"这类暗示关联的表述。
- 上游许可表述与仓库一致：MaiBot = GPLv3 + EULA V1.3（`NOTICE.md:22-28`、`README.md:297`），
  SnowLuma = 自定义许可 / GitHub `NOASSERTION`（`NOTICE.md:29-32`、`README.md:298`）。
- 唯一小瑕疵：`package.json:10` 的 `appId: "com.maibot.launcher"` 使用了 `maibot` 域名风格标识，
  与"无隶属关系"的声明略有张力（**低**，属命名习惯，可改为 `io.github.LittleSun-Sam.maibot-launcher`）。

### ✅ 3.7 代码来源：参考实现已被**明示标注**，未发现"照抄未标源"

对 `MaiBot OneKey` / `MaiBotOneKeyDesktop` 的引用全部是**注释形式的来源披露或排除声明**，
且都明确区分了"协议约定/交互思路"与"实现代码"：

| 位置 | 内容 | 性质 |
|---|---|---|
| `src/main/constants.js:143-145` | `参考实现（MaiBot OneKey）里这两个值分别是 SNOWLUMA_WEBUI_PORT=5099、SNOWLUMA_ONEBOT_PORT=7988 …我们照抄的是这个**协议约定**，不是它的代码。` | 端口约定，已标注来源 |
| `src/main/constants.js:337-339` | `…是**第三方打包的分支**，不是官方那份…所以下面这两个值保留为 1.0.6 / 官方目录名，别再抄 OneKey 的那组。` | 明确"不抄" |
| `src/renderer/stores/app-store.js:549-554` | `参考过 MaiBot OneKey（GPL-3.0-only）的做法…那个交互对用户不友好，这里**故意不照抄** —— 只借它"用 localStorage 记一次性标志"这个思路` | 思路借鉴，已标注且不复制代码 |
| `src/renderer/onboarding/eula-prompt.js:18` | `为什么不用环境变量绕过（OneKey 的做法）` | 排除声明 |
| `src/main/services/process.js:743,755` | `契约来源（对照参考实现 MaiBot OneKey 的 SnowLuma 分支核实过）` | 契约核实 |
| `src/renderer/views/AboutPanel.vue:182-187` | 特意解释为何不写"AGPLv3 参考项目"：`早先写成"AGPLv3 参考项目"会让人以为用了 AGPL 代码` | 主动澄清 |
| `src/main/services/scanner.js:29,71,456,491` | 只把 `MaiBotOneKey` 当作**要识别的目录名/端口特征** | 兼容性识别，非代码复用 |

源码中搜不到这些项目的特征实现（`app-store.js:553` 说明"只借思路"，
`SettingsPanel.vue:870` 明示"那是 Chakra UI + React，这里是 Vue 3 + 自研组件"）。
**限制**：本结论基于人工特征比对，**未**做二进制/代码相似度工具比对（见第五节）。

### ✅ 3.8 公开仓库已包含 `LICENSE`（AGPL 的源码可得性要求）

```
$ git ls-files | Select-String -Pattern "LICENSE|NOTICE"
LICENSE
NOTICE-TO-USER.md
NOTICE.md
THIRD_PARTY_NOTICES/README.md
THIRD_PARTY_NOTICES/合规审计报告.md
$ git log -1 --format="%H %ad %s" --date=iso
d768362… 2026-09-27 20:43:39 +0800 docs: 约定更新日志的写法…
$ git remote -v
origin  https://github.com/LittleSun-Sam/maibot-launcher.git (fetch/push)
```
`LICENSE`(34020 B) 已被 git 跟踪 → 源码侧许可随源码提供，✅。
**注意**：仓库是否 public 属于 GitHub 侧状态，本次**未联网核实**（见第五节 U1）。

### ✅ 3.9 未发现"把上游项目打包进来"的越界分发

`app.asar` 内 `node_modules` 只有 `node-pty` 一个目录（实测），
`THIRD_PARTY_NOTICES/README.md:35-41,57-61` 关于"不打包 SnowLuma"的说明与实测一致
（无 SnowLuma/MaiBot 文件）。→ 上游 GPLv3/EULA 的再分发义务未被触发。

---

## 四、AGPL 条款逐条判定表

| 条款 | 是否适用 | 判定 | 依据 |
|---|---|---|---|
| §4 随副本提供许可、保留版权声明 | 适用（分发 exe/asar） | ⚠️ 部分不合规 | 许可全文随包✅（`asar!/LICENSE`）；**版权声明不存在**❌（V1/V10） |
| §5(a) 修改声明 | 不适用（本项目为原始作品，非修改版） | ✅ | 无上游代码基础 |
| §5(c) 许可全文随分发 | 适用 | ✅ | `asar!/LICENSE` 34020 B = 标准 AGPL-3.0 全文（`LICENSE:1-235`） |
| §5(d) Appropriate Legal Notices | 适用 | ❌ **违规** | V1（版权/源码途径/无担保）、V2、V4 |
| §6 允许下游再许可 | — | ✅ | `LICENSE:194-198` 标准条款未被削弱 |
| §13 网络交互提供源码 | **不适用** | ✅ | 3.1：无对外服务 |
| §15/§16 担保与责任限制 | 适用（应在界面上被"notice"到） | ⚠️ | 文本在包内✅，界面未呈现❌（V2） |
| 许可名一致性（AGPL-3.0 vs -or-later） | 适用 | ⚠️ | `package.json:7` 声明 `-or-later`，但**项目自己的声明段（AGPL 附录推荐的那段）在任何文件中都不存在**（依赖 `LICENSE:225-229` 的**模板示例文本**并不能表达本项目"or later"的选择）→ 建议在 `README.md` 与「关于」页显式写"AGPL-3.0-or-later"并给出完整声明段 |

---

## 五、不确定项（含如何确认）

| # | 不确定项 | 现状与限制 | 如何确认 |
|---|---|---|---|
| U1 | `https://github.com/LittleSun-Sam/maibot-launcher` 是否真为 public 且当前可达 | 本地只有 `git remote`，本次**未联网**核实（任务禁止改动远端，且未做网络探测） | 浏览器打开该 URL，或 `git ls-remote https://github.com/LittleSun-Sam/maibot-launcher.git`（只读）；确认后 V1 的"源码途径缺失"仍成立（界面没指向它），但"实际不可得"这一加重情节可排除 |
| U2 | `release/MaiBot Launcher Setup 2.1.0.exe` 内部结构 | NSIS 载荷是 LZMA 压缩，原始字节扫描对 `LICENSE`/`app.asar`/`NOTICE.md` 等关键字**全部 0 命中**（无意义，非"不含"）；本机**没有 7z**（`Get-Command 7z/7za` 均无），因此**未**直接解包安装包核对 | 装 `7z`（或用 7-Zip GUI）后 `7z l` / `7z x` 安装包；或直接以 stdout 反查 electron-builder 的 nsis 脚本（`release/builder-debug.yml:36-242` 已含完整脚本）。**间接证据已足够**：安装包由同一 `win-unpacked` 打成，而 `win-unpacked/resources/app.asar` 实测含 `LICENSE`/`NOTICE.md`/`THIRD_PARTY_NOTICES`，且不含 `NOTICE-TO-USER.md` |
| U3 | 代码是否照抄其他实现 | 只做了人工特征匹配（`MaiBot OneKey` 引用均为注释披露）；**未**跑相似度工具 | 对 `src/` 与候选仓库跑 ScanCode/FOSSA 或文本相似度比对（如 `npx jscpd` + 手动比对）；需要候选仓库的本地副本，本次未下载 |
| U4 | `resources/hero.png` 的真实权属 | 自述为"使用者本人的 mai.png"（`AppLayout.vue:521-522`、`docs/UI-BRIEF-v4-imitate.md:28`）；**无法从仓库内确证**它是原创、AI 生成还是某游戏角色 | 向使用者确认图片来源；如涉及第三方角色，必须替换或取得授权（见 V7） |
| U5 | `THIRD_PARTY_NOTICES/合规审计报告.md` 的时效性 | 该报告日期为 2026-09-25，其"已修复"结论针对旧构建；而当前**发行产物是 09-26 的旧构建**，且报告仍保留已删除的 Blue Random/RizUI 章节 | 以本报告为准；建议把「合规审计报告.md」更新或明确标注"仅对 09-25 快照有效" |
| U6 | SnowLuma 自定义许可下，"代为发起下载"是否需额外声明 | 旧的 `合规审计报告.md:261-263` 自己就标了"**需复核**"，本次**未**联网核对其 LICENSE 原文 | 拉取 `https://github.com/SnowLuma/SnowLuma` 的 `LICENSE` 原文逐条阅读（**本报告不下法律结论**） |
| U7 | MaiBot EULA V1.3 是否要求启动器侧额外提示 | 界面已有"不代为同意"的提示（`OverviewPanel.vue:435-443`、`onboarding/eula-prompt.js`）；EULA 原文未逐条核对 | 联网核对 `Mai-with-u/MaiBot` 的 `EULA.md` 第 1.2 条及后续版本 |
| U8 | 生产闭包中未随包分发的包（`@vue/*` 等）是否也需保留声明 | 它们被 Vite/esbuild 编译进 `dist`，成品里只保留了 6 处 `@license MIT` 注释（实测 `dist/renderer/assets/index-BCRNBm_D.js`）；是否**足以**满足 MIT 的"substantial portions"要求，属法律解释问题 | 由法务/权利方判断；工程侧最稳做法：把完整三方许可文本一并随包（`THIRD_PARTY_NOTICES/` 里新增构建产物级许可汇总） |

---

## 附录 A：本次审计的可复现命令

```powershell
# 0) 定位与前置
Set-Location "C:\Users\LittleSun-Sam\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a780289bcec713577f44b23\maibot-tauri"
$env:NODE_OPTIONS=""

# 1) 直接依赖 + 生产闭包
npm ls --omit=dev --json | Out-File -Encoding utf8 docs\_scratch_npm_ls.json

# 2) 许可全文与版本条款（AGPL-3.0 标准文本、无项目自己的声明段）
Get-Content LICENSE -TotalCount 20
Select-String -Path LICENSE -Pattern "either version|any later version"

# 3) 打包白名单（NOTICE-TO-USER.md 不在其中）
Select-String -Path release\builder-debug.yml -Pattern "NOTICE|LICENSE"

# 4) app.asar 内容清点（只读，自己解析 asar 头；不需要 npx asar）
node docs\_audit\audit.cjs list     # 顶层条目 / 许可类条目 / node_modules

# 5) asar 内的关键文本（验证 V1/V6/V7）
node docs\_audit\audit.cjs pkg      # 包内 package.json（含 qrcode-generator 与无版权的 author）
node docs\_audit\audit.cjs notice   # 包内 NOTICE.md（旧版，含 Blue Random / RizUI 章节）
node docs\_audit\audit.cjs links    # AboutPanel chunk 的 URL 与版权/源码关键字
node docs\_audit\audit.cjs dist     # dist 里的 @license 注释
node docs\_audit\audit.cjs deps     # 生产依赖闭包的许可扫描

# 6) Electron/Chromium 声明是否随包
Get-ChildItem release\win-unpacked -Filter "LICENSE*"

# 7) §13 判定：服务端 API 穷举
git grep -n -E "createServer|listen\(|express|fastify|koa" -- src

# 8) 代码来源
git grep -n -i -E "onekey|参考实现|借鉴|照抄" -- src

# 9) 字体 / 素材
Get-ChildItem -Recurse -File -Include *.ttf,*.otf,*.woff,*.woff2 | Where-Object { $_.FullName -notmatch "node_modules" }

# 10) 版权声明是否存在（V1 的核心证据）
git grep -n -i -E "copyright|\(c\) *[0-9]{4}" -- src            # 无输出
git grep -n -i -E "copyright|\(c\) *[0-9]{4}" -- NOTICE.md NOTICE-TO-USER.md README.md   # 无输出
```

> 本审计使用的**只读**分析脚本保留在 `docs/_audit/audit.cjs`
> （纯 Node、无依赖、路径自解析，可从任意 cwd 运行；只打印，不修改任何被审对象）。
> 如不需要，可直接删除 `docs/_audit/` 整个目录。

## 附录 B：修复清单（按优先级）

| 优先级 | 动作 | 落点 |
|---|---|---|
| P0 | 「本项目源码」链接改为 `https://github.com/LittleSun-Sam/maibot-launcher` | `src/renderer/views/AboutPanel.vue:190` |
| P0 | 「关于」页加版权行 + 无担保声明 | `src/renderer/views/AboutPanel.vue:145-153` |
| P0 | `package.json` 加 `copyright` 字段 | `package.json`（顶层） |
| P1 | `build.files` 加入 `NOTICE-TO-USER.md`（并考虑加 `README.md`） | `package.json:19-29` |
| P1 | 重新 `npm run dist`，刷新三个产物 | `release/` |
| P1 | 界面提供"查看 LICENSE / NOTICE"入口（或 extraResources 落地） | `AboutPanel.vue` + `package.json:33-54` |
| P2 | NOTICES 补 Electron/Chromium/node-pty 子组件；修正 `README.md:142` 的事实错误；删空表 | `THIRD_PARTY_NOTICES/README.md` |
| P2 | 处置 `resources/hero.png` 权属 | `resources/`、`NOTICE.md`、`build.files` |
| P3 | `ansi-shim/sitecustomize.py` 加 SPDX 头 | `resources/ansi-shim/sitecustomize.py` |
| P3 | `appId` 去 `maibot` 域名风格 | `package.json:10` |
| P3 | `scripts/verify-packaged-assets.mjs` 增加 LICENSE/NOTICE 断言 | `scripts/verify-packaged-assets.mjs` |

---

*本报告所有数据均来自本仓库内的实际命令输出，可复现。*
