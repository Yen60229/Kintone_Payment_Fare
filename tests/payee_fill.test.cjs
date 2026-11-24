'use strict';

// 測試：受款人填寫設定.js
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
const { loadInto } = require('./lib/esm_loader.cjs');
loadInto(null, '使用者主檔快取.js');
const P = loadInto(null, '受款人填寫設定.js');

const F = global.window.PR_CONFIG.FIELDS;

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

check('新增／編輯都不自動帶申請人：受款人維持原值（欄位已鎖住，只能用按鈕填）', () => {
  const show = registered.find((r) => Array.isArray(r.types) && r.types.includes('app.record.create.show'));
  assert.ok(show && show.types.includes('app.record.edit.show'));
  const event = { record: recordWithApplicant({ code: '24136', name: '王小明' }) };
  assert.strictEqual(show.handler(event), event);
  assert.strictEqual(event.record[F.PAYEE].value, '');
  assert.strictEqual(P.autoFillPayee, undefined);
});

check('存檔檢查用：只查傳入的編號（去重、非 5 碼略過），回傳主檔查不到的', async () => {
  const calls = [];
  const api = async (url, method, params) => (calls.push([url, method, params]), { records: [{ five_digit_num: { value: '00546' } }] });
  assert.deepStrictEqual(await P.findMissingAccounts(['00546', '12345', '00546', '王', ''], api), ['12345']);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][2].query, 'five_digit_num in ("00546", "12345") limit 500');
  assert.deepStrictEqual(await P.findMissingAccounts([], api), []);
  assert.strictEqual(calls.length, 1, '沒有編號不打 API');
});

// ── 「選擇員工」選人視窗 ──────────────────────────────────────────────────
check('選人：中文姓名取括號內（半形／全形），沒有括號用整個名稱；受款人＝「代碼 中文姓名」', () => {
  assert.strictEqual(P.chineseNameOf('Wang Xiao Ming(王小明)'), '王小明');
  assert.strictEqual(P.chineseNameOf('Wang（王小明）'), '王小明');
  assert.strictEqual(P.chineseNameOf('陳大文'), '陳大文');
  assert.strictEqual(P.toPayeeText({ code: '00546', name: 'Wang (王小明)' }), '00546 王小明');
});

const acc = (code, name, id = 1) => ({ $id: { value: String(id) }, five_digit_num: { value: code }, chinese_name: { value: name } });

check('選人：主檔記錄 → 只留有員工編號的、同編號留第一筆，依編號排序；受款人＝「編號 姓名」', () => {
  const list = P.normalizeAccounts([acc('00900', '乙'), acc('00100', ' 甲 '), acc('', '沒編號'), acc('00100', '重複'), null]);
  assert.deepStrictEqual(list.map((u) => u.payee), ['00100 甲', '00900 乙']);
});

check('選人：關鍵字每段都要符合、不分大小寫；空關鍵字回傳全部', () => {
  const users = P.normalizeAccounts([acc('00100', 'Wang (王小明)'), acc('00200', 'Chen (陳大文)')]);
  assert.strictEqual(P.filterUsers(users, '').length, 2);
  assert.deepStrictEqual(P.filterUsers(users, 'wang').map((u) => u.code), ['00100']);
  assert.deepStrictEqual(P.filterUsers(users, '002 陳').map((u) => u.code), ['00200']);
  assert.strictEqual(P.filterUsers(users, '00100 陳').length, 0);
});

check('選人：清單 HTML 跳脫特殊字元；沒有結果顯示提示；超過上限只列前面並提示', () => {
  const html = P.buildListHtml([{ code: '<1>', name: '"x"' }]);
  assert.ok(html.includes('&lt;1&gt;') && html.includes('&quot;x&quot;') && !html.includes('<1>'));
  assert.ok(P.buildListHtml([]).includes('pr-emp-empty'));
  assert.ok(P.buildListHtml([]).includes('pr-emp-create'), '查不到給「新增員工帳號」');
  const many = Array.from({ length: P.MAX_LIST + 3 }, (_, i) => ({ code: String(i), name: `n${i}` }));
  const big = P.buildListHtml(many);
  assert.strictEqual((big.match(/pr-emp-item/g) || []).length, P.MAX_LIST);
  assert.ok(big.includes('還有 3 位沒有列出'));
});

