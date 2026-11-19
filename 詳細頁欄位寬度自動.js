(() => {
  'use strict';

  // =============================================================================
  // 詳細頁欄位寬度自動（2026-11-12，只進桌面版；取代原本的 SetFieldWidth_4_20251206.js）
  //
  //   kintone 依表單設計時拉的寬度，在每個欄位的外框（.control-gaia）用 inline style 寫死寬度（px）。
  //   詳細頁只顯示文字，選項按鈕、核取方塊、短文字常常留一大段空白；拉太窄的又會把長文字擠成好幾行。
  //   進詳細頁時，把主表每個欄位的外框加上 pr-fit-width，由 payment_request.css 改成 width: auto（依內容縮放）。
  //
  //   不動：子表格、群組、關聯記錄清單、狀態（自己有版面）；標籤、空白欄位（不在 record 裡）。
  //   新增／編輯頁不動（輸入框保留設計時的寬度）；kintone 換畫面會重畫 DOM，class 不會帶過去。
  //   找不到欄位元素（欄位隱藏、沒放在版面上、kintone 改版）就略過，不丟錯。
  // =============================================================================

  const KT = window.PR_KT;

  const FIT_CLASS = 'pr-fit-width';
  const CONTAINER_SELECTOR = '.control-gaia';
  // 這些型別有自己的版面，不改寬度
  const SKIP_TYPES = Object.freeze(['SUBTABLE', 'GROUP', 'REFERENCE_TABLE', 'CATEGORY', 'STATUS', 'STATUS_ASSIGNEE', '__ID__', '__REVISION__']);

  /** 要調整的欄位代碼（純函式）：record 裡型別不在 SKIP_TYPES 的欄位 */
  const targetFieldCodes = (record) =>
    Object.keys(record || {}).filter((code) => {
      const type = record[code]?.type;
      return Boolean(type) && !SKIP_TYPES.includes(type);
    });

  /**
   * 把每個欄位的外框加上 pr-fit-width。
   * @returns {number} 加了幾個
   */
  const applyFitWidth = (record) => {
    let count = 0;
    targetFieldCodes(record).forEach((code) => {
      try {
        const el = KT.record().getFieldElement(code);
        const box = el && typeof el.closest === 'function' ? el.closest(CONTAINER_SELECTOR) : null;
        if (!box) return;
        box.classList.add(FIT_CLASS);
        count += 1;
      } catch (err) {
        console.error(`[詳細頁欄位寬度自動] 欄位 ${code} 調整失敗:`, err);
      }
    });
    return count;
  };

  KT.on('app.record.detail.show', (event) => {
    applyFitWidth(event.record);
    return event;
  });

  window.PR_DETAIL_FIT_WIDTH = Object.freeze({ targetFieldCodes, applyFitWidth, FIT_CLASS, SKIP_TYPES });
})();
