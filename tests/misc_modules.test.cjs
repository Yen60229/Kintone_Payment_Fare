'use strict';

// 測試：作廢防呆_20260506.js 與其餘小模組的清理結果
//   ① 作廢防呆的動作名稱接 C.ACTIONS.VOID：作廢動作要二次確認、其他動作直接放行
//   ② 自動寬度欄位＝付款方式、申請人、申請人部門、費用所屬人、費用所屬人部門；左移（leftShift）整段刪除
//   ③ 其餘小模組沒有 723 其他類型的殘留
// 單獨執行：node tests/misc_modules.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
const prompts = [];
global.window = {
  prompt: (msg) => {
    prompts.push(msg);
    return global.window.__promptAnswer;
  },
};
global.kintone = {
  app: { getId: () => 749, record: {} },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types: [].concat(types), handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('作廢防呆_20260506.js'));

const C = global.window.PR_CONFIG;
const F = C.FIELDS;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('misc_modules.test.cjs');

// ── 作廢防呆 ───────────────────────────────────────────────────────────────

const voidHandler = registered.find((r) => r.types.includes('app.record.detail.process.proceed')).handler;
const FILE = [{ fileKey: 'k', name: 'a.pdf' }];
const proceedEvent = (action, nextStatus, { status = '草稿（未送出）', files = FILE } = {}) => ({
  action: { value: action },
  nextStatus: { value: nextStatus },
  status: { value: status },
  record: { $id: { value: '15' }, [F.ATTACHMENT]: { type: 'FILE', value: files } },
});

check('作廢防呆：動作名稱取自 C.ACTIONS.VOID（原始碼不再寫死 \'作廢\' 當動作名稱）', () => {
  const src = readSrc('作廢防呆_20260506.js');
  assert.ok(src.includes('ACTION_NAME: window.PR_CONFIG.ACTIONS.VOID'));
  assert.ok(!/ACTION_NAME:\s*'作廢'/.test(src));
  assert.strictEqual(C.ACTIONS.VOID, '作廢');
});

check('作廢防呆：非作廢動作直接放行、不跳確認', () => {
  prompts.length = 0;
  const event = proceedEvent(C.ACTIONS.APPLY_START, C.STATUS.APPLY_START);
  assert.strictEqual(voidHandler(event), event);
  assert.strictEqual(prompts.length, 0);
});

check('作廢防呆：作廢動作要輸入「作廢」確認（沒有 Swal 時退回 prompt）；輸入對才放行', () => {
  prompts.length = 0;
  const event = proceedEvent(C.ACTIONS.VOID, C.STATUS.VOID);
  global.window.__promptAnswer = '作廢';
  assert.strictEqual(voidHandler(event), event);
  assert.strictEqual(prompts.length, 1);
  assert.ok(prompts[0].includes('記錄號碼：15'));
  global.window.__promptAnswer = '亂打';
  assert.strictEqual(voidHandler(event), false);
});

check('附件防呆：草稿（未送出）按流程按鈕送出、附件沒檔案 → 擋下，用存檔防呆同一個錯誤視窗（說明改成按流程按鈕）', () => {
  const shown = [];
  global.window.PR_SHOW_VALIDATION = (title, errors, lead) => shown.push({ title, errors, lead });
  global.Swal = {};
  try {
    assert.strictEqual(voidHandler(proceedEvent('提交單位主管3確認', '申請單位主管3確認中', { files: [] })), false);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].title, '無法送出');
    assert.ok(shown[0].errors[0].includes('「發票/憑證」') && shown[0].errors[0].includes('\n※ '));
    assert.ok(shown[0].lead.includes('流程按鈕'));
    // 有檔案 → 放行
    const ok = proceedEvent('提交單位主管3確認', '申請單位主管3確認中');
    assert.strictEqual(voidHandler(ok), ok);
    // 不是草稿（例如主管確認中按核准）→ 不檢查附件
    const approve = proceedEvent('核准', '單位會計處理中', { status: '申請單位主管3確認中', files: [] });
    assert.strictEqual(voidHandler(approve), approve);
    // 報銷人填單 → 點擊流程開始（還沒送出簽核）→ 不檢查
    const start = proceedEvent('點擊流程開始', C.STATUS.APPLY_START, { status: C.STATUS.REIMBURSEMENT_FILL, files: [] });
    assert.strictEqual(voidHandler(start), start);
    assert.strictEqual(shown.length, 1);
  } finally {
    delete global.window.PR_SHOW_VALIDATION;
    delete global.Swal;
  }
});

check('附件防呆：草稿沒附件但按的是作廢 → 走作廢確認，不擋附件', () => {
  prompts.length = 0;
  global.window.__promptAnswer = '作廢';
  const event = proceedEvent(C.ACTIONS.VOID, C.STATUS.VOID, { files: [] });
  assert.strictEqual(voidHandler(event), event);
  assert.strictEqual(prompts.length, 1);
});

check('附件防呆：沒有 Swal 時退回 alert', () => {
  const alerts = [];
  global.window.alert = (m) => alerts.push(m);
  assert.strictEqual(voidHandler(proceedEvent('提交單位會計入帳', '單位會計處理中', { files: [] })), false);
  assert.strictEqual(alerts.length, 1);
  delete global.window.alert;
});

check('submit 對外提供 PR_SHOW_VALIDATION，視窗上方說明可換', () => {
  const src = readSrc('payment_request_submit_20260506.js');
  assert.ok(src.includes('window.PR_SHOW_VALIDATION = showValidationErrors'));
  assert.ok(/const showValidationErrors = \(title, errors, lead\)/.test(src));
});

check('作廢防呆：只看下一狀態是作廢也算作廢動作', () => {
  prompts.length = 0;
  global.window.__promptAnswer = '';
  assert.strictEqual(voidHandler(proceedEvent('別的動作名', C.STATUS.VOID)), false);
  assert.strictEqual(prompts.length, 1);
});

// ── 其餘小模組 ─────────────────────────────────────────────────────────────

check('其餘小模組沒有 723 其他類型的殘留（類型、回寫來源單、交際費簽核判定、docs 連結）', () => {
  [
    'coding_tools.js',
    'file_reader.js',
    '存檔等待提示_20260923.js',
    '作廢防呆_20260506.js',
    '請款單作廢_style_20260506.js',
    '轉至其他會計單位按鈕處理_20250723.js',
    '開發人員用群組欄位.js',
    '流程自動推進_20260810.js',
  ].forEach((name) => {
    const src = readSrc(name);
    ['F.TYPE', 'EMPLOYEE_NAME', '回寫來源單', '交際費簽核判定', '簽核判定', 'docs/1', 'ENT_SIGN'].forEach((s) => assert.ok(!src.includes(s), `${name}: ${s}`));
  });
});

console.log(`${passed} assertions passed.`);
