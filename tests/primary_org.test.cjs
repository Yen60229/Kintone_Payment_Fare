'use strict';

// 測試：費用所屬人的「優先組織」自動帶入費用所屬人部門（2026-11-16，做法同出差申請單的簽核流程）
//   - 有多個所屬單位、有設優先組織 → 直接帶優先組織，不跳選部門視窗（新增畫面也一樣，蓋過原本的部門）
//   - 路線 A kintone.user.getOrganizations()（primary 旗標）→ 路線 B /v1/users.json primaryOrganization
//   - 沒設、讀不到、不在清單 → 照舊跳選部門視窗
// 單獨執行：node tests/primary_org.test.cjs

const assert = require('assert');
const { readSrc, makeElement, readOrgPicker } = require('./lib/pr_env.cjs');

const clone = (o) => JSON.parse(JSON.stringify(o));
const wait = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await wait();
};
const U = (code, name = code) => ({ code, name });
const org = (id, code, title = '課員') => ({ organization: { id, code, name: code }, title: { name: title } });

const SLOTS = ['單位主管1', '單位主管2', '單位主管3', '單位次長', '單位次長1', '單位部長_支店長'];
const handlers = {};
const env = { live: {}, apiCalls: [], dialogs: [], orgs: {}, primaryA: undefined, primaryB: {}, failA: false, failB: false };
global.window = {};
global.alert = () => {};
global.confirm = () => true;
global.Swal = { fire: () => Promise.resolve({ isConfirmed: true }) };
global.document = {
  createElement: () => makeElement(),
  body: {
    appendChild: (el) => {
      env.dialogs.push(el);
      if (typeof env.pick === 'number') readOrgPicker(el).options[env.pick].click();
      return el;
    },
  },
};
global.kintone = {
  app: {
    getId: () => 749,
    record: {
      get: () => ({ record: clone(env.live) }),
      set: (r) => {
        env.live = clone(r.record);
      },
      setFieldShown: () => {},
      setGroupFieldOpen: () => {},
    },
  },
  user: {
    // 路線 A：env.primaryA＝undefined 表示「這版 kintone 沒有這個 API」
    getOrganizations: (code) => {
      if (env.failA) return Promise.reject(new Error('A 失敗'));
      return Promise.resolve((env.orgs[code] || []).map((o) => ({ organization: { ...o.organization, primary: o.organization.id === env.primaryA } })));
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
      if (url === '/v1/user/organizations.json') return Promise.resolve({ organizationTitles: env.orgs[params.code] || [] });
      if (url === '/v1/users.json') {
        if (env.failB) return Promise.reject(new Error('403'));
        return Promise.resolve({ users: params.codes.map((code) => ({ code, primaryOrganization: env.primaryB[code] || null })) });
      }
      const records = [];
      if (typeof onOk === 'function') {
        setTimeout(() => onOk({ records }), 0);
        return undefined;
      }
      return Promise.resolve({ records });
    },
    { url: (p) => p },
  ),
};
// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('signing_personnel_manager_20260506.js'));
const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const OWNER_EVENT = `app.record.create.change.${F.EXPENSE_OWNER}`;
const fire = (type, record = clone(env.live)) => (handlers[type] || []).reduce((ev, fn) => fn(ev) || ev, { type, record });

const ORGS = [org('11', '物流部-業務企劃課'), org('22', '總務部-資訊課'), org('33', '總務部', '部長')];
const reset = ({ owner = 'u1', orgCode = 'OLD', pick } = {}) => {
  env.apiCalls.length = 0;
  env.dialogs.length = 0;
  env.orgs = { u1: ORGS };
  env.primaryA = undefined;
  env.primaryB = {};
  env.failA = false;
  env.failB = false;
  env.pick = pick;
  env.live = {
    [F.EXPENSE_OWNER]: { type: 'USER_SELECT', value: owner ? [U(owner)] : [] },
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: orgCode ? [U(orgCode)] : [] },
    [F.MANUAL_FLOW]: { type: 'CHECK_BOX', value: [] },
    [F.ACCOUNTING_UNIT]: { type: 'GROUP_SELECT', value: [] },
    [F.ACCOUNTING_STAFF]: { type: 'USER_SELECT', value: [] },
    [F.PERMISSION_STAFF]: { type: 'USER_SELECT', value: [] },
    部門主管簽核人數: { value: '' },
    部門次長簽核人數: { value: '' },
  };
  SLOTS.forEach((f) => (env.live[f] = { type: 'USER_SELECT', value: [] }));
};
const orgValue = () => env.live[F.EXPENSE_OWNER_ORG].value.map((o) => o.code);

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

