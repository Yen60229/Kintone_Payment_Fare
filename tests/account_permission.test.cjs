'use strict';

// 測試：帳號權限設定_20260722.js
//   ① 依登入者帳號套用顯示／編輯權限（show 事件）
//   ② 必填未填 → 直接 event.error（不再借 NXVendorDB），欄位也標紅
//   ③ 已移除：類型欄位鎖定、類型 change 重新套用、window.NXAccountPermission、window.NXVendorDB 分支
// 單獨執行：node tests/account_permission.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const fileName = '帳號權限設定_20260722.js';
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
const src = readSrc(fileName);

const registered = [];
const shown = {};
let apiQuery = null;

// 權限設定 App 的一筆記錄：帳號 24136 在「報銷人填單」狀態下，受款人可編輯且必填、理由隱藏
const settingRecord = {
  帳號權限設定: {
    value: [
      {
        value: {
          帳號權限: { value: [{ code: '24136', name: 'Jimmy' }] },
          帳號欄位屬性: { value: '' },
          帳號欄位設定: { value: '受款人' },
          帳號欄位涵蓋值: { value: '' },
          帳號顯示選項: { value: ['顯示'] },
          帳號權限選項: { value: ['編輯'] },
          帳號欄位必填: { value: ['必填'] },
          帳號狀態設定: { value: '報銷人填單' },
          帳號使用狀況: { value: '使用中' },
        },
      },
      {
        value: {
          帳號權限: { value: [{ code: '24136', name: 'Jimmy' }] },
          帳號欄位屬性: { value: '' },
          帳號欄位設定: { value: '理由' },
          帳號欄位涵蓋值: { value: '' },
          帳號顯示選項: { value: ['隱藏'] },
          帳號權限選項: { value: [] },
          帳號欄位必填: { value: [] },
          帳號狀態設定: { value: '報銷人填單' },
          帳號使用狀況: { value: '使用中' },
        },
      },
    ],
  },
};

global.window = { NXVendorDB: { pushSubmitError: () => assert.fail('不應再呼叫 NXVendorDB.pushSubmitError') } };
global.kintone = {
  app: {
    getId: () => 749,
    record: { setFieldShown: (code, v) => (shown[code] = v), getFieldElement: () => null },
  },
  getLoginUser: () => ({ code: '24136', name: 'Jimmy' }),
  user: { getOrganizations: async () => [] },
  api: Object.assign(
    async (url, method, params) => {
      apiQuery = params;
      return { records: [settingRecord] };
    },
    { url: (p) => p },
  ),
  events: { on: (types, handler) => registered.push({ types: [].concat(types), handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(src);

const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const handlerOf = (type) => registered.find((r) => r.types.includes(type)).handler;

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const recordOf = (payee) => ({
  [F.STATUS_FIELD]: { value: '報銷人填單' },
  [F.PAYEE]: { type: 'SINGLE_LINE_TEXT', value: payee },
  [F.REASON]: { type: 'MULTI_LINE_TEXT', value: '' },
});

(async () => {
  console.log('account_permission.test.cjs');

  await check('事件：show 類（含列印頁）與 submit 類，沒有任何 change 事件', () => {
    const all = registered.flatMap((r) => r.types);
    ['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show', 'app.record.print.show', 'app.record.create.submit', 'app.record.edit.submit'].forEach((t) =>
      assert.ok(all.includes(t), t),
    );
    assert.ok(!all.some((t) => t.includes('.change.')));
  });

  await check('show：依登入帳號套用——受款人顯示且可編輯、理由隱藏且鎖住', async () => {
    const event = { type: 'app.record.edit.show', record: recordOf('') };
    const result = await handlerOf('app.record.edit.show')(event);
    assert.strictEqual(result, event);
    assert.strictEqual(shown[F.PAYEE], true);
    assert.strictEqual(shown[F.REASON], false);
    assert.strictEqual(event.record[F.PAYEE].disabled, false);
    assert.strictEqual(event.record[F.REASON].disabled, true);
    assert.strictEqual(apiQuery.query, 'APP_ID = "749"');
    assert.strictEqual(apiQuery.app, C.APPS.PERMISSION);
  });

  await check('show：詳細頁是唯讀畫面，不設 disabled', async () => {
    const event = { type: 'app.record.detail.show', record: recordOf('x') };
    await handlerOf('app.record.detail.show')(event);
    assert.strictEqual(event.record[F.PAYEE].disabled, undefined);
  });

  await check('編輯畫面不再鎖任何「類型」欄位（沒有類型這個欄位）', async () => {
    const event = { type: 'app.record.edit.show', record: { ...recordOf(''), 類型: { type: 'DROP_DOWN', value: 'x' } } };
    await handlerOf('app.record.edit.show')(event);
    assert.strictEqual(event.record['類型'].disabled, undefined);
  });

  await check('submit：必填未填 → event.error 直接擋下，欄位標紅（即使 window.NXVendorDB 存在也不使用）', async () => {
    const event = { type: 'app.record.create.submit', record: recordOf('') };
    await handlerOf('app.record.create.submit')(event);
    assert.strictEqual(event.error, '尚有必填欄位未填寫');
    assert.strictEqual(event.record[F.PAYEE].error, '此欄位為必填');
  });

  await check('submit：必填有填 → 不擋存檔', async () => {
    const event = { type: 'app.record.edit.submit', record: recordOf('24136 王小明') };
    await handlerOf('app.record.edit.submit')(event);
    assert.strictEqual(event.error, undefined);
    assert.strictEqual(event.record[F.PAYEE].error, null);
  });

  await check('對外 API 與其他專案模組的殘留已移除', () => {
    assert.strictEqual(global.window.NXAccountPermission, undefined);
    ['NXAccountPermission', 'NXVendorDB', 'OPERATION_FIELD', 'EVENTS_OPERATION_CHANGE', 'onOperationChange', 'lockOperationFieldToCreator', 'reapplyPermissions', 'F.TYPE', 'CREATOR_FIELD'].forEach(
      (s) => assert.ok(!src.includes(s), s),
    );
  });

  console.log(`${passed} assertions passed.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
