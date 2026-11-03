'use strict';

// 測試：簽核注意 (3)(4) —— 申請人在「費用歸屬不限部門」群組 → 新增時自動切手動設定簽核流程（簽核人員自選）；
//   手動模式下改費用所屬人／部門不重排、不蓋掉自選的簽核人員，只帶會計單位承辦人。
// 單獨執行：node tests/signing_exempt_manual.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));

const SLOTS = ['單位主管1', '單位主管2', '單位主管3', '單位次長', '單位次長1', '單位部長_支店長'];
const API_OF = {
  單位主管1: '請購單位主管1',
  單位主管2: '請購單位主管2',
  單位主管3: '請購單位主管3',
  單位次長: '請購單位次長',
  單位次長1: '請購單位次長1',
  單位部長_支店長: '請購單位部長',
};
const COUNT_M = '部門主管簽核人數';
const COUNT_D = '部門次長簽核人數';
const U = (code) => ({ code, name: code });

const loadSigning = () => {
  const handlers = {};
  const env = { live: {}, shown: {}, apiCalls: [], alerts: [], orgs: {}, master: {}, accountingRecord: null, groups: {} };
  global.window = {};
  global.alert = (m) => env.alerts.push(m);
  global.confirm = () => true;
  // 特殊簽核流程用名稱查、其他用組織代碼查「簽核所屬單位」；假主檔用查詢鍵（名稱或組織代碼）對應
  const queryName = (q) => (q.match(/簽核流程名稱 = "(.*)"/) || q.match(/簽核所屬單位 in \("(.*?)"\)/) || [])[1];
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
    getLoginUser: () => ({ code: 'x' }),
    events: {
      on: (types, fn) => {
        [].concat(types).forEach((t) => {
          (handlers[t] = handlers[t] || []).push(fn);
        });
      },
    },
    api: Object.assign(
      (url, method, params, onOk) => {
        env.apiCalls.push({ url, params });
        if (url === '/v1/organizations.json') return Promise.resolve({ organizations: [] });
        if (url === '/v1/user/groups.json') {
          return Promise.resolve({ groups: (env.groups[params.code] || []).map((name) => ({ code: name, name })) });
        }
        if (url === '/v1/user/organizations.json') {
          return Promise.resolve({ organizationTitles: env.orgs[params.code] || [] });
        }
        const records = params.app === env.C.APPS.ACCOUNTING_MAP ? [env.accountingRecord] : env.master[queryName(params.query)] ? [env.master[queryName(params.query)]] : [];
        if (typeof onOk === 'function') {
          setTimeout(() => onOk({ records }), 0); // 網路回應一定晚於 show 事件結束
          return undefined;
        }
        return Promise.resolve({ records });
      },
      { url: (p) => p },
    ),
  };
  // eslint-disable-next-line no-eval
  eval(readSrc('payment_request_config.js'));
  env.C = global.window.PR_CONFIG;
  // eslint-disable-next-line no-eval
  eval(readSrc('費用歸屬部門限制_20261022.js'));
  // eslint-disable-next-line no-eval
  eval(readSrc('signing_personnel_manager_20260506.js'));
  const ACC = env.C.REF_FIELDS.ACCOUNTING_MAP;
  env.accountingRecord = { [ACC.APPLY_UNIT]: { value: 'U' }, [ACC.ACCOUNTING_UNIT]: { value: 'ACC_TPE' }, [ACC.ACCOUNTING_STAFF]: { value: [] }, [ACC.PERMISSION_USER]: { value: [] } };
  return { env, handlers };
};

const T = loadSigning();
const { env } = T;
const C = env.C;
const F = C.FIELDS;
const ORG_EVENT = `app.record.create.change.${F.EXPENSE_OWNER_ORG}`;

/** 簽核流程主檔的一筆：給 { 單位主管1: 'A1', ... }，沒給的格子是空的 */
const masterOf = (people) => {
  const rec = { 簽核流程名稱: { value: 'X' } };
  SLOTS.forEach((slot) => {
    rec[API_OF[slot]] = { value: people[slot] ? [U(people[slot])] : [] };
  });
  return rec;
};
const FULL = { 單位主管1: 'A1', 單位主管2: 'A2', 單位主管3: 'A3', 單位次長: 'D0', 單位次長1: 'D1', 單位部長_支店長: 'H' };

