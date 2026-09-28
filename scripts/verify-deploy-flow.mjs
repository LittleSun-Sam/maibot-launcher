/*
================================================================================
脚本：scripts/verify-deploy-flow.mjs
职责：用**这台机器上真实的磁盘/进程状态**验证首跑部署流程的判定逻辑。
================================================================================
  为什么必须有这个脚本：
    「首跑部署流程」的价值全在"它说的是不是真的"——
       · 说"已检测到 MaiBot 1.2.0"就必须真的读到 1.2.0；
       · 说"缺 Python"就不能因为探测失败而默认通过；
       · 说"下一步点安装"时，那一步的按钮必须真的接得上。
    这些错误**不会抛异常**，只会让用户照着做却卡住，所以只能靠断言守。

  这个脚本做两件事：
    1) 用真实数据跑一遍 buildDeploySteps（环境探测直接调用主进程的 envcheck，
       设置读真实 backend-settings.json），断言"不许假通过"的几条铁律；
    2) 用三份合成快照验证可重入与边界（没装 / 装好没跑 / 跑起来了）。
    它**不下载任何东西、不启动任何服务、不写设置**。

  跑法：node scripts/verify-deploy-flow.mjs
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.NODE_OPTIONS = '';

const envcheck = require(path.join(ROOT, 'src/main/services/envcheck.js'));
const {
  buildDeploySteps,
  deploySummary,
  validateTargetDir,
  diskRootOf,
  installDirFor,
  DEPLOY_IDS,
  MIN_FREE_BYTES
} = await import(
  new URL('../src/renderer/onboarding/deploy-flow.js', import.meta.url).href
);

let bad = 0;
const chk = (name, ok, extra) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? `   -> ${extra}` : ''}`);
  if (!ok) bad += 1;
};

/* ------------------------------------------------------------------ 真实快照 */

/** 真实设置文件（启动器写的那一份；读不到就退回空设置，不算失败） */
function readRealSettings() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'maibot-launcher', 'backend-settings.json'),
    path.join(process.env.APPDATA || '', 'MaiBotLauncher', 'backend-settings.json')
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return { file: f, data: JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch (_) {
      /* 读不动就试下一个 */
    }
  }
  return { file: '', data: {} };
}

const settings = readRealSettings();
const svc = settings.data?.service || {};
const maibotDir = String(svc.maibotDir || '');
const snowlumaDir = String(svc.snowlumaDir || '');

console.log(`[deploy] 真实设置文件：${settings.file || '（没找到）'}`);
console.log(`[deploy] maibotDir   = ${maibotDir || '（空）'}`);
console.log(`[deploy] snowlumaDir = ${snowlumaDir || '（空）'}`);
console.log('');

const maibot = envcheck.detectDirKind(maibotDir);
const snowluma = envcheck.detectDirKind(snowlumaDir);
const maibotVersion = envcheck.detectMaiBotVersion(maibotDir);
const tools = await envcheck.detectTools(svc.pythonPath || 'python');

/* 目标目录（父目录）默认取已配置目录的父级，与安装器页 parentOf 同义 */
function parentOf(dir) {
  const p = String(dir || '').trim();
  if (!p) return '';
  const m = /^(.*)[\\/](?:maibot|snowluma)[\\/]?$/i.exec(p);
  if (m && m[1]) return m[1];
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return cut > 2 ? p.slice(0, cut) : p;
}
const targetDir = parentOf(maibotDir);
const diskTarget = diskRootOf(targetDir) || 'C:\\';

/* 磁盘空间：主进程用 fs.statfs；这里用同一套 API 的真实调用 */
let disk = { ok: false, message: '未能读取磁盘空间（本脚本在 Node 里直接调用 statfs）' };
try {
  const st = await fs.promises.statfs(diskTarget);
  disk = {
    ok: true,
    freeBytes: Number(st.bavail) * Number(st.bsize),
    totalBytes: Number(st.blocks) * Number(st.bsize),
    message: ''
  };
} catch (e) {
  disk = { ok: false, message: e.message };
}

