'use strict';

// 測試：費用所屬人確認.js
//   - 申請人＝費用所屬人、沒填所屬人 → 不需要（不打 API）
//   - 申請人≠費用所屬人 → 需要；所屬人在免確認群組（代碼或名稱）→ 不需要
//   - 查群組失敗 → 擋存檔；作廢、送出後（非可編輯狀態）不處理；駁回狀態會重算；表單沒有欄位整支不動
//   - 畫面：旗標一律鎖；停在費用所屬人確認中時申請人／費用所屬人／部門也鎖
//   - 流程按鈕：草稿送出前重算，和存的值不同就擋；作廢動作、其他狀態不擋
// 單獨執行：node tests/owner_confirm.test.cjs

const assert = require('assert');
const { createEnv, createRunner } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('owner_confirm.test.cjs');

const GROUP = '費用所屬人免確認';

/**
 * @param {Object} [o]
 * @param {Object<string,Array>} [o.groups] 使用者代碼 → groups
 * @param {boolean} [o.fail] 群組 API 失敗
 */
const setup = ({ groups = {}, fail = false } = {}) => {
  const calls = [];
  const env = createEnv({
    api: (url, method, params) => {
      calls.push({ url, params });
      if (fail) return Promise.reject(new Error('403'));
      if (url === '/v1/user/groups.json') return Promise.resolve({ groups: groups[params.code] || [] });
      return Promise.reject(new Error(`沒預期的 API ${url}`));
    },
  });
  env.load('payment_request_config.js');
  const C = env.window.PR_CONFIG;
  const mod = env.load('費用所屬人確認.js').OWNER_CONFIRM;
  const F = C.FIELDS;
  const record = ({ applicant = 'a1', owner = 'o1', flag = '', status, voided = false, hasField = true } = {}) => {
    const r = {
      [F.APPLICANT]: { value: applicant ? [{ code: applicant, name: applicant }] : [] },
      [F.EXPENSE_OWNER]: { value: owner ? [{ code: owner, name: owner }] : [] },
      [F.EXPENSE_OWNER_ORG]: { value: [{ code: 'ORG', name: 'ORG' }] },
      [C.VOID_FIELD]: { value: voided ? ['作廢'] : [] },
    };
    if (hasField) r[F.OWNER_CONFIRM] = { value: flag };
    if (status !== undefined) r[F.STATUS_FIELD] = { value: status };
    return r;
  };
  return { env, C, F, mod, calls, record };
};

check('config：欄位、狀態、選項、群組都有登記', () => {
  const { C } = setup();
  assert.strictEqual(C.FIELDS.OWNER_CONFIRM, '費用所屬人確認');
  assert.strictEqual(C.STATUS.OWNER_CONFIRMING, '費用所屬人確認中');
  assert.deepStrictEqual({ ...C.OPTIONS.OWNER_CONFIRM }, { NEED: '需要', NO_NEED: '不需要' });
  assert.strictEqual(C.OWNER_CONFIRM.EXEMPT_GROUP, GROUP);
});

check('needConfirm：同一人／沒填所屬人／免確認 → false，其他 → true', () => {
  const { mod } = setup();
  assert.strictEqual(mod.needConfirm({ applicantCode: 'a', ownerCode: 'a' }), false);
  assert.strictEqual(mod.needConfirm({ applicantCode: 'a', ownerCode: '' }), false);
  assert.strictEqual(mod.needConfirm({ applicantCode: 'a', ownerCode: 'b', ownerExempt: true }), false);
  assert.strictEqual(mod.needConfirm({ applicantCode: 'a', ownerCode: 'b', ownerExempt: false }), true);
});

check('apply：同一人 → 不需要，不打 API', async () => {
  const { mod, record, calls, F } = setup();
  const r = record({ applicant: 'u', owner: 'u' });
  assert.strictEqual((await mod.apply(r)).length, 0);
  assert.strictEqual(r[F.OWNER_CONFIRM].value, '不需要');
  assert.strictEqual(calls.length, 0);
});

check('apply：不同人 → 需要（查的是費用所屬人的群組）', async () => {
  const { mod, record, calls, F } = setup();
  const r = record({ status: '草稿（未送出）' });
  assert.strictEqual((await mod.apply(r)).length, 0);
  assert.strictEqual(r[F.OWNER_CONFIRM].value, '需要');
  assert.deepStrictEqual(calls.map((c) => c.params.code), ['o1']);
});

