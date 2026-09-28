/*
  实机/契约校验：SnowLuma 接入。
  ─────────────────────────────────────────────────────────────────────
  分四组：
    ① 服务载荷推导（目录探测、自带 node → 系统 node、缺 index.mjs → null）
    ② runtime.json 的写入与**合并**（不能抹掉用户在 SnowLuma 面板里改过的项）
    ③ 发布资产挑选（绝不选 lite 包）、仓库解析不串到 MaiBot
    ④ 设置归一化与预加载通道存在性

  资产挑选那组是纯函数测试，不发网络请求。
  这样"装了 lite 包导致启动失败"这类问题在 CI 就能拦住。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

let pass = 0;
let fail = 0;
const chk = (name, ok, extra) => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/* ---------------------------------------------------------------- 沙箱 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-snowluma-'));
const Module = require('module');
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userData, getVersion: () => '2.1.0', isPackaged: false } };
  }
  return realLoad.call(this, request, parent, isMain);
};

const proc = require(path.join(ROOT, 'src/main/services/process.js'));
const settings = require(path.join(ROOT, 'src/main/services/settings.js'));
const github = require(path.join(ROOT, 'src/main/services/github.js'));
const constants = require(path.join(ROOT, 'src/main/constants.js'));

/** 造一个 SnowLuma 目录；withNode 决定是否放 node.exe */
function makeSlDir(name, { withNode = true, withEntry = true } = {}) {
  const dir = path.join(userData, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withEntry) fs.writeFileSync(path.join(dir, 'index.mjs'), '// fake', 'utf8');
  if (withNode) fs.writeFileSync(path.join(dir, 'node.exe'), '', 'utf8');
  return dir;
}
const setSl = (dir, extra = {}) =>
  settings.saveBackendSettings({ service: { snowlumaDir: dir, ...extra } }, { immediate: true });

/* =========================================================== ① 服务载荷 */
console.log('[snowluma] ① 启动载荷推导');
{
  /*
    ⚠️ 这一组必须先把"默认模块位置"隔离掉。
    buildStartPayload 在设置为空/无效时会去 %LOCALAPPDATA%\<app.id>\resources\modules\snowluma
    兜底找已装好的运行时（见 ①b）。如果测试机上真的装了 SnowLuma，
    "未配置 → null" 这类断言就会失败 —— 不是代码错，是测试没隔离环境。
    所以这里把 LOCALAPPDATA/APPDATA 指到一个空临时目录。
  */
  const savedLocal = process.env.LOCALAPPDATA;
  const savedApp = process.env.APPDATA;
  process.env.LOCALAPPDATA = path.join(userData, 'isolated-empty');
  process.env.APPDATA = path.join(userData, 'isolated-empty');
  try {
    setSl('');
    chk('★ 未配置目录且默认位置也没有 → null（不编命令）', (await proc.buildStartPayload('snowluma')) === null);

    const dir = makeSlDir('ok');
    setSl(dir);
    const p = await proc.buildStartPayload('snowluma');
    chk('能推导出启动参数', Boolean(p));
    chk('★ 命令是包内自带的 node.exe', p.command === path.join(dir, 'node.exe'), p.command);
    chk('★ 参数是 index.mjs', JSON.stringify(p.args) === '["index.mjs"]', JSON.stringify(p.args));
    chk('★ cwd 必须是 SnowLuma 根目录（它相对 cwd 找 config/ 和 client/）', p.cwd === dir);

    chk(
      '★ 就绪端口用 snowlumaPorts.webui，不是 ports.webui',
      p.readyPort === constants.DEFAULT_SNOWLUMA_PORTS.webui,
      String(p.readyPort)
    );

    /* lite 包：没有 node.exe → 退回系统 node */
    const lite = makeSlDir('lite', { withNode: false });
    setSl(lite);
    const p2 = await proc.buildStartPayload('snowluma');
    chk('★ 包内无 node.exe → 退回系统 node', p2 && p2.command === 'node', p2 && p2.command);

    /* 目录不是 SnowLuma */
    const empty = makeSlDir('empty', { withEntry: false });
    setSl(empty);
    chk('★ 目录里没有 index.mjs → null', (await proc.buildStartPayload('snowluma')) === null);

    setSl(path.join(userData, '不存在'));
    chk('★ 目录不存在且默认位置也没有 → null', (await proc.buildStartPayload('snowluma')) === null);
  } finally {
    process.env.LOCALAPPDATA = savedLocal;
    process.env.APPDATA = savedApp;
  }
}

