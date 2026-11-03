'use strict';

// 測試：批次整理資料.js —— 交通費轉出 Excel
//   樣板語法（單層大括號）：{欄位}、{交通費請款單.欄位}（目前這一列明細）、{序號}、{TODAY}、{$id}、
//     篩選器 {欄位|數字|左5|括號內}、算式 ={…}-{…}
//   每筆記錄轉出 應付帳款／費用成本／（總稅額不為 0 才有）稅額 最多三列；{交通費請款單.欄位} 在稅額列取第一個有稅額的明細列，其餘取第一列；單一工作表；儲存格依「儲存格格式」存型別。
// 單獨執行：node tests/batch_organize.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');

const registered = [];
global.window = {};
global.kintone = {
  app: { getId: () => 749, record: {} },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(readSrc('批次整理資料.js'));

const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const B = global.window.PR_BATCH_ORGANIZE;
const { parseTemplate, resolveToken, applyFilters, evalArithmetic, buildRows, buildSheet, toCell, mapMappingRecord, columnIndex, columnLetters, formatDate } = B;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// 攔截 console.warn，確認有警告又不讓測試輸出變吵
const withWarn = (fn) => {
  const orig = console.warn;
  const msgs = [];
  console.warn = (...a) => msgs.push(a.join(' '));
  try {
    fn(msgs);
  } finally {
    console.warn = orig;
  }
};

console.log('batch_organize.test.cjs');

// ── 假資料 ─────────────────────────────────────────────────────────────────
const TODAY = new Date(2026, 9, 28); // 2026/10/28

const detail = (cols) => ({ value: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, { value: v }])) });
const sumCol = (details, col) => String(details.reduce((a, d) => a + (Number(String(d.value[col]?.value ?? '').replace(/,/g, '')) || 0), 0));
const mkRecord = (id, no, owner, details, extra = {}) => ({
  [F.TOTAL_AMOUNT]: { value: sumCol(details, T.COLS.AMOUNT) },
  [F.TOTAL_TAX]: { value: sumCol(details, T.COLS.TAX) },
  $id: { value: String(id) },
  [F.RECORD_NO]: { value: String(no) },
  [F.PAYEE]: { value: '24136T TEST' },
  [F.EXPENSE_OWNER]: { value: owner },
  [F.EXPECTED_PAY_DATE]: { value: '2026-11-10' },
  [F.PAY_METHOD]: { value: ['現金', '電匯'] },
  [F.REASON]: { value: '' },
  [T.CODE]: { value: details },
  ...extra,
});
const OWNER = [{ code: '24136T', name: 'Jimmy Lai (賴彥廷)' }];
const D = (amount, tax, extra = {}) =>
  detail({
    [T.COLS.AMOUNT]: String(amount),
    [T.COLS.TAX]: String(tax),
    [T.COLS.EXPENSE]: 'AJ63',
    [T.COLS.VEHICLE]: '高鐵',
    [T.COLS.ROUTE]: '台北-台中',
    [T.COLS.VISIT_CUSTOMER]: 'ABC',
    [T.COLS.INVOICE_NO]: 'AB12345678',
    [T.COLS.SELLER_TAX_ID]: '00012345',
    [T.COLS.DATE]: '2026-10-05',
    [T.COLS.FORMAT]: '21',
    ...extra,
  });

// 兩列明細：第 1 列金額 3000 稅額 0（費用歸屬 AJ63）、第 2 列金額 476 稅額 166（費用歸屬 XXXX）→ 總金額 3476、總稅額 166
const record = mkRecord(88, 12, OWNER, [D(3000, 0), D(476, 166, { [T.COLS.EXPENSE]: 'XXXX', [T.COLS.INVOICE_NO]: 'ZZ99999999', [T.COLS.SELLER_TAX_ID]: '99999999' })]);
const ctx = (over = {}) => ({ record, seq: 7, today: TODAY, dateFormat: 'YYYY/MM/DD', ...over });
const tmpl = (...parts) => parts.join('');
const tok = (s) => `{${s}}`;
const tcol = (col) => tok(`${T.CODE}.${col}`);

// ── 1. 取值：每一種 token ─────────────────────────────────────────────────────
check('{欄位}：主表文字、記錄編號欄位', () => {
  assert.strictEqual(parseTemplate(tok(F.PAYEE), ctx()), '24136T TEST');
  assert.strictEqual(parseTemplate(tok(F.RECORD_NO), ctx()), '12');
});

check('{欄位}：人員欄位（陣列 {code,name}）取名稱，多人用逗號串', () => {
  assert.strictEqual(parseTemplate(tok(F.EXPENSE_OWNER), ctx()), 'Jimmy Lai (賴彥廷)');
  const two = mkRecord(1, 1, [{ code: 'a', name: 'A 甲' }, { code: 'b', name: 'B 乙' }], []);
  assert.strictEqual(parseTemplate(tok(F.EXPENSE_OWNER), { record: two }), 'A 甲,B 乙');
});

check('{欄位}：組織、群組欄位同樣取名稱；沒有 name 退回 code', () => {
  const r = { org: { value: [{ code: 'D01', name: '業務部' }] }, grp: { value: [{ code: 'G1', name: '會計群' }] }, nm: { value: [{ code: 'only' }] } };
  assert.strictEqual(parseTemplate('{org}', { record: r }), '業務部');
  assert.strictEqual(parseTemplate('{grp}', { record: r }), '會計群');
  assert.strictEqual(parseTemplate('{nm}', { record: r }), 'only');
});

