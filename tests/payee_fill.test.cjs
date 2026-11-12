'use strict';

// 測試：受款人填寫設定_20250902.js
//   「同申請人」按鈕：填入「員工代碼 中文姓名」；沒填申請人要報錯；只在 create.show／edit.show 掛按鈕且不重複掛。
// 單獨執行：node tests/payee_fill.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
const alerts = [];
let currentRecord = null;
const spaceHost = { children: [], appendChild(el) { el.parentNode = this; this.children.push(el); } };
const domById = {};

const makeEl = () => {
  const listeners = {};
  return {
    style: {},
    textContent: '',
    addEventListener: (type, fn) => (listeners[type] = fn),
    click: () => listeners.click.call({ style: {} }),
    remove() {},
    parentNode: null,
    _listeners: listeners,
  };
};

global.alert = (m) => alerts.push(m);
global.setTimeout = () => 0; // 成功訊息的淡出計時器不必真的跑
global.document = {
  createElement: () => makeEl(),
  getElementById: (id) => domById[id] || null,
  head: { appendChild() {} },
};
global.window = {};
global.kintone = {
  app: {
    getId: () => 749,
    record: {
      get: () => ({ record: currentRecord }),
      set: ({ record }) => (currentRecord = record),
      getSpaceElement: () => spaceHost,
    },
  },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('受款人填寫設定_20250902.js'));

const F = global.window.PR_CONFIG.FIELDS;
const P = global.window.PR_PAYEE;

let passed = 0;
// 依序執行（有些項目是 async）：每一項等前一項跑完
let queue = Promise.resolve();
const check = (label, fn) => {
  queue = queue.then(async () => {
    await fn();
    passed += 1;
    console.log(`  ok - ${label}`);
  });
};

console.log('payee_fill.test.cjs');

const recordWithApplicant = (applicant) => ({
  [F.APPLICANT]: { value: applicant ? [applicant] : [] },
  [F.PAYEE]: { value: '' },
});

check('組字：員工代碼 + 空白 + 括號內的中文姓名', () => {
  const info = P.getApplicantInfo(recordWithApplicant({ code: '24136', name: 'Jimmy (王小明)' }));
  assert.strictEqual(info.error, undefined);
  assert.strictEqual(info.code, '24136');
  assert.strictEqual(info.name, '王小明');
  assert.strictEqual(info.fullName, '24136 王小明');
});

check('組字：名稱沒有括號就整串當中文姓名', () => {
  assert.strictEqual(P.getApplicantInfo(recordWithApplicant({ code: '24145', name: '陳大文' })).fullName, '24145 陳大文');
});

check('組字：缺代碼只留姓名、不留前導空白', () => {
  assert.strictEqual(P.getApplicantInfo(recordWithApplicant({ name: '陳大文' })).fullName, '陳大文');
});

check('沒填申請人 → 回錯誤訊息', () => {
  assert.deepStrictEqual(P.getApplicantInfo(recordWithApplicant(null)), { error: '請先填寫申請人' });
  assert.deepStrictEqual(P.getApplicantInfo({}), { error: '請先填寫申請人' });
});

check('只取申請人（723 的「員工姓名」改成 749 的「申請人」），費用所屬人不影響結果', () => {
  const record = { ...recordWithApplicant({ code: 'A1', name: '甲' }), [F.EXPENSE_OWNER]: { value: [{ code: 'B2', name: '乙' }] } };
  assert.strictEqual(P.getApplicantInfo(record).fullName, 'A1 甲');
});

check('事件：只掛 create.show／edit.show，沒有任何 change 事件', () => {
  const all = registered.flatMap((r) => (Array.isArray(r.types) ? r.types : [r.types]));
  assert.deepStrictEqual(all.sort(), ['app.record.create.show', 'app.record.edit.show']);
});

let button = null;
let pickButton = null;
check('掛按鈕：「同申請人」「選擇員工」依序放進 apply_button 空白欄位', () => {
  const event = { record: recordWithApplicant({ code: '24136', name: '王小明' }) };
  assert.strictEqual(P.handleShow(event), event);
  assert.strictEqual(spaceHost.children.length, 2);
  button = spaceHost.children[0];
  assert.strictEqual(button.id, 'same-applicant-btn');
  assert.strictEqual(button.textContent, '同申請人');
  assert.strictEqual(button.type, 'button');
  pickButton = spaceHost.children[1];
  assert.strictEqual(pickButton.id, 'pick-employee-btn');
  assert.strictEqual(pickButton.textContent, '選擇員工');
  assert.strictEqual(pickButton.type, 'button');
  assert.strictEqual(pickButton.className, 'pr-pick-employee-btn');
});

