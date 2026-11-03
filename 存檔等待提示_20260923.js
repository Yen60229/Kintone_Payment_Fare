(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // 按下儲存後，各模組要查好幾支 API（驗證、簽核人員、預計付款日…），畫面會靜止 1〜3 秒。
  // 這段期間顯示「儲存中，請稍候…」，避免使用者以為沒按到而重複按、或以為當掉。
  //
  // 何時關掉：
  //   - 存檔被擋下（event.error 有值）→ 最後一個存檔程式關掉
  //   - kintone 欄位設定的必填沒填（例如「發票/憑證」附件）→ 最後一個存檔程式關掉
  //     （kintone 自己的必填檢查在所有存檔程式跑完之後才做，擋下時不會再觸發任何事件，提示會一直卡著）
  //   - 其他程式跳出錯誤視窗 → SweetAlert 同一時間只有一個視窗，會直接取代本提示
  //   - 存檔成功 → 換到詳細頁時關掉（存檔成功後的回寫、流程推進期間都還顯示著）
  //   - 保險：超過 SAFETY_CLOSE_MS 還開著就自動關；使用者也可以按 Esc 或點外面關掉
  //     （萬一有程式讓 kintone 中途停止存檔、收尾程式沒被執行，畫面也不會被一直擋住；關掉提示不影響存檔本身）
  // 只關「自己開的」提示（用 POPUP_CLASS 辨識），不會誤關別的程式的視窗。

  const POPUP_CLASS = 'pr-saving-popup';
  const SAFETY_CLOSE_MS = 15000;
  const SUBMIT_EVENTS = ['app.record.create.submit', 'app.record.edit.submit'];
  const LEAVE_EVENTS = ['app.record.detail.show', 'app.record.create.show', 'app.record.edit.show', 'app.record.index.show'];
  const FORM_EVENTS = ['app.record.create.show', 'app.record.edit.show', 'mobile.app.record.create.show', 'mobile.app.record.edit.show'];

  let safetyTimer = null;
  let requiredFields = null; // { main: [欄位代碼], tables: { 子表格代碼: [欄位代碼] } }；開新增／編輯畫面時讀一次

  const isEmptyValue = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

  /** 表單欄位設定（/k/v1/app/form/fields 的 properties）→ 必填欄位清單（含子表格裡的必填欄位） */
  const parseRequiredFields = (properties) => {
    const main = [];
    const tables = {};
    Object.values(properties || {}).forEach((f) => {
      if (f.type === 'SUBTABLE') {
        const codes = Object.values(f.fields || {})
          .filter((sub) => sub.required)
          .map((sub) => sub.code);
        if (codes.length > 0) tables[f.code] = codes;
      } else if (f.required) {
        main.push(f.code);
      }
    });
    return { main, tables };
  };

  /** 有沒有 kintone 欄位設定的必填欄位是空的（還沒讀到欄位設定就當作沒有） */
  const hasMissingRequired = (record) => {
    if (!requiredFields || !record) return false;
    if (requiredFields.main.some((code) => record[code] && isEmptyValue(record[code].value))) return true;
    return Object.entries(requiredFields.tables).some(([table, codes]) =>
      (record[table]?.value || []).some((row) => codes.some((code) => row?.value?.[code] && isEmptyValue(row.value[code].value))),
    );
  };

  const loadRequiredFields = () => {
    if (requiredFields || typeof kintone?.api !== 'function') return;
    let appId;
    try {
      appId = KT.app().getId();
    } catch (e) {
      return;
    }
    kintone
      .api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: appId })
      .then((resp) => {
        requiredFields = parseRequiredFields(resp.properties);
      })
      .catch((err) => console.warn('存檔等待提示：讀不到欄位設定，必填沒填時改靠保險計時關閉', err));
  };

  const getSwal = () => (typeof window.Swal?.fire === 'function' ? window.Swal : null);

  const isOurPopupOpen = () => {
    const swal = getSwal();
    return !!swal?.isVisible?.() && !!swal.getPopup?.()?.classList.contains(POPUP_CLASS);
  };

  const closeSaving = () => {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (isOurPopupOpen()) getSwal().close();
  };

  const openSaving = () => {
    const swal = getSwal();
    if (!swal) return;
    swal.fire({
      title: '儲存中，請稍候…',
      text: '正在檢查資料與簽核流程，完成後會自動跳轉',
      allowOutsideClick: true,
      allowEscapeKey: true,
      showConfirmButton: false,
      customClass: { popup: POPUP_CLASS },
      didOpen: () => swal.showLoading(),
    });
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(closeSaving, SAFETY_CLOSE_MS);
  };

  // 第一個存檔程式：本檔在 src/index.js 排在共用設定檔之後、其他模組之前，所以最先執行
  const onSubmitStart = (event) => {
    openSaving();
    return event;
  };

  // 最後一個存檔程式：存檔被擋下時關掉提示（kintone 會在畫面上方顯示 event.error）；
  // kintone 欄位設定的必填沒填也關掉（接著 kintone 會在欄位上標示必填，存檔不會成功）
  const onSubmitEnd = (event) => {
    if (event.error || hasMissingRequired(event.record)) closeSaving();
    return event;
  };

  const onLeave = (event) => {
    closeSaving();
    if (FORM_EVENTS.includes(event?.type)) loadRequiredFields();
    return event;
  };

  KT.on(SUBMIT_EVENTS, onSubmitStart);
  KT.on(LEAVE_EVENTS, onLeave);
  // kintone 依註冊順序執行同一個事件的處理程式。所有模組都在載入時同步註冊，
  // 所以延到下一輪再註冊，這個處理程式就會排在所有存檔程式的最後面。
  setTimeout(() => KT.on(SUBMIT_EVENTS, onSubmitEnd), 0);

  window.PR_SAVING_HINT = Object.freeze({
    onSubmitStart,
    onSubmitEnd,
    onLeave,
    closeSaving,
    parseRequiredFields,
    hasMissingRequired,
    setRequiredFields: (v) => {
      requiredFields = v;
    },
    POPUP_CLASS,
    SAFETY_CLOSE_MS,
  });
})();
