# MaiBot Launcher

基于 **Electron** 的 MaiBot / SnowLuma 桌面管理器：进程托管、安装与升级、日志聚合、AI 辅助工具。

> **实现说明**：本项目是纯 Electron 应用（主进程 + preload + Vue 渲染层）。
> 仓库目录名中的 `tauri` 是历史遗留，与实现无关，代码中不含任何 Tauri 依赖。

---

## 快速开始

> 📖 **第一次用？先看 [新手配置教程](新手配置教程.md)** ——
> 从零到「在群里 @ 麦麦它能回话」的完整步骤，含一份按现象查的排错手册。
> 软件内首次启动也会滑出同一套流程的交互式引导（会读你机器的真实状态）。

```bash
npm install          # 安装依赖（首次会下载 Electron）
npm run dev          # 开发模式：Vite dev server + 主进程监听重建 + 自动启动 Electron
npm run app          # 构建并以独立窗口启动（改完想直接看效果就用这个）
npm run build        # 生产构建（渲染层 + 主进程/preload）
npm run smoke        # 冒烟测试：先构建，再真实启动一次并校验启动里程碑
npm run selfcheck    # 逐页自检：7 个页面各真实渲染一次
npm run verify       # 全量门禁：lint + build + 15 个测试脚本（13 个 verify-* + selfcheck + smoke）
npm run dist         # 打包成 Windows 安装包（electron-builder → release/）
```

### 想直接看效果？

```bash
npm run app          # 构建 + 启动，窗口独立存活，脚本立刻返回
npm run app -- --no-build   # 跳过构建，启动现有产物
npm run app:fresh           # 用临时数据目录启动，不影响你的真实配置
```

`run.mjs` 会先检测是否已有实例在运行（单实例锁会让新进程直接退出、
只聚焦旧窗口 —— 不明说容易误判成"启动失败"），启动后轮询确认
**窗口真的出现了**再返回，并打印日志路径与末尾几行。
窗口是 detached 启动的，脚本退出后继续存在。

### 界面小技巧

- **双击顶部「日志」标签**：标签下方会弹出一个胶囊，用来筛选日志来源
  「全部 / MaiBot / SnowLuma」。选某个服务就整屏只看它的日志，
  标签上会显示当前筛选的来源（再双击一次、点空白处、按 `Esc`
  或切到别的页面都会收起）。这是个没有按钮的手势，所以状态一定显示在标签上。
- 日志页是**铺满式**的，而且整页只有**一个**日志区：MaiBot 与 SnowLuma 的输出
  按时间合并成一条流，每行前面挂一个来源标签表明"这行是谁输出的"；
  从菜单栏底下一直铺到窗口底部，只有这一处滚动条。
- **行首不会有 `OUT` / `ERR` 之类的标记**（用户要求：就是正常的 cmd 样式）。
  只在「全部」视图里标**来源**（MaiBot / SnowLuma）—— 两路日志并成一条流时
  不标来源就分不清是谁说的。点开单个来源后连来源标签也不重复，
  行首只剩时间 + 服务自己输出的那行文字，跟直接在 cmd 里跑一样。
  stdout / stderr 的区分没有丢：行文字按级别上色，顶部还有「错误 / 警告」计数。
- **日志是带颜色的。** 服务输出里的 ANSI 转义（256 色 / 真彩色 / 加粗 / 下划线）
  会被真正渲染成颜色，而不是把 `\x1b[38;5;117m` 这种控制码原样喷在页面上；
  复制/导出的文本会先把控制码去掉。为此主进程给子进程补了三样东西
  （见 `process.js` 的 `applyColorEnv`）：`FORCE_COLOR=1`（Node 系服务认这个）、
  `TERM=xterm-256color`，以及把 `resources/ansi-shim` 加进 `PYTHONPATH` ——
  最后这个是给 **colorama** 的垫片：colorama 发现 stdout 不是终端就把颜色删掉，
  且不认任何环境变量，而麦麦 `bot.py` 的彩虹彩蛋正是用它打的，
  于是经启动器的管道出来就成了一行白字。垫片只做一件事：
  告诉 colorama"接收端支持 ANSI"（这是真的，日志页现在会渲染颜色），
  它不改麦麦任何文件，你自己在 cmd 里跑麦麦时也不会被加载。
- 日志页只显示两个**被托管的服务**。启动器自己的运行日志不占这块屏幕，
  但它照旧写入 `userData/logs/launcher.log` —— 右上角「日志目录」按钮能直接定位。

---

## 架构

