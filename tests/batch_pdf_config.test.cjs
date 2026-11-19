'use strict';

// 測試：檔案批次.js
//   PDF 明細表格設定只認交通費子表格、欄位都在 F.TRAFFIC_TABLE.COLS 內；
//   PDF 表頭是 749 主表欄位（沒有類型、借支、供應商、分攤等）；數字欄位名單；檔名；原始碼沒有 723 其他類型殘留。
// 單獨執行：node tests/batch_pdf_config.test.cjs

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const pdfFile = '檔案批次.js';
const readSrc = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8');
const pdfSrc = readSrc(pdfFile);

const registered = [];
// 假 PDFLib：只記錄附件被怎麼接上（每個 PDF 附件有 2 頁）
const pdfLoads = [];
global.window = {
  location: { origin: 'https://example.cybozu.com' },
  PDFLib: {
    rgb: () => ({}),
    PDFDocument: {
      load: async (bytes) => {
        if (bytes.bad) throw new Error('壞檔');
        pdfLoads.push(bytes);
        return { getPageIndices: () => [0, 1], tag: bytes.tag };
      },
    },
  },
};
global.location = global.window.location;
const spaces = {};
global.kintone = {
  app: { getId: () => 749, record: { getSpaceElement: (id) => spaces[id] || null, getHeaderMenuSpaceElement: () => spaces.__header || null } },
  api: { url: (p) => p },
  getLoginUser: () => ({ code: 'x' }),
  events: { on: (types, handler) => registered.push({ types, handler }) },
};
// 假下載：fileKey 就是內容標記；'bad' 讓 PDF 解析失敗
global.fetch = async (url) => {
  const key = url.split('fileKey=')[1];
  return { ok: true, blob: async () => ({ size: 10, arrayBuffer: async () => ({ tag: key, bad: key === 'bad' }) }) };
};
const fakeEl = (tag) => {
  const el = { tagName: tag, children: [], appendChild: (c) => el.children.push(c), addEventListener: () => {} };
  return el;
};
global.document = { getElementById: () => null, createElement: fakeEl };

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
    ['憑證日期', '交通工具', '拜訪客戶', '起訖點', '金額', '手續費', '費用歸屬', '憑證種類', '發票號碼', '賣方統編', '格式', '稅額'],
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
  assert.ok(!('備註' in data.rows[0]), '備註欄已從 749 移除');
  assert.strictEqual(data.rows[1]['金額'], '50');
});

check('getTableData：只認交通費子表格，別的子表格或沒有明細 → null', () => {
  assert.strictEqual(B.getTableData({ 其他子表格: { value: [trafficRow()] } }), null);
  assert.strictEqual(B.getTableData({ [T.CODE]: { value: [] } }), null);
  assert.strictEqual(B.getTableData({}), null);
});

