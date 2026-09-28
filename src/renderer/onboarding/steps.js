/*
================================================================================
模块：src/renderer/onboarding/steps.js
职责：新手引导的步骤定义与判定逻辑（纯函数，便于单元测试）。
================================================================================
  为什么把步骤抽成纯函数：
    引导的正确性完全取决于"每一步该检查什么、什么算完成"。
    如果逻辑埋在组件里，就只能靠人肉点界面来验证，而这类错误
    （比如把 0.6.x 当 1.2.x 引导）恰恰是"点了也看不出错"的。
    抽出来之后 scripts/verify-onboarding.mjs 可以直接喂真实数据断言。

  核心约定（与用户明确约定过）：
    · **不自动勾选**：done 只由用户在界面上点「我已完成」决定。
      这里的 ready 只表示"检测看起来没问题"，用于给按钮加亮，
      **不参与 done 判定** —— 自动打勾会制造"看起来配好了"的假象。
    · **纯只读**：actions 只允许跳转/复制/打开，不允许改文件。

  协议端只有 SnowLuma（独立 Node 程序，不注入 QQ 进程）：
    · 它自带运行时与 WebUI，**不要求本机装 QQ 客户端**，
      所以旧版那步「确认你装了 QQ」连同 QQ 注入那套一起删掉了；
    · 它默认只开 WebUI，"正向 WebSocket 服务器"要在它自己的 WebUI 里现建，
      端口也由用户填写 —— 启动器没有可靠落点，所以这半只给指引、不假装检测过；
    · 麦麦这半边靠官方插件 MaiBot-SnowLuma-Adapter：它跑在 MaiBot 进程内，
      以客户端身份去连那个正向 WS，server / port 必须与 SnowLuma 一致。

  步骤依据：官方文档 docs.mai-mai.org/manual/adapters/snowluma（已联网核对），
  不是照源码猜的。
================================================================================
*/

/**
 * 步骤 id：持久化用，改名会让老用户的进度丢失，所以保持稳定。
 * 旧版那两步（QQ 客户端探测、QQ 注入式协议端接线）的 id 随概念一起删除；
 * 它们留在 doneIds 里只会被忽略，不会让任何一步被误打勾。
 */
export const STEP_IDS = {
  version: 'maibot-version',
  tools: 'tools',
  install: 'install-maibot',
  config: 'init-config',
  agreement: 'agree-eula',
  webui: 'webui-token',
  model: 'llm-model',
  snowluma: 'snowluma-runtime',
  adapter: 'snowluma-adapter',
  chat: 'first-chat'
};

/** 小工具：把探测结果转成"带色调的事实行" */
const fact = (text, tone) => ({ text, tone });

/**
 * 构造引导步骤。
 *
 * @param {object} input
 * @param {object|null} input.env    detectAll() 的结果（可能为 null = 还没探测）
 * @param {string[]} input.doneIds   用户手动标记完成的步骤 id
 * @param {object} input.docs        外部链接（由组件注入，避免这里硬编码）
 * @returns {Array} 步骤数组
 */
