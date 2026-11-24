import { openUserPicker, findMissingAccounts, createAccount, createErrorText, escapeHtml, CREATE_NOTE } from './受款人填寫設定.js';
import { openSaving } from './存檔等待提示.js';

// 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
const KT = window.PR_KT;

// =============================================================================
// 公司卡支付／受款人明細（2026-11-16，從請款單的「交際費付款來源」搬來）
//   主表「是否為公司卡支付」（唯一選項 是）→ 勾了才顯示「公司卡支付方式」（全額支付／部分支付，只能選一個）：
//     全額支付 → 主表受款人自動填 TEXT.FULL_PAYEE，受款人明細不用填（清成一列空白列）
//     部分支付 → 主表受款人自動填 TEXT.PARTIAL_PAYEE，顯示「受款人明細」逐列填付款來源／受款人／金額
//   和請款單交際費不同：交通費請款單只有一張單、沒有單號，明細金額合計要等於整張單的總金額
//   （總金額＝交通費明細的金額＋手續費合計，和 FIELDS.TOTAL_AMOUNT 的計算式相同；存檔時自己算，不等計算欄位更新）。
//   存檔檢查（部分支付）：每列付款來源、受款人（員工代墊必填且要「5 碼員工編號＋中文姓名」）必填、金額 > 0；
//     明細合計＝總金額；至少一列公司信用卡、一列員工代墊；員工代墊只能有一位受款人。
//   員工代墊列改付款來源、或受款人打的不是合格格式 → 開員工選人視窗（共用 受款人填寫設定 的 PR_PAYEE.openUserPicker）。
//   欄位代碼見 C.CARD_PAY；749 表單還沒建這幾個欄位（record 裡沒有）時整支程式不動作。
//   錯誤訊息交給 PR_SAVE_ERRORS，和 payment_request_submit 的檢查同一個視窗顯示（所以載入順序排在 submit 前面）。
//   kintone 子表格寫入限制：每一列都要含表格全部欄位，而且至少要有一列；「清空」＝換成一列空白列。
// =============================================================================

const C = window.PR_CONFIG;
const F = C.FIELDS;
const P = C.CARD_PAY;
const TABLE = P.TABLE.CODE;
const COLS = P.TABLE.COLS;
const SOURCE = P.OPTIONS.SOURCE;
const MODE = P.OPTIONS.MODE;
const TRAFFIC = F.TRAFFIC_TABLE;
const AUTO_PAYEE_TEXTS = [P.TEXT.PARTIAL_PAYEE, P.TEXT.FULL_PAYEE]; // 主表受款人自動填的字樣（不是真的受款人）

// 表格全部欄位與型別（寫回時每列都要含這些）
const COL_TYPES = Object.freeze({
  [COLS.PAY_SOURCE]: 'DROP_DOWN',
  [COLS.PAYEE]: 'SINGLE_LINE_TEXT',
  [COLS.AMOUNT]: 'NUMBER',
});

// ── 純函式 ──────────────────────────────────────────────────────────────

const text = (value) => String(value ?? '').trim();

