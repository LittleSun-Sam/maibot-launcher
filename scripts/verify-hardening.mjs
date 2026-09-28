/*
================================================================================
回归测试：本轮修掉的 7 个真实缺陷。
================================================================================
  这些缺陷有一个共同特征：**界面不报错、日志不报错，但行为是错的**。
  所以它们靠"启动一次看看"是发现不了的，必须写成断言钉住。

  覆盖：
    ① Temperature 被静默取整 → 温度 0.75 变 0 并落盘（会改坏配置）
    ② 分块加载失败完全静默 → 点了没反应，关掉重开也救不回来
    ③ 桌面通知文案 "连续失败 undefined 次"
    ④ 换页不回到顶部 → 新页面停在半中间，顶部内容被切掉
    ⑤ 告警托盘压住设置页「应用 / 取消」→ 按钮点不到
    ⑥ 端口就绪误判 → 别人的程序占着端口，也报"已启动并就绪"
    ⑦ 模板把普通函数直接插值 → 界面上显示出一段 JS 源码
       （真机跑下载、采样 DOM 才抓到的；eslint/build 全都是绿的）

  ①的检测逻辑和②的判定函数是可以**真跑**的，所以做成功能测试；
  其余几条是模板/结构层面的修正，用源码断言（沿用本项目 verify-* 的既有做法）。
================================================================================
*/

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

/* ============================================================ ① Temperature */
console.log('[hardening] ① Temperature 不能被静默取整');
{
  const textInput = read('src/renderer/components/ui/TextInput.vue');
  const settings = read('src/renderer/views/SettingsPanel.vue');

  chk('★ TextInput 提供 allowFloat 开关', /allowFloat:\s*\{\s*type:\s*Boolean/.test(textInput));
  chk(
    '★ coerce 在 allowFloat 时不做 Math.trunc',
    /props\.allowFloat\s*\?\s*n\s*:\s*Math\.trunc\(n\)/.test(textInput)
  );
  chk(
    '★ 未开启 allowFloat 时仍然按整数清洗（端口/毫秒这类字段依赖它）',
    /Math\.trunc\(n\)/.test(textInput)
  );
  /*
    min/max 必须**透传到原生 input**：声明成 props 后 Vue 不再自动落到 DOM，
    不显式绑定的话 <input type="number"> 的上下箭头就没有边界，
    用户能点出 5，虽然 coerce 会夹回 2，但体验上是"我输的数被吃了"。
  */
  chk(
    '★ min/max 透传到原生 input（上下箭头才有边界）',
    /:min="min"/.test(textInput) && /:max="max"/.test(textInput)
  );
  chk(
    '★ 超范围被夹到边界（不落到配置文件里）',
    /v\s*<\s*props\.min\)\s*v\s*=\s*props\.min/.test(textInput) &&
      /v\s*>\s*props\.max\)\s*v\s*=\s*props\.max/.test(textInput)
  );
  chk(
    '★ 无法解析的中间态不写入垃圾（保留上一次合法值）',
    /Number\.isNaN\(n\)\s*\|\|\s*!Number\.isFinite\(n\)\)\s*return\s*props\.modelValue/.test(textInput)
  );

  /*
    设置页的 LLM 配置块（Base URL / 模型 / API Key / Temperature / Max Tokens）
    已按产品决定整块移除，所以原来那条"设置页能找到 Temperature 字段"变成了过时断言 ——
    它会把一个刻意的决定判成回归，这正是"断言与实现方向相反"的老毛病
    （verify-shell 里那条写死 24px 的断言也是同一类）。

    改成反向钉住：这些字段**不该**再回到设置页，免得日后有人顺手加回去。
    只匹配模板里的 <FieldRow label=...>，不匹配整份文件 ——
    文件里还留着"为什么删掉这一块"的注释，按整份文件匹配会被注释误判。

    同时保留 TextInput 的 allowFloat 能力断言（上面那些）：别的浮点字段还要用，
    以及后端 clampNumber 的断言（下面那条）：AI 对话工具箱仍走主进程的 temperature。
  */
  chk(
    '★ 设置页不再暴露 Temperature 输入（LLM 块已按产品决定移除）',
    !/<FieldRow[^>]*label="Temperature"/.test(settings)
  );
  chk(
    '★ 设置页不再暴露 API Key / Max Tokens 输入',
    !/<FieldRow[^>]*label="(API Key|Max Tokens)"/.test(settings)
  );

  /* 后端本来就是对的，确认它没被误改 */
  const backend = read('src/main/services/settings.js');
  chk(
    '★ 主进程仍用保留小数的 clampNumber 处理 temperature',
    /merged\.llm\.temperature\s*=\s*clampNumber\(/.test(backend)
  );
}

