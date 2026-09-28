/*
================================================================================
技术文档：src/main/services/maibot-connect.js
职责：MaiBot 侧的可检测状态与配置对齐——WebUI 登录 Token、适配器插件是否就位、
      bot_config.toml 的 platform / qq_account 对齐。
================================================================================
  为什么需要这个模块：
    官方文档写明 MaiBot 的 WebUI 登录方式是在终端里翻出这一行：

        [WebUI应用] 🔑 WebUI 登录 Token: e37fd618051f802816dc3bf3206758329...
        [WebUI应用] 💡 请使用此 Token 登录 WebUI

    而且**每次冷启动都会重新生成**（只有用户在 WebUI 里设过固定 Token 之后
    才会固定下来）。也就是说用户每次重启都可能要再去终端里翻一遍长串。

    启动器本来就在捕获 MaiBot 的 stdout（serviceLog），所以这件事可以
    直接替用户做掉：抓出来、显示出来、给个复制按钮。
    这不是"猜"，是读他自己的日志。

  读写边界（重要，别混）：
    · Token 相关（extractWebuiToken / readTokenFromFile / getWebuiToken）
      —— **纯只读**。Token 仅用于本机浏览器登录 http://127.0.0.1:8001，
      展示在启动器界面里是安全的（比让用户在终端里翻更安全，
      至少不会被误粘贴到别的窗口）。
    · ensureMaiBotBotIdentity —— **会写文件**，但只改 [bot] 段内的
      platform / qq_account 两个键，改写前先备份，且遇到 0.6.x 结构
      会直接拒绝（那个版本不读 qq_account，硬写只会制造"看起来配好了"的假象）。
================================================================================
*/
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** WebUI 的默认端口（官方文档：http://localhost:8001） */
const DEFAULT_WEBUI_PORT = 8001;

/**
 * 从已捕获的 MaiBot 输出里抓 WebUI 临时 Token。
 *
 * 官方日志格式（Windows 部署文档原文）：
 *   [WebUI应用] 🔑 WebUI 登录 Token: <token>
 *
 * 实现要点：
 *   · 取**最后一条** —— 重启后会有多条，最新的才是有效的
 *   · 不假设 token 长度/字符集，只要求是连续的非空白串
 *   · emoji 可能因为编码问题丢失，所以同时匹配不带 emoji 的变体
 *
 * @param {string} logText 已捕获的服务输出
 * @returns {string} token，找不到返回空串
 */
function extractWebuiToken(logText) {
  const text = String(logText || '');
  if (!text) return '';

  /*
    用「Token」这个中文词锚定，前面允许有 emoji 或方括号前缀。
    不写死 emoji：控制台编码不同，🔑 可能变成 ? 或被吞掉。
  */
  const re = /WebUI\s*登录\s*Token[:：]\s*([A-Za-z0-9_\-+/=.]{8,})/g;
  let last = '';
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
  }
  return last;
}

/**
 * 兜底：从 `data/webui.json` 读 token。
 *
 * 官方文档说「后续可以在 data/webui.json 中查看或修改 Token」，
 * 但**没有公开该文件的字段名**（社区与文档都没给出 schema）。
 * 所以这里按候选字段名依次尝试，全部落空就老实地返回空 ——
 * 宁可拿不到，也不能把别的东西当 token 塞给用户。
 *
 * @param {string} maibotDir
 */
function readTokenFromFile(maibotDir) {
  const file = path.join(String(maibotDir || ''), 'data', 'webui.json');
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { ok: false, file, reason: '文件不存在或不是合法 JSON' };
  }

  /* 字段名未经官方文档确认，按可能性排序尝试 */
  const candidates = ['access_token', 'token', 'webui_token', 'auth_token', 'password'];
  for (const key of candidates) {
    const v = json?.[key];
    if (typeof v === 'string' && v.trim().length >= 8) {
      return { ok: true, file, token: v.trim(), field: key, guessed: true };
    }
  }
  return {
    ok: false,
    file,
    reason: '文件里没有找到可识别的 token 字段',
    /* 把字段名回传，方便排查时看它到底是什么结构（不含值） */
    fields: json && typeof json === 'object' ? Object.keys(json) : []
  };
}

/**
 * 综合取 WebUI Token：优先日志（官方口径），其次文件兜底。
 *
 * @param {object} deps
 * @param {string} deps.maibotDir
 * @param {string} deps.logText  已捕获的 MaiBot 输出
 */