/** 金額加千分位（整數元） */
const formatAmount = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 欄位值轉整數元；空值、非數字當 0 */
const toAmount = (value) => {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const cellOf = (row, code) => row?.value?.[code]?.value;
const rowsOf = (record, code) => (Array.isArray(record?.[code]?.value) ? record[code].value : []);

/** 員工受款人格式：5 碼數字＋中文姓名（中間可有可無空白；姓名至少 2 個中文字，允許中間點） */
const EMPLOYEE_PAYEE_PATTERN = /^(\d{5})\s*([一-鿿]+(?:[·‧][一-鿿]+)*)$/;
const isValidEmployeePayee = (value) => {
  const m = EMPLOYEE_PAYEE_PATTERN.exec(text(value));
  return !!m && m[2].replace(/[·‧]/g, '').length >= 2;
};

/** 空白列：每個欄位都沒有值 */
const isBlankRow = (row) => Object.keys(COL_TYPES).every((code) => text(cellOf(row, code)) === '');

/** 明細表沒有實際資料：每一列的受款人與金額都是空的（自動帶入的判斷用） */
const hasNoData = (record) => rowsOf(record, TABLE).every((row) => text(cellOf(row, COLS.PAYEE)) === '' && text(cellOf(row, COLS.AMOUNT)) === '');

/** 選項欄位目前的值（核取方塊是陣列；單選／下拉是字串，轉成一個元素的陣列） */
const checkedOf = (record, code) => {
  const v = record?.[code]?.value;
  if (Array.isArray(v)) return v;
  return text(v) === '' ? [] : [v];
};

/** 表單上有沒有這組欄位（749 還沒建欄位時整支不動作） */
const isInstalled = (record) => !!record?.[P.FLAG];

/** 有勾「是否為公司卡支付」 */
const isCardPay = (record) => checkedOf(record, P.FLAG).includes(P.OPTIONS.FLAG.YES);

/** none（沒勾公司卡、支付方式沒選或兩個都勾）／full 全額／partial 部分（還要明細表存在） */
const modeOf = (record) => {
  if (!isCardPay(record)) return 'none';
  const picked = checkedOf(record, P.MODE);
  const full = picked.includes(MODE.FULL);
  const partial = picked.includes(MODE.PARTIAL);
  if (full && !partial) return 'full';
  if (partial && !full && Array.isArray(record?.[TABLE]?.value)) return 'partial';
  return 'none';
};

const isPartial = (record) => modeOf(record) === 'partial';

/** 整張單的總金額：交通費明細 金額＋手續費 合計（與 FIELDS.TOTAL_AMOUNT 的計算式相同）；沒有明細表就讀總金額欄位 */
const totalOf = (record) => {
  const rows = record?.[TRAFFIC.CODE]?.value;
  if (!Array.isArray(rows)) return toAmount(record?.[F.TOTAL_AMOUNT]?.value);
  return rows.reduce((sum, row) => sum + toAmount(cellOf(row, TRAFFIC.COLS.AMOUNT)) + toAmount(cellOf(row, TRAFFIC.COLS.FEE)), 0);
};

/** 部分支付時，明細中某付款來源的金額合計（負數當 0） */
const detailTotalBySource = (record, source) =>
  rowsOf(record, TABLE)
    .filter((row) => cellOf(row, COLS.PAY_SOURCE) === source)
    .reduce((sum, row) => sum + Math.max(0, toAmount(cellOf(row, COLS.AMOUNT))), 0);

/**
 * 部分支付的存檔檢查：回傳錯誤訊息陣列（空陣列＝通過）。不是部分支付回傳空陣列。
 * 完全空白的列忽略。
 */
const validatePayeeDetail = (record) => {
  if (!isPartial(record)) return [];
  const errors = [];
  let detailTotal = 0;
  rowsOf(record, TABLE).forEach((row, index) => {
    if (isBlankRow(row)) return;
    const label = `${TABLE}第 ${index + 1} 行`;
    const source = cellOf(row, COLS.PAY_SOURCE);
    const amount = toAmount(cellOf(row, COLS.AMOUNT));
    detailTotal += amount;
    if (text(source) === '') errors.push(`${label}：付款來源必填`);
    // 受款人：員工代墊必填且要「5 碼員工編號＋中文姓名」；公司信用卡不限定寫法，可留白
    if (source !== SOURCE.CARD) {
      if (text(cellOf(row, COLS.PAYEE)) === '') errors.push(`${label}：受款人必填`);
      else if (source === SOURCE.EMPLOYEE && !isValidEmployeePayee(cellOf(row, COLS.PAYEE))) {
        errors.push(`${label}：員工受款人請填「5 碼員工編號＋中文姓名」，例：12345 王小明`);
      }
    }
    if (!(amount > 0)) errors.push(`${label}：金額必須大於 0`);
  });
  const total = totalOf(record);
  if (detailTotal !== total) {
    errors.push(`「${TABLE}」金額合計 ${formatAmount(detailTotal)} 元，與「${F.TOTAL_AMOUNT}」${formatAmount(total)} 元不符`);
  }
  // 員工代墊只能有一位受款人（同一人可分好幾列；員工編號相同就算同一人）
  const employeeKeys = new Map();
  rowsOf(record, TABLE).forEach((row) => {
    if (isBlankRow(row) || cellOf(row, COLS.PAY_SOURCE) !== SOURCE.EMPLOYEE) return;
    const written = text(cellOf(row, COLS.PAYEE));
    if (written === '') return;
    const m = EMPLOYEE_PAYEE_PATTERN.exec(written);
    const key = m ? m[1] : written;
    if (!employeeKeys.has(key)) employeeKeys.set(key, written);
  });
  if (employeeKeys.size > 1) {
    errors.push(
      ['依規定，員工代墊只能有一位受款人', `目前填了 ${employeeKeys.size} 位：${[...employeeKeys.values()].join('、')}`, '請修改受款人明細，只保留一位員工代墊'].join('\n'),
    );
  }
  // 部分支付：公司信用卡與員工代墊都要有
  if (detailTotalBySource(record, SOURCE.CARD) <= 0) errors.push(`部分支付時，「${TABLE}」至少要有一列${SOURCE.CARD}`);
  else if (detailTotalBySource(record, SOURCE.EMPLOYEE) <= 0) {
    // 全部是信用卡但受款人（卡片）寫得不一樣 → 可能是拆到不同張公司卡，不擋；都相同才請改選全額支付
    const cardPayees = new Set(
      rowsOf(record, TABLE)
        .filter((row) => !isBlankRow(row) && cellOf(row, COLS.PAY_SOURCE) === SOURCE.CARD)
        .map((row) => text(cellOf(row, COLS.PAYEE))),
    );
    if (cardPayees.size <= 1) errors.push(`「${TABLE}」全部都是同一張公司信用卡，請將「${P.MODE}」改選「${MODE.FULL}」`);
  }
  return errors;
};

/** 「公司卡支付方式」沒選或兩個都勾的錯誤；沒勾公司卡、或剛好選一個回傳空字串 */
const validateMode = (record) => {
  if (!isCardPay(record)) return '';
  const picked = checkedOf(record, P.MODE).filter((v) => v === MODE.FULL || v === MODE.PARTIAL);
  return new Set(picked).size === 1 ? '' : `勾選「${P.FLAG}」時，請在「${P.MODE}」選擇${MODE.FULL}或${MODE.PARTIAL}（只能選一個）`;
};

// ── 子表格寫入（每列要含全部欄位）──────────────────────────────────────────

/** 一列：含表格全部欄位，值由 values 指定、沒給的欄位是空字串 */
const makeRow = (values = {}) => {
  const row = { value: {} };
  Object.keys(COL_TYPES).forEach((code) => {
    row.value[code] = { type: COL_TYPES[code], value: values[code] ?? '' };
  });
  return row;
};

/** 補齊既有列缺少的欄位（就地修改） */
const ensureColumns = (row) => {
  if (!row.value) row.value = {};
  Object.keys(COL_TYPES).forEach((code) => {
    if (!row.value[code]) row.value[code] = { type: COL_TYPES[code], value: '' };
  });
  return row;
};

const setTableRows = (record, rows) => {
  const field = record[TABLE];
  field.type = field.type || 'SUBTABLE';
  field.value = rows;
};

/** 明細表重設成一列空白列（已經是單一空白列就不動） */
const resetToBlankRow = (record) => {
  if (!Array.isArray(record?.[TABLE]?.value)) return;
  const rows = rowsOf(record, TABLE);
  if (rows.length === 1 && isBlankRow(rows[0])) return;
  setTableRows(record, [makeRow()]);
};

/** 主表受款人（自動填的字樣不是真的受款人，帶入明細時當空白） */
const mainPayeeForRows = (record) => {
  const v = String(record?.[F.PAYEE]?.value ?? '');
  return AUTO_PAYEE_TEXTS.includes(v) ? '' : v;
};

/** 切到部分支付、明細還沒資料：先帶一列員工代墊（主表受款人、整張單的總金額），使用者再拆出公司信用卡的部分 */
const autoFillRows = (record) => {
  const total = totalOf(record);
  return [makeRow({ [COLS.PAY_SOURCE]: SOURCE.EMPLOYEE, [COLS.PAYEE]: mainPayeeForRows(record), [COLS.AMOUNT]: total > 0 ? String(total) : '' })];
};

/**
 * 主表受款人跟著模式：部分 → TEXT.PARTIAL_PAYEE；全額 → TEXT.FULL_PAYEE；
 * 其他 → 只在值剛好是自動字樣時清空（使用者自己填的不動）。
 */
const syncMainPayee = (record, mode) => {
  const field = record?.[F.PAYEE];
  if (!field) return;
  const auto = { partial: P.TEXT.PARTIAL_PAYEE, full: P.TEXT.FULL_PAYEE }[mode];
  if (auto) {
    if (field.value !== auto) field.value = auto;
  } else if (AUTO_PAYEE_TEXTS.includes(field.value)) {
    field.value = '';
  }
};

/**
 * 員工代墊列的受款人鎖住（只能用選人視窗填）；其他來源的列解開。就地修改，回傳 record。
 * 寫回畫面要經由 event 回傳或 record.set 才生效。
 */
const lockEmployeePayees = (record) => {
  rowsOf(record, TABLE).forEach((row) => {
    const payee = row?.value?.[COLS.PAYEE];
    if (payee) payee.disabled = cellOf(row, COLS.PAY_SOURCE) === SOURCE.EMPLOYEE;
  });
  return record;
};

/** 清空選項欄位（核取方塊清成空陣列；單選／下拉不能清，留給存檔檢查） */
const clearChoice = (record, code) => {
  if (Array.isArray(record?.[code]?.value)) record[code].value = [];
};

// ── 畫面 ─────────────────────────────────────────────────────────────────

const setShown = (record, code, shown) => {
  if (!record?.[code]) return;
  try {
    KT.record().setFieldShown(code, shown);
  } catch (err) {
    console.error(`[公司卡付款來源] 設定欄位顯示失敗（${code}）:`, err);
  }
};

// 「公司卡支付方式」上一次的勾選值：兩個選項只能選一個，同時勾兩個時靠它判斷哪個是新勾的
let lastModes = [];

/** 支付方式同時勾兩個：保留這次新勾的；判斷不出來（例如開舊單）就保留最後一個 */
const enforceSingleMode = (record) => {
  const picked = checkedOf(record, P.MODE);
  if (picked.length > 1 && Array.isArray(record[P.MODE].value)) {
    const fresh = picked.filter((v) => !lastModes.includes(v));
    record[P.MODE].value = [(fresh.length > 0 ? fresh : picked).slice(-1)[0]];
  }
  lastModes = [...checkedOf(record, P.MODE)];
};

/**
 * 顯示與重設；editable＝新增／編輯（可以改值），詳細頁只顯示／隱藏。
 * 勾公司卡才顯示支付方式；部分支付才顯示明細表（可編輯時沒資料就自動帶一列）；
 * 可編輯時：沒勾公司卡就清空支付方式；不是部分支付就把明細表清成一列空白列；主表受款人跟著模式。
 */
const applyFieldState = (record, editable) => {
  if (!isInstalled(record)) return;
  if (editable) enforceSingleMode(record);
  const cardOn = isCardPay(record);
  if (editable && !cardOn) clearChoice(record, P.MODE);
  const partial = isPartial(record);
  setShown(record, P.FLAG, true);
  setShown(record, P.MODE, cardOn);
  setShown(record, TABLE, partial);
  if (!editable) return;
  if (partial) {
    if (hasNoData(record)) setTableRows(record, autoFillRows(record));
    rowsOf(record, TABLE).forEach(ensureColumns);
  } else {
    resetToBlankRow(record);
  }
  lockEmployeePayees(record);
  syncMainPayee(record, modeOf(record));
  lastModes = [...checkedOf(record, P.MODE)];
};

const makeHandler = (editable) => (event) => {
  try {
    applyFieldState(event.record, editable);
  } catch (err) {
    console.error('[公司卡付款來源] 更新欄位狀態失敗:', err);
  }
  return event;
};

// ── 員工代墊列的選人視窗 ───────────────────────────────────────────────────

/**
 * 這次 change 要不要開選人視窗：部分支付、變動的是員工代墊列；
 * 改付款來源 → 一定開；改受款人 → 寫的不是合格格式才開（例如只打了「王」，用打的字當關鍵字）。
 * @returns {{ index: number, keyword: string } | null}
 */
const pickerRequest = (event, changedField) => {
  const record = event?.record;
  if (!record || !isPartial(record)) return null;
  const row = event.changes?.row;
  if (!row || row.value?.[COLS.PAY_SOURCE]?.value !== SOURCE.EMPLOYEE) return null;
  const rows = rowsOf(record, TABLE);
  let index = rows.indexOf(row);
  if (index < 0 && row.id != null) index = rows.findIndex((r) => r.id === row.id);
  if (index < 0) return null;
  const raw = text(row.value?.[COLS.PAYEE]?.value);
  const written = raw === P.TEXT.CARD_PAYEE ? '' : raw; // 從公司信用卡改回員工代墊：殘留字樣不當關鍵字
  if (changedField === COLS.PAYEE && (written === '' || isValidEmployeePayee(written))) return null;
  const keyword = changedField === COLS.PAYEE || !isValidEmployeePayee(written) ? written : written.slice(0, 5);
  return { index, keyword };
};

/** 選到的受款人寫回第 index 列（那一列還是員工代墊才寫） */
const writePayee = (index, payee) => {
  const current = KT.record().get();
  const row = current.record?.[TABLE]?.value?.[index];
  if (!row || row.value?.[COLS.PAY_SOURCE]?.value !== SOURCE.EMPLOYEE) return;
  row.value[COLS.PAYEE].value = payee;
  lockEmployeePayees(current.record); // set 會照 record 裡的 disabled 重畫，員工代墊列維持鎖住
  KT.record().set(current);
};

const openPicker = ({ index, keyword }) =>
  openUserPicker({ title: `選擇員工代墊受款人（第 ${index + 1} 行）`, keyword, onPick: (payee) => writePayee(index, payee) });

/**
 * 付款來源選公司信用卡 → 同一列受款人直接寫入同選項的字（TEXT.CARD_PAYEE）；
 * 改成其他來源且受款人還是這個字樣 → 清空（不用手動刪掉再選人）。改動 event.changes.row 後回傳 event 即生效
 */
const fillCardPayee = (event) => {
  const row = event?.changes?.row;
  const payee = row?.value?.[COLS.PAYEE];
  if (!payee) return event;
  if (row.value[COLS.PAY_SOURCE]?.value === SOURCE.CARD) payee.value = P.TEXT.CARD_PAYEE;
  else if (text(payee.value) === P.TEXT.CARD_PAYEE) payee.value = '';
  payee.disabled = row.value[COLS.PAY_SOURCE]?.value === SOURCE.EMPLOYEE; // 員工代墊只能用選人視窗填
  return event;
};

// ── 存檔 ─────────────────────────────────────────────────────────────────

/** 存檔檢查與整理：回傳錯誤訊息（空陣列＝通過）；會直接改 record（清明細、主表受款人） */
const checkOnSubmit = (record) => {
  if (!isInstalled(record)) return [];
  if (record?.[C.VOID_FIELD]?.value?.length > 0) return [];
  if (!isCardPay(record)) {
    clearChoice(record, P.MODE);
    resetToBlankRow(record);
    syncMainPayee(record, 'none');
    return [];
  }
  const modeError = validateMode(record);
  if (modeError) return [modeError];
  if (modeOf(record) === 'full') {
    resetToBlankRow(record);
    syncMainPayee(record, 'full');
    return [];
  }
  syncMainPayee(record, modeOf(record));
  return validatePayeeDetail(record);
};

// ── 存檔：受款人要已建立匯款帳號（員工匯款帳號主檔，2026-11-23）─────────────────
//   要查的受款人：
//     不是公司卡支付 → 主表受款人（要有 5 碼員工編號開頭）；
//     公司卡全額支付 → 主表受款人是自動字樣（不是員工），不查；
//     公司卡部分支付 → 受款人明細的員工代墊列（格式不對的列由 validatePayeeDetail 報，這裡略過）。
//   取前 5 碼和主檔員工編號比對，查不到＝尚未建立匯款帳號。

/**
 * 要查匯款帳號的受款人 [{ label, payee, code, rowIndex }]：rowIndex＝受款人明細第幾列（主表受款人是 -1）；
 * 主表受款人沒有 5 碼開頭時 code 是空字串（另報格式錯誤）
 */
const payeesToCheck = (record) => {
  const mode = isInstalled(record) ? modeOf(record) : 'none';
  if (mode === 'full') return [];
  const codeOf = (payee) => (/^(\d{5})/.exec(payee) || [])[1] || '';
  if (mode === 'partial') {
    return rowsOf(record, TABLE)
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !isBlankRow(row) && cellOf(row, COLS.PAY_SOURCE) === SOURCE.EMPLOYEE && isValidEmployeePayee(cellOf(row, COLS.PAYEE)))
      .map(({ row, index }) => {
        const payee = text(cellOf(row, COLS.PAYEE));
        return { label: `${TABLE}第 ${index + 1} 行受款人`, payee, code: codeOf(payee), rowIndex: index };
      });
  }
  const payee = text(record?.[F.PAYEE]?.value);
  if (payee === '' || AUTO_PAYEE_TEXTS.includes(payee)) return [];
  return [{ label: F.PAYEE, payee, code: codeOf(payee), rowIndex: -1 }];
};

