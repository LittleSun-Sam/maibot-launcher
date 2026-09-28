/*
================================================================================
脚本：scripts/selfcheck.mjs
职责：逐个路由真实渲染一次，确认每个页面都能正常工作。
================================================================================
  为什么 smoke-test 不够：
    smoke 只校验「渲染层已挂载」——那只证明默认页（/overview）渲染成功。
    而所有路由都是懒加载的 (`() => import(...)`)，其他页面要真正进去一次
    才知道会不会炸：模板里读一个 undefined 字段、组件里少 import 一个符号，
    构建阶段都不会报错（Vue 的模板错误往往是运行时的）。

    重构期间就出现过这类问题：设置页读 `form.general.scanRoots.length`，
    而老配置文件里根本没有这个字段 —— 直接进设置页就是整页白屏。

  做法：
    1) 以 MAIBOT_LAUNCHER_SELFCHECK=1 启动应用（主进程会逐个导航并记录结果）
    2) 等待主进程写出「[selfcheck] 完成」汇总行
    3) 按每页一行解析结果，任何一页异常即判定失败
    4) 杀掉进程树并清理临时 userData

  用法：
    node scripts/selfcheck.mjs [--keep] [--timeout 90000]

  注意：本脚本读取 dist/ 下的构建产物，请先 npm run build
        （或直接用 npm run selfcheck，它会自动先构建）。
================================================================================
*/
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const timeoutArg = argv.indexOf('--timeout');
const TIMEOUT_MS = timeoutArg > -1 ? Number(argv[timeoutArg + 1]) || 90000 : 90000;

/*
  --user-data <dir>：用一个**预置了配置文件**的目录启动，
  用于覆盖"有数据"的渲染分支（例如设置页里已经填好的扫描根列表）。
  空目录只能测到空态，而 bug 往往藏在有数据的那一支。
*/
const udArg = argv.indexOf('--user-data');
const PRESET_DIR = udArg > -1 ? argv[udArg + 1] : null;

let SANDBOX;
if (PRESET_DIR) {
  const abs = path.resolve(PRESET_DIR);
  if (!fs.existsSync(abs)) {
    console.error(`[selfcheck] ✗ --user-data 目录不存在: ${abs}`);
    process.exit(1);
  }
  SANDBOX = abs;
} else {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-selfcheck-'));
  /* 自建目录才清理；用户指定的目录不动 */
}
const OWN_SANDBOX = !PRESET_DIR;

const electronBin = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

let child = null;
let stdout = '';
let stderr = '';

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (_) {
      /* 进程可能已退出 */
    }
  }
}

function cleanup() {
  if (child?.pid) killTree(child.pid);
  if (!KEEP && OWN_SANDBOX) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true });
    } catch (_) {
      /* 忽略 */
    }
  }
}

function fail(msg) {
  console.error(`\n[selfcheck] ✗ ${msg}\n`);
  cleanup();
  process.exit(1);
}

/* ---------------------------------------------------------------- 前置检查 */
if (!fs.existsSync(electronBin)) {
  fail(`未找到 Electron 可执行文件: ${electronBin}\n            请先执行 npm install`);
}
for (const rel of ['dist/main/main.cjs', 'dist/preload/preload.cjs', 'dist/renderer/index.html']) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    fail(`缺少构建产物 ${rel}\n            请先执行 npm run build`);
  }
}

const logFile = path.join(SANDBOX, 'logs', 'launcher.log');

console.log('[selfcheck] 逐个路由真实渲染（隔离 userData）…');
console.log(`[selfcheck]   electron : ${electronBin}`);
console.log(`[selfcheck]   userData : ${SANDBOX}${OWN_SANDBOX ? '' : '（预置，运行后不删除）'}`);
console.log(`[selfcheck]   超时     : ${TIMEOUT_MS}ms\n`);

child = spawn(electronBin, ['.'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    ELECTRON_ENABLE_LOGGING: '1',
    MAIBOT_LAUNCHER_USER_DATA: SANDBOX,
    /* 打开页面自检开关（见 src/main/windows.js 的 runPageSelfCheck） */
    MAIBOT_LAUNCHER_SELFCHECK: '1'
  }
});

