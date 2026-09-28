/*
================================================================================
回归测试：多线程分段下载 + SHA-256 校验。
================================================================================
  为什么这个测试必须存在：
    "多线程下载"最可怕的失败方式不是报错，而是**静默地写出一个内容错位的文件**
    —— 每段都从错误的偏移开始写，大小看起来完全正常，只有装到一半才炸。
    所以本测试的核心断言不是"ok===true"，而是**逐字节完全相同**，
    并且刻意构造了几种会让分片出错的服务端行为。

  全程离线：自己起 HTTP 服务端，不碰真实网络。
  并且把 github.useMirror 打桩关掉 —— 否则 candidateUrls 会给
  http://127.0.0.1 套上 ghproxy 前缀去真的访问外网，测试就变得又慢又不确定。

  覆盖：
    ① 支持 Range → 真的并发了 6 段，且文件逐字节一致、sha256 一致
    ② 错误的 sha256 → 必须失败，并且**把坏文件删掉**（不能留给用户）
    ③ 服务端不支持 Range → 自动退回单连接，文件仍逐字节一致
    ④ 服务端"探测时说支持、分段时又反悔" → 退回单连接，文件仍一致
    ⑤ 某一段第一次传输被掐断 → 整段重取，文件仍逐字节一致
    ⑥ 大小不符 → 失败并删文件
    ⑦ 纯函数：分段数决策 / digest 解析
================================================================================
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/* ---- 关键：在 require github.js **之前**把设置打桩，关掉镜像 ---- */
const settingsMod = require(path.join(ROOT, 'src/main/services/settings.js'));
settingsMod.getBackendSettings = () => ({ github: { useMirror: false, downloadThreads: 0 } });

/*
  把投递给渲染层的进度事件截下来。
  为什么能这样截：github.js 在**模块加载时**做了
  `const { sendToRenderer } = require('../windows')`（解构 = 当场抓住函数引用），
  所以必须先改 windows 模块、再 require github.js。
  这样进度事件的**契约**（帧的顺序、字段含义）就能在离线测试里钉住，
  不用每次都靠真机 CDP 采样界面。
*/
const windowsMod = require(path.join(ROOT, 'src/main/windows.js'));
const events = [];
windowsMod.sendToRenderer = (channel, payload) => {
  events.push({ channel, ...payload });
  return true;
};

const github = require(path.join(ROOT, 'src/main/services/github.js'));

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

/* ---------------------------------------------------------------- 测试夹具 */
const PAYLOAD = crypto.randomBytes(6 * 1024 * 1024); // 6MB，大于 4MB 分片门槛
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maibot-dl-test-'));
/* 每个分段起点只掉一次链，用来验证"整段重取"的路劲 */
const dropped = new Set();

const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  const size = PAYLOAD.length;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');

  const sendFull = () => {
    res.writeHead(200, { 'Content-Length': String(size), 'Content-Type': 'application/zip' });
    res.end(PAYLOAD);
  };
  const sendRange = (start, end) => {
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/zip'
    });
    res.end(PAYLOAD.subarray(start, end + 1));
  };

  /* 完全不认 Range：永远回 200 + 完整正文 */
  if (route === '/norange') return sendFull();

  /* 探测时（bytes=0-0）假装支持，真要分段时又回 200 全量 */
  if (route === '/liar') {
    if (m && m[1] === '0' && m[2] === '0') return sendRange(0, 0);
    return sendFull();
  }

  /*
    探测时报一个**偏大**的总长，模拟"镜像缓存了另一个版本的文件"。
    真实区间仍然按正确内容返回。
  */
  if (route === '/liar-size' && m && m[1] === '0' && m[2] === '0') {
    res.writeHead(206, {
      'Content-Range': `bytes 0-0/${size + 999999}`,
      'Content-Length': '1',
      'Accept-Ranges': 'bytes'
    });
    return res.end(PAYLOAD.subarray(0, 1));
  }

  if (!m) return sendFull();
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Length': '0' });
    return res.end();
  }

  /* 非首段：第一次只发一半就掐断连接 */
  if (route === '/drop' && start > 0 && !dropped.has(start)) {
    dropped.add(start);
    const len = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(len),
      'Accept-Ranges': 'bytes'
    });
    res.write(PAYLOAD.subarray(start, start + Math.floor(len / 2)));
    setTimeout(() => res.destroy(), 40);
    return;
  }

  return sendRange(start, end);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;

