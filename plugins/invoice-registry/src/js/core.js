/*
 * 發票登記 plug-in：核心邏輯（不碰畫面、不註冊事件；desktop.js 接事件，測試直接呼叫）
 *
 * 判斷重複「只看發票登記 App」：請款單有記錄權限，一般人看不到別人的單，用使用者身分去查請款 App 查不準；
 * 登記 App 只放發票號碼、App ID、記錄編號，所有人都看得到。
 *
 * 存檔時（checkAndReserve）：
 *   1. 查登記表：號碼已被別張單登記（不論哪個 App）→ 擋下「發票號碼已使用過」，不說是哪張單（IT 自己查登記表）。
 *      例外：還沒回填記錄編號、是自己建的、超過 TTL 的登記＝自己之前沒存成的單留下的 → 作廢後換本單。
 *      已被管理單位改成作廢＝是、但號碼還沒換成 VOID- 的 → 補換號碼後換本單（IT 手動作廢只要把作廢改成是）。
 *   2. 登記（發票號碼值不可重複）：兩張單同時存同一個號碼，kintone 只讓一筆成功，另一張擋下請再按一次。
 * 存檔成功（confirm）：這次登記的回填記錄編號；本單不再用的號碼作廢（單據作廢＝全部作廢）。
 *   失敗會重試；仍失敗就記在瀏覽器（localStorage），下次打開任何畫面再補。
 * 刪除單據（release）：本單登記全部作廢（單據刪除）。
 * 詳細頁（reconcile）：單據已作廢（例如用流程按鈕作廢）但還有登記 → 作廢（單據作廢）。
 *
 * 登記不刪除、只作廢（留作紀錄）：發票號碼搬到「原發票號碼」，發票號碼改成 VOID-<登記記錄編號>（值不可重複才釋放得出來），
 *   作廢＝是、作廢原因；更新時帶版本號，兩個人同時作廢同一筆時第二個人會失敗（→ 請再按一次儲存）。
 * 一筆登記屬於哪張單＝App ID＋記錄編號；記錄編號還空著時用儲存鍵（每次開畫面換一個）認自己。
 */
