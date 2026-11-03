'use strict';

// 測試：部長簽核帶入_20261029.js
//   費用所屬人在費用所屬人部門是部長 → 依明細第一個費用歸屬查費用歸屬主檔：
//     所屬部門是總公司（HQ_CODE）的部之一 → 該筆的部門部長群組；其他 → 預設代碼（DEFAULT_CODE）的部門部長群組
//   部長所在的部已是最上層 → 只帶 AJ30 主要管理部門（總務部）的部長群組
//   群組成員去掉本人寫入單位部長_支店長；存檔（apply）與畫面（費用歸屬變更 → refresh）
// 單獨執行：node tests/director_by_cost_center.test.cjs

const assert = require('assert');
const { createEnv, createRunner } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('director_by_cost_center.test.cjs');

// 組織樹：事業本部 ← 航空貨物部 ← 台北航空課；總務部 ← 總務課；營業戰略部；安全品質推動部
const ORGS = [
  { code: 'BH', parentCode: null },
  { code: 'AIR', parentCode: 'BH' },
  { code: 'AIR-1', parentCode: 'AIR' },
  { code: 'GA', parentCode: null },
  { code: 'GA-1', parentCode: 'GA' },
  { code: 'STR', parentCode: null },
  { code: 'QA', parentCode: null },
];
// 照費用歸屬主檔實際資料：AJ30（總公司）三筆（總務部那筆是主要管理部門）、AJ36（事業本部）、AJA1（航空貨物部）
const CC_RECORDS = [
  { code: 'AJ30', dept: 'STR', groups: ['AS_部長'] },
  { code: 'AJ30', dept: 'QA', groups: ['SQF_部長'] },
  { code: 'AJ30', dept: 'GA', groups: ['HQ_部長'], main: true },
  { code: 'AJ36', dept: 'BH', groups: ['BH_部長'], main: true },
  { code: 'AJA1', dept: 'AIR', groups: ['BH_FF_AC_部長'] },
  { code: 'AJ99', dept: 'GA', groups: [] }, // 總務部自己的代碼但沒設部長群組
];
const GROUP_USERS = {
  AS_部長: ['STRBOSS', 'STRDEP'], // STRDEP：用來確認最上層時不帶自己部的群組
  SQF_部長: ['QABOSS'],
  HQ_部長: ['GABOSS', 'PRES'],
  BH_部長: ['BHBOSS'],
  BH_FF_AC_部長: ['AIRBOSS'],
};
const DEPTS_OF_CODE = { AJ30: ['STR', 'QA', 'GA'], AJ36: ['BH'], AJA1: ['AIR'], AJ99: ['GA'] };

/**
 * @param {Object} o
 * @param {Object<string,Array>} [o.titles] 使用者代碼 → [[組織代碼, 職稱]]
 * @param {boolean} [o.groupFail] 群組成員 API 失敗
 * @param {boolean} [o.orgFail] 組織 API 失敗
 */
const setup = ({ titles = {}, groupFail = false, orgFail = false } = {}) => {
  const calls = [];
  const env = createEnv({
    api: (url, method, params) => {
      calls.push({ url, params });
      if (url === '/v1/user/organizations.json') {
        return Promise.resolve({ organizationTitles: (titles[params.code] || []).map(([code, title]) => ({ organization: { code, name: code }, title: title ? { name: title } : null })) });
      }
      if (url === '/v1/organizations.json') return orgFail ? Promise.reject(new Error('org boom')) : Promise.resolve({ organizations: ORGS.slice(params.offset, params.offset + params.size) });
      if (url === '/v1/group/users.json') {
        if (groupFail) return Promise.reject(new Error('group boom'));
        return Promise.resolve({ users: (GROUP_USERS[params.code] || []).slice(params.offset, params.offset + params.size).map((c) => ({ code: c, name: c })) });
      }
      if (url === '/k/v1/records') {
        const codes = (params.query.match(/CostCenter in \((.*?)\)/)[1].match(/"(.*?)"/g) || []).map((s) => s.slice(1, -1));
        const records = CC_RECORDS.filter((r) => codes.includes(r.code)).map((r) => ({
          CostCenter: { value: r.code },
          所屬部門: { value: [{ code: r.dept, name: r.dept }] },
          部門部長: { value: r.groups.map((g) => ({ code: g, name: g })) },
          主要管理部門: { value: r.main ? ['是'] : [] },
        }));
        return Promise.resolve({ records });
      }
      return Promise.reject(new Error(`未預期的 API ${url}`));
    },
  });
  env.load('payment_request_config.js');
  env.load('費用歸屬部門限制_20261022.js');
  env.load('部長簽核帶入_20261029.js');
  env.window.PR_COST_CENTER = { ensureLoaded: () => Promise.resolve(), getDeptsOfCode: () => DEPTS_OF_CODE };
  return { env, calls, D: env.window.PR_DIRECTOR_BY_CC, C: env.window.PR_CONFIG };
};

