'use strict';

// 測試：批次填傳票_入帳完成.js（2026-11-18 從請購庶務搬來，欄位換成 749 的） —— 列表頁「📋 批次填傳票／入帳完成」
//   查詢字串、列分類（未收到鎖定／已填只簽核／只補空欄）、輸入驗證、payload 不覆蓋、
//   每 100 筆分批、整批失敗逐筆重試、index.show 註冊與載入順序。
// 單獨執行：node tests/batch_voucher_status.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8').replace(/\r\n/g, '\n');
const MOD = '批次填傳票_入帳完成.js';

const registered = [];
global.window = {};
global.kintone = {
  app: { getId: () => 749 },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (name, fn) => registered.push({ name, fn }) },
};
// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
const C = global.window.PR_CONFIG;
// eslint-disable-next-line no-eval
eval(readSrc(MOD));
const M = global.window.PR_BATCH_VOUCHER;
const BV = C.BATCH_VOUCHER;

let passed = 0;
let chain = Promise.resolve();
const check = (label, fn) => {
  chain = chain.then(async () => {
    await fn();
    passed += 1;
    console.log(`  ok - ${label}`);
  });
};

const rec = (id, o = {}) => ({
  $id: { value: String(id) },
  交通費請款單號: { value: String(id) },
  狀態: { value: o.status || '單位會計處理中(台北)' },
  受款人: { value: o.payee || '00001王小明' },
  總金額: { value: o.total ?? '1000' },
  傳票編號: { value: o.vno || '' },
  傳票日期: { value: o.vdate || '' },
  會計課承辦註記是否收到單據紙本: { value: o.receipt || '已收到' },
});
const row = (id, o) => M.classifyRow(rec(id, o));
const YEAR = 2026;

console.log('batch_voucher_status.test.cjs');

check('config：BATCH_VOUCHER 已凍結並匯出，七個狀態、動作、目標狀態、作業者欄位', () => {
  assert.ok(Object.isFrozen(BV) && Object.isFrozen(BV.FROM_STATUSES));
  assert.strictEqual(BV.FROM_STATUSES.length, 7);
  assert.strictEqual(BV.ACTION, '入帳完成');
  assert.strictEqual(BV.TARGET_STATUS, '請款流程結束');
  assert.strictEqual(BV.ASSIGNEE_FIELD, '執行者');
  assert.strictEqual(BV.CHUNK_SIZE, 100);
});

check('查詢：七個狀態＋作業者是登入者＋$id 由大到小＋每頁 500；翻頁用 $id <', () => {
  const q = M.buildQuery();
  assert.ok(q.startsWith('狀態 in ("單位會計處理中(台北)","單位會計處理中(台北海運)"'));
  BV.FROM_STATUSES.forEach((s) => assert.ok(q.includes(`"${s}"`)));
  assert.ok(q.includes('and 執行者 in (LOGINUSER())'));
  assert.ok(q.endsWith('order by $id desc limit 500'));
  assert.ok(!q.includes('$id <'));
  assert.ok(M.buildQuery(1234).includes('and $id < 1234 order by $id desc'));
});

check('分類：未收到鎖定（即使兩欄都有值）、兩欄都有值只簽核、只填一欄補空的', () => {
  const locked = row(1, { receipt: '未收到', vno: 'A', vdate: '2026-01-01' });
  assert.strictEqual(locked.kind, 'locked');
  assert.strictEqual(locked.selectable, false);
  const only = row(2, { vno: 'A', vdate: '2026-01-01' });
  assert.strictEqual(only.kind, 'actionOnly');
  assert.ok(only.selectable && !only.needNo && !only.needDate);
  const both = row(3);
  assert.ok(both.kind === 'fill' && both.needNo && both.needDate);
  const noOnly = row(4, { vdate: '2026-02-02' });
  assert.ok(noOnly.needNo && !noOnly.needDate);
  const dateOnly = row(5, { vno: 'V1' });
  assert.ok(!dateOnly.needNo && dateOnly.needDate);
  assert.ok(row(6, { receipt: '不適用' }).selectable);
});

check('備註 badge 與關鍵字搜尋（整列文字）', () => {
  assert.strictEqual(M.badgeOf(row(1, { receipt: '未收到' })), '📄 未收到紙本');
  assert.strictEqual(M.badgeOf(row(2, { vno: 'A', vdate: '2026-01-01' })), '已填・只簽核');
  assert.ok(M.matchKeyword(row(123, { total: '1234567' }), '1,234,567'));
  assert.ok(M.matchKeyword(row(123), '王小明'), '受款人也能搜');
  assert.ok(M.matchKeyword(row(123, { vno: 'ABC9' }), 'abc9'));
  assert.ok(!M.matchKeyword(row(123), 'zzz'));
  assert.ok(M.matchKeyword(row(123), ''));
});

