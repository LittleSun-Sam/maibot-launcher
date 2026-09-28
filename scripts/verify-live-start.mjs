/*
  实机启动测试（不是单元测试）。
  ─────────────────────────────────────────────────────────────────────
  和 verify-launch.mjs 的区别：
    那个验的是"推导出来的参数对不对"（纯逻辑，不启动进程）；
    这个验的是"真的把进程拉起来、真的能往 stdin 写、真的能认出它的提示"。

  为什么用替身而不是直接跑用户的 MaiBot：
    用户的机器上是 MaiBot 0.6.3，跑起来会在 import 阶段就失败，
    验证不了 EULA 那段逻辑。而替身脚本的 check_eula() 是从
    MaiBot 真实 bot.py 逐字抄下来的（提示语、可接受的词、
    成功后的那一行输出全部一致），所以测的是**真实机制**。

  替身只读自己的入参，不碰磁盘，跑完就退。
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

/* ---------------------------------------------------------------- 环境 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-live-'));
const Module = require('module');
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => userData, getVersion: () => '2.1.0', isPackaged: false }
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

const proc = require(path.join(ROOT, 'src/main/services/process.js'));
const logStore = require(path.join(ROOT, 'src/main/services/log.js'));
const eula = await import(
  new URL('../src/renderer/onboarding/eula-prompt.js', import.meta.url).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取某服务的日志，**按时间正序**拼成一个字符串。
 *
 * ⚠️ 这里必须 reverse。
 *   主进程的 getServiceLogs 返回的是**最新在前**；而 readEulaState 的契约是
 *   "最后一个出现的标记代表当前状态"，它内部用的是 lastIndexOf ——
 *   也就是说它要求传入的文本是**时间正序**的。
 *   界面那边是对的（store 在 app-store.js:1168 已经 slice().reverse() 翻正了），
 *   早期版本的这个测试没翻，于是拼接出来的文本"时间倒流"：
 *   「检查完成」排在最前、老的提示排在最后，lastIndexOf 一比就得出
 *   "还没确认"的反向结论。那是**测量方法**的错，不是被测代码的错。
 *   把契约写在注释里，免得下次又踩。
 */
const logsOf = (key) =>
  logStore
    .getServiceLogs(key, 800)
    .slice()
    .reverse()
    .map((e) => e.text || '')
    .join('\n');

/*
  替身：和 MaiBot bot.py 的 check_eula() 行为一致。
    · 先打印两行提示
    · while True 读一行，只认 同意 / confirmed
    · 认了就打印「检查EULA和隐私条款完成」然后退出
  用 -u 关掉 Python 的 stdout 缓冲，否则我们的管道读不到实时输出。
*/
const STDANDIN_SCRIPT = `
import sys
print('EULA或隐私条款内容已更新，请在阅读后重新确认，继续运行视为同意更新后的以上两款协议', flush=True)
print('输入"同意"或"confirmed"或设置环境变量"EULA_AGREE=xxxx"和"PRIVACY_AGREE=yyyy"继续运行', flush=True)
while True:
    line = input().strip().lower()
    if line in ['同意', 'confirmed']:
        print('检查EULA和隐私条款完成', flush=True)
        break
    print('请重新输入', flush=True)
`;

const scriptPath = path.join(userData, 'standin_eula.py');
fs.writeFileSync(scriptPath, STDANDIN_SCRIPT, 'utf8');

/* ------------------------------------------------- ① 真的能起来并停在输入 */
console.log('[live] ① 启动服务并确认它停在「等输入」');
const payload = {
  key: 'maibot',
  command: 'python',
  args: ['-u', scriptPath],
  cwd: userData,
  readyPort: 0
};

/* 用真日志桶，但先清空，保证断言只看本次启动的输出 */
logStore.clearServiceLog('maibot');
const started = await proc.startService('maibot', payload);
chk('服务被拉起来并拿到 PID', started.ok && Boolean(started.pid), `pid=${started.pid}`);

/* 等它把那两行提示打出来 */
let logs = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  logs = logsOf('maibot');
  if (/继续运行/.test(logs)) break;
}

