(function () {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 建單後自動推進流程狀態
  //
  // 移植來源：「內部往來請求表」App 的 `src/重構更新版/13_main_20260622.js`
  //   之 `_advanceToApplying()` 與其草稿補償機制 `_compensateDraftIfNeeded()`。
  //
  // 【解決什麼問題】kintone 新增記錄後，狀態會停在流程的第一個狀態，使用者必須再回到
  //   詳細頁手動按一次動作按鈕才會進到下一關。本模組在 create.submit.success 代打一次
  //   `/k/v1/record/status`，讓單子存檔後直接落在下一個狀態。
  //
  // 【要改狀態／動作名稱看這裡】本檔不放任何設定值，一律取自
  //   `payment_request_config.js` 的 `AUTO_ADVANCE`（單一事實來源）。
  //   前後狀態 ①FROM_STATUS ②TO_STATUS 接 STATUS 註冊表、③ACTION_NAME 接 ACTIONS 註冊表，
  //   改 config 一處即全專案同步。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const CONFIG = C.AUTO_ADVANCE;

  // ── 共用工具 ───────────────────────────────────────────────────────────────

  // VOID_FIELD 是「表單作廢」核取方塊欄位代碼，與 STATUS.VOID 狀態值語意不同（見 config 註解）
  const isVoided = (record) => (record?.[C.VOID_FIELD]?.value?.length || 0) > 0;

  const getStatus = (record) => record?.[F.STATUS_FIELD]?.value || '';

  // 逾時包裝：kintone.api 若因網路／後台問題「既不 resolve 也不 reject」，
  // 會把整個 submit.success 卡住（畫面永久轉圈）。以此把「無回應」轉成明確的 reject。
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}逾時（超過 ${ms / 1000} 秒未回應）`)), ms)),
    ]);

  /**
   * 組出 /k/v1/record/status 的 request body
   * @param {string|number} recordId 記錄 ID
   * @param {string} assigneeCode 作業者帳號 code
   * @returns {Object} PUT body
   */
  const buildStatusBody = (recordId, assigneeCode) => {
    const body = {
      app: C.APPS.PAYMENT,
      id: String(recordId),
      action: CONFIG.ACTION_NAME,
    };
    if (CONFIG.SEND_ASSIGNEE && assigneeCode) {
      body.assignee = assigneeCode;
    }
    return body;
  };

  // ── 流程推進 ───────────────────────────────────────────────────────────────

  /**
   * 將記錄從 FROM_STATUS 推進至 TO_STATUS（失敗時指數退避重試）
   * @param {string|number} recordId 記錄 ID
   * @param {string} assigneeCode 作業者帳號 code（通常為建立者＝登入者）
   * @param {Object} opts
   * @param {number} opts.maxRetries 最多重試次數
   * @param {boolean} opts.silent 失敗時是否靜默不彈窗
   * @returns {Promise<boolean>} 成功回傳 true，失敗回傳 false
   */
  async function advanceStatus(recordId, assigneeCode, { maxRetries = 3, silent = false } = {}) {
    const body = buildStatusBody(recordId, assigneeCode);
    let lastErr;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await withTimeout(kintone.api(kintone.api.url('/k/v1/record/status', true), 'PUT', body), CONFIG.TIMEOUT_MS, '流程推進');
        return true;
      } catch (err) {
        lastErr = err;
        console.warn(`[流程自動推進] 推進失敗，第 ${attempt}/${maxRetries} 次：`, err);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 800 * attempt)); // 指數退避
        }
      }
    }

    console.error('[流程自動推進] 已耗盡重試次數：', lastErr);
    if (!silent && typeof Swal !== 'undefined') {
      await Swal.fire({
        icon: 'error',
        title: '流程推進失敗',
        text: (lastErr && lastErr.message) || String(lastErr),
        confirmButtonText: '確定',
      });
    }
    return false;
  }

  // ── 詳細頁補償 ─────────────────────────────────────────────────────────────

  // sessionStorage 安全存取（無痕／停用時退回 module 變數，至少在本次 page load 內有效）
  const _guardFallback = new Set();
  const guardGet = (key) => {
    try {
      return sessionStorage.getItem(key) === '1';
    } catch (e) {
      return _guardFallback.has(key);
    }
  };
  const guardSet = (key) => {
    try {
      sessionStorage.setItem(key, '1');
    } catch (e) {
      _guardFallback.add(key);
    }
  };
  const guardClear = (key) => {
    try {
      sessionStorage.removeItem(key);
    } catch (e) {
      _guardFallback.delete(key);
    }
  };

  /**
   * 判斷這筆記錄是否該在詳細頁自動補推一次（純函式，供測試）
   * 僅限本人（建立人）觸發，避免他人瀏覽時誤打 API。
   * @param {Object} record kintone 記錄物件
   * @param {string} loginCode 登入者帳號 code
   * @returns {boolean}
   */
  const shouldCompensate = (record, loginCode) => {
    if (!CONFIG.ENABLED || !CONFIG.COMPENSATE_ON_DETAIL) return false;
    if (!record || isVoided(record)) return false;
    if (getStatus(record) !== CONFIG.FROM_STATUS) return false;

    const recordId = String(record.$id?.value || '');
    if (!recordId || recordId === '0') return false;
    if (!loginCode) return false;

    // '建立人' 為 kintone 內建欄位（CREATOR，值是單一物件，沒有 value[0]），非本表單自訂欄位，故不進 PR_CONFIG.FIELDS
    const creatorCode = record['建立人']?.value?.code;

    return Boolean(creatorCode) && loginCode === creatorCode;
  };

  /**
   * 詳細頁補償：處理 create.submit.success 因頁面跳轉導致請求被中斷的情況
   * @param {Object} record kintone 記錄物件
   */
  async function compensateIfNeeded(record) {
    const loginCode = kintone.getLoginUser()?.code || '';
    if (!shouldCompensate(record, loginCode)) return;

    const recordId = String(record.$id.value);
    const creatorCode = record['建立人']?.value?.code || loginCode;

    // ⚠️ 防無限 reload：每筆記錄每個分頁 session 僅自動補償一次。
    //   若上次已嘗試過、reload 後狀態仍停在 FROM_STATUS（推進成功但狀態未前進），
    //   此處直接跳出，不再 reload、不再打 API，避免迴圈把 session 打掛導致登出。
    const guardKey = `${CONFIG.GUARD_PREFIX}${recordId}`;
    if (guardGet(guardKey)) {
      console.warn('[流程自動推進] 已嘗試過補償，跳過以避免重載迴圈。請確認流程管理設定或聯繫管理員。');
      if (typeof Swal !== 'undefined') {
        Swal.fire({ icon: 'warning', title: `此單仍停在「${CONFIG.FROM_STATUS}」，請手動執行「${CONFIG.ACTION_NAME}」`, timer: 4000, showConfirmButton: false });
      }
      return;
    }

    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'info', title: '流程處理中…', timer: 3000, showConfirmButton: false });
    }

    // 先設旗標：即使本次推進「成功但狀態未變」，reload 後也不會再次進入（迴圈最多一圈）
    guardSet(guardKey);

    const ok = await advanceStatus(recordId, creatorCode, { maxRetries: CONFIG.COMPENSATE_MAX_RETRIES, silent: false });

    if (ok) {
      window.location.reload();
    } else {
      // 失敗本來就不 reload（無迴圈風險）；清除旗標，讓使用者下次開啟可重試
      guardClear(guardKey);
    }
  }

  // ── 事件註冊 ───────────────────────────────────────────────────────────────

  // 新建單後自動推進。
  // silent = true：建單後頁面立即跳轉，請求可能被中斷；失敗時靜默，補償交由 detail.show 接手。
  KT.on('app.record.create.submit.success', async (event) => {
    if (!CONFIG.ENABLED || isVoided(event.record)) return event;

    const creatorCode = kintone.getLoginUser()?.code || '';
    await advanceStatus(event.recordId, creatorCode, { maxRetries: CONFIG.CREATE_MAX_RETRIES, silent: true });

    return event;
  });

  // SHOW handler 禁止 async（kintone 不等 Promise），須透過 setTimeout 脫離同步流程後再呼叫
  KT.on('app.record.detail.show', (event) => {
    setTimeout(() => compensateIfNeeded(event.record), 0);
    return event;
  });
})();
