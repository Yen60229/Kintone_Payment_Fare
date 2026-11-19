'use strict';

// 測試：部長上一階主管.js（取代 部長簽核帶入_20261029.js）＋簽核人員程式的接法
//   - 費用所屬人部門＋職稱對到 C.DIRECTOR_UPLINE.RULES → 群組成員（扣掉本人）進單位部長_支店長，其他格清空，人數 0人／0人
//   - 存檔 apply()：不在對照表不打 API；群組沒人／查不到 → 擋存檔；手動、作廢、送出後不處理
//   - 畫面：改費用所屬人部門 → 對照表裡的部長不查簽核流程主檔，改讀群組
//   - 主管／次長人數一律依各格重算：換費用所屬人先清空歸 0人；主檔查不到流程、特定部長也不留上一位的人數
// 單獨執行：node tests/director_upline.test.cjs

const assert = require('assert');
const { loadInto } = require('./lib/esm_loader.cjs');
const { stubSigningDeps } = require('./lib/signing_deps.cjs');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));
const wait = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await wait();
};

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

// ── 環境 ────────────────────────────────────────────────────────────────────
const handlers = {};
const env = { live: {}, shown: {}, apiCalls: [], alerts: [], swal: [], orgs: {}, master: {}, groups: {}, groupFail: false };
global.window = {};
global.alert = (m) => env.alerts.push(m);
global.confirm = () => true;
global.Swal = { fire: (o) => env.swal.push(o) };
const queryName = (q) => (q.match(/簽核流程名稱 = "(.*)"/) || q.match(/簽核所屬單位 in \("(.*?)"\)/) || [])[1];
global.kintone = {
  app: {
    getId: () => 749,
    record: {
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
      if (url === '/v1/user/organizations.json') return Promise.resolve({ organizationTitles: env.orgs[params.code] || [] });
      if (url === '/v1/group/users.json') {
        if (env.groupFail) return Promise.reject(new Error('403'));
        const all = (env.groups[params.code] || []).map(U);
        return Promise.resolve({ users: all.slice(params.offset, params.offset + params.size) });
      }
      if (url === '/v1/users.json') return Promise.resolve({ users: [] });
      const records = params.app === env.C.APPS.ACCOUNTING_MAP ? [env.accountingRecord] : env.master[queryName(params.query)] ? [env.master[queryName(params.query)]] : [];
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
env.C = global.window.PR_CONFIG;
// 簽核人員 import 的其他模組：換成「沒載入」的替身（見 tests/lib/signing_deps.cjs）
stubSigningDeps(null, { real: ['部長上一階主管.js'] });
loadInto(null, 'signing_personnel_manager.js');
loadInto(null, '部長上一階主管.js');
const C = env.C;
const F = C.FIELDS;
const D = loadInto(null, '部長上一階主管.js', { install: false }).DIRECTOR_UPLINE;
const ACC = C.REF_FIELDS.ACCOUNTING_MAP;
env.accountingRecord = { [ACC.APPLY_UNIT]: { value: 'U' }, [ACC.ACCOUNTING_UNIT]: { value: 'ACC_TPE' }, [ACC.ACCOUNTING_STAFF]: { value: [] }, [ACC.PERMISSION_USER]: { value: [] } };

const ORG_EVENT = `app.record.create.change.${F.EXPENSE_OWNER_ORG}`;
const OWNER_EVENT = `app.record.create.change.${F.EXPENSE_OWNER}`;
const fire = (type, record = clone(env.live)) => (handlers[type] || []).reduce((ev, fn) => fn(ev) || ev, { type, record });

const masterOf = (people) => {
  const rec = { 簽核流程名稱: { value: 'X' } };
  SLOTS.forEach((slot) => {
    rec[API_OF[slot]] = { value: people[slot] ? [U(people[slot])] : [] };
  });
  return rec;
};
const FULL = { 單位主管1: 'A1', 單位主管2: 'A2', 單位主管3: 'A3', 單位次長: 'D0', 單位次長1: 'D1', 單位部長_支店長: 'H' };

/** 一張單：費用所屬人 owner 在 orgName（組織代碼＝名稱），簽核格可先放舊值 */
const makeRecord = ({ orgName, owner = 'OWN', slots = {}, counts = ['', ''], status, manual = false, voided = false }) => {
  const r = {
    [F.APPLICANT]: { type: 'USER_SELECT', value: [U('APPLICANT')] },
    [F.EXPENSE_OWNER]: { type: 'USER_SELECT', value: owner ? [U(owner)] : [] },
    [F.EXPENSE_OWNER_ORG]: { type: 'ORGANIZATION_SELECT', value: orgName ? [{ code: orgName, name: orgName }] : [] },
    [F.MANUAL_FLOW]: { type: 'CHECK_BOX', value: manual ? [C.OPTIONS.MANUAL_FLOW.ON] : [] },
    [F.ACCOUNTING_UNIT]: { type: 'GROUP_SELECT', value: [] },
    [F.ACCOUNTING_STAFF]: { type: 'USER_SELECT', value: [] },
    [F.PERMISSION_STAFF]: { type: 'USER_SELECT', value: [] },
    [C.VOID_FIELD]: { type: 'CHECK_BOX', value: voided ? ['作廢'] : [] },
    [COUNT_M]: { value: counts[0] },
    [COUNT_D]: { value: counts[1] },
  };
  if (status !== undefined) r[F.STATUS_FIELD] = { value: status };
  SLOTS.forEach((f) => (r[f] = { type: 'USER_SELECT', value: slots[f] ? [U(slots[f])] : [] }));
  return r;
};
const setOwner = (code, orgName, title) => {
  env.orgs[code] = [{ organization: { id: '1', code: orgName, name: orgName }, title: title ? { name: title } : null }];
};
const signers = (r = env.live) => Object.fromEntries(SLOTS.map((f) => [f, (r[f]?.value || []).map((u) => u.code)]));
const counts = (r = env.live) => [r[COUNT_M].value, r[COUNT_D].value];
const resetEnv = () => {
  env.apiCalls.length = 0;
  env.swal.length = 0;
  env.groupFail = false;
  env.orgs = {};
  env.groups = {};
  env.master = {};
  D._reset();
};
const callsTo = (url) => env.apiCalls.filter((c) => c.url === url);
const approvalCalls = () => env.apiCalls.filter((c) => c.params?.app === C.APPS.APPROVAL_FLOW);

let passed = 0;
const check = async (label, fn) => {
  resetEnv();
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

(async () => {
  console.log('director_upline.test.cjs');

  // ── 純函式 ────────────────────────────────────────────────────────────────
  await check('groupOf：8 筆部長都對得到群組；同部門不同職稱、不在表的部門 → null', () => {
    assert.strictEqual(D.groupOf('事業本部', '部長'), 'HQ_部長');
    assert.strictEqual(D.groupOf('總務部', '部長'), 'HQ_ACC_課長');
    assert.strictEqual(D.groupOf('物流運輸事業部', '部長'), 'BH_部長');
    assert.strictEqual(D.groupOf('總務部', '課長'), null);
    assert.strictEqual(D.groupOf('營業戰略部', '部長'), null);
  });

  await check('membersExcept：扣掉本人、去重；writeSlots：部長格＝成員，其他 5 格清空，人數 0人／0人；沒人 → 0人／0人', () => {
    assert.deepStrictEqual(D.membersExcept([U('OWN'), U('B'), U('B'), U('C')], 'OWN').map((u) => u.code), ['B', 'C']);
    const r = makeRecord({ orgName: '事業本部', slots: FULL, counts: ['3人', '2人'] });
    assert.strictEqual(D.writeSlots(r, [U('B'), U('C')]), true);
    assert.deepStrictEqual(signers(r), { 單位主管1: [], 單位主管2: [], 單位主管3: [], 單位次長: [], 單位次長1: [], 單位部長_支店長: ['B', 'C'] });
    assert.deepStrictEqual(counts(r), ['0人', '0人']);
    assert.strictEqual(D.writeSlots(r, [U('C'), U('B')]), false, '值沒變（順序不同）不算改到');
    D.writeSlots(r, []);
    assert.deepStrictEqual(counts(r), ['0人', '0人']);
  });

  // ── 存檔 apply() ──────────────────────────────────────────────────────────
  await check('apply：事業本部部長 → 部長格＝HQ_部長成員（扣掉本人），人數 0人／0人', async () => {
    setOwner('OWN', '事業本部', '部長');
    env.groups.HQ_部長 = ['OWN', 'BOSS'];
    const r = makeRecord({ orgName: '事業本部', slots: FULL, counts: ['3人', '2人'] });
    assert.deepStrictEqual(await D.apply(r), []);
    assert.deepStrictEqual(signers(r)['單位部長_支店長'], ['BOSS']);
    assert.deepStrictEqual(SLOTS.filter((f) => signers(r)[f].length), ['單位部長_支店長']);
    assert.deepStrictEqual(counts(r), ['0人', '0人']);
    assert.deepStrictEqual(callsTo('/v1/group/users.json').map((c) => c.params.code), ['HQ_部長']);
  });

  await check('apply：群組超過 100 人 → 分頁抓完', async () => {
    setOwner('OWN', '總務部', '部長');
    env.groups.HQ_ACC_課長 = Array.from({ length: 150 }, (_, i) => `M${i}`);
    const r = makeRecord({ orgName: '總務部' });
    assert.deepStrictEqual(await D.apply(r), []);
    assert.strictEqual(signers(r)['單位部長_支店長'].length, 150);
    assert.deepStrictEqual(callsTo('/v1/group/users.json').map((c) => c.params.offset), [0, 100]);
  });

  await check('apply：部門不在對照表 → 不查職稱也不查群組，record 不動', async () => {
    const r = makeRecord({ orgName: '業務一課', slots: FULL, counts: ['3人', '2人'] });
    assert.deepStrictEqual(await D.apply(r), []);
    assert.strictEqual(env.apiCalls.length, 0);
    assert.deepStrictEqual(counts(r), ['3人', '2人']);
  });

  await check('apply：部門在對照表、但職稱不是部長 → 照原本排法，不動 record', async () => {
    setOwner('OWN', '總務部', '課長');
    const r = makeRecord({ orgName: '總務部', slots: FULL, counts: ['3人', '2人'] });
    assert.deepStrictEqual(await D.apply(r), []);
    assert.strictEqual(callsTo('/v1/group/users.json').length, 0);
    assert.deepStrictEqual(counts(r), ['3人', '2人']);
  });

  await check('apply：群組只有本人／空群組 → 回錯誤擋存檔（點名部門與群組，提示可改勾手動）', async () => {
    setOwner('OWN', '汽車貨運部', '部長');
    env.groups.BH_LT_部長 = ['OWN'];
    const errs = await D.apply(makeRecord({ orgName: '汽車貨運部' }));
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0].includes('汽車貨運部') && errs[0].includes('BH_LT_部長'));
    assert.ok(errs[0].includes(F.MANUAL_FLOW));
  });

  await check('apply：群組查詢失敗 → 回錯誤擋存檔；下次再查（失敗不快取）', async () => {
    setOwner('OWN', '台中營業部', '部長');
    env.groupFail = true;
    const errs = await D.apply(makeRecord({ orgName: '台中營業部' }));
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0].includes(C.DIRECTOR_UPLINE.SLOT));
    env.groupFail = false;
    env.groups.HQ_部長 = ['BOSS'];
    assert.deepStrictEqual(await D.apply(makeRecord({ orgName: '台中營業部' })), []);
  });

  await check('apply：手動設定簽核流程、表單作廢、送出後的狀態 → 不處理；駁回狀態照常重算', async () => {
    setOwner('OWN', '事業本部', '部長');
    env.groups.HQ_部長 = ['BOSS'];
    for (const r of [makeRecord({ orgName: '事業本部', manual: true }), makeRecord({ orgName: '事業本部', voided: true }), makeRecord({ orgName: '事業本部', status: '申請單位主管3確認中' })]) {
      assert.deepStrictEqual(await D.apply(r), []);
      assert.deepStrictEqual(signers(r)['單位部長_支店長'], []);
    }
    assert.strictEqual(env.apiCalls.length, 0);
    const rejected = makeRecord({ orgName: '事業本部', status: '申請單位主管3駁回' });
    assert.deepStrictEqual(await D.apply(rejected), []);
    assert.deepStrictEqual(signers(rejected)['單位部長_支店長'], ['BOSS']);
  });

  // ── 畫面：簽核人員程式 ──────────────────────────────────────────────────────
  await check('畫面：改費用所屬人部門（事業本部部長）→ 不查簽核流程主檔，部長格＝群組成員、人數 0人／0人、只顯示部長格', async () => {
    setOwner('OWN', '事業本部', '部長');
    env.groups.HQ_部長 = ['OWN', 'BOSS'];
    env.live = makeRecord({ orgName: '事業本部', slots: FULL, counts: ['3人', '2人'] });
    fire(ORG_EVENT);
    await settle();
    assert.strictEqual(approvalCalls().length, 0);
    assert.deepStrictEqual(SLOTS.filter((f) => signers()[f].length), ['單位部長_支店長']);
    assert.deepStrictEqual(signers()['單位部長_支店長'], ['BOSS']);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
    assert.strictEqual(env.shown['單位部長_支店長'], true);
    assert.strictEqual(env.shown['單位主管1'], false);
    assert.strictEqual(env.shown[COUNT_M], false);
    assert.strictEqual(env.shown[COUNT_D], false);
  });

  await check('畫面：群組沒有別人 → 格子清空、人數 0人，跳提醒', async () => {
    setOwner('OWN', '物流運輸事業部', '部長');
    env.groups.BH_部長 = ['OWN'];
    env.live = makeRecord({ orgName: '物流運輸事業部', slots: FULL, counts: ['3人', '2人'] });
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(SLOTS.filter((f) => signers()[f].length), []);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
    assert.strictEqual(env.swal.length, 1);
    assert.ok(String(env.swal[0].text || env.swal[0].html).includes('BH_部長'));
  });

  await check('畫面：群組讀不到 → 格子清空、人數 0人，跳錯誤提醒', async () => {
    setOwner('OWN', '海運貨物部', '部長');
    env.groupFail = true;
    env.live = makeRecord({ orgName: '海運貨物部', slots: FULL, counts: ['3人', '2人'] });
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(SLOTS.filter((f) => signers()[f].length), []);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
    assert.strictEqual(env.swal[0].icon, 'error');
  });

  // ── 人數重算 ───────────────────────────────────────────────────────────────
  await check('換費用所屬人：change 當下就清掉上一位的簽核人員、人數歸 0人（查完單位再依新的人重排）', () => {
    env.live = makeRecord({ orgName: '業務一課', slots: FULL, counts: ['3人', '2人'] });
    const ev = fire(OWNER_EVENT);
    assert.deepStrictEqual(SLOTS.filter((f) => ev.record[f].value.length), []);
    assert.deepStrictEqual(counts(ev.record), ['0人', '0人']);
  });

  await check('換費用所屬人（手動設定簽核流程）：不清自選的人', () => {
    env.live = makeRecord({ orgName: '業務一課', slots: FULL, counts: ['3人', '2人'], manual: true });
    const ev = fire(OWNER_EVENT);
    assert.deepStrictEqual(counts(ev.record), ['3人', '2人']);
  });

  await check('主檔查不到流程：不留上一位的人與人數（全部清空、0人／0人）', async () => {
    setOwner('OWN', '沒有流程的課', '課員');
    env.live = makeRecord({ orgName: '沒有流程的課', slots: FULL, counts: ['3人', '2人'] });
    fire(ORG_EVENT);
    await settle();
    assert.strictEqual(approvalCalls().length, 1);
    assert.deepStrictEqual(SLOTS.filter((f) => signers()[f].length), []);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
  });

  await check('特定部長（營業戰略部長，不在對照表）：清空、0人／0人', async () => {
    setOwner('OWN', '營業戰略部', '部長');
    env.master['安全品質推動部長/營業戰略部長/總務部長/事業本部長'] = masterOf(FULL);
    env.live = makeRecord({ orgName: '營業戰略部', slots: FULL, counts: ['3人', '2人'] });
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(SLOTS.filter((f) => signers()[f].length), []);
    assert.deepStrictEqual(counts(), ['0人', '0人']);
  });

  await check('一般課員：主檔六格都有人 → 人數依實際有人的格子算（3人／2人）', async () => {
    setOwner('OWN', '業務一課', '課員');
    env.master['業務一課'] = masterOf(FULL);
    env.live = makeRecord({ orgName: '業務一課', counts: ['', ''] });
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(counts(), ['3人', '2人']);
  });

  await check('課長本人在主管2：清主管1、2 → 人數 1人／2人（依清完後的格子重算）', async () => {
    setOwner('OWN', '業務一課', '課長');
    env.master['業務一課'] = masterOf({ ...FULL, 單位主管2: 'OWN' });
    env.live = makeRecord({ orgName: '業務一課' });
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(SLOTS.filter((f) => signers()[f].length), ['單位主管3', '單位次長', '單位次長1', '單位部長_支店長']);
    assert.deepStrictEqual(counts(), ['1人', '2人']);
  });

  await check('連續改兩次部門（先改的群組查得慢也一樣）：只寫回最後一次', async () => {
    setOwner('OWN', '事業本部', '部長');
    env.groups.HQ_部長 = ['BOSS'];
    env.live = makeRecord({ orgName: '事業本部' });
    fire(ORG_EVENT);
    setOwner('OWN', '業務一課', '課員');
    env.master['業務一課'] = masterOf(FULL);
    env.live = makeRecord({ orgName: '業務一課' });
    fire(ORG_EVENT);
    await settle();
    assert.deepStrictEqual(signers()['單位主管3'], ['A3']);
    assert.deepStrictEqual(counts(), ['3人', '2人']);
  });

  await check('原始碼：舊的依費用歸屬帶部長已移除；註解不寫 App 編號', () => {
    assert.ok(!fs.existsSync(path.join(rootDir, '部長簽核帶入_20261029.js')));
    const sig = readSrc('signing_personnel_manager.js');
    assert.ok(!sig.includes('PR_DIRECTOR_BY_CC') && !sig.includes('DIRECTOR_BY_COST_CENTER'));
    assert.ok(readSrc('payment_request_submit.js').includes("import { DIRECTOR_UPLINE } from './部長上一階主管.js';"));
    assert.ok(!/App ?\d{3}/.test(readSrc('部長上一階主管.js')));
  });

  console.log(`\n${passed} assertions passed.`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