export function buildSteps(input = {}) {
  const env = input.env || null;
  const doneIds = Array.isArray(input.doneIds) ? input.doneIds : [];
  const docs = input.docs || {};
  const done = (id) => doneIds.includes(id);

  const tools = env?.tools || null;
  const mv = env?.maibotVersion || null;
  const maibot = env?.maibot || null;
  const snowluma = env?.snowluma || null;
  /*
    适配器插件是"接线"里**唯一能靠文件系统验证**的一半。
    另一半（SnowLuma 上那个正向 WS 服务器）只能在它的 WebUI 里由用户现建，
    实测它的 config/runtime.json 里没有 OneBot 段，硬写一份猜结构的只会
    制造"看起来配好了、其实没生效"，所以那半只给指引。
  */
  const adapter = mv?.adapter || null;
  const running = Array.isArray(env?.running) ? env.running : [];
  const svcRunning = (key) => running.some((s) => s && s.key === key && s.running);

  const steps = [];

  /* ------------------------------------------------------ 1. 版本是根因 */
  /*
    官方 SnowLuma 适配器只支持 MaiBot ≥ 1.2.0，而 0.6.x 是另一套架构；
    判错版本 = 用户每一步都"照做了"却永远连不上。
    所以它必须排在最前面，早于任何"启动/连接"类的引导。
  */
  const versionBlocked = mv?.kind === 'unsupported';
  steps.push({
    id: STEP_IDS.version,
    title: '确认 MaiBot 版本（很关键）',
    why:
      '官方 SnowLuma 适配器只支持 MaiBot 1.2.0 或更新。0.6.x 是另一套完全不同的架构' +
      '（配置文件字段、适配器形态、WebSocket 方向、依赖的数据库都不一样），' +
      '混用会导致"每一步都照做了但永远连不上"。所以先说清楚版本。',
    ready: mv?.kind === 'supported',
    facts: mv
      ? [
          mv.kind === 'supported'
            ? fact(`MaiBot ${mv.version}（受支持）`, 'ok')
            : mv.kind === 'unsupported'
              ? fact(`检测到 ${mv.version}（不受支持）`, 'err')
              : fact('无法判定版本', 'warn'),
          ...(mv.evidence || []).slice(0, 3).map((e) => fact(e))
        ]
      : [fact('尚未检测')],
    warn: versionBlocked
      ? mv.message
      : mv?.kind === 'unknown'
        ? mv.message
        : '',
    actions: versionBlocked || mv?.kind === 'unknown'
      ? [
          { key: 'v-route', kind: 'route', label: '去安装器装 1.2.x', icon: 'folder', hash: '#/installer' },
          { key: 'v-onekey', kind: 'external', label: '官方一键包', icon: 'link', url: docs.ONEKEY },
          { key: 'v-win', kind: 'external', label: '官方部署文档', icon: 'info', url: docs.DOCS_WIN }
        ]
      : []
  });

  /* ------------------------------------------------------ 2. 工具链 */
  const py = tools?.python;
  const toolsReady = Boolean(py?.ok && tools?.git?.ok);
  steps.push({
    id: STEP_IDS.tools,
    title: '检查工具链（Python 3.12+ / Git）',
    why:
      '官方 Windows 部署要求 Python 3.12 或更新，并且推荐用 uv 装依赖。' +
      '这几样缺一个，都会在你后面完全想不到的地方报错，所以先查。',
    ready: toolsReady,
    facts: tools
      ? [
          fact(py?.message || 'Python 未知', py?.ok ? 'ok' : 'err'),
          fact(tools.git?.message || 'Git 未知', tools.git?.ok ? 'ok' : 'err'),
          fact(tools.uv?.message || 'uv 未知', tools.uv?.ok ? 'ok' : 'warn')
        ]
      : [fact('尚未检测')],
    warn: py && !py.ok ? py.message : '',
    actions: [
      { key: 't-py', kind: 'external', label: '下载 Python', icon: 'link', url: 'https://www.python.org/downloads/' },
      { key: 't-git', kind: 'external', label: '下载 Git', icon: 'link', url: 'https://git-scm.com/downloads' }
    ]
  });

  /* -------------------------------------------- 3. 装 MaiBot（若还没装） */
  steps.push({
    id: STEP_IDS.install,
    title: '安装 MaiBot 1.2.x',
    why:
      '推荐用官方一键包（自动配好 Python 环境和依赖）；也可以用安装器按版本下载源码。' +
      '这一步会真的动磁盘，所以交给你自己点 —— 引导只负责跳转。',
    ready: mv?.kind === 'supported',
    facts: maibot
      ? [
          fact(
            maibot.dir ? `当前目录：${maibot.dir}` : '还没设置 MaiBot 目录',
            maibot.dir && maibot.kind === 'maibot' ? 'ok' : 'warn'
          ),
          ...(maibot.entry ? [fact(`找到入口：${maibot.entry}`, 'ok')] : [])
        ]
      : [fact('尚未检测')],
    actions: [
      { key: 'i-route', kind: 'route', label: '打开安装器', icon: 'folder', primary: true, hash: '#/installer' },
      { key: 'i-onekey', kind: 'external', label: '官方一键包', icon: 'link', url: docs.ONEKEY }
    ]
  });

  /* -------------------------------------------------- 4. 首次初始化 */
  const hasConfig = Boolean(mv?.hasConfigDir);
  steps.push({
    id: STEP_IDS.config,
    title: '首次启动，生成配置文件',
    why:
      '第一次启动时 MaiBot 会自动生成 config/bot_config.toml 和 data/ 目录。' +
      '如果它在终端停下来问你，那是因为第一次要同意用户协议（见下一步）。',
    ready: hasConfig,
    facts: [
      hasConfig ? fact('已生成 config/ 目录', 'ok') : fact('还没生成 config/ 目录', 'warn'),
      fact(svcRunning('maibot') ? 'MaiBot 正在运行' : 'MaiBot 当前未运行')
    ],
    actions: [
      { key: 'c-route', kind: 'route', label: '去启动 MaiBot', icon: 'play', hash: '#/' }
    ]
  });

  /* ------------------------------------------- 5. 用户协议（必踩的坑） */
  steps.push({
    id: STEP_IDS.agreement,
    title: '在终端输入「同意」',
    why:
      '这是官方文档专门列出的常见问题：MaiBot 第一次启动会要求同意用户协议，' +
      '必须在终端里输入中文「同意」并回车 —— 输入 yes 或 y 都不行，会一直卡住。',
    ready: hasConfig,
    facts: [fact('终端页可以直接往 MaiBot 的 stdin 发内容', 'ok')],
    warn: '如果你看到它一直停在协议那一行，就是这里没输入对。',
    actions: [
      { key: 'a-term', kind: 'route', label: '打开终端页输入「同意」', icon: 'bolt', primary: true, hash: '#/terminal' }
    ]
  });

  /* --------------------------------------- 6. WebUI Token（每次都会变） */
  steps.push({
    id: STEP_IDS.webui,
    title: '拿到 WebUI 登录 Token',
    why:
      'MaiBot 的管理界面在 http://localhost:8001。首次启动时它会在终端打印一行' +
      '「🔑 WebUI 登录 Token: …」，而且**每次冷启动都会换新的**。' +
      '启动器会替你从日志里读出来，直接复制就行，不用去终端里翻。',
    ready: svcRunning('maibot'),
    facts: [
      fact('WebUI 地址：http://127.0.0.1:8001', 'ok'),
      fact('登录后它会要求你设一个固定 Token（≥10 位 + 大写 + 小写 + 特殊符号）')
    ],
    actions: [
      { key: 'w-token', kind: 'copy-token', label: '复制当前 Token', icon: 'copy', primary: true },
      { key: 'w-open', kind: 'maibot-webui', label: '打开 WebUI', icon: 'link' }
    ]
  });

  /* --------------------------------------------- 7. 模型（不然不说话） */
  steps.push({
    id: STEP_IDS.model,
    title: '配置 LLM 模型',
    why:
      '麦麦靠大模型说话，至少要有**一个**可用的模型（API 地址 + Key）。' +
      '官方首次配置向导里就有这一步，也可以跳过、之后在 WebUI 里补。',
    ready: false,
    facts: [fact('没有配模型时，麦麦收到消息也不会回复', 'warn')],
    actions: [
      { key: 'm-open', kind: 'maibot-webui', label: '在 WebUI 里配置', icon: 'link', primary: true }
    ]
  });

  /* --------------------------------- 8. SnowLuma 运行时（QQ 那一侧） */
  const slDir = String(env?.dirs?.snowlumaDir || '').trim();
  const slReady = snowluma?.kind === 'snowluma';
  steps.push({
    id: STEP_IDS.snowluma,
    title: '安装并启动 SnowLuma',
    why:
      'SnowLuma 是独立程序：不注入 QQ 进程，也不要求本机装 QQ 客户端 ——' +
      '它自带的 Node 运行时和 WebUI 都在自己的目录里，登录机器人 QQ 也在它的 WebUI 里做。' +
      '先在「安装器」页把它装下来并启动，后面的接线才有对象。',
    ready: slReady,
    facts: slDir
      ? [
          fact(snowluma?.message || '已配置目录，尚未探测', slReady ? 'ok' : 'warn'),
          ...(snowluma?.entry ? [fact(`入口：${snowluma.entry}`, 'ok')] : []),
          fact(svcRunning('snowluma') ? 'SnowLuma 正在运行' : 'SnowLuma 当前未运行')
        ]
      : [fact('还没设置 SnowLuma 目录', 'warn')],
    warn: slDir ? '' : '到「设置 → SnowLuma 目录」填目录，或用下面的按钮去安装器页一键下载。',
    actions: [
      { key: 'sl-installer', kind: 'route', label: '去安装 SnowLuma', icon: 'download', primary: true, hash: '#/installer' },
      { key: 'sl-repo', kind: 'external', label: '官方仓库', icon: 'link', url: docs.SNOWLUMA_REPO }
    ]
  });

  /* --------------------- 9. OneBot 正向 WS + 官方适配器插件（麦麦那半边） */
  const adapterReady = Boolean(adapter?.hasManifest) && adapter?.kind === 'official';
  steps.push({
    id: STEP_IDS.adapter,
    title: '建 OneBot 正向 WS，装官方适配器',
    why:
      'SnowLuma 默认**只开 WebUI**：正向 WebSocket 服务器要你在它的 WebUI 里现建一个，' +
      '端口记住（启动器设置里那个「SnowLuma OneBot 端口」就是拿来和它对账的）。' +
      '麦麦这半边装官方插件「MaiBot-SnowLuma-Adapter」—— 它跑在 MaiBot 进程内，' +
      '以客户端身份去连那个正向 WS，插件里的 server / port 必须与 SnowLuma 上建的完全一致。',
    ready: adapterReady,
    facts: [
      adapter
        ? fact(
            `适配器插件「${adapter.name}」${adapter.version ? ' v' + adapter.version : ''}` +
              (adapter.hasManifest ? ' 已就位' : ' 缺 _manifest.json —— 麦麦不会加载它'),
            adapterReady ? 'ok' : 'warn'
          )
        : fact('还没检测到 SnowLuma 适配器插件', 'warn'),
      adapter && adapter.kind === 'fork'
        ? fact('这个名字不是官方那份：社区第三方分支的配置版本不同，装错了从日志里看不出来', 'err')
        : fact('官方插件目录：plugins/MaiBot-SnowLuma-Adapter'),
      fact('插件放对位置还不够：配置里 enabled 必须为 true 才会去连（位置对了但没启用，照样一声不响）')
    ],
    warn:
      '两个最容易踩的坑：① 插件位置对了但没启用，表现是"SnowLuma 在跑、麦麦这边毫无反应"；' +
      '② 聊天的名单过滤默认开启且名单为空 —— 不把群号加进去，所有消息都会被丢掉。',
    actions: [
      { key: 'ad-repo', kind: 'external', label: '官方适配器仓库', icon: 'link', primary: true, url: docs.ADAPTER },
      { key: 'ad-docs', kind: 'external', label: '官方适配器文档', icon: 'info', url: docs.ADAPTER_DOCS },
      { key: 'ad-check', kind: 'route', label: '去总览页自检接线', icon: 'scan', hash: '#/' }
    ]
  });

  /* ------------------------------------------- 10. 验收：能不能收到 */
  steps.push({
    id: STEP_IDS.chat,
    title: '验收：让麦麦回一句话',
    why:
      '把机器人 QQ 拉进一个群（或用另一个号私聊它），在群里 @ 一下麦麦。' +
      '能收到回复就说明整条链路通了：QQ → SnowLuma → 适配器插件 → MaiBot → 模型 → 回消息。',
    ready: false,
    facts: [
      fact('收不到回复时，先查适配器的群聊名单里有没有这个群号（默认空名单会把消息丢光）'),
      fact('再查适配器插件的 enabled 是不是 true（放对位置但没启用照样连不上）'),
      fact('还不行就看 MaiBot 的日志页，那里会写明原因')
    ],
    actions: [{ key: 'f-logs', kind: 'route', label: '打开日志页', icon: 'info', hash: '#/logs' }]
  });

  /* done 只由用户点击决定；ready 仅用于按钮加亮，不参与判定 */
  return steps.map((s) => ({ ...s, done: done(s.id) }));
}

export default { buildSteps, STEP_IDS };