```
src/
├── main/                     主进程（Node 环境，拥有全部系统权限）
│   ├── main.js               入口：userData 重定向 → 单实例锁 → 启动编排 → 优雅退出
│   ├── constants.js          全局常量：仓库、默认设置、默认端口、扫描限制
│   ├── paths.js              路径唯一来源（userData / 日志 / 数据 / 导出目录）
│   ├── logging.js            应用日志：串行写盘 + 2MB 轮转 + 内存环形缓冲
│   ├── windows.js            主窗口创建、导航守卫、预加载路径解析
│   ├── tray.js               系统托盘
│   └── services/             各业务域（每个文件一个域）
│       ├── index.js          模块注册表 + 全部 IPC 通道注册
│       ├── process.js        子进程生命周期（启动/停止/看门狗/退避重启）
│       ├── winproc.js        Windows 进程树操作（taskkill /T /F 并等待真正退出）
│       ├── terminal.js       交互式终端（node-pty，失败时降级为管道）
│       ├── scanner.js        本地安装扫描（异步 + 可取消 + 深度/数量上限）
│       ├── envcheck.js       环境探测（目录归属判定、MaiBot 版本、适配器插件、工具链）
│       ├── maibot-connect.js MaiBot 侧状态与配置对齐（WebUI Token / 适配器 / bot_config.toml）
│       ├── exit-codes.js     进程退出码翻译（NTSTATUS → 可读原因；区分"预期结束"与"真崩溃"）
│       ├── github.js         Release 查询、流式下载、原子安装/升级/回滚
│       ├── data.js           数据目录统计与按保留天数清理
│       ├── settings.js       设置读写（原子写入 + 防抖 + 校验 + 损坏自愈）
│       ├── system.js         CPU / 内存 / 磁盘占用
│       ├── prereq.js         Python 版本与依赖检查、pip 安装
│       ├── llm.js            LLM 流式对话（SSE，按 requestId 隔离，可中止）
│       ├── log.js            子进程日志聚合、批量推送、导出为真实文件
│       ├── loginitem.js      开机自启：真实读写 Windows 登录项（注册表复核）
│       ├── notify.js         Windows 系统通知（服务异常/放弃重启时提醒）
│       └── dialog.js         原生文件/目录选择、确认框
├── preload/preload.js        唯一桥接层：contextBridge 暴露 maibotApi / maibotEvents / launcher
└── renderer/                 Vue 3 渲染层（无 Node 权限）
    ├── main.js               全局错误捕获（上报主进程落盘）+ 挂载
    ├── index.html            CSP 策略
    ├── router/               路由与页签元信息
    ├── stores/app-store.js   全部状态与 IPC 调用封装（无 Pinia）
    ├── views/                各功能面板
    └── components/           UI 组件
```

### 安全模型

| 项 | 取值 | 说明 |
|---|---|---|
| `contextIsolation` | 开启 | 渲染层无法直接触达 Node |
| `nodeIntegration` | 关闭 | 渲染层无 `require` |
| `sandbox` | 开启 | 渲染进程受 Chromium 沙箱约束（preload 仅用 `require('electron')`，沙箱内可用） |
| CSP | `script-src 'self'` | 禁止内联脚本与 `eval` |
| 外部链接 | `shell.openExternal` | 仅放行 `http`/`https` |
| 导航 | `will-navigate` 拦截 | 阻止窗口被导航到外部页面 |

渲染层与主进程之间**只有** `preload.js` 中显式列出的方法，无任意 `invoke(channel)` 通道。

> 上述取值已通过 `npm run smoke` 实测验证（沙箱开启后 preload 仍能建立桥接、界面正常挂载）。

---

## 关键设计决策

**主进程 / preload 用 esbuild 构建，渲染层用 Vite。**
两者职责分离：`scripts/build-main.mjs` 只做打包（`electron`、Node 内置模块、`node-pty` 保持外部依赖），
避免了历史上“依赖一个从未声明的 Vite 插件导致 `npm run build` 永久失败”的问题。

**node-pty 使用 N-API 预编译产物，无需 electron-rebuild。**
`node-pty@1.1.0` 自带 `prebuilds/win32-x64/*.node`，与 Electron 的 Node ABI 解耦。
终端不可用时自动降级为管道模式，并在界面明确标注后端类型，不会假装成完整终端。

**停止子进程必须等待真正退出。**
Windows 上 `SIGINT`/`SIGTERM` 对 `shell: false` 启动的 `python.exe` 无效。
统一走 `taskkill /PID <pid> /T /F` 并轮询确认进程消失，否则会出现“界面显示已停止、后台仍在跑”。

