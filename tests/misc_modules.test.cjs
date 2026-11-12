'use strict';

// 測試：作廢防呆_20260506.js 與其餘小模組的清理結果
//   ① 作廢防呆的動作名稱接 C.ACTIONS.VOID：作廢動作要二次確認、其他動作直接放行
//   ② 自動寬度欄位＝付款方式、申請人、申請人部門、費用所屬人、費用所屬人部門；左移（leftShift）整段刪除
//   ③ 其餘小模組沒有 723 其他類型的殘留
// 單獨執行：node tests/misc_modules.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
const prompts = [];
global.window = {
  prompt: (msg) => {
    prompts.push(msg);
    return window.__promptAnswer;
  },
};
global.kintone = {
  app: { getId: () => 749, record: {} },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types: [].concat(types), handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('作廢防呆_20260506.js'));

const C = global.window.PR_CONFIG;
const F = C.FIELDS;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('misc_modules.test.cjs');

// ── 作廢防呆 ───────────────────────────────────────────────────────────────

const voidHandler = registered.find((r) => r.types.includes('app.record.detail.process.proceed')).handler;
const proceedEvent = (action, nextStatus) => ({ action: { value: action }, nextStatus: { value: nextStatus }, status: { value: '草稿（未送出）' }, record: { $id: { value: '15' } } });

check('作廢防呆：動作名稱取自 C.ACTIONS.VOID（原始碼不再寫死 \'作廢\' 當動作名稱）', () => {
  const src = readSrc('作廢防呆_20260506.js');
  assert.ok(src.includes('ACTION_NAME: window.PR_CONFIG.ACTIONS.VOID'));
  assert.ok(!/ACTION_NAME:\s*'作廢'/.test(src));
  assert.strictEqual(C.ACTIONS.VOID, '作廢');
});

check('作廢防呆：非作廢動作直接放行、不跳確認', () => {
  prompts.length = 0;
  const event = proceedEvent(C.ACTIONS.APPLY_START, C.STATUS.APPLY_START);
  assert.strictEqual(voidHandler(event), event);
  assert.strictEqual(prompts.length, 0);
});

check('作廢防呆：作廢動作要輸入「作廢」確認（沒有 Swal 時退回 prompt）；輸入對才放行', () => {
  prompts.length = 0;
  const event = proceedEvent(C.ACTIONS.VOID, C.STATUS.VOID);
  global.window.__promptAnswer = '作廢';
  assert.strictEqual(voidHandler(event), event);
  assert.strictEqual(prompts.length, 1);
  assert.ok(prompts[0].includes('記錄號碼：15'));
  global.window.__promptAnswer = '亂打';
  assert.strictEqual(voidHandler(event), false);
});

check('作廢防呆：只看下一狀態是作廢也算作廢動作', () => {
  prompts.length = 0;
  global.window.__promptAnswer = '';
  assert.strictEqual(voidHandler(proceedEvent('別的動作名', C.STATUS.VOID)), false);
  assert.strictEqual(prompts.length, 1);
});

// ── 其餘小模組 ─────────────────────────────────────────────────────────────

check('其餘小模組沒有 723 其他類型的殘留（類型、回寫來源單、交際費簽核判定、docs 連結）', () => {
  [
    'coding_tools.js',
    'file_reader.js',
    '存檔等待提示_20260923.js',
    '作廢防呆_20260506.js',
    '請款單作廢_style_20260506.js',
    '轉至其他會計單位按鈕處理_20250723.js',
    '開發人員用群組欄位.js',
    '流程自動推進_20260810.js',
  ].forEach((name) => {
    const src = readSrc(name);
    ['F.TYPE', 'EMPLOYEE_NAME', '回寫來源單', '交際費簽核判定', '簽核判定', 'docs/1', 'ENT_SIGN'].forEach((s) => assert.ok(!src.includes(s), `${name}: ${s}`));
  });
});

console.log(`${passed} assertions passed.`);