const { C } = setup();
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const TARGET = C.DIRECTOR_BY_COST_CENTER.TARGET_FIELD;

const record = ({ owner = 'BOSS', ownerOrg = 'AIR', codes = ['AJA1'], director = ['OLD'], status, manual = false, voided = false } = {}) => ({
  [F.EXPENSE_OWNER]: { value: owner ? [{ code: owner, name: owner }] : [] },
  [F.EXPENSE_OWNER_ORG]: { value: ownerOrg ? [{ code: ownerOrg, name: ownerOrg }] : [] },
  [T.CODE]: { value: codes.map((c) => ({ value: { [T.COLS.EXPENSE]: { value: c } } })) },
  [TARGET]: { value: director.map((c) => ({ code: c, name: c })) },
  [F.MANUAL_FLOW]: { value: manual ? [C.OPTIONS.MANUAL_FLOW.ON] : [] },
  [C.VOID_FIELD]: { value: voided ? ['表單作廢'] : [] },
  ...(status ? { [F.STATUS_FIELD]: { value: status } } : {}),
});
const codesOf = (users) => [...users].map((u) => u.code);

// ── 純函式 ──────────────────────────────────────────────────────────────
check('config：總公司 AJ30、預設 AJ36、寫入單位部長_支店長、主檔部長群組欄位「部門部長」', () => {
  const d = C.DIRECTOR_BY_COST_CENTER;
  assert.strictEqual(d.OWNER_TITLE, '部長');
  assert.strictEqual(d.HQ_CODE, 'AJ30');
  assert.strictEqual(d.DEFAULT_CODE, 'AJ36');
  assert.strictEqual(d.TARGET_FIELD, '單位部長_支店長');
  assert.strictEqual(C.REF_FIELDS.COST_CENTER.DIRECTOR_GROUP, '部門部長');
});

check('firstCostCenter：取第一個有填的費用歸屬（去空白、轉大寫）', () => {
  const { D } = setup();
  assert.strictEqual(D.firstCostCenter(record({ codes: ['', ' aja1 ', 'AJ30'] })), 'AJA1');
  assert.strictEqual(D.firstCostCenter(record({ codes: [''] })), '');
});

check('isEditableStatus：新增（沒有狀態）、報銷人填單、草稿、各種駁回可以；送出後不行', () => {
  const { D } = setup();
  ['', undefined, '報銷人填單', '草稿（未送出）', '申請單位部長駁回', '單位會計駁回'].forEach((s) => assert.strictEqual(D.isEditableStatus(s), true, s));
  ['申請單位部長確認中', '單位會計處理中', '請款流程結束'].forEach((s) => assert.strictEqual(D.isEditableStatus(s), false, s));
});

check('pickDirectorGroups：總公司代碼依費用所屬人的部選那一筆；業務部門代碼 → 預設 AJ36', () => {
  const { D, env } = setup();
  const resolve = env.window.PR_COST_SCOPE.resolveDeptOfOrg;
  const parentOf = Object.fromEntries(ORGS.map((o) => [o.code, o.parentCode]));
  const pick = (code, ownerDept) => D.pickDirectorGroups({ code, ownerDept, records: CC_RECORDS, parentOf, resolveDeptOfOrg: resolve });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pick('AJ30', 'GA'))), { groups: ['HQ_部長'], source: 'HQ', dept: 'GA' });
  assert.deepStrictEqual(pick('AJ30', 'STR').groups, ['AS_部長']);
  assert.deepStrictEqual(pick('AJ30', 'QA').groups, ['SQF_部長']);
  const air = pick('AJA1', 'AIR');
  assert.strictEqual(air.source, 'DEFAULT');
  assert.deepStrictEqual([...air.groups], ['BH_部長']);
  assert.strictEqual(pick('AJ36', 'BH').source, 'DEFAULT');
  assert.strictEqual(pick('NOPE', 'GA'), null, '代碼不在主檔 → null');
});

check('pickDirectorGroups：總公司部門的代碼自己沒設部長群組 → 用 AJ30 同部門那筆的', () => {
  const { D, env } = setup();
  const p = D.pickDirectorGroups({ code: 'AJ99', ownerDept: 'GA', records: CC_RECORDS, resolveDeptOfOrg: env.window.PR_COST_SCOPE.resolveDeptOfOrg });
  assert.strictEqual(p.source, 'HQ');
  assert.deepStrictEqual([...p.groups], ['HQ_部長']);
});