**所有写盘操作都是原子的。**
设置与升级采用「临时文件 + `rename`」替换；升级时保留备份目录，失败可回滚。
备份**不会被自动删除**（用户需要能回退），但可以在「安装」页看到累计占用并一键清理；
清理走主进程的路径白名单校验：只允许删除与安装目录同级、且名字匹配
`<名称>.backup-<ISO时间戳>` / `<名称>.old-<ISO时间戳>` 的目录，
即使前端被篡改也无法删到无关路径。

**"开机自启"以注册表为准，而不是以 Electron 的回读为准。**
实测（打包版 / Electron 37.10.3 / Windows 10 19045）在
`setLoginItemSettings({ openAtLogin: true })` 之后**立即**调用
`getLoginItemSettings()`，`openAtLogin` 仍返回 `false` —— 尽管注册表项已经写入成功。
若据此判断结果，就会出现"功能生效了却给用户报错"的假阴性。
因此 `loginitem.js` 在写入后直接查询
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 来复核真实状态。

**日志只有一个来源。**
应用日志固定为 `userData/logs/launcher.log`，路径由 `src/main/paths.js` 单点定义；
渲染层的未捕获异常（`onerror` / `unhandledrejection` / Vue `errorHandler`）
经 `log:report` 真实写入同一文件，排查问题时主进程与渲染层日志同源。
该文件不进「日志」页（那一页只显示被托管服务 MaiBot / SnowLuma 的输出），
由右上角「日志目录」按钮一键定位 —— 排查启动器自身问题时看它。

---

## 系统集成