child.stdout?.on('data', (d) => {
  stdout += d.toString();
});
child.stderr?.on('data', (d) => {
  stderr += d.toString();
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

/*
  自检日志行的"行首形状" —— **唯一一份**，本文件 5 个匹配点共用。
  ──────────────────────────────────────────────────────────────────────
  主进程用 src/main/logging.js 的 formatLine 写盘：
      `[<ISO 时间戳>] [<LEVEL>] <正文>`
  自检相关行的正文都以 `[selfcheck] ` 开头（见 src/main/windows.js 的
  runPageSelfCheck），所以**真实**行的行首一定是：
      [2026-09-27T04:50:26.123Z] [INFO] [selfcheck] …
  ⚠️ 只锚 `[selfcheck]` 那一截**不够**：渲染层可控的字符串会被拼进主进程日志
  （services/index.js 的 `启动目录不存在或不是目录：${cwd}`、preload 的 log:report 等），
  它能造出一条**行尾或行内**形如 `[selfcheck] …` 的日志行；按行尾/行内匹配就会把
  渲染层文本当成主进程的自检结论。钉死"行首 + 时间戳 + 级别"之后，渲染层写出的
  文本**不可能**出现在这个位置（它前面永远还有主进程自己的字）。
  下面每条都按"先 trim 再判定单行"使用，^ / $ 才落在真正的行首行尾。
*/
const LOG_HEAD = String.raw`^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]\s*`;
/* 汇总行 `[selfcheck] 完成：…`；主进程在整轮页面循环**之后**才写（windows.js 末尾） */
const SUMMARY_RE = new RegExp(LOG_HEAD + String.raw`\[(?:INFO|ERROR)\]\s*\[selfcheck\] 完成：`);
/* 每页一行 `[selfcheck] <route> 正常|异常 …`（ok 记 INFO / bad 记 ERROR） */
const PAGE_RE = new RegExp(
  LOG_HEAD + String.raw`\[(?:INFO|ERROR)\]\s*\[selfcheck\]\s+\S+\s+(?:正常|异常)`
);
/* 新手引导入口统计行；只有"有页面缺失"时正文里才带"缺失页面" */
const GUIDE_MISSING_RE = new RegExp(
  LOG_HEAD + String.raw`\[(?:INFO|ERROR)\]\s*\[selfcheck\] 新手引导常驻入口：.*缺失页面`
);
/* 设置页关键字段行 `[selfcheck] 设置页关键服务字段：齐全|缺失 …` */
const SETTINGS_FIELD_RE = new RegExp(
  LOG_HEAD + String.raw`\[(?:INFO|ERROR)\]\s*\[selfcheck\] 设置页关键服务字段：`
);

function readLog() {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch (_) {
    return '';
  }
}

/** 等待自检汇总行出现（自检要跑完 8 个路由，默认给 90s） */
async function waitForSummary() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT_MS) {
     
    if (exited && exited.code !== 0) {
      fail(
        `Electron 提前退出（code=${exited.code} signal=${exited.signal}）\n` +
          `            stdout: ${stdout.slice(-500) || '(空)'}\n` +
          `            stderr: ${stderr.slice(-500) || '(空)'}`
      );
    }
    const text = readLog();
    /*
      ⚠️ 这个"完成"探针必须锚行首，而且它比另外几处**更要紧** —— 它决定
      **什么时候停止收集**。未锚定时，注入一条行尾形如 `[selfcheck] 完成：…`
      的日志就能让等待提前返回，此时日志里只有前 N 个页面的结果；N≥1 且每页
      都有 verdict 行时"行数一致"照样成立 → 等于**没跑完 7 个路由就判绿**。
      （N=0 会被后面的 pageLines.length===0 拦住；N≥1 单靠行数拦不住。
        要做到真判绿还得同时伪造一条"设置页关键服务字段：齐全" ——
        那一行是整轮循环之后才写的；两条都出自"行尾伪造"同一个原语。）
      锚定后不可构造：只有主进程**真跑完**写出的那行才算数
      （windows.js 的 `[selfcheck] 完成：` 在整轮页面循环之后）。
      这里判的是整份日志文本，所以按行 trim 后逐行测，^ 才落在行首。
    */
    if (text.split('\n').some((l) => SUMMARY_RE.test(l.trim()))) return text;
    await new Promise((r) => setTimeout(r, 500));
  }
  const partial = readLog();
  fail(
    `等待 ${TIMEOUT_MS}ms 后自检未完成\n` +
      `            已捕获日志:\n${(partial || '(空)')
        .split('\n')
        .filter(Boolean)
        .map((l) => `              ${l}`)
        .join('\n')}`
  );
}