// ── 存檔 apply ──────────────────────────────────────────────────────────
check('apply：航空貨物部長用 AJA1 → 單位部長＝事業本部長（AJ36 的部長群組成員）', async () => {
  const { D } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  const r = record();
  assert.strictEqual((await D.apply(r)).length, 0);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['BHBOSS']);
});

check('apply：總務部長用 AJ30 → HQ_部長群組，去掉本人', async () => {
  const { D } = setup({ titles: { GABOSS: [['GA', '部長']] } });
  const r = record({ owner: 'GABOSS', ownerOrg: 'GA', codes: ['AJ30'] });
  assert.strictEqual((await D.apply(r)).length, 0);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['PRES']);
});

check('apply：總務課（子單位）的部長用 AJ30 → 往上爬到總務部，選總務部那筆', async () => {
  const { D } = setup({ titles: { BOSS: [['GA-1', '部長']] } });
  const r = record({ ownerOrg: 'GA-1', codes: ['AJ30'] });
  await D.apply(r);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['GABOSS', 'PRES']);
});

check('apply：群組只有本人、部不是最上層 → 單位部長清空，不簽自己', async () => {
  const { D } = setup({ titles: { BHBOSS: [['AIR', '部長']] } });
  const r = record({ owner: 'BHBOSS', ownerOrg: 'AIR', codes: ['AJ36'] });
  await D.apply(r);
  assert.strictEqual(r[TARGET].value.length, 0);
});

check('isTopDept：往上沒有別的部才算最上層', () => {
  const { D } = setup();
  const parentOf = Object.fromEntries(ORGS.map((o) => [o.code, o.parentCode]));
  const deptSet = new Set(Object.values(DEPTS_OF_CODE).flat());
  assert.strictEqual(D.isTopDept('GA', parentOf, deptSet), true);
  assert.strictEqual(D.isTopDept('BH', parentOf, deptSet), true);
  assert.strictEqual(D.isTopDept('AIR', parentOf, deptSet), false, '航空貨物部上面還有事業本部');
});

check('mainHqGroups：AJ30 勾主要管理部門那筆的部長群組', () => {
  const { D } = setup();
  assert.deepStrictEqual([...D.mainHqGroups(CC_RECORDS)], ['HQ_部長']);
  assert.deepStrictEqual([...D.mainHqGroups(CC_RECORDS.map((r) => ({ ...r, main: false })))], []);
});

check('apply：營業戰略部長（最上層）→ 只帶總務部長群組，不帶自己部的 AS_部長', async () => {
  const { D } = setup({ titles: { STRBOSS: [['STR', '部長']] } });
  const r = record({ owner: 'STRBOSS', ownerOrg: 'STR', codes: ['AJ30'] });
  assert.strictEqual((await D.apply(r)).length, 0);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['GABOSS', 'PRES']);
});

check('apply：事業本部長（最上層）用 AJ36 → 只帶總務部長群組', async () => {
  const { D } = setup({ titles: { BHBOSS: [['BH', '部長']] } });
  const r = record({ owner: 'BHBOSS', ownerOrg: 'BH', codes: ['AJ36'] });
  assert.strictEqual((await D.apply(r)).length, 0);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['GABOSS', 'PRES']);
});

check('apply：最上層但 AJ30 沒有勾主要管理部門 → 回錯誤訊息擋存檔', async () => {
  const { D } = setup({ titles: { STRBOSS: [['STR', '部長']] } });
  CC_RECORDS[2].main = false;
  try {
    const r = record({ owner: 'STRBOSS', ownerOrg: 'STR', codes: ['AJ30'] });
    const errs = await D.apply(r);
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0].includes('主要管理部門') && errs[0].includes('AJ30'), errs[0]);
    assert.deepStrictEqual(codesOf(r[TARGET].value), ['OLD']);
  } finally {
    CC_RECORDS[2].main = true;
  }
});

check('apply：組織樹拿不到 → 無法判斷是否最上層，回錯誤訊息擋存檔', async () => {
  const { D } = setup({ titles: { BOSS: [['AIR', '部長']] }, orgFail: true });
  const r = record();
  const errs = await D.apply(r);
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('組織資料'), errs[0]);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['OLD']);
});

check('apply：看的是費用所屬人部門那個單位的職稱（兼任別單位的部長不算）', async () => {
  const { D, calls } = setup({ titles: { BOSS: [['AIR', '課長'], ['GA', '部長']] } });
  const r = record();
  await D.apply(r);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['OLD']);
  assert.ok(!calls.some((c) => c.url === '/k/v1/records'), '不是部長就不查主檔');
});

check('apply：手動設定簽核流程、表單作廢、沒有費用歸屬 → 不動', async () => {
  const { D } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  for (const r of [record({ manual: true }), record({ voided: true }), record({ codes: [] })]) {
    await D.apply(r);
    assert.deepStrictEqual(codesOf(r[TARGET].value), ['OLD']);
  }
});