check('{欄位}：核取方塊／多選（字串陣列）用逗號串；空值、不存在的欄位、null → 空字串', () => {
  assert.strictEqual(parseTemplate(tok(F.PAY_METHOD), ctx()), '現金,電匯');
  assert.strictEqual(parseTemplate(tok(F.REASON), ctx()), '');
  assert.strictEqual(parseTemplate('{不存在的欄位}', ctx()), '');
  assert.strictEqual(parseTemplate('{x}', { record: { x: { value: null } } }), '');
  assert.strictEqual(parseTemplate('{x}', { record: { x: {} } }), '');
});

check('{日期欄位}：YYYY-MM-DD 依日期格式輸出（預設 YYYY/MM/DD）', () => {
  assert.strictEqual(parseTemplate(tok(F.EXPECTED_PAY_DATE), ctx({ dateFormat: undefined })), '2026/11/10');
  assert.strictEqual(parseTemplate(tok(F.EXPECTED_PAY_DATE), ctx({ dateFormat: 'YYYYMMDD' })), '20261110');
  assert.strictEqual(parseTemplate(tok(F.EXPECTED_PAY_DATE), ctx({ dateFormat: 'YYYY-MM-DD' })), '2026-11-10');
  assert.strictEqual(parseTemplate(tcol(T.COLS.DATE), ctx({ dateFormat: 'YYYYMMDD' })), '20261005');
});

check('{交通費請款單.欄位}：應付帳款、費用成本列取第一列明細；稅額列取第一個稅額不為 0 的列', () => {
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), ctx({ kind: 'ap' })), 'AJ63');
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), ctx({ kind: 'expense' })), 'AJ63');
  assert.strictEqual(parseTemplate(tcol(T.COLS.AMOUNT), ctx({ kind: 'expense' })), '3000');
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), ctx({ kind: 'tax' })), 'XXXX');
  assert.strictEqual(parseTemplate(tcol(T.COLS.AMOUNT), ctx({ kind: 'tax' })), '476');
  assert.strictEqual(parseTemplate(tcol(T.COLS.INVOICE_NO), ctx({ kind: 'tax' })), 'ZZ99999999');
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), { record }), 'AJ63', '沒給 kind 當第一列');
});

check('{交通費請款單.欄位}：稅額列在所有明細稅額都是 0／空時退回第一列；沒有明細或別的子表格 → 空字串', () => {
  const none = mkRecord(1, 1, OWNER, [D(100, 0, { [T.COLS.EXPENSE]: 'FIRST' }), D(200, '', { [T.COLS.EXPENSE]: 'SECOND' })]);
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), ctx({ record: none, kind: 'tax' })), 'FIRST');
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), { record: { [T.CODE]: { value: [] } }, kind: 'tax' }), '');
  assert.strictEqual(parseTemplate(tcol(T.COLS.EXPENSE), { record: {} }), '');
  assert.strictEqual(parseTemplate('{沒有的表.欄位}', ctx()), '');
});

check('{總金額}、{總稅額} 是一般主表欄位（CALC 值是字串）', () => {
  assert.strictEqual(parseTemplate(tok(F.TOTAL_AMOUNT), ctx()), '3476');
  assert.strictEqual(parseTemplate(tok(F.TOTAL_TAX), ctx()), '166');
  assert.strictEqual(parseTemplate(tok(F.TOTAL_TAX), { record: { [F.TOTAL_TAX]: { value: '' } } }), '');
});

check('{序號}、{TODAY}、{$id}', () => {
  assert.strictEqual(parseTemplate('{序號}', ctx({ seq: 7 })), '7');
  assert.strictEqual(parseTemplate('{TODAY}', ctx()), '2026/10/28');
  assert.strictEqual(parseTemplate('{TODAY}', ctx({ dateFormat: 'YYYYMMDD' })), '20261028');
  assert.strictEqual(parseTemplate('{TODAY}', ctx({ dateFormat: 'YYYY-MM-DD' })), '2026-10-28');
  assert.strictEqual(parseTemplate('{$id}', ctx()), '88');
  assert.match(parseTemplate('{TODAY}', { record }), /^\d{4}\/\d{2}\/\d{2}$/, '沒給 today 就用現在');
});

check('括號外的文字照用、多個 token 與固定文字併用；空白樣板 → 空字串', () => {
  assert.strictEqual(parseTemplate('固定值100', ctx()), '固定值100');
  assert.strictEqual(parseTemplate('', ctx()), '');
  assert.strictEqual(parseTemplate('   ', ctx()), '');
  assert.strictEqual(parseTemplate(undefined, ctx()), '');
  assert.strictEqual(parseTemplate(null, ctx()), '');
  assert.strictEqual(parseTemplate(`NX-{$id}-${tok(F.PAYEE)}`, ctx()), 'NX-88-24136T TEST');
  assert.strictEqual(parseTemplate(`${tcol(T.COLS.EXPENSE)}H`, ctx()), 'AJ63H');
});

check('舊的 {{ }} 語法不再支援：外層大括號被當成文字', () => {
  assert.strictEqual(parseTemplate(`{{${F.PAYEE}}}`, ctx()), '{24136T TEST}');
});

check('欄位值裡的 $ 不會被當成取代語法', () => {
  const r = { [F.PAYEE]: { value: "A$&B$'C" } };
  assert.strictEqual(parseTemplate(`<${tok(F.PAYEE)}>`, { record: r }), "<A$&B$'C>");
});

check('resolveToken 可單獨呼叫（不含大括號）', () => {
  assert.strictEqual(resolveToken('$id', ctx()), '88');
  assert.strictEqual(resolveToken(`${F.PAYEE}|數字`, ctx()), '24136');
});