check('apply：所屬人在免確認群組（代碼或名稱）→ 不需要；同頁只查一次', async () => {
  const byCode = setup({ groups: { o1: [{ code: GROUP, name: 'x' }] } });
  const r1 = byCode.record({ flag: '需要' });
  await byCode.mod.apply(r1);
  await byCode.mod.apply(byCode.record());
  assert.strictEqual(r1[byCode.F.OWNER_CONFIRM].value, '不需要');
  assert.strictEqual(byCode.calls.length, 1);
  const byName = setup({ groups: { o1: [{ code: 'G9', name: GROUP }] } });
  const r2 = byName.record();
  await byName.mod.apply(r2);
  assert.strictEqual(r2[byName.F.OWNER_CONFIRM].value, '不需要');
});

check('apply：查群組失敗 → 回錯誤擋存檔、值不動', async () => {
  const { mod, record, F } = setup({ fail: true });
  const r = record({ flag: '' });
  const errors = await mod.apply(r);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].includes('無法判斷是否需要費用所屬人確認'));
  assert.strictEqual(r[F.OWNER_CONFIRM].value, '');
});

check('apply：作廢、送出後狀態、表單沒有欄位都不處理；駁回狀態會重算', async () => {
  const { mod, record, calls, F } = setup();
  const voided = record({ voided: true, flag: 'x' });
  await mod.apply(voided);
  assert.strictEqual(voided[F.OWNER_CONFIRM].value, 'x');
  const sent = record({ status: '費用所屬人確認中', flag: 'x' });
  await mod.apply(sent);
  assert.strictEqual(sent[F.OWNER_CONFIRM].value, 'x');
  assert.strictEqual((await mod.apply(record({ hasField: false }))).length, 0);
  assert.strictEqual(calls.length, 0);
  const rejected = record({ status: '費用所屬人駁回', flag: '' });
  await mod.apply(rejected);
  assert.strictEqual(rejected[F.OWNER_CONFIRM].value, '需要');
});

check('畫面：旗標一律鎖；費用所屬人確認中另鎖申請人／所屬人／部門', async () => {
  const { env, record, F } = setup();
  const draft = record({ status: '草稿（未送出）' });
  await env.fire('app.record.edit.show', { record: draft });
  assert.strictEqual(draft[F.OWNER_CONFIRM].disabled, true);
  assert.strictEqual(draft[F.EXPENSE_OWNER].disabled, undefined);
  const confirming = record({ status: '費用所屬人確認中' });
  await env.fire('app.record.edit.show', { record: confirming });
  [F.OWNER_CONFIRM, F.APPLICANT, F.EXPENSE_OWNER, F.EXPENSE_OWNER_ORG].forEach((code) => assert.strictEqual(confirming[code].disabled, true, code));
  const created = record({ hasField: false });
  await env.fire('app.record.create.show', { record: created });
  assert.strictEqual(created[F.EXPENSE_OWNER].disabled, undefined, '表單沒有欄位不動');
});

check('流程按鈕：草稿值正確放行；值不同擋下並跳提示', async () => {
  const { mod, record, env } = setup();
  const ok = { record: record({ flag: '需要' }), status: { value: '草稿（未送出）' }, action: { value: '提交費用所屬人確認' } };
  assert.strictEqual(await mod.guardProceed(ok), ok);
  const stale = { record: record({ flag: '不需要' }), status: { value: '草稿（未送出）' }, action: { value: '提交單位主管3確認' } };
  assert.strictEqual(await mod.guardProceed(stale), false);
  assert.ok(env.swalCalls.at(-1).text.includes('應為「需要」'));
});

check('流程按鈕：作廢動作、非草稿狀態、查詢失敗', async () => {
  const { mod, record } = setup();
  const voidAct = { record: record({ flag: '' }), status: { value: '草稿（未送出）' }, action: { value: '作廢' } };
  assert.strictEqual(await mod.guardProceed(voidAct), voidAct);
  const other = { record: record({ flag: '' }), status: { value: '費用所屬人確認中' }, action: { value: '駁回' } };
  assert.strictEqual(await mod.guardProceed(other), other);
  const failing = setup({ fail: true });
  const ev = { record: failing.record({ flag: '需要' }), status: { value: '草稿（未送出）' }, action: { value: 'x' } };
  assert.strictEqual(await failing.mod.guardProceed(ev), false);
});

check('事件註冊：create/edit.show 與 process.proceed', () => {
  const { env } = setup();
  const types = env.registeredTypes();
  ['app.record.create.show', 'app.record.edit.show', 'app.record.detail.process.proceed'].forEach((t) => assert.ok(types.includes(t), t));
});

done();
