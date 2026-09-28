/*
================================================================================
回归测试：安装目录扫描（判定精度 + 扫描根 + 版本读取）
================================================================================
  为什么这个测试必须存在：
    扫描的问题是**用户实测报上来的**，而且静态检查一个都发现不了 ——
    eslint、Vue 编译、build、原有 verify 全绿，但扫描出来的 11 条里有 10 条是假的：

      · `Documents\Tencent Files`（里面有个叫 NapCat 的**目录**，只存 data/temp）
        → 报成协议端安装（协议端整体删掉后这条已不可能命中，但夹具保留，
           因为"名字像就当成安装"这个**根因**必须永远防住）
      · 一个只放了几个 txt 的桌面文件夹（里面正好有个 bot_config.toml）
        → 报成 MaiBot 安装
      · zhenxun_bot / AstrBot / MaiBotOneKey（别的框架，只是"像 Python 项目"）
        → 全被报成 MaiBot 安装，版本还是从它们自己的 pyproject.toml 读的

    更糟的是"命中即不下钻"：`...\modules` 这种**容器目录**一旦被误判，
    它里面真正的 MaiBot / SnowLuma 就永远扫不到了 ——
    连启动器自己下载的模块目录都被漏掉。

  所以本测试的重点不是"能扫到东西"，而是：
    ① 真实的三种 MaiBot 形态（0.6.x / 0.11.x / 1.2.x）必须都被认出来，版本必须正确；
    ② 上述每一种误报都必须**扫不到**；
    ③ 容器目录绝不能被判成安装，且不能挡住它里面的真安装。

  全程离线：全部用临时目录里的合成夹具，不碰真实磁盘、不碰网络。
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/*
  打桩顺序很重要：
    · logging.js 会去算日志路径，而 paths.js 依赖 electron 的 app.getPath()，
      纯 Node 下拿不到 → 先把 log 换掉，避免不必要的路径计算。
    · settings.js 的 getBackendSettings 换成可控对象，
      这样扫描根/已知安装目录的各种组合都能在同一个进程里轮流测。
*/
const loggingMod = require(path.join(ROOT, 'src/main/logging.js'));
loggingMod.log = () => {};

const settingsMod = require(path.join(ROOT, 'src/main/services/settings.js'));
let fakeSettings = {};
settingsMod.getBackendSettings = () => fakeSettings;

const scanner = require(path.join(ROOT, 'src/main/services/scanner.js'));
const envcheck = require(path.join(ROOT, 'src/main/services/envcheck.js'));

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

