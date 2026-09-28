/*
================================================================================
脚本：scripts/verify-repo-fallback.mjs
职责：拿**真实 GitHub API** 验证仓库解析（resolveRepo）的回退行为。
================================================================================
  为什么必须单独做这个验证：
    resolveRepo 探测仓库用的是 Electron 主进程的 fetch，
    纯 Node 脚本跑不出同样的行为，所以它没法用普通单元测试覆盖。
    而它要修的正是"老配置里留着已改名的仓库"这类真实故障 ——
    这类问题读代码很容易看漏（原实现的判定条件
    `target === REPOS.maibot` 就是不满足时不回退，一眼看不出差别），
    必须拿真实网络跑一遍。

  覆盖的场景：
    1) 已废弃的旧仓库名 MaiBot/MaiBot → 必须自动切到候选仓库
       （这正是当前用户配置文件里的值，也是触发本脚本的原因）
    2) 非法仓库名 → 必须回退到默认仓库
    3) 合法的官方仓库名 → 必须原样使用，不能"多此一举"地切换
    4) SnowLuma 默认仓库 → 必须能解析出来

  用法：
    node scripts/verify-repo-fallback.mjs
    需要先 npm run build（或直接用 npm run verify:repo，它会先构建）。

  退出码：0 = 全部通过；非 0 = 有断言失败。
================================================================================
*/
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 90000;

const electronBin = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

function fail(msg) {
  console.error(`[repo] ✗ ${msg}`);
  process.exitCode = 1;
}

/*
  本地假 GitHub API。
  ─────────────────────────────────────────────────────────────────────
  为什么不再直连 api.github.com：
    未认证配额只有 60 次/小时。用尽之后 API 返回 403，而 resolveRepo
    出于正确的原因（403 不能证明仓库不存在）会沿用配置值 ——
    于是"旧仓库名自动切候选"这条断言得到 switched=false 的**假失败**。
    实测撞到过 remaining=0，这条测试因此长期不可靠。
  现在行为完全由这里定义，离线、确定、跑多少次结果都一样。
*/
const FAKE = {
  'Mai-with-u/MaiBot': 200,
  'SnowLuma/SnowLuma': 200,
  'MaiBot/MaiBot': 404, // 已改名的旧仓库：必须触发切换
  'not a repo!!': 400 // 非法名字（正常情况下不会发请求，这里只是兜底）
};

const server = http.createServer((req, res) => {
  let pathname = '';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (_) {
    res.writeHead(400).end('{}');
    return;
  }
  const m = /^\/repos\/([^/]+)\/([^/]+?)(\/releases)?$/.exec(pathname);
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  const full = `${m[1]}/${m[2]}`;

  /* 限流/被拒：resolveRepo 必须沿用它，绝不能静默换成官方仓库 */
  if (/^rate-limit-test\//i.test(full)) {
    res
      .writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' })
      .end('{"message":"API rate limit exceeded"}');
    return;
  }
  if (m[3]) {
    /* releases 端点：返回空数组即可，本测试不校验发布列表 */
    res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    return;
  }
  const code = FAKE[full];
  if (code === 200) {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ full_name: full, name: m[2] }));
    return;
  }
  res.writeHead(code || 404, { 'content-type': 'application/json' }).end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fakeApi = `http://127.0.0.1:${server.address().port}`;

console.log(`[repo] 用本地假 GitHub API 验证仓库回退… (${fakeApi})`);