| 能力 | 实现要点 |
|---|---|
| 启动后自动拉起服务 | `general.autoStart`，主窗口就绪后由主进程按**已保存设置**推导启动参数（含入口文件探测），找不到入口则跳过并记录原因 |
| 开机登录自启 | `general.launchOnLogin`，真实写入 Windows 登录项；启动时做一次幂等对齐，修正"系统里关了但设置里还开着"的漂移 |
| 系统通知 | 服务异常退出 / 放弃自动重启 / 手动重启失败时发出 Windows Toast，窗口隐藏时也能看到；可用 `general.desktopNotify` 关闭 |
| 手动重启服务 | 主进程侧**一次原子操作**（停干净再启动），并把这次停止标记为主动停止，避免看门狗误判为异常退出后重复拉起、两个进程争抢同一端口 |
| 服务标准输入 | 向托管进程 stdin 写入内容（MaiBot 首次启动的「同意」确认、`y/n` 确认等交互场景） |
| 自定义扫描范围 | `general.scanRoots`；留空用系统默认根，裸盘符根（`C:\`）会被拒绝 |
| 依赖检查双模式 | 快速（模块级探测，实测约 340 ms，进页面默认）/ 完整（`pip list`，约 2.4 s，可读取准确版本号） |

> 依赖清单同时记录 **pip 包名与 import 名**（`Pillow`→`PIL`、`pyyaml`→`yaml`）。
> 快速模式按 import 名做模块探测，两者写错会导致"明明装了却报缺失"。

---

## 版本线：这里有**两条**，别混

平台上流传的"必须 1.2.0"和代码里的"1.0.0"说的不是同一件事，混起来容易得出
"文档和实现不一致"的错误结论：

| 线 | 门槛 | 谁的要求 | 代码位置 |
|---|---|---|---|
| **启动器准入线** | MaiBot **≥ 1.0.0** | 启动器只拒绝确定低于主版本 1 的旧版本（0.x）；1.0 / 1.1 能被启动 | `src/main/services/scanner.js:273`（`MIN_MAIBOT_MAJOR = 1`）、`:291`（`classifyVersion`）、`isBelowMinVersion` |
| **SnowLuma 适配器线** | MaiBot **≥ 1.2.0** | 官方 SnowLuma 适配器插件的要求。1.0.x / 1.1.x 上插件装不上或启用失败 | `src/main/services/envcheck.js:379-381`（0.6.x 判定文案）、`:391` |

也就是说：**装 1.0.x / 1.1.x 启动器不会拦你，但接不上 SnowLuma** —— 所以实操上
仍然应该直接用 1.2.0+（见 `新手配置教程.md` §1）。两条线的判定与文案都各有断言
守着（`scripts/verify-scan.mjs` 的 A2 段与 `classifyVersion` 用例、
`scripts/verify-onboarding.mjs:67`），改之前先看那几处注释里记录的用户要求。

---

## 环境变量

| 变量 | 作用 | 读取位置 |
|---|---|---|
| `MAIBOT_LAUNCHER_USER_DATA` | 重定向数据目录（便携版 / 自动化测试用）。必须在启动前设置 | `src/main/main.js:49` |
| `VITE_DEV_SERVER_URL` | 由 `npm run dev` 注入，主进程据此加载 dev server 而非本地文件 | `src/main/windows.js:148,171` |
| `MAIBOT_LAUNCHER_SELFCHECK` | 逐页自检：页面按固定顺序自动切换并在完成后报告 | `src/preload/preload.js:32`、`src/main/windows.js:225` |
| `MAIBOT_LAUNCHER_SELFCHECK_EXIT` | 自检结束后自动退出进程（供 CI 收尾） | `src/main/windows.js:482` |
| `MAIBOT_LAUNCHER_IPC_PROBE` | IPC 契约探针：渲染层把每个桥接方法的可用性回报主进程 | `src/main/main.js:195`、`src/preload/preload.js:297` |
| `MAIBOT_LAUNCHER_GITHUB_PROBE` | Release 解析探针（不真正下载） | `src/main/main.js:181` |
| `MAIBOT_LAUNCHER_GITHUB_API` | 把 GitHub API 指向本地假服务，供离线测试用 | `src/main/services/github.js:58` |

---

## 配置文件

设置保存在 `<userData>/backend-settings.json`，写入前会做类型校验与范围钳制；
文件损坏时自动备份为 `.corrupt-<时间戳>` 并回退默认值，不会因一个坏文件而无法启动。

默认端口（均已在各上游的源码中核实）：

| 用途 | 默认端口 | 出处 |
|---|---|---|
| MaiBot 主服务 | `8080` | MaiBot `src/config/startup_bindings.py` |
| MaiBot WebUI | `8001` | MaiBot `src/config/startup_bindings.py` |
| SnowLuma WebUI（首次登录、同意协议、建 OneBot 服务器） | `5099` | SnowLuma 启动日志与 `config/runtime.json` 的 `webuiPort` |
| SnowLuma OneBot 正向 WebSocket 服务器 | `7988` | SnowLuma 适配器要去连的那个端口 |

> **协议端现在只有 SnowLuma 一种**（独立的 Node 程序，不注入 QQ 进程、
> 也不需要用户装 QQ 客户端）。
>
> ⚠️ 关于 SnowLuma 的 OneBot 端口要理解它的**性质**：它不是 SnowLuma
> 配置文件里可以被写入的项 —— 实测它启动后**只监听 WebUI 的 5099**，
> 生成的 `config/runtime.json` 里**没有 OneBot 段**。
> OneBot 正向 WS 服务器是用户**在 SnowLuma 自己的 WebUI 里新建**的，
> `7988` 是那个服务器应当使用的端口（也是启动器做接线自检时去连的端口）。
>
> 如果哪个旧教程让你填 `3001` / `6099` / `6199` / `8090`，那些都是**旧的
> QQ 注入式协议端**或 AstrBot 的端口，跟 SnowLuma 无关，填了连不上。

---

## 自检

```bash
npm run smoke        # 启动冒烟：主进程能否起来、渲染层是否挂载
npm run selfcheck    # 逐页自检：7 个页面各真实渲染一次
```

### `smoke` — 能启动吗

真实启动一次应用（隔离的临时数据目录），校验：
日志系统就绪、服务层 IPC 注册、主窗口与托盘创建、**渲染层成功挂载**。
任何渲染层未捕获异常都会让测试失败 —— 因为"能启动"不等于"能用"。

### `selfcheck` — 每个页面都能用吗

`smoke` 只覆盖默认页（`/overview`）。所有路由都是懒加载的
（`() => import(...)`），其余页面要真正进去一次才知道会不会炸：
模板里读一个 `undefined` 字段、组件里漏 import 一个符号，
构建阶段都不会报错，而 Vue 的模板错误基本只在运行时暴露。

`selfcheck` 以 `MAIBOT_LAUNCHER_SELFCHECK=1` 启动，主进程逐个导航
到 7 个路由、抓取渲染层异常与页面实际内容，任一页异常即判定失败：

```
[selfcheck] ── 页面渲染结果 ──────────────────────
  ✓ overview   正常 节点长度=15397 内容="总览 安装器 日志 …"
  ✓ settings   正常 节点长度=22339 内容="… 重新载入 LLM 引擎 …"
  …
