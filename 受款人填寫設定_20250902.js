(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

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
    // 樣式（含滑鼠懸停效果）在 payment_request.css
    button.className = 'pr-same-applicant-btn';

    // 按鈕點擊事件
    button.addEventListener('click', function () {
      // 取得當前記錄
      const record = KT.record().get().record;
      const applicantInfo = getApplicantInfo(record);

      if (applicantInfo.error) {
        // 顯示錯誤訊息
        alert(applicantInfo.error);
        return;
      }

      // 將 fullName 寫入受款人欄位
      record[F.PAYEE].value = applicantInfo.fullName;

      // 更新記錄
      KT.record().set({ record: record });

      // 顯示成功訊息（淡出動畫在 payment_request.css 的 .pr-copied-msg）
      const successMsg = document.createElement('span');
      successMsg.textContent = ' ✓ 已複製';
      successMsg.className = 'pr-copied-msg';

      button.parentNode.appendChild(successMsg);
      setTimeout(() => {
        successMsg.remove();
      }, 2000);
    });

    return button;
  }

  // 在編輯和新增頁面顯示按鈕（已掛過就不重複掛）
  function handleShow(event) {
    const spaceElement = KT.record().getSpaceElement(window.PR_CONFIG.SPACES.APPLY_BUTTON);
    if (spaceElement && !document.getElementById(BUTTON_ID)) {
      spaceElement.appendChild(createSameApplicantButton());
    }
    return event;
  }

  // 新增時受款人空白且申請人有值 → 自動帶入（沒填申請人就不動、不跳 alert；已有值不覆蓋）
  function autoFillPayee(event) {
    const record = event.record;
    if (!record[F.PAYEE] || String(record[F.PAYEE].value || '').trim()) return event;
    const info = getApplicantInfo(record);
    if (!info.error) record[F.PAYEE].value = info.fullName;
    return event;
  }

  KT.on('app.record.create.show', (event) => handleShow(autoFillPayee(event)));
  KT.on('app.record.edit.show', handleShow);

  window.PR_PAYEE = Object.freeze({ getApplicantInfo, handleShow, autoFillPayee });
})();
