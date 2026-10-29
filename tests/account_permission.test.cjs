'use strict';

// 測試：帳號權限設定_20260722.js
//   ① 依登入者帳號套用顯示／編輯權限（show 事件）
//   ② 必填未填 → event.error＝「儲存失敗」、欄位標紅；訊息用全域 SweetAlert（新增／編輯交給 PR_SAVE_ERRORS 合併顯示，列表直接編輯直接跳）
//   ⑤ 錯誤視窗點名欄位「標籤」（kintone.app.getFormFields，沒有就打 REST，都取不到才顯示代碼）
//   ④ 讀不到權限規則：開畫面跳「發生錯誤」不擋畫面；存檔擋下「儲存失敗」
//   ⑥ 子表格新增列：依開畫面時的權限重新鎖定每一列（子表格 change 事件，讀表單設定後註冊）
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
let apiFail = false;
let formFieldsFail = false;
const formFieldsCalls = [];
// 749 表單實際的標籤（kintone MCP 讀出）
const FORM_PROPERTIES = {
  傳票編號: { code: '傳票編號', label: '申請單號（Application Number）' },
  傳票日期: { code: '傳票日期', label: '過帳日期（Posting Date）' },
  受款人: { code: '受款人', label: '受款人' },
  交通費請款單: { code: '交通費請款單', type: 'SUBTABLE', label: '交通費請款單', fields: { 發票號碼: { code: '發票號碼', label: '發票號碼／票號' } } },
};
const SUBTABLE = '交通費請款單';
const SUBTABLE_CHANGE = [`app.record.create.change.${SUBTABLE}`, `app.record.edit.change.${SUBTABLE}`];
const swalCalls = [];

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
      // 子表格明細欄位：稅額顯示但不可編輯（測子表格新增列重新鎖定）
      {
        value: {
          帳號權限: { value: [{ code: '24136', name: 'Jimmy' }] },
          帳號欄位屬性: { value: '' },
          帳號欄位設定: { value: '稅額' },
          帳號欄位涵蓋值: { value: '' },
          帳號顯示選項: { value: ['顯示'] },
          帳號權限選項: { value: [] },
          帳號欄位必填: { value: [] },
          帳號狀態設定: { value: '報銷人填單' },
          帳號使用狀況: { value: '使用中' },
        },
      },
    ],
  },
};

