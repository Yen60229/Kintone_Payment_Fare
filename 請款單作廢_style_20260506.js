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
          // 為標籤添加自訂樣式
          voidFieldLabel.style.textAlign = 'center';
          voidFieldLabel.style.color = '#ff0000'; // 紅色文字
          voidFieldLabel.style.fontWeight = 'bold'; // 粗體
          voidFieldLabel.style.fontSize = '18px'; // 放大字體
          //voidFieldLabel.style.backgroundColor = '#ffcccc'; // 淺紅色背景
          voidFieldLabel.style.padding = '5px 10px'; // 內邊距
          voidFieldLabel.style.borderRadius = '5px'; // 圓角
          voidFieldLabel.style.left = '5px';
          voidFieldLabel.style.border = '2px solid #ff0000'; // 紅色邊框

          // 為核取方塊本身添加樣式
          const checkboxElement = voidFieldLabel.querySelector('input[type="checkbox"]');
          if (checkboxElement) {
            checkboxElement.style.transform = 'scale(1.5)'; // 放大核取方塊
            checkboxElement.style.accentColor = '#ff0000'; // 紅色勾選框（現代瀏覽器）
          }
        }
      }, 100);
    }

    return event;
  });
})();
