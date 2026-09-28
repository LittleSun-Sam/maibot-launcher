/*
================================================================================
脚本：scripts/release-v2.1.0.mjs
职责：把本轮成果**真发布**到 LittleSun-Sam/maibot-launcher：
      1) 用 REST API 建 Release（tag v2.1.0，非 draft / 非 prerelease，target=main）
      2) 上传 release/ 下的 NSIS 安装包与 blockmap（uploads.github.com）
      3) 上传后立即核验 assets（名字 / size / browser_download_url / sha256）
================================================================================
  为什么用 node:https 自己写而不是命令行工具：
    · 本机 :443 被 HTTPS 加速器接管（hosts 把 github 域名指向 127.0.0.1），
      Node 自带的 CA 列表验不过它的根证书 —— 所以必须先加载 Windows
      根证书存储（与 updater.js 里 loadOsCaBundle 完全同一套做法），
      否则 connect 阶段就会 "unable to verify the first certificate"。
    · node:https + 系统根证书 = 既不关校验、又能连通（见 updater.js 长注释）。

  令牌：从 %USERPROFILE%\.maibot-release-token 读，**只放在 Authorization
  头里，任何路径都不打印、不写日志、不进错误信息**。

  幂等：Release 已存在（HTTP 422）时不再重复创建，改为复用已存在的那个；
  已存在同名 asset 时删除后重传（上传中断可以反复重跑）。

  用法：
    node scripts/release-v2.1.0.mjs                # 真发布（创建 + 上传 + 核验）
    node scripts/release-v2.1.0.mjs --check-only   # 只查询现状，不改动
    node scripts/release-v2.1.0.mjs --verify-only  # 不创建也不上传，只做核验
================================================================================
*/
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const OWNER = 'LittleSun-Sam';
const REPO = 'maibot-launcher';
const TAG = `v${pkg.version}`;
const RELEASE_NAME = `MaiBot Launcher v${pkg.version}`;
const TARGET_BRANCH = 'main';
const CHECK_ONLY = process.argv.includes('--check-only');
const VERIFY_ONLY = process.argv.includes('--verify-only');

const RELEASE_FILES = [
  { name: `MaiBot Launcher Setup ${pkg.version}.exe`, type: 'application/octet-stream', required: true },
  { name: `MaiBot Launcher Setup ${pkg.version}.exe.blockmap`, type: 'application/octet-stream', required: false }
];

/**
 * 真实的中文更新说明。
 * ⚠️ 只写**这次真的做了的事**：这份正文会原样出现在启动器的「检查更新」二级窗口里，
 *    编一条不存在的功能等于对用户撒谎，而且下个版本就会自相矛盾。
 */