/* ============================================ ①b 默认模块位置兜底 ======== */
console.log('\n　      ①b 装好了但设置没填时，要能自动找到');
{
  /*
    守的是一个**实际发生过**的坑：程序装在默认模块位置，
    但设置里的 snowlumaDir 是空的（用户没走「下载安装」按钮，
    或者装了没点保存）—— 没有兜底的话界面会显示"未配置"，
    用户会以为得重装一遍。

    为了不受测试机是否真的装了 SnowLuma 影响，
    这里把 LOCALAPPDATA 指到一个临时目录，在里面造一个假的模块位置。
  */
  const fakeLocal = path.join(userData, 'fake-localappdata');
  const defDir = path.join(fakeLocal, 'com.maibot.launcher', 'resources', 'modules', 'snowluma');
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(path.join(defDir, 'index.mjs'), '// fake', 'utf8');
  fs.writeFileSync(path.join(defDir, 'node.exe'), '', 'utf8');

  const savedLocal = process.env.LOCALAPPDATA;
  const savedApp = process.env.APPDATA;
  process.env.LOCALAPPDATA = fakeLocal;
  process.env.APPDATA = fakeLocal;
  try {
    setSl('');
    const p = await proc.buildStartPayload('snowluma');
    chk('★ 设置为空时自动找到默认模块位置', Boolean(p) && p.cwd === defDir, p ? p.cwd : 'null');
    chk(
      '★ 自动找到时仍然用自带的 node.exe',
      Boolean(p) && p.command === path.join(defDir, 'node.exe')
    );

    setSl('Z:\\__绝对不存在__\\snowluma');
    const p2 = await proc.buildStartPayload('snowluma');
    chk('★ 设置里填了坏路径也能回退到默认位置', Boolean(p2) && p2.cwd === defDir);

    /* 两处都没有 → 必须 null，不能编一个命令出来 */
    process.env.LOCALAPPDATA = path.join(userData, 'nowhere1');
    process.env.APPDATA = path.join(userData, 'nowhere2');
    setSl('');
    chk('★ 两处都没有 → null（不编命令）', (await proc.buildStartPayload('snowluma')) === null);

    /*
      但"设置里显式填了有效路径"必须优先 —— 否则用户自己指定别的安装位置
      会被默认位置抢走（多版本共存时会用错那个）。
    */
    process.env.LOCALAPPDATA = fakeLocal;
    process.env.APPDATA = fakeLocal;
    const custom = makeSlDir('explicit');
    setSl(custom);
    const p3 = await proc.buildStartPayload('snowluma');
    chk('★ 设置里的有效路径优先于默认位置', Boolean(p3) && p3.cwd === custom, p3 ? p3.cwd : 'null');
  } finally {
    process.env.LOCALAPPDATA = savedLocal;
    process.env.APPDATA = savedApp;
  }
}

/* ================================================= ② runtime.json 写入 */
console.log('\n[snowluma] ② runtime.json 的写入与合并');
{
  const dir = makeSlDir('cfg');
  setSl(dir);
  await proc.buildStartPayload('snowluma');

  const cfgFile = path.join(dir, 'config', 'runtime.json');
  chk('★ 自动创建 config/runtime.json', fs.existsSync(cfgFile));
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  chk('★ 写入 webuiPort', cfg.webuiPort === 5099, String(cfg.webuiPort));
  chk(
    '★ hookAutoLoad 默认 false（不替用户开启自动注入 QQ）',
    cfg.hookAutoLoad === false,
    String(cfg.hookAutoLoad)
  );

  /*
    用户在 SnowLuma 自己的面板里改过 webuiHost / 日志保留等项。
    我们写 runtime.json 时必须合并，不能整份覆盖 ——
    覆盖会静默抹掉用户在那边做的设置。
  */
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      { webuiPort: 5099, hookAutoLoad: false, webuiHost: '127.0.0.1', logRetainDays: 3, logPerUin: true },
      null,
      2
    ),
    'utf8'
  );
  setSl(dir, { snowlumaPorts: { webui: 6099, onebot: 7988 } });
  const p = await proc.buildStartPayload('snowluma');
  const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  chk('★ webuiHost 未被抹掉', after.webuiHost === '127.0.0.1');
  chk('★ logRetainDays 未被抹掉', after.logRetainDays === 3);
  chk('★ logPerUin 未被抹掉', after.logPerUin === true);
  chk('★ 用户配的端口生效', after.webuiPort === 6099 && p.readyPort === 6099, String(after.webuiPort));
  chk('★ hookAutoLoad 不被我们改成 true', after.hookAutoLoad === false);

  /* 文件损坏时不能崩，要能重建成合法 JSON */
  fs.writeFileSync(cfgFile, '{ 这不是 JSON', 'utf8');
  const p3 = await proc.buildStartPayload('snowluma');
  let rebuilt = null;
  try {
    rebuilt = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch (_) {
    rebuilt = null;
  }
  chk('★ runtime.json 损坏时能重建为合法 JSON', rebuilt !== null);
  chk('重建后仍能启动', Boolean(p3));
}

