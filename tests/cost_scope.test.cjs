'use strict';

// 測試：費用歸屬部門限制_20261022.js
//   (1) 掛帳單位（費用歸屬）只能是費用所屬人部內  (2) 不能跨部門
//   (3) 申請人在「費用歸屬不限部門」群組 → 不受限制；create.show／edit.show 先算好存起來
//   組織樹：費用所屬人部門沿上層爬到費用歸屬主檔出現過的部門
// 單獨執行：node tests/cost_scope.test.cjs

const assert = require('assert');
const { createEnv, createRunner } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('cost_scope.test.cjs');

// 組織樹：物流部 ← 物流部-NEXT1 ← 物流部-NEXT1-CS課；總務部 ← 總務課；安全品質推動部（沒有費用歸屬代碼）
const ORGS = [
  { code: 'LOG', parentCode: null },
  { code: 'LOG-N1', parentCode: 'LOG' },
  { code: 'LOG-N1-CS', parentCode: 'LOG-N1' },
  { code: 'GA', parentCode: null },
  { code: 'GA-1', parentCode: 'GA' },
  { code: 'QA', parentCode: null },
];
const DEPT_OF_CODE = { AJ50: 'LOG', AJ51: 'LOG', AJ30: 'GA', AJ99: 'GA' };

/**
 * @param {Object} o
 * @param {Object<string,string[]>} [o.groups] 使用者代碼 → 群組名稱
 * @param {boolean} [o.groupFail] 群組 API 失敗
 * @param {boolean} [o.orgFail] 組織 API 失敗
 * @param {string[]} [o.validCodes] 使用中的費用歸屬代碼
 */
const setup = ({ groups = {}, groupFail = false, orgFail = false, validCodes = Object.keys(DEPT_OF_CODE), loginCode = 'ME' } = {}) => {
  const calls = [];
  const env = createEnv({
    loginCode,
    api: (url, method, params) => {
      calls.push({ url, params });
      if (url === '/v1/user/groups.json') {
        if (groupFail) return Promise.reject(new Error('group boom'));
        return Promise.resolve({ groups: (groups[params.code] || []).map((name) => ({ code: `G_${name}`, name })) });
      }
      if (url === '/v1/organizations.json') {
        if (orgFail) return Promise.reject(new Error('org boom'));
        return Promise.resolve({ organizations: ORGS.slice(params.offset, params.offset + params.size) });
      }
      return Promise.reject(new Error(`未預期的 API ${url}`));
    },
  });
  env.load('payment_request_config.js');
  env.load('費用歸屬部門限制_20261022.js');
  // 費用歸屬主檔快取（main 提供）的替身
  env.window.PR_COST_CENTER = {
    ensureLoaded: () => Promise.resolve(),
    getValidCodes: () => new Set(validCodes),
    getDeptOfCode: () => DEPT_OF_CODE,
    getDeptNames: () => ({ LOG: '物流部', GA: '總務部' }),
  };
  return { env, calls, S: env.window.PR_COST_SCOPE, C: env.window.PR_CONFIG };
};

const { C } = setup();
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;

const record = ({ applicant = 'ME', ownerOrg = { code: 'LOG-N1-CS', name: '物流部-NEXT1-CS課' }, codes = [] } = {}) => ({
  [F.APPLICANT]: { value: applicant ? [{ code: applicant, name: applicant }] : [] },
  [F.EXPENSE_OWNER_ORG]: { value: ownerOrg ? [ownerOrg] : [] },
  [T.CODE]: { value: codes.map((c) => ({ value: { [T.COLS.EXPENSE]: { value: c } } })) },
});

// ── 組織樹與規則（純函式）──────────────────────────────────────────────────
check('resolveDeptOfOrg：往上爬到主檔出現過的部門；自己就是部門直接回；爬到頂找不到回自己', () => {
  const { S } = setup();
  const parentOf = Object.fromEntries(ORGS.map((o) => [o.code, o.parentCode]));
  const depts = new Set(Object.values(DEPT_OF_CODE));
  assert.strictEqual(S.resolveDeptOfOrg('LOG-N1-CS', parentOf, depts), 'LOG');
  assert.strictEqual(S.resolveDeptOfOrg('GA', parentOf, depts), 'GA');
  assert.strictEqual(S.resolveDeptOfOrg('QA', parentOf, depts), 'QA');
});

check('resolveDeptOfOrg：組織資料有迴圈也不會卡死', () => {
  const { S } = setup();
  assert.strictEqual(S.resolveDeptOfOrg('A', { A: 'B', B: 'A' }, new Set(['Z'])), 'A');
});

check('checkScope：全部是部內代碼 → 通過（大小寫、空白列不影響）', () => {
  const { S } = setup();
  assert.strictEqual(S.checkScope({ codes: ['aj50', '', 'AJ51 '], deptOfCode: DEPT_OF_CODE, ownerDept: 'LOG' }).length, 0);
});

check('checkScope：(1) 部外代碼 → 錯誤列出第幾行、代碼與所屬部門', () => {
  const { S } = setup();
  const errs = S.checkScope({ codes: ['AJ30'], deptOfCode: DEPT_OF_CODE, ownerDept: 'LOG', orgNames: { LOG: '物流部', GA: '總務部' } });
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('只能是費用所屬人的部內') && errs[0].includes('物流部'), errs[0]);
  assert.ok(errs[0].includes('▸第 1 行 AJ30（總務部）'), errs[0]);
});

