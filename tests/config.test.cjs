'use strict';

// 回歸測試：payment_request_config.js（window.PR_CONFIG，交通費請款單）
// 直接用 Node 執行，不引入任何測試框架：node tests/config.test.cjs
// 驗證結構與不變式：欄位代碼不重複、狀態值與欄位代碼語意分開、自動推進三字串、已刪的鍵不存在，
// 以及 main／submit 沒有把已註冊的欄位代碼再寫死一次。

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(rootDir, 'payment_request_config.js'), 'utf8');

const loadConfig = (appId, loginCode = 'x') => {
  global.window = {};
  global.kintone = { app: { getId: () => appId }, getLoginUser: () => ({ code: loginCode }) };
  // eslint-disable-next-line no-eval
  eval(src);
  return global.window.PR_CONFIG;
};

const c = loadConfig(749);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const isDeepFrozen = (obj) =>
  Object.isFrozen(obj) && Object.values(obj).every((v) => (v !== null && typeof v === 'object' ? isDeepFrozen(v) : true));

console.log('config.test.cjs');

// ── 整體結構 ────────────────────────────────────────────────────────────────
check('PR_CONFIG 的頂層鍵恰為這 21 個（多了或少了都要有意識地改這裡）', () => {
  assert.deepStrictEqual(
    Object.keys(c).sort(),
    ['ACCOUNTING', 'ACTIONS', 'ADMIN_USERS', 'APPS', 'AUTO_ADVANCE', 'COST_SCOPE', 'DIRECTOR_BY_COST_CENTER', 'EXPECTED_PAY_DATE', 'FIELDS', 'INLINE_EDIT', 'MANUAL_SIGNERS', 'OPTIONS', 'REF_FIELDS', 'SEP', 'SPACES', 'STATUS', 'SUPER_ADMIN', 'TRAFFIC_RULES', 'TRAFFIC_TABLE_LAYOUT', 'VOID_FIELD', 'isAdmin'].sort(),
  );
});

check('PR_CONFIG 與各註冊表皆為凍結物件（不會被其他模組意外改寫）', () => {
  assert.ok(Object.isFrozen(c));
  ['APPS', 'ACCOUNTING', 'EXPECTED_PAY_DATE', 'REF_FIELDS', 'ADMIN_USERS', 'SPACES', 'FIELDS', 'TRAFFIC_TABLE_LAYOUT', 'INLINE_EDIT', 'STATUS', 'ACTIONS', 'AUTO_ADVANCE', 'OPTIONS', 'TRAFFIC_RULES', 'COST_SCOPE', 'DIRECTOR_BY_COST_CENTER', 'MANUAL_SIGNERS'].forEach((key) => {
    assert.ok(isDeepFrozen(c[key]), `${key} 應為深層凍結`);
  });
});

check('已刪除的 723 設定鍵全部不存在（頂層）', () => {
  [
    'TYPE', 'TYPES', 'GROUP', 'TRANSFER_TYPES', 'COMPANY_TYPES', 'AUTO_CHAIN_TYPES', 'PURCHASE_ONLY_TYPES', 'SHIP_ONLY_TYPES',
    'AMOUNT_CONSISTENCY_TYPES', 'INVOICE_CHECK_TYPES', 'ENT_SIGN', 'SLOT3_RELOCATION', 'ENT_PICK_ANY_APPLICANT', 'APPLICANT_SWITCH',
    'COST_CENTER_SCOPE', 'PAYEE_EDITABLE_TYPES', 'SOURCE_FIELDS', 'ENT_NOTE_LEGEND', 'TAX', 'ATTACHMENT_TEXT', 'isTransfer', 'isCompany',
    'detailPathOf', 'fetchOriginalData', 'applyTableLabels', 'ENTERTAINMENT_APP_BY_PAYMENT',
  ].forEach((key) => assert.ok(!(key in c), `不應存在 ${key}`));
});