/* =================================================== ③ 发布资产挑选 */
console.log('\n[snowluma] ③ 发布资产挑选（绝不选 lite 包）');
{
  const pick = github.pickSnowLumaAsset;

  /* 官方 v1.14.19 的真实资产列表（照抄自 GitHub API 返回的 name 字段） */
  const real = [
    { name: 'SnowLuma-v1.14.19-linux-arm64-lite.tar.gz' },
    { name: 'SnowLuma-v1.14.19-linux-arm64.tar.gz' },
    { name: 'SnowLuma-v1.14.19-linux-x64-lite.tar.gz' },
    { name: 'SnowLuma-v1.14.19-linux-x64.tar.gz' },
    { name: 'SnowLuma-v1.14.19-win-x64-lite.zip' },
    { name: 'SnowLuma-v1.14.19-win-x64.zip' }
  ];
  const a = pick(real);
  chk('★ 从官方资产里选出 win-x64 完整包', a && a.name === 'SnowLuma-v1.14.19-win-x64.zip', a && a.name);

  chk(
    '★ 只有 lite 包时返回 null（宁可报错也不装 lite）',
    pick([
      { name: 'SnowLuma-v1.0.0-win-x64-lite.zip' },
      { name: 'SnowLuma-v1.0.0-linux-x64-lite.tar.gz' }
    ]) === null
  );

  chk(
    '★ 没有 win 包时不退到 linux 的 tar.gz',
    pick([{ name: 'SnowLuma-v1.0.0-linux-x64.tar.gz' }]) === null
  );

  chk(
    'win 包不带 x64 时仍能选到',
    (pick([{ name: 'SnowLuma-v1.0.0-win.zip' }]) || {}).name === 'SnowLuma-v1.0.0-win.zip'
  );

  chk('空列表返回 null', pick([]) === null);
  chk('非数组入参返回 null', pick(null) === null);

  /* 仓库解析：snowluma 不能掉进 MaiBot 的候选列表 */
  chk('★ REPOS.snowluma 指向官方仓库', constants.REPOS.snowluma === 'SnowLuma/SnowLuma', constants.REPOS.snowluma);
  const src = fs.readFileSync(path.join(ROOT, 'src/main/services/github.js'), 'utf8');
  chk(
    '★ resolveRepo 按 kind 分派候选（snowluma 不会去查 MaiBot）',
    /snowluma:\s*\[REPOS\.snowluma\]/.test(src)
  );
}