check('範圍輸入：100-150, 160；反向自動交換；略過鎖定列；無法解析的列出', () => {
  const { segments, invalid } = M.parseRanges('100-150, 160，170~165 abc 1-2-3');
  assert.deepStrictEqual(segments, [[100, 150], [160, 160], [165, 170]]);
  assert.deepStrictEqual(invalid, ['abc', '1-2-3']);
  const rows = [row(100), row(120, { receipt: '未收到' }), row(160), row(200)];
  const r = M.pickByRanges(rows, segments);
  assert.deepStrictEqual(r.ids, ['100', '160']);
  assert.strictEqual(r.skippedLocked, 1);
});

check('列表頁範圍帶入：連續範圍兩格→"起-迄"、只填一格、指定記錄、沒輸入格回空字串', () => {
  const fakeDoc = (mode, vals) => ({
    querySelector: () => (mode ? { value: mode } : null),
    getElementById: (id) => (id in vals ? { value: vals[id] } : null),
  });
  assert.strictEqual(M.readIndexRange(fakeDoc('range', { 'range-start': ' 100 ', 'range-end': '150' })), '100-150');
  assert.strictEqual(M.readIndexRange(fakeDoc('range', { 'range-start': '', 'range-end': '150' })), '150');
  assert.strictEqual(M.readIndexRange(fakeDoc(null, { 'range-start': '7', 'range-end': '9' })), '7-9');
  assert.strictEqual(M.readIndexRange(fakeDoc('specific', { 'specific-records': '1, 5,9', 'range-start': '7' })), '1, 5,9');
  assert.strictEqual(M.readIndexRange(fakeDoc('range', {})), '');
  // 帶入的文字能被 parseRanges 解析
  assert.deepStrictEqual(M.parseRanges(M.readIndexRange(fakeDoc('range', { 'range-start': '150', 'range-end': '100' }))).segments, [[100, 150]]);
});

check('驗證：要補填時編號、日期都必填；沒勾任何列擋下', () => {
  assert.strictEqual(M.validateInput([], { year: YEAR }).ok, false);
  const rows = [row(1)];
  let v = M.validateInput(rows, { voucherNo: '', voucherDate: '2026-05-01', doAction: false, year: YEAR });
  assert.ok(!v.ok && v.errors[0].includes('傳票編號'), '沒給 labels 時用欄位代碼');
  v = M.validateInput(rows, { voucherNo: 'V1', voucherDate: '', doAction: false, year: YEAR, labels: { no: '申請單號', date: '過帳日期' } });
  assert.ok(!v.ok && v.errors[0].includes('過帳日期'));
  v = M.validateInput(rows, { voucherNo: '  V1 ', voucherDate: '2026-05-01', doAction: false, year: YEAR });
  assert.ok(v.ok);
});

check('驗證：全部都已填好又沒勾入帳完成 → 沒事可做；只簽核時不要求輸入', () => {
  const rows = [row(1, { vno: 'A', vdate: '2026-03-03' })];
  assert.ok(!M.validateInput(rows, { doAction: false, year: YEAR }).ok);
  assert.ok(M.validateInput(rows, { doAction: true, year: YEAR }).ok);
});

check('驗證：勾入帳完成時，每列有效日期（既有值或新輸入）必須是今年，列出不合格的記錄號碼', () => {
  const rows = [row(1, { vno: 'A', vdate: '2025-12-31' }), row(2), row(3, { vno: 'B', vdate: '2026-01-01' })];
  let v = M.validateInput(rows, { voucherNo: 'V', voucherDate: '2026-06-06', doAction: true, year: YEAR });
  assert.ok(!v.ok);
  assert.deepStrictEqual(v.badRows, ['1']);
  v = M.validateInput([rows[1], rows[2]], { voucherNo: 'V', voucherDate: '2025-06-06', doAction: true, year: YEAR });
  assert.deepStrictEqual(v.badRows, ['2']);
  v = M.validateInput([rows[1]], { voucherNo: 'V', voucherDate: '2025-06-06', doAction: false, year: YEAR });
  assert.ok(v.ok, '不執行入帳完成時不檢查年度');
});

check('payload：只補空欄位、不覆蓋；已填好與鎖定列不產生；動作 payload', () => {
  const rows = [row(1), row(2, { vno: 'OLD' }), row(3, { vdate: '2026-01-01' }), row(4, { vno: 'A', vdate: '2026-01-02' }), row(5, { receipt: '未收到' })];
  const p = M.buildFillPayloads(rows, ' V9 ', '2026-09-09');
  assert.deepStrictEqual(p, [
    { id: '1', record: { 傳票編號: { value: 'V9' }, 傳票日期: { value: '2026-09-09' } } },
    { id: '2', record: { 傳票日期: { value: '2026-09-09' } } },
    { id: '3', record: { 傳票編號: { value: 'V9' } } },
  ]);
  assert.deepStrictEqual(M.buildActionPayloads(['5', '6']), [{ id: '5', action: '入帳完成' }, { id: '6', action: '入帳完成' }]);
});