const dest = (name) => path.join(TMP, name);
const same = (file) => {
  try {
    return Buffer.compare(fs.readFileSync(file), PAYLOAD) === 0;
  } catch (_) {
    return false;
  }
};

/* =============================================== ① 真并发 + 逐字节一致 */
console.log('[download] ① 支持 Range → 分段并发下载');
{
  const r = await github.downloadToFile({
    url: `${base}/range`,
    destFile: dest('a.zip'),
    fileName: 'a.zip',
    expectSize: PAYLOAD.length,
    expectSha256: PAYLOAD_SHA,
    threads: 6
  });

  chk('★ 下载成功', r.ok === true, r.message);
  chk('★ 确实开了多线程（6 段）', r.segments === 6, `segments=${r.segments}`);
  chk('★ 校验方式是真 sha256（不是只比大小）', r.verify === 'sha256', `verify=${r.verify}`);
  chk('★ 算出的 sha256 与上游一致', r.sha256 === PAYLOAD_SHA, r.sha256?.slice(0, 16) + '…');
  chk('★ 大小一致', r.bytes === PAYLOAD.length, `${r.bytes}/${PAYLOAD.length}`);
  chk('★★ 文件内容逐字节完全相同（分段偏移没写错）', same(dest('a.zip')));
}

/* =============================================== ② 校验不过必须删文件 */
console.log('\n[download] ② SHA-256 不匹配 → 必须失败且删掉坏文件');
{
  const wrong = crypto.randomBytes(32).toString('hex');
  const target = dest('b.zip');
  const r = await github.downloadToFile({
    url: `${base}/range`,
    destFile: target,
    fileName: 'b.zip',
    expectSize: PAYLOAD.length,
    expectSha256: wrong,
    threads: 4
  });

  chk('★ 拒绝接受摘要不符的文件', r.ok === false, r.message);
  chk('★ 明确指出是 SHA-256 校验不通过', /SHA-256 校验不通过/.test(r.message || ''), r.message);
  chk('★ 坏文件已被删除（不留半成品给用户）', !fs.existsSync(target));
}

/* =============================================== ③ 不支持 Range → 单连接 */
console.log('\n[download] ③ 服务端不支持 Range → 自动退回单连接');
{
  const r = await github.downloadToFile({
    url: `${base}/norange`,
    destFile: dest('c.zip'),
    fileName: 'c.zip',
    expectSize: PAYLOAD.length,
    threads: 6
  });
  chk('★ 下载成功', r.ok === true, r.message);
  chk('★ 自动退成单连接（没有硬上分段）', r.segments === 1, `segments=${r.segments}`);
  chk('★ 文件内容逐字节一致', same(dest('c.zip')));
}

/* =============================================== ④ 探测与实际不一致 */
console.log('\n[download] ④ 探测说支持、分段请求却回 200 → 退回单连接');
{
  const r = await github.downloadToFile({
    url: `${base}/liar`,
    destFile: dest('d.zip'),
    fileName: 'd.zip',
    expectSize: PAYLOAD.length,
    threads: 6
  });
  chk('★ 下载成功', r.ok === true, r.message);
  chk('★ 没有把整份正文写进某个分段的偏移（退回单连接）', r.segments === 1, `segments=${r.segments}`);
  chk('★ 文件内容逐字节一致', same(dest('d.zip')));
}

/* =============================================== ⑤ 分段中途被掐断 → 重取 */
console.log('\n[download] ⑤ 某段第一次被掐断 → 整段重取后仍然正确');
{
  dropped.clear();
  const r = await github.downloadToFile({
    url: `${base}/drop`,
    destFile: dest('e.zip'),
    fileName: 'e.zip',
    expectSize: PAYLOAD.length,
    expectSha256: PAYLOAD_SHA,
    threads: 6
  });
  chk('★ 下载成功（重试后恢复）', r.ok === true, r.message);
  chk('★ 确实发生了掐断（测试真的生效了）', dropped.size > 0, `被掐断的分段数=${dropped.size}`);
  chk('★ 校验通过', r.verify === 'sha256');
  chk('★★ 文件内容逐字节一致（重取没有造成错位）', same(dest('e.zip')));
}

