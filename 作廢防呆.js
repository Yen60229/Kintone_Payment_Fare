import { showValidationErrors } from './payment_request_submit.js';

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

// 草稿（未送出）按流程按鈕送出時，「附件」（FIELDS.ATTACHMENT）至少要有一個檔案（2026-11-16，同請款單）。
// 只在 process.proceed 擋，儲存（submit）不擋：可以先存草稿、之後再補上傳。作廢動作不受影響（先判斷 isVoidAction）。
function isDraftMissingAttachment(event) {
  const cfg = window.PR_CONFIG || {};
  const draftStatus = cfg.STATUS && cfg.STATUS.APPLY_START;
  const attField = cfg.FIELDS && cfg.FIELDS.ATTACHMENT;
  if (!draftStatus || !attField) return false;
  if (getSafeValue(event.status) !== draftStatus) return false;
  // 交通費明細有列、且每列憑證種類都是「無」→ 沒有憑證可傳，不檢查附件
  const tbl = cfg.FIELDS.TRAFFIC_TABLE;
  const rows = (event.record && event.record[tbl.CODE] && event.record[tbl.CODE].value) || [];
  const none = cfg.OPTIONS.RECEIPT_TYPE.NONE;
  if (rows.length > 0 && rows.every((r) => r.value[tbl.COLS.RECEIPT_TYPE] && r.value[tbl.COLS.RECEIPT_TYPE].value === none)) return false;
  const field = event.record && event.record[attField];
  return !(field && Array.isArray(field.value) && field.value.length > 0);
}

function blockMissingAttachment() {
  // 欄位代碼是 FIELDS.ATTACHMENT（附件），畫面上的標籤是「發票/憑證」，訊息用使用者看得到的標籤
  const label = '發票/憑證';
  const err = `請上傳**「${label}」**至少一個檔案\n※ 儲存草稿不受限制，可先儲存、之後再上傳，上傳完成後再送出。`;
  // 和存檔防呆同一個視窗樣式（payment_request_submit 提供）；沒載入時才退回簡單提示
  if (typeof showValidationErrors === 'function' && typeof Swal !== 'undefined') {
    showValidationErrors('無法送出', [err], '請修正以下問題後，再按一次流程按鈕：');
  } else {
    window.alert(`請先上傳至少一個「${label}」檔案，才能送出。`);
  }
  return false;
}

/** 入口檔 import '…?install' 時呼叫：註冊事件（載入時只定義函式） */
export const install = () => {
  KT.on('app.record.detail.process.proceed', function (event) {
    if (!isVoidAction(event)) {
      return isDraftMissingAttachment(event) ? blockMissingAttachment() : event;
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
      width: 'auto',
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
};
