(() => {
  'use strict';

  // 「帶入的資料_開發人員用」群組欄位只給 ADMIN_USERS 看
  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;
  const C = window.PR_CONFIG;

  KT.on(['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show'], (event) => {
    KT.record().setFieldShown(C.FIELDS.DEV_ONLY_DATA, C.ADMIN_USERS.includes(kintone.getLoginUser().code));
    return event;
  });
})();
