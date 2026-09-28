/*
================================================================================
技术文档：scripts/clean.mjs
职责：清理全部构建产物与临时目录（不动 node_modules）。
用法：npm run clean
================================================================================
*/
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['dist', 'release'];

let removed = 0;
for (const name of TARGETS) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) continue;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[clean] 已删除 ${name}/`);
    removed += 1;
  } catch (e) {
    console.warn(`[clean] 删除 ${name}/ 失败（可能被运行中的程序占用）: ${e.message}`);
  }
}
if (!removed) console.log('[clean] 没有需要清理的产物');
