(function () {
  'use strict';
  const F = window.PR_CONFIG.FIELDS;

  // 列印時要隱藏的欄位／群組（內部簽核用、除錯用，不印在單據上）
  const PRINT_HIDDEN_FIELDS = [F.SIGN_FLOW_GROUP, F.MANUAL_FLOW, F.PERMISSION_STAFF, F.DEV_ONLY_DATA];

  // 隱藏空白間隔與標籤欄位
  const HIDE_SELECTOR = '.spacer-cybozu:not(#user-js-Expense_Table), .control-label-field-gaia';

  const handlePrintShow = (event) => {
    PRINT_HIDDEN_FIELDS.forEach((field) => kintone.app.record.setFieldShown(field, false));
    document.querySelectorAll(HIDE_SELECTOR).forEach((el) => (el.style.display = 'none'));
    return event;
  };

  kintone.events.on(['app.record.print.show'], handlePrintShow);

  window.PR_PRINT_SHOW = Object.freeze({ PRINT_HIDDEN_FIELDS, HIDE_SELECTOR, handlePrintShow });
})();