/* ======================================== ④ 适配器命名（实测定的，别抄错） */
console.log('\n[snowluma] ④ 适配器目录名与配置版本');
{
  /*
    这组断言守的是一个**很容易抄错**的点：
    社区里流传的 `plugins/snowluma-adapter` + config_version `1.0.0`
    是第三方打包分支；官方插件是 `MaiBot-SnowLuma-Adapter` + `1.0.6`
    （直接读官方源码 snowluma_adapter/settings.py 得到的 SUPPORTED_CONFIG_VERSION）。
    抄错目录名的后果是"接完线连不上，且报错完全指不到原因"。
  */
  const A = constants.ADAPTER;
  chk(
    '★ 适配器目录用官方名 MaiBot-SnowLuma-Adapter',
    A.snowlumaDir === 'plugins/MaiBot-SnowLuma-Adapter',
    A.snowlumaDir
  );
  chk('★ 配置版本用官方 1.0.6', A.snowlumaConfigVersion === '1.0.6', A.snowlumaConfigVersion);
  chk(
    '★ 没有退回第三方分支的 snowluma-adapter / 1.0.0',
    A.snowlumaDir !== 'plugins/snowluma-adapter' && A.snowlumaConfigVersion !== '1.0.0'
  );
  /*
    反向守卫：协议端只剩 SnowLuma 之后，constants.ADAPTER 里不该再有别的
    协议端目录键。留一个就说明没删干净，界面还可能照着它去查一个早已
    不存在的插件目录。
  */
  chk('★ ADAPTER 里没有已废弃的协议端目录键', !('napcatDir' in A), Object.keys(A).join(','));

  /*
    接线必须是"探测 + 指引"，不能变成"偷偷写用户文件"。
    这是与用户的明确约定（向导只做检测和跳转，不改用户文件）。
  */
  const overview = fs.readFileSync(path.join(ROOT, 'src/renderer/views/OverviewPanel.vue'), 'utf8');
  chk('接线自检会真的连端口', /isPortOpen\(onebotPort\)/.test(overview));
  chk('接线自检不做文件写入', !/writeFile|writeJson|fs\.write/i.test(overview.slice(overview.indexOf('checkSnowlumaWiring'), overview.indexOf('checkSnowlumaWiring') + 2000)));
  chk(
    '界面里写明了 SnowLuma OneBot 端口',
    /7988/.test(overview)
  );

  /*
    适配器检测：真的读文件系统。
    这半边是「接线」里启动器**能真正验证**的部分，所以必须测真的目录结构，
    不能只测"函数存在"。
  */
  const envcheck = require(path.join(ROOT, 'src/main/services/envcheck.js'));

  /** 造一个假 MaiBot 目录，plugins 下按需放插件 */
  const mkMaiBot = (name, plugins) => {
    const dir = path.join(userData, name);
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    for (const p of plugins) {
      const pd = path.join(dir, 'plugins', p.name);
      fs.mkdirSync(pd, { recursive: true });
      if (p.manifest) {
        fs.writeFileSync(
          path.join(pd, '_manifest.json'),
          JSON.stringify({ name: p.name, version: p.version || '1.0.0' }),
          'utf8'
        );
      }
    }
    return dir;
  };

  const good = mkMaiBot('mb-official', [
    { name: 'MaiBot-SnowLuma-Adapter', manifest: true, version: '1.2.3' }
  ]);
  const r1 = envcheck.detectAdapter({ dir: good, backend: 'snowluma' });
  chk('★ 认得出官方适配器', r1.found && r1.kind === 'official', r1.name + ' kind=' + r1.kind);
  chk('★ 读得到插件版本', r1.version === '1.2.3', r1.version);
  chk('不会误报 nameMismatch', r1.nameMismatch === false);

  const fork = mkMaiBot('mb-fork', [{ name: 'snowluma-adapter', manifest: true }]);
  const r2 = envcheck.detectAdapter({ dir: fork, backend: 'snowluma' });
  chk('★ 第三方分支被识别为 fork（不是默默当成官方）', r2.found && r2.kind === 'fork', r2.kind);
  chk('★ fork 会被标记 nameMismatch，界面才能提示', r2.nameMismatch === true);

  const none = mkMaiBot('mb-none', [{ name: 'some-other-plugin', manifest: true }]);
  const r3 = envcheck.detectAdapter({ dir: none, backend: 'snowluma' });
  chk('★ 没装适配器 → found=false', r3.found === false);
  chk('★ 同时返回期望目录，界面可以告诉用户该放哪', r3.expectedDir === 'plugins/MaiBot-SnowLuma-Adapter', r3.expectedDir);
  chk('★ 返回期望的配置版本供提示用', r3.expectedConfigVersion === '1.0.6', r3.expectedConfigVersion);

  /* 没有 _manifest.json 的插件 1.2.x 根本不认，必须能区分出来 */
  const noManifest = mkMaiBot('mb-nomanifest', [
    { name: 'MaiBot-SnowLuma-Adapter', manifest: false }
  ]);
  const r4 = envcheck.detectAdapter({ dir: noManifest, backend: 'snowluma' });
  chk('★ 缺 _manifest.json 时 found 仍为 true 但 hasManifest=false', r4.found && r4.hasManifest === false);

  /* 容错：目录不存在 / 空入参不能抛 */
  let threw = false;
  try {
    envcheck.detectAdapter({ dir: path.join(userData, '__没有这个目录__'), backend: 'snowluma' });
  } catch (_) {
    threw = true;
  }
  chk('★ 目录不存在时不抛异常', !threw);
  /*
    没配 MaiBot 目录必须是**可解释的状态**（ok:true + reason），
    不能是 ok:false —— 否则界面会显示"检测失败"，
    而实际原因只是用户还没设置目录，这是可操作的提示，不是故障。
  */
  const rEmpty = envcheck.detectAdapter({});
  chk('★ 没配目录时 ok 仍为 true（是可解释状态而非故障）', rEmpty.ok === true, JSON.stringify(rEmpty.ok));
  chk('★ 没配目录时给出 reason=no-dir', rEmpty.reason === 'no-dir', String(rEmpty.reason));
  chk('★ 没配目录时带可操作提示', typeof rEmpty.message === 'string' && rEmpty.message.length > 0, rEmpty.message);
  chk('★ 没配目录时仍返回期望目录供界面展示', rEmpty.expectedDir === 'plugins/MaiBot-SnowLuma-Adapter');
  chk('★ 没配目录时 found 为 false', rEmpty.found === false);

  /*
    反向守卫：`backend` 参数已经删掉了（协议端只剩一种）。
    传进来也必须被忽略，而且返回值里不该再出现 backend 字段 ——
    否则界面会以为还有第二条协议端路径可选。
  */
  const nc = mkMaiBot('mb-legacy-backend', [{ name: 'snowluma-adapter', manifest: true }]);
  const r5 = envcheck.detectAdapter({ dir: nc, backend: 'napcat' });
  chk('★ 已废弃的 backend 入参被忽略，检测照常走 SnowLuma', r5.ok === true && r5.found === true, r5.name);
  chk('★ 返回值里不再有 backend 字段', !('backend' in r5), Object.keys(r5).join(','));

  /*
    界面上不能出现第三方分支的名字 —— 这个很容易漏。
    实际发生过：设置页那段"SnowLuma OneBot 端口"的说明里写的是
    `snowluma-adapter`，用户照着去装就装成第三方分支了。
    注释里提到那个名字是**故意**的（用来警告别装错），所以只查界面文案：
    把 <code>…</code> 与引号里的名字抓出来看。
  */
  const uiFiles = ['src/renderer/views/SettingsPanel.vue', 'src/renderer/views/OverviewPanel.vue'];
  for (const rel of uiFiles) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    /* <code>snowluma-adapter</code> 这种是给用户看的名字，只允许出现在"警告别混装"的上下文里 */
    const bad = [...txt.matchAll(/<code>(snowluma-adapter)<\/code>/g)];
    const warned = /第三方分支|别混装|不是同一个插件/.test(txt);
    chk(
      `★ ${path.basename(rel)} 里 <code>snowluma-adapter</code> 只出现在警告语境`,
      bad.length === 0 || warned,
      `出现 ${bad.length} 次`
    );
  }
  const sp = fs.readFileSync(path.join(ROOT, 'src/renderer/views/SettingsPanel.vue'), 'utf8');
  /*
    端口说明必须同时说清两件事，否则用户会以为填个数字就完事：
      · 麦麦那边要用的是**官方**插件 MaiBot-SnowLuma-Adapter（不是第三方分支）
      · 插件里的 server / port 必须和这里填的端口一致
    只查"提到了插件名"是不够的 —— 那样文案退化成一句产品介绍也能过。
  */
  chk(
    '★ 设置页端口说明指向官方插件名',
    /MaiBot-SnowLuma-Adapter<\/code>/.test(sp) &&
      /server\s*\/\s*port|端口一致|同一个端口|一致/.test(sp)
  );
}

