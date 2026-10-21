(function () {
  'use strict';

  // =========================================================================
  // SECTION 1: 頂層常數與設定 (Config & Constants)
  // =========================================================================

  const CURRENT_YEAR = new Date().getFullYear();

  // PR_CONFIG 全域物件別名
  const C = window.PR_CONFIG;
  const F = window.PR_CONFIG.FIELDS;
  const REF_CC = C.REF_FIELDS.COST_CENTER; // 費用歸屬主檔自己的欄位代碼
  const APPS = window.PR_CONFIG.APPS;
  const STATUS = window.PR_CONFIG.STATUS;

  const TRAFFIC = F.TRAFFIC_TABLE;

  // 關聯 App 配置
  const COST_CENTER_APP_ID = APPS.COST_CENTER;

  // =========================================================================
  // SECTION 2: API 存取與資料輔助函數 (API & Helper Functions)
  // =========================================================================

  /**
   * 發票號碼重複檢查的 REST 存取統一入口
   */
  const invoiceCheckApi = (path, method, body, appId) => {
    if (window.NXSdaApi && typeof window.NXSdaApi.call === 'function') {
      return window.NXSdaApi.call(path, method, body, appId);
    }
    return kintone.api(kintone.api.url(path, true), method, body);
  };

  /**
   * 從費用歸屬主檔動態取得「使用中」的費用歸屬代碼集合
   * @returns {Promise<Set<string>>}
   */
  const fetchValidCostCenters = async () => {
    const validSet = new Set();
    const params = {
      app: COST_CENTER_APP_ID,
      fields: [REF_CC.CODE],
      query: `${REF_CC.IN_USE} in ("使用中")`,
      size: 500,
    };

    const cursor = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'POST', params);

    let hasNext = true;
    while (hasNext) {
      const resp = await kintone.api(kintone.api.url('/k/v1/records/cursor', true), 'GET', { id: cursor.id });
      resp.records.forEach((r) => {
        const code = r[REF_CC.CODE]?.value?.trim();
        if (code) validSet.add(code);
      });
      hasNext = resp.next;
    }

    return validSet;
  };

  /**
   * 取「使用中」的費用歸屬代碼。
   * 主程式開畫面時已經載入同一份主檔，優先共用它的快取（存檔時少兩次 API 往返）；
   * 主程式沒載入時才自己查。
   * @returns {Promise<Set<string>>}
   */
  const getValidCostCenters = async () => {
    const shared = window.PR_COST_CENTER;
    if (typeof shared?.ensureLoaded === 'function' && typeof shared.getValidCodes === 'function') {
      await shared.ensureLoaded();
      return shared.getValidCodes();
    }
    return fetchValidCostCenters();
  };

  const escKintoneStr = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  /**
   * 發票號碼重複檢查。回傳要顯示給使用者的錯誤訊息陣列。
   * 查本 App「發票號碼記錄」欄位（每張發票以分隔字元包住存放），排除已作廢的單與自己。
   * @param {Object} record
   * @returns {Promise<string[]>}
   */
  const checkInvoiceDuplicate = async (record) => {
    const SEP = C.SEP;
    const APP_ID = APPS.PAYMENT;

    // 發票號碼記錄的格式是「 / A / B / 」（頭尾也有分隔字元），不能先 trim 再切，否則頭尾的 / 會黏在發票號碼上
    const agg = record[F.INVOICE_AGG]?.value || '';
    if (!agg.trim()) return [];

    const invoices = agg
      .split(SEP)
      .map((s) => s.trim())
      .filter(Boolean);
    const invoiceOr = invoices.map((v) => `${F.INVOICE_AGG} like "${escKintoneStr(`${SEP}${v}${SEP}`)}"`).join(' or ');

    const thisId = record.$id?.value;
    const excludeSelf = thisId ? ` and $id != ${thisId}` : '';

    const query = `${F.STATUS_FIELD} not in ("${STATUS.VOID}") and (${invoiceOr})${excludeSelf} limit 1`;

    const resp = await invoiceCheckApi('/k/v1/records.json', 'GET', { app: APP_ID, query, fields: ['$id'] }, APP_ID);
    return resp.records && resp.records.length > 0 ? ['發票號碼重複：已存在相同發票號碼，請更換後再儲存。'] : [];
  };

  /**
   * 驗證費用歸屬代碼是否有效
   */
  const isValidCode = (code, validSet) => {
    if (!validSet || validSet.size === 0) {
      return false;
    }
    return validSet.has(code);
  };

  // =========================================================================
  // SECTION 3: 核心表單驗證邏輯 (Business Logic & Validation Rules)
  // =========================================================================

  /**
   * 驗證表單必填欄位
   * @param {Object} record
   * @param {Set<string>|null} validCostCenterSet 「使用中」費用歸屬代碼；null＝取不到主檔，只檢查有沒有填、不檢查存不存在
   * @returns {string[]}
   */
  const validateForm = (record, validCostCenterSet) => {
    const errors = [];

    const companyName = record[F.COMPANY_NAME]?.value || '';
    const paymentWay = record[F.PAY_METHOD]?.value || [];

    if (companyName.length === 0) {
      errors.push('需填寫公司名稱欄位');
    }
    if (paymentWay.length === 0) {
      errors.push('需選擇一種付款方式');
    }
    if (paymentWay.length > 1) {
      errors.push('限選一種付款方式');
    }

    const tableData = record[TRAFFIC.CODE];

    if (!tableData || !tableData.value) {
      console.error(`❌ 表格 ${TRAFFIC.CODE} 不存在或沒有 value 屬性`);
      errors.push(`找不到 ${TRAFFIC.CODE} 表格資料`);
    } else {
      const rows = tableData.value;

      if (!Array.isArray(rows)) {
        console.error(`❌ ${TRAFFIC.CODE} 的 value 不是陣列格式`);
        errors.push(`${TRAFFIC.CODE} 資料格式不正確`);
      } else {
        try {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.value) continue;

            const costValue = row.value[TRAFFIC.COLS.EXPENSE]?.value;

            if (!costValue || costValue.trim() === '') {
              errors.push(`第 ${i + 1} 行請確實填寫費用歸屬`);
              continue;
            }

            const trimmedCode = costValue.trim();

            if (validCostCenterSet && !isValidCode(trimmedCode, validCostCenterSet)) {
              errors.push(`第 ${i + 1} 行的 ${trimmedCode} 不屬於${CURRENT_YEAR}年最新分攤表，請重新填寫`);
            }
          }
        } catch (costCheckError) {
          console.error('❌ 檢查費用歸屬代碼時發生問題:', costCheckError);
          errors.push('檢查費用歸屬代碼時發生問題');
        }
      }
    }

    return errors;
  };

  // =========================================================================
  // SECTION 4: Kintone 事件監聽註冊 (Submit Event Handlers)
  // =========================================================================

  // ── 驗證失敗視窗（字放大、逐條編號、每條一張卡片，年長同仁也看得清楚）──
  const VALIDATION_STYLE_ID = 'pr-validation-popup-style';
  const VALIDATION_CSS = `
    .pr-validation-popup { width: min(760px, 95vw) !important; padding: 28px 28px 24px !important; }
    .pr-validation-popup .swal2-title { font-size: 28px !important; font-weight: 800; color: #b71c1c; }
    .pr-validation-popup .swal2-html-container { margin: 12px 0 0 !important; text-align: left !important; }
    .pr-validation-lead { font-size: 19px; font-weight: 700; color: #333; margin: 0 0 14px; }
    .pr-validation-list { list-style: none; margin: 0; padding: 0; max-height: 55vh; overflow-y: auto; }
    .pr-validation-item { display: flex; gap: 14px; align-items: flex-start; margin: 0 0 12px; padding: 14px 16px;
      background: #fff5f5; border: 1px solid #f5c2c2; border-left: 6px solid #d32f2f; border-radius: 8px; }
    .pr-validation-no { flex: 0 0 34px; height: 34px; border-radius: 50%; background: #d32f2f; color: #fff;
      font-size: 18px; font-weight: 800; line-height: 34px; text-align: center; }
    .pr-validation-text { flex: 1; min-width: 0; line-height: 1.7; color: #1a1a1a; word-break: break-word; }
    .pr-v-head { font-size: 20px; font-weight: 700; color: #1a1a1a; }
    .pr-v-detail { margin-top: 6px; font-size: 17px; color: #555; }
    .pr-v-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 2px; }
    .pr-v-chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 3px 14px; background: #fff;
      border: 2px solid #d32f2f; border-radius: 999px; }
    .pr-v-chip-code { font-family: Consolas, 'Courier New', monospace; font-size: 20px; font-weight: 800; color: #b71c1c; letter-spacing: 0.5px; }
    .pr-v-chip-note { font-size: 15px; color: #666; }
    .pr-v-hint { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #f0b4b4; font-size: 16px; color: #5d4037; }
    .pr-v-hint-tag { display: inline-block; margin-right: 8px; padding: 0 8px; border-radius: 4px; background: #ffe082;
      color: #5d4037; font-size: 14px; font-weight: 800; }
    .pr-hl { background: linear-gradient(transparent 55%, #ffe082 55%); color: #b71c1c; font-weight: 800; padding: 0 2px; }
    .pr-field { color: #1565c0; font-weight: 800; }
    .pr-row { display: inline-block; margin: 0 4px; padding: 0 8px; border-radius: 4px; background: #455a64; color: #fff;
      font-size: 16px; font-weight: 700; line-height: 1.6; vertical-align: 1px; }
    .pr-validation-popup .swal2-confirm { font-size: 20px !important; font-weight: 700; padding: 12px 40px !important; }
  `;

  const escapeValidationText = (text) =>
    String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  /**
   * 一行錯誤文字的重點標示（先跳脫再加標籤）：
   *   **重點** → 黃底紅字；「欄位名」→ 藍色粗體；第 N 行 → 深色小標籤，一眼看出是哪一列。
   * 舊的錯誤訊息沒有 ** 也會自動標出「」與第 N 行。
   */
  const formatValidationInline = (text) =>
    escapeValidationText(text)
      .replace(/\*\*(.+?)\*\*/g, '<mark class="pr-hl">$1</mark>')
      .replace(/「(.+?)」/g, '<b class="pr-field">「$1」</b>')
      .replace(/第 ?(\d+) ?行/g, '<span class="pr-row">第 $1 行</span>');

  // 「AJM1（物流部）」→ 代號大字、括號內小字；不是這種格式就整段當代號
  const formatValidationChip = (text) => {
    const m = /^(.+?)（(.+)）$/.exec(text);
    if (!m) return `<span class="pr-v-chip"><span class="pr-v-chip-code">${escapeValidationText(text)}</span></span>`;
    return `<span class="pr-v-chip"><span class="pr-v-chip-code">${escapeValidationText(m[1])}</span><span class="pr-v-chip-note">${escapeValidationText(m[2])}</span></span>`;
  };

  /**
   * 一條錯誤的內容。錯誤文字可以分行（\n）：
   *   第一行＝結論（大字粗體）；「▸」開頭＝有問題的項目，排成一排紅框標籤；「※」開頭＝怎麼辦（底部提示）；其餘＝說明（灰色小字）。
   * @param {string} err
   * @returns {string} HTML
   */
  const renderValidationError = (err) => {
    const [head, ...rest] = String(err ?? '').split('\n');
    const parts = [`<div class="pr-v-head">${formatValidationInline(head)}</div>`];
    let chips = [];
    const flushChips = () => {
      if (chips.length > 0) parts.push(`<div class="pr-v-chips">${chips.join('')}</div>`);
      chips = [];
    };
    rest.forEach((line) => {
      const t = line.trim();
      if (t.startsWith('▸')) {
        chips.push(formatValidationChip(t.slice(1).trim()));
        return;
      }
      flushChips();
      if (t.startsWith('※')) parts.push(`<div class="pr-v-hint"><span class="pr-v-hint-tag">提示</span>${formatValidationInline(t.slice(1).trim())}</div>`);
      else if (t) parts.push(`<div class="pr-v-detail">${formatValidationInline(t)}</div>`);
    });
    flushChips();
    return parts.join('');
  };

  /**
   * 組驗證失敗視窗的內容：每條錯誤一張卡片、前面有編號，內容依 renderValidationError 標出重點。
   * @param {string[]} errors
   * @returns {string} HTML
   */
  const buildValidationHtml = (errors) => {
    const items = errors
      .map(
        (err, i) =>
          `<li class="pr-validation-item"><span class="pr-validation-no">${i + 1}</span><div class="pr-validation-text">${renderValidationError(err)}</div></li>`,
      )
      .join('');
    return `<p class="pr-validation-lead">請修正以下 ${errors.length} 個問題後，再按一次儲存：</p><ol class="pr-validation-list">${items}</ol>`;
  };

  const showValidationErrors = (title, errors) => {
    if (!document.getElementById(VALIDATION_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = VALIDATION_STYLE_ID;
      style.textContent = VALIDATION_CSS;
      document.head.appendChild(style);
    }
    Swal.fire({
      icon: 'error',
      title,
      html: buildValidationHtml(errors),
      confirmButtonText: '我知道了',
      confirmButtonColor: '#d33',
      customClass: { popup: 'pr-validation-popup' },
    });
  };

  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], async (event) => {
    if (event.record[C.VOID_FIELD]?.value?.length > 0) {
      return event;
    }

    try {
      const record = event.record;
      const allErrors = [];

      // 需要查 API 的兩項檢查互不相依，一次同時送出，縮短按下儲存後的等待
      const costCentersTask = getValidCostCenters()
        .then((set) => ({ set }))
        .catch((loadErr) => {
          console.error('❌ 載入費用歸屬代碼失敗:', loadErr);
          return { set: null, error: '無法取得最新費用歸屬代碼，請稍後再試或聯絡系統管理員' };
        });
      const invoiceTask = checkInvoiceDuplicate(record).catch((e) => {
        console.error('發票號碼檢查失敗:', e);
        return ['發票號碼檢查失敗：請稍後再試或聯絡系統管理員'];
      });
      const [costCenters, invoiceErrors] = await Promise.all([costCentersTask, invoiceTask]);

      if (costCenters.error) allErrors.push(costCenters.error);
      else console.log(`✅ 已載入 ${costCenters.set.size} 筆合法費用歸屬代碼`);

      // 1. 表單基本驗證
      allErrors.push(...validateForm(record, costCenters.set));

      // 2. 發票號碼檢查（上面已同時查好）
      allErrors.push(...invoiceErrors);

      if (allErrors.length > 0) {
        event.error = '儲存失敗';
        showValidationErrors('表單驗證失敗', allErrors);
      }
      return event;
    } catch (generalError) {
      console.error('Submit 事件發生未預期錯誤:', generalError);
      event.error = '處理過程中發生錯誤，請稍後再試一次';
      Swal.fire({
        icon: 'error',
        title: '系統錯誤',
        text: '處理過程中發生錯誤，請稍後再試',
        confirmButtonText: '確定',
      });
      return event;
    }
  });
})();