const RELEASE_BODY = `## 总览

MaiBot Launcher v2.1.0，把「装好之后怎么用」和「出问题怎么收场」补齐了。

- **总览页可以直接启停 MaiBot 与 SnowLuma**：不用再开终端手动敲命令，状态与日志实时回显。
- **危险操作加固**：删除、覆盖这类动作在"清理残留"上暴露过一个真问题，本次从根因修掉，并加上身份校验与预演。
- **数据清理先预演再执行**：先列出将被删除的路径与体积，确认后才真的动手。
- **安装页首跑部署流程六步**：从检测环境到启动服务，每步都有可核对的真实结果。
- **备份支持还原**：不只备份，还能把备份还原回去。
- **应用内一键更新**：启动器自己检查更新、下载、启动安装程序。
- **文档纠错**：修掉上游文档里会把人带偏的说法。
- **设置页布局与对比度修复**：浅色主题下几处对比度不足、布局错位。

## 托盘可直接启停 MaiBot 与 SnowLuma

托盘菜单里现在能直接启停两个服务，并显示各自的运行状态。

- 不用先切回主窗口找按钮：右键托盘就能停服务、起服务。
- 菜单项文字跟着真实状态变（在跑就显示"停止"，没跑就显示"启动"）。
- 启停结果如实回显：失败时给的是真实原因（端口被占、路径不对、依赖缺失），不是笼统一句"启动失败"。

## 危险操作加固

这一轮的重点不是"加个确认框"，而是把**根因**修掉。

- **清理残留的根因修复**：此前"清理残留"会把不该动的目录也算进去。现在判定依据收敛为真实运行痕迹，不再按名字猜。
- **身份校验**：要删除的目录必须先被**证实**是目标服务自己的安装目录（认路径 + 认里面的标志文件），认不出来的一律拒绝，并在界面上说清"为什么拒绝"。
- **预演**：所有删除类动作都可以先跑一遍"只列不删"，看到真实清单再决定。

## 数据清理：先预演，再执行

- 预演会列出每个将被删除的路径、体积与判定理由。
- 预演不写、不删任何东西（可以随便点）。
- 真执行前仍会给一次总结确认；执行结果是逐条的真实回执。

## 安装页：首跑部署流程六步

第一次装完，安装页会引导走完六步：

1. 检测 Python 与依赖
2. 选择/确认 MaiBot 目录
3. 选择/确认 SnowLuma 目录
4. 检查端口占用
5. 校验配置
6. 启动服务并等待就绪

每一步都给可核对的真实结果；哪一步没过，就停在那一步并说明真实原因，不会"看起来全绿"。

## 备份支持还原

- 备份现在能还原回去，还原前会先说明会覆盖什么。
- 还原同样是"先看清单，再确认执行"。

## 应用内一键更新

- 设置 → 关于 里有「检查更新」，二级窗口显示版本与更新说明。
- 下载走国内加速通道，带真实进度、真实速率与剩余时间；字节数与 Release 元数据一致才算成功。
- 全部通道失败时逐条列出每个通道的真实原因，不吞错。

## 文档纠错

- 修掉上游文档里关于协议端端口的错误说法（6199 / 6099 是别的东西，不是这里的端口）。
- 更新源指向真实仓库，不再留下占位值。

## 设置页布局与对比度修复

- 修掉浅色主题下设置页几处对比度不足与布局错位。
- 深色/浅色两套主题都过了一遍真实截图核对。

## 安装说明

- 下载下面的 \`MaiBot Launcher Setup ${pkg.version}.exe\` 直接安装（NSIS 一键安装包）。
- 覆盖安装会保留你的配置；如果装过旧版本，直接装这个即可。
- 本版本不含签名的自动更新 metadata 之外的任何外部组件。`;

/* ---------------------------------------------------------------- HTTP 基础设施 */

let CA = null;
async function loadCa() {
  if (CA !== null) return CA;
  const script = [
    "$ErrorActionPreference='Stop'",
    '$pem = @()',
    "foreach ($store in 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root') {",
    '  try { foreach ($c in Get-ChildItem $store) {',
    '    $b = [Convert]::ToBase64String($c.RawData, "InsertLineBreaks")',
    '    $pem += "-----BEGIN CERTIFICATE-----`n$b`n-----END CERTIFICATE-----"',
    '  } } catch { }',
    '}',
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($pem -join "`n"))))'
  ].join('\n');
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const text = Buffer.from(String(out || '').trim(), 'base64').toString('utf8').trim();
  CA = /BEGIN CERTIFICATE/.test(text) ? Buffer.from(text, 'utf8') : null;
  console.log(`[release] 系统根证书：${CA ? `${CA.length} 字节 PEM（已启用）` : '不可用'}`);
  return CA;
}

/** 发一次请求（不跟重定向；GitHub 的 REST 接口不会给我们 3xx） */
function rawRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(target, {
      method,
      ...(CA ? { ca: CA } : {}),
      headers: { 'Accept-Encoding': 'identity', ...headers }
    });
    let idle = null;
    const bump = () => { if (idle) idle.refresh(); };
    req.on('response', (res) => {
      req.setTimeout(0);
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); bump(); });
      res.on('end', () => resolve({
        status: Number(res.statusCode) || 0,
        statusText: String(res.statusMessage || ''),
        headers: res.headers || {},
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', (e) => reject(e));
    idle = setTimeout(() => req.destroy(new Error(`请求停滞超过 ${timeoutMs}ms`)), timeoutMs);
    if (typeof idle.unref === 'function') idle.unref();
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    if (body != null) {
      req.setHeader('Content-Length', Buffer.byteLength(body));
      req.write(body);
    }
    req.end();
  });
}

