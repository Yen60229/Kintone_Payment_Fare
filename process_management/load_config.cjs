'use strict';

// 載入共用設定檔 payment_request_config.js（它是給 kintone 瀏覽器用的 IIFE，掛在 window.PR_CONFIG）。
// 用 vm 在替身環境裡執行：kintone.app.getId() 回傳 749（交通費請款單測試區），取出 PR_CONFIG。
// 給流程管理檢查工具（process_management/check_process.cjs、tests/lib/process_*.cjs）和它們的測試用。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONFIG_FILE = path.join(__dirname, '..', 'payment_request_config.js');
const APP_ID = 749;

/** 讀設定檔，回傳 window.PR_CONFIG */
const loadConfig = () => {
  const sandbox = {
    kintone: {
      app: { getId: () => APP_ID },
      getLoginUser: () => ({ code: '24136' }),
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(CONFIG_FILE, 'utf8'), sandbox, { filename: CONFIG_FILE });
  return sandbox.window.PR_CONFIG;
};

module.exports = { loadConfig, CONFIG_FILE, APP_ID };