const missingMessage = (t) => `「${t.label}」${t.payee} 尚未建立匯款帳號：請在選人視窗按「＋ 新增員工帳號」建立後再存檔`;

/**
 * 找出格式不對的受款人與查不到匯款帳號的受款人。作廢的單不查。
 * @param {Function} [find] 查不到的編號（預設 受款人填寫設定 的 findMissingAccounts），測試時注入
 * @returns {Promise<{ errors: string[], missing: Array<{ label, payee, code, name, rowIndexes }> }>}
 *   missing 同編號只留一筆，rowIndexes 是用到這個編號的所有位置（寫回用）
 */
const findPayeeProblems = async (record, find = findMissingAccounts) => {
  if (record?.[C.VOID_FIELD]?.value?.length > 0) return { errors: [], missing: [] };
  const targets = payeesToCheck(record);
  const errors = targets.filter((t) => t.code === '').map((t) => `「${t.label}」請用「選擇員工」選擇（要有 5 碼員工編號），目前是「${t.payee}」`);
  const withCode = targets.filter((t) => t.code !== '');
  if (withCode.length === 0) return { errors, missing: [] };
  const notFound = new Set(await find(withCode.map((t) => t.code)));
  const byCode = new Map();
  withCode
    .filter((t) => notFound.has(t.code))
    .forEach((t) => {
      if (!byCode.has(t.code)) byCode.set(t.code, { label: t.label, payee: t.payee, code: t.code, name: text(t.payee.slice(5)), rowIndexes: [] });
      byCode.get(t.code).rowIndexes.push(t.rowIndex);
    });
  return { errors, missing: [...byCode.values()] };
};

