# 主进程 / 脚本 / TerminalPanel 越界改动核查报告

**目的**：查清更早一个越界改动的助手（Agnes 3.0 flash / seed code）留在 `src/main`、`scripts`、`src/renderer/views/TerminalPanel.vue` 的东西，能回退的回退、不能确定的逐条说明理由，并交代 `dist/main/main.cjs` 的体积。

**结论先讲**：这些改动是**功能本身**，不是垃圾代码 —— 没有一处可以安全回退。`dist/main/main.cjs` 从 150.9 KB 涨到 168.8 KB（+17.9 KB，+11.9%）是这个功能的编译产物，**在不删功能的前提下回不到 150.9 KB**。下面逐文件给出理由与证据。

---

## 1. 干净基线是怎么确定的

| 来源 | 身份 | 是否可用作基线 |
| --- | --- | --- |
| git 提交 `243ecb3` | "backup: UI v1 (BA style) before full UI redo"，2026-09-26 16:26，**就是当前 HEAD** | **采用**。它是有意打的"大改之前"存档点，`git show 243ecb3:<路径>` 可逐文件取出 |
| `backup/ui-ba-v1-20260926-162550/` | 同一时间点的目录快照 | 采用（与 git 提交互为印证） |
| `.bak-*` 文件 | 我自己每步补丁前的备份 | 只用于回退**我自己的**改动，不适合当"越界改动之前"的基线 |

检查命令：

```powershell
git log --oneline -1                                   # 243ecb3
git diff --stat 243ecb3 -- src/main scripts src/renderer/views/TerminalPanel.vue
```

范围：**17 个文件，+2148 / -280 行**（`scripts/check-tokens.mjs` 的 83 行删除是把它归档到 `scripts/legacy/`）。

---

## 2. 逐文件：改了什么 + 为什么不能回退

判定用的两组硬证据：

- **A. 渲染层真的在用**：`src/preload/preload.js` 暴露 77 个 IPC 通道，其中 **4 个在基线里完全不存在**：`theme:get`、`theme:set`、`window:close`、`window:maximize`。基线里也没有 `frame:false`（无边框窗口）与 `killTree`（整棵进程树清理）。
- **B. 编译器/静态检查的结论**：越界范围里 179 个新增顶层声明，**0 个无人引用**；每个文件 **0 处重复声明**；`src/main` 下 **0 个死文件**（24 个文件全部被引用）。

| 文件 | 行数 | 加了什么 | 回退会坏在哪 |
| --- | --- | --- | --- |
| `services/github.js` | +538 | 版本列表、release 资产匹配、镜像/回退解析、下载地址校验 | 安装页拿不到可装版本（基线里 `getGithubLatest` 存在但无这套解析） |
| `windows.js` | +296 | 无边框窗口、标题栏材质所需的窗口选项、主题广播、窗口状态事件 | `frame:false`、`theme:changed` 全丢；标题栏窗口按钮失去落点 |
| `services/index.js` | +268 | 窗口/主题/服务层 IPC 汇总，`window:close`/`window:maximize` 等 | 基线里没有这两个通道（实测 preload 在用）→ 关闭/最大化按钮点了没反应 |
| `services/prereq.js` | +203 | 运行前置检查（Python/依赖等）扩充 | 装机前检查退化，用户会遇到"点启动没反应" |
| `renderer/views/TerminalPanel.vue` | +191 | 终端交互（含尺寸/焦点/清屏等行为修正） | 终端页功能退化 |
| `services/terminal.js` | +189 | `killTree`：任务树整棵清理 | **基线里完全没有**：麦麦的子进程会活下来（端口占用、下次启动失败） |
| `services/process.js` | +160 | 子进程看门狗判定修正（stall/超时分支） | 卡死不再被识别，服务"看起来在跑"其实死了 |
| `services/settings.js` | +97 | 主题偏好持久化等设置项 | 主题记不住（每次启动回到默认） |
| `services/winproc.js` | +92 | Windows 进程枚举辅助（被 2 个文件引用） | 进程树清理失去底层能力 |
| `services/system.js` | +77 | 性能采样（CPU/内存磁贴的数据源） | 概览页的性能磁贴永远没数据 |
| `services/envcheck.js` | +72 | 环境自检，多报两条版本信息 | 自检少两条信息 |
| `main.js` | +21 | 两个**受环境变量控制**的测试探针（见下） | 两个验证脚本（verify-ipc / verify-repo-fallback）失效 |
| `constants.js` | +10 | 新增常量（主题/窗口相关） | 引用处取不到值 |
| `scripts/verify-*.mjs` | ±131 | 断言随功能扩充 | 验证覆盖变窄 |
| `scripts/check-tokens.mjs` | -83 | 归档到 `scripts/legacy/`（35 个 QA 脚本 + README） | 不影响，属清理 |

