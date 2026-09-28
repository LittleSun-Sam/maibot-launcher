/*
================================================================================
脚本：scripts/verify-onboarding.mjs
职责：验证 MaiBot 版本识别 + 工具链探测 + 引导步骤判定逻辑。
================================================================================
  为什么这几项必须进 verify 门禁：
    版本识别是本项目此前**完全缺失**、且后果最严重的一项检查。
    官方 SnowLuma 适配器只支持 MaiBot ≥ 1.2.0，而 0.6.x 是
    完全不同的架构（配置字段、适配器形态、WebSocket 方向、依赖数据库
    都不一样）。把 0.6.x 当 1.2.x 引导，用户每一步都"照做了"却永远连不上，
    而且没有任何地方告诉他根因是版本。

    这类"判错了比不判更糟"的逻辑，必须用**真实的两种目录结构**跑一遍：
      · 真实 0.6.x 安装（用户磁盘上那套 MaiBot 0.6.3-alpha）
      · 合成 1.2.x 安装（config/bot_config.toml 用 qq_account 字符串写法）
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

const env = require(path.join(ROOT, 'src/main/services/envcheck.js'));

/* 用户磁盘上真实的 0.6.3 安装（只读） */
const REAL_OLD = 'D:\\文件夹\\MaiM-with-u\\MaiBot';
const hasRealOld = fs.existsSync(path.join(REAL_OLD, 'template', 'bot_config_template.toml'));

let bad = 0;
let skipped = 0;
const chk = (name, ok, extra) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  → ${extra}` : ''}`);
  if (!ok) bad += 1;
};
const skip = (name, why) => {
  console.log(`  – ${name}（跳过：${why}）`);
  skipped += 1;
};

