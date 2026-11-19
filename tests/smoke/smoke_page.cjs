'use strict';

// 冒煙測試共用：開一個假的 kintone 新增畫面，載入打包好的桌面版 bundle 與 payment_request.css。
// 網址 http://smoke.test/ 只存在 Playwright 的 page.route 裡（不開任何伺服器、不連外）。

const fs = require('fs');
const path = require('path');
const { installFakeKintone } = require('./fake_kintone.cjs');
const { BUNDLE_DIR } = require('./global_setup.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const ORIGIN = 'http://smoke.test';
const APP_ID = 749;
const LOGIN_USER = { id: '1', code: '24136', name: '冒煙測試' };

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>smoke</title>
<link rel="stylesheet" href="/payment_request.css"></head>
<body><div id="smoke-header-menu"></div><div id="smoke-record"></div>
<script src="/payment_request_desktop.js"></script></body></html>`;

/**
 * 開頁面並載入 bundle。kintone.api 的假資料在載入後用 page.evaluate 寫進 __smoke.db（見 fake_kintone.cjs）。
 * @returns {Promise<string[]>} 頁面上的 console.error／pageerror（呼叫端自己決定要不要斷言）
 */
const openSmokePage = async (page) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
    if (url.pathname === '/payment_request_desktop.js') {
      return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(BUNDLE_DIR, 'payment_request_desktop.js')) });
    }
    if (url.pathname === '/payment_request.css') {
      return route.fulfill({ contentType: 'text/css; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'payment_request.css')) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(installFakeKintone, { appId: APP_ID, loginUser: LOGIN_USER });
  await page.goto(`${ORIGIN}/`);
  return pageErrors;
};

module.exports = { openSmokePage, APP_ID, LOGIN_USER };