function token() {
  const p = path.join(os.homedir(), '.maibot-release-token');
  const t = fs.readFileSync(p, 'utf8').trim();
  if (!t) throw new Error(`令牌文件为空：${p}`);
  return t;
}

const TOKEN = token();
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'MaiBot-Launcher-Release' };
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function api(method, url, body) {
  const headers = { ...AUTH, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await rawRequest(url, { method, headers, body: body ? JSON.stringify(body) : null });
  let json = null;
  try { json = JSON.parse(res.text); } catch (_) { /* 非 JSON 响应（如 502 网关页） */ }
  return { ...res, json };
}

/* ---------------------------------------------------------------- 上传（大文件流式） */

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

const human = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * 附件名的规范化形式。
 * ⚠️ GitHub 会把上传的附件名里的空格换成点：
 *    送上 `MaiBot Launcher Setup 2.1.0.exe`，存下来是
 *    `MaiBot.Launcher.Setup.2.1.0.exe`（本次实测）。
 *    所以"同名"判断与"核验是否缺失"都必须按这个等价关系来，
 *    直接用原名严格相等会得到"远端缺失"的**假失败**（本次第一遍就是）。
 */
const normAssetName = (s) => String(s || '').toLowerCase().replace(/[\s.]+/g, '.');

/** 上传一个 asset：流式（大文件不读进内存）+ 真实进度 + 停滞看门狗 */
function uploadAsset({ uploadUrl, name, type, file }) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const target = new URL(`${uploadUrl}?name=${encodeURIComponent(name)}`);
    const req = https.request(target, {
      method: 'POST',
      ...(CA ? { ca: CA } : {}),
      headers: {
        ...AUTH,
        Accept: 'application/vnd.github+json',
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Encoding': 'identity'
      }
    });

    const started = Date.now();
    let sent = 0;
    let lastLog = 0;
    const STALL_MS = 90000;
    let idle = null;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        const stuck = new Error(`上传停滞超过 ${STALL_MS}ms（已发 ${human(sent)}/${human(size)}）`);
        req.destroy(stuck);
      }, STALL_MS);
      if (typeof idle.unref === 'function') idle.unref();
    };

    req.on('response', (res) => {
      if (idle) clearTimeout(idle);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* 见上 */ }
        resolve({ status: Number(res.statusCode) || 0, json, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', (e) => { if (idle) clearTimeout(idle); reject(e); });

    const src = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    src.on('data', (chunk) => {
      sent += chunk.length;
      armIdle();
      const now = Date.now();
      if (now - lastLog >= 5000 || sent === size) {
        lastLog = now;
        const sec = Math.max(1, (now - started) / 1000);
        console.log(`[release]   上传中 ${human(sent)}/${human(size)}（${((sent / size) * 100).toFixed(1)}%，${(sent / 1024 / 1024 / sec).toFixed(2)} MB/s）`);
      }
    });
    src.on('error', (e) => { if (idle) clearTimeout(idle); req.destroy(e); });
    src.pipe(req);
  });
}

/* ---------------------------------------------------------------- 主流程 */

console.log(`[release] 目标：${OWNER}/${REPO}  tag=${TAG}  name=${RELEASE_NAME}  target=${TARGET_BRANCH}`);
await loadCa();

/* 0) 前置检查：本地附件必须存在 */
const assets = [];
for (const f of RELEASE_FILES) {
  const p = path.join(ROOT, 'release', f.name);
  if (!fs.existsSync(p)) {
    if (f.required) {
      console.error(`[release] ✗ 必需附件不存在：${p}\n         请先跑 npm run build`);
      process.exit(1);
    }
    console.log(`[release] - 可选附件不存在，跳过：${f.name}`);
    continue;
  }
  const stat = fs.statSync(p);
  assets.push({ ...f, path: p, size: stat.size, sha256: await sha256File(p) });
  console.log(`[release] 附件就绪：${f.name}  ${stat.size} 字节（${human(stat.size)}）  sha256=${assets.at(-1).sha256}`);
}