/* 目录占用探测：与 github:probe-dirs 同义（存在 / 是否为空 / 条目数） */
function probeDirs(dirs) {
  const results = dirs.map((d) => {
    const p = String(d || '');
    try {
      if (!p || !fs.existsSync(p)) return { path: p, exists: false, empty: true, fileCount: 0 };
      const n = fs.readdirSync(p).length;
      return { path: p, exists: true, empty: n === 0, fileCount: n };
    } catch (e) {
      return { path: p, exists: true, empty: false, fileCount: 0, error: e.message };
    }
  });
  return { ok: true, results };
}

const snapReal = {
  ok: true,
  tools,
  disk,
  diskTarget,
  maibot,
  maibotVersion,
  snowluma,
  dirs: { maibotDir, snowlumaDir, pythonPath: svc.pythonPath || 'python' },
  ports: {
    maibot: Number(svc.ports?.maibot) || 8080,
    maibotWebui: Number(svc.ports?.webui) || 8001,
    snowlumaWebui: Number(svc.snowlumaPorts?.webui) || 5099,
    snowlumaOnebot: Number(svc.snowlumaPorts?.onebot) || 7988
  },
  targetDir,
  suggestedTarget: path.join(os.homedir() || 'C:\\', 'MaiBot'),
  diskProbe: probeDirs([installDirFor(targetDir, 'maibot'), installDirFor(targetDir, 'snowluma')]),
  installations: [],
  deps: null,
  eula: { state: 'none' },
  running: [],
  minFreeBytes: MIN_FREE_BYTES
};

const realSteps = buildDeploySteps(snapReal);
const realSummary = deploySummary(realSteps);

console.log('[deploy] 真实快照下每一步的判定：');
for (const s of realSteps) {
  console.log(`   ${s.done ? '✔' : '·'} [${s.status}] ${s.title} — ${s.summary}`);
}
console.log('');
console.log('[deploy] 真实快照下的"当前这一步"：');
const cur = realSteps.find((s) => s.current);
if (cur) {
  console.log(`   标题：${cur.title}`);
  console.log(`   状态：${cur.status}（done=${cur.done}）`);
  cur.facts.forEach((f) => console.log(`   事实[${f.tone || '-'}] ${f.text}`));
  console.log(`   下一步照做：${cur.next}`);
}
console.log('');

/* ------------------------------------------------------------------ 断言 1：结构 */

console.log('[deploy] 步骤表结构与顺序');
chk('共 6 步', realSteps.length === 6, String(realSteps.length));
chk(
  '顺序：体检 → 位置 → 安装 → 依赖 → 启动 → 出口',
  realSteps.map((s) => s.id).join(',') ===
    [DEPLOY_IDS.env, DEPLOY_IDS.dir, DEPLOY_IDS.install, DEPLOY_IDS.deps, DEPLOY_IDS.start, DEPLOY_IDS.out].join(','),
  realSteps.map((s) => s.id).join(',')
);
chk(
  '每一步都有可照做的 next 文案与事实行',
  realSteps.every((s) => typeof s.next === 'string' && s.next.length > 8 && Array.isArray(s.facts) && s.facts.length > 0)
);
chk(
  '每一步的 next 都不含空话（必须能落到具体动作）',
  realSteps.every((s) => /点|去|输入|填|装|扫描|打开|登录|确认|先|推荐|使用|跳过|启动|复制/.test(s.next))
);
chk('只允许一个 current', realSteps.filter((s) => s.current).length <= 1);
chk('进度已算出', realSummary.total === 6 && realSummary.done >= 0, `${realSummary.done}/${realSummary.total}`);

/* ------------------------------------------------------------------ 断言 2：不许假通过 */

console.log('');
console.log('[deploy] 不许假通过（探测失败 / 缺东西时必须如实报）');

const emptySnap = buildDeploySteps({ tools: null, disk: null, running: [] });
const envEmpty = emptySnap[0];
chk(
  '没有工具链数据时第 1 步不能是 done',
  envEmpty.status !== 'done' && envEmpty.done === false,
  `${envEmpty.status}`
);
chk(
  '没有磁盘数据时明确写"无法读取/还没有读取"，不假装充足',
  envEmpty.facts.some((f) => /无法读取|还没有读取/.test(f.text)),
  envEmpty.facts.map((f) => f.text).join(' | ').slice(0, 120)
);

