'use strict';

// 打包 plug-in：npm run pack（在 plugins/invoice-registry 底下）
//   第一次沒有 private.ppk → 產生新的私鑰（決定 plug-in ID），存成 private.ppk；之後一律用它打包，ID 才不會變。
//   private.ppk 不進 git，請另外備份；弄丟只能當成新的 plug-in 重裝、重新設定。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const ppk = path.join(root, 'private.ppk');
const outDir = path.join(root, 'dist');
const out = path.join(outDir, 'invoice-registry-plugin.zip');
// 直接用 node 跑 packer 的 CLI（路徑有空白，不經過 shell）
const cli = path.join(root, 'node_modules', '@kintone', 'plugin-packer', 'bin', 'cli.js');

fs.mkdirSync(outDir, { recursive: true });
const args = ['--out', out];
const firstTime = !fs.existsSync(ppk);
if (!firstTime) args.push('--ppk', ppk);
args.push(path.join(root, 'src'));

const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

if (firstTime) {
  const made = fs.readdirSync(outDir).find((f) => f.endsWith('.ppk'));
  if (!made) {
    console.error('找不到產生的私鑰（.ppk）');
    process.exit(1);
  }
  fs.renameSync(path.join(outDir, made), ppk);
  console.log(`\n已產生私鑰 private.ppk（plug-in ID：${made.replace(/\.ppk$/, '')}）→ 請另外備份這個檔`);
}
console.log(`\n打包完成：${path.relative(process.cwd(), out)}`);
