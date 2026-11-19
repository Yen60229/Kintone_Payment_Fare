(function () {
  'use strict';

  // =============================================================================
  // 使用者主檔快取（window.PR_USERS）
  //
  //   cybozu.com 共通 API /v1/users.json 的全部使用者，同一頁面只抓一次：
  //   - 分頁抓（一次 100 筆，抓到不足一頁為止）；
  //   - 同時有好幾個地方要名單時共用同一個 Promise（不會重複打 API）；
  //   - 抓失敗就清掉，下次再呼叫會重抓。
  //   回傳原始使用者物件陣列（含停用帳號，valid=false），各模組自己過濾／整理，不要改裡面的物件。
  //   使用端：受款人填寫設定（選擇員工）、手動簽核人設定（指定簽核人視窗）。
  //   不依賴 PR_CONFIG；要排在使用端前面。
  // =============================================================================

  const USERS_API = '/v1/users.json';
  const PAGE_SIZE = 100; // /v1/users.json 一次最多 100 筆

  /**
   * 實際分頁抓全部使用者（不經快取）。
   * @param {Function} [api] 預設 kintone.api，測試時注入
   * @returns {Promise<Object[]>}
   */
  const fetchAll = async (api = kintone.api) => {
    const all = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await api(kintone.api.url(USERS_API, true), 'GET', { offset, size: PAGE_SIZE });
      const page = resp?.users || [];
      all.push(...page);
      if (page.length < PAGE_SIZE) return all;
    }
  };

  let usersPromise = null;

  /** 全部使用者（同一頁面共用同一個 Promise；失敗清掉，下次重抓） */
  const loadAll = () => {
    if (!usersPromise) {
      usersPromise = fetchAll()
        .then((list) => Object.freeze(list))
        .catch((err) => {
          usersPromise = null;
          throw err;
        });
    }
    return usersPromise;
  };

  window.PR_USERS = Object.freeze({ PAGE_SIZE, fetchAll, loadAll });
})();