const makeLive = ({ orgName, owner = 'OWN' }) => {
  const r = {
    [F.APPLICANT]: { type: 'USER_SELECT', value: [U('APPLICANT')] },
    [F.EXPENSE_OWNER]: { type: 'USER_SELECT', value: owner ? [U(owner)] : [] },
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: orgName ? [{ code: orgName, name: orgName }] : [] },
    [F.MANUAL_FLOW]: { type: 'CHECK_BOX', value: [] },
    [F.ACCOUNTING_UNIT]: { type: 'GROUP_SELECT', value: [] },
    [F.ACCOUNTING_STAFF]: { type: 'USER_SELECT', value: [] },
    [F.PERMISSION_STAFF]: { type: 'USER_SELECT', value: [] },
    [COUNT_M]: { value: '' },
    [COUNT_D]: { value: '' },
  };
  SLOTS.forEach((f) => (r[f] = { type: 'USER_SELECT', value: [] }));
  return r;
};

/** 在目前的畫面資料上依序跑某個事件的所有處理函式，kintone 會把 event.record 套回畫面 */
const fire = async (type) => {
  for (const fn of T.handlers[type] || []) {
    const event = { type, record: clone(env.live) };
    const out = await fn(event);
    env.live = clone((out || event).record);
  }
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * 設定費用所屬人（OWN）在 orgName 的職稱與簽核流程主檔，觸發費用所屬人部門變更。
 * @param {{orgName:string, title:string, queryName?:string, master?:Object|null}} o
 */
const run = async ({ orgName, title, queryName = orgName, master = masterOf(FULL), owner = 'OWN', eventType = ORG_EVENT }) => {
  env.apiCalls.length = 0;
  env.alerts.length = 0;
  env.shown = {};
  env.master = master ? { [queryName]: master } : {};
  env.orgs = { [owner]: [{ organization: { code: orgName, name: orgName, primary: true }, title: { name: title } }] };
  env.live = makeLive({ orgName, owner });
  await fire(eventType);
  await settle();
};
const signers = () => {
  const out = {};
  SLOTS.forEach((f) => (out[f] = env.live[f].value.map((u) => u.code)));
  return out;
};
const filledSlots = () => SLOTS.filter((f) => env.live[f].value.length > 0);
const counts = () => [env.live[COUNT_M].value, env.live[COUNT_D].value];
const approvalCall = () => env.apiCalls.find((c) => c.params.app === C.APPS.APPROVAL_FLOW);

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`  ok - ${label}\n`);
};

const NAME = '航空貨物部-台北營業課';
const CREATE = 'app.record.create.show';
const manualOn = () => env.live[F.MANUAL_FLOW].value.length > 0;

