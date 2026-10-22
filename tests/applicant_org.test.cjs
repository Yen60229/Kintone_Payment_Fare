'use strict';

// 測試：申請人部門帶入_20261022.js
//   申請人部門鎖住、只依申請人帶入：
//     - create.show：目前部門是申請人的單位 → 不動；空白或不是他的單位（複製別人的單）→ 重新帶入
//     - 改申請人 → 查新申請人的單位帶入；清空申請人 → 部門清空
//   1 個單位直接帶；多個跳視窗（共用簽核人員程式的 PR_ORG_PICKER），目前部門不是他的單位時不給取消。
// 單獨執行：node tests/applicant_org.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('applicant_org.test.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 6; i++) await wait(0);
};
const plain = (v) => JSON.parse(JSON.stringify(v));
const org = (code, name, primary = false) => ({ organization: { code, name, primary }, title: null });
const ORG_A = org('A', '物流部-業務企劃課');
const ORG_B = org('B', '總務部-資訊課', true);
const ORG_C = org('C', '總務部');

/**
 * 載入 config＋簽核人員程式（提供 PR_ORG_PICKER）＋申請人部門模組，只取申請人部門模組自己註冊的事件。
 * @param {Object} o
 * @param {Object<string,Array>} [o.orgs] 使用者代碼 → organizationTitles
 * @param {Object<string,number>} [o.delay] 使用者代碼 → 查詢延遲毫秒
 * @param {Object|Function} [o.swalAnswer]
 * @param {boolean} [o.apiFail]
 */
const setup = ({ orgs = {}, delay = {}, swalAnswer = { isConfirmed: false }, apiFail = false } = {}) => {
  const calls = [];
  const env = createEnv({
    loginCode: 'someone',
    swalAnswer,
    api: (url, method, params) => {
      calls.push({ url, params });
      if (apiFail) return Promise.reject(new Error('boom'));
      if (url === '/v1/user/organizations.json') return wait(delay[params.code] || 0).then(() => ({ organizationTitles: orgs[params.code] || [] }));
      return Promise.resolve({ records: [] });
    },
  });
  env.load('payment_request_config.js');
  env.load('signing_personnel_manager_20260506.js');
  const before = env.handlers.length;
  env.load('申請人部門帶入_20261022.js');
  const mine = env.handlers.slice(before);
  const F = env.window.PR_CONFIG.FIELDS;
  /** 只觸發申請人部門模組的處理程式（同步回傳值照原樣交回） */
  const fire = (type, record) => {
    env.currentRecord = plain(record);
    const ev = { type, record };
    let out = ev;
    mine.filter((h) => h.types.includes(type)).forEach((h) => (out = h.handler(ev)));
    return out;
  };
  const record = ({ applicant = 'u1', name = '王小明', dept = [] } = {}) => ({
    [F.APPLICANT]: { value: applicant ? [{ code: applicant, name }] : [] },
    [F.APPLICANT_ORG]: { value: dept },
    [F.EXPENSE_OWNER_ORG]: { value: [{ code: 'OWNER_ORG', name: '費用所屬人部門' }] },
  });
  return { env, calls, mine, fire, record, F };
};

check('事件註冊：create.show、新增／編輯的 change.申請人', () => {
  const { mine, F } = setup();
  const types = mine.flatMap((h) => h.types);
  ['app.record.create.show', `app.record.create.change.${F.APPLICANT}`, `app.record.edit.change.${F.APPLICANT}`].forEach((t) => assert.ok(types.includes(t), t));
  assert.ok(!types.includes('app.record.edit.show'), '編輯畫面打開不重帶');
});

check('處理程式同步回傳 event（不是 Promise）', () => {
  const { fire, record, F } = setup({ orgs: { u1: [ORG_A] } });
  const rec = record();
  const out = fire(`app.record.create.change.${F.APPLICANT}`, rec);
  assert.strictEqual(out.record, rec);
  assert.ok(!(out instanceof Promise));
});

check('create.show：部門就是申請人的單位 → 不跳視窗、不寫回', async () => {
  const { env, fire, record } = setup({ orgs: { u1: [ORG_A, ORG_B] } });
  fire('app.record.create.show', record({ dept: [{ code: 'B', name: '總務部-資訊課' }] }));
  await flush();
  assert.strictEqual(env.swalCalls.length, 0);
  assert.strictEqual(env.setCalls.length, 0);
});

check('create.show：部門空白、1 個單位 → 直接帶入並保持鎖住', async () => {
  const { env, fire, record, F } = setup({ orgs: { u1: [ORG_A] } });
  fire('app.record.create.show', record());
  await flush();
  assert.strictEqual(env.swalCalls.length, 0);
  assert.deepStrictEqual(plain(env.currentRecord[F.APPLICANT_ORG].value), [{ code: 'A', name: '物流部-業務企劃課' }]);
  assert.strictEqual(env.currentRecord[F.APPLICANT_ORG].disabled, true);
});