/** 受款人匯款帳號檢查：回傳錯誤訊息陣列（空陣列＝通過）；查不到的也當錯誤（不跳確認視窗） */
const checkPayeeAccounts = async (record, find = findMissingAccounts) => {
  const { errors, missing } = await findPayeeProblems(record, find);
  return [...errors, ...missing.map(missingMessage)];
};

/** 存檔時的確認視窗內容：每位一組可修改的員工編號／中文姓名（data-index 對應 missing 的位置） */
const buildConfirmHtml = (missing) =>
  '<p class="pr-emp-msg">以下受款人尚未建立匯款帳號，請確認員工編號與姓名，確認後會新增並繼續儲存：</p>' +
  missing
    .map(
      (t, i) =>
        '<div class="pr-emp-create-form">' +
        `<p class="pr-emp-msg">${escapeHtml(t.label)}</p>` +
        `<label class="pr-emp-field">員工編號（5 碼）<input type="text" class="pr-emp-new-code" data-index="${i}" inputmode="numeric" maxlength="5" value="${escapeHtml(t.code)}"></label>` +
        `<label class="pr-emp-field">中文姓名<input type="text" class="pr-emp-new-name" data-index="${i}" value="${escapeHtml(t.name)}"></label>` +
        '</div>',
    )
    .join('') +
  `<p class="pr-emp-create-note">${CREATE_NOTE}</p>`;

