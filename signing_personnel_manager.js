(function () {
  'use strict';

  // 桌面版／手機版共用的 kintone 入口（見 payment_request_config.js 的 PR_KT）
  const KT = window.PR_KT;

  // =============================================================================
  // 簽核人員自動帶入
  //
  //   依「費用所屬人／費用所屬人部門」到簽核流程主檔（APPS.APPROVAL_FLOW）查主管，
  //   把有值的欄位全部排進來（單位主管1〜3 → 單位次長 → 單位次長1 → 單位部長_支店長），
  //   再依費用所屬人在該部門的職稱，清掉他自己那一層與以下。
  //   同時依費用所屬人部門到會計對應主檔（APPS.ACCOUNTING_MAP）帶入會計單位與承辦人。
  //
  //   事件：
  //     - 費用所屬人部門變更（新增畫面開啟時也跑一次）→ 重排簽核人員
  //     - 費用所屬人變更 → 查他的所屬單位、帶入費用所屬人部門，再重排
  //     - 勾選「手動設定簽核流程」（只限費用歸屬不限部門群組）→ 6 格清空，改由手動簽核人設定.js 的視窗指定 1～3 位
  // =============================================================================

  // =========================
  // 常數定義區塊
  // =========================

  // PR_CONFIG 全域物件別名
  const C = window.PR_CONFIG;
  const F = window.PR_CONFIG.FIELDS;
  const APPS = window.PR_CONFIG.APPS;
  const OPT = window.PR_CONFIG.OPTIONS;

  // 簽核欄位設定 - 可依需求調整使用哪些欄位
  const APPROVAL_FIELDS = {
    單位主管1: { enabled: true },
    單位主管2: { enabled: true },
    單位主管3: { enabled: true },
    單位次長: { enabled: true },
    單位次長1: { enabled: true },
    單位部長_支店長: { enabled: true },
    事業本部長: { enabled: false },
    總務部長: { enabled: false },
    總經理: { enabled: false },
  };

  // 取得啟用的欄位名稱陣列
  const getEnabledFields = () => {
    return Object.keys(APPROVAL_FIELDS).filter((field) => APPROVAL_FIELDS[field].enabled);
  };

  // 簽核人數欄位（只有簽核流程用，不在請款單主表 FIELDS 範圍）
  const COUNT_FIELDS = { manager: '部門主管簽核人數', deputy: '部門次長簽核人數' };

  // 簽核相關欄位
  const MANAGER_FIELDS = ['單位主管1', '單位主管2', '單位主管3'].filter((field) => APPROVAL_FIELDS[field]?.enabled);
  const DEPUTY_FIELDS = ['單位次長', '單位次長1'].filter((field) => APPROVAL_FIELDS[field]?.enabled);
  const DIRECTOR_FIELD = '單位部長_支店長';

  const SIGNING_FIELDS_TO_HIDE = [...getEnabledFields(), COUNT_FIELDS.manager, COUNT_FIELDS.deputy];

  // 特殊部門（六大簽核流程）
  const SPECIAL_DEPARTMENTS = [
    '總務部',
    '高雄營業部',
    '台中營業部',
    '航空貨物部',
    '桃園機場營業所',
    '新竹營業所',
    '海運貨物部',
    '物流部',
    '物流部-桃園NEXT1倉庫',
  ];

  // 需要檢查部長的部門
  const DIRECTOR_CHECK_DEPARTMENTS = ['汽車貨運部', '營業戰略部', '事業本部'];

  // 簽核流程主檔（APPS.APPROVAL_FLOW）的欄位 ↔ 請款單上的簽核欄位
  const MANAGER_FIELDS_MAPPING = [
    { apiField: '請購單位主管1', displayField: '單位主管1' },
    { apiField: '請購單位主管2', displayField: '單位主管2' },
    { apiField: '請購單位主管3', displayField: '單位主管3' },
    { apiField: '請購單位次長', displayField: '單位次長' },
    { apiField: '請購單位次長1', displayField: '單位次長1' },
    { apiField: '請購單位部長', displayField: '單位部長_支店長' },
  ].filter((item) => APPROVAL_FIELDS[item.displayField]?.enabled);

  // 特殊部門只需要部長欄位
  const MANAGER_FIELDS_SPECIAL = [{ apiField: '請購單位部長', displayField: '單位部長_支店長' }].filter(
    (item) => APPROVAL_FIELDS[item.displayField]?.enabled,
  );

  // API 路徑
  const USER_API = '/v1/user/organizations.json';

  // 會計對應主檔（APPS.ACCOUNTING_MAP）自己的欄位代碼；其中 PERMISSION_USER 與請款單主表的
  // FIELDS.PERMISSION_STAFF 字串相同但分屬不同 App，讀主檔走 ACC、寫請款單走 F，不可代用。
  const ACC = C.REF_FIELDS.ACCOUNTING_MAP;

  // 簽核流程主檔（APPS.APPROVAL_FLOW）自己的欄位代碼
  const AF = C.REF_FIELDS.APPROVAL_FLOW;

  // =========================
  // 手動簽核流程相關常數
  // =========================

  // 手動模式：簽核人改由手動簽核人設定（PR_MANUAL_SIGNERS）的三格指定，原本的 6 格與人數欄位不用
  const MANUAL_ACCOUNTING_FIELD = C.MANUAL_SIGNERS.ACCOUNTING_FIELD; // 手動模式的會計承辦人（指定簽核人視窗第 4 格）
  const MANUAL_MODE_CONFIG = {
    // 核取方塊欄位名稱
    checkbox: F.MANUAL_FLOW,
    // 人數欄位：手動模式固定 0人（流程管理的自動關卡條件才不會成立）
    countFields: COUNT_FIELDS,
    // 手動模式要清空的簽核欄位
    slotFields: getEnabledFields(),
  };

  // =========================
  // 工具函數區塊
  // =========================

  // ── 只改 record、不碰畫面的部分（存檔時 PR_SIGNING_CHAIN.applyOnSave 也用同一套）──────────

  /** 一格簽核欄位寫成指定的人並鎖住 */
  const setSlot = (record, field, users) => {
    if (record[field]) {
      record[field].value = users;
      record[field].disabled = true;
    } else {
      record[field] = { value: users, type: 'USER_SELECT', disabled: true };
    }
  };

  /** 人數欄位的值（「3人」→ 3） */
  const countOf = (record, field) => parseInt(record[field]?.value, 10) || 0;

  /**
   * 依各格目前有沒有人重算主管／次長人數（2026-11-16）。
   * 費用所屬人或部門一變就重算，不沿用上一位的人數（流程管理靠人數決定從哪一關開始）。
   */
  function recountOnRecord(record) {
    const filled = (fields) => fields.filter((field) => record[field]?.value?.length > 0).length;
    if (record[COUNT_FIELDS.manager]) record[COUNT_FIELDS.manager].value = `${filled(MANAGER_FIELDS)}人`;
    if (record[COUNT_FIELDS.deputy]) record[COUNT_FIELDS.deputy].value = `${filled(DEPUTY_FIELDS)}人`;
  }

  /** 簽核格全部清空、人數歸 0人 */
  function clearSlots(record) {
    getEnabledFields().forEach((field) => {
      if (record[field]) record[field].value = [];
    });
    recountOnRecord(record);
  }

  // ── 畫面 ──────────────────────────────────────────────────────────────────

  /** 畫面上：簽核格有人才顯示，人數大於 0 才顯示 */
  function syncSigningShown(record) {
    getEnabledFields().forEach((field) => KT.record().setFieldShown(field, record[field]?.value?.length > 0));
    Object.values(COUNT_FIELDS).forEach((field) => {
      if (record[field]) KT.record().setFieldShown(field, countOf(record, field) > 0);
    });
  }

  /** 重算人數並同步顯示 */
  function recountSigning(record) {
    recountOnRecord(record);
    Object.values(COUNT_FIELDS).forEach((field) => {
      if (record[field]) KT.record().setFieldShown(field, countOf(record, field) > 0);
    });
  }

  /** 簽核格全部清空隱藏、人數歸 0人（排不出人、查詢失敗、換費用所屬人時用） */
  function resetSigningSlots(record) {
    clearSlots(record);
    syncSigningShown(record);
  }

  /** 非同步回來後清空畫面上的簽核格（手動模式不動） */
  function resetSigningOnScreen() {
    return KT.whenIdle(() => {
      const current = KT.record().get();
      if (isManualSigningMode(current.record)) return;
      resetSigningSlots(current.record);
      KT.record().set(current);
    }).catch((err) => console.error('[簽核人員] 清空簽核欄位失敗:', err));
  }

  /**
   * 找出選擇的組織在 orgs 中的索引
   * @param {Array} orgs - 組織陣列
   * @param {string} selectedOrgName - 選擇的組織名稱
   * @returns {number} 索引值，找不到回傳 -1
   */
  function getMatchedOrgIndex(orgs, selectedOrgName) {
    return orgs.findIndex((org) => org.organization.name === selectedOrgName);
  }

  /**
   * 取得使用者職位資料
   * @param {string} userApi - API 路徑
   * @param {Object} params - 查詢參數
   * @param {Function} callback - 回調函數
   */
  function fetchTitleData(userApi, params, callback) {
    kintone
      .api(kintone.api.url(userApi, true), 'GET', params)
      .then((resp) => {
        const orgs = resp.organizationTitles;
        const titleCount = orgs.length;
        callback(null, { orgs, titleCount });
      })
      .catch((error) => {
        callback(error, null);
      });
  }

  /**
   * 依職稱改查的合併簽核流程（簽核流程主檔「特殊簽核流程」那幾筆，例如「物流部次長級」）。
   * 有對應就回傳要查的「簽核流程名稱」；沒有就回傳空字串，改用費用所屬人部門的組織代碼查「簽核所屬單位」。
   * @param {string} org - 費用所屬人該單位的組織名稱
   * @param {string} title - 費用所屬人在該單位的職稱
   * @returns {string} 特殊簽核流程名稱，沒有則為空字串
   */
  function specialFlowName(org, title) {
    let flowName = '';

    if (org && title) {
      // 1. 物流部次長級
      if ((org === '物流部-桃園NEXT1倉庫' || org === '物流部') && title === '次長') {
        flowName = '物流部次長級';
      }
      // 2. 航空貨物部次長(所長)級
      else if (
        (org === '航空貨物部' && title === '次長') ||
        ((org === '桃園機場營業所' || org === '新竹營業所') && (title === '所長' || title === '次長'))
      ) {
        flowName = '航空貨物部次長(所長)級';
      }
      // 3. 海運貨物部次長級
      else if (org === '海運貨物部' && title === '次長') {
        flowName = '海運貨物部次長級';
      }
      // 4. 總務部次長級
      else if (org === '總務部' && title === '次長') {
        flowName = '總務部次長級';
      }
      // 5. 物流部長/汽車貨運部長
      else if ((org === '物流部' || org === '汽車貨運部') && title === '部長') {
        flowName = '物流部長/汽車貨運部長';
      }

      // 6. 海運貨物部長/航空貨物部長
      else if ((org === '海運貨物部' || org === '航空貨物部') && title === '部長') {
        flowName = '海運貨物部長/航空貨物部長';
      }
      // 7. 安全品質推動部長/營業戰略部長/總務部長/事業本部長
      else if (
        (org === '安全品質推動部' && title === '部長') ||
        ((org === '營業戰略部' || org === '總務部' || org === '事業本部') && title === '部長')
      ) {
        flowName = '安全品質推動部長/營業戰略部長/總務部長/事業本部長';
      }
      //8. 台中營業部/高雄營業部/事業本部次長(中心長)級
      else if ((org === '事業本部' && title === '次長') || ((org === '台中營業部' || org === '高雄營業部') && title === '部長')) {
        flowName = '台中營業部長/高雄營業部長/事業本部次長(中心長)級';
      }

      //9. 安全品質推動部次長級
      else if (org === '安全品質推動部' && title === '次長') {
        flowName = '安全品質推動部次長級';

        //10. 高雄營業部次長級
      } else if (org === '高雄營業部' && title === '次長') {
        flowName = '高雄營業部次長級';
      }

      //11. 台中營業部次長級
      else if (org === '台中營業部' && title === '次長') {
        flowName = '台中營業部次長級';
      }
    }

    return flowName;
  }

  /**
   * 決定「要排哪幾位主管」——只做判斷，不碰 kintone、不改 record。
   *
   * 簽核流程主檔有值的欄位全部保留，由低層級到高層級：
   *   單位主管1 → 單位主管2 → 單位主管3 → 單位次長 → 單位次長1 → 單位部長_支店長
   * 同一人出現在好幾格時只留最上面那格（主檔的主管3 與次長1 常是同一位次長，不讓他連簽兩關）。
   * 費用所屬人本人那一層與以下，之後由 clearByTitle 依職稱清掉。
   *
   * @param {Object} managerData - 簽核流程主檔回傳的那筆記錄
   * @param {Array}  fieldsToUpdate - MANAGER_FIELDS_MAPPING 或 MANAGER_FIELDS_SPECIAL
   * @returns {{ fieldHasValue: Object, fieldsToShow: string[], usersOf: Object<string, Array> }}  usersOf：每格實際要排的人
   */
  const planSigningChain = (managerData, fieldsToUpdate) => {
    // 由高層往低層看：同一人已排在更上面的格子（例如主管3 與次長1 是同一人），下面那格就不排，只簽上面那關
    const usersOf = {};
    const codesAbove = new Set();
    [...fieldsToUpdate].reverse().forEach(({ apiField, displayField }) => {
      const users = (managerData[apiField]?.value || []).filter((user) => !codesAbove.has(user.code));
      users.forEach((user) => codesAbove.add(user.code));
      usersOf[displayField] = users;
    });

    const fieldHasValue = {};
    fieldsToUpdate.forEach(({ displayField }) => {
      fieldHasValue[displayField] = usersOf[displayField].length > 0;
    });

    const fieldsToShow = fieldsToUpdate.map(({ displayField }) => displayField).filter((displayField) => fieldHasValue[displayField]);

    return { fieldHasValue, fieldsToShow, usersOf };
  };
  /**
   * 把簽核流程主檔排出的人寫進簽核格（只改 record）。
   *
   * 簽核層級結構：
   *   A1: 單位主管1
   *   A2: 單位主管2
   *   A3: 單位主管3
   *   B:  單位次長
   *   C:  單位次長1
   *   D:  單位部長_支店長
   *
   * @param {Object} record - Kintone record 物件
   * @param {Object} managerData - 簽核流程主檔的那一筆
   * @param {boolean} isSpecialDepartment - 是否為特殊部門（六大簽核流程，只排部長）
   * @returns {Object} record
   */
  function writeChain(record, managerData, isSpecialDepartment) {
    const fieldsToUpdate = isSpecialDepartment ? MANAGER_FIELDS_SPECIAL : MANAGER_FIELDS_MAPPING;
    const { usersOf } = planSigningChain(managerData, fieldsToUpdate);
    fieldsToUpdate.forEach(({ displayField }) => {
      setSlot(
        record,
        displayField,
        usersOf[displayField].map((user) => ({ code: user.code, name: user.name })),
      );
    });
    return record;
  }

  /**
   * 依費用所屬人職稱清掉本人那一層與以下，再依各格實際有沒有人重算人數（只改 record）。
   * @param {Object} record - Kintone record 物件
   * @param {string} title - 職稱
   * @param {string} userCode - 費用所屬人的使用者代碼
   */
  function clearByTitle(record, title, userCode) {
    const hasOwner = (field) => record[field]?.value?.some((user) => user.code === userCode);
    const clear = (fields) => fields.forEach((field) => setSlot(record, field, []));
    // 本人也排在次長格（課長兼次長、中心長排在次長格…）：照次長處理，簽核從他上面那一層開始，不會自己簽自己
    const isInDeputySlot = DEPUTY_FIELDS.some(hasOwner);
    // 本人就排在部長格（職稱不一定是部長，例如事業部長）：照部長處理，部長格也清掉，不會自己簽自己
    const isInDirectorSlot = hasOwner(DIRECTOR_FIELD);
    const effectiveTitle = isInDirectorSlot ? '部長' : isInDeputySlot && title !== '部長' && title !== '支店長' ? '次長' : title;

    switch (effectiveTitle) {
      case '課長': {
        // 本人在哪一格主管，清掉那一格與以下
        const level = MANAGER_FIELDS.findIndex(hasOwner);
        if (level >= 0) clear(MANAGER_FIELDS.slice(0, level + 1));
        break;
      }
      case '次長':
      case '室長': {
        // 課長全清；本人在哪一格次長（取最上面那格），清掉那一格與以下
        clear(MANAGER_FIELDS);
        let level = -1;
        DEPUTY_FIELDS.forEach((field, index) => {
          if (hasOwner(field)) level = index;
        });
        if (level >= 0) clear(DEPUTY_FIELDS.slice(0, level + 1));
        break;
      }
      case '部長':
      case '支店長':
        // 部長格是本人才清；部長格是別人（上一層部長）就留著讓他簽
        clear([...MANAGER_FIELDS, ...DEPUTY_FIELDS, ...(isInDirectorSlot ? [DIRECTOR_FIELD] : [])]);
        break;
      default:
        break;
    }

    // 人數一律依清完後各格實際有沒有人重算（職稱沒對到上面任何一種、或格子本來就空著，也不會留錯的人數）
    recountOnRecord(record);
  }

  /**
   * 依查到的簽核流程主檔排好整條簽核鏈（只改 record；畫面與存檔共用）。
   *   台中支店長等（isSpecificDirector）或主檔查不到 → 全部清空、人數 0人；
   *   六大簽核流程只排部長，部長就是本人時才依職稱清；其他依職稱清掉本人那層與以下。
   * @param {Object} record
   * @param {Object|null} managerData 簽核流程主檔的那一筆
   * @param {{ title: string, isSpecialDepartment: boolean, isSpecificDirector: boolean }} owner classifyOwner 的結果
   * @param {string} ownerCode 費用所屬人代碼
   * @returns {Object} record
   */
  function fillChain(record, managerData, { title, isSpecialDepartment, isSpecificDirector }, ownerCode) {
    // 先全部清掉：六大簽核流程只寫部長格，其他格不能留著上一位（或舊單）的人
    clearSlots(record);
    if (isSpecificDirector || !managerData) return record;
    writeChain(record, managerData, isSpecialDepartment);
    const isOwnerDirector = record[DIRECTOR_FIELD]?.value?.some((user) => user.code === ownerCode);
    if (!isSpecialDepartment || isOwnerDirector) clearByTitle(record, title, ownerCode);
    recountOnRecord(record);
    return record;
  }

  /**
   * 依費用所屬人在所選部門的職稱，算出查簽核流程主檔要用的資料。
   * @param {string} orgName  請款單上選的費用所屬人部門名稱
   * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
   * @param {number} matchedIndex  orgName 在 orgs 裡的位置
   */
  const classifyOwner = (orgName, orgs, matchedIndex) => {
    const org = orgs[matchedIndex];
    // 沒有職稱（title 是 null）→ 不清任何一層，簽核流程主檔有值的欄位全部排上
    const title = org.title?.name || '';
    const orgNameOfTitle = org.organization.name;
    const flowName = specialFlowName(orgNameOfTitle, title);
    return {
      title,
      // 特殊簽核流程用名稱查；其他一律用組織代碼查「簽核所屬單位」（改組織名稱不用改程式）
      approvalQuery: flowName
        ? `${AF.FLOW_NAME} = "${flowName}"`
        : `${AF.ORG} in ("${org.organization.code}") and ${AF.IN_USE} in ("${AF.IN_USE_VALUE}")`,
      // 未更動之前的名稱來觀察是否為六大簽核流程
      isSpecialDepartment: SPECIAL_DEPARTMENTS.includes(orgName) || (DIRECTOR_CHECK_DEPARTMENTS.includes(orgName) && orgs[0]?.title?.name === '部長'),
      // 台中支店長／營業戰略部長／總務部長／事業本部長：不帶入課／次／部長流程
      isSpecificDirector:
        (orgNameOfTitle === '台中營業部' && title === '支店長') ||
        ((orgNameOfTitle === '營業戰略部' || orgNameOfTitle === '總務部' || orgNameOfTitle === '事業本部') && title === '部長'),
    };
  };

  /**
   * 查簽核流程主檔（APPS.APPROVAL_FLOW）的那一筆；查不到回 null。
   * @param {{ approvalQuery: string, isSpecialDepartment: boolean }} owner classifyOwner 的結果
   * @returns {Promise<Object|null>}
   */
  const fetchManagerData = ({ approvalQuery, isSpecialDepartment }) => {
    const apiFields = (isSpecialDepartment ? MANAGER_FIELDS_SPECIAL : MANAGER_FIELDS_MAPPING).map((field) => field.apiField);
    return kintone
      .api(kintone.api.url('/k/v1/records', true), 'GET', { app: APPS.APPROVAL_FLOW, fields: [AF.FLOW_NAME, ...apiFields], query: approvalQuery })
      .then((resp) => resp?.records?.[0] || null);
  };

  // ── 存檔時重算（2026-11-18）──────────────────────────────────────────────
  //   畫面上的排人是改費用所屬人／部門時非同步做的：改完馬上按儲存、或簽核流程主檔事後改過、
  //   或複製舊單，存進去的都會是舊的人。存檔時一律依目前的費用所屬人／部門再排一次，寫進 record。
  //   不處理：表單作廢、手動設定簽核流程、送出後（不在可編輯狀態）、對照表裡的部長（PR_DIRECTOR_UPLINE.apply 負責）。

  /** 這個狀態還能重算：新增（沒有狀態）、報銷人填單、草稿與駁回（和部長上一階主管同一組狀態） */
  const isEditableStatus = (status) =>
    !status || C.DIRECTOR_UPLINE.EDITABLE_STATUSES.includes(status) || String(status).endsWith(C.DIRECTOR_UPLINE.REJECT_SUFFIX);

  /**
   * 存檔時呼叫：依目前的費用所屬人／費用所屬人部門重排簽核人員並寫進 record。
   * 查不到資料、部門不是費用所屬人的單位 → 回錯誤訊息擋存檔（不讓舊的簽核人員被存進去）。
   * @param {Object} record event.record
   * @returns {Promise<string[]>}
   */
  const applyOnSave = async (record) => {
    if (record?.[C.VOID_FIELD]?.value?.length > 0) return [];
    if (isManualSigningMode(record)) return [];
    if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return [];
    const ownerUser = record?.[F.EXPENSE_OWNER]?.value?.[0];
    const ownerOrg = record?.[F.EXPENSE_OWNER_ORG]?.value?.[0];
    if (!ownerUser?.code || !ownerOrg?.code) return []; // 沒填由必填檢查擋，這裡不重複報錯

    try {
      const resp = await kintone.api(kintone.api.url(USER_API, true), 'GET', { code: ownerUser.code });
      const orgs = resp?.organizationTitles || [];
      const matchedIndex = orgs.findIndex((org) => org.organization?.code === ownerOrg.code);
      if (matchedIndex === -1) {
        return [`「${F.EXPENSE_OWNER_ORG}」${ownerOrg.name || ownerOrg.code} **不是費用所屬人的所屬單位**，無法安排簽核人員\n※ 請重新選一次「${F.EXPENSE_OWNER}」，系統會重新帶入部門`];
      }
      const owner = classifyOwner(ownerOrg.name, orgs, matchedIndex);
      // 對照表裡的部長：上一階主管由 PR_DIRECTOR_UPLINE.apply 寫入，這裡不動
      if (window.PR_DIRECTOR_UPLINE?.groupOf(orgs[matchedIndex].organization.name, owner.title)) return [];
      const managerData = owner.isSpecificDirector ? null : await fetchManagerData(owner);
      fillChain(record, managerData, owner, ownerUser.code);
      return [];
    } catch (err) {
      console.error('[簽核人員] 存檔時重排簽核人員失敗:', err);
      return [`**無法安排簽核人員**（讀不到費用所屬人的單位或簽核流程主檔）\n※ 請稍後再按一次儲存；仍無法存檔請聯絡系統管理員`];
    }
  };

  /**
   * 存檔時呼叫：依目前的費用所屬人部門重帶會計單位／會計承辦人／權限開放人員（和簽核人員同一個理由：
   * 畫面上是改部門時非同步帶的，改完馬上存、舊單、會計對應主檔事後改過，存進去的都會是舊的）。
   * 手動設定簽核流程也要帶（會計承辦人、權限開放人員），會計單位照舊維持空白；手動會計承辦人不在這裡動。
   * 查不到對應 → 非手動擋存檔（流程管理要靠會計單位送件）；手動不擋。
   * @param {Object} record event.record
   * @returns {Promise<string[]>}
   */
  const applyAccountingOnSave = async (record) => {
    if (record?.[C.VOID_FIELD]?.value?.length > 0) return [];
    if (!isEditableStatus(record?.[F.STATUS_FIELD]?.value)) return [];
    const orgName = record?.[F.EXPENSE_OWNER_ORG]?.value?.[0]?.name;
    if (!orgName) return [];
    try {
      const accountData = await fetchAccountingData(orgName);
      if (!accountData) {
        if (isManualSigningMode(record)) return [];
        return [`「${F.EXPENSE_OWNER_ORG}」${orgName} **找不到對應的會計單位**\n※ 請確認費用所屬人部門是否正確；仍有問題請洽系統管理員`];
      }
      fillAccounting(record, accountData);
      return [];
    } catch (err) {
      console.error('[簽核人員] 存檔時帶入會計單位失敗:', err);
      return [`**無法取得會計單位**（讀不到會計對應主檔）\n※ 請稍後再按一次儲存；仍無法存檔請聯絡系統管理員`];
    }
  };

  // 給 payment_request_submit 存檔時呼叫；fillChain 對外給測試用
  window.PR_SIGNING_CHAIN = Object.freeze({ applyOnSave, applyAccountingOnSave, fillChain, isEditableStatus });

  /** 提示視窗：一律用 SweetAlert；載不到 SweetAlert 才退回瀏覽器的 alert */
  function notify(icon, title, text) {
    if (typeof Swal !== 'undefined') Swal.fire({ icon, title, text, width: 'auto', confirmButtonText: '好' });
    else alert(text ? `${title}\n${text}` : title);
  }

  const accountingParams = (orgName) => ({
    app: APPS.ACCOUNTING_MAP,
    fields: [ACC.APPLY_UNIT, ACC.ACCOUNTING_UNIT, ACC.ACCOUNTING_STAFF, ACC.PERMISSION_USER],
    query: `${ACC.APPLY_UNIT} in ("${orgName}")`,
  });

  /** 查會計對應主檔（APPS.ACCOUNTING_MAP）申請單位＝orgName 的那一筆；查不到回 null */
  const fetchAccountingData = (orgName) =>
    new Promise((resolve, reject) => {
      kintone.api(kintone.api.url('/k/v1/records', true), 'GET', accountingParams(orgName), resolve, reject);
    }).then((resp) => resp?.records?.[0] || null);

  const toUsers = (list) => (list || []).map((u) => ({ code: u.code || u, name: u.name || u }));

  /**
   * 會計對應主檔的一筆 → 寫進 record（只改 record，畫面與存檔共用）：
   *   會計單位（手動設定簽核流程時維持空白：流程管理靠它分辨「送會計」與「送單位會計處理中」）、
   *   會計承辦人、權限開放人員。
   * @returns {{ hasAccount: boolean, isManual: boolean, staff: Array }}
   */
  function fillAccounting(record, accountData) {
    const isManual = isManualSigningMode(record);
    const unit = accountData[ACC.ACCOUNTING_UNIT]?.value;
    const hasAccount = unit?.length > 0;
    if (!isManual) {
      record[F.ACCOUNTING_UNIT] = { value: hasAccount ? [{ code: unit, name: unit }] : [], type: 'GROUP_SELECT', disabled: true };
    }
    const staff = toUsers(accountData[ACC.ACCOUNTING_STAFF]?.value);
    record[F.ACCOUNTING_STAFF] = { value: staff, type: 'USER_SELECT' };
    // 左側是請款單主表的欄位（F），右側是會計對應主檔的欄位（ACC）——同名但不同 App
    record[F.PERMISSION_STAFF] = { value: toUsers(accountData[ACC.PERMISSION_USER]?.value), type: 'USER_SELECT' };
    return { hasAccount, isManual, staff };
  }

  /**
   * 取得會計單位並設定到畫面
   * @param {string} orgName - 費用所屬人部門名稱
   */
  function setAccountingUnit(orgName) {
    // 用回呼寫法：API 一回來就同步寫畫面（不多繞 Promise）
    kintone.api(
      kintone.api.url('/k/v1/records', true),
      'GET',
      accountingParams(orgName),
      // 別的處理程式還在跑時 get() 會被擋，KT.whenIdle 等它跑完再寫
      (resp) => KT.whenIdle(() => {
        const accountData = resp?.records?.[0];
        if (!accountData) {
          notify('warning', '找不到對應的會計單位', '請確認費用所屬人部門是否正確；仍有問題請洽系統管理員。');
          return;
        }

        // API 回來時使用者可能剛勾選手動，所以看寫入當下的畫面資料，不看呼叫當時的狀態
        const updateRecord = KT.record().get();
        const { hasAccount, isManual, staff } = fillAccounting(updateRecord.record, accountData);

        // 手動模式另有「手動會計承辦人」（指定簽核人視窗第 4 格）：還空著才帶這個預設，申請人選過的不蓋掉
        const manualStaffField = updateRecord.record[MANUAL_ACCOUNTING_FIELD];
        const offerManualStaff = isManual && manualStaffField && !(manualStaffField.value?.length > 0) && staff.length > 0;
        if (offerManualStaff) {
          manualStaffField.value = staff;
          manualStaffField.disabled = true;
        }

        KT.record().setFieldShown(F.ACCOUNTING_UNIT, hasAccount && !isManual);
        KT.record().set(updateRecord);
        if (offerManualStaff) window.PR_MANUAL_SIGNERS?.offerAccounting?.(staff);
      }).catch((err) => console.error('[簽核人員] 帶入會計單位失敗:', err)),
      function (error) {
        console.error('API錯誤:', error);
        notify('error', '取得會計單位資料時發生錯誤', '請稍後再試，或重新選一次費用所屬人。');
      },
    );
  }

  // =========================
  // 主要處理函數
  // =========================

  // 連續改費用所屬人／部門時，只讓最後一次的查詢結果寫回畫面
  let ownerOrgChangeSeq = 0;

  /**
   * 對照表裡的部長：讀上一階主管群組 → 單位部長_支店長＝成員（扣掉本人），其餘格清空，人數 0人／0人。
   * 群組沒人或讀不到：格子清空並提醒（存檔時 PR_DIRECTOR_UPLINE.apply 會再查一次並擋下）。
   */
  function applyUplineToScreen({ group, ownerCode, orgName, isLatest }) {
    const upline = window.PR_DIRECTOR_UPLINE;
    return upline
      .loadMembers(group)
      .then((members) =>
        KT.whenIdle(() => {
          if (!isLatest()) return;
          const current = KT.record().get();
          if (isManualSigningMode(current.record)) return;
          const users = upline.membersExcept(members, ownerCode);
          upline.writeSlots(current.record, users);
          getEnabledFields().forEach((field) => {
            if (current.record[field]) current.record[field].disabled = true;
            KT.record().setFieldShown(field, current.record[field]?.value?.length > 0);
          });
          recountSigning(current.record);
          KT.record().set(current);
          window.PR_LOG.debug(`[簽核人員] ${orgName} 部長 → 上一階主管群組 ${group}：`, users.map((u) => u.code));
          if (users.length === 0) notify('warning', '上一階主管群組沒有人', `${upline.emptyMessage(orgName, group)}，存檔會被擋下，請聯絡系統管理員。`);
        }),
      )
      .catch((err) => {
        console.error('[簽核人員] 讀取上一階主管群組失敗:', err);
        if (!isLatest()) return;
        resetSigningOnScreen();
        notify('error', '讀不到上一階主管', `群組「${group}」的成員讀取失敗，請稍後再試；存檔時會再查一次。`);
      });
  }

  /**
   * 處理費用所屬人部門變更時的簽核人員設定
   * @param {Object} event - Kintone event 物件
   * @returns {Object} event 物件
   */
  function handleExpenseOwnerOrgChange(event) {
    const record = event.record;
    const selectedOrg = record[F.EXPENSE_OWNER_ORG].value;

    // 手動設定簽核流程：簽核人員由使用者自選，不重排、不清空；只帶入會計單位承辦人與權限開放人員
    if (isManualSigningMode(record)) {
      if (selectedOrg?.length > 0) setAccountingUnit(selectedOrg[0].name);
      return event;
    }

    // 先隱藏所有簽核相關欄位
    SIGNING_FIELDS_TO_HIDE.forEach((field) => {
      KT.record().setFieldShown(field, false);
    });

    // 如果沒有選擇費用所屬人部門，清空所有簽核欄位
    if (!selectedOrg || selectedOrg.length === 0) {
      resetSigningSlots(record);
      record[F.ACCOUNTING_UNIT].value = [];

      return event;
    }

    record[COUNT_FIELDS.manager].disabled = true;
    record[COUNT_FIELDS.deputy].disabled = true;

    // 取得組織名稱
    const orgName = selectedOrg[0].name;

    // 設定會計單位
    setAccountingUnit(orgName);

    const ownerCode = record[F.EXPENSE_OWNER]?.value?.[0]?.code;
    if (!ownerCode) {
      resetSigningSlots(record);
      return event;
    }

    // 連續觸發時只讓最後一次的查詢結果寫回畫面
    const seq = ++ownerOrgChangeSeq;
    const isLatest = () => seq === ownerOrgChangeSeq;

    // 取得費用所屬人在各部門的職位資料
    fetchTitleData(USER_API, { code: ownerCode }, (error, result) => {
      if (!isLatest()) return;
      if (error) {
        console.error('Error:', error);
        resetSigningOnScreen();
        return;
      }

      const { orgs } = result;

      // 取得匹配的組織索引
      const matchedIndex = getMatchedOrgIndex(orgs, orgName);

      // 費用所屬人部門鎖住、只依費用所屬人帶入；不一致（例如複製別人的單）由 handleExpenseOwnerChange 重新帶入部門後再排
      if (matchedIndex === -1) {
        console.warn(`[簽核人員] 費用所屬人部門「${orgName}」不是費用所屬人的所屬單位，等重新帶入部門後再排簽核人員`);
        return;
      }

      // 使用匹配到的索引取得正確的組織和職位資料
      const owner = classifyOwner(orgName, orgs, matchedIndex);
      const { title, approvalQuery, isSpecificDirector } = owner;

      // 對照表裡的部長（C.DIRECTOR_UPLINE）：上一階主管由群組決定，不查簽核流程主檔
      const upline = window.PR_DIRECTOR_UPLINE;
      const ownerOrgName = orgs[matchedIndex].organization.name;
      const uplineGroup = upline?.groupOf(ownerOrgName, title);
      if (uplineGroup) {
        applyUplineToScreen({ group: uplineGroup, ownerCode, orgName: ownerOrgName, isLatest });
        return;
      }
      window.PR_LOG.debug(`簽核流程查詢：${approvalQuery}`);

      // 查簽核流程主檔 → 排好整條簽核鏈（fillChain，存檔時 applyOnSave 用同一套）→ 寫回畫面
      fetchManagerData(owner).then(
        // 別的處理程式還在跑時 get() 會被擋，KT.whenIdle 等它跑完再寫
        (managerData) =>
          KT.whenIdle(() => {
            if (!isLatest()) return;
            const updateRecord = KT.record().get();

            // API 回來前使用者可能已勾選手動設定簽核流程，那就不蓋掉他自選的人
            if (isManualSigningMode(updateRecord.record)) return;

            if (isSpecificDirector) window.PR_LOG.debug('台中支店長/營業戰略部長/總務部長/事業本部長，不帶入課/次/部長流程');
            else if (!managerData) window.PR_LOG.debug('此費用所屬人部門沒有設定簽核流程');

            fillChain(updateRecord.record, managerData, owner, ownerCode);
            syncSigningShown(updateRecord.record);
            KT.record().set(updateRecord);
          }).catch((err) => console.error('[簽核人員] 帶入簽核主管失敗:', err)),
        (error) => {
          console.error('API錯誤:', error);
          if (!isLatest()) return;
          resetSigningOnScreen();
          notify('error', '取得主管資料時發生錯誤', '請稍後再試，或重新選一次費用所屬人。');
        },
      );
    });

    return event;
  }

  // =========================
  // 手動簽核流程相關函數
  // =========================

  /**
   * 初始化手動簽核模式：人數歸 0人並鎖住、6 格清空隱藏；
   * 手動簽核人三格、手動會計承辦人與「設定簽核人」按鈕交給 PR_MANUAL_SIGNERS（只能從指定簽核人視窗改）。
   * @param {Object} record - Kintone record 物件
   * @param {{ openNow?: boolean }} [opts] openNow：馬上開「指定簽核人」視窗
   * @returns {Object} 更新後的 record
   */
  function initManualSigningMode(record, { openNow = false } = {}) {
    manualShown = true;
    Object.values(MANUAL_MODE_CONFIG.countFields).forEach((field) => {
      if (!record[field]) return;
      record[field].value = '0人';
      record[field].disabled = true;
      KT.record().setFieldShown(field, false);
    });

    MANUAL_MODE_CONFIG.slotFields.forEach((field) => {
      if (!record[field]) return;
      record[field].value = [];
      record[field].disabled = true;
      KT.record().setFieldShown(field, false);
    });

    window.PR_MANUAL_SIGNERS?.enter(record, { openNow });
    return record;
  }

  /**
   * 檢查是否為手動模式
   * @param {Object} record - Kintone record 物件
   * @returns {boolean}
   */
  function isManualSigningMode(record) {
    return record[MANUAL_MODE_CONFIG.checkbox] && record[MANUAL_MODE_CONFIG.checkbox].value && record[MANUAL_MODE_CONFIG.checkbox].value.length > 0;
  }

  // 畫面上「手動設定簽核流程」目前的勾選狀態（開畫面時讀、程式自己改勾選時跟著改；null＝還不知道）。
  // kintone 在程式 KT.record().set() 之後也會觸發勾選欄位的 change 事件（值沒變也會），
  // 事件的值和這裡一樣就是 set() 的回音、不是使用者點的：不開視窗、不確認、不勾回去。
  // 否則開新增畫面帶會計單位的 set() 會跳「指定簽核人」視窗，視窗按取消改回自動後又被勾回去，無限循環。
  let manualShown = null;

  // =========================
  // 事件註冊
  // =========================

  // 費用所屬人部門變更時的事件
  KT.on([`app.record.create.change.${F.EXPENSE_OWNER_ORG}`, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`], handleExpenseOwnerOrgChange);

  /**
   * 申請人在「費用歸屬不限部門」群組（COST_SCOPE.EXEMPT_GROUP）→ 簽核人員自選：勾上手動設定簽核流程。
   * @param {Object} record
   * @param {{ openNow?: boolean }} [opts] openNow：還沒指定簽核人就跳「指定簽核人」視窗（使用者自己勾的才跳；開新增畫面時不跳，改按「設定簽核人」）
   */
  function enterManualModeForExempt(record, { openNow = true } = {}) {
    record[F.MANUAL_FLOW].value = [OPT.MANUAL_FLOW.ON];
    record[F.ACCOUNTING_UNIT].value = [];
    KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);
    if (typeof KT.record().setGroupFieldOpen === 'function') KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
    // 還沒指定簽核人才跳視窗（複製的單已經有人就不吵他，要改按「更改簽核人」）
    const hasSigners = window.PR_MANUAL_SIGNERS?.signersOf(record).some(Boolean);
    initManualSigningMode(record, { openNow: openNow && !hasSigners });
  }

  /** 不在「費用歸屬不限部門」群組的人勾了手動設定簽核流程 */
  function warnManualNotAllowed() {
    const title = '這張單不能手動設定簽核人';
    const text = `手動設定簽核流程只開放給「${C.COST_SCOPE.EXEMPT_GROUP}」的同仁，簽核人員會由系統依費用所屬人自動安排。`;
    notify('info', title, text);
  }

  /** 取消勾選手動設定時確認（SweetAlert；載不到才用瀏覽器 confirm） */
  function askExitManual() {
    const title = '改回系統自動排簽核人員？';
    const text = '剛才指定的簽核人與會計承辦人會清掉，改由系統依費用所屬人重新安排。';
    if (typeof Swal === 'undefined') return Promise.resolve(confirm(`${title}\n\n${text}\n按「取消」維持手動設定。`));
    return Swal.fire({
      icon: 'question',
      title,
      text,
      width: 'auto',
      showCancelButton: true,
      confirmButtonText: '改回自動',
      cancelButtonText: '維持手動',
      reverseButtons: true,
      focusCancel: true,
    }).then((result) => result.isConfirmed);
  }

  /**
   * 新增畫面：手動設定簽核流程不自動勾（排除群組的人要用再自己勾）。
   * 勾著（複製了手動設定的單）但申請人不在排除群組（PR_COST_SCOPE）→ 取消勾選、清掉手動簽核人並提示；
   * 再帶入費用所屬人部門與簽核人員／會計單位（改回自動排人）。
   */
  function handleCreateShow(event) {
    manualShown = Boolean(isManualSigningMode(event.record));
    const scope = window.PR_COST_SCOPE;
    if (!scope || !manualShown) return syncOwnerOrgOnCreate(event);
    return scope.ensureExempt(scope.applicantCodeOf(event.record)).then((exempt) => {
      if (!exempt && !C.isAdmin()) {
        event.record[MANUAL_MODE_CONFIG.checkbox].value = [];
        manualShown = false;
        window.PR_MANUAL_SIGNERS?.leave(event.record);
        notify('info', '已改回系統自動排簽核人員', `這張單複製自手動設定簽核流程的單；手動設定只開放給「${C.COST_SCOPE.EXEMPT_GROUP}」的同仁，簽核人員會由系統依費用所屬人自動安排。`);
      }
      return syncOwnerOrgOnCreate(event);
    });
  }

  /**
   * 新增畫面：費用所屬人部門一律依費用所屬人（部門鎖住，不能手選）。
   *   - 沒有費用所屬人 → 部門清空、簽核欄位清空
   *   - 部門有值 → 先照它排簽核人員；同時查費用所屬人的單位，部門不是他的單位（例如複製別人的單）就重新帶入
   *   - 部門空白 → 簽核欄位清空，查單位帶入部門（同改費用所屬人）
   * 查單位是非同步的，帶入部門後 handleExpenseOwnerChange 會再重排簽核人員，兩者不會互相覆蓋。
   */
  function syncOwnerOrgOnCreate(event) {
    const record = event.record;
    const hasOwner = record[F.EXPENSE_OWNER]?.value?.length > 0;
    if (!hasOwner) return clearOwnerOrg(event);
    handleExpenseOwnerOrgChange(event);
    handleExpenseOwnerChange(event, { keepIfValid: true });
    return event;
  }

  /** 沒有費用所屬人 → 部門跟著清空（部門只依費用所屬人帶入），公司名稱重算、簽核欄位清空 */
  function clearOwnerOrg(event) {
    const orgField = event.record[F.EXPENSE_OWNER_ORG];
    if (orgField?.value?.length > 0) {
      orgField.value = [];
      window.PR_COMPANY_NAME?.apply(event.record);
    }
    return handleExpenseOwnerOrgChange(event);
  }

  KT.on('app.record.create.show', handleCreateShow);

  // ── 改費用所屬人後帶入費用所屬人部門並重排簽核人員（所有人適用）──

  /**
   * 選單位的視窗（和 723 交際費同一種）：每個所屬單位一顆按鈕，點了就帶入；可取消時最下面多一顆「取消」。
   * 樣式在 payment_request.css 的 .pr-org-picker*。
   * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
   * @param {{ heading: string, hint: string, keepable: boolean }} p
   * @returns {Promise<Object|null>} 點到的那筆 organizationTitles；按取消回傳 null
   */
  const openOrgDialog = (orgs, { heading, hint, keepable }) =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'pr-org-picker-overlay';
      const box = document.createElement('div');
      box.className = 'pr-org-picker';

      const title = document.createElement('p');
      title.className = 'pr-org-picker__title';
      title.textContent = heading;
      box.appendChild(title);
      if (hint) {
        const hintEl = document.createElement('p');
        hintEl.className = 'pr-org-picker__hint';
        hintEl.textContent = hint;
        box.appendChild(hintEl);
      }

      const close = (picked) => {
        overlay.remove();
        resolve(picked);
      };
      orgs.forEach((o) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pr-org-picker__option';
        btn.textContent = o.organization.name;
        btn.addEventListener('click', () => close(o));
        box.appendChild(btn);
      });
      if (keepable) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'pr-org-picker__cancel';
        cancelBtn.textContent = '取消（保留原本的部門）';
        cancelBtn.addEventListener('click', () => close(null));
        box.appendChild(cancelBtn);
      }

      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });

  // 選單位的視窗一次只開一個（申請人、費用所屬人同時要選時排隊，不會疊在一起）
  let orgDialogQueue = Promise.resolve();

  /**
   * 決定要帶入哪個單位：只有一個就直接用；多個跳視窗讓使用者選。按取消回傳 null。
   * 部門欄位鎖住、只能依人員帶入，所以目前的部門不是這個人的單位時（keepable＝false）不給取消，一定要選。
   * @param {Array} orgs  /v1/user/organizations.json 的 organizationTitles
   * @param {string} userName
   * @param {{ subject?: string, hint?: string, keepable?: boolean, isCurrent?: Function }} [opts]
   *   subject：「費用所屬人」或「申請人」；isCurrent：排隊輪到時再確認這次查詢還算數（使用者已改人就不開視窗）
   * @returns {Promise<Object|null>} organizationTitles 的其中一筆
   */
  const pickOrg = (orgs, userName, { subject = '費用所屬人', hint = '', keepable = true, isCurrent = () => true } = {}) => {
    if (orgs.length <= 1) return Promise.resolve(orgs[0] || null);
    const open = () => {
      if (!isCurrent()) return null;
      return openOrgDialog(orgs, { heading: `${userName} 有多個所屬單位，請選擇${subject}部門：`, hint, keepable });
    };
    const picked = orgDialogQueue.then(open, open);
    orgDialogQueue = picked.catch(() => null);
    return picked;
  };

  /**
   * 使用者在 kintone 後台設定的「優先組織」id（2026-11-16，做法同出差申請單的簽核流程）。
   *   路線 A：kintone.user.getOrganizations()（一般使用者可呼叫，有 primary 旗標；有所屬組織但沒有 primary＝沒設定）
   *   路線 B：/v1/users.json 的 primaryOrganization（需要共通管理權限）
   * 都拿不到回 null，呼叫端退回原本的選部門視窗。
   */
  const fetchPrimaryOrgId = async (userCode) => {
    if (typeof kintone.user?.getOrganizations === 'function') {
      try {
        const list = (await kintone.user.getOrganizations(userCode)) || [];
        const hit = list.find((item) => item?.organization?.primary === true);
        if (hit) return String(hit.organization.id);
        if (list.length > 0) return null;
      } catch (err) {
        console.warn('[簽核人員] kintone.user.getOrganizations 失敗，改查 /v1/users.json:', err);
      }
    }
    try {
      const resp = await kintone.api(kintone.api.url('/v1/users.json', true), 'GET', { codes: [userCode] });
      const id = resp?.users?.[0]?.primaryOrganization;
      return id ? String(id) : null;
    } catch (err) {
      console.warn('[簽核人員] 讀不到優先組織（可能沒有權限），改用選部門視窗:', err);
      return null;
    }
  };

  /** 有多個所屬單位時，優先組織那一筆；沒設定、讀不到或不在清單裡回 null */
  const primaryOrgOf = async (orgs, userCode) => {
    if (!orgs || orgs.length < 2) return null;
    const id = await fetchPrimaryOrgId(userCode);
    return id ? orgs.find((o) => String(o.organization?.id) === id) || null : null;
  };

  /** 查使用者的所屬單位（organizationTitles） */
  const fetchUserOrgs = (userCode) => kintone.api(kintone.api.url(USER_API, true), 'GET', { code: userCode }).then((resp) => resp.organizationTitles || []);

  /** 人員沒有任何所屬單位時的提醒 */
  const warnNoOrg = (subject) => {
    const title = `此${subject}沒有所屬單位`;
    const text = `請改選其他${subject}，或請管理員到 kintone 設定他的所屬組織。`;
    notify('warning', title, text);
  };

  // 申請人部門（申請人部門帶入.js）共用同一套查單位與選單位視窗
  window.PR_ORG_PICKER = Object.freeze({ fetchUserOrgs, pickOrg, warnNoOrg, fetchPrimaryOrgId, primaryOrgOf });

  /**
   * 「指定簽核人」視窗按取消、一位簽核人都沒指定（PR_MANUAL_SIGNERS 呼叫）：
   * 取消勾選手動設定簽核流程，改回系統自動排人。使用者已經在視窗按了取消，這裡不再跳確認。
   * set() 引起的 change 事件靠 manualShown 認出是回音，不會再勾回去。
   */
  function exitManualMode() {
    const current = KT.record().get();
    const record = current.record;
    if (!isManualSigningMode(record)) return;
    record[MANUAL_MODE_CONFIG.checkbox].value = [];
    manualShown = false;
    window.PR_MANUAL_SIGNERS?.leave(record);
    handleExpenseOwnerOrgChange({ record });
    KT.record().set(current);
  }

  window.PR_MANUAL_MODE = Object.freeze({
    exitManualMode,
    /** 測試用：忘掉畫面上的勾選狀態（模擬重新開頁） */
    _reset: () => {
      manualShown = null;
    },
  });

  // 連續改費用所屬人時，只讓最後一次的查詢結果寫回畫面
  let expenseOwnerChangeSeq = 0;

  /**
   * 改費用所屬人：查他的所屬單位 → 帶入費用所屬人部門 → 依新的人與部門重排簽核人員。
   * change 事件不可 async，查詢與寫回放在 .then() 裡用 get()/set()。
   * 費用所屬人部門由程式寫入不一定會觸發 change，所以寫完直接呼叫 handleExpenseOwnerOrgChange 重排；
   * 部門沒變（同部門換人）也要重排，因為簽核人員的職稱清除會因人而異。
   * @param {Object} event
   * @param {{ keepIfValid?: boolean }} [opts] keepIfValid：目前的部門就是這個人的單位時不動（新增畫面用）
   */
  function handleExpenseOwnerChange(event, { keepIfValid = false } = {}) {
    const owner = event.record[F.EXPENSE_OWNER]?.value?.[0];
    const seq = ++expenseOwnerChangeSeq;
    if (!owner?.code) return clearOwnerOrg(event);

    fetchUserOrgs(owner.code)
      .then(async (orgs) => {
        if (seq !== expenseOwnerChangeSeq) return;
        if (orgs.length === 0) {
          warnNoOrg('費用所屬人');
          return;
        }
        // 有設定優先組織 → 直接用，不跳選部門視窗（新增畫面也一樣，蓋過原本的部門）
        const primary = await primaryOrgOf(orgs, owner.code);
        if (seq !== expenseOwnerChangeSeq) return;
        const currentCode = (await KT.whenIdle()).record[F.EXPENSE_OWNER_ORG]?.value?.[0]?.code;
        if (seq !== expenseOwnerChangeSeq) return;
        const currentValid = orgs.some((o) => o.organization.code === currentCode);
        if (keepIfValid && (primary ? primary.organization.code === currentCode : currentValid)) return;

        const picked =
          primary ||
          (await pickOrg(orgs, owner.name || owner.code, {
            subject: '費用所屬人',
            hint: '簽核人員會依選的部門排。',
            keepable: currentValid,
            isCurrent: () => seq === expenseOwnerChangeSeq,
          }));
        if (seq !== expenseOwnerChangeSeq) return;
        if (!picked) {
          // 視窗按「維持原部門」：部門沒變，但人換了，簽核人員還是要依新的人重排
          if (currentValid) handleExpenseOwnerOrgChange({ record: (await KT.whenIdle()).record });
          return;
        }

        const current = await KT.whenIdle();
        if (seq !== expenseOwnerChangeSeq) return;
        current.record[F.EXPENSE_OWNER_ORG].value = [{ code: picked.organization.code, name: picked.organization.name }];
        current.record[F.EXPENSE_OWNER_ORG].disabled = true;
        // 程式寫入部門不會觸發 change 事件，公司名稱要在這裡跟著重算（推導規則在 main）
        window.PR_COMPANY_NAME?.apply(current.record);
        KT.record().set(current);
        handleExpenseOwnerOrgChange({ record: KT.record().get().record });
      })
      .catch((err) => console.error('[簽核人員] 改費用所屬人後帶入費用所屬人部門失敗:', err));
    return event;
  }

  // 改費用所屬人：先把上一位的簽核人員與人數清掉（主管、次長人數一律重算），查完單位再依新的人重排
  KT.on([`app.record.create.change.${F.EXPENSE_OWNER}`, `app.record.edit.change.${F.EXPENSE_OWNER}`], (event) => {
    if (!isManualSigningMode(event.record)) resetSigningSlots(event.record);
    return handleExpenseOwnerChange(event);
  });

  // 表單編輯時，有顯示的繼續顯示，隱藏的繼續隱藏
  KT.on(['app.record.edit.show', 'app.record.detail.show'], (event) => {
    const record = event.record;

    // 處理簽核欄位的顯示邏輯
    getEnabledFields().forEach((field) => {
      const hasValue = record[field]?.value?.length > 0;
      KT.record().setFieldShown(field, hasValue);
    });

    // 處理其他一般欄位的顯示邏輯
    const fieldList = [COUNT_FIELDS.manager, COUNT_FIELDS.deputy, ...getEnabledFields()];

    // USER_SELECT disabled
    fieldList.forEach((field) => {
      if (record[field]) {
        record[field].disabled = true;
      }
    });

    // 手動設定簽核流程時不顯示會計單位
    KT.record().setFieldShown(F.ACCOUNTING_UNIT, record[F.MANUAL_FLOW]?.value?.length < 1);

    return event;
  });

  // 手動設定簽核流程勾選變更
  //   勾選：只限「費用歸屬不限部門」群組的申請人（PR_COST_SCOPE 開畫面時已查好）；不在群組就取消勾選並說明。
  //     開畫面時的查詢若還沒回來，先取消勾選，查完確定在群組再幫他勾回去。
  //   取消勾選：確認後清掉手動簽核人，改回系統自動排人。
  //   勾選狀態和 manualShown 一樣 → 是程式 set() 引起的回音，直接放行。
  KT.on([`app.record.create.change.${F.MANUAL_FLOW}`, `app.record.edit.change.${F.MANUAL_FLOW}`], function (event) {
    const record = event.record;
    const isManual = Boolean(isManualSigningMode(record));
    if (isManual === manualShown) return event;

    if (isManual) {
      const scope = window.PR_COST_SCOPE;
      if (scope && !scope.isExempt()) {
        record[MANUAL_MODE_CONFIG.checkbox].value = [];
        manualShown = false;
        scope.ensureExempt(scope.applicantCodeOf(record)).then((exempt) => {
          if (!exempt) {
            warnManualNotAllowed();
            return undefined;
          }
          return KT.whenIdle(() => {
            const current = KT.record().get();
            enterManualModeForExempt(current.record);
            KT.record().set(current);
          });
        });
        return event;
      }

      // 啟用手動模式
      record[F.ACCOUNTING_UNIT].value = [];
      KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);

      KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
      event.record = initManualSigningMode(record, { openNow: true });
    } else {
      // 取消手動模式：change 事件不能等視窗，先維持勾選；問過按「改回自動」才真的取消勾選
      record[MANUAL_MODE_CONFIG.checkbox].value = [OPT.MANUAL_FLOW.ON];
      manualShown = true;
      askExitManual().then((ok) => {
        if (ok) exitManualMode();
      });
    }

    return event;
  });

  // 編輯/詳細頁面顯示（手動模式）：6 格的兩個人數欄位不顯示（會計單位承辦人照一般規則，只有管理員看得到）
  KT.on(['app.record.edit.show', 'app.record.detail.show'], function (event) {
    const record = event.record;
    manualShown = Boolean(isManualSigningMode(record));

    if (isManualSigningMode(record)) {
      Object.values(MANUAL_MODE_CONFIG.countFields).forEach((field) => KT.record().setFieldShown(field, false));
    }

    return event;
  });
})();