// ── 子表格版面（MCP 快照）───────────────────────────────────────────────────
check('TRAFFIC_TABLE_LAYOUT.COLUMNS 和 MCP 讀出的 749 表單快照一致（順序、代碼、標籤、型別、單位），且涵蓋子表格全部欄位', () => {
  const snap = JSON.parse(fs.readFileSync(path.join(rootDir, 'form_snapshots', '749_rev1798_traffic_table.json'), 'utf8'));
  assert.strictEqual(snap.subtable, c.FIELDS.TRAFFIC_TABLE.CODE);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.TRAFFIC_TABLE_LAYOUT.COLUMNS)), snap.columns);
  assert.deepStrictEqual(c.TRAFFIC_TABLE_LAYOUT.COLUMNS.map((col) => col.code).sort(), Object.values(c.FIELDS.TRAFFIC_TABLE.COLS).sort());
  const w = c.TRAFFIC_TABLE_LAYOUT.WIDTH;
  assert.ok(w.MIN_PX > 0 && w.MIN_PX < w.MAX_PX);
});

// ── 列表直接編輯 ────────────────────────────────────────────────────────────
check('INLINE_EDIT.EDITABLE：列表上只留傳票編號、傳票日期、表單作廢（其餘程式管的欄位一律鎖）', () => {
  assert.deepStrictEqual([...c.INLINE_EDIT.EDITABLE], [c.FIELDS.VOUCHER_NO, c.FIELDS.VOUCHER_DATE, c.VOID_FIELD]);
  const programOwned = [c.FIELDS.APPLICANT, c.FIELDS.APPLICANT_ORG, c.FIELDS.EXPENSE_OWNER, c.FIELDS.EXPENSE_OWNER_ORG, c.FIELDS.PAYEE,
    c.FIELDS.COMPANY_NAME, c.FIELDS.ACCOUNTING_UNIT, c.FIELDS.ACCOUNTING_STAFF, c.FIELDS.PERMISSION_STAFF, c.FIELDS.MANUAL_FLOW,
    c.FIELDS.EXPECTED_PAY_DATE, c.FIELDS.INVOICE_AGG, c.FIELDS.PAY_METHOD, c.FIELDS.PAPER_RECEIPT, c.FIELDS.REASON, c.FIELDS.PAYMENT_DATE];
  programOwned.forEach((code) => assert.ok(!c.INLINE_EDIT.EDITABLE.includes(code), `${code} 有程式邏輯，不能在列表直接改`));
});

// ── APPS ────────────────────────────────────────────────────────────────────
check('APPS 共 8 個鍵，已刪的請購／庶務／出差／交際費／供應商／分攤 App 全不在', () => {
  assert.deepStrictEqual(
    Object.keys(c.APPS).sort(),
    ['ACCOUNTING_MAP', 'APPROVAL_FLOW', 'COST_CENTER', 'HOLIDAY_CALENDAR', 'PAYMENT', 'PDF_FONT', 'PERMISSION', 'SAP_MAPPING'],
  );
  ['PURCHASE', 'PURCHASE_LH', 'MAINTENANCE', 'BUSINESS_TRIP', 'ENTERTAINMENT', 'SUPPLIER_DB', 'ALLOC_TEMPLATE', 'ALLOC_CONFIG', 'ALLOC_FAVORITE', 'ALLOC_STORE'].forEach((key) => {
    assert.ok(!(key in c.APPS), `APPS 不應有 ${key}`);
  });
});

check('APPS 各值正確；PAYMENT 用 kintone.app.getId() 動態取得（換 App 就跟著換）', () => {
  assert.strictEqual(c.APPS.PAYMENT, 749);
  assert.strictEqual(loadConfig(631).APPS.PAYMENT, 631);
  assert.strictEqual(c.APPS.COST_CENTER, 661);
  assert.strictEqual(c.APPS.ACCOUNTING_MAP, 433);
  assert.strictEqual(c.APPS.APPROVAL_FLOW, 139);
  assert.strictEqual(c.APPS.SAP_MAPPING, 623);
  assert.strictEqual(c.APPS.PDF_FONT, 488);
  assert.strictEqual(c.APPS.PERMISSION, 673);
  assert.strictEqual(c.APPS.HOLIDAY_CALENDAR, 620);
  loadConfig(749);
});

