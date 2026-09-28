# 第三方声明与许可清单

本目录存放本项目所**引用、调用或管理**的第三方项目的许可原文与说明。

> 与早期版本相比，本目录少了一个文件：那份 **QQ 注入式协议端的许可证原文**
> 已随该支持一起移除。原因见下面第 1 节 ——
> 本项目现在**只以 SnowLuma 作为协议端**，不再引用、打包或下载任何注入式协议端，
> 保留一份指向它的许可文本反而构成**不准确的归属声明**。

本项目的完整来源说明见仓库根目录的 [NOTICE.md](../NOTICE.md)。

---

## 1. 已移除的第三方条目 —— QQ 注入式协议端（专有许可）

> **本条目已作废，保留在此仅为说明"为什么这里少了一个文件"。**

本项目曾支持一种 **QQ 注入式协议端**（把自己注入到 `QQ.exe` 里运行的协议端插件），
并为此在本目录下保存了它的许可证原文文件。

**现在这套支持已经整体移除**：代码、IPC 通道、界面组件、QQ 客户端探测、
端口与仓库常量、相关文档表述全部删除，协议端**只剩 SnowLuma 一种**。
那份许可证原文文件**已从本目录删除**，不再随本项目分发。

### 为什么连许可证文本也一起删掉

那份许可的第 2 条要求"再分发时须附许可全文并标注来源"。
但**前提是确实发生了再分发** —— 而本项目现在：

- **不引用**它：没有任何代码路径调用它；
- **不打包**它：它的文件不在本项目的发布产物里；
- **不下载**它：启动器不再为它发起任何请求；
- **不再管理**它：不启动、不读日志、不改配置。

在这种状态下继续在目录里留一份它的许可证全文，等于向接收者**声明了一个
并不存在的归属关系** —— 那是**不准确的归属声明**，比不写更容易误导人。
因此该文件已删除，本条目的位置改为这份说明。

### 对使用者的提醒

- 如果你**自己在用**那类注入式协议端，那是你与它作者之间的事，
  请自行获取并遵守其许可（尤其是"禁止商业用途"一类的限制）。
- 本项目**不支持、不参与、也不为你配置**那类协议端。
- 旧的教程/配置里如果还留着 `3001` / `6099` / `6199` 这类端口，
  那是那类协议端（或 AstrBot）的端口，与 SnowLuma 无关。

---

## 2. SnowLuma —— 本项目唯一的协议端

- 项目：<https://github.com/SnowLuma/SnowLuma>
- 许可：仓库自带的**自定义许可文件**；GitHub 许可标识为 `NOASSERTION`
  （即**不是** OSI 认可的标准开源协议）
- 形态：**独立 Node 程序**，自带运行时与 WebUI，**不注入 QQ 进程**，
  也不要求用户安装 QQ 客户端

> ⚠️ **本目录不收录 SnowLuma 的许可原文**。原因是本项目**不随包分发**协议端程序：
> 它的文件不在本项目的发布产物内、也不作为依赖声明。用户在启动器里点「下载安装」
> 时，启动器只是**替你向官方 GitHub Releases 发起下载**，落盘的是官方原包；
> 你也可以完全不用启动器，自行获取。
> 具体条款请以该仓库的 `LICENSE` 为准。

### 本项目如何与之相处

- **启动**：以它自身的入口（`index.mjs`，完整包里同时带 `node.exe`）启动，自建启动命令。
- **配置**：**不替用户改写它的文件**。它的 OneBot 正向 WS 服务器本来就不在
  配置文件里（实测它默认只监听 WebUI 5099，生成的 `config/runtime.json`
  里没有 OneBot 段），需要用户在它自己的 WebUI 里新建。
- **日志**：读取它自身产生的标准输出（例如首次启动打印的 WebUI 初始凭据），
  这属于运行已授权软件的正常使用。
- **自检**：只做**只读探测** —— 真的去连它的 WebUI / OneBot 端口，
  以及真的读 MaiBot 的 `plugins/` 目录判断适配器插件在不在。

### 对使用者的提醒

> **SnowLuma 的许可不是标准开源协议。** 如果你打算把包含它的部署用于商业用途，
> 请先自行阅读该仓库的许可条款。本项目不对其授权状况作判断或背书。

---

## 3. MaiBot 侧要装的官方适配器插件

- 仓库：<https://github.com/Mai-with-u/MaiBot-SnowLuma-Adapter>
- 官方目录名：`plugins/MaiBot-SnowLuma-Adapter`
- 配置版本：**1.0.6**

这是**跑在 MaiBot 进程内的插件**，不是本项目的一部分，也不随本项目分发 ——
用户自行 `git clone` 到 MaiBot 的 `plugins/` 下（或用 MaiBot 的插件市场装）。

