// 统一清理：调试脚本/日志/截图 + data/uploads + DB 重置
// 用法：node scripts/cleanup.js [--keep-seed]
//   --keep-seed 保留 20 条种子数据（默认清空后重播 seed）
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/i, '$1'), '..');
const keepSeed = process.argv.includes('--keep-seed');

// 1) 删除调试脚本/日志/截图
const debugFiles = [
  'debug2.js', 'debug3.js', 'debug4.js', 'debug5.js', 'debug6.js', 'debug7.js', 'debug8.js',
  'debug-step3.js', 'cleanup-test.js', 'reset-seed.js', 'check-embed.js',
  'vs_install.log', 'vs_install2.log', 'desktop1.png', 'desktop2.png',
  'msvc_install.log', 'msvc_install2.log', 'install-msvc.js',
];
let removed = 0;
for (const f of debugFiles) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) { fs.rmSync(p); removed++; console.log('rm', f); }
}
for (const f of fs.readdirSync(root)) {
  if (/^debug.*\.js$/.test(f) || /^vs_install.*\.log$/.test(f) || /^desktop.*\.png$/.test(f) || /^msvc_install.*\.log$/.test(f)) {
    if (!debugFiles.includes(f)) { fs.rmSync(path.join(root, f)); removed++; console.log('rm', f); }
  }
}
console.log(`调试文件清理: ${removed} 个`);

// 2) 清空 data/uploads
const upDir = path.join(root, 'data', 'uploads');
if (fs.existsSync(upDir)) {
  const n = fs.readdirSync(upDir).length;
  for (const f of fs.readdirSync(upDir)) fs.rmSync(path.join(upDir, f), { recursive: true, force: true });
  console.log(`uploads 清空: ${n} 个文件`);
}

// 3) DB 重置（除非 --keep-seed）
if (!keepSeed) {
  console.log('重置 DB...');
  execSync(`node ${path.join(root, 'scripts', 'seed.js')}`, { cwd: root, stdio: 'inherit' });
} else {
  console.log('--keep-seed: 跳过 DB 重置');
}
console.log('CLEANUP DONE');