check('數字欄位名單（靠右＋千分位）＝金額、手續費、稅額，且都是明細欄位', () => {
  assert.deepStrictEqual([...B.NUMERIC_COLUMNS], ['金額', '手續費', '稅額']);
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

// ── 詳細頁按鈕位置 ─────────────────────────────────────────────────────────

const detailHandler = registered.find((r) => [].concat(r.types).includes('app.record.detail.show')).handler;
const detailEvent = { type: 'app.record.detail.show', record: { $id: { value: '7' } } };

check('詳細頁 PDF 按鈕放在空白欄位 SPACES.PDF_BUTTON（Purchase_button）', () => {
  assert.strictEqual(C.SPACES.PDF_BUTTON, 'Purchase_button');
  spaces[C.SPACES.PDF_BUTTON] = fakeEl('div');
  spaces.__header = fakeEl('div');
  detailHandler(detailEvent);
  assert.strictEqual(spaces[C.SPACES.PDF_BUTTON].children.length, 1);
  assert.strictEqual(spaces[C.SPACES.PDF_BUTTON].children[0].id, 'detail-print-pdflib-btn');
  assert.strictEqual(spaces.__header.children.length, 0, '不再放表頭');
});

check('表單上沒有那格空白欄位 → 退回放表頭', () => {
  delete spaces[C.SPACES.PDF_BUTTON];
  spaces.__header = fakeEl('div');
  detailHandler(detailEvent);
  assert.strictEqual(spaces.__header.children.length, 1);
});

// ── 附件接在 PDF 後面 ──────────────────────────────────────────────────────

check('attachmentKind：PDF／JPG／PNG 依 contentType 或副檔名判斷，其他不支援', () => {
  assert.strictEqual(B.attachmentKind({ name: 'a.PDF', contentType: '' }), 'pdf');
  assert.strictEqual(B.attachmentKind({ name: 'a', contentType: 'application/pdf' }), 'pdf');
  assert.strictEqual(B.attachmentKind({ name: 'a.jpeg' }), 'jpg');
  assert.strictEqual(B.attachmentKind({ name: 'a.jpg', contentType: 'image/jpeg' }), 'jpg');
  assert.strictEqual(B.attachmentKind({ name: 'a.png' }), 'png');
  assert.strictEqual(B.attachmentKind({ name: 'a.xlsx', contentType: 'application/vnd.ms-excel' }), null);
  assert.strictEqual(B.attachmentKind({ name: 'a.heic', contentType: 'image/heic' }), null);
  assert.strictEqual(B.attachmentKind(null), null);
});

const fakeDoc = () => {
  const doc = {
    pages: [],
    copyPages: async (src, idx) => idx.map((i) => ({ from: src.tag, i })),
    addPage: (p) => {
      const page = Array.isArray(p) ? { size: p, images: [], drawImage: (img, o) => page.images.push({ img, o }) } : p;
      doc.pages.push(page);
      return page;
    },
    embedJpg: async (b) => ({ kind: 'jpg', tag: b.tag, width: 4000, height: 3000 }),
    embedPng: async (b) => ({ kind: 'png', tag: b.tag, width: 100, height: 200 }),
  };
  return doc;
};

(async () => {
  const origError = console.error;
  console.error = () => {};
  const doc = fakeDoc();
  const record = {
    [F.ATTACHMENT]: {
      value: [
        { name: '發票.pdf', contentType: 'application/pdf', fileKey: 'p1' },
        { name: '收據.jpg', contentType: 'image/jpeg', fileKey: 'j1' },
        { name: '表.xlsx', contentType: 'application/vnd.ms-excel', fileKey: 'x1' },
        { name: '壞.pdf', contentType: 'application/pdf', fileKey: 'bad' },
        { name: '截圖.png', contentType: 'image/png', fileKey: 'g1' },
      ],
    },
  };
  const skipped = await B.appendAttachments(doc, record);
  console.error = origError;

  check('appendAttachments：依附件順序接上——PDF 全部頁、圖片一張一頁', () => {
    assert.deepStrictEqual(
      doc.pages.map((p) => p.from || p.images[0].img.tag),
      ['p1', 'p1', 'j1', 'g1'],
    );
  });

  check('appendAttachments：不支援的格式與讀取失敗的檔案回傳檔名、不中斷', () => {
    assert.deepStrictEqual(skipped, ['表.xlsx', '壞.pdf']);
  });

  check('圖片頁：橫的圖用 A4 橫式、直的圖用 A4 直式，縮到邊界內（小圖不放大）並置中', () => {
    const [jpgPage, pngPage] = doc.pages.slice(2);
    assert.deepStrictEqual(jpgPage.size, [841.89, 595.28]);
    const o = jpgPage.images[0].o;
    assert.ok(o.width <= 841.89 - 48 + 1e-6 && o.height <= 595.28 - 48 + 1e-6);
    assert.ok(Math.abs(o.x * 2 + o.width - 841.89) < 1e-6);
    assert.deepStrictEqual(pngPage.size, [595.28, 841.89]);
    assert.strictEqual(pngPage.images[0].o.width, 100);
    assert.strictEqual(pngPage.images[0].o.height, 200);
  });

  const emptyDoc = fakeDoc();
  const emptySkipped = await B.appendAttachments(emptyDoc, {});
  check('沒有附件 → 什麼都不接', () => {
    assert.deepStrictEqual(emptySkipped, []);
    assert.strictEqual(emptyDoc.pages.length, 0);
  });

  check('批次列印合成一份 PDF（不再打包 ZIP）：每筆直接畫進同一份文件，不先存檔再讀回來合併', () => {
    assert.ok(pdfSrc.includes('drawRecordInto(merged, font, record, recordId)'));
    assert.ok(!pdfSrc.includes('merged.copyPages'), '不再 save → load → copyPages');
    assert.ok(!pdfSrc.includes('zip.file(fileName, pdfBlob)'));
    assert.ok(!/fetchRecord\(appId, recordId\)/.test(pdfSrc.slice(pdfSrc.indexOf('async function performBatchPrintPDF'), pdfSrc.indexOf('const generatePDFFileName'))),'批次列印不再一筆一筆查');
  });

  // ── 批次查詢：$id in (...) 每 100 筆一次 ──
  const realApi = global.kintone.api;
  const apiCalls = [];
  global.kintone.api = Object.assign(
    async (url, method, params) => {
      apiCalls.push({ url, method, params });
      const ids = params.query.match(/\(([^)]*)\)/)[1].split(',').map(Number);
      // 假裝 7 號找不到（已刪除／沒權限）
      return { records: ids.filter((id) => id !== 7).map((id) => ({ $id: { value: String(id) } })) };
    },
    { url: (p) => p },
  );
  const ids = Array.from({ length: 250 }, (_, i) => i + 1);
  const byId = await B.fetchRecordsByIds(749, ids, ['$id']);
  global.kintone.api = realApi;
  check('fetchRecordsByIds：$id in (...) 每 100 筆查一次、帶 fields；回傳 Map(id → record)，找不到的不在裡面', () => {
    assert.strictEqual(apiCalls.length, 3);
    assert.ok(apiCalls.every((c) => c.url === '/k/v1/records' && c.method === 'GET'));
    assert.strictEqual(apiCalls[0].params.query, `$id in (${ids.slice(0, 100).join(',')}) limit 100`);
    assert.strictEqual(apiCalls[2].params.query, `$id in (${ids.slice(200).join(',')}) limit 100`);
    assert.deepStrictEqual(apiCalls[0].params.fields, ['$id']);
    assert.strictEqual(byId.size, 249);
    assert.strictEqual(byId.has(7), false);
    assert.strictEqual(byId.get(250).$id.value, '250');
  });

  check('批次下載：附件合計有上限，開始前先算、下載中再擋一次', () => {
    assert.ok(B.LIMITS.maxZipBytes > 0);
    const rec = (...sizes) => ({ [F.ATTACHMENT]: { value: sizes.map((size) => ({ size: String(size) })) } });
    assert.strictEqual(B.attachmentBytes([rec(100, 200), rec(), {}, rec(5)]), 305);
    const dl = pdfSrc.slice(pdfSrc.indexOf('async function handleSecureBatchDownload'));
    assert.ok(/attachmentBytes\(records\)[\s\S]*totalBytes > LIMITS\.maxZipBytes[\s\S]*askConfirm/.test(dl), '超過上限在確認前就擋');
    assert.ok(/zippedBytes > LIMITS\.maxZipBytes/.test(dl), '實際下載量也擋');
    assert.ok(/fetchRecordsByIds\(currentAppId, recordIds/.test(dl));
  });

  check('檔名只換掉不合法的路徑字元：& \' 保留；/ \\ : * ? " < > | 與控制字元換成 _', () => {
    assert.strictEqual(B.safeFileName("A&B's 收據.pdf"), "A&B's 收據.pdf");
    assert.strictEqual(B.safeFileName('a/b\\c:d*e?f"g<h>i|j\tk.pdf'), 'a_b_c_d_e_f_g_h_i_j_k.pdf');
    assert.strictEqual(B.safeFileName(null), '');
  });

  check('沒有作用的「安全」機制已移除（__token 參數、網域要含 cybozu/kintone、sanitizeInput、假的安全報告）', () => {
    ['__token', "includes('cybozu')", 'sanitizeInput', 'validateSecurity', 'generateSecurityToken', 'secureKintoneApi', '安全 Token', 'CSRF'].forEach((s) =>
      assert.ok(!pdfSrc.includes(s), s),
    );
  });

  check('處理結果的顏色用 class（pr-result--error／warning／success），不寫 style.color', () => {
    assert.ok(!pdfSrc.includes('style.color'));
    assert.ok(!pdfSrc.includes('style.display'), '範圍／指定號碼切換也用 class（pr-mode-specific）');
    assert.ok(pdfSrc.includes("rangeGroup.classList.toggle('pr-mode-specific'"));
    const css = readSrc('payment_request.css');
    ['error', 'warning', 'success'].forEach((t) => assert.ok(css.includes(`.result-message.pr-result--${t} {`), t));
  });

  check('事件一律走 PR_KT.on（不直接呼叫 kintone.events.on）', () => {
    assert.ok(!/kintone\.events\.on\(/.test(pdfSrc));
    assert.ok(pdfSrc.includes("window.PR_KT.on('app.record.index.show'"));
  });

  console.log(`${passed} assertions passed.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