// ── 其他共用常數 ────────────────────────────────────────────────────────────
check("SEP === ' / '、VOID_FIELD === '表單作廢'", () => {
  assert.strictEqual(c.SEP, ' / ');
  assert.strictEqual(c.VOID_FIELD, '表單作廢');
});

check('ADMIN_USERS 為四人白名單；SUPER_ADMIN 比白名單更窄、刻意分開', () => {
  assert.deepStrictEqual([...c.ADMIN_USERS], ['24136', '24136T', '24145', '24145T']);
  assert.strictEqual(c.SUPER_ADMIN, '24136');
});

check('isAdmin：指定代碼／預設取目前登入者', () => {
  assert.strictEqual(c.isAdmin('24145T'), true);
  assert.strictEqual(c.isAdmin('someone'), false);
  assert.strictEqual(loadConfig(749, '24136').isAdmin(), true);
  assert.strictEqual(loadConfig(749, 'nobody').isAdmin(), false);
  loadConfig(749);
});

check('SPACES 空白欄位 ID 正確（說明文字三格、受款人按鈕、預計付款日說明、設定簽核人按鈕；沒有已刪的使用須知／受款人統計）', () => {
  assert.deepStrictEqual(
    { ...c.SPACES },
    {
      NOTI_1: 'Space_Noti_1',
      NOTI_2: 'Space_Noti_2',
      NOTI_3: 'Space_Noti_3',
      APPLY_BUTTON: 'apply_button',
      EXPECTED_PAY_DATE_NOTE: 'Space_Expected_Pay_Date',
      MANUAL_SIGNERS: 'Space_Manual_Signers',
    },
  );
});

// ── FIELDS 註冊表 ───────────────────────────────────────────────────────────
const F = c.FIELDS;
const mainCodes = Object.values(F).filter((v) => typeof v === 'string');
const tables = Object.values(F).filter((v) => v && typeof v === 'object');

check('FIELDS 主表欄位代碼正確', () => {
  assert.deepStrictEqual(
    { ...Object.fromEntries(Object.entries(F).filter(([, v]) => typeof v === 'string')) },
    {
      APPLICANT: '申請人',
      APPLICANT_ORG: '申請人部門',
      EXPENSE_OWNER: '費用所屬人',
      EXPENSE_OWNER_ORG: '費用所屬人部門',
      PAYMENT_DATE: '請款日期',
      PAY_METHOD: '付款方式',
      PAYEE: '受款人',
      COMPANY_NAME: '公司名稱',
      ACCOUNTING_UNIT: '會計單位',
      ACCOUNTING_STAFF: '會計單位承辦人',
      INVOICE_AGG: '發票號碼記錄',
      VOUCHER_NO: '傳票編號',
      VOUCHER_DATE: '傳票日期',
      ATTACHMENT: '附件',
      PAPER_RECEIPT: '是否有紙本憑證',
      REASON: '理由',
      RECORD_NO: '交通費請款單號',
      DEV_ONLY_DATA: '帶入的資料_開發人員用',
      SIGN_FLOW_GROUP: '簽核流程',
      MANUAL_FLOW: '手動設定簽核流程',
      PERMISSION_STAFF: '權限開放人員',
      EXPECTED_PAY_DATE: '預計付款日',
      STATUS_FIELD: '狀態',
    },
  );
});

check('FIELDS 子表格：交通費請款單 12 欄、簽核記錄 3 欄，欄位代碼正確', () => {
  assert.strictEqual(F.TRAFFIC_TABLE.CODE, '交通費請款單');
  assert.deepStrictEqual(
    { ...F.TRAFFIC_TABLE.COLS },
    {
      DATE: '憑證日期',
      VEHICLE: '交通工具',
      VISIT_CUSTOMER: '拜訪客戶',
      ROUTE: '起訖點',
      AMOUNT: '金額',
      EXPENSE: '費用歸屬',
      NOTE: '備註',
      RECEIPT_TYPE: '憑證種類',
      INVOICE_NO: '發票號碼',
      SELLER_TAX_ID: '賣方統編',
      FORMAT: '格式',
      TAX: '稅額',
    },
  );
  assert.strictEqual(F.SIGN_TABLE.CODE, '簽核記錄');
  assert.deepStrictEqual({ ...F.SIGN_TABLE.COLS }, { DATETIME: '日期與時間', ACTION: '動作', SIGNER: '簽核人員' });
});

