(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 費用所屬人是部長 → 單位部長_支店長 依費用歸屬帶入（2026-10-29）
  //
  //   費用所屬人在費用所屬人部門的職稱是部長時，簽核流程主檔排的部長不適用（本人或同層），
  //   改依明細第一個費用歸屬代碼查費用歸屬主檔（APPS.COST_CENTER）：
  //     (1) 代碼的所屬部門（往上爬）是 DIRECTOR_BY_COST_CENTER.HQ_CODE（總公司）的所屬部門之一
  //         → 用該代碼那筆的「部門部長」群組（沒設就用總公司同部門那筆的）
  //     (2) 其他 → 用 DEFAULT_CODE（事業本部）的「部門部長」群組
  //   群組成員去掉費用所屬人本人後寫入單位部長_支店長（只剩本人＝清空，部長本人不簽自己）。
  //   同一代碼有好幾筆（例如總公司由三個部共用）→ 取費用所屬人的部那一筆。
  //
  //   存檔：payment_request_submit 呼叫 apply()，查不到資料時擋存檔（錯誤一起顯示）。
  //   畫面：費用歸屬變更、簽核人員排完（signing_personnel_manager 呼叫 refresh()）時先帶給使用者看。
  //   手動設定簽核流程、表單作廢不處理；送出後（不在可編輯狀態）不重算。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const CFG = C.DIRECTOR_BY_COST_CENTER;
  const CC = C.REF_FIELDS.COST_CENTER;
  const TRAFFIC = F.TRAFFIC_TABLE;

  // ── 純函式 ──────────────────────────────────────────────────────────────

  /** 明細裡第一個有填的費用歸屬代碼（大寫）；都沒填回空字串 */
  const firstCostCenter = (record) => {
    const rows = record?.[TRAFFIC.CODE]?.value || [];
    for (const row of rows) {
      const code = String(row?.value?.[TRAFFIC.COLS.EXPENSE]?.value || '').trim().toUpperCase();
      if (code) return code;
    }
    return '';
  };

  /** 這個狀態還能重算（新增畫面沒有狀態欄位值，一律可以） */
  const isEditableStatus = (status) => !status || CFG.EDITABLE_STATUSES.includes(status) || String(status).endsWith(CFG.REJECT_SUFFIX);

  /**
   * 決定要用哪個部長群組。
   * @param {Object} p
   * @param {string} p.code 費用歸屬代碼（大寫）
   * @param {string} p.ownerDept 費用所屬人部門往上爬到的部（共用代碼時選哪一筆）
   * @param {Array<{code:string, dept:string, groups:string[]}>} p.records 費用歸屬主檔的記錄（至少含 code、HQ_CODE、DEFAULT_CODE）
   * @param {Object<string,string|null>} [p.parentOf] 組織代碼 → 上一層
   * @param {Function} p.resolveDeptOfOrg PR_COST_SCOPE.resolveDeptOfOrg
   * @returns {{ groups: string[], source: 'HQ'|'DEFAULT', dept: string }|null} 代碼不在主檔 → null
   */
  const pickDirectorGroups = ({ code, ownerDept, records, parentOf = {}, resolveDeptOfOrg }) => {
    const ofCode = (c) => records.filter((r) => r.code === c);
    const own = ofCode(code);
    if (own.length === 0) return null;
    const picked = own.find((r) => r.dept === ownerDept) || own[0];

    const hq = ofCode(CFG.HQ_CODE);
    const hqDepts = new Set(hq.map((r) => r.dept).filter(Boolean));
    const top = picked.dept ? resolveDeptOfOrg(picked.dept, parentOf, hqDepts) : '';
    if (top && hqDepts.has(top)) {
      const groups = picked.groups.length > 0 ? picked.groups : hq.find((r) => r.dept === top)?.groups || [];
      return { groups, source: 'HQ', dept: top };
    }
    const fallback = ofCode(CFG.DEFAULT_CODE);
    return { groups: [...new Set(fallback.flatMap((r) => r.groups))], source: 'DEFAULT', dept: picked.dept };
  };

  /** 兩組使用者是否相同（只看代碼、不看順序） */
  const sameUsers = (a, b) => {
    const key = (list) => (list || []).map((u) => u?.code).filter(Boolean).sort().join(',');
    return key(a) === key(b);
  };

  // ── 查資料 ──────────────────────────────────────────────────────────────

  /** 費用所屬人在費用所屬人部門的職稱；查不到該部門回空字串 */
  const fetchOwnerTitle = async (ownerCode, ownerOrgCode) => {
    const resp = await kintone.api(kintone.api.url('/v1/user/organizations.json', true), 'GET', { code: ownerCode });
    const hit = (resp.organizationTitles || []).find((o) => o.organization?.code === ownerOrgCode);
    return hit?.title?.name || '';
  };

  /** 費用歸屬主檔裡這幾個代碼（使用中）的所屬部門與部長群組 */
  const fetchCostCenterRecords = async (codes) => {
    const list = [...new Set(codes)].map((c) => `"${c}"`).join(',');
    const resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: C.APPS.COST_CENTER,
      fields: [CC.CODE, CC.DEPT, CC.DIRECTOR_GROUP],
      query: `${CC.CODE} in (${list}) and ${CC.IN_USE} in ("使用中") limit 500`,
    });
    return (resp.records || []).map((r) => ({
      code: String(r[CC.CODE]?.value || '').trim().toUpperCase(),
      dept: r[CC.DEPT]?.value?.[0]?.code || '',
      groups: (r[CC.DIRECTOR_GROUP]?.value || []).map((g) => g.code).filter(Boolean),
    }));
  };

  /** 群組（角色）成員，分頁抓完 */
  const fetchGroupUsers = async (groupCode) => {
    const users = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const resp = await kintone.api(kintone.api.url('/v1/group/users.json', true), 'GET', { code: groupCode, size: 100, offset });
      const page = resp.users || [];
      users.push(...page.map((u) => ({ code: u.code, name: u.name })));
      if (page.length < 100) break;
    }
    return users;
  };

  /** 費用所屬人部門往上爬到的部；組織樹或主檔拿不到就用部門自己（只影響共用代碼選哪一筆） */
  const ownerDeptOf = async (ownerOrgCode) => {
    try {
      const scope = window.PR_COST_SCOPE;
      const cc = window.PR_COST_CENTER;
      await cc.ensureLoaded();
      const parentOf = await scope.loadOrgParents();
      return { dept: scope.resolveDeptOfOrg(ownerOrgCode, parentOf, new Set(Object.values(cc.getDeptsOfCode()).flat())), parentOf };
    } catch (err) {
      console.warn('[部長簽核帶入] 取得組織樹失敗，改用費用所屬人部門本身判斷:', err);
      return { dept: ownerOrgCode, parentOf: {} };
    }
  };

  /**
   * 算出單位部長_支店長應該是誰。
   * @param {Object} record
   * @returns {Promise<{ users: Array }|{ skip: string }>} skip：不處理（不是部長、沒填費用歸屬、代碼不在主檔…）
   */
  const resolveDirector = async (record) => {
    if (record?.[F.MANUAL_FLOW]?.value?.length > 0) return { skip: 'manual' };
    const owner = record?.[F.EXPENSE_OWNER]?.value?.[0];
    const ownerOrg = record?.[F.EXPENSE_OWNER_ORG]?.value?.[0];
    if (!owner?.code || !ownerOrg?.code) return { skip: 'no-owner' };
    const code = firstCostCenter(record);
    if (!code) return { skip: 'no-cost-center' };

    const title = await fetchOwnerTitle(owner.code, ownerOrg.code);
    if (title !== CFG.OWNER_TITLE) return { skip: 'not-director' };

    const [records, { dept: ownerDept, parentOf }] = await Promise.all([
      fetchCostCenterRecords([code, CFG.HQ_CODE, CFG.DEFAULT_CODE]),
      ownerDeptOf(ownerOrg.code),
    ]);
    const plan = pickDirectorGroups({ code, ownerDept, records, parentOf, resolveDeptOfOrg: window.PR_COST_SCOPE.resolveDeptOfOrg });
    if (!plan) return { skip: 'unknown-cost-center' }; // 代碼不在主檔：存檔驗證另有錯誤訊息
    if (plan.groups.length === 0) throw new Error(`費用歸屬主檔沒有設定「${CC.DIRECTOR_GROUP}」（${plan.source === 'HQ' ? code : CFG.DEFAULT_CODE}）`);

    const members = (await Promise.all(plan.groups.map(fetchGroupUsers))).flat();
    const seen = new Set([owner.code]); // 部長本人不簽自己
    const users = members.filter((u) => u?.code && !seen.has(u.code) && seen.add(u.code));
    console.log(`[部長簽核帶入] ${code} → ${plan.source === 'HQ' ? '總公司' : '預設'}部長群組 ${plan.groups.join('、')}：`, users.map((u) => u.code));
    return { users };
  };

  // ── 存檔／畫面 ────────────────────────────────────────────────────────────

  /**
   * 存檔時呼叫：算好就寫進 record（值沒變不寫）。查不到資料回錯誤訊息擋存檔。
   * @param {Object} record event.record
   * @returns {Promise<string[]>}
   */
  const apply = async (record) => {
    if (record?.[C.VOID_FIELD]?.value?.length > 0) return [];
    if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return [];
    try {
      const result = await resolveDirector(record);
      if (result.skip) return [];
      const field = record[CFG.TARGET_FIELD];
      if (field && !sameUsers(field.value, result.users)) field.value = result.users;
      return [];
    } catch (err) {
      console.error('[部長簽核帶入] 帶入單位部長失敗:', err);
      return [`費用所屬人是部長，**無法帶入「${CFG.TARGET_FIELD}」**\n※ ${err?.message || '請稍後再試'}；仍無法存檔請聯絡系統管理員`];
    }
  };

  // 連續觸發時只讓最後一次的結果寫回畫面
  let refreshSeq = 0;

  /**
   * 畫面上先帶給使用者看（非同步，寫回用 get()/set()）。失敗只記 log，存檔時 apply() 會再算並擋下。
   * @param {Object} [snapshot] 變更事件的 event.record（change 事件裡不能同步 get()）；沒給就讀畫面
   */
  const refresh = (snapshot) => {
    const seq = ++refreshSeq;
    const record = snapshot || KT.record().get().record;
    if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return Promise.resolve();
    return resolveDirector(record)
      .then((result) => {
        if (result.skip || seq !== refreshSeq) return;
        const current = KT.record().get();
        if (current.record[F.MANUAL_FLOW]?.value?.length > 0 || !current.record[CFG.TARGET_FIELD]) return;
        current.record[CFG.TARGET_FIELD].value = result.users;
        KT.record().set(current);
        KT.record().setFieldShown(CFG.TARGET_FIELD, result.users.length > 0);
      })
      .catch((err) => console.warn('[部長簽核帶入] 畫面帶入單位部長失敗（存檔時會再試）:', err));
  };

  const changeEvents = [TRAFFIC.CODE, TRAFFIC.COLS.EXPENSE].flatMap((code) => [`app.record.create.change.${code}`, `app.record.edit.change.${code}`]);
  KT.on(changeEvents, (event) => {
    refresh(event.record);
    return event;
  });

  window.PR_DIRECTOR_BY_CC = Object.freeze({ firstCostCenter, isEditableStatus, pickDirectorGroups, resolveDirector, apply, refresh });
})();