[selfcheck] ✓ 全部页面渲染正常
```

> 路由数从 8 变 7 是因为**下载页已并入安装器页**：`/download` 现在只是一条
> 指向 `/installer?tab=download` 的重定向，没有 `meta.title`，因此不在标签栏、
> 也不在自检路由表里（见 `src/main/windows.js` 的 `SELFCHECK_ROUTES`）。
> 自检会核对"页面条数 == verdict 条数"，把重定向项留在表里会让它误判失败。

用 `--user-data <目录>` 可以拿一份**预置的配置文件**启动，
用来覆盖"有数据"的渲染分支（空目录只能测到空态，而 bug 常藏在有数据的那一支）：

```bash
node scripts/selfcheck.mjs --user-data C:\tmp\preset-config --keep
```

---

## 许可证与合规

本项目以 **GNU AGPL-3.0-or-later** 发布，许可证全文见 [LICENSE](LICENSE)，
并随安装包一同分发。

**来源与第三方声明见 [NOTICE.md](NOTICE.md)；
许可原文与逐项清单见 [THIRD_PARTY_NOTICES/](THIRD_PARTY_NOTICES/README.md)。**

### 所管理服务的许可（请务必了解）

| 项目 | 许可 | 要点 |
|---|---|---|
| [MaiBot](https://github.com/Mai-with-u/MaiBot) | **GPLv3 + EULA V1.3** | 使用前须阅读并同意其 EULA；本启动器不代为同意 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | 以该仓库自身的声明为准（GitHub 标识 `NOASSERTION`） | 由**用户自行安装**的独立协议端程序；**不在本启动器的发布产物内**，也未被声明为依赖 |

> ⚠️ **本项目不再引用、不打包也不下载任何 QQ 注入式协议端。**
> 相关支持、代码与文档已全部移除，其许可证原文也已从
> [`THIRD_PARTY_NOTICES/`](THIRD_PARTY_NOTICES/README.md) 中撤下（原因见该目录说明）。
> 协议端现在**只有 SnowLuma** 一种，且由用户自行安装、独立进程运行。

> 说明：设置页的「SnowLuma 下载安装」是**替你向官方 GitHub Releases 发起下载**
> （落盘的是官方原包），并不构成本项目对 SnowLuma 的打包或再分发。
> 你也可以完全不用该按钮，自行获取后把「SnowLuma 目录」指过去。

本启动器**不修改**这些项目的代码，也**不重新实现**其启动逻辑，
二者均以独立进程运行，构成聚合关系而非衍生作品。

### 代码来源与 AI 使用说明

> 如实说明，不主张多于实际的东西。

- **绝大部分代码由 AI 编程助手生成或辅助编写**（由 DeepSeek 系列模型驱动），
  随后经**人工审阅、修改与测试**。早期版本曾出现过"界面代码为完全原创编写"
  这类表述，它不准确，现已更正。
- **人工贡献在于**：需求取舍、整体架构与判定逻辑的设计、对 AI 输出的审查与修正，
  以及真机验证（逐页自检、冒烟测试、所管理服务的实际启停与升级回归）。
- **未复制任何第三方项目的源代码**：界面图标由 `scripts/gen-icons.mjs` 程序化生成，
  未打包任何字体（界面仅使用系统内置字体），对被管理的 MaiBot / SnowLuma
  只做独立进程调用（命令行调用 + 标准输出捕获），不链接、不修改其代码。
  结论来源见 [docs/license-audit.md](docs/license-audit.md)。
- **授权与著作权**：本项目整体以 **AGPL-3.0-or-later** 分发。
  需说明的是，AI 生成部分在不同法域下可能不构成受著作权保护的成果；
  对本项目中的这类部分，**本项目不主张独占著作权**。
  对本项目的整体汇编及人工撰写、人工修改的部分，本项目主张相应权利。
  以上为项目方的自我说明，不构成法律意见；具体权利状态依各法域法律而定。

### 界面来源与素材边界

- 界面的视觉方案（布局、配色、组件、交互）为本项目自研，
  **未复制任何第三方界面的源代码或资源**；
- 项目中**不含任何第三方游戏素材**（立绘、UI 元素、音效、字体、Logo），也未打包任何字体。
  全部图标由 `scripts/gen-icons.mjs` 在构建时以代码程序化生成
  （无外部素材输入，且可字节级复现），界面仅使用系统内置字体。
  本项目为**第三方非官方工具**，无隶属或授权关系。

### 第三方依赖

运行时依赖共 4 个（`vue`、`vue-router`、`@xterm/xterm`、`@xterm/addon-fit`），
全部为 MIT 许可；原生模块 `node-pty` 同为 MIT。经打包实测，
安装包内不含任何 copyleft 或专有许可的第三方包。