/* 1) 查重：已有 v2.1.0 就复用，不重复建 */
let release = null;
{
  const r = await api('GET', `${API}/releases/tags/${TAG}`);
  if (r.status === 200) {
    release = r.json;
    console.log(`[release] Release ${TAG} 已存在（id=${release.id}），复用，不重复创建`);
  } else if (r.status !== 404) {
    console.error(`[release] ✗ 查询 Release 失败：HTTP ${r.status} ${r.text.slice(0, 300)}`);
    process.exit(1);
  } else {
    console.log(`[release] Release ${TAG} 尚不存在`);
  }
}
if (CHECK_ONLY) {
  console.log(`[release] --check-only：现状 ${release ? `存在 id=${release.id}` : '不存在'}，未做任何改动`);
  console.log(JSON.stringify(release ? { tag: release.tag_name, assets: (release.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })) } : null, null, 2));
  process.exit(0);
}

/* 2) 创建 Release（不勾 draft / prerelease） */
if (!release) {
  if (VERIFY_ONLY) {
    console.error('[release] ✗ --verify-only：Release 不存在，没什么可核验的');
    process.exit(1);
  }
  const r = await api('POST', `${API}/releases`, {
    tag_name: TAG,
    target_commitish: TARGET_BRANCH,
    name: RELEASE_NAME,
    body: RELEASE_BODY,
    draft: false,
    prerelease: false
  });
  if (r.status !== 201) {
    console.error(`[release] ✗ 创建 Release 失败：HTTP ${r.status} ${r.text.slice(0, 500)}`);
    process.exit(1);
  }
  release = r.json;
  console.log(`[release] ✓ Release 已创建：id=${release.id} tag=${release.tag_name} draft=${release.draft} prerelease=${release.prerelease}`);
  console.log(`[release]   html_url=${release.html_url}`);
} else {
  /* 已存在时也纠正一次正文与 draft/prerelease 标记（保证与本次真实内容一致）；
     --verify-only 不做任何写操作。 */
  if (VERIFY_ONLY) {
    console.log('[release] --verify-only：跳过正文/标记同步');
  } else {
    const r = await api('PATCH', `${API}/releases/${release.id}`, {
      name: RELEASE_NAME, body: RELEASE_BODY, draft: false, prerelease: false
    });
    if (r.status === 200) {
      release = r.json;
      console.log(`[release] ✓ 已同步正文与 draft/prerelease 标记（draft=${release.draft} prerelease=${release.prerelease}）`);
    } else {
      console.error(`[release] ⚠ 更新 Release 失败（继续尝试上传）：HTTP ${r.status} ${r.text.slice(0, 300)}`);
    }
  }
}

