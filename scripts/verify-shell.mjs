/*
================================================================================
脚本：scripts/verify-shell.mjs
职责：验证「外壳」这一层的东西 —— 应用图标、日志页铺满、双击日志标签的服务胶囊。
================================================================================
  为什么单独有这么一个脚本：
    这三件事都属于"外壳"，不属于任何一个业务服务。它们的共同点是
    **测试不写就会悄悄退化**：
      · 图标：没人看 taskbar 就发现不了 build/icon.ico 变成单帧/空图标
      · 铺满：某个 max-height 被加回去，日志区就只剩半屏，功能还"正常"
      · 胶囊：双击手势没有任何显式入口，删掉一处绑定界面不会报错
    所以这里既做结构性断言（源码里该有的分支还在），
    也做**真正的二进制解析**（把 icon.ico / *.png 的头读出来验尺寸），
    而不是只 grep 一下文件名。
================================================================================
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;

function chk(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? '  → ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
/*
  去掉注释后再断言。
  这个项目里注释写得很详细，"旧实现是 max-height: 56vh"这种说明
  本身就会出现那串字符 —— 直接 grep 会把解释误判成残留代码
  （第一版就是这么被自己的测试判失败的）。
*/
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

/* ------------------------------------------------------------ PNG 头解析 */
/** 读 PNG 的 IHDR，返回 { width, height }（顺带验证签名与 IHDR 完整性） */
function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ------------------------------------------------------------ ICO 头解析 */
/**
 * 解析 ICO 目录，返回每一帧的信息。
 * 这是**真的按格式读**，不是找文件名：ICO 的目录项里
 * 宽高 0 表示 256，偏移/长度写错的话资源管理器会读出一张空图。
 */
function icoFrames(buf) {
  if (buf.length < 6) return null;
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) return null;
    const w = buf[off] === 0 ? 256 : buf[off];
    const h = buf[off + 1] === 0 ? 256 : buf[off + 1];
    const bytes = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    /* 每帧的载荷必须在文件内，否则是坏图标 */
    if (dataOff + bytes > buf.length) return null;
    const isPng = buf.subarray(dataOff, dataOff + 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    /* DIB 帧：前 4 字节是 biSize=40，biHeight 必须是 size*2（XOR + AND） */
    const dibOk =
      buf.readUInt32LE(dataOff) === 40 && buf.readInt32LE(dataOff + 8) === h * 2;
    out.push({ w, h, bytes, isPng, dibOk });
  }
  return out;
}

/* ===================================================== ① 应用图标 */
console.log('\n[shell] ① 应用图标：多尺寸 ICO + PNG + 托盘');

const icoPath = 'build/icon.ico';
if (!exists(icoPath)) {
  chk('build/icon.ico 存在', false, '文件不存在');
} else {
  const frames = icoFrames(fs.readFileSync(path.join(ROOT, icoPath)));
  chk('build/icon.ico 是合法 ICO（能解析目录）', Array.isArray(frames), frames ? '' : '头/目录坏了');

  if (Array.isArray(frames)) {
    const sizes = frames.map((f) => f.w);
    /*
      ★ 必须多帧。
      第一版只塞了一帧 256 的 PNG：任务栏/标题栏要 16/24/32 时，
      Windows 只能拿 256 硬缩，小尺寸一片糊 —— 而这正是用户唯一看得见的地方。
    */
    chk('★ ICO 是多帧（不是只塞一张 256）', frames.length >= 5, `${frames.length} 帧: ${sizes.join('/')}`);
    chk('★ 含 16px 帧（标题栏/托盘尺寸）', sizes.includes(16));
    chk('★ 含 32px 帧（任务栏默认尺寸）', sizes.includes(32));
    chk('★ 含 256px 帧（大图标视图与安装包）', sizes.includes(256));
    chk('每帧都是 32 位 DIB 且 biHeight = size*2', frames.every((f) => f.dibOk && !f.isPng),
      frames.filter((f) => !f.dibOk || f.isPng).map((f) => f.w).join(',') || '全部合规');
    chk('每帧宽高一致', frames.every((f) => f.w === f.h));
  }
}

for (const size of [16, 32, 256, 512]) {
  const rel = `build/icon-${size}.png`;
  if (!exists(rel)) {
    chk(`${rel} 存在`, false);
    continue;
  }
  const s = pngSize(fs.readFileSync(path.join(ROOT, rel)));
  chk(`${rel} 是 ${size}×${size} 的合法 PNG`, s && s.width === size && s.height === size,
    s ? `${s.width}×${s.height}` : '头非法');
}