// ── 2. 篩選器 ────────────────────────────────────────────────────────────────
check('篩選器 數字：只留數字', () => {
  assert.strictEqual(parseTemplate(`${tok(`${F.PAYEE}|數字`)}`, ctx()), '24136');
  assert.strictEqual(applyFilters('a1b2-3　4', ['數字']), '1234');
  assert.strictEqual(applyFilters('abc', ['數字']), '');
});

check('篩選器 左N：前 N 個字（不足就整段、中文照字數、0 為空）', () => {
  assert.strictEqual(applyFilters('1234567', ['左5']), '12345');
  assert.strictEqual(applyFilters('123', ['左5']), '123');
  assert.strictEqual(applyFilters('賴彥廷先生', ['左3']), '賴彥廷');
  assert.strictEqual(applyFilters('abc', ['左0']), '');
});

check('篩選器 括號內：半形、全形、取最後一組、去空白、沒括號回原文', () => {
  assert.strictEqual(applyFilters('Jimmy Lai (賴彥廷)', ['括號內']), '賴彥廷');
  assert.strictEqual(applyFilters('Jimmy Lai（賴彥廷）', ['括號內']), '賴彥廷');
  assert.strictEqual(applyFilters('Jimmy Lai ( 賴彥廷 )', ['括號內']), '賴彥廷');
  assert.strictEqual(applyFilters('A(第一)B(第二)', ['括號內']), '第二');
  assert.strictEqual(applyFilters('A(第一)B（第二）', ['括號內']), '第二');
  assert.strictEqual(applyFilters('Jimmy Lai', ['括號內']), 'Jimmy Lai');
  assert.strictEqual(parseTemplate(`${tok(`${F.EXPENSE_OWNER}|括號內`)}`, ctx()), '賴彥廷');
});

check('篩選器可串接，由左到右套用', () => {
  assert.strictEqual(parseTemplate(tok(`${F.PAYEE}|數字|左3`), ctx()), '241');
  assert.strictEqual(parseTemplate(tok(`${F.PAYEE}|左3|數字`), ctx()), '241');
  assert.strictEqual(parseTemplate(tok(`${F.PAYEE}|左2|數字`), ctx()), '24');
  assert.strictEqual(parseTemplate(tok(`${F.EXPENSE_OWNER}|括號內|左2`), ctx()), '賴彥');
  assert.strictEqual(parseTemplate(tok(`${F.PAYEE} | 數字 | 左5`), ctx()), '24136', '空白不影響');
});

check('不認得的篩選器：警告並忽略', () => {
  withWarn((msgs) => {
    assert.strictEqual(applyFilters('abc', ['亂寫']), 'abc');
    assert.ok(msgs.length === 1);
  });
});

// ── 3. 算式 ──────────────────────────────────────────────────────────────────
check('算式：={總金額}-{總稅額}；明細欄位則依列種類取第一列或有稅額的列', () => {
  assert.strictEqual(parseTemplate(`=${tok(F.TOTAL_AMOUNT)}-${tok(F.TOTAL_TAX)}`, ctx()), '3310');
  const expr = `=${tcol(T.COLS.AMOUNT)}-${tcol(T.COLS.TAX)}`;
  assert.strictEqual(parseTemplate(expr, ctx({ kind: 'expense' })), '3000');
  assert.strictEqual(parseTemplate(expr, ctx({ kind: 'tax' })), '310');
});

check('算式：加減、數字常數、空白、連續正負號、小數去除浮點誤差、可為負數', () => {
  assert.strictEqual(evalArithmetic('1+2+3', ctx()), 6);
  assert.strictEqual(evalArithmetic(' 10 - 3 + 1 ', ctx()), 8);
  assert.strictEqual(evalArithmetic('-5+2', ctx()), -3);
  assert.strictEqual(evalArithmetic('5- -2', ctx()), 7);
  assert.strictEqual(evalArithmetic('0.1+0.2', ctx()), 0.3);
  assert.strictEqual(evalArithmetic('2-5', ctx()), -3);
  assert.strictEqual(parseTemplate('  = 2 + 3', ctx()), '5', '樣板前後空白可有');
});

check('算式：空白運算元當 0、逗號千分位可算', () => {
  const expr = `=${tcol(T.COLS.AMOUNT)}-${tcol(T.COLS.TAX)}`;
  assert.strictEqual(parseTemplate(expr, ctx({ record: mkRecord(1, 1, OWNER, [D('', 166)]) })), '-166');
  assert.strictEqual(parseTemplate(expr, ctx({ record: mkRecord(1, 1, OWNER, [D('1,000', '')]) })), '1000');
  assert.strictEqual(parseTemplate(`=${tok(F.TOTAL_AMOUNT)}-${tok(F.TOTAL_TAX)}`, { record: { [F.TOTAL_AMOUNT]: { value: '100' } } }), '100', '總稅額沒值當 0');
  assert.strictEqual(parseTemplate('={不存在}+5', ctx()), '5');
});

check('算式：token 可帶篩選器', () => {
  assert.strictEqual(parseTemplate(`=${tok(`${F.PAYEE}|數字`)}+1`, ctx()), '24137');
});

check('算式：運算元不是數字 → 結果空字串並警告', () => {
  withWarn((msgs) => {
    assert.strictEqual(parseTemplate(`=${tok(F.PAYEE)}+1`, ctx()), '');
    assert.strictEqual(msgs.length, 1);
  });
  withWarn(() => {
    assert.strictEqual(parseTemplate('=1+', ctx()), '', '結尾缺運算元');
    assert.strictEqual(parseTemplate('=', ctx()), '', '什麼都沒有');
    assert.strictEqual(parseTemplate('=1 2', ctx()), '', '兩個數字中間沒運算子');
    assert.strictEqual(parseTemplate('=1*2', ctx()), '', '不支援乘除');
    assert.strictEqual(parseTemplate('=abc', ctx()), '');
  });
  assert.strictEqual(evalArithmetic('1+x', ctx()), null);
});

