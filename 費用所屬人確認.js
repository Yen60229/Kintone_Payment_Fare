// =============================================================================
// 費用所屬人確認（2026-11-20）
//
//   申請人≠費用所屬人，且費用所屬人不在 C.OWNER_CONFIRM.EXEMPT_GROUP 群組 → 「費用所屬人確認」＝需要；
//   其他（同一人、所屬人在免確認群組、沒填所屬人）＝不需要。
//   流程管理：草稿（未送出）看這個欄位決定先送「費用所屬人確認中」（作業者＝費用所屬人），
//   確認後再照原本的主管流程走（條件和草稿出發的送出動作相同）。
//
//   存檔：payment_request_submit 呼叫 apply()，算好寫進 record；查群組失敗 → 回錯誤擋存檔（不能靜默跳過確認）。
//   畫面：旗標欄位一律鎖住；停在費用所屬人確認中時，申請人、費用所屬人、費用所屬人部門也鎖住。
//   流程按鈕：草稿送出前再算一次，和存檔時的值不同（例：群組名單後來改了）就擋下，請先編輯儲存。
//   只在新增、EDITABLE_STATUSES 與駁回狀態重算；表單作廢不處理。749 表單還沒有這個欄位時整支不動作。
// =============================================================================

const C = window.PR_CONFIG;
const F = C.FIELDS;
const CFG = C.OWNER_CONFIRM;
const OPT = C.OPTIONS.OWNER_CONFIRM;
const KT = window.PR_KT;
const GROUPS_API = '/v1/user/groups.json';

// ── 純函式 ──────────────────────────────────────────────────────────────

/** 這個狀態還能重算（新增畫面沒有狀態欄位值，一律可以） */
const isEditableStatus = (status) => !status || CFG.EDITABLE_STATUSES.includes(status) || String(status).endsWith(CFG.REJECT_SUFFIX);

/** 群組清單裡有沒有免確認群組（代碼或名稱相同都算） */
const inExemptGroup = (groups) => (groups || []).some((g) => g?.code === CFG.EXEMPT_GROUP || g?.name === CFG.EXEMPT_GROUP);

/**
 * 要不要給費用所屬人確認。
 * @param {{ applicantCode?: string, ownerCode?: string, ownerExempt?: boolean }} o
 */
const needConfirm = ({ applicantCode, ownerCode, ownerExempt }) => {
  if (!ownerCode) return false;
  if (ownerCode === applicantCode) return false;
  return !ownerExempt;
};

const flagOf = (need) => (need ? OPT.NEED : OPT.NO_NEED);

const codeOf = (record, code) => record?.[code]?.value?.[0]?.code || '';

const isVoided = (record) => record?.[C.VOID_FIELD]?.value?.length > 0;

// ── 查資料 ──────────────────────────────────────────────────────────────

// 使用者 → 是否在免確認群組：同一頁面記住，查失敗就清掉下次再查
const exemptCache = new Map();

/** 費用所屬人在不在免確認群組；查失敗會 reject（呼叫端決定要不要擋） */
const isOwnerExempt = (userCode) => {
  if (!exemptCache.has(userCode)) {
    const task = kintone.api(kintone.api.url(GROUPS_API, true), 'GET', { code: userCode }).then((resp) => inExemptGroup(resp?.groups));
    exemptCache.set(userCode, task);
    task.catch(() => exemptCache.delete(userCode));
  }
  return exemptCache.get(userCode);
};

/**
 * 依目前的申請人／費用所屬人算出旗標值（同一人或沒填所屬人不打 API）。
 * @returns {Promise<string>} OPT.NEED 或 OPT.NO_NEED
 */
const resolve = async (record) => {
  const applicantCode = codeOf(record, F.APPLICANT);
  const ownerCode = codeOf(record, F.EXPENSE_OWNER);
  if (!needConfirm({ applicantCode, ownerCode, ownerExempt: false })) return OPT.NO_NEED;
  const ownerExempt = await isOwnerExempt(ownerCode);
  return flagOf(needConfirm({ applicantCode, ownerCode, ownerExempt }));
};