/** 讀確認視窗裡第 i 組的值（找不到輸入框就用原本的值） */
const readConfirmInputs = (popup, missing) =>
  missing.map((t, i) => ({
    code: text(popup?.querySelector?.(`.pr-emp-new-code[data-index="${i}"]`)?.value ?? t.code),
    name: text(popup?.querySelector?.(`.pr-emp-new-name[data-index="${i}"]`)?.value ?? t.name),
  }));

/** 確認視窗的值檢查：編號 5 碼數字、姓名是中文（至少 2 個字）、不同組不能同編號；回傳錯誤訊息（沒問題回空字串） */
const validateConfirmInputs = (values, missing) => {
  for (let i = 0; i < values.length; i += 1) {
    const { code, name } = values[i];
    const label = missing[i].label;
    if (!/^\d{5}$/.test(code)) return `${label}：員工編號請輸入 5 碼數字`;
    if (!isValidEmployeePayee(`${code} ${name}`)) return `${label}：中文姓名請填中文（至少 2 個字）`;
    if (values.findIndex((v) => v.code === code) !== i) return `${label}：員工編號 ${code} 重複`;
  }
  return '';
};

/**
 * 跳確認視窗（編號／姓名已帶入、可修改），使用者按「新增匯款帳號並儲存」就逐筆新增
 * （改成主檔已有的編號就不新增，直接用）。
 * 回傳每組最後的 [{ code, name }]（和 missing 同順序）；取消或沒有 SweetAlert 回 null。
 * 新增失敗時視窗不關、顯示原因（已新增的下次不再新增）。
 * @param {{ create?: Function, find?: Function }} [deps] 測試時注入
 */