check('算式不用 eval／Function', () => {
  const src = readSrc('批次整理資料.js');
  assert.ok(!/\beval\s*\(/.test(src) && !/new Function\b/.test(src));
});

// ── 4. 欄位字母 ──────────────────────────────────────────────────────────────
check('欄位字母 ↔ 索引：A、Z、AA、AZ、BA，小寫與空白可容忍，非字母 → -1', () => {
  assert.strictEqual(columnIndex('A'), 0);
  assert.strictEqual(columnIndex('Q'), 16);
  assert.strictEqual(columnIndex('Z'), 25);
  assert.strictEqual(columnIndex('AA'), 26);
  assert.strictEqual(columnIndex('AZ'), 51);
  assert.strictEqual(columnIndex('BA'), 52);
  assert.strictEqual(columnIndex(' b '), 1);
  assert.strictEqual(columnIndex(''), -1);
  assert.strictEqual(columnIndex('A1'), -1);
  assert.strictEqual(columnIndex(undefined), -1);
  [0, 1, 25, 26, 51, 52, 701, 702].forEach((i) => assert.strictEqual(columnIndex(columnLetters(i)), i));
  assert.strictEqual(columnLetters(26), 'AA');
});

// ── 5. 儲存格型別 ────────────────────────────────────────────────────────────
check('儲存格 文字：字串＋@ 格式，前導 0、純數字都保留', () => {
  assert.deepStrictEqual(toCell('00012345', '文字'), { t: 's', v: '00012345', z: '@' });
  assert.deepStrictEqual(toCell('2100000', '文字'), { t: 's', v: '2100000', z: '@' });
  assert.deepStrictEqual(toCell('20261028', '文字'), { t: 's', v: '20261028', z: '@' });
});

check('儲存格 數值：數字＋#,##0；千分位可解；非數字或空 → 不建立', () => {
  assert.deepStrictEqual(toCell('3476', '數值'), { t: 'n', v: 3476, z: '#,##0' });
  assert.deepStrictEqual(toCell('1,234', '數值'), { t: 'n', v: 1234, z: '#,##0' });
  assert.deepStrictEqual(toCell('-166', '數值'), { t: 'n', v: -166, z: '#,##0' });
  assert.deepStrictEqual(toCell('0', '數值'), { t: 'n', v: 0, z: '#,##0' });
  assert.strictEqual(toCell('', '數值'), null);
  assert.strictEqual(toCell('abc', '數值'), null);
});

check('儲存格 日期：合法日期 → 日期序號＋yyyy/mm/dd；三種文字格式都認；否則留字串', () => {
  const serial = 46323; // 2026/10/28
  assert.deepStrictEqual(toCell('2026/10/28', '日期'), { t: 'n', v: serial, z: 'yyyy/mm/dd' });
  assert.deepStrictEqual(toCell('20261028', '日期'), { t: 'n', v: serial, z: 'yyyy/mm/dd' });
  assert.deepStrictEqual(toCell('2026-10-28', '日期'), { t: 'n', v: serial, z: 'yyyy/mm/dd' });
  assert.deepStrictEqual(toCell('2026/02/30', '日期'), { t: 's', v: '2026/02/30' });
  assert.deepStrictEqual(toCell('明天', '日期'), { t: 's', v: '明天' });
});

check('儲存格 一般：整數、小數、負數、單獨的 0 → 數字；前導 0、超過 15 位、非數字 → 字串', () => {
  assert.deepStrictEqual(toCell('3476', '一般'), { t: 'n', v: 3476 });
  assert.deepStrictEqual(toCell('12.5', '一般'), { t: 'n', v: 12.5 });
  assert.deepStrictEqual(toCell('-3', '一般'), { t: 'n', v: -3 });
  assert.deepStrictEqual(toCell('0', '一般'), { t: 'n', v: 0 });
  assert.deepStrictEqual(toCell('0.5', '一般'), { t: 'n', v: 0.5 });
  assert.deepStrictEqual(toCell('007', '一般'), { t: 's', v: '007' });
  assert.deepStrictEqual(toCell('123456789012345', '一般'), { t: 'n', v: 123456789012345 });
  assert.deepStrictEqual(toCell('1234567890123456', '一般'), { t: 's', v: '1234567890123456' });
  assert.deepStrictEqual(toCell('AB123', '一般'), { t: 's', v: 'AB123' });
  assert.deepStrictEqual(toCell('1.AP', '一般'), { t: 's', v: '1.AP' });
  assert.deepStrictEqual(toCell('12_賴彥廷_交通費', '一般'), { t: 's', v: '12_賴彥廷_交通費' });
});

check('儲存格：空值 → 不建立（任何格式）；未知格式當一般', () => {
  ['一般', '文字', '數值', '日期'].forEach((f) => {
    assert.strictEqual(toCell('', f), null);
    assert.strictEqual(toCell(undefined, f), null);
    assert.strictEqual(toCell(null, f), null);
  });
  assert.deepStrictEqual(toCell('12', undefined), { t: 'n', v: 12 });
});

// ── 6. 設定記錄轉換 ───────────────────────────────────────────────────────────
check('mapMappingRecord：欄位全轉；日期格式空 → YYYY/MM/DD，儲存格格式空 → 一般；缺欄位不當掉', () => {
  const m = mapMappingRecord({
    Excel欄位代碼: { value: ' B ' },
    Excel欄位說明: { value: '日期' },
    排序: { value: '2' },
    應付帳款_值: { value: '{TODAY}' },
    費用成本_值: { value: '' },
    稅額_值: { value: '{TODAY}' },
    日期格式: { value: 'YYYYMMDD' },
    儲存格格式: { value: '文字' },
  });
  assert.deepStrictEqual(m, {
    excelColumn: 'B',
    excelColumnName: '日期',
    sortOrder: 2,
    應付帳款_值: '{TODAY}',
    費用成本_值: '',
    稅額_值: '{TODAY}',
    dateFormat: 'YYYYMMDD',
    cellFormat: '文字',
  });
  const e = mapMappingRecord({ Excel欄位代碼: { value: 'C' }, 日期格式: { value: '' }, 儲存格格式: { value: null } });
  assert.strictEqual(e.dateFormat, 'YYYY/MM/DD');
  assert.strictEqual(e.cellFormat, '一般');
  assert.strictEqual(e.應付帳款_值, '');
  assert.doesNotThrow(() => mapMappingRecord({}));
});

// ── 7. 列產生 ────────────────────────────────────────────────────────────────
const mini = (over = {}) => ({
  excelColumn: 'A',
  excelColumnName: '序號',
  sortOrder: 1,
  應付帳款_值: '{序號}',
  費用成本_值: '{序號}',
  稅額_值: '{序號}',
  dateFormat: 'YYYY/MM/DD',
  cellFormat: '一般',
  ...over,
});
const typeCol = mini({ excelColumn: 'B', excelColumnName: '類別', 應付帳款_值: '1.AP', 費用成本_值: '2.費用', 稅額_值: '3.稅' });

check('列順序：兩筆記錄（總稅額 0 與 166）→ AP、費用、AP、費用、稅；序號連續', () => {
  const r1 = mkRecord(1, 1, OWNER, [D(100, 0)]);
  const r2 = mkRecord(2, 2, OWNER, [D(3476, 166)]);
  const rows = buildRows([mini(), typeCol], [r1, r2], TODAY);
  assert.deepStrictEqual(
    rows.map((r) => r.map((c) => c.value)),
    [
      ['1', '1.AP'],
      ['2', '2.費用'],
      ['3', '1.AP'],
      ['4', '2.費用'],
      ['5', '3.稅'],
    ],
  );
});

check('一筆記錄不管幾列明細都只轉 AP、費用（、稅）各一列；總稅額空、"0"、0 跳過稅額列，負數與小數不跳過', () => {
  const kindsOf = (r) => buildRows([typeCol], [r], TODAY).map((row) => row[0].value);
  const many = [D(100, 5), D(200, 0), D(300, 0)];
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many)), ['1.AP', '2.費用', '3.稅']);
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many, { [F.TOTAL_TAX]: { value: '0' } })), ['1.AP', '2.費用']);
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many, { [F.TOTAL_TAX]: { value: '' } })), ['1.AP', '2.費用']);
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many, { [F.TOTAL_TAX]: { value: 0 } })), ['1.AP', '2.費用']);
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many, { [F.TOTAL_TAX]: {} })), ['1.AP', '2.費用']);
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many, { [F.TOTAL_TAX]: { value: '-20' } })), ['1.AP', '2.費用', '3.稅']);
  assert.deepStrictEqual(kindsOf(mkRecord(1, 1, OWNER, many, { [F.TOTAL_TAX]: { value: '0.5' } })), ['1.AP', '2.費用', '3.稅']);
});

