/*
================================================================================
脚本：scripts/verify-identity.mjs
职责：验证 bot_config.toml 的 platform / qq_account 对齐是**安全**的。
================================================================================
  为什么这个测试比别的更重要：
    这是整个项目里唯一一个"会改用户已有配置文件"的操作，而且改的是
    MaiBot 的核心配置。写错的后果不是报错，而是**静默的语义错误**：
    麦麦把自己的消息当成别人发的，用户完全看不出原因。

  必须守住的不变量：
    1) 0.6.x 结构（[bot] qq = <数字>）→ **拒绝写入**。那个版本不读
       qq_account，写进去只会制造"看起来配好了"的假象。
       —— 这正是本项目最忌讳的那种"假装修好了"。
    2) 已有非空 qq_account → 不改（尊重用户配置）
    3) 只动 [bot] 段内两个键，其余字节（注释、排版、别的段）原样保留
    4) 改写前必须留下备份
    5) 原子写：不留下半截文件
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mc = require(path.join(ROOT, 'src/main/services/maibot-connect.js'));

let bad = 0;
const chk = (name, ok, extra) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  → ${extra}` : ''}`);
  if (!ok) bad += 1;
};

/** 造一个临时 MaiBot 目录并把给定文本写成 config/bot_config.toml */
function mk(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  const file = path.join(dir, 'config', 'bot_config.toml');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file };
}

/*
  1.2.x 的形状：`[bot] qq_account = "<字符串>"`，平台走适配器插件。
  ⚠️ 这里**不能**有真实的 [platforms] 段 —— 那是 0.6.x 走 URL 直连的遗留物，
  带着它会被正确地判成 0.6.x 并拒绝写入（我第一版 fixture 就踩了这个坑，
  测试失败其实是代码判对了、fixture 写错了）。
  另外带一段"注释里提到 [platforms]"来守卫注释误判。
*/
const TPL_12 = `# MaiBot 配置
[bot]
platform = "qq"
qq_account = ""
nickname = "麦麦"
alias_names = ["麦麦"]

[personality]
prompt = "你很可爱"

# 说明：1.2.x 走适配器插件，不需要 [platforms] 段
`;

const QQ = '123456789';

