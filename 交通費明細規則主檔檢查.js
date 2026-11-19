(() => {
  'use strict';

  // =============================================================================
  // 交通費明細規則主檔（APPS.TRAFFIC_RULE_MASTER）存檔檢查 —— 上傳到規則主檔，不是請款單
  //
  // 規則主檔每筆記錄＝請款單子表格下拉選項的一個選項，「名稱」要和下拉選項一字不差；
  // 打錯字的話請款單端對不到，會靜默當成「不限制」。所以在主檔存檔時擋下。
  //
  // 【上傳順序】規則主檔的 JavaScript（PC）：① payment_request_config.js ② 本檔。
  //   config 是自包含的 IIFE（不用打包），在規則主檔執行時 APPS.PAYMENT 會是規則主檔自己的 ID，
  //   所以本檔讀請款單表單設定一律用 APPS.TRAFFIC_PAYMENT。
  // 事件走 PR_KT.on（規則主檔只有 PC，PR_KT 在桌面版等於 kintone.events.on）。
  // 手機版不用上傳。
  //
  // 檢查範圍：「使用狀況」不分使用中／停用，一律檢查——停用的之後可能改回使用中，
  //   名稱打錯的話到時才發現就晚了。
  // =============================================================================

  const C = window.PR_CONFIG;
  if (!C || !window.PR_KT) {
    console.error('交通費明細規則主檔檢查：找不到 PR_CONFIG，請確認 payment_request_config.js 排在本檔前面');
    return;
  }

  const M = C.REF_FIELDS.TRAFFIC_RULE_MASTER;
  const TABLE = C.FIELDS.TRAFFIC_TABLE;
  const SUBMIT_EVENTS = ['app.record.create.submit', 'app.record.edit.submit', 'app.record.index.edit.submit'];
  const NO_FORM_MESSAGE = '讀不到交通費請款單的欄位設定，無法檢查名稱，請稍後再試或聯絡系統管理員';

  const LABEL_VEHICLE = '交通工具';
  const LABEL_RECEIPT = '憑證種類';

  /** 取欄位值；欄位不在 record 裡回傳 undefined（列表直接編輯可能只帶部分欄位） */
  const valueOf = (record, code) => (record && record[code] ? record[code].value : undefined);
  const text = (v) => (v === undefined || v === null ? '' : String(v));
  const list = (v) => (Array.isArray(v) ? v : []);

  /**
   * 請款單 form fields 的 properties → 子表格兩個下拉欄位的選項文字（options 的 key 即選項文字）。
   * @returns {{ vehicles: string[], receipts: string[] }}
   */
  const extractOptions = (properties) => {
    const table = properties && properties[TABLE.CODE];
    const cols = table && table.fields;
    if (!cols || !cols[TABLE.COLS.VEHICLE] || !cols[TABLE.COLS.RECEIPT_TYPE]) {
      throw new Error('請款單表單設定找不到子表格或下拉欄位');
    }
    const keys = (field) => Object.keys(field.options || {});
    return { vehicles: keys(cols[TABLE.COLS.VEHICLE]), receipts: keys(cols[TABLE.COLS.RECEIPT_TYPE]) };
  };

  /**
   * 檢查一筆規則主檔記錄。
   * @param {Object} record kintone 記錄物件
   * @param {{ vehicles: string[], receipts: string[] }} options 請款單的下拉選項
   * @returns {string[]} 錯誤訊息（空陣列＝通過）
   */
  const validateMasterRecord = (record, options) => {
    const errors = [];
    const type = valueOf(record, M.TYPE);
    const rawName = valueOf(record, M.NAME);
    const isVehicle = type === M.TYPE_VEHICLE;
    const isReceipt = type === M.TYPE_RECEIPT;

    // ── 名稱 ──
    if (rawName !== undefined && (isVehicle || isReceipt)) {
      const raw = text(rawName);
      const name = raw.trim();
      const own = isVehicle ? options.vehicles : options.receipts;
      const other = isVehicle ? options.receipts : options.vehicles;
      const ownLabel = isVehicle ? LABEL_VEHICLE : LABEL_RECEIPT;
      if (name && raw !== name) {
        errors.push(`「${M.NAME}」「${raw}」前後有空白`);
      } else if (name && !own.includes(name)) {
        const hint = other.includes(name) ? `；這是${isVehicle ? LABEL_RECEIPT : LABEL_VEHICLE}的選項，${M.TYPE}是否選錯？` : '';
        errors.push(`「${M.NAME}」「${raw}」不是交通費請款單「${ownLabel}」的選項（可選：${own.join('、')}）${hint}`);
      }
    }

    // ── 交通工具用欄位 ──
    if (isVehicle) {
      list(valueOf(record, M.ALLOWED_RECEIPTS)).forEach((r) => {
        if (!options.receipts.includes(r)) {
          errors.push(`「${M.ALLOWED_RECEIPTS}」的「${r}」不是交通費請款單「${LABEL_RECEIPT}」的選項（可選：${options.receipts.join('、')}）`);
        }
      });
      if (text(valueOf(record, M.FIXED_FORMAT)).trim() && !text(valueOf(record, M.FIXED_SELLER_TAX_ID)).trim()) {
        errors.push(`「${M.FIXED_FORMAT}」有填但「${M.FIXED_SELLER_TAX_ID}」空白（有填固定賣方統編才能填固定格式）`);
      }
      [M.RECEIPT_FLAGS, M.LOCK_COLS].forEach((code) => {
        if (list(valueOf(record, code)).length) errors.push(`${M.TYPE}是${M.TYPE_VEHICLE}時，「${code}」要留空`);
      });
    }

    // ── 憑證種類不用的欄位（請款單端會忽略，擋下避免誤會）──
    if (isReceipt) {
      const filled = [];
      if (list(valueOf(record, M.ALLOWED_RECEIPTS)).length) filled.push(M.ALLOWED_RECEIPTS);
      if (text(valueOf(record, M.FIXED_SELLER_TAX_ID)).trim()) filled.push(M.FIXED_SELLER_TAX_ID);
      if (text(valueOf(record, M.FIXED_FORMAT)).trim()) filled.push(M.FIXED_FORMAT);
      if (list(valueOf(record, M.VEHICLE_FLAGS)).length) filled.push(M.VEHICLE_FLAGS);
      filled.forEach((f) => errors.push(`${M.TYPE}是${M.TYPE_RECEIPT}時，「${f}」是${M.TYPE_VEHICLE}用的欄位，要留空`));
      const locks = list(valueOf(record, M.LOCK_COLS));
      if (locks.includes(M.LOCK_TAX_EMPTY) && locks.includes(M.LOCK_TAX_ZERO)) {
        errors.push(`「${M.LOCK_COLS}」的「${M.LOCK_TAX_EMPTY}」和「${M.LOCK_TAX_ZERO}」只能擇一`);
      }
    }
    return errors;
  };

  // ── 讀請款單表單設定（整頁只讀一次；失敗時清掉快取，下次存檔再試）──
  let optionsPromise = null;
  const loadOptions = () => {
    if (!optionsPromise) {
      optionsPromise = kintone
        .api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: C.APPS.TRAFFIC_PAYMENT })
        .then((resp) => extractOptions(resp && resp.properties))
        .catch((err) => {
          optionsPromise = null;
          throw err;
        });
    }
    return optionsPromise;
  };

  const handler = async (event) => {
    let options;
    try {
      options = await loadOptions();
    } catch (err) {
      console.error('交通費明細規則主檔檢查：讀取交通費請款單欄位設定失敗', err);
      event.error = NO_FORM_MESSAGE;
      return event;
    }
    const errors = validateMasterRecord(event.record, options);
    if (errors.length) event.error = errors.map((e) => `・${e}`).join('\n');
    return event;
  };

  window.PR_KT.on(SUBMIT_EVENTS, handler);

  window.PR_TRAFFIC_RULE_MASTER_CHECK = Object.freeze({ validateMasterRecord, extractOptions });
})();