global.window = {
  NXVendorDB: { pushSubmitError: () => assert.fail('不應再呼叫 NXVendorDB.pushSubmitError') },
  Swal: { fire: (opts) => swalCalls.push(opts) },
};
global.kintone = {
  app: {
    getId: () => 749,
    getFormFields: async () => {
      formFieldsCalls.push(1);
      if (formFieldsFail) throw new Error('no permission');
      return FORM_PROPERTIES;
    },
    record: { setFieldShown: (code, v) => (shown[code] = v), getFieldElement: () => null },
  },
  getLoginUser: () => ({ code: '24136', name: 'Jimmy' }),
  user: { getOrganizations: async () => [] },
  api: Object.assign(
    async (url, method, params) => {
      apiQuery = params;
      if (apiFail) throw new Error('403');
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

  await check('事件：show 類（含列印頁）與 submit 類；change 事件只有表單設定裡的子表格（讀完表單設定才註冊）', async () => {
    await new Promise((resolve) => setImmediate(resolve)); // 等讀表單設定、註冊子表格 change 事件
    const all = registered.flatMap((r) => r.types);
    ['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show', 'app.record.print.show', 'app.record.create.submit', 'app.record.edit.submit'].forEach((t) =>
      assert.ok(all.includes(t), t),
    );
    assert.deepStrictEqual(all.filter((t) => t.includes('.change.')).sort(), [...SUBTABLE_CHANGE].sort());
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

  await check('子表格新增列：依開畫面時的權限重新鎖定每一列（新列預設可編輯），主表欄位照樣套用', async () => {
    const row = () => ({ value: { 稅額: { type: 'NUMBER', value: '' }, 發票號碼: { type: 'SINGLE_LINE_TEXT', value: '' } } });
    const show = { type: 'app.record.edit.show', record: { ...recordOf(''), [SUBTABLE]: { type: 'SUBTABLE', value: [row()] } } };
    await handlerOf('app.record.edit.show')(show);
    assert.strictEqual(show.record[SUBTABLE].value[0].value.稅額.disabled, true);

    const change = { type: SUBTABLE_CHANGE[1], record: { ...recordOf(''), [SUBTABLE]: { type: 'SUBTABLE', value: [row(), row()] } } };
    const result = handlerOf(SUBTABLE_CHANGE[1])(change);
    assert.strictEqual(result, change, 'change 事件同步回傳 event');
    change.record[SUBTABLE].value.forEach((r, i) => {
      assert.strictEqual(r.value.稅額.disabled, true, `第 ${i + 1} 列稅額鎖住`);
      assert.strictEqual(r.value.發票號碼.disabled, undefined, `第 ${i + 1} 列沒設定的欄位不動`);
    });
    assert.strictEqual(change.record[F.REASON].disabled, true);
    assert.strictEqual(change.record[F.PAYEE].disabled, false);
  });

  await check('子表格 change：開畫面讀權限失敗（還沒有權限結果）→ 維持現狀不動', async () => {
    const fresh = [];
    const realOn = global.kintone.events.on;
    global.kintone.events.on = (types, handler) => fresh.push({ types: [].concat(types), handler });
    // eslint-disable-next-line no-eval
    eval(src);
    await new Promise((resolve) => setImmediate(resolve));
    global.kintone.events.on = realOn;
    const change = { type: SUBTABLE_CHANGE[0], record: { [SUBTABLE]: { type: 'SUBTABLE', value: [{ value: { 稅額: { value: '' } } }] } } };
    fresh.find((r) => r.types.includes(SUBTABLE_CHANGE[0])).handler(change);
    assert.strictEqual(change.record[SUBTABLE].value[0].value.稅額.disabled, undefined);
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

  await check('submit：必填未填 → event.error＝儲存失敗、欄位標紅，訊息交給 PR_SAVE_ERRORS（不使用 window.NXVendorDB）', async () => {
    swalCalls.length = 0;
    const event = { type: 'app.record.create.submit', record: recordOf('') };
    await handlerOf('app.record.create.submit')(event);
    assert.strictEqual(event.error, '儲存失敗');
    assert.strictEqual(event.record[F.PAYEE].error, '此欄位為必填');
    const queued = global.window.PR_SAVE_ERRORS.take();
    assert.strictEqual(queued.length, 1, '交給 payment_request_submit 合併成同一個視窗');
    assert.ok(queued[0].startsWith('尚有必填欄位未填寫') && queued[0].includes('▸受款人'), queued[0]);
    assert.strictEqual(swalCalls.length, 0, '新增／編輯不自己跳視窗（避免和存檔驗證視窗互蓋）');
  });

  await check('submit：必填有填 → 不擋存檔', async () => {
    const event = { type: 'app.record.edit.submit', record: recordOf('24136 王小明') };
    await handlerOf('app.record.edit.submit')(event);
    assert.strictEqual(event.error, undefined);
    assert.strictEqual(event.record[F.PAYEE].error, null);
  });

  // 列表直接編輯：規則改成傳票編號、傳票日期必填（受款人仍必填，但列表上改不了）
  const voucherRule = (code) => ({
    value: {
      帳號權限: { value: [{ code: '24136', name: 'Jimmy' }] },
      帳號欄位屬性: { value: '' },
      帳號欄位設定: { value: code },
      帳號欄位涵蓋值: { value: '' },
      帳號顯示選項: { value: ['顯示'] },
      帳號權限選項: { value: ['編輯'] },
      帳號欄位必填: { value: ['必填'] },
      帳號狀態設定: { value: '單位會計處理中(台北)' },
      帳號使用狀況: { value: '使用中' },
    },
  });
  const inlineRecord = ({ no = '', date = '', payee = '' } = {}) => ({
    [F.STATUS_FIELD]: { value: '單位會計處理中(台北)' },
    [F.VOUCHER_NO]: { type: 'SINGLE_LINE_TEXT', value: no },
    [F.VOUCHER_DATE]: { type: 'DATE', value: date },
    [F.PAYEE]: { type: 'SINGLE_LINE_TEXT', value: payee },
  });
  const withVoucherRules = async (fn) => {
    const original = settingRecord.帳號權限設定.value;
    settingRecord.帳號權限設定.value = [
      voucherRule(F.VOUCHER_NO),
      voucherRule(F.VOUCHER_DATE),
      { value: { ...original[0].value, 帳號狀態設定: { value: '單位會計處理中(台北)' } } },
    ];
    try {
      await fn();
    } finally {
      settingRecord.帳號權限設定.value = original;
    }
  };

  await check('列表直接編輯存檔（index.edit.submit）也檢查必填：傳票編號、傳票日期沒填 → 儲存失敗，SweetAlert 點名欄位標籤', async () => {
    assert.ok(registered.some((r) => r.types.includes('app.record.index.edit.submit')));
    await withVoucherRules(async () => {
      const event = { type: 'app.record.index.edit.submit', record: inlineRecord({ payee: 'x' }) };
      swalCalls.length = 0;
      await handlerOf('app.record.index.edit.submit')(event);
      assert.strictEqual(event.error, '儲存失敗');
      assert.strictEqual(event.record[F.VOUCHER_NO].error, '此欄位為必填');
      assert.strictEqual(swalCalls.length, 1, '列表直接編輯沒有 payment_request_submit，直接跳 SweetAlert');
      assert.strictEqual(swalCalls[0].title, '儲存失敗');
      assert.ok(swalCalls[0].html.includes('申請單號（Application Number）') && swalCalls[0].html.includes('過帳日期（Posting Date）'), swalCalls[0].html);
      assert.ok(!swalCalls[0].html.includes(F.VOUCHER_NO), '顯示標籤，不是欄位代碼');
      assert.strictEqual(global.window.PR_SAVE_ERRORS.take().length, 0);
    });
  });

  await check('列表直接編輯存檔：都有填 → 不擋', async () => {
    await withVoucherRules(async () => {
      const event = { type: 'app.record.index.edit.submit', record: inlineRecord({ no: 'V001', date: '2026-10-27', payee: 'x' }) };
      await handlerOf('app.record.index.edit.submit')(event);
      assert.strictEqual(event.error, undefined);
    });
  });

  await check('列表直接編輯存檔：列表上改不了的欄位（受款人）就算必填沒填也不擋，留給編輯畫面', async () => {
    await withVoucherRules(async () => {
      const event = { type: 'app.record.index.edit.submit', record: inlineRecord({ no: 'V001', date: '2026-10-27', payee: '' }) };
      await handlerOf('app.record.index.edit.submit')(event);
      assert.strictEqual(event.error, undefined);
      assert.strictEqual(event.record[F.PAYEE].error, undefined, '不碰受款人');
    });
    // 同樣的規則在編輯畫面存檔照樣擋受款人
    await withVoucherRules(async () => {
      const event = { type: 'app.record.edit.submit', record: inlineRecord({ no: 'V001', date: '2026-10-27', payee: '' }) };
      await handlerOf('app.record.edit.submit')(event);
      assert.strictEqual(event.error, '儲存失敗');
      assert.ok(global.window.PR_SAVE_ERRORS.take()[0].includes(`▸${F.PAYEE}`));
    });
  });

  await check('讀不到權限規則（例如沒有帳號權限設定 App 的權限）：開畫面跳「發生錯誤」但不擋畫面；存檔擋下「儲存失敗」', async () => {
    // 權限規則讀過就快取，另外載一份全新的模組（只收它自己註冊的處理程式）
    const fresh = [];
    const realOn = global.kintone.events.on;
    global.kintone.events.on = (types, handler) => fresh.push({ types: [].concat(types), handler });
    // eslint-disable-next-line no-eval
    eval(src);
    global.kintone.events.on = realOn;
    const handlerOf = (type) => fresh.find((r) => r.types.includes(type)).handler;
    apiFail = true;
    const realError = console.error;
    console.error = () => {};
    try {
      swalCalls.length = 0;
      const show = { type: 'app.record.create.show', record: recordOf('') };
      assert.strictEqual(await handlerOf('app.record.create.show')(show), show);
      assert.strictEqual(swalCalls.length, 1);
      assert.strictEqual(swalCalls[0].title, '發生錯誤');
      assert.strictEqual(swalCalls[0].icon, 'error');
      const save = { type: 'app.record.create.submit', record: recordOf('x') };
      await handlerOf('app.record.create.submit')(save);
      assert.strictEqual(save.error, '儲存失敗');
      assert.ok(global.window.PR_SAVE_ERRORS.take()[0].includes('無法讀取帳號權限設定'));
      const inline = { type: 'app.record.index.edit.submit', record: recordOf('x') };
      await handlerOf('app.record.index.edit.submit')(inline);
      assert.strictEqual(inline.error, '儲存失敗');
      assert.strictEqual(swalCalls[swalCalls.length - 1].title, '儲存失敗');
    } finally {
      apiFail = false;
      console.error = realError;
    }
  });

  await check('欄位標籤整頁只取一次；取不到（例如沒有權限）就退回顯示欄位代碼，照樣擋存檔', async () => {
    // 每載入一份模組讀一次表單設定（子表格清單與標籤共用同一次）；前面載了 3 份、存檔多次，仍只有 3 次
    assert.strictEqual(formFieldsCalls.length, 3, '前面存檔多次，標籤只取一次');
    const fresh = [];
    const realOn = global.kintone.events.on;
    global.kintone.events.on = (types, handler) => fresh.push({ types: [].concat(types), handler });
    formFieldsFail = true; // 載入時就會讀表單設定，要在載入前設成失敗
    const realError = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    try {
      // eslint-disable-next-line no-eval
      eval(src);
      global.kintone.events.on = realOn;
      await withVoucherRules(async () => {
        swalCalls.length = 0;
        const event = { type: 'app.record.index.edit.submit', record: inlineRecord({ payee: 'x' }) };
        await fresh.find((r) => r.types.includes('app.record.index.edit.submit')).handler(event);
        assert.strictEqual(event.error, '儲存失敗');
        assert.ok(swalCalls[0].html.includes(F.VOUCHER_NO), swalCalls[0].html);
      });
      assert.ok(errors.some((m) => m.includes('讀取子表格清單失敗')), '讀不到表單設定時記錄子表格不會套用權限');
    } finally {
      global.kintone.events.on = realOn;
      console.error = realError;
      formFieldsFail = false;
    }
  });

  await check('沒有 kintone.app.getFormFields 時改打 REST 取標籤；子表格欄位附「第幾列」', () => {
    const body = src.slice(src.indexOf('const getFormProperties'), src.indexOf('const getFieldLabels'));
    assert.ok(body.includes("'/k/v1/app/form/fields'") && body.includes('prop?.fields'), body);
    assert.ok(src.includes('（第 ${row} 列）'));
  });

  await check('原始碼：event.error 只用「儲存失敗」，提醒都走全域 SweetAlert（沒有 alert／自訂錯誤文字放進 event.error）', () => {
    const errorAssigns = [...src.matchAll(/event\.error = ([^;]+);/g)].map((m) => m[1].trim());
    assert.deepStrictEqual(errorAssigns, ['SAVE_FAILED']);
    assert.ok(src.includes("const SAVE_FAILED = '儲存失敗'") && src.includes("const ERROR_TITLE = '發生錯誤'"));
    assert.ok(src.includes('window.Swal'));
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
