'use strict';

// 測試：員工帳號匯入.js（上傳到員工匯款帳號主檔：Excel 匯入預覽＋存檔去頭尾空白）
//   a. config 原始檔 + 本檔在主檔（getId 回 APPS.EMPLOYEE_ACCOUNT）單獨可執行、選到正確環境、不警告
//   b. 存檔去頭尾空白：新增／編輯／列表直接編輯三個事件；含全形空白、零寬字元、子表格；不動非文字欄位
//   c. Excel 解析：認欄位名稱或代碼、全部 trim、員工編號補 0、略過空白列、沒有標題列報錯
//   d. 比對主檔：新增／更新（只更新有填且不同的欄位）／不變／錯誤（5 碼、姓名、檔案內重複、BP_CODE 衝突）／取消勾選
//   e. 寫入：每 100 筆一批，新增 POST、更新 PUT（員工編號當 updateKey）；失敗帶已完成筆數
// 單獨執行：node tests/employee_account_import.test.cjs

const assert = require('assert');
const vm = require('vm');
const { createRunner, readSrc } = require('./lib/pr_env.cjs');

const { check, done } = createRunner('employee_account_import.test.cjs');

const FILE = '員工帳號匯入.js';
const plain = (x) => JSON.parse(JSON.stringify(x));

const setup = (appId) => {
  const handlers = [];
  const warns = [];
  const kintone = {
    app: { getId: () => appId, getHeaderMenuSpaceElement: () => null },
    events: { on: (types, handler) => handlers.push({ types: [].concat(types), handler }) },
    api: Object.assign(() => Promise.reject(new Error('不該打 API')), { url: (p) => p }),
  };
  const sandbox = { window: {}, kintone, document: { getElementById: () => null }, console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(readSrc('payment_request_config.js'), sandbox, { filename: 'config' });
  vm.runInContext(readSrc(FILE), sandbox, { filename: FILE });
  const fire = (type, record) => {
    const ev = { type, record };
    handlers.filter((x) => x.types.includes(type)).forEach((h) => h.handler(ev));
    return ev;
  };
  return { win: sandbox.window, handlers, warns, fire };
};

// 先用請款單的 ID 讀出 APPS.EMPLOYEE_ACCOUNT，再模擬在主檔執行
const probe = setup(749);
const ACCOUNT_APP = probe.win.PR_CONFIG.APPS.EMPLOYEE_ACCOUNT;
const env = setup(ACCOUNT_APP);
const C = env.win.PR_CONFIG;
const EA = C.REF_FIELDS.EMPLOYEE_ACCOUNT;
const I = env.win.PR_EMPLOYEE_ACCOUNT_IMPORT;

check('在主檔單獨可執行：選到測試區、不警告；掛出匯入函式', () => {
  assert.strictEqual(C.ENV, 'test');
  assert.deepStrictEqual(env.warns, []);
  assert.strictEqual(C.APPS.PAYMENT, ACCOUNT_APP);
  assert.ok(I && typeof I.buildPlan === 'function');
});

check('存檔去頭尾空白：新增／編輯／列表直接編輯都註冊；全形空白、零寬字元、子表格都去掉；非文字欄位不動', () => {
  ['app.record.create.submit', 'app.record.edit.submit', 'app.record.index.edit.submit'].forEach((type) => {
    const record = {
      [EA.CODE]: { type: 'SINGLE_LINE_TEXT', value: ' 00546　' },
      [EA.NAME]: { type: 'SINGLE_LINE_TEXT', value: '​王小明 ' },
      memo: { type: 'MULTI_LINE_TEXT', value: '\n備註\n' },
      num: { type: 'NUMBER', value: ' 12 ' },
      pick: { type: 'DROP_DOWN', value: ' A ' },
      table: { type: 'SUBTABLE', value: [{ value: { cell: { type: 'SINGLE_LINE_TEXT', value: ' x ' } } }] },
    };
    env.fire(type, record);
    assert.strictEqual(record[EA.CODE].value, '00546', type);
    assert.strictEqual(record[EA.NAME].value, '王小明');
    assert.strictEqual(record.memo.value, '備註');
    assert.strictEqual(record.num.value, '12');
    assert.strictEqual(record.pick.value, ' A ', '下拉不動');
    assert.strictEqual(record.table.value[0].value.cell.value, 'x');
  });
});

check('Excel 解析：認欄位名稱或代碼、全部 trim、員工編號 1～4 碼補 0、略過空白列；沒有標題列或沒有資料報錯', () => {
  const aoa = [
    ['說明列', '', '', ''],
    [' 員工編號 ', '中文姓名', 'bp_code', 'BANK_DETAIL_ID'],
    [' 546 ', ' 王小明　', ' BP01 ', ' B1 '],
    ['', '', '', ''],
    ['00777', '陳大文', '', ''],
  ];
  const { rows, error } = I.parseSheetRows(aoa);
  assert.strictEqual(error, '');
  assert.deepStrictEqual(plain(rows), [
    { line: 3, code: '00546', name: '王小明', bp: 'BP01', bank: 'B1' },
    { line: 5, code: '00777', name: '陳大文', bp: '', bank: '' },
  ]);
  assert.ok(I.parseSheetRows([['姓名'], ['王']]).error.includes('員工編號'));
  assert.ok(I.parseSheetRows([['five_digit_num']]).error.includes('沒有資料'));
});

const existing = () =>
  I.toExistingMap([
    { $id: { value: '1' }, [EA.CODE]: { value: '00546 ' }, [EA.NAME]: { value: '王小明' }, [EA.BP_CODE]: { value: 'BP01' }, [EA.BANK_DETAIL_ID]: { value: '' } },
    { $id: { value: '2' }, [EA.CODE]: { value: '00777' }, [EA.NAME]: { value: '陳大文' }, [EA.BP_CODE]: { value: '' }, [EA.BANK_DETAIL_ID]: { value: 'B7' } },
  ]);
const row = (code, name = '', bp = '', bank = '', extra = {}) => ({ line: 2, code, name, bp, bank, ...extra });

check('比對主檔：新增、更新只算有填且不同的欄位（空白不清）、不變；主檔值也先 trim', () => {
  const plan = I.buildPlan([row('00888', '林新人'), row('00546', '王小明', 'BP01', 'B1'), row('00777', '', '', 'B7')], existing());
  assert.deepStrictEqual(
    plan.map((p) => [p.kind, [...p.changes]]),
    [
      ['add', ['code', 'name']],
      ['update', ['bank']],
      ['same', []],
    ],
  );
});

check('比對主檔：錯誤——不是 5 碼、新增沒姓名、檔案內編號重複、BP_CODE 檔案內重複或屬於別人；取消勾選不檢查', () => {
  const plan = I.buildPlan(
    [row('1234a', '甲'), row('00888'), row('00999', '乙'), row('00999', '丙'), row('00111', '丁', 'BPX'), row('00222', '戊', 'BPX'), row('00333', '己', 'BP01')],
    existing(),
  );
  const errs = plan.map((p) => p.errors.join('|'));
  assert.ok(errs[0].includes('5 碼'));
  assert.ok(errs[1].includes('姓名'));
  assert.ok(errs[2].includes('重複') && errs[3].includes('重複'));
  assert.ok(errs[4].includes('BP_CODE 檔案內重複') && errs[5].includes('BP_CODE 檔案內重複'));
  assert.ok(errs[6].includes('已屬於員工編號 00546'));
  const skipped = I.buildPlan([row('00999', '乙'), row('00999', '丙', '', '', { include: false })], existing());
  assert.deepStrictEqual(
    skipped.map((p) => p.kind),
    ['add', 'skip'],
  );
  assert.deepStrictEqual(plain(I.summarize(skipped)), { add: 1, update: 0, same: 0, error: 0, skip: 1 });
});

check('寫入：新增 POST、更新 PUT（員工編號 updateKey、只送有變的欄位）；每 100 筆一批', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => row(String(10000 + i), `人${i}`));
  rows.push(row('00777', '陳大文改'));
  const plan = I.buildPlan(rows, existing());
  const calls = [];
  const res = await I.runImport(plan, ACCOUNT_APP, async (path, method, params) => calls.push([path, method, params.records.length]));
  assert.deepStrictEqual(plain(res), { added: 150, updated: 1 });
  assert.deepStrictEqual(calls, [
    ['/k/v1/records', 'POST', 100],
    ['/k/v1/records', 'POST', 50],
    ['/k/v1/records', 'PUT', 1],
  ]);
  const w = I.buildWrites(plan);
  assert.deepStrictEqual(plain(w.updates[0]), { updateKey: { field: EA.CODE, value: '00777' }, record: { [EA.NAME]: { value: '陳大文改' } } });
  assert.deepStrictEqual(plain(w.adds[0]), { [EA.CODE]: { value: '10000' }, [EA.NAME]: { value: '人0' } });
});