check('checkScope：(2) 跨部門 → 另外一條「不能跨部門」', () => {
  const { S } = setup();
  const errs = S.checkScope({ codes: ['AJ50', 'AJ30'], deptOfCode: DEPT_OF_CODE, ownerDept: 'LOG', orgNames: { LOG: '物流部', GA: '總務部' } });
  assert.strictEqual(errs.length, 2);
  assert.ok(errs[0].includes('不能跨部門') && errs[0].includes('物流部、總務部'), errs[0]);
  assert.ok(errs[1].includes('第 2 行 AJ30'), errs[1]);
});

check('checkScope：代碼在主檔沒設定所屬部門 → 請管理員補主檔', () => {
  const { S } = setup();
  const errs = S.checkScope({ codes: ['AJ77'], deptOfCode: DEPT_OF_CODE, ownerDept: 'LOG' });
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('沒有設定所屬部門') && errs[0].includes('▸AJ77'), errs[0]);
});

// ── 排除群組 ────────────────────────────────────────────────────────────────
check('排除群組：群組名稱或代碼相符都算', () => {
  const { S } = setup();
  assert.strictEqual(S.inExemptGroup([{ code: 'x', name: '費用歸屬不限部門' }]), true);
  assert.strictEqual(S.inExemptGroup([{ code: '費用歸屬不限部門', name: 'x' }]), true);
  assert.strictEqual(S.inExemptGroup([{ code: 'a', name: 'b' }]), false);
  assert.strictEqual(S.inExemptGroup(undefined), false);
});

check('create.show：先查申請人群組並存起來，isExempt() 直接讀；同一人不重查', async () => {
  const { env, calls, S } = setup({ groups: { BOSS: ['費用歸屬不限部門'] } });
  assert.strictEqual(S.isExempt(), false, '還沒算好前回 false');
  await env.fire('app.record.create.show', { record: record({ applicant: 'BOSS' }) });
  assert.strictEqual(await S.ensureExempt('BOSS'), true);
  assert.strictEqual(S.isExempt(), true);
  assert.strictEqual(calls.filter((c) => c.url === '/v1/user/groups.json').length, 1);
  assert.strictEqual(calls.find((c) => c.url === '/v1/user/groups.json').params.code, 'BOSS');
});

check('沒填申請人 → 用登入者；群組 API 失敗 → 當作不在排除名單（寧可多擋）', async () => {
  const { S } = setup({ groupFail: true, loginCode: 'ME' });
  assert.strictEqual(S.applicantCodeOf(record({ applicant: null })), 'ME');
  assert.strictEqual(await S.ensureExempt('ME'), false);
});

check('申請人改了（change）→ 重查新申請人', async () => {
  const { env, S } = setup({ groups: { BOSS: ['費用歸屬不限部門'] } });
  await env.fire('app.record.edit.show', { record: record({ applicant: 'ME' }) });
  await S.ensureExempt('ME');
  assert.strictEqual(S.isExempt(), false);
  await env.fire(`app.record.edit.change.${F.APPLICANT}`, { record: record({ applicant: 'BOSS' }) });
  await S.ensureExempt('BOSS');
  assert.strictEqual(S.isExempt(), true);
});

// ── 存檔驗證 ────────────────────────────────────────────────────────────────
check('validate：部內代碼通過；子單位的費用所屬人部門往上爬到物流部', async () => {
  const { S } = setup();
  assert.strictEqual((await S.validate(record({ codes: ['AJ50', 'AJ51'] }))).length, 0);
});

check('validate：部外代碼被擋，訊息用主檔的部門名稱', async () => {
  const { S } = setup();
  const errs = await S.validate(record({ codes: ['AJ50', 'AJ30'] }));
  assert.strictEqual(errs.length, 2);
  assert.ok(errs.join('\n').includes('總務部'));
});

check('validate：排除群組的申請人不檢查（也不查組織樹）', async () => {
  const { S, calls } = setup({ groups: { BOSS: ['費用歸屬不限部門'] } });
  assert.strictEqual((await S.validate(record({ applicant: 'BOSS', codes: ['AJ30', 'AJ50'] }))).length, 0);
  assert.ok(!calls.some((c) => c.url === '/v1/organizations.json'));
});

check('validate：沒填費用所屬人部門或沒有任何費用歸屬 → 略過', async () => {
  const { S } = setup();
  assert.strictEqual((await S.validate(record({ ownerOrg: null, codes: ['AJ30'] }))).length, 0);
  assert.strictEqual((await S.validate(record({ codes: ['', ' '] }))).length, 0);
});

check('validate：主檔沒有（非使用中）的代碼交給既有驗證報錯，這裡不重複報', async () => {
  const { S } = setup({ validCodes: ['AJ50'] });
  assert.strictEqual((await S.validate(record({ codes: ['AJ50', 'AJ30', 'NOPE'] }))).length, 0);
});

check('validate：部門沒有自己代碼的人（安全品質推動部）用別部門代碼 → 擋', async () => {
  const { S } = setup();
  const errs = await S.validate(record({ ownerOrg: { code: 'QA', name: '安全品質推動部' }, codes: ['AJ30'] }));
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('安全品質推動部'), errs[0]);
});

check('validate：組織 API 失敗 → 一條「無法檢查」錯誤擋下存檔', async () => {
  const { S } = setup({ orgFail: true });
  const errs = await S.validate(record({ codes: ['AJ50'] }));
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].includes('無法取得'), errs[0]);
});

check('組織樹：分頁抓完後記在記憶體，第二次不再呼叫 API', async () => {
  const { S, calls } = setup();
  await S.loadOrgParents();
  await S.loadOrgParents();
  assert.strictEqual(calls.filter((c) => c.url === '/v1/organizations.json').length, 1, '6 筆 < 100 一頁就結束');
});

done();
