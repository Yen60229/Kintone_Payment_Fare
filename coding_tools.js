(function () {
  'use strict';

  kintone.events.on('app.record.index.show', (event) => {
    // 檢查按鈕是否已存在
    if (document.getElementById('btn-workflow-settings') || document.getElementById('btn-js-settings')) {
      return event;
    }

    // 流程管理按鈕，檢查用戶是否為特定用戶
    if (!window.PR_CONFIG.ADMIN_USERS.includes(kintone.getLoginUser().code)) {
      return event;
    }

    // 使用 setTimeout 確保 batch-download-container 已經載入
    setTimeout(() => {
      // 創建流程管理按鈕
      const workflowButton = document.createElement('button');
      workflowButton.id = 'btn-workflow-settings';
      workflowButton.innerHTML = '流程管理';
      workflowButton.className = 'workflow-button';

      // 設定流程管理按鈕點擊事件
      workflowButton.onclick = () => {
        const appId = kintone.app.getId();
        window.location.href = `/k/admin/app/status?app=${appId}`;
      };

      // JS自定義設定按鈕，限我自己使用
      if (kintone.getLoginUser().code !== window.PR_CONFIG.SUPER_ADMIN) {
        return;
      }

      // 創建JS自定義設定按鈕
      const settingsButton = document.createElement('button');
      settingsButton.id = 'btn-js-settings';
      settingsButton.innerHTML = 'JS自定義設定';
      settingsButton.className = 'settings-button';

      // 設定JS自定義設定按鈕點擊事件
      settingsButton.onclick = () => {
        const appId = kintone.app.getId();
        window.location.href = `/k/admin/app/customize?app=${appId}#/`;
      };

      // 檢查是否存在 batch-download-button
      const headerMenuSpace = kintone.app.getHeaderMenuSpaceElement();
      const batchDownloadButton = document.querySelector('.batch-download-button');

      if (batchDownloadButton) {
        // 找到 batch-download-button 的父容器
        const parentContainer = batchDownloadButton.parentElement;

        // 創建按鈕容器
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'pr-tool-buttons'; // 樣式在 payment_request.css

        buttonContainer.appendChild(settingsButton);
        buttonContainer.appendChild(workflowButton);

        // 將按鈕容器添加到 batch-download-button 的父容器中
        parentContainer.appendChild(buttonContainer);
      } else {
        // 如果不存在下載按鈕，就正常加入到選單列
        headerMenuSpace.appendChild(settingsButton);
        headerMenuSpace.appendChild(workflowButton);
      }
    }, 100); // 延遲 100ms 確保下載容器已載入

    // 樣式在 payment_request.css（.workflow-button／.settings-button）

    return event;
  });
})();
