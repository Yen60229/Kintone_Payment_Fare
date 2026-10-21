(() => {
  'use strict';

  const F = window.PR_CONFIG.FIELDS;

  // 🔧 設定要自動調整的欄位代碼
  const autoResizeFields = [F.PAY_METHOD, F.APPLICANT, F.APPLICANT_ORG, F.EXPENSE_OWNER, F.EXPENSE_OWNER_ORG];

  // 📐 固定左邊界的自動寬度調整
  function fixedLeftAutoResize(record) {
    autoResizeFields.forEach((fieldCode) => {
      try {
        // 從 record 取得欄位值
        const field = record[fieldCode];
        if (!field) {
          return;
        }

        // 取得欄位內容
        let content = '';

        // 處理不同類型的欄位
        if (field.type === 'CHECK_BOX') {
          content = field.value ? field.value.join('') : '';
        } else if (field.type === 'MULTI_SELECT') {
          // 多選：找出最長的選項
          if (field.value && field.value.length > 0) {
            content = field.value.reduce((longest, current) => {
              return current.length > longest.length ? current : longest;
            }, '');
          } else {
            content = '';
          }
        } else if (field.type === 'DROP_DOWN' || field.type === 'RADIO_BUTTON') {
          content = field.value || '';
        } else if (field.type === 'SINGLE_LINE_TEXT' || field.type === 'MULTI_LINE_TEXT') {
          content = field.value || '';
        } else if (field.type === 'USER_SELECT' || field.type === 'ORGANIZATION_SELECT') {
          // 人員／組織：以顯示名稱最長的一筆為準
          content = (field.value || []).reduce((longest, current) => ((current.name || '').length > longest.length ? current.name : longest), '');
        } else if (field.type === 'NUMBER') {
          content = field.value ? field.value.toString() : '';
        } else {
          content = field.value ? field.value.toString() : '';
        }

        // 計算寬度
        let width;
        const minWidth = 50; // 最小寬度
        const maxWidth = 500; // 最大寬度

        if (!content || content.trim() === '') {
          width = minWidth;
        } else {
          let charCount = 0;
          for (let i = 0; i < content.length; i++) {
            // 判斷是否為中文字元（給予更多寬度）
            const char = content[i];
            if (/[\u4e00-\u9fa5]/.test(char)) {
              charCount += 2; // 中文字元算 2 個單位
            } else {
              charCount += 1; // 英數字算 1 個單位
            }
          }

          // 寬度 = 字元數 × 基礎像素 + padding
          width = Math.min(Math.max(charCount * 10 + 40, minWidth), maxWidth);
        }

        const widthPx = width + 'px';

        // 透過 kintone API 取得欄位元素
        const fieldElement = kintone.app.record.getFieldElement(fieldCode);

        if (fieldElement) {
          // 找到欄位的最外層容器
          const fieldRow =
            fieldElement.closest('.row-gaia') ||
            fieldElement.closest('.field-gaia') ||
            fieldElement.closest('.control-gaia');

          if (fieldRow) {
            // 保持原始的定位方式，不改變 display 屬性
            // 只調整寬度，讓欄位保持在原位

            // 找到實際的輸入控制項容器
            const controlContainer =
              fieldElement.querySelector('.control-value-gaia') ||
              fieldElement.querySelector('.control-value-content-gaia') ||
              fieldElement;

            // 設定控制項容器的寬度
            if (controlContainer) {
              controlContainer.style.width = widthPx;
              controlContainer.style.minWidth = 'auto';
              controlContainer.style.maxWidth = widthPx;
              controlContainer.style.transition = 'width 0.3s ease'; // 加入平滑過渡效果
            }

            // 調整內部的實際輸入元素
            const inputElements = fieldElement.querySelectorAll('input, select, textarea');
            inputElements.forEach((input) => {
              input.style.width = '100%';
              input.style.boxSizing = 'border-box';
            });

            // 對於下拉選單，確保選項列表不會被截斷
            const selectElements = fieldElement.querySelectorAll('select');
            selectElements.forEach((select) => {
              select.style.minWidth = widthPx;
            });
          }
        } else {
        }
      } catch (error) {
        console.error(`調整欄位 ${fieldCode} 時發生錯誤:`, error);
      }
    });
  }

  // 建立觀察者以處理動態內容變化
  function createObserver(record) {
    const observer = new MutationObserver((mutations) => {
      let shouldResize = false;

      mutations.forEach((mutation) => {
        if (mutation.type === 'characterData' || (mutation.type === 'childList' && mutation.addedNodes.length > 0)) {
          shouldResize = true;
        }
      });

      if (shouldResize) {
        // 使用防抖動，避免過度調整
        clearTimeout(window.resizeTimeout);
        window.resizeTimeout = setTimeout(() => {
          fixedLeftAutoResize(record);
        }, 300);
      }
    });

    // 開始觀察
    const targetNode =
      document.querySelector('.record-detail-gaia') || document.querySelector('.gaia-argoui-app-index-index');

    if (targetNode) {
      observer.observe(targetNode, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    return observer;
  }

  window.PR_FIELD_WIDTH = Object.freeze({ autoResizeFields });

  // 在詳細頁面顯示時執行
  kintone.events.on('app.record.detail.show', (event) => {
    const record = event.record;

    // 使用較短的延遲時間，確保 DOM 已經渲染
    setTimeout(() => {
      fixedLeftAutoResize(record);
      // 建立觀察者以處理動態變化
      createObserver(record);
    }, 500);

    return event;
  });

  // 在編輯頁面也可以使用（選擇性）
  kintone.events.on(['app.record.edit.show', 'app.record.create.show'], (event) => {
    const record = event.record;

    setTimeout(() => {
      fixedLeftAutoResize(record);
    }, 500);

    return event;
  });

  // 清理函數
  kintone.events.on(['app.record.detail.delete.submit', 'app.record.index.show'], (event) => {
    // 清理計時器
    if (window.resizeTimeout) {
      clearTimeout(window.resizeTimeout);
    }
    return event;
  });
})();
