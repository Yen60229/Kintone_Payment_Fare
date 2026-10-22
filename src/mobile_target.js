// 手機版打包的第一個模組：告訴共用設定檔（payment_request_config.js）這是手機版，
// PR_KT 會改註冊 mobile.* 事件、改用 kintone.mobile.app.record。必須排在 config 之前。
window.PR_BUILD_TARGET = 'mobile';