console.log('[identity] 1.2.x：空的 qq_account 应被填上');
{
  const { dir, file } = mk(TPL_12);
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('ok=true', r.ok === true, r.action);
  chk('action=fixed', r.action === 'fixed', r.action);
  const after = fs.readFileSync(file, 'utf8');
  chk('qq_account 被填成目标号', new RegExp(`qq_account\\s*=\\s*"${QQ}"`).test(after));
  chk('★ platform 是 qq', /platform\s*=\s*"qq"/.test(after));
  chk('★ 注释与其它段原样保留（没有重新序列化）',
    after.includes('# MaiBot 配置') && after.includes('[personality]') && after.includes('# 说明：1.2.x 走适配器插件'));
  chk('nickname 等其它键未被碰', /nickname\s*=\s*"麦麦"/.test(after));
  const baks = fs.readdirSync(path.join(dir, 'config')).filter((f) => f.includes('.bak-'));
  chk('★ 改写前留下了备份', baks.length === 1, baks.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] ★ 0.6.x：必须拒绝写入（最重要的一条）');
{
  const tpl06 = `[bot]
qq = 1145141919810
nickname = "麦麦"

[platforms]
nonebot-qq = "http://127.0.0.1:18002/api/message"
`;
  const { dir, file } = mk(tpl06);
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('ok=false（拒绝）', r.ok === false, r.action);
  chk('action=unsupported-schema', r.action === 'unsupported-schema', r.action);
  chk('说明里点出 qq_account 这个版本不读', /不(会)?读|不读/.test(r.message), r.message.slice(0, 40));
  const after = fs.readFileSync(file, 'utf8');
  chk('★ 文件字节完全未变（连备份都没产生）', after === tpl06);
  chk('★ 没有偷偷插入 qq_account', !after.includes('qq_account'));
  const baks = fs.readdirSync(path.join(dir, 'config')).filter((f) => f.includes('.bak-'));
  chk('没有产生备份（说明根本没写）', baks.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] 已有非空 qq_account：尊重用户不改');
{
  const tpl = TPL_12.replace('qq_account = ""', 'qq_account = "999888777"');
  const { dir, file } = mk(tpl);
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('action=kept-conflict', r.action === 'kept-conflict', r.action);
  chk('说明了不一致但没改', /不一致/.test(r.message), r.message.slice(0, 40));
  chk('★ 原值被保留', fs.readFileSync(file, 'utf8').includes('"999888777"'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] 已是目标值：幂等，不写文件');
{
  const tpl = TPL_12.replace('qq_account = ""', `qq_account = "${QQ}"`);
  const { dir, file } = mk(tpl);
  const before = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 12));
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('action=kept', r.action === 'kept', r.action);
  chk('★ 文件未被重写（mtime 未变）', fs.statSync(file).mtimeMs === before);
  chk('没有产生备份', fs.readdirSync(path.join(dir, 'config')).filter((f) => f.includes('.bak-')).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] platform 写错时要被纠正');
{
  const tpl = TPL_12.replace('platform = "qq"', 'platform = "onebot"');
  const { dir } = mk(tpl);
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('action=fixed', r.action === 'fixed', r.action);
  chk('platform 被纠正为 qq', /platform\s*=\s*"qq"/.test(fs.readFileSync(r.file, 'utf8')));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] 缺少 platform / qq_account 键 → 新增而不是报错');
{
  const tpl = `[bot]
nickname = "麦麦"

[personality]
prompt = "x"
`;
  const { dir, file } = mk(tpl);
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('ok=true', r.ok === true, r.action);
  const after = fs.readFileSync(file, 'utf8');
  chk('两个键都被新增', /qq_account\s*=\s*"/.test(after) && /platform\s*=\s*"qq"/.test(after));
  chk('★ 新增的键落在 [bot] 段内（不在 [personality] 之后）',
    after.indexOf('qq_account') < after.indexOf('[personality]'),
    `qq@${after.indexOf('qq_account')} personality@${after.indexOf('[personality]')}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] 拒绝非法输入（不能把垃圾写进配置）');
{
  const { dir, file } = mk(TPL_12);
  const before = fs.readFileSync(file, 'utf8');
  for (const [name, val] of [['空', ''], ['非数字', 'abc'], ['太短', '12'], ['太长', '1'.repeat(20)], ['带引号注入', '12"34']]) {
    const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: val });
    chk(`${name} → 拒绝`, r.ok === false && r.action === 'bad-qq', r.action);
  }
  chk('★ 非法输入后文件未变', fs.readFileSync(file, 'utf8') === before);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] 异常路径不抛');
{
  chk('空目录参数 → 结构化失败', (await mc.ensureMaiBotBotIdentity('', { qqAccount: QQ })).ok === false);
  chk('目录不存在 → 结构化失败', (await mc.ensureMaiBotBotIdentity('Z:\\__nope__', { qqAccount: QQ })).ok === false);
  const { dir } = mk('[personality]\nprompt = "x"\n');
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  /*
    这份配置既没有 [bot] 也没有任何版本标记 → 判 unknown，
    必须在**写入之前**就拒绝，而不是靠"找不到 [bot] 段"兜底。
  */
  chk('无版本线索 → 拒绝（unknown-schema）', r.ok === false && r.action === 'unknown-schema', r.action);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] schema 判定');
{
  chk('1.2.x → 1.2.x', mc.detectBotSchema('[bot]\nqq_account = ""\n') === '1.2.x');
  chk('0.6.x → 0.6.x', mc.detectBotSchema('[bot]\nqq = 1145141919810\n') === '0.6.x');
  chk('0.6.x 的 qq 带注释也认得出', mc.detectBotSchema('[bot]\nqq = 10001 # 我的号\n') === '0.6.x');
  chk('都不是 → unknown', mc.detectBotSchema('[personality]\nprompt="x"\n') === 'unknown');
  /*
    混合态（0.6.x 底子 + 用户手加了 qq_account）必须按 0.6.x 处理。
    如果按 1.2.x 处理，我们会写出一个"看着对、那个版本根本不读"的配置 ——
    正是要消灭的假象。
  */
  chk('★ 混合态判为 0.6.x（那个版本不读 qq_account）',
    mc.detectBotSchema('[bot]\nqq = 123\nqq_account = "456"\n') === '0.6.x',
    mc.detectBotSchema('[bot]\nqq = 123\nqq_account = "456"\n'));
  chk('★ 有 [platforms] 段也判为 0.6.x（1.2.x 用适配器插件，没这段）',
    mc.detectBotSchema('[bot]\nnickname = "x"\n\n[platforms]\nnonebot-qq = "http://x"\n') === '0.6.x');
  chk('缺 qq_account 但有 [bot]+字符串 nickname → 仍判 1.2.x（升级上来的配置也要能对齐）',
    mc.detectBotSchema('[bot]\nnickname = "麦麦"\n') === '1.2.x');
  /*
    这条是被真实 bug 逼出来的：注释里出现 [platforms] 曾被误判成 0.6.x，
    导致正常的 1.2.x 配置被拒绝对齐。配置文件里注释提到段名太常见了。
  */
  chk('★ 注释里的 [platforms] 不算段（不能据此判 0.6.x）',
    mc.detectBotSchema('[bot]\nqq_account = ""\n# [platforms] 这一段在 1.2.x 已经没有用了\n') === '1.2.x');
  chk('★ hasSection 忽略注释行', mc.hasSection('# [platforms]\n', 'platforms') === false);
  chk('★ hasSection 认得真实段头', mc.hasSection('[platforms]\nx = 1\n', 'platforms') === true);
  chk('★ hasSection 不被缩进注释骗过', mc.hasSection('  # [platforms]\n', 'platforms') === false);
}

console.log('[identity] ★ 混合态必须走拒绝路径（不能写出"看着对但不生效"的配置）');
{
  const mixed = `[bot]
qq = 1145141919810
qq_account = ""
nickname = "麦麦"
`;
  const { dir, file } = mk(mixed);
  const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
  chk('拒绝写入', r.ok === false && r.action === 'unsupported-schema', r.action);
  chk('★ 空的 qq_account 没被偷偷填上', fs.readFileSync(file, 'utf8').includes('qq_account = ""'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('[identity] ★ 用磁盘上真实的 0.6.x 模板做端到端验证（最有说服力的一条）');
/* 未执行的断言条数：必须让"通过"这两个字不能覆盖"没验" */
let skipped = 0;
{
  /*
    候选路径：磁盘上真实存在的 0.6.x 模板（用来证伪"我以为 0.6.x 长什么样"）。

    ⚠️ 这里原来只写死了一个 D:\\ 路径：文件不存在就打印一行"跳过"，
    而整个套件的总结行照旧显示"全部通过" —— 下面 5 条断言
    （包括它自己标注的"最有说服力的一条"）就这样无声消失了，
    读日志的人只会以为这一段验过了。
    "跳过"和"通过"必须是两件事：找不到就按候选顺序再找一遍，
    实在找不到就**把未执行的断言条数打出来**，并计入下面的 skipped 计数。
  */
  const candidates = [
    'D:\\文件夹\\MaiM-with-u\\MaiBot\\template\\bot_config_template.toml',
    path.join(os.homedir(), 'Desktop', 'MaiM-with-u', 'MaiBot', 'template', 'bot_config_template.toml'),
    path.join(os.homedir(), 'Desktop', '桌面所有文件夹', 'MaiM-with-u', 'MaiBot', 'template', 'bot_config_template.toml')
  ];
  const real = candidates.find((p) => fs.existsSync(p));
  if (!real) {
    const unrun = 5;
    skipped += unrun;
    console.log(`  ⚠ 未执行 ${unrun} 条断言：候选路径里都没有真实的 0.6.x 模板`);
    for (const p of candidates) console.log(`      · ${p}`);
    console.log('      （这一节专门用真实模板证伪假设，缺失时结果不完整 —— 不是"通过"）');
  } else {
    const text = fs.readFileSync(real, 'utf8');
    chk('真实模板判为 0.6.x', mc.detectBotSchema(text) === '0.6.x', mc.detectBotSchema(text));
    chk('真实模板确实有 qq = <整数>', /^\s*qq\s*=\s*\d+/m.test(text));

    /* 把它当成真实配置放进临时目录，走完整写入流程 */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real06-'));
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    const file = path.join(dir, 'config', 'bot_config.toml');
    fs.writeFileSync(file, text, 'utf8');
    const r = await mc.ensureMaiBotBotIdentity(dir, { qqAccount: QQ });
    chk('★ 真实 0.6.x 配置被拒绝写入', r.ok === false && r.action === 'unsupported-schema', r.action);
    chk('★ 真实文件字节完全未变', fs.readFileSync(file, 'utf8') === text);
    chk('★ 没有产生任何备份文件（根本没写）',
      fs.readdirSync(path.join(dir, 'config')).filter((f) => f.includes('.bak-')).length === 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (bad) {
  console.error(`\n[identity] ✗ ${bad} 项失败`);
  process.exit(1);
}
/*
  总结行必须暴露"有未执行的断言"。
  原来无论跳过多少条，这里都打印"全部通过" —— 于是"跳过"在日志里
  与"通过"长得一模一样，这个套件最该防的就是这种假信号。
*/
console.log(
  skipped
    ? `\n[identity] ⚠ 通过，但有 ${skipped} 条断言**未执行**（环境缺失，见上方警告）`
    : '\n[identity] ✓ 全部通过'
);