check('稅額列是否產生只看主表總稅額（不看各列明細稅額）', () => {
  const r = mkRecord(1, 1, OWNER, [D(100, 5)], { [F.TOTAL_TAX]: { value: '0' } });
  assert.strictEqual(buildRows([typeCol], [r], TODAY).length, 2);
  const r2 = mkRecord(1, 1, OWNER, [D(100, 0)], { [F.TOTAL_TAX]: { value: '5' } });
  assert.strictEqual(buildRows([typeCol], [r2], TODAY).length, 3);
});

check('明細欄位的來源列：AP、費用取第一列，稅取第一個有稅額的列', () => {
  const r = mkRecord(1, 1, OWNER, [D(111, 0, { [T.COLS.EXPENSE]: 'AAA' }), D(222, 7, { [T.COLS.EXPENSE]: 'BBB' }), D(333, 9, { [T.COLS.EXPENSE]: 'CCC' })]);
  const m = mini({ excelColumn: 'F', excelColumnName: '歸屬', 應付帳款_值: tcol(T.COLS.EXPENSE), 費用成本_值: tcol(T.COLS.EXPENSE), 稅額_值: tcol(T.COLS.EXPENSE) });
  assert.deepStrictEqual(buildRows([m], [r], TODAY).map((row) => row[0].value), ['AAA', 'AAA', 'BBB']);
});

check('沒有明細列的記錄照樣轉出 AP、費用（總稅額為 0 不轉稅額）；沒有記錄 → 空陣列；序號連續', () => {
  const empty = mkRecord(1, 1, OWNER, []);
  const r2 = mkRecord(2, 2, OWNER, [D(100, 0)]);
  const rows = buildRows([mini(), typeCol], [empty, r2], TODAY);
  assert.deepStrictEqual(rows.map((r) => r[0].value), ['1', '2', '3', '4']);
  assert.deepStrictEqual(buildRows([mini()], [], TODAY), []);
  assert.strictEqual(buildRows([mini()], [{ $id: { value: '3' } }], TODAY).length, 2);
});

