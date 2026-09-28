/*
================================================================================
脚本：scripts/verify-update-net-real.mjs
职责：用**真实**更新源（api.github.com/repos/LittleSun-Sam/maibot-launcher）
      跑一遍 updater.check()，证明"检查更新"这条路在真机上真的通了。
================================================================================
  与 verify-update-net.mjs 的分工：
    verify-update-net.mjs      —— 离线：证明"不再使用全局 fetch"、重定向/超时/
                                  取消/字节校验的语义没丢（用 127.0.0.1 假服务端）。
    本脚本                      —— 联网：证明真实更新源返回的结果是对的
                                  （ok:true + latest/hasUpdate 与真实 Release 一致）。

  为什么这两件事必须分开：
    离线脚本能证明"实现没有走 Chromium 网络栈"，但证明不了"真机能连通"；
    而真机连通性正是这次故障的现场。只跑其中一个都会漏掉一半。

  本脚本只读 GitHub API（GET），不下载、不安装、不写用户文件。
  退出码：0 = 检查更新真实成功；非 0 = 失败（并打印真实原因）。
================================================================================
*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const electronStub = {
  app: { getVersion: () => pkg.version, quit: () => {} },
  shell: { async openPath() { return ''; } }
};
const Module = require('node:module');
const electronPath = require.resolve('electron', { paths: [ROOT] });
const electronMod = new Module(electronPath, null);
electronMod.filename = electronPath;
electronMod.loaded = true;
electronMod.exports = electronStub;
require.cache[electronPath] = electronMod;
require(path.join(ROOT, 'src/main/windows.js')).sendToRenderer = () => true;

/* 确保走真实更新源（不被离线脚本的环境变量影响） */
delete process.env.MAIBOT_LAUNCHER_UPDATE_REPO;
delete process.env.MAIBOT_LAUNCHER_UPDATE_API;

const updater = require(path.join(ROOT, 'src/main/services/updater.js'));
const constants = require(path.join(ROOT, 'src/main/constants.js'));

const ca = await updater.loadOsCaBundle();
console.log(`[verify-update-net-real] 更新源：${constants.UPDATE.owner}/${constants.UPDATE.repo}`);
console.log(`[verify-update-net-real] 系统根证书：${ca ? `${ca.length} 字节 PEM（已启用）` : '不可用（退回 Node 自带 CA 列表）'}`);

const t0 = Date.now();
const r = await updater.check();
const ms = Date.now() - t0;

console.log(`[verify-update-net-real] check() 用时 ${ms}ms`);
console.log(`[verify-update-net-real] 原始返回：\n${JSON.stringify(
  { ...r, notes: r.notes ? `${r.notes.slice(0, 120)}…（共 ${r.notes.length} 字）` : '' },
  null,
  2
)}`);

let fail = 0;
const chk = (name, ok, extra) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fail += 1;
};

chk('check() 真实成功（ok:true）', r.ok === true, r.message);
chk('configured:true（更新源不是占位值）', r.configured === true);
chk('current 与 package.json 一致', r.current === pkg.version, `${r.current} vs ${pkg.version}`);
if (r.ok) {
  chk('latest 是真实 tag（非空）', /^v?\d+\.\d+\.\d+/.test(String(r.latest)), String(r.latest));
  chk('hasUpdate 是布尔值', typeof r.hasUpdate === 'boolean', String(r.hasUpdate));
  chk('notes 是真实 Release 正文（非空）', String(r.notes || '').trim().length > 0, `${String(r.notes || '').length} 字`);
  chk('asset 指向本仓库的 Release 附件（若该 Release 挂了安装包）',
    !r.asset || /^https:\/\/github\.com\/LittleSun-Sam\/maibot-launcher\/releases\/download\//.test(r.asset.url),
    r.asset ? r.asset.url : '(该 Release 没有可识别附件)');
}

console.log(`\n[verify-update-net-real] 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