check('寫入失敗：丟出錯誤並帶已完成筆數', async () => {
  const plan = I.buildPlan(
    Array.from({ length: 120 }, (_, i) => row(String(20000 + i), `人${i}`)),
    existing(),
  );
  let n = 0;
  const err = await I.runImport(plan, ACCOUNT_APP, async () => {
    n += 1;
    if (n === 2) throw new Error('boom');
  }).catch((e) => e);
  assert.strictEqual(err.message, 'boom');
  assert.deepStrictEqual(plain(err.done), { added: 100, updated: 0 });
});

check('預覽 HTML：每格可修改、跳脫特殊字元、狀態與摘要', () => {
  const plan = I.buildPlan([row('00888', '<林>'), row('00546', '王小明', '', 'B1')], existing());
  const html = I.buildPreviewHtml(plan);
  assert.ok(html.includes('class="pr-imp-input" data-row="0" data-key="name" value="&lt;林&gt;"'));
  assert.ok(html.includes('新增 1 筆、更新 1 筆'));
  assert.ok(html.includes('更新：BANK_DETAIL_ID'));
  assert.ok(!html.includes('readonly'));
});

check('讀主檔依 $id 翻頁、只讀匯入用到的欄位', async () => {
  const calls = [];
  const page = (n, start) => Array.from({ length: n }, (_, i) => ({ $id: { value: String(start + i + 1) } }));
  const all = await I.fetchAllAccounts(ACCOUNT_APP, async (path, method, params) => {
    calls.push(params.query);
    return { records: calls.length === 1 ? page(500, 0) : page(3, 500) };
  });
  assert.strictEqual(all.length, 503);
  assert.deepStrictEqual(calls, ['$id > 0 order by $id asc limit 500', '$id > 500 order by $id asc limit 500']);
});

check('列表頁有註冊 index.show（掛匯入按鈕）', () => {
  assert.ok(env.handlers.some((h) => h.types.includes('app.record.index.show')));
});

done();