const confirmCreateAccounts = async (missing, deps = {}) => {
  const { create = createAccount, find = findMissingAccounts } = deps;
  if (typeof Swal === 'undefined' || typeof Swal.fire !== 'function') return null;
  const done = new Set();
  const result = await Swal.fire({
    icon: 'warning',
    title: '受款人尚未建立匯款帳號',
    html: buildConfirmHtml(missing),
    showCancelButton: true,
    confirmButtonText: '新增匯款帳號並儲存',
    cancelButtonText: '取消',
    allowOutsideClick: false,
    showLoaderOnConfirm: true,
    customClass: { popup: 'pr-emp-picker' },
    preConfirm: async () => {
      const values = readConfirmInputs(Swal.getPopup?.(), missing);
      const invalid = validateConfirmInputs(values, missing);
      if (invalid) {
        Swal.showValidationMessage(invalid);
        return false;
      }
      let stillMissing;
      try {
        stillMissing = new Set(await find(values.map((v) => v.code).filter((c) => !done.has(c))));
      } catch (err) {
        console.error('[公司卡付款來源] 存檔時查詢員工帳號失敗:', err);
        Swal.showValidationMessage('查詢員工帳號失敗，請稍後再試');
        return false;
      }
      for (const v of values) {
        if (done.has(v.code) || !stillMissing.has(v.code)) continue; // 已新增過、或主檔本來就有
        try {
          await create(v);
          done.add(v.code);
        } catch (err) {
          console.error('[公司卡付款來源] 存檔時新增員工帳號失敗:', err);
          Swal.showValidationMessage(`${v.code} ${v.name}：${createErrorText(err)}`);
          return false;
        }
      }
      return values;
    },
  });
  return result?.isConfirmed && Array.isArray(result.value) ? result.value : null;
};