const log = await waitForSummary();

/* ---------------------------------------------------------------- 结果判定 */
const lines = log.split('\n').filter(Boolean);
/*
  ⚠️ 这两处也锚行首（与 verdict 共用 LOG_HEAD 那一套，不再各写一份前缀）：
  · pageLines 只用于**展示** + "行数与 verdict 行数一致"的检查。未锚定时，
    注入一条行尾形如 `[selfcheck] <名字> 正常` 的日志会多算一条页面行 ——
    那**只会假红**（行数对不上 → fail），不会假绿：页面好坏只由 verdict 判，
    而 verdict 行已锚行首、同一 route 重复还会直接 fail。
    锚定后"假红"是否仍可构造？要构造就得有一条**整段正文**都以
    `[selfcheck] <名字> 正常|异常` 开头、且带真实 `[时间戳] [INFO|ERROR]` 的日志 ——
    行尾/行内拼接做不到（^ 之后立刻要求时间戳+级别）；目前唯一的整段可控入口
    log:report 已在主进程侧把 `[selfcheck]` 抹成 `[selfcheck-redacted]`（fix-g3），
    其余注入面（如 cwd）前面都有固定中文前缀 → 构造不出来。可接受。
  · 页面正文（最多 1400 字）里即便出现 `[selfcheck] xxx 正常`，也不在行首 → 不会自匹配。
  · summaryLine 只用于最后那行展示；锚定后不会把渲染层文本当"主进程汇总"打印出来。
*/
const pageLines = lines.filter((l) => PAGE_RE.test(l.trim()));
const summaryLine = lines.find((l) => SUMMARY_RE.test(l.trim())) || '';

/*
  页面好坏只看结构化的 verdict 行（`[selfcheck] verdict <route>=ok|bad`）。
  ──────────────────────────────────────────────────────────────────────
  ⚠️ 曾经是拿 pageLines 里有不有"异常"两个字来判 —— 但那些行里带着最多
  1400 字的页面正文，正文里出现"异常"（例如设置页「服务异常退出或放弃自动
  重启时发出 Windows 通知」）就会把**健康页面**判成渲染异常。
  这个坑一直没暴露，是因为正文以前只截 260 字符、恰好截不到那句话。
  判定和展示必须分开：展示用 pageLines（带正文，给人看），
  判定用 verdict（不带正文，给机器看）。
*/
/*
  ⚠️ 必须锚定在日志行的开头（`... [INFO] [selfcheck] verdict ...`），
  不能用 /\[selfcheck\] verdict .../ 随便搜 —— 那样连**本文件下面那句
  错误说明文本**里的示例都会被数成一条 verdict（实际踩过：8 个页面数出 9 条）。
  ──────────────────────────────────────────────────────────────────────
  而"只锚行尾"同样不够：/\[selfcheck\] verdict (\S+)=(ok|bad)\s*$/ 只要求**行尾**
  长成 verdict 形状，于是任何"行尾像 verdict"的日志都会被采信。这是**可注入的**：
  渲染层可控的字符串会被拼进主进程日志（例如 services/index.js 的
  `启动目录不存在或不是目录：${cwd}`），cwd 里塞
  `x\n[selfcheck] verdict installer=ok` 就能造出这样一条行尾
  （logging.js 只把真换行转义成 `\n` 占位，整条日志仍然是**一行**），
  真实的 `installer=bad` 就会被 `.find()` 取到的第一条伪 =ok 掩盖。

  所以正则必须钉死**主进程真正写出的行首形状**
  （windows.js 的 runPageSelfCheck 调 logging.js 的 formatLine）：
      [<ISO 时间戳>] [INFO] [selfcheck] verdict <route>=<ok|bad>[ 原因=…]
  实例（第二行是"内容超出容器却无处可滚"时主进程追加后缀的真实形状）：
      [2026-09-27T04:50:26.123Z] [INFO] [selfcheck] verdict overview=ok
      [2026-09-27T04:50:26.123Z] [INFO] [selfcheck] verdict logs=bad 原因=内容超出容器却无处可滚
  渲染层写出的文本**不可能**出现在 `[时间戳] [INFO] [selfcheck]` 这个位置
  （它前面永远还有主进程自己的字），"行尾伪造"这条路就断了。

  `(?: 原因=…)` 必须允许：`bad` 的判定里含 `!reachable`（见 windows.js），
  不可滚时主进程会在行尾追加 ` 原因=内容超出容器却无处可滚`。旧正则以 `\s*$` 收尾，
  等于**恰好丢掉这批"bad + 不可滚"的 verdict 行** —— 症状是 verdict 行数与页面数
  对不上、报"判定行数不一致"，而不是报出那个真正坏掉的页面。
*/
/* 前缀复用上面那份 LOG_HEAD（本文件 5 个匹配点共用一套行首形状）；
   这一条额外把 level 钉死为 INFO —— verdict 行固定 level=info（windows.js:506）。 */