check('FIELDS 所有欄位代碼（主表＋子表格本身＋子表格欄位）互不重複——kintone 欄位代碼全 App 唯一', () => {
  const all = [...mainCodes, ...tables.map((t) => t.CODE), ...tables.flatMap((t) => Object.values(t.COLS))];
  const dup = all.filter((code, i) => all.indexOf(code) !== i);
  assert.deepStrictEqual(dup, [], `重複的欄位代碼：${dup.join('、')}`);
  assert.strictEqual(new Set(all).size, all.length);
});

check('FIELDS 的每個邏輯鍵名也不重複（Object.freeze 不會擋同名鍵，檢查原始碼）', () => {
  const block = src.slice(src.indexOf('const FIELDS = Object.freeze({'), src.indexOf('// ── 流程狀態字串註冊表'));
  const keys = [...block.matchAll(/^ {4}([A-Z_]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 23);
  assert.deepStrictEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});

check('FIELDS 不含已刪的 723 欄位：類型、申請單位、員工姓名、借支、分攤填寫方式、供應商／交際費／出差表格、更改金額、各種註記、總金額…', () => {
  [
    'TYPE', 'APPLY_UNIT', 'EMPLOYEE_NAME', 'ADVANCE', 'EXPENSE_FILL_MODE', 'VENDOR_TABLE', 'ENTERTAINMENT_TABLE', 'TRIP_TABLE',
    'ADVANCE_DETAIL_TABLE', 'RECEIPT_ORIGINAL', 'AMOUNT_CHANGE', 'PURCHASE_NOTE', 'INSPECTION_NOTE', 'OTHER_NOTE', 'ENT_TOTAL',
    'ALLOC_GROUP', 'SOURCE_NO', 'TAX_ID', 'PAYMENT_TERMS', 'SUPPLIER_CODE', 'VENDOR_NAME', 'GA_DIRECTOR', 'PRESIDENT', 'TRIP_INFO',
    'CROSS_DEPT_SIGN', 'CROSS_DEPT_DIRECTOR', 'OVERAGE_SIGN',
  ].forEach((key) => assert.ok(!(key in F), `FIELDS 不應有 ${key}`));
  assert.ok(!Object.keys(F).some((k) => k.startsWith('CROSS_DEPT_')));
});

check('刻意不收「表單作廢」進 FIELDS：欄位代碼的單一事實來源是 VOID_FIELD', () => {
  assert.ok(!Object.values(F).includes(c.VOID_FIELD));
  assert.ok(!('VOID_FLAG' in F) && !('VOID' in F));
});

check('費用所屬人與申請人是兩組獨立欄位（簽核、會計單位、公司名稱依費用所屬人部門）', () => {
  assert.notStrictEqual(F.EXPENSE_OWNER, F.APPLICANT);
  assert.notStrictEqual(F.EXPENSE_OWNER_ORG, F.APPLICANT_ORG);
});

// ── STATUS／ACTIONS／AUTO_ADVANCE ───────────────────────────────────────────
check("STATUS 只剩三個流程狀態值；STATUS.VOID 與 VOID_FIELD 字串相同但語意分開（狀態值 vs 欄位代碼）", () => {
  assert.deepStrictEqual({ ...c.STATUS }, { VOID: '表單作廢', REIMBURSEMENT_FILL: '報銷人填單', APPLY_START: '草稿（未送出）' });
  assert.strictEqual(c.STATUS.VOID, c.VOID_FIELD);
  assert.notStrictEqual(F.STATUS_FIELD, c.STATUS.VOID, '「狀態」是欄位代碼，不是狀態值');
  ['ACCOUNTING', 'UNIT_ACCOUNTING', 'IN_PROGRESS', 'DONE', 'FLOW_DONE'].forEach((key) => assert.ok(!(key in c.STATUS), `STATUS 不應有 ${key}`));
});

check('ACTIONS 是「動作名稱」，與同義的 STATUS「狀態值」不可混用', () => {
  assert.deepStrictEqual({ ...c.ACTIONS }, { VOID: '作廢', APPLY_START: '點擊流程開始' });
  assert.notStrictEqual(c.ACTIONS.VOID, c.STATUS.VOID);
  assert.notStrictEqual(c.ACTIONS.APPLY_START, c.STATUS.APPLY_START);
});

check('AUTO_ADVANCE 的三個字串（前狀態、後狀態、動作名稱）都接註冊表，且前後狀態不同', () => {
  const a = c.AUTO_ADVANCE;
  assert.strictEqual(a.FROM_STATUS, c.STATUS.REIMBURSEMENT_FILL);
  assert.strictEqual(a.TO_STATUS, c.STATUS.APPLY_START);
  assert.strictEqual(a.ACTION_NAME, c.ACTIONS.APPLY_START);
  assert.strictEqual(a.FROM_STATUS, '報銷人填單');
  assert.strictEqual(a.TO_STATUS, '草稿（未送出）');
  assert.strictEqual(a.ACTION_NAME, '點擊流程開始');
  assert.notStrictEqual(a.FROM_STATUS, a.TO_STATUS);
  assert.notStrictEqual(a.ACTION_NAME, a.TO_STATUS, '動作名稱不是目標狀態名稱');
});

check('AUTO_ADVANCE 行為開關與重試參數為合理值', () => {
  const a = c.AUTO_ADVANCE;
  assert.strictEqual(a.ENABLED, true);
  assert.strictEqual(a.SEND_ASSIGNEE, true);
  assert.strictEqual(a.COMPENSATE_ON_DETAIL, true);
  assert.ok(Number.isInteger(a.CREATE_MAX_RETRIES) && a.CREATE_MAX_RETRIES >= 1);
  assert.ok(Number.isInteger(a.COMPENSATE_MAX_RETRIES) && a.COMPENSATE_MAX_RETRIES >= 1);
  assert.ok(a.TIMEOUT_MS >= 1000 && a.TIMEOUT_MS <= 60000);
  assert.ok(typeof a.GUARD_PREFIX === 'string' && a.GUARD_PREFIX.length > 0);
});

// ── OPTIONS ─────────────────────────────────────────────────────────────────
check('OPTIONS：手動簽核流程、交通工具（7 種）、憑證種類（5 種，與 749 rev1819 下拉選項一致）、紙本憑證「是」；723 選項已刪', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.OPTIONS)), {
    MANUAL_FLOW: { ON: '手動設定簽核流程' },
    VEHICLE: { HSR: '高鐵', MRT_BUS: '捷運／公車', PARKING: '停車費', TRAIN: '火車', TAXI: '計程車', UBER: 'Uber', RENTAL: '汽機車短租' },
    RECEIPT_TYPE: { HSR_TICKET: '高鐵票', TICKET: '車票（高鐵外）', INVOICE: '發票', RECEIPT: '收據', NONE: '無' },
    PAPER_RECEIPT: { YES: '是' },
  });
  assert.strictEqual(c.OPTIONS.MANUAL_FLOW.ON, F.MANUAL_FLOW, '勾選值與欄位代碼同字串但是兩回事，各自一個常數');
});

