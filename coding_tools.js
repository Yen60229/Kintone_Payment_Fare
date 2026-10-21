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
        buttonContainer.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-top: 8px;';

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

    // 添加CSS樣式
    const style = document.createElement('style');
    style.innerHTML = `
        /* 黑色背景按鈕 */
        .workflow-button {
          background-color: #2c3e50; /* 黑色背景 */
          color: #fff;
          font-size: 16px;
          font-weight: bold;
          padding: 10px 20px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          margin-left: 10px;
          margin-right: 10px; 
          transition: all 0.3s ease;
        }
  
        /* 金色背景按鈕 */
        .settings-button {
          background-color: #f39c12; /* 金色背景 */
          color: #fff;
          font-size: 16px;
          font-weight: bold;
          padding: 10px 20px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          margin-left: 10px;
          margin-right: 10px; 
          transition: all 0.3s ease;
        }
  
        /* 按鈕 hover 和 active 效果 */
        .workflow-button:hover {
          background-color: #34495e; /* 當滑鼠懸停時變成深灰色 */
        }
  
        .settings-button:hover {
          background-color: #e67e22; /* 當滑鼠懸停時變成亮金色 */
        }
  
        .workflow-button:active {
          background-color: #2c3e50;
          transform: scale(0.98);
        }
  
        .settings-button:active {
          background-color: #d35400;
          transform: scale(0.98);
        }
      `;
    document.head.appendChild(style);

    return event;
  });
})();
