'use strict';

// 測試：費用所屬人部門變更後，簽核人員怎麼排（signing_personnel_manager 整段流程）
//   - 依「費用所屬人／費用所屬人部門」查職稱、簽核流程主檔、會計對應主檔（不看申請人）
//   - 完整鏈：主檔有值的欄位全部排進來，再依費用所屬人職稱清掉本人那層與以下
//   - 六大簽核流程部門只排部長；台中支店長、總務部長等不排人
//   - 事件：create.show、change.費用所屬人部門
// 直接用 Node 執行：node tests/signing_owner_chain.test.cjs
//
// 作法：載入整支簽核人員程式，kintone API 換成假的（職稱、簽核流程主檔、會計對應主檔），
// 從查資料、排人到寫回畫面整段跑一遍。

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
  const env = { live: {}, shown: {}, apiCalls: [], alerts: [], orgs: {}, master: {}, accountingRecord: null };
  global.window = {};
  global.alert = (m) => env.alerts.push(m);
  global.confirm = () => true;
  const queryName = (q) => (q.match(/簽核流程名稱 = "(.*)"/) || [])[1];
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
        if (url === '/v1/user/organizations.json') {
          return Promise.resolve({ organizationTitles: env.orgs[params.code] || [] });
        }
        const records = params.app === env.C.APPS.ACCOUNTING_MAP ? [env.accountingRecord] : env.master[queryName(params.query)] ? [env.master[queryName(params.query)]] : [];
        if (typeof onOk === 'function') {
          Promise.resolve().then(() => onOk({ records }));
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
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: orgName ? [{ code: 'ORG', name: orgName }] : [] },
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
const fire = (type) => {
  (T.handlers[type] || []).forEach((fn) => {
    const event = { type, record: clone(env.live) };
    const out = fn(event);
    env.live = clone((out || event).record);
  });
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
  // title 給 null＝這個人在該單位沒有職稱（kintone 回 title: null）
  env.orgs = { [owner]: [{ organization: { code: 'ORG', name: orgName, primary: true }, title: title === null ? null : { name: title } }] };
  env.live = makeLive({ orgName, owner });
  fire(eventType);
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

(async () => {
  console.log('signing_owner_chain.test.cjs');
  const origLog = console.log;
  console.log = () => {};
  console.error = () => {};

  await check('事件註冊：create.show 與 新增／編輯的 change.費用所屬人部門 都掛上，沒有舊的申請單位／類型事件', () => {
    ['app.record.create.show', ORG_EVENT, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`].forEach((t) => {
      assert.ok(T.handlers[t]?.length === 1, `缺 ${t}`);
    });
    assert.strictEqual(T.handlers['app.record.create.show'][0].name, 'handleCreateShow', 'create.show 先查排除群組再帶簽核');
    assert.strictEqual(T.handlers[ORG_EVENT][0].name, 'handleExpenseOwnerOrgChange');
    Object.keys(T.handlers).forEach((t) => {
      assert.ok(!/申請單位|員工姓名|類型/.test(t), `不應有舊事件 ${t}`);
    });
  });

  await check('一般員工（課員）：主檔有值的六格全部排進來，人數 主管3／次長2', async () => {
    await run({ orgName: NAME, title: '課員' });
    assert.deepStrictEqual(signers(), { 單位主管1: ['A1'], 單位主管2: ['A2'], 單位主管3: ['A3'], 單位次長: ['D0'], 單位次長1: ['D1'], 單位部長_支店長: ['H'] });
    assert.deepStrictEqual(counts(), ['3人', '2人']);
    SLOTS.forEach((f) => assert.strictEqual(env.shown[f], true, `${f} 應顯示`));
    SLOTS.forEach((f) => assert.strictEqual(env.live[f].disabled, true, `${f} 應鎖住`));
  });

  await check('create.show 開啟新增畫面時也會依預設的費用所屬人／部門排人', async () => {
    await run({ orgName: NAME, title: '課員', eventType: 'app.record.create.show' });
    assert.deepStrictEqual(filledSlots(), SLOTS);
  });

  await check('主檔有的格子才排：沒值的格子清空且隱藏，人數只算有人的', async () => {
    await run({ orgName: NAME, title: '課員', master: masterOf({ 單位主管1: 'A1', 單位主管3: 'A3', 單位次長: 'D0', 單位部長_支店長: 'H' }) });
    assert.deepStrictEqual(filledSlots(), ['單位主管1', '單位主管3', '單位次長', '單位部長_支店長']);
    assert.strictEqual(env.shown['單位主管2'], false);
    assert.strictEqual(env.shown['單位次長1'], false);
    assert.deepStrictEqual(counts(), ['2人', '1人']);
  });

  await check('課長本人在單位主管2：主管1、主管2 清掉，主管3 以上留著，主管人數 3→1', async () => {
    await run({ orgName: NAME, title: '課長', master: masterOf({ ...FULL, 單位主管2: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), ['單位主管3', '單位次長', '單位次長1', '單位部長_支店長']);
    assert.strictEqual(env.shown['單位主管1'], false);
    assert.strictEqual(env.shown['單位主管2'], false);
    assert.deepStrictEqual(counts(), ['1人', '2人']);
  });

  await check('課長本人在單位主管1：只清主管1；不在任何一格：什麼都不清', async () => {
    await run({ orgName: NAME, title: '課長', master: masterOf({ ...FULL, 單位主管1: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), SLOTS.slice(1));
    assert.deepStrictEqual(counts(), ['2人', '2人']);
    await run({ orgName: NAME, title: '課長' });
    assert.deepStrictEqual(filledSlots(), SLOTS);
    assert.deepStrictEqual(counts(), ['3人', '2人']);
  });

  await check('次長本人在單位次長：課長全清、次長清掉自己，剩次長1 與部長；人數 0／1', async () => {
    await run({ orgName: NAME, title: '次長', master: masterOf({ ...FULL, 單位次長: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), ['單位次長1', '單位部長_支店長']);
    assert.deepStrictEqual(counts(), ['0人', '1人']);
  });

  await check('次長本人在單位次長1：次長、次長1 都清掉，剩部長；室長同樣處理', async () => {
    await run({ orgName: NAME, title: '次長', master: masterOf({ ...FULL, 單位次長1: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), ['單位部長_支店長']);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
    await run({ orgName: NAME, title: '室長', master: masterOf({ ...FULL, 單位次長: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), ['單位次長1', '單位部長_支店長']);
  });

  await check('部長／支店長本人：主管、次長全清，只剩部長格，人數 0／0', async () => {
    await run({ orgName: NAME, title: '部長', master: masterOf({ ...FULL, 單位部長_支店長: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), ['單位部長_支店長']);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
    await run({ orgName: NAME, title: '支店長' });
    assert.deepStrictEqual(filledSlots(), ['單位部長_支店長']);
  });

  await check('六大簽核流程部門（總務部）：只查部長欄位、只排部長', async () => {
    await run({ orgName: '總務部', title: '課長', master: masterOf({ 單位部長_支店長: 'H' }) });
    assert.deepStrictEqual(approvalCall().params.fields, ['簽核流程名稱', '請購單位部長']);
    assert.deepStrictEqual(filledSlots(), ['單位部長_支店長']);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
  });

  await check('六大簽核流程部門且職稱合併名稱：航空貨物部的部長以「海運貨物部長/航空貨物部長」查主檔', async () => {
    await run({ orgName: '航空貨物部', title: '部長', queryName: '海運貨物部長/航空貨物部長', master: masterOf({ 單位部長_支店長: 'GM' }) });
    assert.strictEqual(approvalCall().params.query, '簽核流程名稱 = "海運貨物部長/航空貨物部長"');
    assert.deepStrictEqual(signers()['單位部長_支店長'], ['GM']);
    assert.strictEqual(filledSlots().length, 1);
  });

  await check('營業戰略部等需檢查部長的部門：主要職稱是部長時才算六大特殊流程（只查部長欄位）', async () => {
    await run({ orgName: '汽車貨運部', title: '部長', queryName: '物流部長/汽車貨運部長', master: masterOf({ 單位部長_支店長: 'H2' }) });
    assert.deepStrictEqual(approvalCall().params.fields, ['簽核流程名稱', '請購單位部長']);
    assert.deepStrictEqual(filledSlots(), ['單位部長_支店長']);
    await run({ orgName: '汽車貨運部', title: '課員', master: masterOf(FULL) });
    assert.deepStrictEqual(approvalCall().params.fields.length, 7, '課員不是部長，走一般六格查詢');
  });

  await check('新竹營業所-Sales Team：以補完前綴的名稱「航空貨物部-新竹營業所-營業Team」查簽核流程主檔', async () => {
    await run({ orgName: '新竹營業所-Sales Team', title: '課員', queryName: '航空貨物部-新竹營業所-營業Team', master: masterOf(FULL) });
    assert.strictEqual(approvalCall().params.query, '簽核流程名稱 = "航空貨物部-新竹營業所-營業Team"');
    assert.deepStrictEqual(filledSlots(), SLOTS);
  });

  await check('台中支店長／總務部長／事業本部長（isSpecificDirector）：不排任何人，簽核欄位全隱藏', async () => {
    const cases = [
      ['台中營業部', '支店長'],
      ['總務部', '部長'],
      ['事業本部', '部長'],
      ['營業戰略部', '部長'],
    ];
    for (const [orgName, title] of cases) {
      await run({ orgName, title, queryName: orgName === '台中營業部' ? orgName : '安全品質推動部長/營業戰略部長/總務部長/事業本部長', master: masterOf(FULL) });
      assert.deepStrictEqual(filledSlots(), [], `${orgName}/${title} 不該排人`);
      SLOTS.forEach((f) => assert.strictEqual(env.shown[f], false, `${orgName}/${title}：${f} 應隱藏`));
      assert.deepStrictEqual(counts(), ['', ''], '人數欄位不動');
    }
  });

  await check('沒有職稱（title 是 null）：不清任何一層，主檔有值的六格全部排上', async () => {
    await run({ orgName: NAME, title: null });
    assert.deepStrictEqual(filledSlots(), SLOTS);
    assert.deepStrictEqual(counts(), ['3人', '2人']);
    assert.strictEqual(approvalCall().params.query, `簽核流程名稱 = "${NAME}"`);
  });

  await check('沒有職稱且費用所屬人自己就在主管格：照樣全部排上（沒有職稱就不清）', async () => {
    await run({ orgName: NAME, title: null, master: masterOf({ ...FULL, 單位主管2: 'OWN' }) });
    assert.deepStrictEqual(filledSlots(), SLOTS);
  });

  await check('費用所屬人不屬於這個部門（部門鎖住，只會發生在複製別人的單）：不跳 alert、不排人，等重新帶入部門', async () => {
    env.orgs = { OWN: [{ organization: { code: 'X', name: '別的部門', primary: true }, title: { name: '課長' } }] };
    env.master = { [NAME]: masterOf(FULL) };
    env.apiCalls.length = 0;
    env.alerts.length = 0;
    env.live = makeLive({ orgName: NAME });
    const origWarn = console.warn;
    const warns = [];
    console.warn = (m) => warns.push(m);
    fire(ORG_EVENT);
    await settle();
    console.warn = origWarn;
    assert.strictEqual(env.alerts.length, 0, '部門不能手選，不再叫使用者去選部門');
    assert.ok(warns.some((m) => /不是費用所屬人的所屬單位/.test(m)), warns.join('\n'));
    assert.deepStrictEqual(filledSlots(), []);
    assert.strictEqual(approvalCall(), undefined, '沒查簽核流程主檔');
  });

  await check('簽核流程主檔查不到這個部門：不排人、不跳錯誤', async () => {
    await run({ orgName: NAME, title: '課員', master: null });
    assert.deepStrictEqual(filledSlots(), []);
    assert.strictEqual(env.alerts.length, 0);
  });

  await check('依費用所屬人查職稱與主檔，不看申請人；會計單位依費用所屬人部門名稱查', async () => {
    await run({ orgName: NAME, title: '課員' });
    const orgCall = env.apiCalls.find((c) => c.url === '/v1/user/organizations.json');
    assert.deepStrictEqual(orgCall.params, { code: 'OWN' }, '職稱要用費用所屬人的代碼，不是申請人 APPLICANT');
    const acc = env.apiCalls.find((c) => c.params.app === C.APPS.ACCOUNTING_MAP);
    assert.ok(acc, '要查會計對應主檔');
    assert.strictEqual(acc.params.query, `${C.REF_FIELDS.ACCOUNTING_MAP.APPLY_UNIT} in ("${NAME}")`);
    assert.strictEqual(approvalCall().params.app, C.APPS.APPROVAL_FLOW);
    assert.deepStrictEqual(env.live[F.ACCOUNTING_UNIT].value.map((g) => g.code), ['ACC_TPE']);
    assert.deepStrictEqual(env.live[F.APPLICANT].value.map((u) => u.code), ['APPLICANT'], '申請人欄位不被動到');
  });

  await check('清空費用所屬人部門：簽核人員與會計單位清空，也不查職稱', async () => {
    env.apiCalls.length = 0;
    env.live = makeLive({ orgName: NAME });
    SLOTS.forEach((f) => (env.live[f].value = [U('OLD')]));
    env.live[F.ACCOUNTING_UNIT].value = [{ code: 'ACC_TPE', name: 'ACC_TPE' }];
    env.live[F.EXPENSE_OWNER_ORG].value = [];
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(filledSlots(), []);
    assert.deepStrictEqual(env.live[F.ACCOUNTING_UNIT].value, []);
    assert.strictEqual(env.apiCalls.length, 0);
  });

  await check('費用所屬人沒填但部門有值：會計單位照帶，不查職稱也不排人', async () => {
    env.apiCalls.length = 0;
    env.master = { [NAME]: masterOf(FULL) };
    env.live = makeLive({ orgName: NAME, owner: null });
    fire(ORG_EVENT);
    await settle();
    assert.strictEqual(env.apiCalls.filter((c) => c.url === '/v1/user/organizations.json').length, 0);
    assert.deepStrictEqual(env.live[F.ACCOUNTING_UNIT].value.map((g) => g.code), ['ACC_TPE']);
    assert.deepStrictEqual(filledSlots(), []);
  });

  await check('原始檔只讀費用所屬人／費用所屬人部門，沒有舊欄位與舊 config 鍵', () => {
    const src = readSrc('signing_personnel_manager_20260506.js');
    [/F\.TYPE/, /F\.APPLY_UNIT/, /F\.EMPLOYEE_NAME/, /ENT_SIGN/, /SLOT3/, /APPLICANT_SWITCH/, /AUTO_CHAIN_TYPES/, /app\.record\.[a-z]+\.change\.申請單位/].forEach((re) => {
      assert.ok(!re.test(src), `不應再出現 ${re}`);
    });
    assert.ok(/F\.EXPENSE_OWNER_ORG/.test(src) && /F\.EXPENSE_OWNER\b/.test(src));
  });

  console.log = origLog;
  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  console.log = console.info;
  console.error = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.error(err);
  process.exit(1);
});