check('每個儲存格帶自己那欄的儲存格格式；日期格式依欄位套用', () => {
  const m = [
    mini({ excelColumn: 'A', 應付帳款_值: '{TODAY}', 費用成本_值: '{TODAY}', 稅額_值: '{TODAY}', dateFormat: 'YYYYMMDD', cellFormat: '文字' }),
    mini({ excelColumn: 'B', 應付帳款_值: '{TODAY}', 費用成本_值: '{TODAY}', 稅額_值: '{TODAY}', dateFormat: 'YYYY-MM-DD', cellFormat: '日期' }),
  ];
  const rows = buildRows(m, [mkRecord(1, 1, OWNER, [D(1, 0)])], TODAY);
  assert.deepStrictEqual(rows[0], [
    { value: '20261028', format: '文字' },
    { value: '2026-10-28', format: '日期' },
  ]);
});

// ── 8. 組成工作表 ────────────────────────────────────────────────────────────
check('標題列：依 Excel欄位代碼放位置，中間空欄留空，AA 在 Z 後面；只有一列標題', () => {
  const m = [
    mini({ excelColumn: 'A', excelColumnName: '序號' }),
    mini({ excelColumn: 'C', excelColumnName: '類別' }),
    mini({ excelColumn: 'AA', excelColumnName: '最後一欄' }),
  ];
  const rows = buildRows(m, [mkRecord(1, 1, OWNER, [D(1, 0)])], TODAY);
  const ws = buildSheet(m, rows);
  assert.strictEqual(ws.A1.v, '序號');
  assert.strictEqual(ws.C1.v, '類別');
  assert.strictEqual(ws.AA1.v, '最後一欄');
  assert.ok(!('B1' in ws) && !('Z1' in ws), '空欄不建立');
  assert.strictEqual(ws.A2.v, 1, '第 2 列就是資料（沒有欄位字母列）');
  assert.strictEqual(ws['!ref'], 'A1:AA3');
  assert.strictEqual(ws['!cols'].length, 27);
  assert.strictEqual(ws['!cols'][0].wch, 12);
});

check('標題寬度：標題比 12 長就用標題長度；順序亂也依欄位代碼放', () => {
  const m = [mini({ excelColumn: 'C', excelColumnName: '一二三四五六七八九十一二三四', 應付帳款_值: 'x', 費用成本_值: 'x', 稅額_值: 'x' }), mini({ excelColumn: 'A', excelColumnName: '短' })];
  const ws = buildSheet(m, buildRows(m, [mkRecord(1, 1, OWNER, [D(1, 0)])], TODAY));
  assert.strictEqual(ws['!cols'][2].wch, 14);
  assert.strictEqual(ws['!cols'][0].wch, 12);
  assert.strictEqual(ws.C2.v, 'x');
  assert.strictEqual(ws.A1.v, '短');
});

check('資料列依儲存格格式存型別；空值不建立儲存格；Excel欄位代碼不是字母的欄略過', () => {
  const m = [
    mini({ excelColumn: 'A', excelColumnName: '編號', 應付帳款_值: '00123', 費用成本_值: '00123', 稅額_值: '00123', cellFormat: '文字' }),
    mini({ excelColumn: 'B', excelColumnName: '金額', 應付帳款_值: tcol(T.COLS.AMOUNT), 費用成本_值: '', 稅額_值: '', cellFormat: '數值' }),
    mini({ excelColumn: '1', excelColumnName: '壞欄位' }),
  ];
  const r = mkRecord(1, 1, OWNER, [D(3476, 0)]);
  withWarn((msgs) => {
    const ws = buildSheet(m, buildRows(m, [r], TODAY));
    assert.deepStrictEqual(ws.A2, { t: 's', v: '00123', z: '@' });
    assert.deepStrictEqual(ws.B2, { t: 'n', v: 3476, z: '#,##0' });
    assert.ok(!('B3' in ws), '費用列金額空白 → 沒有儲存格');
    assert.strictEqual(ws['!ref'], 'A1:B3');
    assert.ok(msgs.length >= 1);
  });
});

check('沒有任何有效欄位也不當掉', () => {
  assert.doesNotThrow(() => buildSheet([], []));
  assert.strictEqual(buildSheet([], [])['!ref'], 'A1');
});

// ── 9. 整合：App 的 A～Q 設定 ─────────────────────────────────────────────────
const M = (col, name, ap, exp, tax, dateFormat, cellFormat) =>
  mini({ excelColumn: col, excelColumnName: name, 應付帳款_值: ap, 費用成本_值: exp, 稅額_值: tax, dateFormat: dateFormat || 'YYYY/MM/DD', cellFormat: cellFormat || '一般' });