// ── TRAFFIC_RULES／COST_SCOPE ───────────────────────────────────────────────
check('TRAFFIC_RULES：高鐵賣方統編 00000000、格式 22、稅率 5%、高鐵票與發票才填發票號碼', () => {
  const t = c.TRAFFIC_RULES;
  assert.strictEqual(t.HSR_SELLER_TAX_ID, '00000000');
  assert.strictEqual(t.HSR_FORMAT, '22');
  assert.strictEqual(t.TAX_RATE_PERCENT, 5);
  assert.deepStrictEqual([...t.INVOICE_RECEIPT_TYPES], [c.OPTIONS.RECEIPT_TYPE.HSR_TICKET, c.OPTIONS.RECEIPT_TYPE.INVOICE]);
  assert.deepStrictEqual([...t.TAX_RECEIPT_TYPES], [c.OPTIONS.RECEIPT_TYPE.HSR_TICKET, c.OPTIONS.RECEIPT_TYPE.INVOICE], '高鐵票與發票才算稅額');
});

check('DIRECTOR_BY_COST_CENTER：部長的單位部長依費用歸屬帶入，只在填單／草稿／駁回時重算', () => {
  const d = c.DIRECTOR_BY_COST_CENTER;
  assert.deepStrictEqual([...d.EDITABLE_STATUSES], [c.STATUS.REIMBURSEMENT_FILL, c.STATUS.APPLY_START]);
  assert.strictEqual(d.REJECT_SUFFIX, '駁回');
  assert.strictEqual(d.TARGET_FIELD, '單位部長_支店長');
});

