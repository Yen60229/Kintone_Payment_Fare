'use strict';

// 測試：print.show顯示單據編號_請款單據編號.js
//   列印頁隱藏：簽核流程群組、手動設定簽核流程、權限開放人員、帶入的資料_開發人員用，以及空白與標籤欄位；
//   一般畫面（新增、編輯、詳細）不隱藏交通費請款單號；不再有寫死的 DOM 選擇器或類型判斷。
// 單獨執行：node tests/print_show.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const fileName = 'print.show顯示單據編號_請款單據編號.js';
const src = fs.readFileSync(path.join(rootDir, fileName), 'utf8');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
const shown = {};
const queried = [];
const hiddenEls = [{ style: {} }, { style: {} }];

global.window = {};
global.document = {
  querySelectorAll: (selector) => {
    queried.push(selector);
    return hiddenEls;
  },
};
global.kintone = {
  app: { getId: () => 749, record: { setFieldShown: (code, v) => (shown[code] = v) } },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(src);

const F = global.window.PR_CONFIG.FIELDS;
const P = global.window.PR_PRINT_SHOW;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('print_show.test.cjs');

check('隱藏清單：簽核流程群組、手動設定簽核流程、權限開放人員、帶入的資料_開發人員用', () => {
  assert.deepStrictEqual([...P.PRINT_HIDDEN_FIELDS], [F.SIGN_FLOW_GROUP, F.MANUAL_FLOW, F.PERMISSION_STAFF, F.DEV_ONLY_DATA]);
  assert.deepStrictEqual([...P.PRINT_HIDDEN_FIELDS], ['簽核流程', '手動設定簽核流程', '權限開放人員', '帶入的資料_開發人員用']);
});

check('只註冊 print.show 一個事件', () => {
  assert.strictEqual(registered.length, 1);
  assert.deepStrictEqual([...registered[0].types], ['app.record.print.show']);
});

check('列印時四個欄位／群組都被隱藏（setFieldShown false）', () => {
  const event = { type: 'app.record.print.show', record: {} };
  assert.strictEqual(registered[0].handler(event), event);
  P.PRINT_HIDDEN_FIELDS.forEach((code) => assert.strictEqual(shown[code], false, code));
});

check('列印時不碰交通費請款單號（它本來就要印在單據上）', () => {
  assert.ok(!(F.RECORD_NO in shown));
});

check('列印時隱藏空白間隔與標籤欄位（保留 user-js-Expense_Table）', () => {
  assert.strictEqual(queried.length, 1);
  assert.strictEqual(queried[0], P.HIDE_SELECTOR);
  assert.ok(queried[0].includes('.spacer-cybozu:not(#user-js-Expense_Table)'));
  assert.ok(queried[0].includes('.control-label-field-gaia'));
  hiddenEls.forEach((el) => assert.strictEqual(el.style.display, 'none'));
});

check('原始碼沒有類型、分攤群組、借支明細、寫死的 field-ID 選擇器', () => {
  ['F.TYPE', 'ALLOC_GROUP', 'ADVANCE_DETAIL_TABLE', 'SOURCE_NO', 'EXPENSE_FILL_MODE', 'field-8253249', 'field-13315538', 'labelEl', '請購單據編號'].forEach((s) =>
    assert.ok(!src.includes(s), s),
  );
});

check('原始碼沒有在新增、編輯、詳細頁隱藏交通費請款單號', () => {
  ['create.show', 'edit.show', 'detail.show'].forEach((s) => assert.ok(!src.includes(s), s));
});

console.log(`${passed} assertions passed.`);