(function (root) {
  'use strict';

  const DEFAULT_REGISTRY_FIELDS = Object.freeze({
    INVOICE: 'invoice_number',
    OWNER_APP: 'app_id',
    OWNER_ID: 'request_record_number',
    TOKEN: 'storage_key',
    CREATED: '建立時間',
    ORIGINAL: 'original_invoice_number',
    VOIDED: 'voided',
    VOID_REASON: 'void_reason',
  });
  const VOID_YES = '是';
  const VOID_PREFIX = 'VOID-';
  const REASON = Object.freeze({ RECORD_VOID: '單據作廢', CHANGED: '改號或刪列', STALE: '舊登記清除', DELETED: '單據刪除' });
  const DEFAULT_TTL_MINUTES = 10;
  const SEP = ' / ';
  const CHUNK = 100; // REST 一次最多新增／更新 100 筆；query 的 in 也分批
  const PAGE = 500;
  const MAX_PAGES = 20;
  const RACE_CODES = /CB_VA01|GAIA_CO02|重複|duplicate/i; // 值重複／版本號不符（被別人搶先）
  const RETRY_DELAYS = [500, 1500]; // 存檔成功後回填失敗的重試間隔（毫秒）

  const HELP = '有其他問題請洽管理單位詢問';
  const MSG = Object.freeze({
    USED: (nos) => `發票號碼已使用過：${nos.join('、')}\n※ 請確認後更換；${HELP}`,
    RACE: `發票號碼剛被其他單據登記，請再按一次儲存\n※ ${HELP}`,
    DOWN: `目前無法檢查發票號碼，請稍後再按一次儲存\n※ 仍無法存檔請洽管理單位詢問`,
  });

  const norm = (s) => String(s).trim().toUpperCase();
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const chunks = (list) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
  const splitList = (v) =>
    (Array.isArray(v) ? v : String(v || '').split(/[\n,，、]/))
      .map((s) => String(s).trim())
      .filter(Boolean);

  /**
   * plug-in 設定（kintone.plugin.app.getConfig 的結果，資料放在 config 這個鍵的 JSON）→ 正規化；沒設定好回 null
   * 舊版設定的 others／label／recordNoField 不再使用，讀到也忽略。
   * @param {{ config?: string }} raw
   * @param {number|string} appId 本 App
   */
  const parseConfig = (raw, appId) => {
    let c;
    try {
      c = JSON.parse(raw?.config || 'null');
    } catch (e) {
      return null;
    }
    if (!c || !/^\d+$/.test(String(c.registryApp || '')) || !c.self?.invoiceField) return null;
    const ttl = Number(c.pendingTtlMinutes);
    return {
      registryApp: String(c.registryApp),
      fields: { ...DEFAULT_REGISTRY_FIELDS, ...Object.fromEntries(Object.entries(c.fields || {}).filter(([, v]) => String(v || '').trim())) },
      pendingTtlMs: (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MINUTES) * 60000,
      self: {
        app: String(appId),
        invoiceField: String(c.self.invoiceField).trim(),
        statusField: String(c.self.statusField || '').trim(),
        voidStatuses: splitList(c.self.voidStatuses),
        voidCheckField: String(c.self.voidCheckField || '').trim(),
      },
    };
  };

  /** 「 / A / B / 」→ 大寫去重的號碼 */
  const invoicesOfValue = (value) => [...new Set(String(value || '').split(SEP).map(norm).filter(Boolean))];

  const defaultStorage = () => {
    try {
      return root.localStorage || null;
    } catch (e) {
      return null;
    }
  };

  /**
   * @param {{ kintone: Object, config: Object, appId: number|string, loginUser?: string, now?: () => number,
   *           newToken?: () => string, storage?: Storage|null, sleep?: (ms: number) => Promise<void> }} opts
   */
  const create = ({ kintone, config, appId, loginUser = '', now = () => Date.now(), newToken, storage = defaultStorage(), sleep }) => {
    const R = config.fields;
    const REG = config.registryApp;
    const THIS_APP = String(appId);
    const self = config.self;
    const makeToken = newToken || (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const PENDING_KEY = `nx-invoice-registry:pending:${REG}:${THIS_APP}`;
    let token = makeToken();

    const regApi = (method, params) => kintone.api(kintone.api.url('/k/v1/records', true), method, { app: REG, ...params });

    const invoicesOf = (record) => invoicesOfValue(record?.[self.invoiceField]?.value);
    const isVoid = (record) => {
      if (self.voidCheckField && record?.[self.voidCheckField]?.value?.length > 0) return true;
      return !!self.statusField && self.voidStatuses.includes(record?.[self.statusField]?.value);
    };

    /** 登記表依 $id 分頁讀完 */
    const fetchAll = async (cond) => {
      const out = [];
      let lastId = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const resp = await regApi('GET', { query: `(${cond}) and $id > ${lastId} order by $id asc limit ${PAGE}` });
        const list = resp?.records || [];
        out.push(...list);
        if (list.length < PAGE) return out;
        lastId = list[list.length - 1].$id.value;
      }
      throw new Error(`發票登記 App 符合條件的記錄超過 ${PAGE * MAX_PAGES} 筆，沒有讀完`);
    };
    const ACTIVE = `${R.VOIDED} not in ("${VOID_YES}")`;
    const OF_THIS_APP = `${R.OWNER_APP} = ${Number(THIS_APP)}`;

    const rowsOfInvoices = async (invoices) => {
      const rows = [];
      for (const part of chunks(invoices)) {
        rows.push(...(await fetchAll(`${R.INVOICE} in (${part.map((v) => `"${esc(v)}"`).join(', ')})`)));
      }
      return rows;
    };
    /** 登記作廢（不刪除）：號碼搬到原發票號碼、發票號碼改 VOID-<記錄編號>、作廢＝是；已作廢的保留原本的原因；帶版本號 */
    const releaseRows = async (rows, reason) => {
      for (const part of chunks(rows)) {
        await regApi('PUT', {
          records: part.map((row) => {
            const already = row[R.VOIDED]?.value === VOID_YES;
            return {
              id: row.$id.value,
              ...(row.$revision?.value ? { revision: row.$revision.value } : {}),
              record: {
                [R.INVOICE]: { value: `${VOID_PREFIX}${row.$id.value}` },
                [R.ORIGINAL]: { value: (already && row[R.ORIGINAL]?.value) || row[R.INVOICE].value },
                [R.VOIDED]: { value: VOID_YES },
                [R.VOID_REASON]: { value: (already && row[R.VOID_REASON]?.value) || reason },
              },
            };
          }),
        });
      }
    };
    const creatorOf = (row) => Object.values(row || {}).find((f) => f && f.type === 'CREATOR')?.value?.code || '';
    const isFresh = (row, at) => {
      const created = Date.parse(row[R.CREATED]?.value || '');
      return !Number.isFinite(created) || at - created < config.pendingTtlMs;
    };
    const isMine = (row, selfId) => {
      if ((row[R.OWNER_APP]?.value || '') !== THIS_APP) return false;
      const owner = row[R.OWNER_ID]?.value || '';
      return owner ? owner === selfId : row[R.TOKEN]?.value === token;
    };

    /**
     * 存檔時：查登記表 → 登記。回傳錯誤訊息（空陣列＝可以存）。
     * @param {Object} record event.record
     */
    const checkAndReserve = async (record) => {
      const invoices = invoicesOf(record);
      if (invoices.length === 0) return [];
      const selfId = record?.$id?.value ? String(record.$id.value) : '';
      try {
        const at = now();
        const rowOf = new Map((await rowsOfInvoices(invoices)).map((row) => [norm(row[R.INVOICE].value), row]));
        const used = [];
        const stale = [];
        for (const no of invoices) {
          const row = rowOf.get(no);
          if (!row || isMine(row, selfId)) continue;
          const voidedByAdmin = row[R.VOIDED]?.value === VOID_YES;
          const myLeftover = !row[R.OWNER_ID]?.value && !!loginUser && creatorOf(row) === loginUser && !isFresh(row, at);
          if (voidedByAdmin || myLeftover) stale.push(row);
          else used.push(no);
        }
        if (used.length > 0) return [MSG.USED(used)];

        if (stale.length > 0) await releaseRows(stale, REASON.STALE);
        const toAdd = invoices.filter((no) => !rowOf.has(no) || stale.includes(rowOf.get(no)));
        for (const part of chunks(toAdd)) {
          await regApi('POST', {
            records: part.map((no) => ({
              [R.INVOICE]: { value: no },
              [R.OWNER_APP]: { value: THIS_APP },
              [R.OWNER_ID]: { value: selfId },
              [R.TOKEN]: { value: token },
            })),
          });
        }
        return [];
      } catch (err) {
        console.error('[發票登記] 登記失敗:', err);
        if (RACE_CODES.test(`${err?.code || ''} ${err?.message || ''} ${JSON.stringify(err?.errors || {})}`)) return [MSG.RACE];
        return [MSG.DOWN];
      }
    };

    // ── 回填失敗的補救：記在瀏覽器，下次打開畫面再補 ──
    const readPending = () => {
      try {
        const list = JSON.parse(storage?.getItem(PENDING_KEY) || '[]');
        return Array.isArray(list) ? list : [];
      } catch (e) {
        return [];
      }
    };
    const writePending = (list) => {
      try {
        if (list.length > 0) storage?.setItem(PENDING_KEY, JSON.stringify(list));
        else storage?.removeItem(PENDING_KEY);
      } catch (e) {
        /* 瀏覽器不給存就算了 */
      }
    };
    const claimRows = async (rows, id) => {
      for (const part of chunks(rows)) {
        await regApi('PUT', { records: part.map((row) => ({ id: row.$id.value, record: { [R.OWNER_ID]: { value: id } } })) });
      }
    };

    /** 存檔成功後做一次：回填記錄編號、作廢不再用的號碼 */
    const confirmOnce = async (record, id, tok) => {
      const voided = isVoid(record);
      const keep = voided ? [] : invoicesOf(record);
      const rows = await fetchAll(`${OF_THIS_APP} and ${ACTIVE} and ((${R.TOKEN} = "${esc(tok)}" and ${R.OWNER_ID} = "") or ${R.OWNER_ID} = "${esc(id)}")`);
      const drop = rows.filter((row) => !keep.includes(norm(row[R.INVOICE].value)));
      await claimRows(rows.filter((row) => !drop.includes(row) && !row[R.OWNER_ID]?.value), id);
      if (drop.length > 0) await releaseRows(drop, voided ? REASON.RECORD_VOID : REASON.CHANGED);
    };

    /**
     * 存檔成功後：失敗重試；仍失敗記到瀏覽器待補。不丟例外、不影響存檔。
     */
    const confirm = async (record, recordId) => {
      const id = String(recordId || record?.$id?.value || '');
      const tok = token;
      token = makeToken();
      if (!id) return;
      for (let attempt = 0; ; attempt++) {
        try {
          await confirmOnce(record, id, tok);
          return;
        } catch (err) {
          if (attempt >= RETRY_DELAYS.length) {
            console.error('[發票登記] 存檔後回填登記失敗，下次打開畫面再補（不影響存檔）:', err);
            writePending([...readPending().filter((p) => p.token !== tok), { id, token: tok }]);
            return;
          }
          await wait(RETRY_DELAYS[attempt]);
        }
      }
    };

    /** 補做之前回填失敗的登記（只補記錄編號；不再用的號碼等下次存檔再作廢）。不丟例外。 */
    const retryPending = async () => {
      const pending = readPending();
      if (pending.length === 0) return;
      const left = [];
      for (const p of pending) {
        try {
          const rows = await fetchAll(`${OF_THIS_APP} and ${ACTIVE} and ${R.TOKEN} = "${esc(p.token)}" and ${R.OWNER_ID} = ""`);
          await claimRows(rows, String(p.id));
        } catch (err) {
          console.error('[發票登記] 補回填登記失敗:', err);
          left.push(p);
        }
      }
      writePending(left);
    };

    /**
     * 本單的登記全部作廢（刪除單據、單據已作廢）。回傳 true＝成功（或本來就沒有）。不丟例外。
     */
    const release = async (recordId, reason) => {
      const id = String(recordId || '');
      if (!id) return true;
      try {
        const rows = await fetchAll(`${OF_THIS_APP} and ${ACTIVE} and ${R.OWNER_ID} = "${esc(id)}"`);
        if (rows.length > 0) await releaseRows(rows, reason);
        return true;
      } catch (err) {
        console.error('[發票登記] 作廢登記失敗:', err);
        return false;
      }
    };

    /** 詳細頁：單據已作廢（流程按鈕作廢等）→ 登記作廢。沒作廢就什麼都不做（不打 API）。 */
    const reconcile = async (record, recordId) => {
      if (!isVoid(record)) return true;
      return release(recordId || record?.$id?.value, REASON.RECORD_VOID);
    };

    return {
      invoicesOf,
      isVoid,
      checkAndReserve,
      confirm,
      retryPending,
      release,
      reconcile,
      renewToken: () => {
        token = makeToken();
      },
      token: () => token,
    };
  };

  root.NXInvoiceRegistry = Object.freeze({ parseConfig, create, invoicesOfValue, DEFAULT_REGISTRY_FIELDS, DEFAULT_TTL_MINUTES, VOID_PREFIX, REASON, MSG });
})(typeof window !== 'undefined' ? window : globalThis);
