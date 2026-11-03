'use strict';

// 測試：手動設定簽核流程（signing_personnel_manager）
//   一、會計單位不填：手動時改費用所屬人部門不能把「會計單位」又填回去（setAccountingUnit）
//      會計單位若在手動模式下被填回去，流程管理的「送會計」與手動的「送單位會計處理中」會同時成立，單子出現兩顆按鈕。
//      1. 手動：改費用所屬人部門 → 會計單位維持空白
//      2. 自動：改費用所屬人部門 → 會計單位照常填入
//      3. 呼叫時是自動、API 回來前使用者勾了手動 → 看寫入當下的畫面，仍然不填
//      4. 取消手動（確認）→ 會計單位恢復填入
//   二、勾選／取消手動模式：6 格與人數欄位清空鎖住、只限「費用歸屬不限部門」群組、簽核人交給手動簽核人設定
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
const SUBMIT = 'app.record.create.submit';

/** 新的畫面資料（同時讓簽核人員程式忘掉上一個畫面的勾選狀態，模擬重新開頁） */
const makeLive = ({ manual }) => {
  global.window.PR_MANUAL_MODE._reset();
  const r = {
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: [{ code: '航空貨物部-台北營業課', name: '航空貨物部-台北營業課' }] },
    [F.EXPENSE_OWNER]: { type: 'USER_SELECT', value: [U('ME')] },
    [F.MANUAL_FLOW]: { type: 'CHECK_BOX', value: manual ? [F.MANUAL_FLOW] : [] },
    [F.ACCOUNTING_UNIT]: { type: 'GROUP_SELECT', value: [] },
    [F.ACCOUNTING_STAFF]: { type: 'USER_SELECT', value: [] },
    [F.PERMISSION_STAFF]: { type: 'USER_SELECT', value: [] },
    [T.C.MANUAL_SIGNERS.ACCOUNTING_FIELD]: { type: 'USER_SELECT', value: [] },
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

  await check('手動時：會計單位承辦人照舊自動帶入；手動會計承辦人已選的不蓋掉，空的才帶預設並鎖住、通知開著的視窗補上', async () => {
    const ACC = T.C.REF_FIELDS.ACCOUNTING_MAP;
    const MANUAL_ACC = T.C.MANUAL_SIGNERS.ACCOUNTING_FIELD;
    const offered = [];
    global.window.PR_MANUAL_SIGNERS = { offerAccounting: (list) => offered.push(list.map((u) => u.code)) };
    T.env.accountingRecord[ACC.ACCOUNTING_STAFF] = { value: [U('S1')] };
    T.env.live = makeLive({ manual: true });
    T.env.live[MANUAL_ACC].value = [U('PICKED')];
    T.env.live[F.ACCOUNTING_STAFF].value = [U('OLD')];
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(T.env.live[F.ACCOUNTING_STAFF].value.map((u) => u.code), ['S1'], '原本的欄位照舊重帶');
    assert.deepStrictEqual(T.env.live[MANUAL_ACC].value.map((u) => u.code), ['PICKED']);
    assert.strictEqual(offered.length, 0);

    T.env.live = makeLive({ manual: true });
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(T.env.live[MANUAL_ACC].value.map((u) => u.code), ['S1']);
    assert.strictEqual(T.env.live[MANUAL_ACC].disabled, true);
    assert.deepStrictEqual(offered, [['S1']]);

    T.env.live = makeLive({ manual: false });
    await fire(ORG_CHANGE);
    assert.deepStrictEqual(T.env.live[MANUAL_ACC].value, [], '自動模式不動手動會計承辦人');
    assert.strictEqual(offered.length, 1);
    T.env.accountingRecord[ACC.ACCOUNTING_STAFF] = { value: [] };
    delete global.window.PR_MANUAL_SIGNERS;
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
    await fire(MANUAL_CHANGE); // kintone 在 set() 之後會再觸發一次 change，程式自己取消的那次要直接放行
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

  // ── 二、勾選／取消手動模式（簽核人的三格與視窗在手動簽核人設定，這裡用替身確認有交給它）──
  const signerCalls = [];
  global.window.PR_MANUAL_SIGNERS = {
    signersOf: () => [null, null, null],
    enter: (record, opts) => signerCalls.push({ type: 'enter', opts }),
    leave: () => signerCalls.push({ type: 'leave' }),
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  await check('勾手動：人數歸 0人並鎖住隱藏，6 格清空隱藏，原本的會計單位承辦人不動，馬上開指定簽核人視窗', async () => {
    T.env.live = makeLive({ manual: true });
    SLOTS.forEach((f) => (T.env.live[f].value = [U('OLD')]));
    T.env.shown = {};
    signerCalls.length = 0;
    await fire(MANUAL_CHANGE);
    [COUNT_M, COUNT_D].forEach((f) => {
      assert.strictEqual(T.env.live[f].value, '0人', f);
      assert.strictEqual(T.env.live[f].disabled, true, f);
      assert.strictEqual(T.env.shown[f], false, f);
    });
    SLOTS.forEach((f) => {
      assert.strictEqual(T.env.live[f].value.length, 0, f);
      assert.strictEqual(T.env.shown[f], false, f);
    });
    assert.strictEqual(T.env.live[F.ACCOUNTING_STAFF].disabled, undefined, '原本的會計單位承辦人不歸手動管');
    assert.strictEqual(T.env.shown[F.ACCOUNTING_STAFF], undefined);
    assert.strictEqual(signerCalls.length, 1);
    assert.strictEqual(signerCalls[0].type, 'enter');
    assert.strictEqual(signerCalls[0].opts.openNow, true);
  });

  await check('不在「費用歸屬不限部門」群組的人勾手動：取消勾選、說明原因，不進手動模式', async () => {
    const alerts = [];
    global.alert = (m) => alerts.push(m);
    global.window.PR_COST_SCOPE = { isExempt: () => false, ensureExempt: () => Promise.resolve(false), applicantCodeOf: () => 'ME' };
    T.env.live = makeLive({ manual: true });
    T.env.live['單位主管3'].value = [U('AUTO')];
    signerCalls.length = 0;
    await fire(MANUAL_CHANGE);
    await settle();
    assert.strictEqual(T.env.live[F.MANUAL_FLOW].value.length, 0);
    assert.strictEqual(T.env.live['單位主管3'].value[0].code, 'AUTO', '自動排的人不動');
    assert.strictEqual(signerCalls.length, 0);
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /費用歸屬不限部門/);
    global.alert = () => {};
  });

  await check('開畫面的群組查詢還沒回來就勾手動：先取消勾選，查完確定在群組再勾回去並開視窗', async () => {
    global.window.PR_COST_SCOPE = { isExempt: () => false, ensureExempt: () => Promise.resolve(true), applicantCodeOf: () => 'ME' };
    T.env.live = makeLive({ manual: true });
    signerCalls.length = 0;
    const out = T.handlers[MANUAL_CHANGE][0]({ type: MANUAL_CHANGE, record: clone(T.env.live) });
    assert.strictEqual(out.record[F.MANUAL_FLOW].value.length, 0, '事件當下先取消');
    T.env.live = clone(out.record);
    await settle();
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [T.C.OPTIONS.MANUAL_FLOW.ON]);
    assert.strictEqual(T.env.live[COUNT_M].value, '0人');
    assert.strictEqual(signerCalls[0].opts.openNow, true);
  });

  await check('群組成員勾手動：照常進手動模式', async () => {
    global.window.PR_COST_SCOPE = { isExempt: () => true, ensureExempt: () => Promise.resolve(true), applicantCodeOf: () => 'ME' };
    T.env.live = makeLive({ manual: true });
    signerCalls.length = 0;
    await fire(MANUAL_CHANGE);
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [F.MANUAL_FLOW]);
    assert.strictEqual(signerCalls[0].type, 'enter');
    delete global.window.PR_COST_SCOPE;
  });

  await check('取消手動按「確定」：清掉手動簽核人（交給 leave），改回自動排人', async () => {
    T.env.live = makeLive({ manual: false });
    signerCalls.length = 0;
    await fire(MANUAL_CHANGE);
    assert.deepStrictEqual(
      signerCalls.map((c) => c.type),
      ['leave'],
    );
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);
  });

  await check('指定簽核人視窗按取消且沒選人（PR_MANUAL_MODE.exitManualMode）：取消勾選、清掉手動簽核人、改回自動排人，不跳確認', async () => {
    T.env.live = makeLive({ manual: true });
    signerCalls.length = 0;
    T.env.confirmAnswer = false; // 有跳確認的話會被「取消」擋住
    T.env.accountingCallbacks.length = 0;
    global.window.PR_MANUAL_MODE.exitManualMode();
    await Promise.resolve();
    T.env.accountingCallbacks.splice(0).forEach((cb) => cb());
    T.env.confirmAnswer = true;
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, []);
    assert.deepStrictEqual(
      signerCalls.map((c) => c.type),
      ['leave'],
    );
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);

    T.env.live = makeLive({ manual: false });
    signerCalls.length = 0;
    global.window.PR_MANUAL_MODE.exitManualMode();
    assert.strictEqual(signerCalls.length, 0, '已經是自動就不動');
  });

  await check('不會無限循環：exitManualMode 取消勾選引起的 change 事件直接放行（不再勾回、不再確認）；之後使用者自己取消勾選才再確認', async () => {
    let asked = 0;
    global.Swal = { fire: () => { asked += 1; return Promise.resolve({ isConfirmed: false }); } };
    T.env.live = makeLive({ manual: true });
    global.window.PR_MANUAL_MODE.exitManualMode();
    T.env.accountingCallbacks.length = 0;
    // kintone 在 set() 之後會對勾選欄位再觸發一次 change（這時已是未勾選）
    await fire(MANUAL_CHANGE);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [], '沒有被勾回去');
    assert.strictEqual(asked, 0, '沒有再跳確認');

    T.env.live = makeLive({ manual: false });
    await fire(MANUAL_CHANGE);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.strictEqual(asked, 1, '使用者自己取消勾選：照樣確認一次');
    delete global.Swal;
  });

  await check('kintone 的 set() 也會觸發勾選的 change（值沒變也會）：回音不再開視窗、不確認；視窗按取消改回自動後不會又被勾回去', async () => {
    let asked = 0;
    global.Swal = { fire: () => { asked += 1; return Promise.resolve({ isConfirmed: false }); } };
    global.window.PR_COST_SCOPE = { isExempt: () => true, ensureExempt: () => Promise.resolve(true), applicantCodeOf: () => 'ME' };
    const origSet = global.kintone.app.record.set;
    let sets = 0;
    global.kintone.app.record.set = (r) => {
      origSet(r);
      sets += 1;
      if (sets > 20) assert.fail('set() 停不下來（無限循環）');
      Promise.resolve().then(() => {
        const event = { type: MANUAL_CHANGE, record: clone(T.env.live) };
        T.env.live = clone((T.handlers[MANUAL_CHANGE][0](event) || event).record);
      });
    };
    const settleAll = async () => {
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 5; i++) await Promise.resolve();
        T.env.accountingCallbacks.splice(0).forEach((cb) => cb());
      }
    };

    T.env.live = makeLive({ manual: true });
    signerCalls.length = 0;
    await fire(MANUAL_CHANGE); // 使用者自己勾：開一次視窗；帶會計單位的 set() 回音不再開
    await settleAll();
    assert.deepStrictEqual(signerCalls.map((c) => [c.type, c.opts?.openNow]), [['enter', true]]);

    global.window.PR_MANUAL_MODE.exitManualMode(); // 視窗按取消、沒選人
    await settleAll();
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [], '取消後維持未勾選');
    assert.deepStrictEqual(signerCalls.map((c) => c.type), ['enter', 'leave'], '沒有再進手動、再開視窗');
    assert.strictEqual(asked, 0, '沒有跳「改回自動？」確認');

    global.kintone.app.record.set = origSet;
    delete global.window.PR_COST_SCOPE;
    delete global.Swal;
  });

  await check('有 SweetAlert 時：取消勾選手動用 SweetAlert 確認（先維持勾選，按「改回自動」才取消）；找不到會計單位用 SweetAlert 提示', async () => {
    const swalCalls = [];
    let answer = false;
    global.Swal = {
      fire: (opts) => {
        swalCalls.push(opts);
        return Promise.resolve({ isConfirmed: answer });
      },
    };
    global.confirm = () => assert.fail('不應再用瀏覽器 confirm');
    const settleAll = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      T.env.accountingCallbacks.splice(0).forEach((cb) => cb());
    };

    T.env.live = makeLive({ manual: false });
    signerCalls.length = 0;
    await fire(MANUAL_CHANGE);
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [T.C.OPTIONS.MANUAL_FLOW.ON], '視窗回答前維持勾選');
    await settleAll();
    assert.strictEqual(swalCalls[0].title, '改回系統自動排簽核人員？');
    assert.strictEqual(swalCalls[0].confirmButtonText, '改回自動');
    assert.strictEqual(swalCalls[0].cancelButtonText, '維持手動');
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [T.C.OPTIONS.MANUAL_FLOW.ON], '按維持手動');
    assert.strictEqual(signerCalls.length, 0);

    answer = true;
    T.env.live[F.MANUAL_FLOW].value = [];
    await fire(MANUAL_CHANGE);
    await settleAll();
    assert.deepStrictEqual(T.env.live[F.MANUAL_FLOW].value, [], '按改回自動');
    assert.deepStrictEqual(
      signerCalls.map((c) => c.type),
      ['leave'],
    );
    assert.deepStrictEqual(accountingOf(), ['ACC_TPE']);

    swalCalls.length = 0;
    const saved = T.env.accountingRecord;
    T.env.accountingRecord = undefined;
    const origApi = global.kintone.api;
    global.kintone.api = Object.assign((url, method, params, onOk) => (typeof onOk === 'function' ? onOk({ records: [] }) : origApi(url, method, params)), { url: origApi.url });
    T.env.live = makeLive({ manual: false });
    await fire(ORG_CHANGE);
    assert.ok(swalCalls.some((o) => o.icon === 'warning' && o.title === '找不到對應的會計單位'));
    global.kintone.api = origApi;
    T.env.accountingRecord = saved;
    delete global.Swal;
    global.confirm = () => T.env.confirmAnswer;
  });

  await check('編輯畫面：手動記錄不顯示人數欄位，會計單位承辦人照一般規則（不歸手動管）', () => {
    const r = makeLive({ manual: true });
    T.env.shown = {};
    T.handlers['app.record.edit.show'].forEach((fn) => fn({ type: 'app.record.edit.show', record: r }));
    assert.strictEqual(T.env.shown[COUNT_M], false);
    assert.strictEqual(T.env.shown[COUNT_D], false);
    assert.strictEqual(r[F.ACCOUNTING_STAFF].disabled, undefined, '照一般規則，不歸手動管');
    assert.strictEqual(T.env.shown[F.ACCOUNTING_STAFF], undefined);
  });

  await check('存檔驗證改由 payment_request_submit 呼叫手動簽核人設定：簽核人員程式不再自己擋存檔', () => {
    assert.strictEqual(T.handlers[SUBMIT], undefined);
    assert.strictEqual(T.handlers[`app.record.create.change.${COUNT_M}`], undefined, '人數欄位在手動模式鎖住，不用再跟著顯示欄位');
  });

  console.log = origLog;
  console.error = origErr;
  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