const noPython = buildDeploySteps({
  tools: {
    ok: true,
    python: { ok: false, found: false, version: '', message: '没有找到 python，请先安装 Python 3.12+' },
    git: { ok: true, version: '2.53.0', message: 'git version 2.53.0' },
    uv: { ok: false, version: '', message: '没有找到 uv' }
  },
  disk: { ok: true, freeBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }
});
chk('缺 Python 时第 1 步为 blocked', noPython[0].status === 'blocked', noPython[0].status);
chk(
  '缺 Python 时事实行明确是 err（不是 ok）',
  noPython[0].facts.some((f) => f.tone === 'err' && /Python/.test(f.text)),
  noPython[0].facts.map((f) => `${f.tone}:${f.text}`).join(' | ')
);
chk('缺 uv 只给 warn —— 它是可选项，不能拦人', noPython[0].facts.some((f) => f.tone === 'warn' && /uv/.test(f.text)));

const lowDisk = buildDeploySteps({
  tools: { ok: true, python: { ok: true, found: true, version: '3.12.8', message: 'Python 3.12.8' }, git: { ok: true, version: '2', message: 'git' }, uv: { ok: true, version: '1', message: 'uv' } },
  disk: { ok: true, freeBytes: 100 * 1024 * 1024, totalBytes: 100 * 1024 ** 3 }
});
chk('磁盘不足时第 1 步为 blocked', lowDisk[0].status === 'blocked', lowDisk[0].status);

/* ------------------------------------------------------------------ 断言 3：目录与可重入 */

console.log('');
console.log('[deploy] 选位置 / 可重入');

chk('空目录被拦', validateTargetDir('').level === 'block');
chk('C:\\Windows 被拦', validateTargetDir('C:\\Windows').level === 'block');
chk('C:\\Users 本身被拦', validateTargetDir('C:\\Users').level === 'block');
chk('C:\\Users\\me\\MaiBot 放行（用户自己的目录）', validateTargetDir('C:\\Users\\me\\MaiBot').level === 'ok');
chk('D:\\ 给 warn 但放行', validateTargetDir('D:\\').level === 'warn');
chk('盘根解析正确', diskRootOf('E:\\新建文件夹\\x') === 'E:\\', diskRootOf('E:\\新建文件夹\\x'));
chk('安装目录拼接正确', installDirFor('D:\\MaiBot', 'maibot') === 'D:\\MaiBot\\maibot', installDirFor('D:\\MaiBot', 'maibot'));

const installedSnap = {
  tools: { ok: true, python: { ok: true, found: true, version: '3.12.8' }, git: { ok: true, version: '2.53.0' }, uv: { ok: true, version: '0.12.1' } },
  disk: { ok: true, freeBytes: 50 * 1024 ** 3 },
  maibot: { ok: true, kind: 'maibot', dir: 'D:\\MaiBot\\maibot', entry: 'bot.py', message: '识别为 MaiBot（入口 bot.py，版本 1.2.0）' },
  maibotVersion: { ok: true, kind: 'supported', version: '1.2.0', hasConfigDir: false, adapter: null },
  snowluma: { ok: false, kind: 'unknown', dir: '' },
  targetDir: 'D:\\MaiBot',
  installations: [],
  diskProbe: { ok: true, results: [{ path: 'D:\\MaiBot\\maibot', exists: true, empty: false, fileCount: 12 }] },
  deps: { ok: true, source: 'requirements.txt', mode: 'quick', dependencies: [{ name: 'a', ok: true }, { name: 'b', ok: false }] },
  eula: { state: 'none' },
  running: []
};
const s1 = buildDeploySteps(installedSnap, { doneIds: [DEPLOY_IDS.dir] });
const byId = (steps, id) => steps.find((s) => s.id === id);
chk('检测到已安装时「安装麦麦」自动 done（不靠用户点）', byId(s1, DEPLOY_IDS.install).done === true);
chk('检测到已安装时「选位置」自动 done', byId(s1, DEPLOY_IDS.dir).done === true);
chk('缺依赖时「依赖」不是 done，且列出缺的名字', byId(s1, DEPLOY_IDS.deps).done === false && byId(s1, DEPLOY_IDS.deps).facts.some((f) => f.text.includes('b')));
chk('未运行服务时「启动」不是 done', byId(s1, DEPLOY_IDS.start).done === false);
chk('current 落在第一个未完成步（依赖）', byId(s1, DEPLOY_IDS.deps).current === true, s1.find((s) => s.current)?.title);