const tmpRoots = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
/** 造一个合成目录：给出相对路径 → 内容（'' 表示空文件） */
function synth(files) {
  const dir = mkTmp('mbver-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

console.log('[onboarding] 真实 0.6.x 安装必须被判为不支持');
if (hasRealOld) {
  const r = env.detectMaiBotVersion(REAL_OLD);
  chk('判定为 unsupported', r.kind === 'unsupported', r.kind);
  chk('识别出版本为 0.6.x', r.version === '0.6.x', r.version);
  chk('给出了可读原因', typeof r.message === 'string' && r.message.includes('1.2.0'), r.message.slice(0, 40));
  chk('列出了判定依据（可复核）', Array.isArray(r.evidence) && r.evidence.length > 0, (r.evidence || []).join(' / '));
} else {
  skip('真实 0.6.x 判定', '磁盘上没有那套安装');
}

console.log('[onboarding] 合成 1.2.x 安装必须被判为支持');
const newDir = synth({
  'config/bot_config.toml': '[bot]\nplatform = "qq"\nqq_account = "123456789"\nnickname = "麦麦"\n',
  'src/config/startup_bindings.py': '# placeholder\n',
  'plugins/MaiBot-SnowLuma-Adapter/_manifest.json': JSON.stringify({ name: 'MaiBot-SnowLuma-Adapter', version: '1.0.6' })
});
const rn = env.detectMaiBotVersion(newDir);
chk('判定为 supported', rn.kind === 'supported', rn.kind);
chk('识别出版本为 1.2.x', rn.version === '1.2.x', rn.version);
chk('识别出 qq_account 写法', rn.scheme === 'qq_account', String(rn.scheme));
chk('发现了适配器插件', rn.adapter?.name === 'MaiBot-SnowLuma-Adapter', rn.adapter?.name);
chk('报告插件版本', rn.adapter?.version === '1.0.6', rn.adapter?.version);
chk('认出这是官方那个适配器（不是第三方分支）', rn.adapter?.kind === 'official', String(rn.adapter?.kind));
chk('结论里提到已装适配器', /适配器/.test(rn.message), rn.message);

console.log('[onboarding] 1.2.x 但未装适配器');
const noAdapter = synth({
  'config/bot_config.toml': '[bot]\nqq_account = "123"\n',
  'src/config/startup_bindings.py': '# x\n'
});
const rna = env.detectMaiBotVersion(noAdapter);
chk('仍判为 supported', rna.kind === 'supported', rna.kind);
chk('adapter 为 null', rna.adapter === null);
chk('提示尚未安装适配器', /尚未安装/.test(rna.message), rna.message);

console.log('[onboarding] 0.6.x 但用户手建了 config/bot_config.toml（危险混合态）');
const mixed = synth({
  'template/bot_config_template.toml': '[bot]\nqq = 114514\n',
  'src/heart_flow/x.py': '# x\n',
  'config/bot_config.toml': '[bot]\nqq = 1145141919810\nnickname = "麦麦"\n'
});
const rm = env.detectMaiBotVersion(mixed);
chk('仍判为 unsupported（老字段 qq=<数字>）', rm.kind === 'unsupported', rm.kind);
chk('原因指出字段写法差异', /qq_account/.test(rm.message), rm.message.slice(0, 50));

console.log('[onboarding] 判定不出来时必须说不知道，不能猜');
const emptyDir = mkTmp('mbver-empty-');
const re = env.detectMaiBotVersion(emptyDir);
chk('空目录 → unknown', re.kind === 'unknown', re.kind);
chk('unknown 也有可读原因', typeof re.message === 'string' && re.message.length > 0);
const missing = env.detectMaiBotVersion(path.join(os.tmpdir(), '__nope_maibot__'));
chk('目录不存在 → unknown 且不抛', missing.kind === 'unknown');
chk('空路径 → unknown 且不抛', env.detectMaiBotVersion('').kind === 'unknown');

console.log('[onboarding] 无 _manifest.json 的插件目录不算有效插件');
const noManifest = synth({
  'config/bot_config.toml': 'qq_account = "1"\n',
  'src/config/startup_bindings.py': '# x\n',
  'plugins/snowluma-adapter/main.py': '# 没有 _manifest.json\n'
});
const rnm = env.detectMaiBotVersion(noManifest);
chk('识别到该目录但标记 hasManifest=false', rnm.adapter?.hasManifest === false);
chk('目录级适配器仍被列出（供界面提示结构不对）', rnm.plugins.length === 1, String(rnm.plugins.length));

console.log('[onboarding] 工具链探测（Python 必须比较版本，不能只看命令能跑）');
const tools = await env.detectTools('python');
console.log('     ', JSON.stringify({
  python: tools.python.version, pythonOk: tools.python.ok,
  git: tools.git.version, gitOk: tools.git.ok, uvOk: tools.uv.ok
}));
chk('返回 python/git/uv/node 四项', ['python', 'git', 'uv', 'node'].every((k) => tools[k]));
chk('本机 Python 3.12+ 判为 ok', tools.python.ok === true, tools.python.version);
chk('Python 版本号被正确解析', /^\d+\.\d+\.\d+$/.test(tools.python.version), tools.python.version);
chk('Python 的 ok 是布尔值', typeof tools.python.ok === 'boolean');
const fakePy = await env.detectTools('definitely_not_a_real_python_exe');
chk('不存在的解释器 → ok=false 且不抛', fakePy.python.ok === false, fakePy.python.message.slice(0, 40));
chk('不存在的解释器仍给出可行建议', /安装/.test(fakePy.python.message), fakePy.python.message.slice(0, 40));

/*
  ⚠️ 这里原来还有"QQ 客户端探测"一节（env.detectQq）。
  QQ 客户端探测随 QQ 注入式协议端一起删掉了：SnowLuma 是独立 Node 程序，
  不需要机器上装 QQ。向导里那条"去下载 QQ"的步骤也一并删除，
  所以这里只剩目录归属判定。
*/
console.log('[onboarding] 目录归属判定');
const naDir = env.detectDirKind(path.join(os.tmpdir(), '__nope__'));
chk('不存在目录 → unknown 且 ok=false', naDir.kind === 'unknown' && naDir.ok === false);

/* ============================================================================
   引导步骤：核心不变量
   --------------------------------------------------------------------------
   这一段防的是"看起来做完了"的假象 —— 那是这个项目最忌讳的东西。
   ========================================================================== */
console.log('[onboarding] 步骤定义：不自动勾选 + 每步都有真实依据');

/* steps.js 是 ESM，用 pathToFileURL 解析 —— 路径含空格与中文，手拼 file:// 会坏 */
const { pathToFileURL } = await import('node:url');
const stepsMod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/onboarding/steps.js')).href);
const { buildSteps, STEP_IDS } = stepsMod;

/* 与 OnboardingWizard.vue 实际注入的 docs 对象保持同一组键（多一个少一个都会掩盖死链） */
const DOCS = { DOCS_WIN: 'd', ONEKEY: 'o', ADAPTER: 'a', ADAPTER_DOCS: 'ad', SNOWLUMA_REPO: 's' };

/* 1) 最核心的不变量：没有任何一步会因为"环境看起来正常"而自动变成已完成 */
const emptyEnv = {
  maibot: { dir: 'X', kind: 'maibot', entry: 'bot.py' },
  maibotVersion: { kind: 'supported', version: '1.2.x', evidence: [], adapter: { name: 'MaiBot-SnowLuma-Adapter', version: '1.0.6' } },
  snowluma: { dir: 'Y', kind: 'snowluma', version: '1.14.19' },
  tools: { python: { ok: true, version: '3.12.8' }, git: { ok: true }, uv: { ok: true } },
  running: [{ key: 'maibot', running: true }, { key: 'snowluma', running: true }]
};
const allGood = buildSteps({ env: emptyEnv, doneIds: [], docs: DOCS });
chk('★ 环境全绿时也没有任何一步自动完成（不自动勾选）', allGood.every((s) => s.done === false),
  `done=${allGood.filter((s) => s.done).length}/${allGood.length}`);
chk('步骤数量合理（8~12 步）', allGood.length >= 8 && allGood.length <= 12, String(allGood.length));

/* 2) 每步都必须有 id / title / why，且 id 唯一 */
chk('每步都有 id', allGood.every((s) => typeof s.id === 'string' && s.id));
chk('每步都有 title', allGood.every((s) => typeof s.title === 'string' && s.title));
chk('每步都有 why（要说清为什么需要它）', allGood.every((s) => typeof s.why === 'string' && s.why.length > 8));
chk('id 不重复', new Set(allGood.map((s) => s.id)).size === allGood.length);

/* 3) ★ 纯只读：步骤里的动作只允许跳转/复制/打开，不允许改文件 */
const ALLOWED = new Set(['external', 'maibot-webui', 'copy-token', 'copy', 'route']);
const allKinds = allGood.flatMap((s) => (s.actions || []).map((a) => a.kind));
chk('★ 引导里只有只读动作（不写文件）', allKinds.every((k) => ALLOWED.has(k)),
  [...new Set(allKinds)].join(','));
chk('确实存在可执行的跳转动作', allKinds.length > 0, `${allKinds.length} 个动作`);

/* 4) ★ 版本不受支持时必须给出重装路径，且排在任何"连接"步骤之前 */
const oldEnv = {
  ...emptyEnv,
  maibotVersion: { kind: 'unsupported', version: '0.6.x', message: '0.6.x 不受支持', evidence: ['src/heart_flow'] }
};
const oldSteps = buildSteps({ env: oldEnv, doneIds: [], docs: DOCS });
const vIdx = oldSteps.findIndex((s) => s.id === STEP_IDS.version);
/*
  协议端只剩 SnowLuma，所以"接线"那一组步骤的入口是 snowluma / adapter。
  取两者中先出现的那一步做对比即可 —— 版本判错必须排在它们之前。
*/
const wireIdx = oldSteps.findIndex((s) => s.id === STEP_IDS.snowluma || s.id === STEP_IDS.adapter);
chk('版本步骤存在', vIdx >= 0, String(vIdx));
chk('★ 版本步骤排在任何协议端接线步骤之前', vIdx >= 0 && wireIdx >= 0 && vIdx < wireIdx,
  `version=${vIdx} wire=${wireIdx}`);
chk('★ 不受支持时给出明确警告', Boolean(oldSteps[vIdx].warn), String(oldSteps[vIdx].warn).slice(0, 30));
chk('★ 不受支持时给出重装动作',
  (oldSteps[vIdx].actions || []).some((a) => a.kind === 'route' || a.kind === 'external'));
chk('版本不受支持时 ready 为 false', oldSteps[vIdx].ready === false);

/* 5) 协议坑与名单坑必须被写进引导（官方文档点名的两大故障源） */
const allText = allGood.map((s) => `${s.title} ${s.why} ${s.warn || ''} ${(s.facts || []).map((f) => f.text).join(' ')}`).join('\n');
chk('★ 提到首次启动要输入「同意」（不是 yes/y）', /同意/.test(allText) && /不是\s*yes|yes\s*或\s*y|输入\s*yes/.test(allText));
chk('★ 提到 WebUI 端口 8001', /8001/.test(allText));
chk('★ 提到 WebUI Token 每次启动都会变', /每次/.test(allText) && /Token/.test(allText));
chk('★ 提到模型必须先配（否则不回复）', /模型/.test(allText) && /不(会)?回复/.test(allText));
chk('★ 提醒适配器必须启用（没启用就连不上）', /enabled/.test(allText) && /必须|启用|才会/.test(allText));
chk('★ 提到群聊名单为空会丢弃所有消息', /名单/.test(allText) && /丢弃|丢掉|没反应/.test(allText));

/* 6) 真实环境下的表现：用户当前是 0.6.x，第一步之后就该被拦下 */
if (hasRealOld) {
  const realEnv = { ...emptyEnv, maibotVersion: env.detectMaiBotVersion(REAL_OLD) };
  const realSteps = buildSteps({ env: realEnv, doneIds: [], docs: DOCS });
  const rv = realSteps.find((s) => s.id === STEP_IDS.version);
  chk('真实 0.6.x 环境下版本步骤给出警告', Boolean(rv.warn), String(rv.warn).slice(0, 34));
  chk('真实环境下仍不自动勾选任何一步', realSteps.every((s) => s.done === false));
} else {
  skip('真实环境下的版本拦截', '磁盘上没有 0.6.x 安装');
}

/* 7) 用户手动标记后必须真的生效（done 只由 doneIds 决定） */
const marked = buildSteps({ env: emptyEnv, doneIds: [STEP_IDS.tools], docs: DOCS });
chk('用户标记后该步 done=true', marked.find((s) => s.id === STEP_IDS.tools).done === true);
chk('未标记的步骤仍为 false', marked.filter((s) => s.done).length === 1);

/* ============================================================================
   开关逻辑（gate.js）：防"关掉就再也打不开"
   --------------------------------------------------------------------------
   这是用户实际报的 bug：抽屉收起后入口直接消失。
   这类问题不会报错，只会让入口静默不见，所以必须逐状态断言。
   ========================================================================== */
console.log('[onboarding] 引导开关：收起之后必须还能再打开');

const gateMod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/onboarding/gate.js')).href);
const { KEYS, readState, decideAutoOpen, decideMode, badgeText } = gateMod;

/** 造一个 localStorage 的假实现 */
const fakeStore = (obj) => (k) => (k in obj ? obj[k] : null);
const TOTAL = allGood.length;

/* —— 最核心的不变量 —— */
{
  /*
    decideAutoOpen 的返回值里**不允许**出现任何"禁止手动打开"的语义。
    只检查 reason: 'dismissed' 之类的字段不存在是不够的，
    关键是：无论 autoOpened 是什么，手动打开（decideMode）都必须给出形态。
  */
  const closedState = readState(fakeStore({ [KEYS.autoOpened]: '1' }), TOTAL);
  chk('★ 已自动弹过 → 不自动展开', decideAutoOpen(closedState).open === false, decideAutoOpen(closedState).reason);
  chk('★ 但状态里仍然有完整信息可供手动打开', typeof closedState.doneCount === 'number' && closedState.total === TOTAL);
  chk('★ 手动打开时仍能给出形态（不是被永久禁用）',
    ['guide', 'reference'].includes(decideMode(closedState, undefined)), decideMode(closedState, undefined));

  /* 旧版本的 dismissed 键必须只等价于"弹过"，不能变成"禁用" */
  const legacy = readState(fakeStore({ [KEYS.legacyDismissed]: '1' }), TOTAL);
  chk('★ 旧 dismissed 键只算"弹过"，仍可手动打开',
    decideAutoOpen(legacy).open === false && ['guide', 'reference'].includes(decideMode(legacy, 'guide')));
}

/* —— 各种状态组合 —— */
{
  const first = readState(fakeStore({}), TOTAL);
  chk('全新用户 → 自动展开', decideAutoOpen(first).open === true, decideAutoOpen(first).reason);
  chk('且要求写入"已弹过"标记（避免下次再弹）', decideAutoOpen(first).markAutoOpened === true);

  const sup = readState(fakeStore({ [KEYS.suppress]: '1' }), TOTAL);
  chk('自检环境 → 不自动展开', decideAutoOpen(sup).open === false && decideAutoOpen(sup).reason === 'suppressed');
  chk('★ 自检环境也不写标记（别把测试状态持久化给真实用户）', decideAutoOpen(sup).markAutoOpened === false);

  const all = readState(fakeStore({ [KEYS.doneIds]: JSON.stringify(allGood.map((s) => s.id)) }), TOTAL);
  chk('全部完成 → 不自动展开', decideAutoOpen(all).open === false && decideAutoOpen(all).reason === 'completed');
  chk('★ 全部完成 → 手动打开是只读参考资料', decideMode(all, undefined) === 'reference', decideMode(all, undefined));
  chk('★ 但显式要求 guide 时仍给 guide（不被强行只读）', decideMode(all, 'guide') === 'guide');

  const partial = readState(fakeStore({ [KEYS.doneIds]: JSON.stringify([STEP_IDS.tools]) }), TOTAL);
  chk('部分完成 → 手动打开是交互式引导', decideMode(partial, undefined) === 'guide');
  chk('部分完成时进度被正确读出', partial.doneCount === 1 && partial.total === TOTAL, `${partial.doneCount}/${partial.total}`);
}

/* —— 防御性：坏数据不能炸 —— */
{
  const bad1 = readState(fakeStore({ [KEYS.doneIds]: '不是JSON' }), TOTAL);
  chk('doneIds 是坏 JSON → 当作空，不抛', bad1.doneCount === 0);
  const bad2 = readState(fakeStore({ [KEYS.doneIds]: '{"a":1}' }), TOTAL);
  chk('doneIds 不是数组 → 当作空', bad2.doneCount === 0);
  const bad3 = readState(fakeStore({ [KEYS.doneIds]: '[1,2,"x",null]' }), TOTAL);
  chk('doneIds 里混入非字符串 → 只留字符串', bad3.doneCount === 1, String(bad3.doneCount));
  const bad4 = readState(fakeStore({}), 0);
  chk('总步数为 0 → allDone=false（不能空集算全部完成）', bad4.allDone === false);
  chk('总步数为 0 → 徽标不显示内容', badgeText(bad4) === '', badgeText(bad4));
}

/* —— 徽标 —— */
{
  chk('未完成 → 显示 x/y', badgeText(readState(fakeStore({ [KEYS.doneIds]: JSON.stringify([STEP_IDS.tools]) }), TOTAL)) === `1/${TOTAL}`);
  chk('全部完成 → 显示 ✓', badgeText(readState(fakeStore({ [KEYS.doneIds]: JSON.stringify(allGood.map((s) => s.id)) }), TOTAL)) === '✓');
}

/* —— 源码级守卫：外壳里不能再出现"关掉就删掉入口"的写法 —— */
{
  const layout = fs.readFileSync(path.join(ROOT, 'src/renderer/components/AppLayout.vue'), 'utf8');
  chk('★ 外壳里有常驻的「新手引导」入口按钮', /新手引导/.test(layout) && /openGuide/.test(layout));
  chk('★ 入口不依赖"是否被关过"这类条件（不能收起就消失）',
    !/v-if="[^"]*onboardingResumable/.test(layout));
  chk('★ 已删除旧的浮动入口（resume-wiz）', !/resume-wiz/.test(layout));
  const store = fs.readFileSync(path.join(ROOT, 'src/renderer/stores/app-store.js'), 'utf8');
  chk('★ store 导出 openOnboarding（手动入口存在）', /export function openOnboarding/.test(store));
  chk('★ dismissOnboarding 不再清掉手动打开的能力（只写 autoOpened 标记）',
    /export function dismissOnboarding[\s\S]{0,400}?onboardingOpen = false/.test(store));
}

for (const d of tmpRoots) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
}

if (bad) {
  console.error(`\n[onboarding] ✗ ${bad} 项失败${skipped ? `（另有 ${skipped} 项跳过）` : ''}`);
  process.exit(1);
}
console.log(`\n[onboarding] ✓ 全部通过${skipped ? `（${skipped} 项因缺少真实安装而跳过）` : ''}`);