check('選人：讀員工匯款帳號主檔，依 $id 翻頁到不足一頁為止', async () => {
  const calls = [];
  const page = (n, start) => Array.from({ length: n }, (_, i) => acc(String(start + i).padStart(5, '0'), 'x', start + i + 1));
  const api = async (url, method, params) => {
    calls.push([url, method, params.app, params.query]);
    return { records: params.query.startsWith('$id > 0 ') ? page(500, 0) : page(5, 500) };
  };
  const list = await P.fetchAccounts(api);
  const app = global.window.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT;
  assert.deepStrictEqual(calls, [
    ['/k/v1/records', 'GET', app, '$id > 0 order by $id asc limit 500'],
    ['/k/v1/records', 'GET', app, '$id > 500 order by $id asc limit 500'],
  ]);
  assert.strictEqual(list.length, 505);
});

check('新增員工帳號：關鍵字拆預設值、檢查編號 5 碼／姓名必填／不可重複、表單跳脫', () => {
  assert.deepStrictEqual(P.splitKeyword('00888 陳新人'), { code: '00888', name: '陳新人' });
  assert.deepStrictEqual(P.splitKeyword('陳新人'), { code: '', name: '陳新人' });
  const list = P.normalizeAccounts([acc('00100', '甲')]);
  assert.strictEqual(P.validateNewAccount({ code: '888', name: '陳' }, list), '員工編號請輸入 5 碼數字');
  assert.strictEqual(P.validateNewAccount({ code: '00888', name: ' ' }, list), '請輸入中文姓名');
  assert.ok(P.validateNewAccount({ code: '00100', name: '甲' }, list).includes('已存在'));
  assert.strictEqual(P.validateNewAccount({ code: '00888', name: '陳' }, list), '');
  const html = P.buildCreateFormHtml({ code: '<1>', name: '"x"' });
  assert.ok(html.includes('&lt;1&gt;') && html.includes('&quot;x&quot;'));
  assert.ok(html.includes('新增匯款帳號，需要3個工作天（不含假日）'), '新增並選擇旁的說明');
});

check('新增員工帳號：POST 一筆（員工編號＋中文姓名）；沒權限的錯誤訊息另外說明', async () => {
  const calls = [];
  const res = await P.createAccount({ code: ' 00888 ', name: ' 陳新人 ' }, async (...a) => (calls.push(a), { id: '9' }));
  assert.deepStrictEqual(calls, [
    ['/k/v1/record', 'POST', { app: global.window.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT, record: { five_digit_num: { value: '00888' }, chinese_name: { value: '陳新人' } } }],
  ]);
  assert.deepStrictEqual(res, { code: '00888', name: '陳新人', payee: '00888 陳新人' });
  assert.ok(P.createErrorText({ code: 'CB_NO02' }).includes('權限'));
  assert.strictEqual(P.createErrorText({ message: '重複' }), '新增失敗：重複');
});

check('主檔 API：有狀態驅動動作外掛就借 NXSdaApi（第 4 個參數＝主檔 App 取 Token）；外掛的錯誤拆出 code 判斷沒權限', async () => {
  const appId = global.window.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT;
  const calls = [];
  global.window.NXSdaApi = { call: async (...a) => (calls.push(a), { id: '9' }) };
  try {
    await P.createAccount({ code: '00999', name: '林' });
    assert.deepStrictEqual(calls, [['/k/v1/record', 'POST', { app: appId, record: { five_digit_num: { value: '00999' }, chinese_name: { value: '林' } } }, appId]]);
    global.window.NXSdaApi = {
      call: async () => {
        throw new Error('API /k/v1/record 403: {"code":"CB_NO02","id":"x","message":"沒有權限"}');
      },
    };
    const err = await P.createAccount({ code: '00998', name: '林' }).then(() => null, (e) => e);
    assert.strictEqual(err.code, 'CB_NO02');
    assert.ok(P.createErrorText(err).includes('沒有新增員工帳號的權限'));
  } finally {
    delete global.window.NXSdaApi;
  }
});

