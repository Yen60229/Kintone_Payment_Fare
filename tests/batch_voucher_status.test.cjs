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
const M = require('./lib/esm_loader.cjs').loadInto(null, MOD);
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
  執行者: { value: (o.assignees || []).map((code) => ({ code, name: code })) },
  會計單位: { value: (o.units || []).map((code) => ({ code, name: code })) },
});
const row = (id, o) => M.classifyRow(rec(id, o));
const joinCtx = { loginCode: 'me', myGroups: new Set(['ACC_TPE']), canJoin: true };
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

check('查詢：七個狀態（不再限定執行者是登入者）＋$id 由大到小＋每頁 500；翻頁用 $id <', () => {
  const q = M.buildQuery();
  assert.ok(q.startsWith('狀態 in ("單位會計處理中(台北)","單位會計處理中(台北海運)"'));
  BV.FROM_STATUSES.forEach((s) => assert.ok(q.includes(`"${s}"`)));
  assert.ok(!q.includes('LOGINUSER()'));
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

check('config：加執行者用的會計單位欄位、上限 100；token 不放 config（走外掛）', () => {
  assert.strictEqual(BV.ACCOUNTING_UNIT_FIELD, '會計單位');
  assert.strictEqual(BV.ASSIGNEE_MAX, 100);
  assert.ok(!('ASSIGNEE_TOKENS' in BV));
  assert.ok(!/X-Cybozu-API-Token/.test(readSrc(MOD)), '模組不自己帶 token');
});

check('外掛呼叫：path 補 .json、token 用本 App；外掛沒載入回 null', async () => {
  const calls = [];
  const api = M.makePluginApi(758, { call: async (...a) => { calls.push(a); return { revision: '2' }; } });
  assert.deepStrictEqual(await api('PUT', '/k/v1/record/assignees', { app: 758, id: '1', assignees: ['me'] }), { revision: '2' });
  assert.deepStrictEqual(calls, [['/k/v1/record/assignees.json', 'PUT', { app: 758, id: '1', assignees: ['me'] }, 758]]);
  assert.strictEqual(M.makePluginApi(758, null), null);
  assert.strictEqual(M.makePluginApi(758, {}), null);
  assert.strictEqual(M.makePluginApi(758), null, '測試環境沒有 window.NXSdaApi');
});

check('權限分類：執行者照常；非執行者在會計單位群組＋外掛可用 → 可勾且需加入；沒外掛／不在群組 → 鎖住', () => {
  const r = (o) => M.classifyRow(rec(1, o), joinCtx);
  const mine = r({ assignees: ['a', 'me'], units: ['ACC_KHH'] });
  assert.ok(mine.access === 'assignee' && mine.selectable && !mine.needJoin, '已是執行者不看群組');
  const join = r({ assignees: ['a'], units: ['ACC_TPE'] });
  assert.ok(join.access === 'join' && join.selectable && join.needJoin && join.kind === 'fill');
  assert.strictEqual(M.badgeOf(join), '👤 加入執行者・填寫：編號＋日期');
  const deny = r({ assignees: ['a'], units: ['ACC_KHH'] });
  assert.ok(deny.kind === 'denied' && !deny.selectable && !deny.needJoin);
  assert.strictEqual(M.badgeOf(deny), '🚫 非執行者・不在會計單位群組');
  assert.strictEqual(r({ assignees: ['a'], units: [] }).kind, 'denied', '會計單位空白 → 不能加');
  const noTok = M.classifyRow(rec(1, { units: ['ACC_TPE'] }), { ...joinCtx, canJoin: false });
  assert.ok(noTok.access === 'noToken' && !noTok.selectable);
  assert.strictEqual(M.badgeOf(noTok), '🚫 非執行者（外掛未載入，無法加入）');
  const lockedJoin = r({ units: ['ACC_TPE'], receipt: '未收到' });
  assert.ok(lockedJoin.kind === 'locked' && !lockedJoin.needJoin, '未收到紙本優先，不加入');
  assert.strictEqual(M.classifyRow(rec(1)).access, 'assignee', '沒給 ctx 視為執行者');
});

check('執行者清單：加入登入者去重、保留原順序；超過 100 人回 null', () => {
  assert.deepStrictEqual(M.joinedAssignees(['a', 'b'], 'me'), ['a', 'b', 'me']);
  assert.deepStrictEqual(M.joinedAssignees(['me', 'a'], 'me'), ['me', 'a']);
  assert.deepStrictEqual(M.joinedAssignees(undefined, 'me'), ['me']);
  assert.strictEqual(M.joinedAssignees(Array.from({ length: 100 }, (_, i) => `u${i}`), 'me'), null);
});

check('登入者群組：回傳代碼集合；查詢失敗回空集合', async () => {
  const got = await M.fetchMyGroups(async (m, p, b) => {
    assert.deepStrictEqual([m, p, b], ['GET', '/v1/user/groups', { code: 'me' }]);
    return { groups: [{ code: 'ACC_TPE', name: '台北' }] };
  }, 'me');
  assert.deepStrictEqual([...got], ['ACC_TPE']);
  const origErr = console.error;
  console.error = () => {};
  const none = await M.fetchMyGroups(async () => { throw new Error('x'); }, 'me');
  console.error = origErr;
  assert.strictEqual(none.size, 0);
});

check('execute：先用外掛逐筆加執行者，加入失敗的列不填欄位、不送入帳完成；沒有外掛 → 這些列記失敗', async () => {
  const rows = [
    M.classifyRow(rec(1, { assignees: ['a'], units: ['ACC_TPE'] }), joinCtx),
    M.classifyRow(rec(2, { assignees: ['b'], units: ['ACC_TPE'] }), joinCtx),
    M.classifyRow(rec(3, { assignees: ['me'] }), joinCtx),
  ];
  const log = [];
  const api = async (m, p, body) => log.push(`${p} ${body.records.map((r) => r.id).join(',')}`);
  const tokenLog = [];
  const assigneeApi = async (m, p, body) => {
    tokenLog.push([m, p, body]);
    if (body.id === '2') throw new Error('token 權限不足');
  };
  const prog = [];
  const res = await M.execute(api, 758, rows, { voucherNo: 'V', voucherDate: '2026-04-04', doAction: true, loginCode: 'me', assigneeApi }, (d, t, l) => prog.push(`${l} ${d}/${t}`));
  assert.deepStrictEqual(tokenLog, [
    ['PUT', '/k/v1/record/assignees', { app: 758, id: '1', assignees: ['a', 'me'] }],
    ['PUT', '/k/v1/record/assignees', { app: 758, id: '2', assignees: ['b', 'me'] }],
  ]);
  assert.deepStrictEqual(log, ['/k/v1/records 1,3', '/k/v1/records/status 1,3']);
  assert.strictEqual(res.joined, 1);
  assert.strictEqual(res.filled, 2);
  assert.strictEqual(res.acted, 2);
  assert.deepStrictEqual(res.failures, [{ recordNo: '2', step: '加入執行者', message: 'token 權限不足' }]);
  assert.strictEqual(prog[prog.length - 1], '執行入帳完成 6/6', '加入失敗後總數扣掉後續步驟');
  const log2 = [];
  const res2 = await M.execute(async (m, p, b) => log2.push(b.records.map((r) => r.id).join(',')), 758, [rows[0], rows[2]], { voucherNo: 'V', voucherDate: '2026-04-04', doAction: true, loginCode: 'me' });
  assert.deepStrictEqual(log2, ['3', '3']);
  assert.strictEqual(res2.failures[0].step, '加入執行者');
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

// ── 2026-11-24 版面調整（同請購庶務版；交通費沒有類型，只有「會計」一列）──────────────────
check('版面：狀態縮成「會計」（括號內），沒括號原樣', () => {
  assert.strictEqual(M.regionOf('單位會計處理中(桃園&新竹)'), '桃園&新竹');
  assert.strictEqual(M.regionOf('單位會計處理中(台北海運)'), '台北海運');
  assert.strictEqual(M.regionOf('單位會計處理中'), '單位會計處理中');
  assert.strictEqual(M.regionOf(''), '');
});

check('版面：備註欄只標例外（未收到紙本、加入執行者）；填寫／只簽核不標', () => {
  const notes = (r) => M.noteTagsOf(r).map((t) => t.text);
  assert.deepStrictEqual(notes(row(1)), []);
  assert.deepStrictEqual(notes(row(2, { vno: 'A', vdate: '2026-01-01' })), []);
  assert.deepStrictEqual(notes(row(3, { receipt: '未收到' })), ['📄 未收到紙本']);
  assert.deepStrictEqual(notes(M.classifyRow(rec(4, { assignees: ['a'], units: ['ACC_TPE'] }), joinCtx)), ['👤 加入執行者']);
});

const fRows = () => [
  row(9, { receipt: '未收到', status: '單位會計處理中(台中)' }),
  row(8, { status: '單位會計處理中(高雄)' }),
  row(7, { status: '單位會計處理中(台北)', vno: 'A', vdate: '2026-01-01' }),
  row(6, { status: '單位會計處理中(高雄)' }),
  row(5, { receipt: '未收到', status: '單位會計處理中(高雄)' }),
];

check('篩選：鎖住的排最後、同組維持原順序', () => {
  const rows = [row(9, { receipt: '未收到' }), row(8), row(7, { vno: 'A', vdate: '2026-01-01' }), M.classifyRow(rec(6, { assignees: ['a'], units: ['ACC_TPE'] }), joinCtx), M.classifyRow(rec(5, { units: ['ACC_KHH'] }), joinCtx)];
  assert.deepStrictEqual(M.sortRows(rows).map((r) => r.id), ['8', '7', '6', '9', '5']);
});

check('篩選：會計多選（同列「或」）＋未收到紙本（「且」）；都不選＝不篩', () => {
  const rows = fRows();
  const f = M.emptyFilter();
  assert.strictEqual(M.applyFilter(rows, f).length, 5);
  assert.ok(!M.hasFilter(f));
  f.region.add('高雄');
  assert.deepStrictEqual(M.applyFilter(rows, f).map((r) => r.id), ['8', '6', '5']);
  f.region.add('台中');
  assert.deepStrictEqual(M.applyFilter(rows, f).map((r) => r.id), ['9', '8', '6', '5'], '同列是「或」');
  f.noPaper = true;
  assert.deepStrictEqual(M.applyFilter(rows, f).map((r) => r.id), ['9', '5'], '與未收到紙本是「且」');
  assert.ok(M.hasFilter(f));
});

check('篩選：標籤選項與連動筆數（照流程順序；0 筆仍列出）', () => {
  const rows = fRows();
  const f = M.emptyFilter();
  assert.deepStrictEqual(M.regionOptions(rows, f), [
    { value: '台北', count: 1 },
    { value: '台中', count: 1 },
    { value: '高雄', count: 3 },
  ]);
  assert.strictEqual(M.noPaperCount(rows, f), 2);
  f.noPaper = true;
  assert.deepStrictEqual(M.regionOptions(rows, f).map((o) => o.count), [0, 1, 1], '會計筆數跟著未收到紙本連動');
  f.noPaper = false;
  f.region.add('高雄');
  assert.strictEqual(M.noPaperCount(rows, f), 1, '未收到紙本筆數跟著會計連動');
  assert.deepStrictEqual(M.regionOptions(rows, f).map((o) => o.count), [1, 1, 3], '自己這列不受自己影響');
});

check('篩選區 HTML：只有會計一列（沒有類型）、選中與 0 筆樣式、未收到紙本開關', () => {
  const f = M.emptyFilter();
  f.region.add('高雄');
  f.noPaper = true;
  const html = M.renderFilters(fRows(), f);
  assert.ok(html.includes('>會計</span>') && !html.includes('類型'));
  assert.ok(/class="pr-bvs-chip pr-bvs-on" data-k="region" data-v="高雄"/.test(html));
  assert.ok(/class="pr-bvs-chip pr-bvs-on pr-bvs-warn" data-k="noPaper"/.test(html));
  const none = M.emptyFilter();
  none.noPaper = true;
  assert.ok(/class="pr-bvs-chip pr-bvs-zero" data-k="region" data-v="台北"/.test(M.renderFilters(fRows(), none)));
});

check('版面：表格欄位（會計、受款人，沒有類型）、鎖住排最後、備註只標例外、日期不是今年標紅', () => {
  const rows = [row(3, { receipt: '未收到' }), row(2, { vno: 'A', vdate: '2025-12-01' }), row(1, { status: '單位會計處理中(高雄)' })];
  const t = M.renderTable(rows, { keyword: '', selected: new Set(['1']), filter: M.emptyFilter(), badIds: new Set(['2']) });
  assert.deepStrictEqual(t.visible.map((r) => r.id), ['2', '1', '3'], '預設不篩：鎖住的也顯示、排最後');
  assert.ok(t.html.includes('<th>會計</th>') && t.html.includes('<th>受款人</th>') && !t.html.includes('類型') && t.html.includes('>高雄</td>'));
  assert.ok(t.html.includes('class="pr-bvs-bad"'), '既有日期不是今年 → 標紅');
  assert.ok(t.html.includes('pr-bvs-row-sel') && t.html.includes('pr-bvs-row-locked'));
  assert.ok(!t.html.includes('填寫：') && !t.html.includes('只簽核'), '備註只標例外');
  const np = M.emptyFilter();
  np.noPaper = true;
  assert.deepStrictEqual(M.renderTable(rows, { keyword: '', selected: new Set(), filter: np, badIds: new Set() }).visible.map((r) => r.id), ['3']);
  assert.deepStrictEqual(M.renderTable(rows, { keyword: '高雄', selected: new Set(), badIds: new Set() }).visible.map((r) => r.id), ['1'], '沒給 filter 視為不篩');
  assert.ok(M.renderTable([], { keyword: '', selected: new Set(), badIds: new Set() }).html.includes('沒有符合條件的記錄'));
});

check('版面：執行摘要與按鈕筆數；傳票日期預設今天；不是今年的列只在執行入帳完成時標出', () => {
  const chosen = [row(1), row(2, { vno: 'A', vdate: '2026-01-01' }), M.classifyRow(rec(3, { assignees: ['a'], units: ['ACC_TPE'] }), joinCtx)];
  assert.deepStrictEqual(M.summarize(chosen, true), { total: 3, join: 1, fill: 2, act: 3 });
  assert.deepStrictEqual(M.summarize(chosen, false), { total: 3, join: 1, fill: 2, act: 0 });
  assert.strictEqual(M.summaryLine(M.summarize([], true)), '尚未勾選記錄');
  const line = M.summaryLine(M.summarize(chosen, false));
  assert.ok(line.includes('已選 <b>3</b>') && line.includes('加入執行者 <b>1</b>') && line.includes('不執行入帳完成'));
  assert.strictEqual(M.todayStr(new Date(2026, 0, 5)), '2026-01-05');
  const rows = [row(1), row(2, { vno: 'A', vdate: '2025-12-31' }), row(3, { vno: 'B', vdate: '2026-02-02' }), row(4, { vno: 'C' })];
  assert.deepStrictEqual(M.badDateIds(rows, '2026-11-24', 2026, true), ['2']);
  assert.deepStrictEqual(M.badDateIds(rows, '2025-11-24', 2026, true), ['1', '2', '4']);
  assert.deepStrictEqual(M.badDateIds(rows, '2025-11-24', 2026, false), []);
});

check('註冊與載入：按鈕在「批次動作」下拉選單（本檔不註冊 index.show、開放 openDialog）；src/index.js 排在批次整理資料之後；檔案批次選單有這一項；package.json test 有本檔；不寫死 App ID', () => {
  assert.strictEqual(registered.filter((r) => r.name === 'app.record.index.show').length, 0);
  assert.strictEqual(typeof M.openDialog, 'function');
  const idx = readSrc('src/index.js');
  const iPrev = idx.indexOf("'../批次整理資料.js");
  const iMod = idx.indexOf(`'../${MOD}`);
  assert.ok(iPrev > 0 && iMod > iPrev);
  const batch = readSrc('檔案批次.js');
  assert.ok(batch.includes('📋 批次填傳票／入帳完成') && batch.includes("import { openDialog as openBatchVoucherDialog } from './批次填傳票_入帳完成.js';") && batch.includes('openBatchVoucherDialog()'));
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
