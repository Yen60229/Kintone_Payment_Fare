'use strict';

// 測試：發票號碼寫入獨立欄位檢查.js
//   只彙整交通費子表格的發票號碼：去空白、去空值、去重、頭尾加分隔字元。
// 單獨執行：node tests/invoice_agg.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
global.window = {};
global.kintone = {
  app: { getId: () => 749, record: {} },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('發票號碼寫入獨立欄位檢查.js'));

const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const { buildInvoiceAgg } = global.window.PR_INVOICE_AGG;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('invoice_agg.test.cjs');

const row = (invoice) => ({ value: { [T.COLS.INVOICE_NO]: { value: invoice } } });
const recordOf = (...invoices) => ({ [T.CODE]: { value: invoices.map(row) }, [F.INVOICE_AGG]: { value: '' } });

check('分隔字元取自設定檔，頭尾都加', () => {
  assert.strictEqual(C.SEP, ' / ');
  assert.strictEqual(buildInvoiceAgg(recordOf('AB12345678')), ' / AB12345678 / ');
});

check('多筆用分隔字元串接、保留順序', () => {
  assert.strictEqual(buildInvoiceAgg(recordOf('AB12345678', 'CD87654321')), ' / AB12345678 / CD87654321 / ');
});

check('重複的發票號碼只留一個', () => {
  assert.strictEqual(buildInvoiceAgg(recordOf('AB12345678', 'CD87654321', 'AB12345678')), ' / AB12345678 / CD87654321 / ');
});

check('前後空白會被去掉再比對去重', () => {
  assert.strictEqual(buildInvoiceAgg(recordOf('  AB12345678 ', 'AB12345678')), ' / AB12345678 / ');
});

check('空白、未填的列略過', () => {
  assert.strictEqual(buildInvoiceAgg(recordOf('', '   ', 'AB12345678', undefined)), ' / AB12345678 / ');
});

check('全部沒填 → 空字串（不是只剩分隔字元）', () => {
  assert.strictEqual(buildInvoiceAgg(recordOf('', '')), '');
  assert.strictEqual(buildInvoiceAgg(recordOf()), '');
});

check('沒有子表格欄位也不會出錯', () => {
  assert.strictEqual(buildInvoiceAgg({}), '');
});

check('只看交通費子表格：別的子表格即使有同名欄位也不納入', () => {
  const record = recordOf('AB12345678');
  record['其他子表格'] = { value: [row('ZZ99999999')] };
  assert.strictEqual(buildInvoiceAgg(record), ' / AB12345678 / ');
});

check('事件：只聽交通費子表格與其發票號碼欄位的 change（新增、編輯各一）', () => {
  assert.strictEqual(registered.length, 1);
  assert.deepStrictEqual(
    [...registered[0].types].sort(),
    [
      `app.record.create.change.${T.CODE}`,
      `app.record.create.change.${T.COLS.INVOICE_NO}`,
      `app.record.edit.change.${T.CODE}`,
      `app.record.edit.change.${T.COLS.INVOICE_NO}`,
    ].sort(),
  );
});

check('事件處理：把彙整結果寫進「發票號碼記錄」', () => {
  const event = { record: recordOf('AB12345678', 'CD87654321') };
  const result = registered[0].handler(event);
  assert.strictEqual(result, event);
  assert.strictEqual(event.record[F.INVOICE_AGG].value, ' / AB12345678 / CD87654321 / ');
});

console.log(`${passed} assertions passed.`);