> ⚠️ 社区里另有一份第三方分支 `plugins/snowluma-adapter`（配置版本 `1.0.0`）。
> 它的**配置结构与官方那份不同**，装错会"看起来一切正常但连不上"。
> 本项目会在接线自检里比对目录名，命中分支时明确提示"疑似第三方分支"。

---

## 4. MaiBot —— GPLv3 + 最终用户许可协议（EULA）

- 项目：<https://github.com/Mai-with-u/MaiBot>
- 许可：**GNU GPLv3**（主程序源代码）+ **EULA V1.3**（最终用户许可协议）
- 版权：2025 © MaiBot 项目团队

### 双许可结构

MaiBot 发行包内含两份文件，**两者都需要遵守**：

- `LICENSE` —— GPLv3 全文（涵盖主程序源代码的复制、修改、分发）
- `EULA.md` —— 最终用户许可协议 V1.3，其中第 1.2 条要求：
  **在运行或使用本项目之前，您必须阅读并同意本协议的所有条款。**

MaiBot 安装目录中的 `eula.confirmed` / `privacy.confirmed` 即为用户已确认的标记。

### 本项目如何与之相处

- 本项目**不是 MaiBot 的衍生作品**：不与它链接、不把它嵌入进程，
  仅以**独立进程**方式启动它（命令行调用 + 标准输出捕获）。
  在 GPL/AGPL 的意义上，二者构成**聚合（aggregate）**而非衍生作品。
- 因此本项目的 AGPL-3.0-or-later 许可**不会**因管理 MaiBot 而被 GPLv3 覆盖，
  反之亦然。
- 本项目**不代为同意 MaiBot 的 EULA**。EULA 是用户与 MaiBot 项目团队之间的协议，
  需由用户自行阅读并同意。若 MaiBot 首次运行要求确认 EULA，请用户自行确认。

> **提醒**：使用 MaiBot 前请阅读其 `EULA.md` 与 `PRIVACY.md`。
> 特别是涉及数据收集与模型调用的条款。

---

## 5. 本项目自身的依赖（随安装包分发的部分）

本项目的运行时依赖全部为宽松许可（MIT）。经实测，**打出的安装包内实际包含
以下第三方件**（Vue / vue-router / xterm 已由 Vite 编译进 `dist/renderer`，
不再以独立包形式存在；`node-pty` 因含原生模块必须保留为独立文件）：

### 5.1 Electron / Chromium（包体最大的两个三方件）

| 组件 | 许可 | 随包的文件与位置 |
|---|---|---|
| `Electron` | MIT（Copyright (c) Electron contributors；Copyright (c) 2013-2020 GitHub Inc.） | 安装目录根部的 `LICENSE.electron.txt`（实测 1 096 B，免安装版 `release/win-unpacked/` 内同样存在） |
| `Chromium`（Electron 内嵌的浏览器内核，含 V8 等） | BSD-3-Clause 等 Chromium 自身的多项许可（逐项见文件内） | 安装目录根部的 `LICENSES.chromium.html`（实测 15 271 935 B 全量三方许可清单，免安装版同样存在） |

> 上面两个文件由 `electron-builder` 在打包时自动落盘，不是本项目自己撰写的声明，
> 本项目**不改动**它们的内容。如上表所述，它们是**独立文件、不装在 `app.asar` 内**，
> 用户可以直接在安装目录里打开阅读。

### 5.2 npm 依赖

| 包 | 许可 | 是否以独立包形式分发 |
|---|---|---|
| `node-pty` | MIT（Copyright (c) Microsoft Corporation；`LICENSE` 内同时保留早期 `pty.js` 的 Christopher Jeffrey 版权段） | 是（因含原生模块，落在 `app.asar.unpacked/node_modules/node-pty/`） |
| `vue` | MIT | 否（已编译进产物） |
| `vue-router` | MIT | 否（已编译进产物） |
| `@xterm/xterm` | MIT | 否（已编译进产物） |
| `@xterm/addon-fit` | MIT | 否（已编译进产物） |
| `@vue/*`、`@babel/*`、`postcss`、`magic-string` 等 | MIT | 否（构建期工具，不随包分发） |

### 5.3 `node-pty` 的子组件（随 `node-pty` 一同分发）

| 子组件 | 许可 | 随包的文件与位置 |
|---|---|---|
| `winpty`（`node-pty` 的 `deps/winpty`，Windows 旧版控制台后端） | MIT（Copyright (c) 2011-2016 Ryan Prichard） | 许可原文随包：`app.asar.unpacked/node_modules/node-pty/deps/winpty/LICENSE`（实测 1 085 B）；二进制为 `prebuilds/win32-*/winpty.dll`、`winpty-agent.exe` |
| ConPTY 组件（`OpenConsole.exe`、`conpty.dll`，`node-pty` 的 `third_party/conpty/1.23.251008001/`） | MIT（该二进制来自 Microsoft **Windows Terminal** 项目的 ConPTY 实现） | 二进制随包：`node-pty/third_party/conpty/…` 与 `node-pty/prebuilds/win32-*/conpty/…`；**上游没有为它附带独立的许可文件**，因此它的许可声明就以本表这一行为准 |

