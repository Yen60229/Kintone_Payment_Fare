'use strict';

// 測試：手動設定簽核流程（signing_personnel_manager）
//   一、會計單位不填：手動時改費用所屬人部門不能把「會計單位」又填回去（setAccountingUnit）
//      會計單位若在手動模式下被填回去，流程管理的「送會計」與手動的「送單位會計處理中」會同時成立，單子出現兩顆按鈕。
//      1. 手動：改費用所屬人部門 → 會計單位維持空白
//      2. 自動：改費用所屬人部門 → 會計單位照常填入
//      3. 呼叫時是自動、API 回來前使用者勾了手動 → 看寫入當下的畫面，仍然不填
//      4. 取消手動（確認）→ 會計單位恢復填入
//   二、手動模式的人數欄位連動與存檔驗證（人數與實際填寫要一致、固定欄位必填、管理員與作廢略過）
// 直接用 Node 執行：node tests/signing_manual_accounting.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));

const SLOTS = ['單位主管1', '單位主管2', '單位主管3', '單位次長', '單位次長1', '單位部長_支店長'];
const COUNT_M = '部門主管簽核人數';
const COUNT_D = '部門次長簽核人數';
const U = (code) => ({ code, name: code });

const loadSigning = () => {
  const handlers = {};
  const env = { live: {}, accountingCallbacks: [], shown: {}, loginCode: 'x', confirmAnswer: true };
  global.window = {};
  global.alert = () => {};
  global.confirm = () => env.confirmAnswer;
  global.kintone = {
    app: {
      getId: () => 749,
      record: {
        // 畫面上的資料：get 給複本、set 整份換掉，和 kintone 一樣
        get: () => ({ record: clone(env.live) }),
        set: (r) => {
          env.live = clone(r.record);
        },
        setFieldShown: (code, shown) => {
          env.shown[code] = shown;
        },
        setGroupFieldOpen: () => {},
      },
    },
    getLoginUser: () => ({ code: env.loginCode }),
    events: {
      on: (types, fn) => {
        [].concat(types).forEach((t) => {
          (handlers[t] = handlers[t] || []).push(fn);
        });
      },
    },
    api: Object.assign(
      (url, method, params, onOk) => {
        // 會計對應主檔：用回呼的寫法，先存起來，由測試決定什麼時候「回來」
        if (typeof onOk === 'function') {
          env.accountingCallbacks.push(() => onOk({ records: [env.accountingRecord] }));
          return undefined;
        }
        // 查職稱：讓它查不到，後面的簽核人員流程不在這個測試的範圍
        return Promise.reject(new Error('not needed'));
      },
      { url: (p) => p },
    ),
  };
  // eslint-disable-next-line no-eval
  eval(readSrc('payment_request_config.js'));
  const C = global.window.PR_CONFIG;
  // eslint-disable-next-line no-eval
  eval(readSrc('signing_personnel_manager_20260506.js'));
  const ACC = C.REF_FIELDS.ACCOUNTING_MAP;
  env.accountingRecord = { [ACC.APPLY_UNIT]: { value: 'U' }, [ACC.ACCOUNTING_UNIT]: { value: 'ACC_TPE' }, [ACC.ACCOUNTING_STAFF]: { value: [] }, [ACC.PERMISSION_USER]: { value: [] } };
  return { C, env, handlers };
};

const T = loadSigning();
const F = T.C.FIELDS;
const ORG_CHANGE = `app.record.create.change.${F.EXPENSE_OWNER_ORG}`;
const MANUAL_CHANGE = `app.record.create.change.${F.MANUAL_FLOW}`;
const MANAGER_COUNT_CHANGE = `app.record.create.change.${COUNT_M}`;
const DEPUTY_COUNT_CHANGE = `app.record.create.change.${COUNT_D}`;
const SUBMIT = 'app.record.create.submit';

const makeLive = ({ manual }) => {
  const r = {
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: [{ code: '航空貨物部-台北營業課', name: '航空貨物部-台北營業課' }] },
    [F.EXPENSE_OWNER]: { type: 'USER_SELECT', value: [U('ME')] },
    [F.MANUAL_FLOW]: { type: 'CHECK_BOX', value: manual ? [F.MANUAL_FLOW] : [] },
    [F.ACCOUNTING_UNIT]: { type: 'GROUP_SELECT', value: [] },
    [F.ACCOUNTING_STAFF]: { type: 'USER_SELECT', value: [] },
    [F.PERMISSION_STAFF]: { type: 'USER_SELECT', value: [] },
    [COUNT_M]: { value: '' },
    [COUNT_D]: { value: '' },
    [T.C.VOID_FIELD]: { type: 'CHECK_BOX', value: [] },
  };
  SLOTS.forEach((f) => (r[f] = { type: 'USER_SELECT', value: [] }));
  return r;
};

