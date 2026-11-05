'use strict';

// 回歸測試：流程自動推進_20260810.js
//   ① buildStatusBody —— 送出的是「動作名稱」而非狀態名稱；assignee 依 SEND_ASSIGNEE 決定送不送
//   ② shouldCompensate —— 只有「本人 × FROM_STATUS × 未作廢 × 有 $id」四條件全滿足才補償
//   ③ withTimeout —— 無回應的 Promise 會被轉成明確的 reject（避免 submit 永久轉圈）
//   ④ 結構斷言 —— detail.show 必須用 setTimeout 脫離同步流程（SHOW handler 禁止 async）
// 直接用 Node 執行：node tests/auto_advance_status.test.cjs
//
// 作法：從原始檔擷取函式本體隔離執行，並對原始碼做結構斷言。

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const srcPath = path.join(__dirname, '..', '流程自動推進_20260810.js');
const src = fs.readFileSync(srcPath, 'utf8');

const extract = (re, label) => {
  const m = src.match(re);
  assert.ok(m, `找不到 ${label}，來源檔可能已改結構，請同步更新本測試`);
  return m[0];
};

const isVoidedSrc = extract(/const isVoided = \(record\) =>.*;/, 'isVoided');
const getStatusSrc = extract(/const getStatus = \(record\) =>.*;/, 'getStatus');
const withTimeoutSrc = extract(/const withTimeout = \(promise, ms, label\) =>[\s\S]*?\n    \]\);/, 'withTimeout');
const buildStatusBodySrc = extract(/const buildStatusBody = \(recordId, assigneeCode\) => \{[\s\S]*?\n  \};/, 'buildStatusBody');
const shouldCompensateSrc = extract(/const shouldCompensate = \(record, loginCode\) => \{[\s\S]*?\n  \};/, 'shouldCompensate');

// 測試用替身：對應 payment_request_config.js 的實際值
const PRELUDE = `
  const C = {
    APPS: { PAYMENT: 749 },
    VOID_FIELD: '表單作廢',
    FIELDS: { STATUS_FIELD: '狀態', APPLICANT: '申請人' },
  };
  const F = C.FIELDS;
`;

const build = (configOverrides, fnSrcs, exposed) =>
  // eslint-disable-next-line no-new-func
  new Function(`
    ${PRELUDE}
    const CONFIG = Object.assign({
      ENABLED: true,
      FROM_STATUS: '報銷人填單',
      TO_STATUS: '草稿（未送出）',
      ACTION_NAME: '點擊流程開始',
      SEND_ASSIGNEE: true,
      COMPENSATE_ON_DETAIL: true,
    }, ${JSON.stringify(configOverrides)});
    ${fnSrcs.join('\n')}
    return { ${exposed.join(', ')} };
  `)();

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('auto_advance_status.test.cjs');

// ── ① buildStatusBody ──────────────────────────────────────────────────────

check('body 帶的是動作名稱（ACTION_NAME），不是目標狀態名稱', () => {
  const { buildStatusBody } = build({ ACTION_NAME: '點擊流程開始', TO_STATUS: '草稿（未送出）' }, [buildStatusBodySrc], ['buildStatusBody']);
  const body = buildStatusBody(123, 'u1');
  assert.strictEqual(body.action, '點擊流程開始');
  assert.strictEqual(body.app, 749);
  assert.ok(!('status' in body), 'API 不吃 status 欄位，不應送出');
  assert.notStrictEqual(body.action, '草稿（未送出）', 'action 誤用了 TO_STATUS');
});

check('recordId 一律轉成字串（kintone API 要求）', () => {
  const { buildStatusBody } = build({}, [buildStatusBodySrc], ['buildStatusBody']);
  assert.strictEqual(buildStatusBody(456, 'u1').id, '456');
});

check('SEND_ASSIGNEE=true 且有 code → 帶 assignee', () => {
  const { buildStatusBody } = build({ SEND_ASSIGNEE: true }, [buildStatusBodySrc], ['buildStatusBody']);
  assert.strictEqual(buildStatusBody(1, 'u1').assignee, 'u1');
});

check('SEND_ASSIGNEE=false → 不帶 assignee（下一關為自動指定時送了會 400）', () => {
  const { buildStatusBody } = build({ SEND_ASSIGNEE: false }, [buildStatusBodySrc], ['buildStatusBody']);
  assert.ok(!('assignee' in buildStatusBody(1, 'u1')));
});

check('沒有 assigneeCode → 不帶 assignee', () => {
  const { buildStatusBody } = build({ SEND_ASSIGNEE: true }, [buildStatusBodySrc], ['buildStatusBody']);
  assert.ok(!('assignee' in buildStatusBody(1, '')));
});

// ── ② shouldCompensate ─────────────────────────────────────────────────────

const compensateFns = [isVoidedSrc, getStatusSrc, shouldCompensateSrc];
const makeRecord = (over = {}) => ({
  $id: { value: '77' },
  狀態: { value: '報銷人填單' },
  表單作廢: { value: [] },
  申請人: { value: [{ code: 'u1' }] },
  建立人: { value: { code: 'u1' } },
  ...over,
});

check('本人 × FROM_STATUS × 未作廢 → 需要補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord(), 'u1'), true);
});

check('狀態已推進過 → 不補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord({ 狀態: { value: '草稿（未送出）' } }), 'u1'), false);
});