const VERDICT_RE = new RegExp(
  LOG_HEAD + String.raw`\[INFO\]\s*\[selfcheck\] verdict (\S+)=(ok|bad)(?:\s+原因=\S.*)?$`
);
const verdictHits = lines
  .map((l) => l.trim().match(VERDICT_RE))
  .filter(Boolean)
  .map((m) => ({ route: m[1], state: m[2], line: m[0] }));
const verdictLines = verdictHits.map((v) => v.line);
/*
  同一 route 出现多条 verdict = 有人在冒充主进程（或自检循环坏了）：
  主进程按 SELFCHECK_ROUTES 每个路由**只写一条**。这里 fail-closed ——
  否则"伪 =ok 排在真实 =bad 之前"仍然能靠"取第一条"蒙过去。
  ⚠️ 不能只靠下面的"verdict 行数与页面数一致"兜底：pageLines 目前没有锚行首
  （本文件另一个待收口点），理论上可以顺手注入一条假页面行把行数配平，
  所以必须显式拒绝重复。
*/
const dupVerdictRoutes = [...new Set(verdictHits.map((v) => v.route))].filter(
  (r) => verdictHits.filter((v) => v.route === r).length > 1
);
if (dupVerdictRoutes.length) {
  fail(
    `同一路由出现多条 verdict 判定行（${dupVerdictRoutes.join(' / ')}）——` +
      ' 主进程每个路由只写一条，重复说明日志被伪造或自检循环异常，无法判定'
  );
}
const verdictOf = (route) => verdictHits.find((v) => v.route === route)?.state || '';

console.log('[selfcheck] ── 页面渲染结果 ──────────────────────');
if (pageLines.length === 0) {
  console.log('  (未解析到任何页面结果)');
} else {
  for (const l of pageLines) {
    /* 只保留自检那一段的正文，日志前缀时间戳太长 */
    const body = l.replace(/^.*?\[selfcheck\]\s*/, '');
    /* 用 verdict 判定，不看正文里有没有"异常"两个字 */
    const route = body.split(/\s+/)[0];
    const bad = verdictOf(route) === 'bad';
    console.log(`  ${bad ? '✗' : '✓'} ${body}`);
  }
}
console.log('[selfcheck] ───────────────────────────────────────\n');

/*
  明确的崩溃特征：这类问题即便日志里没有 [selfcheck] 的"异常"标记也必须拦下。
  例如模块级抛错会让整个页面空白，但错误在 window.onerror 之前就发生了。
*/
const crashSignatures = [
  'Cannot find module',
  'MODULE_NOT_FOUND',
  'Unable to load preload script',
  'ERR_REQUIRE_ESM',
  'is not a function',
  'Cannot read properties of undefined',
  'before initialization'
];
const crashLine = crashSignatures.find((s) => log.includes(s) || stderr.includes(s));

