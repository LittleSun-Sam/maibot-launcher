/*
  实机/契约校验：Python 依赖检查的编码健壮性。
  ─────────────────────────────────────────────────────────────────────
  这个脚本是为一个**真实故障**写的回归测试：

    用户机器上的 MaiBot/requirements.txt 是 UTF-16 LE（开头 FF FE）。
    prereq.js 原先一律 fsp.readFile(p, 'utf8')，于是每一行变成
    "\uFEFFA\u0000P\u0000S\u0000c\u0000h\u0000e\u0000d\u0000u\u0000l\u0000e\u0000r\u0000"
    这种夹 NUL 的垃圾。"包名"永远匹配不上 pip list 里的任何一项，
    依赖检查因此**恒定报告 0/42 已满足**，把已经装好的
    aiohttp / loguru / numpy / pillow / pydantic / requests / setuptools
    全列成"缺少"，用户按提示去装就是白装一遍。

  这类 bug 的特点是：页面一切正常、没有报错、数字也"有值"，
  只是值是错的 —— 只有专门断言编码才能拦住，所以单独成组。
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-deps-'));
const Module = require('module');
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userData, getVersion: () => '2.1.0', isPackaged: false } };
  }
  return realLoad.call(this, request, parent, isMain);
};

const prereq = require(path.join(ROOT, 'src/main/services/prereq.js'));

/** 按指定编码写一个 requirements.txt，返回所在目录 */
function makeDir(name, content, encoding) {
  const dir = path.join(userData, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'requirements.txt');
  if (encoding === 'utf16le') {
    /* 带 BOM 的 UTF-16 LE —— 正是用户机器上那份的编码 */
    const bom = Buffer.from([0xff, 0xfe]);
    fs.writeFileSync(file, Buffer.concat([bom, Buffer.from(content, 'utf16le')]));
  } else if (encoding === 'utf16le-nobom') {
    fs.writeFileSync(file, Buffer.from(content, 'utf16le'));
  } else if (encoding === 'utf16be') {
    /* 手工造 UTF-16 BE：逐字符高字节在前，前面加 FE FF */
    const le = Buffer.from(content, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  } else if (encoding === 'utf8bom') {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]));
  } else {
    fs.writeFileSync(file, content, 'utf8');
  }
  return dir;
}

/* 与用户机器上那份 requirements.txt 同构的样例内容 */
const SAMPLE = 'APScheduler\nPillow\naiohttp\nloguru\nnumpy\n';
const EXPECTED = ['apscheduler', 'pillow', 'aiohttp', 'loguru', 'numpy'];

/* ================================================ ① 解码：各种编码都要认 */
console.log('[deps] ① requirements.txt 编码解码');
{
  const cases = [
    ['utf16le（带 BOM，用户机器上的真实情况）', 'utf16le'],
    ['utf16le（无 BOM）', 'utf16le-nobom'],
    ['utf16be（带 BOM）', 'utf16be'],
    ['utf8（带 BOM）', 'utf8bom'],
    ['utf8（无 BOM，正常情况）', 'utf8']
  ];
  for (const [label, encoding] of cases) {
    const dir = makeDir(`dec-${encoding}`, SAMPLE, encoding);
    const buf = fs.readFileSync(path.join(dir, 'requirements.txt'));
    const text = prereq.decodeTextFile(buf);
    const names = prereq.parseRequirements(text);
    chk(
      `★ ${label} → 解析出正确的包名`,
      JSON.stringify(names) === JSON.stringify(EXPECTED),
      JSON.stringify(names)
    );
    chk(`  ${label} → 不含 NUL / BOM 残留`, !/[\uFEFF]/.test(text) && !text.includes('\u0000'));
  }
}

