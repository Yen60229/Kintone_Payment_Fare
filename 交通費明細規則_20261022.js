(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 交通費明細規則（子表格「交通費請款單」與「是否有紙本憑證」「理由」）
  //
  //   1. 交通工具＝高鐵 → 賣方統編寫 TRAFFIC_RULES.HSR_SELLER_TAX_ID、格式寫 HSR_FORMAT，並鎖住
  //   2. 金額變更 → 稅額＝金額 ÷ 1.05 × 0.05，四捨五入到個位數（金額本身含稅），稅額鎖住
  //   3. 憑證種類＝高鐵票／發票 → 開放發票號碼；其他種類鎖住並清空。存檔時必填、表單內不可重複，
  //      並重算「發票號碼記錄」（跨單重複由 payment_request_submit 查記錄欄位，不用迴圈讀表格）
  //   4. 有任何一列是計程車 → 是否有紙本憑證自動選「是」，理由動態必填（標籤加紅色 *）
  //
  //   存檔驗證的錯誤由 payment_request_submit 統一顯示（呼叫 normalize／validate），這裡不另跳視窗。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const OPT = C.OPTIONS;
  const RULES = C.TRAFFIC_RULES;
  const TRAFFIC = F.TRAFFIC_TABLE;
  const COLS = TRAFFIC.COLS;

  const REQUIRED_MARK_ID = 'pr-reason-required-mark';

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

  const isInvoiceReceipt = (row) => RULES.INVOICE_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
  const isHsr = (row) => row.value[COLS.VEHICLE]?.value === OPT.VEHICLE.HSR;
  const getRows = (record) => (Array.isArray(record[TRAFFIC.CODE]?.value) ? record[TRAFFIC.CODE].value.filter((r) => r?.value) : []);

  /** 是否有任何一列交通工具是計程車 */
  const hasTaxi = (record) => getRows(record).some((row) => row.value[COLS.VEHICLE]?.value === OPT.VEHICLE.TAXI);

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
      else if (unlock) v[code].disabled = false;
    };

    // 1. 高鐵
    if (isHsr(row)) {
      if (v[COLS.SELLER_TAX_ID]) v[COLS.SELLER_TAX_ID].value = RULES.HSR_SELLER_TAX_ID;
      if (v[COLS.FORMAT]) v[COLS.FORMAT].value = RULES.HSR_FORMAT;
    }
    setLock(COLS.SELLER_TAX_ID, isHsr(row));
    setLock(COLS.FORMAT, isHsr(row));

    // 2. 稅額
    if (v[COLS.TAX] && v[COLS.AMOUNT]) v[COLS.TAX].value = calcTax(v[COLS.AMOUNT].value);
    setLock(COLS.TAX, true);

    // 3. 發票號碼
    if (v[COLS.INVOICE_NO]) {
      if (!isInvoiceReceipt(row)) v[COLS.INVOICE_NO].value = '';
      setLock(COLS.INVOICE_NO, !isInvoiceReceipt(row));
    }
  };

  /**
   * 套用整張單的規則：每一列＋計程車 → 是否有紙本憑證選「是」。
   * @param {Object} record
   * @param {boolean} unlock 見 applyRowRules
   * @returns {Object} record
   */
  const applyRecordRules = (record, unlock) => {
    getRows(record).forEach((row) => applyRowRules(row, unlock));
    if (hasTaxi(record) && record[F.PAPER_RECEIPT]) record[F.PAPER_RECEIPT].value = OPT.PAPER_RECEIPT.YES;
    return record;
  };

  /**
   * 存檔前整理：重算稅額、高鐵固定值、清掉不該有的發票號碼，並重算「發票號碼記錄」。
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

    // 計程車：是否有紙本憑證要選「是」、理由必填
    if (hasTaxi(record)) {
      if (record[F.PAPER_RECEIPT] && record[F.PAPER_RECEIPT].value !== OPT.PAPER_RECEIPT.YES) {
        errors.push(`有搭乘${OPT.VEHICLE.TAXI}，「${F.PAPER_RECEIPT}」**必須選「${OPT.PAPER_RECEIPT.YES}」**`);
      }
      if (!(record[F.REASON]?.value || '').trim()) {
        errors.push(`有搭乘${OPT.VEHICLE.TAXI}，**請填寫「${F.REASON}」**`);
      }
    }
    return errors;
  };

  // ── 畫面：理由動態必填的紅色 * ────────────────────────────────────────────

  /**
   * 有計程車就在「理由」標籤後面加紅色 *，沒有就拿掉。
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
      // 樣式在 styles/common.css 的 .pr-required-mark
      mark.className = 'kintone-field-required pr-required-mark';
      mark.textContent = '*';
      label.appendChild(mark);
    } catch (e) {
      console.warn('[交通費明細規則] 理由必填標示失敗', e);
    }
  };

  // ── 事件 ───────────────────────────────────────────────────────────────

  KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
    applyRecordRules(event.record, false);
    updateReasonRequiredMark(hasTaxi(event.record));
    return event;
  });

  const changeEvents = [TRAFFIC.CODE, COLS.VEHICLE, COLS.AMOUNT, COLS.RECEIPT_TYPE].flatMap((code) => [
    `app.record.create.change.${code}`,
    `app.record.edit.change.${code}`,
  ]);

  KT.on(changeEvents, (event) => {
    applyRecordRules(event.record, true);
    // 憑證種類改掉會清空發票號碼，發票號碼記錄要跟著重算（程式寫入不會觸發發票號碼的 change）
    const agg = window.PR_INVOICE_AGG;
    if (event.record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') {
      event.record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(event.record);
    }
    updateReasonRequiredMark(hasTaxi(event.record));
    return event;
  });

  window.PR_TRAFFIC_RULES = Object.freeze({ calcTax, hasTaxi, applyRowRules, applyRecordRules, normalize, validate, updateReasonRequiredMark });
})();
