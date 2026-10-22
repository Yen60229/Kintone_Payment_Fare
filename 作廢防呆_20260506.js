(function () {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  const CONFIG = {
    ACTION_NAME: window.PR_CONFIG.ACTIONS.VOID,
    TARGET_STATE: window.PR_CONFIG.STATUS.VOID,
    CONFIRM_TEXT: '作廢',
  };

  function getSafeValue(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj.value !== 'undefined') return obj.value;
    if (typeof obj.name !== 'undefined') return obj.name;
    return '';
  }

  function isVoidAction(event) {
    const actionName = getSafeValue(event.action);
    const nextStatus = getSafeValue(event.nextStatus);
    return actionName === CONFIG.ACTION_NAME || nextStatus === CONFIG.TARGET_STATE;
  }

  KT.on('app.record.detail.process.proceed', function (event) {
    if (!isVoidAction(event)) {
      return event;
    }

    const recordId = event.record.$id ? event.record.$id.value : '';
    const currentStatus = getSafeValue(event.status);
    const nextStatus = getSafeValue(event.nextStatus) || CONFIG.TARGET_STATE;
    const actionName = getSafeValue(event.action) || CONFIG.ACTION_NAME;

    if (typeof Swal === 'undefined') {
      const input = window.prompt(
        `您即將執行「${actionName}」。\n` +
          `目前狀態：${currentStatus}\n` +
          `變更後狀態：${nextStatus}\n` +
          `記錄號碼：${recordId}\n\n` +
          `請輸入「${CONFIG.CONFIRM_TEXT}」以確認：`,
      );
      return input === CONFIG.CONFIRM_TEXT ? event : false;
    }

    return Swal.fire({
      icon: 'warning',
      title: '請確認是否真的要作廢',
      html:
        // 樣式在 payment_request.css（.pr-void-*）
        '<div class="pr-void-confirm">' +
        '<div>您即將執行 <b class="pr-void-action">「' +
        actionName +
        '」</b>。</div>' +
        '<div>目前狀態：<b>' +
        currentStatus +
        '</b></div>' +
        '<div>變更後狀態：<b class="pr-void-next">' +
        nextStatus +
        '</b></div>' +
        '<div>記錄號碼：<b>' +
        recordId +
        '</b></div>' +
        '<br>' +
        '<div>若確認要繼續，請在下方輸入：<b>' +
        CONFIG.CONFIRM_TEXT +
        '</b></div>' +
        '</div>',
      input: 'text',
      inputPlaceholder: '請輸入「作廢」',
      showCancelButton: true,
      confirmButtonText: '送出',
      cancelButtonText: '取消',
      confirmButtonColor: '#d4380d',
      reverseButtons: true,
      focusCancel: true,
      preConfirm: function (value) {
        if (value !== CONFIG.CONFIRM_TEXT) {
          Swal.showValidationMessage('請正確輸入「' + CONFIG.CONFIRM_TEXT + '」才能繼續');
          return false;
        }
        return true;
      },
    }).then(function (result) {
      if (result.isConfirmed) {
        return event;
      }
      return false;
    });
  });
})();