(async () => {
  console.log('primary_org.test.cjs');
  const P = global.window.PR_ORG_PICKER;

  await check('路線 A：getOrganizations 有 primary → 回該組織 id；有組織但沒有 primary → null（不再問路線 B）', async () => {
    reset();
    env.primaryA = '22';
    assert.strictEqual(await P.fetchPrimaryOrgId('u1'), '22');
    env.primaryA = 'none';
    env.primaryB.u1 = '33';
    assert.strictEqual(await P.fetchPrimaryOrgId('u1'), null);
    assert.strictEqual(env.apiCalls.filter((c) => c.url === '/v1/users.json').length, 0);
  });

  await check('路線 A 失敗 → 路線 B /v1/users.json；兩條都失敗 → null', async () => {
    reset();
    env.failA = true;
    env.primaryB.u1 = 33;
    assert.strictEqual(await P.fetchPrimaryOrgId('u1'), '33');
    env.failB = true;
    assert.strictEqual(await P.fetchPrimaryOrgId('u1'), null);
  });

  await check('primaryOrgOf：只有一個單位不查；優先組織不在清單 → null', async () => {
    reset();
    env.primaryA = '22';
    assert.strictEqual(await P.primaryOrgOf([ORGS[0]], 'u1'), null);
    assert.strictEqual(env.apiCalls.length, 0);
    assert.strictEqual((await P.primaryOrgOf(ORGS, 'u1')).organization.code, '總務部-資訊課');
    env.primaryA = '99';
    assert.strictEqual(await P.primaryOrgOf(ORGS, 'u1'), null);
  });

  await check('改費用所屬人：有優先組織 → 直接帶入，不跳選部門視窗', async () => {
    reset();
    env.primaryA = '22';
    fire(OWNER_EVENT);
    await settle();
    assert.strictEqual(env.dialogs.length, 0);
    assert.deepStrictEqual(orgValue(), ['總務部-資訊課']);
    assert.strictEqual(env.live[F.EXPENSE_OWNER_ORG].disabled, true);
  });

  await check('改費用所屬人：沒設優先組織 → 照舊跳選部門視窗，點哪個帶哪個', async () => {
    reset({ pick: 2 });
    env.primaryA = 'none';
    fire(OWNER_EVENT);
    await settle();
    assert.strictEqual(env.dialogs.length, 1);
    assert.deepStrictEqual(orgValue(), ['總務部']);
  });

  await check('改費用所屬人：優先組織讀不到（兩條路都失敗）→ 跳選部門視窗', async () => {
    reset({ pick: 0 });
    env.failA = true;
    env.failB = true;
    fire(OWNER_EVENT);
    await settle();
    assert.strictEqual(env.dialogs.length, 1);
    assert.deepStrictEqual(orgValue(), ['物流部-業務企劃課']);
  });

  await check('新增畫面：原部門雖是他的單位，但不是優先組織 → 改帶優先組織；原部門就是優先組織 → 不動', async () => {
    reset({ orgCode: '總務部' });
    env.primaryA = '22';
    fire('app.record.create.show');
    await settle();
    assert.strictEqual(env.dialogs.length, 0);
    assert.deepStrictEqual(orgValue(), ['總務部-資訊課']);

    reset({ orgCode: '總務部-資訊課' });
    env.primaryA = '22';
    const before = clone(env.live[F.EXPENSE_OWNER_ORG]);
    fire('app.record.create.show');
    await settle();
    assert.deepStrictEqual(env.live[F.EXPENSE_OWNER_ORG], before);
  });

  await check('新增畫面：沒設優先組織、原部門是他的單位 → 照舊保留，不跳視窗', async () => {
    reset({ orgCode: '總務部' });
    env.primaryA = 'none';
    fire('app.record.create.show');
    await settle();
    assert.strictEqual(env.dialogs.length, 0);
    assert.deepStrictEqual(orgValue(), ['總務部']);
  });

  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