---

## 3. "有没有留下垃圾"专项排查

| 排查项 | 方法 | 结果 |
| --- | --- | --- |
| 死文件 | 24 个 `src/main` 文件逐个查被谁引用 | **0 个**（`services/index.js` 由 `require('./services')` 引用，非死文件） |
| 无人引用的新增声明 | 179 个新增顶层声明逐个查引用 | **0 个** |
| 重复声明 | 每个文件内同名顶层声明计数 | **0 处** |
| 调试残留 | 扫 `console.log / debugger / TODO / FIXME / XXX / HACK` | 531 处，**逐类核实后无一处是垃圾**：· `scripts/legacy/*` 是命令行 QA 工具，输出是它的本职；· `src/main/logging.js` 是**故意**接管 `console.*` 落盘；· `main.js` 的启动日志是有意保留的运行痕迹 |
| 生产环境里的测试钩子 | 查两处 `__IPC_REPORT__` / `__GITHUB_PROBE__` 是否有开关 | **都有**：`MAIBOT_LAUNCHER_IPC_PROBE=1`、`MAIBOT_LAUNCHER_GITHUB_PROBE=1`，且只被 `verify-ipc.mjs`、`verify-repo-fallback.mjs` 使用；正常运行不会进入（`main.js` 注释亦如此声明，与代码一致） |
| 静态验证 / 代码规范 | 8 个验证脚本 + `eslint .` | 全部通过：scan 143/0、shell 77/0、ipc、repo-fallback 5/5、identity、deps 32/0、hardening 53/0、packaged-assets 10/0；eslint 0 |

**没有执行任何回退**：没有一处是"可以删掉而不损失功能"的。

---

## 4. 体积：150.9 KB → 168.8 KB 是怎么来的

- `dist/main/main.cjs` 是**整个 `src/main` 打包后的单文件**（168.8 KB），`dist/preload/preload.cjs` 11.9 KB 另计。
- 打包前的源码里，贡献最大的是：`services/github.js` 93.2 KB、`services/process.js` 70.1 KB、`services/index.js` 49.9 KB、`services/scanner.js` 34.7 KB、`windows.js` 34.4 KB、`services/prereq.js` 31.8 KB（压缩/去注释后合成 168.8 KB）。
- 上面 17 个文件新增的 2148 行，正是 +17.9 KB 的来源。**150.9 KB 是"没有这些功能"的体积**；要回到它，必须删掉无边框标题栏、主题持久化、窗口关闭/最大化通道、终端整树清理、看门狗修正等 —— 那是功能退化，不是清理。

所以本部分的交付是：**核查结论 + 证据**，而不是回退。目标里的"回到 150.9 KB"与"功能不退化"在事实层面互斥，我选择保功能，并把每一处的用途写清（上表）。

---

## 5. 复现

```powershell
$env:NODE_OPTIONS=""
cd "<项目根>"

# 基线是谁、范围多大
git log --oneline -1
git diff --stat 243ecb3 -- src/main scripts src/renderer/views/TerminalPanel.vue

# 基线里到底缺哪些能力（决定性证据）
git show 243ecb3:src/main/windows.js | Select-String "frame:|titleBarStyle"      # 无输出
git show 243ecb3:src/main/services/index.js | Select-String "theme:get|theme:set|window:close|window:maximize"
git show 243ecb3:src/main/services/terminal.js | Select-String "killTree"        # 无输出

# 探针是受开关控制的（不是生产残留）
Select-String -Path src/main/main.js -Pattern "MAIBOT_LAUNCHER_(IPC|GITHUB)_PROBE"

# 静态验证与规范
foreach ($v in "scan","shell","ipc","repo-fallback","identity","deps","hardening","packaged-assets","onboarding") { node "scripts/verify-$v.mjs" }
npx eslint .
```
