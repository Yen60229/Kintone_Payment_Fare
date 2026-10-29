(() => {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 掛帳單位（費用歸屬）限費用所屬人部內
  //
  //   (1) 每一列費用歸屬代碼的「所屬部門」（費用歸屬主檔 REF_FIELDS.COST_CENTER.DEPT）
  //       必須包含費用所屬人部門沿組織樹往上爬到的那個部。
  //       同一代碼可在主檔建多筆、各屬不同部門（例如總公司代碼由好幾個部共用）→ 任一個部符合就算部內
  //   (2) 不能跨部門：所有列的代碼要有共同的部
  //   (5) 申請人與費用所屬人要同部門：申請部門、費用所屬人部門各自往上爬到的部要相同（2026-10-29）
  //   (3) 申請人在 COST_SCOPE.EXEMPT_GROUP 群組內 → 不受 (1)(2)(5) 限制
  //   (4) 同上的人新增單時，自動切成「手動設定簽核流程」，簽核人員自選（signing_personnel_manager 接手）
  //
  //   create.show／edit.show 時先查申請人在不在排除群組，結果存在模組變數（isExempt() 直接讀）；
  //   存檔驗證由 payment_request_submit 呼叫 validate()，錯誤一起顯示。
  // =============================================================================

  const C = window.PR_CONFIG;
  const F = C.FIELDS;
  const SCOPE = C.COST_SCOPE;
  const TREE = SCOPE.ORG_TREE;
  const TRAFFIC = F.TRAFFIC_TABLE;

  // ── 申請人是否在排除群組 ─────────────────────────────────────────────────

  // 目前畫面上申請人的判斷結果：{ code, exempt }；切換申請人或換頁就重查
  let exemptState = null;
  let exemptPromise = null;

  const applicantCodeOf = (record) => record?.[F.APPLICANT]?.value?.[0]?.code || kintone.getLoginUser().code;

  /** 群組清單裡有沒有排除群組（代碼或名稱相同都算） */
  const inExemptGroup = (groups) => (groups || []).some((g) => g.code === SCOPE.EXEMPT_GROUP || g.name === SCOPE.EXEMPT_GROUP);

  /**
   * 查使用者是否在排除群組，結果存起來。查不到（API 失敗）當作「不在」——寧可多擋，不可漏擋。
   * @param {string} userCode
   * @returns {Promise<boolean>}
   */
  const ensureExempt = (userCode) => {
    if (exemptState && exemptState.code === userCode) return Promise.resolve(exemptState.exempt);
    if (exemptPromise && exemptPromise.code === userCode) return exemptPromise.promise;
    const promise = kintone
      .api(kintone.api.url('/v1/user/groups.json', true), 'GET', { code: userCode })
      .then((resp) => inExemptGroup(resp.groups))
      .catch((err) => {
        console.error('[費用歸屬部門限制] 查詢群組失敗，當作不在排除名單:', err);
        return false;
      })
      .then((exempt) => {
        exemptState = { code: userCode, exempt };
        exemptPromise = null;
        return exempt;
      });
    exemptPromise = { code: userCode, promise };
    return promise;
  };

  /** 目前申請人是否在排除群組（create.show／edit.show 算好的結果；還沒算好回 false） */
  const isExempt = () => Boolean(exemptState?.exempt);

  // ── 組織樹：組織代碼 → 上一層組織代碼 ────────────────────────────────────

  let orgParentsMemory = null;
  let orgParentsPromise = null;

  const readCache = () => {
    try {
      const raw = localStorage.getItem(TREE.CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed.ts || Date.now() - parsed.ts > TREE.CACHE_TTL_MS) return null;
      return parsed.data;
    } catch (e) {
      return null; // localStorage 不能用（隱私模式等）就當沒有快取
    }
  };

  const writeCache = (data) => {
    try {
      localStorage.setItem(TREE.CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch (e) {
      // 存不進去只是下次要重抓
    }
  };

  /**
   * 全公司組織表。先看記憶體、再看 localStorage，都沒有才分頁呼叫組織 API。
   * @returns {Promise<Object<string,string|null>>}
   */
  const loadOrgParents = () => {
    if (orgParentsMemory) return Promise.resolve(orgParentsMemory);
    const cached = readCache();
    if (cached) {
      orgParentsMemory = cached;
      return Promise.resolve(cached);
    }
    if (!orgParentsPromise) {
      orgParentsPromise = (async () => {
        const parentOf = {};
        for (let page = 0; page < TREE.MAX_PAGES; page++) {
          const resp = await kintone.api(kintone.api.url('/v1/organizations.json', true), 'GET', { size: TREE.PAGE_SIZE, offset: page * TREE.PAGE_SIZE });
          const orgs = resp.organizations || [];
          orgs.forEach((org) => {
            parentOf[org.code] = org.parentCode || null;
          });
          if (orgs.length < TREE.PAGE_SIZE) break;
        }
        orgParentsMemory = parentOf;
        writeCache(parentOf);
        return parentOf;
      })().finally(() => {
        orgParentsPromise = null;
      });
    }
    return orgParentsPromise;
  };

  /**
   * 沿組織樹往上爬，爬到的第一個「費用歸屬主檔裡出現過的所屬部門」就是答案（含自己）。
   * 爬到頂都沒有（例如該部門沒有自己的費用歸屬代碼）就回組織自己的代碼。
   * @param {string} orgCode
   * @param {Object<string,string|null>} parentOf
   * @param {Set<string>} deptSet
   * @returns {string}
   */
  const resolveDeptOfOrg = (orgCode, parentOf, deptSet) => {
    let current = orgCode;
    for (let depth = 0; depth < TREE.MAX_DEPTH && current; depth++) {
      if (deptSet.has(current)) return current;
      current = parentOf[current] || null;
    }
    return orgCode;
  };

  /**
   * 判斷規則（純函式）。
   * @param {Object} p
   * @param {string[]} p.codes 每一列的費用歸屬代碼（依列順序；空白的列給空字串）
   * @param {Object<string,string[]>} p.deptsOfCode 代號（大寫）→ 所屬部門組織代碼陣列（同代號可屬多個部門）
   * @param {string} p.ownerDept 費用所屬人部門往上爬到的部（組織代碼）
   * @param {Object<string,string>} [p.orgNames] 組織代碼 → 名稱（訊息用）
   * @returns {string[]} 錯誤訊息
   */
  const checkScope = ({ codes, deptsOfCode, ownerDept, orgNames = {} }) => {
    const errors = [];
    const nameOf = (code) => orgNames[code] || code;
    const deptsOf = (code) => deptsOfCode[code] || [];
    const filled = codes.map((code, i) => ({ code: String(code || '').trim().toUpperCase(), line: i + 1 })).filter((x) => x.code);

    const missing = filled.filter((x) => deptsOf(x.code).length === 0);
    if (missing.length > 0) {
      errors.push(`以下費用歸屬在主檔沒有設定所屬部門，無法判斷是否為部內掛帳\n${[...new Set(missing.map((x) => `▸${x.code}`))].join('\n')}\n※ 請聯絡管理員補齊費用歸屬主檔的「所屬部門」`);
    }

    // 跨部門：所有列的代碼找不到一個共同的部（共用代碼屬於好幾個部，只要有交集就不算跨部門）
    const resolved = filled.filter((x) => deptsOf(x.code).length > 0);
    const common = resolved.reduce((acc, x) => acc.filter((d) => deptsOf(x.code).includes(d)), resolved.length > 0 ? deptsOf(resolved[0].code) : []);
    if (resolved.length > 1 && common.length === 0) {
      const depts = [...new Set(resolved.flatMap((x) => deptsOf(x.code)))];
      errors.push(`掛帳單位**不能跨部門**：本單的費用歸屬分屬 ${depts.map(nameOf).join('、')}`);
    }

    const foreign = resolved.filter((x) => !deptsOf(x.code).includes(ownerDept));
    if (foreign.length > 0) {
      errors.push(
        `掛帳單位**只能是費用所屬人的部內**（${nameOf(ownerDept)}）\n${foreign.map((x) => `▸第 ${x.line} 行 ${x.code}（${deptsOf(x.code).map(nameOf).join('、')}）`).join('\n')}\n※ 請改填部內的費用歸屬，或改選費用所屬人`,
      );
    }
    return errors;
  };

  /**
   * 申請人與費用所屬人要同部門（純函式）：兩邊的部門各自往上爬到的部要相同。
   * @param {Object} p
   * @param {{code:string,name:string}} p.applicantOrg 申請部門
   * @param {{code:string,name:string}} p.ownerOrg 費用所屬人部門
   * @param {string} p.applicantDept 申請部門往上爬到的部
   * @param {string} p.ownerDept 費用所屬人部門往上爬到的部
   * @param {Object<string,string>} [p.orgNames] 組織代碼 → 名稱（訊息用）
   * @returns {string[]} 錯誤訊息
   */
  const checkSameDept = ({ applicantOrg, ownerOrg, applicantDept, ownerDept, orgNames = {} }) => {
    if (applicantDept === ownerDept) return [];
    const nameOf = (code) => orgNames[code] || code;
    const line = (label, org, dept) => `▸${label}：${org.name || org.code}${org.code === dept ? '' : `（屬 ${nameOf(dept)}）`}`;
    return [
      `申請人與費用所屬人**必須同部門**\n${line('申請部門', applicantOrg, applicantDept)}\n${line('費用所屬人部門', ownerOrg, ownerDept)}\n※ 請改選同部門的費用所屬人`,
    ];
  };

  /**
   * 存檔驗證。排除群組內的申請人直接通過；費用所屬人部門沒填也略過（簽核排不出來，另有必填擋）。
   *   (A) 申請人與費用所屬人同部門（申請部門沒填就略過）
   *   (B) 掛帳單位限部內、不可跨部門（沒有任何費用歸屬就略過）
   * @param {Object} record
   * @returns {Promise<string[]>}
   */
  const validate = async (record) => {
    const exempt = await ensureExempt(applicantCodeOf(record));
    if (exempt) return [];

    const ownerOrg = record[F.EXPENSE_OWNER_ORG]?.value?.[0];
    if (!ownerOrg?.code) return [];
    const applicantOrg = record[F.APPLICANT_ORG]?.value?.[0];

    const rows = record[TRAFFIC.CODE]?.value || [];
    const codes = rows.map((row) => row?.value?.[TRAFFIC.COLS.EXPENSE]?.value || '');
    const hasCodes = codes.some((c) => String(c).trim());
    if (!hasCodes && !applicantOrg?.code) return [];

    const cc = window.PR_COST_CENTER;
    let deptsOfCode;
    let parentOf;
    try {
      await cc.ensureLoaded();
      deptsOfCode = cc.getDeptsOfCode();
      parentOf = await loadOrgParents();
    } catch (err) {
      console.error('[費用歸屬部門限制] 載入主檔或組織資料失敗:', err);
      return ['無法取得費用歸屬主檔或組織資料，無法檢查申請人部門與掛帳單位，請稍後再試或聯絡系統管理員'];
    }

    const deptSet = new Set(Object.values(deptsOfCode).flat());
    const ownerDept = resolveDeptOfOrg(ownerOrg.code, parentOf, deptSet);
    const orgNames = { ...(cc.getDeptNames?.() || {}), [ownerOrg.code]: ownerOrg.name };
    const errors = [];

    if (applicantOrg?.code) {
      const applicantDept = resolveDeptOfOrg(applicantOrg.code, parentOf, deptSet);
      errors.push(...checkSameDept({ applicantOrg, ownerOrg, applicantDept, ownerDept, orgNames: { ...orgNames, [applicantOrg.code]: applicantOrg.name } }));
    }

    if (hasCodes) {
      // 主檔裡沒有（或不是使用中）的代碼，payment_request_submit 已經會報錯，這裡略過不重複報
      const known = new Set([...(cc.getValidCodes() || [])].map((c) => String(c).trim().toUpperCase()));
      const knownCodes = codes.map((c) => (known.has(String(c).trim().toUpperCase()) ? c : ''));
      errors.push(...checkScope({ codes: knownCodes, deptsOfCode, ownerDept, orgNames }));
    }
    return errors;
  };

  // ── 事件 ───────────────────────────────────────────────────────────────

  // 開畫面就先算好申請人是否在排除群組（存檔時直接用），組織樹也先在背景抓
  KT.on(['app.record.create.show', 'app.record.edit.show'], (event) => {
    ensureExempt(applicantCodeOf(event.record));
    loadOrgParents().catch((err) => console.warn('[費用歸屬部門限制] 預先載入組織樹失敗，存檔時再試:', err));
    return event;
  });

  // 申請人改了（只有管理員能改）→ 重查
  KT.on([`app.record.create.change.${F.APPLICANT}`, `app.record.edit.change.${F.APPLICANT}`], (event) => {
    ensureExempt(applicantCodeOf(event.record));
    return event;
  });

  window.PR_COST_SCOPE = Object.freeze({
    ensureExempt,
    isExempt,
    applicantCodeOf,
    inExemptGroup,
    resolveDeptOfOrg,
    checkScope,
    checkSameDept,
    validate,
    loadOrgParents,
    /** 測試用：清掉記憶體裡的快取，模擬重新開頁 */
    _reset: () => {
      exemptState = null;
      exemptPromise = null;
      orgParentsMemory = null;
      orgParentsPromise = null;
    },
  });
})();