check('MANUAL_SIGNERS：手動簽核人三格依序、人數欄位、可改簽核人的狀態與 749 的欄位代碼一致', () => {
  const m = c.MANUAL_SIGNERS;
  assert.deepStrictEqual([...m.FIELDS], ['手動簽核人1', '手動簽核人2', '手動簽核人3']);
  assert.strictEqual(m.COUNT_FIELD, '手動簽核人數');
  assert.strictEqual(m.ACCOUNTING_FIELD, '手動會計承辦人');
  assert.notStrictEqual(m.ACCOUNTING_FIELD, c.FIELDS.ACCOUNTING_STAFF, '不和原本自動帶入的會計單位承辦人共用');
  assert.strictEqual(m.COUNT_UNIT, '人');
  assert.deepStrictEqual([...m.EDITABLE_STATUSES], [c.STATUS.REIMBURSEMENT_FILL, c.STATUS.APPLY_START]);
  assert.strictEqual(m.REJECT_SUFFIX, '駁回');
  assert.ok(m.USER_PAGE_SIZE <= 100, '/v1/users.json 一次最多 100 筆');
});

check('TRAFFIC_RULES.RECEIPT_BY_VEHICLE：每種交通工具都有設定，值都是有效的憑證種類；高鐵只能高鐵票、高鐵票只給高鐵', () => {
  const map = JSON.parse(JSON.stringify(c.TRAFFIC_RULES.RECEIPT_BY_VEHICLE));
  const R = c.OPTIONS.RECEIPT_TYPE;
  assert.deepStrictEqual(Object.keys(map).sort(), Object.values(c.OPTIONS.VEHICLE).sort());
  Object.values(map).forEach((list) => list.forEach((v) => assert.ok(Object.values(R).includes(v), v)));
  assert.deepStrictEqual(map[c.OPTIONS.VEHICLE.HSR], [R.HSR_TICKET]);
  Object.entries(map).filter(([k]) => k !== c.OPTIONS.VEHICLE.HSR).forEach(([k, list]) => assert.ok(!list.includes(R.HSR_TICKET), k));
  assert.ok(!map[c.OPTIONS.VEHICLE.TAXI].includes(R.TICKET), '計程車不能選車票');
});

check('COST_SCOPE：排除群組「費用歸屬不限部門」、組織樹快取設定', () => {
  assert.strictEqual(c.COST_SCOPE.EXEMPT_GROUP, '費用歸屬不限部門');
  assert.ok(c.COST_SCOPE.ORG_TREE.PAGE_SIZE <= 100);
  assert.ok(c.COST_SCOPE.ORG_TREE.MAX_DEPTH > 0 && c.COST_SCOPE.ORG_TREE.CACHE_TTL_MS > 0);
});

// ── ACCOUNTING ─────────────────────────────────────────────────────
check('ACCOUNTING 只剩 MAP 六個會計群組；依費用歸屬據點判斷的機場／海運特殊代碼已刪（會計單位只依費用所屬人部門）', () => {
  assert.deepStrictEqual({ ...c.ACCOUNTING.MAP }, { TPE: 'ACC_TPE', TPE海運: 'ACC_TPE海運', CKS: 'ACC_CKS', KHH: 'ACC_KHH', TEPZ: 'ACC_TEPZ', NEXT: 'ACC_NEXT' });
  assert.deepStrictEqual(Object.keys(c.ACCOUNTING), ['MAP']);
});

