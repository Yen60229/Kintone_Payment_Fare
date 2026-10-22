(() => {
  'use strict';

  const F = window.PR_CONFIG.FIELDS;
  const BUTTON_ID = 'same-applicant-btn';

  // 取得申請人資訊：fullName 為「員工代碼 中文姓名」（受款人＝申請人，723 是「員工姓名」欄位）
  function getApplicantInfo(record) {
    const applicant = record[F.APPLICANT]?.value?.[0];

    if (!applicant) {
      return { error: '請先填寫申請人' };
    }

    const applicantCode = applicant.code || '';
    const applicantName = applicant.name || '';

    // 提取括號內的中文姓名
    const nameMatch = applicantName.match(/\((.+?)\)/);
    const chineseName = nameMatch ? nameMatch[1] : applicantName;

    return {
      code: applicantCode,
      name: chineseName,
      fullName: `${applicantCode} ${chineseName}`.trim(),
    };
  }

  // 建立按鈕元素
  function createSameApplicantButton() {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = '同申請人';
    button.type = 'button';

    // 設定按鈕樣式（白色背景）
    button.style.cssText = `
      background-color: #3498db; 
      color: #ffffff;              
      border: 1px solid #2980b9; 
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;           
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.3s ease;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-top: 30px;
    `;

    // 滑鼠懸停效果
    button.addEventListener('mouseenter', function () {
      this.style.backgroundColor = '#2980b9';
      this.style.borderColor = '#21618c';
      this.style.boxShadow = '0 3px 6px rgba(0,0,0,0.2)';
    });

    button.addEventListener('mouseleave', function () {
      this.style.backgroundColor = '#3498db';
      this.style.borderColor = '#2980b9';
      this.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    });

    // 按鈕點擊事件
    button.addEventListener('click', function () {
      // 取得當前記錄
      const record = kintone.app.record.get().record;
      const applicantInfo = getApplicantInfo(record);

      if (applicantInfo.error) {
        // 顯示錯誤訊息
        alert(applicantInfo.error);
        return;
      }

      // 將 fullName 寫入受款人欄位
      record[F.PAYEE].value = applicantInfo.fullName;

      // 更新記錄
      kintone.app.record.set({ record: record });

      // 顯示成功訊息（可選）
      const successMsg = document.createElement('span');
      successMsg.textContent = ' ✓ 已複製';
      successMsg.style.cssText = `
        color: #28a745;
        margin-left: 10px;
        font-size: 12px;
        animation: fadeOut 2s forwards;
      `;

      // 添加淡出動畫
      const style = document.createElement('style');
      style.textContent = `
        @keyframes fadeOut {
          0% { opacity: 1; }
          70% { opacity: 1; }
          100% { opacity: 0; }
        }
      `;
      document.head.appendChild(style);

      button.parentNode.appendChild(successMsg);
      setTimeout(() => {
        successMsg.remove();
      }, 2000);
    });

    return button;
  }

  // 在編輯和新增頁面顯示按鈕（已掛過就不重複掛）
  function handleShow(event) {
    const spaceElement = kintone.app.record.getSpaceElement(window.PR_CONFIG.SPACES.APPLY_BUTTON);
    if (spaceElement && !document.getElementById(BUTTON_ID)) {
      spaceElement.appendChild(createSameApplicantButton());
    }
    return event;
  }

  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], handleShow);

  window.PR_PAYEE = Object.freeze({ getApplicantInfo, handleShow });
})();
