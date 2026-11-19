'use strict';

// 冒煙測試開跑前：用 Vite 打包桌面版到 node_modules/.cache/smoke-bundle（不動版控裡的 dist/）。
// 打包設定與 npm run build 相同（vite.config.js 的 desktop 目標），只換輸出資料夾。

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_DIR = path.join(ROOT, 'node_modules', '.cache', 'smoke-bundle');

module.exports = async () => {
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--mode', 'desktop', '--outDir', BUNDLE_DIR, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`冒煙測試打包失敗：\n${r.stdout}\n${r.stderr}`);
};

module.exports.BUNDLE_DIR = BUNDLE_DIR;
