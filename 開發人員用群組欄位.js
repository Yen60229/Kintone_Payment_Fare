const events = ['app.record.create.show', 'app.record.edit.show', 'app.record.detail.show'];

kintone.events.on(events, function (event) {
  kintone.app.record.setFieldShown(window.PR_CONFIG.FIELDS.DEV_ONLY_DATA, window.PR_CONFIG.ADMIN_USERS.includes(kintone.getLoginUser().code));
  return event;
});