check('create.show：部門不是申請人的單位（複製別人的單）、多個單位 → 跳視窗、不給取消、預選主要單位，選了才帶入', async () => {
  const { env, fire, record, F } = setup({ orgs: { u1: [ORG_A, ORG_B, ORG_C] }, swalAnswer: { isConfirmed: true, value: '2' } });
  fire('app.record.create.show', record({ dept: [{ code: 'OTHER', name: '別人的部門' }] }));
  await flush();
  assert.strictEqual(env.swalCalls.length, 1);
  const opts = env.swalCalls[0];
  assert.strictEqual(opts.title, '請選擇申請人部門');
  assert.match(opts.text, /王小明 有 3 個所屬單位/);
  assert.strictEqual(opts.inputValue, '1');
  assert.strictEqual(opts.showCancelButton, false);
  assert.strictEqual(opts.allowEscapeKey, false);
  assert.deepStrictEqual(plain(env.currentRecord[F.APPLICANT_ORG].value), [{ code: 'C', name: '總務部' }]);
});

check('改申請人：原部門也是新申請人的單位 → 視窗可取消；按取消不寫回', async () => {
  const { env, fire, record, F } = setup({ orgs: { u2: [ORG_A, ORG_B] }, swalAnswer: { isConfirmed: false } });
  fire(`app.record.edit.change.${F.APPLICANT}`, record({ applicant: 'u2', dept: [{ code: 'A', name: '物流部-業務企劃課' }] }));
  await flush();
  assert.strictEqual(env.swalCalls[0].showCancelButton, true);
  assert.strictEqual(env.setCalls.length, 0);
});

check('改申請人：即使原部門有效也一樣讓使用者選（只有新增畫面打開時才保留）', async () => {
  const { env, fire, record, F } = setup({ orgs: { u2: [ORG_A, ORG_B] }, swalAnswer: { isConfirmed: true, value: '1' } });
  fire(`app.record.create.change.${F.APPLICANT}`, record({ applicant: 'u2', dept: [{ code: 'A', name: '物流部-業務企劃課' }] }));
  await flush();
  assert.strictEqual(env.swalCalls.length, 1);
  assert.deepStrictEqual(plain(env.currentRecord[F.APPLICANT_ORG].value), [{ code: 'B', name: '總務部-資訊課' }]);
});

check('清空申請人：部門跟著清空，不查單位', async () => {
  const { calls, fire, record, F } = setup();
  const out = fire(`app.record.edit.change.${F.APPLICANT}`, record({ applicant: null, dept: [{ code: 'A', name: 'x' }] }));
  await flush();
  assert.strictEqual(out.record[F.APPLICANT_ORG].value.length, 0);
  assert.strictEqual(calls.length, 0);
});

check('申請人沒有任何所屬單位 → 警告「此申請人沒有所屬單位」，部門不動', async () => {
  const { env, fire, record } = setup({ orgs: { u1: [] } });
  fire('app.record.create.show', record({ dept: [{ code: 'A', name: 'x' }] }));
  await flush();
  assert.strictEqual(env.swalCalls.length, 1);
  assert.strictEqual(env.swalCalls[0].title, '此申請人沒有所屬單位');
  assert.strictEqual(env.setCalls.length, 0);
});

check('連續改兩次申請人（先改的查得慢）：只寫回最後一次', async () => {
  const { env, fire, record, F } = setup({ orgs: { u1: [ORG_A], u2: [ORG_C] }, delay: { u1: 20 } });
  const ev1 = record({ applicant: 'u1' });
  fire(`app.record.create.change.${F.APPLICANT}`, ev1);
  // 第二次觸發時畫面上的記錄已是 u2（fire 會把 currentRecord 換掉）
  fire(`app.record.create.change.${F.APPLICANT}`, record({ applicant: 'u2' }));
  await wait(40);
  await flush();
  assert.strictEqual(env.setCalls.length, 1);
  assert.deepStrictEqual(plain(env.currentRecord[F.APPLICANT_ORG].value), [{ code: 'C', name: '總務部' }]);
});

check('只動申請人部門，不碰費用所屬人部門', async () => {
  const { env, fire, record, F } = setup({ orgs: { u1: [ORG_A] } });
  fire('app.record.create.show', record());
  await flush();
  assert.deepStrictEqual(plain(env.currentRecord[F.EXPENSE_OWNER_ORG].value), [{ code: 'OWNER_ORG', name: '費用所屬人部門' }]);
});

check('查詢失敗：記錄錯誤、不寫回、不丟例外', async () => {
  const { env, fire, record } = setup({ apiFail: true });
  fire('app.record.create.show', record());
  await flush();
  assert.strictEqual(env.setCalls.length, 0);
  assert.ok(env.logs.error.some((m) => m.includes('[申請人部門]')), env.logs.error.join('\n'));
});

check('原始檔：欄位代碼走 F.*，沒有用字面值取申請人／申請人部門欄位（「申請人」只出現在畫面文字）', () => {
  const src = readSrc('申請人部門帶入_20261022.js').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\[\s*['"`]申請人(部門)?['"`]\s*\]/.test(src));
  assert.ok(!/change\.申請人/.test(src));
  assert.ok(src.includes('F.APPLICANT_ORG') && src.includes('F.APPLICANT'));
});

done();
