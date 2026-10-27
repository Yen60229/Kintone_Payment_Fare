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
  //     - 勾選「手動設定簽核流程」→ 由使用者自己填人數與人員，存檔時驗證
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

  // 手動模式欄位配置
  const MANUAL_MODE_CONFIG = {
    // 核取方塊欄位名稱
    checkbox: F.MANUAL_FLOW,

    // A類：人數欄位
    countFields: COUNT_FIELDS,

    // B類：主管欄位
    managerFields: [
      { field: '單位主管1', order: 1 },
      { field: '單位主管2', order: 2 },
      { field: '單位主管3', order: 3 },
    ],
    deputyFields: [
      { field: '單位次長', order: 1 },
      { field: '單位次長1', order: 2 },
    ],

    // C類：固定顯示欄位（必填）
    fixedFields: ['單位部長_支店長', F.ACCOUNTING_STAFF],
  };

  // 人數對應主管欄位
  const MANUAL_DISPLAY_RULES = {
    manager: {
      '0人': [],
      '1人': ['單位主管3'],
      '2人': ['單位主管2', '單位主管3'],
      '3人': ['單位主管1', '單位主管2', '單位主管3'],
    },
    deputy: {
      '0人': [],
      '1人': ['單位次長1'],
      '2人': ['單位次長', '單位次長1'],
    },
  };

  // =========================
  // 工具函數區塊
  // =========================

  /**
   * 更新簽核人數
   * @param {Object} record - Kintone record 物件
   * @param {string} field - 欄位名稱
   * @param {number} count - 人數
   */
  function updateSigningCount(record, field, count) {
    record[field].value = `${count}人`;
    KT.record().setFieldShown(field, count > 0);
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
   * 費用所屬人本人那一層與以下，之後由 clearSigningFieldsByTitle 依職稱清掉。
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
   * 設定簽核人員欄位
   *
   * 簽核層級結構：
   *   A1: 單位主管1
   *   A2: 單位主管2
   *   A3: 單位主管3
   *   B:  單位次長
   *   C:  單位次長1
   *   D:  單位部長_支店長
   *
   * 決定「要排哪幾位主管」的判斷本身是純函式 planSigningChain，
   * 本函式只負責把結果寫進 record 並設定顯示狀態。
   *
   * @param {Object} managerData - 主管資料（來源 API 回傳）
   * @param {Object} record - Kintone record 物件
   * @param {boolean} isSpecialDepartment - 是否為特殊部門（六大簽核流程）
   * @returns {Object} 更新後的 record
   */
  function updateSigningFields(managerData, record, isSpecialDepartment) {
    const fieldsToUpdate = isSpecialDepartment ? MANAGER_FIELDS_SPECIAL : MANAGER_FIELDS_MAPPING;

    const { fieldHasValue, fieldsToShow, usersOf } = planSigningChain(managerData, fieldsToUpdate);

    fieldsToUpdate.forEach(({ displayField }) => {
      const shouldShow = fieldsToShow.includes(displayField);
      const users = fieldHasValue[displayField] ? usersOf[displayField] : [];

      if (shouldShow && users.length > 0) {
        // 顯示欄位並設定值
        record[displayField] = {
          value: users.map((user) => ({
            code: user.code,
            name: user.name,
          })),
          type: 'USER_SELECT',
          disabled: true,
        };
        KT.record().setFieldShown(displayField, true);
      } else {
        // 隱藏欄位並清空值
        record[displayField] = {
          value: [],
          type: 'USER_SELECT',
          disabled: true,
        };
        KT.record().setFieldShown(displayField, false);
      }
    });

    return record;
  }

  /**
   * 根據費用所屬人職位清空對應簽核欄位
   * @param {Object} updateRecord - 更新的 record 物件
   * @param {string} title - 職位名稱
   * @param {string} userCode - 費用所屬人的使用者代碼
   */
  function clearSigningFieldsByTitle(updateRecord, title, userCode) {
    // 本人也排在次長格（課長兼次長、中心長排在次長格…）：照次長處理，簽核從他上面那一層開始，不會自己簽自己
    const isInDeputySlot = DEPUTY_FIELDS.some((field) => updateRecord.record[field]?.value?.some((user) => user.code === userCode));
    // 本人就排在部長格（職稱不一定是部長，例如事業部長）：照部長處理，部長格也清掉，不會自己簽自己
    const isInDirectorSlot = updateRecord.record[DIRECTOR_FIELD]?.value?.some((user) => user.code === userCode);
    const effectiveTitle = isInDirectorSlot ? '部長' : isInDeputySlot && title !== '部長' && title !== '支店長' ? '次長' : title;

    switch (effectiveTitle) {
      case '課長':
        console.log('開始處理課長身份');
        console.log('使用者 code:', userCode);

        let matchedLevel = -1; // 用來記錄匹配到的主管層級

        // 先找出使用者是哪一個層級的主管
        for (let i = 1; i <= 3; i++) {
          const managerField = `單位主管${i}`;
          if (APPROVAL_FIELDS[managerField]?.enabled && updateRecord.record[managerField].value?.some((user) => user.code === userCode)) {
            matchedLevel = i;
            console.log(`找到匹配的主管層級: ${matchedLevel}`);
            break;
          }
        }

        // 如果找到匹配的層級，清空該層級及以下層級的主管欄位
        if (matchedLevel > 0) {
          let clearedCount = 0; // 記錄清空的主管數量

          // 清空所有較低層級的主管欄位（包含當前層級）
          for (let i = 1; i <= matchedLevel; i++) {
            const managerField = `單位主管${i}`;

            if (APPROVAL_FIELDS[managerField]?.enabled && updateRecord.record[managerField].value.length > 0) {
              clearedCount++;
            }

            // 清空欄位值
            if (APPROVAL_FIELDS[managerField]?.enabled) {
              updateRecord.record[managerField] = {
                value: [],
                type: 'USER_SELECT',
                disabled: true,
              };

              // 隱藏欄位
              KT.record().setFieldShown(managerField, false);
            }
          }

          // 更新主管簽核人數
          const currentCount = parseInt(updateRecord.record[COUNT_FIELDS.manager].value.charAt(0));
          console.log('當前主管人數:', currentCount);

          if (!isNaN(currentCount) && currentCount > 0) {
            const newCount = Math.max(0, currentCount - clearedCount);
            updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, newCount);
            console.log('更新後主管人數:', newCount);
          }
        }
        break;

      case '次長':
      case '室長':
        console.log('開始處理次長/室長身份');
        // 課長欄位清空與隱藏
        MANAGER_FIELDS.forEach((field) => {
          updateRecord.record[field] = {
            value: [],
            type: 'USER_SELECT',
            disabled: true,
          };
          KT.record().setFieldShown(field, false);
        });
        updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, 0);

        // 處理次長欄位 - 採用階層式邏輯
        let matchedDeputyLevel = -1;

        // 檢查是單位次長還是單位次長1
        DEPUTY_FIELDS.forEach((field, index) => {
          if (updateRecord.record[field].value?.some((user) => user.code === userCode)) {
            matchedDeputyLevel = index;
            console.log(`找到匹配的次長層級: ${field}`);
          }
        });

        // 如果找到匹配的層級，清空該層級及以下層級的次長欄位
        if (matchedDeputyLevel >= 0) {
          let clearedDeputyCount = 0;

          // 清空所有較低層級的次長欄位（包含當前層級）
          for (let i = 0; i <= matchedDeputyLevel; i++) {
            const field = DEPUTY_FIELDS[i];

            if (updateRecord.record[field].value.length > 0) {
              clearedDeputyCount++;
            }

            // 清空欄位值
            updateRecord.record[field] = {
              value: [],
              type: 'USER_SELECT',
              disabled: true,
            };

            KT.record().setFieldShown(field, false);
          }

          // 更新次長簽核人數
          const currentDeputyCount = parseInt(updateRecord.record[COUNT_FIELDS.deputy].value);
          console.log('目前次長人數:', currentDeputyCount);

          if (!isNaN(currentDeputyCount) && currentDeputyCount > 0) {
            const newCount = Math.max(0, currentDeputyCount - clearedDeputyCount);
            updateSigningCount(updateRecord.record, COUNT_FIELDS.deputy, newCount);
            console.log('更新後次長人數:', newCount);
          }
        }
        break;

      case '部長':
      case '支店長':
        // 部長格是本人才清；部長格是別人（上一層部長）就留著讓他簽
        [...MANAGER_FIELDS, ...DEPUTY_FIELDS, ...(isInDirectorSlot ? [DIRECTOR_FIELD] : [])].forEach((field) => {
          updateRecord.record[field] = {
            value: [],
            type: 'USER_SELECT',
            disabled: true,
          };
          KT.record().setFieldShown(field, false);
        });
        // 設定簽核人數為 0
        updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, 0);
        updateSigningCount(updateRecord.record, COUNT_FIELDS.deputy, 0);
        break;
    }

    KT.record().set(updateRecord);
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
   * 取得會計單位並設定
   * @param {string} orgName - 費用所屬人部門名稱
   */
  function setAccountingUnit(orgName) {
    const params_acc = {
      app: APPS.ACCOUNTING_MAP,
      fields: [ACC.APPLY_UNIT, ACC.ACCOUNTING_UNIT, ACC.ACCOUNTING_STAFF, ACC.PERMISSION_USER],
      query: `${ACC.APPLY_UNIT} in ("${orgName}")`,
    };

    // 呼叫 API 取得會計單位帶入簽核流程
    kintone.api(
      kintone.api.url('/k/v1/records', true),
      'GET',
      params_acc,
      function (resp) {
        if (!resp.records || resp.records.length === 0) {
          alert('找不到對應的會計單位，請確認費用所屬人部門');
          return;
        }

        const AccountData = resp.records[0];
        const updateRecord = KT.record().get();
        // 手動設定簽核流程時，會計單位要維持空白（流程管理靠它分辨「送會計」與「送單位會計處理中」）。
        // API 回來時使用者可能剛勾選手動，所以看寫入當下的畫面資料，不看呼叫當時的狀態。
        const isManual = isManualSigningMode(updateRecord.record);
        const has_account = AccountData[ACC.ACCOUNTING_UNIT]?.value?.length > 0;
        const has_account_member = AccountData[ACC.ACCOUNTING_STAFF]?.value?.length > 0;
        const has_permission_user = AccountData[ACC.PERMISSION_USER]?.value?.length > 0;

        if (!isManual) {
          updateRecord.record[F.ACCOUNTING_UNIT] = {
            value: has_account
              ? [
                  {
                    code: AccountData[ACC.ACCOUNTING_UNIT].value,
                    name: AccountData[ACC.ACCOUNTING_UNIT].value,
                  },
                ]
              : [],
            type: 'GROUP_SELECT',
            disabled: true,
          };
        }

        updateRecord.record[F.ACCOUNTING_STAFF] = {
          value: has_account_member
            ? AccountData[ACC.ACCOUNTING_STAFF].value.map((member) => ({
                code: member.code || member,
                name: member.name || member,
              }))
            : [],
          type: 'USER_SELECT',
        };

        // 左側是請款單主表的欄位（F），右側是會計對應主檔的欄位（ACC）——同名但不同 App
        updateRecord.record[F.PERMISSION_STAFF] = {
          value: has_permission_user
            ? AccountData[ACC.PERMISSION_USER].value.map((user) => ({
                code: user.code || user,
                name: user.name || user,
              }))
            : [],
          type: 'USER_SELECT',
        };

        KT.record().setFieldShown(F.ACCOUNTING_UNIT, has_account && !isManual);
        KT.record().set(updateRecord);
      },
      function (error) {
        console.error('API錯誤:', error);
        alert('取得會計單位資料時發生錯誤');
      },
    );
  }

  // =========================
  // 主要處理函數
  // =========================

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
      getEnabledFields().forEach((field) => {
        record[field].value = [];
      });
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
    if (!ownerCode) return event;

    // 取得費用所屬人在各部門的職位資料
    fetchTitleData(USER_API, { code: ownerCode }, (error, result) => {
      if (error) {
        console.error('Error:', error);
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
      const { title, approvalQuery, isSpecialDepartment, isSpecificDirector } = owner;
      console.log(`簽核流程查詢：${approvalQuery}`);

      // 動態建立欄位陣列
      const enabledApiFields = MANAGER_FIELDS_MAPPING.map((field) => field.apiField);
      const specialApiFields = MANAGER_FIELDS_SPECIAL.map((field) => field.apiField);

      const params = {
        app: APPS.APPROVAL_FLOW,
        fields: isSpecialDepartment ? [AF.FLOW_NAME, ...specialApiFields] : [AF.FLOW_NAME, ...enabledApiFields],
        query: approvalQuery,
      };

      // 呼叫 API 取得簽核主管資料、身份確認
      kintone.api(
        kintone.api.url('/k/v1/records', true),
        'GET',
        params,
        function (resp) {
          const updateRecord = KT.record().get();

          // API 回來前使用者可能已勾選手動設定簽核流程，那就不蓋掉他自選的人
          if (isManualSigningMode(updateRecord.record)) return;

          console.log('title為', title);

          // 如果是台中支店長/營業戰略部長/總務部長/事業本部長，不用後續的設定
          if (isSpecificDirector) {
            // 隱藏其餘欄位
            SIGNING_FIELDS_TO_HIDE.forEach((field) => {
              KT.record().setFieldShown(field, false);
            });
            KT.record().set(updateRecord);
            console.log('台中支店長/營業戰略部長/總務部長/事業本部長，不帶入課/次/部長流程');
            return;
          }

          if (!resp.records || resp.records.length === 0) {
            console.log('此費用所屬人部門沒有設定簽核流程');
            return;
          }

          const managerData = resp.records[0];

          updateRecord.record = updateSigningFields(managerData, updateRecord.record, isSpecialDepartment);
          KT.record().set(updateRecord);

          // 計算主管人數
          let managerCount = 0;
          MANAGER_FIELDS.forEach((field) => {
            if (updateRecord.record[field]?.value?.length > 0) managerCount++;
          });

          // 計算次長人數
          let deputyCount = 0;
          DEPUTY_FIELDS.forEach((field) => {
            if (updateRecord.record[field]?.value?.length > 0) deputyCount++;
          });

          console.log(`managerCount = ${managerCount}, deputyCount = ${deputyCount}`);

          // 設定簽核人數
          updateSigningCount(updateRecord.record, COUNT_FIELDS.manager, managerCount);
          updateSigningCount(updateRecord.record, COUNT_FIELDS.deputy, deputyCount);

          KT.record().set(updateRecord);

          // 六大簽核流程只排部長，不需再運行下方程式；除非那位部長就是本人，要清掉部長格
          const isOwnerDirector = updateRecord.record[DIRECTOR_FIELD]?.value?.some((user) => user.code === ownerCode);
          if (isSpecialDepartment && !isOwnerDirector) return;

          // 費用所屬人職位設定 - 單職位與雙職位過濾重複簽核的人員
          clearSigningFieldsByTitle(updateRecord, title, ownerCode);
        },
        function (error) {
          console.error('API錯誤:', error);
          alert('取得主管資料時發生錯誤');
        },
      );
    });

    return event;
  }

  // =========================
  // 手動簽核流程相關函數
  // =========================

  /**
   * 初始化手動簽核模式
   * @param {Object} record - Kintone record 物件
   * @returns {Object} 更新後的 record
   */
  function initManualSigningMode(record) {
    console.log('=== 初始化手動簽核模式 ===');

    // A類：人數欄位啟用
    record[MANUAL_MODE_CONFIG.countFields.manager].disabled = false;
    record[MANUAL_MODE_CONFIG.countFields.deputy].disabled = false;
    record[MANUAL_MODE_CONFIG.countFields.manager].value = '0人';
    record[MANUAL_MODE_CONFIG.countFields.deputy].value = '0人';

    KT.record().setFieldShown(MANUAL_MODE_CONFIG.countFields.manager, true);
    KT.record().setFieldShown(MANUAL_MODE_CONFIG.countFields.deputy, true);

    // B類：主管欄位先全部隱藏
    MANUAL_MODE_CONFIG.managerFields.forEach(({ field }) => {
      record[field].value = [];
      record[field].disabled = false;
      KT.record().setFieldShown(field, false);
    });

    MANUAL_MODE_CONFIG.deputyFields.forEach(({ field }) => {
      record[field].value = [];
      record[field].disabled = false;
      KT.record().setFieldShown(field, false);
    });

    // C類：固定欄位顯示
    MANUAL_MODE_CONFIG.fixedFields.forEach((field) => {
      record[field].disabled = false;
      KT.record().setFieldShown(field, true);
    });

    console.log('手動簽核模式初始化完成');
    return record;
  }

  /**
   * 根據主管人數動態顯示欄位
   * @param {string} count - 人數選擇（"0人", "1人", "2人", "3人"）
   * @param {Object} record - Kintone record 物件
   */
  function handleManagerCountChangeForManual(count, record) {
    console.log(`=== 處理主管人數變更: ${count} ===`);

    const fieldsToShow = MANUAL_DISPLAY_RULES.manager[count] || [];

    MANUAL_MODE_CONFIG.managerFields.forEach(({ field }) => {
      const shouldShow = fieldsToShow.includes(field);

      if (shouldShow) {
        record[field].disabled = false;
        KT.record().setFieldShown(field, true);

        console.log(`顯示欄位: ${field}`);
      } else {
        record[field].value = [];
        record[field].disabled = false;
        KT.record().setFieldShown(field, false);

        console.log(`隱藏欄位: ${field}`);
      }
    });
  }

  /**
   * 根據次長人數動態顯示欄位
   * @param {string} count - 人數選擇（"0人", "1人", "2人"）
   * @param {Object} record - Kintone record 物件
   */
  function handleDeputyCountChangeForManual(count, record) {
    console.log(`=== 處理次長人數變更: ${count} ===`);

    const fieldsToShow = MANUAL_DISPLAY_RULES.deputy[count] || [];

    MANUAL_MODE_CONFIG.deputyFields.forEach(({ field }) => {
      const shouldShow = fieldsToShow.includes(field);

      if (shouldShow) {
        record[field].disabled = false;
        KT.record().setFieldShown(field, true);

        console.log(`顯示欄位: ${field}`);
      } else {
        record[field].value = [];
        record[field].disabled = false;
        KT.record().setFieldShown(field, false);

        console.log(`隱藏欄位: ${field}`);
      }
    });
  }

  /**
   * 驗證手動簽核流程
   * @param {Object} record - Kintone record 物件
   * @returns {Object} { isValid: boolean, errors: string[] }
   */
  function validateManualSigningFlow(record) {
    console.log('=== 開始驗證手動簽核流程 ===');

    const errors = [];

    // 1. 驗證主管人數與實際填寫是否一致
    const managerCountStr = record[MANUAL_MODE_CONFIG.countFields.manager].value;
    if (managerCountStr) {
      const declaredCount = parseInt(managerCountStr.charAt(0));
      let actualCount = 0;

      MANUAL_MODE_CONFIG.managerFields.forEach(({ field }) => {
        if (record[field].value && record[field].value.length > 0) {
          actualCount++;
        }
      });

      if (declaredCount !== actualCount) {
        errors.push(`❌ 部門主管簽核人數選擇 ${declaredCount}人，但實際填寫 ${actualCount} 位，請補齊或調整人數`);
      }

      console.log(`主管人數驗證: 宣告=${declaredCount}, 實際=${actualCount}`);
    }

    // 2. 驗證次長人數與實際填寫是否一致
    const deputyCountStr = record[MANUAL_MODE_CONFIG.countFields.deputy].value;
    if (deputyCountStr) {
      const declaredCount = parseInt(deputyCountStr.charAt(0));
      let actualCount = 0;

      MANUAL_MODE_CONFIG.deputyFields.forEach(({ field }) => {
        if (record[field].value && record[field].value.length > 0) {
          actualCount++;
        }
      });

      if (declaredCount !== actualCount) {
        errors.push(`❌ 部門次長簽核人數選擇 ${declaredCount}人，但實際填寫 ${actualCount} 位，請補齊或調整人數`);
      }

      console.log(`次長人數驗證: 宣告=${declaredCount}, 實際=${actualCount}`);
    }

    // 3. 驗證 C類固定欄位必填(管理員略過)
    if (!C.isAdmin()) {
      MANUAL_MODE_CONFIG.fixedFields.forEach((field) => {
        const value = record[field].value;
        const isEmpty = !value || value.length === 0;

        if (isEmpty) {
          const fieldLabel = field === '單位部長_支店長' ? '單位部長/支店長' : '會計單位承辦人';
          errors.push(`❌ 請填寫「${fieldLabel}」欄位`);
        }

        console.log(`${field} 必填驗證: ${isEmpty ? '未填寫' : '已填寫'}`);
      });
    }

    // 4. 驗證是否有選擇人數但未填寫
    if (managerCountStr && parseInt(managerCountStr.charAt(0)) > 0) {
      const hasAnyManager = MANUAL_MODE_CONFIG.managerFields.some(({ field }) => record[field].value && record[field].value.length > 0);
      if (!hasAnyManager) {
        errors.push(`❌ 已選擇部門主管簽核人數，但未填寫任何主管人員`);
      }
    }

    if (deputyCountStr && parseInt(deputyCountStr.charAt(0)) > 0) {
      const hasAnyDeputy = MANUAL_MODE_CONFIG.deputyFields.some(({ field }) => record[field].value && record[field].value.length > 0);
      if (!hasAnyDeputy) {
        errors.push(`❌ 已選擇部門次長簽核人數，但未填寫任何次長人員`);
      }
    }

    const isValid = errors.length === 0;
    console.log(`驗證結果: ${isValid ? '通過' : '失敗'}`);
    if (!isValid) {
      console.log('錯誤列表:', errors);
    }

    return { isValid, errors };
  }

  /**
   * 檢查是否為手動模式
   * @param {Object} record - Kintone record 物件
   * @returns {boolean}
   */
  function isManualSigningMode(record) {
    return record[MANUAL_MODE_CONFIG.checkbox] && record[MANUAL_MODE_CONFIG.checkbox].value && record[MANUAL_MODE_CONFIG.checkbox].value.length > 0;
  }

  // =========================
  // 事件註冊
  // =========================

  // 費用所屬人部門變更時的事件
  KT.on([`app.record.create.change.${F.EXPENSE_OWNER_ORG}`, `app.record.edit.change.${F.EXPENSE_OWNER_ORG}`], handleExpenseOwnerOrgChange);

  /**
   * 申請人在「費用歸屬不限部門」群組（COST_SCOPE.EXEMPT_GROUP）→ 簽核人員自選：勾上手動設定簽核流程。
   * @param {Object} record
   */
  function enterManualModeForExempt(record) {
    record[F.MANUAL_FLOW].value = [OPT.MANUAL_FLOW.ON];
    record[F.ACCOUNTING_UNIT].value = [];
    KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);
    if (typeof KT.record().setGroupFieldOpen === 'function') KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
    initManualSigningMode(record);
  }

  /**
   * 新增畫面：先確認申請人是否在排除群組（PR_COST_SCOPE），在的話切手動模式，再帶入費用所屬人部門與簽核人員／會計單位。
   */
  function handleCreateShow(event) {
    const scope = window.PR_COST_SCOPE;
    if (!scope) return syncOwnerOrgOnCreate(event);
    return scope.ensureExempt(scope.applicantCodeOf(event.record)).then((exempt) => {
      if (exempt && !isManualSigningMode(event.record)) enterManualModeForExempt(event.record);
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

  /** 查使用者的所屬單位（organizationTitles） */
  const fetchUserOrgs = (userCode) => kintone.api(kintone.api.url(USER_API, true), 'GET', { code: userCode }).then((resp) => resp.organizationTitles || []);

  /** 人員沒有任何所屬單位時的提醒 */
  const warnNoOrg = (subject) => {
    const title = `此${subject}沒有所屬單位`;
    const text = `請改選其他${subject}，或請管理員到 kintone 設定他的所屬組織。`;
    if (typeof Swal !== 'undefined') Swal.fire({ icon: 'warning', title, text });
    else alert(`${title}\n${text}`);
  };

  // 申請人部門（申請人部門帶入_20261022.js）共用同一套查單位與選單位視窗
  window.PR_ORG_PICKER = Object.freeze({ fetchUserOrgs, pickOrg, warnNoOrg });

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
        const currentCode = KT.record().get().record[F.EXPENSE_OWNER_ORG]?.value?.[0]?.code;
        const currentValid = orgs.some((o) => o.organization.code === currentCode);
        if (keepIfValid && currentValid) return;

        const picked = await pickOrg(orgs, owner.name || owner.code, {
          subject: '費用所屬人',
          hint: '簽核人員會依選的部門排。',
          keepable: currentValid,
          isCurrent: () => seq === expenseOwnerChangeSeq,
        });
        if (!picked || seq !== expenseOwnerChangeSeq) return;

        const current = KT.record().get();
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

  KT.on([`app.record.create.change.${F.EXPENSE_OWNER}`, `app.record.edit.change.${F.EXPENSE_OWNER}`], handleExpenseOwnerChange);

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
  KT.on([`app.record.create.change.${F.MANUAL_FLOW}`, `app.record.edit.change.${F.MANUAL_FLOW}`], function (event) {
    const record = event.record;
    const isManual = isManualSigningMode(record);

    if (isManual) {
      // 啟用手動模式
      record[F.ACCOUNTING_UNIT].value = [];
      KT.record().setFieldShown(F.ACCOUNTING_UNIT, false);

      KT.record().setGroupFieldOpen(F.SIGN_FLOW_GROUP, true);
      event.record = initManualSigningMode(record);
    } else {
      // 取消手動模式 - 需要確認
      const userConfirmed = confirm(
        '⚠️ 切換回自動模式會清除已填寫的內容，確定要繼續嗎？\n\n' + '按「確定」將重新載入自動簽核流程\n' + '按「取消」將維持手動模式',
      );

      if (userConfirmed) {
        handleExpenseOwnerOrgChange(event);
      } else {
        // 使用者取消，重新勾選 checkbox
        record[MANUAL_MODE_CONFIG.checkbox].value = [OPT.MANUAL_FLOW.ON];
        event.record = record;
      }
    }

    return event;
  });

  // 部門主管簽核人數變更
  KT.on(
    [`app.record.create.change.${COUNT_FIELDS.manager}`, `app.record.edit.change.${COUNT_FIELDS.manager}`],
    function (event) {
      const record = event.record;

      // 只在手動模式下處理
      if (!isManualSigningMode(record)) {
        return event;
      }

      const count = record[MANUAL_MODE_CONFIG.countFields.manager].value;

      handleManagerCountChangeForManual(count, record);
      event.record = record;

      return event;
    },
  );

  // 部門次長簽核人數變更
  KT.on(
    [`app.record.create.change.${COUNT_FIELDS.deputy}`, `app.record.edit.change.${COUNT_FIELDS.deputy}`],
    function (event) {
      const record = event.record;

      // 只在手動模式下處理
      if (!isManualSigningMode(record)) {
        return event;
      }

      const count = record[MANUAL_MODE_CONFIG.countFields.deputy].value;

      handleDeputyCountChangeForManual(count, record);
      event.record = record;

      return event;
    },
  );

  // 編輯/詳細頁面顯示（手動模式支援）
  KT.on(['app.record.edit.show', 'app.record.detail.show'], function (event) {
    const record = event.record;

    if (isManualSigningMode(record)) {
      // A類欄位：啟用編輯（僅編輯模式）
      if (event.type === 'app.record.edit.show') {
        record[MANUAL_MODE_CONFIG.countFields.manager].disabled = false;
        record[MANUAL_MODE_CONFIG.countFields.deputy].disabled = false;
      }

      // B類欄位：根據目前人數顯示對應欄位並啟用
      const managerCount = record[MANUAL_MODE_CONFIG.countFields.manager].value;
      const deputyCount = record[MANUAL_MODE_CONFIG.countFields.deputy].value;

      if (managerCount) {
        handleManagerCountChangeForManual(managerCount, record);
      }

      if (deputyCount) {
        handleDeputyCountChangeForManual(deputyCount, record);
      }

      // C類欄位：顯示並啟用（僅編輯模式）
      if (event.type === 'app.record.edit.show') {
        MANUAL_MODE_CONFIG.fixedFields.forEach((field) => {
          record[field].disabled = false;
          KT.record().setFieldShown(field, true);
        });
      }
    }

    return event;
  });

  // 儲存時檢查手動簽核流程的欄位值是否符合規定
  KT.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {
    const record = event.record;
    // VOID_FIELD 是 checkbox 欄位代碼，與 STATUS.VOID 流程狀態字串語意不同
    if (record[C.VOID_FIELD]?.value?.length > 0) {
      return event;
    }
    if (isManualSigningMode(record)) {
      const validation = validateManualSigningFlow(record);

      if (!validation.isValid) {
        const errorMessage = '⚠️ 簽核流程驗證失敗：\n\n' + validation.errors.join('\n\n') + '\n\n請修正後再送出。';

        event.error = errorMessage;
        return event;
      }
    }

    return event;
  });
})();
