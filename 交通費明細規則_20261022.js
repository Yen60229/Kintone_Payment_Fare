(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 交通費明細規則（子表格「交通費請款單」與「是否有紙本憑證」「理由」）
  //
  //   1. 交通工具＝高鐵 → 賣方統編寫 TRAFFIC_RULES.HSR_SELLER_TAX_ID、格式寫 HSR_FORMAT，並鎖住；
  //      改選高鐵以外（變更事件）→ 若賣方統編還是高鐵固定值，賣方統編、格式一起清空並解鎖
  //   2. 某一列的金額、憑證種類、交通工具變更或新增列 → 只重算「那一列」的稅額：憑證種類是 TRAFFIC_RULES.TAX_RECEIPT_TYPES（高鐵票／發票）
  //      → 金額 ÷ 1.05 × 0.05 四捨五入到個位數（金額含稅），其他種類寫 0；開畫面、存檔、改別列都不動稅額（會計手改的保留）。稅額不鎖
  //   3. 憑證種類＝高鐵票／發票 → 開放發票號碼；其他種類鎖住並清空。存檔時必填、表單內不可重複，
  //      並重算「發票號碼記錄」（跨單重複由 payment_request_submit 查記錄欄位，不用迴圈讀表格）
  //   4. 有任何一列是計程車 → 是否有紙本憑證自動選「是」，理由動態必填（標籤加紅色 *）
  //   5. 交通工具限制憑證種類（TRAFFIC_RULES.RECEIPT_BY_VEHICLE）：變更事件清掉不能用的組合、只有一種就自動帶入；
  //      存檔時擋下不能用的組合；桌面版下拉選單只列出可選的項目
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
  const isTaxReceipt = (row) => RULES.TAX_RECEIPT_TYPES.includes(row.value[COLS.RECEIPT_TYPE]?.value);
  /**
   * 這個交通工具可選的憑證種類；交通工具空白或沒設定 → null（不限制）
   * @param {string} vehicle
   * @returns {string[]|null}
   */
  const allowedReceiptTypes = (vehicle) => (vehicle && RULES.RECEIPT_BY_VEHICLE[vehicle]) || null;
  const isReceiptAllowed = (row) => {
    const receipt = row.value[COLS.RECEIPT_TYPE]?.value;
    const allowed = allowedReceiptTypes(row.value[COLS.VEHICLE]?.value);
    return !receipt || !allowed || allowed.includes(receipt);
  };
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
    else if (unlock && v[COLS.SELLER_TAX_ID]?.value === RULES.HSR_SELLER_TAX_ID) {
      v[COLS.SELLER_TAX_ID].value = '';
      if (v[COLS.FORMAT]) v[COLS.FORMAT].value = '';
    }
    setLock(COLS.SELLER_TAX_ID, isHsr(row));
    setLock(COLS.FORMAT, isHsr(row));

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
  };

  /**
   * 2. 重算這一列的稅額：高鐵票／發票才算，其他種類寫 0。
   * 只在變更事件對「被改的那一列」呼叫（見 changeEvents）；開畫面、新增別列、存檔都不動稅額，
   * 會計（帳號權限設定開放編輯）手改的稅額才不會被蓋掉。稅額不鎖：能不能改交給帳號權限設定。
   * @param {Object} row 子表格的一列
   */
  const recalcRowTax = (row) => {
    const v = row?.value;
    if (v?.[COLS.TAX]) v[COLS.TAX].value = isTaxReceipt(row) ? calcTax(v[COLS.AMOUNT]?.value) : '0';
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
    if (hasTaxi(record) && record[F.PAPER_RECEIPT]) record[F.PAPER_RECEIPT].value = OPT.PAPER_RECEIPT.YES;
    return record;
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
  const ALL_RECEIPT_TYPES = Object.values(OPT.RECEIPT_TYPE);

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
    Array.from(menu.querySelectorAll('.goog-menuitem')).forEach((item) => {
      const text = (item.textContent || '').trim();
      const hide = !!allowed && ALL_RECEIPT_TYPES.includes(text) && !allowed.includes(text);
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
    // 稅額只重算被改的那一列（憑證種類可能剛被上面的規則清空或帶入，所以排在後面）
    const row = changedRow(event);
    if (row) recalcRowTax(row);
    // 憑證種類改掉會清空發票號碼，發票號碼記錄要跟著重算（程式寫入不會觸發發票號碼的 change）
    const agg = window.PR_INVOICE_AGG;
    if (event.record[F.INVOICE_AGG] && typeof agg?.buildInvoiceAgg === 'function') {
      event.record[F.INVOICE_AGG].value = agg.buildInvoiceAgg(event.record);
    }
    updateReasonRequiredMark(hasTaxi(event.record));
    return event;
  });

  window.PR_TRAFFIC_RULES = Object.freeze({ calcTax, recalcRowTax, changedRow, hasTaxi, allowedReceiptTypes, filterMenuItems, menuContext, applyRowRules, applyRecordRules, normalize, validate, updateReasonRequiredMark });
})();
