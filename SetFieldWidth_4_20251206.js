(() => {
  'use strict';

  // =============================================================================
  // 依欄位內容自動調整欄位寬度（付款方式、申請人、申請人部門、費用所屬人、費用所屬人部門）
  //
  //   詳細頁：畫面畫好後（DELAY_MS）調一次，之後用 MutationObserver 監看內容變化，變了再調（DEBOUNCE_MS 防抖）。
  //   新增／編輯頁：畫面畫好後調一次。
  //
  // 【換頁太快會畸形的防護】（2026-10-22）
  //   原本詳細頁打開後要等 0.5 秒才調寬度、之後觀察者一直監看。使用者在這之前就按「編輯」，
  //   舊的計時器和觀察者會在編輯畫面上拿「詳細頁的記錄」再調一次 → 欄位被壓窄、版面變形；
  //   觀察者也從不斷開，來回切換幾次就疊好幾個。
  //   現在每次換畫面（任何 show 事件）都先「收攤」：畫面序號 +1、斷開觀察者、清掉計時器；
  //   延遲的工作執行前再比對序號，已經不是同一個畫面就放棄。
  //
  //   靜態樣式（min-width、過渡效果、輸入框撐滿）在 payment_request.css 的 .pr-auto-width；
  //   寬度是依內容算出來的，只能留在 JS。
  // =============================================================================

  // 🔧 設定要自動調整的欄位代碼
  //   用到時才讀 window.PR_CONFIG（在 bundle 裡）：這支在 kintone 上就算排在 bundle 前面載入也不會出錯，
  //   事件觸發時所有 JS 都已載入完。
  const autoResizeFields = () => {
    const F = window.PR_CONFIG.FIELDS;
    return [F.PAY_METHOD, F.APPLICANT, F.APPLICANT_ORG, F.EXPENSE_OWNER, F.EXPENSE_OWNER_ORG];
  };

  const DELAY_MS = 500; // 等畫面畫好
  const DEBOUNCE_MS = 300; // 內容連續變化時，停下來才調
  const MIN_WIDTH = 50;
  const MAX_WIDTH = 500;

  // ── 純函式 ───────────────────────────────────────────────────────────────

  /**
   * 欄位要顯示的文字（多值欄位取最長的一個）
   * @param {Object} field record 的欄位 { type, value }
   * @returns {string}
   */
  const fieldContent = (field) => {
    const value = field?.value;
    if (value === null || value === undefined) return '';
    switch (field.type) {
      case 'CHECK_BOX':
        return value.join('');
      case 'MULTI_SELECT':
        return value.reduce((longest, current) => (current.length > longest.length ? current : longest), '');
      case 'USER_SELECT':
      case 'ORGANIZATION_SELECT':
        // 人員／組織：以顯示名稱最長的一筆為準
        return value.reduce((longest, current) => ((current.name || '').length > longest.length ? current.name : longest), '');
      default:
        return value.toString();
    }
  };

  /**
   * 文字 → 寬度（px）。中文字算 2 個單位、英數 1 個單位，每單位 10px，再加 40px 留白，限制在 MIN～MAX。
   * @param {string} content
   * @returns {number}
   */
  const calcWidth = (content) => {
    if (!content || content.trim() === '') return MIN_WIDTH;
    let units = 0;
    for (const char of content) units += /[一-龥]/.test(char) ? 2 : 1;
    return Math.min(Math.max(units * 10 + 40, MIN_WIDTH), MAX_WIDTH);
  };

  // ── 畫面 ─────────────────────────────────────────────────────────────────

  /** 依 record 的值調整每個欄位的寬度；寬度沒變就不重寫（避免連續觸發時畫面一直重排） */
  const applyWidths = (record) => {
    autoResizeFields().forEach((fieldCode) => {
      try {
        if (!record[fieldCode]) return;
        const widthPx = `${calcWidth(fieldContent(record[fieldCode]))}px`;

        const fieldElement = kintone.app.record.getFieldElement(fieldCode);
        if (!fieldElement) return;
        const fieldRow = fieldElement.closest('.row-gaia') || fieldElement.closest('.field-gaia') || fieldElement.closest('.control-gaia');
        if (!fieldRow) return;

        // 實際的輸入控制項容器
        const controlContainer = fieldElement.querySelector('.control-value-gaia') || fieldElement.querySelector('.control-value-content-gaia') || fieldElement;
        controlContainer.classList.add('pr-auto-width');
        if (controlContainer.style.width !== widthPx) {
          controlContainer.style.width = widthPx;
          controlContainer.style.maxWidth = widthPx;
        }

        // 下拉選單：確保選項列表不會被截斷
        fieldElement.querySelectorAll('select').forEach((select) => {
          if (select.style.minWidth !== widthPx) select.style.minWidth = widthPx;
        });
      } catch (error) {
        console.error(`調整欄位 ${fieldCode} 時發生錯誤:`, error);
      }
    });
  };

  // ── 換畫面收攤：序號、觀察者、計時器 ─────────────────────────────────────

  let viewSeq = 0;
  let observer = null;
  let pendingTimer = null;
  let debounceTimer = null;

  /** 換畫面：序號 +1，斷開觀察者、清掉所有還沒執行的計時器。回傳這個畫面的序號 */
  const startView = () => {
    viewSeq += 1;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(pendingTimer);
    clearTimeout(debounceTimer);
    pendingTimer = null;
    debounceTimer = null;
    return viewSeq;
  };

  /** 延遲執行；到時候已經換了畫面就不做 */
  const later = (seq, fn, ms) =>
    setTimeout(() => {
      if (seq === viewSeq) fn();
    }, ms);

  /** 詳細頁：監看內容變化，變了再調（同一時間只會有一個觀察者） */
  const watch = (record, seq) => {
    const targetNode = document.querySelector('.record-detail-gaia');
    if (!targetNode || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver((mutations) => {
      if (seq !== viewSeq) return;
      const changed = mutations.some((m) => m.type === 'characterData' || (m.type === 'childList' && m.addedNodes.length > 0));
      if (!changed) return;
      clearTimeout(debounceTimer);
      debounceTimer = later(seq, () => applyWidths(record), DEBOUNCE_MS);
    });
    observer.observe(targetNode, { childList: true, characterData: true, subtree: true });
  };

  kintone.events.on('app.record.detail.show', (event) => {
    const seq = startView();
    const record = event.record;
    pendingTimer = later(
      seq,
      () => {
        applyWidths(record);
        watch(record, seq);
      },
      DELAY_MS,
    );
    return event;
  });

  kintone.events.on(['app.record.edit.show', 'app.record.create.show'], (event) => {
    const seq = startView();
    const record = event.record;
    pendingTimer = later(seq, () => applyWidths(record), DELAY_MS);
    return event;
  });

  // 離開記錄畫面（回列表、列印、刪除）：只收攤
  kintone.events.on(['app.record.index.show', 'app.record.print.show', 'app.record.detail.delete.submit'], (event) => {
    startView();
    return event;
  });

  window.PR_FIELD_WIDTH = Object.freeze({ autoResizeFields, fieldContent, calcWidth });
})();