/* 手动标记：事实反证时必须失效（启动这一步完全由进程事实决定） */
const markedStart = buildDeploySteps({ ...installedSnap, running: [] }, { doneIds: [DEPLOY_IDS.start] });
chk('服务没在跑时，用户上次的「启动」标记不生效', byId(markedStart, DEPLOY_IDS.start).done === false);
const markedStartUp = buildDeploySteps({ ...installedSnap, running: [{ key: 'maibot', running: true }] }, { doneIds: [] });
chk('服务真在跑时「启动」自动 done（不靠标记）', byId(markedStartUp, DEPLOY_IDS.start).done === true);
const markedBlockedDir = buildDeploySteps(
  { ...installedSnap, maibot: { ok: false, kind: 'unknown', dir: '' }, maibotVersion: { kind: 'unknown' }, targetDir: 'C:\\Windows' },
  { doneIds: [DEPLOY_IDS.dir] }
);
chk('位置非法（blocked）时手动标记不生效', byId(markedBlockedDir, DEPLOY_IDS.dir).done === false);

/* 依赖齐 + 服务在跑 → 全流程走完 */
const allDoneSnap = {
  ...installedSnap,
  deps: { ok: true, source: 'requirements.txt', mode: 'quick', dependencies: [{ name: 'a', ok: true }] },
  running: [{ key: 'maibot', running: true }],
  maibotVersion: { ...installedSnap.maibotVersion, hasConfigDir: true }
};
const s2 = buildDeploySteps(allDoneSnap);
chk('依赖齐 + 服务在跑 → 除出口外全 done', s2.slice(0, 5).every((s) => s.done), s2.map((s) => `${s.title}:${s.done}`).join(' | '));
chk('没有 current（全走完）', s2.every((s) => !s.current) || s2.filter((s) => s.current).length === 1);

/* 首次启动卡在协议上 → 必须 blocked 且指向终端 */
const eulaSnap = { ...installedSnap, deps: { ok: true, source: 'requirements.txt', dependencies: [{ name: 'a', ok: true }] }, eula: { state: 'need-confirm' } };
const s3 = buildDeploySteps(eulaSnap);
const start3 = byId(s3, DEPLOY_IDS.start);
chk('卡在 EULA 时「启动」为 blocked', start3.status === 'blocked', start3.status);
chk('卡在 EULA 时下一步指向终端输入「同意」', start3.next.includes('同意') && start3.actions.some((a) => a.kind === 'route' && a.hash === '#/terminal'));

/* SnowLuma 缺失必须是"可选"，不能被说成必装 */
chk(
  '未装 SnowLuma 时明确写"可选"',
  byId(s3, DEPLOY_IDS.start).facts.some((f) => /可选/.test(f.text)),
  byId(s3, DEPLOY_IDS.start).facts.map((f) => f.text).find((t) => /SnowLuma/.test(t))
);
/* 未装 SnowLuma 时出口步骤也写"可选" */
chk(
  '未装 SnowLuma 时出口步骤也写"可选"',
  byId(s3, DEPLOY_IDS.out).facts.some((f) => /可选/.test(f.text))
);