const amt = tok(F.TOTAL_AMOUNT);
const taxc = tok(F.TOTAL_TAX);
const own = tok(`${F.EXPENSE_OWNER}|括號內`);
const no = tok(F.RECORD_NO);
const assignAP = `${no}_${own}_交通費`;
const FIXTURE = [
  M('A', '序號', '{序號}', '{序號}', '{序號}'),
  M('B', '日期', '{TODAY}', '{TODAY}', '{TODAY}', 'YYYYMMDD'),
  M('C', '類別', '1.AP', '2.費用', '3.稅'),
  M('D', '會科', '2100000', '6020000', '1490000', '', '文字'),
  M('E', '受款人', tok(`${F.PAYEE}|數字|左5`), '', '', '', '文字'),
  M('F', '金額', amt, `=${amt}-${taxc}`, taxc, '', '數值'),
  M('G', '稅基', '', '', `=${amt}-${taxc}`, '', '數值'),
  M('H', 'Cost Center', '', `${tcol(T.COLS.EXPENSE)}H`, ''),
  M('I', 'Profit Center', '', tcol(T.COLS.EXPENSE), tcol(T.COLS.EXPENSE)),
  M('J', 'Business Area', '', '', ''),
  M('K', 'Assinment', assignAP, assignAP, tcol(T.COLS.INVOICE_NO)),
  M('L', '說明', assignAP, `${no}_${own}_${tcol(T.COLS.VEHICLE)}_${tcol(T.COLS.ROUTE)}_${tcol(T.COLS.VISIT_CUSTOMER)}_交通費`, tcol(T.COLS.INVOICE_NO)),
  M('M', '付款日', tok(F.EXPECTED_PAY_DATE), '', '', 'YYYYMMDD'),
  M('N', '匯款方式', 'T', '', ''),
  M('O', '統編', '', '', tcol(T.COLS.SELLER_TAX_ID), '', '文字'),
  M('P', '發票日期', '', '', tcol(T.COLS.DATE), 'YYYYMMDD', '文字'),
  M('Q', '發票格式', '', '', tcol(T.COLS.FORMAT)),
];

check('整合：單號 12、兩列明細（3000／稅 0，476／稅 166）→ 總金額 3476、總稅額 166，轉出 AP、費用、稅三列，逐格檢查內容與型別', () => {
  const r = mkRecord(5, 12, OWNER, [D(3000, 0), D(476, 166, { [T.COLS.EXPENSE]: 'XXXX', [T.COLS.INVOICE_NO]: 'ZZ99999999', [T.COLS.SELLER_TAX_ID]: '99999999', [T.COLS.DATE]: '2026-10-06', [T.COLS.FORMAT]: '22' })]);
  const rows = buildRows(FIXTURE, [r], TODAY);
  assert.strictEqual(rows.length, 3);
  const ws = buildSheet(FIXTURE, rows);

  // 標題
  assert.deepStrictEqual(
    FIXTURE.map((m) => ws[`${m.excelColumn}1`].v),
    FIXTURE.map((m) => m.excelColumnName),
  );
  assert.strictEqual(ws['!ref'], 'A1:Q4');

  // AP（第 2 列）
  assert.deepStrictEqual(ws.A2, { t: 'n', v: 1 });
  assert.deepStrictEqual(ws.B2, { t: 'n', v: 20261028 });
  assert.deepStrictEqual(ws.C2, { t: 's', v: '1.AP' });
  assert.deepStrictEqual(ws.D2, { t: 's', v: '2100000', z: '@' });
  assert.deepStrictEqual(ws.E2, { t: 's', v: '24136', z: '@' });
  assert.deepStrictEqual(ws.F2, { t: 'n', v: 3476, z: '#,##0' });
  assert.ok(!('G2' in ws) && !('H2' in ws) && !('I2' in ws) && !('J2' in ws));
  assert.deepStrictEqual(ws.K2, { t: 's', v: '12_賴彥廷_交通費' });
  assert.deepStrictEqual(ws.L2, { t: 's', v: '12_賴彥廷_交通費' });
  assert.deepStrictEqual(ws.M2, { t: 'n', v: 20261110 });
  assert.deepStrictEqual(ws.N2, { t: 's', v: 'T' });
  assert.ok(!('O2' in ws) && !('P2' in ws) && !('Q2' in ws));

  // 費用（第 3 列）
  assert.strictEqual(ws.A3.v, 2);
  assert.strictEqual(ws.C3.v, '2.費用');
  assert.deepStrictEqual(ws.D3, { t: 's', v: '6020000', z: '@' });
  assert.ok(!('E3' in ws));
  assert.deepStrictEqual(ws.F3, { t: 'n', v: 3310, z: '#,##0' });
  assert.deepStrictEqual(ws.H3, { t: 's', v: 'AJ63H' });
  assert.deepStrictEqual(ws.I3, { t: 's', v: 'AJ63' });
  assert.strictEqual(ws.K3.v, '12_賴彥廷_交通費');
  assert.strictEqual(ws.L3.v, '12_賴彥廷_高鐵_台北-台中_ABC_交通費');
  assert.ok(!('M3' in ws));

  // 稅（第 4 列）
  assert.strictEqual(ws.A4.v, 3);
  assert.strictEqual(ws.C4.v, '3.稅');
  assert.deepStrictEqual(ws.D4, { t: 's', v: '1490000', z: '@' });
  assert.deepStrictEqual(ws.F4, { t: 'n', v: 166, z: '#,##0' });
  assert.deepStrictEqual(ws.G4, { t: 'n', v: 3310, z: '#,##0' });
  assert.deepStrictEqual(ws.I4, { t: 's', v: 'XXXX' }, '稅額列的明細欄位取有稅額的第 2 列');
  assert.deepStrictEqual(ws.K4, { t: 's', v: 'ZZ99999999' });
  assert.deepStrictEqual(ws.L4, { t: 's', v: 'ZZ99999999' });
  assert.deepStrictEqual(ws.O4, { t: 's', v: '99999999', z: '@' });
  assert.deepStrictEqual(ws.P4, { t: 's', v: '20261006', z: '@' });
  assert.deepStrictEqual(ws.Q4, { t: 'n', v: 22 });
});

check('整合：總稅額 "0" 的記錄只有 AP、費用兩列（稅額欄有值也不轉稅額列）', () => {
  const r = mkRecord(5, 12, OWNER, [D(3000, 0), D(476, 166)], { [F.TOTAL_TAX]: { value: '0' } });
  const rows = buildRows(FIXTURE, [r], TODAY);
  assert.deepStrictEqual(rows.map((x) => x[2].value), ['1.AP', '2.費用']);
  assert.strictEqual(buildSheet(FIXTURE, rows)['!ref'], 'A1:Q3');
});

