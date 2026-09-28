/*
================================================================================
脚本：scripts/verify-launch.mjs
职责：验证「服务启动链路」的两处真实缺陷已修好，且不会退回假功能。
================================================================================
  这个脚本守两件**不报错、只静默失效**的事：

  ① 麦麦卡在 EULA 输入上（用户完全动不了）
     bot.py 的 check_eula() 用 input() 等一行输入。我们的启动器把 stdout
     收进日志、stdin 留成管道，但界面上没有任何输入口 —— 点「启动」后
     界面显示已启动，进程却在等一行永远不来的输入。没有任何异常、没有任何
     报错，用户只会觉得"卡住了/坏了"。所以必须断言：
       · 能从日志里认出"正在等确认"
       · 能认出"已经确认过"（否则横幅永远挂着）
       · 绝不能把提示文本里那句『或设置环境变量"EULA_AGREE=..."』当成
         "需要确认"的信号 —— 那句话在**成功路径上也照打**，误判会导致
         每次启动都弹一个假警报。

  ② 写 stdin 不补换行 → Python 的 input() 永远等不到行结束。
     界面显示"已发送"，实际什么也没发生。这是最难查的假成功。

  隔离说明：
    buildStartPayload 走 settings.getBackendSettings() → paths.userDataDir()
    → electron.app.getPath('userData')。为了**绝不碰用户真实配置**，
    这里在 require 之前把 electron 模块整个换成假的，把 userData 指到临时目录。
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let bad = 0;
const chk = (name, ok, extra) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  → ${extra}` : ''}`);
  if (!ok) bad += 1;
};

/* ============================================================================
   0) 隔离：把 electron 换成假的，userData 指向临时目录
   ========================================================================== */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-launch-'));
const userData = path.join(sandbox, 'userData');
fs.mkdirSync(userData, { recursive: true });
/* 假 userData 下的设置文件：下面几节直接写它来喂不同的配置 */
const settingsFile = path.join(userData, 'backend-settings.json');

const Module = require('module');
const realLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false } };
  }
  return realLoad.call(this, request, parent, isMain);
};

/* ------------------------------------------------------------------ ① EULA */

console.log('[launch] ① 麦麦 EULA 等待输入的识别');

const eulaMod = await import(
  pathToFileURL(path.join(ROOT, 'src/renderer/onboarding/eula-prompt.js')).href
);
const { readEulaState, isValidAcceptWord, ACCEPT_WORDS } = eulaMod;

/* 这三行是 bot.py 里真实打印的文本（逐字抄自 bot.py:183-185 / 215） */
const LINE_UPDATED = 'EULA或隐私条款内容已更新，请在阅读后重新确认，继续运行视为同意更新后的以上两款协议';
const EULA_HASH = '35362b6ea30f12891d46ef545122e84a';
const PRIV_HASH = '2402af06e133d2d10d9c6c643fdc9333';
const LINE_PROMPT = `输入"同意"或"confirmed"或设置环境变量"EULA_AGREE=${EULA_HASH}"和"PRIVACY_AGREE=${PRIV_HASH}"继续运行`;
const LINE_DONE = '检查EULA和隐私条款完成';

{
  chk('空日志 → 判为 none（还没走到这一步）', readEulaState('').state === 'none');
  chk('★ 只有提示行 → 判为正在等确认', readEulaState(LINE_PROMPT).state === 'need-confirm');
  chk('★ 等确认时必须给用户输入通道', readEulaState(LINE_PROMPT).canAccept === true);

  /* 最关键的一条：成功路径上也会出现 EULA_AGREE 这个词 */
  chk(
    '★ 已确认的日志里含 EULA_AGREE 字样，仍判为 confirmed（不能误报）',
    readEulaState(`${LINE_DONE}\n[INFO] env EULA_AGREE=${EULA_HASH}`).state === 'confirmed'
  );
  chk(
    '★ 用户输入后（提示行后面的"检查完成"）→ 不再提示确认',
    readEulaState(`${LINE_PROMPT}\n${LINE_DONE}`).state === 'confirmed'
  );
  chk(
    '★ 跨次启动日志（上次卡住 + 这次已完成）→ 取最新状态为 confirmed',
    readEulaState(`${LINE_PROMPT}\n=== 新会话 ===\n${LINE_DONE}`).state === 'confirmed'
  );
  /*
    ★ 真机上这两行是**紧挨着**打出来的（bot.py:183 和 185 同属一个分支）。
    曾经按"已更新出现在提示行附近"又分出一个 'updated' 状态，
    在真机上把「在等确认」误判成了「协议更新」。
    现在合并成一个状态：只要在等输入，就是 need-confirm。
  */
  chk(
    '★ 协议更新的提示不另算一个状态，仍判为正在等确认',
    readEulaState(`${LINE_UPDATED}\n${LINE_PROMPT}`).state === 'need-confirm'
  );
  chk(
    '★ 两行提示紧挨着（真机形态）也要判对',
    readEulaState(`${LINE_UPDATED}\n${LINE_PROMPT}`).canAccept === true
  );
  chk('确认过的状态不需要输入通道', readEulaState(LINE_DONE).canAccept === false);

  /* bot.py:189 只认这两个词；界面不该暗示别的写法能过 */
  chk('合法确认词恰好是 同意 / confirmed', ACCEPT_WORDS.length === 2);
  chk('「同意」被接受', isValidAcceptWord('同意') === true);
  chk('「confirmed」大小写不敏感', isValidAcceptWord('CONFIRMED') === true);
  chk('「同意」带空格也接受', isValidAcceptWord('  同意  ') === true);
  chk('「yes」不被接受（bot.py 不认）', isValidAcceptWord('yes') === false);
  chk('「y」不被接受（常见误以为可以）', isValidAcceptWord('y') === false);
  chk('空串不被接受', isValidAcceptWord('') === false);
}