/* =============================================== ⑥ 大小不符 */
console.log('\n[download] ⑥ 大小不符 → 失败并删文件');
{
  const target = dest('f.zip');
  const r = await github.downloadToFile({
    url: `${base}/range`,
    destFile: target,
    fileName: 'f.zip',
    expectSize: PAYLOAD.length + 12345,
    threads: 4
  });
  chk('★ 拒绝大小不符的文件', r.ok === false, r.message);
  chk('★ 坏文件已删除', !fs.existsSync(target));
}

/* =============================================== ⑦ 镜像谎报总长 */
console.log('\n[download] ⑦ 镜像谎报总长 → 以 GitHub API 的 size 为准');
{
  /*
    这是"信谁"的问题：镜像的 Content-Range 是镜像自己说的，
    而 expectSize 来自 Release 元数据。若信镜像，
    分段区间会按一个偏大的长度去算，最后一段越界 → 整条下载失败
    （旧实现的症状就是"下载不完整"）。
    这里断言：以 API 的 size 为准时，一切都正常，文件也对。
  */
  const r = await github.downloadToFile({
    url: `${base}/liar-size`,
    destFile: dest('g.zip'),
    fileName: 'g.zip',
    expectSize: PAYLOAD.length,
    expectSha256: PAYLOAD_SHA,
    threads: 6
  });
  chk('★ 下载成功（没被镜像的假总长带偏）', r.ok === true, r.message);
  chk('★ 仍然真的并发了 6 段', r.segments === 6, `segments=${r.segments}`);
  chk('★ sha256 校验通过', r.verify === 'sha256');
  chk('★★ 文件内容逐字节一致', same(dest('g.zip')));
}

/* =============================================== ⑧ 纯函数 */
console.log('\n[download] ⑧ 分段数与 digest 解析');{
  const S = github.resolveSegmentCount;
  const MIN = github.SEGMENT_MIN_BYTES;
  chk('★ 小于门槛 → 不分段', S(0, MIN - 1) === 1, String(S(0, MIN - 1)));
  chk('★ 用户要求 1 线程 → 一定单连接（哪怕文件很大）', S(1, 999 * 1024 * 1024) === 1);
  chk('★ 用户指定 6 线程 → 6', S(6, 100 * 1024 * 1024) === 6);
  chk('★ 并发数被夹到上限 8（配置写 999 也不会真开 999 条连接）', S(999, 100 * 1024 * 1024) === 8);
  chk('★ 自动模式：小文件 4 段', S(0, 5 * 1024 * 1024) === 4, String(S(0, 5 * 1024 * 1024)));
  chk('★ 自动模式：大文件到上限 8 段', S(0, 500 * 1024 * 1024) === 8, String(S(0, 500 * 1024 * 1024)));
  chk('★ 不知道大小时不分段（无法算偏移）', S(0, 0) === 1);

  const P = github.parseDigest;
  const hex = 'a'.repeat(64);
  chk('★ 正常 sha256 解析成功', P(`sha256:${hex}`) === hex);
  chk('★ 大小写不敏感', P(`SHA256:${'B'.repeat(64)}`) === 'b'.repeat(64));
  chk('★ 其它算法一律不认（宁可当作没有，也不假装校验过）', P(`sha512:${hex}`) === '');
  chk('★ 长度不对不认', P('sha256:abc') === '');
  chk('★ 非十六进制不认', P(`sha256:${'z'.repeat(64)}`) === '');
  chk('★ 空值安全', P(undefined) === '' && P(null) === '');
}

/* =============================================== ⑨ digest 必须一路带到下载器 */
console.log('\n[download] ⑨ Release 元数据里的 digest 不能被丢掉');
{
  /*
    这是整条校验链最容易被"顺手改坏"的一环：
    如果 normalizeRelease 不再把 digest 带出来，downloadAsset / installSnowLuma
    拿到的 expectSha256 就是空 —— 校验会**静默降级**成"只比大小"，
    界面照样显示"下载完成"，用户以为校验过了，其实没有任何哈希比对。
    没有断言钉住的话，这种退化不会有任何症状。
  */
  const hex = 'c'.repeat(64);
  const fake = {
    id: 1,
    tag_name: 'v9.9.9',
    name: 'rel',
    prerelease: false,
    draft: false,
    published_at: '2026-01-01T00:00:00Z',
    body: 'x',
    assets: [
      { id: 11, name: 'a.zip', size: 123, download_count: 5, browser_download_url: 'https://e/a.zip', digest: `sha256:${hex}` },
      { id: 12, name: 'b.zip', size: 456, download_count: 6, browser_download_url: 'https://e/b.zip' },
      { id: 13, name: 'c.zip', size: 789, download_count: 7, browser_download_url: 'https://e/c.zip', digest: 'md5:deadbeef' }
    ]
  };
  const n = github.normalizeRelease(fake);
  chk('★ 有 digest 的附件被解析成 sha256', n.assets[0].digest === hex, n.assets[0].digest?.slice(0, 12) + '…');
  chk('★ 没有 digest 的附件是空串（触发"只校验大小"的如实降级）', n.assets[1].digest === '');
  chk('★ 不支持的算法（md5）当作没有，不冒充 sha256', n.assets[2].digest === '');
  chk('★ 其它字段仍在', n.assets[0].name === 'a.zip' && n.assets[0].size === 123 && n.tag_name === 'v9.9.9');
}