check('整合：總稅額 0 的記錄不產生稅額列；兩筆記錄序號連續', () => {
  const r1 = mkRecord(5, 12, OWNER, [D(3476, 0)]);
  const r2 = mkRecord(6, 13, [{ code: 'x', name: '王小明' }], [D(1000, 48)]);
  const rows = buildRows(FIXTURE, [r1, r2], TODAY);
  assert.deepStrictEqual(rows.map((r) => r[2].value), ['1.AP', '2.費用', '1.AP', '2.費用', '3.稅']);
  assert.deepStrictEqual(rows.map((r) => r[0].value), ['1', '2', '3', '4', '5']);
  assert.strictEqual(rows[2][10].value, '13_王小明_交通費', '沒有括號的名字原樣使用');
  assert.strictEqual(rows[3][5].value, '952');
});

// ── 10. 其他 ─────────────────────────────────────────────────────────────────
check('valueToText：整段是日期或日期時間才換格式；開頭是日期的文字照原樣', () => {
  const { valueToText } = global.window.PR_BATCH_ORGANIZE;
  assert.strictEqual(valueToText('2026-11-03', 'YYYYMMDD'), '20261103');
  assert.strictEqual(valueToText('2026-11-03T00:00:00Z', 'YYYYMMDD').length, 8);
  assert.strictEqual(valueToText('2026-11-03 拜訪客戶', 'YYYYMMDD'), '2026-11-03 拜訪客戶');
});

check('formatDate：三種格式、Date 物件與日期字串、空值、非法日期', () => {
  const d = new Date(2026, 9, 5);
  assert.strictEqual(formatDate(d, 'YYYYMMDD'), '20261005');
  assert.strictEqual(formatDate(d, 'YYYY-MM-DD'), '2026-10-05');
  assert.strictEqual(formatDate(d), '2026/10/05');
  assert.strictEqual(formatDate('2026-10-05', 'YYYYMMDD'), '20261005');
  assert.strictEqual(formatDate(null, 'YYYYMMDD'), '');
  assert.strictEqual(formatDate('不是日期', 'YYYYMMDD'), '');
});

check('只在列表頁註冊事件；原始碼不含分攤表、舊 {{ }} 語法；設定 App 走 APPS.SAP_MAPPING；明細表走 TRAFFIC_TABLE', () => {
  const all = registered.flatMap((r) => (Array.isArray(r.types) ? r.types : [r.types]));
  assert.deepStrictEqual(all, ['app.record.index.show']);
  const src = readSrc('批次整理資料.js');
  ['ALLOC', 'isMultiAllocation', 'getAllocationData', 'fetchTableConfig', 'ALLOCATION_FIELDS', '分攤表索引欄位', 'EXPENSE_FILL_MODE', '{{', 'parseValue'].forEach((s) =>
    assert.ok(!src.includes(s), s),
  );
  assert.ok(src.includes('APPS.SAP_MAPPING'));
  assert.ok(src.includes('FIELDS.TRAFFIC_TABLE') && src.includes('FIELDS.TOTAL_TAX'), '明細表與總稅額都走 config 常數');
});

check('輸出：單一工作表「交通費」、檔名 交通費轉出_YYYYMMDD.xlsx', () => {
  const src = readSrc('批次整理資料.js');
  assert.ok(src.includes("SHEET_NAME = '交通費'"));
  assert.ok(src.includes('交通費轉出_${formatDate(new Date(), \'YYYYMMDD\')}.xlsx'));
  assert.strictEqual((src.match(/book_append_sheet/g) || []).length, 1);
});

// generateExcel 是 async，用假的 XLSX／alert 驗證：一個活頁簿、一張工作表「交通費」、檔名、沒資料時不寫檔
(async () => {
  const calls = [];
  global.XLSX = {
    utils: {
      book_new: () => ({ sheets: [] }),
      book_append_sheet: (wb, ws, name) => wb.sheets.push({ ws, name }),
    },
    writeFile: (wb, name) => calls.push({ wb, name }),
  };
  const alerts = [];
  global.alert = (m) => alerts.push(m);
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  const res = await B.generateExcel(FIXTURE, [mkRecord(5, 12, OWNER, [D(3476, 166)])]);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, `交通費轉出_${stamp}.xlsx`);
  assert.strictEqual(calls[0].wb.sheets.length, 1);
  assert.strictEqual(calls[0].wb.sheets[0].name, '交通費');
  assert.strictEqual(calls[0].wb.sheets[0].ws['!ref'], 'A1:Q4');
  assert.deepStrictEqual(res, { fileName: calls[0].name, rowCount: 3 });
  passed += 1;
  console.log('  ok - generateExcel：單一工作表「交通費」、檔名 交通費轉出_YYYYMMDD.xlsx');

  const none = await B.generateExcel(FIXTURE, []);
  assert.strictEqual(none, null);
  assert.strictEqual(calls.length, 1, '沒有記錄就不寫檔');
  assert.strictEqual(alerts.length, 1);
  passed += 1;
  console.log('  ok - generateExcel：沒有任何列可轉出 → 提示並不寫檔');

  delete global.XLSX;
  assert.strictEqual(await B.generateExcel(FIXTURE, [record]), null);
  assert.strictEqual(alerts.length, 2, 'SheetJS 沒載入要提示');
  passed += 1;
  console.log('  ok - generateExcel：SheetJS 沒載入 → 提示');

  console.log(`${passed} assertions passed.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