check('已作廢 → 不補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord({ 表單作廢: { value: ['表單作廢'] } }), 'u1'), false);
});

check('他人瀏覽 → 不補償（避免誤打 API）', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord(), 'other'), false);
});

check('登入者非申請人但為建立人 → 仍補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  const record = makeRecord({ 申請人: { value: [{ code: 'someoneElse' }] }, 建立人: { value: { code: 'u1' } } });
  assert.strictEqual(shouldCompensate(record, 'u1'), true);
});

check('只認建立人：登入者是申請人但不是建立人 → 不補償；建立人欄位缺漏 → 不補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  const asApplicantOnly = makeRecord({ 申請人: { value: [{ code: 'u1' }] }, 建立人: { value: { code: 'creator' } } });
  assert.strictEqual(shouldCompensate(asApplicantOnly, 'u1'), false);
  assert.strictEqual(shouldCompensate(makeRecord({ 建立人: undefined }), 'u1'), false);
});

check('$id 缺漏或為 0 → 不補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord({ $id: { value: '0' } }), 'u1'), false);
  assert.strictEqual(shouldCompensate(makeRecord({ $id: undefined }), 'u1'), false);
});

check('loginCode 為空 → 不補償', () => {
  const { shouldCompensate } = build({}, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord(), ''), false);
});

check('COMPENSATE_ON_DETAIL=false → 一律不補償', () => {
  const { shouldCompensate } = build({ COMPENSATE_ON_DETAIL: false }, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord(), 'u1'), false);
});

check('ENABLED=false → 一律不補償', () => {
  const { shouldCompensate } = build({ ENABLED: false }, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord(), 'u1'), false);
});

check('FROM_STATUS 改名後，判斷跟著改名走（狀態名稱可自由更換）', () => {
  const { shouldCompensate } = build({ FROM_STATUS: '未處理' }, compensateFns, ['shouldCompensate']);
  assert.strictEqual(shouldCompensate(makeRecord({ 狀態: { value: '未處理' } }), 'u1'), true);
  assert.strictEqual(shouldCompensate(makeRecord({ 狀態: { value: '報銷人填單' } }), 'u1'), false);
});

// ── ③ withTimeout ──────────────────────────────────────────────────────────

const { withTimeout } = build({}, [withTimeoutSrc], ['withTimeout']);

const asyncChecks = (async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(() => withTimeout(neverSettles, 20, '流程推進'), /流程推進逾時/);
  passed += 1;
  console.log('  ok - 無回應的 Promise 會在逾時後 reject（不會卡住 submit）');

  assert.strictEqual(await withTimeout(Promise.resolve('ok'), 1000, '流程推進'), 'ok');
  passed += 1;
  console.log('  ok - 正常回應在逾時前 resolve，值原樣傳回');
})();

// ── ④ 結構斷言 ─────────────────────────────────────────────────────────────

check('設定值一律取自 config，模組內不得自帶或寫死', () => {
  assert.ok(/const CONFIG = C\.AUTO_ADVANCE;/.test(src), 'CONFIG 未接 PR_CONFIG.AUTO_ADVANCE');
  assert.ok(!/const CONFIG = \{/.test(src), '模組內不應自建 CONFIG 物件');
  // 狀態／動作字面值只能出現在 config，模組內不得再寫一份
  ['報銷人填單', '草稿（未送出）', '點擊流程開始'].forEach((literal) => {
    assert.ok(!new RegExp(`['"]${literal}['"]`).test(src), `模組內出現寫死的狀態／動作字串「${literal}」`);
  });
});

check('有註冊 create.submit.success 並呼叫 advanceStatus', () => {
  // 事件走 PR_KT.on（桌面版／手機版共用），見 payment_request_config.js
  const m = src.match(/KT\.on\('app\.record\.create\.submit\.success'[\s\S]*?\n  \}\);/);
  assert.ok(m, '找不到 create.submit.success 事件註冊');
  assert.ok(m[0].includes('advanceStatus('), 'create.submit.success 未呼叫 advanceStatus');
  assert.ok(/silent:\s*true/.test(m[0]), '建單推進應為靜默（失敗交由詳細頁補償）');
});

check('detail.show 用 setTimeout 脫離同步流程（SHOW handler 禁止 async）', () => {
  const m = src.match(/KT\.on\('app\.record\.detail\.show'[\s\S]*?\n  \}\);/);
  assert.ok(m, '找不到 detail.show 事件註冊');
  assert.ok(/setTimeout\(\(\) => compensateIfNeeded/.test(m[0]), 'detail.show 未透過 setTimeout 呼叫補償');
  assert.ok(!/async \(event\)/.test(m[0]), 'SHOW handler 不可為 async');
});

check('補償流程有防迴圈守衛（reload 前先設旗標）', () => {
  const m = src.match(/async function compensateIfNeeded\(record\)[\s\S]*?\n  \}/);
  assert.ok(m, '找不到 compensateIfNeeded');
  const body = m[0];
  assert.ok(body.includes('guardGet('), '缺少守衛檢查');
  assert.ok(body.indexOf('guardSet(') < body.indexOf('window.location.reload'), '必須先設旗標再 reload，否則會無限重載');
});

asyncChecks.then(() => {
  console.log(`\n${passed} 項斷言全部通過`);
});