check('apply：送出後的狀態不重算（不查任何 API）；駁回狀態照樣重算', async () => {
  const { D, calls } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  const sent = record({ status: '申請單位部長確認中' });
  await D.apply(sent);
  assert.deepStrictEqual(codesOf(sent[TARGET].value), ['OLD']);
  assert.strictEqual(calls.length, 0);
  const rejected = record({ status: '申請單位部長駁回' });
  await D.apply(rejected);
  assert.deepStrictEqual(codesOf(rejected[TARGET].value), ['BHBOSS']);
});

check('apply：算出來和現值相同 → 不寫入（避免沒有欄位編輯權限的人存檔被退回）', async () => {
  const { D } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  const r = record({ director: ['BHBOSS'] });
  const before = r[TARGET].value;
  await D.apply(r);
  assert.strictEqual(r[TARGET].value, before);
});

check('apply：群組成員查不到（API 失敗）→ 回錯誤訊息擋存檔，不改欄位', async () => {
  const { D, env } = setup({ titles: { BOSS: [['AIR', '部長']] }, groupFail: true });
  const r = record();
  const errs = await D.apply(r);
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('無法帶入') && errs[0].includes(TARGET), errs[0]);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['OLD']);
  assert.ok(env.logs.error.some((m) => m.includes('部長簽核帶入')));
});

check('apply：主檔的代碼沒設部長群組、預設代碼也沒有 → 回錯誤訊息', async () => {
  const { D } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  const saved = CC_RECORDS.splice(3, 1); // 拿掉 AJ36
  try {
    const errs = await D.apply(record());
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0].includes('部門部長') && errs[0].includes('AJ36'), errs[0]);
    // 最上層的部不看自己那筆的群組：拿掉 AJ36 也照樣帶總務部長
    const r = record({ owner: 'BHBOSS', ownerOrg: 'BH', codes: ['AJA1'] });
    const top = setup({ titles: { BHBOSS: [['BH', '部長']] } });
    assert.strictEqual((await top.D.apply(r)).length, 0);
    assert.deepStrictEqual(codesOf(r[TARGET].value), ['GABOSS', 'PRES']);
  } finally {
    CC_RECORDS.splice(3, 0, ...saved);
  }
});

check('apply：費用歸屬代碼不在主檔 → 不處理（存檔驗證另有錯誤）', async () => {
  const { D } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  const r = record({ codes: ['NOPE'] });
  assert.strictEqual((await D.apply(r)).length, 0);
  assert.deepStrictEqual(codesOf(r[TARGET].value), ['OLD']);
});

// ── 畫面 refresh ────────────────────────────────────────────────────────
check('費用歸屬變更事件 → 背景查好後寫回畫面並顯示單位部長', async () => {
  const { env } = setup({ titles: { BOSS: [['AIR', '部長']] } });
  const r = record();
  env.currentRecord = JSON.parse(JSON.stringify(r));
  const ev = await env.fire(`app.record.edit.change.${T.COLS.EXPENSE}`, { record: r });
  assert.strictEqual(ev.record, r, 'change 事件本身不改 record');
  await env.window.PR_DIRECTOR_BY_CC.refresh(); // 等背景查詢跑完（同一份畫面資料）
  assert.deepStrictEqual(codesOf(env.currentRecord[TARGET].value), ['BHBOSS']);
  assert.strictEqual(env.shown[TARGET], true);
});

check('refresh：結果是清空（只有本人）→ 隱藏單位部長；手動模式不寫', async () => {
  const { env, D } = setup({ titles: { BHBOSS: [['AIR', '部長']], BOSS: [['AIR', '部長']] } });
  env.currentRecord = record({ owner: 'BHBOSS', ownerOrg: 'AIR', codes: ['AJ36'] });
  await D.refresh();
  assert.strictEqual(env.currentRecord[TARGET].value.length, 0);
  assert.strictEqual(env.shown[TARGET], false);
  env.currentRecord = record({ manual: true });
  env.setCalls.length = 0;
  await D.refresh();
  assert.strictEqual(env.setCalls.length, 0);
});

check('事件：只註冊子表格與費用歸屬的變更（新增／編輯）', () => {
  const { env } = setup();
  assert.deepStrictEqual(env.registeredTypes().filter((t) => !t.includes('show') && !t.includes(F.APPLICANT)).sort(), [
    `app.record.create.change.${T.CODE}`,
    `app.record.create.change.${T.COLS.EXPENSE}`,
    `app.record.edit.change.${T.CODE}`,
    `app.record.edit.change.${T.COLS.EXPENSE}`,
  ].sort());
});

done();