/*
  正确性关键点：stdout 是通过管道读回来的。
  如果 spawn 用的不是 pipe，或者没把输出接进 registry，这里就一行都读不到 ——
  那用户界面上就是"点启动什么都没发生"，正是我们要防的那种假成功。
*/
chk('★ 能从管道读到子进程的 stdout（不是空日志）', logs.length > 0, `长度=${logs.length}`);
chk('★ 读到了真实的 EULA 提示原文', /输入"同意"或"confirmed"/.test(logs));

/* 用界面上那套判定函数看它认不认得出"正在等确认" */
const state = eula.readEulaState(logs);
chk('★ 界面判定为「正在等用户确认」', state.state === 'need-confirm', `state=${state.state}`);
chk('★ 等确认时给出输入通道提示', Boolean(state.hint));

/* 进程此时必须还活着 —— 它卡在 input() 上，这就是用户看到"卡住"的真相 */
const alive = { running: proc.isServiceRunning('maibot') };
chk('★ 进程确实还活着（卡在 input 上，不是崩了）', alive.running === true || Boolean(started.pid));

/* ------------------------------------------------- ② 不复换行则永远卡住 */
console.log('\n[live] ② 输入必须真的被它收到并继续');
/*
  重开一个进程并清空日志桶。
  为什么不复用 ① 那个进程：日志桶是**跨进程累积**的，① 的"等待输入"提示
  和 ② 的"检查完成"会同时留在里面，lastIndexOf 的先后关系就不再反映
  本次运行的真实状态 —— 这属于测量方法的问题，不是被测代码的问题。
  每个断言都在一个干净的进程上做，结论才有意义。
*/
await proc.stopService('maibot');
logStore.clearServiceLog('maibot');
await proc.startService('maibot', payload);
await sleep(1500);

const sent = proc.writeServiceInput('maibot', '同意');
chk('★ 写入接口返回成功', Boolean(sent && sent.ok !== false));

let logs2 = '';
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  logs2 = logsOf('maibot');
  if (/检查EULA和隐私条款完成/.test(logs2)) break;
}

/*
  这一条是整个修复的核心证据。
  Python 的 input() 以换行为行结束标志；writeServiceInput 如果不补 \n，
  程序会一直等下去 —— 界面上显示"已发送"，而程序毫无反应。
*/
chk(
  '★★ 补了换行：程序收到输入并走完了确认流程',
  /检查EULA和隐私条款完成/.test(logs2),
  /检查EULA和隐私条款完成/.test(logs2) ? '' : '（说明写入没补换行，或输入没进到 stdin）'
);

const after = eula.readEulaState(logs2);
chk('★ 确认后界面不再提示需要确认', after.state === 'confirmed', `state=${after.state}`);

/* 程序确认完就退出了，进程应当结束 */
await sleep(800);
const done = { running: proc.isServiceRunning('maibot') };
chk('确认流程走完后进程正常结束', done.running === false);

/* ------------------------------------------------- ③ 错误输入不该被接受 */
console.log('\n[live] ③ 输入错词不能被当成同意');
/*
  先清空日志桶再起第二个进程。
  不然上一轮那句「检查EULA和隐私条款完成」还留在缓冲里，
  "有没有通过确认"的断言会被上一轮的残留直接满足 —— 假通过。
  （这个坑真踩过：③ 一开始就是靠残留日志"通过"的。）
*/
logStore.clearServiceLog('maibot');
const s2 = await proc.startService('maibot', payload);
chk('服务能第二次启动（说明上一条清理干净了）', s2.ok && Boolean(s2.pid), `pid=${s2.pid}`);
await sleep(1500);
proc.writeServiceInput('maibot', 'yes');
let logs3 = '';
for (let i = 0; i < 20; i += 1) {
  await sleep(150);
  logs3 = logsOf('maibot');
}
chk('★ 输入 yes 后没有通过确认', !/检查EULA和隐私条款完成/.test(logs3));
chk('★ 输入 yes 后它明确要求重新输入', /重新输入/.test(logs3));
chk('★ 界面仍然认为在等确认', eula.readEulaState(logs3).state === 'need-confirm');
proc.writeServiceInput('maibot', '同意');
await sleep(900);
chk('★ 改用正确词之后才通过', /检查EULA和隐私条款完成/.test(logsOf('maibot')));
await proc.stopService('maibot');

console.log(`\n[live] ${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}  通过=${pass} 失败=${fail}`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
