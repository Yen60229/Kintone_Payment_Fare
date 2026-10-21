'use strict';

// 測試：檔案批次_6版_PDFLib向量版_20260716.js
//   PDF 明細表格設定只認交通費子表格、欄位都在 F.TRAFFIC_TABLE.COLS 內；
//   PDF 表頭是 749 主表欄位（沒有類型、借支、供應商、分攤等）；數字欄位名單；檔名；原始碼沒有 723 其他類型殘留。
// 單獨執行：node tests/batch_pdf_config.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const pdfFile = '檔案批次_6版_PDFLib向量版_20260716.js';
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
const pdfSrc = readSrc(pdfFile);

const registered = [];
global.window = { location: { origin: 'https://example.cybozu.com' } };
global.location = global.window.location;
global.kintone = {
  app: { getId: () => 749, record: {} },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};

console.warn = () => {}; // 測試環境沒有 PDFLib，略過載入警告
// eslint-disable-next-line no-eval
eval(readSrc('payment_request_config.js'));
// eslint-disable-next-line no-eval
eval(pdfSrc);

const C = global.window.PR_CONFIG;
const F = C.FIELDS;
const T = F.TRAFFIC_TABLE;
const B = global.window.PR_BATCH_PDF;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log('batch_pdf_config.test.cjs');

// ── 明細表格設定 ───────────────────────────────────────────────────────────

check('表格設定只有交通費一種：子表格代碼＝F.TRAFFIC_TABLE.CODE（不再依類型挑）', () => {
  assert.strictEqual(B.TABLE_CONFIG.tableFieldName, T.CODE);
  assert.ok(Array.isArray(B.TABLE_CONFIG.fields));
  assert.ok(!('一般請款單' in B.TABLE_CONFIG) && !('交通費請款單' in B.TABLE_CONFIG), '不應再有以類型為鍵的對照表');
});

check('欄位清單：12 欄，順序與顯示名稱照規格', () => {
  assert.deepStrictEqual(
    B.TABLE_CONFIG.fields.map((f) => f[0]),
    ['憑證日期', '交通工具', '拜訪客戶', '起訖點', '金額', '費用歸屬', '備註', '憑證種類', '發票號碼', '賣方統編', '格式', '稅額'],
  );
});

check('每個欄位代碼都在 F.TRAFFIC_TABLE.COLS 內、沒有重複、也沒有漏用', () => {
  const colCodes = Object.values(T.COLS);
  const used = B.TABLE_CONFIG.fields.map((f) => f[1]);
  used.forEach((code) => assert.ok(colCodes.includes(code), `${code} 不在 COLS`));
  assert.strictEqual(new Set(used).size, used.length);
  assert.deepStrictEqual([...used].sort(), [...colCodes].sort());
});

const trafficRow = (over = {}) => ({
  value: {
    [T.COLS.DATE]: { value: '2026-10-05' },
    [T.COLS.VEHICLE]: { value: '計程車' },
    [T.COLS.VISIT_CUSTOMER]: { value: 'A 客戶' },
    [T.COLS.ROUTE]: { value: '台北→桃園' },
    [T.COLS.AMOUNT]: { value: '1234' },
    [T.COLS.EXPENSE]: { value: 'AJ63' },
    [T.COLS.NOTE]: { value: '' },
    [T.COLS.RECEIPT_TYPE]: { value: '發票' },
    [T.COLS.INVOICE_NO]: { value: 'AB12345678' },
    [T.COLS.SELLER_TAX_ID]: { value: '12345678' },
    [T.COLS.FORMAT]: { value: '21' },
    [T.COLS.TAX]: { value: '59' },
    ...over,
  },
});

check('getTableData：讀交通費子表格，欄位依顯示名稱對應，未填的給空字串', () => {
  const data = B.getTableData({ [T.CODE]: { value: [trafficRow(), trafficRow({ [T.COLS.AMOUNT]: { value: '50' } })] } });
  assert.strictEqual(data.rows.length, 2);
  assert.strictEqual(data.displayNames.length, 12);
  assert.strictEqual(data.rows[0]['起訖點'], '台北→桃園');
  assert.strictEqual(data.rows[0]['金額'], '1234');
  assert.strictEqual(data.rows[0]['備註'], '');
  assert.strictEqual(data.rows[1]['金額'], '50');
});

check('getTableData：只認交通費子表格，別的子表格或沒有明細 → null', () => {
  assert.strictEqual(B.getTableData({ 其他子表格: { value: [trafficRow()] } }), null);
  assert.strictEqual(B.getTableData({ [T.CODE]: { value: [] } }), null);
  assert.strictEqual(B.getTableData({}), null);
});

check('數字欄位名單（靠右＋千分位）＝金額、稅額，且都是明細欄位', () => {
  assert.deepStrictEqual([...B.NUMERIC_COLUMNS], ['金額', '稅額']);
  const names = B.TABLE_CONFIG.fields.map((f) => f[0]);
  B.NUMERIC_COLUMNS.forEach((n) => assert.ok(names.includes(n), n));
});

// ── 表頭 ───────────────────────────────────────────────────────────────────

