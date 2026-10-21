'use strict';

// 測試：批次整理資料.js —— SAP 轉檔語法解析
//   {{欄位}}、{{子表格.欄位}}（取第一列）、{{TODAY}}／{{TODAY:格式}}、{{$id}}；沒有 {{ }} 的原文照用；已無分攤表相關程式。
// 單獨執行：node tests/batch_organize.test.cjs

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
eval(readSrc('批次整理資料.js'));

const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const { parseValue, resolveFieldValue, formatDate } = global.window.PR_BATCH_ORGANIZE;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('batch_organize.test.cjs');

const record = {
  $id: { value: '88' },
  [F.PAYEE]: { value: '24136 王小明' },
  [F.PAYMENT_DATE]: { value: '2026-10-05' },
  [F.PAY_METHOD]: { value: ['現金', '電匯'] },
  [F.REASON]: { value: '' },
  [T.CODE]: {
    value: [
      { value: { [T.COLS.EXPENSE]: { value: 'AJ63' }, [T.COLS.AMOUNT]: { value: '120' } } },
      { value: { [T.COLS.EXPENSE]: { value: 'XXXX' }, [T.COLS.AMOUNT]: { value: '999' } } },
    ],
  },
};

check('一般欄位：{{受款人}} 取欄位值', () => {
  assert.strictEqual(parseValue(`{{${F.PAYEE}}}`, record), '24136 王小明');
});

check('日期欄位轉成 YYYY/MM/DD', () => {
  assert.strictEqual(parseValue(`{{${F.PAYMENT_DATE}}}`, record), '2026/10/05');
});

check('陣列欄位（核取方塊）用逗號串接', () => {
  assert.strictEqual(parseValue(`{{${F.PAY_METHOD}}}`, record), '現金,電匯');
});

check('空欄位、不存在的欄位 → 空字串', () => {
  assert.strictEqual(parseValue(`{{${F.REASON}}}`, record), '');
  assert.strictEqual(parseValue('{{不存在的欄位}}', record), '');
});

check('子表格語法 {{表格.欄位}} 取第一列', () => {
  assert.strictEqual(parseValue(`{{${T.CODE}.${T.COLS.EXPENSE}}}`, record), 'AJ63');
  assert.strictEqual(parseValue(`{{${T.CODE}.${T.COLS.AMOUNT}}}`, record), '120');
});

check('子表格空列或不存在 → 空字串', () => {
  assert.strictEqual(parseValue(`{{${T.CODE}.${T.COLS.EXPENSE}}}`, { [T.CODE]: { value: [] } }), '');
  assert.strictEqual(parseValue('{{沒有的表.欄位}}', record), '');
});

check('{{$id}} 取記錄 ID', () => {
  assert.strictEqual(parseValue('{{$id}}', record), '88');
});

check('{{TODAY}} 預設 YYYY/MM/DD；{{TODAY:YYYYMMDD}} 照格式', () => {
  assert.match(parseValue('{{TODAY}}', record), /^\d{4}\/\d{2}\/\d{2}$/);
  assert.match(parseValue('{{TODAY:YYYYMMDD}}', record), /^\d{8}$/);
  assert.match(parseValue('{{TODAY:YYYY-MM-DD}}', record), /^\d{4}-\d{2}-\d{2}$/);
});

check('沒有 {{ }} 的文字原樣輸出；空白語法 → 空字串', () => {
  assert.strictEqual(parseValue('固定值100', record), '固定值100');
  assert.strictEqual(parseValue('', record), '');
  assert.strictEqual(parseValue('   ', record), '');
  assert.strictEqual(parseValue(undefined, record), '');
});

check('混合語法：多個 {{ }} 與固定文字併用', () => {
  assert.strictEqual(parseValue(`NX-{{$id}}-{{${F.PAYEE}}}`, record), 'NX-88-24136 王小明');
});

check('欄位值裡的 $ 不會被當成取代語法', () => {
  const r = { [F.PAYEE]: { value: "A$&B$'C" } };
  assert.strictEqual(parseValue(`<{{${F.PAYEE}}}>`, r), "<A$&B$'C>");
});

check('formatDate：三種格式、空值、非法日期', () => {
  const d = new Date(2026, 9, 5);
  assert.strictEqual(formatDate(d, 'YYYYMMDD'), '20261005');
  assert.strictEqual(formatDate(d, 'YYYY-MM-DD'), '2026-10-05');
  assert.strictEqual(formatDate(d), '2026/10/05');
  assert.strictEqual(formatDate(null, 'YYYYMMDD'), '');
  assert.strictEqual(formatDate('不是日期', 'YYYYMMDD'), '');
});

check('resolveFieldValue 可單獨呼叫', () => {
  assert.strictEqual(resolveFieldValue('$id', record), '88');
});

check('只在列表頁註冊事件；原始碼不含分攤表、均攤相關程式', () => {
  const all = registered.flatMap((r) => (Array.isArray(r.types) ? r.types : [r.types]));
  assert.deepStrictEqual(all, ['app.record.index.show']);
  const src = readSrc('批次整理資料.js');
  ['ALLOC', 'isMultiAllocation', 'getAllocationData', 'fetchTableConfig', 'ALLOCATION_FIELDS', '分攤表索引欄位', 'EXPENSE_FILL_MODE'].forEach((s) =>
    assert.ok(!src.includes(s), s),
  );
  assert.ok(src.includes('APPS.SAP_MAPPING'));
});

console.log(`${passed} assertions passed.`);
