'use strict';

// 回歸測試：payment_request_main_20260521.js 的公司名稱推導
//   費用所屬人部門代碼開頭為「聯海」→ 公司名稱＝聯海通運；其餘（含尚未選擇）→ ＮＸ臺灣國際物流。
//   create.show 與「費用所屬人部門」變更時都要重算並鎖住欄位；edit.show 只鎖、不重算（不蓋掉已存的值）。
// 直接用 Node 執行：node tests/company_name_derivation.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('company_name_derivation.test.cjs');

const loadMain = () => {
  const env = createEnv({ appId: 749, loginCode: 'someone' });
  env.load('payment_request_config.js');
  env.load('payment_request_main_20260521.js');
  return { env, F: env.window.PR_CONFIG.FIELDS };
};

const orgValue = (code, name = code) => ({ value: code ? [{ code, name }] : [] });
const newRecord = (F, orgCode) => ({
  [F.EXPENSE_OWNER_ORG]: orgValue(orgCode),
  [F.COMPANY_NAME]: { value: '' },
  [F.PAYMENT_DATE]: { value: '' },
});

// ── 純函式 derive ───────────────────────────────────────────────────────────
check('部門代碼開頭為「聯海」→ 公司名稱＝聯海通運', () => {
  const { env, F } = loadMain();
  assert.strictEqual(env.window.PR_COMPANY_NAME.derive(newRecord(F, '聯海通運股份有限公司')), '聯海通運');
});

check('部門代碼不是以「聯海」開頭 → ＮＸ臺灣國際物流（「聯海」出現在中間也不算）', () => {
  const { env, F } = loadMain();
  assert.strictEqual(env.window.PR_COMPANY_NAME.derive(newRecord(F, '日通國際物流部')), 'ＮＸ臺灣國際物流');
  assert.strictEqual(env.window.PR_COMPANY_NAME.derive(newRecord(F, 'NX聯海')), 'ＮＸ臺灣國際物流');
});

check('費用所屬人部門為空（尚未選擇）或欄位不存在 → 預設為ＮＸ臺灣國際物流，不誤判為聯海', () => {
  const { env, F } = loadMain();
  assert.strictEqual(env.window.PR_COMPANY_NAME.derive(newRecord(F, '')), 'ＮＸ臺灣國際物流');
  assert.strictEqual(env.window.PR_COMPANY_NAME.derive({}), 'ＮＸ臺灣國際物流');
});

check('依「費用所屬人部門」而不是「申請人部門」判斷', () => {
  const { env, F } = loadMain();
  const record = newRecord(F, '總務部');
  record[F.APPLICANT_ORG] = orgValue('聯海業務部');
  assert.strictEqual(env.window.PR_COMPANY_NAME.derive(record), 'ＮＸ臺灣國際物流');
});

// ── 事件接線 ────────────────────────────────────────────────────────────────
check('create.show：依費用所屬人部門算出公司名稱並鎖住欄位', async () => {
  const { env, F } = loadMain();
  const lianhai = await env.fire('app.record.create.show', { record: newRecord(F, '聯海營運部') });
  assert.strictEqual(lianhai.record[F.COMPANY_NAME].value, '聯海通運');
  assert.strictEqual(lianhai.record[F.COMPANY_NAME].disabled, true);

  const nx = await env.fire('app.record.create.show', { record: newRecord(F, '總務部-總務課') });
  assert.strictEqual(nx.record[F.COMPANY_NAME].value, 'ＮＸ臺灣國際物流');
  assert.strictEqual(nx.record[F.COMPANY_NAME].disabled, true);
});

check('費用所屬人部門變更（新增／編輯畫面都會）→ 重算公司名稱並鎖住', async () => {
  const { env, F } = loadMain();
  const types = env.registeredTypes();
  assert.ok(types.includes(`app.record.create.change.${F.EXPENSE_OWNER_ORG}`));
  assert.ok(types.includes(`app.record.edit.change.${F.EXPENSE_OWNER_ORG}`));

  for (const phase of ['create', 'edit']) {
    const record = newRecord(F, '聯海營運部');
    record[F.COMPANY_NAME].value = 'ＮＸ臺灣國際物流';
    const toLianhai = await env.fire(`app.record.${phase}.change.${F.EXPENSE_OWNER_ORG}`, { record });
    assert.strictEqual(toLianhai.record[F.COMPANY_NAME].value, '聯海通運', `${phase}：改成聯海部門`);
    assert.strictEqual(toLianhai.record[F.COMPANY_NAME].disabled, true);

    toLianhai.record[F.EXPENSE_OWNER_ORG] = orgValue('總務部-總務課');
    const back = await env.fire(`app.record.${phase}.change.${F.EXPENSE_OWNER_ORG}`, { record: toLianhai.record });
    assert.strictEqual(back.record[F.COMPANY_NAME].value, 'ＮＸ臺灣國際物流', `${phase}：改回一般部門`);
  }
});

check('edit.show：只鎖住公司名稱、不重算（不蓋掉單據原本存的值）', async () => {
  const { env, F } = loadMain();
  const record = newRecord(F, '聯海營運部');
  record[F.COMPANY_NAME].value = 'ＮＸ臺灣國際物流'; // 假設單據存的是這個值
  const ev = await env.fire('app.record.edit.show', { record });
  assert.strictEqual(ev.record[F.COMPANY_NAME].value, 'ＮＸ臺灣國際物流');
  assert.strictEqual(ev.record[F.COMPANY_NAME].disabled, true);
});

check('PR_COMPANY_NAME.apply：給其他模組（例如簽核人員程式帶入部門後）重算用', () => {
  const { env, F } = loadMain();
  const record = newRecord(F, '聯海營運部');
  env.window.PR_COMPANY_NAME.apply(record);
  assert.strictEqual(record[F.COMPANY_NAME].value, '聯海通運');
  assert.strictEqual(record[F.COMPANY_NAME].disabled, true);
  assert.doesNotThrow(() => env.window.PR_COMPANY_NAME.apply({}), '沒有公司名稱欄位時不報錯');
});

// ── 結構：不再依賴已刪除的欄位 ──────────────────────────────────────────────
check('main 原始碼不再出現申請單位／請購庶務帶入／URL 參數的殘留', () => {
  const src = readSrc('payment_request_main_20260521.js');
  ['APPLY_UNIT', 'deriveCompanyNameByApplyUnit', 'getCompanyNameFromUrl', 'checkBoxValue', 'kintoneTransferData'].forEach((s) => {
    assert.ok(!src.includes(s), `不應殘留 ${s}`);
  });
});

done();