/* ============================================ ② 分块加载失败要有可视化兜底 */
console.log('\n[hardening] ② 分块加载失败不再静默变砖');
{
  const recoverPath = path.join(ROOT, 'src/renderer/recover.js');
  chk('★ recover.js 存在', fs.existsSync(recoverPath));

  if (fs.existsSync(recoverPath)) {
    const mod = await import(new URL('file:///' + recoverPath.replace(/\\/g, '/')).href);

    /* 用真实的失败文案做判定测试（第一个就是实测日志里那条） */
    const realMessages = [
      'Failed to fetch dynamically imported module: file:///C:/app/dist/renderer/assets/LogsPanel-BQQBsKnm.js',
      'error loading dynamically imported module: /assets/TerminalPanel-rPznYFwt.js',
      'Importing a module script failed.',
      'Loading chunk 12 failed.',
      'Unable to preload CSS for /assets/index-abc.css'
    ];
    for (const m of realMessages) {
      chk(`★ 识别为分块加载失败: ${m.slice(0, 46)}…`, mod.isChunkLoadError(new Error(m)));
    }

    /* 不能把普通业务错误也当成分块失败，否则会乱弹"请重新载入" */
    const notChunk = [
      'Cannot read properties of undefined (reading id)',
      'NetworkError when attempting to fetch resource.',
      'Request failed with status code 403'
    ];
    for (const m of notChunk) {
      chk(`  不误判普通错误: ${m.slice(0, 40)}…`, !mod.isChunkLoadError(new Error(m)));
    }
    chk('  容错：null / 字符串 / 空值都不抛异常', mod.isChunkLoadError(null) === false);

    const body = fs.readFileSync(recoverPath, 'utf8');
    chk('★ 监听 vite:preloadError（比 router.onError 更早）', /vite:preloadError/.test(body));
    chk('★ 提供了"重新载入"按钮而不是只弹一句提示', /location\.reload\(\)/.test(body));
    chk('★ 兜底 UI 用原生 DOM（不依赖它要拯救的组件树）', /document\.createElement/.test(body));
  }

  const main = read('src/renderer/main.js');
  chk('★ 入口安装了兜底', /installChunkRecovery\(\)/.test(main));
  chk('★ 挂在 router.onError 上', /router\.onError\(/.test(main));
  chk(
    '★ 安装发生在 mount 之前（首屏分块失败也能兜住）',
    main.indexOf('installChunkRecovery()') < main.indexOf("app.mount('#app')")
  );
}

/* ============================================ ③ 桌面通知文案不能漏变量 */
console.log('\n[hardening] ③ 通知文案不再出现 undefined');
{
  const idx = read('src/main/services/index.js');
  const layout = read('src/renderer/components/AppLayout.vue');

  chk('★ 主进程读取 attempts（process.js 真正 emit 的字段名）', /p\.attempts/.test(idx));
  chk('★ 主进程不再直接读不存在的 p.attempt}', !/p\.attempt\}/.test(idx));
  chk('★ 优先使用主进程已备好的 message', /body:\s*p\.message\s*\|\|/.test(idx));
  chk('★ 渲染层也用 attempts', /p\?\.attempts/.test(layout));

  /* 与真正 emit 的地方对齐：字段名必须真的是 attempts */
  const proc = read('src/main/services/process.js');
  const m = proc.match(/bus\.emit\('service:restart-giveup',\s*\{([\s\S]*?)\}\)/);
  chk('★ process.js 的 restart-giveup 载荷含 attempts', Boolean(m) && /attempts:/.test(m[1]));
  if (m) {
    chk('  载荷里确实没有 attempt（只有 attempts）', !/\battempt:/.test(m[1]));
    chk(
      '  载荷里带 message（通知优先用它）',
      /message:/.test(m[1]),
      (m[1].match(/message:\s*`([^`]*)`/) || [])[1] || ''
    );
  }
}

/* ============================================ ④ 换页回到顶部 */
console.log('\n[hardening] ④ 换页后滚动位置归零');
{
  const layout = read('src/renderer/components/AppLayout.vue');
  chk('★ .body 上绑定了 ref', /<main\s+ref="bodyRef"/.test(layout) || /ref="bodyRef"/.test(layout));
  chk('★ 监听 route.fullPath（同路由换 query 也会重置）', /\(\)\s*=>\s*route\.fullPath/.test(layout));
  chk('★ 换页时把 scrollTop 归零', /scrollTop\s*=\s*0/.test(layout));
  chk(
    '★ 归零发生在 nextTick 里（否则会被旧页面高度算回去）',
    /nextTick\(\(\)\s*=>\s*\{[\s\S]{0,80}scrollTop\s*=\s*0/.test(layout)
  );
}

/* ============================================ ⑤ 告警托盘不能压住按钮 */
console.log('\n[hardening] ⑤ 告警托盘让出空间');
{
  const layout = read('src/renderer/components/AppLayout.vue');
  chk('★ 托盘上绑定了 ref', /ref="alertTrayRef"/.test(layout));
  chk('★ 用量出的托盘高度做下内边距', /paddingBottom[\s\S]{0,60}alertTrayH/.test(layout));
  chk('★ 用 ResizeObserver 跟高度变化（文案长短/条目增减都会变）', /new ResizeObserver/.test(layout));
  chk('★ 托盘消失后收掉占位', /alertTrayH\.value\s*=\s*0/.test(layout));
  chk('★ 卸载时断开 observer（否则泄漏）', /trayObserver\?\.disconnect\(\)/.test(layout));
  chk('★ 占位样式已绑到 .body 上', /:style="bodyStyle"/.test(layout));
}

/* ============================================ ⑥ 端口就绪不能认错人 */
console.log('\n[hardening] ⑥ 端口就绪要认自己的服务');
{
  const proc = read('src/main/services/process.js');

  chk('★ 有查端口归属 PID 的能力', /function findPortOwnerPid/.test(proc));
  chk('★ 解析 netstat -ano 输出', /netstat/.test(proc) && /LISTENING/i.test(proc));
  chk('★ 启动前记录端口占用基线', /portPreOccupiedBy/.test(proc));
  chk('★ 端口开着但"启动前就被占用"时不判定为就绪', /open\s*&&\s*record\.portPreOccupiedBy/.test(proc));
  chk('★ 正常情况（端口本来空闲）仍按端口就绪判定', /open\s*&&\s*!record\.portPreOccupiedBy/.test(proc));
  chk(
    '★ 占用时如实说明"无法据此判断就绪"而不是给假的就绪',
    /无法据此判断本服务是否就绪/.test(proc)
  );
  chk('★ 基线写进了 record，重启时也会重新测量', /portPreOccupiedBy,/.test(proc));

  /* 反向断言：不能存在"只看端口开着就算就绪"的老写法 */
  chk(
    '★ 已不存在无条件的 if (open) → 就绪 的老逻辑',
    !/const open = await probePort\(readyPort\);\s*\n\s*if \(open\) \{/.test(proc)
  );
}

/* ============================== ⑦ 模板里不能把函数当值渲染出来 */
console.log('\n[hardening] ⑦ 模板插值不能渲染出函数源码');
{
  /*
    真实事故：DownloadProgress.vue 里写了 {{ bytesText }}，而 bytesText 是个
    普通函数，于是界面上"已下/总"的位置显示的是一段 JS 源码
    （`function bytesText(){const got=...}`），数字永远不出现。

    为什么必须单独守着：
      eslint 不看模板语义，Vue 编译器也认为 {{ fn }} 合法，
      npm run build 照样成功，页面照样渲染 —— 没有报错、没有异常、
      日志干净。**只有把真实 DOM 读出来才会发现**。
      （这次就是在真机 CDP 里采样 .dp 的 innerText 才抓到的。）

    规则：{{ xxx }} 里如果是单个标识符，且它在 <script setup> 里是
    `function xxx(` 这种普通函数声明，而且不是 computed/ref/method 返回的，
    就是 bug。computed / ref / reactive 属性都能正常插值。
  */
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.vue')) files.push(rel);
    }
  };
  walk('src/renderer');

  const offenders = [];
  let scanned = 0;
  for (const rel of files) {
    const src = read(rel);
    const tplEnd = src.indexOf('</template>');
    if (tplEnd < 0) continue;
    const tpl = src.slice(0, tplEnd);
    const scriptIdx = src.indexOf('<script setup');
    if (scriptIdx < 0) continue;
    const script = src.slice(scriptIdx);
    scanned += 1;

    /* 普通函数声明 */
    const plainFns = new Set();
    for (const m of script.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      plainFns.add(m[1]);
    }
    /* const f = () => {} / const f = function(){} 也算普通函数 */
    for (const m of script.matchAll(/(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/g)) {
      plainFns.add(m[1]);
    }
    /* 被 computed / ref / reactive / toRef 包起来的**不是**普通函数 */
    for (const m of script.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:computed|ref|reactive|toRef|toRefs|shallowRef)\s*\(/g)) {
      plainFns.delete(m[1]);
    }

    /* 模板里 {{ name }} 形式的单标识符插值 */
    for (const m of tpl.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g)) {
      if (plainFns.has(m[1])) offenders.push(`${rel} → {{ ${m[1]} }}`);
    }
  }

  chk('★ 扫描到了渲染层组件', scanned > 10, `${scanned} 个 .vue 文件`);
  chk(
    '★ 没有任何模板把普通函数直接插值（会显示成 JS 源码）',
    offenders.length === 0,
    offenders.length ? offenders.join(' | ') : ''
  );
  /* 反向自检：造一个必然违规的样本，确认上面的规则真的能抓到 */
  {
    const bad = `<template><div>{{ fmt }}</div></template>\n<script setup>\nfunction fmt() { return 'x'; }\n</script>`;
    const tpl = bad.slice(0, bad.indexOf('</template>'));
    const script = bad.slice(bad.indexOf('<script setup'));
    const fns = new Set();
    for (const m of script.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) fns.add(m[1]);
    let caught = false;
    for (const m of tpl.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g)) if (fns.has(m[1])) caught = true;
    chk('★ 检测规则自检：能抓到 {{ 普通函数 }} 这种写法', caught);
  }
}

console.log(`\n[hardening] ${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}  通过=${pass} 失败=${fail}`);
process.exit(fail === 0 ? 0 : 1);