check('SIGNING（「所／中心 → 部」補前綴對應）已刪：簽核流程主檔改用組織欄位「簽核所屬單位」查，不再拼名稱', () => {
  assert.strictEqual(c.SIGNING, undefined);
});

// ── REF_FIELDS／EXPECTED_PAY_DATE ───────────────────────────────────────────
check('REF_FIELDS 有簽核流程、費用歸屬、會計對應、行事曆四份；費用歸屬主檔有代碼／中文名稱／使用狀況／所屬部門四個欄位（據點不再讀）', () => {
  assert.deepStrictEqual(Object.keys(c.REF_FIELDS).sort(), ['ACCOUNTING_MAP', 'APPROVAL_FLOW', 'COST_CENTER', 'HOLIDAY_CALENDAR']);
  assert.deepStrictEqual({ ...c.REF_FIELDS.APPROVAL_FLOW }, { FLOW_NAME: '簽核流程名稱', ORG: '簽核所屬單位', IN_USE: '使用狀況', IN_USE_VALUE: '使用中' });
  assert.deepStrictEqual({ ...c.REF_FIELDS.COST_CENTER }, { CODE: 'CostCenter', NAME: '中文名稱', IN_USE: '使用狀況', DEPT: '所屬部門', DIRECTOR_GROUP: '部門部長' });
  assert.deepStrictEqual(
    { ...c.REF_FIELDS.ACCOUNTING_MAP },
    { APPLY_UNIT: '申請單位', ACCOUNTING_UNIT: '請款會計單位', ACCOUNTING_STAFF: '請款會計人員', PERMISSION_USER: '權限開放人員' },
  );
  assert.deepStrictEqual({ ...c.REF_FIELDS.HOLIDAY_CALENDAR }, { DATE: 'date', IS_HOLIDAY: 'isHoliday', HOLIDAY_VALUE: '是', WORKDAY_VALUE: '否' });
});

check('EXPECTED_PAY_DATE：5 個工作日、每月 10／20 日（另加月底）、查行事曆 60 天', () => {
  const e = c.EXPECTED_PAY_DATE;
  assert.strictEqual(e.LEAD_WORKDAYS, 5);
  assert.deepStrictEqual([...e.PAY_DAYS], [10, 20]);
  assert.strictEqual(e.LOOKAHEAD_DAYS, 60);
  assert.ok(e.NOTE.includes('10、20、月底'));
});

// ── 沒有人把已註冊的欄位代碼再寫死一次 ──────────────────────────────────────
check('main／submit 沒有把 FIELDS 已註冊的欄位代碼再寫死成字面值', () => {
  const allCodes = [...mainCodes, ...tables.map((t) => t.CODE), ...tables.flatMap((t) => Object.values(t.COLS))];
  ['payment_request_main_20260521.js', 'payment_request_submit_20260506.js'].forEach((file) => {
    const text = fs.readFileSync(path.join(rootDir, file), 'utf8');
    // 去掉註解再看，只檢查可執行程式碼
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    allCodes.forEach((fieldCode) => {
      [`'${fieldCode}'`, `"${fieldCode}"`].forEach((literal) => {
        assert.ok(!code.includes(literal), `${file} 不應寫死欄位代碼 ${literal}，請改用 F.*`);
      });
    });
  });
});

check('main／submit 沒有引用已刪的 config 鍵', () => {
  const removed = ['C.TYPE', 'C.TYPES', 'TRANSFER_TYPES', 'COMPANY_TYPES', 'ENT_SIGN', 'SLOT3_RELOCATION', 'APPLICANT_SWITCH', 'COST_CENTER_SCOPE', 'PAYEE_EDITABLE_TYPES', 'SOURCE_FIELDS', 'C.TAX', 'ATTACHMENT_TEXT', 'OPT.', 'SPECIAL_CODES', 'LOCATION', 'determineAllocation'];
  ['payment_request_main_20260521.js', 'payment_request_submit_20260506.js'].forEach((file) => {
    const text = fs.readFileSync(path.join(rootDir, file), 'utf8');
    removed.forEach((key) => assert.ok(!text.includes(key), `${file} 不應引用 ${key}`));
  });
});

console.log(`\n${passed} assertions passed.`);
