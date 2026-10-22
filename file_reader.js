(function () {
  'use strict';
  function updateAttachmentInList(record, index) {
    // 找到該筆記錄的附件欄位 <td>
    const attachmentCells = document.querySelectorAll('.recordlist-cell-gaia.recordlist-file-gaia');
    if (!attachmentCells || attachmentCells.length <= index) {
      return;
    }
    const attachmentCell = attachmentCells[index];

    // 獲取該筆記錄的附件資料
    const attachmentField = record[window.PR_CONFIG.FIELDS.ATTACHMENT];
    if (!attachmentField || !attachmentField.value || attachmentField.value.length === 0) {
      return;
    }

    // 找到該筆記錄的附件列表 <li>
    const fileItems = attachmentCell.querySelectorAll('.recordlist-file-others-gaia');
    if (!fileItems || fileItems.length === 0) {
      return;
    }

    // 遍歷附件
    attachmentField.value.forEach((file, fileIndex) => {
      if (fileIndex >= fileItems.length) return;

      const fileItem = fileItems[fileIndex];
      const fileName = file.name;
      const fileExt = fileName.split('.').pop().toLowerCase();

      if (fileExt === 'pdf') {
        // 檢查是否已經有預覽按鈕
        if (fileItem.querySelector('.gaia-attachment-file-action-preview')) {
          return;
        }

        // 創建預覽按鈕
        const previewButton = document.createElement('a');
        previewButton.className = 'gaia-attachment-file-action-link gaia-attachment-file-action-preview pr-preview-button'; // 樣式在 styles/desktop.css
        previewButton.title = '預覽';
        previewButton.href = 'javascript:void(0)';

        // 創建放大鏡圖示
        const magnifierIcon = document.createElement('i');
        magnifierIcon.className = 'fa fa-search gaia-attachment-file-action-preview-image';
        previewButton.appendChild(magnifierIcon);

        // 點擊事件
        previewButton.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const fileUrl = await getFileUrl(file.fileKey);
          openInNewTab(fileUrl);
        };

        // 添加按鈕
        fileItem.appendChild(previewButton);
      }
    });
  }

  // 添加簡單的日誌功能，方便除錯
  // function log(message, data) {
  //   console.log(`[附件預覽] ${message}`, data || '');
  // }

  // 更新附件欄位中的文件
  function updateAttachmentField(record) {
    // 找到附件欄位 - 嘗試多種選擇器
    const attachmentFieldEl = kintone.app.record.getFieldElement(window.PR_CONFIG.FIELDS.ATTACHMENT);
    if (!attachmentFieldEl) {
      return;
    }

    // 獲取附件資料
    const attachmentField = record[window.PR_CONFIG.FIELDS.ATTACHMENT];
    if (!attachmentField || !attachmentField.value || attachmentField.value.length === 0) {
      return;
    }

    // 嘗試多種選擇器找到文件列表
    let fileListEl = attachmentFieldEl.querySelector('.attachment-list-itemlist');
    if (!fileListEl) {
      fileListEl = attachmentFieldEl.querySelector('.gaia-attachment-filelist');
    }
    if (!fileListEl) {
      fileListEl = attachmentFieldEl;
    }

    if (!fileListEl) {
      return;
    }

    // 使用多種可能的選擇器來找到文件項目
    let fileItems = fileListEl.querySelectorAll('.attachment-list-item');
    if (!fileItems || fileItems.length === 0) {
      fileItems = fileListEl.querySelectorAll('.gaia-attachment-file');
    }
    if (!fileItems || fileItems.length === 0) {
      fileItems = fileListEl.querySelectorAll('li');
    }

    if (!fileItems || fileItems.length === 0) {
      return;
    }

    // 遍歷所有檔案
    attachmentField.value.forEach((file, index) => {
      if (index >= fileItems.length) {
        return;
      }

      const fileItem = fileItems[index];
      const fileName = file.name;
      const fileExt = fileName.split('.').pop().toLowerCase();

      // 僅為 PDF 檔案添加預覽按鈕
      if (fileExt === 'pdf') {
        // 檢查是否已有預覽按鈕
        if (fileItem.querySelector('.gaia-attachment-file-action-preview')) {
          return;
        }

        // 嘗試多種選擇器找到適合添加按鈕的容器
        let fileInfoContainer = fileItem.querySelector('.attachment-list-item-gaia');
        if (!fileInfoContainer) {
          fileInfoContainer = fileItem.querySelector('.gaia-attachment-file-fileinformation');
        }
        if (!fileInfoContainer) {
          fileInfoContainer = fileItem.querySelector('a').parentNode;
        }
        if (!fileInfoContainer) {
          fileInfoContainer = fileItem;
        }

        const previewButton = document.createElement('a');
        previewButton.className = 'gaia-attachment-file-action-link gaia-attachment-file-action-preview pr-preview-button'; // 樣式在 styles/desktop.css
        previewButton.title = '預覽';
        previewButton.href = 'javascript:void(0)';

        // 創建放大鏡圖示
        const magnifierIcon = document.createElement('i');
        magnifierIcon.className = 'fa fa-search gaia-attachment-file-action-preview-image';
        previewButton.appendChild(magnifierIcon);

        // 添加點擊事件
        previewButton.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const fileUrl = await getFileUrl(file.fileKey);
          openInNewTab(fileUrl);
        };

        // 將按鈕添加到檔案資訊容器
        fileInfoContainer.appendChild(previewButton);
      }
    });
  }

  // 下載 Kintone 附件
  async function getFileUrl(fileKey) {
    try {
      const response = await fetch(kintone.api.url('/k/v1/file.json', true) + `?fileKey=${fileKey}`, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!response.ok) {
        throw new Error('無法下載檔案');
      }

      const blob = await response.blob();
      const fileUrl = URL.createObjectURL(blob);
      return fileUrl;
    } catch (error) {
      console.error('無法取得檔案 URL:', error);
      return null;
    }
  }

  // **彈出視窗顯示預覽**
  function openInNewTab(fileUrl) {
    if (!fileUrl) {
      alert('無法預覽檔案，請稍後再試！');
      return;
    }

    // 直接在新分頁開啟
    window.open(fileUrl, '_blank');
  }

  // 處理詳細頁面的顯示
  kintone.events.on('app.record.detail.show', function (event) {
    // 首次更新
    setTimeout(() => {
      updateAttachmentField(event.record);
    }, 500);

    // 再次嘗試更新，以防DOM延遲載入
    setTimeout(() => {
      updateAttachmentField(event.record);
    }, 1500);

    // 設置 MutationObserver
    setTimeout(() => {
      // 確認當前仍在詳細頁面
      if (!window.isKintoneDetailPage) return;

      const targetNode = document.body;
      const config = { childList: true, subtree: true };

      const callback = function (mutationsList) {
        // 確認當前仍在詳細頁面
        if (!window.isKintoneDetailPage) return;

        for (const mutation of mutationsList) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            // kintone.app.record.get() 不接受 REST API 風格的 {app,id}+callback 參數；
            // 它是同步 API，只回傳「目前畫面上這筆記錄」的內容，原寫法的 callback 從未被呼叫過。
            if (kintone.app.record.getId()) {
              const resp = kintone.app.record.get();
              updateAttachmentField(resp.record);
            }
          }
        }
      };

      // 保存 observer 到全局變數以便後續清除
      if (window.attachmentObserver) {
        window.attachmentObserver.disconnect();
      }

      window.attachmentObserver = new MutationObserver(callback);
      window.attachmentObserver.observe(targetNode, config);
    }, 2000);

    return event;
  });

  kintone.events.on('app.record.index.show', function (event) {
    // 設定延遲確保 DOM 載入完成
    setTimeout(() => {
      event.records.forEach((record, index) => {
        updateAttachmentInList(record, index);
      });
    }, 1000);

    return event;
  });
})();