check('分批：250 筆 → 100／100／50 三批，進度累計', async () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: String(i) }));
  const sizes = [];
  const prog = [];
  const r = await M.runChunked(items, 100, async (part) => sizes.push(part.length), (x) => x.id, (n) => prog.push(n));
  assert.deepStrictEqual(sizes, [100, 100, 50]);
  assert.deepStrictEqual(prog, [100, 200, 250]);
  assert.strictEqual(r.okIds.length, 250);
  assert.strictEqual(r.failed.length, 0);
});

check('分批：某批失敗 → 該批逐筆重試，只回報真正失敗的那幾筆與訊息', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
  const calls = [];
  const send = async (part) => {
    calls.push(part.map((x) => x.id).join(','));
    if (part.some((x) => x.id === '3')) throw new Error(part.length > 1 ? '整批失敗' : '條件不符');
  };
  const r = await M.runChunked(items, 100, send, (x) => x.id);
  assert.deepStrictEqual(calls, ['0,1,2,3,4', '0', '1', '2', '3', '4']);
  assert.deepStrictEqual(r.okIds, ['0', '1', '2', '4']);
  assert.deepStrictEqual(r.failed, [{ id: '3', message: '條件不符' }]);
});

check('execute：先 PUT 欄位再 PUT 狀態；欄位失敗的列不送入帳完成；結果與失敗清單', async () => {
  const rows = [row(1), row(2), row(3, { vno: 'A', vdate: '2026-01-01' })];
  const log = [];
  const api = async (method, p, body) => {
    log.push(`${method} ${p} ${body.records.map((r) => r.id).join(',')}`);
    if (p === '/k/v1/records' && body.records.some((r) => r.id === '2')) throw new Error('欄位被鎖');
    if (p === '/k/v1/records/status' && body.records.some((r) => r.id === '3')) throw new Error('無權限');
  };
  const res = await M.execute(api, 749, rows, { voucherNo: 'V', voucherDate: '2026-04-04', doAction: true });
  assert.deepStrictEqual(log, [
    'PUT /k/v1/records 1,2',
    'PUT /k/v1/records 1',
    'PUT /k/v1/records 2',
    'PUT /k/v1/records/status 1,3',
    'PUT /k/v1/records/status 1',
    'PUT /k/v1/records/status 3',
  ]);
  assert.strictEqual(res.filled, 1);
  assert.strictEqual(res.acted, 1);
  assert.deepStrictEqual(res.failures, [
    { recordNo: '2', step: '填入傳票', message: '欄位被鎖' },
    { recordNo: '3', step: '入帳完成', message: '無權限' },
  ]);
});

check('execute：沒勾入帳完成只填欄位；全是只簽核的列不打 PUT 欄位', async () => {
  const log = [];
  const api = async (m, p) => log.push(p);
  await M.execute(api, 749, [row(1)], { voucherNo: 'V', voucherDate: '2026-04-04', doAction: false });
  assert.deepStrictEqual(log, ['/k/v1/records']);
  log.length = 0;
  const r = await M.execute(api, 749, [row(2, { vno: 'A', vdate: '2026-01-01' })], { doAction: true });
  assert.deepStrictEqual(log, ['/k/v1/records/status']);
  assert.strictEqual(r.acted, 1);
});

check('註冊與載入：按鈕在「批次動作」下拉選單（本檔不註冊 index.show、開放 openDialog）；src/index.js 排在批次整理資料之後；檔案批次選單有這一項；package.json test 有本檔；不寫死 App ID', () => {
  assert.strictEqual(registered.filter((r) => r.name === 'app.record.index.show').length, 0);
  assert.strictEqual(typeof M.openDialog, 'function');
  const idx = readSrc('src/index.js');
  const iPrev = idx.indexOf("'../批次整理資料.js'");
  const iMod = idx.indexOf(`'../${MOD}'`);
  assert.ok(iPrev > 0 && iMod > iPrev);
  const batch = readSrc('檔案批次.js');
  assert.ok(batch.includes('📋 批次填傳票／入帳完成') && batch.includes('window.PR_BATCH_VOUCHER.openDialog()'));
  assert.ok(fs.readdirSync(__dirname).includes('batch_voucher_status.test.cjs') && /\.test\.cjs$/.test(path.basename(__filename)), 'npm test（scripts/run-tests.cjs）會自動找到本檔');
  assert.ok(!/\b(749|752|673)\b/.test(readSrc(MOD)));
  assert.ok(!/<style|style="/.test(readSrc(MOD)), '樣式只寫在 payment_request.css');
});

chain
  .then(() => console.log(`\n${passed} assertions passed.`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
