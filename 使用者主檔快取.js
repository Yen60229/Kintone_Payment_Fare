// =============================================================================
// 使用者主檔快取
//
//   cybozu.com 共通 API /v1/users.json 的全部使用者，同一頁面只抓一次：
//   - 分頁抓（一次 100 筆，抓到不足一頁為止）；
//   - 同時有好幾個地方要名單時共用同一個 Promise（不會重複打 API）；
//   - 抓失敗就清掉，下次再呼叫會重抓。
//   回傳原始使用者物件陣列（含停用帳號，valid=false），各模組自己過濾／整理，不要改裡面的物件。
//   使用端：手動簽核人設定（指定簽核人視窗）。（受款人選擇員工 2026-11-23 起改讀員工匯款帳號主檔，不再用這裡）
//   不依賴 PR_CONFIG。
//
// ES module：使用端 import { loadAll } from './使用者主檔快取.js'（只提供函式，沒有 install）。
// =============================================================================

const USERS_API = '/v1/users.json';
export const PAGE_SIZE = 100; // /v1/users.json 一次最多 100 筆

/**
 * 實際分頁抓全部使用者（不經快取）。
 * @param {Function} [api] 預設 kintone.api，測試時注入
 * @returns {Promise<Object[]>}
 */
export const fetchAll = async (api = kintone.api) => {
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
export const loadAll = () => {
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