> 说明：`node-pty` 的本机模块与 `prebuilds/` 里包含 darwin / linux / win32 各平台的
> 预编译文件，它们随包原样分发（本项目在 Windows 上只用 `win32-x64` 那一份）。

### 5.4 许可原文在包内的实际情况（逐项写清"本包随附了哪些文件"）

- **只有以独立包形式分发的依赖才携带许可原文**（这正是 MIT「随副本包含版权声明
  与许可声明」的要求所在）：
  `app.asar.unpacked/node_modules/node-pty/LICENSE` 与
  `node_modules/node-pty/deps/winpty/LICENSE` —— 实测 `app.asar` 内许可类文件
  **只有这两个**（另有 `node-pty/package.json` 的 `"license": "MIT"` 字段）。
- **Vue / vue-router / xterm 是被 Vite 编译进 `dist/renderer` 的**（不以独立包存在），
  它们的许可声明以构建产物里保留的 `@license MIT` 注释形式存在
  （可在 `dist/renderer/assets/index-*.js` 中检索到）。
- **Electron / Chromium 的许可原文是独立的落地文件**，不装在 `app.asar` 内
  （见 5.1：`LICENSE.electron.txt`、`LICENSES.chromium.html`）。
- **ConPTY 二进制没有独立许可文件**（见 5.3 的说明）。

### 关于 MIT 许可的合规说明

MIT 许可要求：**在软件的所有副本或实质部分中包含版权声明与许可声明**。

- `node-pty`（含 `deps/winpty`）以独立包形式分发，其 `LICENSE` 文件**随包一同分发**，
  满足要求；ConPTY 组件没有独立许可文件，其声明由本清单给出。
- Vue / vue-router / xterm 经打包后，其许可声明由构建工具保留在产物注释中
  （`dist/renderer/assets/index-*.js` 内的 `@license MIT`）。
- **本项目自身的许可原文（`LICENSE`）已显式加入打包白名单**，
  随安装包一同分发，以满足 AGPL-3.0 的相应要求。

---

## 6. 其他被参考但未使用的项目

**本节没有条目**（原先那张表只有表头、没有任何项目，已删除）。

早期版本在这里列过两个「界面风格参考」项目。仓库根目录的 [NOTICE.md](../NOTICE.md)
已不再保留那段归属描述 —— 本项目**没有使用它们的任何代码或资源**，
继续列出反而会被读成存在代码复用关系（不准确的归属声明比不写更容易误导人）。
如果将来确实引入了第三方代码或资源，应在本目录新增条目，并写清"随包附了哪些文件"。

---

## 7. 游戏相关素材

也不包含任何其他游戏的素材。详见 [NOTICE.md](../NOTICE.md) 第二节。

- 全部图标由 `scripts/gen-icons.mjs` 在构建时以代码程序化生成
  （手写 PNG/ICO 编码，无外部素材输入，可字节级复现）。
- 界面仅使用操作系统内置字体，**未打包任何字体文件**。
- 无音频、无视频、无角色立绘、无游戏内 UI 元素。

---

## 8. 本项目自己的随包文件（不是第三方组件，列出以便逐项核对）

下面这些文件**属于本项目本身**，在这里列出只是为了让"包里到底有什么"一目了然：

| 文件 | 性质 | 许可 |
|---|---|---|
| `resources/ansi-shim/sitecustomize.py` | 本项目自研的 colorama 保色垫片（文件头已带 `SPDX-License-Identifier: AGPL-3.0-or-later`） | AGPL-3.0-or-later |
| `resources/hero.png` | 界面左下角插画，**由本项目作者提供**（详见 [NOTICE.md](../NOTICE.md) 第一节） | 随本项目以 AGPL-3.0-or-later 分发 |
| `LICENSE` | 本项目许可全文 | AGPL-3.0（全文） |
| `NOTICE.md` | 来源说明与第三方声明 | 本项目文档 |
| `NOTICE-TO-USER.md` | 使用须知（数据存放与联网行为披露） | 本项目文档 |
| `THIRD_PARTY_NOTICES/` | 本目录 | 本项目文档 |

> 以上文件均在 `package.json` 的 `build.files` 白名单内，**随安装包一同分发**
> （`app.asar` 内或安装目录根部）。除此之外，包内没有本项目的其它源码文件。

---

*本文件随项目版本一同维护。如发现描述与实际情况不符，请通过仓库 Issue 指出。*
