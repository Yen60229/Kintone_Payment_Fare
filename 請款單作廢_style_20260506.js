(() => {
  'use strict';

  // 詳細頁面顯示事件
  kintone.events.on('app.record.detail.show', (event) => {
    const record = event.record;
    // STATUS.VOID 是比對的狀態值
    if (record[window.PR_CONFIG.FIELDS.STATUS_FIELD]?.value !== window.PR_CONFIG.STATUS.VOID) {
      return event;
    }

    // 檢查作廢欄位是否存在且被勾選
    if (record[window.PR_CONFIG.VOID_FIELD] && record[window.PR_CONFIG.VOID_FIELD].value && record[window.PR_CONFIG.VOID_FIELD].value.length > 0) {
      // 延遲執行以確保 DOM 已載入
      setTimeout(() => {
        // 尋找特殊情形欄位的標籤元素
        const voidFieldLabel = kintone.app.record.getFieldElement(window.PR_CONFIG.VOID_FIELD);

        if (voidFieldLabel) {
          // 標籤與核取方塊放大、紅框（樣式在 payment_request.css 的 .pr-void-field）
          voidFieldLabel.classList.add('pr-void-field');
        }
      }, 100);
    }

    return event;
  });
})();
