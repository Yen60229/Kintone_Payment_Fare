'use strict';

// 測試：改「費用所屬人」後自動帶入「費用所屬人部門」並重排簽核人員（所有人適用，不需開關）
//   查 /v1/user/organizations.json：
//     - 0 個單位：Swal 警告「此費用所屬人沒有所屬單位」，不改部門
//     - 1 個單位：直接帶入
//     - 多個單位：跳 radio 視窗選（主要單位排第一並預選、職稱附在後面），按取消保留原本的部門
//   帶入後依新的人與部門重排簽核人員；連續快速改人時只讓最後一次結果寫回。
// 直接用 Node 執行：node tests/expense_owner_switch.test.cjs
//
// 作法：載入整支簽核人員程式，kintone／Swal 換成假的，從 change 事件一路跑到簽核流程主檔查詢。

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
// 正規化行尾：repo 內 LF／CRLF 混用，regex 擷取需先統一
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8').replace(/\r\n/g, '\n');
const clone = (o) => JSON.parse(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (code, name = code) => ({ code, name });

const org = (code, name, title, primary = false) => ({ organization: { code, name, primary }, title: title ? { name: title } : null });
const ORG_A = org('A', '物流部-業務企劃課', '課長');
const ORG_B = org('B', '總務部-資訊課', '課員', true);
const ORG_C = org('C', '總務部', '課員');
const ORGS = [ORG_A, ORG_B, ORG_C];

const loadSigning = () => {
  const handlers = {};
  const env = {
    live: {},
    apiCalls: [],
    alerts: [],
    swalCalls: [],
    setCount: 0,
    orgs: {},
    orgDelay: {},
    swalAnswer: { isConfirmed: false },
    swalDelay: 0,
  };
  global.window = {};
  global.alert = (m) => env.alerts.push(m);
  global.confirm = () => true;
  const fakeSwal = {
    fire: async (opts) => {
      env.swalCalls.push(opts);
      if (env.swalDelay) await wait(env.swalDelay);
      return env.swalAnswer;
    },
  };
  env.useSwal = (on) => {
    if (on) global.Swal = fakeSwal;
    else delete global.Swal;
  };
  global.kintone = {
    app: {
      getId: () => 749,
      record: {
        get: () => ({ record: clone(env.live) }),
        set: (r) => {
          env.setCount += 1;
          env.live = clone(r.record);
        },
        setFieldShown: () => {},
        setGroupFieldOpen: () => {},
      },
    },
    getLoginUser: () => ({ code: 'x' }),
    events: {
      on: (types, fn) => {
        [].concat(types).forEach((t) => {
          handlers[t] = fn;
        });
      },
    },
    api: Object.assign(
      (url, method, params, onOk) => {
        env.apiCalls.push({ url, params });
        if (url === '/v1/user/organizations.json') {
          return wait(env.orgDelay[params.code] || 0).then(() => ({ organizationTitles: env.orgs[params.code] || [] }));
        }
        const records = params.app === env.C.APPS.ACCOUNTING_MAP ? [env.accountingRecord] : [];
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
const OWNER_EVENT = `app.record.create.change.${F.EXPENSE_OWNER}`;
const handler = T.handlers[OWNER_EVENT];

const SLOTS = ['單位主管1', '單位主管2', '單位主管3', '單位次長', '單位次長1', '單位部長_支店長'];
const reset = ({ useSwal = true, swalAnswer = { isConfirmed: false }, swalDelay = 0 } = {}) => {
  env.apiCalls.length = 0;
  env.alerts.length = 0;
  env.swalCalls.length = 0;
  env.setCount = 0;
  env.orgs = {};
  env.orgDelay = {};
  env.swalAnswer = swalAnswer;
  env.swalDelay = swalDelay;
  env.useSwal(useSwal);
  env.live = {
    [F.EXPENSE_OWNER]: { type: 'USER_SELECT', value: [] },
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: [{ code: 'OLD', name: '原部門' }] },
    [F.MANUAL_FLOW]: { type: 'CHECK_BOX', value: [] },
    [F.ACCOUNTING_UNIT]: { type: 'GROUP_SELECT', value: [] },
    [F.ACCOUNTING_STAFF]: { type: 'USER_SELECT', value: [] },
    [F.PERMISSION_STAFF]: { type: 'USER_SELECT', value: [] },
    部門主管簽核人數: { value: '' },
    部門次長簽核人數: { value: '' },
  };
  SLOTS.forEach((f) => (env.live[f] = { type: 'USER_SELECT', value: [] }));
};
const changeEvent = (code, name = code) => {
  const record = clone(env.live);
  record[F.EXPENSE_OWNER].value = code ? [U(code, name)] : [];
  env.live[F.EXPENSE_OWNER].value = record[F.EXPENSE_OWNER].value;
  return { record };
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await wait(0);
};
const orgValue = () => env.live[F.EXPENSE_OWNER_ORG].value;
const approvalQueries = () => env.apiCalls.filter((c) => c.params.app === C.APPS.APPROVAL_FLOW).map((c) => c.params.query);

// 純函式 buildOwnerOrgOptions 從原始檔擷取
const optionsSrc = readSrc('signing_personnel_manager_20260506.js').match(/const buildOwnerOrgOptions = \(orgs\) => \{[\s\S]*?\n  \};/);
assert.ok(optionsSrc, '找不到 buildOwnerOrgOptions，來源檔可能已改結構，請同步更新本測試');
const buildOwnerOrgOptions = new Function(`${optionsSrc[0]}\nreturn buildOwnerOrgOptions;`)();

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`  ok - ${label}\n`);
};

(async () => {
  console.log('expense_owner_switch.test.cjs');
  const origLog = console.log;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};

  await check('事件註冊：新增、編輯畫面的費用所屬人 change 都掛上同一支；沒有申請人（員工姓名）事件', () => {
    assert.strictEqual(typeof handler, 'function');
    assert.strictEqual(T.handlers[`app.record.edit.change.${F.EXPENSE_OWNER}`], handler);
    Object.keys(T.handlers).forEach((t) => assert.ok(!/員工姓名/.test(t)));
  });

  await check('不需要任何開關：config 已無 APPLICANT_SWITCH，而且對所有登入者生效', async () => {
    assert.strictEqual(C.APPLICANT_SWITCH, undefined);
    reset({ useSwal: false });
    env.orgs.u1 = [ORG_A];
    handler(changeEvent('u1'));
    await flush();
    assert.deepStrictEqual(orgValue(), [U('A', ORG_A.organization.name)]);
  });

  await check('選單選項：部門名稱附職稱、主要單位有標示且預先選好；沒有主要單位時預選第一個', () => {
    const { options, defaultIndex } = buildOwnerOrgOptions([ORG_A, ORG_B, org('C', '總務部', null)]);
    assert.deepStrictEqual(options, { 0: '物流部-業務企劃課（課長）', 1: '總務部-資訊課（課員）　★主要單位', 2: '總務部' });
    assert.strictEqual(defaultIndex, '1');
    assert.strictEqual(buildOwnerOrgOptions([org('X', 'X'), org('Y', 'Y')]).defaultIndex, '0');
    assert.strictEqual(buildOwnerOrgOptions([org('Y', 'Y', null, false), org('Z', 'Z', '課長', true)]).defaultIndex, '1');
  });

  await check('change 事件同步回傳 event（不是 async）', () => {
    reset();
    env.orgs.u1 = [ORG_A];
    const ev = changeEvent('u1');
    const out = handler(ev);
    assert.strictEqual(out, ev);
    assert.ok(!(out instanceof Promise));
  });

  await check('清空費用所屬人：不查單位，費用所屬人部門跟著清空（部門只依費用所屬人帶入），簽核與會計單位清空', async () => {
    reset();
    env.live[SLOTS[0]].value = [U('m1')];
    env.live[F.ACCOUNTING_UNIT].value = [{ code: 'ACC_TPE', name: 'ACC_TPE' }];
    const out = handler(changeEvent(null));
    await flush();
    assert.strictEqual(env.apiCalls.length, 0);
    assert.strictEqual(env.setCount, 0, '直接改 event.record，不用 set()');
    assert.deepStrictEqual(out.record[F.EXPENSE_OWNER_ORG].value, []);
    assert.deepStrictEqual(out.record[SLOTS[0]].value, []);
    assert.deepStrictEqual(out.record[F.ACCOUNTING_UNIT].value, []);
  });

  await check('清空費用所屬人時，還在查的上一次結果不再寫回', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    env.orgDelay.u1 = 20;
    handler(changeEvent('u1'));
    handler(changeEvent(null));
    await wait(40);
    await flush();
    assert.deepStrictEqual(orgValue(), [U('OLD', '原部門')], 'live 沒被慢回來的 u1 結果蓋掉');
    assert.strictEqual(env.setCount, 0);
  });

  await check('0 個單位（有 Swal）：警告「此費用所屬人沒有所屬單位」，部門不動、不重排', async () => {
    reset();
    env.orgs.u3 = [];
    handler(changeEvent('u3'));
    await flush();
    assert.strictEqual(env.swalCalls.length, 1);
    assert.strictEqual(env.swalCalls[0].icon, 'warning');
    assert.strictEqual(env.swalCalls[0].title, '此費用所屬人沒有所屬單位');
    assert.match(env.swalCalls[0].text, /改選其他費用所屬人/);
    assert.ok(!/手動選/.test(env.swalCalls[0].text), '部門已鎖住，不能再叫使用者手動選部門');
    assert.deepStrictEqual(orgValue(), [U('OLD', '原部門')]);
    assert.strictEqual(env.setCount, 0);
    assert.strictEqual(approvalQueries().length, 0);
  });

  await check('0 個單位（沒有 Swal）：退回用 alert 提醒', async () => {
    reset({ useSwal: false });
    env.orgs.u3 = [];
    handler(changeEvent('u3'));
    await flush();
    assert.strictEqual(env.alerts.length, 1);
    assert.match(env.alerts[0], /此費用所屬人沒有所屬單位/);
    assert.deepStrictEqual(orgValue(), [U('OLD', '原部門')]);
  });

  await check('1 個單位：不跳視窗，直接帶入費用所屬人部門並重排（查會計單位與簽核流程主檔）', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    handler(changeEvent('u1'));
    await flush();
    assert.deepStrictEqual(env.apiCalls[0], { url: '/v1/user/organizations.json', params: { code: 'u1' } });
    assert.strictEqual(env.swalCalls.length, 0);
    assert.deepStrictEqual(orgValue(), [U('A', '物流部-業務企劃課')]);
    assert.deepStrictEqual(approvalQueries(), ['簽核流程名稱 = "物流部-業務企劃課"'], '帶入後用新部門重排');
    assert.deepStrictEqual(env.live[F.ACCOUNTING_UNIT].value.map((g) => g.code), ['ACC_TPE']);
  });

  await check('帶入部門時一併重算公司名稱（程式寫入不會觸發 change，改呼叫 main 的 PR_COMPANY_NAME.apply），和部門同一次寫回', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    const applied = [];
    global.window.PR_COMPANY_NAME = {
      apply: (record) => {
        applied.push(record[F.EXPENSE_OWNER_ORG].value[0].code);
        record[F.COMPANY_NAME] = { type: 'DROP_DOWN', value: '推導結果', disabled: true };
      },
    };
    try {
      handler(changeEvent('u1'));
      await flush();
      assert.deepStrictEqual(applied, ['A'], '用新帶入的部門推導');
      assert.strictEqual(env.live[F.COMPANY_NAME].value, '推導結果');
    } finally {
      delete global.window.PR_COMPANY_NAME;
    }
  });

  await check('多個單位：跳 radio 視窗（主要單位預選、職稱附註），選哪個就帶哪個並用它重排；原部門不是新費用所屬人的單位 → 不給取消', async () => {
    reset({ swalAnswer: { isConfirmed: true, value: '2' } });
    env.orgs.u2 = ORGS;
    handler(changeEvent('u2', '王小明'));
    await flush();
    assert.strictEqual(env.swalCalls.length, 1);
    const opts = env.swalCalls[0];
    assert.strictEqual(opts.input, 'radio');
    assert.strictEqual(opts.inputValue, '1', '預選主要單位');
    assert.strictEqual(opts.showCancelButton, false, '部門鎖住，不能留著別人的部門');
    assert.strictEqual(opts.allowEscapeKey, false);
    assert.strictEqual(opts.inputOptions[1], '總務部-資訊課（課員）　★主要單位');
    assert.strictEqual(opts.title, '請選擇費用所屬人部門');
    assert.match(opts.text, /王小明 有 3 個所屬單位，簽核人員會依選的部門排/);
    assert.deepStrictEqual(orgValue(), [U('C', '總務部')]);
    assert.deepStrictEqual(approvalQueries(), ['簽核流程名稱 = "總務部"']);
  });

  await check('多個單位、原部門也是新費用所屬人的單位 → 可以取消保留', async () => {
    reset({ swalAnswer: { isConfirmed: true, value: '2' } });
    env.orgs.u2 = ORGS;
    env.live[F.EXPENSE_OWNER_ORG].value = [U('B', '總務部-資訊課')];
    handler(changeEvent('u2'));
    await flush();
    assert.strictEqual(env.swalCalls[0].showCancelButton, true);
    assert.match(env.swalCalls[0].cancelButtonText, /保留原本的部門/);
  });

  await check('程式帶入的部門保持鎖住（disabled）', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    handler(changeEvent('u1'));
    await flush();
    assert.strictEqual(env.live[F.EXPENSE_OWNER_ORG].disabled, true);
  });

  await check('多個單位、沒有 Swal：直接帶主要單位', async () => {
    reset({ useSwal: false });
    env.orgs.u2 = ORGS;
    handler(changeEvent('u2'));
    await flush();
    assert.deepStrictEqual(orgValue(), [U('B', '總務部-資訊課')]);
  });

  await check('多個單位按取消（原部門也是他的單位）：費用所屬人部門保留原值、不寫回、不重排', async () => {
    reset({ swalAnswer: { isConfirmed: false } });
    env.orgs.u2 = [...ORGS, org('OLD', '原部門', '課員')];
    handler(changeEvent('u2'));
    await flush();
    assert.strictEqual(env.swalCalls.length, 1);
    assert.strictEqual(env.setCount, 0);
    assert.deepStrictEqual(orgValue(), [U('OLD', '原部門')]);
    assert.strictEqual(approvalQueries().length, 0);
    assert.strictEqual(env.apiCalls.filter((c) => c.params.app === C.APPS.ACCOUNTING_MAP).length, 0);
  });

  await check('連續改兩次費用所屬人（先改的查得慢）：只採用最後一次的結果寫回', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    env.orgs.u4 = [ORG_C];
    env.orgDelay.u1 = 30;
    handler(changeEvent('u1'));
    handler(changeEvent('u4'));
    await wait(60);
    await flush();
    assert.deepStrictEqual(orgValue(), [U('C', '總務部')], '慢的第一次不可蓋掉最後一次');
    assert.deepStrictEqual(approvalQueries(), ['簽核流程名稱 = "總務部"']);
  });

  await check('第一次正在等使用者選視窗時又改了人：第一次的選擇不再寫回', async () => {
    reset({ swalAnswer: { isConfirmed: true, value: '0' }, swalDelay: 30 });
    env.orgs.u2 = ORGS;
    env.orgs.u4 = [ORG_C];
    handler(changeEvent('u2'));
    await wait(5);
    handler(changeEvent('u4'));
    await wait(60);
    await flush();
    assert.deepStrictEqual(orgValue(), [U('C', '總務部')]);
    assert.deepStrictEqual(approvalQueries(), ['簽核流程名稱 = "總務部"']);
  });

  await check('查詢失敗：只記錄錯誤，不寫回、不跳例外', async () => {
    reset();
    const realApi = global.kintone.api;
    global.kintone.api = Object.assign(() => Promise.reject(new Error('boom')), { url: (p) => p });
    handler(changeEvent('u1'));
    await flush();
    global.kintone.api = realApi;
    assert.deepStrictEqual(orgValue(), [U('OLD', '原部門')]);
    assert.strictEqual(env.setCount, 0);
  });

  // ── 新增畫面：費用所屬人有值、部門空白 → 自動帶部門 ──
  const showHandler = T.handlers['app.record.create.show'];
  const showEvent = (ownerCode, orgVal) => {
    env.live[F.EXPENSE_OWNER].value = ownerCode ? [U(ownerCode)] : [];
    env.live[F.EXPENSE_OWNER_ORG].value = orgVal;
    return { record: clone(env.live) };
  };

  await check('create.show：有費用所屬人、部門空白、只有 1 個單位 → 直接帶入部門並重排簽核（同步回傳 event）', async () => {
    reset({ useSwal: false });
    env.orgs.u1 = [ORG_A];
    const ev = showEvent('u1', []);
    const out = showHandler(ev);
    assert.strictEqual(out, ev);
    await flush();
    assert.deepStrictEqual(orgValue(), [U('A', ORG_A.organization.name)]);
    assert.ok(env.apiCalls.some((c) => c.url === '/v1/user/organizations.json' && c.params.code === 'u1'));
    assert.deepStrictEqual(approvalQueries(), [`簽核流程名稱 = "${ORG_A.organization.name}"`]);
  });

  await check('create.show：多個單位 → 跳視窗選，選了才帶入', async () => {
    reset({ swalAnswer: { isConfirmed: true, value: '2' } });
    env.orgs.u2 = ORGS;
    showHandler(showEvent('u2', []));
    await flush();
    assert.strictEqual(env.swalCalls.length, 1);
    assert.strictEqual(env.swalCalls[0].title, '請選擇費用所屬人部門');
    assert.deepStrictEqual(orgValue(), [U('C', '總務部')]);
  });

  await check('create.show：部門空白、多個單位 → 視窗不給取消；萬一沒選（視窗被關掉）部門維持空白', async () => {
    reset({ swalAnswer: { isConfirmed: false } });
    env.orgs.u2 = ORGS;
    showHandler(showEvent('u2', []));
    await flush();
    assert.strictEqual(env.swalCalls[0].showCancelButton, false);
    assert.deepStrictEqual(orgValue(), []);
  });

  await check('create.show：0 個單位 → 警告、部門不動', async () => {
    reset();
    env.orgs.u3 = [];
    showHandler(showEvent('u3', []));
    await flush();
    assert.strictEqual(env.swalCalls.length, 1);
    assert.strictEqual(env.swalCalls[0].title, '此費用所屬人沒有所屬單位');
    assert.deepStrictEqual(orgValue(), []);
  });

  await check('create.show：部門已有值且是費用所屬人的單位 → 不跳視窗、維持現狀', async () => {
    reset({ swalAnswer: { isConfirmed: true, value: '2' } });
    env.orgs.u1 = ORGS;
    showHandler(showEvent('u1', [U('B', '總務部-資訊課')]));
    await flush();
    assert.strictEqual(env.swalCalls.length, 0, '不該跳選部門視窗');
    assert.strictEqual(env.setCount > 0, true, '照原部門排簽核');
    assert.deepStrictEqual(orgValue(), [U('B', '總務部-資訊課')]);
  });

  await check('create.show：部門不是費用所屬人的單位（例如複製別人的單）→ 重新帶入（1 個單位直接帶、多個跳視窗且不給取消）', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    showHandler(showEvent('u1', [U('OLD', '原部門')]));
    await flush();
    assert.deepStrictEqual(orgValue(), [U('A', ORG_A.organization.name)]);
    assert.ok(approvalQueries().includes(`簽核流程名稱 = "${ORG_A.organization.name}"`));
    assert.strictEqual(env.alerts.length, 0, '不再跳「請選取費用所屬人正確所在的部門」');

    reset({ swalAnswer: { isConfirmed: true, value: '0' } });
    env.orgs.u2 = ORGS;
    showHandler(showEvent('u2', [U('OLD', '原部門')]));
    await flush();
    assert.strictEqual(env.swalCalls.length, 1);
    assert.strictEqual(env.swalCalls[0].showCancelButton, false);
    assert.deepStrictEqual(orgValue(), [U('A', ORG_A.organization.name)]);
  });

  await check('create.show：費用所屬人空白但部門有值 → 部門清空', async () => {
    reset();
    const ev = showEvent(null, [U('OLD', '原部門')]);
    const out = showHandler(ev);
    await flush();
    assert.deepStrictEqual(out.record[F.EXPENSE_OWNER_ORG].value, []);
    assert.strictEqual(env.apiCalls.length, 0);
  });

  await check('create.show：費用所屬人也空白 → 不查單位；部門空白時簽核欄位照舊被清空', async () => {
    reset();
    const ev = showEvent(null, []);
    ev.record[SLOTS[0]].value = [U('m1')];
    showHandler(ev);
    await flush();
    assert.strictEqual(env.apiCalls.length, 0);
    assert.deepStrictEqual(ev.record[SLOTS[0]].value, []);
  });

  await check('edit.show 不觸發補部門（不查單位、部門維持空白）', async () => {
    reset();
    env.orgs.u1 = [ORG_A];
    env.live[F.EXPENSE_OWNER].value = [U('u1')];
    env.live[F.EXPENSE_OWNER_ORG].value = [];
    T.handlers['app.record.edit.show']({ record: clone(env.live) });
    await flush();
    assert.ok(!env.apiCalls.some((c) => c.url === '/v1/user/organizations.json'));
    assert.deepStrictEqual(orgValue(), []);
  });

  await check('create.show 補部門後呼叫公司名稱重算', async () => {
    reset({ useSwal: false });
    env.orgs.u1 = [ORG_A];
    const applied = [];
    global.window.PR_COMPANY_NAME = { apply: (r) => applied.push(r[F.EXPENSE_OWNER_ORG].value) };
    showHandler(showEvent('u1', []));
    await flush();
    delete global.window.PR_COMPANY_NAME;
    assert.deepStrictEqual(applied, [[U('A', ORG_A.organization.name)]]);
  });

  console.log = origLog;
  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  console.log = console.info;
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