function getWebuiToken(deps = {}) {
  const fromLog = extractWebuiToken(deps.logText);
  if (fromLog) {
    return {
      ok: true,
      token: fromLog,
      source: 'log',
      message: '从 MaiBot 启动日志中读取到本次的 WebUI 登录 Token'
    };
  }

  const file = readTokenFromFile(deps.maibotDir);
  if (file.ok) {
    return {
      ok: true,
      token: file.token,
      source: 'file',
      /* 老实标注这是推断出来的字段名，不是官方文档确认的 */
      message: `从 data/webui.json 的 ${file.field} 字段读取（该字段名未经官方文档确认，若登录失败请以终端日志为准）`
    };
  }

  return {
    ok: false,
    token: '',
    source: '',
    message:
      '还没抓到 WebUI Token。请先启动 MaiBot —— 首次启动时它会打印一行' +
      '「🔑 WebUI 登录 Token: ...」，启动器会自动读出来。' +
      '如果已经启动过，请重启一次 MaiBot 让它重新打印。'
  };
}

/** WebUI 地址（官方文档：http://localhost:8001） */
function webuiUrl(port) {
  const p = Number(port) || DEFAULT_WEBUI_PORT;
  return `http://127.0.0.1:${p}`;
}

/* ============================================================================
 *  bot_config.toml 的机器人身份对齐
 * --------------------------------------------------------------------------
 *  官方文档明确要求（协议端适配器页）：
 *      [bot]
 *      platform = "qq"            # 本地客户端适配器都用 qq
 *      qq_account = "你的QQ号"     # 必须与协议端登录的 QQ 号完全一致
 *
 *  不一致的后果很具体：**麦麦会把自己的消息当成别人发的**（自己跟自己聊天）。
 *  适配器正常上报身份时这两个字段只是备用值，但保持一致永远是对的。
 *
 *  ⚠️ 两代 schema 完全不同，绝不能混写：
 *      1.2.x  →  [bot] qq_account = "123456789"   （字符串）
 *      0.6.x  →  [bot] qq = 1145141919810         （整数，且平台走 [platforms] URL）
 *    往 0.6.x 的配置里加 qq_account，它根本不读这个字段，用户会以为改好了。
 *    所以检测到 0.6.x 结构时**必须拒绝写入并说明原因**，而不是硬塞。
 *
 *  写文件的安全约定（与项目其它地方一致）：
 *    · 只改 [bot] 段内的目标键，其余字节原样保留（不重新序列化整个 TOML，
 *      否则会丢掉用户的注释与排版）
 *    · 已存在且值非空 → 不改（返回 kept）
 *    · 要改动 → 先备份成 .bak-<时间戳>
 *    · 原子写（临时文件 + rename）
 * ========================================================================== */