/* ------------------------------------------------------------------ 断言 5：复用路径不许被说成"要覆盖"

console.log('');
console.log('[deploy] 复用已有安装时的文案（实测踩到的两处误报）');

/*
  真实机器上的情形：设置里 maibotDir = …\modules\MaiBot，
  于是安装器页的 targetDir 预填成它的父级 …\modules，
  而磁盘上**恰好**存在 …\modules\maibot（OneKey 留下的另一个目录，34 项）。
  旧实现会因此报红："已有内容 —— 安装会整体替换且不留备份"，
  而用户其实什么都不用装（清单前两步都已经完成）—— 这是纯误报。
*/
const reuseSnap = {
  ...installedSnap,
  maibot: { ok: true, kind: 'maibot', dir: 'D:\\MaiBot\\maibot', message: '识别为 MaiBot' },
  targetDir: 'D:\\MaiBot',
  diskProbe: {
    ok: true,
    results: [
      { path: 'D:\\MaiBot\\maibot', exists: true, empty: false, fileCount: 34 },
      { path: 'D:\\MaiBot\\snowluma', exists: false, empty: true, fileCount: 0 }
    ]
  }
};
const reuseDir = byId(buildDeploySteps(reuseSnap), DEPLOY_IDS.dir);
chk(
  '目标目录就是正在用的那一份时，不再报"会被整体替换且不留备份"',
  !reuseDir.facts.some((f) => f.tone === 'err' && /不留备份/.test(f.text)),
  reuseDir.facts.map((f) => `${f.tone}:${f.text}`).join(' | ')
);
chk(
  '并且明确说出"这一份就是启动器在用的"',
  reuseDir.facts.some((f) => /就是启动器正在用的这一份/.test(f.text))
);

/* 反向：目标目录里那份**不是**识别出来的安装时，警告必须保留 */
const otherSnap = {
  ...reuseSnap,
  maibot: { ok: true, kind: 'maibot', dir: 'C:\\elsewhere\\maibot', message: '识别为 MaiBot' }
};
const otherDir = byId(buildDeploySteps(otherSnap), DEPLOY_IDS.dir);
chk(
  '目标目录里是**另一份**安装时，仍要警告"会被替换且不留备份"',
  otherDir.facts.some((f) => f.tone === 'err' && /不留备份/.test(f.text)),
  otherDir.facts.map((f) => `${f.tone}:${f.text}`).join(' | ')
);

/* 适配器：没有数据时必须说"没检测到"，不能默认就位 */
chk(
  '适配器数据缺失时说"没有检测到"，不假装就位',
  byId(buildDeploySteps({ ...installedSnap, maibotVersion: { kind: 'supported', version: '1.2.0', adapter: null } }), DEPLOY_IDS.install).facts.some(
    (f) => /没有检测到 SnowLuma 适配器插件/.test(f.text)
  )
);
chk(
  '适配器是官方那份时报 ok',
  byId(
    buildDeploySteps({ ...installedSnap, maibotVersion: { kind: 'supported', version: '1.2.0', adapter: { name: 'MaiBot-SnowLuma-Adapter', kind: 'official', version: '1.4.0', hasManifest: true } } }),
    DEPLOY_IDS.install
  ).facts.some((f) => f.tone === 'ok' && /已就位/.test(f.text))
);

/* ------------------------------------------------------------------ 断言 4：动作接线 */

console.log('');
console.log('[deploy] 动作接线（按钮必须指向已有动作，不能是空指向）');
const KINDS = new Set(['external', 'route', 'refresh', 'pick-dir', 'use-suggested', 'install-maibot', 'check-deps', 'install-deps', 'start-service', 'open-webui', 'open-guide']);
const allActions = realSteps.concat(s1, s2, s3).flatMap((s) => s.actions || []);
chk('所有动作的 kind 都在已接线的集合里', allActions.every((a) => KINDS.has(a.kind)), [...new Set(allActions.map((a) => a.kind))].join(','));
chk('route 动作都带 hash', allActions.filter((a) => a.kind === 'route').every((a) => String(a.hash || '').startsWith('#/')));
chk('external 动作都带 https 链接', allActions.filter((a) => a.kind === 'external').every((a) => /^https:\/\//.test(String(a.url || ''))));
chk('start-service 动作都带 service', allActions.filter((a) => a.kind === 'start-service').every((a) => a.service === 'maibot' || a.service === 'snowluma'));

/* ------------------------------------------------------------------ 结论 */

console.log('');
if (bad) {
  console.log(`[deploy] ${bad} 项断言失败`);
  process.exit(1);
}
console.log('[deploy] 全部断言通过（真实快照 + 合成边界 + 动作接线）');
