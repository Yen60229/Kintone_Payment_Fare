(function () {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

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

  // 發票重複查詢一次最多取回的對方單數
  const INVOICE_DUP_LIMIT = 100;

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

    // 一併取回對方的單號與發票號碼記錄，才能告訴使用者是哪幾個號碼、撞到哪幾張單
    const query = `${F.STATUS_FIELD} not in ("${STATUS.VOID}") and (${invoiceOr})${excludeSelf} limit ${INVOICE_DUP_LIMIT}`;

    const resp = await invoiceCheckApi(
      '/k/v1/records.json',
      'GET',
      { app: APP_ID, query, fields: ['$id', F.RECORD_NO, F.INVOICE_AGG] },
      APP_ID,
    );
    const hits = resp.records || [];
    if (hits.length === 0) return [];

    // 比對本單每個號碼出現在對方哪幾張單（同一號碼撞到多張單，單號用「、」併在同一個標籤）
    const lines = [];
    invoices.forEach((no) => {
      const nos = [];
      hits.forEach((r) => {
        const theirs = (r[F.INVOICE_AGG]?.value || '').split(SEP).map((x) => x.trim());
        const recNo = r[F.RECORD_NO]?.value;
        if (theirs.includes(no) && recNo && !nos.includes(recNo)) nos.push(recNo);
      });
      if (nos.length > 0) lines.push(`▸${no}（${F.RECORD_NO} ${nos.join('、')}）`);
    });

    // 比對不出明細（例如對方欄位讀不到）就退回原本那句話
    if (lines.length === 0) return ['發票號碼重複：已存在相同發票號碼，請更換後再儲存。'];
    return [`發票號碼重複：以下發票號碼已在其他單據出現，請更換後再儲存。\n${lines.join('\n')}`];
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
  //   樣式在 payment_request.css（.pr-validation-*、.pr-v-*）（不經過打包，直接上傳）

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
    Swal.fire({
      icon: 'error',
      title,
      html: buildValidationHtml(errors),
      confirmButtonText: '我知道了',
      confirmButtonColor: '#d33',
      customClass: { popup: 'pr-validation-popup' },
    });
  };

  KT.on(['app.record.create.submit', 'app.record.edit.submit'], async (event) => {
    // 比本程式早跑的存檔檢查（帳號權限設定的必填）留下的訊息，和這裡的檢查結果合成同一個視窗
    const earlierErrors = window.PR_SAVE_ERRORS?.take() || [];

    if (event.record[C.VOID_FIELD]?.value?.length > 0) {
      if (earlierErrors.length > 0) {
        event.error = '儲存失敗';
        showValidationErrors('表單驗證失敗', earlierErrors);
      }
      return event;
    }

    try {
      const record = event.record;
      const allErrors = [...earlierErrors];

      // 交通費明細：重算稅額、高鐵固定值、發票號碼記錄（發票重複檢查要讀整理後的記錄欄位，所以排最前）
      const trafficRules = window.PR_TRAFFIC_RULES;
      if (trafficRules) trafficRules.normalize(record);

      // 需要查 API 的檢查互不相依，一次同時送出，縮短按下儲存後的等待
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
      const scope = window.PR_COST_SCOPE;
      const scopeTask = scope
        ? scope.validate(record).catch((e) => {
            console.error('掛帳單位檢查失敗:', e);
            return ['掛帳單位檢查失敗：請稍後再試或聯絡系統管理員'];
          })
        : Promise.resolve([]);
      const [costCenters, invoiceErrors, scopeErrors] = await Promise.all([costCentersTask, invoiceTask, scopeTask]);

      if (costCenters.error) allErrors.push(costCenters.error);
      else console.log(`✅ 已載入 ${costCenters.set.size} 筆合法費用歸屬代碼`);

      // 1. 表單基本驗證
      allErrors.push(...validateForm(record, costCenters.set));

      // 2. 交通費明細（發票號碼必填／本單重複、計程車的紙本憑證與理由）
      if (trafficRules) allErrors.push(...trafficRules.validate(record));

      // 3. 發票號碼跨單重複（上面已同時查好）
      allErrors.push(...invoiceErrors);

      // 4. 掛帳單位限費用所屬人部內、不可跨部門（排除群組的申請人不檢查）
      allErrors.push(...scopeErrors);

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