/** 確認視窗最後的值寫回原本的欄位（主表受款人或受款人明細那幾列的受款人），寫成「編號 姓名」 */
const writeBackPayees = (record, missing, values) => {
  missing.forEach((t, i) => {
    const payee = `${values[i].code} ${values[i].name}`;
    t.rowIndexes.forEach((index) => {
      const field = index < 0 ? record?.[F.PAYEE] : record?.[TABLE]?.value?.[index]?.value?.[COLS.PAYEE];
      if (field) field.value = payee;
    });
  });
};

/**
 * 存檔時的匯款帳號處理：格式錯誤直接擋；查不到的在沒有其他錯誤時跳確認視窗（可修改），
 * 新增後把值寫回原本的欄位、繼續儲存；取消（或已有其他錯誤）就擋下。回傳要加進 PR_SAVE_ERRORS 的訊息。
 */
const handlePayeeAccountsOnSubmit = async (record, hasOtherErrors, deps = {}) => {
  const { find = findMissingAccounts, confirm = confirmCreateAccounts, reopen = openSaving } = deps;
  const { errors, missing } = await findPayeeProblems(record, find);
  if (missing.length === 0) return errors;
  if (errors.length > 0 || hasOtherErrors) return [...errors, ...missing.map(missingMessage)];
  const values = await confirm(missing);
  if (!values) return missing.map(missingMessage);
  writeBackPayees(record, missing, values);
  reopen(); // 確認視窗蓋掉了「儲存中」提示，繼續儲存前再開回來
  return [];
};