/* ---------------------------------------------------------------- 夹具 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-scan-'));
const FIX = path.join(TMP, 'roots');

/** 写一个文件（自动建父目录） */
function w(rel, content = '') {
  const p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
/** 建一个空目录 */
function d(rel) {
  fs.mkdirSync(path.join(FIX, rel), { recursive: true });
}

const MAIBOT_PYPROJECT = (v) => `[tool.poetry]\nversion = "9.9.9"\n\n[project]\nname = "maibot"\nversion = "${v}"\n`;

/*
  config.py 夹具覆盖三条真实产品线的写法，都照抄上游原样：

    ① 0.6.x   ：is_test / mai_version_main / mai_version_fix 拼装
                （第一版夹具只写了 mai_version_main，漏了 fix，
                  于是把真实的 0.6.3-fix-2 显示成 0.6.3）
    ② 0.7~0.12：MMC_VERSION 直接写字面量
                （实测 `MMC_VERSION = "0.12.2"`；同目录 pyproject 却是脚手架的 0.1.0。
                  上一版去读 pyproject，把 0.12.2 显示成 0.11.6、0.7.0 显示成 0.1.0）
    ③ 1.2.x   ：MMC_VERSION = read_project_version(...) → 真的去读 pyproject
*/
const CONFIG_PY = ({ main = null, fix = null, isTest = false, modern = false, mmc = null } = {}) => {
  if (modern) {
    return `from src.common.version import read_project_version\nCONFIG_VERSION: str = "8.14.40"\nMMC_VERSION: str = read_project_version(PROJECT_ROOT)\n`;
  }
  if (mmc) {
    /* 实测两种写法都出现过：带类型注解和裸赋值各来一种 */
    return mmc === '0.7.0'
      ? `CONFIG_VERSION = "7.3.5"\nMMC_VERSION = "${mmc}"\n`
      : `from typing import Any\nCONFIG_VERSION: str = "8.14.40"\nMMC_VERSION: str = "${mmc}"  # 硬编码的版本信息\n`;
  }
  return [
    '# 考虑到，实际上配置文件中的mai_version是不会自动更新的,所以采用硬编码',
    `is_test = ${isTest ? 'True' : 'False'}`,
    `mai_version_main = "${main}"`,
    `mai_version_fix = ${fix === null ? 'None' : `"${fix}"`}`,
    '',
    'if mai_version_fix:',
    '    if is_test:',
    '        mai_version = f"test-{mai_version_main}-{mai_version_fix}"',
    '    else:',
    '        mai_version = f"{mai_version_main}-{mai_version_fix}"',
    'else:',
    '    if is_test:',
    '        mai_version = f"test-{mai_version_main}"',
    '    else:',
    '        mai_version = mai_version_main',
    ''
  ].join('\n');
};

/*
  ---- 真实形态 ①：0.6.x（版本由 config.py 里三个变量拼出来）----
  这才是用户机器上的实际写法：main="0.6.3" + fix="fix-2" → 真实版本 0.6.3-fix-2。
  只读 main 会显示成 0.6.3，那是错的。
*/
w('real-0.6.3/bot.py');
w('real-0.6.3/src/config/config.py', CONFIG_PY({ main: '0.6.3', fix: 'fix-2' }));
d('real-0.6.3/depends-data');
d('real-0.6.3/template');
/* 关键：0.6.x 的 pyproject 写的是脚手架版本，绝不能被当成产品版本 */
w('real-0.6.3/pyproject.toml', MAIBOT_PYPROJECT('0.1.0'));

/* ---- 真实形态 ①b：0.6.x 的 fix 为空 / is_test 为真时的拼装 ---- */
w('real-0.6.0-nofix/bot.py');
w('real-0.6.0-nofix/src/config/config.py', CONFIG_PY({ main: '0.6.0', fix: '' }));
d('real-0.6.0-nofix/depends-data');

w('real-test-build/bot.py');
w('real-test-build/src/config/config.py', CONFIG_PY({ main: '0.6.3', fix: 'fix-2', isTest: true }));
d('real-test-build/depends-data');

/*
  ---- 真实形态 ②：0.7.x / 0.11.x / 0.12.x ----
  这一线的版本是 config.py 里 **MMC_VERSION 的字面量**，
  但同目录下**也有一份 pyproject.toml，写的是脚手架的 0.1.0**。
  上一版统一去读 pyproject，于是把 0.12.2 显示成 0.11.6、把 0.7.0 显示成 0.1.0。
  用户就是拿这个骂的（"哪来的 0.6？会看版本号吗"）。

  实测原样：C:\...\MaiBotOneKey\modules\MaiBot\src\config\config.py 里
            MMC_VERSION = "0.12.2"
*/
w('real-0.12.2/bot.py');
w('real-0.12.2/src/config/config.py', CONFIG_PY({ mmc: '0.12.2' }));
d('real-0.12.2/depends-data');
d('real-0.12.2/plugins');
/* 关键：这个 pyproject 是脚手架版本，绝不能盖过 MMC_VERSION */
w('real-0.12.2/pyproject.toml', MAIBOT_PYPROJECT('0.1.0'));

/* 另一种写法（无类型注解） + 更老的 0.7.0 */
w('real-0.7.0/bot.py');
w('real-0.7.0/src/config/config.py', CONFIG_PY({ mmc: '0.7.0' }));
d('real-0.7.0/depends-data');
w('real-0.7.0/pyproject.toml', MAIBOT_PYPROJECT('0.1.0'));

/* ---- 真实形态 ③：1.2.x（MMC_VERSION 去 pyproject 取） ---- */
w('real-1.2.4/bot.py');
w('real-1.2.4/src/config/config.py', CONFIG_PY({ modern: true }));
w('real-1.2.4/src/common/version.py', 'def read_project_version():\n    pass\n');
d('real-1.2.4/depends-data');
d('real-1.2.4/plugins');
w('real-1.2.4/pyproject.toml', MAIBOT_PYPROJECT('1.2.4'));

/* ---- 真实形态 ⑤：1.1.x（结构与 1.2.x 完全一样，只是版本低于适配器线） ----
   为什么要单独有这么一个：1.0.x / 1.1.x 的目录结构与 1.2.x **无法区分**
   （都是 config/bot_config.toml + `qq_account`），只按结构判就会被报成 1.2.x，
   用户既看不到真实版本、也拿不到任何版本不足提示。它同时钉住两条线：
     · 启动器准入线 ≥1.0.0  → supported（不能因为适配器要 1.2.0 就判死）
     · SnowLuma 适配器线 ≥1.2.0 → 必须有明确提示（envcheck 负责说话）
*/
w('real-1.1.4/bot.py');
w('real-1.1.4/src/config/config.py', CONFIG_PY({ modern: true }));
w('real-1.1.4/src/common/version.py', 'def read_project_version():\n    pass\n');
d('real-1.1.4/depends-data');
d('real-1.1.4/plugins');
w('real-1.1.4/pyproject.toml', MAIBOT_PYPROJECT('1.1.4'));
w('real-1.1.4/config/bot_config.toml', '[bot]\nqq_account = "123456789"\nnickname = "麦麦"\n');

/* ---- 真实形态 ④：读不到版本号的 MaiBot（绝不能被"1.0.0 以上"这条规则误杀） ---- */
w('real-noversion/bot.py');
w('real-noversion/src/config/config.py', 'CONFIG_VERSION = "1.0.0"\n# 既没有 MMC_VERSION 也没有 mai_version_main\n');
d('real-noversion/depends-data');

/* ---- 误报 ①：zhenxun_bot（另一个框架：bot.py + requirements + pyproject，但没有 src/） ---- */
w('fake-zhenxun/bot.py');
w('fake-zhenxun/requirements.txt');
w('fake-zhenxun/pyproject.toml', MAIBOT_PYPROJECT('0.2.4'));
d('fake-zhenxun/zhenxun');

/* ---- 误报 ②：AstrBot 的 backend/app（main.py + requirements，没有 bot.py） ---- */
w('fake-astrbot/main.py');
w('fake-astrbot/requirements.txt');
d('fake-astrbot/astrbot');

/* ---- 误报 ③：只有配置和 txt 的文件夹 ---- */
w('fake-txt/bot_config.toml', '[bot]\nqq = 123\n');
w('fake-txt/新建文本文档.txt', 'hello');
w('fake-txt/麦麦默认人格.txt', 'persona');

/* ---- 误报 ④：OneKey 启动器本身（main.py + requirements） ---- */
w('fake-onekey/main.py');
w('fake-onekey/requirements.txt');

/*
  ---- 误报 ⑤：只有一个 package.json 的普通 Node 项目 ----
  SnowLuma 的判据就是 package.json 里的官方包名，所以这里专门造一个
  "有 package.json 但不是 SnowLuma"的目录，确保判据不是"有 package.json 就算"。
*/
w('fake-node-project/package.json', '{"name":"some-other-tool","version":"9.9.9"}');
w('fake-node-project/index.mjs');
d('fake-node-project/native');
d('fake-node-project/client');
w('fake-node-project/node.exe');

/* ---- 误报 ⑥：有 src/ 但没有 bot.py ---- */
w('fake-noentry/src/config/config.py', CONFIG_PY({ modern: true }));
d('fake-noentry/depends-data');

/* ---- 误报 ⑦：有 bot.py 但没有 src/ ----
   注意不能靠"写 src/config/config.py 来制造 src/"—— 那样反而会把 src/ 建出来，
   夹具就测不到"缺 src/"这件事了（第一版就是这么错的）。 */
w('fake-nosrc/bot.py');
d('fake-nosrc/depends-data');
w('fake-nosrc/pyproject.toml', MAIBOT_PYPROJECT('1.2.0'));

/* ---- 真 SnowLuma ①：官方运行时（package.json 里是 @snowluma/runtime） ---- */
w(
  'real-snowluma/package.json',
  JSON.stringify({ name: '@snowluma/runtime', version: '1.14.19', main: 'index.mjs' }, null, 2)
);
w('real-snowluma/index.mjs');
w('real-snowluma/node.exe');
w('real-snowluma/launcher.bat');
w('real-snowluma/EULA.md');
d('real-snowluma/native');
d('real-snowluma/client');
d('real-snowluma/config');

/*
  ---- 容器目录（最要命的那条）----
  `modules` 本身不是任何东西的安装，它只是装了几个模块。
  旧实现因为里面有个同名子目录就把 `modules` 判成安装，
  然后"命中即不下钻"，把下面真正的安装全挡住了。
*/
w('container/modules/maibot/bot.py');
w('container/modules/maibot/src/config/config.py', CONFIG_PY({ modern: true }));
d('container/modules/maibot/depends-data');
w('container/modules/maibot/pyproject.toml', MAIBOT_PYPROJECT('1.2.9'));
w(
  'container/modules/snowluma/package.json',
  JSON.stringify({ name: '@snowluma/runtime', version: '1.14.19' }, null, 2)
);
w('container/modules/snowluma/index.mjs');
d('container/data');

/* ---------------------------------------------------------------- 跑扫描 */
console.log('\n════ 扫描（合成夹具，离线）');
const res = await scanner.scanInstallations({ roots: [FIX] });
chk('扫描成功返回', res.ok === true);
chk('扫描结果带 rootsUsed（界面能解释扫了哪）', Array.isArray(res.rootsUsed) && res.rootsUsed.length === 1);
chk('扫描结果带 knownRoots 字段', Array.isArray(res.knownRoots));

/** 相对路径（小写、统一分隔符）→ 命中条目 */
const hits = new Map();
for (const i of res.installations) {
  hits.set(path.relative(FIX, i.path).replace(/\\/g, '/').toLowerCase(), i);
}
const has = (rel) => hits.has(rel.toLowerCase());
const get = (rel) => hits.get(rel.toLowerCase());

/**
 * 直接在夹具目录上跑判定原件（不经过扫描流程）。
 * 为什么要单独有这么一个：扫描结果现在**只保留 1.0.0 以上**的 MaiBot，
 * 而"能不能认出 0.6.x"和"版本号读得对不对"跟这条过滤规则是两件事。
 * 拿扫描结果去测 0.x 的识别能力会被过滤掉，测不到东西。
 */
const inspect = (rel) => {
  const dir = path.join(FIX, rel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return scanner.inspectDir(dir, entries);
};

/* ============================================ A. 真实安装必须都被认出来 */
console.log('\n════ A. 真实的 MaiBot 形态');
chk('① 0.6.x 被认出来', inspect('real-0.6.3')?.type === 'maibot');
/*
  这一条是最关键的断言之一。
  用户机器上写的是 main="0.6.3" + fix="fix-2"，MaiBot 自己拼出来的是 0.6.3-fix-2。
  第一版只读了 mai_version_main，界面上显示成 "0.6.3" —— 少了一截。
*/
chk(
  '① 0.6.x 版本 = 0.6.3-fix-2（fix 后缀不能丢）',
  inspect('real-0.6.3')?.version === '0.6.3-fix-2',
  `实际=${JSON.stringify(inspect('real-0.6.3')?.version)}`
);
chk('① 0.6.x 版本不是被截断的 0.6.3', inspect('real-0.6.3')?.version !== '0.6.3');
chk('① 0.6.x 版本不是 pyproject 里的脚手架版本 0.1.0', inspect('real-0.6.3')?.version !== '0.1.0');
chk('① 版本来源标注为 config.py 的 mai_version 拼装', /config\.py/.test(inspect('real-0.6.3')?.versionSource || ''));
chk('① 0.6.x 被判为低于支持范围', inspect('real-0.6.3')?.supported === 'unsupported');
chk('① 入口 = bot.py', inspect('real-0.6.3')?.entry === 'bot.py');
chk('① 带判定依据（能解释为什么说它是 MaiBot）', Boolean(inspect('real-0.6.3')?.evidence));

/* 拼装逻辑的另外两条分支也必须照上游走 */
chk(
  '①b fix 为空 → 版本就是 main（不能拖一个多余的横杠）',
  inspect('real-0.6.0-nofix')?.version === '0.6.0',
  `实际=${JSON.stringify(inspect('real-0.6.0-nofix')?.version)}`
);
chk(
  '①c is_test=True → 版本带 test- 前缀',
  inspect('real-test-build')?.version === 'test-0.6.3-fix-2',
  `实际=${JSON.stringify(inspect('real-test-build')?.version)}`
);
chk('①c test- 开头的版本也能判出受支持程度（unsupported）', inspect('real-test-build')?.supported === 'unsupported');

/*
  ② 这一组是"会看版本号吗"那一轮的核心：
  0.7~0.12 线的版本在 config.py 的 MMC_VERSION 里，
  而同目录的 pyproject.toml 是脚手架版本 0.1.0 —— 绝不能读成 0.1.0。
  用户机器上就有 `MMC_VERSION = "0.12.2"`，上一版被读成了 0.11.6（pyproject 的值）。
*/
chk('② 0.12.x 被认出来', inspect('real-0.12.2')?.type === 'maibot');
chk(
  '② 版本 = 0.12.2（读 config.py 的 MMC_VERSION，不是 pyproject）',
  inspect('real-0.12.2')?.version === '0.12.2',
  `实际=${JSON.stringify(inspect('real-0.12.2')?.version)}`
);
chk('② 版本不是脚手架版本 0.1.0', inspect('real-0.12.2')?.version !== '0.1.0');
chk('② 版本不是 pyproject 里的别的数字', inspect('real-0.12.2')?.version !== '9.9.9');
chk('② 来源标注为 MMC_VERSION', /MMC_VERSION/.test(inspect('real-0.12.2')?.versionSource || ''), inspect('real-0.12.2')?.versionSource);
chk('② 0.12.2 被判为低于支持范围', inspect('real-0.12.2')?.supported === 'unsupported');

chk(
  '②b 裸赋值写法（无类型注解）也能读对 → 0.7.0',
  inspect('real-0.7.0')?.version === '0.7.0',
  `实际=${JSON.stringify(inspect('real-0.7.0')?.version)}`
);

chk('③ 1.2.4 被认出来', inspect('real-1.2.4')?.type === 'maibot');
chk('③ 1.2.4 版本 = 1.2.4', inspect('real-1.2.4')?.version === '1.2.4', `实际=${JSON.stringify(inspect('real-1.2.4')?.version)}`);
chk('③ 版本取自 [project] 而不是 [tool.poetry]（节作用域）', inspect('real-1.2.4')?.version !== '9.9.9');
chk('③ 1.2.4 受支持', inspect('real-1.2.4')?.supported === 'supported');

/* ================================ A3. 两条版本线（别混） ================================
   这一节同时钉住两件事，缺一不可：
     1) 启动器准入线 = ≥1.0.0：1.1.4 必须判 supported（scanner 侧，用户死规矩）
     2) 适配器线 = ≥1.2.0：1.1.4 必须拿到"低于适配器要求"的明确提示（envcheck 侧）
   只钉第 2 条会退回到"把适配器线当准入线"的老错误；只钉第 1 条则会让
   1.1.x 用户拿到一个"1.2.x"的假版本号 + 零提示 —— 两条都要有断言。
*/
console.log('\n════ A3. 版本线：准入线 ≥1.0.0 / 适配器线 ≥1.2.0');
chk('⑤ 1.1.4 被认出来', inspect('real-1.1.4')?.type === 'maibot');
chk(
  '⑤ 1.1.4 版本 = 1.1.4（不是被结构判成 1.2.x）',
  inspect('real-1.1.4')?.version === '1.1.4',
  `实际=${JSON.stringify(inspect('real-1.1.4')?.version)}`
);
chk('⑤ 1.1.4 仍判 supported（准入线是 ≥1.0.0，不因适配器线抬高）', inspect('real-1.1.4')?.supported === 'supported');
const v114 = envcheck.detectMaiBotVersion(path.join(FIX, 'real-1.1.4'));
chk('⑤ 版本如实报 1.1.4（不再一律写死 1.2.x）', v114.version === '1.1.4', `实际=${JSON.stringify(v114.version)}`);
chk('⑤ 标出 belowAdapterLine=true', v114.belowAdapterLine === true, String(v114.belowAdapterLine));
chk('⑤ kind 仍是 supported（能启动）', v114.kind === 'supported', v114.kind);
chk('⑤ 提示里点名适配器线 1.2.0', /1\.2\.0/.test(v114.message || ''), (v114.message || '').slice(0, 60));
/*
  适配器线的另一侧：同构目录、版本 = 1.2.4，必须**不再**报"低于适配器线"。
  刻意建在 FIX 之外（临时目录）：它是一条判定用例，不是"被扫描到的真实安装"，
  放进 FIX 会改变上面那条"夹具命中数正好 = N"的计数。
*/
const tmp124 = fs.mkdtempSync(path.join(os.tmpdir(), 'mbv-124-'));
for (const p of ['config', 'src/config', 'src/common', 'plugins']) {
  fs.mkdirSync(path.join(tmp124, p), { recursive: true });
}
fs.writeFileSync(path.join(tmp124, 'bot.py'), '');
fs.writeFileSync(path.join(tmp124, 'src', 'config', 'config.py'), CONFIG_PY({ modern: true }));
fs.writeFileSync(path.join(tmp124, 'src', 'common', 'version.py'), 'def read_project_version():\n    pass\n');
fs.writeFileSync(path.join(tmp124, 'pyproject.toml'), MAIBOT_PYPROJECT('1.2.4'));
fs.writeFileSync(path.join(tmp124, 'config', 'bot_config.toml'), '[bot]\nqq_account = "123456789"\n');
const v124 = envcheck.detectMaiBotVersion(tmp124);
chk('⑤ 1.2.4 不再报低于适配器线', v124.belowAdapterLine === false, String(v124.belowAdapterLine));
chk('⑤ 1.2.4 版本如实报 1.2.4', v124.version === '1.2.4', `实际=${JSON.stringify(v124.version)}`);

chk(
  '所有真实安装都带运行入口（runnable）',
  ['real-0.6.3', 'real-0.6.0-nofix', 'real-test-build', 'real-0.12.2', 'real-0.7.0', 'real-1.2.4'].every(
    (k) => inspect(k)?.entry === 'bot.py'
  )
);

/* ============================================ A2. 只保留 1.0.0 以上 */
console.log('\n════ A2. 用户要求：只扫 1.0.0 以上的 MaiBot');
chk('低于 1.0.0 的 0.6.3 不出现在扫描结果里', !has('real-0.6.3'));
chk('低于 1.0.0 的 0.6.0 不出现在扫描结果里', !has('real-0.6.0-nofix'));
chk('低于 1.0.0 的 test- 构建不出现在扫描结果里', !has('real-test-build'));
chk('低于 1.0.0 的 0.12.2 不出现在扫描结果里', !has('real-0.12.2'));
chk('低于 1.0.0 的 0.7.0 不出现在扫描结果里', !has('real-0.7.0'));
chk('1.2.4 仍然正常出现', has('real-1.2.4'));
/*
  读不到版本 != 版本太旧。不能因为"没读出来"就把它过滤掉，
  否则一个 pyproject 没写全的 1.2.x 安装会凭空消失，而且是无声消失。
*/
chk('版本读不到的 MaiBot 不被过滤（不误杀）', has('real-noversion'), `version=${JSON.stringify(get('real-noversion')?.version)}`);
chk('版本读不到时 version 是空串（不瞎猜一个数字）', get('real-noversion')?.version === '');
chk('被隐藏的旧版本数量被如实返回（不静默丢弃）', res.hiddenOldCount === 5, `实际=${res.hiddenOldCount}`);
/*
  过滤只针对 MaiBot。SnowLuma 是独立产品（版本线不一样），
  拿"1.0.0 以上"去卡它是错的。
*/
chk(
  'SnowLuma 不受"1.0.0 以上"这条规则影响（版本线不同）',
  res.installations.filter((i) => i.type === 'snowluma').length === 2,
  `实际=${res.installations.filter((i) => i.type === 'snowluma').length}`
);
/* 读不到版本的不许被误杀 */
chk('isBelowMinVersion 对读不到的版本返回 false（不误杀）', scanner.isBelowMinVersion('') === false && scanner.isBelowMinVersion(undefined) === false && scanner.isBelowMinVersion('abc') === false);
chk('isBelowMinVersion("0.12.2") = true', scanner.isBelowMinVersion('0.12.2') === true);
chk('isBelowMinVersion("0.6.3-fix-2") = true', scanner.isBelowMinVersion('0.6.3-fix-2') === true);
chk('isBelowMinVersion("test-0.6.3-fix-2") = true', scanner.isBelowMinVersion('test-0.6.3-fix-2') === true);
chk('isBelowMinVersion("1.0.0") = false（边界：1.0.0 本身要保留）', scanner.isBelowMinVersion('1.0.0') === false);
chk('isBelowMinVersion("1.0.11") = false', scanner.isBelowMinVersion('1.0.11') === false);
chk('isBelowMinVersion("1.2.5") = false', scanner.isBelowMinVersion('1.2.5') === false);
chk('isBelowMinVersion("2.0.0") = false', scanner.isBelowMinVersion('2.0.0') === false);
chk('阈值就是 1（1.0.0）', scanner.MIN_MAIBOT_MAJOR === 1);

/* ============================================ B. 误报必须全部消失 */
console.log('\n════ B. 用户实测报上来的误报，一条都不许再出现');
const falsePositives = [
  ['fake-zhenxun', 'zhenxun_bot（别的框架：bot.py + requirements + pyproject，无 src/）'],
  ['fake-astrbot', 'AstrBot backend/app（main.py + requirements）'],
  ['fake-txt', '只有 bot_config.toml 和几个 txt 的文件夹'],
  ['fake-onekey', 'MaiBotOneKey 启动器本身'],
  ['fake-node-project', '普通 Node 项目（有 package.json + index.mjs + native/ + client/，但不是 SnowLuma）'],
  ['fake-noentry', '有 src/ 和 config.py 但没有 bot.py'],
  ['fake-nosrc', '有 bot.py 但没有 src/']
];
for (const [rel, desc] of falsePositives) {
  chk(`扫不到：${desc}`, !has(rel));
}

/*
  ---- 这台机器上真实存在的"别的机器人框架"，必须逐一证明不被误判 ----
  用户明确说过："还有 astrbot 和 zhenxunbot 你也扫进去了？？？我要的是 maibot"。
  所以不只测合成夹具，直接把**真实路径**钉进来：
  只要哪天判定逻辑一放松，这几条断言就会先炸，而不是等用户再发现一次。
  目录不存在时跳过（换台机器跑测试不该因此失败）。
*/
console.log('\n════ B2. 真实磁盘上的其他框架（存在就必须判成 unknown）');
const otherFrameworks = [
  ['C:\\Users\\LittleSun-Sam\\Desktop\\zhenxun_bot-2026', 'zhenxun_bot'],
  ['C:\\Users\\LittleSun-Sam\\AppData\\Local\\AstrBot', 'AstrBot 根目录'],
  ['C:\\Users\\LittleSun-Sam\\AppData\\Local\\AstrBot\\backend\\app', 'AstrBot backend/app'],
  ['D:\\所有文件夹\\LangBot-master\\LangBot-master', 'LangBot']
];
for (const [dir, desc] of otherFrameworks) {
  if (!fs.existsSync(dir)) {
    console.log(`  · 跳过（本机没有）：${desc}`);
    continue;
  }
  const kind = envcheck.detectDirKind(dir);
  chk(`${desc} 必须判成 unknown（不是 MaiBot）`, kind.kind === 'unknown', `实际 kind=${kind.kind}`);
  chk(`${desc} 的提示里不能说它是 MaiBot`, !/MaiBot|麦麦/.test(kind.message) || /既不是/.test(kind.message), kind.message);
}

/* 已经扫出来的结果里，一条都不许是别的框架 */
chk(
  '扫描结果里没有任何别的机器人框架（astr/zhenxun/langbot/onebot 字样）',
  !res.installations.some((i) => /astr|zhenxun|langbot/i.test(i.path)),
  res.installations.map((i) => i.path).join(' | ')
);
chk(
  '扫描结果里只有 maibot 和 snowluma 两种类型',
  res.installations.every((i) => i.type === 'maibot' || i.type === 'snowluma'),
  [...new Set(res.installations.map((i) => i.type))].join(',')
);

/* ============================================ C. 容器不许挡住里面的真安装 */
console.log('\n════ C. 容器目录（旧实现在这里把真安装全挡住了）');
chk('容器 `modules` 本身不被判成安装', !has('container/modules'));
chk('容器上层 `container` 也不被误判', !has('container'));
chk('容器里的真 MaiBot 被找到', get('container/modules/maibot')?.type === 'maibot');
chk('容器里的真 MaiBot 版本正确 = 1.2.9', get('container/modules/maibot')?.version === '1.2.9');
chk('容器里的真 SnowLuma 被找到', get('container/modules/snowluma')?.type === 'snowluma');
chk(
  '整个夹具里命中数正好 = 6（4 真 MaiBot[1.1.4 / 1.2.4 / 无版本 / 容器内 1.2.9] + 2 真 SnowLuma）',
  res.installations.length === 6,
  `实际=${res.installations.length}`
);

/* ============================================ D. SnowLuma 判定 */
console.log('\n════ D. SnowLuma 判定（只认官方包名，不靠"看着像"）');
chk('官方运行时被认出来', get('real-snowluma')?.type === 'snowluma');
chk('版本取自 package.json 的 version = 1.14.19', get('real-snowluma')?.version === '1.14.19', `实际=${JSON.stringify(get('real-snowluma')?.version)}`);
chk('版本来源标注为 package.json', /package\.json/.test(get('real-snowluma')?.versionSource || ''), get('real-snowluma')?.versionSource);
chk('入口 = index.mjs', get('real-snowluma')?.entry === 'index.mjs');
chk('判定依据能说清为什么', /@snowluma\/runtime/.test(get('real-snowluma')?.evidence || ''), get('real-snowluma')?.evidence);
/*
  SnowLuma 是独立产品，不该套 MaiBot 的"≥1.0.0 才算受支持"这条线。
  它的 supported 固定为 unknown（界面上不显示"需重装"）。
*/
chk('SnowLuma 不套 MaiBot 的版本支持线（supported = unknown）', get('real-snowluma')?.supported === 'unknown');
chk('容器里的 SnowLuma 版本也对', get('container/modules/snowluma')?.version === '1.14.19');

/* ============================================ E. 纯函数与反向保护 */
console.log('\n════ E. 判定函数本身');
const cv = scanner.classifyVersion;
chk('classifyVersion("0.6.3") = unsupported', cv('0.6.3') === 'unsupported');
chk('classifyVersion("0.6.3-fix-2") = unsupported（带后缀也要判得出来）', cv('0.6.3-fix-2') === 'unsupported');
chk('classifyVersion("test-0.6.3-fix-2") = unsupported（test- 前缀不影响判定）', cv('test-0.6.3-fix-2') === 'unsupported');
chk('classifyVersion("0.11.6") = unsupported', cv('0.11.6') === 'unsupported');
chk('classifyVersion("0.12.2") = unsupported', cv('0.12.2') === 'unsupported');
/*
  用户死规矩（原话）："启动器只能启动1.0.0以上 记住几死"。
  准入线就是主版本 >= 1 —— 所以 1.0.0 / 1.1.x 必须判为 supported。
  这里以前断言的恰恰相反（unsupported），那是"适配器要 1.2.x"那条线，
  被错当成了启动器的准入线。
*/
chk('classifyVersion("1.0.0") = supported（准入线是 ≥1.0.0）', cv('1.0.0') === 'supported');
chk('classifyVersion("1.1.0") = supported', cv('1.1.0') === 'supported');
/*
  加固：**不许**把准入线抬到适配器线（1.2.0）。
  曾经有人这么改过（minor >= 2），理由是"适配器要 1.2.x"，结果 1.0/1.1 被
  直接隐藏、连解释都没有。适配器线由 envcheck 单独说话（见 A3 一节），
  准入线只看主版本 —— 这条断言就是防止那次回退重演。
*/
chk('classifyVersion("1.1.9") = supported（准入线不因适配器线抬高）', cv('1.1.9') === 'supported');
chk('classifyVersion("1.2.0") = supported', cv('1.2.0') === 'supported');
chk('classifyVersion("1.2.4") = supported', cv('1.2.4') === 'supported');
chk('classifyVersion("v1.3.0") = supported（前缀 v 也要认）', cv('v1.3.0') === 'supported');
chk('classifyVersion("2.0.0") = supported（不武断判死未来主版本）', cv('2.0.0') === 'supported');
chk('classifyVersion("") = unknown', cv('') === 'unknown');
chk('classifyVersion("abc") = unknown', cv('abc') === 'unknown');
chk('classifyVersion(undefined) = unknown', cv(undefined) === 'unknown');

/*
  反向保护：detectType 以前接受"一堆名字的集合"。
  仅凭名字无法区分"这里是 SnowLuma 安装"和"这里有个叫 snowluma 的子文件夹"，
  而那正是误报的根源 —— 所以现在这种调用必须**返回 null**，
  否则以后有人图省事再传名字集合，误报会立刻回来。
*/
chk(
  'detectType(名字集合) 必须返回 null（不再凭名字猜）',
  scanner.detectType(new Set(['snowluma', 'bot.py', 'requirements.txt'])) === null
);

/* 直接钉住版本拼装本身，不经过扫描流程 */
const rv = scanner.readMaiBotVersion(path.join(FIX, 'real-0.6.3'));
chk('readMaiBotVersion 复刻上游拼装 → 0.6.3-fix-2', rv.version === '0.6.3-fix-2', `实际=${JSON.stringify(rv.version)}`);
chk('readMaiBotVersion 能看出值来自 config.py', /config\.py/.test(rv.source));
const rvMmc = scanner.readMaiBotVersion(path.join(FIX, 'real-0.12.2'));
chk('readMaiBotVersion 0.12.x → 0.12.2（走 MMC_VERSION）', rvMmc.version === '0.12.2', `实际=${JSON.stringify(rvMmc.version)}`);
chk('readMaiBotVersion 能看出值来自 MMC_VERSION', /MMC_VERSION/.test(rvMmc.source));
const rvModern = scanner.readMaiBotVersion(path.join(FIX, 'real-1.2.4'));
chk('readMaiBotVersion 1.2.x → 1.2.4（走 pyproject）', rvModern.version === '1.2.4', `实际=${JSON.stringify(rvModern.version)}`);
chk('readMaiBotVersion 1.2.x 的来源标成 pyproject', /pyproject/.test(rvModern.source), rvModern.source);
chk('readMaiBotVersion 对不存在的目录不抛异常', scanner.readMaiBotVersion(path.join(TMP, 'nope')).version === '');
chk('detectType(目录路径) 能正常判定', scanner.detectType(path.join(FIX, 'real-snowluma')) === 'snowluma');
chk('detectType(不存在的目录) = null', scanner.detectType(path.join(TMP, 'no-such-dir')) === null);
chk('detectType 对空字符串 = null', scanner.detectType('') === null);

console.log('\n════ F. envcheck.detectDirKind 复用同一套判定');
const k1 = envcheck.detectDirKind(path.join(FIX, 'real-0.6.3'));
chk('真实 0.6.x → kind=maibot', k1.kind === 'maibot');
chk('真实 0.6.x → 带完整版本号 0.6.3-fix-2', k1.version === '0.6.3-fix-2', `实际=${JSON.stringify(k1.version)}`);
chk('真实 0.6.x → 提示里出现完整版本号', k1.message.includes('0.6.3-fix-2'), k1.message);
chk('真实 0.6.x → 明确提示低于最低支持版本 1.0.0', /1\.0\.0/.test(k1.message));
chk('真实 0.6.x → supported=unsupported', k1.supported === 'unsupported');
const k2 = envcheck.detectDirKind(path.join(FIX, 'real-snowluma'));
chk('真实 SnowLuma → kind=snowluma', k2.kind === 'snowluma', k2.message);
chk('真实 SnowLuma → 提示里带版本号 1.14.19', k2.message.includes('1.14.19'), k2.message);
chk('真实 SnowLuma → 提示里说它是 SnowLuma', /SnowLuma/.test(k2.message), k2.message);
chk('真实 SnowLuma → 提示里不提"需重装"（不套 MaiBot 的版本线）', !/重装/.test(k2.message), k2.message);
const k3 = envcheck.detectDirKind(path.join(FIX, 'fake-txt'));
chk('只有 txt 的文件夹 → unknown', k3.kind === 'unknown');
chk('unknown 的提示同时提到 MaiBot 和 SnowLuma 两个名字', /MaiBot/.test(k3.message) && /SnowLuma/.test(k3.message), k3.message);
const k4 = envcheck.detectDirKind(path.join(FIX, 'real-1.2.4'));
chk('真实 1.2.4 → kind=maibot 且 supported=supported', k4.kind === 'maibot' && k4.supported === 'supported');
chk('不存在的目录 → ok:false 而不是抛异常', envcheck.detectDirKind(path.join(TMP, 'nope')).ok === false);

/* ============================================ G. 扫描根 */
console.log('\n════ G. 扫描根（用户配的目录必须真的被扫到）');
const existingDir = path.join(FIX, 'real-1.2.4');
const missingDir = path.join(TMP, 'gone');

fakeSettings = { service: { maibotDir: existingDir, snowlumaDir: missingDir } };
const known = scanner.knownRoots();
chk('knownRoots 收进存在的已配置目录', known.includes(path.resolve(existingDir)));
chk('knownRoots 跳过不存在的目录（不报错）', !known.some((p) => p.toLowerCase() === missingDir.toLowerCase()));

fakeSettings = {};
const rDefault = scanner.resolveRoots();
chk('无自定义扫描根 → source=defaults', rDefault.source === 'defaults');
chk('无自定义扫描根 → 仍用系统默认根', rDefault.roots.length > 0);
/*
  这条断言原来是反的（"默认根里不含裸盘符"）。
  那是在"怕慢"的前提下定的，结果被实测推翻：
  用户十几个麦麦里有一半装在 D:/E: 上，不扫盘就是真的扫不到，
  他会直接问"会扫盘吗"。所以现在必须**包含**盘符根。
*/
chk(
  '默认根包含盘符根（不扫盘就扫不到装在别的盘的安装）',
  rDefault.roots.some((p) => /^[a-z]:\\?$/i.test(p)),
  rDefault.roots.join(' | ')
);
/*
  深路径必须排在盘符根前面：万一撞上 maxDirs 上限，
  被截断的应该只是兜底的盘符根，而不是这些真正装着麦麦的位置。
  而且不能因为"父目录已覆盖"就把它们去掉 —— 深度是从根算起的，
  %APPDATA%\MaiBotOneKeyDesktop\<hash>\modules\MaiBot 从 C:\ 算是 8 层，够不到。
*/
const appdataIdx = rDefault.roots.findIndex((p) => /appdata/i.test(p));
const driveIdx = rDefault.roots.findIndex((p) => /^[a-z]:\\?$/i.test(p));
chk('深路径排在盘符根之前（优先保证够得到）', appdataIdx >= 0 && driveIdx > appdataIdx, `appdata=${appdataIdx} drive=${driveIdx}`);
chk(
  'AppData 根没有被"父目录已覆盖"剔除掉（剔除就够不到了）',
  rDefault.roots.some((p) => /appdata\\roaming$/i.test(p)) && rDefault.roots.some((p) => /appdata\\local$/i.test(p)),
  rDefault.roots.join(' | ')
);

fakeSettings = { service: { maibotDir: existingDir }, general: { scanRoots: [FIX] } };
const rSettings = scanner.resolveRoots();
chk('有自定义扫描根 → source=settings', rSettings.source === 'settings');
chk('自定义扫描根被采用', rSettings.roots.some((p) => p.toLowerCase() === FIX.toLowerCase()));
chk('已知安装目录排在扫描根最前面（命中率最高的优先）', rSettings.roots[0].toLowerCase() === path.resolve(existingDir).toLowerCase());
chk('返回 knownRoots 供界面说明"你配的目录也扫了"', Array.isArray(rSettings.knownRoots) && rSettings.knownRoots.length === 1);
/*
  这一条是实测踩出来的：原实现"有自定义根就只扫自定义根"，
  用户加一个 D 盘的根之后，家目录那一堆全都不扫了 ——
  原来能扫到的另外几个安装凭空消失（扫描目录数 3691 → 10）。
  自定义根必须是**追加**，不是替换。
*/
chk(
  '自定义扫描根是追加，不是替换（默认根仍在）',
  rSettings.roots.length > 1 && scanner.defaultRoots().every((d) => rSettings.roots.some((p) => p.toLowerCase() === d.toLowerCase())),
  `共 ${rSettings.roots.length} 个根`
);

fakeSettings = { service: { maibotDir: existingDir }, general: { scanRoots: [missingDir] } };
const rFallback = scanner.resolveRoots();
chk('自定义扫描根全部失效 → 退回默认根（扫描不会变成"什么都不扫"）', rFallback.source === 'defaults' && rFallback.roots.length > 0);
chk('失效的扫描根被记录在 skipped 里（不静默丢弃）', rFallback.skipped.length === 1 && rFallback.skipped[0] === missingDir);
chk('退回时已知安装目录仍然在', rFallback.roots.some((p) => p.toLowerCase() === path.resolve(existingDir).toLowerCase()));

/* 自定义根全部失效但仍标 source=settings 时，默认根也不能丢 */
fakeSettings = { service: {}, general: { scanRoots: [missingDir, path.join(TMP, 'also-gone')] } };
const rAllGone = scanner.resolveRoots();
chk('自定义根全失效 → skipped 记录 2 条', rAllGone.skipped.length === 2);
chk('自定义根全失效 → 仍然扫默认根', rAllGone.roots.length > 0 && scanner.defaultRoots().every((d) => rAllGone.roots.some((p) => p.toLowerCase() === d.toLowerCase())));

fakeSettings = {};
const rExplicit = scanner.resolveRoots([FIX]);
chk('显式传入扫描根时完全照办（不掺入其他根）', rExplicit.source === 'explicit' && rExplicit.roots.length === 1);

console.log('\n════ H. 其他');
chk('取消一个不存在的扫描：ok:false 且带说明（不是静默失败）', (() => {
  const r = scanner.cancelScan('nope');
  return r.ok === false && Boolean(r.message);
})());
chk('defaultRoots 返回的都是真实存在的目录', scanner.defaultRoots().every((p) => fs.existsSync(p)));

/* ---------------------------------------------------------------- 收尾 */
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {
  /* 临时目录清不掉不影响结论 */
}

console.log(`\n════════════════════════════════════════`);
console.log(`  scan: 通过=${pass} 失败=${fail}`);
process.exit(fail ? 1 : 0);