/* ================================================ ② 端到端：checkDependencies */
console.log('\n[deps] ② checkDependencies 端到端（真实读盘 + 真实 pip list）');
{
  const dirU16 = makeDir('full-utf16', SAMPLE, 'utf16le');
  const dirU8 = makeDir('full-utf8', SAMPLE, 'utf8');

  const rU16 = await prereq.checkDependencies(dirU16, 'python', { mode: 'full' });
  const rU8 = await prereq.checkDependencies(dirU8, 'python', { mode: 'full' });

  chk('★ UTF-16 文件被识别为 requirements.txt 来源', rU16.source === 'requirements.txt', rU16.source);
  chk(
    '★ 依赖名与文件内容一致（修复前这里是夹 NUL 的乱码）',
    JSON.stringify(rU16.dependencies.map((d) => d.name)) === JSON.stringify(EXPECTED),
    JSON.stringify(rU16.dependencies.map((d) => d.name))
  );
  chk(
    '★ UTF-16 与 UTF-8 两份同内容文件得到完全一致的结果',
    JSON.stringify(rU16.dependencies) === JSON.stringify(rU8.dependencies)
  );

  /*
    最关键的一条：修复前 installedCount 恒为 0（"0/N 已满足"）。
    这里断言"至少认出了已安装的包" —— 只要 machine 上装了 aiohttp/loguru/
    numpy/pillow 里的任意一个成立即可。这些包在跑 MaiBot 的机器上必然存在，
    而修复前的结果是 0，所以这条断言对本次修复是**必要且充分**的判别。
  */
  chk(
    '★ 不再恒定报告 0 个已满足（修复前的症状）',
    rU16.installedCount > 0,
    `installedCount=${rU16.installedCount} missingCount=${rU16.missingCount}`
  );
  chk(
    '★ 至少认出 aiohttp/loguru/numpy/pillow 中已装的那些',
    rU16.dependencies.some((d) => d.ok),
    rU16.dependencies.filter((d) => d.ok).map((d) => `${d.name}@${d.installed}`).join(', ') || '（一个都没认出）'
  );
}

/* ================================================ ③ 包名归一化（PEP 503） */
console.log('\n[deps] ③ 包名归一化：- _ . 是同一个包');
{
  /*
    实测故障：pip list 里登记的是 quick-algo，requirements.txt 里写的是 quick_algo。
    PEP 503 规定 - _ . 三者等价，它们就是同一个包；老代码拿小写字符串直接比，
    于是已装好的包被判成"缺少"，安装页那条红字**点多少次安装都消不掉**。
  */
  const eq = (a, b) => prereq.canonName(a) === prereq.canonName(b);
  chk('★ quick_algo 与 quick-algo 视为同一个包', eq('quick_algo', 'quick-algo'), prereq.canonName('quick_algo'));
  chk('★ tomli_w 与 tomli-w 视为同一个包', eq('tomli_w', 'tomli-w'));
  chk('★ Foo.Bar 与 foo-bar 视为同一个包', eq('Foo.Bar', 'foo-bar'), prereq.canonName('Foo.Bar'));
  chk('★ 大小写不敏感', eq('Pillow', 'pillow'));
  chk('★ 多个分隔符折叠', prereq.canonName('a__b..c--d') === 'a-b-c-d', prereq.canonName('a__b..c--d'));
  chk('★ 不同包不会被归一化到一起', !eq('pyyaml', 'pyaml'));
  chk('★ 空值安全', prereq.canonName(null) === '' && prereq.canonName(undefined) === '');

  /*
    更强的端到端断言：requirements.txt 里故意写 quick_algo（下划线），
    而 pip 分发名是 quick-algo。真装了的话，full 模式必须认出来。
    没装则该包本来就该报缺少，跳过这条（避免依赖测试机环境）。
  */
  const probeDir = makeDir('canon', 'quick_algo\n', 'utf8');
  const rCanon = await prereq.checkDependencies(probeDir, 'python', { mode: 'full' });
  const dep = rCanon.dependencies[0];
  if (dep && dep.ok) {
    chk('★ requirements 写下划线、pip 登记连字符 → full 模式仍认出已安装', true, `${dep.name}@${dep.installed}`);
  } else {
    console.log('  · 跳过：本机未安装 quick-algo（下划线/连字符等价断言已在上面覆盖）');
  }
}