/* ------------------------------------------------- ② stdin 必须补换行 */

console.log('\n[launch] ② 向服务 stdin 写入必须补齐换行');

/*
  这里做**源码级断言**而不是行为断言，原因说清楚：
  writeServiceInput 依赖 registry 里真实存在的子进程记录，而 registry 由
  真正 spawn 之后才填充 —— 为了验一个字符串处理去 spawn 一个进程不划算，
  且会让测试依赖机器上有没有 python。

  所以断言落在"换行到底补没补"这个具体写法上。它确实比行为断言脆，
  但覆盖的是同一个失效点：只要有人把补换行去掉，这三条就会红。
*/
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main/services/process.js'), 'utf8');
  chk('★ 写入前把 \\r\\n 归一成 \\n（避免多送空行）', /replace\(\/\\r\\n\/g, '\\n'\)/.test(src));
  chk('★ 写入时补了结尾换行', /stdin\.write\(`\$\{line\}\\n`\)/.test(src));
  chk('★ 去掉了行尾多余换行（不会连送多行）', /replace\(\/\\n\+\$\/, ''\)/.test(src));
}

/* ------------------------------- ③ SnowLuma 设置项：默认值 + 非法值纠正 */

console.log('\n[launch] ③ SnowLuma 设置项的默认值与非法值纠正');
{
  const constants = require(path.join(ROOT, 'src/main/constants.js'));
  const def = constants.DEFAULT_SETTINGS.service.snowlumaPorts;
  chk('★ SnowLuma WebUI 端口默认 5099（上游默认值）', Number(def.webui) === 5099, String(def.webui));
  chk('★ SnowLuma OneBot 端口默认 7988（上游默认值）', Number(def.onebot) === 7988, String(def.onebot));
  /*
    协议端只剩 SnowLuma 之后，设置里**不该**再有 qqBackend / napcatDir /
    napcatQuickLogin / ports.napcat 这些键。留一个就是没删干净。
  */
  const s0 = constants.DEFAULT_SETTINGS.service;
  const stale = ['qqBackend', 'napcatDir', 'napcatQuickLogin'].filter((k) => k in s0);
  chk('★ 默认设置里没有已废弃的协议端字段', stale.length === 0, stale.join(','));
  chk('★ 默认 ports 里没有已废弃的协议端端口', !('napcat' in (s0.ports || {})));

  const settings = require(path.join(ROOT, 'src/main/services/settings.js'));
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ service: { snowlumaPorts: { webui: 'not-a-port', onebot: 999999 } } }),
    'utf8'
  );
  const s = settings.getBackendSettings();
  const ports = s.service.snowlumaPorts || {};
  chk('★ 端口写成非法字符串时被纠正成默认端口', Number(ports.webui) === 5099, String(ports.webui));
  chk('★ 端口越界（>65535）时被夹回合法范围', Number(ports.onebot) <= 65535, String(ports.onebot));
  chk('★ 纠正后必须是数字而不是原样的字符串', typeof ports.webui === 'number', typeof ports.webui);
}


/* ------------------------------------------------------------------ 收尾 */

Module._load = realLoad;
fs.rmSync(sandbox, { recursive: true, force: true });

if (bad) {
  console.error(`\n[launch] ✗ ${bad} 项失败`);
  process.exit(1);
}
console.log('\n[launch] ✓ 全部通过');