check('不重複掛：頁面上已有按鈕時再進 show 不會多出來', () => {
  domById['same-applicant-btn'] = button;
  domById['pick-employee-btn'] = pickButton;
  P.handleShow({ record: {} });
  assert.strictEqual(spaceHost.children.length, 2);
});

check('點按鈕：受款人寫入「員工代碼 中文姓名」；「✓ 已複製」放在「選擇員工」右邊', () => {
  currentRecord = recordWithApplicant({ code: '24136', name: 'Jimmy (王小明)' });
  const placed = [];
  pickButton.after = (el) => placed.push(el);
  button.click();
  assert.strictEqual(currentRecord[F.PAYEE].value, '24136 王小明');
  assert.strictEqual(alerts.length, 0);
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(placed[0].textContent, ' ✓ 已複製');
  assert.strictEqual(placed[0].className, 'pr-copied-msg');
  delete pickButton.after;
});

check('點按鈕但沒填申請人 → alert 錯誤、受款人不動', () => {
  currentRecord = recordWithApplicant(null);
  currentRecord[F.PAYEE].value = '原值';
  button.click();
  assert.deepStrictEqual(alerts, ['請先填寫申請人']);
  assert.strictEqual(currentRecord[F.PAYEE].value, '原值');
  alerts.length = 0;
});

check('新增時自動帶：受款人空白 → 填入申請人「員工代碼 中文姓名」，回傳同一個 event', () => {
  const create = registered.find((r) => r.types === 'app.record.create.show');
  assert.ok(create, 'create.show 要有自己的 handler');
  const event = { record: recordWithApplicant({ code: '24136', name: 'Jimmy (王小明)' }) };
  assert.strictEqual(create.handler(event), event);
  assert.strictEqual(event.record[F.PAYEE].value, '24136 王小明');
  assert.strictEqual(alerts.length, 0);
});

check('新增時自動帶：受款人已有值不覆蓋；只有空白字元視為空白', () => {
  const create = registered.find((r) => r.types === 'app.record.create.show');
  const keep = { record: recordWithApplicant({ code: '24136', name: '王小明' }) };
  keep.record[F.PAYEE].value = '別人';
  create.handler(keep);
  assert.strictEqual(keep.record[F.PAYEE].value, '別人');
  const blank = { record: recordWithApplicant({ code: '24136', name: '王小明' }) };
  blank.record[F.PAYEE].value = '  ';
  create.handler(blank);
  assert.strictEqual(blank.record[F.PAYEE].value, '24136 王小明');
});

check('新增時自動帶：申請人沒填 → 受款人不動、不跳 alert', () => {
  const create = registered.find((r) => r.types === 'app.record.create.show');
  const event = { record: recordWithApplicant(null) };
  create.handler(event);
  assert.strictEqual(event.record[F.PAYEE].value, '');
  assert.strictEqual(alerts.length, 0);
});

check('編輯時不自動帶：edit.show 受款人維持空白', () => {
  const edit = registered.find((r) => r.types === 'app.record.edit.show');
  assert.ok(edit);
  const event = { record: recordWithApplicant({ code: '24136', name: '王小明' }) };
  assert.strictEqual(edit.handler(event), event);
  assert.strictEqual(event.record[F.PAYEE].value, '');
});

// ── 「選擇員工」選人視窗 ──────────────────────────────────────────────────
check('選人：中文姓名取括號內（半形／全形），沒有括號用整個名稱；受款人＝「代碼 中文姓名」', () => {
  assert.strictEqual(P.chineseNameOf('Wang Xiao Ming(王小明)'), '王小明');
  assert.strictEqual(P.chineseNameOf('Wang（王小明）'), '王小明');
  assert.strictEqual(P.chineseNameOf('陳大文'), '陳大文');
  assert.strictEqual(P.toPayeeText({ code: '00546', name: 'Wang (王小明)' }), '00546 王小明');
});

check('選人：只留啟用、有代碼的帳號，依代碼排序', () => {
  const list = P.normalizeUsers([
    { code: '00900', name: 'B (乙)' },
    { code: '00100', name: 'A (甲)' },
    { code: '00200', name: '停用', valid: false },
    { code: '', name: '沒代碼' },
    null,
  ]);
  assert.deepStrictEqual(list.map((u) => u.payee), ['00100 甲', '00900 乙']);
});

