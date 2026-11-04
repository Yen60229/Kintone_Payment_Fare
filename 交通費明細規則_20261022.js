(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 交通費明細規則（子表格「交通費請款單」與「是否有紙本憑證」「理由」）
  //
  //   規則來源：APPS.TRAFFIC_RULE_MASTER（交通費明細規則主檔），開畫面時讀一次；
  //   讀不到、逾時或資料不合法 → 退回 config 的 TRAFFIC_RULES（行為和主檔初始記錄一樣）。
  //   下面說的「高鐵」「計程車」等都是主檔現在的設定，程式只看主檔的欄位與旗標，不看名稱。
  //
  //   1. 交通工具有「固定賣方統編」（現在是高鐵）→ 賣方統編、格式寫主檔的固定值，並鎖住；
  //      改選別的交通工具（變更事件）→ 若賣方統編還是某個交通工具的固定值，賣方統編、格式一起清空並解鎖
  //   2. 某一列的金額、憑證種類、交通工具變更或新增列 → 只重算「那一列」的稅額：憑證種類有「要算稅」旗標（現在是高鐵票／發票）
  //      → 金額 ÷ 1.05 × 0.05 四捨五入到個位數（金額含稅），其他種類寫 0；開畫面、存檔、改別列都不動稅額（會計手改的保留）。稅額不鎖
  //   3. 憑證種類有「開放發票號碼」旗標（現在是高鐵票／發票）→ 開放發票號碼；其他種類鎖住並清空。存檔時必填、表單內不可重複，
  //      並重算「發票號碼記錄」（跨單重複由 payment_request_submit 查記錄欄位，不用迴圈讀表格）
  //   4. 有任何一列的交通工具有「需紙本憑證」旗標（現在是計程車）→ 是否有紙本憑證自動選「是」；
  //      有「理由必填」旗標 → 理由動態必填（標籤加紅色 *）
  //   5. 交通工具限制憑證種類（主檔的「可選憑證種類」）：變更事件清掉不能用的組合、只有一種就自動帶入；
  //      存檔時擋下不能用的組合；桌面版下拉選單只列出可選的項目
  //   6. 憑證種類＝無（config 的 NO_RECEIPT_TYPES）→ 賣方統編、格式、稅額清空並鎖住；
  //      create/edit 的 show、上面的變更事件、存檔前 normalize 都套用（detail.show 唯讀不處理）。
  //      改回別的種類 → 解鎖，但只回到開畫面時帳號權限設定給的狀態（不會打開權限鎖住的欄位）。
  //      憑證種類＝收據（config 的 PLAIN_RECEIPT_TYPES）→ 同上，但稅額寫 0（不是空白）；優先於主檔的「要算稅」旗標。
  //      發票號碼照 3 處理（收據沒有「開放發票號碼」旗標 → 清空並鎖住）
  //   7. 是否有紙本憑證＝否 → 「會計課承辦註記是否收到單據紙本」寫「不適用」（show、變更事件含是否有紙本憑證、存檔前）；
  //      變更事件改回「是」且還是「不適用」→ 回到「未收到」
  //
  //   存檔驗證的錯誤由 payment_request_submit 統一顯示（呼叫 normalize／validate），這裡不另跳視窗。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const OPT = C.OPTIONS;
  const RULES = C.TRAFFIC_RULES;
  const M = C.REF_FIELDS.TRAFFIC_RULE_MASTER;
  const TRAFFIC = F.TRAFFIC_TABLE;
  const COLS = TRAFFIC.COLS;

  const REQUIRED_MARK_ID = 'pr-reason-required-mark';

  // ── 生效規則（來源：主檔或 config）────────────────────────────────────────
  //   統一形狀：
  //   {
  //     source: 'master' | 'config',
  //     receiptTypes: string[],                       // 全部憑證種類（排序）
  //     taxReceiptTypes: string[],                    // 要算稅（排序）
  //     invoiceReceiptTypes: string[],                // 開放發票號碼（排序）
  //     receiptByVehicle: { [交通工具]: string[] },   // 只放有限制的交通工具；陣列保留可選順序
  //     fixedByVehicle: { [交通工具]: { sellerTaxId, format } },
  //     paperReceiptVehicles: string[],               // 需紙本憑證（排序）
  //     reasonRequiredVehicles: string[],             // 理由必填（排序）
  //   }

  const sortedUnique = (list) => Array.from(new Set(list)).sort();
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const getRowsOf = (record) => (Array.isArray(record?.[TRAFFIC.CODE]?.value) ? record[TRAFFIC.CODE].value.filter((r) => r?.value) : []);

  /**
   * config 的 TRAFFIC_RULES → 生效規則（主檔讀不到時用）。
   * 固定賣方統編的交通工具是 HSR；需紙本憑證與理由必填的交通工具是 TAXI。
   * @param {Object} rules C.TRAFFIC_RULES
   * @param {Object} options C.OPTIONS
   * @returns {Object}
   */
  const rulesFromConfig = (rules, options) => {
    const receiptByVehicle = {};
    Object.keys(rules.RECEIPT_BY_VEHICLE).forEach((vehicle) => {
      receiptByVehicle[vehicle] = rules.RECEIPT_BY_VEHICLE[vehicle].slice();
    });
    return {
      source: 'config',
      receiptTypes: sortedUnique(Object.values(options.RECEIPT_TYPE)),
      taxReceiptTypes: sortedUnique(rules.TAX_RECEIPT_TYPES),
      invoiceReceiptTypes: sortedUnique(rules.INVOICE_RECEIPT_TYPES),
      receiptByVehicle,
      fixedByVehicle: { [options.VEHICLE.HSR]: { sellerTaxId: rules.HSR_SELLER_TAX_ID, format: rules.HSR_FORMAT } },
      paperReceiptVehicles: [options.VEHICLE.TAXI],
      reasonRequiredVehicles: [options.VEHICLE.TAXI],
    };
  };

  /**
   * 主檔（APPS.TRAFFIC_RULE_MASTER）的 REST records → 生效規則。停用的記錄忽略（等同沒列＝不限制、沒有旗標）。
   * 資料不合法 → 回傳 { errors: string[] }（呼叫端退回 config 規則）。
   * @param {Object[]} records
   * @returns {Object} 生效規則，或 { errors }
   */
  const rulesFromMaster = (records) => {
    const errors = [];
    const val = (rec, code) => rec?.[code]?.value;
    const text = (rec, code) => String(val(rec, code) ?? '').trim();
    const list = (rec, code) => (Array.isArray(val(rec, code)) ? val(rec, code) : []);

    const used = (Array.isArray(records) ? records : []).filter((rec) => {
      const inUse = val(rec, M.IN_USE);
      return inUse === undefined || inUse === M.IN_USE_VALUE;
    });

    const vehicles = [];
    const receipts = [];
    const names = new Set();
    used.forEach((rec, i) => {
      const where = `第 ${i + 1} 筆`;
      const type = val(rec, M.TYPE);
      const name = text(rec, M.NAME);
      if (type !== M.TYPE_VEHICLE && type !== M.TYPE_RECEIPT) errors.push(`${where}「${M.TYPE}」不是「${M.TYPE_VEHICLE}」或「${M.TYPE_RECEIPT}」`);
      if (!name) errors.push(`${where}「${M.NAME}」空白`);
      else if (names.has(name)) errors.push(`${where}「${M.NAME}」${name} 重複`);
      names.add(name);
      if (text(rec, M.FIXED_FORMAT) && !text(rec, M.FIXED_SELLER_TAX_ID)) errors.push(`${where}${name}：有「${M.FIXED_FORMAT}」但「${M.FIXED_SELLER_TAX_ID}」空白`);
      switch (type) {
        case M.TYPE_VEHICLE:
          vehicles.push({ rec, name });
          break;
        case M.TYPE_RECEIPT:
          receipts.push({ rec, name });
          break;
      }
    });
    if (!vehicles.length) errors.push(`沒有任何使用中的「${M.TYPE_VEHICLE}」記錄`);
    if (!receipts.length) errors.push(`沒有任何使用中的「${M.TYPE_RECEIPT}」記錄`);
    if (errors.length) return { errors };

    const receiptByVehicle = {};
    const fixedByVehicle = {};
    vehicles.forEach(({ rec, name }) => {
      const allowed = list(rec, M.ALLOWED_RECEIPTS);
      if (allowed.length) receiptByVehicle[name] = allowed.slice();
      const sellerTaxId = text(rec, M.FIXED_SELLER_TAX_ID);
      if (sellerTaxId) fixedByVehicle[name] = { sellerTaxId, format: text(rec, M.FIXED_FORMAT) };
    });
    const vehiclesWith = (flag) => sortedUnique(vehicles.filter(({ rec }) => list(rec, M.VEHICLE_FLAGS).includes(flag)).map((v) => v.name));
    const receiptsWith = (flag) => sortedUnique(receipts.filter(({ rec }) => list(rec, M.RECEIPT_FLAGS).includes(flag)).map((v) => v.name));
    return {
      source: 'master',
      receiptTypes: sortedUnique(receipts.map((r) => r.name)),
      taxReceiptTypes: receiptsWith(M.FLAG_TAX),
      invoiceReceiptTypes: receiptsWith(M.FLAG_INVOICE_NO),
      receiptByVehicle,
      fixedByVehicle,
      paperReceiptVehicles: vehiclesWith(M.FLAG_PAPER_RECEIPT),
      reasonRequiredVehicles: vehiclesWith(M.FLAG_REASON_REQUIRED),
    };
  };

  // 目前生效的規則：一載入就是 config 規則（任何時候都有規則可用），主檔讀成功才換掉
  let active = rulesFromConfig(RULES, OPT);
  let loadPromise = null;

  const getActiveRules = () => active;

  const withTimeout = (promise, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`讀取逾時（${ms} ms）`)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  /**
   * 讀主檔並換掉生效規則。整個頁面只讀一次（快取 Promise）；永不 reject：
   * 失敗、逾時、資料不合法都 console.warn 並維持 config 規則。
   * @param {Function} [api=kintone.api] 測試時可替換
   * @returns {Promise<Object>} 生效規則
   */
  const loadRules = (api) => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const call = api || kintone.api;
        const fields = [M.TYPE, M.NAME, M.IN_USE, M.ALLOWED_RECEIPTS, M.FIXED_SELLER_TAX_ID, M.FIXED_FORMAT, M.VEHICLE_FLAGS, M.RECEIPT_FLAGS];
        const params = { app: C.APPS.TRAFFIC_RULE_MASTER, query: `${M.IN_USE} in ("${M.IN_USE_VALUE}") limit 500`, fields };
        const resp = await withTimeout(Promise.resolve().then(() => call(kintone.api.url('/k/v1/records', true), 'GET', params)), RULES.MASTER_TIMEOUT_MS);
        const result = rulesFromMaster(resp?.records);
        if (result.errors) console.warn('[交通費明細規則] 規則主檔資料不合法，改用 config 規則', result.errors);
        else active = result;
      } catch (e) {
        console.warn('[交通費明細規則] 讀不到規則主檔，改用 config 規則', e);
      }
      return active;
    })();
    return loadPromise;
  };

  /** 測試用：回到 config 規則並清掉快取 */
  const _resetForTest = () => {
    active = rulesFromConfig(RULES, OPT);
    loadPromise = null;
    baseLocked = {};
  };

  // ── 純函式（只動 record，不碰畫面）────────────────────────────────────────

  /**
   * 含稅金額 → 稅額（字串，四捨五入到個位數）。金額空白或不是數字 → 空字串。
   * 用整數運算（金額 × 5 ÷ 105）避免 1.05 的浮點誤差；負數（退款）照絕對值算再補回正負號。
   * @param {string|number} amount
   * @returns {string}
   */
  const calcTax = (amount) => {
    if (amount === '' || amount === null || amount === undefined) return '';
    const n = Number(amount);
    if (!Number.isFinite(n)) return '';
    const rate = RULES.TAX_RATE_PERCENT;
    const tax = Math.round((Math.abs(n) * rate) / (100 + rate));
    return String(n < 0 && tax !== 0 ? -tax : tax);
  };

  const isInvoiceReceipt = (row) => active.invoiceReceiptTypes.includes(row.value[COLS.RECEIPT_TYPE]?.value);
  const isTaxReceipt = (row) => active.taxReceiptTypes.includes(row.value[COLS.RECEIPT_TYPE]?.value);
  /** 6. 憑證種類＝無（沒有憑證）→ 賣方統編、格式、稅額清空並鎖住 */
  const isNoReceipt = (row) => RULES.NO_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
  /** 6. 憑證種類＝收據 → 賣方統編、格式清空並鎖住，稅額寫 0 並鎖住 */
  const isPlainReceipt = (row) => RULES.PLAIN_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
  const NO_RECEIPT_CLEAR_COLS = [COLS.SELLER_TAX_ID, COLS.FORMAT, COLS.TAX];

  // 開畫面時（帳號權限設定已套用、本模組還沒鎖）各欄的鎖定狀態。
  //   變更事件「解鎖」只回到這個狀態，不會把帳號權限設定鎖住的欄位打開。
  const LOCK_COLS = [COLS.SELLER_TAX_ID, COLS.FORMAT, COLS.TAX, COLS.INVOICE_NO];
  let baseLocked = {};
  const captureBaseLocks = (record) => {
    const rows = getRowsOf(record);
    baseLocked = {};
    LOCK_COLS.forEach((code) => {
      const cell = rows.map((row) => row.value[code]).find(Boolean);
      baseLocked[code] = cell?.disabled === true;
    });
  };
  /**
   * 這個交通工具可選的憑證種類；交通工具空白或沒設定 → null（不限制）
   * @param {string} vehicle
   * @returns {string[]|null}
   */
  const allowedReceiptTypes = (vehicle) => (vehicle && own(active.receiptByVehicle, vehicle) && active.receiptByVehicle[vehicle]) || null;
  const isReceiptAllowed = (row) => {
    const receipt = row.value[COLS.RECEIPT_TYPE]?.value;
    const allowed = allowedReceiptTypes(row.value[COLS.VEHICLE]?.value);
    return !receipt || !allowed || allowed.includes(receipt);
  };
  /** 這一列交通工具的固定賣方統編／格式；沒有 → null */
  const fixedOf = (row) => {
    const vehicle = row.value[COLS.VEHICLE]?.value;
    return vehicle && own(active.fixedByVehicle, vehicle) ? active.fixedByVehicle[vehicle] : null;
  };
  const isFixedSellerTaxId = (taxId) => !!taxId && Object.values(active.fixedByVehicle).some((fixed) => fixed.sellerTaxId === taxId);
  const getRows = (record) => getRowsOf(record);

  /** 這張單裡命中名單的交通工具名稱（不重複，依列順序） */
  const vehiclesHit = (record, names) => Array.from(new Set(getRows(record).map((row) => row.value[COLS.VEHICLE]?.value).filter((v) => v && names.includes(v))));
  /** 有「需紙本憑證」旗標的交通工具（現在是計程車） */
  const paperVehicles = (record) => vehiclesHit(record, active.paperReceiptVehicles);
  /** 有「理由必填」旗標的交通工具（現在是計程車） */
  const reasonVehicles = (record) => vehiclesHit(record, active.reasonRequiredVehicles);
  /** 舊名稱相容：是否有任何一列需要紙本憑證（原本只看計程車） */
  const hasTaxi = (record) => paperVehicles(record).length > 0;

  /**
   * 套用一列的規則（寫值與鎖定）。
   * @param {Object} row 子表格的一列
   * @param {boolean} unlock true＝變更事件：條件不成立時解除鎖定；false＝開畫面：只加鎖不解鎖（不蓋掉帳號權限設定的鎖定）
   */
  const applyRowRules = (row, unlock) => {
    const v = row.value;
    const setLock = (code, locked) => {
      if (!v[code]) return;
      if (locked) v[code].disabled = true;
      else if (unlock) v[code].disabled = baseLocked[code] === true;
    };

    // 1. 固定賣方統編（現在是高鐵）
    const fixed = fixedOf(row);
    if (fixed) {
      if (v[COLS.SELLER_TAX_ID]) v[COLS.SELLER_TAX_ID].value = fixed.sellerTaxId;
      if (v[COLS.FORMAT]) v[COLS.FORMAT].value = fixed.format;
    }
    else if (unlock && isFixedSellerTaxId(v[COLS.SELLER_TAX_ID]?.value)) {
      v[COLS.SELLER_TAX_ID].value = '';
      if (v[COLS.FORMAT]) v[COLS.FORMAT].value = '';
    }
    // 賣方統編、格式的鎖定在 6 一起決定（固定值或憑證種類＝無）

    // 5. 交通工具限制憑證種類（只在變更事件改值；開畫面／存檔不動，交給 validate 擋）
    if (unlock && v[COLS.RECEIPT_TYPE]) {
      const allowed = allowedReceiptTypes(v[COLS.VEHICLE]?.value);
      if (!isReceiptAllowed(row)) v[COLS.RECEIPT_TYPE].value = '';
      if (allowed && allowed.length === 1 && !v[COLS.RECEIPT_TYPE].value) v[COLS.RECEIPT_TYPE].value = allowed[0];
    }

    // 3. 發票號碼
    if (v[COLS.INVOICE_NO]) {
      if (!isInvoiceReceipt(row)) v[COLS.INVOICE_NO].value = '';
      setLock(COLS.INVOICE_NO, !isInvoiceReceipt(row));
    }

    // 6. 憑證種類＝無 → 賣方統編、格式、稅額清空並鎖住（排在 1、5 後面：憑證種類可能剛被清空或帶入，固定值也要被蓋掉）
    //    憑證種類＝收據 → 同上，但稅額寫 0
    //    改成別的憑證種類（變更事件）→ 稅額解鎖；賣方統編、格式照 1 的固定值決定
    const none = isNoReceipt(row);
    const plain = isPlainReceipt(row);
    const cleared = none || plain;
    NO_RECEIPT_CLEAR_COLS.forEach((code) => {
      if (cleared && v[code]) v[code].value = '';
    });
    if (plain && v[COLS.TAX]) v[COLS.TAX].value = '0';
    setLock(COLS.SELLER_TAX_ID, cleared || !!fixed);
    setLock(COLS.FORMAT, cleared || !!fixed);
    setLock(COLS.TAX, cleared);
  };

  /**
   * 2. 重算這一列的稅額：高鐵票／發票才算，其他種類寫 0。
   * 只在變更事件對「被改的那一列」呼叫（見 changeEvents）；開畫面、新增別列、存檔都不動稅額，
   * 會計（帳號權限設定開放編輯）手改的稅額才不會被蓋掉。稅額不鎖：能不能改交給帳號權限設定。
   * @param {Object} row 子表格的一列
   */
  const recalcRowTax = (row) => {
    const v = row?.value;
    if (!v?.[COLS.TAX]) return;
    if (isNoReceipt(row)) v[COLS.TAX].value = ''; // 6. 憑證種類＝無 → 稅額清空
    else if (isPlainReceipt(row)) v[COLS.TAX].value = '0'; // 6. 憑證種類＝收據 → 稅額 0
    else v[COLS.TAX].value = isTaxReceipt(row) ? calcTax(v[COLS.AMOUNT]?.value) : '0';
  };

  /**
   * 變更事件改到的是哪一列（kintone 的 event.changes.row）；刪除列或不是子表格的變更 → null
   * @param {Object} event
   * @returns {Object|null}
   */
  const changedRow = (event) => {
    const target = event?.changes?.row;
    if (!target) return null;
    const rows = getRows(event.record);
    return rows.find((row) => row === target) || (target.id ? rows.find((row) => row.id === target.id) : null) || target;
  };

  /**
   * 套用整張單的規則：每一列＋計程車 → 是否有紙本憑證選「是」。
   * @param {Object} record
   * @param {boolean} unlock 見 applyRowRules
   * @returns {Object} record
   */
  const applyRecordRules = (record, unlock) => {
    getRows(record).forEach((row) => applyRowRules(row, unlock));
    if (paperVehicles(record).length && record[F.PAPER_RECEIPT]) record[F.PAPER_RECEIPT].value = OPT.PAPER_RECEIPT.YES;
    applyPaperReceived(record, unlock);
    return record;
  };

  /**
   * 7. 是否有紙本憑證＝否 → 會計課承辦註記是否收到單據紙本 寫「不適用」。
   *    改回「是」（變更事件）且還是「不適用」→ 回到 kintone 預設的「未收到」；
   *    開畫面／存檔時是「是」就不動（會計課自己選的值保留）。排在計程車強制選「是」後面。
   * @param {Object} record
   * @param {boolean} unlock true＝變更事件
   */
  const applyPaperReceived = (record, unlock) => {
    const received = record[F.PAPER_RECEIVED];
    const paper = record[F.PAPER_RECEIPT]?.value;
    if (!received || !paper) return;
    if (paper === OPT.PAPER_RECEIPT.NO) received.value = OPT.PAPER_RECEIVED.NOT_APPLICABLE;
    else if (unlock && received.value === OPT.PAPER_RECEIVED.NOT_APPLICABLE) received.value = OPT.PAPER_RECEIVED.NOT_RECEIVED;
  };

  /**
   * 存檔前整理：高鐵固定值、清掉不該有的發票號碼，並重算「發票號碼記錄」。
   * 程式寫入的值不會觸發 change 事件，所以存檔時一律再算一次，以這裡為準。
   * @param {Object} record
   * @returns {Object} record
   */
  const normalize = (record) => {
    applyRecordRules(record, false);
    getRows(record).forEach((row) => {
      if (row.value[COLS.INVOICE_NO]?.value) row.value[COLS.INVOICE_NO].value = row.value[COLS.INVOICE_NO].value.trim();
    });
    const agg = window.PR_INVOICE_AGG;
    if (record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(record);
    return record;
  };

  /**
   * 存檔驗證（先呼叫 normalize）。回傳錯誤訊息陣列，格式配合 payment_request_submit 的錯誤視窗。
   * @param {Object} record
   * @returns {string[]}
   */
  const validate = (record) => {
    const errors = [];
    const rows = getRows(record);

    // 交通工具與憑證種類的組合
    rows.forEach((row, i) => {
      if (isReceiptAllowed(row)) return;
      const vehicle = row.value[COLS.VEHICLE].value;
      errors.push(
        `第 ${i + 1} 行交通工具是「${vehicle}」，「${COLS.RECEIPT_TYPE}」**不能選「${row.value[COLS.RECEIPT_TYPE].value}」**\n※ 可選：${allowedReceiptTypes(vehicle).join('、')}`,
      );
    });

    // 發票號碼：高鐵票／發票必填、表單內不可重複
    const seen = {};
    rows.forEach((row, i) => {
      if (!isInvoiceReceipt(row)) return;
      const no = (row.value[COLS.INVOICE_NO]?.value || '').trim();
      if (!no) {
        errors.push(`第 ${i + 1} 行憑證種類是「${row.value[COLS.RECEIPT_TYPE].value}」，**請填寫「${COLS.INVOICE_NO}」**`);
        return;
      }
      (seen[no] = seen[no] || []).push(i + 1);
    });
    Object.keys(seen)
      .filter((no) => seen[no].length > 1)
      .forEach((no) => {
        errors.push(`「${COLS.INVOICE_NO}」**${no}** 在本單重複填寫（第 ${seen[no].join('、')} 行）\n※ 同一張發票只能填一次`);
      });

    // 需紙本憑證的交通工具（現在是計程車）：是否有紙本憑證要選「是」；理由必填的交通工具：理由必填
    const paper = paperVehicles(record);
    if (paper.length && record[F.PAPER_RECEIPT] && record[F.PAPER_RECEIPT].value !== OPT.PAPER_RECEIPT.YES) {
      errors.push(`有搭乘${paper.join('、')}，「${F.PAPER_RECEIPT}」**必須選「${OPT.PAPER_RECEIPT.YES}」**`);
    }
    const reason = reasonVehicles(record);
    if (reason.length && !(record[F.REASON]?.value || '').trim()) {
      errors.push(`有搭乘${reason.join('、')}，**請填寫「${F.REASON}」**`);
    }
    return errors;
  };

  // ── 畫面：理由動態必填的紅色 * ────────────────────────────────────────────

  /**
   * 有「理由必填」的交通工具（現在是計程車）就在「理由」標籤後面加紅色 *，沒有就拿掉。
   * kintone 沒有切換必填的 API，只能找標籤文字以 REASON_LABEL_PREFIX 開頭的欄位；找不到就略過（存檔驗證仍會擋）。
   */
  const updateReasonRequiredMark = (required) => {
    try {
      const existing = document.getElementById(REQUIRED_MARK_ID);
      if (!required) {
        if (existing) existing.remove();
        return;
      }
      if (existing) return;
      const label = Array.from(document.querySelectorAll('.control-label-text-gaia')).find((el) =>
        (el.textContent || '').trim().startsWith(RULES.REASON_LABEL_PREFIX),
      );
      if (!label) return;
      const mark = document.createElement('span');
      mark.id = REQUIRED_MARK_ID;
      // 樣式在 payment_request.css 的 .pr-required-mark
      mark.className = 'kintone-field-required pr-required-mark';
      mark.textContent = '*';
      label.appendChild(mark);
    } catch (e) {
      console.warn('[交通費明細規則] 理由必填標示失敗', e);
    }
  };

  // ── 畫面：憑證種類下拉選單只列出可選的項目（桌面版）───────────────────────
  //   kintone 沒有隱藏下拉選項的 API。桌面版的下拉選單點開後是掛在 body 的 .goog-menu，
  //   點子表格的下拉時記下是哪一列哪一欄，選單出現後把不能選的項目加上 pr-option-hidden。
  //   這是畫面層的輔助，DOM 改版找不到就不做；真正的把關是變更事件與存檔驗證。

  const OPTION_HIDDEN_CLASS = 'pr-option-hidden';
  /** 選單過濾認得的憑證種類：config 選項值 ∪ 生效規則裡出現過的 */
  const allReceiptTypes = () =>
    Array.from(new Set([...Object.values(OPT.RECEIPT_TYPE), ...active.receiptTypes, ...active.taxReceiptTypes, ...active.invoiceReceiptTypes, ...Object.values(active.receiptByVehicle).flat()]));

  const cellLabel = (th) => (th?.textContent || '').replace(/\*/g, '').trim();

  /**
   * 把選單裡不能選的憑證種類藏起來；allowed 為 null 時全部顯示。
   * 只動憑證種類的選項（「-----」等其他項目不碰），所以點其他欄位的下拉也可以呼叫來還原。
   * @param {Element} menu .goog-menu
   * @param {string[]|null} allowed
   * @returns {number} 藏起來的項目數
   */
  const filterMenuItems = (menu, allowed) => {
    let hidden = 0;
    const known = allReceiptTypes();
    Array.from(menu.querySelectorAll('.goog-menuitem')).forEach((item) => {
      const text = (item.textContent || '').trim();
      const hide = !!allowed && known.includes(text) && !allowed.includes(text);
      item.classList.toggle(OPTION_HIDDEN_CLASS, hide);
      if (hide) hidden += 1;
    });
    return hidden;
  };

  /**
   * 點到的是不是交通費明細的下拉；是 → 回傳這次選單要用的限制（不是憑證種類欄 → null＝全部顯示）。
   * @param {Element} target 點到的元素
   * @returns {{ allowed: string[]|null }|undefined} 不是交通費明細的下拉 → undefined
   */
  const menuContext = (target) => {
    const select = target?.closest?.('.gaia-argoui-select');
    const td = select?.closest('td');
    const tr = td?.closest('tr');
    const table = tr?.closest('table');
    if (!table) return undefined;
    const headers = Array.from(table.querySelectorAll('thead th'));
    const labelAt = (i) => cellLabel(headers[i]);
    const receiptLabel = C.TRAFFIC_TABLE_LAYOUT.COLUMNS.find((c) => c.code === COLS.RECEIPT_TYPE)?.label || COLS.RECEIPT_TYPE;
    if (!headers.some((th) => cellLabel(th) === receiptLabel)) return undefined;
    const tds = Array.from(tr.children);
    if (labelAt(tds.indexOf(td)) !== receiptLabel) return { allowed: null };
    const rowIndex = Array.from(tr.parentNode.children).indexOf(tr);
    const row = getRows(KT.record().get().record)[rowIndex];
    return { allowed: row ? allowedReceiptTypes(row.value[COLS.VEHICLE]?.value) : null };
  };

  const filterOpenMenus = (allowed) => {
    document.querySelectorAll('.goog-menu').forEach((menu) => {
      if (getComputedStyle(menu).display !== 'none') filterMenuItems(menu, allowed);
    });
  };

  const installMenuFilter = () => {
    if (KT.IS_MOBILE || typeof document.addEventListener !== 'function') return;
    const onOpen = (e) => {
      try {
        const ctx = menuContext(e.target);
        if (!ctx) return;
        // 選單是點下去之後才畫出來，等一下再處理（第二次是保險）
        [0, 50].forEach((ms) => setTimeout(() => filterOpenMenus(ctx.allowed), ms));
      } catch (err) {
        console.warn('[交通費明細規則] 憑證種類選單過濾失敗', err);
      }
    };
    document.addEventListener('mousedown', onOpen, true);
    document.addEventListener('keydown', onOpen, true);
  };
  installMenuFilter();

  // ── 事件 ───────────────────────────────────────────────────────────────

  // 先讀完規則主檔再套規則（kintone 會等 show 的 Promise；loadRules 永不 reject）
  KT.on(['app.record.create.show', 'app.record.edit.show'], async (event) => {
    await loadRules();
    captureBaseLocks(event.record);
    applyRecordRules(event.record, false);
    updateReasonRequiredMark(reasonVehicles(event.record).length > 0);
    return event;
  });

  const changeEvents = [TRAFFIC.CODE, COLS.VEHICLE, COLS.AMOUNT, COLS.RECEIPT_TYPE, F.PAPER_RECEIPT].flatMap((code) => [
    `app.record.create.change.${code}`,
    `app.record.edit.change.${code}`,
  ]);

  KT.on(changeEvents, (event) => {
    applyRecordRules(event.record, true);
    // 稅額只重算被改的那一列（憑證種類可能剛被上面的規則清空或帶入，所以排在後面）
    const row = changedRow(event);
    if (row) recalcRowTax(row);
    // 憑證種類改掉會清空發票號碼，發票號碼記錄要跟著重算（程式寫入不會觸發發票號碼的 change）
    const agg = window.PR_INVOICE_AGG;
    if (event.record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') {
      event.record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(event.record);
    }
    updateReasonRequiredMark(reasonVehicles(event.record).length > 0);
    return event;
  });

  window.PR_TRAFFIC_RULES = Object.freeze({ calcTax, recalcRowTax, changedRow, hasTaxi, rulesFromConfig, rulesFromMaster, loadRules, getActiveRules, _resetForTest, allowedReceiptTypes, isNoReceipt, isPlainReceipt, filterMenuItems, menuContext, applyRowRules, applyRecordRules, normalize, validate, updateReasonRequiredMark });
})();