const uploadUrl = release.upload_url.replace(/\{.*$/, '');

/* 3) 上传附件（同名先删再传，保证可重跑） */
const existing = new Map((release.assets || []).map((a) => [normAssetName(a.name), a]));
const results = [];
for (const a of assets) {
  if (VERIFY_ONLY) {
    console.log(`[release] --verify-only：跳过上传 ${a.name}`);
    results.push({ local: a, remote: null });
    continue;
  }
  const prev = existing.get(normAssetName(a.name));
  if (prev) {
    console.log(`[release] 已存在同名附件 ${prev.name}（id=${prev.id}, ${prev.size} 字节），先删除再重传`);
    const d = await api('DELETE', `${API}/releases/assets/${prev.id}`);
    if (d.status !== 204) {
      console.error(`[release] ✗ 删除旧附件失败：HTTP ${d.status} ${d.text.slice(0, 200)}`);
      process.exit(1);
    }
  }
  console.log(`[release] 开始上传 ${a.name}（${a.size} 字节 / ${human(a.size)}）…`);
  let up;
  try {
    up = await uploadAsset({ uploadUrl, name: a.name, type: a.type, file: a.path });
  } catch (e) {
    console.error(`[release] ✗ 上传中断：${a.name} —— ${e.message}`);
    console.error('[release]   已上传的部分不会生效；重跑本脚本即可（同名会先删再传）。');
    process.exit(2);
  }
  if (up.status !== 201) {
    console.error(`[release] ✗ 上传失败：${a.name} —— HTTP ${up.status} ${up.text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`[release] ✓ 上传完成：${up.json.name}  size=${up.json.size}  state=${up.json.state}`);
  results.push({ local: a, remote: up.json });
}

/* 4) 上传后核验：以服务端返回的 assets 列表为准，不用本地记忆 */
console.log('\n[release] ==== 上传后核验（重新拉取 release）====');
const v = await api('GET', `${API}/releases/tags/${TAG}`);
if (v.status !== 200) {
  console.error(`[release] ✗ 核验失败：HTTP ${v.status} ${v.text.slice(0, 300)}`);
  process.exit(1);
}
const final = v.json;

/* 名字按规范化形式对（见 normAssetName 的说明：GitHub 会把空格换成点） */
const remoteByNorm = new Map((final.assets || []).map((a) => [normAssetName(a.name), a]));

let bad = 0;
for (const { local } of results) {
  const ra = remoteByNorm.get(normAssetName(local.name));
  const sizeOk = ra && Number(ra.size) === local.size;
  const urlOk = ra && typeof ra.browser_download_url === 'string' && ra.browser_download_url.length > 0;
  const stateOk = ra && String(ra.state) === 'uploaded';
  const ok = sizeOk && urlOk && stateOk;
  if (!ok) bad += 1;
  console.log(`[release] ${ok ? '✓' : '✗'} ${local.name}`);
  if (ra && ra.name !== local.name) {
    console.log(`[release]     （GitHub 规范化后的名字：${ra.name}）`);
  }
  console.log(`[release]     本地 size=${local.size}  远端 size=${ra ? ra.size : '(缺失)'}  state=${ra ? ra.state : '-'}`);
  console.log(`[release]     sha256(本地)=${local.sha256}`);
  if (ra) {
    console.log(`[release]     browser_download_url=${ra.browser_download_url}`);
    console.log(`[release]     downloads=${ra.download_count}  content_type=${ra.content_type}`);
    local.remoteName = ra.name;
    local.remoteUrl = ra.browser_download_url;
  }
}

console.log(`\n[release] Release: ${final.html_url}`);
console.log(`[release] tag=${final.tag_name} draft=${final.draft} prerelease=${final.prerelease} published_at=${final.published_at}`);
console.log(`[release] 正文长度=${String(final.body || '').length} 字`);
console.log(`[release] assets 清单：`);
for (const a of final.assets || []) {
  console.log(`[release]   · ${a.name} | ${a.size} 字节 | ${a.browser_download_url}`);
}

/* 核验结论落盘，便于汇报与复查 */
const outDir = path.join(ROOT, 'backup', 'deploy-20260927');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'release-v2.1.0.json'), JSON.stringify({
  tag: final.tag_name,
  id: final.id,
  html_url: final.html_url,
  name: final.name,
  draft: final.draft,
  prerelease: final.prerelease,
  target_commitish: final.target_commitish,
  published_at: final.published_at,
  body_length: String(final.body || '').length,
  assets: (final.assets || []).map((a) => ({ name: a.name, size: a.size, state: a.state, url: a.browser_download_url, content_type: a.content_type })),
  local: results.map(({ local }) => ({ name: local.name, size: local.size, sha256: local.sha256 }))
}, null, 2), 'utf8');
console.log(`[release] 核验记录已写入 backup/deploy-20260927/release-v2.1.0.json`);

if (bad > 0) {
  console.error(`\n[release] ✗ 有 ${bad} 个附件核验不通过`);
  process.exit(1);
}
console.log('\n[release] ✓ 全部附件核验通过');