if (exists('build/icon.png')) {
  const s = pngSize(fs.readFileSync(path.join(ROOT, 'build/icon.png')));
  chk('build/icon.png ≥512（electron-builder 通用图标）', s && s.width >= 512, s ? `${s.width}×${s.height}` : '头非法');
}

for (const [rel, size] of [['build/tray.png', 16], ['build/tray@2x.png', 32]]) {
  if (!exists(rel)) {
    chk(`${rel} 存在`, false);
    continue;
  }
  const s = pngSize(fs.readFileSync(path.join(ROOT, rel)));
  chk(`${rel} 是 ${size}×${size}`, s && s.width === size && s.height === size, s ? `${s.width}×${s.height}` : '头非法');
}

/* ===================================================== ② 图标接线 */
console.log('\n[shell] ② 图标接线：窗口 / 托盘 / 打包 / 生成时机');

const mainSrc = read('src/main/main.js');
chk('★ main.js 设置了 AppUserModelID（否则任务栏显示 Electron 默认图标）',
  /app\.setAppUserModelId\(/.test(mainSrc));
chk('★ 开发模式用独立 AUMID 后缀（与正式版共用会被 Windows 的旧图标缓存覆盖）',
  /app\.isPackaged\s*\?\s*APP_ID\s*:\s*`\$\{APP_ID\}\.dev`/.test(mainSrc));
chk('AUMID 与 build.appId 同源（都在包里的 appId 上）',
  /const APP_ID = 'com\.maibot\.launcher'/.test(mainSrc));

const winSrc = read('src/main/windows.js');
chk('★ 窗口图标优先用 .ico（小尺寸清晰），PNG 兜底',
  /'icon\.ico'/.test(winSrc) && /'icon-256\.png'/.test(winSrc));
chk('窗口图标候选按存在性挑选（不硬编码单一路径）',
  /iconCandidates\.find/.test(winSrc));

const traySrc = read('src/main/tray.js');
chk('★ 托盘图标会去 process.resourcesPath 找（打包后 build/ 不在 asar 里）',
  /process\.resourcesPath/.test(traySrc) && /'icons'/.test(traySrc));

const pkg = JSON.parse(read('package.json'));
chk('★ npm run build:main 前会自动重新生成图标（否则图标会停留在旧版本）',
  pkg.scripts['prebuild:main'] === 'node scripts/gen-icons.mjs');
chk('图标通过 extraResources 进打包产物（asar 外的 resources/icons）',
  Array.isArray(pkg.build?.extraResources) && pkg.build.extraResources.length >= 3);
chk('win.icon 指向 build/icon.ico', pkg.build?.win?.icon === 'build/icon.ico');
chk('安装包与卸载程序也用同一个图标',
  pkg.build?.nsis?.installerIcon === 'build/icon.ico' &&
    pkg.build?.nsis?.uninstallerIcon === 'build/icon.ico');

const genSrc = read('scripts/gen-icons.mjs');
chk('图标是"画"出来的（麦穗几何图形），不是纯色占位块',
  /inWheatEar/.test(genSrc) && /inEllipse/.test(genSrc));
chk('★ 第一版那个"蓝方块 + 两个圆点"的占位图形已不存在',
  !/mouth|leftEye|rightEye/.test(genSrc));

/* ===================================================== ③ 日志页铺满 */
console.log('\n[shell] ③ 日志页：只有一个日志区，且铺满整个软件（菜单栏底下）');

const routerSrc = read('src/renderer/router/index.js');
chk('★ /logs 路由带 meta.full（外壳据此切铺满模式）',
  /path: '\/logs'[\s\S]{0,400}?full: true/.test(routerSrc));

const layoutSrc = read('src/renderer/components/AppLayout.vue');
chk('外壳按 meta.full 给 .body 加 body-full 类',
  /'body-full': isFullRoute/.test(layoutSrc) && /const isFullRoute = computed\(\(\) => Boolean\(route\.meta\?\.full\)\)/.test(layoutSrc));
chk('★ 铺满模式去掉内边距并关掉外壳滚动（否则两条滚动条打架）',
  /\.body-full\s*\{[\s\S]{0,120}?padding: 0;[\s\S]{0,120}?overflow: hidden;/.test(layoutSrc));

const logsCss = read('src/renderer/views/LogsPanel.vue');
const logsCode = stripComments(logsCss);
const storeSrc = read('src/renderer/stores/app-store.js');

/*
  ★ 这几条是"日志不要分成好几个"的护栏。
  用户明确要求日志只有**一个**区；这里从三个角度钉住它：
  模板里不再有分区容器、只剩一个滚动区、高度用 flex 吃满。
  任何一处被改回"多个框"，这里都会响。
*/
chk('★ 模板里只有一个日志区（没有 log-cols / log-zone 这类多分区容器）',
  !/class="log-cols/.test(logsCode) && !/class="log-zone/.test(logsCode) &&
    /<section class="log-console">/.test(logsCode));
chk('★ 只剩一个滚动容器（class="log-box" 只出现一次）',
  (logsCode.match(/class="log-box"/g) || []).length === 1);
chk('★ 可见日志是"合并后的一串"（模板遍历 visibleRows，而不是按分区遍历）',
  /v-for="l in visibleRows"/.test(logsCode));
chk('★ 日志页高度吃满容器（height:100%，不是 min-height:100vh）',
  /\.logs-page\s*\{[\s\S]{0,200}?height: 100%;[\s\S]{0,200}?min-height: 0;/.test(logsCode));
chk('★ .log-console 是 flex:1 + min-height:0（把剩余高度吃满）',
  /\.log-console\s*\{[\s\S]{0,240}?flex: 1;[\s\S]{0,240}?min-height: 0;/.test(logsCode));
chk('★ .log-box 不再有写死的 max-height:56vh（"只占半屏"的元凶）',
  !/max-height:\s*56vh/.test(logsCode));
chk('★ .log-box 的 min-height 改成 0（让内容自己滚，而不是把容器顶高）',
  /\.log-box\s*\{[\s\S]{0,120}?min-height: 0;/.test(logsCode));

/* -------- 合并流的正确性 -------- */
chk('★ 两个来源按时间归并成一条流',
  /rows\.sort\(\(a, b\) => \(a\.ts \|\| 0\) - \(b\.ts \|\| 0\)\)/.test(logsCode));
chk('★ 每个日志条目自带 key（否则合并后分不清这行是谁输出的）',
  /bucket\.push\(\{ id: store\.logSeq, ts: Date\.now\(\), level, source, text: line, key \}\)/.test(storeSrc) &&
    /store\.logsByKey\[key\] = ordered\.map\(\(e, i\) => \(\{/.test(storeSrc) &&
    /\n\s+key\n\s+\}\)\);/.test(storeSrc));
chk('★ 行内来源标签（合并后"谁输出的"只能由它表达）',
  /TAG_BY_KEY = \{ maibot: 'MaiBot', snowluma: 'SnowLuma' \}/.test(logsCode) &&
    /\{\{ srcTag\(l\) \}\}/.test(logsCode));
/*
  用户原话："（日志）不要显示错误等内容，就是正常的 cmd 样式"。
  他截图指的就是每行前面那个 OUT / ERR 徽标 —— 单个来源视图里不再贴它，
  正常 cmd 窗口不会给每行标"这是标准输出/这是标准错误"。
  （stdout/stderr 的区分没丢：行颜色仍按级别上色，顶部"错误 N"计数照旧。）
*/
chk('★ 只看单个来源时不贴 OUT/ERR 徽标（用户要求：正常 cmd 样式）',
  /if \(store\.logsFocus\) return '';/.test(logsCode) &&
    /<span v-if="srcTag\(l\)" class="log-src"/.test(logsCode));

/* -------- 用户要求：日志要有颜色（"都是有颜色的"）-------- */
chk('★ 日志页真的渲染 ANSI（不是把控制码原样喷在页面上）',
  /function ansiToHtml\(raw\)/.test(logsCode) &&
    /v-html="rowHtml\(l\)"/.test(logsCode) &&
    /const ansiCache = new WeakMap\(\)/.test(logsCode));
chk('★ 上色之前先转义（v-html 的注入面不能交给被监控的进程）',
  /const escHtml = \(s\) => String\(s\)\.replace\(\/\[&<>"'\]\/g/.test(logsCode));
chk('★ 复制 / 导出的日志不带控制码', /stripAnsi\(l\.text\)/.test(logsCode));
/*
  "非 SGR"字符类里绝不能有 m：混进去就会把 \x1b[38;5;117m 这种颜色序列
  当成光标控制整段删掉，颜色全没（实测踩过一次，单测里 span 数是 0）。
*/
chk('★ "非 SGR"字符类里没有 m（混进去就把颜色序列也删了）',
  !/A-HJKSTfhilmnpsu/.test(logsCode) && /A-HJKSTfhlnpsu/.test(logsCode));

/* -------- 让服务的颜色活下来（colorama 会主动删颜色）-------- */
const processSrc = read('src/main/services/process.js');
chk('★ 子进程环境补了 FORCE_COLOR / TERM / 去掉 NO_COLOR',
  /function applyColorEnv\(env\)/.test(processSrc) &&
    /env\.FORCE_COLOR = '1'/.test(processSrc) &&
    /env\.TERM = 'xterm-256color'/.test(processSrc) &&
    /delete env\.NO_COLOR/.test(processSrc) &&
    /applyColorEnv\(childEnv\)/.test(processSrc));
chk('★ colorama 垫片存在，且只把 convert / strip 关掉',
  exists('resources/ansi-shim/sitecustomize.py') &&
    /kwargs\["convert"\] = False/.test(read('resources/ansi-shim/sitecustomize.py')) &&
    /kwargs\["strip"\] = False/.test(read('resources/ansi-shim/sitecustomize.py')));
chk('★ 打包时带上垫片（asar 里 Python 读不到，必须走 extraResources）',
  JSON.stringify(JSON.parse(read('package.json')).build.extraResources || []).indexOf('ansi-shim') !== -1);

/* -------- 用户要求：日志页去掉「启动器」来源 -------- */
chk('★ 日志来源只有 MaiBot 与 SnowLuma（启动器已从这一页移除）',
  /const ZONES = \[\s*\{ key: 'maibot'[\s\S]{0,200}?\{ key: 'snowluma'[\s\S]{0,80}?\s\];/.test(logsCode) &&
    !/key: 'launcher'/.test(logsCode) &&
    !/name: '启动器'/.test(logsCode));
chk('★ 渲染层不再订阅/拉取启动器日志（数据不进这一页）',
  !/subscribeAppLogs/.test(layoutSrc) &&
    !/loadAppLogs|clearAppLogs|exportAppLog/.test(logsCode));
chk('★ 去掉的是显示而不是功能：启动器日志文件仍能一键定位',
  /store\.info\.logFile/.test(logsCode) && /openPath\(dir\)/.test(logsCode));
chk('仓储层仍保留启动器日志桶（哪天要加回来只是一行订阅）',
  /logsByKey: \{ maibot: \[\], snowluma: \[\], launcher: \[\] \}/.test(storeSrc));
chk('★ 空状态要说明"为什么这里是空的"',
  /都没在运行/.test(logsCode));
chk('没 key 的旧条目不会渲染出 "undefined" 徽标',
  /TAG_BY_KEY\[srcKeyOf\(l\)\] \|\| \(l\.source === 'stderr' \? 'ERR' : 'OUT'\)/.test(logsCode));
/*
  ★ 顺序与时间戳的两条护栏。
  这两个都是合并视图上线时才暴露出来的老 bug：
    · 主进程返回"最新在前"，服务日志翻正了、启动器日志没翻 → 那块日志倒着显示
      （启动器日志现在不显示了，但 loadAppLogs 这条路仍然要正确：
        它是「日志目录」之外唯一读回该文件的地方，留着就得是对的）
    · 解析不出时间的行被写成 Date.now() → 时间全变成"现在"，排序随之失效
*/
chk('★ 启动器日志快照也会翻正成时间升序（主进程返回的是最新在前）',
  /const ordered = entries\.slice\(\)\.reverse\(\);/.test(storeSrc));
chk('★ 时间解析不出来的行继承上一行时间，不用 Date.now() 冒充',
  /const known = Number\.isFinite\(e\.ts\) && e\.ts > 0;/.test(storeSrc) &&
    /const ts = known \? e\.ts : lastTs;/.test(storeSrc) &&
    !/ts: e\.ts \|\| Date\.now\(\)/.test(storeSrc));
chk('服务日志的时间戳同样只接受正数（0 = 不知道，界面显示 --:--:--）',
  /ts: Number\.isFinite\(e\.ts\) && e\.ts > 0 \? e\.ts : 0,/.test(storeSrc));
/*
  ★ 来源徽标宽度必须放得下最宽的标签。
  ⚠️ 这条断言原本写死 `min-width: 24px`，但那个值在 LogsPanel.vue 里**已经被有意改掉**：
     代码注释记着实测结果 —— "实测 MaiBot 45.2px / SnowLuma 56.9px / OUT 27.6px"，
     所以固定列宽取最宽标签（SnowLuma）向上取整为 **58px**，并写明"min-width 而不是 width"。
     也就是说 24px 是**旧的、放不下 SnowLuma 的值**，这条断言当年是用来防它的，
     现在它自己在要求那个错误的值 —— 断言与实现方向相反，必然红。
  → 改为断言"宽度不低于最宽标签的实测值"，而不是钉死某个历史数字。
*/
chk('★ 来源徽标宽度自适应（写死 24px 放不下 "SnowLuma"）',
  /\.log-src\s*\{[\s\S]{0,400}?min-width: (?:5[89]|[6-9]\d|\d{3,})px;/.test(logsCode) &&
    /white-space: nowrap;/.test(logsCode));
/*
  ★ 时间列必须能区分"哪一天"。
  实测：合并流里有一对相邻行渲染成 "22:18:11 → 08:18:50" —— 其实是前一天
  22:18 和第二天 08:18（排序完全正确），只显示时分秒就看起来像排序坏了。
*/
chk('★ 不是今天的行带月-日（否则跨天相邻行看起来像倒序）',
  /if \(sameDay\) return hm;/.test(logsCode) && /return `\$\{md\} \$\{hm\}`;/.test(logsCode));
chk('非法时间戳退化成 --:--:--（不渲染 NaN）',
  /if \(Number\.isNaN\(d\.getTime\(\)\)\) return '--:--:--';/.test(logsCode));
chk('时间列悬停给出完整时间', /:title="fullTime\(l\.ts\)"/.test(logsCode));

/* -------- 曾经"没有 CSS"的输入栏 -------- */
chk('★ 补齐 stdin 输入栏/EULA 横幅样式（此前 .zone-input/.zi-* 全项目一条 CSS 都没有）',
  /\.zone-input\s*\{/.test(logsCode) && /\.zi-field\s*\{/.test(logsCode) &&
    /\.zi-send\s*\{/.test(logsCode) && /\.zi-eula\s*\{/.test(logsCode));
chk('★ 合并视图下"某个服务在等确认"仍然可见（否则麦麦卡住没人知道）',
  /<div v-if="consentTip" class="console-tip">/.test(logsCode) &&
    /focusLogs\(consentTip\.key\)/.test(logsCode));
chk('输入栏只在选中单个"可输入"服务时出现（合并视图没有明确的写入对象）',
  /const inputZone = computed\(\(\) => \{[\s\S]{0,160}?return z && z\.inputtable \? z : null;/.test(logsCode));

/* ===================================================== ④ 双击日志标签的胶囊 */
console.log('\n[shell] ④ 双击「日志」弹出日志来源胶囊');

/*
  ★ 这两条是本轮"假绿"最直接的修复对象。
  ────────────────────────────────────────────────────────────────────────
  旧断言（只 grep 源码里出现过某段字符串）在**死代码**上也是绿的：
    · `@dblclick="onTabDblClick($event, t)"` 当时只出现在模板里那块
      `<nav v-if="false">` 的旧分段导航上 —— 恒定不渲染，等于这条手势在
      界面上完全不可达，而门禁照样打勾；
    · `class="nav-focus"` 同理，那个 span 也在死块里。
  也就是说：门禁不是在验证行为，而是在验证"死代码还没被删掉"。
  现在改成同时断言**绑定本身**与**绑定落在一个会渲染的条目上**
  （v-for 遍历的 MENUBAR_ITEMS + 该条目的 data-testid）——
  谁把这段绑定挪回死分支，这条会红。
*/
chk('★ 标签上绑定了 dblclick', /@dblclick="onTabDblClick\(\$event, t/.test(layoutSrc));
/* 锚点参数：胶囊挂在"被双击的那一条"下面（日志条目在标题栏左侧菜单栏里，
   取不到锚点就会飘到窗口中间）。断言要连着第三个参数一起看。 */
chk('★ 双击处理拿到定位锚点（否则胶囊不知道挂哪儿）',
  /@dblclick="onTabDblClick\(\$event, t, \$event\.currentTarget\)"/.test(layoutSrc) &&
    /const el = anchor \|\| ev\.currentTarget;/.test(layoutSrc));
/* 真正的修复：绑定必须落在**渲染出来的**菜单栏条目上，而不是某个死分支里。
   左侧用 <nav …> 单标签切片（[^>]* 不会跨标签），把"绑定在哪一条 nav 上"
   限定住：v-show 的那个 nav 里必须有 dblclick；同一段里不得出现 v-if="false"。 */
chk('★ 绑定落在会渲染的菜单栏条目上（不是 v-if="false" 的死块）',
  /<nav[^>]*v-show="menuOpen"[^>]*>(?:(?!<\/?nav)[\s\S])*?@dblclick="onTabDblClick/.test(layoutSrc) &&
    !/<nav[^>]*v-if="false"[^>]*>(?:(?!<\/?nav)[\s\S])*?@dblclick="onTabDblClick/.test(layoutSrc));
chk('★ 胶囊用 Teleport 挂到 body（.tab-bar 是 overflow:hidden 的圆角药丸，就地定位会被裁）',
  /<Teleport to="body">/.test(layoutSrc) && /class="log-menu"/.test(layoutSrc));

/*
  ★ 菜单栏数据源：断言的是**真正的数据**，不是"源码里出现过某个字符串"。
  ────────────────────────────────────────────────────────────────────────
  标题栏那 6 个页面入口必须是 MENUBAR_ITEMS 里的**人话名字**
  （路由 meta.title 是"总览 / 安装器"，给开发看；菜单栏给新手看）。
  所以这里逐个解析 (path, label) 对：
    · 少一条 / 名字被换成 meta.title / label 变空 → 立刻红；
    · 每条 path 必须真的在路由表里存在（写错路径 = 点了没反应）。
  这条是"标签渲染成空行"那类事故的护栏（见 AppLayout 里 MENUBAR_ITEMS 注释）。
*/
const MENUBAR_EXPECT = [
  ['/overview', '总览'],
  ['/installer', '安装麦麦'],
  ['/logs', '日志'],
  ['/terminal', '终端'],
  ['/toolbox', '工具箱'],
  ['/settings', '设置']
];
const menubarPairs = [...layoutSrc.matchAll(/\{\s*path:\s*'([^']+)',\s*key:\s*'[^']+',\s*label:\s*'([^']*)'\s*\}/g)]
  .map((m) => [m[1], m[2]]);
chk('★ 菜单栏是 6 条人话入口（不是 meta.title，也没有空 label）',
  JSON.stringify(menubarPairs) === JSON.stringify(MENUBAR_EXPECT),
  menubarPairs.map(([p, l]) => `${p}=${l || '(空)'}`).join(' '));
chk('★ 菜单栏每条 path 都在路由表里存在（写错路径=点了没反应）',
  menubarPairs.every(([p]) => new RegExp(`path:\\s*'${p}'`).test(routerSrc)) &&
    /v-for="t in MENUBAR_ITEMS"/.test(layoutSrc));
chk('★ 胶囊挂在被双击标签的正下方并水平居中',
  /r\.left \+ r\.width \/ 2/.test(layoutSrc) && /r\.bottom \+ 10/.test(layoutSrc));
/* ⚠️ 文案已从「全部」改成「全部来源」（AppLayout.LOG_TARGETS 注释：
   "光写「全部」新手不知道'全部什么'"）。断言跟着改，否则它要求的是旧文案。 */
chk('★ 三个选项：全部来源 / MaiBot / SnowLuma（没有启动器）',
  /LOG_TARGETS = \[/.test(layoutSrc) && /label: '全部来源'/.test(layoutSrc) &&
    /key: 'maibot'/.test(layoutSrc) && /key: 'snowluma'/.test(layoutSrc) &&
    !/key: 'launcher'/.test(layoutSrc));
chk('★ 当前选中项高亮（否则用户不知道自己在看哪个）',
  /\.lm-item\.active/.test(layoutSrc) && /active: \(store\.logsFocus \|\| null\) === t\.key/.test(layoutSrc));
/*
  ⚠️ 换页收起这段，实现已经从"直接把 closeLogMenu 当回调"改成块级回调：
      watch(() => route.path, () => { closeLogMenu(); closeMore(); })
     原因是要**同时**收起齿轮面板（closeMore）—— 只收日志胶囊的话，
     换页后齿轮菜单会挂在屏幕角落挡内容。
     旧断言要求 `watch(() => route.path, closeLogMenu)` 这种单回调写法，
     于是把"顺带修好了第二个浮层"的改进判成失败 —— 典型的"断言钉住了实现细节"。
  → 改为断言"换页时两个浮层都收起"，这才是真正要保住的行为。
*/
chk('★ 点空白 / Esc / 换页都会收起胶囊',
  /onDocMouseDown/.test(layoutSrc) && /ev\.key === 'Escape'/.test(layoutSrc) &&
    /watch\(\(\) => route\.path, \(\) => \{[\s\S]{0,120}?closeLogMenu\(\);[\s\S]{0,120}?closeMore\(\);/.test(layoutSrc));
chk('★ 收起用 mousedown 捕获（用 click 会让"点按钮"先关菜单、第一次点无反应）',
  /addEventListener\('mousedown', onDocMouseDown, true\)/.test(layoutSrc));
/*
  ⚠️ 这条也是"假绿"的修复对象，而且比上面那条更彻底。
  ────────────────────────────────────────────────────────────────────────
  旧断言：`/class="nav-focus"/` + `/logsFocusLabel/`。
  这两处当时**都只存在于 v-if="false" 的死块里**（那个 .nav-focus 小药丸和
  喂它的 logsFocusLabel computed）—— 断言的字面意思是"标签上显示当前筛选的
  来源"，实际验证的却是"死代码还没被删"。它不是断言太弱，是**断言在说谎**。
  死块与 logsFocusLabel 已删，这条断言不能再留着（留着就必须把死代码加回来
  才能绿，那就本末倒置了）。

  → 改为断言**真正存在、并且真的会渲染**的那份可见状态：
    · 胶囊里当前来源用 .lm-item.active 标出（active: (store.logsFocus||null)===t.key）；
    · 胶囊在 logMenu 为真时才挂载（v-if="logMenu"）。
  ⚠️ 已知缺口（写在这里免得下一个人以为已经覆盖）：常驻在菜单栏上的
  "只看某个服务"文字痕迹**当前不存在**。它原来挂在旧分段导航上，随死块一起
  消失了；胶囊只在被双击打开时才可见。所以"无痕手势必须有可见状态"这条
  需求目前是**部分满足**（胶囊内满足，胶囊外不满足），要彻底满足得把痕迹
  加到真正渲染的 .menubar-item 上。这条断言只覆盖已实现的部分，不假装更多。
*/
chk('★ 胶囊里当前来源有高亮（否则用户不知道自己在看哪个）',
  /class="lm-item"/.test(layoutSrc) && /\.lm-item\.active/.test(layoutSrc) &&
    /active: \(store\.logsFocus \|\| null\) === t\.key/.test(layoutSrc));
chk('★ 胶囊只在被双击打开时挂载（v-if="logMenu"）',
  /v-if="logMenu"/.test(layoutSrc) && /const logMenu = ref\(false\)/.test(layoutSrc));
chk('只有日志标签响应双击（其它标签双击=再点一次）',
  /if \(!tab\.meta\?\.full\) return;/.test(layoutSrc));

chk('store 里有 logsFocus 状态', /logsFocus: null/.test(storeSrc));
chk('★ focusLogs 白名单收口（合法来源固定两个，写错字会过滤出空流）',
  /const LOG_FOCUS_KEYS = \['maibot', 'snowluma'\]/.test(storeSrc) &&
    /store\.logsFocus = LOG_FOCUS_KEYS\.includes\(key\) \? key : null;/.test(storeSrc));
chk('★ 日志区按 logsFocus 过滤来源（不是隐藏，计数也要跟着变）',
  /const sources = computed\(\(\) =>[\s\S]{0,160}?ZONES\.filter\(\(z\) => z\.key === store\.logsFocus\)/.test(logsCode));
chk('★ 派生计数只遍历 sources（否则只看 SnowLuma 时还挂着 MaiBot 的条数）',
  /for \(const z of sources\.value\)/.test(logsCode));
chk('切换来源后跳到最新一行（否则停在一段无关的中间内容上）',
  /watch\(\s*\(\) => store\.logsFocus,/.test(logsCode));

/* ------------------------------------------------------------------ 收尾 */
console.log(`\n[shell] ${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}  通过=${pass} 失败=${fail}`);
process.exit(fail === 0 ? 0 : 1);