check('選人：關鍵字每段都要符合、不分大小寫；空關鍵字回傳全部', () => {
  const users = P.normalizeUsers([
    { code: '00100', name: 'Wang (王小明)' },
    { code: '00200', name: 'Chen (陳大文)' },
  ]);
  assert.strictEqual(P.filterUsers(users, '').length, 2);
  assert.deepStrictEqual(P.filterUsers(users, 'wang').map((u) => u.code), ['00100']);
  assert.deepStrictEqual(P.filterUsers(users, '002 陳').map((u) => u.code), ['00200']);
  assert.strictEqual(P.filterUsers(users, '00100 陳').length, 0);
});

check('選人：清單 HTML 跳脫特殊字元；沒有結果顯示提示；超過上限只列前面並提示', () => {
  const html = P.buildListHtml([{ code: '<1>', name: '"x"' }]);
  assert.ok(html.includes('&lt;1&gt;') && html.includes('&quot;x&quot;') && !html.includes('<1>'));
  assert.ok(P.buildListHtml([]).includes('pr-emp-empty'));
  const many = Array.from({ length: P.MAX_LIST + 3 }, (_, i) => ({ code: String(i), name: `n${i}` }));
  const big = P.buildListHtml(many);
  assert.strictEqual((big.match(/pr-emp-item/g) || []).length, P.MAX_LIST);
  assert.ok(big.includes('還有 3 位沒有列出'));
});

check('選人：抓使用者分頁到不足一頁為止', async () => {
  const calls = [];
  global.kintone.api = { url: (p) => p };
  const page = (n, start) => Array.from({ length: n }, (_, i) => ({ code: String(start + i).padStart(5, '0'), name: 'x' }));
  const api = async (url, method, params) => {
    calls.push(params.offset);
    return { users: params.offset === 0 ? page(100, 0) : page(5, 100) };
  };
  const list = await P.fetchAllUsers(api);
  assert.deepStrictEqual(calls, [0, 100]);
  assert.strictEqual(list.length, 105);
});

check('選擇員工：沒有 SweetAlert 開不了視窗 → alert 提示手動輸入、受款人不動', () => {
  alerts.length = 0;
  currentRecord = recordWithApplicant(null);
  currentRecord[F.PAYEE].value = '原值';
  pickButton.click();
  assert.deepStrictEqual(alerts, ['無法開啟人員清單，請直接在受款人欄輸入「5 碼員工編號＋中文姓名」']);
  assert.strictEqual(currentRecord[F.PAYEE].value, '原值');
});

check('選擇員工：受款人是 5 碼開頭用員工編號當關鍵字；選一位寫入受款人並在按鈕右邊顯示「✓ 已選擇」', () => {
  const fired = [];
  global.Swal = { fire: (opts) => fired.push(opts), close: () => {} };
  alerts.length = 0;
  currentRecord = recordWithApplicant(null);
  currentRecord[F.PAYEE].value = '00546 王小明';
  const placed = [];
  pickButton.after = (el) => placed.push(el);
  pickButton.click();
  assert.strictEqual(fired.length, 1);
  assert.ok(fired[0].html.includes('value="00546"'));
  assert.strictEqual(fired[0].customClass.popup, 'pr-emp-picker');
  // 模擬視窗：取得 didOpen 綁的事件，載入清單後點第一位
  const listeners = {};
  const listEl = { innerHTML: '', addEventListener: (t, fn) => (listeners['list:' + t] = fn) };
  const input = { value: '00777', focus() {}, addEventListener: (t, fn) => (listeners['input:' + t] = fn) };
  const popup = { querySelector: (sel) => (sel === '.pr-emp-search' ? input : listEl) };
  // 不打真的 API：讓 loadUsers 拿到假清單
  global.kintone.api = Object.assign(async () => ({ users: [{ code: '00777', name: 'Lin (林小華)' }] }), { url: (p) => p });
  fired[0].didOpen(popup);
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.ok(listEl.innerHTML.includes('林小華'));
    listeners['list:click']({ target: { closest: () => ({ dataset: { index: '0' } }) } });
    assert.strictEqual(currentRecord[F.PAYEE].value, '00777 林小華');
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].textContent, ' ✓ 已選擇');
    assert.strictEqual(alerts.length, 0);
    delete global.Swal;
    delete pickButton.after;
  });
});

check('原始碼不含類型判斷、舊的「同費用所屬人」按鈕與 723 員工姓名欄位', () => {
  const src = readSrc('受款人填寫設定_20250902.js');
  ['F.TYPE', 'COMPANY_TYPES', 'EMPLOYEE_NAME', 'same-expense-owner-btn', '同費用所屬人', 'F.EXPENSE_OWNER'].forEach((s) => assert.ok(!src.includes(s), s));
});

queue
  .then(() => console.log(`${passed} assertions passed.`))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