/*
  ⚠️ 用解析出来的 state 判，不再用 `endsWith('=bad')`：带 ` 原因=…` 后缀的 bad 行
  结尾不是 `=bad`，用 endsWith 会漏掉它（与旧正则漏行是同一个坑的两半）。
*/
const badPages = verdictHits.filter((v) => v.state === 'bad').map((v) => v.line);
const rendererErrors = lines.filter((l) => /\[ERROR\].*\[renderer/.test(l));

/*
  新手引导常驻入口必须在每个页面都可见。
  它挂在 AppLayout（所有路由共用的外壳）上，一旦被挪进某个具体页面、
  或被加上"关过就不再显示"的条件，就会在部分页面消失 ——
  那正是用户报过的"收起后就没了"。主进程已经统计过，这里负责让它真正拦住 CI。
*/
/*
  ⚠️ 锚行首（LOG_HEAD）：未锚定时，一条行尾形如
  `[selfcheck] 新手引导常驻入口：x 个页面可见，缺失页面: y` 的渲染层日志会让这里命中。
  影响方向是**假红**（本来没缺失也拦住），不是假绿 —— 这条只用于"发现即 fail"，
  它不参与判绿（主进程那行不存在时这条断言不触发，判绿与否由 verdict + 设置页字段
  + 行数一致性决定）。锚定后该形状不可构造（见 LOG_HEAD 说明）。
*/
const missingGuideLine = lines.find((l) => GUIDE_MISSING_RE.test(l.trim()));
/*
  注意方向：这里要找的是"**没有**报齐全"的情况，而不是"报了缺失"。
  写成 /：缺失/ 的话，只有在失败时才匹配得上 —— 等于一条永远不触发的断言，
  而它看起来还很像在工作。用"必须出现齐全"来判，缺了主进程日志同样会红。
*/
/*
  ⚠️ 锚行首（LOG_HEAD）—— 这一处是**真的假绿**，比上面那条严重：
  它用 `.find()` 取**第一条**匹配。未锚定时，渲染层可以在主进程那行之前注入一条
  行尾形如 `[selfcheck] 设置页关键服务字段：齐全` 的日志，于是 settingsFieldOk
  读到"齐全"，把主进程真实报出的"缺失 SnowLuma 目录…"掩盖掉 → 门禁判绿。
  锚定后只有主进程写出的那行能命中，"抢先占位"不可构造。
*/
const settingsFieldLine = lines.find((l) => SETTINGS_FIELD_RE.test(l.trim()));
const settingsFieldOk = Boolean(settingsFieldLine) && /：齐全\s*$/.test(settingsFieldLine.trim());

if (pageLines.length === 0) {
  fail('自检完成但没有任何页面结果（自检逻辑可能未生效）');
}
/*
  verdict 行数必须和页面行数对得上。
  否则一旦主进程忘了打 verdict，badPages 恒为空、断言全部"通过" ——
  那正是我刚修掉的那类"看起来在工作其实永不触发"的假断言。
*/
if (verdictLines.length !== pageLines.length) {
  fail(
    `verdict 判定行数与页面数不一致（页面 ${pageLines.length} 条 / verdict ${verdictLines.length} 条）` +
      '，页面好坏无法判定'
  );
}
if (missingGuideLine) {
  fail(`新手引导入口没有出现在所有页面里:\n            ${missingGuideLine.replace(/^.*?\[selfcheck\]\s*/, '')}`);
}
if (!settingsFieldOk) {
  fail(
    '设置页缺少关键服务字段（服务可能配不起来）:\n            ' +
      (settingsFieldLine
        ? settingsFieldLine.replace(/^.*?\[selfcheck\]\s*/, '')
        : '主进程未报告「设置页关键服务字段」结果（断言未生效）')
  );
}
if (crashLine) {
  fail(`检测到崩溃特征 "${crashLine}"\n            详见上方日志`);
}
if (rendererErrors.length) {
  fail(
    `渲染层报告了 ${rendererErrors.length} 条未捕获异常:\n` +
      rendererErrors.map((l) => `            ${l}`).join('\n')
  );
}
if (badPages.length) {
  fail(
    `有 ${badPages.length} 个页面渲染异常:\n` +
      badPages.map((l) => `            ${l.replace(/^.*?\[selfcheck\]\s*/, '')}`).join('\n')
  );
}

console.log('[selfcheck] ✓ 全部页面渲染正常');
console.log(`[selfcheck]   ${summaryLine.replace(/^.*?\[selfcheck\]\s*/, '')}`);
console.log(`[selfcheck]   日志文件: ${logFile}\n`);

cleanup();
process.exit(0);