// ── 存檔 ────────────────────────────────────────────────────────────────

/**
 * 存檔時呼叫：算好寫進 record。查不到群組回錯誤訊息擋存檔。
 * @param {Object} record event.record
 * @returns {Promise<string[]>}
 */
const apply = async (record) => {
  const field = record?.[F.OWNER_CONFIRM];
  if (!field) return [];
  if (isVoided(record)) return [];
  if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return [];
  try {
    const flag = await resolve(record);
    if (field.value !== flag) {
      field.value = flag;
      window.PR_LOG?.debug?.(`[費用所屬人確認] ${F.OWNER_CONFIRM}＝${flag}`);
    }
    return [];
  } catch (err) {
    console.error('[費用所屬人確認] 查詢費用所屬人群組失敗:', err);
    return [`**無法判斷是否需要費用所屬人確認**\n※ ${err?.message || '讀不到費用所屬人的群組'}；請稍後再試，仍無法存檔請聯絡系統管理員`];
  }
};

// ── 畫面 ────────────────────────────────────────────────────────────────

/** 旗標欄位一律鎖；停在費用所屬人確認中時，申請人與費用所屬人相關欄位也鎖 */
const lockFields = (record) => {
  if (!record?.[F.OWNER_CONFIRM]) return;
  record[F.OWNER_CONFIRM].disabled = true;
  if (record?.[F.STATUS_FIELD]?.value !== C.STATUS.OWNER_CONFIRMING) return;
  CFG.LOCK_FIELDS.forEach((code) => {
    if (record[code]) record[code].disabled = true;
  });
};

// ── 流程按鈕 ────────────────────────────────────────────────────────────

const textOf = (v) => (v && typeof v === 'object' ? v.value : v) || '';

const isVoidAction = (event) => textOf(event.action) === C.ACTIONS.VOID || textOf(event.nextStatus) === C.STATUS.VOID;

const blockProceed = (message) => {
  if (typeof Swal !== 'undefined') {
    Swal.fire({ icon: 'warning', title: '無法送出', text: message, confirmButtonText: '我知道了' });
  } else {
    window.alert(message);
  }
  return false;
};

/**
 * 草稿送出前再算一次：和欄位上的值不同就擋下。
 * @returns {Promise<Object|false>|Object}
 */
const guardProceed = async (event) => {
  const record = event.record;
  if (!record?.[F.OWNER_CONFIRM]) return event;
  if (textOf(event.status) !== C.STATUS.APPLY_START || isVoidAction(event)) return event;
  if (isVoided(record)) return event;
  let flag;
  try {
    flag = await resolve(record);
  } catch (err) {
    console.error('[費用所屬人確認] 送出前查詢群組失敗:', err);
    return blockProceed('無法判斷是否需要費用所屬人確認，請稍後再試；仍無法送出請聯絡系統管理員。');
  }
  if ((record[F.OWNER_CONFIRM].value || '') === flag) return event;
  return blockProceed(`「${F.OWNER_CONFIRM}」應為「${flag}」，和目前存的值不同。\n請先按「編輯」再「儲存」一次，再按流程按鈕送出。`);
};

/** 入口檔 import '…?install' 時呼叫：註冊事件（載入時只定義函式） */
export const install = () => {
  KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
    lockFields(event.record);
    return event;
  });
  KT.on('app.record.detail.process.proceed', guardProceed);
};

export const OWNER_CONFIRM = Object.freeze({
  isEditableStatus,
  inExemptGroup,
  needConfirm,
  flagOf,
  isOwnerExempt,
  resolve,
  apply,
  lockFields,
  guardProceed,
  /** 測試用：清掉群組快取 */
  _reset: () => exemptCache.clear(),
});
