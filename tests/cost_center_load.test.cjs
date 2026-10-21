'use strict';

// 測試：費用歸屬主檔載入（payment_request_main 的 loadCostCenterMaps）
//   只讀 CODE／LOCATION／NAME 三個欄位，建出 代號→據點、代號→中文名稱、「使用中」代碼集合；
//   同一個代號可以建多筆記錄：據點／名稱保留第一筆非空值，不同就警告；
//   對外只暴露 window.PR_COST_CENTER = { ensureLoaded, getValidCodes }。
// 單獨執行：node tests/cost_center_load.test.cjs

const assert = require('assert');
const { createEnv, createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('cost_center_load.test.cjs');

// 費用歸屬主檔自己的欄位代碼（來自 config，不寫死）
const CCf = (() => {
  const e = createEnv();
  e.load('payment_request_config.js');
  return e.window.PR_CONFIG.REF_FIELDS.COST_CENTER;
})();

const rec = ({ code, loc = '', name = '' }) => ({
  [CCf.CODE]: { value: code },
  [CCf.LOCATION]: { value: loc },
  [CCf.NAME]: { value: name },
});

/** 載入 main，費用歸屬主檔由 records 提供；回傳 env、被呼叫的 api 參數與載入後的結果 */
const loadWith = async (records, { pages = null } = {}) => {
  const calls = [];
  const pageList = pages || [records];
  let pageNo = 0;
  const env = createEnv({
    appId: 749,
    api: (url, method, params) => {
      calls.push({ url, method, params });
      if (method === 'POST') return Promise.resolve({ id: 'cursor-1' });
      const records_ = pageList[pageNo];
      pageNo += 1;
      return Promise.resolve({ records: records_, next: pageNo < pageList.length });
    },
  });
  env.load('payment_request_config.js');
  env.load('payment_request_main_20260521.js');
  const CC = env.window.PR_CONFIG.REF_FIELDS.COST_CENTER;
  await env.window.PR_COST_CENTER.ensureLoaded();
  return { env, calls, CC, validCodes: [...env.window.PR_COST_CENTER.getValidCodes()] };
};

check('只向費用歸屬主檔要 CODE／LOCATION／NAME 三個欄位，且只查「使用中」', async () => {
  const { env, calls, CC } = await loadWith([]);
  const open = calls.find((c) => c.method === 'POST');
  assert.strictEqual(open.params.app, env.window.PR_CONFIG.APPS.COST_CENTER);
  assert.deepStrictEqual([...open.params.fields], [CC.CODE, CC.LOCATION, CC.NAME]);
  assert.strictEqual(open.params.query, `${CC.IN_USE} in ("使用中")`);
});

check('對外只暴露 ensureLoaded／getValidCodes（舊的 getMaps 已拿掉），且物件被凍結', async () => {
  const { env } = await loadWith([]);
  const api = env.window.PR_COST_CENTER;
  assert.deepStrictEqual(Object.keys(api).sort(), ['ensureLoaded', 'getValidCodes']);
  assert.ok(Object.isFrozen(api));
});

check('代碼集合保留原始大小寫、去掉前後空白、略過空白代碼', async () => {
  const { validCodes } = await loadWith([
    rec({ code: ' AJ30 ' }),
    rec({ code: 'aj31' }),
    rec({ code: '   ' }),
  ]);
  assert.deepStrictEqual(validCodes, ['AJ30', 'aj31']);
});

check('分頁（cursor 多頁）全部讀完', async () => {
  const { validCodes } = await loadWith(null, { pages: [[rec({ code: 'A1' })], [rec({ code: 'B2' })], [rec({ code: 'C3' })]] });
  assert.deepStrictEqual(validCodes, ['A1', 'B2', 'C3']);
});

check('同代號多筆記錄、據點或名稱不同 → 採用第一筆非空值，並警告管理者回主檔統一', async () => {
  const { env, validCodes } = await loadWith([
    rec({ code: 'AJ30', loc: '', name: '' }), // 空值不算
    rec({ code: 'AJ30', loc: 'TPE', name: '總務部' }),
    rec({ code: 'AJ30', loc: 'KHH', name: '高雄' }),
  ]);
  assert.deepStrictEqual(validCodes, ['AJ30'], '同代號只算一個');
  const warns = env.logs.warn.join('\n');
  assert.ok(warns.includes('AJ30') && warns.includes('據點') && warns.includes('TPE'), warns);
  assert.ok(warns.includes('名稱') && warns.includes('總務部'), warns);
});

check('多筆記錄的據點／名稱一致時不警告', async () => {
  const { env } = await loadWith([rec({ code: 'AJ30', loc: 'TPE', name: '總務部' }), rec({ code: 'AJ30', loc: 'TPE', name: '總務部' })]);
  assert.strictEqual(env.logs.warn.length, 0);
});

check('重複呼叫 ensureLoaded 共用同一次載入（只開一次 cursor）', async () => {
  const { env, calls } = await loadWith([]);
  await env.window.PR_COST_CENTER.ensureLoaded();
  await env.window.PR_COST_CENTER.ensureLoaded();
  assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 1);
});

check('載入失敗：丟出錯誤，且不快取失敗結果，下次呼叫會重試', async () => {
  let fail = true;
  const env = createEnv({
    appId: 749,
    api: (url, method) => {
      if (fail) return Promise.reject(new Error('boom'));
      return method === 'POST' ? Promise.resolve({ id: 'c' }) : Promise.resolve({ records: [rec({ code: 'X1' })], next: false });
    },
  });
  env.load('payment_request_config.js');
  env.load('payment_request_main_20260521.js');
  await assert.rejects(() => env.window.PR_COST_CENTER.ensureLoaded(), /boom/);
  fail = false;
  await env.window.PR_COST_CENTER.ensureLoaded();
  assert.deepStrictEqual([...env.window.PR_COST_CENTER.getValidCodes()], ['X1']);
});

check('主檔欄位代碼走 REF_FIELDS.COST_CENTER，不寫死；部門／部長／主管部門的讀取已全數移除', () => {
  const src = readSrc('payment_request_main_20260521.js');
  assert.ok(src.includes('C.REF_FIELDS.COST_CENTER'));
  ['CC.DEPT', 'CC.DIRECTOR', 'CC.OWNER', 'DEPTS_OF_CODE', 'DIRECTOR_OF_DEPT', 'OWNER_DEPT_OF_CODE', 'getMaps'].forEach((s) => {
    assert.ok(!src.includes(s), `不應殘留 ${s}`);
  });
});

done();