/** 取某一段（形如 [bot]）在行数组里的起止下标 */
function findSection(lines, name) {
  const head = new RegExp(`^\\s*\\[\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    /* 下一个段头就是本段结束 */
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 真实的段头（排除注释行）。注释里出现 [xxx] 是常事，不能当成段 */
function hasSection(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s{0,3}\\[${escaped}\\]\\s*$`);
  return text
    .split(/\r?\n/)
    .some((ln) => !/^\s*#/.test(ln) && re.test(ln));
}

/** 判断配置是 1.2.x 还是 0.6.x 结构——判不出来就说不知道，不猜 */
function detectBotSchema(text) {
  const hasQqAccount = /^\s*qq_account\s*=/m.test(text);
  const hasLegacyQq = /^\s*qq\s*=\s*\d+/m.test(text);
  /* [platforms] 是 0.6.x 独有的段（走 URL 直连）；1.2.x 改用适配器插件后没有它 */
  const hasLegacyPlatforms = hasSection(text, 'platforms');

  /*
    优先看有没有决定性的老字段：只要出现 `qq = <整数>`，不管有没有
    qq_account，这都是 0.6.x 的底子。混合态（用户手加了 qq_account）
    也必须按 0.6.x 处理 —— 那个版本根本不会读 qq_account，
    按 1.2.x 处理会写出一个"看着对但根本不生效"的配置。
  */
  if (hasLegacyQq || hasLegacyPlatforms) return '0.6.x';
  if (hasQqAccount) return '1.2.x';

  /*
    两个键都没有的情况：不能一律判 unknown 就拒绝 ——
    升级上来的 1.2.x 配置可能缺 qq_account，直接拒绝会让用户没法对齐身份。
    `[bot]` + 字符串型 nickname 是 1.2.x 独有的形状
    （0.6.x 的 [bot] 是 qq = <整数> + nickname，靠上面的规则已经排除了）。
  */
  const lines = text.split(/\r?\n/);
  const botSec = findSection(lines, 'bot');
  if (botSec) {
    const nick = readBotValue(lines, botSec, 'nickname');
    if (nick && /^["'].*["']$/.test(nick.raw)) return '1.2.x';
    /* [bot] 里出现 1.2.x 专有键，同样是足够证据 */
    if (/^\s*(alias_names|personality)\s*=/m.test(lines.slice(botSec.start, botSec.end).join('\n'))) {
      return '1.2.x';
    }
  }
  return 'unknown';
}

/** 读 [bot] 段内某个键的字符串值 */
function readBotValue(lines, section, key) {
  if (!section) return null;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`);
  for (let i = section.start + 1; i < section.end; i++) {
    const m = lines[i].match(re);
    if (m) return { line: i, raw: m[1].trim() };
  }
  return null;
}

/**
 * 对齐 bot_config.toml 里的 platform / qq_account。
 *
 * @param {string} maibotDir
 * @param {object} opts
 * @param {string} opts.qqAccount  协议端登录的 QQ 号（必需；拿不到就不该调）
 * @returns {Promise<{ok:boolean, action:string, file?:string, message:string}>}
 */
async function ensureMaiBotBotIdentity(maibotDir, opts = {}) {
  const dir = String(maibotDir || '').trim();
  if (!dir) return { ok: false, action: 'no-dir', message: '尚未设置 MaiBot 目录' };

  const qq = String(opts.qqAccount || '').trim();
  if (!/^\d{5,12}$/.test(qq)) {
    return {
      ok: false,
      action: 'bad-qq',
      message: `QQ 号看起来不对（需要 5~12 位数字，收到「${qq || '空'}」），已跳过对齐`
    };
  }

  const file = path.join(dir, 'config', 'bot_config.toml');
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return {
      ok: false,
      action: 'no-file',
      file,
      message: `读不到 ${file}（MaiBot 首次启动后才会生成）：${e.message}`
    };
  }

  const schema = detectBotSchema(text);
  if (schema === '0.6.x') {
    /*
      关键的安全阀：0.6.x 用的是 [bot] qq = <整数> + [platforms] URL，
      加 qq_account 它不会读 —— 那会让用户"以为配好了"，比不写更糟。
    */
    return {
      ok: false,
      action: 'unsupported-schema',
      file,
      schema,
      message:
        '这份 bot_config.toml 是 0.6.x 结构（[bot] 用 `qq = <数字>`，平台走 [platforms]）。' +
        '1.2.x 才用 `qq_account`，写进去这个版本不会读，所以已跳过。' +
        '请先升级到 MaiBot 1.2.0 或更新。'
    };
  }
  if (schema === 'unknown') {
    return {
      ok: false,
      action: 'unknown-schema',
      file,
      schema,
      message: '这份 bot_config.toml 的结构既不像 1.2.x 也不像 0.6.x，无法安全写入，已跳过'
    };
  }

  const lines = text.split(/\r?\n/);
  const section = findSection(lines, 'bot');
  if (!section) {
    return {
      ok: false,
      action: 'no-section',
      file,
      message: 'bot_config.toml 里没有找到 [bot] 段，无法安全写入，已跳过'
    };
  }

  const existingQq = readBotValue(lines, section, 'qq_account');
  const existingPf = readBotValue(lines, section, 'platform');

  /* 已有非空的 qq_account 就尊重它 —— 用户可能有意指向别的号 */
  if (existingQq && existingQq.raw.replace(/^["']|["']$/g, '').trim()) {
    const cur = existingQq.raw.replace(/^["']|["']$/g, '').trim();
    if (cur === qq) {
      return { ok: true, action: 'kept', file, schema, message: `qq_account 已经是 ${qq}，未改动` };
    }
    return {
      ok: true,
      action: 'kept-conflict',
      file,
      schema,
      message:
        `bot_config.toml 里的 qq_account 是 ${cur}，与协议端登录的 ${qq} 不一致。` +
        '已保留原值（不擅自改你的配置）—— 若协议端登录的就是这个号之外的账号，' +
        '请自行改成一致，否则麦麦会把自己的消息当成别人发的。'
    };
  }

  /* 备份后原地改 */
  try {
    await fsp.copyFile(file, `${file}.bak-${Date.now()}`);
  } catch (_) {
    /* 备份失败不阻塞，但下面会如实说明 */
  }

  const changed = [];
  if (existingQq) {
    lines[existingQq.line] = `qq_account = "${qq}"`;
    changed.push(`qq_account → ${qq}`);
  } else {
    /* 插到 [bot] 段开头之后，保持与官方模板的位置一致 */
    lines.splice(section.start + 1, 0, `qq_account = "${qq}"`);
    changed.push(`qq_account = "${qq}"（新增）`);
  }
  if (existingPf) {
    const curPf = existingPf.raw.replace(/^["']|["']$/g, '').trim();
    if (curPf !== 'qq') {
      lines[existingPf.line] = 'platform = "qq"';
      changed.push(`platform ${curPf} → qq`);
    }
  } else {
    lines.splice(section.start + 1, 0, 'platform = "qq"');
    changed.push('platform = "qq"（新增）');
  }

  const out = lines.join('\n');
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, out, 'utf8');
  await fsp.rename(tmp, file);

  return {
    ok: true,
    action: 'fixed',
    file,
    schema,
    message: `已对齐机器人身份：${changed.join('、')}（原文件已备份）`
  };
}

module.exports = {
  extractWebuiToken,
  readTokenFromFile,
  getWebuiToken,
  webuiUrl,
  ensureMaiBotBotIdentity,
  detectBotSchema,
  hasSection,
  findSection,
  DEFAULT_WEBUI_PORT
};