const mainRecord = () => ({
  [F.RECORD_NO]: { value: '15' },
  [F.PAYMENT_DATE]: { value: '2026-10-05' },
  [F.COMPANY_NAME]: { value: 'ＮＸ臺灣國際物流' },
  [F.EXPECTED_PAY_DATE]: { value: '2026-10-20' },
  [F.APPLICANT]: { value: [{ code: '24136', name: '王小明' }] },
  [F.APPLICANT_ORG]: { value: [{ code: 'A01', name: '總務部' }] },
  [F.EXPENSE_OWNER]: { value: [{ code: '24145', name: '陳大文' }] },
  [F.EXPENSE_OWNER_ORG]: { value: [{ code: 'B02', name: '業務一部' }, { code: 'B03', name: '業務二部' }] },
  [F.PAYEE]: { value: '24145 陳大文' },
  [F.PAY_METHOD]: { value: ['現金', '電匯'] },
  [F.VOUCHER_NO]: { value: 'V001' },
  [F.VOUCHER_DATE]: { value: '2026-10-06T00:00:00Z' },
  [F.PAPER_RECEIPT]: { value: '是' },
  [F.REASON]: { value: '拜訪客戶\n搭計程車' },
});

check('表頭涵蓋 749 主表 14 個欄位（兩欄一組共 7 列）', () => {
  const rows = B.buildHeaderRows(mainRecord());
  assert.strictEqual(rows.length, 7);
  const labels = rows.flatMap((r) => [r.l1, r.l2]);
  assert.deepStrictEqual(labels, [
    '交通費請款單號', '請款日期',
    '公司名稱', '預計付款日',
    '申請人', '申請部門',
    '費用所屬人', '費用所屬人部門',
    '受款人', '付款方式',
    '傳票編號', '傳票日期',
    '是否有紙本憑證', '理由',
  ]);
});

check('表頭值：人員／部門取顯示名稱、多個用逗號、日期去掉時間、核取方塊串接', () => {
  const v = Object.fromEntries(B.buildHeaderRows(mainRecord()).flatMap((r) => [[r.l1, r.v1], [r.l2, r.v2]]));
  assert.strictEqual(v['交通費請款單號'], '15');
  assert.strictEqual(v['請款日期'], '2026-10-05');
  assert.strictEqual(v['公司名稱'], 'ＮＸ臺灣國際物流');
  assert.strictEqual(v['預計付款日'], '2026-10-20');
  assert.strictEqual(v['申請人'], '王小明');
  assert.strictEqual(v['申請部門'], '總務部');
  assert.strictEqual(v['費用所屬人'], '陳大文');
  assert.strictEqual(v['費用所屬人部門'], '業務一部, 業務二部');
  assert.strictEqual(v['受款人'], '24145 陳大文');
  assert.strictEqual(v['付款方式'], '現金, 電匯');
  assert.strictEqual(v['傳票日期'], '2026-10-06');
  assert.strictEqual(v['是否有紙本憑證'], '是');
  assert.strictEqual(v['理由'], '拜訪客戶\n搭計程車');
});

check('表頭：欄位全空也不會出錯、值都是空字串', () => {
  const rows = B.buildHeaderRows({});
  rows.forEach((r) => {
    assert.strictEqual(r.v1, '');
    assert.strictEqual(r.v2, '');
  });
});

check('表頭沒有類型、借支、供應商代號、統一編號、支付條件、備註、分攤等 723 標籤', () => {
  const labels = B.buildHeaderRows(mainRecord()).flatMap((r) => [r.l1, r.l2]);
  ['類型', '借支', '供應商代號', '統一編號', '支付條件', '請購備註', '驗貨備註', '其他備註', '員工姓名'].forEach((l) => assert.ok(!labels.includes(l), l));
});

// ── 檔名 ───────────────────────────────────────────────────────────────────

check('檔名：交通費請款單{ID}_{NX|聯海}({受款人}).pdf；ＮＸ 開頭算 NX，其餘聯海', () => {
  assert.strictEqual(B.generatePDFFileName({ [F.COMPANY_NAME]: { value: 'ＮＸ臺灣國際物流' }, [F.PAYEE]: { value: '24145 陳大文' } }, 15), '交通費請款單15_NX(24145 陳大文).pdf');
  assert.strictEqual(B.generatePDFFileName({ [F.COMPANY_NAME]: { value: '聯海通運' }, [F.PAYEE]: { value: '24145 陳大文' } }, 16), '交通費請款單16_聯海(24145 陳大文).pdf');
});

check('檔名：受款人夾 Tab／換行與 Windows 不允許的字元會被換掉', () => {
  const name = B.generatePDFFileName({ [F.COMPANY_NAME]: { value: '聯海通運' }, [F.PAYEE]: { value: '24145\t陳:大/文\n' } }, 1);
  assert.strictEqual(name, '交通費請款單1_聯海(24145 陳_大_文).pdf');
});

// ── 原始碼 ─────────────────────────────────────────────────────────────────

check('原始碼沒有類型、借支、供應商、分攤表（ALLOC_*）、其他子表格的殘留', () => {
  [
    'F.TYPE', 'F.EMPLOYEE_NAME', 'F.APPLY_UNIT', 'F.ADVANCE', 'F.SUPPLIER_CODE', 'F.TAX_ID', 'F.PAYMENT_TERMS', 'F.PURCHASE_NOTE', 'F.INSPECTION_NOTE', 'F.OTHER_NOTE',
    'F.EXPENSE_FILL_MODE', 'VENDOR_TABLE', 'TRIP_TABLE', 'ENTERTAINMENT_TABLE', 'ADVANCE_DETAIL_TABLE', 'ALLOC_', 'NXSdaApi', '分攤', 'getTableDataByType', 'PURCHASE_BUTTON',
  ].forEach((s) => assert.ok(!pdfSrc.includes(s), s));
});

check('事件：列表頁與詳細頁各一個', () => {
  const all = registered.flatMap((r) => (Array.isArray(r.types) ? r.types : [r.types]));
  assert.deepStrictEqual(all.sort(), ['app.record.detail.show', 'app.record.index.show']);
});

console.log(`${passed} assertions passed.`);
