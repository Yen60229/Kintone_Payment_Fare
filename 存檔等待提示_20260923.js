(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // 按下儲存後，各模組要查好幾支 API（驗證、簽核人員、預計付款日…），畫面會靜止 1〜3 秒。
  // 這段期間顯示「儲存中，請稍候…」，避免使用者以為沒按到而重複按、或以為當掉。
  //
  // 何時關掉：
  //   - 存檔被擋下（event.error 有值）→ 最後一個存檔程式關掉
  //   - 其他程式跳出錯誤視窗 → SweetAlert 同一時間只有一個視窗，會直接取代本提示
  //   - 存檔成功 → 換到詳細頁時關掉（存檔成功後的回寫、流程推進期間都還顯示著）
  //   - 保險：超過 SAFETY_CLOSE_MS 還開著就自動關；使用者也可以按 Esc 或點外面關掉
  //     （萬一有程式讓 kintone 中途停止存檔、收尾程式沒被執行，畫面也不會被一直擋住；關掉提示不影響存檔本身）
  // 只關「自己開的」提示（用 POPUP_CLASS 辨識），不會誤關別的程式的視窗。

  const POPUP_CLASS = 'pr-saving-popup';
  const SAFETY_CLOSE_MS = 15000;
  const SUBMIT_EVENTS = ['app.record.create.submit', 'app.record.edit.submit'];
  const LEAVE_EVENTS = ['app.record.detail.show', 'app.record.create.show', 'app.record.edit.show', 'app.record.index.show'];

  let safetyTimer = null;

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

  // 最後一個存檔程式：存檔被擋下時關掉提示（kintone 會在畫面上方顯示 event.error）
  const onSubmitEnd = (event) => {
    if (event.error) closeSaving();
    return event;
  };

  const onLeave = (event) => {
    closeSaving();
    return event;
  };

  KT.on(SUBMIT_EVENTS, onSubmitStart);
  KT.on(LEAVE_EVENTS, onLeave);
  // kintone 依註冊順序執行同一個事件的處理程式。所有模組都在載入時同步註冊，
  // 所以延到下一輪再註冊，這個處理程式就會排在所有存檔程式的最後面。
  setTimeout(() => KT.on(SUBMIT_EVENTS, onSubmitEnd), 0);

  window.PR_SAVING_HINT = Object.freeze({ onSubmitStart, onSubmitEnd, onLeave, closeSaving, POPUP_CLASS, SAFETY_CLOSE_MS });
})();