/* ============================================ ④ 下载源测速与停滞检测 */
console.log('\n[snowluma] ⑤ 下载源测速与停滞检测');
{
  /*
    结构性断言（不发网络请求，所以 CI 里稳定）：
    这两件事都是"不测就一定会退回去"的类型 ——
    它们不影响功能正确性，只影响"等 9 秒还是等 9 分钟"，
    所以任何常规功能测试都发现不了回归。
  */
  const src = fs.readFileSync(path.join(ROOT, 'src/main/services/github.js'), 'utf8');

  chk(
    '★ downloadToFile 下载前会测速并重排候选源',
    /const urls = await orderBySpeed\(/.test(src)
  );
  chk('★ 测速用的是 Range 只取开头一小段', /Range: `bytes=0-\$\{PROBE_BYTES - 1\}`/.test(src));
  chk('★ 测速请求跟随 302（release 会跳到 objects.githubusercontent.com）', /redirect: 'follow'/.test(src));
  chk('★ 停滞超时存在（没有它源卡住就是永久卡死）', /const STALL_TIMEOUT_MS = \d+/.test(src));
  chk('★ 流式下载接入了 abort 信号', /signal: aborter\.signal/.test(src));
  chk(
    '★ 每收到数据就重置停滞计时器（慢但在传的源不能被误杀）',
    /clearTimeout\(stallTimer\);\s*\n\s*stallTimer = setTimeout\(\(\) => aborter\.abort\(\)/.test(src)
  );
  chk('★ 进度里带实测速率（用户才能分清"慢"和"卡"）', /kbps: Math\.round\(received/.test(src));
  chk('★ 超时/停滞会被区分出来并换下一个源', /AbortError/.test(src) && /连接停滞超过/.test(src));
  chk('测速结果有缓存，避免反复测', /PROBE_CACHE_MS/.test(src));

  /* 单源不该触发测速（省掉无谓的等待） */
  const single = await github.orderBySpeed(['https://example.invalid/a.zip'], 'test');
  chk('★ 只有一个候选源时不做测速', single.length === 1 && single[0] === 'https://example.invalid/a.zip');

  /*
    真实测速（可跳过）：用真实 SnowLuma 附件量一下，
    确认"镜像是真的比直连快"这个前提仍然成立 ——
    如果哪天镜像变慢了，orderBySpeed 会自动不用它，但这里能提前发现。
    设置 DSH_SPEED_TEST=1 才跑，避免给 CI 增加网络依赖与耗时。
  */
  if (process.env.DSH_SPEED_TEST === '1') {
    const url =
      'https://github.com/SnowLuma/SnowLuma/releases/download/v1.14.19/SnowLuma-v1.14.19-win-x64.zip';
    const cands = [
      url,
      'https://ghproxy.net/' + url,
      'https://gh-proxy.com/' + url
    ];
    const speeds = await Promise.all(cands.map((u) => github.measureSpeed(u)));
    speeds.forEach((s, i) => {
      console.log(
        `    测速 ${new URL(cands[i]).host} = ${s > 0 ? Math.round(s / 1024) + ' KB/s' : '失败'}`
      );
    });
    const ranked = await github.orderBySpeed(cands, 'verify');
    chk('真实测速至少有一个源可用', speeds.some((s) => s > 0));
    chk(
      '★ 重排后首选确实是实测最快的那个',
      ranked[0] === cands[speeds.indexOf(Math.max(...speeds))]
    );
  } else {
    console.log('    （跳过真实测速；设 DSH_SPEED_TEST=1 可跑）');
  }
}

/* ================================================ ⑤ 设置与预加载通道 */
console.log('\n[snowluma] ⑥ 设置归一化与通道');
{
  settings.resetBackendSettings();
  const d = settings.getBackendSettings().service;
  chk(
    '★ snowlumaPorts 默认 5099 / 7988',
    d.snowlumaPorts.webui === 5099 && d.snowlumaPorts.onebot === 7988,
    JSON.stringify(d.snowlumaPorts)
  );
  chk('snowlumaDir 默认空串', d.snowlumaDir === '');
  /*
    ★ 协议端二选一这件事被整个删掉了（用户要求只用 SnowLuma）。
    `qqBackend` 这个键必须**不存在** —— 留着它，界面就还会有"切到另一个
    协议端"的入口，而那个协议端的代码已经全删了。
  */
  chk('★ 设置里不再有 qqBackend（协议端二选一已废除）', !('qqBackend' in d), Object.keys(d).join(','));
  chk('★ 设置里不再有已废弃的协议端目录/端口键', !('napcatDir' in d) && !('napcat' in (d.ports || {})));
  chk(
    '★ SnowLuma 两个端口与 MaiBot 的端口互不相同（别撞端口）',
    d.snowlumaPorts.webui !== d.ports.maibot &&
      d.snowlumaPorts.onebot !== d.ports.maibot &&
      d.snowlumaPorts.webui !== d.ports.webui &&
      d.snowlumaPorts.onebot !== d.snowlumaPorts.webui,
    JSON.stringify({ snowluma: d.snowlumaPorts, maibot: d.ports })
  );

  /*
    旧配置里残留的协议端键必须被**主动删掉**（而不是留着不管）。
    这是升级路径上的真实场景：用户上一版启动器写过 qqBackend='snowluma'。
  */
  fs.writeFileSync(
    path.join(userData, 'backend-settings.json'),
    JSON.stringify({
      service: {
        qqBackend: 'napcat',
        napcatDir: 'D:\\x\\napcat',
        napcatQuickLogin: true,
        ports: { maibot: 8080, webui: 6099, napcat: 3001 }
      },
      github: { napcatRepo: 'NapNeko/NapCatQQ' }
    }),
    'utf8'
  );
  const migrated = settings.getBackendSettings();
  chk('★ 旧 qqBackend 被删除', !('qqBackend' in migrated.service));
  chk('★ 旧 napcatDir / napcatQuickLogin 被删除',
    !('napcatDir' in migrated.service) && !('napcatQuickLogin' in migrated.service));
  chk('★ 旧 ports.napcat 被删除', !('napcat' in migrated.service.ports));
  chk('★ 旧 github.napcatRepo 被删除', !('napcatRepo' in migrated.github));
  chk('★ 旧 webui 端口 6099 被迁移到 MaiBot 真实默认 8001',
    Number(migrated.service.ports.webui) === 8001, String(migrated.service.ports.webui));
  settings.resetBackendSettings();

  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8');
  chk('预加载暴露 installSnowluma', /installSnowluma:\s*\(opts\)/.test(preload));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'src/main/services/index.js'), 'utf8');
  chk('主进程注册 github:install-snowluma', /github:install-snowluma/.test(indexSrc));
  chk('服务名映射含 SnowLuma', /snowluma:\s*'SnowLuma'/.test(indexSrc));
}

/* ============================ ⑦ 布局：能滚 + 第三个后端不漏 ============ */
console.log('\n[snowluma] ⑦ 布局与"第三个服务"的遗漏点');
{
  /*
    这些断言守的是**用户实际反馈的两个问题**：
      "所有页面无法上下滚动" / "仪表盘太乱了"
    它们共同的特点：页面渲染完全正常，节点长度、文本、主题色全部通过，
    所以只有专门的断言才拦得住。这里用静态契约测试兜住，
    真实几何由 selfcheck 的滚动探针测量（见 windows.js）。
  */

  /* 1) 高度链：.app-root 必须撑满，否则 .shell 的 height:100% 解析不出来 */
  const theme = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/theme.css'), 'utf8');
  chk(
    '★ .app-root 有确定高度（缺了它整条高度链断掉，所有页面都滚不动）',
    /\.app-root\s*\{[^}]*height:\s*100%/s.test(theme),
    'theme.css 里 .app-root 缺少 height:100%'
  );
  chk('★ html/body/#app 高度链仍然完整', /html,\s*body,\s*#app\s*\{[^}]*height:\s*100%/s.test(theme));

  /* 2) 滚动容器存在且允许滚动（不能是 hidden/clip） */
  const layout = fs.readFileSync(path.join(ROOT, 'src/renderer/components/AppLayout.vue'), 'utf8');
  chk('★ .body 是滚动容器', /\.body\s*\{[^}]*overflow-y:\s*auto/s.test(layout));
  chk('★ .body 有 min-height:0（flex 子项默认 min-height:auto 会把容器撑高）', /\.body\s*\{[^}]*min-height:\s*0/s.test(layout));

  /* 3) 面板卡片头部多个元素要有间距（scoped 管不到插槽内容，必须用 :slotted） */
  const panelCard = fs.readFileSync(path.join(ROOT, 'src/renderer/components/ui/PanelCard.vue'), 'utf8');
  chk(
    '★ PanelCard 用 :slotted 处理插槽内多元素间距',
    /:slotted\(/.test(panelCard),
    '插槽里放两个按钮会贴在一起'
  );

  /* 4) 快捷操作必须认得第三个后端，且启动顺序不能再硬编码 */
  const qa = fs.readFileSync(
    path.join(ROOT, 'src/renderer/components/dashboard/QuickActions.vue'),
    'utf8'
  );
  chk('★ QuickActions 的服务名表含 SnowLuma（此前漏了，提示会说成 undefined）', /snowluma:\s*'SnowLuma'/.test(qa));
  chk('★ QuickActions 的目录字段表含 SnowLuma', /snowluma:\s*'SnowLuma 目录'/.test(qa));
  chk('★ QuickActions 不再有"按 qqBackend 推导顺序"的逻辑（二选一已废除）', !/backendOrder|qqBackend/.test(qa));
  /*
    启动/停止顺序必须是写死的常量、且互为逆序。
    理由：SnowLuma 是 OneBot 服务端，麦麦的适配器是 WS 客户端 ——
    麦麦先起来只会刷一屏"连接失败"，用户会误判成装坏了。
    停止时反过来，否则协议端先消失，适配器开始刷重连失败日志。
  */
  chk(
    '★ 启动顺序是 { SnowLuma → MaiBot }（写死常量，不靠运行时推导）',
    /const START_ORDER = \['snowluma', 'maibot'\]/.test(qa)
  );
  chk(
    '★ 停止顺序是启动顺序的逆序 { MaiBot → SnowLuma }',
    /const STOP_ORDER = \['maibot', 'snowluma'\]/.test(qa)
  );
  chk(
    '★ 启动循环遍历 START_ORDER（不再硬编码服务名列表）',
    /for \(const key of START_ORDER\)/.test(qa)
  );

  /* 5) 总览页：协议端只剩 SnowLuma，"切后端"这件事整体废除 */
  const ov = fs.readFileSync(path.join(ROOT, 'src/renderer/views/OverviewPanel.vue'), 'utf8');
  chk(
    '★ 总览页不再有"切换协议端"的入口（二选一已废除）',
    !/switchBackend|showNapcat|qqBackend/.test(ov)
  );
  chk('★ SnowLuma 卡片是无条件展示的（它现在是唯一的协议端）', !/v-if="!showNapcat"/.test(ov));
  /*
    扫描统计必须按新的 type 值计数。这里钉死字符串 `'snowluma'`：
    写回 `'napcat'` 的话数字会永远是 0，而界面照样"渲染正常"。
  */
  chk(
    "★ 扫描统计按 type === 'snowluma' 计数（写成旧协议端名会永远是 0）",
    /type === 'snowluma'/.test(ov)
  );
  /*
    扫描结果必须变成可执行的一步。
    以前"还没装？"的条件是 `!snowluma.running` —— 把"没在运行"当成"没安装"，
    已经装好只是没启动的用户会看到一句假话，然后去重复下载。
  */
  chk('★ "还没装？"不再以"没在运行"为条件', !/v-if="!snowluma\.running"\s*class="sl-hint"/.test(ov));
  chk(
    '★ "还没装？"只在既没配目录、也没扫到时出现',
    /snowlumaMissing/.test(ov) && /const snowlumaMissing = computed/.test(ov) &&
      /!configuredSnowlumaDir\.value && scannedSnowluma\.value\.length === 0/.test(ov)
  );
  chk(
    '★ 扫到的 SnowLuma 能一键指定（而不是只显示个数）',
    /function adoptSnowluma/.test(ov) && /store\.draft\.service\.snowlumaDir = v\.path/.test(ov) &&
      /applySettings\(\)/.test(ov)
  );
  chk(
    '★ 扫到的 SnowLuma 只取有入口文件的那份（runnable !== false）',
    /i\.type === 'snowluma' && i\.runnable !== false/.test(ov)
  );
}

console.log(`\n[snowluma] ${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}  通过=${pass} 失败=${fail}`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
