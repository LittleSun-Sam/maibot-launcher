/*
打包产物验证（打包态）
================================================================================
为什么必须有这个脚本
--------------------------------------------------------------------------------
`windows.js:74`、`tray.js:32-40`、`process.js:334` 这三处**只在打包态生效**
（它们都判断 process.resourcesPath 是否存在），而其余 verify 脚本把 electron
桩成 isPackaged:false（纯 Node 下 resourcesPath 实测是 undefined）。
结果是：extraResources 写错、图标改名、垫片漏打包，门禁**全都还是绿的**，
而正式版会静默降级 —— 没窗口图标、没托盘图标、MaiBot 的彩色日志全丢。

所以这里不看源码、只查**真实产物**：
  1) release/win-unpacked 是否存在（不存在就明确说"未打包，跳过"，不假装通过）
  2) 主程序与 app.asar
  3) extraResources 那 5 项是否真的落在 resources/ 下
  4) 垫片内容是否真会生效（含 colorama 补丁），且没有被 __pycache__ 污染
  5) 终端依赖的 node-pty 原生部分是否随包带出（asar.unpacked）

用法：node scripts/verify-packaged-assets.mjs
退出码：0 = 全部通过（或未打包，已显式说明）；1 = 有失败项
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked');
const RES = path.join(UNPACKED, 'resources');

let pass = 0;
let fail = 0;
const ok = (msg) => {
  pass += 1;
  console.log(`  ✓ ${msg}`);
};
const bad = (msg, detail) => {
  fail += 1;
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`      ${detail}`);
};

console.log('[packaged] 校验打包产物…');

if (!fs.existsSync(UNPACKED)) {
  /*
    没有产物时**不静默通过**：明确打一行警告说清楚"这次没验证打包态"，
    否则整条 verify 链会给人"打包态也没问题"的错觉。
  */
  console.log('  ⚠ release/win-unpacked 不存在 —— 本次未验证打包态。');
  console.log('    打包后请重跑：npm run dist:fast && node scripts/verify-packaged-assets.mjs');
  console.log(`[packaged] 通过=${pass} 失败=${fail}（跳过打包态校验）`);
  process.exit(0);
}

/* ---- 1) 主程序与 asar ---- */
const exe = path.join(UNPACKED, 'MaiBot Launcher.exe');
fs.existsSync(exe) ? ok('主程序 MaiBot Launcher.exe 存在') : bad('缺少主程序 exe');
/**
 * 读出 asar 里真实存在的文件清单。
 *
 * 注意：**不能用整串搜索**。asar 头部是一段 JSON 索引，而且目录是**嵌套**的
 * （{"files":{"dist":{"files":{"renderer":{"files":{"index.html":…}}}}}}），
 * 完整路径 "dist/renderer/index.html" 根本不会作为子串出现。
 * 我第一版就是整串搜索，于是把 preload 与 renderer 都判成"缺失" ——
 * 而包里其实有（唯一命中的 "dist/main/main.cjs" 是 package.json 的 main 字段）；
 * 一次假失败就足以让人不再信这个脚本，所以老老实实解析头部。
 */
function readAsarEntries(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    /* asar 头部：前 4 字节是头部长度字段本身的长度，偏移 12 处是 JSON 长度 */
    const headerSize = head.readUInt32LE(12);
    if (!headerSize || headerSize > 64 * 1024 * 1024) throw new Error(`asar 头部长度异常: ${headerSize}`);
    const jsonBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, jsonBuf, 0, headerSize, 16);
    const raw = jsonBuf.toString('utf8');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const out = new Set();
    const walk = (node, prefix) => {
      for (const [name, v] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (v && v.files) walk(v, p);
        else out.add(p);
      }
    };
    walk(json, '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

const asar = path.join(RES, 'app.asar');
if (fs.existsSync(asar)) {
  const size = fs.statSync(asar).size;
  /*
    用**内容**判断，不要用体积。
    我第一版写的是"大于 1MB 才算正常" —— 实测这个包只有 965KB，于是报了一次假失败。
    原因很简单：重的东西（node-pty 等原生件）都在 app.asar.unpacked 里，
    代码本身只有几百 KB。用体积当代理指标早晚会误报，
    而误报的代价是别人开始不信这个脚本。
  */
  let entries = null;
  try {
    entries = readAsarEntries(asar);
  } catch (e) {
    bad(`无法解析 app.asar 头部: ${e.message}`);
  }
  if (entries) {
    const need = ['dist/main/main.cjs', 'dist/preload/preload.cjs', 'dist/renderer/index.html'];
    const missing = need.filter((e) => !entries.has(e));
    if (missing.length === 0) {
      ok(`app.asar 含全部入口（共 ${entries.size} 个文件，${(size / 1024).toFixed(0)} KB）`);
    } else {
      bad('app.asar 里缺少入口文件，打包内容不完整', missing.join(', '));
    }
  }
} else {
  bad('缺少 resources/app.asar');
}

/* ---- 2) extraResources：图标 + ANSI 垫片 ---- */
const ICONS = ['icon.ico', 'icon-256.png', 'tray.png', 'tray@2x.png'];
for (const name of ICONS) {
  const p = path.join(RES, 'icons', name);
  if (fs.existsSync(p) && fs.statSync(p).size > 0) ok(`图标 ${name} 已随包（${fs.statSync(p).size} B）`);
  else bad(`图标 ${name} 缺失或为空`, p);
}

/* ---- 3) ANSI 垫片：内容必须真能生效 ---- */
const shim = path.join(RES, 'ansi-shim', 'sitecustomize.py');
if (fs.existsSync(shim)) {
  const src = fs.readFileSync(shim, 'utf8');
  ok('ANSI 垫片 sitecustomize.py 已随包');
  /* 垫片的核心是给 colorama 打补丁；改名/写错都会让彩色日志静默消失 */
  /AnsiToWin32/.test(src)
    ? ok('垫片含 colorama.AnsiToWin32 补丁（彩色日志依赖它）')
    : bad('垫片里找不到 AnsiToWin32 补丁，彩色日志会失效');
} else {
  bad('缺少 resources/ansi-shim/sitecustomize.py（MaiBot 彩色日志会丢失）', shim);
}

/*
  __pycache__ 必须不在包里。
  process.js 的注释明确写着"该目录只能有 sitecustomize.py"；
  Python 导入垫片时会在旁边写字节码，一旦随包分发就与注释、与校验断言都不符。
  （已在 applyColorEnv 里设 PYTHONDONTWRITEBYTECODE=1 从源头禁止，这里是回归守卫。）
  垫片目录下的**任何**非 sitecustomize.py 文件都算污染。
*/
const shimDir = path.join(RES, 'ansi-shim');
if (fs.existsSync(shimDir)) {
  const extra = fs.readdirSync(shimDir).filter((n) => n !== 'sitecustomize.py');
  extra.length === 0
    ? ok('垫片目录干净（只有 sitecustomize.py）')
    : bad('垫片目录有额外内容，违反"只能有 sitecustomize.py"', extra.join(', '));
}

/* ---- 4) 终端依赖：node-pty 原生件必须在 asar 外 ---- */
const ptyDir = path.join(RES, 'app.asar.unpacked', 'node_modules', 'node-pty');
fs.existsSync(ptyDir)
  ? ok('node-pty 已解包到 app.asar.unpacked（终端功能依赖）')
  : bad('node-pty 未解包，打包版的终端会不可用', ptyDir);

console.log(`[packaged] 通过=${pass} 失败=${fail}`);
process.exit(fail === 0 ? 0 : 1);