const child = spawn(electronBin, ['.'], {
  cwd: ROOT,
  env: {
    ...process.env,
    MAIBOT_LAUNCHER_GITHUB_PROBE: '1',
    /* 指向本地假 API：不依赖网络，也不消耗 GitHub 配额 */
    MAIBOT_LAUNCHER_GITHUB_API: fakeApi,
    /* 隔离 userData，绝不碰用户真实配置 */
    MAIBOT_LAUNCHER_USER_DATA: path.join(
      process.env.TEMP || process.env.TMPDIR || '/tmp',
      `maibot-repo-probe-${Date.now()}`
    )
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => {
  stdout += d.toString();
});
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

const timer = setTimeout(() => {
  fail(`超时（${TIMEOUT_MS}ms）未取得探针结果`);
  child.kill();
}, TIMEOUT_MS);

child.on('close', () => {
  clearTimeout(timer);

  /*
    用标记切片而不是贪婪正则取 JSON。
    之前 verify-ipc.mjs 就踩过这个坑：报告里只要出现嵌套的 `}`，
    贪婪匹配就会把 JSON 截断。这里保持同样的稳健做法。
  */
  const START = '__GITHUB_PROBE__';
  const END = '__END__';
  const start = stdout.indexOf(START);
  const end = stdout.indexOf(END, start + START.length);

  if (start < 0 || end < 0) {
    fail('未在输出中找到探针结果标记');
    console.error('--- stdout ---\n' + stdout.slice(-2000));
    console.error('--- stderr ---\n' + stderr.slice(-2000));
    return;
  }

  let report;
  try {
    report = JSON.parse(stdout.slice(start + START.length, end));
  } catch (e) {
    fail(`探针结果不是合法 JSON: ${e.message}`);
    console.error(stdout.slice(start, end + END.length));
    return;
  }

  if (report.errors?.length) {
    report.errors.forEach((e) => fail(`探针内部错误: ${e}`));
  }

  const byName = Object.fromEntries((report.cases || []).map((c) => [c.name, c]));
  console.log(`[repo] 解析结果（${(report.cases || []).length} 例）:`);
  for (const c of report.cases || []) {
    console.log(`  · ${c.name.padEnd(16)} 输入="${c.input}" → ${c.repo}  switched=${c.switched}`);
  }

  /* ---- 断言 ---- */
  const checks = [
    {
      name: '旧仓库名会自动切到候选',
      ok: () => {
        const c = byName['stale-old-name'];
        return c && c.repo !== 'MaiBot/MaiBot' && c.switched === true;
      },
      detail: () =>
        `期望切到候选且 switched=true，实际 repo=${byName['stale-old-name']?.repo} switched=${byName['stale-old-name']?.switched}`
    },
    {
      name: '非法仓库名回退到默认仓库',
      ok: () => {
        const c = byName['invalid-name'];
        return c && /^[\w.-]+\/[\w.-]+$/.test(c.repo);
      },
      detail: () => `实际 repo=${byName['invalid-name']?.repo}`
    },
    {
      name: '合法的官方仓库原样使用且不切换',
      ok: () => {
        const c = byName['valid-primary'];
        return c && c.repo === 'Mai-with-u/MaiBot' && c.switched === false;
      },
      detail: () =>
        `期望 Mai-with-u/MaiBot switched=false，实际 repo=${byName['valid-primary']?.repo} switched=${byName['valid-primary']?.switched}`
    },
    {
      name: 'SnowLuma 默认仓库可解析',
      ok: () => {
        const c = byName['snowluma-default'];
        return c && /^[\w.-]+\/[\w.-]+$/.test(c.repo);
      },
      detail: () => `实际 repo=${byName['snowluma-default']?.repo}`
    },
    {
      /*
        这条是离线化之后**新增**的覆盖：403（限流/被拒）不能证明仓库不存在，
        必须沿用用户配置的仓库，否则一次网络抖动就把用户的 fork 静默换成官方仓库
        —— 属于"装错项目"这类最难查的问题。
        以前没法稳定测这条，因为真实 API 的 403 是随机出现的。
      */
      name: '403 限流时沿用配置的仓库，不静默切换',
      ok: () => {
        const c = byName['rate-limited'];
        return c && c.repo === 'rate-limit-test/keep-me' && c.switched === false;
      },
      detail: () =>
        `期望沿用 rate-limit-test/keep-me 且 switched=false，实际 repo=${byName['rate-limited']?.repo} switched=${byName['rate-limited']?.switched}`
    }
  ];

  let failed = 0;
  for (const c of checks) {
    if (c.ok()) {
      console.log(`[repo] ✓ ${c.name}`);
    } else {
      fail(`${c.name}：${c.detail()}`);
      failed += 1;
    }
  }

  if (failed) console.error(`[repo] ✗ ${failed}/${checks.length} 项断言失败`);
  else console.log(`[repo] ✓ 全部 ${checks.length} 项断言通过`);
});

child.on('error', (e) => {
  clearTimeout(timer);
  fail(`无法启动 Electron: ${e.message}`);
  server.close();
});

/*
  收尾必须关掉假 API 服务器，否则脚本会挂着一个监听端口不退出
  （在 CI 里表现为"测试跑完了但进程不结束"）。
*/
child.on('exit', () => {
  server.close();
});