/** 在目前的畫面資料上觸發事件，並讓 API 的回呼回來 */
const fire = async (type, { flushBefore } = {}) => {
  T.env.accountingCallbacks.length = 0;
  const event = { type, record: clone(T.env.live) };
  const out = T.handlers[type][0](event);
  // kintone 會把 event.record 套回畫面
  T.env.live = clone((out || event).record);
  if (flushBefore) flushBefore();
  await Promise.resolve();
  T.env.accountingCallbacks.splice(0).forEach((cb) => cb());
};
const accountingOf = () => T.env.live[F.ACCOUNTING_UNIT].value.map((g) => g.code);

/** 跑存檔事件：回傳 event（有 error 代表被擋下） */
const submit = (record) => T.handlers[SUBMIT][0]({ type: SUBMIT, record });
/** 手動模式下的存檔資料：給人數與各格的人 */
const manualRecord = ({ managers = '0人', deputies = '0人', fill = {} }) => {
  const r = makeLive({ manual: true });
  r[COUNT_M].value = managers;
  r[COUNT_D].value = deputies;
  Object.entries(fill).forEach(([slot, code]) => (r[slot].value = [U(code)]));
  return r;
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`  ok - ${label}\n`);
};

(async () => {
  console.log('signing_manual_accounting.test.cjs');
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};

  // ── 一、會計單位不填 ──
  await check('手動設定簽核流程：改費用所屬人部門後會計單位維持空白，欄位也不顯示', async () => {
    T.env.live = makeLive({ manual: true });
    T.env.shown = {};
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(accountingOf(), []);
    assert.strictEqual(T.env.shown[F.ACCOUNTING_UNIT], false);
  });

  await check('自動：改費用所屬人部門後會計單位照常填入主檔查到的會計單位', async () => {
    T.env.live = makeLive({ manual: false });
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);
    assert.strictEqual(T.env.live[F.ACCOUNTING_UNIT].disabled, true);
  });

  await check('呼叫時是自動、API 回來前使用者勾了手動：看寫入當下，不填會計單位', async () => {
    T.env.live = makeLive({ manual: false });
    await fire(ORG_CHANGE, {
      flushBefore: () => {
        T.env.live[F.MANUAL_FLOW].value = [F.MANUAL_FLOW];
      },
    });
    assert.deepStrictEqual(accountingOf(), []);
  });

  await check('呼叫時是手動、API 回來前使用者取消了手動：看寫入當下，照常填入', async () => {
    T.env.live = makeLive({ manual: true });
    await fire(ORG_CHANGE, {
      flushBefore: () => {
        T.env.live[F.MANUAL_FLOW].value = [];
      },
    });
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);
  });

  await check('手動時其他欄位不受影響：會計承辦人、有權限人員照舊帶入', async () => {
    const ACC = T.C.REF_FIELDS.ACCOUNTING_MAP;
    T.env.accountingRecord[ACC.ACCOUNTING_STAFF] = { value: [U('S1')] };
    T.env.accountingRecord[ACC.PERMISSION_USER] = { value: [U('P1')] };
    T.env.live = makeLive({ manual: true });
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(T.env.live[F.ACCOUNTING_STAFF].value.map((u) => u.code), ['S1']);
    assert.deepStrictEqual(T.env.live[F.PERMISSION_STAFF].value.map((u) => u.code), ['P1']);
    assert.deepStrictEqual(accountingOf(), []);
    T.env.accountingRecord[ACC.ACCOUNTING_STAFF] = { value: [] };
    T.env.accountingRecord[ACC.PERMISSION_USER] = { value: [] };
  });

  await check('勾手動：會計單位清空；取消手動（按確定）：會計單位恢復填入', async () => {
    T.env.live = makeLive({ manual: false });
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);
    // 勾選手動
    T.env.live[F.MANUAL_FLOW].value = [F.MANUAL_FLOW];
    await fire(MANUAL_CHANGE);
    assert.deepStrictEqual(accountingOf(), []);
    // 取消手動
    T.env.live[F.MANUAL_FLOW].value = [];
    await fire(MANUAL_CHANGE);
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);
  });

  await check('取消手動但按「取消」：維持手動模式（重新勾回核取方塊），會計單位仍空白', async () => {
    T.env.live = makeLive({ manual: true });
    await fire(MANUAL_CHANGE);
    T.env.live[F.MANUAL_FLOW].value = [];
    T.env.confirmAnswer = false;
    await fire(MANUAL_CHANGE);
    T.env.confirmAnswer = true;
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [T.C.OPTIONS.MANUAL_FLOW.ON]);
    assert.deepStrictEqual(accountingOf(), []);
  });

  // ── 二、手動模式連動與驗證 ──
  await check('勾手動：人數欄位開放且歸 0 人，主管／次長欄位先隱藏，部長與會計承辦人欄位開放顯示', async () => {
    T.env.live = makeLive({ manual: true });
    T.env.shown = {};
    await fire(MANUAL_CHANGE);
    assert.strictEqual(T.env.live[COUNT_M].value, '0人');
    assert.strictEqual(T.env.live[COUNT_D].value, '0人');
    assert.strictEqual(T.env.live[COUNT_M].disabled, false);
    ['單位主管1', '單位主管2', '單位主管3', '單位次長', '單位次長1'].forEach((f) => assert.strictEqual(T.env.shown[f], false, f));
    ['單位部長_支店長', F.ACCOUNTING_STAFF].forEach((f) => assert.strictEqual(T.env.shown[f], true, f));
    assert.strictEqual(T.env.shown[COUNT_M], true);
    assert.strictEqual(T.env.shown[COUNT_D], true);
  });

  await check('主管人數 2 人：顯示主管2、主管3，隱藏並清空主管1；次長 1 人：只顯示次長1', async () => {
    T.env.live = makeLive({ manual: true });
    T.env.live['單位主管1'].value = [U('OLD')];
    T.env.live[COUNT_M].value = '2人';
    T.env.shown = {};
    await fire(MANAGER_COUNT_CHANGE);
    assert.deepStrictEqual([T.env.shown['單位主管1'], T.env.shown['單位主管2'], T.env.shown['單位主管3']], [false, true, true]);
    assert.deepStrictEqual(T.env.live['單位主管1'].value, []);
    T.env.live[COUNT_D].value = '1人';
    await fire(DEPUTY_COUNT_CHANGE);
    assert.deepStrictEqual([T.env.shown['單位次長'], T.env.shown['單位次長1']], [false, true]);
  });

  await check('非手動模式：改人數欄位什麼都不做', async () => {
    T.env.live = makeLive({ manual: false });
    T.env.live[COUNT_M].value = '3人';
    T.env.shown = {};
    await fire(MANAGER_COUNT_CHANGE);
    assert.deepStrictEqual(T.env.shown, {});
  });

  await check('存檔驗證：非手動模式不檢查；表單作廢略過檢查', () => {
    const auto = makeLive({ manual: false });
    assert.strictEqual(submit(auto).error, undefined);
    const voided = manualRecord({ managers: '3人' });
    voided[T.C.VOID_FIELD].value = [T.C.VOID_FIELD];
    assert.strictEqual(submit(voided).error, undefined);
  });

  await check('存檔驗證：主管人數與實際填寫不一致 → 擋下並說明', () => {
    const ev = submit(manualRecord({ managers: '2人', fill: { 單位主管3: 'M3', 單位部長_支店長: 'H' } }));
    assert.match(ev.error, /簽核流程驗證失敗/);
    assert.match(ev.error, /部門主管簽核人數選擇 2人，但實際填寫 1 位/);
  });

  await check('存檔驗證：次長人數與實際填寫不一致 → 擋下；一致則不報次長的錯', () => {
    const ev = submit(manualRecord({ deputies: '2人', fill: { 單位次長1: 'D1', 單位部長_支店長: 'H' } }));
    assert.match(ev.error, /部門次長簽核人數選擇 2人，但實際填寫 1 位/);
    const ok = submit(manualRecord({ deputies: '1人', fill: { 單位次長1: 'D1', 單位部長_支店長: 'H' } }));
    assert.ok(!/次長簽核人數/.test(ok.error || ''));
  });

  await check('存檔驗證：一般使用者的部長與會計單位承辦人必填；填了就通過', () => {
    const ev = submit(manualRecord({}));
    assert.match(ev.error, /請填寫「單位部長\/支店長」欄位/);
    assert.match(ev.error, /請填寫「會計單位承辦人」欄位/);
    const full = manualRecord({ fill: { 單位部長_支店長: 'H' } });
    full[F.ACCOUNTING_STAFF].value = [U('S1')];
    assert.strictEqual(submit(full).error, undefined);
  });

  await check('存檔驗證：管理員略過固定欄位必填，人數對不上仍然擋', () => {
    T.env.loginCode = T.C.ADMIN_USERS[0];
    assert.strictEqual(submit(manualRecord({})).error, undefined);
    assert.match(submit(manualRecord({ managers: '1人' })).error, /部門主管簽核人數選擇 1人，但實際填寫 0 位/);
    T.env.loginCode = 'x';
  });

  await check('已選人數卻沒填任何人 → 擋下', () => {
    const ev = submit(manualRecord({ managers: '1人', deputies: '1人', fill: { 單位部長_支店長: 'H' } }));
    assert.match(ev.error, /已選擇部門主管簽核人數，但未填寫任何主管人員/);
    assert.match(ev.error, /已選擇部門次長簽核人數，但未填寫任何次長人員/);
  });

  await check('編輯畫面：手動記錄依人數顯示欄位並開放人數與固定欄位', () => {
    const r = manualRecord({ managers: '1人', deputies: '2人', fill: { 單位主管3: 'M3', 單位次長: 'D0', 單位次長1: 'D1', 單位部長_支店長: 'H' } });
    T.env.shown = {};
    T.handlers['app.record.edit.show'].forEach((fn) => fn({ type: 'app.record.edit.show', record: r }));
    assert.strictEqual(r[COUNT_M].disabled, false);
    assert.strictEqual(T.env.shown['單位主管3'], true);
    assert.strictEqual(T.env.shown['單位次長'], true);
    assert.strictEqual(r[F.ACCOUNTING_STAFF].disabled, false);
  });

  console.log = origLog;
  console.error = origErr;
  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