check('選擇員工：沒有 SweetAlert 開不了視窗 → alert 提示手動輸入、受款人不動', () => {
  alerts.length = 0;
  currentRecord = recordWithApplicant(null);
  currentRecord[F.PAYEE].value = '原值';
  pickButton.click();
  assert.deepStrictEqual(alerts, ['無法開啟人員清單，請重新整理頁面後再試']);
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
  assert.strictEqual(fired[0].cancelButtonText, '取消');
  // 模擬視窗：取得 didOpen 綁的事件，載入清單後點第一位
  const listeners = {};
  const listEl = { innerHTML: '', addEventListener: (t, fn) => (listeners['list:' + t] = fn) };
  const input = { value: '00777', focus() {}, addEventListener: (t, fn) => (listeners['input:' + t] = fn) };
  const popup = { querySelector: (sel) => (sel === '.pr-emp-search' ? input : listEl) };
  // 不打真的 API：讓 loadUsers 拿到假清單
  global.kintone.api = Object.assign(async () => ({ records: [acc('00777', '林小華')] }), { url: (p) => p });
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

check('選擇員工：查不到 → 新增員工帳號表單（帶入關鍵字）→ 新增並選擇，受款人寫入、提示會通知承辦人', async () => {
  const fired = [];
  const closed = [];
  global.Swal = { fire: (opts) => fired.push(opts), close: () => closed.push(1) };
  currentRecord = recordWithApplicant(null);
  currentRecord[F.PAYEE].value = '陳新人';
  pickButton.click();
  const listeners = {};
  const fields = { '.pr-emp-new-code': { value: '00888' }, '.pr-emp-new-name': { value: '陳新人' }, '.pr-emp-create-error': { textContent: '' } };
  const listEl = { innerHTML: '', addEventListener: (t, fn) => (listeners['list:' + t] = fn), querySelector: (sel) => fields[sel] || null };
  const input = { value: '00888 陳新人', focus() {}, addEventListener: (t, fn) => (listeners['input:' + t] = fn) };
  const popup = { querySelector: (sel) => (sel === '.pr-emp-search' ? input : listEl) };
  const posts = [];
  global.kintone.api = Object.assign(async (url, method, params) => (posts.push([url, method, params]), { id: '9' }), { url: (p) => p });
  fired[0].didOpen(popup);
  await new Promise((r) => setImmediate(r));
  assert.ok(listEl.innerHTML.includes('pr-emp-create'), '查不到顯示新增按鈕');
  const click = (cls) => listeners['list:click']({ target: { closest: (sel) => (sel === cls ? {} : null) } });
  click('.pr-emp-create');
  assert.ok(listEl.innerHTML.includes('value="00888"') && listEl.innerHTML.includes('value="陳新人"'), '表單帶入關鍵字');
  click('.pr-emp-create-submit');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0][1], 'POST');
  assert.strictEqual(currentRecord[F.PAYEE].value, '00888 陳新人');
  assert.strictEqual(closed.length, 1);
  assert.ok(fired[1].text.includes('通知承辦人'));
  // 再新增同一個編號：已在名單裡 → 擋下不打 API
  click('.pr-emp-create-submit');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(posts.length, 1);
  assert.ok(fields['.pr-emp-create-error'].textContent.includes('已存在'));
  delete global.Swal;
});

check('原始碼不含類型判斷、舊的「同費用所屬人」按鈕與 723 員工姓名欄位', () => {
  const src = readSrc('受款人填寫設定.js');
  ['F.TYPE', 'COMPANY_TYPES', 'EMPLOYEE_NAME', 'same-expense-owner-btn', '同費用所屬人', 'F.EXPENSE_OWNER'].forEach((s) => assert.ok(!src.includes(s), s));
});

queue
  .then(() => console.log(`${passed} assertions passed.`))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