export { isValidEmployeePayee, modeOf, totalOf, validatePayeeDetail, validateMode, applyFieldState, pickerRequest, checkOnSubmit, payeesToCheck, findPayeeProblems, checkPayeeAccounts, buildConfirmHtml, validateConfirmInputs, confirmCreateAccounts, writeBackPayees, handlePayeeAccountsOnSubmit, lockEmployeePayees, formatAmount };

/** 入口檔 import '…?install' 時呼叫：註冊事件（載入時只定義函式） */
export const install = () => {
  KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
    lastModes = [];
    return makeHandler(true)(event);
  });
  KT.on('app.record.detail.show', makeHandler(false));
  KT.on(
    ['create', 'edit'].flatMap((mode) => [P.FLAG, P.MODE].map((code) => `app.record.${mode}.change.${code}`)),
    makeHandler(true),
  );

  [COLS.PAY_SOURCE, COLS.PAYEE].forEach((code) => {
    KT.on(['create', 'edit'].map((mode) => `app.record.${mode}.change.${code}`), (event) => {
      try {
        const req = pickerRequest(event, code);
        if (req) setTimeout(() => openPicker(req), 0); // 等 kintone 套用完這次變更再開視窗
      } catch (err) {
        console.error('[公司卡付款來源] 判斷是否開啟選人視窗失敗:', err);
      }
      return event;
    });
  });
  KT.on(['create', 'edit'].map((mode) => `app.record.${mode}.change.${COLS.PAY_SOURCE}`), fillCardPayee);
  // 加列／刪列後重新套員工代墊列的鎖定（加列複製來的員工代墊列也要鎖）
  KT.on(['create', 'edit'].map((mode) => `app.record.${mode}.change.${TABLE}`), (event) => {
    lockEmployeePayees(event.record);
    return event;
  });

  // 錯誤交給 PR_SAVE_ERRORS，由 payment_request_submit 在同一個視窗顯示（本檔排在它前面）
  KT.on(['app.record.create.submit', 'app.record.edit.submit'], async (event) => {
    let hasOtherErrors;
    try {
      const errors = checkOnSubmit(event.record);
      hasOtherErrors = errors.length > 0;
      if (hasOtherErrors) window.PR_SAVE_ERRORS.add(errors);
    } catch (err) {
      console.error('[公司卡付款來源] 存檔檢查失敗:', err);
      hasOtherErrors = true;
      window.PR_SAVE_ERRORS.add(['公司卡支付檢查失敗：請稍後再試或聯絡系統管理員']);
    }
    // 受款人匯款帳號：在 checkOnSubmit 整理完主表受款人之後查；查不到 → 確認視窗新增後繼續儲存
    //   （kintone 會等這個 Promise，再跑 payment_request_submit）
    try {
      const errors = await handlePayeeAccountsOnSubmit(event.record, hasOtherErrors);
      if (errors.length > 0) window.PR_SAVE_ERRORS.add(errors);
    } catch (err) {
      console.error('[公司卡付款來源] 受款人匯款帳號檢查失敗:', err);
      window.PR_SAVE_ERRORS.add(['受款人匯款帳號檢查失敗：請稍後再試或聯絡系統管理員']);
    }
    return event;
  });
};
