/*
================================================================================
scripts/verify-ipc.mjs —— IPC 契约冒烟验证
================================================================================
职责：在隔离 userData 下真实启动一次 Electron，逐个调用**关键 IPC 通道**，
      assert 返回值结构。用于回归"通道注册成功 + 返回值形状正确"。

为什么需要它：
  主进程的 safeHandle 把 handler 注册包在 try/catch 里，
  某个模块注册失败只会写一行 error 日志，界面表现为"点了没反应"。
  selfcheck 只验证页面能渲染，不验证 IPC 契约 —— 缺口就在这里。

用法：node scripts/verify-ipc.mjs
================================================================================
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), `maibot-ipc-${Date.now().toString(36)}`);
const TIMEOUT_MS = 60000;

function resolveElectron() {
  const rel = process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : process.platform === 'darwin'
      ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      : 'node_modules/electron/dist/electron';
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? p : null;
}

/*
  探针在 preload 里静态实现（见 preload.js 末尾），
  这里不再注入代码 —— 渲染进程 CSP 是 script-src 'self'，
  eval / new Function 会被当场拒绝，注入路线走不通。
*/
function main() {
  const electronBin = resolveElectron();
  if (!electronBin) {
    console.error('[ipc] 找不到 electron 可执行文件，请先 npm install');
    process.exit(1);
  }
  fs.mkdirSync(SANDBOX, { recursive: true });

  console.log('[ipc] 隔离 userData:', SANDBOX);
  const child = spawn(
    electronBin,
    [ROOT, '--no-sandbox', '--ipc-probe'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        MAIBOT_LAUNCHER_USER_DATA: SANDBOX,
        MAIBOT_LAUNCHER_IPC_PROBE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    process.exit(code);
  };

  const timer = setTimeout(() => {
    console.error('[ipc] ✗ 超时未收到探针回报');
    console.error('--- stdout 尾部 ---');
    console.error(stdout.slice(-2000) || '(空)');
    console.error('--- stderr 尾部 ---');
    console.error(stderr.slice(-1200) || '(空)');
    finish(1);
  }, TIMEOUT_MS);

  child.on('exit', () => {
    /* 进程先退出了，给 stdout 收尾一点时间再判定 */
    setTimeout(() => {
      if (!done) {
        console.error('[ipc] ✗ Electron 已退出但未收到探针回报');
        console.error('--- stdout 尾部 ---');
        console.error(stdout.slice(-2000) || '(空)');
        finish(1);
      }
    }, 400);
  });

  /* 报告可能很长且含嵌套 } —— 用标记切分，不要用非贪婪正则 */
  const onData = () => {
    const start = stdout.indexOf('__IPC_REPORT__');
    if (start < 0) return;
    const end = stdout.indexOf('__END__', start);
    if (end < 0) return;
    const raw = stdout.slice(start + '__IPC_REPORT__'.length, end);
    let report;
    try {
      report = JSON.parse(raw);
    } catch (e) {
      console.error('[ipc] ✗ 报告 JSON 解析失败:', e.message);
      console.error('原文:', raw.slice(0, 800));
      finish(1);
      return;
    }
    console.log('\n[ipc] 通道验证结果:');
    let bad = 0;
    for (const [k, v] of Object.entries(report)) {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      /*
        判定标准：
          undefined / 抛出 / 被拒   → 通道坏了
          ASSERT_FAIL               → 通道通了但内容不对（恒真假实现）
          {ok:false}                → 合法业务失败（如未配置），不算坏
      */
      const failed =
        (typeof v === 'string' && /THREW|REJECTED|^undefined$/.test(v)) ||
        (v && typeof v === 'object' && v.ASSERT_FAIL);
      if (failed) bad += 1;
      console.log(`  ${failed ? '✗' : '✓'} ${k.padEnd(22)} ${s}`);
    }
    console.log(`\n[ipc] ${bad === 0 ? '✓ 全部通道正常（含内容断言）' : `✗ ${bad} 个通道异常`}`);
    finish(bad === 0 ? 0 : 1);
  };
  child.stdout.on('data', onData);
}

main();
