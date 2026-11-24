/*
 * 發票登記 plug-in：事件接線（PC 與手機共用這支）
 *
 * App 自己的 JS 自訂先載入、plug-in 後載入，同一個存檔事件 App 的處理程式先跑完：
 *   event.error 已經有值（App 的檢查擋下了）→ 不查、不登記；
 *   沒有值 → 查發票登記 App＋登記；有問題就設 event.error 擋下。
 * 單據作廢的單存檔時不查、不登記；存檔成功後把它的登記全部作廢（號碼釋出）。
 * 刪除單據 → 登記作廢；詳細頁看到已作廢（流程按鈕作廢）→ 登記作廢；開任何畫面 → 補做之前回填失敗的登記。
 */
(function (PLUGIN_ID) {
  'use strict';

  const Core = window.NXInvoiceRegistry;
  // PC 拿得到 kintone.app.getId()；手機版改用 kintone.mobile.app.getId()
  const tryGet = (fn) => {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  };
  const appId = tryGet(() => kintone.app.getId()) || tryGet(() => kintone.mobile.app.getId());

  // 員工匯款帳號主檔 API（2026-11-24）：一般填單人對主檔沒權限，改走 plug-in 代理（設定頁存的 Administrator API Token，
  //   只在伺服器端帶出、前端看不到）。請款單 JS 用 window.NX_EMPLOYEE_ACCOUNT_API(path, method, params)，格式同 kintone.api。
  //   只開放 GET /k/v1/records、POST /k/v1/record、PUT /k/v1/record（新增、編輯、檢視）。
  const rawConfig = tryGet(() => JSON.parse(kintone.plugin.app.getConfig(PLUGIN_ID)?.config || '{}')) || {};
  if (rawConfig.employeeAccountProxy) {
    const toQuery = (params) => {
      const parts = [];
      Object.entries(params || {}).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach((item, i) => parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(item)}`));
        else if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      });
      return parts.join('&');
    };
    window.NX_EMPLOYEE_ACCOUNT_API = async (path, method, params) => {
      const base = `${location.origin}${path}.json`;
      const isGet = method === 'GET';
      const url = isGet ? `${base}?${toQuery(params)}` : base;
      const [body, status] = await kintone.plugin.app.proxy(PLUGIN_ID, url, method, { 'Content-Type': 'application/json' }, isGet ? {} : params);
      let data = {};
      try {
        data = JSON.parse(body);
      } catch (e) {
        data = {};
      }
      if (status !== 200) throw Object.assign(new Error(data.message || `HTTP ${status}`), { code: data.code, status });
      return data;
    };
  }
  const config = Core.parseConfig(kintone.plugin.app.getConfig(PLUGIN_ID), appId);
  if (!config) {
    console.warn('[發票登記] plug-in 還沒設定，不檢查發票號碼');
    return;
  }
  const loginUser = tryGet(() => kintone.getLoginUser().code) || '';
  const reg = Core.create({ kintone, config, appId, loginUser });

  const both = (types) => types.flatMap((t) => [t, `mobile.${t}`]);

  /** 錯誤視窗：有 SweetAlert 就用（會取代 App 的「儲存中」提示），沒有就用 alert */
  const showErrors = (errors) => {
    const text = errors.join('\n\n');
    if (typeof window.Swal?.fire === 'function') {
      window.Swal.fire({ icon: 'error', title: '發票號碼檢查', text, confirmButtonText: '好', customClass: { htmlContainer: 'nx-invoice-registry-text' } });
    } else {
      alert(text);
    }
  };

  kintone.events.on(both(['app.record.create.show', 'app.record.edit.show']), (event) => {
    reg.renewToken();
    reg.retryPending();
    return event;
  });

  kintone.events.on(both(['app.record.detail.show']), (event) => {
    reg.retryPending();
    reg.reconcile(event.record, event.recordId);
    return event;
  });

  kintone.events.on(both(['app.record.create.submit', 'app.record.edit.submit']), async (event) => {
    if (event.error) return event;
    if (reg.isVoid(event.record)) return event;
    const errors = await reg.checkAndReserve(event.record);
    if (errors.length > 0) {
      event.error = '發票號碼檢查未通過';
      showErrors(errors);
    }
    return event;
  });

  kintone.events.on(both(['app.record.create.submit.success', 'app.record.edit.submit.success']), async (event) => {
    await reg.confirm(event.record, event.recordId);
    return event;
  });

  // 刪除單據：登記作廢（失敗不擋刪除，只記錄；殘留的登記由管理單位處理）
  kintone.events.on(['app.record.detail.delete.submit', 'app.record.index.delete.submit', 'mobile.app.record.detail.delete.submit'], async (event) => {
    await reg.release(event.recordId || event.record?.$id?.value, Core.REASON.DELETED);
    return event;
  });
})(kintone.$PLUGIN_ID);