/* ---------------------------------------------------------------- 收尾 */
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
/* =============================================== ⑩ 进度事件契约 */
console.log('\n[download] ⑩ 推给界面的进度事件必须自成一条时间线');
{
  /*
    界面完全靠这些帧说话。这里钉住三件最容易退化的事：
      1) **第一帧必须在测速之前发出**，否则真实网络下头 3~4 秒
         进度条一动不动（直连 GitHub 要等超时），像卡死；
         而且这一帧不能声称"单连接"—— 此时还不知道会不会分段。
      2) 必须有 verify 帧，否则大文件算 sha256 的那一两秒界面没有反馈，
         用户会以为下载失败了。
      3) done 必须是最后一帧（且 percent=100）；error 时不能再冒出 done，
         否则界面会在失败后显示"下载完成"。
  */
  events.length = 0;
  const r = await github.downloadToFile({
    url: `${base}/range`,
    destFile: dest('h.zip'),
    fileName: 'h.zip',
    expectSize: PAYLOAD.length,
    expectSha256: PAYLOAD_SHA,
    threads: 6
  });
  chk('★ 下载成功', r.ok === true, r.message);

  const first = events[0];
  chk('★ 第一帧就是 start（不是等字节到了才发）', first && first.phase === 'start', first?.phase);
  chk('★ 第一帧说明了"在测速选源"', /测速/.test(first?.message || ''), first?.message);
  chk(
    '★ 第一帧不谎称线程数（segments=0，界面据此不显示）',
    first?.segments === 0,
    `segments=${first?.segments}`
  );
  chk('★ 第一帧 received=0', first?.received === 0);

  const starts = events.filter((e) => e.phase === 'start');
  chk('★ 随后有 start 帧给出真实分段数 6', starts.some((e) => e.segments === 6));
  chk('★ 有 verify 帧（校验中要有反馈）', events.some((e) => e.phase === 'verify'));
  chk('★ 每一帧都带 fileName（界面靠它对齐是哪一行）', events.every((e) => e.fileName === 'h.zip'));

  const last = events[events.length - 1];
  chk('★ 最后一帧是 done', last?.phase === 'done', last?.phase);
  chk('★ done 的 percent 是 100', last?.percent === 100, String(last?.percent));
  chk('★ done 如实标注 verify=sha256', last?.verify === 'sha256', last?.verify);
  chk('★ done 带上 sha256 供界面/日志引用', last?.sha256 === PAYLOAD_SHA);
  chk('★ 进度事件里 percent 从不超过 100', events.every((e) => !(e.percent > 100)));
  chk(
    '★ 进度帧的 received 单调不减（除了重试时的回退，这里没有重试）',
    events.filter((e) => e.phase === 'progress').every((e, i, a) => i === 0 || e.received >= a[i - 1].received)
  );

  /* 失败路径：最后一帧必须是 error，绝不能再出现 done */
  events.length = 0;
  await github.downloadToFile({
    url: `${base}/range`,
    destFile: dest('i.zip'),
    fileName: 'i.zip',
    expectSize: PAYLOAD.length,
    expectSha256: 'f'.repeat(64),
    threads: 4
  });
  const lastErr = events[events.length - 1];
  chk('★ 校验失败时最后一帧是 error（不能被 done 盖掉）', lastErr?.phase === 'error', lastErr?.phase);
  chk('★ 失败帧里没有 verify=sha256 的"通过"结论', events.every((e) => e.verify !== 'sha256'));
}

console.log(`\n[download] ${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}  通过=${pass} 失败=${fail}`);
process.exit(fail === 0 ? 0 : 1);
