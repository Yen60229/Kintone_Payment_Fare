'use strict';

// 測試：受款人填寫設定_20250902.js
//   「同申請人」按鈕：填入「員工代碼 中文姓名」；沒填申請人要報錯；只在 create.show／edit.show 掛按鈕且不重複掛。
// 單獨執行：node tests/payee_fill.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
const alerts = [];
let currentRecord = null;
const spaceHost = { children: [], appendChild(el) { el.parentNode = this; this.children.push(el); } };
const domById = {};

const makeEl = () => {
  const listeners = {};
  return {
    style: {},
    textContent: '',
    addEventListener: (type, fn) => (listeners[type] = fn),
    click: () => listeners.click.call({ style: {} }),
    remove() {},
    parentNode: null,
    _listeners: listeners,
  };
};

global.alert = (m) => alerts.push(m);
global.setTimeout = () => 0; // 成功訊息的淡出計時器不必真的跑
global.document = {
  createElement: () => makeEl(),
  getElementById: (id) => domById[id] || null,
  head: { appendChild() {} },
};
global.window = {};
global.kintone = {
  app: {
    getId: () => 749,
    record: {
      get: () => ({ record: currentRecord }),
      set: ({ record }) => (currentRecord = record),
      getSpaceElement: () => spaceHost,
    },
  },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('受款人填寫設定_20250902.js'));

const F = global.window.PR_CONFIG.FIELDS;
const P = global.window.PR_PAYEE;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('payee_fill.test.cjs');

const recordWithApplicant = (applicant) => ({
  [F.APPLICANT]: { value: applicant ? [applicant] : [] },
  [F.PAYEE]: { value: '' },
});

check('組字：員工代碼 + 空白 + 括號內的中文姓名', () => {
  const info = P.getApplicantInfo(recordWithApplicant({ code: '24136', name: 'Jimmy (王小明)' }));
  assert.strictEqual(info.error, undefined);
  assert.strictEqual(info.code, '24136');
  assert.strictEqual(info.name, '王小明');
  assert.strictEqual(info.fullName, '24136 王小明');
});

check('組字：名稱沒有括號就整串當中文姓名', () => {
  assert.strictEqual(P.getApplicantInfo(recordWithApplicant({ code: '24145', name: '陳大文' })).fullName, '24145 陳大文');
});

check('組字：缺代碼只留姓名、不留前導空白', () => {
  assert.strictEqual(P.getApplicantInfo(recordWithApplicant({ name: '陳大文' })).fullName, '陳大文');
});

check('沒填申請人 → 回錯誤訊息', () => {
  assert.deepStrictEqual(P.getApplicantInfo(recordWithApplicant(null)), { error: '請先填寫申請人' });
  assert.deepStrictEqual(P.getApplicantInfo({}), { error: '請先填寫申請人' });
});

check('只取申請人（723 的「員工姓名」改成 749 的「申請人」），費用所屬人不影響結果', () => {
  const record = { ...recordWithApplicant({ code: 'A1', name: '甲' }), [F.EXPENSE_OWNER]: { value: [{ code: 'B2', name: '乙' }] } };
  assert.strictEqual(P.getApplicantInfo(record).fullName, 'A1 甲');
});

check('事件：只掛 create.show／edit.show，沒有任何 change 事件', () => {
  const all = registered.flatMap((r) => (Array.isArray(r.types) ? r.types : [r.types]));
  assert.deepStrictEqual(all.sort(), ['app.record.create.show', 'app.record.edit.show']);
});

let button = null;
check('掛按鈕：「同申請人」放進 apply_button 空白欄位', () => {
  const event = { record: recordWithApplicant({ code: '24136', name: '王小明' }) };
  assert.strictEqual(P.handleShow(event), event);
  assert.strictEqual(spaceHost.children.length, 1);
  button = spaceHost.children[0];
  assert.strictEqual(button.id, 'same-applicant-btn');
  assert.strictEqual(button.textContent, '同申請人');
  assert.strictEqual(button.type, 'button');
});

check('不重複掛：頁面上已有按鈕時再進 show 不會多一顆', () => {
  domById['same-applicant-btn'] = button;
  P.handleShow({ record: {} });
  assert.strictEqual(spaceHost.children.length, 1);
});

check('點按鈕：受款人寫入「員工代碼 中文姓名」', () => {
  currentRecord = recordWithApplicant({ code: '24136', name: 'Jimmy (王小明)' });
  button.click();
  assert.strictEqual(currentRecord[F.PAYEE].value, '24136 王小明');
  assert.strictEqual(alerts.length, 0);
});

check('點按鈕但沒填申請人 → alert 錯誤、受款人不動', () => {
  currentRecord = recordWithApplicant(null);
  currentRecord[F.PAYEE].value = '原值';
  button.click();
  assert.deepStrictEqual(alerts, ['請先填寫申請人']);
  assert.strictEqual(currentRecord[F.PAYEE].value, '原值');
});

check('原始碼不含類型判斷、舊的「同費用所屬人」按鈕與 723 員工姓名欄位', () => {
  const src = readSrc('受款人填寫設定_20250902.js');
  ['F.TYPE', 'COMPANY_TYPES', 'EMPLOYEE_NAME', 'same-expense-owner-btn', '同費用所屬人', 'F.EXPENSE_OWNER'].forEach((s) => assert.ok(!src.includes(s), s));
});

console.log(`${passed} assertions passed.`);