(async () => {
  console.log('signing_exempt_manual.test.cjs');
  const origLog = console.log;
  console.log = () => {};
  console.error = () => {};

  await check('一般申請人新增：不切手動，照簽核流程主檔排人', async () => {
    env.groups = {};
    await run({ orgName: NAME, title: '一般', eventType: CREATE });
    assert.strictEqual(manualOn(), false);
    assert.deepStrictEqual(filledSlots(), SLOTS);
    assert.ok(env.apiCalls.some((c) => c.url === '/v1/user/groups.json' && c.params.code === 'APPLICANT'));
  });

  await check('排除群組的申請人新增：自動勾手動設定簽核流程，原本的簽核欄位清空鎖住、不查簽核流程主檔', async () => {
    env.groups = { APPLICANT: ['費用歸屬不限部門'] };
    global.window.PR_COST_SCOPE._reset(); // 模擬重新開頁（同一申請人的群組結果會快取）
    const enterCalls = [];
    global.window.PR_MANUAL_SIGNERS = { signersOf: () => [null, null, null], enter: (r, opts) => enterCalls.push(opts), leave: () => {} };
    await run({ orgName: NAME, title: '一般', eventType: CREATE });
    delete global.window.PR_MANUAL_SIGNERS;
    assert.deepStrictEqual(enterCalls, [{ openNow: false }], '開新增畫面不直接跳「指定簽核人」視窗，要按「設定簽核人」');
    assert.strictEqual(manualOn(), true);
    assert.deepStrictEqual(filledSlots(), []);
    assert.strictEqual(approvalCall(), undefined, '手動模式不排人');
    assert.strictEqual(env.live[COUNT_M].value, '0人');
    assert.strictEqual(env.live[COUNT_M].disabled, true, '手動模式不用人數欄位，鎖住');
    assert.strictEqual(env.live['單位部長_支店長'].disabled, true, '原本的 6 格不用，鎖住');
    assert.strictEqual(env.shown[F.ACCOUNTING_UNIT], false, '手動模式不顯示會計單位');
    assert.deepStrictEqual(env.live[F.ACCOUNTING_UNIT].value, []);
    assert.ok(env.apiCalls.some((c) => c.params?.app === C.APPS.ACCOUNTING_MAP), '仍帶入會計單位承辦人／權限開放人員');
  });

  await check('排除群組的申請人新增：之後帶會計單位的 set() 觸發勾選 change（kintone 值沒變也會觸發），也不跳「指定簽核人」視窗', async () => {
    env.groups = { APPLICANT: ['費用歸屬不限部門'] };
    global.window.PR_COST_SCOPE._reset();
    const enterCalls = [];
    global.window.PR_MANUAL_SIGNERS = { signersOf: () => [null, null, null], enter: (r, opts) => enterCalls.push(opts), leave: () => {} };
    const MANUAL_EVENT = `app.record.create.change.${F.MANUAL_FLOW}`;
    const origSet = global.kintone.app.record.set;
    global.kintone.app.record.set = (r) => {
      origSet(r);
      setTimeout(() => {
        T.handlers[MANUAL_EVENT].forEach((fn) => {
          const event = { type: MANUAL_EVENT, record: clone(env.live) };
          env.live = clone((fn(event) || event).record);
        });
      }, 0);
    };
    await run({ orgName: NAME, title: '一般', eventType: CREATE });
    await settle();
    global.kintone.app.record.set = origSet;
    delete global.window.PR_MANUAL_SIGNERS;
    assert.ok(env.apiCalls.some((c) => c.params?.app === C.APPS.ACCOUNTING_MAP), '確實有帶會計單位（會 set()）');
    assert.deepStrictEqual(enterCalls, [{ openNow: false }], 'set() 的回音不當成使用者勾選');
    assert.strictEqual(manualOn(), true);
  });

  await check('手動模式下改費用所屬人部門：不重排、不清掉自選的簽核人員', async () => {
    env.groups = {};
    env.apiCalls.length = 0;
    env.master = { [NAME]: masterOf(FULL) };
    env.orgs = { OWN: [{ organization: { code: 'ORG', name: NAME, primary: true }, title: { name: '一般' } }] };
    env.live = makeLive({ orgName: NAME });
    env.live[F.MANUAL_FLOW].value = [C.OPTIONS.MANUAL_FLOW.ON];
    env.live['單位部長_支店長'].value = [U('SELF_PICK')];
    await fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(env.live['單位部長_支店長'].value.map((u) => u.code), ['SELF_PICK']);
    assert.strictEqual(approvalCall(), undefined);
  });

  await check('排人的 API 回來前使用者才勾手動：不蓋掉', async () => {
    env.groups = {};
    env.apiCalls.length = 0;
    env.master = { [NAME]: masterOf(FULL) };
    env.orgs = { OWN: [{ organization: { code: 'ORG', name: NAME, primary: true }, title: { name: '一般' } }] };
    env.live = makeLive({ orgName: NAME });
    await fire(ORG_EVENT); // 先送出查詢（職稱 → 簽核流程主檔）
    env.live[F.MANUAL_FLOW].value = [C.OPTIONS.MANUAL_FLOW.ON]; // 查詢回來前勾了手動
    await settle();
    assert.ok(approvalCall(), '查詢確實送出了，是寫回前的檢查擋下');
    assert.deepStrictEqual(filledSlots(), []);
  });

  console.log = origLog;
  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