/* ================================================ ④ full 与 quick 必须一致 */
console.log('\n[deps] ④ full / quick 两种模式结论必须一致');
{
  /*
    这是最能抓住"快速检查在骗人"的断言：
    修复前 full 说 40/41、quick 说 38/41 —— 同一台机器、同一份 requirements，
    两个模式给出不同答案，而 quick 才是安装页一进来就显示的那个。
    quick 之所以错，是因为它去 import 猜出来的名字（faiss_cpu / strawberry_graphql
    这种根本不存在的模块名），而不是查分发元数据。
  */
  const dir = makeDir('modes', 'pillow\npyyaml\nrequests\n', 'utf8');
  const full = await prereq.checkDependencies(dir, 'python', { mode: 'full' });
  const quick = await prereq.checkDependencies(dir, 'python', { mode: 'quick' });

  chk(
    '★ 两种模式判定出的"已安装/缺少"集合一致',
    JSON.stringify([...full.missing].sort()) === JSON.stringify([...quick.missing].sort()),
    `full=[${full.missing}] quick=[${quick.missing}]`
  );
  chk(
    '★ quick 模式也能给出真实版本号（修复前恒为空）',
    quick.dependencies.some((d) => d.ok && d.installed),
    quick.dependencies.filter((d) => d.installed).map((d) => `${d.name}@${d.installed}`).join(', ') || '（全为空）'
  );
  chk(
    '★ quick 模式识别 pip 名与 import 名不一致的包（pillow→PIL / pyyaml→yaml）',
    quick.dependencies.every((d) => d.ok),
    quick.dependencies.map((d) => `${d.name}=${d.ok ? d.installed : '缺'}`).join(', ')
  );
}

/* ================================================ ⑤ 异常输入不能崩、不能装作正常 */
console.log('\n[deps] ⑤ 异常输入');
{
  /* 空文件：解析不出包名 → 应回退内置清单，而不是报 0 个依赖 */
  const emptyDir = makeDir('empty', '', 'utf8');
  const rEmpty = await prereq.checkDependencies(emptyDir, 'python', { mode: 'full' });
  chk('★ 空 requirements.txt → 回退内置清单（source=builtin）', rEmpty.source === 'builtin', rEmpty.source);
  chk('★ 空文件不会得到 0 项依赖', rEmpty.dependencies.length > 0, String(rEmpty.dependencies.length));

  /* 全是注释与选项行 */
  chk(
    '★ 纯注释/选项行解析为空',
    prereq.parseRequirements('# 注释\n-r other.txt\n\n').length === 0
  );

  /* 注释与 extras、版本约束混排 */
  chk(
    '★ 版本约束 / extras / 行内注释被正确剥离',
    JSON.stringify(prereq.parseRequirements('foo[bar]>=1.2  # 说明\nbaz==2.0 ; python_version>"3.10"\n')) ===
      JSON.stringify(['foo', 'baz']),
    JSON.stringify(prereq.parseRequirements('foo[bar]>=1.2  # 说明\nbaz==2.0 ; python_version>"3.10"\n'))
  );

  /* 乱码残渣不应被当成包名 */
  const junk = prereq.parseRequirements('\u0000\u0000\uFEFF\n!!!\n@@@\n');
  chk('★ 纯乱码不会产生假包名', junk.length === 0, JSON.stringify(junk));

  /* 不存在的目录：应回退内置清单而不是抛异常 */
  const rNoDir = await prereq.checkDependencies(path.join(userData, 'does-not-exist'), 'python', {
    mode: 'full'
  });
  chk('★ 目标目录不存在时回退内置清单且不抛异常', rNoDir.source === 'builtin', rNoDir.source);
}

console.log(`\n[deps] ${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}  通过=${pass} 失败=${fail}`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
