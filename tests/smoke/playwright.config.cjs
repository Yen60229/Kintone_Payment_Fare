'use strict';

// Playwright 冒煙測試設定：npm run smoke
//   開跑前 global_setup 打包桌面版 → 每支測試開一個假的 kintone 頁面載入 bundle（不連真的 kintone）。
const path = require('path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.spec.cjs',
  globalSetup: require.resolve('./global_setup.cjs'),
  outputDir: path.join(__dirname, '..', '..', 'node_modules', '.cache', 'smoke-results'),
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
});
